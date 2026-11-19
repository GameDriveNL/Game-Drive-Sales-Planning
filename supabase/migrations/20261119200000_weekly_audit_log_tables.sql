-- Persistent memory for the weekly audit routine (docs/audits/PLAYBOOK.md).
-- Lets each run see what earlier runs found, which fixes it made, whether those
-- fixes held, and which thresholds it has tuned. RLS is on with no policies, so
-- only the service role and the Supabase MCP (postgres) can read or write.

CREATE TABLE IF NOT EXISTS public.audit_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_date        date NOT NULL,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  status          text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed','partial')),
  verdicts        jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary         text,
  report_path     text,
  commit_sha      text,
  could_not_verify text[] NOT NULL DEFAULT '{}',
  tuning_notes    text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_runs_run_date ON public.audit_runs (run_date DESC);

CREATE TABLE IF NOT EXISTS public.audit_findings (
  key             text PRIMARY KEY,
  area            text NOT NULL,
  severity        text NOT NULL CHECK (severity IN ('critical','high','medium','low','info')),
  title           text NOT NULL,
  evidence        text,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','watching','fixed','wontfix','needs_josh')),
  first_seen_run  uuid REFERENCES public.audit_runs(id),
  last_seen_run   uuid REFERENCES public.audit_runs(id),
  times_seen      integer NOT NULL DEFAULT 1,
  resolved_run    uuid REFERENCES public.audit_runs(id),
  notes           text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_findings_status ON public.audit_findings (status);

CREATE TABLE IF NOT EXISTS public.audit_fixes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          uuid NOT NULL REFERENCES public.audit_runs(id),
  finding_key     text REFERENCES public.audit_findings(key),
  tier            smallint NOT NULL CHECK (tier IN (1,2,3)),
  kind            text NOT NULL CHECK (kind IN ('db_maintenance','data_cleanup','code','branch_pr','doc','tuning','other')),
  description     text NOT NULL,
  commit_sha      text,
  branch          text,
  pr_url          text,
  sql_executed    text,
  rows_affected   integer,
  verified        boolean NOT NULL DEFAULT false,
  verification    text,
  reverted        boolean NOT NULL DEFAULT false,
  revert_reason   text,
  outcome         text NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending','held','regressed','unknown','superseded')),
  outcome_checked_run uuid REFERENCES public.audit_runs(id),
  outcome_note    text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_fixes_outcome ON public.audit_fixes (outcome);
CREATE INDEX IF NOT EXISTS idx_audit_fixes_run ON public.audit_fixes (run_id);

CREATE TABLE IF NOT EXISTS public.audit_metrics (
  id          bigserial PRIMARY KEY,
  run_id      uuid NOT NULL REFERENCES public.audit_runs(id),
  name        text NOT NULL,
  value       numeric,
  unit        text,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_metrics_name ON public.audit_metrics (name, created_at DESC);

CREATE TABLE IF NOT EXISTS public.audit_tuning (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  bounds      jsonb,
  reason      text,
  updated_run uuid REFERENCES public.audit_runs(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.audit_runs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_fixes    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_metrics  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_tuning   ENABLE ROW LEVEL SECURITY;

INSERT INTO public.audit_tuning (key, value, bounds, reason) VALUES
  ('cron_stale_multiplier',      '2'::jsonb,   '{"min":1.5,"max":4}',   'flag a cron with no run within N times its interval'),
  ('silent_source_days',         '14'::jsonb,  '{"min":7,"max":30}',    'days of zero output before a scanner counts as silent'),
  ('steam_data_stale_days',      '2'::jsonb,   '{"min":1,"max":4}',     'latest sale_date older than this is stale'),
  ('connection_test_stale_days', '45'::jsonb,  '{"min":14,"max":90}',   'service_api_keys last_tested_at older than this is stale'),
  ('dead_tuple_vacuum_pct',      '20'::jsonb,  '{"min":10,"max":40}',   'run VACUUM ANALYZE above this dead tuple percentage'),
  ('scanner_errors_retention_days','90'::jsonb,'{"min":30,"max":180}',  'prune scanner_errors older than this'),
  ('tier1_max_changed_lines',    '120'::jsonb, '{"min":20,"max":120}',  'cap for an autonomous code fix (can be lowered, never raised past 120)'),
  ('muted_findings',             '[]'::jsonb,  NULL,                    'finding keys to report only on change, not every week'),
  ('playbook_suggestions',       '[]'::jsonb,  NULL,                    'changes to the playbook the routine recommends; Josh approves')
ON CONFLICT (key) DO NOTHING;
