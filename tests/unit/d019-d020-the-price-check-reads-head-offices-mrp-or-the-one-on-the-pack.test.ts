import { describe, it, expect } from 'vitest';
import {
  createCatalogueSession, priceChangeDetails,
  type CataloguePorts, type CatalogueConfig, type HeadOfficeMrp,
  type PriceChangeBody, type PriceChangeCloudOutcome, type PriceChangeCloudPort,
} from '../../apps/web-erp/src/catalogue-session';
import { activatePriceChange, proposePriceChange, PRICE_CHANGE_REFUSALS } from '../../packages/price-list/src/index';
import type { ProductRecord, Category } from '../../packages/product/src/index';
import type { DecidedRequest } from '../../packages/approvals/src/index';
import { money } from '../../packages/contracts/src/money';
import { ShelfMap } from '../../packages/merchandising/src/index';

/**
 * D-019 · D-020 (daily-work walkthrough, store manager, "Change price").
 *
 * D-020: the Change price check read the MRP from the store computer's till-pack copy, so an MRP the owner had just added
 * at head office still said "No MRP" until the pack was sent again. Now the check reads head office's own MRP, live, for
 * the day the price starts; the pack's copy is used only when head office cannot be asked, and that is said.
 *
 * D-019: every price for an item with no MRP on head office's record was refused outright ("Add the MRP from the pack
 * first"), and the manager had no way forward on that page. Now the MRP printed on the pack can be typed in the same
 * form. The law does not move: a price above that MRP is still refused and nothing can approve it. And no approval is
 * loosened: a price checked against a typed MRP NEVER goes through on one person's word — it needs a second person, and
 * what they approve is exactly the change with that MRP in it.
 */

const TODAY = '2026-11-16';
const CATEGORIES: Category[] = [{ categoryId: 'grocery', name: 'Grocery', parentId: null }];
const BISCUIT: ProductRecord = {
  productId: 'prod-biscuit', tenantId: 't1', sku: 'BISC-1', name: 'Marie biscuits', primaryCategoryId: 'grocery', baseUom: 'ea',
  taxClass: '1905', attributes: {}, mrpHistory: [], lifecycle: 'active',
};
const CONFIG: CatalogueConfig = { tenantId: 't1', storeId: 'store-1', userId: 'u-manager', currency: 'INR', today: TODAY, marginFloorBps: 1000 };

function office(mrp: HeadOfficeMrp | (() => Promise<HeadOfficeMrp>)) {
  const posts: (PriceChangeBody & { approvalId?: string })[] = [];
  const reads: { productId: string; storeId: string; on: string }[] = [];
  const port: PriceChangeCloudPort = {
    post: async (input) => { posts.push(input); return { saved: true, verdict: 'ok', approvedBy: null } as PriceChangeCloudOutcome; },
    readMrp: async (productId, storeId, on) => { reads.push({ productId, storeId, on }); return typeof mrp === 'function' ? mrp() : mrp; },
  };
  return { posts, reads, port };
}

function session(over: Partial<CataloguePorts> = {}, products: ProductRecord[] = [BISCUIT]) {
  const map = new ShelfMap('store-1', [], [], ['ambient']);
  return createCatalogueSession(CONFIG, {
    categories: () => CATEGORIES, products: () => products, priceEntries: () => [],
    costOf: () => ({ known: true, cost: money(25_00, 'INR') }), barcodesInUse: () => [], promotions: () => [], shelfMap: () => map,
    ...over,
  });
}

const approved = (subjectRef: string, decidedBy: string): DecidedRequest => ({
  id: `ap-${subjectRef}`, subjectType: 'price_change', subjectRef, requestedBy: 'u-manager', branchId: null, value: null,
  status: 'approved', decidedBy, reason: 'checked the MRP on the pack', decidedAt: `${TODAY}T10:00:00.000Z`,
});

