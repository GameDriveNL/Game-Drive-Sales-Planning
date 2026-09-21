-- Same bug as get_sales_report_summary (add_sales_report_summary_rpc.sql),
-- in the sibling Data Tables endpoint: app/api/reports/data-table/route.ts
-- paginated unified_performance_view via sequential OFFSET and grouped in
-- JS, which hangs for "All Time" + a client with lots of history (confirmed
-- live: All Games/All Time for tobspr Games never resolved after 45s+).
--
-- This does the GROUP BY (whichever dimension the "Drill Down" dropdown
-- picked — game/product/platform/country/daily) in Postgres in one pass,
-- and returns the aggregated rows plus the three filter-option lists
-- (distinct products/platforms/countries) the UI's filter dropdowns need.
-- The route still does sort/search/pagination in JS afterward, same as
-- before — but now over the aggregated result set (tens to low thousands of
-- rows) instead of every raw sales row (hundreds of thousands for a client
-- like tobspr Games).
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
  WITH rows AS (
    SELECT product_name, product_type, platform, country_code, country, date,
           gross_units_sold, chargebacks_returns, net_units_sold,
           base_price_usd, gross_steam_sales_usd, net_steam_sales_usd, vat_tax_usd
    FROM unified_performance_view
    WHERE client_id = p_client_id
      AND (p_date_from IS NULL OR date >= p_date_from)
      AND (p_date_to IS NULL OR date <= p_date_to)
      AND (p_product_name IS NULL OR product_name = p_product_name)
      AND (p_platform IS NULL OR platform = p_platform)
      AND (p_country_code IS NULL OR country_code = p_country_code)
  ),
  grouped AS (
    SELECT
      CASE p_drill
        WHEN 'game' THEN coalesce(product_name, 'Unknown')
        WHEN 'platform' THEN coalesce(platform, 'Unknown')
        WHEN 'country' THEN coalesce(country_code, 'Unknown') || '|' || coalesce(country, 'Unknown')
        WHEN 'daily' THEN coalesce(date::text, 'Unknown')
        ELSE coalesce(product_name, 'Unknown') || '|' || coalesce(platform, 'Unknown')
      END AS key,
      -- Only populate the fields relevant to the chosen drill level, matching
      -- what the JS aggregation this replaces used to set per drill case. An
      -- unrecognized p_drill falls through to the 'product' shape, same as
      -- the key CASE's ELSE branch above.
      CASE WHEN p_drill NOT IN ('platform', 'country', 'daily') THEN min(product_name) END AS product_name,
      CASE WHEN p_drill NOT IN ('platform', 'country', 'daily') THEN min(product_type) END AS product_type,
      CASE WHEN p_drill NOT IN ('game', 'country', 'daily') THEN min(platform) END AS platform,
      CASE WHEN p_drill = 'country' THEN min(country_code) END AS country_code,
      CASE WHEN p_drill = 'country' THEN min(country) END AS country,
      CASE WHEN p_drill = 'daily' THEN min(date) END AS date,
      sum(gross_steam_sales_usd) AS gross_revenue,
      sum(net_steam_sales_usd) AS net_revenue,
      sum(gross_units_sold) AS gross_units,
      sum(net_units_sold) AS net_units,
      sum(chargebacks_returns) AS chargebacks,
      sum(vat_tax_usd) AS vat,
      sum(coalesce(base_price_usd, 0) * coalesce(net_units_sold, 0)) AS full_price_revenue,
      count(*) AS row_count
    FROM rows
    GROUP BY 1
  )
  SELECT jsonb_build_object(
    'rows', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'product_name', product_name, 'product_type', product_type,
        'platform', platform, 'country_code', country_code, 'country', country,
        'date', date::text,
        'gross_revenue', gross_revenue, 'net_revenue', net_revenue,
        'gross_units', gross_units, 'net_units', net_units,
        'chargebacks', chargebacks, 'vat', vat,
        'full_price_revenue', full_price_revenue, 'row_count', row_count
      )), '[]'::jsonb)
      FROM grouped
    ),
    'products', (SELECT coalesce(jsonb_agg(DISTINCT product_name), '[]'::jsonb) FROM rows WHERE product_name IS NOT NULL),
    'platforms', (SELECT coalesce(jsonb_agg(DISTINCT platform), '[]'::jsonb) FROM rows WHERE platform IS NOT NULL),
    'countries', (SELECT coalesce(jsonb_agg(DISTINCT country_code), '[]'::jsonb) FROM rows WHERE country_code IS NOT NULL),
    'raw_row_count', (SELECT coalesce(sum(row_count), 0) FROM grouped)
  );
$$;

GRANT EXECUTE ON FUNCTION get_sales_data_table(uuid, date, date, text, text, text, text) TO authenticated, service_role;
