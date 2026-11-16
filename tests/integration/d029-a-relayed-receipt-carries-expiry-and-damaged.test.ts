import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { STREAM } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';

/**
 * **Fix batch 4b · D-029 at head office: a delivery booked in on the manager's screen carries each line's batch, EXPIRY date
 * and how many arrived DAMAGED (M07-FR-02/03 · M10 · P-08 · hard rules #2/#10).**
 *
 * The walkthrough found received food had no expiry, so the expiry list could never show it, and nothing could be booked in
 * as damaged from the manager's screen. Now the relayed receipt's line names its expiry and damaged count: the damaged units
 * become their own captured line (quarantined, never sellable, never on-hand), the good ones are sellable, and the batch's
 * expiry is on the `received` movement — so the batch read (earliest expiry first, which the expiry list and A03 use) knows
 * it. A batch-tracked item booked in with its batch and expiry is received. A damaged count above what arrived, or an
 * expiry that is not a date, is not a delivery this route can read: refused, nothing saved. Synthetic data throughout.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AT = '2026-11-16T10:00:00.000Z';
const WH = 'wh-store';

interface GrnBody {
  grn: { availableMinor: number; heldMinor?: number; captured: { lines: { productId: string; sellableMinor: number; disposition: string; expiry: string | null; batchId?: string | null }[] } };
}

const receipt = (grnId: string, lines: Record<string, unknown>[]) => ({
  grnId, number: `DN-${grnId}`, poId: null, lineCount: lines.length, warehouseId: WH, receivedBy: 'u-mgr', receivedAt: AT,
  lines, storeId: WH, source: 'manager-screen',
});
const relay = (h: ApiHarness, body: ReturnType<typeof receipt>) =>
  h.request({ method: 'POST', path: `/v1/inventory/goods-receipt/${body.grnId}/synced`, userId: 'u-box', tenantId: A, idempotencyKey: `k-${body.grnId}`, body });
const onHand = async (h: ApiHarness, productId: string): Promise<number> => {
  const res = await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: 'u-owner', tenantId: A, query: { productId } });
  return ((res.body as { rows: { locationId: string; onHandMinor: number }[] }).rows).filter((r) => r.locationId === WH).reduce((s, r) => s + r.onHandMinor, 0);
};
const batches = async (h: ApiHarness, productId: string) =>
  ((await h.request({ method: 'GET', path: '/v1/inventory/batches', userId: 'u-owner', tenantId: A, query: { locationId: WH, productId } })).body as { batches: { batchId: string | null; onHandMinor: number; expiry?: string }[] }).batches;

async function seeded(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager');
  await h.provisionRole(A, 'u-box', 'store_computer', [WH]);
  await h.store.append(A, STREAM.catalogue, makeEvent({
    id: `pack-${A}-1`, type: 'CataloguePublished', occurredAt: AT, idempotencyKey: `catalogue-${A}-v1`, source: 'test/catalogue',
    payload: {
      snapshot: {
        tenantId: A, version: 1, builtAt: AT, scope: { tenantId: A, storeId: 'store-1' },
        products: [
          { productId: 'p-rice', sku: 'p-rice', name: 'Ponni rice 5 kg', unitPriceMinor: 60_000, taxBps: 0, status: 'active', uom: 'ea', batchTracked: false, handling: 'ambient' },
          { productId: 'p-curd', sku: 'p-curd', name: 'Curd 500 g', unitPriceMinor: 4_000, taxBps: 0, status: 'active', uom: 'ea', batchTracked: true, handling: 'ambient' },
        ],
        barcodes: [],
      },
    },
  }));
  return h;
}

describe('D-029: a delivery booked in on the manager\'s screen carries its batch, expiry and damaged count to head office', () => {
  it('the damaged units are quarantined, the good ones sellable, and the batch\'s expiry reaches the batch read (expiry list)', async () => {
    const h = await seeded();
    const res = await relay(h, receipt('g-d029-1', [{ productId: 'p-rice', quantityMinor: 11, uom: 'ea', batchId: 'RB-2611', expiry: '2027-05-31', damagedMinor: 2 }]));
    expect(res.status).toBe(202);
    const grn = (res.body as GrnBody).grn;
    const lines = grn.captured.lines.filter((l) => l.productId === 'p-rice');
    expect(lines.map((l) => ({ sellable: l.sellableMinor, disposition: l.disposition, expiry: l.expiry }))).toEqual([
      { sellable: 9, disposition: 'sellable', expiry: '2027-05-31' },
      { sellable: 0, disposition: 'quarantine', expiry: '2027-05-31' },
    ]);
    expect(grn.availableMinor).toBe(9);
    // Only the 9 good ones are on hand; the 2 damaged never are.
    expect(await onHand(h, 'p-rice')).toBe(9);
    // The batch read — earliest expiry first, what the expiry list and A03 markdowns read — knows the batch and its date.
    expect(await batches(h, 'p-rice')).toEqual([expect.objectContaining({ batchId: 'RB-2611', onHandMinor: 9, expiry: '2027-05-31' })]);
  });

  it('a wholly damaged line books nothing on hand; a batch-tracked item with its batch and expiry from the screen is received', async () => {
    const h = await seeded();
    const res = await relay(h, receipt('g-d029-2', [
      { productId: 'p-rice', quantityMinor: 3, uom: 'ea', batchId: null, damagedMinor: 3 },
      { productId: 'p-curd', quantityMinor: 20, uom: 'ea', batchId: 'CURD-77', expiry: '2026-12-10' },
    ]));
    expect(res.status).toBe(202);
    expect(await onHand(h, 'p-rice')).toBe(0);
    expect(await onHand(h, 'p-curd')).toBe(20);
    expect(await batches(h, 'p-curd')).toEqual([expect.objectContaining({ batchId: 'CURD-77', expiry: '2026-12-10' })]);
  });

  it('more damaged than arrived, or an expiry that is not a real date, is not readable — refused, nothing saved', async () => {
    const h = await seeded();
    const tooMany = await relay(h, receipt('g-d029-3', [{ productId: 'p-rice', quantityMinor: 5, uom: 'ea', batchId: null, damagedMinor: 6 }]));
    expect(tooMany.status).toBe(400);
    const badDate = await relay(h, receipt('g-d029-4', [{ productId: 'p-rice', quantityMinor: 5, uom: 'ea', batchId: 'B', expiry: '2027-02-30' }]));
    expect(badDate.status).toBe(400);
    const notWhole = await relay(h, receipt('g-d029-5', [{ productId: 'p-rice', quantityMinor: 5, uom: 'ea', batchId: null, damagedMinor: 1.5 }]));
    expect(notWhole.status).toBe(400);
    expect(await onHand(h, 'p-rice')).toBe(0);
  });
});
