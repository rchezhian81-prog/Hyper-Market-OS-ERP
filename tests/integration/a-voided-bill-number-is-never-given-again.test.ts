import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { apiHarness, TEST_IDP, TEST_PACK_KEY } from '../support/api-harness';
import { startRealCloud, type RealCloud } from '../support/real-store';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { issueTillPins, signInTill } from '../support/till-operator';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { SqlSnapshotStore } from '../../packages/persistence/src/snapshot';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM, bankedReceiptCounts, bankedReceiptCountsByFullScan } from '../../services/api/src/adapters';

/**
 * **Verifier r18 item 6 (voided numbers) and OB85-2 (cost) — the high-water a store pack carries.**
 *
 *   1. A bill number the box GAVE but no bill used (a voided or abandoned bill — the customer may have seen it) never
 *      reaches head office as a sale; the box now reports the highest count it gave per prefix with its health, head office
 *      folds it into the store's `bankedThrough`, and a REPLACEMENT box (a fresh disk) resumes above it — never re-giving it.
 *      Another store's box cannot move this store's count (its report is kept under its own store).
 *   2. The incremental high-water equals the full scan on PostgreSQL, with the durable snapshot store, as the shop trades.
 */

const OWNER = 'u-owner';
const S1 = 'S1'; const S2 = 'S2';
const SETTINGS = { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 15 };

interface Reply { readonly status: number; readonly body: unknown }
interface Cloud {
  readonly tenant: string;
  readonly url: string;
  call(method: HttpRequest['method'], path: string, user: string, body?: unknown, key?: string, branchId?: string): Promise<Reply>;
  grant(user: string, role: string, scope: readonly string[] | 'all'): Promise<void>;
  fetchFor(saved: typeof globalThis.fetch): typeof globalThis.fetch;
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
}

const bankedThrough = async (cloud: Cloud, prefix: string): Promise<number | undefined> =>
  (((await cloud.call('GET', `/v1/store-packs/${S2}`, OWNER)).body as { sections: { receiptSeries?: { prefix: string; bankedThrough: number }[] } }).sections.receiptSeries ?? [])
    .find((s) => s.prefix === prefix)?.bankedThrough;

async function aVoidedNumberIsNeverGivenAgain(cloud: Cloud): Promise<void> {
  expect((await cloud.call('POST', `/v1/stores/${S2}/tills/lane-7/receipt-prefix`, OWNER, { prefix: 'S2L7-' }, `pfx-${randomUUID()}`)).status).toBe(201);
  const dirs: string[] = [];
  const edges: EdgeProcess[] = [];
  const saved = globalThis.fetch;
  // Round 25 · OB-94: every health report the box sends is kept here too, to read what it said.
  const sent: { receiptNumbersIssued?: unknown }[] = [];
  const toCloud = cloud.fetchFor(saved);
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/v1/store-computers/health-reports')) sent.push(JSON.parse(String(init?.body)) as { receiptNumbersIssued?: unknown });
    return toCloud(url, init);
  }) as typeof globalThis.fetch;
  const boot = async (): Promise<EdgeProcess> => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-void-'));
    dirs.push(dir, `${dir}-witness`);
    await issueTillPins(dir, TEST_PACK_KEY, ['u-cash2']);
    const e = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: cloud.tenant, PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-7',
      CLOUD_API_URL: cloud.url, CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box-2', tenantId: cloud.tenant, branchId: S2 }), EDGE_STORE_PACK_SOURCE: 'head-office', EDGE_STORE_ID: S2,
    }, () => {}))!;
    edges.push(e);
    return e;
  };
  try {
    const box = await boot();
    expect(await box.refreshStorePack!()).toMatchObject({ status: 'updated' });
    const t = bootPos({ laneId: 'lane-7', taxPercent: 0, lanePort: box.lane!.port });
    await signInTill(t, 'u-cash2');
    const first = await t.nextReceipt();
    t.scan({ productId: 'P1', description: 'Toor dal 1kg', unitPriceMinor: 7_000, qty: 1 });
    await t.tenderCash(`S-${first}`, first, new Date().toISOString());
    expect(first).toBe('S2L7-000001');
    expect(await box.syncOnce!()).toMatchObject({ sent: 1, dead: 0 });
    // The next bill is numbered (the customer sees S2L7-000002 on the screen) and then given up: no sale ever carries it.
    const t2 = bootPos({ laneId: 'lane-7', taxPercent: 0, lanePort: box.lane!.port });
    await signInTill(t2, 'u-cash2');
    expect(await t2.nextReceipt()).toBe('S2L7-000002');
    expect(await bankedThrough(cloud, 'S2L7-')).toBe(1); // head office has banked only 000001
    // The box's health report carries what it GAVE: head office's count for the prefix moves to 2.
    expect(await box.reportBoxHealth!()).toBe(true);
    expect(await bankedThrough(cloud, 'S2L7-')).toBe(2);
    // Round 25 · OB-94 (verifier r24 NEW-2): the till's next bill is sold (S2L7-000003). The box now says S2L7-000002 was
    // given and never put on a bill (`unused`), so head office never names it "never received" nor has anyone look for a
    // paper bill that never was — and head office accepts the report (a malformed one is refused, below).
    const third = await t2.nextReceipt();
    t2.scan({ productId: 'P1', description: 'Toor dal 1kg', unitPriceMinor: 7_000, qty: 1 });
    await t2.tenderCash(`S-${third}`, third, new Date().toISOString());
    expect(third).toBe('S2L7-000003');
    expect(await box.reportBoxHealth!()).toBe(true);
    expect(sent.at(-1)?.receiptNumbersIssued).toEqual([expect.objectContaining({ prefix: 'S2L7-', through: 3, soldThrough: 3, unused: [[2, 2]] })]);
    expect(await bankedThrough(cloud, 'S2L7-')).toBe(3);
    // Another store's box saying it gave S2L7- up to 50 does not move store 2's count (kept under its own store).
    const foreign = await cloud.call('POST', '/v1/store-computers/health-reports', 'u-box-1', {
      observedAt: new Date().toISOString(), disk: { freeBytes: 1, totalBytes: 2, salesLogUsedBytes: 0, salesLogCapacityBytes: 1, reserveBytes: 0 },
      queue: { unsent: 0, deadLettered: 0 }, tills: [], receiptNumbersIssued: [{ prefix: 'S2L7-', through: 50 }],
    }, `hr-${randomUUID()}`, S1);
    expect(foreign.status).toBe(200);
    expect(await bankedThrough(cloud, 'S2L7-')).toBe(3);
    // A malformed claim is refused by name, nothing kept.
    const bad = await cloud.call('POST', '/v1/store-computers/health-reports', 'u-box-2', {
      observedAt: new Date().toISOString(), disk: { freeBytes: 1, totalBytes: 2, salesLogUsedBytes: 0, salesLogCapacityBytes: 1, reserveBytes: 0 },
      queue: { unsent: 0, deadLettered: 0 }, tills: [], receiptNumbersIssued: [{ prefix: 'S2L7-', through: 1_000_000 }],
    }, `hr-${randomUUID()}`, S2);
    expect(bad.status).toBe(400);

    // The box is REPLACED (a fresh disk): online, it resumes above the voided number — never re-giving S2L7-000002 or 000003.
    await box.stop(); edges.splice(edges.indexOf(box), 1);
    const replacement = await boot();
    expect(await replacement.refreshStorePack!()).toMatchObject({ status: 'updated' });
    const t3 = bootPos({ laneId: 'lane-7', taxPercent: 0, lanePort: replacement.lane!.port });
    await signInTill(t3, 'u-cash2');
    expect(await t3.nextReceipt()).toBe('S2L7-000004');
  } finally {
    for (const e of edges.splice(0)) await e.stop();
    globalThis.fetch = saved;
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  }
}

