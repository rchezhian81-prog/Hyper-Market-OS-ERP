import { describe, it, expect } from 'vitest';
import { reportingRoutes, type ReportCatalogueView, type ReportingDeps } from '../../services/reporting/src/index';
import type { RequestContext, Route } from '../../services/kernel/src/index';

// CORE-01 inc1: the report catalogue (D13 / M29 / M30) is served on the running path by the tested
// `packages/reporting` engine — this proves the route delegates to that engine rather than carrying
// a second copy of the "which reports can I run, and why not" logic. The engine's own maths is
// pinned separately in `tests/unit/reporting.test.ts`; here we prove the wiring.

const NOW = '2026-08-10T10:00:00Z';

const ctx = (over: Partial<RequestContext> = {}): RequestContext => ({
  tenantId: 'sre', userId: 'owner-1', branchId: null, params: {}, query: {}, body: undefined, traceId: 't', ...over,
});

const routeFor = (routes: readonly Route[], path: string): Route => {
  const r = routes.find((x) => x.method === 'GET' && x.path === path);
  if (r === undefined) throw new Error(`no route GET ${path}`);
  return r;
};

const deps = (over: Partial<ReportingDeps> = {}): ReportingDeps => ({
  figures: () => [], now: () => NOW, ...over,
});

describe('GET /v1/reports/catalogue is served by the tested reporting engine', () => {
  it('marks a report available when the shop records what it needs and the build can produce it', async () => {
    const routes = reportingRoutes(deps({
      catalogueInputs: () => ({ records: ['sales_rung_at_the_till'], produced: ['sales_by_day'] }),
    }));
    const res = await routeFor(routes, '/v1/reports/catalogue').handler(ctx());
    expect(res.status).toBe(200);
    const body = res.body as ReportCatalogueView;

    const salesByDay = body.reports.find((e) => e.report.id === 'sales_by_day');
    expect(salesByDay?.availability.available).toBe(true);
    // The unavailable half is never dropped — the catalogue lists everything, runnable or not.
    expect(body.reports.length).toBeGreaterThan(5);
  });

  it('says WHY a report cannot run — the shop-does-not-record-it reason names the missing fact', async () => {
    const routes = reportingRoutes(deps({
      // The build can produce margin, but the shop is not recording cost prices yet.
      catalogueInputs: () => ({ records: ['sales_rung_at_the_till'], produced: ['sales_by_day', 'margin'] }),
    }));
    const body = (await routeFor(routes, '/v1/reports/catalogue').handler(ctx())).body as ReportCatalogueView;

    const margin = body.reports.find((e) => e.report.id === 'margin');
    expect(margin?.availability.available).toBe(false);
    if (margin?.availability.available === false) {
      expect(margin.availability.blockedBy).toBe('the_shop_does_not_record_it');
      expect(margin.availability.missing).toContain('cost_prices_on_the_catalogue');
    }
    // And "what would unlock most" points the owner at that same fact to record next.
    expect(body.unlockNext.map((u) => u.producer)).toContain('cost_prices_on_the_catalogue');
  });

  it('is honest with no inputs wired — everything reads as not yet available, never as a clean empty', async () => {
    const routes = reportingRoutes(deps()); // no catalogueInputs (the bare, store-less wiring)
    const body = (await routeFor(routes, '/v1/reports/catalogue').handler(ctx())).body as ReportCatalogueView;
    expect(body.reports.length).toBeGreaterThan(5);
    expect(body.reports.every((e) => e.availability.available === false)).toBe(true);
  });
});
