// Offline sync outbox — the store-edge → cloud sync queue behind P-01 (offline
// first) and §31 (durable outbox, idempotent drain, a visible unsent count, and
// dead-letter). A locally-committed event is enqueued; the sync agent drains the
// pending items to cloud and acknowledges each; an item that repeatedly fails to
// apply moves to a VISIBLE dead-letter queue and is NEVER dropped (hard rule #6).
// Pure and storage-agnostic (in-memory here; a durable edge store slots in later).

import type { DomainEvent } from '../../contracts/src/event';

export type OutboxState = 'pending' | 'acknowledged' | 'dead_letter';

/** A queued item: the event, its sync state, attempt count and (if dead) a reason. */
export interface OutboxItem<TType extends string = string, TPayload = unknown> {
  /** The event's idempotency key — the dedupe identity in the outbox. */
  readonly key: string;
  readonly event: DomainEvent<TType, TPayload>;
  readonly state: OutboxState;
  readonly attempts: number;
  readonly reason: string | null;
}

export class SyncOutbox<TType extends string = string, TPayload = unknown> {
  // Map preserves insertion order, so reads come back in enqueue order.
  private readonly items = new Map<string, OutboxItem<TType, TPayload>>();

  /** Enqueue a locally-committed event; idempotent on its idempotency key. */
  enqueue(event: DomainEvent<TType, TPayload>): OutboxItem<TType, TPayload> {
    const existing = this.items.get(event.idempotencyKey);
    if (existing) {
      return existing; // already queued or handled — one effect (§31.1)
    }
    const item: OutboxItem<TType, TPayload> = Object.freeze({
      key: event.idempotencyKey,
      event,
      state: 'pending',
      attempts: 0,
      reason: null,
    });
    this.items.set(event.idempotencyKey, item);
    return item;
  }

  /** Items awaiting sync, in enqueue order. */
  pending(): OutboxItem<TType, TPayload>[] {
    return [...this.items.values()].filter((i) => i.state === 'pending');
  }

  /** The §27.1 unsent-count badge (pending items only). */
  unsentCount(): number {
    return this.pending().length;
  }

  /** Mark an item successfully synced (advance the watermark). Idempotent. */
  acknowledge(key: string): void {
    const item = this.items.get(key);
    if (!item || item.state !== 'pending') {
      return;
    }
    this.items.set(key, Object.freeze({ ...item, state: 'acknowledged' }));
  }

  /** Record a failed sync attempt; returns the new attempt count. */
  recordFailure(key: string): number {
    const item = this.items.get(key);
    if (!item || item.state !== 'pending') {
      return item?.attempts ?? 0;
    }
    const updated: OutboxItem<TType, TPayload> = Object.freeze({
      ...item,
      attempts: item.attempts + 1,
    });
    this.items.set(key, updated);
    return updated.attempts;
  }

  /** Move a poison item to the dead-letter queue — never dropped (hard rule #6). */
  deadLetter(key: string, reason: string): void {
    const item = this.items.get(key);
    if (!item) {
      return;
    }
    this.items.set(key, Object.freeze({ ...item, state: 'dead_letter', reason }));
  }

  /** The visible dead-letter queue — poison items, never silently dropped. */
  deadLetters(): OutboxItem<TType, TPayload>[] {
    return [...this.items.values()].filter((i) => i.state === 'dead_letter');
  }

  /** Look up any item (pending, acknowledged or dead-lettered) by key. */
  find(key: string): OutboxItem<TType, TPayload> | undefined {
    return this.items.get(key);
  }

  /**
   * Every item ever enqueued in this run, **in enqueue order**, whatever state it reached.
   *
   * The order is the point. It is what lets the edge advance a durable cursor over the *contiguous*
   * finished prefix — and only the contiguous one, because a sale still pending in the middle must
   * hold the cursor where it is or the next restart would step over it and that sale would be gone
   * with nothing saying so.
   */
  all(): OutboxItem<TType, TPayload>[] {
    return [...this.items.values()];
  }
}
