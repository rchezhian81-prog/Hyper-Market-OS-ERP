import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { laneHeldBills, bootPos, LANE_NO_ANSWER, NO_ANSWER_WORDS, HeldListNotKnownError, LaneNoAnswerError, type HeldBillsPort } from '../../apps/pos/src/browser-entry';
import { HeldBills } from '../../edge/store-edge/src/held-bills';

/**
 * OB-908 · D-127 · P-08: a till's held-basket calls to its own store computer used `fetch` with no time limit. When the
 * store computer took the call but did not answer, the till waited for ever with nothing on the screen (CI on PR #974:
 * "a held basket can be given up from More…" hung 30 s). These stand up a store computer that takes the call and never
 * answers — the mechanism, proved — and hold the till to a bounded wait that says plainly what it knows.
 */

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((resolve) => { s.closeAllConnections(); s.close(() => resolve()); });
});

/** A store computer that reads the call and then says nothing (or answers after `lateMs`). */
const silentBox = async (lateMs?: number): Promise<{ port: number; calls: string[] }> => {
  const calls: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    calls.push(`${req.method} ${req.url}`);
    req.resume();
    if (lateMs !== undefined) setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ held: true, billId: 'H-late' })); }, lateMs);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, calls };
};

describe('the till waits for its store computer a bounded time on a held basket (OB-908 · P-08)', () => {
  it('a store computer that never answers a HOLD: the till says so within the wait — it does not hang', async () => {
    const box = await silentBox();
    const started = Date.now();
    const r = await laneHeldBills(box.port, { waitMs: 300 }).hold({ billId: 'H-1', lines: [] });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(r).toMatchObject({ refusedBecause: 'lane_no_answer' });
    expect(String(r['laneMessage'])).toContain('did not answer in time');
    expect(String(r['laneMessage'])).toContain('still on this till');
    expect(String(r['laneMessageTa'])).toContain('கடை கணினி');
    expect(box.calls).toEqual(['POST /lane/held-bills']);
  }, 8_000);

  it('recall, give-up and the held list are bounded the same way, each in its own honest words', async () => {
    const box = await silentBox();
    const port = laneHeldBills(box.port, { waitMs: 300 });
    const recall = await port.recall('H-1');
    expect(recall).toMatchObject({ refusedBecause: 'lane_no_answer' });
    expect(String(recall['laneMessage'])).toContain('did not come back');
    const abandon = await port.abandon('H-1', 'customer_left');
    expect(abandon).toMatchObject({ refusedBecause: 'lane_no_answer' });
    expect(String(abandon['laneMessage'])).toContain('does not know');
    expect(String(abandon['laneMessage'])).not.toMatch(/^Basket given up/);
    // The list never pretends "nothing on hold" when the store computer did not say.
    await expect(port.list()).rejects.toMatchObject({ refusedBecause: 'lane_no_answer' });
  }, 8_000);

  it('the shop\'s default wait is five seconds — a store computer that answers in under it is waited for', async () => {
    const box = await silentBox(400);
    const r = await laneHeldBills(box.port).hold({ billId: 'H-late', lines: [] });
    expect(r).toMatchObject({ held: true, billId: 'H-late' });
  }, 8_000);
});

