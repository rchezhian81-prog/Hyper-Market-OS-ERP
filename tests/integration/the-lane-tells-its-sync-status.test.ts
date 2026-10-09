import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import type { LaneSyncStatus } from '../../edge/store-edge/src/sync-status';
import { prepareTillBox, signInAtLane, operatorHeader, receiptNumberAt } from '../support/till-operator';

/** The literal path — the edge exports no name for it on purpose (hard rule #1, tests/unit/store-edge.test.ts). */
const LANE_SYNC_STATUS_ROUTE = '/lane/sync-status';

/**
 * **The lane socket tells the screens what the box knows about its link to head office (Stage G slice 2 · design
 * system §1 rule 4 · P-01 · P-08).**
 *
 * `GET /lane/sync-status` is the fact behind the till's and the manager's sync badge. Proven on a REAL edge:
 *   • a box with no cloud says `not_configured` and counts what it is holding — a sale saved on the lane raises
 *     the count the badge will show, from the box's outbox, not the browser's;
 *   • a box with a cloud says `unknown` until a pass has run, `online` once head office has answered (a day
 *     close drained, then a pull), and `offline` — keeping the last contact time — once the line is gone;
 *   • the same authorization as every other lane route: a foreign origin is refused, a loopback preflight is
 *     answered, and the answer is never cacheable.
 */

const KEY = ['lane', 'sync', 'status', 'signing', 'key'].join('-').padEnd(48, '0');
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PACK_JSON = JSON.stringify({ version: 1, policies: { tradingDayCutoff: '02:00' }, lossPreventionRules: [] });

const cleanups: Array<() => Promise<void>> = [];
const savedFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = savedFetch;
  for (const c of cleanups.splice(0)) await c();
});

const statusOf = async (edge: EdgeProcess, headers: Record<string, string> = {}): Promise<{ res: Response; body: LaneSyncStatus }> => {
  const res = await savedFetch(`http://127.0.0.1:${edge.lane!.port}${LANE_SYNC_STATUS_ROUTE}`, { headers });
  return { res, body: (await res.json()) as LaneSyncStatus };
};

async function standaloneLane(): Promise<EdgeProcess> {
  const dir = await mkdtemp(join(tmpdir(), 'sre-lane-status-'));
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); });
  const edge = (await startEdge({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
    ...await prepareTillBox({ dir, key: KEY }),
  }, () => {}))!;
  cleanups.push(async () => { await edge.stop(); });
  return edge;
}

/** A real cloud (the API harness, in memory) behind a `fetch` the test can cut. */
async function laneWithCloud(): Promise<{ h: ApiHarness; edge: EdgeProcess; setOnline: (v: boolean) => void }> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager');
  const dir = await mkdtemp(join(tmpdir(), 'sre-lane-status-cloud-'));
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); });
  const packFile = join(dir, 'store-pack.json');
  await writeFile(packFile, PACK_JSON, 'utf8');

  let online = true;
  globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
    // The test's own reads of the lane socket must still reach it; only the CLOUD is cut.
    if (url.startsWith('http://127.0.0.1:')) return savedFetch(url, init);
    if (!online) throw new Error('ENETUNREACH');
    const hdr = (init.headers ?? {}) as Record<string, string>;
    const res = await h.raw({
      method: (init.method ?? 'GET') as HttpRequest['method'],
      path: new URL(url).pathname,
      token: hdr['authorization']?.replace(/^Bearer /, ''),
      idempotencyKey: hdr['idempotency-key'],
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
    });
    return new Response(JSON.stringify(res.body), { status: res.status });
  }) as unknown as typeof globalThis.fetch;

  const edge = (await startEdge({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: A, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
    CLOUD_API_URL: 'https://cloud.example.test',
    CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-mgr', tenantId: A }),
    EDGE_PACK_FILE: packFile,
  }, () => {}))!;
  cleanups.push(async () => { await edge.stop(); });
  return { h, edge, setOnline: (v) => { online = v; } };
}

