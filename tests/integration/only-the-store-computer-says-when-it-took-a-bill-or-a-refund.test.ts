import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { STREAM } from '../../services/api/src/adapters';

/**
 * **Round 35 · M35-FR-04 · verifier r34 NEW-6 (OB-108 / OB-124 (1)) — only the store computer itself says when it took a bill
 * or a refund; through head office's production routes, in memory and on PostgreSQL.**
 *
 * Before round 35 head office kept `storeComputerTakenAt` from ANY sign-in holding the sync permission — a cashier, a manager
 * or the owner posting a refund (or a sale) straight to head office could pick the time, up to "now", and so hide the
 * "said unused, but head office has the bill" line, or make it look like the store computer's own clock.
 *
 *   • from the store computer's own sign-in (`store_computer` role for its store) the time is kept, as before;
 *   • from a cashier (synced refund), a manager (no-receipt refund) or the owner (sale) it is NOT kept: the record notes that
 *     it was offered and ignored (what, by whom, why), the reply says so, and the "said unused" check uses the till's clock —
 *     so the cashier's late refund of a number the store computer called unused DOES raise the line ("the TILL's own clock");
 *   • a note of "ignored" sent in the body by anybody is never kept as sent (head office writes it).
 */

const OWNER = 'u-owner';
const S1 = 'S1';
const P = 'S1L1-';
const pad = (n: number): string => String(n).padStart(6, '0');
const SETTINGS = { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 30 };
interface Finding { kind: string; ranges?: [number, number][]; count?: number; detail: string }
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
  expect((await call('PUT', '/v1/platform/setup/locale.time_zone', OWNER, { value: 'UTC' })).status).toBe(200);
  for (const [id, body] of [['C1', { kind: 'company', name: 'SRE Retail' }], [S1, { kind: 'branch', name: 'Store One', parentId: 'C1', companyId: 'C1' }]] as const) {
    expect((await call('POST', `/v1/org/nodes/${id}`, OWNER, body)).status).toBeLessThan(300);
  }
  expect((await call('POST', `/v1/stores/${S1}/settings`, OWNER, SETTINGS)).status).toBeLessThan(300);
  await h.provisionRole(T, 'u-box', 'store_computer', [S1]);
  await h.provisionRole(T, 'u-cash', 'cashier', [S1]);
  await h.provisionRole(T, 'u-mgr', 'store_manager', [S1]);
  expect((await call('POST', `/v1/stores/${S1}/tills/lane-1/receipt-prefix`, OWNER, { prefix: P })).status).toBe(201);
  return { T, call };
}
const saleBody = (n: number, committedAt: string, extra: Record<string, unknown> = {}) => {
  const receipt = `${P}${pad(n)}`;
  return {
    saleId: `S-${receipt}`, receiptNumber: receipt, laneId: 'lane-1', locationId: S1, cashierId: 'u-cash', tradingDay: committedAt.slice(0, 10), committedAt,
    totalMinor: 1_000, currency: 'INR', packVersion: 0, lines: [{ productId: 'P1', quantityMinor: 1, uom: 'ea', unitPriceMinor: 1_000, lineTotalMinor: 1_000 }],
    tenders: [{ kind: 'cash', amountMinor: 1_000 }], ...extra,
  };
};
const refundBody = (n: number, processedAt: string, extra: Record<string, unknown> = {}) => {
  const number = `${P}${pad(n)}`;
  return {
    returnId: `RT-${number}`, number, processedBy: 'u-cash', reasonCode: 'damaged', refundMinor: 100, refundTender: 'cash', refundStatus: 'settled',
    processedAt, lines: [{ productId: 'P1', quantityMinor: 1, uom: 'ea', disposition: 'resell' }], locationId: S1, ...extra,
  };
};
interface KeptReturn { number: string; storeComputerTakenAt?: string; storeComputerTakenAtIgnored?: { offered: string; by: string; why: string } }
const keptReturn = async (h: ApiHarness, T: string, n: number): Promise<KeptReturn | undefined> =>
  (await h.store.readStream(T, STREAM.returns, { type: 'ReturnRecorded' })).map((e) => e.event.payload as KeptReturn).find((p) => p.number === `${P}${pad(n)}`);

