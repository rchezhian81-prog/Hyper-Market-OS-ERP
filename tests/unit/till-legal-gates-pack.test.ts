import { describe, it, expect } from 'vitest';
import { canonicalise, hmacSigner, publishPack, acceptPack } from '../../services/catalogue/src/index';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { readPack, emptyPack } from '../../edge/store-edge/src/store-pack';
import { laneScalesFor, readWeighingScales, checkTillRules } from '../../edge/store-edge/src/lane-scales';
import { posLanePayload, type ScreenInput } from '../../edge/store-edge/src/screen-data';
import { regulatedFlagsFor } from '../../services/catalogue/src/catalogue-preview';
import { acceptSale, type IncomingSale } from '../../services/pos/src/sale-intake';
import { foldScaleRegister, weighingScalesSection, type WeighingScaleRecord } from '../../services/platform/src/scale-register';

/**
 * **R2 lane 1 — the data the till's legal gates need travels in the SIGNED packs, and the store computer judges a sale
 * before its disk (roadmap v2.1 B5 · B6 · B14 · B19).** Synthetic data only.
 */

const KEY = ['lane', 'one', 'pack', 'signing', 'key'].join('-').padEnd(48, '0');
const signer = hmacSigner(KEY);
const snapshot = (flags?: Record<string, unknown>): CatalogueSnapshot => ({
  tenantId: 't-sre', version: 2, builtAt: '2026-10-16T05:00:00.000Z',
  products: [{ productId: 'P1', sku: 'S1', name: 'Item', baseUom: 'ea', unitPriceMinor: 1_000, taxBps: 0, status: 'active', ...(flags === undefined ? {} : { regulatedFlags: flags }) }],
  barcodes: [],
});
const publish = (s: CatalogueSnapshot) => {
  const r = publishPack({ snapshot: s, approvals: [], signer, publishedBy: 'u-mgr', publishedAt: s.builtAt });
  if (r.pack === undefined) throw new Error(r.detail);
  return r.pack;
};

describe('the catalogue pack signs the till-gate flags (B14 · B19)', () => {
  it('a product carrying only an age signs to exactly the bytes it always did — a held pack still verifies after the upgrade', () => {
    expect(canonicalise(snapshot({ minimumAge: 21 }))).toBe(canonicalise(snapshot()));
    expect(canonicalise(snapshot({ minimumAge: 21 }))).not.toContain('--regulated');
  });

  it('a tobacco pack size or a plastic flag is under the signature: edited after signing, the pack is rejected and the lane keeps trading', () => {
    for (const [flags, edited] of [
      [{ tobacco: true, packMinimumMinor: 10 }, { tobacco: true, packMinimumMinor: 1 }],
      [{ bannedSingleUsePlastic: true }, {}],
      [{ carryBag: true, plasticMaterial: 'plastic', plasticThicknessMicrons: 40 }, { carryBag: true, plasticMaterial: 'plastic', plasticThicknessMicrons: 120 }],
    ] as const) {
      const pack = publish(snapshot(flags));
      expect(acceptPack({ incoming: pack, signer, tenantId: 't-sre' }).accepted).toBe(true);
      const tampered = { ...pack, snapshot: { ...pack.snapshot, products: pack.snapshot.products.map((p) => ({ ...p, regulatedFlags: edited })) } };
      const verdict = acceptPack({ incoming: tampered, signer, tenantId: 't-sre' });
      expect(verdict.accepted).toBe(false);
      expect(verdict.shopKeepsTrading).toBe(true);
    }
  });

  it('the product master writes the flags the gate reads — and tobacco always carries 18', () => {
    expect(regulatedFlagsFor({ safety: { tobacco: true, packMinimumMinor: 20 } })).toEqual({ tobacco: true, minimumAge: 18, packMinimumMinor: 20 });
    expect(regulatedFlagsFor({ safety: { tobacco: true, minimumAge: 21, packMinimumMinor: 20 } })).toEqual({ tobacco: true, minimumAge: 21, packMinimumMinor: 20 });
    expect(regulatedFlagsFor({ safety: { carryBag: true, plasticMaterial: 'paper' } })).toEqual({ carryBag: true, plasticMaterial: 'paper' });
    expect(regulatedFlagsFor({ safety: { bannedSingleUsePlastic: true } })).toEqual({ bannedSingleUsePlastic: true });
    expect(regulatedFlagsFor({ safety: { allergens: [] } })).toBeUndefined();
  });
});

