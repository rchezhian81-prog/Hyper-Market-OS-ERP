// POS terminal session (M12 / D04) — the application shell behind the Sale screen
// (`docs/design/screens/pos-cashier.md`). It holds the basket a cashier is building
// and composes the tested engines: line/bill pricing, the promotions best-price
// engine, tender settlement, and the local sale commit. Hard rule #1 is structural
// here: NOTHING in this class awaits I/O — scanning, pricing, tendering and
// committing are all synchronous and local, so a sale completes with the network
// cable out and is queued for sync afterwards. The sync badge (§27.1) reads the
// outbox's unsent count so lag is always visible (P-08).

import { money, add, type Money, type CurrencyCode } from '../../../packages/contracts/src/money';
import { shopDateTimeOf } from '../../../packages/calendar/src/shop-day'; // OB-607: the slip's time is the shop's clock
import { quantity, type Uom } from '../../../packages/contracts/src/quantity';
import { rate, type Rate } from '../../../packages/contracts/src/rate';
import type { ConnectionState } from '../../../packages/contracts/src/enums';
import { priceLine, sumLines, splitInclusive, type LinePricing, type BillTotals } from '../../../packages/pricing/src/pricing';
import { bestPrice, promotionProductIds, type Promotion, type BasketLine, type PromotionResult } from '../../../packages/promotions/src/promotions';
import { tobaccoAdvertisingRefusal } from '../../../packages/restricted-sales/src/advertising';
import { lineBundleOf, type BundleDefinition, type LineBundle } from '../../../packages/product/src/bundles';
import { settle, type Tender, type Settlement } from '../../../packages/tender/src/tender';
import { commitSale, UnpaidSaleError, type CommittedSale } from '../../../packages/sale/src/sale';
import type { Ledger } from '../../../packages/ledger/src/ledger';
import type { SyncOutbox } from '../../../packages/sync/src/outbox';
import type { CommitOutcome } from '../../../edge/store-edge/src/durability';
import { makeTradingDayRule, tradingDateOf } from '../../../packages/calendar/src/index';
import type { SuspendedLine, SuspendedAgeAnswer } from '../../../packages/suspended-sales/src/suspended-bill';
import { normaliseMobile } from '../../../packages/loyalty/src/mobile';
import { withoutCardData } from '../../../packages/tender/src/tender-card-data';
import { saleTenderRefusal } from '../../../packages/tender/src/paid-on-old-erp';
import { oldErpBillRefusal } from '../../../packages/tender/src/old-erp-bill-number';
import { readMachineReference } from '../../../packages/tender/src/machine-reference';
import { buildTaxInvoice, invoiceRoundOff, type TaxInvoiceDocument, type TaxInvoiceIdentity, type TaxInvoiceProblem } from '../../../packages/receipt/src/tax-invoice';
import { splitInclusiveWithCess, readCessRate, type CessRate } from '../../../packages/finance/src/cess';
import {
  tillLineRefusals, tillRuleFlagsOf, scaleEvidence, lineIsWeighed, TillRuleRefusedError, TOBACCO_MINIMUM_AGE,
  type LaneScales, type TillGateContext,
} from '../../../packages/restricted-sales/src/till-gate';

export interface PosSessionConfig {
  /**
   * The lane this till IS — the store box's own identity (`EDGE_LANE_ID`), told to the served shell; never a default
   * (audit finding F09). Absent means the box was never told, and a sale is REFUSED rather than filed under a lane
   * that does not exist.
   */
  readonly laneId?: string;
  /**
   * The cashier at the till when the session was built. Usually absent: the person SIGNS IN with their staff code
   * (`signIn`), so every sale names who actually rang it (§28 · hard rule #4). Absent and nobody signed in → refused.
   */
  readonly cashierId?: string;
  /** A FIXED trading day (a test, a replay). Absent → each sale is dated at the moment it is taken, per the cut-off. */
  readonly tradingDay?: string;
  /** Where this shop's trading day ends, "HH:MM" local (M01-FR-02), from the store pack. Absent = midnight. */
  readonly tradingDayCutoff?: string;
  /**
   * R1 (M01-FR-02): the shop's IANA time zone, from the store pack through the box. The till dates by it, not by the zone
   * the device happens to be set to. Absent (a page from an older box): this device's own wall clock, as before.
   */
  readonly timeZone?: string;
  readonly currency: CurrencyCode;
  /** Default tax rate EXTRACTED from the inclusive price when a line doesn't carry its own (per-tenant config). */
  readonly defaultTaxRate: Rate;
  /**
   * SF-01 — this lane's wall clock, the instant an offer's window is judged at. Absent (a test, a replay) → the instant
   * `setNow` gave. Before, nothing ever set it, so every offer on a real till was judged at 1 Jan 1970 and none applied.
   */
  readonly clock?: () => string;
  /**
   * B6 — the weighing scales THIS lane takes weight from, from the store pack (store computer → served page). Absent, or
   * `known: false`, means the till was never told: then nothing is sold by weight, because no stamp can be shown current.
   */
  readonly laneScales?: LaneScales;
  /**
   * B13 (OB-138) — the hallmark HUIDs this store has already sold, as its store computer knows them from its own sales
   * (served with the page; no network on the scan). Absent → only what this till sold since it loaded is known; the store
   * computer and head office judge the rest.
   */
  readonly soldHuids?: () => ReadonlySet<string>;
  /**
   * B14 · B19 — a product's `regulatedFlags` as the lane's signed catalogue pack carries them, by id. The commit's second
   * gate and a recalled held basket read the PACK, not only what the scan said. Absent → only the scan's own flags.
   */
  readonly regulatedFlagsOf?: (productId: string) => Readonly<Record<string, unknown>> | undefined;
  /**
   * NEW-2 (B6) — a product's base unit as the lane's signed catalogue pack carries it, by id. Whether a line is WEIGHED is
   * decided from the pack, not only from the unit a scan or a recalled basket wrote on the line. Absent → the line's unit.
   */
  readonly baseUomOf?: (productId: string) => string | undefined;
  /**
   * A7: a product's GST Compensation Cess as the lane's signed catalogue pack carries it, by id. The commit reads the PACK
   * (a recalled held line included), not only what the scan said. Absent → only the scan's own cess.
   */
  readonly cessOf?: (productId: string) => CessRate | undefined;
  /**
   * B17 · OB-348: a product's HSN as the lane's signed catalogue pack carries it, by id — an alcoholic-drink heading is
   * refused at the scan and at the commit even when the product carries no liquor flag. Absent → the scan's own HSN.
   */
  readonly hsnCodeOf?: (productId: string) => string | undefined;
  /**
   * OB-506 (owner, 28 Oct 2026): a product's MRP as the lane's signed catalogue pack carries it, by id — the legal ceiling a
   * line raised to a quotation's price may never pass (Legal Metrology · A9). Absent, or no MRP on the product → the till
   * cannot show a raised price is within the MRP, so it refuses to raise it.
   */
  readonly mrpOf?: (productId: string) => number | undefined;
  /**
   * OB-306 (M03-FR-02): the own-barcode bundle a product is sold as, from the lane's signed catalogue pack. A bundle line is
   * exploded at the commit (`explodeBundleLine`) and the components it takes off the shelf are frozen on the line, so head
   * office writes one stock movement per component. Absent → no product is a bundle here.
   */
  readonly bundleOf?: (productId: string) => BundleDefinition | undefined;
  /**
   * OB-299 (M12-FR-02): the catalogue product whose signed price is the DELIVERY-FEE line, from the store pack (store setup).
   * Absent → "not set": the till refuses to mark a bill for delivery and says the owner has not set the fee.
   */
  readonly deliveryFeeProductId?: string;
  /**
   * OB-348 (B17): the shop's state (ISO 3166-2:IN code) from the store pack, which liquor is judged by. Absent → "not set"
   * (liquor is refused either way; the cashier is told why).
   */
  readonly shopState?: string;
  /**
   * OB-252 (owner, 20 Oct 2026, "Guest sales only"): during the mirror pilot this till takes no customer mobile number and
   * no loyalty — no member on the bill, no points or store credit spent. Turned on by the store pack
   * (`policies.guestSalesOnly`) or the store computer's own setting (`EDGE_GUEST_SALES_ONLY=1`), told to the till by its
   * box. Refused in words when asked, never dropped quietly; the screen shows it is on.
   */
  readonly guestSalesOnly?: boolean;
  /**
   * OB-256 (owner, 20 Oct 2026, "One 'paid on old' type"): the MIRROR PILOT — the customer is billed and pays on the old
   * ERP; this till records the same lines paid by ONE non-cash tender, `paid_on_old_erp`, for the whole bill. Turned on by
   * the store pack (`policies.mirrorPilot`) or the store computer's own setting (`EDGE_MIRROR_PILOT=1`), told to the till
   * by its box. Off → that tender is refused; on → every other tender is refused. Both before the disk, in words.
   */
  readonly mirrorPilot?: boolean;
  /**
   * OB-271 (owner, 21 Oct 2026): REAL TRADING — the new till's bill is the legal GST tax invoice. Turned on only by the
   * store computer's own `EDGE_REAL_TRADING=1` or the store pack (`policies.realTrading`), after the pilot passes and the
   * owner's written GO; never together with the mirror pilot. While on, every sale must make a complete Rule 46 invoice
   * from the shop's legal identity (`identity`, the store's setup) or it is REFUSED before the disk. Absent = off: the till
   * behaves exactly as before.
   */
  readonly realTrading?: { readonly identity: TaxInvoiceIdentity | null };
  /** OB-501 (R7-A): this till's own app build, reported on every sale record (head office judges it by its version policy). */
  readonly appVersion?: string;
}

/** OB-271: the mirror pilot and real trading are never on together — the till refuses to sell rather than guess which. */
export const REAL_TRADING_AND_MIRROR_WORDS = 'This till is set for the mirror pilot AND for real trading, which are never on together. Nothing was saved — do not take money. Tell the owner.';

/**
 * OB-271: a real-trading sale whose bill would not be a complete Rule 46 tax invoice — refused BEFORE the disk, with every
 * missing field named, so a non-compliant bill is never issued. `problems` lets the screen say it in the cashier's language.
 */
export class TaxInvoiceRefusedError extends Error {
  readonly refusedBecause = 'tax_invoice_incomplete';
  constructor(public readonly saleId: string, public readonly laneMessage: string, public readonly problems: readonly TaxInvoiceProblem[]) {
    super(`sale ${saleId} was not committed: ${laneMessage}`);
    this.name = 'TaxInvoiceRefusedError';
  }
}

/** What the till says when a customer number or loyalty is asked for while guest sales only is on (OB-252). */
export const GUEST_SALES_ONLY_WORDS = 'Guest sales only on this till during the pilot: no customer mobile number and no loyalty points or store credit. Ring the sale as a guest. The old billing system keeps loyalty as today.';

/**
 * OB-352 (owner, 24 Oct 2026, in writing): the bill's delivery — how its address and slot will be given. A member with the
 * app chooses them in the app; otherwise the till prints this DELIVERY SLIP for the delivery desk, who enters them at head
 * office against the job (`till-<saleId>`). The slip carries only the job, the bill and blank lines to be written by hand —
 * the till keeps no address and no phone number (P-04).
 */
export interface DeliverySlip {
  readonly path: 'customer_app' | 'delivery_desk';
  readonly jobRef: string;
  readonly receiptNumber: string;
  readonly committedAt: string;
  readonly itemLines: number;
  /** The lines as they print (or show), in the language asked. */
  readonly lines: readonly string[];
}

const SLIP_WORDS = {
  en: {
    title: 'DELIVERY SLIP', job: 'Delivery job', bill: 'Bill', at: 'Billed', items: 'Item lines', paid: 'Paid in full at the till — the door collects nothing.',
    write: 'Write clearly, then hand this slip to the delivery desk:', name: 'Name', address: 'Address', landmark: 'Landmark', phone: 'Phone', slot: 'Delivery slot (day and time)',
    app: 'The customer chooses the delivery address and slot in the SRE app (Deliveries from the shop).',
  },
  ta: {
    title: 'டெலிவரி சீட்டு', job: 'டெலிவரி பணி', bill: 'பில்', at: 'பில் நேரம்', items: 'பொருள் வரிகள்', paid: 'கவுண்டரில் முழுத் தொகையும் செலுத்தப்பட்டது — வீட்டில் எதுவும் வசூலிக்கப்படாது.',
    write: 'தெளிவாக எழுதி, இந்தச் சீட்டை டெலிவரி மேசையில் கொடுக்கவும்:', name: 'பெயர்', address: 'முகவரி', landmark: 'அடையாளம்', phone: 'தொலைபேசி', slot: 'டெலிவரி நேரம் (நாள், நேரம்)',
    app: 'வாடிக்கையாளர் டெலிவரி முகவரியையும் நேரத்தையும் SRE செயலியில் தேர்வு செய்வார் (கடையிலிருந்து டெலிவரி).',
  },
} as const;

/** OB-299: the words the till says when the owner has not set the delivery fee. */
export const DELIVERY_FEE_NOT_SET_WORDS = 'Delivery from the till is not set up: the owner has not set the delivery fee. Take the sale as a normal sale, or ask the manager.';

/**
 * OB-299 (M12-FR-02): a bill cannot be marked for delivery — the fee is not set, its product is not in this till's
 * catalogue, or the basket is in a state that cannot take it. Thrown before anything changes; `refusedBecause` lets the
 * screen say it in the cashier's language.
 */
export class DeliveryNotAvailableError extends Error {
  readonly laneMessage: string;
  constructor(public readonly refusedBecause: 'delivery_fee_not_set' | 'delivery_fee_not_in_catalogue', words: string) {
    super(`delivery not available: ${refusedBecause}`);
    this.name = 'DeliveryNotAvailableError';
    this.laneMessage = words;
  }
}

/**
 * NEW-1 (B19): an offer the till refused to apply because it targets a carry bag — said, never dropped quietly (P-08).
 * B15 (COTPA s.5 · OB-288 till side): or because it names a tobacco product — tobacco may not be promoted.
 */
export interface RefusedOffer {
  readonly offerId: string;
  readonly carryBags: readonly string[];
  /** B15: the tobacco products the offer names (by the lane's own signed pack). Absent when it names none. */
  readonly tobaccoProductIds?: readonly string[];
  readonly laneMessage: string;
}

export { TillRuleRefusedError } from '../../../packages/restricted-sales/src/till-gate';

