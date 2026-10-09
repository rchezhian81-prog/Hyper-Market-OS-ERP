// API-03 Purchase — suppliers, POs, GRNs, invoices, three-way match.
//
// The single most valuable control on this surface is not about purchasing at all: **a change to a
// supplier's bank details is verified out of band, against a number the supplier gave us before
// the request arrived** (M06, `packages/bank-controls`). Invoice fraud in retail is almost never
// clever — it is an email from a real supplier's real address saying the account has changed, and
// the money leaves on the next payment run. A system that accepts the change because the email
// looked right has no control at all.
//
// The second is the **three-way match**: a PO, a receipt and an invoice must agree before anything
// is paid, and where they do not, what is paid is the *lowest* of the three until a person settles
// it. Paying the invoice and investigating later is how an overcharge becomes permanent.

import type { Route } from '../../kernel/src/index';
import { deciderSealFlags } from '../../pos/src/store-seal';
import { apiError, requireActorIsCaller } from '../../kernel/src/index';
import { namedSecondPersonRefusal, openApproval, actionDetails, approvalNamedIn, type ApprovalPort, NO_APPROVALS } from '../../identity/src/approval-requests';
import { threeWayMatch, type MatchLine, type MatchResult } from '../../../packages/purchasing/src/three-way-match';
import {
  matchInvoice, InvalidMatchApprovalError,
  type OrderedLine, type ReceivedLine, type InvoicedLine, type LandedCharges, type MatchPolicy, type MatchApproval,
} from '../../../packages/receiving/src/three-way-match';
import { isCurrencyCode, type Money, type CurrencyCode } from '../../../packages/contracts/src/money';
import type { AuditEntry } from '../../../packages/audit/src/index';
import type { StoredPurchaseOrder } from './purchase-orders';

// The rule itself lives in `packages/purchasing` so the buyer's screen can use the SAME one — a
// browser cannot import this file, which imports the HTTP kernel. Re-exported so every existing
// caller of the service keeps working and there is still exactly one implementation.
export * from '../../../packages/purchasing/src/three-way-match';

// --- readers for the richer three-way match (invoice ↔ PO ↔ receipt + landed cost) ------------------
// This one is stateless: the AP clerk supplies the three source documents, so the figures are validated
// off the wire before they reach the engine. One reporting currency throughout — a Money quoted in
// another currency is refused rather than summed into a mixed-currency total (P-08).
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isNonNegInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const moneyIn = (v: unknown, currency: CurrencyCode): Money | undefined =>
  isObj(v) && Number.isInteger(v['minor']) && v['currency'] === currency ? { minor: v['minor'] as number, currency } : undefined;

function readOrdered(v: unknown, currency: CurrencyCode): OrderedLine | undefined {
  if (!isObj(v) || !isStr(v['lineId']) || !isStr(v['productId']) || !isNonNegInt(v['quantityMinor'])) return undefined;
  const unitCost = moneyIn(v['unitCost'], currency);
  if (unitCost === undefined) return undefined;
  return { lineId: v['lineId'] as string, productId: v['productId'] as string, quantityMinor: v['quantityMinor'] as number, unitCost };
}
function readReceived(v: unknown): ReceivedLine | undefined {
  if (!isObj(v) || !isStr(v['lineId']) || !isStr(v['productId']) || !isNonNegInt(v['quantityMinor'])) return undefined;
  return { lineId: v['lineId'] as string, productId: v['productId'] as string, quantityMinor: v['quantityMinor'] as number };
}
function readInvoiced(v: unknown, currency: CurrencyCode): InvoicedLine | undefined {
  if (!isObj(v) || !isStr(v['lineId']) || !isStr(v['productId']) || !isNonNegInt(v['quantityMinor'])) return undefined;
  const unitCost = moneyIn(v['unitCost'], currency);
  if (unitCost === undefined) return undefined;
  if (v['taxMinor'] !== undefined && !isNonNegInt(v['taxMinor'])) return undefined;
  return {
    lineId: v['lineId'] as string, productId: v['productId'] as string, quantityMinor: v['quantityMinor'] as number, unitCost,
    ...(isNonNegInt(v['taxMinor']) ? { taxMinor: v['taxMinor'] } : {}),
  };
}
function readPolicy(v: unknown): MatchPolicy | undefined {
  if (!isObj(v) || !isNonNegInt(v['priceToleranceBp']) || !isNonNegInt(v['quantityToleranceBp']) || !isNonNegInt(v['immaterialMinor'])) return undefined;
  return { priceToleranceBp: v['priceToleranceBp'] as number, quantityToleranceBp: v['quantityToleranceBp'] as number, immaterialMinor: v['immaterialMinor'] as number };
}
function readCharges(v: unknown, currency: CurrencyCode): LandedCharges | undefined | 'invalid' {
  if (v === undefined) return undefined;
  if (!isObj(v)) return 'invalid';
  const out: { freight?: Money; duty?: Money; other?: Money } = {};
  for (const k of ['freight', 'duty', 'other'] as const) {
    if (v[k] !== undefined) {
      const mv = moneyIn(v[k], currency);
      if (mv === undefined) return 'invalid';
      out[k] = mv;
    }
  }
  return out;
}
function readApproval(v: unknown): MatchApproval | undefined | 'invalid' {
  if (v === undefined) return undefined;
  if (!isObj(v) || !isStr(v['subjectRef']) || !isStr(v['decidedBy'])
    || !(v['status'] === 'approved' || v['status'] === 'rejected' || v['status'] === 'pending')) return 'invalid';
  return { subjectRef: v['subjectRef'] as string, status: v['status'] as MatchApproval['status'], decidedBy: v['decidedBy'] as string };
}

