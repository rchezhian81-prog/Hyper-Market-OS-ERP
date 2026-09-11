// The failed-sync record that outlives the process — P-08, hard rule #6, §31, RR-F06.
//
// ── Why this file exists ─────────────────────────────────────────────────────
//
// A sale or refund the cloud will not take is dead-lettered: a person has to look at it. Until this
// file, that dead-letter lived only in the in-memory `SyncOutbox`, and the durable cursor was
// advanced *over* it (a dead-letter counted as "finished"). So on the next restart the record was
// below the cursor — never re-queued — and the in-memory dead-letter was gone with the process. The
// failed record, its reason, and its history vanished silently. That is the exact failure hard rule
// #6 forbids ("never delete audit evidence, dead-letter items or migration exceptions"), and it is
// money: a refund that could not sync, gone with nothing saying so.
//
// This is the durable dead-letter store. When the edge dead-letters an item it is appended here —
// on the disk, fsync'd — *before* the cursor is allowed to move past it. On restart the store is
// read back and the failures are visible again, with their payload, reason, attempt count and the
// full history of what happened to them. Nothing is ever rewritten or removed (hard rule #6): the
// file is append-only, and a resolution is another entry, not an edit.
//
// ── Why it reuses the durable-log framing ────────────────────────────────────
//
// A dead-letter that is itself lost to a half-written line would be the same bug one layer down, so
// this stores each entry with the same length-framed, fsync'd, truncation-visible format the sale
// log uses (`file-log.ts`). A truncated tail entry is reported, never guessed at.

import type { DomainEvent } from '../../../packages/contracts/src/event';

/** What happened to a failed-sync item, one appended fact at a time (RR-F06 resolution history). */
export type DeadLetterKind = 'dead_lettered' | 'resolved';

/** A single appended fact about one failed-sync item. The file is a sequence of these. */
export interface DeadLetterEntry {
  /** The item's idempotency key — its identity across the outbox, the log and the cloud. */
  readonly key: string;
  readonly kind: DeadLetterKind;
  /** The event the cloud would not take — the payload, kept whole so it can be re-examined. */
  readonly event: DomainEvent;
  /** Why it failed (or, for a resolution, the note a person left). */
  readonly reason: string;
  /** How many delivery attempts it had taken when this fact was recorded. */
  readonly attempts: number;
  /** ISO-8601 UTC time this fact was recorded. */
  readonly at: string;
}

/** The current state of one failed-sync item, folded from every fact recorded about it. */
export interface DeadLetterState {
  readonly key: string;
  readonly event: DomainEvent;
  /** The most recent reason (a resolution note, or the last failure reason). */
  readonly reason: string;
  readonly attempts: number;
  /** When it first failed. */
  readonly firstFailedAt: string;
  /** When the most recent fact about it was recorded. */
  readonly lastUpdatedAt: string;
  /** 'dead_lettered' while it still needs a person; 'resolved' once one has dealt with it. */
  readonly status: DeadLetterKind;
  /** Every fact recorded about this item, in order — the resolution history (RR-F06). */
  readonly history: readonly DeadLetterEntry[];
}

/** Serialise one fact for the durable store. JSON has no raw newline, so a record stays one frame. */
export function serialiseDeadLetter(entry: DeadLetterEntry): string {
  return JSON.stringify(entry);
}

/** Parse one stored fact, or `undefined` if it is not a well-formed entry (kept, never guessed). */
export function parseDeadLetter(record: string): DeadLetterEntry | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(record);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const e = parsed as Record<string, unknown>;
  if (typeof e['key'] !== 'string' || typeof e['at'] !== 'string') return undefined;
  if (e['kind'] !== 'dead_lettered' && e['kind'] !== 'resolved') return undefined;
  if (typeof e['event'] !== 'object' || e['event'] === null) return undefined;
  return {
    key: e['key'],
    kind: e['kind'],
    event: e['event'] as DomainEvent,
    reason: typeof e['reason'] === 'string' ? e['reason'] : '',
    attempts: Number.isInteger(e['attempts']) ? (e['attempts'] as number) : 0,
    at: e['at'],
  };
}

/**
 * Fold every stored fact into the current state of each failed-sync item, in first-seen order.
 *
 * The file is append-only, so a key can appear more than once — a failure, then a later resolution,
 * or a re-failure with a higher attempt count. The latest fact wins for the visible state; **all**
 * of them are kept as the history, because "what happened to this refund" is the question a person
 * asks and a single latest row cannot answer it (hard rule #6, P-08).
 */
export function foldDeadLetters(records: readonly string[]): Map<string, DeadLetterState> {
  const byKey = new Map<string, DeadLetterState>();
  for (const record of records) {
    const entry = parseDeadLetter(record);
    if (entry === undefined) continue; // a truncated or unreadable fact is skipped, never guessed
    const existing = byKey.get(entry.key);
    if (existing === undefined) {
      byKey.set(entry.key, {
        key: entry.key,
        event: entry.event,
        reason: entry.reason,
        attempts: entry.attempts,
        firstFailedAt: entry.at,
        lastUpdatedAt: entry.at,
        status: entry.kind,
        history: [entry],
      });
      continue;
    }
    byKey.set(entry.key, {
      key: existing.key,
      // Keep the original event payload — a resolution note carries the same event, but the first
      // failure is the authoritative copy of what was to be sent.
      event: existing.event,
      reason: entry.reason,
      attempts: Math.max(existing.attempts, entry.attempts),
      firstFailedAt: existing.firstFailedAt,
      lastUpdatedAt: entry.at,
      status: entry.kind,
      history: [...existing.history, entry],
    });
  }
  return byKey;
}

/** The keys still needing a person — dead_lettered and not since resolved. */
export function unresolvedKeys(state: ReadonlyMap<string, DeadLetterState>): Set<string> {
  const out = new Set<string>();
  for (const [key, s] of state) {
    if (s.status === 'dead_lettered') out.add(key);
  }
  return out;
}
