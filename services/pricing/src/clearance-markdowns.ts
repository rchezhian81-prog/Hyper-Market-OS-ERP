// D-16 (R3, OB-189) — a clearance product produces price-cut SUGGESTIONS that a person must approve; nothing is cut
// automatically (hard rule #5).
//
//   GET /v1/pricing/clearance-markdowns?storeId=&asOf=YYYY-MM-DD
//
// Each product the product master marks `clearance` (or the store's range has on clearance today) is put through the
// existing D-4 markdown ladder (`proposeMarkdown`, packages/demand/src/markdown.ts), batch by batch, from what head office
// holds at the store: on-hand per batch, the batch's sell-by date, the store's own selling rate and today's shelf price.
// Every suggestion is `advisoryOnly`; this route has no write at all. A person commits a suggestion through the existing
// price-change path (`POST /v1/prices/changes`), which applies the MRP ceiling, the margin floor and its second-person
// approval exactly as for any price.
//
// Said, never guessed (P-08): stock with no sell-by date on record has no shelf-life input for the ladder, so it is listed
// as `no_sell_by_date_known`; a product with no shelf price is listed as `no_shelf_price`.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { proposeMarkdown, type MarkdownProposal } from '../../../packages/demand/src/markdown';
import { salesHistory, type SoldLine } from '../../../packages/demand/src/sales-history';
import { shopToday, type ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';

export interface ClearanceBatch { readonly productId: string; readonly batchId: string | null; readonly onHandMinor: number; readonly expiry?: string }

export interface ClearanceMarkdownDeps {
  /** R1c (M01-FR-02): the shop's calendar — "today" is the shop's date, never the UTC one. */
  readonly calendar?: ShopCalendarOf;
  readonly now: () => string;
  /** The products on clearance for a store on a day: the master's lifecycle, and the store's range. */
  readonly clearanceProducts: (tenantId: string, storeId: string, onDate: string) => Promise<readonly { readonly productId: string; readonly source: 'product_master' | 'store_range' }[]>;
  /** On-hand per batch at the store (every place in it). */
  readonly batchesAtStore: (tenantId: string, storeId: string) => Promise<readonly ClearanceBatch[]>;
  /** Sold lines at the store for trading days [fromDay, toDay]. */
  readonly soldAtStore: (tenantId: string, storeId: string, fromDay: string, toDay: string) => Promise<readonly SoldLine[]>;
  /** Today's shelf price at the store, or undefined. */
  readonly shelfPriceMinor: (tenantId: string, productId: string, storeId: string, at: string) => Promise<number | undefined>;
  /** The caller may read this store (PA-01): throws by name when not. */
  readonly assertStoreInScope: (ctx: Parameters<Route['handler']>[0], storeId: string) => Promise<void>;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayNo = (d: string): number => Math.round(Date.parse(`${d}T00:00:00.000Z`) / 86_400_000);
const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);

export function clearanceMarkdownRoutes(deps: ClearanceMarkdownDeps): readonly Route[] {
  return [
    {
      api: 'API-02', method: 'GET', path: '/v1/pricing/clearance-markdowns',
      permission: 'price.change.propose',
      handler: async (ctx) => {
        const storeId = (ctx.query['storeId'] ?? '').trim();
        const asOf = ctx.query['asOf'] ?? await shopToday(deps, ctx.tenantId);
        if (storeId === '' || !DAY.test(asOf)) {
          throw apiError(400, { code: 'not_readable_as_a_clearance_query', whatHappened: 'Clearance suggestions need ?storeId= and optionally ?asOf=YYYY-MM-DD.', wasItSaved: 'not_saved', nextSafeAction: 'Correct the query. Nothing was changed; this only reads.' });
        }
        await deps.assertStoreInScope(ctx, storeId);
        const products = await deps.clearanceProducts(ctx.tenantId, storeId, asOf);
        const from = addDays(asOf, -27); // the trailing 28 days, as the D-4 markdown route uses
        const rate = new Map(salesHistory({ lines: await deps.soldAtStore(ctx.tenantId, storeId, from, asOf), from, to: asOf }).products.map((p) => [p.productId, p.avgDailyDemandMinor]));
        const batches = await deps.batchesAtStore(ctx.tenantId, storeId);
        const suggestions: (MarkdownProposal & { source: string; commitVia: string })[] = [];
        const notJudged: { productId: string; batchId: string | null; onHandMinor: number; because: 'no_sell_by_date_known' | 'no_shelf_price' | 'expired' }[] = [];
        for (const p of products) {
          const held = batches.filter((b) => b.productId === p.productId && b.onHandMinor > 0);
          if (held.length === 0) continue;
          const price = await deps.shelfPriceMinor(ctx.tenantId, p.productId, storeId, `${asOf}T12:00:00.000Z`);
          for (const b of held) {
            if (price === undefined) { notJudged.push({ productId: p.productId, batchId: b.batchId, onHandMinor: b.onHandMinor, because: 'no_shelf_price' }); continue; }
            if (b.expiry === undefined) { notJudged.push({ productId: p.productId, batchId: b.batchId, onHandMinor: b.onHandMinor, because: 'no_sell_by_date_known' }); continue; }
            const daysLeft = dayNo(b.expiry) - dayNo(asOf);
            if (daysLeft < 0) { notJudged.push({ productId: p.productId, batchId: b.batchId, onHandMinor: b.onHandMinor, because: 'expired' }); continue; }
            suggestions.push({
              ...proposeMarkdown({
                productId: p.productId, ...(b.batchId === null ? {} : { batchId: b.batchId }), remainingShelfLifeDays: daysLeft,
                onHandMinor: b.onHandMinor, avgDailyDemandMinor: rate.get(p.productId) ?? 0, currentPriceMinor: price,
              }),
              source: p.source,
              commitVia: 'POST /v1/prices/changes (a person, with the price approval path)',
            });
          }
        }
        return {
          status: 200,
          body: {
            storeId, asOf, suggestions, notJudged, clearanceProducts: products,
            advisoryOnly: true, pricesChanged: false, asAt: deps.now(),
          },
        };
      },
    },
  ];
}
