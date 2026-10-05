import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore, type HttpRequest } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { makeEvent } from '../../packages/contracts/src/event';
import type { BoxItemStatus, DeviceAck } from '../../packages/sync/src/device-relay';

/**
 * **The whole floor-indent chain as a CONNECTED stock workflow — the back store issues on the handheld, the floor counts in
 * with damage, and location balances, bins, availability and valuation reconcile with no double counting (SP-8c · F08 ·
 * WF-06 · WF-07 · M09-FR-03 · M08-FR-02 · M08-FR-04 · §28 · §31 · P-01 · P-08 · hard rules #1 #2 #4 #6 #10).**
 *
 * Everything below the handheld is production: the REAL box (`startEdge`) with its device-events pipeline, the REAL cloud
 * (the API harness behind a `fetch` the test can cut or make lose a reply) — on the in-memory event store AND, where
 * `DATABASE_URL` is set (the CI "Stage gate suites" job and the local gate), on REAL PostgreSQL with the same migrations
 * production runs. Synthetic data only (hard rule #7).
 *
 *   • the floor's ask arrives through the box; a manager approves; the handheld's ISSUE (`FloorIndentIssued`, naming the bin
 *     it took from) is on the box before the device hears accepted; one sync pass dispatches the transfer at head office —
 *     stock off the back store ONCE, in transit at the floor, the BIN lowered in the same write — with the issuer and the
 *     relay named; a reply lost between cloud and box settles to ONE dispatch on the retry; a re-sent issue is `duplicate`
 *     before and after a box restart;
 *   • a bin head office does not know is FLAGGED (`bin_disagrees`), the stock still moves once, no bin is forced;
 *   • the floor counts in 10 good + 2 damaged of 12: 10 on the shelf (the till's availability), 2 written off at the floor at
 *     the cost they left with, nothing in transit for that issue, no shortfall — and the register says received / damaged /
 *     in transit / outstanding separately;
 *   • at every step: back-store on-hand + floor on-hand + in transit + written-off = the 50 that were ever received, and
 *     their VALUE at weighted-average cost reconciles to the same 250,000 minor — nothing counted twice, nothing lost;
 *   • the requester issuing to themselves, an over-issue and a wrong item are head office's refusals → visible dead-letters
 *     on the box with the code in the reason, surviving a restart, moving nothing; a cut line holds the issue, never refuses.
 */

const AT = '2026-10-01T10:00:00.000Z';
const BACK = 'S1-BACK';
const FLOOR = 'S1';
const KEY = ['floor', 'indents', 'handheld', 'signing', 'key'].join('-').padEnd(48, '0');
const PACK_JSON = JSON.stringify({ version: 1, policies: { tradingDayCutoff: '02:00', storeId: FLOOR, branchId: FLOOR, warehouseId: BACK }, lossPreventionRules: [] });

type Body = Record<string, unknown>;
const post = (h: ApiHarness, t: string, u: string, path: string, body: Body, key: string) => h.request({ method: 'POST', path, userId: u, tenantId: t, idempotencyKey: key, body });
const get = (h: ApiHarness, t: string, u: string, path: string, query?: Readonly<Record<string, string>>) => h.request({ method: 'GET', path, userId: u, tenantId: t, ...(query === undefined ? {} : { query }) });
interface Indent { indentId: string; state: string; flags: string[]; attention: string[]; totals: Record<string, unknown>; issues: { issueId: string; state: string; issuedBy: string; lines: { binId?: string }[]; governanceFlags?: string[]; relayed?: Record<string, unknown>; damaged?: unknown[] }[] }
const indentAt = async (h: ApiHarness, t: string, id: string): Promise<Indent> => (await get(h, t, 'u-owner', `/v1/floor/indents/${id}`)).body as Indent;

