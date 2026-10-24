import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { useRestartableBackings } from '../support/p3-backings';
import { ownerApprovedSetting, SETUP_ASKER } from '../support/owner-approved-setting';
import { aStoreWithRules } from '../support/store-rules';
import { STREAM, customerAdapter, ordersAdapter } from '../../services/api/src/adapters';
import type { SignedPack } from '../../services/catalogue/src/pack';

/**
 * **OB-288 till-side completion — head office's half, through the real routes, on the in-memory store and (with
 * DATABASE_URL) on real PostgreSQL, each with a COLD RESTART of head office reading the same records.**
 *
 *   • OB-348 (B17) — the shop's state is a high-impact setting: the administrator asks, the owner approves (never the
 *     maker), and it rides the store pack to the store computer; a sale under a liquor HSN is banked and raised CRITICAL;
 *   • OB-306 — a bundle defined at head office rides the SIGNED pack; a bill whose bundle line carries the till's explosion
 *     takes stock off each component (the bundle holds none); a return of one bundle puts back its components;
 *   • OB-347 — changing a published product's HSN class needs Finance (the accountant or the owner), never the maker;
 *   • OB-299 — a bill the till marked for delivery becomes ONE delivery order, paid, booked once on any resend; delivered,
 *     it posts no second sale and the door collects nothing;
 *   • OB-346 — an online order earns points once DELIVERED, at the till rate, for the member the app account is tied to.
 */

const backings = useRestartableBackings();
const TODAY = new Date().toISOString().slice(0, 10);
const AT = new Date().toISOString();
const GROCERY = { categoryId: 'grocery', name: 'Grocery', parentId: null };
const SETTINGS = { tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 15, warehouseId: 'S1' };
const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

async function shop(h: ApiHarness) {
  const T = randomUUID();
  await h.seedOwner(T, 'u-owner');
  await h.enableFeature(T, 'delivery');
  await h.provisionRole(T, 'u-meena', 'cashier');
  await h.provisionRole(T, 'u-cat', 'store_manager');
  await h.provisionRole(T, 'u-acct', 'accountant');
  const call = (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, userId = 'u-owner', on: ApiHarness = h) => {
    const [bare, qs] = path.split('?');
    const query = Object.fromEntries(new URLSearchParams(qs ?? ''));
    // The store computer's credential names its store (a fresh head office after a restart is told it again here).
    return on.request({ method, path: bare!, userId, tenantId: T, ...(userId === 'u-box' ? { branchId: 'S1' } : {}), ...(method === 'GET' ? { query } : { idempotencyKey: `k-${randomUUID()}`, body: body ?? {} }) });
  };
  await aStoreWithRules(h, T, 'u-owner', 'S1', 0);
  // Head office grants a store-scoped role only at a store it knows: the store first, then its computer.
  await h.provisionRole(T, 'u-box', 'store_computer', ['S1']);
  expect((await call('POST', '/v1/stores/S1/settings', SETTINGS)).status).toBe(201);
  for (const [hsn, bps] of [['1006', 0], ['0713', 500], ['1507', 500], ['1701', 500], ['2106', 1200], ['996813', 1800]] as const) {
    expect((await call('POST', `/v1/catalogue/tax-classes/${hsn}/rates/2017-07-01`, { rateBps: bps })).status).toBeLessThan(300);
  }
  const product = async (id: string, name: string, taxClass: string, priceMinor: number, baseUom = 'each') => {
    const r = await call('POST', `/v1/catalogue/products/${id}/publish`, { product: { sku: `SKU-${id}`, name, baseUom, primaryCategoryId: 'grocery', taxClass, lifecycle: 'active', handling: 'ambient' }, categories: [GROCERY] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await call('POST', `/v1/prices/list/${id}/entries/e1`, { scope: 'store', scopeRef: 'S1', priceMinor, mrpMinor: priceMinor, costMinor: Math.floor(priceMinor / 2), marginFloorBps: 0, currency: 'INR', effectiveFrom: TODAY })).status).toBe(201);
  };
  return { T, call, product };
}

