import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Pool } from 'pg';
import type { Page } from 'playwright-core';
import { CONNECTED, DATABASE_URL, OWNER, ok, startBoxPageOnCloud, type BoxCloudShop } from './lib/box-page-on-cloud';
import { setUpPracticeStores, type RealCloud } from '../support/real-store';
import { onlineReady, sellOnline } from '../support/sell-online';
import { signInOnPhonePage } from '../support/phone-sign-in-page';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { makeEvent } from '../../packages/contracts/src/event';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

/**
 * **W4 · M19-FR-02 · M19-FR-03 · M19-FR-04 · OB-676 · HA-1 · OB-26 "A" — ONE connected run of the picker's and the driver's
 * phones: the real phone screens in Chromium, enrolled on a REAL store computer's device socket, the store computer set up
 * from head office and carrying their work up with its own sync agent, head office the PRODUCTION API on real PostgreSQL.**
 * Synthetic data only; no real customer, no real number; the phones never talk to head office themselves (P-01).
 *
 *   • M19-FR-02 — the dispatcher's wave (RICE ×2 ambient, MILK chilled) reaches the picker's phone from head office. The
 *     picker scans each bin and item, then PACKS the crate with its temperature and its tamper seal. The store computer
 *     carries it up; head office's wave register holds the pack (temperature, seal, no disagreement), each order's pack is
 *     folded from it. On the Dispatch page (served by the same store computer) each order is dispatched with the tamper
 *     seal typed for its crate — a crate with no seal refused on the page, a manifest asked for too early refused in head
 *     office's words — and the manifest head office builds from that pack carries exactly what was packed;
 *   • OB-676 · M19-FR-04 — the owner, on the Dispatch page (served by the same store computer), reads the driver cash limit
 *     "NOT CONFIRMED" with ₹100 only offered as a starting suggestion, and confirms ₹20. Head office's signed setup carries
 *     his confirmation down to the store computer;
 *   • M19-FR-03 — the route head office handed the driver reaches the driver's phone. At the first door he types the
 *     customer's own 4-digit code and takes the cash on delivery; at the second nobody is home: the reason, then back to the
 *     store. Head office records the proof (the code matched, the phone was at the door), the delivery, the failed stop with
 *     its reason and the return to the store;
 *   • M19-FR-04 — at the end of the shift he counts ₹130 against the ₹160 he collected. The phone judges the ₹30 shortfall
 *     against the OWNER's confirmed ₹20 (and no longer says "not confirmed"): the cash office is told. Head office records
 *     the hand-over as material and flags it for the cash office review, and the owner's Dispatch board shows it.
 * Needs DATABASE_URL and Chromium; else it SKIPS.
 */

/** The shop's date field reads day/month/year (U2). */
const ddmm = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

const STORE = 'br-1';
const BOX = 'u-box';
const PICKER = 'u-picker';
const DRIVER = 'u-driver';
const SHOP = { lat: 11.0168, lon: 76.9558 };
const DOOR_1 = { lat: 11.02, lon: 76.96 };
const DOOR_2 = { lat: 11.03, lon: 76.97 };
const SETTINGS = { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 15, warehouseId: STORE };
type Doc = { document: { getElementById(id: string): { dataset: Record<string, string>; textContent: string | null } | null } };
interface PhoneWindow { routeSession?: { route(): { stopId: string; orderRef: string; state: string }[] }; pickSession?: unknown; location: { pathname: string } }

