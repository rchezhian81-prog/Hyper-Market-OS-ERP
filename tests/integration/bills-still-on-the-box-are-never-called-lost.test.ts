import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM, streamName } from '../../services/api/src/adapters';
import { PLAUSIBLE_ISSUED_AHEAD, UNRECEIVED_GRACE_MINUTES } from '../../services/platform/src/box-health';

/**
 * **Verifier r20 LOST-1 (P-03, P-08) and BOX-2 — "bills issued but never received" is said only of bills that are truly
 * missing, and a refused report stops being a warning once the store computer is plainly fine again.** Through head
 * office's production routes (the box's health reports, the sales intake, the observed health read, the store pack), in
 * memory and on PostgreSQL:
 *
 *   1. THE PROBE (zz-v20-lost): a lane sold 2,450 bills offline. On reconnection the box drains about 100 per pass and
 *      reports after each, saying how many bills under the prefix it still holds and their range. At +31 minutes 2,000 are
 *      banked and 450 are still on the box: NOTHING is named "never received" (it used to name all 450 as lost and tell
 *      staff to enter the paper bills — a double-entry risk). The box then reports it no longer holds 2001–2010 (they never
 *      arrive) while 2011–2450 are still queued: within the grace nothing; after it, EXACTLY S1L1-002001 to S1L1-002010 are
 *      named, never the queued ones. The rest arrive; a restored box that cannot vouch for 1995–2010 has exactly the ten
 *      head office never received named (the six it banked are found in one indexed read, not one at a time).
 *   2. An older box that gives no per-prefix queue: its whole queue stands in — anything unsent, nothing is named; empty
 *      for the grace, the missing numbers are named.
 *   3. BOX-2 (verifier r21 rule): a store computer's implausible report is refused and shown, and it stays a finding until
 *      head office's OWN banked count catches up to the refused claim, or a person acknowledges it — a LATER report from
 *      the box (lower, plausible, everything banked) never clears it (probe zz-v21 C: refused 10,600, then "through 50").
 *      The acknowledgement needs platform.alert.manage with ALL-STORES authority (r22 D2 · OB-88), names the exact refused
 *      count, and keeps who, when and why; a higher refusal after it is a new finding.
 *   4. BOX-2: a report kept BEFORE head office judged reports at arrival (written straight to the ledger, as an old
 *      release did) is re-judged against the 10,000 cap at read: it never moves the store pack's `bankedThrough` and
 *      raises no "never received" — the till keeps selling from where head office banked.
 */

const OWNER = 'u-owner';
const S1 = 'S1';
const P = 'S1L1-';
const pad = (n: number): string => String(n).padStart(6, '0');
const AT = new Date(Date.now() - 60_000).toISOString();
const SETTINGS = { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 30 };

interface Finding { kind: string; prefix: string; ranges?: [number, number][]; through?: number; detail: string }
interface Component { name: string; status: string; detail: string }
interface Observed { observed: { boxes: { storeId: string; billNumberFindings?: Finding[] }[] }; health: { components: Component[] } }

afterEach(() => { vi.useRealTimers(); });

async function shop(h: ApiHarness): Promise<{ T: string; call: (method: 'GET' | 'POST', path: string, user: string, body?: unknown, branchId?: string) => Promise<{ status: number; body: unknown }> }> {
  const T = randomUUID();
  await h.seedOwner(T, OWNER);
  const call = (method: 'GET' | 'POST', path: string, user: string, body?: unknown, branchId?: string) => h.request({
    method, path, userId: user, tenantId: T, ...(branchId === undefined ? {} : { branchId }),
    ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }),
  });
  for (const [id, body] of [
    ['C1', { kind: 'company', name: 'SRE Retail' }],
    [S1, { kind: 'branch', name: 'Store One', parentId: 'C1', companyId: 'C1' }],
  ] as const) expect((await call('POST', `/v1/org/nodes/${id}`, OWNER, body)).status).toBeLessThan(300);
  expect((await call('POST', `/v1/stores/${S1}/settings`, OWNER, SETTINGS)).status).toBeLessThan(300);
  await h.provisionRole(T, 'u-box', 'store_computer', [S1]);
  expect((await call('POST', `/v1/stores/${S1}/tills/lane-1/receipt-prefix`, OWNER, { prefix: P })).status).toBe(201);
  return { T, call };
}

