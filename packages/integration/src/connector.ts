// Connector SDK — mapping, throttling, retry and dead letter
// (M32-FR-02 / §19 / §31.1 / P-08 / hard rules #6, #10).
//
// `packages/period-close` already has a working connector — the Tally one, built in Stage 10.
// This module is the **shape** that one proved, extracted so every future integration inherits
// the same behaviour instead of each one reinventing the retry loop slightly differently.
//
// The thing that makes integrations rot is not any single failure; it is that failures become
// **invisible**. A retry loop that never gives up looks healthy while nothing moves. A
// dead-letter queue somebody clears every Monday looks empty. A mapping that drops an
// unrecognised field looks like a clean run.
//
//   • **A DEAD LETTER IS READ, NEVER DELETED** (hard rule #6). There is no `remove`, `purge`
//     or `clear` in this module — a test asserts their absence. A failure is resolved by a
//     **new, corrected message with a new key**, and the original stays on file.
//   • **RETRIES ARE BOUNDED AND A PERMANENT ERROR SKIPS THEM.** Retrying a 400 nine times
//     with exponential backoff burns forty minutes and buries the one message that mattered
//     behind it.
//   • **AN UNMAPPED FIELD IS AN EXCEPTION, NOT A DROPPED FIELD.** Silently dropping what the
//     mapping does not recognise is how a tax code stops reaching the accounts package and
//     nobody notices for a quarter.
//   • **THROTTLING WAITS; IT DOES NOT DISCARD.** A provider's rate limit is their capacity
//     problem, not a reason to lose our message.
//   • **A CONNECTOR UPGRADE DOES NOT BREAK IN-FLIGHT MESSAGES.** A message enqueued under v1
//     is delivered under v1's mapping, whatever version is deployed by the time it drains.
//
// Pure and deterministic: the clock is injected, the transport is injected, no I/O.

export type MessageState = 'queued' | 'in_flight' | 'delivered' | 'dead_lettered';

export interface ConnectorMessage<T = unknown> {
  readonly messageId: string;
  readonly tenantId: string;
  readonly connectorId: string;
  /** The mapping version this message was enqueued under. It travels WITH the message. */
  readonly connectorVersion: string;
  readonly kind: string;
  readonly payload: T;
  /** Idempotency key the destination sees. A correction gets a NEW one. */
  readonly deliveryKey: string;
  readonly enqueuedAt: string;
  readonly state: MessageState;
  readonly attempts: number;
  readonly lastError?: string;
  readonly deadLetteredAt?: string;
  /** Set on the ORIGINAL when a correction supersedes it. The original still stands. */
  readonly supersededBy?: string;
}

export type FieldRule =
  | { readonly kind: 'copy'; readonly from: string; readonly to: string }
  | { readonly kind: 'constant'; readonly to: string; readonly value: string | number }
  | { readonly kind: 'lookup'; readonly from: string; readonly to: string; readonly table: Readonly<Record<string, string>> };

export interface Mapping {
  readonly connectorId: string;
  readonly version: string;
  readonly rules: readonly FieldRule[];
  /** Fields the destination requires. A missing one is an exception, not a null. */
  readonly required: readonly string[];
}

export type MappingOutcome = 'mapped' | 'unmapped_fields' | 'missing_required' | 'lookup_miss';

export interface MappingResult {
  readonly mapped: boolean;
  readonly outcome: MappingOutcome;
  readonly output: Readonly<Record<string, unknown>>;
  /** Source fields no rule accounted for. Reported, never silently dropped. */
  readonly unmapped: readonly string[];
  readonly detail: string;
}

/**
 * Map a source record to a destination record.
 *
 * **An unmapped source field is an exception, not a dropped field.** Dropping what the
 * mapping does not recognise is how a tax code stops reaching the accounts package and nobody
 * notices for a quarter — the run looks clean, the totals look plausible, and the difference
 * turns up at the year end.
 *
 * A lookup that misses is the same kind of failure: mapping an unknown ledger code to blank
 * produces a journal that posts and is wrong.
 */
