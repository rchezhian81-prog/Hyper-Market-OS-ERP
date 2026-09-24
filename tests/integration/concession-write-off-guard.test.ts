import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// API-04 M27-FR-02 (access half) — store staff cannot write off stock the store does not own. A
// concession's goods sit on the store's shelves and belong to somebody else; a loss recorded against
// them by our staff is "a bill we cannot argue with". The write-off route now reads the M08 ledger's
// ownership and refuses a store write-off against a product+location that holds non-own stock — the
// tested checkStockAccess engine makes the call. It fires only once concession stock is present, so an
// ordinary loss on the store's own goods is untouched. Proven through the real pipeline + real ledger.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AT = '2026-09-24T10:00:00.000Z';
const mvBase = { locationId: 'L1', uom: 'ea', occurredAt: AT, enteredBy: 'u-owner' };

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const move = (h: ApiHarness, m: Record<string, unknown>) =>
  h.request({ method: 'POST', path: '/v1/inventory/movements', userId: 'u-owner', tenantId: A, idempotencyKey: `mv-${String(m['movementId'])}`, body: m });

const writeOff = (h: ApiHarness, id: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/inventory/write-off/${id}`, userId: 'u-owner', tenantId: A, idempotencyKey: id,
    body: { locationId: 'L1', uom: 'ea', lossType: 'damage', reasonCode: 'broken', valueMinor: 30_000, ...body } });

describe('store staff cannot write off concession stock (M27-FR-02 access half)', () => {
  it('refuses a store write-off against a product that holds concession stock', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    // The jeweller's gold, on the store's shelf.
    await move(h, { movementId: 'g1', productId: 'GOLD', kind: 'received', quantityMinor: 2, unitCostMinor: 2_000_000, ownership: 'concession', ownerId: 'jeweller-1', ...mvBase });

    const res = await writeOff(h, 'wo-gold', { productId: 'GOLD', qty: 1 });
    expect(res.status).toBe(422);
    expect(codeOf(res)).toBe('stock_not_owned_by_the_store');
    // The refusal names whose stock it is.
    expect((res.body as { error: { whatHappened: string } }).error.whatHappened).toContain('jeweller-1');
  });

  it('allows a store write-off of the store\'s OWN stock (the guard fires only on non-own stock)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await move(h, { movementId: 'r1', productId: 'RICE', kind: 'received', quantityMinor: 10, unitCostMinor: 50, ...mvBase });

    const res = await writeOff(h, 'wo-rice', { productId: 'RICE', qty: 2 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ lossType: 'damage', qtyRemoved: 2 });
  });

  it('guards per product+location — a concession product on the shelf does not block a loss on the store\'s own', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await move(h, { movementId: 'g2', productId: 'GOLD', kind: 'received', quantityMinor: 1, unitCostMinor: 2_000_000, ownership: 'concession', ownerId: 'jeweller-1', ...mvBase });
    await move(h, { movementId: 'r2', productId: 'RICE', kind: 'received', quantityMinor: 8, unitCostMinor: 50, ...mvBase });

    expect((await writeOff(h, 'wo-gold-2', { productId: 'GOLD', qty: 1 })).status).toBe(422);
    expect((await writeOff(h, 'wo-rice-2', { productId: 'RICE', qty: 1 })).status).toBe(201);
  });
});
