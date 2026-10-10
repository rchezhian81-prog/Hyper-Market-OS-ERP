import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { makeEvent } from '../../packages/contracts/src/event';
import type { BoxItemStatus, DeviceAck } from '../../packages/sync/src/device-relay';

// M04-FR-02/03 shelf counting on the live API — the producer planogram compliance always needed. A count
// is a blind observation (the counter is the authenticated user, no expected quantity is accepted or
// returned), append-only, and the reads report how stale each facing is and which need counting worst
// first (never-counted before long-ago). Recording gated shelf.count.record; reads shelf.count.read.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STORE = 'BR1';
const KNOWN = ['loc1', 'loc2'];

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const record = (h: ApiHarness, u: string, countId: string, body: Record<string, unknown>, key: string) =>
  h.request({ method: 'POST', path: `/v1/merchandising/shelf-counts/${countId}`, userId: u, tenantId: A, idempotencyKey: key, body });
const latest = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/merchandising/shelf-counts', userId: u, tenantId: A, query: { storeId: STORE } });
const worklist = (h: ApiHarness, u: string, planned: unknown[], key: string) =>
  h.request({ method: 'POST', path: '/v1/merchandising/shelf-counts/worklist', userId: u, tenantId: A, idempotencyKey: key, body: { storeId: STORE, planned } });

const cnt = (over: Record<string, unknown> = {}) =>
  ({ storeId: STORE, locationId: 'loc1', productId: 'p1', countedMinor: 5, knownLocationIds: KNOWN, ...over });

type Latest = { latest: { productId: string; locationId: string; countedMinor: number; countedBy: string }[]; ages: { productId: string; stale: boolean }[] };

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // shelf.count.record + read
  await h.provisionRole(A, 'u-cash', 'cashier');       // neither
  return h;
}

describe('shelf counting: blind, append-only, staleness-aware (M04-FR-02/03)', () => {
  it('records a blind count signed by the user, and reads it back fresh with no expected quantity', async () => {
    const h = await cast();
    const res = await record(h, 'u-mgr', 'c1', cnt({ countedMinor: 7 }), 'k1');
    expect(res.status).toBe(201);
    // The count carries the counter (from login) and NOT any expected quantity.
    const count = (res.body as { count: Record<string, unknown> }).count;
    expect(count).toMatchObject({ productId: 'p1', locationId: 'loc1', countedMinor: 7, countedBy: 'u-mgr' });
    expect(Object.keys(count)).not.toContain('expectedMinor');

    const l = (await latest(h, 'u-owner')).body as Latest;
    expect(l.latest.find((c) => c.productId === 'p1')?.countedMinor).toBe(7);
    expect(l.ages.find((a) => a.productId === 'p1')?.stale).toBe(false); // just counted → fresh
  });

  it('refuses a negative count and a count against a shelf the shop does not have', async () => {
    const h = await cast();
    expect(codeOf(await record(h, 'u-mgr', 'c1', cnt({ countedMinor: -3 }), 'k1'))).toBe('a_negative_count_is_not_a_count');
    expect(codeOf(await record(h, 'u-mgr', 'c2', cnt({ locationId: 'ghost' }), 'k2'))).toBe('this_shop_has_no_such_shelf');
    // A missing count or store is not readable at all.
    expect(codeOf(await record(h, 'u-mgr', 'c3', { storeId: STORE, locationId: 'loc1', productId: 'p1', knownLocationIds: KNOWN }, 'k3'))).toBe('not_readable_as_a_shelf_count');
  });

  it('the worklist puts a never-counted facing first and leaves a freshly-counted one off', async () => {
    const h = await cast();
    await record(h, 'u-mgr', 'c1', cnt({ productId: 'p1', locationId: 'loc1', countedMinor: 4 }), 'k1');
    // Two facings are planned; only (p1,loc1) has been counted (and it is fresh).
    const wl = (await worklist(h, 'u-owner', [
      { productId: 'p1', locationId: 'loc1' },
      { productId: 'p2', locationId: 'loc2' },
    ], 'k2')).body as { worklist: { productId: string; lastCountedAt: string | null; stale: boolean }[]; count: number };
    // Only the never-counted facing needs work; the fresh one is not on the list.
    expect(wl.worklist.map((w) => w.productId)).toEqual(['p2']);
    expect(wl.worklist[0]).toMatchObject({ lastCountedAt: null, stale: true });
  });

  it('gates recording and reading, and survives a restart (counts rebuild from the event store)', async () => {
    const h = await cast();
    // A cashier can neither record nor read shelf counts.
    expect((await record(h, 'u-cash', 'c1', cnt(), 'k1')).status).toBe(403);
    expect((await latest(h, 'u-cash')).status).toBe(403);
    await record(h, 'u-mgr', 'c1', cnt({ countedMinor: 9 }), 'k2');

    const restarted = apiHarness({ store: h.store });
    const l = (await latest(restarted, 'u-owner')).body as Latest;
    expect(l.latest.find((c) => c.productId === 'p1')?.countedMinor).toBe(9);
  });
});

