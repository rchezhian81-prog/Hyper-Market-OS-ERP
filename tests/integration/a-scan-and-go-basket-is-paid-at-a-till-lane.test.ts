import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEST_IDP, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import { useRestartableBackings } from '../support/p3-backings';
import type { HttpRequest } from '../../services/kernel/src/index';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { prepareTillBox, signInTill } from '../support/till-operator';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

/**
 * **OB-350 · R8-3 · D04-FR-06 — scan-and-go: the phone builds the basket and shows the total; payment and the bag check are at
 * a till lane, where the till re-prices every line. The phone is never trusted.** Through the production routes, a real store
 * computer (`startEdge`, its lane socket) and the real till (`bootPos`):
 *
 *   • the customer's phone asks the shop's price (the till's offers engine, no delivery fee) and hands the basket to head
 *     office: product ids and counts only; a loose weighed item and a product the pack does not sell are refused; the same
 *     basket sent again is the same six-digit code; no price is kept;
 *   • a person cannot recall a basket — only the store computer, for the cashier it verified; a customer sees only their own;
 *   • at the till the cashier keys the code: the box asks head office, and the till rings every line through ITS OWN pack —
 *     its price, never the phone's — and sells it as any bill; head office says which till took it;
 *   • strictly once: a second recall is refused, naming the first till; with the line down the box says so in words and the
 *     cashier scans the items — the sale never waits (hard rule #1);
 *   • in memory and on real PostgreSQL, with a cold restart of head office. Synthetic data.
 */

