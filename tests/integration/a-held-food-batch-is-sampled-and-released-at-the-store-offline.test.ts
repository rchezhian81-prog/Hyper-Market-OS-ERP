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
import type { DomainEvent } from '../../packages/contracts/src/event';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import type { BoxItemStatus, DeviceAck } from '../../packages/sync/src/device-relay';
import { createQualityReleaseQueue, type HeldQualityHolds } from '../../apps/web-erp/src/quality-release-queue';
import { STREAM, streamName } from '../../services/api/src/adapters';

// M10-FR-02 "Offline (§31): evidence captured offline; queued" with OB-513 and OB-333 — THE PROOF, through the REAL store
// computer (`startEdge`, its fsync'd device-events log and its sync agent) and the REAL head office (the API harness behind a
// `fetch` this test can cut, make lose a reply, or drop one call). A held FOOD batch is sampled and released at the store
// with the cable out:
//   • the facilities screen's own queue (`createQualityReleaseQueue`, fed the box's facilities payload) records a PASS on a
//     food batch that has no sample, which makes it releasable there; the sample and the release reach the box durably, in
//     that order; a cold restart loses nothing and a re-sent item is "duplicate"; the screen is told the sample is waiting;
//   • back online (one reply lost, one sample call dropped so the release overtakes it) head office books the sample ONCE and
//     the release ONCE — the release waits (425) until its sample is on the hold, and is judged on head office's record;
//   • a sample recorded at the store on a batch head office released meanwhile is refused by name and kept on the box,
//     visible (hard rules #6, #10) — never written over the release. Synthetic data only (hard rule #7).

