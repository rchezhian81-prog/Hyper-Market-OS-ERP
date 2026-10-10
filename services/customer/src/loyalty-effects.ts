// What a banked sale and a recorded return do to a member's points (Wave 5 · PF-09-a · OB-28 "C and 1",
// M17-FR-01, M12-FR-03, P-01, P-08).
//
// A SALE EARNS when it carries a member code, the owner has set the rule, and the code was a member when the sale was
// rung. A RETURN TAKES BACK in proportion to what was refunded. Both are durable, idempotent facts (one per sale, one
// per return), so a till re-sending a sale or a return never earns or takes back twice.
//
// Neither ever refuses: the sale and the refund already happened (hard rule #1). Every outcome — earned, not a member,
// rule not set, or points the member had already spent so could not all be taken back — is SAID in the reply (P-08).

import { pointsEarned, pointsToTakeBack, isMemberRef } from '../../../packages/loyalty/src/index';
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

export interface LoyaltyEffectsDeps {
  readonly rule: (tenantId: string) => Promise<LoyaltyRule> | LoyaltyRule;
  readonly memberHistory: (tenantId: string, memberRef: string) => Promise<readonly MemberRecord[]> | readonly MemberRecord[];
  /** What loyalty already did on one sale: its earn, and every take-back. */
  readonly saleLoyalty: (tenantId: string, saleId: string) => Promise<{ readonly earn?: SaleEarn; readonly takeBacks: readonly ReturnTakeBack[] }>;
  readonly pointsBalance: (tenantId: string, memberRef: string) => Promise<number | undefined> | number | undefined;
  readonly pointsVersion: (tenantId: string, memberRef: string) => Promise<number> | number;
  /** The earn movement and the sale's loyalty fact, in one write. Idempotent on the sale. */
  readonly recordEarn: (tenantId: string, saleId: string, earn: SaleEarn, at: string) => Promise<void>;
  /** The take-back movement (when any points move) and the return's loyalty fact, in one write, under the member's points guard. */
  readonly recordTakeBack: (tenantId: string, saleId: string, takeBack: ReturnTakeBack, at: string, expectedVersion: number) => Promise<void>;
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