// ── SP-8c-ii (F08): the count the merchandising screen takes, RELAYED through the store box ───────────────────────────
//
// Before SP-8c-ii the screen's count changed the page and nothing else. Now it is on the DURABLE device queue before the
// screen says saved, handed to the box, and relayed HERE under the store's sync credential. These prove the cloud half
// on the REAL API with REAL RBAC, then the whole path against the REAL box (`startEdge`) and the REAL cloud (the harness
// behind a `fetch` the test can cut or make lose a reply). Synthetic data only (hard rule #7).

const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AT = '2026-10-01T09:30:00.000Z';
const BACK = 'BR1-BACK';
const KEY = ['shelf', 'count', 'edge', 'signing', 'key'].join('-').padEnd(48, '0');
const PACK_JSON = JSON.stringify({ version: 1, policies: { tradingDayCutoff: '02:00', storeId: STORE, branchId: STORE, warehouseId: BACK }, lossPreventionRules: [] });

type Body = Record<string, unknown>;
const syncedCount = (h: ApiHarness, u: string, countId: string, body: Body, key?: string, t = A) =>
  h.request({ method: 'POST', path: `/v1/merchandising/shelf-counts/${countId}/synced`, userId: u, tenantId: t, idempotencyKey: key ?? `sync-${countId}`, body });
/** What the merchandising screen queues (apps/web-erp/src/merchandising-session.ts). */
const countPayload = (countId: string, over: Body = {}): Body => ({
  countId, storeId: STORE, locationId: 'loc1', productId: 'p1', countedMinor: 6, countedBy: 'u-mgr', at: AT, knownLocationIds: KNOWN, source: 'merchandising-screen', ...over,
});
interface StoredCount { countId?: string; countedBy: string; countedMinor: number; locationId: string; productId: string; governanceFlags?: string[]; relayed?: Record<string, unknown> }
const latestOf = async (h: ApiHarness, u = 'u-owner', t = A) => ((await h.request({ method: 'GET', path: '/v1/merchandising/shelf-counts', userId: u, tenantId: t, query: { storeId: STORE } })).body as { latest: StoredCount[] }).latest;

async function castForSync(): Promise<ApiHarness> {
  const h = await cast();
  await h.seedOwner(B, 'u-owner-b');
  await h.provisionRole(A, 'u-box', 'store_computer');     // the store computer's sync identity holds the hop
  await h.provisionRole(A, 'u-acct', 'accountant'); // holds no shelf.count.record
  return h;
}

