// API-10 Owner drill-through & KPI comparison (M29-FR-02 · NFR-15 · §28) — tested since the module was
// written, on NO cloud route. The owner sees "margin down 4% in Fresh" and asks the only question worth
// asking: **show me.** A drill-through that looks right and is wrong is worse than none — the owner acts on
// it — so the two rules that matter here are honesty rules, not display ones:
//
//   • THE SHOWN ROWS MUST ADD UP TO THE HEADLINE, and when they do not it is said LOUDLY, never hidden — a
//     list that nearly explains a number sends the owner to fix a problem that is really in the reporting.
//   • SCOPE IS ENFORCED (§28): rows in branches the viewer cannot see are withheld, the shown total is
//     recomputed, and the viewer is TOLD a figure exists they cannot see — very different from being shown a
//     number that does not match its own list. A comparison reconciles to the KPI too (unattributed grouped,
//     never dropped, or the rows quietly sum to less than the total).
//
// And every drill is LOGGED (§28): drilling reaches individual transactions and, through them, individual
// people's work, so who looked at what is itself a record worth keeping.
//
// The rules are the tested `drillThrough`/`compareBy`/`auditDrill` in `@sre/owner-control` (the
// services-run-on-their-tested-engine guardrail). Drill and compare are pure computes over the supplied
// source transactions; the drill records an append-only audit. Gated `owner.kpi.read`.

import type { Route, RequestContext, BranchScope } from '../../kernel/src/index';
import { apiError, narrowScope } from '../../kernel/src/index';
import type { ProducedReportView } from './index';
import {
  drillThrough, compareBy, auditDrill,
  type SourceTransaction, type Dimension, type DataScope, type DrillAudit,
} from '../../../packages/owner-control/src/index';

const DIMENSIONS: readonly Dimension[] = ['branch', 'category', 'vendor', 'staff'];
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const strArray = (v: unknown): readonly string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;
const isLabelMap = (v: unknown): v is Record<string, string> => isObj(v) && Object.values(v).every((x) => typeof x === 'string');

function readTxn(v: unknown): SourceTransaction | undefined {
  if (!isObj(v) || !isStr(v['transactionId']) || !isStr(v['at']) || !isStr(v['branchId']) || !isInt(v['amountMinor']) || !isStr(v['description'])) return undefined;
  return {
    transactionId: v['transactionId'] as string, at: v['at'] as string, branchId: v['branchId'] as string,
    amountMinor: v['amountMinor'] as number, description: v['description'] as string,
    ...(isStr(v['categoryId']) ? { categoryId: v['categoryId'] } : {}),
    ...(isStr(v['vendorId']) ? { vendorId: v['vendorId'] } : {}),
    ...(isStr(v['staffId']) ? { staffId: v['staffId'] } : {}),
  };
}
// The transactions[] from the body, or undefined if any row is malformed. An empty list is allowed.
function readTxns(v: unknown): readonly SourceTransaction[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.map(readTxn);
  return out.some((t) => t === undefined) ? undefined : (out as SourceTransaction[]);
}
// The viewer's data scope — userId is the authenticated caller (§28); the branches are the SERVER's answer (Wave 2b ·
// PA-01): what the caller's grants cover, narrowed to the `branchScope` they asked for ('all' or a list); a branch
// they do not hold is refused by name, never widened by a body. Malformed → undefined.
const scopeFor = (ctx: RequestContext, raw: unknown): DataScope | undefined => {
  const requested = raw === undefined ? undefined : raw === 'all' ? ('all' as const) : strArray(raw);
  if (requested === undefined && raw !== undefined) return undefined;
  return { userId: ctx.userId, branchScope: narrowScope(ctx, requested) };
};

