import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { makeEvent } from '../../packages/contracts/src/event';
import type { BoxItemStatus, DeviceAck } from '../../packages/sync/src/device-relay';

/**
 * **The floor's indent and its independent receipt, RELAYED from the served Indents screen through the store computer to
 * head office (SP-8b · F08 · WF-06 · M09-FR-03 · M08-FR-02 · §28 · §31 · P-01 · P-08 · hard rules #1/#2/#4/#6/#10).**
 *
 * SP-8 built the chain on the direct routes; the audit's F08 said the SCREENS still kept nothing. SP-8b puts the floor's
 * ask and count-in on the SAME durable device queue and relay as the manager's decisions (SP-2) and the buyer's invoices
 * (SP-7a). This proves the cloud half on the REAL API with REAL RBAC, then the whole path against the REAL box
 * (`startEdge`) and the REAL cloud (the API harness behind a `fetch` the test can cut or make lose a reply):
 *
 *   • the synced routes take the FACT from the device (who asked / counted what, when) and re-run the JUDGEMENT through
 *     the same engine as the direct routes: an unknown place, a repeated product, the issuer counting in their own issue,
 *     a wrong item are refused (4xx) — never silently applied; the same indent / receipt again is 200, one record;
 *   • they re-verify the REQUESTER / RECEIVER the device named from their own grants and FLAG a breach on the record;
 *     the relay is recorded beside them, never as the actor; a tenant sees only its own;
 *   • a relayed receipt puts what arrived on the shelf ONCE at the cost it left with — a reply lost between cloud and
 *     box settles to one posting on the retry; a refused receipt is a visible dead-letter on the box, with the code in
 *     its reason, that survives a restart, and moved no stock.
 *
 * Synthetic data only; nothing touches production (hard rule #7).
 */

const KEY = ['floor', 'indents', 'edge', 'signing', 'key'].join('-').padEnd(48, '0');
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AT = '2026-09-30T10:00:00.000Z';
const BACK = 'S1-BACK';
const FLOOR = 'S1';
const PACK_JSON = JSON.stringify({ version: 1, policies: { tradingDayCutoff: '02:00', storeId: FLOOR, branchId: FLOOR, warehouseId: BACK }, lossPreventionRules: [] });

type Body = Record<string, unknown>;
const post = (h: ApiHarness, u: string, path: string, body: Body, key: string, t = A) => h.request({ method: 'POST', path, userId: u, tenantId: t, idempotencyKey: key, body });
const get = (h: ApiHarness, u: string, path: string, query?: Readonly<Record<string, string>>, t = A) => h.request({ method: 'GET', path, userId: u, tenantId: t, ...(query === undefined ? {} : { query }) });
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
interface Indent { indentId: string; state: string; requestedBy: string; governanceFlags?: string[]; relayed?: Record<string, unknown>; issues: { issueId: string; state: string; receivedBy?: string; governanceFlags?: string[]; relayed?: Record<string, unknown> }[]; totals: Record<string, unknown> }
const indentOf = (res: { body: unknown }) => (res.body as { indent: Indent }).indent;
const indentAt = (res: { body: unknown }) => res.body as Indent;

const availability = async (h: ApiHarness, productId: string) =>
  (await get(h, 'u-owner', '/v1/inventory/availability', { productId })).body as { rows: { locationId: string; onHandMinor: number }[]; inTransit: { transferId: string; quantityMinor: number }[] };
const onHand = (a: Awaited<ReturnType<typeof availability>>, locationId: string): number => a.rows.filter((r) => r.locationId === locationId).reduce((s, r) => s + r.onHandMinor, 0);

