import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiHarness, TEST_IDP, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import { startRealCloud, type RealCloud } from '../support/real-store';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { issueTillPins, signInTill } from '../support/till-operator';
import { GST_INVOICE_NUMBER_MAX, storeComputerDefaultPrefix } from '../../packages/contracts/src/receipt-number';

/**
 * **OB-81 "A" (owner, 12 Oct 2026): bill numbers — and the sale ids the till derives from them — are unique across stores,
 * and every bill number is within GST's 16 characters.**
 *
 * Two stores (S1, S2), each with a till called "lane-1" (OB-80), each with its own REAL store computer taking its setup from
 * head office, and the real `bootPos` till on each box's lane socket. In memory and on real PostgreSQL through the
 * production API over HTTP:
 *
 *   • the owner issues each (store, till) a prefix (S1L1-, S2L1-); versioned, audited; a prefix another till holds is
 *     refused BY NAME (store and till); a prefix past 10 characters, with a reserved start, or not GST's characters is
 *     refused; a cashier cannot issue one; the same issue re-sent is the same answer and records nothing new;
 *   • the signed store pack carries each store's prefix and the number of stores; the box numbers from it;
 *   • with head office UNREACHABLE both tills sell: S1L1-000001 and S2L1-000001 — distinct numbers, distinct sale ids,
 *     each ≤ 16 characters; box 1 restarts offline and carries on at S1L1-000002 (its cursor is on its disk);
 *   • back online, both boxes sync: each sale is banked once, at ITS OWN store's stock; a replay is the same one sale;
 *   • a changed prefix starts a new series and the old prefix stays that till's forever (never issued to another);
 *   • a till head office never issued a prefix, in a two-store business, still sells offline under its box's store-
 *     qualified default (ZZ……-) and head office flags every such sale and lists the till.
 */

const OWNER = 'u-owner';
const S1 = 'S1'; const S2 = 'S2';
const SETTINGS = { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 30 };
const AT = new Date(Date.now() - 60_000).toISOString();

interface Reply { readonly status: number; readonly body: unknown }
interface Cloud {
  readonly tenant: string;
  /** Where a box reaches head office. */
  readonly url: string;
  call(method: HttpRequest['method'], path: string, user: string, body?: unknown, key?: string, query?: Record<string, string>, branchId?: string): Promise<Reply>;
  grant(user: string, role: string, scope: readonly string[] | 'all'): Promise<void>;
  /** A fetch for the boxes to use: head office (unless cut) and the boxes' own sockets. */
  fetchFor(saved: typeof globalThis.fetch, isCut: () => boolean): typeof globalThis.fetch;
}
const codeOf = (r: Reply): string | undefined => (r.body as { error?: { code?: string } } | null)?.error?.code;
const wordsOf = (r: Reply): string => (r.body as { error?: { whatHappened?: string } } | null)?.error?.whatHappened ?? '';

async function headOfficeSetUp(cloud: Cloud): Promise<void> {
  const post = (path: string, body: unknown, key: string) => cloud.call('POST', path, OWNER, body, key);
  for (const [id, body] of [
    ['C1', { kind: 'company', name: 'SRE Retail' }],
    [S1, { kind: 'branch', name: 'Store One', parentId: 'C1', companyId: 'C1' }],
    [S2, { kind: 'branch', name: 'Store Two', parentId: 'C1', companyId: 'C1' }],
  ] as const) expect((await post(`/v1/org/nodes/${id}`, body, `org-${id}`)).status).toBeLessThan(300);
  for (const s of [S1, S2]) expect((await post(`/v1/stores/${s}/settings`, SETTINGS, `settings-${s}`)).status).toBeLessThan(300);
  await cloud.grant('u-box-1', 'store_computer', [S1]);
  await cloud.grant('u-box-2', 'store_computer', [S2]);
  await cloud.grant('u-cash1', 'cashier', [S1]);
  await cloud.grant('u-cash2', 'cashier', [S2]);
  await cloud.grant('u-mgr1', 'store_manager', [S1]);
  // Stock on each store's floor, so each sale is seen leaving ITS store.
  for (const s of [S1, S2]) {
    expect((await post('/v1/inventory/movements', { movementId: `rcv-${s}`, productId: 'P1', locationId: s, kind: 'received', quantityMinor: 10, unitCostMinor: 9_000, uom: 'ea', occurredAt: AT, enteredBy: OWNER }, `rcv-${s}`)).status).toBeLessThan(300);
  }
}