/** The stock picture head office holds for RICE: on-hand per place, in transit, value per place — the figures that must reconcile. */
async function picture(h: ApiHarness, t: string) {
  const a = (await get(h, t, 'u-owner', '/v1/inventory/availability', { productId: 'RICE' })).body as { rows: { locationId: string; onHandMinor: number }[]; inTransit: { transferId: string; quantityMinor: number }[] };
  const v = (await get(h, t, 'u-owner', '/v1/inventory/valuation', { productId: 'RICE' })).body as { rows: { locationId: string; value: { minor: number } }[] };
  const on = (loc: string) => a.rows.filter((r) => r.locationId === loc).reduce((s, r) => s + r.onHandMinor, 0);
  const val = (loc: string) => v.rows.filter((r) => r.locationId === loc).reduce((s, r) => s + r.value.minor, 0);
  const inTransit = a.inTransit.reduce((s, r) => s + r.quantityMinor, 0);
  return { back: on(BACK), floor: on(FLOOR), inTransit, backValue: val(BACK), floorValue: val(FLOOR), inTransitValue: inTransit * 5_000 };
}
const binHeld = async (h: ApiHarness, t: string, binId: string): Promise<Record<string, number>> =>
  Object.fromEntries((((await get(h, t, 'u-owner', `/v1/warehouse/bins/${binId}`)).body as { held: { key: string; quantityMinor: number }[] }).held).map((x) => [x.key, x.quantityMinor]));

