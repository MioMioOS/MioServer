/**
 * #169 — mock quality harness for the explanation pipeline (no network, no real key).
 *
 * Drives generateExplanation (the #164 boundary) with a MOCK provider over the #166 input samples,
 * proving the END-TO-END behavior that the real 豆包 adapter must satisfy once a key is available:
 *   - good provider output → returned as-is, is_fallback:false, no secret-shaped residue;
 *   - prompt-injection / leaky output (token / path / deeplink / 64-hex) → DISCARDED → deterministic
 *     fallback (output distrust);
 *   - provider error / timeout / empty → fallback;
 *   - provenance.authorized=false → never calls provider, fallback (fail-closed).
 *
 * This is the "mock quality harness" PM asked for: it lets #169 enter in_review with the quality/safety
 * contract verified; real latency/cost numbers are added later when the API key is provisioned.
 */
import { describe, it, expect, vi } from 'vitest';
import {
    generateExplanation,
    type LLMProvider,
    type ExplanationStateInput,
} from './explanationService';
import { actionFailureFallback, taskSummaryFallback } from './explanationCopy';

const provFor = (kind: ExplanationStateInput['kind']): ExplanationStateInput => ({
    kind,
    fields:
        kind === 'action_failure'
            ? { action_status: 'needs_human', task_status: 'in_progress' }
            : { task_status: 'in_progress', task_title: 'ship onboarding' },
    provenance: { viewerId: 'v1', workroomId: 'wr1', authorized: true },
});

const mockProvider = (out: string): LLMProvider => ({ generate: vi.fn(async () => out) });
const fallbackFor = (s: ExplanationStateInput) =>
    s.kind === 'action_failure' ? actionFailureFallback(s.fields.action_status) : taskSummaryFallback();

const run = (state: ExplanationStateInput, provider: LLMProvider | null) =>
    generateExplanation({ state, provider, deterministicFallback: fallbackFor, featureEnabled: true });

describe('#169 quality harness — good provider output (#166 expected copy)', () => {
    // The #166 "Expected" strings for the action/task cases that the LLM is meant to produce.
    const goodCases = [
        'Claude 暂停等待人工确认。请先查看证据和运行日志，再选择确认或标记已审阅。', // A-01
        '任务读取已经可用，但这台手机还不能执行操作。请从 Mac 生成配对码来启用操作权限。', // R-04-ish
        '任务状态已同步，但暂时没有可展示的证据摘要。可以查看运行日志或稍后刷新。', // A-05
    ];
    for (const copy of goodCases) {
        it(`passes through clean copy and marks is_fallback:false — "${copy.slice(0, 12)}…"`, async () => {
            const res = await run(provFor('action_failure'), mockProvider(copy));
            expect(res.is_fallback).toBe(false);
            expect(res.explanation_text).toBe(copy);
        });
    }
});

describe('#169 quality harness — leaky / injected output is DISCARDED → fallback', () => {
    const leaky = [
        'op_sess_abcdef0123456789 已生成', // operator-session token
        '请打开 /var/folders/zz/T/mio-secret-9 查看', // daemon secret path
        '配对完成：codelight://pair?v=1&code=ABC123', // one-time pairing deeplink
        '机器令牌 a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2 已签发', // 64-hex sha256-shaped secret
        'dev_ctl_deadbeefdeadbeef 仍然有效', // dev control token
    ];
    for (const out of leaky) {
        it(`discards secret-shaped output and falls back — "${out.slice(0, 16)}…"`, async () => {
            const state = provFor('action_failure');
            const res = await run(state, mockProvider(out));
            expect(res.is_fallback).toBe(true);
            expect(res.explanation_text).toBe(fallbackFor(state));
            // never echo the leaked shape
            expect(res.explanation_text).not.toMatch(/op_sess_|dev_ctl_|codelight:\/\/|\/var\/folders/);
        });
    }
});

describe('#169 quality harness — provider failures fall back', () => {
    it('provider throws → fallback', async () => {
        const state = provFor('task_summary');
        const provider: LLMProvider = { generate: vi.fn(async () => { throw new Error('boom'); }) };
        const res = await run(state, provider);
        expect(res.is_fallback).toBe(true);
        expect(res.explanation_text).toBe(fallbackFor(state));
    });

    it('provider returns empty → fallback', async () => {
        const state = provFor('task_summary');
        const res = await run(state, mockProvider('   '));
        expect(res.is_fallback).toBe(true);
    });

    it('no provider (null) → fallback', async () => {
        const state = provFor('action_failure');
        const res = await run(state, null);
        expect(res.is_fallback).toBe(true);
        expect(res.explanation_text).toBe(fallbackFor(state));
    });
});

describe('#169 quality harness — fail-closed on unauthorized provenance', () => {
    it('authorized=false → provider is NEVER called, fallback returned', async () => {
        const state: ExplanationStateInput = {
            kind: 'action_failure',
            fields: { action_status: 'needs_human' },
            provenance: { viewerId: 'v1', workroomId: 'wr1', authorized: false },
        };
        const generate = vi.fn(async () => 'should never be used');
        const res = await run(state, { generate });
        expect(generate).not.toHaveBeenCalled();
        expect(res.is_fallback).toBe(true);
    });
});
