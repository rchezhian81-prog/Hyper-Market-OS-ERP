import { describe, it, expect } from 'vitest';
import { migrationRoutes, type MigrationDeps } from '../../services/migration/src/index';
import type { RequestContext, Route } from '../../services/kernel/src/index';
import type { LoadTarget, TargetKind } from '../../packages/migration/src/trial';
import type { ControlTotal } from '../../packages/migration/src/reconcile';

/**
 * **MG-05 trial-load + MG-06 reconciliation wired on API-12.**
 *
 * MG-05 runs a full-volume load into a NON-production rehearsal and refuses one that rehearses nothing
 * (no operator, unverified extract, open blocking exceptions, target not empty). MG-06 decides QG-07,
 * and refuses the total that reconciles because both sides were derived the same way — the mistake
 * nobody notices because the report is green. Both refuse a production target (hard rule #7).
 */

const NOW = '2026-09-12T10:00:00Z';

const deps = (targetKind: TargetKind = 'rehearsal'): MigrationDeps => ({
  target: (tenantId): LoadTarget => ({ targetId: `tgt-${tenantId}`, tenantId, kind: targetKind, label: targetKind }),
  findings: () => [], acceptances: () => [], signatures: () => [],
  recordAcceptance: () => {}, ownerId: () => 'u-owner', extractionOperator: () => 'u-op', now: () => NOW,
});

const ctx = (over: Partial<RequestContext>): RequestContext =>
  ({ tenantId: 't-sre', userId: 'u-operator', branchId: null, params: {}, query: {}, body: undefined, traceId: 't', ...over });

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

const trialRoute = (tk: TargetKind = 'rehearsal') => routeFor(migrationRoutes(deps(tk)), 'POST', '/v1/migration/trial-loads');
const reconcileRoute = (tk: TargetKind = 'rehearsal') => routeFor(migrationRoutes(deps(tk)), 'POST', '/v1/migration/reconciliation');

const goodTrial = (over: Record<string, unknown> = {}) => ({
  rowsToLoad: 1000, elapsedMs: 5000, extractVerified: true, blockingExceptionsOpen: 0,
  targetPreparedEmpty: true, fullVolumeRows: 50000, ...over,
});

describe('POST /v1/migration/trial-loads (MG-05)', () => {
  it('runs a clean rehearsal and projects the full-volume time', async () => {
    const res = await trialRoute().handler(ctx({ body: goodTrial() }));
    expect(res.status).toBe(200);
    const r = res.body as { ok: boolean; repeatable: boolean; projectedFullVolumeMs: number };
    expect(r.ok).toBe(true);
    expect(r.repeatable).toBe(true);
    expect(r.projectedFullVolumeMs).toBe(250000); // 5000ms/1000 rows * 50000 rows
  });

  it('refuses a rehearsal that rehearses nothing — unverified extract, open blockers, non-empty target', async () => {
    expect((await thrown(() => trialRoute().handler(ctx({ body: goodTrial({ extractVerified: false }) })))).body.code).toBe('extract_not_verified');
    expect((await thrown(() => trialRoute().handler(ctx({ body: goodTrial({ blockingExceptionsOpen: 3 }) })))).body.code).toBe('blocking_exceptions_open');
    expect((await thrown(() => trialRoute().handler(ctx({ body: goodTrial({ targetPreparedEmpty: false }) })))).body.code).toBe('target_not_empty');
  });

  it('refuses a production target and a malformed body', async () => {
    expect((await thrown(() => trialRoute('production').handler(ctx({ body: goodTrial() })))).body.code).toBe('target_is_production');
    expect((await thrown(() => trialRoute().handler(ctx({ body: { rowsToLoad: 1000 } })))).status).toBe(400);
  });
});

describe('POST /v1/migration/reconciliation (MG-06)', () => {
  const total = (over: Partial<ControlTotal> = {}): ControlTotal => ({
    totalId: 'CT-stock', tenantId: 't-sre', kind: 'stock', name: 'Stock value', unit: 'minor_currency',
    legacyValue: 100000, loadedValue: 100000,
    legacyDerivation: 'SUM(value) from legacy stock export',
    loadedDerivation: 'SUM(value_minor) from loaded stock_levels',
    ...over,
  });

  it('reconciles a matching, signed total and passes QG-07', async () => {
    const signed = total({ signature: { signedBy: 'u-ca', signerRole: 'chartered_accountant', signedAt: NOW, statement: 'checked' } });
    const res = await reconcileRoute().handler(ctx({ body: { totals: [signed] } }));
    expect(res.status).toBe(200);
    const r = res.body as { qg07Passed: boolean; open: unknown[] };
    expect(r.qg07Passed).toBe(true);
    expect(r.open).toEqual([]);
  });

  it('leaves an unexplained difference OPEN and blocks QG-07', async () => {
    const res = await reconcileRoute().handler(ctx({ body: { totals: [total({ loadedValue: 99000 })] } }));
    const r = res.body as { qg07Passed: boolean; open: { totalId: string }[] };
    expect(r.qg07Passed).toBe(false);
    expect(r.open.map((o) => o.totalId)).toContain('CT-stock');
  });

  it('REFUSES a total whose two sides were derived the same way (proves nothing)', async () => {
    const selfCompared = total({ loadedDerivation: 'SUM(value) from legacy stock export' });
    const e = await thrown(() => reconcileRoute().handler(ctx({ body: { totals: [selfCompared] } })));
    expect(e.status).toBe(422);
    expect(e.body.code).toBe('same_derivation_both_sides');
  });

  it('refuses a production target and a malformed body', async () => {
    expect((await thrown(() => reconcileRoute('production').handler(ctx({ body: { totals: [total()] } })))).body.code).toBe('target_is_production');
    expect((await thrown(() => reconcileRoute().handler(ctx({ body: { totals: [{ totalId: 'x' }] } })))).status).toBe(400);
  });
});
