// Input tax credit through GSTR-2B and the Invoice Management System (R3 · A17 · M23 · CGST Act s.16(2)(aa), Rule 36(4)).
//
// The shop may claim the GST it paid its suppliers only for invoices the supplier has REPORTED to the GST portal — the
// monthly GSTR-2B statement lists them. The accountant downloads that statement from the portal and uploads it (OB-145
// "A"). This engine then does four things, and nothing else:
//
//   • READS the 2B file (the portal's JSON) into lines — supplier GSTIN, invoice number, invoice date, the tax on it — and
//     refuses a file it cannot read by naming every line that is wrong, never by taking the readable half (P-08);
//   • MATCHES each line against the shop's own booked supplier invoices — only those that passed the three-way match —
//     on GSTIN + invoice number + date + tax. A line with no booked invoice, and a booked invoice that is in no 2B, are
//     each an EXCEPTION a person sees by name;
//   • holds each line's ACTION — accept, reject or keep pending — as the act of a NAMED, SIGNED-IN person (IMS). A line
//     nobody has acted on is "awaiting a person", never quietly accepted. Only a matched line may be accepted: ITC is
//     claimed only for an invoice the shop holds (s.16(2)(a));
//   • says what ITC may be CLAIMED for the month (GSTR-3B Table 4): the accepted lines only. While any line is awaiting a
//     person, or no 2B has been uploaded, the answer is "not reconciled" — never a zero (P-08).
//
// A reversal (Rule 37 unpaid after 180 days, Rule 42/43 common credit, free samples under A12) is its own compensating
// record beside the claim; nothing already accepted is ever edited (hard rule #2). Pure and deterministic: no clock, no
// I/O; the people and the times arrive as data.

/** A supplier GSTIN as the portal prints it (state code, PAN, entity number, Z, check character). */
export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The four GST components a 2B line and a booked invoice carry, in paise. */
export interface TaxComponents {
  readonly igstMinor: number;
  readonly cgstMinor: number;
  readonly sgstMinor: number;
  readonly cessMinor: number;
}
export const NO_TAX: TaxComponents = Object.freeze({ igstMinor: 0, cgstMinor: 0, sgstMinor: 0, cessMinor: 0 });
const COMPONENTS = ['igstMinor', 'cgstMinor', 'sgstMinor', 'cessMinor'] as const;
const add = (a: TaxComponents, b: TaxComponents): TaxComponents => ({
  igstMinor: a.igstMinor + b.igstMinor, cgstMinor: a.cgstMinor + b.cgstMinor, sgstMinor: a.sgstMinor + b.sgstMinor, cessMinor: a.cessMinor + b.cessMinor,
});
export const taxTotal = (t: TaxComponents): number => t.igstMinor + t.cgstMinor + t.sgstMinor + t.cessMinor;

/** One invoice as the supplier reported it, read from the 2B file. */
export interface Gstr2bLine extends TaxComponents {
  /** Stable for the same supplier GSTIN + invoice number + date — how a person's action finds its line again. */
  readonly lineId: string;
  readonly supplierGstin: string;
  readonly supplierName: string | null;
  readonly invoiceNo: string;
  readonly invoiceDate: string;
  readonly invoiceValueMinor: number;
  readonly taxableMinor: number;
  /** The portal's own "ITC available" flag (`itcavl`) — said, never acted on: the person decides. Null when absent. */
  readonly portalItcAvailable: boolean | null;
  readonly reverseCharge: boolean;
}

export interface Gstr2bStatement {
  /** The month the statement is for, YYYY-MM. */
  readonly period: string;
  /** The shop's own GSTIN the statement was generated for. */
  readonly recipientGstin: string;
  readonly lines: readonly Gstr2bLine[];
}

export type Gstr2bReadResult =
  | { readonly ok: true; readonly statement: Gstr2bStatement }
  | { readonly ok: false; readonly problems: readonly string[] };

