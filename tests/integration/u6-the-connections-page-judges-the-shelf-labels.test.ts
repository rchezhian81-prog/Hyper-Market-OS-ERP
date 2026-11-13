import { describe, it, expect } from 'vitest';
import { randomUUID, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { storeRules } from '../support/store-rules';
import { deviceBatchMessage } from '../../packages/integration/src/floor-devices';
import { nameSecurityReviewer, switchFloorDeviceOn } from '../support/floor-device-switch';

/**
 * **U6 (UI/UX gap audit §27 "Product — label/ESL: no integration row" · D14-FR-05 · M32-FR-04 · P-08): through the real API,
 * `GET /v1/integration/health` carries a `shelf-labels` row once a label is registered — judged like every other connection
 * by when it last worked, drawn from the labels' pushes and echoes, never a second record.** Before a label exists there is
 * no row; a label nobody has pushed to has "never worked"; a price change the stand-in vendor took reads healthy; the label's
 * own echo keeps it so. On the in-memory store AND (with DATABASE_URL) real PostgreSQL, head office restarted cold between
 * the writes and the read.
 */
const backings = useRestartableBackings();
type Res = { status: number; body: unknown };
interface Health { adapters: { adapterId: string; category: string; state: string; detail: string }[]; posUnaffected: boolean }

interface Device { readonly id: string; readonly publicKey: string; readonly privateKey: KeyObject }
const device = (id: string): Device => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { id, publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey };
};
const signed = (d: Device, events: unknown[]): { events: unknown[]; signature: string } =>
  ({ events, signature: sign(null, Buffer.from(deviceBatchMessage(d.id, events)), d.privateKey).toString('base64') });

describe.each(backings)('U6: the Connections page judges the shelf labels — on $name', ({ harness }) => {
  it('no row before a label exists; never worked before a push; healthy once the vendor took a price and the label echoed it', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-it', 'platform_admin');
    await h.provisionRole(T, 'u-gw', 'floor_device_gateway', ['B1']);
    await h.provisionRole(T, 'u-rev', 'security_reviewer');
    const scoped = new Set(['u-gw']);
    const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(scoped.has(userId) ? { branchId: 'B1' } : {}), ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Record<string, unknown>> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r.body as Record<string, unknown>; };
    const health = async (): Promise<Health> => (await ok(call('GET', '/v1/integration/health', 'u-owner'), 'health')) as unknown as Health;
    const row = async () => (await health()).adapters.find((a) => a.adapterId === 'shelf-labels');

    await ok(call('POST', '/v1/org/nodes/C1', 'u-it', { kind: 'company', name: 'SRE Retail' }), 'company');
    await ok(call('POST', '/v1/org/nodes/B1', 'u-it', { kind: 'branch', name: 'Main store', parentId: 'C1', companyId: 'C1' }), 'branch');
    await storeRules(h, T, 'u-owner', 'B1', 0);
    await ok(call('POST', '/v1/catalogue/tax-classes/34011190/rates/2017-07-01', 'u-owner', { rateBps: 1_800 }), 'tax');
    await ok(call('POST', '/v1/catalogue/products/p-soap/publish', 'u-owner', { product: { sku: 'SKU-SOAP', name: 'Soap 100g', baseUom: 'ea', primaryCategoryId: 'home', taxClass: '34011190', lifecycle: 'draft' }, categories: [{ categoryId: 'home', name: 'Home', parentId: null }] }), 'product');

    // No label registered: no row — a connection that does not exist is not "healthy" (P-08).
    expect(await row()).toBeUndefined();

    const esl = device('esl-1');
    await ok(call('POST', `/v1/devices/floor/${esl.id}`, 'u-it', { branchId: 'B1', kind: 'esl_label', label: 'Soap label', vendor: 'stand-in', publicKey: esl.publicKey, productId: 'p-soap', shelfAddress: 'A1-01' }), 'register');
    const never = await row();
    expect(never).toMatchObject({ adapterId: 'shelf-labels', category: 'hardware', state: 'silent' });
    expect(never!.detail).toMatch(/NEVER reported a success/);

    await nameSecurityReviewer(h, T, 'u-owner', 'u-rev');
    expect((await switchFloorDeviceOn(h, T, { switcher: 'u-it', owner: 'u-owner', reviewer: 'u-rev' }, 'esl', { branchId: 'B1', reason: 'esl trial in B1' })).status).toBeLessThan(300);
    // A price change pushes the price to the label (the stand-in vendor takes it): the connection worked just now.
    await ok(call('POST', '/v1/prices/changes', 'u-owner', { productId: 'p-soap', priceMinor: 4_500, mrpMinor: 6_000, costMinor: 2_000, currency: 'INR', marginFloorBps: 0 }), 'price change');
    expect((await row())?.state).toBe('healthy');

    h = harness(h); // ── head office COLD ──
    const echo = { eventId: 'e1', type: 'esl.echo', at: new Date(Date.now() + 1_000).toISOString(), productId: 'p-soap', displayedPriceMinor: 4_500, batteryPercent: 80 };
    expect((await ok(call('POST', `/v1/devices/floor/${esl.id}/events`, 'u-gw', signed(esl, [echo])), 'echo'))['accepted']).toBe(1);
    const shown = await row();
    expect(shown?.state).toBe('healthy');
    expect((await health()).posUnaffected).toBe(true);
    // Nothing was registered as an adapter for it: the row is drawn, not stored (hard rule #2).
    expect((await call('GET', '/v1/integration/adapters/shelf-labels', 'u-owner')).status).not.toBe(200);
  });
});
