// The CLOSED-DAY EVIDENCE PACK (M14-FR-04 "produce evidence pack (sales, tenders, cash, over/short, exceptions)" · §29 ·
// P-08 · hard rules #2 and #6) — one store's trading day as head office holds it, for the CA.
//
// What it is: the facts of one locked day put side by side — every sale and refund, the takings and refunds per tender,
// each till's cash (expected, counted, over/short and whether a person signed the difference off), every exception raised
// on the day (open or resolved), and every close and controlled reopen of the day with who approved it. Nothing is
// re-decided here: it is a pure read over recorded facts, so the same facts always give the same pack.
//
// The seal: `contentHash` is SHA-256 over the canonical JSON of the pack's CONTENT (every field except the hash and who
// exported it when). The CA re-derives it (`verifyDayEvidencePack`); one changed figure changes the hash. It is a
// tamper-evident fingerprint of what was handed over, not a signature — the CA's signature is EXTERNAL.
//
// Honesty: a day reopened since its last close is still produced, marked `final: false` with the reason; a figure the
// facts cannot give (no till closed its shift, so no counted cash) is said, never shown as ₹0 (P-08).

import { createHash } from 'node:crypto';

export const DAY_EVIDENCE_SCHEMA = 'sre.day-evidence-pack/1';

/** The facts the pack is built from, as head office recorded them. */
export interface DayEvidenceFacts {
  readonly storeId: string;
  readonly storeName?: string;
  readonly tradingDay: string;
  /** Every close of this store-day (a reopened day closed again has two), oldest first. */
  readonly closes: readonly {
    readonly dayCloseId: string; readonly closedBy: string; readonly closedAt: string;
    readonly governanceFlags?: readonly string[];
    readonly carriedForward?: { readonly approvedBy: string; readonly reason: string; readonly attemptIds: readonly string[]; readonly unresolvedMinor: { readonly card: number; readonly upi: number }; readonly flags: readonly string[] };
  }[];
  readonly reopens: readonly {
    readonly dayCloseId: string; readonly reopenedBy: string; readonly approvedBy: string | null; readonly reason: string; readonly reopenedAt: string; readonly governanceFlags: readonly string[];
  }[];
  readonly sales: readonly {
    readonly saleId: string; readonly receiptNumber: string; readonly laneId: string; readonly cashierId: string; readonly committedAt: string;
    readonly totalMinor: number; readonly tenders: readonly { readonly kind: string; readonly amountMinor: number }[];
  }[];
  readonly refunds: readonly {
    readonly returnId: string; readonly number: string; readonly originalSaleId: string | null; readonly processedBy: string; readonly processedAt: string;
    readonly refundMinor: number; readonly refundTender: string; readonly reasonCode: string; readonly approvedBy?: string; readonly governanceFlags?: readonly string[];
  }[];
  readonly shifts: readonly {
    readonly shiftId: string; readonly tillId: string; readonly cashierId: string; readonly closedAt: string;
    readonly expectedMinor: number; readonly countedMinor: number; readonly varianceMinor: number;
    readonly exceptionRaised: boolean; readonly reasonCode: string | null;
    readonly review?: { readonly reviewedBy: string; readonly disposition: string; readonly reviewedAt: string };
  }[];
  readonly saleExceptions: readonly { readonly saleId: string; readonly kind: string; readonly severity: string; readonly detail: string; readonly differenceMinor?: number }[];
}

export interface DayEvidenceException {
  /** Where it came from: a sale, a refund, a till's cash, the close, a reopen, a carried payment. */
  readonly source: 'sale' | 'refund' | 'cash' | 'close' | 'reopen' | 'carried_payment';
  readonly ref: string;
  readonly kind: string;
  readonly severity: string;
  readonly detail: string;
  readonly amountMinor?: number;
  /** Whether a person has resolved it on the record (an over/short signed off). Resolved ones stay listed (hard rule #6). */
  readonly resolved: boolean;
}

