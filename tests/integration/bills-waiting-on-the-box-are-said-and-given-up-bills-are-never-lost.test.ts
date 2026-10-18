import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { UNRECEIVED_GRACE_MINUTES } from '../../services/platform/src/box-health';

/**
 * **Verifier r21 UNSENT-CEILING (P-08) and DEAD-LETTER-AS-LOST (P-03) — a store computer can no longer hide bills head
 * office never received behind "still sending", and a bill it gave up sending is never called lost.** Through head office's
 * production routes (the box's health report, the sales intake, store setup, the observed health read), in memory and on
 * PostgreSQL:
 *
 *   1. THE PROBE (zz-v21 ITEM2): 100 banked; the box reports every hour for 7 days `unsent: {count: 1, from: 101, to: 600}`
 *      with a queue that agrees (1). Before two hours: no warning, but box_queue never says "has sent everything". Past two
 *      hours (the owner's line, a tenant setting, default 2): "bills waiting on the store computer for N hours" on
 *      box_bill_numbers AND box_queue (degraded) — still there after 7 days. The line is the owner's: store setup takes 1–72
 *      whole hours (a cashier is refused, 0 is refused in the engine's words), kept with who changed it, and the warning
 *      follows it. A box's own "oldest bill made at …" counts when it is older than head office's own observation.
 *   2. THE PROBE, contradicting (queue 0, the prefix says 1): the report is kept but NOT believed — "contradicts itself" is
 *      said on box_queue (degraded, never "has sent everything") and box_bill_numbers, and after the grace the 500 bills
 *      head office never received are named [[101, 600]].
 *   3. DEAD LETTERS (zz-v21 ITEM2b): the box gave up sending bill 101 and lists it per prefix (`deadLettered`). At +31 min
 *      and +3 h: NOT "never received"; "needs a person (the store computer gave up sending; do NOT re-enter from paper)" on
 *      box_bill_numbers, and box_queue says "gave up sending … do NOT re-enter those bills from paper" — never "head office
 *      refused" nor "enter the paper bills". The dead letter is released and the bill arrives: the finding clears. An OLDER
 *      box that does not list its dead letters by prefix: the never-received line says "do NOT re-enter them from paper
 *      until a person has checked", never "find the paper bills and enter them". A per-prefix dead-letter count above the
 *      box's own is a contradiction too.
 */

const OWNER = 'u-owner';
const S1 = 'S1';
const P = 'S1L1-';
const pad = (n: number): string => String(n).padStart(6, '0');
const AT = new Date(Date.now() - 60_000).toISOString();
const SETTINGS = { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 15 };

interface Finding { kind: string; prefix: string; ranges?: [number, number][]; count?: number; detail: string }
interface Component { name: string; status: string; detail: string }
interface Observed { observed: { boxes: { storeId: string; billNumberFindings?: Finding[] }[] }; health: { components: Component[] } }

afterEach(() => { vi.useRealTimers(); });

