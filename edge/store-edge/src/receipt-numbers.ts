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
//
// OB-87 "A" (owner, 12 Oct 2026) · verifier r18 OB85-1 — A BOX RESTORED FROM A BACKUP OF ITS OWN DISK. A backup of the
// data folder holds this log as it was at the backup; numbers given after it are not in the copy, so a restored box would
// give them again (customers already hold them). Detected DETERMINISTICALLY, with nothing for staff to remember:
//
//   • THE WITNESS — every number this box gives is also written to a small append-only witness log OUTSIDE the data
//     folder (`EDGE_WITNESS_DIR`, by default the folder `<data folder>-witness` beside it — never inside a backup of the
//     data folder), together with the box identity. At start the box compares its log with its witness:
//       – the witness holds numbers the log does not (the data folder is OLDER than what this box gave): a restore;
//       – the log has numbering history but there is no witness (the data folder was restored or moved onto a computer
//         that never watched it — a new box, a re-imaged one), or the witness watched a different box identity, or the
//         witness cannot be opened: a POSSIBLE restore — treated exactly like one;
//     a fresh box (no history) or an ordinary restart (the witness is a subset of the log) is neither.
//   • ON A RESTORE — the witness's numbers the log lacks are copied into the log (so they are never given again, and they
//     show as "issued, not used": a visible gap), the box takes a BRAND-NEW identity (so its store-coded fallback prefix
//     is one never used before), and every lane numbers under that fresh fallback prefix (`restored_from_backup`, said on
//     every answer) — still selling offline (P-01) — UNTIL HEAD OFFICE'S LATEST SETUP ARRIVES (a live pull that answers
//     updated / renewed / unchanged: `headOfficeConfirmed`). Then the ordinary rule (1–3) applies again, and the count
//     resumes above head office's `bankedThrough` and above this box's own. Both facts — the restore and its clearing —
//     are lines on this append-only log, so a restart in between stays on the fresh prefix.
//   Limit (said, not hidden): a restore onto a NEW computer whose dead predecessor gave numbers it never synced cannot know
//   those numbers — head office never saw them. Head office's finding for any repeated number (sale-intake and the
//   idempotency-conflict register) makes such a clash visible, never silent.
//
// Verifier r19 (OB87-1, OB87-2) — THE WITNESS SELF-CHECK. At start the box checks its witness folder and SAYS what it found
// (`witnessHealth()`: on the status read, on the box's health report to head office, and in its start-up log):
//   • `kept` — the witness folder could be opened and written, outside the data folder;
//   • `unavailable` — it could not be opened (a read-only root with no witness volume, a permissions fault), or it lies
//     INSIDE the data folder (a backup of the data folder would carry it, which defeats it). A box with numbering history
//     then treats every start as a possible restore and takes a fresh prefix — fail-safe, never a repeated number — and
//     says so loudly on every read until the folder is fixed: it is never a silent new prefix each boot.
//   • each box keeps its OWN witness file in the folder, named by its disk's identity (the first line of this log, which a
//     restore of the same disk keeps), so two boxes pointed at one witness folder no longer read each other's witness as a
//     restore on every start (OB87-2); the other boxes' files in the folder are listed (`sharedWith`) so a shared folder is
//     visible and can be fixed. A witness written before r19 (one shared file name) is adopted once when it watched this
//     disk.

import { randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute } from 'node:path';
import type { OpenFileLog } from './file-log';
import { openFileLog, readLog } from './file-log';
import { RECEIPT_COUNTER_DIGITS, RECEIPT_COUNTER_MAX, RECEIPT_PREFIX_MAX, readPublishedSeries, storeComputerDefaultPrefix, financialYearOf } from '../../../packages/contracts/src/receipt-number';
import { DEFAULT_SHOP_CALENDAR } from '../../../packages/calendar/src/shop-clock';

// A2 (roadmap v2.1 addendum · CGST Rule 46(b)) — THE SERIES RESETS ON THE FINANCIAL-YEAR BOUNDARY. When head office issues a
// till its prefix FOR a financial year (the pack's series line carries `financialYear`), this register numbers each bill
// under the prefix of the year the bill is dated in (India time — `financialYearOf`): on 1 April the count starts again at
// 000001 under the new year's prefix, offline, with no head-office call (P-01). Head office issues next year's prefix
// before 1 April; a lane whose year has come with no prefix for it numbers under a store-coded fallback made FOR that year
// (`financial_year_series_not_issued`, said on every answer and flagged at head office) — never the old year's prefix
// carried on. A lane whose pack carries no year on its series numbers exactly as before, and its status says it is not
// year-scoped (P-08).
//
// THE CLOCK (§31.1 · OB-327). Which year a bill is in comes from this box's clock. The clock guard (owned by the store
// computer's offline-queues work) tells this register, through `seriesClock`, whether the clock can be trusted: while it
// cannot, a lane keeps numbering under the year it last numbered in (last-known-good) rather than switching on a clock
// that may be wrong — the switch happens once the clock is trusted again. Until that guard is wired, the box's own clock
// is used and is trusted (the seam: `ReceiptNumbers.open({ seriesClock })`).

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
  /** A2: the financial year this prefix numbers ("2026-27"). Absent → a series with no year (it never resets). */
  readonly financialYear?: string;
}

