// API-05 Self-checkout baskets for loss prevention (R8-3 · R8-7 · M15 · D04-FR-06 · P-03 · P-08 · hard rules #2, #6, #10).
//
//   POST /v1/self-checkout/baskets/:activityId/synced   the store computer relays a paid self-checkout basket's evidence
//        (selfcheckout.basket.sync — the store computer's own role). Kept once per basket (a re-send is the same fact),
//        stamped with the relaying box's store, and the colleague it names is RE-CHECKED from head office's own grants:
//        one who holds no till authority here is kept and FLAGGED, never dropped and never silently believed.
//   GET  /v1/loss-prevention/self-checkout?branchId=&day=   the office's view of a day's self-checkout baskets: the ones a
//        colleague was needed for first, then by the basket's risk figure — "not set" when the owner has not set the watch
//        numbers (never a made-up zero). It reads; nothing is opened and nothing is blamed on anyone. A person opens a case
//        from it through the existing case route.
//
// The sale itself never travels here: it went through the till's own path to the books. This is evidence.

import type { Route } from '../../kernel/src/index';
import { apiError, assertBranchInScope } from '../../kernel/src/index';
import { readBasketEvidence, basketSummary, type SelfCheckoutBasketEvidence } from '../../../packages/self-checkout/src/basket-evidence';

export interface SelfCheckoutBasketRecord {
  readonly activityId: string;
  readonly storeId: string;
  readonly laneId: string;
  /** The colleague the store computer verified at the lane — the one who confirmed the payment. */
  readonly cashierId: string;
  readonly via: string;
  readonly billRef: string;
  readonly valueMinor: number;
  readonly at: string;
  readonly tradingDay: string;
  readonly selfCheckout: SelfCheckoutBasketEvidence;
  /** Head office's own grants: does the colleague hold till authority here? false = kept and flagged (P-08). */
  readonly colleagueAuthorityHeld: boolean;
  readonly relayedBy: string;
}

export interface SelfCheckoutBasketDeps {
  readonly now: () => string;
  readonly baskets: (tenantId: string) => Promise<readonly SelfCheckoutBasketRecord[]>;
  readonly recordBasket: (tenantId: string, record: SelfCheckoutBasketRecord) => Promise<void>;
  /** The permissions a person holds by head office's own grants, or undefined when nobody of that id is known. */
  readonly permissionsOf: (tenantId: string, userId: string) => Promise<readonly string[] | undefined>;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= 120;
const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isTime = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));

export function selfCheckoutBasketRoutes(deps: SelfCheckoutBasketDeps): readonly Route[] {
  return [
    {
      api: 'API-05', method: 'POST', path: '/v1/self-checkout/baskets/:activityId/synced',
      permission: 'selfcheckout.basket.sync', idempotent: true,
      handler: async (ctx) => {
        const activityId = (ctx.params['activityId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const evidence = readBasketEvidence(b['selfCheckout']);
        if (activityId === '' || b['activityId'] !== activityId || !isStr(b['storeId']) || !isStr(b['laneId']) || !isStr(b['cashierId']) || !isStr(b['billRef'])
          || typeof b['valueMinor'] !== 'number' || !Number.isSafeInteger(b['valueMinor']) || b['valueMinor'] <= 0 || !isTime(b['at']) || !isDay(b['tradingDay']) || evidence === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_self_checkout_basket',
            whatHappened: 'A relayed self-checkout basket needs its activityId matching the address, the store, the lane, the colleague, the bill, its value, when, the trading day and its evidence (format sre-sco-basket/1).',
            wasItSaved: 'not_saved', nextSafeAction: 'Keep it in the store computer\'s queue and raise it. The sale itself is unaffected.',
          });
        }
        assertBranchInScope(ctx, b['storeId'] as string);
        const prior = (await deps.baskets(ctx.tenantId)).find((x) => x.activityId === activityId);
        if (prior !== undefined) return { status: 200, body: { activityId, recorded: true, alreadyRecorded: true } };
        const held = (await deps.permissionsOf(ctx.tenantId, b['cashierId'] as string)) ?? [];
        const record: SelfCheckoutBasketRecord = {
          activityId, storeId: (b['storeId'] as string).trim(), laneId: (b['laneId'] as string).trim(), cashierId: (b['cashierId'] as string).trim(),
          via: isStr(b['via']) ? (b['via'] as string).trim() : 'unknown', billRef: (b['billRef'] as string).trim(), valueMinor: b['valueMinor'] as number,
          at: new Date(Date.parse(b['at'] as string)).toISOString(), tradingDay: b['tradingDay'] as string, selfCheckout: evidence,
          colleagueAuthorityHeld: held.includes('pos.sale.sync'), relayedBy: ctx.userId,
        };
        await deps.recordBasket(ctx.tenantId, record);
        return { status: 201, body: { activityId, recorded: true, colleagueAuthorityHeld: record.colleagueAuthorityHeld } };
      },
    },
    {
      api: 'API-05', method: 'GET', path: '/v1/loss-prevention/self-checkout',
      permission: 'lp.case.read',
      handler: async (ctx) => {
        const branchId = (ctx.query['branchId'] ?? '').trim();
        const day = ctx.query['day'];
        if (branchId === '' || !isDay(day)) {
          throw apiError(400, { code: 'branch_and_day_not_given', whatHappened: 'Say which branch and which trading day (?branchId=&day=YYYY-MM-DD).', wasItSaved: 'not_saved', nextSafeAction: 'Send both. Nothing was changed; this only reads.' });
        }
        assertBranchInScope(ctx, branchId);
        const needed = (r: SelfCheckoutBasketRecord): number => r.selfCheckout.interventions.filter((i) => i.kind !== 'payment').length;
        const baskets = (await deps.baskets(ctx.tenantId)).filter((r) => r.storeId === branchId && r.tradingDay === day)
          .sort((a, b) => needed(b) - needed(a) || (b.selfCheckout.riskBps ?? -1) - (a.selfCheckout.riskBps ?? -1) || a.at.localeCompare(b.at))
          .map((r) => ({ ...r, colleagueNeeded: needed(r), summary: basketSummary(r.selfCheckout), riskFigure: r.selfCheckout.riskBps === null ? 'not set' : r.selfCheckout.riskBps }));
        return {
          status: 200,
          body: {
            branchId, day, baskets, count: baskets.length, withColleague: baskets.filter((b) => b.colleagueNeeded > 0).length,
            flagged: baskets.filter((b) => !b.colleagueAuthorityHeld).length,
            rule: 'A basket is evidence, not an accusation: open a case from it through the case route, naming the investigator.',
            asAt: deps.now(),
          },
        };
      },
    },
  ];
}
