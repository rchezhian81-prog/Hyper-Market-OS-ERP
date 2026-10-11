import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import type { PaymentProviderPort } from '../../edge/store-edge/src/payment-attempts';
import type { ProviderAuthorisation } from '../../packages/tender/src/pending-recovery';
import { GLOBAL_FOR } from '../../edge/store-edge/src/screen-data';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { prepareTillBox, signInTill, pinOf } from '../support/till-operator';

/**
 * **D04-FR-02 · PF-06 · PF-08 residual · WF-12 "tender settlement" — a card or UPI payment with no final answer holds the
 * store's day close on the box until it is resolved; the reason is shown, the day is never silently closed.**
 *
 * A real store computer (its lane socket, its disk, its screens socket), the real till page, and a stand-in payment
 * provider (no live provider is connected in this build). On day D a card payment gets NO ANSWER from the machine and a
 * UPI payment on another bill is asked and never answered. Next morning the manager, with their own till PIN, asks the
 * box to close day D: it refuses, naming both payments (till, bill, amount, since when); the manager's close list on the
 * screens socket shows both. A restart changes nothing. A payment asked on the NEW day does not hold yesterday. Once the
 * provider's record settles the no-answer and the cashier records the machine's own answer for the other, the day
 * closes and locks — and a second close of it is not a second lock.
 */

const KEY = ['pending', 'close', 'box', 'key'].join('-').padEnd(48, '0');
const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const s of stops.splice(0)) await s();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const provider = (records: { authorisations: ProviderAuthorisation[]; statementComplete: boolean }): PaymentProviderPort => ({
  lookup: async (reference) => ({ authorisations: records.authorisations.filter((a) => a.ref === reference), statementComplete: records.statementComplete }),
});

const PEOPLE = [{ userId: 'u-lanecash', displayName: 'Lane Cashier' }, { userId: 'u-mgr', displayName: 'Manager', manager: true }];
const PACK = {
  policies: { storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 30, warehouseId: 'wh-1' },
  lossPreventionRules: [],
  managerPolicy: { userId: 'u-mgr', approvalLimitMinor: 500_000 },
};

const startBox = async (dir: string, ready: Record<string, string>, paymentProvider: PaymentProviderPort): Promise<EdgeProcess> => {
  const edge = (await startEdge({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
    EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', ...ready,
  }, () => {}, { paymentProvider }))!;
  stops.push(() => edge.stop());
  return edge;
};

const managerList = async (edge: EdgeProcess): Promise<{ id: string; what: string }[] | undefined> => {
  const html = await (await fetch(`http://127.0.0.1:${edge.screens!.port}/manager`)).text();
  const m = new RegExp(`<script>window\\.${GLOBAL_FOR.manager} = ([\\s\\S]*?);</script>`).exec(html);
  expect(m, 'the manager screen was served no data').not.toBeNull();
  return (JSON.parse(m![1]!) as { pendingPayments?: { id: string; what: string }[] }).pendingPayments;
};

const DAY_D = '2026-10-05';
// 10:30 in the shop (UTC+05:30) on day D; and 08:30 the next morning — after the 02:00 cut-off, so D has ended.
const ON_DAY_D = new Date(`${DAY_D}T05:00:00.000Z`);
const NEXT_MORNING = new Date('2026-10-06T03:00:00.000Z');

