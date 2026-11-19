# Weekly audit

An unattended routine audits the whole system each week and applies only safe fixes.

- `PLAYBOOK.md`: what the routine does, its hard rules, fix tiers and report format. Edit this to change the audit.
- `NOTES.md`: human readable copy of what it is watching and its run log.
- `YYYY-MM-DD.md`: one report per run.
- Supabase tables `audit_runs`, `audit_findings`, `audit_fixes`, `audit_metrics`, `audit_tuning`: the routine's memory across sessions (what it found, what it fixed and whether the fix held, trend numbers, tunable thresholds). Migration: `supabase/migrations/20261119200000_weekly_audit_log_tables.sql`.

Quick views (run in the Supabase SQL editor):

```sql
select run_date, verdicts, summary from audit_runs order by run_date desc limit 5;
select key, severity, status, times_seen, title from audit_findings where status <> 'fixed' order by severity, times_seen desc;
select r.run_date, f.tier, f.kind, f.description, f.verified, f.outcome from audit_fixes f join audit_runs r on r.id = f.run_id order by f.created_at desc limit 20;
select name, value, created_at from audit_metrics where name = 'noise_unclassified' order by created_at desc limit 8;
select key, value, reason from audit_tuning order by key;
```
