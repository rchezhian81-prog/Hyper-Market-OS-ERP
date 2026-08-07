// Concession and shop-in-shop (M27 / §28 / P-02 / P-04 / hard rules #2, #5).
//
// A concession counter — the jeweller, the mobile-phone kiosk, the sweet stall — sits inside
// the shop, rings through the shop's tills, and is **not the shop's business**. Everything
// difficult about this module follows from that one fact.
//
// The mistake that costs real money is boring and universal: **concession stock ends up in
// the store's valuation.** It is on the store's shelves, it moves through the store's POS,
// and one day somebody runs a stock valuation for the accountant and ₹40,00,000 of somebody
// else's gold is in it. The balance sheet is then wrong, the insurance is wrong, and the tax
// position is wrong — and nobody notices because the number "looks about right".
//
//   • **OWNERSHIP IS A PROPERTY OF THE STOCK, AND VALUATION ASKS.** `valueOwnStock` excludes
//     anything the store does not own, and reports what it excluded rather than silently
//     dropping it. A quiet exclusion is as dangerous as a quiet inclusion.
//   • **THE MONEY FROM A CONCESSION SALE IS NOT THE SHOP'S EITHER.** The shop collects it and
//     owes it onward, less its share. So a concession sale creates a **liability**, and
//     settlement discharges it — it never appears as the shop's revenue.
//   • **A DEPOSIT IS A LIABILITY, NEVER INCOME.** The commonest small fraud in a shop-in-shop
//     arrangement is a deposit quietly treated as rent received. It is the concessionaire's
//     money and it goes back when they leave.
//   • **AN EXPIRED AGREEMENT OR LAPSED INSURANCE BLOCKS NEW SALES.** The shop is liable for
//     what happens on its floor. An uninsured counter trading in the shop's name is the
//     shop's exposure, not the concessionaire's.
//
// Exact integer money throughout (§29.1). Pure and deterministic: the clock is injected.

export type ConcessionChargeBasis = 'fixed_rent' | 'revenue_share' | 'higher_of_both';

export interface ConcessionContract {
  readonly contractId: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly concessionaireId: string;
  readonly name: string;
  readonly startsOn: string;
  /** Inclusive last day, YYYY-MM-DD. */
  readonly endsOn: string;
  readonly basis: ConcessionChargeBasis;
  /** Monthly fixed rent in minor units. */
  readonly fixedRentMinor?: number;
  /** Share of gross sales in basis points, e.g. 1_500 = 15%. */
  readonly revenueShareBps?: number;
  /** Refundable security deposit held. A LIABILITY, never income. */
  readonly depositMinor: number;
  /** Utilities recharged, in minor units per month, or metered. */
  readonly utilitiesMinor?: number;
  readonly insuranceUntil?: string;
  readonly licenceUntil?: string;
  readonly approvedBy?: string;
  readonly active: boolean;
}

export type OwnershipStatus = 'own' | 'concession' | 'consignment' | 'customer_property';

export interface OwnedLot {
  readonly lotId: string;
  readonly productId: string;
  readonly branchId: string;
  readonly qty: number;
  readonly unitCostMinor: number;
  readonly ownership: OwnershipStatus;
  /** Set when ownership is not 'own'. */
  readonly ownerId?: string;
}

export interface ValuationResult {
  readonly branchId: string;
  readonly ownedValueMinor: number;
  readonly ownedLots: number;
  /** What was left out, by owner, so the exclusion is never silent. */
  readonly excluded: readonly {
    readonly ownership: OwnershipStatus;
    readonly ownerId: string;
    readonly lots: number;
    readonly valueMinor: number;
  }[];
  readonly excludedValueMinor: number;
  readonly detail: string;
}

/**
 * Value **only the stock the store actually owns**.
 *
 * This is the whole point of the ownership field. Concession and consignment stock sits on
 * the store's shelves and moves through the store's tills, and it belongs to somebody else.
 * A valuation that includes it overstates the balance sheet, the insurance schedule and the
 * tax position at once — and it always "looks about right".
 *
 * What was excluded is **named and valued**, because an unexplained gap between the shelf and
 * the balance sheet is its own kind of trouble at an audit.
 */
