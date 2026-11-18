import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lowStockSectionOf, supplierNamesOf } from '../../services/api/src/low-stock-section';
import { todayBoard, todayFigures, lowStockFigure, lowStockListOf, recentActivity, receivingAidsFor, supplierNamesOf as packSupplierNames, dailyFiguresOf, type ScreenInput } from '../../edge/store-edge/src/screen-data';
import { emptyPack, known, type StorePack } from '../../edge/store-edge/src/store-pack';
import { figuresToRecord, previousFigure, priceChangesBetween, openTodayHistory, readHistoryRecord, type TodayHistoryRecord } from '../../edge/store-edge/src/today-history';
import { directoryPayload } from '../../edge/store-edge/src/screen-directory';
import { branchOf } from '../../edge/store-edge/src/screen-navigation';
import { SETUP_CATALOGUE } from '../../packages/tenant/src/setup';
import { SETTINGS } from '../../packages/tenant/src/settings';
import type { LoggedSale } from '../../edge/store-edge/src/read-model';

/**
 * **Batch 15 (owner's gap audit, 18 Nov 2026): the Today cards carry real figures, the box remembers yesterday, Recent
 * activity is the store's day, the town is under the store's name, and a supplier is named — never made up (P-08).**
 *
 *   1. Low stock is head office's own judgement on its own stock: items at or below their reorder point. With no reorder
 *      point set anywhere the card says "no reorder levels set yet" — never a reassuring 0.
 *   2. The box keeps an append-only daily record of open orders and low stock, so the cards compare with the last earlier
 *      day it saw; with none, it says so.
 *   3. Recent activity lists bills, deliveries booked in, approvals decided, write-offs and price changes — each from a record.
 *   5. The town rides the pack only when store setup holds one.
 *   6. Suppliers are named from the pack's supplier master; the code shows only when no name exists.
 */

const DAY = '2026-11-18';
const NOW = '2026-11-18T08:30:00.000Z'; // 14:00 in the shop
const basePack = (over: Partial<StorePack> = {}): StorePack => ({
  ...emptyPack('test'),
  policies: known({ storeId: 'S1', branchId: 'S1', branchName: 'SRE Hyper Market', tradingDayCutoff: '02:00', timeZone: 'Asia/Kolkata' } as never),
  ...over,
});
const input = (pack: StorePack, extra: Partial<ScreenInput> = {}): ScreenInput =>
  ({ pack, sales: [], tradingDay: DAY, now: NOW, unreadableRecords: 0, ...extra }) as unknown as ScreenInput;

describe('1 · low stock: head office counts items at or below their reorder point', () => {
  it('lists only items with a reorder point that are at or below it, emptiest first, and counts the levels set', () => {
    const section = lowStockSectionOf(
      [{ productId: 'rice', reorderPoint: 10 }, { productId: 'dal', reorderPoint: 4 }, { productId: 'oil' }, { productId: 'salt', reorderPoint: 5 }, { productId: 'tea', reorderPoint: 2 }],
      new Map([['rice', 10], ['dal', 1], ['oil', 0], ['salt', 9]]), // tea: no stock record → 0 on hand
      (id) => (id === 'rice' ? { name: 'Ponni rice 5kg', uom: 'ea' } : {}),
    );
    expect(section.levelsSet).toBe(4); // oil has no reorder point: not counted either way
    expect(section.items.map((i) => i.productId)).toEqual(['tea', 'dal', 'rice']); // 0/2, 1/4, 10/10 — salt (9 > 5) is fine
    expect(section.items[2]).toEqual({ productId: 'rice', name: 'Ponni rice 5kg', onHandMinor: 10, reorderPoint: 10, uom: 'ea' });
  });

  it('Today\'s card: the count; "no reorder levels set yet" when none is set; "not given" from an older pack', () => {
    const withList = basePack({ lowStock: known({ levelsSet: 3, items: [{ productId: 'dal', onHandMinor: 1, reorderPoint: 4 }] }) });
    expect(lowStockFigure(withList)).toMatchObject({ known: true, value: 1 });
    expect(todayFigures(input(withList))['lowStock']).toMatchObject({ known: true, value: 1 });
    expect(lowStockFigure(basePack({ lowStock: known({ levelsSet: 0, items: [] }) }))).toEqual({ known: false, noLevels: true, why: 'no reorder levels set yet', whyTa: expect.stringMatching(/[஀-௿]/) });
    expect(lowStockFigure(basePack())).toMatchObject({ known: false, why: 'the store computer has not been given a low-stock list' });
    expect(lowStockListOf(basePack({ lowStock: known({ levelsSet: 'x', items: [] } as never) }))).toBeUndefined(); // unreadable is not "none"
  });
});

