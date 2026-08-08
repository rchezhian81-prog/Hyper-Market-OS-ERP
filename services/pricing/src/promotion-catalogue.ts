// API-02 the promotion catalogue and best-price basket evaluation (M05-FR-03). This is distinct from
// promotion GOVERNANCE (./promotions.ts, M05-FR-04), which simulates the margin of ONE offer and gates a
// margin-losing launch behind §28: THIS surface is the rule SET and the DETERMINISTIC best price it
// yields for a basket — "one promotion truth" (P-02), the same price online and offline.
//
// The rule is the pure `bestPrice` engine in `packages/promotions` (a complete engine nothing fed on the
// cloud): only a PUBLISHED, in-window, eligible promotion applies; within an exclusive group the single
// best-for-the-customer wins and everything else stacks; the total discount never takes a line below
// zero. This surface gives the engine a lifecycle (draft → active → stopped) and persistence, so a
// promotion is DEFINED, then deliberately ACTIVATED, then can be STOPPED — an offer never goes live by
// being typed, and evaluation only ever sees the active set.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import { bestPrice, type Promotion, type PromotionKind, type BasketLine, type PromoContext } from '../../../packages/promotions/src/promotions';
import { isCurrencyCode, type CurrencyCode, type Money } from '../../../packages/contracts/src/money';