describe('a relayed shelf count: the FACT from the device, the JUDGEMENT and the counter\'s authority re-run here (SP-8c-ii · F08 · §28 · §31)', () => {
  it('only the sync identity relays; a good count is recorded ONCE in the counter\'s name with the relay beside it, said to be judged against the device\'s shelves, and is 200 the second time', async () => {
    const h = await castForSync();
    // A store manager posting "on behalf of" and an accountant are refused the hop — only the box identity (and the owner) relay.
    expect(codeOf(await syncedCount(h, 'u-mgr', 'c-s1', countPayload('c-s1')))).toBe('forbidden');
    expect(codeOf(await syncedCount(h, 'u-acct', 'c-s1', countPayload('c-s1')))).toBe('forbidden');

    const r = await syncedCount(h, 'u-box', 'c-s1', countPayload('c-s1'));
    expect(r.status).toBe(202);
    // Head office keeps no shelf map for BR1 yet, so the device's list judged the shelf — said on the record, not hidden.
    expect(r.body).toMatchObject({ countId: 'c-s1', recorded: true, alreadyRecorded: false, flags: ['shelves_from_device'] });
    expect((r.body as { count: StoredCount }).count).toMatchObject({ countId: 'c-s1', countedBy: 'u-mgr', countedMinor: 6, governanceFlags: ['shelves_from_device'], relayed: { relayedBy: 'u-box', source: 'merchandising-screen', storeId: STORE } });
    expect(Object.keys((r.body as { count: object }).count)).not.toContain('expectedMinor');
    // The same count again — a re-sent queue item — is the same observation (200), not a second row.
    expect((await syncedCount(h, 'u-box', 'c-s1', countPayload('c-s1'), 'sync-c-s1-again')).body).toMatchObject({ alreadyRecorded: true, flags: ['shelves_from_device'] });
    const latest = await latestOf(h);
    expect(latest.filter((c) => c.productId === 'p1')).toHaveLength(1);
    expect(latest.find((c) => c.productId === 'p1')).toMatchObject({ countedMinor: 6, countedBy: 'u-mgr', relayed: { relayedBy: 'u-box' } });
    // The other tenant sees nothing of it.
    expect(await latestOf(h, 'u-owner-b', B)).toEqual([]);
  });

  it('the COUNTER is verified from THEIR grants and a breach is flagged, never silently trusted; the engine\'s refusals are 4xx with nothing saved; a payload that is not a shelf count is 400', async () => {
    const h = await castForSync();
    const lacking = await syncedCount(h, 'u-box', 'c-s2', countPayload('c-s2', { countedBy: 'u-acct' }));
    expect(lacking.status).toBe(202);
    expect(lacking.body).toMatchObject({ flags: ['shelves_from_device', 'counter_lacks_authority'] });
    // A second facing, so both observations show in the latest-per-facing read below.
    const ghost = await syncedCount(h, 'u-box', 'c-s3', countPayload('c-s3', { countedBy: 'u-nobody', productId: 'p2' }));
    expect(ghost.body).toMatchObject({ flags: ['shelves_from_device', 'counter_unknown'] });

    expect(codeOf(await syncedCount(h, 'u-box', 'c-s4', countPayload('c-s4', { countedMinor: -1 })))).toBe('a_negative_count_is_not_a_count');
    expect(codeOf(await syncedCount(h, 'u-box', 'c-s5', countPayload('c-s5', { locationId: 'ghost' })))).toBe('this_shop_has_no_such_shelf');
    expect(codeOf(await syncedCount(h, 'u-box', 'c-s6', countPayload('c-other')))).toBe('not_readable_as_a_relayed_shelf_count');
    expect(codeOf(await syncedCount(h, 'u-box', 'c-s7', { countId: 'c-s7', storeId: STORE }))).toBe('not_readable_as_a_relayed_shelf_count');
    expect((await latestOf(h)).map((c) => c.countId).sort()).toEqual(['c-s2', 'c-s3']);
  });

  it('once head office has PUBLISHED the store\'s shelf map, a relayed count is judged against THAT — the device\'s list no longer decides, and a shelf head office does not have is refused', async () => {
    const h = await castForSync();
    const published = await h.request({
      method: 'PUT', path: `/v1/merchandising/stores/${STORE}/shelf-map`, userId: 'u-mgr', tenantId: A, idempotencyKey: 'map-1',
      body: { locations: [{ locationId: 'loc1', aisle: 1, rack: 1, bay: 1, shelf: 1, position: 1 }] },
    });
    expect(published.status).toBeLessThan(300);
    // The device believes loc2 exists; head office does not. Head office's map wins — and the refusal is the engine's own.
    expect(codeOf(await syncedCount(h, 'u-box', 'c-m1', countPayload('c-m1', { locationId: 'loc2', knownLocationIds: ['loc1', 'loc2'] })))).toBe('this_shop_has_no_such_shelf');
    const ok = await syncedCount(h, 'u-box', 'c-m2', countPayload('c-m2', { locationId: 'loc1', knownLocationIds: [] }));
    expect(ok.status).toBe(202);
    expect(ok.body).toMatchObject({ flags: [] }); // judged against head office's own shelves: nothing to say
  });
});

