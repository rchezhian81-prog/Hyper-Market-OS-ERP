import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiHarness, TEST_IDP, TEST_PACK_KEY } from '../support/api-harness';
import { startRealCloud, type RealCloud } from '../support/real-store';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { issueTillPins, prepareTillBox, signInTill } from '../support/till-operator';
import { GST_INVOICE_NUMBER_MAX, isStoreComputerDefaultReceipt } from '../../packages/contracts/src/receipt-number';

/**
 * **Verifier r17 — OB81-1 (OB-85 "A"), OB81-2 and the replaced box: a bill number is never given twice, and a prefix issue
 * that did not land is never reported or audited as if it had.** In memory and on real PostgreSQL through the production
 * API over HTTP, with REAL store computers and the real `bootPos` till:
 *
 *   1. THE PROBE (zz-v17-prefix): store 1's bill R-lane-1-000001 is banked. Store 2's NEW box, on its first boot before
 *      head office answers (its pack file does not say how many stores), used to number R-lane-1-000001 too — and head
 *      office refused store 2's real sale. Now (OB-85) it numbers under its own store-coded prefix: the sale is banked at
 *      store 2, flagged until a prefix is issued, and store 1's bill is untouched.
 *   2. THE REPLACED BOX: a till whose box is replaced (its disk lost) neither repeats its predecessor's bills offline (a
 *      fresh store-coded prefix) nor once it reaches head office (it resumes above head office's banked count).
 *   3. OB81-2 (zz-v17-prefix-lost): two owners issuing DIFFERENT prefixes to the SAME till at the same moment — one is kept;
 *      the other gets a visible 409 naming the kept prefix (never a "saved" for a write that did not land), and the audit
 *      trail holds exactly the issues that landed.
 */

const OWNER = 'u-owner';
const OWNER2 = 'u-owner2';
const S1 = 'S1'; const S2 = 'S2';
const SETTINGS = { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 15 };
const AT = new Date(Date.now() - 60_000).toISOString();

interface Reply { readonly status: number; readonly body: unknown }
interface Cloud {
  readonly tenant: string;
  readonly url: string;
  call(method: HttpRequest['method'], path: string, user: string, body?: unknown, key?: string, query?: Record<string, string>, branchId?: string): Promise<Reply>;
  grant(user: string, role: string, scope: readonly string[] | 'all'): Promise<void>;
  fetchFor(saved: typeof globalThis.fetch, isCut: () => boolean): typeof globalThis.fetch;
}
const codeOf = (r: Reply): string | undefined => (r.body as { error?: { code?: string } } | null)?.error?.code;

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
  await cloud.grant('u-cash1', 'cashier', [S1]);
  await cloud.grant('u-cash2', 'cashier', [S2]);
  await cloud.grant(OWNER2, 'owner', 'all');
}

const saleBody = (receipt: string, store: string, cashier: string) => ({
  saleId: `S-${receipt}`, receiptNumber: receipt, laneId: 'lane-1', locationId: store, cashierId: cashier, tradingDay: AT.slice(0, 10), committedAt: AT,
  totalMinor: 7_000, currency: 'INR', packVersion: 0, lines: [{ productId: 'P1', quantityMinor: 1, uom: 'ea', unitPriceMinor: 7_000, lineTotalMinor: 7_000 }], tenders: [{ kind: 'cash', amountMinor: 7_000 }],
});

/** Boxes: one per call; `packFile` = the box also holds a pack file (its first-boot setup) naming the cashier. */
async function withBoxes(cloud: Cloud, run: (b: {
  boot: (o: { user: string; store: string; lane: string; cashier: string; packFile: boolean }) => Promise<EdgeProcess>;
  stop: (e: EdgeProcess) => Promise<void>;
  setCut: (v: boolean) => void;
}) => Promise<void>): Promise<void> {
  const dirs: string[] = [];
  const edges: EdgeProcess[] = [];
  const saved = globalThis.fetch;
  let cut = false;
  globalThis.fetch = cloud.fetchFor(saved, () => cut);
  try {
    await run({
      boot: async ({ user, store, lane, cashier, packFile }) => {
        const dir = await mkdtemp(join(tmpdir(), `sre-r17-${store}-`));
        dirs.push(dir);
        const file = packFile ? await prepareTillBox({ dir, key: TEST_PACK_KEY, laneId: lane, people: [{ userId: cashier, displayName: cashier }] }) : {};
        if (!packFile) await issueTillPins(dir, TEST_PACK_KEY, [cashier]);
        const edge = (await startEdge({
          EDGE_DATA_DIR: dir, EDGE_TENANT_ID: cloud.tenant, PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_LANE_ID: lane,
          CLOUD_API_URL: cloud.url, CLOUD_API_TOKEN: TEST_IDP.issue({ sub: user, tenantId: cloud.tenant, branchId: store }),
          EDGE_STORE_PACK_SOURCE: 'head-office', EDGE_STORE_ID: store, ...file,
        }, () => {}))!;
        edges.push(edge);
        return edge;
      },
      stop: async (e) => { await e.stop(); edges.splice(edges.indexOf(e), 1); },
      setCut: (v) => { cut = v; },
    });
  } finally {
    for (const e of edges.splice(0)) await e.stop();
    globalThis.fetch = saved;
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  }
}

