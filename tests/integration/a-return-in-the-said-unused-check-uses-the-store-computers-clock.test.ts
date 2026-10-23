import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { STREAM } from '../../services/api/src/adapters';
import { ownerApprovedSetting } from '../support/owner-approved-setting';

/**
 * **Round 34 · M35-FR-04 · owner decision OB-124 (1) "A" (15 Oct 2026, in writing, "Build all five before pilot"), finishing
 * OB-108 "A" ("Use store computer time") for RETURNS — through head office's production routes, in memory and on PostgreSQL.**
 *
 *   • a refund the store computer sends carries WHEN IT took the refund from the till (`storeComputerTakenAt`, its own clock);
 *     head office keeps it on the return — receipted and no-receipt alike — never later than head office received it;
 *   • a till 20 minutes slow, an honest number listed "unused" in one report while its RETURN was being written — NO line (the
 *     store computer took the refund after it said so, by its own clock). Before round 34 this raised a false line;
 *   • an altered store computer calling a returned number unused well after it took the refund — the line, both times its own
 *     clock; a return from a store computer not yet updated (no stamp) is judged on the till's clock, and the line says so.
 */

const OWNER = 'u-owner';
const S1 = 'S1';
const P = 'S1L1-';
const pad = (n: number): string => String(n).padStart(6, '0');
const SETTINGS = { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 15 };
interface Finding { kind: string; prefix: string; ranges?: [number, number][]; count?: number; since: string; detail: string }
interface Observed { observed: { boxes: { storeId: string; billNumberFindings?: Finding[] }[] } }
type Call = (method: 'GET' | 'POST' | 'PUT', path: string, user: string, body?: unknown, branchId?: string) => Promise<{ status: number; body: unknown }>;

afterEach(() => { vi.useRealTimers(); });

