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

    // --- Sales data (from unified_performance_view) ---
    if (!section || section === 'summary' || section === 'sales') {
      const columns = 'date,product_name,platform,country_code,country,region,gross_units_sold,chargebacks_returns,net_units_sold,base_price_usd,sale_price_usd,net_steam_sales_usd'

      let allSalesRows: Record<string, unknown>[] = []
      let offset = 0
      const batchSize = 1000

      while (true) {
        let query = supabase
          .from('unified_performance_view')
          .select(columns)
          .eq('client_id', clientId)
          .order('date', { ascending: true })
          .range(offset, offset + batchSize - 1)

        if (dateFrom) query = query.gte('date', dateFrom)
        if (dateTo) query = query.lte('date', dateTo)

        const { data, error } = await query
        if (error) throw error
        if (!data || data.length === 0) break

        allSalesRows = allSalesRows.concat(data)
        if (data.length < batchSize) break
        offset += batchSize
      }

      // Compute sales summary
      let totalGrossRevenue = 0
      let totalNetRevenue = 0
      let totalGrossUnits = 0
      let totalNetUnits = 0
      const platformRevenue: Record<string, number> = {}
      const platformUnits: Record<string, number> = {}
      const countryRevenue: Record<string, number> = {}
      const productRevenue: Record<string, number> = {}
      const productUnits: Record<string, number> = {}
      const dailyRevenue: Record<string, number> = {}

      for (const row of allSalesRows) {
        const r = row as Record<string, unknown>
        const grossRev = Number(r.net_steam_sales_usd || 0)
        const netRev = Number(r.net_steam_sales_usd || 0)
        const grossUnits = Number(r.gross_units_sold || 0)
        const netUnits = Number(r.net_units_sold || 0)
        const platform = String(r.platform || 'Unknown')
        const country = String(r.country_code || r.country || 'Unknown')
        const product = String(r.product_name || 'Unknown')
        const date = String(r.date || '')

        totalGrossRevenue += grossRev
        totalNetRevenue += netRev
        totalGrossUnits += grossUnits
        totalNetUnits += netUnits

        platformRevenue[platform] = (platformRevenue[platform] || 0) + netRev
        platformUnits[platform] = (platformUnits[platform] || 0) + netUnits
        countryRevenue[country] = (countryRevenue[country] || 0) + netRev
        productRevenue[product] = (productRevenue[product] || 0) + netRev
        productUnits[product] = (productUnits[product] || 0) + netUnits

        if (date) {
          dailyRevenue[date] = (dailyRevenue[date] || 0) + netRev
        }
      }

      // Sort breakdowns by value descending
      const sortObj = (obj: Record<string, number>) =>
        Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([key, value]) => ({ name: key, value }))

      result.sales = {
        total_rows: allSalesRows.length,
        total_gross_revenue: totalGrossRevenue,
        total_net_revenue: totalNetRevenue,
        total_gross_units: totalGrossUnits,
        total_net_units: totalNetUnits,
        avg_price: totalNetUnits > 0 ? totalNetRevenue / totalNetUnits : 0,
        platform_revenue: sortObj(platformRevenue),
        platform_units: sortObj(platformUnits),
        country_revenue: sortObj(countryRevenue).slice(0, 20),
        product_revenue: sortObj(productRevenue),
        product_units: sortObj(productUnits),
        daily_revenue: Object.entries(dailyRevenue)
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([date, value]) => ({ date, value })),
        raw_rows: section === 'sales' ? allSalesRows : undefined,
      }
    }

    // --- Coverage data ---
    if (!section || section === 'summary' || section === 'pr_coverage') {
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
      if (dateFrom) covQuery = covQuery.gte('publish_date', dateFrom)
      if (dateTo) covQuery = covQuery.lte('publish_date', dateTo)

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
              // Outlet audience size: subscribers for social, monthly visitors for news.
              // GD-003: fall back to the item's own audience figure when the outlet
              // record hasn't been traffic-enriched, so top outlets don't show 0.
              visitors: Number(outlet.monthly_unique_visitors || reach || 0),
            }
          }
          topOutlets[outletId].count++
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
    }

    // --- Social media data (from coverage_items with social source_types) ---
    if (!section || section === 'summary' || section === 'social') {
      const socialTypes = ['twitter', 'tiktok', 'instagram', 'youtube', 'twitch', 'reddit']

      let socialQuery = supabase
        .from('coverage_items')
        .select('id, title, url, publish_date, source_type, coverage_type, monthly_unique_visitors, sentiment, source_metadata, outlet:outlets(name, domain, tier)')
        .eq('client_id', clientId)
        .in('source_type', socialTypes)
        .in('approval_status', ['auto_approved', 'manually_approved', 'pending_review'])
        .order('discovered_at', { ascending: false })

      if (gameId) socialQuery = socialQuery.eq('game_id', gameId)
      if (dateFrom) socialQuery = socialQuery.gte('publish_date', dateFrom)
      if (dateTo) socialQuery = socialQuery.lte('publish_date', dateTo)

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
    }

    // --- Twitch Analytics (SullyGnome enriched data) ---
    if (!section || section === 'summary' || section === 'twitch_analytics') {
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
    }

    // --- Annotations ---
    let annQuery = supabase
      .from('report_annotations')
      .select('*')
      .eq('client_id', clientId)

    if (gameId) annQuery = annQuery.eq('game_id', gameId)

    const { data: annotations } = await annQuery
    result.annotations = annotations || []

    // --- Client & game info ---
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

    return NextResponse.json(result)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
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
