/**
 * Operator capability model types — Slice 1 of the operator write capability contract v1.
 *
 * These are SHARED TYPE DEFINITIONS ONLY. No behavior, no DB calls, no POST endpoints.
 * Slice 2 (Task #83) will include these types in the GET action response for read_only_demo sessions.
 * Slice 3 (Task #84) will drive CodeLight rendering from these types.
 *
 * Key design decisions (from operator-write-capability-contract-v1.md):
 *   - `capability_version`: ISO timestamp of when this capability block was generated.
 *     Used as the stale-write CAS marker on write requests — client must echo it back.
 *   - `action_version`: ISO timestamp snapshot of action.updatedAt at generation time.
 *     Second CAS check to detect concurrent action state changes between GET and write.
 *   - Both are needed because capability_version is regenerated on each GET response even
 *     when action state hasn't changed, while action_version tracks actual action state.
 *   - anti-replay (nonce+timestamp in request signature) is enforced separately from
 *     idempotency_key. A captured idempotency key does NOT prevent replay attacks.
 *
 * Capability block is ALWAYS generated server-side.
 * Missing capability block = all writes unavailable (fail-closed).
 * CodeLight must NOT infer write authority from local status strings or hidden flags.
 */

// ---------------------------------------------------------------------------
// Controlled enums
// ---------------------------------------------------------------------------

/** Session/credential mode that produced this capability block. */
export type CapabilityMode =
  | 'read_only_demo'    // dev_ctl_... token: read-only, all writes disabled.
  | 'operator_review'   // operator_session credential: limited write scope.
  | 'admin_control';    // Future admin mode — NOT V1.

/** Commands that may appear in capabilities.commands (V1 allow-list). */
export type CapabilityCommandKey =
  | 'acknowledge_needs_human'  // Record operator ack. Does not change task success.
  | 'mark_reviewed'            // Advance review workflow. Does not mean task done.
  | 'approve'                  // Consume server approval. Must be pending and unexpired.
  | 'retry'                    // Create/authorize retry. Reversible + server-enabled only.
  | 'open_evidence';           // Read capability — may be available in read_only_demo.

/**
 * Reason codes for disabled commands.
 * Unknown values MUST render as neutral unavailable state. Never expose raw server text.
 */
export type CapabilityReason =
  | 'read_only_session'           // dev_ctl_... token — writes not permitted.
  | 'operator_credential_required'// No operator_session present.
  | 'server_capability_missing'   // Server has not yet implemented this command.
  | 'approval_not_pending'        // No pending approval to consume.
  | 'approval_expired'            // Approval window has passed.
  | 'action_state_changed'        // Action is no longer in a state that allows this.
  | 'terminal_action'             // Action has reached a terminal state.
  | 'irreversible_no_abort'       // Irreversible; requires explicit server gate.
  | 'retry_not_reversible'        // Cannot retry: not marked reversible by server.
  | 'credential_action_forbidden' // Operator credential is out-of-scope for this action.
  | 'unknown';                    // Catch-all — must render as neutral unavailable.

/** Confirmation level required before the user can submit a command. */
export type ConfirmationLevel =
  | 'none'      // No confirmation dialog (e.g. acknowledge_needs_human).
  | 'standard'  // Standard confirmation with redacted summary + command verb.
  | 'high';     // High-risk: also shows reversibility, expiration, success caveat.

// ---------------------------------------------------------------------------
// Per-command capability entry
// ---------------------------------------------------------------------------

export interface ControlCapabilityCommand {
  /** Whether this command is currently executable. */
  enabled: boolean;

  /**
   * Why the command is disabled. MUST be a CapabilityReason value.
   * Unknown reason values must render as neutral unavailable — never expose raw server text.
   * Absent when `enabled: true`.
   */
  reason?: CapabilityReason;

  /** Whether a confirmation dialog is required before submitting. */
  requires_confirmation: boolean;

  /** Confirmation level — determines what the dialog must show. */
  confirmation_level: ConfirmationLevel;
}

// ---------------------------------------------------------------------------
// Top-level capabilities block
// ---------------------------------------------------------------------------

/**
 * Server-generated capability block included in action detail responses.
 *
 * Rules:
 *   - If this block is ABSENT from a response, CodeLight treats ALL writes as unavailable.
 *   - `commands` only includes keys that are meaningful for the current action state.
 *     Missing key = command unavailable (same as enabled: false).
 *   - CodeLight must NOT synthesize write authority from local status strings.
 *
 * Stale-write protection (for future write endpoints):
 *   - Client echoes `capability_version` and `action_version` in write request body.
 *   - Server rejects with 409 if action has been mutated since these were issued.
 *
 * Security invariant:
 *   This block must NEVER contain:
 *     - token values or credential aliases
 *     - storage_ref or secret file paths
 *     - raw evidence bodies
 *     - vendor/KMS/Vault/SSM error text
 *     - hidden admin policy details
 */
export interface ControlCapabilities {
  /** Session mode that generated this block. */
  mode: CapabilityMode;

  /**
   * ISO timestamp of when this capability block was generated.
   * Used as a CAS marker on write requests: client must echo this back.
   * Server rejects with 409 if a fresher capability exists (concurrent write detected).
   */
  capability_version: string;

  /**
   * ISO timestamp snapshot of action.updatedAt at generation time.
   * Second CAS check on write requests: client echoes this; server rejects 409 if
   * action has been mutated (state change) since this was captured.
   */
  action_version: string;

  /**
   * Per-command capability entries. Only V1 command keys are allowed.
   * Missing entry = command unavailable.
   */
  commands: Partial<Record<CapabilityCommandKey, ControlCapabilityCommand>>;
}

// ---------------------------------------------------------------------------
// Action response extension
// ---------------------------------------------------------------------------

/**
 * Shape of the `capabilities` field in GET /api/v1/actions/:id responses.
 * Optional — absent in non-capability-aware sessions (e.g. machine_token only mode
 * before Slice 2 is deployed).
 */
export interface ActionResponseWithCapabilities {
  capabilities?: ControlCapabilities;
}
