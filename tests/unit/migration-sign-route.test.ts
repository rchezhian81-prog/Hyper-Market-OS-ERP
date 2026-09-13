import { describe, it, expect } from 'vitest';
import { migrationRoutes, type MigrationDeps } from '../../services/migration/src/index';
import type { RequestContext, Route } from '../../services/kernel/src/index';
import type { LoadTarget, TargetKind } from '../../packages/migration/src/trial';
import type { ControlTotal } from '../../packages/migration/src/reconcile';

/**
 * **MG-06 sign-off wired on API-12, with the Chartered Accountant role.**
 *
 * A control total is signed by a NAMED person, and two refusals carry the control: the person who ran
 * the load cannot sign its totals (§28), and a finance or tax total is the chartered accountant's to
 * sign and nobody else's (M23 / C-01). The signer's role is read from their own grants, never the
 * body. An open total cannot be signed at all. Refuses a production target (hard rule #7).
 */

const NOW = '2026-09-12T12:00:00Z';

const deps = (roles: readonly string[], targetKind: TargetKind = 'rehearsal'): MigrationDeps => ({
  target: (tenantId): LoadTarget => ({ targetId: `tgt-${tenantId}`, tenantId, kind: targetKind, label: targetKind }),
  findings: () => [], acceptances: () => [], signatures: () => [],
  recordAcceptance: () => {}, ownerId: () => 'u-owner', extractionOperator: () => 'u-op',
  rolesOf: () => roles, exclusions: () => [], recordExclusion: () => {}, now: () => NOW,
});

const ctx = (over: Partial<RequestContext>): RequestContext =>
  ({ tenantId: 't-sre', userId: 'u-ca', branchId: null, params: {}, query: {}, body: undefined, traceId: 't', ...over });

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

const signRoute = (roles: readonly string[], tk: TargetKind = 'rehearsal') =>
  routeFor(migrationRoutes(deps(roles, tk)), 'POST', '/v1/migration/control-totals/sign');

const financeTotal = (over: Partial<ControlTotal> = {}): ControlTotal => ({
  totalId: 'CT-fin', tenantId: 't-sre', kind: 'financial', name: 'Trial balance', unit: 'minor_currency',
  legacyValue: 500000, loadedValue: 500000,
  legacyDerivation: 'legacy trial balance export', loadedDerivation: 'sum of loaded opening journals',
  ...over,
});
const stockTotal = (over: Partial<ControlTotal> = {}): ControlTotal => ({
  totalId: 'CT-stock', tenantId: 't-sre', kind: 'stock', name: 'Stock value', unit: 'minor_currency',
  legacyValue: 100000, loadedValue: 100000,
  legacyDerivation: 'legacy stock export', loadedDerivation: 'loaded stock_levels',
  ...over,
});

const body = (over: Record<string, unknown>) => ({ totalId: 'CT-fin', loadOperator: 'u-op', statement: 'checked', ...over });

describe('POST /v1/migration/control-totals/sign (MG-06 + CA role)', () => {
  it('lets a chartered accountant sign a reconciled FINANCE total', async () => {
    const res = await signRoute(['chartered_accountant']).handler(ctx({ body: body({ totals: [financeTotal()] }) }));
    expect(res.status).toBe(200);
    const r = res.body as { totals: ControlTotal[] };
    const signed = r.totals.find((t) => t.totalId === 'CT-fin');
    expect(signed?.signature?.signerRole).toBe('chartered_accountant');
    expect(signed?.signature?.signedBy).toBe('u-ca');
  });

  it('REFUSES a finance/tax total signed by anyone who is not a chartered accountant', async () => {
    const e = await thrown(() => signRoute(['owner']).handler(ctx({ userId: 'u-owner', body: body({ totals: [financeTotal()] }) })));
    expect(e.status).toBe(422);
    expect(e.body.code).toBe('finance_or_tax_needs_ca');
  });

  it('lets a non-CA sign a non-finance total (stock)', async () => {
    const res = await signRoute(['owner']).handler(ctx({ userId: 'u-owner', body: body({ totalId: 'CT-stock', totals: [stockTotal()] }) }));
    expect(res.status).toBe(200);
    const r = res.body as { totals: ControlTotal[] };
    expect(r.totals.find((t) => t.totalId === 'CT-stock')?.signature?.signerRole).toBe('owner');
  });

  it('refuses the person who ran the load signing its own totals (§28)', async () => {
    // signedBy (u-ca) is also the loadOperator.
    const e = await thrown(() => signRoute(['chartered_accountant']).handler(ctx({ body: body({ totals: [financeTotal()], loadOperator: 'u-ca' }) })));
    expect(e.status).toBe(422);
    expect(e.body.code).toBe('signer_ran_the_load');
  });

  it('refuses an OPEN total — there is no provisional signature', async () => {
    const e = await thrown(() => signRoute(['chartered_accountant']).handler(ctx({ body: body({ totals: [financeTotal({ loadedValue: 499000 })] }) })));
    expect(e.status).toBe(422);
    expect(e.body.code).toBe('total_is_open');
  });

  it('refuses a production target and a malformed body', async () => {
    expect((await thrown(() => signRoute(['chartered_accountant'], 'production').handler(ctx({ body: body({ totals: [financeTotal()] }) })))).body.code).toBe('target_is_production');
    expect((await thrown(() => signRoute(['chartered_accountant']).handler(ctx({ body: { totals: [financeTotal()] } })))).status).toBe(400);
  });
});
