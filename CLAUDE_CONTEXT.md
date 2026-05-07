# GameDrive Sales Planning Tool - Claude Code Project Guide

## Quick Start Commands
```bash
# Start development server on port 3003
npm run dev -- -p 3003

# Build for production
npm run build

# Type check
npm run type-check

# Lint
npm run lint
```

---

## Project Overview

**Client:** Game Drive (Utrecht, Netherlands)
**Purpose:** Replace manual Excel workflow with interactive Gantt chart for game sales planning
**Budget:** $5,000 fixed price MVP
**Status:** Core MVP complete, preparing for client deployment

### What This Tool Does
- Interactive 12-month Gantt timeline for scheduling game sales
- Platform cooldown validation (Steam 28 days, PlayStation 42 days, etc.)
- Multi-client data management (TMG, Funselektor, WeirdBeard, tobspr, Rangatang)
- Steam performance analytics dashboard with CSV import
- Excel export for client reporting

---

## Repository & Deployment Info

| Resource | Value |
|----------|-------|
| GitHub Repo | `GameDriveNL/Game-Drive-Sales-Planning` |
| Main Branch | `main` |
| Production URL | https://platform.game-drive.nl/ |
| Vercel Team ID | `team_6piiLSU3y16pH8Kt0uAlDFUu` |
| Vercel Project ID | `prj_aKbiJdM5fbOPa8YeCc5aCEQWqzcK` |
| Vercel Project Name | `game_drive_sales_planning` |
| Supabase Project ID | `znueqcmlqfdhetnierno` (eu-west-1) |
| Supabase Org ID | `gmnnavqsmgbtfocyuakq` |

### Deployment Flow
1. Make changes locally
2. Test on `localhost:3003`
3. Once approved, commit and push to GitHub
4. Vercel auto-deploys from main branch in 2-3 minutes
5. Update `docs/PROJECT_PROGRESS.md` with completed work

---

## Critical Technical Notes

### MUST READ Before Coding

| Rule | Why |
|------|-----|
| **CSS Modules ONLY** | Tailwind had silent compilation failures on Vercel - use `.module.css` files |
| **Fixed heights for timeline** | MUST use `height` (NOT `min-height`) for row positioning - absolute positioning calculations break otherwise |
| **Supabase returns strings** | Numeric fields come back as `"19.99"` not `19.99` - use `toNumber()` helper |
| **TypeScript: undefined ≠ null** | Use `value ?? null` for conversion when Supabase expects null |
| **GitHub API encoding** | For complex TypeScript files, use `push_files` NOT `create_or_update_file` - prevents HTML entity corruption |
| **Optimistic UI updates** | Update React state immediately, rollback on server error - prevents loading screens and visual jumps |

---

## File Structure

```
GameDrive/
├── app/
│   ├── page.tsx                    # Main Gantt timeline (home page)
│   ├── page.module.css             # Main page CSS
│   ├── analytics/page.tsx          # Steam Analytics Dashboard
│   ├── clients/page.tsx            # Client management CRUD
│   ├── platforms/page.tsx          # Platform settings (cooldowns, colors)
│   ├── settings/page.tsx           # API key management
│   ├── export/page.tsx             # Excel export functionality
│   ├── components/
│   │   ├── GanttChart.tsx          # Main timeline component
│   │   ├── SaleBlock.tsx           # Draggable sale blocks
│   │   ├── AddSaleModal.tsx        # Create new sales
│   │   ├── EditSaleModal.tsx       # Edit existing sales
│   │   ├── ProductManager.tsx      # Client/Game/Product CRUD
│   │   └── ...                     # Other components
│   ├── api/                        # API routes (if needed)
│   └── layout.tsx                  # Root layout with sidebar
├── lib/
│   ├── supabase.ts                 # Supabase client
│   ├── types.ts                    # TypeScript type definitions
│   ├── validation.ts               # Cooldown validation logic
│   ├── dateUtils.ts                # Date helper functions
│   └── sale-calendar-generator.ts  # Auto-generate sale calendars
├── docs/
│   ├── PROJECT_PROGRESS.md         # Progress tracker (UPDATE THIS!)
│   └── DEVELOPMENT_WORKFLOW.md     # Development patterns
└── package.json
```

