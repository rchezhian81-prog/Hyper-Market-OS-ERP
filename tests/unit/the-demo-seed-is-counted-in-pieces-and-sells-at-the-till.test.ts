import { describe, it, expect } from 'vitest';
import { PosSession, taxRateFromPercent, createPosView } from '../../apps/pos/src/index';
import { CatalogueCache, type CatalogueProduct } from '../../packages/catalogue/src/index';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';
import { PILOT_CATALOGUE, PILOT_TRADING_PARTNERS, PILOT_TRANSACTIONS } from '../../db/seed/pilot/dataset';

// Screen gap audit 31 Oct 2026 (Round B, OB-614 "wrong numbers first"): the demo seed's opening stock for goods counted
// by the piece was 1000 times too big (100,000 soaps), and two of the five demo products could not be sold at the till:
// the 1 kg rice bag was set up in `kg` (refused — the demo till has no stamped scale) and the 1 L oil pouch in `L` (its
// plain barcode rang 0.001 L at ₹0.12). Packed goods are sold by the piece (`ea`, OB-31 rule 1). Synthetic data only.

const products = PILOT_CATALOGUE.products;
const receipt = PILOT_TRADING_PARTNERS.goodsReceipts[0]!;
const rateOf = (hsn: string): number => PILOT_CATALOGUE.taxRates.find((t) => t.hsnCode === hsn)!.rateBps;

describe('the demo seed: opening stock is counted in pieces', () => {
  it('each opening line is the count a person would shelve — 100 soaps, 60 brushes, 200 rice bags, 80 biscuits, 120 oil pouches', () => {
    expect(receipt.lines.map((l) => [l.productId, l.countedMinor, l.uom])).toEqual([
      ['prod-soap', 100, 'ea'], ['prod-brush', 60, 'ea'], ['prod-rice', 200, 'ea'], ['prod-biscuit', 80, 'ea'], ['prod-oil', 120, 'ea'],
    ]);
  });

  it("every receipt line is in its product's own unit, and the demo order asks for no more than is on hand", () => {
    for (const l of receipt.lines) {
      expect(l.uom, l.productId).toBe(products.find((p) => p.productId === l.productId)!.baseUom);
      expect(l.orderedMinor, l.productId).toBe(l.countedMinor);
    }
    for (const o of PILOT_TRANSACTIONS.orders) {
      for (const line of o.lines) {
        expect(line.quantityMinor, line.productId).toBeLessThanOrEqual(receipt.lines.find((l) => l.productId === line.productId)!.countedMinor);
      }
    }
  });
});

describe('the demo seed: every demo product sells at the till as one piece at its price', () => {
  // The demo till as it ships: no scale register on the box (nothing may be sold by weight), so only goods packed and sold
  // by the piece can be rung from their plain barcode.
  const pack: CatalogueProduct[] = products.map((p) => ({
    productId: p.productId, sku: p.sku, name: p.name, baseUom: p.baseUom, unitPriceMinor: p.price.priceMinor,
    mrpMinor: p.price.mrpMinor, taxBps: rateOf(p.taxClass), hsnCode: p.taxClass, status: 'active',
  }));
  const catalogue = new CatalogueCache({
    tenantId: PILOT_CATALOGUE.tenantId, version: 1, builtAt: '2026-10-31T00:00:00Z', products: pack,
    barcodes: products.map((p) => ({ code: p.barcode!.code, productId: p.productId, kind: 'standard' as const })),
  });
  const session = new PosSession(
    { laneId: 'lane-demo', cashierId: 'pilot-cashier', tradingDay: '2026-10-31', currency: 'INR', defaultTaxRate: taxRateFromPercent(0),
      laneScales: { known: false, why: 'the demo store has no scale register' } },
    new Ledger(new InMemoryLedgerStore()), new SyncOutbox(),
    () => Promise.resolve({ committed: true as const, durable: true as const, detail: 'test double', laneMessage: 'Sale complete.' }),
  );
  session.setNow('2026-10-31T06:00:00Z');
  const view = createPosView(session, 'INR', catalogue);

  for (const p of products) {
    it(`${p.name}: one scan rings 1 at ₹${p.price.priceMinor / 100}, within its MRP, under HSN ${p.taxClass}`, () => {
      expect(p.price.priceMinor).toBeLessThanOrEqual(p.price.mrpMinor);
      const before = view.payableMinor();
      const out = view.scanBarcode(p.barcode!.code);
      expect(out.qty).toBe(1);
      const line = view.basket().find((l) => l.lineId === out.lineId)!;
      expect(line.qtyText).toBe('1');
      expect(view.payableMinor() - before).toBe(p.price.priceMinor);
    });
  }
});
