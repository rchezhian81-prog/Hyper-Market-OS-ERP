import { describe, it, expect, vi, afterEach, afterAll, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Pool } from 'pg';
import { apiHarness, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import { startRealCloud, type RealCloud } from '../support/real-store';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM, streamName } from '../../services/api/src/adapters';
import { UNRECEIVED_GRACE_MINUTES, REFUSAL_STAYS_WORDS } from '../../services/platform/src/box-health';
import { ROLE_CATALOGUE, PLATFORM_ADMIN_ROLE_ID, isPlatformAdministrationRole } from '../../services/api/src/roles';

/**
 * **Verifier r23 NEW-1, NEW-3, NEW-4 · owner decisions OB-89 and OB-91 (13 Oct 2026, in writing).** Through head office's
 * production routes (the box's health report, the sales intake, the acknowledgement, the observed health read), in
 * memory and on PostgreSQL:
 *
 *   1. NEW-1 · OB-89 (probe zz-v23 A): a box that sends "nothing waiting" (queue 0) a few seconds before each "500 waiting,
 *      101–600" report, every 6 hours for 7 days, no longer hides anything. A box keeps a bill until head office takes it,
 *      so a bill it has said it no longer holds cannot honestly come back: after the grace those 500 are named "never
 *      received", the contradiction is said by name (`report_contradicts_earlier_report`), and the waiting clock runs
 *      from head office's FIRST sight of them waiting (168 hours), never restarted by the "nothing waiting" reports.
 *   2. NEW-1 · OB-89 (probe zz-v23 B): the same trick from a box that gives no per-prefix list (queue 0, then queue 1):
 *      the 500 numbers its "queue 0" reports let go are named after the grace — its later whole queue no longer stands in
 *      for them.
 *   3. The honest cases stay quiet: a box draining its queue normally (catch-up, new sales, empty queue between busy
 *      spells, an older box without lists as well); a box that restarts and re-reports the same still-unsent bills; and
 *      bills banked late (head office takes them after the box has let them go, inside the grace).
 *   4. NEW-3 · OB-91: the IT/platform administrator — even with all-stores scope — is refused by name (403
 *      acknowledgement_refused_to_platform_administrator, nothing kept, on the audit trail); the owner and head-office
 *      BUSINESS staff with all stores (a manager granted all stores) still acknowledge.
 *   5. NEW-4 · OB-90: the ops-alert worker (which raises the owner's inbox alerts by itself) uses the owner's claim slack:
 *      with 0 / 0 it raises the bill-number alert that the defaults (5 / 5%) would not.
 */

