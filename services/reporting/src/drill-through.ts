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

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
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
// The viewer's data scope — userId is the authenticated caller (§28), branchScope 'all' or a branch list.
const scopeFor = (userId: string, raw: unknown): DataScope | undefined => {
  if (raw === undefined || raw === 'all') return { userId, branchScope: 'all' };
  const list = strArray(raw);
  return list === undefined ? undefined : { userId, branchScope: list };
};

export interface DrillThroughDeps {
  readonly audits: (tenantId: string) => Promise<readonly DrillAudit[]> | readonly DrillAudit[];
  readonly recordAudit: (tenantId: string, audit: DrillAudit, key: string) => Promise<void> | void;
  readonly now: () => string;
}

export function drillThroughRoutes(deps: DrillThroughDeps): readonly Route[] {
  return [
    {
      // Show the transactions behind a headline figure, within the viewer's scope, and reconcile them to it.
      // Body: { metric, kpiValueMinor, transactions[], branchScope? }. Records who drilled what (§28).
      api: 'API-10', method: 'POST', path: '/v1/reporting/drill',
      permission: 'owner.kpi.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const transactions = readTxns(b['transactions']);
        const scope = scopeFor(ctx.userId, b['branchScope']);
        if (!isStr(b['metric']) || !isInt(b['kpiValueMinor']) || transactions === undefined || scope === undefined) {
          throw apiError(400, { code: 'not_readable_as_a_drill', whatHappened: 'A drill needs { metric, kpiValueMinor (whole), transactions[] (each { transactionId, at, branchId, amountMinor, description, categoryId?, vendorId?, staffId? }), branchScope? }.', wasItSaved: 'not_saved', nextSafeAction: 'Send the figure and the transactions behind it.' });
        }
        const now = deps.now();
        const result = drillThrough({ metric: b['metric'] as string, kpiValueMinor: b['kpiValueMinor'] as number, transactions, scope });
        // Every drill is logged — who reached which transactions, and whether they added up.
        const audit = auditDrill(result, scope, now);
        await deps.recordAudit(ctx.tenantId, audit, `${ctx.userId}-${result.metric}-${now}`);
        return { status: 200, body: result };
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
        const scope = scopeFor(ctx.userId, b['branchScope']);
        if (!DIMENSIONS.includes(b['dimension'] as Dimension) || !isStr(b['metric']) || transactions === undefined || scope === undefined
          || (b['labels'] !== undefined && !isLabelMap(b['labels']))) {
          throw apiError(400, { code: 'not_readable_as_a_comparison', whatHappened: 'A comparison needs { dimension (branch/category/vendor/staff), metric, transactions[], branchScope?, labels? }.', wasItSaved: 'not_saved', nextSafeAction: 'Send the dimension to rank by and the transactions.' });
        }
        const result = compareBy({
          dimension: b['dimension'] as Dimension, metric: b['metric'] as string, transactions, scope,
          ...(isLabelMap(b['labels']) ? { labels: b['labels'] } : {}),
        });
        return { status: 200, body: result };
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