export function applyMapping(input: {
  readonly mapping: Mapping;
  readonly source: Readonly<Record<string, unknown>>;
  /** Source fields deliberately not carried. Named, so the omission is a decision. */
  readonly ignore?: readonly string[];
}): MappingResult {
  const output: Record<string, unknown> = {};
  const consumed = new Set<string>(input.ignore ?? []);
  const lookupMisses: string[] = [];

  for (const rule of input.mapping.rules) {
    if (rule.kind === 'constant') {
      output[rule.to] = rule.value;
      continue;
    }
    consumed.add(rule.from);
    const value = input.source[rule.from];
    if (rule.kind === 'copy') {
      if (value !== undefined) output[rule.to] = value;
      continue;
    }
    if (value === undefined) continue;
    const mapped = rule.table[String(value)];
    if (mapped === undefined) {
      lookupMisses.push(`${rule.from}="${String(value)}"`);
      continue;
    }
    output[rule.to] = mapped;
  }

  const unmapped = Object.keys(input.source).filter((k) => !consumed.has(k)).sort();

  if (lookupMisses.length > 0) {
    return {
      mapped: false,
      outcome: 'lookup_miss',
      output,
      unmapped,
      detail: `no mapping for ${lookupMisses.join(', ')} — mapping an unknown code to blank produces a record that posts and is wrong`,
    };
  }
  if (unmapped.length > 0) {
    return {
      mapped: false,
      outcome: 'unmapped_fields',
      output,
      unmapped,
      detail: `${unmapped.length} source field(s) no rule accounts for: ${unmapped.join(', ')}. Silently dropping them is how a tax code stops reaching the accounts package for a quarter`,
    };
  }

  const missing = input.mapping.required.filter((f) => output[f] === undefined).sort();
  if (missing.length > 0) {
    return {
      mapped: false,
      outcome: 'missing_required',
      output,
      unmapped,
      detail: `the destination requires ${missing.join(', ')} and the mapping produced nothing for ${missing.length === 1 ? 'it' : 'them'}`,
    };
  }

  return { mapped: true, outcome: 'mapped', output, unmapped: [], detail: `${Object.keys(output).length} field(s) mapped` };
}

export type DeliveryOutcome = 'delivered' | 'duplicate' | 'retryable' | 'permanent' | 'throttled';

export interface DeliveryResult {
  readonly outcome: DeliveryOutcome;
  readonly detail: string;
  /** Provider's own retry hint on a throttle, in seconds. */
  readonly retryAfterSeconds?: number;
}

/** The injected transport. A connector never talks to the network itself. */
export type ConnectorTransport = (message: ConnectorMessage) => DeliveryResult;

export interface RetryPolicy {
  /** Attempts before a message dead-letters. Default 5. */
  readonly maxAttempts?: number;
  readonly baseSeconds?: number;
  readonly maxBackoffSeconds?: number;
  /** Messages delivered per drain. A provider's rate limit is real. Default 100. */
  readonly ratePerDrain?: number;
}

/** Exponential backoff, capped. Pure — attempt 1 is the first retry. */
export function backoffSeconds(attempt: number, policy: RetryPolicy = {}): number {
  const base = policy.baseSeconds ?? 2;
  const cap = policy.maxBackoffSeconds ?? 900;
  return Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
}

export interface DrainResult {
  readonly connectorId: string;
  readonly attempted: number;
  readonly delivered: readonly string[];
  readonly requeued: readonly { readonly messageId: string; readonly nextAttemptInSeconds: number }[];
  readonly deadLettered: readonly string[];
  /** Left in the queue because the rate limit was reached. Waiting, never lost. */
  readonly throttled: readonly string[];
  readonly messages: readonly ConnectorMessage[];
  readonly detail: string;
}

/**
 * Drain a connector queue.
 *
 * Four outcomes, and the difference between them is the whole module:
 *
 * - **`duplicate` counts as delivered.** After a timeout the destination has usually taken the
 *   message and our acknowledgement was lost. Treating that as a failure re-sends it forever.
 * - **`permanent` dead-letters immediately.** Retrying a rejected record nine times with
 *   backoff burns forty minutes and buries the message that mattered behind it.
 * - **`retryable` backs off, bounded.** An unbounded retry loop looks healthy while nothing
 *   moves, which is worse than a visible failure.
 * - **`throttled` stays queued.** A provider's rate limit is their capacity problem, not a
 *   reason to lose our message.
 *
 * A message carries **its own connector version**, so an in-flight message enqueued under v1
 * is still delivered under v1 whatever is deployed by the time it drains.
 */
