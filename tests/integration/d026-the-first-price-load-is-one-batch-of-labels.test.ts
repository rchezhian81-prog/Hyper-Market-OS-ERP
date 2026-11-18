import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';
import { useBackings } from '../support/backings';
import { aBranch } from '../support/a-branch';
import { storeRules } from '../support/store-rules';
import { mrpOnRecord } from '../support/mrp-on-record';

// D-026 (owner, 18 Nov 2026, under OB-801), through the real API — in memory and, with DATABASE_URL, on real PostgreSQL.
// The first price load enters each item's first price on the price list: those label tasks are ONE "first price load"
// batch with its count, never "due now". A manager's Change price afterwards is a real change, due as before. Nothing is
// deleted: every task stays on the list.

type Res = { status: number; body: unknown };
interface Row { taskId: string; productId: string; priceMinor: number; firstLabel: boolean; dueNow: boolean; because: string }

describe.each(useBackings())('D-026 — the first price load is one batch of labels — on $name', ({ harness }) => {
  it('first price-list entries are one counted batch; a later Change price is not part of it', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await aBranch(h, T, 'u-owner');
    await storeRules(h, T, 'u-owner', 'store-1', 0);
    for (const p of ['p-soap', 'p-salt', 'p-dal']) await mrpOnRecord(h, T, 'u-owner', p, 5_000);
    const req = (method: 'GET' | 'POST', path: string, body?: unknown): Promise<Res> =>
      h.request({ method, path, userId: 'u-owner', tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
    const today = shopDateIn(new Date().toISOString());
    for (const [p, price] of [['p-soap', 3_000], ['p-salt', 2_000], ['p-dal', 4_000]] as const) {
      const r = await req('POST', `/v1/prices/list/${p}/entries/e-${p}`, { scope: 'store', scopeRef: 'store-1', priceMinor: price, mrpMinor: 5_000, costMinor: 1_000, marginFloorBps: 0, currency: 'INR', effectiveFrom: today });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
    const first = (await req('GET', '/v1/pricing/relabel-tasks')).body as { tasks: Row[]; open: number; firstLoad: { open: number }; dueNow: number };
    expect(first.firstLoad).toEqual({ open: 3 });
    expect(first.dueNow).toBe(0);
    expect(first.tasks.every((r) => r.firstLabel && !r.dueNow)).toBe(true);

    await new Promise((r) => setTimeout(r, 20)); // a later moment for the later price
    const change = await req('POST', '/v1/prices/changes', { productId: 'p-soap', priceMinor: 3_200, mrpMinor: 5_000, costMinor: 1_000, currency: 'INR', marginFloorBps: 0 });
    expect(change.status, JSON.stringify(change.body)).toBe(201);
    const after = (await req('GET', '/v1/pricing/relabel-tasks')).body as { tasks: Row[]; open: number; firstLoad: { open: number } };
    expect(after.tasks).toHaveLength(4); // nothing deleted
    expect(after.tasks.find((r) => r.priceMinor === 3_200)).toMatchObject({ firstLabel: false, because: 'price_change' });
    expect(after.firstLoad).toEqual({ open: 2 }); // soap's first label is replaced by its newer price
  });
});