type Call = (method: 'GET' | 'POST' | 'PUT', path: string, user: string, body?: unknown, branchId?: string) => Promise<{ status: number; body: unknown }>;
async function shop(h: ApiHarness): Promise<{ T: string; call: Call }> {
  const T = randomUUID();
  await h.seedOwner(T, OWNER);
  const call: Call = (method, path, user, body, branchId) => h.request({
    method, path, userId: user, tenantId: T, ...(branchId === undefined ? {} : { branchId }),
    ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }),
  });
  for (const [id, body] of [
    ['C1', { kind: 'company', name: 'SRE Retail' }],
    [S1, { kind: 'branch', name: 'Store One', parentId: 'C1', companyId: 'C1' }],
  ] as const) expect((await call('POST', `/v1/org/nodes/${id}`, OWNER, body)).status).toBeLessThan(300);
  expect((await call('POST', `/v1/stores/${S1}/settings`, OWNER, SETTINGS)).status).toBeLessThan(300);
  await h.provisionRole(T, 'u-box', 'store_computer', [S1]);
  await h.provisionRole(T, 'u-cash', 'cashier', [S1]);
  expect((await call('POST', `/v1/stores/${S1}/tills/lane-1/receipt-prefix`, OWNER, { prefix: P })).status).toBe(201);
  return { T, call };
}
const bank = async (call: Call, from: number, to: number): Promise<void> => {
  for (let n = from; n <= to; n += 1) {
    const receipt = `${P}${pad(n)}`;
    const r = await call('POST', '/v1/sales', 'u-box', {
      saleId: `S-${receipt}`, receiptNumber: receipt, laneId: 'lane-1', locationId: S1, cashierId: 'u-cash', tradingDay: AT.slice(0, 10), committedAt: AT,
      totalMinor: 1_000, currency: 'INR', packVersion: 0, lines: [{ productId: 'P1', quantityMinor: 1, uom: 'ea', unitPriceMinor: 1_000, lineTotalMinor: 1_000 }],
      tenders: [{ kind: 'cash', amountMinor: 1_000 }],
    }, S1);
    expect(r.status).toBe(202);
  }
};
const report = async (call: Call, issued: unknown, queue: { unsent: number; deadLettered: number }): Promise<{ recorded: Record<string, unknown> }> => {
  const r = await call('POST', '/v1/store-computers/health-reports', 'u-box', {
    observedAt: new Date().toISOString(), disk: { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1000, salesLogCapacityBytes: 1e7, reserveBytes: 1e6 },
    queue, tills: [], receiptNumbersIssued: issued,
  }, S1);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { recorded: Record<string, unknown> };
};
const observed = async (call: Call): Promise<Observed> => {
  const r = await call('GET', '/v1/platform/operational-health/observed', OWNER);
  expect(r.status).toBe(200);
  return r.body as Observed;
};
const findings = async (call: Call, kind?: string): Promise<Finding[]> =>
  ((await observed(call)).observed.boxes.find((b) => b.storeId === S1)?.billNumberFindings ?? []).filter((f) => kind === undefined || f.kind === kind);
const comp = async (call: Call, name: string): Promise<Component | undefined> => (await observed(call)).health.components.find((c) => c.name === `${name}:${S1}`);

function clock(): { travel: (minutes: number) => void } {
  const t0 = Date.now();
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  return { travel: (minutes) => { vi.setSystemTime(t0 + minutes * 60_000); } };
}

const CLAIM = [{ prefix: P, through: 600, soldThrough: 600, unsent: { count: 1, from: 101, to: 600 } }];