export function valueOwnStock(input: {
  readonly branchId: string;
  readonly lots: readonly OwnedLot[];
}): ValuationResult {
  const here = input.lots.filter((l) => l.branchId === input.branchId);
  const mine = here.filter((l) => l.ownership === 'own');
  const theirs = here.filter((l) => l.ownership !== 'own');

  const valueOf = (lots: readonly OwnedLot[]): number =>
    lots.reduce((s, l) => s + l.qty * l.unitCostMinor, 0);

  const byOwner = new Map<string, OwnedLot[]>();
  for (const lot of theirs) {
    const key = `${lot.ownership}|${lot.ownerId ?? 'unknown'}`;
    byOwner.set(key, [...(byOwner.get(key) ?? []), lot]);
  }

  const excluded = [...byOwner]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, lots]) => {
      const [ownership, ownerId] = key.split('|');
      return {
        ownership: (ownership ?? 'own') as OwnershipStatus,
        ownerId: ownerId ?? 'unknown',
        lots: lots.length,
        valueMinor: valueOf(lots),
      };
    });

  const ownedValueMinor = valueOf(mine);
  const excludedValueMinor = valueOf(theirs);

  return {
    branchId: input.branchId,
    ownedValueMinor,
    ownedLots: mine.length,
    excluded,
    excludedValueMinor,
    detail:
      excludedValueMinor === 0
        ? `${ownedValueMinor} across ${mine.length} lot(s), all owned by the store`
        : `${ownedValueMinor} owned by the store; ${excludedValueMinor} on these shelves belongs to somebody else and is EXCLUDED from the valuation, the insurance schedule and the tax position`,
  };
}

export type StockAccessOutcome = 'allowed' | 'not_your_stock' | 'not_permitted';

export interface StockAccessDecision {
  readonly allowed: boolean;
  readonly outcome: StockAccessOutcome;
  readonly securityEvent: boolean;
  readonly detail: string;
}

/**
 * Decide whether an actor may touch a lot.
 *
 * A concessionaire may handle their own stock and nothing else; store staff may handle the
 * store's stock and, where the contract says so, may sell the concession's on their behalf —
 * but never adjust, write off or count it as if it were theirs. Somebody else's inventory
 * being written off by our staff is a bill we cannot argue with.
 */
export function checkStockAccess(input: {
  readonly lot: OwnedLot;
  readonly actorId: string;
  readonly actorKind: 'store_staff' | 'concessionaire';
  readonly action: 'view' | 'sell' | 'adjust' | 'write_off' | 'count';
  /** Concessionaire id this actor belongs to, when actorKind is 'concessionaire'. */
  readonly concessionaireId?: string;
  /** True when the contract lets store staff ring the concession's sales. */
  readonly storeSellsOnBehalf?: boolean;
}): StockAccessDecision {
  const isOwn = input.lot.ownership === 'own';

  if (input.actorKind === 'concessionaire') {
    if (isOwn || input.lot.ownerId !== input.concessionaireId) {
      return {
        allowed: false,
        outcome: 'not_your_stock',
        securityEvent: true,
        detail: `${input.actorId} tried to ${input.action} stock that is not theirs — refused and recorded`,
      };
    }
    return { allowed: true, outcome: 'allowed', securityEvent: false, detail: `${input.action} on their own stock` };
  }

  if (isOwn) {
    return { allowed: true, outcome: 'allowed', securityEvent: false, detail: `${input.action} on the store's own stock` };
  }
  if (input.action === 'view') {
    return { allowed: true, outcome: 'allowed', securityEvent: false, detail: 'visible so the shelf makes sense' };
  }
  if (input.action === 'sell' && input.storeSellsOnBehalf === true) {
    return {
      allowed: true,
      outcome: 'allowed',
      securityEvent: false,
      detail: 'sold on the concessionaire\'s behalf under the contract — the money is theirs, less our share',
    };
  }
  return {
    allowed: false,
    outcome: 'not_permitted',
    securityEvent: false,
    detail: `store staff cannot ${input.action} stock owned by ${input.lot.ownerId ?? 'another party'} — somebody else's inventory written off by our staff is a bill we cannot argue with`,
  };
}

