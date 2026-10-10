// What a banked sale and a recorded return do to a member's points (Wave 5 · PF-09-a · OB-28 "C and 1",
// M17-FR-01, M12-FR-03, P-01, P-08).
//
// A SALE EARNS when it carries a member code, the owner has set the rule, and the code was a member when the sale was
// rung. A RETURN TAKES BACK in proportion to what was refunded. Both are durable, idempotent facts (one per sale, one
// per return), so a till re-sending a sale or a return never earns or takes back twice.
//
// Neither ever refuses: the sale and the refund already happened (hard rule #1). Every outcome — earned, not a member,
// rule not set, or points the member had already spent so could not all be taken back — is SAID in the reply (P-08).

import { pointsEarned, pointsToTakeBack, pointsToGiveBack, isMemberRef } from '../../../packages/loyalty/src/index';
import { ConcurrencyConflictError } from '../../../packages/persistence/src/event-store';
import { wasMemberAt, type LoyaltyRule, type MemberRecord } from './loyalty-members';

export type LoyaltyOutcomeKind =
  | 'earned' | 'already_earned' | 'no_customer' | 'not_a_member_code' | 'rule_not_set' | 'not_a_member' | 'nothing_to_earn'
  | 'taken_back' | 'nothing_to_take_back' | 'no_points_on_sale';

export interface LoyaltyOutcome {
  readonly outcome: LoyaltyOutcomeKind;
  readonly points?: number;
  /** On a take-back: points owed back that the member had already spent, so could not be taken (said, never hidden). */
  readonly shortfall?: number;
  readonly detail: string;
}

export interface SaleEarn {
  readonly memberRef: string; readonly points: number; readonly saleTotalMinor: number;
  /** The point value in force when the points were earned — what the liability is booked at (PF-09 step 3). */
  readonly pointValuePaise?: number;
}
export interface ReturnTakeBack {
  readonly returnId: string; readonly memberRef: string; readonly refundMinor: number;
  readonly owed: number; readonly taken: number; readonly shortfall: number;
}

/**
 * What one return gave BACK of the points the member paid with on the bill (OB-34 "A"): in proportion to the returned
 * goods, once per return. `valueMinor` is what those points were worth when spent — what the liability is booked back at.
 */
export interface ReturnGiveBack {
  readonly returnId: string; readonly memberRef: string;
  /** The goods that came back on this return, at the bill's own prices. */
  readonly returnedValueMinor: number;
  readonly points: number;
  readonly valueMinor: number;
}

/** The points a bill was paid with, as head office applied them (what actually left the member's balance). */
export interface PointsSpentOnSale {
  readonly memberRef: string;
  readonly saleTotalMinor: number;
  readonly pointsApplied: number;
  /** The money value of the applied points (the till's tender, in proportion to what was applied). */
  readonly appliedMinor: number;
}

export interface LoyaltyEffectsDeps {
  readonly rule: (tenantId: string) => Promise<LoyaltyRule> | LoyaltyRule;
  readonly memberHistory: (tenantId: string, memberRef: string) => Promise<readonly MemberRecord[]> | readonly MemberRecord[];
  /** What loyalty already did on one sale: its earn, and every take-back. */
  readonly saleLoyalty: (tenantId: string, saleId: string) => Promise<{ readonly earn?: SaleEarn; readonly takeBacks: readonly ReturnTakeBack[]; readonly giveBacks?: readonly ReturnGiveBack[] }>;
  readonly pointsBalance: (tenantId: string, memberRef: string) => Promise<number | undefined> | number | undefined;
  readonly pointsVersion: (tenantId: string, memberRef: string) => Promise<number> | number;
  /** The earn movement and the sale's loyalty fact, in one write. Idempotent on the sale. */
  readonly recordEarn: (tenantId: string, saleId: string, earn: SaleEarn, at: string) => Promise<void>;
  /** The take-back movement (when any points move) and the return's loyalty fact, in one write, under the member's points guard. */
  readonly recordTakeBack: (tenantId: string, saleId: string, takeBack: ReturnTakeBack, at: string, expectedVersion: number) => Promise<void>;
  /** OB-34: the points the bill was paid with, once head office applied them; undefined when it used none. */
  readonly pointsSpentOnSale?: (tenantId: string, saleId: string) => Promise<PointsSpentOnSale | undefined>;
  /** OB-34: the give-back movement (when any points move) and the return's give-back fact, in one write, under the
   *  member's points guard. Idempotent on the return. */
  readonly recordGiveBack?: (tenantId: string, saleId: string, giveBack: ReturnGiveBack, at: string, expectedVersion: number) => Promise<void>;
  readonly now: () => string;
}

