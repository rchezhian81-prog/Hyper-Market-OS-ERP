import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { ApiHarness } from '../support/api-harness';
import { TEST_IDP } from '../support/api-harness';
import { r3OpsBackings, tenantClient } from '../support/r3-ops-backings';
import { aStoreWithRules } from '../support/store-rules';
import { buildPersonToken } from '../../scripts/lib/operator-env';
import { createImportApp } from '../../scripts/lib/import-app';
import type { SetupClient } from '../../packages/migration/src/owner-steps-command';
import { xlsx } from '../support/xlsx';

/**
 * OB-800 (owner, 15 Nov 2026): NO pilot department — the whole store is loaded from the old ERP (Bpal) and run in parallel
 * with it. The store PC's Import page, end to end against the real API (in-memory store AND PostgreSQL), with items of
 * several departments: a packaged grocery (loads with its label facts still to read — OB-738), a banana sold LOOSE by
 * weight with the scale's PLU (marked by a person, loaded in kg), a shampoo (personal care: its label facts are needed
 * first — today's rule), cigarettes (never loaded from the old ERP: set up on the Products page), and one HSN the old ERP
 * taxes at two rates (Finance decides, OB-697). Made-up data only.
 */

const backings = r3OpsBackings();
const OWNER = 'owner-01';
const MANAGER = 'store-manager-01';
const ACCOUNTANT = 'accountant-01';
const STORE = 'SRE-T1';
const PINS: Record<string, string> = { [OWNER]: '111111', [MANAGER]: '222222', [ACCOUNTANT]: '333333' };
const SHOP = [['TEST SHOP'], ['1 Test Road']];
const EAN = [['Item Id', 'Item Name', 'EanCode'], ['31', 'TEST RICE 5KG', '8901234567890'], ['32', 'TEST BANANA', '123'], ['33', 'TEST SHAMPOO 180ML', '8901234567906'],
  ['34', 'TEST CIGARETTES 10', '8901234567913'], ['35', 'TEST TEA 250G', '8901234567920'], ['36', 'TEST TEA DUST 250G', '8901234567937']];
const HSN = [['Item Id', 'Item Name', 'Hsn Code', 'Item Quantity', 'Gst %', 'Cess Amt', 'Addl Cess Amt'],
  ['31', 'TEST RICE 5KG', '10063020', '50', '5', '0', '0'], ['32', 'TEST BANANA', '08039010', '412.5', '0', '0', '0'], ['33', 'TEST SHAMPOO 180ML', '33051090', '80', '18', '0', '0'],
  ['34', 'TEST CIGARETTES 10', '24022090', '40', '28', '0', '0'], ['35', 'TEST TEA 250G', '09023020', '30', '5', '0', '0'], ['36', 'TEST TEA DUST 250G', '09023020', '20', '0', '0', '0']];
const BUYS = [['Purc Date', 'Purc No', 'Item Id', 'Item Name', 'Qty', 'Cost', 'NetCost', 'Selling', 'MRP'],
  ['01/11/2026', '1', '31', 'TEST RICE 5KG', '10', '300', '300', '340', '360'], ['01/11/2026', '1', '32', 'TEST BANANA', '50', '30', '30', '40', '40'],
  ['01/11/2026', '1', '33', 'TEST SHAMPOO 180ML', '10', '90', '90', '110', '120'], ['01/11/2026', '1', '34', 'TEST CIGARETTES 10', '10', '80', '80', '95', '100'],
  ['01/11/2026', '1', '35', 'TEST TEA 250G', '10', '90', '90', '100', '110'], ['01/11/2026', '1', '36', 'TEST TEA DUST 250G', '10', '60', '60', '70', '75']];

function personClient(get: () => ApiHarness): SetupClient {
  return {
    request: async (r) => get().raw({
      method: r.method, path: r.path, ...(r.body === undefined ? {} : { body: r.body }), ...(r.idempotencyKey === undefined ? {} : { idempotencyKey: r.idempotencyKey }),
      token: buildPersonToken({ sub: r.userId, tenantId: r.tenantId, ttlSeconds: 300, authTimeSec: Math.floor(Date.parse(r.signedInAt) / 1000) }, TEST_IDP.policy(), Date.now()),
    }),
  };
}

