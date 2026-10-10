import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { STREAM } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { openDeviceOutbox, guardedStore } from '../../packages/sync/src/device-outbox';
import {
  fetchIndents, indentsPortsFromData, openIndentResolvePort, fetchGoodsReceipt, goodsReceiptPortsFromData, openGrnLineReturnPort,
} from '../../apps/web-erp/src/browser-entry';
import { createIndentsSession } from '../../apps/web-erp/src/indents-session';
import { createGoodsReceiptSession } from '../../apps/web-erp/src/goods-receipt-session';

/**
 * **Batch 2 · the two new screen writes, driven through the browser's OWN read and write functions against the REAL routes
 * (real RBAC, real records; in memory and, with DATABASE_URL, on real PostgreSQL).**
 *
 * The browser e2e proves the pages against a stub cloud; this proves the stub's shapes are the real ones: `fetchIndents` /
 * `fetchGoodsReceipt` read what head office actually returns, the sessions offer exactly the right thing to the right
 * person, and `openIndentResolvePort` / `openGrnLineReturnPort` POST what the real routes accept —
 *   • a floor-indent issue counted in 3 short stays on the OPEN register though the indent is "received" (it needs a person —
 *     the gap this test found: `?open=true` hid it, so the screen could never offer it); it is offered for resolution to a
 *     third person (never the issuer or the counter); the resolution lands and the indent leaves the open register, its
 *     record saying who resolved it and the value confirmed lost;
 *   • a chilled delivery with no temperature is held, a second person disposes of it as a return, and the receipt screen
 *     records it as gone back to the supplier; the re-read list says so, by whom.
 * `fetch` is replaced by a call into the harness AS the person at the screen — nothing else is stubbed. Synthetic data only.
 */

const AT = '2026-10-10T09:00:00.000Z';
type Body = Record<string, unknown>;

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });
const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

const savedFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = savedFetch; });
/** The browser's `fetch`, answered by the real API as `userId` — the person signed in at the screen. */
function signedInAs(h: ApiHarness, t: string, userId: string): void {
  globalThis.fetch = (async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(String(url), 'http://screen.local');
    const hdr = (init.headers ?? {}) as Record<string, string>;
    const res = await h.request({
      method: (init.method ?? 'GET') as 'GET' | 'POST', path: u.pathname, userId, tenantId: t,
      ...(hdr['idempotency-key'] === undefined ? {} : { idempotencyKey: hdr['idempotency-key'] }),
      ...(init.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown }),
      ...(u.search === '' ? {} : { query: Object.fromEntries(u.searchParams.entries()) }),
    });
    return new Response(JSON.stringify(res.body), { status: res.status });
  }) as unknown as typeof globalThis.fetch;
}
const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } }; };