async function onlyTheStoreComputer(h: ApiHarness): Promise<void> {
  const { T, call } = await shop(h);
  const t0 = Date.now();
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  const at = (min: number, sec = 0): string => new Date(t0 + min * 60_000 + sec * 1000).toISOString();
  vi.setSystemTime(t0);
  for (let n = 1; n <= 104; n += 1) expect((await call('POST', '/v1/sales', 'u-box', saleBody(n, at(-120), { storeComputerTakenAt: at(-120) }), S1)).status).toBe(202);
  // The store computer's own stamp is kept (as before).
  const boxIdx = await h.store.findByIdempotencyKey(T, `receipt-${T}-${P}000104`);
  expect((boxIdx?.event.payload as { storeComputerTakenAt?: string }).storeComputerTakenAt).toBe(at(-120));

  // At 0:41 the store computer reports 105 and 106 unused (it never took them).
  vi.setSystemTime(t0 + 41 * 60_000);
  const report = await call('POST', '/v1/store-computers/health-reports', 'u-box', {
    observedAt: new Date().toISOString(), disk: { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1000, salesLogCapacityBytes: 1e7, reserveBytes: 1e6 },
    queue: { unsent: 0, deadLettered: 0 }, tills: [], receiptNumbersIssued: [{ prefix: P, through: 106, soldThrough: 106, unsent: { count: 0 }, unused: [[105, 106]] }],
  }, S1);
  expect(report.status, JSON.stringify(report.body)).toBe(200);

  // 0:45 — a CASHIER posts refund 105 straight to head office (its till says 0:00), stamping "the store computer took it at
  // 0:45" — which, if kept, would put it after the store computer's word and hide the line. Not kept: noted, and said.
  vi.setSystemTime(t0 + 45 * 60_000);
  const byCashier = await call('POST', `/v1/sales/S-${P}000001/returns/synced`, 'u-cash', refundBody(105, at(0), { storeComputerTakenAt: at(45), storeComputerTakenAtIgnored: { offered: 'x', by: 'nobody', why: 'planted' } }), S1);
  expect(byCashier.status, JSON.stringify(byCashier.body)).toBe(202);
  expect(byCashier.body).toMatchObject({ storeComputerTakenAtIgnored: { offered: at(45), by: 'u-cash' } });
  const r105 = await keptReturn(h, T, 105);
  expect(r105?.storeComputerTakenAt).toBeUndefined();
  expect(r105?.storeComputerTakenAtIgnored).toMatchObject({ offered: at(45), by: 'u-cash', why: expect.stringMatching(/only the store computer's own sign-in/) });

  // A MANAGER's no-receipt refund (number 106) with a stamp: the same.
  const byManager = await call('POST', '/v1/returns/no-receipt/synced', 'u-mgr', {
    ...refundBody(106, at(0)), noReceipt: true, laneId: 'lane-1', storeComputerTakenAt: at(45),
  }, S1);
  expect(byManager.status, JSON.stringify(byManager.body)).toBe(202);
  expect((await keptReturn(h, T, 106))).toMatchObject({ storeComputerTakenAtIgnored: { offered: at(45), by: 'u-mgr' } });
  expect((await keptReturn(h, T, 106))?.storeComputerTakenAt).toBeUndefined();

  // The "said unused" check uses the till's clock for both — the line IS raised, and says whose clock.
  vi.setSystemTime(t0 + 46 * 60_000);
  const health = await call('GET', '/v1/platform/operational-health/observed', OWNER);
  const lines = ((health.body as Observed).observed.boxes.find((b) => b.storeId === S1)?.billNumberFindings ?? []).filter((f) => f.kind === 'unused_number_received');
  expect(lines).toHaveLength(1);
  expect([lines[0]!.ranges, lines[0]!.count]).toEqual([[[105, 106]], 2]);
  expect(lines[0]!.detail).toMatch(/the bill's time is the TILL's own clock/);

  // The OWNER posts a sale with a stamp: not kept on the bill-number index; the sale notes it; the reply says it.
  const byOwner = await call('POST', '/v1/sales', OWNER, saleBody(107, at(46), { storeComputerTakenAt: at(46) }), S1);
  expect(byOwner.status, JSON.stringify(byOwner.body)).toBe(202);
  expect(byOwner.body).toMatchObject({ storeComputerTakenAtIgnored: { offered: at(46), by: OWNER } });
  const idx = await h.store.findByIdempotencyKey(T, `receipt-${T}-${P}000107`);
  expect((idx?.event.payload as { storeComputerTakenAt?: string }).storeComputerTakenAt).toBeUndefined();
  const banked = await h.store.findByIdempotencyKey(T, `sale-${T}-S-${P}000107`);
  expect(banked?.event.payload).toMatchObject({ storeComputerTakenAtIgnored: { offered: at(46), by: OWNER } });
  expect((banked?.event.payload as { storeComputerTakenAt?: string }).storeComputerTakenAt).toBeUndefined();

  // The store computer itself: kept; a planted "ignored" note in its body is not kept as sent.
  const byBox = await call('POST', '/v1/sales', 'u-box', saleBody(108, at(46), { storeComputerTakenAt: at(46), storeComputerTakenAtIgnored: { offered: 'x', by: 'nobody', why: 'planted' } }), S1);
  expect(byBox.status).toBe(202);
  expect((byBox.body as Record<string, unknown>)['storeComputerTakenAtIgnored']).toBeUndefined();
  const boxSale = await h.store.findByIdempotencyKey(T, `sale-${T}-S-${P}000108`);
  expect((boxSale?.event.payload as Record<string, unknown>)['storeComputerTakenAtIgnored']).toBeUndefined();
  expect(((await h.store.findByIdempotencyKey(T, `receipt-${T}-${P}000108`))?.event.payload as { storeComputerTakenAt?: string }).storeComputerTakenAt).toBe(at(46));
}

describe('round 35 · M35-FR-04 · NEW-6: only the store computer says when it took a bill or a refund (memory)', () => {
  it('M35-FR-04 OB-108 NEW-6: kept from the store computer; from a cashier, a manager or the owner noted as ignored, said, and the till\'s clock used', async () => {
    await onlyTheStoreComputer(apiHarness());
  }, 180_000);
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(DATABASE_URL === undefined)('round 35 · M35-FR-04 · NEW-6: only the store computer says when it took a bill or a refund (PostgreSQL)', () => {
  it('M35-FR-04 OB-108 NEW-6: kept from the store computer; from a cashier, a manager or the owner noted as ignored, said, and the till\'s clock used', async () => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 16, options: '-c app.tenant_id=*' });
    const sql = pgPoolClient(pool);
    try { await onlyTheStoreComputer(apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) })); } finally { await pool.end(); }
  }, 300_000);
});
