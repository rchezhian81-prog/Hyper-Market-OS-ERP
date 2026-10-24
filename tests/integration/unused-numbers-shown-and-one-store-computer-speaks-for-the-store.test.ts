import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, InMemoryEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { InMemorySnapshotStore, SqlSnapshotStore, type SnapshotStore } from '../../packages/persistence/src/snapshot';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM, streamName, storeComputerReading } from '../../services/api/src/adapters';
import { UNRECEIVED_GRACE_MINUTES, FOLD_SNAPSHOT_EVERY, type BoxHealthRecord } from '../../services/platform/src/box-health';
import { ownerApprovedSetting } from '../support/owner-approved-setting';

/**
 * **Round 27 · owner decisions OB-100 "A", OB-101 "A", OB-102 "A" (13 Oct 2026, in writing) — through head office's
 * production routes (the store computer's health report, the sales intake, the observed health read, the bindings read), in
 * memory and on PostgreSQL.**
 *
 *   1. OB-100 (verifier r26 NEW-1, probes U1 and U4): the numbers a store computer reports as taken and never used are on the
 *      observed health read — per till and day, count and numbers, as an information line ("taken but never used"), never a
 *      "find the paper bill" alarm; and a sale head office HOLDS under a number the store computer kept calling unused after
 *      it was made is a finding by name (`unused_number_received`).
 *   2. OB-101 (verifier r26 NEW-3, probe B2): a second store computer's healthy report never hides the full disk of the one
 *      that holds the store's tills' prefixes; the second one is shown apart.
 *   3. NEW-5 (the bindings store-scope mutant): one store's manager reads only that store's bindings; the owner reads every store's.
 *   4. OB-102: the never-received fold's saved running result is kept in the snapshot store (PostgreSQL's projection_snapshot
 *      in production), a later read resumes from it, and deleting it changes no answer.
 */

const OWNER = 'u-owner';
const S1 = 'S1';
const S2 = 'S2';
const P = 'S1L1-';
const P2 = 'S2L1-';
const pad = (n: number): string => String(n).padStart(6, '0');
const AT = new Date(Date.now() - 60_000).toISOString();
const SETTINGS = { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 15 };

afterEach(() => { vi.useRealTimers(); });

interface Finding { kind: string; prefix: string; ranges?: [number, number][]; count?: number; since: string; detail: string }
interface Box { storeId: string; canRecordSales: boolean | null; computer?: string | null; otherComputers?: { computer: string; canRecordSales: boolean }[]; billNumberFindings?: Finding[]; unusedNumbers?: { prefix: string; day: string; count: number; ranges: [number, number][] }[] }
interface Observed { observed: { boxes: Box[] }; health: { components: { name: string; status: string; detail: string }[] } }
type Call = (method: 'GET' | 'POST' | 'PUT', path: string, user: string, body?: unknown, branchId?: string) => Promise<{ status: number; body: unknown }>;

