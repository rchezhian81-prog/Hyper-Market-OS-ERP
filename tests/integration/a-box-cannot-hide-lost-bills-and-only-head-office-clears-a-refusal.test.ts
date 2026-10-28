import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import { startRealCloud, type RealCloud } from '../support/real-store';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { STREAM, streamName } from '../../services/api/src/adapters';
import {
  UNRECEIVED_GRACE_MINUTES, billNumberFindingsFor, sparseSlack, weighSparseClaim, type BoxHealthRecord, type RefusalAcknowledgement,
} from '../../services/platform/src/box-health';
import { ownerApprovedSetting } from '../support/owner-approved-setting';

/**
 * **Verifier r22 D2–D5 · owner decisions OB-88 and OB-89 (13 Oct 2026, in writing) — a faulty or tampered store computer
 * cannot hide bills head office never received, and only the owner or head office clears a suspicious bill count.**
 * Through head office's production routes (the box's health report, the sales intake, the acknowledgement, the observed
 * health read), in memory and on PostgreSQL:
 *
 *   1. D3 · OB-89 (probe zz-v22 A): a box that reports WITHOUT the per-prefix `unsent` list while its whole queue holds 1
 *      item. Before the owner's line (2 hours, from head office's FIRST sight of such reports): nothing named. Past it:
 *      "bills may be waiting on the store computer" (box_queue degraded), and 30 minutes later the 500 bills head office
 *      never received are named [[101, 600]] — saying they may still be on it, do NOT re-enter until a person checked.
 *   2. D4 · OB-89 (probe zz-v22 B): a box that lowers `from` by one on every hourly report (101, 100, 99 … to 600, each a
 *      whole list that fits its queue) no longer restarts the clock: past 2 hours the warning stands, aged from the FIRST
 *      report. An honest box draining its queue (from rising pass by pass) is never warned inside the line.
 *   3. D5 (probes zz-v22 C, D): a SPARSE list — `{count: 2, from: 101, to: 600}`, given up on or still to send — no longer
 *      shields the whole span: after the grace the numbers head office lacks are named (it says it holds 2 of them, which
 *      ones cannot be told). An honest box is never called lost: two old dead letters with everything between them banked,
 *      or a queue with a few voided numbers inside it (within count + max(5, 5%)), names nothing.
 *   3b. OB-90 "C": that slack is the owner's store-setup setting (platform.box_claim_slack_numbers, default 5, 0–100;
 *      platform.box_claim_slack_percent, default 5, 0–50): defaults as built; set to 0 / 0 the same honest-with-voids claim
 *      is named; set back, it sticks (versioned, who changed it) and the claim is believed again; out of range is refused.
 *   4. D2 · OB-88 (probe zz-v22 E): a store manager — of ANOTHER store, or of this very store — is refused by name (403
 *      acknowledgement_needs_all_stores_authority) and the warning stays. The owner's acknowledgement holds while the box
 *      repeats the same count on every pass; acknowledging again is kept as its own record (its own who, why, when); a
 *      DIFFERENT count needs a new acknowledgement, and so does the acknowledged count reported again after it. A lower
 *      refused report never hides a higher earlier one. On PostgreSQL, through the served API, the refusal is on the audit
 *      trail (audit_log, status 403).
 */

const OWNER = 'u-owner';
const S1 = 'S1';
const P = 'S1L1-';
const pad = (n: number): string => String(n).padStart(6, '0');
const AT = new Date(Date.now() - 60_000).toISOString();
const SETTINGS = { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 15 };
const ACK_PATH = '/v1/store-computers/bill-number-refusals/acknowledgements';

interface Finding { kind: string; prefix: string; ranges?: [number, number][]; count?: number; through?: number; since: string; detail: string; words?: { en: string; ta: string } }
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
  expect((await ownerApprovedSetting(h, T, 'locale.time_zone', { value: 'UTC' }, OWNER)).status).toBe(200);
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
const report = async (call: Call, issued: unknown, queue: { unsent: number; deadLettered: number }): Promise<Record<string, unknown>> => {
  const r = await call('POST', '/v1/store-computers/health-reports', 'u-box', {
    observedAt: new Date().toISOString(), disk: { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1000, salesLogCapacityBytes: 1e7, reserveBytes: 1e6 },
    queue, tills: [], receiptNumbersIssued: issued,
  }, S1);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return (r.body as { recorded: Record<string, unknown> }).recorded;
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

/**
 * Head office's clock, held still at each moment the test names (round 4): `Date` is faked and does NOT run on its own, so
 * "head office first saw it at t0" is exactly t0 however busy the machine is — before, the clock ran on between
 * `travel(0)` and the report being received, and under load the two read 20 ms apart. Only `Date` is faked: the server's
 * own timers and the database still run in real time.
 */
function clock(): { travel: (minutes: number) => void; t0: number } {
  const t0 = Date.now();
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: false });
  vi.setSystemTime(t0);
  return { t0, travel: (minutes) => { vi.setSystemTime(t0 + minutes * 60_000); } };
}

