import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// MG-10 — the parallel run the server keeps, through the real authenticated API (Stage B3): the owner
// writes the policy, the named reconciler records the days, differences get names and real explanations,
// the sheet prints, a rollback is recorded, and the cutover decision reads both from the ledger.

const T = 'ab000000-0000-4000-8000-000000000042';
const OWNER = 'u-owner';
const RECON = 'u-recon';
const OTHER_MANAGER = 'u-manager2';
const CA = 'u-ca';
const CASHIER = 'u-cashier';

async function seeded(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(T, OWNER);
  await h.provisionRole(T, RECON, 'store_manager');
  await h.provisionRole(T, OTHER_MANAGER, 'store_manager');
  await h.provisionRole(T, CA, 'chartered_accountant');
  await h.provisionRole(T, CASHIER, 'cashier');
  return h;
}
const post = (h: ApiHarness, path: string, userId: string, key: string, body: unknown) =>
  h.request({ method: 'POST', path, userId, tenantId: T, idempotencyKey: key, body });
const put = (h: ApiHarness, path: string, userId: string, key: string, body: unknown) =>
  h.request({ method: 'PUT', path, userId, tenantId: T, idempotencyKey: key, body });
const get = (h: ApiHarness, path: string, userId = OWNER) => h.request({ method: 'GET', path, userId, tenantId: T });

const POLICY = { cutoverId: 'cut-1', dailyReconcilerUserId: RECON, requiredCleanDays: 3, maxParallelDays: 14, startedOn: '2026-10-01' };
const clean = { comparisons: [{ area: 'sales_value', legacyValue: 4_120_000, newValue: 4_120_000, toleranceMinor: 500 }, { area: 'tax', legacyValue: 206_000, newValue: 206_040, toleranceMinor: 100 }] };

describe('MG-10 parallel run through the API', () => {
  it('policy → three clean days by the named reconciler → sufficient; the sheet prints; the CA can read, a cashier cannot', async () => {
    const h = await seeded();
    expect((await put(h, '/v1/migration/parallel-run/policy', OWNER, 'p1', POLICY)).status).toBe(201);
    for (const [i, d] of ['2026-10-01', '2026-10-02', '2026-10-03'].entries()) {
      const res = await post(h, `/v1/migration/parallel-run/days/${d}`, RECON, `d${i}`, clean);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }
    const view = (await get(h, '/v1/migration/parallel-run', CA)).body as { started: boolean; position: { consecutiveCleanDays: number; sufficient: boolean }; days: unknown[] };
    expect(view.started).toBe(true);
    expect(view.position).toMatchObject({ consecutiveCleanDays: 3, sufficient: true });
    expect(view.days).toHaveLength(3);
    expect((await get(h, '/v1/migration/parallel-run/sheet', OWNER)).status).toBe(200);
    expect((await get(h, '/v1/migration/parallel-run', CASHIER)).status).toBe(403);
    // A manager who is NOT the named reconciler holds the permission but is refused by name.
    expect((await post(h, '/v1/migration/parallel-run/days/2026-10-04', OTHER_MANAGER, 'd4', clean)).status).toBe(403);
    // The reconciler cannot write the policy — that is the owner's.
    expect((await put(h, '/v1/migration/parallel-run/policy', RECON, 'p2', POLICY)).status).toBe(403);
  });

  it('a differing day raises a difference; a lazy explanation is refused; a real one resolves it; the ledger keeps every state', async () => {
    const h = await seeded();
    await put(h, '/v1/migration/parallel-run/policy', OWNER, 'p1', POLICY);
    const bad = await post(h, '/v1/migration/parallel-run/days/2026-10-02', RECON, 'd2', { comparisons: [{ area: 'sales_value', legacyValue: 4_120_000, newValue: 4_115_500, toleranceMinor: 500 }] });
    expect(bad.status).toBe(201);
    const id = (bad.body as { day: { differences: { differenceId: string }[] } }).day.differences[0]!.differenceId;
    expect(id).toBe('PD-2026-10-02-001');
    const lazy = await post(h, `/v1/migration/parallel-run/differences/${id}/own`, RECON, 'o1', { explanation: 'assume the new system is right' });
    expect(lazy.status).toBe(422);
    const real = await post(h, `/v1/migration/parallel-run/differences/${id}/own`, RECON, 'o2', { explanation: 'a cash refund was keyed twice at the old till by the evening cashier', wrongSide: 'legacy' });
    expect(real.status).toBe(200);
    expect(real.body).toMatchObject({ difference: { status: 'resolved', ownerUserId: RECON, wrongSide: 'legacy' } });
    const view = (await get(h, '/v1/migration/parallel-run')).body as { position: { openDifferences: unknown[]; consecutiveCleanDays: number } };
    expect(view.position.openDifferences).toEqual([]);
    expect(view.position.consecutiveCleanDays).toBe(0); // the day itself was not clean; resolving does not rewrite that
    expect(await h.store.readStream(T, 'migration', { type: 'ParallelDifferenceRecorded' })).toHaveLength(2); // open, resolved
    expect(await h.store.readStream(T, 'migration', { type: 'ParallelDayCompared' })).toHaveLength(1);
  });

  it('a recorded rollback and the recorded run feed the cutover decision from the ledger; a replayed day is one day', async () => {
    const h = await seeded();
    await put(h, '/v1/migration/parallel-run/policy', OWNER, 'p1', POLICY);
    for (const [i, d] of ['2026-10-01', '2026-10-02', '2026-10-03'].entries()) await post(h, `/v1/migration/parallel-run/days/${d}`, RECON, `d${i}`, clean);
    // The same day sent again under the same key is the same fact.
    await post(h, '/v1/migration/parallel-run/days/2026-10-03', RECON, 'd2', clean);
    expect(((await get(h, '/v1/migration/parallel-run')).body as { days: unknown[] }).days).toHaveLength(3);
    const rb = await post(h, '/v1/migration/cutover/rollback', OWNER, 'rb1', { cutoverId: 'cut-1', trigger: 'owner_decision', legacySystemAvailable: true });
    expect(rb.status).toBe(201);
    expect((await post(h, '/v1/migration/cutover/rollback', RECON, 'rb2', { cutoverId: 'cut-1', trigger: 'owner_decision', legacySystemAvailable: true })).status).toBe(403);
    const decision = await post(h, '/v1/migration/cutover/decision', OWNER, 'cut', { cutoverId: 'cut-1', evidence: {
      reconciliation: { tenantId: T, assessments: [], open: [], unsigned: [], qg07Passed: true, detail: 'signed' },
      exceptions: { tenantId: T, clearForCutover: true, blockingUnresolved: [], detail: 'clear' },
      edgeUnsyncedItems: 0, deltaAppliedAt: '2026-10-03T22:00:00Z', namedTeam: [{ userId: OWNER, role: 'owner' }], ownerGoBy: OWNER,
    } });
    expect(decision.status).toBe(200);
    expect((decision.body as { decision: { go: boolean; failed: string[] } }).decision).toMatchObject({ go: true, failed: [] });
  });

  it('a second tenant sees none of it (tenant isolation)', async () => {
    const h = await seeded();
    const OTHER = 'cd000000-0000-4000-8000-000000000077';
    await h.seedOwner(OTHER, 'u-other');
    await put(h, '/v1/migration/parallel-run/policy', OWNER, 'p1', POLICY);
    const view = await h.request({ method: 'GET', path: '/v1/migration/parallel-run', userId: 'u-other', tenantId: OTHER });
    expect(view.body).toMatchObject({ started: false });
  });
});
