import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtemp, rm, appendFile, writeFile } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { syncWatermarksAdapter } from '../../services/api/src/adapters';

/**
 * **EA-01 — the owner's figures carry each store's last COMPLETE sync, not the moment they were read (M29-FR-01/03 · D13 ·
 * P-08 · §31).**
 *
 * The audit's case: an 08:00 sale was reported at 16:00 "as at 16:00, live" — the dashboard stamped its read time as the
 * data's freshness, and nothing told head office that a store had stopped syncing. Here, two REAL store computers
 * (`startEdge`, their durable queues and sync loop) talk to the REAL head office (the production route table through the
 * harness, in memory and on PostgreSQL):
 *   • each box, after its sync pass, reports how far each queue has reached (its watermark);
 *   • the second store's line goes down, the store keeps trading (a sale waits on its disk, through a restart), three
 *     hours pass — head office shows that store STALE with its last complete sync time, the first store live, and the
 *     owner's "Sales today" figure stale, naming the store that makes it so;
 *   • the line comes back; the waiting sale goes up, the box reports, and the figures are live again;
 *   • only a store's own computer may report for it; a clock running ahead cannot buy freshness; a re-sent report is one.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaae01';
const KEY = ['ea01', 'pack', 'signing', 'key'].join('-').padEnd(48, '0');
const OWNER = 'u-owner';
const T0 = Date.parse('2026-10-10T04:00:00.000Z'); // 09:30 in the shop
const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();
const travel = (minutes: number): void => { vi.setSystemTime(new Date(T0 + minutes * 60_000)); };
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

interface Source { source: string; domain: string; lastEventAt: string | null; lastCompleteSyncAt?: string | null; basis?: string; staleness: string; unsent?: number; detail: string }
interface Row { branchId: string; domain: string; state: string; lastCompleteSyncAt: string | null; staleness: string; unsent: number | null; detail: string }
interface Fig { name: string; valueMinor?: number; asAt: string | null; staleness: string; notAvailableBecause?: string; detail: string }
interface Dash { figures: Fig[]; worstStaleness: string; asAt: string | null; readAt: string; sources?: Source[] }

/** Two real store computers on one head office, each with its own credential, each line cuttable on its own. */
async function scene(h: ApiHarness, tenant: string) {
  const dirs: string[] = [];
  const edges: EdgeProcess[] = [];
  const savedFetch = globalThis.fetch;
  // Each box presents an opaque credential; the shim resolves it to that box's identity at head office (u-box1 at S1,
  // u-box2 at S2) and mints a token as of the current clock, so hours of travelled time never expire a box's sign-in.
  const tokenOf = { S1: ['box', 's1', tenant].join('-').padEnd(48, '0'), S2: ['box', 's2', tenant].join('-').padEnd(48, '0') };
  const whoBy = new Map<string, { userId: string; branchId: string }>([[tokenOf.S1, { userId: 'u-box1', branchId: 'S1' }], [tokenOf.S2, { userId: 'u-box2', branchId: 'S2' }]]);
  const cut = new Set<string>();
  globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
    if (String(url).startsWith('http://127.0.0.1:')) return savedFetch(url, init);
    const hdr = (init.headers ?? {}) as Record<string, string>;
    const who = whoBy.get(hdr['authorization']?.replace(/^Bearer /, '') ?? '');
    if (who === undefined) return new Response('{}', { status: 401 });
    if (cut.has(who.branchId)) throw new Error('network down');
    const res = await h.request({
      method: (init.method ?? 'GET') as HttpRequest['method'], path: new URL(url).pathname, userId: who.userId, tenantId: tenant, branchId: who.branchId,
      ...(hdr['idempotency-key'] === undefined ? {} : { idempotencyKey: hdr['idempotency-key'] }),
      ...(init.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown }),
    });
    return new Response(JSON.stringify(res.body), { status: res.status });
  }) as unknown as typeof globalThis.fetch;

  const owner = (method: 'GET' | 'POST', path: string, body?: unknown) =>
    h.request({ method, path, userId: OWNER, tenantId: tenant, ...(method === 'POST' ? { idempotencyKey: `k-${Math.random()}` } : {}), ...(body === undefined ? {} : { body }) });
  await h.seedOwner(tenant, OWNER);
  await h.provisionRole(tenant, 'u-box1', 'store_computer', ['S1']);
  await h.provisionRole(tenant, 'u-box2', 'store_computer', ['S2']);
  for (const [id, body] of [
    ['C1', { kind: 'company', name: 'SRE Retail' }],
    ['S1', { kind: 'branch', name: 'SRE Hyper Market', parentId: 'C1', companyId: 'C1' }],
    ['S2', { kind: 'branch', name: 'Second store', parentId: 'C1', companyId: 'C1' }],
  ] as const) expect((await owner('POST', `/v1/org/nodes/${id}`, body)).status).toBe(201);

  const dirOf: Record<string, string> = {};
  const boot = async (storeId: 'S1' | 'S2'): Promise<EdgeProcess> => {
    if (dirOf[storeId] === undefined) {
      dirOf[storeId] = await mkdtemp(join(tmpdir(), `sre-ea01-${storeId}-`)); dirs.push(dirOf[storeId]);
      // The store's setup names the store, so every sale this box sends is stamped with it (store:S1 / store:S2).
      await writeFile(join(dirOf[storeId], 'setup.json'), JSON.stringify({ version: 1, policies: { storeId, branchId: storeId, branchName: storeId, tradingDayCutoff: '00:00', staleAfterSeconds: 3600, countApprovalThresholdMinor: 1, handoverToleranceMinor: 1, privacySlaDays: 30, warehouseId: storeId } }));
    }
    const e = (await startEdge({
      EDGE_DATA_DIR: dirOf[storeId], EDGE_TENANT_ID: tenant, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_PACK_FILE: join(dirOf[storeId], 'setup.json'),
      CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: tokenOf[storeId], EDGE_STORE_ID: storeId,
    }, () => {}))!;
    edges.push(e);
    return e;
  };
  /** A sale rung at the till while the box was off-line, as the lane writes it to the box's durable sales log. */
  const saleOnDisk = async (storeId: 'S1' | 'S2', saleId: string, committedAt: string): Promise<void> => {
    const record = JSON.stringify({ id: saleId, saleId, laneId: 'lane-1', tradingDay: committedAt.slice(0, 10), committedAt, total: 12_000, totalMinor: 12_000, currency: 'INR', lines: [{ productId: 'P1', qty: 1, unitPriceMinor: 12_000 }], tenders: [{ kind: 'cash', amountMinor: 12_000 }] });
    await appendFile(join(dirOf[storeId]!, 'sales.log'), `${Buffer.byteLength(record, 'utf8')} ${record}\n`);
  };
  const dash = async (): Promise<Dash> => {
    const res = await owner('GET', '/v1/reports/dashboard');
    expect(res.status).toBe(200);
    return res.body as Dash;
  };
  const salesOf = (d: Dash, branchId: string): Source => d.sources!.find((s) => s.source === `store:${branchId}` && s.domain === 'sales')!;
  const done = async (): Promise<void> => {
    for (const e of edges.splice(0)) await e.stop();
    globalThis.fetch = savedFetch;
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  };
  return { boot, saleOnDisk, dash, salesOf, owner, cut, done, edges };
}

