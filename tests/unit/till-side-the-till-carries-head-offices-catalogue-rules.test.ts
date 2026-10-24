import { describe, it, expect } from 'vitest';
import { PosSession, TillRuleRefusedError, DeliveryNotAvailableError, DELIVERY_FEE_NOT_SET_WORDS, type ScanInput } from '../../apps/pos/src/session';
import { money } from '../../packages/contracts/src/money';
import { rate } from '../../packages/contracts/src/rate';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';
import type { Promotion } from '../../packages/promotions/src/promotions';
import { BANK_OFFERS, BANK_OFFERS_RELEASE } from '../../packages/promotions/src/bank-offers';
import type { BundleDefinition } from '../../packages/product/src/bundles';
import { liquorRuleForState, isIndianStateCode, shopStateFromGstin, GST_STATE_CODE_TO_STATE, INDIAN_STATES, RECORDED_STATE_LIQUOR_RULES } from '../../packages/restricted-sales/src/liquor';
import { tillLineRefusals, productRuleRefusals } from '../../packages/restricted-sales/src/till-gate';
import { buildCatalogueSnapshot } from '../../packages/catalogue/src/snapshot-builder';
import { CatalogueCache } from '../../packages/catalogue/src/catalogue';
import { canonicalise, hmacSigner, publishPack, acceptPack } from '../../services/catalogue/src/index';
import { checkTillRules } from '../../edge/store-edge/src/lane-scales';
import { toCloudSale } from '../../edge/store-edge/src/cloud-sale';
import { toCloudReturn } from '../../edge/store-edge/src/cloud-return';
import { acceptSale, type IncomingSale, type IntakeContext } from '../../services/pos/src/index';
import { saleStockMovements, returnStockMovements, bundlesOfReturn } from '../../services/pos/src/sale-stock';
import { setupItem } from '../../packages/tenant/src/setup';
import { HIGH_IMPACT_SETTINGS } from '../../services/platform/src/governed-config';
import type { CatalogueProduct } from '../../packages/catalogue/src/catalogue';

/**
 * **OB-288 till-side completion — head office's new catalogue rules, carried onto the till (hard rule #1: every one is
 * judged from what the lane already holds, no network).**
 *
 *   • B15 — an offer naming tobacco is refused at the till; a basket-wide offer never reaches a tobacco line; bank offers
 *     stay off until R4 (OB-349);
 *   • B17 · OB-348 — liquor is judged by the shop's state (Tamil Nadu refuses — TASMAC); a line under an alcoholic-drink HSN
 *     with no flag is refused at the scan, at the commit, on the box and flagged at head office; the pack leaves it out;
 *   • OB-306 — a bundle line is exploded into its components at the till, on the record, and into one stock movement per
 *     component at head office (a return puts the components back); the bundles ride the pack under its signature;
 *   • OB-299 — a delivery sale: the owner's fee line, once, paid in full; "not set" refused in words.
 */

