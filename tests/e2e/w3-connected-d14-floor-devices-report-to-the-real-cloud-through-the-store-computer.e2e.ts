import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { CONNECTED, OWNER, startBoxPageOnCloud, operatorGrant, type BoxCloudShop } from './lib/box-page-on-cloud';
import { says } from './lib/r4c-box-page';
import { aStoreWithRules } from '../support/store-rules';
import { nameSecurityReviewer, switchFloorDeviceOn } from '../support/floor-device-switch';
import { deviceBatchMessage } from '../../packages/integration/src/floor-devices';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

/**
 * **W3 · D14 (D14-FR-05 ESL/RFID/CCTV-event/IoT readiness · OB-407 · P-08 · hard rules #2 and #5): ONE connected run —
 * the "Shelf labels and floor devices" page in a real browser, served by a REAL store computer, over the PRODUCTION API on
 * real PostgreSQL.** Every device is a STAND-IN (no vendor is connected); every key is made at run time.
 *   • the owner registers an electronic shelf label, an RFID reader and a camera event source on the page, each with its own
 *     public key; each kind was switched on by the owner AND the named security reviewer (OB-407), on head office;
 *   • the store's floor-device gateway (a machine identity) relays the devices' signed reports to the real API: a shelf
 *     count of 37 against a book of 40, and camera events (one with a field that is not allowed — refused and KEPT);
 *   • a price change sends the price to the label, which never shows it back: the page says it is not confirmed and sends
 *     the SAME price again; the RFID difference is listed for a person to count — the book on PostgreSQL still says 40 (a
 *     reader never moves stock); the camera event shows next to the till void;
 *   • the owner blocks the label with a reason, then reinstates it — each a new event; Tamil words; no page errors.
 * Needs DATABASE_URL and Chromium; else it SKIPS.
 */

const IT = 'u-it'; const REVIEWER = 'u-rev'; const GATEWAY = 'u-gw'; const BOX = 'u-box'; const CASH = 'u-cash';
const STORE = 'store-1';

interface Device { readonly id: string; readonly publicKey: string; readonly privateKey: KeyObject }
const device = (id: string): Device => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { id, publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey };
};
const signed = (d: Device, events: unknown[]): { events: unknown[]; signature: string } =>
  ({ events, signature: sign(null, Buffer.from(deviceBatchMessage(d.id, events)), d.privateKey).toString('base64') });
const esl = device('esl-1'); const rfid = device('rfid-1'); const cam = device('cam-1');
const minutesAgo = (n: number): string => new Date(Date.now() - n * 60_000).toISOString();

