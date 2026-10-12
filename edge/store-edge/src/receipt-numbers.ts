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
// OB-81 "A" (owner, 12 Oct 2026): bill numbers are unique across STORES. Head office issues each till a short prefix per
// (store, till), carried in the signed store pack as that lane's `receiptSeries` (6-digit counter, 1…999 999, so every
// number is at most 16 characters — packages/contracts/src/receipt-number.ts proves the bound and the uniqueness).
//
// OB-85 "A" (owner, 12 Oct 2026) and verifier r17 (OB81-1, OB81-3, the replaced box) — THE RULE this register applies to
// choose a lane's series, at every issue, from the CURRENT pack and this box's own disk:
//
//   1. HEAD OFFICE'S PREFIX — the lane's published `receiptSeries` — is used when it obeys the OB-81 rule (a prefix head
//      office may issue, 6 digits, inside 1…999 999 — `readPublishedSeries`) AND this box knows where its count stands:
//      either this box has already numbered under it (its own disk), or the pack states `bankedThrough`, the highest
//      count head office holds under that prefix. The count then resumes ABOVE both — so a replaced box (its disk lost)
//      never re-issues a number its predecessor's bills already carry. A series that breaks the rule is IGNORED, said
//      aloud on every answer and the status read (OB81-3); one whose count is not known is not used until it is.
//   2. `R-<lane>-` — this box's own numbering from before prefixes — continues ONLY when the pack says, in so many words,
//      that the business has exactly ONE store (`receiptNumbering.storesInBusiness === 1`) AND that numbering has history
//      for this lane: this box already numbered `R-<lane>-` on its own disk, or head office states it banked `R-<lane>-`
//      numbers for this store (`receiptNumbering.boxSeriesBankedThrough[lane]`), the count resuming above both. So the
//      pilot store's till carries on its numbering all day (its held head-office setup says one store and its disk holds
//      its count, across restarts); the switch happens only when a FACT changes — a second store, or the box falling
//      back to a pack that does not say — never by the clock. A pack that does not say how many stores (a pack FILE, the
//      first boot before head office answers, a pack from before OB-81) is never read as "one store".
//   3. OTHERWISE — the STORE-CODED FALLBACK: `storeComputerDefaultPrefix(store, lane, box identity)` (`ZZ……-`, 9
//      characters, numbers of 15). The box identity is made ONCE on this box's own disk (the first line of this log) and
//      never shared, so two boxes never share a fallback even when neither knows its store, and a replaced box starts a
//      fresh prefix. Still selling offline (P-01), said on every answer (P-08), and flagged at head office on every sale so
//      numbered (services/pos/src/sale-intake.ts `receipt_numbered_without_issued_prefix`) until a prefix is issued.
//
// The log is append-only (hard rule #2) and folded at start, together with the numbers already on the sales and refunds
// logs, so a crash between a record's write and its "used" line cannot free that number for someone else.

import { randomUUID } from 'node:crypto';
import type { OpenFileLog } from './file-log';
import { openFileLog, readLog } from './file-log';
import { RECEIPT_COUNTER_DIGITS, RECEIPT_COUNTER_MAX, RECEIPT_PREFIX_MAX, readPublishedSeries, storeComputerDefaultPrefix } from '../../../packages/contracts/src/receipt-number';

/** A lane's reserved range, as head office publishes it in the store pack (M01-FR-02). */
export interface PackReceiptSeries {
  readonly laneId: string;
  readonly prefix: string;
  readonly padTo: number;
  readonly rangeStart: number;
  readonly rangeEnd: number;
  /** Say "running low" once this many or fewer remain. Absent → 10% of the range. */
  readonly warnAtRemaining?: number;
  /**
   * The highest count head office holds banked under this prefix (0 = none yet) — verifier r17: a replaced box resumes
   * above it. Absent (a pack file, an older pack) → this box uses the prefix only once its own disk has numbered under it.
   */
  readonly bankedThrough?: number;
}

/**
 * Where a lane's numbers come from: head office's published range; this box's own `R-<lane>-` sequence (a business that
 * head office says has ONE store, with that numbering's history); or this box's store-coded fallback (OB-85).
 */
export type SeriesSource = 'published' | 'this_box' | 'store_default';

/** Why a lane numbers under the store-coded fallback (OB-85 · verifier r17) — said on every answer and the status read. */
export type FallbackReason =
  | 'more_than_one_store' | 'store_count_not_said' | 'no_numbering_history' | 'own_numbering_too_long'
  | 'published_series_breaks_rule' | 'published_count_not_known';

