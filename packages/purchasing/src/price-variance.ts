// Purchase-price variance (D03-FR-05 "landed cost, freight and purchase-price variance"; FG-4, 26 Oct 2026).
//
// What it answers: for every product that arrived, did it cost what was agreed? Each goods-receipt line's COST AS RECEIVED
// is set against two agreed prices:
//
//   • the purchase order's price for that product (for a call-off release of a blanket agreement, the order's price IS the
//     agreement's — the line says so);
//   • the contract price: an APPROVED blanket agreement with the same supplier, valid on the day the goods arrived, that
//     names the product. Where none exists the line says "no contract price on file" — never a zero.
//
// The variance is valued on what was received and kept (sellable + held back + over-tolerance excess; refused goods go
// back and are not paid for): received value at the receipt's cost minus the same quantity at the agreed price. Positive
// means the shop paid MORE than agreed.
//
// A line that cannot be compared is never left out of the count (P-08): no order on the receipt, an order head office does
// not hold, the product not on the order, or a different currency — each is named and counted separately from the lines
// that agree.
//
// Two roll-ups — per product and per receipt — sum ONLY the compared lines, and every figure keeps the receipt lines behind
// it (the drill-through). Pure and deterministic.

import type { CurrencyCode } from '../../contracts/src/money';
import { valueAtCost, type CostBasis } from '../../contracts/src/quantity';

export interface PpvReceiptLine {
  readonly lineId: string;
  readonly productId: string;
  /** Received and kept, in the unit's smallest steps (sellable + quarantined + held excess; refused excluded). */
  readonly keptMinor: number;
  readonly uom: string;
  readonly unitCost: CostBasis & { readonly currency: CurrencyCode };
}

export interface PpvReceipt {
  readonly grnId: string;
  readonly number: string;
  readonly poId: string | null;
  readonly supplierId: string | null;
  /** The shop's trading day the goods arrived, YYYY-MM-DD. */
  readonly receivedOn: string;
  readonly locationId: string;
  readonly lines: readonly PpvReceiptLine[];
}

export interface PpvOrder {
  readonly poId: string;
  readonly number: string;
  readonly supplierId: string;
  readonly blanketAgreementId?: string;
  readonly lines: readonly { readonly productId: string; readonly unitCost: CostBasis & { readonly currency: CurrencyCode } }[];
}

export interface PpvAgreement {
  readonly agreementId: string;
  readonly supplierId: string;
  readonly currency: CurrencyCode;
  readonly validFrom: string;
  readonly validTo: string;
  readonly approved: boolean;
  readonly lines: readonly { readonly productId: string; readonly agreedUnitCost: CostBasis }[];
}

export type NotCompared = 'no_purchase_order' | 'order_not_held' | 'product_not_on_order' | 'currency_differs';

export interface PpvLine {
  readonly grnId: string;
  readonly receiptNumber: string;
  readonly lineId: string;
  readonly productId: string;
  readonly supplierId: string | null;
  readonly poId: string | null;
  readonly poNumber: string | null;
  readonly receivedOn: string;
  readonly keptMinor: number;
  readonly uom: string;
  readonly currency: CurrencyCode;
  /** The cost per unit as it was received (and per how many units, OB-46). */
  readonly receivedUnitCost: CostBasis;
  readonly receivedValueMinor: number;
  /** Against the order: absent when the line could not be compared (`notCompared` says why). */
  readonly order?: { readonly unitCost: CostBasis; readonly valueMinor: number; readonly varianceMinor: number; readonly varianceBps: number | null; readonly basis: 'purchase_order' | 'blanket_release' };
  readonly notCompared?: NotCompared;
  /** Against the contract price on the day: absent ⇒ no approved agreement with this supplier named the product then. */
  readonly contract?: { readonly agreementId: string; readonly unitCost: CostBasis; readonly valueMinor: number; readonly varianceMinor: number; readonly varianceBps: number | null };
}

export interface PpvRollup {
  readonly key: string;
  readonly lines: number;
  readonly comparedLines: number;
  readonly receivedValueMinor: number;
  readonly orderValueMinor: number;
  readonly varianceMinor: number;
  readonly varianceBps: number | null;
  readonly linesAboveOrder: number;
  readonly linesBelowOrder: number;
  /** Lines with a contract price on the day, and the variance against it. */
  readonly contractLines: number;
  readonly contractVarianceMinor: number;
}

export interface PriceVarianceReport {
  readonly lines: readonly PpvLine[];
  readonly byProduct: readonly PpvRollup[];
  readonly byReceipt: readonly PpvRollup[];
  readonly totals: Omit<PpvRollup, 'key'> & { readonly notCompared: Readonly<Record<NotCompared, number>> };
}

const bps = (variance: number, base: number): number | null => (base === 0 ? null : Math.round((variance * 10_000) / base));
const basisOf = (c: CostBasis): CostBasis => (c.per === undefined || c.per === 1 ? { minor: c.minor } : { minor: c.minor, per: c.per });

/** The approved agreement with this supplier, valid on the day, naming the product (lowest agreement id when several). */
function contractFor(agreements: readonly PpvAgreement[], supplierId: string | null, productId: string, on: string, currency: CurrencyCode) {
  if (supplierId === null) return undefined;
  return agreements
    .filter((a) => a.approved && a.supplierId === supplierId && a.currency === currency && a.validFrom <= on && on <= a.validTo)
    .sort((a, b) => a.agreementId.localeCompare(b.agreementId))
    .map((a) => ({ a, line: a.lines.find((l) => l.productId === productId) }))
    .find((x) => x.line !== undefined);
}