/** Places, cast, costed back-store stock (50 RICE @ 5,000 minor), and the bin at the cloud holding those 50. */
async function seeded(h: ApiHarness, t: string): Promise<void> {
  await h.seedOwner(t, 'u-owner');
  for (const u of ['u-floor', 'u-mgr', 'u-back', 'u-floor2']) await h.provisionRole(t, u, 'store_manager');
  await h.provisionRole(t, 'u-box', 'cashier');
  const node = (id: string, body: Body) => post(h, t, 'u-owner', `/v1/org/nodes/${id}`, body, `org-${id}`);
  expect((await node('C1', { kind: 'company', name: 'SRE Retail' })).status).toBe(201);
  expect((await node(FLOOR, { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' })).status).toBe(201);
  expect((await node(BACK, { kind: 'warehouse', name: 'Store 1 back store', parentId: FLOOR, companyId: 'C1' })).status).toBe(201);
  expect((await post(h, t, 'u-owner', '/v1/inventory/movements', {
    movementId: 'seed-RICE-50', productId: 'RICE', locationId: BACK, kind: 'received', quantityMinor: 50, uom: 'EA', occurredAt: '2026-09-01T00:00:00.000Z', enteredBy: 'u-owner', unitCostMinor: 5_000,
  }, 'seed-RICE-50')).status).toBeLessThan(300);
  // The bin register at head office: BIN-A at the back store, put away with the 50 — a bin-level projection UNDER the M08 position, never a second posting.
  expect((await post(h, t, 'u-owner', '/v1/warehouse/bins/BIN-A', { storeId: FLOOR, capacityMinor: 1000, pickable: true, zone: 'ambient', locationId: BACK }, 'bin-a')).status).toBeLessThan(300);
  expect((await post(h, t, 'u-owner', '/v1/warehouse/movements/seed-pa', { kind: 'put_away', storeId: FLOOR, productId: 'RICE', batchId: null, quantityMinor: 50, uom: 'EA', fromBinId: null, toBinId: 'BIN-A' }, 'seed-pa')).status).toBeLessThan(300);
  expect(await binHeld(h, t, 'BIN-A')).toEqual({ 'BIN-A|RICE|': 50 });
  expect(await picture(h, t)).toEqual({ back: 50, floor: 0, inTransit: 0, backValue: 250_000, floorValue: 0, inTransitValue: 0 });
}

const askEvent = (indentId: string) => makeEvent({
  id: `indent:${indentId}`, type: 'FloorIndentRequested', occurredAt: AT, idempotencyKey: `indent:${indentId}`, source: 'web-erp/indents',
  payload: { indentId, fromLocationId: BACK, toLocationId: FLOOR, lines: [{ productId: 'RICE', quantityMinor: 20, uom: 'EA' }], reason: 'shelf 4 empty', requestedBy: 'u-floor', at: AT, storeId: FLOOR, source: 'indents-screen' },
});
/** What the warehouse handheld queues (`WarehouseSession.issueToFloor`): the indent, the line, how many, from which bin, by whom. */
const issueEvent = (indentId: string, issueId: string, over: Body = {}) => makeEvent({
  id: `indent-issue:${indentId}:${issueId}`, type: 'FloorIndentIssued', occurredAt: AT, idempotencyKey: `indent-issue:${indentId}:${issueId}`, source: 'A-1',
  payload: { indentId, issueId, lines: [{ productId: 'RICE', batchId: null, quantityMinor: 12, binId: 'BIN-A', uom: 'EA' }], issuedBy: 'u-back', at: AT, storeId: FLOOR, source: 'warehouse-handheld', ...over },
});
const countEvent = (indentId: string, issueId: string, counted: Body[]) => makeEvent({
  id: `indent-receipt:${indentId}:${issueId}`, type: 'FloorIndentReceived', occurredAt: AT, idempotencyKey: `indent-receipt:${indentId}:${issueId}`, source: 'web-erp/indents',
  payload: { indentId, issueId, counted, receivedBy: 'u-floor2', at: AT, storeId: FLOOR, source: 'indents-screen' },
});

const cleanups: Array<() => Promise<void>> = [];
const savedFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = savedFetch;
  for (const c of cleanups.splice(0).reverse()) await c();
});

const postBatch = async (edge: EdgeProcess, items: unknown[], source: string): Promise<{ status: number; acks: DeviceAck[] }> => {
  const res = await savedFetch(`http://127.0.0.1:${edge.lane!.port}/lane/outbox`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:8091' }, body: JSON.stringify({ source, items }),
  });
  return { status: res.status, acks: ((await res.json()) as { acks: DeviceAck[] }).acks };
};
const statusOf = async (edge: EdgeProcess, keys: string[]): Promise<BoxItemStatus[]> => {
  const res = await savedFetch(`http://127.0.0.1:${edge.lane!.port}/lane/outbox/status?keys=${encodeURIComponent(keys.join(','))}`);
  return ((await res.json()) as { items: BoxItemStatus[] }).items;
};
const relay = async (edge: EdgeProcess, event: ReturnType<typeof makeEvent>, source: string) => (await postBatch(edge, [{ key: event.idempotencyKey, event }], source)).acks[0];

/** The real cloud behind a controllable `fetch`, and a real box pointed at it under the store's sync credential. */
async function cloudAndBox(h: ApiHarness, t: string): Promise<{ start: () => Promise<EdgeProcess>; setOnline: (v: boolean) => void; loseNextReply: () => void; posts: () => number }> {
  await seeded(h, t);
  const dir = await mkdtemp(join(tmpdir(), 'sre-indent-handheld-'));
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); });
  const packFile = join(dir, 'store-pack.json');
  await writeFile(packFile, PACK_JSON, 'utf8');
  let online = true;
  let lose = false;
  let posts = 0;
  globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
    if (url.startsWith('http://127.0.0.1:')) return savedFetch(url, init);
    if (!online) throw new Error('ENETUNREACH');
    const hdr = (init.headers ?? {}) as Record<string, string>;
    const path = new URL(url).pathname;
    if (path.startsWith('/v1/floor/') && (init.method ?? 'GET') === 'POST') posts += 1;
    const res = await h.raw({
      method: (init.method ?? 'GET') as HttpRequest['method'], path,
      token: hdr['authorization']?.replace(/^Bearer /, ''), idempotencyKey: hdr['idempotency-key'],
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
    });
    if (lose) { lose = false; throw new Error('ECONNRESET'); }
    return new Response(JSON.stringify(res.body), { status: res.status });
  }) as unknown as typeof globalThis.fetch;
  const start = async (): Promise<EdgeProcess> => {
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: t, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
      CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: t }), EDGE_PACK_FILE: packFile,
    }, () => {}))!;
    cleanups.push(async () => { await edge.stop(); });
    return edge;
  };
  return { start, setOnline: (v) => { online = v; }, loseNextReply: () => { lose = true; }, posts: () => posts };
}

