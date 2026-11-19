-- google-news-scan writes source_type 'google_news' and web-scrape writes
-- 'web_scrape', but both CHECK constraints rejected them, so neither scanner
-- has ever stored a row. Widen the lists. NOT VALID then VALIDATE keeps the
-- table writable while existing rows are checked.
ALTER TABLE public.coverage_items DROP CONSTRAINT IF EXISTS coverage_items_source_type_check;
ALTER TABLE public.coverage_items ADD CONSTRAINT coverage_items_source_type_check
  CHECK (source_type IS NULL OR source_type::text = ANY (ARRAY[
    'rss','tavily','youtube','twitch','reddit','twitter','tiktok','instagram',
    'sullygnome','semrush','manual','wayback','google_news','web_scrape'
  ]::text[])) NOT VALID;
ALTER TABLE public.coverage_items VALIDATE CONSTRAINT coverage_items_source_type_check;

ALTER TABLE public.coverage_sources DROP CONSTRAINT IF EXISTS coverage_sources_source_type_check;
ALTER TABLE public.coverage_sources ADD CONSTRAINT coverage_sources_source_type_check
  CHECK (source_type::text = ANY (ARRAY[
    'rss','tavily','youtube','twitch','reddit','twitter','tiktok','instagram',
    'sullygnome','semrush','google_news','web_scrape'
  ]::text[])) NOT VALID;
ALTER TABLE public.coverage_sources VALIDATE CONSTRAINT coverage_sources_source_type_check;