interface TillPrefixView { storeId: string; tillId: string; prefix: string; version: number; firstNumber: string; lastNumber: string; history: { prefix: string; version: number }[] }

async function headOfficeIssuesPrefixes(cloud: Cloud): Promise<void> {
  const issue = (store: string, till: string, prefix: unknown, key = `pfx-${randomUUID()}`, user = OWNER) =>
    cloud.call('POST', `/v1/stores/${store}/tills/${till}/receipt-prefix`, user, { prefix, reason: 'OB-81 proof' }, key);

  const first = await issue(S1, 'lane-1', 'S1L1-', 'pfx-s1');
  expect(first.status, JSON.stringify(first.body)).toBe(201);
  expect((first.body as { prefix: TillPrefixView }).prefix).toMatchObject({ storeId: S1, tillId: 'lane-1', prefix: 'S1L1-', version: 1, firstNumber: 'S1L1-000001', lastNumber: 'S1L1-999999' });
  expect((await issue(S2, 'lane-1', 'S2L1-', 'pfx-s2')).status).toBe(201);

  // THE CLASH: another till asking for S1's prefix is refused BY NAME — the till and the store that hold it; nothing saved.
  const clash = await issue(S2, 'lane-2', 'S1L1-');
  expect(clash.status).toBe(409);
  expect(codeOf(clash)).toBe('receipt_prefix_taken');
  expect(wordsOf(clash)).toMatch(/till lane-1 at Store One \(S1\)/);
  // The 16-character bound and GST's characters, refused in words; the reserved starts too.
  for (const [bad, words] of [['S2LANE0001-', /at most 10/], ['s2l2-', /capital letters/], ['S2 L2', /capital letters/], ['R-L2-', /R-/], ['ZZ2-', /ZZ/], ['S', /at least 2/], [12, /must be text/]] as const) {
    const r = await issue(S2, 'lane-2', bad);
    expect(r.status, String(bad)).toBe(400);
    expect(codeOf(r)).toBe('receipt_prefix_not_allowed');
    expect(wordsOf(r)).toMatch(words);
  }
  // A cashier holds no setup permission: refused.
  expect((await issue(S1, 'lane-1', 'S1X1-', `pfx-${randomUUID()}`, 'u-cash1')).status).toBe(403);
  // …nor does the store manager, signed in at their own store (they may READ the prefixes): refused by name of the right.
  const mgr = await cloud.call('POST', `/v1/stores/${S1}/tills/lane-1/receipt-prefix`, 'u-mgr1', { prefix: 'S1X1-' }, `pfx-${randomUUID()}`, undefined, S1);
  expect(mgr.status).toBe(403);
  expect(wordsOf(mgr)).toMatch(/platform\.setup\.write/);
  expect((await cloud.call('GET', '/v1/receipt-prefixes', 'u-mgr1', undefined, undefined, undefined, S1)).status).toBe(200);
  // An unknown store: refused by name.
  expect((await issue('S9', 'lane-1', 'S9L1-')).status).toBe(404);

  // REPLAY: the same request again is the same answer; the same prefix under a new key records nothing new.
  const again = await issue(S1, 'lane-1', 'S1L1-', 'pfx-s1');
  expect(again.status).toBe(201);
  expect(again.body).toEqual(first.body);
  const same = await issue(S1, 'lane-1', 'S1L1-');
  expect(same.status).toBe(200);
  expect(same.body).toMatchObject({ unchanged: true, prefix: { version: 1 } });

  const list = (await cloud.call('GET', '/v1/receipt-prefixes', OWNER)).body as { tills: TillPrefixView[]; storesInBusiness: number; multiStore: boolean; rule: { maxNumberLength: number } };
  expect(list).toMatchObject({ storesInBusiness: 2, multiStore: true, rule: { maxNumberLength: 16 } });
  expect(list.tills.map((t) => [t.storeId, t.tillId, t.prefix, t.version])).toEqual([[S1, 'lane-1', 'S1L1-', 1], [S2, 'lane-1', 'S2L1-', 1]]);

  // AUDITED: who issued which prefix to which till.
  const trail = (await cloud.call('GET', '/v1/audit/trail', OWNER, undefined, undefined, { action: 'receipt.prefix.issue' })).body as { matches: { actorId: string; objectId: string; after: { prefix: string } }[] };
  expect(trail.matches.map((m) => [m.actorId, m.objectId, m.after.prefix])).toEqual(expect.arrayContaining([[OWNER, `${S1}/lane-1`, 'S1L1-'], [OWNER, `${S2}/lane-1`, 'S2L1-']]));
  expect(trail.matches.filter((m) => m.objectId === `${S1}/lane-1`)).toHaveLength(1); // the replays recorded nothing
}

