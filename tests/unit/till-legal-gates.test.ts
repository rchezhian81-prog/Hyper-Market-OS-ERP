import { describe, it, expect } from 'vitest';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { TillRuleRefusedError, AgeCheckRequiredError, AgeCheckNotDoneError } from '../../apps/pos/src/session';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { CatalogueCache, minimumAgeOf } from '../../packages/catalogue/src/catalogue';
import {
  tillLineRefusals, productRuleRefusals, tillRuleFlagsOf, hasTillRuleFlags, scaleEvidence, type LaneScales,
} from '../../packages/restricted-sales/src/till-gate';
import { priceLine } from '../../packages/pricing/src/pricing';
import { money } from '../../packages/contracts/src/money';
import { quantity } from '../../packages/contracts/src/quantity';
import { rate } from '../../packages/contracts/src/rate';
import { PosSession } from '../../apps/pos/src/session';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/ledger';
import { SyncOutbox } from '../../packages/sync/src/outbox';

/**
 * **R2 lane 1 — the till's legal gates on the REAL till path (roadmap v2.1 B5 · B6 · B14 · B19 · hard rule #1).**
 *
 * The audit found the engines and check routes for B6, B14 and B19 built and tested, and the till's sale path never
 * calling them; and B5's arithmetic rounding a fraction of a paisa UP against the customer. These drive `bootPos` — the
 * function the served till boots — with a synthetic signed-pack catalogue and a durable write double, scan by barcode
 * as the cashier does, and read the record the till hands its store computer. Synthetic data only.
 */

const TODAY = new Date().toISOString();
const day = (offset: number): string => {
  const d = new Date(Date.now() + offset * 86_400_000);
  return d.toISOString().slice(0, 10);
};
const CURRENT: LaneScales = { known: true, scales: [{ assetId: 'SCALE-L1', approvalNo: 'LM/APP/0001', reverificationDueOn: day(200) }] };
const LAPSED: LaneScales = { known: true, scales: [{ assetId: 'SCALE-L1', approvalNo: 'LM/APP/0001', reverificationDueOn: day(-3) }] };

const BANANA = '2000123003330'; // weight-embedded: item 000123, 333 g
const CIG = '8900000000101';
const STRAW = '8900000000202';
const THIN_BAG = '8900000000303';
const GOOD_BAG = '8900000000404';
const FREE_BAG = '8900000000505';
const CLOTH_BAG = '8900000000606';
const RICE = '8900000000707';

const catalogue: CatalogueSnapshot = {
  tenantId: 't-sre', version: 4, builtAt: TODAY,
  products: [
    { productId: 'P-BAN', sku: '000123', name: 'Banana (loose)', baseUom: 'kg', unitPriceMinor: 99_99, taxBps: 0, status: 'active' },
    { productId: 'P-CIG', sku: 'CIG-10', name: 'Cigarette sticks (demo)', baseUom: 'ea', unitPriceMinor: 18_00, taxBps: 2800, status: 'active', regulatedFlags: { tobacco: true, packMinimumMinor: 10 } },
    { productId: 'P-STRAW', sku: 'STRAW', name: 'Plastic straws (demo)', baseUom: 'ea', unitPriceMinor: 20_00, taxBps: 1800, status: 'active', regulatedFlags: { bannedSingleUsePlastic: true } },
    { productId: 'P-THIN', sku: 'BAG-50', name: 'Carry bag 50 micron (demo)', baseUom: 'ea', unitPriceMinor: 3_00, taxBps: 1800, status: 'active', regulatedFlags: { carryBag: true, plasticMaterial: 'plastic', plasticThicknessMicrons: 50 } },
    { productId: 'P-BAG', sku: 'BAG-120', name: 'Carry bag 120 micron', baseUom: 'ea', unitPriceMinor: 5_00, taxBps: 1800, status: 'active', regulatedFlags: { carryBag: true, plasticMaterial: 'plastic', plasticThicknessMicrons: 120 } },
    { productId: 'P-FREE', sku: 'BAG-FREE', name: 'Carry bag (free, demo)', baseUom: 'ea', unitPriceMinor: 0, taxBps: 1800, status: 'active', regulatedFlags: { carryBag: true, plasticMaterial: 'plastic', plasticThicknessMicrons: 120 } },
    { productId: 'P-CLOTH', sku: 'BAG-CLOTH', name: 'Cloth bag', baseUom: 'ea', unitPriceMinor: 30_00, taxBps: 500, status: 'active', regulatedFlags: { carryBag: true, plasticMaterial: 'cloth' } },
    { productId: 'P-RICE', sku: 'RICE-1', name: 'Ponni rice 1kg', baseUom: 'ea', unitPriceMinor: 70_00, taxBps: 0, status: 'active' },
  ],
  barcodes: [
    { code: CIG, productId: 'P-CIG', kind: 'standard' }, { code: STRAW, productId: 'P-STRAW', kind: 'standard' },
    { code: THIN_BAG, productId: 'P-THIN', kind: 'standard' }, { code: GOOD_BAG, productId: 'P-BAG', kind: 'standard' },
    { code: FREE_BAG, productId: 'P-FREE', kind: 'standard' }, { code: CLOTH_BAG, productId: 'P-CLOTH', kind: 'standard' },
    { code: RICE, productId: 'P-RICE', kind: 'standard' },
  ],
  embeddedRules: [{ prefix: '2', itemStart: 1, itemLength: 6, valueStart: 7, valueLength: 5, valueKind: 'weight' }],
};