export async function earnOnSale(
  deps: LoyaltyEffectsDeps, tenantId: string,
  sale: {
    readonly saleId: string; readonly totalMinor: number; readonly committedAt: string; readonly customerRef?: unknown;
    readonly tenders?: readonly { readonly kind: string; readonly amountMinor: number }[];
  },
): Promise<LoyaltyOutcome> {
  if (sale.customerRef === undefined || sale.customerRef === null || sale.customerRef === '') {
    return { outcome: 'no_customer', detail: 'No loyalty member was named on this sale.' };
  }
  if (!isMemberRef(sale.customerRef)) {
    return { outcome: 'not_a_member_code', detail: 'The sale named a customer in a form head office does not accept as a member code — no points.' };
  }
  const already = (await deps.saleLoyalty(tenantId, sale.saleId)).earn;
  if (already !== undefined) return { outcome: 'already_earned', points: already.points, detail: `This sale already earned ${already.points} point(s).` };
  const rule = await deps.rule(tenantId);
  if (rule.pointsPer100Inr <= 0) return { outcome: 'rule_not_set', detail: 'Loyalty is off: the owner has not set how many points ₹100 earns. No points.' };
  if (!wasMemberAt(await deps.memberHistory(tenantId, sale.customerRef), sale.committedAt)) {
    return { outcome: 'not_a_member', detail: 'This number was not a loyalty member when the sale was rung — no points. They can join at the service desk.' };
  }
  // Points are earned on what the member PAID, not on what they paid with points (PF-09 step 3): spending points does not
  // earn new ones. Store credit is the customer's own money held by the shop, so it earns like cash.
  const paidWithPoints = (sale.tenders ?? []).filter((t) => t.kind === 'loyalty_points').reduce((n, t) => n + (Number.isSafeInteger(t.amountMinor) ? t.amountMinor : 0), 0);
  const points = pointsEarned(Math.max(0, sale.totalMinor - paidWithPoints), rule.pointsPer100Inr);
  if (points === 0) return { outcome: 'nothing_to_earn', points: 0, detail: 'The sale was too small to earn a whole point.' };
  await deps.recordEarn(tenantId, sale.saleId, { memberRef: sale.customerRef, points, saleTotalMinor: sale.totalMinor, pointValuePaise: rule.pointValuePaise }, deps.now());
  return { outcome: 'earned', points, detail: `${points} point(s) earned.` };
}

export async function takeBackOnReturn(
  deps: LoyaltyEffectsDeps, tenantId: string, saleId: string, returnId: string, refundMinor: number,
): Promise<LoyaltyOutcome> {
  for (let attempt = 0; ; attempt += 1) {
    const ledger = await deps.saleLoyalty(tenantId, saleId);
    if (ledger.earn === undefined) return { outcome: 'no_points_on_sale', detail: 'The sale earned no points, so the return takes none back.' };
    const prior = ledger.takeBacks.find((t) => t.returnId === returnId);
    if (prior !== undefined) {
      return prior.taken === 0 && prior.owed === 0
        ? { outcome: 'nothing_to_take_back', points: 0, detail: 'This return took back no points.' }
        : { outcome: 'taken_back', points: prior.taken, shortfall: prior.shortfall, detail: `${prior.taken} point(s) were taken back.` };
    }
    const owed = pointsToTakeBack({
      earned: ledger.earn.points, saleTotalMinor: ledger.earn.saleTotalMinor, refundMinor,
      priorRefundMinor: ledger.takeBacks.reduce((s, t) => s + t.refundMinor, 0),
      priorTakenBack: ledger.takeBacks.reduce((s, t) => s + t.owed, 0),
    });
    const memberRef = ledger.earn.memberRef;
    const version = await deps.pointsVersion(tenantId, memberRef);
    const balance = Math.max(0, (await deps.pointsBalance(tenantId, memberRef)) ?? 0);
    const taken = Math.min(owed, balance);
    const takeBack: ReturnTakeBack = { returnId, memberRef, refundMinor, owed, taken, shortfall: owed - taken };
    try {
      await deps.recordTakeBack(tenantId, saleId, takeBack, deps.now(), version);
    } catch (err) {
      // A burn or another take-back on this member landed first: re-read and decide again on the true balance.
      if (err instanceof ConcurrencyConflictError && attempt < 4) continue;
      throw err;
    }
    if (owed === 0) return { outcome: 'nothing_to_take_back', points: 0, detail: 'This return is too small to take back a whole point.' };
    return {
      outcome: 'taken_back', points: taken, shortfall: takeBack.shortfall,
      detail: takeBack.shortfall > 0
        ? `${taken} point(s) taken back; ${takeBack.shortfall} more were owed but the member had already spent them.`
        : `${taken} point(s) taken back.`,
    };
  }
}