// ── the backings: the in-memory store always; real PostgreSQL where the gate provides one ─────────────────────────
const DATABASE_URL = process.env['DATABASE_URL'];
let client: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  // The TRANSACTIONAL pool client — the wiring main.ts uses. Wave 2a's write guards (the audit chain's among them) run inside
  // the append's own transaction, and the store refuses a guarded append on a client that offers none (fail closed, by name).
  client = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(client), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await client?.end(); });
const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(client!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

describe.each(backings)('the back store issues on the handheld and the chain reconciles — on $name (SP-8c · F08)', ({ harness }) => {
  it('ask → approve → handheld issue through the box (once, bin lowered in the same write, lost reply → one dispatch, duplicate after a restart) → count in with damage → the figures reconcile → the shelf sells', async () => {
    const h = harness();
    const t = randomUUID();
    const c = await cloudAndBox(h, t);
    const edge = await c.start();

    // 1. The floor's ask reaches head office through the box; a manager allocates all 20 against the 50 the back store holds.
    expect((await relay(edge, askEvent('ind-h1'), 'manager'))?.status).toBe('accepted');
    expect((await edge.syncOnce!()).sent).toBe(1);
    expect((await post(h, t, 'u-mgr', '/v1/floor/indents/ind-h1/approval', {}, 'ap-h1')).status).toBe(200);
    expect((await indentAt(h, t, 'ind-h1')).totals).toMatchObject({ allocatedMinor: 20, outstandingMinor: 20 });

    // 2. The handheld ISSUES 12 from BIN-A. On the box before the device hears accepted; the cloud's reply is lost on the way back.
    const issue1 = issueEvent('ind-h1', 'c-1');
    expect((await relay(edge, issue1, 'warehouse'))?.status).toBe('accepted');
    expect((await statusOf(edge, [issue1.idempotencyKey]))[0]).toMatchObject({ state: 'pending' });
    c.loseNextReply();
    expect((await edge.syncOnce!()).sent).toBe(0);
    // Head office DID dispatch — stock off the back store, in transit at the floor, the BIN lowered in the same write — the reply was what got lost.
    let after = await indentAt(h, t, 'ind-h1');
    expect(after.issues[0]).toMatchObject({ issueId: 'c-1', state: 'in_transit', issuedBy: 'u-back', governanceFlags: [], relayed: { relayedBy: 'u-box', source: 'warehouse-handheld', storeId: FLOOR }, lines: [{ binId: 'BIN-A' }] });
    expect(await picture(h, t)).toEqual({ back: 38, floor: 0, inTransit: 12, backValue: 190_000, floorValue: 0, inTransitValue: 60_000 });
    expect(await binHeld(h, t, 'BIN-A')).toEqual({ 'BIN-A|RICE|': 38 });
    // The retry hears "already issued": handed once, ONE dispatch, ONE bin movement.
    expect((await edge.syncOnce!()).sent).toBe(1);
    expect((await statusOf(edge, [issue1.idempotencyKey]))[0]?.state).toBe('posted');
    expect(await picture(h, t)).toMatchObject({ back: 38, inTransit: 12 });
    expect(await binHeld(h, t, 'BIN-A')).toEqual({ 'BIN-A|RICE|': 38 });
    // The device retries on the LAN: duplicate now, and after a box restart — nothing re-sent.
    expect((await relay(edge, issue1, 'warehouse'))?.status).toBe('duplicate');
    await edge.stop();
    cleanups.pop();
    const second = await c.start();
    expect((await relay(second, issue1, 'warehouse'))?.status).toBe('duplicate');
    await second.syncOnce!();
    expect(await picture(h, t)).toMatchObject({ back: 38, inTransit: 12 });
    expect(await binHeld(h, t, 'BIN-A')).toEqual({ 'BIN-A|RICE|': 38 });

    // 3. A bin head office does not know (the handheld's projection disagrees): the stock still moves ONCE, the bin disagreement is FLAGGED, no bin is forced.
    const issue2 = issueEvent('ind-h1', 'c-2', { lines: [{ productId: 'RICE', batchId: null, quantityMinor: 4, binId: 'BIN-Z', uom: 'EA' }] });
    await relay(second, issue2, 'warehouse');
    expect((await second.syncOnce!()).sent).toBe(1);
    after = await indentAt(h, t, 'ind-h1');
    expect(after.issues.find((i) => i.issueId === 'c-2')).toMatchObject({ state: 'in_transit', governanceFlags: ['bin_disagrees'] });
    expect(await picture(h, t)).toEqual({ back: 34, floor: 0, inTransit: 16, backValue: 170_000, floorValue: 0, inTransitValue: 80_000 });
    expect(await binHeld(h, t, 'BIN-A')).toEqual({ 'BIN-A|RICE|': 38 });

    // 4. The floor counts issue c-1 in: 10 good + 2 DAMAGED of 12. Ten on the shelf, two written off at the floor at the cost they
    //    left with, nothing of c-1 left in transit, no shortfall — and the register says each figure separately.
    const count = countEvent('ind-h1', 'c-1', [{ productId: 'RICE', batchId: null, quantityMinor: 10, damagedMinor: 2 }]);
    await relay(second, count, 'manager');
    expect((await second.syncOnce!()).sent).toBe(1);
    after = await indentAt(h, t, 'ind-h1');
    expect(after.issues.find((i) => i.issueId === 'c-1')).toMatchObject({ state: 'received', damaged: [{ productId: 'RICE', batchId: null, quantityMinor: 2, valueMinor: 10_000 }] });
    expect(after.totals).toMatchObject({ issuedMinor: 16, receivedMinor: 10, damagedMinor: 2, shortfallMinor: 0, inTransitMinor: 4, outstandingMinor: 4 });
    expect(after.flags).toContain('arrived_damaged');
    expect(after.flags).not.toContain('partial_receipt');
    expect(after.attention).toEqual(['owed_by_back_store', 'on_the_trolley', 'arrived_damaged']);
    const p = await picture(h, t);
    expect(p).toEqual({ back: 34, floor: 10, inTransit: 4, backValue: 170_000, floorValue: 50_000, inTransitValue: 20_000 });
    // Conservation: on-hand everywhere + in transit + the 2 written off = the 50 ever received; value likewise = 250,000.
    expect(p.back + p.floor + p.inTransit + 2).toBe(50);
    expect(p.backValue + p.floorValue + p.inTransitValue + 10_000).toBe(250_000);
    // Counting the same issue again (a re-sent queue item) is 200: nothing moves twice.
    expect((await relay(second, count, 'manager'))?.status).toBe('duplicate');
    expect(await picture(h, t)).toMatchObject({ floor: 10 });

    // 5. A cut line holds the last issue on the box — pending, never refused — and it goes when the line is back.
    const issue3 = issueEvent('ind-h1', 'c-3', { lines: [{ productId: 'RICE', batchId: null, quantityMinor: 4, binId: 'BIN-A', uom: 'EA' }] });
    await relay(second, issue3, 'warehouse');
    c.setOnline(false);
    expect(await second.syncOnce!()).toMatchObject({ sent: 0, dead: 0 });
    expect((await statusOf(second, [issue3.idempotencyKey]))[0]?.state).toBe('pending');
    c.setOnline(true);
    expect((await second.syncOnce!()).sent).toBe(1);
    after = await indentAt(h, t, 'ind-h1');
    expect(after.state).toBe('issued'); // nothing owed; two issues still on the trolley
    expect(after.totals).toMatchObject({ issuedMinor: 20, outstandingMinor: 0, inTransitMinor: 8 });
    expect(await picture(h, t)).toEqual({ back: 30, floor: 10, inTransit: 8, backValue: 150_000, floorValue: 50_000, inTransitValue: 40_000 });
    expect(await binHeld(h, t, 'BIN-A')).toEqual({ 'BIN-A|RICE|': 34 });

    // 6. The shelf SELLS from what arrived good: a till sale at the floor draws from the 10 — never from the trolley, never from the write-off.
    expect((await post(h, t, 'u-owner', '/v1/inventory/movements', { movementId: 'sale-1', productId: 'RICE', locationId: FLOOR, kind: 'sold', quantityMinor: 3, uom: 'EA', occurredAt: AT, enteredBy: 'u-cashier' }, 'sale-1')).status).toBeLessThan(300);
    expect(await picture(h, t)).toMatchObject({ floor: 7, back: 30, inTransit: 8 });
    expect(c.posts()).toBe(6); // ask, issue c-1 (lost reply), issue c-1 (retry), issue c-2, receipt c-1, issue c-3 — the duplicate acks never reached the cloud
  }, 60_000);

  it('the requester issuing to themselves, an over-issue and a wrong item are head office\'s refusals — visible dead-letters on the box with the code in the reason, surviving a restart, moving nothing', async () => {
    const h = harness();
    const t = randomUUID();
    const c = await cloudAndBox(h, t);
    const edge = await c.start();
    await relay(edge, askEvent('ind-h2'), 'manager');
    await edge.syncOnce!();
    expect((await post(h, t, 'u-mgr', '/v1/floor/indents/ind-h2/approval', {}, 'ap-h2')).status).toBe(200);

    const own = issueEvent('ind-h2', 'c-own', { issuedBy: 'u-floor' });
    const over = issueEvent('ind-h2', 'c-over', { lines: [{ productId: 'RICE', batchId: null, quantityMinor: 21, binId: 'BIN-A', uom: 'EA' }] });
    const wrong = issueEvent('ind-h2', 'c-wrong', { lines: [{ productId: 'OIL', batchId: null, quantityMinor: 1, binId: 'BIN-A', uom: 'EA' }] });
    for (const e of [own, over, wrong]) expect((await relay(edge, e, 'warehouse'))?.status).toBe('accepted');
    const pass = await edge.syncOnce!();
    expect(pass.dead).toBe(3);
    const st = await statusOf(edge, [own.idempotencyKey, over.idempotencyKey, wrong.idempotencyKey]);
    expect(st.map((s) => s.state)).toEqual(['refused', 'refused', 'refused']);
    expect(st[0]?.reason).toMatch(/requester_cannot_issue/);
    expect(st[1]?.reason).toMatch(/over_issue/);
    expect(st[2]?.reason).toMatch(/not_on_indent/);
    expect(await picture(h, t)).toEqual({ back: 50, floor: 0, inTransit: 0, backValue: 250_000, floorValue: 0, inTransitValue: 0 });
    expect(await binHeld(h, t, 'BIN-A')).toEqual({ 'BIN-A|RICE|': 50 });
    expect((await indentAt(h, t, 'ind-h2')).issues).toEqual([]);

    await edge.stop();
    cleanups.pop();
    const again = await c.start();
    const after = await statusOf(again, [own.idempotencyKey]);
    expect(after[0]?.state).toBe('refused');
    expect(after[0]?.reason).toMatch(/requester_cannot_issue/);
    // A handheld issuer head office cannot find (a device named a worker with no grants) is recorded and FLAGGED — never silently trusted.
    const ghost = issueEvent('ind-h2', 'c-ghost', { issuedBy: 'u-nobody' });
    await relay(again, ghost, 'warehouse');
    expect((await again.syncOnce!()).sent).toBe(1);
    expect((await indentAt(h, t, 'ind-h2')).issues[0]).toMatchObject({ issueId: 'c-ghost', governanceFlags: ['issuer_unknown'] });
  }, 60_000);
});
