import { describe, it, expect } from 'vitest';
import { PosSession, taxRateFromPercent, createPosView, type PosView } from '../../apps/pos/src/index';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';
import { CatalogueCache, type CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';

// The view adapter is the surface the bundled shell attaches as window.posSession.
// It converts display primitives only — every rule stays in the tested model.

const AT = '2026-08-02T12:00:00Z';

function newView(): { view: PosView; ledger: Ledger; outbox: SyncOutbox } {
  const ledger = new Ledger(new InMemoryLedgerStore());
  const outbox = new SyncOutbox();
  const session = new PosSession(
    {
      laneId: 'lane-1',
      cashierId: 'clerk-1',
      tradingDay: '2026-08-02',
      currency: 'INR',
      defaultTaxRate: taxRateFromPercent(18),
    },
    ledger,
    outbox,
      // A session with nowhere to write is a lane that must not take payment.
      () => Promise.resolve({
        committed: true as const, durable: true as const,
        detail: 'test double', laneMessage: 'Sale complete.',
      }),
    );
  session.setNow(AT);
  return { view: createPosView(session), ledger, outbox };
}

describe('createPosView', () => {
  it('scans in display primitives and reports the payable amount in minor units', () => {
    const { view } = newView();
    view.scan({ productId: 'p1', description: 'Rice 1kg', unitPriceMinor: 100_00, qty: 2 });
    expect(view.basket()).toHaveLength(1);
    expect(view.basket()[0]?.unitPriceMinor).toBe(100_00);
    expect(view.payableMinor()).toBe(200_00); // 2 × ₹100 — the shelf price, GST inside it (A9)
  });

  it('supports a weighed line via its uom', () => {
    const { view } = newView();
    view.scan({ productId: 'p2', description: 'Tomato', unitPriceMinor: 80_00, qty: 1234, uom: 'kg' });
    expect(view.payableMinor()).toBe(98_72); // 1.234 kg × ₹80, GST inside
  });

  it('changes quantity through the model', () => {
    const { view } = newView();
    view.scan({ productId: 'p1', description: 'Rice', unitPriceMinor: 100_00, qty: 1 });
    view.setQuantity(view.basket()[0]!.lineId, 3);
    expect(view.payableMinor()).toBe(300_00);
  });

  it('keeps a voided line on the bill with its reason and drops it from the total', () => {
    const { view } = newView();
    view.scan({ productId: 'p1', description: 'Rice', unitPriceMinor: 100_00, qty: 1 });
    view.scan({ productId: 'p2', description: 'Dal', unitPriceMinor: 50_00, qty: 1 });
    view.voidLine(view.basket()[1]!.lineId, 'changed mind');

    expect(view.basket()).toHaveLength(2); // still shown
    expect(view.basket()[1]?.voided).toBe(true);
    expect(view.basket()[1]?.voidReason).toBe('changed mind');
    expect(view.payableMinor()).toBe(100_00); // only the first line counts
  });

  it('takes cash locally, returns the receipt number and queues the sale', async () => {
    const { view, ledger, outbox } = newView();
    view.scan({ productId: 'p1', description: 'Rice', unitPriceMinor: 100_00, qty: 1 });
    const receipt = await view.tenderCash('sale-1', 'S-0001', AT);

    expect(receipt).toBe('S-0001');
    expect(ledger.entries()).toHaveLength(1); // stock committed on the lane
    expect(outbox.unsentCount()).toBe(1); // queued for sync — no network call
    expect(view.syncBadge().unsentCount).toBe(1);
  });

  it('clears the basket for the next customer', async () => {
    const { view } = newView();
    view.scan({ productId: 'p1', description: 'Rice', unitPriceMinor: 100_00, qty: 1 });
    await view.tenderCash('sale-1', 'S-0001', AT);
    view.newSale();
    expect(view.basket()).toHaveLength(0);
    expect(view.payableMinor()).toBe(0);
  });

  it('freezes the scanned product\'s HSN onto the basket line, for the GST return (A5)', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const session = new PosSession(
      { laneId: 'lane-1', cashierId: 'clerk-1', tradingDay: '2026-08-02', currency: 'INR', defaultTaxRate: taxRateFromPercent(18) },
      ledger, new SyncOutbox(),
      () => Promise.resolve({ committed: true as const, durable: true as const, detail: 'ok', laneMessage: 'Sale complete.' }),
    );
    const snapshot: CatalogueSnapshot = {
      tenantId: 't1', version: 1, builtAt: AT,
      products: [{ productId: 'p1', sku: 'RICE1', name: 'Rice 1kg', baseUom: 'ea', unitPriceMinor: 100_00, taxBps: 1800, hsnCode: '1006', status: 'active' }],
      barcodes: [{ code: '890111', productId: 'p1', kind: 'standard' }],
    };
    const view = createPosView(session, 'INR', new CatalogueCache(snapshot));

    view.scanBarcode('890111');
    // The HSN off the pack is frozen on the underlying basket entry (a record only — it never blocks a scan).
    expect(session.basket()[0]!.hsnCode).toBe('1006');
    expect(session.basket()[0]!.taxRate.bps).toBe(1800);
  });

  it('resolves a product name by id for the refund screen, undefined for an unknown id', () => {
    const session = new PosSession(
      { laneId: 'lane-1', cashierId: 'clerk-1', tradingDay: '2026-08-02', currency: 'INR', defaultTaxRate: taxRateFromPercent(18) },
      new Ledger(new InMemoryLedgerStore()), new SyncOutbox(),
      () => Promise.resolve({ committed: true as const, durable: true as const, detail: 'ok', laneMessage: 'ok' }),
    );
    const snapshot: CatalogueSnapshot = {
      tenantId: 't1', version: 1, builtAt: AT,
      products: [{ productId: 'p1', sku: 'RICE1', name: 'Rice 1kg', baseUom: 'ea', unitPriceMinor: 100_00, taxBps: 1800, status: 'active' }],
      barcodes: [],
    };
    const view = createPosView(session, 'INR', new CatalogueCache(snapshot));
    expect(view.productName('p1')).toBe('Rice 1kg');
    expect(view.productName('p-unknown')).toBeUndefined();
  });

  it('has no product name without a catalogue — the refund screen then falls back to the code', () => {
    const { view } = newView(); // no catalogue loaded on this lane
    expect(view.productName('p1')).toBeUndefined();
  });
});

