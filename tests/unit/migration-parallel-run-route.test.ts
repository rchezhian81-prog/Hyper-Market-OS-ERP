import { describe, it, expect } from 'vitest';
import { migrationRoutes, type MigrationDeps, type ParallelRunPolicy, type RecordedParallelDay, type RecordedRollback } from '../../services/migration/src/index';
import { renderParallelSheet, parallelRunView } from '../../services/migration/src/parallel-run';
import type { RequestContext, Route } from '../../services/kernel/src/index';
import type { LoadTarget, TargetKind } from '../../packages/migration/src/trial';
import type { ParallelDifference, RollbackReconciliation, WindowTotals, StoreSyncedThrough } from '../../packages/migration/src/cutover';

/**
 * **MG-10 — the parallel run the server keeps (Stage B3), route by route.**
 *
 * Nothing is compared until the owner has written the policy (the named daily reconciler, the required clean
 * days, the maximum duration — R-05). Only that person or the owner records a day; the engine decides what a
 * difference is; "the new system is probably right" is refused as an explanation (hard rule #10); overrun is
 * reported, never hidden; a rollback is a recorded fact the cutover checklist then reads from the ledger.
 */

const NOW = '2026-10-10T20:00:00.000Z';

interface Rec { policies: ParallelRunPolicy[]; days: RecordedParallelDay[]; diffs: ParallelDifference[]; rollbacks: RecordedRollback[]; reconciliations: RollbackReconciliation[]; window: WindowTotals; stores: StoreSyncedThrough[] }

const stub = (over: Partial<MigrationDeps> & { targetKind?: TargetKind } = {}) => {
  const rec: Rec = { policies: [], days: [], diffs: [], rollbacks: [], reconciliations: [], window: { count: 0, totalMinor: 0 }, stores: [] };
  const deps: MigrationDeps = {
    target: (tenantId): LoadTarget => ({ targetId: `tgt-${tenantId}`, tenantId, kind: over.targetKind ?? 'rehearsal', label: over.targetKind ?? 'rehearsal' }),
    findings: () => [], acceptances: () => [], signatures: () => [], recordAcceptance: () => {},
    ownerId: () => 'u-owner', extractionOperator: () => 'u-op', exclusions: () => [], recordExclusion: () => {},
    parallelPolicy: () => rec.policies.at(-1),
    parallelDays: () => { const m = new Map<string, RecordedParallelDay>(); for (const d of rec.days) m.set(d.businessDate, d); return [...m.values()]; },
    parallelDifferences: () => { const m = new Map<string, ParallelDifference>(); for (const d of rec.diffs) m.set(d.differenceId, d); return [...m.values()]; },
    rollbacks: () => rec.rollbacks,
    recordParallelPolicy: (_t, p) => { rec.policies.push(p); },
    recordParallelDay: (_t, d) => { rec.days.push(d); },
    recordParallelDifference: (_t, d) => { rec.diffs.push(d); },
    recordRollback: (_t, r) => { rec.rollbacks.push(r); },
    rollbackReconciliations: () => rec.reconciliations,
    recordRollbackReconciliation: (_t, c) => { rec.reconciliations.push(c); },
    windowSales: () => Promise.resolve(rec.window),
    storeSalesSyncedThrough: () => Promise.resolve(rec.stores),
    now: () => NOW,
    ...over,
  };
  return { deps, rec, routes: migrationRoutes(deps) };
};

const ctx = (over: Partial<RequestContext>): RequestContext =>
  ({ tenantId: 't-sre', userId: 'u-owner', branchId: null, params: {}, query: {}, body: undefined, traceId: 't', ...over });
const routeFor = (routes: readonly Route[], method: string, path: string): Route => {
  const r = routes.find((x) => x.method === method && x.path === path);
  if (r === undefined) throw new Error(`no route ${method} ${path}`);
  return r;
};
interface Thrown { readonly status: number; readonly body: { readonly code: string; readonly whatHappened: string } }
async function thrown(fn: () => unknown): Promise<Thrown> {
  try { await fn(); } catch (e) { return e as Thrown; }
  throw new Error('expected the handler to throw');
}

const POLICY = { cutoverId: 'cut-1', dailyReconcilerUserId: 'u-recon', requiredCleanDays: 3, maxParallelDays: 14, startedOn: '2026-10-01' };
const clean = (date: string) => ({ params: { businessDate: date }, body: { comparisons: [
  { area: 'sales_value', legacyValue: 4_120_000, newValue: 4_120_000, toleranceMinor: 500 },
  { area: 'tax', legacyValue: 206_000, newValue: 206_040, toleranceMinor: 100 },
] } });
const withPolicy = async () => {
  const s = stub();
  await routeFor(s.routes, 'PUT', '/v1/migration/parallel-run/policy').handler(ctx({ body: POLICY }));
  return s;
};