export function drainConnector(input: {
  readonly connectorId: string;
  readonly messages: readonly ConnectorMessage[];
  readonly transport: ConnectorTransport;
  readonly policy?: RetryPolicy;
  readonly at: string;
}): DrainResult {
  const policy = input.policy ?? {};
  const maxAttempts = policy.maxAttempts ?? 5;
  const rate = policy.ratePerDrain ?? 100;

  const queue = input.messages.filter((m) => m.connectorId === input.connectorId && m.state === 'queued');
  const untouched = input.messages.filter((m) => !(m.connectorId === input.connectorId && m.state === 'queued'));

  const delivered: string[] = [];
  const requeued: { messageId: string; nextAttemptInSeconds: number }[] = [];
  const deadLettered: string[] = [];
  const throttled: string[] = [];
  const out: ConnectorMessage[] = [];
  let sent = 0;

  for (const message of queue) {
    if (sent >= rate) {
      throttled.push(message.messageId);
      out.push(message);
      continue;
    }
    sent += 1;

    const attempts = message.attempts + 1;
    const result = input.transport(message);

    if (result.outcome === 'delivered' || result.outcome === 'duplicate') {
      delivered.push(message.messageId);
      out.push({ ...message, state: 'delivered', attempts });
      continue;
    }
    if (result.outcome === 'throttled') {
      // Not an attempt against the budget — the provider never looked at it.
      throttled.push(message.messageId);
      out.push(message);
      continue;
    }
    if (result.outcome === 'permanent') {
      deadLettered.push(message.messageId);
      out.push({ ...message, state: 'dead_lettered', attempts, lastError: result.detail, deadLetteredAt: input.at });
      continue;
    }
    if (attempts >= maxAttempts) {
      deadLettered.push(message.messageId);
      out.push({
        ...message, state: 'dead_lettered', attempts,
        lastError: `${result.detail} (gave up after ${attempts} attempts)`,
        deadLetteredAt: input.at,
      });
      continue;
    }
    requeued.push({ messageId: message.messageId, nextAttemptInSeconds: backoffSeconds(attempts, policy) });
    out.push({ ...message, state: 'queued', attempts, lastError: result.detail });
  }

  return {
    connectorId: input.connectorId,
    attempted: sent,
    delivered,
    requeued,
    deadLettered,
    throttled,
    messages: [...untouched, ...out],
    detail:
      deadLettered.length > 0
        ? `${delivered.length} delivered, ${requeued.length} to retry, ${deadLettered.length} DEAD-LETTERED and awaiting a person${throttled.length === 0 ? '' : `, ${throttled.length} waiting on the rate limit`}`
        : `${delivered.length} delivered, ${requeued.length} to retry${throttled.length === 0 ? '' : `, ${throttled.length} waiting on the rate limit`}`,
  };
}

/** Read the dead-letter queue. There is deliberately no function that empties it. */
export function deadLetters(
  messages: readonly ConnectorMessage[],
  connectorId?: string,
): readonly ConnectorMessage[] {
  return messages
    .filter((m) => m.state === 'dead_lettered' && (connectorId === undefined || m.connectorId === connectorId))
    .sort((a, b) => (a.deadLetteredAt ?? '').localeCompare(b.deadLetteredAt ?? '') || a.messageId.localeCompare(b.messageId));
}

export interface QueueHealth {
  readonly connectorId: string;
  readonly queued: number;
  readonly deadLettered: number;
  readonly oldestQueuedMinutes: number | 'nothing_queued';
  readonly oldestDeadLetterDays: number | 'none';
  /** True when somebody should look today. */
  readonly needsAttention: boolean;
  readonly detail: string;
}

/**
 * Queue health, reported so a stuck connector is **visible** rather than quiet (P-08).
 *
 * The failure this catches is the one nobody sees: a queue that is not growing and not moving.
 * Depth alone says nothing — twenty messages is fine, and twenty messages that have been
 * there since Tuesday is an outage nobody noticed.
 */
