-- These SECURITY DEFINER functions never check who is calling, yet anon (and
-- signed in users) could execute them through /rest/v1/rpc. Nothing in the app
-- calls them over the API; pg_cron and the service role run as postgres /
-- service_role, which keep EXECUTE. RLS helper functions (is_superadmin,
-- has_client_access, has_game_client_access) are left alone: policies need them.
REVOKE EXECUTE ON FUNCTION public.disable_auto_sync(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.enable_auto_sync(uuid, date, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_auto_sync_status(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.process_continuous_sync(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.trigger_manual_sync(uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
