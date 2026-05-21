/**
 * Artifact three-state milestone — unit tests.
 *
 * Verifies:
 * 1. Milestones are one-way (cannot be cleared once set)
 * 2. Milestones are idempotent (setting an already-set milestone is a no-op)
 * 3. Status transitions are correct: created → verified → external_confirmed → accepted
 * 4. Milestones are independent (can be set in any order)
 * 5. verify milestone only advances when verification status is 'passed'
 * 6. Coinbyte fixture: verificationLog captures method + evidence (archive vs IPA)
 */
import { describe, it, expect } from 'vitest';

// ── Types ─────────────────────────────────────────────────────────────────────

interface SimArtifact {
  id: string;
  status: string;
  verifiedAt: Date | null;
  externalConfirmedAt: Date | null;
  humanAckedAt: Date | null;
}

type VerificationStatus = 'passed' | 'failed' | 'inconclusive';

interface SimVerificationLog {
  log_id: string;
  artifact_id: string;
  verifier_agent_id: string;
  method: string;
  status: VerificationStatus;
  evidence: Record<string, unknown>;
  error?: string;
  client_idempotency_key: string;
  created_at: Date;
}

// ── Status derivation (mirrors deriveArtifactStatus in production code) ───────

function deriveArtifactStatus(
  verifiedAt: Date | null,
  externalConfirmedAt: Date | null,
  humanAckedAt: Date | null,
): string {
  if (humanAckedAt) return 'accepted';
  if (externalConfirmedAt) return 'external_confirmed';
  if (verifiedAt) return 'verified';
  return 'created';
}

// ── Milestone simulators ───────────────────────────────────────────────────────

type VerifyResult =
  | { ok: true; verified_at: Date; idempotent: boolean; log_id: string; artifact_status: string }
  | { ok: false; code: string };

function simulateVerify(
  artifact: SimArtifact,
  logs: SimVerificationLog[],
  params: { verifier_agent_id: string; method: string; status: VerificationStatus; evidence: Record<string, unknown>; client_idempotency_key: string; error?: string },
  now: Date = new Date(),
): VerifyResult {
  // Idempotent log: same client_idempotency_key → return existing log ID
  const existingLog = logs.find((l) => l.client_idempotency_key === params.client_idempotency_key);
  const logId = existingLog
    ? existingLog.log_id
    : (() => {
        const newLog: SimVerificationLog = {
          log_id: `log-${logs.length + 1}`,
          artifact_id: artifact.id,
          verifier_agent_id: params.verifier_agent_id,
          method: params.method,
          status: params.status,
          evidence: params.evidence,
          error: params.error,
          client_idempotency_key: params.client_idempotency_key,
          created_at: now,
        };
        logs.push(newLog);
        return newLog.log_id;
      })();

  const alreadyVerified = artifact.verifiedAt !== null;

  // Only advance milestone if verification passed and not already set
  if (!alreadyVerified && params.status === 'passed') {
    artifact.verifiedAt = now;
    artifact.status = deriveArtifactStatus(now, artifact.externalConfirmedAt, artifact.humanAckedAt);
  }

  return {
    ok: true,
    verified_at: artifact.verifiedAt!,
    idempotent: alreadyVerified,
    log_id: logId,
    artifact_status: artifact.status,
  };
}

function simulateConfirm(artifact: SimArtifact, now: Date = new Date()): { idempotent: boolean; confirmed_at: Date } {
  if (artifact.externalConfirmedAt !== null) {
    return { idempotent: true, confirmed_at: artifact.externalConfirmedAt };
  }
  artifact.externalConfirmedAt = now;
  artifact.status = deriveArtifactStatus(artifact.verifiedAt, now, artifact.humanAckedAt);
  return { idempotent: false, confirmed_at: now };
}

function simulateAck(artifact: SimArtifact, now: Date = new Date()): { idempotent: boolean; acked_at: Date } {
  if (artifact.humanAckedAt !== null) {
    return { idempotent: true, acked_at: artifact.humanAckedAt };
  }
  artifact.humanAckedAt = now;
  artifact.status = 'accepted';
  return { idempotent: false, acked_at: now };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Artifact status derivation', () => {
  it('created: no milestones set', () => {
    expect(deriveArtifactStatus(null, null, null)).toBe('created');
  });
  it('verified: only verifiedAt set', () => {
    expect(deriveArtifactStatus(new Date(), null, null)).toBe('verified');
  });
  it('external_confirmed: verifiedAt + externalConfirmedAt', () => {
    expect(deriveArtifactStatus(new Date(), new Date(), null)).toBe('external_confirmed');
  });
  it('external_confirmed: externalConfirmedAt without verifiedAt (independent)', () => {
    expect(deriveArtifactStatus(null, new Date(), null)).toBe('external_confirmed');
  });
  it('accepted: humanAckedAt set (overrides all)', () => {
    expect(deriveArtifactStatus(null, null, new Date())).toBe('accepted');
  });
  it('accepted: all three milestones set', () => {
    expect(deriveArtifactStatus(new Date(), new Date(), new Date())).toBe('accepted');
  });
});

