// View adapter — the thin, tested bridge between the `PosSession` model and the
// browser view (`web/app.js`). The view deals only in display primitives (integer
// minor units, plain strings), never in Money/Quantity/Rate objects, so the view
// layer can hold NO business rules: pricing, promotions, tender and the sale commit
// all stay in the tested engines behind this adapter. Keeping the mapping here (and
// tested) means the bundled shell behaves exactly like the model it wraps.

import { money, type CurrencyCode } from '../../../packages/contracts/src/money';
import type { Uom } from '../../../packages/contracts/src/quantity';
import type { Tender } from '../../../packages/tender/src/tender';
import type { PosSession, SyncBadge } from './session';

/** A basket line as the view renders it — display primitives only. */
export interface ViewLine {
  readonly lineId: string;
  readonly productId: string;
  readonly description: string;
  readonly unitPriceMinor: number;
  readonly qty: number;
  readonly uom: string;
  readonly voided: boolean;
  readonly voidReason?: string;
}

/** A scan as the view supplies it (e.g. from the scanner or a lookup). */
export interface ViewScan {
  readonly productId: string;
  readonly description: string;
  readonly unitPriceMinor: number;
  readonly qty: number;
  readonly uom?: string;
}

/** The surface `web/app.js` binds to (attached as `window.posSession`). */
export interface PosView {
  scan(input: ViewScan): void;
  setQuantity(lineId: string, qty: number): void;
  voidLine(lineId: string, reason: string): void;
  basket(): ViewLine[];
  payableMinor(): number;
  syncBadge(): SyncBadge;
  /** Take a full cash payment and commit locally. Returns the receipt number. */
  tenderCash(saleId: string, receiptNumber: string, atIsoUtc: string): string;
  newSale(): void;
}

/**
 * Wrap a `PosSession` in the display-primitive surface the view binds to. Every
 * call delegates to the tested model — this adapter only converts types.
 */
export function createPosView(session: PosSession, currency: CurrencyCode = 'INR'): PosView {
  return {
    scan(input: ViewScan): void {
      session.scan({
        productId: input.productId,
        description: input.description,
        unitPrice: money(input.unitPriceMinor, currency),
        quantityMinor: input.qty,
        uom: (input.uom ?? 'ea') as Uom,
      });
    },

    setQuantity(lineId: string, qty: number): void {
      session.setQuantity(lineId, qty);
    },

    voidLine(lineId: string, reason: string): void {
      session.voidLine(lineId, reason);
    },

    basket(): ViewLine[] {
      return session.basket().map((l) => ({
        lineId: l.lineId,
        productId: l.productId,
        description: l.description,
        unitPriceMinor: l.unitPrice.minor,
        qty: l.quantityMinor,
        uom: l.uom,
        voided: l.voided,
        voidReason: l.voidReason,
      }));
    },

    /** The amount the customer pays, in minor units — the big number on screen. */
    payableMinor(): number {
      return session.totals().payable.minor;
    },

    syncBadge(): SyncBadge {
      return session.syncBadge();
    },

    tenderCash(saleId: string, receiptNumber: string, atIsoUtc: string): string {
      const payable = session.totals().payable;
      const tenders: Tender[] = [{ kind: 'cash', amount: payable, status: 'settled' }];
      // Commits locally and queues for sync — no network call (hard rule #1).
      const sale = session.commit(saleId, receiptNumber, atIsoUtc, tenders);
      return sale.number;
    },

    newSale(): void {
      session.newSale();
    },
  };
}
