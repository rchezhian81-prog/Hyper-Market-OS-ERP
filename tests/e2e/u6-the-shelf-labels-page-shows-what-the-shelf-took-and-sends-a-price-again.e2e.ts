import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { CONNECTED, OWNER, startBoxPageOnCloud, operatorGrant, type BoxCloudShop } from './lib/box-page-on-cloud';
import { says } from './lib/r4c-box-page';
import { confirmIt } from './lib/confirm-sheet';
import { aStoreWithRules } from '../support/store-rules';
import { nameSecurityReviewer, switchFloorDeviceOn } from '../support/floor-device-switch';
import { deviceBatchMessage } from '../../packages/integration/src/floor-devices';

/**
 * **U6 (UI/UX gap audit §27 "Product — label/ESL: no screen" · D14-FR-05 · D06-FR-06 · P-02 · P-03 · P-08 · OB-698): the
 * Electronic shelf labels page in a real browser, served by a REAL store computer, over the PRODUCTION API on real
 * PostgreSQL.** A label is registered for the soap; a price change sends ₹45.00 to it; the page shows the price sent, that no
 * label has shown it, the label counts, and offers "Send again" — behind the confirm sheet, the SAME price; the label then
 * echoes the price and the page says it is shown on every label. Tamil words on the toggle; a cashier is told the page is
 * not theirs and nothing is written. Needs DATABASE_URL and Chromium; else it SKIPS.
 */
const IT = 'u-it'; const REVIEWER = 'u-rev'; const GATEWAY = 'u-gw'; const CASH = 'u-cash';
const STORE = 'store-1';
interface Device { readonly id: string; readonly publicKey: string; readonly privateKey: KeyObject }
const device = (id: string): Device => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { id, publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey };
};
const signed = (d: Device, events: unknown[]): { events: unknown[]; signature: string } =>
  ({ events, signature: sign(null, Buffer.from(deviceBatchMessage(d.id, events)), d.privateKey).toString('base64') });
const esl = device('esl-1');