/** What the current pack says about the business, for a lane with no published range (OB-81). */
export interface ReceiptNumberingContext {
  /** This box's store, as head office named it in the pack (or the box's own setting). */
  readonly storeId: string | null;
  /** How many stores head office says the business has; null when the pack does not say. */
  readonly storesInBusiness: number | null;
  /**
   * OB-85 · verifier r17: the highest `R-<lane>-` count head office holds banked for this store, per lane — said only for a
   * one-store business. A lane named here has `R-<lane>-` history even on a box whose disk is new.
   */
  readonly boxSeriesBankedThrough?: Readonly<Record<string, number>> | null;
}

/** This box's own sequence for a lane with no published range: `R-<lane>-000001` upwards. */
export const BOX_SERIES_PAD = RECEIPT_COUNTER_DIGITS;
export const BOX_SERIES_END = RECEIPT_COUNTER_MAX;

export type IssueRefusal = 'no_lane' | 'request_key_missing' | 'receipt_numbers_used_up' | 'could_not_write_durably';
export type UseRefusal = 'receipt_number_missing' | 'receipt_number_not_issued' | 'receipt_number_already_used';

export type IssueOutcome =
  | {
    readonly issued: true; readonly receiptNumber: string; readonly remaining: number; readonly runningLow: boolean;
    readonly source: SeriesSource; readonly laneMessage?: string; readonly fallbackBecause?: FallbackReason;
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
  /** Why this lane is on the store-coded fallback, when it is (OB-85). */
  readonly fallbackBecause?: FallbackReason;
}

interface Issued {
  readonly laneId: string; readonly seriesKey: string; readonly seq: number; readonly receiptNumber: string;
  readonly requestKey: string; readonly issuedTo: string; readonly at: string;
}
type LogRecord =
  | ({ readonly kind: 'issued' } & Issued)
  | { readonly kind: 'used'; readonly receiptNumber: string; readonly laneId: string; readonly recordId: string; readonly at: string };
/** The first line of the log: this box's own identity, made once on its disk (OB-85 — never shared with another box). */
interface BoxRecord { readonly kind: 'box'; readonly boxIdentity: string; readonly at: string }

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const countOrUndefined = (v: unknown, min: number): number | undefined =>
  (typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= RECEIPT_COUNTER_MAX ? v : undefined);

/** A series as this register resolved it now: where it comes from, the count it must stay above, and why. */
type Resolved = PackReceiptSeries & {
  readonly source: SeriesSource;
  /** The count head office says is already banked under this prefix: the next number is above it. */
  readonly floor: number;
  readonly fallbackBecause?: FallbackReason;
  readonly words?: string;
};