const OWNER = 'u-owner';
const S1 = 'S1';
const P = 'S1L1-';
const pad = (n: number): string => String(n).padStart(6, '0');
const AT = new Date(Date.now() - 60_000).toISOString();
const SETTINGS = { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 15 };
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
    ['S2', { kind: 'branch', name: 'Store Two', parentId: 'C1', companyId: 'C1' }],
  ] as const) expect((await call('POST', `/v1/org/nodes/${id}`, OWNER, body)).status).toBeLessThan(300);
  expect((await call('POST', `/v1/stores/${S1}/settings`, OWNER, SETTINGS)).status).toBeLessThan(300);
  await h.provisionRole(T, 'u-box', 'store_computer', [S1]);
  await h.provisionRole(T, 'u-cash', 'cashier', [S1]);
  expect((await call('POST', `/v1/stores/${S1}/tills/lane-1/receipt-prefix`, OWNER, { prefix: P })).status).toBe(201);
  return { T, call };
}
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
const report = async (call: Call, issued: unknown, queue: { unsent: number; deadLettered: number }): Promise<void> => {
  const r = await call('POST', '/v1/store-computers/health-reports', 'u-box', {
    observedAt: new Date().toISOString(), disk: { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1000, salesLogCapacityBytes: 1e7, reserveBytes: 1e6 },
    queue, tills: [], receiptNumbersIssued: issued,
  }, S1);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
const observed = async (call: Call): Promise<Observed> => {
  const r = await call('GET', '/v1/platform/operational-health/observed', OWNER);
  expect(r.status).toBe(200);
  return r.body as Observed;
};
const findings = async (call: Call, kind?: string): Promise<Finding[]> =>
  ((await observed(call)).observed.boxes.find((b) => b.storeId === S1)?.billNumberFindings ?? []).filter((f) => kind === undefined || f.kind === kind);
const neverReceived = async (call: Call): Promise<[number, number][]> => (await findings(call, 'issued_never_received')).flatMap((f) => f.ranges ?? []);
const comp = async (call: Call, name: string): Promise<Component | undefined> => (await observed(call)).health.components.find((c) => c.name === `${name}:${S1}`);

/** The clock keeps moving between travels (shouldAdvanceTime): a time head office stamped is within a second of the travel. */
const near = (iso: string, ms: number): boolean => Math.abs(Date.parse(iso) - ms) < 1_000;

function clock(): { travel: (minutes: number) => void; t0: number } {
  const t0 = Date.now();
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  return { t0, travel: (minutes) => { vi.setSystemTime(t0 + minutes * 60_000); } };
}

const ZERO = [{ prefix: P, through: 600, soldThrough: 600, unsent: { count: 0 } }];
const FULL = [{ prefix: P, through: 600, soldThrough: 600, unsent: { count: 500, from: 101, to: 600 } }];

// ── 1. NEW-1 · OB-89 (probe V23-A): "nothing waiting" before each "still waiting" hides nothing ───────────────────────
async function anEmptyQueueBeforeEachClaimHidesNothing(h: ApiHarness): Promise<void> {
  const { call } = await shop(h);
  await bank(call, 1, 100);
  const { travel, t0 } = clock();
  const pair = async (minutes: number): Promise<void> => {
    travel(minutes); await report(call, ZERO, { unsent: 0, deadLettered: 0 });
    travel(minutes + 0.05); await report(call, FULL, { unsent: 500, deadLettered: 0 });
  };
  await pair(0);
  // Inside the grace from the first "nothing waiting": nothing named yet — and the box's last word holds them.
  travel(UNRECEIVED_GRACE_MINUTES - 1);
  expect(await neverReceived(call)).toEqual([]);
  expect(await findings(call, 'report_contradicts_earlier_report')).toEqual([]);
  for (let hr = 6; hr <= 24 * 7; hr += 6) await pair(hr * 60);
  travel(24 * 7 * 60 + 1);
  // The 500 head office never received are named; the box claiming them again holds nothing back.
  expect(await neverReceived(call)).toEqual([[101, 600]]);
  const named = (await findings(call, 'issued_never_received'))[0]!;
  expect(near(named.since, t0)).toBe(true); // from the FIRST "nothing waiting", never restarted
  expect(named.detail).toMatch(/The store computer said at .* that it no longer held S1L1-000101 to S1L1-000600, and its latest report says they are in its list of bills still to send, given up on, or given and never used again/);
  expect(named.detail).toMatch(/Do NOT re-enter any of them from paper until a person has checked/);
  expect(named.detail).not.toMatch(/find the paper bills and enter them/);
  // The contradiction is said by name.
  const contra = await findings(call, 'report_contradicts_earlier_report');
  expect(contra.map((f) => [f.prefix, f.ranges, near(f.since, t0)])).toEqual([[P, [[101, 600]], true]]);
  expect(contra[0]!.detail).toMatch(/^store S1's computer contradicts its own earlier report: at .* it said it no longer held S1L1-000101 to S1L1-000600 \(head office has not received them\), and its latest report .* lists them as still on it/);
  expect(contra[0]!.detail).toMatch(/The store computer or head office lost track of these bills — call support/);
  expect(contra[0]!.detail).not.toMatch(/faulty or altered/); // OB-92: no blame placed
  // And the waiting clock is the NUMBERS' — from head office's first sight of them waiting, 168 hours ago.
  const waiting = await findings(call, 'bills_waiting_on_box');
  expect(waiting.map((f) => [f.ranges, near(f.since, t0 + 3_000)])).toEqual([[[[101, 600]], true]]); // the first FULL report
  expect(waiting[0]!.detail).toMatch(/^bills waiting on the store computer for 168 hours: .* head office first saw S1L1-000101 to S1L1-000600 said to be waiting at /);
  expect((await comp(call, 'box_bill_numbers'))?.status).toBe('degraded');
  expect((await comp(call, 'box_queue'))?.status).toBe('degraded');
}

// ── 2. NEW-1 · OB-89 (probe V23-B): the same trick without a per-prefix list ─────────────────────────────────────────
async function anEmptyQueueBeforeEachWholeQueueHidesNothing(h: ApiHarness): Promise<void> {
  const { call } = await shop(h);
  await bank(call, 1, 100);
  const { travel, t0 } = clock();
  const OLD = [{ prefix: P, through: 600, soldThrough: 600 }]; // an older (or altered) box: no `unsent`
  for (let hr = 0; hr <= 24 * 7; hr += 6) {
    travel(hr * 60); await report(call, OLD, { unsent: 0, deadLettered: 0 });
    travel(hr * 60 + 0.05); await report(call, OLD, { unsent: 1, deadLettered: 0 });
  }
  travel(24 * 7 * 60 + 1);
  expect(await neverReceived(call)).toEqual([[101, 600]]);
  const named = (await findings(call, 'issued_never_received'))[0]!;
  expect(near(named.since, t0)).toBe(true);
  expect(named.detail).toMatch(/and its latest report says its queue holds item\(s\) still to send, without saying which again/);
  expect(named.detail).toMatch(/Do NOT re-enter any of them from paper/);
  // Its whole queue is not a list: no number is said to be claimed by name, so no list contradiction is raised.
  expect(await findings(call, 'report_contradicts_earlier_report')).toEqual([]);
  expect((await comp(call, 'box_bill_numbers'))?.status).toBe('degraded');
}

// ── 2b. NEW-1: a bill the box let go is never "accounted for" by a later sparse claim either ────────────────────────────
async function aSparseClaimNeverAccountsForABillLetGo(h: ApiHarness): Promise<void> {
  const { call } = await shop(h);
  await bank(call, 1, 100);
  await bank(call, 106, 200); // 101–105 never arrive
  const { travel } = clock();
  travel(0);
  // A box restored from a backup cannot vouch for 101–105, and says it holds nothing to send.
  await report(call, [{ prefix: P, through: 200, soldThrough: 200, atRisk: [[101, 105]], unsent: { count: 0 } }], { unsent: 0, deadLettered: 0 });
  // Later: "3 bills waiting somewhere in 101–200". Five missing there would fit 3 + the 5-number slack — but the box has
  // already said it no longer held them, so the claim accounts for none of them.
  travel(UNRECEIVED_GRACE_MINUTES + 1);
  await report(call, [{ prefix: P, through: 200, soldThrough: 200, unsent: { count: 3, from: 101, to: 200 } }], { unsent: 3, deadLettered: 0 });
  expect(await neverReceived(call)).toEqual([[101, 105]]);
  expect((await findings(call, 'report_contradicts_earlier_report')).map((f) => f.ranges)).toEqual([[[101, 105]]]);
}

// ── 3. The honest cases stay quiet ──────────────────────────────────────────────────────────────────────────────────
async function honestBoxesStayQuiet(h: ApiHarness): Promise<void> {
  const { call } = await shop(h);
  await bank(call, 1, 100);
  const { travel } = clock();
  const quiet = async (when: string): Promise<void> => {
    expect(await findings(call), when).toEqual([]);
    expect((await comp(call, 'box_bill_numbers'))?.status ?? 'absent', when).toBe('absent');
  };
  // (a) Draining normally: reconnected with 500 queued, 100 sent a pass every 10 minutes while the till keeps selling;
  //     the queue empties, then a busy spell queues a few again, then it empties again — over four hours.
  let sold = 600;
  let banked = 100;
  for (let pass = 0; pass <= 6; pass += 1) {
    travel(pass * 10);
    if (pass > 0) { const to = Math.min(sold, banked + 100); await bank(call, banked + 1, to); banked = to; }
    sold += 2;
    const waiting = sold - banked;
    await report(call, [{ prefix: P, through: sold, soldThrough: sold, unsent: waiting === 0 ? { count: 0 } : { count: waiting, from: banked + 1, to: sold } }], { unsent: waiting, deadLettered: 0 });
  }
  await bank(call, banked + 1, sold); banked = sold;
  travel(70);
  await report(call, [{ prefix: P, through: sold, soldThrough: sold, unsent: { count: 0 } }], { unsent: 0, deadLettered: 0 });
  for (let m = 80; m <= 240; m += 20) {
    travel(m);
    sold += 3; // a busy spell: three bills waiting at the report, sent before the next one
    await report(call, [{ prefix: P, through: sold, soldThrough: sold, unsent: { count: 3, from: sold - 2, to: sold } }], { unsent: 3, deadLettered: 0 });
    await bank(call, banked + 1, sold); banked = sold;
    travel(m + 1);
    await report(call, [{ prefix: P, through: sold, soldThrough: sold, unsent: { count: 0 } }], { unsent: 0, deadLettered: 0 });
  }
  travel(240 + UNRECEIVED_GRACE_MINUTES + 5);
  await quiet('draining normally');

  // (b) A box that restarts and re-reports the same still-unsent bills (head office's intake was slow): 40 waiting, the
  //     box off for 25 minutes, the same 40 again after the restart, then sent — inside the owner's line.
  const t = 240 + UNRECEIVED_GRACE_MINUTES + 10;
  sold += 40;
  const still = [{ prefix: P, through: sold, soldThrough: sold, unsent: { count: 40, from: sold - 39, to: sold } }];
  travel(t); await report(call, still, { unsent: 40, deadLettered: 0 });
  travel(t + 1); await report(call, still, { unsent: 40, deadLettered: 0 });
  travel(t + 26); await report(call, still, { unsent: 40, deadLettered: 0 }); // after the restart: the same bills
  travel(t + 60); await report(call, still, { unsent: 40, deadLettered: 0 });
  await bank(call, banked + 1, sold); banked = sold;
  travel(t + 61); await report(call, [{ prefix: P, through: sold, soldThrough: sold, unsent: { count: 0 } }], { unsent: 0, deadLettered: 0 });
  travel(t + 61 + UNRECEIVED_GRACE_MINUTES + 5);
  await quiet('a restart re-reporting the same still-unsent bills');

  // (c) Bills banked late: head office took them (the box let them go) but books them 20 minutes later — inside the grace.
  const u = t + 61 + UNRECEIVED_GRACE_MINUTES + 10;
  sold += 25;
  travel(u); await report(call, [{ prefix: P, through: sold, soldThrough: sold, unsent: { count: 0 } }], { unsent: 0, deadLettered: 0 });
  travel(u + 20); await report(call, [{ prefix: P, through: sold, soldThrough: sold, unsent: { count: 0 } }], { unsent: 0, deadLettered: 0 });
  await bank(call, banked + 1, sold); banked = sold;
  travel(u + UNRECEIVED_GRACE_MINUTES + 30);
  await report(call, [{ prefix: P, through: sold, soldThrough: sold, unsent: { count: 0 } }], { unsent: 0, deadLettered: 0 });
  await quiet('bills banked late');

  // (d) An older box (no per-prefix list) draining normally: queue 3, then 0 once they are sent, again and again.
  const OLDP = 'S1L2-';
  expect((await call('POST', `/v1/stores/${S1}/tills/lane-2/receipt-prefix`, OWNER, { prefix: OLDP })).status).toBe(201);
  let oldSold = 0;
  const v = u + UNRECEIVED_GRACE_MINUTES + 40;
  for (let m = 0; m <= 180; m += 15) {
    oldSold += 3;
    travel(v + m); await report(call, [{ prefix: OLDP, through: oldSold, soldThrough: oldSold }], { unsent: 3, deadLettered: 0 });
    for (let n = oldSold - 2; n <= oldSold; n += 1) {
      const receipt = `${OLDP}${pad(n)}`;
      const r = await call('POST', '/v1/sales', 'u-box', {
        saleId: `S-${receipt}`, receiptNumber: receipt, laneId: 'lane-2', locationId: S1, cashierId: 'u-cash', tradingDay: AT.slice(0, 10), committedAt: AT,
        totalMinor: 1_000, currency: 'INR', packVersion: 0, lines: [{ productId: 'P1', quantityMinor: 1, uom: 'ea', unitPriceMinor: 1_000, lineTotalMinor: 1_000 }],
        tenders: [{ kind: 'cash', amountMinor: 1_000 }],
      }, S1);
      expect(r.status).toBe(202);
    }
    travel(v + m + 1); await report(call, [{ prefix: OLDP, through: oldSold, soldThrough: oldSold }], { unsent: 0, deadLettered: 0 });
  }
  travel(v + 180 + UNRECEIVED_GRACE_MINUTES + 5);
  await quiet('an older box draining normally');
}

// ── 4. NEW-3 · OB-91: the IT/platform administrator never clears a suspicious bill count ─────────────────────────────
async function theItAdministratorIsRefusedByName(h: ApiHarness): Promise<void> {
  const { T, call } = await shop(h);
  await h.provisionRole(T, 'u-it', PLATFORM_ADMIN_ROLE_ID, 'all');
  await h.provisionRole(T, 'u-ho-mgr', 'store_manager', 'all'); // head office business staff given all stores
  await bank(call, 1, 150);
  const refused = async (): Promise<(number | undefined)[]> => (await findings(call, 'report_refused')).map((f) => f.through);
  const ack = (user: string, through: number, reason: string) => call('POST', ACK_PATH, user, { storeId: S1, prefix: P, through, reason });
  await report(call, [{ prefix: P, through: 10_600, soldThrough: 10_600 }], { unsent: 0, deadLettered: 0 });
  expect(await refused()).toEqual([10_600]);
  expect((await findings(call, 'report_refused'))[0]!.detail).toContain(REFUSAL_STAYS_WORDS);
  expect(REFUSAL_STAYS_WORDS).toMatch(/a store's own manager cannot, and neither can the IT\/platform administrator/);
  // The IT administrator, with ALL stores: refused by name, nothing kept, the warning stays.
  const no = await ack('u-it', 10_600, 'IT looked at the box');
  expect(no.status).toBe(403);
  expect((no.body as { error: { code: string; wasItSaved: string; whatHappened: string } }).error).toMatchObject({ code: 'acknowledgement_refused_to_platform_administrator', wasItSaved: 'not_saved' });
  expect((no.body as { error: { whatHappened: string } }).error.whatHappened).toMatch(/owner decision OB-91/);
  expect(await refused()).toEqual([10_600]);
  expect(await h.store.readStream(T, streamName(STREAM.org, 'store-computer-refusal-acknowledgements'))).toEqual([]);
  // Head office business staff with all stores: allowed. And the owner: allowed.
  const yes = await ack('u-ho-mgr', 10_600, 'head office manager checked the box');
  expect(yes.status).toBe(201);
  expect(await refused()).toEqual([]);
  await report(call, [{ prefix: P, through: 10_700, soldThrough: 10_700 }], { unsent: 0, deadLettered: 0 });
  expect(await refused()).toEqual([10_700]);
  expect((await ack('u-it', 10_700, 'IT tries again')).status).toBe(403);
  expect((await ack(OWNER, 10_700, 'owner checked the box')).status).toBe(201);
  expect(await refused()).toEqual([]);
}

describe('verifier r23 NEW-1 / NEW-3 · OB-89 / OB-91 (memory)', () => {
  it('V23-A: an empty-queue report before each claim hides nothing; the contradiction is said', async () => { await anEmptyQueueBeforeEachClaimHidesNothing(apiHarness()); }, 180_000);
  it('V23-B: the same trick without a per-prefix list hides nothing', async () => { await anEmptyQueueBeforeEachWholeQueueHidesNothing(apiHarness()); }, 180_000);
  it('a bill the box let go is never accounted for by a later sparse claim', async () => { await aSparseClaimNeverAccountsForABillLetGo(apiHarness()); }, 120_000);
  it('honest boxes stay quiet: draining normally, a restart re-reporting the same bills, bills banked late, an older box', async () => { await honestBoxesStayQuiet(apiHarness()); }, 180_000);
  it('OB-91: the IT/platform administrator is refused by name even with all stores; owner and head-office staff are not', async () => { await theItAdministratorIsRefusedByName(apiHarness()); }, 120_000);
});

describe('OB-91: which roles are the platform/IT administration function', () => {
  it('the platform administrator is; the owner and the store manager (who hold platform.alert.manage too) are not', () => {
    const role = (id: string) => ROLE_CATALOGUE.find((r) => r.id === id)!;
    expect(isPlatformAdministrationRole(role(PLATFORM_ADMIN_ROLE_ID))).toBe(true);
    expect(isPlatformAdministrationRole(role('owner'))).toBe(false);
    expect(isPlatformAdministrationRole(role('store_manager'))).toBe(false);
    // Any role whose whole grant is platform administration counts the same, whatever it is called.
    expect(isPlatformAdministrationRole({ id: 'it_helpdesk', name: 'IT helpdesk', permissions: ['identity.self.read', 'platform.alert.manage', 'platform.health.read'] })).toBe(true);
    expect(isPlatformAdministrationRole({ id: 'ho_ops', name: 'Head office operations', permissions: ['platform.alert.manage', 'reporting.report.read'] })).toBe(false);
    // Of the catalogue's roles that may manage alerts, only the platform administrator is the IT function.
    expect(ROLE_CATALOGUE.filter((r) => r.permissions.includes('platform.alert.manage')).map((r) => [r.id, isPlatformAdministrationRole(r)]))
      .toEqual([['owner', false], ['store_manager', false], [PLATFORM_ADMIN_ROLE_ID, true]]);
  });
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(DATABASE_URL === undefined)('verifier r23 NEW-1 / NEW-3 · OB-89 / OB-91 (PostgreSQL)', () => {
  const onPg = async (run: (h: ApiHarness) => Promise<void>): Promise<void> => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 16, options: '-c app.tenant_id=*' });
    const sql = pgPoolClient(pool);
    try { await run(apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) })); } finally { await pool.end(); }
  };
  it('V23-A: an empty-queue report before each claim hides nothing; the contradiction is said', async () => { await onPg(anEmptyQueueBeforeEachClaimHidesNothing); }, 300_000);
  it('V23-B: the same trick without a per-prefix list hides nothing', async () => { await onPg(anEmptyQueueBeforeEachWholeQueueHidesNothing); }, 300_000);
  it('a bill the box let go is never accounted for by a later sparse claim', async () => { await onPg(aSparseClaimNeverAccountsForABillLetGo); }, 300_000);
  it('honest boxes stay quiet: draining normally, a restart re-reporting the same bills, bills banked late, an older box', async () => { await onPg(honestBoxesStayQuiet); }, 300_000);
  it('OB-91: the IT/platform administrator is refused by name even with all stores; owner and head-office staff are not', async () => { await onPg(theItAdministratorIsRefusedByName); }, 300_000);
});