/** The places head office knows, its costed back-store stock, and the cast — u-box is the store computer's identity. */
async function seeded(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.seedOwner(B, 'u-owner-b');
  for (const u of ['u-floor', 'u-mgr', 'u-back', 'u-floor2']) await h.provisionRole(A, u, 'store_manager');
  await h.provisionRole(A, 'u-box', 'cashier');
  await h.provisionRole(A, 'u-acct', 'accountant');
  const node = (id: string, body: Body) => post(h, 'u-owner', `/v1/org/nodes/${id}`, body, `org-${id}`);
  expect((await node('C1', { kind: 'company', name: 'SRE Retail' })).status).toBe(201);
  expect((await node(FLOOR, { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' })).status).toBe(201);
  expect((await node(BACK, { kind: 'warehouse', name: 'Store 1 back store', parentId: FLOOR, companyId: 'C1' })).status).toBe(201);
  expect((await post(h, 'u-owner', '/v1/inventory/movements', {
    movementId: 'seed-RICE-50', productId: 'RICE', locationId: BACK, kind: 'received', quantityMinor: 50, uom: 'EA', occurredAt: '2026-09-01T00:00:00.000Z', enteredBy: 'u-owner', unitCostMinor: 5_000,
  }, 'seed-RICE-50')).status).toBeLessThan(300);
  return h;
}

/** What the Indents screen queues (apps/web-erp/src/indents-session.ts) — the ask, and the count-in. */
const askPayload = (indentId: string, over: Body = {}): Body => ({
  indentId, fromLocationId: BACK, toLocationId: FLOOR, lines: [{ productId: 'RICE', quantityMinor: 20, uom: 'EA' }], reason: 'shelf 4 empty',
  requestedBy: 'u-floor', at: AT, storeId: FLOOR, source: 'indents-screen', ...over,
});
const countPayload = (indentId: string, issueId: string, over: Body = {}): Body => ({
  indentId, issueId, counted: [{ productId: 'RICE', batchId: null, quantityMinor: 12 }], receivedBy: 'u-floor2', at: AT, storeId: FLOOR, source: 'indents-screen', ...over,
});
const syncedAsk = (h: ApiHarness, u: string, indentId: string, payload: Body, key?: string) => post(h, u, `/v1/floor/indents/${indentId}/synced`, payload, key ?? `sync-${indentId}`);
const syncedCount = (h: ApiHarness, u: string, indentId: string, issueId: string, payload: Body, key?: string) => post(h, u, `/v1/floor/indents/${indentId}/issues/${issueId}/receipt/synced`, payload, key ?? `sync-rc-${indentId}-${issueId}`);
const approve = (h: ApiHarness, indentId: string) => post(h, 'u-mgr', `/v1/floor/indents/${indentId}/approval`, {}, `ap-${indentId}`);
const issue = (h: ApiHarness, indentId: string, issueId: string, qty: number) => post(h, 'u-back', `/v1/floor/indents/${indentId}/issues/${issueId}`, { lines: [{ productId: 'RICE', quantityMinor: qty }] }, `is-${indentId}-${issueId}`);

describe('the synced routes: the floor\'s ask and count-in as the store computer relays them (SP-8b · F08 · §28)', () => {
  it('records a relayed ask ONCE in the requester\'s name with the relay beside it, verifies the requester from their grants and flags a breach, refuses an unknown place and a repeated product, and keeps tenants apart', async () => {
    const h = await seeded();
    // Only the store's sync identity (and the owner) may relay; a store manager posting "on behalf of" is refused.
    expect(codeOf(await syncedAsk(h, 'u-floor', 'ind-s0', askPayload('ind-s0')))).toBe('forbidden');
    expect(codeOf(await syncedAsk(h, 'u-acct', 'ind-s0', askPayload('ind-s0')))).toBe('forbidden');

    const r = await syncedAsk(h, 'u-box', 'ind-s1', askPayload('ind-s1'));
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ indentId: 'ind-s1', recorded: true, alreadyRecorded: false, flags: [] });
    expect(indentOf(r)).toMatchObject({ state: 'requested', requestedBy: 'u-floor', governanceFlags: [], relayed: { relayedBy: 'u-box', source: 'indents-screen', storeId: FLOOR }, totals: expect.objectContaining({ requestedMinor: 20 }) });
    // The same ask again — a re-sent queue item — is the same record (200), not a second ask.
    expect((await syncedAsk(h, 'u-box', 'ind-s1', askPayload('ind-s1'), 'sync-ind-s1-again')).body).toMatchObject({ alreadyRecorded: true });
    // It is on the register as any other indent, and awaits a different person.
    const reg = (await get(h, 'u-mgr', '/v1/floor/indents', { open: 'true' })).body as { indents: Indent[] };
    expect(reg.indents.map((i) => i.indentId)).toEqual(['ind-s1']);
    expect(reg.indents[0]).toMatchObject({ relayed: { relayedBy: 'u-box' } });
    // The other tenant sees nothing of it.
    expect((await get(h, 'u-owner-b', '/v1/floor/indents/ind-s1', undefined, B)).status).toBe(404);

    // The requester is verified from THEIR grants: an accountant cannot raise an indent — recorded, and FLAGGED, never silently trusted.
    const lacking = await syncedAsk(h, 'u-box', 'ind-s2', askPayload('ind-s2', { requestedBy: 'u-acct' }));
    expect(lacking.status).toBe(202);
    expect(lacking.body).toMatchObject({ flags: ['requester_lacks_authority'] });
    expect(indentOf(lacking).governanceFlags).toEqual(['requester_lacks_authority']);
    const ghost = await syncedAsk(h, 'u-box', 'ind-s3', askPayload('ind-s3', { requestedBy: 'u-nobody' }));
    expect(ghost.body).toMatchObject({ flags: ['requester_unknown'] });

    // The engine's judgement runs here too: an unknown place and a repeated product are refused, nothing recorded.
    expect(codeOf(await syncedAsk(h, 'u-box', 'ind-s4', askPayload('ind-s4', { fromLocationId: 'NOWHERE' })))).toBe('unknown_location');
    expect(codeOf(await syncedAsk(h, 'u-box', 'ind-s5', askPayload('ind-s5', { lines: [{ productId: 'RICE', quantityMinor: 1, uom: 'EA' }, { productId: 'RICE', quantityMinor: 2, uom: 'EA' }] })))).toBe('duplicate_product');
    expect((await get(h, 'u-owner', '/v1/floor/indents/ind-s5')).status).toBe(404);
    // A payload that is not a floor indent (id not matching the path) is 400 — kept at the store, not dropped.
    expect(codeOf(await syncedAsk(h, 'u-box', 'ind-s6', askPayload('ind-other')))).toBe('not_readable_as_a_relayed_indent');
  });

  it('a relayed receipt puts what arrived on the shelf ONCE, values a shortfall, refuses the issuer and a wrong item, flags a receiver without authority, and is 200 the second time', async () => {
    const h = await seeded();
    expect((await syncedAsk(h, 'u-box', 'ind-r1', askPayload('ind-r1'))).status).toBe(202);
    expect((await approve(h, 'ind-r1')).status).toBe(200);
    expect((await issue(h, 'ind-r1', 'is-1', 12)).status).toBe(201);
    expect((await issue(h, 'ind-r1', 'is-2', 8)).status).toBe(201);
    let rice = await availability(h, 'RICE');
    expect([onHand(rice, BACK), onHand(rice, FLOOR), rice.inTransit.map((t) => t.quantityMinor)]).toEqual([30, 0, [12, 8]]);

    // Only the sync identity relays; the engine refuses the issuer counting in their own issue and a wrong item; an unknown issue is 404.
    expect(codeOf(await syncedCount(h, 'u-floor2', 'ind-r1', 'is-1', countPayload('ind-r1', 'is-1')))).toBe('forbidden');
    expect(codeOf(await syncedCount(h, 'u-box', 'ind-r1', 'is-1', countPayload('ind-r1', 'is-1', { receivedBy: 'u-back' })))).toBe('issuer_cannot_receive');
    expect(codeOf(await syncedCount(h, 'u-box', 'ind-r1', 'is-1', countPayload('ind-r1', 'is-1', { counted: [{ productId: 'OIL', quantityMinor: 1 }] })))).toBe('not_on_issue');
    expect((await syncedCount(h, 'u-box', 'ind-r1', 'is-9', countPayload('ind-r1', 'is-9'))).status).toBe(404);
    expect((await syncedCount(h, 'u-box', 'ind-r9', 'is-1', countPayload('ind-r9', 'is-1'))).status).toBe(404);
    rice = await availability(h, 'RICE');
    expect(onHand(rice, FLOOR)).toBe(0); // none of the refusals moved anything

    // 10 counted of 12 sent: 10 on the shelf, 2 a valued shortfall — the transfer's own receipt, at the cost it left with.
    const rc = await syncedCount(h, 'u-box', 'ind-r1', 'is-1', countPayload('ind-r1', 'is-1', { counted: [{ productId: 'RICE', batchId: null, quantityMinor: 10 }] }));
    expect(rc.status).toBe(202);
    expect(rc.body).toMatchObject({ indentId: 'ind-r1', issueId: 'is-1', recorded: true, alreadyReceived: false, flags: [] });
    expect((rc.body as { posted: string[] }).posted).toHaveLength(1);
    expect((rc.body as { discrepancies: { differenceMinor: number; valueMinor?: number }[] }).discrepancies).toEqual([expect.objectContaining({ differenceMinor: -2 })]);
    const received = indentOf(rc);
    expect(received.issues.find((i) => i.issueId === 'is-1')).toMatchObject({ state: 'received', receivedBy: 'u-floor2', governanceFlags: [], relayed: { relayedBy: 'u-box', source: 'indents-screen', storeId: FLOOR } });
    expect(received.totals).toMatchObject({ issuedMinor: 20, receivedMinor: 10, shortfallMinor: 2, inTransitMinor: 8 });
    rice = await availability(h, 'RICE');
    expect([onHand(rice, BACK), onHand(rice, FLOOR), rice.inTransit.map((t) => t.quantityMinor)]).toEqual([30, 10, [8]]);
    const exceptions = (await get(h, 'u-owner', '/v1/inventory/exceptions')).body as { transferShortfalls: Record<string, unknown>[] };
    expect(exceptions.transferShortfalls).toEqual([expect.objectContaining({ transferId: 'ind-r1:is-1', productId: 'RICE' })]);

    // The same receipt again (a re-sent queue item, or a different key) is 200 and moves nothing.
    expect((await syncedCount(h, 'u-box', 'ind-r1', 'is-1', countPayload('ind-r1', 'is-1'), 'sync-rc-again')).body).toMatchObject({ alreadyReceived: true });
    expect(onHand(await availability(h, 'RICE'), FLOOR)).toBe(10);

    // A receiver without the movement right (the accountant) is recorded — what arrived IS on the shelf — and FLAGGED for a person.
    const flagged = await syncedCount(h, 'u-box', 'ind-r1', 'is-2', countPayload('ind-r1', 'is-2', { receivedBy: 'u-acct', counted: [{ productId: 'RICE', batchId: null, quantityMinor: 8 }] }));
    expect(flagged.status).toBe(202);
    expect(flagged.body).toMatchObject({ flags: ['receiver_lacks_authority'] });
    expect(indentOf(flagged)).toMatchObject({ state: 'received' });
    rice = await availability(h, 'RICE');
    expect([onHand(rice, BACK), onHand(rice, FLOOR), rice.inTransit]).toEqual([30, 18, []]);
  });
});

// ── the whole path: device → box (durable) → head office (once) ─────────────────────────────────────────────

const cleanups: Array<() => Promise<void>> = [];
const savedFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = savedFetch;
  for (const c of cleanups.splice(0).reverse()) await c();
});

