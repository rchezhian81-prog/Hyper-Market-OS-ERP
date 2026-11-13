import { describe, it, expect } from 'vitest';
import { apiHarness } from '../support/api-harness';

/**
 * U7 (OB-726) · M10 / §27 Inventory "Quarantine": the hold form asked a TYPED batch id because head office had no list a
 * picker could read — `/v1/inventory/batches` needs a place and a product. The batch directory answers "which batches of
 * this product are on hand, at which of MY places, earliest expiry first", so the office picks a batch by product, never
 * by typing its id. A place outside the caller's branches is never listed (the same stock-read scope as availability).
 */
const T = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('U7 · the batch directory', () => {
  it('lists a product\'s batches on hand at every place the reader may see, by place then earliest expiry; a product is required', async () => {
    const h = apiHarness();
    await h.seedOwner(T, 'u-owner');
    const receive = (id: string, loc: string, batchId: string, expiry: string, qty: number, productId = 'MILK') => h.request({
      method: 'POST', path: '/v1/inventory/movements', userId: 'u-owner', tenantId: T, idempotencyKey: id,
      body: { movementId: id, productId, locationId: loc, kind: 'received', quantityMinor: qty, uom: 'ea', occurredAt: '2026-10-09T08:00:00.000Z', enteredBy: 'u-owner', batchId, expiry, unitCostMinor: 2_500 },
    });
    for (const r of [
      await receive('r1', 'S1', 'B-LATE', '2026-10-20', 5),
      await receive('r2', 'S1', 'B-EARLY', '2026-10-12', 3),
      await receive('r3', 'S2', 'B-S2', '2026-10-15', 4),
      await receive('r4', 'S1', 'B-CURD', '2026-10-11', 9, 'CURD'),
    ]) expect(r.status).toBeLessThan(300);
    const res = await h.request({ method: 'GET', path: '/v1/inventory/batch-directory', userId: 'u-owner', tenantId: T, query: { productId: 'MILK' } });
    expect(res.status).toBe(200);
    const body = res.body as { productId: string; batches: { batchId: string; locationId: string; onHandMinor: number; expiry?: string }[]; order: string };
    expect(body.productId).toBe('MILK');
    expect(body.order).toBe('place_then_earliest_expiry');
    expect(body.batches.map((b) => `${b.locationId}/${b.batchId}`)).toEqual(['S1/B-EARLY', 'S1/B-LATE', 'S2/B-S2']);
    expect(body.batches[0]).toMatchObject({ onHandMinor: 3, expiry: '2026-10-12' });
    const none = await h.request({ method: 'GET', path: '/v1/inventory/batch-directory', userId: 'u-owner', tenantId: T, query: {} });
    expect(none.status).toBe(400);
    expect((none.body as { error: { wasItSaved: string } }).error.wasItSaved).toBe('not_saved');
  });
});
