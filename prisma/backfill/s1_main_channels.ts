/**
 * S1 backfill: create one "main" ControlChannel per ControlWorkroom,
 * then set all that workroom's ControlMessage.channelId to it,
 * and backfill per-channel seq (1..n by createdAt asc).
 *
 * Run AFTER migration 20260524000000_s1_channels_messages (channelId nullable)
 * and BEFORE migration 20260524010000_s1_channelid_notnull (channelId NOT NULL).
 *
 * Usage (from project root):
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/codelight_test \
 *     npx tsx prisma/backfill/s1_main_channels.ts
 */

import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

async function main() {
    console.log('[s1_backfill] Starting S1 main channel backfill…');

    const workrooms = await db.controlWorkroom.findMany({
        select: { id: true, name: true, createdAt: true },
    });

    console.log(`[s1_backfill] Found ${workrooms.length} workroom(s) to backfill.`);

    for (const workroom of workrooms) {
        // Determine lastActivityAt = max(messages.createdAt) for this workroom, fallback to workroom.createdAt
        const latestMessage = await db.controlMessage.findFirst({
            where: { workroomId: workroom.id },
            orderBy: { createdAt: 'desc' },
            select: { createdAt: true },
        });
        const lastActivityAt = latestMessage ? latestMessage.createdAt : workroom.createdAt;

        // Check if a main channel already exists (idempotent re-run safety)
        const existing = await db.controlChannel.findFirst({
            where: { workroomId: workroom.id, type: 'main' },
            select: { id: true },
        });

        let channelId: string;
        if (existing) {
            channelId = existing.id;
            console.log(`[s1_backfill]   workroom ${workroom.id}: reusing existing main channel ${channelId}`);
        } else {
            const channel = await db.controlChannel.create({
                data: {
                    workroomId: workroom.id,
                    name: workroom.name,
                    type: 'main',
                    visibility: 'public',
                    createdBy: 'system',
                    lastActivityAt,
                },
            });
            channelId = channel.id;
            console.log(`[s1_backfill]   workroom ${workroom.id}: created main channel ${channelId}`);
        }

        // Assign channelId to all messages in this workroom (skip already-assigned)
        const updateResult = await db.controlMessage.updateMany({
            where: { workroomId: workroom.id, channelId: null },
            data: { channelId },
        });
        console.log(`[s1_backfill]   workroom ${workroom.id}: updated ${updateResult.count} message(s) → channelId`);

        // Backfill seq: assign 1..n in createdAt asc order, only for messages where seq=0
        // (i.e. not yet backfilled, which is the default)
        const messages = await db.controlMessage.findMany({
            where: { channelId, seq: 0 },
            orderBy: { createdAt: 'asc' },
            select: { id: true },
        });

        for (let i = 0; i < messages.length; i++) {
            await db.controlMessage.update({
                where: { id: messages[i].id },
                data: { seq: BigInt(i + 1) },
            });
        }
        console.log(`[s1_backfill]   workroom ${workroom.id}: backfilled seq for ${messages.length} message(s)`);
    }

    // Verification: no remaining NULL channelId
    const nullCount = await db.controlMessage.count({
        where: { channelId: null },
    });

    if (nullCount > 0) {
        throw new Error(`[s1_backfill] FAIL: ${nullCount} message(s) still have NULL channelId after backfill!`);
    }

    console.log('[s1_backfill] Verification PASSED: no NULL channelId rows remain.');
    console.log('[s1_backfill] Backfill complete. Safe to apply s1_channelid_notnull migration.');
}

main()
    .catch((err) => {
        console.error('[s1_backfill] ERROR:', err);
        process.exit(1);
    })
    .finally(() => {
        db.$disconnect();
    });