async function aBoxThatAlwaysSaysStillSendingIsWarnedAbout(h: ApiHarness): Promise<void> {
  const { call } = await shop(h);
  await bank(call, 1, 100);
  const { travel } = clock();
  travel(0);
  await report(call, CLAIM, { unsent: 1, deadLettered: 0 });
  travel(119);
  await report(call, CLAIM, { unsent: 1, deadLettered: 0 });
  expect(await findings(call, 'bills_waiting_on_box')).toEqual([]); // inside the owner's line: not yet a warning (P-03)
  const early = await comp(call, 'box_queue');
  expect(early?.detail).not.toMatch(/has sent everything/); // bills are waiting — never "sent everything"
  expect(early?.detail).toMatch(/holds 1 item\(s\) still to send \(1 of them bills\)/);
  travel(121);
  await report(call, CLAIM, { unsent: 1, deadLettered: 0 });
  const w = await findings(call, 'bills_waiting_on_box');
  expect(w.map((f) => [f.prefix, f.ranges, f.count])).toEqual([[P, [[101, 600]], 1]]);
  expect(w[0]!.detail).toMatch(/^bills waiting on the store computer for 2 hours: store S1's computer has held 1 bill\(s\) under S1L1- \(between S1L1-000101 to S1L1-000600\) unsent since .* longer than the 2-hour line/);
  expect(w[0]!.detail).toMatch(/Do NOT re-enter these bills from paper until support has checked the store computer/);
  const bn = await comp(call, 'box_bill_numbers');
  expect(bn?.status).toBe('degraded');
  expect(bn?.detail).toMatch(/bills waiting on the store computer for 2 hours/);
  const q = await comp(call, 'box_queue');
  expect(q?.status).toBe('degraded');
  expect(q?.detail).toMatch(/bills waiting on the store computer for 2 hours/);
  // Seven days of the same claim, every hour: still said, with the true age — never quietly green.
  for (let hr = 3; hr <= 24 * 7; hr += 12) { travel(hr * 60); await report(call, CLAIM, { unsent: 1, deadLettered: 0 }); }
  travel(24 * 7 * 60 + 1);
  await report(call, CLAIM, { unsent: 1, deadLettered: 0 });
  expect((await findings(call, 'bills_waiting_on_box'))[0]?.detail).toMatch(/for 168 hours/);
  expect((await comp(call, 'box_queue'))?.status).toBe('degraded');

  // The line is the owner's: store setup, 1–72 whole hours, a cashier refused, kept with who changed it.
  const KEY = 'platform.box_unsent_warn_hours';
  expect((await call('PUT', `/v1/platform/setup/${KEY}`, 'u-cash', { value: 4 })).status).toBe(403);
  const bad = await call('PUT', `/v1/platform/setup/${KEY}`, OWNER, { value: 0 });
  expect(bad.status).toBe(422);
  expect(JSON.stringify(bad.body)).toMatch(/Give a whole number of hours, from 1 to 72/);
  expect((await call('PUT', `/v1/platform/setup/${KEY}`, OWNER, { value: 73 })).status).toBe(422);
  expect((await call('PUT', `/v1/platform/setup/${KEY}`, OWNER, { value: 1 })).status).toBe(200);
  const setup = (await call('GET', '/v1/platform/setup', OWNER)).body as { items: { key: string; value: unknown; changedBy?: string; version: number }[] };
  expect(setup.items.find((i) => i.key === KEY)).toMatchObject({ value: 1, changedBy: OWNER, version: 1 });
  // A fresh wait (the box drained, then one new bill waits) is warned about after 1 hour now, not 2.
  const t = 24 * 7 * 60 + 10;
  travel(t);
  await report(call, [{ prefix: P, through: 601, soldThrough: 601, unsent: { count: 1, from: 601, to: 601 } }], { unsent: 1, deadLettered: 0 });
  travel(t + 50);
  await report(call, [{ prefix: P, through: 601, soldThrough: 601, unsent: { count: 1, from: 601, to: 601 } }], { unsent: 1, deadLettered: 0 });
  expect(await findings(call, 'bills_waiting_on_box')).toEqual([]);
  travel(t + 61);
  expect((await findings(call, 'bills_waiting_on_box')).map((f) => f.ranges)).toEqual([[[601, 601]]]);
  // The box's OWN word that its oldest waiting bill was made 5 hours ago counts (older than head office has seen it).
  travel(t + 62);
  await report(call, [{ prefix: P, through: 602, soldThrough: 602, unsent: { count: 1, from: 602, to: 602, oldestAt: new Date(Date.now() - 5 * 3_600_000).toISOString() } }], { unsent: 1, deadLettered: 0 });
  expect((await findings(call, 'bills_waiting_on_box'))[0]?.detail).toMatch(/for 5 hours/);
}

async function aReportThatContradictsItsQueueIsNotBelieved(h: ApiHarness): Promise<void> {
  const { call } = await shop(h);
  await bank(call, 1, 100);
  const { travel } = clock();
  travel(0);
  const kept = await report(call, CLAIM, { unsent: 0, deadLettered: 0 });
  expect(kept.recorded['queueContradiction']).toMatch(/its bills still to send under each prefix add up to 1, more than the 0 item\(s\) its whole queue holds/);
  const q = await comp(call, 'box_queue');
  expect(q?.status).toBe('degraded');
  expect(q?.detail).toMatch(/contradicts itself/);
  expect(q?.detail).not.toMatch(/has sent everything/);
  expect((await findings(call, 'report_contradicts_its_queue')).length).toBe(1);
  // Not believed: after the grace the 500 bills head office never received are named — never hidden behind the claim.
  for (const m of [10, 20, UNRECEIVED_GRACE_MINUTES + 1]) { travel(m); await report(call, CLAIM, { unsent: 0, deadLettered: 0 }); }
  expect((await findings(call, 'issued_never_received')).flatMap((f) => f.ranges ?? [])).toEqual([[101, 600]]);
  // A per-prefix dead-letter count above the box's own is a contradiction too.
  const dead = await report(call, [{ prefix: P, through: 600, soldThrough: 600, unsent: { count: 0 }, deadLettered: { count: 2, from: 101, to: 102 } }], { unsent: 0, deadLettered: 1 });
  expect(dead.recorded['queueContradiction']).toMatch(/bills given up on under each prefix add up to 2, more than the 1 item\(s\) it says it gave up on/);
}

async function aBillTheBoxGaveUpOnIsNeverCalledLost(h: ApiHarness): Promise<void> {
  const { call } = await shop(h);
  await bank(call, 1, 100);
  const { travel } = clock();
  const GIVEN_UP = [{ prefix: P, through: 101, soldThrough: 101, unsent: { count: 0 }, deadLettered: { count: 1, from: 101, to: 101, oldestAt: AT } }];
  for (const m of [0, 10, 20, 31]) { travel(m); await report(call, GIVEN_UP, { unsent: 0, deadLettered: 1 }); }
  for (const m of [31, 180]) {
    travel(m);
    expect(await findings(call, 'issued_never_received')).toEqual([]);
    const d = await findings(call, 'bills_dead_lettered_on_box');
    expect(d.map((f) => [f.prefix, f.ranges, f.count])).toEqual([[P, [[101, 101]], 1]]);
    expect(d[0]!.detail).toMatch(/^needs a person \(the store computer gave up sending; do NOT re-enter from paper\): store S1's computer holds 1 bill\(s\) under S1L1- \(between S1L1-000101\)/);
    const bn = await comp(call, 'box_bill_numbers');
    expect(bn?.status).toBe('degraded');
    expect(bn?.detail).not.toMatch(/never received|find the paper bills and enter them/);
    const q = await comp(call, 'box_queue');
    expect(q?.detail).toMatch(/1 item\(s\) it gave up sending, waiting for a person \(do NOT re-enter those bills from paper\)/);
    expect(q?.detail).not.toMatch(/head office refused/);
  }
  // A person releases the dead letter; the bill arrives; the box lists none: the finding clears by itself.
  await bank(call, 101, 101);
  travel(181);
  await report(call, [{ prefix: P, through: 101, soldThrough: 101, unsent: { count: 0 }, deadLettered: { count: 0 } }], { unsent: 0, deadLettered: 0 });
  expect(await findings(call, 'bills_dead_lettered_on_box')).toEqual([]);
  expect(await findings(call, 'issued_never_received')).toEqual([]);
  expect((await comp(call, 'box_queue'))?.detail).toMatch(/has sent everything/);

  // An OLDER box (r21) that does not list its dead letters by prefix but holds one: never "enter the paper bills".
  for (const m of [200, 210, 200 + UNRECEIVED_GRACE_MINUTES + 2]) {
    travel(m);
    await report(call, [{ prefix: P, through: 102, soldThrough: 102, unsent: { count: 0 } }], { unsent: 0, deadLettered: 1 });
  }
  const nr = await findings(call, 'issued_never_received');
  expect(nr.flatMap((f) => f.ranges ?? [])).toEqual([[102, 102]]);
  expect(nr[0]!.detail).toMatch(/do NOT re-enter them from paper until a person has checked the store computer's "gave up sending" list/);
  expect(nr[0]!.detail).not.toMatch(/find the paper bills and enter them/);
}

describe('verifier r21 UNSENT-CEILING / DEAD-LETTER-AS-LOST (memory)', () => {
  it('the probe: a box that always says "1 still queued" is warned about past the owner\'s line, and the line is the owner\'s', async () => { await aBoxThatAlwaysSaysStillSendingIsWarnedAbout(apiHarness()); }, 120_000);
  it('the probe, contradicting its own queue: kept, said, not believed — the never-received bills are named', async () => { await aReportThatContradictsItsQueueIsNotBelieved(apiHarness()); }, 120_000);
  it('a bill the box gave up sending needs a person and is never called lost', async () => { await aBillTheBoxGaveUpOnIsNeverCalledLost(apiHarness()); }, 120_000);
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(DATABASE_URL === undefined)('verifier r21 UNSENT-CEILING / DEAD-LETTER-AS-LOST (PostgreSQL)', () => {
  const onPg = async (run: (h: ApiHarness) => Promise<void>): Promise<void> => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 16, options: '-c app.tenant_id=*' });
    const sql = pgPoolClient(pool);
    try { await run(apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) })); } finally { await pool.end(); }
  };
  it('the probe: a box that always says "1 still queued" is warned about past the owner\'s line', async () => { await onPg(aBoxThatAlwaysSaysStillSendingIsWarnedAbout); }, 300_000);
  it('the probe, contradicting its own queue: not believed', async () => { await onPg(aReportThatContradictsItsQueueIsNotBelieved); }, 300_000);
  it('a bill the box gave up sending is never called lost', async () => { await onPg(aBillTheBoxGaveUpOnIsNeverCalledLost); }, 300_000);
});
