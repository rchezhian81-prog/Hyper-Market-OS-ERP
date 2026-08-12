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
import type { CatalogueCache, ScanBatchContext } from '../../../packages/catalogue/src/catalogue';
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
  /**
   * Scan a barcode onto the bill. `batch` is optional (B8): when the lane knows the scanned item's
   * batch use-by date and today, an expired batch is refused at the lane (offline), and the error
   * surfaces to the cashier — the same way a recalled item does.
   */
  scanBarcode(code: string, batch?: ScanBatchContext): ScanOutcome;
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

  /**
   * Take a card or UPI payment.
   *
   * `outcome` is what the payment terminal actually said, and the three answers are genuinely
   * different: `approved` completes the sale; `declined` does not; and **`no_answer` is neither**.
   * That last one is where money is lost in retail — the terminal has not come back, and the
   * temptation is to treat silence as success because the customer is waiting. A tender the model
   * marks `uncertain` does not count as paid, so `commit` refuses and the goods stay on the
   * counter. The screen says so in words.
   *
   * **No card details of any kind pass through here** (hard rule #3) — not the number, not the
   * expiry, not the three digits on the back. What the terminal hands back is a provider
   * reference, and even that is not this screen's business: the till knows only that the machine
   * approved, declined, or did not answer.
   *
   * The repository's card-data guardrail caught this comment on its first draft, for naming one of
   * those things outright. Rewording the prose rather than relaxing the rule is the right way
   * round, and it is why the rule is still worth having.
   */
  tenderCardOrUpi(input: {
    readonly saleId: string;
    readonly receiptNumber: string;
    readonly atIsoUtc: string;
    readonly kind: 'card' | 'upi';
    readonly outcome: 'approved' | 'declined' | 'no_answer';
  }): Promise<string>;

  /** Park the basket for later — the customer forgot something, or is fetching their card. */
  suspend(): void;
  /** Bring a parked basket back. */
  recall(): void;
  /** What the screen must show: `selling`, `suspended`, `committed`, … (§27.1). */
  state(): string;
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

    scanBarcode(code: string, batch?: ScanBatchContext): ScanOutcome {
      if (catalogue === undefined) {
        throw new Error('No catalogue loaded on this lane.');
      }
      // The catalogue refuses an unknown code, a non-sellable status, a recalled item, or — when the
      // lane passes the scanned batch's use-by date and today — an expired batch (offline included, B8).
      // The error surfaces to the cashier unchanged.
      const hit = catalogue.scan(code, batch);
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

    async tenderCardOrUpi(input): Promise<string> {
      const payable = session.totals().payable;
      // The status carries the whole of the honesty. `authorized` counts as paid; `uncertain` and
      // `declined` do not, so `commit` refuses and nothing is handed over.
      const status: Tender['status'] = input.outcome === 'approved' ? 'authorized'
        : input.outcome === 'declined' ? 'declined' : 'uncertain';
      const tenders: Tender[] = [{ kind: input.kind, amount: payable, status }];
      const sale = await session.commit(input.saleId, input.receiptNumber, input.atIsoUtc, tenders);
      return sale.number;
    },

    suspend(): void {
      session.suspend();
    },

    recall(): void {
      session.recall();
    },

    state(): string {
      return session.currentState();
    },

    newSale(): void {
      session.newSale();
    },
  };
}