function till(laneScales?: LaneScales) {
  const written: Record<string, unknown>[] = [];
  const pos = bootPos({
    laneId: 'lane-1', cashierId: 'u-cashier', tradingDay: day(0), catalogue, taxPercent: 0,
    ...(laneScales === undefined ? {} : { laneScales }),
    durable: async (_id, record) => {
      written.push(JSON.parse(record) as Record<string, unknown>);
      return { committed: true, durable: true, detail: 'test double', laneMessage: 'Sale complete.' };
    },
  });
  return { pos, written };
}
const refusedWith = (fn: () => unknown): TillRuleRefusedError => {
  try { fn(); } catch (e) { if (e instanceof TillRuleRefusedError) return e; throw e; }
  throw new Error('expected the till to refuse');
};
type Line = { productId: string; quantityMinor: number; unitPriceMinor: number; lineTotalMinor: number; scaleCheck?: unknown; packCheck?: unknown; carryBag?: unknown; ageCheck?: { minimumAge: number } };

describe('B5 — a weighed line is weighed quantity × the displayed price per kg, never rounded against the customer', () => {
  it('333 g at ₹99.99/kg is 3,329.667 paise: the till charges ₹33.29 (down), on screen and on the record', async () => {
    const { pos, written } = till(CURRENT);
    pos.scanBarcode(BANANA);
    expect(pos.payableMinor()).toBe(33_29);
    await pos.tenderCash('S-1', 'R-1', TODAY);
    const line = (written[0]!['lines'] as Line[])[0]!;
    expect(line).toMatchObject({ productId: 'P-BAN', quantityMinor: 333, unitPriceMinor: 99_99, lineTotalMinor: 33_29 });
    expect(written[0]!['total']).toBe(33_29);
  });

  it('an exact weight is charged exactly (1.234 kg at ₹80.00/kg = ₹98.72); the down step only drops a fraction', () => {
    expect(priceLine({ unitPrice: money(80_00, 'INR'), quantity: quantity(1234, 'kg'), taxRate: rate(0), pricesIncludeTax: true, quantityRounding: 'down' }).total.minor).toBe(98_72);
    expect(priceLine({ unitPrice: money(99_99, 'INR'), quantity: quantity(333, 'kg'), taxRate: rate(0), pricesIncludeTax: true, quantityRounding: 'down' }).total.minor).toBe(33_29);
    // The default (purchase lines, quotes) is unchanged: half-up.
    expect(priceLine({ unitPrice: money(99_99, 'INR'), quantity: quantity(333, 'kg'), taxRate: rate(0) }).total.minor).toBe(33_30);
  });
});

