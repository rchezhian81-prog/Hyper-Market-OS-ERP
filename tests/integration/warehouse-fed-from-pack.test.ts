import { describe, it, expect } from 'vitest';
import { readPack, emptyPack, type StorePack } from '../../edge/store-edge/src/store-pack';
import { warehousePayload } from '../../edge/store-edge/src/screen-data';
import { bootWarehouse, type WarehouseAssignment } from '../../apps/warehouse-app/src/index';
import { DeviceOutbox, noDeviceStore } from '../../packages/sync/src/device-outbox';
import { SyncOutbox } from '../../packages/sync/src/outbox';

/**
 * **The box builds the Warehouse PWA's assignment from what the cloud sent (M09 / OA-9).**
 *
 * PR #67 proved the offline session executes on a hand-built assignment. This proves the OTHER half of
 * the data path: a store box, given a cloud pack, reads its `warehouse` section (`readPack`), turns it
 * into the handheld's assignment (`warehousePayload`) and the real `WarehouseSession` boots on it and
 * works. And it holds the file's one rule: a pack with NO warehouse section is served **nothing**, not
 * an empty assignment — the box never invents warehouse work the cloud never mentioned.
 */

const NOW = '2026-08-08T10:00:00.000Z';

const CLOUD_PACK = {
  version: 3,
  warehouse: {
    assignmentId: 'wa-7', workerId: 'u-wh', storeId: 'store-1',
    bins: [
      { binId: 'B-PICK', storeId: 'store-1', capacityMinor: 200, pickable: true },
      { binId: 'B-HOLD', storeId: 'store-1', capacityMinor: 200, pickable: false, zone: 'quarantine' },
    ],
    goodsIn: [{ productId: 'P1', batchId: null, quantityMinor: 40, uom: 'EA', state: 'on_hand', expiry: null }],
    barcodes: [{ barcode: '111', productId: 'P1', level: 'unit' }],
    ordered: [{ productId: 'P1', quantityMinor: 100, unitCostMinor: 90_00, currency: 'INR' }],
    grnId: 'GRN-9',
    recalledBatchIds: ['B-RECALL'],
  },
};

const screenInput = (pack: StorePack) => ({
  pack, sales: [], unreadableRecords: 0, outbox: new SyncOutbox(), now: NOW, tradingDay: '2026-08-08',
});

describe('the box feeds the warehouse handheld from the cloud pack (M09 / OA-9)', () => {
  it('reads the warehouse section, builds the assignment, and the session boots and works on it', () => {
    const pack = readPack(CLOUD_PACK, NOW);
    expect(pack.warehouse.known).toBe(true);

    const payload = warehousePayload(screenInput(pack));
    expect(payload).not.toBeNull();
    // The ordered lines are mapped into the money shape the receiving engine expects.
    expect((payload as { ordered: { unitCost: { minor: number; currency: string } }[] }).ordered[0]!.unitCost)
      .toEqual({ minor: 90_00, currency: 'INR' });

    // The real handheld session boots on exactly what the box serves.
    const session = bootWarehouse(payload as unknown as WarehouseAssignment, new DeviceOutbox(noDeviceStore()), () => NOW)!;
    expect(session).not.toBeNull();
    expect(session.goodsIn()).toHaveLength(1);

    // It executes on the served facts: receive on-order stock, then put it away into a real bin.
    const recv = session.receive({ commandId: 'c1', grnId: 'GRN-9', barcode: '111', scannedQuantity: 10, source: 'po', poId: 'PO-1' });
    expect(recv.result.accepted).toBe(true);
    const put = session.putAway({ commandId: 'm1', scannedProductId: 'P1', scannedBinId: 'B-PICK', quantityMinor: 40, uom: 'EA', at: NOW });
    expect(put.result.accepted).toBe(true);
    expect(session.binContents()['B-PICK|P1|']).toBe(40);
  });

  it('serves NOTHING when the cloud pack carries no warehouse section — the box invents no work', () => {
    // A pack that never mentioned warehouse work must not become an empty assignment.
    const packNoWarehouse = readPack({ version: 3 }, NOW);
    expect(packNoWarehouse.warehouse.known).toBe(false);
    expect(warehousePayload(screenInput(packNoWarehouse))).toBeNull();

    // And an unheard-of box (emptyPack) says the same.
    expect(warehousePayload(screenInput(emptyPack()))).toBeNull();
    // Booting on nothing is a real, supported state.
    expect(bootWarehouse(undefined, new DeviceOutbox(noDeviceStore()))).toBeNull();
  });
});
