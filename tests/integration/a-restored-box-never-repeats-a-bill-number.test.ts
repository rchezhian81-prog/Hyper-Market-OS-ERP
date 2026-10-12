import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiHarness, TEST_IDP, TEST_PACK_KEY } from '../support/api-harness';
import { startRealCloud, type RealCloud } from '../support/real-store';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { issueTillPins, signInTill } from '../support/till-operator';
import { isStoreComputerDefaultReceipt } from '../../packages/contracts/src/receipt-number';

/**
 * **OB-87 "A" (owner, 12 Oct 2026) · verifier r18 OB85-1 — a store computer restored from a backup of its own disk never
 * gives a bill number twice, and any repeated number that reaches head office is a visible finding.** In memory and on
 * real PostgreSQL through the production API over HTTP, with REAL store computers and the real `bootPos` till:
 *
 *   1. THE PROBE (zz-v18-restore): S2L5-000001 and -000002 are sold and banked; the data folder is restored from a backup
 *      taken between them onto a NEW computer (no witness). Its first bill used to be S2L5-000002 AGAIN (dead-lettered at
 *      the box, nothing at head office). Now it is a brand-new `ZZ…` prefix (`restored_from_backup`), banked; once head
 *      office's latest setup arrives the till resumes ABOVE head office's last banked bill (000003) — and a restart after
 *      that stays there.
 *   2. THE SAME COMPUTER: the backup is restored over the data folder of the computer that gave 000002 and 000003 after
 *      the backup WITHOUT syncing them. The witness outside the data folder holds them: they are never given again (listed
 *      as issued, not used), the box numbers under a fresh prefix offline (and across a restart), and once head office
 *      answers it resumes above its OWN highest (000004), not head office's (000001).
 *   3. HEAD OFFICE SEES A REPEATED NUMBER: a different bill under a banked sale id — under the same key (409 kept on the
 *      idempotency-conflicts register, and a `receipt_number_reused` finding) or a new key (202 "already banked" plus the
 *      finding) — is never silently dropped; an honest resend raises nothing; a re-sent conflict is one record.
 */

const OWNER = 'u-owner';
const S2 = 'S2';
const SETTINGS = { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 30 };
const AT = new Date(Date.now() - 60_000).toISOString();

interface Reply { readonly status: number; readonly body: unknown }
interface Cloud {
  readonly tenant: string;
  readonly url: string;
  call(method: HttpRequest['method'], path: string, user: string, body?: unknown, key?: string): Promise<Reply>;
  grant(user: string, role: string, scope: readonly string[] | 'all'): Promise<void>;
  fetchFor(saved: typeof globalThis.fetch, isCut: () => boolean): typeof globalThis.fetch;
}
const codeOf = (r: Reply): string | undefined => (r.body as { error?: { code?: string } } | null)?.error?.code;

async function setUp(cloud: Cloud): Promise<void> {
  const post = (path: string, body: unknown, key: string) => cloud.call('POST', path, OWNER, body, key);
  for (const [id, body] of [
    ['C1', { kind: 'company', name: 'SRE Retail' }],
    ['S1', { kind: 'branch', name: 'Store One', parentId: 'C1', companyId: 'C1' }],
    [S2, { kind: 'branch', name: 'Store Two', parentId: 'C1', companyId: 'C1' }],
  ] as const) expect((await post(`/v1/org/nodes/${id}`, body, `org-${id}`)).status).toBeLessThan(300);
  for (const s of ['S1', S2]) expect((await post(`/v1/stores/${s}/settings`, SETTINGS, `settings-${s}`)).status).toBeLessThan(300);
  await cloud.grant('u-box-2', 'store_computer', [S2]);
  await cloud.grant('u-cash2', 'cashier', [S2]);
}