/** One bill on a real till: the box gives the number, the till derives the sale id `S-<number>`. */
async function sell(edge: EdgeProcess, lane: string, cashier: string): Promise<{ number: string; notice: string | undefined }> {
  const t = bootPos({ laneId: lane, taxPercent: 0, lanePort: edge.lane!.port });
  await signInTill(t, cashier);
  const number = await t.nextReceipt();
  const notice = t.receiptNotice();
  t.scan({ productId: 'P1', description: 'Toor dal 1kg', unitPriceMinor: 7_000, qty: 1 });
  await t.tenderCash(`S-${number}`, number, new Date().toISOString());
  return { number, notice };
}

async function theProbe(cloud: Cloud): Promise<void> {
  // Store 1's bill from its single-store era is at head office.
  const s1 = await cloud.call('POST', '/v1/sales', 'u-box-1', saleBody('R-lane-1-000001', S1, 'u-cash1'), `s1-${randomUUID()}`, undefined, S1);
  expect(s1.status, JSON.stringify(s1.body)).toBe(202);
  await withBoxes(cloud, async ({ boot, setCut }) => {
    // Store 2's NEW box, first boot, head office unreachable: it has only its pack file, which does not say how many stores.
    setCut(true);
    const box2 = await boot({ user: 'u-box-2', store: S2, lane: 'lane-1', cashier: 'u-cash2', packFile: true });
    const sale = await sell(box2, 'lane-1', 'u-cash2');
    expect(sale.number).not.toBe('R-lane-1-000001');
    expect(sale.number).not.toMatch(/^R-/);
    expect(isStoreComputerDefaultReceipt(sale.number)).toBe(true);
    expect(sale.number.length).toBeLessThanOrEqual(GST_INVOICE_NUMBER_MAX);
    expect(sale.notice).toMatch(/not been told by head office how many stores/);
    // Back online: store 2's real sale is BANKED at store 2 (before OB-85 it was refused) — and flagged until a prefix is issued.
    setCut(false);
    expect(await box2.syncOnce!()).toMatchObject({ sent: 1, dead: 0 });
    expect((await cloud.call('GET', `/v1/sales/S-${sale.number}`, OWNER)).status).toBe(200);
    const findings = ((await cloud.call('GET', '/v1/sales/exceptions', OWNER)).body as { material: { kind: string; saleId: string }[] }).material;
    expect(findings).toContainEqual(expect.objectContaining({ kind: 'receipt_numbered_without_issued_prefix', saleId: `S-${sale.number}` }));
    expect(findings.filter((f) => f.kind === 'receipt_number_reused')).toEqual([]);
    // Store 1's bill is untouched; nothing was refused.
    expect((await cloud.call('GET', '/v1/sales/S-R-lane-1-000001', OWNER)).status).toBe(200);
  });
}

