import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startW4Shop, openAs, says, type W4Shop } from './lib/w4-office-shop';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM } from '../../services/api/src/adapters';
import { seedSubstitutionTruth, recordOrderRules, paidOnline, SWAP_PRODUCTS } from '../support/substitution-truth';

/**
 * **W5 · route audit bundle 8 — the service-desk, dispatch, delivery-exception and online-order sections, in a real browser, on
 * the production API surface (over real PostgreSQL when DATABASE_URL is set).** Synthetic data only.
 *   • Customer cases (M21-FR-04 · PF-11): the first human reply is marked; goodwill credit is given with its reason and is
 *     carried out through the value records; once the case is resolved the customer's rating is recorded — head office's
 *     service report counts it;
 *   • Dispatch (M19-FR-02): a partly delivered order waits for the hand-back count; the manager counts the milk that came back,
 *     and head office posts only what was kept and the rest as a refund due; (D09-FR-05 · WF-15) the order's proof as head
 *     office holds it — no driver's phone recorded this one, and the page says so;
 *   • Delivery exceptions (M19-FR-01): the owner moves a refund-due exception to the duty manager, with the reason;
 *   • Online orders (FUL-14): what the customer said on the phone about substitutes is recorded with how she was reached —
 *     a swap then needs her yes (head office refuses it without one); (M20-FR-03) the order notices are read; (P-04) a
 *     customer who asked for a desk order is on the refused-access register.
 * Nothing is written on open.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER = 'u-owner'; const MGR = 'u-mgr'; const CUST = 'cust-w5-probe';
const AT = new Date().toISOString();

describe.skipIf(!existsSync(CHROMIUM))('W5 case, dispatch, exception and online-order sections on the production API, in a real browser', () => {
  let browser: Browser;
  let shop: W4Shop;
  const T = randomUUID();
  const as = (who: string, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) => shop.ho().request({ method, path, userId: who, tenantId: T, ...(method !== 'GET' ? { idempotencyKey: `seed-${randomUUID()}`, body: body ?? {} } : {}) });
  const must = async (p: ReturnType<typeof as>, what: string) => { const r = await p; if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`); return r.body as Record<string, unknown>; };
  let exceptionId = '';

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    const page = (html: string, dataGlobal: string) => ({ html, dataGlobal });
    shop = await startW4Shop({
      tenantId: T, databaseUrl: DATABASE_URL, pages: {
        '/service-desk': page('service-desk.html', 'serviceDeskData'), '/dispatch': page('dispatch.html', 'dispatchData'),
        '/substitution-exceptions': page('substitution-exceptions.html', 'substitutionExceptionInboxData'), '/online-orders': page('online-orders.html', 'onlineOrdersData'),
      },
    });
    const h = shop.ho();
    await h.seedOwner(T, OWNER);
    for (const f of ['delivery', 'customer_app']) await h.enableFeature(T, f);
    await h.provisionRole(T, MGR, 'store_manager');
    await h.provisionRole(T, CUST, 'customer');
    // A complaint case.
    await must(as(MGR, 'POST', '/v1/service/cases/K-W5', { kind: 'complaint', priority: 'normal', assignedTo: MGR, customerRef: 'cust-w5-k', summary: 'The delivery came two hours late (synthetic)' }), 'case');
    // Two products head office has published, stock received, and an order out for delivery (2 milk ₹60, 1 dal ₹160, prepaid).
    await h.store.append(T, STREAM.catalogue, makeEvent({
      id: `pack-${T}-w5`, type: 'CataloguePublished', occurredAt: AT, idempotencyKey: `catalogue-${T}-w5`, source: 'test/catalogue',
      payload: { snapshot: { tenantId: T, version: 1, builtAt: AT, scope: { tenantId: T, storeId: 'store-1' }, barcodes: [], products: [
        { productId: 'MILK', sku: 'MILK', name: 'Milk', unitPriceMinor: 6_000, taxBps: 0, status: 'active', uom: 'ea', batchTracked: false },
        { productId: 'DAL', sku: 'DAL', name: 'Dal', unitPriceMinor: 16_000, taxBps: 0, status: 'active', uom: 'ea', batchTracked: false },
      ] } },
    }));
    for (const [id, name] of [['MILK', 'Milk'], ['DAL', 'Dal']] as const) {
      await must(as(OWNER, 'POST', `/v1/catalogue/products/${id}/publish`, { product: { sku: id, name, baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '1006', lifecycle: 'active', handling: 'ambient' }, categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }] }), `publish ${id}`);
      await must(as(OWNER, 'POST', '/v1/inventory/movements', { movementId: `r-${id}`, productId: id, locationId: 'store-1', kind: 'received', quantityMinor: 10, uom: 'ea', occurredAt: AT, enteredBy: OWNER, unitCostMinor: 3_000 }), `stock ${id}`);
    }
    await must(as(OWNER, 'POST', '/v1/orders/o-part/promise', { lines: [{ productId: 'MILK', quantityMinor: 2 }, { productId: 'DAL', quantityMinor: 1 }], locationId: 'store-1' }), 'promise');
    await must(as(MGR, 'POST', '/v1/orders/o-part/payment', { providerRef: 'tok_o-part', amountMinor: 28_000, result: 'authorised' }), 'payment');
    await must(as(OWNER, 'POST', '/v1/orders/o-part/transition', { event: 'confirm' }), 'confirm');
    await must(as(MGR, 'POST', '/v1/fulfilment/orders/o-part/pack', { lines: [{ productId: 'MILK', pickedMinor: 2 }, { productId: 'DAL', pickedMinor: 1 }], crateAssignment: { MILK: 'c1', DAL: 'c1' } }), 'pack');
    await must(as(MGR, 'POST', '/v1/fulfilment/orders/o-part/dispatch', { manifestId: 'm-o-part', locationId: 'store-1', seals: { c1: 's1' } }), 'dispatch');
    await must(as(OWNER, 'POST', '/v1/delivery/orders/o-part/transition', { event: 'depart' }), 'depart');
    await must(as(OWNER, 'POST', '/v1/delivery/orders/o-part/transition', { event: 'deliver_partial', proof: { kind: 'otp', ref: 'OTP-1234' } }), 'partial');
    // A substitution that leaves a refund due (a cheaper swap on a prepaid order) — an exception for the finance queue.
    await seedSubstitutionTruth(h, T, SWAP_PRODUCTS);
    await must(as(OWNER, 'POST', '/v1/orders/ord-a/promise', { lines: [{ productId: 'MILK', quantityMinor: 2 }], locationId: 'store-1' }), 'ord-a');
    await recordOrderRules(h, T, OWNER, 'ord-a', { preference: 'best_match' });
    await paidOnline(h, T, OWNER, 'ord-a', 10_000);
    const offer = { lineId: 'l1', orderedProductId: 'MILK', orderedName: 'Milk 1L', orderedUnitPriceMinor: 5_000, orderedQuantityMinor: 2, substituteProductId: 'MILK-ALT', substituteName: 'Milk 1L alt', substituteUnitPriceMinor: 4_000, substituteQuantityMinor: 2, offeredAt: AT };
    await must(as(OWNER, 'POST', '/v1/orders/ord-a/substitute', { offer, decision: 'confirmed' }), 'swap');
    exceptionId = ((await must(as(OWNER, 'GET', '/v1/orders/substitution-exceptions'), 'worklist'))['exceptions'] as { exceptionId: string }[])[0]!.exceptionId;
    // A second order, its substitution answer still to be told; and a customer who asks the app for this desk order.
    await must(as(OWNER, 'POST', '/v1/orders/ord-b/promise', { lines: [{ productId: 'MILK', quantityMinor: 1 }], locationId: 'store-1' }), 'ord-b');
    expect((await as(CUST, 'GET', '/v1/storefront/orders/ord-b')).status).toBe(403);
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 240_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  it('Customer cases: first reply, goodwill credit carried out, the customer\'s rating once resolved (M21-FR-04 · PF-11)', async () => {
    const o = await openAs(shop, browser, MGR, '/service-desk');
    try {
      await says(o.page, '#desk-case-follow-up-h', /^Follow up a case/);
      expect(o.writes, 'nothing is written on open').toEqual([]);
      await o.page.fill('#cd-case-no', 'K-W5');
      await o.page.click('#cd-case-form-go');
      await says(o.page, '#cd-case-comp-list', /^No compensation given on this case\.$/);
      await o.page.click('#cd-case-first');
      await says(o.page, '#cd-case-first-status', /^First reply recorded\.$/);
      await o.page.selectOption('#cd-case-kind', 'goodwill_credit');
      await o.page.fill('#cd-case-amount', '50');
      await o.page.fill('#cd-case-reason', 'Delivery two hours late');
      await o.page.click('#cd-case-grant-go');
      await says(o.page, '#cd-case-grant-status', /^Given\.$/);
      await says(o.page, '#cd-case-comp-list li[data-state="completed"]', /^goodwill credit ₹50\.00 — Delivery two hours late · by u-mgr · carried out \(₹50\.00 of store credit issued to the customer\.\)/);
      // PF-11: points cannot be carried out while the owner has not set what a point is worth — FAILED, said, and offered again.
      await o.page.selectOption('#cd-case-kind', 'loyalty_points');
      await o.page.fill('#cd-case-amount', '10');
      await o.page.fill('#cd-case-reason', 'Points for the wait');
      await o.page.click('#cd-case-grant-go');
      await says(o.page, '#cd-case-comp-list li[data-state="failed"]', /FAILED \(The owner has not set what a point is worth/);
      await must(as(OWNER, 'PUT', '/v1/platform/setup/loyalty.point_value_paise', { value: 50 }), 'point value');
      await o.page.click('#cd-case-comp-list li[data-state="failed"] button.retry');
      await says(o.page, '#cd-case-total', /^2 · total ₹60\.00$/);
      await says(o.page, '#cd-case-comp-list', /loyalty points ₹10\.00 — Points for the wait · by u-mgr · carried out \(20 point\(s\) added to the customer\.\)/);
      // Rated before it is resolved: head office refuses, in its words.
      await o.page.fill('#cd-case-customer', 'cust-w5-k');
      await o.page.selectOption('#cd-case-score', '4');
      await o.page.click('#cd-case-rate-go');
      await says(o.page, '#cd-case-rate-status', /^Head office refused: Case K-W5 is open/);
      expect(o.errors).toEqual([]);
    } finally { await o.close(); }
    const sla = (await as(MGR, 'GET', '/v1/service/cases/K-W5/sla')).body as { firstResponse: { status: string } };
    expect(sla.firstResponse.status).toBe('met');
    await must(as(MGR, 'POST', '/v1/service/cases/K-W5/resolution', { resolution: 'Apologised and gave goodwill credit' }), 'resolve');
    const again = await openAs(shop, browser, MGR, '/service-desk');
    try {
      await again.page.fill('#cd-case-no', 'K-W5');
      await again.page.click('#cd-case-form-go');
      await says(again.page, '#cd-case-total', /^2 · total ₹60\.00$/);
      await again.page.fill('#cd-case-customer', 'cust-w5-k');
      await again.page.selectOption('#cd-case-score', '4');
      await again.page.fill('#cd-case-comment', 'Thank you');
      await again.page.click('#cd-case-rate-go');
      await says(again.page, '#cd-case-rate-status', /^Rating recorded\.$/);
      expect(again.errors).toEqual([]);
    } finally { await again.close(); }
    const report = (await as(OWNER, 'GET', '/v1/service/report')).body as { csatHundredths: number };
    expect(report.csatHundredths).toBe(400);
    const comps = (await as(MGR, 'GET', '/v1/service/cases/K-W5/compensations')).body as { compensations: { grantedBy: string; amountMinor: number }[] };
    expect(comps.compensations).toEqual([expect.objectContaining({ grantedBy: MGR, amountMinor: 5_000, fulfilment: expect.objectContaining({ status: 'completed' }) }), expect.objectContaining({ kind: 'loyalty_points', amountMinor: 1_000, fulfilment: expect.objectContaining({ status: 'completed' }) })]);
  });

  it('Dispatch: the goods back from a part delivery are counted and head office settles the order; the proof is read (M19-FR-02 · D09-FR-05)', async () => {
    const o = await openAs(shop, browser, MGR, '/dispatch');
    try {
      expect(o.writes).toEqual([]);
      await o.page.fill('#cd-back-order', 'o-part');
      await o.page.click('#cd-back-form-go');
      await o.page.locator('#cd-back-MILK').waitFor();
      await o.page.fill('#cd-back-MILK', '1');
      await o.page.fill('#cd-back-DAL', '0');
      await o.page.click('#cd-back-record-go');
      await says(o.page, '#cd-back-record-status', /^Recorded\.$/);
      await o.page.fill('#cd-proof-order', 'o-part');
      await o.page.click('#cd-proof-form-go');
      await says(o.page, '#cd-proof-door', /^The driver's phone has recorded nothing at the door for this order\.$/);
      await says(o.page, '#cd-proof-images', /^No photo or signature kept\.$/);
      expect(o.errors).toEqual([]);
    } finally { await o.close(); }
    const settled = (await as(MGR, 'GET', '/v1/fulfilment/orders/o-part/settlement')).body as Record<string, unknown>;
    expect(settled).toMatchObject({ outcome: 'partially_delivered', keptMinor: 22_000, refundDueMinor: 6_000 });
  });

  it('Delivery exceptions: the owner moves one to the duty manager, with the reason (M19-FR-01)', async () => {
    const o = await openAs(shop, browser, OWNER, '/substitution-exceptions');
    try {
      await o.page.fill('#cd-move-exception', exceptionId);
      await o.page.selectOption('#cd-move-to', 'duty_manager');
      await o.page.fill('#cd-move-reason', 'needs a manager today');
      await o.page.click('#cd-move-form-go');
      await says(o.page, '#cd-move-status', /^Moved\.$/);
      expect(o.errors).toEqual([]);
    } finally { await o.close(); }
    const list = (await as(OWNER, 'GET', '/v1/orders/substitution-exceptions')).body as { exceptions: { exceptionId: string; owner: string }[] };
    expect(list.exceptions.find((x) => x.exceptionId === exceptionId)?.owner).toBe('duty_manager');
  });

  it('Online orders: the customer\'s substitution answer told to staff, the order notices, the refused-access register (FUL-14 · M20-FR-03 · P-04)', async () => {
    const o = await openAs(shop, browser, OWNER, '/online-orders');
    try {
      expect(o.writes).toEqual([]);
      await o.page.fill('#cd-sub-order', 'ord-b');
      await o.page.selectOption('#cd-sub-pref', 'contact_me');
      await o.page.selectOption('#cd-sub-method', 'phone');
      await o.page.fill('#cd-sub-ref', 'call at 10:42 to the number on the order');
      await o.page.click('#cd-sub-form-go');
      await says(o.page, '#cd-sub-status', /^Recorded\.$/);
      await o.page.click('#cd-notices-go');
      await says(o.page, '#cd-notices-list', /^No message about an order is due\.$/);
      await o.page.click('#cd-refusals-go');
      await says(o.page, '#cd-refusals-list li[data-customer="cust-w5-probe"]', /^cust-w5-probe tried to see ord-b · /);
      await o.page.click('#lang');
      await says(o.page, '#desk-refusals-h', /^வேறொருவரின் ஆர்டரைக் கேட்ட வாடிக்கையாளர்கள்$/);
      expect(o.errors).toEqual([]);
    } finally { await o.close(); }
    // "Ask me first", as she said on the phone: a swap now needs her yes — head office refuses it without one.
    const offer = { lineId: 'l1', orderedProductId: 'MILK', orderedName: 'Milk 1L', orderedUnitPriceMinor: 5_000, orderedQuantityMinor: 1, substituteProductId: 'MILK-ALT', substituteName: 'Milk 1L alt', substituteUnitPriceMinor: 4_000, substituteQuantityMinor: 1, offeredAt: AT };
    const swap = await as(OWNER, 'POST', '/v1/orders/ord-b/substitute', { offer, decision: 'confirmed' });
    expect(swap.status).toBe(409);
    expect((swap.body as { error: { code: string } }).error.code).toBe('customer_consent_required');
  });
});
