// REAL TRADING on the store computer (OB-271 · owner, 21 Oct 2026) — the till's legal-invoice rule, again, before THIS disk.
//
// The till assembles and checks the Rule 46 tax invoice before it sends a sale (`apps/pos/src/session.ts`). The store
// computer runs the same check on the record it is about to keep — the bill number, the date, each line's HSN, rate and
// value, and the shop's legal identity from its own store pack — so a page from an older till, or a record posted
// straight to the socket, cannot put a sale whose bill is not a tax invoice on the disk. The box does not hold the items'
// names, so it judges everything but the description (the till judged that). Pure; no network (hard rule #1).
//
// Off unless real trading is on, and never together with the mirror pilot (the box also refuses to start with both).

import { buildTaxInvoice, lineTaxSplit, type TaxInvoiceIdentity } from '../../../packages/receipt/src/tax-invoice';
import { readCessRate, type CessRate } from '../../../packages/finance/src/cess';

/** The box's words when the mirror pilot and real trading are both on (a later store pack could set both). */
export const REAL_TRADING_AND_MIRROR_BOX_WORDS = 'This store computer is set for the mirror pilot AND for real trading, which are never on together. Nothing was saved — do not take money. Tell the owner.';

type Rec = Record<string, unknown>;
const isObj = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' ? v : Number.NaN);

/**
 * A real-trading SALE record judged as a tax invoice: `undefined` when its bill is a complete Rule 46 invoice, else the
 * refusal in the cashier's words (every missing field named).
 */
export function realTradingSaleRefusal(
  record: Rec, identity: TaxInvoiceIdentity | null,
  /** A7: the compensation cess THIS box's signed pack says each product carries — the bill is judged by it, not the record's. */
  cessOf?: (productId: string) => CessRate | undefined,
): { readonly refusedBecause: 'tax_invoice_incomplete'; readonly laneMessage: string } | undefined {
  const lines = Array.isArray(record['lines']) ? record['lines'] : [];
  // A7: a line's cess as recorded must be what this box's pack says — dropping or cutting it under-declares the tax.
  for (const l of lines) {
    const o = isObj(l) ? l : {};
    const productId = typeof o['productId'] === 'string' ? o['productId'] : '';
    const packCess = cessOf === undefined ? readCessRate(o['cess']) : readCessRate(cessOf(productId));
    const expected = packCess === undefined ? 0
      : lineTaxSplit({ lineTotalMinor: num(o['lineTotalMinor']), taxRateBps: num(o['taxRateBps']), cess: packCess, quantityMinor: num(o['quantityMinor']) })?.cessMinor;
    const recorded = typeof o['cessMinor'] === 'number' ? o['cessMinor'] : 0;
    if (expected === undefined || expected !== recorded) {
      return { refusedBecause: 'tax_invoice_incomplete', laneMessage: `This bill cannot be issued as a legal tax invoice, so it was NOT saved — do not take money. ${productId}: the compensation cess on the bill is not the cess the price list gives this item. Head office must correct the item in the price list.` };
    }
  }
  const number = typeof record['number'] === 'string' ? record['number'] : typeof record['receiptNumber'] === 'string' ? record['receiptNumber'] : '';
  const built = buildTaxInvoice({
    identity, number,
    committedAt: typeof record['committedAt'] === 'string' ? record['committedAt'] : '',
    laneId: typeof record['laneId'] === 'string' ? record['laneId'] : '',
    cashierId: typeof record['cashierId'] === 'string' ? record['cashierId'] : '',
    lines: lines.map((l) => {
      const o = isObj(l) ? l : {};
      return {
        // The box holds no item names: the product id stands in, so only what the box CAN judge is judged here.
        description: typeof o['productId'] === 'string' ? o['productId'] : '',
        ...(typeof o['hsnCode'] === 'string' ? { hsnCode: o['hsnCode'] } : {}),
        quantityMinor: num(o['quantityMinor']), uom: typeof o['uom'] === 'string' ? o['uom'] : '',
        unitPriceMinor: num(o['unitPriceMinor']), lineTotalMinor: num(o['lineTotalMinor']), taxRateBps: num(o['taxRateBps']),
        ...((): { cess?: CessRate } => {
          const c = cessOf === undefined ? readCessRate(o['cess']) : readCessRate(cessOf(typeof o['productId'] === 'string' ? o['productId'] : ''));
          return c === undefined ? {} : { cess: c };
        })(),
      };
    }),
    // OB-279 · OB-285: the record's total must be the invoice's total (never above the lines), to the paisa.
    ...(typeof record['total'] === 'number' ? { totalMinor: record['total'] } : typeof record['totalMinor'] === 'number' ? { totalMinor: record['totalMinor'] } : {}),
  });
  return built.ok ? undefined : { refusedBecause: 'tax_invoice_incomplete', laneMessage: built.laneMessage };
}
