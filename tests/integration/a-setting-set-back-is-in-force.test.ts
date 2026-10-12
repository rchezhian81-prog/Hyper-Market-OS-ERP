import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { makeEvent } from '../../packages/contracts/src/event';
import {
  STREAM, streamName, b2bCreditAdapter, facilitiesAdapter, facilitiesAssetsAdapter, facilitiesMonitoringAdapter, wasteAdapter, integrationAdapter, webhookAdapter, productionAdapter,
  purchaseAdapter, supplierPortalAdapter, openToBuyAdapter,
} from '../../services/api/src/adapters';

/**
 * **Hard rule #10 · verifier r18 RULE10-ABA — a setting set BACK to an earlier value is in force.** Settings were keyed on
 * their value alone, so A → B → A collapsed the second A onto the first: 201 "saved", and B stayed in force. Now each is keyed
 * on its value AND the setting it supersedes. Proved through the real routes (count-approval threshold, loss-prevention rule,
 * fraud thresholds, segmentation policy) and the real adapters (every other value-keyed setting the audit found), in memory
 * and on PostgreSQL; plus: re-sending the value in force writes nothing (a true replay or a retry dedupes), a replayed
 * request answers its first reply, and an event written under the OLD key scheme is still deduped onto.
 */

type Res = { status: number; body: unknown };
const NOW = (): string => new Date().toISOString();

