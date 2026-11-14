import { describe, it, expect } from 'vitest';
import { PosSession, taxRateFromPercent, createPosView } from '../../apps/pos/src/index';
import { CatalogueCache, type CatalogueProduct } from '../../packages/catalogue/src/index';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';
import { PILOT_CATALOGUE, PILOT_TRADING_PARTNERS, PILOT_TRANSACTIONS, PILOT_DEMO_CHILLED_OPENING, PILOT_DEMO_RECEIVING_CHECK } from '../../db/seed/pilot/dataset';

// Screen gap audit 31 Oct 2026 (Round B, OB-614 "wrong numbers first"): the demo seed's opening stock for goods counted
// by the piece was 1000 times too big (100,000 soaps), and two of the five demo products could not be sold at the till:
// the 1 kg rice bag was set up in `kg` (refused — the demo till has no stamped scale) and the 1 L oil pouch in `L` (its
// plain barcode rang 0.001 L at ₹0.12). Packed goods are sold by the piece (`ea`, OB-31 rule 1). Synthetic data only.

const products = PILOT_CATALOGUE.products;
// OB-570 "A": the loose rice is sold by weight (no barcode of its own, no opening stock) — rung only from a scale's label.
const pieces = products.filter((p) => p.baseUom === 'ea');
const loose = products.filter((p) => p.baseUom !== 'ea');
const positionsOf = (r: (typeof PILOT_CATALOGUE.scaleLabelRules)[number]) => ({ prefix: r.prefix, itemStart: r.itemStart, itemLength: r.itemLength, valueStart: r.valueStart, valueLength: r.valueLength, valueKind: r.valueKind });
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

describe('UAT-06: the demo\'s chilled product (Demo Curd 400g) — its own opening stock, counted in pieces, probed and checked', () => {
  const chilled = PILOT_TRADING_PARTNERS.goodsReceipts.find((g) => g.grnId === PILOT_DEMO_CHILLED_OPENING)!;
  const curd = products.find((p) => p.productId === 'prod-curd')!;

  it('the curd is a chilled, cold-chain product of 2–8 °C sold by the piece in the food category', () => {
    expect(curd).toMatchObject({ sku: 'DEMO-CURD-400', name: 'Demo Curd 400g (demo)', baseUom: 'ea', primaryCategoryId: 'cat-food', lifecycle: 'active', handling: 'chilled', coldChain: { minTenthsC: 20, maxTenthsC: 80 } });
    expect(curd.price.priceMinor).toBeLessThanOrEqual(curd.price.mrpMinor);
    expect(curd.price.costMinor).toBeLessThan(curd.price.priceMinor);
  });

  it('its opening stock is 24 cups on its OWN opening receipt (the first one already landed on the demo box), with a batch, an expiry and an arrival temperature inside its limits', () => {
    expect(chilled.lines.map((l) => [l.productId, l.countedMinor, l.uom])).toEqual([['prod-curd', 24, 'ea']]);
    const line = chilled.lines[0]!;
    expect(line.batchId).toBeDefined();
    expect(line.expiry).toBeDefined();
    expect(line.temperatureC! * 10).toBeGreaterThanOrEqual(curd.coldChain!.minTenthsC!);
    expect(line.temperatureC! * 10).toBeLessThanOrEqual(curd.coldChain!.maxTenthsC!);
    expect(receipt.lines.some((l) => l.productId === 'prod-curd')).toBe(false);
    // The receiving checklist is done first, every item ticked, by a person who may record it — never the seed's operator.
    const check = PILOT_TRADING_PARTNERS.receivingChecks.find((c) => c.checkId === PILOT_DEMO_RECEIVING_CHECK)!;
    expect(chilled.receivingChecklist?.checkId).toBe(check.checkId);
    expect(Object.keys(chilled.receivingChecklist!.itemResults).sort()).toEqual(check.items.map((i) => i.itemId).sort());
    expect(chilled.receivingChecklist!.performedBy).not.toBe('pilot-owner');
  });
});

