import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { apiHarness } from '../support/api-harness';
import { P3, p3Shop } from '../support/p3-purchase';

/**
 * **Owner's answer of 1 Nov 2026 (OB-653): the Purchase User may change the reorder settings
 * (`POST /v1/replenishment/parameters/:storeId/:productId`) as well as the store manager and the owner.** The route asks for
 * `purchase.order.propose`, which the Purchase User holds (OB-622); a role without it — the Receiver/QC, the Warehouse
 * user, a cashier — is refused, and nothing is stored. On the real API.
 */

const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

describe('reorder settings: the Purchase User may set them; a role without the buying word may not', () => {
  it('stored for the Purchase User, the manager and the owner; refused, by name, for the receiver, the warehouse user and a cashier', async () => {
    const h = apiHarness();
    const T = randomUUID();
    await p3Shop(h, T);
    await h.provisionRole(T, 'u-pu', 'purchase_user', [P3.STORE]);
    await h.provisionRole(T, 'u-rq', 'receiver_qc', [P3.STORE]);
    await h.provisionRole(T, 'u-wh', 'warehouse_user', [P3.STORE]);
    const set = (who: string, product: string, maxLevel: number) => h.request({
      method: 'POST', path: `/v1/replenishment/parameters/${P3.STORE}/${product}`, userId: who, tenantId: T, branchId: P3.STORE,
      idempotencyKey: `k-${randomUUID()}`, body: { maxLevel, reorderPoint: 10, reason: 'season' },
    });
    for (const [who, product] of [['u-pu', 'rice'], [P3.BUYER, 'dal'], [P3.OWNER, 'oil']] as const) {
      const r = await set(who, product, 40);
      expect(r.status, `${who}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
    }
    for (const who of ['u-rq', 'u-wh', P3.CASHIER]) {
      const r = await set(who, 'sugar', 40);
      expect(r.status, who).toBe(403);
      expect(codeOf(r), who).toBe('forbidden');
    }
    const stored = (await h.request({ method: 'GET', path: '/v1/replenishment/parameters', userId: P3.OWNER, tenantId: T, query: { storeId: P3.STORE } })).body as { products: { current: { productId: string; setBy: string } }[] };
    expect(stored.products.map((p) => [p.current.productId, p.current.setBy]).sort()).toEqual([['dal', P3.BUYER], ['oil', P3.OWNER], ['rice', 'u-pu']]);
  });
});
