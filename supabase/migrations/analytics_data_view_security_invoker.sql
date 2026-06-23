-- analytics_data_view was created with SECURITY DEFINER (Postgres default for
-- views), which causes it to bypass RLS by running as the view creator.
-- Recreating with SECURITY INVOKER so queries execute under the calling
-- user's permissions and RLS policies on steam_sales / performance_metrics
-- are correctly enforced.
DROP VIEW IF EXISTS public.analytics_data_view;

CREATE VIEW public.analytics_data_view
  WITH (security_invoker = true)
AS
SELECT
  (s.id)::text AS id,
  s.client_id,
  s.sale_date AS date,
  NULL::text AS bundle_name,
  s.app_name AS product_name,
  s.product_type,
  s.app_name AS game,
  'Steam'::text AS platform,
  s.country_code,
  s.country_code AS country,
  get_region_from_country_code(s.country_code) AS region,
  s.units_sold AS gross_units_sold,
  0 AS gross_units_activated,
  0 AS chargebacks_returns,
  s.units_sold AS net_units_sold,
  NULL::numeric AS base_price_usd,
  NULL::numeric AS sale_price_usd,
  s.gross_revenue AS gross_steam_sales_usd,
  0 AS chargeback_returns_usd,
  0 AS vat_tax_usd,
  s.net_revenue AS net_steam_sales_usd
FROM steam_sales s

UNION ALL

SELECT
  (pm.id)::text AS id,
  pm.client_id,
  pm.date,
  NULL::text AS bundle_name,
  pm.product_name,
  NULL::text AS product_type,
  pm.product_name AS game,
  pm.platform,
  pm.country_code,
  pm.country_code AS country,
  COALESCE(pm.region, get_region_from_country_code(pm.country_code)) AS region,
  pm.gross_units_sold,
  pm.gross_units_activated,
  0 AS chargebacks_returns,
  pm.net_units_sold,
  NULL::numeric AS base_price_usd,
  NULL::numeric AS sale_price_usd,
  pm.gross_revenue_usd AS gross_steam_sales_usd,
  0 AS chargeback_returns_usd,
  0 AS vat_tax_usd,
  pm.net_revenue_usd AS net_steam_sales_usd
FROM performance_metrics pm;
