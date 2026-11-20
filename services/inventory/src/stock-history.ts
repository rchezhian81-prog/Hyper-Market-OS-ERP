// API-04 — STOCK HISTORY reads for the office's stock pages (batch 20b · the owner's missing-options audit of 19 Nov):
//
//   • S3 — EARLIER COUNTS and COUNT ACCURACY (M09-FR-04 "count-variance and accuracy reports"): every reconciled count in a
//     date range, by its human number, with what it found, and how accurate the counting was over the range.
//   • S4 — WHAT THE EMPTY SHELVES COST (M08-FR-04 "stockouts"): head office's estimate from its own records, its basis
//     stated, "not known" where it cannot be worked out (packages/stock/src/stockout-estimate.ts).
//   • S5 — HOW TO SHARE STOCK (M09-FR-03 "recommend inter-store transfers"): what is out where it sells while another of our
//     places holds it — a SUGGESTION only. Nothing moves: a person starts the transfer on Transfers (P-05 · hard rule #5).
//
// All three are READ-ONLY (nothing is appended), scoped to the reader's branches (PA-01-r1), and say what they could not do.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { shopDateIn } from '../../../packages/calendar/src/shop-clock';
import { ratioBp } from '../../../packages/stock/src/metrics';
import { estimateStockout, shelfDaysOf, type DatedStockChange, type StockoutEstimateRow } from '../../../packages/stock/src/stockout-estimate';
import { stockReadScope, type LocationBranches } from './location-scope';
import type { StoredReconciliation } from './counts';

/** One reconciled count as the history lists it — by its number, never its internal id alone. */
export interface CountHistoryRow {
  readonly countId: string;
  /** `CNT1/26-27/00001` — the count's own, or its plan's for a planned count; null for a count from before numbering. */
  readonly documentNumber: string | null;
  readonly productId: string;
  readonly locationId: string;
  readonly shopDate: string;
  readonly at: string;
  readonly expectedMinor: number;
  readonly countedMinor: number;
  readonly varianceMinor: number;
  /** The money value of the difference (paise, magnitude), or null when head office held no cost for it. */
  readonly valueMinor: number | null;
  readonly uom: string | null;
  readonly requiredApproval: boolean;
  readonly counterId: string;
  readonly approvedBy: string | null;
  readonly reasonCode: string;
}

/** Count accuracy over a range (M09-FR-04). Each share is in basis points, or null when it cannot be stated. */
export interface CountAccuracy {
  readonly counts: number;
  readonly matched: number;
  readonly short: number;
  readonly over: number;
  /** Counts that found exactly what the record said ÷ all counts. */
  readonly exactBp: number | null;
  /** 1 − (units off ÷ units the record expected), never below 0. */
  readonly unitsBp: number | null;
  readonly shortValueMinor: number;
  readonly overValueMinor: number;
  /** Counts whose difference has no value (no cost held) — said, never summed as zero. */
  readonly withoutValue: number;
}

export function countAccuracyOf(rows: readonly CountHistoryRow[]): CountAccuracy {
  const matched = rows.filter((r) => r.varianceMinor === 0).length;
  const short = rows.filter((r) => r.varianceMinor < 0).length;
  const expected = rows.reduce((s, r) => s + Math.abs(r.expectedMinor), 0);
  const off = rows.reduce((s, r) => s + Math.abs(r.varianceMinor), 0);
  const exact = ratioBp(matched, rows.length, 'no counts');
  const offShare = ratioBp(off, expected, 'nothing was expected');
  return {
    counts: rows.length, matched, short, over: rows.length - matched - short,
    exactBp: exact.kind === 'ratio' ? exact.bp : null,
    unitsBp: offShare.kind === 'ratio' ? Math.max(0, 10_000 - offShare.bp) : null,
    shortValueMinor: rows.filter((r) => r.varianceMinor < 0).reduce((s, r) => s + (r.valueMinor ?? 0), 0),
    overValueMinor: rows.filter((r) => r.varianceMinor > 0).reduce((s, r) => s + (r.valueMinor ?? 0), 0),
    withoutValue: rows.filter((r) => r.varianceMinor !== 0 && r.valueMinor === null).length,
  };
}

/**
 * The counts that stand: a recount supersedes the count it recounts (WF-08), and a decided count's latest state is the
 * one folded in by the caller. Each takes its own number or its plan's.
 */
