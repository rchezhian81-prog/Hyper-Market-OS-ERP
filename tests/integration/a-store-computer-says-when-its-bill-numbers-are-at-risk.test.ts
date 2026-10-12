import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, cp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiHarness, TEST_IDP, TEST_PACK_KEY } from '../support/api-harness';
import { startRealCloud, type RealCloud } from '../support/real-store';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { issueTillPins, signInTill } from '../support/till-operator';
import { PLAUSIBLE_ISSUED_AHEAD, UNRECEIVED_GRACE_MINUTES } from '../../services/platform/src/box-health';

/**
 * **Verifier r19 — a store computer SAYS when its bill numbers are at risk, and a report alone never locks a till.**
 * Through REAL store computers (`startEdge`), the real till (`bootPos`) and head office's production routes — in memory and
 * on PostgreSQL over HTTP:
 *
 *   1. OB87-1 — THE WITNESS SELF-CHECK. A box whose witness folder cannot be opened (the containerised edge's read-only root
 *      had no witness volume) says so LOUDLY: at start, on its status read (the sentence leads), and on its health report —
 *      head office shows `box_bill_numbers:<store>` degraded, "CANNOT keep its bill-number witness". It still never repeats
 *      a number across restarts. A witness folder INSIDE the data folder is refused the same way. Given a proper witness
 *      folder, the component reads ok once head office's setup has arrived.
 *   2. OB87-2 — two boxes sharing one witness folder no longer read each other as a restore on every start (each keeps its
 *      own file): offline restarts keep each till's own prefix, and each box names the other's witness file beside it.
 *   3. BOX-1 — a box's reported "issued through 999999" for its own till's prefix is REFUSED for the high-water (beyond
 *      banked + PLAUSIBLE_ISSUED_AHEAD) and shown to the owner; the till keeps selling. A store-1 box reporting store 2's
 *      prefix is refused too. A plausible report is folded. A store-coded `ZZ` prefix is not folded and raises nothing.
 *   4. SALES LOST BY A RESTORE — the bills a box gave after the backup it was restored from are reported as numbers it cannot
 *      vouch for; once the grace period has passed, head office names the prefix and the range it never received ("bills
 *      issued but never received"). Bills banked and a number abandoned at the till are never named.
 */

const OWNER = 'u-owner';
const S1 = 'S1';
const S2 = 'S2';
const SETTINGS = { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 30 };

interface Reply { readonly status: number; readonly body: unknown }
interface Cloud {
  readonly tenant: string;
  readonly url: string;
  call(method: HttpRequest['method'], path: string, user: string, body?: unknown, key?: string, branchId?: string): Promise<Reply>;
  grant(user: string, role: string, scope: readonly string[] | 'all'): Promise<void>;
  fetchFor(saved: typeof globalThis.fetch, isCut: () => boolean): typeof globalThis.fetch;
}
interface Component { name: string; status: string; detail: string; evidence?: Record<string, unknown> }
interface Observed {
  observed: { boxes: { storeId: string; billNumbering?: { witness: string; restoreHeld: boolean; sharedWith: unknown[] } | null; billNumberFindings?: { kind: string; prefix: string; ranges?: [number, number][]; detail: string }[] }[] };
  health: { components: Component[] };
}

async function setUp(cloud: Cloud): Promise<void> {
  const post = (path: string, body: unknown, key: string) => cloud.call('POST', path, OWNER, body, key);
  for (const [id, body] of [
    ['C1', { kind: 'company', name: 'SRE Retail' }],
    [S1, { kind: 'branch', name: 'Store One', parentId: 'C1', companyId: 'C1' }],
    [S2, { kind: 'branch', name: 'Store Two', parentId: 'C1', companyId: 'C1' }],
  ] as const) expect((await post(`/v1/org/nodes/${id}`, body, `org-${id}`)).status).toBeLessThan(300);
  for (const s of [S1, S2]) expect((await post(`/v1/stores/${s}/settings`, SETTINGS, `settings-${s}`)).status).toBeLessThan(300);
  await cloud.grant('u-box-1', 'store_computer', [S1]);
  await cloud.grant('u-box-2', 'store_computer', [S2]);
  await cloud.grant('u-cash2', 'cashier', [S2]);
  for (const lane of ['lane-1', 'lane-2', 'lane-3', 'lane-4', 'lane-6']) {
    expect((await cloud.call('POST', `/v1/stores/${S2}/tills/${lane}/receipt-prefix`, OWNER, { prefix: `S2L${lane.slice(-1)}-` }, `pfx-${lane}`)).status).toBe(201);
  }
}

