-- Add 'wayback' to the allowed coverage_items.source_type values.
--
-- Currently two redundant check constraints exist with slightly different
-- allowlists. Consolidate into one constraint that includes all values
-- we actually use, plus 'wayback' for the Internet Archive recovery path.

DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN (
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.coverage_items'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%source_type%'
  )
  LOOP
    EXECUTE 'ALTER TABLE coverage_items DROP CONSTRAINT IF EXISTS ' || quote_ident(c.conname);
  END LOOP;
END $$;

ALTER TABLE coverage_items
  ADD CONSTRAINT coverage_items_source_type_check
  CHECK (source_type IS NULL OR source_type IN (
    'rss', 'tavily', 'youtube', 'twitch', 'reddit', 'twitter',
    'tiktok', 'instagram', 'sullygnome', 'semrush', 'manual', 'wayback'
  ));
