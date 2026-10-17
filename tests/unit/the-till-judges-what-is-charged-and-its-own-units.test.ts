import { describe, it, expect } from 'vitest';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { TillRuleRefusedError } from '../../apps/pos/src/session';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { productRuleRefusals, tillLineRefusals, lineIsWeighed, type LaneScales } from '../../packages/restricted-sales/src/till-gate';
import { checkSingleUsePlastic } from '../../packages/restricted-sales/src/single-use-plastic';
import { checkRestrictedSale } from '../../packages/restricted-sales/src/restricted-sales';
import { checkTillRules } from '../../edge/store-edge/src/lane-scales';
import { acceptSale, type IncomingSale, type IntakeContext } from '../../services/pos/src/index';
import { canonicalise, publishPack, acceptPack } from '../../services/catalogue/src/pack';
import { hmacSigner } from '../../services/catalogue/src/index';
import { returnedValueAtOriginalPrices, assessExchange } from '../../packages/returns/src/exchange';
import type { OriginalSale } from '../../packages/returns/src/return-register';

/**
 * **Follow-up F1 (till) — the verifier's R2 lane 1 findings, and the owner's OB-160, closed on the real till path.**
 *
 *   • NEW-1 (B19): a carry bag is judged as CHARGED, after the offer the till attributed to it — at the till's commit, at
 *     the store computer and at head office — and an offer that names a carry bag is refused when it reaches the till.
 *   • NEW-2 (B6): "weighed" is each side's OWN catalogue's answer (the till's pack, the box's catalogue, head office's), never
 *     only the unit written on the line; a pack's units and barcode rules are under its signature, and a pack signed before
 *     still verifies.
 *   • OB-160 "A" (owner, 16 Oct 2026): tobacco sells in whole multiples of the pack size — at the scan, a quantity change,
 *     the commit, the store computer and head office.
 *   • L1 (B5): a part return of a weighed line is never rounded against the customer; the parts add up to the whole.
 * Synthetic data only.
 */

const NOW = new Date().toISOString();
const day = (o: number): string => new Date(Date.now() + o * 86_400_000).toISOString().slice(0, 10);
const LAPSED: LaneScales = { known: true, scales: [{ assetId: 'SCALE-L1', reverificationDueOn: day(-3) }] };
const CURRENT: LaneScales = { known: true, scales: [{ assetId: 'SCALE-L1', reverificationDueOn: day(200) }] };

const BAG = '8900000000404';
const RICE = '8900000000707';
const CIG = '8900000000101';
const BASE: CatalogueSnapshot = {
  tenantId: 't-f1', version: 4, builtAt: NOW,
  products: [
    { productId: 'P-BAN', sku: '000123', name: 'Banana (loose)', baseUom: 'kg', unitPriceMinor: 99_99, taxBps: 0, status: 'active' },
    { productId: 'P-BAG', sku: 'BAG-120', name: 'Carry bag 120 micron', baseUom: 'ea', unitPriceMinor: 5_00, taxBps: 0, status: 'active', regulatedFlags: { carryBag: true, plasticMaterial: 'plastic', plasticThicknessMicrons: 120 } },
    { productId: 'P-RICE', sku: 'RICE', name: 'Ponni rice 1kg', baseUom: 'ea', unitPriceMinor: 70_00, taxBps: 0, status: 'active' },
    { productId: 'P-CIG', sku: 'CIG-10', name: 'Cigarette sticks (demo)', baseUom: 'ea', unitPriceMinor: 18_00, taxBps: 0, status: 'active', regulatedFlags: { tobacco: true, packMinimumMinor: 10 } },
  ],
  barcodes: [{ code: BAG, productId: 'P-BAG', kind: 'standard' }, { code: RICE, productId: 'P-RICE', kind: 'standard' }, { code: CIG, productId: 'P-CIG', kind: 'standard' }],
  embeddedRules: [{ prefix: '2', itemStart: 1, itemLength: 6, valueStart: 7, valueLength: 5, valueKind: 'weight' }],
};
const WINDOW = { status: 'active' as const, startsAt: '2020-01-01T00:00:00Z', endsAt: '2099-01-01T00:00:00Z' };

