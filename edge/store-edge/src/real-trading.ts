// REAL TRADING on the store computer (OB-271 · owner, 21 Oct 2026) — the till's legal-invoice rule, again, before THIS disk.
//
// The till assembles and checks the Rule 46 tax invoice before it sends a sale (`apps/pos/src/session.ts`). The store
// computer runs the same check on the record it is about to keep — the bill number, the date, each line's HSN, rate and
// value, and the shop's legal identity from its own store pack — so a page from an older till, or a record posted
// straight to the socket, cannot put a sale whose bill is not a tax invoice on the disk. The box does not hold the items'
// names, so it judges everything but the description (the till judged that). Pure; no network (hard rule #1).
//
// Off unless real trading is on, and never together with the mirror pilot (the box also refuses to start with both).

import { buildTaxInvoice, type TaxInvoiceIdentity } from '../../../packages/receipt/src/tax-invoice';

/** The box's words when the mirror pilot and real trading are both on (a later store pack could set both). */
export const REAL_TRADING_AND_MIRROR_BOX_WORDS = 'This store computer is set for the mirror pilot AND for real trading, which are never on together. Nothing was saved — do not take money. Tell the owner.';

type Rec = Record<string, unknown>;
const isObj = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' ? v : Number.NaN);

/**
 * A real-trading SALE record judged as a tax invoice: `undefined` when its bill is a complete Rule 46 invoice, else the
 * refusal in the cashier's words (every missing field named).
 */
export function realTradingSaleRefusal(record: Rec, identity: TaxInvoiceIdentity | null): { readonly refusedBecause: 'tax_invoice_incomplete'; readonly laneMessage: string } | undefined {
  const lines = Array.isArray(record['lines']) ? record['lines'] : [];
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
      };
    }),
    // OB-279: the record's total must be the invoice's rounded total (the lines plus the round off), to the paisa.
    ...(typeof record['total'] === 'number' ? { totalMinor: record['total'] } : typeof record['totalMinor'] === 'number' ? { totalMinor: record['totalMinor'] } : {}),
  });
  return built.ok ? undefined : { refusedBecause: 'tax_invoice_incomplete', laneMessage: built.laneMessage };
}
