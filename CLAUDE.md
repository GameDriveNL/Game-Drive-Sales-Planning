# CLAUDE.md — Claude Code Onboarding

> **Read this file first.** It tells you what the project is, what's built, what's next, and where everything lives.

## What Is This Project?

GameDrive Sales Planning Tool — a Next.js 14 + Supabase app for a Dutch PR & marketing agency (Game Drive) that manages game sales across Steam, PlayStation, Xbox, Nintendo, and Epic.

**Two major systems:**
1. **Sales Planning Tool** (MVP complete) — Gantt timeline for scheduling game sales with cooldown validation, multi-client support, Steam analytics, Excel export
2. **PR Coverage Tracker** (built, live in production) — Automated discovery and tracking of press/media coverage for game clients. 70k+ coverage items tracked as of 2026-09-18. See below.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | Next.js 14.0.4 (App Router) |
| Database | Supabase (PostgreSQL) — project `znueqcmlqfdhetnierno` |
| Hosting | Vercel — project `prj_aKbiJdM5fbOPa8YeCc5aCEQWqzcK` |
| Styling | CSS Modules (NO Tailwind — it fails silently on Vercel) |
| Auth | Supabase Auth with RLS |
| Language | TypeScript |

## Critical Rules

1. **CSS Modules ONLY** — Tailwind had silent compilation failures on Vercel. Use `.module.css` files.
2. **Fixed heights for timeline** — Use `height` not `min-height` for row positioning.
3. **Supabase returns strings** — Numeric fields come back as `"19.99"` not `19.99`. Use `toNumber()` helper.
4. **GitHub pushes** — For complex TypeScript files, use `push_files` not `create_or_update_file` to prevent HTML entity corruption.
5. **Optimistic UI** — Update React state immediately, rollback on server error.

## PR Coverage Tracker (built, live)

Live production system, not a build-from-scratch project — 130+ commits from 2026-02-11 to 2026-08-18, 70,891 rows in `coverage_items` as of 2026-09-18. Further work is incremental (see the in-app `/feedback` board), not a fresh build. The Issues #62–#97 / `docs/PR_COVERAGE_ARCHITECTURE.md` plan below is the **original design doc** — useful for intent, but the "Apify for everything" decision it describes was later reversed (see below), so don't trust it over the actual code.

### Actual data sources (as built — NOT Apify)

- **Tavily** (`TAVILY_API_KEY`) — web search discovery. Runs in `app/api/cron/tavily-scan` (2x/day) and powers manual backfill (`app/api/coverage-backfill`).
- **RSS** (`rss-parser`) — `app/api/cron/rss-scan` (hourly, per-outlet feeds) + `app/api/cron/google-news-scan` (every 4h, 8 languages).
- **YouTube Data API** (`YOUTUBE_DATA_API_KEY`) — `lib/youtube-data-api.ts`, plus `app/api/cron/youtube-rss-poll` (every 30 min) for tracked creator channels ("Creator Watch").
- **Twitch Helix** (`TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET`) — VODs, live streams, clips.
- **Reddit** — public JSON API (`lib/reddit-public-api.ts`), no key needed.
- **Google AI/Gemini** (`GOOGLE_AI_API_KEY`) — enrichment/classification, `app/api/cron/coverage-enrich` (every 15 min).
- **Apify is intentionally NOT used.** It was the original plan (see architecture doc) but was abandoned for quota-cost reasons — `app/api/cron/full-backfill/route.ts` has a comment explaining why, and commit `2fecb7b` moved Creator Watch off a paid Apify actor onto the free YouTube Data API.

### Routes under `app/coverage/`