// ── through the REAL box ─────────────────────────────────────────────────────────────────────────────────────────

const cleanups: Array<() => Promise<void>> = [];
const savedFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = savedFetch;
  for (const c of cleanups.splice(0).reverse()) await c();
});

const countEvent = (countId: string, over: Body = {}) => makeEvent({
  id: `shelf-count:${countId}`, type: 'ShelfCounted', occurredAt: AT, idempotencyKey: `shelf-count:${countId}`, source: 'web-erp/merchandising', payload: countPayload(countId, over),
});
/** The refill tasks' ask as the merchandising screen raises it through the Indents session (SP-8c-ii). */
const refillAskEvent = (indentId: string) => makeEvent({
  id: `indent:${indentId}`, type: 'FloorIndentRequested', occurredAt: AT, idempotencyKey: `indent:${indentId}`, source: 'web-erp/indents',
  payload: { indentId, fromLocationId: BACK, toLocationId: STORE, lines: [{ productId: 'p1', quantityMinor: 24, uom: 'EA' }], reason: 'shelf refill · A1', requestedBy: 'u-mgr', at: AT, storeId: STORE, source: 'indents-screen' },
});
const postBatch = async (edge: EdgeProcess, items: unknown[]): Promise<{ status: number; acks: DeviceAck[] }> => {
  const res = await savedFetch(`http://127.0.0.1:${edge.lane!.port}/lane/outbox`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:8091' }, body: JSON.stringify({ source: 'manager', items }),
  });
  return { status: res.status, acks: ((await res.json()) as { acks: DeviceAck[] }).acks };
};
const statusOf = async (edge: EdgeProcess, keys: string[]): Promise<BoxItemStatus[]> => {
  const res = await savedFetch(`http://127.0.0.1:${edge.lane!.port}/lane/outbox/status?keys=${encodeURIComponent(keys.join(','))}`);
  return ((await res.json()) as { items: BoxItemStatus[] }).items;
};

/** The real cloud behind a controllable `fetch`, and a real box pointed at it under the store's sync credential. */
async function cloudAndBox(): Promise<{ h: ApiHarness; start: () => Promise<EdgeProcess>; loseNextReply: () => void; posts: () => number }> {
  const h = await castForSync();
  // The places the refill ask names, so head office knows them (the indent route refuses an unknown place).
  const node = (id: string, body: Body) => h.request({ method: 'POST', path: `/v1/org/nodes/${id}`, userId: 'u-owner', tenantId: A, idempotencyKey: `org-${id}`, body });
  expect((await node('C1', { kind: 'company', name: 'SRE Retail' })).status).toBe(201);
  expect((await node(STORE, { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' })).status).toBe(201);
  expect((await node(BACK, { kind: 'warehouse', name: 'Store 1 back store', parentId: STORE, companyId: 'C1' })).status).toBe(201);

  const dir = await mkdtemp(join(tmpdir(), 'sre-shelf-count-edge-'));
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); });
  const packFile = join(dir, 'store-pack.json');
  await writeFile(packFile, PACK_JSON, 'utf8');

  let lose = false;
  let posts = 0;
  globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
    if (url.startsWith('http://127.0.0.1:')) return savedFetch(url, init);
    const hdr = (init.headers ?? {}) as Record<string, string>;
    const path = new URL(url).pathname;
    if ((path.startsWith('/v1/merchandising/') || path.startsWith('/v1/floor/')) && (init.method ?? 'GET') === 'POST') posts += 1;
    const res = await h.raw({
      method: (init.method ?? 'GET') as HttpRequest['method'], path,
      token: hdr['authorization']?.replace(/^Bearer /, ''), idempotencyKey: hdr['idempotency-key'],
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
    });
    if (lose) { lose = false; throw new Error('ECONNRESET'); } // the cloud acted; the reply never arrived
    return new Response(JSON.stringify(res.body), { status: res.status });
  }) as unknown as typeof globalThis.fetch;

  const start = async (): Promise<EdgeProcess> => {
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: A, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
      CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: A }), EDGE_PACK_FILE: packFile,
    }, () => {}))!;
    cleanups.push(async () => { await edge.stop(); });
    return edge;
  };
  return { h, start, loseNextReply: () => { lose = true; }, posts: () => posts };
}