const backings = useRestartableBackings();
const STORE = 'store-1';
const MILK = { id: 'p-milk', code: '8900000000029', price: 30_00 };
const DAL = { id: 'p-dal', code: '8900000000036', price: 120_00 };
const LOOSE = { id: 'p-loose-rice', code: '8900000000043', price: 60_00 };
const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
const savedFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = savedFetch;
  for (const s of stops.splice(0)) await s();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe.each(backings)('a scan-and-go basket is paid at a till lane (OB-350) — on $name', ({ harness }) => {
  it('phone → code → the till re-prices and sells it → once only → offline the cashier scans; a restart reads the same', async () => {
    let h: ApiHarness = harness();
    const A = randomUUID();
    if (h.store instanceof SqlEventStore) await h.store.registerTenant(A, 'test/provision');
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-meena', 'cashier');
    await h.provisionRole(A, 'u-box', 'store_computer', [STORE]);
    for (const c of ['c-1', 'c-2']) await h.provisionRole(A, c, 'customer');
    await h.enableFeature(A, 'customer_app');
    const req = (method: HttpRequest['method'], path: string, userId: string, body?: unknown) => h.request({ method, path, userId, tenantId: A, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
    const ok = async (method: HttpRequest['method'], path: string, userId: string, body?: unknown) => {
      const r = await req(method, path, userId, body);
      if (r.status >= 300) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.body)}`);
      return r.body as Record<string, unknown>;
    };
    const today = shopDateIn(new Date().toISOString());
    await ok('POST', '/v1/catalogue/tax-classes/0401/rates/2017-07-01', 'u-owner', { rateBps: 0 });
    for (const [p, uom] of [[MILK, 'ea'], [DAL, 'ea'], [LOOSE, 'kg']] as const) {
      await ok('POST', `/v1/catalogue/products/${p.id}/publish`, 'u-owner', { product: { sku: `${p.id}-sku`, name: `Synthetic ${p.id}`, baseUom: uom, primaryCategoryId: 'grocery', taxClass: '0401', lifecycle: 'active' }, categories: [{ categoryId: 'grocery', name: 'Grocery (test)', parentId: null }] });
      await ok('POST', `/v1/prices/list/${p.id}/entries/e1`, 'u-owner', { scope: 'store', scopeRef: STORE, priceMinor: p.price, mrpMinor: p.price, costMinor: 1, marginFloorBps: 0, currency: 'INR', effectiveFrom: today });
      await ok('POST', `/v1/catalogue/products/${p.id}/barcodes/${p.code}`, 'u-owner', { kind: 'ean' });
    }
    await ok('POST', '/v1/catalogue/pack', 'u-owner', { storeId: STORE, asOf: today });
    const pack = (await ok('GET', '/v1/catalogue/pack', 'u-owner'))['snapshot'] as CatalogueSnapshot;

    // ── The phone: the shop's price (the till's offers engine; nothing is delivered, so no fee) — a what-if.
    const lines = [{ productId: MILK.id, quantityMinor: 2 }, { productId: DAL.id, quantityMinor: 1 }];
    expect(await ok('POST', '/v1/storefront/cart/quote', 'c-1', { lines })).toMatchObject({ priced: true, goodsMinor: 180_00, deliveryFeeMinor: 0, payableMinor: 180_00, committedAnything: false });
    // ── Handing it to the till: a weighed item and a product the pack does not sell are refused; nothing is kept.
    const hand = (customer: string, basketId: string, body: unknown) => req('POST', `/v1/storefront/scan-and-go/baskets/${basketId}`, customer, body);
    const weighed = await hand('c-1', 'sg-basket-0001', { lines: [...lines, { productId: LOOSE.id, quantityMinor: 1 }] });
    expect([weighed.status, (weighed.body as { error: { code: string } }).error.code]).toEqual([422, 'not_for_scan_and_go']);
    expect(JSON.stringify(weighed.body)).toContain('weighed at the till');
    expect((await hand('c-1', 'sg-basket-0001', { lines: [{ productId: 'p-nope', quantityMinor: 1 }] })).status).toBe(422);
    expect((await hand('c-1', 'sg-basket-0001', { lines: [{ productId: MILK.id, quantityMinor: 0 }] })).status).toBe(400);
    expect((await hand('u-meena', 'sg-basket-0001', { lines })).status).toBe(403); // the till's person is not a customer
    const held = await hand('c-1', 'sg-basket-0001', { lines });
    expect(held.status).toBe(201);
    const code = (held.body as { code: string }).code;
    expect(code).toMatch(/^\d{6}$/);
    expect((held.body as { lines: unknown[] }).lines).toEqual([
      { productId: MILK.id, name: `Synthetic ${MILK.id}`, quantityMinor: 2, barcode: MILK.code }, { productId: DAL.id, name: `Synthetic ${DAL.id}`, quantityMinor: 1, barcode: DAL.code },
    ]);
    // No price is kept — the till prices it: no key anywhere names a price or an amount (only counts).
    expect(JSON.stringify(held.body).match(/"[A-Za-z]*(?:[Pp]rice|[Aa]mount|[Tt]otal|[Pp]ayable)[A-Za-z]*"\s*:/g)).toBeNull();
    expect(await ok('POST', '/v1/storefront/scan-and-go/baskets/sg-basket-0001', 'c-1', { lines })).toMatchObject({ code, alreadyHeld: true });
    expect((await ok('GET', '/v1/storefront/scan-and-go/baskets', 'c-2'))['baskets']).toEqual([]);
    // Only the store computer recalls — never a person, not even the cashier, from outside the box.
    expect((await req('POST', `/v1/store/scan-and-go/${code}/recall`, 'u-meena', { laneId: 'lane-1', cashierId: 'u-meena' })).status).toBe(403);
    expect((await req('POST', `/v1/store/scan-and-go/${code}/recall`, 'c-1', { laneId: 'lane-1', cashierId: 'c-1' })).status).toBe(403);

    // ── The store: a real box whose cloud is this head office (the line can be cut), and a till with the signed pack.
    let online = true;
    globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
      if (String(url).startsWith('http://127.0.0.1:')) return savedFetch(url, init);
      if (!online) throw new Error('ENETUNREACH');
      const hdr = (init.headers ?? {}) as Record<string, string>;
      const res = await h.raw({
        method: (init.method ?? 'GET') as HttpRequest['method'], path: new URL(url).pathname,
        token: hdr['authorization']?.replace(/^Bearer /, ''), idempotencyKey: hdr['idempotency-key'],
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
      });
      return new Response(JSON.stringify(res.body), { status: res.status });
    }) as unknown as typeof globalThis.fetch;
    const dir = await mkdtemp(join(tmpdir(), 'sre-scan-and-go-'));
    dirs.push(dir);
    const ready = await prepareTillBox({ dir, key: TEST_PACK_KEY, people: [{ userId: 'u-meena', displayName: 'Meena' }] });
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: A, PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', ...ready,
      CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: A, branchId: STORE }),
    }, () => {}))!;
    stops.push(() => edge.stop());
    const till = bootPos({ laneId: 'lane-1', taxPercent: 0, lanePort: edge.lane!.port, catalogue: pack });
    await signInTill(till, 'u-meena');

    // A basket already on the till: a phone basket never joins another customer's.
    till.scanBarcode(DAL.code);
    expect(await till.recallPhoneBasketAtTill(code)).toMatchObject({ ok: false, refusedBecause: 'basket_not_empty' });
    till.voidLine(till.basket()[0]!.lineId, 'customer changed their mind');
    expect(await till.recallPhoneBasketAtTill('12ab')).toMatchObject({ ok: false, refusedBecause: 'not_a_basket_code' });
    expect(await till.recallPhoneBasketAtTill('000000')).toMatchObject({ ok: false, refusedBecause: 'no_such_phone_basket' });

    // ── The cashier keys the code: every line rung through THIS till's pack, at the till's price.
    const brought = await till.recallPhoneBasketAtTill(code);
    expect(brought).toMatchObject({ ok: true, code, notAdded: [] });
    expect(till.basket().filter((l) => !l.voided).map((l) => [l.productId, l.qty, l.unitPriceMinor])).toEqual([[MILK.id, 2, MILK.price], [DAL.id, 1, DAL.price]]);
    expect(till.payableMinor()).toBe(180_00);
    // Strictly once — even this same till asking again.
    expect(await till.recallPhoneBasketAtTill(code)).toMatchObject({ ok: false, refusedBecause: 'basket_not_empty' });
    const n = await till.nextReceipt();
    expect(await till.tenderCash(`S-sg-${n}`, n, new Date().toISOString())).toBe(n);
    expect(await till.recallPhoneBasketAtTill(code)).toMatchObject({ ok: false, refusedBecause: 'already_recalled' });
    const sold = (await readLog(edge.log.path)).flatMap((r) => (r.ok ? [JSON.parse(r.record) as { total: number }] : []));
    expect(sold).toEqual([expect.objectContaining({ total: 180_00 })]);
    expect(((await ok('GET', '/v1/storefront/scan-and-go/baskets', 'c-1'))['baskets'] as { code: string; recalled: unknown }[])).toEqual([expect.objectContaining({ code, recalled: { laneId: 'lane-1', at: expect.any(String) } })]);

    // ── The line goes down: the box says so in words; the cashier scans the items — the sale never waits.
    const second = (await ok('POST', '/v1/storefront/scan-and-go/baskets/sg-basket-0002', 'c-2', { lines: [{ productId: MILK.id, quantityMinor: 1 }] }))['code'] as string;
    online = false;
    const offline = await till.recallPhoneBasketAtTill(second);
    expect(offline).toMatchObject({ ok: false, refusedBecause: 'head_office_unreachable' });
    expect(offline.laneMessage).toMatch(/Scan the items as usual/);
    till.newSale();
    till.scanBarcode(MILK.code);
    const n2 = await till.nextReceipt();
    expect(await till.tenderCash(`S-sg-${n2}`, n2, new Date().toISOString())).toBe(n2);
    online = true;

    // ── A cold restart of head office: the baskets and the one recall read the same.
    const before = await ok('GET', '/v1/storefront/scan-and-go/baskets', 'c-1');
    h = harness(h);
    const after = (await h.request({ method: 'GET', path: '/v1/storefront/scan-and-go/baskets', userId: 'c-1', tenantId: A })).body as Record<string, unknown>;
    expect(after['baskets']).toEqual(before['baskets']);
    const again = await h.raw({ method: 'POST', path: `/v1/store/scan-and-go/${code}/recall`, token: TEST_IDP.issue({ sub: 'u-box', tenantId: A, branchId: STORE }), idempotencyKey: 'again', body: { laneId: 'lane-2', cashierId: 'u-meena' } });
    expect([again.status, (again.body as { error: { code: string } }).error.code]).toEqual([409, 'already_recalled']);
  }, 120_000);
});