describe('a box with no cloud says so, and counts what it holds', () => {
  it('answers not_configured with nothing unsent, and the same fact is on the process', async () => {
    const edge = await standaloneLane();
    const { res, body } = await statusOf(edge);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(body.cloud).toBe('not_configured');
    expect(body.unsent).toBe(0);
    expect(body.deadLettered).toBe(0);
    expect(body.lastSentAt).toBeNull();
    expect(body.lastContactAt).toBeNull();
    expect(body.staffMessage).toMatch(/No head office link is set up/);
    expect(edge.syncStatus().cloud).toBe('not_configured');
  });

  it('a sale saved on the lane raises the count the badge shows — the BOX\'s outbox, not the browser\'s', async () => {
    const edge = await standaloneLane();
    const token = await signInAtLane(edge.lane!.port, 'u-lanecash');
    const who = operatorHeader(token);
    const number = await receiptNumberAt(edge.lane!.port, token);
    const saved = await savedFetch(`http://127.0.0.1:${edge.lane!.port}/lane/sales`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...who }, body: JSON.stringify({ id: 'S-1', number, total: 1, cashierId: 'u-lanecash' }),
    });
    expect((await saved.json() as { committed: boolean }).committed).toBe(true);
    const { body } = await statusOf(edge);
    expect(body.unsent).toBe(1);
    expect(body.staffMessage).toMatch(/1 item\(s\) are saved on this box/);
  });

  it('is refused to a foreign origin, answers a loopback preflight, and is listed on the socket\'s 404', async () => {
    const edge = await standaloneLane();
    const foreign = await savedFetch(`http://127.0.0.1:${edge.lane!.port}${LANE_SYNC_STATUS_ROUTE}`, { headers: { origin: 'https://untrusted.invalid' } });
    expect(foreign.status).toBe(403);
    const preflight = await savedFetch(`http://127.0.0.1:${edge.lane!.port}${LANE_SYNC_STATUS_ROUTE}`, {
      method: 'OPTIONS', headers: { origin: `http://127.0.0.1:${edge.screens?.port ?? 8091}` },
    });
    expect(preflight.status).toBe(204);
    const lost = await savedFetch(`http://127.0.0.1:${edge.lane!.port}/lane/nothing`);
    expect(lost.status).toBe(404);
    expect(((await lost.json()) as { error: string }).error).toContain(`GET ${LANE_SYNC_STATUS_ROUTE}`);
  });
});

describe('a box with a cloud says what its passes found', () => {
  it('unknown before a pass; online once head office answers; offline — with the last contact kept — when the line goes', async () => {
    const { edge, setOnline } = await laneWithCloud();

    // Nothing has run yet: the honest answer is "not checked", not "online".
    expect((await statusOf(edge)).body.cloud).toBe('unknown');

    // Something to send: a day close queued on the box. Draining it is a send that head office acknowledges.
    const closed = await edge.closeDay({ dayCloseId: 'dc-1', closedBy: 'u-mgr' });
    expect(closed.closed).toBe(true);
    expect((await statusOf(edge)).body.unsent).toBe(1);
    await edge.syncOnce!();
    let s = (await statusOf(edge)).body;
    expect(s.cloud).toBe('online');
    expect(s.unsent).toBe(0);
    expect(s.lastSentAt).not.toBeNull();
    expect(s.lastContactAt).toBe(s.lastSentAt);

    // A pull that reaches head office (nothing published is still an answer) is contact too.
    const before = s.lastContactAt!;
    await new Promise((r) => setTimeout(r, 5));
    await edge.refreshPack!();
    s = (await statusOf(edge)).body;
    expect(s.cloud).toBe('online');
    expect(Date.parse(s.lastContactAt!)).toBeGreaterThanOrEqual(Date.parse(before));

    // The line goes. The next pull says so; the last contact is kept, not blanked; nothing pretends.
    setOnline(false);
    await edge.refreshPack!();
    const gone = (await statusOf(edge)).body;
    expect(gone.cloud).toBe('offline');
    expect(gone.lastContactAt).toBe(s.lastContactAt);
    expect(gone.staffMessage).toMatch(/could not be reached/);
  });
});