export type GiveBackOutcomeKind = 'given_back' | 'nothing_to_give_back' | 'no_points_spent';
export interface GiveBackOutcome {
  readonly outcome: GiveBackOutcomeKind;
  readonly points?: number;
  readonly valueMinor?: number;
  readonly detail: string;
}

/**
 * OB-34 "A": a return GIVES BACK the points the member paid with on the bill, in proportion to the goods coming back
 * (valued at the bill's own prices), cumulative over the bill's returns so it is exact across partial returns, once per
 * return (a till re-sending the return gives nothing twice), under the member's points guard. Never refuses — the refund
 * already happened (hard rule #1); every outcome is said (P-08). An exchange gives back nothing (the caller does not ask):
 * its returned goods are credited in full against the replacement.
 */
export async function giveBackOnReturn(
  deps: LoyaltyEffectsDeps, tenantId: string, saleId: string, returnId: string, returnedValueMinor: number,
): Promise<GiveBackOutcome> {
  if (deps.pointsSpentOnSale === undefined || deps.recordGiveBack === undefined) {
    return { outcome: 'no_points_spent', detail: 'No points were paid on this bill.' };
  }
  const spent = await deps.pointsSpentOnSale(tenantId, saleId);
  if (spent === undefined || spent.pointsApplied <= 0) return { outcome: 'no_points_spent', detail: 'No points were paid on this bill, so none come back.' };
  for (let attempt = 0; ; attempt += 1) {
    const prior = (await deps.saleLoyalty(tenantId, saleId)).giveBacks ?? [];
    const done = prior.find((g) => g.returnId === returnId);
    if (done !== undefined) {
      return done.points > 0
        ? { outcome: 'given_back', points: done.points, valueMinor: done.valueMinor, detail: `${done.points} point(s) were given back.` }
        : { outcome: 'nothing_to_give_back', points: 0, detail: 'This return gave back no points.' };
    }
    const priorPoints = prior.reduce((n, g) => n + g.points, 0);
    const points = pointsToGiveBack({
      spent: spent.pointsApplied, saleTotalMinor: spent.saleTotalMinor, returnedValueMinor,
      priorReturnedValueMinor: prior.reduce((n, g) => n + g.returnedValueMinor, 0), priorGivenBack: priorPoints,
    });
    // Valued at what the points were worth when spent, cumulatively, so the liability booked back adds up to the spend.
    const valueAfter = Math.floor((spent.appliedMinor * (priorPoints + points)) / spent.pointsApplied);
    const valueBefore = Math.floor((spent.appliedMinor * priorPoints) / spent.pointsApplied);
    const giveBack: ReturnGiveBack = { returnId, memberRef: spent.memberRef, returnedValueMinor: Math.max(0, returnedValueMinor), points, valueMinor: valueAfter - valueBefore };
    const version = await deps.pointsVersion(tenantId, spent.memberRef);
    try {
      await deps.recordGiveBack(tenantId, saleId, giveBack, deps.now(), version);
    } catch (err) {
      if (err instanceof ConcurrencyConflictError && attempt < 4) continue;
      throw err;
    }
    return points > 0
      ? { outcome: 'given_back', points, valueMinor: giveBack.valueMinor, detail: `${points} point(s) the customer paid with were given back.` }
      : { outcome: 'nothing_to_give_back', points: 0, detail: 'This return is too small to give back a whole point.' };
  }
}
