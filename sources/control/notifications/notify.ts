/**
 * Control-plane push notifications (Task #121 S4).
 *
 * Two triggers feed APNs from the workroom/agent control plane:
 *   1. notifyMentionedUsers  — a message mentions one or more HUMAN users.
 *   2. notifyTaskDone        — a task transitions to a terminal `done` status.
 *
 * Device resolution chain (control plane → push):
 *   User.id ──(Device.userId)──▶ Device[] ──(PushToken.deviceId)──▶ APNs token[]
 * sendPushToDevice() handles per-device token fan-out + dead-token self-healing.
 *
 * SHARED DEEP-LINK CONTRACT (must match CodeLight + the daemon / MioIsland agents):
 *   APNs custom payload (alongside `aps`):
 *     {
 *       type: "mention_ai" | "mention_human" | "task_done",
 *       workroomId: string,
 *       channelId:  string,
 *       messageId:  string,
 *       threadId?:  string,   // parentMessageId when the message is a thread reply
 *       title:      string,
 *       body:       string,
 *     }
 *   APNs requires custom payload values to be strings; threadId is omitted (not null)
 *   when absent. The same field set is mirrored on every activity-feed item.
 *
 * GATING (Task #121):
 *   - MENTIONS notify regardless of the per-kind completion/approval/error toggles —
 *     a direct mention is always relevant. Only the device master kill-switch
 *     (notificationsEnabled) and the staleness filter apply.
 *   - TASK-DONE is a completion-style signal → gated by notifyOnCompletion
 *     (plus the master switch + staleness), consistent with session-completion pushes.
 */

import { db } from '@/storage/db';
import { sendPushToDevice, type PushPayload } from '@/push/apns';
import { sendWebPushToUsers } from '@/push/webpush';
import { config } from '@/config';

/**
 * How long after a device's last successful auth we keep pushing to it.
 * JWT TTL + 1-day grace — mirrors the formula in sessionHandler.ts so the
 * control-plane push path uses the same staleness window as the session path.
 */
function getStaleThresholdMs(): number {
  const days = (config.tokenExpiryDays || 30) + 1;
  return days * 24 * 60 * 60 * 1000;
}

export type DeepLinkType = 'mention_ai' | 'mention_human' | 'task_done';

export interface DeepLinkTarget {
  type: DeepLinkType;
  workroomId: string;
  channelId: string;
  messageId: string;
  threadId?: string | null;
}

/** Build the APNs custom-payload `data` map (all values must be strings). */
function buildDeepLinkData(target: DeepLinkTarget, title: string, body: string): Record<string, string> {
  const data: Record<string, string> = {
    type: target.type,
    workroomId: target.workroomId,
    channelId: target.channelId,
    messageId: target.messageId,
    title,
    body,
  };
  if (target.threadId) data.threadId = target.threadId;
  return data;
}

/**
 * Resolve the active (non-stale, notifications-enabled) iOS devices for a set of users,
 * honoring an optional completion-style gate.
 *
 * @param requireCompletionPref when true, the device must have notifyOnCompletion=true
 *   (used by task-done). When false, only the master switch + staleness apply (mentions).
 */
async function resolveTargetDevices(
  userIds: string[],
  requireCompletionPref: boolean,
): Promise<string[]> {
  if (userIds.length === 0) return [];
  const uniqueUserIds = [...new Set(userIds)];

  const devices = await db.device.findMany({
    where: { userId: { in: uniqueUserIds }, kind: 'ios' },
    select: {
      id: true,
      notificationsEnabled: true,
      notifyOnCompletion: true,
      lastSeenAt: true,
    },
  });

  const staleCutoff = Date.now() - getStaleThresholdMs();
  const result: string[] = [];
  for (const d of devices) {
    if (!d.notificationsEnabled) continue; // master kill-switch
    if (d.lastSeenAt && d.lastSeenAt.getTime() < staleCutoff) continue; // stale device
    if (requireCompletionPref && !d.notifyOnCompletion) continue;
    result.push(d.id);
  }
  return result;
}

/**
 * Send a mention push to every mentioned HUMAN user's active devices.
 * Mentions are NOT gated by completion/approval/error toggles (always relevant).
 *
 * @param mentionedUserIds cuid User.id list (already classified as human).
 * @param senderUserId     optional cuid of the sender — excluded so you never push
 *                         yourself for @-ing your own name in a message.
 */
export async function notifyMentionedUsers(params: {
  mentionedUserIds: string[];
  senderUserId?: string | null;
  target: Omit<DeepLinkTarget, 'type'>;
  title: string;
  body: string;
}): Promise<void> {
  const recipients = params.mentionedUserIds.filter((id) => id !== params.senderUserId);
  if (recipients.length === 0) return;

  // Web Push (browser/PWA) — parallel to APNs, same recipients. Not gated by
  // the iOS device prefs (those are per-APNs-device); a browser subscription
  // existing IS the opt-in. Fire-and-forget.
  const webTarget: DeepLinkTarget = { ...params.target, type: 'mention_human' };
  void sendWebPushToUsers(
    recipients,
    { title: params.title, body: params.body, data: buildDeepLinkData(webTarget, params.title, params.body) },
    params.senderUserId,
  ).catch((err) => console.error('[notify-mention] web push failed', err));

  const deviceIds = await resolveTargetDevices(recipients, /* requireCompletionPref */ false);
  if (deviceIds.length === 0) {
    console.log(`[notify-mention] no active devices for ${recipients.length} mentioned user(s)`);
    return;
  }

  const target: DeepLinkTarget = { ...params.target, type: 'mention_human' };
  const payload: PushPayload = {
    title: params.title,
    body: params.body,
    data: buildDeepLinkData(target, params.title, params.body),
  };

  console.log(
    `[notify-mention] message=${params.target.messageId.slice(0, 8)} recipients=${recipients.length} devices=${deviceIds.length}`,
  );
  for (const deviceId of deviceIds) {
    sendPushToDevice(deviceId, payload, db).catch((err) =>
      console.error('[notify-mention] push failed', err),
    );
  }
}