interface Boxes {
  boot: (dir: string, opts?: { pins?: boolean }) => Promise<EdgeProcess>;
  stop: (e: EdgeProcess) => Promise<void>;
  setCut: (v: boolean) => void;
  dir: (tag: string) => Promise<string>;
}
async function withBoxes(cloud: Cloud, lane: string, run: (b: Boxes) => Promise<void>): Promise<void> {
  const dirs: string[] = [];
  const edges: EdgeProcess[] = [];
  const saved = globalThis.fetch;
  let cut = false;
  globalThis.fetch = cloud.fetchFor(saved, () => cut);
  try {
    await run({
      dir: async (tag) => { const d = await mkdtemp(join(tmpdir(), `sre-ob87-${tag}-`)); dirs.push(d, `${d}-witness`); return d; },
      boot: async (dir, opts) => {
        if (opts?.pins === true) await issueTillPins(dir, TEST_PACK_KEY, ['u-cash2']);
        const edge = (await startEdge({
          EDGE_DATA_DIR: dir, EDGE_TENANT_ID: cloud.tenant, PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_LANE_ID: lane,
          CLOUD_API_URL: cloud.url, CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box-2', tenantId: cloud.tenant, branchId: S2 }),
          EDGE_STORE_PACK_SOURCE: 'head-office', EDGE_STORE_ID: S2,
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
async function sell(edge: EdgeProcess, lane: string): Promise<{ number: string; notice: string | undefined }> {
  const t = bootPos({ laneId: lane, taxPercent: 0, lanePort: edge.lane!.port });
  await signInTill(t, 'u-cash2');
  const number = await t.nextReceipt();
  const notice = t.receiptNotice();
  t.scan({ productId: 'P1', description: 'Toor dal 1kg', unitPriceMinor: 7_000, qty: 1 });
  await t.tenderCash(`S-${number}`, number, new Date().toISOString());
  return { number, notice };
}
const laneStatus = async (edge: EdgeProcess): Promise<{ prefix: string; fallbackBecause?: string; issuedNotUsed: { receiptNumber: string }[]; restore?: { held: boolean; because?: string } }> =>
  (await (await fetch(`http://127.0.0.1:${edge.lane!.port}/lane/receipt-numbers`)).json()) as never;

const findings = async (cloud: Cloud): Promise<{ kind: string; saleId: string; detail: string }[]> => {
  const b = (await cloud.call('GET', '/v1/sales/exceptions', OWNER)).body as { material: { kind: string; saleId: string; detail: string }[]; critical: { kind: string; saleId: string; detail: string }[] };
  return [...b.material, ...b.critical];
};

async function restoredOntoANewComputer(cloud: Cloud): Promise<void> {
  expect((await cloud.call('POST', `/v1/stores/${S2}/tills/lane-5/receipt-prefix`, OWNER, { prefix: 'S2L5-' }, `pfx-${randomUUID()}`)).status).toBe(201);
  await withBoxes(cloud, 'lane-5', async ({ boot, stop, setCut, dir }) => {
    const oldDir = await dir('old');
    const old = await boot(oldDir, { pins: true });
    expect(await old.refreshStorePack!()).toMatchObject({ status: 'updated' });
    const a = await sell(old, 'lane-5');
    expect(await old.syncOnce!()).toMatchObject({ sent: 1, dead: 0 });
    const backup = await dir('backup');
    await cp(oldDir, backup, { recursive: true }); // the nightly backup of the data folder (never the witness)
    const b = await sell(old, 'lane-5');
    expect(await old.syncOnce!()).toMatchObject({ sent: 1, dead: 0 });
    expect([a.number, b.number]).toEqual(['S2L5-000001', 'S2L5-000002']);
    await stop(old);

    // The computer dies; the backup is restored onto a NEW one, with the internet down.
    setCut(true);
    const restored = await boot(backup);
    const c = await sell(restored, 'lane-5');
    expect(c.number).not.toBe('S2L5-000002');
    expect(isStoreComputerDefaultReceipt(c.number)).toBe(true);
    expect(c.notice).toMatch(/restored from a backup/);
    const held = await laneStatus(restored);
    expect(held).toMatchObject({ fallbackBecause: 'restored_from_backup', restore: { held: true, because: 'witness_missing' } });
    // A second bill while still held: the same fresh prefix, the next count — never an old number.
    const c2 = await sell(restored, 'lane-5');
    expect(c2.number.slice(0, -6)).toBe(c.number.slice(0, -6));

    // Back online: the restored bills are BANKED (no dead letter), and head office raises no reused number for them.
    setCut(false);
    expect(await restored.syncOnce!()).toMatchObject({ dead: 0 });
    expect((await findings(cloud)).filter((f) => f.kind === 'receipt_number_reused')).toEqual([]);
    expect(['updated', 'renewed', 'unchanged']).toContain((await restored.refreshStorePack!()).status);
    const d = await sell(restored, 'lane-5');
    expect(d.number).toBe('S2L5-000003'); // above head office's last banked (000002)
    expect((await laneStatus(restored)).restore).toBeUndefined();
    await stop(restored);

    // A restart after head office answered stays on the till's own prefix (the clearing is on the log).
    setCut(true);
    const again = await boot(backup);
    expect((await sell(again, 'lane-5')).number).toBe('S2L5-000004');
    setCut(false);
  });
}

async function restoredOverTheSameComputer(cloud: Cloud): Promise<void> {
  expect((await cloud.call('POST', `/v1/stores/${S2}/tills/lane-6/receipt-prefix`, OWNER, { prefix: 'S2L6-' }, `pfx-${randomUUID()}`)).status).toBe(201);
  await withBoxes(cloud, 'lane-6', async ({ boot, stop, setCut, dir }) => {
    const box = await dir('same');
    const first = await boot(box, { pins: true });
    expect(await first.refreshStorePack!()).toMatchObject({ status: 'updated' });
    expect((await sell(first, 'lane-6')).number).toBe('S2L6-000001');
    expect(await first.syncOnce!()).toMatchObject({ sent: 1, dead: 0 });
    const backup = await dir('bk');
    await cp(box, backup, { recursive: true });
    // Two more bills that NEVER reach head office (the line is down), then the data folder is restored over.
    setCut(true);
    expect((await sell(first, 'lane-6')).number).toBe('S2L6-000002');
    expect((await sell(first, 'lane-6')).number).toBe('S2L6-000003');
    await stop(first);
    await rm(box, { recursive: true, force: true });
    await cp(backup, box, { recursive: true }); // restored over — the witness beside it is untouched

    const restored = await boot(box);
    const st = await laneStatus(restored);
    expect(st).toMatchObject({ fallbackBecause: 'restored_from_backup', restore: { held: true, because: 'witness_ahead_of_log' } });
    const fresh = await sell(restored, 'lane-6');
    expect(isStoreComputerDefaultReceipt(fresh.number)).toBe(true);
    await stop(restored);
    // A restart while still offline: still held, the same fresh prefix, counting on.
    const restarted = await boot(box);
    const fresh2 = await sell(restarted, 'lane-6');
    expect(fresh2.number.slice(0, -6)).toBe(fresh.number.slice(0, -6));
    expect(Number(fresh2.number.slice(-6))).toBe(Number(fresh.number.slice(-6)) + 1);

    // Online: head office banked only 000001, but this computer gave 000002 and 000003 — it resumes above its OWN highest.
    setCut(false);
    expect(['updated', 'renewed', 'unchanged']).toContain((await restarted.refreshStorePack!()).status);
    const after = await sell(restarted, 'lane-6');
    expect(after.number).toBe('S2L6-000004');
    // The two numbers given after the backup stay visible as issued, not used — never given again.
    expect((await laneStatus(restarted)).issuedNotUsed.map((i) => i.receiptNumber)).toEqual(expect.arrayContaining(['S2L6-000002', 'S2L6-000003']));
    expect(await restarted.syncOnce!()).toMatchObject({ dead: 0 });
  });
}

const saleBody = (saleId: string, receipt: string, totalMinor: number) => ({
  saleId, receiptNumber: receipt, laneId: 'lane-9', locationId: S2, cashierId: 'u-cash2', tradingDay: AT.slice(0, 10), committedAt: AT,
  totalMinor, currency: 'INR', packVersion: 0, lines: [{ productId: 'P1', quantityMinor: 1, uom: 'ea', unitPriceMinor: totalMinor, lineTotalMinor: totalMinor }], tenders: [{ kind: 'cash', amountMinor: totalMinor }],
});

async function headOfficeSeesARepeatedNumber(cloud: Cloud): Promise<void> {
  const tag = randomUUID().slice(0, 6).toUpperCase();
  const receipt = `S2Q${tag}-000002`.slice(0, 16);
  const saleId = `S-${receipt}`;
  const key = `sale-key-${tag}`;
  expect((await cloud.call('POST', '/v1/sales', 'u-box-2', saleBody(saleId, receipt, 7_000), key)).status).toBe(202);
  // An honest resend (same bill, same key; then same bill, new key): nothing raised.
  expect((await cloud.call('POST', '/v1/sales', 'u-box-2', saleBody(saleId, receipt, 7_000), key)).status).toBe(202);
  expect((await cloud.call('POST', '/v1/sales', 'u-box-2', saleBody(saleId, receipt, 7_000), `${key}-again`)).status).toBe(202);
  expect((await findings(cloud)).filter((f) => f.saleId === saleId && f.kind === 'receipt_number_reused')).toEqual([]);

  // A DIFFERENT bill under the same sale id and key (a box that re-issued the number): refused AND kept.
  const clash = await cloud.call('POST', '/v1/sales', 'u-box-2', saleBody(saleId, receipt, 9_900), key);
  expect(clash.status).toBe(409);
  expect(codeOf(clash)).toBe('idempotency_key_reused');
  const reused = (await findings(cloud)).filter((f) => f.saleId === saleId && f.kind === 'receipt_number_reused');
  expect(reused).toHaveLength(1);
  expect(reused[0]!.detail).toMatch(/NOT bank/);
  const list = async (): Promise<{ saleId?: string; receiptNumber?: string; idempotencyKey: string; userId: string }[]> =>
    ((await cloud.call('GET', '/v1/idempotency-conflicts', OWNER)).body as { conflicts: { saleId?: string; receiptNumber?: string; idempotencyKey: string; userId: string }[] }).conflicts;
  expect((await list()).filter((c) => c.idempotencyKey === key)).toEqual([expect.objectContaining({ saleId, receiptNumber: receipt, userId: 'u-box-2' })]);
  // The same conflicting request re-sent (the box retries): still refused, still ONE record.
  expect((await cloud.call('POST', '/v1/sales', 'u-box-2', saleBody(saleId, receipt, 9_900), key)).status).toBe(409);
  expect((await list()).filter((c) => c.idempotencyKey === key)).toHaveLength(1);
  // A cashier may not read the register (platform.health.read): refused.
  expect((await cloud.call('GET', '/v1/idempotency-conflicts', 'u-cash2')).status).toBe(403);

  // A different bill under a banked sale id with a NEW key: 202 "already banked" — and the finding, never silence.
  const tag2 = randomUUID().slice(0, 6).toUpperCase();
  const receipt2 = `S2R${tag2}-000007`.slice(0, 16);
  expect((await cloud.call('POST', '/v1/sales', 'u-box-2', saleBody(`S-${receipt2}`, receipt2, 5_000), `k1-${tag2}`)).status).toBe(202);
  const second = await cloud.call('POST', '/v1/sales', 'u-box-2', saleBody(`S-${receipt2}`, receipt2, 6_000), `k2-${tag2}`);
  expect(second.status).toBe(202);
  expect((second.body as { alreadyBanked: boolean }).alreadyBanked).toBe(true);
  expect((await findings(cloud)).filter((f) => f.saleId === `S-${receipt2}` && f.kind === 'receipt_number_reused')).toHaveLength(1);
}

function memoryCloud(tenant: string): { cloud: Cloud; ready: Promise<void> } {
  const h = apiHarness();
  const cloud: Cloud = {
    tenant, url: 'https://cloud.example.test',
    call: (method, path, user, body, key) => h.raw({
      method, path, token: TEST_IDP.issue({ sub: user, tenantId: tenant, ...(user === 'u-box-2' ? { branchId: S2 } : {}) }),
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

describe('OB-87: a restored store computer never repeats a bill number (memory)', () => {
  it('restored onto a new computer: a fresh prefix offline, then above head office\'s last banked bill', async () => {
    const { cloud, ready } = memoryCloud(randomUUID()); await ready;
    await restoredOntoANewComputer(cloud);
  }, 90_000);
  it('restored over the same computer: the witness keeps the numbers given after the backup', async () => {
    const { cloud, ready } = memoryCloud(randomUUID()); await ready;
    await restoredOverTheSameComputer(cloud);
  }, 90_000);
  it('head office keeps any repeated bill number as a visible finding', async () => {
    const { cloud, ready } = memoryCloud(randomUUID()); await ready;
    await headOfficeSeesARepeatedNumber(cloud);
  }, 60_000);
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(DATABASE_URL === undefined)('OB-87: a restored store computer never repeats a bill number (PostgreSQL, over HTTP)', () => {
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
      call: (method, path, user, body, key) => send(method, path, TEST_IDP.issue({ sub: user, tenantId: real.tenantId, ...(user === 'u-box-2' ? { branchId: S2 } : {}) }), body, key),
      grant: (user, role, scope) => real.grant(user, role, undefined, scope),
      fetchFor: (saved, isCut) => (async (url: string, init?: RequestInit): Promise<Response> => {
        if (String(url).startsWith(real.baseUrl) && isCut()) throw new Error('network down');
        return saved(url, init);
      }) as unknown as typeof globalThis.fetch,
    };
    await setUp(cloud);
  }, 120_000);
  afterAll(async () => { await real?.stop(); });

  it('restored onto a new computer', async () => { await restoredOntoANewComputer(cloud); }, 180_000);
  it('restored over the same computer', async () => { await restoredOverTheSameComputer(cloud); }, 180_000);
  it('head office keeps any repeated bill number as a visible finding', async () => { await headOfficeSeesARepeatedNumber(cloud); }, 120_000);
});