export interface ScanInput {
  readonly productId: string;
  readonly description: string;
  /** Price of one UOM unit (per each, per kg, …) — the SHELF price, GST already inside it (≤ MRP, A9). */
  readonly unitPrice: Money;
  /** Quantity in the UOM's smallest unit (e.g. 1 ea, or 1234 g for 1.234 kg). */
  readonly quantityMinor: number;
  readonly uom: Uom;
  /** Line tax rate; falls back to the session default. */
  readonly taxRate?: Rate;
  /** The product's HSN / tax-class code, from the pack the lane priced from. Carried so the sale FREEZES
   *  the HSN it was sold under, for the GST return (A5) — a record only, never a control (hard rule #1). */
  readonly hsnCode?: string;
  /** Optional promotion grouping tag (mix-match). */
  readonly group?: string;
  /** The product's minimum age in whole years, from the pack (`regulatedFlags.minimumAge`) — absent when unrestricted.
   *  A restricted item joins the basket only once the basket holds a CONFIRMED answer for at least this age
   *  (M12-FR-04 · Wave 2b audit PF-03). */
  readonly minimumAge?: number;
  /** The product's `regulatedFlags` from the pack — tobacco pack size, carry-bag and plastic facts (B14 · B19). */
  readonly regulatedFlags?: Readonly<Record<string, unknown>>;
  /** D-20 — the batch the barcode CARRIED (a GS1 2D code), kept on the sale line for the recall trace. Never guessed. */
  readonly batchId?: string;
  /** D-20 — that batch's use-by date (YYYY-MM-DD), as the code carried it. */
  readonly batchExpiry?: string;
  /** A7: the product's compensation cess from the pack (tobacco / pan-masala). Absent = not cess-liable. */
  readonly cess?: CessRate;
}

/** A basket line as the cashier sees it. */
export interface BasketEntry {
  readonly lineId: string;
  readonly productId: string;
  readonly description: string;
  readonly unitPrice: Money;
  readonly quantityMinor: number;
  readonly uom: Uom;
  readonly taxRate: Rate;
  /** The HSN / tax-class code the line was priced under (frozen at supply for the GST return, A5). */
  readonly hsnCode?: string;
  readonly group?: string;
  /** The minimum age this line needs, when it is age-restricted (PF-03). */
  readonly minimumAge?: number;
  /** The product's `regulatedFlags` the line was scanned under (B14 · B19). */
  readonly regulatedFlags?: Readonly<Record<string, unknown>>;
  /** D-20 — the batch the barcode carried, and its use-by date. */
  readonly batchId?: string;
  readonly batchExpiry?: string;
  /**
   * B8 (OB-298): a perishable whose barcode carried no date — the signed-in cashier looked at the date printed on the pack
   * and confirmed it, with one tap, before this line was added. Kept on the sale line as the evidence.
   */
  readonly packDateCheck?: PackDateCheck;
  /** A7: the compensation cess charged inside the line's price (from the pack). */
  readonly cess?: CessRate;
  readonly voided: boolean;
  readonly voidReason?: string;
  /**
   * The line's price was LOWERED at the till with a manager's approval (audit PF-07 · M12-FR-04): the unit price before,
   * who approved it and the till action the store computer holds as evidence. Carried on the sale record.
   */
  readonly priceOverride?: { readonly fromUnitMinor: number; readonly approvedBy: string; readonly activityId: string; readonly quotationId?: string };
}

/**
 * One answer to the age question, kept in the basket (Wave 2b · audit PF-03). The question is about the CUSTOMER — "is the
 * customer 18 or over?" — so one confirmed answer covers every item in this basket that needs that age or less; a 21+
 * item needs its own question. A refusal is kept too: "warned and NOT sold" is the evidence loss prevention reads (M15).
 */
export interface AgeAnswer {
  readonly minimumAge: number;
  readonly outcome: 'confirmed' | 'refused';
  /** The signed-in person who checked the identification. */
  readonly by: string;
  readonly at: string;
  /** The item the question was asked for. */
  readonly productId?: string;
}

/** B8 (OB-298): who confirmed a perishable's printed date on the pack, and when — the evidence a sale line carries. */
export interface PackDateCheck {
  readonly confirmedBy: string;
  readonly confirmedAt: string;
}

/**
 * B8 (OB-298): one answer to "is the date printed on this pack still good?", kept for the basket — a "no" is kept too:
 * "looked, out of date, not sold" is the evidence loss prevention and the expiry list read.
 */
export interface PackDateAnswer {
  readonly productId: string;
  readonly outcome: 'in_date' | 'out_of_date';
  readonly by: string;
  readonly at: string;
}

/**
 * B8 (OB-298, owner 23 Oct 2026): a PERISHABLE was scanned whose barcode carries no date, and the cashier has not yet
 * confirmed the date printed on the pack. The line is NOT added; the till asks (one tap) and, on a yes, scans again. Thrown,
 * not returned, so a screen that has not learned to ask still refuses rather than sells.
 */
export class PackDateCheckRequiredError extends Error {
  readonly laneMessage: string;
  constructor(public readonly productId: string, public readonly description: string) {
    super(`${description} is perishable and its printed date has not been confirmed.`);
    this.name = 'PackDateCheckRequiredError';
    this.laneMessage = `${description} is perishable. Look at the date printed on the pack before adding it.`;
  }
}

/** B8: the commit found a perishable line with no date confirmation (a recalled held basket, an older screen). Before the disk. */
export class PackDateCheckNotDoneError extends Error {
  readonly laneMessage: string;
  constructor(public readonly saleId: string, public readonly unchecked: readonly { readonly productId: string; readonly description: string }[]) {
    super(`sale ${saleId}: ${unchecked.length} perishable line(s) have no confirmed pack date.`);
    this.name = 'PackDateCheckNotDoneError';
    this.laneMessage = `Do not take payment. ${unchecked[0]?.description ?? 'A perishable item'} has not had the date on its pack checked. Remove it and scan it again to check the date.`;
  }
}

/**
 * `unconfirmed` (audit A8): the sale was sent to the store computer and its answer was lost, so the till does not yet know
 * whether it is saved. Nothing on the basket may change and no other sale may start until the box answers
 * (`confirmPendingSale`).
 */
export type PosState = 'idle' | 'selling' | 'tendering' | 'committed' | 'suspended' | 'unconfirmed';

export interface SyncBadge {
  readonly connection: ConnectionState;
  readonly unsentCount: number;
}

/**
 * B13 · M31-FR-02: the last committed sale as its bill prints — the record's own lines (each with its name, its HUID for
 * a gold piece, its batch), the GST inside each rate band, and the payments. Prices are GST-INCLUSIVE (A9): the lines add
 * to the total, and net + GST = total. `@sre/receipt` turns this into the printed lines (`apps/pos/src/bill-receipt.ts`).
 */
export interface CommittedBill {
  readonly number: string;
  readonly saleId: string;
  readonly tradingDay: string;
  readonly committedAt: string;
  readonly laneId: string;
  readonly cashierId: string;
  readonly currency: CurrencyCode;
  readonly lines: readonly {
    readonly description: string; readonly quantityMinor: number; readonly uom: string;
    readonly unitPriceMinor: number; readonly lineTotalMinor: number; readonly huid?: string; readonly batchId?: string;
    /** A7: the compensation cess inside the line. */
    readonly cessMinor?: number;
  }[];
  readonly taxBands: readonly { readonly rateBps: number; readonly netMinor: number; readonly taxMinor: number }[];
  readonly netMinor: number;
  readonly taxMinor: number;
  /** A7: the bill's compensation cess (net + GST + cess = total). Absent when no line carries one. */
  readonly cessMinor?: number;
  readonly totalMinor: number;
  readonly tenders: readonly { readonly kind: string; readonly amountMinor: number; readonly machineRef?: string }[];
  /** OB-271: in real trading, the Rule 46 tax invoice this sale was checked against before the disk — what prints. */
  readonly taxInvoice?: TaxInvoiceDocument;
}

export interface BasketTotals extends BillTotals {
  /** Promotion discount applied to the basket, on top of any line discounts. */
  readonly promotionDiscount: Money;
  /** total − promotionDiscount (what the customer pays) — in real trading, less what OB-279/OB-285 take off (never more). */
  readonly payable: Money;
  readonly lineCount: number;
  /**
   * OB-279 (real trading only): what rounding the bill's CGST and SGST to the rupee adds (+) or takes off (−), already in
   * `payable`. Absent off real trading — the till charges exactly the lines, as before.
   */
  readonly roundOffMinor?: number;
}

/**
 * OB-506 (owner, 28 Oct 2026): a quotation's price HIGHER than the till's price is charged — but never above the line's
 * MRP (Legal Metrology · A9). The till refuses to raise the line, in plain words, rather than quietly charging less than
 * the quotation promised or more than the law allows.
 */
export class QuotedPriceRefusedError extends Error {
  readonly laneMessage: string;
  readonly laneMessageTa: string;
  constructor(public readonly refusedBecause: 'quoted_above_mrp' | 'mrp_not_known', words: { readonly en: string; readonly ta: string }) {
    super(`quoted price refused: ${refusedBecause}`);
    this.name = 'QuotedPriceRefusedError';
    this.laneMessage = words.en;
    this.laneMessageTa = words.ta;
  }
}

const rupeesOf = (minor: number): string => `₹${(minor / 100).toFixed(2)}`;

/** The till's words when a quoted price would pass the MRP, or the MRP is not known — English and Tamil. */
export function quotedPriceRefusal(refusedBecause: 'quoted_above_mrp' | 'mrp_not_known', quotedMinor: number, mrpMinor?: number): { readonly en: string; readonly ta: string } {
  return refusedBecause === 'quoted_above_mrp'
    ? {
      en: `the quoted price ${rupeesOf(quotedMinor)} is above this item's MRP ${rupeesOf(mrpMinor ?? 0)} — a customer is never charged above the MRP`,
      ta: `சொன்ன விலை ${rupeesOf(quotedMinor)} இந்தப் பொருளின் அதிகபட்ச சில்லறை விலை (MRP) ${rupeesOf(mrpMinor ?? 0)}-ஐ விட அதிகம் — MRP-க்கு மேல் வாடிக்கையாளரிடம் வசூலிக்கக் கூடாது`,
    }
    : {
      en: `the quoted price ${rupeesOf(quotedMinor)} is higher than the till's price, and this till's price pack carries no MRP for the item, so the till cannot show the quoted price is within the MRP`,
      ta: `சொன்ன விலை ${rupeesOf(quotedMinor)} பில்லிங் விலையை விட அதிகம்; இந்த பில்லிங்கின் விலைத் தொகுப்பில் இந்தப் பொருளுக்கு MRP இல்லை, எனவே சொன்ன விலை MRP-க்குள் உள்ளதா என்று காட்ட முடியாது`,
    };
}

export class EmptyBasketError extends Error {
  constructor() {
    super('Cannot tender an empty basket.');
    this.name = 'EmptyBasketError';
  }
}

export class NoSuchLineError extends Error {
  constructor(lineId: string) {
    super(`No basket line "${lineId}".`);
    this.name = 'NoSuchLineError';
  }
}

export class VoidReasonRequiredError extends Error {
  constructor(lineId: string) {
    super(`Voiding line "${lineId}" needs a reason (loss prevention, M15).`);
    this.name = 'VoidReasonRequiredError';
  }
}

export class SessionStateError extends Error {
  constructor(action: string, state: PosState) {
    super(`Cannot ${action} while the session is "${state}".`);
    this.name = 'SessionStateError';
  }
}

/**
 * One cashier's terminal session. Synchronous by construction (hard rule #1): a
 * scan, a price, a tender and a commit never await the network. Promotions and
 * pricing are recomputed from the basket on demand, so the running total is always
 * consistent with what is on screen.
 */
/**
 * The local write was refused, so the sale did not happen.
 *
 * Distinct from every other error here because of *when* it is: before the receipt, before payment,
 * with the customer still standing there. It carries the cashier's words rather than a code.
 */
export class LocalCommitRefusedError extends Error {
  /** OB-301: the store computer's own Tamil words for this refusal, when it gave them (the screen shows them in Tamil). */
  readonly laneMessageTa?: string;
  /** Why the store computer refused, when it said (e.g. `staff_purchase_refused`). */
  readonly refusedBecause?: string;
  constructor(public readonly saleId: string, public readonly laneMessage: string, from?: { readonly laneMessageTa?: string; readonly refusedBecause?: string }) {
    super(`sale ${saleId} was not committed locally: ${laneMessage}`);
    this.name = 'LocalCommitRefusedError';
    if (from?.laneMessageTa !== undefined) this.laneMessageTa = from.laneMessageTa;
    if (from?.refusedBecause !== undefined) this.refusedBecause = from.refusedBecause;
  }
}

/**
 * OB-500: a line whose price a manager cut cannot change quantity — the approval was for the rupees taken off THAT
 * quantity, and ten of them would take ten times as much off with nobody approving it. The line keeps its quantity; the
 * cashier voids it and rings it again. Said in the cashier's words, English and Tamil.
 */
export class CutLineQuantityRefusedError extends Error {
  readonly laneMessage: string;
  readonly laneMessageTa: string;
  constructor(public readonly description: string) {
    super(`${description}: a line with a manager-approved price cut cannot change quantity.`);
    this.name = 'CutLineQuantityRefusedError';
    this.laneMessage = `The price of ${description} was cut with a manager's approval, so its quantity cannot be changed. Nothing was changed — void the line and ring it again.`;
    this.laneMessageTa = `${description} பொருளின் விலை மேலாளரின் ஒப்புதலுடன் குறைக்கப்பட்டது, எனவே அதன் எண்ணிக்கையை மாற்ற முடியாது. எதுவும் மாற்றப்படவில்லை — வரியை ரத்து செய்து மீண்டும் பில்லில் சேர்க்கவும்.`;
  }
}

/**
 * OB-302 (B5 · B6 · OB-31): a product sold by weight or volume (kg, g, L, ml) was scanned by a code that says nothing about
 * HOW MUCH is in the customer's hand (its plain barcode, a 2D code without a weight). The till never rings it as one gram
 * or one millilitre, and never asks the cashier to key a weight (OB-302 "never key a weight"): it is weighed or measured
 * on a verified scale and the scale's own label is scanned — the rule the self-checkout lane already applies. A product
 * packed and sold by the piece (a 1 kg bag, a 1 L pouch) is set up with the unit `ea` and scans normally. Nothing is added
 * to the bill. Said in the cashier's words, English and Tamil.
 */