export interface ConcessionSale {
  readonly saleId: string;
  readonly contractId: string;
  readonly concessionaireId: string;
  readonly branchId: string;
  readonly at: string;
  readonly grossMinor: number;
  readonly taxMinor: number;
  /** Which till took the money. The shop is holding it. */
  readonly tenderedTo: 'store_till' | 'concessionaire_till';
  readonly refundOf?: string;
}

export interface PeriodCharge {
  readonly contractId: string;
  readonly concessionaireId: string;
  readonly from: string;
  readonly to: string;
  readonly grossSalesMinor: number;
  readonly fixedRentMinor: number;
  readonly revenueShareMinor: number;
  /** What the contract actually charges, given its basis. */
  readonly chargeMinor: number;
  readonly utilitiesMinor: number;
  readonly totalDueMinor: number;
  readonly basis: ConcessionChargeBasis;
  readonly detail: string;
}

/**
 * Compute the period charge — rent, revenue share and utilities — in **exact integer money**.
 *
 * Revenue share is taken on **gross sales net of refunds**, in BigInt, so a busy month at a
 * jewellery counter cannot drift by a paisa. `higher_of_both` is the common Indian mall term
 * and is computed as exactly that: the higher of the two, not the sum.
 */
export function computePeriodCharge(input: {
  readonly contract: ConcessionContract;
  readonly sales: readonly ConcessionSale[];
  readonly from: string;
  readonly to: string;
  /** Metered utilities for the period, overriding the contract's flat figure. */
  readonly meteredUtilitiesMinor?: number;
}): PeriodCharge {
  const window = input.sales.filter(
    (s) =>
      s.contractId === input.contract.contractId &&
      s.at >= input.from &&
      s.at <= `${input.to}T23:59:59Z`,
  );

  // A refund carries a NEGATIVE grossMinor and names the sale it reverses, so it reduces
  // the base by construction. Charging revenue share on money that went back to a customer
  // is a charge the concessionaire will find, and they will be right.
  const grossSalesMinor = window.reduce((s, sale) => s + sale.grossMinor, 0);

  const fixedRentMinor = input.contract.fixedRentMinor ?? 0;
  const revenueShareMinor =
    input.contract.revenueShareBps === undefined
      ? 0
      : Number((BigInt(Math.max(0, grossSalesMinor)) * BigInt(input.contract.revenueShareBps)) / 10_000n);

  const chargeMinor =
    input.contract.basis === 'fixed_rent'
      ? fixedRentMinor
      : input.contract.basis === 'revenue_share'
        ? revenueShareMinor
        : Math.max(fixedRentMinor, revenueShareMinor);

  const utilitiesMinor = input.meteredUtilitiesMinor ?? input.contract.utilitiesMinor ?? 0;

  return {
    contractId: input.contract.contractId,
    concessionaireId: input.contract.concessionaireId,
    from: input.from,
    to: input.to,
    grossSalesMinor,
    fixedRentMinor,
    revenueShareMinor,
    chargeMinor,
    utilitiesMinor,
    totalDueMinor: chargeMinor + utilitiesMinor,
    basis: input.contract.basis,
    detail:
      input.contract.basis === 'higher_of_both'
        ? `${grossSalesMinor} of sales: rent ${fixedRentMinor} against ${revenueShareMinor} revenue share — the HIGHER of the two applies, not the sum`
        : `${grossSalesMinor} of sales, charged on ${input.contract.basis.replace(/_/g, ' ')} at ${chargeMinor}`,
  };
}

export interface SettlementStatement {
  readonly contractId: string;
  readonly concessionaireId: string;
  readonly from: string;
  readonly to: string;
  /** Money the shop collected on their behalf — a LIABILITY, never our revenue. */
  readonly collectedForThemMinor: number;
  readonly chargeMinor: number;
  readonly utilitiesMinor: number;
  /** What we pay them: collected less what they owe us. Can be negative. */
  readonly payableToThemMinor: number;
  /** Held deposit, stated but never netted without instruction. */
  readonly depositHeldMinor: number;
  readonly reconciles: boolean;
  readonly differenceMinor: number;
  readonly detail: string;
}

