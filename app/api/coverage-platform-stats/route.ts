import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  return createClient(url, key)
}

// GET /api/coverage-platform-stats
// Returns item counts + last discovered per social platform for the Sources page display
export async function GET() {
  const supabase = getSupabase()
  const platforms = ['youtube', 'twitch', 'reddit', 'twitter', 'tiktok', 'instagram']
  const stats: Record<string, { total: number; lastSeen: string | null }> = {}

  await Promise.all(platforms.map(async (platform) => {
    const { count } = await supabase
      .from('coverage_items')
      .select('*', { count: 'exact', head: true })
      .eq('source_type', platform)

    const { data: latest } = await supabase
      .from('coverage_items')
      .select('discovered_at')
      .eq('source_type', platform)
      .order('discovered_at', { ascending: false })
      .limit(1)
      .single()

    stats[platform] = {
      total: count || 0,
      lastSeen: latest?.discovered_at || null
    }
  }))

  return NextResponse.json(stats)
}
