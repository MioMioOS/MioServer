/**
 * WorkroomBroadcaster — control plane WS fanout.
 *
 * HARD CONSTRAINTS (per spec §6.1 + 运维 review):
 * 1. Write-before-broadcast: this module ONLY broadcasts events that are
 *    already persisted. It is NEVER called before DB commit.
 * 2. Fanout failure is non-fatal: a dropped push is recoverable via the
 *    catch-up protocol (GET /events?after_seq=N). The persisted event
 *    is the source of truth; push is a latency optimization.
 * 3. Scope-aware delivery: a connection subscribes to a specific workroom.
 *    It receives events for that workroom only.
 * 4. No global broadcast: events are scoped to workroom membership.
 *    Cross-workroom fanout is NOT performed here.
 *
 * Lifecycle:
 *   - Client WS connects → calls broadcaster.subscribe(workroomId, conn)
 *   - publishControlEvent commits → caller calls broadcaster.broadcast(workroomId, event)
 *   - Client WS disconnects → calls broadcaster.unsubscribe(workroomId, conn)
 *
 * This is a singleton (module-level export). All route handlers share it.
 */

import type { Socket } from 'socket.io';

export interface WorkroomSubscriber {
  /** The socket.io socket for this connection. */
  socket: Socket;
  /** Agent or machine session context (for logging). */
  context?: string;
}

/** The WS event name clients receive for new control plane events. */
export const WORKROOM_EVENT_TOPIC = 'workroom:event';

export class WorkroomBroadcaster {
  // workroomId → Set<WorkroomSubscriber>
  private subscriptions = new Map<string, Set<WorkroomSubscriber>>();

  /**
   * Register a connection as interested in events for this workroom.
   * Called when a WS client sends a "subscribe" message after connecting.
   */
  subscribe(workroomId: string, subscriber: WorkroomSubscriber): void {
    if (!this.subscriptions.has(workroomId)) {
      this.subscriptions.set(workroomId, new Set());
    }
    this.subscriptions.get(workroomId)!.add(subscriber);
    console.log(`[WorkroomBroadcaster] subscribed workroom=${workroomId} total=${this.subscriptions.get(workroomId)!.size}`);
  }

  /**
   * Remove a connection from all workrooms it was subscribed to.
   * Called on WS disconnect.
   */
  unsubscribeAll(subscriber: WorkroomSubscriber): void {
    let count = 0;
    for (const [workroomId, subs] of this.subscriptions.entries()) {
      if (subs.delete(subscriber)) {
        count++;
        if (subs.size === 0) this.subscriptions.delete(workroomId);
      }
    }
    if (count > 0) {
      console.log(`[WorkroomBroadcaster] unsubscribed from ${count} workroom(s)`);
    }
  }

  /**
   * Remove a connection from a specific workroom subscription.
   */
  unsubscribe(workroomId: string, subscriber: WorkroomSubscriber): void {
    const subs = this.subscriptions.get(workroomId);
    if (!subs) return;
    subs.delete(subscriber);
    if (subs.size === 0) this.subscriptions.delete(workroomId);
  }

  /**
   * Broadcast a persisted event to all subscribers of a workroom.
   *
   * MUST be called AFTER the event is committed to DB (write-before-broadcast).
   * Fanout failure is non-fatal — log and continue. Clients use catch-up to recover.
   *
   * @param workroomId  The workroom this event belongs to.
   * @param eventPayload  The serializable event object to push to clients.
   */
  broadcast(workroomId: string, eventPayload: WorkroomEventPayload): void {
    const subs = this.subscriptions.get(workroomId);
    if (!subs || subs.size === 0) return;

    let sent = 0;
    let failed = 0;
    for (const sub of subs) {
      try {
        sub.socket.emit(WORKROOM_EVENT_TOPIC, eventPayload);
        sent++;
      } catch (err) {
        // Non-fatal: this subscriber's socket errored. Remove it and log.
        // The client will catch up via GET /events?after_seq=N on reconnect.
        failed++;
        console.error(`[WorkroomBroadcaster] emit failed (workroom=${workroomId}), removing subscriber:`, (err as Error)?.message);
        subs.delete(sub);
      }
    }
    if (subs.size === 0) this.subscriptions.delete(workroomId);

    console.log(`[WorkroomBroadcaster] broadcast workroom=${workroomId} sent=${sent} failed=${failed}`);
  }

  /** Current subscriber count for a workroom (useful for health checks + tests). */
  subscriberCount(workroomId: string): number {
    return this.subscriptions.get(workroomId)?.size ?? 0;
  }

  /** Total subscriber count across all workrooms. */
  totalSubscriberCount(): number {
    let total = 0;
    for (const subs of this.subscriptions.values()) total += subs.size;
    return total;
  }
}

/** Shape of the event pushed to WS subscribers. Mirrors the HTTP GET /events response entry. */
export interface WorkroomEventPayload {
  event_id: string;
  workroom_id: string;
  seq: string;           // BigInt as string — JSON-safe
  topic: string;
  payload: Record<string, unknown>;
  created_at: string;    // ISO 8601
}

/** Singleton instance — imported by eventRoutes.ts and wsGateway.ts */
export const workroomBroadcaster = new WorkroomBroadcaster();
