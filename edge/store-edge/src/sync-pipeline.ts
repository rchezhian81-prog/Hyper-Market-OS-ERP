// One offline sync pipeline — the durable log, its checkpoint, and its failed-sync store, joined so
// that a restart recovers *exactly* the right work (P-01, §31, hard rules #1/#6/#10, RR-F05/RR-F06).
//
// The sale pipeline and the refund pipeline are the same machine over different files, so it lives
// here once rather than being written — and mis-written — twice in the composition root.
//
// ── What was wrong, and what this fixes ──────────────────────────────────────
//
// The checkpoint ("cursor") is the count of records at the front of the durable log that are
// finished, so a restart re-queues only what came after it. The old advance had two faults:
//
//   • It treated a DEAD-LETTERED record as "finished" and stepped the cursor over it — while the
//     dead-letter itself lived only in memory. On the next start the record was below the cursor
//     (never re-queued) and the in-memory dead-letter was gone: the failed sale or refund vanished
//     silently, which is the one thing hard rule #6 forbids (RR-F06).
//   • It advanced by `cursorBefore + <finished prefix of the in-memory outbox>`, and the outbox
//     dedupes on key. A duplicate record in the log made the outbox shorter than the log, so the
//     cursor fell permanently one short per duplicate and re-sent the tail on every restart (RR-F05).
//
// The fix here is one coherent rule:
//
//   A log position is DONE when it was acknowledged by the cloud, OR it is recorded in the DURABLE
//   dead-letter store. A dead-letter is written to that store — on the disk, fsync'd — *before* the
//   cursor is allowed to move past it, so advancing over it can no longer lose it. On restart the
//   dead-letter store is read back and every failure is visible again with its reason, attempts and
//   history (RR-F06). The cursor is derived per *log position* (keyed, so duplicates collapse
//   correctly), never by outbox length (RR-F05).

import type { OpenFileLog } from './file-log';
import { readLog } from './file-log';
import { readCursor, writeCursor, advanceTo } from './sync-cursor';
import { SyncOutbox, type OutboxItem, type OutboxState } from '../../../packages/sync/src/outbox';
import { makeEvent, type DomainEvent } from '../../../packages/contracts/src/event';
import {
  foldDeadLetters, serialiseDeadLetter, type DeadLetterState,
} from './dead-letter-log';

export interface PipelineConfig {
  readonly dataDir: string;
  /** The durable record log (sales.log / returns.log). Opened by the caller. */
  readonly log: OpenFileLog;
  /** The durable failed-sync store for this pipeline (dead-letters / dead-letters-returns). */
  readonly deadLetterLog: OpenFileLog;
  /** The cursor file name; `undefined` is the sales cursor's default (see sync-cursor). */
  readonly cursorFile: string | undefined;
  /** 'sale' / 'refund' — the noun for the staff-facing lines. */
  readonly noun: string;
  /**
   * Turn a raw whole log record into the event to queue, or `undefined` when it cannot be parsed.
   * `index` is the record's absolute position in the whole-record list, for a deterministic fallback
   * key. Provided by the caller because sales and refunds address the cloud differently.
   */
  readonly eventFor: (record: string, index: number) => DomainEvent | undefined;
  readonly say: (line: string) => void;
}

export interface RestoreOutcome {
  /** How many records were re-queued to send (pending after the cursor). */
  readonly resendCount: number;
  /** How many records on the disk could not be read whole (truncated/unframed). */
  readonly brokenCount: number;
  /** How many failed-sync items were restored from the durable store (visible again). */
  readonly restoredDeadLetters: number;
}

export class SyncPipeline {
  /** The checkpoint as it stood at restore — the fixed base the ordered positions are counted from. */
  private baseCursor = 0;
  /** The checkpoint as last written this run. */
  private handled = 0;
  /** Keys of the after-the-cursor log positions, in log order (duplicates included). */
  private readonly orderedKeys: string[] = [];
  private readonly orderedKeySet = new Set<string>();
  /** Keys restored from BELOW the cursor — visible, but not an after-cursor position to advance over. */
  private readonly belowCursor = new Set<string>();
  /** Keys already accounted for as durably dead-lettered. */
  private readonly durablyDead = new Set<string>();
  private deadState: ReadonlyMap<string, DeadLetterState> = new Map();
  private outboxRef: SyncOutbox | null = null;

