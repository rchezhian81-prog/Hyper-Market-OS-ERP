import { describe, it, expect } from 'vitest';
import { migrationRoutes, type MigrationDeps } from '../../services/migration/src/index';
import type { RequestContext, Route } from '../../services/kernel/src/index';
import type { LoadTarget, TargetKind } from '../../packages/migration/src/trial';
import type { ControlTotal } from '../../packages/migration/src/reconcile';

/**
 * **MG-08 opening balances + MG-09 delta wired on API-12.**
 *
 * MG-08 turns SIGNED control totals into append-only opening EVENTS, never a written balance, and
 * refuses unless QG-07 has passed and every position traces to a signed total. MG-09 applies the
 * post-extract delta exactly once — a re-send is a success, a pre-cutoff change is refused as already
 * loaded. Both refuse a production target (hard rule #7). Synthetic data only.
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

const openingRoute = (tk: TargetKind = 'rehearsal') => routeFor(migrationRoutes(deps(tk)), 'POST', '/v1/migration/opening-events');
const deltaRoute = (tk: TargetKind = 'rehearsal') => routeFor(migrationRoutes(deps(tk)), 'POST', '/v1/migration/deltas');

const signedTotal: ControlTotal = {
  totalId: 'CT-stock', tenantId: 't-sre', kind: 'stock', name: 'Stock value', unit: 'minor_currency',
  legacyValue: 100000, loadedValue: 100000,
  legacyDerivation: 'SUM(value) from legacy stock export',
  loadedDerivation: 'SUM(value_minor) from loaded stock_levels',
  signature: { signedBy: 'u-owner', signerRole: 'owner', signedAt: NOW, statement: 'checked' },
};

describe('POST /v1/migration/opening-events (MG-08)', () => {
  it('builds append-only opening events from signed, reconciled totals', async () => {
    const res = await openingRoute().handler(ctx({ body: {
      totals: [signedTotal],
      positions: [{ kind: 'stock', subjectId: 'P1', valueMinor: 100000, fromTotalId: 'CT-stock' }],
    } }));
    expect(res.status).toBe(200);
    const r = res.body as { events: { appendOnly: true; fromTotalId: string }[] };
    expect(r.events).toHaveLength(1);
    expect(r.events[0]!.appendOnly).toBe(true);
    expect(r.events[0]!.fromTotalId).toBe('CT-stock');
  });

  it('refuses when QG-07 has not passed (an unsigned total blocks the gate)', async () => {
    const { signature, ...unsigned } = signedTotal;
    void signature;
    const e = await thrown(() => openingRoute().handler(ctx({ body: {
      totals: [unsigned],
      positions: [{ kind: 'stock', subjectId: 'P1', valueMinor: 100000, fromTotalId: 'CT-stock' }],
    } })));
    expect(e.status).toBe(422);
    expect(e.body.code).toBe('qg07_not_passed');
  });

  it('refuses a position that cites a total which is not signed', async () => {
    const e = await thrown(() => openingRoute().handler(ctx({ body: {
      totals: [signedTotal],
      positions: [{ kind: 'stock', subjectId: 'P1', valueMinor: 100000, fromTotalId: 'CT-not-a-total' }],
    } })));
    expect(e.status).toBe(422);
    expect(e.body.code).toBe('unsigned_source_total');
  });

  it('refuses a production target and a malformed body', async () => {
    expect((await thrown(() => openingRoute('production').handler(ctx({ body: { totals: [signedTotal], positions: [] } })))).body.code).toBe('target_is_production');
    expect((await thrown(() => openingRoute().handler(ctx({ body: { totals: [signedTotal] } })))).status).toBe(400);
  });
});

describe('POST /v1/migration/deltas (MG-09)', () => {
  const change = (over: Record<string, unknown> = {}) => ({
    changeKey: 'chg-1', entity: 'sale', legacyId: 'S1', operation: 'insert', changedAt: '2026-09-12T09:00:00Z', deltaMinor: 5000, ...over,
  });

  it('applies a post-cutoff change once and reports the net movement', async () => {
    const res = await deltaRoute().handler(ctx({ body: { changes: [change()], extractCutoff: '2026-09-12T00:00:00Z' } }));
    expect(res.status).toBe(200);
    const r = res.body as { applied: number; netValueMinor: number };
    expect(r.applied).toBe(1);
    expect(r.netValueMinor).toBe(5000);
  });

  it('treats a re-sent change as already applied (a success, so a run can resume)', async () => {
    const res = await deltaRoute().handler(ctx({ body: {
      changes: [change()], extractCutoff: '2026-09-12T00:00:00Z', alreadyApplied: ['chg-1'],
    } }));
    const r = res.body as { applied: number; duplicatesIgnored: number };
    expect(r.applied).toBe(0);
    expect(r.duplicatesIgnored).toBe(1);
  });

  it('refuses a change dated before the extract cutoff (already loaded)', async () => {
    const res = await deltaRoute().handler(ctx({ body: {
      changes: [change({ changeKey: 'chg-old', changedAt: '2026-09-11T09:00:00Z' })],
      extractCutoff: '2026-09-12T00:00:00Z',
    } }));
    const r = res.body as { refused: number; applied: number };
    expect(r.refused).toBe(1);
    expect(r.applied).toBe(0);
  });

  it('refuses a production target and a malformed body', async () => {
    expect((await thrown(() => deltaRoute('production').handler(ctx({ body: { changes: [change()], extractCutoff: '2026-09-12T00:00:00Z' } })))).body.code).toBe('target_is_production');
    expect((await thrown(() => deltaRoute().handler(ctx({ body: { changes: [change()] } })))).status).toBe(400);
  });
});
