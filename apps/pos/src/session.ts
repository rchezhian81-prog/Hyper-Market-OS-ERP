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
import { priceLine, sumLines, type LinePricing, type BillTotals } from '../../../packages/pricing/src/pricing';
import { bestPrice, type Promotion, type BasketLine, type PromotionResult } from '../../../packages/promotions/src/promotions';
import { settle, type Tender, type Settlement } from '../../../packages/tender/src/tender';
import { commitSale, UnpaidSaleError, type CommittedSale } from '../../../packages/sale/src/sale';
import type { Ledger } from '../../../packages/ledger/src/ledger';
import type { SyncOutbox } from '../../../packages/sync/src/outbox';
import type { CommitOutcome } from '../../../edge/store-edge/src/durability';

export interface PosSessionConfig {
  readonly laneId: string;
  readonly cashierId: string;
  readonly tradingDay: string;
  readonly currency: CurrencyCode;
  /** Default tax rate when a line doesn't carry its own (per-tenant config). */
  readonly defaultTaxRate: Rate;
}

export interface ScanInput {
  readonly productId: string;
  readonly description: string;
  /** Price of one UOM unit (per each, per kg, …). */
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
  readonly voided: boolean;
  readonly voidReason?: string;
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

export class PosSession {
  private readonly lines: BasketEntry[] = [];
  private seq = 0;
  private state: PosState = 'idle';
  private connection: ConnectionState = 'online';
  private promotions: readonly Promotion[] = [];
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
      voided: false,
    });
    this.lines.push(entry);
    this.state = 'selling';
    return entry;
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

  /** Price every active line (exact, weighed goods included). */
  private pricedLines(): LinePricing[] {
    return this.activeLines().map((l) =>
      priceLine({
        unitPrice: l.unitPrice,
        quantity: quantity(l.quantityMinor, l.uom),
        taxRate: l.taxRate,
      }),
    );
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

    const active = this.activeLines();
    const input = {
        id: saleId,
        number,
        laneId: this.config.laneId,
        cashierId: this.config.cashierId,
        tradingDay: this.config.tradingDay,
        committedAt,
        lines: active.map((l) => ({
          productId: l.productId,
          quantityMinor: l.quantityMinor,
          uom: l.uom,
        })),
        tenders,
    };

    // The lines the CLOUD sees carry more than the local ledger needs: the unit price and the
    // tax-inclusive line total (so the day's figures and the GST return can be projected without
    // guessing), and the HSN + rate the line was priced under, FROZEN at the moment of sale so the
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
      const lineTotalMinor = priceLine({ unitPrice: l.unitPrice, quantity: quantity(l.quantityMinor, l.uom), taxRate: l.taxRate }).total.minor;
      return {
        productId: l.productId,
        quantityMinor: l.quantityMinor,
        uom: l.uom,
        unitPriceMinor: l.unitPrice.minor,
        lineTotalMinor: lineTotalMinor - (perLineDiscount.get(l.lineId) ?? 0),
        taxRateBps: l.taxRate.bps,
        ...(l.hsnCode !== undefined ? { hsnCode: l.hsnCode } : {}),
      };
    });

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
      netMinor: totals.net.minor,
      taxMinor: totals.tax.minor,
      currency: totals.payable.currency,
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
    this.state = 'idle';
  }
}

/** Convenience: a tax rate from a percentage (e.g. 18 → 18%). */
export function taxRateFromPercent(percent: number): Rate {
  return rate(Math.round(percent * 100));
}

/** Convenience: sum a list of Money in one currency (used by the receipt view). */
export function sumMoney(amounts: readonly Money[], currency: CurrencyCode): Money {
  return amounts.reduce((total, a) => add(total, a), money(0, currency));
}
