import { describe, it, expect } from 'vitest';
import { migrationRoutes, type MigrationDeps } from '../../services/migration/src/index';
import type { RequestContext, Route } from '../../services/kernel/src/index';
import type { LoadTarget, TargetKind } from '../../packages/migration/src/trial';
import type { MappingTable } from '../../packages/migration/src/mapping';

/**
 * **MG-03 mapping wired on API-12: approve, and measure coverage against the real extract.**
 *
 * A mapping table is a set of accounting decisions, so it is approved by a named person and the
 * contradiction that cannot be resolved at load — one legacy value meaning two targets — is refused
 * here. Coverage is measured against the values ACTUALLY in the source, because an uncovered value is
 * an exception, never a default (that is how nine products silently become zero-rated). Both routes
 * refuse a production target (hard rule #7). Synthetic data only.
 */

const NOW = '2026-09-12T10:00:00Z';

const deps = (targetKind: TargetKind = 'rehearsal'): MigrationDeps => ({
  target: (tenantId): LoadTarget => ({ targetId: `tgt-${tenantId}`, tenantId, kind: targetKind, label: targetKind }),
  findings: () => [], acceptances: () => [], signatures: () => [],
  recordAcceptance: () => {}, ownerId: () => 'u-owner', extractionOperator: () => 'u-op',
  exclusions: () => [], recordExclusion: () => {}, now: () => NOW,
});

const ctx = (over: Partial<RequestContext>): RequestContext =>
  ({ tenantId: 't-sre', userId: 'u-approver', branchId: null, params: {}, query: {}, body: undefined, traceId: 't', ...over });

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

const approveRoute = (tk: TargetKind = 'rehearsal') => routeFor(migrationRoutes(deps(tk)), 'POST', '/v1/migration/mapping/approve');
const coverageRoute = (tk: TargetKind = 'rehearsal') => routeFor(migrationRoutes(deps(tk)), 'POST', '/v1/migration/mapping/coverage');

const table = (over: Partial<MappingTable> = {}): MappingTable => ({
  mappingId: 'MAP-1', tenantId: 't-sre', version: 1, status: 'draft',
  entries: [
    { domain: 'tax_code', legacyValue: 'TX', targetValue: 'GST18', rationale: 'legacy 18% code' },
    { domain: 'uom', legacyValue: 'KG', targetValue: 'kg', rationale: 'kilogram' },
  ],
  ...over,
});

describe('POST /v1/migration/mapping/approve (MG-03)', () => {
  it('approves a clean table, stamping the approver from the token', async () => {
    const res = await approveRoute().handler(ctx({ body: { table: table() } }));
    expect(res.status).toBe(200);
    const t = res.body as MappingTable;
    expect(t.status).toBe('approved');
    expect(t.approvedBy).toBe('u-approver');
  });

  it('REFUSES one legacy value mapping to two different targets (the contradiction that matters)', async () => {
    const conflicted = table({ entries: [
      { domain: 'tax_code', legacyValue: 'TX', targetValue: 'GST18', rationale: 'a' },
      { domain: 'tax_code', legacyValue: 'TX', targetValue: 'GST5', rationale: 'b' },
    ] });
    const e = await thrown(() => approveRoute().handler(ctx({ body: { table: conflicted } })));
    expect(e.status).toBe(422);
    expect(e.body.code).toBe('one_legacy_value_two_targets');
  });

  it('refuses a missing rationale, an empty table, and an already-approved table', async () => {
    expect((await thrown(() => approveRoute().handler(ctx({ body: { table: table({ entries: [{ domain: 'uom', legacyValue: 'KG', targetValue: 'kg', rationale: '' }] }) } })))).body.code).toBe('no_rationale');
    expect((await thrown(() => approveRoute().handler(ctx({ body: { table: table({ entries: [] }) } })))).body.code).toBe('empty_table');
    expect((await thrown(() => approveRoute().handler(ctx({ body: { table: table({ status: 'approved' }) } })))).body.code).toBe('already_approved');
  });

  it('refuses a production target, a malformed body, and another tenant\'s table', async () => {
    expect((await thrown(() => approveRoute('production').handler(ctx({ body: { table: table() } })))).body.code).toBe('target_is_production');
    expect((await thrown(() => approveRoute().handler(ctx({ body: { table: { mappingId: 'x' } } })))).status).toBe(400);
    expect((await thrown(() => approveRoute().handler(ctx({ body: { table: table({ tenantId: 't-other' }) } })))).body.code).toBe('mapping_belongs_to_another_tenant');
  });
});

describe('POST /v1/migration/mapping/coverage (MG-03)', () => {
  const approved = table({ status: 'approved', approvedBy: 'u-owner', approvedAt: NOW });

  it('reports full coverage when every observed value has an approved mapping', async () => {
    const res = await coverageRoute().handler(ctx({ body: {
      table: approved,
      observed: [{ domain: 'tax_code', value: 'TX', rows: 40 }, { domain: 'uom', value: 'KG', rows: 12 }],
    } }));
    expect(res.status).toBe(200);
    const r = res.body as { fullyCovered: boolean; totalAffectedRows: number };
    expect(r.fullyCovered).toBe(true);
    expect(r.totalAffectedRows).toBe(0);
  });

  it('names the uncovered values and how many rows they affect — the size of the problem', async () => {
    const res = await coverageRoute().handler(ctx({ body: {
      table: approved,
      observed: [{ domain: 'tax_code', value: 'TX', rows: 40 }, { domain: 'tax_code', value: 'ZZ', rows: 9 }],
    } }));
    const r = res.body as { fullyCovered: boolean; totalAffectedRows: number };
    expect(r.fullyCovered).toBe(false);
    expect(r.totalAffectedRows).toBe(9);
  });

  it('refuses a production target and a malformed body', async () => {
    expect((await thrown(() => coverageRoute('production').handler(ctx({ body: { table: approved, observed: [] } })))).body.code).toBe('target_is_production');
    expect((await thrown(() => coverageRoute().handler(ctx({ body: { table: approved, observed: [{ domain: 'nope', value: 'x', rows: 1 }] } })))).status).toBe(400);
  });
});
