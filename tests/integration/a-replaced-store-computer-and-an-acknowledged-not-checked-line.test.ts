import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { startRealCloud, type RealCloud } from '../support/real-store';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM, streamName } from '../../services/api/src/adapters';
import { UNRECEIVED_GRACE_MINUTES } from '../../services/platform/src/box-health';

/**
 * **Round 26 · owner decisions OB-97 "B" and OB-98 "B" (13 Oct 2026, in writing) — through head office's production routes
 * (the store computer's health report, the maker-checker engine, the "store computer replaced" act, the bindings read, the
 * not-checked acknowledgement, the observed health read), in memory and on PostgreSQL; refusals read back from audit_log on
 * the served API.**
 *
 *   OB-97: a store computer died; its replacement has its OWN sign-in. Head office business staff (all stores, never IT) ask
 *   the owner's approval on the maker-checker engine, the owner approves in his own session, and the act moves the till's
 *   prefix to the new computer: its reports are used, the old one's are refused by name, and lost-bill checks resume on the
 *   new one. Refused by name: a sign-in that is not a store computer of that store; a prefix not issued to that store;
 *   self-approval; one store's manager; the IT administrator; no approval, or an approval for something else.
 *   OB-98: the owner or head office business staff acknowledge the "at-risk numbers not checked" line with a reason (kept,
 *   each one); it holds while the same set is reported; a different set needs a new acknowledgement.
 */

const OWNER = 'u-owner';
const S1 = 'S1';
const S2 = 'S2';
const P = 'S1L1-';
const P2 = 'S2L1-';
const pad = (n: number): string => String(n).padStart(6, '0');
const AT = new Date(Date.now() - 60_000).toISOString();
const SETTINGS = { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 30 };
const REPLACE = '/v1/store-computers/replacements';
const BINDINGS = '/v1/store-computers/prefix-bindings';
const NOT_CHECKED_ACK = '/v1/store-computers/at-risk-not-checked/acknowledgements';
const REFUSAL_ACK = '/v1/store-computers/bill-number-refusals/acknowledgements';

interface Finding { kind: string; prefix: string; ranges?: [number, number][]; count?: number; through?: number; since: string; detail: string }
interface Observed { observed: { boxes: { storeId: string; billNumberFindings?: Finding[] }[] } }
type Reply = { status: number; body: unknown };
type Call = (method: 'GET' | 'POST' | 'PUT', path: string, user: string, body?: unknown, branchId?: string, key?: string) => Promise<Reply>;
const codeOf = (r: Reply): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

afterEach(() => { vi.useRealTimers(); });

