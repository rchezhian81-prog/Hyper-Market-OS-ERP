import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Stage C3b — the migration screen's feed through the real authenticated API: the store box's sync identity
// (and the owner and the manager) read one assembly of the register the cloud keeps — exceptions with the
// desk's resolutions folded in, totals with signatures, the owner's parallel-run terms, the reconciled days,
// the latest PERFORMED rollback, who ran the load, where verification stands, every refused decision. What has
// not been recorded is absent, not empty. A chartered accountant, who may not read the cleaning register, may
// not read the feed either; and nothing is read against production.

const T = 'ab000000-0000-4000-8000-000000000045';
const OWNER = 'u-owner'; const MGR = 'u-mgr'; const CA = 'u-ca'; const SYNC = 'u-sync'; const LOADER = 'u-loader'; const RECON = 'u-recon';

async function seeded(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(T, OWNER);
  await h.provisionRole(T, MGR, 'store_manager');
  await h.provisionRole(T, CA, 'chartered_accountant');
  await h.provisionRole(T, SYNC, 'store_computer');          // the store box's sync identity
  await h.provisionRole(T, LOADER, 'store_manager');
  await h.provisionRole(T, RECON, 'store_manager');
  return h;
}
const post = (h: ApiHarness, path: string, userId: string, key: string, body: unknown) =>
  h.request({ method: 'POST', path, userId, tenantId: T, idempotencyKey: key, body });
const put = (h: ApiHarness, path: string, userId: string, key: string, body: unknown) =>
  h.request({ method: 'PUT', path, userId, tenantId: T, idempotencyKey: key, body });
const get = (h: ApiHarness, path: string, userId = SYNC) => h.request({ method: 'GET', path, userId, tenantId: T });

interface Feed {
  tenantId: string; generatedAt: string;
  policy?: { cutoverId: string; requiredCleanDays: number; dailyReconcilerUserId: string };
  loadOperator?: string; rollbackDemonstratedAt?: string;
  exceptions?: { exceptionId: string; resolution?: { decidedBy: string } }[];
  totals?: { totalId: string; signature?: { signedBy: string } }[];
  refusedDecisions: { attemptedBy: string }[];
  parallelDays?: { businessDate: string; clean: boolean; recordedBy: string }[];
  parallelDifferences?: unknown[];
  rollbacks: { performed: boolean }[];
  verification: { covered: string[]; missing: string[]; extractionOperatorKnown: boolean; detail: string };
}
const EX = [
  { exceptionId: 'EX-1', kind: 'duplicate_product', severity: 'low', confidence: 'probable', legacyIds: ['L-1', 'L-2'], evidence: 'same name and pack' },
  { exceptionId: 'EX-2', kind: 'negative_stock', severity: 'blocking', confidence: 'certain', legacyIds: ['L-9'], evidence: 'qty -4 on the shelf', valueMinor: 12000 },
];
const TOTAL = { totalId: 'CT-STOCK', kind: 'stock', name: 'Stock units', unit: 'quantity', legacyValue: 1000, loadedValue: 1000, legacyDerivation: 'SUM(qty) FROM legacy stock', loadedDerivation: 'count of opening movements' };
const POLICY = { cutoverId: 'cut-1', dailyReconcilerUserId: RECON, requiredCleanDays: 3, maxParallelDays: 14, startedOn: '2026-10-01' };
const clean = { comparisons: [{ area: 'sales_value', legacyValue: 4_120_000, newValue: 4_120_000, toleranceMinor: 500 }] };