export class MeasuredItemNeedsLabelError extends Error {
  readonly reason = 'measured_item_plain_barcode' as const;
  readonly laneMessage: string;
  readonly laneMessageTa: string;
  constructor(public readonly productId: string, public readonly description: string, public readonly uom: string) {
    const weighed = uom === 'kg' || uom === 'g';
    super(`${description} is sold by ${uom}; the code scanned does not say how much, so it was not added.`);
    this.name = 'MeasuredItemNeedsLabelError';
    this.laneMessage = weighed
      ? `${description} is sold by weight (${uom}). Its barcode does not say how much, so it was not added to the bill. Weigh it on a verified scale and scan the scale's label. A weight is never typed in.`
      : `${description} is sold by volume (${uom}). Its barcode does not say how much, so it was not added to the bill. Measure it and scan its measured label. A quantity is never typed in.`;
    this.laneMessageTa = weighed
      ? `${description} எடைப்படி (${uom}) விற்கப்படுகிறது. அதன் பார்கோடு எவ்வளவு என்று சொல்லாது, எனவே பில்லில் சேர்க்கப்படவில்லை. சரிபார்க்கப்பட்ட தராசில் எடைபோட்டு, தராசின் லேபிளை ஸ்கேன் செய்யவும். எடையைக் கையால் உள்ளிட வேண்டாம்.`
      : `${description} அளவுப்படி (${uom}) விற்கப்படுகிறது. அதன் பார்கோடு எவ்வளவு என்று சொல்லாது, எனவே பில்லில் சேர்க்கப்படவில்லை. அளந்து, அதன் அளவு லேபிளை ஸ்கேன் செய்யவும். அளவைக் கையால் உள்ளிட வேண்டாம்.`;
  }
}

/**
 * OB-302 · B5 · OB-31 (Round B follow-up): a scale label this till cannot ring safely, refused by name and nothing added.
 *
 *  • `price_only_label_for_measured_item` — a label whose barcode carries only a PRICE, for a product sold by weight or
 *    volume (kg, g, L, ml). It says nothing about how much is in the pack, so the till could only ring it as one gram (a kg
 *    item at ₹765 rang as ₹0.77 — the customer under-charged and the stock ledger told 1 g left the shelf). Working a weight
 *    back from the price would be a guess whenever the scale's price per kg and the till's differ. Only a label carrying
 *    the WEIGHT is rung (the weight × the till's own price per kg, the B5 rule); a price-only label is refused.
 *  • `weight_label_for_counted_item` — a weight label for a product sold by the piece (`ea`): its grams would ring as that
 *    many pieces (850 g as 850 items). The product's unit or the label is wrong; refused until the office corrects it.
 *
 * A weight is never keyed instead (OB-302 "never key a weight"). Said in the cashier's words, English and Tamil.
 */
export class ScaleLabelRefusedError extends Error {
  readonly laneMessage: string;
  readonly laneMessageTa: string;
  constructor(
    public readonly productId: string,
    public readonly description: string,
    public readonly uom: string,
    public readonly reason: 'price_only_label_for_measured_item' | 'weight_label_for_counted_item',
  ) {
    super(reason === 'price_only_label_for_measured_item'
      ? `${description} is sold by ${uom}; this label carries only a price, not how much, so it was not added.`
      : `${description} is sold by the piece; this label carries a weight, so it was not added.`);
    this.name = 'ScaleLabelRefusedError';
    this.laneMessage = reason === 'price_only_label_for_measured_item'
      ? `${description} is sold by ${uom}. This label's barcode carries only a price, not the weight, so the till cannot ring it correctly and it was not added to the bill. Weigh it on a verified scale set to print the weight in the barcode, and scan that label. A weight is never typed in.`
      : `${description} is sold by the piece, but this label's barcode carries a weight, so it was not added to the bill. Scan the item's own barcode, and ask the office to check how this product is set up.`;
    this.laneMessageTa = reason === 'price_only_label_for_measured_item'
      ? `${description} ${uom} அளவில் விற்கப்படுகிறது. இந்த லேபிளின் பார்கோடில் விலை மட்டுமே உள்ளது, எடை இல்லை, எனவே சரியாகப் பில் போட முடியாது; பில்லில் சேர்க்கப்படவில்லை. பார்கோடில் எடையை அச்சிடும்படி அமைக்கப்பட்ட சரிபார்க்கப்பட்ட தராசில் எடைபோட்டு, அந்த லேபிளை ஸ்கேன் செய்யவும். எடையைக் கையால் உள்ளிட வேண்டாம்.`
      : `${description} ஒவ்வொன்றாக விற்கப்படுகிறது, ஆனால் இந்த லேபிளின் பார்கோடில் எடை உள்ளது, எனவே பில்லில் சேர்க்கப்படவில்லை. பொருளின் சொந்தப் பார்கோடை ஸ்கேன் செய்யவும்; இந்தப் பொருளின் அமைப்பைச் சரிபார்க்க அலுவலகத்திடம் சொல்லவும்.`;
  }
}

/**
 * OB-302 "never key a weight" (Round B follow-up): the cashier's Qty keypad on a line sold by weight or volume (kg, g, L, ml).
 * The keypad asked "Quantity" and took the number as GRAMS — "2" for 2 kg rang 2 g — and any number keyed there is a
 * weight typed by hand, which the owner ruled out. The line keeps the quantity its scale label gave it. For more of the
 * item, weigh it again and scan the new label; to take it off, void the line. Said in the cashier's words, English and Tamil.
 */
export class MeasuredLineQuantityRefusedError extends Error {
  readonly reason = 'measured_line_quantity_keyed' as const;
  readonly laneMessage: string;
  readonly laneMessageTa: string;
  constructor(public readonly description: string, public readonly uom: string) {
    super(`${description} is sold by ${uom}; its quantity cannot be keyed.`);
    this.name = 'MeasuredLineQuantityRefusedError';
    this.laneMessage = `${description} is sold by ${uom}, so its quantity comes only from the scale's label and cannot be typed in. Nothing was changed. For a different amount, weigh it again and scan the new label (void this line if it is wrong).`;
    this.laneMessageTa = `${description} ${uom} அளவில் விற்கப்படுகிறது, எனவே அதன் அளவு தராசின் லேபிளிலிருந்து மட்டுமே வரும்; கையால் உள்ளிட முடியாது. எதுவும் மாற்றப்படவில்லை. வேறு அளவுக்கு, மீண்டும் எடைபோட்டு புதிய லேபிளை ஸ்கேன் செய்யவும் (இந்த வரி தவறு என்றால் அதை ரத்து செய்யவும்).`;
  }
}

/**
 * OB-501 (R7-A · M33-FR-02): this till's app build is withdrawn or below the minimum supported version, so it may finish the
 * bill in progress but may not START a new one until it is updated. Said in the cashier's words, English and Tamil.
 */
export class NewBillRefusedError extends Error {
  constructor(public readonly laneMessage: string, public readonly laneMessageTa: string) {
    super(laneMessage);
    this.name = 'NewBillRefusedError';
  }
}

/**
 * The till sent the sale to its store computer and did not hear back (audit A8 · roadmap §32 "zero duplicate business
 * effect"): the reply was lost, or the box did not answer after the till's own same-id retries. The sale MAY be saved.
 *
 * It is neither a success nor a refusal, and the screen must treat it as neither: it does not say "saved", it does not
 * say "do not take money", and it does not let the sale be rung again. The session holds the exact record it sent and
 * re-sends it, under the SAME sale id, with `confirmPendingSale()` until the store computer answers — the box is
 * idempotent on the sale id (GAP-SALE-IDEMPOTENCY-01), so a re-send can never make a second sale. Only that answer says
 * "saved" or "not saved".
 */
export class SaleUnconfirmedError extends Error {
  constructor(public readonly saleId: string, public readonly number: string, public readonly laneMessage: string) {
    super(`sale ${saleId} could not be confirmed as saved yet: ${laneMessage}`);
    this.name = 'SaleUnconfirmedError';
  }
}

/** The words while a sale's answer is still awaited and something else is asked of the till (A8). */
const STILL_CHECKING = (number: string): string =>
  `Wait. The till is still checking with the store computer whether sale ${number} was saved. Do not ring it again and do not start another sale.`;

/**
 * Nobody is signed in at this till (SP-4b · F09 · §28 · hard rule #4). A sale with no cashier is a sale nobody can be
 * asked about, so it is refused BEFORE the money is taken — with the cashier's words, like every lane refusal.
 */
export class NoOperatorError extends Error {
  readonly laneMessage = 'Nobody is signed in at this till. Sign in with your staff ID and till PIN before taking payment.';
  constructor(action = 'take payment') {
    super(`Cannot ${action}: nobody is signed in at this till.`);
    this.name = 'NoOperatorError';
  }
}

/**
 * An age-restricted item was scanned and this basket holds no confirmed answer for that age (M12-FR-04 · Wave 2b PF-03).
 * The line is NOT added — "warned and sold" is the outcome to prevent — so the till asks the question and, on a yes,
 * scans again. Thrown, not returned, so a screen that has not learned to ask still refuses rather than sells.
 */
export class AgeCheckRequiredError extends Error {
  readonly laneMessage: string;
  constructor(public readonly productId: string, public readonly description: string, public readonly minimumAge: number) {
    super(`${description} is age restricted (${minimumAge}+) and the customer's age has not been checked.`);
    this.name = 'AgeCheckRequiredError';
    this.laneMessage = `${description} is age restricted. Check the customer's identification: they must be ${minimumAge} or over.`;
  }
}

/**
 * The commit's own check found an age-restricted line with no confirmed answer covering it (Wave 2b PF-03). Refused BEFORE
 * the disk and before the money — a second gate, because a rule enforced only at the door is a rule one new door away
 * from not being enforced at all.
 */
export class AgeCheckNotDoneError extends Error {
  readonly laneMessage: string;
  constructor(public readonly saleId: string, public readonly unchecked: readonly { readonly productId: string; readonly description: string; readonly minimumAge: number }[]) {
    super(`sale ${saleId}: ${unchecked.length} age-restricted line(s) have no confirmed age check.`);
    this.name = 'AgeCheckNotDoneError';
    const first = unchecked[0];
    this.laneMessage = `Do not take payment. ${first?.description ?? 'An item'} is age restricted and the customer's age has not been checked. Check their identification, or remove the item.`;
  }
}

/** This till has no lane id — the store box was never told which lane it is (SP-4b · F09). Refused before the money. */
export class NoLaneError extends Error {
  readonly laneMessage = 'This till has no lane id. Do not take money — ask the installer to set the lane on this store computer.';
  constructor(action = 'take payment') {
    super(`Cannot ${action}: this till has no lane id.`);
    this.name = 'NoLaneError';
  }
}

/**
 * Verifier r2final NEW-2: the bill's own arithmetic does not hold — a line would be recorded below zero (a negative
 * taxable value and negative GST), or the lines would not add up to what the customer pays. Refused BEFORE the disk and
 * before the money: such a bill cannot be filed. The promotions engine never produces one; this is the last check.
 */
export class BillArithmeticError extends Error {
  readonly laneMessage = 'Do not take payment. This bill does not add up (an offer would take a line below zero). Nothing was saved. Remove the offer line and tell the manager.';
  constructor(public readonly saleId: string, public readonly detail: string) {
    super(`sale ${saleId}: ${detail}`);
    this.name = 'BillArithmeticError';
  }
}

export class PosSession {
  private readonly lines: BasketEntry[] = [];
  private seq = 0;
  /** B13: the HUIDs this till has committed since it loaded — refused again at once, offline. */
  private readonly huidsSoldHere = new Set<string>();
  /** B13 · M31-FR-02: the bill of the sale this till last committed — what its receipt prints. */
  private lastBillValue: CommittedBill | undefined;

  /** The bill of the last sale this till committed (kept until the next one commits), or undefined before the first. */
  lastBill(): CommittedBill | undefined {
    return this.lastBillValue;
  }
  private state: PosState = 'idle';
  private connection: ConnectionState = 'online';
  private promotions: readonly Promotion[] = [];
  /** OB-403 "A" · §31.1: while the store computer's clock is 5+ minutes out, no offer starting after this instant applies. */
  private offerHoldCutoff: string | null = null;
  private refusedOfferList: readonly RefusedOffer[] = [];
  /** The cashier who signed in at this till (SP-4b) — over the configured one, when both exist. */
  private operatorId: string | undefined;
  /** Every answer to the age question for THIS basket, in order (PF-03). Cleared with the basket, kept across hold/recall. */
  private readonly ageAnswerLog: AgeAnswer[] = [];
  /** B8: every answer to the pack-date question for THIS basket, in order — refusals included (evidence). */
  private readonly packDateLog: PackDateAnswer[] = [];
  /** B8: a confirmed pack date waiting for its line — used by the next scan of that product, then gone (one tap, one line). */
  private readonly packDatePending = new Map<string, PackDateAnswer>();
  /** The loyalty member's mobile number for THIS bill (PF-09 step 2 · OB-28 "1"). Held in memory only and handed to the
   *  store computer with the sale, which turns it into the member code before anything is written — never on a disk here. */
  private loyaltyMobile: string | undefined;
  /** This basket's own reference (audit PF-06): the bill a card/UPI attempt is recorded against, until the next sale. */
  private billRefValue: string | undefined;
  /** OB-352: how the last saved delivery bill gets its address and slot, and its slip. */
  private lastSlipValue: Omit<DeliverySlip, 'lines'> | undefined;
  /** OB-352: what the store computer said about the bill being saved now (customer app or delivery desk). */
  private pendingDeliveryPath: 'customer_app' | 'delivery_desk' | undefined;
  /** OB-299: the bill is marked for delivery — the fee line added for it (by its line id). */
  private deliveryMark: { readonly feeProductId: string; readonly feeLineId: string } | undefined;
  /** Evaluation instant for effective-dated promotions, when the caller fixed one (`setNow`); else the lane's clock. */
  private nowRef: string | undefined;
  /**
   * A sale sent to the store computer whose answer was lost (audit A8): the EXACT record that was sent (so a re-send hashes
   * the same on the box), what to do once the box says it is saved, and the state to go back to if the box says it is not.
   */
  private awaiting: { readonly saleId: string; readonly number: string; readonly record: string; readonly finish: () => CommittedSale; readonly before: PosState } | undefined;