---

## Database Schema (Supabase)

### Core Tables
```sql
-- Clients table
clients (id, name, email, steam_api_key, contact_person, created_at, updated_at)

-- Games table
games (id, client_id, name, steam_app_id, steam_store_url, release_date, created_at, updated_at)

-- Products table (base games, DLCs, editions)
products (id, game_id, name, product_type, steam_product_id, base_price_usd, bundle_eligible, launch_date, launch_sale_duration, created_at, updated_at)

-- Platforms table
platforms (id, name, cooldown_days, max_sale_days, approval_required, color_hex, special_sales_no_cooldown, typical_start_day, submission_lead_days, min_discount_percent, max_discount_percent, notes, is_active, created_at)

-- Sales table
sales (
  id, product_id, platform_id, client_id,
  start_date, end_date, discount_percentage,
  sale_name, sale_type, goal_type, status, submission_status,
  submission_date, confirmation_date, deadline_date,
  previous_sale_end_date, prev_sale_end_date,
  client_submitted, gamedrive_submitted,
  is_campaign, is_submitted, is_confirmed,
  notes, comment, version_id,
  created_at, updated_at
)

-- Platform events table
platform_events (id, platform_id, name, start_date, end_date, event_type, region, requires_cooldown, is_recurring, notes, created_at, updated_at)

-- Calendar versions table
calendar_versions (id, name, description, sales_snapshot, product_count, sale_count, platform_summary, date_range_start, date_range_end, client_id, product_id, is_committed, committed_at, is_active, created_at, updated_at)
```

### Analytics Tables
```sql
-- Steam performance data (CSV imports)
steam_performance_data (id, client_id, date, bundle_name, product_name, product_type, game, platform, country_code, country, region, gross_units_sold, chargebacks_returns, net_units_sold, base_price_usd, sale_price_usd, currency, gross_steam_sales_usd, chargeback_returns_usd, vat_tax_usd, net_steam_sales_usd, imported_at, created_at)

-- Steam sales (API sync data - 360K+ rows)
steam_sales (id, client_id, sale_date, app_id, app_name, product_type, country_code, units_sold, gross_revenue, net_revenue, created_at, updated_at)

-- Import history
performance_import_history (id, client_id, import_type, filename, rows_imported, rows_skipped, date_range_start, date_range_end, status, error_message, created_at)

-- Sync jobs
sync_jobs (id, client_id, job_type, status, created_at, started_at, completed_at, start_date, end_date, force_full_sync, total_dates, dates_processed, rows_imported, rows_skipped, error_message, result_data, is_auto_sync, sync_frequency_hours)
```

### Auth Tables
```sql
-- User profiles
user_profiles (id, email, display_name, role, is_active, all_clients, created_at, updated_at)

-- User permissions
user_permissions (id, user_id, feature, access_level)

-- User-client access
user_clients (id, user_id, client_id, created_at)
```

---

## Vercel MCP Tools Reference

All Vercel tools use the prefix: `mcp__a4288cc3-ead4-4a33-8068-db81680ffa2b__`

### Listing Deployments

Find recent deployments, their status, and IDs for further investigation:
```
mcp__a4288cc3-ead4-4a33-8068-db81680ffa2b__list_deployments(
  projectId="prj_aKbiJdM5fbOPa8YeCc5aCEQWqzcK",
  teamId="team_6piiLSU3y16pH8Kt0uAlDFUu"
)
```
- Look for `state: "ERROR"` to find failed deployments
- `target: "production"` means it was deployed to main
- Grab the `id` field (e.g., `dpl_XXXXX`) for further investigation

