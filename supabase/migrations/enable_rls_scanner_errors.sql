-- scanner_errors was the only public table without RLS, flagged by Supabase
-- security advisor. It stores internal coverage-scanner diagnostics (not
-- client-confidential, but must not be world-readable/writable).
ALTER TABLE scanner_errors ENABLE ROW LEVEL SECURITY;

-- Service role (used by all API routes + cron) gets unrestricted access.
CREATE POLICY "Service role full access on scanner_errors"
  ON scanner_errors FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Authenticated users can read scanner errors for games they have access to.
CREATE POLICY "Authenticated users can read scanner_errors"
  ON scanner_errors FOR SELECT
  TO authenticated
  USING (
    game_id IS NULL
    OR EXISTS (
      SELECT 1 FROM games g
      JOIN user_clients uc ON uc.client_id = g.client_id
      WHERE g.id = scanner_errors.game_id
        AND uc.user_id = auth.uid()
    )
  );
