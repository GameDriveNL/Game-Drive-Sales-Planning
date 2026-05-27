-- Dedupe per-game coverage_sources rows and prevent recurrence.
--
-- Three games (Verdun, Tannenberg, Rift Reborn) ended up with two identical
-- tavily source rows from a check-then-insert race in autoEnrollGameInScrapers.
-- All duplicate rows had last_run_at: null, items_found: 0, identical config,
-- so the keep-the-oldest choice loses no scan history.

-- Step 1: keep the oldest row per (game_id, source_type), delete the rest.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY game_id, source_type
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM coverage_sources
  WHERE game_id IS NOT NULL
)
DELETE FROM coverage_sources
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- Step 2: enforce one source per (game, source_type) going forward.
-- Partial index because globally-scoped sources (game_id IS NULL, e.g. the
-- "test - Web Search" tavily source) legitimately don't need this constraint.
CREATE UNIQUE INDEX IF NOT EXISTS
  uq_coverage_sources_game_type
ON coverage_sources (game_id, source_type)
WHERE game_id IS NOT NULL;
