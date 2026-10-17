// API-04 Waste analytics (D-5, roadmap v2.1 addendum, ratified R2) — "analytics aggregate by SKU/dept/reason".
//
//   GET /v1/waste/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD[&branchId=]   (waste.view)
//
// Two kinds of waste event are recorded, and both are read here: the governed WRITE-OFF (M28-FR-01 — stock leaving as a
// loss, valued at head office's own cost) and the sustainability WASTE RECORD (M28-FR-04 — what was thrown away and
// where it went). They are reported SIDE BY SIDE, each with its own SKU / department / reason breakdown, never added into
// one figure: one loss is often recorded both ways (written off, then its disposal recorded), so a single sum would count
// it twice. Both speak the same closed reason list (`WASTE_REASON_CODES`).
//
// Department: a write-off's department is the product master's primary category for that product (the same rule the
// "units by category" report uses); a product the master places nowhere is counted under "in no department". A waste
// record carries its own department. A write-off stored before D-5 (or by another path, such as a held-stock decision)
// whose reason is not on the list is counted under "unclassified" and named — never dropped (P-08).
//
// A read only: nothing is written, nothing is decided. Scope: only the caller's branches (PA-01-r1).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { aggregateWaste, type WasteEvent, type WasteRecord } from '../../../packages/waste/src/index';
import { stockReadScope, type LocationBranches } from './location-scope';
import type { StoredWriteOff } from './write-off';

export interface WasteAnalyticsDeps {
  readonly writeOffs: (tenantId: string) => Promise<readonly StoredWriteOff[]> | readonly StoredWriteOff[];
  readonly wasteRecords: (tenantId: string) => Promise<readonly WasteRecord[]> | readonly WasteRecord[];
  /** The product master's primary category per product (`null`/absent → in no department). */
  readonly departmentOf: (tenantId: string) => Promise<ReadonlyMap<string, string | null>> | ReadonlyMap<string, string | null>;
  readonly locationBranches?: LocationBranches;
  readonly now: () => string;
}

const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`));
const inWindow = (at: string, from: string, to: string): boolean => at.slice(0, 10) >= from && at.slice(0, 10) <= to;

export function wasteAnalyticsRoutes(deps: WasteAnalyticsDeps): readonly Route[] {
  return [
    {
      api: 'API-04', method: 'GET', path: '/v1/waste/analytics',
      permission: 'waste.view',
      handler: async (ctx) => {
        const from = ctx.query['from'];
        const to = ctx.query['to'];
        if (!isDate(from) || !isDate(to) || from > to) {
          throw apiError(400, {
            code: 'waste_analytics_needs_a_window',
            whatHappened: 'Waste analytics need ?from=YYYY-MM-DD and ?to=YYYY-MM-DD (from on or before to).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the window. A report reads; it never writes.',
          });
        }
        const scope = await stockReadScope(ctx, deps.locationBranches); // PA-01-r1: the caller's branches (or ?branchId=)
        const departments = await deps.departmentOf(ctx.tenantId);
        const writeOffEvents: WasteEvent[] = (await deps.writeOffs(ctx.tenantId))
          .filter((w) => scope.covers(w.locationId) && inWindow(w.at, from, to))
          .map((w) => ({
            eventId: w.id, productId: w.productId, departmentId: departments.get(w.productId) ?? null,
            reason: w.reasonCode, valueMinor: w.valueMinor, qty: w.qtyRemoved, at: w.at,
          }));
        const recordEvents: WasteEvent[] = (await deps.wasteRecords(ctx.tenantId))
          .filter((r) => (scope.everything || scope.covers(r.branchId)) && inWindow(r.at, from, to))
          .map((r) => ({ eventId: r.wasteId, productId: r.productId, departmentId: r.departmentId, reason: r.source, valueMinor: r.valueMinor, at: r.at }));
        return {
          status: 200,
          body: {
            from, to, scope: scope.scope,
            writeOffs: aggregateWaste(writeOffEvents),
            wasteRecords: aggregateWaste(recordEvents),
            note: 'Write-offs and waste records are shown side by side and never added together — one loss is often recorded both ways.',
            asAt: deps.now(),
          },
        };
      },
    },
  ];
}
