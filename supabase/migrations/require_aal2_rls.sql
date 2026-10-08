-- Two-factor enforcement at the database.
--
-- The app talks to Supabase straight from the browser, so the Next.js
-- middleware alone cannot stop someone who has only a password from calling
-- the API with their password-only (aal1) session. This adds a RESTRICTIVE
-- policy to every public table: signed-in requests are only allowed through
-- when the session has completed two-factor (aal2). Restrictive policies are
-- ANDed with the existing permissive ones, so current access rules still apply.
--
-- Not affected: service_role (cron jobs, API routes) and the anon role.
-- Emergency rollback: run the DO block below with `drop policy` instead.
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('drop policy if exists "require_aal2" on public.%I', t.tablename);
    execute format(
      'create policy "require_aal2" on public.%I as restrictive for all to authenticated '
      || 'using ((select auth.jwt() ->> ''aal'') = ''aal2'') '
      || 'with check ((select auth.jwt() ->> ''aal'') = ''aal2'')',
      t.tablename
    );
  end loop;
end $$;
