-- Add a "Clarification Needed" status to the feedback Kanban board — for
-- items that are blocked on a decision or answer from the client rather
-- than active development work.
ALTER TABLE feedback_items DROP CONSTRAINT feedback_items_status_check;
ALTER TABLE feedback_items ADD CONSTRAINT feedback_items_status_check
  CHECK (status = ANY (ARRAY['backlogged'::text, 'clarification_needed'::text, 'in_development'::text, 'tested_pending_review'::text, 'fix_verified'::text]));
