import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM } from '../../services/api/src/adapters';
import { UNRECEIVED_CHECK_CAP, UNUSED_HELD_TIMED_MAX } from '../../services/platform/src/box-health';

/**
 * **Round 29 · owner decision OB-108 "A" (14 Oct 2026, in writing, "Use store computer time"; verifier r28 NEW-4, probe U5) and
 * verifier r28 NEW-6 — through head office's production routes, in memory and on PostgreSQL.**
 *
 *   • the sale a store computer sends carries WHEN IT took the bill from the till (`storeComputerTakenAt`, its own clock);
 *     head office keeps it on the bill's receipt-number index — never later than head office received the bill;
 *   • U5: a till 20 minutes slow, an honest number listed "unused" in one report while its sale was being written — NO line
 *     (the store computer took the bill after it said so, by its own clock);
 *   • an altered store computer calling a bill unused well after it took it — the line, saying both times are its own clock;
 *     a bill from a store computer not yet updated (no stamp) is judged on the till's clock, and the line says so;
 *   • NEW-6: when more numbers are said unused than are checked (the newest 500) or timed (the newest 50 held), the line says so.
 */

const OWNER = 'u-owner';
const S1 = 'S1';
const P = 'S1L1-';
const pad = (n: number): string => String(n).padStart(6, '0');
const SETTINGS = { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 30 };
interface Finding { kind: string; prefix: string; ranges?: [number, number][]; count?: number; since: string; detail: string }
interface Observed { observed: { boxes: { storeId: string; billNumberFindings?: Finding[] }[] }; health: { components: { name: string; status: string; detail: string }[] } }
type Call = (method: 'GET' | 'POST' | 'PUT', path: string, user: string, body?: unknown, branchId?: string) => Promise<{ status: number; body: unknown }>;

afterEach(() => { vi.useRealTimers(); });