interface Boxes {
  boot: (dir: string, lane: string, extra?: Record<string, string>) => Promise<EdgeProcess & { lines: string[] }>;
  stop: (e: EdgeProcess) => Promise<void>;
  setCut: (v: boolean) => void;
  dir: (tag: string) => Promise<string>;
  root: string;
}
async function withBoxes(cloud: Cloud, run: (b: Boxes) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'sre-r19-at-risk-'));
  const edges: EdgeProcess[] = [];
  const saved = globalThis.fetch;
  let cut = false;
  globalThis.fetch = cloud.fetchFor(saved, () => cut);
  try {
    await run({
      root,
      dir: async (tag) => { const d = join(root, tag); await mkdir(d, { recursive: true }); await issueTillPins(d, TEST_PACK_KEY, ['u-cash2']); return d; },
      boot: async (dir, lane, extra = {}) => {
        const lines: string[] = [];
        const edge = (await startEdge({
          EDGE_DATA_DIR: dir, EDGE_TENANT_ID: cloud.tenant, PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_LANE_ID: lane,
          CLOUD_API_URL: cloud.url, CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box-2', tenantId: cloud.tenant, branchId: S2 }),
          EDGE_STORE_PACK_SOURCE: 'head-office', EDGE_STORE_ID: S2, ...extra,
        }, (m) => { lines.push(m); }))!;
        edges.push(edge);
        return Object.assign(edge, { lines });
      },
      stop: async (e) => { await e.stop(); edges.splice(edges.indexOf(e), 1); },
      setCut: (v) => { cut = v; },
    });
  } finally {
    for (const e of edges.splice(0)) await e.stop();
    globalThis.fetch = saved;
    await rm(root, { recursive: true, force: true });
  }
}

async function sell(edge: EdgeProcess, lane: string): Promise<string> {
  const t = bootPos({ laneId: lane, taxPercent: 0, lanePort: edge.lane!.port });
  await signInTill(t, 'u-cash2');
  const number = await t.nextReceipt();
  t.scan({ productId: 'P1', description: 'Toor dal 1kg', unitPriceMinor: 7_000, qty: 1 });
  await t.tenderCash(`S-${number}`, number, new Date().toISOString());
  return number;
}
const syncStatus = async (edge: EdgeProcess): Promise<{ staffMessage: string; billNumbering?: { witness: string; fault?: string; restoreHeld: boolean; sharedWith: { box: string }[]; says: string } }> =>
  (await (await fetch(`http://127.0.0.1:${edge.lane!.port}/lane/sync-status`)).json()) as never;
const observed = async (cloud: Cloud): Promise<Observed> => {
  const r = await cloud.call('GET', '/v1/platform/operational-health/observed', OWNER);
  expect(r.status).toBe(200);
  return r.body as Observed;
};
const component = (o: Observed, name: string): Component | undefined => o.health.components.find((c) => c.name === name);
const bankedThrough = async (cloud: Cloud, prefix: string): Promise<number | undefined> =>
  (((await cloud.call('GET', `/v1/store-packs/${S2}`, OWNER)).body as { sections: { receiptSeries?: { prefix: string; bankedThrough: number }[] } }).sections.receiptSeries ?? [])
    .find((s) => s.prefix === prefix)?.bankedThrough;
