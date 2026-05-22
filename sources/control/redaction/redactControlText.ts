/**
 * Server-side control-plane text redactor (#141).
 *
 * Defense-in-depth no-leak pass for free-text fields that surface to the human UI via GET
 * (currently: reconciliation output_summary / raw_log_redacted flattened onto GET /actions).
 *
 * This MIRRORS CodeLight's client ControlPlaneRedactor patterns so server + client agree on
 * what counts as a secret. It is a SAFETY NET on top of the contract that the daemon already
 * sends a productized summary + an already-redacted log — NOT a substitute for daemon-side
 * redaction, and NOT a complete PII/secret scrubber. It scrubs known high-value token shapes,
 * PEM blocks, storage_ref values, daemon secret-file paths, and credential aliases.
 *
 * Keep these patterns in lockstep with CodeLight/app/CodeLight/Models/ControlPlaneRedactor.swift.
 */

const REPLACEMENT = '[REDACTED]';

// Each pattern is global; PEM uses dotall ([\s\S]). Case-insensitive where the Swift side is.
const PATTERNS: RegExp[] = [
  // act_tok_ one-time action tokens (base64url suffix)
  /act_tok_[A-Za-z0-9\-_]+/gi,
  // dev_ctl_ read-only debug control tokens (base64url(32B) suffix)
  /dev_ctl_[A-Za-z0-9\-_]+/gi,
  // op_sess_ operator write session tokens (server-only; not in the client list but is a secret)
  /op_sess_[A-Za-z0-9\-_]+/gi,
  // 64-hex machine token / sha256 shape, anchored to non-hex boundaries (reduce git-SHA false positives)
  /(?<![A-Fa-f0-9])[A-Fa-f0-9]{64}(?![A-Fa-f0-9])/g,
  // PEM blocks (multi-line)
  /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g,
  // storage_ref values: "storage_ref":"<value>" or storage_ref=<value>
  /"?storage_ref"?\s*[=:]\s*"?[^\s,"}]+/gi,
  // daemon secret-file paths: /tmp/mio-* (Linux) and /var/folders/.../T/mio-* (macOS TMPDIR)
  /\/tmp\/mio-[^\s"',\]]+/gi,
  /\/var\/folders\/[^\s"',\]]*?\/T\/mio-[^\s"',\]]+/gi,
  // credential alias identifiers: alias:<name>
  /alias:[A-Za-z0-9_\-.]+/gi,
];

/**
 * Redact all known sensitive patterns from `input`. Returns a new string with each match
 * replaced by "[REDACTED]". Passes through null/undefined unchanged.
 */
export function redactControlText<T extends string | null | undefined>(input: T): T {
  if (input == null) return input;
  let result = input as string;
  for (const re of PATTERNS) {
    result = result.replace(re, REPLACEMENT);
  }
  return result as T;
}
