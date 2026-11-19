-- The repo is public, so the weekly audit report (which lists open security
-- findings) is stored here, in a private table, instead of docs/audits/*.md.
ALTER TABLE public.audit_runs ADD COLUMN IF NOT EXISTS report_md text;