describe('B6 — weight only from a scale whose Legal Metrology verification is current', () => {
  it('a lane whose scale stamp has lapsed refuses the weighed line, by name, and adds nothing', () => {
    const { pos } = till(LAPSED);
    const e = refusedWith(() => pos.scanBarcode(BANANA));
    expect(e.refusals[0]?.reason).toBe('weighed_on_lapsed_scale');
    expect(e.laneMessage).toContain('SCALE-L1');
    expect(e.laneMessage).toContain('Nothing can be sold by weight on this lane until it is re-verified');
    expect(pos.basket()).toHaveLength(0);
    // Ordinary goods still sell on that lane — only weight is refused.
    pos.scanBarcode(RICE);
    expect(pos.basket()).toHaveLength(1);
  });

  it('a till never told its scales (an old page, no register) sells nothing by weight', () => {
    for (const scales of [undefined, { known: false as const, why: 'no register' }, { known: true as const, scales: [] }]) {
      const { pos } = till(scales);
      expect(refusedWith(() => pos.scanBarcode(BANANA)).refusals[0]?.reason).toBe('weighed_without_verified_scale');
    }
  });

  it('a weight keyed by hand on a lapsed lane is refused too (a line added by id, a quantity change)', () => {
    const { pos } = till(LAPSED);
    expect(refusedWith(() => pos.scan({ productId: 'P-BAN', description: 'Banana (loose)', unitPriceMinor: 99_99, qty: 500, uom: 'kg' })).refusals[0]?.reason).toBe('weighed_on_lapsed_scale');
  });

  it('a current scale: the line sells, and the record names the scale and the last day its stamp is valid', async () => {
    const { pos, written } = till(CURRENT);
    pos.scanBarcode(BANANA);
    await pos.tenderCash('S-2', 'R-2', TODAY);
    expect((written[0]!['lines'] as Line[])[0]!.scaleCheck).toEqual({ checkedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) as unknown, scales: [{ assetId: 'SCALE-L1', reverificationDueOn: day(200) }] });
  });

  it('the stamp runs out while the basket is open: the commit refuses before the disk', async () => {
    const lastDay = day(0);
    const { pos, written } = till({ known: true, scales: [{ assetId: 'SCALE-L1', reverificationDueOn: lastDay }] });
    pos.scanBarcode(BANANA);
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString();
    await expect(pos.tenderCash('S-3', 'R-3', tomorrow)).rejects.toThrow(TillRuleRefusedError);
    await expect(pos.tenderCash('S-3', 'R-3', tomorrow)).rejects.toMatchObject({ laneMessage: expect.stringMatching(/^Do not take payment\. The weighing scale on this lane/) as unknown });
    expect(written).toHaveLength(0);
  });

  it('the engine: due today is still current; the day after it is lapsed; an unreadable date proves nothing', () => {
    const line = { productId: 'P', description: 'Tomato', quantityMinor: 100, uom: 'kg', unitPriceMinor: 40_00 };
    expect(tillLineRefusals(line, { scales: { known: true, scales: [{ assetId: 'S', reverificationDueOn: '2026-10-16' }] }, today: '2026-10-16' })).toEqual([]);
    expect(tillLineRefusals(line, { scales: { known: true, scales: [{ assetId: 'S', reverificationDueOn: '2026-10-16' }] }, today: '2026-10-17' })[0]?.reason).toBe('weighed_on_lapsed_scale');
    expect(tillLineRefusals(line, { scales: { known: true, scales: [{ assetId: 'S', reverificationDueOn: 'soon' }] }, today: '2026-10-17' })[0]?.reason).toBe('weighed_without_verified_scale');
    expect(tillLineRefusals(line, { scales: CURRENT })[0]?.reason).toBe('weighed_without_verified_scale'); // no date known
    expect(tillLineRefusals({ ...line, uom: 'L' }, {})).toEqual([]); // measured, not weighed
    expect(scaleEvidence({ scales: CURRENT, today: '2026-10-16' })).toEqual({ checkedOn: '2026-10-16', scales: [{ assetId: 'SCALE-L1', reverificationDueOn: day(200) }] });
  });
});