/** The two stores' boxes and tills: offline sales, a restart, sync, placement, replay, a changed prefix, an unissued till. */
async function twoStoresTrade(cloud: Cloud): Promise<void> {
  const dirs: string[] = [];
  const edges: EdgeProcess[] = [];
  const saved = globalThis.fetch;
  let cut = false;
  globalThis.fetch = cloud.fetchFor(saved, () => cut);
  const boot = async (user: string, store: string, dir?: string, lane = 'lane-1'): Promise<{ edge: EdgeProcess; dir: string }> => {
    const d = dir ?? await mkdtemp(join(tmpdir(), `sre-ob81-${store}-`));
    if (dir === undefined) {
      dirs.push(d);
      await issueTillPins(d, TEST_PACK_KEY, ['u-cash1', 'u-cash2']);
    }
    const edge = (await startEdge({
      EDGE_DATA_DIR: d, EDGE_TENANT_ID: cloud.tenant, PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_LANE_ID: lane,
      CLOUD_API_URL: cloud.url, CLOUD_API_TOKEN: TEST_IDP.issue({ sub: user, tenantId: cloud.tenant, branchId: store }),
      EDGE_STORE_PACK_SOURCE: 'head-office', EDGE_STORE_ID: store,
    }, () => {}))!;
    edges.push(edge);
    return { edge, dir: d };
  };
  const stop = async (e: EdgeProcess): Promise<void> => { await e.stop(); edges.splice(edges.indexOf(e), 1); };
  // The till page holds ONE signed-in session per page (module state), so each till signs in before its bill — as two
  // cashiers on two tills each do on their own page.
  const till = (edge: EdgeProcess, cashier: string, lane = 'lane-1') =>
    Object.assign(bootPos({ laneId: lane, taxPercent: 0, lanePort: edge.lane!.port }), { cashier });
  /** One bill: the box gives the number, the till derives its sale id `S-<number>` and prints the number. */
  const ring = async (t: ReturnType<typeof till>): Promise<{ number: string; printed: string }> => {
    await signInTill(t, t.cashier);
    const number = await t.nextReceipt();
    t.scan({ productId: 'P1', description: 'Toor dal 1kg', unitPriceMinor: 12_000, qty: 1 });
    const printed = await t.tenderCash(`S-${number}`, number, new Date().toISOString());
    t.newSale();
    return { number, printed };
  };
  const onDisk = async (edge: EdgeProcess) => (await readLog(edge.log.path)).flatMap((r) => (r.ok ? [JSON.parse(r.record) as { id: string; number: string }] : []));
  try {
    // Online: each box takes ITS setup from head office — its till's prefix and the number of stores, signed.
    const one = await boot('u-box-1', S1);
    const two = await boot('u-box-2', S2);
    expect(await one.edge.refreshStorePack!()).toMatchObject({ status: 'updated' });
    expect(await two.edge.refreshStorePack!()).toMatchObject({ status: 'updated' });

    // OFFLINE: head office unreachable; both lane-1 tills sell.
    cut = true;
    const t1 = till(one.edge, 'u-cash1');
    const t2 = till(two.edge, 'u-cash2');
    const a = await ring(t1);
    const b = await ring(t2);
    expect(a).toEqual({ number: 'S1L1-000001', printed: 'S1L1-000001' });
    expect(b).toEqual({ number: 'S2L1-000001', printed: 'S2L1-000001' });
    expect(a.number).not.toBe(b.number);
    expect(`S-${a.number}`).not.toBe(`S-${b.number}`);
    for (const n of [a.number, b.number]) expect(n.length).toBeLessThanOrEqual(GST_INVOICE_NUMBER_MAX);

    // RESTART, still offline: box 1 comes back on the setup it holds and carries its count on from its disk.
    await stop(one.edge);
    const oneAgain = await boot('u-box-1', S1, one.dir);
    const t1b = till(oneAgain.edge, 'u-cash1');
    const c = await ring(t1b);
    expect(c.number).toBe('S1L1-000002');
    expect((await onDisk(oneAgain.edge)).map((s) => [s.id, s.number])).toEqual([['S-S1L1-000001', 'S1L1-000001'], ['S-S1L1-000002', 'S1L1-000002']]);
    expect((await onDisk(two.edge)).map((s) => [s.id, s.number])).toEqual([['S-S2L1-000001', 'S2L1-000001']]);

    // BACK ONLINE: both sync; every sale banked once, at its own store.
    cut = false;
    expect(await oneAgain.edge.syncOnce!()).toMatchObject({ sent: 2, dead: 0 });
    expect(await two.edge.syncOnce!()).toMatchObject({ sent: 1, dead: 0 });
    for (const id of ['S-S1L1-000001', 'S-S1L1-000002', 'S-S2L1-000001']) expect((await cloud.call('GET', `/v1/sales/${id}`, OWNER)).status).toBe(200);
    const stock = ((await cloud.call('GET', '/v1/inventory/availability', OWNER, undefined, undefined, { productId: 'P1' })).body as { rows: { locationId: string; onHandMinor: number }[] }).rows;
    expect(stock.find((r) => r.locationId === S1)?.onHandMinor).toBe(8);
    expect(stock.find((r) => r.locationId === S2)?.onHandMinor).toBe(9);
    // REPLAY: a second pass sends nothing; the same sale re-sent by its box is the same one sale, not a second.
    expect(await two.edge.syncOnce!()).toMatchObject({ sent: 0, dead: 0 });
    const replay = await cloud.call('POST', '/v1/sales', 'u-box-2', {
      saleId: 'S-S2L1-000001', receiptNumber: 'S2L1-000001', laneId: 'lane-1', locationId: S2, cashierId: 'u-cash2', tradingDay: AT.slice(0, 10), committedAt: AT,
      totalMinor: 12_000, currency: 'INR', packVersion: 0, lines: [{ productId: 'P1', quantityMinor: 1, uom: 'ea', unitPriceMinor: 12_000, lineTotalMinor: 12_000 }], tenders: [{ kind: 'cash', amountMinor: 12_000 }],
    }, `replay-${randomUUID()}`, undefined, S2);
    expect(replay.status).toBe(202);
    expect(replay.body).toMatchObject({ alreadyBanked: true });
    expect(((await cloud.call('GET', '/v1/inventory/availability', OWNER, undefined, undefined, { productId: 'P1' })).body as { rows: { locationId: string; onHandMinor: number }[] }).rows.find((r) => r.locationId === S2)?.onHandMinor).toBe(9);

    // A CHANGED prefix: version 2, a new series on the next pull; the old prefix stays this till's — refused elsewhere.
    const changed = await cloud.call('POST', `/v1/stores/${S1}/tills/lane-1/receipt-prefix`, OWNER, { prefix: 'S1A1-', reason: 'new counter' }, 'pfx-s1-v2');
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ prefix: { prefix: 'S1A1-', version: 2, history: [{ prefix: 'S1L1-', version: 1 }, { prefix: 'S1A1-', version: 2 }] } });
    const reuse = await cloud.call('POST', `/v1/stores/${S2}/tills/lane-3/receipt-prefix`, OWNER, { prefix: 'S1L1-' }, `pfx-${randomUUID()}`);
    expect(codeOf(reuse)).toBe('receipt_prefix_taken');
    expect(await oneAgain.edge.refreshStorePack!()).toMatchObject({ status: 'updated' });
    expect((await ring(t1b)).number).toBe('S1A1-000001');

    // A TILL WITH NO ISSUED PREFIX, two stores: it still sells offline — under its box's store-qualified default — and head
    // office flags the sale and the registered till.
    expect((await cloud.call('POST', '/v1/platform/devices/lane-2/register', OWNER, { branchId: S2, kind: 'pos_lane', label: 'Store Two lane 2' }, 'reg-lane-2')).status).toBe(201);
    const lane2 = await boot('u-box-2', S2, undefined, 'lane-2');
    await lane2.edge.refreshStorePack!();
    cut = true;
    const t3 = till(lane2.edge, 'u-cash2', 'lane-2');
    const d = await ring(t3);
    // OB-85: the store-coded fallback, worked out from S2, lane-2 and this box's own identity (never another box's).
    expect(d.number).toMatch(/^ZZ[A-Z2-7]{6}-000001$/);
    expect(d.number).not.toBe(`${storeComputerDefaultPrefix(S2, 'lane-2')}000001`);
    expect(d.number.length).toBeLessThanOrEqual(GST_INVOICE_NUMBER_MAX);
    expect(t3.receiptNotice()).toMatch(/has not issued this till its bill-number prefix/);
    cut = false;
    expect(await lane2.edge.syncOnce!()).toMatchObject({ sent: 1, dead: 0 });
    const exceptions = ((await cloud.call('GET', '/v1/sales/exceptions', OWNER)).body as { material: { kind: string; saleId: string }[] }).material;
    expect(exceptions).toContainEqual(expect.objectContaining({ kind: 'receipt_numbered_without_issued_prefix', saleId: `S-${d.number}` }));
    const listed = (await cloud.call('GET', '/v1/receipt-prefixes', OWNER)).body as { needsPrefix: { storeId: string; tillId: string; flagged: boolean }[] };
    expect(listed.needsPrefix).toContainEqual(expect.objectContaining({ storeId: S2, tillId: 'lane-2', flagged: true }));
  } finally {
    for (const e of edges.splice(0)) await e.stop();
    globalThis.fetch = saved;
    for (const dd of dirs) await rm(dd, { recursive: true, force: true });
  }
}

