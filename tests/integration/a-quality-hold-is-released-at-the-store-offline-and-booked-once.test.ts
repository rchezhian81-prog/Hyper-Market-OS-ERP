import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TEST_IDP, type ApiHarness } from '../support/api-harness';
import { useBackings } from '../support/backings';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { GLOBAL_FOR } from '../../edge/store-edge/src/screen-data';
import { makeEvent, type DomainEvent } from '../../packages/contracts/src/event';
import type { BoxItemStatus, DeviceAck } from '../../packages/sync/src/device-relay';
import { STREAM, streamName } from '../../services/api/src/adapters';

// OB-333 (owner, 23 Oct 2026, in writing) — THE PROOF, through the REAL store box (`startEdge`) and the REAL head office
// (the API harness behind a `fetch` this test can cut and make lose a reply). A quality-hold RELEASE is decided at the
// store with the line down:
//   • the box holds head office's held batches (its quality-holds work feed) across a cold restart with the cable out;
//   • the facilities screen's release is taken durably (fsync'd before "accepted"); a cold restart loses nothing and a
//     re-sent release is "duplicate";
//   • on reconnect (one reply lost) head office books it ONCE, after re-checking the PERSON named from their own grants —
//     a release by someone without the quality-release right is a visible refusal kept on the box (hard rules #6, #10);
//   • the box can NEVER place a hold: no device event for it is relayable, and the store computer's own credential is
//     refused on the hold route. Synthetic data only (hard rule #7).

const S1 = 'S1';
const KEY = ['ob333', 'box', 'edge', 'signing', 'key'].join('-').padEnd(48, '0');
type Body = Record<string, unknown>;
const cleanups: Array<() => Promise<void>> = [];
const savedFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = savedFetch;
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function cloudAndBox(harness: () => ApiHarness) {
  const h = harness();
  const T = randomUUID();
  await h.seedOwner(T, 'u-owner');
  await h.provisionRole(T, 'u-box', 'store_computer', [S1]);
  await h.provisionRole(T, 'u-qc', 'store_manager', [S1]);   // holds quality.hold.release
  await h.provisionRole(T, 'u-cash', 'cashier', [S1]);       // does not
  let n = 0;
  const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown) =>
    h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `ho-${n++}` }), ...(body === undefined ? {} : { body }) });
  for (const [id, body] of [['C1', { kind: 'company', name: 'SRE Retail' }], [S1, { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' }]] as const) {
    expect((await call('POST', `/v1/org/nodes/${id}`, 'u-owner', body)).status).toBe(201);
  }
  for (const b of ['B-1', 'B-2', 'B-3']) expect((await call('POST', `/v1/quality/holds/${b}`, 'u-owner', { productId: 'CURD', reason: 'chiller ran warm overnight' })).status).toBe(201);

  const dir = await mkdtemp(join(tmpdir(), 'sre-ob333-box-'));
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); });
  const packFile = join(dir, 'store-pack.json');
  await writeFile(packFile, JSON.stringify({
    version: 1, lossPreventionRules: [], policies: { tradingDayCutoff: '02:00', storeId: S1, branchId: S1 },
    facilitiesPolicy: { userId: 'u-qc', permissions: ['facilities.overdue.read', 'facilities.task.record', 'quality.hold.release'] },
  }), 'utf8');
  const net = { up: true, loseNext: false, posts: 0 };
  globalThis.fetch = (async (url: string, init: RequestInit = {}): Promise<Response> => {
    if (url.startsWith('http://127.0.0.1:')) return savedFetch(url, init);
    if (!net.up) throw new Error('ECONNREFUSED');
    const hdr = (init.headers ?? {}) as Record<string, string>;
    const u = new URL(url);
    if ((init.method ?? 'GET') === 'POST') net.posts += 1;
    const res = await h.raw({
      method: (init.method ?? 'GET') as HttpRequest['method'], path: u.pathname, query: Object.fromEntries(u.searchParams),
      token: hdr['authorization']?.replace(/^Bearer /, ''), idempotencyKey: hdr['idempotency-key'],
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
    });
    if (net.loseNext) { net.loseNext = false; throw new Error('ECONNRESET'); } // head office acted; the reply never came
    return new Response(JSON.stringify(res.body), { status: res.status, headers: { date: new Date().toUTCString() } });
  }) as unknown as typeof globalThis.fetch;
  const start = async (): Promise<EdgeProcess> => {
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: T, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: T, branchId: S1 }), EDGE_PACK_FILE: packFile,
    }, () => {}))!;
    cleanups.push(async () => { await edge.stop(); });
    return edge;
  };
  return { h, T, call, net, start };
}

