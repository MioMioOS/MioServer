-- Migration: add control_action_reconciliations.output_summary + raw_log_redacted (#141)
--
-- Data source for the CodeLight P1 Evidence / Runtime Log pushed pages (plan B):
-- evidence/log belong to post-run reconcile evidence, not the action's main row. The daemon
-- reports a productized output summary + an ALREADY-redacted runtime log excerpt at reconcile;
-- GET /actions(/:id) flattens the most recent reconciliation's values (re-redacted server-side
-- as defense-in-depth) so the human UI can show real evidence/log instead of an empty state.
--
-- TEXT (nullable): NULL until the daemon backfills (#141 daemon side). No index needed
-- (read alongside the reconciliation row, same as runtime_warnings #59).

ALTER TABLE control_action_reconciliations
  ADD COLUMN output_summary TEXT,
  ADD COLUMN raw_log_redacted TEXT;
