import { describe, it, expect } from 'vitest';
import { PosSession, type ScanInput } from '../../apps/pos/src/session';
import { customerDisplayFrame } from '../../apps/pos/src/customer-display';
import { money } from '../../packages/contracts/src/money';
import { rate } from '../../packages/contracts/src/rate';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';
import type { Promotion } from '../../packages/promotions/src/promotions';
import { onlineStoreRoutes, onlineSaleOf, type OnlineStoreDeps } from '../../services/orders/src/storefront-online-store';
import { bundleProblems } from '../../packages/product/src/bundles';
import { substituteProblems } from '../../packages/product/src/substitutes';
import type { ProductRecord } from '../../packages/product/src/index';

/**
 * **B15 (COTPA 2003 s.5): tobacco is never promoted — the surfaces beyond the till's offers**, each asking the one guard
 * (`tobaccoAdvertisingRefusal`): the CUSTOMER DISPLAY (an offer naming tobacco never reaches the screen the customer
 * reads), the customer's ONLINE LISTING and "sold online" answer, BUNDLES (holding tobacco or being tobacco) and
 * SUBSTITUTES (the guard's own words). Recommendations, the online-listing route and cart reminders run through the real
 * API in the integration test of the same name.
 */

const AT = '2026-10-26T09:00:00.000Z';
const window = { startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-12-31T00:00:00.000Z', status: 'active' as const };
const FLAGS: Record<string, Readonly<Record<string, unknown>>> = { 'p-cig': { tobacco: true, packMinimumMinor: 1, minimumAge: 18 } };
const item = (productId: string, priceMinor: number): ScanInput => ({ productId, description: productId, unitPrice: money(priceMinor, 'INR'), quantityMinor: 1, uom: 'ea' });
const product = (productId: string, safety: Record<string, unknown> = {}): ProductRecord =>
  ({ productId, tenantId: 't', sku: productId, name: productId, baseUom: 'ea', primaryCategoryId: 'c', taxClass: '2402', lifecycle: 'active', safety }) as unknown as ProductRecord;

describe('B15 — the customer display never shows an offer on tobacco', () => {
  it('a tobacco offer loaded on the till is refused, so the display shows the tobacco line at its price and no saving; a rice offer still shows', () => {
    const s = new PosSession(
      { laneId: 'lane-1', cashierId: 'u-meena', currency: 'INR', defaultTaxRate: rate(500), clock: () => AT, regulatedFlagsOf: (id) => FLAGS[id] },
      new Ledger(new InMemoryLedgerStore()), new SyncOutbox(), async () => ({ committed: true }) as never,
    );
    s.loadPromotions([
      { id: 'cig-10', kind: 'percent_off', percentBps: 1000, productIds: ['p-cig'], ...window },
      { id: 'rice-5', kind: 'percent_off', percentBps: 500, productIds: ['p-rice'], ...window },
    ] as Promotion[]);
    expect(s.refusedOffers().map((r) => r.offerId)).toEqual(['cig-10']);
    s.confirmAge(18, AT, 'p-cig'); // the cashier checked the customer is 18 or over (B14)
    s.scan(item('p-cig', 20_000));
    const frameOf = () => {
      const totals = s.totals();
      return customerDisplayFrame({
        laneId: 'lane-1', basket: s.basket().map((l) => ({ description: l.description, qty: l.quantityMinor, uom: l.uom, voided: l.voided })),
        lineTotalsMinor: s.replacementLines().map((l) => l.lineTotalMinor + (l.discountMinor ?? 0)),
        promotionDiscountMinor: totals.promotionDiscount.minor, payableMinor: totals.payable.minor, currency: totals.payable.currency, seq: 1,
      });
    };
    const cigOnly = frameOf();
    expect(cigOnly.savedMinor).toBe(0);
    expect(cigOnly.lines).toEqual([{ description: 'p-cig', qty: 1, uom: 'ea', amountMinor: 20_000 }]);
    expect(cigOnly.payableMinor).toBe(20_000);
    s.scan(item('p-rice', 10_000));
    expect(frameOf().savedMinor).toBe(500); // the rice offer, and only it
  });
});

describe('B15 — the online store never lists tobacco', () => {
  const facts = (productId: string) => ({ productId, name: productId, seller: { own: true }, mrpMinor: 100, priceWithTaxMinor: 90, countryOfOrigin: 'India' });
  const deps = (tobacco: ReadonlySet<string>): OnlineStoreDeps => ({
    shopDetails: async () => [], recordShopDetails: async () => {}, catalogueProducts: async () => ['p-cig', 'p-rice'],
    listingFacts: async (_t, id) => facts(id) as never, deliveryTerms: async () => ({}) as never,
    listings: async () => [{ kind: 'published', productId: 'p-cig', by: 'u', at: AT }, { kind: 'published', productId: 'p-rice', by: 'u', at: AT }],
    recordListing: async () => {}, publications: async () => [], recordPublication: async () => {}, onlineComplaints: async () => [],
    isTobacco: async (_t, id) => tobacco.has(id), now: () => AT,
  });

  it('"sold online" says no for tobacco, in the guard\'s words, even when a listing record says published', async () => {
    expect(await onlineSaleOf(deps(new Set(['p-cig'])), 't', 'p-cig')).toEqual({ soldOnline: false, refusal: expect.stringMatching(/tobacco may not be advertised or promoted \(COTPA 2003 s\.5 · B15\)/) });
    expect(JSON.stringify(await onlineSaleOf(deps(new Set()), 't', 'p-cig'))).not.toMatch(/tobacco/);
  });

  it('the customer\'s listing leaves tobacco out entirely; the staff register shows it never publishable, in the guard\'s words', async () => {
    const routes = onlineStoreRoutes(deps(new Set(['p-cig'])));
    const call = (path: string) => routes.find((r) => r.method === 'GET' && r.path === path)!.handler({ tenantId: 't', userId: 'u', params: {}, query: {}, body: undefined } as never);
    const ids = ((await call('/v1/storefront/listing')).body as { products: { productId: string }[] }).products.map((p) => p.productId);
    expect(ids).toEqual(['p-rice']);
    const staff = ((await call('/v1/online-store/listings')).body as { listings: { productId: string; listed: boolean; publishable: boolean; refusal?: string }[] }).listings;
    expect(staff.find((l) => l.productId === 'p-cig')).toMatchObject({ listed: false, publishable: false, refusal: expect.stringMatching(/^The online store cannot name a tobacco product/) });
  });

  it('a listing request for tobacco is refused by name and the attempt is kept', async () => {
    const kept: unknown[] = [];
    const route = onlineStoreRoutes({ ...deps(new Set(['p-cig'])), recordListing: async (_t, r) => { kept.push(r); } }).find((r) => r.method === 'POST' && r.path === '/v1/online-store/listings/:productId')!;
    await expect(route.handler({ tenantId: 't', userId: 'u-owner', params: { productId: 'p-cig' }, query: {}, body: { action: 'publish' } } as never))
      .rejects.toMatchObject({ status: 422 });
    expect(kept).toEqual([expect.objectContaining({ kind: 'refused', productId: 'p-cig', refusal: 'tobacco_may_not_be_promoted' })]);
  });
});

describe('B15 — bundles and substitutes ask the same guard', () => {
  const byId = new Map([['tea', product('tea')], ['mug', product('mug')], ['cig', product('cig', { tobacco: true })], ['box', product('box')]]);
  it('a bundle holding tobacco, or one that IS tobacco, is refused in the guard\'s words', () => {
    const holds = bundleProblems({ bundleProductId: 'box', components: [{ productId: 'tea', quantityMinor: 1 }, { productId: 'cig', quantityMinor: 1 }], product: (id) => byId.get(id), bundles: [] });
    expect(holds.map((p) => p.refusal)).toEqual(['bundle_component_tobacco']);
    expect(holds[0]!.detail).toMatch(/A bundle cannot name a tobacco product \(cig\): tobacco may not be advertised or promoted \(COTPA 2003 s\.5 · B15\)/);
    const is = bundleProblems({ bundleProductId: 'cig', components: [{ productId: 'tea', quantityMinor: 1 }, { productId: 'mug', quantityMinor: 1 }], product: (id) => byId.get(id), bundles: [] });
    expect(is.map((p) => p.refusal)).toEqual(['bundle_product_tobacco']);
  });
  it('tobacco is never a substitute, in the guard\'s words', () => {
    const { problems } = substituteProblems({ productId: 'tea', substitutes: ['cig'], product: (id) => byId.get(id) });
    expect(problems.map((p) => p.refusal)).toEqual(['substitute_controlled']);
    expect(problems[0]!.detail).toMatch(/A suggested substitute cannot name a tobacco product \(cig\)/);
  });
});
