import { describe, it, expect } from 'vitest';
import { migrationRoutes, type MigrationDeps } from '../../services/migration/src/index';
import type { RequestContext, Route } from '../../services/kernel/src/index';
import type { LoadTarget, TargetKind } from '../../packages/migration/src/trial';
import type { SealedExtract, VerifyResult } from '../../packages/migration/src/discovery';

/**
 * **MG-02 preservation wired on API-12: seal at extraction, verify at load.**
 *
 * A raw extract is SEALED when it is taken (hashed + stamped + refused without a verified backup),
 * and VERIFIED at load time against that seal — both the digest and the row count, because a
 * truncated extract loads perfectly and reconciles to a smaller, self-consistent shop. Both routes
 * refuse a production target (hard rule #7). Synthetic data only.
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

const sealRoute = (tk: TargetKind = 'rehearsal') => routeFor(migrationRoutes(deps(tk)), 'POST', '/v1/migration/extracts/:extractId/seal');
const verifyRoute = (tk: TargetKind = 'rehearsal') => routeFor(migrationRoutes(deps(tk)), 'POST', '/v1/migration/extracts/verify');

const goodSealBody = (over: Record<string, unknown> = {}) => ({
  sourceId: 'src-erp', material: 'row1\nrow2\nrow3', rowCount: 3, extractedBy: 'u-op',
  backupVerifiedAt: '2026-09-12T09:00:00Z', ...over,
});

describe('POST /v1/migration/extracts/:extractId/seal (MG-02)', () => {
  it('seals a raw extract taken with a verified backup, hashing it and stamping who took it', async () => {
    const res = await sealRoute().handler(ctx({ params: { extractId: 'X-1' }, body: goodSealBody() }));
    expect(res.status).toBe(200);
    const e = res.body as SealedExtract;
    expect(e.extractId).toBe('X-1');
    expect(e.tenantId).toBe('t-sre');
    expect(e.sealed).toBe(true);
    expect(e.digest).not.toBe('');
    expect(e.rowCount).toBe(3);
  });

  it('REFUSES to seal without a verified backup restore (MG-02, the difference that matters)', async () => {
    const e = await thrown(() => sealRoute().handler(ctx({ params: { extractId: 'X-2' }, body: goodSealBody({ backupVerifiedAt: undefined }) })));
    expect(e.status).toBe(422);
    expect(e.body.code).toBe('backup_not_verified');
  });

  it('refuses an empty extract and one with nobody\'s name on it', async () => {
    expect((await thrown(() => sealRoute().handler(ctx({ params: { extractId: 'X-3' }, body: goodSealBody({ rowCount: 0 }) })))).body.code).toBe('empty_extract');
    expect((await thrown(() => sealRoute().handler(ctx({ params: { extractId: 'X-4' }, body: goodSealBody({ extractedBy: '' }) })))).body.code).toBe('no_extractor_named');
  });

  it('refuses a production target and a malformed body', async () => {
    expect((await thrown(() => sealRoute('production').handler(ctx({ params: { extractId: 'X-5' }, body: goodSealBody() })))).body.code).toBe('target_is_production');
    expect((await thrown(() => sealRoute().handler(ctx({ params: { extractId: 'X-6' }, body: { sourceId: 'src' } })))).status).toBe(400);
  });
});

describe('POST /v1/migration/extracts/verify (MG-02)', () => {
  // Seal once, then verify the same bytes and a tampered/truncated load against that seal.
  const seal = async (): Promise<SealedExtract> =>
    (await sealRoute().handler(ctx({ params: { extractId: 'X-1' }, body: goodSealBody() }))).body as SealedExtract;

  it('verifies the bytes about to be loaded ARE the bytes that were sealed', async () => {
    const extract = await seal();
    const res = await verifyRoute().handler(ctx({ body: { extract, material: 'row1\nrow2\nrow3', rowCount: 3 } }));
    expect(res.status).toBe(200);
    const v = res.body as VerifyResult;
    expect(v.matches).toBe(true);
    expect(v.rowCountMatches).toBe(true);
  });

  it('catches a changed digest (content moved) and a truncated load (part did not arrive)', async () => {
    const extract = await seal();
    const moved = (await verifyRoute().handler(ctx({ body: { extract, material: 'row1\nrow2\nCHANGED', rowCount: 3 } }))).body as VerifyResult;
    expect(moved.matches).toBe(false);
    const short = (await verifyRoute().handler(ctx({ body: { extract, material: 'row1\nrow2', rowCount: 2 } }))).body as VerifyResult;
    expect(short.rowCountMatches).toBe(false);
  });

  it('refuses to verify a seal taken for another tenant (isolation)', async () => {
    const extract = { ...(await seal()), tenantId: 'someone-else' };
    const e = await thrown(() => verifyRoute().handler(ctx({ body: { extract, material: 'row1\nrow2\nrow3', rowCount: 3 } })));
    expect(e.status).toBe(403);
    expect(e.body.code).toBe('seal_belongs_to_another_tenant');
  });

  it('refuses a production target and a malformed body', async () => {
    const extract = await seal();
    expect((await thrown(() => verifyRoute('production').handler(ctx({ body: { extract, material: 'x', rowCount: 3 } })))).body.code).toBe('target_is_production');
    expect((await thrown(() => verifyRoute().handler(ctx({ body: { material: 'x', rowCount: 3 } })))).status).toBe(400);
  });
});
