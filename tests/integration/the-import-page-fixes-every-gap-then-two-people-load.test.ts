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
 *   OB-733       a label fact is NOT a gap (owner, 14 Nov 2026, replacing OB-696; option A "sell at the till only"): an
 *                item with facts still to read loads with them blank (never "none") and is on head office's list; the
 *                facts saved later on this page for a loaded item reach the item on sale, and it leaves the list
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
const BUY_HEAD = ['Purc Date', 'Purc No', 'Item Id', 'Item Name', 'Qty', 'Cost', 'NetCost', 'Selling', 'MRP'];
// OB-705: the old ERP exports its purchase report three months at a time — a year comes as several files.
const BUYS_EARLY = [BUY_HEAD, ['15/12/2025', '7', '11', 'TEST RICE 1KG', '10', '55', '55', '65', '75'], ['15/12/2025', '7', '14', 'TEST OIL 1L', '10', '150', '150', '170', '180']];
const BUYS_LATE = [BUY_HEAD, ['01/11/2026', '1', '11', 'TEST RICE 1KG', '10', '60', '60', '70', '80'], ['01/11/2026', '1', '13', 'TEST TEA 250G', '10', '90', '90', '100', '110']];
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
      // OB-706: every file in ONE choice, in any order — each recognised by its own columns; the backup day asked once.
      const f = (name: string, rows: string[][]) => ({ name, base64: b64(rows) });
      const ALL = [f('Purchases-5.xlsx', BUYS_LATE), f('HSN.xlsx', HSN), f('Purchases-1.xlsx', BUYS_EARLY), f('EANCODE.xlsx', EAN)];
      const firstTime = await call(owner, 'POST', '/api/imports', { files: ALL });
      expect(firstTime.status).toBe(400);
      expect(String(firstTime.body['error'])).toContain('First time only');
      // The same file chosen twice, and a file that is none of the three reports, are refused by name — nothing read.
      const twice = await call(owner, 'POST', '/api/imports', { files: [...ALL, f('Purchases-1 copy.xlsx', BUYS_EARLY)], backupRestoredOn: '2026-11-06' });
      expect(twice.status).toBe(400);
      expect(String(twice.body['error'])).toContain('are the same file');
      const stranger = await call(owner, 'POST', '/api/imports', { files: [...ALL, f('Distributor Invoice.xlsx', [['Grn No', 'Item Id', 'Purchase Qty'], ['1', '11', '5']])], backupRestoredOn: '2026-11-06' });
      expect(stranger.status).toBe(422);
      expect(String(stranger.body['error'])).toBe('Distributor Invoice.xlsx is not a report this page reads (its columns are: Grn No, Item Id, Purchase Qty). Choose the barcode (EANCODE), HSN and Product wise Detail reports. Nothing was read.');
      const noHsn = await call(owner, 'POST', '/api/imports', { files: ALL.filter((x) => x.name !== 'HSN.xlsx'), backupRestoredOn: '2026-11-06' });
      expect(String(noHsn.body['error'])).toContain('The HSN report (Item Id, Hsn Code, Gst %) is not among the files chosen');
      const read = await call(owner, 'POST', '/api/imports', { files: ALL, backupRestoredOn: '2026-11-06' });
      expect(read.status, JSON.stringify(read.body)).toBe(201);
      expect(read.body).toMatchObject({ files: { barcodes: ['EANCODE.xlsx'], hsn: ['HSN.xlsx'], purchases: ['Purchases-5.xlsx', 'Purchases-1.xlsx'] }, purchaseFiles: 2, purchaseRows: 4, purchasesFrom: '2025-12-15', purchasesTo: '2026-11-01', backupRestoredOn: '2026-11-06' });
      // The rates are in force from the day they were read; never a day typed by hand.
      expect(((await req('GET', `/v1/migration/old-system-imports/${read.body['importId'] as string}`, undefined, OWNER)).body as { import: { ratesFrom: string } }).import.ratesFrom).toBe('2026-11-07');
      const id = read.body['importId'] as string;
      expect(read.body['items']).toBe(4);
      expect(existsSync(join(dataDir, id, 'read.json'))).toBe(true);
      expect(existsSync(join(dataDir, id, 'files'))).toBe(true);

      type Item = { itemId: string; gaps: { kind: string }[]; factsToRead: string[]; loaded: boolean; excluded: boolean };
      const view = async (cookie = owner) => (await call(cookie, 'GET', `/api/imports/${id}`)).body as { summary: { ready: number; loaded: number; gaps: Record<string, number>; factsToRead: number }; items: Item[]; loads: { loadId: string }[]; finance: boolean; factsFrom: string };
      const gapsOf = (v: Awaited<ReturnType<typeof view>>, itemId: string) => v.items.find((i) => i.itemId === itemId)!.gaps.map((g) => g.kind).sort();
      const factsOf = (v: Awaited<ReturnType<typeof view>>, itemId: string) => v.items.find((i) => i.itemId === itemId)!.factsToRead;
      let v = await view();
      expect(gapsOf(v, '12')).toEqual(['barcode', 'price']);
      expect(gapsOf(v, '13')).toEqual(['tax']);
      // OB-733: no label fact is a gap — the clean items are ready with all five facts still to read.
      expect(v.summary.ready).toBe(2);
      expect(v.summary).toMatchObject({ factsToRead: 4, gaps: { barcode: 1, tax: 1, price: 1 } });

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
      for (const item of ['11', '12']) expect((await fixAs(manager, item, 'label', LABEL)).status).toBe(201);
      // OB-733: some facts read now, the rest later; item 14 has none read at all — neither is held back.
      expect((await fixAs(manager, '13', 'label', { country_of_origin: 'India', net_quantity: '250 g' })).status).toBe(201);
      v = await view();
      expect(v.items.filter((i) => i.gaps.length === 0).map((i) => i.itemId).sort()).toEqual(['11', '12', '13', '14']);
      expect(factsOf(v, '13')).toEqual(['allergens', 'packer', 'consumer_care']);
      expect(factsOf(v, '14')).toHaveLength(5);
      expect(v.summary.factsToRead).toBe(2);
      const factsCsv = await fetch(`${base}/api/imports/${id}/export/facts-to-read.csv`, { headers: { cookie: owner } });
      expect((await factsCsv.text()).split('\r\n').slice(1, 3).map((l) => l.split(',').slice(0, 4).join(','))).toEqual(['13,TEST TEA 250G,209,not loaded yet', '14,TEST OIL 1L,100,not loaded yet']);

      // ── load: prepared by the owner, accepted by the manager, loaded by the owner ──────────────────────────────
      const prepared = await call(owner, 'POST', `/api/imports/${id}/prepare`, { pin: PINS[OWNER] });
      expect(prepared.status, JSON.stringify(prepared.body)).toBe(201);
      const loadId = prepared.body['loadId'] as string;
      expect(prepared.body['items']).toBe(4);
      expect((prepared.body['lines'] as string[]).join('\n')).toMatch(/SEALED — products\.csv: 4 row\(s\)/);
      expect((prepared.body['lines'] as string[]).join('\n')).toContain('Label facts still to read (OB-733): 2 staged item(s)');
      // Blank is written blank — never "none", never a guess.
      expect(readFileSync(join(dataDir, id, loadId, 'products.csv'), 'utf8')).toContain('14,TEST OIL 1L,pcs,packaged-groceries,15079010,active,,,,,');

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
      expect(products).toEqual(['11', '12', '13', '14']);
      // OB-733: on sale at the till, and on head office's list of facts still to read, until filled.
      const outstanding = async () => ((await req('GET', '/v1/catalogue/label-facts-outstanding', undefined, OWNER)).body as { items: { productId: string; facts: string[]; loadId: string; loadedBy: string }[] }).items;
      expect((await outstanding()).map((x) => [x.productId, x.facts, x.loadId, x.loadedBy])).toEqual([
        ['13', ['allergens', 'packer', 'consumer_care'], loadId, OWNER], ['14', ['allergens', 'country_of_origin', 'net_quantity', 'packer', 'consumer_care'], loadId, OWNER]]);
      const oil = ((await req('GET', '/v1/catalogue/products/14', undefined, OWNER)).body as { product: { lifecycle: string; safety?: { allergens?: string[] } } }).product;
      expect(oil.lifecycle).toBe('active');
      expect(oil.safety?.allergens).toBeUndefined(); // not read yet — never "none"
      v = await view();
      expect(v.summary.loaded).toBe(4);
      expect(v.factsFrom).toBe('head office');
      expect(factsOf(v, '13')).toEqual(['allergens', 'packer', 'consumer_care']);
      expect(v.summary.ready).toBe(0); // loaded items are not prepared again
      const again = await call(owner, 'POST', `/api/imports/${id}/prepare`, { pin: PINS[OWNER] });
      expect(again.status).toBe(422);
      expect(String(again.body['error'])).toContain('No item is ready');

      // ── facts later (OB-733): saved on this page for a LOADED item, they reach the item on sale ─────────────────
      const later = await fixAs(manager, '14', 'label', { allergens: 'none', country_of_origin: 'India', net_quantity: '1 L', packer: 'Test Oils, Erode', consumer_care: 'care@testoils.example' });
      expect(later.status, JSON.stringify(later.body)).toBe(201);
      expect(later.body['onSale']).toEqual({ updated: true, factsStillToRead: [] });
      const partly = await fixAs(manager, '13', 'label', { allergens: 'milk' });
      expect(partly.body['onSale']).toEqual({ updated: true, factsStillToRead: ['packer', 'consumer_care'] });
      expect((await outstanding()).map((x) => [x.productId, x.facts])).toEqual([['13', ['packer', 'consumer_care']]]);
      const oilNow = ((await req('GET', '/v1/catalogue/products/14', undefined, OWNER)).body as { product: { safety: Record<string, unknown>; labelFactsFollow?: unknown } }).product;
      expect(oilNow.safety).toMatchObject({ allergens: [], countryOfOrigin: 'India', netQuantity: '1 L', packerDetails: 'Test Oils, Erode', consumerCareContact: 'care@testoils.example' });
      expect(oilNow.labelFactsFollow).toBeUndefined(); // complete: it stands on the full rule from now on
      const tea = ((await req('GET', '/v1/catalogue/products/13', undefined, OWNER)).body as { product: { safety: Record<string, unknown> } }).product;
      expect(tea.safety).toMatchObject({ allergens: ['milk'], countryOfOrigin: 'India', netQuantity: '250 g' });
      v = await view();
      expect(factsOf(v, '14')).toEqual([]);
      expect(v.summary.factsToRead).toBe(1);

      // Every fix is at head office in its fixer's own name.
      const fixes = ((await req('GET', `/v1/migration/old-system-imports/${id}`, undefined, OWNER)).body as { fixes: { kind: string; by: string; itemId: string }[] }).fixes;
      expect(fixes.find((f) => f.kind === 'tax')?.by).toBe(ACCOUNTANT);
      expect(fixes.find((f) => f.kind === 'barcode')?.by).toBe(MANAGER);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 120_000);
});
