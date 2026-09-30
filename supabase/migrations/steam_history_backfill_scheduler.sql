-- Steam sync: one-time deep history backfill per client, then a short rolling
-- window for the daily sync.
--
-- Before: the daily auto-sync re-read everything from each key's sync_start_date
-- (tobspr: 2024-01-01, ~100 min per night), and keys without a start date only
-- looked back 30 days, so clients that share their apps with Game Drive's
-- Steamworks account never got their history.
--
-- Now:
--   * schedule_auto_sync_jobs(): the daily job is always a rolling 30 day window.
--   * schedule_steam_history_backfills(): hourly, queues ONE deep job (one at a
--     time, to go easy on Steam) for each client that has a Steam partner id and
--     a way to read its data (own key, or Game Drive's agency key) and has not
--     been backfilled yet. The job starts at that client's key sync_start_date,
--     or 2013-01-01 (the earliest date Steam reports) when none is set.
--   * process-sync-jobs stamps clients.steam_history_backfilled_at when the deep
--     job completes. Through the agency with zero rows it fails instead, and the
--     scheduler waits 7 days before trying that client again.

ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS steam_history_backfilled_at timestamptz;
ALTER TABLE public.sync_jobs ADD COLUMN IF NOT EXISTS is_history_backfill boolean NOT NULL DEFAULT false;

-- BlackMill: 2022 onward was loaded by hand. Earlier Steam rows for this partner
-- are key activations only (no units sold, no revenue), so nothing is missing.
UPDATE public.clients
SET steam_history_backfilled_at = now()
WHERE steam_partner_id = '187651' AND steam_history_backfilled_at IS NULL;

-- The agency account never gets a deep job of its own (its feed holds every shared
-- client). Clear the 2024 start date set earlier: its daily sync is the rolling window.
UPDATE public.steam_api_keys
SET sync_start_date = NULL
WHERE client_id IN (SELECT id FROM public.clients WHERE steam_partner_id = '352871');

CREATE OR REPLACE FUNCTION public.schedule_auto_sync_jobs()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  api_key_record RECORD;
  existing_job_count INTEGER;
BEGIN
  FOR api_key_record IN
    SELECT
      id, client_id, sync_frequency_hours,
      last_auto_sync, next_sync_due
    FROM public.steam_api_keys
    WHERE auto_sync_enabled = TRUE
      AND is_active = TRUE
      AND (next_sync_due IS NULL OR next_sync_due <= NOW())
  LOOP
    SELECT COUNT(*) INTO existing_job_count
    FROM public.sync_jobs
    WHERE client_id = api_key_record.client_id
      AND status IN ('pending', 'running')
      AND is_auto_sync = TRUE;

    IF existing_job_count = 0 THEN
      INSERT INTO public.sync_jobs (
        client_id, job_type, status, start_date, end_date,
        is_auto_sync, sync_frequency_hours, force_full_sync
      ) VALUES (
        api_key_record.client_id, 'steam_sync', 'pending',
        (CURRENT_DATE - 30)::text,
        NULL, TRUE, api_key_record.sync_frequency_hours,
        (api_key_record.last_auto_sync IS NULL)
      );

      UPDATE public.steam_api_keys
      SET next_sync_due = public.calculate_next_sync_time(
        sync_frequency_hours, NOW()
      )
      WHERE id = api_key_record.id;

      RAISE NOTICE 'Scheduled auto-sync job for client %', api_key_record.client_id;
    END IF;
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.schedule_steam_history_backfills()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  agency_partner CONSTANT text := '352871';
  agency_has_key boolean;
  target_id uuid;
  target_start text;
BEGIN
  -- One deep backfill at a time.
  IF EXISTS (
    SELECT 1 FROM public.sync_jobs
    WHERE is_history_backfill AND status IN ('pending', 'running')
  ) THEN
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.steam_api_keys k
    JOIN public.clients c ON c.id = k.client_id
    WHERE c.steam_partner_id = agency_partner
      AND k.is_active
      AND COALESCE(k.publisher_key, k.api_key) IS NOT NULL
  ) INTO agency_has_key;

  SELECT c.id, COALESCE(own.sync_start_date::text, '2013-01-01')
    INTO target_id, target_start
  FROM public.clients c
  LEFT JOIN LATERAL (
    SELECT k.sync_start_date
    FROM public.steam_api_keys k
    WHERE k.client_id = c.id AND k.is_active
    LIMIT 1
  ) own ON TRUE
  WHERE c.steam_partner_id IS NOT NULL
    AND c.steam_partner_id <> agency_partner
    AND c.steam_history_backfilled_at IS NULL
    AND (
      agency_has_key
      OR EXISTS (SELECT 1 FROM public.steam_api_keys k WHERE k.client_id = c.id AND k.is_active)
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.sync_jobs j
      WHERE j.client_id = c.id
        AND j.is_history_backfill
        AND j.status = 'failed'
        AND j.completed_at > now() - interval '7 days'
    )
  ORDER BY c.created_at
  LIMIT 1;

  IF target_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.sync_jobs (
    client_id, job_type, status, start_date, end_date,
    is_auto_sync, is_history_backfill, force_full_sync
  ) VALUES (
    target_id, 'steam_sync', 'pending', target_start, NULL,
    FALSE, TRUE, TRUE
  );

  RAISE NOTICE 'Scheduled Steam history backfill for client % from %', target_id, target_start;
END;
$function$;

SELECT cron.schedule(
  'gamedrive-steam-history-backfill',
  '30 * * * *',
  $$SELECT public.schedule_steam_history_backfills();$$
);