// ── 1. D3 · OB-89: a report without the per-prefix list ─────────────────────────────────────────────────────────────
async function aReportWithoutItsListHidesNothingPastTheLine(h: ApiHarness): Promise<void> {
  const { call } = await shop(h);
  await bank(call, 1, 100);
  const { travel, t0 } = clock();
  const OLD = [{ prefix: P, through: 600, soldThrough: 600 }]; // no `unsent`: an older or altered box
  for (const m of [0, 30, 60, 90, 119]) { travel(m); await report(call, OLD, { unsent: 1, deadLettered: 0 }); }
  // Inside the owner's line (2 hours from head office's FIRST sight of such a report): its whole queue still stands in.
  expect(await neverReceived(call)).toEqual([]);
  expect(await findings(call, 'bills_waiting_on_box')).toEqual([]);
  travel(121);
  await report(call, OLD, { unsent: 1, deadLettered: 0 });
  const w = await findings(call, 'bills_waiting_on_box');
  expect(w.map((f) => [f.prefix, f.count, f.ranges])).toEqual([[P, 1, undefined]]);
  expect(w[0]!.since).toBe(new Date(t0).toISOString()); // aged from head office's first sight, never from the latest report
  expect(w[0]!.detail).toMatch(/^bills may be waiting on the store computer for 2 hours: .* it does not say which bills under S1L1- they are .* longer than the 2-hour line/);
  expect(w[0]!.detail).toMatch(/Do NOT re-enter bills from paper until support has checked the store computer/);
  expect((await comp(call, 'box_queue'))?.status).toBe('degraded');
  expect(await neverReceived(call)).toEqual([]); // the grace runs from the line
  travel(120 + UNRECEIVED_GRACE_MINUTES - 1);
  await report(call, OLD, { unsent: 1, deadLettered: 0 });
  expect(await neverReceived(call)).toEqual([]);
  // Seven days of the same, every six hours: the 500 numbers head office never received are named — not hidden for ever.
  for (let hr = 3; hr <= 24 * 7; hr += 6) { travel(hr * 60); await report(call, OLD, { unsent: 1, deadLettered: 0 }); }
  expect(await neverReceived(call)).toEqual([[101, 600]]);
  const named = (await findings(call, 'issued_never_received'))[0]!;
  expect(named.detail).toMatch(/after it stopped taking the store computer's word that it still held them/);
  expect(named.detail).toMatch(/The store computer still says its queue holds 1 item\(s\) to send, as it has since .* but not which bills/);
  expect(named.detail).toMatch(/do NOT re-enter them from paper until a person has checked the store computer's "waiting to send" count/);
  expect(named.detail).not.toMatch(/find the paper bills and enter them/);
  expect((await comp(call, 'box_bill_numbers'))?.status).toBe('degraded');
  // The box says which bills again (none waiting): its word counts again — the run, and its clock, are over.
  await report(call, [{ prefix: P, through: 600, soldThrough: 600, unsent: { count: 0 } }], { unsent: 0, deadLettered: 0 });
  expect(await findings(call, 'bills_waiting_on_box')).toEqual([]);
}

// ── 2. D4 · OB-89: the clock belongs to the numbers, not to the box's `from` ─────────────────────────────────────────
async function loweringFromNeverRestartsTheClock(h: ApiHarness): Promise<void> {
  const { call } = await shop(h);
  await bank(call, 1, 100);
  const { travel, t0 } = clock();
  // Each report a whole, self-consistent list (count = span, queue agrees), its `from` one lower than the last.
  for (let hr = 0; hr <= 3; hr += 1) {
    travel(hr * 60);
    const from = 101 - hr;
    const count = 600 - from + 1;
    await report(call, [{ prefix: P, through: 600, soldThrough: 600, unsent: { count, from, to: 600 } }], { unsent: count, deadLettered: 0 });
    if (hr < 2) expect(await findings(call, 'bills_waiting_on_box')).toEqual([]);
  }
  travel(3 * 60 + 1);
  const w = await findings(call, 'bills_waiting_on_box');
  expect(w.map((f) => [f.prefix, f.ranges])).toEqual([[P, [[98, 600]]]]);
  expect(w[0]!.since).toBe(new Date(t0).toISOString()); // from the FIRST report: lowering `from` restarted nothing
  expect(w[0]!.detail).toMatch(/for 3 hours/);
  // r23 NEW-1: the clock is the numbers' — head office first saw 101–600 waiting in the first report, and they still are.
  expect(w[0]!.detail).toMatch(/head office first saw S1L1-000101 to S1L1-000600 said to be waiting at .*, and they are still said to be waiting/);
  expect((await comp(call, 'box_queue'))?.status).toBe('degraded');
}

async function anHonestDrainIsNeverWarnedInsideTheLine(h: ApiHarness): Promise<void> {
  const { call } = await shop(h);
  await bank(call, 1, 100);
  const { travel } = clock();
  // Reconnected with 500 queued, sending 50 a pass, a pass every 10 minutes: the oldest waiting number rises pass by pass.
  for (let pass = 0; pass < 10; pass += 1) {
    travel(pass * 10);
    const from = 101 + pass * 50;
    if (pass > 0) await bank(call, from - 50, from - 1);
    await report(call, [{ prefix: P, through: 600, soldThrough: 600, unsent: { count: 600 - from + 1, from, to: 600 } }], { unsent: 600 - from + 1, deadLettered: 0 });
  }
  expect(await findings(call, 'bills_waiting_on_box')).toEqual([]);
  expect(await neverReceived(call)).toEqual([]);
}

// ── 3. D5: a sparse list shields only what it can account for ───────────────────────────────────────────────────────
async function aSparseListNoLongerShieldsTheSpan(h: ApiHarness): Promise<void> {
  const { call } = await shop(h);
  await bank(call, 1, 100);
  const { travel } = clock();
  // Probe C: "2 bills given up on, between 101 and 600" — for a week, repeated every 12 hours.
  const DEAD = [{ prefix: P, through: 600, soldThrough: 600, unsent: { count: 0 }, deadLettered: { count: 2, from: 101, to: 600 } }];
  travel(0);
  await report(call, DEAD, { unsent: 0, deadLettered: 2 });
  travel(UNRECEIVED_GRACE_MINUTES - 1);
  expect(await neverReceived(call)).toEqual([]); // the grace, as for any number the box does not vouch for
  for (let hr = 1; hr <= 24 * 7; hr += 12) { travel(hr * 60); await report(call, DEAD, { unsent: 0, deadLettered: 2 }); }
  expect(await neverReceived(call)).toEqual([[101, 600]]);
  const named = (await findings(call, 'issued_never_received'))[0]!;
  expect(named.detail).toMatch(/The store computer says it still holds 2 bill\(s\) somewhere between S1L1-000101 to S1L1-000600 \(to send, or given up on\) — fewer than the 500 head office has not received there, so at least 498 of them are not on it/);
  expect(named.detail).toMatch(/Do NOT re-enter any of them from paper until a person has checked/);
  // The box's own word about its 2 given-up bills is still said: they need a person.
  expect((await findings(call, 'bills_dead_lettered_on_box')).map((f) => [f.ranges, f.count])).toEqual([[[[101, 600]], 2]]);

  // Probe D: "2 still to send, between 101 and 600" — named after the grace too (no longer hidden for the first 2 hours).
  const Q = 'S1L2-';
  expect((await call('POST', `/v1/stores/${S1}/tills/lane-2/receipt-prefix`, OWNER, { prefix: Q })).status).toBe(201);
  const t = 24 * 7 * 60 + 10;
  const UNSENT = [...DEAD, { prefix: Q, through: 500, soldThrough: 500, unsent: { count: 2, from: 1, to: 500 } }];
  for (const m of [0, 10, 20, UNRECEIVED_GRACE_MINUTES + 1]) { travel(t + m); await report(call, UNSENT, { unsent: 2, deadLettered: 2 }); }
  expect((await findings(call, 'issued_never_received')).filter((f) => f.prefix === Q).flatMap((f) => f.ranges ?? [])).toEqual([[1, 500]]);
}

async function anHonestBoxWithGapsIsNeverCalledLost(h: ApiHarness): Promise<void> {
  const { call } = await shop(h);
  await bank(call, 1, 100);
  await bank(call, 102, 599); // everything between the two dead letters arrived
  const { travel } = clock();
  // One old and one new dead letter, far apart — sparse, but every number between them is banked: accounted for.
  const DEAD = [{ prefix: P, through: 600, soldThrough: 600, unsent: { count: 0 }, deadLettered: { count: 2, from: 101, to: 600 } }];
  for (const m of [0, 20, 40, 3 * 60]) { travel(m); await report(call, DEAD, { unsent: 0, deadLettered: 2 }); }
  expect(await neverReceived(call)).toEqual([]);
  expect((await findings(call, 'bills_dead_lettered_on_box')).map((f) => f.count)).toEqual([2]);

  // A catch-up whose queue has 5 voided numbers among 100 (count 95 over a span of 100): within count + max(5, 5%) —
  // believed whole, so nothing is named while it drains, as before.
  const Q = 'S1L2-';
  expect((await call('POST', `/v1/stores/${S1}/tills/lane-2/receipt-prefix`, OWNER, { prefix: Q })).status).toBe(201);
  expect(sparseSlack(95)).toBe(5);
  const VOIDS = [...DEAD, { prefix: Q, through: 100, soldThrough: 100, unsent: { count: 95, from: 1, to: 100 } }];
  for (const m of [200, 220, 240]) { travel(m); await report(call, VOIDS, { unsent: 95, deadLettered: 2 }); }
  expect((await findings(call, 'issued_never_received')).filter((f) => f.prefix === Q)).toEqual([]);
}

// ── 3b. OB-90 "C": the claim slack is the owner's store-setup setting ──────────────────────────────────────────────
async function theClaimSlackIsTheOwnersSetting(h: ApiHarness): Promise<void> {
  const { call } = await shop(h);
  const { travel } = clock();
  const N = 'platform.box_claim_slack_numbers';
  const PCT = 'platform.box_claim_slack_percent';
  const item = async (key: string) => ((await call('GET', '/v1/platform/setup', OWNER)).body as { items: { key: string; value: unknown; changedBy?: string; version: number }[] }).items.find((i) => i.key === key);
  // The defaults reproduce the rule as built: 5 numbers, or 5%.
  expect((await item(N))?.value).toBe(5);
  expect((await item(PCT))?.value).toBe(5);
  // A catch-up whose queue holds 95 bills over 100 numbers (5 voided): believed whole by default — nothing named.
  const VOIDS = [{ prefix: P, through: 100, soldThrough: 100, unsent: { count: 95, from: 1, to: 100 } }];
  for (const m of [0, 20, UNRECEIVED_GRACE_MINUTES + 5]) { travel(m); await report(call, VOIDS, { unsent: 95, deadLettered: 0 }); }
  expect(await neverReceived(call)).toEqual([]);

  // Validated and the owner's alone: a cashier is refused; out of range or not whole is refused in the engine's words.
  expect((await call('PUT', `/v1/platform/setup/${N}`, 'u-cash', { value: 0 })).status).toBe(403);
  for (const [key, value] of [[N, 101], [N, -1], [N, 2.5], [PCT, 51], [PCT, -1]] as const) {
    const bad = await call('PUT', `/v1/platform/setup/${key}`, OWNER, { value });
    expect(bad.status, `${key}=${value}`).toBe(422);
  }
  expect(JSON.stringify((await call('PUT', `/v1/platform/setup/${N}`, OWNER, { value: 101 })).body)).toMatch(/Give a whole number of bill numbers, from 0 to 100/);
  expect(JSON.stringify((await call('PUT', `/v1/platform/setup/${PCT}`, OWNER, { value: 51 })).body)).toMatch(/Give a whole percentage, from 0 to 50/);
  expect((await item(N))?.value).toBe(5); // nothing refused changed it

  // The owner tightens it to 0 and 0: the same claim no longer covers its 5 extra numbers — all 100 are checked and named.
  expect((await call('PUT', `/v1/platform/setup/${N}`, OWNER, { value: 0 })).status).toBe(200);
  expect((await call('PUT', `/v1/platform/setup/${PCT}`, OWNER, { value: 0 })).status).toBe(200);
  expect(await item(N)).toMatchObject({ value: 0, changedBy: OWNER, version: 1 });
  expect(await neverReceived(call)).toEqual([[1, 100]]);
  const named = (await findings(call, 'issued_never_received'))[0]!;
  expect(named.detail).toMatch(/The store computer says it still holds 95 bill\(s\) somewhere between S1L1-000001 to S1L1-000100/);
  expect(named.detail).toMatch(/Do NOT re-enter any of them from paper/);

  // Set back: it sticks (a new version, who and when kept) and the rule follows it again.
  expect((await call('PUT', `/v1/platform/setup/${N}`, OWNER, { value: 5 })).status).toBe(200);
  expect((await call('PUT', `/v1/platform/setup/${PCT}`, OWNER, { value: 5 })).status).toBe(200);
  expect(await item(N)).toMatchObject({ value: 5, changedBy: OWNER, version: 2 });
  expect(await item(PCT)).toMatchObject({ value: 5, changedBy: OWNER, version: 2 });
  travel(UNRECEIVED_GRACE_MINUTES + 40);
  await report(call, VOIDS, { unsent: 95, deadLettered: 0 });
  expect(await neverReceived(call)).toEqual([]);
  expect((await item(N))?.value).toBe(5);
  // The percentage alone counts too: 0 numbers but 6% of 95 (⌈5.7⌉ = 6) still covers the 5 voided numbers.
  expect((await call('PUT', `/v1/platform/setup/${N}`, OWNER, { value: 0 })).status).toBe(200);
  expect((await call('PUT', `/v1/platform/setup/${PCT}`, OWNER, { value: 6 })).status).toBe(200);
  expect(await neverReceived(call)).toEqual([]);
  expect((await call('PUT', `/v1/platform/setup/${PCT}`, OWNER, { value: 4 })).status).toBe(200); // ⌈3.8⌉ = 4 < 5
  expect(await neverReceived(call)).toEqual([[1, 100]]);
}

// ── 4. D2 · OB-88: only the owner or head office acknowledges, and it sticks while the count stays ──────────────────
async function onlyHeadOfficeAcknowledgesAndItSticks(h: ApiHarness): Promise<void> {
  const { T, call } = await shop(h);
  await h.provisionRole(T, 'u-mgr1', 'store_manager', [S1]);
  await h.provisionRole(T, 'u-mgr2', 'store_manager', ['S2']);
  await h.provisionRole(T, 'u-ho', 'owner', 'all'); // head office staff with all-stores authority
  await bank(call, 1, 150);
  const refused = async (): Promise<(number | undefined)[]> => (await findings(call, 'report_refused')).map((f) => f.through);
  const ack = (user: string, through: number, reason: string, branchId?: string) => call('POST', ACK_PATH, user, { storeId: S1, prefix: P, through, reason }, branchId);
  const claim = (through: number) => report(call, [{ prefix: P, through, soldThrough: through }], { unsent: 0, deadLettered: 0 });

  await claim(10_600);
  expect(await refused()).toEqual([10_600]);
  const words = (await findings(call, 'report_refused'))[0]!.detail;
  // OB-435 · OB-439: the finding reaches the Store computers page in both languages — the English word for word, the Tamil in Tamil.
  const twoLanguages = (await findings(call, 'report_refused'))[0]!.words!;
  expect(twoLanguages.en).toBe(words);
  expect(twoLanguages.ta).toMatch(/[\u0B80-\u0BFF]/);
  expect(twoLanguages.ta).toContain(`${P} இன் கீழ் 10600 வரை`);
  expect(twoLanguages.ta).not.toMatch(/reported giving bill numbers/);
  expect(words).toMatch(/This stays until head office has banked that many, or the owner or head office staff \(all-stores authority — a store's own manager cannot, and neither can the IT\/platform administrator\) acknowledge this count with a reason/);
  expect(words).toMatch(/The acknowledgement holds while the store computer keeps reporting this same count; a different count needs a new acknowledgement/);

  // A store manager is refused BY NAME — another store's (probe E), and this store's own. The warning stays.
  for (const [user, branch] of [['u-mgr2', 'S2'], ['u-mgr1', S1]] as const) {
    const no = await ack(user, 10_600, 'manager tries to clear it', branch);
    expect(no.status).toBe(403);
    expect((no.body as { error: { code: string; wasItSaved: string } }).error).toMatchObject({ code: 'acknowledgement_needs_all_stores_authority', wasItSaved: 'not_saved' });
  }
  expect(await refused()).toEqual([10_600]);

  // The owner acknowledges: cleared — and it STAYS cleared while the box repeats the same count on every pass.
  const first = await ack(OWNER, 10_600, 'owner checked the box: a restore rehearsal');
  expect(first.status).toBe(201);
  expect(await refused()).toEqual([]);
  for (let i = 0; i < 3; i += 1) { await new Promise((r) => setTimeout(r, 5)); await claim(10_600); }
  expect(await refused()).toEqual([]);
  // Acknowledging again is kept as its OWN record — its own person, reason and time — never collapsed onto the first.
  await new Promise((r) => setTimeout(r, 5));
  const second = await ack('u-ho', 10_600, 'head office looked again after the repeats');
  expect(second.status).toBe(201);
  const a1 = (first.body as { acknowledged: RefusalAcknowledgement }).acknowledged;
  const a2 = (second.body as { acknowledged: RefusalAcknowledgement }).acknowledged;
  expect(a2).toMatchObject({ by: 'u-ho', reason: 'head office looked again after the repeats', through: 10_600, authority: 'all_stores' });
  expect(a2.at).not.toBe(a1.at);
  const kept = await h.store.readStream(T, streamName(STREAM.org, 'store-computer-refusal-acknowledgements'));
  expect(kept.map((e) => [(e.event.payload as RefusalAcknowledgement).by, (e.event.payload as RefusalAcknowledgement).reason])).toEqual([
    [OWNER, 'owner checked the box: a restore rehearsal'], ['u-ho', 'head office looked again after the repeats'],
  ]);

  // A DIFFERENT count needs a new acknowledgement — and the acknowledged count reported AGAIN after it does too.
  await new Promise((r) => setTimeout(r, 5));
  await claim(10_700);
  expect(await refused()).toEqual([10_700]);
  await new Promise((r) => setTimeout(r, 5));
  await claim(10_600);
  const both = await findings(call, 'report_refused');
  expect(both.map((f) => f.through)).toEqual([10_700]); // the highest open claim is the finding …
  expect(both[0]!.detail).toMatch(/It also reported another count head office refused under S1L1-, still to be looked at: 10600/); // … naming the other
  await new Promise((r) => setTimeout(r, 5));
  expect((await ack(OWNER, 10_700, 'owner checked: a second rehearsal')).status).toBe(201);
  expect(await refused()).toEqual([10_600]); // the old acknowledgement of 10,600 ended when 10,700 was reported
  await new Promise((r) => setTimeout(r, 5));
  expect((await ack(OWNER, 10_600, 'owner checked again: same rehearsal')).status).toBe(201);
  expect(await refused()).toEqual([]);

  // r22 D2 (c): a LOWER refused report never hides a higher earlier one.
  await new Promise((r) => setTimeout(r, 5));
  await claim(999_998);
  await new Promise((r) => setTimeout(r, 5));
  await claim(20_000);
  const high = await findings(call, 'report_refused');
  expect(high.map((f) => f.through)).toEqual([999_998]);
  expect(high[0]!.detail).toMatch(/still to be looked at: 20000/);
}

describe('verifier r22 D2–D5 · OB-88 / OB-89 (memory)', () => {
  it('D3: a report without its per-prefix list hides nothing past the owner\'s line', async () => { await aReportWithoutItsListHidesNothingPastTheLine(apiHarness()); }, 120_000);
  it('D4: lowering `from` on every report never restarts the waiting clock', async () => { await loweringFromNeverRestartsTheClock(apiHarness()); }, 60_000);
  it('D4: an honest box draining its queue is never warned inside the line', async () => { await anHonestDrainIsNeverWarnedInsideTheLine(apiHarness()); }, 60_000);
  it('D5: a sparse list no longer shields the whole span', async () => { await aSparseListNoLongerShieldsTheSpan(apiHarness()); }, 120_000);
  it('D5: an honest box with gaps (old dead letters, voided numbers) is never called lost', async () => { await anHonestBoxWithGapsIsNeverCalledLost(apiHarness()); }, 120_000);
  it('D2: only the owner or head office acknowledges, and it holds until the count changes', async () => { await onlyHeadOfficeAcknowledgesAndItSticks(apiHarness()); }, 120_000);
  it('OB-90: the claim slack is the owner\'s store-setup setting (default 5 / 5%)', async () => { await theClaimSlackIsTheOwnersSetting(apiHarness()); }, 120_000);
});

describe('verifier r22 D2/D5: the rules themselves', () => {
  const rec = (at: string, refused?: number, accepted?: number): BoxHealthRecord => ({
    storeId: S1, observedAt: at, receivedAt: at, reportedBy: 'u-box', clockAheadCorrected: false, tills: [],
    disk: { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1, salesLogCapacityBytes: 1e7, reserveBytes: 1 }, queue: { unsent: 0, deadLettered: 0 },
    ...(accepted === undefined ? {} : { receiptNumbersIssued: [{ prefix: P, through: accepted }] }),
    ...(refused === undefined ? {} : { receiptNumbersRefused: [{ prefix: P, through: refused, because: 'beyond_plausible_advance' as const, bankedThrough: 0, plausibleThrough: 10_000 }] }),
  });
  const ackOf = (at: string, through: number, authority?: 'all_stores'): RefusalAcknowledgement => ({ storeId: S1, prefix: P, through, reason: 'checked', by: 'u-owner', at, ...(authority === undefined ? {} : { authority }) });
  const open = (records: BoxHealthRecord[], acknowledged: RefusalAcknowledgement[]): (number | undefined)[] =>
    billNumberFindingsFor({ storeId: S1, records, at: '2026-10-13T12:00:00.000Z', unreceived: [], banked: new Map(), acknowledged })
      .filter((f) => f.kind === 'report_refused').map((f) => f.through);

  it('an acknowledgement kept without all-stores authority (before OB-88) is not honoured', () => {
    const records = [rec('2026-10-13T10:00:00.000Z', 20_000)];
    expect(open(records, [ackOf('2026-10-13T10:05:00.000Z', 20_000)])).toEqual([20_000]);
    expect(open(records, [ackOf('2026-10-13T10:05:00.000Z', 20_000, 'all_stores')])).toEqual([]);
  });
  it('an acknowledgement covers repeats of its count, ends at a different count (accepted or refused), and covers everything before it', () => {
    const r = [rec('2026-10-13T10:00:00.000Z', 20_000), rec('2026-10-13T10:10:00.000Z', 20_000), rec('2026-10-13T10:20:00.000Z', 20_000)];
    const a = [ackOf('2026-10-13T10:05:00.000Z', 20_000, 'all_stores')];
    expect(open(r, a)).toEqual([]); // repeats after it: still covered
    expect(open([...r, rec('2026-10-13T10:30:00.000Z', undefined, 50), rec('2026-10-13T10:40:00.000Z', 20_000)], a)).toEqual([20_000]); // after a different count: needs a new one
    expect(open([rec('2026-10-13T10:00:00.000Z', 20_000), rec('2026-10-13T10:02:00.000Z', undefined, 50)], a)).toEqual([]); // the one before it stays acknowledged
    // An acknowledgement given while the box was reporting ANOTHER count covers only what came before it.
    expect(open([rec('2026-10-13T10:00:00.000Z', 20_000), rec('2026-10-13T10:01:00.000Z', 30_000), rec('2026-10-13T10:20:00.000Z', 20_000)],
      [ackOf('2026-10-13T10:05:00.000Z', 20_000, 'all_stores'), ackOf('2026-10-13T10:06:00.000Z', 30_000, 'all_stores')])).toEqual([20_000]);
  });
  it('a sparse claim accounts for at most count + max(5, 5%) missing numbers in its span (the default), or the owner\'s slack', () => {
    expect(sparseSlack(2)).toBe(5);
    expect(sparseSlack(1_000)).toBe(50);
    expect(sparseSlack(140)).toBe(7); // whole-number arithmetic: 5% of 140 is exactly 7
    expect(sparseSlack(141)).toBe(8);
    expect(sparseSlack(95, { numbers: 0, percent: 0 })).toBe(0);
    expect(sparseSlack(95, { numbers: 2, percent: 10 })).toBe(10);
    expect(weighSparseClaim([101, 600, 700], { count: 2, spans: [[101, 700]] }, { numbers: 0, percent: 0 })).toEqual({ numbers: [101, 600, 700], outnumbered: true });
    const sparse = { count: 2, spans: [[101, 600]] as [number, number][] };
    expect(weighSparseClaim([101, 600], sparse)).toEqual({ numbers: [], outnumbered: false });
    expect(weighSparseClaim([101, 300, 301, 302, 303, 304, 600], sparse)).toEqual({ numbers: [], outnumbered: false }); // 7 = 2 + 5
    expect(weighSparseClaim([101, 300, 301, 302, 303, 304, 305, 600], sparse)).toEqual({ numbers: [101, 300, 301, 302, 303, 304, 305, 600], outnumbered: true });
    expect(weighSparseClaim([5, 101], sparse)).toEqual({ numbers: [5], outnumbered: false }); // outside its span: untouched
  });
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(DATABASE_URL === undefined)('verifier r22 D2–D5 · OB-88 / OB-89 (PostgreSQL)', () => {
  const onPg = async (run: (h: ApiHarness) => Promise<void>): Promise<void> => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 16, options: '-c app.tenant_id=*' });
    const sql = pgPoolClient(pool);
    try { await run(apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) })); } finally { await pool.end(); }
  };
  it('D3: a report without its per-prefix list hides nothing past the owner\'s line', async () => { await onPg(aReportWithoutItsListHidesNothingPastTheLine); }, 300_000);
  it('D4: lowering `from` on every report never restarts the waiting clock', async () => { await onPg(loweringFromNeverRestartsTheClock); }, 180_000);
  it('D4: an honest box draining its queue is never warned inside the line', async () => { await onPg(anHonestDrainIsNeverWarnedInsideTheLine); }, 180_000);
  it('D5: a sparse list no longer shields the whole span', async () => { await onPg(aSparseListNoLongerShieldsTheSpan); }, 300_000);
  it('D5: an honest box with gaps (old dead letters, voided numbers) is never called lost', async () => { await onPg(anHonestBoxWithGapsIsNeverCalledLost); }, 300_000);
  it('D2: only the owner or head office acknowledges, and it holds until the count changes', async () => { await onPg(onlyHeadOfficeAcknowledgesAndItSticks); }, 300_000);
  it('OB-90: the claim slack is the owner\'s store-setup setting (default 5 / 5%)', async () => { await onPg(theClaimSlackIsTheOwnersSetting); }, 300_000);
});

