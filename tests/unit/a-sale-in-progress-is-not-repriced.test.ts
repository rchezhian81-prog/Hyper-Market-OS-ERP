import { describe, it, expect } from 'vitest';
import { PosSession, taxRateFromPercent, createPosView } from '../../apps/pos/src/index';
import { CatalogueCache, type CatalogueSnapshot } from '../../packages/catalogue/src/index';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';

/**
 * **M05-FR-01 (round 6 re-audit) — a sale in progress is not repriced.**
 *
 * A price or pack change can reach the lane while a customer's basket is open (a newer signed pack). The lines already
 * scanned keep the price they were scanned at — the customer is charged what the screen showed them — and only items
 * scanned AFTER the change take the new price. This held by design (each line freezes its price when scanned) but no test
 * said so. Synthetic data only; no network anywhere (hard rule #1).
 */

const AT = '2026-08-02T12:00:00Z';

const pack = (version: number, riceMinor: number, oilName: string, oilMinor: number): CatalogueSnapshot => ({
  tenantId: 't1',
  version,
  builtAt: '2026-08-02T06:00:00Z',
  products: [
    { productId: 'p1', sku: 'RICE1', name: 'Rice 1kg', baseUom: 'ea', unitPriceMinor: riceMinor, taxBps: 500, status: 'active' },
    { productId: 'p5', sku: 'OIL1', name: oilName, baseUom: 'ea', unitPriceMinor: oilMinor, taxBps: 500, status: 'active' },
  ],
  barcodes: [
    { code: '8901234567890', productId: 'p1', kind: 'standard' },
    { code: '8901234500012', productId: 'p5', kind: 'standard' },
  ],
  embeddedRules: [],
});

describe('M05-FR-01: a sale in progress is not repriced when a new price or pack arrives', () => {
  it('lines already scanned keep their scanned price; scans after the change take the new price; the bill is charged exactly that', async () => {
    const written: unknown[] = [];
    const session = new PosSession(
      { laneId: 'lane-1', cashierId: 'clerk-1', tradingDay: '2026-08-02', currency: 'INR', defaultTaxRate: taxRateFromPercent(5) },
      new Ledger(new InMemoryLedgerStore()),
      new SyncOutbox(),
      (_id, record) => { written.push(record); return Promise.resolve({ committed: true as const, durable: true as const, detail: 'test double', laneMessage: 'Sale complete.' }); },
    );
    session.setNow(AT);

    // Pack v1: rice ₹100.00, oil (1 L) ₹150.00. Two items scanned.
    const before = createPosView(session, 'INR', new CatalogueCache(pack(1, 100_00, 'Oil 1L', 150_00)));
    before.scanBarcode('8901234567890');
    before.scanBarcode('8901234500012');
    expect(before.payableMinor()).toBe(250_00);

    // Mid-basket a newer pack lands: rice is now ₹120.00, and the oil barcode now names a 1 L pack at ₹165.00.
    const after = createPosView(session, 'INR', new CatalogueCache(pack(2, 120_00, 'Oil 1L (new pack)', 165_00)));
    // Nothing already on the bill moved.
    expect(after.basket().map((l) => [l.productId, l.description, l.unitPriceMinor])).toEqual([
      ['p1', 'Rice 1kg', 100_00],
      ['p5', 'Oil 1L', 150_00],
    ]);
    expect(after.payableMinor()).toBe(250_00);

    // The next scans take the new price and pack.
    after.scanBarcode('8901234567890');
    after.scanBarcode('8901234500012');
    expect(after.basket().map((l) => [l.productId, l.description, l.unitPriceMinor])).toEqual([
      ['p1', 'Rice 1kg', 100_00],
      ['p5', 'Oil 1L', 150_00],
      ['p1', 'Rice 1kg', 120_00],
      ['p5', 'Oil 1L (new pack)', 165_00],
    ]);
    expect(after.payableMinor()).toBe(535_00);

    // The committed sale carries exactly those prices — nothing re-priced at payment.
    await after.tenderCash('sale-1', 'S-0001', AT);
    expect(written).toHaveLength(1);
    const sale = (typeof written[0] === 'string' ? JSON.parse(written[0]) : written[0]) as { lines: { productId: string; unitPriceMinor: number }[]; total: number };
    expect(sale.lines.map((l) => [l.productId, l.unitPriceMinor])).toEqual([['p1', 100_00], ['p5', 150_00], ['p1', 120_00], ['p5', 165_00]]);
    expect(sale.total).toBe(535_00);
  });
});