describe('OB-81 — bill numbers unique across stores (real API in memory, real boxes and tills)', () => {
  const tenant = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0b81';
  let h: ApiHarness;
  let cloud: Cloud;
  beforeAll(async () => {
    h = apiHarness();
    await h.seedOwner(tenant, OWNER);
    cloud = {
      tenant, url: 'https://cloud.example.test',
      call: (method, path, user, body, key, query, branchId) => h.raw({
        method, path, token: TEST_IDP.issue({ sub: user, tenantId: tenant, ...(branchId === undefined ? {} : { branchId }) }),
        ...(body === undefined ? {} : { body }), ...(key === undefined ? {} : { idempotencyKey: key }), ...(query === undefined ? {} : { query }),
      }),
      grant: (user, role, scope) => h.provisionRole(tenant, user, role, scope),
      fetchFor: (saved, isCut) => (async (url: string, init: RequestInit = {}): Promise<Response> => {
        if (String(url).startsWith('http://127.0.0.1:')) return saved(url, init);
        if (isCut()) throw new Error('network down');
        const hdr = (init.headers ?? {}) as Record<string, string>;
        const u = new URL(url);
        const res = await h.raw({
          method: (init.method ?? 'GET') as HttpRequest['method'], path: u.pathname, query: Object.fromEntries(u.searchParams),
          token: hdr['authorization']?.replace(/^Bearer /, ''), idempotencyKey: hdr['idempotency-key'],
          body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
        });
        return new Response(JSON.stringify(res.body), { status: res.status });
      }) as unknown as typeof globalThis.fetch,
    };
    await headOfficeSetUp(cloud);
  });
  it('head office issues each (store, till) a prefix: versioned, audited, clash refused by name, ≤ 16 characters, replay idempotent', async () => { await headOfficeIssuesPrefixes(cloud); });
  it('two stores\' lane-1 tills sell offline with distinct numbers and sale ids; restart keeps the count; sync banks each at its own store', async () => { await twoStoresTrade(cloud); }, 60_000);
});