const KINDS: readonly PromotionKind[] = ['percent_off', 'amount_off', 'buy_x_get_y', 'member_price'];
const isKind = (v: unknown): v is PromotionKind => typeof v === 'string' && (KINDS as readonly string[]).includes(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isInt = (v: unknown): v is number => Number.isInteger(v);
const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const isDateLike = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const isMoney = (v: unknown): v is Money => v !== null && typeof v === 'object' && Number.isInteger((v as Money).minor) && isCurrencyCode((v as { currency?: unknown }).currency as string);
const strArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

export interface PromotionCatalogueDeps {
  readonly promotion: (tenantId: string, promotionId: string) => Promise<Promotion | undefined> | Promotion | undefined;
  readonly promotions: (tenantId: string) => Promise<readonly Promotion[]> | readonly Promotion[];
  readonly recordDefined: (tenantId: string, promo: Promotion) => Promise<void> | void;
  readonly recordStatus: (tenantId: string, promotionId: string, status: 'active' | 'stopped', at: string) => Promise<void> | void;
  readonly now: () => string;
}

/** Read a promotion definition from the body (status is server-set to 'draft'), or null if malformed. */
function readDefinition(promotionId: string, body: unknown): Promotion | null {
  if (body === null || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (!isKind(b['kind']) || !isDateLike(b['startsAt']) || !isDateLike(b['endsAt'])) return null;
  if (Date.parse(b['endsAt'] as string) < Date.parse(b['startsAt'] as string)) return null;

  // Per-kind required parameters.
  const kind = b['kind'];
  if (kind === 'percent_off' && !(isInt(b['percentBps']) && (b['percentBps'] as number) > 0 && (b['percentBps'] as number) <= 10_000)) return null;
  if (kind === 'amount_off' && !isPosInt(b['amountOffMinor'])) return null;
  if (kind === 'buy_x_get_y' && !(isPosInt(b['buyQty']) && isPosInt(b['getQty']))) return null;
  if (kind === 'member_price' && !isMoney(b['memberUnitPrice'])) return null;

  // Optional fields, validated when present.
  if (b['productIds'] !== undefined && !strArray(b['productIds'])) return null;
  if (b['group'] !== undefined && !isStr(b['group'])) return null;
  if (b['exclusiveGroup'] !== undefined && !isStr(b['exclusiveGroup'])) return null;
  if (b['requiresCoupon'] !== undefined && !isStr(b['requiresCoupon'])) return null;
  if (b['requiresMember'] !== undefined && typeof b['requiresMember'] !== 'boolean') return null;
  if (b['maxApplications'] !== undefined && !isPosInt(b['maxApplications'])) return null;
  if (b['minSpendMinor'] !== undefined && !(isInt(b['minSpendMinor']) && (b['minSpendMinor'] as number) >= 0)) return null;

  return {
    id: promotionId, kind, startsAt: b['startsAt'] as string, endsAt: b['endsAt'] as string, status: 'draft',
    ...(strArray(b['productIds']) ? { productIds: b['productIds'] } : {}),
    ...(isStr(b['group']) ? { group: b['group'] } : {}),
    ...(isStr(b['exclusiveGroup']) ? { exclusiveGroup: b['exclusiveGroup'] } : {}),
    ...(isStr(b['requiresCoupon']) ? { requiresCoupon: b['requiresCoupon'] } : {}),
    ...(typeof b['requiresMember'] === 'boolean' ? { requiresMember: b['requiresMember'] } : {}),
    ...(isPosInt(b['maxApplications']) ? { maxApplications: b['maxApplications'] } : {}),
    ...(isInt(b['minSpendMinor']) ? { minSpendMinor: b['minSpendMinor'] as number } : {}),
    ...(isInt(b['percentBps']) ? { percentBps: b['percentBps'] as number } : {}),
    ...(isInt(b['amountOffMinor']) ? { amountOffMinor: b['amountOffMinor'] as number } : {}),
    ...(isInt(b['buyQty']) ? { buyQty: b['buyQty'] as number } : {}),
    ...(isInt(b['getQty']) ? { getQty: b['getQty'] as number } : {}),
    ...(isMoney(b['memberUnitPrice']) ? { memberUnitPrice: b['memberUnitPrice'] } : {}),
  };
}

/** Read the basket lines for evaluation, or null if any line is malformed. */
function readLines(v: unknown): BasketLine[] | null {
  if (!Array.isArray(v)) return null;
  const lines: BasketLine[] = [];
  for (const raw of v) {
    if (raw === null || typeof raw !== 'object') return null;
    const l = raw as Record<string, unknown>;
    if (!isStr(l['lineId']) || !isStr(l['productId']) || !isMoney(l['unitPrice']) || !isPosInt(l['qty'])) return null;
    if (l['group'] !== undefined && !isStr(l['group'])) return null;
    lines.push({
      lineId: l['lineId'] as string, productId: l['productId'] as string,
      unitPrice: l['unitPrice'] as Money, qty: l['qty'] as number,
      ...(isStr(l['group']) ? { group: l['group'] } : {}),
    });
  }
  return lines;
}

export function promotionCatalogueRoutes(deps: PromotionCatalogueDeps): readonly Route[] {
  return [
    {
      // Define a promotion — created as a DRAFT that never applies until it is activated (an offer must
      // not go live by being typed). Create-once: a re-definition of a live id is refused.
      api: 'API-02', method: 'POST', path: '/v1/promotions/:promotionId/definition',
      permission: 'promotion.launch', idempotent: true,
      handler: async (ctx) => {
        const promotionId = ctx.params['promotionId'] ?? '';
        const promo = readDefinition(promotionId, ctx.body);
        if (promo === null) {
          throw apiError(400, {
            code: 'not_readable_as_a_promotion',
            whatHappened: 'A promotion needs a kind (percent_off/amount_off/buy_x_get_y/member_price), an effective window, and the parameters that kind requires.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send a valid definition. Nothing was recorded.',
          });
        }
        if ((await deps.promotion(ctx.tenantId, promotionId)) !== undefined) {
          throw apiError(409, {
            code: 'promotion_already_defined',
            whatHappened: `Promotion ${promotionId} already exists — a definition is created once, then activated or stopped.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Use a new id, or stop the existing one. Nothing was changed.',
          });
        }
        await deps.recordDefined(ctx.tenantId, promo);
        return { status: 201, body: { promotionId, kind: promo.kind, status: promo.status, startsAt: promo.startsAt, endsAt: promo.endsAt } };
      },
    },
    {
      // Activate a draft — from now it can apply within its window. A stopped promotion cannot be revived.
      api: 'API-02', method: 'POST', path: '/v1/promotions/:promotionId/activate',
      permission: 'promotion.launch', idempotent: true,
      handler: async (ctx) => {
        const promotionId = ctx.params['promotionId'] ?? '';
        const promo = await deps.promotion(ctx.tenantId, promotionId);
        if (promo === undefined) throw notFound(`promotion ${promotionId}`);
        if (promo.status === 'stopped') {
          throw apiError(422, {
            code: 'promotion_stopped',
            whatHappened: `Promotion ${promotionId} has been stopped and cannot be reactivated — define a new one.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Define a fresh promotion. Nothing was changed.',
          });
        }
        if (promo.status !== 'active') await deps.recordStatus(ctx.tenantId, promotionId, 'active', deps.now());
        return { status: 200, body: { promotionId, status: 'active' } };
      },
    },
    {
      // Stop a promotion — from now it never applies, whatever its window says.
      api: 'API-02', method: 'POST', path: '/v1/promotions/:promotionId/stop',
      permission: 'promotion.launch', idempotent: true,
      handler: async (ctx) => {
        const promotionId = ctx.params['promotionId'] ?? '';
        const promo = await deps.promotion(ctx.tenantId, promotionId);
        if (promo === undefined) throw notFound(`promotion ${promotionId}`);
        if (promo.status !== 'stopped') await deps.recordStatus(ctx.tenantId, promotionId, 'stopped', deps.now());
        return { status: 200, body: { promotionId, status: 'stopped' } };
      },
    },
    {
      // Read a promotion definition and its current status.
      api: 'API-02', method: 'GET', path: '/v1/promotions/:promotionId/definition',
      permission: 'promotion.read',
      handler: async (ctx) => {
        const promotionId = ctx.params['promotionId'] ?? '';
        const promo = await deps.promotion(ctx.tenantId, promotionId);
        if (promo === undefined) throw notFound(`promotion ${promotionId}`);
        return { status: 200, body: promo };
      },
    },
    {
      // The deterministic best price for a basket, over the ACTIVE, in-window promotions — the same
      // answer online and offline. A what-if: it computes, it never commits.
      api: 'API-02', method: 'POST', path: '/v1/promotions/evaluate',
      permission: 'promotion.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as { lines?: unknown; at?: unknown; currency?: unknown; isMember?: unknown; coupons?: unknown };
        const lines = readLines(b.lines);
        if (lines === null || !isDateLike(b.at) || typeof b.currency !== 'string' || !isCurrencyCode(b.currency)
          || (b.isMember !== undefined && typeof b.isMember !== 'boolean')
          || (b.coupons !== undefined && !strArray(b.coupons))) {
          throw apiError(400, {
            code: 'not_readable_as_a_basket',
            whatHappened: 'Evaluating a basket needs lines (each with a line id, product id, unit price and whole qty), an "at" date and a currency.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the basket and context. Nothing was changed; evaluation only reads.',
          });
        }
        const promoCtx: PromoContext = {
          at: b.at, currency: b.currency as CurrencyCode,
          ...(typeof b.isMember === 'boolean' ? { isMember: b.isMember } : {}),
          ...(strArray(b.coupons) ? { coupons: b.coupons } : {}),
        };
        const all = await deps.promotions(ctx.tenantId);
        return { status: 200, body: bestPrice(lines, all, promoCtx) };
      },
    },
  ];
}