export interface DayEvidencePack {
  readonly schema: typeof DAY_EVIDENCE_SCHEMA;
  readonly storeId: string;
  readonly storeName: string | null;
  readonly tradingDay: string;
  /** True when the day's last event is a close (locked); false when it was reopened after its last close. */
  readonly final: boolean;
  readonly notFinalBecause: string | null;
  readonly sales: {
    readonly count: number; readonly grossMinor: number;
    readonly byLane: readonly { readonly laneId: string; readonly count: number; readonly grossMinor: number }[];
    readonly bills: readonly { readonly saleId: string; readonly receiptNumber: string; readonly laneId: string; readonly cashierId: string; readonly committedAt: string; readonly totalMinor: number }[];
  };
  readonly refunds: {
    readonly count: number; readonly totalMinor: number;
    readonly items: readonly { readonly returnId: string; readonly number: string; readonly originalSaleId: string | null; readonly processedBy: string; readonly processedAt: string; readonly refundMinor: number; readonly refundTender: string; readonly reasonCode: string; readonly approvedBy: string | null }[];
  };
  readonly tenders: readonly { readonly kind: string; readonly takenMinor: number; readonly refundedMinor: number; readonly netMinor: number }[];
  readonly cash: {
    /** Null when no till closed its shift for the day — counted cash is not known (never ₹0). */
    readonly expectedMinor: number | null; readonly countedMinor: number | null; readonly overShortMinor: number | null;
    readonly notKnownBecause: string | null;
    readonly tills: readonly { readonly shiftId: string; readonly tillId: string; readonly cashierId: string; readonly closedAt: string; readonly expectedMinor: number; readonly countedMinor: number; readonly overShortMinor: number; readonly reasonCode: string | null; readonly signedOffBy: string | null }[];
  };
  readonly overShort: readonly { readonly shiftId: string; readonly tillId: string; readonly overShortMinor: number; readonly material: boolean; readonly signedOffBy: string | null; readonly disposition: string | null }[];
  readonly exceptions: readonly DayEvidenceException[];
  readonly openExceptions: number;
  readonly history: readonly { readonly at: string; readonly event: 'closed' | 'reopened'; readonly dayCloseId: string; readonly by: string; readonly approvedBy: string | null; readonly reason: string | null; readonly flags: readonly string[] }[];
  /** SHA-256 (hex) over the canonical JSON of every field above. */
  readonly contentHash: string;
}

