import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, TEST_IDP, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import type { HttpRequest } from '../../services/kernel/src/index';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import type { PaymentProviderPort } from '../../edge/store-edge/src/payment-attempts';
import type { ProviderAuthorisation } from '../../packages/tender/src/pending-recovery';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { prepareTillBox, signInTill, pinOf } from '../support/till-operator';

/**
 * **OB-55 "A" (owner, 11 Oct 2026) · D04-FR-02 · PF-06 · WF-12 · M14-FR-04 — the manager closes the day with a card/UPI
 * payment that has no final answer CARRIED FORWARD to head office as a named finance exception: only with their own PIN
 * plus a SECOND person's approval on the store computer (offline), naming every pending payment. Head office lists each
 * one until the provider's later answer resolves it — once.**
 *
 * A real store computer (its lane socket, its disk, its one-use approval register, its sync agent) relaying through the
 * real transport to the real head-office API — in memory and, with DATABASE_URL, on real PostgreSQL. On day D a card
 * payment gets NO ANSWER and a UPI request is never answered. Next morning, with the line down:
 *   • without a second approval the old refusal stands; the closer approving themselves, a cashier approving, a wrong PIN
 *     and an approval that leaves one payment out are each refused, and nothing locks;
 *   • the manager's PIN plus the owner's PIN, naming both: the day locks on the box, the approval is issued and spent on
 *     the box's approval register, no PIN is written;
 *   • the line returns: head office records the close with what it carried, raises two named exceptions (flag-free: the
 *     approver holds the authority and the box sealed them), the day's tender figures say ₹640 card and ₹410 UPI are
 *     unresolved; a re-sent close carries nothing twice;
 *   • the provider's answer arrives at the till (Check payment): the card was paid, the UPI was not — each relayed once and
 *     each exception resolved once; a later DIFFERENT provider answer is refused and shown as a conflict, the same again is
 *     a no-op; finance resolving from the provider's record directly is the same engine; only finance may.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });
const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

const PEOPLE = [
  { userId: 'u-lanecash', displayName: 'Lane Cashier' },
  { userId: 'u-mgr', displayName: 'Manager', manager: true },
  // The owner on this box: may approve day-close matters with their own PIN (till.dayclose.approve).
  { userId: 'u-owner', displayName: 'Owner', permissions: ['till.dayclose.read', 'till.dayclose.approve'] },
];
const PACK = {
  policies: { storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 30, warehouseId: 'wh-1' },
  lossPreventionRules: [],
  managerPolicy: { userId: 'u-mgr', approvalLimitMinor: 500_000 },
};
const DAY_D = '2026-10-05';
const ON_DAY_D = new Date(`${DAY_D}T05:00:00.000Z`);
const NEXT_MORNING = new Date('2026-10-06T03:00:00.000Z');

const provider = (records: { authorisations: ProviderAuthorisation[]; statementComplete: boolean }): PaymentProviderPort => ({
  lookup: async (reference) => ({ authorisations: records.authorisations.filter((a) => a.ref === reference), statementComplete: records.statementComplete }),
});

const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
const savedFetch = globalThis.fetch;
afterEach(async () => {
  vi.useRealTimers();
  globalThis.fetch = savedFetch;
  for (const s of stops.splice(0)) await s();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

interface ExceptionList {
  exceptions: { attemptId: string; kind: string; amountMinor: number; tradingDay: string; state: string; storeId: string; dayCloseId: string; approvedBy: string; closedBy: string; governanceFlags: string[]; resolution: { paid: boolean; via: string } | null; conflicts: unknown[] }[];
  open: number; openMinor: { card: number; upi: number }; flagged: string[];
}

describe.each(backings)('OB-55 — a day closes with a pending card/UPI payment carried to head office — on $name', ({ harness }) => {
  it('needs the second person\'s approval naming each payment; head office lists them until the provider answers, once', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-box', 'store_computer', ['store-1']);
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-lanecash', 'cashier');
    await h.provisionRole(T, 'u-acct', 'accountant');
    let online = false;
    globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
      if (String(url).startsWith('http://127.0.0.1:')) return savedFetch(url, init);
      if (!online) throw new Error('ENETUNREACH');
      const hdr = (init.headers ?? {}) as Record<string, string>;
      // The store computer's own sign-in (its store-bound credential), minted at the moment it calls.
      const res = await h.raw({
        method: (init.method ?? 'GET') as HttpRequest['method'], path: new URL(url).pathname,
        token: TEST_IDP.issue({ sub: 'u-box', tenantId: T, branchId: 'store-1' }), idempotencyKey: hdr['idempotency-key'],
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
      });
      return new Response(JSON.stringify(res.body), { status: res.status });
    }) as unknown as typeof globalThis.fetch;
    let n = 0;
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Record<string, string>) =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${n += 1}-${randomUUID()}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const list = async () => (await call('GET', '/v1/finance/payment-exceptions', 'u-acct')).body as ExceptionList;

    const dir = await mkdtemp(join(tmpdir(), 'sre-carry-forward-'));
    dirs.push(dir);
    const ready = await prepareTillBox({ dir, key: TEST_PACK_KEY, people: PEOPLE, pack: PACK });
    const records = { authorisations: [] as ProviderAuthorisation[], statementComplete: false };
    const startBox = async (): Promise<EdgeProcess> => {
      const edge = (await startEdge({
        EDGE_DATA_DIR: dir, EDGE_TENANT_ID: T, PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
        EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: T, branchId: 'store-1' }), ...ready,
      }, () => {}, { paymentProvider: provider(records) }))!;
      stops.push(() => edge.stop());
      return edge;
    };

    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(ON_DAY_D);
    let edge = await startBox();
    const t = bootPos({ laneId: 'lane-1', taxPercent: 0, lanePort: edge.lane!.port });
    await signInTill(t, 'u-lanecash');
    t.scan({ productId: 'P1', description: 'Ghee 1L', unitPriceMinor: 64_000, qty: 1 });
    const card = await t.startCardPayment('card');
    expect(await t.answerCardPayment(card.attemptId!, 'no_answer')).toMatchObject({ ok: true, state: 'no_answer' });
    t.newSale();
    t.scan({ productId: 'P2', description: 'Rice 5kg', unitPriceMinor: 41_000, qty: 1 });
    const upi = await t.startCardPayment('upi');
    expect(upi).toMatchObject({ ok: true, state: 'asked' });
    const both = [card.attemptId!, upi.attemptId!];

    // ── Next morning, the line still down. Without a second person's approval the old refusal stands.
    vi.setSystemTime(NEXT_MORNING);
    const dc = `dc-${DAY_D}`;
    const close = (carryForward?: Record<string, unknown>) => edge.closeDay({ dayCloseId: dc, closedBy: 'u-mgr', closerPin: pinOf('u-mgr'), ...(carryForward === undefined ? {} : { carryForward: carryForward as never }) });
    expect(await close()).toMatchObject({ closed: false, reason: expect.stringMatching(/2 card\/UPI payment\(s\) still have no final answer/) });
    // The closer approving themselves; a cashier (no authority); the owner with a wrong PIN; an approval leaving one out.
    expect(await close({ attemptIds: both, approvedBy: 'u-mgr', approverPin: pinOf('u-mgr'), reason: 'provider down' })).toMatchObject({ closed: false, reason: expect.stringMatching(/second person must approve/) });
    expect(await close({ attemptIds: both, approvedBy: 'u-lanecash', approverPin: pinOf('u-lanecash'), reason: 'provider down' })).toMatchObject({ closed: false, reason: expect.stringMatching(/second person's approval was not confirmed/) });
    expect(await close({ attemptIds: both, approvedBy: 'u-owner', approverPin: pinOf('u-lanecash'), reason: 'provider down' })).toMatchObject({ closed: false, reason: expect.stringMatching(/not confirmed/) });
    const leftOut = await close({ attemptIds: [card.attemptId!], approvedBy: 'u-owner', approverPin: pinOf('u-owner'), reason: 'provider down' });
    expect(leftOut).toMatchObject({ closed: false, reason: expect.stringContaining(`not named: ${upi.attemptId!}`) });
    // The manager's own PIN is still required: a wrong closer PIN with a good approval locks nothing.
    expect(await edge.closeDay({ dayCloseId: dc, closedBy: 'u-mgr', closerPin: pinOf('u-lanecash'), carryForward: { attemptIds: both, approvedBy: 'u-owner', approverPin: pinOf('u-owner'), reason: 'provider down' } })).toMatchObject({ closed: false });
    // Nothing locked: no close on the box's day-close log (OB-69: the card's no-answer waits there to be relayed).
    expect((await readLog(edge.dayCloseLog.path)).filter((r) => r.ok && r.record.includes('"closedBy"')).length).toBe(0);

    // ── The manager's PIN and the owner's PIN, naming both: the day locks on the box, offline.
    const closed = await close({ attemptIds: both, approvedBy: 'u-owner', approverPin: pinOf('u-owner'), reason: 'card provider down since 9pm' });
    expect(closed, JSON.stringify(closed)).toMatchObject({ closed: true, tradingDay: DAY_D, locked: true, unresolvedMinor: { card: 64_000, upi: 41_000 } });
    expect([...(closed as unknown as { carriedForward: string[] }).carriedForward].sort()).toEqual([...both].sort());
    const dayLog = (await readLog(edge.dayCloseLog.path)).flatMap((r) => (r.ok && r.record.includes('"closedBy"') ? [r.record] : [])).map((r) => JSON.parse(r) as { closedBy: string; carriedForward: { approvedBy: string; approvalId: string; payments: { attemptId: string; tradingDay: string }[] }; approverVerified?: unknown });
    expect(dayLog).toHaveLength(1);
    expect(dayLog[0]).toMatchObject({ closedBy: 'u-mgr', carriedForward: { approvedBy: 'u-owner' } });
    expect(dayLog[0]!.approverVerified).toBeDefined();
    expect(dayLog[0]!.carriedForward.payments.map((p) => p.tradingDay)).toEqual([DAY_D, DAY_D]);
    // The approval was issued AND spent on the box's one-use approval register, for this close; no PIN is on any log.
    const approvals = (await readLog(join(dir, 'till-approvals.log'))).filter((r) => r.ok).map((r) => JSON.parse(r.record) as { kind: string; approvalId: string; subjectKind?: string; usedBy?: string; approvedBy?: string });
    const granted = approvals.find((a) => a.kind === 'granted' && a.subjectKind === 'day_close_exception')!;
    expect(granted).toMatchObject({ approvedBy: 'u-owner', approvalId: dayLog[0]!.carriedForward.approvalId });
    expect(approvals.find((a) => a.kind === 'used' && a.approvalId === granted.approvalId)?.usedBy).toBe(dc);
    for (const who of ['u-mgr', 'u-owner']) expect(JSON.stringify(approvals) + JSON.stringify(dayLog)).not.toContain(pinOf(who));
    expect(await list()).toMatchObject({ open: 0 }); // nothing at head office yet — the line is down

    // ── A restart, then the line returns: head office records the close and raises two named exceptions.
    await edge.stop();
    stops.splice(0);
    edge = await startBox();
    online = true;
    expect((await edge.syncOnce!()).dead).toBe(0);
    const closes = (await call('GET', '/v1/pos/day-close', 'u-owner')).body as { dayCloses: { dayCloseId: string; carriedForward: { approvedBy: string; attemptIds: string[]; unresolvedMinor: { card: number; upi: number }; flags: string[] } | null }[]; flaggedCloses: unknown[] };
    expect(closes.dayCloses.find((c) => c.dayCloseId === dc)!.carriedForward).toMatchObject({ approvedBy: 'u-owner', unresolvedMinor: { card: 64_000, upi: 41_000 }, flags: [] });
    expect(closes.flaggedCloses).toEqual([]);
    let l = await list();
    expect(l).toMatchObject({ open: 2, openMinor: { card: 64_000, upi: 41_000 }, flagged: [] });
    expect(l.exceptions.map((e) => [e.attemptId, e.kind, e.amountMinor, e.tradingDay, e.state, e.storeId, e.dayCloseId, e.closedBy, e.approvedBy]).sort()).toEqual([
      [card.attemptId, 'card', 64_000, DAY_D, 'open', 'store-1', dc, 'u-mgr', 'u-owner'],
      [upi.attemptId, 'upi', 41_000, DAY_D, 'open', 'store-1', dc, 'u-mgr', 'u-owner'],
    ].sort());
    // The day's tender figures say which amounts are unresolved (a cash sale of the day makes the report produce).
    expect((await call('POST', '/v1/sales', 'u-owner', {
      saleId: 'S-D-1', receiptNumber: 'R-D-1', laneId: 'lane-1', cashierId: 'u-lanecash', locationId: 'store-1', tradingDay: DAY_D, committedAt: `${DAY_D}T06:00:00.000Z`,
      totalMinor: 5_000, currency: 'INR', packVersion: 1, lines: [{ productId: 'P3', quantityMinor: 1, uom: 'each', unitPriceMinor: 5_000, lineTotalMinor: 5_000, taxRateBps: 0 }],
      tenders: [{ kind: 'cash', amountMinor: 5_000 }],
    })).status).toBeLessThan(300);
    const tenders = (await call('GET', '/v1/reports/tender_mix', 'u-owner', undefined, { day: DAY_D })).body as { figures: { name: string; valueMinor?: number }[] };
    expect(tenders.figures.find((f) => f.name === 'cash')?.valueMinor).toBe(5_000);
    expect(tenders.figures.find((f) => f.name.startsWith('unresolved — card'))).toMatchObject({ name: `unresolved — card (${card.attemptId!})`, valueMinor: 64_000 });
    expect(tenders.figures.find((f) => f.name.startsWith('unresolved — upi'))).toMatchObject({ name: `unresolved — upi (${upi.attemptId!})`, valueMinor: 41_000 });
    // A re-sent close (a lost reply) carries nothing twice.
    const closeEvent = edge.dayCloseOutbox.pending().length === 0 ? undefined : edge.dayCloseOutbox.pending()[0];
    expect(closeEvent).toBeUndefined();
    const relayedBody = { dayCloseId: dc, storeId: 'store-1', tradingDay: DAY_D, closedBy: 'u-mgr', closedAt: NEXT_MORNING.toISOString(), locked: true, carriedForward: dayLog[0]!.carriedForward, approverVerified: dayLog[0]!.approverVerified };
    expect((await h.request({ method: 'POST', path: `/v1/pos/day-close/${dc}/synced`, userId: 'u-box', tenantId: T, idempotencyKey: `fresh-${randomUUID()}`, body: relayedBody })).status).toBe(200);
    expect((await list()).exceptions).toHaveLength(2);

    // ── The provider answers. At the till: the card WAS paid; the UPI request never reached the provider.
    records.authorisations.push({ ref: card.attemptId!, amountMinor: 64_000, status: 'captured', at: '2026-10-05T05:01:00.000Z' });
    records.statementComplete = true;
    const t2 = bootPos({ laneId: 'lane-1', taxPercent: 0, lanePort: edge.lane!.port });
    await signInTill(t2, 'u-lanecash');
    expect(await t2.checkCardPayment(card.attemptId!)).toMatchObject({ ok: true, state: 'recovered_paid' });
    expect(await t2.checkCardPayment(upi.attemptId!)).toMatchObject({ ok: true, state: 'recovered_not_paid' });
    // Asked again at the till: already settled, nothing relayed twice.
    expect(await t2.checkCardPayment(card.attemptId!)).toMatchObject({ ok: true, state: 'recovered_paid' });
    expect((await readLog(edge.dayCloseLog.path)).filter((r) => r.ok && r.record.includes('resolvedAttemptId'))).toHaveLength(2);
    expect((await edge.syncOnce!()).dead).toBe(0);
    l = await list();
    expect(l).toMatchObject({ open: 0, openMinor: { card: 0, upi: 0 } });
    expect(l.exceptions.find((e) => e.attemptId === card.attemptId)).toMatchObject({ state: 'resolved_paid', resolution: { paid: true, via: 'store_computer' } });
    expect(l.exceptions.find((e) => e.attemptId === upi.attemptId)).toMatchObject({ state: 'resolved_not_paid', resolution: { paid: false, via: 'store_computer' } });
    const after = (await call('GET', '/v1/reports/tender_mix', 'u-owner', undefined, { day: DAY_D })).body as { figures: { name: string }[] };
    expect(after.figures.some((f) => f.name.startsWith('unresolved'))).toBe(false);

    // ── Finance with the provider's own record: a DIFFERENT answer is refused and shown; the same one is a no-op.
    const resolve = (attemptId: string, auths: ProviderAuthorisation[], userId = 'u-acct') => call('POST', `/v1/finance/payment-exceptions/${attemptId}/resolve`, userId, { authorisations: auths, statementComplete: true });
    const conflict = await resolve(card.attemptId!, [{ ref: card.attemptId!, amountMinor: 64_000, status: 'declined', at: '2026-10-05T05:01:00.000Z' }]);
    expect(conflict.status).toBe(409);
    expect((conflict.body as { error: { code: string } }).error.code).toBe('resolution_conflicts');
    const same = await resolve(card.attemptId!, [{ ref: card.attemptId!, amountMinor: 64_000, status: 'captured', at: '2026-10-05T05:01:00.000Z' }]);
    expect(same.status).toBe(200);
    expect(same.body).toMatchObject({ alreadyResolved: true });
    l = await list();
    expect(l.exceptions.find((e) => e.attemptId === card.attemptId)!.conflicts).toHaveLength(1);
    expect(l.flagged).toEqual([card.attemptId]);
    // Only finance resolves; a store manager and a cashier cannot, and a cashier cannot read the list.
    expect((await resolve(card.attemptId!, [], 'u-mgr')).status).toBe(403);
    expect((await call('GET', '/v1/finance/payment-exceptions', 'u-lanecash')).status).toBe(403);
    // A payment no close carried is not an exception.
    expect((await resolve('PAY-unknown', [])).status).toBe(404);
  }, 90_000);

  it('PF-06: a machine answer typed in next morning for yesterday\'s attempt needs a manager at the till, and reaches head office as such', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-box', 'store_computer', ['store-1']);
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-lanecash', 'cashier');
    await h.provisionRole(T, 'u-acct', 'accountant');
    globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
      if (String(url).startsWith('http://127.0.0.1:')) return savedFetch(url, init);
      const hdr = (init.headers ?? {}) as Record<string, string>;
      const res = await h.raw({
        method: (init.method ?? 'GET') as HttpRequest['method'], path: new URL(url).pathname,
        token: TEST_IDP.issue({ sub: 'u-box', tenantId: T, branchId: 'store-1' }), idempotencyKey: hdr['idempotency-key'],
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
      });
      return new Response(JSON.stringify(res.body), { status: res.status });
    }) as unknown as typeof globalThis.fetch;
    const dir = await mkdtemp(join(tmpdir(), 'sre-late-answer-'));
    dirs.push(dir);
    const ready = await prepareTillBox({ dir, key: TEST_PACK_KEY, people: PEOPLE, pack: PACK });
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(ON_DAY_D);
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: T, PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
      EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: T, branchId: 'store-1' }), ...ready,
    }, () => {}))!;
    stops.push(() => edge.stop());
    const t = bootPos({ laneId: 'lane-1', taxPercent: 0, lanePort: edge.lane!.port });
    await signInTill(t, 'u-lanecash');
    t.scan({ productId: 'P2', description: 'Rice 5kg', unitPriceMinor: 41_000, qty: 1 });
    const upi = await t.startCardPayment('upi');
    // The same day, the cashier records what the machine said for another attempt with no approval (today's flow).
    t.newSale();
    t.scan({ productId: 'P1', description: 'Ghee 1L', unitPriceMinor: 64_000, qty: 1 });
    const sameDay = await t.startCardPayment('card');
    expect(await t.answerCardPayment(sameDay.attemptId!, 'declined')).toMatchObject({ ok: true, state: 'declined' });

    vi.setSystemTime(NEXT_MORNING);
    await signInTill(t, 'u-lanecash');
    expect(await t.answerCardPayment(upi.attemptId!, 'declined')).toMatchObject({ ok: false, refusedBecause: 'approval_required' });
    const approval = await t.approveAtTill({ managerId: 'u-mgr', pin: pinOf('u-mgr'), kind: 'late_payment_answer', billRef: upi.attemptId!, valueMinor: 41_000, reason: 'machine slip shows declined' });
    expect(await t.answerCardPayment(upi.attemptId!, 'declined', (approval as { approvalId: string }).approvalId)).toMatchObject({ ok: true, state: 'declined' });
    expect((await edge.syncOnce!()).dead).toBe(0);
    const l = (await h.request({ method: 'GET', path: '/v1/finance/payment-exceptions', userId: 'u-acct', tenantId: T })).body as { lateAnswers: { attemptId: string; outcome: string; answeredBy: string; approvedBy: string; tradingDay: string; storeId: string; flags: string[] }[] };
    expect(l.lateAnswers).toEqual([expect.objectContaining({ attemptId: upi.attemptId, outcome: 'declined', answeredBy: 'u-lanecash', approvedBy: 'u-mgr', tradingDay: DAY_D, storeId: 'store-1', flags: [] })]);
    // The day now closes (the relay is not trading the day owes the cloud), and the same answer re-sent records nothing twice.
    expect(await edge.closeDay({ dayCloseId: 'dc-late', closedBy: 'u-mgr', closerPin: pinOf('u-mgr') })).toMatchObject({ closed: true });
    const again = await h.request({ method: 'POST', path: `/v1/finance/payment-exceptions/${upi.attemptId!}/late-answer/synced`, userId: 'u-box', tenantId: T, idempotencyKey: `fresh-${randomUUID()}`, body: { ...l.lateAnswers[0], approvalId: 'apr-x', laneId: 'lane-1', billRef: 'b', kind: 'upi', amountMinor: 41_000, askedAt: 'x', answeredAt: 'y' } });
    expect(again.body).toMatchObject({ alreadyRecorded: true });
  }, 60_000);

  it('finance resolves an exception from the provider\'s record — an incomplete record with nothing in it is NOT a decline', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-box', 'store_computer', ['store-1']);
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-acct', 'accountant');
    let n = 0;
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown) =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${n += 1}-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
    // An older relay with no seal on the approver, and an approver head office does not know: recorded, FLAGGED.
    const body = {
      dayCloseId: 'dc-x', storeId: 'store-1', tradingDay: DAY_D, closedBy: 'u-mgr', closedAt: '2026-10-06T03:00:00.000Z', locked: true,
      carriedForward: {
        approvalId: 'apr-x', approvedBy: 'u-stranger', reason: 'provider down',
        payments: [{ attemptId: 'PAY-x1', laneId: 'lane-1', billRef: 'B-1', kind: 'card', amountMinor: 30_000, askedAt: '2026-10-05T05:00:00.000Z', state: 'no_answer', tradingDay: DAY_D }],
        unresolvedMinor: { card: 30_000, upi: 0 },
      },
    };
    const rec = await call('POST', '/v1/pos/day-close/dc-x/synced', 'u-box', body);
    expect(rec.status).toBe(202);
    expect((rec.body as { carriedForward: { flags: string[] } }).carriedForward.flags).toEqual(['approver_lacks_authority', 'approver_not_verified_at_store']);
    const l = (await call('GET', '/v1/finance/payment-exceptions', 'u-acct')).body as ExceptionList;
    expect(l).toMatchObject({ open: 1, flagged: ['PAY-x1'] });
    // A carried block that cannot be read is kept at the store, not half-recorded.
    expect((await call('POST', '/v1/pos/day-close/dc-y/synced', 'u-box', { ...body, dayCloseId: 'dc-y', carriedForward: { approvedBy: 'u-owner' } })).status).toBe(400);
    // Incomplete provider record, nothing found: still unknown — it stays open.
    const unknown = await call('POST', '/v1/finance/payment-exceptions/PAY-x1/resolve', 'u-acct', { authorisations: [], statementComplete: false });
    expect(unknown.status).toBe(422);
    expect((unknown.body as { error: { code: string } }).error.code).toBe('still_unknown');
    // A reference that looks like a card number is refused (hard rule #3).
    expect((await call('POST', '/v1/finance/payment-exceptions/PAY-x1/resolve', 'u-acct', { authorisations: [{ ref: '4111111111111111', amountMinor: 30_000, status: 'captured', at: DAY_D }], statementComplete: true })).status).toBe(422);
    // The complete record shows it captured: resolved, paid — once.
    const ok = await call('POST', '/v1/finance/payment-exceptions/PAY-x1/resolve', 'u-acct', { authorisations: [{ ref: 'PAY-x1', amountMinor: 30_000, status: 'captured', at: '2026-10-05T05:00:30.000Z' }], statementComplete: true });
    expect(ok.status).toBe(201);
    expect(((await call('GET', '/v1/finance/payment-exceptions', 'u-acct')).body as ExceptionList).exceptions[0]).toMatchObject({ state: 'resolved_paid', resolution: { paid: true, via: 'provider_record' } });
  }, 60_000);
});