/** Read the whole three-way match off the wire. Returns undefined for any unreadable field. */
function readMatchInput(body: unknown, invoiceId: string): Parameters<typeof matchInvoice>[0] | undefined {
  if (!isObj(body)) return undefined;
  const cur = body['currency'];
  if (typeof cur !== 'string' || !isCurrencyCode(cur) || !isStr(body['receivedBy'])) return undefined;
  if (!Array.isArray(body['ordered']) || !Array.isArray(body['received']) || !Array.isArray(body['invoiced']) || body['invoiced'].length === 0) return undefined;
  const ordered = body['ordered'].map((x) => readOrdered(x, cur));
  const received = body['received'].map(readReceived);
  const invoiced = body['invoiced'].map((x) => readInvoiced(x, cur));
  if (ordered.some((x) => x === undefined) || received.some((x) => x === undefined) || invoiced.some((x) => x === undefined)) return undefined;
  const policy = readPolicy(body['policy']);
  if (policy === undefined) return undefined;
  const charges = readCharges(body['charges'], cur);
  if (charges === 'invalid') return undefined;
  const approval = readApproval(body['approval']);
  if (approval === 'invalid') return undefined;
  return {
    invoiceId,
    ordered: ordered as OrderedLine[], received: received as ReceivedLine[], invoiced: invoiced as InvoicedLine[],
    policy, currency: cur, receivedBy: body['receivedBy'] as string,
    ...(charges !== undefined ? { charges } : {}),
    ...(approval !== undefined ? { approval } : {}),
  };
}

export interface BankChangeRequest {
  readonly supplierId: string;
  readonly newAccount: string;
  readonly requestedVia: 'email' | 'letter' | 'portal' | 'phone_call_we_made';
  /** Confirmed on a number we already held, not one supplied with the request. */
  readonly calledBackOn?: string;
  readonly numberWeAlreadyHeld?: string;
  readonly approvedBy?: string;
  readonly requestedBy: string;
  /**
   * When the request arrived. Required, and it is evidence rather than bookkeeping.
   *
   * "When did this come in?" is the first question at an investigation into a payment that went
   * to the wrong place, and it is also what keeps the record straight when a supplier moves to a
   * new account and later moves back: without a date, the return to the first account looks
   * identical to the original change and collapses into it — leaving the ledger asserting the
   * money still goes to the middle account.
   */
  readonly requestedAt: string;
}

export type BankChangeRefusal =
  | 'no_request_date'
  | 'not_called_back'
  | 'called_back_on_the_number_they_supplied'
  | 'not_approved'
  | 'approved_by_the_requester';

export interface BankChangeResult {
  readonly ok: boolean;
  readonly refusedBecause?: BankChangeRefusal;
  readonly detail: string;
}

/**
 * Verify a supplier bank-detail change.
 *
 * The refusal that matters is the second one. Ringing the number printed on the letter that asks
 * for the change reaches whoever sent the letter — it feels like verification and confirms
 * nothing. The call must go to a number we already held.
 */
export function verifyBankChange(r: BankChangeRequest): BankChangeResult {
  if (typeof r.requestedAt !== 'string' || Number.isNaN(Date.parse(r.requestedAt))) {
    return {
      ok: false, refusedBecause: 'no_request_date',
      detail: `${r.supplierId}'s account change carries no date it was requested on. An undated request cannot be placed against the call that verified it or the payment run that followed, which is the whole sequence an investigation reads`,
    };
  }
  if (r.calledBackOn === undefined) {
    return {
      ok: false, refusedBecause: 'not_called_back',
      detail: `${r.supplierId}'s account change arrived by ${r.requestedVia} and nobody rang them. Invoice fraud in retail is not clever — it is a real supplier's real address saying the account has changed, and the money leaves on the next payment run`,
    };
  }
  if (r.numberWeAlreadyHeld === undefined || r.calledBackOn !== r.numberWeAlreadyHeld) {
    return {
      ok: false, refusedBecause: 'called_back_on_the_number_they_supplied',
      detail: `the call went to ${r.calledBackOn}, which is not the number we already held. Ringing the number on the letter that asks for the change reaches whoever sent the letter — it feels like verification and confirms nothing`,
    };
  }
  if (r.approvedBy === undefined) {
    return { ok: false, refusedBecause: 'not_approved', detail: 'a bank-detail change needs a second person' };
  }
  if (r.approvedBy === r.requestedBy) {
    return { ok: false, refusedBecause: 'approved_by_the_requester', detail: `${r.requestedBy} approved their own bank change for ${r.supplierId}` };
  }
  return { ok: true, detail: `${r.supplierId} verified on ${r.numberWeAlreadyHeld}, approved by ${r.approvedBy}` };
}

// ── Supplier invoices (SP-7a · audit findings F02 · F04 · M07-FR-04 · §28) ────────────────────────────────────────
//
// Until SP-7a the invoice never existed as a record: the buyer's screen wrote nothing (F02) and `/capture` took a
// caller-typed snapshot of what was ordered and received beside what was invoiced (F04) — so the "three-way" match
// compared three figures one person typed in one go. Now the INVOICE is the record — its own lines as the paper says
// them, who captured it, who checked the capture — and the match joins it to the purchase order head office holds and
// to the receipts that were folded into that order (SP-6). Nothing about the order or the delivery is taken from a body.

/** One line as the supplier's paper says it. Nothing here is about the order or the delivery. */
export interface SupplierInvoiceLine {
  readonly productId: string;
  readonly quantity: number;
  readonly unitPriceMinor: number;
  readonly lineTotalMinor: number;
}

/** What head office could not verify about a captured invoice — said on the record, never silent (P-08). */
export const INVOICE_FLAGS = Object.freeze([
  'capturer_unknown', 'capturer_lacks_authority', 'approver_unknown', 'approver_lacks_authority', 'self_approved', 'no_approval',
  'no_purchase_order', 'order_unknown', 'order_not_issued', 'supplier_differs_from_order',
  // 2b-vi-c-3 (ADR-0023 amended): a bill relayed from a store whose capturer the store computer did not vouch for, or
  // which names a checker the store computer could not verify (a second person's check is their own act at head office).
  'decider_not_verified_at_store', 'decider_seal_does_not_match', 'approver_not_verified_at_store',
] as const);
export type InvoiceFlag = (typeof INVOICE_FLAGS)[number];

/** A supplier invoice as head office keeps it — the durable record the match, the payable and the statement read (SP-7). */
export interface SupplierInvoiceRecord {
  readonly invoiceId: string;
  readonly supplierId: string;
  readonly poId: string | null;
  readonly lines: readonly SupplierInvoiceLine[];
  /** What the buyer typed off the bottom of the paper — the lines must add up to it. */
  readonly declaredTotalMinor: number;
  readonly totalMinor: number;
  readonly currency: CurrencyCode;
  readonly capturedBy: string;
  readonly capturedAt: string;
  /** The second person who checked the capture (§28); null when nobody has yet — said as a flag. */
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
  /** The identity that relayed it (the store box) and the surface / store, when it came through the shared queue. */
  readonly relayedBy?: string;
  readonly source: string;
  readonly storeId?: string | null;
  readonly governanceFlags: readonly string[];
  /** A checker the store's screen NAMED but no second person verified (2b-vi-c-3) — kept as evidence, never as an approval. */
  readonly approvalClaimedBy?: string;
}