const report = (cloud: Cloud, user: string, store: string, issued: unknown, key = `hr-${randomUUID()}`): Promise<Reply> => cloud.call('POST', '/v1/store-computers/health-reports', user, {
  observedAt: new Date().toISOString(), disk: { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1000, salesLogCapacityBytes: 1e7, reserveBytes: 1e6 },
  queue: { unsent: 0, deadLettered: 0 }, tills: [], receiptNumbersIssued: issued,
}, key, store);

async function witnessSelfCheck(cloud: Cloud): Promise<void> {
  await withBoxes(cloud, async ({ boot, stop, setCut, dir, root }) => {
    const data = await dir('w-data');
    const blocker = join(root, 'a-file');
    await writeFile(blocker, 'x');
    const unopenable = { EDGE_WITNESS_DIR: join(blocker, 'witness') }; // like a read-only root with no witness volume

    const a = await boot(data, 'lane-1', unopenable);
    expect(a.lines.join('\n')).toMatch(/!!! BILL-NUMBER WITNESS UNAVAILABLE/);
    expect(await a.refreshStorePack!()).toMatchObject({ status: 'updated' });
    const numbers = [await sell(a, 'lane-1')];
    expect(numbers[0]).toBe('S2L1-000001');
    const st = await syncStatus(a);
    expect(st.billNumbering).toMatchObject({ witness: 'unavailable', restoreHeld: false });
    expect(st.staffMessage).toMatch(/^BILL-NUMBER WITNESS UNAVAILABLE/);
    expect(await a.syncOnce!()).toMatchObject({ sent: 1, dead: 0 }); 
    expect(await a.reportBoxHealth!()).toBe(true); // the health report rides each sync pass
    const o = await observed(cloud);
    const c = component(o, `box_bill_numbers:${S2}`);
    expect(c?.status).toBe('degraded');
    expect(c?.detail).toMatch(/CANNOT keep its bill-number witness/);
    expect(o.observed.boxes.find((b) => b.storeId === S2)?.billNumbering).toMatchObject({ witness: 'unavailable' });
    await stop(a);

    // Restarts offline: loud every time, a fresh prefix each start (fail-safe) — and never a repeated number.
    setCut(true);
    for (let i = 0; i < 2; i += 1) {
      const e = await boot(data, 'lane-1', unopenable);
      expect(e.lines.join('\n')).toMatch(/!!! BILL-NUMBER WITNESS UNAVAILABLE/);
      expect((await syncStatus(e)).billNumbering).toMatchObject({ witness: 'unavailable', restoreHeld: true });
      numbers.push(await sell(e, 'lane-1'));
      await stop(e);
    }
    expect(new Set(numbers).size).toBe(numbers.length);

    // A witness folder INSIDE the data folder is refused the same way (a backup of the data would carry it).
    const inside = await boot(data, 'lane-1', { EDGE_WITNESS_DIR: join(data, 'witness') });
    const insideStatus = await syncStatus(inside);
    expect(insideStatus.billNumbering?.witness).toBe('unavailable');
    expect(insideStatus.billNumbering?.fault).toMatch(/INSIDE the data folder/);
    numbers.push(await sell(inside, 'lane-1'));
    await stop(inside);
    expect(new Set(numbers).size).toBe(numbers.length);

    // Fixed: a witness folder of its own. The first start is a possible restore (no witness yet) — said; once head office
    // answers, the till is back on its own prefix and head office's component reads ok.
    const fixed = { EDGE_WITNESS_DIR: join(root, 'w-witness') };
    setCut(false);
    const f = await boot(data, 'lane-1', fixed);
    expect(f.lines.join('\n')).not.toMatch(/WITNESS UNAVAILABLE/);
    await f.refreshStorePack!();
    const back = await sell(f, 'lane-1');
    expect(back).toMatch(/^S2L1-0000\d\d$/);
    numbers.push(back);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect((await syncStatus(f)).billNumbering).toMatchObject({ witness: 'kept', restoreHeld: false });
    await f.syncOnce!();
    expect(await f.reportBoxHealth!()).toBe(true);
    expect(component(await observed(cloud), `box_bill_numbers:${S2}`)?.status).toBe('ok');
    await stop(f);
    // ...and a restart with it is an ordinary restart: no fresh prefix.
    setCut(true);
    const g = await boot(data, 'lane-1', fixed);
    expect(await sell(g, 'lane-1')).toMatch(/^S2L1-/);
    await stop(g);
    setCut(false);
  });
}