describe('OB-81 · OB-85 — a single-store business keeps its numbering where it has history; a second store moves an unissued till off it', () => {
  it('one store with R-lane-1- history: the box resumes above head office\'s banked count; a REPLACED box resumes above it too; a second store: the store-coded fallback', async () => {
    const tenant = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa1b81';
    const h = apiHarness();
    await h.seedOwner(tenant, OWNER);
    const call = (method: HttpRequest['method'], path: string, body?: unknown, user = OWNER, branchId?: string) => h.raw({ method, path, token: TEST_IDP.issue({ sub: user, tenantId: tenant, ...(branchId === undefined ? {} : { branchId }) }), ...(body === undefined ? {} : { body, idempotencyKey: `k-${randomUUID()}` }) });
    expect((await call('POST', '/v1/org/nodes/C1', { kind: 'company', name: 'SRE Retail' })).status).toBe(201);
    expect((await call('POST', `/v1/org/nodes/${S1}`, { kind: 'branch', name: 'Store One', parentId: 'C1', companyId: 'C1' })).status).toBe(201);
    expect((await call('POST', `/v1/stores/${S1}/settings`, SETTINGS)).status).toBe(201);
    await h.provisionRole(tenant, 'u-box-1', 'store_computer', [S1]);
    await h.provisionRole(tenant, 'u-cash1', 'cashier', [S1]);
    // The pilot's history: head office already holds store 1's bill R-lane-1-000041 (its box numbered R-<lane>- for months).
    const old = await call('POST', '/v1/sales', {
      saleId: 'S-R-lane-1-000041', receiptNumber: 'R-lane-1-000041', laneId: 'lane-1', locationId: S1, cashierId: 'u-cash1', tradingDay: AT.slice(0, 10), committedAt: AT,
      totalMinor: 12_000, currency: 'INR', packVersion: 0, lines: [{ productId: 'P1', quantityMinor: 1, uom: 'ea', unitPriceMinor: 12_000, lineTotalMinor: 12_000 }], tenders: [{ kind: 'cash', amountMinor: 12_000 }],
    }, 'u-box-1', S1);
    expect(old.status, JSON.stringify(old.body)).toBe(202);
    const saved = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit = {}): Promise<Response> => {
      if (String(url).startsWith('http://127.0.0.1:')) return saved(url, init);
      const hdr = (init.headers ?? {}) as Record<string, string>;
      const res = await h.raw({ method: (init.method ?? 'GET') as HttpRequest['method'], path: new URL(url).pathname, token: hdr['authorization']?.replace(/^Bearer /, ''), idempotencyKey: hdr['idempotency-key'], body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown });
      return new Response(JSON.stringify(res.body), { status: res.status });
    }) as unknown as typeof globalThis.fetch;
    const dirs: string[] = [];
    const boot = async () => {
      const dir = await mkdtemp(join(tmpdir(), 'sre-ob81-single-'));
      dirs.push(dir);
      await issueTillPins(dir, TEST_PACK_KEY, ['u-cash1']);
      return (await startEdge({
        EDGE_DATA_DIR: dir, EDGE_TENANT_ID: tenant, PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1',
        CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box-1', tenantId: tenant, branchId: S1 }), EDGE_STORE_PACK_SOURCE: 'head-office', EDGE_STORE_ID: S1,
      }, () => {}))!;
    };
    const sell = async (t: ReturnType<typeof bootPos>): Promise<string> => {
      const n = await t.nextReceipt();
      t.scan({ productId: 'P1', description: 'Toor dal 1kg', unitPriceMinor: 12_000, qty: 1 });
      await t.tenderCash(`S-${n}`, n, new Date().toISOString());
      t.newSale();
      return n;
    };
    let edge = await boot();
    try {
      await edge.refreshStorePack!();
      let t = bootPos({ laneId: 'lane-1', taxPercent: 0, lanePort: edge.lane!.port });
      await signInTill(t, 'u-cash1');
      // Head office says ONE store and that R-lane-1- was banked through 41: the box carries the numbering on, above it.
      expect(await sell(t)).toBe('R-lane-1-000042');
      expect(await sell(t)).toBe('R-lane-1-000043');
      expect(await edge.syncOnce!()).toMatchObject({ sent: 2, dead: 0 });
      // THE REPLACED BOX (its disk lost): a new box for the same till, first pull — it resumes above head office's 43.
      await edge.stop();
      edge = await boot();
      await edge.refreshStorePack!();
      t = bootPos({ laneId: 'lane-1', taxPercent: 0, lanePort: edge.lane!.port });
      await signInTill(t, 'u-cash1');
      expect(await sell(t)).toBe('R-lane-1-000044');
      expect(await edge.syncOnce!()).toMatchObject({ sent: 1, dead: 0 });
      // No bill number was given twice: no "receipt reused" finding at head office.
      const findings = ((await call('GET', '/v1/sales/exceptions')).body as { material: { kind: string }[] }).material;
      expect(findings.filter((f) => f.kind === 'receipt_number_reused')).toEqual([]);
      // The registered-till list says the till has none — not flagged while there is one store.
      expect((await call('POST', '/v1/platform/devices/lane-1/register', { branchId: S1, kind: 'pos_lane', label: 'Lane 1' })).status).toBe(201);
      expect(((await call('GET', '/v1/receipt-prefixes')).body as { needsPrefix: unknown[] }).needsPrefix).toEqual([expect.objectContaining({ storeId: S1, tillId: 'lane-1', flagged: false })]);
      // A second store opens: the next pull moves the till onto its box's store-coded fallback.
      expect((await call('POST', `/v1/org/nodes/${S2}`, { kind: 'branch', name: 'Store Two', parentId: 'C1', companyId: 'C1' })).status).toBe(201);
      await edge.refreshStorePack!();
      expect(await t.nextReceipt()).toMatch(/^ZZ[A-Z2-7]{6}-000001$/);
      expect(t.receiptNotice()).toMatch(/more than one store/);
      expect(((await call('GET', '/v1/receipt-prefixes')).body as { needsPrefix: unknown[] }).needsPrefix).toEqual([expect.objectContaining({ storeId: S1, tillId: 'lane-1', flagged: true })]);
      // Head office issues the prefix: the next pull numbers under it.
      expect((await call('POST', `/v1/stores/${S1}/tills/lane-1/receipt-prefix`, { prefix: 'S1L1-' })).status).toBe(201);
      await edge.refreshStorePack!();
      expect(await t.nextReceipt()).toBe('S1L1-000001');
    } finally {
      await edge.stop();
      globalThis.fetch = saved;
      for (const d of dirs) await rm(d, { recursive: true, force: true });
    }
  }, 60_000);
});
// ── On real PostgreSQL, through the production API assembly over HTTP ───────────────────────────────────────────────
const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(DATABASE_URL === undefined)('OB-81 — on real PostgreSQL: two stores, two real boxes, two tills', () => {
  let real: RealCloud;
  let cloud: Cloud;
  beforeAll(async () => {
    real = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId: randomUUID(), owner: OWNER, packSigningKey: TEST_PACK_KEY });
    const send = async (method: HttpRequest['method'], path: string, token: string, body?: unknown, key?: string, query?: Record<string, string>): Promise<Reply> => {
      const qs = query === undefined ? '' : `?${new URLSearchParams(query).toString()}`;
      const res = await fetch(`${real.baseUrl}${path}${qs}`, {
        method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(key === undefined ? {} : { 'idempotency-key': key }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return { status: res.status, body: text === '' ? null : JSON.parse(text) as unknown };
    };
    cloud = {
      tenant: real.tenantId, url: real.baseUrl,
      call: (method, path, user, body, key, query, branchId) => send(method, path, TEST_IDP.issue({ sub: user, tenantId: real.tenantId, ...(branchId === undefined ? {} : { branchId }) }), body, key, query),
      grant: (user, role, scope) => real.grant(user, role, undefined, scope),
      fetchFor: (saved, isCut) => (async (url: string, init?: RequestInit): Promise<Response> => {
        if (String(url).startsWith(real.baseUrl) && isCut()) throw new Error('network down');
        return saved(url, init);
      }) as unknown as typeof globalThis.fetch,
    };
    await headOfficeSetUp(cloud);
  }, 120_000);
  afterAll(async () => { await real?.stop(); });
  it('head office issues each (store, till) a prefix: versioned, audited, clash refused by name, ≤ 16 characters, replay idempotent', async () => { await headOfficeIssuesPrefixes(cloud); }, 60_000);
  it('two stores\' lane-1 tills sell offline with distinct numbers and sale ids; restart keeps the count; sync banks each at its own store', async () => { await twoStoresTrade(cloud); }, 120_000);
  it('after an API restart head office still holds every till\'s prefix and its history (PostgreSQL)', async () => {
    const tenantId = real.tenantId;
    await real.stop();
    real = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId, owner: OWNER, packSigningKey: TEST_PACK_KEY });
    const tills = ((await cloud.call('GET', '/v1/receipt-prefixes', OWNER)).body as { tills: TillPrefixView[] }).tills;
    expect(tills.map((t) => [t.storeId, t.tillId, t.prefix, t.version])).toEqual([[S1, 'lane-1', 'S1A1-', 2], [S2, 'lane-1', 'S2L1-', 1]]);
    expect(tills[0]!.history.map((x) => x.prefix)).toEqual(['S1L1-', 'S1A1-']);
    // …and still refuses the retired prefix to any other till.
    expect(codeOf(await cloud.call('POST', `/v1/stores/${S2}/tills/lane-4/receipt-prefix`, OWNER, { prefix: 'S1L1-' }, `pfx-${randomUUID()}`))).toBe('receipt_prefix_taken');
  }, 120_000);
});
