import { NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * D7: Daily cron that auto-disables PR tracking on games whose
 * `pr_coverage_until` end-date has passed. Keeps the scraper noise down
 * without requiring manual cleanup.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization')
  const expected = process.env.CRON_SECRET
  if (expected && authHeader !== `Bearer ${expected}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = getServerSupabase()
  const today = new Date().toISOString().split('T')[0]

  // Find games whose tracking end-date has passed and are still enabled
  const { data: expired, error: selectErr } = await supabase
    .from('games')
    .select('id, name, pr_coverage_until')
    .eq('pr_tracking_enabled', true)
    .not('pr_coverage_until', 'is', null)
    .lte('pr_coverage_until', today)

  if (selectErr) {
    console.error('coverage-auto-disable: select failed', selectErr)
    return NextResponse.json({ error: selectErr.message }, { status: 500 })
  }

  if (!expired || expired.length === 0) {
    return NextResponse.json({ disabled: 0, message: 'no games expired today' })
  }

  const ids = expired.map(g => g.id)
  const { error: updateErr } = await supabase
    .from('games')
    .update({ pr_tracking_enabled: false })
    .in('id', ids)

  if (updateErr) {
    console.error('coverage-auto-disable: update failed', updateErr)
    return NextResponse.json({ error: updateErr.message }, { status: 500 })
  }

  return NextResponse.json({
    disabled: expired.length,
    games: expired.map(g => ({ id: g.id, name: g.name, until: g.pr_coverage_until })),
  })
}