async function shop(h: ApiHarness): Promise<{ T: string; call: Call }> {
  const T = randomUUID();
  await h.seedOwner(T, OWNER);
  const call: Call = (method, path, user, body, branchId, key) => h.request({
    method, path, userId: user, tenantId: T, ...(branchId === undefined ? {} : { branchId }),
    ...(method === 'GET' ? {} : { idempotencyKey: key ?? `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }),
  });
  // Records here are dated by the UTC clock: the shop's own time zone is set to UTC so a trading day never shifts under them.
  expect((await call('PUT', '/v1/platform/setup/locale.time_zone', OWNER, { value: 'UTC' })).status).toBe(200);
  for (const [id, body] of [
    ['C1', { kind: 'company', name: 'SRE Retail' }],
    [S1, { kind: 'branch', name: 'Store One', parentId: 'C1', companyId: 'C1' }],
    [S2, { kind: 'branch', name: 'Store Two', parentId: 'C1', companyId: 'C1' }],
  ] as const) expect((await call('POST', `/v1/org/nodes/${id}`, OWNER, body)).status).toBeLessThan(300);
  expect((await call('POST', `/v1/stores/${S1}/settings`, OWNER, SETTINGS)).status).toBeLessThan(300);
  await h.provisionRole(T, 'u-box', 'store_computer', [S1]); // the old store computer (it died)
  await h.provisionRole(T, 'u-box-new', 'store_computer', [S1]); // its replacement, with its OWN sign-in
  await h.provisionRole(T, 'u-box-s2', 'store_computer', [S2]); // another store's computer
  await h.provisionRole(T, 'u-cash', 'cashier', [S1]);
  await h.provisionRole(T, 'u-ho', 'store_manager', 'all'); // head office business staff, all stores
  await h.provisionRole(T, 'u-mgr1', 'store_manager', [S1]); // one store's manager
  await h.provisionRole(T, 'u-it', 'platform_admin', 'all'); // the IT / platform administrator
  expect((await call('POST', `/v1/stores/${S1}/tills/lane-1/receipt-prefix`, OWNER, { prefix: P })).status).toBe(201);
  expect((await call('POST', `/v1/stores/${S2}/tills/lane-1/receipt-prefix`, OWNER, { prefix: P2 })).status).toBe(201);
  return { T, call };
}
const bank = async (call: Call, numbers: readonly number[]): Promise<void> => {
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
const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const report = async (call: Call, box: string, issued: unknown, queue = { unsent: 0, deadLettered: 0 }): Promise<void> => {
  const r = await call('POST', '/v1/store-computers/health-reports', box, {
    observedAt: new Date().toISOString(), disk: { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1000, salesLogCapacityBytes: 1e7, reserveBytes: 1e6 },
    queue, tills: [], receiptNumbersIssued: issued,
  }, S1);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
const findings = async (call: Call, kind?: string): Promise<Finding[]> => {
  const r = await call('GET', '/v1/platform/operational-health/observed', OWNER);
  expect(r.status).toBe(200);
  return ((r.body as Observed).observed.boxes.find((b) => b.storeId === S1)?.billNumberFindings ?? []).filter((f) => kind === undefined || f.kind === kind);
};
function clock(): { travel: (minutes: number) => void } {
  const t0 = Date.now();
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  return { travel: (minutes) => { vi.setSystemTime(t0 + minutes * 60_000); } };
}
const sold = (through: number, unsent: { count: number; from?: number; to?: number } = { count: 0 }) => [{ prefix: P, through, soldThrough: through, unsent }];

const ACT = { storeId: S1, prefix: P, fromComputer: 'u-box', toComputer: 'u-box-new', reason: 'old store computer disk failed; replaced' };
/** The maker asks the owner's approval for exactly `details`; resolves the request id. */
const ask = async (call: Call, maker: string, details: Record<string, unknown> = ACT): Promise<string> => {
  const r = await call('POST', '/v1/approvals/requests', maker, {
    kind: 'store_computer_replaced', subjectRef: `${String(details['storeId'])}/${String(details['prefix'])}`, details,
    summary: `Move ${String(details['prefix'])} to ${String(details['toComputer'])}`, reason: String(details['reason']),
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return (r.body as { requestId: string }).requestId;
};
const decide = (call: Call, checker: string, requestId: string, branchId?: string) =>
  call('POST', `/v1/approvals/requests/${requestId}/decide`, checker, { decision: 'approved', reason: 'I checked the new machine at the store' }, branchId);

// ── OB-97: the replaced act, end to end ──────────────────────────────────────────────────────────────────────────────
async function theReplacedActMovesThePrefix(h: ApiHarness): Promise<void> {
  const { T, call } = await shop(h);
  await bank(call, range(1, 100));
  const { travel } = clock();
  travel(0); await report(call, 'u-box', sold(100));
  // The new box is switched on with the till's prefix before head office knows: refused by name (round 25).
  travel(1); await report(call, 'u-box-new', sold(100));
  expect((await findings(call, 'report_refused')).map((f) => f.detail.match(/^refused — a second store computer: (\S+)/)?.[1])).toEqual(['u-box-new']);

  // ── Refused by name: who may do it ──
  const no = async (user: string, body: unknown, status: number, code: string, branchId?: string): Promise<void> => {
    const r = await call('POST', REPLACE, user, body, branchId);
    expect(r.status, `${user} ${JSON.stringify(r.body)}`).toBe(status);
    expect(codeOf(r)).toBe(code);
  };
  await no('u-it', { ...ACT, approvalId: 'x' }, 403, 'forbidden'); // the IT role does not hold the act (OB-91 / OB-95)
  await no('u-mgr1', { ...ACT, approvalId: 'x' }, 403, 'replacement_needs_all_stores_authority', S1);
  await no('u-cash', { ...ACT, approvalId: 'x' }, 403, 'forbidden', S1);
  // ── Refused by name: what may be moved, and where ──
  await no('u-ho', { ...ACT, prefix: P2 }, 422, 'prefix_not_issued_to_this_store');
  await no('u-ho', { ...ACT, prefix: 'ZZ9-' }, 422, 'prefix_not_issued_to_this_store');
  await no('u-ho', { ...ACT, toComputer: 'u-box-s2' }, 422, 'not_a_store_computer_of_this_store'); // another store's computer
  await no('u-ho', { ...ACT, toComputer: 'u-cash' }, 422, 'not_a_store_computer_of_this_store'); // a person, not a store computer
  await no('u-ho', { ...ACT, toComputer: 'u-box' }, 409, 'already_bound_to_that_computer');
  await no('u-ho', { ...ACT, fromComputer: 'u-box-s2' }, 409, 'prefix_bound_to_another_computer');
  await no('u-ho', { ...ACT, reason: 'x' }, 400, 'not_readable_as_store_computer_replacement');
  // ── Refused by name: the owner's approval ──
  await no('u-ho', ACT, 422, 'owner_approval_needed');
  await no('u-ho', { ...ACT, approvedBy: OWNER }, 422, 'approver_named_without_approval'); // a typed name is not an approval
  // The IT administrator cannot even ask; one store's manager may ask, but the act still refuses them (above).
  expect(codeOf(await call('POST', '/v1/approvals/requests', 'u-it', { kind: 'store_computer_replaced', subjectRef: `${S1}/${P}`, details: ACT, summary: 's', reason: 'r' }))).toBe('not_permitted_for_this_approval');
  // Self-approval: the owner asks and decides himself — refused by name (§28); a manager cannot approve at all.
  const own = await ask(call, OWNER);
  const self = await decide(call, OWNER, own);
  expect(self.status).toBe(422);
  expect(codeOf(self)).toBe('self_approval');
  const req = await ask(call, 'u-ho');
  expect(codeOf(await decide(call, 'u-mgr1', req, S1))).toBe('not_permitted_for_this_approval');
  await no('u-ho', { ...ACT, approvalId: req }, 422, 'approval_still_waiting');
  expect((await decide(call, OWNER, req)).status).toBe(201);
  // The approval is for exactly this act, by this maker: a different reason, or another maker, is refused.
  await no('u-ho', { ...ACT, reason: 'something else entirely', approvalId: req }, 422, 'approval_does_not_match');
  await no(OWNER, { ...ACT, approvalId: req }, 422, 'approval_does_not_match');
  // The owner's approval of his OWN request was refused, so it cannot be used by anybody.
  await no(OWNER, { ...ACT, approvalId: own }, 422, 'approval_still_waiting');
  // Nothing moved by any refusal.
  const still = await call('GET', BINDINGS, OWNER);
  expect((still.body as { bindings: { computer: string; via: string }[] }).bindings.map((b) => [b.computer, b.via])).toEqual([['u-box', 'first_report']]);
  // OB-99: the Store computers page offers only what head office would accept — its own answer, by the acts' own rule.
  for (const [who, branch, mayReplace, mayAcknowledge] of [[OWNER, undefined, true, true], ['u-ho', undefined, true, true], ['u-mgr1', S1, false, false], ['u-it', undefined, false, false]] as const) {
    const r = await call('GET', BINDINGS, who, undefined, branch);
    expect(r.status, who).toBe(200);
    expect((r.body as { you: unknown }).you, who).toEqual({ mayReplace, mayAcknowledge });
  }

  // ── The act ──
  travel(2);
  const key = `act-${randomUUID()}`;
  const done = await call('POST', REPLACE, 'u-ho', { ...ACT, approvalId: req }, undefined, key);
  expect(done.status, JSON.stringify(done.body)).toBe(201);
  expect((done.body as { replacement: Record<string, unknown> }).replacement).toMatchObject({
    storeId: S1, prefix: P, from: 'u-box', to: 'u-box-new', requestedBy: 'u-ho', approvedBy: OWNER, approvalId: req, reason: ACT.reason,
  });
  // Idempotent: the same request re-sent answers the same act; the same approval cannot be used twice.
  const again = await call('POST', REPLACE, 'u-ho', { ...ACT, approvalId: req }, undefined, key);
  expect(again.status).toBe(201);
  expect(again.body).toEqual(done.body);
  const twice = await call('POST', REPLACE, 'u-ho', { ...ACT, approvalId: req });
  expect(twice.status).toBe(409); // already bound to the new computer (and the approval is spent)
  const kept = await h.store.readStream(T, streamName(STREAM.org, 'store-computer-replacements'));
  expect(kept.map((e) => e.event.type)).toEqual(['StoreComputerReplaced']);
  const bound = (await call('GET', BINDINGS, 'u-ho')).body as { bindings: { storeId: string; prefix: string; computer: string; via: string }[]; replacements: { approvedBy: string }[] };
  expect(bound.bindings.filter((b) => b.storeId === S1).map((b) => [b.prefix, b.computer, b.via])).toEqual([[P, 'u-box-new', 'replacement']]);
  expect(bound.replacements.map((m) => m.approvedBy)).toEqual([OWNER]);
  // The new box's refusal from before the act is answered by it.
  expect(await findings(call, 'report_refused')).toEqual([]);

  // ── After the act: the new computer's reports are used; the old one's are refused by name ──
  // The new box sold 101–110; head office has not received them; it says it holds nothing to send.
  travel(3); await report(call, 'u-box-new', sold(110));
  travel(4); await report(call, 'u-box', sold(100)); // the old box comes back on (someone switched it on)
  const refusedNow = await findings(call, 'report_refused');
  expect(refusedNow).toHaveLength(1);
  expect(refusedNow[0]!.detail).toMatch(/^refused — a second store computer: u-box reported bill numbers under S1L1- \(through 100\) for store S1, but S1L1- belongs to the store computer u-box-new/);
  // Lost-bill checks resume on the new computer: past the grace, 101–110 are named never received.
  travel(4 + UNRECEIVED_GRACE_MINUTES + 1);
  expect((await findings(call, 'issued_never_received')).map((f) => f.ranges)).toEqual([[[101, 110]]]);
  // Banked, they are no longer named.
  await bank(call, range(101, 110));
  expect(await findings(call, 'issued_never_received')).toEqual([]);
  // The old computer's refusal is cleared only by a person (all stores, never IT) — as in round 25.
  expect((await call('POST', REFUSAL_ACK, 'u-it', { storeId: S1, prefix: P, through: 100, reason: 'old box unplugged' })).status).toBe(403);
  expect((await call('POST', REFUSAL_ACK, 'u-ho', { storeId: S1, prefix: P, through: 100, reason: 'old box unplugged' })).status).toBe(201);
  expect(await findings(call, 'report_refused')).toEqual([]);
}

// ── OB-98: the not-checked line, acknowledged ───────────────────────────────────────────────────────────────────────
async function theNotCheckedLineIsAcknowledged(h: ApiHarness): Promise<void> {
  const { T, call } = await shop(h);
  await bank(call, range(1, 100));
  const { travel } = clock();
  const SET_A = [{ prefix: P, through: 1_300, soldThrough: 1_300, atRisk: [[101, 700], [1_001, 1_300]], unsent: { count: 0 } }];
  const SET_B = [{ prefix: P, through: 1_300, soldThrough: 1_300, atRisk: [[51, 700], [1_001, 1_300]], unsent: { count: 0 } }];
  travel(0); await report(call, 'u-box', SET_A);
  const line = async (): Promise<[number | undefined, [number, number][] | undefined][]> => (await findings(call, 'at_risk_not_checked')).map((f) => [f.count, f.ranges]);
  expect(await line()).toEqual([[400, [[101, 500]]]]);
  const ackBody = { storeId: S1, prefix: P, count: 400, reason: 'support compared the restore record with head office' };
  // Refused by name: one store's manager, the IT administrator, a cashier; a stale count; nothing to acknowledge; no reason.
  const no = async (user: string, body: unknown, status: number, code: string, branchId?: string): Promise<void> => {
    const r = await call('POST', NOT_CHECKED_ACK, user, body, branchId);
    expect(r.status, `${user} ${JSON.stringify(r.body)}`).toBe(status);
    expect(codeOf(r)).toBe(code);
  };
  await no('u-mgr1', ackBody, 403, 'acknowledgement_needs_all_stores_authority', S1);
  await no('u-it', ackBody, 403, 'acknowledgement_refused_to_platform_administrator');
  await no('u-cash', ackBody, 403, 'forbidden', S1);
  await no('u-ho', { ...ackBody, count: 450 }, 409, 'not_checked_set_changed');
  await no('u-ho', { ...ackBody, prefix: P2 }, 404, 'no_such_not_checked_finding');
  await no('u-ho', { ...ackBody, reason: 'ok' }, 400, 'not_readable_as_acknowledgement');
  expect(await line()).toEqual([[400, [[101, 500]]]]);
  // Head office staff acknowledge it, and so does the owner — each kept with who, why and when.
  travel(1);
  const a = await call('POST', NOT_CHECKED_ACK, 'u-ho', ackBody);
  expect(a.status, JSON.stringify(a.body)).toBe(201);
  expect((a.body as { acknowledged: Record<string, unknown> }).acknowledged).toMatchObject({ storeId: S1, prefix: P, notChecked: [[101, 500]], count: 400, by: 'u-ho', reason: ackBody.reason, authority: 'all_stores' });
  travel(1.5);
  expect((await call('POST', NOT_CHECKED_ACK, OWNER, { ...ackBody, reason: 'owner saw it too' })).status).toBe(201);
  const kept = await h.store.readStream(T, streamName(STREAM.org, 'store-computer-not-checked-acknowledgements'));
  expect(kept.map((e) => (e.event.payload as { by: string }).by)).toEqual(['u-ho', OWNER]);
  expect(await line()).toEqual([]);
  // The store computer repeats itself: still acknowledged.
  travel(2); await report(call, 'u-box', SET_A);
  expect(await line()).toEqual([]);
  // A different set: the line is back — and the old set coming back needs a NEW acknowledgement.
  travel(3); await report(call, 'u-box', SET_B);
  expect(await line()).toEqual([[450, [[51, 500]]]]);
  travel(4); await report(call, 'u-box', SET_A);
  expect(await line()).toEqual([[400, [[101, 500]]]]);
  travel(5);
  expect((await call('POST', NOT_CHECKED_ACK, 'u-ho', ackBody)).status).toBe(201);
  expect(await line()).toEqual([]);
}

describe('round 26 · OB-97 / OB-98 (memory)', () => {
  it('OB-97: the owner-approved "store computer replaced" act moves the prefix; every refusal by name', async () => { await theReplacedActMovesThePrefix(apiHarness()); }, 180_000);
  it('OB-98: the not-checked line is acknowledged by head office or the owner, and holds until the set changes', async () => { await theNotCheckedLineIsAcknowledged(apiHarness()); }, 180_000);
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(DATABASE_URL === undefined)('round 26 · OB-97 / OB-98 (PostgreSQL)', () => {
  const onPg = async (run: (h: ApiHarness) => Promise<void>): Promise<void> => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 16, options: '-c app.tenant_id=*' });
    const sql = pgPoolClient(pool);
    try { await run(apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) })); } finally { await pool.end(); }
  };
  it('OB-97: the owner-approved "store computer replaced" act moves the prefix; every refusal by name', async () => { await onPg(theReplacedActMovesThePrefix); }, 300_000);
  it('OB-98: the not-checked line is acknowledged by head office or the owner, and holds until the set changes', async () => { await onPg(theNotCheckedLineIsAcknowledged); }, 300_000);
});

describe.skipIf(DATABASE_URL === undefined)('round 26 · OB-97 / OB-98: refusals on the audit trail (served API, PostgreSQL)', () => {
  let cloud: RealCloud;
  let platform: Pool;
  const TENANT = randomUUID();
  const B = 'B1';
  const Q = 'B1L1-';
  beforeAll(async () => {
    platform = new Pool({ connectionString: DATABASE_URL, max: 2 });
    cloud = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId: TENANT, owner: OWNER, packSigningKey: ['r26', 'replaced', 'key'].join('-').padEnd(48, '0') });
    await cloud.grant('u-ho', 'store_manager', undefined, 'all');
    await cloud.grant('u-mgr-b1', 'store_manager', undefined, [B]);
    await cloud.grant('u-box-b1', 'store_computer', undefined, [B]);
    await cloud.grant('u-box-b1n', 'store_computer', undefined, [B]);
    await cloud.grant('u-box-b2', 'store_computer', undefined, ['B2']);
    // The IT role, laid on the ledger by the operator (the owner may not hand out platform_admin's own permissions).
    const at = new Date().toISOString();
    await new SqlEventStore(pgPoolClient(platform)).append(TENANT, STREAM.identity, makeEvent({
      id: `grant-it-${TENANT}`, type: 'RoleGranted', occurredAt: at, idempotencyKey: `grant-${TENANT}-platform_admin-u-it`, source: 'test/r26',
      payload: { userId: 'u-it', roleId: 'platform_admin', branchScope: 'all', request: { grantId: 'platform_admin-u-it', userId: 'u-it', roleId: 'platform_admin', branchScope: 'all', requestedBy: 'operator', approvedBy: 'operator', requestedAt: at } },
    }));
    for (const [store, prefix] of [[B, Q], ['B2', 'B2L1-']] as const) {
      expect((await cloud.request({ method: 'POST', path: `/v1/stores/${store}/tills/lane-1/receipt-prefix`, userId: OWNER, idempotencyKey: `pfx-${randomUUID()}`, body: { prefix } })).status).toBe(201);
    }
    const r = await cloud.request({ method: 'POST', path: '/v1/store-computers/health-reports', userId: 'u-box-b1', idempotencyKey: `rep-${randomUUID()}`, body: {
      observedAt: new Date().toISOString(), disk: { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1000, salesLogCapacityBytes: 1e7, reserveBytes: 1e6 },
      queue: { unsent: 0, deadLettered: 0 }, tills: [], receiptNumbersIssued: [{ prefix: Q, through: 1_300, soldThrough: 1_300, atRisk: [[101, 700], [1_001, 1_300]], unsent: { count: 0 } }],
    } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }, 180_000);
  afterAll(async () => { await cloud?.stop(); await platform?.end(); });

  const BODY = { storeId: B, prefix: Q, fromComputer: 'u-box-b1', toComputer: 'u-box-b1n', reason: 'store computer replaced after a disk failure' };
  const refusedOnTheTrail = async (user: string, path: string, body: unknown, status: number, code: string, permission: string, branchId?: string): Promise<void> => {
    const key = `r26-${randomUUID()}`;
    const r = await cloud.request({ method: 'POST', path, userId: user, idempotencyKey: key, body, ...(branchId === undefined ? {} : { branchId }) });
    expect(r.status, JSON.stringify(r.body)).toBe(status);
    expect(codeOf(r)).toBe(code);
    const audit = await platform.query('SELECT status, permission FROM audit_log WHERE tenant_id = $1 AND user_id = $2 AND path = $3 AND idempotency_key = $4', [TENANT, user, path, key]);
    expect(audit.rows).toEqual([{ status, permission }]);
  };

  it('OB-97: each refusal of the replaced act is on the audit trail, and nothing was kept', async () => {
    await refusedOnTheTrail('u-mgr-b1', REPLACE, { ...BODY, approvalId: 'x' }, 403, 'replacement_needs_all_stores_authority', 'store.computer.replace', B);
    await refusedOnTheTrail('u-ho', REPLACE, { ...BODY, prefix: 'B2L1-' }, 422, 'prefix_not_issued_to_this_store', 'store.computer.replace');
    await refusedOnTheTrail('u-ho', REPLACE, { ...BODY, toComputer: 'u-box-b2' }, 422, 'not_a_store_computer_of_this_store', 'store.computer.replace');
    await refusedOnTheTrail('u-ho', REPLACE, BODY, 422, 'owner_approval_needed', 'store.computer.replace');
    // Self-approval on the maker-checker engine: the owner asks, and may not decide his own request.
    const asked = await cloud.request({ method: 'POST', path: '/v1/approvals/requests', userId: OWNER, idempotencyKey: `ask-${randomUUID()}`, body: {
      kind: 'store_computer_replaced', subjectRef: `${B}/${Q}`, details: BODY, summary: 'Move B1L1- to the new store computer', reason: BODY.reason,
    } });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const id = (asked.body as { requestId: string }).requestId;
    await refusedOnTheTrail(OWNER, `/v1/approvals/requests/${id}/decide`, { decision: 'approved', reason: 'my own' }, 422, 'self_approval', 'identity.self.read');
    const kept = await platform.query("SELECT count(*)::int AS n FROM event_ledger WHERE tenant_id = $1 AND type IN ('StoreComputerReplaced', 'ApprovalDecided')", [TENANT]);
    expect(kept.rows[0].n).toBe(0);
  }, 120_000);

  it('OB-97: the owner-approved act lands on the served API and the bindings read follows it', async () => {
    const asked = await cloud.request({ method: 'POST', path: '/v1/approvals/requests', userId: 'u-ho', idempotencyKey: `ask-${randomUUID()}`, body: {
      kind: 'store_computer_replaced', subjectRef: `${B}/${Q}`, details: BODY, summary: 'Move B1L1- to the new store computer', reason: BODY.reason,
    } });
    const id = (asked.body as { requestId: string }).requestId;
    expect((await cloud.request({ method: 'POST', path: `/v1/approvals/requests/${id}/decide`, userId: OWNER, idempotencyKey: `dec-${randomUUID()}`, body: { decision: 'approved', reason: 'checked the new machine' } })).status).toBe(201);
    const done = await cloud.request({ method: 'POST', path: REPLACE, userId: 'u-ho', idempotencyKey: `act-${randomUUID()}`, body: { ...BODY, approvalId: id } });
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    const bound = await cloud.request({ method: 'GET', path: BINDINGS, userId: OWNER });
    expect((bound.body as { bindings: { prefix: string; computer: string; via: string }[] }).bindings.filter((b) => b.prefix === Q).map((b) => [b.computer, b.via])).toEqual([['u-box-b1n', 'replacement']]);
    const kept = await platform.query("SELECT count(*)::int AS n FROM event_ledger WHERE tenant_id = $1 AND type = 'StoreComputerReplaced'", [TENANT]);
    expect(kept.rows[0].n).toBe(1);
  }, 120_000);

  it('OB-98: a refused acknowledgement of the not-checked line is on the audit trail, and nothing was kept', async () => {
    const body = { storeId: B, prefix: Q, count: 400, reason: 'support compared the restore record' };
    await refusedOnTheTrail('u-mgr-b1', NOT_CHECKED_ACK, body, 403, 'acknowledgement_needs_all_stores_authority', 'platform.alert.manage', B);
    await refusedOnTheTrail('u-it', NOT_CHECKED_ACK, body, 403, 'acknowledgement_refused_to_platform_administrator', 'platform.alert.manage');
    await refusedOnTheTrail('u-ho', NOT_CHECKED_ACK, { ...body, count: 7 }, 409, 'not_checked_set_changed', 'platform.alert.manage');
    const kept = await platform.query("SELECT count(*)::int AS n FROM event_ledger WHERE tenant_id = $1 AND type = 'BoxAtRiskNotCheckedAcknowledged'", [TENANT]);
    expect(kept.rows[0].n).toBe(0);
    // And the owner's acknowledgement is kept.
    expect((await cloud.request({ method: 'POST', path: NOT_CHECKED_ACK, userId: OWNER, idempotencyKey: `ack-${randomUUID()}`, body })).status).toBe(201);
    const after = await platform.query("SELECT count(*)::int AS n FROM event_ledger WHERE tenant_id = $1 AND type = 'BoxAtRiskNotCheckedAcknowledged'", [TENANT]);
    expect(after.rows[0].n).toBe(1);
  }, 120_000);
});