describe('a voided bill number is never given again (memory)', () => {
  it('the box reports what it gave; a replacement resumes above it', async () => {
    const tenant = randomUUID();
    const h = apiHarness();
    await h.seedOwner(tenant, OWNER);
    const cloud: Cloud = {
      tenant, url: 'https://cloud.example.test',
      call: (method, path, user, body, key, branchId) => h.raw({
        method, path, token: TEST_IDP.issue({ sub: user, tenantId: tenant, ...(branchId === undefined ? {} : { branchId }) }),
        ...(body === undefined ? {} : { body }), ...(key === undefined ? {} : { idempotencyKey: key }),
      }),
      grant: (user, role, scope) => h.provisionRole(tenant, user, role, scope),
      fetchFor: (saved) => (async (url: string, init: RequestInit = {}): Promise<Response> => {
        if (String(url).startsWith('http://127.0.0.1:')) return saved(url, init);
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
    await aVoidedNumberIsNeverGivenAgain(cloud);
  }, 90_000);
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(DATABASE_URL === undefined)('the pack high-water on PostgreSQL', () => {
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
      fetchFor: (saved) => saved,
    };
    await setUp(cloud);
  }, 120_000);
  afterAll(async () => { await real?.stop(); });

  it('a voided bill number is never given again (over HTTP)', async () => { await aVoidedNumberIsNeverGivenAgain(cloud); }, 180_000);

  it('the incremental high-water equals the full scan, with the durable snapshot store, as the shop trades', async () => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
    const sql = pgPoolClient(pool);
    try {
      const store = new SqlEventStore(sql);
      const snapshots = new SqlSnapshotStore(sql);
      const T = randomUUID();
      await store.registerTenant(T, 'high-water');
      const at = new Date().toISOString();
      const trade = async (from: number, to: number): Promise<void> => {
        const batch = [];
        for (let i = from; i < to; i += 1) {
          const count = i % 97 === 0 && i > 0 ? Math.max(1, Math.floor(i / 4) - 30) : Math.floor(i / 4) + 1;
          const rn = `S9L${i % 4}-${String(count).padStart(6, '0')}`;
          batch.push({ stream: STREAM.sales, event: makeEvent({ id: `rn-${T}-${i}`, type: 'ReceiptNumberIssued', occurredAt: at, idempotencyKey: `receipt-${T}-${rn}-${i}`, source: 'test', payload: { receiptNumber: rn, saleId: `S-${i}` } }) });
          if (i % 9 === 0) batch.push({ stream: STREAM.returns, event: makeEvent({ id: `ret-${T}-${i}`, type: 'ReturnRecorded', occurredAt: at, idempotencyKey: `ret-${T}-${i}`, source: 'test', payload: { returnId: `RT-${i}`, number: `R-lane-${i % 2}-${String(Math.floor(i / 9) + 1).padStart(6, '0')}` } }) });
        }
        await store.appendBatch(T, batch);
      };
      const same = async (): Promise<void> => {
        const a = await bankedReceiptCounts(store, T, { snapshots });
        const b = await bankedReceiptCountsByFullScan(store, T);
        expect(new Map([...a].sort())).toEqual(new Map([...b].sort()));
      };
      await trade(0, 900); await same();
      await trade(900, 1_500); await same(); await same();
      // Verifier r19 HW-1: the fenced snapshot (@2) — advanced only to a position every transaction below which has finished.
      expect(await snapshots.load(T, STREAM.sales, 'receipt-high-water@2:ReceiptNumberIssued')).toBeDefined();
      await trade(1_500, 1_600); await same();
    } finally {
      await pool.end();
    }
  }, 180_000);
});
