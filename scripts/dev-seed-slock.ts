/**
 * dev-seed-slock.ts — Local dev seed for S1 channel/message data (slockai workroom).
 *
 * Idempotently creates:
 *   - 1 ControlOrg  (slug: dev-slock-org)
 *   - 1 ControlWorkroom  (name: "Test123Kris")
 *   - 1 ControlChannel   (name: "slockai", type: "standard", visibility: "public")
 *   - 5 ControlMessage rows with realistic content
 *   - 1 dev_ctl_ token  (TTL 720h / 30 days)
 *
 * Idempotency: looks up existing records by slug / name before creating; only creates missing pieces.
 * Duplicate token mints are fine (each run adds a new one — old ones still work until they expire).
 *
 * Usage:
 *   tsx --env-file=.env.dev scripts/dev-seed-slock.ts
 *
 * Output: a single JSON line on stdout:
 *   {"serverURL":"http://localhost:3005","workroomId":"...","channelId":"...","orgId":"...","devToken":"..."}
 *
 * SECURITY: never commit .env.dev or any secret. This script contains no secrets.
 */

import { randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { mintDevControlToken } from '@/control/devTokens/mintDevToken';

const ORG_SLUG = 'dev-slock-org';
const WORKROOM_NAME = 'Test123Kris';
const CHANNEL_NAME = 'slockai';

async function main(): Promise<void> {
  // ── 1. Org ──────────────────────────────────────────────────────────────
  let org = await db.controlOrg.findUnique({ where: { slug: ORG_SLUG } });
  if (!org) {
    org = await db.controlOrg.create({
      data: {
        id: randomUUID(),
        name: 'Dev Slock Org',
        slug: ORG_SLUG,
        ownerUserId: randomUUID(),
        billingPlan: 'free',
      },
    });
  }

  // ── 2. Workroom ──────────────────────────────────────────────────────────
  let workroom = await db.controlWorkroom.findFirst({
    where: { orgId: org.id, name: WORKROOM_NAME },
  });
  if (!workroom) {
    workroom = await db.controlWorkroom.create({
      data: {
        id: randomUUID(),
        orgId: org.id,
        name: WORKROOM_NAME,
        visibility: 'private',
        createdBy: randomUUID(),
      },
    });
  }

  // ── 3. Channel ───────────────────────────────────────────────────────────
  let channel = await db.controlChannel.findFirst({
    where: { workroomId: workroom.id, name: CHANNEL_NAME },
  });
  if (!channel) {
    channel = await db.controlChannel.create({
      data: {
        id: randomUUID(),
        workroomId: workroom.id,
        name: CHANNEL_NAME,
        type: 'standard',
        visibility: 'public',
        createdBy: 'system',
        lastActivityAt: new Date(),
      },
    });
  } else {
    // Ensure lastActivityAt is refreshed so the iOS app sees an active channel
    channel = await db.controlChannel.update({
      where: { id: channel.id },
      data: { lastActivityAt: new Date() },
    });
  }

  // ── 4. Messages (idempotent: skip if 5+ already exist on this channel) ───
  const existingCount = await db.controlMessage.count({ where: { channelId: channel.id } });
  if (existingCount < 5) {
    const now = Date.now();
    const messages: Array<{
      id: string;
      workroomId: string;
      channelId: string;
      seq: bigint;
      senderKind: string;
      senderId: string;
      content: string;
      mentions: string[];
      createdAt: Date;
      clientIdempotencyKey: string;
    }> = [
      {
        id: randomUUID(),
        workroomId: workroom.id,
        channelId: channel.id,
        seq: BigInt(1),
        senderKind: 'human',
        // senderId is TEXT in DB (s1_senderid_text migration) — opaque actor id, not constrained to uuid format
        senderId: 'kris',
        content: 'Hey everyone, kicking off the slockai channel. Can the agent summarize today\'s deployment plan?',
        mentions: [],
        createdAt: new Date(now - 5 * 60_000),
        clientIdempotencyKey: `slock-seed-msg-1-${channel.id.slice(0, 8)}`,
      },
      {
        id: randomUUID(),
        workroomId: workroom.id,
        channelId: channel.id,
        seq: BigInt(2),
        senderKind: 'agent',
        senderId: 'slock-ops',
        content: 'Sure! Today\'s plan: (1) run integration tests on the feature branch, (2) build iOS IPA, (3) upload to TestFlight, (4) await human sign-off before distributing to testers.',
        mentions: [],
        createdAt: new Date(now - 4 * 60_000),
        clientIdempotencyKey: `slock-seed-msg-2-${channel.id.slice(0, 8)}`,
      },
      {
        id: randomUUID(),
        workroomId: workroom.id,
        channelId: channel.id,
        seq: BigInt(3),
        senderKind: 'human',
        senderId: 'kris',
        content: 'Integration tests passed locally. Go ahead and start the build.',
        mentions: [],
        createdAt: new Date(now - 3 * 60_000),
        clientIdempotencyKey: `slock-seed-msg-3-${channel.id.slice(0, 8)}`,
      },
      {
        id: randomUUID(),
        workroomId: workroom.id,
        channelId: channel.id,
        seq: BigInt(4),
        senderKind: 'agent',
        senderId: 'slock-ops',
        content: 'Build started. Estimated completion: ~8 minutes. I\'ll post the IPA digest and upload status here when done.',
        mentions: [],
        createdAt: new Date(now - 2 * 60_000),
        clientIdempotencyKey: `slock-seed-msg-4-${channel.id.slice(0, 8)}`,
      },
      {
        id: randomUUID(),
        workroomId: workroom.id,
        channelId: channel.id,
        seq: BigInt(5),
        senderKind: 'agent',
        senderId: 'slock-ops',
        content: 'Build complete. IPA uploaded to TestFlight (build 1.4.2+15, 6e3a1b9f). Waiting for human confirmation to distribute to external testers.',
        mentions: [],
        createdAt: new Date(now - 1 * 60_000),
        clientIdempotencyKey: `slock-seed-msg-5-${channel.id.slice(0, 8)}`,
      },
    ];

    // Only insert messages that don't already exist (by clientIdempotencyKey + channelId)
    for (const msg of messages) {
      const seqExists = await db.controlMessage.findUnique({
        where: { channelId_seq: { channelId: channel.id, seq: msg.seq } },
      });
      if (!seqExists) {
        await db.controlMessage.create({ data: msg });
      }
    }
  }

  // ── 5. Mint dev_ctl_ token ────────────────────────────────────────────────
  const { rawToken } = await mintDevControlToken({
    orgId: org.id,
    workroomId: workroom.id,
    ttlHours: 720,
  });

  // ── 6. Output ─────────────────────────────────────────────────────────────
  const result = {
    serverURL: 'http://localhost:3005',
    workroomId: workroom.id,
    channelId: channel.id,
    orgId: org.id,
    devToken: rawToken,
  };

  console.log(JSON.stringify(result));

  await db.$disconnect();
}

const isDirectRun =
  process.argv[1]?.endsWith('dev-seed-slock.ts') || process.argv[1]?.endsWith('dev-seed-slock.js');

if (isDirectRun) {
  main().catch(async (err) => {
    console.error('dev-seed-slock failed:', err);
    try { await db.$disconnect(); } catch { /* */ }
    process.exit(1);
  });
}
