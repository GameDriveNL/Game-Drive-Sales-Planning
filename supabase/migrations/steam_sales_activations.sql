-- Free DLC (and demos, retail keys) never reached steam_sales.
--
-- Steam reports a free product only as `gross_units_activated` on GetDetailedSales rows:
-- net_units_sold, gross_units_sold and gross_sales_usd are all 0. The cron sync skipped any
-- row with no units and no revenue and steam_sales had nowhere to keep activations, so the
-- free "Gallipoli - Long March Pack" DLC (launched 2026-10-15, ~9,600 claims in its first 5
-- days) was invisible in analytics. Verified against the live Steam feed on 2026-10-20.
--
-- 1. steam_sales.units_activated keeps the activations (the sync now writes them).
-- 2. Both analytics views expose it as gross_units_activated (unified_performance_view gets the
--    column appended; analytics_data_view already had it, hard coded to 0 for Steam rows).
-- 3. get_sales_data_table returns an `activations` total per row so the product breakdown
--    can show free products.
--
-- ADD COLUMN with a constant default is a metadata-only change, so it is instant on a big table.

ALTER TABLE public.steam_sales ADD COLUMN IF NOT EXISTS units_activated integer NOT NULL DEFAULT 0;

CREATE OR REPLACE VIEW public.analytics_data_view
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
  s.units_activated AS gross_units_activated,
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

CREATE OR REPLACE VIEW public.unified_performance_view
  WITH (security_invoker = true)
AS
SELECT s.id::text AS id,
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
    0 AS chargebacks_returns,
    s.units_sold AS net_units_sold,
    NULL::numeric AS base_price_usd,
    NULL::numeric AS sale_price_usd,
    s.gross_revenue AS gross_steam_sales_usd,
    0 AS chargeback_returns_usd,
    0 AS vat_tax_usd,
    s.net_revenue AS net_steam_sales_usd,
    s.units_activated AS gross_units_activated
   FROM steam_sales s
UNION ALL
 SELECT pm.id::text AS id,
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
    0 AS chargebacks_returns,
    COALESCE(pm.net_units_sold, pm.gross_units_sold) AS net_units_sold,
    pm.base_price AS base_price_usd,
    pm.sale_price AS sale_price_usd,
    COALESCE(pm.gross_revenue_usd, 0::numeric) AS gross_steam_sales_usd,
    0 AS chargeback_returns_usd,
    0 AS vat_tax_usd,
    COALESCE(pm.net_revenue_usd, pm.gross_revenue_usd, 0::numeric) AS net_steam_sales_usd,
    COALESCE(pm.gross_units_activated, 0) AS gross_units_activated
   FROM performance_metrics pm;