  constructor(
    private readonly config: PosSessionConfig,
    private readonly stockLedger: Ledger,
    private readonly outbox: SyncOutbox,
    /**
     * The durable local write — the edge's disk.
     *
     * **Hard rule #1 says commit locally first, and until this existed `commit()` did not.** It
     * priced, settled, appended to an in-memory ledger and queued to an in-memory outbox, all
     * correctly and all in memory: nothing reached a disk, so a lane that lost power between the
     * sale and the next sync lost the sale. The docstring on `commit` already said *"commit the
     * sale LOCALLY (hard rule #1)"* and the function did not do it, which is the most expensive
     * kind of comment.
     *
     * It is a port so the session stays testable without a filesystem, and `commit` is
     * **asynchronous because of it** — the one thing a sale is allowed to wait for. Awaiting a
     * local fsync is not awaiting the network, and the original "synchronous by construction"
     * comment conflated the two.
     *
     * **Required, not optional.** An optional durable write is one a deployment can forget, and
     * forgetting it is invisible: the lane sells, the screen says "Sale complete", and the sales
     * are in memory. Today has been spent finding controls that were present in a type and absent
     * in the running system, so this one sits in the constructor where it cannot be left out.
     */
    private readonly durable: (saleId: string, record: string) => Promise<CommitOutcome>,
  ) {}

  /** The current screen state (§27.1). */
  currentState(): PosState {
    return this.state;
  }

  /** The sale still waiting for the store computer's answer (A8) — its id and bill number — or undefined. */
  pendingSale(): { readonly saleId: string; readonly number: string } | undefined {
    return this.awaiting === undefined ? undefined : { saleId: this.awaiting.saleId, number: this.awaiting.number };
  }

  /** Refuse anything that would change the basket or start another sale while a sale's answer is awaited (A8). */
  private notWhileAwaiting(): void {
    if (this.awaiting !== undefined) {
      throw new SaleUnconfirmedError(this.awaiting.saleId, this.awaiting.number, STILL_CHECKING(this.awaiting.number));
    }
  }

  /**
   * Ask the store computer again about the sale whose answer was lost (A8), by re-sending the SAME record under the SAME
   * sale id. Resolves the committed sale when the box says it is saved (a re-send of a saved sale is answered "saved",
   * never saved twice); throws `LocalCommitRefusedError` when the box says it is not saved (the basket is back as it was);
   * throws `SaleUnconfirmedError` again while the box still does not answer.
   */
  async confirmPendingSale(): Promise<CommittedSale> {
    const pending = this.awaiting;
    if (pending === undefined) throw new SessionStateError('check a sale that is not waiting', this.state);
    const outcome = await this.durable(pending.saleId, pending.record);
    if (outcome.committed) {
      this.awaiting = undefined;
      this.pendingDeliveryPath = outcome.deliveryPath;
      return pending.finish();
    }
    if (outcome.unconfirmed === true) throw new SaleUnconfirmedError(pending.saleId, pending.number, outcome.laneMessage);
    this.awaiting = undefined;
    this.state = pending.before;
    throw new LocalCommitRefusedError(pending.saleId, outcome.laneMessage, outcome);
  }

  /** Set the connection state shown on the badge (the lane observes it; sales never wait on it). */
  setConnection(connection: ConnectionState): void {
    this.connection = connection;
  }

  /** The permanent sync badge: connection + unsent count (§27.1 / P-08). */
  syncBadge(): SyncBadge {
    return { connection: this.connection, unsentCount: this.outbox.unsentCount() };
  }

  /**
   * Load the approved promotion pack (from the signed local cache — §31). NEW-1 (B19): an offer that names a carry bag
   * among its products is REFUSED here — a bag is a priced line, never given away by an offer — and kept on
   * `refusedOffers()` so the lane can say so. Head office refuses such an offer when it is defined; this is the till's own
   * check for a pack built before that, or a product that became a carry bag afterwards.
   */
  loadPromotions(promotions: readonly Promotion[]): void {
    const refused: RefusedOffer[] = [];
    this.promotions = promotions.filter((p) => {
      // Every product the offer names — its own list, a bundle-price set and both sides of a mix-match (B15 · B19).
      const named = promotionProductIds(p);
      // B15 (COTPA s.5): an offer that names a tobacco product is refused whole — the same rule head office applies when an
      // offer is defined, asked again here of the lane's own signed pack (a product may have become tobacco since).
      const tobacco = tobaccoAdvertisingRefusal('promotion', named, (id) => tillRuleFlagsOf(this.config.regulatedFlagsOf?.(id)).tobacco === true);
      if (tobacco !== undefined) {
        refused.push({
          offerId: p.id, carryBags: [], tobaccoProductIds: tobacco.tobaccoProductIds,
          laneMessage: `Offer ${p.id} names tobacco (${tobacco.tobaccoProductIds.join(', ')}), so this till does not apply it — tobacco may not be promoted. Tell the manager.`,
        });
        return false;
      }
      const bags = named.filter((id) => tillRuleFlagsOf(this.config.regulatedFlagsOf?.(id)).carryBag === true);
      if (bags.length === 0) return true;
      refused.push({
        offerId: p.id, carryBags: bags,
        laneMessage: `Offer ${p.id} names a carry bag (${bags.join(', ')}), so this till does not apply it — a bag is always sold at its price. Tell the manager.`,
      });
      return false;
    });
    this.refusedOfferList = refused;
  }

  /** NEW-1 (B19): the offers this till refused to apply because they target a carry bag. */
  refusedOffers(): readonly RefusedOffer[] {
    return this.refusedOfferList.slice();
  }

  /**
   * OB-501 (R7-A): stop (words) or allow (null) STARTING new bills on this till — the build check, made by the caller from the
   * signed pack. A bill already on the till is never stopped: only the first line of a new bill is refused.
   */
  barNewBills(words: { readonly en: string; readonly ta: string } | null): void {
    this.newBillBar = words;
  }

  private newBillBar: { readonly en: string; readonly ta: string } | null = null;

  /** Scan an item onto the basket — 1 interaction (design bar). */
  scan(input: ScanInput): BasketEntry {
    this.notWhileAwaiting();
    // OB-501: a new bill is refused on a withdrawn or too-old build; a bill in progress (any line on it) is finished.
    if (this.newBillBar !== null && this.lines.length === 0) throw new NewBillRefusedError(this.newBillBar.en, this.newBillBar.ta);
    if (this.state === 'committed' || this.state === 'suspended') {
      throw new SessionStateError('scan', this.state);
    }
    // B6 · B14 · B19 — what the law forbids selling at all is refused FIRST, before any age question: a banned plastic,
    // a thin or free carry bag, a loose cigarette, or weight from a scale whose stamp has lapsed. No override exists.
    const regulatedFlags = input.regulatedFlags ?? this.config.regulatedFlagsOf?.(input.productId);
    const catalogueUom = this.config.baseUomOf?.(input.productId);
    // B17 · OB-348: the HSN the line is sold under — the lane's pack first, else what the scan carried.
    const hsnCode = this.config.hsnCodeOf?.(input.productId) ?? input.hsnCode;
    const refusals = tillLineRefusals({
      productId: input.productId, description: input.description, quantityMinor: input.quantityMinor, uom: input.uom,
      unitPriceMinor: input.unitPrice.minor, ...(regulatedFlags === undefined ? {} : { regulatedFlags }),
      ...(catalogueUom === undefined ? {} : { catalogueUom }),
      ...(hsnCode === undefined ? {} : { hsnCode }),
    }, this.gateContext(this.nowIso()));
    if (refusals.length > 0) throw new TillRuleRefusedError(refusals);
    // An age-restricted item joins the basket only behind a confirmed answer for at least its age (PF-03). Tobacco needs
    // at least 18, whatever the scan said (B14).
    const minimumAge = tobaccoAge(validAge(input.minimumAge), regulatedFlags);
    if (minimumAge !== undefined && this.ageConfirmedAtLeast() < minimumAge) {
      throw new AgeCheckRequiredError(input.productId, input.description, minimumAge);
    }
    // B8 (OB-298): a perishable whose barcode carried no date joins the bill only after the cashier confirmed the date on
    // the pack — one tap for this line. A barcode that carried its date was judged by the catalogue already (no tap).
    let packDateCheck: PackDateCheck | undefined;
    if (tillRuleFlagsOf(regulatedFlags).perishable === true && input.batchExpiry === undefined) {
      const pending = this.packDatePending.get(input.productId);
      if (pending === undefined) throw new PackDateCheckRequiredError(input.productId, input.description);
      this.packDatePending.delete(input.productId);
      packDateCheck = { confirmedBy: pending.by, confirmedAt: pending.at };
    }
    this.seq += 1;
    const entry: BasketEntry = Object.freeze({
      lineId: `L${this.seq}`,
      productId: input.productId,
      description: input.description,
      unitPrice: input.unitPrice,
      quantityMinor: input.quantityMinor,
      uom: input.uom,
      taxRate: input.taxRate ?? this.config.defaultTaxRate,
      ...(input.hsnCode !== undefined ? { hsnCode: input.hsnCode } : {}),
      group: input.group,
      ...(minimumAge === undefined ? {} : { minimumAge }),
      ...(regulatedFlags === undefined ? {} : { regulatedFlags }),
      ...(input.batchId === undefined ? {} : { batchId: input.batchId }),
      ...(input.batchExpiry === undefined ? {} : { batchExpiry: input.batchExpiry }),
      ...(packDateCheck === undefined ? {} : { packDateCheck }),
      ...((): { cess?: CessRate } => { const c = readCessRate(this.config.cessOf?.(input.productId) ?? input.cess); return c === undefined ? {} : { cess: c }; })(),
      voided: false,
    });
    this.lines.push(entry);
    this.state = 'selling';
    return entry;
  }

  /**
   * The cashier checked the customer's identification and they ARE at least `minimumAge` (PF-03). Recorded in the
   * basket in the signed-in person's name; refused when nobody is signed in — an answer in nobody's name is no answer.
   */
  confirmAge(minimumAge: number, atIsoUtc: string, productId?: string): AgeAnswer {
    this.notWhileAwaiting();
    return this.answerAge('confirmed', minimumAge, atIsoUtc, productId);
  }

  /** The customer could not show they are old enough: the item is NOT sold, and that is kept as evidence (PF-03, M15). */
  refuseAge(minimumAge: number, atIsoUtc: string, productId?: string): AgeAnswer {
    this.notWhileAwaiting();
    return this.answerAge('refused', minimumAge, atIsoUtc, productId);
  }

  /**
   * B8 (OB-298): the cashier looked at the date printed on this perishable's pack and it is still good — one tap. Recorded
   * in the signed-in person's name; the next scan of the product adds its line with this confirmation on it.
   */
  confirmPackDate(productId: string, atIsoUtc: string): PackDateAnswer {
    this.notWhileAwaiting();
    return this.answerPackDate('in_date', productId, atIsoUtc);
  }

  /** B8: the date on the pack has passed — the item is NOT sold, and that is kept as evidence. */
  refusePackDate(productId: string, atIsoUtc: string): PackDateAnswer {
    this.notWhileAwaiting();
    return this.answerPackDate('out_of_date', productId, atIsoUtc);
  }

  /** Every answer to the pack-date question for this basket, in order (B8). */
  packDateAnswers(): readonly PackDateAnswer[] {
    return this.packDateLog.slice();
  }

  private answerPackDate(outcome: PackDateAnswer['outcome'], productId: string, atIsoUtc: string): PackDateAnswer {
    if (this.state === 'committed' || this.state === 'suspended') throw new SessionStateError('answer the pack-date check', this.state);
    if (productId.trim() === '') throw new RangeError('The pack-date check needs the product it is for.');
    const by = this.operator();
    if (by === undefined) throw new NoOperatorError('answer the pack-date check');
    const answer: PackDateAnswer = Object.freeze({ productId, outcome, by, at: atIsoUtc });
    this.packDateLog.push(answer);
    if (outcome === 'in_date') this.packDatePending.set(productId, answer);
    else this.packDatePending.delete(productId);
    return answer;
  }

  private answerAge(outcome: AgeAnswer['outcome'], minimumAge: number, atIsoUtc: string, productId?: string): AgeAnswer {
    if (this.state === 'committed' || this.state === 'suspended') {
      throw new SessionStateError('answer the age check', this.state);
    }
    const age = validAge(minimumAge);
    if (age === undefined) throw new RangeError(`A minimum age must be a positive whole number of years, got ${minimumAge}.`);
    const by = this.operator();
    if (by === undefined) throw new NoOperatorError('answer the age check');
    const answer: AgeAnswer = Object.freeze({ minimumAge: age, outcome, by, at: atIsoUtc, ...(productId === undefined ? {} : { productId }) });
    this.ageAnswerLog.push(answer);
    return answer;
  }

  /** The highest age this basket's customer has been CONFIRMED to be — 0 when nobody has checked (PF-03). */
  ageConfirmedAtLeast(): number {
    return this.ageAnswerLog.reduce((most, a) => (a.outcome === 'confirmed' && a.minimumAge > most ? a.minimumAge : most), 0);
  }

  /** Every age answer given for this basket, in order. */
  ageAnswers(): readonly AgeAnswer[] {
    return this.ageAnswerLog.slice();
  }

  /** The confirmed answer that covers a line needing `minimumAge` — the lowest confirmed age at or above it. */
  private confirmationFor(minimumAge: number): AgeAnswer | undefined {
    return this.ageAnswerLog
      .filter((a) => a.outcome === 'confirmed' && a.minimumAge >= minimumAge)
      .sort((a, b) => a.minimumAge - b.minimumAge)[0];
  }

  /** The basket as shown on screen (voided lines retained, marked — never erased). */
  basket(): readonly BasketEntry[] {
    return this.lines.slice();
  }

  /**
   * What one line charges, in minor units: the unit price times the quantity, as the totals price it (a weighed line is
   * its weight times the price per kg, rounded down). Before any offer — the offer's discount is shown on its own.
   */
  lineAmountMinor(line: BasketEntry): number {
    return this.priceOf(line).total.minor;
  }

  /** Lines that count toward the total (not voided). */
  private activeLines(): BasketEntry[] {
    return this.lines.filter((l) => !l.voided);
  }

  private replace(lineId: string, next: BasketEntry): void {
    const index = this.lines.findIndex((l) => l.lineId === lineId);
    if (index < 0) {
      throw new NoSuchLineError(lineId);
    }
    this.lines[index] = next;
  }