/**
 * DM push (browser/PWA only) — a direct message has no @-mention but the peer
 * still wants to know. Resolves the DM channel's other member(s) and web-pushes
 * them with the sender's name as the title. No-op for non-DM channels and for
 * agent peers (agent ids never match a WebPushSubscription.userId).
 *
 * APNs is intentionally NOT touched here — DM-to-APNs wasn't a prior behavior
 * and the iOS app has its own delivery. This only lights up the web PWA.
 */
export async function notifyDirectMessagePeers(params: {
  channelId: string;
  senderUserId?: string | null;
  target: Omit<DeepLinkTarget, 'type'>;
  body: string;
}): Promise<void> {
  const channel = await db.controlChannel.findUnique({
    where: { id: params.channelId },
    select: { visibility: true },
  });
  if (channel?.visibility !== 'dm') return;

  const members = await db.controlChannelMember.findMany({
    where: { channelId: params.channelId },
    select: { memberId: true },
  });
  const peers = members.map((m) => m.memberId).filter((id) => id !== params.senderUserId);
  if (peers.length === 0) return;

  let title = '新私信';
  if (params.senderUserId) {
    const sender = await db.user.findUnique({
      where: { id: params.senderUserId },
      select: { displayName: true, email: true },
    });
    if (sender) title = sender.displayName || sender.email.split('@')[0];
  }

  const target: DeepLinkTarget = { ...params.target, type: 'mention_human' };
  await sendWebPushToUsers(
    peers,
    { title, body: params.body, data: buildDeepLinkData(target, title, params.body) },
    params.senderUserId,
  );
}

/**
 * 客户频道里新建了需求任务 → 通知工作区里的每个人(Web Push)。
 *
 * 客户在客户频道向顾问提需求、顾问批准建单时触发。整个内部团队都该知道有新
 * 客户需求进来,所以推给该工作区的**全部**人类成员(不限 owner)。深链到客户
 * 频道;进不去的成员点开就停在 app 首页(无害)。APNs 不碰(那是旧 iOS app)。
 */
export async function notifyClientTaskCreated(params: {
  workroomId: string;
  channelId: string;
  channelName: string;
  tasks: Array<{ number: number; title: string }>;
}): Promise<void> {
  if (params.tasks.length === 0) return;
  const memberships = await db.userWorkroomMembership.findMany({
    where: { workroomId: params.workroomId },
    select: { userId: true },
  });
  const recipientUserIds = memberships.map((m) => m.userId);
  if (recipientUserIds.length === 0) return;

  const first = params.tasks[0];
  const title = `新客户需求 · ${params.channelName}`;
  const body =
    params.tasks.length === 1
      ? `#${first.number} ${first.title}`
      : `${params.tasks.length} 条新需求,例:#${first.number} ${first.title}`;
  const target: DeepLinkTarget = {
    type: 'mention_human',
    workroomId: params.workroomId,
    channelId: params.channelId,
    messageId: params.channelId,
    threadId: null,
  };
  await sendWebPushToUsers(recipientUserIds, {
    title,
    body,
    data: buildDeepLinkData(target, title, body),
  });
  console.log(
    `[notify-client-task] workroom=${params.workroomId.slice(0, 8)} channel=${params.channelId.slice(0, 8)} tasks=${params.tasks.length} recipients=${recipientUserIds.length}`,
  );
}

/**
 * Send a task-done push. Gated by notifyOnCompletion (completion-style signal).
 *
 * @param recipientUserIds cuid User.id list — typically every human OWNER member of the
 *   task's workroom (the people who care that work finished). Resolved by the caller.
 */
export async function notifyTaskDone(params: {
  recipientUserIds: string[];
  target: Omit<DeepLinkTarget, 'type'>;
  title: string;
  body: string;
}): Promise<void> {
  if (params.recipientUserIds.length === 0) return;

  const deviceIds = await resolveTargetDevices(params.recipientUserIds, /* requireCompletionPref */ true);
  if (deviceIds.length === 0) {
    console.log(`[notify-task-done] no completion-enabled devices for ${params.recipientUserIds.length} user(s)`);
    return;
  }

  const target: DeepLinkTarget = { ...params.target, type: 'task_done' };
  const payload: PushPayload = {
    title: params.title,
    body: params.body,
    data: buildDeepLinkData(target, params.title, params.body),
  };

  console.log(
    `[notify-task-done] message=${params.target.messageId.slice(0, 8)} recipients=${params.recipientUserIds.length} devices=${deviceIds.length}`,
  );
  for (const deviceId of deviceIds) {
    sendPushToDevice(deviceId, payload, db).catch((err) =>
      console.error('[notify-task-done] push failed', err),
    );
  }
}
