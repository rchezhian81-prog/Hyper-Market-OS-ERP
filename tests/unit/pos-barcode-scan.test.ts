import { describe, it, expect } from 'vitest';
import { PosSession, taxRateFromPercent, createPosView, type PosView } from '../../apps/pos/src/index';
import { CatalogueCache, RecalledItemError, UnknownBarcodeError } from '../../packages/catalogue/src/index';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';

// End to end at the lane: scan a barcode → the local catalogue prices it → the line
// lands on the bill → cash completes locally. No network anywhere (hard rule #1).

const AT = '2026-08-02T12:00:00Z';

const CATALOGUE = new CatalogueCache({
  tenantId: 't1',
  version: 3,
  builtAt: '2026-08-02T06:00:00Z',
  products: [
    { productId: 'p1', sku: 'RICE1', name: 'Rice 1kg', baseUom: 'ea', unitPriceMinor: 100_00, taxBps: 1800, status: 'active' },
    { productId: 'p2', sku: '123456', name: 'Tomato', baseUom: 'kg', unitPriceMinor: 80_00, taxBps: 0, status: 'active' },
    { productId: 'p3', sku: 'BEER', name: 'Beer', baseUom: 'ea', unitPriceMinor: 200_00, taxBps: 1800, status: 'active', regulatedFlags: { minimumAge: 21 } },
    { productId: 'p4', sku: 'BAD', name: 'Recalled Item', baseUom: 'ea', unitPriceMinor: 50_00, taxBps: 1800, status: 'active', recallBlock: true },
  ],
  barcodes: [
    { code: '8901234567890', productId: 'p1', kind: 'standard' },
    { code: '8901234500003', productId: 'p3', kind: 'standard' },
    { code: '8901234500005', productId: 'p4', kind: 'standard' },
  ],
  embeddedRules: [
    { prefix: '2', itemStart: 1, itemLength: 6, valueStart: 7, valueLength: 5, valueKind: 'weight' },
  ],
});

function newLane(): { view: PosView; ledger: Ledger; outbox: SyncOutbox } {
  const ledger = new Ledger(new InMemoryLedgerStore());
  const outbox = new SyncOutbox();
  const session = new PosSession(
    { laneId: 'lane-1', cashierId: 'clerk-1', tradingDay: '2026-08-02', currency: 'INR', defaultTaxRate: taxRateFromPercent(18) },
    ledger,
    outbox,
      // A session with nowhere to write is a lane that must not take payment.
      () => Promise.resolve({
        committed: true as const, durable: true as const,
        detail: 'test double', laneMessage: 'Sale complete.',
      }),
    );
  session.setNow(AT);
  return { view: createPosView(session, 'INR', CATALOGUE), ledger, outbox };
}

describe('POS barcode scanning', () => {
  it('scans a barcode and prices the line from the catalogue', () => {
    const { view } = newLane();
    const outcome = view.scanBarcode('8901234567890');
    expect(outcome.description).toBe('Rice 1kg');
    expect(outcome.qty).toBe(1);
    expect(view.basket()).toHaveLength(1);
    expect(view.payableMinor()).toBe(118_00); // ₹100 + 18% from the product's tax class
  });

  it('scans a weighed item from an embedded barcode and prices it exactly', () => {
    const { view } = newLane();
    // 2 | 123456 | 01234 | C → 1.234 kg of Tomato at ₹80/kg (tax-free class)
    const outcome = view.scanBarcode('2123456012349');
    expect(outcome.description).toBe('Tomato');
    expect(outcome.qty).toBe(1234); // grams
    expect(view.payableMinor()).toBe(98_72); // 1.234 × ₹80, exact
  });

  it('flags an age-restricted item for the lane to prompt', () => {
    const { view } = newLane();
    expect(view.scanBarcode('8901234500003').requiresAgeCheck).toBe(true);
  });

  it('refuses a recalled item at the scan — even offline', () => {
    const { view } = newLane();
    expect(() => view.scanBarcode('8901234500005')).toThrow(RecalledItemError);
    expect(view.basket()).toHaveLength(0); // nothing added to the bill
  });

  it('refuses an unknown barcode without touching the bill', () => {
    const { view } = newLane();
    expect(() => view.scanBarcode('0000000000000')).toThrow(UnknownBarcodeError);
    expect(view.basket()).toHaveLength(0);
  });

  it('completes a scanned basket with cash, locally', async () => {
    const { view, ledger, outbox } = newLane();
    view.scanBarcode('8901234567890');
    view.scanBarcode('2123456012349');
    expect(view.payableMinor()).toBe(216_72); // ₹118.00 + ₹98.72

    const receipt = await view.tenderCash('sale-1', 'S-0001', AT);
    expect(receipt).toBe('S-0001');
    expect(ledger.entries()).toHaveLength(2); // both lines moved stock on the lane
    expect(outbox.unsentCount()).toBe(1); // one sale queued for sync
  });

  it('reports when a lane has no catalogue loaded', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const session = new PosSession(
      { laneId: 'lane-2', cashierId: 'c', tradingDay: '2026-08-02', currency: 'INR', defaultTaxRate: taxRateFromPercent(18) },
      ledger,
      new SyncOutbox(),
      // A session with nowhere to write is a lane that must not take payment.
      () => Promise.resolve({
        committed: true as const, durable: true as const,
        detail: 'test double', laneMessage: 'Sale complete.',
      }),
    );
    const view = createPosView(session); // no catalogue
    expect(view.hasCatalogue()).toBe(false);
    expect(() => view.scanBarcode('8901234567890')).toThrow(/No catalogue/);
  });
});
