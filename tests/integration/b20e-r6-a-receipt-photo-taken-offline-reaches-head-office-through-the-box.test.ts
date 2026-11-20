import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TEST_IDP, type ApiHarness } from '../support/api-harness';
import { useBackings } from '../support/backings';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import type { BoxItemStatus } from '../../packages/sync/src/device-relay';
import type { FetchLike } from '../../packages/sync/src/device-drain';
import { ReceiptAttachmentQueue, attachmentKeyFor } from '../../packages/receiving/src/receipt-attachments';
import { openAttachmentRelay } from '../../packages/receiving/src/receipt-attachment-relay';

// Batch 20e · R6 (M07-FR-04 · P-01 · P-08 · hard rules #6, #10) — THE PROOF, through the REAL store computer (`startEdge`, its
// fsync'd device-events log and its sync agent) and the REAL head office (the API harness behind a `fetch` this test can cut or
// make lose a reply). A photo of the delivery note and a damage photo are taken on Receive with the cable out:
//   • the screen's OWN attachment queue hands them to the store computer one file per hand-over; they are on its disk, nothing
//     goes to head office, and a cold restart of the store computer loses nothing;
//   • back online (the first reply lost) head office keeps each file ONCE, with its bytes, in the receiver's name, carried by
//     the store computer's credential; the screen is told "posted";
//   • a file the store computer may not speak for (another store's place) is refused by head office BY NAME and kept on the
//     store computer, visible as refused with the reason — never dropped. Synthetic data only (hard rule #7).