describe('the store computer reads which scales a lane weighs on (B6)', () => {
  const register = [
    { assetId: 'SC-1', laneIds: ['lane-1', 'lane-2'], approvalNo: 'LM/1', capacityGrams: 15_000, lastStampedOn: '2026-01-10', reverificationDueOn: '2027-01-09' },
    { assetId: 'SC-2', laneIds: ['lane-2'], reverificationDueOn: '2026-10-01' },
    { assetId: 'SC-bad', laneIds: ['lane-1'], reverificationDueOn: 'soon' },
    { laneIds: ['lane-1'], reverificationDueOn: '2027-01-01' },
  ];
  const pack = readPack({ version: 3, weighingScales: register }, '2026-10-16T05:00:00Z');

  it('per lane, unreadable entries left out and counted; a pack without the register says it was not told', () => {
    expect(readWeighingScales(register).unreadable).toBe(2);
    expect(laneScalesFor(pack, 'lane-1')).toEqual({ known: true, scales: [{ assetId: 'SC-1', approvalNo: 'LM/1', capacityGrams: 15_000, lastStampedOn: '2026-01-10', reverificationDueOn: '2027-01-09' }] });
    expect(laneScalesFor(pack, 'lane-2').known && laneScalesFor(pack, 'lane-2')).toMatchObject({ scales: [{ assetId: 'SC-1' }, { assetId: 'SC-2' }] });
    expect(laneScalesFor(emptyPack(), 'lane-1')).toMatchObject({ known: false });
    expect(laneScalesFor(readPack({ version: 1 }, '2026-10-16T05:00:00Z'), 'lane-1')).toEqual({ known: false, why: 'the pack from the cloud carried no weighing scales' });
    expect(laneScalesFor(pack, undefined)).toEqual({ known: false, why: 'this store computer was never told which lane it is' });
  });

  it('the served till is told its lane\'s scales beside its lane id', () => {
    const input = { pack, tradingDay: '2026-10-16' } as unknown as ScreenInput;
    expect(posLanePayload(input, 'lane-2')['scales']).toMatchObject({ known: true, scales: [{ assetId: 'SC-1' }, { assetId: 'SC-2' }] });
  });

  it('the box\'s gate before the disk: a lane where ANY of its scales has lapsed weighs nothing; a banned plastic or a loose stick is refused', () => {
    const products = new Map([
      ['P-STRAW', { name: 'Straws', regulatedFlags: { bannedSingleUsePlastic: true } }],
      ['P-STICK', { name: 'Stick', regulatedFlags: { tobacco: true, packMinimumMinor: 10 } }],
      ['P-RICE', { name: 'Rice' }],
    ]);
    const weighed = { lines: [{ productId: 'P-TOM', quantityMinor: 500, uom: 'kg', unitPriceMinor: 40_00 }] };
    expect(checkTillRules(weighed, { products, scales: laneScalesFor(pack, 'lane-1'), today: '2026-10-16' })).toEqual({ ok: true });
    expect(checkTillRules(weighed, { products, scales: laneScalesFor(pack, 'lane-2'), today: '2026-10-16' })).toMatchObject({ ok: false, refusedBecause: 'weighed_on_lapsed_scale' });
    expect(checkTillRules({ lines: [{ productId: 'P-STRAW', quantityMinor: 1, uom: 'ea', unitPriceMinor: 2_000 }] }, { products, scales: laneScalesFor(pack, 'lane-1'), today: '2026-10-16' }))
      .toEqual({ ok: false, refusedBecause: 'banned_single_use_plastic', productId: 'P-STRAW', laneMessage: 'Do not take payment. Straws is a banned single-use plastic item. It cannot be sold — keep it off the bill and tell the manager. Nothing was saved.' });
    expect(checkTillRules({ lines: [{ productId: 'P-STICK', quantityMinor: 2, uom: 'ea', unitPriceMinor: 1_800 }] }, { products, scales: laneScalesFor(pack, 'lane-1'), today: '2026-10-16' })).toMatchObject({ ok: false, refusedBecause: 'tobacco_below_pack' });
    expect(checkTillRules({ lines: [{ productId: 'P-RICE', quantityMinor: 1, uom: 'ea', unitPriceMinor: 7_000 }] }, { products, scales: { known: false, why: 'never told' }, today: '2026-10-16' })).toEqual({ ok: true });
  });
});