describe('D-020: the check reads head office’s MRP live, not the store computer’s copy', () => {
  it('uses the MRP the owner just added at head office although the pack still has none', async () => {
    const o = office({ read: true, mrpMinor: 35_00, from: '2026-11-15' });
    const s = session({ changePrice: () => o.port });
    expect((await s.readMrpFromHeadOffice('prod-biscuit'))).toEqual({ source: 'head_office', mrpMinor: 35_00, from: '2026-11-15' });
    expect(o.reads).toEqual([{ productId: 'prod-biscuit', storeId: 'store-1', on: TODAY }]);
    const p = s.proposePrice({ id: 'pc-1', productId: 'prod-biscuit', priceMinor: 32_00, effectiveFrom: TODAY });
    expect(p.refusals).toEqual([]);
    expect(p.cleanToActivate).toBe(true);
    // ...and the change it sends carries head office's MRP.
    const out = await s.changePriceInCloud({ productId: 'prod-biscuit', priceMinor: 32_00 });
    expect(out.saved).toBe(true);
    expect(o.posts[0]?.mrpMinor).toBe(35_00);
  });

  it('head office’s MRP wins over an older, higher one in the store computer’s copy', async () => {
    const stale: ProductRecord = { ...BISCUIT, mrpHistory: [{ value: money(40_00, 'INR'), effectiveFrom: '2026-01-01' }] };
    const o = office({ read: true, mrpMinor: 35_00, from: '2026-11-01' });
    const s = session({ changePrice: () => o.port }, [stale]);
    await s.readMrpFromHeadOffice('prod-biscuit');
    expect(s.proposePrice({ id: 'pc-1', productId: 'prod-biscuit', priceMinor: 38_00, effectiveFrom: TODAY }).refusals).toContain('above_the_printed_mrp');
  });

  it('when head office cannot be asked it uses the copy and says so — never silently', async () => {
    const withCopy: ProductRecord = { ...BISCUIT, mrpHistory: [{ value: money(35_00, 'INR'), effectiveFrom: '2026-01-01' }] };
    const o = office({ read: false, reason: 'no connection to head office' });
    const s = session({ changePrice: () => o.port }, [withCopy]);
    expect(await s.readMrpFromHeadOffice('prod-biscuit')).toEqual({ source: 'store_copy', mrpMinor: 35_00, why: 'no connection to head office' });
    const thrown = office(() => Promise.reject(new Error('down')));
    const s2 = session({ changePrice: () => thrown.port }, [withCopy]);
    expect(await s2.readMrpFromHeadOffice('prod-biscuit')).toMatchObject({ source: 'store_copy', why: 'no connection to head office' });
    // A screen with no head office behind it says that too.
    expect(await session({}, [withCopy]).readMrpFromHeadOffice('prod-biscuit')).toMatchObject({ source: 'store_copy', why: 'this screen is not connected to head office' });
  });

  it('is read for TODAY whatever day the price starts — a dearer MRP dated ahead never lifts today’s ceiling', async () => {
    const o = office({ read: true, mrpMinor: 35_00, from: '2026-01-01' });
    const s = session({ changePrice: () => o.port });
    await s.readMrpFromHeadOffice('prod-biscuit');
    expect(o.reads).toEqual([{ productId: 'prod-biscuit', storeId: 'store-1', on: TODAY }]);
    expect(s.mrpSourceFor('prod-biscuit')).toMatchObject({ source: 'head_office', mrpMinor: 35_00 });
    expect(s.proposePrice({ id: 'pc-9', productId: 'prod-biscuit', priceMinor: 38_00, effectiveFrom: '2026-12-01' }).refusals).toContain('above_the_printed_mrp');
  });
});