function till(cat: CatalogueSnapshot, laneScales: LaneScales = CURRENT) {
  const written: Record<string, unknown>[] = [];
  const pos = bootPos({
    laneId: 'lane-1', cashierId: 'u-cashier', tradingDay: day(0), catalogue: cat, taxPercent: 0, laneScales,
    durable: async (_id, record) => { written.push(JSON.parse(record) as Record<string, unknown>); return { committed: true, durable: true, detail: 'double', laneMessage: 'Sale complete.' }; },
  });
  return { pos, written };
}
const refused = async (fn: () => unknown): Promise<TillRuleRefusedError> => {
  try { await fn(); } catch (e) { if (e instanceof TillRuleRefusedError) return e; throw e; }
  throw new Error('expected the till to refuse');
};
const products = (cat: CatalogueSnapshot) => new Map(cat.products.map((p) => [p.productId, { name: p.name, baseUom: p.baseUom, ...(p.regulatedFlags ? { regulatedFlags: p.regulatedFlags } : {}) }]));
const intakeCtx = (cat: CatalogueSnapshot, over: Partial<IntakeContext> = {}): IntakeContext => ({
  catalogue: new Map(cat.products.map((p) => [p.productId, p])), currentPackVersion: 4, saleHoldingThisReceipt: undefined, alreadyBanked: false, now: NOW, ...over,
});
const sale = (lines: IncomingSale['lines'], over: Partial<IncomingSale> = {}): IncomingSale => {
  const total = lines.reduce((n, l) => n + l.lineTotalMinor, 0);
  return { saleId: 'S-1', receiptNumber: 'R-1', laneId: 'lane-1', cashierId: 'u', tradingDay: day(0), committedAt: NOW, totalMinor: total, currency: 'INR', packVersion: 4, lines, tenders: [{ kind: 'cash', amountMinor: total }], ...over };
};

