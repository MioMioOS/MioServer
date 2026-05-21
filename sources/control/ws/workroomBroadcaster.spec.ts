import { describe, it, expect, vi } from 'vitest';
import { WorkroomBroadcaster, WorkroomEventPayload, WorkroomSubscriber } from './workroomBroadcaster';

function makeSubscriber(id: string = 'conn-1'): WorkroomSubscriber & { emitSpy: ReturnType<typeof vi.fn> } {
  const emitSpy = vi.fn();
  return {
    socket: { emit: emitSpy } as any,
    context: id,
    emitSpy,
  };
}

const SAMPLE_EVENT: WorkroomEventPayload = {
  event_id: 'evt-1',
  workroom_id: 'wroom-1',
  seq: '42',
  topic: 'task.updated',
  payload: { task_id: 'task-1', status: 'in_progress' },
  created_at: '2026-05-21T10:00:00Z',
};

// ─── subscribe / unsubscribe ──────────────────────────────────────────────────

describe('WorkroomBroadcaster — subscription management', () => {
  it('starts with 0 subscribers', () => {
    const b = new WorkroomBroadcaster();
    expect(b.subscriberCount('wroom-1')).toBe(0);
    expect(b.totalSubscriberCount()).toBe(0);
  });

  it('subscribe adds a subscriber', () => {
    const b = new WorkroomBroadcaster();
    const sub = makeSubscriber();
    b.subscribe('wroom-1', sub);
    expect(b.subscriberCount('wroom-1')).toBe(1);
  });

  it('multiple subscribers for same workroom', () => {
    const b = new WorkroomBroadcaster();
    b.subscribe('wroom-1', makeSubscriber('a'));
    b.subscribe('wroom-1', makeSubscriber('b'));
    expect(b.subscriberCount('wroom-1')).toBe(2);
    expect(b.totalSubscriberCount()).toBe(2);
  });

  it('subscribers for different workrooms are isolated', () => {
    const b = new WorkroomBroadcaster();
    b.subscribe('wroom-1', makeSubscriber('a'));
    b.subscribe('wroom-2', makeSubscriber('b'));
    expect(b.subscriberCount('wroom-1')).toBe(1);
    expect(b.subscriberCount('wroom-2')).toBe(1);
    expect(b.totalSubscriberCount()).toBe(2);
  });

  it('unsubscribe removes specific subscriber', () => {
    const b = new WorkroomBroadcaster();
    const sub1 = makeSubscriber('a');
    const sub2 = makeSubscriber('b');
    b.subscribe('wroom-1', sub1);
    b.subscribe('wroom-1', sub2);
    b.unsubscribe('wroom-1', sub1);
    expect(b.subscriberCount('wroom-1')).toBe(1);
  });

  it('unsubscribe removes workroom entry when last subscriber leaves', () => {
    const b = new WorkroomBroadcaster();
    const sub = makeSubscriber();
    b.subscribe('wroom-1', sub);
    b.unsubscribe('wroom-1', sub);
    expect(b.subscriberCount('wroom-1')).toBe(0);
  });

  it('unsubscribeAll removes subscriber from all workrooms', () => {
    const b = new WorkroomBroadcaster();
    const sub = makeSubscriber();
    b.subscribe('wroom-1', sub);
    b.subscribe('wroom-2', sub);
    expect(b.totalSubscriberCount()).toBe(2);
    b.unsubscribeAll(sub);
    expect(b.totalSubscriberCount()).toBe(0);
  });

  it('unsubscribe on unknown workroom is a no-op', () => {
    const b = new WorkroomBroadcaster();
    const sub = makeSubscriber();
    expect(() => b.unsubscribe('nonexistent', sub)).not.toThrow();
  });
});

// ─── broadcast ───────────────────────────────────────────────────────────────

