// RECEIPT NUMBERS — issued by this store computer, kept on its disk, bound to the record that used them
// (Wave 4 · audit PF-04 · M01-FR-02 · M12-FR-02 · P-01 · P-08 · hard rules #1, #2, #6).
//
// Before this, the served till numbered its own bills in the browser's memory: a reload started the count again (two
// bills with R-L1-0001), two tabs counted separately, and without a range injected the shell minted a timestamp. Now:
//
//   • the till ASKS this register for the next number for its lane, under a request key it chose (a lost reply re-asked
//     with the same key gets the same number, never a second one);
//   • the number is written to an fsync'd log BEFORE the till hears it — so a reload, a second tab or a restart of the
//     box continue from where the box is, never from 1;
//   • numbers come from the reserved range head office published for the lane (the store pack's `receiptSeries`); a lane
//     with none published draws from this box's own sequence for the lane and SAYS so on every answer and on the status
//     read (P-08) — the till keeps trading (P-01) while head office has not set up its range;
//   • a range that is spent refuses (no money is taken), and one running low says so;
//   • when a sale or refund reaches the disk, its number must be one this box issued to this lane and not already used by
//     a DIFFERENT record — the same record re-sent after a lost reply is the same use. Issued numbers that no record used
//     stay listed as "issued, not used": a gap is visible evidence, never silent.
//
// The log is append-only (hard rule #2) and folded at start, together with the numbers already on the sales and refunds
// logs, so a crash between a record's write and its "used" line cannot free that number for someone else.

import type { OpenFileLog } from './file-log';
import { openFileLog, readLog } from './file-log';

/** A lane's reserved range, as head office publishes it in the store pack (M01-FR-02). */
export interface PackReceiptSeries {
  readonly laneId: string;
  readonly prefix: string;
  readonly padTo: number;
  readonly rangeStart: number;
  readonly rangeEnd: number;
  /** Say "running low" once this many or fewer remain. Absent → 10% of the range. */
  readonly warnAtRemaining?: number;
}

/** Where a lane's numbers come from: head office's published range, or this box's own sequence while none is published. */
export type SeriesSource = 'published' | 'this_box';

/** This box's own sequence for a lane with no published range: `R-<lane>-000001` upwards. */
export const BOX_SERIES_PAD = 6;
export const BOX_SERIES_END = 999_999;

export type IssueRefusal = 'no_lane' | 'request_key_missing' | 'receipt_numbers_used_up' | 'could_not_write_durably';
export type UseRefusal = 'receipt_number_missing' | 'receipt_number_not_issued' | 'receipt_number_already_used';

export type IssueOutcome =
  | {
    readonly issued: true; readonly receiptNumber: string; readonly remaining: number; readonly runningLow: boolean;
    readonly source: SeriesSource; readonly laneMessage?: string;
  }
  | { readonly issued: false; readonly refusedBecause: IssueRefusal; readonly laneMessage: string };

export type UseCheck =
  | { readonly ok: true; readonly record: () => Promise<void> }
  | { readonly ok: false; readonly refusedBecause: UseRefusal; readonly laneMessage: string };

export interface ReceiptNumberStatus {
  readonly laneId: string;
  readonly source: SeriesSource;
  readonly prefix: string;
  readonly rangeStart: number;
  readonly rangeEnd: number;
  readonly issued: number;
  readonly used: number;
  readonly remaining: number;
  readonly runningLow: boolean;
  /** Numbers issued and never used by any record — each a visible gap, with who asked and when. */
  readonly issuedNotUsed: readonly { readonly receiptNumber: string; readonly issuedTo: string; readonly issuedAt: string }[];
  readonly laneMessage?: string;
}

interface Issued {
  readonly laneId: string; readonly seriesKey: string; readonly seq: number; readonly receiptNumber: string;
  readonly requestKey: string; readonly issuedTo: string; readonly at: string;
}
type LogRecord =
  | ({ readonly kind: 'issued' } & Issued)
  | { readonly kind: 'used'; readonly receiptNumber: string; readonly laneId: string; readonly recordId: string; readonly at: string };

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

const NOT_PUBLISHED = 'Head office has not set up a receipt-number range for this till yet, so this store computer is numbering its bills itself. Tell the manager.';

