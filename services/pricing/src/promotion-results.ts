// API-02 a promotion's effectiveness FOLDED from head office's own records (M05-FR-04 "… effectiveness"; D06 · OB-288 P2).
//
// `POST /v1/promotions/:promotionId/effectiveness` measures figures the caller types — a what-if. This is the measurement:
//
//   GET /v1/promotions/:promotionId/results?baselineFrom=YYYY-MM-DD&baselineTo=YYYY-MM-DD
//
// The offer's own window (its start to its end, or to now while it runs) against a BASELINE window — the reader's, or, when
// none is sent, the same number of days immediately before the offer started (said in the answer as `baselineChosenBy`).
// For the products the offer names, in each window: the whole units sold, the sales net of tax, and the margin at each
// product's average buying cost — from the banked bills. Plus the supplier funding finance has RECEIVED for it (the
// promotion-funding journals). The verdict is the tested `measureEffectiveness`: was it worth doing — judged on margin,
// not units. A product sold with no known cost makes the margin "not known" and the verdict is withheld, the products
// named — never a margin costed at zero (P-08). An offer that names no products (a basket-wide or group offer) cannot be
// folded to products and says so.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import { measureEffectiveness } from '../../../packages/promotions/src/simulation';
import { promotionProductIds, type Promotion } from '../../../packages/promotions/src/promotions';

export interface WindowTakings {
  readonly units: number;
  readonly netSalesMinor: number;
  /** Undefined when some product sold in the window has no known cost — then `costNotKnownFor` names them. */
  readonly costMinor: number | undefined;
  readonly costNotKnownFor: readonly string[];
  readonly bills: number;
}

export interface PromotionResultsDeps {
  readonly promotion: (tenantId: string, promotionId: string) => Promise<Promotion | undefined>;
  readonly takings: (tenantId: string, productIds: readonly string[], fromIso: string, toIso: string) => Promise<WindowTakings>;
  /** What finance has received from suppliers towards this offer (promotion-funding journals), in paise. */
  readonly fundingReceived: (tenantId: string, promotionId: string) => Promise<number>;
  readonly now: () => string;
}

const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const DAY = 86_400_000;

export function promotionResultRoutes(deps: PromotionResultsDeps): readonly Route[] {
  return [
    {
      api: 'API-02', method: 'GET', path: '/v1/promotions/:promotionId/results',
      permission: 'promotion.read',
      handler: async (ctx) => {
        const promotionId = (ctx.params['promotionId'] ?? '').trim();
        const promotion = await deps.promotion(ctx.tenantId, promotionId);
        if (promotion === undefined) throw notFound(`promotion ${promotionId}`);
        const { baselineFrom, baselineTo } = ctx.query;
        const sent = baselineFrom !== undefined || baselineTo !== undefined;
        if (sent && (!isDay(baselineFrom) || !isDay(baselineTo) || baselineTo < baselineFrom)) {
          throw apiError(400, {
            code: 'not_readable_as_a_baseline',
            whatHappened: 'A baseline is both ?baselineFrom=YYYY-MM-DD and ?baselineTo=YYYY-MM-DD (to on or after from), or neither — then the same number of days just before the offer started.',
            wasItSaved: 'not_saved', nextSafeAction: 'Send both days, or neither. Nothing was changed; this only reads.',
          });
        }
        const productIds = promotionProductIds(promotion);
        if (productIds.length === 0) {
          throw apiError(422, {
            code: 'promotion_names_no_products',
            whatHappened: `Offer ${promotionId} names no products (it targets a group or the whole basket), so its sales cannot be folded product by product.`,
            wasItSaved: 'not_saved', nextSafeAction: 'Measure it with the what-if (POST /v1/promotions/:promotionId/effectiveness). Nothing was changed.',
          });
        }
        const now = Date.parse(deps.now());
        const start = Date.parse(promotion.startsAt);
        const end = Math.min(Date.parse(promotion.endsAt) + 1, now);
        if (!(end > start)) {
          return { status: 200, body: { promotionId, measured: false, why: 'the offer has not started yet, so nothing has sold under it', asAt: deps.now() } };
        }
        const span = end - start;
        const baseFromIso = sent ? `${baselineFrom}T00:00:00.000Z` : new Date(start - span).toISOString();
        const baseToIso = sent ? new Date(Date.parse(`${baselineTo}T00:00:00Z`) + DAY).toISOString() : new Date(start).toISOString();
        const [actual, baseline, funding] = await Promise.all([
          deps.takings(ctx.tenantId, productIds, new Date(start).toISOString(), new Date(end).toISOString()),
          deps.takings(ctx.tenantId, productIds, baseFromIso, baseToIso),
          deps.fundingReceived(ctx.tenantId, promotionId),
        ]);
        const notKnown = [...new Set([...actual.costNotKnownFor, ...baseline.costNotKnownFor])].sort();
        const windows = {
          offer: { from: new Date(start).toISOString(), to: new Date(end).toISOString(), ...actual },
          baseline: { from: baseFromIso, to: baseToIso, ...baseline },
        };
        if (actual.costMinor === undefined || baseline.costMinor === undefined) {
          return {
            status: 200,
            body: {
              promotionId, measured: false, productIds, windows, fundingReceivedMinor: funding, marginNotKnownFor: notKnown,
              why: `the margin is not known: no buying cost is recorded for ${notKnown.join(', ')} — the verdict is withheld rather than costed at zero`,
              baselineChosenBy: sent ? 'the_reader' : 'same_length_just_before_the_offer', asAt: deps.now(),
            },
          };
        }
        const result = measureEffectiveness({
          promotionId, baselineUnits: baseline.units, actualUnits: actual.units,
          baselineMargin: { minor: baseline.netSalesMinor - baseline.costMinor, currency: 'INR' },
          actualMargin: { minor: actual.netSalesMinor - actual.costMinor, currency: 'INR' },
          vendorFundingReceived: { minor: funding, currency: 'INR' },
        });
        return {
          status: 200,
          body: {
            measured: true, productIds, windows, fundingReceivedMinor: funding, ...result,
            baselineChosenBy: sent ? 'the_reader' : 'same_length_just_before_the_offer',
            factsFrom: 'head_office_banked_sales_average_buying_cost_and_promotion_funding_journals', asAt: deps.now(),
          },
        };
      },
    },
  ];
}