describe.skipIf(DATABASE_URL === undefined)('OB-91 / OB-90 on the served API (PostgreSQL): the refusal is audited; the alert worker uses the owner\'s slack', () => {
  let real: RealCloud;
  let platform: Pool;
  const TENANT = randomUUID();
  beforeAll(async () => {
    platform = new Pool({ connectionString: DATABASE_URL, max: 2 });
    real = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId: TENANT, owner: OWNER, packSigningKey: TEST_PACK_KEY, providers: { opsAlertWorkerIntervalMs: 50 } });
  }, 180_000);
  afterAll(async () => { await real?.stop(); await platform?.end(); vi.useRealTimers(); });

  it('OB-91: the IT administrator with all stores gets 403 by name, nothing kept, and the refusal is in audit_log', async () => {
    // The IT administrator's role is laid down by the operator (the owner's own role may not hand out platform_admin's —
    // the no-escalation rule), as tests/integration/keycloak-provisioning.test.ts does.
    await new SqlEventStore(pgPoolClient(platform)).append(TENANT, STREAM.identity, makeEvent({
      id: `grant-it-${TENANT}`, type: 'RoleGranted', occurredAt: new Date().toISOString(), idempotencyKey: `grant-${TENANT}-platform_admin-u-it`, source: 'test/ob-91',
      payload: { userId: 'u-it', roleId: PLATFORM_ADMIN_ROLE_ID, branchScope: 'all', request: { grantId: 'platform_admin-u-it', userId: 'u-it', roleId: PLATFORM_ADMIN_ROLE_ID, branchScope: 'all', requestedBy: 'operator', approvedBy: 'operator', requestedAt: new Date().toISOString() } },
    }));
    const key = `ack-${randomUUID()}`;
    const no = await real.request({ method: 'POST', path: ACK_PATH, userId: 'u-it', idempotencyKey: key, body: { storeId: 'A1', prefix: 'A1L1-', through: 20_000, reason: 'IT tries to clear it' } });
    expect(no.status).toBe(403);
    expect((no.body as { error: { code: string } }).error.code).toBe('acknowledgement_refused_to_platform_administrator');
    const audit = await platform.query('SELECT status, permission FROM audit_log WHERE tenant_id = $1 AND user_id = $2 AND path = $3 AND idempotency_key = $4', [TENANT, 'u-it', ACK_PATH, key]);
    expect(audit.rows).toEqual([{ status: 403, permission: 'platform.alert.manage' }]);
    const kept = await platform.query("SELECT count(*)::int AS n FROM event_ledger WHERE tenant_id = $1 AND type = 'BoxReportRefusalAcknowledged'", [TENANT]);
    expect(kept.rows[0].n).toBe(0);
  }, 120_000);

  it('NEW-4 · OB-90: with the owner\'s 0 / 0 the ops-alert worker raises the bill-number alert the defaults would not', async () => {
    const B = 'A3';
    const Q = 'A3L1-';
    await real.grant('u-box-a3', 'store_computer', undefined, [B]);
    expect((await real.request({ method: 'POST', path: `/v1/stores/${B}/tills/lane-1/receipt-prefix`, userId: OWNER, idempotencyKey: `pfx-${randomUUID()}`, body: { prefix: Q } })).status).toBe(201);
    // The owner names who owns the store computer's bill numbers (himself), and nothing else.
    expect((await real.request({ method: 'PUT', path: '/v1/platform/alert-rules', userId: OWNER, idempotencyKey: `rules-${randomUUID()}`, body: {
      basedOnVersion: 0,
      rules: [{ alertId: 'bill-numbers-a3', component: `box_bill_numbers:${B}`, firesAt: 'degraded', ownerUserId: OWNER, ownerName: 'The owner', ackWithinMinutes: 60, escalatesToUserId: OWNER }],
    } })).status).toBe(200);
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    const travel = (minutes: number): void => { vi.setSystemTime(t0 + minutes * 60_000); };
    // A catch-up whose queue holds 95 bills over 100 numbers (5 voided): believed whole by the default 5 / 5%.
    const send = async (): Promise<void> => {
      const r = await real.request({ method: 'POST', path: '/v1/store-computers/health-reports', userId: 'u-box-a3', idempotencyKey: `rep-${randomUUID()}`, body: {
        observedAt: new Date().toISOString(), disk: { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1000, salesLogCapacityBytes: 1e7, reserveBytes: 1e6 },
        queue: { unsent: 95, deadLettered: 0 }, tills: [], receiptNumbersIssued: [{ prefix: Q, through: 100, soldThrough: 100, unsent: { count: 95, from: 1, to: 100 } }],
      } });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    };
    const passes = async (n = 3): Promise<void> => {
      const target = real.opsAlertWorker!.total() + n;
      for (let i = 0; i < 600 && real.opsAlertWorker!.total() < target; i += 1) await sleep(10);
      expect(real.opsAlertWorker!.total()).toBeGreaterThanOrEqual(target);
    };
    const inbox = async (): Promise<{ alert: { alertId: string; detail: string } }[]> =>
      ((await real.request({ method: 'GET', path: '/v1/platform/alerts/inbox', userId: OWNER })).body as { alerts: { alert: { alertId: string; detail: string } }[] }).alerts
        .filter((a) => a.alert.alertId === 'bill-numbers-a3');
    for (const m of [0, UNRECEIVED_GRACE_MINUTES + 5]) { travel(m); await send(); }
    await passes();
    expect(await inbox()).toEqual([]); // the defaults: the 5 voided numbers are within the claim — nothing to raise
    // The owner tightens the slack to 0 / 0 in store setup: the WORKER (nobody presses anything) now raises the alert.
    for (const k of ['platform.box_claim_slack_numbers', 'platform.box_claim_slack_percent']) {
      expect((await real.request({ method: 'PUT', path: `/v1/platform/setup/${k}`, userId: OWNER, idempotencyKey: `set-${randomUUID()}`, body: { value: 0 } })).status).toBe(200);
    }
    await passes();
    const raised = await inbox();
    expect(raised).toHaveLength(1);
    expect(raised[0]!.alert.detail).toMatch(/bills issued but never received: store A3's computer gave A3L1-000001 to A3L1-000100/);
  }, 180_000);
});
