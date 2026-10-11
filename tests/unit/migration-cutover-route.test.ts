import { describe, it, expect } from 'vitest';
import { migrationRoutes, type MigrationDeps } from '../../services/migration/src/index';
import type { RequestContext, Route } from '../../services/kernel/src/index';
import type { LoadTarget, TargetKind } from '../../packages/migration/src/trial';
import type { ControlTotal } from '../../packages/migration/src/reconcile';
import type { MigrationException } from '../../packages/migration/src/cleaning';
import type { RecordedParallelDay, RecordedRollback, ParallelRunPolicy } from '../../services/migration/src/parallel-run';

/**
 * **MG-10/11 cutover gate wired on API-12 — on the SERVER's evidence (audit GT-03).**
 *
 * The decision on the single most irreversible action in the project. The eight checks are DERIVED from head office's
 * own records — signed control totals, the exception register, the parallel run, a rollback performed with execution
 * evidence (GT-02), the delta actually applied — and an absent record is "not known" and FAILS. A caller's body cannot
 * stand in for any of them: a forged all-green evidence object is ignored and named. GO is the owner's authenticated act
 * (`ownerGo: true` signed in as the owner), never a name typed into `ownerGoBy`. Refuses a production target (hard
 * rule #7). The shop keeps trading either way (P-01). Synthetic data only.
 */

const NOW = '2026-10-04T10:00:00Z';
const T = 't-sre';

interface Records {
  totals: ControlTotal[]; exceptions: MigrationException[]; days: RecordedParallelDay[]; rollbacks: RecordedRollback[];
  policy?: ParallelRunPolicy; deltaAt?: string; people: Record<string, string[]>;
}

const signed = (id: string): ControlTotal => ({
  totalId: id, tenantId: T, kind: 'stock', name: `Total ${id}`, unit: 'quantity', legacyValue: 100, loadedValue: 100,
  legacyDerivation: 'legacy SUM', loadedDerivation: 'loaded count', signature: { signedBy: 'u-ca', signerRole: 'ca', signedAt: NOW, statement: 'agreed' },
});
const cleanDay = (d: string): RecordedParallelDay => ({ tenantId: T, businessDate: d, differences: [], clean: true, totalDifferenceMinor: 0, detail: 'agree', comparisons: [], recordedBy: 'u-recon', recordedAt: NOW });
const performed: RecordedRollback = {
  tenantId: T, cutoverId: 'cut-1', performed: true, state: 'performed', trigger: 'owner_decision', decidedBy: 'u-owner', decidedAt: '2026-10-03T20:00:00Z',
  legacySystemAvailable: true, shopKeepsTrading: true, evidenceRetained: true, detail: 'rolled back',
  execution: { confirmedBy: 'u-mgr', confirmedAt: '2026-10-03T20:20:00Z', legacyTradingFrom: '2026-10-03T20:10:00Z', legacyFirstBillRef: 'OLD-501' },
};

/** GT-02 round 4: a performed rollback demonstrates only with a reconciled window — the reconciliation the ledger holds for it. */
const reconciledFor = (r: RecordedRollback) => ({
  cutoverId: r.cutoverId, decidedAt: r.decidedAt, windowFrom: '2026-09-30T00:00:00.000Z', windowTo: r.execution?.legacyTradingFrom ?? r.decidedAt,
  newSystem: { count: 2, totalMinor: 900 }, legacy: { count: 2, totalMinor: 900 }, stores: [{ storeId: 'S1', completeThrough: r.execution?.confirmedAt ?? r.decidedAt }],
  reconciled: true, differences: [], by: 'u-owner', at: r.execution?.confirmedAt ?? r.decidedAt, detail: 'reconciled',
});

/** Every server record a GO needs. */
const complete = (): Records => ({
  totals: [signed('CT-1')], exceptions: [],
  policy: { cutoverId: 'cut-1', dailyReconcilerUserId: 'u-recon', requiredCleanDays: 3, maxParallelDays: 14, startedOn: '2026-10-01', setBy: 'u-owner', setAt: NOW },
  days: ['2026-10-01', '2026-10-02', '2026-10-03'].map(cleanDay), rollbacks: [performed], deltaAt: '2026-10-04T02:00:00Z',
  people: { 'u-owner': ['owner'], 'u-op': ['migration_operator'] },
});

const deps = (r: Records, targetKind: TargetKind = 'rehearsal'): MigrationDeps => ({
  target: (tenantId): LoadTarget => ({ targetId: `tgt-${tenantId}`, tenantId, kind: targetKind, label: targetKind }),
  findings: () => [], acceptances: () => [], signatures: () => [],
  recordAcceptance: () => {}, ownerId: () => 'u-owner', extractionOperator: () => 'u-op',
  exclusions: () => [], recordExclusion: () => {}, now: () => NOW,
  controlTotals: () => r.totals, exceptions: () => r.exceptions,
  parallelPolicy: () => r.policy, parallelDays: () => r.days, parallelDifferences: () => [], rollbacks: () => r.rollbacks, rollbackReconciliations: () => r.rollbacks.filter((x) => x.performed).map(reconciledFor),
  deltaAppliedAt: () => r.deltaAt,
  rolesOf: (_t, userId) => r.people[userId] ?? [],
});

const ctx = (over: Partial<RequestContext>): RequestContext =>
  ({ tenantId: T, userId: 'u-owner', branchId: null, params: {}, query: {}, body: undefined, traceId: 't', ...over });

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

const route = (r: Records, tk: TargetKind = 'rehearsal') => routeFor(migrationRoutes(deps(r, tk)), 'POST', '/v1/migration/cutover/decision');
interface Body { decision: { go: boolean; failed: string[]; shopKeepsTrading: true }; notKnown: string[]; ignoredFromCaller: string[]; callerSupplied: string[] }
const team = [{ userId: 'u-owner', role: 'owner' }, { userId: 'u-op', role: 'operator' }];