### Getting Build Logs (Debugging Failed Deployments)

Read the build output to find compilation errors, missing dependencies, etc:
```
mcp__a4288cc3-ead4-4a33-8068-db81680ffa2b__get_deployment_build_logs(
  idOrUrl="dpl_XXXXXXXXXXXXX",
  teamId="team_6piiLSU3y16pH8Kt0uAlDFUu",
  limit=100
)
```
- Build logs are stored **indefinitely** per deployment
- Truncated if they exceed **4 MB**
- Look for `type: "stderr"` or search for "Error" in the `text` field
- The LAST error often just says `exited with 1` -- look ABOVE it for the root cause

### Getting Runtime/Function Logs

See `console.log`/`console.error` output from serverless functions, middleware, etc:
```
# All production errors
mcp__a4288cc3-ead4-4a33-8068-db81680ffa2b__get_runtime_logs(
  projectId="prj_aKbiJdM5fbOPa8YeCc5aCEQWqzcK",
  teamId="team_6piiLSU3y16pH8Kt0uAlDFUu",
  level=["error"],
  environment="production",
  limit=50
)

# Search for specific error text
mcp__a4288cc3-ead4-4a33-8068-db81680ffa2b__get_runtime_logs(
  projectId="prj_aKbiJdM5fbOPa8YeCc5aCEQWqzcK",
  teamId="team_6piiLSU3y16pH8Kt0uAlDFUu",
  query="TypeError",
  limit=20
)

# Only 500 errors
mcp__a4288cc3-ead4-4a33-8068-db81680ffa2b__get_runtime_logs(
  projectId="prj_aKbiJdM5fbOPa8YeCc5aCEQWqzcK",
  teamId="team_6piiLSU3y16pH8Kt0uAlDFUu",
  statusCode="500",
  limit=20
)

# Logs for a specific deployment
mcp__a4288cc3-ead4-4a33-8068-db81680ffa2b__get_runtime_logs(
  deploymentId="dpl_XXXXXXXXXXXXX",
  teamId="team_6piiLSU3y16pH8Kt0uAlDFUu",
  limit=50
)
```

**Runtime log filter parameters:** `level` (error/warning/info), `environment` (production/preview), `statusCode`, `query` (full-text search), `source`, `requestId`, `since`/`until` (ISO 8601), `limit`.

**Runtime log retention:** Hobby = 1 hour, Pro = 1 day. Logs are capped at 256 lines per request, 256 KB per line.

### Getting Deployment Details

Full metadata about a specific deployment:
```
mcp__a4288cc3-ead4-4a33-8068-db81680ffa2b__get_deployment(
  idOrUrl="dpl_XXXXXXXXXXXXX",
  teamId="team_6piiLSU3y16pH8Kt0uAlDFUu"
)
```
Returns status (`READY`, `ERROR`, `BUILDING`, `QUEUED`, `CANCELED`), git info, build config, etc.

### Getting Project Info

```
mcp__a4288cc3-ead4-4a33-8068-db81680ffa2b__get_project(
  projectId="prj_aKbiJdM5fbOPa8YeCc5aCEQWqzcK",
  teamId="team_6piiLSU3y16pH8Kt0uAlDFUu"
)
```

### Fetching Protected Deployment URLs

When a deployment URL returns 401/403:
```
mcp__a4288cc3-ead4-4a33-8068-db81680ffa2b__web_fetch_vercel_url(
  url="https://platform.game-drive.nl/"
)
```

Or create a temporary shareable link (23-hour expiry):
```
mcp__a4288cc3-ead4-4a33-8068-db81680ffa2b__get_access_to_vercel_url(
  url="https://game-drive-sales-planning-abc123.vercel.app"
)
```

### Searching Vercel Documentation

```
mcp__a4288cc3-ead4-4a33-8068-db81680ffa2b__search_vercel_documentation(
  topic="Next.js serverless function timeout",
  tokens=2000
)
```

