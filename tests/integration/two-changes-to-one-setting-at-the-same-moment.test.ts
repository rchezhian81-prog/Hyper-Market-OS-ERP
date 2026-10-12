import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { STREAM, streamName, facilitiesAssetsAdapter } from '../../services/api/src/adapters';

/**
 * **Hard rule #10 · verifier r19 SET-1 — two DIFFERENT values for one setting at the same moment: the loser is TOLD.**
 * Both used to answer 201 "saved" and one was silently lost (memory 10/10, PostgreSQL 10/10 in the verifier's probe). Now each
 * setting family writes under one write guard: exactly one value lands, the other gets a visible 409
 * `setting_changed_at_the_same_moment` — as the till-prefix screen does — and the value in force is the one that answered 201.
 * Two people setting the SAME value at once are one fact (both "saved", one event); two different SUBJECTS of one family
 * (two loss-prevention rule kinds, two facilities assets) at once both land. A 409 is not banked as a reply, so the loser's
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

describe('hard rule #10: two changes to one setting at the same moment (memory)', () => {
  it('the loser gets a visible 409; the value in force is the one told "saved"', async () => { await race(apiHarness()); }, 60_000);
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(DATABASE_URL === undefined)('hard rule #10: two changes to one setting at the same moment (PostgreSQL)', () => {
  it('the loser gets a visible 409; the value in force is the one told "saved"', async () => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 8, options: '-c app.tenant_id=*' });
    const sql = pgPoolClient(pool);
    try { await race(apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) })); } finally { await pool.end(); }
  }, 180_000);
});
