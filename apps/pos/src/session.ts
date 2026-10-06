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
}

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
  readonly voided: boolean;
  readonly voidReason?: string;
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

export class PosSession {
  private readonly lines: BasketEntry[] = [];
  private seq = 0;
  private state: PosState = 'idle';
  private connection: ConnectionState = 'online';
  private promotions: readonly Promotion[] = [];
  /** The cashier who signed in at this till (SP-4b) — over the configured one, when both exist. */
  private operatorId: string | undefined;
  /** Every answer to the age question for THIS basket, in order (PF-03). Cleared with the basket, kept across hold/recall. */
  private readonly ageAnswerLog: AgeAnswer[] = [];
  /** Evaluation instant for effective-dated promotions; set by the caller (no clock). */
  private nowRef = '1970-01-01T00:00:00Z';

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

  /** Load the approved promotion pack (from the signed local cache — §31). */
  loadPromotions(promotions: readonly Promotion[]): void {
    this.promotions = promotions;
  }

  /** Scan an item onto the basket — 1 interaction (design bar). */
  scan(input: ScanInput): BasketEntry {
    if (this.state === 'committed' || this.state === 'suspended') {
      throw new SessionStateError('scan', this.state);
    }
    // An age-restricted item joins the basket only behind a confirmed answer for at least its age (PF-03).
    const minimumAge = validAge(input.minimumAge);
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
    });
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
      group: l.group,
    }));
    return bestPrice(basket, this.promotions, { at: this.nowRef, currency: this.config.currency });
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
        tenders,
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
      return {
        productId: l.productId,
        quantityMinor: l.quantityMinor,
        uom: l.uom,
        unitPriceMinor: l.unitPrice.minor,
        lineTotalMinor: lineTotalMinor - (perLineDiscount.get(l.lineId) ?? 0),
        taxRateBps: l.taxRate.bps,
        ...(l.hsnCode !== undefined ? { hsnCode: l.hsnCode } : {}),
        // The evidence for a restricted line: what age it needed, and who confirmed it when (PF-03) — so head office can
        // see the check was made, and flag any restricted line that arrives without one.
        ...(l.minimumAge === undefined ? {} : { ageCheck: ageEvidence(l.minimumAge, this.confirmationFor(l.minimumAge)) }),
      };
    });
    // The record's net and GST are the sum of what is INSIDE each line as actually charged — after the attributed
    // promotion discount — so net + tax == total on the disk record exactly as on the cloud's lines, and the box's
    // day figures (`costTheDay`) read the same GST the GST return will file.
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
    }));
    if (!outcome.committed) throw new LocalCommitRefusedError(saleId, outcome.laneMessage);

    const sale = commitSale(
      { ...input, total: totals.payable },
      this.stockLedger,
      this.outbox,
    );
    this.state = 'committed';
    return sale;
  }

  /** Suspend the basket for later recall (≤ 3 interactions). */
  suspend(): void {
    if (this.state === 'committed') {
      throw new SessionStateError('suspend', this.state);
    }
    this.state = 'suspended';
  }

  /** Recall a suspended basket. */
  recall(): void {
    if (this.state !== 'suspended') {
      throw new SessionStateError('recall', this.state);
    }
    this.state = this.lines.length > 0 ? 'selling' : 'idle';
  }

  /** Start a fresh basket on the same lane (after a commit). */
  newSale(): void {
    this.lines.length = 0;
    this.seq = 0;
    // A new basket is a new customer: no age answer carries over (PF-03).
    this.ageAnswerLog.length = 0;
    this.state = 'idle';
  }
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
