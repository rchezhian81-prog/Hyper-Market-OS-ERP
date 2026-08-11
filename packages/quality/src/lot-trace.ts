// One-up / one-down lot traceability export (roadmap v2.1 B11 / M10-FR-03). Food-safety law (FSSAI, and
// the global Codex "one step back, one step forward" principle) requires that, for any batch, a retailer
// can produce on demand: who it came FROM (one step back — the supplier and goods-receipt note) and who
// it went TO (one step forward — the sales, and the customers where they were identified). This is the
// document a recall runs on: pull the batch, and you have the two lists in one place.
//
// This assembles and RECONCILES that export from the inbound and outbound records of a single batch. The
// reconciliation is the safety check: you cannot have dispatched more of a batch than you received, so
// dispatched-exceeds-received is surfaced (`reconciled: false`) rather than hidden — a traceability gap
// is a food-safety failure, not a rounding note (P-08). A sale with no identified customer is NOT
// dropped: it still appears (its reference and date), counted as an anonymous recipient, because "we sold
// 40 units we cannot trace to a person" is exactly what a recall must know (M10-FR-03 alt/error path).
//
// Pure and deterministic — the records go in, the reconciled export comes out; no storage, no I/O. The
// records are sorted by date then reference so two runs of the same batch produce a byte-identical export.

export interface InboundLotRecord {
  readonly supplierId: string;
  readonly supplierName?: string;
  /** Goods-receipt-note reference the batch arrived on. */
  readonly grnId: string;
  /** Date received (YYYY-MM-DD). */
  readonly receivedDate: string;
  /** Quantity received, in minor units. */
  readonly quantityMinor: number;
}

export interface OutboundLotRecord {
  /** Sale / dispatch reference the batch left on. */
  readonly saleId: string;
  /** Date sold / dispatched (YYYY-MM-DD). */
  readonly soldDate: string;
  readonly quantityMinor: number;
  /** The identified customer, where a sale captured one. Omitted for an anonymous (walk-in) sale — the
   *  sale is still traced by its reference and date. */
  readonly customerId?: string;
}

export interface LotTraceExport {
  readonly batchId: string;
  readonly productId: string;
  /** One step back — supplier → store, sorted by receivedDate then grnId. */
  readonly inbound: readonly InboundLotRecord[];
  /** One step forward — store → recipient, sorted by soldDate then saleId. */
  readonly outbound: readonly OutboundLotRecord[];
  readonly totalReceivedMinor: number;
  readonly totalDispatchedMinor: number;
  /** received − dispatched — the quantity still to quarantine/pull. Negative signals an impossible
   *  over-dispatch (a traceability gap), which also sets `reconciled` false. */
  readonly remainingOnHandMinor: number;
  readonly identifiedRecipientCount: number;
  readonly anonymousSaleCount: number;
  /** True only when dispatched ≤ received — no more of the batch left than arrived. */
  readonly reconciled: boolean;
}

export class InvalidLotTrace extends Error {
  constructor(detail: string) {
    super(`Cannot build the lot trace: ${detail}`);
    this.name = 'InvalidLotTrace';
  }
}

const isDate = (s: unknown): s is string =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`));
const isNonNegInt = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0;
const isNonEmpty = (s: unknown): s is string => typeof s === 'string' && s.trim() !== '';

/**
 * Build the reconciled one-up/one-down trace export for a batch (B11 / M10-FR-03).
 *
 * @throws InvalidLotTrace if the batch/product id is empty, or any inbound record lacks a supplier / GRN
 *   / valid date / whole non-negative quantity, or any outbound record lacks a sale reference / valid
 *   date / whole non-negative quantity. Bad data is refused, never traced past.
 */
export function buildLotTrace(input: {
  readonly batchId: string;
  readonly productId: string;
  readonly inbound: readonly InboundLotRecord[];
  readonly outbound: readonly OutboundLotRecord[];
}): LotTraceExport {
  if (!isNonEmpty(input.batchId)) throw new InvalidLotTrace('the batch id is required');
  if (!isNonEmpty(input.productId)) throw new InvalidLotTrace('the product id is required');
  if (!Array.isArray(input.inbound) || !Array.isArray(input.outbound)) {
    throw new InvalidLotTrace('inbound and outbound must each be an array (empty is allowed)');
  }

  for (const r of input.inbound) {
    if (!isNonEmpty(r.supplierId)) throw new InvalidLotTrace('an inbound record has no supplier');
    if (!isNonEmpty(r.grnId)) throw new InvalidLotTrace('an inbound record has no goods-receipt-note reference');
    if (!isDate(r.receivedDate)) throw new InvalidLotTrace(`an inbound record has an invalid received date (${String(r.receivedDate)})`);
    if (!isNonNegInt(r.quantityMinor)) throw new InvalidLotTrace('an inbound record has a non-whole or negative quantity');
  }
  for (const r of input.outbound) {
    if (!isNonEmpty(r.saleId)) throw new InvalidLotTrace('an outbound record has no sale reference');
    if (!isDate(r.soldDate)) throw new InvalidLotTrace(`an outbound record has an invalid sold date (${String(r.soldDate)})`);
    if (!isNonNegInt(r.quantityMinor)) throw new InvalidLotTrace('an outbound record has a non-whole or negative quantity');
  }

  const inbound = [...input.inbound].sort((a, b) => a.receivedDate.localeCompare(b.receivedDate) || a.grnId.localeCompare(b.grnId));
  const outbound = [...input.outbound].sort((a, b) => a.soldDate.localeCompare(b.soldDate) || a.saleId.localeCompare(b.saleId));

  const totalReceivedMinor = inbound.reduce((s, r) => s + r.quantityMinor, 0);
  const totalDispatchedMinor = outbound.reduce((s, r) => s + r.quantityMinor, 0);
  const identifiedRecipientCount = outbound.filter((r) => isNonEmpty(r.customerId)).length;
  const anonymousSaleCount = outbound.length - identifiedRecipientCount;

  return {
    batchId: input.batchId,
    productId: input.productId,
    inbound,
    outbound,
    totalReceivedMinor,
    totalDispatchedMinor,
    remainingOnHandMinor: totalReceivedMinor - totalDispatchedMinor,
    identifiedRecipientCount,
    anonymousSaleCount,
    reconciled: totalDispatchedMinor <= totalReceivedMinor,
  };
}
