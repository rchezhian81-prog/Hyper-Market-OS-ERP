// API-04 the range-gap report (D02-FR-04 "range gaps and private label" · OB-319, owner, 23 Oct 2026, in writing: "a gap
// report from our own facts — short-picks, failed substitutions and no-result searches per category and price band — plus
// private-label margin against branded").
//
//   GET /v1/merchandising/range-gaps?from=YYYY-MM-DD&to=YYYY-MM-DD&bandEdgesMinor=5000,20000
//
// Every figure is folded from head office's own records in the window — never typed by the reader:
//   • short-picks and failed substitutions from the online orders' substitution record (the ordered product, its price,
//     its category on the product master);
//   • no-result searches from the app's search-miss register (by the words searched — nothing else is kept);
//   • private label against branded from the banked sales (net of tax) and each product's average buying cost, the own
//     brand being the product's EPR own-brand declaration — one fact, one place.
// The price bands are the reader's: none sent is ONE band, "all prices", said; a product with no known cost makes its
// side's margin "not known", named — never a margin costed at zero (P-08). The folds are the tested `rangeGaps` and
// `privateLabelMargins`. Read-only, `merchandising.range.read`.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { rangeGaps, privateLabelMargins, priceBands, type GapFact, type SearchMiss, type SoldProduct } from '../../../packages/merchandising/src/index';

export interface RangeGapDeps {
  readonly gapFacts: (tenantId: string, fromIso: string, toIso: string) => Promise<readonly GapFact[]>;
  readonly searchMisses: (tenantId: string, fromIso: string, toIso: string) => Promise<readonly SearchMiss[]>;
  readonly categoryOf: (tenantId: string) => Promise<(productId: string) => string | null>;
  readonly sold: (tenantId: string, fromIso: string, toIso: string) => Promise<readonly SoldProduct[]>;
  readonly privateLabel: (tenantId: string) => Promise<ReadonlySet<string>>;
  readonly now: () => string;
}

const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

export function rangeGapRoutes(deps: RangeGapDeps): readonly Route[] {
  return [
    {
      api: 'API-04', method: 'GET', path: '/v1/merchandising/range-gaps',
      permission: 'merchandising.range.read',
      handler: async (ctx) => {
        const { from, to } = ctx.query;
        const edgesRaw = ctx.query['bandEdgesMinor'];
        const edges = edgesRaw === undefined || edgesRaw === '' ? [] : edgesRaw.split(',').map((e) => Number(e.trim()));
        if (!isDay(from) || !isDay(to) || to < from || edges.some((e) => !Number.isSafeInteger(e) || e <= 0)) {
          throw apiError(400, {
            code: 'not_readable_as_a_range_gap_report',
            whatHappened: 'The range-gap report needs ?from=YYYY-MM-DD&to=YYYY-MM-DD (to on or after from), and optionally the price-band edges in paise, ascending, as bandEdgesMinor=5000,20000.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the window (and the bands you want). Nothing was changed; this only reads.',
          });
        }
        const fromIso = `${from}T00:00:00.000Z`;
        const toIso = new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000).toISOString();
        const [facts, misses, categoryOf, sold, own] = await Promise.all([
          deps.gapFacts(ctx.tenantId, fromIso, toIso), deps.searchMisses(ctx.tenantId, fromIso, toIso), deps.categoryOf(ctx.tenantId),
          deps.sold(ctx.tenantId, fromIso, toIso), deps.privateLabel(ctx.tenantId),
        ]);
        const bands = priceBands(edges);
        const gaps = rangeGaps({ facts, categoryOf, bands });
        const privateLabel = privateLabelMargins({ sold, categoryOf, isPrivateLabel: (id) => own.has(id) });
        return {
          status: 200,
          body: {
            from, to, bands: bands.map((b) => b.label), bandsChosenBy: edges.length === 0 ? 'none_sent_one_band' : 'the_reader',
            gaps, searchesWithNoResult: [...misses].sort((a, b) => b.count - a.count || a.words.localeCompare(b.words)),
            privateLabel, privateLabelProducts: own.size,
            totals: {
              shortPicks: gaps.reduce((s, g) => s + g.shortPicks, 0), failedSubstitutions: gaps.reduce((s, g) => s + g.failedSubstitutions, 0),
              searchesWithNoResult: misses.reduce((s, m) => s + m.count, 0),
            },
            factsFrom: 'head_office_substitution_record_search_misses_banked_sales_and_epr_own_brand', asAt: deps.now(),
          },
        };
      },
    },
  ];
}