describe('NEW-1 (B19) — an offer can never give a carry bag away', () => {
  it('the verifier\'s case: an amount_off offer on the bag is refused at the till, said on refusedOffers(), and the bag is charged', async () => {
    const cat: CatalogueSnapshot = { ...BASE, promotions: [{ id: 'PR-FREEBAG', kind: 'amount_off', ...WINDOW, productIds: ['P-BAG'], amountOffMinor: 5_00 }] };
    const { pos, written } = till(cat);
    expect(pos.refusedOffers()).toEqual([{ offerId: 'PR-FREEBAG', carryBags: ['P-BAG'], laneMessage: expect.stringContaining('names a carry bag') as unknown }]);
    pos.scanBarcode(RICE); pos.scanBarcode(RICE); pos.scanBarcode(BAG);
    expect(pos.payableMinor()).toBe(145_00); // the bag is NOT free
    await pos.tenderCash('S-1', 'R-1', NOW);
    const bag = (written[0]!['lines'] as { productId: string; lineTotalMinor: number }[]).find((l) => l.productId === 'P-BAG')!;
    expect(bag.lineTotalMinor).toBe(5_00);
  });

  it('a 100% offer on the whole basket (no product named) reaches the bag: the till\'s commit refuses before the disk', async () => {
    const cat: CatalogueSnapshot = { ...BASE, promotions: [{ id: 'PR-ALL', kind: 'percent_off', ...WINDOW, percentBps: 10_000 }] };
    const { pos, written } = till(cat);
    expect(pos.refusedOffers()).toEqual([]); // it names no carry bag; the charged amount is what is judged
    pos.scanBarcode(RICE); pos.scanBarcode(BAG);
    const e = await refused(() => pos.tenderCash('S-2', 'R-2', NOW));
    expect(e.refusals.map((r) => [r.productId, r.reason])).toEqual([['P-BAG', 'carry_bag_not_priced']]);
    expect(e.laneMessage).toMatch(/^Do not take payment\. Carry bag 120 micron is a carry bag and an offer has taken its price to nothing/);
    expect(written).toHaveLength(0);
  });

  it('a part discount on the bag is still a priced bag (the rule is "never free", not "never discounted")', async () => {
    const cat: CatalogueSnapshot = { ...BASE, promotions: [{ id: 'PR-10', kind: 'percent_off', ...WINDOW, percentBps: 1_000 }] };
    const { pos, written } = till(cat);
    pos.scanBarcode(RICE); pos.scanBarcode(BAG);
    await pos.tenderCash('S-3', 'R-3', NOW);
    const bag = (written[0]!['lines'] as { productId: string; lineTotalMinor: number }[]).find((l) => l.productId === 'P-BAG')!;
    expect(bag.lineTotalMinor).toBeGreaterThan(0);
  });

  it('the store computer and head office judge the line as CHARGED (lineTotalMinor), not its unit price', () => {
    const record = { id: 'S', lines: [{ productId: 'P-BAG', quantityMinor: 1, uom: 'ea', unitPriceMinor: 5_00, lineTotalMinor: 0 }] };
    expect(checkTillRules(record, { products: products(BASE), scales: CURRENT, today: day(0) })).toMatchObject({ ok: false, refusedBecause: 'carry_bag_not_priced', productId: 'P-BAG' });
    expect(checkTillRules({ id: 'S', lines: [{ ...record.lines[0], lineTotalMinor: 5_00 }] }, { products: products(BASE), scales: CURRENT, today: day(0) })).toEqual({ ok: true });
    const res = acceptSale(sale([
      { productId: 'P-RICE', quantityMinor: 2, uom: 'ea', unitPriceMinor: 70_00, lineTotalMinor: 140_00 },
      { productId: 'P-BAG', quantityMinor: 1, uom: 'ea', unitPriceMinor: 5_00, lineTotalMinor: 0 },
    ]), intakeCtx(BASE));
    expect(res.exceptions.filter((x) => x.kind === 'unlawful_plastic_sold').map((x) => [x.severity, x.productId])).toEqual([['critical', 'P-BAG']]);
  });

  it('the engine: a priced bag charged nothing is "not priced"; without a charged amount only the unit price is judged', () => {
    const bag = { lineId: 'l', productId: 'B', unitPriceMinor: 5_00, isCarryBag: true, material: 'cloth' };
    expect(checkSingleUsePlastic({ lines: [{ ...bag, chargedMinor: 0 }] }).blocks.map((b) => b.reason)).toEqual(['carry_bag_not_priced']);
    expect(checkSingleUsePlastic({ lines: [{ ...bag, chargedMinor: 1 }] }).allowed).toBe(true);
    expect(checkSingleUsePlastic({ lines: [bag] }).allowed).toBe(true);
    expect(productRuleRefusals({ productId: 'B', description: 'Cloth bag', quantityMinor: 1, uom: 'ea', unitPriceMinor: 5_00, chargedMinor: 0, regulatedFlags: { carryBag: true, plasticMaterial: 'cloth' } })[0]?.reason).toBe('carry_bag_not_priced');
  });
});