/** JSON with every object's keys in order — the bytes the hash is taken over. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonicalJson(x))).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

const hashOf = (content: Omit<DayEvidencePack, 'contentHash'>): string => createHash('sha256').update(canonicalJson(content), 'utf8').digest('hex');
const rupees = (minor: number | null): string => (minor === null ? 'not known' : (minor / 100).toFixed(2));
const byText = <T>(key: (x: T) => string) => (a: T, b: T): number => key(a).localeCompare(key(b));

export class NoCloseForThisDayError extends Error {
  constructor(storeId: string, tradingDay: string) {
    super(`Store ${storeId} has no recorded close for ${tradingDay}, so there is no closed day to put in an evidence pack.`);
    this.name = 'NoCloseForThisDayError';
  }
}

/** Build the pack. Pure; the order of the facts given does not change it. Throws when the day was never closed. */
export function buildDayEvidencePack(facts: DayEvidenceFacts): DayEvidencePack {
  if (facts.closes.length === 0) throw new NoCloseForThisDayError(facts.storeId, facts.tradingDay);
  const sales = [...facts.sales].sort(byText((s) => `${s.committedAt}\u0000${s.saleId}`));
  const refunds = [...facts.refunds].sort(byText((r) => `${r.processedAt}\u0000${r.returnId}`));
  const shifts = [...facts.shifts].sort(byText((s) => `${s.tillId}\u0000${s.closedAt}\u0000${s.shiftId}`));

  const lanes = new Map<string, { count: number; grossMinor: number }>();
  for (const s of sales) { const l = lanes.get(s.laneId) ?? { count: 0, grossMinor: 0 }; l.count += 1; l.grossMinor += s.totalMinor; lanes.set(s.laneId, l); }

  const tenders = new Map<string, { takenMinor: number; refundedMinor: number }>();
  const tender = (k: string) => { const t = tenders.get(k) ?? { takenMinor: 0, refundedMinor: 0 }; tenders.set(k, t); return t; };
  for (const s of sales) for (const t of s.tenders) tender(t.kind).takenMinor += t.amountMinor;
  for (const r of refunds) tender(r.refundTender).refundedMinor += r.refundMinor;

  const tills = shifts.map((s) => ({
    shiftId: s.shiftId, tillId: s.tillId, cashierId: s.cashierId, closedAt: s.closedAt, expectedMinor: s.expectedMinor, countedMinor: s.countedMinor,
    overShortMinor: s.varianceMinor, reasonCode: s.reasonCode, signedOffBy: s.review?.reviewedBy ?? null,
  }));
  const sum = (f: (t: (typeof tills)[number]) => number): number => tills.reduce((n, t) => n + f(t), 0);

  const exceptions: DayEvidenceException[] = [
    ...[...facts.saleExceptions].sort(byText((e) => `${e.saleId}\u0000${e.kind}`)).map((e): DayEvidenceException => ({
      source: 'sale', ref: e.saleId, kind: e.kind, severity: e.severity, detail: e.detail, ...(e.differenceMinor === undefined ? {} : { amountMinor: e.differenceMinor }), resolved: false,
    })),
    ...refunds.flatMap((r) => (r.governanceFlags ?? []).map((f): DayEvidenceException => ({ source: 'refund', ref: r.returnId, kind: f, severity: 'material', detail: `Refund ${r.number}: ${f.replace(/_/g, ' ')}.`, amountMinor: r.refundMinor, resolved: false }))),
    ...shifts.filter((s) => s.exceptionRaised).map((s): DayEvidenceException => ({
      source: 'cash', ref: s.shiftId, kind: 'cash_over_short', severity: 'material',
      detail: `Till ${s.tillId}: counted ₹${rupees(s.countedMinor)} against ₹${rupees(s.expectedMinor)} expected — ${s.varianceMinor > 0 ? 'over' : 'short'} by ₹${rupees(Math.abs(s.varianceMinor))}.${s.review === undefined ? ' Not yet signed off.' : ` Signed off by ${s.review.reviewedBy}: ${s.review.disposition}.`}`,
      amountMinor: s.varianceMinor, resolved: s.review !== undefined,
    })),
    ...facts.closes.flatMap((c) => [
      ...(c.governanceFlags ?? []).map((f): DayEvidenceException => ({ source: 'close', ref: c.dayCloseId, kind: f, severity: 'material', detail: `The close ${c.dayCloseId} by ${c.closedBy}: ${f.replace(/_/g, ' ')}.`, resolved: false })),
      ...(c.carriedForward === undefined ? [] : [{
        source: 'carried_payment' as const, ref: c.dayCloseId, kind: 'card_upi_carried_forward', severity: 'material',
        detail: `${c.carriedForward.attemptIds.length} card/UPI payment(s) carried forward to head office unresolved (approved by ${c.carriedForward.approvedBy}: ${c.carriedForward.reason}).${c.carriedForward.flags.length === 0 ? '' : ` Flags: ${c.carriedForward.flags.join(', ')}.`}`,
        amountMinor: c.carriedForward.unresolvedMinor.card + c.carriedForward.unresolvedMinor.upi, resolved: false,
      }]),
    ]),
    ...facts.reopens.flatMap((r) => r.governanceFlags.map((f): DayEvidenceException => ({ source: 'reopen', ref: r.dayCloseId, kind: f, severity: 'material', detail: `The reopen of ${r.dayCloseId} by ${r.reopenedBy}: ${f.replace(/_/g, ' ')}.`, resolved: false }))),
  ];

  // Each reopen belongs to the close it reopened, so it follows that close — whatever the clocks say (a reopen is timed by
  // head office when it arrives, a close by the store computer). The closes go in the order they were made.
  const history = [...facts.closes].sort(byText((c) => `${c.closedAt}\u0000${c.dayCloseId}`)).flatMap((c) => [
    { at: c.closedAt, event: 'closed' as const, dayCloseId: c.dayCloseId, by: c.closedBy, approvedBy: c.carriedForward?.approvedBy ?? null, reason: null, flags: [...(c.governanceFlags ?? [])] },
    ...facts.reopens.filter((r) => r.dayCloseId === c.dayCloseId).map((r) => ({ at: r.reopenedAt, event: 'reopened' as const, dayCloseId: r.dayCloseId, by: r.reopenedBy, approvedBy: r.approvedBy, reason: r.reason, flags: [...r.governanceFlags] })),
  ]);
  const last = history[history.length - 1]!;
  const final = last.event === 'closed';

  const content: Omit<DayEvidencePack, 'contentHash'> = {
    schema: DAY_EVIDENCE_SCHEMA,
    storeId: facts.storeId, storeName: facts.storeName ?? null, tradingDay: facts.tradingDay,
    final,
    notFinalBecause: final ? null : `The day was reopened on ${last.at} by ${last.by}${last.approvedBy === null ? '' : ` (approved by ${last.approvedBy})`} and has not been closed again — these figures may still change.`,
    sales: {
      count: sales.length, grossMinor: sales.reduce((n, s) => n + s.totalMinor, 0),
      byLane: [...lanes.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([laneId, l]) => ({ laneId, ...l })),
      bills: sales.map((s) => ({ saleId: s.saleId, receiptNumber: s.receiptNumber, laneId: s.laneId, cashierId: s.cashierId, committedAt: s.committedAt, totalMinor: s.totalMinor })),
    },
    refunds: {
      count: refunds.length, totalMinor: refunds.reduce((n, r) => n + r.refundMinor, 0),
      items: refunds.map((r) => ({ returnId: r.returnId, number: r.number, originalSaleId: r.originalSaleId, processedBy: r.processedBy, processedAt: r.processedAt, refundMinor: r.refundMinor, refundTender: r.refundTender, reasonCode: r.reasonCode, approvedBy: r.approvedBy ?? null })),
    },
    tenders: [...tenders.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([kind, t]) => ({ kind, ...t, netMinor: t.takenMinor - t.refundedMinor })),
    cash: tills.length === 0
      ? { expectedMinor: null, countedMinor: null, overShortMinor: null, notKnownBecause: 'No till closed its shift for this day at head office, so the counted cash is not known.', tills: [] }
      : { expectedMinor: sum((t) => t.expectedMinor), countedMinor: sum((t) => t.countedMinor), overShortMinor: sum((t) => t.overShortMinor), notKnownBecause: null, tills },
    overShort: shifts.filter((s) => s.varianceMinor !== 0).map((s) => ({ shiftId: s.shiftId, tillId: s.tillId, overShortMinor: s.varianceMinor, material: s.exceptionRaised, signedOffBy: s.review?.reviewedBy ?? null, disposition: s.review?.disposition ?? null })),
    exceptions,
    openExceptions: exceptions.filter((e) => !e.resolved).length,
    history,
  };
  return { ...content, contentHash: hashOf(content) };
}