type Call = Awaited<ReturnType<typeof shop>>['call'];
const bank = async (call: Call, from: number, to: number): Promise<void> => {
  const numbers = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  for (let i = 0; i < numbers.length; i += 16) {
    await Promise.all(numbers.slice(i, i + 16).map(async (n) => {
      const receipt = `${P}${pad(n)}`;
      const r = await call('POST', '/v1/sales', 'u-box', {
        saleId: `S-${receipt}`, receiptNumber: receipt, laneId: 'lane-1', locationId: S1, cashierId: 'u-cash', tradingDay: AT.slice(0, 10), committedAt: AT,
        totalMinor: 1_000, currency: 'INR', packVersion: 0, lines: [{ productId: 'P1', quantityMinor: 1, uom: 'ea', unitPriceMinor: 1_000, lineTotalMinor: 1_000 }],
        tenders: [{ kind: 'cash', amountMinor: 1_000 }],
      }, S1);
      expect(r.status).toBe(202);
    }));
  }
};
const report = async (call: Call, issued: unknown, queueUnsent: number): Promise<{ status: number; body: unknown }> => {
  const r = await call('POST', '/v1/store-computers/health-reports', 'u-box', {
    observedAt: new Date().toISOString(), disk: { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1000, salesLogCapacityBytes: 1e7, reserveBytes: 1e6 },
    queue: { unsent: queueUnsent, deadLettered: 0 }, tills: [], receiptNumbersIssued: issued,
  }, S1);
  expect(r.status).toBe(200);
  return r;
};
const observed = async (call: Call): Promise<Observed> => {
  const r = await call('GET', '/v1/platform/operational-health/observed', OWNER);
  expect(r.status).toBe(200);
  return r.body as Observed;
};
const neverReceived = async (call: Call): Promise<[number, number][]> =>
  ((await observed(call)).observed.boxes.find((b) => b.storeId === S1)?.billNumberFindings ?? [])
    .filter((f) => f.kind === 'issued_never_received' && f.prefix === P).flatMap((f) => f.ranges ?? []);
const contradictions = async (call: Call): Promise<[number, number][]> =>
  ((await observed(call)).observed.boxes.find((b) => b.storeId === S1)?.billNumberFindings ?? [])
    .filter((f) => f.kind === 'report_contradicts_earlier_report' && f.prefix === P).flatMap((f) => f.ranges ?? []);
const refusedFindings = async (call: Call): Promise<Finding[]> =>
  ((await observed(call)).observed.boxes.find((b) => b.storeId === S1)?.billNumberFindings ?? []).filter((f) => f.kind === 'report_refused');

function clock(): { travel: (minutes: number) => void } {
  const t0 = Date.now();
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  return { travel: (minutes) => { vi.setSystemTime(t0 + minutes * 60_000); } };
}