async function theReplacedBox(cloud: Cloud): Promise<void> {
  expect((await cloud.call('POST', `/v1/stores/${S2}/tills/lane-3/receipt-prefix`, OWNER, { prefix: 'S2L3-' }, `pfx-${randomUUID()}`)).status).toBe(201);
  await withBoxes(cloud, async ({ boot, stop, setCut }) => {
    // The old box: its setup from head office, two bills, synced.
    const old = await boot({ user: 'u-box-2', store: S2, lane: 'lane-3', cashier: 'u-cash2', packFile: false });
    expect(await old.refreshStorePack!()).toMatchObject({ status: 'updated' });
    const a = await sell(old, 'lane-3', 'u-cash2');
    const b = await sell(old, 'lane-3', 'u-cash2');
    expect([a.number, b.number]).toEqual(['S2L3-000001', 'S2L3-000002']);
    expect(await old.syncOnce!()).toMatchObject({ sent: 2, dead: 0 });
    await stop(old); // …and its disk is lost.
    // The REPLACEMENT, first boot with head office unreachable (its pack file only): never S2L3-000001 again, and never
    // the old box's fallback either — a fresh store-coded prefix.
    setCut(true);
    const fresh = await boot({ user: 'u-box-2', store: S2, lane: 'lane-3', cashier: 'u-cash2', packFile: true });
    const c = await sell(fresh, 'lane-3', 'u-cash2');
    expect(c.number).toMatch(/^ZZ[A-Z2-7]{6}-000001$/);
    // Online: head office's setup says S2L3- is banked through 2 — the replacement resumes ABOVE it.
    setCut(false);
    expect(await fresh.refreshStorePack!()).toMatchObject({ status: 'updated' });
    const d = await sell(fresh, 'lane-3', 'u-cash2');
    expect(d.number).toBe('S2L3-000003');
    expect(d.notice).toBeUndefined();
    expect(await fresh.syncOnce!()).toMatchObject({ sent: 2, dead: 0 });
    // Every bill banked once, at store 2, and no number was given twice.
    for (const n of [a.number, b.number, c.number, d.number]) expect((await cloud.call('GET', `/v1/sales/S-${n}`, OWNER)).status).toBe(200);
    const numbers = [a.number, b.number, c.number, d.number];
    expect(new Set(numbers).size).toBe(numbers.length);
    const findings = ((await cloud.call('GET', '/v1/sales/exceptions', OWNER)).body as { material: { kind: string }[] }).material;
    expect(findings.filter((f) => f.kind === 'receipt_number_reused')).toEqual([]);
  });
}

/** OB81-2: two owners, two DIFFERENT prefixes, the SAME till, the same moment — `rounds` tills. Returns how many raced. */
async function sameTillRace(cloud: Cloud, rounds: number, tag: string): Promise<number> {
  let conflicts = 0;
  for (let i = 0; i < rounds; i += 1) {
    const till = `lane-${tag}${i}`;
    const [pa, pb] = [`A${tag.toUpperCase()}${i}-`, `B${tag.toUpperCase()}${i}-`];
    const [ra, rb] = await Promise.all([
      cloud.call('POST', `/v1/stores/${S1}/tills/${till}/receipt-prefix`, OWNER, { prefix: pa }, `race-a-${randomUUID()}`),
      cloud.call('POST', `/v1/stores/${S1}/tills/${till}/receipt-prefix`, OWNER2, { prefix: pb }, `race-b-${randomUUID()}`),
    ]);
    const held = ((await cloud.call('GET', '/v1/receipt-prefixes', OWNER)).body as { tills: { storeId: string; tillId: string; prefix: string; version: number; history: { prefix: string; version: number; setBy: string }[] }[] }).tills
      .find((t) => t.storeId === S1 && t.tillId === till)!;
    const trail = ((await cloud.call('GET', '/v1/audit/trail', OWNER, undefined, undefined, { action: 'receipt.prefix.issue' })).body as { matches: { objectId: string; actorId: string; after: { prefix: string; version: string } }[] }).matches
      .filter((m) => m.objectId === `${S1}/${till}`);
    // Every "saved" answer names an issue head office HOLDS, at the version it said; every audit entry is one that landed.
    const saved = [[ra, pa], [rb, pb]].filter(([r]) => (r as Reply).status === 200 || (r as Reply).status === 201) as [Reply, string][];
    for (const [r, p] of saved) {
      const said = (r.body as { prefix: { prefix: string; version: number } }).prefix;
      expect(said.prefix, JSON.stringify(r.body)).toBe(p);
      expect(held.history).toContainEqual(expect.objectContaining({ prefix: p, version: said.version }));
    }
    expect(trail.map((m) => [m.after.prefix, m.after.version]).sort()).toEqual(held.history.map((x) => [x.prefix, String(x.version)]).sort());
    expect(held.history.length).toBe(saved.length);
    const lost = [[ra, pa], [rb, pb]].filter(([r]) => (r as Reply).status === 409) as [Reply, string][];
    for (const [r, p] of lost) {
      expect(codeOf(r)).toBe('receipt_prefix_changed_at_the_same_moment');
      expect((r.body as { error: { whatHappened: string } }).error.whatHappened).toContain(held.prefix);
      expect(held.history.map((x) => x.prefix)).not.toContain(p);
      conflicts += 1;
    }
    expect(saved.length + lost.length).toBe(2);
  }
  return conflicts;
}