async function theStoreThatStoppedSyncingIsShownStale(h: ApiHarness, tenant: string, again?: () => ApiHarness): Promise<void> {
  const s = await scene(h, tenant);
  try {
    travel(0);
    // Nothing reported yet: the owner's figures are NOT current, and say so — never "as at now, live".
    const before = await s.dash();
    const salesFig = before.figures.find((f) => f.name === 'Sales today')!;
    expect(salesFig).toMatchObject({ staleness: 'stale', asAt: null });
    expect(salesFig.valueMinor).toBeUndefined();                       // never ₹0 from a shop head office has not heard
    expect(before.asAt).toBeNull();
    // Every branch head office knows is listed — never heard from, stale — not left out.
    expect(s.salesOf(before, 'S1')).toMatchObject({ lastEventAt: null, staleness: 'stale' });
    expect(s.salesOf(before, 'S2')).toMatchObject({ lastEventAt: null, staleness: 'stale' });

    // Both store computers pass and report: both live, the figure's "as at" is the stalest store's watermark.
    const box1 = await s.boot('S1');
    let box2 = await s.boot('S2');
    travel(1);
    await box1.syncOnce!(); await box2.syncOnce!();
    expect(await box1.reportSyncWatermarks!()).toBe(true);
    expect(await box2.reportSyncWatermarks!()).toBe(true);
    const live = await s.dash();
    // No sale yet today — and that ₹0 is now a real answer: both stores' computers say everything has reached us.
    expect(s.salesOf(live, 'S1')).toMatchObject({ basis: 'store_computer_watermark', staleness: 'live', lastCompleteSyncAt: at(1), lastEventAt: null });
    expect(s.salesOf(live, 'S2')).toMatchObject({ basis: 'store_computer_watermark', staleness: 'live', lastCompleteSyncAt: at(1) });
    expect(live.figures.find((f) => f.name === 'Sales today')).toMatchObject({ staleness: 'live', asAt: at(1), valueMinor: 0 });
    expect(live.worstStaleness).toBe('live');
    expect(live.asAt).toBe(at(1));

    // The second store's line goes down. It keeps trading: a sale rung at 09:40 waits on its disk — and survives the box
    // restarting during the cut (P-01, §31).
    s.cut.add('S2');
    travel(10);
    await box2.stop(); s.edges.splice(s.edges.indexOf(box2), 1);
    await s.saleOnDisk('S2', 'S2-SALE-1', at(10));
    travel(12);
    box2 = await s.boot('S2'); // re-queued at 09:42 — but the sale was rung at 09:40, and that is what counts

    // Three hours on. The first store syncs and reports; the second cannot reach head office at all.
    travel(180);
    await box1.syncOnce!();
    expect(await box1.reportSyncWatermarks!()).toBe(true);
    await box2.syncOnce!();
    expect(await box2.reportSyncWatermarks!()).toBe(false);
    // The box itself knows its watermark: the waiting sale's own time, not the restart or the pass.
    expect(box2.agent!.health()).toMatchObject({ unsentCount: 1, completeThrough: at(10) });

    const cutOff = await s.dash();
    // A quiet store whose computer keeps reporting is LIVE (a newest-sale rule would have called it stale).
    expect(s.salesOf(cutOff, 'S1')).toMatchObject({ staleness: 'live', lastCompleteSyncAt: at(180), basis: 'store_computer_watermark' });
    // THE AUDIT'S CASE: the store that stopped syncing is shown stale, with its last complete sync time — not "now".
    expect(s.salesOf(cutOff, 'S2')).toMatchObject({ staleness: 'stale', lastCompleteSyncAt: at(1), basis: 'store_computer_watermark' });
    expect(s.salesOf(cutOff, 'S2').detail).toMatch(/store:S2: sales complete up to .*STALE/);
    const fig = cutOff.figures.find((f) => f.name === 'Sales today')!;
    expect(fig).toMatchObject({ staleness: 'stale', asAt: at(1) });
    expect(fig.asAt).not.toBe(at(180)); // never the read time
    expect(cutOff).toMatchObject({ worstStaleness: 'stale', asAt: at(1), readAt: at(180) });
    // A named report built from the same sales says the same (EA-06 producers share the rule).
    const byDay = await s.owner('GET', '/v1/reports/sales_by_day');
    expect(byDay.status).toBe(200);
    expect((byDay.body as { sources: Source[] }).sources.find((x) => x.source === 'store:S2')).toMatchObject({ staleness: 'stale', lastCompleteSyncAt: at(1) });
    expect((byDay.body as { figures: Fig[] }).figures[0]).toMatchObject({ staleness: 'stale', asAt: at(1) });
    // The same answer on the owner's sync page: every branch × queue.
    const page = await s.owner('GET', '/v1/sync/source-freshness');
    expect(page.status).toBe(200);
    const rows = (page.body as { sources: Row[] }).sources;
    expect(rows.find((r) => r.branchId === 'S2' && r.domain === 'sales')).toMatchObject({ state: 'reported', staleness: 'stale', lastCompleteSyncAt: at(1) });
    expect(rows.find((r) => r.branchId === 'S1' && r.domain === 'sales')).toMatchObject({ staleness: 'live', lastCompleteSyncAt: at(180) });
    expect(rows.find((r) => r.branchId === 'S1' && r.domain === 'refunds')).toMatchObject({ staleness: 'live' });

    // A second instance of head office (a restart, another replica) tells the owner the same — it is on the record.
    if (again !== undefined) {
      const other = again();
      const res = await other.request({ method: 'GET', path: '/v1/reports/dashboard', userId: OWNER, tenantId: tenant });
      expect(s.salesOf(res.body as Dash, 'S2')).toMatchObject({ staleness: 'stale', lastCompleteSyncAt: at(1) });
    }

    // The line comes back. The waiting sale goes up, the box reports, and the store is live again.
    s.cut.delete('S2');
    travel(181);
    await box2.syncOnce!();
    expect(box2.agent!.health().unsentCount).toBe(0);
    expect(await box2.reportSyncWatermarks!()).toBe(true);
    const back = await s.dash();
    expect(s.salesOf(back, 'S2')).toMatchObject({ staleness: 'live', lastCompleteSyncAt: at(181), unsent: 0, lastEventAt: at(10) });
    // The 09:40 sale is now in head office's figure — and the figure is live, because its store has synced through 09:41+.
    expect(back.figures.find((f) => f.name === 'Sales today')).toMatchObject({ staleness: 'live', valueMinor: 12_000 });
    expect(back.worstStaleness).toBe('live');
  } finally {
    await s.done();
  }
}

