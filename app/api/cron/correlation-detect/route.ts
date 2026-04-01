import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

function getSupabase() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  return createClient(supabaseUrl, supabaseKey)
}

// Configurable threshold: % change that triggers a candidate
const SPIKE_THRESHOLD = 0.15 // 15%
const WINDOW_DAYS = 3 // ±3 days (72 hours total)
const REVERSE_WINDOW_DAYS = 5 // Check for PR mentions within 5 days after a sales event

export async function GET() {
  const db = getSupabase()
  let candidatesCreated = 0

  try {
    // 1. Get recent coverage items (approved, last 7 days) that don't already have a correlation candidate
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

    const { data: recentMentions } = await db
      .from('coverage_items')
      .select('id, game_id, client_id, title, publish_date, discovered_at, outlet_id, outlet:outlets(name)')
      .in('approval_status', ['auto_approved', 'manually_approved'])
      .gte('created_at', sevenDaysAgo)
      .not('game_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(200)

    if (recentMentions && recentMentions.length > 0) {
      // Get existing candidates to avoid duplicates
      const { data: existingCandidates } = await db
        .from('correlation_candidates')
        .select('coverage_item_id')
        .not('coverage_item_id', 'is', null)

      const existingItemIds = new Set((existingCandidates || []).map(c => c.coverage_item_id))

      for (const mention of recentMentions) {
        if (existingItemIds.has(mention.id)) continue
        if (!mention.game_id) continue

        const mentionDate = mention.publish_date || (mention.discovered_at ? mention.discovered_at.split('T')[0] : null)
        if (!mentionDate) continue

        const windowStart = new Date(new Date(mentionDate).getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
        const windowEnd = new Date(new Date(mentionDate).getTime() + WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

        // Check sales data in the window
        const { data: salesData } = await db
          .from('unified_performance_view')
          .select('date, net_units, net_revenue_usd')
          .eq('game_id', mention.game_id)
          .gte('date', windowStart)
          .lte('date', windowEnd)
          .order('date')

        if (salesData && salesData.length >= 3) {
          const beforeMention = salesData.filter(d => d.date < mentionDate)
          const afterMention = salesData.filter(d => d.date >= mentionDate)

          if (beforeMention.length > 0 && afterMention.length > 0) {
            const avgBefore = beforeMention.reduce((s, d) => s + (Number(d.net_units) || 0), 0) / beforeMention.length
            const avgAfter = afterMention.reduce((s, d) => s + (Number(d.net_units) || 0), 0) / afterMention.length

            if (avgBefore > 0) {
              const change = (avgAfter - avgBefore) / avgBefore
              if (Math.abs(change) >= SPIKE_THRESHOLD) {
                const outletName = (mention.outlet as { name?: string } | null)?.name || null
                await db.from('correlation_candidates').insert({
                  game_id: mention.game_id,
                  client_id: mention.client_id,
                  coverage_item_id: mention.id,
                  event_type: 'pr_mention',
                  event_date: mentionDate,
                  outlet_or_source: outletName || 'Unknown',
                  suspected_effect: change > 0 ? 'sales_spike' : 'sales_spike',
                  direction: 'pr_to_sales',
                  detection_confidence: Math.min(Math.abs(change), 1.0),
                  status: 'pending',
                })
                candidatesCreated++
              }
            }
          }
        }

        // Check wishlist data in the window
        const { data: wishlistData } = await db
          .from('steam_wishlists')
          .select('date, additions, deletions')
          .eq('game_id', mention.game_id)
          .gte('date', windowStart)
          .lte('date', windowEnd)
          .order('date')

        if (wishlistData && wishlistData.length >= 3) {
          const wlBefore = wishlistData.filter(d => d.date < mentionDate)
          const wlAfter = wishlistData.filter(d => d.date >= mentionDate)

          if (wlBefore.length > 0 && wlAfter.length > 0) {
            const avgWlBefore = wlBefore.reduce((s, d) => s + (d.additions || 0), 0) / wlBefore.length
            const avgWlAfter = wlAfter.reduce((s, d) => s + (d.additions || 0), 0) / wlAfter.length

            if (avgWlBefore > 0) {
              const wlChange = (avgWlAfter - avgWlBefore) / avgWlBefore
              if (Math.abs(wlChange) >= SPIKE_THRESHOLD) {
                // Check we haven't already created a sales candidate for this mention
                const outletName = (mention.outlet as { name?: string } | null)?.name || null
                await db.from('correlation_candidates').insert({
                  game_id: mention.game_id,
                  client_id: mention.client_id,
                  coverage_item_id: mention.id,
                  event_type: 'pr_mention',
                  event_date: mentionDate,
                  outlet_or_source: outletName || 'Unknown',
                  suspected_effect: 'wishlist_spike',
                  direction: 'pr_to_sales',
                  detection_confidence: Math.min(Math.abs(wlChange), 1.0),
                  status: 'pending',
                })
                candidatesCreated++
              }
            }
          }
        }
      }
    }

    // 2. Reverse detection: Check if sales events correlate with subsequent PR mentions
    // Get recent sales with active platform_events (Steam sales, events, etc.)
    const { data: recentEvents } = await db
      .from('platform_events')
      .select('id, name, start_date, end_date, platform_id')
      .gte('start_date', sevenDaysAgo)
      .order('start_date', { ascending: false })
      .limit(50)

    if (recentEvents && recentEvents.length > 0) {
      for (const event of recentEvents) {
        if (!event.start_date) continue

        const eventEnd = new Date(new Date(event.start_date).getTime() + REVERSE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

        // Check if any PR mentions appeared within 5 days after this event
        const { data: followUpMentions } = await db
          .from('coverage_items')
          .select('id, game_id, client_id, title, publish_date')
          .in('approval_status', ['auto_approved', 'manually_approved'])
          .gte('publish_date', event.start_date)
          .lte('publish_date', eventEnd)
          .not('game_id', 'is', null)
          .limit(20)

        if (followUpMentions && followUpMentions.length >= 2) {
          // Multiple PR mentions after a sales event = potential sales_to_pr correlation
          for (const mention of followUpMentions.slice(0, 3)) {
            const exists = await db
              .from('correlation_candidates')
              .select('id')
              .eq('coverage_item_id', mention.id)
              .eq('direction', 'sales_to_pr')
              .limit(1)

            if (!exists.data || exists.data.length === 0) {
              await db.from('correlation_candidates').insert({
                game_id: mention.game_id,
                client_id: mention.client_id,
                coverage_item_id: mention.id,
                event_type: 'steam_event',
                event_date: event.start_date,
                outlet_or_source: event.name,
                suspected_effect: 'pr_pickup',
                direction: 'sales_to_pr',
                detection_confidence: 0.5,
                status: 'pending',
              })
              candidatesCreated++
            }
          }
        }
      }
    }

    return NextResponse.json({
      success: true,
      candidates_created: candidatesCreated,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error('Correlation detection failed:', error)
    return NextResponse.json({ error: 'Correlation detection failed', details: String(error) }, { status: 500 })
  }
}