/** A recorded three-way match: the engine's verdict plus what it was computed FROM (never the body). */
export interface StoredMatch extends MatchResult {
  readonly invoiceId: string;
  readonly poId: string | null;
  readonly matchedBy: string;
  readonly matchedAt: string;
  readonly sources: {
    readonly invoice: { readonly capturedBy: string; readonly capturedAt: string; readonly totalMinor: number } | null;
    readonly order: { readonly status: string; readonly supplierId: string; readonly lineCount: number } | null;
    /** Where the received figures came from: the goods receipts folded into the order (SP-6) — never a typed number. */
    readonly received: 'goods_receipts_folded_into_the_order' | 'none';
    /** The tolerances applied (SP-7b): the tenant's own policy, or the engine's defaults — said as `defaulted`. */
    readonly policy?: MatchTolerancePolicy & { readonly defaulted: boolean };
    /** SP-7c — what earlier invoices against the same order had already claimed, per product, when this one was judged. */
    readonly invoicedBefore?: Readonly<Record<string, number>>;
  };
  readonly flags: readonly string[];
}

/**
 * The tenant's three-way-match tolerances (SP-7b · OC-13): how far a quantity or a price may differ before a person must
 * look, and the value below which a difference is nobody's time. The owner's call, applied by `/match` to every invoice
 * and recorded on every verdict — never a figure a caller sends with the match. Until the owner sets one the engine's
 * defaults apply and the verdict SAYS so (`sources.policy.defaulted`).
 */
export interface MatchTolerancePolicy {
  readonly quantityToleranceBps: number;
  readonly priceToleranceBps: number;
  readonly immaterialMinor: number;
}
export interface StoredMatchPolicy extends MatchTolerancePolicy {
  readonly setBy: string;
  readonly setAt: string;
}
/** The engine's own defaults (`threeWayMatch`): no quantity tolerance, 1% on price, ₹1 immaterial. */
export const DEFAULT_MATCH_POLICY: MatchTolerancePolicy = Object.freeze({ quantityToleranceBps: 0, priceToleranceBps: 100, immaterialMinor: 100 });

const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const isIso = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));

type LinesRead =
  | { readonly ok: true; readonly lines: readonly SupplierInvoiceLine[] }
  | { readonly ok: false; readonly code: 'not_readable' | 'line_does_not_multiply' | 'carries_caller_claims'; readonly detail: string };

/** The invoice's own lines off the wire — and a refusal, by name, of a body that carries the F04 shape (ordered / received figures). */
export function readInvoiceLines(v: unknown): LinesRead {
  if (!Array.isArray(v) || v.length === 0) return { ok: false, code: 'not_readable', detail: 'at least one invoice line is needed' };
  const lines: SupplierInvoiceLine[] = [];
  for (const [i, raw] of (v as unknown[]).entries()) {
    if (!isObj(raw)) return { ok: false, code: 'not_readable', detail: `line ${i + 1} is not readable` };
    if (raw['orderedQty'] !== undefined || raw['receivedQty'] !== undefined || raw['invoicedQty'] !== undefined || raw['orderedUnitMinor'] !== undefined) {
      return { ok: false, code: 'carries_caller_claims', detail: `line ${i + 1} names what was ordered or received` };
    }
    if (!isStr(raw['productId']) || !isPosInt(raw['quantity']) || !isNonNegInt(raw['unitPriceMinor']) || !isNonNegInt(raw['lineTotalMinor'])) {
      return { ok: false, code: 'not_readable', detail: `line ${i + 1} needs a productId, a whole positive quantity, and whole non-negative unitPriceMinor and lineTotalMinor` };
    }
    const product = raw['quantity'] * raw['unitPriceMinor'];
    if (product !== raw['lineTotalMinor']) {
      return { ok: false, code: 'line_does_not_multiply', detail: `line ${i + 1}: ${raw['quantity']} × ${raw['unitPriceMinor']} is ${product}, but the line says ${raw['lineTotalMinor']}` };
    }
    lines.push({ productId: raw['productId'], quantity: raw['quantity'], unitPriceMinor: raw['unitPriceMinor'], lineTotalMinor: raw['lineTotalMinor'] });
  }
  return { ok: true, lines };
}
const sumOf = (lines: readonly SupplierInvoiceLine[]): number => lines.reduce((s, l) => s + l.lineTotalMinor, 0);

const refuseLines = (read: Extract<LinesRead, { ok: false }>, relayed: boolean) => apiError(read.code === 'line_does_not_multiply' ? 422 : 400, {
  code: read.code === 'not_readable' ? 'not_readable_as_a_supplier_invoice' : read.code === 'carries_caller_claims' ? 'invoice_carries_caller_claims' : 'invoice_line_does_not_multiply',
  whatHappened: read.code === 'carries_caller_claims'
    ? `${read.detail}. An invoice is captured as the paper says it; what was ordered comes from the purchase order and what arrived from the goods receipts head office holds — never from the sender.`
    : `${read.detail}.`,
  wasItSaved: 'not_saved',
  nextSafeAction: read.code === 'carries_caller_claims'
    ? 'Send the invoice\'s own lines { productId, quantity, unitPriceMinor, lineTotalMinor } only. Nothing was saved.'
    : relayed ? 'Do not discard it at the store. Keep it in the queue and raise it — the paper invoice exists.' : 'Check the line against the paper invoice and send it again. Nothing was saved.',
});
const refuseTotal = (totalMinor: number, declared: number, relayed: boolean) => apiError(422, {
  code: 'does_not_add_up_to_the_invoice_total',
  whatHappened: `The lines add up to ${totalMinor} and the invoice says ${declared}. Either a line is wrong or a line is missing — and both mean paying something other than what was agreed.`,
  wasItSaved: 'not_saved',
  nextSafeAction: relayed ? 'Do not discard it at the store. Keep it in the queue and raise it.' : 'Check the lines against the paper and send it again. Nothing was saved.',
});

