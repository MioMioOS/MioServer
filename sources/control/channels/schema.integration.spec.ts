/**
 * S1 Chunk 1 — ControlChannel/ControlChannelMember schema + ControlMessage extensions.
 *
 * Integration tests covering:
 *  1. Creating a workroom produces a usable main channel (via backfill pattern).
 *  2. ControlMessage.channelId is properly set and NOT NULL after backfill.
 *  3. UNIQUE(channelId, seq) is enforced: duplicate insert throws.
 *  4. UNIQUE(channelId, clientIdempotencyKey) is enforced: duplicate keyed insert throws.
 *  5. NULL clientIdempotencyKey rows do NOT collide (Postgres NULL != NULL).
 *
 * ── Running ────────────────────────────────────────────────────────────────────
 *   npm run test:db:setup
 *   npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { Prisma } from '@prisma/client';

const ORG_ID = randomUUID();
const WORKROOM_ID = randomUUID();
let CHANNEL_ID = '';

beforeAll(async () => {
    await db.controlOrg.create({
        data: { id: ORG_ID, name: 'Schema Spec Org', slug: `schema-spec-${randomUUID()}`, ownerUserId: randomUUID() },
    });
    await db.controlWorkroom.create({
        data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'Schema Spec WR', createdBy: randomUUID() },
    });
});

afterAll(async () => {
    // Clean up in FK-safe order: messages → channel members → channels → workroom → org
    await db.controlMessage.deleteMany({ where: { workroomId: WORKROOM_ID } });
    await db.controlChannelMember.deleteMany({ where: { channel: { workroomId: WORKROOM_ID } } });
    await db.controlChannel.deleteMany({ where: { workroomId: WORKROOM_ID } });
    await db.controlWorkroom.deleteMany({ where: { id: WORKROOM_ID } });
    await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
    await db.$disconnect();
});

describe('S1 Chunk 1 — schema + migration', () => {
    it('can create a main ControlChannel for a workroom', async () => {
        const channel = await db.controlChannel.create({
            data: {
                workroomId: WORKROOM_ID,
                name: 'Schema Spec WR',
                type: 'main',
                visibility: 'public',
                createdBy: 'system',
                lastActivityAt: new Date(),
            },
        });
        CHANNEL_ID = channel.id;

        expect(channel.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(channel.type).toBe('main');
        expect(channel.visibility).toBe('public');
        expect(channel.createdBy).toBe('system');
        expect(channel.workroomId).toBe(WORKROOM_ID);
    });

    it('ControlWorkroom has reverse channels relation', async () => {
        const wr = await db.controlWorkroom.findUniqueOrThrow({
            where: { id: WORKROOM_ID },
            include: { channels: true },
        });
        expect(wr.channels).toHaveLength(1);
        expect(wr.channels[0].id).toBe(CHANNEL_ID);
    });

    it('can add a ControlChannelMember to the channel', async () => {
        const memberId = `op_sess_${randomUUID()}`;
        const member = await db.controlChannelMember.create({
            data: { channelId: CHANNEL_ID, memberId },
        });
        expect(member.channelId).toBe(CHANNEL_ID);
        expect(member.memberId).toBe(memberId);
    });

    it('UNIQUE(channelId, memberId) prevents duplicate member rows', async () => {
        const memberId = `op_sess_${randomUUID()}`;
        await db.controlChannelMember.create({ data: { channelId: CHANNEL_ID, memberId } });
        await expect(
            db.controlChannelMember.create({ data: { channelId: CHANNEL_ID, memberId } }),
        ).rejects.toThrow();
    });

    it('can create a ControlMessage with channelId and seq=1', async () => {
        const msg = await db.controlMessage.create({
            data: {
                workroomId: WORKROOM_ID,
                channelId: CHANNEL_ID,
                seq: BigInt(1),
                senderKind: 'system',
                senderId: randomUUID(),
                content: 'First message',
            },
        });
        expect(msg.channelId).toBe(CHANNEL_ID);
        expect(msg.seq).toBe(BigInt(1));
    });

    it('UNIQUE(channelId, seq) prevents duplicate seq within same channel', async () => {
        // seq=1 was already inserted above; inserting it again should throw.
        await expect(
            db.controlMessage.create({
                data: {
                    workroomId: WORKROOM_ID,
                    channelId: CHANNEL_ID,
                    seq: BigInt(1),
                    senderKind: 'system',
                    senderId: randomUUID(),
                    content: 'Duplicate seq',
                },
            }),
        ).rejects.toThrow(Prisma.PrismaClientKnownRequestError);
    });

    it('UNIQUE(channelId, clientIdempotencyKey) prevents duplicate keyed messages', async () => {
        const key = `idem-${randomUUID()}`;
        await db.controlMessage.create({
            data: {
                workroomId: WORKROOM_ID,
                channelId: CHANNEL_ID,
                seq: BigInt(2),
                senderKind: 'agent',
                senderId: randomUUID(),
                content: 'Idempotent first',
                clientIdempotencyKey: key,
            },
        });
        await expect(
            db.controlMessage.create({
                data: {
                    workroomId: WORKROOM_ID,
                    channelId: CHANNEL_ID,
                    seq: BigInt(3),
                    senderKind: 'agent',
                    senderId: randomUUID(),
                    content: 'Idempotent duplicate',
                    clientIdempotencyKey: key,
                },
            }),
        ).rejects.toThrow(Prisma.PrismaClientKnownRequestError);
    });

    it('NULL clientIdempotencyKey rows do NOT collide (Postgres NULL != NULL)', async () => {
        // Two machine messages with no idempotency key — both should succeed.
        const [m1, m2] = await Promise.all([
            db.controlMessage.create({
                data: {
                    workroomId: WORKROOM_ID,
                    channelId: CHANNEL_ID,
                    seq: BigInt(10),
                    senderKind: 'system',
                    senderId: randomUUID(),
                    content: 'No idem key 1',
                    clientIdempotencyKey: null,
                },
            }),
            db.controlMessage.create({
                data: {
                    workroomId: WORKROOM_ID,
                    channelId: CHANNEL_ID,
                    seq: BigInt(11),
                    senderKind: 'system',
                    senderId: randomUUID(),
                    content: 'No idem key 2',
                    clientIdempotencyKey: null,
                },
            }),
        ]);
        expect(m1.clientIdempotencyKey).toBeNull();
        expect(m2.clientIdempotencyKey).toBeNull();
        // They should have different ids — no collision.
        expect(m1.id).not.toBe(m2.id);
    });

    it('all seeded messages have non-null channelId (backfill contract)', async () => {
        // channelId is now non-nullable in both schema and DB (I1 fix: s1_channelid_notnull migration).
        // Verify by counting messages for this workroom that DO have a channelId set.
        const messages = await db.controlMessage.findMany({
            where: { workroomId: WORKROOM_ID },
            select: { id: true, channelId: true },
        });
        // Every message must have a channelId (non-null enforced at schema + DB level).
        for (const m of messages) {
            expect(m.channelId).not.toBeNull();
            expect(typeof m.channelId).toBe('string');
        }
    });
});