  /** Change a line's quantity — ≤ 3 interactions (design bar). */
  setQuantity(lineId: string, quantityMinor: number): BasketEntry {
    this.notWhileAwaiting();
    const line = this.lines.find((l) => l.lineId === lineId);
    if (line === undefined) {
      throw new NoSuchLineError(lineId);
    }
    if (!Number.isSafeInteger(quantityMinor) || quantityMinor <= 0) {
      throw new RangeError(`Quantity must be a positive integer, got ${quantityMinor}.`);
    }
    // OB-500: a manager approved a price cut for THIS quantity — the rupees it takes off the line. A new quantity would
    // multiply that cut with no new approval, so it is refused; the cashier voids the line and rings it again.
    if (line.priceOverride !== undefined && quantityMinor !== line.quantityMinor) throw new CutLineQuantityRefusedError(line.description);
    // A new quantity is judged like a new scan (B6 · B14): a loose-cigarette count, or a weight keyed on a lane whose
    // scale has lapsed, is refused and the line keeps the quantity it had.
    const refusals = this.lineRefusals({ ...line, quantityMinor }, this.nowIso());
    if (refusals.length > 0) throw new TillRuleRefusedError(refusals);
    const next: BasketEntry = Object.freeze({ ...line, quantityMinor });
    this.replace(lineId, next);
    return next;
  }

  /**
   * Void a line before the sale is committed. The line is MARKED voided with a
   * reason and kept on the bill (never erased), so voids are visible to loss
   * prevention (M15-FR-01).
   */
  voidLine(lineId: string, reason: string): BasketEntry {
    this.notWhileAwaiting();
    const line = this.lines.find((l) => l.lineId === lineId);
    if (line === undefined) {
      throw new NoSuchLineError(lineId);
    }
    if (reason.trim() === '') {
      throw new VoidReasonRequiredError(lineId);
    }
    const next: BasketEntry = Object.freeze({ ...line, voided: true, voidReason: reason });
    this.replace(lineId, next);
    return next;
  }

  /**
   * What lowering a line's unit price to `toUnitMinor` would take off the line, priced exactly as the line is priced
   * (weighed goods included) — the value a manager approves and loss prevention judges (audit PF-07).
   *
   * OB-500: measured from the line's FIRST price (the price it was rung at, before any cut), never from a price already
   * cut — so a second cut on the same line is judged on everything taken off it, and two ₹90 cuts are ₹180, not ₹90 twice.
   */
  overrideValue(lineId: string, toUnitMinor: number): { readonly fromUnitMinor: number; readonly reductionMinor: number } {
    const line = this.lines.find((l) => l.lineId === lineId && !l.voided);
    if (line === undefined) throw new NoSuchLineError(lineId);
    if (!Number.isSafeInteger(toUnitMinor) || toUnitMinor < 0 || toUnitMinor >= line.unitPrice.minor) {
      throw new RangeError(`A till price change only lowers a price: ${toUnitMinor} is not below ${line.unitPrice.minor}.`);
    }
    // B19: a carry bag stays a PRICED line — no approval can make it free. Asked here, before any approval is spent.
    const refusals = this.lineRefusals({ ...line, unitPrice: money(toUnitMinor, line.unitPrice.currency) }, this.nowIso(), undefined, line.priceOverride?.fromUnitMinor ?? line.unitPrice.minor);
    if (refusals.length > 0) throw new TillRuleRefusedError(refusals);
    const firstUnitMinor = line.priceOverride?.fromUnitMinor ?? line.unitPrice.minor;
    const before = this.priceOf({ ...line, unitPrice: money(firstUnitMinor, line.unitPrice.currency) }).total.minor;
    const after = this.priceOf({ ...line, unitPrice: money(toUnitMinor, line.unitPrice.currency) }).total.minor;
    return { fromUnitMinor: firstUnitMinor, reductionMinor: before - after };
  }

  /**
   * Lower a line's price — ONLY once the store computer holds the approved change as evidence (the caller's job, audit
   * PF-07). The line keeps where the price came from and who approved it; the sale record carries both.
   */
  overridePrice(lineId: string, toUnitMinor: number, evidence: { readonly approvedBy: string; readonly activityId: string; readonly quotationId?: string }): BasketEntry {
    this.notWhileAwaiting();
    // The line's first price — kept through every later cut, so the sale record and head office see the whole cut.
    const { fromUnitMinor } = this.overrideValue(lineId, toUnitMinor);
    const line = this.lines.find((l) => l.lineId === lineId)!;
    const next: BasketEntry = Object.freeze({
      ...line, unitPrice: money(toUnitMinor, line.unitPrice.currency),
      priceOverride: { fromUnitMinor, approvedBy: evidence.approvedBy, activityId: evidence.activityId, ...(evidence.quotationId === undefined ? {} : { quotationId: evidence.quotationId }) },
    });
    this.replace(lineId, next);
    return next;
  }

  /**
   * OB-506 (owner, 28 Oct 2026): RAISE a line to the price a quotation promised, when that is higher than the till's price —
   * the only way a till raises a price. Never above the line's MRP as the lane's own signed pack carries it (Legal Metrology
   * · A9): above it, or with no MRP known, the line is refused in words (`QuotedPriceRefusedError`) and keeps its price. The
   * line records where the price came from — the quotation's number — so head office's sale check sees why.
   */
  chargeQuotedPrice(lineId: string, toUnitMinor: number, quotationId: string): BasketEntry {
    this.notWhileAwaiting();
    const line = this.lines.find((l) => l.lineId === lineId && !l.voided);
    if (line === undefined) throw new NoSuchLineError(lineId);
    if (!Number.isSafeInteger(toUnitMinor) || toUnitMinor <= line.unitPrice.minor) {
      throw new RangeError(`A quoted price is raised to only when it is above the till's price: ${toUnitMinor} is not above ${line.unitPrice.minor}.`);
    }
    const id = quotationId.trim();
    if (id === '') throw new RangeError('A raised price names the quotation it came from.');
    const mrp = this.config.mrpOf?.(line.productId);
    if (mrp === undefined || !Number.isSafeInteger(mrp)) throw new QuotedPriceRefusedError('mrp_not_known', quotedPriceRefusal('mrp_not_known', toUnitMinor));
    if (toUnitMinor > mrp) throw new QuotedPriceRefusedError('quoted_above_mrp', quotedPriceRefusal('quoted_above_mrp', toUnitMinor, mrp));
    const first = line.priceOverride?.fromUnitMinor ?? line.unitPrice.minor;
    const raised: BasketEntry = { ...line, unitPrice: money(toUnitMinor, line.unitPrice.currency) };
    const refusals = this.lineRefusals(raised, this.nowIso(), undefined, Math.max(first, toUnitMinor));
    if (refusals.length > 0) throw new TillRuleRefusedError(refusals);
    const next: BasketEntry = Object.freeze({
      ...raised,
      priceOverride: { fromUnitMinor: first, approvedBy: `quotation ${id}`, activityId: `quotation:${id}`, quotationId: id },
    });
    this.replace(lineId, next);
    return next;
  }

  /**
   * Price ONE line the way a retail till prices: the catalogue's unit price is the shelf price, GST already inside
   * it (Legal Metrology: the MRP or below, tax included — roadmap A9), so the customer pays price × quantity and the
   * taxable value and the GST are pulled OUT of that amount. The till never adds tax on top of a shelf price: that
   * charged ₹504 against a ₹500 MRP (audit finding F15, M05-FR-02) and disagreed with the day book and the GST
   * return, which already read every line total as inclusive. Both the running total and the lines the cloud sees
   * go through here, so the two cannot differ.
   */
  private priceOf(l: BasketEntry): LinePricing {
    return priceLine({
      unitPrice: l.unitPrice,
      quantity: quantity(l.quantityMinor, l.uom),
      taxRate: l.taxRate,
      pricesIncludeTax: true,
      // B5: the amount is the weighed net quantity × the displayed price per kg, and a fraction of a paisa goes the
      // CUSTOMER's way — never rounded up against them. (An `ea` line is a whole number of units, so nothing rounds.)
      quantityRounding: 'down',
    });
  }

  /**
   * Today at this lane, in its own wall clock (YYYY-MM-DD) — what a scanned batch's use-by date is judged against (B8 ·
   * D-20). The calendar day, not the shop's trading day: a pack past its use-by at 1 a.m. is past it. Undefined when the
   * clock cannot be read; the scan then cannot judge the date and does not guess.
   */
  laneToday(): string | undefined {
    try { return tradingDateOf(this.nowIso(), makeTradingDayRule('00:00'), this.config.timeZone); } catch { return undefined; }
  }

  /** The lane's own clock now, as ISO UTC (the fixed instant `setNow` gave, else the lane's clock, else the machine's). */
  private nowIso(): string {
    return this.nowRef ?? this.config.clock?.() ?? new Date().toISOString();
  }

  /**
   * The gate's view of this lane at a moment: its scales, the lane's LOCAL calendar date (B6 · B16), and the HUIDs already
   * sold — by this store, by this till since it loaded, and on this bill's OTHER lines (B13). `exceptLineId` is the line
   * being judged, so a gold line never counts against itself.
   */
  private gateContext(atIsoUtc: string, exceptLineId?: string): TillGateContext {
    let today: string | undefined;
    try { today = tradingDateOf(atIsoUtc, makeTradingDayRule('00:00'), this.config.timeZone); } catch { today = undefined; }
    const sold = new Set<string>([...(this.config.soldHuids?.() ?? []), ...this.huidsSoldHere]);
    for (const l of this.activeLines()) {
      if (l.lineId === exceptLineId) continue;
      const huid = huidOf(this.flagsOf(l));
      if (huid !== undefined) sold.add(huid);
    }
    return {
      ...(this.config.laneScales === undefined ? {} : { scales: this.config.laneScales }), ...(today === undefined ? {} : { today }), soldHuids: sold,
      ...(this.config.shopState === undefined ? {} : { shopState: this.config.shopState }),
    };
  }

  /** OB-306: the explosion a line carries when its product is a bundle in the lane's signed pack (whole bundles only). */
  private bundleOfLine(l: Pick<BasketEntry, 'productId' | 'quantityMinor'>): LineBundle | undefined {
    const def = this.config.bundleOf?.(l.productId);
    return def === undefined ? undefined : lineBundleOf(def, l.quantityMinor, (id) => this.config.baseUomOf?.(id));
  }

  /**
   * The lines the till's own stock ledger moves: each line as rung, except a bundle line, which moves its components (the
   * bundle holds no stock — OB-306). One line per product and unit, so a component also rung on its own is counted once.
   */
  private stockLines(active: readonly BasketEntry[]): readonly { readonly productId: string; readonly quantityMinor: number; readonly uom: string }[] {
    const merged = new Map<string, { productId: string; quantityMinor: number; uom: string }>();
    const add = (productId: string, quantityMinor: number, uom: string): void => {
      const key = `${productId}\u001f${uom}`;
      const cur = merged.get(key);
      if (cur === undefined) merged.set(key, { productId, quantityMinor, uom }); else cur.quantityMinor += quantityMinor;
    };
    for (const l of active) {
      const b = this.bundleOfLine(l);
      if (b === undefined) { add(l.productId, l.quantityMinor, l.uom); continue; }
      for (const c of b.components) add(c.productId, c.quantityMinor, c.uom ?? 'ea');
    }
    // Without a bundle on the bill the lines are exactly as rung (one per line), as they always were.
    return active.some((l) => this.bundleOfLine(l) !== undefined) ? [...merged.values()]
      : active.map((l) => ({ productId: l.productId, quantityMinor: l.quantityMinor, uom: l.uom }));
  }

  /** The flags a line is judged by: the lane's signed pack first, else what the scan carried (B14 · B19). */
  private flagsOf(l: Pick<BasketEntry, 'productId' | 'regulatedFlags'>): Readonly<Record<string, unknown>> | undefined {
    return this.config.regulatedFlagsOf?.(l.productId) ?? l.regulatedFlags;
  }

  /** A7: the cess a line is charged — the lane's signed pack first, else what the scan carried. */
  private cessOfLine(l: Pick<BasketEntry, 'productId' | 'cess'>): CessRate | undefined {
    return readCessRate(this.config.cessOf?.(l.productId) ?? l.cess);
  }

  private lineRefusals(l: BasketEntry, atIsoUtc: string, chargedMinor?: number, listUnitMinor?: number): ReturnType<typeof tillLineRefusals> {
    const regulatedFlags = this.flagsOf(l);
    const catalogueUom = this.config.baseUomOf?.(l.productId);
    // OB-173: the line's list price is its price before any change at the till — a bag lowered at the till is refused.
    const list = listUnitMinor ?? l.priceOverride?.fromUnitMinor;
    // B17 · OB-348: the line's HSN from the lane's pack first, else the one it was scanned under.
    const hsnCode = this.config.hsnCodeOf?.(l.productId) ?? l.hsnCode;
    return tillLineRefusals({
      productId: l.productId, description: l.description, quantityMinor: l.quantityMinor, uom: l.uom,
      unitPriceMinor: l.unitPrice.minor, ...(regulatedFlags === undefined ? {} : { regulatedFlags }),
      ...(list === undefined ? {} : { listUnitPriceMinor: list }),
      ...(chargedMinor === undefined ? {} : { chargedMinor }),
      ...(catalogueUom === undefined ? {} : { catalogueUom }),
      ...(hsnCode === undefined ? {} : { hsnCode }),
    }, this.gateContext(atIsoUtc, l.lineId));
  }

  /** Whether a line is sold by weight (B6): its own unit, or its product's unit in the lane's pack (NEW-2). */
  private weighed(l: Pick<BasketEntry, 'productId' | 'uom'>): boolean {
    const catalogueUom = this.config.baseUomOf?.(l.productId);
    return lineIsWeighed({ uom: l.uom, ...(catalogueUom === undefined ? {} : { catalogueUom }) });
  }

  /** Price every active line (exact, weighed goods included). */
  private pricedLines(): LinePricing[] {
    return this.activeLines().map((l) => this.priceOf(l));
  }