### Deploying Current Project

```
mcp__a4288cc3-ead4-4a33-8068-db81680ffa2b__deploy_to_vercel()
```

### Vercel Troubleshooting Workflow

**For Build Failures (deployment never completes):**
1. List deployments -- find the one with `state: "ERROR"`
2. Get build logs for that deployment ID
3. Search for first "Error" in the output -- that's the root cause
4. Fix locally, verify with `npm run build`, then push

**For Runtime Errors (build succeeded but app crashes/errors):**
1. Get runtime logs filtered by `level=["error"]`
2. Search for specific error text with `query="..."`
3. Filter by `statusCode="500"` for server errors
4. Check the `requestId` for tracing specific requests

**Common Build Errors:**

| Error | Fix |
|-------|-----|
| Module not found | Check import paths; ensure dependency is in `package.json` |
| TypeScript errors | Fix locally with `npm run build` first |
| ESLint errors | Fix lint errors locally with `npm run lint` |
| Out of Memory | Set `VERCEL_BUILD_SYSTEM_REPORT=1` env var; reduce bundle size |
| Build timeout (45 min) | Optimize build; use cache effectively |
| Disk space exceeded (23 GB) | Audit `node_modules`; remove unused deps |

**Build Container Resources:** 4 cores, 8 GB memory, 23 GB disk, 45 min max, 1 GB build cache.

**Force deploy without cache:** Set `VERCEL_FORCE_NO_BUILD_CACHE=1` environment variable.

---

## Supabase MCP Tools Reference

All Supabase tools use the prefix: `mcp__supabase__`
**Project ID for all commands:** `znueqcmlqfdhetnierno`

### Executing SQL Queries (Read-Only / DML)

Use for SELECT queries, INSERT, UPDATE, DELETE -- anything that is NOT a schema change:
```
mcp__supabase__execute_sql(
  project_id="znueqcmlqfdhetnierno",
  query="SELECT * FROM sales WHERE product_id = 'some-uuid' LIMIT 10"
)
```

**Useful diagnostic queries:**
```sql
-- Count records per table
SELECT 'clients' as t, count(*) FROM clients UNION ALL
SELECT 'games', count(*) FROM games UNION ALL
SELECT 'products', count(*) FROM products UNION ALL
SELECT 'platforms', count(*) FROM platforms UNION ALL
SELECT 'sales', count(*) FROM sales;

-- Check table columns
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'sales'
ORDER BY ordinal_position;

-- Check constraints
SELECT conname, contype, pg_get_constraintdef(oid)
FROM pg_constraint WHERE conrelid = 'sales'::regclass;

-- Check indexes
SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public';

-- Check RLS policies
SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename;

-- Check which tables have RLS enabled
SELECT relname as table_name, relrowsecurity as rls_enabled
FROM pg_class
WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
ORDER BY relname;

-- Check foreign key relationships
SELECT tc.table_name, kcu.column_name, ccu.table_name AS foreign_table,
       ccu.column_name AS foreign_column
FROM information_schema.table_constraints AS tc
JOIN information_schema.key_column_usage AS kcu
  ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.constraint_column_usage AS ccu
  ON ccu.constraint_name = tc.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public';
```

### Applying Migrations (DDL / Schema Changes)

Use for CREATE TABLE, ALTER TABLE, CREATE INDEX, CREATE POLICY, etc. -- any schema change:
```
mcp__supabase__apply_migration(
  project_id="znueqcmlqfdhetnierno",
  name="descriptive_snake_case_name",
  query="ALTER TABLE sales ADD COLUMN new_field TEXT"
)
```

**Rules:**
- Always use `apply_migration` for DDL, never `execute_sql`
- Use descriptive `snake_case` names
- Do NOT hardcode generated IDs in data migrations
- After every migration, run the security advisor check