async function shop(h: ApiHarness): Promise<{ T: string; call: Call }> {
  const T = randomUUID();
  await h.seedOwner(T, OWNER);
  const call: Call = (method, path, user, body, branchId) => h.request({
    method, path, userId: user, tenantId: T, ...(branchId === undefined ? {} : { branchId }),
    ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }),
  });
  expect((await ownerApprovedSetting(h, T, 'locale.time_zone', { value: 'UTC' }, OWNER)).status).toBe(200);
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
/** A refund taken at the till under bill number `n` (the till's one register), relayed by the store computer. */
const refund = async (call: Call, n: number, processedAt: string, takenAt?: unknown): Promise<void> => {
  const number = `${P}${pad(n)}`;
  const r = await call('POST', `/v1/sales/S-${P}000001/returns/synced`, 'u-box', {
    returnId: `RT-${number}`, number, processedBy: 'u-cash', reasonCode: 'damaged', refundMinor: 100, refundTender: 'cash', refundStatus: 'settled',
    processedAt, lines: [{ productId: 'P1', quantityMinor: 1, uom: 'ea', disposition: 'resell' }], locationId: S1,
    ...(takenAt === undefined ? {} : { storeComputerTakenAt: takenAt }),
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
const line = async (call: Call): Promise<Finding[]> => {
  const r = await call('GET', '/v1/platform/operational-health/observed', OWNER);
  expect(r.status).toBe(200);
  return ((r.body as Observed).observed.boxes.find((b) => b.storeId === S1)?.billNumberFindings ?? []).filter((f) => f.kind === 'unused_number_received');
};
const keptReturn = async (h: ApiHarness, T: string, n: number): Promise<{ storeComputerTakenAt?: string; processedAt: string } | undefined> =>
  (await h.store.readStream(T, STREAM.returns, { type: 'ReturnRecorded' })).map((e) => e.event.payload as { number: string; storeComputerTakenAt?: string; processedAt: string })
    .find((p) => p.number === `${P}${pad(n)}`);

async function aReturnOnTheStoreComputersClock(h: ApiHarness): Promise<void> {
  const { T, call } = await shop(h);
  const t0 = Date.now();
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  const at = (min: number, sec = 0): string => new Date(t0 + min * 60_000 + sec * 1000).toISOString();
  vi.setSystemTime(t0);
  for (let n = 1; n <= 104; n += 1) await sale(call, n, at(-120), at(-120));
  // The till's register gave 105 to a REFUND; the store computer listed 105 "unused" in its report at 0:00 (the refund was
  // still being written). It took the refund at 0:30 by its own clock; the till's clock is 20 minutes slow (−19:30).
  await report(call, 105, [[105, 105]]);
  vi.setSystemTime(t0 + 31_000);
  await refund(call, 105, at(-20, 30), at(0, 30));
  expect((await keptReturn(h, T, 105))).toMatchObject({ storeComputerTakenAt: at(0, 30), processedAt: at(-20, 30) });
  for (const m of [1, 30, 60]) { vi.setSystemTime(t0 + m * 60_000); await report(call, 105); }
  // Judged on the store computer's clock: no false line (on the till's clock it would be "said unused 19 minutes after").
  expect(await line(call)).toEqual([]);

  // An altered store computer: it took refund 106 at 61:00 (stamped); refund 107 came from a store computer not yet updated
  // (no stamp; its till says 61:00) — then it calls both unused 40 minutes later.
  vi.setSystemTime(t0 + 61 * 60_000);
  await refund(call, 106, at(61), at(61));
  await refund(call, 107, at(61));
  expect((await keptReturn(h, T, 107))?.storeComputerTakenAt).toBeUndefined();
  vi.setSystemTime(t0 + 101 * 60_000);
  await report(call, 107, [[106, 107]]);
  vi.setSystemTime(t0 + 102 * 60_000);
  const [f] = await line(call);
  expect([f?.ranges, f?.count]).toEqual([[[106, 107]], 2]);
  expect(f!.detail).toMatch(/head office holds returns under those numbers/);
  expect(f!.detail).toMatch(/for 1 of them, the bill's time is the TILL's own clock — this store computer did not stamp when it took the bill/);

  // A stamp AHEAD of head office is cut back to when head office received the refund; an unreadable stamp is not kept.
  vi.setSystemTime(t0 + 103 * 60_000);
  const received = Date.now();
  await refund(call, 108, at(103), at(103 + 10 * 24 * 60));
  const kept = Date.parse((await keptReturn(h, T, 108))!.storeComputerTakenAt!);
  expect(kept).toBeGreaterThanOrEqual(received);
  expect(kept).toBeLessThan(received + 60_000);
  await refund(call, 109, at(103), 'yesterday');
  expect((await keptReturn(h, T, 109))?.storeComputerTakenAt).toBeUndefined();

  // A NO-RECEIPT refund relayed by the store computer keeps its stamp too.
  const nr = await call('POST', '/v1/returns/no-receipt/synced', 'u-box', {
    returnId: 'RT-NR-1', number: `${P}${pad(110)}`, processedBy: 'u-cash', reasonCode: 'damaged', refundMinor: 100, refundTender: 'cash', refundStatus: 'settled',
    noReceipt: true, laneId: 'lane-1', locationId: S1, processedAt: at(103), lines: [{ productId: 'P1', quantityMinor: 1, uom: 'ea', disposition: 'resell' }],
    storeComputerTakenAt: at(102, 55),
  }, S1);
  expect(nr.status, JSON.stringify(nr.body)).toBe(202);
  expect((await keptReturn(h, T, 110))?.storeComputerTakenAt).toBe(at(102, 55));
}

describe('round 34 · M35-FR-04 · OB-124 (1) / OB-108: a return in the "said unused" check uses the store computer\'s clock (memory)', () => {
  it('M35-FR-04 OB-124 OB-108: a slow till\'s refund raises nothing; an altered store computer does; an unstamped refund says the till\'s clock; receipted and no-receipt refunds keep the stamp', async () => {
    await aReturnOnTheStoreComputersClock(apiHarness());
  }, 180_000);
});

const DATABASE_URL = process.env['DATABASE_URL'];
const onPg = async (run: (h: ApiHarness) => Promise<void>): Promise<void> => {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 16, options: '-c app.tenant_id=*' });
  const sql = pgPoolClient(pool);
  try { await run(apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) })); } finally { await pool.end(); }
};
describe.skipIf(DATABASE_URL === undefined)('round 34 · M35-FR-04 · OB-124 (1) / OB-108: a return in the "said unused" check uses the store computer\'s clock (PostgreSQL)', () => {
  it('M35-FR-04 OB-124 OB-108: a slow till\'s refund raises nothing; an altered store computer does; an unstamped refund says the till\'s clock; receipted and no-receipt refunds keep the stamp', async () => {
    await onPg(aReturnOnTheStoreComputersClock);
  }, 300_000);
});