/** A2 · §31.1: this box's clock as the clock guard judges it — the instant, and whether it can be trusted for a switch. */
export interface SeriesClock {
  readonly nowIso: string;
  readonly trusted: boolean;
}

/**
 * Where a lane's numbers come from: head office's published range; this box's own `R-<lane>-` sequence (a business that
 * head office says has ONE store, with that numbering's history); or this box's store-coded fallback (OB-85).
 */
export type SeriesSource = 'published' | 'this_box' | 'store_default';

/** Why a lane numbers under the store-coded fallback (OB-85 · verifier r17) — said on every answer and the status read. */
export type FallbackReason =
  | 'more_than_one_store' | 'store_count_not_said' | 'no_numbering_history' | 'own_numbering_too_long'
  | 'published_series_breaks_rule' | 'published_count_not_known'
  /** OB-87: this box's data folder was restored from a backup (or may have been) — a fresh prefix until head office answers. */
  | 'restored_from_backup'
  /** A2: the till's prefixes are per financial year, and head office has issued none for the year this bill is dated in. */
  | 'financial_year_series_not_issued';

/** OB-87: why the box judged its data folder restored (said on the status read and kept on the log). */
export type RestoreSign = 'witness_ahead_of_log' | 'witness_missing' | 'witness_of_another_box' | 'witness_unavailable';

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
    /** A2: the financial year the number is in, when the till's series is year-scoped. */
    readonly financialYear?: string;
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
  /** OB-87: a held restore (and why), or a witness fault — said on the status read (P-08). */
  readonly restore?: RestoreState;
  /** A2: whether this till's series resets on the financial-year boundary (head office issued it per year), and the year. */
  readonly financialYearScoped: boolean;
  readonly financialYear?: string;
  /** A2 · §31.1: false while the clock guard does not trust this box's clock — the year in use is then last-known-good. */
  readonly clockTrusted: boolean;
}

/** OB-87: whether this box numbers under a fresh prefix after a (possible) restore, and why; and any witness fault. */
export interface RestoreState {
  readonly held: boolean;
  readonly because?: RestoreSign;
  readonly since?: string;
  readonly witnessFault?: string;
}

/**
 * Verifier r19 OB87-1/OB87-2: the box's own check of its bill-number witness — said on the status read, in the start-up log
 * and on the health report head office judges (`box_bill_numbers:<store>`).
 */
export interface WitnessHealth {
  /** `kept`: opened and written outside the data folder. `unavailable`: it could not be, so every start is a possible restore. `none`: no witness is kept (a unit test). */
  readonly witness: 'kept' | 'unavailable' | 'none';
  /** Why it is unavailable, or the last fault writing it — in words. */
  readonly fault?: string;
  /** Whether the box numbers under a fresh prefix after a (possible) restore right now, why and since when. */
  readonly restoreHeld: boolean;
  readonly restoreBecause?: RestoreSign;
  readonly restoreSince?: string;
  /** Other store computers' witness files in the same folder (a shared folder — OB87-2): a short id and when each was last written. */
  readonly sharedWith: readonly { readonly box: string; readonly lastWrittenAt: string }[];
  /** One sentence for the log and the screens (P-08). */
  readonly says: string;
}

interface Issued {
  readonly laneId: string; readonly seriesKey: string; readonly seq: number; readonly receiptNumber: string;
  readonly requestKey: string; readonly issuedTo: string; readonly at: string;
  /** A2: the financial year the number was given in (a year-scoped series only). */
  readonly financialYear?: string;
}
type LogRecord =
  | ({ readonly kind: 'issued' } & Issued)
  | { readonly kind: 'used'; readonly receiptNumber: string; readonly laneId: string; readonly recordId: string; readonly at: string };
/** The first line of the log: this box's own identity, made once on its disk (OB-85 — never shared with another box). */
interface BoxRecord { readonly kind: 'box'; readonly boxIdentity: string; readonly at: string }
/**
 * OB-87: the box found its data folder restored (or possibly so) — from now on it is a NEW box identity, numbering under a
 * fresh fallback prefix until head office's latest setup arrives. Append-only; the latest identity line wins.
 */
