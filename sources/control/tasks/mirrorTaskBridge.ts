/**
 * mirrorTaskBridge — 客户频道任务桥(07-09)。
 *
 * 场景:客户在 client 类型频道向需求顾问提需求 → 顾问批准制立「需求单」→
 * 真人点「派发」在内部频道生成镜像任务(mirrorOfTaskId 指向需求单)→ 内部
 * 任务状态变化单向回流到需求单,并在客户频道发一行干净的进度语。
 *
 * 保密边界:回流只携带粗粒度状态词,内部 thread/标题变化/评审细节一概不过桥。
 * 防环:需求单自身没有 mirrorOfTaskId,回流更新它不会再次触发回流。
 */

import { db } from '@/storage/db';
import { insertSystemMessage } from '@/control/messages/insertSystemMessage';
import { writeEventAndBroadcast } from '@/control/messages/writeEventAndBroadcast';
import { writeTaskEventAndBroadcast } from './writeTaskEventAndBroadcast';
import { serverToSlockStatus } from './slockTaskStatus';

/** 内部状态 → 客户可见的粗粒度状态。in_review 对客户仍是「开发中」——内部
 *  评审是实现细节,不该让客户产生"要我验收了"的误解。 */
const CLIENT_STATUS: Record<string, { status: string; note: string }> = {
  in_progress: { status: 'in_progress', note: '已进入开发' },
  in_review: { status: 'in_progress', note: '开发中(内部核对)' },
  done: { status: 'done', note: '已完成,可以体验了' },
  canceled: { status: 'canceled', note: '已取消' },
  closed: { status: 'closed', note: '已关闭' },
};

/**
 * 内部任务状态变化 → 回流到源需求单。由状态更新路径调用,best-effort:
 * 桥故障绝不影响内部任务本身的写入。
 */
export async function syncMirrorSource(taskId: string, newStatus: string): Promise<void> {
  try {
    const task = await db.controlTask.findUnique({
      where: { id: taskId },
      select: { mirrorOfTaskId: true, workroomId: true },
    });
    if (!task?.mirrorOfTaskId) return;
    const map = CLIENT_STATUS[newStatus];
    if (!map) return;

    const source = await db.controlTask.findUnique({
      where: { id: task.mirrorOfTaskId },
      select: { id: true, number: true, status: true, channelId: true, workroomId: true },
    });
    if (!source || !source.channelId || source.status === map.status) return;

    await db.controlTask.update({ where: { id: source.id }, data: { status: map.status } });
    await writeTaskEventAndBroadcast({
      workroomId: source.workroomId,
      topic: 'task.status_changed',
      payload: {
        task_id: source.id,
        channel_id: source.channelId,
        from: serverToSlockStatus(source.status),
        to: serverToSlockStatus(map.status),
        status: map.status,
        source: 'mirror-bridge',
      },
    });
    // 客户频道的干净进度语(不走全景摘要——客户不需要看内部任务面板)。
    const row = await insertSystemMessage({
      workroomId: source.workroomId,
      channelId: source.channelId,
      content: `📌 需求 #${source.number ?? '?'} ${map.note}`,
    });
    await writeEventAndBroadcast({
      id: row.id,
      seq: row.seq,
      created_at: row.created_at,
      workroomId: source.workroomId,
      channelId: source.channelId,
      senderKind: 'system',
      senderId: 'system',
      content: row.content,
      mentions: [],
    });
    console.info(`[mirrorTaskBridge] synced source=#${source.number} ← ${newStatus}`);
  } catch (err) {
    console.warn('[mirrorTaskBridge] sync failed (non-fatal)', err instanceof Error ? err.message : err);
  }
}
