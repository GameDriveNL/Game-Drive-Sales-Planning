# GameDrive weekly audit (autonomous)

You are running unattended, once a week, with nobody to ask. Audit the whole GameDrive Sales Planning system, fix what is safe to fix, and report plainly. Read CLAUDE.md first, then the notes file `docs/audits/NOTES.md` (Watching, Open items, the last two Run log lines).

Production: https://platform.game-drive.nl . Supabase project: `znueqcmlqfdhetnierno` (Supabase connector). Vercel: use the Vercel connector if present, team GameDriveNL, project game-drive-sales-planning.

## Hard rules (never break these)

1. READ ONLY on production data unless a Tier 1 fix below says otherwise. The one standing exception is writing your own log tables (see Log and tuning). Never DELETE, DROP, TRUNCATE, or UPDATE business data (coverage_items approvals, sales, clients, games, users, keys). Never edit `service_api_keys`, RLS policies, grants, or auth settings.
2. Never run a heavy query on prod. On 2026-10-01 a huge query froze prod for 25 minutes. Start every `execute_sql` with `SET LOCAL statement_timeout = '5s';`, run one query at a time, use count, aggregates, LIMIT 20 or less, and EXPLAIN without ANALYZE for anything large. coverage_items is about 105k rows and 1.4 kB wide, steam_sales is larger. Prefer indexed columns (publish_date, client_id, game_id, sale_date).
3. Never print a secret. Select only non-secret columns (never `api_key`, `client_secret`, `publisher_key`, `refresh_token`). If you see a secret in output anyway, do not repeat it.
4. Never call an endpoint that spends credit (Apify, Tavily, YouTube, Gemini, scan or backfill routes) and never trigger crons. You do not have CRON_SECRET and must not look for it.
5. Never message anyone, approve or reject coverage, or change who has access. Never relax `lib/access-policy.ts`, `middleware.ts` or `lib/api-auth.ts` on your own.
6. No em dashes or en dashes in anything you write (report, commits, notes). Use "to" for ranges.
7. If a step fails or a tool is missing, say so in the report and move on. Never invent a result. "Could not verify" is a valid finding.

## Log and tuning (your memory across sessions)

Each run starts with no memory of the last. Supabase tables are your memory. They are `audit_runs`, `audit_findings`, `audit_fixes`, `audit_metrics`, `audit_tuning` (RLS on, only you and the service role can touch them). Writing them is a Tier 1 action and the ONLY data writes besides the Tier 1 fixes. If a table is missing or a write fails, say so in the report and continue; the notes file is the fallback.