interface RestoreRecord {
  readonly kind: 'restore'; readonly boxIdentity: string; readonly previousIdentity: string; readonly because: RestoreSign;
  readonly absorbed: number; readonly at: string;
}
/** OB-87: head office's latest setup arrived after the restore — the ordinary rule applies again. */
interface RestoreClearedRecord { readonly kind: 'restore_cleared'; readonly at: string; readonly detail: string }
/** A line on the witness log (outside the data folder): the box identity it watches, and each number given. */
type WitnessRecord =
  | { readonly kind: 'box'; readonly boxIdentity: string; readonly at: string }
  | { readonly kind: 'issued'; readonly boxIdentity: string; readonly laneId: string; readonly seriesKey: string; readonly seq: number; readonly receiptNumber: string; readonly at: string };

/** The witness log's file name before r19 (one per folder) — read once, to adopt a witness that watched this disk (OB-87). */
/**
 * Round 25 · OB-94: the most numbers-given-and-never-used, and ranges of them, one health report carries per prefix — head
 * office's own bounds (services/platform/src/box-health.ts UNRECEIVED_CHECK_CAP and UNUSED_RANGES_MAX; a test holds them equal).
 */
export const UNUSED_NUMBERS_MAX = 500;
export const UNUSED_RANGES_MAX = 50;

