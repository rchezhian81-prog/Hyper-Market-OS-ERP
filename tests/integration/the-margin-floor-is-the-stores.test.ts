import { describe, it, expect } from 'vitest';
import { aBranch } from '../support/a-branch';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { storeRules } from '../support/store-rules';

/**
 * **M05 — the margin floor a head-office price is judged by is the STORE's, never a figure sent with the price (M05-FR-02 ·
 * §28 · audit finding on `services/pricing`).** The owner set the store's margin floor at 20%. A price change that sends its
 * own "marginFloorBps: 0" must still be judged at 20% — so ₹60 on an MRP of ₹100 and a cost of ₹50 (16.7% margin) is
 * below the floor and needs a second person. With two stores, the stricter floor applies; a store whose floor nobody has
 * set refuses the price by name (a limit nobody chose is a limit nobody owns).
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa505';
const price = (priceMinor: number, over: Record<string, unknown> = {}) => ({ productId: 'P1', priceMinor, mrpMinor: 10_000, costMinor: 5_000, currency: 'INR', ...over });
const propose = (h: ApiHarness, body: Record<string, unknown>, key: string) =>
  h.request({ method: 'POST', path: '/v1/prices/changes', userId: 'owner-1', tenantId: A, idempotencyKey: key, body });
const code = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

async function shop(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.provisionOwner(A, 'owner-1');
  await aBranch(h, A, 'owner-1');
  return h;
}

describe('M05: a head-office price is judged by the store\'s own margin floor', () => {
  it('a price change that sends its own floor of 0 is still judged at the store\'s 20%', async () => {
    const h = await shop();
    await storeRules(h, A, 'owner-1', 'store-1', 2_000);
    const r = await propose(h, price(6_000, { marginFloorBps: 0 }), 'k1');
    expect(r.status).toBe(422);
    expect(code(r)).toBe('price_below_floor');
    // At the floor it goes through, and the answer says which floor it was judged by.
    const ok = await propose(h, price(6_250), 'k2');
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ verdict: 'ok', marginFloor: { appliedBps: 2_000, source: 'store_rules', stores: ['store-1'] } });
  });

  it('with no floor set for the store, the price is refused by name — never judged against a floor nobody chose', async () => {
    const h = await shop();
    const r = await propose(h, price(8_000, { marginFloorBps: 0 }), 'k3');
    expect(r.status).toBe(422);
    expect(code(r)).toBe('margin_floor_not_set');
  });

  it('a price for every store is judged at the strictest store\'s floor', async () => {
    const h = await shop();
    await aBranch(h, A, 'owner-1', 'store-2');
    await storeRules(h, A, 'owner-1', 'store-1', 1_000);
    await storeRules(h, A, 'owner-1', 'store-2', 3_000);
    // ₹70: (7000 − 5000) / 7000 = 28.6% margin — above store-1's 10%, below store-2's 30%.
    expect(code(await propose(h, price(7_000), 'k4'))).toBe('price_below_floor');
    expect((await propose(h, price(7_000, { storeId: 'store-1' }), 'k5')).status).toBe(201);
  });
});
