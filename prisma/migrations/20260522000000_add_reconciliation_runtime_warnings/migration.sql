-- Migration: add control_action_reconciliations.runtime_warnings (#59)
--
-- Stores optional runtime-produced warnings forwarded by the daemon/harness in the
-- reconcile body (e.g. CLAUDE_DELEGATION_CONFIG_NOT_PROVISIONED from #53's
-- delegation-config detection). Structure-validated at the route layer:
--   [{ code: string, severity: string, message: string }]
-- Surfaced to the control-plane / human UI as needs_human / known-gap context, so the
-- residual Claude CLAUDE.md-isolation gap is observable rather than silently inherited.
--
-- JSONB (nullable): absent for reconciles without warnings. No FK, no index needed
-- (read alongside the reconciliation row).

ALTER TABLE control_action_reconciliations
  ADD COLUMN runtime_warnings JSONB;