export const WITNESS_FILE = 'receipt-numbers.witness.log';
/** Verifier r19 OB87-2: each box's OWN witness file in the folder, named by its disk's identity (kept across a restore). */
export const witnessFileFor = (diskIdentity: string): string => `receipt-numbers.witness.${diskIdentity}.log`;
const WITNESS_FILE_PATTERN = /^receipt-numbers\.witness\.(.+)\.log$/;
const LEGACY_NEIGHBOUR = 'a store computer from before r19';
/** Whether `inner` is `outer` itself or lies inside it. */
const isInside = (inner: string, outer: string): boolean => {
  const rel = relative(resolve(outer), resolve(inner));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

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
    case 'financial_year_series_not_issued':
      return `Bill numbers start again every financial year, and head office has not issued this till its prefix for ${detail}, so ${own} Tell the manager to issue this till's prefix for ${detail}.`;
    case 'restored_from_backup':
      return `This store computer's data was restored from a backup, or may have been (${detail}), so a bill number it gave after that backup could be given again. To never repeat one, this store computer numbers its bills under a brand-new store prefix ${prefix} that has never been used, so they never clash with another bill. It goes back to the till's own prefix, above the last bill head office holds, as soon as head office's latest setup arrives. Tell the manager.`;
  }
};
const RESTORE_SIGN_WORDS: Readonly<Record<RestoreSign, string>> = {
  witness_ahead_of_log: 'its witness log outside the data folder holds bill numbers its data folder does not',
  witness_missing: 'its data folder has bill-number history but this computer holds no witness log for it — it was moved or restored here',
  witness_of_another_box: 'its witness log outside the data folder watched a different store computer',
  witness_unavailable: 'its witness log outside the data folder could not be opened, so a restore cannot be ruled out',
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
  /** OB-87: set from a detected restore until head office's latest setup arrives (folded from the log). */
  private restoreHold: { readonly because: RestoreSign; readonly at: string } | undefined;
  /** OB-87: the witness log outside the data folder (null when none is kept or it could not be opened). */
  private readonly witness: OpenFileLog | null;
  /** The last fault opening or writing the witness, said on the status read (P-08). */
  private witnessFault: string | undefined;
  /** Verifier r19: whether a witness is kept at all (a unit test of the numbering alone keeps none). */
  private readonly witnessKept: boolean;
  /** Verifier r19 OB87-2: the witness folder and this box's own file in it — to list other boxes' files beside it. */
  private readonly witnessWhere: { readonly dir: string; readonly own: string; readonly legacyAdopted: boolean } | undefined;
  private witnessNeighbours: { readonly box: string; readonly lastWrittenAt: string }[] = [];

  private constructor(
    private readonly log: OpenFileLog,
    private readonly deps: {
      /** The ranges in the CURRENT pack; `null` when the pack carries none. */
      readonly published: () => readonly PackReceiptSeries[] | null;
      readonly numbering: () => ReceiptNumberingContext;
      readonly now: () => string;
      /** A2 · §31.1: the clock the financial year is judged by (the clock guard's seam); absent → `now`, trusted. */
      readonly seriesClock?: () => SeriesClock;
      /** M01-FR-02 (T1): the shop's time zone, from the CURRENT signed pack; absent → the shop default (Asia/Kolkata). */
      readonly timeZone?: () => string;
    },
    /** OB-85: this box's own identity, from the first line of its log — the fallback prefix is never another box's. */
    readonly boxIdentity: string,
    restored: readonly LogRecord[],
    committed: readonly { readonly receiptNumber: string; readonly recordId: string }[],
    unreadable: number,
    hold?: { readonly because: RestoreSign; readonly at: string },
    witness?: {
      readonly log: OpenFileLog | null; readonly fault?: string; readonly dir?: string; readonly own?: string; readonly legacyAdopted?: boolean;
      readonly neighbours?: { box: string; lastWrittenAt: string }[];
    },
  ) {
    this.unreadableRecords = unreadable;
    this.restoreHold = hold;
    this.witness = witness?.log ?? null;
    this.witnessFault = witness?.fault;
    this.witnessKept = witness !== undefined;
    this.witnessWhere = witness?.dir === undefined || witness.own === undefined ? undefined : { dir: witness.dir, own: witness.own, legacyAdopted: witness.legacyAdopted === true };
    this.witnessNeighbours = witness?.neighbours ?? [];
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
    /**
     * OB-87: the folder OUTSIDE the data folder where the witness log lives (main.ts: `EDGE_WITNESS_DIR`, else
     * `<data folder>-witness`). Absent or `null` → no witness is kept (a unit test of the numbering alone): no detection.
     */
    readonly witnessDir?: string | null;
    /**
     * A2 · §31.1 · OB-327 — THE SEAM for the clock guard: this box's clock and whether it is trusted. While it is not, a
     * year-scoped lane keeps the year it last numbered in. Absent → the box's own clock (`now`), trusted.
     */
    readonly seriesClock?: () => SeriesClock;
    /**
     * M01-FR-02 (re-audit T1): the shop's time zone (`policies.timeZone` in the signed pack — shop-zone.ts `packTimeZone`),
     * read at each bill so the year a bill is numbered in is its date in the SHOP, never the machine's zone or a fixed
     * +05:30. Absent → the shop default (Asia/Kolkata). The cut-off does not move a bill's year (receipt-number.ts).
     */
    readonly timeZone?: () => string;
  }): Promise<ReceiptNumbers> {
    const log = await openFileLog({ dataDir: input.dataDir, capacityBytes: input.capacityBytes, fileName: 'receipt-numbers.log' });
    const now = input.now ?? (() => new Date().toISOString());
    const restored: LogRecord[] = [];
    let identity: string | undefined;
    /** The disk's identity — the FIRST box line, which a restore of the same disk keeps (names its witness file). */
    let diskIdentity: string | undefined;
    /** Every identity this disk has had (its box line and each restore line) — to adopt a pre-r19 witness that watched it. */
    const lineage = new Set<string>();
    let hold: { because: RestoreSign; at: string } | undefined;
    let unreadable = 0;
    for (const v of await readLog(log.path)) {
      if (!v.ok) { unreadable += 1; continue; }
      try {
        const r = JSON.parse(v.record) as unknown;
        // The FIRST box line is the disk's identity; a later restore line replaces it (OB-87 — the latest restore wins).
        if (isObj(r) && r['kind'] === 'box' && isStr(r['boxIdentity'])) { identity ??= r['boxIdentity']; diskIdentity ??= r['boxIdentity']; lineage.add(r['boxIdentity']); continue; }
        if (isObj(r) && r['kind'] === 'restore' && isStr(r['boxIdentity'])) {
          identity = r['boxIdentity'];
          lineage.add(r['boxIdentity']);
          hold = { because: (isStr(r['because']) ? r['because'] : 'witness_missing') as RestoreSign, at: isStr(r['at']) ? r['at'] : '' };
          continue;
        }
        if (isObj(r) && r['kind'] === 'restore_cleared') { hold = undefined; continue; }
        if (isObj(r) && (r['kind'] === 'issued' || r['kind'] === 'used') && isStr(r['receiptNumber']) && isStr(r['laneId'])) restored.push(r as unknown as LogRecord);
        else unreadable += 1;
      } catch { unreadable += 1; }
    }
    const freshDisk = identity === undefined;
    if (identity === undefined) {
      // Made once, on this box's own disk, before any number is given under it. A box whose disk is lost (a replacement)
      // makes a new one — so its fallback prefix is fresh and never continues another box's count.
      identity = randomUUID();
      diskIdentity = identity;
      lineage.add(identity);
      const rec: BoxRecord = { kind: 'box', boxIdentity: identity, at: now() };
      await log.append(JSON.stringify(rec));
    }
    const witness = input.witnessDir === undefined || input.witnessDir === null ? undefined
      : await ReceiptNumbers.judgeWitness({
        log, witnessDir: input.witnessDir, dataDir: input.dataDir, capacityBytes: input.capacityBytes, restored, identity,
        diskIdentity: diskIdentity ?? identity, lineage, freshDisk, now,
      });
    if (witness?.restore !== undefined) { identity = witness.restore.identity; hold = { because: witness.restore.because, at: witness.restore.at }; }
    return new ReceiptNumbers(log, { published: input.published, numbering: input.numbering ?? (() => ({ storeId: null, storesInBusiness: null })), now, ...(input.seriesClock === undefined ? {} : { seriesClock: input.seriesClock }), ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }) }, identity, restored, input.committed ?? [], unreadable, hold, witness);
  }

  /**
   * OB-87: compare the data folder's log with the witness outside it (header). On a restore — or a possible one — the
   * witness's numbers the log lacks are copied onto the log (pushed onto `restored` so they fold as issued), and a restore
   * line gives the box a brand-new identity. The witness is (re)told the identity it now watches.
   */
  private static async judgeWitness(input: {
    readonly log: OpenFileLog; readonly witnessDir: string; readonly dataDir: string; readonly capacityBytes: number; readonly restored: LogRecord[];
    readonly identity: string; readonly diskIdentity: string; readonly lineage: ReadonlySet<string>; readonly freshDisk: boolean; readonly now: () => string;
  }): Promise<{
    log: OpenFileLog | null; fault?: string; dir: string; own: string; legacyAdopted: boolean; neighbours: { box: string; lastWrittenAt: string }[];
    restore?: { identity: string; because: RestoreSign; at: string };
  }> {
    const own = witnessFileFor(input.diskIdentity);
    const witnessPath = join(input.witnessDir, own);
    let existed: boolean;
    try { await stat(witnessPath); existed = true; } catch { existed = false; }
    const issuedSeen: Extract<WitnessRecord, { kind: 'issued' }>[] = [];
    let watched: string | undefined;
    let wlog: OpenFileLog | null = null;
    let fault: string | undefined;
    // Read one witness file: its box lines (the latest is the identity it watches) and its issued numbers; answers the lines.
    const readWitness = async (path: string): Promise<string[]> => {
      const lines: string[] = [];
      for (const v of await readLog(path)) {
        if (!v.ok) continue;
        try {
          const r = JSON.parse(v.record) as unknown;
          if (isObj(r) && r['kind'] === 'box' && isStr(r['boxIdentity'])) { watched = r['boxIdentity']; lines.push(v.record); continue; }
          if (isObj(r) && r['kind'] === 'issued' && isStr(r['receiptNumber']) && isStr(r['laneId']) && isStr(r['seriesKey']) && typeof r['seq'] === 'number') {
            issuedSeen.push(r as unknown as Extract<WitnessRecord, { kind: 'issued' }>);
            lines.push(v.record);
          }
        } catch { /* an unreadable witness line is skipped: the data folder's log is the record */ }
      }
      return lines;
    };
    let adoptLegacy: string[] = [];
    // Verifier r19 OB87-1 — the self-check: a witness folder INSIDE the data folder would be backed up and restored WITH the
    // data, which defeats it. It is refused as unavailable (every start a possible restore — fail-safe), and said loudly.
    if (isInside(input.witnessDir, input.dataDir)) {
      fault = `the witness folder ${input.witnessDir} is INSIDE the data folder ${input.dataDir}, so a backup of the data folder would carry it and a restore could not be seen — give EDGE_WITNESS_DIR a folder (or volume) of its own, outside the data folder`;
    } else {
      try {
        if (existed) await readWitness(witnessPath);
        else {
          // A witness written before r19 (one file per folder): adopted once, only when it watched THIS disk.
          const legacy = join(input.witnessDir, WITNESS_FILE);
          let legacyExists = false;
          try { await stat(legacy); legacyExists = true; } catch { legacyExists = false; }
          if (legacyExists && (await readLog(legacy)).some((v) => {
            if (!v.ok) return false;
            try { const r = JSON.parse(v.record) as unknown; return isObj(r) && r['kind'] === 'box' && isStr(r['boxIdentity']) && input.lineage.has(r['boxIdentity']); } catch { return false; }
          })) {
            adoptLegacy = await readWitness(legacy);
            existed = true;
          }
        }
        wlog = await openFileLog({ dataDir: input.witnessDir, capacityBytes: input.capacityBytes, fileName: own });
        for (const line of adoptLegacy) await wlog.append(line);
      } catch (e) {
        fault = wlog === null
          ? `the witness log outside the data folder could not be opened (${e instanceof Error ? e.message : String(e)})`
          : `the witness log could not be written (${e instanceof Error ? e.message : String(e)})`;
      }
    }
    const inLog = new Set(input.restored.filter((r) => r.kind === 'issued').map((r) => r.receiptNumber));
    const ahead = [...new Map(issuedSeen.filter((w) => !inLog.has(w.receiptNumber)).map((w) => [w.receiptNumber, w])).values()];
    const sign: RestoreSign | undefined = ahead.length > 0 ? 'witness_ahead_of_log'
      : inLog.size === 0 ? undefined
      : wlog === null ? 'witness_unavailable'
      : !existed ? 'witness_missing'
      : watched !== undefined && watched !== input.identity ? 'witness_of_another_box'
      : undefined;
    const at = input.now();
    let identity = input.identity;
    let restore: { identity: string; because: RestoreSign; at: string } | undefined;
    if (sign !== undefined) {
      // The numbers this box gave after the backup: on the log now, so never given again (and visible as issued, not used).
      for (const w of ahead) {
        const rec: LogRecord = {
          kind: 'issued', laneId: w.laneId, seriesKey: w.seriesKey, seq: w.seq, receiptNumber: w.receiptNumber,
          requestKey: `witnessed:${w.receiptNumber}`, issuedTo: 'before the restore (from the witness log)', at: w.at,
        };
        await input.log.append(JSON.stringify(rec));
        input.restored.push(rec);
      }
      identity = randomUUID();
      const rec: RestoreRecord = { kind: 'restore', boxIdentity: identity, previousIdentity: input.identity, because: sign, absorbed: ahead.length, at };
      await input.log.append(JSON.stringify(rec));
      restore = { identity, because: sign, at };
    }
    if (wlog !== null && (restore !== undefined || input.freshDisk || !existed || watched !== identity)) {
      try {
        await wlog.append(JSON.stringify({ kind: 'box', boxIdentity: identity, at } satisfies WitnessRecord));
      } catch (e) {
        fault = `the witness log could not be written (${e instanceof Error ? e.message : String(e)})`;
      }
    }
    const legacyAdopted = adoptLegacy.length > 0;
    const neighbours = wlog === null ? [] : await ReceiptNumbers.neighboursIn(input.witnessDir, own, legacyAdopted);
    return { log: wlog, dir: input.witnessDir, own, legacyAdopted, neighbours, ...(fault === undefined ? {} : { fault }), ...(restore === undefined ? {} : { restore }) };
  }

  /** Verifier r19 OB87-2: the OTHER boxes' witness files in this witness folder (a shared folder), each with when it was last written. */
  private static async neighboursIn(dir: string, own: string, legacyAdopted: boolean): Promise<{ box: string; lastWrittenAt: string }[]> {
    try {
      const out: { box: string; lastWrittenAt: string }[] = [];
      for (const name of await readdir(dir)) {
        if (name === own || (name === WITNESS_FILE && legacyAdopted)) continue;
        const m = WITNESS_FILE_PATTERN.exec(name);
        if (m === null && name !== WITNESS_FILE) continue;
        try {
          const st = await stat(join(dir, name));
          out.push({ box: m === null ? LEGACY_NEIGHBOUR : m[1]!.slice(0, 8), lastWrittenAt: st.mtime.toISOString() });
        } catch { /* gone meanwhile */ }
      }
      return out.sort((a, b) => a.box.localeCompare(b.box));
    } catch {
      return [];
    }
  }

  /**
   * Verifier r19 OB87-1/OB87-2: the box's own check of its witness, in words — said on the status read, in the start-up log
   * and on the health report to head office. The other boxes' files beside it are re-listed on each call (one folder read).
   */
  async witnessHealth(): Promise<WitnessHealth> {
    if (this.witnessWhere !== undefined && this.witness !== null) {
      this.witnessNeighbours = await ReceiptNumbers.neighboursIn(this.witnessWhere.dir, this.witnessWhere.own, this.witnessWhere.legacyAdopted);
    }
    return this.witnessHealthNow();
  }

  /** The same, from what is known now (no folder read). */
  witnessHealthNow(): WitnessHealth {
    const witness: WitnessHealth['witness'] = !this.witnessKept ? 'none' : this.witness === null ? 'unavailable' : 'kept';
    const hold = this.restoreHold;
    const shared = this.witnessNeighbours;
    const says = [
      witness === 'unavailable'
        ? `BILL-NUMBER WITNESS UNAVAILABLE: ${this.witnessFault ?? 'the witness folder could not be opened'}. Until it is fixed this store computer cannot tell a restart from a restore of its data, so every start with bill-number history numbers under a brand-new prefix (never a repeated bill number). Fix the witness folder (EDGE_WITNESS_DIR — its own writable folder or volume, outside the data folder).`
        : witness === 'kept' && this.witnessFault !== undefined ? `The bill-number witness could not be written last time (${this.witnessFault}).`
        : witness === 'kept' ? 'The bill-number witness outside the data folder is kept.' : 'No bill-number witness is kept on this store computer.',
      ...(hold === undefined ? [] : [`It is numbering bills under a brand-new prefix since ${hold.at}, because ${RESTORE_SIGN_WORDS[hold.because]}, until head office's latest setup arrives.`]),
      ...(shared.length === 0 ? [] : [`Its witness folder also holds the witness of ${shared.length} other store computer(s) (${shared.map((x) => `${x.box}, last written ${x.lastWrittenAt}`).join('; ')}) — if two store computers share one witness folder, give each its own.`]),
    ].join(' ');
    return {
      witness, ...(this.witnessFault === undefined ? {} : { fault: this.witnessFault }),
      restoreHeld: hold !== undefined, ...(hold === undefined ? {} : { restoreBecause: hold.because, restoreSince: hold.at }),
      sharedWith: shared, says,
    };
  }

  /**
   * Verifier r18 item 6: the highest count this box has GIVEN under each prefix — used on a bill or not (a voided or
   * abandoned bill keeps its number). Reported to head office with the box's health, so a replaced box resumes above it.
   */
  issuedThrough(): {
    readonly prefix: string; readonly through: number; readonly soldThrough: number; readonly atRisk?: readonly (readonly [number, number])[];
    readonly unused?: readonly (readonly [number, number])[];
  }[] {
    const by = new Map<string, number>();
    for (const [k, seq] of this.cursor) {
      const prefix = k.slice(k.lastIndexOf('|') + 1);
      if (prefix !== '' && Number.isSafeInteger(seq) && seq >= 1) by.set(prefix, Math.max(by.get(prefix) ?? 0, seq));
    }
    // Verifier r19 (sales lost by a restore · P-08): per prefix, the highest count this box put on a bill or cannot vouch for,
    // and the numbers it cannot vouch for — the ones its witness held after a restore (given after the backup; whether they
    // were sold is lost with the data). Head office checks each against what it banked and names the ones it never received.
    // A number issued and never used on this box (a void, an abandoned bill) is neither: it never raises "never received".
    const sold = new Map<string, number>();
    const risky = new Map<string, number[]>();
    // Round 25 · OB-94 "A": numbers given and never put on a bill (the sale could not be saved after its number was taken) —
    // said to head office, so it never names them "never received" nor sends anyone looking for a paper bill that never was.
    const unusedSeqs = new Map<string, number[]>();
    for (const i of this.issued.values()) {
      const prefix = i.seriesKey.split('|')[0] ?? '';
      if (prefix === '' || !Number.isSafeInteger(i.seq) || i.seq < 1) continue;
      const absorbed = i.requestKey.startsWith('witnessed:');
      if (absorbed) risky.set(prefix, [...(risky.get(prefix) ?? []), i.seq]);
      if (absorbed || this.usedBy.has(i.receiptNumber)) sold.set(prefix, Math.max(sold.get(prefix) ?? 0, i.seq));
      else { const list = unusedSeqs.get(prefix); if (list === undefined) unusedSeqs.set(prefix, [i.seq]); else list.push(i.seq); }
    }
    const ranges = (seqs: number[]): [number, number][] => {
      const out: [number, number][] = [];
      for (const n of [...new Set(seqs)].sort((a, b) => a - b)) {
        const last = out[out.length - 1];
        if (last !== undefined && n === last[1] + 1) last[1] = n; else out.push([n, n]);
      }
      return out.slice(-50);
    };
    // Only the ones head office could ever look for: at or below what was put on a bill, the newest UNUSED_NUMBERS_MAX of
    // them, in at most UNUSED_RANGES_MAX ranges (head office's own bounds — it refuses a report beyond them).
    const unusedOf = (prefix: string, soldThrough: number): [number, number][] => {
      const seqs = [...new Set((unusedSeqs.get(prefix) ?? []).filter((n) => n <= soldThrough))].sort((a, b) => a - b).slice(-UNUSED_NUMBERS_MAX);
      return ranges(seqs).slice(-UNUSED_RANGES_MAX);
    };
    return [...by].map(([prefix, through]) => {
      const soldThrough = Math.min(through, sold.get(prefix) ?? 0);
      const unused = unusedOf(prefix, soldThrough);
      return {
        prefix, through, soldThrough,
        ...(risky.has(prefix) ? { atRisk: ranges(risky.get(prefix)!) } : {}),
        ...(unused.length === 0 ? {} : { unused }),
      };
    }).sort((a, b) => a.prefix.localeCompare(b.prefix)).slice(0, 200);
  }

  /** OB-87: whether this box is numbering under a fresh prefix after a (possible) restore, and why. */
  restoreState(): RestoreState {
    return {
      held: this.restoreHold !== undefined,
      ...(this.restoreHold === undefined ? {} : { because: this.restoreHold.because, since: this.restoreHold.at }),
      ...(this.witnessFault === undefined ? {} : { witnessFault: this.witnessFault }),
    };
  }

  /**
   * OB-87: head office's LATEST setup has arrived (a live pull answered updated / renewed / unchanged) — the pack now
   * carries head office's `bankedThrough`, so the ordinary rule applies again and the count resumes above it. Kept on the
   * log (append-only), so a restart does not go back to the fresh prefix. Nothing is written when no restore is held.
   */
  headOfficeConfirmed(detail: string): Promise<boolean> {
    const run = this.queue.then(async () => {
      if (this.restoreHold === undefined) return false;
      const rec: RestoreClearedRecord = { kind: 'restore_cleared', at: this.deps.now(), detail };
      await this.log.append(JSON.stringify(rec));
      this.restoreHold = undefined;
      return true;
    });
    this.queue = run.catch(() => undefined);
    return run;
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
    // 0. OB-87: a restored (or possibly restored) data folder numbers under the fresh identity's prefix until head office answers.
    if (this.restoreHold !== undefined) return fallback('restored_from_backup', RESTORE_SIGN_WORDS[this.restoreHold.because]);
    const hasHistory = (prefix: string): boolean => this.cursor.has(`${laneId}|${prefix}`);
    // 1. Head office's prefix — only one that obeys the OB-81 rule, and only once this box knows where its count stands.
    const mine = (this.deps.published() ?? []).filter((s) => isObj(s) && s.laneId === laneId);
    // A2: a year-scoped till numbers under the prefix of the year the bill is dated in — or a fallback made FOR that year.
    const yearly = mine.filter((s) => s.financialYear !== undefined);
    if (yearly.length > 0) {
      const fy = this.yearFor(laneId);
      const p = yearly.find((s) => s.financialYear === fy && readPublishedSeries(s).ok);
      if (p === undefined) {
        const prefix = storeComputerDefaultPrefix(ctx.storeId ?? '', laneId, `${this.boxIdentity}\u0000FY${fy}`);
        return {
          laneId, prefix, padTo: BOX_SERIES_PAD, rangeStart: 1, rangeEnd: BOX_SERIES_END, source: 'store_default', floor: 0, financialYear: fy,
          fallbackBecause: 'financial_year_series_not_issued', words: fallbackWords('financial_year_series_not_issued', prefix, fy),
        };
      }
      const banked = countOrUndefined(p.bankedThrough, 0);
      if (banked === undefined && !hasHistory(p.prefix)) return { ...fallback('published_count_not_known', p.prefix), financialYear: fy };
      return { ...p, padTo: RECEIPT_COUNTER_DIGITS, source: 'published', floor: banked ?? 0, financialYear: fy };
    }
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

  /** T1: the shop's zone the year is dated in — the pack's, else the shop default; a zone this runtime cannot read is the default. */
  private shopZone(): string {
    try {
      const z = this.deps.timeZone?.();
      if (typeof z === 'string' && z !== '') { new Intl.DateTimeFormat('en-CA', { timeZone: z }); return z; }
    } catch { /* an unreadable zone falls back to the shop default below */ }
    return DEFAULT_SHOP_CALENDAR.timeZone;
  }

  /** A2: the clock this register judges the year by (the clock guard's, else the box's own — trusted). */
  private clockNow(): SeriesClock {
    try { return this.deps.seriesClock?.() ?? { nowIso: this.deps.now(), trusted: true }; } catch { return { nowIso: this.deps.now(), trusted: false }; }
  }

  /**
   * A2 · §31.1: the financial year a lane's next bill is in — by the clock, or, while the clock guard does not trust it, the
   * year this lane last numbered in (last-known-good; nothing switches on a doubtful clock).
   */
  private yearFor(laneId: string): string {
    const clock = this.clockNow();
    const zone = this.shopZone();
    const byClock = financialYearOf(clock.nowIso, zone) ?? financialYearOf(this.deps.now(), zone) ?? '';
    if (clock.trusted) return byClock;
    const last = [...this.issued.values()].filter((i) => i.laneId === laneId && typeof i.financialYear === 'string').sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).at(-1);
    return last?.financialYear ?? byClock;
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
        ...(s.financialYear === undefined ? {} : { financialYear: s.financialYear }),
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
      ...(s.financialYear === undefined ? {} : { financialYear: s.financialYear }),
    };
    try {
      await this.log.append(JSON.stringify(record));
    } catch (e) {
      return { issued: false, refusedBecause: 'could_not_write_durably', laneMessage: `The store computer could not save the receipt number, so none was given. No money should be taken — ${e instanceof Error ? e.message : String(e)}` };
    }
    this.fold(record);
    // OB-87: the same number on the witness outside the data folder, so a restore of an older copy of the folder is seen.
    // After the log (the record of truth): a witness line that did not land only leaves the witness a subset of the log —
    // never a false restore — and the fault is said on the status read.
    if (this.witness !== null) {
      try {
        await this.witness.append(JSON.stringify({
          kind: 'issued', boxIdentity: this.boxIdentity, laneId, seriesKey: record.seriesKey, seq, receiptNumber: record.receiptNumber, at: record.at,
        } satisfies WitnessRecord));
        this.witnessFault = undefined;
      } catch (e) {
        this.witnessFault = `the witness log could not be written (${e instanceof Error ? e.message : String(e)})`;
      }
    }
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
      ...(this.restoreHold === undefined && this.witnessFault === undefined ? {} : { restore: this.restoreState() }),
      financialYearScoped: s.financialYear !== undefined,
      ...(s.financialYear === undefined ? {} : { financialYear: s.financialYear }),
      clockTrusted: this.clockNow().trusted,
    };
  }

  async close(): Promise<void> {
    await this.log.close();
    if (this.witness !== null) await this.witness.close();
  }
}