describe.each(backings)('OB-800: the import page loads every department, loose goods included — on $name', ({ harness }) => {
  it('read every department → loose banana marked in kg with its PLU → shampoo\'s facts first → Finance settles the two-rate HSN → two people load → each item in its department', async () => {
    const h: ApiHarness = harness();
    const T = randomUUID();
    await h.seedOwner(T, OWNER);
    await aStoreWithRules(h, T, OWNER, STORE, 0);
    await h.provisionRole(T, MANAGER, 'store_manager');
    await h.provisionRole(T, ACCOUNTANT, 'accountant');
    const { req, ok } = tenantClient(() => h, T);
    await ok(req('POST', '/v1/migration/exceptions', { exceptions: [] }, OWNER), 'cleaning register');

    const dataDir = mkdtempSync(join(tmpdir(), 'sre-imports-800-'));
    const app = createImportApp({
      client: personClient(() => h), verifyPin: (u, p) => (PINS[u] === undefined ? 'no_pin_issued' : PINS[u] === p ? 'ok' : 'wrong'),
      tenantId: T, storeId: STORE, targetKind: 'rehearsal', demoTenantIds: ['pilot-demo'], dataDir, pageHtml: '<!doctype html><title>t</title>', now: () => new Date('2026-11-15T10:00:00.000Z'),
    });
    const server: Server = createServer((rq, rs) => { void app(rq, rs); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const signIn = async (who: string): Promise<string> => {
        const r = await fetch(`${base}/session`, { method: 'POST', headers: { 'x-sre-import': '1', 'content-type': 'application/json' }, body: JSON.stringify({ staffId: who, pin: PINS[who] }) });
        if (r.status !== 200) throw new Error(`${who}: ${JSON.stringify(await r.json())}`);
        return r.headers.get('set-cookie')!.split(';')[0]!;
      };
      const call = async (cookie: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
        const r = await fetch(`${base}${path}`, { method, headers: { cookie, 'x-sre-import': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: r.status, body: await r.json() as Record<string, unknown> };
      };
      const owner = await signIn(OWNER);
      const manager = await signIn(MANAGER);
      const accountant = await signIn(ACCOUNTANT);

      const f = (name: string, rows: string[][]) => ({ name, base64: xlsx([...SHOP, ...rows]).toString('base64') });
      const read = await call(owner, 'POST', '/api/imports', { files: [f('HSN.xlsx', HSN), f('EANCODE.xlsx', EAN), f('Purchases.xlsx', BUYS)], backupRestoredOn: '2026-11-14' });
      expect(read.status, JSON.stringify(read.body)).toBe(201);
      expect(read.body['items']).toBe(6); // every department — nothing left out for its department
      const id = read.body['importId'] as string;

      type Item = { itemId: string; gaps: { kind: string; why: string }[]; factsToRead: string[]; department?: string; soldAs: string; barcodes: string[] };
      const view = async (cookie = owner) => (await call(cookie, 'GET', `/api/imports/${id}`)).body as { summary: { ready: number; loaded: number; loose: number; gaps: Record<string, number>; byDepartment: Record<string, { ready: number; loaded: number; waiting: number }> }; items: Item[]; departmentNames: Record<string, string> };
      const item = (v: Awaited<ReturnType<typeof view>>, itemId: string) => v.items.find((i) => i.itemId === itemId)!;
      const gapsOf = (v: Awaited<ReturnType<typeof view>>, itemId: string) => item(v, itemId).gaps.map((g) => g.kind).sort();
      let v = await view();
      expect(gapsOf(v, '31')).toEqual([]);
      expect(gapsOf(v, '32')).toEqual(['barcode']);
      expect(item(v, '32').gaps[0]!.why).toContain('mark it "Sold loose"');
      expect(gapsOf(v, '33')).toEqual(['label']);
      expect(gapsOf(v, '34')).toEqual(['setup']);
      expect(gapsOf(v, '35')).toEqual(['tax']);
      expect(gapsOf(v, '36')).toEqual(['tax']);
      expect(v.departmentNames['personal-care']).toBe('Personal care');
      expect(v.summary.gaps).toEqual({ barcode: 1, tax: 2, price: 0, label: 1, setup: 1 });

      // ── the banana is sold loose, by weight, with the scale's PLU — marked by whoever runs the load, not by Finance ──────
      const fixAs = (cookie: string, itemId: string, kind: string, value: unknown, reason = 'checked in the shop') => call(cookie, 'POST', `/api/imports/${id}/fix`, { itemId, kind, value, reason });
      const notFinance = await fixAs(accountant, '32', 'loose', { soldBy: 'kg', plu: '00123' });
      expect(notFinance.status).toBe(403);
      expect(String(notFinance.body['error'])).toContain('"sold loose"');
      const badPlu = await fixAs(manager, '32', 'loose', { soldBy: 'kg', plu: '12' });
      expect(badPlu.status).toBe(422);
      expect((await fixAs(manager, '32', 'loose', { soldBy: 'kg', plu: '00123' }, 'weighed at the counter')).status).toBe(201);
      v = await view();
      expect([item(v, '32').soldAs, item(v, '32').department, gapsOf(v, '32')]).toEqual(['loose_kg', 'loose-foods', ['label']]); // a loose food needs allergens and origin
      expect((await fixAs(manager, '32', 'label', { allergens: 'none', country_of_origin: 'India' }, 'loose fruit, grown in India')).status).toBe(201);
      expect((await fixAs(manager, '33', 'label', { country_of_origin: 'India', net_quantity: '180 ml', packer: 'Test Care, Chennai', consumer_care: '1800 111 111' })).status).toBe(201);
      // ── Finance settles the two-rate HSN (OB-697 still asks for Bpal to be corrected too) ─────────────────────────
      expect((await fixAs(accountant, '36', 'tax', { hsn: '09023020', gstPercent: 5 }, 'checked with the CA')).status).toBe(201);
      v = await view();
      expect(v.items.filter((i) => i.gaps.length === 0).map((i) => i.itemId).sort()).toEqual(['31', '32', '33', '35', '36']);
      expect(v.summary.loose).toBe(1);
      expect(v.summary.byDepartment).toMatchObject({ 'packaged-groceries': { ready: 3 }, 'loose-foods': { ready: 1 }, 'personal-care': { ready: 1 }, 'household-general': { waiting: 1 } });

      // ── load: prepared by the owner, accepted by the manager, loaded by the owner ──────────────────────────────────
      const prepared = await call(owner, 'POST', `/api/imports/${id}/prepare`, { pin: PINS[OWNER] });
      expect(prepared.status, JSON.stringify(prepared.body)).toBe(201);
      expect(prepared.body).toMatchObject({ items: 5, soldByWeight: 1, departments: [{ name: 'Packaged groceries', items: 3 }, { name: 'Personal care', items: 1 }, { name: 'Loose foods (by weight or by count)', items: 1 }] });
      const loadId = prepared.body['loadId'] as string;
      const manifest = JSON.parse(readFileSync(join(dataDir, id, loadId, 'slice.json'), 'utf8')) as { department?: unknown; departments: { categoryId: string }[] };
      expect(manifest.department).toBeUndefined(); // no pilot department
      expect(manifest.departments.map((d) => d.categoryId)).toEqual(['packaged-groceries', 'personal-care', 'loose-foods']);
      expect(readFileSync(join(dataDir, id, loadId, 'products.csv'), 'utf8')).toContain('32,TEST BANANA,kg,loose-foods,08039010,active,none,India,,,');
      expect((await call(manager, 'POST', `/api/imports/${id}/loads/${loadId}/accept`, { statement: 'Read the five items of three departments; the banana is weighed, the cigarettes wait.', pin: PINS[MANAGER] })).status).toBe(200);
      const applied = await call(owner, 'POST', `/api/imports/${id}/loads/${loadId}/apply`, { pin: PINS[OWNER] });
      expect(applied.status, JSON.stringify(applied.body)).toBe(200);

      // ── each item in the catalogue in its own department; the cigarettes are not ───────────────────────────────────
      const products = ((await req('GET', '/v1/catalogue/products', undefined, OWNER)).body as { products: { productId: string }[] }).products.map((p) => p.productId).sort();
      expect(products).toEqual(['31', '32', '33', '35', '36']);
      const productOf = async (pid: string) => ((await req('GET', `/v1/catalogue/products/${pid}`, undefined, OWNER)).body as { product: { primaryCategoryId: string; baseUom: string; labelFactsFollow?: unknown; safety?: Record<string, unknown> } }).product;
      const banana = await productOf('32');
      expect([banana.primaryCategoryId, banana.baseUom]).toEqual(['loose-foods', 'kg']);
      expect(banana.labelFactsFollow).toBeUndefined();
      const shampoo = await productOf('33');
      expect(shampoo.primaryCategoryId).toBe('personal-care');
      expect(shampoo.labelFactsFollow).toBeUndefined();
      expect(shampoo.safety).toMatchObject({ netQuantity: '180 ml', consumerCareContact: '1800 111 111' });
      // OB-738's list holds the packaged groceries only.
      const outstanding = ((await req('GET', '/v1/catalogue/label-facts-outstanding', undefined, OWNER)).body as { items: { productId: string }[] }).items.map((x) => x.productId).sort();
      expect(outstanding).toEqual(['31', '35', '36']);
      // The load record names no pilot department (OB-800).
      const record = ((await req('GET', `/v1/migration/loads/${loadId}`, undefined, OWNER)).body as { record: { department?: unknown } }).record;
      expect(record.department).toBeUndefined();
      v = await view();
      expect(v.summary.loaded).toBe(5);
      expect(gapsOf(v, '34')).toEqual(['setup']); // never loaded from here; still on the list, with its reason
      const itemsCsv = await (await fetch(`${base}/api/imports/${id}/export/items.csv`, { headers: { cookie: owner } })).text();
      expect(itemsCsv).toContain('32,TEST BANANA,412.5,loaded,Loose foods (by weight or by count),kg (loose),00123,08039010');
      expect(itemsCsv).toContain('34,TEST CIGARETTES 10,40,1 gap(s),Household and general goods,piece (pack)');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 120_000);
});
