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
