import { describe, it, expect } from 'vitest';
import {
  PosSession, taxRateFromPercent, createPosView, ScaleLabelRefusedError, MeasuredLineQuantityRefusedError, type PosView,
} from '../../apps/pos/src/index';
import { CatalogueCache } from '../../packages/catalogue/src/index';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';

// Round B (PR #852) follow-ups at the till, OB-302 "never key a weight" · B5 · OB-31:
//  1. A scale label whose barcode carries only a PRICE, for a kg item, rang as ONE gram: a ₹765.00 pack of mutton at
//     ₹900/kg rang ₹0.76 — the customer under-charged, the stock ledger told 1 g left. Now refused by name (English and
//     Tamil), nothing added; a label carrying the WEIGHT still rings exactly, offline (no network call anywhere here).
//  2. A weight label on a product sold by the piece rang its grams as that many pieces (850 g → 850 items). Refused.
//  3. The cashier's Qty keypad on a weighed line took the number as grams ("2" for 2 kg rang 2 g) — a weight typed by
//     hand, which OB-302 rules out. Now refused by name; the line keeps the label's weight. A count line still changes.
// Synthetic data only.

const AT = '2026-10-31T06:00:00Z';
const PRICE_RULE = { prefix: '22', itemStart: 2, itemLength: 5, valueStart: 7, valueLength: 5, valueKind: 'price' as const };
const WEIGHT_RULE = { prefix: '21', itemStart: 2, itemLength: 5, valueStart: 7, valueLength: 5, valueKind: 'weight' as const };

const CATALOGUE = new CatalogueCache({
  tenantId: 't1', version: 1, builtAt: '2026-10-31T00:00:00Z',
  products: [
    { productId: 'p-mutton', sku: '10023', name: 'Mutton curry cut', baseUom: 'kg', unitPriceMinor: 900_00, taxBps: 0, status: 'active' },
    { productId: 'p-paneer', sku: '10024', name: 'Paneer (loose)', baseUom: 'g', unitPriceMinor: 40, taxBps: 0, status: 'active' },
    { productId: 'p-cake', sku: '10025', name: 'Plum cake slice', baseUom: 'ea', unitPriceMinor: 30_00, taxBps: 0, status: 'active' },
    { productId: 'p-soap', sku: '10026', name: 'Bath soap', baseUom: 'ea', unitPriceMinor: 35_00, taxBps: 0, status: 'active' },
  ],
  barcodes: [{ code: '8900000000261', productId: 'p-soap', kind: 'standard' }],
  embeddedRules: [PRICE_RULE, WEIGHT_RULE],
});

function lane(): PosView {
  const session = new PosSession(
    { laneId: 'lane-1', cashierId: 'clerk-1', tradingDay: '2026-10-31', currency: 'INR', defaultTaxRate: taxRateFromPercent(0),
      // A lane whose scale stamp is current — so every refusal below is the label or the keypad, never the stamp rule.
      laneScales: { known: true, scales: [{ assetId: 'SCALE-1', reverificationDueOn: '2099-12-31' }] } },
    new Ledger(new InMemoryLedgerStore()), new SyncOutbox(),
    () => Promise.resolve({ committed: true as const, durable: true as const, detail: 'test double', laneMessage: 'Sale complete.' }),
  );
  session.setNow(AT);
  return createPosView(session, 'INR', CATALOGUE);
}

function thrown<T>(fn: () => unknown, type: new (...a: never[]) => T): T {
  try { fn(); } catch (e) { expect(e).toBeInstanceOf(type); return e as T; }
  throw new Error('expected a refusal');
}

describe('a price-only scale label never rings a weighed item as one gram (OB-302 · B5)', () => {
  it('a kg item: refused by name in English and Tamil, nothing on the bill (it rang ₹765.00 of mutton as ₹0.76)', () => {
    const view = lane();
    // 22 | 10023 | 76500 | 0 → ₹765.00 printed by the scale for mutton sold per kg
    const e = thrown(() => view.scanBarcode('2210023765000'), ScaleLabelRefusedError);
    expect(e.reason).toBe('price_only_label_for_measured_item');
    expect(e.laneMessage).toContain('Mutton curry cut is sold by kg');
    expect(e.laneMessage).toContain('carries only a price, not the weight');
    expect(e.laneMessage).toContain('A weight is never typed in');
    expect(e.laneMessageTa).toContain('பில்லில் சேர்க்கப்படவில்லை');
    expect(view.basket()).toHaveLength(0);
    expect(view.payableMinor()).toBe(0);
  });

  it('a g item too: the price would be right, but the bill and the stock would say 1 g of an 850 g pack — refused', () => {
    expect(thrown(() => lane().scanBarcode('2210024340000'), ScaleLabelRefusedError).reason).toBe('price_only_label_for_measured_item');
  });

  it('a price label for an item sold by the piece still rings one at the printed price (a cafe slice)', () => {
    const view = lane();
    expect(view.scanBarcode('2210025045000').qty).toBe(1);
    expect(view.payableMinor()).toBe(45_00);
  });

  it('the WEIGHT label for the same mutton rings exactly: 0.850 kg × ₹900 = ₹765.00', () => {
    const view = lane();
    expect(view.scanBarcode('2110023008500').qty).toBe(850);
    expect(view.basket()[0]?.qtyText).toBe('0.850 kg');
    expect(view.payableMinor()).toBe(765_00);
  });

  it('a weight label on an item sold by the piece is refused — 850 g never rings as 850 soaps', () => {
    const view = lane();
    const e = thrown(() => view.scanBarcode('2110026008500'), ScaleLabelRefusedError);
    expect(e.reason).toBe('weight_label_for_counted_item');
    expect(e.laneMessage).toContain('Bath soap is sold by the piece');
    expect(e.laneMessageTa.length).toBeGreaterThan(0);
    expect(view.basket()).toHaveLength(0);
  });
});

describe('the Qty keypad never keys a weight (OB-302 "never key a weight")', () => {
  it('on a weighed line it is refused by name, in English and Tamil, and the line keeps the label\'s weight and price', () => {
    const view = lane();
    const line = view.scanBarcode('2110023008500');
    const e = thrown(() => view.keyQuantity(line.lineId, 2), MeasuredLineQuantityRefusedError);
    expect(e.laneMessage).toContain('Mutton curry cut is sold by kg');
    expect(e.laneMessage).toContain('cannot be typed in');
    expect(e.laneMessage).toContain('weigh it again and scan the new label');
    expect(e.laneMessageTa).toContain('கையால் உள்ளிட முடியாது');
    expect(view.basket()[0]?.qty).toBe(850);
    expect(view.payableMinor()).toBe(765_00); // not ₹1.80 for "2" taken as 2 g
  });

  it('on a count line it changes the quantity exactly as before', () => {
    const view = lane();
    const line = view.scanBarcode('8900000000261');
    view.keyQuantity(line.lineId, 3);
    expect(view.basket()[0]?.qty).toBe(3);
    expect(view.payableMinor()).toBe(105_00);
  });
});
