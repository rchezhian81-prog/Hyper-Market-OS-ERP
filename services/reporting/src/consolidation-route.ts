// API-10 Company-wide consolidation — durable ingestion + roll-up read (M01 / M29 / D13, owner decision).
//
// The pure engine (`@sre/reporting` `consolidation.ts`) rolls every branch's numbers up an effective-dated
// org and does it honestly (idempotent, correction-supersedes, worst-freshness, reconciliation, scope).
// This is its durable, per-tenant surface: branches POST their period contributions and their membership,
// the head office GETs the roll-up for any node/family/period. Everything append-only (hard rule #2); the
// resolved set is FOLDED through the engine's own `ingestContribution`, so the durable read applies the
// exact same idempotency/supersede/refuse-stale rules a fresh ingest would — one resolution path.
//
// Ingestion is gated `reporting.consolidation.manage` (a head-office/branch-feed write); reads are
// `reporting.report.read`. RBAC branch visibility (§28 · Wave 2b · audit EA-03): the reader's scope is the
// SERVER's — the branches where their grants hold the permission (`ctx.scope`), narrowed to `?scope=` when they
// ask for less; a branch they do not hold is refused by name, never widened. The total is recomputed to the
// visible branches, the rest named as withheld. A contribution or membership names a branch the writer holds.

import type { Route } from '../../kernel/src/index';
import { apiError, assertBranchInScope, narrowScope } from '../../kernel/src/index';
import { exportDomain, type ExportSpec, type ExportAudit } from '../../../packages/export/src/export';
import { AccessDeniedError, type AccessControl } from '../../../packages/rbac/src/rbac';
import {
  ingestContribution,
  consolidate,
  consolidationExportRows,
  type BranchContribution,
  type BranchMembership,
  type MetricFamily,
  type ReportScope,
} from '../../../packages/reporting/src/index';

const FAMILIES: readonly MetricFamily[] = [
  'sales', 'returns', 'margin', 'stock', 'wastage', 'purchases', 'payables', 'cash_recon', 'tax', 'workforce', 'delivery', 'exceptions',
];

export interface ConsolidationDeps {
  /** Append a contribution event (idempotent on the caller's key). The read fold resolves revisions. */
  readonly recordContribution: (tenantId: string, contribution: BranchContribution, key: string) => Promise<void> | void;
  /** The RESOLVED contributions (every event folded through `ingestContribution`). */
  readonly contributions: (tenantId: string) => Promise<readonly BranchContribution[]> | readonly BranchContribution[];
  /** Append a membership edge (append-only; a move is a later-dated edge). */
  readonly recordMembership: (tenantId: string, membership: BranchMembership, key: string) => Promise<void> | void;
  readonly memberships: (tenantId: string) => Promise<readonly BranchMembership[]> | readonly BranchMembership[];
  readonly now: () => string;
  /**
   * The export leg (audit EA-04 · M30-FR-02): the caller's authority for this tenant — the SAME per-tenant resolver the
   * kernel uses — and the append-only export audit ledger. Absent, the export route refuses rather than writing a file
   * nobody is recorded as having taken.
   */
  readonly access?: (tenantId: string) => Promise<AccessControl> | AccessControl;
  readonly recordExport?: (tenantId: string, record: ExportAudit, key: string) => Promise<void> | void;
}

