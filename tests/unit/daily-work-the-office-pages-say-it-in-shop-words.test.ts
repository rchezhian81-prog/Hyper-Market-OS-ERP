import { describe, it, expect } from 'vitest';
import { createStockHealthSession, type StockHealthData } from '../../apps/web-erp/src/inventory-health-session';
import { createGoodsReceiptSession, type GoodsReceiptData, type GrnRecordView } from '../../apps/web-erp/src/goods-receipt-session';
import { createCashOfficeSession, type CashOverShortData } from '../../apps/web-erp/src/cash-office-session';
import { overShortStillOpen, type LiveCounts } from '../../apps/web-erp/src/today-live-counts';
import { boxClockView } from '../../apps/web-erp/src/box-clock-view';
import { quantityInWords } from '../../apps/web-erp/src/quantity-words';

// The daily-work walkthrough (docs/registers/daily-work-defects.md, 15 Nov 2026) found office pages saying things in
// computer words or the wrong scale. Each block is one defect, as the person on that page reads it.

describe('a quantity in the shop\'s words (OB-31: a count for pieces, grams for kg — never ÷100)', () => {
  it('pieces are the count itself; kilos are grams ÷ 1000; the unit is a plain word in English and Tamil', () => {
    expect(quantityInWords(-4, 'ea')).toBe('−4 pieces');
    expect(quantityInWords(1, 'EA')).toBe('1 piece');
    expect(quantityInWords(-1250, 'kg')).toBe('−1.25 kg');
    expect(quantityInWords(500, 'ml')).toBe('500 ml');
    expect(quantityInWords(-4, 'ea', 'ta')).toBe('−4 எண்ணிக்கை');
    expect(quantityInWords(2500, 'kg', 'ta')).toBe('2.5 கிலோ');
  });
});

describe('D-016: Stock health shows −4 biscuits as −4, loose rice −1.250 kg as −1.25 kg, by the item\'s name', () => {
  const data: StockHealthData = {
    negative: [
      { productId: 'prod-biscuit', locationId: 'S1', onHandMinor: -4, detail: '', ownerAction: '', name: 'Marie biscuits 200 g', uom: 'ea' },
      { productId: 'prod-rice', locationId: 'S1', onHandMinor: -1250, detail: '', ownerAction: '', name: 'Loose ponni rice', uom: 'kg' },
      { productId: 'prod-curd', locationId: 'S1', onHandMinor: -1, detail: '', ownerAction: '' },
    ],
  };
  const view = (lang: 'en' | 'ta') => createStockHealthSession({ userId: 'u-mgr' }, { snapshot: () => data, mayRead: () => true }).view(lang);

  it('each negative row carries the name head office gave and the quantity in its unit', () => {
    const rows = view('en').signals.filter((s) => s.kind === 'negative_stock');
    expect(rows.map((r) => [r.productName, r.quantity])).toEqual([
      ['Loose ponni rice', '−1.25 kg'],
      ['Marie biscuits 200 g', '−4 pieces'],
      [null, '−1 piece'], // no unit said → a count of pieces, never ÷100
    ]);
    expect(view('ta').signals.find((s) => s.productId === 'prod-biscuit')?.quantity).toBe('−4 எண்ணிக்கை');
  });
});

describe('D-037: Goods receipt review says "4 pieces short", item by item', () => {
  const receipt: GrnRecordView = {
    grnId: 'g1', number: 'GRN-1', poId: 'po-1', warehouseId: 'pilot-demo-wh', receivedBy: 'u-recv', receivedAt: '2026-11-15T10:00:00.000Z',
    requiresApproval: false, discrepancyValueMinor: 4000, currency: 'INR', sellableMinor: 64, quarantinedMinor: 0, rejectedMinor: 0,
    discrepancies: [{ kind: 'short', lineId: 'l1', productId: 'prod-biscuit', productName: 'Marie biscuits 200 g', uom: 'ea', quantityMinor: 4, valueMinor: 4000, currency: 'INR', requiresApproval: false, detail: '4 ea short of the 48 ordered — claim or credit note due from the supplier' }],
    quantitiesByUom: { sellable: { ea: 64 }, quarantined: {}, rejected: {} },
    items: [
      { lineId: 'l1', productId: 'prod-biscuit', name: 'Marie biscuits 200 g', uom: 'ea', sellableMinor: 44 },
      { lineId: 'l2', productId: 'prod-oil', uom: 'ea', sellableMinor: 20 },
    ],
  };
  const data: GoodsReceiptData = { receipts: [receipt], asAt: '2026-11-15T10:05:00.000Z' };
  const present = (lang: 'en' | 'ta') => createGoodsReceiptSession({ userId: 'u-mgr' }, { snapshot: () => data, mayRead: () => true }).view(lang).receipts[0]!;

  it('the short is said with the item and its unit\'s plain word, never "4 ea"', () => {
    expect(present('en').discrepancies[0]!.detail).toBe('Marie biscuits 200 g: 4 pieces short — a claim or credit note is due from the supplier');
    expect(present('en').discrepancies[0]!.detail).not.toContain(' ea ');
    expect(present('ta').discrepancies[0]!.detail).toMatch(/^Marie biscuits 200 g: 4 எண்ணிக்கை குறைவு/);
  });

  it('"Became sellable" is per item, not biscuits and oil added into one number', () => {
    expect(present('en').sellableItems.map((i) => i.label)).toEqual(['Marie biscuits 200 g — 44 pieces', 'prod-oil — 20 pieces']);
    expect(present('en').sellableQuantity).toBe('64 pieces');
  });
});

