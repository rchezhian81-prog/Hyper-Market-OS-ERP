// Tally connector with retry and a visible dead-letter queue (M23-FR-04 / §4.2 / M32).
//
// The single most important thing about this connector is what it is **not**: Tally is
// a **destination, not the book of record**. Our append-only ledger is the truth; Tally
// is where a copy of it goes so the CA can work in the software they already use. That
// ordering decides everything else, because the failure people actually hit is the
// reverse assumption — a posting fails, somebody "fixes it in Tally", and now two
// systems disagree and neither knows it.
//
// So:
//   • **A FAILED POSTING NEVER CHANGES OUR NUMBERS.** It queues, it retries, and if it
//     keeps failing it lands in a dead-letter queue that is **visible and never
//     drained by deletion** (hard rule #6, §4.2). The shop's own accounts are unaffected
//     and unambiguous throughout.
//   • **POSTING IS IDEMPOTENT AND VERSIONED.** The same journal posted twice is one
//     voucher in Tally. Without that, every retry after an ambiguous timeout doubles the
//     month's revenue — and the ambiguous timeout is the normal case, not the edge case.
//   • **AN UNKNOWN OUTCOME IS NOT A SUCCESS.** Same rule as the payment reversal
//     (M13-FR-04): if the connector cannot tell whether Tally accepted it, it retries,
//     and idempotency makes that safe. It never marks a posting done on a guess.
//   • **A REJECTION IS NOT A RETRY.** Tally refusing a voucher because the ledger name
//     does not exist will refuse it identically a thousand times. Retrying a permanent
//     rejection burns the attempt budget and buries the one item a human needs to see.
//
// Pure and deterministic: the connector is a port, the clock is injected, backoff is
// computed rather than slept.

export type PostingState = 'queued' | 'posted' | 'dead_lettered';

export interface QueuedPosting {
  readonly postingId: string;
  /** Idempotency key sent to Tally — the same journal always produces the same key. */
  readonly idempotencyKey: string;
  readonly period: string;
  readonly journalRef: string;
  /** Sum of the debit legs in minor units, used for control totals. */
  readonly debitMinor: number;
  readonly creditMinor: number;
  readonly state: PostingState;
  readonly attempts: number;
  readonly queuedAt: string;
  readonly lastAttemptAt?: string;
  readonly postedAt?: string;
  /** Tally's own voucher reference, once it gives one. */
  readonly voucherRef?: string;
  readonly lastFailure?: string;
  readonly deadLetteredAt?: string;
}

/** What the Tally adapter reports back. `unknown` is expected, not exceptional. */
export type TallyOutcome =
  | { readonly result: 'accepted'; readonly voucherRef: string }
  /** Tally already has this idempotency key — the same effect, not a second voucher. */
  | { readonly result: 'duplicate'; readonly voucherRef: string }
  /** Permanently wrong. Retrying will fail identically. */
  | { readonly result: 'rejected'; readonly reason: string }
  /** Temporarily unavailable, or we did not hear back. Retry is safe (idempotent). */
  | { readonly result: 'retryable'; readonly reason: string };

export interface TallyConnector {
  readonly version: string;
  post(input: {
    readonly idempotencyKey: string;
    readonly journalRef: string;
    readonly period: string;
    readonly debitMinor: number;
    readonly creditMinor: number;
  }): TallyOutcome;
}

export interface ConnectorPolicy {
  /** Attempts before an item is dead-lettered. Default 5. */
  readonly maxAttempts?: number;
  /** First backoff step in seconds; doubles each attempt. Default 30. */
  readonly baseBackoffSeconds?: number;
  /** Backoff ceiling in seconds. Default 3600 (one hour). */
  readonly maxBackoffSeconds?: number;
}

/** Pure exponential backoff — computed, never slept, so it is testable without timers. */
export function backoffSeconds(attempt: number, policy: ConnectorPolicy = {}): number {
  const base = policy.baseBackoffSeconds ?? 30;
  const cap = policy.maxBackoffSeconds ?? 3_600;
  return Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
}

export interface DrainResult {
  readonly postings: readonly QueuedPosting[];
  readonly posted: number;
  readonly stillQueued: number;
  readonly deadLettered: number;
  readonly detail: string;
}

/**
 * Attempt one delivery pass over the queue.
 *
 * A `duplicate` is treated exactly as an `accepted` — Tally already has it, so the
 * business effect is present and the queue should stop trying. That is the whole
 * payoff of idempotency, and the case that actually occurs after a timeout.
 *
 * A `rejected` goes **straight to the dead-letter queue** without burning retries: a
 * voucher Tally will never accept does not become acceptable on the fifth attempt, and
 * retrying it buries the one item a human needs to look at.
 */
