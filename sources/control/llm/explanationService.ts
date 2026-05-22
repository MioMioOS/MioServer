/**
 * #162 Phase 1 — server-assist LLM explanation security base.
 *
 * This is the boundary core for the optional "explanation layer": it turns already-AUTHORIZED,
 * structured control-plane state into a short user-facing explanation, while enforcing the #162
 * security口径:
 *   - authorize-before-build, FAIL CLOSED: refuse to build a prompt without authorized provenance.
 *   - input redaction: every free-text field is redacted (redactControlText, #141) before it can
 *     reach the provider.
 *   - provider orchestration: feature-flag gated; timeout + error → deterministic fallback.
 *   - output distrust: if the LLM output contains ANY secret-shaped string, the whole output is
 *     discarded and we fall back to deterministic text (an LLM should never emit a token/secret —
 *     it never saw a raw one; emission = hallucination or injection success → do not trust it).
 *
 * NO raw token / machine_token / path / repo / execution ever touches this layer. The provider
 * (a thin EC2 explain-service over a service-owned model API) only ever receives RedactedPromptInput.
 *
 * This module is intentionally provider-agnostic + DB-agnostic so it is fully unit-testable. The
 * scope-fetch (authorize-then-redact against real control-plane data) and the EC2 provider adapter
 * are wired in later slices on top of this base.
 */
import { redactControlText } from '@/control/redaction/redactControlText';

export type ExplanationKind = 'readiness' | 'action_failure' | 'task_summary';

/** Proof the caller already authorized this viewer for this workroom's data. Fail-closed if absent. */
export interface ExplanationProvenance {
  viewerId: string;
  workroomId: string;
  /** Must be true — set ONLY after the caller ran the control-plane authorize-then-redact path. */
  authorized: boolean;
}

export interface ExplanationStateInput {
  kind: ExplanationKind;
  /** Structured, low-sensitivity fields the LLM may explain. Free-text values are redacted. */
  fields: Record<string, string | null | undefined>;
  provenance: ExplanationProvenance;
}

export interface RedactedPromptInput {
  kind: ExplanationKind;
  fields: Record<string, string | null>;
}

export interface ExplanationResult {
  explanation_text: string;
  is_fallback: boolean;
  generated_at: string;
}

export interface LLMProvider {
  /** Generate short explanation text for an ALREADY-redacted structured prompt. */
  generate(promptInput: RedactedPromptInput, opts: { timeoutMs: number }): Promise<string>;
}

export class ExplanationBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExplanationBoundaryError';
  }
}

/**
 * Secret-shaped patterns that must NEVER appear in LLM output. Mirrors redactControlText's classes
 * (token prefixes, 64-hex, PEM, daemon secret paths). Used to DISTRUST the whole output, not just
 * scrub it: an explanation LLM never receives raw secrets, so emitting one means hallucination or a
 * successful injection — discard and fall back.
 */
const SECRET_SHAPE_RE = new RegExp(
  [
    'op_sess_[A-Za-z0-9\\-_]+',
    'dev_ctl_[A-Za-z0-9\\-_]+',
    'act_tok_[A-Za-z0-9\\-_]+',
    '(?<![A-Fa-f0-9])[A-Fa-f0-9]{64}(?![A-Fa-f0-9])',
    '-----BEGIN [A-Z ]+-----',
    '/tmp/mio-[^\\s"\',\\]]+',
    '/var/folders/[^\\s"\',\\]]*?/T/mio-[^\\s"\',\\]]+',
    // #166 banned: a full pairing deeplink (carries a one-time code) must never appear in output.
    'codelight://[^\\s]+',
  ].join('|'),
);

/** Build a redacted prompt input. FAIL CLOSED on missing/unauthorized provenance. */
export function buildRedactedPromptInput(state: ExplanationStateInput): RedactedPromptInput {
  const p = state.provenance;
  if (!p || p.authorized !== true || !p.viewerId || !p.workroomId) {
    throw new ExplanationBoundaryError('missing or unauthorized provenance — refusing to build prompt');
  }
  const fields: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(state.fields)) {
    fields[k] = redactControlText(v ?? null);
  }
  return { kind: state.kind, fields };
}

/**
 * Sanitize LLM output. Returns the redacted text plus whether the RAW output contained a
 * secret-shaped string (caller should fall back if hadLeak is true).
 */
export function sanitizeExplanationOutput(raw: string): { text: string; hadLeak: boolean } {
  const hadLeak = SECRET_SHAPE_RE.test(raw);
  return { text: redactControlText(raw), hadLeak };
}

export interface GenerateExplanationOpts {
  state: ExplanationStateInput;
  /** null = no provider configured → deterministic fallback. */
  provider: LLMProvider | null;
  /** Always-available deterministic explanation; used whenever the LLM path is unavailable/unsafe. */
  deterministicFallback: (state: ExplanationStateInput) => string;
  /** Org/workroom feature flag. Default off → caller passes false. */
  featureEnabled: boolean;
  timeoutMs?: number;
}

/**
 * Produce an explanation, never throwing. Falls back to deterministic text on: unauthorized
 * provenance, feature off, no provider, provider error/timeout, empty output, or any secret-shaped
 * residue in the output.
 */
export async function generateExplanation(opts: GenerateExplanationOpts): Promise<ExplanationResult> {
  const fallback = (): ExplanationResult => ({
    explanation_text: opts.deterministicFallback(opts.state),
    is_fallback: true,
    generated_at: new Date().toISOString(),
  });

  // Boundary first: build redacted input (fail-closed). If unauthorized, never call the LLM.
  let promptInput: RedactedPromptInput;
  try {
    promptInput = buildRedactedPromptInput(opts.state);
  } catch {
    return fallback();
  }

  if (!opts.featureEnabled || !opts.provider) return fallback();

  let raw: string;
  try {
    raw = await opts.provider.generate(promptInput, { timeoutMs: opts.timeoutMs ?? 8000 });
  } catch {
    return fallback();
  }

  const { text, hadLeak } = sanitizeExplanationOutput(raw);
  if (hadLeak || text.trim() === '') return fallback();
  return { explanation_text: text, is_fallback: false, generated_at: new Date().toISOString() };
}
