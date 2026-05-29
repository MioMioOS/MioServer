import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { writeTaskEventAndBroadcast } from './writeTaskEventAndBroadcast';

const ORG_ID = randomUUID();
const WORKROOM_ID = randomUUID();

beforeAll(async () => {
  await db.controlOrg.create({ data: { id: ORG_ID, name: 'WTEB Org', slug: `wteb-${randomUUID()}`, ownerUserId: randomUUID() } });
  await db.controlWorkroom.create({ data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'WTEB WR', createdBy: randomUUID() } });
});

afterAll(async () => {
  await db.controlEventLog.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlWorkroom.deleteMany({ where: { id: WORKROOM_ID } });
  await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
  await db.$disconnect();
});

describe('writeTaskEventAndBroadcast (shared module)', () => {
  it('writes a task.updated event row with the given payload', async () => {
    const taskId = randomUUID();
    await writeTaskEventAndBroadcast({
      workroomId: WORKROOM_ID,
      topic: 'task.updated',
      payload: { task_id: taskId, channel_id: 'ch_1', status: 'IN_PROGRESS', assignee_id: 'ag_1' },
    });
    const event = await db.controlEventLog.findFirst({ where: { workroomId: WORKROOM_ID, topic: 'task.updated' }, orderBy: { createdAt: 'desc' } });
    expect(event).not.toBeNull();
    const payload = event!.payloadJson as Record<string, unknown>;
    expect(payload.task_id).toBe(taskId);
    expect(payload.channel_id).toBe('ch_1');
    expect(payload.status).toBe('IN_PROGRESS');
    expect(payload.assignee_id).toBe('ag_1');
  });

  it('accepts task.created topic', async () => {
    await writeTaskEventAndBroadcast({
      workroomId: WORKROOM_ID, topic: 'task.created',
      payload: { task_id: randomUUID(), channel_id: 'ch_2', status: 'TODO', assignee_id: null },
    });
    const event = await db.controlEventLog.findFirst({ where: { workroomId: WORKROOM_ID, topic: 'task.created' }, orderBy: { createdAt: 'desc' } });
    expect(event).not.toBeNull();
  });
});