async function sharedWitnessFolder(cloud: Cloud): Promise<void> {
  await withBoxes(cloud, async ({ boot, stop, setCut, dir, root }) => {
    const shared = { EDGE_WITNESS_DIR: join(root, 'shared-witness') };
    const d1 = await dir('s-a'); const d2 = await dir('s-b');
    const a = await boot(d1, 'lane-2', shared); const b = await boot(d2, 'lane-3', shared);
    await a.refreshStorePack!(); await b.refreshStorePack!();
    setCut(true);
    const got = [await sell(a, 'lane-2'), await sell(b, 'lane-3')];
    await stop(a); await stop(b);
    // Restarts of either box, offline: each keeps its till's own prefix (no false restore), and says the folder is shared.
    for (let i = 0; i < 2; i += 1) {
      const a2 = await boot(d1, 'lane-2', shared);
      expect(a2.lines.join('\n')).toMatch(/also holds the witness of 1 other store computer/);
      const sa = await syncStatus(a2);
      expect(sa.billNumbering).toMatchObject({ witness: 'kept', restoreHeld: false });
      expect(sa.billNumbering?.sharedWith).toHaveLength(1);
      got.push(await sell(a2, 'lane-2'));
      await stop(a2);
      const b2 = await boot(d2, 'lane-3', shared);
      expect((await syncStatus(b2)).billNumbering).toMatchObject({ restoreHeld: false });
      got.push(await sell(b2, 'lane-3'));
      await stop(b2);
    }
    expect(got).toEqual(['S2L2-000001', 'S2L3-000001', 'S2L2-000002', 'S2L3-000002', 'S2L2-000003', 'S2L3-000003']);
    // Head office sees the shared folder on the box's health.
    setCut(false);
    const a3 = await boot(d1, 'lane-2', shared);
    await a3.refreshStorePack!();
    await a3.syncOnce!();
    expect(await a3.reportBoxHealth!()).toBe(true);
    const c = component(await observed(cloud), `box_bill_numbers:${S2}`);
    expect(c?.status).toBe('degraded');
    expect(c?.detail).toMatch(/shares its witness folder with 1 other store computer/);
    await stop(a3);
  });
}

