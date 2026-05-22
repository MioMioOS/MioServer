import { describe, it, expect } from 'vitest';
import { buildReadOnlyDemoCapabilities } from './buildReadOnlyDemoCapabilities.js';

const ACTION = { updatedAt: new Date('2026-05-22T03:00:00.000Z') };
const NOW = new Date('2026-05-22T04:30:00.000Z');

describe('buildReadOnlyDemoCapabilities', () => {
  it('mode is read_only_demo', () => {
    expect(buildReadOnlyDemoCapabilities(ACTION, NOW).mode).toBe('read_only_demo');
  });

  it('capability_version (now) and action_version (action.updatedAt) are distinct fields', () => {
    const caps = buildReadOnlyDemoCapabilities(ACTION, NOW);
    expect(caps.capability_version).toBe(NOW.toISOString());
    expect(caps.action_version).toBe(ACTION.updatedAt.toISOString());
    expect(caps.capability_version).not.toBe(caps.action_version); // never merged into one marker
  });

  it('all write commands disabled with reason read_only_session', () => {
    const { commands } = buildReadOnlyDemoCapabilities(ACTION, NOW);
    for (const key of ['acknowledge_needs_human', 'mark_reviewed', 'approve', 'retry'] as const) {
      expect(commands[key]?.enabled, key).toBe(false);
      expect(commands[key]?.reason, key).toBe('read_only_session');
    }
  });

  it('open_evidence is enabled (read capability, no operator_session required) with no reason', () => {
    const { commands } = buildReadOnlyDemoCapabilities(ACTION, NOW);
    expect(commands.open_evidence?.enabled).toBe(true);
    expect(commands.open_evidence?.reason).toBeUndefined();
  });

  it('confirmation levels match the contract (ack=none, mark_reviewed/approve=standard, retry=high)', () => {
    const { commands } = buildReadOnlyDemoCapabilities(ACTION, NOW);
    expect(commands.acknowledge_needs_human?.confirmation_level).toBe('none');
    expect(commands.acknowledge_needs_human?.requires_confirmation).toBe(false);
    expect(commands.mark_reviewed?.confirmation_level).toBe('standard');
    expect(commands.approve?.confirmation_level).toBe('standard');
    expect(commands.retry?.confirmation_level).toBe('high');
    expect(commands.retry?.requires_confirmation).toBe(true);
  });

  it('only V1 command keys are present (no force_complete / mark_succeeded etc.)', () => {
    const { commands } = buildReadOnlyDemoCapabilities(ACTION, NOW);
    expect(Object.keys(commands).sort()).toEqual(
      ['acknowledge_needs_human', 'approve', 'mark_reviewed', 'open_evidence', 'retry'].sort(),
    );
  });

  it('no-leak: serialized block carries only controlled enums + ISO timestamps (no secrets/paths)', () => {
    const json = JSON.stringify(buildReadOnlyDemoCapabilities(ACTION, NOW));
    expect(json).not.toMatch(/dev_ctl_|op_sess_|act_tok_|storage_ref|\/var\/folders|BEGIN [A-Z ]*PRIVATE KEY/);
  });
});