const NOT_PUBLISHED = 'Head office has not set up a receipt-number range for this till yet, so this store computer is numbering its bills itself. Tell the manager.';
const fallbackWords = (because: FallbackReason, prefix: string, detail: string): string => {
  const own = `this store computer numbers its bills under its own store prefix ${prefix} so they never clash with another store's.`;
  switch (because) {
    case 'more_than_one_store':
      return `Head office has not issued this till its bill-number prefix, and the business has more than one store, so ${own} Tell the manager to issue this till's prefix.`;
    case 'store_count_not_said':
      return `Head office has not issued this till its bill-number prefix, and this store computer has not been told by head office how many stores the business has (it is on a setup file, or has not reached head office yet), so ${own} Tell the manager to issue this till's prefix.`;
    case 'no_numbering_history':
      return `Head office has not issued this till its bill-number prefix, and this till has no earlier bill numbering to carry on, so ${own} Tell the manager to issue this till's prefix.`;
    case 'own_numbering_too_long':
      return `Head office has not issued this till its bill-number prefix, and this till's own numbering would pass GST's 16 characters, so ${own} Tell the manager to issue this till's prefix.`;
    case 'published_series_breaks_rule':
      return `The bill-number range in this store computer's setup for this till breaks the bill-number rule (${detail}), so it is not used: ${own} Tell the manager to issue this till's prefix from head office.`;
    case 'published_count_not_known':
      return `Head office's prefix ${detail} for this till is in this store computer's setup, but head office has not said how far that prefix has been used and this store computer has never numbered under it (it may be a replacement), so to never repeat a bill number ${own} It moves to ${detail} once head office's setup arrives. Tell the manager.`;
  }
};
const keyOf = (s: Pick<PackReceiptSeries, 'prefix' | 'rangeStart' | 'rangeEnd'>): string => `${s.prefix}|${s.rangeStart}|${s.rangeEnd}`;
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
  /** The highest sequence issued per lane per PREFIX (any range): a count never goes back under one prefix. */
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
      readonly numbering: () => ReceiptNumberingContext;
      readonly now: () => string;
    },
    /** OB-85: this box's own identity, from the first line of its log — the fallback prefix is never another box's. */
    readonly boxIdentity: string,
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
    /** OB-81: this box's store and how many stores the business has (from the current pack). Absent → not said. */
    readonly numbering?: () => ReceiptNumberingContext;
    /** The receipt numbers already on this box's sales and refunds logs, with the record each belongs to. */
    readonly committed?: readonly { readonly receiptNumber: string; readonly recordId: string }[];
    readonly now?: () => string;
  }): Promise<ReceiptNumbers> {
    const log = await openFileLog({ dataDir: input.dataDir, capacityBytes: input.capacityBytes, fileName: 'receipt-numbers.log' });
    const now = input.now ?? (() => new Date().toISOString());
    const restored: LogRecord[] = [];
    let identity: string | undefined;
    let unreadable = 0;
    for (const v of await readLog(log.path)) {
      if (!v.ok) { unreadable += 1; continue; }
      try {
        const r = JSON.parse(v.record) as unknown;
        if (isObj(r) && r['kind'] === 'box' && isStr(r['boxIdentity'])) { identity ??= r['boxIdentity']; continue; }
        if (isObj(r) && (r['kind'] === 'issued' || r['kind'] === 'used') && isStr(r['receiptNumber']) && isStr(r['laneId'])) restored.push(r as unknown as LogRecord);
        else unreadable += 1;
      } catch { unreadable += 1; }
    }
    if (identity === undefined) {
      // Made once, on this box's own disk, before any number is given under it. A box whose disk is lost (a replacement)
      // makes a new one — so its fallback prefix is fresh and never continues another box's count.
      identity = randomUUID();
      const rec: BoxRecord = { kind: 'box', boxIdentity: identity, at: now() };
      await log.append(JSON.stringify(rec));
    }
    return new ReceiptNumbers(log, { published: input.published, numbering: input.numbering ?? (() => ({ storeId: null, storesInBusiness: null })), now }, identity, restored, input.committed ?? [], unreadable);
  }

  private fold(r: LogRecord): void {
    if (r.kind === 'issued') {
      if (this.issued.has(r.receiptNumber)) return;
      this.issued.set(r.receiptNumber, r);
      this.byRequest.set(`${r.laneId}|${r.requestKey}`, r.receiptNumber);
      const ck = `${r.laneId}|${r.seriesKey.split('|')[0] ?? ''}`;
      this.cursor.set(ck, Math.max(this.cursor.get(ck) ?? Number.NEGATIVE_INFINITY, r.seq));
    } else if (!this.usedBy.has(r.receiptNumber)) {
      this.usedBy.set(r.receiptNumber, r.recordId);
    }
  }

  /** The rule (header, 1–3): the series this lane draws from NOW, from the current pack and this box's own disk. */
  private seriesFor(laneId: string): Resolved {
    const ctx = this.deps.numbering();
    const fallback = (because: FallbackReason, detail = ''): Resolved => {
      const prefix = storeComputerDefaultPrefix(ctx.storeId ?? '', laneId, this.boxIdentity);
      return { laneId, prefix, padTo: BOX_SERIES_PAD, rangeStart: 1, rangeEnd: BOX_SERIES_END, source: 'store_default', floor: 0, fallbackBecause: because, words: fallbackWords(because, prefix, detail) };
    };
    const hasHistory = (prefix: string): boolean => this.cursor.has(`${laneId}|${prefix}`);
    // 1. Head office's prefix — only one that obeys the OB-81 rule, and only once this box knows where its count stands.
    const mine = (this.deps.published() ?? []).filter((s) => isObj(s) && s.laneId === laneId);
    if (mine.length > 0) {
      const p = mine.find((s) => readPublishedSeries(s).ok);
      if (p === undefined) {
        const why = readPublishedSeries(mine[0]!);
        return fallback('published_series_breaks_rule', why.ok ? '' : why.words);
      }
      const banked = countOrUndefined(p.bankedThrough, 0);
      if (banked === undefined && !hasHistory(p.prefix)) return fallback('published_count_not_known', p.prefix);
      return { ...p, padTo: RECEIPT_COUNTER_DIGITS, source: 'published', floor: banked ?? 0 };
    }
    // 2. `R-<lane>-` — only when head office SAYS one store, and that numbering has history for this lane.
    if (ctx.storesInBusiness === null || !Number.isSafeInteger(ctx.storesInBusiness) || ctx.storesInBusiness < 1) return fallback('store_count_not_said');
    if (ctx.storesInBusiness > 1) return fallback('more_than_one_store');
    const own = `R-${laneId}-`;
    if (own.length > RECEIPT_PREFIX_MAX) return fallback('own_numbering_too_long');
    const bankedOwn = countOrUndefined(ctx.boxSeriesBankedThrough?.[laneId], 1);
    if (bankedOwn === undefined && !hasHistory(own)) return fallback('no_numbering_history');
    return { laneId, prefix: own, padTo: BOX_SERIES_PAD, rangeStart: 1, rangeEnd: BOX_SERIES_END, source: 'this_box', floor: bankedOwn ?? 0, words: NOT_PUBLISHED };
  }

  /** The next count under a series: above this box's own highest under the prefix and above head office's banked count. */
  private nextIn(laneId: string, s: Resolved): number {
    const last = this.cursor.get(`${laneId}|${s.prefix}`);
    return Math.max(s.rangeStart, s.floor + 1, last === undefined ? Number.NEGATIVE_INFINITY : last + 1);
  }

  private remainingIn(laneId: string, s: Resolved): number {
    return Math.max(0, s.rangeEnd - this.nextIn(laneId, s) + 1);
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
    const s = this.seriesFor(laneId);
    const answer = (receiptNumber: string): IssueOutcome => {
      const remaining = this.remainingIn(laneId, s);
      const runningLow = remaining <= warnAt(s);
      const words = [
        ...(s.words === undefined ? [] : [s.words]),
        ...(runningLow ? [`This till has ${remaining} receipt number(s) left in its range. Tell the manager to load a new range.`] : []),
      ];
      return {
        issued: true, receiptNumber, remaining, runningLow, source: s.source,
        ...(words.length === 0 ? {} : { laneMessage: words.join(' ') }),
        ...(s.fallbackBecause === undefined ? {} : { fallbackBecause: s.fallbackBecause }),
      };
    };
    // A lost reply, re-asked: the same number, never a second one.
    const again = this.byRequest.get(`${laneId}|${input.requestKey}`);
    if (again !== undefined) return answer(again);

    let seq = this.nextIn(laneId, s);
    // Never a number this box already gave (a range head office re-drew over one it had used): skip past it.
    while (seq <= s.rangeEnd && this.issued.has(format(s, seq))) seq += 1;
    if (seq > s.rangeEnd) {
      return { issued: false, refusedBecause: 'receipt_numbers_used_up', laneMessage: 'This till has used all its receipt numbers. Do not take money — tell the manager to load a new number range.' };
    }
    const record: LogRecord = {
      kind: 'issued', laneId, seriesKey: keyOf(s), seq, receiptNumber: format(s, seq), requestKey: input.requestKey, issuedTo: input.issuedTo, at: this.deps.now(),
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
    const s = this.seriesFor(laneId);
    const mine = [...this.issued.values()].filter((i) => i.laneId === laneId && i.seriesKey.split('|')[0] === s.prefix).sort((a, b) => a.seq - b.seq);
    const remaining = this.remainingIn(laneId, s);
    return {
      laneId, source: s.source, prefix: s.prefix, rangeStart: s.rangeStart, rangeEnd: s.rangeEnd,
      issued: mine.length,
      used: mine.filter((i) => this.usedBy.has(i.receiptNumber)).length,
      remaining, runningLow: remaining <= warnAt(s),
      issuedNotUsed: mine.filter((i) => !this.usedBy.has(i.receiptNumber)).map((i) => ({ receiptNumber: i.receiptNumber, issuedTo: i.issuedTo, issuedAt: i.at })),
      ...(s.words === undefined ? {} : { laneMessage: s.words }),
      ...(s.fallbackBecause === undefined ? {} : { fallbackBecause: s.fallbackBecause }),
    };
  }

  async close(): Promise<void> {
    await this.log.close();
  }
}
