/**
 * #179 — connection-credential core, REAL Postgres integration test.
 *
 * Proves mint/verify/revoke/rotate against a real DB: hash-only storage, scope rules (read base,
 * operator requires subject, no silent escalation), TTL bounds, workroom/org binding, expiry/revoke
 * → verify null, idempotent revoke, and rolling rotation (successor valid, predecessor revoked,
 * scopes carried, lineage set).
 *
 * ── Running ────────────────────────────────────────────────────────────────────
 * Requires a real Postgres test DB (db name must contain "test"). NOT part of `npm test`.
 *   1. npm run test:db:setup
 *   2. npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { db } from '@/storage/db';
import {
  mintConnectionCredential,
  verifyConnectionCredential,
  revokeConnectionCredential,
  rotateConnectionCredential,
  ConnectionCredentialError,
  CONNECTION_CREDENTIAL_PREFIX,
  CONNECTION_CREDENTIAL_MAX_TTL_DAYS,
} from './connectionCredential';

const ORG_ID = randomUUID();
const OTHER_ORG_ID = randomUUID();
const WORKROOM = randomUUID();
const OTHER_WORKROOM = randomUUID();

const bearer = (raw: string) => `Bearer ${raw}`;

beforeAll(async () => {
  await db.controlOrg.create({ data: { id: ORG_ID, name: 'Conn Org', slug: `conn-${randomUUID()}`, ownerUserId: randomUUID() } });
  await db.controlOrg.create({ data: { id: OTHER_ORG_ID, name: 'Other Org', slug: `other-${randomUUID()}`, ownerUserId: randomUUID() } });
  await db.controlWorkroom.create({ data: { id: WORKROOM, orgId: ORG_ID, name: 'WR', createdBy: randomUUID() } });
  await db.controlWorkroom.create({ data: { id: OTHER_WORKROOM, orgId: OTHER_ORG_ID, name: 'WR2', createdBy: randomUUID() } });
});

afterAll(async () => {
  await db.controlConnectionCredential.deleteMany({ where: { workroomId: { in: [WORKROOM, OTHER_WORKROOM] } } });
  await db.controlWorkroom.deleteMany({ where: { id: { in: [WORKROOM, OTHER_WORKROOM] } } });
  await db.controlOrg.deleteMany({ where: { id: { in: [ORG_ID, OTHER_ORG_ID] } } });
  await db.$disconnect();
});

describe('#179 connection credential — mint + verify', () => {
  it('mint(read) → verify roundtrip; raw has conn_ prefix; only hash stored', async () => {
    const r = await mintConnectionCredential({ orgId: ORG_ID, workroomId: WORKROOM, scopes: ['read'] });
    expect(r.rawCredential.startsWith(CONNECTION_CREDENTIAL_PREFIX)).toBe(true);
    expect(r.scopes).toEqual(['read']);

    // No-leak: the stored row holds the hash, never the raw.
    const row = await db.controlConnectionCredential.findUnique({ where: { id: r.connectionId } });
    expect(row?.credentialHash).toBeDefined();
    expect(row?.credentialHash).not.toBe(r.rawCredential);

    const v = await verifyConnectionCredential(bearer(r.rawCredential));
    expect(v).not.toBeNull();
    expect(v!.connectionId).toBe(r.connectionId);
    expect(v!.workroomId).toBe(WORKROOM);
    expect(v!.scopes).toEqual(['read']);
    expect(v!.operatorSubjectId).toBeNull();
  });

  it('mint(operator) carries operator scope + subject; read is always present', async () => {
    const r = await mintConnectionCredential({
      orgId: ORG_ID, workroomId: WORKROOM, scopes: ['operator'],
      operatorSubjectId: 'op-subject-1', allowedCommands: ['acknowledge_needs_human', 'mark_reviewed'],
    });
    expect(r.scopes).toContain('read'); // base scope auto-added
    expect(r.scopes).toContain('operator');
    const v = await verifyConnectionCredential(bearer(r.rawCredential));
    expect(v!.scopes).toContain('operator');
    expect(v!.operatorSubjectId).toBe('op-subject-1');
    expect(v!.allowedCommands).toEqual(['acknowledge_needs_human', 'mark_reviewed']);
  });

  it('operator scope WITHOUT operatorSubjectId → throws (fail-closed, no silent escalation)', async () => {
    await expect(
      mintConnectionCredential({ orgId: ORG_ID, workroomId: WORKROOM, scopes: ['read', 'operator'] }),
    ).rejects.toThrow(ConnectionCredentialError);
  });

  it('invalid scope → throws', async () => {
    await expect(
      mintConnectionCredential({ orgId: ORG_ID, workroomId: WORKROOM, scopes: ['admin' as 'read'] }),
    ).rejects.toThrow(ConnectionCredentialError);
  });

  it('ttlDays out of range → throws', async () => {
    await expect(
      mintConnectionCredential({ orgId: ORG_ID, workroomId: WORKROOM, scopes: ['read'], ttlDays: CONNECTION_CREDENTIAL_MAX_TTL_DAYS + 1 }),
    ).rejects.toThrow(ConnectionCredentialError);
    await expect(
      mintConnectionCredential({ orgId: ORG_ID, workroomId: WORKROOM, scopes: ['read'], ttlDays: 0 }),
    ).rejects.toThrow(ConnectionCredentialError);
  });

  it('workroom not found / org mismatch → throws', async () => {
    await expect(
      mintConnectionCredential({ orgId: ORG_ID, workroomId: randomUUID(), scopes: ['read'] }),
    ).rejects.toThrow(ConnectionCredentialError);
    // workroom belongs to OTHER_ORG_ID, not ORG_ID
    await expect(
      mintConnectionCredential({ orgId: ORG_ID, workroomId: OTHER_WORKROOM, scopes: ['read'] }),
    ).rejects.toThrow(ConnectionCredentialError);
  });
});

describe('#179 connection credential — verify rejections', () => {
  it('wrong prefix / no bearer / non-existent → null', async () => {
    expect(await verifyConnectionCredential(undefined)).toBeNull();
    expect(await verifyConnectionCredential('Bearer op_sess_notaconn')).toBeNull();
    expect(await verifyConnectionCredential(bearer(`${CONNECTION_CREDENTIAL_PREFIX}doesnotexist`))).toBeNull();
  });

  it('expired credential → null', async () => {
    const r = await mintConnectionCredential({ orgId: ORG_ID, workroomId: WORKROOM, scopes: ['read'] });
    await db.controlConnectionCredential.update({ where: { id: r.connectionId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await verifyConnectionCredential(bearer(r.rawCredential))).toBeNull();
  });
});

describe('#179 connection credential — revoke (kill switch)', () => {
  it('revoke → verify null; idempotent (true then false)', async () => {
    const r = await mintConnectionCredential({ orgId: ORG_ID, workroomId: WORKROOM, scopes: ['read'] });
    expect(await verifyConnectionCredential(bearer(r.rawCredential))).not.toBeNull();

    expect(await revokeConnectionCredential(r.connectionId)).toBe(true);
    expect(await verifyConnectionCredential(bearer(r.rawCredential))).toBeNull();
    // idempotent — second revoke is a no-op
    expect(await revokeConnectionCredential(r.connectionId)).toBe(false);
  });
});

describe('#179 connection credential — rotate (rolling refresh)', () => {
  it('rotate → successor valid, predecessor revoked, scopes/operator carried, lineage set', async () => {
    const r = await mintConnectionCredential({
      orgId: ORG_ID, workroomId: WORKROOM, scopes: ['operator'], operatorSubjectId: 'op-rotate',
      allowedCommands: ['mark_reviewed'],
    });
    const next = await rotateConnectionCredential(r.connectionId);

    // predecessor is now revoked
    expect(await verifyConnectionCredential(bearer(r.rawCredential))).toBeNull();
    // successor verifies and carries scopes/operator
    const v = await verifyConnectionCredential(bearer(next.rawCredential));
    expect(v).not.toBeNull();
    expect(v!.scopes).toContain('operator');
    expect(v!.operatorSubjectId).toBe('op-rotate');
    expect(v!.allowedCommands).toEqual(['mark_reviewed']);
    // lineage recorded
    const nextRow = await db.controlConnectionCredential.findUnique({ where: { id: next.connectionId } });
    expect(nextRow?.rotatedFromId).toBe(r.connectionId);
  });

  it('rotate a revoked/expired connection → throws (caller must re-bind)', async () => {
    const r = await mintConnectionCredential({ orgId: ORG_ID, workroomId: WORKROOM, scopes: ['read'] });
    await revokeConnectionCredential(r.connectionId);
    await expect(rotateConnectionCredential(r.connectionId)).rejects.toThrow(ConnectionCredentialError);
  });
});
