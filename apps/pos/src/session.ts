// POS terminal session (M12 / D04) — the application shell behind the Sale screen
// (`docs/design/screens/pos-cashier.md`). It holds the basket a cashier is building
// and composes the tested engines: line/bill pricing, the promotions best-price
// engine, tender settlement, and the local sale commit. Hard rule #1 is structural
// here: NOTHING in this class awaits I/O — scanning, pricing, tendering and
// committing are all synchronous and local, so a sale completes with the network
// cable out and is queued for sync afterwards. The sync badge (§27.1) reads the
// outbox's unsent count so lag is always visible (P-08).

import { money, add, type Money, type CurrencyCode } from '../../../packages/contracts/src/money';
import { quantity, type Uom } from '../../../packages/contracts/src/quantity';
import { rate, type Rate } from '../../../packages/contracts/src/rate';
import type { ConnectionState } from '../../../packages/contracts/src/enums';
import { priceLine, sumLines, splitInclusive, type LinePricing, type BillTotals } from '../../../packages/pricing/src/pricing';
import { bestPrice, type Promotion, type BasketLine, type PromotionResult } from '../../../packages/promotions/src/promotions';
import { settle, type Tender, type Settlement } from '../../../packages/tender/src/tender';
import { commitSale, UnpaidSaleError, type CommittedSale } from '../../../packages/sale/src/sale';
import type { Ledger } from '../../../packages/ledger/src/ledger';
import type { SyncOutbox } from '../../../packages/sync/src/outbox';
import type { CommitOutcome } from '../../../edge/store-edge/src/durability';
import { makeTradingDayRule, tradingDateOf } from '../../../packages/calendar/src/index';
import type { SuspendedLine, SuspendedAgeAnswer } from '../../../packages/suspended-sales/src/suspended-bill';
import { normaliseMobile } from '../../../packages/loyalty/src/mobile';
import { withoutCardData } from '../../../packages/tender/src/tender-card-data';
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
}

/** NEW-1 (B19): an offer the till refused to apply because it targets a carry bag — said, never dropped quietly (P-08). */
export interface RefusedOffer {
  readonly offerId: string;
  readonly carryBags: readonly string[];
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
  readonly voided: boolean;
  readonly voidReason?: string;
  /**
   * The line's price was LOWERED at the till with a manager's approval (audit PF-07 · M12-FR-04): the unit price before,
   * who approved it and the till action the store computer holds as evidence. Carried on the sale record.
   */
  readonly priceOverride?: { readonly fromUnitMinor: number; readonly approvedBy: string; readonly activityId: string };
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

export type PosState = 'idle' | 'selling' | 'tendering' | 'committed' | 'suspended';

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
  }[];
  readonly taxBands: readonly { readonly rateBps: number; readonly netMinor: number; readonly taxMinor: number }[];
  readonly netMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
  readonly tenders: readonly { readonly kind: string; readonly amountMinor: number }[];
}