**Examples:**
```sql
-- Add a column
name: "add_approved_by_to_sales"
query: "ALTER TABLE sales ADD COLUMN approved_by TEXT"

-- Create a new table
name: "create_sale_templates"
query: "CREATE TABLE sale_templates (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, name TEXT NOT NULL, platform_id UUID REFERENCES platforms(id), discount_percentage NUMERIC, created_at TIMESTAMPTZ DEFAULT NOW())"

-- Add an index
name: "add_sales_date_index"
query: "CREATE INDEX idx_sales_start_date ON sales(start_date)"

-- Enable RLS with policies
name: "enable_rls_new_table"
query: "ALTER TABLE new_table ENABLE ROW LEVEL SECURITY; CREATE POLICY \"Allow all\" ON new_table FOR ALL USING (true) WITH CHECK (true)"
```

### Listing Tables

```
mcp__supabase__list_tables(
  project_id="znueqcmlqfdhetnierno",
  schemas=["public"]
)
```
Returns table names, columns, RLS status, row counts, primary keys, and foreign key constraints.

### Listing Migrations

```
mcp__supabase__list_migrations(project_id="znueqcmlqfdhetnierno")
```
Returns all applied migrations in order. Use to check migration history and verify schema changes.

### Getting Project Logs

Check logs from the last 24 hours by service type:
```
# API/PostgREST logs (most common - data fetch/mutation failures)
mcp__supabase__get_logs(project_id="znueqcmlqfdhetnierno", service="api")

# Database query errors
mcp__supabase__get_logs(project_id="znueqcmlqfdhetnierno", service="postgres")

# Authentication issues
mcp__supabase__get_logs(project_id="znueqcmlqfdhetnierno", service="auth")

# Edge Function logs
mcp__supabase__get_logs(project_id="znueqcmlqfdhetnierno", service="edge_functions")

# Storage (file uploads)
mcp__supabase__get_logs(project_id="znueqcmlqfdhetnierno", service="storage")

# Realtime subscriptions
mcp__supabase__get_logs(project_id="znueqcmlqfdhetnierno", service="realtime")
```

**When to check which service:**

| Symptom | Check Service |
|---------|---------------|
| Data not saving / loading | `api` |
| Slow queries | `postgres` |
| Login/auth failures | `auth` |
| Serverless function errors | `edge_functions` |
| File upload problems | `storage` |
| Real-time sync issues | `realtime` |

### Security & Performance Advisors

Run after every migration or when troubleshooting:
```
# Security advisors (missing RLS, exposed functions, etc.)
mcp__supabase__get_advisors(project_id="znueqcmlqfdhetnierno", type="security")

# Performance advisors (missing indexes, slow queries)
mcp__supabase__get_advisors(project_id="znueqcmlqfdhetnierno", type="performance")
```

### Generating TypeScript Types

Regenerate types after any schema change:
```
mcp__supabase__generate_typescript_types(project_id="znueqcmlqfdhetnierno")
```
Compare output with `lib/types.ts` and update as needed.

### Getting API URL and Keys

```
mcp__supabase__get_project_url(project_id="znueqcmlqfdhetnierno")
mcp__supabase__get_publishable_keys(project_id="znueqcmlqfdhetnierno")
```

### Edge Functions

```
# List all functions
mcp__supabase__list_edge_functions(project_id="znueqcmlqfdhetnierno")

# Read function source
mcp__supabase__get_edge_function(
  project_id="znueqcmlqfdhetnierno",
  function_slug="my-function"
)

# Deploy a function
mcp__supabase__deploy_edge_function(
  project_id="znueqcmlqfdhetnierno",
  name="my-function",
  files=[{"name": "index.ts", "content": "import \"jsr:@supabase/functions-js/edge-runtime.d.ts\";\n\nDeno.serve(async (req: Request) => {\n  return new Response(JSON.stringify({ok: true}), {\n    headers: {'Content-Type': 'application/json', 'Connection': 'keep-alive'}\n  });\n});"}]
)
```

### Database Branching

