/**
 * #86 operator_session mint/revoke — REAL Postgres integration tests.
 * Run with: npm run test:db:setup && npm run test:integration
 * Excluded from default `npm test` (no DB there).
 *
 * Mirrors the #32 dev-token security posture: only the SHA-256 hash is stored, raw token shown once,
 * workroom/org validation, bounded TTL, V1 command allow-list (fail-closed on approve/retry), revoke.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomUUID } from 'crypto';
import { db } from '@/storage/db';
import {
  mintOperatorSession,
  revokeOperatorSession,
  OperatorSessionMintError,
  OPERATOR_SESSION_MAX_TTL_HOURS,
} from './operatorSessionMint.js';

const ORG_ID = randomUUID();
const OTHER_ORG_ID = randomUUID();
const WORKROOM_ID = randomUUID();
const SUBJECT = 'operator-subject-opaque-1';
const ISSUED_BY = 'cli:test-runner';

beforeAll(async () => {
  await db.controlOrg.create({ data: { id: ORG_ID, name: 'OpSess Org', slug: `opsess-${randomUUID()}`, ownerUserId: randomUUID() } });
  await db.controlOrg.create({ data: { id: OTHER_ORG_ID, name: 'OpSess Other Org', slug: `opsess-${randomUUID()}`, ownerUserId: randomUUID() } });
  await db.controlWorkroom.create({ data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'OpSess Workroom', createdBy: randomUUID() } });
});

afterAll(async () => {
  await db.controlOperatorSession.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlWorkroom.deleteMany({ where: { id: WORKROOM_ID } });
  await db.controlOrg.deleteMany({ where: { id: { in: [ORG_ID, OTHER_ORG_ID] } } });
  await db.$disconnect();
});

describe('#86 mintOperatorSession — real DB', () => {
  it('mints an op_sess_ token, stores only the sha256 hash (never raw), default V1 commands', async () => {
    const r = await mintOperatorSession({ orgId: ORG_ID, workroomId: WORKROOM_ID, operatorSubjectId: SUBJECT, issuedBy: ISSUED_BY });
    expect(r.rawToken.startsWith('op_sess_')).toBe(true);
    expect(r.allowedCommands).toEqual(['acknowledge_needs_human', 'mark_reviewed']);

    const row = await db.controlOperatorSession.findUnique({ where: { id: r.id } });
    expect(row).not.toBeNull();
    // Only the hash is stored — raw token must NOT appear anywhere on the row.
    expect(row!.tokenHash).toBe(createHash('sha256').update(r.rawToken).digest('hex'));
    expect(JSON.stringify(row)).not.toContain(r.rawToken);
    expect(row!.operatorSubjectId).toBe(SUBJECT);
    expect(row!.issuedBy).toBe(ISSUED_BY);
    expect(row!.revokedAt).toBeNull();
  });

  it('fail-closed: requesting approve/retry (not in V1 allow-list) throws, mints nothing', async () => {
    await expect(
      mintOperatorSession({ orgId: ORG_ID, workroomId: WORKROOM_ID, operatorSubjectId: SUBJECT, issuedBy: ISSUED_BY, allowedCommands: ['approve'] }),
    ).rejects.toBeInstanceOf(OperatorSessionMintError);
    await expect(
      mintOperatorSession({ orgId: ORG_ID, workroomId: WORKROOM_ID, operatorSubjectId: SUBJECT, issuedBy: ISSUED_BY, allowedCommands: ['mark_reviewed', 'retry'] }),
    ).rejects.toThrow(/not allowed in V1/);
  });

  it('rejects workroom/org mismatch and non-existent workroom', async () => {
    await expect(
      mintOperatorSession({ orgId: OTHER_ORG_ID, workroomId: WORKROOM_ID, operatorSubjectId: SUBJECT, issuedBy: ISSUED_BY }),
    ).rejects.toThrow(/orgId mismatch/);
    await expect(
      mintOperatorSession({ orgId: ORG_ID, workroomId: randomUUID(), operatorSubjectId: SUBJECT, issuedBy: ISSUED_BY }),
    ).rejects.toThrow(/workroom not found/);
  });

  it('rejects out-of-range TTL', async () => {
    await expect(
      mintOperatorSession({ orgId: ORG_ID, workroomId: WORKROOM_ID, operatorSubjectId: SUBJECT, issuedBy: ISSUED_BY, ttlHours: OPERATOR_SESSION_MAX_TTL_HOURS + 1 }),
    ).rejects.toThrow(/ttlHours/);
    await expect(
      mintOperatorSession({ orgId: ORG_ID, workroomId: WORKROOM_ID, operatorSubjectId: SUBJECT, issuedBy: ISSUED_BY, ttlHours: 0 }),
    ).rejects.toThrow(/ttlHours/);
  });

  it('revoke sets revoked_at; second revoke is idempotent-false', async () => {
    const r = await mintOperatorSession({ orgId: ORG_ID, workroomId: WORKROOM_ID, operatorSubjectId: SUBJECT, issuedBy: ISSUED_BY });
    expect(await revokeOperatorSession(r.id)).toBe(true);
    const row = await db.controlOperatorSession.findUnique({ where: { id: r.id } });
    expect(row!.revokedAt).not.toBeNull();
    // Already revoked → no-op (false).
    expect(await revokeOperatorSession(r.id)).toBe(false);
  });
});
