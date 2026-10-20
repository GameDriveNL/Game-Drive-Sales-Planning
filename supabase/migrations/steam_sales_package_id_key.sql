-- steam_sales: one row per Steam package, not one per game.
--
-- The unique key was (client_id, sale_date, app_id, product_type, country_code) and the sync
-- stores app_id = primary_appid for every package, so all packages of a game (base game,
-- DLCs, editions, soundtrack) collapsed into ONE row per day and country, named after
-- whichever package Steam listed first (seen live 2026-10-20: US 2026-10-16 Gallipoli was a
-- single row "Ordered to Die Pack: 126 units" although Steam sent ~30 package rows). That is
-- also why a free DLC could never show up under its own name.
--
-- steam_package_id is part of the key now. 0 means a legacy collapsed row (or a non-package
-- row); the sync deletes a day's legacy package rows when it rewrites that day with the real
-- per-package rows. Adding a column with a constant default is metadata-only (instant).

ALTER TABLE public.steam_sales ADD COLUMN IF NOT EXISTS steam_package_id bigint NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX steam_sales_client_date_app_type_country_pkg_key
  ON public.steam_sales (client_id, sale_date, app_id, product_type, country_code, steam_package_id);

ALTER TABLE public.steam_sales
  DROP CONSTRAINT steam_sales_client_id_sale_date_app_id_product_type_country_key;
