-- Reports page ("Generate Report" summary) was hanging/timing out on the "All
-- Time" period for clients with a lot of sales history (e.g. 138k+ rows for
-- tobspr Games). It worked by paginating unified_performance_view 1000 rows
-- at a time and summing in JS — each page used OFFSET, which costs roughly
-- O(offset) since Postgres has to walk and discard that many rows first, so
-- total cost across ~139 pages was effectively O(n^2) and eventually hit the
-- statement timeout. This computes the same aggregates in a single pass in
-- Postgres instead of shipping every raw row over the wire.
--
-- Tried and measured against the 138k-row client before landing on this
-- plain, unhinted shape:
--   - plain (non-materialized) CTE, SELECT *: ~8.1-26s depending on cache
--     state — consistently the best result of the shapes tried
--   - MATERIALIZED CTE, SELECT *: ~9.2-9.9s, spills to disk (wide rows)
--   - MATERIALIZED CTE, narrow 8-column SELECT: ~9.5s, still spills
--   - plain CTE + SET work_mem = '256MB': ~17.2s — clearly worse
-- Every attempt to hint the planner (materialize, widen work_mem) made this
-- slower, not faster, so it's left as the planner's own default plan.
--
-- Separately: PostgREST caps the `authenticated` role's statement_timeout at
-- 8s project-wide (`anon` is 3s). This route calls Supabase with the service
-- role key, but the effective role the query runs under still hit that ~8s
-- ceiling in production, canceling the query outright (Postgres error 57014)
-- whenever cold-cache execution ran past it — a real 500, not just slow.
-- SET statement_timeout here raises the ceiling for this function's own
-- duration only, without touching the project-wide role default that every
-- other query depends on for runaway-query protection.
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
  WITH rows AS (
    SELECT *
    FROM unified_performance_view
    WHERE client_id = p_client_id
      AND (p_date_from IS NULL OR date >= p_date_from)
      AND (p_date_to IS NULL OR date <= p_date_to)
  ),
  totals AS (
    SELECT
      count(*)::bigint AS total_rows,
      coalesce(sum(net_steam_sales_usd), 0) AS total_net_revenue,
      coalesce(sum(gross_units_sold), 0) AS total_gross_units,
      coalesce(sum(net_units_sold), 0) AS total_net_units
    FROM rows
  ),
  by_platform AS (
    SELECT coalesce(platform, 'Unknown') AS name, sum(net_steam_sales_usd) AS revenue, sum(net_units_sold) AS units
    FROM rows GROUP BY 1
  ),
  by_country AS (
    SELECT coalesce(country_code, country, 'Unknown') AS name, sum(net_steam_sales_usd) AS revenue
    FROM rows GROUP BY 1
  ),
  by_product AS (
    SELECT coalesce(product_name, 'Unknown') AS name, sum(net_steam_sales_usd) AS revenue, sum(net_units_sold) AS units
    FROM rows GROUP BY 1
  ),
  by_day AS (
    SELECT date, sum(net_steam_sales_usd) AS revenue
    FROM rows
    WHERE date IS NOT NULL
    GROUP BY date
  )
  SELECT jsonb_build_object(
    'total_rows', (SELECT total_rows FROM totals),
    -- gross and net are the same source column here — matches the existing
    -- JS aggregation this replaces, which summed net_steam_sales_usd into both.
    'total_gross_revenue', (SELECT total_net_revenue FROM totals),
    'total_net_revenue', (SELECT total_net_revenue FROM totals),
    'total_gross_units', (SELECT total_gross_units FROM totals),
    'total_net_units', (SELECT total_net_units FROM totals),
    'platform_revenue', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', name, 'value', revenue) ORDER BY revenue DESC), '[]'::jsonb) FROM by_platform),
    'platform_units', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', name, 'value', units) ORDER BY units DESC), '[]'::jsonb) FROM by_platform),
    'country_revenue', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', name, 'value', revenue) ORDER BY revenue DESC), '[]'::jsonb) FROM (SELECT * FROM by_country ORDER BY revenue DESC LIMIT 20) top_countries),
    'product_revenue', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', name, 'value', revenue) ORDER BY revenue DESC), '[]'::jsonb) FROM by_product),
    'product_units', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', name, 'value', units) ORDER BY units DESC), '[]'::jsonb) FROM by_product),
    'daily_revenue', (SELECT coalesce(jsonb_agg(jsonb_build_object('date', date::text, 'value', revenue) ORDER BY date ASC), '[]'::jsonb) FROM by_day)
  );
$$;

GRANT EXECUTE ON FUNCTION get_sales_report_summary(uuid, date, date) TO authenticated, service_role;
