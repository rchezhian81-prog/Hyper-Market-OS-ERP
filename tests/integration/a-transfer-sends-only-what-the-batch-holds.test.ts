import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { makeEvent } from '../../packages/contracts/src/event';
import { inventoryAdapter, STREAM } from '../../services/api/src/adapters';
import { projectBatches, type Movement } from '../../services/inventory/src/index';

/**
 * **SF-03 — a transfer sends only what the named batch holds (Wave 3 · M08-FR-01 · M08-FR-02 · M09-FR-03 · M10-FR-03).**
 *
 * The audit seeded batch A with 10 and batch B with 90 of one product at the warehouse, asked to send 50 of A, and the
 * dispatch said A had 100 and sent 50 — the product's total stood in for the batch. The source's stock for a transfer is
 * now ONE batch-, state- and reservation-aware figure from the movement ledger: the named batch's own on-hand; 0 for a
 * batch the source never held; an expired batch refused by state; stock promised to customers not free to send; every
 * line on the same batch counted together; and a line in another unit than the product master's refused by name.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AT = '2026-10-09T06:00:00.000Z';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const whatHappened = (res: { body: unknown }): string => (res.body as { error: { whatHappened: string } }).error.whatHappened;
const line = (quantityMinor: number, batchId: string | null, uom = 'EA') => ({ productId: 'P1', batchId, quantityMinor, uom, unitCost: { minor: 5_000, currency: 'INR' } });

async function lab(): Promise<{ h: ApiHarness; stock: (qty: number, batchId: string | null, expiry?: string) => Promise<void>; send: (id: string, lines: unknown[]) => Promise<{ status: number; body: unknown }> }> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-boss', 'store_manager');
  const req = (path: string, key: string, body: unknown, userId = 'u-owner') => h.request({ method: 'POST', path, userId, tenantId: A, idempotencyKey: key, body });
  for (const [id, body] of [
    ['C1', { kind: 'company', name: 'SRE Retail' }],
    ['WH', { kind: 'warehouse', name: 'Central warehouse', parentId: 'C1', companyId: 'C1' }],
    ['S1', { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' }],
  ] as const) expect((await req(`/v1/org/nodes/${id}`, `org-${id}`, body)).status).toBe(201);
  return {
    h,
    stock: async (qty, batchId, expiry) => {
      const id = `seed-${qty}-${batchId ?? 'none'}`;
      expect((await req('/v1/inventory/movements', id, {
        movementId: id, productId: 'P1', locationId: 'WH', kind: 'received', quantityMinor: qty, uom: 'EA', occurredAt: '2026-08-01T00:00:00.000Z', enteredBy: 'u-owner',
        ...(batchId === null ? {} : { batchId }), ...(expiry === undefined ? {} : { expiry }),
      })).status).toBeLessThan(300);
    },
    send: async (id, lines) => {
      const proposed = await req(`/v1/warehouse/transfers/${id}`, `tr-${id}`, { fromLocationId: 'WH', toLocationId: 'S1', lines });
      if (proposed.status !== 201) return proposed;
      return req(`/v1/warehouse/transfers/${id}/dispatch`, `td-${id}`, {}, 'u-boss');
    },
  };
}

describe('SF-03 — a transfer sends only what the named batch holds', () => {
  it('the audit\'s case: batch A holds 10, batch B 90 — 50 of A is refused by the batch\'s own figure; 10 of A goes', async () => {
    const { stock, send } = await lab();
    await stock(10, 'A');
    await stock(90, 'B');
    const fifty = await send('t1', [line(50, 'A')]);
    expect(codeOf(fifty)).toBe('transfer_refused');
    expect(whatHappened(fifty)).toMatch(/only 10 of P1 batch A available to send, not 50/);
    const ten = await send('t2', [line(10, 'A')]);
    expect(ten.status).toBe(200);
    expect((ten.body as { availableChecked: unknown[] }).availableChecked).toEqual([{ productId: 'P1', batchId: 'A', quantityMinor: 10, state: 'on_hand', recalled: false }]);
    // and A is now empty while B is untouched
    expect(codeOf(await send('t3', [line(1, 'A')]))).toBe('transfer_refused');
    expect((await send('t4', [line(90, 'B')])).status).toBe(200);
  });

  it('a batch the source never held has nothing to send', async () => {
    const { stock, send } = await lab();
    await stock(100, 'B');
    expect(whatHappened(await send('t1', [line(5, 'Z')]))).toMatch(/only 0 of P1 batch Z available to send, not 5/);
  });

  it('an expired batch is refused by its state, however much of it there is', async () => {
    const { stock, send } = await lab();
    await stock(40, 'OLD', '2026-01-31');
    expect(whatHappened(await send('t1', [line(5, 'OLD')]))).toMatch(/P1 is expired/);
  });

  it('two lines on the same batch are counted together: 60 + 60 against 100 is 120 asked', async () => {
    const { stock, send } = await lab();
    await stock(100, 'A');
    expect(whatHappened(await send('t1', [line(60, 'A'), line(60, 'A')]))).toMatch(/only 100 of P1 batch A available to send, not 120/);
  });

  it('stock promised to customers is not free to send: 100 on hand, 70 promised — 50 refused, 30 goes', async () => {
    const { h, stock, send } = await lab();
    await stock(100, null);
    const promised = await h.request({ method: 'POST', path: '/v1/orders/o1/promise', userId: 'u-owner', tenantId: A, idempotencyKey: 'p-o1', body: { lines: [{ productId: 'P1', quantityMinor: 70 }], locationId: 'WH' } });
    expect((promised.body as { outcome: string }).outcome).toBe('promised');
    expect(whatHappened(await send('t1', [line(50, null)]))).toMatch(/only 30 of P1 available to send, not 50/);
    expect((await send('t2', [line(30, null)])).status).toBe(200);
  });

  it('a line in another unit than the product master\'s is refused by name — nothing recorded', async () => {
    const { h, stock, send } = await lab();
    await stock(100, null);
    await h.store.append(A, STREAM.catalogue, makeEvent({
      id: `pack-${A}-1`, type: 'CataloguePublished', occurredAt: AT, idempotencyKey: `catalogue-${A}-v1`, source: 'test/catalogue',
      payload: { snapshot: { tenantId: A, version: 1, builtAt: AT, scope: { tenantId: A, storeId: 'S1' }, barcodes: [],
        products: [{ productId: 'P1', sku: 'P1', name: 'Toor dal 1kg', baseUom: 'EA', unitPriceMinor: 16_000, taxBps: 0, status: 'active', batchTracked: false }] } },
    }));
    const wrong = await send('t1', [line(2, null, 'CASE')]);
    expect(wrong.status).toBe(422);
    expect(codeOf(wrong)).toBe('unit_not_the_products');
    expect(whatHappened(wrong)).toMatch(/counted in "EA".*says "CASE"/);
    expect((await h.request({ method: 'GET', path: '/v1/warehouse/transfers/t1', userId: 'u-owner', tenantId: A })).status).toBe(404);
    expect((await send('t2', [line(2, null, 'EA')])).status).toBe(200);
  });
});

describe('SF-03 — the per-batch figure is the ledger\'s, through every snapshot', () => {
  const mv = (n: number, batchId: string | undefined, qty: number, kind: Movement['kind'] = 'received', expiry?: string): Movement => ({
    movementId: `m${n}`, productId: 'P1', locationId: 'WH', kind, quantityMinor: qty, uom: 'EA', occurredAt: AT, enteredBy: 'u',
    ...(batchId === undefined ? {} : { batchId }), ...(expiry === undefined ? {} : { expiry }),
  });

  it('projectBatches: per product, location and batch; an unbatched movement is its own row; the receipt\'s expiry rides along', () => {
    expect(projectBatches([mv(1, 'A', 10, 'received', '2026-12-31'), mv(2, 'B', 90), mv(3, 'A', 4, 'sold'), mv(4, undefined, 7)])).toEqual([
      { productId: 'P1', locationId: 'WH', batchId: null, onHandMinor: 7 },
      { productId: 'P1', locationId: 'WH', batchId: 'A', onHandMinor: 6, expiry: '2026-12-31' },
      { productId: 'P1', locationId: 'WH', batchId: 'B', onHandMinor: 90 },
    ]);
  });

  it('snapshots carry the batch balances, so the figure is the same before and after one is taken', async () => {
    const store = new InMemoryEventStore();
    const inv = inventoryAdapter({ store, now: () => AT, snapshotEvery: 3 });
    const moves = [mv(1, 'A', 10), mv(2, 'B', 90), mv(3, 'A', 4, 'sold'), mv(4, 'B', 5, 'sold'), mv(5, 'A', 1, 'sold')];
    for (const m of moves) await inv.appendMovement(A, m);
    expect((await store.readStream(A, STREAM.inventory, { type: 'InventorySnapshotTaken' })).length).toBeGreaterThan(0);
    expect(await inv.batches!(A, 'P1')).toEqual(projectBatches(moves));
  });

  it('a snapshot from before SF-03 (no batch balances) is not trusted for batches: the ledger is folded from the start', async () => {
    const store = new InMemoryEventStore();
    const inv = inventoryAdapter({ store, now: () => AT });
    const moves = [mv(1, 'A', 10), mv(2, 'B', 90), mv(3, 'A', 4, 'sold')];
    for (const m of moves) await inv.appendMovement(A, m);
    const seq = (await store.readStream(A, STREAM.inventory)).at(-1)!.seq;
    await store.append(A, STREAM.inventory, makeEvent({
      id: 'old-snap', type: 'InventorySnapshotTaken', occurredAt: AT, idempotencyKey: 'old-snap', source: 'test',
      payload: { asOfSeq: seq, balances: [{ productId: 'P1', locationId: 'WH', onHandMinor: 96, movements: 3, asAt: AT }] },
    }));
    await inv.appendMovement(A, mv(4, 'B', 10, 'sold'));
    expect(await inv.batches!(A, 'P1')).toEqual(projectBatches([...moves, mv(4, 'B', 10, 'sold')]));
  });
});