export function priceVariance(input: {
  readonly receipts: readonly PpvReceipt[];
  readonly orders: ReadonlyMap<string, PpvOrder>;
  readonly agreements: readonly PpvAgreement[];
}): PriceVarianceReport {
  const lines: PpvLine[] = [];
  for (const r of [...input.receipts].sort((a, b) => a.receivedOn.localeCompare(b.receivedOn) || a.grnId.localeCompare(b.grnId))) {
    const order = r.poId === null ? undefined : input.orders.get(r.poId);
    const supplierId = order?.supplierId ?? r.supplierId;
    for (const l of r.lines) {
      const currency = l.unitCost.currency;
      const receivedValueMinor = valueAtCost(l.keptMinor, l.uom, l.unitCost);
      const base = {
        grnId: r.grnId, receiptNumber: r.number, lineId: l.lineId, productId: l.productId, supplierId, poId: r.poId, poNumber: order?.number ?? null,
        receivedOn: r.receivedOn, keptMinor: l.keptMinor, uom: l.uom, currency, receivedUnitCost: basisOf(l.unitCost), receivedValueMinor,
      };
      let compared: Pick<PpvLine, 'order' | 'notCompared'>;
      const poLine = order?.lines.find((x) => x.productId === l.productId);
      if (r.poId === null) compared = { notCompared: 'no_purchase_order' };
      else if (order === undefined) compared = { notCompared: 'order_not_held' };
      else if (poLine === undefined) compared = { notCompared: 'product_not_on_order' };
      else if (poLine.unitCost.currency !== currency) compared = { notCompared: 'currency_differs' };
      else {
        const valueMinor = valueAtCost(l.keptMinor, l.uom, poLine.unitCost);
        compared = { order: { unitCost: basisOf(poLine.unitCost), valueMinor, varianceMinor: receivedValueMinor - valueMinor, varianceBps: bps(receivedValueMinor - valueMinor, valueMinor), basis: order.blanketAgreementId === undefined ? 'purchase_order' : 'blanket_release' } };
      }
      const k = contractFor(input.agreements, supplierId, l.productId, r.receivedOn, currency);
      const contract = k === undefined || k.line === undefined ? undefined : (() => {
        const valueMinor = valueAtCost(l.keptMinor, l.uom, k.line.agreedUnitCost);
        return { agreementId: k.a.agreementId, unitCost: basisOf(k.line.agreedUnitCost), valueMinor, varianceMinor: receivedValueMinor - valueMinor, varianceBps: bps(receivedValueMinor - valueMinor, valueMinor) };
      })();
      lines.push({ ...base, ...compared, ...(contract === undefined ? {} : { contract }) });
    }
  }

  const roll = (key: string, of: readonly PpvLine[]): PpvRollup => {
    const cmp = of.filter((l) => l.order !== undefined);
    const orderValueMinor = cmp.reduce((s, l) => s + l.order!.valueMinor, 0);
    const receivedValueMinor = cmp.reduce((s, l) => s + l.receivedValueMinor, 0);
    const varianceMinor = receivedValueMinor - orderValueMinor;
    const withContract = of.filter((l) => l.contract !== undefined);
    return {
      key, lines: of.length, comparedLines: cmp.length, receivedValueMinor, orderValueMinor, varianceMinor, varianceBps: bps(varianceMinor, orderValueMinor),
      linesAboveOrder: cmp.filter((l) => l.order!.varianceMinor > 0).length, linesBelowOrder: cmp.filter((l) => l.order!.varianceMinor < 0).length,
      contractLines: withContract.length, contractVarianceMinor: withContract.reduce((s, l) => s + l.contract!.varianceMinor, 0),
    };
  };
  const group = (keyOf: (l: PpvLine) => string): PpvRollup[] => {
    const by = new Map<string, PpvLine[]>();
    for (const l of lines) by.set(keyOf(l), [...(by.get(keyOf(l)) ?? []), l]);
    // Worst first: the largest overpayment against the order leads; ties by key.
    return [...by].map(([k, ls]) => roll(k, ls)).sort((a, b) => b.varianceMinor - a.varianceMinor || a.key.localeCompare(b.key));
  };
  const notCompared: Record<NotCompared, number> = { no_purchase_order: 0, order_not_held: 0, product_not_on_order: 0, currency_differs: 0 };
  for (const l of lines) if (l.notCompared !== undefined) notCompared[l.notCompared] += 1;
  const all = roll('all', lines);
  const totals: Omit<PpvRollup, 'key'> = { lines: all.lines, comparedLines: all.comparedLines, receivedValueMinor: all.receivedValueMinor, orderValueMinor: all.orderValueMinor, varianceMinor: all.varianceMinor, varianceBps: all.varianceBps, linesAboveOrder: all.linesAboveOrder, linesBelowOrder: all.linesBelowOrder, contractLines: all.contractLines, contractVarianceMinor: all.contractVarianceMinor };
  return { lines, byProduct: group((l) => l.productId), byReceipt: group((l) => l.grnId), totals: { ...totals, notCompared } };
}
