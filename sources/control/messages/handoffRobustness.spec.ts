import { describe, it, expect } from 'vitest';
import { matchMentionGroups } from './messageRoutes';
import { computeMentionWake } from './finalizeMentionWake';
import type { AgentReachability } from '@/control/agents/agentLiveness';

const g = (label: string, ...agentIds: string[]) => ({ label, agentIds, userIds: [] as string[] });
const ug = (label: string, ...userIds: string[]) => ({ label, agentIds: [] as string[], userIds });

describe('matchMentionGroups — boundary-safe @mention resolution (#1)', () => {
  it('right boundary: @Backend does NOT match inside @BackendTeam', () => {
    const r = matchMentionGroups('@BackendTeam ship it', [g('Backend', 'a1'), g('BackendTeam', 'a2')]);
    expect(r.agentIds).toEqual(['a2']);
  });

  it('right boundary: a shorter label @Back does NOT match @Backend', () => {
    const r = matchMentionGroups('@Backend do X', [g('Back', 'a1'), g('Backend', 'a2')]);
    expect(r.agentIds).toEqual(['a2']);
  });

  it('exact @Back still matches its own agent', () => {
    const r = matchMentionGroups('@Back hey', [g('Back', 'a1'), g('Backend', 'a2')]);
    expect(r.agentIds).toEqual(['a1']);
  });

  it('case-insensitive', () => {
    const r = matchMentionGroups('hey @backend', [g('Backend', 'a1')]);
    expect(r.agentIds).toEqual(['a1']);
  });

  it('CJK: @UI does NOT bleed into @UI设计师', () => {
    const r = matchMentionGroups('@UI设计师 出个图', [g('UI', 'a1'), g('UI设计师', 'a2')]);
    expect(r.agentIds).toEqual(['a2']);
  });

  it('email guard: a@Backend.io is NOT a mention', () => {
    const r = matchMentionGroups('send to a@Backend.io please', [g('Backend', 'a1')]);
    expect(r.agentIds).toEqual([]);
  });

  it('same-name collision keeps BOTH candidate ids in one agentMatches group', () => {
    const r = matchMentionGroups('@Agent go', [g('Agent', 'a1', 'a2')]);
    expect(r.agentMatches).toEqual([{ label: 'Agent', ids: ['a1', 'a2'] }]);
    expect(new Set(r.agentIds)).toEqual(new Set(['a1', 'a2']));
  });

  it('resolves user labels too', () => {
    const r = matchMentionGroups('@alice hi', [ug('alice', 'u1')]);
    expect(r.userIds).toEqual(['u1']);
    expect(r.agentIds).toEqual([]);
  });
});

describe('computeMentionWake — disambiguation + offline report (#1 dup + #3)', () => {
  const reach = (m: Record<string, Partial<AgentReachability>>): Map<string, AgentReachability> =>
    new Map(Object.entries(m).map(([id, v]) => [id, { status: v.status ?? 'online', reachable: v.reachable ?? true, label: v.label ?? id }]));

  it('same-name, one live one dead → wake ONLY the live one, no offline notice', () => {
    const r = computeMentionWake([{ label: 'Agent', ids: ['live', 'dead'] }], ['live', 'dead'],
      reach({ live: { reachable: true }, dead: { reachable: false, status: 'offline' } }));
    expect(r.wakeAgentIds).toEqual(['live']);
    expect(r.offlineLabels).toEqual([]);
  });

  it('same-name, both dead → keep both (cursor catch-up) + report offline', () => {
    const r = computeMentionWake([{ label: 'Agent', ids: ['d1', 'd2'] }], ['d1', 'd2'],
      reach({ d1: { reachable: false }, d2: { reachable: false } }));
    expect(new Set(r.wakeAgentIds)).toEqual(new Set(['d1', 'd2']));
    expect(r.offlineLabels).toEqual(['Agent']);
  });

  it('solo mention, offline → wake it + report offline', () => {
    const r = computeMentionWake([{ label: 'Backend', ids: ['b'] }], ['b'],
      reach({ b: { reachable: false, label: 'Backend' } }));
    expect(r.wakeAgentIds).toEqual(['b']);
    expect(r.offlineLabels).toEqual(['Backend']);
  });

  it('solo mention, online → wake, no report', () => {
    const r = computeMentionWake([{ label: 'Backend', ids: ['b'] }], ['b'], reach({ b: { reachable: true } }));
    expect(r.wakeAgentIds).toEqual(['b']);
    expect(r.offlineLabels).toEqual([]);
  });

  it('uuid-picker mention (no label group), offline → reports via reachability label', () => {
    const r = computeMentionWake([], ['u1'], reach({ u1: { reachable: false, label: 'Frontend' } }));
    expect(r.wakeAgentIds).toEqual(['u1']);
    expect(r.offlineLabels).toEqual(['Frontend']);
  });
});