  /**
   * The active basket as a REPLACEMENT on an exchange (SP-9b-ii · M13-FR-03): each line as rung — unit price, quantity,
   * the promotion discount attributed to it and what it actually charged — so the exchange engine can check the goods
   * going out against the credit for the goods coming back with the same arithmetic the sale record will carry.
   */
  replacementLines(): readonly { readonly productId: string; readonly uom: string; readonly quantityMinor: number; readonly unitPriceMinor: number; readonly lineTotalMinor: number; readonly discountMinor?: number }[] {
    const perLineDiscount = this.promotionDiscountByLine();
    return this.activeLines().map((l) => {
      const discountMinor = perLineDiscount.get(l.lineId) ?? 0;
      return {
        productId: l.productId, uom: l.uom, quantityMinor: l.quantityMinor,
        unitPriceMinor: l.unitPrice.minor,
        lineTotalMinor: this.priceOf(l).total.minor - discountMinor,
        ...(discountMinor > 0 ? { discountMinor } : {}),
      };
    });
  }

  /** The running total shown on screen — the largest element on the Sale screen. */
  totals(): BasketTotals {
    const currency = this.config.currency;
    const bill = sumLines(this.pricedLines(), currency);
    const promotionDiscount = this.promotionDiscount();
    const goods = Math.max(0, bill.total.minor - promotionDiscount.minor);
    // OB-279 · A10: in real trading the bill's CGST and SGST are each rounded to the rupee and the bill's total is the
    // rounded total — OB-285: never above the lines' exact MRP-based total — so the customer is asked for exactly what the
    // tax invoice will say, and never more than the goods. Off real trading: nothing changed.
    const active = this.activeLines();
    const roundOff = this.config.realTrading === undefined || goods === 0 ? undefined
      : invoiceRoundOff(this.replacementLines().map((l, i) => {
        const cess = active[i] === undefined ? undefined : this.cessOfLine(active[i]);
        return { lineTotalMinor: l.lineTotalMinor, taxRateBps: active[i]?.taxRate.bps ?? 0, quantityMinor: l.quantityMinor, ...(cess === undefined ? {} : { cess }) };
      })).totalLessGoodsMinor;
    return {
      ...bill,
      promotionDiscount,
      payable: money(goods + (roundOff ?? 0), currency),
      lineCount: this.activeLines().length,
      ...(roundOff === undefined ? {} : { roundOffMinor: roundOff }),
    };
  }

  /**
   * OB-403 "A" · §31.1: the store computer says its clock is 5+ minutes out — apply no offer that starts after `cutoffAt`
   * (null: nothing held). The offers stay loaded, so the moment the hold lifts they apply again (nothing is lost).
   */
  holdOffersStartingAfter(cutoffAt: string | null): void {
    this.offerHoldCutoff = typeof cutoffAt === 'string' && !Number.isNaN(Date.parse(cutoffAt)) ? cutoffAt : null;
  }

  /** OB-403: the loaded offers this till is not applying now because the store computer's clock is out. */
  heldOffers(): readonly string[] {
    return this.promotions.filter((p) => !this.offerInForce(p)).map((p) => p.id);
  }

  private offerInForce(p: Promotion): boolean {
    if (this.offerHoldCutoff === null) return true;
    const starts = Date.parse(p.startsAt);
    return !Number.isNaN(starts) && starts <= Date.parse(this.offerHoldCutoff);
  }

  /** The deterministic best-price result for the current basket, or null when no promotion is loaded. */
  private promotionResult(): PromotionResult | null {
    const offers = this.promotions.filter((p) => this.offerInForce(p));
    if (offers.length === 0) return null;
    const basket: BasketLine[] = this.activeLines().map((l) => ({
      lineId: l.lineId,
      productId: l.productId,
      unitPrice: l.unitPrice,
      // Promotions count whole sellable units; a weighed line counts as one unit.
      qty: l.uom === 'ea' ? l.quantityMinor : 1,
      // Verifier r2final NEW-2: the line's ACTUAL gross (a weighed line: weight × price per kg, as charged) — the cap, the
      // minimum spend and the spread all read this, never the per-kg price as if a whole kilo were sold.
      lineTotal: this.priceOf(l).total,
      group: l.group,
      // OB-173 (owner, 17 Oct 2026, "Never discount bags"): no offer reaches a carry bag — not a basket-wide one, not a
      // category one — so it is charged its full price and the discount is spread over the other lines only.
      ...(tillRuleFlagsOf(this.flagsOf(l)).carryBag === true ? { carryBag: true } : {}),
      // B15 (COTPA s.5 · OB-288 till side): no offer reaches a tobacco line — not a basket-wide one either. It is charged its
      // price and any basket discount is spread over the other lines only.
      ...(tillRuleFlagsOf(this.flagsOf(l)).tobacco === true ? { tobacco: true } : {}),
    }));
    const at = this.nowRef ?? this.config.clock?.() ?? '1970-01-01T00:00:00Z';
    // OB-305 · OB-349: bank-card offers stay OFF until R4 (certified integrated card terminals) — the till never passes
    // `bankOffersOn` or a card issuer, so a bank offer computes nothing here (`BANK_OFFERS_RELEASE`).
    return bestPrice(basket, offers, { at, currency: this.config.currency });
  }

  /** Deterministic promotion discount for the basket (M05-FR-03), or zero. */
  private promotionDiscount(): Money {
    const result = this.promotionResult();
    return result === null ? money(0, this.config.currency) : result.discount;
  }

  /** The promotion discount ATTRIBUTED to each active line (keyed by lineId), so a targeted promotion
   *  reduces only the lines it applied to — the per-line taxable value the GST return needs (CGST s.15(3)). */
  private promotionDiscountByLine(): ReadonlyMap<string, number> {
    const result = this.promotionResult();
    const map = new Map<string, number>();
    if (result !== null) for (const p of result.perLine) map.set(p.lineId, p.discountMinor);
    return map;
  }

  /** Set the evaluation instant used for effective-dated promotions. */
  /** A cashier signs in with their staff code (SP-4b · F09). Every sale from here names them. */
  signIn(cashierId: string): void {
    const id = cashierId.trim();
    if (id === '') throw new RangeError('A staff code is required to sign in.');
    this.operatorId = id;
  }

  /** The cashier leaves the till: the next sale is refused until somebody signs in. */
  signOut(): void {
    this.operatorId = undefined;
  }

  /** Who is at the till now — the signed-in cashier, else the one the session was built with, else nobody. */
  operator(): string | undefined {
    return this.operatorId ?? this.config.cashierId;
  }

  /** The lane this till is, or undefined when the box never said. */
  laneId(): string | undefined {
    return this.config.laneId === undefined || this.config.laneId === '' ? undefined : this.config.laneId;
  }

  /**
   * The trading day a moment belongs to — per this shop's cut-off, in this machine's wall clock (M01-FR-02), or the
   * fixed day the session was built with. Worked out at COMMIT, so a till left open past the cut-off dates the next
   * sale to the new day rather than the one the page was opened on (F09).
   */
  tradingDayFor(atIsoUtc: string): string {
    return this.config.tradingDay ?? tradingDateOf(atIsoUtc, makeTradingDayRule(this.config.tradingDayCutoff ?? '00:00'), this.config.timeZone);
  }

  setNow(atIsoUtc: string): void {
    this.nowRef = atIsoUtc;
  }

  /** Go to tender — 1 interaction. Refuses an empty basket. */
  goToTender(): BasketTotals {
    this.notWhileAwaiting();
    const totals = this.totals();
    if (totals.lineCount === 0) {
      throw new EmptyBasketError();
    }
    this.state = 'tendering';
    return totals;
  }

  /**
   * Preview how the tenders cover the payable amount. Only authorized/settled
   * tenders count — a pending card/UPI is shown honestly and never treated as paid
   * (M12-FR-03 / §4.3).
   */
  previewSettlement(tenders: readonly Tender[]): Settlement {
    return settle(this.totals().payable, tenders);
  }