```
# List branches
mcp__supabase__list_branches(project_id="znueqcmlqfdhetnierno")

# Create a branch (requires cost confirmation flow)
mcp__supabase__get_cost(organization_id="gmnnavqsmgbtfocyuakq", type="branch")
mcp__supabase__confirm_cost(amount=0, recurrence="monthly", type="branch")
mcp__supabase__create_branch(
  project_id="znueqcmlqfdhetnierno",
  name="feature/my-feature",
  confirm_cost_id="<from_confirm_cost>"
)

# Merge branch to production
mcp__supabase__merge_branch(branch_id="<branch_id>")

# Rebase branch on production (get latest migrations)
mcp__supabase__rebase_branch(branch_id="<branch_id>")

# Delete branch
mcp__supabase__delete_branch(branch_id="<branch_id>")
```

### Searching Supabase Documentation

```
mcp__supabase__search_docs(
  graphql_query="query { searchDocs(query: \"row level security\", limit: 5) { nodes { title href content } } }"
)
```

### Supabase Troubleshooting Workflow

**Data not saving/loading:**
1. Check API logs: `get_logs(service="api")` -- look for 4xx/5xx status codes
2. Check Postgres logs: `get_logs(service="postgres")` -- look for SQL errors
3. Verify RLS policies: `execute_sql(query="SELECT * FROM pg_policies WHERE tablename='TABLE'")`
4. Check table structure: `execute_sql(query="SELECT column_name, data_type FROM information_schema.columns WHERE table_name='TABLE'")`

**Permission errors (401/403):**
1. Check RLS is enabled and policies exist
2. Verify API keys with `get_publishable_keys`
3. Check `auth` logs for token issues

**After every migration:**
1. Run `get_advisors(type="security")` to catch missing RLS
2. Run `generate_typescript_types` to keep types in sync
3. Verify the migration appears in `list_migrations`

---

## Key Components Reference

### GanttChart.tsx
Main timeline component. Key features:
- 12-month scrollable timeline
- Product rows with platform sub-rows
- Drag-and-drop sale repositioning
- Click-drag to create new sales
- Real-time cooldown validation
- Platform event display (Steam sales)

### SaleBlock.tsx
Individual sale block component:
- Draggable with @dnd-kit
- Resizable by dragging edges
- Shows discount %, sale name, duration
- Platform-colored background
- Cooldown visualization

### Analytics Dashboard (app/analytics/page.tsx)
Steam performance analytics:
- Summary stat cards (revenue, units, rates)
- Revenue over time bar chart
- Revenue by region chart
- Period comparison table (sale vs regular)
- CSV import modal

---

## Common Development Tasks

### Adding a New Feature
1. Create/modify component in `app/components/`
2. Add CSS in corresponding `.module.css` file
3. Update types in `lib/types.ts` if needed
4. Test on `localhost:3003`
5. Update `docs/PROJECT_PROGRESS.md`

### Database Changes
```
# Apply a migration
mcp__supabase__apply_migration(
  project_id="znueqcmlqfdhetnierno",
  name="descriptive_name",
  query="YOUR SQL HERE"
)

# Then verify:
mcp__supabase__get_advisors(project_id="znueqcmlqfdhetnierno", type="security")
mcp__supabase__generate_typescript_types(project_id="znueqcmlqfdhetnierno")
```

### Pushing to GitHub
```bash
# Standard git workflow
git add .
git commit -m "descriptive message"
git push origin main

# Vercel auto-deploys in 2-3 minutes
```