/** The series a lane draws from now: the published one, else this box's own. */
function seriesFor(laneId: string, published: readonly PackReceiptSeries[] | null): PackReceiptSeries & { readonly source: SeriesSource } {
  const p = (published ?? []).find((s) => s.laneId === laneId && isStr(s.prefix) && Number.isSafeInteger(s.rangeStart)
    && Number.isSafeInteger(s.rangeEnd) && s.rangeStart >= 0 && s.rangeEnd >= s.rangeStart);
  if (p !== undefined) return { ...p, padTo: Number.isSafeInteger(p.padTo) && p.padTo > 0 ? p.padTo : 1, source: 'published' };
  return { laneId, prefix: `R-${laneId}-`, padTo: BOX_SERIES_PAD, rangeStart: 1, rangeEnd: BOX_SERIES_END, source: 'this_box' };
}
const keyOf = (s: PackReceiptSeries): string => `${s.prefix}|${s.rangeStart}|${s.rangeEnd}`;
const format = (s: PackReceiptSeries, seq: number): string => `${s.prefix}${String(seq).padStart(s.padTo, '0')}`;
const warnAt = (s: PackReceiptSeries): number =>
  (typeof s.warnAtRemaining === 'number' && Number.isSafeInteger(s.warnAtRemaining) && s.warnAtRemaining >= 0
    ? s.warnAtRemaining
    : Math.ceil((s.rangeEnd - s.rangeStart + 1) / 10));

export class ReceiptNumbers {
  /** Every number issued, by number. */
  private readonly issued = new Map<string, Issued>();
  /** lane|requestKey → number, so a re-asked request gets the same answer. */
  private readonly byRequest = new Map<string, string>();
  /** The highest sequence issued per lane per series. */
  private readonly cursor = new Map<string, number>();
  /** number → the record that used it. */
  private readonly usedBy = new Map<string, string>();
  /** One issue at a time: two tabs asking at once are answered in turn, from the same cursor. */
  private queue: Promise<unknown> = Promise.resolve();
  readonly unreadableRecords: number;

  private constructor(
    private readonly log: OpenFileLog,
    private readonly deps: {
      /** The ranges in the CURRENT pack; `null` when the pack carries none. */
      readonly published: () => readonly PackReceiptSeries[] | null;
      readonly now: () => string;
    },
    restored: readonly LogRecord[],
    committed: readonly { readonly receiptNumber: string; readonly recordId: string }[],
    unreadable: number,
  ) {
    this.unreadableRecords = unreadable;
    for (const r of restored) this.fold(r);
    // Numbers already on the sales and refunds logs are used, whether or not their "used" line made it to this log.
    for (const c of committed) if (isStr(c.receiptNumber) && !this.usedBy.has(c.receiptNumber)) this.usedBy.set(c.receiptNumber, c.recordId);
  }

  static async open(input: {
    readonly dataDir: string;
    readonly capacityBytes: number;
    readonly published: () => readonly PackReceiptSeries[] | null;
    /** The receipt numbers already on this box's sales and refunds logs, with the record each belongs to. */
    readonly committed?: readonly { readonly receiptNumber: string; readonly recordId: string }[];
    readonly now?: () => string;
  }): Promise<ReceiptNumbers> {
    const log = await openFileLog({ dataDir: input.dataDir, capacityBytes: input.capacityBytes, fileName: 'receipt-numbers.log' });
    const restored: LogRecord[] = [];
    let unreadable = 0;
    for (const v of await readLog(log.path)) {
      if (!v.ok) { unreadable += 1; continue; }
      try {
        const r = JSON.parse(v.record) as unknown;
        if (isObj(r) && (r['kind'] === 'issued' || r['kind'] === 'used') && isStr(r['receiptNumber']) && isStr(r['laneId'])) restored.push(r as unknown as LogRecord);
        else unreadable += 1;
      } catch { unreadable += 1; }
    }
    return new ReceiptNumbers(log, { published: input.published, now: input.now ?? (() => new Date().toISOString()) }, restored, input.committed ?? [], unreadable);
  }

  private fold(r: LogRecord): void {
    if (r.kind === 'issued') {
      if (this.issued.has(r.receiptNumber)) return;
      this.issued.set(r.receiptNumber, r);
      this.byRequest.set(`${r.laneId}|${r.requestKey}`, r.receiptNumber);
      const ck = `${r.laneId}|${r.seriesKey}`;
      this.cursor.set(ck, Math.max(this.cursor.get(ck) ?? Number.NEGATIVE_INFINITY, r.seq));
    } else if (!this.usedBy.has(r.receiptNumber)) {
      this.usedBy.set(r.receiptNumber, r.recordId);
    }
  }

  private remainingIn(laneId: string, s: PackReceiptSeries): number {
    const last = this.cursor.get(`${laneId}|${keyOf(s)}`);
    const next = last === undefined ? s.rangeStart : last + 1;
    return Math.max(0, s.rangeEnd - next + 1);
  }