describe.skipIf(!CONNECTED)('W4 · M19-FR-02/03/04 connected: the picker and the driver phones reach head office through the store computer, on PostgreSQL', () => {
  let shop: BoxCloudShop;
  let runDate = '';
  const codes: Record<string, string> = {};

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'picker-app'], { stdio: 'ignore' });
    execFileSync('node', ['scripts/build-app.mjs', 'delivery-app'], { stdio: 'ignore' });
    shop = await startBoxPageOnCloud({
      name: 'w4-m19-phones', store: STORE,
      people: [{ userId: OWNER }],
      link: { boxUser: BOX, storePackFromHeadOffice: true },
      phones: { pins: [PICKER, DRIVER] },
      seed: async (cloud) => {
        const req = (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, userId = OWNER) => cloud.request({ method, path, userId, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
        await setUpPracticeStores(cloud, OWNER, [STORE]);
        await ok(req('POST', `/v1/stores/${STORE}/settings`, SETTINGS), 'store settings');
        for (const f of ['delivery', 'customer_app']) await ok(req('PUT', `/v1/platform/entitlements/${f}`, { enabled: true }), `feature ${f}`);
        await cloud.grant(BOX, 'store_computer', undefined, [STORE]);
        for (const who of [PICKER, DRIVER]) await cloud.grant(who, 'store_manager', undefined, [STORE]);
        await provisionCustomers(cloud, ['c-1', 'c-2']);
        // The product master: rice travels ambient; milk chilled with its own cold-chain limit (HA-3).
        const today = shopDateIn(new Date().toISOString());
        await ok(req('POST', '/v1/catalogue/tax-classes/0401/rates/2017-07-01', { rateBps: 0 }), 'tax');
        for (const [productId, priceMinor, handling] of [['RICE', 80_00, 'ambient'], ['MILK', 30_00, 'chilled']] as const) {
          await ok(req('POST', `/v1/catalogue/products/${productId}/publish`, {
            product: { sku: `${productId}-SKU`, name: `Synthetic ${productId}`, baseUom: 'each', primaryCategoryId: 'grocery-test', taxClass: '0401', lifecycle: 'active', handling, ...(handling === 'chilled' ? { coldChain: { minTenthsC: 0, maxTenthsC: 60 } } : {}), ...onlineReady(priceMinor) },
            categories: [{ categoryId: 'grocery-test', name: 'Grocery (test)', parentId: null }],
          }), `publish ${productId}`);
          await ok(req('POST', `/v1/prices/list/${productId}/entries/e1`, { scope: 'store', scopeRef: STORE, priceMinor, mrpMinor: priceMinor, costMinor: 1, marginFloorBps: 0, currency: 'INR', effectiveFrom: today }), `price ${productId}`);
          await ok(req('POST', '/v1/inventory/movements', { movementId: `rcv-${productId}`, productId, locationId: STORE, kind: 'received', quantityMinor: 50, uom: 'each', unitCostMinor: 50_00, occurredAt: new Date().toISOString(), enteredBy: OWNER }), `receive ${productId}`);
        }
        await ok(req('POST', '/v1/catalogue/pack', { storeId: STORE, asOf: today }), 'catalogue pack');
        await ok(req('POST', '/v1/serviceability/periods/2025-01-01', { radiusMetres: 10_000, deliveryFeeMinor: 0 }), 'no delivery fee');
        await sellOnline((path, body) => req('POST', path, body), ['RICE', 'MILK']);
        for (const [bin, productId] of [['A-01', 'RICE'], ['B-02', 'MILK']] as const) {
          await ok(req('POST', `/v1/warehouse/bins/${bin}`, { storeId: STORE, capacityMinor: 500, pickable: true }), `bin ${bin}`);
          await ok(req('POST', `/v1/warehouse/movements/pa-${productId}`, { kind: 'put_away', storeId: STORE, productId, batchId: null, quantityMinor: 30, uom: 'each', fromBinId: null, toBinId: bin }), `put away ${productId}`);
        }
        await ok(req('PUT', '/v1/serviceability/delivery-service', { storeLocation: SHOP, slotsPerDay: 6, windowOpen: '09:00', windowClose: '21:00', capacityPerSlot: 10, leadMinutes: 60 }), 'delivery service');
        const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
        const svc = (await req('GET', `/v1/serviceability/delivery-service?day=${tomorrow}`)).body as { day: string; slots: { startsAt: string }[] };
        runDate = svc.day;
        for (const [c, orderId, productId, qty, door] of [['c-1', 'ORD-1', 'RICE', 2, DOOR_1], ['c-2', 'ORD-2', 'MILK', 1, DOOR_2]] as const) {
          await ok(req('POST', `/v1/storefront/orders/${orderId}`, { lines: [{ productId, quantityMinor: qty }], locationId: STORE, fulfilment: 'delivery', deliverySlot: { startsAt: svc.slots[1]!.startsAt }, deliveryLocation: door }, c), `place ${orderId}`);
          await ok(req('POST', `/v1/orders/${orderId}/transition`, { event: 'confirm' }), `confirm ${orderId}`);
        }
        // The two phones in head office's device register, each with a one-time enrolment code (made at run time).
        for (const [deviceId, label] of [['hh-pick', 'Picker phone'], ['hh-van', 'Van phone']] as const) {
          await ok(req('POST', `/v1/platform/devices/${deviceId}/register`, { branchId: STORE, kind: 'handheld', label }), `register ${deviceId}`);
          codes[deviceId] = String(((await ok(req('POST', `/v1/platform/devices/${deviceId}/enrolment`, {}), `enrol ${deviceId}`)) as { code: string }).code);
        }
      },
    });
    // OB-26 "A": the store computer's first pull — its setup from head office, signed for this store.
    // The box may already have pulled it on its own schedule: then head office only renews the signature.
    expect(['updated', 'renewed']).toContain((await shop.edge.refreshStorePack!()).status);
  }, 300_000);
  afterAll(async () => { await shop?.stop(); });

  const call = (method: 'GET' | 'POST', path: string, body?: unknown, who = OWNER) => shop.call(method, path, who, body);

  /** Enrol the phone with head office's one-time code, then the person signs in with their own PIN (DF-3-c). */
  async function enrolled(path: '/picker/' | '/driver/', deviceId: string, person: string, geolocation?: { latitude: number; longitude: number }) {
    const p = await shop.phone(path, geolocation === undefined ? {} : { geolocation: { ...geolocation, accuracy: 10 }, permissions: ['geolocation'] });
    await p.page.waitForFunction(() => (globalThis as unknown as PhoneWindow).location.pathname === '/device/enrol', undefined, { timeout: 15_000 });
    await p.page.fill('#deviceId', deviceId);
    await p.page.fill('#code', codes[deviceId]!);
    await p.page.click('button[type="submit"]');
    await signInOnPhonePage(p.page, path === '/picker/' ? 'picker' : 'driver', person);
    return p;
  }
  const scan = async (page: Page, code: string) => { await page.keyboard.type(code); await page.keyboard.press('Enter'); };
  const handedToBox = (page: Page, kind: string, id: string) => page.waitForSelector(`#sent-work .sent[data-kind="${kind}"][data-id="${id}"][data-state="handed_to_box"]`, { timeout: 15_000 });

  it('M19-FR-02: the picker packs the wave on the phone; the pack, each order\'s pack and the manifest are head office\'s on PostgreSQL', async () => {
    // The dispatcher plans the day and hands the route to its driver; builds the wave for the picker (HA-1, head office).
    const planned = (await ok(call('POST', `/v1/delivery/dispatch/${runDate}/plan-from-orders`, { storeId: STORE, drivers: [{ driverId: DRIVER, maxStops: 10, availableFrom: `${runDate}T00:30:00.000Z`, availableUntil: `${runDate}T17:30:00.000Z` }], averageSpeedKmh: 20, serviceMinutesPerStop: 5 }), 'plan')) as { plan: { routes: { routeId: string; stops: { orderId: string }[] }[] } };
    expect(planned.plan.routes).toHaveLength(1);
    expect(planned.plan.routes[0]!.stops.map((s) => s.orderId).sort()).toEqual(['ORD-1', 'ORD-2']);
    await ok(call('POST', `/v1/delivery/dispatch/${runDate}/routes/${encodeURIComponent(planned.plan.routes[0]!.routeId)}/assign`, { storeId: STORE }), 'route to the driver');
    const built = (await ok(call('POST', '/v1/fulfilment/waves/W-1/build', { storeId: STORE, pickerId: PICKER, orderIds: ['ORD-1', 'ORD-2'] }), 'wave')) as { lineCount: number; refused: unknown[] };
    expect(built).toMatchObject({ lineCount: 2, refused: [] });
    // The store computer's first assignments pull — on its first day, before any restart (the W4 fix).
    expect(shop.edge.refreshAssignmentsFeed, 'the box asks head office for its store\'s work').not.toBeNull();
    expect((await shop.edge.refreshAssignmentsFeed!()).status).toBe('updated');

    const { page, errors, close } = await enrolled('/picker/', 'hh-pick', PICKER);
    try {
      await page.waitForFunction(() => (globalThis as unknown as PhoneWindow).pickSession !== undefined, undefined, { timeout: 15_000 });
      await page.locator('#wave', { hasText: 'W-1' }).waitFor({ timeout: 15_000 });
      for (const [bin, item, name] of [['A-01', 'RICE', 'Synthetic RICE'], ['B-02', 'MILK', 'Synthetic MILK']] as const) {
        await scan(page, bin);
        await page.locator('#scan-title', { hasText: `Scan the item — ${name}` }).waitFor({ timeout: 15_000 });
        await scan(page, item);
        await page.waitForSelector('#sheet:not([hidden])');
        // Head office's line is in "each" (the product master's spelling): the sheet offers what was asked as a count
        // (W4 found it pre-filled "NaN.NaN" and the pick silently not made — fixed in apps/picker-app/src/pick-session.ts).
        expect(await page.textContent('#sheet-title')).toBe('How many are you taking?');
        expect(await page.textContent('#entry')).toBe(item === 'RICE' ? '2' : '1');
        await page.click('#sheet-ok');
        await page.waitForSelector('#banner:not([hidden])');
        expect(await page.textContent('#banner-title')).toBe('Picked');
        await page.click('#banner-ok');
      }
      await page.locator('#step', { hasText: 'Every line is resolved' }).waitFor({ timeout: 15_000 });
      await page.click('#pack');
      await page.locator('#sheet-title', { hasText: 'Cold-chain temperature in °C' }).waitFor({ timeout: 15_000 });
      await page.click('#sheet-ok');
      await page.locator('#scan-title', { hasText: 'Scan the tamper seal' }).waitFor({ timeout: 15_000 });
      await scan(page, 'SEAL-W4-1');
      await page.locator('#banner-title', { hasText: 'Crate packed' }).waitFor({ timeout: 15_000 });
      expect(await page.textContent('#banner-text')).toBe('2 items on the manifest · Value ₹190.00');
      await page.click('#banner-ok');
      await handedToBox(page, 'pack', 'W-1');

      // The store computer's own sync agent carries the picks and the pack to head office.
      const pass = await shop.edge.syncOnce!();
      expect(pass.dead, JSON.stringify(pass)).toBe(0);
      const wave = (await ok(call('GET', '/v1/fulfilment/waves/W-1'), 'wave')) as { packed: Record<string, unknown> | null; flags: string[] };
      expect(wave.packed).toMatchObject({ packedBy: PICKER, relayedBy: BOX, lineCount: 2, totalValueMinor: 190_00, temperatureC: 4, tamperSealRef: 'SEAL-W4-1' });
      expect(wave.flags).toEqual([]);
      // Each order's pack, folded from the crate by the product master's handling class; the manifest built from it.
      const pack1 = (await ok(call('GET', '/v1/fulfilment/orders/ORD-1/pack'), 'pack ORD-1')) as { lines: { productId: string; packedMinor: number; crateId: string }[]; refused: unknown[]; totalMinor: number };
      expect(pack1.refused).toEqual([]);
      expect(pack1.lines.map((l) => [l.productId, l.packedMinor])).toEqual([['RICE', 2]]);
      expect(pack1.totalMinor).toBe(160_00);
      const pack2 = (await ok(call('GET', '/v1/fulfilment/orders/ORD-2/pack'), 'pack ORD-2')) as { lines: { productId: string; packedMinor: number; crateId: string }[]; refused: unknown[] };
      expect(pack2.refused).toEqual([]);
      expect(pack2.lines.map((l) => [l.productId, l.packedMinor])).toEqual([['MILK', 1]]);
      // ── The dispatch office, on the Dispatch page the store computer serves: each order leaves with a manifest head
      // office builds from what was packed; the tamper seal typed for each crate (W4: on the screen, not the API).
      const d = await shop.open(OWNER, '/dispatch');
      try {
        expect(d.status).toBe(200);
        await d.page.fill('#store', STORE);
        for (const [orderId, product, other] of [['ORD-1', 'RICE', 'MILK'], ['ORD-2', 'MILK', 'RICE']] as const) {
          await d.page.fill('#send-order', orderId);
          // Not dispatched yet: head office has no manifest, and the page says so in head office's words.
          await d.page.click('#show-manifest');
          await d.page.locator('#send-status', { hasText: 'Head office refused:' }).waitFor({ timeout: 15_000 });
          await d.page.click('#show-pack');
          await d.page.locator(`#pack-lines li.row[data-line]`, { hasText: `(${product})` }).waitFor({ timeout: 15_000 });
          expect(await d.page.locator('#pack-lines li.row').count()).toBe(1);
          // A crate with no seal is refused on the page; nothing is asked.
          const before = d.writes.length;
          await d.page.click('#dispatch-order');
          await d.page.locator('#send-status', { hasText: 'Type the tamper seal on every crate.' }).waitFor({ timeout: 15_000 });
          expect(d.writes.length).toBe(before);
          for (const input of await d.page.locator('#crate-seals input.seal').all()) await input.fill('SEAL-W4-1');
          await d.page.click('#dispatch-order');
          await d.page.locator('#send-status', { hasText: `✓ Dispatched — manifest MF-${orderId}` }).waitFor({ timeout: 15_000 });
          const shown = d.page.locator(`#manifest[data-manifest="MF-${orderId}"]`);
          await shown.waitFor({ timeout: 15_000 });
          const words = await shown.innerText();
          expect(words).toMatch(new RegExp(`Manifest MF-${orderId} · ${orderId} · 1 crates · .* · dispatched by ${OWNER}`));
          expect(words).toContain(`(${product})`);
          expect(words).not.toContain(`(${other})`);
          expect(words).toMatch(/Seals: .+ → SEAL-W4-1/);
          // Head office holds the manifest on PostgreSQL, built from the pack — exactly what was packed, sealed.
          const manifest = (await ok(call('GET', `/v1/fulfilment/orders/${orderId}/manifest`), `manifest ${orderId}`)) as { manifestId: string; orderId: string; locationId: string; dispatchedBy: string; lines: { productId: string; quantityMinor: number }[]; seals: Record<string, string> };
          expect(manifest).toMatchObject({ manifestId: `MF-${orderId}`, orderId, locationId: STORE, dispatchedBy: OWNER });
          expect(manifest.lines.map((l) => [l.productId, l.quantityMinor])).toEqual([[product, orderId === 'ORD-1' ? 2 : 1]]);
          expect(Object.values(manifest.seals)).toEqual(['SEAL-W4-1']);
        }
        expect(d.writes.filter((w) => w.endsWith('/dispatch'))).toEqual(['POST /v1/fulfilment/orders/ORD-1/dispatch', 'POST /v1/fulfilment/orders/ORD-2/dispatch']);
        await d.page.click('#lang');
        expect(await d.page.textContent('#send-h')).toBe('பேக் செய்த ஆர்டரை அனுப்பு');
        expect(d.errors).toEqual([]);
      } finally { await d.close(); }
      // The phone sees head office's word for its work once the box has it.
      await page.reload({ waitUntil: 'load' });
      await page.waitForSelector('#sent-work .sent[data-kind="pack"][data-id="W-1"][data-state="posted"]', { timeout: 30_000 });
      expect(errors).toEqual([]);
    } finally { await close(); }
  }, 240_000);

  it('OB-676 · M19-FR-03/04: the owner confirms ₹20 on the Dispatch page; the driver proves the door, fails a stop with its reason and hands over ₹30 short — material against HIS limit, flagged at head office and on the board', async () => {
    // ── The owner, on the Dispatch page the store computer serves: "not confirmed" until he confirms; he confirms ₹20.
    const o = await shop.open(OWNER, '/dispatch');
    expect(o.status).toBe(200);
    await o.page.fill('#store', STORE);
    await o.page.fill('#run-date', ddmm(runDate));
    await o.page.click('#show-tolerance');
    const stateIs = (s: string) => o.page.waitForFunction((x) => (globalThis as unknown as Doc).document.getElementById('tolerance-state')?.dataset['state'] === x, s, { timeout: 15_000 });
    await stateIs('not_confirmed');
    expect(await o.page.innerText('#tolerance-state')).toMatch(/NOT CONFIRMED by the owner .*Starting suggestion: ₹100\.00\./);
    await o.page.fill('#tolerance-value', '20');
    await o.page.fill('#tolerance-note', 'synthetic test limit for this run');
    await o.page.click('#confirm-tolerance');
    await stateIs('confirmed');
    expect(await o.page.innerText('#tolerance-state')).toMatch(/₹20\.00 — Confirmed by the owner/);
    // Head office's signed setup carries his figure and his confirmation down to the store computer.
    // The box may already have pulled it on its own schedule: then head office only renews the signature.
    expect(['updated', 'renewed']).toContain((await shop.edge.refreshStorePack!()).status);

    // ── The driver's phone: the route head office handed him, from the store computer.
    const first = await enrolled('/driver/', 'hh-van', DRIVER, { latitude: DOOR_1.lat, longitude: DOOR_1.lon });
    const page = first.page;
    try {
      await page.waitForFunction(() => ((globalThis as unknown as PhoneWindow).routeSession?.route().length ?? 0) === 2, undefined, { timeout: 15_000 });
      const stops = await page.evaluate(() => (globalThis as unknown as PhoneWindow).routeSession!.route().map((s) => ({ stopId: s.stopId, orderRef: s.orderRef })));
      expect(stops.map((s) => s.orderRef).sort()).toEqual(['ORD-1', 'ORD-2']);
      const stopOf = new Map(stops.map((s) => [s.stopId, s.orderRef]));
      // The customer's own delivery code, as their app shows it (head office issued it for this order).
      const code = ((await ok(call('GET', '/v1/storefront/orders/ORD-1/delivery-code', undefined, 'c-1'), 'code')) as { code: string }).code;

      // ORD-1's door: the customer's code on the keypad, then the ₹160 cash on delivery the order says.
      await page.locator('#stops .order', { hasText: 'ORD-1' }).click();
      await page.click('#deliver');
      await page.locator('#choices button', { hasText: '4-digit code' }).click();
      await page.waitForSelector('#keypad:not([hidden])');
      for (const d of code) await page.click(`#keypad button:text-is("${d}")`);
      await page.click('#sheet-ok');
      await page.locator('#choices button', { hasText: 'Cash' }).click();
      await page.waitForSelector('#keypad:not([hidden])');
      expect(await page.textContent('#entry')).toBe('160');
      await page.click('#sheet-ok');
      await page.locator('#banner-title', { hasText: 'Delivered' }).waitFor({ timeout: 15_000 });
      await page.click('#banner-ok');

      // ORD-2's door: nobody at home → back to the store.
      await page.locator('#stops .order', { hasText: 'ORD-2' }).click();
      await page.click('#failed');
      await page.locator('#choices button', { hasText: 'Nobody at home' }).click();
      await page.locator('#choices button', { hasText: 'Take it back' }).click();
      await page.locator('#banner-title', { hasText: 'Recorded as not delivered' }).waitFor({ timeout: 15_000 });
      await page.click('#banner-ok');

      // End of shift: he counts ₹100 + ₹20 + ₹10 = ₹130 against the ₹160 he collected — ₹30 short, judged against the
      // OWNER's confirmed ₹20 (the starting suggestion of ₹100 would have let it pass without the cash office).
      await page.click('#handover');
      await page.waitForSelector('#count:not([hidden])');
      for (const n of ['100', '20', '10']) await page.click(`button[aria-label="one more ₹${n}.00"]`);
      expect(await page.textContent('#count-total')).toBe('Counted: ₹130.00');
      await page.click('#count-ok');
      await page.waitForSelector('#banner:not([hidden])');
      expect(await page.textContent('#banner-title')).toBe('You have less than the day recorded, by ₹30.00');
      const said = (await page.textContent('#banner-text')) ?? '';
      expect(said).toContain('cash office must be told');
      expect(said, 'the limit is the owner\'s confirmed one — the phone no longer says it is not confirmed').not.toContain('not confirmed');
      await page.click('#banner-ok');
      await page.waitForSelector('#sent-work .sent[data-kind="handover"][data-state="handed_to_box"]', { timeout: 15_000 });

      // The store computer carries the shift up; head office holds it on PostgreSQL.
      const pass = await shop.edge.syncOnce!();
      expect(pass.dead, JSON.stringify(pass)).toBe(0);
      const board = (await ok(call('GET', `/v1/delivery/dispatch/${runDate}/board?storeId=${STORE}`), 'board')) as { routes: { routeId: string }[]; handoverTolerance: { valueMinor: number; state: string } };
      expect(board.handoverTolerance).toEqual({ valueMinor: 20_00, state: 'confirmed' });
      const routeId = board.routes[0]!.routeId;
      const route = (await ok(call('GET', `/v1/delivery/routes/${encodeURIComponent(routeId)}`), 'route')) as {
        stops: { stopId: string; state: string }[]; cash: Record<string, number>; handover: Record<string, unknown> | null;
      };
      expect(route.stops.map((s) => [stopOf.get(s.stopId), s.state]).sort()).toEqual([['ORD-1', 'delivered'], ['ORD-2', 'returned_to_origin']]);
      expect(route.cash).toEqual({ expectedMinor: 160_00, collectedMinor: 160_00, cashHeldMinor: 160_00 });
      expect(route.handover).toMatchObject({ driverId: DRIVER, relayedBy: BOX, countedMinor: 130_00, recordedMinor: 160_00, varianceMinor: -30_00, material: true, governanceFlags: ['cash_office_review'] });
      // The orders followed the phone: delivered with the proof; the other failed with its reason and went back to the store.
      const delivered = (await ok(call('GET', '/v1/delivery/orders/ORD-1'), 'order')) as { state: string; history: Record<string, unknown>[] };
      expect(delivered.state).toBe('delivered');
      expect(delivered.history.at(-1)).toMatchObject({ event: 'deliver', by: DRIVER });
      const back = (await ok(call('GET', '/v1/delivery/orders/ORD-2'), 'order')) as { state: string; history: Record<string, unknown>[] };
      expect(back.state).toBe('returned_to_origin');
      expect(back.history.map((h) => h['event']).slice(-2)).toEqual(['fail', 'rto']);
      // The reason rides on head office's route register, beside the stop.
      expect(JSON.stringify(route.stops)).toContain('nobody_home');
      expect(first.errors).toEqual([]);
    } finally { await first.close(); }

    // ── The owner's board: the proof checked (the right code, at the door), the failed stop, and the hand-over for the cash office.
    await o.page.click('#show-board');
    const row = o.page.locator('#board li.row').first();
    await row.locator('.facts.cash', { hasText: 'counted' }).waitFor({ timeout: 15_000 });
    const words = await row.innerText();
    expect(words).toMatch(/delivered · Code: ✓/);
    expect(words).toMatch(/returned to origin/);
    expect(await row.locator('.facts.cash').innerText()).toMatch(/counted ₹130\.00 · difference .*30\.00 · ⚠ cash office must look$/);
    expect(await o.page.isHidden('#board-tolerance'), 'his limit is confirmed — the board no longer warns').toBe(true);
    expect(o.errors).toEqual([]);
    await o.close();
  }, 240_000);
});

/**
 * A customer's storefront login is an outside party's (OB-76); for the phones' journey the two synthetic customers are
 * provisioned straight onto the ledger, the way tenant provisioning seeds a login (as the W3 D09 connected run does).
 */
async function provisionCustomers(cloud: RealCloud, ids: readonly string[]): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 1, options: '-c app.tenant_id=*' });
  try {
    const ledger = new SqlEventStore(pgPoolClient(pool));
    for (const c of ids) {
      await ledger.append(cloud.tenantId, 'identity', makeEvent({
        id: `grant-customer-${c}`, type: 'RoleGranted', occurredAt: new Date().toISOString(), idempotencyKey: `grant-${cloud.tenantId}-customer-${c}`, source: 'test/provision',
        payload: { userId: c, roleId: 'customer', branchScope: 'all', request: { grantId: `customer-${c}`, userId: c, roleId: 'customer', branchScope: 'all', requestedBy: 'test', approvedBy: 'test', requestedAt: new Date().toISOString() } },
      }));
    }
  } finally { await pool.end(); }
}