describe('NEW-2 (B6) — "weighed" is each side\'s own catalogue\'s answer', () => {
  it('the store computer refuses a kg product on a LAPSED lane however the line spells its unit (L, ea, or none)', () => {
    const rec = (uom?: string) => ({ id: 'S', lines: [{ productId: 'P-BAN', quantityMinor: 333, ...(uom === undefined ? {} : { uom }), unitPriceMinor: 99_99, lineTotalMinor: 33_29 }] });
    for (const uom of ['kg', 'L', 'ea', undefined]) {
      expect(checkTillRules(rec(uom), { products: products(BASE), scales: LAPSED, today: day(0) }), String(uom)).toMatchObject({ ok: false, refusedBecause: 'weighed_on_lapsed_scale' });
    }
    // Rice (sold each) on the same lane still sells.
    expect(checkTillRules({ id: 'S', lines: [{ productId: 'P-RICE', quantityMinor: 1, uom: 'ea', unitPriceMinor: 70_00, lineTotalMinor: 70_00 }] }, { products: products(BASE), scales: LAPSED, today: day(0) })).toEqual({ ok: true });
  });

  it('the till refuses a weighed product keyed in another unit on a lapsed lane (its own pack says kg)', () => {
    const { pos } = till(BASE, LAPSED);
    let e: unknown;
    try { pos.scan({ productId: 'P-BAN', description: 'Banana (loose)', unitPriceMinor: 99_99, qty: 333, uom: 'L' }); } catch (x) { e = x; }
    expect(e).toBeInstanceOf(TillRuleRefusedError);
    expect((e as TillRuleRefusedError).refusals[0]?.reason).toBe('weighed_on_lapsed_scale');
    expect(lineIsWeighed({ uom: 'L', catalogueUom: 'kg' })).toBe(true);
    expect(lineIsWeighed({ uom: 'L' })).toBe(false);
    expect(tillLineRefusals({ productId: 'X', description: 'x', quantityMinor: 1, uom: 'ea', unitPriceMinor: 1, catalogueUom: 'g' }, { scales: LAPSED, today: day(0) })[0]?.reason).toBe('weighed_on_lapsed_scale');
  });

  it('head office: a kg product sent as "L" is judged weighed by ITS catalogue (scale finding) and the unit mismatch is raised', () => {
    const res = acceptSale(sale([{ productId: 'P-BAN', quantityMinor: 333, uom: 'L', unitPriceMinor: 99_99, lineTotalMinor: 33_29, taxRateBps: 0 }]), intakeCtx(BASE));
    const kinds = res.exceptions.map((x) => [x.kind, x.severity]);
    expect(kinds).toContainEqual(['weighed_on_unverified_scale', 'material']);
    expect(kinds).toContainEqual(['unit_differs_from_catalogue', 'material']);
    // And the same line in kg with the lane's evidence raises neither.
    const ok = acceptSale(sale([{ productId: 'P-BAN', quantityMinor: 333, uom: 'kg', unitPriceMinor: 99_99, lineTotalMinor: 33_29, taxRateBps: 0, scaleCheck: { checkedOn: day(0), scales: [{ assetId: 'SCALE-L1', reverificationDueOn: day(200) }] } }]), intakeCtx(BASE));
    expect(ok.exceptions.map((x) => x.kind)).not.toContain('weighed_on_unverified_scale');
    expect(ok.exceptions.map((x) => x.kind)).not.toContain('unit_differs_from_catalogue');
  });

  it('a pack publishPack signs carries its units and barcode rules under the signature: kg→L, a new rule, or a stripped marker fails to verify', () => {
    const signer = hmacSigner(['f1', 'pack', 'key'].join('-').padEnd(40, '0'));
    const published = publishPack({ snapshot: BASE, approvals: [], signer, publishedBy: 'u-owner', publishedAt: NOW });
    expect(published.ok).toBe(true);
    const pack = published.pack!;
    expect(pack.snapshot.unitsSigned).toBe(true);
    expect(acceptPack({ incoming: pack, signer, tenantId: 't-f1' }).accepted).toBe(true);
    const kgToL = { ...pack, snapshot: { ...pack.snapshot, products: pack.snapshot.products.map((p) => (p.productId === 'P-BAN' ? { ...p, baseUom: 'L' } : p)) } };
    expect(acceptPack({ incoming: kgToL, signer, tenantId: 't-f1' })).toMatchObject({ accepted: false, rejectedBecause: 'signature_does_not_verify' });
    const rule = { ...pack, snapshot: { ...pack.snapshot, embeddedRules: [{ prefix: '2', itemStart: 1, itemLength: 6, valueStart: 7, valueLength: 5, valueKind: 'price' as const }] } };
    expect(acceptPack({ incoming: rule, signer, tenantId: 't-f1' }).accepted).toBe(false);
    const { unitsSigned: _m, ...stripped } = pack.snapshot;
    void _m;
    expect(acceptPack({ incoming: { ...pack, snapshot: stripped }, signer, tenantId: 't-f1' }).accepted).toBe(false);
    expect(acceptPack({ incoming: { ...pack, snapshot: { ...stripped, products: kgToL.snapshot.products } }, signer, tenantId: 't-f1' }).accepted).toBe(false);
  });

  it('a pack signed BEFORE (no marker) signs to exactly the bytes it always did, so a box\'s held pack still verifies', () => {
    const signer = hmacSigner(['f1', 'pack', 'key'].join('-').padEnd(40, '0'));
    const tiny: CatalogueSnapshot = {
      tenantId: 't', version: 1, builtAt: '2026-10-01T00:00:00.000Z',
      products: [{ productId: 'P1', sku: 'S1', name: 'n', baseUom: 'kg', unitPriceMinor: 100, taxBps: 0, status: 'active' }],
      barcodes: [{ code: '890', productId: 'P1', kind: 'standard' }],
      embeddedRules: [{ prefix: '2', itemStart: 1, itemLength: 6, valueStart: 7, valueLength: 5, valueKind: 'weight' }],
    };
    // The canonical text of the pre-F1 code, written out: no unit, no barcode rule, no section marker.
    const F = '\u001f'; const R = '\u001e';
    expect(canonicalise(tiny)).toBe(['t', '1', '2026-10-01T00:00:00.000Z', ['P1', 'S1', '100', '0', '', 'active', '0'].join(F), '--', ['890', 'P1', 'standard'].join(F)].join(R));
    const held = { snapshot: tiny, signature: signer.sign(canonicalise(tiny)), publishedBy: 'u', publishedAt: '2026-10-01T00:00:00.000Z' };
    expect(acceptPack({ incoming: held, signer, tenantId: 't' }).accepted).toBe(true);
  });
});