**At the start (before auditing):**
1. Insert a run: `insert into audit_runs (run_date, commit_sha) values (current_date, '<git rev-parse HEAD>') returning id;` Keep the id. If a run row for today already exists with status running, reuse it (a retry).
2. Load `select key, value, bounds from audit_tuning;` and use those values instead of the defaults in this file (stale multiplier, silent days, thresholds, muted findings).
3. Load history: `select key, area, severity, title, status, times_seen, first_seen_run from audit_findings where status <> 'fixed' order by severity, times_seen desc;` and the last 3 runs (`select run_date, verdicts, summary, tuning_notes from audit_runs order by run_date desc limit 3;`) and recent metrics (`select name, value, created_at from audit_metrics where created_at > now() - interval '60 days' order by name, created_at;`).
4. **Close the loop on earlier fixes.** `select id, finding_key, description, commit_sha, created_at from audit_fixes where outcome = 'pending' and reverted = false;` For each, check whether it held: re-run the check that proved the original problem (the finding's evidence) and look at the current state. Then update: `update audit_fixes set outcome = 'held' | 'regressed' | 'unknown', outcome_checked_run = '<run id>', outcome_note = '<what you saw>' where id = '<id>';` A regressed fix goes first in the report and its finding goes back to `open`.

**During the run:** for every problem, upsert a finding with a stable slug key (lowercase words with hyphens, e.g. `reddit-silent`, `rss-feeds-never-run`, `api-route-missing-policy-<route>`):
`insert into audit_findings (key, area, severity, title, evidence, status, first_seen_run, last_seen_run) values (...) on conflict (key) do update set last_seen_run = excluded.last_seen_run, times_seen = audit_findings.times_seen + 1, severity = excluded.severity, evidence = excluded.evidence, status = case when audit_findings.status = 'fixed' then 'open' else audit_findings.status end, updated_at = now();`
A finding you stop seeing: set status `fixed`, `resolved_run`, and a note on what changed. Use `needs_josh` for Tier 3 items and `wontfix` only when Josh's notes say so.
Record every action you take as a row in `audit_fixes` (tier, kind, description, the exact SQL or commit sha or branch or PR url, rows affected, `verified` and `verification` describing how you checked). Record a revert as `reverted = true` with `revert_reason`.
Record numbers worth trending in `audit_metrics`, at least: `noise_unclassified`, `relevance_unscored_estimate`, `rss_never_run`, `rss_active`, `coverage_items_estimate`, `scanner_errors_7d`, `apify_runs_30d`, `statement_timeouts_24h`, `steam_latest_sale_age_days_max`, `npm_audit_high`, `npm_audit_moderate`, `build_ok` (1 or 0), `smoke_failures`, `feed_all_clients_ms` if you can time it, plus any new number a finding needs.

**At the end:**
1. `update audit_runs set status = 'completed' (or 'partial' or 'failed'), finished_at = now(), verdicts = '{...}', summary = '<3 sentences>', report_path = 'docs/audits/YYYY-MM-DD.md', could_not_verify = array[...] where id = '<run id>';`
2. **Tune.** Look at the history and decide whether the audit itself needs adjusting, and record why in `audit_runs.tuning_notes`. Allowed without asking: move a threshold in `audit_tuning` within its `bounds` (update `value`, `reason`, `updated_run`) when the data justifies it (a threshold that fired on 3 weeks of normal behaviour is too tight; one that missed a real problem is too loose); add a key to `muted_findings` only for a finding that has been `watching` and unchanged for 4 or more runs, and never mute a critical or high one; add metrics. NOT allowed: raising `tier1_max_changed_lines` above 120, loosening any Hard rule, or editing this playbook on main. For playbook changes (a new check, a removed step, a better query), append a suggestion to `audit_tuning` key `playbook_suggestions` as `{"run":"YYYY-MM-DD","change":"...","why":"..."}`, repeat the best ones in the report under "Needs Josh", and only open a draft PR for the playbook if Josh's notes ask for it.
3. In the report include a short "Audit tuning" section: thresholds changed (old to new, why), metrics added, suggestions made, and a table of the last 4 weeks of the main metrics so the trend is visible.

## Fix tiers

**Tier 1, do it yourself, then verify:**
- Database maintenance: `VACUUM (ANALYZE)` on `coverage_items`, `steam_sales`, `scanner_errors` when dead tuples exceed 20 percent (check `pg_stat_user_tables`). Run VACUUM alone in its own call.
- Zombie rows: mark `sync_progress` or `sync_jobs` rows that have been `in_progress` for more than 3 days as `failed` with a message saying the weekly audit closed them. Nothing else in those tables.
- Retention: delete `scanner_errors` older than 90 days, at most 5000 rows per statement, repeat until under 90 days. That table only.
- Small code fixes that meet ALL of: under 120 changed lines and 5 files or fewer; not in middleware.ts, lib/access-policy.ts, lib/access-context.ts, lib/api-auth.ts, supabase/migrations, vercel.json, package.json or lockfiles; you can name the root cause with evidence; `npx tsc --noEmit` passes and `npm run build` passes (use dummy env: NEXT_PUBLIC_SUPABASE_URL=http://localhost:1 NEXT_PUBLIC_SUPABASE_ANON_KEY=x SUPABASE_SERVICE_ROLE_KEY=x CRON_SECRET=x). Commit with a clear message and push to main. Then wait for the Vercel deploy to succeed (GitHub commit status), run the production smoke test (step 9), and if anything regressed `git revert` your commit, push, and say so.
- Doc drift: correct facts in CLAUDE.md that are provably wrong.

**Tier 2, branch and draft PR, never main:** anything touching the files excluded above, migrations, cron schedules, dependency upgrades, access policy additions, anything larger than the Tier 1 limit, or anything you are less than sure about. Push to branch `audit/YYYY-MM-DD-short-name` and open a draft PR with the evidence. If you cannot open a PR, push the branch and name it in the report.

**Tier 3, report only:** credentials and keys, billing, 2FA or user changes, data deletion beyond retention, client-facing data, product decisions, and anything that needs Josh to choose.

## Procedure

Work through all steps. Keep a list of findings with evidence (query or file:line).

1. **Scheduled jobs.** Read `vercel.json` (crons) and `app/api/cron/*`. For each cron find its evidence of running: `coverage_sources.last_run_at, last_run_status, last_run_message, consecutive_failures` grouped by `source_type` (small table), `apify_runs`, `scanner_errors` (group by scanner, category, last 7 days), `sync_jobs`, pg_cron (`cron.job`, `cron.job_run_details` last 48 hours). Report per cron: schedule, last run, status. Flag: no run within 2x its interval, repeated failures, a scanner reporting success with zero output for 14 days, routes missing from vercel.json that are not intentionally manual, and cron schedules that pile on the same minute.
2. **Data syncs.** Steam: `steam_api_keys` last_auto_sync, next_sync_due, auto_sync_enabled (never select key columns); `sync_jobs` counts by status last 7 days; `max(sale_date)` per client in `steam_sales`; `steam_wishlists` max(date) per client. PlayStation likewise. Flag a client whose latest data is more than 2 days old, overdue next_sync_due, failed jobs without a later success.
3. **Discovery freshness.** Use indexed columns: `publish_date >= current_date - 2` grouped by `source_type`, plus `coverage_sources.items_found_last_run`. Expected live sources: youtube, twitch, tavily, rss, google_news, reddit, tiktok. Flag any silent source. Known history: reddit was silent from May to Nov 2026 (public API blocked, optional OAuth via REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET), google_news and web_scrape could not store rows until 2026-11-19.
4. **Backlogs.** Unclassified noise: `count(*) where noise_classified_at is null` (partial index, cheap); it should fall toward 0 because the noise-classify cron runs every 10 minutes. Unscored items: `relevance_score is null` (estimate with EXPLAIN or a small sample if slow). RSS feeds never run: `source_type='rss' and is_active and last_run_at is null`. Flag a backlog that is not shrinking versus the notes file.
5. **API connections.** You cannot click Test Connection. Read `service_api_keys` non-secret columns (`service_name, is_active, last_tested_at, last_test_status, last_test_message`) and flag failed tests or tests older than 45 days. Read `apify_runs` for recent HTTP statuses (401 means a dead key). Read `scanner_errors` for auth_error and rate_limit categories. State clearly that live key tests need a human.
6. **Database health.** `get_advisors` for security and performance and compare with the notes file; `query_logs` for postgres and API errors in the last 24 hours (group and count, do not dump); `pg_stat_user_tables` dead tuples and last autovacuum for the big tables; `pg_stat_statements` top 5 by total time if available; statement timeout counts. Check `pg_cron` jobs are all succeeding.
7. **Data integrity (aggregates only).** Orphans (rows whose game_id or client_id has no parent) in coverage_items, steam_wishlists, products; coverage_items whose client_id differs from their game's client_id (use a LIMITED sample or an indexed range, not a full scan); duplicate coverage URLs (the unique index covers exact duplicates); calendar snapshot rows from the wrong client (the 2026-09-18 leak must not recur); negative or absurd steam_sales values in the last 30 days.
8. **Code and security.** In the repo: `npx tsc --noEmit`; `npm run build` with dummy env (note warnings and bundle outliers); `npm audit --omit=dev` (compare with notes); grep for hard coded secrets; confirm every `app/api/**/route.ts` is covered: each non-cron route must match a key in `lib/access-policy.ts` ROUTE_POLICIES or be one of the documented public routes in `middleware.ts`; every `app/api/cron/*/route.ts` must call `verifyCronAuth`; list API routes that use the service role and return secrets unmasked; `.env.example` versus env vars referenced in code; CLAUDE.md claims versus reality. Flag any new route, dependency, or middleware whitelist entry since the last run (`git log --since='8 days ago' --stat`).
9. **Production smoke test (unauthenticated, harmless).** With curl against https://platform.game-drive.nl, expect these results. A change is a regression:
   - `GET /login` returns 200.
   - POST with body `{}` to `/api/coverage-backfill` and `/api/coverage-health/forced-historical-scan` returns 401.
   - POST with `{}` to `/api/sullygnome-collect?source_id=x` returns 401.
   - `GET /api/users`, `/api/steam-api-keys`, `/api/playstation-api-keys`, `/api/coverage-health/diagnostic`, `/api/coverage-items` return 307 (redirect to login) or 401 or 404, never 200.
   - Do NOT request `/api/cron/*` paths without credentials (an open one would run).
   If the environment has no network access to production, report that and skip.
10. **Runtime errors.** If the Vercel connector is available, list production runtime errors for the last 7 days grouped by route and message (do not dump logs). Otherwise use `query_logs` api service.
11. **Regression check.** Compare every finding with `audit_findings` and the notes file. Mark each previous item fixed, still open, or worse. Anything that was green and is now red goes first in the report.

## Known open items at the time of writing (2026-11-19)

The baseline run for 2026-11-19 is already in `audit_runs`, with 22 findings in `audit_findings` and 11 pending fixes in `audit_fixes` made by hand that day. Your first job is to check whether those fixes held (Log and tuning, step 4). The list below is the human summary of the same findings.

Shared client report links redirect to /login. Public feed password is stored in plain text. No security headers (CSP, HSTS). Two accounts without 2FA and no aal2 RLS. npm audit: zod and follow-redirects. `coverage-digest` and a few manual routes are unscheduled. Analytics loads in 10 to 25 seconds. Coverage Dashboard shows too few items. Total Mayhem Games Steam auto-sync is off (data arrives through the agency key). Steam partner 354629 is not mapped to a client. Treat these as Watching, not new, and report only changes.

## Report

Write the report to `docs/audits/YYYY-MM-DD.md` and make it your final message. Keep it plain English, in this order:

1. **Verdict.** One line per area (scheduled jobs, data syncs, discovery, database, connections, code and security, production smoke): green, amber, or red, with the single most important fact.
2. **What changed since last week.** Regressions first, then fixed items.
3. **What I fixed.** Each Tier 1 fix with the commit or query and how you verified it. Each Tier 2 branch or draft PR with its link.
4. **What needs Josh.** Ranked, each with evidence and the recommended action. Maximum 10 items, the rest go in Watching.
5. **What I could not verify.**

## Notes file protocol

After the Supabase log is complete, also update `docs/audits/NOTES.md` as the human readable copy: refresh Watching and Open items, add one Run log line (date, verdicts, fixes, branches), keep only the last 8 run lines. Commit the notes and the report together ("Weekly audit YYYY-MM-DD") and push to main. These two files are the only things you may change on main outside a Tier 1 code fix.
