import { describe, it, expect } from 'vitest';
import { decisionRoutes, type RefusedDecision } from '../../services/migration/src/decisions';
import type { MigrationDeps } from '../../services/migration/src/index';
import type { MigrationException, ExceptionResolution } from '../../packages/migration/src/cleaning';
import type { ControlTotal, TotalSignature } from '../../packages/migration/src/reconcile';
import type { RequestContext, Route } from '../../services/kernel/src/index';

/**
 * **MG-04 / MG-06 — the migration screen's decisions, KEPT on the cloud (Stage C3a).** Route-level with a
 * stubbed ledger: exceptions and control totals are recorded once; a named person resolves/signs at the desk
 * under the engine's own rules; a decision RELAYED by the store box is applied only after the cloud re-checks
 * the decider's authority and re-runs the engine — otherwise it is recorded as REFUSED (never dropped, never
 * silently applied) and acknowledged so the box stops retrying.
 */

const NOW = '2026-10-10T21:00:00.000Z';
const T = 't-sre';

interface Ledger {
  exceptions: MigrationException[];
  resolutions: Map<string, ExceptionResolution>;
  totals: ControlTotal[];
  signatures: Map<string, TotalSignature>;
  refused: RefusedDecision[];
  grants: Map<string, Set<string>>;      // userId -> permissions
  loadOperator: string | undefined;
}
const exception = (over: Partial<MigrationException> = {}): MigrationException => ({
  exceptionId: 'EX-1', tenantId: T, kind: 'duplicate_product', severity: 'low', confidence: 'probable',
  legacyIds: ['L-1', 'L-2'], evidence: 'same name, same pack', ...over,
});
const total = (over: Partial<ControlTotal> = {}): ControlTotal => ({
  totalId: 'CT-1', tenantId: T, kind: 'stock', name: 'Stock units', unit: 'quantity', legacyValue: 1000, loadedValue: 1000,
  legacyDerivation: 'SUM(qty) FROM legacy stock', loadedDerivation: 'count of opening movements', ...over,
});
function stub(over: Partial<Ledger> = {}) {
  const l: Ledger = {
    exceptions: [], resolutions: new Map(), totals: [], signatures: new Map(), refused: [],
    grants: new Map([['u-owner', new Set(['migration.exception.resolve', 'migration.controltotal.sign'])], ['u-mgr', new Set(['migration.exception.resolve'])], ['u-ca', new Set(['migration.controltotal.sign'])]]),
    loadOperator: 'u-loader', ...over,
  };
  const deps: MigrationDeps = {
    target: () => ({ targetId: 't', tenantId: T, kind: 'rehearsal', label: 'rehearsal' }),
    findings: () => [], acceptances: () => [], signatures: () => [], recordAcceptance: () => {},
    ownerId: () => 'u-owner', extractionOperator: () => l.loadOperator,
    rolesOf: (_t, u) => (u === 'u-ca' ? ['chartered_accountant'] : u === 'u-owner' ? ['owner'] : ['store_manager']),
    exclusions: () => [], recordExclusion: () => {},
    exceptions: () => l.exceptions.map((e) => (l.resolutions.has(e.exceptionId) ? { ...e, resolution: l.resolutions.get(e.exceptionId)! } : e)),
    recordException: (_t, e) => { l.exceptions.push(e); },
    recordExceptionResolution: (_t, id, r) => { l.resolutions.set(id, r); },
    controlTotals: () => l.totals.map((t) => (l.signatures.has(t.totalId) ? { ...t, signature: l.signatures.get(t.totalId)! } : t)),
    recordControlTotal: (_t, t) => { l.totals.push(t); },
    recordTotalSignature: (_t, id, s) => { l.signatures.set(id, s); },
    refusedDecisions: () => l.refused,
    recordRefusedDecision: (_t, d) => { l.refused.push(d); },
    holdsPermission: (_t, u, p) => l.grants.get(u)?.has(p) ?? false,
    now: () => NOW,
  };
  return { l, routes: decisionRoutes(deps) };
}
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
const recordEx = (routes: readonly Route[], exceptions: unknown[]) => routeFor(routes, 'POST', '/v1/migration/exceptions').handler(ctx({ body: { exceptions } }));
const resolve = (routes: readonly Route[], id: string, body: unknown, userId = 'u-mgr') =>
  routeFor(routes, 'POST', '/v1/migration/exceptions/:exceptionId/resolution').handler(ctx({ params: { exceptionId: id }, body, userId }));