const invoiceIdWithdrawn = (invoiceId: string) => apiError(409, {
  code: 'invoice_id_withdrawn',
  whatHappened: `Invoice ${invoiceId} was captured before and then withdrawn (an import was undone). Its record is kept as evidence, so the id is not used again.`,
  wasItSaved: 'not_saved',
  nextSafeAction: 'Check the paper. If it is the same bill, ask why it was withdrawn; if it is a new bill, it has its own number.',
});

/** The order behind an invoice, from head office's register — never the body; what it could not confirm is SAID. */
export async function orderForInvoice(
  deps: Pick<PurchaseDeps, 'purchaseOrder'>, tenantId: string, poId: string | null, supplierId: string, flags: InvoiceFlag[],
): Promise<StoredPurchaseOrder | undefined> {
  if (poId === null) { flags.push('no_purchase_order'); return undefined; }
  const po = await deps.purchaseOrder(tenantId, poId);
  if (po === undefined) { flags.push('order_unknown'); return undefined; }
  if (po.status !== 'issued') flags.push('order_not_issued');
  if (po.supplierId !== supplierId) flags.push('supplier_differs_from_order');
  return po;
}

/**
 * The three documents as the ONE shared engine compares them (`threeWayMatch` — the same rule the buyer's screen runs):
 * what the ORDER says was ordered (quantity and agreed price per product), what the receipts folded into that order say
 * was RECEIVED (SP-6), and what the INVOICE says — a product missing from a side contributes zero rather than being
 * skipped, so an invoiced line nobody ordered shows as exactly that. An order not yet issued counts as nothing ordered:
 * nobody committed to it, so an invoice against it cannot agree with it. Pure.
 */
export function matchLinesFrom(
  order: StoredPurchaseOrder | undefined, invoice: SupplierInvoiceRecord,
  /** SP-7c — what EARLIER invoices against the same order already claimed, per product: the order and the receipts left for
   *  THIS invoice are what remains after them, so a second bill for the same goods pays nothing twice (invoiced-to-date). */
  invoicedBefore: Readonly<Record<string, number>> = {},
): MatchLine[] {
  const usable = order !== undefined && order.status === 'issued' ? order : undefined;
  const ordered = new Map<string, { qty: number; unitMinor: number }>();
  for (const l of usable?.lines ?? []) {
    const cur = ordered.get(l.productId);
    ordered.set(l.productId, { qty: (cur?.qty ?? 0) + l.orderedQty, unitMinor: cur?.unitMinor ?? l.unitCost.minor });
  }
  for (const [productId, prior] of Object.entries(invoicedBefore)) {
    const cur = ordered.get(productId);
    if (cur !== undefined) ordered.set(productId, { ...cur, qty: Math.max(0, cur.qty - prior) });
  }
  const receivedRaw = usable?.receivedByProduct ?? {};
  const received: Record<string, number> = {};
  for (const [productId, qty] of Object.entries(receivedRaw)) received[productId] = Math.max(0, qty - (invoicedBefore[productId] ?? 0));
  const invoiced = new Map<string, { qty: number; unitMinor: number }>();
  for (const l of invoice.lines) {
    const cur = invoiced.get(l.productId);
    invoiced.set(l.productId, { qty: (cur?.qty ?? 0) + l.quantity, unitMinor: cur?.unitMinor ?? l.unitPriceMinor });
  }
  return [...new Set([...ordered.keys(), ...Object.keys(received), ...invoiced.keys()])].sort().map((productId) => ({
    productId,
    orderedQty: ordered.get(productId)?.qty ?? 0,
    receivedQty: received[productId] ?? 0,
    invoicedQty: invoiced.get(productId)?.qty ?? 0,
    orderedUnitMinor: ordered.get(productId)?.unitMinor ?? 0,
    invoicedUnitMinor: invoiced.get(productId)?.unitMinor ?? 0,
  }));
}

/**
 * SP-7c — the quantities EARLIER invoices against the same order already claimed, per product. Earlier = captured before this
 * one (ties broken by invoice id), so re-matching the first invoice never sees the second, and the second is judged against
 * what the first left. Pure.
 */
export function invoicedBeforeOn(poId: string, invoice: SupplierInvoiceRecord, all: readonly SupplierInvoiceRecord[]): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const other of all) {
    if (other.poId !== poId || other.invoiceId === invoice.invoiceId) continue;
    const earlier = other.capturedAt < invoice.capturedAt || (other.capturedAt === invoice.capturedAt && other.invoiceId < invoice.invoiceId);
    if (!earlier) continue;
    for (const l of other.lines) out[l.productId] = (out[l.productId] ?? 0) + l.quantity;
  }
  return out;
}


