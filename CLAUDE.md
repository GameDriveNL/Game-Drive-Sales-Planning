# CLAUDE.md — Claude Code Onboarding

> **Read this file first.** It tells you what the project is, what's built, what's next, and where everything lives.

## What Is This Project?

GameDrive Sales Planning Tool — a Next.js 14 + Supabase app for a Dutch PR & marketing agency (Game Drive) that manages game sales across Steam, PlayStation, Xbox, Nintendo, and Epic.

**Two major systems:**
1. **Sales Planning Tool** (MVP complete) — Gantt timeline for scheduling game sales with cooldown validation, multi-client support, Steam analytics, Excel export
2. **PR Coverage Tracker** (building now) — Automated discovery and tracking of press/media coverage for game clients. Issues #62–#97 in GitHub.

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

## What To Build Next: PR Coverage Tracker

**Start with GitHub Issues #62–#97.** They are organized into epics with priority labels.

### Architecture Decision: Simplified API Stack

**Only 3 required API keys** (plus 1 optional):
- `TAVILY_API_KEY` — Web search for coverage discovery (~$20-40/mo)
- `GOOGLE_AI_API_KEY` — AI relevance scoring via Gemini Flash (free)
- `APIFY_API_KEY` — YouTube, Twitch, Reddit, Twitter/X, TikTok, Instagram monitoring ($30-65/mo)
- `DISCORD_WEBHOOK_URL` — Coverage alert notifications (free, optional)

**Important:** We do NOT use separate YouTube/Twitch/Reddit API keys. All platform monitoring goes through Apify for simplicity. See Issues #96 and #97 for details on this consolidation.

### Build Order (Phase 1 — Must Have)

1. **Issue #62** — Database schema migration (4 new tables: `coverage_items`, `outlets`, `coverage_keywords`, `coverage_campaigns`)
2. **Issue #67** — RSS Feed Aggregation Engine
3. **Issue #68** — Tavily Web Search Integration
4. **Issue #74** — Hypestat Traffic Auto-Enrichment
5. **Issue #96** — AI scoring uses Gemini (NOT Claude/Anthropic)
6. **Issue #97** — YouTube/Twitch/Reddit all via Apify (NOT individual free APIs)
7. **Issue #79** — Internal Coverage Feed View
8. **Issue #80** — Summary Dashboard
9. **Issues #86, #87, #88** — Client Report Builder (Summary, Sales, PR sections)

See `docs/PR_COVERAGE_ARCHITECTURE.md` for full technical spec.

### New Routes to Create

```
app/coverage/                    # Coverage feed & dashboard
app/coverage/sources/            # Source Management Hub (3-tab admin: RSS, Tavily, Apify)
app/coverage/outlets/            # Outlet registry
app/coverage/keywords/           # Keyword management
app/coverage/reports/            # Client report builder
app/coverage/[clientSlug]/       # Public shareable coverage feed
app/api/coverage/scrape/         # Scraper API routes
app/api/coverage/enrich/         # Enrichment API routes
app/settings/                    # API key management (Tavily, Gemini, Apify, Discord)
```

### New Dependencies Needed

```bash
npm install rss-parser           # RSS feed parsing
npm install @google/generative-ai # Gemini AI for relevance scoring
# Tavily — REST API via fetch
# Apify — REST API via fetch (covers YouTube, Twitch, Reddit, Twitter, TikTok, Instagram)
```

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

See `.env.example` for all required keys. PR coverage needs:
- `TAVILY_API_KEY` — Web search for coverage discovery
- `GOOGLE_AI_API_KEY` — AI relevance scoring (Gemini Flash)
- `APIFY_API_KEY` — YouTube, Twitch, Reddit, Twitter/X, TikTok, Instagram (all-in-one)
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
- **PR Coverage spec:** See `docs/PR_COVERAGE_ARCHITECTURE.md`

---

## Autonomy Settings

- **Do not ask for approval before taking actions** — file edits, shell commands, tool calls
- **Complete tasks end-to-end without interruption** — do not pause mid-task to confirm steps
- **Only stop and ask if genuinely blocked** — missing credentials, truly ambiguous destructive operations, or explicit decisions that cannot be inferred from this file
- Questions are fine; approval prompts are not
