-- The Coverage Feed sorts by monthly_unique_visitors DESC NULLS LAST, id ASC by
-- default. With no matching index every load seq scanned and sorted all rows
-- (about 100k, 1.4kB wide) and hit the 8s statement timeout, so the Feed
-- returned a 500 for "All Clients".
CREATE INDEX IF NOT EXISTS idx_coverage_items_umv_sort
  ON public.coverage_items (monthly_unique_visitors DESC NULLS LAST, id ASC);