describe('the demo seed: every demo barcode is a real EAN-13 shape — its last digit is the check digit', () => {
  const checkDigit = (first12: string): number => {
    const sum = [...first12].reduce((s, d, i) => s + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
    return (10 - (sum % 10)) % 10;
  };
  for (const p of pieces) {
    it(`${p.name}: ${p.barcode!.code}`, () => {
      expect(p.barcode!.code).toMatch(/^\d{13}$/);
      expect(Number(p.barcode!.code[12])).toBe(checkDigit(p.barcode!.code.slice(0, 12)));
    });
  }
  it('the curd\'s barcode is 8900000000159 (check digit 9)', () => {
    expect(products.find((p) => p.productId === 'prod-curd')?.barcode?.code).toBe('8900000000159');
    expect(new Set(pieces.map((p) => p.barcode!.code)).size).toBe(pieces.length);
  });
});

describe('the demo seed: every demo product sells at the till as one piece at its price', () => {
  // The demo till as it ships: no scale register on the box (nothing may be sold by weight), so only goods packed and sold
  // by the piece can be rung from their plain barcode.
  const pack: CatalogueProduct[] = pieces.map((p) => ({
    productId: p.productId, sku: p.sku, name: p.name, baseUom: p.baseUom, unitPriceMinor: p.price.priceMinor,
    mrpMinor: p.price.mrpMinor, taxBps: rateOf(p.taxClass), hsnCode: p.taxClass, status: 'active',
  }));
  const catalogue = new CatalogueCache({
    tenantId: PILOT_CATALOGUE.tenantId, version: 1, builtAt: '2026-10-31T00:00:00Z', products: pack,
    barcodes: pieces.map((p) => ({ code: p.barcode!.code, productId: p.productId, kind: 'standard' as const })),
  });
  const session = new PosSession(
    { laneId: 'lane-demo', cashierId: 'pilot-cashier', tradingDay: '2026-10-31', currency: 'INR', defaultTaxRate: taxRateFromPercent(0),
      laneScales: { known: false, why: 'the demo store has no scale register' } },
    new Ledger(new InMemoryLedgerStore()), new SyncOutbox(),
    () => Promise.resolve({ committed: true as const, durable: true as const, detail: 'test double', laneMessage: 'Sale complete.' }),
  );
  session.setNow('2026-10-31T06:00:00Z');
  const view = createPosView(session, 'INR', catalogue);

  for (const p of pieces) {
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

describe('the demo seed: the loose rice rings from a scale label by the seeded scale-label rule (OB-570 "A")', () => {
  it('only the loose rice is sold by weight, and it has no barcode of its own — its 6-digit SKU is the item code a scale prints', () => {
    expect(loose.map((p) => [p.productId, p.baseUom, p.sku, p.barcode])).toEqual([['prod-rice-loose', 'kg', '100201', undefined]]);
    expect(PILOT_CATALOGUE.scaleLabelRules.map(positionsOf)).toEqual([
      { prefix: '2', itemStart: 1, itemLength: 6, valueStart: 7, valueLength: 5, valueKind: 'weight' },
    ]);
  });

  it('on a lane with a stamped scale, the label 2 100201 00850 rings 0.850 kg at ₹60.00/kg = ₹51.00, offline', () => {
    const rice = loose[0]!;
    const catalogue = new CatalogueCache({
      tenantId: PILOT_CATALOGUE.tenantId, version: 1, builtAt: '2026-10-31T00:00:00Z',
      products: [{ productId: rice.productId, sku: rice.sku, name: rice.name, baseUom: rice.baseUom, unitPriceMinor: rice.price.priceMinor, mrpMinor: rice.price.mrpMinor, taxBps: 0, hsnCode: rice.taxClass, status: 'active' }],
      barcodes: [],
      embeddedRules: PILOT_CATALOGUE.scaleLabelRules.map(positionsOf),
    });
    const session = new PosSession(
      { laneId: 'lane-demo', cashierId: 'pilot-cashier', tradingDay: '2026-10-31', currency: 'INR', defaultTaxRate: taxRateFromPercent(0),
        laneScales: { known: true, scales: [{ assetId: 'SCALE-DEMO-1', reverificationDueOn: '2099-12-31' }] } },
      new Ledger(new InMemoryLedgerStore()), new SyncOutbox(),
      () => Promise.resolve({ committed: true as const, durable: true as const, detail: 'test double', laneMessage: 'Sale complete.' }),
    );
    session.setNow('2026-10-31T06:00:00Z');
    const view = createPosView(session, 'INR', catalogue);
    expect(view.scanBarcode('2100201008503').qty).toBe(850); // 2 | 100201 | 00850 | 3 (the EAN-13 check digit)
    expect(view.basket()[0]?.qtyText).toBe('0.850 kg');
    expect(view.payableMinor()).toBe(51_00);
  });
});