- `page.tsx` — outlet directory (list/add/edit outlets, tier, MUV, country)
- `dashboard/` — coverage overview metrics + scanner health panel
- `feed/` — live coverage item feed; has the CSV/TSV **"Import CSV"** button (`components/CoverageImporter.tsx`) for merging manually-tracked items with auto-found ones
- `keywords/` — whitelist/blacklist keyword management per client/game
- `sources/` — scan source config (RSS feeds, Tavily) + Creator Watch + **"🔍 Retroactive Search"** (pick a game, optional date range, backfills via `/api/coverage-backfill`; also auto-fires once when a game is first created)
- `report/` — client-facing coverage report export (Excel)
- `campaign-report/` — campaign-scoped coverage report export
- `reception/` — sentiment/reception analytics
- `competitors/` — competitor game coverage + eWOM comparison
- `timeline/` — coverage timeline overlaid with sales data
- `backfill/` — data-hygiene dashboard (fixing missing outlet/date/territory fields, HypeStat traffic enrichment) — NOT the same thing as the discovery backfill in `sources/`
- `clients/` — redirects to `/settings/clients`

## File Structure (Current)

```
├── CLAUDE.md                    # THIS FILE — read first
├── CLAUDE_CONTEXT.md            # Detailed MCP tools reference, Supabase/Vercel IDs
├── app/
│   ├── page.tsx                 # Main Gantt timeline (home page)
│   ├── analytics/               # Steam analytics dashboard
│   ├── clients/                 # Client management
│   ├── platforms/               # Platform settings
│   ├── settings/                # API key management
│   ├── export/                  # Excel export
│   ├── permissions/             # User management & RBAC
│   ├── components/              # Shared components
│   └── api/                     # API routes
├── lib/
│   ├── supabase.ts              # Supabase client
│   ├── types.ts                 # TypeScript types
│   ├── validation.ts            # Cooldown validation
│   └── dateUtils.ts             # Date helpers
├── docs/
│   ├── PR_COVERAGE_ARCHITECTURE.md  # Full PR coverage technical spec
│   ├── PROJECT_PROGRESS.md      # Session-by-session progress log
│   └── DEVELOPMENT_WORKFLOW.md  # Dev patterns
└── supabase/migrations/         # Applied SQL migrations
```

## Environment Variables

See `.env.example` for all required keys. PR coverage uses:
- `TAVILY_API_KEY` — Web search for coverage discovery
- `GOOGLE_AI_API_KEY` — AI relevance scoring (Gemini Flash)
- `YOUTUBE_DATA_API_KEY` — YouTube video search + Creator Watch channel polling
- `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` — Twitch VODs/streams/clips
- Reddit uses the public JSON API — no key needed
- `APIFY_API_KEY` is NOT used (abandoned for quota-cost reasons; do not reintroduce without checking with Josh first)
- `DISCORD_WEBHOOK_URL` — Coverage alert notifications (optional)

## Commands

```bash
npm run dev -- -p 3003    # Dev server on port 3003
npm run build             # Production build
npm run lint              # ESLint
```

## Key Reference

- **Production:** https://platform.game-drive.nl/ (custom domain → `game-drive-sales-planning` Vercel project on GameDriveNL team)
- **Backup URL:** https://game-drive-sales-planning.vercel.app/
- **GitHub repo:** https://github.com/GameDriveNL/Game-Drive-Sales-Planning (canonical — `joshmartin1186/Game-Drive-Sales-Planning` was archived 2026-05-07)
- **GitHub Issues:** https://github.com/GameDriveNL/Game-Drive-Sales-Planning/issues
- **Supabase:** https://supabase.com/dashboard/project/znueqcmlqfdhetnierno
- **Full MCP tools reference:** See `CLAUDE_CONTEXT.md`
- **PR Coverage spec:** See `docs/PR_COVERAGE_ARCHITECTURE.md` — original design doc, now partially outdated (see "PR Coverage Tracker (built, live)" above for what's actually true)

---

## Autonomy Settings

- **Do not ask for approval before taking actions** — file edits, shell commands, tool calls
- **Complete tasks end-to-end without interruption** — do not pause mid-task to confirm steps
- **Only stop and ask if genuinely blocked** — missing credentials, truly ambiguous destructive operations, or explicit decisions that cannot be inferred from this file
- Questions are fine; approval prompts are not
