// Lane-local receipt lookup (M13-FR-01, §31) — **what makes an offline refund possible.**
//
// A refund against a receipt needs the original bill: which products, how many of each, what was
// paid, and how much has already come back. Offline, the only place that answer exists is THIS lane's
// own durable logs — the sale log it wrote when it rang the bill, and the returns log it wrote for
// any refund since. This turns those two logs into exactly the read model the refund screen consumes
// (`OriginalSale` + the return/refund history the register folds), for a bill THIS lane rang.
//
// Scope, stated honestly: a bill rung on ANOTHER lane, or before this box was installed, is not in
// these logs and is not found here — that is a cloud-backed online lookup, a later step. This is the
// offline-first half (M13-FR-01: "receipted return works offline where the original is locally
// known"), and it never reaches the network.
//
// Pure and deterministic: it is given the log records as strings (exactly what `readLog` yields) and
// returns a lookup. No clock, no I/O, no filesystem — the same shape as `return-register.ts` and
// `cloud-sale.ts`, so it is tested without a disk.

import type { OriginalSale, RecordedReturn } from '../../../packages/returns/src/return-register';

/** A recorded refund's value against a bill, for the money cap (M13-FR-03). */
export interface RecordedRefund {
  readonly returnId: string;
  readonly originalSaleId: string | null;
  readonly refundMinor: number;
}

/** Everything the refund screen needs about one bill this lane rang. */
export interface SaleLookupResult {
  readonly sale: OriginalSale;
  readonly returns: readonly RecordedReturn[];
  readonly refunds: readonly RecordedRefund[];
}

type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec => (v !== null && typeof v === 'object' ? v as Rec : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * A sale disk record → the `OriginalSale` the return register understands.
 *
 * The record is untrusted JSON off the disk (a record from an older build, a truncated line), so
 * every field is read defensively and a sale that cannot yield an id + a line is skipped rather than
 * turned into a half-built bill the screen would show wrongly. A sale line's quantity is
 * `quantityMinor` (the shape the session writes); `qty` is tolerated for the older/simpler shape.
 */
export function toOriginalSale(record: unknown): OriginalSale | undefined {
  const r = asRec(record);
  const saleId = str(r['id']) ?? str(r['saleId']);
  if (saleId === undefined) return undefined;

  const rawLines = Array.isArray(r['lines']) ? r['lines'] as unknown[] : [];
  const lines = rawLines.flatMap((l) => {
    const line = asRec(l);
    const productId = str(line['productId']);
    const quantityMinor = int(line['quantityMinor']) ?? int(line['qty']);
    return productId !== undefined && quantityMinor !== undefined
      ? [{ productId, uom: str(line['uom']) ?? 'ea', quantityMinor }]
      : [];
  });
  if (lines.length === 0) return undefined;

  const rawTenders = Array.isArray(r['tenders']) ? r['tenders'] as unknown[] : [];
  const tenders = rawTenders.flatMap((tRaw) => {
    const tRec = asRec(tRaw);
    const kind = str(tRec['kind']);
    const amountMinor = int(tRec['amountMinor']) ?? int(asRec(tRec['amount'])['minor']);
    return kind !== undefined && amountMinor !== undefined ? [{ kind, amountMinor }] : [];
  });

  return {
    saleId,
    number: str(r['number']) ?? saleId,
    tradingDay: str(r['tradingDay']) ?? '',
    committedAt: str(r['committedAt']) ?? str(r['occurredAt']) ?? '',
    totalMinor: int(r['total']) ?? int(r['totalMinor']) ?? 0,
    lines,
    ...(tenders.length === 0 ? {} : { tenders }),
  };
}

/**
 * A returns disk record → the `RecordedReturn` (for the at-most-once register) and its refund value
 * (for the money cap). A return with no id or no original bill contributes nothing to a bill's
 * lookup — a no-receipt return is against no bill by definition (M13-FR-01).
 */
export function toRecordedReturn(record: unknown): { readonly ret: RecordedReturn; readonly refund: RecordedRefund } | undefined {
  const r = asRec(record);
  const returnId = str(r['returnId']) ?? str(r['id']);
  if (returnId === undefined) return undefined;
  const originalSaleId = str(r['originalSaleId']) ?? null;

  const rawLines = Array.isArray(r['lines']) ? r['lines'] as unknown[] : [];
  const lines = rawLines.flatMap((l) => {
    const line = asRec(l);
    const productId = str(line['productId']);
    const quantityMinor = int(line['quantityMinor']) ?? int(line['qty']);
    return productId !== undefined && quantityMinor !== undefined
      ? [{ productId, uom: str(line['uom']) ?? 'ea', quantityMinor: Math.abs(quantityMinor) }]
      : [];
  });

  return {
    ret: { returnId, originalSaleId, processedAt: str(r['processedAt']) ?? '', lines },
    refund: { returnId, originalSaleId, refundMinor: Math.abs(int(r['refundMinor']) ?? 0) },
  };
}

/**
 * Build a receipt lookup over this lane's durable logs.
 *
 * Sales are indexed by BOTH their receipt number and their sale id, because a cashier at the desk
 * has whichever the customer's slip shows — usually the printed receipt number, sometimes the id a
 * reprint carries. Returns and refunds are grouped by the bill they came off, and the SAME return id
 * counts once however many times it appears (a re-queued or re-read record must not inflate what has
 * already come back — the same rule the register keeps). A later duplicate sale id/number keeps the
 * FIRST record seen, so a malformed re-append cannot shadow the real bill.
 */
export function buildReceiptLookup(
  saleRecords: readonly string[],
  returnRecords: readonly string[],
): (receiptOrId: string) => SaleLookupResult | undefined {
  const sales = new Map<string, OriginalSale>();   // key (number or id) -> sale
  for (const raw of saleRecords) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { continue; }
    const sale = toOriginalSale(parsed);
    if (sale === undefined) continue;
    for (const key of new Set([sale.saleId, sale.number])) {
      if (!sales.has(key)) sales.set(key, sale);
    }
  }

  const returnsBySale = new Map<string, RecordedReturn[]>();
  const refundsBySale = new Map<string, RecordedRefund[]>();
  const seen = new Set<string>();
  for (const raw of returnRecords) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { continue; }
    const mapped = toRecordedReturn(parsed);
    if (mapped === undefined || mapped.ret.originalSaleId === null) continue;
    if (seen.has(mapped.ret.returnId)) continue;
    seen.add(mapped.ret.returnId);
    const saleId = mapped.ret.originalSaleId;
    (returnsBySale.get(saleId) ?? returnsBySale.set(saleId, []).get(saleId)!).push(mapped.ret);
    (refundsBySale.get(saleId) ?? refundsBySale.set(saleId, []).get(saleId)!).push(mapped.refund);
  }

  return (receiptOrId: string): SaleLookupResult | undefined => {
    const sale = sales.get(receiptOrId);
    if (sale === undefined) return undefined;
    return {
      sale,
      returns: returnsBySale.get(sale.saleId) ?? [],
      refunds: refundsBySale.get(sale.saleId) ?? [],
    };
  };
}