describe.skipIf(DATABASE_URL === undefined)('verifier r22 D2 · OB-88: a store manager\'s refused acknowledgement is on the audit trail (served API, PostgreSQL)', () => {
  let real: RealCloud;
  let platform: Pool;
  const TENANT = randomUUID();
  beforeAll(async () => {
    platform = new Pool({ connectionString: DATABASE_URL, max: 2 });
    real = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId: TENANT, owner: OWNER, packSigningKey: TEST_PACK_KEY });
  }, 180_000);
  afterAll(async () => { await real?.stop(); await platform?.end(); });

  it('403 by name, nothing kept, and the refusal is in audit_log', async () => {
    await real.grant('u-mgr-a1', 'store_manager', undefined, ['A1']);
    const key = `ack-${randomUUID()}`;
    const no = await real.request({ method: 'POST', path: ACK_PATH, userId: 'u-mgr-a1', branchId: 'A1', idempotencyKey: key, body: { storeId: 'A1', prefix: 'A1L1-', through: 20_000, reason: 'store manager tries to clear it' } });
    expect(no.status).toBe(403);
    expect((no.body as { error: { code: string } }).error.code).toBe('acknowledgement_needs_all_stores_authority');
    const audit = await platform.query('SELECT status, permission FROM audit_log WHERE tenant_id = $1 AND user_id = $2 AND path = $3 AND idempotency_key = $4', [TENANT, 'u-mgr-a1', ACK_PATH, key]);
    expect(audit.rows).toEqual([{ status: 403, permission: 'platform.alert.manage' }]);
    const kept = await platform.query("SELECT count(*)::int AS n FROM event_ledger WHERE tenant_id = $1 AND type = 'BoxReportRefusalAcknowledged'", [TENANT]);
    expect(kept.rows[0].n).toBe(0);
  }, 120_000);

  it('OB-90 on the served API: the claim slack is read from the owner\'s durable store setup', async () => {
    const B = 'A2';
    const Q = 'A2L1-';
    await real.grant('u-box-a2', 'store_computer', undefined, [B]);
    expect((await real.request({ method: 'POST', path: `/v1/stores/${B}/tills/lane-1/receipt-prefix`, userId: OWNER, idempotencyKey: `pfx-${randomUUID()}`, body: { prefix: Q } })).status).toBe(201);
    const { travel } = clock();
    const VOIDS = [{ prefix: Q, through: 100, soldThrough: 100, unsent: { count: 95, from: 1, to: 100 } }];
    const send = async (): Promise<void> => {
      const r = await real.request({ method: 'POST', path: '/v1/store-computers/health-reports', userId: 'u-box-a2', idempotencyKey: `rep-${randomUUID()}`, body: {
        observedAt: new Date().toISOString(), disk: { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1000, salesLogCapacityBytes: 1e7, reserveBytes: 1e6 },
        queue: { unsent: 95, deadLettered: 0 }, tills: [], receiptNumbersIssued: VOIDS,
      } });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    };
    const named = async (): Promise<[number, number][]> => {
      const r = await real.request({ method: 'GET', path: '/v1/platform/operational-health/observed', userId: OWNER });
      expect(r.status).toBe(200);
      return ((r.body as Observed).observed.boxes.find((b) => b.storeId === B)?.billNumberFindings ?? [])
        .filter((f) => f.kind === 'issued_never_received').flatMap((f) => f.ranges ?? []);
    };
    const set = async (key: string, value: number): Promise<void> => {
      expect((await real.request({ method: 'PUT', path: `/v1/platform/setup/${key}`, userId: OWNER, idempotencyKey: `set-${randomUUID()}`, body: { value } })).status).toBe(200);
    };
    for (const m of [0, UNRECEIVED_GRACE_MINUTES + 5]) { travel(m); await send(); }
    expect(await named()).toEqual([]); // default 5 / 5%: the 5 voided numbers are within the claim
    await set('platform.box_claim_slack_numbers', 0);
    await set('platform.box_claim_slack_percent', 0);
    expect(await named()).toEqual([[1, 100]]); // the owner's 0 / 0, read from the durable settings
    await set('platform.box_claim_slack_numbers', 5);
    expect(await named()).toEqual([]);
  }, 120_000);
});
