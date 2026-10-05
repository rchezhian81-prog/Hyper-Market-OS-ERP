import { describe, it, expect } from 'vitest';
import { todayFigures, managerPayload, type ScreenInput } from '../../edge/store-edge/src/screen-data';
import { emptyPack, known, type StorePack } from '../../edge/store-edge/src/store-pack';
import { SyncOutbox } from '../../packages/sync/src/index';

/**
 * **The Today page's figures come from the pack and this box's own log, or say they are not known (UX-2b · OB-15 ·
 * OB-16 · M02 · M29 · P-03 · P-08).** The command centre of the owner's composition shows sales today, purchase orders
 * open, receipts, counts awaiting approval, floor indents, expiry and recalls, the checklist and the day's deliveries.
 * This pins the rule that makes it honest: a section the box has not been given is `known: false` WITH the reason,
 * never a zero; a figure the box can compute is computed the same way every time; and the manager payload carries
 * them, so a screen reload shows the day as it now is.
 */

const DAY = '2026-10-05';
const input = (pack: StorePack, sales: ScreenInput['sales'] = []): ScreenInput =>
  ({ pack, sales, unreadableRecords: 0, outbox: new SyncOutbox(), now: `${DAY}T09:00:00.000Z`, tradingDay: DAY }) as unknown as ScreenInput;
const bare = (): StorePack => emptyPack('this test pulled nothing');

describe('a box given nothing says so for every figure — never a zero', () => {
  it('every figure but the takings is not known, each with the register it lacks', () => {
    const figures = todayFigures(input(bare()));
    expect(figures['salesToday']).toEqual({ known: true, value: 0, unit: 'inr', note: '0 sales on this box' });
    for (const [key, what] of Object.entries({
      purchaseOrdersOpen: 'the purchase orders', receiptsRecorded: 'the goods receipts', indentsOpen: 'the floor indents', countsAwaitingApproval: 'the stock counts',
      expiringSoon: 'the batch register', recallsOpen: 'the recall notices', checklistOpen: 'the day\'s checklist', deliveriesToday: 'the delivery slots',
    })) {
      expect(figures[key], key).toEqual({ known: false, why: `the store computer has not been given ${what}` });
    }
  });

  it('the manager payload carries them under `today`', () => {
    const payload = managerPayload(input(bare()));
    expect((payload['today'] as Record<string, { known: boolean }>)['purchaseOrdersOpen']?.known).toBe(false);
    expect((payload['today'] as Record<string, { known: boolean }>)['salesToday']?.known).toBe(true);
  });
});

describe('the takings are this box\'s own log for the trading day', () => {
  it('sums today\'s totals, counts the sales, and names the undated ones as out of the figures', () => {
    const sales = [
      { id: 's1', tradingDay: DAY, total: 12_050 }, { id: 's2', tradingDay: DAY, total: 7_950 },
      { id: 's3', tradingDay: '2026-10-04', total: 99_999 }, { id: 's4', total: 500 },
    ] as unknown as ScreenInput['sales'];
    expect(todayFigures(input(bare(), sales))['salesToday']).toEqual({ known: true, value: 20_000, unit: 'inr', note: '2 sales on this box · 1 undated, in nobody\'s figures' });
    expect(todayFigures(input(bare(), [{ id: 's1', tradingDay: DAY, total: 100 }] as unknown as ScreenInput['sales']))['salesToday']).toMatchObject({ value: 100, note: '1 sale on this box' });
  });
});

