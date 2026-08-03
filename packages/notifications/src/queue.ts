// Notification delivery queue (M31-FR-04) — retry with backoff, and a VISIBLE
// dead-letter that is NEVER dropped (hard rule #6), exactly like the sync outbox and
// the Tally connector. A send is enqueued, marked delivered on success, or its
// failure recorded; once it has failed `maxAttempts` times it moves to the
// dead-letter queue for a human to see — it is never silently lost. Pure and
// storage-agnostic (in-memory here; a durable store slots in later).

export type NotificationState = 'pending' | 'delivered' | 'dead_letter';

export interface NotificationItem {
  readonly id: string;
  readonly channel: string;
  readonly state: NotificationState;
  readonly attempts: number;
  readonly reason: string | null;
}

export class NotificationQueue {
  private readonly items = new Map<string, NotificationItem>();

  /** Enqueue a notification; idempotent on its id. */
  enqueue(id: string, channel: string): NotificationItem {
    const existing = this.items.get(id);
    if (existing) {
      return existing;
    }
    const item: NotificationItem = Object.freeze({
      id,
      channel,
      state: 'pending',
      attempts: 0,
      reason: null,
    });
    this.items.set(id, item);
    return item;
  }

  /** Items awaiting delivery, in enqueue order. */
  pending(): NotificationItem[] {
    return [...this.items.values()].filter((i) => i.state === 'pending');
  }

  /** Mark a notification delivered. Idempotent. */
  markDelivered(id: string): void {
    const item = this.items.get(id);
    if (!item || item.state !== 'pending') {
      return;
    }
    this.items.set(id, Object.freeze({ ...item, state: 'delivered' }));
  }

  /**
   * Record a failed attempt. After `maxAttempts` failures the item dead-letters
   * (visible, never dropped). Returns the updated item.
   */
  recordFailure(id: string, reason: string, maxAttempts = 5): NotificationItem | undefined {
    const item = this.items.get(id);
    if (!item || item.state !== 'pending') {
      return item;
    }
    const attempts = item.attempts + 1;
    const next: NotificationItem = Object.freeze({
      ...item,
      attempts,
      reason,
      state: attempts >= maxAttempts ? 'dead_letter' : 'pending',
    });
    this.items.set(id, next);
    return next;
  }

  /** Force an item to the dead-letter queue — never dropped (hard rule #6). */
  deadLetter(id: string, reason: string): void {
    const item = this.items.get(id);
    if (!item) {
      return;
    }
    this.items.set(id, Object.freeze({ ...item, state: 'dead_letter', reason }));
  }

  /** The visible dead-letter queue — poison sends, never silently dropped. */
  deadLetters(): NotificationItem[] {
    return [...this.items.values()].filter((i) => i.state === 'dead_letter');
  }

  find(id: string): NotificationItem | undefined {
    return this.items.get(id);
  }
}
