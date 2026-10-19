// Product ratings in the customer app, on API-07 (R4 · M20-FR-04 · OB-74 · OB-218).
//
// A signed-in customer rates a product they BOUGHT — a delivered or collected order of their own carries it — with 1 to 5
// stars, once; a later rating replaces their own in the average and the earlier one stays in the history (append-only).
// One who never bought it is refused by name ("rate only what you bought"). Stars only: a rating carrying words is
// refused. Every read shows the average and the count, never a name or a customer reference.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  readRatingInput, ratingSummary, ratingSummaries, nextRatingVersion, currentRatings, RATE_ONLY_WHAT_YOU_BOUGHT, type RatingRecord,
} from '../../../packages/storefront/src/ratings';

export interface StorefrontRatingDeps {
  readonly ratings: (tenantId: string) => Promise<readonly RatingRecord[]>;
  readonly recordRating: (tenantId: string, r: RatingRecord) => Promise<void>;
  /** Did this customer receive this product on an order of their own (delivered or collected)? */
  readonly bought: (tenantId: string, customerRef: string, productId: string) => Promise<boolean>;
  readonly now: () => string;
}

export function storefrontRatingRoutes(deps: StorefrontRatingDeps): readonly Route[] {
  return [
    {
      // Rate a product I bought. Body: { stars: 1–5 } — nothing else.
      api: 'API-07', method: 'POST', path: '/v1/me/ratings/:productId',
      permission: 'storefront.order.place', entitlement: 'customer_app', idempotent: true,
      handler: async (ctx) => {
        const productId = (ctx.params['productId'] ?? '').trim();
        const input = readRatingInput(ctx.body);
        if (!input.ok) throw apiError(400, { code: input.code, whatHappened: `The rating was not saved: ${input.detail}.`, wasItSaved: 'not_saved', nextSafeAction: 'Tap the stars again.' });
        if (productId === '' || !(await deps.bought(ctx.tenantId, ctx.userId, productId))) {
          throw apiError(403, { code: 'rate_only_what_you_bought', whatHappened: `${RATE_ONLY_WHAT_YOU_BOUGHT}: there is no delivered order of yours with this product.`, wasItSaved: 'not_saved', nextSafeAction: 'You can rate a product once it has reached you.' });
        }
        const history = await deps.ratings(ctx.tenantId);
        const version = nextRatingVersion(history, productId, ctx.userId);
        const prior = currentRatings(history).find((r) => r.productId === productId && r.customerRef === ctx.userId);
        if (prior !== undefined && prior.stars === input.stars) return { status: 200, body: { productId, stars: prior.stars, unchanged: true, summary: ratingSummary(history, productId) } };
        const rec: RatingRecord = { productId, customerRef: ctx.userId, stars: input.stars, version, at: deps.now() };
        await deps.recordRating(ctx.tenantId, rec);
        return { status: prior === undefined ? 201 : 200, body: { productId, stars: rec.stars, replacedEarlier: prior !== undefined, summary: ratingSummary([...history, rec], productId) } };
      },
    },
    {
      // My own current ratings (the stars I gave), for the app to show.
      api: 'API-07', method: 'GET', path: '/v1/me/ratings',
      permission: 'storefront.order.read', entitlement: 'customer_app',
      handler: async (ctx) => {
        const mine = currentRatings(await deps.ratings(ctx.tenantId)).filter((r) => r.customerRef === ctx.userId).map((r) => ({ productId: r.productId, stars: r.stars, at: r.at }));
        return { status: 200, body: { ratings: mine.sort((a, b) => a.productId.localeCompare(b.productId)), count: mine.length } };
      },
    },
    {
      // Every rated product's average and count — never a name.
      api: 'API-07', method: 'GET', path: '/v1/storefront/ratings',
      permission: 'storefront.order.read', entitlement: 'customer_app',
      handler: async (ctx) => ({ status: 200, body: { ratings: ratingSummaries(await deps.ratings(ctx.tenantId)) } }),
    },
    {
      // The same, for the shop's own staff (catalogue) — still no names.
      api: 'API-07', method: 'GET', path: '/v1/catalogue/ratings',
      permission: 'catalogue.pack.read',
      handler: async (ctx) => ({ status: 200, body: { ratings: ratingSummaries(await deps.ratings(ctx.tenantId)) } }),
    },
  ];
}