describe('Milestone 1 — verify (agent)', () => {
  const makeArtifact = (): SimArtifact => ({
    id: 'art-1', status: 'created',
    verifiedAt: null, externalConfirmedAt: null, humanAckedAt: null,
  });

  it('sets verifiedAt and advances status on first verify (passed)', () => {
    const artifact = makeArtifact();
    const logs: SimVerificationLog[] = [];
    const result = simulateVerify(artifact, logs, {
      verifier_agent_id: 'agent-1', method: 'ipa_inspect',
      status: 'passed', evidence: { ipa_version: '1.4.1' }, client_idempotency_key: 'k1',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.idempotent).toBe(false);
      expect(result.artifact_status).toBe('verified');
      expect(artifact.verifiedAt).not.toBeNull();
    }
  });

  it('does NOT set verifiedAt when verification status is failed', () => {
    const artifact = makeArtifact();
    simulateVerify(artifact, [], {
      verifier_agent_id: 'agent-1', method: 'ipa_inspect',
      status: 'failed', evidence: {}, client_idempotency_key: 'k-fail',
      error: 'MinimumOSVersion missing',
    });
    expect(artifact.verifiedAt).toBeNull();
    expect(artifact.status).toBe('created');
  });

  it('does NOT set verifiedAt when status is inconclusive', () => {
    const artifact = makeArtifact();
    simulateVerify(artifact, [], {
      verifier_agent_id: 'agent-1', method: 'app_store_check',
      status: 'inconclusive', evidence: {}, client_idempotency_key: 'k-inc',
    });
    expect(artifact.verifiedAt).toBeNull();
  });

  it('idempotent: second verify returns existing verifiedAt', () => {
    const artifact = makeArtifact();
    const logs: SimVerificationLog[] = [];
    const t1 = new Date('2026-05-21T09:00:00Z');
    simulateVerify(artifact, logs, {
      verifier_agent_id: 'agent-1', method: 'ipa_inspect',
      status: 'passed', evidence: {}, client_idempotency_key: 'k2',
    }, t1);

    const t2 = new Date('2026-05-21T10:00:00Z');
    const result2 = simulateVerify(artifact, logs, {
      verifier_agent_id: 'agent-1', method: 'ipa_inspect',
      status: 'passed', evidence: {}, client_idempotency_key: 'k3',  // new log key
    }, t2);

    if (result2.ok) {
      expect(result2.idempotent).toBe(true);
      expect(result2.verified_at.toISOString()).toBe(t1.toISOString());  // unchanged
    }
  });

  it('creates a new log entry for each verification attempt (same artifact, different log keys)', () => {
    const artifact = makeArtifact();
    const logs: SimVerificationLog[] = [];
    simulateVerify(artifact, logs, { verifier_agent_id: 'a', method: 'ipa_inspect', status: 'failed', evidence: {}, client_idempotency_key: 'attempt-1' });
    simulateVerify(artifact, logs, { verifier_agent_id: 'a', method: 'ipa_inspect', status: 'passed', evidence: { fixed: true }, client_idempotency_key: 'attempt-2' });
    expect(logs.length).toBe(2);
    expect(logs[0].status).toBe('failed');
    expect(logs[1].status).toBe('passed');
  });

  it('Coinbyte fixture: log captures method = ipa_inspect (not archive)', () => {
    // Fixture: "verified archive not IPA → VerificationLog must bind final artifact"
    // The method field distinguishes what was actually checked.
    const artifact = makeArtifact();
    const logs: SimVerificationLog[] = [];
    simulateVerify(artifact, logs, {
      verifier_agent_id: 'agent-build', method: 'archive',  // WRONG: checked archive
      status: 'passed', evidence: { path: 'app.xcarchive' }, client_idempotency_key: 'wrong-check',
    });
    simulateVerify(artifact, logs, {
      verifier_agent_id: 'agent-build', method: 'ipa_inspect',  // CORRECT: checked IPA
      status: 'passed', evidence: { path: 'app.ipa', ipa_size_bytes: 45000000 }, client_idempotency_key: 'correct-check',
    });
    // Both logs are stored — the audit trail shows what was checked each time
    expect(logs[0].method).toBe('archive');
    expect(logs[1].method).toBe('ipa_inspect');
    expect(logs[1].evidence).toMatchObject({ path: 'app.ipa' });
  });
});