describe('a product with a unit the till does not know is refused at the scan, by name — never priced as ₹NaN (Stage G slice 5c)', () => {
  const snapshotWith = (baseUom: string): CatalogueSnapshot => ({
    tenantId: 't1', version: 1, builtAt: AT,
    products: [{ productId: 'p-odd', sku: 'ODD', name: 'Odd Item', baseUom, unitPriceMinor: 100_00, taxBps: 1800, status: 'active' }],
    barcodes: [{ code: '8901234500099', productId: 'p-odd', kind: 'standard' }],
  });

  it('the scan is refused with the product\'s name and the unit, and the basket stays empty and finite', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const session = new PosSession(
      { laneId: 'lane-1', cashierId: 'clerk-1', tradingDay: '2026-08-02', currency: 'INR', defaultTaxRate: taxRateFromPercent(18) },
      ledger, new SyncOutbox(),
      () => Promise.resolve({ committed: true as const, durable: true as const, detail: 'test double', laneMessage: 'Sale complete.' }),
    );
    session.setNow(AT);
    const view = createPosView(session, 'INR', new CatalogueCache(snapshotWith('bundle')));
    expect(() => view.scanBarcode('8901234500099')).toThrow('Cannot sell Odd Item: its unit "bundle" is not one this till knows.');
    expect(view.basket()).toEqual([]);
    expect(view.payableMinor()).toBe(0);
    expect(Number.isFinite(view.payableMinor())).toBe(true);
  });

  it('the same product in a known unit scans and prices', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const session = new PosSession(
      { laneId: 'lane-1', cashierId: 'clerk-1', tradingDay: '2026-08-02', currency: 'INR', defaultTaxRate: taxRateFromPercent(18) },
      ledger, new SyncOutbox(),
      () => Promise.resolve({ committed: true as const, durable: true as const, detail: 'test double', laneMessage: 'Sale complete.' }),
    );
    session.setNow(AT);
    const view = createPosView(session, 'INR', new CatalogueCache(snapshotWith('ea')));
    view.scanBarcode('8901234500099');
    expect(view.payableMinor()).toBe(100_00); // the shelf price; its 18% tax class is inside it
  });
});