describe('the purchase-to-shelf figures', () => {
  const orders = known([
    { poId: 'po-1', supplierId: 's', lines: [{ productId: 'rice', qty: 10, unitMinor: 5000 }] },
    { poId: 'po-2', supplierId: 's', lines: [{ productId: 'oil', qty: 6, unitMinor: 9000 }, { productId: 'soap', qty: 2, unitMinor: 2000 }] },
    { poId: 'po-3', supplierId: 's', lines: [{ productId: 'dal', qty: 4, unitMinor: 7000 }] },
  ]);
  it('a purchase order is open while any line still awaits goods; receipts close it line by line', () => {
    const receipts = known([{ poId: 'po-1', lines: [{ productId: 'rice', qty: 10 }] }, { poId: 'po-2', lines: [{ productId: 'oil', qty: 6 }] }]);
    const figures = todayFigures(input({ ...bare(), purchaseOrders: orders, receipts }));
    expect(figures['purchaseOrdersOpen']).toEqual({ known: true, value: 2, note: 'of 3 on the box, still awaiting goods' }); // po-2 (soap) and po-3
    expect(figures['receiptsRecorded']).toEqual({ known: true, value: 2, note: 'against open orders' });
  });
  it('without the receipts every order counts as open — and the note says so', () => {
    expect(todayFigures(input({ ...bare(), purchaseOrders: orders }))['purchaseOrdersOpen']).toEqual({ known: true, value: 3, note: 'receipts not given — every order counted as open' });
  });
  it('indents: open unless their state says finished; counts: awaiting while nobody has approved', () => {
    const pack: StorePack = {
      ...bare(),
      floorIndents: known({ asAt: `${DAY}T08:00:00Z`, indents: [{ indentId: 'i1', state: 'requested' }, { indentId: 'i2', state: 'Received' }, { indentId: 'i3', state: 'issued' }, { indentId: 'i4', state: 'cancelled' }] }),
      countsQueue: known([{ countId: 'c1', approvedBy: null, status: 'posted' }, { countId: 'c2', approvedBy: 'u-mgr', status: 'approved' }, { countId: 'c3', status: 'pending' }, 'junk']),
    };
    const figures = todayFigures(input(pack));
    expect(figures['indentsOpen']).toEqual({ known: true, value: 2, note: 'shelf requests the back store has not finished' });
    expect(figures['countsAwaitingApproval']).toEqual({ known: true, value: 2, note: 'of 3 counted' });
  });
});

describe('food safety, the checklist and the day\'s deliveries', () => {
  it('expiring soon counts dated batches inside the policy window; undated batch records are not known, not zero', () => {
    const policy = known({ nearExpiryDays: 7 }) as StorePack['expiryPolicy'];
    const dated = known([{ batchId: 'b1', expiresOn: '2026-10-08' }, { batchId: 'b2', expiryDate: '2026-10-30' }, { batchId: 'b3', bestBefore: '2026-10-04T00:00:00Z' }, { batchId: 'b4' }]);
    expect(todayFigures(input({ ...bare(), batches: dated, expiryPolicy: policy }))['expiringSoon']).toEqual({ known: true, value: 2, note: 'within 7 days, of 4 batches' }); // b1 (3 days) and b3 (already past)
    expect(todayFigures(input({ ...bare(), batches: known([{ batchId: 'x' }]), expiryPolicy: policy }))['expiringSoon']).toEqual({ known: false, why: 'the batch records carry no expiry date' });
    expect(todayFigures(input({ ...bare(), batches: dated }))['expiringSoon']).toEqual({ known: false, why: 'the store computer has not been given the expiry policy' });
    expect(todayFigures(input({ ...bare(), batches: known([]), expiryPolicy: policy }))['expiringSoon']).toEqual({ known: true, value: 0, note: 'within 7 days, of 0 batches' });
  });
  it('recalls are counted; the checklist says what still holds the day close; deliveries are today\'s slots only', () => {
    const pack: StorePack = {
      ...bare(),
      recalls: known([{ recallId: 'r1' }]),
      checklist: known([
        { itemId: 'a', description: 'Open the safe', done: true, blocking: true },
        { itemId: 'b', description: 'Count float', done: false, blocking: true },
        { itemId: 'c', description: 'Water the plants', done: false, blocking: false },
      ]),
      deliveries: known([
        { orderId: 'o1', slotId: 's', slotStartsAt: `${DAY}T10:00:00+05:30`, slotEndsAt: `${DAY}T12:00:00+05:30`, area: 'A', codMinor: 0 },
        { orderId: 'o2', slotId: 's', slotStartsAt: '2026-10-06T10:00:00+05:30', slotEndsAt: '2026-10-06T12:00:00+05:30', area: 'A', codMinor: 0 },
      ]),
    };
    const figures = todayFigures(input(pack));
    expect(figures['recallsOpen']).toEqual({ known: true, value: 1, note: 'recall notices on the box' });
    expect(figures['checklistOpen']).toEqual({ known: true, value: 2, note: '1 must be done before the day closes' });
    expect(figures['deliveriesToday']).toEqual({ known: true, value: 1, note: 'customer deliveries in today\'s slots' });
    expect(todayFigures(input({ ...bare(), checklist: known([{ itemId: 'c', description: 'x', done: false, blocking: false }]) }))['checklistOpen']).toMatchObject({ value: 1, note: 'none holds the day close' });
  });
});