const onHand = async (call: (method: 'GET', path: string) => Promise<{ body: unknown }>, productId: string): Promise<number> => {
  const r = await call('GET', `/v1/inventory/availability?productId=${productId}`);
  const rows = (r.body as { rows?: { locationId: string; onHandMinor: number }[] }).rows;
  if (rows === undefined) throw new Error(JSON.stringify(r.body));
  return rows.filter((x) => x.locationId === 'S1').reduce((n, x) => n + x.onHandMinor, 0);
};

const bill = (saleId: string, lines: readonly Record<string, unknown>[], totalMinor: number, extra: Record<string, unknown> = {}) => ({
  saleId, receiptNumber: `L1-${saleId}`, laneId: 'lane-1', locationId: 'S1', cashierId: 'u-meena', tradingDay: TODAY, committedAt: AT,
  totalMinor, currency: 'INR', packVersion: 1, lines, tenders: [{ kind: 'cash', amountMinor: totalMinor }], ...extra,
});

describe.each(backings)('OB-288 till side — head office\'s rules reach the till and come back — on $name', ({ harness }) => {
  it('OB-348: the shop\'s state is owner-approved and rides the store pack; a liquor-HSN sale banks and is raised critical', async () => {
    const h = harness();
    const { T, call } = await shop(h);
    await h.provisionRole(T, SETUP_ASKER, 'platform_admin');
    // The administrator alone cannot set it — high-impact (OB-336 pattern) — and "Tamil Nadu" in words is not a code.
    const alone = await call('PUT', '/v1/platform/setup/store.state', { value: 'TN' }, SETUP_ASKER);
    expect(codeOf(alone)).toBe('high_impact_change_needs_owner_approval');
    expect((await ownerApprovedSetting(h, T, 'store.state', { value: 'Tamil Nadu' })).status).toBe(422);
    expect((await ownerApprovedSetting(h, T, 'store.state', { value: 'TN' })).status).toBe(200);

    // (Store setup is durable in a deployment; this harness keeps it in memory, so the pack is read from the same instance —
    // the real-stack proof restarts head office over PostgreSQL.)
    const again = harness(h);
    const pack = await call('GET', '/v1/store-packs/S1', undefined, 'u-box');
    expect(pack.status, JSON.stringify(pack.body)).toBe(200);
    expect((pack.body as { sections: { policies: Record<string, unknown> } }).sections.policies).toMatchObject({ shopState: 'TN' });
    // The delivery-fee product is not set: nothing is sent, and the till says "not set".
    expect((pack.body as { sections: { policies: Record<string, unknown> } }).sections.policies['tillDeliveryFeeProductId']).toBeUndefined();

    // A bill that reached head office with a line under HSN 2203 (an old till): banked — it happened — and raised critical.
    const sold = await call('POST', '/v1/sales', bill('S-LIQ', [{ productId: 'p-beer', quantityMinor: 1, uom: 'ea', unitPriceMinor: 15_000, lineTotalMinor: 15_000, hsnCode: '2203' }], 15_000), 'u-meena', again);
    expect(sold.status).toBe(202);
    const found = (sold.body as { exceptions: { kind: string; severity: string; detail: string }[] }).exceptions.find((e) => e.kind === 'liquor_sold');
    expect(found).toMatchObject({ severity: 'critical' });
    expect(found!.detail).toMatch(/TASMAC/);
  }, 120_000);

  it('OB-306: a bundle rides the signed pack; a bundle bill takes stock off each component; a return of one puts them back', async () => {
    const h = harness();
    const { T, call, product } = await shop(h);
    await product('p-dal', 'Toor dal 1kg', '0713', 12_000);
    await product('p-oil', 'Groundnut oil 1L', '1507', 20_000);
    await product('p-sugar', 'Sugar (loose)', '1701', 4_500, 'kg');
    await product('p-combo', 'Festival combo', '2106', 45_000);
    for (const [id, productId, qty, uom] of [['r-dal', 'p-dal', 20, 'each'], ['r-oil', 'p-oil', 10, 'each'], ['r-sugar', 'p-sugar', 5_000, 'kg']] as const) {
      expect((await call('POST', '/v1/inventory/movements', { movementId: id, productId, locationId: 'S1', kind: 'received', quantityMinor: qty, uom, occurredAt: AT, enteredBy: 'u-owner', unitCostMinor: 1_000 })).status).toBe(202);
    }
    // The bundle: what ONE combo holds — two dal, one oil, 500 g sugar.
    expect((await call('POST', '/v1/catalogue/bundles/p-combo', { components: [{ productId: 'p-dal', quantityMinor: 2 }, { productId: 'p-oil', quantityMinor: 1 }, { productId: 'p-sugar', quantityMinor: 500 }], reason: 'festival pack' })).status).toBe(201);
    expect((await call('POST', '/v1/catalogue/pack', { storeId: 'S1', asOf: AT })).status).toBe(201);
    const published = (await h.store.latestOfType(T, STREAM.catalogue, 'CataloguePublished'))!.event.payload as SignedPack;
    expect(published.snapshot.bundles?.map((b) => [b.bundleProductId, b.version]), JSON.stringify(published.snapshot.products.map((p) => p.productId))).toEqual([['p-combo', 1]]);

    // The till's bill (as the store computer sends it): two combos, exploded from the pack, and one dal on its own.
    const bundle = { bundleProductId: 'p-combo', version: 1, components: [{ productId: 'p-dal', quantityMinor: 4, uom: 'ea' }, { productId: 'p-oil', quantityMinor: 2, uom: 'ea' }, { productId: 'p-sugar', quantityMinor: 1000, uom: 'kg' }] };
    const lines = [
      { productId: 'p-combo', quantityMinor: 2, uom: 'ea', unitPriceMinor: 45_000, lineTotalMinor: 90_000, bundle },
      { productId: 'p-dal', quantityMinor: 1, uom: 'ea', unitPriceMinor: 12_000, lineTotalMinor: 12_000 },
    ];
    expect((await call('POST', '/v1/sales', bill('S-COMBO', lines, 102_000), 'u-meena')).status).toBe(202);
    const again = harness(h);
    const c2 = (m: 'GET' | 'POST', p: string, b?: unknown, u = 'u-owner') => call(m, p, b, u, again);
    expect(await onHand(c2, 'p-dal')).toBe(20 - 4 - 1);
    expect(await onHand(c2, 'p-oil')).toBe(10 - 2);
    expect(await onHand(c2, 'p-sugar')).toBe(5_000 - 1_000);
    expect(await onHand(c2, 'p-combo')).toBe(0); // the bundle itself never moved
    // A resend of the same bill moves nothing twice.
    expect((await c2('POST', '/v1/sales', bill('S-COMBO', lines, 102_000), 'u-meena')).status).toBe(202);
    expect(await onHand(c2, 'p-dal')).toBe(15);

    // One combo comes back through the box, resold: its components return, in proportion, from the bill's own explosion.
    const ret = await c2('POST', '/v1/sales/S-COMBO/returns/synced', {
      returnId: 'RT-COMBO', number: 'L1-RT1', processedBy: 'u-meena', reasonCode: 'changed_mind', refundMinor: 45_000, refundTender: 'cash', refundStatus: 'settled',
      processedAt: AT, locationId: 'S1', lines: [{ productId: 'p-combo', uom: 'ea', quantityMinor: 1, disposition: 'resell' }],
    }, 'u-box');
    expect(ret.status, JSON.stringify(ret.body)).toBeLessThan(300);
    const third = harness(again);
    const c3 = (m: 'GET' | 'POST', p: string) => call(m, p, undefined, 'u-owner', third);
    expect(await onHand(c3, 'p-dal')).toBe(15 + 2);
    expect(await onHand(c3, 'p-oil')).toBe(8 + 1);
    expect(await onHand(c3, 'p-sugar')).toBe(4_000 + 500);
    expect(await onHand(c3, 'p-combo')).toBe(0);
  }, 120_000);

  it('OB-347: a published product\'s HSN class changes only with Finance\'s approval — never the maker\'s own', async () => {
    const h = harness();
    const { call, product } = await shop(h);
    await product('p-dal', 'Toor dal 1kg', '0713', 12_000);
    const record ={ product: { sku: 'SKU-p-dal', name: 'Toor dal 1kg', baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '1006', lifecycle: 'active', handling: 'ambient' }, categories: [GROCERY] };
    // The maker is whoever keeps the catalogue (here the owner); the checker is Finance — the accountant.
    const refused = await call('POST', '/v1/catalogue/products/p-dal/publish', record);
    expect(codeOf(refused), JSON.stringify(refused.body)).toBe('tax_class_change_needs_finance_approval');
    // The maker asks; the maker cannot decide their own request; a store manager is not Finance either.
    const ask = await call('POST', '/v1/approvals/requests', { kind: 'hsn_class_change', subjectRef: 'product:p-dal', details: { ...record, productId: 'p-dal' }, valueMinor: null, summary: 'Dal to 1006', reason: 'HSN corrected by the CA' });
    expect(ask.status, JSON.stringify(ask.body)).toBe(201);
    const requestId = (ask.body as { requestId: string }).requestId;
    expect((await call('POST', `/v1/approvals/requests/${requestId}/decide`, { decision: 'approved', reason: 'mine' })).status).toBeGreaterThanOrEqual(400);
    expect((await call('POST', `/v1/approvals/requests/${requestId}/decide`, { decision: 'approved', reason: 'not finance' }, 'u-cat')).status).toBeGreaterThanOrEqual(400);
    expect((await call('POST', `/v1/approvals/requests/${requestId}/decide`, { decision: 'approved', reason: 'checked against the CA note' }, 'u-acct')).status).toBe(201);
    const again = harness(h);
    // A DIFFERENT record than the one approved is refused; exactly the approved one is saved, once.
    expect((await call('POST', '/v1/catalogue/products/p-dal/publish', { ...record, product: { ...record.product, name: 'Dal' }, approvalId: requestId }, 'u-owner', again)).status).toBeGreaterThanOrEqual(400);
    const saved = await call('POST', '/v1/catalogue/products/p-dal/publish', { ...record, approvalId: requestId }, 'u-owner', again);
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    expect(saved.body).toMatchObject({ product: { taxClass: '1006' }, taxClassChange: { from: '0713', to: '1006', approvedBy: 'u-acct' } });
    // Spent: the same approval cannot carry a second change.
    expect((await call('POST', '/v1/catalogue/products/p-dal/publish', { ...record, product: { ...record.product, taxClass: '0713' }, approvalId: requestId }, 'u-owner', again)).status).toBeGreaterThanOrEqual(400);
    // An edit that keeps the class (a new name) needs no approval — only the tax class is Finance's.
    expect((await call('POST', '/v1/catalogue/products/p-dal/publish', { ...record, product: { ...record.product, name: 'Toor dal (1kg)' } }, 'u-owner', again)).status).toBe(201);
  }, 120_000);

  it('OB-299: a till bill marked for delivery is ONE paid delivery order, booked once; delivered, it posts no second sale', async () => {
    const h = harness();
    const { T, call, product } = await shop(h);
    await product('p-rice', 'Ponni rice 5kg', '1006', 40_000);
    await product('p-del', 'Home delivery', '996813', 3_000);
    expect((await call('POST', '/v1/catalogue/pack', { storeId: 'S1', asOf: AT })).status).toBe(201);
    expect((await call('POST', '/v1/inventory/movements', { movementId: 'r-rice', productId: 'p-rice', locationId: 'S1', kind: 'received', quantityMinor: 10, uom: 'each', occurredAt: AT, enteredBy: 'u-owner', unitCostMinor: 20_000 })).status).toBe(202);
    const lines = [
      { productId: 'p-rice', quantityMinor: 2, uom: 'ea', unitPriceMinor: 40_000, lineTotalMinor: 80_000 },
      { productId: 'p-del', quantityMinor: 1, uom: 'ea', unitPriceMinor: 3_000, lineTotalMinor: 3_000 },
    ];
    const sale = bill('S-DEL', lines, 83_000, { delivery: { requested: true, feeProductId: 'p-del', feeMinor: 3_000 } });
    const first = await call('POST', '/v1/sales', sale, 'u-meena');
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ delivery: { outcome: 'booked', orderId: 'till-S-DEL' } });

    // A cold restart, and the store computer's resend: booked once.
    const again = harness(h);
    const resend = await call('POST', '/v1/sales', sale, 'u-meena', again);
    expect(resend.body).toMatchObject({ delivery: { outcome: 'already_booked', orderId: 'till-S-DEL' } });
    const orders = ordersAdapter({ store: again.store, now: () => AT, holdMinutes: 0 });
    expect(await orders.placedOrder(T, 'till-S-DEL')).toMatchObject({ state: 'confirmed', fulfilment: 'delivery', locationId: 'S1', lines: [{ productId: 'p-rice', quantityMinor: 2 }] });
    expect(await orders.orderPayment(T, 'till-S-DEL')).toMatchObject({ providerRef: 'till-bill:L1-S-DEL', amountMinor: 83_000, result: 'authorised' });
    expect(await onHand((m, p) => call(m, p, undefined, 'u-owner', again), 'p-rice')).toBe(8); // the till's own sale moved it, once

    // Packed, dispatched, delivered: the hand-over posts NO second sale; the stock stays as the till's sale left it.
    const c2 = (m: 'GET' | 'POST', p: string, b?: unknown, u = 'u-cat') => call(m, p, b, u, again);
    const packedTill = await c2('POST', '/v1/fulfilment/orders/till-S-DEL/pack', { lines: [{ productId: 'p-rice', pickedMinor: 2 }], crateAssignment: { 'p-rice': 'bag-1' } });
    expect(packedTill.status, JSON.stringify(packedTill.body)).toBe(200);
    const sentTill = await c2('POST', '/v1/fulfilment/orders/till-S-DEL/dispatch', { manifestId: 'm-till', locationId: 'S1', seals: { 'bag-1': 's1' } });
    expect(sentTill.body, JSON.stringify(sentTill.body)).toMatchObject({ dispatched: true });
    expect((await c2('POST', '/v1/delivery/orders/till-S-DEL/transition', { event: 'depart' }, 'u-owner')).status).toBe(200);
    const door = await c2('POST', '/v1/delivery/orders/till-S-DEL/transition', { event: 'deliver', proof: { kind: 'otp', ref: 'OTP-55' } }, 'u-owner');
    expect(door.body).toMatchObject({ state: 'delivered', fulfilment: { settlement: { outcome: 'delivered', keptMinor: 0, tenders: [], codDueMinor: 0, refundDueMinor: 0 } } });
    const sales = (await again.store.readStream(T, STREAM.sales, { type: 'SaleCommitted' })).map((e) => (e.event.payload as { saleId: string }).saleId);
    expect(sales).toEqual(['S-DEL']);
    expect(await onHand((m, p) => call(m, p, undefined, 'u-owner', again), 'p-rice')).toBe(8);
  }, 120_000);

  it('OB-346: an online order earns points once DELIVERED, at the till rate, for the member the app is tied to — once', async () => {
    const h = harness();
    const { T, call, product } = await shop(h);
    await h.provisionRole(T, SETUP_ASKER, 'platform_admin');
    expect((await call('PUT', '/v1/platform/setup/loyalty.points_per_100_inr', { value: 2 }, SETUP_ASKER)).status).toBe(200);
    await product('p-rice', 'Ponni rice 5kg', '1006', 40_000);
    expect((await call('POST', '/v1/inventory/movements', { movementId: 'r-rice', productId: 'p-rice', locationId: 'S1', kind: 'received', quantityMinor: 10, uom: 'each', occurredAt: AT, enteredBy: 'u-owner', unitCostMinor: 20_000 })).status).toBe(202);
    expect((await call('POST', '/v1/catalogue/pack', { storeId: 'S1', asOf: AT })).status).toBe(201);
    const MOBILE = '98400' + '12345';
    const enrolled = await call('POST', '/v1/loyalty/members', { mobile: MOBILE, consent: true, verifiedHow: 'seen_on_phone' });
    expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(201);
    const memberRef = (enrolled.body as { memberRef: string }).memberRef;
    expect((await call('POST', '/v1/loyalty/members/app-link', { mobile: MOBILE, appCustomerRef: 'c-app-1', verifiedHow: 'seen_on_phone' })).status).toBe(201);
    // The app customer's order (as the storefront records it), paid online.
    await ordersAdapter({ store: h.store, now: () => AT, holdMinutes: 0 }).recordPlaced(T, { orderId: 'o-app', locationId: 'S1', state: 'placed', placedAt: AT, fulfilment: 'delivery', customerRef: 'c-app-1', lines: [{ productId: 'p-rice', quantityMinor: 1 }] });
    expect((await call('POST', '/v1/orders/o-app/payment', { providerRef: 'tok_o_app', amountMinor: 40_000, result: 'authorised' }, 'u-cat')).status).toBeLessThan(300);
    expect((await call('POST', '/v1/orders/o-app/transition', { event: 'confirm' })).status).toBe(200);
    const packedApp = await call('POST', '/v1/fulfilment/orders/o-app/pack', { lines: [{ productId: 'p-rice', pickedMinor: 1 }], crateAssignment: { 'p-rice': 'c1' } }, 'u-cat');
    expect(packedApp.status, JSON.stringify(packedApp.body)).toBe(200);
    const sentApp = await call('POST', '/v1/fulfilment/orders/o-app/dispatch', { manifestId: 'm-app', locationId: 'S1', seals: { c1: 's1' } }, 'u-cat');
    expect(sentApp.body, JSON.stringify(sentApp.body)).toMatchObject({ dispatched: true });
    expect((await call('POST', '/v1/delivery/orders/o-app/transition', { event: 'depart' })).status).toBe(200);
    // Not yet delivered: nothing earned (no spending or earning online before the hand-over).
    expect(await customerAdapter({ store: h.store, now: () => AT }).pointsBalance(T, memberRef) ?? 0).toBe(0);
    const door = await call('POST', '/v1/delivery/orders/o-app/transition', { event: 'deliver', proof: { kind: 'otp', ref: 'OTP-77' } });
    expect(door.body).toMatchObject({ fulfilment: { settlement: { outcome: 'delivered', saleId: 'order-o-app', keptMinor: 40_000 } } });
    const again = harness(h);
    // ₹400 at 2 points per ₹100 = 8 points — the till rate; run the command again and it earns nothing twice.
    expect(await customerAdapter({ store: again.store, now: () => AT }).pointsBalance(T, memberRef)).toBe(8);
    expect((await call('POST', '/v1/fulfilment/orders/o-app/apply', {}, 'u-cat', again)).body).toMatchObject({ alreadySettled: true });
    expect(await customerAdapter({ store: again.store, now: () => AT }).pointsBalance(T, memberRef)).toBe(8);
  }, 120_000);
});