const askEvent = (indentId: string, over: Body = {}) => makeEvent({
  id: `indent:${indentId}`, type: 'FloorIndentRequested', occurredAt: AT, idempotencyKey: `indent:${indentId}`, source: 'web-erp/indents', payload: askPayload(indentId, over),
});
const countEvent = (indentId: string, issueId: string, over: Body = {}) => makeEvent({
  id: `indent-receipt:${indentId}:${issueId}`, type: 'FloorIndentReceived', occurredAt: AT, idempotencyKey: `indent-receipt:${indentId}:${issueId}`, source: 'web-erp/indents', payload: countPayload(indentId, issueId, over),
});
const postBatch = async (edge: EdgeProcess, items: unknown[], source = 'manager'): Promise<{ status: number; acks: DeviceAck[] }> => {
  const res = await savedFetch(`http://127.0.0.1:${edge.lane!.port}/lane/outbox`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:8091' }, body: JSON.stringify({ source, items }),
  });
  return { status: res.status, acks: ((await res.json()) as { acks: DeviceAck[] }).acks };
};
const statusOf = async (edge: EdgeProcess, keys: string[]): Promise<BoxItemStatus[]> => {
  const res = await savedFetch(`http://127.0.0.1:${edge.lane!.port}/lane/outbox/status?keys=${encodeURIComponent(keys.join(','))}`);
  return ((await res.json()) as { items: BoxItemStatus[] }).items;
};

