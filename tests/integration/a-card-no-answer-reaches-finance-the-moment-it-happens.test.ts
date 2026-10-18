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
import { STREAM, streamName } from '../../services/api/src/adapters';
import { readLog } from '../../edge/store-edge/src/file-log';
import type { PaymentProviderPort } from '../../edge/store-edge/src/payment-attempts';
import type { ProviderAuthorisation } from '../../packages/tender/src/pending-recovery';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { prepareTillBox, signInTill, pinOf } from '../support/till-operator';

/**
 * **OB-69 "A" (owner, 11 Oct 2026, in writing, "The moment it happens") — finance sees a card/UPI payment with no final answer
 * the moment the till records it (PF-06 · WF-12 · D04-FR-02 · M14-FR-04 · P-01 · P-08 · hard rules #1 #2 #3 #10).**
 *
 * A real store computer (its lane socket, its disk, its sync agent) relaying through the real transport to the real
 * head-office API — in memory and, with DATABASE_URL, on real PostgreSQL:
 *   • line UP: the card machine gives NO ANSWER on a ₹640 bill — the box relays it at once: head office lists ONE open
 *     finance item (raised, no day close yet), and the day's tender figures say ₹640 card is unresolved;
 *   • the line is CUT: a ₹410 UPI request gets no answer — queued on the box (the till keeps trading); head office still holds
 *     one; the box restarts offline and the relay is still queued, once; the card's provider answer arrives at the till
 *     (paid) and is queued; next morning the manager closes the day OFFLINE, carrying the UPI forward with the owner's
 *     approval — the queued relays do not hold the close (P-01);
 *   • the line RETURNS: head office holds exactly TWO items — the card resolved (paid) by the provider's answer, the UPI the
 *     SAME item now carried by the close (raised first, then carried — never a second item); open ₹410 UPI only, counted
 *     once in the open total and the day's tender figures; a re-sent relay and a re-sent close add nothing;
 *   • the UPI's provider answer (not paid) resolves it once; nothing is open.
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
  { userId: 'u-owner', displayName: 'Owner', permissions: ['till.dayclose.read', 'till.dayclose.approve'] },
];
const PACK = {
  policies: { storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' },
  lossPreventionRules: [],
  managerPolicy: { userId: 'u-mgr', approvalLimitMinor: 500_000 },
};
const DAY_D = '2026-10-07';
const NEXT_MORNING = new Date('2026-10-08T03:00:00.000Z');

const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
const savedFetch = globalThis.fetch;
afterEach(async () => {
  vi.useRealTimers();
  globalThis.fetch = savedFetch;
  for (const s of stops.splice(0)) await s();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

interface Row { attemptId: string; kind: string; amountMinor: number; tradingDay: string; state: string; stage: string; storeId: string; dayCloseId: string | null; raisedAt: string | null; resolution: { paid: boolean; via: string } | null }
interface ExceptionList { exceptions: Row[]; open: number; openMinor: { card: number; upi: number } }

describe.each(backings)('OB-69 — a card/UPI no-answer reaches finance the moment it happens — on $name', ({ harness }) => {
  it('relays each no-answer at once (or on reconnect), one open item per attempt, resolved once by the provider or carried by the close', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-box', 'store_computer', ['store-1']);
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-lanecash', 'cashier');
    await h.provisionRole(T, 'u-acct', 'accountant');
    let online = true;
    globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
      if (String(url).startsWith('http://127.0.0.1:')) return savedFetch(url, init);
      if (!online) throw new Error('ENETUNREACH');
      const hdr = (init.headers ?? {}) as Record<string, string>;
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
    const unresolvedFigures = async () => ((await call('GET', '/v1/reports/tender_mix', 'u-owner', undefined, { day: DAY_D })).body as { figures: { name: string; valueMinor?: number }[] }).figures.filter((f) => f.name.startsWith('unresolved'));

    const dir = await mkdtemp(join(tmpdir(), 'sre-no-answer-'));
    dirs.push(dir);
    const ready = await prepareTillBox({ dir, key: TEST_PACK_KEY, people: PEOPLE, pack: PACK });
    const records = { authorisations: [] as ProviderAuthorisation[], statementComplete: false };
    const provider: PaymentProviderPort = { lookup: async (reference) => ({ authorisations: records.authorisations.filter((a) => a.ref === reference), statementComplete: records.statementComplete }) };
    const startBox = async (): Promise<EdgeProcess> => {
      const edge = (await startEdge({
        EDGE_DATA_DIR: dir, EDGE_TENANT_ID: T, PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
        EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: T, branchId: 'store-1' }), ...ready,
      }, () => {}, { paymentProvider: provider }))!;
      stops.push(() => edge.stop());
      return edge;
    };
    const relaysOnBox = async () => (await readLog(join(dir, 'day-close.log'))).filter((r) => r.ok && r.record.includes('noAnswerAttemptId'));
    const pendingRelays = (edge: EdgeProcess) => edge.dayCloseOutbox.pending().filter((i) => i.event.type === 'PaymentNoAnswerRaised').map((i) => (i.event.payload as { attemptId: string }).attemptId);

    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(new Date(`${DAY_D}T05:00:00.000Z`));
    let edge = await startBox();
    const t = bootPos({ laneId: 'lane-1', taxPercent: 0, lanePort: edge.lane!.port });
    await signInTill(t, 'u-lanecash');

    // ── Line UP: the card machine gives no answer — relayed at once, ONE open finance item (raised, no close yet).
    t.scan({ productId: 'P1', description: 'Ghee 1L', unitPriceMinor: 64_000, qty: 1 });
    const card = await t.startCardPayment('card');
    expect(await t.answerCardPayment(card.attemptId!, 'no_answer')).toMatchObject({ ok: true, state: 'no_answer' });
    expect(pendingRelays(edge)).toEqual([card.attemptId]);
    expect((await edge.syncOnce!()).dead).toBe(0);
    let l = await list();
    expect(l).toMatchObject({ open: 1, openMinor: { card: 64_000, upi: 0 } });
    expect(l.exceptions.map((e) => [e.attemptId, e.kind, e.amountMinor, e.tradingDay, e.state, e.stage, e.storeId, e.dayCloseId])).toEqual([[card.attemptId, 'card', 64_000, DAY_D, 'open', 'raised', 'store-1', null]]);
    expect(l.exceptions[0]!.raisedAt).not.toBeNull();
    // The day's tender figures say it at once (a cash sale makes the day's report produce).
    expect((await call('POST', '/v1/sales', 'u-owner', {
      saleId: 'S-D-1', receiptNumber: 'R-D-1', laneId: 'lane-1', cashierId: 'u-lanecash', locationId: 'store-1', tradingDay: DAY_D, committedAt: `${DAY_D}T06:00:00.000Z`,
      totalMinor: 5_000, currency: 'INR', packVersion: 1, lines: [{ productId: 'P3', quantityMinor: 1, uom: 'each', unitPriceMinor: 5_000, lineTotalMinor: 5_000, taxRateBps: 0 }],
      tenders: [{ kind: 'cash', amountMinor: 5_000 }],
    })).status).toBeLessThan(300);
    expect(await unresolvedFigures()).toEqual([expect.objectContaining({ name: `unresolved — card (${card.attemptId!})`, valueMinor: 64_000 })]);
    // One relay record on the box's disk for it.
    expect(await relaysOnBox()).toHaveLength(1);

    // ── The line is CUT: the UPI request gets no answer — queued on the box; the till keeps trading.
    online = false;
    t.newSale();
    t.scan({ productId: 'P2', description: 'Rice 5kg', unitPriceMinor: 41_000, qty: 1 });
    const upi = await t.startCardPayment('upi');
    expect(await t.answerCardPayment(upi.attemptId!, 'no_answer')).toMatchObject({ ok: true, state: 'no_answer' });
    expect(pendingRelays(edge)).toEqual([upi.attemptId]);
    expect((await edge.syncOnce!()).sent).toBe(0);
    expect((await list()).exceptions).toHaveLength(1);
    // A restart, still offline: the relay is re-minted from the box's disk — still queued, still once.
    await edge.stop();
    stops.splice(0);
    edge = await startBox();
    expect(pendingRelays(edge)).toEqual([upi.attemptId]);
    expect(await relaysOnBox()).toHaveLength(2);
    // The card's provider answer arrives at the till (offline): paid — queued for head office.
    records.authorisations.push({ ref: card.attemptId!, amountMinor: 64_000, status: 'captured', at: `${DAY_D}T05:01:00.000Z` });
    records.statementComplete = true;
    const t2 = bootPos({ laneId: 'lane-1', taxPercent: 0, lanePort: edge.lane!.port });
    await signInTill(t2, 'u-lanecash');
    expect(await t2.checkCardPayment(card.attemptId!)).toMatchObject({ ok: true, state: 'recovered_paid' });
    // Next morning, still offline: the manager closes the day carrying the UPI forward — the queued relays do not hold it.
    records.statementComplete = false;
    vi.setSystemTime(NEXT_MORNING);
    const dc = `dc-${DAY_D}`;
    const closed = await edge.closeDay({ dayCloseId: dc, closedBy: 'u-mgr', closerPin: pinOf('u-mgr'), carryForward: { attemptIds: [upi.attemptId!], approvedBy: 'u-owner', approverPin: pinOf('u-owner'), reason: 'UPI switch down' } as never });
    expect(closed, JSON.stringify(closed)).toMatchObject({ closed: true, tradingDay: DAY_D, unresolvedMinor: { card: 0, upi: 41_000 } });

    // ── The line RETURNS: two items — the card resolved by the provider, the UPI the SAME item now carried.
    online = true;
    expect((await edge.syncOnce!()).dead).toBe(0);
    l = await list();
    expect(l).toMatchObject({ open: 1, openMinor: { card: 0, upi: 41_000 } });
    expect(l.exceptions.map((e) => [e.attemptId, e.state, e.stage, e.dayCloseId]).sort()).toEqual([
      [card.attemptId, 'resolved_paid', 'raised', null],
      [upi.attemptId, 'open', 'carried', dc],
    ].sort());
    expect(l.exceptions.find((e) => e.attemptId === upi.attemptId)!.raisedAt).not.toBeNull();
    expect(l.exceptions.find((e) => e.attemptId === card.attemptId)!.resolution).toMatchObject({ paid: true, via: 'store_computer' });
    // Counted once: the day's tender figures carry the UPI's ₹410 once (raised AND carried is one item); the card's is gone.
    expect(await unresolvedFigures()).toEqual([expect.objectContaining({ name: `unresolved — upi (${upi.attemptId!})`, valueMinor: 41_000 })]);
    // A re-sent relay and a re-sent close (lost replies) add nothing.
    const again = await h.request({ method: 'POST', path: `/v1/finance/payment-exceptions/${upi.attemptId!}/no-answer/synced`, userId: 'u-box', tenantId: T, idempotencyKey: `fresh-${randomUUID()}`, body: {
      attemptId: upi.attemptId, laneId: 'lane-1', billRef: 'x', kind: 'upi', amountMinor: 41_000, askedAt: `${DAY_D}T05:30:00.000Z`, tradingDay: DAY_D, recordedAt: `${DAY_D}T05:30:01.000Z`, recordedBy: 'u-lanecash', storeId: 'store-1',
    } });
    expect(again).toMatchObject({ status: 200, body: { alreadyRecorded: true, stage: 'carried' } });
    expect((await list()).exceptions).toHaveLength(2);
    // Only the store computer relays; a cashier's own sign-in cannot raise one.
    expect((await call('POST', '/v1/finance/payment-exceptions/PAY-x/no-answer/synced', 'u-lanecash', { laneId: 'lane-1', billRef: 'b', kind: 'card', amountMinor: 100, askedAt: 'a', tradingDay: DAY_D, recordedAt: 'a', recordedBy: 'u-lanecash' })).status).toBe(403);

    // ── The UPI's provider answer (not paid) resolves it once; nothing is open.
    records.statementComplete = true;
    const t3 = bootPos({ laneId: 'lane-1', taxPercent: 0, lanePort: edge.lane!.port });
    await signInTill(t3, 'u-lanecash');
    const upiCheck = await t3.checkCardPayment(upi.attemptId!);
    expect(upiCheck, JSON.stringify(upiCheck)).toMatchObject({ ok: true, state: 'recovered_not_paid' });
    expect((await edge.syncOnce!()).dead).toBe(0);
    l = await list();
    expect(l).toMatchObject({ open: 0, openMinor: { card: 0, upi: 0 } });
    expect(l.exceptions.find((e) => e.attemptId === upi.attemptId)).toMatchObject({ state: 'resolved_not_paid', stage: 'carried', resolution: { paid: false, via: 'store_computer' } });
    expect((await readLog(join(dir, 'day-close.log'))).filter((r) => r.ok && r.record.includes('resolvedAttemptId'))).toHaveLength(2);
    const events = (await h.store.readStream(T, streamName(STREAM.finance, 'payment-exceptions'), {})).map((e) => e.event.type);
    expect(events.filter((x) => x === 'PaymentNoAnswerRaised')).toHaveLength(2);
    expect(events.filter((x) => x === 'PaymentExceptionResolved')).toHaveLength(2);
  }, 90_000);
});