async function shop(h: ApiHarness): Promise<{ T: string; call: Call }> {
  const T = randomUUID();
  await h.seedOwner(T, OWNER);
  const call: Call = (method, path, user, body, branchId) => h.request({
    method, path, userId: user, tenantId: T, ...(branchId === undefined ? {} : { branchId }),
    ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }),
  });
  expect((await ownerApprovedSetting(h, T, 'locale.time_zone', { value: 'UTC' }, OWNER)).status).toBe(200);
  for (const [id, body] of [
    ['C1', { kind: 'company', name: 'SRE Retail' }],
    [S1, { kind: 'branch', name: 'Store One', parentId: 'C1', companyId: 'C1' }],
    [S2, { kind: 'branch', name: 'Store Two', parentId: 'C1', companyId: 'C1' }],
  ] as const) expect((await call('POST', `/v1/org/nodes/${id}`, OWNER, body)).status).toBeLessThan(300);
  for (const s of [S1, S2]) expect((await call('POST', `/v1/stores/${s}/settings`, OWNER, SETTINGS)).status).toBeLessThan(300);
  await h.provisionRole(T, 'u-box', 'store_computer', [S1]);
  await h.provisionRole(T, 'u-box-2', 'store_computer', [S1]);
  await h.provisionRole(T, 'u-box-s2', 'store_computer', [S2]);
  await h.provisionRole(T, 'u-mgr-s1', 'store_manager', [S1]);
  await h.provisionRole(T, 'u-cash', 'cashier', [S1]);
  expect((await call('POST', `/v1/stores/${S1}/tills/lane-1/receipt-prefix`, OWNER, { prefix: P })).status).toBe(201);
  expect((await call('POST', `/v1/stores/${S2}/tills/lane-1/receipt-prefix`, OWNER, { prefix: P2 })).status).toBe(201);
  return { T, call };
}
const bank = async (call: Call, numbers: readonly number[], at = AT): Promise<void> => {
  for (const n of numbers) {
    const receipt = `${P}${pad(n)}`;
    const r = await call('POST', '/v1/sales', 'u-box', {
      saleId: `S-${receipt}`, receiptNumber: receipt, laneId: 'lane-1', locationId: S1, cashierId: 'u-cash', tradingDay: at.slice(0, 10), committedAt: at,
      totalMinor: 1_000, currency: 'INR', packVersion: 0, lines: [{ productId: 'P1', quantityMinor: 1, uom: 'ea', unitPriceMinor: 1_000, lineTotalMinor: 1_000 }],
      tenders: [{ kind: 'cash', amountMinor: 1_000 }],
    }, S1);
    expect(r.status).toBe(202);
  }
};
const DISK = { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1000, salesLogCapacityBytes: 1e7, reserveBytes: 1e6 };
const report = async (call: Call, issued: unknown, opts: { box?: string; store?: string; disk?: typeof DISK } = {}): Promise<void> => {
  const r = await call('POST', '/v1/store-computers/health-reports', opts.box ?? 'u-box', {
    observedAt: new Date().toISOString(), disk: opts.disk ?? DISK, queue: { unsent: 0, deadLettered: 0 }, tills: [], receiptNumbersIssued: issued,
  }, opts.store ?? S1);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
const observed = async (call: Call): Promise<Observed> => {
  const r = await call('GET', '/v1/platform/operational-health/observed', OWNER);
  expect(r.status).toBe(200);
  return r.body as Observed;
};
const boxOf = async (call: Call, storeId = S1): Promise<Box> => (await observed(call)).observed.boxes.find((b) => b.storeId === storeId)!;
function clock(): { travel: (minutes: number) => void } {
  const t0 = Date.now();
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  return { travel: (minutes) => { vi.setSystemTime(t0 + minutes * 60_000); } };
}

// ── 1. OB-100 (U1, U4) ───────────────────────────────────────────────────────────────────────────────────────────────
async function unusedNumbersAreShownAndAHeldOneIsAFinding(h: ApiHarness): Promise<void> {
  const { call } = await shop(h);
  await bank(call, [...Array.from({ length: 105 }, (_, i) => i + 1), 106, 107, 108, 109]); // 105 sold and banked; 110 never received
  const { travel } = clock();
  // The store computer says 105 (head office HOLDS its sale) and 110 (never received) were taken and never used — for hours.
  for (const k of [0, 30, 60, 90, 120, 150]) {
    travel(k); await report(call, [{ prefix: P, through: 110, soldThrough: 110, unsent: { count: 0 }, unused: [[105, 105], [110, 110]] }]);
  }
  travel(150 + UNRECEIVED_GRACE_MINUTES + 1);
  const box = await boxOf(call);
  const day = new Date().toISOString().slice(0, 10);
  // U1: 110 is SHOWN (count and number, per till and day) — and never "find the paper bill" (OB-94 kept).
  expect(box.unusedNumbers?.map((d) => [d.prefix, d.count, d.ranges])).toEqual([[P, 2, [[105, 105], [110, 110]]]]);
  expect(box.unusedNumbers?.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.day) && d.day <= day)).toBe(true);
  const info = (await observed(call)).health.components.find((c) => c.name === `box_unused_numbers:${S1}`)!;
  expect(info.status).toBe('ok');
  expect(info.detail).toMatch(/^taken but never used \(information — nothing to look for\)/);
  expect((box.billNumberFindings ?? []).filter((f) => f.kind === 'issued_never_received')).toEqual([]);
  // U4: head office holds a sale under 105, made before the store computer kept calling it unused — a finding by name.
  const contradiction = (box.billNumberFindings ?? []).filter((f) => f.kind === 'unused_number_received');
  expect(contradiction.map((f) => [f.prefix, f.ranges, f.count])).toEqual([[P, [[105, 105]], 1]]);
  expect(contradiction[0]!.detail).toMatch(/^does not fit: store S1's computer said .* that it gave S1L1-000105 and never put it on a bill, but head office holds a sale under that number/);
  expect(contradiction[0]!.detail).toMatch(/do NOT look for paper bills/);
  expect((await observed(call)).health.components.find((c) => c.name === `box_bill_numbers:${S1}`)?.status).toBe('degraded');
}

