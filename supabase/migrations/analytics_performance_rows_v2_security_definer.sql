-- get_analytics_performance_rows_v2: check access ONCE, then read without per-row RLS.
--
-- As a normal (authenticated) user the function was far too slow for big clients:
-- steam_sales has row level security policies that call is_superadmin() /
-- has_client_access(client_id), both SECURITY DEFINER SQL functions with two table
-- lookups each, and Postgres calls them once per row. For Total Mayhem Games
-- (720k rows) that took longer than the 40s limit ("canceling statement due to
-- statement timeout") although the same work takes ~7s without per-row checks.
--
-- Fix: run as the function owner (SECURITY DEFINER) and enforce the SAME rule the
-- policies enforce, once, up front: superadmin, or access to this client. Data is
-- only ever read for p_client_id. Callable by authenticated and service_role only.

CREATE OR REPLACE FUNCTION get_analytics_performance_rows_v2(
  p_client_id uuid,
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL,
  p_product_name text DEFAULT NULL,
  p_region text DEFAULT NULL,
  p_platform text DEFAULT NULL,
  p_max_rows integer DEFAULT 40000
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '40s'
SET work_mem = '16MB'
AS $$
DECLARE
  v_max integer := least(greatest(coalesce(p_max_rows, 40000), 1000), 150000);
  v_rows bigint;
  v_days integer;
  v_top text[];
  v_result jsonb;
  v_countries jsonb;
  v_out_rows integer;
BEGIN
  -- Same rule as the steam_sales / performance_metrics SELECT policies, evaluated once.
  IF NOT (
    session_user IN ('postgres', 'supabase_admin')
    OR coalesce(auth.role(), '') = 'service_role'
    OR public.is_superadmin()
    OR public.has_client_access(p_client_id)
  ) THEN
    RAISE EXCEPTION 'Not allowed to view analytics for this client' USING ERRCODE = '42501';
  END IF;

  WITH g AS (
    SELECT product_name,
           count(*) AS n,
           count(DISTINCT date) AS d,
           sum(coalesce(net_steam_sales_usd, 0)) AS rev,
           GROUPING(product_name) AS is_total
    FROM unified_performance_view
    WHERE client_id = p_client_id
      AND (p_date_from IS NULL OR date >= p_date_from)
      AND (p_date_to IS NULL OR date <= p_date_to)
      AND (p_product_name IS NULL OR product_name = p_product_name)
      AND (p_region IS NULL OR region = p_region)
      AND (p_platform IS NULL OR platform = p_platform)
      AND (
        coalesce(net_units_sold, 0) <> 0
        OR coalesce(gross_units_sold, 0) <> 0
        OR coalesce(net_steam_sales_usd, 0) <> 0
      )
    GROUP BY GROUPING SETS ((product_name), ())
  )
  SELECT
    (SELECT n FROM g WHERE is_total = 1),
    (SELECT d FROM g WHERE is_total = 1),
    (SELECT array_agg(product_name ORDER BY rev DESC)
       FROM (SELECT product_name, rev FROM g WHERE is_total = 0 AND product_name IS NOT NULL ORDER BY rev DESC LIMIT 40) t)
  INTO v_rows, v_days, v_top;

  v_rows := coalesce(v_rows, 0);
  v_days := coalesce(v_days, 0);

  IF v_rows <= v_max THEN
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
    INTO v_result
    FROM unified_performance_view
    WHERE client_id = p_client_id
      AND (p_date_from IS NULL OR date >= p_date_from)
      AND (p_date_to IS NULL OR date <= p_date_to)
      AND (p_product_name IS NULL OR product_name = p_product_name)
      AND (p_region IS NULL OR region = p_region)
      AND (p_platform IS NULL OR platform = p_platform)
      AND (
        coalesce(net_units_sold, 0) <> 0
        OR coalesce(gross_units_sold, 0) <> 0
        OR coalesce(net_steam_sales_usd, 0) <> 0
      );

    RETURN jsonb_build_object(
      'grain', 'raw',
      'raw_row_count', v_rows,
      'total_days', v_days,
      'rows', v_result,
      'country_totals', '[]'::jsonb
    );
  END IF;

  WITH a AS (
    SELECT
      date_trunc('month', date)::date AS m,
      CASE WHEN product_name = ANY (v_top) THEN product_name ELSE 'Other products' END AS prod,
      platform,
      region,
      country_code,
      GROUPING(country_code) AS is_main,
      sum(coalesce(gross_units_sold, 0)) AS gu,
      sum(coalesce(chargebacks_returns, 0)) AS cb,
      sum(coalesce(net_units_sold, 0)) AS nu,
      sum(coalesce(net_steam_sales_usd, 0)) AS rev,
      max(country) AS country
    FROM unified_performance_view
    WHERE client_id = p_client_id
      AND (p_date_from IS NULL OR date >= p_date_from)
      AND (p_date_to IS NULL OR date <= p_date_to)
      AND (p_product_name IS NULL OR product_name = p_product_name)
      AND (p_region IS NULL OR region = p_region)
      AND (p_platform IS NULL OR platform = p_platform)
      AND (
        coalesce(net_units_sold, 0) <> 0
        OR coalesce(gross_units_sold, 0) <> 0
        OR coalesce(net_steam_sales_usd, 0) <> 0
      )
    GROUP BY GROUPING SETS (
      (date_trunc('month', date)::date, (CASE WHEN product_name = ANY (v_top) THEN product_name ELSE 'Other products' END), platform, region),
      (country_code)
    )
  )
  SELECT
    coalesce((SELECT jsonb_agg(jsonb_build_object(
      'date', m::text,
      'product_name', prod,
      'platform', platform,
      'country_code', NULL,
      'country', NULL,
      'region', region,
      'gross_units_sold', gu,
      'chargebacks_returns', cb,
      'net_units_sold', nu,
      'base_price_usd', NULL,
      'sale_price_usd', NULL,
      'net_steam_sales_usd', rev,
      'client_id', p_client_id
    )) FROM a WHERE is_main = 1), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(jsonb_build_object(
      'country_code', country_code,
      'country', country,
      'net_steam_sales_usd', rev,
      'net_units_sold', nu
    ) ORDER BY rev DESC) FROM (SELECT * FROM a WHERE is_main = 0 ORDER BY rev DESC LIMIT 300) c), '[]'::jsonb),
    (SELECT count(*) FROM a WHERE is_main = 1)
  INTO v_result, v_countries, v_out_rows;

  IF v_out_rows > v_max * 3 THEN
    RAISE EXCEPTION 'Range too large to summarise (% groups); choose a shorter range', v_out_rows;
  END IF;

  RETURN jsonb_build_object(
    'grain', 'monthly_region',
    'raw_row_count', v_rows,
    'total_days', v_days,
    'rows', v_result,
    'country_totals', v_countries
  );
END;
$$;

REVOKE ALL ON FUNCTION get_analytics_performance_rows_v2(uuid, date, date, text, text, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_analytics_performance_rows_v2(uuid, date, date, text, text, text, integer) TO authenticated, service_role;
