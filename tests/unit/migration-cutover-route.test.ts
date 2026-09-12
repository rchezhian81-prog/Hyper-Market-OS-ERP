import { describe, it, expect } from 'vitest';
import { migrationRoutes, type MigrationDeps } from '../../services/migration/src/index';
import type { RequestContext, Route } from '../../services/kernel/src/index';
import type { LoadTarget, TargetKind } from '../../packages/migration/src/trial';

/**
 * **MG-10/11 cutover gate wired on API-12.**
 *
 * The decision on the single most irreversible action in the project. The eight checks are DERIVED
 * from evidence — an absent producer is "not known" and FAILS, never a comfortable default — and
 * decideCutover names every failed check at once. Whichever way it goes, the shop keeps trading
 * (P-01). Refuses a production target (hard rule #7). Synthetic data only.
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

const route = (tk: TargetKind = 'rehearsal') => routeFor(migrationRoutes(deps(tk)), 'POST', '/v1/migration/cutover/decision');

/** Evidence with all eight checks satisfiable. */
const fullEvidence = () => ({
  reconciliation: { tenantId: 't-sre', assessments: [], open: [], unsigned: [], qg07Passed: true, detail: 'all signed' },
  parallel: { sufficient: true, detail: '3 clean days' },
  exceptions: { tenantId: 't-sre', clearForCutover: true, blockingUnresolved: [], detail: 'clear' },
  edgeUnsyncedItems: 0,
  deltaAppliedAt: '2026-09-12T02:00:00Z',
  rollbackDemonstratedAt: '2026-09-11T22:00:00Z',
  namedTeam: [{ userId: 'u-owner', role: 'owner' }, { userId: 'u-op', role: 'operator' }],
  ownerGoBy: 'u-owner',
});

describe('POST /v1/migration/cutover/decision (MG-10/11)', () => {
  it('says GO when all eight checks are answered from evidence and pass, and the shop still trades', async () => {
    const res = await route().handler(ctx({ body: { evidence: fullEvidence() } }));
    expect(res.status).toBe(200);
    const r = res.body as { decision: { go: boolean; failed: string[]; shopKeepsTrading: true } };
    expect(r.decision.go).toBe(true);
    expect(r.decision.failed).toEqual([]);
    expect(r.decision.shopKeepsTrading).toBe(true);
  });

  it('says NO GO and names the failed check when the owner has not given GO', async () => {
    const { ownerGoBy, ...rest } = fullEvidence();
    void ownerGoBy;
    const res = await route().handler(ctx({ body: { evidence: rest } }));
    const r = res.body as { decision: { go: boolean; failed: string[]; shopKeepsTrading: true } };
    expect(r.decision.go).toBe(false);
    expect(r.decision.failed).toContain('owner_go');
    expect(r.decision.shopKeepsTrading).toBe(true);
  });

  it('treats an ABSENT producer as not-known and fails it — never a default pass', async () => {
    // No reconciliation and no edge count supplied at all.
    const res = await route().handler(ctx({ body: { evidence: { ownerGoBy: 'u-owner', namedTeam: [{ userId: 'u-owner', role: 'owner' }] } } }));
    const r = res.body as { decision: { go: boolean }; notKnown: string[] };
    expect(r.decision.go).toBe(false);
    expect(r.notKnown).toContain('control_totals_signed');
    expect(r.notKnown).toContain('edge_fully_synced');
  });

  it('refuses a production target, a missing evidence object, and a malformed part', async () => {
    expect((await thrown(() => route('production').handler(ctx({ body: { evidence: fullEvidence() } })))).body.code).toBe('target_is_production');
    expect((await thrown(() => route().handler(ctx({ body: {} })))).body.code).toBe('not_readable_as_cutover_evidence');
    expect((await thrown(() => route().handler(ctx({ body: { evidence: { reconciliation: { qg07Passed: 'yes' } } } })))).body.code).toBe('malformed_cutover_evidence');
  });
});