describe('B14 — a tobacco line demands age-18 confirmation and refuses a below-pack quantity', () => {
  it('a loose stick is refused before any age question; a whole pack asks for 18+ even though the record names no age', () => {
    const { pos } = till(CURRENT);
    const loose = refusedWith(() => pos.scanBarcode(CIG)); // 1 stick, pack of 10
    expect(loose.refusals.map((r) => r.reason)).toEqual(['tobacco_below_pack']);
    expect(loose.laneMessage).toBe('Cigarette sticks (demo) is tobacco and is sold only in whole packs (at least 10). Loose cigarettes cannot be sold — this line is 1.');
    let asked: unknown;
    try { pos.scan({ productId: 'P-CIG', description: 'Cigarette sticks (demo)', unitPriceMinor: 18_00, qty: 10 }); } catch (e) { asked = e; }
    expect(asked).toBeInstanceOf(AgeCheckRequiredError);
    expect((asked as AgeCheckRequiredError).minimumAge).toBe(18);
    expect(pos.basket()).toHaveLength(0);
  });

  it('after the ID check the pack sells; a quantity change below the pack is refused and the line keeps 10', async () => {
    const { pos, written } = till(CURRENT);
    pos.confirmAge(18, TODAY, 'P-CIG');
    pos.scan({ productId: 'P-CIG', description: 'Cigarette sticks (demo)', unitPriceMinor: 18_00, qty: 10 });
    const lineId = pos.basket()[0]!.lineId;
    expect(refusedWith(() => pos.setQuantity(lineId, 5)).refusals[0]?.reason).toBe('tobacco_below_pack');
    expect(pos.basket()[0]!.qty).toBe(10);
    pos.setQuantity(lineId, 20); // two whole packs
    await pos.tenderCash('S-4', 'R-4', TODAY);
    const line = (written[0]!['lines'] as Line[])[0]!;
    expect(line.packCheck).toEqual({ packMinimumMinor: 10 });
    expect(line.ageCheck).toMatchObject({ minimumAge: 18, confirmedAtLeast: 18, confirmedBy: 'u-cashier' });
  });

  it('a 16+ answer does not cover tobacco; the catalogue reads tobacco as 18+ whatever it declares', () => {
    const { pos } = till(CURRENT);
    pos.confirmAge(16, TODAY);
    expect(() => pos.scan({ productId: 'P-CIG', description: 'Cigarette sticks (demo)', unitPriceMinor: 18_00, qty: 10 })).toThrow(AgeCheckRequiredError);
    expect(minimumAgeOf({ regulatedFlags: { tobacco: true } })).toBe(18);
    expect(minimumAgeOf({ regulatedFlags: { tobacco: true, minimumAge: 16 } })).toBe(18);
    expect(minimumAgeOf({ regulatedFlags: { tobacco: true, minimumAge: 21 } })).toBe(21);
    expect(new CatalogueCache(catalogue).scan(CIG)).toMatchObject({ requiresAgeCheck: true, minimumAge: 18 });
  });

  it('tobacco with no pack size on record is refused (the till cannot tell a pack from a loose stick)', () => {
    expect(productRuleRefusals({ productId: 'T', description: 'Beedi', quantityMinor: 1, uom: 'ea', unitPriceMinor: 10_00, regulatedFlags: { tobacco: true } })[0]?.reason).toBe('tobacco_pack_size_unknown');
  });

  it('the commit reads the PACK again: a line rung before its flags arrived (or recalled from a held basket) is judged', async () => {
    // The lane's pack flags, as the session reads them by id — empty at the scan, then the new pack says tobacco / thin bag.
    const flags = new Map<string, Record<string, unknown>>();
    const written: string[] = [];
    const session = new PosSession(
      { laneId: 'lane-1', cashierId: 'u-cashier', currency: 'INR', defaultTaxRate: rate(0), laneScales: CURRENT, regulatedFlagsOf: (id) => flags.get(id) },
      new Ledger(new InMemoryLedgerStore()), new SyncOutbox(),
      async (_id, record) => { written.push(record); return { committed: true, durable: true, detail: 'double', laneMessage: 'Sale complete.' }; },
    );
    session.scan({ productId: 'P-X', description: 'Item X', unitPrice: money(18_00, 'INR'), quantityMinor: 10, uom: 'ea' });
    flags.set('P-X', { tobacco: true, packMinimumMinor: 10 });
    const cash = [{ kind: 'cash' as const, amount: money(18_00 * 10, 'INR'), status: 'settled' as const }];
    await expect(session.commit('S-5', 'R-5', TODAY, cash)).rejects.toBeInstanceOf(AgeCheckNotDoneError);
    flags.set('P-X', { carryBag: true, plasticMaterial: 'plastic', plasticThicknessMicrons: 40 });
    await expect(session.commit('S-5', 'R-5', TODAY, cash)).rejects.toMatchObject({ name: 'TillRuleRefusedError', laneMessage: expect.stringMatching(/^Do not take payment\. Item X is a 40-micron plastic carry bag/) as unknown });
    expect(written).toHaveLength(0);
  });
});

