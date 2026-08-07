// API-09 Scrap & recycling (M28-FR-02) — cardboard, plastic crates, dead freezers, used oil, damaged
// stock sold for salvage. In most shops this is the one revenue stream with no paperwork and no
// controls: a man with a van comes on a Tuesday, cash changes hands, and nothing records it. The
// control is not suspicion — it is **making the number exist**. Proceeds are income and must land in
// the books; an unevidenced sale is FLAGGED, never refused (refusing just pushes it back outside the
// system); a rate well below the category's own running average is the question worth asking — of the
// RATE, not the person. The rule is the pure `reviewScrap` in `packages/waste` — another unfed engine.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  reviewScrap,
  type ScrapSale, type ScrapCategory, type ScrapDisposal,
} from '../../../packages/waste/src/index';

export type { ScrapSale } from '../../../packages/waste/src/index';

const CATEGORIES: readonly ScrapCategory[] = ['cardboard', 'plastic', 'metal', 'e_waste', 'used_oil', 'damaged_stock', 'expired_stock', 'other'];
const DISPOSALS: readonly ScrapDisposal[] = ['sold', 'recycled', 'donated', 'destroyed'];
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`));

export interface ScrapDeps {
  readonly scrapSales: (tenantId: string) => Promise<readonly ScrapSale[]> | readonly ScrapSale[];
  readonly recordScrapSale: (tenantId: string, sale: ScrapSale) => Promise<void> | void;
  readonly recordPosted: (tenantId: string, scrapId: string, at: string) => Promise<void> | void;
  readonly now: () => string;
}

export function scrapRoutes(deps: ScrapDeps): readonly Route[] {
  return [
    {
      // Record a scrap/recycling disposal. Never refused — an unevidenced or off-books one is recorded
      // and flagged on review, because refusing it just puts the transaction back outside the system.
      api: 'API-09', method: 'POST', path: '/v1/scrap/sales',
      permission: 'scrap.sale.record', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof b['scrapId'] !== 'string' || (b['scrapId'] as string).trim() === ''
          || typeof b['branchId'] !== 'string' || (b['branchId'] as string).trim() === ''
          || typeof b['category'] !== 'string' || !CATEGORIES.includes(b['category'] as ScrapCategory)
          || typeof b['disposal'] !== 'string' || !DISPOSALS.includes(b['disposal'] as ScrapDisposal)
          || !Number.isInteger(b['grams']) || (b['grams'] as number) < 0
          || !Number.isInteger(b['proceedsMinor']) || (b['proceedsMinor'] as number) < 0
          || typeof b['handledBy'] !== 'string' || (b['handledBy'] as string).trim() === '') {
          throw apiError(400, {
            code: 'not_readable_as_a_scrap_sale',
            whatHappened: 'A scrap disposal needs an id, branch, category, disposal (sold/recycled/donated/destroyed), whole grams and proceeds, and who handled it.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the disposal details. Nothing was recorded.',
          });
        }
        const sale: ScrapSale = {
          scrapId: b['scrapId'] as string, tenantId: ctx.tenantId, branchId: b['branchId'] as string,
          category: b['category'] as ScrapCategory, disposal: b['disposal'] as ScrapDisposal,
          at: isDate((b['at'] as string ?? '').slice(0, 10)) ? b['at'] as string : deps.now(),
          grams: b['grams'] as number, proceedsMinor: b['proceedsMinor'] as number, handledBy: b['handledBy'] as string,
          postedToFinance: false,
          ...(typeof b['buyerName'] === 'string' ? { buyerName: b['buyerName'] } : {}),
          ...(Array.isArray(b['evidenceRefs']) ? { evidenceRefs: (b['evidenceRefs'] as unknown[]).filter((r): r is string => typeof r === 'string') } : {}),
          ...(typeof b['recyclerRegistration'] === 'string' ? { recyclerRegistration: b['recyclerRegistration'] } : {}),
        };
        await deps.recordScrapSale(ctx.tenantId, sale);
        return { status: 201, body: { scrapId: sale.scrapId, category: sale.category, proceedsMinor: sale.proceedsMinor, postedToFinance: false } };
      },
    },
    {
      // Mark a disposal's proceeds as taken up by finance — this is what clears the off-books flag.
      api: 'API-09', method: 'POST', path: '/v1/scrap/sales/:scrapId/posted',
      permission: 'scrap.sale.record', idempotent: true,
      handler: async (ctx) => {
        const scrapId = ctx.params['scrapId'] ?? '';
        const known = (await deps.scrapSales(ctx.tenantId)).some((s) => s.scrapId === scrapId);
        if (!known) throw notFound(`scrap sale ${scrapId}`);
        await deps.recordPosted(ctx.tenantId, scrapId, deps.now());
        return { status: 200, body: { scrapId, postedToFinance: true } };
      },
    },
    {
      api: 'API-09', method: 'GET', path: '/v1/scrap/review',
      permission: 'scrap.review.read',
      handler: async (ctx) => {
        const branchId = ctx.query['branchId']; const from = ctx.query['from']; const to = ctx.query['to'];
        if (typeof branchId !== 'string' || branchId.trim() === '' || !isDate(from) || !isDate(to)) {
          throw apiError(400, { code: 'review_needs_a_branch_and_window', whatHappened: 'A scrap review needs ?branchId=&from=YYYY-MM-DD&to=YYYY-MM-DD.', wasItSaved: 'not_saved', nextSafeAction: 'Send the branch and window. A review reads, it never writes.' });
        }
        const review = reviewScrap({ branchId, sales: await deps.scrapSales(ctx.tenantId), from, to });
        return { status: 200, body: { ...review, asAt: deps.now() } };
      },
    },
  ];
}
