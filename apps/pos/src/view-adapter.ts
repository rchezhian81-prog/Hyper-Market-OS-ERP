// View adapter — the thin, tested bridge between the `PosSession` model and the
// browser view (`web/app.js`). The view deals only in display primitives (integer
// minor units, plain strings), never in Money/Quantity/Rate objects, so the view
// layer can hold NO business rules: pricing, promotions, tender and the sale commit
// all stay in the tested engines behind this adapter. Keeping the mapping here (and
// tested) means the bundled shell behaves exactly like the model it wraps.

import { money, type CurrencyCode } from '../../../packages/contracts/src/money';
import type { Uom } from '../../../packages/contracts/src/quantity';
import { rate } from '../../../packages/contracts/src/rate';
import type { Tender } from '../../../packages/tender/src/tender';
import type { CatalogueCache } from '../../../packages/catalogue/src/catalogue';
import type { PosSession, SyncBadge } from './session';
import { presentSyncBadge, type StatusPresentation } from '../../../packages/a11y/src/signals';

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

/** What a barcode scan produced, for the view to show (or announce). */
export interface ScanOutcome {
  readonly lineId: string;
  readonly description: string;
  readonly qty: number;
  readonly amountMinor: number;
  /** The lane must prompt for age before completing this sale (M12-FR-04). */
  readonly requiresAgeCheck: boolean;
}

/** The surface `web/app.js` binds to (attached as `window.posSession`). */
export interface PosView {
  scan(input: ViewScan): void;
  /**
   * Scan a barcode: resolve it in the local catalogue and add the priced line.
   * Throws a clear error the lane can show if the code is unknown, the item is not
   * sellable, or it is under recall (offline included).
   */
  scanBarcode(code: string): ScanOutcome;
  /** True when no catalogue is loaded on this lane (the view hides scanning). */
  hasCatalogue(): boolean;
  setQuantity(lineId: string, qty: number): void;
  voidLine(lineId: string, reason: string): void;
  basket(): ViewLine[];
  payableMinor(): number;
  syncBadge(): SyncBadge;
  /**
   * The badge as it must be RENDERED — tone, label, icon and announcement together (NFR-07).
   *
   * The raw `syncBadge()` hands the view a state and a number, which is everything it needs to
   * render a coloured dot and nothing that stops it. This returns the words as well, so a
   * colour-only badge takes a deliberate act of discarding them.
   */
  syncStatus(): StatusPresentation;
  /** Take a full cash payment and commit locally. Returns the receipt number. */
  /**
   * Take cash and finish the sale.
   *
   * Returns a **promise**, and the type is the guarantee: the receipt number does not exist until
   * the sale is on the local disk, so there is nothing to print with before then (hard rule #1).
   */
  tenderCash(saleId: string, receiptNumber: string, atIsoUtc: string): Promise<string>;
  newSale(): void;
}

/**
 * Wrap a `PosSession` in the display-primitive surface the view binds to. Every
 * call delegates to the tested model — this adapter only converts types. Pass the
 * lane's `CatalogueCache` to enable barcode scanning.
 */
export function createPosView(
  session: PosSession,
  currency: CurrencyCode = 'INR',
  catalogue?: CatalogueCache,
): PosView {
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

    hasCatalogue(): boolean {
      return catalogue !== undefined;
    },

    scanBarcode(code: string): ScanOutcome {
      if (catalogue === undefined) {
        throw new Error('No catalogue loaded on this lane.');
      }
      // The catalogue refuses an unknown code, a non-sellable status, or a recalled
      // item (offline included) — the error surfaces to the cashier unchanged.
      const hit = catalogue.scan(code);
      // A price-embedded barcode carries the line price for one unit; otherwise the
      // catalogue's unit price applies to the scanned quantity.
      const unitPriceMinor = hit.priceOverrideMinor ?? hit.product.unitPriceMinor;
      const entry = session.scan({
        productId: hit.product.productId,
        description: hit.product.name,
        unitPrice: money(unitPriceMinor, currency),
        quantityMinor: hit.quantityMinor,
        uom: hit.product.baseUom as Uom,
        taxRate: rate(hit.product.taxBps),
      });
      return {
        lineId: entry.lineId,
        description: entry.description,
        qty: entry.quantityMinor,
        amountMinor: unitPriceMinor,
        requiresAgeCheck: hit.requiresAgeCheck,
      };
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

    syncStatus(): StatusPresentation {
      const badge = session.syncBadge();
      return presentSyncBadge({ connection: badge.connection, unsentCount: badge.unsentCount });
    },

    async tenderCash(saleId: string, receiptNumber: string, atIsoUtc: string): Promise<string> {
      const payable = session.totals().payable;
      const tenders: Tender[] = [{ kind: 'cash', amount: payable, status: 'settled' }];
      // Commits to the local DISK, then queues for sync — no network call (hard rule #1).
      //
      // The `await` is the receipt's guarantee, and it is structural rather than a convention: the
      // receipt number does not exist until the sale is on the disk, so there is nothing to print
      // early with. That is why `commit` is asynchronous — awaiting a local fsync is not awaiting
      // the network.
      const sale = await session.commit(saleId, receiptNumber, atIsoUtc, tenders);
      return sale.number;
    },

    newSale(): void {
      session.newSale();
    },
  };
}
