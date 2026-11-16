import { describe, it, expect } from 'vitest';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/ledger';
import { createManagerSession, ReceivePlaceRefusedError, type ManagerConfig } from '../../apps/web-erp/src/manager-session';
import { readReceivingAids } from '../../apps/web-erp/src/browser-entry';
import { receivingAidsFor } from '../../edge/store-edge/src/screen-data';
import { readPack } from '../../edge/store-edge/src/store-pack';

/**
 * Fix batch 5 · D-017 (M07-FR-01 · M09 · P-02 · P-08): a delivery is booked at the place the purchase order names — this
 * store's shelves when the order says "deliver to the store" — or at the place the manager picks on Receive, and only ever
 * at one of this store's own places. Before, every delivery was booked at the back store, so the store's own stock (which
 * the tills sell from) went negative. Synthetic data only.
 */

const AT = '2026-11-16T10:00:00.000Z';

function session(extra: Partial<ManagerConfig> = {}) {
  const outbox = new SyncOutbox();
  const ledger = new Ledger(new InMemoryLedgerStore());
  const config: ManagerConfig = {
    storeId: 'store-1', branchId: 'store-1', tradingDay: '2026-11-16', tradingDayRule: { cutoff: '02:00' } as unknown as ManagerConfig['tradingDayRule'],
    manager: { userId: 'u-mgr', branchScope: ['store-1'], authorityLimit: null }, currency: 'INR', warehouseId: 'wh-1',
    openDeliveries: [
      { poId: 'po-store', number: 'PO-0001', supplierId: 'sup-1', deliverToLocationId: 'store-1', due: [{ productId: 'p-biscuit', dueMinor: 40 }] },
      { poId: 'po-back', number: 'PO-0002', supplierId: 'sup-1', deliverToLocationId: 'wh-1', due: [{ productId: 'p-biscuit', dueMinor: 40 }] },
      { poId: 'po-elsewhere', number: 'PO-0003', supplierId: 'sup-1', deliverToLocationId: 'store-9', due: [{ productId: 'p-biscuit', dueMinor: 40 }] },
      { poId: 'po-untold', number: 'PO-0004', supplierId: 'sup-1', due: [{ productId: 'p-biscuit', dueMinor: 40 }] },
    ],
    ...extra,
  };
  const ports = { approvals: () => ({ known: false as const, why: 'x' }), exceptions: () => ({ known: false as const, why: 'x' }), unsent: () => ({ known: false as const, why: 'x' }), tasks: () => ({ known: false as const, why: 'x' }), pendingPayments: () => ({ known: false as const, why: 'x' }) };
  return { s: createManagerSession(config, ports as never, ledger, outbox), outbox, ledger };
}

const line = { productId: 'p-biscuit', quantityMinor: 40, uom: 'ea' };
const movedAt = (ledger: Ledger) => ledger.entries().map((r) => r.event.source);
const queuedAt = (outbox: SyncOutbox) => outbox.pending().map((i) => (i.event.payload as { warehouseId?: string }).warehouseId).filter((w) => w !== undefined);

describe('D-017: the places a delivery can be booked into', () => {
  it('offers this store first, then its back store — each once', () => {
    expect(session().s.receivePlaces()).toEqual([{ locationId: 'store-1', kind: 'store' }, { locationId: 'wh-1', kind: 'back_store' }]);
    expect(session({ warehouseId: 'store-1' }).s.receivePlaces()).toEqual([{ locationId: 'store-1', kind: 'store' }]);
  });

  it('starts on the place the order names when it is one of ours; otherwise on the back store, as before', () => {
    const { s } = session();
    expect(s.defaultReceivePlace('po-store')).toBe('store-1');
    expect(s.defaultReceivePlace('po-back')).toBe('wh-1');
    expect(s.defaultReceivePlace('po-elsewhere')).toBe('wh-1');
    expect(s.defaultReceivePlace('po-untold')).toBe('wh-1');
    expect(s.defaultReceivePlace(null)).toBe('wh-1');
    expect(s.defaultReceivePlace('po-not-on-the-list')).toBe('wh-1');
  });
});

describe('D-017: the goods are booked where they are', () => {
  it('an order that says "deliver to the store" is booked at the store — its ledger and the receipt head office gets', () => {
    const { s, ledger, outbox } = session();
    s.receive({ grnId: 'g-1', number: 'DN-1', poId: 'po-store', receivedAt: AT, lines: [line] });
    expect(movedAt(ledger)).toEqual(['store-1']);
    expect(queuedAt(outbox)).toEqual(['store-1']);
  });

  it('the manager may pick the back store instead (or the store for an order to the back store)', () => {
    const a = session();
    a.s.receive({ grnId: 'g-2', number: 'DN-2', poId: 'po-store', receivedAt: AT, lines: [line], locationId: 'wh-1' });
    expect(movedAt(a.ledger)).toEqual(['wh-1']);
    const b = session();
    b.s.receive({ grnId: 'g-3', number: 'DN-3', poId: 'po-back', receivedAt: AT, lines: [line], locationId: 'store-1' });
    expect(queuedAt(b.outbox)).toEqual(['store-1']);
  });

  it('a delivery with no order, or one the store computer was not told the place of, goes to the back store as before', () => {
    const a = session();
    a.s.receive({ grnId: 'g-4', number: 'DN-4', poId: null, receivedAt: AT, lines: [line] });
    expect(movedAt(a.ledger)).toEqual(['wh-1']);
    const b = session();
    b.s.receive({ grnId: 'g-5', number: 'DN-5', poId: 'po-untold', receivedAt: AT, lines: [line] });
    expect(movedAt(b.ledger)).toEqual(['wh-1']);
  });

  it('a place that is not one of this store\'s is refused: nothing saved, no stock moved', () => {
    const { s, ledger, outbox } = session();
    expect(() => s.receive({ grnId: 'g-6', number: 'DN-6', poId: 'po-store', receivedAt: AT, lines: [line], locationId: 'store-9' })).toThrow(ReceivePlaceRefusedError);
    expect(ledger.entries()).toEqual([]);
    expect(outbox.pending()).toEqual([]);
  });
});

describe('D-017: the store computer tells the page where each order is delivered; the page reads it strictly', () => {
  it('serves the order\'s place with the order, and the page keeps it (absent stays absent)', () => {
    const pack = readPack({
      version: 1,
      warehouse: {
        assignmentId: 'A-1', workerId: 'u-mgr', storeId: 'store-1', bins: [],
        openDeliveries: [{ poId: 'po-store', number: 'PO-0001', supplierId: 'sup-1', deliverToLocationId: 'store-1', grnId: 'g-7', ordered: [{ productId: 'p-biscuit', quantityMinor: 40, unitCostMinor: 2_000, currency: 'INR' }] }],
      },
    }, AT);
    const aids = receivingAidsFor({ pack, now: AT } as never);
    expect(aids['openDeliveries']).toEqual([{ poId: 'po-store', number: 'PO-0001', supplierId: 'sup-1', deliverToLocationId: 'store-1', due: [{ productId: 'p-biscuit', dueMinor: 40 }] }]);
    expect(readReceivingAids(aids as never).openDeliveries).toEqual([{ poId: 'po-store', number: 'PO-0001', supplierId: 'sup-1', deliverToLocationId: 'store-1', due: [{ productId: 'p-biscuit', dueMinor: 40 }] }]);
    expect(readReceivingAids({ openDeliveries: [{ poId: 'po-x', number: 'PO-X', due: [] }] } as never).openDeliveries).toEqual([{ poId: 'po-x', number: 'PO-X', supplierId: '', due: [] }]);
  });
});
