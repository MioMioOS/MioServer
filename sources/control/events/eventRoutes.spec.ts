/**
 * EventLog — write-before-broadcast + catch-up protocol unit tests.
 *
 * Verifies:
 * 1. Seq allocation: COALESCE(MAX, 0) + 1 is monotonic; each publish increments seq
 * 2. Catch-up: after_seq < current_max by ≤ 500 → returns delta
 * 3. Seq expired: after_seq too far behind → { seq_expired: true }
 * 4. Idempotency: same event_id publish → no-op (existing record returned)
 * 5. ClientCursor monotonicity: apply_seq / read_seq can only increase
 */
import { describe, it, expect } from 'vitest';

// ── Seq allocation simulator ──────────────────────────────────────────────────

interface SimEvent {
  event_id: string;
  workroom_id: string;
  seq: number;
  topic: string;
  payload: unknown;
  created_at: Date;
}

type EventStore = Map<string, SimEvent[]>; // workroom_id → events[]

function simulatePublish(
  store: EventStore,
  workroomId: string,
  event_id: string,
  topic: string,
  payload: unknown,
): { created: boolean; event: SimEvent } {
  // Idempotency: if event_id already exists, return existing
  const events = store.get(workroomId) ?? [];
  const existing = events.find((e) => e.event_id === event_id);
  if (existing) {
    return { created: false, event: existing };
  }

  // Seq allocation: COALESCE(MAX(seq), 0) + 1
  // In production: done inside a DB transaction with FOR UPDATE on workroom row
  const maxSeq = events.reduce((m, e) => Math.max(m, e.seq), 0);
  const nextSeq = maxSeq + 1;

  const newEvent: SimEvent = {
    event_id,
    workroom_id: workroomId,
    seq: nextSeq,
    topic,
    payload,
    created_at: new Date(),
  };

  events.push(newEvent);
  store.set(workroomId, events);
  return { created: true, event: newEvent };
}

const MAX_CATCH_UP_EVENTS = 500;

interface CatchUpExpired {
  seq_expired: true;
  reason: 'too_many_behind' | 'prune_gap';
  current_max_seq: number;
  min_retained_seq: number | null;
  events_behind: number;
}
interface CatchUpDelta {
  seq_expired: false;
  events: SimEvent[];
  events_behind: number;
  min_retained_seq: number | null;
}

function simulateCatchUp(
  store: EventStore,
  workroomId: string,
  afterSeq: number,
  limit: number = MAX_CATCH_UP_EVENTS,
): CatchUpExpired | CatchUpDelta {
  const events = store.get(workroomId) ?? [];

  const minRetained = events.length > 0 ? Math.min(...events.map((e) => e.seq)) : null;
  const maxSeq = events.length > 0 ? Math.max(...events.map((e) => e.seq)) : 0;
  const delta = events.filter((e) => e.seq > afterSeq);

  // Condition (a): too many events behind (volume)
  const tooManyBehind = delta.length > MAX_CATCH_UP_EVENTS;

  // Condition (b): prune gap — after_seq + 1 < min_retained_seq
  // Client's next expected seq (afterSeq + 1) is before the earliest we have.
  // Pruned events in the gap [afterSeq+1 .. minRetained-1] are lost.
  const prunedGap = afterSeq > 0 && minRetained !== null && (afterSeq + 1 < minRetained);

  if (tooManyBehind || prunedGap) {
    return {
      seq_expired: true,
      reason: prunedGap ? 'prune_gap' : 'too_many_behind',
      current_max_seq: maxSeq,
      min_retained_seq: minRetained,
      events_behind: delta.length,
    };
  }

  const slice = delta.slice(0, limit).sort((a, b) => a.seq - b.seq);
  return { seq_expired: false, events: slice, events_behind: delta.length, min_retained_seq: minRetained };
}

// ── ClientCursor monotonicity simulator ───────────────────────────────────────

interface SimCursor {
  apply_seq: number;
  read_seq: number;
}

