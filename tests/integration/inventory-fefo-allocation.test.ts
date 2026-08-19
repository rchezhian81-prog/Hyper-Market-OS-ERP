import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// M10-FR-01: FEFO allocation on the live API — "to meet a demand for N units of a product, which batches do
// we draw from?" — earliest-expiry-first over the supplied on-hand batches, only sellable ones (expired /
// recalled / quarantined / zero-qty / wrong-product excluded), reporting any SHORTFALL honestly rather than
// over-allocating. This is the allocation a pick list, a transfer or an online order uses so the oldest stock
// leaves first ("sales allocate the earliest-expiry batch"). Stateless: a read masquerading as POST.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AS_OF = '2026-08-18';

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const allocate = (h: ApiHarness, userId: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/inventory/fefo-allocation', userId, tenantId: A, idempotencyKey: key, body });

interface FefoResult {
  requiredQty: number;
  allocated: { batchId: string; qty: number; expiry: string }[];
  allocatedQty: number;
  shortfallQty: number;
  fullyAllocated: boolean;
}

describe('FEFO allocation (M10-FR-01)', () => {
  it('draws earliest-expiry-first and fully meets a demand it can cover', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const batches = [
      { batchId: 'later', productId: 'p1', qty: 10, expiry: '2026-08-25' },
      { batchId: 'soonest', productId: 'p1', qty: 3, expiry: '2026-08-18' },
      { batchId: 'middle', productId: 'p1', qty: 5, expiry: '2026-08-20' },
    ];
    const body = (await allocate(h, 'u-owner', { batches, productId: 'p1', requiredQty: 6, asOf: AS_OF }, 'f1')).body as FefoResult;
    // soonest (3, 08-18) fully, then middle (3 of 5, 08-20); the later batch is untouched.
    expect(body.allocated).toEqual([
      { batchId: 'soonest', qty: 3, expiry: '2026-08-18' },
      { batchId: 'middle', qty: 3, expiry: '2026-08-20' },
    ]);
    expect(body).toMatchObject({ allocatedQty: 6, shortfallQty: 0, fullyAllocated: true });
  });

  it('reports a shortfall honestly rather than over-allocating', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const batches = [
      { batchId: 'a', productId: 'p1', qty: 3, expiry: '2026-08-18' },
      { batchId: 'b', productId: 'p1', qty: 5, expiry: '2026-08-20' },
    ];
    const body = (await allocate(h, 'u-owner', { batches, productId: 'p1', requiredQty: 20, asOf: AS_OF }, 'f2')).body as FefoResult;
    expect(body).toMatchObject({ allocatedQty: 8, shortfallQty: 12, fullyAllocated: false });
    expect(body.allocated.map((a) => a.batchId)).toEqual(['a', 'b']);
  });

  it('never draws from an expired, recalled, quarantined, empty or wrong-product batch', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const batches = [
      { batchId: 'good', productId: 'p1', qty: 4, expiry: '2026-08-20' },                              // sellable → drawn
      { batchId: 'expired', productId: 'p1', qty: 9, expiry: '2026-08-10' },                            // expired → never
      { batchId: 'recalled', productId: 'p1', qty: 9, expiry: '2026-08-25', recallBlocked: true },      // recalled → never
      { batchId: 'held', productId: 'p1', qty: 9, expiry: '2026-08-25', state: 'quarantine' },          // held → never
      { batchId: 'empty', productId: 'p1', qty: 0, expiry: '2026-08-25' },                              // no stock → never
      { batchId: 'other', productId: 'p2', qty: 9, expiry: '2026-08-19' },                              // wrong product → never
    ];
    const body = (await allocate(h, 'u-owner', { batches, productId: 'p1', requiredQty: 100, asOf: AS_OF }, 'f3')).body as FefoResult;
    // Only the one sellable p1 batch is drawn; everything else is correctly excluded.
    expect(body.allocated.map((a) => a.batchId)).toEqual(['good']);
    expect(body).toMatchObject({ allocatedQty: 4, shortfallQty: 96, fullyAllocated: false });
  });

  it('a demand of zero draws nothing and is fully allocated', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const batches = [{ batchId: 'a', productId: 'p1', qty: 5, expiry: '2026-08-20' }];
    const body = (await allocate(h, 'u-owner', { batches, productId: 'p1', requiredQty: 0, asOf: AS_OF }, 'f4')).body as FefoResult;
    expect(body).toMatchObject({ allocated: [], allocatedQty: 0, shortfallQty: 0, fullyAllocated: true });
  });

  it('refuses a malformed request and an unparseable date, and gates on inventory.availability.read', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    const ok = { batchId: 'b', productId: 'p1', qty: 5, expiry: '2026-08-20' };
    // Missing productId / requiredQty.
    expect(codeOf(await allocate(h, 'u-owner', { batches: [ok], asOf: AS_OF }, 'f-bad1'))).toBe('not_readable_as_a_fefo_allocation');
    // Negative requiredQty is refused at the boundary.
    expect((await allocate(h, 'u-owner', { batches: [ok], productId: 'p1', requiredQty: -1, asOf: AS_OF }, 'f-neg')).status).toBe(400);
    // An unparseable expiry reaches the engine → 400 invalid_fefo_request.
    const bad = await allocate(h, 'u-owner', { batches: [{ ...ok, expiry: 'not-a-date' }], productId: 'p1', requiredQty: 1, asOf: AS_OF }, 'f-baddate');
    expect(codeOf(bad)).toBe('invalid_fefo_request');
    // A cashier does not hold inventory.availability.read.
    expect((await allocate(h, 'u-cash', { batches: [ok], productId: 'p1', requiredQty: 1, asOf: AS_OF }, 'f-rbac')).status).toBe(403);
  });
});