const resolveSynced = (routes: readonly Route[], id: string, body: unknown) =>
  routeFor(routes, 'POST', '/v1/migration/exceptions/:exceptionId/resolution/synced').handler(ctx({ params: { exceptionId: id }, body, userId: 'u-sync' }));
const recordTotals = (routes: readonly Route[], totals: unknown[]) => routeFor(routes, 'POST', '/v1/migration/control-totals').handler(ctx({ body: { totals } }));
const sign = (routes: readonly Route[], id: string, userId: string, statement = 'checked both sides') =>
  routeFor(routes, 'POST', '/v1/migration/control-totals/:totalId/signature').handler(ctx({ params: { totalId: id }, body: { statement }, userId }));
const signSynced = (routes: readonly Route[], id: string, body: unknown) =>
  routeFor(routes, 'POST', '/v1/migration/control-totals/:totalId/signature/synced').handler(ctx({ params: { totalId: id }, body, userId: 'u-sync' }));

describe('MG-04 — exceptions are recorded once and resolved by a named person', () => {
  it('records the cleaning report\'s exceptions once (a re-post records nothing new) and reports what is outstanding', async () => {
    const { routes, l } = stub();
    const first = await recordEx(routes, [exception(), exception({ exceptionId: 'EX-2', severity: 'blocking', kind: 'negative_stock', legacyIds: ['L-9'] })]);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ recorded: 2, alreadyKnown: 0, outstanding: { total: 2, clearForCutover: false } });
    expect((await recordEx(routes, [exception()])).body).toMatchObject({ recorded: 0, alreadyKnown: 1 });
    expect(l.exceptions).toHaveLength(2);
    // Stamped with THIS tenant, whatever the body said.
    expect((await recordEx(routes, [exception({ exceptionId: 'EX-3', tenantId: 'someone-else' })])).status).toBe(201);
    expect(l.exceptions[2]?.tenantId).toBe(T);
    expect((await thrown(() => recordEx(routes, [{ exceptionId: 'x', kind: 'not_a_kind' }]))).status).toBe(400);
  });
  it('resolves at the desk under the authenticated decider, and refuses the engine\'s own cases', async () => {
    const { routes, l } = stub();
    await recordEx(routes, [exception()]);
    expect((await thrown(() => resolve(routes, 'EX-9', { action: 'correct', reason: 'r' }))).status).toBe(404);
    expect((await thrown(() => resolve(routes, 'EX-1', { action: 'merge', reason: 'same item' }))).body.code).toBe('merge_without_survivor');
    expect((await thrown(() => resolve(routes, 'EX-1', { action: 'merge', reason: 'same item', survivingLegacyId: 'L-7' }))).body.code).toBe('survivor_not_involved');
    expect((await thrown(() => resolve(routes, 'EX-1', { action: 'correct', reason: '' }))).body.code).toBe('no_reason');
    const ok = await resolve(routes, 'EX-1', { action: 'merge', reason: 'same item, keep the newer', survivingLegacyId: 'L-2' });
    expect(ok.status).toBe(200);
    expect(l.resolutions.get('EX-1')).toMatchObject({ action: 'merge', decidedBy: 'u-mgr', decidedAt: NOW, survivingLegacyId: 'L-2' });
    expect(ok.body).toMatchObject({ outstanding: { total: 1, unresolved: [], clearForCutover: true } });
    // The first decision is the evidence — a second is refused.
    expect((await thrown(() => resolve(routes, 'EX-1', { action: 'exclude', reason: 'changed my mind' }, 'u-owner'))).body.code).toBe('already_resolved');
  });
});