async function shop(h: ApiHarness): Promise<{ T: string; call: Call }> {
  const T = randomUUID();
  await h.seedOwner(T, OWNER);
  const call: Call = (method, path, user, body, branchId) => h.request({
    method, path, userId: user, tenantId: T, ...(branchId === undefined ? {} : { branchId }),
    ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }),
  });
  expect((await call('PUT', '/v1/platform/setup/locale.time_zone', OWNER, { value: 'UTC' })).status).toBe(200);
  for (const [id, body] of [['C1', { kind: 'company', name: 'SRE Retail' }], [S1, { kind: 'branch', name: 'Store One', parentId: 'C1', companyId: 'C1' }]] as const) {
    expect((await call('POST', `/v1/org/nodes/${id}`, OWNER, body)).status).toBeLessThan(300);
  }
  expect((await call('POST', `/v1/stores/${S1}/settings`, OWNER, SETTINGS)).status).toBeLessThan(300);
  await h.provisionRole(T, 'u-box', 'store_computer', [S1]);
  await h.provisionRole(T, 'u-cash', 'cashier', [S1]);
  expect((await call('POST', `/v1/stores/${S1}/tills/lane-1/receipt-prefix`, OWNER, { prefix: P })).status).toBe(201);
  return { T, call };
}
const sale = async (call: Call, n: number, committedAt: string, takenAt?: string): Promise<void> => {
  const receipt = `${P}${pad(n)}`;
  const r = await call('POST', '/v1/sales', 'u-box', {
    saleId: `S-${receipt}`, receiptNumber: receipt, laneId: 'lane-1', locationId: S1, cashierId: 'u-cash', tradingDay: committedAt.slice(0, 10), committedAt,
    totalMinor: 1_000, currency: 'INR', packVersion: 0, lines: [{ productId: 'P1', quantityMinor: 1, uom: 'ea', unitPriceMinor: 1_000, lineTotalMinor: 1_000 }],
    tenders: [{ kind: 'cash', amountMinor: 1_000 }], ...(takenAt === undefined ? {} : { storeComputerTakenAt: takenAt }),
  }, S1);
  expect(r.status, JSON.stringify(r.body)).toBe(202);
};
const report = async (call: Call, through: number, unused?: [number, number][]): Promise<void> => {
  const r = await call('POST', '/v1/store-computers/health-reports', 'u-box', {
    observedAt: new Date().toISOString(), disk: { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1000, salesLogCapacityBytes: 1e7, reserveBytes: 1e6 },
    queue: { unsent: 0, deadLettered: 0 }, tills: [], receiptNumbersIssued: [{ prefix: P, through, soldThrough: through, unsent: { count: 0 }, ...(unused === undefined ? {} : { unused }) }],
  }, S1);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
const observed = async (call: Call): Promise<Observed> => {
  const r = await call('GET', '/v1/platform/operational-health/observed', OWNER);
  expect(r.status).toBe(200);
  return r.body as Observed;
};
const line = async (call: Call): Promise<Finding[]> => ((await observed(call)).observed.boxes.find((b) => b.storeId === S1)?.billNumberFindings ?? []).filter((f) => f.kind === 'unused_number_received');

async function theStoreComputersClock(h: ApiHarness): Promise<void> {
  const { T, call } = await shop(h);
  const t0 = Date.now();
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  const at = (min: number, sec = 0): string => new Date(t0 + min * 60_000 + sec * 1000).toISOString();
  vi.setSystemTime(t0);
  // Bills 1–104 sold and banked earlier.
  for (let n = 1; n <= 104; n += 1) await sale(call, n, at(-120), at(-120));
  // U5: the till took 105 and the store computer listed it "unused" in its report at 0:00 (the sale was still being written).
  await report(call, 105, [[105, 105]]);
  // The store computer took the bill at 0:30 by its clock; the till's clock is 20 minutes slow (its committedAt says −19:30).
  vi.setSystemTime(t0 + 31_000);
  await sale(call, 105, at(-20, 30), at(0, 30));
  const idx = await h.store.findByIdempotencyKey(T, `receipt-${T}-${P}000105`);
  expect((idx?.event.payload as { storeComputerTakenAt?: string }).storeComputerTakenAt).toBe(at(0, 30));
  for (const m of [1, 30, 60]) { vi.setSystemTime(t0 + m * 60_000); await report(call, 105); }
  expect(await line(call)).toEqual([]);

  // An altered store computer: it took 106 at 61:00 (stamped) and 107 came from a store computer not yet updated (no stamp,
  // its till's clock says 61:00) — then calls both unused 40 minutes later.
  vi.setSystemTime(t0 + 61 * 60_000);
  await sale(call, 106, at(61), at(61));
  await sale(call, 107, at(61));
  vi.setSystemTime(t0 + 101 * 60_000);
  await report(call, 107, [[106, 107]]);
  vi.setSystemTime(t0 + 102 * 60_000);
  const [f] = await line(call);
  expect([f?.ranges, f?.count]).toEqual([[[106, 107]], 2]);
  expect(f!.detail).toMatch(/for 1 of them, the bill's time is the TILL's own clock — this store computer did not stamp when it took the bill/);

  // A stamp AHEAD of head office (a store computer whose clock runs fast) is cut back to when head office received the bill.
  vi.setSystemTime(t0 + 103 * 60_000);
  const banking = Date.now();
  await sale(call, 108, at(103), at(103 + 10 * 24 * 60));
  const kept = Date.parse(((await h.store.findByIdempotencyKey(T, `receipt-${T}-${P}000108`))?.event.payload as { storeComputerTakenAt: string }).storeComputerTakenAt);
  expect(kept).toBeGreaterThanOrEqual(banking);
  expect(kept).toBeLessThan(banking + 60_000);
}

async function theLimitsAreSaid(h: ApiHarness): Promise<void> {
  const { T, call } = await shop(h);
  const t0 = Date.now();
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(t0);
  // Head office holds bills 1–600 (their receipt-number index, made two hours ago by the store computer's clock).
  const made = new Date(t0 - 2 * 3_600_000).toISOString();
  for (let i = 1; i <= 600; i += 100) {
    await h.store.appendBatch(T, Array.from({ length: 100 }, (_, k) => i + k).map((n) => ({
      stream: STREAM.sales,
      event: makeEvent({ id: `receipt-${P}${pad(n)}`, type: 'ReceiptNumberIssued', occurredAt: made, idempotencyKey: `receipt-${T}-${P}${pad(n)}`, source: 'test/r29', payload: { receiptNumber: `${P}${pad(n)}`, saleId: `S-${n}`, storeComputerTakenAt: made } }),
    })));
  }
  // The store computer calls all 600 unused — in two reports (a report names at most 500; head office keeps every one said).
  await report(call, 600, [[1, 500]]);
  await report(call, 600, [[101, 600]]);
  vi.setSystemTime(t0 + 60_000);
  const [f] = await line(call);
  expect(f?.count).toBe(UNUSED_HELD_TIMED_MAX);
  expect(f!.detail).toContain(`Not every number was looked at: ${600 - UNRECEIVED_CHECK_CAP} older number(s) said unused, beyond the newest ${UNRECEIVED_CHECK_CAP}, were not checked against head office's bills; ${UNRECEIVED_CHECK_CAP - UNUSED_HELD_TIMED_MAX} more number(s) head office holds a bill for, beyond the newest ${UNUSED_HELD_TIMED_MAX}, did not have their bill's time read`);
  expect(f!.detail).toContain('(both times by the store computer\'s own clock');
  const info = (await observed(call)).health.components.find((c) => c.name === `box_unused_numbers:${S1}`);
  expect(info?.detail).toMatch(/Under S1L1-: Not every number was looked at/);
}

describe('round 29 · OB-108 / NEW-6 (memory)', () => {
  it('the "said unused, but held" check uses the store computer\'s own time for the bill: a slow till raises nothing; an altered store computer does; old bills say so', async () => { await theStoreComputersClock(apiHarness()); }, 180_000);
  it('the 500-checked and 50-timed limits are said on the line and on the information', async () => { await theLimitsAreSaid(apiHarness()); }, 180_000);
});

const DATABASE_URL = process.env['DATABASE_URL'];
const onPg = async (run: (h: ApiHarness) => Promise<void>): Promise<void> => {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 16, options: '-c app.tenant_id=*' });
  const sql = pgPoolClient(pool);
  try { await run(apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) })); } finally { await pool.end(); }
};
describe.skipIf(DATABASE_URL === undefined)('round 29 · OB-108 / NEW-6 (PostgreSQL)', () => {
  it('the "said unused, but held" check uses the store computer\'s own time for the bill: a slow till raises nothing; an altered store computer does; old bills say so', async () => { await onPg(theStoreComputersClock); }, 300_000);
  it('the 500-checked and 50-timed limits are said on the line and on the information', async () => { await onPg(theLimitsAreSaid); }, 300_000);
});
