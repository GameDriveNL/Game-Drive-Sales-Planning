import { NextResponse } from 'next/server'
import { serverSupabase as supabase } from '@/lib/supabase'
import { getSteamConnections } from '@/lib/steam-connection'

// Live check, never cached: it asks Steam whether each stored key still works.
export const dynamic = 'force-dynamic'

// GET - how each client's Steam data reaches us (own key / through Game Drive / needs attention)
export async function GET() {
  try {
    return NextResponse.json(await getSteamConnections(supabase))
  } catch (error) {
    console.error('[Steam Connections] Error:', error)
    return NextResponse.json({ error: 'Failed to load Steam connections' }, { status: 500 })
  }
}
