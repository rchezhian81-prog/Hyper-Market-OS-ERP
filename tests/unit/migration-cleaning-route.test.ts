import { describe, it, expect } from 'vitest';
import { migrationRoutes, type MigrationDeps } from '../../services/migration/src/index';
import type { RequestContext, Route } from '../../services/kernel/src/index';
import type { LoadTarget, TargetKind } from '../../packages/migration/src/trial';

/**
 * **MG-04 cleaning wired on API-12: find everything wrong, and change nothing.**
 *
 * Cleaning proposes; it never decides, merges or drops (hard rules #2/#6). The route runs the tested
 * detectors over the legacy dataset and returns a severity-ordered report whose `nothingWasModified`
 * is typed `true`. It refuses a production target (hard rule #7) and a dataset it cannot read.
 * Synthetic data only.
 */

const NOW = '2026-09-12T10:00:00Z';

const deps = (targetKind: TargetKind = 'rehearsal'): MigrationDeps => ({
  target: (tenantId): LoadTarget => ({ targetId: `tgt-${tenantId}`, tenantId, kind: targetKind, label: targetKind }),
  findings: () => [], acceptances: () => [], signatures: () => [],
  recordAcceptance: () => {}, ownerId: () => 'u-owner', extractionOperator: () => 'u-op', now: () => NOW,
});

const ctx = (over: Partial<RequestContext>): RequestContext =>
  ({ tenantId: 't-sre', userId: 'u-migrator', branchId: null, params: {}, query: {}, body: undefined, traceId: 't', ...over });

const routeFor = (routes: readonly Route[], method: string, path: string): Route => {
  const r = routes.find((x) => x.method === method && x.path === path);
  if (r === undefined) throw new Error(`no route ${method} ${path}`);
  return r;
};

interface Thrown { readonly status: number; readonly body: { readonly code: string } }
async function thrown(fn: () => unknown): Promise<Thrown> {
  try { await fn(); } catch (e) { return e as Thrown; }
  throw new Error('expected the handler to throw');
}

const route = (tk: TargetKind = 'rehearsal') => routeFor(migrationRoutes(deps(tk)), 'POST', '/v1/migration/cleaning/exceptions');

const product = (over: Record<string, unknown> = {}) => ({
  legacyId: 'P1', name: 'Rice 1kg', barcode: '8900001', uom: 'kg', taxCode: 'TX',
  costMinor: 4000, priceMinor: 5000, departmentCode: 'GROC', active: true, ...over,
});

describe('POST /v1/migration/cleaning/exceptions (MG-04)', () => {
  it('finds a shared barcode and negative stock, and changes nothing', async () => {
    const res = await route().handler(ctx({ body: { dataset: {
      products: [product(), product({ legacyId: 'P2', name: 'Sugar 1kg' })], // same barcode 8900001
      stock: [{ legacyProductId: 'P1', locationCode: 'MAIN', qty: -5, valueMinor: -2000 }],
    } } }));
    expect(res.status).toBe(200);
    const r = res.body as { byKind: Record<string, number>; nothingWasModified: true };
    expect(r.byKind['shared_barcode']).toBeGreaterThanOrEqual(1);
    expect(r.byKind['negative_stock']).toBeGreaterThanOrEqual(1);
    // The read-only guarantee, stated in the payload itself.
    expect(r.nothingWasModified).toBe(true);
  });

  it('returns a clean report for a dataset with nothing wrong', async () => {
    const res = await route().handler(ctx({ body: { dataset: {
      products: [product()],
      stock: [{ legacyProductId: 'P1', locationCode: 'MAIN', qty: 10, valueMinor: 40000 }],
    } } }));
    expect(res.status).toBe(200);
    const r = res.body as { exceptions: unknown[] };
    expect(r.exceptions).toEqual([]);
  });

  it('refuses a production target and a body it cannot read as a dataset', async () => {
    expect((await thrown(() => route('production').handler(ctx({ body: { dataset: { products: [] } } })))).body.code).toBe('target_is_production');
    expect((await thrown(() => route().handler(ctx({ body: {} })))).status).toBe(400);
    // A present field that is not a list is a malformed dataset.
    expect((await thrown(() => route().handler(ctx({ body: { dataset: { products: 'lots' } } })))).body.code).toBe('not_readable_as_a_dataset');
  });
});
