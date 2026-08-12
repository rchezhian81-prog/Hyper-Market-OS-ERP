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
    expect(view.payableMinor()).toBe(236_00); // (2 × ₹100) + 18%
  });

  it('supports a weighed line via its uom', () => {
    const { view } = newView();
    view.scan({ productId: 'p2', description: 'Tomato', unitPriceMinor: 80_00, qty: 1234, uom: 'kg' });
    expect(view.payableMinor()).toBe(116_49); // 1.234 kg × ₹80 + 18%
  });

  it('changes quantity through the model', () => {
    const { view } = newView();
    view.scan({ productId: 'p1', description: 'Rice', unitPriceMinor: 100_00, qty: 1 });
    view.setQuantity(view.basket()[0]!.lineId, 3);
    expect(view.payableMinor()).toBe(354_00);
  });

  it('keeps a voided line on the bill with its reason and drops it from the total', () => {
    const { view } = newView();
    view.scan({ productId: 'p1', description: 'Rice', unitPriceMinor: 100_00, qty: 1 });
    view.scan({ productId: 'p2', description: 'Dal', unitPriceMinor: 50_00, qty: 1 });
    view.voidLine(view.basket()[1]!.lineId, 'changed mind');

    expect(view.basket()).toHaveLength(2); // still shown
    expect(view.basket()[1]?.voided).toBe(true);
    expect(view.basket()[1]?.voidReason).toBe('changed mind');
    expect(view.payableMinor()).toBe(118_00); // only the first line counts
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
});
