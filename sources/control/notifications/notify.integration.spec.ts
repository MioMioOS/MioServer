/**
 * Control-plane notification device-resolution (REAL Postgres integration).
 * Run: npm run test:db:setup && npm run test:integration -- sources/control/notifications/notify.integration.spec.ts
 *
 * Covers the "消息能正常通知吗" wiring that is testable WITHOUT live APNs: the
 * control-plane User → Device(ios) → push-eligibility chain that notify.ts walks
 * before it hands off to sendPushToDevice. (The APNs network leg itself is a
 * silent no-op without an APNS key — see notify.ts — so it is out of scope here;
 * what we CAN regress is that the right devices are selected and the gates work.)
 *
 * resolveTargetDevices is not exported, so we exercise it through its observable
 * contract: seed users/devices, call the exported notifyMentionedUsers /
 * notifyTaskDone, and assert via the [notify-*] console summary which counts
 * recipients + resolved devices. A spy on console.log captures the summary line.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { hashPassword } from '@/auth/userSession/passwordHash';
import { notifyMentionedUsers, notifyTaskDone } from './notify';

let sender = '', online = '', notifEnabledNoCompletion = '', disabled = '', stale = '', noDevice = '';
const created: string[] = [];

async function userWithDevice(opts: {
  hasDevice: boolean;
  notificationsEnabled?: boolean;
  notifyOnCompletion?: boolean;
  lastSeenAt?: Date | null;
  kind?: string;
}): Promise<string> {
  const u = await db.user.create({ data: { email: `notif-${randomUUID()}@example.test`, passwordHash: await hashPassword('p') } });
  created.push(u.id);
  if (opts.hasDevice) {
    await db.device.create({
      data: {
        publicKey: `pk-${randomUUID()}`,
        name: 'iPhone',
        kind: opts.kind ?? 'ios',
        userId: u.id,
        notificationsEnabled: opts.notificationsEnabled ?? true,
        notifyOnCompletion: opts.notifyOnCompletion ?? false,
        lastSeenAt: opts.lastSeenAt ?? new Date(),
      },
    });
  }
  return u.id;
}

beforeAll(async () => {
  sender = await userWithDevice({ hasDevice: true });
  online = await userWithDevice({ hasDevice: true, notificationsEnabled: true, lastSeenAt: new Date() });
  notifEnabledNoCompletion = await userWithDevice({ hasDevice: true, notificationsEnabled: true, notifyOnCompletion: false });
  disabled = await userWithDevice({ hasDevice: true, notificationsEnabled: false });
  stale = await userWithDevice({ hasDevice: true, lastSeenAt: new Date(Date.now() - 400 * 24 * 3600 * 1000) });
  noDevice = await userWithDevice({ hasDevice: false });
});

afterAll(async () => {
  await db.device.deleteMany({ where: { userId: { in: created } } });
  await db.user.deleteMany({ where: { id: { in: created } } });
  await db.$disconnect();
});

function captureNotifyLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    const s = args.map(String).join(' ');
    if (s.startsWith('[notify-')) lines.push(s);
  });
  return { lines, restore: () => spy.mockRestore() };
}
const target = () => ({ workroomId: randomUUID(), channelId: randomUUID(), messageId: randomUUID() });

describe('notifyMentionedUsers device resolution', () => {
  it('resolves an active ios device; excludes the sender', async () => {
    const { lines, restore } = captureNotifyLog();
    await notifyMentionedUsers({ mentionedUserIds: [online, sender], senderUserId: sender, target: target(), title: 't', body: 'b' });
    restore();
    const summary = lines.find((l) => l.startsWith('[notify-mention] message='));
    expect(summary).toBeDefined();
    // sender filtered out → 1 recipient, 1 device.
    expect(summary).toContain('recipients=1');
    expect(summary).toContain('devices=1');
  });

  it('master kill-switch + staleness + no-device all drop out', async () => {
    const { lines, restore } = captureNotifyLog();
    await notifyMentionedUsers({ mentionedUserIds: [disabled, stale, noDevice], senderUserId: sender, target: target(), title: 't', body: 'b' });
    restore();
    // All three are ineligible → "no active devices" branch, no message= summary.
    expect(lines.some((l) => l.includes('no active devices'))).toBe(true);
    expect(lines.some((l) => l.startsWith('[notify-mention] message='))).toBe(false);
  });

  it('mentions are NOT gated by notifyOnCompletion (a non-completion device still gets it)', async () => {
    const { lines, restore } = captureNotifyLog();
    await notifyMentionedUsers({ mentionedUserIds: [notifEnabledNoCompletion], senderUserId: sender, target: target(), title: 't', body: 'b' });
    restore();
    expect(lines.find((l) => l.startsWith('[notify-mention] message='))).toContain('devices=1');
  });
});

describe('notifyTaskDone gating', () => {
  it('task-done REQUIRES notifyOnCompletion — a mention-only device is dropped', async () => {
    const { lines, restore } = captureNotifyLog();
    await notifyTaskDone({ recipientUserIds: [notifEnabledNoCompletion], target: target(), title: 't', body: 'b' });
    restore();
    expect(lines.some((l) => l.includes('no completion-enabled devices'))).toBe(true);
  });

  it('task-done reaches a completion-enabled device', async () => {
    const completion = await userWithDevice({ hasDevice: true, notifyOnCompletion: true });
    const { lines, restore } = captureNotifyLog();
    await notifyTaskDone({ recipientUserIds: [completion], target: target(), title: 't', body: 'b' });
    restore();
    expect(lines.find((l) => l.startsWith('[notify-task-done] message='))).toContain('devices=1');
  });
});
