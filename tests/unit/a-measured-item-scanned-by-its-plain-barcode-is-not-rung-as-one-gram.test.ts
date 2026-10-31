import { describe, it, expect } from 'vitest';
import { PosSession, taxRateFromPercent, createPosView, MeasuredItemNeedsLabelError, type PosView } from '../../apps/pos/src/index';
import { CatalogueCache } from '../../packages/catalogue/src/index';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';

// Screen gap audit 31 Oct 2026 (Round B): scanning a litre product's plain barcode rang "0.001 L ₹0.12" — the till took
// the plain barcode as ONE base unit (1 ml, or 1 g for a kg product). OB-302 settles the rule: a weight is never keyed,
// the item is weighed on a verified scale and the scale's label is scanned (the self-checkout lane already refuses it).
// So the till refuses a measured product read from a code that carries no amount, by name, in English and Tamil, and
// adds nothing. A scale label (weight inside the code) still rings exactly; a packed item sold `ea` scans as one.
// Synthetic data only.

const AT = '2026-10-31T06:00:00Z';

const CATALOGUE = new CatalogueCache({
  tenantId: 't1', version: 1, builtAt: '2026-10-31T00:00:00Z',
  products: [
    { productId: 'p-oil-loose', sku: '000777', name: 'Sunflower oil (loose)', baseUom: 'L', unitPriceMinor: 120_00, taxBps: 500, status: 'active' },
    { productId: 'p-rice-loose', sku: '000123', name: 'Ponni rice (loose)', baseUom: 'kg', unitPriceMinor: 68_00, taxBps: 0, status: 'active' },
    { productId: 'p-oil-pouch', sku: 'OIL-1L', name: 'Sunflower oil 1L pouch', baseUom: 'ea', unitPriceMinor: 120_00, taxBps: 500, status: 'active' },
  ],
  barcodes: [
    { code: '8900000000777', productId: 'p-oil-loose', kind: 'standard' },
    { code: '8900000000123', productId: 'p-rice-loose', kind: 'standard' },
    { code: '8900000000142', productId: 'p-oil-pouch', kind: 'standard' },
  ],
  embeddedRules: [{ prefix: '2', itemStart: 1, itemLength: 6, valueStart: 7, valueLength: 5, valueKind: 'weight' }],
});

function lane(): PosView {
  const session = new PosSession(
    { laneId: 'lane-1', cashierId: 'clerk-1', tradingDay: '2026-10-31', currency: 'INR', defaultTaxRate: taxRateFromPercent(0),
      // A lane whose scale stamp is current — so the refusal below is NOT the scale rule, it is the missing amount.
      laneScales: { known: true, scales: [{ assetId: 'SCALE-1', reverificationDueOn: '2099-12-31' }] } },
    new Ledger(new InMemoryLedgerStore()), new SyncOutbox(),
    () => Promise.resolve({ committed: true as const, durable: true as const, detail: 'test double', laneMessage: 'Sale complete.' }),
  );
  session.setNow(AT);
  return createPosView(session, 'INR', CATALOGUE);
}

function refused(fn: () => unknown): MeasuredItemNeedsLabelError {
  try { fn(); } catch (e) { expect(e).toBeInstanceOf(MeasuredItemNeedsLabelError); return e as MeasuredItemNeedsLabelError; }
  throw new Error('expected the scan to be refused');
}

describe('a measured item scanned by its plain barcode is not rung as one gram or one millilitre (OB-302)', () => {
  it('a litre product: refused by name in English and Tamil, nothing on the bill (it used to ring 0.001 L at ₹0.12)', () => {
    const view = lane();
    const e = refused(() => view.scanBarcode('8900000000777'));
    expect(e.reason).toBe('measured_item_plain_barcode');
    expect(e.laneMessage).toContain('Sunflower oil (loose) is sold by volume (L)');
    expect(e.laneMessage).toContain('was not added to the bill');
    expect(e.laneMessageTa).toContain('பில்லில் சேர்க்கப்படவில்லை');
    expect(view.basket()).toHaveLength(0);
    expect(view.payableMinor()).toBe(0);
  });

  it('a kg product on a lane with a current scale stamp: refused the same way (never 1 g), with the scale-label words', () => {
    const view = lane();
    const e = refused(() => view.scanBarcode('8900000000123'));
    expect(e.laneMessage).toContain('sold by weight (kg)');
    expect(e.laneMessage).toContain("scan the scale's label");
    expect(e.laneMessage).toContain('A weight is never typed in');
    expect(view.basket()).toHaveLength(0);
  });

  it("the scale's label (weight inside the code) still rings exactly; a 1 L pouch sold by the piece scans as one", () => {
    const view = lane();
    // 2 | 000777 | 01000 | C → 1.000 L of loose oil at ₹120/L
    expect(view.scanBarcode('2000777010002').qty).toBe(1000);
    expect(view.payableMinor()).toBe(120_00);
    const pouch = view.scanBarcode('8900000000142');
    expect(pouch.qty).toBe(1);
    expect(view.basket()[1]?.qtyText).toBe('1');
    expect(view.payableMinor()).toBe(240_00);
  });
});
