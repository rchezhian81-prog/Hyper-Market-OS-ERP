import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, ConcurrencyConflictError, type EventStore } from '../../packages/persistence/src/event-store';
import { STREAM, streamName, facilitiesAssetsAdapter } from '../../services/api/src/adapters';

/**
 * **Hard rule #10 · verifier r19 SET-1 — two DIFFERENT values for one setting at the same moment: the loser is TOLD.**
 * Both used to answer 201 "saved" and one was silently lost (memory 10/10, PostgreSQL 10/10 in the verifier's probe). Now each
 * setting family writes under one write guard: exactly one value lands, the other gets a visible 409
 * `setting_changed_at_the_same_moment` — as the till-prefix screen does — and the value in force is the one that answered 201.
 * Two people setting the SAME value at once are one fact (both "saved", one event); two different SUBJECTS of one family
 * (two loss-prevention rule kinds, two facilities assets) at once both land — and since r20 (SET-2) each subject has its own
 * guard, so forty at once all land too. A 409 is not banked as a reply, so the loser's
 * retry under its own key is judged afresh. Through the real routes and adapters, in memory and on PostgreSQL.
 */

type Res = { status: number; body: unknown };

async function race(h: ApiHarness): Promise<void> {
  const T = randomUUID();
  await h.seedOwner(T, 'u-owner');
  const call = (method: 'GET' | 'POST', path: string, body?: unknown, key?: string): Promise<Res> =>
    h.request({ method, path, userId: 'u-owner', tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: key ?? `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
  const stream = streamName(STREAM.inventory, 'count-policy');
  let conflicts = 0;
  for (let i = 0; i < 10; i += 1) {
    const a = 10_000 + i * 2; const b = a + 1;
    const before = (await h.store.readStream(T, stream, { type: 'CountPolicySet' })).length;
    const [ra, rb] = await Promise.all([
      call('POST', '/v1/inventory/count-policy', { approvalThresholdMinor: a }),
      call('POST', '/v1/inventory/count-policy', { approvalThresholdMinor: b }),
    ]);
    const inForce = ((await call('GET', '/v1/inventory/count-policy')).body as { inForceMinor: number }).inForceMinor;
    const after = await h.store.readStream(T, stream, { type: 'CountPolicySet' });
    if (ra.status === 201 && rb.status === 201) {
      // Only when one truly followed the other: two facts, the later naming the earlier as the one it replaced.
      expect(after.length - before).toBe(2);
      const [first, second] = after.slice(-2);
      expect(second!.event.idempotencyKey).toContain(`-after-${first!.event.id}`);
      expect(inForce).toBe((second!.event.payload as { approvalThresholdMinor: number }).approvalThresholdMinor);
    } else {
      conflicts += 1;
      const [won, lost, wonValue] = ra.status === 201 ? [ra, rb, a] : [rb, ra, b];
      expect(won.status).toBe(201);
      expect(lost.status).toBe(409);
      expect(lost.body).toMatchObject({ error: { code: 'setting_changed_at_the_same_moment', wasItSaved: 'not_saved' } });
      expect(inForce).toBe(wonValue); // the value in force is the one that was told "saved"
      expect(after.length - before).toBe(1); // the loser left nothing behind
    }
  }
  // The race is real: at least one round of ten met at the same moment (the probe's 10/10 silent losses).
  expect(conflicts).toBeGreaterThan(0);

  // The loser's retry under its OWN key is judged afresh (a 409 is never banked as its reply) and now lands.
  const key = `k-${randomUUID()}`;
  const [x, y] = await Promise.all([
    call('POST', '/v1/inventory/count-policy', { approvalThresholdMinor: 61_000 }, key),
    call('POST', '/v1/inventory/count-policy', { approvalThresholdMinor: 62_000 }),
  ]);
  if (x.status === 409) {
    expect((await call('POST', '/v1/inventory/count-policy', { approvalThresholdMinor: 61_000 }, key)).status).toBe(201);
    expect((await call('GET', '/v1/inventory/count-policy')).body).toMatchObject({ inForceMinor: 61_000 });
  } else {
    expect([x.status, y.status]).toContain(201);
  }

  // The SAME value at the same moment: both saved, one fact.
  const n0 = (await h.store.readStream(T, stream, { type: 'CountPolicySet' })).length;
  const same = await Promise.all([1, 2, 3].map(() => call('POST', '/v1/inventory/count-policy', { approvalThresholdMinor: 88_000 })));
  expect(same.map((r) => r.status)).toEqual([201, 201, 201]);
  expect((await h.store.readStream(T, stream, { type: 'CountPolicySet' })).length - n0).toBe(1);

  // Two SUBJECTS of one family at once (loss-prevention: the void rule and the refund rule) both land.
  const [v, r] = await Promise.all([
    call('POST', '/v1/loss-prevention/rules/void', { maxCount: 6 }),
    call('POST', '/v1/loss-prevention/rules/refund', { maxCount: 3 }),
  ]);
  expect([v.status, r.status]).toEqual([201, 201]);
  const rules = ((await call('GET', '/v1/loss-prevention/rules')).body as { rules: { kind: string; maxCount?: number }[] }).rules;
  expect(rules.find((x2) => x2.kind === 'void')?.maxCount).toBe(6);
  expect(rules.find((x2) => x2.kind === 'refund')?.maxCount).toBe(3);

  // Through an adapter of another family (facilities assets): two assets at once both land; one asset two ways → one 409.
  const facA = facilitiesAssetsAdapter({ store: h.store, now: () => new Date().toISOString() });
  const asset = (assetId: string, criticality: string) => ({ assetId, name: 'Chiller', criticality, active: true }) as never;
  await Promise.all([facA.recordAsset(T, asset('A-1', 'high')), facA.recordAsset(T, asset('A-2', 'low'))]);
  const both = (await facA.assets(T)) as unknown as { assetId: string; criticality: string }[];
  expect(both.map((a2) => a2.assetId).sort()).toEqual(['A-1', 'A-2']);
  const outcomes = await Promise.allSettled([facA.recordAsset(T, asset('A-1', 'low')), facA.recordAsset(T, asset('A-1', 'medium'))]);
  const refused = outcomes.filter((o) => o.status === 'rejected');
  if (refused.length > 0) {
    expect(refused).toHaveLength(1);
    const err = (refused[0] as PromiseRejectedResult).reason as { status?: number; body?: { code?: string } };
    expect(err.status).toBe(409);
    expect(err.body?.code).toBe('setting_changed_at_the_same_moment');
  }
}

/**
 * Verifier r20 SET-2: the guard is each SUBJECT's own. The probe zz-v20-set1: 40 production costs for 40 DIFFERENT products
 * at once — r19 saved 9–13 and refused the rest with a false "somebody else changed this same setting". Now every one lands
 * (201) with its own value in force, as do 20 facilities assets at once; two DIFFERENT values for the SAME product at once
 * are still exactly 201 + 409 (a visible conflict, never a silent loss).
 */
async function manyItemsAtOnce(h: ApiHarness): Promise<void> {
  const T = randomUUID();
  await h.seedOwner(T, 'u-owner');
  const call = (method: 'GET' | 'POST', path: string, body?: unknown): Promise<Res> =>
    h.request({ method, path, userId: 'u-owner', tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
  const costs = await Promise.all(Array.from({ length: 40 }, (_, i) => call('POST', `/v1/production/costs/P-${i}`, { unitCostMinor: 100 + i })));
  expect(costs.map((r) => r.status)).toEqual(Array.from({ length: 40 }, () => 201));
  const set = (await h.store.readStream(T, streamName(STREAM.inventory, 'production'), { type: 'ProductionCostSet' })).map((e) => e.event.payload as { productId: string; cost: { minor: number } });
  expect(set).toHaveLength(40);
  for (let i = 0; i < 40; i += 1) expect(set.find((x) => x.productId === `P-${i}`)?.cost.minor).toBe(100 + i);
  const assets = await Promise.all(Array.from({ length: 20 }, (_, i) => call('POST', `/v1/facilities/assets/A-${i}`, { branchId: 'store-1', name: `asset ${i}`, kind: 'refrigeration', criticality: 'critical', installedOn: '2025-01-01' })));
  expect(assets.map((r) => r.status)).toEqual(Array.from({ length: 20 }, () => 201));
  // The same product two ways at once: still one 201 and one visible 409, ten rounds out of ten.
  let met = 0;
  for (let round = 0; round < 10; round += 1) {
    const [a, b] = await Promise.all([
      call('POST', '/v1/production/costs/P-SAME', { unitCostMinor: 5_000 + round * 2 }),
      call('POST', '/v1/production/costs/P-SAME', { unitCostMinor: 5_001 + round * 2 }),
    ]);
    const statuses = [a.status, b.status].sort();
    if (statuses[0] === 201 && statuses[1] === 201) continue; // one genuinely after the other (both kept, the later in force)
    met += 1;
    expect(statuses).toEqual([201, 409]);
    expect((a.status === 409 ? a : b).body).toMatchObject({ error: { code: 'setting_changed_at_the_same_moment', wasItSaved: 'not_saved' } });
  }
  expect(met).toBeGreaterThan(0); // the race on one item is real, and still told

  // A guard that keeps moving while THIS item stays unchanged (a store under a storm of writes): after its retries the save
  // is refused as "busy, try again" — never the false "somebody else changed this setting" — and nothing is written.
  let refusedTries = 0;
  const stormy = new Proxy(h.store, {
    get: (target, prop, receiver) => {
      if (prop === 'appendBatch') {
        return (tenantId: string, entries: unknown, options?: { guard?: { key: string; expectedVersion: number } }) => {
          if (options?.guard !== undefined) { refusedTries += 1; return Promise.reject(new ConcurrencyConflictError(options.guard.key, options.guard.expectedVersion)); }
          return target.appendBatch(tenantId, entries as never, options as never);
        };
      }
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as EventStore;
  const busy = await Promise.resolve(facilitiesAssetsAdapter({ store: stormy, now: () => new Date().toISOString() })
    .recordAsset(T, { assetId: 'A-STORM', name: 'Chiller', criticality: 'high', active: true } as never)).then(() => undefined, (e: unknown) => e);
  expect(busy).toMatchObject({ status: 409, body: { code: 'setting_busy_try_again', wasItSaved: 'not_saved' } });
  expect(JSON.stringify(busy)).toMatch(/Nobody else changed this setting/);
  expect(JSON.stringify(busy)).not.toMatch(/Somebody else changed/);
  expect(refusedTries).toBe(9);
}

describe('hard rule #10: two changes to one setting at the same moment (memory)', () => {
  it('r20 SET-2: forty different items at once all land; one item two ways is still 201/409', async () => { await manyItemsAtOnce(apiHarness()); }, 60_000);
  it('the loser gets a visible 409; the value in force is the one told "saved"', async () => { await race(apiHarness()); }, 60_000);
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(DATABASE_URL === undefined)('hard rule #10: two changes to one setting at the same moment (PostgreSQL)', () => {
  it('the loser gets a visible 409; the value in force is the one told "saved"', async () => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 8, options: '-c app.tenant_id=*' });
    const sql = pgPoolClient(pool);
    try { await race(apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) })); } finally { await pool.end(); }
  }, 180_000);
  it('r20 SET-2: forty different items at once all land; one item two ways is still 201/409', async () => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 20, options: '-c app.tenant_id=*' });
    const sql = pgPoolClient(pool);
    try { await manyItemsAtOnce(apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) })); } finally { await pool.end(); }
  }, 180_000);
});
