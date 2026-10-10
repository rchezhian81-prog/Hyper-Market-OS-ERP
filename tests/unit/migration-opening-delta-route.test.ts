import { describe, it, expect } from 'vitest';
import { migrationRoutes, type MigrationDeps, type AppliedDelta } from '../../services/migration/src/index';
import type { Movement } from '../../services/inventory/src/index';
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
  recordAcceptance: () => {}, ownerId: () => 'u-owner', extractionOperator: () => 'u-op',
  exclusions: () => [], recordExclusion: () => {}, now: () => NOW,
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

describe('POST /v1/migration/deltas (MG-09) — applied means a real effect, once (audit GT-04)', () => {
  const stock = (over: Record<string, unknown> = {}) => ({
    changeKey: 'chg-1', entity: 'stock', legacyId: 'P-RICE', operation: 'update', changedAt: '2026-09-12T09:00:00Z',
    deltaQty: -3, locationId: 'S1', uom: 'ea', ...over,
  });
  /** Head office's own record of what a delta applied, and the movements it wrote. */
  const store = () => {
    const applied: AppliedDelta[] = [];
    const movements: Movement[] = [];
    const d: MigrationDeps = {
      ...deps(),
      appliedDeltaKeys: () => applied.map((a) => a.changeKey),
      applyDeltaChange: (_t, a, m) => { applied.push(a); movements.push(m); },
    };
    return { applied, movements, route: routeFor(migrationRoutes(d), 'POST', '/v1/migration/deltas') };
  };
  interface Body { applied: number; duplicatesIgnored: number; refused: number; lines: { changeKey: string; outcome: string; effect?: string }[]; ignoredFromCaller?: string[]; appliedKeys: string[] }

  it('a stock change after the cutoff becomes a real stock movement — a legacy sale is "sold", a receipt is "received" at cost', async () => {
    const s = store();
    const res = await s.route.handler(ctx({ body: { changes: [stock(), stock({ changeKey: 'chg-2', deltaQty: 10, unitCostMinor: 36_000 })], extractCutoff: '2026-09-12T00:00:00Z' } }));
    expect(res.status).toBe(200);
    const r = res.body as Body;
    expect(r.applied).toBe(2);
    expect(s.movements).toEqual([
      expect.objectContaining({ movementId: 'delta-chg-1', productId: 'P-RICE', locationId: 'S1', kind: 'sold', quantityMinor: 3, uom: 'ea', occurredAt: '2026-09-12T09:00:00Z', enteredBy: 'u-migrator' }),
      expect.objectContaining({ movementId: 'delta-chg-2', kind: 'received', quantityMinor: 10, unitCostMinor: 36_000 }),
    ]);
    // The source identity is kept on the record: the change key, the legacy id, the cutoff.
    expect(s.applied[0]).toMatchObject({ changeKey: 'chg-1', legacyId: 'P-RICE', extractCutoff: '2026-09-12T00:00:00Z', effect: 'stock movement delta-chg-1', appliedBy: 'u-migrator' });
  });

  it('a re-sent change is already applied from HEAD OFFICE\'s record — the caller\'s list is ignored, and no second movement', async () => {
    const s = store();
    await s.route.handler(ctx({ body: { changes: [stock()], extractCutoff: '2026-09-12T00:00:00Z' } }));
    const again = (await s.route.handler(ctx({ body: { changes: [stock()], extractCutoff: '2026-09-12T00:00:00Z', alreadyApplied: [] } }))).body as Body;
    expect(again).toMatchObject({ applied: 0, duplicatesIgnored: 1 });
    expect(again.ignoredFromCaller).toEqual([expect.stringMatching(/alreadyApplied/)]);
    expect(s.movements).toHaveLength(1);
    // And a caller cannot skip a change by claiming it was already applied.
    const s2 = store();
    const claimed = (await s2.route.handler(ctx({ body: { changes: [stock()], extractCutoff: '2026-09-12T00:00:00Z', alreadyApplied: ['chg-1'] } }))).body as Body;
    expect(claimed.applied).toBe(1);
    expect(s2.movements).toHaveLength(1);
  });

  it('an entity this version cannot apply is REFUSED by name — never counted as applied', async () => {
    const s = store();
    const r = (await s.route.handler(ctx({ body: { changes: [stock({ changeKey: 'chg-s', entity: 'sale', deltaMinor: 5000 })], extractCutoff: '2026-09-12T00:00:00Z' } }))).body as Body;
    expect(r).toMatchObject({ applied: 0, refused: 1 });
    expect(r.lines[0]).toMatchObject({ outcome: 'refused_unsupported_entity' });
    expect(s.applied).toEqual([]);
    expect(r.appliedKeys).toEqual([]);
  });

  it('refuses a change dated before the extract cutoff (already loaded), and a stock change missing where or what unit', async () => {
    const s = store();
    const r = (await s.route.handler(ctx({ body: {
      changes: [stock({ changeKey: 'chg-old', changedAt: '2026-09-11T09:00:00Z' }), stock({ changeKey: 'chg-noloc', locationId: undefined }), stock({ changeKey: 'chg-in-nocost', deltaQty: 4 })],
      extractCutoff: '2026-09-12T00:00:00Z',
    } }))).body as Body;
    expect(r).toMatchObject({ applied: 0, refused: 3 });
    expect(r.lines.map((l) => l.outcome)).toEqual(['refused_before_cutoff', 'refused_incomplete', 'refused_incomplete']);
    expect(s.movements).toEqual([]);
  });

  it('refuses a production target, a malformed body, and — 503 — a deployment that cannot record what it applies', async () => {
    expect((await thrown(() => deltaRoute('production').handler(ctx({ body: { changes: [stock()], extractCutoff: '2026-09-12T00:00:00Z' } })))).body.code).toBe('target_is_production');
    expect((await thrown(() => store().route.handler(ctx({ body: { changes: [stock()] } })))).status).toBe(400);
    expect(await thrown(() => deltaRoute().handler(ctx({ body: { changes: [stock()], extractCutoff: '2026-09-12T00:00:00Z' } })))).toMatchObject({ status: 503, body: { code: 'delta_store_not_wired' } });
  });
});
