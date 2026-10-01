-- get_sales_report_summary: one scan instead of one big materialised copy.
--
-- The old version did SELECT * from unified_performance_view into a CTE that six
-- aggregates then read: a full copy of every column of every matching row (including
-- the per-row region lookup) plus six passes. For Total Mayhem Games (720k rows) that
-- exceeded the 30s limit on the 0.5GB database. This computes every aggregate from a
-- single scan with GROUPING SETS (GROUPING() bits: 7 = platform, 11 = country,
-- 13 = product, 14 = date, 15 = grand total). Output is identical (checked against
-- the old function on an empty range, a month and a full year).

CREATE OR REPLACE FUNCTION get_sales_report_summary(
  p_client_id uuid,
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET statement_timeout = '30s'
AS $$
  WITH rows AS NOT MATERIALIZED (
    SELECT coalesce(platform, 'Unknown') AS plat,
           coalesce(country_code, country, 'Unknown') AS ctry,
           coalesce(product_name, 'Unknown') AS prod,
           date,
           net_steam_sales_usd, net_units_sold, gross_units_sold
    FROM unified_performance_view
    WHERE client_id = p_client_id
      AND (p_date_from IS NULL OR date >= p_date_from)
      AND (p_date_to IS NULL OR date <= p_date_to)
  ),
  g AS (
    SELECT plat, ctry, prod, date,
           GROUPING(plat, ctry, prod, date) AS gb,
           count(*)::bigint AS n,
           sum(net_steam_sales_usd) AS revenue,
           sum(net_units_sold) AS units,
           sum(gross_units_sold) AS gross_units
    FROM rows
    GROUP BY GROUPING SETS ((plat), (ctry), (prod), (date), ())
  ),
  totals AS (
    SELECT n AS total_rows,
           coalesce(revenue, 0) AS total_net_revenue,
           coalesce(gross_units, 0) AS total_gross_units,
           coalesce(units, 0) AS total_net_units
    FROM g WHERE gb = 15
  )
  SELECT jsonb_build_object(
    'total_rows', coalesce((SELECT total_rows FROM totals), 0),
    -- gross and net are the same source column here, matching the JS aggregation this replaced
    'total_gross_revenue', coalesce((SELECT total_net_revenue FROM totals), 0),
    'total_net_revenue', coalesce((SELECT total_net_revenue FROM totals), 0),
    'total_gross_units', coalesce((SELECT total_gross_units FROM totals), 0),
    'total_net_units', coalesce((SELECT total_net_units FROM totals), 0),
    'platform_revenue', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', plat, 'value', revenue) ORDER BY revenue DESC), '[]'::jsonb) FROM g WHERE gb = 7),
    'platform_units', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', plat, 'value', units) ORDER BY units DESC), '[]'::jsonb) FROM g WHERE gb = 7),
    'country_revenue', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', ctry, 'value', revenue) ORDER BY revenue DESC), '[]'::jsonb) FROM (SELECT * FROM g WHERE gb = 11 ORDER BY revenue DESC LIMIT 20) top_countries),
    'product_revenue', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', prod, 'value', revenue) ORDER BY revenue DESC), '[]'::jsonb) FROM g WHERE gb = 13),
    'product_units', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', prod, 'value', units) ORDER BY units DESC), '[]'::jsonb) FROM g WHERE gb = 13),
    'daily_revenue', (SELECT coalesce(jsonb_agg(jsonb_build_object('date', date::text, 'value', revenue) ORDER BY date ASC), '[]'::jsonb) FROM g WHERE gb = 14 AND date IS NOT NULL)
  );
$$;