const hand = async (edge: EdgeProcess, source: string, events: readonly DomainEvent[]): Promise<DeviceAck[]> => {
  const res = await savedFetch(`http://127.0.0.1:${edge.lane!.port}/lane/outbox`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:8091' },
    body: JSON.stringify({ source, items: events.map((e) => ({ key: e.idempotencyKey, event: e })) }),
  });
  return ((await res.json()) as { acks: DeviceAck[] }).acks;
};
const statusOf = async (edge: EdgeProcess, keys: readonly string[]): Promise<BoxItemStatus[]> =>
  ((await (await savedFetch(`http://127.0.0.1:${edge.lane!.port}/lane/outbox/status?keys=${encodeURIComponent(keys.join(','))}`)).json()) as { items: BoxItemStatus[] }).items;
const facilities = async (edge: EdgeProcess): Promise<Body> => {
  const html = await (await savedFetch(`http://127.0.0.1:${edge.screens!.port}/facilities/`)).text();
  const m = new RegExp(`<script>window\\.${GLOBAL_FOR.facilities} = ([\\s\\S]*?);</script>`).exec(html);
  expect(m, html.slice(0, 200)).not.toBeNull();
  return JSON.parse(m![1]!) as Body;
};
const ev = (type: string, key: string, payload: Body): DomainEvent => makeEvent({ id: key, type, occurredAt: String(payload['at']), idempotencyKey: key, source: 'web-erp/facilities', payload });
const heldIds = (p: Body): string[] => ((p['qualityHolds'] as Body)['holds'] as Body[]).filter((x) => x['releasedOnThisBox'] !== true).map((x) => String(x['batchId'])).sort();

const backings = useBackings();

