// D-23 (R4, signed OB-227) — bought-together analysis on head office's API, over the bills head office BANKED.
//
//   GET /v1/reporting/basket-affinity?from=YYYY-MM-DD&to=YYYY-MM-DD&minBaskets=N[&department=<category id>]
//
// The baskets are the banked sales (`SaleCommitted`) booked to trading days in the window; what came back against each
// bill (`ReturnRecorded`, by its original sale) is taken out of that bill first. A department narrows every basket to the
// products whose category (or any parent of it) is that department; a product with no category is never silently put in
// one — it is counted under `productsWithoutCategory`. The minimum number of baskets is the person's input: there is no
// default, so no number is invented here. The rule is the tested `basketAffinity` engine in `packages/reporting`.
//
// What this NEVER does: write. It has no write port. Each pair carries DRAFT suggestions; the promotion draft is a body
// the page may send, as the signed-in person, to the EXISTING promotion definition route — which creates a draft that
// applies only after the existing launch approval (services/pricing/src/promotion-catalogue.ts, promotions.ts).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { basketAffinity, InvalidAffinityInputError, type Basket, type BasketReturn } from '../../../packages/reporting/src/basket-affinity';

export interface BasketAffinityDeps {
  readonly now: () => string;
  /** The banked bills booked to trading days in [fromDay, toDay], each with its lines. */
  readonly baskets: (tenantId: string, fromDay: string, toDay: string) => Promise<readonly Basket[]>;
  /** What came back against these bills (any time up to now). */
  readonly returnsAgainst: (tenantId: string, basketIds: ReadonlySet<string>) => Promise<readonly BasketReturn[]>;
  /** A product's category and every parent of it, nearest first; undefined when the product has no category on file. */
  readonly categoryChain: (tenantId: string) => Promise<(productId: string) => readonly string[] | undefined>;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const bad = (whatHappened: string): never => {
  throw apiError(400, { code: 'not_readable_as_a_basket_query', whatHappened, wasItSaved: 'not_saved', nextSafeAction: 'Correct the query. This only reads; nothing was changed.' });
};

export function basketAffinityRoutes(deps: BasketAffinityDeps): readonly Route[] {
  return [
    {
      api: 'API-10', method: 'GET', path: '/v1/reporting/basket-affinity',
      permission: 'reporting.report.read',
      handler: async (ctx) => {
        const from = ctx.query['from'] ?? '';
        const to = ctx.query['to'] ?? '';
        if (!DAY.test(from) || !DAY.test(to) || from > to) bad('A bought-together read needs ?from= and ?to= as YYYY-MM-DD days, from on or before to.');
        const rawMin = ctx.query['minBaskets'];
        if (rawMin === undefined || rawMin === '') bad('Say the minimum number of baskets a pair must be seen in (?minBaskets=). There is no default — the number is yours to choose.');
        const minBaskets = Number(rawMin);
        if (!Number.isInteger(minBaskets) || minBaskets < 1) bad('minBaskets must be a whole number of at least 1.');
        const department = (ctx.query['department'] ?? '').trim();

        const banked = await deps.baskets(ctx.tenantId, from, to);
        const returns = await deps.returnsAgainst(ctx.tenantId, new Set(banked.map((b) => b.basketId)));
        let productsWithoutCategory = 0;
        let baskets: readonly Basket[] = banked;
        if (department !== '') {
          const chainOf = await deps.categoryChain(ctx.tenantId);
          const uncategorised = new Set<string>();
          baskets = banked.map((b) => ({
            basketId: b.basketId,
            lines: b.lines.filter((l) => {
              const chain = chainOf(l.productId);
              if (chain === undefined) { uncategorised.add(l.productId); return false; }
              return chain.includes(department);
            }),
          })).filter((b) => b.lines.length > 0);
          productsWithoutCategory = uncategorised.size;
        }
        try {
          const result = basketAffinity({ baskets, returns, minBaskets });
          return {
            status: 200,
            body: {
              from, to, department: department === '' ? null : department,
              ...result,
              billsInWindow: banked.length,
              returnsTakenOut: returns.length,
              productsWithoutCategory,
              pairs: result.pairs.map((p) => ({
                ...p,
                // A promotion made from a pair is a DRAFT definition sent to the existing route by a person; it applies
                // only after the existing launch approval. Nothing here sends it.
                draftPromotion: {
                  route: '/v1/promotions/:promotionId/definition',
                  definition: { kind: 'percent_off', productIds: [p.productA, p.productB] },
                  note: 'A draft. It does nothing until it passes the promotion launch approval.',
                },
              })),
              changesAnything: false,
              asAt: deps.now(),
            },
          };
        } catch (e) {
          if (e instanceof InvalidAffinityInputError) return bad(e.message);
          throw e;
        }
      },
    },
  ];
}