describe.skipIf(!CONNECTED)('D14 connected: shelf labels and floor devices on the store computer, over the real cloud on PostgreSQL', () => {
  let shop: BoxCloudShop;
  beforeAll(async () => {
    shop = await startBoxPageOnCloud({
      name: 'd14-floor-devices', store: STORE,
      people: [{ userId: OWNER }],
      seed: async (cloud, ho, store) => {
        const T = cloud.tenantId;
        const ok = async (method: 'POST' | 'PUT', path: string, userId: string, body: unknown, branchId?: string) => {
          const r = await ho.request({ method, path, userId, tenantId: T, idempotencyKey: `k-${randomUUID()}`, body, ...(branchId === undefined ? {} : { branchId }) });
          if (r.status >= 300) throw new Error(`${path}: ${r.status} ${JSON.stringify(r.body)}`);
        };
        await aStoreWithRules(ho, T, OWNER, store, 0);
        // The platform administrator, the security reviewer and the two machine identities are laid on by the operator (the
        // owner may not hand out roles carrying words he does not hold himself); the cashier the product's own way.
        await operatorGrant(cloud, IT, 'platform_admin');
        await operatorGrant(cloud, REVIEWER, 'security_reviewer');
        await operatorGrant(cloud, GATEWAY, 'floor_device_gateway', [store]);
        await operatorGrant(cloud, BOX, 'store_computer', [store]);
        await cloud.grant(CASH, 'cashier', undefined, [store]);
        await ok('POST', '/v1/platform/devices/lane-1/register', OWNER, { branchId: store, kind: 'pos_lane', label: 'Lane 1' });
        await ok('POST', '/v1/catalogue/tax-classes/34011190/rates/2017-07-01', OWNER, { rateBps: 1_800 });
        await ok('POST', '/v1/catalogue/products/p-soap/publish', OWNER, { product: { sku: 'SKU-SOAP', name: 'Soap 100g', baseUom: 'ea', primaryCategoryId: 'home', taxClass: '34011190', lifecycle: 'draft' }, categories: [{ categoryId: 'home', name: 'Home', parentId: null }] });
        await ok('POST', '/v1/inventory/movements', OWNER, { movementId: 'soap-in', productId: 'p-soap', locationId: store, kind: 'received', quantityMinor: 40, uom: 'ea', occurredAt: minutesAgo(30), enteredBy: OWNER });
        await nameSecurityReviewer(ho, T, OWNER, REVIEWER);
        for (const key of ['esl', 'rfid', 'cctv']) {
          const r = await switchFloorDeviceOn(ho, T, { switcher: IT, owner: OWNER, reviewer: REVIEWER }, key, { branchId: store, reason: `${key} trial (synthetic)` });
          if (r.status >= 300) throw new Error(`switch ${key}: ${r.status} ${JSON.stringify(r.body)}`);
        }
      },
    });
  }, 300_000);
  afterAll(async () => { await shop?.stop(); });

  const relay = (d: Device, events: unknown[]) => shop.call('POST', `/v1/devices/floor/${d.id}/events`, GATEWAY, signed(d, events), STORE);

  it('registers devices, shows what they reported, sends an unconfirmed price again and blocks a label', async () => {
    const p = await shop.open(OWNER, '/floor-devices');
    expect(p.status).toBe(200);
    await says(p.page, '#standin', /No device maker is connected yet/);
    await says(p.page, '#dev-rows', /No floor device registered for this store yet/);
    expect(p.writes, 'nothing is written on open').toEqual([]);
    const register = async (d: Device, kind: string, label: string, fill: Record<string, string>) => {
      await p.page.fill('#r-id', d.id);
      await p.page.selectOption('#r-kind', kind);
      await p.page.fill('#r-label', label);
      await p.page.fill('#r-vendor', 'stand-in');
      for (const [id, v] of Object.entries(fill)) await p.page.fill(id, v);
      await p.page.fill('#r-key', d.publicKey);
      // Each registration is judged on its own answer (the last one's words are cleared first): over the real cloud an
      // answer takes longer, and the next form must not be filled while the last is still being saved.
      await p.page.evaluate(() => { (globalThis as unknown as { document: { getElementById(i: string): { textContent: string } } }).document.getElementById('reg-status').textContent = ''; });
      await p.page.click('#r-save');
      await says(p.page, '#reg-status', /^Registered\. Its kind is switched on here/);
    };
    await p.page.click('#r-save');
    await says(p.page, '#reg-status', /Fill in the name/);
    expect(p.writes, 'an empty form sends nothing').toEqual([]);
    await register(esl, 'esl_label', 'Soap label', { '#r-product': 'p-soap', '#r-shelf': 'A1-01' });
    await register(rfid, 'rfid_reader', 'Back store reader', { '#r-location': STORE });
    await register(cam, 'cctv_source', 'Lane camera', { '#r-camera': 'CAM-1', '#r-lanes': 'lane-1' });
    await says(p.page, '#dev-rows', /Soap label \(esl-1\).*Shelf label.*p-soap at A1-01.*On.*never heard from/);
    await says(p.page, '#v-silent', /^3$/);

    // The devices report through the store's gateway (a machine identity), each batch signed by its own device.
    expect((await relay(rfid, [{ eventId: 'r1', type: 'rfid.read', at: minutesAgo(2), productId: 'p-soap', countedUnits: 37 }])).status).toBe(200);
    expect((await shop.call('POST', '/v1/loss-prevention/activity/act-1/synced', BOX, { activityId: 'act-1', kind: 'void', laneId: 'lane-1', cashierId: CASH, billRef: 'bill-1', lineId: 'l1', productId: 'p-soap', description: 'Soap 100g', valueMinor: 4_500, reason: 'customer changed mind', at: minutesAgo(5), storeId: STORE }, STORE)).status).toBeLessThan(300);
    expect((await relay(cam, [{ eventId: 'c1', type: 'cctv.event', at: minutesAgo(4), from: minutesAgo(6), to: minutesAgo(4), eventKind: 'lane_activity' }, { eventId: 'c2', type: 'cctv.event', at: minutesAgo(4), from: minutesAgo(6), to: minutesAgo(4), eventKind: 'person', faceId: 'f-9' }])).status).toBe(200);
    expect((await shop.call('POST', '/v1/prices/changes', OWNER, { productId: 'p-soap', priceMinor: 4_500, mrpMinor: 6_000, costMinor: 2_000, currency: 'INR', marginFloorBps: 0 })).status).toBeLessThan(300);

    await p.page.click('#refresh');
    await says(p.page, '#esl-list', /p-soap at ₹45\.00 \(price change, .*\): 0 of 1 label\(s\) confirmed — Not confirmed: Soap label/);
    await says(p.page, '#v-pushes', /^1$/);
    await p.page.click('#esl-list button');
    await says(p.page, '#esl-status', /^The same price was sent again to Soap label\.$/);
    await says(p.page, '#esl-list', /sent again/);
    await says(p.page, '#rfid-list', /p-soap at store-1: counted 37, book 40 \(-3\)/);
    await says(p.page, '#ex-list', /Report c2 from Lane camera: .*\(/);
    await p.page.fill('#cam-day', shopDateIn(minutesAgo(4)));
    await p.page.click('#cam-read');
    await says(p.page, '#cam-list', /Camera CAM-1, lane_activity, .*: 1 till exception\(s\).*void at lane-1 by u-cash, ₹45\.00/);
    // Hard rule #2: the reader changed nothing — the book on PostgreSQL still says 40.
    const avail = (await shop.call('GET', '/v1/inventory/availability?productId=p-soap', OWNER)).body as { rows: { locationId: string; onHandMinor: number }[] };
    expect(avail.rows.filter((r) => r.locationId === STORE).map((r) => r.onHandMinor)).toEqual([40]);

    await p.page.fill('#st-reason', 'battery door broken (synthetic)');
    await p.page.click('#dev-rows tr[data-id="esl-1"] button:has-text("Block")');
    await says(p.page, '#dev-status', /^esl-1 is now Blocked\. The history is kept\.$/);
    await p.page.fill('#st-reason', 'battery door fixed (synthetic)');
    await p.page.click('#dev-rows tr[data-id="esl-1"] button:has-text("Reinstate")');
    await says(p.page, '#dev-status', /^esl-1 is now Working\./);
    expect(p.writes.filter((w) => w.startsWith('POST /v1/devices/floor/')).length, 'three registrations, a block and a reinstate').toBe(5);
    expect(p.writes.filter((w) => /^POST \/v1\/devices\/esl\/pushes\/.+\/retry$/.test(w)).length, 'the same price sent again, once').toBe(1);
    await p.page.click('#lang');
    await says(p.page, '#page-h', /^அலமாரி லேபிள்களும் தளச் சாதனங்களும்$/ /* named as the menu names it (navigation.ts) */);
    expect(p.errors).toEqual([]);
    await p.close();
  }, 180_000);
});