describe('the shelf count and the refill ask: device → box (durable) → head office (once), on the manager\'s own path (SP-8c-ii · F08 · §31)', () => {
  it('a count is on the box before the device hears accepted, becomes head office\'s observation in one pass naming the counter and the relay, a lost reply settles to ONE on the retry, and a re-sent item is duplicate before and after a restart', async () => {
    const c = await cloudAndBox();
    const first = await c.start();
    const e = countEvent('c-b1');
    const { status, acks } = await postBatch(first, [{ key: e.idempotencyKey, event: e }]);
    expect(status).toBe(200);
    expect(acks).toEqual([{ key: 'shelf-count:c-b1', status: 'accepted' }]);
    expect((await statusOf(first, ['shelf-count:c-b1']))[0]).toMatchObject({ state: 'pending' });
    expect(await latestOf(c.h)).toEqual([]); // nothing at head office yet — the box has it

    c.loseNextReply();
    const cut = await first.syncOnce!();
    expect(cut.sent).toBe(0); // the box heard nothing back — it keeps the item and tries again
    const pass = await first.syncOnce!();
    expect([pass.sent, pass.dead]).toEqual([1, 0]);
    const latest = await latestOf(c.h);
    expect(latest).toHaveLength(1);
    expect(latest[0]).toMatchObject({ countId: 'c-b1', countedBy: 'u-mgr', countedMinor: 6, relayed: { relayedBy: 'u-box', source: 'merchandising-screen', storeId: STORE } });
    expect((await statusOf(first, ['shelf-count:c-b1']))[0]?.state).toBe('posted');
    expect(c.posts()).toBe(2); // the cloud acted twice; it holds ONE observation

    expect((await postBatch(first, [{ key: e.idempotencyKey, event: e }])).acks).toEqual([{ key: 'shelf-count:c-b1', status: 'duplicate' }]);
    await first.stop();
    cleanups.pop();
    const second = await c.start();
    expect((await postBatch(second, [{ key: e.idempotencyKey, event: e }])).acks).toEqual([{ key: 'shelf-count:c-b1', status: 'duplicate' }]);
    await second.syncOnce!();
    expect(await latestOf(c.h)).toHaveLength(1);
  });

  it('a count head office refuses is a visible dead-letter on the box with the code in its reason, saved nothing, and survives a restart; the refill ask from the same screen rides the same path to the indent register', async () => {
    const c = await cloudAndBox();
    const edge = await c.start();
    const bad = countEvent('c-b2', { countedMinor: -4 });
    const ask = refillAskEvent('ind-refill-2026-10-01-0a1b2c3d');
    await postBatch(edge, [{ key: bad.idempotencyKey, event: bad }, { key: ask.idempotencyKey, event: ask }]);
    const pass = await edge.syncOnce!();
    expect([pass.sent, pass.dead]).toEqual([1, 1]);
    expect((await statusOf(edge, ['shelf-count:c-b2']))[0]).toMatchObject({ state: 'refused' });
    expect((await statusOf(edge, ['shelf-count:c-b2']))[0]?.reason).toContain('a_negative_count_is_not_a_count');
    expect(await latestOf(c.h)).toEqual([]);
    // The ask is on head office's register in the merchandiser's name, awaiting a different person, with the relay beside it.
    const reg = (await c.h.request({ method: 'GET', path: '/v1/floor/indents', userId: 'u-mgr', tenantId: A, query: { open: 'true' } })).body as { indents: { indentId: string; state: string; requestedBy: string; relayed?: Record<string, unknown> }[] };
    expect(reg.indents).toHaveLength(1);
    expect(reg.indents[0]).toMatchObject({ indentId: 'ind-refill-2026-10-01-0a1b2c3d', state: 'requested', requestedBy: 'u-mgr', relayed: { relayedBy: 'u-box' } });

    await edge.stop();
    cleanups.pop();
    const again = await c.start();
    expect((await statusOf(again, ['shelf-count:c-b2']))[0]).toMatchObject({ state: 'refused' }); // hard rule #6: the dead-letter is kept
    expect(await latestOf(c.h)).toEqual([]);
  });
});