describe('PUT /v1/migration/parallel-run/policy — the owner writes the terms first', () => {
  it('records the named reconciler, the clean days and the maximum; the position read then says "started"', async () => {
    const { routes, rec } = await withPolicy();
    expect(rec.policies).toEqual([{ ...POLICY, setBy: 'u-owner', setAt: NOW }]);
    const view = await routeFor(routes, 'GET', '/v1/migration/parallel-run').handler(ctx({}));
    expect(view.body).toMatchObject({ started: true, overdue: false, position: { daysRun: 0, sufficient: false } });
  });
  it('refuses a policy with nobody named, or a maximum shorter than the clean days required; refuses production first', async () => {
    const { routes } = stub();
    const put = routeFor(routes, 'PUT', '/v1/migration/parallel-run/policy');
    expect((await thrown(() => put.handler(ctx({ body: { ...POLICY, dailyReconcilerUserId: ' ' } })))).status).toBe(400);
    expect((await thrown(() => put.handler(ctx({ body: { ...POLICY, maxParallelDays: 2 } })))).status).toBe(400);
    const prod = stub({ targetKind: 'production' });
    expect(await thrown(() => routeFor(prod.routes, 'PUT', '/v1/migration/parallel-run/policy').handler(ctx({ body: POLICY })))).toMatchObject({ status: 403, body: { code: 'target_is_production' } });
  });
  it('before the policy: no day can be compared, and the read says nobody is named', async () => {
    const { routes } = stub();
    expect(await thrown(() => routeFor(routes, 'POST', '/v1/migration/parallel-run/days/:businessDate').handler(ctx(clean('2026-10-01'))))).toMatchObject({ status: 409, body: { code: 'parallel_run_not_started' } });
    expect((await routeFor(routes, 'GET', '/v1/migration/parallel-run').handler(ctx({}))).body).toMatchObject({ started: false });
  });
});

describe('POST /v1/migration/parallel-run/days/:businessDate — the engine decides what a difference is', () => {
  it('the named reconciler records three clean days and the run becomes sufficient; a fourth person is refused', async () => {
    const { routes, rec } = await withPolicy();
    const post = routeFor(routes, 'POST', '/v1/migration/parallel-run/days/:businessDate');
    for (const d of ['2026-10-01', '2026-10-02', '2026-10-03']) {
      const res = await post.handler(ctx({ userId: 'u-recon', ...clean(d) }));
      expect(res.status).toBe(201);
    }
    expect(rec.days.map((d) => [d.businessDate, d.clean, d.recordedBy])).toEqual([['2026-10-01', true, 'u-recon'], ['2026-10-02', true, 'u-recon'], ['2026-10-03', true, 'u-recon']]);
    const view = (await routeFor(routes, 'GET', '/v1/migration/parallel-run').handler(ctx({}))).body as { position: { consecutiveCleanDays: number; sufficient: boolean }; elapsedDays: number };
    expect(view.position).toMatchObject({ consecutiveCleanDays: 3, sufficient: true });
    expect(view.elapsedDays).toBe(3);
    expect(await thrown(() => post.handler(ctx({ userId: 'u-manager', ...clean('2026-10-04') })))).toMatchObject({ status: 403, body: { code: 'not_the_named_reconciler' } });
    expect(await thrown(() => post.handler(ctx({ userId: 'u-recon', ...clean('2026-09-30') })))).toMatchObject({ status: 422, body: { code: 'before_the_parallel_run_started' } });
  });
  it('a day that differs raises open differences with ids, resets the clean streak, and the run is not sufficient', async () => {
    const { routes, rec } = await withPolicy();
    const post = routeFor(routes, 'POST', '/v1/migration/parallel-run/days/:businessDate');
    await post.handler(ctx({ userId: 'u-recon', ...clean('2026-10-01') }));
    const res = await post.handler(ctx({ userId: 'u-recon', params: { businessDate: '2026-10-02' }, body: { comparisons: [
      { area: 'sales_value', legacyValue: 4_120_000, newValue: 4_115_500, toleranceMinor: 500 },
      { area: 'stock_movement', legacyValue: 800, newValue: 812, toleranceMinor: 0 },
    ] } }));
    expect(res.status).toBe(201);
    expect(rec.diffs.map((d) => [d.differenceId, d.area, d.difference, d.status])).toEqual([['PD-2026-10-02-001', 'sales_value', -4_500, 'open'], ['PD-2026-10-02-002', 'stock_movement', 12, 'open']]);
    expect((res.body as { position: { consecutiveCleanDays: number; sufficient: boolean; unownedDifferences: unknown[] } }).position).toMatchObject({ consecutiveCleanDays: 0, sufficient: false });
    expect((res.body as { position: { unownedDifferences: unknown[] } }).position.unownedDifferences).toHaveLength(2);
  });
  it('an unreadable day is 400 and records nothing', async () => {
    const { routes, rec } = await withPolicy();
    const e = await thrown(() => routeFor(routes, 'POST', '/v1/migration/parallel-run/days/:businessDate').handler(ctx({ userId: 'u-recon', params: { businessDate: '2026-10-01' }, body: { comparisons: [{ area: 'moon_phase', legacyValue: 1, newValue: 1, toleranceMinor: 0 }] } })));
    expect(e).toMatchObject({ status: 400, body: { code: 'not_readable_as_a_parallel_day' } });
    expect(rec.days).toEqual([]);
  });
  it('overrunning the maximum is reported on every read, never hidden, and the day is still recorded', async () => {
    const { routes } = await withPolicy();
    const post = routeFor(routes, 'POST', '/v1/migration/parallel-run/days/:businessDate');
    const res = await post.handler(ctx({ userId: 'u-recon', ...clean('2026-10-20') }));
    expect(res.status).toBe(201);
    expect((res.body as { overdue: boolean }).overdue).toBe(true);
    const view = (await routeFor(routes, 'GET', '/v1/migration/parallel-run').handler(ctx({}))).body as { overdue: boolean; elapsedDays: number; detail: string };
    expect(view).toMatchObject({ overdue: true, elapsedDays: 20 });
    expect(view.detail).toContain('escalate to the owner (R-05)');
  });
});