export function drainToTally(
  postings: readonly QueuedPosting[],
  connector: TallyConnector,
  at: string,
  policy: ConnectorPolicy = {},
): DrainResult {
  const maxAttempts = policy.maxAttempts ?? 5;
  const next: QueuedPosting[] = [];
  let posted = 0;
  let deadLettered = 0;

  for (const item of postings) {
    if (item.state !== 'queued') {
      next.push(item);
      continue;
    }

    const outcome = connector.post({
      idempotencyKey: item.idempotencyKey,
      journalRef: item.journalRef,
      period: item.period,
      debitMinor: item.debitMinor,
      creditMinor: item.creditMinor,
    });
    const attempts = item.attempts + 1;

    if (outcome.result === 'accepted' || outcome.result === 'duplicate') {
      posted += 1;
      next.push({
        ...item,
        state: 'posted',
        attempts,
        lastAttemptAt: at,
        postedAt: at,
        voucherRef: outcome.voucherRef,
      });
      continue;
    }

    if (outcome.result === 'rejected') {
      // Permanent. Straight to the dead-letter queue, visible, with the reason.
      deadLettered += 1;
      next.push({
        ...item,
        state: 'dead_lettered',
        attempts,
        lastAttemptAt: at,
        deadLetteredAt: at,
        lastFailure: `rejected by Tally: ${outcome.reason}`,
      });
      continue;
    }

    if (attempts >= maxAttempts) {
      deadLettered += 1;
      next.push({
        ...item,
        state: 'dead_lettered',
        attempts,
        lastAttemptAt: at,
        deadLetteredAt: at,
        lastFailure: `${attempts} attempts, last: ${outcome.reason}`,
      });
      continue;
    }

    next.push({ ...item, attempts, lastAttemptAt: at, lastFailure: outcome.reason });
  }

  const stillQueued = next.filter((p) => p.state === 'queued').length;
  return {
    postings: next,
    posted,
    stillQueued,
    deadLettered,
    detail:
      deadLettered > 0
        ? `${posted} posted, ${stillQueued} queued, ${deadLettered} dead-lettered and waiting for a person — nothing was dropped`
        : `${posted} posted, ${stillQueued} queued`,
  };
}

/**
 * The dead-letter queue, worst first. It is **read**, never drained by deletion: a
 * dead-lettered posting is money the accounts have not seen, and the only way out is a
 * corrected re-post, which is a new posting with its own key (hard rule #6, #2).
 */
export function deadLetters(postings: readonly QueuedPosting[]): readonly QueuedPosting[] {
  return postings
    .filter((p) => p.state === 'dead_lettered')
    .sort((a, b) => b.debitMinor - a.debitMinor || a.postingId.localeCompare(b.postingId));
}

/**
 * Requeue a dead-lettered posting **as a new posting**, once a human has fixed the
 * cause. The original record is returned unchanged alongside it — the failure stays on
 * file, because a dead-letter that vanishes when it is fixed leaves no evidence that
 * the month was ever wrong.
 */
export function requeueCorrected(input: {
  readonly original: QueuedPosting;
  readonly correctedPostingId: string;
  readonly correctedIdempotencyKey: string;
  readonly fixedBy: string;
  readonly reason: string;
  readonly at: string;
}): { readonly requeued: boolean; readonly detail: string; readonly postings: readonly QueuedPosting[] } {
  const o = input.original;
  if (o.state !== 'dead_lettered') {
    return { requeued: false, detail: `posting ${o.postingId} is ${o.state}, not dead-lettered`, postings: [o] };
  }
  if (input.reason.trim() === '') {
    return { requeued: false, detail: 'requeueing a failed posting needs a reason saying what was fixed', postings: [o] };
  }
  if (input.correctedIdempotencyKey === o.idempotencyKey) {
    // Same key, same rejection. A correction that reuses the key is not a correction.
    return {
      requeued: false,
      detail: 'a corrected posting needs a new idempotency key — reusing the old one would be rejected identically',
      postings: [o],
    };
  }

  return {
    requeued: true,
    detail: `${input.fixedBy} requeued ${o.postingId} as ${input.correctedPostingId}: ${input.reason}`,
    postings: [
      // The failure stays exactly as it was.
      o,
      {
        postingId: input.correctedPostingId,
        idempotencyKey: input.correctedIdempotencyKey,
        period: o.period,
        journalRef: o.journalRef,
        debitMinor: o.debitMinor,
        creditMinor: o.creditMinor,
        state: 'queued',
        attempts: 0,
        queuedAt: input.at,
      },
    ],
  };
}