// ── 2. OB-101 (B2) ───────────────────────────────────────────────────────────────────────────────────────────────────
async function aSecondComputerNeverHidesTheBoundOnesFullDisk(h: ApiHarness): Promise<void> {
  const { call } = await shop(h);
  const { travel } = clock();
  travel(0); await report(call, [{ prefix: P, through: 10, soldThrough: 10, unsent: { count: 0 } }], { disk: { ...DISK, freeBytes: 0, salesLogUsedBytes: 1e7 } });
  travel(1); await report(call, [{ prefix: P, through: 5, soldThrough: 5, unsent: { count: 0 } }], { box: 'u-box-2' });
  const box = await boxOf(call);
  expect([box.canRecordSales, box.computer, box.otherComputers?.map((o) => [o.computer, o.canRecordSales])]).toEqual([false, 'u-box', [['u-box-2', true]]]);
  const disk = (await observed(call)).health.components.find((c) => c.name === `box_disk:${S1}`)!;
  expect(disk.status).toBe('down');
  expect(disk.detail).toMatch(/takes the store's health only from u-box/);
  // And the refusal of the second one is worded neutrally (OB-101 "A").
  const refused = (box.billNumberFindings ?? []).filter((f) => f.kind === 'report_refused');
  expect(refused[0]!.detail).toMatch(/^two store computers report bill numbers under S1L1- for store S1: u-box and u-box-2\. Head office uses u-box's reports for S1L1- because it was the first to report S1L1-/);
}

// ── 3. NEW-5 (bindings scope): bindings by store scope ───────────────────────────────────────────────────────────────────────────
async function aStoresManagerReadsOnlyItsOwnBindings(h: ApiHarness): Promise<void> {
  const { call } = await shop(h);
  await report(call, [{ prefix: P, through: 3, soldThrough: 3, unsent: { count: 0 } }]);
  await report(call, [{ prefix: P2, through: 4, soldThrough: 4, unsent: { count: 0 } }], { box: 'u-box-s2', store: S2 });
  const bindings = async (user: string, branch?: string): Promise<string[]> => {
    const r = await call('GET', '/v1/store-computers/prefix-bindings', user, undefined, branch);
    expect(r.status).toBe(200);
    return (r.body as { bindings: { storeId: string; prefix: string }[] }).bindings.map((b) => `${b.storeId}/${b.prefix}`);
  };
  expect(await bindings(OWNER)).toEqual([`${S1}/${P}`, `${S2}/${P2}`]);
  expect(await bindings('u-mgr-s1', S1)).toEqual([`${S1}/${P}`]);
}

// ── 4. OB-102: the saved running result, kept, resumed, and disposable ───────────────────────────────────────────────
async function theSavedResultIsKeptResumedAndDisposable(store: EventStore, snapshots: SnapshotStore, dropSaved: (T: string) => Promise<void>): Promise<void> {
  const T = randomUUID();
  await store.registerTenant(T, 'test/ob-102');
  await store.append(T, streamName(STREAM.org, 'till-receipt-prefixes'), makeEvent({
    id: `pfx-${P}`, type: 'TillReceiptPrefixIssued', occurredAt: AT, idempotencyKey: `pfx-${T}-${P}`, source: 'test/ob-102',
    payload: { storeId: S1, tillId: 'lane-1', prefix: P, version: 1, setAt: AT, setBy: OWNER },
  }));
  const t0 = Date.now() - 4 * 3_600_000;
  const records: BoxHealthRecord[] = Array.from({ length: FOLD_SNAPSHOT_EVERY * 3 }, (_, i) => {
    const at = new Date(t0 + i * 60_000).toISOString();
    return {
      storeId: S1, observedAt: at, receivedAt: at, reportedBy: 'u-box', clockAheadCorrected: false, tills: [], disk: DISK, queue: { unsent: 0, deadLettered: 0 },
      receiptNumbersIssued: [{ prefix: P, through: 100 + i, soldThrough: 100 + i, unsent: { count: 0 }, unused: [[50, 51]] }],
    };
  });
  const now = new Date().toISOString();
  const first = await storeComputerReading(store, T, records, now, { snapshots, timeZone: 'UTC' });
  expect(first.resumed).toBe(false);
  const saved = await snapshots.load(T, streamName(STREAM.org, 'store-computer-health'), 'never-received-fold@1');
  expect(saved?.result.eventCount).toBeGreaterThan(0);
  const second = await storeComputerReading(store, T, records, now, { snapshots, timeZone: 'UTC' });
  expect(second.resumed).toBe(true);
  expect([...second.findings]).toEqual([...first.findings]);
  expect([...second.unused]).toEqual([...first.unused]);
  // Named, as the fold of everything names them: the bills above banked (0) head office never received — the newest 500.
  expect(second.findings.get(S1)?.find((f) => f.kind === 'issued_never_received')?.ranges?.flat().length).toBeGreaterThan(0);
  expect(second.unused.get(S1)?.map((u) => u.runs.map((r) => [r.from, r.to]))).toEqual([[[50, 51]]]);
  await dropSaved(T);
  const third = await storeComputerReading(store, T, records, now, { snapshots, timeZone: 'UTC' });
  expect(third.resumed).toBe(false);
  expect([...third.findings]).toEqual([...first.findings]);
}

describe('round 27 · OB-100 / OB-101 / OB-102 (memory)', () => {
  it('OB-100 (U1/U4): unused numbers are shown per till and day; a held one said unused afterwards is a finding', async () => { await unusedNumbersAreShownAndAHeldOneIsAFinding(apiHarness()); }, 180_000);
  it('OB-101 (B2): a second store computer never hides the bound one\'s full disk; its refusal is neutral', async () => { await aSecondComputerNeverHidesTheBoundOnesFullDisk(apiHarness()); }, 180_000);
  it('NEW-5 (bindings scope): one store\'s manager reads only that store\'s bindings', async () => { await aStoresManagerReadsOnlyItsOwnBindings(apiHarness()); }, 180_000);
  it('OB-102: the saved running result is kept, resumed, and disposable', async () => {
    const snapshots = new InMemorySnapshotStore();
    await theSavedResultIsKeptResumedAndDisposable(new InMemoryEventStore(), snapshots, async (T) => {
      // A disposable result: replaced by an unusable one, the read starts again from nothing.
      await snapshots.save({ tenantId: T, stream: streamName(STREAM.org, 'store-computer-health'), projection: 'never-received-fold@1', takenAt: AT, result: { state: { version: -1 }, watermarkSeq: 0, lastEventAt: null, eventCount: 0 } });
    });
  }, 120_000);
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(DATABASE_URL === undefined)('round 27 · OB-100 / OB-101 / OB-102 (PostgreSQL)', () => {
  const onPg = async (run: (h: ApiHarness) => Promise<void>): Promise<void> => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 16, options: '-c app.tenant_id=*' });
    const sql = pgPoolClient(pool);
    try { await run(apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) })); } finally { await pool.end(); }
  };
  it('OB-100 (U1/U4): unused numbers are shown per till and day; a held one said unused afterwards is a finding', async () => { await onPg(unusedNumbersAreShownAndAHeldOneIsAFinding); }, 300_000);
  it('OB-101 (B2): a second store computer never hides the bound one\'s full disk; its refusal is neutral', async () => { await onPg(aSecondComputerNeverHidesTheBoundOnesFullDisk); }, 300_000);
  it('NEW-5 (bindings scope): one store\'s manager reads only that store\'s bindings', async () => { await onPg(aStoresManagerReadsOnlyItsOwnBindings); }, 300_000);
  it('OB-102: the saved running result is kept in projection_snapshot, resumed, and disposable', async () => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 8, options: '-c app.tenant_id=*' });
    const sql = pgPoolClient(pool);
    try {
      await theSavedResultIsKeptResumedAndDisposable(new SqlEventStore(sql), new SqlSnapshotStore(sql), async (T) => {
        const kept = await pool.query("SELECT data->'result'->'state'->>'settledCount' AS n FROM projection_snapshot WHERE tenant_id = $1 AND projection = 'never-received-fold@1'", [T]);
        expect(Number(kept.rows[0]?.n)).toBeGreaterThan(0);
        await pool.query("DELETE FROM projection_snapshot WHERE tenant_id = $1 AND projection = 'never-received-fold@1'", [T]);
      });
    } finally { await pool.end(); }
  }, 300_000);
});