async function throughTheRoutes(h: ApiHarness): Promise<void> {
  const T = randomUUID();
  await h.seedOwner(T, 'u-owner');
  const call = (method: 'GET' | 'POST', path: string, body?: unknown, key?: string): Promise<Res> =>
    h.request({ method, path, userId: 'u-owner', tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: key ?? `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });

  // Count-approval threshold ₹1,000 → ₹500 → ₹1,000: ₹1,000 in force.
  for (const v of [100_000, 50_000, 100_000]) expect((await call('POST', '/v1/inventory/count-policy', { approvalThresholdMinor: v })).status).toBe(201);
  expect((await call('GET', '/v1/inventory/count-policy')).body).toMatchObject({ inForceMinor: 100_000 });
  // Re-sending the value in force (a new request) writes nothing; three settings → three facts, never four.
  expect((await call('POST', '/v1/inventory/count-policy', { approvalThresholdMinor: 100_000 })).status).toBe(201);
  expect(await h.store.readStream(T, streamName(STREAM.inventory, 'count-policy'), { type: 'CountPolicySet' })).toHaveLength(3);
  // A replay of the SAME request answers its first reply and changes nothing.
  const key = `k-${randomUUID()}`;
  expect((await call('POST', '/v1/inventory/count-policy', { approvalThresholdMinor: 70_000 }, key)).status).toBe(201);
  expect((await call('POST', '/v1/inventory/count-policy', { approvalThresholdMinor: 70_000 }, key)).status).toBe(201);
  expect(await h.store.readStream(T, streamName(STREAM.inventory, 'count-policy'), { type: 'CountPolicySet' })).toHaveLength(4);
  expect((await call('GET', '/v1/inventory/count-policy')).body).toMatchObject({ inForceMinor: 70_000 });

  // Loss-prevention void rule maxCount 5 → 9 → 5: 5 in force (another kind's rule is untouched).
  expect((await call('POST', '/v1/loss-prevention/rules/refund', { maxCount: 4 })).status).toBe(201);
  for (const v of [5, 9, 5]) expect((await call('POST', '/v1/loss-prevention/rules/void', { maxCount: v })).status).toBe(201);
  const rules = ((await call('GET', '/v1/loss-prevention/rules')).body as { rules: { kind: string; maxCount?: number }[] }).rules;
  expect(rules.find((r) => r.kind === 'void')?.maxCount).toBe(5);
  expect(rules.find((r) => r.kind === 'refund')?.maxCount).toBe(4);

  // Fraud thresholds couponUsesPerAccount 3 → 7 → 3: 3 in force.
  for (const v of [3, 7, 3]) expect((await call('POST', '/v1/fraud-signals/thresholds', { couponUsesPerAccount: v })).status).toBeLessThan(300);
  expect(((await call('GET', '/v1/fraud-signals/thresholds')).body as { thresholds: { couponUsesPerAccount?: number } }).thresholds.couponUsesPerAccount).toBe(3);

  // Segmentation policy A → B → A (its fixed event id used to refuse the SECOND change outright).
  for (const v of [2, 5, 2]) expect((await call('POST', '/v1/customer/segments/policy', { newBelowOrders: v })).status).toBe(201);
  expect(((await call('GET', '/v1/customer/segments/policy')).body as { policy: { newBelowOrders?: number } }).policy.newBelowOrders).toBe(2);
}

async function throughTheAdapters(h: ApiHarness): Promise<void> {
  const T = randomUUID();
  await h.seedOwner(T, 'u-owner'); // registers the tenant (PostgreSQL refuses rows for an unprovisioned one)
  const input = { store: h.store, now: NOW };
  const aba = async <V>(values: readonly [V, V, V], set: (v: V) => Promise<void>, inForce: () => Promise<unknown>, expected: (v: V) => unknown): Promise<void> => {
    for (const v of values) await set(v);
    expect(await inForce()).toEqual(expected(values[2]));
  };

  const b2b = b2bCreditAdapter(input);
  await aba([500_000, 200_000, 500_000], (v) => b2b.recordAccount(T, 'C-1', v, 'INR', NOW()) as Promise<void>, async () => (await b2b.account(T, 'C-1'))?.creditLimitMinor, (v) => v);

  const fac = facilitiesAdapter(input);
  const sched = (active: boolean) => ({ scheduleId: 'SCH-1', title: 'Chiller service', category: 'hvac', frequency: 'monthly', evidenceRequired: false, verificationRequired: false, active }) as never;
  await aba([true, false, true], (v) => fac.recordSchedule(T, sched(v)) as Promise<void>, async () => ((await fac.schedules(T)) as unknown as { scheduleId: string; active: boolean }[]).find((s) => s.scheduleId === 'SCH-1')?.active, (v) => v);
  const facA = facilitiesAssetsAdapter(input);
  const facM = facilitiesMonitoringAdapter(input);
  const asset = (criticality: string) => ({ assetId: 'A-1', name: 'Chiller', criticality, active: true }) as never;
  await aba(['high', 'low', 'high'], (v) => facA.recordAsset(T, asset(v)) as Promise<void>, async () => ((await facA.assets(T)) as unknown as { assetId: string; criticality: string }[]).find((a) => a.assetId === 'A-1')?.criticality, (v) => v);
  const range = (maxTenthsC: number) => ({ assetId: 'A-1', range: { minTenthsC: 0, maxTenthsC, graceMinutes: 15 }, onBackup: false }) as never;
  await aba([50, 80, 50], (v) => facM.recordRange(T, range(v)) as Promise<void>, async () => ((await facM.ranges(T)) as unknown as { assetId: string; range: { maxTenthsC: number } }[]).find((r) => r.assetId === 'A-1')?.range.maxTenthsC, (v) => v);

  const waste = wasteAdapter(input);
  const cov = (d: string) => ({ expected: [{ branchId: 'S1', departmentId: d }], departmentNames: {} }) as never;
  await aba(['dairy', 'bakery', 'dairy'], (v) => waste.recordCoverage(T, cov(v)) as Promise<void>, async () => ((await waste.coverage(T)) as unknown as { expected: { departmentId: string }[] }).expected[0]?.departmentId, (v) => v);

  const intg = integrationAdapter(input);
  const entry = (model: string) => ({ entryId: 'E-1', vendor: 'Acme', model, versions: ['1'], category: 'printer' }) as never;
  await aba(['X1', 'X2', 'X1'], (v) => intg.recordMatrixEntry(T, entry(v)) as Promise<void>, async () => ((await intg.matrix(T)) as unknown as { entryId: string; model: string }[]).find((e) => e.entryId === 'E-1')?.model, (v) => v);

  const wh = webhookAdapter({ ...input, hasher: { hash: (s: string) => s } as never });
  await aba([300, 600, 300], (v) => wh.recordConfig(T, { provider: 'psp', signingKeyRef: 'ref-1', maxAgeSeconds: v } as never) as Promise<void>, async () => ((await wh.config(T, 'psp')) as { maxAgeSeconds?: number } | undefined)?.maxAgeSeconds, (v) => v);

  const prod = productionAdapter(input);
  await aba([1_000, 1_200, 1_000], (v) => prod.recordCost(T, 'P-1', { minor: v, currency: 'INR' } as never) as Promise<void>, async () => ((await prod.ingredientCost(T, 'P-1')) as { minor: number } | undefined)?.minor, (v) => v);

  const purchase = purchaseAdapter(input);
  const match = (blocked: boolean) => ({ invoiceId: 'INV-1', payableMinor: 10_000, invoicedMinor: 10_000, poId: 'PO-1', blocked, matchedAt: NOW() }) as never;
  await aba([false, true, false], (v) => purchase.recordMatch(T, 'INV-1', match(v)) as Promise<void>, async () => ((await purchase.latestMatch!(T, 'INV-1')) as { blocked: boolean } | undefined)?.blocked, (v) => v);

  const portal = supplierPortalAdapter(input);
  await aba([0, 5_000, 0], (v) => portal.recordOpening!(T, 'SUP-1', v) as Promise<void>, async () => portal.opening!(T, 'SUP-1'), (v) => v);
  const cfg = (grants: string[]) => ({ grants, requiredDocuments: [], documents: [], logins: [] }) as never;
  await aba([['po.read'], ['po.read', 'invoice.submit'], ['po.read']], (v) => portal.recordPartner(T, 'SUP-1', cfg(v), NOW()) as Promise<void>, async () => ((await portal.partner(T, 'SUP-1')) as { grants: string[] } | undefined)?.grants, (v) => v);

  const otb = openToBuyAdapter(input);
  const budget = (amountMinor: number) => ({ categoryId: 'GROC', period: '2026-10', amountMinor, reason: 'plan', setBy: 'u-owner', setAt: NOW() }) as never;
  await aba([900_000, 700_000, 900_000], (v) => otb.recordBudget(T, budget(v)) as Promise<void>, async () => ((await otb.budgets(T)) as unknown as { amountMinor: number }[]).at(-1)?.amountMinor, (v) => v);
}

/** An event written under the OLD (value-only) key, with the OLD clock id, is still the value in force — and deduped onto. */
async function oldKeysStillDedupe(h: ApiHarness): Promise<void> {
  const T = randomUUID();
  await h.seedOwner(T, 'u-owner');
  const stream = streamName(STREAM.inventory, 'count-policy');
  const setAt = '2026-10-01T00:00:00.000Z';
  await h.store.append(T, stream, makeEvent({ id: `count-policy-${T}-${setAt}`, type: 'CountPolicySet', occurredAt: setAt, idempotencyKey: `count-policy-${T}-70000`, source: 'api/inventory', payload: { approvalThresholdMinor: 70000, setBy: 'u-owner', setAt } }));
  const post = (v: number) => h.request({ method: 'POST', path: '/v1/inventory/count-policy', userId: 'u-owner', tenantId: T, idempotencyKey: `k-${randomUUID()}`, body: { approvalThresholdMinor: v } });
  expect((await post(70_000)).status).toBe(201);
  expect(await h.store.readStream(T, stream)).toHaveLength(1);
  // Then a change and a change back over the old event: both in force in turn.
  expect((await post(40_000)).status).toBe(201);
  expect((await post(70_000)).status).toBe(201);
  expect(await h.store.readStream(T, stream)).toHaveLength(3);
  expect((await h.request({ method: 'GET', path: '/v1/inventory/count-policy', userId: 'u-owner', tenantId: T })).body).toMatchObject({ inForceMinor: 70_000 });
}

describe('hard rule #10: a setting set back to an earlier value is in force (memory)', () => {
  it('through the routes', async () => { await throughTheRoutes(apiHarness()); }, 60_000);
  it('through the adapters (every value-keyed setting)', async () => { await throughTheAdapters(apiHarness()); }, 60_000);
  it('an event under the old key still dedupes', async () => { await oldKeysStillDedupe(apiHarness()); }, 60_000);
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(DATABASE_URL === undefined)('hard rule #10: a setting set back to an earlier value is in force (PostgreSQL)', () => {
  const withPg = async (run: (h: ApiHarness) => Promise<void>): Promise<void> => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 8, options: '-c app.tenant_id=*' });
    const sql = pgPoolClient(pool);
    try { await run(apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) })); } finally { await pool.end(); }
  };
  it('through the routes', async () => { await withPg(throughTheRoutes); }, 180_000);
  it('through the adapters (every value-keyed setting)', async () => { await withPg(throughTheAdapters); }, 180_000);
  it('an event under the old key still dedupes', async () => { await withPg(oldKeysStillDedupe); }, 120_000);
});