export interface PurchaseDeps {
  /** The invoice with this id, or undefined — the never-double-count check and the match's source. */
  readonly invoice: (tenantId: string, invoiceId: string) => Promise<SupplierInvoiceRecord | undefined> | SupplierInvoiceRecord | undefined;
  /** Every captured invoice — the review surface and, in SP-7b, the supplier's account. */
  readonly invoices: (tenantId: string) => Promise<readonly SupplierInvoiceRecord[]> | readonly SupplierInvoiceRecord[];
  /** SF-06-a: true when this invoice id was EVER captured, withdrawn ones included — a withdrawn id is never reused. */
  readonly invoiceIdUsed?: (tenantId: string, invoiceId: string) => Promise<boolean> | boolean;
  /** Record a captured invoice — idempotent on the invoice id, so a retry never doubles what a supplier is owed. */
  readonly recordInvoice: (tenantId: string, record: SupplierInvoiceRecord) => Promise<void> | void;
  /** The purchase order head office holds — what was ordered, at what price, and what was received against it (SP-6). */
  readonly purchaseOrder: (tenantId: string, poId: string) => Promise<StoredPurchaseOrder | undefined> | StoredPurchaseOrder | undefined;
  /** The permissions a named user holds through their grants; `undefined` for a name head office does not know. */
  readonly permissionsOfUser: (tenantId: string, userId: string) => Promise<readonly string[] | undefined> | readonly string[] | undefined;
  /** The latest recorded match for an invoice, or undefined when it was never matched. */
  readonly latestMatch: (tenantId: string, invoiceId: string) => Promise<StoredMatch | undefined> | StoredMatch | undefined;
  readonly recordMatch: (tenantId: string, invoiceId: string, r: StoredMatch) => Promise<void> | void;
  /** SP-7b: the tenant's match tolerances as SET, or `undefined` when the owner has set none (the engine's defaults apply, said). */
  readonly matchPolicy: (tenantId: string) => Promise<StoredMatchPolicy | undefined> | StoredMatchPolicy | undefined;
  readonly recordMatchPolicy: (tenantId: string, policy: StoredMatchPolicy) => Promise<void> | void;
  readonly applyBankChange: (tenantId: string, r: BankChangeRequest) => Promise<void> | void;
  /** Head office's maker-checker engine (ADR-0024): the bank change's second person approves in their own session.
   *  Optional on a bare stub (then every approval is unknown); the running system provides it. */
  readonly approvals?: ApprovalPort;
  /** SP-7c (M06-FR-01 · §28): who CREATED the supplier's master record, or undefined — they may never approve its bank details. */
  readonly supplierCreatedBy?: (tenantId: string, supplierId: string) => Promise<string | undefined> | string | undefined;
  /**
   * What is on order and not yet received.
   *
   * **`undefined` means not known, and that is not the same answer as zero.** A projection over an empty stream would
   * return `{count: 0, valueMinor: 0}` — which an owner reads as "we have nothing on order" and uses to decide what to
   * buy. Not-known is returned as not-known, the same way loyalty points are.
   */
  readonly openCommitments: (tenantId: string) => Promise<Commitments | undefined> | Commitments | undefined;
  /** The store computer's seal key (ADR-0023, amended 2b-vi-c-3): a relayed decision's decider is checked against the
   *  box's seal. Absent on a bare stub — then nothing is checked and nothing is claimed. */
  readonly tillSealKey?: Buffer;
  readonly now: () => string;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

export interface Commitments {
  readonly count: number;
  readonly valueMinor: number;
}

export function purchaseRoutes(deps: PurchaseDeps): readonly Route[] {
  return [
    {
      // Capture a supplier invoice AS THE PAPER SAYS IT (SP-7a · F04): { supplierId, poId?, declaredTotalMinor, lines[], approvedBy? }.
      // Nothing in the body may say what was ordered or received — those come from head office's own order and receipts
      // at match time. The capturer is the authenticated user; a second person's check is recorded when named (never the
      // capturer, §28) and its absence is SAID. Idempotent per invoice: the same invoice again is 200 `alreadyCaptured`.
      api: 'API-03', method: 'POST', path: '/v1/purchase/invoices/:invoiceId/capture',
      permission: 'purchase.invoice.capture', idempotent: true,
      handler: async (ctx) => {
        const invoiceId = (ctx.params['invoiceId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (b['ordered'] !== undefined || b['received'] !== undefined) throw refuseLines({ ok: false, code: 'carries_caller_claims', detail: 'the body names what was ordered or received' }, false);
        const read = readInvoiceLines(b['lines']);
        if (!read.ok) throw refuseLines(read, false);
        const poId = b['poId'];
        const approvedBy = b['approvedBy'];
        if (invoiceId === '' || !isStr(b['supplierId']) || !isNonNegInt(b['declaredTotalMinor'])
          || !(poId === undefined || poId === null || isStr(poId)) || !(approvedBy === undefined || approvedBy === null || isStr(approvedBy))) {
          throw apiError(400, {
            code: 'not_readable_as_a_supplier_invoice',
            whatHappened: 'A supplier invoice needs the invoiceId in the path and { supplierId, declaredTotalMinor, lines[] } in the body (poId and approvedBy optional).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the invoice as the paper says it. Nothing was saved.',
          });
        }
        const totalMinor = sumOf(read.lines);
        if (totalMinor !== b['declaredTotalMinor']) throw refuseTotal(totalMinor, b['declaredTotalMinor'], false);
        const existing = await deps.invoice(ctx.tenantId, invoiceId);
        if (existing !== undefined) return { status: 200, body: { invoice: existing, alreadyCaptured: true, flags: existing.governanceFlags } };
        if (await deps.invoiceIdUsed?.(ctx.tenantId, invoiceId)) throw invoiceIdWithdrawn(invoiceId);
        // The second person who checked the bill (ADR-0024 · §28 · 2b-vi-b-3): an approval someone holding
        // `purchase.invoice.match` GAVE in their own session for exactly this bill (kind `supplier_invoice_check`). A name
        // typed into `approvedBy` is refused by name — before, an unknown or unauthorised name was only flagged and the
        // bill recorded with it. With no approval the bill is captured and flagged `no_approval`, as before.
        const opened = await approvalNamedIn(deps.approvals, {
          tenantId: ctx.tenantId, approvalId: b['approvalId'], typedField: 'approvedBy', typedValue: approvedBy,
          kind: 'supplier_invoice_check', subjectRef: invoiceId, details: actionDetails(ctx.body, { invoiceId }), valueMinor: totalMinor,
          maker: ctx.userId, usedBy: `invoice-check:${invoiceId}`, now: deps.now(),
        });
        const checkedBy = opened?.decision.decidedBy;
        const flags: InvoiceFlag[] = [];
        if (checkedBy === undefined) flags.push('no_approval');
        await orderForInvoice(deps, ctx.tenantId, isStr(poId) ? poId : null, b['supplierId'], flags);
        const capturedAt = deps.now();
        const record: SupplierInvoiceRecord = {
          invoiceId, supplierId: b['supplierId'], poId: isStr(poId) ? poId : null, lines: read.lines, declaredTotalMinor: b['declaredTotalMinor'], totalMinor, currency: 'INR',
          capturedBy: ctx.userId, capturedAt, approvedBy: checkedBy ?? null, approvedAt: checkedBy === undefined ? null : opened!.decision.decidedAt,
          source: 'head-office', governanceFlags: flags,
        };
        await opened?.spend();
        await deps.recordInvoice(ctx.tenantId, record);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'invoice.capture', objectType: 'supplier_invoice', objectId: invoiceId,
          at: capturedAt, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: null,
          after: { supplierId: record.supplierId, poId: record.poId ?? '', lines: String(record.lines.length), totalMinor: String(totalMinor), approvedBy: record.approvedBy ?? '', flags: flags.join(',') },
          correlationId: invoiceId,
        });
        return { status: 201, body: { invoice: record, alreadyCaptured: false, flags } };
      },
    },
    {
      // A supplier invoice captured on the BUYER'S SCREEN and relayed by the store box (SP-7a · F02): the invoice's own
      // lines, who captured it and who checked it, as the screen queued them. Head office re-verifies BOTH from their
      // grants and records-and-flags (the paper exists; a breach is said, never silently trusted or silently dropped).
      // The arithmetic the screen ran is re-run here — a line that does not multiply or lines that do not add up are
      // 422, which the box dead-letters visibly. Idempotent per invoice.
      api: 'API-03', method: 'POST', path: '/v1/purchase/invoices/:invoiceId/synced',
      permission: 'purchase.invoice.sync', idempotent: true,
      handler: async (ctx) => {
        const invoiceId = (ctx.params['invoiceId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const read = readInvoiceLines(b['lines']);
        if (!read.ok) throw refuseLines(read, true);
        const poId = b['poId'];
        const approvedBy = b['approvedBy'];
        if (invoiceId === '' || b['invoiceId'] !== invoiceId || !isStr(b['supplierId']) || !isNonNegInt(b['declaredTotalMinor']) || !isStr(b['capturedBy']) || !isIso(b['capturedAt'])
          || !(poId === undefined || poId === null || isStr(poId)) || !(approvedBy === undefined || approvedBy === null || isStr(approvedBy))) {
          throw apiError(400, {
            code: 'not_readable_as_a_relayed_invoice',
            whatHappened: 'This payload could not be read as an invoice captured on a store screen — it needs the invoiceId matching the path, supplierId, declaredTotalMinor, lines[], capturedBy and capturedAt (poId, approvedBy, approvedAt, storeId optional).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Do not discard it at the store. Keep it in the queue and raise it — the paper invoice exists.',
          });
        }
        const totalMinor = sumOf(read.lines);
        if (totalMinor !== b['declaredTotalMinor']) throw refuseTotal(totalMinor, b['declaredTotalMinor'], true);
        const existing = await deps.invoice(ctx.tenantId, invoiceId);
        if (existing !== undefined) return { status: 200, body: { invoice: existing, alreadyCaptured: true, flags: existing.governanceFlags } };
        if (await deps.invoiceIdUsed?.(ctx.tenantId, invoiceId)) throw invoiceIdWithdrawn(invoiceId);
        const flags: InvoiceFlag[] = [];
        // The CAPTURER — re-verified from their grants, never the relay's word (hard rule #4).
        const capturerPermissions = await deps.permissionsOfUser(ctx.tenantId, b['capturedBy']);
        if (capturerPermissions === undefined) flags.push('capturer_unknown');
        else if (!capturerPermissions.includes('purchase.invoice.capture')) flags.push('capturer_lacks_authority');
        // Did the store computer see the CAPTURER capture this bill, exactly as it arrives? (2b-vi-c-3)
        flags.push(...deciderSealFlags(deps.tillSealKey, { tenantId: ctx.tenantId, kind: 'supplier_invoice', recordId: invoiceId, named: b['capturedBy'], record: ctx.body }));
        // The CHECKER — a second person (§28). A name the store's screen typed is not that person's act: no store computer
        // verified them, so it is kept as a claim and the bill is recorded unchecked (2b-vi-c-3 · audit PA-03, register
        // row 17b). The check is the checker's own act at head office — the match, under their own sign-in.
        flags.push('no_approval');
        if (isStr(approvedBy)) flags.push(approvedBy === b['capturedBy'] ? 'self_approved' : 'approver_not_verified_at_store');
        await orderForInvoice(deps, ctx.tenantId, isStr(poId) ? poId : null, b['supplierId'], flags);
        const record: SupplierInvoiceRecord = {
          invoiceId, supplierId: b['supplierId'], poId: isStr(poId) ? poId : null, lines: read.lines, declaredTotalMinor: b['declaredTotalMinor'], totalMinor, currency: 'INR',
          capturedBy: b['capturedBy'], capturedAt: b['capturedAt'],
          approvedBy: null, approvedAt: null,
          ...(isStr(approvedBy) ? { approvalClaimedBy: approvedBy } : {}),
          relayedBy: ctx.userId, source: isStr(b['source']) ? b['source'] : 'buyer-screen', storeId: isStr(b['storeId']) ? b['storeId'] : null,
          governanceFlags: flags,
        };
        await deps.recordInvoice(ctx.tenantId, record);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: record.capturedBy, action: 'invoice.capture', objectType: 'supplier_invoice', objectId: invoiceId,
          at: deps.now(), origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: null,
          after: { supplierId: record.supplierId, poId: record.poId ?? '', lines: String(record.lines.length), totalMinor: String(totalMinor), approvedBy: record.approvedBy ?? '', relayedBy: ctx.userId, storeId: record.storeId ?? '', flags: flags.join(',') },
          correlationId: invoiceId,
        });
        // 202, not 201: the invoice was captured at the store and this records that it happened.
        return { status: 202, body: { invoice: record, alreadyCaptured: false, flags } };
      },
    },
    {
      // The three-way match over what head office HOLDS (SP-7a · F04): the stored invoice, the stored purchase order and
      // the receipts folded into it (SP-6). Body: { poId? } — only to name the order when the invoice named none. A body
      // carrying lines or figures is refused by name. An invoice nobody captured is *not checked* (blocked, nothing to
      // compare) — which is a different answer from *checked and clean*. The verdict is recorded with its sources.
      api: 'API-03', method: 'POST', path: '/v1/purchase/invoices/:invoiceId/match',
      permission: 'purchase.invoice.match', idempotent: true,
      handler: async (ctx) => {
        const invoiceId = (ctx.params['invoiceId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (b['lines'] !== undefined || b['ordered'] !== undefined || b['received'] !== undefined || b['invoiced'] !== undefined) {
          throw refuseLines({ ok: false, code: 'carries_caller_claims', detail: 'the body carries figures to match' }, false);
        }
        if (!(b['poId'] === undefined || b['poId'] === null || isStr(b['poId']))) {
          throw apiError(400, { code: 'not_readable_as_a_match_request', whatHappened: 'A match takes only an optional poId.', wasItSaved: 'not_saved', nextSafeAction: 'Send {} or { poId }. Nothing was changed.' });
        }
        const invoice = await deps.invoice(ctx.tenantId, invoiceId);
        const matchedAt = deps.now();
        const flags: string[] = [];
        // SP-7b: the tolerances are the TENANT'S (the owner set them) or the engine's defaults — never the body's; which, is said.
        const set = await deps.matchPolicy(ctx.tenantId);
        const policy: MatchTolerancePolicy & { readonly defaulted: boolean } = set === undefined
          ? { ...DEFAULT_MATCH_POLICY, defaulted: true }
          : { quantityToleranceBps: set.quantityToleranceBps, priceToleranceBps: set.priceToleranceBps, immaterialMinor: set.immaterialMinor, defaulted: false };
        let poId: string | null = null;
        let order: StoredPurchaseOrder | undefined;
        let result: MatchResult;
        let invoicedBefore: Readonly<Record<string, number>> = {};
        if (invoice === undefined) {
          flags.push('invoice_unknown');
          result = threeWayMatch({ lines: [], ...policy });
        } else {
          poId = isStr(b['poId']) ? b['poId'] : invoice.poId;
          const orderFlags: InvoiceFlag[] = [];
          order = await orderForInvoice(deps, ctx.tenantId, poId, invoice.supplierId, orderFlags);
          flags.push(...orderFlags);
          // SP-7c: a second bill against the same order is judged against what the first left — and said when together they
          // claim more than was ordered (the lowest-of-three then withholds the excess by construction).
          invoicedBefore = poId === null ? {} : invoicedBeforeOn(poId, invoice, await deps.invoices(ctx.tenantId));
          if (order !== undefined && order.status === 'issued') {
            const orderedByProduct: Record<string, number> = {};
            for (const l of order.lines) orderedByProduct[l.productId] = (orderedByProduct[l.productId] ?? 0) + l.orderedQty;
            const claimed: Record<string, number> = { ...invoicedBefore };
            for (const l of invoice.lines) claimed[l.productId] = (claimed[l.productId] ?? 0) + l.quantity;
            if (Object.entries(claimed).some(([productId, qty]) => qty > (orderedByProduct[productId] ?? 0))) flags.push('order_over_invoiced');
          }
          result = threeWayMatch({ lines: matchLinesFrom(order, invoice, invoicedBefore), ...policy });
        }
        const stored: StoredMatch = {
          ...result, invoiceId, poId, matchedBy: ctx.userId, matchedAt,
          sources: {
            invoice: invoice === undefined ? null : { capturedBy: invoice.capturedBy, capturedAt: invoice.capturedAt, totalMinor: invoice.totalMinor },
            order: order === undefined ? null : { status: order.status, supplierId: order.supplierId, lineCount: order.lines.length },
            received: order !== undefined && order.status === 'issued' ? 'goods_receipts_folded_into_the_order' : 'none',
            policy,
            invoicedBefore,
          },
          flags,
        };
        await deps.recordMatch(ctx.tenantId, invoiceId, stored);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'invoice.match', objectType: 'supplier_invoice', objectId: invoiceId,
          at: matchedAt, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: null,
          after: { poId: poId ?? '', blocked: String(stored.blocked), payableMinor: String(stored.payableMinor), invoicedMinor: String(stored.invoicedMinor), withheldMinor: String(stored.withheldMinor), flags: flags.join(',') },
          correlationId: invoiceId,
        });
        return { status: 200, body: stored };
      },
    },
    {
      // Read one invoice as head office holds it, with its latest match (or null). 404 when the id is unknown.
      api: 'API-03', method: 'GET', path: '/v1/purchase/invoices/:invoiceId',
      permission: 'purchase.commitment.read',
      handler: async (ctx) => {
        const invoiceId = (ctx.params['invoiceId'] ?? '').trim();
        const invoice = await deps.invoice(ctx.tenantId, invoiceId);
        if (invoice === undefined) {
          throw apiError(404, { code: 'not_found', whatHappened: `No supplier invoice ${invoiceId} is on file here.`, wasItSaved: 'not_saved', nextSafeAction: 'Check the store has synchronised — the invoice may still be on the store computer.' });
        }
        return { status: 200, body: { invoice, match: (await deps.latestMatch(ctx.tenantId, invoiceId)) ?? null } };
      },
    },
    {
      // Every invoice head office holds, each with its latest match — the ones nobody has matched or that are blocked first
      // (control by exception, P-03).
      api: 'API-03', method: 'GET', path: '/v1/purchase/invoices',
      permission: 'purchase.commitment.read',
      handler: async (ctx) => {
        const all = await deps.invoices(ctx.tenantId);
        const rows = [];
        for (const invoice of all) rows.push({ invoice, match: (await deps.latestMatch(ctx.tenantId, invoice.invoiceId)) ?? null });
        const waiting = rows.filter((r) => r.match === null || r.match.blocked);
        return {
          status: 200,
          body: {
            invoices: [...waiting, ...rows.filter((r) => !waiting.includes(r))], count: rows.length,
            unmatchedCount: rows.filter((r) => r.match === null).length, blockedCount: rows.filter((r) => r.match !== null && r.match.blocked).length,
            asAt: deps.now(),
          },
        };
      },
    },
    {
      // SP-7b (OC-13): the tenant's match tolerances — the owner's call, applied by /match to every invoice, never a body's.
      // Body: { quantityToleranceBps, priceToleranceBps, immaterialMinor }. Latest applies; every version stays on the ledger.
      api: 'API-03', method: 'POST', path: '/v1/purchase/match-policy',
      permission: 'purchase.match.policy.set', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isNonNegInt(b['quantityToleranceBps']) || !isNonNegInt(b['priceToleranceBps']) || !isNonNegInt(b['immaterialMinor'])
          || b['quantityToleranceBps'] > 10_000 || b['priceToleranceBps'] > 10_000) {
          throw apiError(400, {
            code: 'not_readable_as_a_match_policy',
            whatHappened: 'A match policy needs whole, non-negative quantityToleranceBps and priceToleranceBps (at most 10000 — 100%) and a whole, non-negative immaterialMinor.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { quantityToleranceBps, priceToleranceBps, immaterialMinor }. Nothing was changed.',
          });
        }
        const policy: StoredMatchPolicy = {
          quantityToleranceBps: b['quantityToleranceBps'], priceToleranceBps: b['priceToleranceBps'], immaterialMinor: b['immaterialMinor'],
          setBy: ctx.userId, setAt: deps.now(),
        };
        await deps.recordMatchPolicy(ctx.tenantId, policy);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'match.policy.set', objectType: 'match_policy', objectId: ctx.tenantId,
          at: policy.setAt, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: null,
          after: { quantityToleranceBps: String(policy.quantityToleranceBps), priceToleranceBps: String(policy.priceToleranceBps), immaterialMinor: String(policy.immaterialMinor) },
          correlationId: `match-policy-${ctx.tenantId}`,
        });
        return { status: 201, body: { policy } };
      },
    },
    {
      api: 'API-03', method: 'GET', path: '/v1/purchase/match-policy',
      permission: 'purchase.commitment.read',
      handler: async (ctx) => {
        const policy = await deps.matchPolicy(ctx.tenantId);
        return { status: 200, body: { policy: policy ?? null, defaultPolicy: DEFAULT_MATCH_POLICY, inForce: policy ?? DEFAULT_MATCH_POLICY } };
      },
    },
    {
      // The full three-way match with LANDED COST (M07-FR-04, D03-FR-05, §28). Distinct from /match
      // above (which reconciles pre-captured lines to the lowest of three): this is the stateless
      // reconciliation the AP clerk drives with the three source documents — the purchase ORDER, the
      // goods RECEIPT and the supplier INVOICE — plus freight/duty. It VALUES and OWNS every variance
      // (₹ over-charged on which lines, not "it doesn't tie up"), apportions the charges across the
      // lines to the paisa so the stock's TRUE landed cost is known (valuation that ignores freight
      // overstates margin), and decides PAYABILITY: an out-of-tolerance variance blocks payment until
      // someone who did NOT receive the goods approves it (§28 — the receiver can never clear their own
      // receipt). It DECIDES only; it records nothing. Gated purchase.invoice.match.
      api: 'API-03', method: 'POST', path: '/v1/purchase/invoices/:invoiceId/reconcile',
      permission: 'purchase.invoice.match', idempotent: true,
      handler: async (ctx) => {
        const input = readMatchInput(ctx.body, ctx.params['invoiceId'] ?? '');
        if (input === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_three_way_match',
            whatHappened: 'A three-way match needs { ordered[], received[], invoiced[] } lines (each with a lineId, productId and whole quantities; ordered/invoiced also a unitCost {minor,currency}), a policy { priceToleranceBp, quantityToleranceBp, immaterialMinor }, a currency, who receivedBy, optional charges {freight,duty,other} and an optional approval — all money in the one currency.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Correct the figures and send again — this only reconciles and decides, it pays nothing and records nothing.',
          });
        }
        try {
          return { status: 200, body: matchInvoice(input) };
        } catch (e) {
          if (e instanceof InvalidMatchApprovalError) {
            throw apiError(422, {
              code: 'approval_authorises_a_different_invoice',
              whatHappened: e.message,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Send the approval that names THIS invoice, or none. Nothing was changed.',
            });
          }
          throw e;
        }
      },
    },
    {
      api: 'API-03', method: 'POST', path: '/v1/purchase/suppliers/:supplierId/bank-details',
      permission: 'purchase.supplier.bank', idempotent: true,
      handler: async (ctx) => {
        // Who asks is the signed-in caller (ADR-0024 · audit PA-03); the second person is an APPROVAL they gave in their
        // own session — never a name in this body. The details below are what the approval was asked for, exactly.
        const body = (ctx.body !== null && typeof ctx.body === 'object' ? ctx.body : {}) as Record<string, unknown>;
        requireActorIsCaller(ctx, body, 'requestedBy');
        const { approvedBy: named, approvalId, requestedBy: _maker, ...asked } = body;
        void _maker;
        const supplierId = ctx.params['supplierId'] ?? '';
        const details = { ...asked, supplierId };
        if (typeof approvalId !== 'string' || approvalId.trim() === '') {
          if (typeof named === 'string' && named.trim() !== '') throw namedSecondPersonRefusal('approvedBy', named);
        }
        const opened = typeof approvalId === 'string' && approvalId.trim() !== '' ? await openApproval(deps.approvals ?? NO_APPROVALS, {
          tenantId: ctx.tenantId, approvalId: approvalId.trim(), kind: 'supplier_bank_change', subjectRef: supplierId, details,
          valueMinor: null, maker: ctx.userId, usedBy: `bank-change-${supplierId}`, now: deps.now(),
        }) : undefined;
        const request = { ...(asked as Partial<BankChangeRequest>), supplierId, requestedBy: ctx.userId, ...(opened === undefined ? {} : { approvedBy: opened.decision.decidedBy }) } as BankChangeRequest;
        const check = verifyBankChange(request);
        if (!check.ok) {
          throw apiError(422, {
            code: check.refusedBecause!,
            whatHappened: check.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'The old account is unchanged and payments will still go there. Ring the supplier on a number you already had, then ask for approval (POST /v1/approvals/requests, kind supplier_bank_change) and send the approvalId once a second person has approved it.',
          });
        }
        // SP-7c (M06-FR-01 · §28): the person who CREATED the supplier can never approve its bank details — the two halves
        // of an invoice fraud are the same person setting up a supplier and pointing its money at an account.
        const creator = await deps.supplierCreatedBy?.(ctx.tenantId, request.supplierId);
        if (creator !== undefined && creator === request.approvedBy) {
          throw apiError(422, {
            code: 'supplier_creator_cannot_approve_bank',
            whatHappened: `${request.approvedBy} created supplier ${request.supplierId} and cannot also approve where its money goes (§28 separation of duties).`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Have a different person with the bank-approval authority approve the change. The old account is unchanged.',
          });
        }
        // Every rule passed: the approval is spent — once — and only then does the account change.
        await opened?.spend();
        await deps.applyBankChange(ctx.tenantId, request);
        return { status: 200, body: { changed: check.detail } };
      },
    },
    {
      api: 'API-03', method: 'GET', path: '/v1/purchase/commitments',
      permission: 'purchase.commitment.read',
      handler: async (ctx) => {
        const open = await deps.openCommitments(ctx.tenantId);
        return {
          status: 200,
          body: open === undefined
            ? {
              known: false, asAt: deps.now(),
              detail: 'what is on order cannot be stated yet, because purchase orders are not recorded in this system. A zero here would read as "we have nothing on order" and be acted on.',
            }
            : { ...open, known: true, asAt: deps.now() },
        };
      },
    },
  ];
}