describe('head office\'s scale register folds to the latest version per scale (append-only)', () => {
  it('the store pack section carries the latest of each scale for that store only', () => {
    const v = (assetId: string, version: number, storeId: string, due: string): WeighingScaleRecord => ({ assetId, storeId, laneIds: ['lane-1'], approvalNo: 'A', capacityGrams: 1, lastStampedOn: '2026-01-01', reverificationDueOn: due, version, setBy: 'u', setAt: '2026-01-01T00:00:00Z' });
    const reg = foldScaleRegister([v('X', 1, 'S1', '2026-06-01'), v('Y', 1, 'S2', '2027-01-01'), v('X', 2, 'S1', '2027-06-01')]);
    expect(weighingScalesSection(reg, 'S1')).toEqual([{ assetId: 'X', laneIds: ['lane-1'], approvalNo: 'A', capacityGrams: 1, lastStampedOn: '2026-01-01', reverificationDueOn: '2027-06-01', version: 2 }]);
  });
});

describe('sale intake re-checks a weighed line\'s arithmetic (B5)', () => {
  const sale = (lineTotalMinor: number): IncomingSale => ({
    saleId: 'S', receiptNumber: 'R-1', laneId: 'lane-1', cashierId: 'u', tradingDay: '2026-10-16', committedAt: '2026-10-16T05:00:00Z',
    totalMinor: lineTotalMinor, currency: 'INR', packVersion: 1, tenders: [{ kind: 'cash', amountMinor: lineTotalMinor }],
    lines: [{ productId: 'P', quantityMinor: 333, uom: 'kg', unitPriceMinor: 99_99, lineTotalMinor, scaleCheck: { checkedOn: '2026-10-16', scales: [{ assetId: 'SC', reverificationDueOn: '2027-01-01' }] } }],
  });
  const ctx = { catalogue: new Map([['P', { productId: 'P', sku: 'BAN', name: 'Banana', baseUom: 'kg', unitPriceMinor: 99_99, taxBps: 0, status: 'active' as const }]]), currentPackVersion: 1, saleHoldingThisReceipt: undefined, alreadyBanked: false, now: '2026-10-16T06:00:00Z' };
  it('rounded down (₹33.29) is clean; rounded up (₹33.30) is a finding of one paisa; a promotion below is never one', () => {
    expect(acceptSale(sale(33_29), ctx).exceptions).toEqual([]);
    expect(acceptSale(sale(33_30), ctx).exceptions).toMatchObject([{ kind: 'weighed_line_charged_above_weight_times_price', differenceMinor: 1 }]);
    expect(acceptSale(sale(30_00), ctx).exceptions.map((e) => e.kind)).not.toContain('weighed_line_charged_above_weight_times_price');
  });
  it('a catalogue product with no SKU never stops the sale being banked (the gate names it by id)', () => {
    const bare = { ...ctx, catalogue: new Map([['P', { productId: 'P', name: 'Banana', baseUom: 'kg', unitPriceMinor: 99_99, taxBps: 0, status: 'active', regulatedFlags: { bannedSingleUsePlastic: true } } as never]]) };
    const r = acceptSale(sale(33_29), bare);
    expect(r.banked).toBe(true);
    expect(r.exceptions.map((e) => e.kind)).toContain('unlawful_plastic_sold');
  });
});
