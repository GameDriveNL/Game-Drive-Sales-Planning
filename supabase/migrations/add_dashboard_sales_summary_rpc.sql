-- Same bug class as the Reports/Analytics fixes (add_sales_report_summary_rpc.sql,
-- add_sales_data_table_rpc.sql, add_analytics_performance_rows_rpc.sql), on
-- the client Dashboard this time: app/api/dashboard/route.ts ran two
-- separate while(true)+.range() loops against unified_performance_view (one
-- for the last 30 days, one for the prior 30 days) and summed in JS. Bounded
-- to a fixed 60-day window total, so unlike the other three it never hangs
-- or times out — but it's still slower than a landing page should be (1.5
-- to 6s live-tested) since each window can take several sequential round
-- trips for a heavy client.
--
-- This computes both windows' sums/breakdowns in a single query instead —
-- one round trip total instead of up to ~10-20.
CREATE OR REPLACE FUNCTION get_dashboard_sales_summary(
  p_client_id uuid,
  p_current_from date,
  p_current_to date,
  p_prior_from date,
  p_prior_to date
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET statement_timeout = '20s'
AS $$
  WITH current_rows AS (
    SELECT date, product_name, platform, net_units_sold, net_steam_sales_usd
    FROM unified_performance_view
    WHERE client_id = p_client_id
      AND date >= p_current_from AND date <= p_current_to
  ),
  prior_rows AS (
    SELECT net_units_sold, net_steam_sales_usd
    FROM unified_performance_view
    WHERE client_id = p_client_id
      AND date >= p_prior_from AND date < p_prior_to
  ),
  by_product AS (
    SELECT coalesce(product_name, 'Unknown') AS name, sum(net_steam_sales_usd) AS revenue
    FROM current_rows GROUP BY 1
  ),
  by_platform AS (
    SELECT coalesce(platform, 'Unknown') AS name, sum(net_steam_sales_usd) AS revenue
    FROM current_rows GROUP BY 1
  ),
  by_date AS (
    SELECT date, sum(net_steam_sales_usd) AS revenue
    FROM current_rows
    WHERE date IS NOT NULL
    GROUP BY date
  )
  SELECT jsonb_build_object(
    'current_revenue', (SELECT coalesce(sum(net_steam_sales_usd), 0) FROM current_rows),
    'current_units', (SELECT coalesce(sum(net_units_sold), 0) FROM current_rows),
    'prior_revenue', (SELECT coalesce(sum(net_steam_sales_usd), 0) FROM prior_rows),
    'prior_units', (SELECT coalesce(sum(net_units_sold), 0) FROM prior_rows),
    'top_products', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('name', name, 'value', revenue) ORDER BY revenue DESC), '[]'::jsonb)
      FROM (SELECT * FROM by_product ORDER BY revenue DESC LIMIT 5) top5
    ),
    'platform_breakdown', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', name, 'value', revenue) ORDER BY revenue DESC), '[]'::jsonb) FROM by_platform),
    'revenue_trend', (SELECT coalesce(jsonb_agg(jsonb_build_object('date', date::text, 'value', revenue) ORDER BY date ASC), '[]'::jsonb) FROM by_date)
  );
$$;

GRANT EXECUTE ON FUNCTION get_dashboard_sales_summary(uuid, date, date, date, date) TO authenticated, service_role;