export interface BasketTotals extends BillTotals {
  /** Promotion discount applied to the basket, on top of any line discounts. */
  readonly promotionDiscount: Money;
  /** total − promotionDiscount (what the customer pays). */
  readonly payable: Money;
  readonly lineCount: number;
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
  constructor(public readonly saleId: string, public readonly laneMessage: string) {
    super(`sale ${saleId} was not committed locally: ${laneMessage}`);
    this.name = 'LocalCommitRefusedError';
  }
}

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
  private refusedOfferList: readonly RefusedOffer[] = [];
  /** The cashier who signed in at this till (SP-4b) — over the configured one, when both exist. */
  private operatorId: string | undefined;
  /** Every answer to the age question for THIS basket, in order (PF-03). Cleared with the basket, kept across hold/recall. */
  private readonly ageAnswerLog: AgeAnswer[] = [];
  /** The loyalty member's mobile number for THIS bill (PF-09 step 2 · OB-28 "1"). Held in memory only and handed to the
   *  store computer with the sale, which turns it into the member code before anything is written — never on a disk here. */
  private loyaltyMobile: string | undefined;
  /** This basket's own reference (audit PF-06): the bill a card/UPI attempt is recorded against, until the next sale. */
  private billRefValue: string | undefined;
  /** Evaluation instant for effective-dated promotions, when the caller fixed one (`setNow`); else the lane's clock. */
  private nowRef: string | undefined;

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
      const bags = (p.productIds ?? []).filter((id) => tillRuleFlagsOf(this.config.regulatedFlagsOf?.(id)).carryBag === true);
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

  /** Scan an item onto the basket — 1 interaction (design bar). */
  scan(input: ScanInput): BasketEntry {
    if (this.state === 'committed' || this.state === 'suspended') {
      throw new SessionStateError('scan', this.state);
    }
    // B6 · B14 · B19 — what the law forbids selling at all is refused FIRST, before any age question: a banned plastic,
    // a thin or free carry bag, a loose cigarette, or weight from a scale whose stamp has lapsed. No override exists.
    const regulatedFlags = input.regulatedFlags ?? this.config.regulatedFlagsOf?.(input.productId);
    const catalogueUom = this.config.baseUomOf?.(input.productId);
    const refusals = tillLineRefusals({
      productId: input.productId, description: input.description, quantityMinor: input.quantityMinor, uom: input.uom,
      unitPriceMinor: input.unitPrice.minor, ...(regulatedFlags === undefined ? {} : { regulatedFlags }),
      ...(catalogueUom === undefined ? {} : { catalogueUom }),
    }, this.gateContext(this.nowIso()));
    if (refusals.length > 0) throw new TillRuleRefusedError(refusals);
    // An age-restricted item joins the basket only behind a confirmed answer for at least its age (PF-03). Tobacco needs
    // at least 18, whatever the scan said (B14).
    const minimumAge = tobaccoAge(validAge(input.minimumAge), regulatedFlags);
    if (minimumAge !== undefined && this.ageConfirmedAtLeast() < minimumAge) {
      throw new AgeCheckRequiredError(input.productId, input.description, minimumAge);
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
    return this.answerAge('confirmed', minimumAge, atIsoUtc, productId);
  }

  /** The customer could not show they are old enough: the item is NOT sold, and that is kept as evidence (PF-03, M15). */
  refuseAge(minimumAge: number, atIsoUtc: string, productId?: string): AgeAnswer {
    return this.answerAge('refused', minimumAge, atIsoUtc, productId);
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
    const line = this.lines.find((l) => l.lineId === lineId);
    if (line === undefined) {
      throw new NoSuchLineError(lineId);
    }
    if (!Number.isSafeInteger(quantityMinor) || quantityMinor <= 0) {
      throw new RangeError(`Quantity must be a positive integer, got ${quantityMinor}.`);
    }
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
    const before = this.priceOf(line).total.minor;
    const after = this.priceOf({ ...line, unitPrice: money(toUnitMinor, line.unitPrice.currency) }).total.minor;
    return { fromUnitMinor: line.unitPrice.minor, reductionMinor: before - after };
  }

  /**
   * Lower a line's price — ONLY once the store computer holds the approved change as evidence (the caller's job, audit
   * PF-07). The line keeps where the price came from and who approved it; the sale record carries both.
   */
  overridePrice(lineId: string, toUnitMinor: number, evidence: { readonly approvedBy: string; readonly activityId: string }): BasketEntry {
    const { fromUnitMinor } = this.overrideValue(lineId, toUnitMinor);
    const line = this.lines.find((l) => l.lineId === lineId)!;
    const first = line.priceOverride?.fromUnitMinor ?? fromUnitMinor;
    const next: BasketEntry = Object.freeze({
      ...line, unitPrice: money(toUnitMinor, line.unitPrice.currency),
      priceOverride: { fromUnitMinor: first, approvedBy: evidence.approvedBy, activityId: evidence.activityId },
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
    try { return tradingDateOf(this.nowIso(), makeTradingDayRule('00:00')); } catch { return undefined; }
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
    try { today = tradingDateOf(atIsoUtc, makeTradingDayRule('00:00')); } catch { today = undefined; }
    const sold = new Set<string>([...(this.config.soldHuids?.() ?? []), ...this.huidsSoldHere]);
    for (const l of this.activeLines()) {
      if (l.lineId === exceptLineId) continue;
      const huid = huidOf(this.flagsOf(l));
      if (huid !== undefined) sold.add(huid);
    }
    return { ...(this.config.laneScales === undefined ? {} : { scales: this.config.laneScales }), ...(today === undefined ? {} : { today }), soldHuids: sold };
  }

  /** The flags a line is judged by: the lane's signed pack first, else what the scan carried (B14 · B19). */
  private flagsOf(l: Pick<BasketEntry, 'productId' | 'regulatedFlags'>): Readonly<Record<string, unknown>> | undefined {
    return this.config.regulatedFlagsOf?.(l.productId) ?? l.regulatedFlags;
  }

  private lineRefusals(l: BasketEntry, atIsoUtc: string, chargedMinor?: number, listUnitMinor?: number): ReturnType<typeof tillLineRefusals> {
    const regulatedFlags = this.flagsOf(l);
    const catalogueUom = this.config.baseUomOf?.(l.productId);
    // OB-173: the line's list price is its price before any change at the till — a bag lowered at the till is refused.
    const list = listUnitMinor ?? l.priceOverride?.fromUnitMinor;
    return tillLineRefusals({
      productId: l.productId, description: l.description, quantityMinor: l.quantityMinor, uom: l.uom,
      unitPriceMinor: l.unitPrice.minor, ...(regulatedFlags === undefined ? {} : { regulatedFlags }),
      ...(list === undefined ? {} : { listUnitPriceMinor: list }),
      ...(chargedMinor === undefined ? {} : { chargedMinor }),
      ...(catalogueUom === undefined ? {} : { catalogueUom }),
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
    return {
      ...bill,
      promotionDiscount,
      payable: money(Math.max(0, bill.total.minor - promotionDiscount.minor), currency),
      lineCount: this.activeLines().length,
    };
  }

  /** The deterministic best-price result for the current basket, or null when no promotion is loaded. */
  private promotionResult(): PromotionResult | null {
    if (this.promotions.length === 0) return null;
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
    }));
    const at = this.nowRef ?? this.config.clock?.() ?? '1970-01-01T00:00:00Z';
    return bestPrice(basket, this.promotions, { at, currency: this.config.currency });
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
    return this.config.tradingDay ?? tradingDateOf(atIsoUtc, makeTradingDayRule(this.config.tradingDayCutoff ?? '00:00'));
  }

  setNow(atIsoUtc: string): void {
    this.nowRef = atIsoUtc;
  }

  /** Go to tender — 1 interaction. Refuses an empty basket. */
  goToTender(): BasketTotals {
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
  ): Promise<CommittedSale> {
    if (this.state === 'committed') {
      throw new SessionStateError('commit', this.state);
    }
    // A bill is never shown for a sale that did not commit: the last one is forgotten until this one is on the disk.
    this.lastBillValue = undefined;
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
    const input = {
        id: saleId,
        number,
        laneId,
        cashierId,
        tradingDay: this.tradingDayFor(committedAt),
        committedAt,
        lines: active.map((l) => ({
          productId: l.productId,
          quantityMinor: l.quantityMinor,
          uom: l.uom,
        })),
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
        // B13: the hallmark HUID of a gold piece, kept with the sale (and printed on the bill).
        ...(huidOf(this.flagsOf(l)) === undefined ? {} : { huid: huidOf(this.flagsOf(l)) }),
        // D-20: the batch the barcode carried and its use-by date — the one-step-forward half of the recall trace (M10-FR-03).
        ...(l.batchId === undefined ? {} : { batchId: l.batchId }),
        ...(l.batchExpiry === undefined ? {} : { batchExpiry: l.batchExpiry }),
        // The evidence for a restricted line: what age it needed, and who confirmed it when (PF-03) — so head office can
        // see the check was made, and flag any restricted line that arrives without one.
        ...(requiredAge === undefined ? {} : { ageCheck: ageEvidence(requiredAge, this.confirmationFor(requiredAge)) }),
        // The evidence for the till's legal gates (B6 · B14 · B19) — a record, so head office can re-check it.
        ...(scale === undefined ? {} : { scaleCheck: scale }),
        ...(flags.tobacco === true && flags.packMinimumMinor !== undefined ? { packCheck: { packMinimumMinor: flags.packMinimumMinor } } : {}),
        ...(flags.carryBag === true ? { carryBag: { ...(flags.plasticMaterial === undefined ? {} : { material: flags.plasticMaterial }), ...(flags.plasticThicknessMicrons === undefined ? {} : { thicknessMicrons: flags.plasticThicknessMicrons }) } } : {}),
        // A price lowered with a manager's approval (PF-07): where it came from, who approved it, the evidence's id.
        ...(l.priceOverride === undefined ? {} : { priceOverride: { fromUnitPriceMinor: l.priceOverride.fromUnitMinor, approvedBy: l.priceOverride.approvedBy, activityId: l.priceOverride.activityId } }),
      };
    });
    // The record's net and GST are the sum of what is INSIDE each line as actually charged — after the attributed
    // promotion discount — so net + tax == total on the disk record exactly as on the cloud's lines, and the box's
    // day figures (`costTheDay`) read the same GST the GST return will file.
    // NEW-2: no line below zero, and the lines add to the payable — checked before the disk and before the money.
    const negative = recordLines.filter((l) => l.lineTotalMinor < 0);
    if (negative.length > 0) throw new BillArithmeticError(saleId, `line(s) ${negative.map((l) => l.productId).join(', ')} would be charged below zero`);
    const lineSum = recordLines.reduce((t, l) => t + l.lineTotalMinor, 0);
    if (lineSum !== totals.payable.minor) throw new BillArithmeticError(saleId, `the lines add to ${lineSum} against a payable of ${totals.payable.minor}`);
    const inside = recordLines.reduce(
      (acc, l) => {
        const split = splitInclusive(money(l.lineTotalMinor, totals.payable.currency), rate(l.taxRateBps));
        return { net: acc.net + split.net.minor, tax: acc.tax + split.tax.minor };
      },
      { net: 0, tax: 0 },
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
    const outcome = await this.durable(saleId, JSON.stringify({
      ...input,
      lines: recordLines, // the cloud sees the rich lines (prices + frozen HSN/rate); commitSale keeps the ledger shape
      total: totals.payable.minor,
      netMinor: inside.net,
      taxMinor: inside.tax,
      currency: totals.payable.currency,
      // Every answer to the age question on this bill, refusals included (PF-03 · M15 loss prevention).
      ...(this.ageAnswerLog.length === 0 ? {} : { ageAnswers: this.ageAnswerLog.slice() }),
      // The member's number, for the STORE COMPUTER to turn into a member code before the disk (PF-09 step 2 · P-04).
      ...(this.loyaltyMobile === undefined ? {} : { customerMobile: this.loyaltyMobile }),
    }));
    if (!outcome.committed) throw new LocalCommitRefusedError(saleId, outcome.laneMessage);
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
      const split = splitInclusive(money(l.lineTotalMinor, totals.payable.currency), rate(l.taxRateBps));
      const band = bands.get(l.taxRateBps) ?? { net: 0, tax: 0 };
      bands.set(l.taxRateBps, { net: band.net + split.net.minor, tax: band.tax + split.tax.minor });
    }
    this.lastBillValue = Object.freeze({
      number, saleId, tradingDay: input.tradingDay, committedAt, laneId, cashierId, currency: totals.payable.currency,
      lines: recordLines.map((l, i) => ({
        description: active[i]?.description ?? l.productId,
        quantityMinor: l.quantityMinor, uom: l.uom, unitPriceMinor: l.unitPriceMinor, lineTotalMinor: l.lineTotalMinor,
        ...(l.huid === undefined ? {} : { huid: l.huid }),
        ...(l.batchId === undefined ? {} : { batchId: l.batchId }),
      })),
      taxBands: [...bands.entries()].sort((a, b) => a[0] - b[0]).map(([rateBps, b]) => ({ rateBps, netMinor: b.net, taxMinor: b.tax })),
      netMinor: inside.net, taxMinor: inside.tax, totalMinor: totals.payable.minor,
      tenders: input.tenders.map((t) => ({ kind: t.kind, amountMinor: t.amount.minor })),
    });
    return sale;
  }

  /** Suspend the basket for later recall (≤ 3 interactions). */
  suspend(): void {
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
        // The pack's flags come back with the line (B14 · B19), so the commit judges a recalled line like a scanned one.
        ...(this.config.regulatedFlagsOf?.(l.productId) === undefined ? {} : { regulatedFlags: this.config.regulatedFlagsOf(l.productId) }),
      }));
    }
    for (const a of ageAnswers) this.ageAnswerLog.push(Object.freeze({ ...a }));
    this.state = this.lines.length > 0 ? 'selling' : 'idle';
  }

  /** Recall a suspended basket. */
  recall(): void {
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
    if (raw === null) { this.loyaltyMobile = undefined; return { ok: true }; }
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
    // A new basket is a new customer: no member carries over (PF-09).
    this.loyaltyMobile = undefined;
    this.billRefValue = undefined;
    this.lines.length = 0;
    this.seq = 0;
    // A new basket is a new customer: no age answer carries over (PF-03).
    this.ageAnswerLog.length = 0;
    this.state = 'idle';
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