  constructor(private readonly config: PipelineConfig) {}

  /** The outbox this pipeline built at restore time — what the edge node queues into and the agent drains. */
  get outbox(): SyncOutbox {
    if (this.outboxRef === null) throw new Error('SyncPipeline.restore() must be called before use.');
    return this.outboxRef;
  }

  /** The visible failed-sync records, folded from the durable store — for health and the owner's screens. */
  deadLetters(): ReadonlyMap<string, DeadLetterState> {
    return this.deadState;
  }

  /**
   * Rebuild the queue from the durable log and the durable dead-letter store.
   *
   * The log is the system of record; the queue and the checkpoint are views of it. This reads all
   * three, clamps a checkpoint that claims more than the log holds (a corrupt or truncated cursor is
   * recovered, never trusted past the evidence), re-queues what is unfinished, and restores every
   * known failure so it is visible again — with its history intact, never reset (RR-F06).
   */
  async restore(): Promise<RestoreOutcome> {
    const found = await readLog(this.config.log.path);
    const broken = found.filter((r) => !r.ok);
    const whole = found.filter((r) => r.ok).map((r) => (r.ok ? r.record : ''));

    const deadRecords = (await readLog(this.config.deadLetterLog.path))
      .filter((r) => r.ok)
      .map((r) => (r.ok ? r.record : ''));
    this.deadState = foldDeadLetters(deadRecords);
    for (const key of this.deadState.keys()) this.durablyDead.add(key);

    // A checkpoint may not claim MORE finished records than the log holds. In correct operation the
    // cursor is always a prefix count, so `stored > whole.length` is provable corruption — a torn or
    // wrong cursor, or a tail the power cut truncated away. Trusting it would hide every record it
    // claims is done, so recover by re-scanning from the start: re-sending is safe (the cloud
    // dedupes on the key) and skipping is the one mistake with no way back. A cursor within the log
    // is trusted as-is — that is the normal, cheap path taken on every clean restart.
    const stored = await readCursor(this.config.dataDir, this.config.cursorFile);
    this.baseCursor = stored > whole.length ? 0 : stored;
    this.handled = this.baseCursor;
    if (stored > whole.length) {
      this.config.say(`  the ${this.config.noun} checkpoint claimed ${stored} done but only ${whole.length} are on the disk — re-checking all of them against the cloud (they will not be double-counted).`);
    }

    const restored: OutboxItem[] = [];
    const seen = new Set<string>();
    let resendCount = 0;

    const item = (
      key: string, event: DomainEvent, state: OutboxState, attempts: number, reason: string | null,
    ): OutboxItem => Object.freeze({ key, event, state, attempts, reason });

    // 1) Everything after the cursor: re-queue it, unless it is a known failure — then restore it as
    //    the dead-letter it is, with its attempts and reason preserved (never retried blindly, never
    //    reset). Its key takes an after-cursor position so the checkpoint can advance over it.
    const after = whole.slice(this.handled);
    for (const [i, record] of after.entries()) {
      const index = this.handled + i;
      const event = this.config.eventFor(record, index) ?? this.malformedEvent(record, index);
      const key = event.idempotencyKey;
      const dead = this.deadState.get(key);
      if (dead !== undefined) {
        restored.push(item(key, dead.event, 'dead_letter', dead.attempts, dead.reason));
      } else if (event.type === 'MalformedRecord') {
        // A well-framed record the parser could not read: surface it as a failure a person must see,
        // durably (below), rather than skip it — which would slide every later position onto the
        // wrong index and either strand or over-run the cursor.
        restored.push(item(key, event, 'pending', 0, null));
      } else {
        restored.push(item(key, event, 'pending', 0, null));
        resendCount += 1;
      }
      this.orderedKeys.push(key);
      this.orderedKeySet.add(key);
      seen.add(key);
    }

    // 2) Failures recorded BELOW the cursor (a prior, incorrect checkpoint stepped past them, or the
    //    cursor legitimately advanced over a durable dead-letter last run). Restore them so they stay
    //    visible and actionable — they are not re-sent (a dead-letter is not pending) and they do not
    //    move the cursor (they are already behind it).
    let restoredDeadLetters = 0;
    for (const [key, dead] of this.deadState) {
      if (dead.status !== 'dead_lettered') continue;
      restoredDeadLetters += 1;
      if (seen.has(key)) continue;
      restored.push(item(key, dead.event, 'dead_letter', dead.attempts, dead.reason));
      this.belowCursor.add(key);
      seen.add(key);
    }

    this.outboxRef = new SyncOutbox(restored);

    // A malformed record we just minted a synthetic event for must be persisted as a dead-letter now,
    // so it survives the next restart too and the cursor is free to advance past it.
    for (const item of this.outboxRef.all()) {
      if (item.event.type === 'MalformedRecord' && !this.durablyDead.has(item.key)) {
        this.outboxRef.deadLetter(item.key, 'the record on the disk could not be read as a sale or refund');
        await this.recordDeadLetter(item.key, item.event, 'the record on the disk could not be read as a sale or refund', item.attempts, new Date().toISOString());
      }
    }

    return { resendCount, brokenCount: broken.length, restoredDeadLetters };
  }