describe('MG-04 / §31 — a resolution relayed from the store box', () => {
  it('applies a decision by a person who genuinely holds the authority, and replays idempotently', async () => {
    const { routes, l } = stub();
    await recordEx(routes, [exception()]);
    const res = await resolveSynced(routes, 'EX-1', { action: 'correct', decidedBy: 'u-mgr', reason: 'counted the shelf', decidedAt: '2026-10-10T20:00:00.000Z' });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ applied: true });
    expect(l.resolutions.get('EX-1')).toMatchObject({ decidedBy: 'u-mgr', decidedAt: '2026-10-10T20:00:00.000Z' });
    const again = await resolveSynced(routes, 'EX-1', { action: 'correct', decidedBy: 'u-mgr', reason: 'counted the shelf' });
    expect(again.body).toMatchObject({ applied: true, alreadyApplied: true });
    expect(l.refused).toHaveLength(0);
  });
  it('RECORDS AS REFUSED — never applies, never drops — a decision by someone without authority, on an unknown exception, or against an earlier decision', async () => {
    const { routes, l } = stub();
    await recordEx(routes, [exception()]);
    const noAuth = await resolveSynced(routes, 'EX-1', { action: 'correct', decidedBy: 'u-cashier', reason: 'r' });
    expect(noAuth.status).toBe(202);
    expect(noAuth.body).toMatchObject({ applied: false, refusedBecause: 'decider_lacks_authority' });
    expect(l.resolutions.has('EX-1')).toBe(false);
    const unknown = await resolveSynced(routes, 'EX-404', { action: 'correct', decidedBy: 'u-mgr', reason: 'r' });
    expect(unknown.body).toMatchObject({ applied: false, refusedBecause: 'unknown_exception' });
    await resolve(routes, 'EX-1', { action: 'exclude', reason: 'obsolete line' }, 'u-owner');
    const late = await resolveSynced(routes, 'EX-1', { action: 'correct', decidedBy: 'u-mgr', reason: 'r' });
    expect(late.body).toMatchObject({ applied: false, refusedBecause: 'already_resolved' });
    expect(l.refused.map((r) => r.refusedBecause)).toEqual(['decider_lacks_authority', 'unknown_exception', 'already_resolved']);
    expect(l.refused[0]).toMatchObject({ kind: 'exception_resolution', subjectId: 'EX-1', attemptedBy: 'u-cashier', relayedBy: 'u-sync', relayedAt: NOW });
    // Visible on the read.
    const read = await routeFor(routes, 'GET', '/v1/migration/exceptions').handler(ctx({}));
    expect((read.body as { refusedDecisions: unknown[] }).refusedDecisions).toHaveLength(3);
    expect((await thrown(() => resolveSynced(routes, 'EX-1', { action: 'correct', reason: 'r' }))).status).toBe(400); // no decider named
  });
});

describe('MG-06 — control totals are recorded once and signed under the engine\'s rules', () => {
  it('records totals, refusing a self-comparison with nothing recorded, and reads the reconciliation', async () => {
    const { routes, l } = stub();
    expect((await thrown(() => recordTotals(routes, [total({ loadedDerivation: 'SUM(qty) FROM legacy stock' })]))).body.code).toBe('same_derivation_both_sides');
    expect(l.totals).toHaveLength(0);
    const ok = await recordTotals(routes, [total(), total({ totalId: 'CT-2', kind: 'financial', name: 'Debtors', unit: 'minor_currency', legacyValue: 500, loadedValue: 500, legacyDerivation: 'ledger', loadedDerivation: 'opening events' })]);
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ recorded: 2, reconciliation: { qg07Passed: false } }); // reconciled but unsigned
    expect((await recordTotals(routes, [total()])).body).toMatchObject({ recorded: 0, alreadyKnown: 1 });
  });
  it('signs at the desk: not the loader, finance only by the CA, never an open total, never twice', async () => {
    const { routes, l } = stub();
    await recordTotals(routes, [total(), total({ totalId: 'CT-FIN', kind: 'financial', name: 'Debtors', unit: 'minor_currency', legacyValue: 500, loadedValue: 500, legacyDerivation: 'ledger', loadedDerivation: 'opening events' }), total({ totalId: 'CT-OPEN', name: 'Open', loadedValue: 990 })]);
    expect((await thrown(() => sign(routes, 'CT-1', 'u-loader'))).body.code).toBe('signer_ran_the_load');
    expect((await thrown(() => sign(routes, 'CT-FIN', 'u-owner'))).body.code).toBe('finance_or_tax_needs_ca');
    expect((await thrown(() => sign(routes, 'CT-OPEN', 'u-owner'))).body.code).toBe('total_is_open');
    expect((await thrown(() => sign(routes, 'CT-404', 'u-owner'))).status).toBe(404);
    expect((await sign(routes, 'CT-1', 'u-owner')).status).toBe(200);
    expect(l.signatures.get('CT-1')).toMatchObject({ signedBy: 'u-owner', signerRole: 'owner', signedAt: NOW, statement: 'checked both sides' });
    expect((await sign(routes, 'CT-FIN', 'u-ca')).body).toMatchObject({ total: { signature: { signerRole: 'chartered_accountant' } } });
    expect((await thrown(() => sign(routes, 'CT-1', 'u-ca'))).body.code).toBe('already_signed');
    const { routes: nobody } = stub({ loadOperator: undefined });
    await recordTotals(nobody, [total()]);
    expect((await thrown(() => sign(nobody, 'CT-1', 'u-owner'))).body.code).toBe('nobody_ran_the_load');
  });
});

