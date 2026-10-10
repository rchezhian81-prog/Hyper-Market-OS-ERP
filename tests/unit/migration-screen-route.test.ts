import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { screenRoutes, migrationScreenFeed, type MigrationScreenFeed } from '../../services/migration/src/screen';
import { ALL_DOMAINS } from '../../services/migration/src/witness';
import type { MigrationDeps, ParallelRunPolicy, RecordedParallelDay, RecordedRollback, RefusedDecision } from '../../services/migration/src/index';
import type { MigrationException } from '../../packages/migration/src/cleaning';
import type { ControlTotal } from '../../packages/migration/src/reconcile';
import type { ParallelDifference } from '../../packages/migration/src/cutover';
import type { RequestContext, Route } from '../../services/kernel/src/index';

/**
 * **The migration screen's feed (Stage C3b) — MG-04 · MG-06 · MG-10 · §28 · P-08.** Route-level over a stubbed
 * ledger. One read assembles everything the screen at the store box shows; the property under test is that it
 * INVENTS NOTHING: a section the ledger has no record for is absent, never an empty list that would read as
 * "clean" or "reconciled"; the cutover's id and clean-day count come only from the owner's written terms; who ran
 * the load comes only from the ledger; a rollback DEMONSTRATED is only one PERFORMED.
 */

const NOW = '2026-10-10T21:00:00.000Z';
const T = 't-sre';

interface Ledger {
  policy: ParallelRunPolicy | undefined;
  days: RecordedParallelDay[];
  diffs: ParallelDifference[];
  rollbacks: RecordedRollback[];
  exceptions: MigrationException[];
  totals: ControlTotal[];
  refused: RefusedDecision[];
  loadOperator: string | undefined;
  findings: { domain: string }[];
  target: 'rehearsal' | 'production';
}
const EX: MigrationException = {
  exceptionId: 'EX-1', tenantId: T, kind: 'duplicate_product', severity: 'low', confidence: 'probable',
  legacyIds: ['L-1', 'L-2'], evidence: 'same name, same pack',
  resolution: { action: 'merge', decidedBy: 'u-mgr', decidedAt: NOW, reason: 'keep the newer', survivingLegacyId: 'L-2' },
};
const TOTAL: ControlTotal = {
  totalId: 'CT-1', tenantId: T, kind: 'stock', name: 'Stock units', unit: 'quantity', legacyValue: 1000, loadedValue: 1000,
  legacyDerivation: 'SUM(qty) FROM legacy stock', loadedDerivation: 'count of opening movements',
};
const POLICY: ParallelRunPolicy = { cutoverId: 'cut-1', dailyReconcilerUserId: 'u-recon', requiredCleanDays: 3, maxParallelDays: 14, startedOn: '2026-10-01', setBy: 'u-owner', setAt: NOW };
const DAY: RecordedParallelDay = { tenantId: T, businessDate: '2026-10-01', differences: [], clean: true, totalDifferenceMinor: 0, detail: 'agree', comparisons: [], recordedBy: 'u-recon', recordedAt: NOW };
/** A rollback decided — and, when `performed`, CONFIRMED at `at` with the old system's first bill (GT-02). */
const rollback = (performed: boolean, at: string): RecordedRollback => ({
  tenantId: T, cutoverId: 'cut-1', performed, state: performed ? 'performed' : 'decided', trigger: 'owner_decision', decidedBy: 'u-owner', decidedAt: at,
  legacySystemAvailable: true, shopKeepsTrading: true, evidenceRetained: true, detail: performed ? 'rolled back' : 'decided only',
  ...(performed ? { execution: { confirmedBy: 'u-mgr', confirmedAt: at, legacyTradingFrom: at, legacyFirstBillRef: 'OLD-1001' } } : {}),
});

function stub(over: Partial<Ledger> = {}) {
  const l: Ledger = {
    policy: undefined, days: [], diffs: [], rollbacks: [], exceptions: [], totals: [], refused: [],
    loadOperator: undefined, findings: [], target: 'rehearsal', ...over,
  };
  const deps: MigrationDeps = {
    target: () => ({ targetId: 't', tenantId: T, kind: l.target, label: l.target }),
    findings: () => l.findings as never, acceptances: () => [], signatures: () => [], recordAcceptance: () => {},
    ownerId: () => 'u-owner', extractionOperator: () => l.loadOperator,
    exclusions: () => [], recordExclusion: () => {},
    parallelPolicy: () => l.policy, parallelDays: () => l.days, parallelDifferences: () => l.diffs, rollbacks: () => l.rollbacks,
    exceptions: () => l.exceptions, controlTotals: () => l.totals, refusedDecisions: () => l.refused,
    now: () => NOW,
  };
  return { l, deps, routes: screenRoutes(deps) };
}
const ctx = (over: Partial<RequestContext> = {}): RequestContext =>
  ({ tenantId: T, userId: 'u-owner', branchId: null, params: {}, query: {}, body: undefined, traceId: 't', ...over });
const routeFor = (routes: readonly Route[], method: string, path: string): Route => {
  const r = routes.find((x) => x.method === method && x.path === path);
  if (r === undefined) throw new Error(`no route ${method} ${path}`);
  return r;
};
const read = async (s: ReturnType<typeof stub>): Promise<MigrationScreenFeed> =>
  (await routeFor(s.routes, 'GET', '/v1/migration/screen').handler(ctx())).body as MigrationScreenFeed;