  /**
   * Persist any newly dead-lettered item to the durable store — BEFORE the cursor is advanced.
   *
   * This ordering is the safety property: if the process dies between the drain and here, the cursor
   * has not moved, so the record is still after it and is re-queued (then re-dead-lettered, then
   * re-persisted) next start. Nothing is lost; at worst a failure is recorded twice, and the fold
   * keeps both as history rather than double-counting the visible state.
   */
  async persistNewDeadLetters(at: string): Promise<void> {
    for (const item of this.outbox.all()) {
      if (item.state === 'dead_letter' && !this.durablyDead.has(item.key)) {
        await this.recordDeadLetter(item.key, item.event, item.reason ?? '', item.attempts, at);
      }
    }
  }

  /**
   * Advance the checkpoint over the finished leading run of after-the-cursor positions.
   *
   * A position is finished when its key was acknowledged, or is durably dead-lettered. New sales
   * committed during this run are appended in order first (they enqueue with fresh keys), so the
   * position list stays the log's order. Only a *contiguous* finished run counts — an unfinished
   * record in the middle holds the cursor, so the next restart never steps over it.
   */
  async advanceCursor(): Promise<void> {
    // Extend the position list with anything committed this run (a new, unique key not already a
    // position and not a below-cursor restore).
    for (const item of this.outbox.all()) {
      if (!this.orderedKeySet.has(item.key) && !this.belowCursor.has(item.key)) {
        this.orderedKeys.push(item.key);
        this.orderedKeySet.add(item.key);
      }
    }
    const finished = this.orderedKeys.map((key) => {
      const item = this.outbox.find(key);
      return item?.state === 'acknowledged' || this.durablyDead.has(key);
    });
    // Counted from the fixed base, not the running cursor: the ordered positions are exactly the
    // records after the base, so adding the finished run to the running cursor would double-count on
    // every pass after the first.
    const handledNow = this.baseCursor + advanceTo(finished);
    if (handledNow > this.handled) {
      this.handled = handledNow;
      await writeCursor(this.config.dataDir, handledNow, this.config.cursorFile);
    }
  }

  private async recordDeadLetter(key: string, event: DomainEvent, reason: string, attempts: number, at: string): Promise<void> {
    await this.config.deadLetterLog.append(serialiseDeadLetter({
      key, kind: 'dead_lettered', event, reason, attempts, at,
    }));
    this.durablyDead.add(key);
  }

  /** A synthetic event standing in for a well-framed record the parser could not read. */
  private malformedEvent(record: string, index: number): DomainEvent {
    return makeEvent({
      id: `edge-malformed-${index}`,
      type: 'MalformedRecord',
      occurredAt: new Date().toISOString(),
      idempotencyKey: `edge-malformed-${this.config.cursorFile ?? 'sales'}-${index}`,
      source: 'edge/recovery',
      payload: { raw: record, index },
    });
  }
}
