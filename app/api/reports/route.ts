import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { getDisplayMetrics, getPrimaryReach } from '@/lib/coverage-metrics'

function getSupabase() {
  return getServerSupabase()
}

// GET /api/reports — Fetch combined sales + coverage data for a client report
export async function GET(request: NextRequest) {
  const supabase = getSupabase()
  const { searchParams } = new URL(request.url)

  const clientId = searchParams.get('client_id')
  const gameId = searchParams.get('game_id')
  const dateFrom = searchParams.get('date_from')
  const dateTo = searchParams.get('date_to')
  const section = searchParams.get('section') // 'summary' | 'sales' | 'pr_coverage' | 'social' | 'twitch_analytics'

  if (!clientId) {
    return NextResponse.json({ error: 'client_id is required' }, { status: 400 })
  }

  try {
    const result: Record<string, unknown> = {}
    // Each section is independent of the others (they only read request params and
    // write their own key on `result`), so they're run concurrently instead of one
    // after another — the route's total latency used to be the sum of every
    // section's query time, now it's the slowest single section.
    const tasks: Promise<void>[] = []

    const wantsSales = !section || section === 'summary' || section === 'sales'
    const wantsCoverage = !section || section === 'summary' || section === 'pr_coverage'
    const wantsSocial = !section || section === 'summary' || section === 'social'
    const wantsTwitch = !section || section === 'summary' || section === 'twitch_analytics'

    // --- Sales data (from unified_performance_view) ---
    // Used to paginate through every matching row (1000 at a time, sequentially)
    // and sum them in JS. For a client with years of history — e.g. 138k+ rows
    // for tobspr Games — that meant ~139 round trips, each one costing more than
    // the last (OFFSET pagination has to walk and discard every prior row), and
    // it either hung for minutes or hit Postgres's statement timeout outright.
    // get_sales_report_summary (migration add_sales_report_summary_rpc.sql) does
    // the same grouping/summing as a single query in Postgres instead.
    if (wantsSales) {
      tasks.push((async () => {
        const { data, error } = await supabase.rpc('get_sales_report_summary', {
          p_client_id: clientId,
          p_date_from: dateFrom || null,
          p_date_to: dateTo || null,
        })
        if (error) throw error

        const summary = (data || {}) as {
          total_rows?: number
          total_gross_revenue?: number
          total_net_revenue?: number
          total_gross_units?: number
          total_net_units?: number
          platform_revenue?: { name: string; value: number }[]
          platform_units?: { name: string; value: number }[]
          country_revenue?: { name: string; value: number }[]
          product_revenue?: { name: string; value: number }[]
          product_units?: { name: string; value: number }[]
          daily_revenue?: { date: string; value: number }[]
        }

        const totalNetRevenue = Number(summary.total_net_revenue || 0)
        const totalNetUnits = Number(summary.total_net_units || 0)

        result.sales = {
          total_rows: Number(summary.total_rows || 0),
          total_gross_revenue: Number(summary.total_gross_revenue || 0),
          total_net_revenue: totalNetRevenue,
          total_gross_units: Number(summary.total_gross_units || 0),
          total_net_units: totalNetUnits,
          avg_price: totalNetUnits > 0 ? totalNetRevenue / totalNetUnits : 0,
          platform_revenue: summary.platform_revenue || [],
          platform_units: summary.platform_units || [],
          country_revenue: summary.country_revenue || [],
          product_revenue: summary.product_revenue || [],
          product_units: summary.product_units || [],
          daily_revenue: summary.daily_revenue || [],
        }
      })())
    }

    // --- Coverage data ---
    if (wantsCoverage) {
      tasks.push((async () => {
        let covQuery = supabase
          .from('coverage_items')
          .select(`
            id, title, url, publish_date, territory, coverage_type,
            monthly_unique_visitors, review_score, quotes, sentiment,
            approval_status, campaign_section, discovered_at, source_type, source_metadata,
            outlet:outlets(id, name, domain, tier, monthly_unique_visitors),
            game:games(id, name),
            campaign:coverage_campaigns(id, name)
          `)
          .eq('client_id', clientId)
          .in('approval_status', ['auto_approved', 'manually_approved'])
          .order('publish_date', { ascending: false })

        if (gameId) covQuery = covQuery.eq('game_id', gameId)
        // GD-001: YouTube items from Apify often have null publish_date.
        // Fall back to discovered_at for null-date items so they're not silently excluded.
        if (dateFrom) covQuery = covQuery.or(`publish_date.gte.${dateFrom},and(publish_date.is.null,discovered_at.gte.${dateFrom})`)
        if (dateTo) covQuery = covQuery.or(`publish_date.lte.${dateTo},and(publish_date.is.null,discovered_at.lte.${dateTo})`)

        const { data: covData, error: covError } = await covQuery.limit(5000)
        if (covError) throw covError

        const SOCIAL_SOURCE_TYPES = new Set(['youtube', 'twitter', 'tiktok', 'twitch', 'instagram', 'reddit'])

        const items = covData || []
        let totalReach = 0
        let estimatedViews = 0
        let totalScoreSum = 0
        let scoredCount = 0
        const tierBreakdown: Record<string, number> = {}
        const typeBreakdown: Record<string, number> = {}
        const territoryBreakdown: Record<string, number> = {}
        const topOutlets: Record<string, { name: string; count: number; tier: string; visitors: number }> = {}

        // Enrich items with display_metrics before returning
        const enrichedItems: Record<string, unknown>[] = items.map((item) => {
          const i = item as Record<string, unknown>
          const outlet = i.outlet as Record<string, unknown> | null
          const sourceType = (i.source_type as string | null) || null
          const meta = (i.source_metadata as Record<string, unknown> | null) || null
          const display_metrics = getDisplayMetrics(sourceType, meta)
          const display_visitors = getPrimaryReach(sourceType, meta, outlet?.monthly_unique_visitors as number | null)
          return { ...i, display_metrics, display_visitors } as Record<string, unknown>
        })

        for (const item of enrichedItems) {
          const outlet = item.outlet as Record<string, unknown> | null
          const sourceType = (item.source_type as string | null) || ''
          const reach = (item.display_visitors as number | null) || 0
          totalReach += reach
          estimatedViews += SOCIAL_SOURCE_TYPES.has(sourceType) ? reach : Math.round(reach * 0.02)

          if (item.review_score) {
            totalScoreSum += Number(item.review_score)
            scoredCount++
          }

          const tier = String(outlet?.tier || 'untiered')
          tierBreakdown[tier] = (tierBreakdown[tier] || 0) + 1

          const covType = String(item.coverage_type || 'article')
          typeBreakdown[covType] = (typeBreakdown[covType] || 0) + 1

          const territory = String(item.territory || 'Unknown')
          territoryBreakdown[territory] = (territoryBreakdown[territory] || 0) + 1

          if (outlet) {
            const outletId = String(outlet.id)
            if (!topOutlets[outletId]) {
              topOutlets[outletId] = {
                name: String(outlet.name || outlet.domain || 'Unknown'),
                count: 0,
                tier: String(outlet.tier || 'untiered'),
                visitors: Number(outlet.monthly_unique_visitors || 0),
              }
            }
            topOutlets[outletId].count++
            // GD-003: if DB traffic is missing, accumulate max item-level reach seen
            // across all items from this outlet (each item may have subscriber counts).
            if (!outlet.monthly_unique_visitors && reach > topOutlets[outletId].visitors) {
              topOutlets[outletId].visitors = reach
            }
          } else if (sourceType) {
            // GD-001: items discovered without a registered outlet (e.g. YouTube
            // videos) were dropped from the report entirely. Aggregate them under a
            // synthetic per-source bucket so they're included instead of vanishing.
            const key = `src:${sourceType}`
            if (!topOutlets[key]) {
              topOutlets[key] = {
                name: sourceType.charAt(0).toUpperCase() + sourceType.slice(1),
                count: 0,
                tier: 'untiered',
                visitors: 0,
              }
            }
            topOutlets[key].count++
            topOutlets[key].visitors += reach
          }
        }

        result.coverage = {
          total_pieces: items.length,
          total_audience_reach: totalReach,
          estimated_views: estimatedViews,
          avg_review_score: scoredCount > 0 ? Math.round((totalScoreSum / scoredCount) * 10) / 10 : null,
          tier_breakdown: Object.entries(tierBreakdown).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value })),
          type_breakdown: Object.entries(typeBreakdown).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value })),
          territory_breakdown: Object.entries(territoryBreakdown).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value })),
          top_outlets: Object.values(topOutlets).sort((a, b) => b.count - a.count).slice(0, 15),
          items: section === 'pr_coverage' ? enrichedItems : enrichedItems.slice(0, 50),
        }
      })())
    }

    // --- Social media data (from coverage_items with social source_types) ---
    if (wantsSocial) {
      tasks.push((async () => {
        const socialTypes = ['twitter', 'tiktok', 'instagram', 'youtube', 'twitch', 'reddit']

        let socialQuery = supabase
          .from('coverage_items')
          .select('id, title, url, publish_date, source_type, coverage_type, monthly_unique_visitors, sentiment, source_metadata, outlet:outlets(name, domain, tier)')
          .eq('client_id', clientId)
          .in('source_type', socialTypes)
          .in('approval_status', ['auto_approved', 'manually_approved', 'pending_review'])
          .order('discovered_at', { ascending: false })

        if (gameId) socialQuery = socialQuery.eq('game_id', gameId)
        if (dateFrom) socialQuery = socialQuery.or(`publish_date.gte.${dateFrom},and(publish_date.is.null,discovered_at.gte.${dateFrom})`)
        if (dateTo) socialQuery = socialQuery.or(`publish_date.lte.${dateTo},and(publish_date.is.null,discovered_at.lte.${dateTo})`)

        const { data: socialData, error: socialError } = await socialQuery.limit(5000)
        if (socialError) throw socialError

        const socialItems = socialData || []

        // Aggregate by platform
        const platformStats: Record<string, {
          count: number; total_followers: number; total_views: number
          total_likes: number; total_comments: number; total_shares: number
          best_post: { title: string; url: string; engagement: number } | null
          worst_post: { title: string; url: string; engagement: number } | null
        }> = {}

        let totalEngagement = 0
        let totalReach = 0
        const sentimentCounts: Record<string, number> = {}

        for (const item of socialItems) {
          const i = item as Record<string, unknown>
          const sourceType = String(i.source_type || 'unknown')
          const meta = (i.source_metadata || {}) as Record<string, unknown>

          if (!platformStats[sourceType]) {
            platformStats[sourceType] = {
              count: 0, total_followers: 0, total_views: 0,
              total_likes: 0, total_comments: 0, total_shares: 0,
              best_post: null, worst_post: null,
            }
          }

          const ps = platformStats[sourceType]
          ps.count++
          // Platform-specific field mapping — each scraper uses different field names
          let followers = 0, views = 0, likes = 0, comments = 0, shares = 0
          switch (sourceType) {
            case 'youtube':
              followers = Number(meta.subscribers || 0)
              views     = Number(meta.views || 0)
              likes     = Number(meta.likes || 0)
              comments  = Number(meta.comments || 0)
              break
            case 'twitter':
              followers = Number(meta.followers || 0)
              views     = Number(meta.views || 0)          // tweet impressions
              likes     = Number(meta.likes || 0)
              comments  = Number(meta.replies || 0)
              shares    = Number(meta.retweets || 0)
              break
            case 'tiktok':
              followers = Number(meta.followers || 0)
              views     = Number(meta.views || 0)          // play count
              likes     = Number(meta.likes || 0)
              comments  = Number(meta.comments || 0)
              shares    = Number(meta.shares || 0)
              break
            case 'twitch':
              followers = Number(meta.followers || 0)
              views     = Number(meta.view_count || 0)     // VOD views
              break
            case 'reddit':
              // Reddit has no reach/follower data from hashtag scraper
              likes     = Number(meta.score || 0)          // upvotes
              comments  = Number(meta.num_comments || 0)
              break
            case 'instagram':
              // Instagram hashtag scraper doesn't return follower counts
              likes     = Number(meta.likes || 0)
              comments  = Number(meta.comments || 0)
              break
            default:
              followers = Number(meta.followers || 0)
              views     = Number(meta.views || 0)
              likes     = Number(meta.likes || 0)
              comments  = Number(meta.comments || 0)
              shares    = Number(meta.shares || 0)
          }

          ps.total_followers += followers
          ps.total_views += views
          ps.total_likes += likes
          ps.total_comments += comments
          ps.total_shares += shares

          const engagement = likes + comments + shares
          totalEngagement += engagement
          totalReach += followers

          // Track best/worst by engagement
          if (!ps.best_post || engagement > ps.best_post.engagement) {
            ps.best_post = { title: String(i.title || ''), url: String(i.url || ''), engagement }
          }
          if (!ps.worst_post || (engagement < ps.worst_post.engagement && engagement >= 0)) {
            ps.worst_post = { title: String(i.title || ''), url: String(i.url || ''), engagement }
          }

          const sentiment = String(i.sentiment || 'unknown')
          sentimentCounts[sentiment] = (sentimentCounts[sentiment] || 0) + 1
        }

        // Top performing posts across all platforms
        const allPosts = socialItems.map(item => {
          const i = item as Record<string, unknown>
          const meta = (i.source_metadata || {}) as Record<string, unknown>
          const st = String(i.source_type || '')
          const followers = st === 'youtube' ? Number(meta.subscribers || 0) : Number(meta.followers || 0)
          const views = st === 'twitch' ? Number(meta.view_count || 0) : Number(meta.views || 0)
          const likes = st === 'reddit' ? Number(meta.score || 0) : Number(meta.likes || 0)
          const comments = st === 'reddit' ? Number(meta.num_comments || 0) : st === 'twitter' ? Number(meta.replies || 0) : Number(meta.comments || 0)
          const shares = st === 'twitter' ? Number(meta.retweets || 0) : Number(meta.shares || 0)
          return {
            id: String(i.id), title: String(i.title || ''), url: String(i.url || ''),
            source_type: st, publish_date: String(i.publish_date || ''),
            outlet_name: ((i.outlet as Record<string, unknown> | null)?.name as string) || '',
            followers, views, likes, comments, shares,
            engagement: likes + comments + shares,
          }
        }).sort((a, b) => b.engagement - a.engagement)

        result.social = {
          total_posts: socialItems.length,
          total_reach: totalReach,
          total_engagement: totalEngagement,
          engagement_rate: totalReach > 0 ? ((totalEngagement / totalReach) * 100) : 0,
          platform_breakdown: Object.entries(platformStats)
            .sort((a, b) => b[1].count - a[1].count)
            .map(([platform, stats]) => ({ platform, ...stats })),
          sentiment_breakdown: Object.entries(sentimentCounts)
            .sort((a, b) => b[1] - a[1])
            .map(([name, value]) => ({ name, value })),
          top_posts: allPosts.slice(0, 10),
          worst_posts: allPosts.slice(-5).reverse(),
        }
      })())
    }

    // --- Twitch Analytics (SullyGnome enriched data) ---
    if (wantsTwitch) {
      tasks.push((async () => {
        let twitchQuery = supabase
          .from('coverage_items')
          .select('id, title, url, source_type, source_metadata, monthly_unique_visitors, outlet:outlets(name, domain)')
          .eq('client_id', clientId)
          .eq('source_type', 'twitch')
          .in('approval_status', ['auto_approved', 'manually_approved', 'pending_review'])
          .order('discovered_at', { ascending: false })

        if (gameId) twitchQuery = twitchQuery.eq('game_id', gameId)

        const { data: twitchData, error: twitchError } = await twitchQuery.limit(5000)
        if (twitchError) throw twitchError

        const twitchItems = twitchData || []
        let totalStreamers = 0
        let enrichedCount = 0
        let totalHoursWatched = 0
        let totalStreamHours = 0
        let totalAvgViewersSum = 0
        let totalPeakViewersSum = 0
        let peakViewersMax = 0

        interface StreamerEntry {
          channel: string
          url: string
          avg_viewers: number
          peak_viewers: number
          hours_watched: number
          stream_hours: number
          followers: number
          time_range: string | null
          outlet_name: string
        }
        const streamers: StreamerEntry[] = []

        for (const item of twitchItems) {
          const i = item as Record<string, unknown>
          const meta = (i.source_metadata || {}) as Record<string, unknown>
          const outlet = i.outlet as Record<string, unknown> | null

          totalStreamers++

          if (meta.sullygnome_enriched) {
            enrichedCount++

            const avgViewers = Number(meta.sullygnome_avg_viewers || 0)
            const peakViewers = Number(meta.sullygnome_peak_viewers || 0)
            const hoursWatched = Number(meta.sullygnome_hours_watched || 0)
            const streamHours = Number(meta.sullygnome_stream_hours || 0)
            const followers = Number(meta.followers || i.monthly_unique_visitors || 0)

            totalHoursWatched += hoursWatched
            totalStreamHours += streamHours
            totalAvgViewersSum += avgViewers
            totalPeakViewersSum += peakViewers
            if (peakViewers > peakViewersMax) peakViewersMax = peakViewers

            streamers.push({
              channel: String(meta.user_name || i.title || 'Unknown'),
              url: String(i.url || ''),
              avg_viewers: avgViewers,
              peak_viewers: peakViewers,
              hours_watched: hoursWatched,
              stream_hours: streamHours,
              followers,
              time_range: meta.sullygnome_time_range ? String(meta.sullygnome_time_range) : null,
              outlet_name: String(outlet?.name || ''),
            })
          }
        }

        // Sort streamers by hours watched descending
        streamers.sort((a, b) => b.hours_watched - a.hours_watched)

        result.twitch_analytics = {
          total_streamers: totalStreamers,
          enriched_streamers: enrichedCount,
          total_hours_watched: totalHoursWatched,
          total_stream_hours: totalStreamHours,
          avg_viewers_mean: enrichedCount > 0 ? Math.round(totalAvgViewersSum / enrichedCount) : 0,
          avg_peak_viewers: enrichedCount > 0 ? Math.round(totalPeakViewersSum / enrichedCount) : 0,
          max_peak_viewers: peakViewersMax,
          top_streamers_by_hours: streamers.slice(0, 10),
          top_streamers_by_avg_viewers: [...streamers].sort((a, b) => b.avg_viewers - a.avg_viewers).slice(0, 10),
          top_streamers_by_peak: [...streamers].sort((a, b) => b.peak_viewers - a.peak_viewers).slice(0, 5),
        }
      })())
    }

    // --- Wishlist data (from steam_wishlists) ---
    if (wantsSales) {
      tasks.push((async () => {
        // Resolve game_ids for this client (optionally filtered to a specific game)
        let gamesForWl: { id: string; name: string }[] = []
        if (gameId) {
          const { data: gd } = await supabase.from('games').select('id, name').eq('id', gameId).single()
          if (gd) gamesForWl = [gd]
        } else {
          const { data: gd } = await supabase.from('games').select('id, name').eq('client_id', clientId)
          gamesForWl = gd || []
        }

        if (gamesForWl.length > 0) {
          const gameIds = gamesForWl.map(g => g.id)
          let wlQuery = supabase
            .from('steam_wishlists')
            .select('date, additions, deletions, purchases_and_activations, gifts, game_id')
            .in('game_id', gameIds)
            .order('date', { ascending: true })

          if (dateFrom) wlQuery = wlQuery.gte('date', dateFrom)
          if (dateTo) wlQuery = wlQuery.lte('date', dateTo)

          const { data: wlRows } = await wlQuery

          if (wlRows && wlRows.length > 0) {
            let totalAdditions = 0
            let totalDeletions = 0
            let totalPurchases = 0
            let totalGifts = 0
            const dailyWl: Record<string, { additions: number; deletions: number; purchases: number }> = {}
            const gameBreakdown: Record<string, { name: string; additions: number; deletions: number; purchases: number }> = {}
            const gameNameMap = Object.fromEntries(gamesForWl.map(g => [g.id, g.name]))

            for (const row of wlRows) {
              const r = row as Record<string, unknown>
              const adds = Number(r.additions || 0)
              const dels = Number(r.deletions || 0)
              const purch = Number(r.purchases_and_activations || 0)
              const gifts = Number(r.gifts || 0)
              const date = String(r.date || '')
              const gid = String(r.game_id || '')

              totalAdditions += adds
              totalDeletions += dels
              totalPurchases += purch
              totalGifts += gifts

              if (date) {
                if (!dailyWl[date]) dailyWl[date] = { additions: 0, deletions: 0, purchases: 0 }
                dailyWl[date].additions += adds
                dailyWl[date].deletions += dels
                dailyWl[date].purchases += purch
              }

              if (gid) {
                if (!gameBreakdown[gid]) gameBreakdown[gid] = { name: gameNameMap[gid] || gid, additions: 0, deletions: 0, purchases: 0 }
                gameBreakdown[gid].additions += adds
                gameBreakdown[gid].deletions += dels
                gameBreakdown[gid].purchases += purch
              }
            }

            result.wishlist = {
              total_additions: totalAdditions,
              total_deletions: totalDeletions,
              total_purchases: totalPurchases,
              total_gifts: totalGifts,
              net_wishlists: totalAdditions - totalDeletions,
              conversion_rate: totalAdditions > 0 ? ((totalPurchases / totalAdditions) * 100) : 0,
              daily: Object.entries(dailyWl)
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([date, d]) => ({ date, ...d })),
              game_breakdown: Object.values(gameBreakdown).sort((a, b) => b.additions - a.additions),
            }
          }
        }
      })())
    }

    // --- Annotations ---
    tasks.push((async () => {
      let annQuery = supabase
        .from('report_annotations')
        .select('*')
        .eq('client_id', clientId)

      if (gameId) annQuery = annQuery.eq('game_id', gameId)

      const { data: annotations } = await annQuery
      result.annotations = annotations || []
    })())

    // --- Event annotations (sale start, trailer release, etc. — distinct from the
    // free-text editorial notes above, which share the confusingly similar name
    // "annotations" but live in the same report_annotations table under different
    // columns). These come from pr_annotations, shown on the Revenue Over Period
    // chart. See feedback card de5900a8. ---
    tasks.push((async () => {
      let eventAnnQuery = supabase
        .from('pr_annotations')
        .select('id, game_id, event_type, event_date, outlet_or_source, notes')
        .eq('client_id', clientId)

      if (gameId) eventAnnQuery = eventAnnQuery.eq('game_id', gameId)
      if (dateFrom) eventAnnQuery = eventAnnQuery.gte('event_date', dateFrom)
      if (dateTo) eventAnnQuery = eventAnnQuery.lte('event_date', dateTo)

      const { data: eventAnnotations } = await eventAnnQuery
      result.eventAnnotations = eventAnnotations || []
    })())

    // --- Client & game info ---
    tasks.push((async () => {
      const { data: clientData } = await supabase
        .from('clients')
        .select('id, name')
        .eq('id', clientId)
        .single()

      result.client = clientData

      if (gameId) {
        const { data: gameData } = await supabase
          .from('games')
          .select('id, name')
          .eq('id', gameId)
          .single()
        result.game = gameData
      }
    })())

    await Promise.all(tasks)

    return NextResponse.json(result)
  } catch (err: unknown) {
    // PostgrestError-shaped rejections (and some Postgres errors surfaced through
    // supabase-js) aren't always `instanceof Error`, so `err.message` alone was
    // silently collapsing real causes (e.g. a statement timeout) into "Unknown error".
    let message: string
    if (err instanceof Error) {
      message = err.message
    } else {
      try {
        message = JSON.stringify(err)
      } catch {
        message = String(err)
      }
    }
    console.error('reports GET failed:', err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// POST /api/reports/annotations — Save/update an annotation
export async function POST(request: NextRequest) {
  const supabase = getSupabase()

  try {
    const body = await request.json()
    const { client_id, game_id, report_section, period_key, annotation_text, custom_fields } = body

    if (!client_id || !report_section || !period_key) {
      return NextResponse.json({ error: 'client_id, report_section, and period_key are required' }, { status: 400 })
    }

    const { data, error } = await supabase
      .from('report_annotations')
      .upsert(
        {
          client_id,
          game_id: game_id || null,
          report_section,
          period_key,
          annotation_text: annotation_text || '',
          custom_fields: custom_fields || {},
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'client_id,report_section,period_key' }
      )
      .select()
      .single()

    if (error) throw error
    return NextResponse.json(data)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
