/**
 * Slice 2 (Task #83) — server-side generator for the `read_only_demo` capability block.
 *
 * Emitted in GET /api/v1/actions/:id for dev_ctl_ (read-only) sessions so CodeLight renders the
 * Operator Actions area from server-authoritative capabilities instead of local placeholders.
 *
 * read_only_demo semantics (per operator-write-capability-contract-v1.md + #85 decision):
 *   - mode = 'read_only_demo' (dev_ctl_ token — no operator_session).
 *   - ALL write commands disabled with reason 'read_only_session' (a read-only session can never
 *     write, regardless of action state — the session, not the state, is the gate).
 *   - open_evidence is a READ capability → enabled (no operator_session required).
 *   - capability_version (generation time) and action_version (action.updatedAt) are TWO distinct
 *     CAS markers for future stale-write protection — never merged into one field.
 *
 * SECURITY: this block contains only controlled enums + two ISO timestamps. It MUST NOT carry any
 * token, credential alias, storage_ref, secret path, evidence body, or vendor error text.
 */

import type {
  ControlCapabilities,
  ControlCapabilityCommand,
} from './controlCapabilityTypes.js';

/** A disabled write command in a read-only session. */
function disabledWrite(confirmation_level: ControlCapabilityCommand['confirmation_level']): ControlCapabilityCommand {
  return {
    enabled: false,
    reason: 'read_only_session',
    requires_confirmation: confirmation_level !== 'none',
    confirmation_level,
  };
}

/**
 * Build the read_only_demo capability block for an action.
 *
 * @param action  Minimal action shape — only `updatedAt` is needed (for action_version).
 * @param now     Injectable clock for deterministic tests (defaults to current time).
 */
export function buildReadOnlyDemoCapabilities(
  action: { updatedAt: Date },
  now: Date = new Date(),
): ControlCapabilities {
  return {
    mode: 'read_only_demo',
    capability_version: now.toISOString(),
    action_version: action.updatedAt.toISOString(),
    commands: {
      // Write commands — all disabled in a read-only session.
      acknowledge_needs_human: disabledWrite('none'),
      mark_reviewed: disabledWrite('standard'),
      approve: disabledWrite('standard'),
      retry: disabledWrite('high'),
      // Read capability — available without an operator_session.
      open_evidence: {
        enabled: true,
        requires_confirmation: false,
        confirmation_level: 'none',
      },
    },
  };
}