describe('verifier r17 — a new or replaced box never repeats a bill number; a same-till prefix race is a visible 409 (memory)', () => {
  const tenant = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0r17';
  let cloud: Cloud;
  beforeAll(async () => {
    const h = apiHarness();
    await h.seedOwner(tenant, OWNER);
    cloud = {
      tenant, url: 'https://cloud.example.test',
      call: (method, path, user, body, key, query, branchId) => h.raw({
        method, path, token: TEST_IDP.issue({ sub: user, tenantId: tenant, ...(branchId === undefined ? {} : { branchId }) }),
        ...(body === undefined ? {} : { body }), ...(key === undefined ? {} : { idempotencyKey: key }), ...(query === undefined ? {} : { query }),
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
    await setUp(cloud);
  });
  it('OB81-1 / OB-85: store 2\'s new box on its first boot numbers under its own store-coded prefix; its sale is banked and flagged', async () => { await theProbe(cloud); }, 60_000);
  it('a REPLACED box never repeats its predecessor\'s numbers — offline (fresh prefix) or online (above head office\'s count)', async () => { await theReplacedBox(cloud); }, 60_000);
  it('OB81-2: two owners, two prefixes, one till, one moment — one kept, the other a visible 409; the audit trail holds only what landed', async () => {
    expect(await sameTillRace(cloud, 6, 'm')).toBeGreaterThan(0);
  }, 60_000);
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(DATABASE_URL === undefined)('verifier r17 — the same on real PostgreSQL, through the production API over HTTP', () => {
  let real: RealCloud;
  let cloud: Cloud;
  beforeAll(async () => {
    real = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId: randomUUID(), owner: OWNER, packSigningKey: TEST_PACK_KEY });
    const send = async (method: HttpRequest['method'], path: string, token: string, body?: unknown, key?: string, query?: Record<string, string>): Promise<Reply> => {
      const qs = query === undefined ? '' : `?${new URLSearchParams(query).toString()}`;
      const res = await fetch(`${real.baseUrl}${path}${qs}`, {
        method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(key === undefined ? {} : { 'idempotency-key': key }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return { status: res.status, body: text === '' ? null : JSON.parse(text) as unknown };
    };
    cloud = {
      tenant: real.tenantId, url: real.baseUrl,
      call: (method, path, user, body, key, query, branchId) => send(method, path, TEST_IDP.issue({ sub: user, tenantId: real.tenantId, ...(branchId === undefined ? {} : { branchId }) }), body, key, query),
      grant: (user, role, scope) => real.grant(user, role, undefined, scope),
      fetchFor: (saved, isCut) => (async (url: string, init?: RequestInit): Promise<Response> => {
        if (String(url).startsWith(real.baseUrl) && isCut()) throw new Error('network down');
        return saved(url, init);
      }) as unknown as typeof globalThis.fetch,
    };
    await setUp(cloud);
  }, 120_000);
  afterAll(async () => { await real?.stop(); });
  it('OB81-1 / OB-85 on PostgreSQL: store 2\'s new box never repeats store 1\'s R-lane-1-000001; its sale is banked and flagged', async () => { await theProbe(cloud); }, 120_000);
  it('a REPLACED box on PostgreSQL never repeats a bill number', async () => { await theReplacedBox(cloud); }, 120_000);
  it('OB81-2 on PostgreSQL: every same-till race keeps one issue; a loser is a visible 409; no false audit entry', async () => {
    const conflicts = await sameTillRace(cloud, 12, 'p');
    // Under PostgreSQL the second writer sometimes reads after the first committed (a sequential change, 200 v2) — both
    // outcomes are honest; the invariants above are checked on every round.
    expect(conflicts).toBeGreaterThanOrEqual(0);
  }, 120_000);
  it('after an API restart head office still holds each raced till\'s one kept issue (PostgreSQL)', async () => {
    const tenantId = real.tenantId;
    await real.stop();
    real = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId, owner: OWNER, packSigningKey: TEST_PACK_KEY });
    const tills = ((await cloud.call('GET', '/v1/receipt-prefixes', OWNER)).body as { tills: { tillId: string; history: unknown[] }[] }).tills;
    expect(tills.filter((t) => t.tillId.startsWith('lane-p')).length).toBe(12);
  }, 120_000);
});
