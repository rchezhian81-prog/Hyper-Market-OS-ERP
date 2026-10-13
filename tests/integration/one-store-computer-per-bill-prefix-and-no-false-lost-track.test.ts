import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { UNRECEIVED_GRACE_MINUTES, UNRECEIVED_CHECK_CAP } from '../../services/platform/src/box-health';

/**
 * **Round 25 · owner decisions OB-93, OB-94 and OB-96 (13 Oct 2026, in writing) — through head office's production routes
 * (the store computer's health report, the sales intake, the acknowledgement, the observed health read), in memory and on
 * PostgreSQL.**
 *
 *   1. OB-93 "A" (verifier r24 NEW-1, probe P1): during a half-working line (sales not getting through, health reports
 *      getting through) ONE report from an honest store computer contradicts its own queue (a sale landed while it was
 *      being made). Head office no longer reads that report as the box letting the bills go: no "never received", no
 *      "lost track — call support" for bills the box truthfully holds. (The store computer side — counts and lists read
 *      in one step — is proved in tests/unit/a-store-computer-reports-in-one-step-and-says-numbers-it-never-used.test.ts.)
 *      The hiding tricks V23-A/V23-B still raise their findings (tests/integration/a-box-cannot-take-back-a-bill-it-let-go).
 *   2. OB-94 "A" (verifier r24 P4): a SECOND store computer at the same store reporting the same till's prefix with an
 *      empty queue is refused by name — its word is never used, so the first box's waiting bills are not called lost; the
 *      refusal is a finding naming both store computers, which only a person (owner / head office) clears; banking never
 *      clears it. The first store computer — also after a restore from its own backup — is never refused.
 *   3. OB-94 "A" (verifier r24 NEW-2, probes P6 and P5): a number the store computer took and never put on a bill (the
 *      sale could not be saved) is said in its report (`unused`) and never named "never received"; completed later, it is
 *      simply waiting, then banked — no contradiction. An older store computer without the field behaves as before.
 *   4. OB-96 "A": a report naming more numbers it cannot vouch for than head office checks per report (500) says the rest
 *      were not checked (`at_risk_not_checked`) — never dropped in silence; an over-long `unused` list is refused at the door.
 */

const OWNER = 'u-owner';
const S1 = 'S1';
const P = 'S1L1-';
const pad = (n: number): string => String(n).padStart(6, '0');
const AT = new Date(Date.now() - 60_000).toISOString();
const SETTINGS = { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 30 };
const ACK_PATH = '/v1/store-computers/bill-number-refusals/acknowledgements';