describe('POST /v1/migration/parallel-run/differences/:differenceId/own — a name, then a real explanation', () => {
  const withDifference = async () => {
    const s = await withPolicy();
    await routeFor(s.routes, 'POST', '/v1/migration/parallel-run/days/:businessDate').handler(ctx({ userId: 'u-recon', params: { businessDate: '2026-10-02' }, body: { comparisons: [{ area: 'sales_value', legacyValue: 4_120_000, newValue: 4_115_500, toleranceMinor: 500 }] } }));
    return s;
  };
  it('owns, then resolves with which side was wrong; the position closes the difference and the sheet shows it', async () => {
    const { routes, rec, deps } = await withDifference();
    const own = routeFor(routes, 'POST', '/v1/migration/parallel-run/differences/:differenceId/own');
    const owned = await own.handler(ctx({ userId: 'u-manager', params: { differenceId: 'PD-2026-10-02-001' }, body: {} }));
    expect(owned.status).toBe(200);
    expect((owned.body as { difference: ParallelDifference }).difference).toMatchObject({ status: 'owned', ownerUserId: 'u-manager' });
    const resolved = await own.handler(ctx({ userId: 'u-manager', params: { differenceId: 'PD-2026-10-02-001' }, body: { explanation: 'a cash refund was keyed into the old system twice by the evening cashier', wrongSide: 'legacy' } }));
    expect((resolved.body as { difference: ParallelDifference }).difference).toMatchObject({ status: 'resolved', wrongSide: 'legacy' });
    expect(rec.diffs.map((d) => d.status)).toEqual(['open', 'owned', 'resolved']);
    const view = (await parallelRunView(deps, 't-sre'))!;
    expect(view.position.openDifferences).toEqual([]);
    const sheet = renderParallelSheet(view, await deps.parallelDays!('t-sre'), await deps.parallelDifferences!('t-sre'));
    expect(sheet).toContain('PD-2026-10-02-001');
    expect(sheet).toContain('keyed into the old system twice');
    expect(sheet).toContain('Reconciled by:');
    const sheetRoute = await routeFor(routes, 'GET', '/v1/migration/parallel-run/sheet').handler(ctx({}));
    expect((sheetRoute.body as { markdown: string }).markdown).toContain('daily reconciler **u-recon**');
  });
  it('refuses "the new system is probably right", an unknown id, and a second resolution', async () => {
    const { routes } = await withDifference();
    const own = routeFor(routes, 'POST', '/v1/migration/parallel-run/differences/:differenceId/own');
    expect(await thrown(() => own.handler(ctx({ userId: 'u-manager', params: { differenceId: 'PD-2026-10-02-001' }, body: { explanation: 'the new system is probably right' } })))).toMatchObject({ status: 422, body: { code: 'newer_is_not_a_reason' } });
    expect(await thrown(() => own.handler(ctx({ userId: 'u-manager', params: { differenceId: 'PD-nope' }, body: {} })))).toMatchObject({ status: 404, body: { code: 'unknown_difference' } });
    await own.handler(ctx({ userId: 'u-manager', params: { differenceId: 'PD-2026-10-02-001' }, body: { explanation: 'a keying error at the old till, corrected there', wrongSide: 'legacy' } }));
    expect(await thrown(() => own.handler(ctx({ userId: 'u-other', params: { differenceId: 'PD-2026-10-02-001' }, body: { explanation: 'something else entirely happened' } })))).toMatchObject({ status: 409, body: { code: 'already_resolved' } });
  });
});