  /** The next number for this lane, written to this box's disk before it is answered. */
  issue(input: { readonly laneId: string; readonly requestKey: unknown; readonly issuedTo: string }): Promise<IssueOutcome> {
    const run = this.queue.then(() => this.issueNow(input));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async issueNow(input: { readonly laneId: string; readonly requestKey: unknown; readonly issuedTo: string }): Promise<IssueOutcome> {
    const laneId = input.laneId.trim();
    if (laneId === '') return { issued: false, refusedBecause: 'no_lane', laneMessage: 'This store computer has not been told which till it is. No number was given — tell the manager.' };
    if (!isStr(input.requestKey)) return { issued: false, refusedBecause: 'request_key_missing', laneMessage: 'The till did not say which bill the number is for. No number was given — try again.' };
    const s = seriesFor(laneId, this.deps.published());
    const answer = (receiptNumber: string): IssueOutcome => {
      const remaining = this.remainingIn(laneId, s);
      const runningLow = remaining <= warnAt(s);
      const words = [
        ...(s.source === 'this_box' ? [NOT_PUBLISHED] : []),
        ...(runningLow ? [`This till has ${remaining} receipt number(s) left in its range. Tell the manager to load a new range.`] : []),
      ];
      return { issued: true, receiptNumber, remaining, runningLow, source: s.source, ...(words.length === 0 ? {} : { laneMessage: words.join(' ') }) };
    };
    // A lost reply, re-asked: the same number, never a second one.
    const again = this.byRequest.get(`${laneId}|${input.requestKey}`);
    if (again !== undefined) return answer(again);

    const sk = keyOf(s);
    const last = this.cursor.get(`${laneId}|${sk}`);
    const seq = last === undefined ? s.rangeStart : last + 1;
    if (seq > s.rangeEnd) {
      return { issued: false, refusedBecause: 'receipt_numbers_used_up', laneMessage: 'This till has used all its receipt numbers. Do not take money — tell the manager to load a new number range.' };
    }
    const record: LogRecord = {
      kind: 'issued', laneId, seriesKey: sk, seq, receiptNumber: format(s, seq), requestKey: input.requestKey, issuedTo: input.issuedTo, at: this.deps.now(),
    };
    try {
      await this.log.append(JSON.stringify(record));
    } catch (e) {
      return { issued: false, refusedBecause: 'could_not_write_durably', laneMessage: `The store computer could not save the receipt number, so none was given. No money should be taken — ${e instanceof Error ? e.message : String(e)}` };
    }
    this.fold(record);
    return answer(record.receiptNumber);
  }

  /**
   * Before a sale or refund reaches the disk: its number must be one this box issued to this lane, not used by a different
   * record. On `ok`, call `record()` once the record is on the disk to note the use.
   */
  checkUse(input: { readonly laneId: string; readonly receiptNumber: unknown; readonly recordId: string }): UseCheck {
    const n = input.receiptNumber;
    if (!isStr(n)) return { ok: false, refusedBecause: 'receipt_number_missing', laneMessage: 'This bill has no receipt number from this store computer. Nothing was saved — try again.' };
    const issued = this.issued.get(n);
    if (issued === undefined || issued.laneId !== input.laneId.trim()) {
      return { ok: false, refusedBecause: 'receipt_number_not_issued', laneMessage: `Receipt number ${n} was not given to this till by this store computer. Nothing was saved — try again for a new number.` };
    }
    const by = this.usedBy.get(n);
    if (by !== undefined && by !== input.recordId) {
      return { ok: false, refusedBecause: 'receipt_number_already_used', laneMessage: `Receipt number ${n} is already on another bill. Nothing was saved — try again for a new number.` };
    }
    return {
      ok: true,
      record: async () => {
        if (this.usedBy.get(n) === input.recordId) return;
        const r: LogRecord = { kind: 'used', receiptNumber: n, laneId: issued.laneId, recordId: input.recordId, at: this.deps.now() };
        await this.log.append(JSON.stringify(r));
        this.fold(r);
      },
    };
  }

  /** What this lane has issued, used and left — and every number issued that no record used (a visible gap). */
  status(laneId: string): ReceiptNumberStatus {
    const s = seriesFor(laneId, this.deps.published());
    const sk = keyOf(s);
    const mine = [...this.issued.values()].filter((i) => i.laneId === laneId && i.seriesKey === sk).sort((a, b) => a.seq - b.seq);
    const remaining = this.remainingIn(laneId, s);
    return {
      laneId, source: s.source, prefix: s.prefix, rangeStart: s.rangeStart, rangeEnd: s.rangeEnd,
      issued: mine.length,
      used: mine.filter((i) => this.usedBy.has(i.receiptNumber)).length,
      remaining, runningLow: remaining <= warnAt(s),
      issuedNotUsed: mine.filter((i) => !this.usedBy.has(i.receiptNumber)).map((i) => ({ receiptNumber: i.receiptNumber, issuedTo: i.issuedTo, issuedAt: i.at })),
      ...(s.source === 'this_box' ? { laneMessage: NOT_PUBLISHED } : {}),
    };
  }

  async close(): Promise<void> {
    await this.log.close();
  }
}