describe('a till action whose answer ran out of wait is never kept twice when the cashier presses again (OB-908)', () => {
  const dirs: string[] = [];
  afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
  const register = async (): Promise<HeldBills> => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-held-no-answer-'));
    dirs.push(dir);
    return HeldBills.open({ dataDir: dir, capacityBytes: 1_048_576, tenantId: 't-sre', policy: () => null, storeId: () => 'store-1', now: () => '2026-11-21T05:00:00.000Z' });
  };
  /** A store computer that WRITES the hold and then its answer never reaches the till (the first `drop` times). */
  const writesButSaysNothing = (box: HeldBills, drop: number): { port: HeldBillsPort; sent: string[] } => {
    const sent: string[] = [];
    let dropped = 0;
    const port: HeldBillsPort = {
      hold: async (body) => {
        sent.push(String(body['billId']));
        const out = await box.hold({ laneId: 'lane-1', cashierId: 'u-cash', ...(body as { billId: unknown; lines: unknown }) });
        if (dropped < drop) { dropped += 1; return { refusedBecause: LANE_NO_ANSWER, laneMessage: NO_ANSWER_WORDS.hold.en, laneMessageTa: NO_ANSWER_WORDS.hold.ta }; }
        return out as unknown as Record<string, unknown>;
      },
      list: async () => box.list('lane-1'),
      recall: async () => ({ recalled: false }),
      abandon: async () => ({ abandoned: false }),
    };
    return { port, sent };
  };

  it('HOLD, no answer in time: the basket stays on the till with plain words (English and Tamil); pressed again, the SAME basket id goes and the store computer keeps ONE basket', async () => {
    const box = await register();
    const { port, sent } = writesButSaysNothing(box, 1);
    const till = bootPos({ laneId: 'lane-1', taxPercent: 0, heldBillsPort: port });
    till.signIn('u-cash');
    till.scan({ productId: 'p-dal', description: 'Toor dal 1kg', unitPriceMinor: 12_000, qty: 2 });

    const first = await till.holdAtTill();
    expect(first).toMatchObject({ ok: false, refusedBecause: LANE_NO_ANSWER });
    expect(first.laneMessage).toBe(NO_ANSWER_WORDS.hold.en);
    expect(first.laneMessage).not.toMatch(/^Basket held/);
    expect(first.laneMessageTa).toBe(NO_ANSWER_WORDS.hold.ta);
    expect(till.basket()).toHaveLength(1); // still on this till — never cleared on a guess

    const second = await till.holdAtTill();
    expect(second).toMatchObject({ ok: true });
    expect(till.basket()).toHaveLength(0);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
    expect(box.list('lane-1')).toHaveLength(1);
    await box.close();
  });

  it('Hold pressed twice while the store computer is still being asked is ONE hold — one call, one basket', async () => {
    const box = await register();
    const sent: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const port: HeldBillsPort = {
      hold: async (body) => { sent.push(String(body['billId'])); await gate; return await box.hold({ laneId: 'lane-1', cashierId: 'u-cash', ...(body as { billId: unknown; lines: unknown }) }) as unknown as Record<string, unknown>; },
      list: async () => box.list('lane-1'), recall: async () => ({}), abandon: async () => ({}),
    };
    const till = bootPos({ laneId: 'lane-1', taxPercent: 0, heldBillsPort: port });
    till.signIn('u-cash');
    till.scan({ productId: 'p-dal', description: 'Toor dal 1kg', unitPriceMinor: 12_000, qty: 1 });
    const a = till.holdAtTill();
    const b = till.holdAtTill();
    release();
    expect(await a).toMatchObject({ ok: true });
    expect(await b).toMatchObject({ ok: true });
    expect(sent).toHaveLength(1);
    expect(box.list('lane-1')).toHaveLength(1);
    await box.close();
  });

  it('a DIFFERENT basket after an unanswered hold gets its own id (never parked under the first basket\'s id)', async () => {
    const box = await register();
    const { port, sent } = writesButSaysNothing(box, 1);
    const till = bootPos({ laneId: 'lane-1', taxPercent: 0, heldBillsPort: port });
    till.signIn('u-cash');
    till.scan({ productId: 'p-dal', description: 'Toor dal 1kg', unitPriceMinor: 12_000, qty: 1 });
    await till.holdAtTill();
    till.scan({ productId: 'p-oil', description: 'Sunflower oil 1L', unitPriceMinor: 18_000, qty: 1 });
    expect(await till.holdAtTill()).toMatchObject({ ok: true });
    expect(sent[1]).not.toBe(sent[0]);
    await box.close();
  });

  it('the held list the store computer did not give is said, not shown as "none on hold"', async () => {
    const till = bootPos({
      laneId: 'lane-1', taxPercent: 0,
      heldBillsPort: { hold: async () => ({}), recall: async () => ({}), abandon: async () => ({}), list: async () => { throw new HeldListNotKnownError(LANE_NO_ANSWER, NO_ANSWER_WORDS.list.en, NO_ANSWER_WORDS.list.ta); } },
    });
    await expect(till.heldAtTill()).rejects.toMatchObject({ laneMessage: NO_ANSWER_WORDS.list.en, laneMessageTa: NO_ANSWER_WORDS.list.ta });
  });

  it('RECALL and GIVE UP with no answer in time say they do not know — never "recalled" or "given up"', async () => {
    const till = bootPos({
      laneId: 'lane-1', taxPercent: 0,
      heldBillsPort: {
        hold: async () => ({}), list: async () => [],
        recall: async () => ({ refusedBecause: LANE_NO_ANSWER, laneMessage: NO_ANSWER_WORDS.recall.en, laneMessageTa: NO_ANSWER_WORDS.recall.ta }),
        abandon: async () => ({ refusedBecause: LANE_NO_ANSWER, laneMessage: NO_ANSWER_WORDS.abandon.en, laneMessageTa: NO_ANSWER_WORDS.abandon.ta }),
      },
    });
    till.signIn('u-cash');
    expect(await till.recallAtTill('H-1')).toMatchObject({ ok: false, refusedBecause: LANE_NO_ANSWER, laneMessage: NO_ANSWER_WORDS.recall.en, laneMessageTa: NO_ANSWER_WORDS.recall.ta });
    expect(till.basket()).toHaveLength(0);
    expect(await till.abandonAtTill('H-1', 'customer_left')).toMatchObject({ ok: false, refusedBecause: LANE_NO_ANSWER, laneMessageTa: NO_ANSWER_WORDS.abandon.ta });
  });

  it('a VOID whose answer ran out of wait: the line stays; pressed again it goes under the SAME activity id (recorded once)', async () => {
    const sent: string[] = [];
    let calls = 0;
    const till = bootPos({
      laneId: 'lane-1', taxPercent: 0,
      tillActivityPost: async (b) => {
        sent.push(String(b['activityId']));
        calls += 1;
        if (calls === 1) throw new LaneNoAnswerError('/lane/till-activity', 300);
        return { recorded: true };
      },
    });
    till.signIn('u-cash');
    till.scan({ productId: 'p-dal', description: 'Toor dal 1kg', unitPriceMinor: 12_000, qty: 1 });
    const line = till.basket()[0]!.lineId;
    const first = await till.voidAtTill(line, 'customer_changed_mind');
    expect(first).toMatchObject({ ok: false, refusedBecause: LANE_NO_ANSWER, laneMessage: NO_ANSWER_WORDS.activity.en, laneMessageTa: NO_ANSWER_WORDS.activity.ta });
    expect(sent).toHaveLength(1); // not asked twice behind the cashier's back — one wait, then the words
    expect(till.basket().filter((l) => !l.voided)).toHaveLength(1);
    expect(await till.voidAtTill(line, 'customer_changed_mind')).toMatchObject({ ok: true });
    expect(sent).toEqual([sent[0], sent[0]]);
  });

  it('a coupon and a gift card the store computer did not answer in time: said in English and Tamil; nothing changed on the bill', async () => {
    const box = await silentBox();
    const till = bootPos({ laneId: 'lane-1', taxPercent: 0, lanePort: box.port, laneAnswerWaitMs: 200 });
    till.signIn('u-cash');
    till.scan({ productId: 'p-dal', description: 'Toor dal 1kg', unitPriceMinor: 12_000, qty: 1 });
    const before = till.payableMinor();
    expect(await till.couponAtTill('DIWALI50')).toMatchObject({ ok: false, refusedBecause: LANE_NO_ANSWER, laneMessage: NO_ANSWER_WORDS.check.en, laneMessageTa: NO_ANSWER_WORDS.check.ta });
    expect(await till.giftCardBalance('GC-1234-5678')).toMatchObject({ ok: false, refusedBecause: LANE_NO_ANSWER });
    expect(till.payableMinor()).toBe(before);
    expect(box.calls).toEqual(['POST /lane/coupons/check', 'POST /lane/gift-cards/balance']);
  }, 8_000);

  it('a card/UPI attempt, a sign-in and a manager approval are bounded the same way — each asked once', async () => {
    const box = await silentBox();
    const till = bootPos({ laneId: 'lane-1', taxPercent: 0, lanePort: box.port, laneAnswerWaitMs: 200 });
    expect(await till.signInAtTill({ staffId: 'u-cash', pin: '1234' })).toMatchObject({ signedIn: false, refusedBecause: LANE_NO_ANSWER, laneMessageTa: NO_ANSWER_WORDS.signIn.ta });
    till.signIn('u-cash');
    till.scan({ productId: 'p-dal', description: 'Toor dal 1kg', unitPriceMinor: 12_000, qty: 1 });
    expect(await till.startCardPayment('card')).toMatchObject({ ok: false, refusedBecause: LANE_NO_ANSWER, laneMessage: NO_ANSWER_WORDS.payment.en, laneMessageTa: NO_ANSWER_WORDS.payment.ta });
    expect(await till.checkCardPayment('PAY-1')).toMatchObject({ ok: false, refusedBecause: LANE_NO_ANSWER });
    expect(await till.approveAtTill({ managerId: 'u-mgr', pin: '9999', kind: 'no_sale', valueMinor: 0, reason: 'change' })).toMatchObject({ approved: false, refusedBecause: LANE_NO_ANSWER });
    // One call each: a call that ran out of wait is not asked again behind the cashier's back.
    expect(box.calls.filter((c) => c.includes('payment-attempts'))).toHaveLength(2);
  }, 8_000);
});
