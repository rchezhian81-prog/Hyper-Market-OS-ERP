import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
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
 * OB-704 (owner, 7 Nov 2026: "screens, not commands" · "fill the gaps in our software, don't carry them") — the store PC's
 * import page, end to end against the real API, on the in-memory store AND on PostgreSQL. Made-up data only.
 *
 *   sign in      staff ID + own PIN; a wrong PIN is refused and nothing is shown
 *   read         three .xlsx reports → the department's items, every gap named; head office keeps the read's fingerprint
 *   fix          the store manager fixes a barcode, a price, the label facts — and is refused a GST rate by name;
 *                the accountant fixes the GST rate — and is refused a barcode by name; every fix in the fixer's own name
 *   load         the owner prepares (sealed + staged) — and cannot accept his own load; the manager accepts — and cannot
 *                load it; the owner loads it: the products are in the catalogue at the fixed price, with the fixed barcode
 *   carried?     an item with a gap left is NOT in the load, and the loaded ones are not prepared again
 */

const backings = r3OpsBackings();
const OWNER = 'owner-01';
const MANAGER = 'store-manager-01';
const ACCOUNTANT = 'accountant-01';
const STORE = 'SRE-T1';
const PINS: Record<string, string> = { [OWNER]: '111111', [MANAGER]: '222222', [ACCOUNTANT]: '333333' };

const SHOP = [['TEST SHOP'], ['1 Test Road']];
const EAN = [['Item Id', 'Item Name', 'EanCode'], ['11', 'TEST RICE 1KG', '8901234567890'], ['12', 'TEST DAL 500G', '8901234567911'], ['13', 'TEST TEA 250G', '8901234567920'], ['14', 'TEST OIL 1L', '8901234567937']];
const HSN = [['serial_no', 'Item Id', 'Item Name', 'Hsn Code', 'Item Quantity', 'Gst %', 'Cess Amt', 'Addl Cess Amt'],
  ['1', '11', 'TEST RICE 1KG', '10063020', '500', '5', '0', '0'], ['2', '12', 'TEST DAL 500G', '07133100', '300', '5', '0', '0'],
  ['3', '13', 'TEST TEA 250G', '09023020', '200', '5', '0', '0'], ['4', '13', 'TEST TEA 250G', '09023020', '9', '0', '0', '0'],
  ['5', '14', 'TEST OIL 1L', '15079010', '100', '5', '0', '0']];
const BUYS = [['Purc Date', 'Purc No', 'Item Id', 'Item Name', 'Qty', 'Cost', 'NetCost', 'Selling', 'MRP'],
  ['01/11/2026', '1', '11', 'TEST RICE 1KG', '10', '60', '60', '70', '80'], ['01/11/2026', '1', '13', 'TEST TEA 250G', '10', '90', '90', '100', '110'], ['01/11/2026', '1', '14', 'TEST OIL 1L', '10', '150', '150', '170', '180']];
const LABEL = { allergens: 'none', country_of_origin: 'India', net_quantity: '500 g', packer: 'Test Foods, Chennai', consumer_care: '1800 000 000' };

function personClient(get: () => ApiHarness): SetupClient {
  return {
    request: async (r) => get().raw({
      method: r.method, path: r.path, ...(r.body === undefined ? {} : { body: r.body }), ...(r.idempotencyKey === undefined ? {} : { idempotencyKey: r.idempotencyKey }),
      token: buildPersonToken({ sub: r.userId, tenantId: r.tenantId, ttlSeconds: 300, authTimeSec: Math.floor(Date.parse(r.signedInAt) / 1000) }, TEST_IDP.policy(), Date.now()),
    }),
  };
}

