import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import { regulatedPublishBody } from '../support/approval-request';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { acceptPack, type SignedPack } from '../../services/catalogue/src/pack';
import { hmacSigner } from '../../services/catalogue/src/index';
import { CatalogueCache, UnknownBarcodeError, type CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { PosSession, taxRateFromPercent, createPosView } from '../../apps/pos/src/index';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';
import { TillRuleRefusedError } from '../../packages/restricted-sales/src/till-gate';

/**
 * **B16 (roadmap v2.1 · COTPA 2003 s.7 · OB-140 "A") through the real API, in memory and on real PostgreSQL, with a cold
 * restart.** Signed sentence: "a tobacco SKU cannot become sellable (activation refused, so it never reaches the pack)
 * without a recorded warning-compliance attestation that is valid for the currently notified warning image. An expired
 * attestation takes it off sale on the next pack, offline."
 *
 * OB-140 "A": a NAMED person confirms each tobacco product once — at listing, and again on each new government picture.
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
const CIG = '8901000000040';
const TOBACCO = { categoryId: 'tobacco', name: 'Tobacco', parentId: null, regulated: ['age_restricted'] };
const cigarettes = { sku: 'CIG10', name: 'Cigarettes 10s (demo)', baseUom: 'ea', primaryCategoryId: 'tobacco', taxClass: '24022010', lifecycle: 'draft', safety: { minimumAge: 18, tobacco: true, packMinimumMinor: 1 } };
// Two government pictures: the one in force since 2020, and a new one notified to come in on 5 June 2030.
const PICTURE_1 = { effectiveFrom: '2020-01-01', notifiedOn: '2019-10-01', reference: 'G.S.R. 2019 (demo)', evidenceRef: 'DOC-gsr-2019' };
const PICTURE_2 = { effectiveFrom: '2030-06-05', notifiedOn: '2026-01-15', reference: 'G.S.R. 2026 (demo)', evidenceRef: 'DOC-gsr-2026' };
type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

/** The lane: accept the signed pack, then scan with no network, the till's own clock set to `today`. */
function laneOn(pack: SignedPack, tenantId: string, today: string) {
  const accepted = acceptPack({ incoming: pack, signer, tenantId });
  expect(accepted.accepted, accepted.detail).toBe(true);
  const snapshot: CatalogueSnapshot = accepted.tradingOn!.snapshot;
  const session = new PosSession(
    { laneId: 'lane-1', cashierId: 'u-cash', tradingDay: today, currency: 'INR', defaultTaxRate: taxRateFromPercent(28), clock: () => `${today}T06:00:00.000Z` },
    new Ledger(new InMemoryLedgerStore()), new SyncOutbox(),
    () => Promise.resolve({ committed: true as const, durable: true as const, detail: 'ok', laneMessage: 'ok' }),
  );
  return { cache: new CatalogueCache(snapshot), view: createPosView(session, 'INR', new CatalogueCache(snapshot)) };
}

describe.each(backings)('B16: a tobacco pack without a current warning confirmation is not sellable — on $name', ({ harness, restart }) => {
  it('activation refused → never on the pack; a named person confirms → on sale; a new picture → the till stops on its day offline, and the next pack leaves it out', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-meena', 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier');
    await h.provisionRole(T, 'u-acct', 'accountant'); // OB-503: the second person who approves a regulated product reaching the tills
    const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = 'u-owner'): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    await ok(req('POST', '/v1/catalogue/tax-classes/24022010/rates/2017-07-01', { rateBps: 2_800 }), 'tax');

    // Listing it to sell NOW, unconfirmed: refused, nothing saved.
    const sellNow = await req('POST', '/v1/catalogue/products/p-cig/publish', { product: { ...cigarettes, lifecycle: 'active' }, categories: [TOBACCO] });
    expect(sellNow.status).toBe(422);
    expect(codeOf(sellNow)).toBe('tobacco_warning_not_confirmed');
    expect((await req('GET', '/v1/catalogue/products/p-cig')).status).toBe(404);
    // Listed as a draft: saved, NOT activated — and said so.
    const draft = await ok(req('POST', '/v1/catalogue/products/p-cig/publish', { product: cigarettes, categories: [TOBACCO] }), 'draft');
    expect(draft.body).toMatchObject({ product: { lifecycle: 'draft' }, activation: { refused: true, because: 'tobacco_warning_not_confirmed', standing: 'no_picture_notified' } });
    await ok(req('POST', '/v1/prices/list/p-cig/entries/e1', { scope: 'store', scopeRef: STORE, priceMinor: 180_00, mrpMinor: 180_00, costMinor: 1, marginFloorBps: 0, currency: 'INR', effectiveFrom: '2030-01-01' }), 'price');
    await ok(req('POST', `/v1/catalogue/products/p-cig/barcodes/${CIG}`, { kind: 'ean' }), 'barcode');
    // The rest of the shop (one line, so a pack is never empty).
    await ok(req('POST', '/v1/catalogue/tax-classes/1006/rates/2017-07-01', { rateBps: 500 }), 'tax rice');
    await ok(req('POST', '/v1/catalogue/products/p-rice/publish', { product: { sku: 'RICE', name: 'Rice 1kg', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '1006', lifecycle: 'draft' }, categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }] }), 'rice');
    await ok(req('POST', '/v1/prices/list/p-rice/entries/e1', { scope: 'store', scopeRef: STORE, priceMinor: 70_00, mrpMinor: 80_00, costMinor: 1, marginFloorBps: 0, currency: 'INR', effectiveFrom: '2030-01-01' }), 'rice price');
    // It never reaches the pack: left out, and the pack says why.
    const previewQ = (await h.request({ method: 'GET', path: '/v1/catalogue/pack/preview', userId: 'u-owner', tenantId: T, query: { storeId: STORE, asOf: '2030-06-01' } })).body as { excluded: { productId: string; reason: string }[]; snapshot: { products: { productId: string }[] } };
    expect(previewQ.excluded).toContainEqual(expect.objectContaining({ productId: 'p-cig', reason: 'tobacco_warning_not_confirmed' }));
    expect(previewQ.snapshot.products.map((p) => p.productId)).not.toContain('p-cig');

    // The government picture in force is recorded; a cashier may not record one, or confirm.
    expect((await req('POST', '/v1/catalogue/tobacco-warning-pictures/P-2020', PICTURE_1, 'u-cash')).status).toBe(403);
    await ok(req('POST', '/v1/catalogue/tobacco-warning-pictures/P-2020', PICTURE_1), 'picture 1');
    expect((await req('POST', '/v1/catalogue/tobacco-warning-pictures/P-2020', { ...PICTURE_1, reference: 'changed' })).status).toBe(409);
    expect((await req('POST', '/v1/catalogue/products/p-cig/tobacco-warning-confirmation', { imageId: 'P-2020', evidenceRef: 'PHOTO-1' }, 'u-cash')).status).toBe(403);
    // A confirmation names what was looked at; a picture that does not exist is not confirmable.
    expect((await req('POST', '/v1/catalogue/products/p-cig/tobacco-warning-confirmation', { imageId: 'P-2020' }, 'u-meena')).status).toBe(400);
    expect((await req('POST', '/v1/catalogue/products/p-cig/tobacco-warning-confirmation', { imageId: 'P-NONE', evidenceRef: 'PHOTO-1' }, 'u-meena')).status).toBe(404);
    // A NAMED person confirms the packs carry it.
    const confirmed = await ok(req('POST', '/v1/catalogue/products/p-cig/tobacco-warning-confirmation', { imageId: 'P-2020', evidenceRef: 'PHOTO-pack-front' }, 'u-meena'), 'confirm');
    expect(confirmed.body).toMatchObject({ confirmation: { imageId: 'P-2020', confirmedBy: 'u-meena', evidenceRef: 'PHOTO-pack-front' }, standing: { sellable: true } });

    // A cold restart: the confirmation is on the product record, kept.
    h = restart(h);
    // A publish cannot type a confirmation in (or out): the body's own `tobaccoWarning` is ignored; the stored one is carried.
    // OB-503: tobacco reaching the tills for the first time (the draft never did) needs a second person's approval as well.
    const activated = await ok(req('POST', '/v1/catalogue/products/p-cig/publish', await regulatedPublishBody(h, T, 'p-cig', { product: { ...cigarettes, tobaccoWarning: { images: [], confirmations: [] } }, categories: [TOBACCO] })), 'activate');
    expect(activated.body).toMatchObject({ product: { lifecycle: 'new', tobaccoWarning: { confirmations: [expect.objectContaining({ confirmedBy: 'u-meena' })] } } });
    expect((activated.body as Record<string, unknown>)['activation']).toBeUndefined();

    // The new government picture is notified: the confirmation is good until the day before it comes in.
    const notified = await ok(req('POST', '/v1/catalogue/tobacco-warning-pictures/P-2030', PICTURE_2), 'picture 2');
    expect((notified.body as { productsToConfirmAgain: string[] }).productsToConfirmAgain).toEqual(['p-cig']);

    let n = 0;
    const pack = async (asOf: string, acknowledgedRemovals?: number): Promise<SignedPack> => {
      n += 1;
      await ok(req('POST', '/v1/catalogue/pack', { storeId: STORE, asOf, ...(acknowledgedRemovals === undefined ? {} : { acknowledgedRemovals }) }), `publish ${n}`);
      return (await req('GET', '/v1/catalogue/pack')).body as SignedPack;
    };
    // The pack built before the new picture carries the cigarettes, signed with the last good day.
    const before = await pack('2030-06-01');
    expect(before.snapshot.products.find((p) => p.productId === 'p-cig')?.regulatedFlags).toMatchObject({ tobacco: true, tobaccoWarningConfirmedUntil: '2030-06-04' });
    const june4 = laneOn(before, T, '2030-06-04');
    expect(() => june4.view.scanBarcode(CIG)).toThrow(/age|18/i); // on sale: the till asks the age question, as for any tobacco
    // OFFLINE on 5 June, still on that pack: the till's own clock stops it, by name.
    const june5 = laneOn(before, T, '2030-06-05');
    expect(() => june5.view.scanBarcode(CIG)).toThrow(TillRuleRefusedError);
    const words = ((): string => { try { june5.view.scanBarcode(CIG); return 'sold'; } catch (e) { return (e as TillRuleRefusedError).laneMessage; } })();
    expect(words).toMatch(/^Cigarettes 10s \(demo\) cannot be sold: a new government health-warning picture/);

    // The next pack after the picture comes in leaves it out (the confirmation has expired) — off sale.
    // (The shop here is two products, so the drop is acknowledged by count — the pack's own shrink guard, P-08.)
    const after = await pack('2030-06-10', 1);
    expect(after.snapshot.products.map((p) => p.productId)).not.toContain('p-cig');
    expect(() => laneOn(after, T, '2030-06-10').cache.scan(CIG)).toThrow(UnknownBarcodeError);
    const standing = (await req('GET', '/v1/catalogue/tobacco-warning')).body as { products: { productId: string; sellable: boolean; goodUntil?: string }[] };
    expect(standing.products).toEqual([expect.objectContaining({ productId: 'p-cig', sellable: true, goodUntil: '2030-06-04' })]); // today (real) is before 2030

    // The new picture may be confirmed ahead of its day: then the next pack carries the cigarettes again, good open-ended.
    const again = await ok(req('POST', '/v1/catalogue/products/p-cig/tobacco-warning-confirmation', { imageId: 'P-2030', evidenceRef: 'PHOTO-new-pack' }, 'u-meena'), 'confirm new picture');
    expect((again.body as { standing: { sellable: boolean } }).standing.sellable).toBe(true);
    const back = await pack('2030-06-11');
    expect(back.snapshot.products.find((p) => p.productId === 'p-cig')?.regulatedFlags).not.toHaveProperty('tobaccoWarningConfirmedUntil');
  });

  it('a product that is not tobacco has nothing to confirm; the pictures read back in order', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    const req = (method: 'GET' | 'POST', path: string, body?: unknown): Promise<Res> =>
      h.request({ method, path, userId: 'u-owner', tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
    const GROCERY = { categoryId: 'grocery', name: 'Grocery', parentId: null };
    expect((await req('POST', '/v1/catalogue/products/p-rice/publish', { product: { sku: 'RICE', name: 'Rice 1kg', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '1006', lifecycle: 'draft' }, categories: [GROCERY] })).body).toMatchObject({ product: { lifecycle: 'new' } });
    await req('POST', '/v1/catalogue/tobacco-warning-pictures/P-2030', PICTURE_2);
    await req('POST', '/v1/catalogue/tobacco-warning-pictures/P-2020', PICTURE_1);
    const rice = await req('POST', '/v1/catalogue/products/p-rice/tobacco-warning-confirmation', { imageId: 'P-2020', evidenceRef: 'X' });
    expect(rice.status).toBe(422);
    expect(codeOf(rice)).toBe('not_a_tobacco_product');
    const pictures = (await req('GET', '/v1/catalogue/tobacco-warning-pictures')).body as { pictures: { imageId: string }[]; inForce: { imageId: string }; next: { imageId: string } };
    expect(pictures.pictures.map((p) => p.imageId)).toEqual(['P-2020', 'P-2030']);
    expect(pictures.inForce.imageId).toBe('P-2020');
    expect(pictures.next.imageId).toBe('P-2030');
    expect((await req('POST', '/v1/catalogue/tobacco-warning-pictures/P-FUTURE', { ...PICTURE_1, notifiedOn: '2099-01-01', effectiveFrom: '2099-02-01' })).status).toBe(400);
  });
});
