# GameDrive weekly audit notes

Maintained by the weekly audit routine as the human readable copy of its log. The source of truth is in Supabase (`audit_runs`, `audit_findings`, `audit_fixes`, `audit_metrics`, `audit_tuning`); see docs/audits/PLAYBOOK.md. Read Watching and Open items first, then the newest Run log lines.

## Baseline (set by hand on 2026-11-19 after the first full audit and fixes)

- Noise backlog: 76,605 unclassified coverage items on 2026-11-19 and falling about 600 every 10 minutes (noise-classify cron). Expect near 0 by 2026-11-21.
- RSS feeds never run: 390 of 709 active on 2026-11-19, before the new ordering (most overdue first, 60 per run) had a full hourly run. Expect this to fall quickly.
- Google News and web scrape: 0 items stored before 2026-11-19 (check constraints blocked them). Expect rows now.
- Reddit: last discovered item 2026-05-01. A blocked scan now marks the source failed and logs a scanner error. Needs REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET if blocked.
- TikTok (Apify): no apify_runs row since 2026-11-11. Apify key replaced and tested OK on 2026-11-19. Skips now log to scanner_errors. First real run: 09:00 UTC cron on 2026-11-20.
- Correlation detect: used nonexistent view columns (117 errors a day) until fixed on 2026-11-19. Expect no net_units errors.
- Coverage Feed "All Clients" was a 500 (no index on monthly_unique_visitors). Fixed with idx_coverage_items_umv_sort, now about 1.7 seconds.
- API access: central policy in middleware (lib/access-policy.ts). Unlisted /api routes are superadmin only.
- Users on 2026-11-19: 11 profiles, all with all_clients true, no client restricted accounts.

## Watching

- Items in "Known open items" in gamedrive-weekly-audit.md.

## Open items

(none recorded yet, the first routine run fills this in)

## Run log

- 2026-11-19 baseline (manual, with Josh): jobs red, syncs amber, discovery red, database amber, connections green, code and security amber, smoke green. 22 findings and 11 fixes were seeded into the Supabase log. First routine run should verify those fixes.