async function aReportNeverLocksATill(cloud: Cloud): Promise<void> {
  // THE PROBE: store 2's own box reports its lane-4 prefix "through 999999".
  const r = await report(cloud, 'u-box-2', S2, [{ prefix: 'S2L4-', through: 999_999 }]);
  expect(r.status).toBe(200);
  const kept = (r.body as { recorded: { receiptNumbersIssued?: unknown[]; receiptNumbersRefused?: { prefix: string; because: string; plausibleThrough?: number }[] } }).recorded;
  expect(kept.receiptNumbersIssued).toEqual([]);
  expect(kept.receiptNumbersRefused).toEqual([expect.objectContaining({ prefix: 'S2L4-', because: 'beyond_plausible_advance', bankedThrough: 0, plausibleThrough: PLAUSIBLE_ISSUED_AHEAD })]);
  expect(await bankedThrough(cloud, 'S2L4-')).toBe(0); // the pack never carries it
  // A store-1 box reporting store 2's prefix: refused too, never folded anywhere.
  const other = await report(cloud, 'u-box-1', S1, [{ prefix: 'S2L4-', through: 50 }]);
  expect((other.body as { recorded: { receiptNumbersRefused?: { because: string }[] } }).recorded.receiptNumbersRefused).toEqual([expect.objectContaining({ because: 'prefix_of_another_store' })]);
  // A store-coded fallback prefix: not folded, no finding.
  const zz = await report(cloud, 'u-box-2', S2, [{ prefix: 'ZZABCDEF-', through: 3 }]);
  expect((zz.body as { recorded: { receiptNumbersNotFolded?: unknown[] } }).recorded.receiptNumbersNotFolded).toEqual([{ prefix: 'ZZABCDEF-', through: 3 }]);

  // The till keeps selling — from 000001, never "used all its receipt numbers".
  await withBoxes(cloud, async ({ boot, stop, dir }) => {
    const e = await boot(await dir('box1'), 'lane-4');
    await e.refreshStorePack!();
    expect(await sell(e, 'lane-4')).toBe('S2L4-000001');
    await e.syncOnce!();
    await stop(e);
  });
  // A plausible report IS folded (a voided bill keeps its number), and a re-send is the same record.
  const key = `hr-${randomUUID()}`;
  const ok = await report(cloud, 'u-box-2', S2, [{ prefix: 'S2L4-', through: 7 }], key);
  expect((ok.body as { recorded: { receiptNumbersIssued: unknown[] } }).recorded.receiptNumbersIssued).toEqual([{ prefix: 'S2L4-', through: 7 }]);
  expect(await bankedThrough(cloud, 'S2L4-')).toBe(7);
  // The owner sees the refused reports as findings, not a locked till.
  const c = component(await observed(cloud), `box_bill_numbers:${S2}`);
  expect(c?.detail).toMatch(/S2L4- through 999999, far beyond/);
  expect(component(await observed(cloud), `box_bill_numbers:${S1}`)?.detail).toMatch(/issued S2L4- to a till of ANOTHER store/);
  expect(c?.detail).not.toMatch(/ZZABCDEF/);
}

async function salesLostByARestore(cloud: Cloud): Promise<void> {
  await withBoxes(cloud, async ({ boot, stop, setCut, dir, root }) => {
    const data = await dir('lost-data');
    const w = { EDGE_WITNESS_DIR: join(root, 'lost-witness') };
    const a = await boot(data, 'lane-6', w);
    await a.refreshStorePack!();
    expect(await sell(a, 'lane-6')).toBe('S2L6-000001');
    expect(await a.syncOnce!()).toMatchObject({ sent: 1 });
    const backup = join(root, 'lost-backup');
    await cp(data, backup, { recursive: true }); // the data folder only — never the witness
    setCut(true);
    expect([await sell(a, 'lane-6'), await sell(a, 'lane-6')]).toEqual(['S2L6-000002', 'S2L6-000003']); // never synced
    await stop(a);
    await rm(data, { recursive: true, force: true });
    await cp(backup, data, { recursive: true }); // the restore
    const r = await boot(data, 'lane-6', w);
    expect(await sell(r, 'lane-6')).toMatch(/^ZZ/);
    setCut(false);
    await r.refreshStorePack!();
    expect(await sell(r, 'lane-6')).toBe('S2L6-000004');
    // A number given and abandoned at the till (never on a bill) — never named "never received".
    const t = bootPos({ laneId: 'lane-6', taxPercent: 0, lanePort: r.lane!.port });
    await signInTill(t, 'u-cash2');
    expect(await t.nextReceipt()).toBe('S2L6-000005');
    await r.syncOnce!();
    expect(await r.reportBoxHealth!()).toBe(true);
    await stop(r);

    // Within the grace period: nothing named yet (the box may still be sending).
    expect((((await observed(cloud)).observed.boxes.find((b) => b.storeId === S2)?.billNumberFindings) ?? []).filter((f) => f.kind === 'issued_never_received')).toEqual([]);
    // After it: head office names the prefix and the range it never received — and nothing it did receive.
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    try {
      vi.setSystemTime(Date.now() + (UNRECEIVED_GRACE_MINUTES + 1) * 60_000);
      const o = await observed(cloud);
      const lost = (o.observed.boxes.find((b) => b.storeId === S2)?.billNumberFindings ?? []).filter((f) => f.kind === 'issued_never_received' && f.prefix === 'S2L6-'); // (on PostgreSQL the tenant is shared with the other scenarios)
      expect(lost).toEqual([expect.objectContaining({ prefix: 'S2L6-', ranges: [[2, 3]] })]);
      const c = component(o, `box_bill_numbers:${S2}`);
      expect(c?.status).toBe('degraded');
      expect(c?.detail).toMatch(/bills issued but never received: .*S2L6-000002 to S2L6-000003/);
      expect(c?.detail).not.toMatch(/S2L6-000001|S2L6-000004|S2L6-000005/);
    } finally {
      vi.useRealTimers();
    }
  });
}