/**
 * Settle a period with a concessionaire.
 *
 * The money the store's tills took for a concession sale was **never the store's revenue** —
 * it is money held on someone else's behalf, and the settlement discharges it. Presenting it
 * as revenue and the payout as a cost inflates both sides of the P&L and makes every margin
 * figure in the business wrong.
 *
 * The **deposit is stated but not netted**. Grabbing a deposit against an unpaid month is a
 * commercial decision with contractual consequences; a settlement routine does not get to
 * take it.
 */
export function settleConcession(input: {
  readonly contract: ConcessionContract;
  readonly charge: PeriodCharge;
  readonly sales: readonly ConcessionSale[];
  /** What the tills actually banked for this concession, from the day-close. */
  readonly bankedForThemMinor: number;
}): SettlementStatement {
  const window = input.sales.filter(
    (s) =>
      s.contractId === input.contract.contractId &&
      s.at >= input.charge.from &&
      s.at <= `${input.charge.to}T23:59:59Z` &&
      s.tenderedTo === 'store_till',
  );

  const collectedForThemMinor = window.reduce((s, sale) => s + sale.grossMinor, 0);
  const differenceMinor = collectedForThemMinor - input.bankedForThemMinor;
  const payableToThemMinor = collectedForThemMinor - input.charge.totalDueMinor;

  return {
    contractId: input.contract.contractId,
    concessionaireId: input.contract.concessionaireId,
    from: input.charge.from,
    to: input.charge.to,
    collectedForThemMinor,
    chargeMinor: input.charge.chargeMinor,
    utilitiesMinor: input.charge.utilitiesMinor,
    payableToThemMinor,
    depositHeldMinor: input.contract.depositMinor,
    reconciles: differenceMinor === 0,
    differenceMinor,
    detail:
      differenceMinor !== 0
        ? `the counter rang ${collectedForThemMinor} and the till banked ${input.bankedForThemMinor} — a ${Math.abs(differenceMinor)} difference is a valued exception, not a rounding note`
        : payableToThemMinor < 0
          ? `they owe us ${-payableToThemMinor} this period; the ${input.contract.depositMinor} deposit is held and is NOT netted against it — that is a commercial decision, not a settlement routine's`
          : `we hold ${collectedForThemMinor} of their money and charge ${input.charge.totalDueMinor}, so ${payableToThemMinor} is payable to them`,
  };
}

export type ConcessionBlockReason =
  | 'contract_expired'
  | 'contract_not_started'
  | 'insurance_lapsed'
  | 'licence_lapsed'
  | 'not_approved'
  | 'inactive';

export interface ConcessionTradingDecision {
  readonly contractId: string;
  readonly mayTrade: boolean;
  readonly blockedBy: readonly ConcessionBlockReason[];
  /** Expiries coming up, so somebody can renew before the counter shuts. */
  readonly warnings: readonly string[];
  readonly detail: string;
}

/**
 * May this counter trade today?
 *
 * **Every blocker at once**, in the same style as the period close — telling somebody their
 * insurance has lapsed, and only after they fix it that the agreement expired too, wastes a
 * week of a trading counter.
 *
 * Lapsed insurance blocks trading because the shop is liable for what happens on its floor.
 * An uninsured counter trading inside the shop is the shop's exposure, whatever the contract
 * says about whose stock it is.
 */
