-- Covering index for the analytics summary functions.
--
-- Total Mayhem Games "All Time" (get_analytics_performance_rows_v2) took ~42s (limit 40s) and the
-- product breakdown (get_sales_data_table) ~15s. Both walked idx_steam_sales_client_id and then
-- fetched ~450k scattered heap rows, because steam_sales rows of different clients are interleaved
-- on disk (the history was rewritten by parallel per-client sync jobs on 2026-10-20/21).
--
-- With every column those functions read INCLUDEd, Postgres answers them from the index alone
-- (Index Only Scan), no heap access: v2 summary 42.5s -> 5.0s, data table 15.3s -> 5.6s.
-- This is the same ~7s the 2026-10-01 migration notes report for the summary function.
--
-- Built on production with CREATE INDEX CONCURRENTLY (does not block writes) followed by VACUUM
-- (ANALYZE) so the visibility map lets index-only scans skip the heap. Index-only scans stay fast
-- only while the table is vacuumed; autovacuum handles that. If a function starts reading another
-- steam_sales column, add it to INCLUDE or that column forces heap fetches again.
--
-- (Run CONCURRENTLY and outside a transaction when applying by hand; the plain form below is for
-- fresh environments.)
CREATE INDEX IF NOT EXISTS idx_steam_sales_analytics_cover
  ON public.steam_sales (client_id, sale_date)
  INCLUDE (app_name, product_type, country_code, units_sold, gross_revenue, net_revenue, units_activated);