/** Re-derive the hash (the CA's check): true only when every figure is as it was sealed. */
export function verifyDayEvidencePack(pack: DayEvidencePack): boolean {
  const { contentHash, ...content } = pack;
  return typeof contentHash === 'string' && hashOf(content) === contentHash;
}

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v);
  // A cell a spreadsheet would run as a formula is written as text (CSV injection).
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** The pack as one CSV for the CA's spreadsheet: section, item, figures (₹), detail — and the hash on its last row. */
export function dayEvidenceCsv(pack: DayEvidencePack): string {
  const rows: unknown[][] = [['section', 'item', 'amount_rupees', 'detail']];
  rows.push(['day', pack.storeId, '', `${pack.storeName ?? ''} trading day ${pack.tradingDay}; ${pack.final ? 'closed and locked' : `NOT FINAL — ${pack.notFinalBecause}`}`]);
  rows.push(['sales', 'total', rupees(pack.sales.grossMinor), `${pack.sales.count} bills`]);
  for (const l of pack.sales.byLane) rows.push(['sales', `lane ${l.laneId}`, rupees(l.grossMinor), `${l.count} bills`]);
  for (const b of pack.sales.bills) rows.push(['bill', b.receiptNumber, rupees(b.totalMinor), `${b.saleId} lane ${b.laneId} cashier ${b.cashierId} at ${b.committedAt}`]);
  rows.push(['refunds', 'total', rupees(pack.refunds.totalMinor), `${pack.refunds.count} refunds`]);
  for (const r of pack.refunds.items) rows.push(['refund', r.number, rupees(r.refundMinor), `${r.returnId} by ${r.processedBy}${r.approvedBy === null ? '' : ` approved by ${r.approvedBy}`} via ${r.refundTender} (${r.reasonCode}) against ${r.originalSaleId ?? 'no receipt'}`]);
  for (const t of pack.tenders) rows.push(['tender', t.kind, rupees(t.netMinor), `taken ${rupees(t.takenMinor)}, refunded ${rupees(t.refundedMinor)}`]);
  rows.push(['cash', 'expected', rupees(pack.cash.expectedMinor), pack.cash.notKnownBecause ?? '']);
  rows.push(['cash', 'counted', rupees(pack.cash.countedMinor), pack.cash.notKnownBecause ?? '']);
  rows.push(['cash', 'over/short', rupees(pack.cash.overShortMinor), pack.cash.notKnownBecause ?? '']);
  for (const t of pack.cash.tills) rows.push(['till', t.tillId, rupees(t.overShortMinor), `shift ${t.shiftId} cashier ${t.cashierId}: expected ${rupees(t.expectedMinor)}, counted ${rupees(t.countedMinor)}${t.signedOffBy === null ? '' : `; signed off by ${t.signedOffBy}`}`]);
  for (const e of pack.exceptions) rows.push(['exception', `${e.source} ${e.ref}`, e.amountMinor === undefined ? '' : rupees(e.amountMinor), `${e.kind} (${e.severity}${e.resolved ? ', resolved' : ', open'}): ${e.detail}`]);
  for (const h of pack.history) rows.push(['history', h.event, '', `${h.dayCloseId} by ${h.by} at ${h.at}${h.approvedBy === null ? '' : ` approved by ${h.approvedBy}`}${h.reason === null ? '' : ` — ${h.reason}`}${h.flags.length === 0 ? '' : ` [${h.flags.join(', ')}]`}`]);
  rows.push(['seal', 'sha256', '', pack.contentHash]);
  return `${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