export function queueHealth(input: {
  readonly connectorId: string;
  readonly messages: readonly ConnectorMessage[];
  /** Minutes a message may sit queued before it is worth a look. Default 60. */
  readonly stalledAfterMinutes?: number;
  readonly at: string;
}): QueueHealth {
  const mine = input.messages.filter((m) => m.connectorId === input.connectorId);
  const queued = mine.filter((m) => m.state === 'queued');
  const dead = mine.filter((m) => m.state === 'dead_lettered');
  const stalled = input.stalledAfterMinutes ?? 60;

  const oldestQueuedMinutes =
    queued.length === 0
      ? ('nothing_queued' as const)
      : Math.max(
          ...queued.map((m) => Math.round((Date.parse(input.at) - Date.parse(m.enqueuedAt)) / 60_000)),
        );

  const oldestDeadLetterDays =
    dead.length === 0
      ? ('none' as const)
      : Math.max(
          ...dead.map((m) => Math.floor((Date.parse(input.at) - Date.parse(m.deadLetteredAt ?? input.at)) / 86_400_000)),
        );

  const stuck = oldestQueuedMinutes !== 'nothing_queued' && oldestQueuedMinutes > stalled;
  const needsAttention = stuck || dead.some((m) => m.supersededBy === undefined);

  return {
    connectorId: input.connectorId,
    queued: queued.length,
    deadLettered: dead.length,
    oldestQueuedMinutes,
    oldestDeadLetterDays,
    needsAttention,
    detail: stuck
      ? `${queued.length} message(s) queued and the oldest has been waiting ${oldestQueuedMinutes} minutes — depth alone says nothing; a queue that is neither growing nor moving is an outage nobody noticed`
      : dead.length > 0
        ? `${dead.length} dead letter(s) awaiting a person, oldest ${oldestDeadLetterDays} day(s) old — they are read, never deleted (#6)`
        : `${queued.length} queued, nothing dead-lettered`,
  };
}

export type CorrectionOutcome = 'requeued' | 'not_dead_lettered' | 'same_key' | 'already_superseded';

export interface CorrectionResult {
  readonly requeued: boolean;
  readonly outcome: CorrectionOutcome;
  readonly messages: readonly ConnectorMessage[];
  readonly detail: string;
}

/**
 * Resolve a dead letter by enqueuing a **corrected message with a new key**.
 *
 * The original is **kept and marked superseded**, never edited and never removed (hard rule
 * #6). Reusing the delivery key would be indistinguishable from a retry at the destination,
 * which is exactly the situation the correction exists to escape.
 */
export function requeueCorrected(input: {
  readonly original: ConnectorMessage;
  readonly correctedPayload: unknown;
  readonly newMessageId: string;
  readonly newDeliveryKey: string;
  readonly correctedBy: string;
  readonly messages: readonly ConnectorMessage[];
  readonly at: string;
}): CorrectionResult {
  const o = input.original;

  if (o.state !== 'dead_lettered') {
    return { requeued: false, outcome: 'not_dead_lettered', messages: input.messages, detail: 'only a dead-lettered message is corrected this way' };
  }
  if (o.supersededBy !== undefined) {
    return { requeued: false, outcome: 'already_superseded', messages: input.messages, detail: `already superseded by ${o.supersededBy}` };
  }
  if (input.newDeliveryKey === o.deliveryKey) {
    return {
      requeued: false,
      outcome: 'same_key',
      messages: input.messages,
      detail: 'a correction needs a NEW delivery key — reusing the old one is indistinguishable from a retry at the destination, which is what we are escaping',
    };
  }

  const corrected: ConnectorMessage = {
    messageId: input.newMessageId,
    tenantId: o.tenantId,
    connectorId: o.connectorId,
    // The corrected message goes out under the SAME mapping version as the original.
    connectorVersion: o.connectorVersion,
    kind: o.kind,
    payload: input.correctedPayload,
    deliveryKey: input.newDeliveryKey,
    enqueuedAt: input.at,
    state: 'queued',
    attempts: 0,
  };

  return {
    requeued: true,
    outcome: 'requeued',
    messages: [
      // The original stays, marked. It is never edited away and never deleted.
      ...input.messages.map((m) => (m.messageId === o.messageId ? { ...m, supersededBy: input.newMessageId } : m)),
      corrected,
    ],
    detail: `corrected by ${input.correctedBy} as ${input.newMessageId} with a new key; the original failure stays on file (#6)`,
  };
}