describe.each(backings)('a quality-hold release decided at the store with the line down is booked once (OB-333) — head office on $name', ({ harness }) => {
  it('held batches survive a cold restart offline; the release is kept, re-checked at head office and booked once; a person without the right is refused and kept; the box never places a hold', async () => {
    const c = await cloudAndBox(harness);
    // Head office's held batches reach the box while the line is up.
    const first = await c.start();
    const pulled = (await first.refreshWorkFeeds!()).find((o) => o.name === 'quality-holds');
    expect(pulled?.status, JSON.stringify(pulled)).toBe('updated');
    expect(heldIds(await facilities(first))).toEqual(['B-1', 'B-2', 'B-3']);

    // ── the cable is cut; a cold restart still shows the held batches ──
    c.net.up = false;
    await first.stop(); cleanups.pop();
    const box = await c.start();
    expect(heldIds(await facilities(box))).toEqual(['B-1', 'B-2', 'B-3']);
    const at = new Date().toISOString();
    const releaseB1 = ev('QualityHoldReleaseDecided', 'quality-release:B-1', { batchId: 'B-1', storeId: S1, releasedBy: 'u-qc', at, samples: [], expiresOn: '2099-12-31', notes: 'probe reads 3°C; sample passed', source: 'facilities-screen' });
    const releaseB2 = ev('QualityHoldReleaseDecided', 'quality-release:B-2', { batchId: 'B-2', storeId: S1, releasedBy: 'u-cash', at, source: 'facilities-screen' });
    const keys = [releaseB1.idempotencyKey, releaseB2.idempotencyKey];
    expect((await hand(box, 'manager', [releaseB1, releaseB2])).map((a) => a.status)).toEqual(['accepted', 'accepted']);
    // The box can never place a hold: no such event rides any surface.
    for (const type of ['QualityHoldPlaced', 'QualityHeld']) {
      expect((await hand(box, 'manager', [ev(type, `hold:${type}`, { batchId: 'B-9', productId: 'CURD', reason: 'x', at })]))[0]?.status).toBe('refused');
    }
    expect((await box.syncOnce!()).sent).toBe(0);
    expect(c.net.posts).toBe(0);
    // The screen shows B-1 released here, waiting to reach head office.
    const shown = await facilities(box);
    expect((shown['qualityReleasesHere'] as Body[]).map((r) => r['batchId']).sort()).toEqual(['B-1', 'B-2']);

    // ── cold restart, still offline: nothing lost; a re-sent release is the same release ──
    await box.stop(); cleanups.pop();
    const again = await c.start();
    expect((await statusOf(again, keys)).map((s) => s.state)).toEqual(['pending', 'pending']);
    expect((await hand(again, 'manager', [releaseB1]))[0]?.status).toBe('duplicate');

    // ── the line is back; a reply is lost; the next passes settle to ONE release ──
    c.net.up = true;
    c.net.loseNext = true;
    await again.syncOnce!();
    for (let i = 0; i < 3; i += 1) await again.syncOnce!();
    const [b1, b2] = await statusOf(again, keys);
    expect(b1?.state).toBe('posted');
    expect(b2).toMatchObject({ state: 'refused' });
    expect(b2?.reason).toContain('releaser_lacks_authority');
    const hold = async (b: string) => ((await c.call('GET', `/v1/quality/holds/${b}`, 'u-owner')).body as { hold: { status: string; releasedBy?: string } }).hold;
    expect(await hold('B-1')).toMatchObject({ status: 'released', releasedBy: 'u-qc' });
    expect((await hold('B-2')).status).toBe('held');
    expect((await hold('B-3')).status).toBe('held');
    const releases = await c.h.store.readStream(c.T, streamName(STREAM.inventory, 'quality-holds'), { type: 'QualityReleased' }).catch(() => []);
    if (releases.length > 0) expect(releases.filter((e) => (e.event.payload as { batchId: string }).batchId === 'B-1')).toHaveLength(1);
    // B-1 is no longer a sale block; B-2 and B-3 still are.
    const blocks = ((await c.call('GET', '/v1/quality/sale-blocks', 'u-owner')).body as { blocks: { batchId: string }[] }).blocks.map((x) => x.batchId).sort();
    expect(blocks).toEqual(['B-2', 'B-3']);

    // Re-sent after posting and after another restart: duplicate; head office still holds one release; the refusal is kept.
    expect((await hand(again, 'manager', [releaseB1]))[0]?.status).toBe('duplicate');
    await again.stop(); cleanups.pop();
    const third = await c.start();
    await third.syncOnce!();
    expect((await statusOf(third, keys)).map((s) => s.state)).toEqual(['posted', 'refused']);
    await third.refreshWorkFeeds!();
    expect(heldIds(await facilities(third))).toEqual(['B-2', 'B-3']);

    // Head office's own doors: a person cannot use the box's relay right; the box cannot place or directly release a hold.
    expect((await c.call('POST', '/v1/quality/holds/B-3/release/synced', 'u-qc', { batchId: 'B-3', releasedBy: 'u-qc', at })).status).toBe(403);
    expect((await c.call('POST', '/v1/quality/holds/B-7', 'u-box', { productId: 'CURD', reason: 'x' })).status).toBe(403);
    expect((await c.call('POST', '/v1/quality/holds/B-3/release', 'u-box', {})).status).toBe(403);
  }, 120_000);
});
