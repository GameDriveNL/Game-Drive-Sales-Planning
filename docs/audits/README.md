# Weekly audit

An unattended routine audits the system each week and applies only safe fixes.

- `PLAYBOOK.md`: what the routine does, its hard rules, fix tiers and report format. Edit this to change the audit.
- Supabase tables `audit_runs`, `audit_findings`, `audit_fixes`, `audit_metrics`, `audit_tuning` (private): the routine's memory across sessions and its reports. Migrations: `supabase/migrations/20261119200000_weekly_audit_log_tables.sql` and `20261119201000_audit_runs_report_markdown.sql`.

This repository is public, so reports and findings are deliberately kept out of it.

Quick views (Supabase SQL editor):

```sql
select run_date, verdicts, summary from audit_runs order by run_date desc limit 5;
select report_md from audit_runs order by run_date desc limit 1;
select key, severity, status, times_seen, title from audit_findings where status <> 'fixed' order by severity, times_seen desc;
select r.run_date, f.tier, f.kind, f.description, f.verified, f.outcome from audit_fixes f join audit_runs r on r.id = f.run_id order by f.created_at desc limit 20;
select name, value, created_at from audit_metrics where name = 'noise_unclassified' order by created_at desc limit 8;
```