describe('WorkroomBroadcaster — broadcast', () => {
  it('delivers event to all subscribers of the workroom', () => {
    const b = new WorkroomBroadcaster();
    const sub1 = makeSubscriber('a');
    const sub2 = makeSubscriber('b');
    b.subscribe('wroom-1', sub1);
    b.subscribe('wroom-1', sub2);

    b.broadcast('wroom-1', SAMPLE_EVENT);

    expect(sub1.emitSpy).toHaveBeenCalledWith('workroom:event', SAMPLE_EVENT);
    expect(sub2.emitSpy).toHaveBeenCalledWith('workroom:event', SAMPLE_EVENT);
  });

  it('does NOT deliver to subscribers of a different workroom', () => {
    const b = new WorkroomBroadcaster();
    const sub1 = makeSubscriber('wroom1-sub');
    const sub2 = makeSubscriber('wroom2-sub');
    b.subscribe('wroom-1', sub1);
    b.subscribe('wroom-2', sub2);

    b.broadcast('wroom-1', SAMPLE_EVENT);

    expect(sub1.emitSpy).toHaveBeenCalled();
    expect(sub2.emitSpy).not.toHaveBeenCalled();
  });

  it('broadcast to workroom with no subscribers is a no-op', () => {
    const b = new WorkroomBroadcaster();
    expect(() => b.broadcast('wroom-empty', SAMPLE_EVENT)).not.toThrow();
  });

  it('failed emit is non-fatal — removes bad subscriber and continues', () => {
    const b = new WorkroomBroadcaster();
    const goodSub = makeSubscriber('good');
    const badSub: WorkroomSubscriber = {
      socket: { emit: vi.fn().mockImplementation(() => { throw new Error('socket closed'); }) } as any,
      context: 'bad',
    };
    b.subscribe('wroom-1', goodSub);
    b.subscribe('wroom-1', badSub);

    // Must not throw even though badSub.socket.emit throws
    expect(() => b.broadcast('wroom-1', SAMPLE_EVENT)).not.toThrow();

    // Good subscriber still received the event
    expect(goodSub.emitSpy).toHaveBeenCalledWith('workroom:event', SAMPLE_EVENT);

    // Bad subscriber is removed (non-fatal cleanup)
    expect(b.subscriberCount('wroom-1')).toBe(1);
  });

  it('write-before-broadcast contract: broadcast carries the same payload passed in', () => {
    // This test asserts the broadcaster is a pure relay — it does NOT modify
    // the event payload. The caller (eventRoutes.ts) is responsible for only
    // calling broadcast AFTER the event is committed to DB.
    const b = new WorkroomBroadcaster();
    const sub = makeSubscriber();
    b.subscribe('wroom-1', sub);

    const event: WorkroomEventPayload = {
      event_id: 'evt-99',
      workroom_id: 'wroom-1',
      seq: '100',
      topic: 'action.fired',
      payload: { action_id: 'act-1', kind: 'deploy' },
      created_at: '2026-05-21T11:00:00.000Z',
    };

    b.broadcast('wroom-1', event);

    const received = sub.emitSpy.mock.calls[0][1] as WorkroomEventPayload;
    // Exact payload reference — no modification
    expect(received).toBe(event);
    expect(received.seq).toBe('100');
    expect(received.topic).toBe('action.fired');
  });

  it('idempotent events should NOT be broadcast (caller responsibility)', () => {
    // The broadcaster itself does not know about idempotency — that check
    // is in eventRoutes.ts: `if (!event.idempotent) { broadcaster.broadcast(...) }`.
    // This test documents the expected integration pattern.
    const b = new WorkroomBroadcaster();
    const sub = makeSubscriber();
    b.subscribe('wroom-1', sub);

    // Simulating: eventRoutes.ts skips broadcast for idempotent retries.
    // If broadcast IS called (incorrectly), the subscriber receives a duplicate.
    // This test just confirms broadcast is a dumb relay — the caller MUST gate it.
    b.broadcast('wroom-1', SAMPLE_EVENT);
    expect(sub.emitSpy).toHaveBeenCalledTimes(1);

    // Second broadcast (simulating bad caller) → duplicate delivery
    b.broadcast('wroom-1', SAMPLE_EVENT);
    expect(sub.emitSpy).toHaveBeenCalledTimes(2); // Broadcaster has no dedup — caller must gate
  });
});
