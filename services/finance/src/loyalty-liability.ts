// API-09 The loyalty liability, reconciled (Wave 5 · PF-09 step 3 · M17-FR-01 "points earned/burned reconcile to the
// liability", M17-FR-03 "balances reconcile to finance", M23, P-08).
//
// Every point a member holds and every rupee of store credit is money the shop owes. This compares two figures reached
// two different ways, exactly, in paise:
//   • what the members HOLD — the points and store credit projected from their append-only movements (head office's
//     loyalty register), the points valued at the owner's point value; and
//   • what the BOOKS carry — the balance of the liability accounts the day book posted to (earned points credited, points
//     spent at the till and taken back debited; store credit issued on refunds credited, spent at the till debited).
// A difference is named with its sign, never rounded away: points spent twice across channels (the till took more than
// the member held), a day not yet posted, or the point value changed since points were earned (a revaluation is the CA's
// call). A read — it writes nothing.

import type { Route } from '../../kernel/src/index';

export interface LoyaltyLiabilityDeps {
  /** What the members hold now: their points, the point value in force, and every store-credit instrument's balance. */
  readonly outstanding: (tenantId: string) => Promise<{ readonly points: number; readonly pointValuePaise: number; readonly storeCreditMinor: number }>;
  /** An account's balance across every posted journal, credit-positive (a liability's natural side). */
  readonly creditBalance: (tenantId: string, accountCode: string) => Promise<number>;
  readonly now: () => string;
}

const ACCOUNT = /^[a-z0-9_.:-]{1,64}$/i;

export function loyaltyLiabilityRoutes(deps: LoyaltyLiabilityDeps): readonly Route[] {
  return [
    {
      api: 'API-09', method: 'GET', path: '/v1/finance/loyalty-liability',
      permission: 'finance.period.read',
      handler: async (ctx) => {
        // The accounts are the CA's mapping; the suggested map's names are the default.
        const pointsAccount = ACCOUNT.test(ctx.query['pointsAccount'] ?? '') ? ctx.query['pointsAccount']! : 'loyalty_points_liability';
        const creditAccount = ACCOUNT.test(ctx.query['storeCreditAccount'] ?? '') ? ctx.query['storeCreditAccount']! : 'store_credit_liability';
        const held = await deps.outstanding(ctx.tenantId);
        const pointsValueMinor = held.points * held.pointValuePaise;
        const pointsPosted = await deps.creditBalance(ctx.tenantId, pointsAccount);
        const creditPosted = await deps.creditBalance(ctx.tenantId, creditAccount);
        const points = {
          account: pointsAccount, outstandingPoints: held.points, pointValuePaise: held.pointValuePaise,
          heldValueMinor: pointsValueMinor, postedMinor: pointsPosted, differenceMinor: pointsPosted - pointsValueMinor,
          reconciles: pointsPosted === pointsValueMinor,
        };
        const storeCredit = {
          account: creditAccount, heldMinor: held.storeCreditMinor, postedMinor: creditPosted,
          differenceMinor: creditPosted - held.storeCreditMinor, reconciles: creditPosted === held.storeCreditMinor,
        };
        const said = (name: string, d: number): string => (d === 0 ? `${name} reconciles exactly.`
          : `${name}: the books carry ₹${(Math.abs(d) / 100).toFixed(2)} ${d > 0 ? 'more' : 'less'} than the members hold — a day not yet posted, value spent twice across channels, or a changed point value. A person settles it.`);
        return {
          status: 200,
          body: {
            points, storeCredit, reconciles: points.reconciles && storeCredit.reconciles,
            detail: `${said('Loyalty points', points.differenceMinor)} ${said('Store credit', storeCredit.differenceMinor)}`,
            asAt: deps.now(),
          },
        };
      },
    },
  ];
}