describe('2 · the box remembers each day\'s figures, append-only', () => {
  const rec = (figure: 'purchaseOrdersOpen' | 'lowStock', tradingDay: string, value: number): TodayHistoryRecord => ({ kind: 'daily_figure', figure, tradingDay, value, at: `${tradingDay}T10:00:00.000Z` });

  it('compares with the LAST figure of the most recent earlier day it saw — and says null when it saw none', () => {
    const records = [rec('purchaseOrdersOpen', '2026-11-15', 9), rec('purchaseOrdersOpen', '2026-11-17', 4), rec('purchaseOrdersOpen', '2026-11-17', 6), rec('purchaseOrdersOpen', DAY, 7)];
    expect(previousFigure(records, 'purchaseOrdersOpen', DAY)).toEqual({ tradingDay: '2026-11-17', value: 6 });
    expect(previousFigure(records, 'lowStock', DAY)).toBeNull();
    const board = todayBoard(input(basePack(), { todayHistory: records }));
    expect(board.dailyPrevious).toEqual({ purchaseOrdersOpen: { tradingDay: '2026-11-17', value: 6 }, lowStock: null });
    expect(todayBoard(input(basePack())).dailyPrevious).toBeUndefined(); // a box that keeps no history: no comparison claimed
  });

  it('writes a figure only when it is new today or has changed — never rewrites one', () => {
    const held = [rec('purchaseOrdersOpen', DAY, 5)];
    expect(figuresToRecord(held, DAY, { purchaseOrdersOpen: 5, lowStock: 2 }, NOW)).toEqual([{ kind: 'daily_figure', figure: 'lowStock', tradingDay: DAY, value: 2, at: NOW }]);
    expect(figuresToRecord(held, DAY, { purchaseOrdersOpen: 6 }, NOW)).toHaveLength(1);
    expect(figuresToRecord(held, DAY, {}, NOW)).toEqual([]); // a figure not known is not written as anything
    expect(dailyFiguresOf({ purchaseOrdersOpen: { known: true, value: 3 }, lowStock: { known: false, why: 'x' } })).toEqual({ purchaseOrdersOpen: 3 });
  });

  it('keeps the history on the disk: re-opened, it reads back what it wrote, and an unknown record is counted, not dropped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'b15-history-'));
    try {
      const first = await openTodayHistory({ dataDir: dir, capacityBytes: 1_000_000 });
      await first.observe('2026-11-17', { purchaseOrdersOpen: 4, lowStock: 2 }, '2026-11-17T10:00:00.000Z');
      await first.observe('2026-11-17', { purchaseOrdersOpen: 4, lowStock: 2 }, '2026-11-17T10:05:00.000Z'); // unchanged: nothing written
      await first.notePriceChanges([{ kind: 'price_change', productId: 'rice', fromMinor: 50_000, toMinor: 52_000, packVersion: 7, at: '2026-11-17T11:00:00.000Z' }]);
      await first.log.append(JSON.stringify({ kind: 'something_else' }));
      await first.log.close();
      const again = await openTodayHistory({ dataDir: dir, capacityBytes: 1_000_000 });
      expect(again.records()).toHaveLength(3);
      expect(again.unreadable()).toBe(1);
      expect(previousFigure(again.records(), 'lowStock', DAY)).toEqual({ tradingDay: '2026-11-17', value: 2 });
      await again.log.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('sees a price change between the catalogue it held and the one it adopted — none on the very first catalogue', () => {
    const before = [{ productId: 'rice', unitPriceMinor: 50_000 }, { productId: 'dal', unitPriceMinor: 12_000 }];
    const after = { version: 8, products: [{ productId: 'rice', unitPriceMinor: 52_000, name: 'Ponni rice 5kg' }, { productId: 'dal', unitPriceMinor: 12_000 }, { productId: 'new', unitPriceMinor: 100 }] };
    expect(priceChangesBetween(before, after, NOW)).toEqual([{ kind: 'price_change', productId: 'rice', fromMinor: 50_000, toMinor: 52_000, packVersion: 8, at: NOW, name: 'Ponni rice 5kg' }]);
    expect(priceChangesBetween(undefined, after, NOW)).toEqual([]);
    expect(readHistoryRecord({ kind: 'daily_figure', figure: 'lowStock', tradingDay: 'today', value: 1, at: NOW })).toBeUndefined();
  });
});

describe('3 · Recent activity is the store\'s day, from records', () => {
  it('lists bills, deliveries booked in, approvals decided, write-offs and price changes — newest first, today only', () => {
    const sale: LoggedSale = { id: 's1', number: 'B-101', laneId: 'lane-1', cashierId: 'u', tradingDay: DAY, total: 45_000, committedAt: '2026-11-18T04:00:00.000Z' } as LoggedSale;
    const pack = basePack({
      products: known([{ productId: 'milk', name: 'Aavin milk 500ml' }] as never),
      wasteWriteOffs: known([
        { id: 'wo-1', productId: 'milk', valueMinor: 2_400, requiredApproval: true, at: '2026-11-18T05:00:00.000Z' },
        { id: 'wo-old', productId: 'milk', valueMinor: 100, requiredApproval: false, at: '2026-11-16T05:00:00.000Z' }, // not today
      ]),
    });
    const rows = recentActivity(input(pack, {
      sales: [sale],
      boxWork: [
        { type: 'ApprovalDecided', occurredAt: '2026-11-18T06:00:00.000Z', sent: false, payload: { id: 'ap-1', subjectType: 'price_change', subjectRef: 'PC-9', status: 'approved', value: { minor: 1_000, currency: 'INR' } } },
        { type: 'GoodsReceived', occurredAt: '2026-11-18T07:00:00.000Z', sent: true, payload: { grnId: 'GRN-5', number: 'GRN-5', poId: 'PO-3', receivedAt: '2026-11-18T07:00:00.000Z' } },
      ],
      todayHistory: [{ kind: 'price_change', productId: 'milk', fromMinor: 2_600, toMinor: 2_800, packVersion: 9, at: '2026-11-18T08:00:00.000Z' }],
    }));
    expect(rows.map((r) => [r.kind, r.at, r.reference, r.status, r.amountMinor])).toEqual([
      ['price_change', '13:30', 'Aavin milk 500ml', 'on_tills', 2_800],
      ['goods_receipt', '12:30', 'GRN-5', 'sent', undefined],
      ['approval', '11:30', 'PC-9', 'approved', 1_000],
      ['write_off', '10:30', 'wo-1', 'needs_approval', 2_400],
      ['sale', '09:30', 'B-101', 'completed', 45_000],
    ]);
    expect(rows[2]!.detail).toBe('price change · saved here, not yet at head office');
    expect(rows[0]!.detail).toBe('Aavin milk 500ml: ₹26.00 → ₹28.00');
  });

  it('with no records, no rows — never an invented one', () => {
    expect(recentActivity(input(basePack()))).toEqual([]);
    expect(todayBoard(input(basePack())).activity).toEqual([]);
  });
});

describe('5 · the town under the store\'s name', () => {
  it('rides the menu only when the pack carries one', () => {
    expect(branchOf(basePack())).toEqual({ name: 'SRE Hyper Market' });
    const withTown = basePack({ policies: known({ storeId: 'S1', branchId: 'S1', branchName: 'SRE Hyper Market', branchTown: ' Tiruppur ', tradingDayCutoff: '02:00' } as never) });
    expect(branchOf(withTown)).toEqual({ name: 'SRE Hyper Market', town: 'Tiruppur' });
  });

  it('is an optional store-setup question with a plain check', () => {
    const item = SETUP_CATALOGUE.find((i) => i.setting.key === SETTINGS.STORE_TOWN.key)!;
    expect(item.required).toBe(false);
    expect(item.questionTa).toMatch(/[஀-௿]/);
    expect(SETTINGS.STORE_TOWN.defaultValue).toBe('');
    expect(item.validate!('Tiruppur')).toBeNull();
    expect(item.validate!('')).toBeNull();
    expect(item.validate!('Line one\nline two')).not.toBeNull();
    expect(item.validate!('x'.repeat(61))).not.toBeNull();
  });
});

describe('6 · suppliers by name, the code only when no name exists', () => {
  it('head office sends names only, and leaves out a record with no name', () => {
    expect(supplierNamesOf([{ supplierId: 'SUP-2', name: ' Sakthi Foods ' }, { supplierId: 'SUP-1', name: 'Aachi Masala' }, { supplierId: 'SUP-3', name: '' }]))
      .toEqual([{ supplierId: 'SUP-1', name: 'Aachi Masala' }, { supplierId: 'SUP-2', name: 'Sakthi Foods' }]);
  });

  it('Receive\'s order list and the office pages\' directory name the supplier from the pack', () => {
    const pack = basePack({
      suppliers: known([{ supplierId: 'SUP-1', name: 'Aachi Masala' }]),
      warehouse: known({ bins: [], openDeliveries: [
        { poId: 'PO-1', number: 'PO-1', supplierId: 'SUP-1', deliverToLocationId: 'S1', grnId: 'G1', ordered: [] },
        { poId: 'PO-2', number: 'PO-2', supplierId: 'SUP-9', deliverToLocationId: 'S1', grnId: 'G2', ordered: [] },
      ] } as never),
    });
    const orders = receivingAidsFor(input(pack))['openDeliveries'] as { supplierId: string; supplierName?: string }[];
    expect(orders.map((o) => o.supplierName ?? o.supplierId)).toEqual(['Aachi Masala', 'SUP-9']);
    expect(packSupplierNames(pack).get('SUP-1')).toBe('Aachi Masala');
    expect(directoryPayload(pack, null).suppliers).toEqual([{ id: 'SUP-1', name: 'Aachi Masala' }]);
    expect(directoryPayload(pack, null).known.suppliers).toBe(true);
  });
});