/**
 * Verifier r20 LOST-1 — through a REAL store computer: bills it still holds unsent are said, per prefix, on its health
 * report (how many, lowest and highest count), and head office never names them "never received" however long they wait.
 */
async function billsStillOnTheBoxAreNotLost(cloud: Cloud): Promise<void> {
  expect((await cloud.call('POST', `/v1/stores/${S2}/tills/lane-7/receipt-prefix`, OWNER, { prefix: 'S2L7-' }, `pfx-lane-7-${randomUUID()}`)).status).toBe(201);
  await withBoxes(cloud, async ({ boot, stop, dir }) => {
    // Head office refuses nothing; only the SALES fail to arrive (a slow link timing out on them), the reports get through.
    const viaCloud = globalThis.fetch;
    let blockSales = true;
    const reports: { receiptNumbersIssued?: { prefix: string; unsent?: unknown }[] }[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      if (blockSales && /\/v1\/sales$/.test(new URL(u).pathname)) throw new Error('timed out');
      if (u.endsWith('/v1/store-computers/health-reports') && init?.body !== undefined) reports.push(JSON.parse(String(init.body)) as never);
      return viaCloud(url, init);
    }) as unknown as typeof globalThis.fetch;
    try {
      const e = await boot(await dir('lost1'), 'lane-7');
      await e.refreshStorePack!();
      expect([await sell(e, 'lane-7'), await sell(e, 'lane-7'), await sell(e, 'lane-7')]).toEqual(['S2L7-000001', 'S2L7-000002', 'S2L7-000003']);
      await e.syncOnce!();
      expect(await e.reportBoxHealth!()).toBe(true);
      const said = reports.at(-1)?.receiptNumbersIssued?.find((x) => x.prefix === 'S2L7-');
      expect(said).toMatchObject({ through: 3, soldThrough: 3, unsent: { count: 3, from: 1, to: 3 } });
      vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
      try {
        vi.setSystemTime(Date.now() + (UNRECEIVED_GRACE_MINUTES + 5) * 60_000);
        expect(await e.reportBoxHealth!()).toBe(true); // still holding them, long past the grace
        const o = await observed(cloud);
        expect((o.observed.boxes.find((b) => b.storeId === S2)?.billNumberFindings ?? []).filter((f) => f.prefix === 'S2L7-')).toEqual([]);
        // The link carries the sales again: they are banked, the box says it holds none.
        blockSales = false;
        expect(await e.syncOnce!()).toMatchObject({ sent: 3 });
        // (The fake clock moves in 20 ms steps; a report is keyed by its time, so the next one is a moment later.)
        vi.setSystemTime(Date.now() + 1_000);
        expect(await e.reportBoxHealth!()).toBe(true);
        expect(reports.at(-1)?.receiptNumbersIssued?.find((x) => x.prefix === 'S2L7-')?.unsent).toEqual({ count: 0 });
        vi.setSystemTime(Date.now() + (UNRECEIVED_GRACE_MINUTES + 5) * 60_000);
        expect((((await observed(cloud)).observed.boxes.find((b) => b.storeId === S2)?.billNumberFindings) ?? []).filter((f) => f.prefix === 'S2L7-')).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
      await stop(e);
    } finally {
      globalThis.fetch = viaCloud;
    }
  });
}