export function countHistoryRows(recs: readonly StoredReconciliation[], planNumber: (planId: string) => string | undefined, timeZone?: string): readonly CountHistoryRow[] {
  const superseded = new Set(recs.map((r) => r.recountOf).filter((x): x is string => typeof x === 'string'));
  return recs.filter((r) => !superseded.has(r.countId)).map((r) => ({
    countId: r.countId,
    documentNumber: r.documentNumber ?? (r.planId === undefined ? undefined : planNumber(r.planId)) ?? null,
    productId: r.productId, locationId: r.locationId, shopDate: shopDateIn(r.at, timeZone), at: r.at,
    expectedMinor: r.expectedMinor, countedMinor: r.countedMinor, varianceMinor: r.varianceMinor,
    valueMinor: (r.governanceFlags ?? []).includes('value_unknown') ? null : Math.abs(r.valueMinor),
    uom: r.uom ?? null, requiredApproval: r.requiredApproval, counterId: r.counterId, approvedBy: r.approvedBy, reasonCode: r.reasonCode,
  })).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.countId < b.countId ? -1 : 1));
}

/** One transfer suggestion (S5): structured, so the screen words it and offers to start it. */
export interface TransferSuggestionRow {
  readonly productId: string;
  readonly toLocationId: string;
  readonly fromLocationId: string;
  /** Where the stock is: the store's own back store, head office's warehouse, or another store. */
  readonly fromKind: 'own_back_store' | 'head_office_warehouse' | 'another_store';
  readonly heldAtSourceMinor: number;
  readonly onHandHereMinor: number;
  readonly soldHereLast7DaysMinor: number;
}