describe('GET /v1/migration/screen — the feed the store box pulls (C3b)', () => {
  it('exposes one read route under its own permission', () => {
    const s = stub();
    expect(s.routes.map((r) => [r.method, r.path, r.permission])).toEqual([['GET', '/v1/migration/screen', 'migration.screen.read']]);
  });

  it('an empty ledger yields a feed that says so: no policy, no exceptions, no totals, no days — and the registers that exist are empty facts', async () => {
    const feed = await read(stub());
    expect(feed.tenantId).toBe(T);
    expect(feed.generatedAt).toBe(NOW);
    expect(feed).not.toHaveProperty('policy');
    expect(feed).not.toHaveProperty('loadOperator');
    expect(feed).not.toHaveProperty('rollbackDemonstratedAt');
    expect(feed).not.toHaveProperty('exceptions');
    expect(feed).not.toHaveProperty('totals');
    expect(feed).not.toHaveProperty('parallelDays');
    expect(feed).not.toHaveProperty('parallelDifferences');
    expect(feed).not.toHaveProperty('exclusions');
    expect(feed.refusedDecisions).toEqual([]);
    expect(feed.rollbacks).toEqual([]);
    expect(feed.verification).toMatchObject({ covered: [], ownerKnown: true, extractionOperatorKnown: false, signaturesOverThisPage: 0 });
    expect(feed.verification.missing).toEqual([...ALL_DOMAINS]);
    expect(feed.verification.detail).toBe(`0 of ${ALL_DOMAINS.length} domains have a finding; still missing: ${ALL_DOMAINS.join(', ')}`);
  });

  it('a populated ledger yields every section, with the desk\'s decisions already folded in', async () => {
    const s = stub({
      policy: POLICY, days: [DAY], exceptions: [EX], totals: [TOTAL], loadOperator: 'u-loader',
      rollbacks: [rollback(false, '2026-10-02T10:00:00.000Z'), rollback(true, '2026-10-03T10:00:00.000Z'), rollback(true, '2026-10-02T22:00:00.000Z')],
      refused: [{ decisionId: 'd1', kind: 'exception_resolution', subjectId: 'EX-1', attemptedBy: 'u-cash', refusedBecause: 'decider_lacks_authority', detail: 'x', relayedBy: 'u-sync', relayedAt: NOW }],
      findings: ALL_DOMAINS.map((domain) => ({ domain })),
    });
    const feed = await read(s);
    expect(feed.policy).toEqual({ cutoverId: 'cut-1', requiredCleanDays: 3, maxParallelDays: 14, startedOn: '2026-10-01', dailyReconcilerUserId: 'u-recon' });
    expect(feed.policy).not.toHaveProperty('setBy'); // the screen gets the terms, not the audit of who set them
    expect(feed.loadOperator).toBe('u-loader');
    // The LATEST PERFORMED rollback — not the designed one, not the earlier performed one.
    expect(feed.rollbackDemonstratedAt).toBe('2026-10-03T10:00:00.000Z');
    expect(feed.exceptions).toEqual([EX]);
    expect(feed.exceptions![0]?.resolution?.decidedBy).toBe('u-mgr');
    expect(feed.totals).toEqual([TOTAL]);
    expect(feed.parallelDays).toEqual([DAY]);
    expect(feed.parallelDifferences).toEqual([]);
    expect(feed.rollbacks).toHaveLength(3);
    expect(feed.refusedDecisions).toHaveLength(1);
    expect(feed.verification).toMatchObject({ missing: [], extractionOperatorKnown: true, detail: `all ${ALL_DOMAINS.length} domains have a finding` });
  });

  it('with terms written but no day reconciled yet, the run\'s registers are present and EMPTY — a started run with nothing in it, not "no run"', async () => {
    const feed = await read(stub({ policy: POLICY }));
    expect(feed.parallelDays).toEqual([]);
    expect(feed.parallelDifferences).toEqual([]);
  });

  it('a record that says "performed" with no execution evidence behind it never demonstrates a rollback (GT-02)', async () => {
    const { execution, ...claimed } = rollback(true, NOW);
    void execution;
    const feed = await read(stub({ rollbacks: [{ ...claimed, state: 'decided' }, claimed] }));
    expect(feed).not.toHaveProperty('rollbackDemonstratedAt');
  });

  it('a rollback that was only DESIGNED leaves "demonstrated" absent, deliberately', async () => {
    const feed = await read(stub({ rollbacks: [rollback(false, NOW)] }));
    expect(feed).not.toHaveProperty('rollbackDemonstratedAt');
    expect(feed.rollbacks).toHaveLength(1);
  });

  it('refuses when the migration target is production (hard rule #7), reading nothing', async () => {
    const s = stub({ target: 'production', exceptions: [EX] });
    let thrown: { status?: number; body?: { code?: string } } | undefined;
    try { await routeFor(s.routes, 'GET', '/v1/migration/screen').handler(ctx()); } catch (e) { thrown = e as typeof thrown; }
    expect(thrown?.status).toBe(403);
    expect(thrown?.body?.code).toBe('target_is_production');
  });

  it('the assembler is the same one the route serves', async () => {
    const s = stub({ exceptions: [EX] });
    expect(await migrationScreenFeed(s.deps, T)).toEqual(await read(s));
  });

  it('the assembler never fills an absent section with a comfortable default', () => {
    const src = readFileSync('services/migration/src/screen.ts', 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    // A `?? []` or `?? 0` on a section would turn "not recorded" into "recorded as clean" — exactly what the
    // cutover gate must never be handed (tests/guardrails/the-cutover-gate-is-never-ticked.test.ts).
    expect(src).not.toMatch(/\?\? \[\]|\?\? 0|\?\? true|\?\? \{\}/);
  });
});