async function aLongCatchUpRaisesNothing(h: ApiHarness): Promise<void> {
  const { call } = await shop(h);
  const { travel } = clock();
  await bank(call, 1, 150); // the morning, synced; then offline 09:00–20:00, 2,300 more bills on lane 1
  travel(0);
  // Reconnection: the first pass banked 100, the box reports what it still holds under the prefix.
  await report(call, [{ prefix: P, through: 2_450, soldThrough: 2_450, unsent: { count: 2_300, from: 151, to: 2_450 } }], 2_300);
  await bank(call, 151, 2_000);
  for (const m of [1, 10, 20, 31]) {
    travel(m);
    await report(call, [{ prefix: P, through: 2_450, soldThrough: 2_450, unsent: { count: 450, from: 2_001, to: 2_450 } }], 450);
  }
  // +31 minutes, 450 still on the box: nothing is "never received" (r19 named S1L1-002001 to S1L1-002450 as lost here).
  expect(await neverReceived(call)).toEqual([]);
  const quiet = (await observed(call)).health.components.find((c) => c.name === `box_bill_numbers:${S1}`);
  expect(quiet?.detail ?? '').not.toMatch(/never received/);

  // 2001–2010 never arrive (dead on the way, say); the box now holds only 2011–2450.
  travel(32);
  await report(call, [{ prefix: P, through: 2_450, soldThrough: 2_450, unsent: { count: 440, from: 2_011, to: 2_450 } }], 440);
  travel(32 + UNRECEIVED_GRACE_MINUTES - 1);
  expect(await neverReceived(call)).toEqual([]); // inside the grace from when the box said it no longer held them
  travel(32 + UNRECEIVED_GRACE_MINUTES + 1);
  expect(await neverReceived(call)).toEqual([[2_001, 2_010]]); // exactly the missing ten — never the 440 still queued
  const named = (await observed(call)).health.components.find((c) => c.name === `box_bill_numbers:${S1}`);
  expect(named?.status).toBe('degraded');
  expect(named?.detail).toMatch(/S1L1-002001 to S1L1-002010/);
  expect(named?.detail).toMatch(/said it no longer held them to send/);
  expect(named?.detail).not.toMatch(/S1L1-002011/);
  // Verifier r23 NEW-1 · OB-89: the box then claims them AGAIN. An honest box cannot — it keeps a bill until head office
  // takes it, and 2001–2010 are below every bill still in its queue (its cursor is past them; a restart re-queues only
  // what is past its cursor). Its later word no longer holds them back: they stay named, and the contradiction is said.
  await report(call, [{ prefix: P, through: 2_450, soldThrough: 2_450, unsent: { count: 450, from: 2_001, to: 2_450 } }], 450);
  expect(await neverReceived(call)).toEqual([[2_001, 2_010]]);
  expect(await contradictions(call)).toEqual([[2_001, 2_010]]);
  await report(call, [{ prefix: P, through: 2_450, soldThrough: 2_450, unsent: { count: 440, from: 2_011, to: 2_450 } }], 440);
  expect(await neverReceived(call)).toEqual([[2_001, 2_010]]);
  expect(await contradictions(call)).toEqual([]);

  // The rest arrive. Then the box is restored from a backup and cannot vouch for 1995–2010 (its witness says they were
  // given after the backup): head office checks those against what it banked — at or below its highest banked count, in
  // ONE indexed read — and names exactly the ten it never received, never the six it did.
  await bank(call, 2_011, 2_450);
  travel(70);
  await report(call, [{ prefix: P, through: 2_450, soldThrough: 2_450, atRisk: [[1_995, 2_010]], unsent: { count: 0 } }], 0);
  travel(70 + UNRECEIVED_GRACE_MINUTES + 1);
  expect(await neverReceived(call)).toEqual([[2_001, 2_010]]);
  // ...and once they are entered (banked), nothing is named.
  await bank(call, 2_001, 2_010);
  expect(await neverReceived(call)).toEqual([]);
}

async function anOlderBoxsWholeQueueStandsIn(h: ApiHarness): Promise<void> {
  const { call } = await shop(h);
  const { travel } = clock();
  await bank(call, 1, 40);
  travel(0);
  await report(call, [{ prefix: P, through: 60, soldThrough: 60 }], 20); // no per-prefix queue: an older box
  travel(UNRECEIVED_GRACE_MINUTES + 5);
  await report(call, [{ prefix: P, through: 60, soldThrough: 60 }], 3); // still something unsent somewhere
  expect(await neverReceived(call)).toEqual([]);
  await report(call, [{ prefix: P, through: 60, soldThrough: 60 }], 0); // its queue is empty now
  expect(await neverReceived(call)).toEqual([]); // the grace runs from here
  travel(2 * UNRECEIVED_GRACE_MINUTES + 10);
  expect(await neverReceived(call)).toEqual([[41, 60]]);
  // A garbled per-prefix queue is refused at the door, never guessed.
  const bad = await call('POST', '/v1/store-computers/health-reports', 'u-box', {
    observedAt: new Date().toISOString(), disk: { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1000, salesLogCapacityBytes: 1e7, reserveBytes: 1e6 },
    queue: { unsent: 0, deadLettered: 0 }, tills: [], receiptNumbersIssued: [{ prefix: P, through: 60, unsent: { count: 5, from: 50, to: 70 } }],
  }, S1);
  expect(bad.status).toBe(400);
  expect(JSON.stringify(bad.body)).toMatch(/unsent must be/);
}

/** Bank receipt numbers straight onto the sales stream (what the sales intake writes) — thousands at once, for the banked-catches-up case. */
const bankDirect = async (store: EventStore, T: string, prefix: string, from: number, to: number): Promise<void> => {
  for (let n = from; n <= to; n += 500) {
    await store.appendBatch(T, Array.from({ length: Math.min(500, to - n + 1) }, (_, j) => {
      const rn = `${prefix}${pad(n + j)}`;
      return { stream: STREAM.sales, event: makeEvent({ id: `receipt-${rn}`, type: 'ReceiptNumberIssued', occurredAt: AT, idempotencyKey: `receipt-${T}-${rn}`, source: 'tests', payload: { receiptNumber: rn, saleId: `S-${rn}` } }) };
    }));
  }
};