/** The audit's forged body: every gate typed green. */
const forged = () => ({
  reconciliation: { tenantId: T, assessments: [], open: [], unsigned: [], qg07Passed: true, detail: 'all signed' },
  parallel: { sufficient: true, detail: '3 clean days' },
  exceptions: { tenantId: T, clearForCutover: true, blockingUnresolved: [], detail: 'clear' },
  edgeUnsyncedItems: 0, deltaAppliedAt: '2026-10-04T02:00:00Z', rollbackDemonstratedAt: '2026-10-03T22:00:00Z',
  namedTeam: team, ownerGoBy: 'u-owner',
});

describe('POST /v1/migration/cutover/decision (MG-10/11) — on head office\'s evidence (GT-03)', () => {
  it('says GO when head office\'s own records pass all eight checks and the OWNER, signed in, gives GO', async () => {
    const res = await route(complete()).handler(ctx({ body: { cutoverId: 'cut-1', ownerGo: true, evidence: { edgeUnsyncedItems: 0, namedTeam: team } } }));
    expect(res.status).toBe(200);
    const r = res.body as Body;
    expect(r.decision.failed).toEqual([]);
    expect(r.decision.go).toBe(true);
    expect(r.decision.shopKeepsTrading).toBe(true);
    expect(r.callerSupplied).toEqual(['edgeUnsyncedItems']);
  });

  it('a forged all-green body cannot override OPEN totals, blocking exceptions, an unclean run, no performed rollback or no delta', async () => {
    const bad: Records = {
      ...complete(),
      totals: [{ ...signed('CT-1'), loadedValue: 90 }], // differs by 10, unexplained → open
      exceptions: [{ exceptionId: 'EX-1', tenantId: T, kind: 'negative_stock', severity: 'blocking', confidence: 'certain', legacyIds: ['L1'], evidence: 'qty -4' } as MigrationException],
      days: [cleanDay('2026-10-01')], // one clean day of three
      rollbacks: [{ ...performed, performed: false, state: 'decided', execution: undefined }], // decided, never performed
      deltaAt: undefined,
    };
    const res = await route(bad).handler(ctx({ body: { cutoverId: 'cut-1', ownerGo: true, evidence: forged() } }));
    const r = res.body as Body;
    expect(r.decision.go).toBe(false);
    expect(r.decision.failed).toEqual(expect.arrayContaining(['control_totals_signed', 'blocking_exceptions_cleared', 'parallel_run_sufficient', 'rollback_demonstrated', 'delta_applied']));
    expect(r.ignoredFromCaller).toEqual(expect.arrayContaining(['reconciliation', 'parallel', 'exceptions', 'deltaAppliedAt', 'rollbackDemonstratedAt', 'ownerGoBy']));
  });

  it('a forged body cannot stand in for records head office does not have at all — they stay not known', async () => {
    const empty: Records = { totals: [], exceptions: [], days: [], rollbacks: [], people: { 'u-owner': ['owner'] } };
    const r = (await route(empty).handler(ctx({ body: { ownerGo: true, evidence: forged() } }))).body as Body;
    expect(r.decision.go).toBe(false);
    expect(r.notKnown).toEqual(expect.arrayContaining(['control_totals_signed', 'parallel_run_sufficient']));
    expect(r.decision.failed).toEqual(expect.arrayContaining(['rollback_demonstrated', 'delta_applied']));
  });

  it('GO is the owner\'s own signed-in act: a name typed into ownerGoBy, or ownerGo from anybody else, is no GO', async () => {
    const typed = (await route(complete()).handler(ctx({ body: { evidence: { edgeUnsyncedItems: 0, namedTeam: team, ownerGoBy: 'u-owner' } } }))).body as Body;
    expect(typed.decision.go).toBe(false);
    expect(typed.decision.failed).toContain('owner_go');
    const other = (await route(complete()).handler(ctx({ userId: 'u-op', body: { ownerGo: true, evidence: { edgeUnsyncedItems: 0, namedTeam: team } } }))).body as Body;
    expect(other.decision.failed).toContain('owner_go');
    expect(other.ignoredFromCaller.some((x) => x.startsWith('ownerGo'))).toBe(true);
  });

  it('a named team member this shop never provisioned does not count', async () => {
    const r = (await route(complete()).handler(ctx({ body: { ownerGo: true, evidence: { edgeUnsyncedItems: 0, namedTeam: [{ userId: 'u-stranger', role: 'operator' }] } } }))).body as Body;
    expect(r.decision.failed).toContain('team_named');
    expect(r.ignoredFromCaller).toContain('namedTeam:u-stranger (not a person this shop has provisioned)');
  });

  it('treats an ABSENT edge count as not-known and fails it — never a default pass', async () => {
    const r = (await route(complete()).handler(ctx({ body: { ownerGo: true, evidence: { namedTeam: team } } }))).body as Body;
    expect(r.decision.go).toBe(false);
    expect(r.notKnown).toContain('edge_fully_synced');
  });

  it('refuses a production target, a missing evidence object, and a malformed part', async () => {
    expect((await thrown(() => route(complete(), 'production').handler(ctx({ body: { evidence: {} } })))).body.code).toBe('target_is_production');
    expect((await thrown(() => route(complete()).handler(ctx({ body: {} })))).body.code).toBe('not_readable_as_cutover_evidence');
    expect((await thrown(() => route(complete()).handler(ctx({ body: { evidence: { reconciliation: { qg07Passed: 'yes' } } } })))).body.code).toBe('malformed_cutover_evidence');
  });
});