describe('Milestone 2 — external confirm', () => {
  const makeArtifact = (verifiedAt: Date | null = null): SimArtifact => ({
    id: 'art-2', status: verifiedAt ? 'verified' : 'created',
    verifiedAt, externalConfirmedAt: null, humanAckedAt: null,
  });

  it('sets externalConfirmedAt on first confirm', () => {
    const artifact = makeArtifact(new Date());
    const result = simulateConfirm(artifact);
    expect(result.idempotent).toBe(false);
    expect(artifact.externalConfirmedAt).not.toBeNull();
    expect(artifact.status).toBe('external_confirmed');
  });

  it('idempotent: second confirm returns existing externalConfirmedAt', () => {
    const artifact = makeArtifact();
    const t1 = new Date('2026-05-21T09:00:00Z');
    simulateConfirm(artifact, t1);
    const t2 = new Date('2026-05-21T10:00:00Z');
    const result = simulateConfirm(artifact, t2);
    expect(result.idempotent).toBe(true);
    expect(result.confirmed_at.toISOString()).toBe(t1.toISOString());
  });

  it('can be set independently without verifiedAt (external system may confirm before agent)', () => {
    const artifact = makeArtifact(null);  // no verifiedAt
    simulateConfirm(artifact);
    expect(artifact.externalConfirmedAt).not.toBeNull();
    expect(artifact.status).toBe('external_confirmed');
  });

  it('Coinbyte fixture: altool upload confirmed ≠ Apple processed (both external events)', () => {
    // Fixture: altool upload ≠ Apple processed ≠ TestFlight visible → Artifact 3-state
    // Confirm represents "Apple processed" (not "altool upload started").
    const artifact = makeArtifact(new Date());
    expect(artifact.externalConfirmedAt).toBeNull();  // upload started but not Apple-processed yet
    simulateConfirm(artifact);  // Apple processing confirmed
    expect(artifact.status).toBe('external_confirmed');
  });
});

describe('Milestone 3 — human ack', () => {
  const makeArtifact = (): SimArtifact => ({
    id: 'art-3', status: 'external_confirmed',
    verifiedAt: new Date(), externalConfirmedAt: new Date(), humanAckedAt: null,
  });

  it('sets humanAckedAt and status=accepted', () => {
    const artifact = makeArtifact();
    const result = simulateAck(artifact);
    expect(result.idempotent).toBe(false);
    expect(artifact.humanAckedAt).not.toBeNull();
    expect(artifact.status).toBe('accepted');
  });

  it('idempotent: second ack returns existing humanAckedAt', () => {
    const artifact = makeArtifact();
    const t1 = new Date('2026-05-21T11:00:00Z');
    simulateAck(artifact, t1);
    const result = simulateAck(artifact, new Date());
    expect(result.idempotent).toBe(true);
    expect(result.acked_at.toISOString()).toBe(t1.toISOString());
  });

  it('accepted status cannot be downgraded by any milestone operation', () => {
    const artifact = makeArtifact();
    simulateAck(artifact);
    expect(artifact.status).toBe('accepted');
    // Simulating another confirm should not change status
    simulateConfirm(artifact, new Date());
    // humanAckedAt still wins — deriveArtifactStatus returns 'accepted' when humanAckedAt set
    expect(artifact.status).toBe('accepted');
  });
});

describe('Milestone independence — any order is valid', () => {
  it('confirm before verify is allowed', () => {
    const artifact: SimArtifact = { id: 'a', status: 'created', verifiedAt: null, externalConfirmedAt: null, humanAckedAt: null };
    simulateConfirm(artifact);
    expect(artifact.status).toBe('external_confirmed');
    const logs: SimVerificationLog[] = [];
    simulateVerify(artifact, logs, { verifier_agent_id: 'x', method: 'hash_compare', status: 'passed', evidence: {}, client_idempotency_key: 'v1' });
    // Status: humanAckedAt=null, externalConfirmedAt set, verifiedAt set → 'external_confirmed'
    expect(artifact.status).toBe('external_confirmed');
  });

  it('ack before verify and confirm is allowed (human decided independently)', () => {
    const artifact: SimArtifact = { id: 'b', status: 'created', verifiedAt: null, externalConfirmedAt: null, humanAckedAt: null };
    simulateAck(artifact);
    expect(artifact.status).toBe('accepted');
    // Later: agent verifies, but status stays 'accepted' (humanAckedAt wins)
    const logs: SimVerificationLog[] = [];
    simulateVerify(artifact, logs, { verifier_agent_id: 'x', method: 'hash_compare', status: 'passed', evidence: {}, client_idempotency_key: 'v2' });
    expect(artifact.status).toBe('accepted');
  });
});