export function mayConcessionTrade(input: {
  readonly contract: ConcessionContract;
  readonly today: string;
  /** Days ahead to warn about an expiry. Per-tenant. Default 30. */
  readonly warnWithinDays?: number;
}): ConcessionTradingDecision {
  const warn = input.warnWithinDays ?? 30;
  const dayMs = 86_400_000;
  const daysTo = (date: string): number =>
    Math.floor((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${input.today}T00:00:00Z`)) / dayMs);

  const blockedBy: ConcessionBlockReason[] = [];
  const warnings: string[] = [];

  if (!input.contract.active) blockedBy.push('inactive');
  if (input.contract.approvedBy === undefined) blockedBy.push('not_approved');
  if (input.today < input.contract.startsOn) blockedBy.push('contract_not_started');
  if (input.today > input.contract.endsOn) blockedBy.push('contract_expired');
  else if (daysTo(input.contract.endsOn) <= warn) {
    warnings.push(`the agreement ends in ${daysTo(input.contract.endsOn)} day(s)`);
  }

  if (input.contract.insuranceUntil === undefined || input.today > input.contract.insuranceUntil) {
    blockedBy.push('insurance_lapsed');
  } else if (daysTo(input.contract.insuranceUntil) <= warn) {
    warnings.push(`their insurance runs out in ${daysTo(input.contract.insuranceUntil)} day(s)`);
  }

  if (input.contract.licenceUntil !== undefined) {
    if (input.today > input.contract.licenceUntil) blockedBy.push('licence_lapsed');
    else if (daysTo(input.contract.licenceUntil) <= warn) {
      warnings.push(`their licence runs out in ${daysTo(input.contract.licenceUntil)} day(s)`);
    }
  }

  const mayTrade = blockedBy.length === 0;

  return {
    contractId: input.contract.contractId,
    mayTrade,
    blockedBy,
    warnings,
    detail: mayTrade
      ? warnings.length === 0
        ? `${input.contract.name} may trade`
        : `${input.contract.name} may trade, but ${warnings.join('; ')}`
      : `${input.contract.name} CANNOT take new sales: ${blockedBy.join(', ').replace(/_/g, ' ')}${blockedBy.includes('insurance_lapsed') ? ' — an uninsured counter inside your shop is your exposure, not theirs' : ''}`,
  };
}

export interface DepositPosition {
  readonly concessionaireId: string;
  readonly heldMinor: number;
  readonly refundedMinor: number;
  readonly forfeitedMinor: number;
  readonly outstandingLiabilityMinor: number;
  readonly detail: string;
}

export interface DepositMovement {
  readonly movementId: string;
  readonly concessionaireId: string;
  readonly kind: 'received' | 'refunded' | 'forfeited';
  readonly amountMinor: number;
  readonly at: string;
  readonly approvedBy?: string;
}

/**
 * The deposit position, **projected from movements** rather than stored (hard rule #2).
 *
 * A deposit is the concessionaire's money sitting in the shop's bank account. The commonest
 * small fraud in a shop-in-shop arrangement is a deposit quietly booked as rent received —
 * it flatters this year and becomes a real debt the day the counter leaves. So it is
 * projected as a liability and a forfeit needs a named approver.
 */
export function depositPosition(input: {
  readonly concessionaireId: string;
  readonly movements: readonly DepositMovement[];
}): DepositPosition {
  const mine = input.movements.filter((m) => m.concessionaireId === input.concessionaireId);
  const sum = (kind: DepositMovement['kind']): number =>
    mine.filter((m) => m.kind === kind).reduce((s, m) => s + m.amountMinor, 0);

  const heldMinor = sum('received');
  const refundedMinor = sum('refunded');
  // A forfeit with nobody's name on it is not a forfeit; it stays a liability.
  const forfeitedMinor = mine
    .filter((m) => m.kind === 'forfeited' && m.approvedBy !== undefined)
    .reduce((s, m) => s + m.amountMinor, 0);
  const unapprovedForfeits = mine.filter((m) => m.kind === 'forfeited' && m.approvedBy === undefined);

  const outstandingLiabilityMinor = heldMinor - refundedMinor - forfeitedMinor;

  return {
    concessionaireId: input.concessionaireId,
    heldMinor,
    refundedMinor,
    forfeitedMinor,
    outstandingLiabilityMinor,
    detail:
      unapprovedForfeits.length > 0
        ? `${outstandingLiabilityMinor} is owed back; ${unapprovedForfeits.length} forfeit(s) have nobody's name on them and are STILL a liability until somebody approves them`
        : `${outstandingLiabilityMinor} of their money is held and owed back — it is a liability, not rent received`,
  };
}