describe('OB-160 "A" — tobacco sells in whole packs only', () => {
  it('the engine: 15 of a pack of 10 is refused, 10 and 20 sell, below one pack keeps its own reason', () => {
    const line = (q: number) => productRuleRefusals({ productId: 'P-CIG', description: 'Cigarettes', quantityMinor: q, uom: 'ea', unitPriceMinor: 18_00, regulatedFlags: { tobacco: true, packMinimumMinor: 10 } }).map((r) => r.reason);
    expect(line(15)).toEqual(['tobacco_not_whole_packs']);
    expect(line(10)).toEqual([]);
    expect(line(20)).toEqual([]);
    expect(line(5)).toEqual(['tobacco_below_pack']);
    expect(checkRestrictedSale({ lines: [{ lineId: 'l', productId: 'p', quantityMinor: 15, uom: 'ea', ageRestricted: true, restrictionKind: 'tobacco', minSaleQuantityMinor: 10 }], ageVerification: { verified: true } }).allowed).toBe(true); // opt-in: the stand-alone engine is unchanged
    const words = productRuleRefusals({ productId: 'P-CIG', description: 'Cigarettes', quantityMinor: 15, uom: 'ea', unitPriceMinor: 18_00, regulatedFlags: { tobacco: true, packMinimumMinor: 10 } })[0]!.laneMessage;
    expect(words).toBe('Cigarettes is tobacco and is sold only in whole packs of 10. This line is 15, which is not a whole number of packs — make it 10 or 20.');
  });

  it('the till: refused at the scan and at a quantity change (the line keeps its packs); the commit re-asks', async () => {
    const { pos, written } = till(BASE);
    pos.confirmAge(18, NOW, 'P-CIG');
    expect((await refused(() => pos.scan({ productId: 'P-CIG', description: 'Cigarette sticks (demo)', unitPriceMinor: 18_00, qty: 15 }))).refusals[0]?.reason).toBe('tobacco_not_whole_packs');
    pos.scan({ productId: 'P-CIG', description: 'Cigarette sticks (demo)', unitPriceMinor: 18_00, qty: 10 });
    const lineId = pos.basket()[0]!.lineId;
    expect((await refused(() => pos.setQuantity(lineId, 25))).refusals[0]?.reason).toBe('tobacco_not_whole_packs');
    expect(pos.basket()[0]!.qty).toBe(10);
    pos.setQuantity(lineId, 30);
    await pos.tenderCash('S-T', 'R-T', NOW);
    expect((written[0]!['lines'] as { quantityMinor: number }[])[0]!.quantityMinor).toBe(30);
  });

  it('the store computer refuses a part pack before its disk; head office raises it critical', () => {
    const rec = { id: 'S', lines: [{ productId: 'P-CIG', quantityMinor: 15, uom: 'ea', unitPriceMinor: 18_00, lineTotalMinor: 270_00 }] };
    expect(checkTillRules(rec, { products: products(BASE), scales: CURRENT, today: day(0) })).toMatchObject({ ok: false, refusedBecause: 'tobacco_not_whole_packs' });
    const res = acceptSale(sale([{ productId: 'P-CIG', quantityMinor: 15, uom: 'ea', unitPriceMinor: 18_00, lineTotalMinor: 270_00, ageCheck: { minimumAge: 18, confirmedAtLeast: 18, confirmedBy: 'u', confirmedAt: NOW } }]), intakeCtx(BASE));
    expect(res.exceptions.map((x) => [x.kind, x.severity])).toContainEqual(['tobacco_sold_below_pack', 'critical']);
  });
});

