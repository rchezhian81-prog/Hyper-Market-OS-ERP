// Store-edge sync agent (P-01 / §31 / hard rules #6 and #10) — the piece that
// carries locally-committed work to the cloud once there is a connection, and makes
// the state of that honest.
//
// It never touches the sale path: the POS commits locally and enqueues (hard rule
// #1); this agent drains that queue afterwards. Its guarantees:
//   • ORDER — pending items drain in enqueue order, so cause precedes effect;
//   • IDEMPOTENT — delivery is keyed on the event's idempotency key, so a retry
//     after an ambiguous failure collapses to one effect in the cloud (§31.1);
//   • NEVER DROPPED — a transient failure keeps the item queued with its attempt
//     count; a permanent rejection (or exhausting the attempt budget) moves it to
//     the VISIBLE dead-letter queue, never silent discard (hard rule #6). A cloud
//     conflict is a rejection, so it becomes an exception rather than a
//     last-write-wins overwrite (hard rule #10);
//   • STOPS EARLY WHEN OFFLINE — consecutive transient failures end the pass
//     instead of hammering a dead link; the caller retries later with backoff;
//   • HONEST — every pass returns exactly what happened, and `health()` exposes the
//     unsent/dead-letter counts and the last success, so sync lag is visible (P-08).
//
// Deterministic and clock-free: `at` is supplied by the caller and backoff is a pure
// function, so the whole agent is testable without timers or a network.

import type { SyncOutbox } from '../../../packages/sync/src/outbox';
import type { SyncTransport } from './transport';

export interface DrainOptions {
  /** ISO-8601 UTC time of this pass (injected — the agent has no clock). */
  readonly at: string;
  /** Maximum items to attempt in one pass (keeps a pass bounded). */
  readonly limit?: number;
  /** Attempts before a repeatedly-failing item is dead-lettered. */
  readonly maxAttempts?: number;
  /** Consecutive transient failures that end the pass (the link looks down). */
  readonly stopAfterConsecutiveFailures?: number;
}

export interface DrainResult {
  readonly attempted: number;
  readonly acknowledged: number;
  readonly retryable: number;
  readonly deadLettered: number;
  /** True when the pass ended early because the link looked down. */
  readonly stoppedEarly: boolean;
  /** Items still queued after this pass. */
  readonly remaining: number;
}

export interface SyncHealth {
  /** Locally-committed items not yet in the cloud — the badge on every surface. */
  readonly unsentCount: number;
  /** Poison items awaiting a human — never silently dropped. */
  readonly deadLetterCount: number;
  /** When a drain last delivered something, or null if never. */
  readonly lastSuccessAt: string | null;
}

const DEFAULTS = {
  limit: 100,
  maxAttempts: 5,
  stopAfterConsecutiveFailures: 3,
} as const;

/**
 * Exponential backoff with a ceiling: 1s, 2s, 4s, 8s… capped at 5 minutes. Pure, so
 * the schedule is testable; the caller (a timer or the app's scheduler) does the
 * waiting — the agent itself never sleeps.
 */
export function nextDelayMs(attempts: number, baseMs = 1000, capMs = 300_000): number {
  if (!Number.isSafeInteger(attempts) || attempts < 0) {
    throw new RangeError(`attempts must be a non-negative integer, got ${attempts}.`);
  }
  const raw = baseMs * 2 ** Math.min(attempts, 30);
  return Math.min(raw, capMs);
}

export class SyncAgent {
  private lastSuccessAt: string | null = null;

  constructor(
    private readonly outbox: SyncOutbox,
    private readonly transport: SyncTransport,
  ) {}

  /** The sync-health figures every surface shows (P-08). */
  health(): SyncHealth {
    return {
      unsentCount: this.outbox.unsentCount(),
      deadLetterCount: this.outbox.deadLetters().length,
      lastSuccessAt: this.lastSuccessAt,
    };
  }

  /**
   * Drain pending items to the cloud. Returns what happened; never throws for a
   * delivery failure (a failure is an outcome to report, not a crash). A transport
   * that throws is treated as a transient failure, so an unexpected error can never
   * lose an item.
   */
  async drain(options: DrainOptions): Promise<DrainResult> {
    const limit = options.limit ?? DEFAULTS.limit;
    const maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
    const stopAfter = options.stopAfterConsecutiveFailures ?? DEFAULTS.stopAfterConsecutiveFailures;

    // Snapshot the queue in enqueue order, so a pass is bounded and predictable.
    const batch = this.outbox.pending().slice(0, limit);

    let attempted = 0;
    let acknowledged = 0;
    let retryable = 0;
    let deadLettered = 0;
    let consecutiveFailures = 0;
    let stoppedEarly = false;

    for (const item of batch) {
      attempted += 1;

      let outcome;
      try {
        outcome = await this.transport.send(item.event);
      } catch (err) {
        // An unexpected transport error is transient by default — never lose work.
        outcome = {
          status: 'retryable' as const,
          reason: err instanceof Error ? err.message : 'transport error',
        };
      }

      if (outcome.status === 'accepted') {
        this.outbox.acknowledge(item.key);
        acknowledged += 1;
        consecutiveFailures = 0;
        this.lastSuccessAt = options.at;
        continue;
      }

      if (outcome.status === 'rejected') {
        // Permanent: a human must look at it. Visible, never discarded.
        this.outbox.deadLetter(item.key, outcome.reason);
        deadLettered += 1;
        consecutiveFailures = 0; // the link is fine; this item is the problem
        continue;
      }

      // Transient: keep it queued, count the attempt, and dead-letter once the
      // attempt budget is exhausted (still visible, still not dropped).
      const attempts = this.outbox.recordFailure(item.key);
      if (attempts >= maxAttempts) {
        this.outbox.deadLetter(item.key, `retry limit reached: ${outcome.reason}`);
        deadLettered += 1;
      } else {
        retryable += 1;
      }

      consecutiveFailures += 1;
      if (consecutiveFailures >= stopAfter) {
        // The link looks down — stop this pass rather than hammering it.
        stoppedEarly = true;
        break;
      }
    }

    return {
      attempted,
      acknowledged,
      retryable,
      deadLettered,
      stoppedEarly,
      remaining: this.outbox.unsentCount(),
    };
  }
}