describe('D04-FR-02 / PF-06 — a card or UPI payment with no final answer holds the day close on the box', () => {
  it('refuses the close naming each pending payment, shows them on the manager list, survives a restart, and closes once they are settled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-pending-close-'));
    dirs.push(dir);
    const ready = await prepareTillBox({ dir, key: KEY, people: PEOPLE, pack: PACK });
    const records = { authorisations: [] as ProviderAuthorisation[], statementComplete: false };

    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(ON_DAY_D);
    let edge = await startBox(dir, ready, provider(records));
    const t = bootPos({ laneId: 'lane-1', taxPercent: 0, lanePort: edge.lane!.port });
    await signInTill(t, 'u-lanecash');
    // Bill 1: the card machine gives no answer.
    t.scan({ productId: 'P1', description: 'Ghee 1L', unitPriceMinor: 64_000, qty: 1 });
    const card = await t.startCardPayment('card');
    expect(await t.answerCardPayment(card.attemptId!, 'no_answer')).toMatchObject({ ok: true, state: 'no_answer' });
    // Bill 2: a UPI request goes to the machine and nothing is ever recorded back.
    t.newSale();
    t.scan({ productId: 'P2', description: 'Rice 5kg', unitPriceMinor: 41_000, qty: 1 });
    const upi = await t.startCardPayment('upi');
    expect(upi).toMatchObject({ ok: true, state: 'asked', amountMinor: 41_000 });

    // ── Next morning: the manager asks the box to close day D with their own till PIN. Refused — and WHY.
    vi.setSystemTime(NEXT_MORNING);
    const refused = await edge.closeDay({ dayCloseId: `dc-${DAY_D}`, closedBy: 'u-mgr', closerPin: pinOf('u-mgr') });
    expect(refused.closed).toBe(false);
    const reason = (refused as { reason: string }).reason;
    expect(reason).toMatch(/2 card\/UPI payment\(s\) still have no final answer/);
    expect(reason).toContain(`card payment ${card.attemptId} on till lane-1`);
    expect(reason).toContain('Rs 640.00');
    expect(reason).toContain('the machine gave no answer and the provider has not settled it');
    expect(reason).toContain(`UPI payment ${upi.attemptId} on till lane-1`);
    expect(reason).toContain('no answer was recorded from the machine');
    expect(reason).toMatch(/do not run the card again/);
    // Nothing was locked: the box's day-close log is empty.
    expect((await readLog(join(dir, 'day-close.log')).catch(() => [])).length).toBe(0);
    // The manager's close list names both, before anyone taps Close.
    expect((await managerList(edge))!.map((p) => p.id).sort()).toEqual([card.attemptId, upi.attemptId].sort());
    expect((await managerList(edge))!.find((p) => p.id === card.attemptId)!.what).toMatch(/Card payment of Rs 640\.00 on till lane-1/);

    // ── A restart changes nothing: the attempts are on the disk, the hold stands.
    await edge.stop();
    stops.splice(0);
    edge = await startBox(dir, ready, provider(records));
    expect(await edge.closeDay({ dayCloseId: `dc-${DAY_D}`, closedBy: 'u-mgr', closerPin: pinOf('u-mgr') })).toMatchObject({ closed: false, reason: expect.stringMatching(/2 card\/UPI payment\(s\)/) });

    // ── Resolution, never by hand. The provider's record shows the card payment did NOT go through (complete record).
    const t2 = bootPos({ laneId: 'lane-1', taxPercent: 0, lanePort: edge.lane!.port });
    await signInTill(t2, 'u-lanecash');
    records.statementComplete = true;
    expect(await t2.checkCardPayment(card.attemptId!)).toMatchObject({ ok: true, state: 'recovered_not_paid' });
    // One still pending: still held, and now only that one is named.
    const stillOne = await edge.closeDay({ dayCloseId: `dc-${DAY_D}`, closedBy: 'u-mgr', closerPin: pinOf('u-mgr') });
    expect(stillOne).toMatchObject({ closed: false, reason: expect.stringMatching(/1 card\/UPI payment\(s\)/) });
    expect((stillOne as { reason: string }).reason).toContain(upi.attemptId!);
    expect((stillOne as { reason: string }).reason).not.toContain(card.attemptId!);

    // A payment asked TODAY with no answer does not hold yesterday's close.
    t2.scan({ productId: 'P3', description: 'Sugar 1kg', unitPriceMinor: 5_000, qty: 1 });
    const today = await t2.startCardPayment('card');
    expect(await t2.answerCardPayment(today.attemptId!, 'no_answer')).toMatchObject({ ok: true });

    // The cashier records what the machine said for the UPI request (declined). Now day D closes and locks.
    expect(await t2.answerCardPayment(upi.attemptId!, 'declined')).toMatchObject({ ok: true, state: 'declined' });
    const closed = await edge.closeDay({ dayCloseId: `dc-${DAY_D}`, closedBy: 'u-mgr', closerPin: pinOf('u-mgr') });
    expect(closed, JSON.stringify(closed)).toMatchObject({ closed: true, tradingDay: DAY_D, locked: true });
    // The manager list still shows TODAY's open payment — it will hold tonight's close.
    expect((await managerList(edge))!.map((p) => p.id)).toEqual([today.attemptId]);
  }, 60_000);

  it('a box with every payment answered closes as before — the hold is only for payments with no final answer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-pending-close-'));
    dirs.push(dir);
    const ready = await prepareTillBox({ dir, key: KEY, people: PEOPLE, pack: PACK });
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(ON_DAY_D);
    const edge = await startBox(dir, ready, provider({ authorisations: [], statementComplete: true }));
    const t = bootPos({ laneId: 'lane-1', taxPercent: 0, lanePort: edge.lane!.port });
    await signInTill(t, 'u-lanecash');
    t.scan({ productId: 'P1', description: 'Ghee 1L', unitPriceMinor: 64_000, qty: 1 });
    const a = await t.startCardPayment('card');
    await t.answerCardPayment(a.attemptId!, 'declined');
    expect(await managerList(edge)).toEqual([]);
    vi.setSystemTime(NEXT_MORNING);
    expect(await edge.closeDay({ dayCloseId: `dc-${DAY_D}`, closedBy: 'u-mgr', closerPin: pinOf('u-mgr') })).toMatchObject({ closed: true, locked: true });
  }, 60_000);
});
