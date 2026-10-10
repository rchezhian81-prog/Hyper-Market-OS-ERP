import { describe, it, expect } from 'vitest';
import { apiHarness } from '../support/api-harness';
import { fefoBatchesAt, type BatchBalance } from '../../services/inventory/src/index';

/**
 * OB-35 "A" (owner, 10 Oct 2026): head office assigns each sold line to the earliest-expiry batch on hand. Batch 2 owns the
 * batch-aware projection; this is the read the sale side (Batch 3) uses — `fefoBatchesAt` and `GET /v1/inventory/batches`.
 */

describe('OB-35 — per batch on hand, earliest expiry first', () => {
  it('orders a place\'s positive batches by expiry, unknown expiry after known, the unbatched remainder last; other places and products excluded', () => {
    const rows: BatchBalance[] = [
      { productId: 'MILK', locationId: 'S1', batchId: 'B-LATE', onHandMinor: 5, expiry: '2026-10-20' },
      { productId: 'MILK', locationId: 'S1', batchId: null, onHandMinor: 2 },
      { productId: 'MILK', locationId: 'S1', batchId: 'B-NODATE', onHandMinor: 1 },
      { productId: 'MILK', locationId: 'S1', batchId: 'B-EARLY', onHandMinor: 3, expiry: '2026-10-12' },
      { productId: 'MILK', locationId: 'S1', batchId: 'B-GONE', onHandMinor: 0, expiry: '2026-10-11' },
      { productId: 'MILK', locationId: 'S2', batchId: 'B-OTHER', onHandMinor: 9, expiry: '2026-10-11' },
      { productId: 'CURD', locationId: 'S1', batchId: 'B-CURD', onHandMinor: 9, expiry: '2026-10-11' },
    ];
    expect(fefoBatchesAt(rows, 'S1', 'MILK').map((b) => b.batchId)).toEqual(['B-EARLY', 'B-LATE', 'B-NODATE', null]);
  });

  it('GET /v1/inventory/batches reads the ledger\'s batches for a store and product, earliest expiry first', async () => {
    const h = apiHarness();
    const t = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await h.seedOwner(t, 'u-owner');
    const receive = (id: string, batchId: string, expiry: string, qty: number) => h.request({
      method: 'POST', path: '/v1/inventory/movements', userId: 'u-owner', tenantId: t, idempotencyKey: id,
      body: { movementId: id, productId: 'MILK', locationId: 'S1', kind: 'received', quantityMinor: qty, uom: 'ea', occurredAt: '2026-10-09T08:00:00.000Z', enteredBy: 'u-owner', batchId, expiry, unitCostMinor: 2_500 },
    });
    expect((await receive('r1', 'B-LATE', '2026-10-20', 5)).status).toBeLessThan(300);
    expect((await receive('r2', 'B-EARLY', '2026-10-12', 3)).status).toBeLessThan(300);
    const res = await h.request({ method: 'GET', path: '/v1/inventory/batches', userId: 'u-owner', tenantId: t, query: { locationId: 'S1', productId: 'MILK' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ order: 'earliest_expiry_first', batches: [{ batchId: 'B-EARLY', onHandMinor: 3, expiry: '2026-10-12' }, { batchId: 'B-LATE', onHandMinor: 5, expiry: '2026-10-20' }] });
    expect((await h.request({ method: 'GET', path: '/v1/inventory/batches', userId: 'u-owner', tenantId: t, query: { productId: 'MILK' } })).status).toBe(400);
  });
});