describe('POST /v1/migration/cutover/rollback and what the cutover decision now reads from the ledger', () => {
  it('a rollback is DECIDED at one click, PERFORMED only on execution evidence; only then does the decision read it (GT-02)', async () => {
    const { routes, rec } = await withPolicy();
    const post = routeFor(routes, 'POST', '/v1/migration/parallel-run/days/:businessDate');
    for (const d of ['2026-10-01', '2026-10-02', '2026-10-03']) await post.handler(ctx({ userId: 'u-recon', ...clean(d) }));
    const rb = await routeFor(routes, 'POST', '/v1/migration/cutover/rollback').handler(ctx({ body: { cutoverId: 'cut-1', trigger: 'owner_decision', legacySystemAvailable: true } }));
    expect(rb.status).toBe(201);
    // The click records a DECISION — never "performed" before anybody has seen the old system trade.
    expect(rec.rollbacks).toEqual([expect.objectContaining({ cutoverId: 'cut-1', performed: false, state: 'decided', decidedBy: 'u-owner', decidedAt: NOW, evidenceRetained: true, shopKeepsTrading: true })]);
    const decide = () => routeFor(routes, 'POST', '/v1/migration/cutover/decision').handler(ctx({ body: { cutoverId: 'cut-1', evidence: {} } }));
    const before = (await decide()).body as { checks: { check: string; state: string }[] };
    expect(before.checks.find((c) => c.check === 'rollback_demonstrated')?.state).toBe('failed');
    expect(before.checks.find((c) => c.check === 'parallel_run_sufficient')?.state).toBe('passed'); // from the ledger

    // Confirmed with the old system's first bill after the decision, by the signed-in person who saw it.
    const confirm = routeFor(routes, 'POST', '/v1/migration/cutover/rollback/:cutoverId/confirmation');
    expect(await thrown(() => confirm.handler(ctx({ userId: 'u-mgr', params: { cutoverId: 'cut-1' }, body: { legacyFirstBillRef: 'OLD-1', legacyTradingFrom: '2026-10-10T19:00:00.000Z' } })))).toMatchObject({ status: 422, body: { code: 'trading_before_the_decision' } });
    const ok = await confirm.handler(ctx({ userId: 'u-mgr', params: { cutoverId: 'cut-1' }, body: { legacyFirstBillRef: 'OLD-1', legacyTradingFrom: NOW } }));
    expect(ok.status).toBe(201);
    expect(rec.rollbacks.at(-1)).toMatchObject({ performed: true, state: 'performed', execution: { confirmedBy: 'u-mgr', legacyFirstBillRef: 'OLD-1' } });
    expect(await thrown(() => confirm.handler(ctx({ params: { cutoverId: 'cut-1' }, body: { legacyFirstBillRef: 'OLD-2', legacyTradingFrom: NOW } })))).toMatchObject({ status: 409, body: { code: 'already_performed' } });
    // GT-02 round 4: performed is not yet DEMONSTRATED — the data must reconcile first.
    expect(((await decide()).body as { checks: { check: string; state: string }[] }).checks.find((c) => c.check === 'rollback_demonstrated')?.state).toBe('failed');
    const reconcile = routeFor(routes, 'POST', '/v1/migration/cutover/rollback/:cutoverId/reconciliation');
    const carry = (count: number, totalMinor: number) => ({ newSystemTradingFrom: '2026-10-10T18:00:00.000Z', legacyCarriedBack: { count, totalMinor } });
    rec.window = { count: 3, totalMinor: 45_000 };
    // A store computer still holding sales from before the switch-back: refused, nothing recorded.
    rec.stores = [{ storeId: 'S1', completeThrough: '2026-10-10T19:30:00.000Z' }];
    expect(await thrown(() => reconcile.handler(ctx({ params: { cutoverId: 'cut-1' }, body: carry(3, 45_000) })))).toMatchObject({ status: 409, body: { code: 'store_not_synced_through_switch_back' } });
    expect(rec.reconciliations).toEqual([]);
    rec.stores = [{ storeId: 'S1', completeThrough: '2026-10-10T20:05:00.000Z' }];
    // The old system is a bill short: recorded (evidence) but NOT reconciled, and not demonstrated.
    const short = await reconcile.handler(ctx({ params: { cutoverId: 'cut-1' }, body: carry(2, 30_000) }));
    expect(short.body).toMatchObject({ demonstrated: false, reconciliation: { reconciled: false, differences: [expect.stringMatching(/bills/), expect.stringMatching(/takings/)] } });
    expect(((await decide()).body as { checks: { check: string; state: string }[] }).checks.find((c) => c.check === 'rollback_demonstrated')?.state).toBe('failed');
    // Every bill carried back: reconciled — demonstrated.
    expect((await reconcile.handler(ctx({ params: { cutoverId: 'cut-1' }, body: carry(3, 45_000) }))).body).toMatchObject({ demonstrated: true });
    const after = (await decide()).body as { checks: { check: string; state: string }[] };
    expect(after.checks.find((c) => c.check === 'rollback_demonstrated')?.state).toBe('passed');
  });

  it('a rollback decided with the old system unavailable can never be confirmed — and is not "gone back"', async () => {
    const { routes, rec } = await withPolicy();
    const rb = await routeFor(routes, 'POST', '/v1/migration/cutover/rollback').handler(ctx({ body: { cutoverId: 'cut-1', trigger: 'data_corruption', legacySystemAvailable: false } }));
    expect(rb.status).toBe(201);
    expect(rec.rollbacks[0]).toMatchObject({ performed: false, state: 'legacy_unavailable' });
    expect((rb.body as { nextSafeAction: string }).nextSafeAction).toMatch(/cannot be performed/);
    const confirm = routeFor(routes, 'POST', '/v1/migration/cutover/rollback/:cutoverId/confirmation');
    expect(await thrown(() => confirm.handler(ctx({ params: { cutoverId: 'cut-1' }, body: { legacyFirstBillRef: 'OLD-1', legacyTradingFrom: NOW } })))).toMatchObject({ status: 422, body: { code: 'legacy_unavailable' } });
    expect(await thrown(() => confirm.handler(ctx({ params: { cutoverId: 'cut-9' }, body: { legacyFirstBillRef: 'OLD-1', legacyTradingFrom: NOW } })))).toMatchObject({ status: 404, body: { code: 'no_rollback_decided' } });
    expect(rec.rollbacks).toHaveLength(1); // nothing confirmed, the decision kept
  });
  it('without a recorded rollback or run, the decision still fails those checks — absent is never a pass', async () => {
    const { routes } = stub();
    const decision = await routeFor(routes, 'POST', '/v1/migration/cutover/decision').handler(ctx({ body: { cutoverId: 'cut-1', evidence: {
      reconciliation: { tenantId: 't-sre', assessments: [], open: [], unsigned: [], qg07Passed: true, detail: 'signed' },
      exceptions: { tenantId: 't-sre', clearForCutover: true, blockingUnresolved: [], detail: 'clear' },
      edgeUnsyncedItems: 0, deltaAppliedAt: '2026-10-03T22:00:00Z', namedTeam: [{ userId: 'u-owner', role: 'owner' }], ownerGoBy: 'u-owner',
    } } }));
    const d = decision.body as { decision: { go: boolean; failed: string[] } };
    expect(d.decision.go).toBe(false);
    expect(d.decision.failed).toEqual(expect.arrayContaining(['rollback_demonstrated', 'parallel_run_sufficient']));
  });
  it('refuses a rollback with no trigger, and 503s honestly when this deployment has no store', async () => {
    const { routes } = await withPolicy();
    expect((await thrown(() => routeFor(routes, 'POST', '/v1/migration/cutover/rollback').handler(ctx({ body: { cutoverId: 'cut-1', trigger: 'felt_like_it', legacySystemAvailable: true } })))).status).toBe(400);
    const unwired = stub({ recordRollback: undefined });
    expect(await thrown(() => routeFor(unwired.routes, 'POST', '/v1/migration/cutover/rollback').handler(ctx({ body: { cutoverId: 'cut-1', trigger: 'owner_decision', legacySystemAvailable: true } })))).toMatchObject({ status: 503, body: { code: 'parallel_run_store_not_wired' } });
  });
});