const S1 = 'S1';
const KEY = ['m10', 'sample', 'edge', 'signing', 'key'].join('-').padEnd(48, '0');
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
  await h.provisionRole(T, 'u-qc', 'store_manager', [S1]); // holds quality.hold.manage and quality.hold.release
  let n = 0;
  const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown) =>
    h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `ho-${n++}` }), ...(body === undefined ? {} : { body }) });
  for (const [id, body] of [['C1', { kind: 'company', name: 'SRE Retail' }], [S1, { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' }]] as const) {
    expect((await call('POST', `/v1/org/nodes/${id}`, 'u-owner', body)).status).toBe(201);
  }
  // OB-513: curd is not on this shop's master, so head office cannot say it is not food — each hold needs a sample first.
  for (const b of ['B-1', 'B-2']) expect((await call('POST', `/v1/quality/holds/${b}`, 'u-owner', { productId: 'CURD', reason: 'chiller ran warm overnight' })).status).toBe(201);

  const dir = await mkdtemp(join(tmpdir(), 'sre-m10-sample-box-'));
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); });
  const packFile = join(dir, 'store-pack.json');
  await writeFile(packFile, JSON.stringify({
    version: 1, lossPreventionRules: [], policies: { tradingDayCutoff: '02:00', storeId: S1, branchId: S1 },
    facilitiesPolicy: { userId: 'u-qc', permissions: ['facilities.overdue.read', 'quality.hold.manage', 'quality.hold.release'] },
  }), 'utf8');
  const net = { up: true, loseNext: false, dropOnce: null as RegExp | null, posts: [] as string[] };
  globalThis.fetch = (async (url: string, init: RequestInit = {}): Promise<Response> => {
    if (url.startsWith('http://127.0.0.1:')) return savedFetch(url, init);
    if (!net.up) throw new Error('ECONNREFUSED');
    const hdr = (init.headers ?? {}) as Record<string, string>;
    const u = new URL(url);
    if (net.dropOnce !== null && net.dropOnce.test(u.pathname)) { net.dropOnce = null; throw new Error('ECONNRESET'); } // never reached head office
    if ((init.method ?? 'GET') === 'POST') net.posts.push(u.pathname);
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

const hand = async (edge: EdgeProcess, events: readonly DomainEvent[]): Promise<DeviceAck[]> => {
  const res = await savedFetch(`http://127.0.0.1:${edge.lane!.port}/lane/outbox`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:8091' },
    body: JSON.stringify({ source: 'manager', items: events.map((e) => ({ key: e.idempotencyKey, event: e })) }),
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
const holdsOf = (p: Body): HeldQualityHolds['holds'] => (p['qualityHolds'] as HeldQualityHolds).holds;

const backings = useBackings();

describe.each(backings)('a held food batch is sampled and released at the store with the line down (M10-FR-02 · OB-513 · OB-333) — head office on $name', ({ harness }) => {
  it('the sample and the release are kept on the box, sent once in order, re-checked at head office; a conflict is refused and kept', async () => {
    const c = await cloudAndBox(harness);
    const first = await c.start();
    expect((await first.refreshWorkFeeds!()).find((o) => o.name === 'quality-holds')?.status).toBe('updated');

    // ── the cable is cut; a cold restart still shows the held batches, each needing a sample ──
    c.net.up = false;
    await first.stop(); cleanups.pop();
    const box = await c.start();
    const shown = await facilities(box);
    expect(holdsOf(shown).map((x) => [x.batchId, x.sampleRule?.required, x.samples]).sort()).toEqual([['B-1', true, []], ['B-2', true, []]]);

    // The facilities screen's own queue, fed what the box told it: the release is refused until a sample is recorded.
    const device = new SyncOutbox();
    let id = 0;
    const screen = (payload: Body) => createQualityReleaseQueue(
      { userId: 'u-qc', storeId: S1, permissions: ['quality.hold.manage', 'quality.hold.release'], now: () => new Date().toISOString(), newId: () => `n${(id += 1)}` },
      payload['qualityHolds'] as HeldQualityHolds, device,
    );
    let q = screen(shown);
    expect(q.release('en', { batchId: 'B-1', notes: 'looked fine' })).toMatchObject({ ok: false, code: 'sample_required' });
    expect(q.recordSample('en', { batchId: 'B-1', test: 'probe and smell', result: 'pass', notes: 'probe 3°C' })).toEqual({ ok: true });
    expect(q.release('en', { batchId: 'B-1', notes: 'sample passed; probe 3°C for 2 hours' })).toEqual({ ok: true });
    expect(q.recordSample('en', { batchId: 'B-2', test: 'coliform', result: 'fail' })).toEqual({ ok: true });
    const items = device.all();
    expect(items.map((i) => i.event.type)).toEqual(['QualitySampleRecorded', 'QualityHoldReleaseDecided', 'QualitySampleRecorded']);
    const keys = items.map((i) => i.key);
    expect((await hand(box, items.map((i) => i.event))).map((a) => a.status)).toEqual(['accepted', 'accepted', 'accepted']);
    for (const k of keys) device.acknowledge(k); // the box has them (what the screen's relay does on "accepted")
    expect((await box.syncOnce!()).sent).toBe(0);
    expect(c.net.posts).toEqual([]);

    // The box tells the screen the samples it holds for head office, on each hold, waiting.
    const told = await facilities(box);
    expect(holdsOf(told).find((x) => x.batchId === 'B-1')?.samplesOnThisBox).toMatchObject([{ sampleId: 's-n1', result: 'pass', recordedBy: 'u-qc', state: 'pending' }]);
    // Another screen opened now (its own empty queue) sees B-1 released here and B-2's failed sample blocking it.
    const other = createQualityReleaseQueue({ userId: 'u-qc', storeId: S1, permissions: ['quality.hold.manage', 'quality.hold.release'], now: () => new Date().toISOString() }, told['qualityHolds'] as HeldQualityHolds, new SyncOutbox());
    const rows = new Map(other.view('en').rows.map((r) => [r.batchId, r]));
    expect(rows.get('B-1')?.state).toBe('released_here');
    expect(rows.get('B-2')).toMatchObject({ canRelease: false, samples: [{ result: 'fail', here: { state: 'on_box', stateWord: 'Saved on the store computer — waiting to reach head office' } }] });

    // Meanwhile head office itself samples and releases B-2 — the store's FAIL on it will be a conflict.
    expect((await c.call('POST', '/v1/quality/holds/B-2/samples/ho-1', 'u-owner', { test: 'coliform', result: 'pass' })).status).toBe(201);
    expect((await c.call('POST', '/v1/quality/holds/B-2/release', 'u-owner', {})).status).toBe(200);

    // ── cold restart, still offline: nothing lost; a re-sent item is the same item ──
    await box.stop(); cleanups.pop();
    const again = await c.start();
    expect((await statusOf(again, keys)).map((s) => s.state)).toEqual(['pending', 'pending', 'pending']);
    expect((await hand(again, [items[0]!.event]))[0]?.status).toBe('duplicate');

    // ── the line is back: the B-1 sample call is dropped once (so the release overtakes it), then a reply is lost ──
    c.net.up = true;
    c.net.dropOnce = /\/samples\/s-n1\/synced$/;
    await again.syncOnce!();
    expect(((await c.call('GET', '/v1/quality/holds/B-1', 'u-owner')).body as { hold: { status: string } }).hold.status).toBe('held'); // the release waited (425)
    c.net.loseNext = true;
    for (let i = 0; i < 4; i += 1) await again.syncOnce!();
    const [sample1, release1, sample2] = await statusOf(again, keys);
    expect(sample1?.state).toBe('posted');
    expect(release1?.state).toBe('posted');
    expect(sample2).toMatchObject({ state: 'refused' });
    expect(sample2?.reason).toContain('batch_no_longer_held');

    // Head office: B-1's sample once, in u-qc's name; B-1 released once by u-qc; B-2's own release stands, the store's FAIL not on it.
    const b1 = (await c.call('GET', '/v1/quality/holds/B-1/samples', 'u-owner')).body as { samples: Body[]; history: Body[] };
    expect(b1.history).toHaveLength(1);
    expect(b1.samples).toMatchObject([{ sampleId: 's-n1', test: 'probe and smell', result: 'pass', takenBy: 'u-qc', recordedBy: 'u-qc', notes: 'probe 3°C' }]);
    expect(((await c.call('GET', '/v1/quality/holds/B-1', 'u-owner')).body as { hold: Body }).hold).toMatchObject({ status: 'released', releasedBy: 'u-qc' });
    expect(((await c.call('GET', '/v1/quality/holds/B-2', 'u-owner')).body as { hold: Body }).hold).toMatchObject({ status: 'released', releasedBy: 'u-owner' });
    expect(((await c.call('GET', '/v1/quality/holds/B-2/samples', 'u-owner')).body as { history: Body[] }).history.map((s) => s['sampleId'])).toEqual(['ho-1']);
    const releases = await c.h.store.readStream(c.T, streamName(STREAM.inventory, 'quality-holds'), { type: 'QualityReleased' }).catch(() => []);
    if (releases.length > 0) expect(releases.filter((e) => (e.event.payload as { batchId: string }).batchId === 'B-1')).toHaveLength(1);
    expect(c.net.posts.filter((p) => p.endsWith('/B-1/release/synced')).length).toBeGreaterThanOrEqual(2); // 425 first, then booked

    // Re-sent after posting and after another restart: duplicate; still one sample; the refusal is kept, visible.
    expect((await hand(again, [items[0]!.event]))[0]?.status).toBe('duplicate');
    await again.stop(); cleanups.pop();
    const third = await c.start();
    await third.syncOnce!();
    expect((await statusOf(third, keys)).map((s) => s.state)).toEqual(['posted', 'posted', 'refused']);
    expect(((await c.call('GET', '/v1/quality/holds/B-1/samples', 'u-owner')).body as { history: Body[] }).history).toHaveLength(1);
    // The screen, told the box's word, shows the store's FAIL on B-2 as refused with its reason (until head office's feed drops B-2).
    q = screen(await facilities(third));
    q.noteBoxStatus(await statusOf(third, keys));
    // B-2 is still in the box's last-heard feed (it was not refreshed): its store sample is refused, said, and does not count.
    const b2 = q.view('en').rows.find((r) => r.batchId === 'B-2');
    expect(b2?.samples).toMatchObject([{ result: 'fail', here: { state: 'refused', reason: expect.stringContaining('batch_no_longer_held') } }]);
    await third.refreshWorkFeeds!();
    expect(holdsOf(await facilities(third))).toEqual([]);
  }, 120_000);
});