async function aRefusedReportStaysUntilBankedOrAcknowledged(h: ApiHarness, store: EventStore): Promise<void> {
  const { T, call } = await shop(h);
  await h.provisionRole(T, 'u-cash', 'cashier', [S1]);
  await bank(call, 1, 150);
  const r = await report(call, [{ prefix: P, through: 10_600, soldThrough: 10_600 }], 0);
  expect((r.body as { recorded: { receiptNumbersRefused?: { because: string }[] } }).recorded.receiptNumbersRefused).toEqual([expect.objectContaining({ because: 'beyond_plausible_advance' })]);
  expect((await refusedFindings(call)).map((f) => f.through)).toEqual([10_600]);
  // THE PROBE (zz-v21 C): a minute later the box reports a LOWER count — plausible, everything banked. The warning STAYS:
  // an honest box's count never goes down, so a box's own later word never clears a refusal.
  await report(call, [{ prefix: P, through: 50, soldThrough: 50, unsent: { count: 0 } }], 0);
  expect((await refusedFindings(call)).map((f) => f.through)).toEqual([10_600]);
  await bank(call, 151, 160);
  await report(call, [{ prefix: P, through: 160, soldThrough: 160, unsent: { count: 0 } }], 0);
  expect((await refusedFindings(call)).map((f) => f.through)).toEqual([10_600]);
  expect((await refusedFindings(call))[0]!.detail).toMatch(/This stays until head office has banked that many, or the owner or head office staff \(all-stores authority — a store's own manager cannot, and neither can the IT\/platform administrator\) acknowledge this count/);

  // A person acknowledges it. Refused: a cashier (no platform.alert.manage); a count that was never refused; no reason.
  const ack = (user: string, body: unknown) => call('POST', '/v1/store-computers/bill-number-refusals/acknowledgements', user, body);
  expect((await ack('u-cash', { storeId: S1, prefix: P, through: 10_600, reason: 'checked the box, a restore test' })).status).toBe(403);
  const wrong = await ack(OWNER, { storeId: S1, prefix: P, through: 10_601, reason: 'checked the box, a restore test' });
  expect(wrong.status).toBe(404);
  expect(JSON.stringify(wrong.body)).toMatch(/no_such_refused_report/);
  expect((await ack(OWNER, { storeId: S1, prefix: P, through: 10_600, reason: 'ok' })).status).toBe(400);
  expect((await refusedFindings(call)).map((f) => f.through)).toEqual([10_600]); // nothing refused cleared it
  const done = await ack(OWNER, { storeId: S1, prefix: P, through: 10_600, reason: 'checked the box: a restore rehearsal, no bills lost' });
  expect(done.status).toBe(201);
  expect((done.body as { acknowledged: Record<string, unknown> }).acknowledged).toMatchObject({ storeId: S1, prefix: P, through: 10_600, by: OWNER, reason: 'checked the box: a restore rehearsal, no bills lost', authority: 'all_stores' });
  expect(await refusedFindings(call)).toEqual([]);
  const c = (await observed(call)).health.components.find((x) => x.name === `box_bill_numbers:${S1}`);
  expect(c?.detail ?? '').not.toMatch(/10600/);
  // The refusal itself is kept as evidence (append-only): a new, higher implausible report is a new warning.
  await report(call, [{ prefix: P, through: 999_998, soldThrough: 999_998 }], 0);
  expect((await refusedFindings(call)).map((f) => f.through)).toEqual([999_998]);

  // The other way out: head office's OWN banked count catches up to a refused claim (it was true after all).
  const Q = 'S1L2-';
  expect((await call('POST', `/v1/stores/${S1}/tills/lane-2/receipt-prefix`, OWNER, { prefix: Q })).status).toBe(201);
  await bankDirect(store, T, Q, 1, 100);
  await report(call, [{ prefix: Q, through: 10_150, soldThrough: 10_150 }], 0); // 100 banked + 10,000: refused
  expect((await refusedFindings(call)).filter((f) => f.prefix === Q).map((f) => f.through)).toEqual([10_150]);
  await bankDirect(store, T, Q, 101, 10_149);
  expect((await refusedFindings(call)).filter((f) => f.prefix === Q).map((f) => f.through)).toEqual([10_150]); // one short: stays
  await bankDirect(store, T, Q, 10_150, 10_150);
  expect((await refusedFindings(call)).filter((f) => f.prefix === Q)).toEqual([]);
}

async function aReportKeptBeforeJudgingIsCapped(h: ApiHarness, store: EventStore): Promise<void> {
  const { T, call } = await shop(h);
  await bank(call, 1, 30);
  // A report an older release kept WITHOUT judging it: its own prefix "through 999,999".
  const at = new Date(Date.now() - 2 * 3_600_000).toISOString();
  await store.append(T, streamName(STREAM.org, 'store-computer-health'), makeEvent({
    id: `old-report-${randomUUID()}`, type: 'StoreComputerHealthReported', occurredAt: at, idempotencyKey: `old-report-${T}`, source: 'api/platform',
    payload: {
      storeId: S1, observedAt: at, receivedAt: at, reportedBy: 'u-box', clockAheadCorrected: false, tills: [],
      disk: { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1000, salesLogCapacityBytes: 1e7, reserveBytes: 1e6 }, queue: { unsent: 0, deadLettered: 0 },
      receiptNumbersIssued: [{ prefix: P, through: 999_999, soldThrough: 999_999 }],
    },
  }));
  const pack = await call('GET', `/v1/store-packs/${S1}`, OWNER);
  expect(pack.status).toBe(200);
  const series = ((pack.body as { sections: { receiptSeries?: { prefix: string; bankedThrough: number }[] } }).sections.receiptSeries ?? []).find((s) => s.prefix === P);
  expect(series?.bankedThrough).toBe(30); // never 999,999 — the till keeps selling from S1L1-000031
  expect(series!.bankedThrough).toBeLessThanOrEqual(30 + PLAUSIBLE_ISSUED_AHEAD);
  expect(await neverReceived(call)).toEqual([]); // and it names nothing
  // A plausible report is still folded (a voided bill keeps its number).
  await report(call, [{ prefix: P, through: 35, soldThrough: 30, unsent: { count: 0 } }], 0);
  const again = ((await call('GET', `/v1/store-packs/${S1}`, OWNER)).body as { sections: { receiptSeries?: { prefix: string; bankedThrough: number }[] } }).sections.receiptSeries?.find((s) => s.prefix === P);
  expect(again?.bankedThrough).toBe(35);
}

describe('verifier r20 LOST-1 / BOX-2: bills still on the box are never called lost (memory)', () => {
  it('a long catch-up after an outage names nothing; only truly missing numbers are named', async () => { await aLongCatchUpRaisesNothing(apiHarness()); }, 180_000);
  it('an older box: its whole queue stands in', async () => { await anOlderBoxsWholeQueueStandsIn(apiHarness()); }, 60_000);
  it('BOX-2: a refused report stays until head office banks that many or a person acknowledges it — never on a later lower report', async () => {
    const h = apiHarness();
    await aRefusedReportStaysUntilBankedOrAcknowledged(h, h.store);
  }, 120_000);
  it('a report kept before judging is re-judged against the cap', async () => {
    const h = apiHarness();
    await aReportKeptBeforeJudgingIsCapped(h, h.store);
  }, 60_000);
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(DATABASE_URL === undefined)('verifier r20 LOST-1 / BOX-2: bills still on the box are never called lost (PostgreSQL)', () => {
  const onPg = async (run: (h: ApiHarness, store: EventStore) => Promise<void>): Promise<void> => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 16, options: '-c app.tenant_id=*' });
    const sql = pgPoolClient(pool);
    const store = new SqlEventStore(sql);
    try { await run(apiHarness({ store, idempotency: new SqlIdempotencyStore(sql) }), store); } finally { await pool.end(); }
  };
  it('a long catch-up after an outage names nothing; only truly missing numbers are named', async () => { await onPg((h) => aLongCatchUpRaisesNothing(h)); }, 600_000);
  it('an older box: its whole queue stands in', async () => { await onPg((h) => anOlderBoxsWholeQueueStandsIn(h)); }, 120_000);
  it('BOX-2: a refused report stays until head office banks that many or a person acknowledges it — never on a later lower report', async () => { await onPg((h, store) => aRefusedReportStaysUntilBankedOrAcknowledged(h, store)); }, 300_000);
  it('a report kept before judging is re-judged against the cap', async () => { await onPg((h, store) => aReportKeptBeforeJudgingIsCapped(h, store)); }, 120_000);
});