/** The roll-up's open CSV (M30-FR-02): one row per contributing branch, branch-scoped, permission-checked, logged. */
export const CONSOLIDATION_EXPORT_SPEC: ExportSpec = {
  domain: 'reporting.consolidation',
  requires: 'reporting.report.read',
  branchColumn: 'branch_id',
  columns: [
    { name: 'branch_id', type: 'text' },
    { name: 'family', type: 'enum' },
    { name: 'period', type: 'text' },
    { name: 'gross_minor', type: 'money_minor' },
    { name: 'net_minor', type: 'money_minor' },
    { name: 'commission_minor', type: 'money_minor' },
  ],
};

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`));
const isWholeNonNeg = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** Read a measures map — every value must be a finite integer (money minor units or a count). */
function readMeasures(v: unknown): Readonly<Record<string, number>> | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== 'number' || !Number.isInteger(val)) return undefined;
    out[k] = val;
  }
  return out;
}

const DEFAULT_STALE_SECONDS = 86_400; // a day — a branch that hasn't synced in a day is stale on the roll-up

export function consolidationRoutes(deps: ConsolidationDeps): readonly Route[] {
  return [
    {
      // A branch posts one family's numbers for one period. Idempotent by revision (the engine decides):
      // same revision → ignored (never doubles), higher → replaces (late/corrected), lower → refused stale.
      api: 'API-10', method: 'POST', path: '/v1/consolidation/contributions',
      permission: 'reporting.consolidation.manage', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const measures = readMeasures(b['measures']);
        if (!isStr(b['branchId']) || !isStr(b['period']) || !isStr(b['family']) || !FAMILIES.includes(b['family'] as MetricFamily)
          || measures === undefined || !isWholeNonNeg(b['revision'])
          || (b['lastRefreshAt'] !== null && typeof b['lastRefreshAt'] !== 'string')) {
          throw apiError(400, {
            code: 'not_readable_as_a_contribution',
            whatHappened: `A consolidation contribution needs { branchId, period, family (one of ${FAMILIES.join('/')}), measures (whole-number map), lastRefreshAt (ISO or null), revision (whole ≥0) }.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the branch, period, family, measures, lastRefreshAt and revision.',
          });
        }
        const incoming: BranchContribution = {
          branchId: b['branchId'] as string,
          period: b['period'] as string,
          family: b['family'] as MetricFamily,
          measures,
          lastRefreshAt: (b['lastRefreshAt'] as string | null) ?? null,
          revision: b['revision'] as number,
        };
        assertBranchInScope(ctx, incoming.branchId); // a branch feed writes its own branch (PA-01)
        const current = await deps.contributions(ctx.tenantId);
        const result = ingestContribution(current, incoming);
        // Only a real state change is written; a duplicate or a stale arrival appends nothing (append-only,
        // and the store never grows a no-op event).
        if (result.outcome === 'ingested' || result.outcome === 'replaced_by_correction') {
          await deps.recordContribution(ctx.tenantId, incoming, ctx.idempotencyKey ?? `${incoming.branchId}-${incoming.period}-${incoming.family}-${incoming.revision}`);
        }
        return { status: 200, body: { outcome: result.outcome, detail: result.detail } };
      },
    },
    {
      // A branch's membership under a parent, from a date (append-only; a move is a later-dated edge).
      api: 'API-10', method: 'POST', path: '/v1/consolidation/memberships',
      permission: 'reporting.consolidation.manage', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['branchId']) || !isStr(b['parentId']) || !isDate(b['from']) || (b['to'] !== undefined && b['to'] !== null && !isDate(b['to']))) {
          throw apiError(400, {
            code: 'not_readable_as_a_membership',
            whatHappened: 'A membership needs { branchId, parentId, from (YYYY-MM-DD), to (YYYY-MM-DD or null) }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the branch, its parent and the effective-from date.',
          });
        }
        const membership: BranchMembership = {
          branchId: b['branchId'] as string,
          parentId: b['parentId'] as string,
          from: b['from'] as string,
          to: isDate(b['to']) ? (b['to'] as string) : null,
        };
        assertBranchInScope(ctx, membership.branchId);
        await deps.recordMembership(ctx.tenantId, membership, ctx.idempotencyKey ?? `${membership.branchId}-${membership.from}`);
        return { status: 201, body: { membership } };
      },
    },
    {
      // Roll a family up to a node for a period. ?node=&family=&period= required; ?asOf= (ISO, defaults now),
      // ?staleAfterSeconds= (default a day), ?scope= (comma branch ids within the caller's own scope; absent = everything they hold, §28).
      api: 'API-10', method: 'GET', path: '/v1/consolidation',
      permission: 'reporting.report.read',
      handler: async (ctx) => {
        const node = ctx.query['node']; const family = ctx.query['family']; const period = ctx.query['period'];
        if (!isStr(node) || !isStr(family) || !FAMILIES.includes(family as MetricFamily) || !isStr(period)) {
          throw apiError(400, {
            code: 'not_readable_as_a_consolidation_query',
            whatHappened: `A roll-up needs ?node=&family=(one of ${FAMILIES.join('/')})&period=. Optional: ?asOf=ISO, ?staleAfterSeconds=, ?scope=br-1,br-2.`,
            wasItSaved: 'unknown',
            nextSafeAction: 'Add the node, family and period. A roll-up reads, it never writes.',
          });
        }
        const scopeQ = ctx.query['scope'];
        const requested = isStr(scopeQ) ? scopeQ.split(',').map((s) => s.trim()).filter((s) => s !== '') : undefined;
        // The viewer's scope is the SERVER's answer (Wave 2b · EA-03): what their grants cover, narrowed to what they
        // asked for; a branch they do not hold is refused by name, never silently widened to the company.
        const scope: ReportScope = { userId: ctx.userId, branchScope: narrowScope(ctx, requested) };
        const staleQ = Number(ctx.query['staleAfterSeconds']);
        const report = consolidate({
          nodeId: node,
          family: family as MetricFamily,
          period,
          contributions: await deps.contributions(ctx.tenantId),
          memberships: await deps.memberships(ctx.tenantId),
          scope,
          asOf: isStr(ctx.query['asOf']) ? (ctx.query['asOf'] as string) : deps.now(),
          staleAfterSeconds: Number.isInteger(staleQ) && staleQ > 0 ? staleQ : DEFAULT_STALE_SECONDS,
        });
        return { status: 200, body: report };
      },
    },
    {
      // EXPORT the roll-up the reader is looking at (audit EA-04 · M30-FR-02): the same server-scoped `consolidate`, out
      // through the one authorised export engine — permission, branch scope and redaction decided against the caller's
      // real authority — and LOGGED (the audit record is the only evidence afterwards of who took the data). A branch
      // view exports only its branch. Body: { node, family, period, scope? (one branch, or absent for what they hold) }.
      api: 'API-10', method: 'POST', path: '/v1/consolidation/export',
      permission: 'reporting.report.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const node = b['node']; const family = b['family']; const period = b['period']; const scopeB = b['scope'];
        if (!isStr(node) || !isStr(family) || !FAMILIES.includes(family as MetricFamily) || !isStr(period) || (scopeB !== undefined && !isStr(scopeB))) {
          throw apiError(400, {
            code: 'not_readable_as_a_consolidation_export',
            whatHappened: `An export needs { node, family (one of ${FAMILIES.join('/')}), period } and may name one branch as { scope }.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the node, family and period of the view being exported.',
          });
        }
        if (deps.access === undefined || deps.recordExport === undefined) {
          throw apiError(503, {
            code: 'export_not_wired',
            whatHappened: 'Head office cannot record who takes an export here, so nothing was written out.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Try again on the full head-office service.',
          });
        }
        const branchScope = narrowScope(ctx, isStr(scopeB) ? [scopeB] : undefined);
        const report = consolidate({
          nodeId: node, family: family as MetricFamily, period,
          contributions: await deps.contributions(ctx.tenantId),
          memberships: await deps.memberships(ctx.tenantId),
          scope: { userId: ctx.userId, branchScope },
          asOf: deps.now(), staleAfterSeconds: DEFAULT_STALE_SECONDS,
        });
        const at = deps.now();
        // One branch → the export is that branch's (the engine filters by it); otherwise a company-wide export, which
        // the engine allows only to someone whose grant is company-wide for this permission.
        const branchId = branchScope !== 'all' && branchScope.length === 1 ? branchScope[0]! : null;
        let result: ReturnType<typeof exportDomain>;
        try {
          result = exportDomain(CONSOLIDATION_EXPORT_SPEC, consolidationExportRows(report), await deps.access(ctx.tenantId), { userId: ctx.userId, branchId, at });
        } catch (e) {
          if (e instanceof AccessDeniedError) {
            throw apiError(403, {
              code: 'export_not_permitted',
              whatHappened: 'You may not export this view of the company report.',
              wasItSaved: 'not_saved',
              nextSafeAction: `This export needs '${CONSOLIDATION_EXPORT_SPEC.requires}' over ${branchId === null ? 'the whole company' : `branch ${branchId}`}.`,
            });
          }
          throw e;
        }
        await deps.recordExport(ctx.tenantId, result.audit, ctx.idempotencyKey ?? `consolidation-${node}-${family}-${period}-${at}`);
        return { status: 200, body: { csv: result.csv, rows: result.audit.rowCount, audit: result.audit } };
      },
    },
  ];
}
