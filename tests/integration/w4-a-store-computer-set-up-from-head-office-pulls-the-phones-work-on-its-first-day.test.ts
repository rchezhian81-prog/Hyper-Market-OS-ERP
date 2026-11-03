import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiHarness, TEST_IDP, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';

/**
 * **W4 · M19-FR-02 · M19-FR-03 (HA-1) · OB-26 "A" — a store computer set up from head office pulls the picker's and the
 * driver's work on its FIRST day, not only after a restart.**
 *
 * Found by the W4 connected run of the phones (tests/e2e/w4-m19-the-picker-and-driver-phones-reach-head-office-on-postgresql.e2e.ts):
 * a new store computer that takes its setup from head office (EDGE_STORE_PACK_SOURCE=head-office, EDGE_STORE_ID — the
 * production way, OB-26 "A") holds no setup on its first boot. It worked out which store to ask head office's assignments
 * for from the pack it had at boot — none — so it never asked: it said "this box's pack names no store", and the phones had
 * no wave and no route until somebody restarted it. The store it is set up for is named in its own settings (EDGE_STORE_ID),
 * so it asks for that store from the first pass. Real head office (the API harness), the real store computer.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa4a1';
const SETTINGS = { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 15, warehouseId: 'S1' };

describe('W4 — a store computer set up from head office pulls the phones\' work on its first day (M19-FR-02/03 · HA-1)', () => {
  const edges: EdgeProcess[] = [];
  const dirs: string[] = [];
  const savedFetch = globalThis.fetch;
  afterEach(async () => {
    for (const e of edges.splice(0)) await e.stop();
    globalThis.fetch = savedFetch;
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  async function headOffice(): Promise<ApiHarness> {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-box', 'store_computer', ['S1']);
    await h.provisionRole(A, 'u-driver', 'store_manager', ['S1']);
    await h.enableFeature(A, 'delivery');
    const call = (path: string, body: unknown) => h.request({ method: 'POST', path, userId: 'u-owner', tenantId: A, idempotencyKey: `k-${path}`, body });
    expect((await call('/v1/org/nodes/C1', { kind: 'company', name: 'SRE Retail' })).status).toBe(201);
    expect((await call('/v1/org/nodes/S1', { kind: 'branch', name: 'SRE Hyper Market', parentId: 'C1', companyId: 'C1' })).status).toBe(201);
    expect((await call('/v1/stores/S1/settings', SETTINGS)).status).toBe(201);
    // The dispatcher hands a route to its driver at head office (HA-1).
    const r = await call('/v1/delivery/routes/R-1/assignment', { storeId: 'S1', driverId: 'u-driver', stops: [{ stopId: 's1', orderRef: 'ORD-1', area: 'Slot 10:00', codMinor: 80_00 }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
      if (String(url).startsWith('http://127.0.0.1:')) return savedFetch(url, init);
      const hdr = (init.headers ?? {}) as Record<string, string>;
      const u = new URL(url);
      const res = await h.raw({
        method: (init.method ?? 'GET') as HttpRequest['method'], path: u.pathname,
        token: hdr['authorization']?.replace(/^Bearer /, ''), idempotencyKey: hdr['idempotency-key'],
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
        ...(u.search === '' ? {} : { query: Object.fromEntries(u.searchParams) }),
      });
      return new Response(JSON.stringify(res.body), { status: res.status });
    }) as unknown as typeof globalThis.fetch;
    return h;
  }

  it('a brand-new box with no setup yet asks head office for ITS store\'s assignments on the first pass, and holds the route', async () => {
    await headOffice();
    const dir = await mkdtemp(join(tmpdir(), 'sre-w4-first-day-'));
    dirs.push(dir);
    const said: string[] = [];
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: A, PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
      CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: A, branchId: 'S1' }),
      EDGE_STORE_PACK_SOURCE: 'head-office', EDGE_STORE_ID: 'S1',
    }, (line) => { said.push(line); }))!;
    edges.push(edge);
    // First boot: no setup is held yet, but the box knows which store it is set up for — it does not say it cannot ask.
    expect(edge.storeSetup()).toMatchObject({ source: 'none' });
    expect(said.join('\n')).not.toMatch(/cannot be asked for assignments/);
    expect(edge.refreshAssignmentsFeed, 'the box asks head office for its store\'s assignments from its first day').not.toBeNull();

    expect((await edge.refreshStorePack!()).status).toBe('updated');
    expect((await edge.refreshAssignmentsFeed!()).status).toBe('updated');
    const held = JSON.parse(await readFile(join(dir, 'assignments-feed.json'), 'utf8')) as { feed: { storeId: string; routes: { routeId: string; driverId: string }[] } };
    expect(held.feed.storeId).toBe('S1');
    expect(held.feed.routes.map((r) => [r.routeId, r.driverId])).toEqual([['R-1', 'u-driver']]);
  });
});