const AT = '2026-10-24T09:00:00.000Z';
const cash = (minor: number) => [{ kind: 'cash' as const, amount: money(minor, 'INR'), status: 'settled' as const }];
const window = { startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-12-31T00:00:00.000Z', status: 'active' as const };

const FLAGS: Record<string, Readonly<Record<string, unknown>>> = {
  'p-cig': { tobacco: true, packMinimumMinor: 1, minimumAge: 18 },
};
const HSN: Record<string, string> = { 'p-beer': '22030000', 'p-rice': '1006', 'p-dal': '0713' };
const UOM: Record<string, string> = { 'p-dal': 'ea', 'p-oil': 'ea', 'p-sugar': 'kg' };
const COMBO: BundleDefinition = {
  bundleProductId: 'p-combo', version: 2, reason: 'festival pack', definedBy: 'u-cat', definedAt: '2026-10-01T00:00:00.000Z',
  components: [{ productId: 'p-dal', quantityMinor: 2 }, { productId: 'p-oil', quantityMinor: 1 }, { productId: 'p-sugar', quantityMinor: 500 }],
};

const tillWith = (extra: Partial<ConstructorParameters<typeof PosSession>[0]> = {}) => {
  const written: Record<string, unknown>[] = [];
  const ledger = new Ledger(new InMemoryLedgerStore());
  const s = new PosSession(
    {
      laneId: 'lane-1', cashierId: 'u-meena', currency: 'INR', defaultTaxRate: rate(500), clock: () => AT,
      regulatedFlagsOf: (id) => FLAGS[id], hsnCodeOf: (id) => HSN[id], baseUomOf: (id) => UOM[id],
      bundleOf: (id) => (id === 'p-combo' ? COMBO : undefined), ...extra,
    },
    ledger, new SyncOutbox(),
    async (_id, record) => { written.push(JSON.parse(record) as Record<string, unknown>); return { committed: true } as never; },
  );
  return { s, written, ledger };
};
const item = (productId: string, priceMinor: number, qty = 1, extra: Partial<ScanInput> = {}): ScanInput =>
  ({ productId, description: productId, unitPrice: money(priceMinor, 'INR'), quantityMinor: qty, uom: 'ea', ...extra });

describe('B15 — no offer reaches tobacco at the till', () => {
  it('an offer that names a tobacco product is refused whole and said; one naming tobacco only on a mix-match side or a bundle-price set too', () => {
    const { s } = tillWith();
    s.loadPromotions([
      { id: 'cig-10', kind: 'percent_off', percentBps: 1000, productIds: ['p-cig'], ...window },
      { id: 'combo-set', kind: 'bundle_price', bundleItems: [{ productId: 'p-rice', qty: 1 }, { productId: 'p-cig', qty: 1 }], bundlePriceMinor: 10_000, ...window },
      { id: 'mm', kind: 'mix_match', buyProductIds: ['p-rice'], buyQty: 1, getProductIds: ['p-cig'], getQty: 1, getPercentBps: 10_000, ...window },
      { id: 'rice-5', kind: 'percent_off', percentBps: 500, productIds: ['p-rice'], ...window },
    ] as Promotion[]);
    expect(s.refusedOffers().map((r) => [r.offerId, r.tobaccoProductIds])).toEqual([['cig-10', ['p-cig']], ['combo-set', ['p-cig']], ['mm', ['p-cig']]]);
    expect(s.refusedOffers()[0]!.laneMessage).toBe('Offer cig-10 names tobacco (p-cig), so this till does not apply it — tobacco may not be promoted. Tell the manager.');
  });

  it('a basket-wide 10% off takes nothing off the cigarettes: the whole discount is spread over the rice', () => {
    const { s } = tillWith();
    s.loadPromotions([{ id: 'all-10', kind: 'percent_off', percentBps: 1000, ...window } as Promotion]);
    s.confirmAge(18, AT);
    s.scan(item('p-cig', 18_000, 1, { regulatedFlags: FLAGS['p-cig'] }));
    s.scan(item('p-rice', 10_000));
    // 10% of the rice only — the cigarettes are charged their price.
    expect(s.totals().payable.minor).toBe(18_000 + 9_000);
  });

  it('bank offers stay off until R4 (OB-305 · OB-349): the till never passes an issuer, so one never applies', () => {
    expect(BANK_OFFERS.on).toBe(false);
    expect(BANK_OFFERS_RELEASE).toBe('R4');
    const { s } = tillWith();
    s.loadPromotions([{ id: 'bank-x', kind: 'bank_offer', bankIssuer: 'Bank X', percentBps: 1000, ...window } as Promotion]);
    s.scan(item('p-rice', 10_000));
    expect(s.totals().payable.minor).toBe(10_000);
  });
});

describe('OB-306 · M05-FR-03 — multibuy, the price-offer bundle and mix-match at the till (the same bestPrice engine)', () => {
  it('3 for ₹99, the named set at one price, and buy-rice-get-dal-half-off each price the basket as head office defined them', () => {
    const multi = tillWith();
    multi.s.loadPromotions([{ id: '3-for-99', kind: 'multibuy', productIds: ['p-soap'], multibuyQty: 3, multibuyPriceMinor: 9_900, ...window } as Promotion]);
    multi.s.scan(item('p-soap', 4_000, 4));
    expect(multi.s.totals().payable.minor).toBe(9_900 + 4_000);

    const set = tillWith();
    set.s.loadPromotions([{ id: 'set', kind: 'bundle_price', bundleItems: [{ productId: 'p-rice', qty: 1 }, { productId: 'p-dal', qty: 2 }], bundlePriceMinor: 25_000, ...window } as Promotion]);
    set.s.scan(item('p-rice', 10_000));
    set.s.scan(item('p-dal', 9_000, 2));
    expect(set.s.totals().payable.minor).toBe(25_000);

    const mm = tillWith();
    mm.s.loadPromotions([{ id: 'mm', kind: 'mix_match', buyProductIds: ['p-rice'], buyQty: 1, getProductIds: ['p-dal'], getQty: 1, getPercentBps: 5_000, ...window } as Promotion]);
    mm.s.scan(item('p-rice', 10_000));
    mm.s.scan(item('p-dal', 9_000));
    expect(mm.s.totals().payable.minor).toBe(10_000 + 4_500);
  });
});

describe('B17 · OB-348 — liquor, by the shop\'s state', () => {
  it('the state rule: Tamil Nadu refuses (TASMAC); not set refuses and says so; a state with no recorded rule refuses until the owner records one', () => {
    expect(liquorRuleForState('TN')).toMatchObject({ refused: true, basis: 'state_monopoly', state: 'TN' });
    expect(liquorRuleForState('TN').laneWords.en).toMatch(/TASMAC/);
    expect(liquorRuleForState(undefined)).toMatchObject({ refused: true, basis: 'state_not_set' });
    expect(liquorRuleForState('XX')).toMatchObject({ refused: true, basis: 'state_not_set' });
    expect(liquorRuleForState('KA')).toMatchObject({ refused: true, basis: 'no_rule_recorded_for_state', state: 'KA' });
    expect(liquorRuleForState('KA').laneWords.ta).toMatch(/கர்நாடகா/);
    expect(isIndianStateCode('TN')).toBe(true);
    expect(isIndianStateCode('tn')).toBe(false);
  });

  it('a beer under HSN 2203 with NO liquor flag is refused at the scan, naming the shop\'s state; nothing joins the bill', () => {
    const { s } = tillWith({ shopState: 'TN' });
    let caught: unknown;
    try { s.scan(item('p-beer', 15_000)); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(TillRuleRefusedError);
    expect((caught as TillRuleRefusedError).refusals.map((r) => r.reason)).toEqual(['liquor_not_sold']);
    expect((caught as TillRuleRefusedError).laneMessage).toBe('p-beer is liquor. Liquor is not sold here: in Tamil Nadu retail liquor is a TASMAC state monopoly. Keep it off the bill and tell the manager.');
    expect(s.basket()).toHaveLength(0);
    // With the state not set, the words say so — still refused.
    const unset = tillWith();
    let unsetCaught: unknown;
    try { unset.s.scan(item('p-beer', 15_000)); } catch (e) { unsetCaught = e; }
    expect((unsetCaught as TillRuleRefusedError).laneMessage).toMatch(/the shop's state is not set/);
  });

  it('a held basket recalled with a beer on it is refused at the commit (the line check reads the pack\'s HSN), before the disk', async () => {
    const { s, written } = tillWith({ shopState: 'TN' });
    s.restoreHeld([{ lineId: 'L1', productId: 'p-beer', description: 'Beer 650ml', unitPriceMinor: 15_000, quantityMinor: 1, uom: 'ea', taxBps: 2800, voided: false }]);
    await expect(s.commit('S-B', 'N-B', AT, cash(15_000))).rejects.toBeInstanceOf(TillRuleRefusedError);
    expect(written).toHaveLength(0);
  });

  it('the box refuses a liquor record before its disk from its own catalogue\'s HSN (or the line\'s), with the state\'s words', () => {
    const products = new Map([['p-beer', { name: 'Beer 650ml', baseUom: 'ea', unitPriceMinor: 15_000, hsnCode: '2203' }]]);
    const record = { lines: [{ productId: 'p-beer', quantityMinor: 1, uom: 'ea', unitPriceMinor: 15_000, lineTotalMinor: 15_000 }] };
    const answer = checkTillRules(record, { products, scales: { known: false, why: 'none' }, today: '2026-10-24', shopState: 'TN' });
    expect(answer).toMatchObject({ ok: false, refusedBecause: 'liquor_not_sold', productId: 'p-beer' });
    // A product the box does not know, sold under a liquor HSN frozen on the line, is refused too.
    expect(checkTillRules({ lines: [{ productId: 'p-x', quantityMinor: 1, uom: 'ea', unitPriceMinor: 1, lineTotalMinor: 1, hsnCode: '2208' }] }, { products: new Map(), scales: { known: false, why: 'none' }, today: '2026-10-24' }))
      .toMatchObject({ ok: false, refusedBecause: 'liquor_not_sold' });
  });

  it('head office\'s intake raises "liquor sold", critical, for a line under a liquor HSN — the sale still banks', () => {
    const catalogue = new Map<string, CatalogueProduct>([['p-beer', { productId: 'p-beer', sku: 'BEER', name: 'Beer', baseUom: 'ea', unitPriceMinor: 15_000, taxBps: 2800, status: 'active', hsnCode: '2203' }]]);
    const sale: IncomingSale = {
      saleId: 'S-L', receiptNumber: 'L1-0001', laneId: 'lane-1', cashierId: 'u-meena', tradingDay: '2026-10-24', committedAt: AT, totalMinor: 15_000, currency: 'INR', packVersion: 3,
      lines: [{ productId: 'p-beer', quantityMinor: 1, uom: 'ea', unitPriceMinor: 15_000, lineTotalMinor: 15_000 }], tenders: [{ kind: 'cash', amountMinor: 15_000 }],
    };
    const ctx: IntakeContext = { catalogue, currentPackVersion: 3, saleHoldingThisReceipt: undefined, alreadyBanked: false, now: AT, shopState: 'TN' };
    const r = acceptSale(sale, ctx);
    expect(r.banked).toBe(true);
    const found = r.exceptions.find((e) => e.kind === 'liquor_sold');
    expect(found?.severity).toBe('critical');
    expect(found?.detail).toMatch(/TASMAC/);
    // The same rule by itself, and the pure gate with the state passed through.
    expect(productRuleRefusals({ productId: 'p', description: 'p', quantityMinor: 1, uom: 'ea', unitPriceMinor: 1, hsnCode: '2204' }, { shopState: 'TN' })[0]?.reason).toBe('liquor_not_sold');
    expect(tillLineRefusals({ productId: 'p', description: 'Wine', quantityMinor: 1, uom: 'ea', unitPriceMinor: 1, regulatedFlags: { liquor: true } }, { shopState: 'KA' })[0]?.laneMessage)
      .toBe('Wine is liquor. Liquor cannot be sold: no liquor rule is recorded in writing for Karnataka. Keep it off the bill and tell the manager.');
    // Non-alcoholic beer (2202) is not caught.
    expect(productRuleRefusals({ productId: 'p', description: 'p', quantityMinor: 1, uom: 'ea', unitPriceMinor: 1, hsnCode: '22029990' })).toEqual([]);
  });

  it('a liquor product never reaches a pack: left out as "liquor_not_sold", with its reason', () => {
    const built = buildCatalogueSnapshot({
      scope: { tenantId: 't', storeId: 'S1' }, version: 1, asOf: AT,
      products: [
        { productId: 'p-beer', sku: 'BEER', name: 'Beer', baseUom: 'ea', taxClassId: '2203', status: 'active' },
        { productId: 'p-rice', sku: 'RICE', name: 'Rice', baseUom: 'ea', taxClassId: '1006', status: 'active' },
      ],
      barcodes: [], taxClasses: { '2203': 2800, '1006': 0 },
      priceEntries: ['p-beer', 'p-rice'].map((productId) => ({ id: `e-${productId}`, productId, scope: 'store' as const, scopeRef: 'S1', price: money(10_000, 'INR'), effectiveFrom: '2026-01-01T00:00:00.000Z', status: 'active' as const, version: 1 })),
    });
    expect(built.excluded).toEqual([{ productId: 'p-beer', sku: 'BEER', reason: 'liquor_not_sold' }]);
    expect(built.snapshot.products.map((p) => p.productId)).toEqual(['p-rice']);
  });

  it('OB-354: there is no business-wide state setting — each store\'s state is read from its GSTIN', () => {
    expect(setupItem('store.state')).toBeUndefined();
    expect(HIGH_IMPACT_SETTINGS['store.state']).toBeUndefined();
    expect(shopStateFromGstin('33AAACS1111A2ZG')).toEqual({ known: true, state: 'TN', gstStateCode: '33', gstin: '33AAACS1111A2ZG' });
    expect(shopStateFromGstin(' 29aaacs1111a1z6 ')).toMatchObject({ known: true, state: 'KA', gstStateCode: '29' });
    expect(shopStateFromGstin('25AAACS1111A1Z6')).toMatchObject({ known: true, state: 'DH' }); // Daman and Diu, merged in 2020
    expect(shopStateFromGstin(undefined)).toEqual({ known: false, why: 'no_gstin' });
    expect(shopStateFromGstin('')).toEqual({ known: false, why: 'no_gstin' });
    expect(shopStateFromGstin('97AAACS1111A1Z6')).toMatchObject({ known: false, why: 'not_a_state_code', gstStateCode: '97' });
    expect(shopStateFromGstin('28AAACS1111A1Z6')).toMatchObject({ known: false, why: 'not_a_state_code' });
    // Every GST state code maps to a state the liquor rule knows.
    for (const [code, iso] of Object.entries(GST_STATE_CODE_TO_STATE)) expect(INDIAN_STATES[iso], code).toBeDefined();
  });

  it('OB-353: liquor is refused in EVERY state; only Tamil Nadu\'s rule is recorded in writing, and it refuses', () => {
    expect(RECORDED_STATE_LIQUOR_RULES.map((r) => [r.state, r.rule])).toEqual([['TN', 'refused']]);
    expect(RECORDED_STATE_LIQUOR_RULES[0]!.recordedIn).toMatch(/OB-353/);
    for (const state of Object.keys(INDIAN_STATES)) {
      const rule = liquorRuleForState(state);
      expect(rule.refused, state).toBe(true);
      expect(rule.basis, state).toBe(state === 'TN' ? 'state_monopoly' : 'no_rule_recorded_for_state');
      expect(rule.laneWords.en, state).toMatch(/Liquor (is not sold|cannot be sold)/);
      expect(rule.laneWords.ta, state).toMatch(/மதுபானம்/);
    }
    expect(liquorRuleForState('KA').why).toMatch(/recorded in writing for Karnataka/);
    expect(liquorRuleForState(undefined)).toMatchObject({ refused: true, basis: 'state_not_set' });
    expect(liquorRuleForState(undefined).laneWords.en).toMatch(/GSTIN/);
  });
});

describe('OB-306 — an own-barcode bundle is exploded at the till and moved component by component', () => {
  it('the commit freezes the explosion on the line and the till\'s own stock moves the components (one line per product)', async () => {
    const { s, written, ledger } = tillWith();
    s.scan(item('p-combo', 49_900, 2));
    s.scan(item('p-dal', 9_000, 1));
    await s.commit('S-C', 'N-C', AT, cash(49_900 * 2 + 9_000));
    const line = (written[0]!['lines'] as Record<string, unknown>[])[0]!;
    expect(line['bundle']).toEqual({
      bundleProductId: 'p-combo', version: 2,
      components: [{ productId: 'p-dal', quantityMinor: 4, uom: 'ea' }, { productId: 'p-oil', quantityMinor: 2, uom: 'ea' }, { productId: 'p-sugar', quantityMinor: 1000, uom: 'kg' }],
    });
    const moved = ledger.entries().map((e) => e.event.payload as { productId: string; deltaMinor: number });
    expect(moved.map((m) => [m.productId, m.deltaMinor])).toEqual([['p-dal', -5], ['p-oil', -2], ['p-sugar', -1000]]);
    // The box sends the line as written; head office writes one sold movement per component, keyed on line and component.
    const sale = toCloudSale(written[0], 3, 'S1', 'lane-1');
    const movements = saleStockMovements(sale, { locationId: 'S1', basis: 'declared_by_lane' });
    expect(movements.map((m) => [m.movementId, m.productId, m.quantityMinor, m.uom])).toEqual([
      ['sale-S-C-0-c0', 'p-dal', 4, 'ea'], ['sale-S-C-0-c1', 'p-oil', 2, 'ea'], ['sale-S-C-0-c2', 'p-sugar', 1000, 'kg'], ['sale-S-C-1', 'p-dal', 1, 'ea'],
    ]);
    expect(movements[0]!.reason).toMatch(/component of bundle p-combo \(definition v2\)/);
  });

  it('a return of one bundle out of two puts back half the components — from the bill\'s own explosion — and a malformed explosion is ignored', () => {
    const sold = { lines: [{ productId: 'p-combo', quantityMinor: 2, bundle: { bundleProductId: 'p-combo', version: 2, components: [{ productId: 'p-dal', quantityMinor: 4 }, { productId: 'p-oil', quantityMinor: 2 }] } }] };
    const lines = bundlesOfReturn(sold, [{ productId: 'p-combo', quantityMinor: 1, uom: 'ea', disposition: 'resell' }]);
    expect(lines[0]!.bundle).toEqual({ bundleProductId: 'p-combo', version: 2, components: [{ productId: 'p-dal', quantityMinor: 2 }, { productId: 'p-oil', quantityMinor: 1 }] });
    const back = returnStockMovements({ returnId: 'RT-1', processedAt: AT, processedBy: 'u-meena', lines }, { locationId: 'S1', basis: 'declared_by_lane' });
    expect(back.map((m) => [m.movementId, m.productId, m.quantityMinor, m.kind])).toEqual([['return-RT-1-0-c0', 'p-dal', 2, 'returned'], ['return-RT-1-0-c1', 'p-oil', 1, 'returned']]);
    expect(saleStockMovements({ ...toCloudSale({ id: 'S-X', lines: [{ productId: 'p-combo', quantityMinor: 1, uom: 'ea', unitPriceMinor: 1, lineTotalMinor: 1, bundle: { components: 'nope' } }] }, 1) }, { locationId: 'S1', basis: 'declared_by_lane' })
      .map((m) => m.productId)).toEqual(['p-combo']);
    // The box carries a till-made explosion on a return line to head office.
    expect(toCloudReturn({ returnId: 'RT-2', lines: [{ productId: 'p-combo', uom: 'ea', quantityMinor: 1, disposition: 'resell', bundle: { bundleProductId: 'p-combo', version: 2, components: [{ productId: 'p-dal', quantityMinor: 2 }] } }] }).lines[0]?.bundle)
      .toEqual({ bundleProductId: 'p-combo', version: 2, components: [{ productId: 'p-dal', quantityMinor: 2 }] });
  });

  it('the bundles ride the pack under its signature: an edited bundle fails to verify; the lane\'s cache serves the latest version', () => {
    const signer = hmacSigner('bundle-pack-key'.padEnd(48, '0'));
    const snapshot = {
      tenantId: 't', version: 4, builtAt: AT, barcodes: [],
      products: [{ productId: 'p-combo', sku: 'COMBO', name: 'Festival combo', baseUom: 'ea', unitPriceMinor: 49_900, taxBps: 500, status: 'active' as const }],
      bundles: [{ ...COMBO, version: 1 }, COMBO],
    };
    const published = publishPack({ snapshot, approvals: [], signer, publishedBy: 'u-cat', publishedAt: AT });
    expect(published.ok).toBe(true);
    const pack = published.pack!;
    expect(canonicalise(pack.snapshot)).toMatch(/--bundles/);
    const edited = { ...pack, snapshot: { ...pack.snapshot, bundles: [{ ...COMBO, components: [{ productId: 'p-dal', quantityMinor: 1 }, { productId: 'p-oil', quantityMinor: 1 }] }] } };
    expect(acceptPack({ incoming: edited, signer, tenantId: 't' }).accepted).toBe(false);
    expect(acceptPack({ incoming: pack, signer, tenantId: 't' }).accepted).toBe(true);
    expect(new CatalogueCache(pack.snapshot).bundleOf('p-combo')?.version).toBe(2);
    // A pack without bundles signs to exactly the bytes it always did (a held pack still verifies).
    const { bundles: _b, ...plain } = snapshot;
    void _b;
    expect(canonicalise({ ...plain, unitsSigned: true })).not.toMatch(/--bundles/);
  });
});

describe('OB-299 — the delivery sale at the till', () => {
  const FEE = item('p-delivery', 3_000, 1, { taxRate: rate(1800), hsnCode: '996813' });

  it('not set by the owner: refused in words, nothing added; the fee product missing from the pack: refused too', () => {
    const { s } = tillWith();
    expect(() => s.markForDelivery(FEE)).toThrow(DeliveryNotAvailableError);
    try { s.markForDelivery(FEE); } catch (e) { expect((e as DeliveryNotAvailableError).laneMessage).toBe(DELIVERY_FEE_NOT_SET_WORDS); }
    const missing = tillWith({ deliveryFeeProductId: 'p-delivery' });
    let missingCaught: unknown;
    try { missing.s.markForDelivery(undefined); } catch (e) { missingCaught = e; }
    expect((missingCaught as DeliveryNotAvailableError).refusedBecause).toBe('delivery_fee_not_in_catalogue');
    expect((missingCaught as DeliveryNotAvailableError).laneMessage).toMatch(/is not in this till's catalogue/);
    expect(missing.s.basket()).toHaveLength(0);
  });

  it('the fee line is added once (₹0 allowed); the customer pays the whole bill; the record says "deliver" with the fee', async () => {
    const { s, written } = tillWith({ deliveryFeeProductId: 'p-delivery' });
    s.scan(item('p-rice', 10_000));
    const fee = s.markForDelivery(FEE);
    expect(s.markForDelivery(FEE).lineId).toBe(fee.lineId);
    expect(s.basket().map((l) => l.productId)).toEqual(['p-rice', 'p-delivery']);
    await s.commit('S-D', 'N-D', AT, cash(13_000));
    expect(written[0]!['delivery']).toEqual({ requested: true, feeProductId: 'p-delivery', feeMinor: 3_000 });
    expect(toCloudSale(written[0], 3).delivery).toEqual({ requested: true, feeProductId: 'p-delivery', feeMinor: 3_000 });

    const free = tillWith({ deliveryFeeProductId: 'p-delivery' });
    free.s.scan(item('p-rice', 10_000));
    free.s.markForDelivery({ ...FEE, unitPrice: money(0, 'INR') });
    await free.s.commit('S-F', 'N-F', AT, cash(10_000));
    expect(free.written[0]!['delivery']).toEqual({ requested: true, feeProductId: 'p-delivery', feeMinor: 0 });
  });

  it('taken off: the fee line is voided with the reason (kept as evidence) and the bill is a normal sale; a new bill is never marked', async () => {
    const { s, written } = tillWith({ deliveryFeeProductId: 'p-delivery' });
    s.scan(item('p-rice', 10_000));
    s.markForDelivery(FEE);
    s.unmarkDelivery('customer will carry it');
    expect(s.deliveryLine()).toBeUndefined();
    expect(s.basket().find((l) => l.productId === 'p-delivery')).toMatchObject({ voided: true, voidReason: 'customer will carry it' });
    await s.commit('S-N', 'N-N', AT, cash(10_000));
    expect(written[0]!['delivery']).toBeUndefined();
    s.newSale();
    expect(s.deliveryLine()).toBeUndefined();
  });

  it('a held bill with the fee line comes back marked for delivery', () => {
    const { s } = tillWith({ deliveryFeeProductId: 'p-delivery' });
    s.restoreHeld([
      { lineId: 'L1', productId: 'p-rice', description: 'Rice', unitPriceMinor: 10_000, quantityMinor: 1, uom: 'ea', taxBps: 0, voided: false },
      { lineId: 'L2', productId: 'p-delivery', description: 'Home delivery', unitPriceMinor: 3_000, quantityMinor: 1, uom: 'ea', taxBps: 1800, voided: false },
    ]);
    expect(s.deliveryLine()?.productId).toBe('p-delivery');
  });
});