  /**
   * Commit the sale LOCALLY (hard rule #1): stock movements to the local ledger, the
   * sale queued to the outbox — no network call. Throws if the tenders don't cover
   * the payable amount. Idempotent on the sale id.
   */
  async commit(
    saleId: string, number: string, committedAt: string, tenders: readonly Tender[],
    /** OB-264: the old ERP's bill number for this sale — required in the mirror pilot, refused outside it. */
    extra: { readonly oldErpBillNumber?: string } = {},
  ): Promise<CommittedSale> {
    // A sale whose answer was lost is resolved first, under its own id — never rung again as a new one (A8).
    if (this.awaiting !== undefined) {
      if (this.awaiting.saleId === saleId) return this.confirmPendingSale();
      this.notWhileAwaiting();
    }
    if (this.state === 'committed') {
      throw new SessionStateError('commit', this.state);
    }
    // A bill is never shown for a sale that did not commit: the last one is forgotten until this one is on the disk.
    this.lastBillValue = undefined;
    this.lastSlipValue = undefined;
    const totals = this.totals();
    if (totals.lineCount === 0) {
      throw new EmptyBasketError();
    }

    // Who, where, which day — REAL, or refused (F09). A placeholder here becomes a sale nobody can be asked about.
    const cashierId = this.operator();
    if (cashierId === undefined) throw new NoOperatorError();
    const laneId = this.laneId();
    if (laneId === undefined) throw new NoLaneError();

    const active = this.activeLines();
    // **The age gate, again, at the moment it matters** (PF-03): every age-restricted line still in the basket must be
    // covered by a confirmed answer. The scan already refuses an unanswered one; this second gate is the one the audit
    // found missing, and it is what makes any other way onto the bill unable to sell to a minor.
    const unchecked = active
      .filter((l) => l.minimumAge !== undefined && this.confirmationFor(l.minimumAge) === undefined)
      .map((l) => ({ productId: l.productId, description: l.description, minimumAge: l.minimumAge as number }));
    if (unchecked.length > 0) throw new AgeCheckNotDoneError(saleId, unchecked);
    // **B6 · B14 · B19, again, at the moment it matters** — before the disk and before the money. A recalled held basket,
    // a scale whose stamp ran out while the basket was open (midnight), a quantity typed in: none reaches a bill.
    const gate = this.gateContext(committedAt);
    // NEW-1 (B19): each line judged as CHARGED — after the promotion discount attributed to it — so an offer cannot give a
    // carry bag away free.
    const discountByLine = this.promotionDiscountByLine();
    const refused = active.flatMap((l) => this.lineRefusals(l, committedAt, this.priceOf(l).total.minor - (discountByLine.get(l.lineId) ?? 0)));
    if (refused.length > 0) throw new TillRuleRefusedError(refused, 'Do not take payment. ');
    // A TOBACCO line needs 18 even when it was rung before the pack said so, or recalled from a held basket (B14).
    const tobaccoUnchecked = active
      .filter((l) => { const age = tobaccoAge(l.minimumAge, this.flagsOf(l)); return age !== undefined && this.confirmationFor(age) === undefined; })
      .map((l) => ({ productId: l.productId, description: l.description, minimumAge: tobaccoAge(l.minimumAge, this.flagsOf(l)) as number }));
    if (tobaccoUnchecked.length > 0) throw new AgeCheckNotDoneError(saleId, tobaccoUnchecked);
    // B8 (OB-298), again at the moment it matters: every perishable line whose barcode carried no date has its pack date
    // confirmed — a recalled held basket or an older screen cannot put one on the bill unchecked.
    const datesUnchecked = active
      .filter((l) => tillRuleFlagsOf(this.flagsOf(l)).perishable === true && l.batchExpiry === undefined && l.packDateCheck === undefined)
      .map((l) => ({ productId: l.productId, description: l.description }));
    if (datesUnchecked.length > 0) throw new PackDateCheckNotDoneError(saleId, datesUnchecked);
    const input = {
        id: saleId,
        number,
        laneId,
        cashierId,
        tradingDay: this.tradingDayFor(committedAt),
        committedAt,
        // OB-306: a bundle line leaves the till's own stock as its components (the bundle itself holds no stock).
        lines: this.stockLines(active),
        // C10 · hard rule #3 (NEW-3): a tender leaves this till with a token reference, the last four digits and the network
        // at most — anything else, and anything shaped like a card number, is removed here. The store computer and head
        // office remove (and raise) it again; this is the till's own copy of the rule, so nothing card-like is handed over.
        tenders: withoutCardData(tenders).tenders as readonly Tender[],
    };

    // The lines the CLOUD sees carry more than the local ledger needs: the unit price and the
    // tax-inclusive line total — the shelf price × quantity, GST inside it (A9), so the day's figures
    // and the GST return can be projected without guessing — and the HSN + rate the line was priced under, FROZEN at the moment of sale so the
    // GST return files each sale under what actually applied — even across a mid-period rate change
    // (A5). These are a record, never a control: they are read off the pack the lane already holds,
    // add no network call and no new way for a sale to fail (hard rule #1).
    //
    // A promotion discount is ATTRIBUTED to the lines it actually reduced (CGST s.15(3): a discount known
    // at supply reduces the taxable value): a targeted promotion comes off its own lines, a basket-wide one
    // is spread by value — the promotions engine decides which, per line. Each line's total is then the
    // post-discount amount actually charged, so the line totals sum to what the customer paid and the GST is
    // pulled from the correct reduced value.
    const perLineDiscount = this.promotionDiscountByLine();
    const recordLines = active.map((l) => {
      const lineTotalMinor = this.priceOf(l).total.minor;
      const flags = tillRuleFlagsOf(this.flagsOf(l));
      const requiredAge = tobaccoAge(l.minimumAge, this.flagsOf(l));
      const scale = this.weighed(l) ? scaleEvidence(gate) : undefined;
      return {
        productId: l.productId,
        quantityMinor: l.quantityMinor,
        uom: l.uom,
        unitPriceMinor: l.unitPrice.minor,
        lineTotalMinor: lineTotalMinor - (perLineDiscount.get(l.lineId) ?? 0),
        taxRateBps: l.taxRate.bps,
        ...(l.hsnCode !== undefined ? { hsnCode: l.hsnCode } : {}),
        // OB-306: a bundle line's components, exploded from the pack's definition and frozen here — the stock evidence.
        ...((b) => (b === undefined ? {} : { bundle: b }))(this.bundleOfLine(l)),
        // A7: the compensation cess the line was charged under (frozen for the GST return) and what it came to.
        ...((): { cess?: CessRate; cessMinor?: number } => {
          const cess = this.cessOfLine(l);
          if (cess === undefined) return {};
          try {
            const split = splitInclusiveWithCess({ grossMinor: Math.max(0, lineTotalMinor - (perLineDiscount.get(l.lineId) ?? 0)), gstRateBps: l.taxRate.bps, cess, quantity: l.quantityMinor });
            return { cess, cessMinor: split.cessMinor };
          } catch (e) {
            // An offer that takes a line below its own fixed cess cannot be billed — refused before the disk, in words.
            throw new BillArithmeticError(saleId, `line ${l.productId}: ${e instanceof Error ? e.message : String(e)}`);
          }
        })(),
        // B13: the hallmark HUID of a gold piece, kept with the sale (and printed on the bill).
        ...(huidOf(this.flagsOf(l)) === undefined ? {} : { huid: huidOf(this.flagsOf(l)) }),
        // D-20: the batch the barcode carried and its use-by date — the one-step-forward half of the recall trace (M10-FR-03).
        ...(l.batchId === undefined ? {} : { batchId: l.batchId }),
        ...(l.batchExpiry === undefined ? {} : { batchExpiry: l.batchExpiry }),
        // B8 (OB-298): who looked at the date printed on a perishable's pack, and when.
        ...(l.packDateCheck === undefined ? {} : { packDateCheck: l.packDateCheck }),
        // The evidence for a restricted line: what age it needed, and who confirmed it when (PF-03) — so head office can
        // see the check was made, and flag any restricted line that arrives without one.
        ...(requiredAge === undefined ? {} : { ageCheck: ageEvidence(requiredAge, this.confirmationFor(requiredAge)) }),
        // The evidence for the till's legal gates (B6 · B14 · B19) — a record, so head office can re-check it.
        ...(scale === undefined ? {} : { scaleCheck: scale }),
        ...(flags.tobacco === true && flags.packMinimumMinor !== undefined ? { packCheck: { packMinimumMinor: flags.packMinimumMinor } } : {}),
        ...(flags.carryBag === true ? { carryBag: { ...(flags.plasticMaterial === undefined ? {} : { material: flags.plasticMaterial }), ...(flags.plasticThicknessMicrons === undefined ? {} : { thicknessMicrons: flags.plasticThicknessMicrons }) } } : {}),
        // A price lowered with a manager's approval (PF-07), or set from a quotation (OB-506 — lowered or raised): where it
        // came from, who approved it, the evidence's id, and the quotation's number when a quotation set it.
        ...(l.priceOverride === undefined ? {} : { priceOverride: { fromUnitPriceMinor: l.priceOverride.fromUnitMinor, approvedBy: l.priceOverride.approvedBy, activityId: l.priceOverride.activityId, ...(l.priceOverride.quotationId === undefined ? {} : { quotationId: l.priceOverride.quotationId }) } }),
      };
    });
    // The record's net and GST are the sum of what is INSIDE each line as actually charged — after the attributed
    // promotion discount — so net + tax == total on the disk record exactly as on the cloud's lines, and the box's
    // day figures (`costTheDay`) read the same GST the GST return will file.
    // NEW-2: no line below zero, and the lines add to the payable — checked before the disk and before the money.
    const negative = recordLines.filter((l) => l.lineTotalMinor < 0);
    if (negative.length > 0) throw new BillArithmeticError(saleId, `line(s) ${negative.map((l) => l.productId).join(', ')} would be charged below zero`);
    const lineSum = recordLines.reduce((t, l) => t + l.lineTotalMinor, 0);
    // OB-279 · OB-285: in real trading the payable is the lines less what the rounding takes off — never above the lines.
    const roundOff = totals.roundOffMinor ?? 0;
    if (lineSum + roundOff !== totals.payable.minor || roundOff > 0) throw new BillArithmeticError(saleId, `the lines add to ${lineSum} against a payable of ${totals.payable.minor}`);
    const inside = recordLines.reduce(
      (acc, l) => {
        // A7: a cess-liable line's value of supply comes out of its price with the GST AND the cess pulled back.
        if (l.cess !== undefined) {
          const s = splitInclusiveWithCess({ grossMinor: l.lineTotalMinor, gstRateBps: l.taxRateBps, cess: l.cess, quantity: l.quantityMinor });
          return { net: acc.net + s.taxableMinor, tax: acc.tax + s.gstMinor, cess: acc.cess + s.cessMinor };
        }
        const split = splitInclusive(money(l.lineTotalMinor, totals.payable.currency), rate(l.taxRateBps));
        return { net: acc.net + split.net.minor, tax: acc.tax + split.tax.minor, cess: acc.cess };
      },
      { net: 0, tax: 0, cess: 0 },
    );

    // **Is this a sale at all? Ask before the disk, not after.**
    //
    // The durable write used to come first, and a card payment the terminal never answered was
    // therefore written to the disk and *then* rejected — so the lane's log accumulated sales that
    // were never paid for, and the edge, which rebuilds its send queue from that log on every
    // restart, would have carried them to the cloud. A test caught it; nothing about the code read
    // wrong.
    //
    // The order is: **decide, then record, then account for it.** Validation is not an effect —
    // nothing has happened yet and nothing needs to survive a power cut. It is the same `settle`
    // that `commitSale` uses below, so the two cannot reach different answers about one basket.
    if (!settle(totals.payable, tenders).fullyPaid) {
      throw new UnpaidSaleError(saleId);
    }
    // OB-252: guest sales only — points and store credit belong to a named customer, so neither is spent here. Refused
    // before the disk, in words; the customer pays another way.
    if (this.config.guestSalesOnly === true && tenders.some((t) => t.kind === 'loyalty_points' || t.kind === 'store_credit')) {
      throw new LocalCommitRefusedError(saleId, `${GUEST_SALES_ONLY_WORDS} Nothing was saved — take another payment.`);
    }
    // OB-256: the mirror pilot's tender — offered only in the mirror pilot, and then the only one, for the whole bill.
    // The same rule the store computer runs before its disk (`packages/tender/src/paid-on-old-erp.ts`).
    const mirror = saleTenderRefusal({
      mirrorOn: this.config.mirrorPilot === true, totalMinor: totals.payable.minor,
      tenders: tenders.map((t) => ({ kind: t.kind, amountMinor: t.amount.minor, status: t.status, ...(t.ref === undefined ? {} : { ref: t.ref }) })),
    });
    if (mirror !== undefined) throw new LocalCommitRefusedError(saleId, mirror.laneMessage);
    // OB-264: the old ERP's bill number — required in the mirror pilot (Rule 46(b) shape, no personal data), absent outside
    // it. Whether another sale already holds it is the store computer's to say, from its own logs, before ITS disk.
    const oldBill = oldErpBillRefusal({ mirrorOn: this.config.mirrorPilot === true, value: extra.oldErpBillNumber });
    if (oldBill !== undefined) throw new LocalCommitRefusedError(saleId, oldBill.laneMessage);
    // OB-271: in REAL TRADING the bill is the legal tax invoice — assembled and checked (A1 · Rule 46) HERE, before the disk
    // and before the money, from the shop's legal identity and the lines exactly as they are about to be saved. A missing
    // field refuses the sale; nothing is asked of any network (hard rule #1). Off (the mirror pilot, or not set): skipped.
    let taxInvoice: TaxInvoiceDocument | undefined;
    if (this.config.realTrading !== undefined) {
      if (this.config.mirrorPilot === true) throw new LocalCommitRefusedError(saleId, REAL_TRADING_AND_MIRROR_WORDS);
      // Audit A9: a card or UPI payment on the shop's own machine carries the machine's approval / reference number, so the
      // day can be matched against the machine's slip. The store computer checks it against its own record again.
      for (const t of input.tenders) {
        if (t.kind !== 'card' && t.kind !== 'upi') continue;
        const ref = readMachineReference(t.machineRef);
        if (!ref.ok) throw new LocalCommitRefusedError(saleId, `${ref.laneMessage} Nothing was saved.`);
      }
      const built = buildTaxInvoice({
        identity: this.config.realTrading.identity, number, committedAt, laneId, cashierId,
        lines: recordLines.map((l, i) => ({
          description: active[i]?.description ?? '', ...(l.hsnCode === undefined ? {} : { hsnCode: l.hsnCode }),
          quantityMinor: l.quantityMinor, uom: l.uom, unitPriceMinor: l.unitPriceMinor, lineTotalMinor: l.lineTotalMinor, taxRateBps: l.taxRateBps,
          ...(l.cess === undefined ? {} : { cess: l.cess }),
        })),
        tenders: input.tenders.map((t) => ({ kind: t.kind, amountMinor: t.amount.minor, ...(t.machineRef === undefined ? {} : { machineRef: t.machineRef }) })),
        // OB-279: the invoice's rounded total must be exactly what the till is about to charge.
        totalMinor: totals.payable.minor,
      });
      if (!built.ok) throw new TaxInvoiceRefusedError(saleId, built.laneMessage, built.problems);
      taxInvoice = built.doc;
    }

    // **The disk, before anything else is true.**
    //
    // The order is the rule: nothing is appended to the ledger, nothing is queued, and the state
    // does not become `committed` until the sale is on the disk. Doing it the other way round is
    // the worst failure this product has — a sale the cashier saw succeed, that the customer paid
    // for and walked away from, which was never written anywhere. Nobody finds out, the day is
    // short, and the till is blamed for a counting error that never happened.
    //
    // A refusal here is thrown, and thrown is right: it happens **before** the receipt exists, so
    // nothing has been promised to anybody and the cashier is told to use another lane. This is
    // the one place in the product where refusing a sale is the correct answer, and it is correct
    // because of the moment.
    // **What goes on the disk is what the shop later has to be able to answer with.**
    //
    // The first version wrote the basket and the payable total and nothing else. That is enough to
    // reprint a receipt and enough to sync a sale, so nothing ever failed — but the store box
    // projects the day's figures from this record, and net, tax and the tender kind were simply
    // not in it. The owner's margin cannot be worked out from a gross total, and a figure that
    // cannot be worked out is either absent or invented.
    //
    // These are not new facts. `totals()` already knows all three; they were being computed,
    // used to take the money, and then dropped on the floor.
    const record = JSON.stringify({
      ...input,
      lines: recordLines, // the cloud sees the rich lines (prices + frozen HSN/rate); commitSale keeps the ledger shape
      total: totals.payable.minor,
      netMinor: inside.net,
      taxMinor: inside.tax,
      // A7: the compensation cess inside the bill (net + GST + cess = the lines).
      ...(inside.cess === 0 ? {} : { cessMinor: inside.cess }),
      // OB-279 · OB-285: what the bill is below its lines (0 or less, never above) — total = lines + round off.
      ...(roundOff === 0 ? {} : { roundOffMinor: roundOff }),
      currency: totals.payable.currency,
      // OB-501 (R7-A): the build that rang it — head office and the store computer judge it by the version policy.
      ...(this.config.appVersion === undefined ? {} : { appVersion: this.config.appVersion }),
      // OB-264: the old ERP's bill number, on every mirror sale — so a mirror refund finds this sale by it.
      ...(extra.oldErpBillNumber === undefined || this.config.mirrorPilot !== true ? {} : { oldErpBillNumber: extra.oldErpBillNumber }),
      // Every answer to the age question on this bill, refusals included (PF-03 · M15 loss prevention).
      ...(this.ageAnswerLog.length === 0 ? {} : { ageAnswers: this.ageAnswerLog.slice() }),
      // B8: every answer to the pack-date question on this bill, "out of date — not sold" included.
      ...(this.packDateLog.length === 0 ? {} : { packDateAnswers: this.packDateLog.slice() }),
      // The member's number, for the STORE COMPUTER to turn into a member code before the disk (PF-09 step 2 · P-04).
      ...(this.loyaltyMobile === undefined || this.config.guestSalesOnly === true ? {} : { customerMobile: this.loyaltyMobile }),
      // OB-299: paid in full here and to be DELIVERED — the fee line (by product) and what it charged. Head office books it as
      // one delivery job, once, when the sale reaches it through the store computer.
      ...((d) => (d === undefined ? {} : {
        delivery: { requested: true, feeProductId: d.productId, feeMinor: recordLines.find((r, i) => active[i]?.lineId === d.lineId)?.lineTotalMinor ?? 0 },
      }))(this.deliveryLine()),
    });
    // Everything that is true only once the box has the sale — kept as one step so a sale confirmed LATE (its first answer
    // was lost, A8) is finished exactly as one confirmed at once.
    const finish = (): CommittedSale => {
      // B13: a HUID on the disk is sold — this till refuses it again at once, before the store computer's list is re-read.
      for (const l of active) { const huid = huidOf(this.flagsOf(l)); if (huid !== undefined) this.huidsSoldHere.add(huid); }

      const sale = commitSale(
        { ...input, total: totals.payable },
        this.stockLedger,
        this.outbox,
      );
      this.state = 'committed';
      // B13 · M31-FR-02: the bill as it prints — read off the record just saved, never re-priced. A record only: building it
      // can add no way for the sale to fail (hard rule #1), and nothing here is sent anywhere.
      const bands = new Map<number, { net: number; tax: number }>();
      for (const l of recordLines) {
        const cessSplit = l.cess === undefined ? undefined : splitInclusiveWithCess({ grossMinor: l.lineTotalMinor, gstRateBps: l.taxRateBps, cess: l.cess, quantity: l.quantityMinor });
        const split = splitInclusive(money(l.lineTotalMinor, totals.payable.currency), rate(l.taxRateBps));
        const band = bands.get(l.taxRateBps) ?? { net: 0, tax: 0 };
        bands.set(l.taxRateBps, cessSplit === undefined
          ? { net: band.net + split.net.minor, tax: band.tax + split.tax.minor }
          : { net: band.net + cessSplit.taxableMinor, tax: band.tax + cessSplit.gstMinor });
      }
      this.lastBillValue = Object.freeze({
        number, saleId, tradingDay: input.tradingDay, committedAt, laneId, cashierId, currency: totals.payable.currency,
        lines: recordLines.map((l, i) => ({
          description: active[i]?.description ?? l.productId,
          quantityMinor: l.quantityMinor, uom: l.uom, unitPriceMinor: l.unitPriceMinor, lineTotalMinor: l.lineTotalMinor,
          ...(l.huid === undefined ? {} : { huid: l.huid }),
          ...(l.batchId === undefined ? {} : { batchId: l.batchId }),
          ...(l.cessMinor === undefined ? {} : { cessMinor: l.cessMinor }),
        })),
        taxBands: [...bands.entries()].sort((a, b) => a[0] - b[0]).map(([rateBps, b]) => ({ rateBps, netMinor: b.net, taxMinor: b.tax })),
        netMinor: inside.net, taxMinor: inside.tax, ...(inside.cess === 0 ? {} : { cessMinor: inside.cess }), totalMinor: totals.payable.minor,
        tenders: input.tenders.map((t) => ({ kind: t.kind, amountMinor: t.amount.minor, ...(t.machineRef === undefined ? {} : { machineRef: t.machineRef }) })),
        ...(taxInvoice === undefined ? {} : { taxInvoice }),
      });
      // OB-352: a delivery bill's slip — the job head office books from it, and which path gives its address and slot.
      // When the store computer did not say (an older box), the slip is printed: the desk can always enter it.
      const delivered = this.deliveryLine();
      this.lastSlipValue = delivered === undefined ? undefined : Object.freeze({
        path: this.pendingDeliveryPath ?? 'delivery_desk', jobRef: `till-${saleId}`, receiptNumber: number, committedAt,
        itemLines: active.filter((l) => l.lineId !== delivered.lineId).length,
      });
      this.pendingDeliveryPath = undefined;
      return sale;
    };

    const outcome = await this.durable(saleId, record);
    if (outcome.unconfirmed === true) {
      // A8: the answer was lost — the sale MAY be on the box. Hold the exact record and refuse everything else until the
      // box answers; `confirmPendingSale` re-sends it under the same id. Never "not saved", never a second sale.
      this.awaiting = { saleId, number, record, finish, before: this.state };
      this.state = 'unconfirmed';
      throw new SaleUnconfirmedError(saleId, number, outcome.laneMessage);
    }
    if (!outcome.committed) throw new LocalCommitRefusedError(saleId, outcome.laneMessage, outcome);
    this.pendingDeliveryPath = outcome.deliveryPath;
    return finish();
  }