describe('B19 — no banned single-use plastic, no carry bag under 120 µm, and a bag is its own priced line', () => {
  it('a banned single-use-plastic SKU is refused by name', () => {
    const { pos } = till(CURRENT);
    const e = refusedWith(() => pos.scanBarcode(STRAW));
    expect(e.refusals[0]?.reason).toBe('banned_single_use_plastic');
    expect(e.laneMessage).toBe('Plastic straws (demo) is a banned single-use plastic item. It cannot be sold — keep it off the bill and tell the manager.');
    expect(pos.basket()).toHaveLength(0);
  });

  it('a 50-micron plastic bag is refused; a free bag is refused; a 120-micron bag at ₹5 and a cloth bag sell as their own lines', async () => {
    const { pos, written } = till(CURRENT);
    expect(refusedWith(() => pos.scanBarcode(THIN_BAG)).laneMessage).toContain('50-micron plastic carry bag, thinner than the 120-micron minimum');
    expect(refusedWith(() => pos.scanBarcode(FREE_BAG)).refusals[0]?.reason).toBe('carry_bag_not_priced');
    pos.scanBarcode(RICE);
    pos.scanBarcode(GOOD_BAG);
    pos.scanBarcode(CLOTH_BAG);
    expect(pos.basket().map((l) => l.productId)).toEqual(['P-RICE', 'P-BAG', 'P-CLOTH']);
    expect(pos.payableMinor()).toBe(70_00 + 5_00 + 30_00);
    await pos.tenderCash('S-6', 'R-6', TODAY);
    const lines = written[0]!['lines'] as Line[];
    expect(lines.find((l) => l.productId === 'P-BAG')).toMatchObject({ unitPriceMinor: 5_00, lineTotalMinor: 5_00, carryBag: { material: 'plastic', thicknessMicrons: 120 } });
    expect(lines.find((l) => l.productId === 'P-CLOTH')?.carryBag).toEqual({ material: 'cloth' });
  });

  it('no manager approval can make a bag free: the price change is refused before any approval is spent', () => {
    const { pos } = till(CURRENT);
    pos.scanBarcode(GOOD_BAG);
    const change = pos.priceChangeValue(pos.basket()[0]!.lineId, 0);
    expect(change).toEqual({ ok: false, laneMessage: 'Carry bag 120 micron is a carry bag. A bag is sold as its own line at its price — it cannot be given free.' });
    // Lowered but still priced is an ordinary approved change.
    expect(pos.priceChangeValue(pos.basket()[0]!.lineId, 4_00)).toMatchObject({ ok: true, reductionMinor: 1_00 });
  });

  it('the flags are read strictly from the pack', () => {
    expect(tillRuleFlagsOf({ tobacco: 'yes', packMinimumMinor: 2.5, plasticThicknessMicrons: -1, carryBag: true })).toEqual({ carryBag: true });
    expect(hasTillRuleFlags({ minimumAge: 18 })).toBe(false);
    expect(hasTillRuleFlags({ minimumAge: 18, tobacco: true })).toBe(true);
    // A bag of no stated material but a thickness is judged as plastic (only plastic is measured in microns).
    expect(productRuleRefusals({ productId: 'B', description: 'Bag', quantityMinor: 1, uom: 'ea', unitPriceMinor: 2_00, regulatedFlags: { carryBag: true, plasticThicknessMicrons: 60 } })[0]?.reason).toBe('carry_bag_below_min_thickness');
    expect(productRuleRefusals({ productId: 'B', description: 'Bag', quantityMinor: 1, uom: 'ea', unitPriceMinor: 2_00, regulatedFlags: { carryBag: true, plasticMaterial: 'plastic' } })[0]?.laneMessage).toContain('no thickness on record');
  });
});