async function onlyItsOwnComputerReportsAndCannotBuyFreshness(h: ApiHarness, tenant: string): Promise<void> {
  const s = await scene(h, tenant);
  try {
    travel(0);
    const report = (who: string, branchId: string, storeId: string, body: unknown, key: string) =>
      h.request({ method: 'POST', path: `/v1/stores/${storeId}/sync-watermarks`, userId: who, tenantId: tenant, branchId, idempotencyKey: key, body });
    const ok = { observedAt: at(0), domains: [{ domain: 'sales', completeThrough: at(0), unsent: 0, deadLettered: 0 }] };
    // Another store's computer may not speak for this one; an unknown store is not found; a garbled report is refused.
    const forged = await report('u-box2', 'S2', 'S1', ok, 'wm-forged');
    expect(forged.status).toBe(403);
    expect(codeOf(forged)).toBe('not_this_stores_computer');
    expect((await report('u-box1', 'S1', 'NOPE', ok, 'wm-nope')).status).toBe(404);
    const bad = await report('u-box1', 'S1', 'S1', { observedAt: 'yesterday', domains: [{ domain: 'sales', completeThrough: 'soon', unsent: -1 }] }, 'wm-bad');
    expect(bad.status).toBe(400);
    expect(codeOf(bad)).toBe('not_readable_as_sync_watermarks');
    // Round 6 (EA-01 security): only the store computer's OWN identity reports. A cashier and a manager at S1 — who both
    // read S1's setup under `store.pack.read` — and the owner (who holds every permission, to approve grants) are all
    // refused, for the sync report AND the "what I hold / have not sent" report; nothing they sent is recorded.
    await h.provisionRole(tenant, 'u-cash-s1', 'cashier', ['S1']);
    await h.provisionRole(tenant, 'u-mgr-s1', 'store_manager', ['S1']);
    const before = (await syncWatermarksAdapter({ store: h.store }).records(tenant)).length;
    const lies = { observedAt: at(0), domains: [{ domain: 'sales', completeThrough: at(0), unsent: 0, deadLettered: 0 }] };
    for (const [who, branch] of [['u-cash-s1', 'S1'], ['u-mgr-s1', 'S1'], [OWNER, 'S1']] as const) {
      const r = await report(who, branch, 'S1', lies, `wm-person-${who}`);
      expect(r.status, `${who} may not report S1's sync`).toBe(403);
      const held = await h.request({ method: 'POST', path: '/v1/store-packs/S1/held', userId: who, tenantId: tenant, branchId: branch, idempotencyKey: `held-person-${who}`, body: { catalogueVersion: null, storePackVersion: null, unsentItems: 0 } });
      expect(held.status, `${who} may not report what S1 holds`).toBe(403);
    }
    expect(codeOf(await report(OWNER, 'S1', 'S1', lies, 'wm-owner-2'))).toBe('not_this_stores_computer');
    // Round 7 (EA-01): a store computer reports only for the store(s) its grant NAMES. A TENANT-WIDE store_computer grant
    // names none — it is never read as "every store" — so it reports for neither S1 nor S2, on either report.
    await h.provisionRole(tenant, 'u-box-any', 'store_computer');          // branchScope 'all'
    for (const store of ['S1', 'S2'] as const) {
      const r = await report('u-box-any', store, store, lies, `wm-any-${store}`);
      expect(r.status, `a tenant-wide box may not report ${store}'s sync`).toBe(403);
      expect(codeOf(r)).toBe('not_this_stores_computer');
      const held = await h.request({ method: 'POST', path: `/v1/store-packs/${store}/held`, userId: 'u-box-any', tenantId: tenant, branchId: store, idempotencyKey: `held-any-${store}`, body: { catalogueVersion: null, storePackVersion: null, unsentItems: 0 } });
      expect(held.status, `a tenant-wide box may not report what ${store} holds`).toBe(403);
    }
    expect((await syncWatermarksAdapter({ store: h.store }).records(tenant)).length).toBe(before);
    const heldNow = await h.request({ method: 'GET', path: '/v1/store-packs/S1/held', userId: OWNER, tenantId: tenant });
    expect((heldNow.body as { held?: { reportedBy: string } }).held?.reportedBy ?? 'u-box1').toBe('u-box1');
    // The box itself is accepted on both.
    const boxHeld = await h.request({ method: 'POST', path: '/v1/store-packs/S1/held', userId: 'u-box1', tenantId: tenant, branchId: 'S1', idempotencyKey: 'held-box1', body: { catalogueVersion: null, storePackVersion: null, unsentItems: 2 } });
    expect(boxHeld.status).toBe(200);
    expect((boxHeld.body as { held: { reportedBy: string; unsentItems: number } }).held).toMatchObject({ reportedBy: 'u-box1', unsentItems: 2 });

    // A person without the owner's dashboard right cannot read the freshness page.
    expect((await h.request({ method: 'GET', path: '/v1/sync/source-freshness', userId: 'u-box1', tenantId: tenant, branchId: 'S1' })).status).toBe(403);

    // A box clock two hours AHEAD cannot make its store look fresher than head office's own clock allows.
    const ahead = await report('u-box1', 'S1', 'S1', { observedAt: at(120), domains: [{ domain: 'sales', completeThrough: at(120), unsent: 0, deadLettered: 0 }] }, 'wm-ahead');
    expect(ahead.status).toBe(200);
    expect((ahead.body as { recorded: { clockAheadCorrected: boolean; domains: { completeThrough: string }[] } }).recorded)
      .toMatchObject({ clockAheadCorrected: true, domains: [{ completeThrough: at(0) }] });

    // The same report sent twice (a retry after a lost answer) is one record.
    travel(1);
    const once = { observedAt: at(1), domains: [{ domain: 'sales', completeThrough: at(1), unsent: 0, deadLettered: 0 }] };
    expect((await report('u-box1', 'S1', 'S1', once, 'wm-once')).status).toBe(200);
    expect((await report('u-box1', 'S1', 'S1', once, 'wm-once')).status).toBe(200);
    const kept = (await syncWatermarksAdapter({ store: h.store }).records(tenant)).filter((r) => r.observedAt === at(1));
    expect(kept).toHaveLength(1);
  } finally {
    await s.done();
  }
}