const S1 = 'S1';
const KEY = ['b20e', 'photo', 'edge', 'signing', 'key'].join('-').padEnd(48, '0');
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 40_000 }, (_, i) => i % 251)]);
const JPG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 60_000 }, (_, i) => (i * 7) % 253)]);
const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');
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
  await h.provisionRole(T, 'u-recv', 'store_manager', [S1]);
  let n = 0;
  const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown) =>
    h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `ho-${n++}` }), ...(body === undefined ? {} : { body }) });
  for (const [id, body] of [['C1', { kind: 'company', name: 'SRE Retail' }], [S1, { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' }], ['S2', { kind: 'branch', name: 'Store 2', parentId: 'C1', companyId: 'C1' }]] as const) {
    expect((await call('POST', `/v1/org/nodes/${id}`, 'u-owner', body)).status).toBe(201);
  }
  const dir = await mkdtemp(join(tmpdir(), 'sre-b20e-photo-box-'));
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); });
  const packFile = join(dir, 'store-pack.json');
  await writeFile(packFile, JSON.stringify({ version: 1, lossPreventionRules: [], policies: { tradingDayCutoff: '02:00', storeId: S1, branchId: S1 } }), 'utf8');
  const net = { up: true, loseNext: false, posts: [] as string[] };
  globalThis.fetch = (async (url: string, init: RequestInit = {}): Promise<Response> => {
    if (url.startsWith('http://127.0.0.1:')) return savedFetch(url, init);
    if (!net.up) throw new Error('ECONNREFUSED');
    const hdr = (init.headers ?? {}) as Record<string, string>;
    const u = new URL(url);
    if ((init.method ?? 'GET') === 'POST') net.posts.push(u.pathname);
    const res = await h.raw({
      method: (init.method ?? 'GET') as HttpRequest['method'], path: u.pathname, query: Object.fromEntries(u.searchParams),
      token: hdr['authorization']?.replace(/^Bearer /, ''), idempotencyKey: hdr['idempotency-key'],
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
    });
    if (net.loseNext) { net.loseNext = false; throw new Error('ECONNRESET'); } // head office kept it; the reply never came
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

/** The screen's own fetch to the store computer (the browser adds the page's origin). */
const screenFetch: FetchLike = (url, init) => savedFetch(url, { ...init, headers: { ...init.headers, origin: 'http://127.0.0.1:8091' } }) as never;
const statusOf = async (edge: EdgeProcess, keys: readonly string[]): Promise<BoxItemStatus[]> =>
  ((await (await savedFetch(`http://127.0.0.1:${edge.lane!.port}/lane/outbox/status?keys=${encodeURIComponent(keys.join(','))}`)).json()) as { items: BoxItemStatus[] }).items;

const backings = useBackings();

describe.each(backings)('a receipt photo taken with the line down reaches head office through the store computer (M07-FR-04 · batch 20e) — head office on $name', ({ harness }) => {
  it('kept on the store computer offline, sent once when the line is back, refused files kept and said', async () => {
    const c = await cloudAndBox(harness);
    c.net.up = false; // the cable is out
    let box = await c.start();

    // Receive (office): a delivery note photo and a damage photo of the oil, on the screen's own attachment queue.
    const device = new SyncOutbox();
    const queue = new ReceiptAttachmentQueue(device, { now: () => '2026-11-20T05:00:00.000Z', source: 'manager-screen' });
    const add = (attachmentId: string, over: Record<string, unknown> = {}, bytes = PNG, mediaType = 'image/png') => queue.add({
      attachmentId, grnId: 'grn-dn-90', receiptNumber: 'DN-90', warehouseId: S1, storeId: S1, kind: 'delivery_note',
      fileName: `${attachmentId}.png`, mediaType, contentBase64: b64(bytes), attachedBy: 'u-recv', ...over,
    });
    expect(add('ra-note').added).toBe(true);
    expect(add('ra-damage', { kind: 'damage_photo', productId: 'p-oil' }, JPG, 'image/jpeg').added).toBe(true);
    const relayFor = (edge: EdgeProcess) => openAttachmentRelay({ boxBase: `http://127.0.0.1:${edge.lane!.port}`, outbox: device, queue, source: 'manager', fetch: screenFetch })!;
    expect(await relayFor(box).syncNow()).toMatchObject({ handed: 2, refused: 0, offline: false });
    expect(queue.list().map((a) => a.state)).toEqual(['handed_to_box', 'handed_to_box']);
    expect((await box.syncOnce!()).sent).toBe(0);
    expect(c.net.posts).toEqual([]);

    // A cold restart of the store computer loses nothing.
    await box.stop(); cleanups.pop();
    box = await c.start();
    const keys = [attachmentKeyFor('ra-note'), attachmentKeyFor('ra-damage')];
    expect((await statusOf(box, keys)).map((s) => s.state)).toEqual(['pending', 'pending']);

    // Back online, the first reply lost: head office keeps each file once.
    c.net.up = true;
    c.net.loseNext = true;
    await box.syncOnce!();
    await box.syncOnce!();
    expect((await statusOf(box, keys)).map((s) => s.state)).toEqual(['posted', 'posted']);
    await relayFor(box).syncNow();
    expect(queue.list().map((a) => [a.attachmentId, a.state])).toEqual([['ra-damage', 'posted'], ['ra-note', 'posted']]);
    const files = (await c.call('GET', '/v1/inventory/goods-receipt/grn-dn-90/attachments', 'u-owner')).body as { attachments: Record<string, unknown>[] };
    expect(files.attachments.map((a) => [a['attachmentId'], a['kind'], a['productId'] ?? null, a['attachedBy'], a['relayedBy'], a['source']])).toEqual([
      ['ra-note', 'delivery_note', null, 'u-recv', 'u-box', 'manager-screen'],
      ['ra-damage', 'damage_photo', 'p-oil', 'u-recv', 'u-box', 'manager-screen'],
    ]);
    const opened = (await c.call('GET', '/v1/inventory/goods-receipt/grn-dn-90/attachments/ra-damage', 'u-owner')).body as { attachment: { contentBase64: string } };
    expect(opened.attachment.contentBase64).toBe(b64(JPG));
    expect(c.net.posts.filter((p) => p.includes('/attachments/')).length).toBeGreaterThanOrEqual(2);

    // A file naming another store's place: head office refuses it by name; the store computer keeps it, visible.
    expect(add('ra-wrong', { warehouseId: 'S2', grnId: 'grn-dn-91', receiptNumber: 'DN-91' }).added).toBe(true);
    await relayFor(box).syncNow();
    await box.syncOnce!();
    const [wrong] = await statusOf(box, [attachmentKeyFor('ra-wrong')]);
    expect(wrong?.state).toBe('refused');
    expect(wrong?.reason ?? '').not.toBe('');
    await relayFor(box).syncNow();
    expect(queue.of('grn-dn-91')[0]).toMatchObject({ state: 'refused' });
    expect(((await c.call('GET', '/v1/inventory/goods-receipt/grn-dn-91/attachments', 'u-owner')).body as { attachments: unknown[] }).attachments).toEqual([]);
  }, 120_000);
});