function simulateCursorUpdate(cursor: SimCursor, newApply?: number, newRead?: number): SimCursor {
  return {
    apply_seq: Math.max(cursor.apply_seq, newApply ?? cursor.apply_seq),
    read_seq: Math.max(cursor.read_seq, newRead ?? cursor.read_seq),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('EventLog seq allocation — monotonic per workroom', () => {
  it('first event in an empty workroom gets seq=1', () => {
    const store: EventStore = new Map();
    const { event } = simulatePublish(store, 'wr-1', 'evt-a', 'task.created', {});
    expect(event.seq).toBe(1);
  });

  it('each publish increments seq by 1', () => {
    const store: EventStore = new Map();
    const e1 = simulatePublish(store, 'wr-2', 'evt-1', 'task.created', {});
    const e2 = simulatePublish(store, 'wr-2', 'evt-2', 'task.updated', {});
    const e3 = simulatePublish(store, 'wr-2', 'evt-3', 'action.fired', {});
    expect(e1.event.seq).toBe(1);
    expect(e2.event.seq).toBe(2);
    expect(e3.event.seq).toBe(3);
  });

  it('seq is per-workroom — two workrooms have independent sequences', () => {
    const store: EventStore = new Map();
    simulatePublish(store, 'wr-A', 'a1', 'task.created', {});
    simulatePublish(store, 'wr-A', 'a2', 'task.created', {});
    simulatePublish(store, 'wr-A', 'a3', 'task.created', {});
    simulatePublish(store, 'wr-B', 'b1', 'task.created', {});

    const eventsA = store.get('wr-A')!;
    const eventsB = store.get('wr-B')!;
    expect(eventsA[eventsA.length - 1].seq).toBe(3);
    expect(eventsB[0].seq).toBe(1);  // wr-B starts from 1 independently
  });

  it('sequential publishes never produce duplicate seq in same workroom', () => {
    const store: EventStore = new Map();
    for (let i = 0; i < 20; i++) {
      simulatePublish(store, 'wr-seq', `evt-${i}`, 'test.event', { i });
    }
    const events = store.get('wr-seq')!;
    const seqs = events.map((e) => e.seq);
    const uniqueSeqs = new Set(seqs);
    expect(uniqueSeqs.size).toBe(20);
    expect(seqs).toEqual([...Array(20)].map((_, i) => i + 1));
  });
});

describe('EventLog idempotency — same event_id is a no-op', () => {
  it('publishing same event_id twice returns the first event unchanged', () => {
    const store: EventStore = new Map();
    const r1 = simulatePublish(store, 'wr-idem', 'stable-id', 'task.created', { v: 1 });
    const r2 = simulatePublish(store, 'wr-idem', 'stable-id', 'task.updated', { v: 2 });

    expect(r1.created).toBe(true);
    expect(r2.created).toBe(false);
    expect(r2.event.seq).toBe(r1.event.seq);
    expect(r2.event.topic).toBe('task.created');  // original topic preserved
  });

  it('only one event is stored when same event_id is published twice', () => {
    const store: EventStore = new Map();
    simulatePublish(store, 'wr-idem2', 'dup-id', 'a.topic', {});
    simulatePublish(store, 'wr-idem2', 'dup-id', 'b.topic', {});
    expect(store.get('wr-idem2')!.length).toBe(1);
  });
});

describe('Catch-up protocol — after_seq delta', () => {
  it('returns empty delta when client is already at head', () => {
    const store: EventStore = new Map();
    simulatePublish(store, 'wr-cu', 'e1', 't', {});
    simulatePublish(store, 'wr-cu', 'e2', 't', {});
    const result = simulateCatchUp(store, 'wr-cu', 2);
    expect(result.seq_expired).toBe(false);
    if (!result.seq_expired) expect(result.events.length).toBe(0);
  });

  it('returns events after after_seq in ascending seq order', () => {
    const store: EventStore = new Map();
    for (let i = 0; i < 5; i++) simulatePublish(store, 'wr-cu2', `e${i}`, 't', { i });
    const result = simulateCatchUp(store, 'wr-cu2', 2);
    if (!result.seq_expired) {
      expect(result.events.length).toBe(3);  // seqs 3, 4, 5
      expect(result.events[0].seq).toBe(3);
      expect(result.events[2].seq).toBe(5);
    }
  });

  it('returns seq_expired when too many events missed (> 500)', () => {
    const store: EventStore = new Map();
    // Publish 501 events
    for (let i = 0; i < 501; i++) {
      simulatePublish(store, 'wr-cu3', `e${i}`, 't', {});
    }
    // Client claims it saw seq=0 (has missed all 501)
    const result = simulateCatchUp(store, 'wr-cu3', 0);
    expect(result.seq_expired).toBe(true);
    if (result.seq_expired) {
      expect(result.events_behind).toBe(501);
      expect(result.current_max_seq).toBe(501);
      expect(result.reason).toBe('too_many_behind');
    }
  });

  it('does NOT expire when exactly 500 events behind', () => {
    const store: EventStore = new Map();
    for (let i = 0; i < 500; i++) {
      simulatePublish(store, 'wr-cu4', `e${i}`, 't', {});
    }
    const result = simulateCatchUp(store, 'wr-cu4', 0);
    expect(result.seq_expired).toBe(false);
    if (!result.seq_expired) expect(result.events.length).toBe(500);
  });
});

describe('Catch-up — prune gap (seq_expired condition b)', () => {
  /**
   * Simulates a store where events 1-50 have been pruned.
   * Only events 51-100 are retained (min_retained = 51).
   */
  function makePrunedStore(workroomId: string): EventStore {
    const store: EventStore = new Map();
    // Publish 100 events, then simulate pruning by removing 1-50
    for (let i = 1; i <= 100; i++) {
      simulatePublish(store, workroomId, `e${i}`, 't', { seq: i });
    }
    // Simulate pruning: remove events 1-50
    const all = store.get(workroomId)!;
    store.set(workroomId, all.filter((e) => e.seq > 50));
    return store;
  }

  it('returns seq_expired=true with reason=prune_gap when after_seq is in pruned range', () => {
    const store = makePrunedStore('wr-prune');
    // Client last saw seq=10, but events 11-50 were pruned → gap!
    const result = simulateCatchUp(store, 'wr-prune', 10);
    expect(result.seq_expired).toBe(true);
    if (result.seq_expired) {
      expect(result.reason).toBe('prune_gap');
      expect(result.min_retained_seq).toBe(51);
      expect(result.current_max_seq).toBe(100);
    }
  });

  it('returns seq_expired=true even when events_behind <= 500 (pure prune gap)', () => {
    const store = makePrunedStore('wr-prune2');
    // Only 50 events retained (51-100), events_behind = 50 which is ≤ 500
    // But after_seq=10 is before min_retained=51 → still must expire
    const result = simulateCatchUp(store, 'wr-prune2', 10);
    expect(result.seq_expired).toBe(true);
    // This test is the Coinbyte-like "silent data loss" scenario the old code missed
  });

  it('returns delta (not expired) when after_seq == min_retained_seq - 1 (exact boundary)', () => {
    const store = makePrunedStore('wr-prune3');
    // after_seq = 50, min_retained = 51: client next expects 51, which exists → no gap
    const result = simulateCatchUp(store, 'wr-prune3', 50);
    expect(result.seq_expired).toBe(false);
    if (!result.seq_expired) {
      expect(result.events.length).toBe(50);  // events 51-100
      expect(result.events[0].seq).toBe(51);
    }
  });

  it('returns delta (not expired) when after_seq = 0 (fresh client, no history expected)', () => {
    const store = makePrunedStore('wr-prune4');
    // Client is new (after_seq=0): gets whatever is retained, no prune gap expectation
    const result = simulateCatchUp(store, 'wr-prune4', 0);
    expect(result.seq_expired).toBe(false);
    if (!result.seq_expired) expect(result.events.length).toBe(50);
  });

  it('returns seq_expired=true when after_seq is one before the gap boundary', () => {
    const store = makePrunedStore('wr-prune5');
    // after_seq = 49: next expected = 50, but min_retained = 51 → gap at seq=50
    const result = simulateCatchUp(store, 'wr-prune5', 49);
    expect(result.seq_expired).toBe(true);
    if (result.seq_expired) expect(result.reason).toBe('prune_gap');
  });

  it('reports min_retained_seq in seq_expired response for client to use as new baseline', () => {
    const store = makePrunedStore('wr-prune6');
    const result = simulateCatchUp(store, 'wr-prune6', 1);
    expect(result.seq_expired).toBe(true);
    if (result.seq_expired) {
      // Client uses current_max_seq as new baseline after reloading snapshot
      expect(result.current_max_seq).toBe(100);
      expect(result.min_retained_seq).toBe(51);
    }
  });
});

describe('ClientCursor monotonicity — apply_seq and read_seq only increase', () => {
  it('advancing apply_seq updates the cursor', () => {
    const cursor: SimCursor = { apply_seq: 10, read_seq: 8 };
    const updated = simulateCursorUpdate(cursor, 15);
    expect(updated.apply_seq).toBe(15);
    expect(updated.read_seq).toBe(8);
  });

  it('advancing read_seq updates the cursor', () => {
    const cursor: SimCursor = { apply_seq: 10, read_seq: 8 };
    const updated = simulateCursorUpdate(cursor, undefined, 10);
    expect(updated.apply_seq).toBe(10);
    expect(updated.read_seq).toBe(10);
  });

  it('stale apply_seq update (old seq) is ignored — cursor stays at higher value', () => {
    const cursor: SimCursor = { apply_seq: 100, read_seq: 90 };
    const updated = simulateCursorUpdate(cursor, 50);  // 50 < 100 → ignored
    expect(updated.apply_seq).toBe(100);  // unchanged
  });

  it('stale read_seq update is ignored', () => {
    const cursor: SimCursor = { apply_seq: 100, read_seq: 90 };
    const updated = simulateCursorUpdate(cursor, undefined, 5);  // 5 < 90 → ignored
    expect(updated.read_seq).toBe(90);
  });

  it('can update both apply_seq and read_seq simultaneously', () => {
    const cursor: SimCursor = { apply_seq: 10, read_seq: 5 };
    const updated = simulateCursorUpdate(cursor, 20, 15);
    expect(updated.apply_seq).toBe(20);
    expect(updated.read_seq).toBe(15);
  });

  it('apply_seq >= read_seq is not enforced by schema (separate concerns)', () => {
    // read_seq can temporarily be ahead of apply_seq (pre-read events not yet applied)
    const cursor: SimCursor = { apply_seq: 10, read_seq: 5 };
    const updated = simulateCursorUpdate(cursor, 10, 20);  // read ahead of apply
    expect(updated.apply_seq).toBe(10);
    expect(updated.read_seq).toBe(20);
  });
});

describe('Write-before-broadcast contract', () => {
  it('event is in the store before any fanout (simulated by checking store after publish)', () => {
    const store: EventStore = new Map();
    const { event } = simulatePublish(store, 'wr-wbb', 'fanout-evt', 'message.created', { text: 'hello' });
    // In production: fanout happens AFTER DB commit. Here: event is in store = "persisted".
    // Any subscriber reading from the store after this point sees the event.
    const stored = store.get('wr-wbb')!.find((e) => e.event_id === 'fanout-evt');
    expect(stored).toBeDefined();
    expect(stored?.seq).toBe(event.seq);
  });

  it('seq numbers survive concurrent publishes — unique per workroom', () => {
    // Simulates two "concurrent" publishes to the same workroom.
    // In real DB: row lock on workroom serializes them.
    // In sim: sequential execution ensures they get different seqs.
    const store: EventStore = new Map();
    const r1 = simulatePublish(store, 'wr-conc', 'c1', 'a', {});
    const r2 = simulatePublish(store, 'wr-conc', 'c2', 'b', {});
    expect(r1.event.seq).not.toBe(r2.event.seq);
    expect(new Set([r1.event.seq, r2.event.seq]).size).toBe(2);
  });
});