describe.each(backings)('Batch 2 · the screens drive the real routes — on $name', ({ harness }) => {
  it('floor indents: an issue counted in short is resolved from the screen by a third person; the register says by whom and what was lost', async () => {
    const h = harness();
    const t = randomUUID();
    const post = (u: string, path: string, body: Body, key: string) => h.request({ method: 'POST', path, userId: u, tenantId: t, idempotencyKey: key, body });
    await h.seedOwner(t, 'u-owner');
    for (const u of ['u-floor', 'u-mgr', 'u-back', 'u-floor2']) await h.provisionRole(t, u, 'store_manager');
    for (const [id, body] of [['C1', { kind: 'company', name: 'SRE Retail' }], ['S1', { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' }], ['S1-BACK', { kind: 'warehouse', name: 'Back store', parentId: 'S1', companyId: 'C1' }]] as const) {
      expect((await post('u-owner', `/v1/org/nodes/${id}`, body, `org-${id}`)).status).toBe(201);
    }
    expect((await post('u-owner', '/v1/inventory/movements', { movementId: 'seed-rice', productId: 'RICE', locationId: 'S1-BACK', kind: 'received', quantityMinor: 50, uom: 'EA', occurredAt: AT, enteredBy: 'u-owner', unitCostMinor: 5_000 }, 'seed-rice')).status).toBeLessThan(300);
    expect((await post('u-floor', '/v1/floor/indents/ind-s', { fromLocationId: 'S1-BACK', toLocationId: 'S1', lines: [{ productId: 'RICE', quantityMinor: 10, uom: 'EA' }] }, 'ind-s')).status).toBe(201);
    expect((await post('u-mgr', '/v1/floor/indents/ind-s/approval', {}, 'ind-s-ap')).status).toBe(200);
    expect((await post('u-back', '/v1/floor/indents/ind-s/issues/is-1', { lines: [{ productId: 'RICE', quantityMinor: 10 }] }, 'ind-s-is')).status).toBe(201);
    expect((await post('u-floor2', '/v1/floor/indents/ind-s/issues/is-1/receipt', { counted: [{ productId: 'RICE', quantityMinor: 7 }] }, 'ind-s-rc')).status).toBe(201);

    const screenFor = async (userId: string) => {
      signedInAs(h, t, userId);
      const data = await fetchIndents();
      expect(data).not.toBeNull();
      const boxData = { userId, permissions: ['inventory.indent.read', 'inventory.adjustment.approve'], storeId: 'S1', backStoreId: 'S1-BACK', products: [] };
      return createIndentsSession({ userId, storeId: 'S1', backStoreId: 'S1-BACK', products: [], now: () => AT },
        indentsPortsFromData(boxData, data!, undefined, openIndentResolvePort()), openDeviceOutbox(guardedStore('sre.indents.outbox.S1', memory(), () => {}), () => {}));
    };

    // The issuer and the counter are not offered it — and refused before anything is sent.
    for (const [who, outcome] of [['u-back', 'issuer_cannot_resolve'], ['u-floor2', 'counter_cannot_resolve']] as const) {
      const s = await screenFor(who);
      expect(s.view('en').resolvable).toEqual([]);
      expect(await s.resolve({ indentId: 'ind-s', issueId: 'is-1', reasonCode: 'miscount', note: 'looked everywhere', found: [] })).toEqual({ outcome });
    }
    // A third person sees the real shortfall (3 RICE at ₹50 = ₹150) and resolves it: 1 found, 2 lost.
    const mgr = await screenFor('u-mgr');
    const offered = mgr.view('en').resolvable;
    expect(offered.map((r) => `${r.indentId}|${r.issue.issueId}`)).toEqual(['ind-s|is-1']);
    expect(offered[0]!.issue).toMatchObject({ issuedBy: 'u-back', receivedBy: 'u-floor2', shortfall: [{ productId: 'RICE', batchId: null, quantityMinor: 3, valueMinor: 15_000 }], resolvedBy: null });
    expect(await mgr.resolve({ indentId: 'ind-s', issueId: 'is-1', reasonCode: 'miscount', note: 'one bag was behind the trolley bay', found: [{ productId: 'RICE', batchId: null, foundMinor: '1' }] })).toEqual({ outcome: 'resolved' });
    // The same click again is the same resolution (the server's word, not a second truth).
    expect(await mgr.resolve({ indentId: 'ind-s', issueId: 'is-1', reasonCode: 'miscount', note: 'one bag was behind the trolley bay', found: [{ productId: 'RICE', batchId: null, foundMinor: '1' }] })).toEqual({ outcome: 'already_resolved' });

    // Before it was resolved the received-but-short indent stayed on the OPEN register (it needed a person — P-03 · P-08);
    // resolved, it needs nobody and leaves it; nothing is left to offer. Its record says by whom, and 2 lost at ₹50 = ₹100.
    const after = await screenFor('u-mgr');
    expect(after.view('en').indents.map((i) => i.indentId)).not.toContain('ind-s');
    expect(after.view('en').resolvable).toEqual([]);
    const record = (await h.request({ method: 'GET', path: '/v1/floor/indents/ind-s', userId: 'u-owner', tenantId: t })).body as { state: string; attention: string[]; issues: { shortfallResolution?: { resolvedBy: string; lines: { lostMinor: number; lostValueMinor: number }[] } }[] };
    expect(record).toMatchObject({ state: 'received', attention: [] });
    expect(record.issues[0]!.shortfallResolution).toMatchObject({ resolvedBy: 'u-mgr', lines: [expect.objectContaining({ lostMinor: 2, lostValueMinor: 10_000 })] });
  }, 60_000);

  it('goods receipt: a held line disposed of as a return is recorded as gone back from the screen; the re-read list says so, by whom', async () => {
    const h = harness();
    const t = randomUUID();
    const post = (u: string, path: string, body: Body, key: string) => h.request({ method: 'POST', path, userId: u, tenantId: t, idempotencyKey: key, body });
    await h.seedOwner(t, 'u-owner');
    for (const u of ['u-recv', 'u-boss', 'u-mgr']) await h.provisionRole(t, u, 'store_manager');
    await h.store.append(t, STREAM.catalogue, makeEvent({
      id: `pack-${t}-1`, type: 'CataloguePublished', occurredAt: AT, idempotencyKey: `catalogue-${t}-v1`, source: 'test/catalogue',
      payload: { snapshot: { tenantId: t, version: 1, builtAt: AT, scope: { tenantId: t, storeId: 'store-1' }, barcodes: [], products: [
        { productId: 'p-paneer', sku: 'p-paneer', name: 'Fresh paneer 200g', unitPriceMinor: 9_000, taxBps: 500, status: 'active', uom: 'ea', batchTracked: true },
      ] } },
    }));
    expect((await post('u-owner', '/v1/catalogue/products/p-paneer/publish', {
      product: { sku: 'p-paneer', name: 'Fresh paneer 200g', baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '04061000', lifecycle: 'draft', handling: 'chilled', coldChain: { minTenthsC: -20, maxTenthsC: 40 } },
      categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
    }, 'pub-paneer')).status).toBe(201);
    expect((await post('u-owner', '/v1/inventory/receipt-policy', { excessToleranceBp: 0, shortageToleranceBp: 0, nearExpiryDays: 7 }, 'pol')).status).toBe(201);
    // No temperature on a chilled line: received but HELD; a second person disposes of it as a return.
    expect((await post('u-recv', '/v1/inventory/goods-receipt/g-ret', { warehouseId: 'wh-1', receivedOnDate: '2026-10-10', currency: 'INR', lines: [
      { lineId: 'L1', productId: 'p-paneer', orderedMinor: 10, countedMinor: 10, uom: 'ea', unitCost: { minor: 4_000, currency: 'INR' }, condition: 'good', batchId: 'B-1', expiry: '2026-10-20' },
    ] }, 'g-ret')).status).toBe(201);

    const screenFor = async (userId: string) => {
      signedInAs(h, t, userId);
      const data = await fetchGoodsReceipt();
      expect(data).not.toBeNull();
      return createGoodsReceiptSession({ userId }, goodsReceiptPortsFromData({ userId, permissions: ['inventory.availability.read', 'inventory.movement.append'] }, data!, openGrnLineReturnPort()));
    };
    // Before the disposition nothing is waiting to go back.
    expect((await screenFor('u-mgr')).view('en').awaitingReturn).toEqual([]);
    expect((await post('u-boss', '/v1/inventory/goods-receipt/g-ret/lines/L1/disposition', { disposition: 'return', reason: 'no reading and the van was warm' }, 'd-ret')).status).toBe(200);

    const mgr = await screenFor('u-mgr');
    const waiting = mgr.view('en').awaitingReturn;
    expect(waiting.map((a) => `${a.grnId}|${a.line.lineId}`)).toEqual(['g-ret|L1']);
    expect(waiting[0]!.line).toMatchObject({ productId: 'p-paneer', quantityMinor: 10, uom: 'ea', valueMinor: 40_000, decidedBy: 'u-boss', state: 'awaiting_return', needsCount: false });
    expect(await mgr.recordReturn({ grnId: 'g-ret', lineId: 'L1', reason: 'the supplier driver collected it' })).toEqual({ outcome: 'returned' });
    expect(await mgr.recordReturn({ grnId: 'g-ret', lineId: 'L1', reason: 'again' })).toEqual({ outcome: 'already_returned' });

    const after = (await screenFor('u-mgr')).view('en');
    expect(after.awaitingReturn).toEqual([]);
    expect(after.receipts.find((r) => r.grnId === 'g-ret')!.returnLines).toEqual([expect.objectContaining({ lineId: 'L1', state: 'returned', returnedBy: 'u-mgr', stateLabel: 'Gone back to the supplier' })]);
  }, 60_000);
});