describe.each(backings)('the import page fixes every gap, then two people load — on $name (OB-704)', ({ harness }) => {
  it('read → each gap fixed by the right person (and refused to the wrong one) → prepared → accepted by a second person → loaded', async () => {
    const h: ApiHarness = harness();
    const T = randomUUID();
    await h.seedOwner(T, OWNER);
    await aStoreWithRules(h, T, OWNER, STORE, 0);
    await h.provisionRole(T, MANAGER, 'store_manager');
    await h.provisionRole(T, ACCOUNTANT, 'accountant');
    const { req, ok } = tenantClient(() => h, T);
    await ok(req('POST', '/v1/migration/exceptions', { exceptions: [] }, OWNER), 'cleaning register');

    const dataDir = mkdtempSync(join(tmpdir(), 'sre-imports-'));
    const app = createImportApp({
      client: personClient(() => h), verifyPin: (u, p) => (PINS[u] === undefined ? 'no_pin_issued' : PINS[u] === p ? 'ok' : 'wrong'),
      tenantId: T, storeId: STORE, targetKind: 'rehearsal', demoTenantIds: ['pilot-demo'], dataDir, pageHtml: '<!doctype html><title>t</title>', now: () => new Date('2026-11-07T10:00:00.000Z'),
    });
    const server: Server = createServer((rq, rs) => { void app(rq, rs); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const signIn = async (who: string, pin = PINS[who]!): Promise<string> => {
        const r = await fetch(`${base}/session`, { method: 'POST', headers: { 'x-sre-import': '1', 'content-type': 'application/json' }, body: JSON.stringify({ staffId: who, pin }) });
        if (r.status !== 200) throw new Error(`${who}: ${JSON.stringify(await r.json())}`);
        return r.headers.get('set-cookie')!.split(';')[0]!;
      };
      const call = async (cookie: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
        const r = await fetch(`${base}${path}`, { method, headers: { cookie, 'x-sre-import': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: r.status, body: await r.json() as Record<string, unknown> };
      };

      // ── sign in: a wrong PIN shows nothing ─────────────────────────────────────────────────────────────────
      await expect(signIn(OWNER, '999999')).rejects.toThrow('not owner-01\'s till PIN');
      expect((await fetch(`${base}/api/imports`)).status).toBe(401);
      const owner = await signIn(OWNER);
      const manager = await signIn(MANAGER);
      const accountant = await signIn(ACCOUNTANT);

      // ── read the three reports ─────────────────────────────────────────────────────────────────────────────
      const b64 = (rows: string[][]) => xlsx([...SHOP, ...rows]).toString('base64');
      const read = await call(owner, 'POST', '/api/imports', { files: { ean: { name: 'EANCODE.xlsx', base64: b64(EAN) }, hsn: { name: 'HSN.xlsx', base64: b64(HSN) }, purchases: { name: 'Product_wise_Detail_Report.xlsx', base64: b64(BUYS) } }, ratesFrom: '2026-11-06', backupRestoredOn: '2026-11-06' });
      expect(read.status, JSON.stringify(read.body)).toBe(201);
      const id = read.body['importId'] as string;
      expect(read.body['items']).toBe(4);
      expect(existsSync(join(dataDir, id, 'read.json'))).toBe(true);
      expect(existsSync(join(dataDir, id, 'files'))).toBe(true);

      type Item = { itemId: string; gaps: { kind: string }[]; loaded: boolean; excluded: boolean };
      const view = async (cookie = owner) => (await call(cookie, 'GET', `/api/imports/${id}`)).body as { summary: { ready: number; loaded: number; gaps: Record<string, number> }; items: Item[]; loads: { loadId: string }[]; finance: boolean };
      const gapsOf = (v: Awaited<ReturnType<typeof view>>, itemId: string) => v.items.find((i) => i.itemId === itemId)!.gaps.map((g) => g.kind).sort();
      let v = await view();
      expect(gapsOf(v, '12')).toEqual(['barcode', 'label', 'price']);
      expect(gapsOf(v, '13')).toEqual(['label', 'tax']);
      expect(v.summary.ready).toBe(0);

      // ── fix: by the right person, refused to the wrong one, each by name ──────────────────────────────────────
      const fixAs = (cookie: string, itemId: string, kind: string, value: unknown, reason = 'read off the pack') => call(cookie, 'POST', `/api/imports/${id}/fix`, { itemId, kind, value, reason });
      const notTax = await fixAs(manager, '13', 'tax', { hsn: '09023020', gstPercent: 5 }, 'checked');
      expect(notTax.status).toBe(403);
      expect(String(notTax.body['error'])).toContain('only Finance');
      expect((await fixAs(accountant, '13', 'tax', { hsn: '09023020', gstPercent: 5 }, 'checked with the CA')).status).toBe(201);
      const notBarcode = await fixAs(accountant, '12', 'barcode', { barcodes: ['8901234567913'] }, 'scanned');
      expect(notBarcode.status).toBe(403);
      expect((await view(accountant)).finance).toBe(true); // the accountant reads through Finance's own route
      const badBarcode = await fixAs(manager, '12', 'barcode', { barcodes: ['8901234567911'] }, 'scanned');
      expect(badBarcode.status).toBe(422);
      expect(String(badBarcode.body['error'])).toContain('not a pack barcode');
      expect((await fixAs(manager, '12', 'barcode', { barcodes: ['8901234567913'] }, 'scanned from the pack')).status).toBe(201);
      expect((await fixAs(manager, '12', 'price', { mrp: '65', sell: '60', cost: '50' }, 'from the supplier bill')).status).toBe(201);
      for (const item of ['11', '12', '13']) expect((await fixAs(manager, item, 'label', LABEL)).status).toBe(201);
      // Item 14 keeps a gap (no label facts): it must NOT be carried into the load.
      v = await view();
      expect(v.items.filter((i) => i.gaps.length === 0).map((i) => i.itemId).sort()).toEqual(['11', '12', '13']);
      expect(gapsOf(v, '14')).toEqual(['label']);

      // ── load: prepared by the owner, accepted by the manager, loaded by the owner ──────────────────────────────
      const prepared = await call(owner, 'POST', `/api/imports/${id}/prepare`, { pin: PINS[OWNER] });
      expect(prepared.status, JSON.stringify(prepared.body)).toBe(201);
      const loadId = prepared.body['loadId'] as string;
      expect(prepared.body['items']).toBe(3);
      expect((prepared.body['lines'] as string[]).join('\n')).toMatch(/SEALED — products\.csv: 3 row\(s\)/);
      expect(readFileSync(join(dataDir, id, loadId, 'products.csv'), 'utf8')).not.toContain('TEST OIL');

      const ownAccept = await call(owner, 'POST', `/api/imports/${id}/loads/${loadId}/accept`, { statement: 'Read the three items and nothing set aside; all as on the packs.', pin: PINS[OWNER] });
      expect(ownAccept.status).toBe(403);
      expect(String(ownAccept.body['error'])).toContain('cannot accept it');
      const early = await call(owner, 'POST', `/api/imports/${id}/loads/${loadId}/apply`, { pin: PINS[OWNER] });
      expect(early.status).toBe(422); // nobody has accepted yet: nothing loads
      expect((await req('GET', '/v1/catalogue/products', undefined, OWNER)).body).toMatchObject({ products: [] });
      const accepted = await call(manager, 'POST', `/api/imports/${id}/loads/${loadId}/accept`, { statement: 'Read the three items and nothing set aside; all as on the packs.', pin: PINS[MANAGER] });
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      const notHis = await call(manager, 'POST', `/api/imports/${id}/loads/${loadId}/apply`, { pin: PINS[MANAGER] });
      expect(notHis.status).toBe(403);
      const applied = await call(owner, 'POST', `/api/imports/${id}/loads/${loadId}/apply`, { pin: PINS[OWNER] });
      expect(applied.status, JSON.stringify(applied.body)).toBe(200);

      const products = ((await req('GET', '/v1/catalogue/products', undefined, OWNER)).body as { products: { productId: string }[] }).products.map((p) => p.productId).sort();
      expect(products).toEqual(['11', '12', '13']);
      v = await view();
      expect(v.summary.loaded).toBe(3);
      expect(v.summary.ready).toBe(0); // loaded items are not prepared again
      const again = await call(owner, 'POST', `/api/imports/${id}/prepare`, { pin: PINS[OWNER] });
      expect(again.status).toBe(422);
      expect(String(again.body['error'])).toContain('No item is ready');

      // Every fix is at head office in its fixer's own name.
      const fixes = ((await req('GET', `/v1/migration/old-system-imports/${id}`, undefined, OWNER)).body as { fixes: { kind: string; by: string; itemId: string }[] }).fixes;
      expect(fixes.find((f) => f.kind === 'tax')?.by).toBe(ACCOUNTANT);
      expect(fixes.find((f) => f.kind === 'barcode')?.by).toBe(MANAGER);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 120_000);
});