/** The real cloud behind a controllable `fetch`, and a real box pointed at it under the store's sync credential. */
async function cloudAndBox(): Promise<{ h: ApiHarness; start: () => Promise<EdgeProcess>; setOnline: (v: boolean) => void; loseNextReply: () => void; posts: () => number }> {
  const h = await seeded();
  const dir = await mkdtemp(join(tmpdir(), 'sre-floor-indents-edge-'));
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
  return { h, start, setOnline: (v) => { online = v; }, loseNextReply: () => { lose = true; }, posts: () => posts };
}

describe('the floor\'s ask and count-in: device → box (durable) → head office (once), on the manager\'s own path (SP-8b · F08 · §31)', () => {
  it('an ask is on the box before the device hears accepted, becomes a cloud indent in one pass naming the requester and the relay, and is duplicate on a retry — before and after a restart', async () => {
    const c = await cloudAndBox();
    const first = await c.start();
    const e = askEvent('ind-b1');
    const { status, acks } = await postBatch(first, [{ key: e.idempotencyKey, event: e }]);
    expect(status).toBe(200);
    expect(acks).toEqual([{ key: 'indent:ind-b1', status: 'accepted' }]);
    expect((await statusOf(first, ['indent:ind-b1']))[0]).toMatchObject({ state: 'pending' });
    expect((await get(c.h, 'u-owner', '/v1/floor/indents/ind-b1')).status).toBe(404); // nothing at head office yet — the box has it

    const pass = await first.syncOnce!();
    expect([pass.sent, pass.dead]).toEqual([1, 0]);
    const at = await get(c.h, 'u-owner', '/v1/floor/indents/ind-b1');
    expect(at.status).toBe(200);
    expect(indentAt(at)).toMatchObject({ state: 'requested', requestedBy: 'u-floor', governanceFlags: [], relayed: { relayedBy: 'u-box', source: 'indents-screen', storeId: FLOOR } });
    expect((await statusOf(first, ['indent:ind-b1']))[0]?.state).toBe('posted');

    // The device retries (a lost ack on the LAN): duplicate now, and after a restart — nothing re-sent, one indent.
    expect((await postBatch(first, [{ key: e.idempotencyKey, event: e }])).acks).toEqual([{ key: 'indent:ind-b1', status: 'duplicate' }]);
    await first.stop();
    cleanups.pop();
    const second = await c.start();
    expect((await postBatch(second, [{ key: e.idempotencyKey, event: e }])).acks).toEqual([{ key: 'indent:ind-b1', status: 'duplicate' }]);
    await second.syncOnce!();
    expect(c.posts()).toBe(1);
    expect(((await get(c.h, 'u-mgr', '/v1/floor/indents', { open: 'true' })).body as { count: number }).count).toBe(1);
  });

  it('a count-in whose reply is lost settles to ONE shelf posting on the retry; the issuer\'s own count is a visible dead-letter with the code in its reason that survives a restart and moved nothing; a cut line holds, never refuses', async () => {
    const c = await cloudAndBox();
    const edge = await c.start();
    const ask = askEvent('ind-b2');
    await postBatch(edge, [{ key: ask.idempotencyKey, event: ask }]);
    expect((await edge.syncOnce!()).sent).toBe(1);
    expect((await approve(c.h, 'ind-b2')).status).toBe(200);
    expect((await issue(c.h, 'ind-b2', 'is-1', 12)).status).toBe(201);
    expect((await issue(c.h, 'ind-b2', 'is-2', 8)).status).toBe(201);

    // The floor counts in is-1; the cloud's reply is lost on the way back.
    const good = countEvent('ind-b2', 'is-1');
    await postBatch(edge, [{ key: good.idempotencyKey, event: good }]);
    c.loseNextReply();
    const lost = await edge.syncOnce!();
    expect(lost.sent).toBe(0);
    expect(edge.deviceEventsOutbox.find('indent-receipt:ind-b2:is-1')).toMatchObject({ state: 'pending', attempts: 1 });
    // Head office DID receive it — 12 on the shelf — the reply was what got lost.
    let rice = await availability(c.h, 'RICE');
    expect([onHand(rice, BACK), onHand(rice, FLOOR), rice.inTransit.map((t) => t.quantityMinor)]).toEqual([30, 12, [8]]);
    // The retry hears "already received": handed once, ONE posting, still 12.
    expect((await edge.syncOnce!()).sent).toBe(1);
    expect((await statusOf(edge, ['indent-receipt:ind-b2:is-1']))[0]?.state).toBe('posted');
    rice = await availability(c.h, 'RICE');
    expect(onHand(rice, FLOOR)).toBe(12);
    expect(indentAt(await get(c.h, 'u-owner', '/v1/floor/indents/ind-b2')).issues.find((i) => i.issueId === 'is-1')).toMatchObject({ state: 'received', receivedBy: 'u-floor2', relayed: { relayedBy: 'u-box' } });

    // The issuer counting in their own issue (§28): refused by head office → a visible dead-letter on the box, nothing moved.
    const own = countEvent('ind-b2', 'is-2', { receivedBy: 'u-back', counted: [{ productId: 'RICE', batchId: null, quantityMinor: 8 }] });
    expect((await postBatch(edge, [{ key: own.idempotencyKey, event: own }])).acks[0]?.status).toBe('accepted');
    const refused = await edge.syncOnce!();
    expect(refused.dead).toBe(1);
    const st = await statusOf(edge, ['indent-receipt:ind-b2:is-2']);
    expect(st[0]?.state).toBe('refused');
    expect(st[0]?.reason).toMatch(/issuer_cannot_receive/);
    rice = await availability(c.h, 'RICE');
    expect([onHand(rice, FLOOR), rice.inTransit.map((t) => t.quantityMinor)]).toEqual([12, [8]]);
    await edge.stop();
    cleanups.pop();
    const again = await c.start();
    const after = await statusOf(again, ['indent-receipt:ind-b2:is-2']);
    expect(after[0]?.state).toBe('refused');
    expect(after[0]?.reason).toMatch(/issuer_cannot_receive/);

    // A cut line: the floor's proper count of is-2 is held on the box — pending, not refused — and goes when the line is back.
    const later = makeEvent({ id: 'indent-receipt:ind-b2:is-2:floor', type: 'FloorIndentReceived', occurredAt: AT, idempotencyKey: 'indent-receipt:ind-b2:is-2:floor', source: 'web-erp/indents', payload: countPayload('ind-b2', 'is-2', { counted: [{ productId: 'RICE', batchId: null, quantityMinor: 8 }] }) });
    await postBatch(again, [{ key: later.idempotencyKey, event: later }]);
    c.setOnline(false);
    const offline = await again.syncOnce!();
    expect([offline.sent, offline.dead]).toEqual([0, 0]);
    expect((await statusOf(again, [later.idempotencyKey]))[0]?.state).toBe('pending');
    c.setOnline(true);
    expect((await again.syncOnce!()).sent).toBe(1);
    expect((await statusOf(again, [later.idempotencyKey]))[0]?.state).toBe('posted');
    rice = await availability(c.h, 'RICE');
    expect([onHand(rice, BACK), onHand(rice, FLOOR), rice.inTransit]).toEqual([30, 20, []]);
    expect(indentAt(await get(c.h, 'u-owner', '/v1/floor/indents/ind-b2'))).toMatchObject({ state: 'received' });
  });
});
