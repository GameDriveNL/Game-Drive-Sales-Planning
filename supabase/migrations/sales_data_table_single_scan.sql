-- get_sales_data_table: one scan instead of five.
--
-- The old version selected every matching row into a CTE that was then read four
-- times (the grouped result plus DISTINCT lists of products, platforms and
-- countries). For a client with hundreds of thousands of rows that is a full
-- copy of the table in a temporary store plus four passes over it: 18 to 30
-- seconds on the 0.5GB database, while everything else queues behind it
-- (seen live 2026-10-01: Total Mayhem Games / tobspr timeouts and 500s).
--
-- This does ONE scan with GROUPING SETS: the requested drill-down groups plus the
-- three distinct lists come out of the same pass. Output shape and values are
-- identical (verified against the old function for every drill level).
-- GROUPING() bit values: 7 = drill groups, 11 = products, 13 = platforms, 14 = countries.

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
           base_price_usd, gross_steam_sales_usd, net_steam_sales_usd, vat_tax_usd
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
        'full_price_revenue', full_price_revenue, 'row_count', row_count
      )), '[]'::jsonb)
      FROM g WHERE gbits = 7
    ),
    'products', (SELECT coalesce(jsonb_agg(DISTINCT pn), '[]'::jsonb) FROM g WHERE gbits = 11 AND pn IS NOT NULL),
    'platforms', (SELECT coalesce(jsonb_agg(DISTINCT pf), '[]'::jsonb) FROM g WHERE gbits = 13 AND pf IS NOT NULL),
    'countries', (SELECT coalesce(jsonb_agg(DISTINCT cc), '[]'::jsonb) FROM g WHERE gbits = 14 AND cc IS NOT NULL),
    'raw_row_count', (SELECT coalesce(sum(row_count), 0) FROM g WHERE gbits = 7)
  );
$$;