export interface StockHistoryDeps {
  readonly now: () => string;
  readonly locationBranches?: LocationBranches;
  /** Every reconciled count (latest state of each). */
  readonly countRecords: (tenantId: string) => Promise<readonly StoredReconciliation[]>;
  /** Each count plan's number (`CNT1/…`), by plan id. */
  readonly planNumbers: (tenantId: string) => Promise<ReadonlyMap<string, string>>;
  /** Every stock movement, dated by the shop's clock. */
  readonly stockChanges: (tenantId: string) => Promise<readonly DatedStockChange[]>;
  /** Head office's gross margin per item over [from, to] (GMROI's figure); absent for an item whose margin it cannot state. */
  readonly grossMargins: (tenantId: string, opts: { readonly from: string; readonly to: string; readonly covers?: (l: string) => boolean }) => Promise<ReadonlyMap<string, number>>;
  /** A03's transfer leg (round 8), as structured rows. */
  readonly transferSuggestions: (tenantId: string) => Promise<readonly TransferSuggestionRow[]>;
  /** Each item's unit (the product master's base unit), so the screen says quantities in the shop's words. */
  readonly productUoms?: (tenantId: string) => Promise<ReadonlyMap<string, string>>;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const daysBefore = (date: string, n: number): string => { const t = new Date(`${date}T00:00:00.000Z`); t.setUTCDate(t.getUTCDate() - n); return t.toISOString().slice(0, 10); };

/** A date range from `?from=&to=` (shop dates), defaulting to the last 30 days; refused in plain words when unreadable. */
export function dateRangeOf(query: Readonly<Record<string, string | undefined>>, today: string, defaultDays = 30): { readonly from: string; readonly to: string } {
  const from = query['from'] ?? daysBefore(today, defaultDays - 1);
  const to = query['to'] ?? today;
  if (!DATE.test(from) || !DATE.test(to) || from > to || daysBefore(to, 366) > from) {
    throw apiError(400, {
      code: 'not_readable_as_a_date_range',
      whatHappened: 'The dates could not be read: give a "from" and a "to" day (YYYY-MM-DD), the "from" day not after the "to" day, at most a year apart.',
      wasItSaved: 'not_saved',
      nextSafeAction: 'Choose the two days again. Nothing was changed.',
    });
  }
  return { from, to };
}

export function stockHistoryRoutes(deps: StockHistoryDeps): readonly Route[] {
  const uomsOf = async (tenantId: string): Promise<Record<string, string>> => Object.fromEntries(deps.productUoms === undefined ? [] : await deps.productUoms(tenantId));
  return [
    {
      // S3 · M09-FR-04: the counts in a date range (newest first), by number, and how accurate they were. ?locationId= narrows.
      api: 'API-04', method: 'GET', path: '/v1/inventory/count-history',
      permission: 'count.view',
      handler: async (ctx) => {
        const range = dateRangeOf(ctx.query, shopDateIn(deps.now()));
        const scope = await stockReadScope(ctx, deps.locationBranches);
        const place = ctx.query['locationId'];
        const product = ctx.query['productId'];
        const plans = await deps.planNumbers(ctx.tenantId);
        const rows = countHistoryRows(await deps.countRecords(ctx.tenantId), (p) => plans.get(p))
          .filter((r) => scope.covers(r.locationId) && r.shopDate >= range.from && r.shopDate <= range.to
            && (place === undefined || place === '' || r.locationId === place) && (product === undefined || product === '' || r.productId === product));
        return { status: 200, body: { ...range, counts: rows, accuracy: countAccuracyOf(rows), productUoms: await uomsOf(ctx.tenantId), scope: scope.scope, asAt: deps.now() } };
      },
    },
    {
      // S4 · M08-FR-04: what the empty shelves cost over the last ?days= (7–90, default 28) shop days — an ESTIMATE.
      api: 'API-04', method: 'GET', path: '/v1/inventory/stockout-estimate',
      permission: 'inventory.availability.read',
      handler: async (ctx) => {
        const asAt = deps.now();
        const days = ctx.query['days'] === undefined ? 28 : Number(ctx.query['days']);
        if (!Number.isInteger(days) || days < 7 || days > 90) {
          throw apiError(400, { code: 'not_readable_as_a_period', whatHappened: 'The period must be a whole number of days from 7 to 90.', wasItSaved: 'not_saved', nextSafeAction: 'Choose the period again. Nothing was changed.' });
        }
        const to = shopDateIn(asAt);
        const from = daysBefore(to, days - 1);
        const scope = await stockReadScope(ctx, deps.locationBranches);
        const shelves = shelfDaysOf(await deps.stockChanges(ctx.tenantId), from, to, scope.covers);
        const margins = await deps.grossMargins(ctx.tenantId, { from: new Date(`${from}T00:00:00.000+05:30`).toISOString(), to: asAt, ...(scope.everything ? {} : { covers: scope.covers }) });
        const soldByProduct = new Map<string, number>();
        for (const s of shelves) soldByProduct.set(s.productId, (soldByProduct.get(s.productId) ?? 0) + s.unitsSoldMinor);
        const estimate = estimateStockout(shelves, (p) => {
          const m = margins.get(p);
          return m === undefined ? undefined : { grossMarginMinor: m, unitsSoldMinor: soldByProduct.get(p) ?? 0 };
        });
        const rows: readonly StockoutEstimateRow[] = estimate.rows;
        return {
          status: 200,
          body: {
            from, to, days, rows, knownLostMarginMinor: estimate.knownLostMarginMinor, notKnownCount: estimate.notKnownCount,
            productUoms: await uomsOf(ctx.tenantId), isEstimate: true,
            basis: {
              emptyDay: 'A day counts as empty when the stock record showed none at the start of the day and nothing of it was sold that day. Days before the place first had the item are not counted.',
              normalSales: 'Normal sales a day = what sold over these days ÷ the days it was not empty.',
              marginEach: 'Margin each = the item\'s gross margin over these days (sales before GST less the cost of what sold, as for GMROI) ÷ what sold.',
              estimate: 'Lost = empty days × normal sales a day × margin each. A sale that never happened leaves no bill, so this is an estimate, never part of the actual figures.',
            },
            scope: scope.scope, asAt,
          },
        };
      },
    },
    {
      // S5 · M09-FR-03: what to move where — a suggestion only; a person starts the transfer on Transfers.
      api: 'API-04', method: 'GET', path: '/v1/inventory/transfer-suggestions',
      permission: 'inventory.availability.read',
      handler: async (ctx) => {
        const scope = await stockReadScope(ctx, deps.locationBranches);
        // Both ends must be the reader's (least privilege): a store manager is not told another branch's stock.
        const suggestions = (await deps.transferSuggestions(ctx.tenantId)).filter((s) => scope.covers(s.toLocationId) && scope.covers(s.fromLocationId));
        return { status: 200, body: { suggestions, productUoms: await uomsOf(ctx.tenantId), suggestionOnly: true, scope: scope.scope, asAt: deps.now() } };
      },
    },
  ];
}
