-- Allow partner bundles (where the bundle's primary app belongs to another
-- studio and therefore has no matching game in our catalog) to be stored, and
-- make the bundle upsert idempotent for those rows.
--
-- Context: storeBundleData() in app/api/steam-sync/route.ts assigns game_id =
-- NULL when a bundle line-item's primary_appid doesn't map to one of the
-- client's games. The original NOT NULL constraint silently rejected those
-- rows, and the standard UNIQUE constraint treated NULL game_id as distinct,
-- which would have produced duplicate partner-bundle rows on every re-sync.

ALTER TABLE steam_bundles ALTER COLUMN game_id DROP NOT NULL;

ALTER TABLE steam_bundles DROP CONSTRAINT IF EXISTS steam_bundles_game_id_bundle_name_date_key;
DROP INDEX IF EXISTS steam_bundles_game_bundle_date_uniq;

-- NULLS NOT DISTINCT so partner-bundle rows (NULL game_id) dedupe on re-sync.
CREATE UNIQUE INDEX steam_bundles_game_bundle_date_uniq
  ON steam_bundles (game_id, bundle_name, date) NULLS NOT DISTINCT;