describe('D-015: Cash over/short says the cashier\'s reason in words, not "wrong_change"', () => {
  const w: CashOverShortData = { openCount: 1, totalVarianceMinor: -13_350, open: [{ shiftId: 'sh-1', tillId: 'lane-1', cashierId: 'u-ravi', tradingDay: '2026-11-15', varianceMinor: -13_350, reasonCode: 'wrong_change' }] };
  const row = (lang: 'en' | 'ta') => createCashOfficeSession({ userId: 'u-mgr' }, { worklist: () => w, mayRead: () => true, mayReview: () => true, signOffPort: () => ({ post: async () => 'signed' as const }) }).view(lang).open[0]!;
  it('in English and Tamil; an unknown code is still words, not a code', () => {
    expect(row('en').reasonWords).toBe('Wrong change given');
    expect(row('ta').reasonWords).toBe('தவறான சில்லறை கொடுக்கப்பட்டது');
    const odd = createCashOfficeSession({ userId: 'u-mgr' }, { worklist: () => ({ ...w, open: [{ ...w.open[0]!, reasonCode: 'note_stuck_in_drawer' }] }), mayRead: () => true, mayReview: () => true, signOffPort: () => ({ post: async () => 'signed' as const }) }).view('en').open[0]!;
    expect(odd.reasonWords).toBe('Note stuck in drawer');
  });
});

describe('D-009: Today leaves out a drawer that was signed off on Cash over/short', () => {
  const box = {
    known: true as const, value: 2, note: 'lane-1 short ₹133.50; lane-2 over ₹20.00 — closed today …',
    drawers: [{ shiftId: 'sh-1', words: 'lane-1 short ₹133.50', wordsTa: 'lane-1 குறைவு ₹133.50' }, { shiftId: 'sh-2', words: 'lane-2 over ₹20.00', wordsTa: 'lane-2 கூடுதல் ₹20.00' }],
  };
  const live = (signed: LiveCounts['signedOffShifts']): LiveCounts => ({ approvals: { result: 'lost_link' }, purchaseOrders: { result: 'lost_link' }, signedOffShifts: signed });

  it('a signed-off drawer drops out; all signed off is zero; head office not read leaves the box\'s figure as it was', () => {
    const one = overShortStillOpen(box, live({ result: 'read', value: ['sh-1'] }));
    expect(one).toMatchObject({ known: true, value: 1 });
    expect(one.known && one.note).toMatch(/^lane-2 over ₹20\.00 — closed today/);
    expect(overShortStillOpen(box, live({ result: 'read', value: ['sh-1', 'sh-2'] }))).toMatchObject({ known: true, value: 0 });
    expect(overShortStillOpen(box, live({ result: 'lost_link' }))).toBe(box);
    expect(overShortStillOpen(box, null)).toBe(box);
  });
});

describe('D-028: the clock line shows only when the clock is out (or not known), in shop words', () => {
  const zone = { verdict: 'differs', needsAttention: true, staffMessage: 'This computer is set to UTC', staffMessageTa: 'UTC' };
  const inStep = { verdict: 'in_step', offsetSeconds: 0, lastCheckedAt: '2026-11-15T17:17:11.002Z', needsAttention: false, staffMessage: 'This store computer\'s clock agrees with head office (0 seconds BEHIND head office, ± 1 s, checked 2026-11-15T17:17:11.002Z).', staffMessageTa: 'ஒத்துப்போகிறது' };
  it('in step: no clock line even while the strip is up for the time zone', () => {
    const v = boxClockView('en', inStep, [], zone, null);
    expect(v.show).toBe(true);
    expect(v.words).toBe('');
  });
  it('out, or not known: the clock line stays, its moments in the shop\'s words', () => {
    const out = { verdict: 'flag_bills', offsetSeconds: 360, lastCheckedAt: '2026-11-15T17:00:00.000Z', needsAttention: true, staffMessage: 'This store computer\'s clock was 6 minutes away from head office when last checked (2026-11-15T17:00:00.000Z).', staffMessageTa: 'x' };
    const v = boxClockView('en', out, [], null, null, () => '15 Nov, 10:30 pm');
    expect(v.words).toBe('This store computer\'s clock was 6 minutes away from head office when last checked (15 Nov, 10:30 pm).');
    const unknown = { verdict: 'not_checked', offsetSeconds: null, lastCheckedAt: null, needsAttention: false, staffMessage: 'This store computer has not compared its clock with head office since it started.', staffMessageTa: 'x' };
    expect(boxClockView('en', unknown, [], zone, null).words).toBe('This store computer has not compared its clock with head office since it started.');
  });
});
