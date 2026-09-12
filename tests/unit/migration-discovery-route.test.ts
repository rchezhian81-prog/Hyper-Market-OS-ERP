import { describe, it, expect } from 'vitest';
import { migrationRoutes, type MigrationDeps } from '../../services/migration/src/index';
import type { RequestContext, Route } from '../../services/kernel/src/index';
import type { LoadTarget, TargetKind } from '../../packages/migration/src/trial';
import type { DiscoveryResult, LegacySource } from '../../packages/migration/src/discovery';

/**
 * **MG-01 wired on API-12: POST /v1/migration/discovery.**
 *
 * The first step of the go-live pipeline reaches the cloud surface: the operator declares the legacy
 * sources and the tested `inventorySources` names what is missing (an unowned source, an estimated or
 * unknown volume, no retention period, a source that cannot be extracted). Read-only — it assesses and
 * reports, storing nothing — and it refuses a production target before it looks at anything (hard rule
 * #7). Synthetic data only.
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

const source = (over: Partial<LegacySource> = {}): LegacySource => ({
  sourceId: 's1', tenantId: 't-sre', name: 'Incumbent ERP DB', kind: 'erp_database',
  ownerUserId: 'u-it', rowCount: 40_000, volumeBasis: 'counted', retentionYears: 8, extractable: true, ...over,
});

interface Thrown { readonly status: number; readonly body: { readonly code: string } }
async function thrown(fn: () => Promise<unknown>): Promise<Thrown> {
  try { await fn(); } catch (e) { return e as Thrown; }
  throw new Error('expected the handler to throw');
}

const run = (body: unknown, targetKind: TargetKind = 'rehearsal') =>
  routeFor(migrationRoutes(deps(targetKind)), 'POST', '/v1/migration/discovery').handler(ctx({ body }));

describe('POST /v1/migration/discovery (MG-01)', () => {
  it('reports a clean inventory as complete, with no gaps and the counted rows', async () => {
    const res = await run({ sources: [source()] });
    expect(res.status).toBe(200);
    const r = res.body as DiscoveryResult;
    expect(r.complete).toBe(true);
    expect(r.gaps).toHaveLength(0);
    expect(r.countedRows).toBe(40_000);
  });

  it('names the gaps — an unowned, estimated, no-retention, non-extractable source is not complete', async () => {
    const res = await run({ sources: [source({
      sourceId: 's2', name: 'Loyalty points spreadsheet', kind: 'spreadsheet',
      ownerUserId: undefined, volumeBasis: 'estimated', retentionYears: undefined, extractable: false,
    })] });
    const r = res.body as DiscoveryResult;
    expect(r.complete).toBe(false);
    const kinds = r.gaps.map((g) => g.kind);
    expect(kinds).toContain('no_named_owner');
    expect(kinds).toContain('volume_estimated');
    expect(kinds).toContain('no_retention_period');
    expect(kinds).toContain('not_extractable');
  });

  it('stamps the tenant from the caller, never the body (tenant isolation)', async () => {
    const res = await run({ sources: [source({ tenantId: 'someone-else' })] });
    const r = res.body as DiscoveryResult;
    expect(r.tenantId).toBe('t-sre');
    expect(r.sources[0]!.tenantId).toBe('t-sre');
  });

  it('refuses a PRODUCTION target before assessing anything (hard rule #7)', async () => {
    const e = await thrown(() => run({ sources: [source()] }, 'production'));
    expect(e.status).toBe(403);
    expect(e.body.code).toBe('target_is_production');
  });

  it('refuses a payload that is not a source inventory (400), nothing assessed', async () => {
    expect((await thrown(() => run({ sources: [] }))).status).toBe(400);
    expect((await thrown(() => run({ sources: [{ sourceId: 's', name: 'x' }] }))).body.code)
      .toBe('not_readable_as_a_source_inventory');
    expect((await thrown(() => run({}))).status).toBe(400);
  });
});