function memoryCloud(tenant: string): { cloud: Cloud; ready: Promise<void> } {
  const h = apiHarness();
  const cloud: Cloud = {
    tenant, url: 'https://cloud.example.test',
    call: (method, path, user, body, key, branchId) => h.raw({
      method, path, token: TEST_IDP.issue({ sub: user, tenantId: tenant, ...(branchId === undefined ? {} : { branchId }) }),
      ...(body === undefined ? {} : { body }), ...(key === undefined ? {} : { idempotencyKey: key }),
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
  return { cloud, ready: (async () => { await h.seedOwner(tenant, OWNER); await setUp(cloud); })() };
}

describe('verifier r19: a store computer says when its bill numbers are at risk (memory)', () => {
  it('OB87-1: an unopenable witness is loud on the box and at head office, and never repeats a number', async () => {
    const { cloud, ready } = memoryCloud(randomUUID()); await ready;
    await witnessSelfCheck(cloud);
  }, 120_000);
  it('OB87-2: two boxes sharing one witness folder are not a restore on every start, and it is said', async () => {
    const { cloud, ready } = memoryCloud(randomUUID()); await ready;
    await sharedWitnessFolder(cloud);
  }, 120_000);
  it('BOX-1: an implausible report is refused for the high-water and shown — the till keeps selling', async () => {
    const { cloud, ready } = memoryCloud(randomUUID()); await ready;
    await aReportNeverLocksATill(cloud);
  }, 120_000);
  it('sales lost by a restore: head office names the bills issued but never received', async () => {
    const { cloud, ready } = memoryCloud(randomUUID()); await ready;
    await salesLostByARestore(cloud);
  }, 120_000);
  it('r20 LOST-1: bills the box still holds unsent are said per prefix, and never called lost', async () => {
    const { cloud, ready } = memoryCloud(randomUUID()); await ready;
    await billsStillOnTheBoxAreNotLost(cloud);
  }, 120_000);
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(DATABASE_URL === undefined)('verifier r19: a store computer says when its bill numbers are at risk (PostgreSQL, over HTTP)', () => {
  let real: RealCloud;
  let cloud: Cloud;
  beforeAll(async () => {
    real = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId: randomUUID(), owner: OWNER, packSigningKey: TEST_PACK_KEY });
    const send = async (method: HttpRequest['method'], path: string, token: string, body?: unknown, key?: string): Promise<Reply> => {
      const res = await fetch(`${real.baseUrl}${path}`, {
        method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(key === undefined ? {} : { 'idempotency-key': key }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return { status: res.status, body: text === '' ? null : JSON.parse(text) as unknown };
    };
    cloud = {
      tenant: real.tenantId, url: real.baseUrl,
      call: (method, path, user, body, key, branchId) => send(method, path, TEST_IDP.issue({ sub: user, tenantId: real.tenantId, ...(branchId === undefined ? {} : { branchId }) }), body, key),
      grant: (user, role, scope) => real.grant(user, role, undefined, scope),
      fetchFor: (saved, isCut) => (async (url: string, init?: RequestInit): Promise<Response> => {
        if (String(url).startsWith(real.baseUrl) && isCut()) throw new Error('network down');
        return saved(url, init);
      }) as unknown as typeof globalThis.fetch,
    };
    await setUp(cloud);
  }, 120_000);
  afterAll(async () => { await real?.stop(); });

  it('OB87-1: an unopenable witness is loud on the box and at head office', async () => { await witnessSelfCheck(cloud); }, 240_000);
  it('OB87-2: a shared witness folder', async () => { await sharedWitnessFolder(cloud); }, 240_000);
  it('BOX-1: a report never locks a till', async () => { await aReportNeverLocksATill(cloud); }, 240_000);
  it('sales lost by a restore are named', async () => { await salesLostByARestore(cloud); }, 240_000);
  it('r20 LOST-1: bills still on the box are never called lost', async () => { await billsStillOnTheBoxAreNotLost(cloud); }, 240_000);
});