describe.skipIf(!CONNECTED)('U6: the Electronic shelf labels page on the store computer, over the real cloud on PostgreSQL', () => {
  let shop: BoxCloudShop;
  beforeAll(async () => {
    shop = await startBoxPageOnCloud({
      name: 'u6-esl', store: STORE,
      people: [{ userId: OWNER }, { userId: CASH, branchId: STORE }],
      seed: async (cloud, ho, store) => {
        const T = cloud.tenantId;
        const ok = async (method: 'POST' | 'PUT', path: string, userId: string, body: unknown, branchId?: string) => {
          const r = await ho.request({ method, path, userId, tenantId: T, idempotencyKey: `k-${randomUUID()}`, body, ...(branchId === undefined ? {} : { branchId }) });
          if (r.status >= 300) throw new Error(`${path}: ${r.status} ${JSON.stringify(r.body)}`);
        };
        await aStoreWithRules(ho, T, OWNER, store, 0);
        await operatorGrant(cloud, IT, 'platform_admin');
        await operatorGrant(cloud, REVIEWER, 'security_reviewer');
        await operatorGrant(cloud, GATEWAY, 'floor_device_gateway', [store]);
        await cloud.grant(CASH, 'cashier', undefined, [store]);
        await ok('POST', '/v1/platform/devices/lane-1/register', OWNER, { branchId: store, kind: 'pos_lane', label: 'Lane 1' });
        await ok('POST', '/v1/catalogue/tax-classes/34011190/rates/2017-07-01', OWNER, { rateBps: 1_800 });
        await ok('POST', '/v1/catalogue/products/p-soap/publish', OWNER, { product: { sku: 'SKU-SOAP', name: 'Soap 100g', baseUom: 'ea', primaryCategoryId: 'home', taxClass: '34011190', lifecycle: 'draft' }, categories: [{ categoryId: 'home', name: 'Home', parentId: null }] });
        await nameSecurityReviewer(ho, T, OWNER, REVIEWER);
        const sw = await switchFloorDeviceOn(ho, T, { switcher: IT, owner: OWNER, reviewer: REVIEWER }, 'esl', { branchId: store, reason: 'esl trial (synthetic)' });
        if (sw.status >= 300) throw new Error(`switch esl: ${sw.status} ${JSON.stringify(sw.body)}`);
        await ok('POST', `/v1/devices/floor/${esl.id}`, IT, { branchId: store, kind: 'esl_label', label: 'Soap label', vendor: 'stand-in', publicKey: esl.publicKey, productId: 'p-soap', shelfAddress: 'A1-01' });
        // A price change sends the price to the label; the label has not shown it back yet.
        await ok('POST', '/v1/prices/changes', OWNER, { productId: 'p-soap', priceMinor: 4_500, mrpMinor: 6_000, costMinor: 2_000, currency: 'INR', marginFloorBps: 0 });
      },
    });
  }, 240_000);
  afterAll(async () => { await shop?.stop(); });

  it('shows the price sent and not yet shown, sends the same price again behind the confirm sheet, then sees it shown; Tamil on the toggle', async () => {
    const p = await shop.open(OWNER, '/esl');
    await says(p.page, '#standin', /No label maker is connected yet/);
    await says(p.page, '#cards', /Prices sent\s*1/);
    await says(p.page, '#cards', /Not yet on every label\s*1/);
    await says(p.page, '#cards', /Labels at this store\s*1/);
    await says(p.page, '#cards', /Never heard from\s*1/);
    const row = p.page.locator('#pushes-table tbody tr[data-push]').first();
    await row.waitFor({ timeout: 15_000 });
    const rowText = await row.innerText();
    expect(rowText).toMatch(/p-soap/);
    expect(rowText).toContain('₹45.00');
    expect(rowText).toContain('Not shown by any label');
    expect(rowText).toContain('price change');
    await says(p.page, '#send-all-text', /^Send the 1 unconfirmed price\(s\) again$/);
    expect(await p.page.isEnabled('#send-all')).toBe(true);

    // The same price, again — behind the confirm sheet (OB-698), in the owner's name.
    const writesBefore = p.writes.length;
    await row.locator('button[data-push]').click();
    await confirmIt(p.page);
    await says(p.page, '#send-status', /^Sent again to 1 label\(s\)\./);
    expect(p.writes.length).toBe(writesBefore + 1);
    expect(p.writes[writesBefore]).toMatch(/^POST \/v1\/devices\/esl\/pushes\/.*\/retry$/);
    await says(p.page, '#cards', /Prices sent\s*2/);
    await says(p.page, '#pushes-table', /sent again/);
    expect(await p.page.locator('#pushes-table tbody tr[data-push]').count()).toBe(2);

    // The label echoes the price through the store's gateway: now shown on every label.
    const echo = await shop.call('POST', `/v1/devices/floor/${esl.id}/events`, GATEWAY,
      signed(esl, [{ eventId: 'e1', type: 'esl.echo', at: new Date(Date.now() + 1_000).toISOString(), productId: 'p-soap', displayedPriceMinor: 4_500, batteryPercent: 80 }]), STORE);
    expect(echo.status, JSON.stringify(echo.body)).toBe(200);
    await p.page.click('#refresh');
    await says(p.page, '#cards', /Shown on every label\s*2/);
    await says(p.page, '#cards', /Not yet on every label\s*0/);
    expect(await p.page.isEnabled('#send-all')).toBe(false);
    await says(p.page, '#send-all-why', /nothing to send again/);
    expect(await p.page.locator('#pushes-table tbody tr[data-push] button[data-push]').count()).toBe(0);

    await p.page.click('#lang');
    await says(p.page, '#page-h', /^மின்னணு அலமாரி லேபிள்கள்$/);
    await says(p.page, '#cards', /அனுப்பிய விலைகள்/);
    await says(p.page, '#pushes-table', /எல்லா லேபிள்களிலும் காட்டப்பட்டது/);
    expect(p.errors).toEqual([]);
    await p.close();
  });

  it('a cashier is refused the screen by the store computer itself, in words, and nothing is written', async () => {
    // The menu item needs `price.integrity.audit`; the box serves a screen only to a person who holds its word (P-07).
    const c = await shop.open(CASH, '/esl');
    expect(c.status).toBe(403);
    expect(await c.page.locator('body').innerText()).toMatch(/may not open this screen/);
    expect(c.writes).toEqual([]);
    await c.close();
  });
});
