import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { acceptPack, type SignedPack } from '../../services/catalogue/src/pack';
import { hmacSigner } from '../../services/catalogue/src/index';
import { CatalogueCache, type CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { PosSession, taxRateFromPercent, createPosView } from '../../apps/pos/src/index';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';
import { TillRuleRefusedError } from '../../packages/restricted-sales/src/till-gate';
import { checkTillRules } from '../../edge/store-edge/src/lane-scales';
import { SoldHuids } from '../../edge/store-edge/src/sold-huids';

/**
 * **B13 (OB-138 · BIS IS 1417:2016) through the real API, the lane's own code and the store computer's gate — in memory
 * and on real PostgreSQL, with a cold restart.** Signed sentence: "Every gold item must carry a 6-character HUID
 * hallmark recorded on the product before it can be sold. At the till, a gold item with no HUID, or with an HUID already
 * sold, is refused by name. The HUID sold is printed on the bill and kept with the sale."
 *
 * The "already sold" check works OFFLINE: the store computer knows the HUIDs it has sold (from its own disk) and tells
 * the till; the till also knows what it sold since it loaded; the store computer refuses again before its disk; head
 * office backstops at intake for a piece sold at another store.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });
const backings: { name: string; harness: () => ApiHarness; restart: (h: ApiHarness) => ApiHarness }[] = [
  { name: 'the in-memory event store', harness: () => apiHarness(), restart: (h) => apiHarness({ store: h.store }) },
];
if (DATABASE_URL !== undefined) {
  const pg = (): ApiHarness => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };
  backings.push({ name: 'real PostgreSQL', harness: pg, restart: pg });
}

const STORE = 'S1';
const signer = hmacSigner(TEST_PACK_KEY);
const JEWELLERY = { categoryId: 'jewellery', name: 'Gold jewellery', parentId: null };
const RING = '8901000000033';
const CHAIN = '8901000000057';
const piece = (sku: string, name: string, safety: Record<string, unknown>) => ({ sku, name, baseUom: 'ea', primaryCategoryId: 'jewellery', taxClass: '7113', lifecycle: 'draft', safety });
type Res = { status: number; body: unknown };

function till(snapshot: CatalogueSnapshot, soldHuids: readonly string[] = []) {
  const records: Record<string, unknown>[] = [];
  const session = new PosSession(
    { laneId: 'lane-1', cashierId: 'u-cash', tradingDay: '2030-06-10', currency: 'INR', defaultTaxRate: taxRateFromPercent(3), clock: () => '2030-06-10T06:00:00.000Z', soldHuids: () => new Set(soldHuids) },
    new Ledger(new InMemoryLedgerStore()), new SyncOutbox(),
    (_id, record) => { records.push(JSON.parse(String(record)) as Record<string, unknown>); return Promise.resolve({ committed: true as const, durable: true as const, detail: 'ok', laneMessage: 'ok' }); },
  );
  return { view: createPosView(session, 'INR', new CatalogueCache(snapshot)), records };
}
const refusalWords = (f: () => unknown): string => { try { f(); return 'sold'; } catch (e) { return (e as TillRuleRefusedError).laneMessage ?? String(e); } };

describe.each(backings)('B13: a gold piece is sold once, with its HUID — on $name', ({ harness, restart }) => {
  it('no HUID → refused by name; with HUID → sold, on the bill and kept with the sale; sold again → refused at the till, the box and head office', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-cash', 'cashier');
    const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = 'u-owner'): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    await ok(req('POST', '/v1/catalogue/tax-classes/7113/rates/2017-07-01', { rateBps: 300 }), 'tax');

    // A HUID the till cannot read is refused at the product master, never published.
    const bad = await req('POST', '/v1/catalogue/products/p-ring/publish', { product: piece('RING-22K-01', 'Gold ring 22K (demo)', { gold: true, huid: 'ab12' }), categories: [JEWELLERY] });
    expect(bad.status).toBe(422);
    expect(JSON.stringify(bad.body)).toContain('6 letters and digits');
    await ok(req('POST', '/v1/catalogue/products/p-ring/publish', { product: piece('RING-22K-01', 'Gold ring 22K (demo)', { gold: true, huid: 'AB12CD' }), categories: [JEWELLERY] }), 'ring');
    // A gold piece with no HUID recorded yet may be listed — and the till will not sell it.
    await ok(req('POST', '/v1/catalogue/products/p-chain/publish', { product: piece('CHAIN-22K-01', 'Gold chain 22K (demo)', { gold: true }), categories: [JEWELLERY] }), 'chain');
    for (const [id, code] of [['p-ring', RING], ['p-chain', CHAIN]] as const) {
      await ok(req('POST', `/v1/prices/list/${id}/entries/e1`, { scope: 'store', scopeRef: STORE, priceMinor: 45_000_00, mrpMinor: 45_000_00, costMinor: 1, marginFloorBps: 0, currency: 'INR', effectiveFrom: '2030-01-01' }), `price ${id}`);
      await ok(req('POST', `/v1/catalogue/products/${id}/barcodes/${code}`, { kind: 'ean' }), `barcode ${id}`);
    }
    h = restart(h);
    await ok(req('POST', '/v1/catalogue/pack', { storeId: STORE, asOf: '2030-06-10' }), 'pack');
    const pack = (await req('GET', '/v1/catalogue/pack')).body as SignedPack;
    const accepted = acceptPack({ incoming: pack, signer, tenantId: T });
    expect(accepted.accepted).toBe(true);
    const snapshot = accepted.tradingOn!.snapshot;
    expect(snapshot.products.find((p) => p.productId === 'p-ring')?.regulatedFlags).toEqual({ gold: true, huid: 'AB12CD' });
    expect(snapshot.products.find((p) => p.productId === 'p-chain')?.regulatedFlags).toEqual({ gold: true });

    // The till, offline: the chain has no HUID → refused by name; the ring sells once.
    const lane = till(snapshot);
    expect(refusalWords(() => lane.view.scanBarcode(CHAIN))).toMatch(/^Gold chain 22K \(demo\) is gold and has no hallmark HUID recorded/);
    lane.view.scanBarcode(RING);
    // The same piece twice on one bill is the same HUID twice — refused.
    expect(refusalWords(() => lane.view.scanBarcode(RING))).toMatch(/Gold ring 22K \(demo\) \(HUID AB12CD\) has already been sold/);
    await lane.view.tenderCash('S-RING-1', 'R-RING-1', '2030-06-10T06:05:00.000Z');
    const line = (lane.records[0]!['lines'] as { productId: string; huid?: string }[])[0]!;
    expect(line).toMatchObject({ productId: 'p-ring', huid: 'AB12CD' }); // kept with the sale — the bill prints it from here
    // The same till, next customer: it knows what it sold since it loaded.
    lane.view.newSale();
    expect(refusalWords(() => lane.view.scanBarcode(RING))).toMatch(/HUID AB12CD\) has already been sold/);
    // Another till served after that sale: the store computer's list (from its disk) tells it.
    const box = new SoldHuids([JSON.stringify(lane.records[0])]);
    expect(box.list()).toEqual(['AB12CD']);
    expect(refusalWords(() => till(snapshot, box.list()).view.scanBarcode(RING))).toMatch(/already been sold/);
    // The store computer's own gate, before its disk, for a till that skipped the check.
    const products = new Map(snapshot.products.map((p) => [p.productId, { name: p.name, baseUom: p.baseUom, unitPriceMinor: p.unitPriceMinor, ...(p.regulatedFlags === undefined ? {} : { regulatedFlags: p.regulatedFlags }) }] as const));
    const again = { lines: [{ productId: 'p-ring', quantityMinor: 1, uom: 'ea', unitPriceMinor: 45_000_00, huid: 'AB12CD' }] };
    expect(checkTillRules(again, { products, scales: { known: false, why: 'none' }, today: '2030-06-10', soldHuids: box.asSet() })).toMatchObject({ ok: false, refusedBecause: 'gold_huid_already_sold', productId: 'p-ring' });
    expect(checkTillRules(again, { products, scales: { known: false, why: 'none' }, today: '2030-06-10', soldHuids: new Set() })).toEqual({ ok: true });
    expect(checkTillRules({ lines: [again.lines[0], again.lines[0]] }, { products, scales: { known: false, why: 'none' }, today: '2030-06-10', soldHuids: new Set() })).toMatchObject({ ok: false, refusedBecause: 'gold_huid_already_sold' });

    // Head office: the sale is banked with its HUID; the same HUID banked again on another sale is CRITICAL.
    const sale = (saleId: string, huid?: string) => ({
      saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', locationId: STORE, cashierId: 'u-owner', tradingDay: '2030-06-10', committedAt: '2030-06-10T06:05:00Z',
      totalMinor: 45_000_00, currency: 'INR', packVersion: pack.snapshot.version,
      lines: [{ productId: 'p-ring', quantityMinor: 1, uom: 'ea', unitPriceMinor: 45_000_00, lineTotalMinor: 45_000_00, ...(huid === undefined ? {} : { huid }) }],
      tenders: [{ kind: 'cash', amountMinor: 45_000_00 }],
    });
    const kinds = (r: Res): string[] => ((r.body as { exceptions?: { kind: string; severity: string }[] }).exceptions ?? []).filter((e) => e.severity === 'critical').map((e) => e.kind);
    expect(kinds(await ok(req('POST', '/v1/sales', sale('S-RING-1', 'AB12CD')), 'first sale'))).not.toContain('gold_huid_sold_twice');
    h = restart(h);
    expect(kinds(await ok(req('POST', '/v1/sales', sale('S-RING-2', 'AB12CD')), 'second sale'))).toContain('gold_huid_sold_twice');
    expect(kinds(await ok(req('POST', '/v1/sales', { ...sale('S-CHAIN-1'), lines: [{ productId: 'p-chain', quantityMinor: 1, uom: 'ea', unitPriceMinor: 45_000_00, lineTotalMinor: 45_000_00 }] }), 'chain sale'))).toContain('gold_sold_without_huid');
  });
});
