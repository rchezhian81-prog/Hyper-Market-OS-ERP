import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { STREAM } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';
import { backingsFor, headOffice, type HeadOffice } from '../support/till-bill-world';

/**
 * **Batch 18a · R3 and R4 (M07-FR-02/03) — a delivery booked in on Receive (office) carries the MRP printed on the pack and
 * how many FAILED THE QUALITY CHECK or were refused at the door; head office judges both — on the in-memory store AND real
 * PostgreSQL.**
 *
 *   • R3: the MRP typed off the pack is compared with the MRP head office publishes for the item; a different one raises an
 *     `mrp_mismatch` discrepancy for the buyer (the goods still go on sale — it is a review, not a refusal). The same MRP
 *     raises nothing.
 *   • R4: the failed units become their own line with the quality check failed — QUARANTINED, never on hand, waiting on a
 *     second person's decision (accept / return to the supplier / claim). Damaged and failed together never exceed what
 *     arrived; anything else is not readable (refused, nothing saved).
 * Synthetic data throughout.
 */

const { backings, open, close } = backingsFor(process.env['DATABASE_URL']);
beforeAll(open);
afterAll(close);

const AT = '2026-11-19T10:00:00.000Z';
const WH = 'wh-store';

interface GrnBody {
  grn: {
    availableMinor: number;
    captured: {
      lines: { productId: string; sellableMinor: number; quarantinedMinor?: number; disposition: string }[];
      discrepancies: { kind: string; productId?: string; lineId: string }[];
    };
  };
}

const receipt = (grnId: string, lines: Record<string, unknown>[]) => ({
  grnId, number: `DN-${grnId}`, poId: null, lineCount: lines.length, warehouseId: WH, receivedBy: 'u-mgr', receivedAt: AT,
  lines, storeId: WH, source: 'manager-screen',
});

async function seeded(ho: HeadOffice): Promise<void> {
  await ho.h.store.append(ho.tenantId, STREAM.catalogue, makeEvent({
    id: `pack-${ho.tenantId}-1`, type: 'CataloguePublished', occurredAt: AT, idempotencyKey: `catalogue-${ho.tenantId}-v1`, source: 'test/catalogue',
    payload: {
      snapshot: {
        tenantId: ho.tenantId, version: 1, builtAt: AT, scope: { tenantId: ho.tenantId, storeId: 'store-1' },
        products: [
          { productId: 'p-oil', sku: 'p-oil', name: 'Groundnut oil 1 L', unitPriceMinor: 19_000, mrpMinor: 21_000, taxBps: 500, status: 'active', uom: 'ea', batchTracked: false, handling: 'ambient' },
        ],
        barcodes: [],
      },
    },
  }));
}

const onHand = async (ho: HeadOffice, productId: string): Promise<number> => {
  const res = await ho.call('GET', '/v1/inventory/availability', 'u-owner', undefined, { productId });
  return ((res.body as { rows: { locationId: string; onHandMinor: number }[] }).rows).filter((r) => r.locationId === WH).reduce((s, r) => s + r.onHandMinor, 0);
};

describe.each(backings)('Batch 18a · R3/R4 — Receive carries the pack MRP and a failed quality check — on $name', (backing) => {
  it('a different MRP on the pack is flagged for the buyer; the failed units are quarantined, never on hand', async () => {
    const ho = await headOffice(backing, [{ userId: 'u-mgr', role: 'store_manager' }, { userId: 'u-box', role: 'store_computer', stores: [WH] }]);
    await seeded(ho);
    const res = await ho.call('POST', '/v1/inventory/goods-receipt/g-b18a-1/synced', 'u-box',
      receipt('g-b18a-1', [{ productId: 'p-oil', quantityMinor: 12, uom: 'ea', batchId: 'OIL-1', qcFailedMinor: 3, damagedMinor: 1, mrpMinor: 22_000 }]));
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const grn = (res.body as GrnBody).grn;
    expect(grn.captured.lines.map((l) => ({ sellable: l.sellableMinor, disposition: l.disposition }))).toEqual([
      { sellable: 8, disposition: 'sellable' },
      { sellable: 0, disposition: 'quarantine' }, // damaged
      { sellable: 0, disposition: 'quarantine' }, // failed the quality check
    ]);
    const kinds = grn.captured.discrepancies.map((d) => d.kind).sort();
    expect(kinds).toContain('qc_failed');
    expect(kinds).toContain('damaged');
    expect(kinds.filter((k) => k === 'mrp_mismatch').length).toBeGreaterThan(0);
    expect(grn.availableMinor).toBe(8);
    expect(await onHand(ho, 'p-oil')).toBe(8);
  });

  it('the same MRP raises nothing; damaged + failed above what arrived, or an MRP that is not an amount, is refused, nothing saved', async () => {
    const ho = await headOffice(backing, [{ userId: 'u-mgr', role: 'store_manager' }, { userId: 'u-box', role: 'store_computer', stores: [WH] }]);
    await seeded(ho);
    const same = await ho.call('POST', '/v1/inventory/goods-receipt/g-b18a-2/synced', 'u-box',
      receipt('g-b18a-2', [{ productId: 'p-oil', quantityMinor: 5, uom: 'ea', batchId: null, mrpMinor: 21_000 }]));
    expect(same.status, JSON.stringify(same.body)).toBe(202);
    expect((same.body as GrnBody).grn.captured.discrepancies.map((d) => d.kind)).not.toContain('mrp_mismatch');
    const tooMany = await ho.call('POST', '/v1/inventory/goods-receipt/g-b18a-3/synced', 'u-box',
      receipt('g-b18a-3', [{ productId: 'p-oil', quantityMinor: 5, uom: 'ea', batchId: null, damagedMinor: 3, qcFailedMinor: 3 }]));
    expect(tooMany.status).toBe(400);
    const badMrp = await ho.call('POST', '/v1/inventory/goods-receipt/g-b18a-4/synced', 'u-box',
      receipt('g-b18a-4', [{ productId: 'p-oil', quantityMinor: 5, uom: 'ea', batchId: null, mrpMinor: -5 }]));
    expect(badMrp.status).toBe(400);
    expect(await onHand(ho, 'p-oil')).toBe(5);
  });
});