interface Finding { kind: string; prefix: string; ranges?: [number, number][]; count?: number; through?: number; since: string; detail: string }
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
  // Records here are dated by the UTC clock: the shop's own time zone is set to UTC so a trading day never shifts under them.
  expect((await call('PUT', '/v1/platform/setup/locale.time_zone', OWNER, { value: 'UTC' })).status).toBe(200);
  for (const [id, body] of [
    ['C1', { kind: 'company', name: 'SRE Retail' }],
    [S1, { kind: 'branch', name: 'Store One', parentId: 'C1', companyId: 'C1' }],
  ] as const) expect((await call('POST', `/v1/org/nodes/${id}`, OWNER, body)).status).toBeLessThan(300);
  expect((await call('POST', `/v1/stores/${S1}/settings`, OWNER, SETTINGS)).status).toBeLessThan(300);
  await h.provisionRole(T, 'u-box', 'store_computer', [S1]);
  await h.provisionRole(T, 'u-box-2', 'store_computer', [S1]); // a stand-by box, with its own sign-in for the same store
  await h.provisionRole(T, 'u-cash', 'cashier', [S1]);
  expect((await call('POST', `/v1/stores/${S1}/tills/lane-1/receipt-prefix`, OWNER, { prefix: P })).status).toBe(201);
  return { T, call };
}
// Round 27 · OB-100: a bill's own time (when the till made it) — `at` for a bill completed later than the shop's first bills.
const bank = async (call: Call, numbers: readonly number[], at = AT): Promise<void> => {
  for (let i = 0; i < numbers.length; i += 16) {
    await Promise.all(numbers.slice(i, i + 16).map(async (n) => {
      const receipt = `${P}${pad(n)}`;
      const r = await call('POST', '/v1/sales', 'u-box', {
        saleId: `S-${receipt}`, receiptNumber: receipt, laneId: 'lane-1', locationId: S1, cashierId: 'u-cash', tradingDay: at.slice(0, 10), committedAt: at,
        totalMinor: 1_000, currency: 'INR', packVersion: 0, lines: [{ productId: 'P1', quantityMinor: 1, uom: 'ea', unitPriceMinor: 1_000, lineTotalMinor: 1_000 }],
        tenders: [{ kind: 'cash', amountMinor: 1_000 }],
      }, S1);
      expect(r.status).toBe(202);
    }));
  }
};
const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const send = (call: Call, issued: unknown, queue: { unsent: number; deadLettered: number }, box = 'u-box') => call('POST', '/v1/store-computers/health-reports', box, {
  observedAt: new Date().toISOString(), disk: { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1000, salesLogCapacityBytes: 1e7, reserveBytes: 1e6 },
  queue, tills: [], receiptNumbersIssued: issued,
}, S1);
const report = async (call: Call, issued: unknown, queue: { unsent: number; deadLettered: number }, box = 'u-box'): Promise<void> => {
  const r = await send(call, issued, queue, box);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
const observed = async (call: Call): Promise<Observed> => {
  const r = await call('GET', '/v1/platform/operational-health/observed', OWNER);
  expect(r.status).toBe(200);
  return r.body as Observed;
};
const findings = async (call: Call, kind?: string): Promise<Finding[]> =>
  ((await observed(call)).observed.boxes.find((b) => b.storeId === S1)?.billNumberFindings ?? []).filter((f) => kind === undefined || f.kind === kind);
const comp = async (call: Call, name: string): Promise<Component | undefined> => (await observed(call)).health.components.find((c) => c.name === `${name}:${S1}`);

function clock(): { travel: (minutes: number) => void; t0: number } {
  const t0 = Date.now();
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  return { t0, travel: (minutes) => { vi.setSystemTime(t0 + minutes * 60_000); } };
}
const waiting = (from: number, to: number, count = to - from + 1) => [{ prefix: P, through: to, soldThrough: to, unsent: { count, from, to } }];

// ── 1. OB-93 (probe P1): one self-contradicting report from an honest box during a half-working line ────────────────────
async function oneRacyReportRaisesNoAlarm(h: ApiHarness): Promise<void> {
  const { call } = await shop(h);
  await bank(call, range(1, 100));
  const { travel } = clock();
  travel(0); await report(call, waiting(101, 110), { unsent: 10, deadLettered: 0 });
  // A sale landed while the box was making its report: in the list (11), not in the count (10) — it contradicts itself.
  travel(0.25); await report(call, waiting(101, 111), { unsent: 10, deadLettered: 0 });
  // Then honest reports, the list growing (sales still not getting through).
  for (let k = 1; k <= 40; k += 1) { travel(0.25 + k); await report(call, waiting(101, 111 + k), { unsent: 11 + k, deadLettered: 0 }); }
  travel(41);
  // Head office never read the racy report as "these are gone": no never-received, no "lost track — call support".
  expect(await findings(call, 'issued_never_received')).toEqual([]);
  expect(await findings(call, 'report_contradicts_earlier_report')).toEqual([]);
  expect(await findings(call)).toEqual([]);
  expect((await comp(call, 'box_bill_numbers'))?.status ?? 'absent').toBe('absent');
  // The line comes back: everything arrives, still nothing to say.
  await bank(call, range(101, 151));
  travel(41.5); await report(call, [{ prefix: P, through: 151, soldThrough: 151, unsent: { count: 0 } }], { unsent: 0, deadLettered: 0 });
  travel(41.5 + UNRECEIVED_GRACE_MINUTES + 1);
  expect(await findings(call)).toEqual([]);
}

// ── 2. OB-94 (probe P4): a second store computer reporting the same till's prefix ──────────────────────────────────────
async function aSecondStoreComputerIsRefusedByName(h: ApiHarness): Promise<void> {
  const { T, call } = await shop(h);
  await h.provisionRole(T, 'u-it', 'platform_admin', 'all');
  await bank(call, range(1, 100));
  const { travel } = clock();
  for (let k = 0; k <= 40; k += 1) {
    travel(k); await report(call, waiting(101, 110), { unsent: 10, deadLettered: 0 });
    // A stand-by box, set up with the same till, reports the same prefix once: "nothing waiting".
    if (k === 5) { travel(k + 0.02); await report(call, [{ prefix: P, through: 110, soldThrough: 110, unsent: { count: 0 } }], { unsent: 0, deadLettered: 0 }, 'u-box-2'); }
  }
  travel(41);
  // Its word is never used: the first box's waiting bills are not called lost, and nothing "lost track".
  expect(await findings(call, 'issued_never_received')).toEqual([]);
  expect(await findings(call, 'report_contradicts_earlier_report')).toEqual([]);
  // The refusal is a finding, by name: both store computers are named.
  const refused = await findings(call, 'report_refused');
  expect(refused.map((f) => [f.prefix, f.through])).toEqual([[P, 110]]);
  // Round 27 · OB-101: neutral — both named, which one head office uses and why; neither called the wrong machine.
  expect(refused[0]!.detail).toMatch(/^two store computers report bill numbers under S1L1- for store S1: u-box and u-box-2\. Head office uses u-box's reports for S1L1- because it was the first to report S1L1-, at \S+; it keeps u-box-2's report \(through 110\) as evidence and does not use it\. One store computer per bill-number prefix \(owner decision OB-94\)/);
  expect(refused[0]!.detail).toMatch(/Check both machines/);
  expect(refused[0]!.detail).not.toMatch(/Check which machine/);
  expect((await comp(call, 'box_bill_numbers'))?.status).toBe('degraded');
  // Banking everything never clears it (it is not a count that "turned out true") — only a person does.
  await bank(call, range(101, 110));
  travel(42); await report(call, [{ prefix: P, through: 110, soldThrough: 110, unsent: { count: 0 } }], { unsent: 0, deadLettered: 0 });
  expect((await findings(call, 'report_refused')).map((f) => f.through)).toEqual([110]);
  // Not the IT administrator (OB-91); the owner, with a reason — kept, by name.
  const ack = (user: string) => call('POST', ACK_PATH, user, { storeId: S1, prefix: P, through: 110, reason: 'stand-by box switched off' });
  expect((await ack('u-it')).status).toBe(403);
  expect((await ack(OWNER)).status).toBe(201);
  expect(await findings(call)).toEqual([]);
  // The first store computer is never refused — also after a restore from its own backup (its sign-in is its own): it
  // reports numbers it cannot vouch for, and head office uses its word as always.
  travel(43); await report(call, [{ prefix: P, through: 115, soldThrough: 115, atRisk: [[111, 115]], unsent: { count: 0 } }], { unsent: 0, deadLettered: 0 });
  travel(43 + UNRECEIVED_GRACE_MINUTES + 1);
  expect((await findings(call, 'issued_never_received')).map((f) => f.ranges)).toEqual([[[111, 115]]]);
  expect(await findings(call, 'report_refused')).toEqual([]);
}

// ── 3. OB-94 (probes P6, P5): a number taken and never used ────────────────────────────────────────────────────────────
async function aNumberNeverUsedIsNeverNamed(h: ApiHarness): Promise<void> {
  const { call } = await shop(h);
  await bank(call, range(1, 104));
  const { travel } = clock();
  // 105 was taken, the sale could not be saved, the till took 106 for the next try. 106–110 wait (the line is down).
  for (let k = 0; k <= 45; k += 1) {
    travel(k);
    await report(call, [{ prefix: P, through: 110, soldThrough: 110, unsent: { count: 5, from: 106, to: 110 }, unused: [[105, 105]] }], { unsent: 5, deadLettered: 0 });
  }
  travel(46);
  expect(await findings(call)).toEqual([]); // P6: 105 is never "never received", no paper bill is looked for
  // P5: had 105 been completed after all (a sale re-sent with its number), it is simply waiting — then banked.
  travel(47); await report(call, waiting(105, 110), { unsent: 6, deadLettered: 0 });
  travel(47 + UNRECEIVED_GRACE_MINUTES + 1);
  expect(await findings(call)).toEqual([]);
  // Completed at minute 47 (after the store computer last said 105 was never used): no contradiction (OB-100).
  await bank(call, range(105, 110), new Date().toISOString());
  travel(80); await report(call, [{ prefix: P, through: 110, soldThrough: 110, unsent: { count: 0 } }], { unsent: 0, deadLettered: 0 });
  travel(80 + UNRECEIVED_GRACE_MINUTES + 1);
  expect(await findings(call)).toEqual([]);
}

async function anOlderBoxWithoutTheFieldBehavesAsBefore(h: ApiHarness): Promise<void> {
  const { call } = await shop(h);
  await bank(call, range(1, 104));
  const { travel } = clock();
  for (let k = 0; k <= 45; k += 1) { travel(k); await report(call, waiting(106, 110).map((x) => ({ ...x, through: 110, soldThrough: 110 })), { unsent: 5, deadLettered: 0 }); }
  travel(46);
  // As before round 25: the box does not say 105 was never used, so head office names it.
  expect((await findings(call, 'issued_never_received')).map((f) => f.ranges)).toEqual([[[105, 105]]]);
}

// ── 4. OB-96: the check is bounded, and what it does not check is said ────────────────────────────────────────────────
async function whatIsNotCheckedIsSaid(h: ApiHarness): Promise<void> {
  const { call } = await shop(h);
  await bank(call, range(1, 100));
  const { travel } = clock();
  travel(0);
  await report(call, [{ prefix: P, through: 1_300, soldThrough: 1_300, atRisk: [[101, 700], [1_001, 1_300]], unsent: { count: 0 } }], { unsent: 0, deadLettered: 0 });
  const notChecked = await findings(call, 'at_risk_not_checked');
  expect(notChecked.map((f) => [f.prefix, f.count])).toEqual([[P, 900 - UNRECEIVED_CHECK_CAP]]);
  expect(notChecked[0]!.detail).toMatch(/^not checked: store S1's computer says it cannot vouch for 900 bill number\(s\) under S1L1- .* so 400 older one\(s\), below S1L1-000501, were NOT checked/);
  // A list of numbers never used beyond head office's bounds is refused at the door, by name — nothing recorded.
  const tooMany = Array.from({ length: 51 }, (_, i) => [i * 2 + 1, i * 2 + 1]);
  for (const unused of [tooMany, [[1, 501]], [[5, 4]], [[3, 4], [1, 2]], [[1, 1_400]].map(([a]) => [a, 1_400])]) {
    const r = await send(call, [{ prefix: P, through: 1_300, soldThrough: 1_300, unused, unsent: { count: 0 } }], { unsent: 0, deadLettered: 0 });
    expect(r.status, JSON.stringify(unused)).toBe(400);
    expect((r.body as { error: { code: string; whatHappened: string } }).error).toMatchObject({ code: 'not_readable_as_box_health' });
    expect((r.body as { error: { whatHappened: string } }).error.whatHappened).toMatch(/unused must be at most 50 \[from, to\] ranges/);
  }
}

describe('round 25 · OB-93 / OB-94 / OB-96 (memory)', () => {
  it('OB-93 (P1): one self-contradicting report from an honest box raises no "lost track" alarm', async () => { await oneRacyReportRaisesNoAlarm(apiHarness()); }, 180_000);
  it('OB-94 (P4): a second store computer reporting the same prefix is refused by name; its word is never used', async () => { await aSecondStoreComputerIsRefusedByName(apiHarness()); }, 180_000);
  it('OB-94 (P6/P5): a number taken and never used is never named never received; completed later it simply waits', async () => { await aNumberNeverUsedIsNeverNamed(apiHarness()); }, 180_000);
  it('OB-94: an older store computer without the field behaves as before', async () => { await anOlderBoxWithoutTheFieldBehavesAsBefore(apiHarness()); }, 180_000);
  it('OB-96: numbers beyond the per-report check are said, and an over-long unused list is refused', async () => { await whatIsNotCheckedIsSaid(apiHarness()); }, 120_000);
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(DATABASE_URL === undefined)('round 25 · OB-93 / OB-94 / OB-96 (PostgreSQL)', () => {
  const onPg = async (run: (h: ApiHarness) => Promise<void>): Promise<void> => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 16, options: '-c app.tenant_id=*' });
    const sql = pgPoolClient(pool);
    try { await run(apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) })); } finally { await pool.end(); }
  };
  it('OB-93 (P1): one self-contradicting report from an honest box raises no "lost track" alarm', async () => { await onPg(oneRacyReportRaisesNoAlarm); }, 300_000);
  it('OB-94 (P4): a second store computer reporting the same prefix is refused by name; its word is never used', async () => { await onPg(aSecondStoreComputerIsRefusedByName); }, 300_000);
  it('OB-94 (P6/P5): a number taken and never used is never named never received; completed later it simply waits', async () => { await onPg(aNumberNeverUsedIsNeverNamed); }, 300_000);
  it('OB-94: an older store computer without the field behaves as before', async () => { await onPg(anOlderBoxWithoutTheFieldBehavesAsBefore); }, 300_000);
  it('OB-96: numbers beyond the per-report check are said, and an over-long unused list is refused', async () => { await onPg(whatIsNotCheckedIsSaid); }, 300_000);
});