describe('L1 (B5) — a part return of a weighed line is never rounded against the customer', () => {
  const bill: OriginalSale = {
    saleId: 'S-W', number: 'R-W', tradingDay: day(0), committedAt: NOW, totalMinor: 336,
    lines: [{ productId: 'P-BAN', quantityMinor: 337, uom: 'kg', lineTotalMinor: 336 } as OriginalSale['lines'][number]],
  };
  it('170 g of 337 g charged 336 paise is worth 169.4955 → 170 (up, the customer\'s way), never 169', () => {
    expect(returnedValueAtOriginalPrices(bill, [{ productId: 'P-BAN', quantityMinor: 170 }])).toBe(170);
  });
  it('the parts add up to exactly what the bill charged, never a paisa more', () => {
    const first = returnedValueAtOriginalPrices(bill, [{ productId: 'P-BAN', quantityMinor: 170 }]);
    const second = returnedValueAtOriginalPrices(bill, [{ productId: 'P-BAN', quantityMinor: 167 }], [{ productId: 'P-BAN', quantityMinor: 170 }]);
    expect(first + second).toBe(336);
    expect(returnedValueAtOriginalPrices(bill, [{ productId: 'P-BAN', quantityMinor: 337 }])).toBe(336);
    // Three pieces too.
    const a = returnedValueAtOriginalPrices(bill, [{ productId: 'P-BAN', quantityMinor: 100 }]);
    const b = returnedValueAtOriginalPrices(bill, [{ productId: 'P-BAN', quantityMinor: 100 }], [{ productId: 'P-BAN', quantityMinor: 100 }]);
    const c = returnedValueAtOriginalPrices(bill, [{ productId: 'P-BAN', quantityMinor: 137 }], [{ productId: 'P-BAN', quantityMinor: 200 }]);
    expect(a + b + c).toBe(336);
    for (const v of [a, b, c]) expect(v).toBeGreaterThan(0);
  });
  it('an exchange of the rest of the line after an earlier part return is not refused for a rounding paisa', () => {
    const r = assessExchange({
      sale: bill,
      priorReturns: [{ returnId: 'RET-1', originalSaleId: 'S-W', processedAt: NOW, lines: [{ productId: 'P-BAN', quantityMinor: 170 } as never] }],
      priorRefunds: [{ returnId: 'RET-1', originalSaleId: 'S-W', refundMinor: 170 }],
      exchange: { exchangeId: 'EX-1', returnLines: [{ productId: 'P-BAN', quantityMinor: 167, disposition: 'resell' } as never], replacementLines: [{ productId: 'P-RICE', uom: 'ea', quantityMinor: 1, unitPriceMinor: 166, lineTotalMinor: 166 } as never] },
    });
    expect(r.returnedValueMinor).toBe(166);
    expect(r.ok).toBe(true);
  });
});