describe('MG-06 / §31 — a signature relayed from the store box', () => {
  it('applies a signature by a genuine signer (role from THEIR grants, never the body), replays idempotently', async () => {
    const { routes, l } = stub();
    await recordTotals(routes, [total({ totalId: 'CT-FIN', kind: 'financial', name: 'Debtors', unit: 'minor_currency', legacyValue: 500, loadedValue: 500, legacyDerivation: 'ledger', loadedDerivation: 'opening events' })]);
    const res = await signSynced(routes, 'CT-FIN', { signedBy: 'u-ca', signerRole: 'owner', statement: 'agrees to the ledger', signedAt: '2026-10-10T20:30:00.000Z' });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ applied: true });
    expect(l.signatures.get('CT-FIN')).toMatchObject({ signedBy: 'u-ca', signerRole: 'chartered_accountant', signedAt: '2026-10-10T20:30:00.000Z' });
    expect((await signSynced(routes, 'CT-FIN', { signedBy: 'u-ca', statement: 'agrees to the ledger' })).body).toMatchObject({ applied: true, alreadyApplied: true });
  });
  it('RECORDS AS REFUSED a signer without authority, the loader, a non-CA on finance, an open total, an unknown total, a second signer', async () => {
    const { routes, l } = stub();
    await recordTotals(routes, [total(), total({ totalId: 'CT-FIN', kind: 'financial', name: 'Debtors', unit: 'minor_currency', legacyValue: 500, loadedValue: 500, legacyDerivation: 'ledger', loadedDerivation: 'opening events' }), total({ totalId: 'CT-OPEN', name: 'Open', loadedValue: 990 })]);
    expect((await signSynced(routes, 'CT-1', { signedBy: 'u-mgr', statement: 's' })).body).toMatchObject({ applied: false, refusedBecause: 'signer_lacks_authority' });
    l.grants.set('u-loader', new Set(['migration.controltotal.sign']));
    expect((await signSynced(routes, 'CT-1', { signedBy: 'u-loader', statement: 's' })).body).toMatchObject({ applied: false, refusedBecause: 'signer_ran_the_load' });
    expect((await signSynced(routes, 'CT-FIN', { signedBy: 'u-owner', statement: 's' })).body).toMatchObject({ applied: false, refusedBecause: 'finance_or_tax_needs_ca' });
    expect((await signSynced(routes, 'CT-OPEN', { signedBy: 'u-owner', statement: 's' })).body).toMatchObject({ applied: false, refusedBecause: 'total_is_open' });
    expect((await signSynced(routes, 'CT-404', { signedBy: 'u-owner', statement: 's' })).body).toMatchObject({ applied: false, refusedBecause: 'unknown_total' });
    await sign(routes, 'CT-1', 'u-owner');
    expect((await signSynced(routes, 'CT-1', { signedBy: 'u-ca', statement: 's' })).body).toMatchObject({ applied: false, refusedBecause: 'already_signed' });
    expect(l.signatures.size).toBe(1);
    expect(l.refused).toHaveLength(6);
    const read = await routeFor(routes, 'GET', '/v1/migration/control-totals').handler(ctx({}));
    expect((read.body as { refusedDecisions: unknown[]; reconciliation: { qg07Passed: boolean } }).refusedDecisions).toHaveLength(6);
  });
  it('refuses 503 when this deployment has no ledger to keep decisions in', async () => {
    const { routes } = stub();
    const bare = decisionRoutes({ target: () => ({ targetId: 't', tenantId: T, kind: 'rehearsal', label: 'rehearsal' }), findings: () => [], acceptances: () => [], signatures: () => [], recordAcceptance: () => {}, ownerId: () => undefined, extractionOperator: () => undefined, exclusions: () => [], recordExclusion: () => {}, now: () => NOW });
    expect((await thrown(() => routeFor(bare, 'GET', '/v1/migration/exceptions').handler(ctx({})))).status).toBe(503);
    expect(routes.length).toBe(8);
  });
});