/** The invoice number as compared: trimmed, upper case, no spaces — "inv 12" and "INV12" are one bill. */
export const normaliseInvoiceNo = (s: string): string => s.trim().toUpperCase().replace(/\s+/g, '');

/** FNV-1a (64-bit) of the line's identity, hex — short, stable and URL-safe. */
function lineIdOf(gstin: string, invoiceNo: string, date: string): string {
  let h = 0xcbf29ce484222325n;
  for (const ch of `${gstin}|${normaliseInvoiceNo(invoiceNo)}|${date}`) {
    h ^= BigInt(ch.codePointAt(0)!);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `ln-${h.toString(16).padStart(16, '0')}`;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** Rupees as the portal writes them (a number or a numeric string, at most two decimals) → paise; null when not readable. */
export function rupeesToPaise(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return 0;
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

/** The portal's DD-MM-YYYY (or an ISO date) → YYYY-MM-DD; null when it is not a real date. */
function isoDate(v: unknown): string | null {
  const s = str(v);
  if (s === null) return null;
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s);
  const iso = m === null ? s : `${m[3]}-${m[2]}-${m[1]}`;
  if (!ISO_DATE.test(iso)) return null;
  const d = new Date(`${iso}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : iso;
}

/** The portal's return period "MMYYYY" (or YYYY-MM) → YYYY-MM. */
function periodOf(v: unknown): string | null {
  const s = str(v);
  if (s === null) return null;
  const m = /^(0[1-9]|1[0-2])(\d{4})$/.exec(s);
  const p = m === null ? s : `${m[2]}-${m[1]}`;
  return PERIOD.test(p) ? p : null;
}

/**
 * Read the GSTR-2B JSON the accountant downloaded from the portal. The portal's shape is followed as it is written:
 * `{ data: { rtnprd: "MMYYYY", gstin, docdata: { b2b: [ { ctin, trdnm, inv: [ { inum, dt: "DD-MM-YYYY", val, txval,
 * igst, cgst, sgst, cess, itcavl, rev, items?: [...] } ] } ] } } }` (the `data` wrapper optional; an IMS download's `stin`
 * is read like `ctin`). Where an invoice carries its tax only per item, the items are added. Every unreadable part is
 * NAMED; nothing is half-read. Two lines for the same supplier, number and date are refused — one bill is one line.
 */
export function readGstr2b(raw: unknown): Gstr2bReadResult {
  const problems: string[] = [];
  const root = isObj(raw) && isObj(raw['data']) ? raw['data'] : raw;
  if (!isObj(root)) return { ok: false, problems: ['the file is not a GSTR-2B statement (no data object)'] };
  const period = periodOf(root['rtnprd'] ?? root['period']);
  if (period === null) problems.push('the return period (rtnprd, MMYYYY) is missing or not a month');
  const recipient = str(root['gstin']);
  if (recipient === null || !GSTIN_PATTERN.test(recipient.toUpperCase())) problems.push('the shop\'s own GSTIN (gstin) is missing or not a GSTIN');
  const docdata = isObj(root['docdata']) ? root['docdata'] : root;
  const b2b = docdata['b2b'];
  if (!Array.isArray(b2b)) problems.push('the statement has no b2b section (docdata.b2b) — a 2B with no supplier invoices is sent as an empty list');
  const lines: Gstr2bLine[] = [];
  const seen = new Set<string>();
  for (const [si, supplier] of (Array.isArray(b2b) ? b2b : []).entries()) {
    if (!isObj(supplier)) { problems.push(`supplier ${si + 1} is not readable`); continue; }
    const gstin = str(supplier['ctin'] ?? supplier['stin'])?.toUpperCase() ?? null;
    if (gstin === null || !GSTIN_PATTERN.test(gstin)) { problems.push(`supplier ${si + 1}: the supplier GSTIN (ctin) is missing or not a GSTIN`); continue; }
    const invs = supplier['inv'];
    if (!Array.isArray(invs)) { problems.push(`supplier ${gstin}: no invoice list (inv)`); continue; }
    for (const [ii, inv] of invs.entries()) {
      const where = `supplier ${gstin}, invoice ${ii + 1}`;
      if (!isObj(inv)) { problems.push(`${where} is not readable`); continue; }
      const invoiceNo = str(inv['inum']);
      const invoiceDate = isoDate(inv['dt']);
      if (invoiceNo === null) problems.push(`${where}: no invoice number (inum)`);
      if (invoiceDate === null) problems.push(`${where}: the invoice date (dt) is not a date`);
      const value = rupeesToPaise(inv['val']);
      if (value === null) problems.push(`${where}: the invoice value (val) is not an amount in rupees`);
      const items = Array.isArray(inv['items']) ? inv['items'] : null;
      const read = (o: Record<string, unknown>, k: string): number | null => rupeesToPaise(o[k]);
      let taxable: number | null = 0;
      let tax: TaxComponents | null = NO_TAX;
      const hasInvoiceTax = ['txval', 'igst', 'cgst', 'sgst', 'cess'].some((k) => inv[k] !== undefined);
      for (const part of hasInvoiceTax || items === null ? [inv] : items) {
        if (!isObj(part)) { taxable = null; tax = null; break; }
        const [tx, ig, cg, sg, ce] = ['txval', 'igst', 'cgst', 'sgst', 'cess'].map((k) => read(part, k));
        if (tx === null || ig === null || cg === null || sg === null || ce === null || taxable === null || tax === null) { taxable = null; tax = null; break; }
        taxable += tx!;
        tax = add(tax, { igstMinor: ig!, cgstMinor: cg!, sgstMinor: sg!, cessMinor: ce! });
      }
      if (taxable === null || tax === null) problems.push(`${where}: a taxable value or tax amount (txval/igst/cgst/sgst/cess) is not an amount in rupees`);
      if (invoiceNo === null || invoiceDate === null || value === null || taxable === null || tax === null) continue;
      const lineId = lineIdOf(gstin, invoiceNo, invoiceDate);
      if (seen.has(lineId)) { problems.push(`${where}: invoice ${invoiceNo} of ${invoiceDate} appears twice for this supplier — one bill is one line`); continue; }
      seen.add(lineId);
      const itc = str(inv['itcavl']);
      lines.push({
        lineId, supplierGstin: gstin, supplierName: str(supplier['trdnm']), invoiceNo, invoiceDate,
        invoiceValueMinor: value, taxableMinor: taxable, ...tax,
        portalItcAvailable: itc === null ? null : itc.toUpperCase() === 'Y', reverseCharge: str(inv['rev'])?.toUpperCase() === 'Y',
      });
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, statement: { period: period!, recipientGstin: recipient!.toUpperCase(), lines } };
}

// ── the shop's own books ─────────────────────────────────────────────────────────────────────────────────────────────

/** A supplier invoice the shop booked, as the ITC match reads it. */
export interface BookedInvoice extends TaxComponents {
  readonly invoiceId: string;
  readonly supplierId: string;
  /** From the supplier master; null when the master holds no GSTIN for the supplier. */
  readonly supplierGstin: string | null;
  /** The supplier's own invoice number and date, as captured off the paper; null when the capture did not record them. */
  readonly supplierInvoiceNo: string | null;
  readonly supplierInvoiceDate: string | null;
  /** True once the invoice passed the three-way match clear (not blocked) — only those are compared with the 2B. */
  readonly threeWayMatched: boolean;
}

export type LineMatch = 'matched' | 'differs' | 'not_in_books' | 'in_an_earlier_2b';
export type LineDifference = 'date' | 'igst' | 'cgst' | 'sgst' | 'cess';
export type IncompleteReason = 'no_supplier_gstin' | 'no_supplier_invoice_number' | 'no_supplier_invoice_date';

export type ItcAction = 'accept' | 'reject' | 'pending';
export const ITC_ACTIONS: readonly ItcAction[] = ['accept', 'reject', 'pending'];

/** One person's action on one line (IMS) — append-only; the latest for a line stands. */
export interface ItcLineAction {
  readonly period: string;
  readonly lineId: string;
  readonly action: ItcAction;
  /** The signed-in person who took it — never a name typed in a body. */
  readonly by: string;
  readonly at: string;
  readonly reason: string | null;
}

export type ReversalRule = 'rule_37' | 'rule_42' | 'rule_43' | 'free_samples';
export const REVERSAL_RULES: readonly ReversalRule[] = ['rule_37', 'rule_42', 'rule_43', 'free_samples'];

/** A reversal of credit — its own compensating record for the month, never an edit of an accepted line. */
export interface ItcReversal extends TaxComponents {
  readonly reversalId: string;
  readonly period: string;
  readonly rule: ReversalRule;
  /** What it reverses — the invoice, the line or the A12 free-sample record. */
  readonly sourceRef: string;
  readonly reason: string;
  readonly by: string;
  readonly at: string;
}

export type LineState = 'accepted' | 'rejected' | 'pending' | 'awaiting_a_person';

export interface ReviewedLine extends Gstr2bLine {
  readonly match: LineMatch;
  readonly differences: readonly LineDifference[];
  /** The booked invoice it was compared with (same supplier GSTIN and number), when there is one. */
  readonly bookedInvoiceId: string | null;
  /** The earlier month whose 2B already carried this bill (match `in_an_earlier_2b`). */
  readonly earlierPeriod: string | null;
  readonly state: LineState;
  readonly actedBy: string | null;
  readonly actedAt: string | null;
  readonly reason: string | null;
}

export interface ItcReview {
  readonly period: string;
  /** False when no 2B has been uploaded for the month — everything below is then about the books only. */
  readonly imported: boolean;
  readonly lines: readonly ReviewedLine[];
  readonly exceptions: {
    /** Booked, three-way matched, dated in or before the month — and in no 2B uploaded up to this month. */
    readonly missingFrom2b: readonly BookedInvoice[];
    /** 2B lines with no booked invoice of that supplier and number. */
    readonly notInBooks: readonly string[];
    /** 2B lines whose booked invoice disagrees on the date or a tax component. */
    readonly differs: readonly string[];
    /** Booked invoices the match cannot compare: no supplier GSTIN, invoice number or date on record. */
    readonly incompleteBooked: readonly { readonly invoiceId: string; readonly supplierId: string; readonly why: readonly IncompleteReason[] }[];
    /** Captured but not (yet) through the three-way match clear — not compared until they are. */
    readonly notThreeWayMatched: readonly string[];
  };
  readonly totals: {
    readonly accepted: TaxComponents;
    readonly pending: TaxComponents;
    readonly rejected: TaxComponents;
    readonly awaiting: TaxComponents;
    readonly reversed: TaxComponents;
    readonly awaitingCount: number;
  };
  readonly reversals: readonly ItcReversal[];
  readonly claim: ItcClaim;
}

/** What GSTR-3B Table 4 may claim for the month — the port the GST returns read (Lane 1's `itcForPeriod`). */
export type ItcClaim =
  | ({ readonly status: 'reconciled' } & TaxComponents & { readonly reversed: TaxComponents; readonly acceptedLines: number })
  | { readonly status: 'not_reconciled'; readonly reason: string };

const monthEnd = (period: string): string => {
  const [y, m] = period.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
export const isPeriod = (p: unknown): p is string => typeof p === 'string' && PERIOD.test(p);

const bookKey = (gstin: string, invoiceNo: string): string => `${gstin}|${normaliseInvoiceNo(invoiceNo)}`;

/** Why a booked invoice cannot be compared with a 2B line — empty when it can. */
export function incompleteReasons(b: BookedInvoice): readonly IncompleteReason[] {
  const why: IncompleteReason[] = [];
  if (b.supplierGstin === null || !GSTIN_PATTERN.test(b.supplierGstin)) why.push('no_supplier_gstin');
  if (b.supplierInvoiceNo === null || b.supplierInvoiceNo.trim() === '') why.push('no_supplier_invoice_number');
  if (b.supplierInvoiceDate === null || !ISO_DATE.test(b.supplierInvoiceDate)) why.push('no_supplier_invoice_date');
  return why;
}

/** Compare one 2B line with the booked invoice of the same supplier GSTIN and number. */
export function compareLine(line: Gstr2bLine, booked: BookedInvoice | undefined): { readonly match: 'matched' | 'differs' | 'not_in_books'; readonly differences: readonly LineDifference[] } {
  if (booked === undefined) return { match: 'not_in_books', differences: [] };
  const differences: LineDifference[] = [];
  if (booked.supplierInvoiceDate !== line.invoiceDate) differences.push('date');
  for (const c of COMPONENTS) if (booked[c] !== line[c]) differences.push(c.replace('Minor', '') as LineDifference);
  return { match: differences.length === 0 ? 'matched' : 'differs', differences };
}

/** May this line be accepted? Only a line that matches a booked invoice exactly — the shop must hold the invoice. */
export function mayAccept(line: Pick<ReviewedLine, 'match'>): boolean {
  return line.match === 'matched';
}

/**
 * The month's review: every 2B line matched and with its person's action, every exception by name, the totals and the
 * claim. `statements` are every uploaded month (the latest upload per month); a booked invoice already carried by an
 * EARLIER month's 2B is not counted again (`in_an_earlier_2b`).
 */
export function reviewItc(input: {
  readonly period: string;
  readonly statements: readonly Gstr2bStatement[];
  readonly booked: readonly BookedInvoice[];
  readonly actions: readonly ItcLineAction[];
  readonly reversals: readonly ItcReversal[];
}): ItcReview {
  const { period } = input;
  const comparable = input.booked.filter((b) => b.threeWayMatched && incompleteReasons(b).length === 0);
  const byKey = new Map<string, BookedInvoice>();
  for (const b of comparable) byKey.set(bookKey(b.supplierGstin!, b.supplierInvoiceNo!), b);
  // Which earlier month's 2B first carried each bill (by supplier GSTIN + number).
  const firstSeen = new Map<string, string>();
  for (const s of [...input.statements].sort((a, b) => a.period.localeCompare(b.period))) {
    if (s.period > period) continue;
    for (const l of s.lines) { const k = bookKey(l.supplierGstin, l.invoiceNo); if (!firstSeen.has(k)) firstSeen.set(k, s.period); }
  }
  const latestAction = new Map<string, ItcLineAction>();
  for (const a of input.actions) if (a.period === period) latestAction.set(a.lineId, a);

  const statement = input.statements.find((s) => s.period === period);
  const lines: ReviewedLine[] = (statement?.lines ?? []).map((l) => {
    const k = bookKey(l.supplierGstin, l.invoiceNo);
    const earlier = firstSeen.get(k);
    const booked = byKey.get(k);
    const cmp = earlier !== undefined && earlier < period ? { match: 'in_an_earlier_2b' as const, differences: [] } : compareLine(l, booked);
    const act = latestAction.get(l.lineId);
    // An accept on a line that no longer matches (it cannot happen through the route, which refuses it) is not counted.
    const state: LineState = act === undefined ? 'awaiting_a_person'
      : act.action === 'accept' ? (mayAccept(cmp) ? 'accepted' : 'awaiting_a_person')
        : act.action === 'reject' ? 'rejected' : 'pending';
    return {
      ...l, match: cmp.match, differences: cmp.differences, bookedInvoiceId: booked?.invoiceId ?? null,
      earlierPeriod: cmp.match === 'in_an_earlier_2b' ? earlier! : null,
      state, actedBy: act?.by ?? null, actedAt: act?.at ?? null, reason: act?.reason ?? null,
    };
  });

  const end = monthEnd(period);
  const missingFrom2b = comparable.filter((b) => b.supplierInvoiceDate! <= end && !firstSeen.has(bookKey(b.supplierGstin!, b.supplierInvoiceNo!)))
    .sort((a, b) => a.supplierInvoiceDate!.localeCompare(b.supplierInvoiceDate!) || a.invoiceId.localeCompare(b.invoiceId));
  const sum = (state: LineState) => lines.filter((l) => l.state === state).reduce<TaxComponents>((t, l) => add(t, l), NO_TAX);
  const reversals = input.reversals.filter((r) => r.period === period);
  const reversed = reversals.reduce<TaxComponents>((t, r) => add(t, r), NO_TAX);
  const awaitingCount = lines.filter((l) => l.state === 'awaiting_a_person').length;
  const accepted = sum('accepted');
  const claim: ItcClaim = statement === undefined
    ? { status: 'not_reconciled', reason: `no GSTR-2B has been uploaded for ${period}` }
    : awaitingCount > 0
      ? { status: 'not_reconciled', reason: `${awaitingCount} line(s) of the ${period} GSTR-2B are awaiting a person's accept, reject or pending` }
      : { status: 'reconciled', ...accepted, reversed, acceptedLines: lines.filter((l) => l.state === 'accepted').length };

  return {
    period,
    imported: statement !== undefined,
    lines,
    exceptions: {
      missingFrom2b,
      notInBooks: lines.filter((l) => l.match === 'not_in_books').map((l) => l.lineId),
      differs: lines.filter((l) => l.match === 'differs').map((l) => l.lineId),
      incompleteBooked: input.booked.filter((b) => b.threeWayMatched && incompleteReasons(b).length > 0)
        .map((b) => ({ invoiceId: b.invoiceId, supplierId: b.supplierId, why: incompleteReasons(b) })),
      notThreeWayMatched: input.booked.filter((b) => !b.threeWayMatched).map((b) => b.invoiceId).sort(),
    },
    totals: { accepted, pending: sum('pending'), rejected: sum('rejected'), awaiting: sum('awaiting_a_person'), reversed, awaitingCount },
    reversals,
    claim,
  };
}

/** The claim for a month as Lane 1's GSTR-3B port expects it: reconciled with the accepted components, or not and why. */
export type ItcForPeriod = (tenantId: string, period: string) => Promise<
  | { readonly status: 'reconciled'; readonly igstMinor: number; readonly cgstMinor: number; readonly sgstMinor: number; readonly cessMinor: number }
  | { readonly status: 'not_reconciled'; readonly reason: string }
>;

/**
 * Build the `itcForPeriod(tenantId, period)` port over whatever loads a month's review. A period that is not YYYY-MM is
 * "not reconciled" with the reason, never a zero claim (P-08).
 */
export function makeItcForPeriod(load: (tenantId: string, period: string) => Promise<ItcReview>): ItcForPeriod {
  return async (tenantId, period) => {
    if (!isPeriod(period)) return { status: 'not_reconciled', reason: `${String(period)} is not a month (YYYY-MM)` };
    const claim = (await load(tenantId, period)).claim;
    if (claim.status !== 'reconciled') return claim;
    return { status: 'reconciled', igstMinor: claim.igstMinor, cgstMinor: claim.cgstMinor, sgstMinor: claim.sgstMinor, cessMinor: claim.cessMinor };
  };
}

/** A reversal as typed: a rule, a source, a reason and whole, non-negative amounts with at least one above zero. */
export function readReversalAmounts(v: Record<string, unknown>): TaxComponents | null {
  const out: Record<string, number> = {};
  for (const c of COMPONENTS) {
    const x = v[c] ?? 0;
    if (!Number.isSafeInteger(x) || (x as number) < 0) return null;
    out[c] = x as number;
  }
  const t = out as unknown as TaxComponents;
  return taxTotal(t) > 0 ? t : null;
}
