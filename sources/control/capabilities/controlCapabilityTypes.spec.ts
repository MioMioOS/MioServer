/**
 * Slice 1 — ControlCapabilities type shape tests.
 *
 * These tests verify that:
 *   1. The TypeScript types compile and are self-consistent.
 *   2. A full read_only_demo capability block (matching the contract spec) is assignable.
 *   3. Missing optional fields and unknown reason codes are handled correctly.
 *   4. The security invariants described in the contract doc are encoded in the type structure.
 *
 * No behavior under test — this is a pure type-shape and construction test.
 */

import { describe, it, expect } from 'vitest';
import type {
  ControlCapabilities,
  ControlCapabilityCommand,
  CapabilityMode,
  CapabilityCommandKey,
  CapabilityReason,
  ConfirmationLevel,
} from './controlCapabilityTypes.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal disabled command for testing. */
function disabledCommand(reason: CapabilityReason, confirmLevel: ConfirmationLevel): ControlCapabilityCommand {
  return {
    enabled: false,
    reason,
    requires_confirmation: confirmLevel !== 'none',
    confirmation_level: confirmLevel,
  };
}

/** Build the canonical read_only_demo capabilities block from the contract spec. */
function readOnlyDemoCapabilities(actionUpdatedAt: string): ControlCapabilities {
  const now = new Date().toISOString();
  return {
    mode: 'read_only_demo',
    capability_version: now,
    action_version: actionUpdatedAt,
    commands: {
      acknowledge_needs_human: disabledCommand('read_only_session', 'none'),
      mark_reviewed: disabledCommand('read_only_session', 'standard'),
      approve: disabledCommand('approval_not_pending', 'standard'),
      retry: disabledCommand('irreversible_no_abort', 'high'),
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ControlCapabilities — type shape (Slice 1)', () => {
  it('constructs a read_only_demo block matching the contract spec', () => {
    const actionTs = '2026-05-22T00:00:00.000Z';
    const caps = readOnlyDemoCapabilities(actionTs);

    expect(caps.mode).toBe('read_only_demo');
    expect(caps.action_version).toBe(actionTs);
    expect(typeof caps.capability_version).toBe('string');
    expect(caps.capability_version.length).toBeGreaterThan(0);
  });

  it('all V1 command keys are present in the read_only_demo block', () => {
    const caps = readOnlyDemoCapabilities('2026-05-22T00:00:00.000Z');
    const keys: CapabilityCommandKey[] = [
      'acknowledge_needs_human',
      'mark_reviewed',
      'approve',
      'retry',
    ];
    for (const key of keys) {
      expect(caps.commands[key]).toBeDefined();
      expect(caps.commands[key]!.enabled).toBe(false);
    }
  });

  it('commands are Partial — missing key means unavailable (not required to exist)', () => {
    const caps: ControlCapabilities = {
      mode: 'read_only_demo',
      capability_version: new Date().toISOString(),
      action_version: new Date().toISOString(),
      commands: {},  // empty is valid — all commands unavailable
    };
    expect(caps.commands.approve).toBeUndefined();
    expect(caps.commands.retry).toBeUndefined();
  });

  it('open_evidence may be present without other commands (read capability)', () => {
    const caps: ControlCapabilities = {
      mode: 'read_only_demo',
      capability_version: new Date().toISOString(),
      action_version: new Date().toISOString(),
      commands: {
        open_evidence: {
          enabled: true,
          requires_confirmation: false,
          confirmation_level: 'none',
        },
      },
    };
    expect(caps.commands.open_evidence?.enabled).toBe(true);
    expect(caps.commands.open_evidence?.reason).toBeUndefined(); // absent when enabled
  });

  it('capability_version and action_version are separate fields (stale-write CAS)', () => {
    // They can be the same (action just updated) or different (action stale but caps refreshed).
    const actionTs = '2026-05-22T10:00:00.000Z';
    const capTs = '2026-05-22T10:05:00.000Z'; // capability generated 5 min after action update
    const caps: ControlCapabilities = {
      mode: 'operator_review',
      capability_version: capTs,
      action_version: actionTs,
      commands: {
        acknowledge_needs_human: { enabled: true, requires_confirmation: false, confirmation_level: 'none' },
      },
    };
    expect(caps.capability_version).toBe(capTs);
    expect(caps.action_version).toBe(actionTs);
    expect(caps.capability_version).not.toBe(caps.action_version);
  });

  it('all CapabilityMode values are assignable', () => {
    const modes: CapabilityMode[] = ['read_only_demo', 'operator_review', 'admin_control'];
    for (const mode of modes) {
      const caps: ControlCapabilities = {
        mode,
        capability_version: new Date().toISOString(),
        action_version: new Date().toISOString(),
        commands: {},
      };
      expect(caps.mode).toBe(mode);
    }
  });

  it('all CapabilityReason values are assignable in a disabled command', () => {
    const reasons: CapabilityReason[] = [
      'read_only_session',
      'operator_credential_required',
      'server_capability_missing',
      'approval_not_pending',
      'approval_expired',
      'action_state_changed',
      'terminal_action',
      'irreversible_no_abort',
      'retry_not_reversible',
      'credential_action_forbidden',
      'unknown',
    ];
    for (const reason of reasons) {
      const cmd = disabledCommand(reason, 'standard');
      expect(cmd.reason).toBe(reason);
      expect(cmd.enabled).toBe(false);
    }
  });

  it('confirmation levels map correctly to requires_confirmation', () => {
    const none = disabledCommand('read_only_session', 'none');
    expect(none.confirmation_level).toBe('none');
    expect(none.requires_confirmation).toBe(false); // 'none' → no confirmation

    const standard = disabledCommand('read_only_session', 'standard');
    expect(standard.confirmation_level).toBe('standard');
    expect(standard.requires_confirmation).toBe(true);

    const high = disabledCommand('irreversible_no_abort', 'high');
    expect(high.confirmation_level).toBe('high');
    expect(high.requires_confirmation).toBe(true);
  });

  it('dev_ctl_... mode maps to read_only_demo — all commands have read_only_session reason', () => {
    const caps = readOnlyDemoCapabilities('2026-05-22T00:00:00.000Z');
    const writeKeys: CapabilityCommandKey[] = [
      'acknowledge_needs_human',
      'mark_reviewed',
    ];
    for (const key of writeKeys) {
      const cmd = caps.commands[key];
      expect(cmd?.enabled).toBe(false);
      expect(cmd?.reason).toBe('read_only_session');
    }
  });
});