describe('EA-01 — the owner\'s figures say how fresh each store really is (in memory)', () => {
  beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); });
  afterAll(() => { vi.useRealTimers(); });

  it('THE AUDIT\'S CASE: a store whose computer stopped syncing is shown stale with its last complete sync; a fresh one is live', async () => {
    await theStoreThatStoppedSyncingIsShownStale(apiHarness(), A);
  });

  it('only a store\'s own computer reports for it; a clock running ahead cannot buy freshness; a re-sent report is one', async () => {
    await onlyItsOwnComputerReportsAndCannotBuyFreshness(apiHarness(), A);
  });
});

// ── on real PostgreSQL ────────────────────────────────────────────────────────────────────────────────────────
const DATABASE_URL = process.env['DATABASE_URL'];
const PG_TENANT = `e${Date.now().toString(16).slice(-7)}-ea01-4eee-8eee-${'e'.repeat(12)}`;

describe.skipIf(!DATABASE_URL)('EA-01 on real PostgreSQL', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterAll(async () => { vi.useRealTimers(); await pool.end(); });
  afterEach(() => { /* each scene cleans up after itself */ });
  const harness = (): ApiHarness => { const sql = pgPoolClient(pool); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };

  it('the stale store is shown stale with its last complete sync — and a second head-office instance agrees', async () => {
    await theStoreThatStoppedSyncingIsShownStale(harness(), PG_TENANT, harness);
  });

  it('refusals, clock-ahead correction and one record per re-sent report hold on PostgreSQL', async () => {
    await onlyItsOwnComputerReportsAndCannotBuyFreshness(harness(), PG_TENANT.replace(/^e/, 'f'));
  });
});
