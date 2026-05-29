/**
 * Slice 7 — Task B2-a: resolveActor / requireActor integration tests.
 *
 * Exercises the dual-actor (user OR machine) resolver against the real test Postgres.
 *
 * 5 cases (per task brief):
 *   - missing Bearer            → 401 (preHandler) / null (resolveActor)
 *   - user happy path           → 200, actor.kind='user', workroomRole='owner'
 *   - user non-member workroom  → 401 (preHandler) / null (resolveActor)
 *   - machine happy path        → 200, actor.kind='machine'
 *   - machine wrong workroom    → 401 (preHandler) / null (resolveActor)
 *
 * Run: npm run test:db:setup && npm run test:integration -- sources/auth/userOrMachine
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { hashPassword } from '@/auth/userSession/passwordHash';
import { mintUserSessionToken, hashUserSessionToken } from '@/auth/userSession/tokenMint';
import { requireActor, type Actor } from './resolveActor';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const ORG_ID = randomUUID();
const OTHER_ORG_ID = randomUUID();
const WORKROOM_A = randomUUID(); // ORG_ID
const WORKROOM_B = randomUUID(); // OTHER_ORG_ID

const MACHINE_ID = randomUUID(); // bound to ORG_ID
const MACHINE_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;

let USER_MEMBER_ID = '';
let USER_MEMBER_TOKEN = '';
let USER_OUTSIDER_ID = '';
let USER_OUTSIDER_TOKEN = '';

let app: FastifyInstance;

beforeAll(async () => {
    app = fastify();
    app.get<{ Params: { wid: string } }>(
        '/probe/:wid',
        { preHandler: requireActor({ workroomIdFrom: 'param', paramName: 'wid' }) },
        async (req) => ({ actor: req.actor as Actor }),
    );
    await app.ready();

    await db.controlOrg.create({ data: { id: ORG_ID, name: 'Actor Org', slug: `actor-${randomUUID()}`, ownerUserId: randomUUID() } });
    await db.controlOrg.create({ data: { id: OTHER_ORG_ID, name: 'Other Org', slug: `actor-other-${randomUUID()}`, ownerUserId: randomUUID() } });
    await db.controlWorkroom.create({ data: { id: WORKROOM_A, orgId: ORG_ID, name: 'WR-A', createdBy: randomUUID() } });
    await db.controlWorkroom.create({ data: { id: WORKROOM_B, orgId: OTHER_ORG_ID, name: 'WR-B', createdBy: randomUUID() } });

    await db.controlMachine.create({
        data: {
            id: MACHINE_ID, orgId: ORG_ID, boundAt: new Date(),
            tokenHash: sha256(MACHINE_TOKEN), tokenExpiresAt: new Date(Date.now() + 86_400_000),
            platform: 'darwin', arch: 'arm64',
        },
    });

    const member = await db.user.create({
        data: { email: `actor-${randomUUID()}@example.test`, passwordHash: await hashPassword('p') },
    });
    USER_MEMBER_ID = member.id;
    USER_MEMBER_TOKEN = mintUserSessionToken();
    await db.userSession.create({
        data: { userId: USER_MEMBER_ID, tokenHash: hashUserSessionToken(USER_MEMBER_TOKEN), expiresAt: new Date(Date.now() + 86_400_000) },
    });
    await db.userWorkroomMembership.create({
        data: { userId: USER_MEMBER_ID, workroomId: WORKROOM_A, role: 'owner' },
    });

    const outsider = await db.user.create({
        data: { email: `actor-out-${randomUUID()}@example.test`, passwordHash: await hashPassword('p') },
    });
    USER_OUTSIDER_ID = outsider.id;
    USER_OUTSIDER_TOKEN = mintUserSessionToken();
    await db.userSession.create({
        data: { userId: USER_OUTSIDER_ID, tokenHash: hashUserSessionToken(USER_OUTSIDER_TOKEN), expiresAt: new Date(Date.now() + 86_400_000) },
    });
});

afterAll(async () => {
    await db.user.deleteMany({ where: { id: { in: [USER_MEMBER_ID, USER_OUTSIDER_ID] } } });
    await db.controlMachine.deleteMany({ where: { id: MACHINE_ID } });
    await db.controlWorkroom.deleteMany({ where: { id: { in: [WORKROOM_A, WORKROOM_B] } } });
    await db.controlOrg.deleteMany({ where: { id: { in: [ORG_ID, OTHER_ORG_ID] } } });
    await app.close();
    await db.$disconnect();
});

describe('requireActor / resolveActor', () => {
    it('missing Bearer → 401', async () => {
        const r = await app.inject({ method: 'GET', url: `/probe/${WORKROOM_A}` });
        expect(r.statusCode).toBe(401);
    });

    it('user_sess_ + member workroom → 200 with actor.kind=user, role=owner', async () => {
        const r = await app.inject({
            method: 'GET',
            url: `/probe/${WORKROOM_A}`,
            headers: { authorization: `Bearer ${USER_MEMBER_TOKEN}` },
        });
        expect(r.statusCode).toBe(200);
        const { actor } = r.json() as { actor: Actor };
        expect(actor.kind).toBe('user');
        if (actor.kind === 'user') {
            expect(actor.userId).toBe(USER_MEMBER_ID);
            expect(actor.workroomRole).toBe('owner');
        }
    });

    it('user_sess_ + non-member workroom → 401 (uniform)', async () => {
        const r = await app.inject({
            method: 'GET',
            url: `/probe/${WORKROOM_A}`,
            headers: { authorization: `Bearer ${USER_OUTSIDER_TOKEN}` },
        });
        expect(r.statusCode).toBe(401);
    });

    it('machine_token + same-org workroom → 200 with actor.kind=machine', async () => {
        const r = await app.inject({
            method: 'GET',
            url: `/probe/${WORKROOM_A}`,
            headers: { authorization: `Bearer ${MACHINE_TOKEN}` },
        });
        expect(r.statusCode).toBe(200);
        const { actor } = r.json() as { actor: Actor };
        expect(actor.kind).toBe('machine');
        if (actor.kind === 'machine') {
            expect(actor.machineId).toBe(MACHINE_ID);
            expect(actor.orgId).toBe(ORG_ID);
        }
    });

    it('machine_token + cross-org workroom → 401 (uniform)', async () => {
        const r = await app.inject({
            method: 'GET',
            url: `/probe/${WORKROOM_B}`,
            headers: { authorization: `Bearer ${MACHINE_TOKEN}` },
        });
        expect(r.statusCode).toBe(401);
    });
});
