/**
 * #96 operator_session WRITE auth — REAL Postgres integration tests.
 * Run with: npm run test:db:setup && npm run test:integration  (excluded from default npm test).
 *
 * Verifies the SIMPLE bearer auth (no signing/nonce): op_sess_ hash lookup, TTL/revoke, command +
 * workroom scope, and dev_ctl_ hard-reject on writes.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { mintOperatorSession, revokeOperatorSession } from './operatorSessionMint.js';
import {
  verifyOperatorSession,
  operatorSessionAllows,
  authorizeOperatorWrite,
} from './operatorSessionAuth.js';

const ORG_ID = randomUUID();
const WORKROOM_ID = randomUUID();
const OTHER_WORKROOM_ID = randomUUID();
const SUBJECT = 'op-subject-1';
const ISSUED_BY = 'cli:test';

/** Minimal FastifyRequest stub — authorizeOperatorWrite only reads headers.authorization. */
function req(authorization?: string): FastifyRequest {
  return { headers: authorization ? { authorization } : {} } as unknown as FastifyRequest;
}

let validRaw: string;

beforeAll(async () => {
  await db.controlOrg.create({ data: { id: ORG_ID, name: 'Auth Org', slug: `auth-${randomUUID()}`, ownerUserId: randomUUID() } });
  await db.controlWorkroom.create({ data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'Auth WR', createdBy: randomUUID() } });
  const r = await mintOperatorSession({ orgId: ORG_ID, workroomId: WORKROOM_ID, operatorSubjectId: SUBJECT, issuedBy: ISSUED_BY });
  validRaw = r.rawToken;
});

afterAll(async () => {
  await db.controlOperatorSession.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlWorkroom.deleteMany({ where: { id: WORKROOM_ID } });
  await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
  await db.$disconnect();
});

describe('#96 verifyOperatorSession — real DB', () => {
  it('valid op_sess_ token → context with workroom/commands/subject', async () => {
    const ctx = await verifyOperatorSession(`Bearer ${validRaw}`);
    expect(ctx).not.toBeNull();
    expect(ctx!.workroomId).toBe(WORKROOM_ID);
    expect(ctx!.orgId).toBe(ORG_ID);
    expect(ctx!.operatorSubjectId).toBe(SUBJECT);
    expect(ctx!.allowedCommands).toEqual(['acknowledge_needs_human', 'mark_reviewed']);
  });

  it('dev_ctl_ token → null (read-only token can never write)', async () => {
    expect(await verifyOperatorSession('Bearer dev_ctl_anything')).toBeNull();
  });

  it('garbage / missing / non-Bearer → null', async () => {
    expect(await verifyOperatorSession(undefined)).toBeNull();
    expect(await verifyOperatorSession('Bearer ')).toBeNull();
    expect(await verifyOperatorSession('op_sess_no_bearer_prefix')).toBeNull();
    expect(await verifyOperatorSession('Bearer op_sess_not_a_real_hash')).toBeNull();
  });

  it('revoked session → null', async () => {
    const r = await mintOperatorSession({ orgId: ORG_ID, workroomId: WORKROOM_ID, operatorSubjectId: SUBJECT, issuedBy: ISSUED_BY });
    expect(await verifyOperatorSession(`Bearer ${r.rawToken}`)).not.toBeNull();
    await revokeOperatorSession(r.id);
    expect(await verifyOperatorSession(`Bearer ${r.rawToken}`)).toBeNull();
  });
});

describe('#96 operatorSessionAllows — command + workroom scope', () => {
  it('allowed command + matching workroom → true; disallowed command → false; wrong workroom → false', async () => {
    const ctx = (await verifyOperatorSession(`Bearer ${validRaw}`))!;
    expect(operatorSessionAllows(ctx, 'acknowledge_needs_human', WORKROOM_ID)).toBe(true);
    expect(operatorSessionAllows(ctx, 'mark_reviewed', WORKROOM_ID)).toBe(true);
    expect(operatorSessionAllows(ctx, 'approve', WORKROOM_ID)).toBe(false);        // not in allow-list
    expect(operatorSessionAllows(ctx, 'acknowledge_needs_human', OTHER_WORKROOM_ID)).toBe(false); // wrong workroom
  });
});

describe('#96 authorizeOperatorWrite — endpoint auth', () => {
  it('valid token + allowed command + correct workroom → ok', async () => {
    const res = await authorizeOperatorWrite(req(`Bearer ${validRaw}`), { command: 'acknowledge_needs_human', workroomId: WORKROOM_ID });
    expect(res.ok).toBe(true);
  });

  it('dev_ctl_ token → 401 (hard reject on write)', async () => {
    const res = await authorizeOperatorWrite(req('Bearer dev_ctl_x'), { command: 'acknowledge_needs_human', workroomId: WORKROOM_ID });
    expect(res).toMatchObject({ ok: false, status: 401 });
  });

  it('missing token → 401', async () => {
    const res = await authorizeOperatorWrite(req(undefined), { command: 'acknowledge_needs_human', workroomId: WORKROOM_ID });
    expect(res).toMatchObject({ ok: false, status: 401 });
  });

  it('valid token but command not allowed → 403', async () => {
    const res = await authorizeOperatorWrite(req(`Bearer ${validRaw}`), { command: 'approve', workroomId: WORKROOM_ID });
    expect(res).toMatchObject({ ok: false, status: 403 });
  });

  it('valid token but wrong workroom → 403', async () => {
    const res = await authorizeOperatorWrite(req(`Bearer ${validRaw}`), { command: 'acknowledge_needs_human', workroomId: OTHER_WORKROOM_ID });
    expect(res).toMatchObject({ ok: false, status: 403 });
  });
});