/** The filters a governed drill may name (EA-05) — each report offers only those its records carry. */
export interface DrillFilters {
  /** One branch, within the reader's grant (refused by name otherwise). */
  readonly branchId?: string;
  /** Bills paid (wholly or in part) by this tender kind. */
  readonly tender?: string;
  /** Lines of products in this department. */
  readonly categoryId?: string;
}
type FilterName = 'branch' | 'tender' | 'category';
/** Which filters each governed report offers — the figure and its rows are then BOTH computed on the filtered records. */
export const REPORT_FILTERS: Readonly<Record<string, readonly FilterName[]>> = {
  sales_by_day: ['branch', 'tender'],
  sales_by_cashier: ['branch', 'tender'],
  tender_mix: ['branch'],
  units_by_category: ['branch', 'category'],
};
/** The longest period one drill may cover, in trading days (a bound, so a drill stays a reading, not a scan of years). */
export const MAX_DRILL_DAYS = 31;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (v: unknown): v is string => typeof v === 'string' && DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00.000Z`));
/** Every trading day from `from` to `to`, inclusive. */
const daysBetween = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00.000Z`); t <= Date.parse(`${to}T00:00:00.000Z`); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};

/** A drill's audit record — who reached which transactions — with the period and filters it was asked over (EA-05). */
export type GovernedDrillAudit = DrillAudit & {
  readonly period?: { readonly from: string; readonly to: string };
  readonly filters?: DrillFilters;
};

export interface DrillThroughDeps {
  /**
   * The governed report producers (audit EA-05): the drill loads the headline AND the source records from the same
   * producer that made the report, server-side — never from the caller. Absent, the governed drill refuses.
   */
  readonly produce?: (tenantId: string, reportId: string, options: { readonly tradingDay?: string; readonly scope: BranchScope; readonly filters?: Omit<DrillFilters, 'branchId'> }) => Promise<ProducedReportView>;
  readonly audits: (tenantId: string) => Promise<readonly GovernedDrillAudit[]> | readonly GovernedDrillAudit[];
  readonly recordAudit: (tenantId: string, audit: GovernedDrillAudit, key: string) => Promise<void> | void;
  readonly now: () => string;
}

