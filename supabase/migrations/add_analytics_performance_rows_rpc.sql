-- Same bug class as the two Reports fixes (add_sales_report_summary_rpc.sql,
-- add_sales_data_table_rpc.sql), on the Steam Analytics page this time:
-- app/analytics/page.tsx's fetchPerformanceData() paginated
-- unified_performance_view via sequential OFFSET, client-side, in the
-- browser. Confirmed live: "All Time" for tobspr Games (138k+ rows) never
-- finished loading — the revenue/units stat cards stayed on loading
-- skeletons indefinitely. There was already a comment in that file
-- acknowledging a related earlier failure ("this made the batched fetch so
-- slow it never finished"), mitigated at the time by filtering out
-- zero-activity rows, but the underlying OFFSET-walk cost was never fixed.
--
-- Unlike the Reports pages, the Analytics page needs the actual raw rows
-- (10+ separate useMemo blocks each slice the data differently — by day, by
-- sale period, by proposition, etc.), not a pre-aggregated summary, so this
-- can't be collapsed into GROUP BY sums the way the Reports fix was. Instead
-- it returns every matching row as a single jsonb array in one query — no
-- pagination needed at all, since PostgREST's row-count cap (db-max-rows)
-- applies to table/view REST requests, not to a single RPC call returning
-- one jsonb value.
CREATE OR REPLACE FUNCTION get_analytics_performance_rows(
  p_client_id uuid,
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL,
  p_product_name text DEFAULT NULL,
  p_region text DEFAULT NULL,
  p_platform text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
-- Benchmarked at 26-37s for the largest client (tobspr Games, 98k rows after
-- the zero-activity filter) depending on cache state — close enough to a 30s
-- ceiling that a cold-cache run could occasionally still hit it, so this
-- gets more headroom than the two Reports RPCs (which came in reliably
-- under 30s).
SET statement_timeout = '60s'
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'date', date::text,
    'product_name', product_name,
    'platform', platform,
    'country_code', country_code,
    'country', country,
    'region', region,
    'gross_units_sold', gross_units_sold,
    'chargebacks_returns', chargebacks_returns,
    'net_units_sold', net_units_sold,
    'base_price_usd', base_price_usd,
    'sale_price_usd', sale_price_usd,
    'net_steam_sales_usd', net_steam_sales_usd,
    'client_id', client_id
  )), '[]'::jsonb)
  FROM unified_performance_view
  WHERE client_id = p_client_id
    AND (p_date_from IS NULL OR date >= p_date_from)
    AND (p_date_to IS NULL OR date <= p_date_to)
    AND (p_product_name IS NULL OR product_name = p_product_name)
    AND (p_region IS NULL OR region = p_region)
    AND (p_platform IS NULL OR platform = p_platform)
    -- Same zero-activity-row exclusion the page already applied (lossless —
    -- zeros sum to zero — and cuts the matching set ~22x per the original
    -- comment).
    AND (
      coalesce(net_units_sold, 0) <> 0
      OR coalesce(gross_units_sold, 0) <> 0
      OR coalesce(net_steam_sales_usd, 0) <> 0
    );
$$;

GRANT EXECUTE ON FUNCTION get_analytics_performance_rows(uuid, date, date, text, text, text) TO authenticated, service_role;