### Verifying a Deployment
```
# 1. Check deployment status
mcp__a4288cc3-ead4-4a33-8068-db81680ffa2b__list_deployments(
  projectId="prj_aKbiJdM5fbOPa8YeCc5aCEQWqzcK",
  teamId="team_6piiLSU3y16pH8Kt0uAlDFUu"
)

# 2. If it failed, read the build logs
mcp__a4288cc3-ead4-4a33-8068-db81680ffa2b__get_deployment_build_logs(
  idOrUrl="<deployment_id>",
  teamId="team_6piiLSU3y16pH8Kt0uAlDFUu"
)

# 3. If it succeeded but has runtime errors
mcp__a4288cc3-ead4-4a33-8068-db81680ffa2b__get_runtime_logs(
  projectId="prj_aKbiJdM5fbOPa8YeCc5aCEQWqzcK",
  teamId="team_6piiLSU3y16pH8Kt0uAlDFUu",
  level=["error"],
  limit=20
)
```

---

## Workflow: Local Development -> Production

### 1. Start Local Server
```bash
cd /Users/joshuamartin/projects/GameDrive
npm run dev -- -p 3003
# Opens at http://localhost:3003
```

### 2. Make Changes
- Edit files in your IDE
- Hot reload shows changes instantly
- Check browser console for errors

### 3. Test Thoroughly
- Test all affected features
- Verify database operations work
- Check responsive design

### 4. Commit & Push
```bash
git add .
git commit -m "feat: description of changes"
git push origin main
```

### 5. Verify Deployment
- Wait 2-3 minutes for Vercel build
- Check deployment status via MCP tools
- Check https://platform.game-drive.nl/
- If errors, check build logs and runtime logs

### 6. Update Progress Tracker
Add entry to `docs/PROJECT_PROGRESS.md`:
```markdown
## [DATE] - Session Summary
### Completed
- Feature X
- Bug fix Y

### Technical Notes
- Any important discoveries or patterns
```

---

## Open Issues / Feature Requests

### From Client Feedback (Issues #4-7)
- **Issue #4:** Duration input flexibility (e.g., "3 days" or end date picker)
- **Issue #5:** Timeline resize (adjust start/end months)
- **Issue #6:** Auto-generate platform selections from Steam events
- **Issue #7:** Platform color editing in settings

### Known Technical Debt
- Right-click paste on timeline (partially implemented)
- PowerPoint export needs live client testing
- Historical discount tracking (deferred to Phase 2)
- Analytical prediction/forecasting (deferred to Phase 2)

---

## Helper Functions (lib/)

### supabase.ts
```typescript
import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)
```

### types.ts
Key types defined:
- `Client`, `Game`, `Product`
- `Platform`, `Sale`
- `SteamPerformanceData`
- Various modal/filter types

### validation.ts
Cooldown validation logic:
- `checkCooldownConflict()` - Validates sale against platform rules
- `getConflictingSales()` - Returns blocking sales

### dateUtils.ts
Date helpers:
- `formatDate()`, `parseDate()`
- `getMonthsBetween()`, `getDaysBetween()`
- `addDays()`, `subDays()`

---

## CSS Modules Pattern

### DO
```tsx
import styles from './page.module.css'

<div className={styles.container}>
  <span className={styles.title}>Hello</span>
</div>
```

### DON'T
```tsx
// Tailwind classes - these fail silently on Vercel
<div className="flex items-center justify-between">
```

---

## Testing Checklist

Before pushing to production:
- [ ] Sales CRUD (create, read, update, delete)
- [ ] Drag and drop repositioning
- [ ] Cooldown validation warnings
- [ ] Platform filtering
- [ ] Client/product filtering
- [ ] Analytics dashboard loads
- [ ] CSV import works
- [ ] Excel export downloads
- [ ] No console errors

---

## Contact & Resources

- **Production Site:** https://platform.game-drive.nl/
- **GitHub:** https://github.com/GameDriveNL/Game-Drive-Sales-Planning
- **Vercel Dashboard:** https://vercel.com/team_6piiLSU3y16pH8Kt0uAlDFUu
- **Supabase Dashboard:** https://supabase.com/dashboard/project/znueqcmlqfdhetnierno

---

*This document serves as the complete reference for Claude Code to manage the GameDrive project. Keep `docs/PROJECT_PROGRESS.md` updated with all completed work.*