export function drillThroughRoutes(deps: DrillThroughDeps): readonly Route[] {
  return [
    {
      // THE GOVERNED DRILL (audit EA-05 · M29-FR-02 · NFR-15): name a report and one of its figures; head office loads
      // the headline and the source records it was summed from — the same producer that made the report — in the
      // reader's server-derived scope, and reconciles them. Nothing about the figure or its rows comes from the caller.
      // Body: { reportId, figure, day? (YYYY-MM-DD) | period?: { from, to } (trading days, at most 31), branchScope?,
      // filters?: { branchId?, tender?, categoryId? } } — each report offers only the filters its records carry, and the
      // headline AND its rows are computed on the filtered records, server-side. Every drill is logged (§28) with its
      // period and filters.
      api: 'API-10', method: 'POST', path: '/v1/reporting/drill/governed',
      permission: 'owner.kpi.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const day = b['day'];
        const periodRaw = b['period'];
        const filtersRaw = b['filters'] === undefined ? {} : b['filters'];
        if (!isStr(b['reportId']) || !isStr(b['figure'])
          || (day !== undefined && !isDay(day))
          || (periodRaw !== undefined && !(isObj(periodRaw) && isDay(periodRaw['from']) && isDay(periodRaw['to'])))
          || (day !== undefined && periodRaw !== undefined)
          || !isObj(filtersRaw) || Object.keys(filtersRaw).some((k) => !['branchId', 'tender', 'categoryId'].includes(k))
          || Object.values(filtersRaw).some((v) => !isStr(v))) {
          throw apiError(400, { code: 'not_readable_as_a_governed_drill', whatHappened: 'A drill needs { reportId, figure } and may name { day: YYYY-MM-DD } or { period: { from, to } } (not both), { branchScope } and { filters: { branchId?, tender?, categoryId? } }. The figure and its rows are head office\'s, never sent.', wasItSaved: 'not_saved', nextSafeAction: 'Name the report and the figure to open.' });
        }
        const reportId = b['reportId'] as string;
        const figureName = b['figure'] as string;
        const filters = filtersRaw as DrillFilters;
        // Each report offers only the filters its records carry — anything else is refused by name, never ignored.
        const offered = REPORT_FILTERS[reportId] ?? ['branch'];
        const asked: FilterName[] = [...(filters.branchId === undefined ? [] : ['branch' as const]), ...(filters.tender === undefined ? [] : ['tender' as const]), ...(filters.categoryId === undefined ? [] : ['category' as const])];
        const notOffered = asked.filter((f) => !offered.includes(f));
        if (notOffered.length > 0) {
          throw apiError(400, { code: 'filter_not_offered_by_this_report', whatHappened: `${reportId} cannot be filtered by ${notOffered.join(', ')} — its records do not carry it. It offers: ${offered.join(', ') || 'none'}.`, wasItSaved: 'not_saved', nextSafeAction: 'Drop that filter, or open a report that carries it.' });
        }
        // The branch filter narrows the reader's OWN grant: a branch they do not hold is refused by name (scope_not_held).
        const scope = scopeFor(ctx, filters.branchId !== undefined ? [filters.branchId] : b['branchScope']);
        if (scope === undefined) {
          throw apiError(400, { code: 'not_readable_as_a_governed_drill', whatHappened: 'branchScope must be "all" or a list of branch ids.', wasItSaved: 'not_saved', nextSafeAction: 'Name the branches to open, or leave it out.' });
        }
        let days: readonly (string | undefined)[] = [typeof day === 'string' ? day : undefined];
        let period: { readonly from: string; readonly to: string } | undefined;
        if (isObj(periodRaw)) {
          period = { from: periodRaw['from'] as string, to: periodRaw['to'] as string };
          const span = period.from <= period.to ? daysBetween(period.from, period.to) : [];
          if (span.length === 0 || span.length > MAX_DRILL_DAYS) {
            throw apiError(400, { code: 'period_out_of_bounds', whatHappened: `A drill covers 1 to ${MAX_DRILL_DAYS} trading days, from on or before to; ${period.from} to ${period.to} is ${span.length === 0 ? 'backwards' : `${span.length} days`}.`, wasItSaved: 'not_saved', nextSafeAction: `Ask for a period of at most ${MAX_DRILL_DAYS} days.` });
          }
          days = span;
        }
        if (deps.produce === undefined) {
          throw apiError(409, { code: 'this_version_cannot_produce_it', whatHappened: 'Head office has no report producers wired, so there is nothing governed to drill into.', wasItSaved: 'not_saved', nextSafeAction: 'Open the report from the catalogue first.' });
        }
        const produceFilters = { ...(filters.tender === undefined ? {} : { tender: filters.tender }), ...(filters.categoryId === undefined ? {} : { categoryId: filters.categoryId }) };
        // Each day of the period produced by head office's own producer, on the filtered records; the period's headline is
        // the sum of the days' headlines and its rows the union of the days' rows — reconciled below like any drill.
        let kpi = 0; let found = 0;
        let unavailable: string | undefined;
        const transactions: SourceTransaction[] = [];
        let produced: ProducedReportView | undefined;
        let drillable: readonly string[] = [];
        let firstHeadline: ProducedReportView['figures'][number] | undefined;
        for (const d of days) {
          try {
            produced = await deps.produce(ctx.tenantId, reportId, { ...(d === undefined ? {} : { tradingDay: d }), scope: scope.branchScope, ...(Object.keys(produceFilters).length === 0 ? {} : { filters: produceFilters }) });
          } catch (e) {
            // Only "no such producer" is the caller's mistake; any other failure is head office's and is not dressed up.
            if (!(e instanceof Error) || !e.message.startsWith('no head-office producer')) throw e;
            throw apiError(404, { code: 'no_such_report', whatHappened: `Head office does not produce a report called "${reportId}".`, wasItSaved: 'not_saved', nextSafeAction: 'Pick a report the catalogue says can be run.' });
          }
          if (period !== undefined && produced.tradingDay === undefined) {
            throw apiError(409, { code: 'not_a_period_report', whatHappened: `${reportId} is a position (as it stands now), not a day's figures — it has no period to add up.`, wasItSaved: 'not_saved', nextSafeAction: 'Drill it without a period.' });
          }
          drillable = [...new Set([...drillable, ...Object.keys(produced.drill)])];
          const headline = produced.figures.find((f) => f.name === figureName);
          const rows = produced.drill[figureName];
          if (headline === undefined || rows === undefined) continue;
          if (headline.valueMinor === undefined) { unavailable = headline.notAvailableBecause ?? 'no source data'; continue; }
          firstHeadline ??= headline;
          kpi += headline.valueMinor; found += 1;
          transactions.push(...rows);
        }
        if (found === 0 && unavailable !== undefined) {
          throw apiError(409, { code: 'figure_not_available', whatHappened: `${figureName} is not available: ${unavailable}.`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing to drill into until the source data arrives.' });
        }
        if (found === 0 || firstHeadline === undefined) {
          throw apiError(404, { code: 'figure_not_drillable', whatHappened: `"${figureName}" is not a figure of ${reportId}${period === undefined ? '' : ` on any day from ${period.from} to ${period.to}`}${asked.length === 0 ? '' : ' with these filters'} with records behind it.`, wasItSaved: 'not_saved', nextSafeAction: `Pick one of: ${drillable.join(', ') || 'none'}.` });
        }
        const now = deps.now();
        const result = drillThrough({ metric: `${reportId}:${figureName}`, kpiValueMinor: kpi, transactions, scope });
        const audit: GovernedDrillAudit = { ...auditDrill(result, scope, now), ...(period === undefined ? {} : { period }), ...(asked.length === 0 ? {} : { filters }) };
        await deps.recordAudit(ctx.tenantId, audit, `${ctx.userId}-${result.metric}-${now}`);
        return {
          status: 200,
          body: {
            ...result, provenance: 'governed', reportId, figure: figureName, asAt: firstHeadline.asAt, staleness: firstHeadline.staleness,
            ...(period === undefined ? (produced?.tradingDay === undefined ? {} : { tradingDay: produced.tradingDay }) : { period: { ...period, days: days.length, daysWithTheFigure: found } }),
            filters: { ...filters, branchScope: scope.branchScope },
          },
        };
      },
    },
    {
      // RETIRED (audit EA-05): the drill over rows the CALLER supplied. It reconciled whatever it was sent and proved
      // nothing about head office's records; the acceptance is that caller-supplied rows are not accepted. The path is
      // kept only to say so — 410, nothing computed, nothing logged — and to point at the governed drill.
      api: 'API-10', method: 'POST', path: '/v1/reporting/drill',
      permission: 'owner.kpi.read', idempotent: true,
      handler: () => {
        throw apiError(410, {
          code: 'caller_rows_not_accepted',
          whatHappened: 'A drill-through no longer takes rows or a headline from the caller — it would prove nothing about the shop\'s own records.',
          wasItSaved: 'not_saved',
          nextSafeAction: 'Use POST /v1/reporting/drill/governed with { reportId, figure, day?, branchScope? }; head office loads the figure and its source records itself.',
        });
      },
    },
    {
      // Rank a metric across a dimension (branch/category/vendor/staff). The rows reconcile to the KPI, and
      // unattributed transactions are GROUPED not dropped. Body: { dimension, metric, transactions[],
      // branchScope?, labels? }. A pure compute.
      api: 'API-10', method: 'POST', path: '/v1/reporting/compare',
      permission: 'owner.kpi.read', idempotent: true,
      handler: (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const transactions = readTxns(b['transactions']);
        const scope = scopeFor(ctx, b['branchScope']);
        if (!DIMENSIONS.includes(b['dimension'] as Dimension) || !isStr(b['metric']) || transactions === undefined || scope === undefined
          || (b['labels'] !== undefined && !isLabelMap(b['labels']))) {
          throw apiError(400, { code: 'not_readable_as_a_comparison', whatHappened: 'A comparison needs { dimension (branch/category/vendor/staff), metric, transactions[], branchScope?, labels? }.', wasItSaved: 'not_saved', nextSafeAction: 'Send the dimension to rank by and the transactions.' });
        }
        // Still over rows the caller supplies — said on every answer (EA-05): a ranking over sent rows is a calculator,
        // not a reading of head office's records.
        const result = compareBy({
          dimension: b['dimension'] as Dimension, metric: b['metric'] as string, transactions, scope,
          ...(isLabelMap(b['labels']) ? { labels: b['labels'] } : {}),
        });
        return { status: 200, body: { ...result, provenance: 'supplied_by_caller' } };
      },
    },
    {
      // The drill audit — who reached which transactions, when, and whether they reconciled. Most recent
      // first. Drilling reaches individual people's work, so the looking is itself a record (§28).
      api: 'API-10', method: 'GET', path: '/v1/reporting/drill-audits',
      permission: 'owner.kpi.read',
      handler: async (ctx) => {
        const audits = [...(await deps.audits(ctx.tenantId))].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
        return { status: 200, body: { audits, count: audits.length } };
      },
    },
  ];
}