-- get_sales_data_table: same single scan as sales_data_table_single_scan.sql, plus an
-- `activations` total per row. Existing keys and values are unchanged.
CREATE OR REPLACE FUNCTION get_sales_data_table(
  p_client_id uuid,
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL,
  p_product_name text DEFAULT NULL,
  p_platform text DEFAULT NULL,
  p_country_code text DEFAULT NULL,
  p_drill text DEFAULT 'product'
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET statement_timeout = '30s'
AS $$
  WITH rows AS NOT MATERIALIZED (
    SELECT product_name, product_type, platform, country_code, country, date,
           gross_units_sold, chargebacks_returns, net_units_sold,
           base_price_usd, gross_steam_sales_usd, net_steam_sales_usd, vat_tax_usd,
           gross_units_activated
    FROM unified_performance_view
    WHERE client_id = p_client_id
      AND (p_date_from IS NULL OR date >= p_date_from)
      AND (p_date_to IS NULL OR date <= p_date_to)
      AND (p_product_name IS NULL OR product_name = p_product_name)
      AND (p_platform IS NULL OR platform = p_platform)
      AND (p_country_code IS NULL OR country_code = p_country_code)
  ),
  g AS (
    SELECT
      (CASE p_drill
        WHEN 'game' THEN coalesce(product_name, 'Unknown')
        WHEN 'platform' THEN coalesce(platform, 'Unknown')
        WHEN 'country' THEN coalesce(country_code, 'Unknown') || '|' || coalesce(country, 'Unknown')
        WHEN 'daily' THEN coalesce(date::text, 'Unknown')
        ELSE coalesce(product_name, 'Unknown') || '|' || coalesce(platform, 'Unknown')
      END) AS key,
      product_name AS pn,
      platform AS pf,
      country_code AS cc,
      GROUPING(
        (CASE p_drill
          WHEN 'game' THEN coalesce(product_name, 'Unknown')
          WHEN 'platform' THEN coalesce(platform, 'Unknown')
          WHEN 'country' THEN coalesce(country_code, 'Unknown') || '|' || coalesce(country, 'Unknown')
          WHEN 'daily' THEN coalesce(date::text, 'Unknown')
          ELSE coalesce(product_name, 'Unknown') || '|' || coalesce(platform, 'Unknown')
        END),
        product_name, platform, country_code
      ) AS gbits,
      min(product_name) AS m_product_name,
      min(product_type) AS m_product_type,
      min(platform) AS m_platform,
      min(country_code) AS m_country_code,
      min(country) AS m_country,
      min(date) AS m_date,
      sum(gross_steam_sales_usd) AS gross_revenue,
      sum(net_steam_sales_usd) AS net_revenue,
      sum(gross_units_sold) AS gross_units,
      sum(net_units_sold) AS net_units,
      sum(chargebacks_returns) AS chargebacks,
      sum(vat_tax_usd) AS vat,
      sum(coalesce(base_price_usd, 0) * coalesce(net_units_sold, 0)) AS full_price_revenue,
      sum(coalesce(gross_units_activated, 0)) AS activations,
      count(*) AS row_count
    FROM rows
    GROUP BY GROUPING SETS (
      ((CASE p_drill
        WHEN 'game' THEN coalesce(product_name, 'Unknown')
        WHEN 'platform' THEN coalesce(platform, 'Unknown')
        WHEN 'country' THEN coalesce(country_code, 'Unknown') || '|' || coalesce(country, 'Unknown')
        WHEN 'daily' THEN coalesce(date::text, 'Unknown')
        ELSE coalesce(product_name, 'Unknown') || '|' || coalesce(platform, 'Unknown')
      END)),
      (product_name),
      (platform),
      (country_code)
    )
  )
  SELECT jsonb_build_object(
    'rows', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'product_name', CASE WHEN p_drill NOT IN ('platform', 'country', 'daily') THEN m_product_name END,
        'product_type', CASE WHEN p_drill NOT IN ('platform', 'country', 'daily') THEN m_product_type END,
        'platform', CASE WHEN p_drill NOT IN ('game', 'country', 'daily') THEN m_platform END,
        'country_code', CASE WHEN p_drill = 'country' THEN m_country_code END,
        'country', CASE WHEN p_drill = 'country' THEN m_country END,
        'date', (CASE WHEN p_drill = 'daily' THEN m_date END)::text,
        'gross_revenue', gross_revenue, 'net_revenue', net_revenue,
        'gross_units', gross_units, 'net_units', net_units,
        'chargebacks', chargebacks, 'vat', vat,
        'full_price_revenue', full_price_revenue, 'activations', activations,
        'row_count', row_count
      )), '[]'::jsonb)
      FROM g WHERE gbits = 7
    ),
    'products', (SELECT coalesce(jsonb_agg(DISTINCT pn), '[]'::jsonb) FROM g WHERE gbits = 11 AND pn IS NOT NULL),
    'platforms', (SELECT coalesce(jsonb_agg(DISTINCT pf), '[]'::jsonb) FROM g WHERE gbits = 13 AND pf IS NOT NULL),
    'countries', (SELECT coalesce(jsonb_agg(DISTINCT cc), '[]'::jsonb) FROM g WHERE gbits = 14 AND cc IS NOT NULL),
    'raw_row_count', (SELECT coalesce(sum(row_count), 0) FROM g WHERE gbits = 7)
  );
$$;
