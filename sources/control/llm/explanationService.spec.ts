/**
 * #162/#164 — explanation security base unit tests.
 * Locks the boundary: authorize-before-build (fail-closed), input redaction, provider
 * orchestration with fallback, output distrust on secret-shaped residue. No DB, no network.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  buildRedactedPromptInput,
  sanitizeExplanationOutput,
  generateExplanation,
  ExplanationBoundaryError,
  type ExplanationStateInput,
  type LLMProvider,
} from './explanationService';

const authorized = (fields: Record<string, string | null | undefined>): ExplanationStateInput => ({
  kind: 'readiness',
  fields,
  provenance: { viewerId: 'v1', workroomId: 'wr1', authorized: true },
});

const deterministic = () => 'Read access expired; operator access ready.';

function spyProvider(returns: string): { provider: LLMProvider; calls: { kind: string; fields: Record<string, string | null> }[] } {
  const calls: { kind: string; fields: Record<string, string | null> }[] = [];
  const provider: LLMProvider = {
    generate: async (p) => { calls.push({ kind: p.kind, fields: p.fields }); return returns; },
  };
  return { provider, calls };
}

describe('#164 buildRedactedPromptInput', () => {
  it('FAILS CLOSED on missing/unauthorized provenance', () => {
    expect(() => buildRedactedPromptInput({ kind: 'readiness', fields: {}, provenance: { viewerId: '', workroomId: 'wr', authorized: true } })).toThrow(ExplanationBoundaryError);
    expect(() => buildRedactedPromptInput({ kind: 'readiness', fields: {}, provenance: { viewerId: 'v', workroomId: 'wr', authorized: false } })).toThrow(ExplanationBoundaryError);
    // @ts-expect-error intentionally missing provenance
    expect(() => buildRedactedPromptInput({ kind: 'readiness', fields: {} })).toThrow(ExplanationBoundaryError);
  });

  it('redacts free-text fields before they can reach the provider', () => {
    const out = buildRedactedPromptInput(authorized({
      summary: 'rotated dev_ctl_ABC123_xyz and cleared /var/folders/zz/T/mio-secret-x',
      status: 'needs_human',
      empty: null,
    }));
    expect(out.fields.summary).not.toMatch(/dev_ctl_/);
    expect(out.fields.summary).not.toMatch(/\/var\/folders/);
    expect(out.fields.summary).toContain('[REDACTED]');
    expect(out.fields.status).toBe('needs_human'); // clean field untouched
    expect(out.fields.empty).toBeNull();
  });
});

describe('#164 sanitizeExplanationOutput', () => {
  it('clean text → hadLeak false, unchanged', () => {
    const r = sanitizeExplanationOutput('读取令牌已失效，操作权限已就绪。');
    expect(r.hadLeak).toBe(false);
    expect(r.text).toBe('读取令牌已失效，操作权限已就绪。');
  });
  it('secret-shaped output → hadLeak true (token / path / deeplink)', () => {
    expect(sanitizeExplanationOutput('your token is op_sess_AAaa-_11').hadLeak).toBe(true);
    expect(sanitizeExplanationOutput('see /tmp/mio-secret-x').hadLeak).toBe(true);
    expect(sanitizeExplanationOutput('codelight://pair?code=abc123XYZ').hadLeak).toBe(true);
    expect(sanitizeExplanationOutput('hash ' + 'a'.repeat(64)).hadLeak).toBe(true);
  });
});

describe('#164 generateExplanation', () => {
  it('unauthorized provenance → deterministic fallback, provider NOT called', async () => {
    const { provider, calls } = spyProvider('llm text');
    const r = await generateExplanation({
      state: { kind: 'readiness', fields: {}, provenance: { viewerId: 'v', workroomId: 'wr', authorized: false } },
      provider, deterministicFallback: deterministic, featureEnabled: true,
    });
    expect(r.is_fallback).toBe(true);
    expect(r.explanation_text).toBe(deterministic());
    expect(calls.length).toBe(0); // never called the LLM
  });

  it('feature off → fallback, provider NOT called', async () => {
    const { provider, calls } = spyProvider('llm text');
    const r = await generateExplanation({ state: authorized({ a: 'b' }), provider, deterministicFallback: deterministic, featureEnabled: false });
    expect(r.is_fallback).toBe(true);
    expect(calls.length).toBe(0);
  });

  it('no provider → fallback', async () => {
    const r = await generateExplanation({ state: authorized({ a: 'b' }), provider: null, deterministicFallback: deterministic, featureEnabled: true });
    expect(r.is_fallback).toBe(true);
  });

  it('provider throws/times out → fallback', async () => {
    const provider: LLMProvider = { generate: async () => { throw new Error('timeout'); } };
    const r = await generateExplanation({ state: authorized({ a: 'b' }), provider, deterministicFallback: deterministic, featureEnabled: true });
    expect(r.is_fallback).toBe(true);
    expect(r.explanation_text).toBe(deterministic());
  });

  it('clean provider output → used, is_fallback false, and input was redacted', async () => {
    const { provider, calls } = spyProvider('读取令牌已失效，请在 Mac 上重新配对。');
    const r = await generateExplanation({
      state: authorized({ summary: 'token dev_ctl_LEAKabc to explain' }),
      provider, deterministicFallback: deterministic, featureEnabled: true,
    });
    expect(r.is_fallback).toBe(false);
    expect(r.explanation_text).toContain('读取令牌');
    // the provider received a REDACTED input (no raw token reached the LLM)
    expect(calls[0].fields.summary).not.toMatch(/dev_ctl_/);
    expect(calls[0].fields.summary).toContain('[REDACTED]');
  });

  it('provider output with a secret-shape → DISTRUST whole output → fallback', async () => {
    const { provider } = spyProvider('your op_sess_HACKED-_token is ready');
    const r = await generateExplanation({ state: authorized({ a: 'b' }), provider, deterministicFallback: deterministic, featureEnabled: true });
    expect(r.is_fallback).toBe(true);
    expect(r.explanation_text).toBe(deterministic());
  });

  it('empty provider output → fallback', async () => {
    const { provider } = spyProvider('   ');
    const r = await generateExplanation({ state: authorized({ a: 'b' }), provider, deterministicFallback: deterministic, featureEnabled: true });
    expect(r.is_fallback).toBe(true);
  });
});