describe('D-019: no MRP at head office — the MRP printed on the pack, checked by a second person', () => {
  it('without an MRP anywhere the price is still refused, as before', async () => {
    const o = office({ read: true, mrpMinor: null, from: null });
    const s = session({ changePrice: () => o.port });
    expect(await s.readMrpFromHeadOffice('prod-biscuit')).toEqual({ source: 'head_office_has_none' });
    const p = s.proposePrice({ id: 'pc-1', productId: 'prod-biscuit', priceMinor: 32_00, effectiveFrom: TODAY });
    expect(p.refusals).toEqual(['no_mrp_recorded']);
    expect(p.needsApproval).toBe(false);
  });

  it('with the MRP typed from the pack, a good price needs a second person — never one person’s word', async () => {
    const o = office({ read: true, mrpMinor: null, from: null });
    const s = session({ changePrice: () => o.port });
    await s.readMrpFromHeadOffice('prod-biscuit');
    const p = s.proposePrice({ id: 'pc-1', productId: 'prod-biscuit', priceMinor: 32_00, effectiveFrom: TODAY, mrpGivenMinor: 35_00 });
    expect(p.refusals).toEqual(['the_mrp_was_typed_from_the_pack']);
    expect(p.needsApproval).toBe(true);
    expect(p.cleanToActivate).toBe(false);
    // The no-approval send refuses itself and sends nothing.
    const out = await s.changePriceInCloud({ productId: 'prod-biscuit', priceMinor: 32_00, mrpGivenMinor: 35_00 });
    expect(out.saved).toBe(false);
    expect(o.posts).toEqual([]);
    // Locally: not without an approval; not with the setter's own; yes with somebody else's.
    expect(s.activatePrice(p).ok).toBe(false);
    expect(s.activatePrice(p, approved('pc-1', 'u-manager'))).toMatchObject({ ok: false, refusals: ['approved_by_the_person_who_set_it'] });
    expect(s.activatePrice(p, approved('pc-1', 'u-owner'))).toMatchObject({ ok: true, approvedBy: 'u-owner' });
  });

  it('a price above the typed MRP is refused outright, and no approval can lift it', async () => {
    const o = office({ read: true, mrpMinor: null, from: null });
    const s = session({ changePrice: () => o.port });
    await s.readMrpFromHeadOffice('prod-biscuit');
    const p = s.proposePrice({ id: 'pc-1', productId: 'prod-biscuit', priceMinor: 36_00, effectiveFrom: TODAY, mrpGivenMinor: 35_00 });
    expect(p.refusals).toEqual(['above_the_printed_mrp']);
    expect(p.needsApproval).toBe(false);
    expect(s.activatePrice(p, approved('pc-1', 'u-owner')).ok).toBe(false);
  });

  it('a typed MRP is ignored whenever head office has its own — it can never raise the ceiling', async () => {
    const o = office({ read: true, mrpMinor: 30_00, from: '2026-01-01' });
    const s = session({ changePrice: () => o.port });
    await s.readMrpFromHeadOffice('prod-biscuit');
    const p = s.proposePrice({ id: 'pc-1', productId: 'prod-biscuit', priceMinor: 32_00, effectiveFrom: TODAY, mrpGivenMinor: 99_00 });
    expect(p.refusals).toEqual(['above_the_printed_mrp']);
  });

  it('the approval asked for is for exactly the change with the typed MRP in it, and says to check the pack', async () => {
    const o = office({ read: true, mrpMinor: null, from: null });
    const asks: { details: Readonly<Record<string, unknown>>; summary: string }[] = [];
    const s = session({
      changePrice: () => o.port,
      askApproval: async (a) => { asks.push({ details: a.details, summary: a.summary }); return { result: 'asked', request: { requestId: 'req-1', summary: a.summary } } as never; },
      approvalInbox: async () => ({ result: 'read', requests: [] }) as never,
    });
    await s.readMrpFromHeadOffice('prod-biscuit');
    const asked = await s.askPriceApproval('en', { productId: 'prod-biscuit', priceMinor: 32_00, mrpGivenMinor: 35_00, why: 'new pack arrived with MRP 35' });
    expect(asked.kind).toBe('asked');
    expect(asks[0]?.details).toEqual(priceChangeDetails({ productId: 'prod-biscuit', priceMinor: 32_00, mrpMinor: 35_00, costMinor: 25_00, currency: 'INR', marginFloorBps: 1000 }));
    expect(asks[0]?.summary).toContain('₹35.00 was typed from the pack');
    // Without the typed MRP there is nothing to check against, and nothing is asked.
    expect(await s.askPriceApproval('en', { productId: 'prod-biscuit', priceMinor: 32_00, why: 'new pack arrived with MRP 35' })).toEqual({ kind: 'cannot_check', missing: 'mrp' });
  });
});

describe('the rule itself (packages/price-list)', () => {
  it('knows the new refusal and words it', () => {
    expect(PRICE_CHANGE_REFUSALS).toContain('the_mrp_was_typed_from_the_pack');
    const p = proposePriceChange(
      { id: 'x', productId: 'p', scope: 'store', scopeRef: 's', price: money(30_00, 'INR'), effectiveFrom: TODAY, setBy: 'u-1' },
      { today: TODAY, mrp: money(35_00, 'INR'), mrpTypedFromThePack: true, cost: { known: false, why: 'none' }, marginFloorBps: 1000, existing: [] },
    );
    // An unknown cost and a typed MRP: both said, and both are for the one approver to see.
    expect(p.refusals).toEqual(['the_cost_is_not_known_so_the_margin_was_never_checked', 'the_mrp_was_typed_from_the_pack']);
    expect(p.needsApproval).toBe(true);
    expect(p.detail[1]).toContain('typed from the pack');
    expect(activatePriceChange(p, { setBy: 'u-1' }).ok).toBe(false);
  });

  it('a below-floor price with a typed MRP still needs exactly one approval (both reasons shown)', () => {
    const p = proposePriceChange(
      { id: 'x', productId: 'p', scope: 'store', scopeRef: 's', price: money(26_00, 'INR'), effectiveFrom: TODAY, setBy: 'u-1' },
      { today: TODAY, mrp: money(35_00, 'INR'), mrpTypedFromThePack: true, cost: { known: true, cost: money(25_00, 'INR') }, marginFloorBps: 1000, existing: [] },
    );
    expect(p.refusals).toEqual(['below_the_margin_floor', 'the_mrp_was_typed_from_the_pack']);
    expect(p.needsApproval).toBe(true);
  });
});