describe('GET /v1/migration/screen through the API (C3b)', () => {
  it('before anything is recorded the box reads an honest nothing: no terms, no exceptions, no totals, no days; the registers that exist are empty', async () => {
    const h = await seeded();
    const res = await get(h, '/v1/migration/screen');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const feed = res.body as Feed;
    expect(feed.tenantId).toBe(T);
    for (const k of ['policy', 'loadOperator', 'rollbackDemonstratedAt', 'exceptions', 'totals', 'parallelDays', 'parallelDifferences', 'exclusions']) {
      expect(feed, k).not.toHaveProperty(k);
    }
    expect(feed.refusedDecisions).toEqual([]);
    expect(feed.rollbacks).toEqual([]);
    expect(feed.verification.covered).toEqual([]);
    expect(feed.verification.extractionOperatorKnown).toBe(false);
  });

  it('once the night\'s work is recorded, the box reads all of it with the desk\'s decisions folded in — the same register the desk sees', async () => {
    const h = await seeded();
    expect((await post(h, '/v1/migration/extraction-runs/run-1', OWNER, 'er1', { operatorId: LOADER })).status).toBe(201);
    expect((await post(h, '/v1/migration/exceptions', MGR, 'x1', { exceptions: EX })).status).toBe(201);
    expect((await post(h, '/v1/migration/exceptions/EX-1/resolution', MGR, 'r1', { action: 'merge', reason: 'same item, keep the newer', survivingLegacyId: 'L-2' })).status).toBe(200);
    expect((await post(h, '/v1/migration/control-totals', MGR, 't1', { totals: [TOTAL] })).status).toBe(201);
    expect((await post(h, '/v1/migration/control-totals/CT-STOCK/signature', OWNER, 's1', { signerRole: 'owner', statement: 'counted a 40-line sample myself' })).status).toBe(200);
    expect((await put(h, '/v1/migration/parallel-run/policy', OWNER, 'p1', POLICY)).status).toBe(201);
    expect((await post(h, '/v1/migration/parallel-run/days/2026-10-01', RECON, 'd1', clean)).status).toBe(201);
    expect((await post(h, '/v1/migration/cutover/rollback', OWNER, 'rb1', { cutoverId: 'cut-1', trigger: 'owner_decision', legacySystemAvailable: true })).status).toBe(201);
    // A decision relayed by the box under someone who may not decide — refused, kept, and now visible in the feed.
    await h.provisionRole(T, 'u-cash', 'cashier');
    expect((await post(h, '/v1/migration/exceptions/EX-2/resolution/synced', SYNC, 'sy1', { action: 'correct', decidedBy: 'u-cash', reason: 'fixed it' })).status).toBe(202);

    const feed = (await get(h, '/v1/migration/screen')).body as Feed;
    expect(feed.policy).toEqual({ cutoverId: 'cut-1', requiredCleanDays: 3, maxParallelDays: 14, startedOn: '2026-10-01', dailyReconcilerUserId: RECON });
    expect(feed.loadOperator).toBe(LOADER);
    expect(feed.rollbackDemonstratedAt).toBeDefined();
    expect(feed.exceptions?.map((e) => [e.exceptionId, e.resolution?.decidedBy])).toEqual([['EX-1', MGR], ['EX-2', undefined]]);
    expect(feed.totals?.[0]).toMatchObject({ totalId: 'CT-STOCK', signature: { signedBy: OWNER } });
    expect(feed.parallelDays?.map((d) => [d.businessDate, d.clean, d.recordedBy])).toEqual([['2026-10-01', true, RECON]]);
    expect(feed.parallelDifferences).toEqual([]);
    expect(feed.rollbacks).toEqual([expect.objectContaining({ performed: true })]);
    expect(feed.refusedDecisions).toEqual([expect.objectContaining({ attemptedBy: 'u-cash' })]);
    expect(feed.verification.extractionOperatorKnown).toBe(true);
    // The same read is the desk's read — the same content, stamped with the cloud's clock at each read.
    const content = (f: Feed): Record<string, unknown> => Object.fromEntries(Object.entries(f).filter(([k]) => k !== 'generatedAt'));
    expect(content((await get(h, '/v1/migration/screen', OWNER)).body as Feed)).toEqual(content(feed));
    expect((await get(h, '/v1/migration/screen', MGR)).status).toBe(200);
  });

  it('who may read: the box\'s sync identity, the owner and the manager — not the chartered accountant, not a stranger', async () => {
    const h = await seeded();
    expect((await get(h, '/v1/migration/screen', CA)).status).toBe(403);
    expect((await get(h, '/v1/migration/screen', 'u-nobody')).status).toBe(403);
    expect((await h.raw({ method: 'GET', path: '/v1/migration/screen' })).status).toBe(401);
  });

  it('never reads against production (hard rule #7)', async () => {
    const h = apiHarness({ migrationTargetKind: 'production' });
    await h.seedOwner(T, OWNER);
    const res = await get(h, '/v1/migration/screen', OWNER);
    expect(res.status).toBe(403);
    expect((res.body as { error?: { code?: string } }).error?.code).toBe('target_is_production');
  });
});