  /**
   * OB-352: the delivery slip of the bill this till last saved, when it was marked for delivery — in the language asked.
   * On the customer-app path it is one line telling the customer to choose in the app (nothing to fill in); otherwise the
   * slip with blank lines for the delivery desk. Undefined for a bill not for delivery.
   */
  deliverySlip(language: 'en' | 'ta' = 'en'): DeliverySlip | undefined {
    const s = this.lastSlipValue;
    if (s === undefined) return undefined;
    const w = SLIP_WORDS[language];
    const blank = '________________________';
    const lines = s.path === 'customer_app'
      ? [w.title, `${w.job}: ${s.jobRef}`, `${w.bill}: ${s.receiptNumber}`, w.app]
      : [
        w.title, `${w.job}: ${s.jobRef}`, `${w.bill}: ${s.receiptNumber}`, `${w.at}: ${shopDateTimeOf(s.committedAt) || s.committedAt}`,
        `${w.items}: ${s.itemLines}`, w.paid, w.write, `${w.name}: ${blank}`, `${w.address}: ${blank}`, `${blank}`,
        `${w.landmark}: ${blank}`, `${w.phone}: ${blank}`, `${w.slot}: ${blank}`,
      ];
    return { ...s, lines };
  }

  /** Suspend the basket for later recall (≤ 3 interactions). */
  suspend(): void {
    this.notWhileAwaiting();
    if (this.state === 'committed') {
      throw new SessionStateError('suspend', this.state);
    }
    this.state = 'suspended';
  }

  /**
   * The basket as it is handed to the store computer to hold (audit PF-05): its live lines, flattened to what a disk can
   * keep — the price it was rung at, its tax, HSN code and age requirement — and the age answers already given.
   */
  basketToHold(): { readonly lines: readonly SuspendedLine[]; readonly ageAnswers: readonly SuspendedAgeAnswer[] } {
    return {
      lines: this.activeLines().map((l) => ({
        lineId: l.lineId, productId: l.productId, description: l.description, unitPriceMinor: l.unitPrice.minor,
        quantityMinor: l.quantityMinor, uom: l.uom, taxBps: l.taxRate.bps, voided: false,
        ...(l.group === undefined ? {} : { group: l.group }),
        ...(l.hsnCode === undefined ? {} : { hsnCode: l.hsnCode }),
        ...(l.minimumAge === undefined ? {} : { minimumAge: l.minimumAge }),
        ...(l.batchId === undefined ? {} : { batchId: l.batchId }),
        ...(l.batchExpiry === undefined ? {} : { batchExpiry: l.batchExpiry }),
        ...(l.packDateCheck === undefined ? {} : { packDateCheck: l.packDateCheck }),
        // R9-A · OB-533: a lowered (or quotation-raised) line keeps its price evidence while parked — never a changed price without its reason.
        // OB-500: a cut line keeps its first price and its approval when parked, so a recalled line is still a cut line.
        ...(l.priceOverride === undefined ? {} : { priceOverride: { ...l.priceOverride } }),
      })),
      ageAnswers: this.ageAnswerLog.map((a) => ({ minimumAge: a.minimumAge, outcome: a.outcome, by: a.by, at: a.at, ...(a.productId === undefined ? {} : { productId: a.productId }) })),
    };
  }

  /**
   * Put a recalled basket back on this till (audit PF-05) — only onto an empty one, so two customers' items never mix.
   * The lines come back at the prices they were held at; the box says when the shop's price window has passed and they
   * must be checked. The age answers come back with them; a line still needing one is refused at payment until asked.
   */
  restoreHeld(lines: readonly SuspendedLine[], ageAnswers: readonly SuspendedAgeAnswer[] = []): void {
    this.notWhileAwaiting();
    if (this.activeLines().length > 0 || this.state === 'committed' || this.state === 'tendering') {
      throw new SessionStateError('recall a held basket onto', this.state);
    }
    this.newSale();
    for (const l of lines) {
      if (l.voided) continue;
      this.seq += 1;
      this.lines.push(Object.freeze({
        lineId: `L${this.seq}`, productId: l.productId, description: l.description,
        unitPrice: money(l.unitPriceMinor, this.config.currency), quantityMinor: l.quantityMinor, uom: l.uom as Uom,
        taxRate: rate(l.taxBps), voided: false,
        ...(l.hsnCode === undefined ? {} : { hsnCode: l.hsnCode }),
        ...(l.group === undefined ? {} : { group: l.group }),
        ...(l.minimumAge === undefined ? {} : { minimumAge: l.minimumAge }),
        ...(l.batchId === undefined ? {} : { batchId: l.batchId }),
        ...(l.batchExpiry === undefined ? {} : { batchExpiry: l.batchExpiry }),
        ...(l.packDateCheck === undefined ? {} : { packDateCheck: l.packDateCheck }),
        // R9-A · OB-533: a lowered (or quotation-raised) line keeps its price evidence while parked — never a changed price without its reason.
        // OB-500: a cut line comes back as a cut line — its first price and approval — so its quantity stays locked and a
        // further cut is measured from its first price, and head office still re-checks it.
        ...(l.priceOverride === undefined ? {} : { priceOverride: { ...l.priceOverride } }),
        // The pack's flags come back with the line (B14 · B19), so the commit judges a recalled line like a scanned one.
        ...(this.config.regulatedFlagsOf?.(l.productId) === undefined ? {} : { regulatedFlags: this.config.regulatedFlagsOf(l.productId) }),
      }));
    }
    for (const a of ageAnswers) this.ageAnswerLog.push(Object.freeze({ ...a }));
    // OB-299: a held bill that carried the delivery-fee line comes back marked for delivery.
    const fee = this.config.deliveryFeeProductId === undefined ? undefined : this.lines.find((l) => l.productId === this.config.deliveryFeeProductId);
    if (fee !== undefined) this.deliveryMark = { feeProductId: fee.productId, feeLineId: fee.lineId };
    this.state = this.lines.length > 0 ? 'selling' : 'idle';
  }

  /** Recall a suspended basket. */
  recall(): void {
    this.notWhileAwaiting();
    if (this.state !== 'suspended') {
      throw new SessionStateError('recall', this.state);
    }
    this.state = this.lines.length > 0 ? 'selling' : 'idle';
  }

  /**
   * This basket's reference (audit PF-06) — the bill a card or UPI attempt is recorded against on the store computer, so
   * a second attempt for the same basket is seen as the same bill. A new one with every new basket.
   */
  billRef(): string {
    if (this.billRefValue === undefined) this.billRefValue = `B-${this.config.laneId ?? 'lane'}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return this.billRefValue;
  }

  /**
   * Name the loyalty member on this bill by their mobile number (PF-09 step 2), or clear it with `null`. A number that is
   * not a 10-digit Indian mobile is refused with the cashier's words; nothing is set.
   */
  setLoyaltyMobile(raw: string | null): { readonly ok: boolean; readonly last4?: string; readonly laneMessage?: string } {
    this.notWhileAwaiting();
    if (raw === null) { this.loyaltyMobile = undefined; return { ok: true }; }
    // OB-252: refused in words — the number is not even read.
    if (this.config.guestSalesOnly === true) return { ok: false, laneMessage: GUEST_SALES_ONLY_WORDS };
    const mobile = normaliseMobile(raw);
    if (mobile === undefined) return { ok: false, laneMessage: 'That is not a 10-digit mobile number. Ask the customer again, or skip — the sale goes ahead without points.' };
    this.loyaltyMobile = mobile;
    return { ok: true, last4: mobile.slice(-4) };
  }

  /** The last four digits of the member named on this bill, or null — for the screen; the full number is never shown. */
  /**
   * The keyed number, for the STORE COMPUTER only — to ask what the member may spend (PF-09 step 3). It goes to the box in
   * a request body, which turns it into the member code; it is never written by the till or shown beyond the last four.
   */
  loyaltyMobileForBox(): string | undefined {
    return this.loyaltyMobile;
  }

  loyaltyMemberLast4(): string | null {
    return this.loyaltyMobile === undefined ? null : this.loyaltyMobile.slice(-4);
  }

  /** Start a fresh basket on the same lane (after a commit). */
  newSale(): void {
    this.notWhileAwaiting();
    // A new basket is a new customer: no member carries over (PF-09).
    this.loyaltyMobile = undefined;
    this.billRefValue = undefined;
    this.lines.length = 0;
    this.seq = 0;
    // A new basket is a new customer: no age answer carries over (PF-03).
    this.ageAnswerLog.length = 0;
    // Nor a pack-date answer (B8).
    this.packDateLog.length = 0;
    this.packDatePending.clear();
    // Nor a delivery mark (OB-299).
    this.deliveryMark = undefined;
    this.state = 'idle';
  }

  /**
   * OB-299 (owner, 23 Oct 2026, in writing — M12-FR-02): the customer pays IN FULL here and the bill is DELIVERED. Adds the
   * owner's delivery-fee line once — the fee product at its signed price from this till's own pack (₹0 allowed) — and marks
   * the bill, so the committed bill becomes one delivery job at head office (booked once, relayed through the store
   * computer). Entirely local (hard rule #1). Refused, in words, when the owner has not set the fee or the till's pack does
   * not hold its product. Marking again answers the fee line already added.
   */
  markForDelivery(feeLine: ScanInput | undefined): BasketEntry {
    this.notWhileAwaiting();
    const feeProductId = this.config.deliveryFeeProductId;
    if (feeProductId === undefined || feeProductId === '') throw new DeliveryNotAvailableError('delivery_fee_not_set', DELIVERY_FEE_NOT_SET_WORDS);
    const marked = this.deliveryLine();
    if (marked !== undefined) return marked;
    if (feeLine === undefined || feeLine.productId !== feeProductId) {
      throw new DeliveryNotAvailableError('delivery_fee_not_in_catalogue', `Delivery from the till cannot be taken: the delivery-fee product (${feeProductId}) is not in this till's catalogue. Ask the manager to check the catalogue.`);
    }
    const entry = this.scan({ ...feeLine, quantityMinor: 1 });
    this.deliveryMark = { feeProductId, feeLineId: entry.lineId };
    return entry;
  }

  /** OB-299: take the delivery off this bill — the fee line is voided with the reason (kept as evidence, never deleted). */
  unmarkDelivery(reason: string): void {
    const line = this.deliveryLine();
    if (line === undefined) { this.deliveryMark = undefined; return; }
    this.voidLine(line.lineId, reason);
    this.deliveryMark = undefined;
  }

  /** OB-299: the delivery-fee product the store pack names — undefined while the owner has not set it. */
  deliveryFeeProductId(): string | undefined {
    const id = this.config.deliveryFeeProductId;
    return id === undefined || id === '' ? undefined : id;
  }

  /** OB-299: the delivery-fee line while the bill is marked for delivery (its fee line still on the bill), else undefined. */
  deliveryLine(): BasketEntry | undefined {
    const mark = this.deliveryMark;
    if (mark === undefined) return undefined;
    return this.activeLines().find((l) => l.lineId === mark.feeLineId);
  }
}

/** The age a line needs once tobacco is counted: at least 18 for a tobacco product (B14), else what it declared. */
function tobaccoAge(declared: number | undefined, flags: Readonly<Record<string, unknown>> | undefined): number | undefined {
  return tillRuleFlagsOf(flags).tobacco === true ? Math.max(TOBACCO_MINIMUM_AGE, declared ?? 0) : declared;
}

/** A positive whole number of years, or undefined — the only shape an age restriction takes (`minimumAgeOf`). */
function validAge(age: number | undefined): number | undefined {
  return typeof age === 'number' && Number.isInteger(age) && age > 0 ? age : undefined;
}

/** The age evidence a sale record carries for one restricted line. `confirmation` is always present here — the commit
 *  gate refused the sale otherwise. */
function ageEvidence(minimumAge: number, confirmation: AgeAnswer | undefined): { minimumAge: number; confirmedAtLeast: number; confirmedBy: string; confirmedAt: string } {
  return {
    minimumAge,
    confirmedAtLeast: confirmation?.minimumAge ?? 0,
    confirmedBy: confirmation?.by ?? '',
    confirmedAt: confirmation?.at ?? '',
  };
}

/** Convenience: a tax rate from a percentage (e.g. 18 → 18%). */
export function taxRateFromPercent(percent: number): Rate {
  return rate(Math.round(percent * 100));
}

/** Convenience: sum a list of Money in one currency (used by the receipt view). */
export function sumMoney(amounts: readonly Money[], currency: CurrencyCode): Money {
  return amounts.reduce((total, a) => add(total, a), money(0, currency));
}

/** B13: the well-formed hallmark HUID a gold line carries in its pack flags, or undefined. */
function huidOf(flags: Readonly<Record<string, unknown>> | undefined): string | undefined {
  const read = tillRuleFlagsOf(flags);
  return read.gold === true ? read.huid : undefined;
}
