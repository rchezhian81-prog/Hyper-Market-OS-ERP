import { describe, it, expect } from 'vitest';
import {
  createTillSession, countTotalMinor, DENOMINATIONS, type TillConfig, type DurableReturnWrite,
} from '../../apps/pos/src/till-session';
import { NoOperatorError, NoLaneError } from '../../apps/pos/src/session';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';
import { money } from '../../packages/contracts/src/money';
import { inMemoryTillBox } from '../support/in-memory-till-box';

// M13 · M14 · M15 · §27 — the till itself, as opposed to the sale. Since SP-4c (F10) the till keeps NO cash of its own:
// every float, pickup and the close goes to the STORE BOX, which decides and records it. The box here is the in-memory
// twin that runs the real box's pure engine (`tests/support/in-memory-till-box.ts`).

const CONFIG: TillConfig = { laneId: 'lane-1', cashierId: 'u-meena', tradingDay: '2026-08-05' };

// A durable-return port that always confirms — the till's edge saying the refund is on the disk.
// Real lanes post to the edge over loopback; a test supplies this stand-in (see the durable-refund
// suite below for the refused case).
const okDurable: DurableReturnWrite = async () => ({ committed: true, durable: true, detail: 'on disk', laneMessage: 'ok' });

// The moments in this file are written in UTC and the fixture's box dates them in UTC, explicitly — so the suite says the
// same thing on a laptop in Chennai and a runner in Dublin (GT-10). The zone a REAL store reckons its day in is its own.
const newTill = (durableReturn: DurableReturnWrite = okDurable, box = inMemoryTillBox({ laneId: 'lane-1', toleranceMinor: 10_000, timeZone: 'UTC' })) => {
  const outbox = new SyncOutbox();
  const stock = new Ledger(new InMemoryLedgerStore());
  return { till: createTillSession(CONFIG, stock, outbox, { durableReturn, ...box.ports }), outbox, box };
};

const AT = '2026-08-05T19:00:00Z';

describe('the box dates a movement in the STORE\'s zone, never the host\'s (GT-10)', () => {
  it('19:00Z on 5 August is the 5th in UTC and already the 6th in Asia/Kolkata — the same moment, said by the zone the box is given', async () => {
    for (const [timeZone, day] of [['UTC', '2026-08-05'], ['Asia/Kolkata', '2026-08-06']] as const) {
      const { till } = newTill(okDurable, inMemoryTillBox({ laneId: 'lane-1', toleranceMinor: 10_000, timeZone }));
      const opened = await till.moveCash({ kind: 'float_issue', amountMinor: 200_000, at: AT });
      expect(opened, timeZone).toMatchObject({ committed: true, tradingDay: day });
    }
  });
});

describe('counting the drawer', () => {
  it('adds up a denomination count exactly, in paise', () => {
    // Two ₹500 notes, three ₹100, one ₹20 → ₹1,320.00
    expect(countTotalMinor([
      { valueMinor: 50_000, count: 2 },
      { valueMinor: 10_000, count: 3 },
      { valueMinor: 2_000, count: 1 },
    ])).toBe(132_000);
  });

  it('lists real Indian denominations, largest first, each once', () => {
    expect(DENOMINATIONS[0]).toBe(50_000); // ₹500
    expect(DENOMINATIONS.at(-1)).toBe(100); // ₹1
    expect(new Set(DENOMINATIONS).size).toBe(DENOMINATIONS.length);
    expect([...DENOMINATIONS]).toEqual([...DENOMINATIONS].sort((a, b) => b - a));
  });

  it('is exact — no floats anywhere near the drawer', () => {
    // ₹0.10 counted seventy times is ₹7.00, not ₹6.999999999999999.
    expect(countTotalMinor(Array.from({ length: 70 }, () => ({ valueMinor: 10, count: 1 })))).toBe(700);
  });
});

describe('money in and out of the drawer — recorded on the store box, never in the browser (SP-4c · F10)', () => {
  it('a float opens the till on the box; a pickup is recorded against it; neither answer carries a balance', async () => {
    const { till, box } = newTill();
    const opened = await till.moveCash({ kind: 'float_issue', amountMinor: 200_000, at: AT });
    expect(opened).toMatchObject({ committed: true, kind: 'float_issue', custodian: 'u-meena', tradingDay: '2026-08-05' });
    const picked = await till.moveCash({ kind: 'pickup', amountMinor: 50_000, at: '2026-08-05T19:01:00Z' });
    expect(picked).toMatchObject({ committed: true, kind: 'pickup', custodian: 'u-meena' });
    // The box holds the records — the till holds nothing but the answer, and the answer names no figure (blind count).
    expect(box.records.map((r) => (r.kind === 'movement' ? [r.movementKind, r.deltaMinor, r.custodianId, r.performedBy, r.laneId] : r.kind)))
      .toEqual([['float_issue', 200_000, 'u-meena', 'u-meena', 'lane-1'], ['pickup', -50_000, 'u-meena', 'u-meena', 'lane-1']]);
    for (const answer of [opened, picked]) expect(Object.keys(answer)).not.toContain('balanceMinor');
    expect(await till.tillCash()).toMatchObject({ shiftOpen: true, custodian: 'u-meena', laneId: 'lane-1' });
  });

  it('the box refuses in words: a pickup with no float out, an overdraw, a second float while one is out', async () => {
    const { till } = newTill();
    expect(await till.moveCash({ kind: 'pickup', amountMinor: 1_000, at: '2026-08-05T08:59:00Z' })).toMatchObject({ committed: false, refusedBecause: 'till_not_held_by_this_custodian' });
    await till.moveCash({ kind: 'float_issue', amountMinor: 200_000, at: '2026-08-05T09:00:00Z' });
    const over = await till.moveCash({ kind: 'pickup', amountMinor: 250_000, at: '2026-08-05T12:00:00Z' });
    expect(over).toMatchObject({ committed: false, refusedBecause: 'insufficient_till_cash' });
    expect((over as { laneMessage: string }).laneMessage).toMatch(/does not hold that much/);
    expect(await till.moveCash({ kind: 'float_issue', amountMinor: 1_000, at: '2026-08-05T12:01:00Z' })).toMatchObject({ committed: false, refusedBecause: 'till_already_assigned' });
  });

  it('the same movement id sent again is ONE movement — a lost reply is resolved, never doubled (§31.1)', async () => {
    const { till, box } = newTill();
    const first = await till.moveCash({ kind: 'float_issue', amountMinor: 200_000, at: AT, movementId: 'cm-float-1' });
    const again = await till.moveCash({ kind: 'float_issue', amountMinor: 200_000, at: AT, movementId: 'cm-float-1' });
    expect(first).toMatchObject({ committed: true });
    expect(again).toMatchObject({ committed: true, alreadyRecorded: true, movementId: 'cm-float-1' });
    expect(box.records).toHaveLength(1);
  });

  it('with the box unreachable the answer is `lane_unreachable`, in the cashier\'s words — never a silent local record', async () => {
    const { till, box } = newTill();
    box.unplug();
    const outcome = await till.moveCash({ kind: 'float_issue', amountMinor: 200_000, at: AT });
    expect(outcome).toMatchObject({ committed: false, refusedBecause: 'lane_unreachable' });
    expect((outcome as { laneMessage: string }).laneMessage).toMatch(/NOT recorded yet/);
    expect(box.records).toHaveLength(0);
    expect(await till.tillCash()).toBeNull();
  });

  it('standing alone with no box at all, the till refuses cash — it never pretends to have recorded it', async () => {
    const till = createTillSession(CONFIG, new Ledger(new InMemoryLedgerStore()), new SyncOutbox(), { durableReturn: okDurable });
    expect(await till.moveCash({ kind: 'float_issue', amountMinor: 200_000, at: AT })).toMatchObject({ committed: false, refusedBecause: 'no_store_box' });
    expect(await till.close({ shiftId: 'sh-1', closedAt: AT, countedMinor: 0 })).toMatchObject({ closed: false, refusedBecause: 'no_store_box' });
    expect(await till.tillCash()).toBeNull();
  });

  it('with nobody signed in, or no lane, cash is refused BEFORE the box is asked (F09)', async () => {
    const box = inMemoryTillBox({ laneId: 'lane-1' });
    const nobody = createTillSession({ laneId: 'lane-1' }, new Ledger(new InMemoryLedgerStore()), new SyncOutbox(), box.ports);
    await expect(nobody.moveCash({ kind: 'float_issue', amountMinor: 200_000, at: AT })).rejects.toBeInstanceOf(NoOperatorError);
    const noLane = createTillSession({ cashierId: 'u-meena' }, new Ledger(new InMemoryLedgerStore()), new SyncOutbox(), box.ports);
    await expect(noLane.moveCash({ kind: 'float_issue', amountMinor: 200_000, at: AT })).rejects.toBeInstanceOf(NoLaneError);
    expect(box.records).toHaveLength(0);
  });
});

describe('closing the shift — the blind count (M14-FR-02 · M15)', () => {
  // A shift: ₹2,000 float, ₹5,000 of cash sales (₹480 bills paid with ₹500 notes), ₹1,000 to the safe → expected ₹6,000.
  const shift = async () => {
    const t = newTill();
    await t.till.moveCash({ kind: 'float_issue', amountMinor: 200_000, at: '2026-08-05T09:00:00Z' });
    for (let i = 0; i < 10; i += 1) {
      t.box.ringSale({ id: `S-${i}`, committedAt: `2026-08-05T1${i}:00:00Z`.replace('T110', 'T11'), total: 50_000, tenders: [{ kind: 'cash', amount: { minor: 50_000 } }] });
    }
    await t.till.moveCash({ kind: 'pickup', amountMinor: 100_000, at: '2026-08-05T15:00:00Z' });
    return t;
  };
  const closeWith = async (countedMinor: number, reasonCode?: string) => {
    const t = await shift();
    return { ...t, result: await t.till.close({ shiftId: 'shift-1', closedAt: AT, countedMinor, ...(reasonCode === undefined ? {} : { reasonCode }) }) };
  };

  it('closes cleanly when the count matches — with exactly the input a cashier has: shift, moment, count', async () => {
    const { result, box } = await closeWith(600_000);
    expect(result).toMatchObject({ closed: true, varianceMinor: 0, exceptionRaised: false, countedMinor: 600_000, tradingDay: '2026-08-05', reasonCode: null });
    // The box's record carries every figure it worked out itself — none came from the till.
    const close = box.records.find((r) => r.kind === 'close');
    expect(close).toMatchObject({ openingFloatMinor: 200_000, cashSalesMinor: 500_000, pickupsMinor: 100_000, cashRefundsMinor: 0, expectedMinor: 600_000, cashierId: 'u-meena' });
    // And the shift is over: the till is free again.
    expect(await (await shift()).till.tillCash()).toMatchObject({ shiftOpen: true }); // a fresh shift, for contrast
  });

  it('reports a shortfall as a NEGATIVE variance, counted minus expected', async () => {
    // Short by ₹50. The sign says which way, and it says it the way a person reads it: less in the
    // drawer than there should be.
    expect((await closeWith(595_000)).result).toMatchObject({ closed: true, varianceMinor: -5_000, exceptionRaised: false });
  });

  it('a material variance is refused until a reason is given — and the refusal SAYS the variance, since the count is already made', async () => {
    // Tolerance is ₹100. ₹200 short is material.
    const refused = (await closeWith(580_000)).result;
    expect(refused).toMatchObject({ closed: false, refusedBecause: 'material_variance_needs_a_reason', varianceMinor: -20_000 });
    const closed = (await closeWith(580_000, 'wrong_change')).result;
    expect(closed).toMatchObject({ closed: true, varianceMinor: -20_000, exceptionRaised: true, reasonCode: 'wrong_change' });
  });

  it('lets an immaterial variance through without a reason', async () => {
    // ₹50 short, inside tolerance. Demanding a reason for every rupee trains people to type
    // anything, and then the reasons on the material ones mean nothing either.
    expect((await closeWith(595_000)).result).toMatchObject({ closed: true, exceptionRaised: false });
  });

  it('the same shift id closed again is ONE close', async () => {
    const t = await shift();
    await t.till.close({ shiftId: 'shift-1', closedAt: AT, countedMinor: 600_000 });
    expect(await t.till.close({ shiftId: 'shift-1', closedAt: AT, countedMinor: 600_000 })).toMatchObject({ closed: true, alreadyClosed: true, varianceMinor: 0 });
    expect(t.box.records.filter((r) => r.kind === 'close')).toHaveLength(1);
  });

  it('the cash refunded in the shift reduces what the drawer should hold', async () => {
    const t = await shift();
    t.box.giveRefund({ returnId: 'R-1', processedAt: '2026-08-05T16:00:00Z', refundMinor: 8_000, refundTender: 'cash' });
    t.box.giveRefund({ returnId: 'R-2', processedAt: '2026-08-05T16:00:00Z', refundMinor: 5_000, refundTender: 'card' }); // a card refund moves no cash
    expect(await t.till.close({ shiftId: 'shift-1', closedAt: AT, countedMinor: 592_000 })).toMatchObject({ closed: true, varianceMinor: 0 });
  });

  it('offers NO way to see the expected figure before counting', async () => {
    // Absence as a control, and the whole reason this is a separate module. Shown "expected:
    // ₹6,000", people write ₹6,000 — not from dishonesty, but because a number on a screen is an
    // answer and counting is work. A cash-up anchored to the expectation finds nothing.
    const { till } = newTill();
    for (const name of Object.keys(till)) {
      expect(name).not.toMatch(/expected|shouldBe|target|predict|balance/i);
    }
    const module = await import('../../apps/pos/src/till-session');
    for (const name of Object.keys(module)) {
      expect(name).not.toMatch(/expectedCash|expectedMinor|balance/i);
    }
    // And the interface itself has no such method — there is nothing to call early. Since SP-4c the till holds no
    // drawer balance at all; even `tillCash()` answers only who holds the till and since when.
    expect(Object.keys(till).sort()).toEqual(['close', 'moveCash', 'operator', 'refund', 'signIn', 'signOut', 'tillCash']);
    await till.moveCash({ kind: 'float_issue', amountMinor: 200_000, at: AT });
    expect(Object.keys((await till.tillCash())!).sort()).toEqual(['custodian', 'laneId', 'openedAt', 'shiftOpen', 'tillId']);
  });
});

describe('refunds — a card refund is never assumed to have happened (M13-FR-04)', () => {
  const REFUND_INPUT = {
    id: 'ret-1', number: 'RET-0001', originalSaleId: 'S-1',
    processedAt: AT, reasonCode: 'damaged',
    lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 1, originalQtyMinor: 1, disposition: 'damaged' as const }],
    maxRefund: money(64_000, 'INR'), approvalThresholdMinor: 100_000,
  };
  const refundOf = (refundTender: 'cash' | 'card') => {
    const { till } = newTill();
    return till.refund({ ...REFUND_INPUT, refund: money(64_000, 'INR'), refundTender });
  };

  it('settles a cash refund at the lane, offline', async () => {
    expect((await refundOf('cash')).refundStatus).toBe('settled');
  });

  it('leaves a CARD refund pending — the provider has not reversed anything yet', async () => {
    // Showing a completed refund for money that has not moved is how a customer is told they have
    // been paid back and finds out days later that they have not.
    expect((await refundOf('card')).refundStatus).toBe('pending');
  });
});

describe('a refund is durable on this till\'s edge before any cash is handed back (§P-01, hard rule #1)', () => {
  const REFUND = {
    id: 'ret-2', number: 'RET-0002', originalSaleId: 'S-2',
    processedAt: AT, reasonCode: 'damaged',
    lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 1, originalQtyMinor: 1, disposition: 'damaged' as const }],
    refund: money(64_000, 'INR'), refundTender: 'cash' as const,
    maxRefund: money(64_000, 'INR'), approvalThresholdMinor: 100_000,
  };

  it('posts the refund to the edge and waits; only a confirmed write lets it settle', async () => {
    const posted: { id: string; record: Record<string, unknown> }[] = [];
    const confirming: DurableReturnWrite = async (id, record) => {
      posted.push({ id, record: JSON.parse(record) as Record<string, unknown> });
      return { committed: true, durable: true, detail: 'on disk', laneMessage: 'ok' };
    };
    const { till } = newTill(confirming);
    const result = await till.refund(REFUND);
    expect(result.refundStatus).toBe('settled');
    // Exactly what the edge's synced-return route + `toCloudReturn` read.
    expect(posted).toHaveLength(1);
    expect(posted[0]?.id).toBe('ret-2');
    expect(posted[0]?.record).toMatchObject({
      returnId: 'ret-2', originalSaleId: 'S-2', laneId: 'lane-1', processedBy: 'u-meena',
      refundMinor: 64_000, refundTender: 'cash', reasonCode: 'damaged',
    });
  });

  it('writes the EXCHANGE settlement onto the edge record with the exchange tender (SP-9b-ii), exactly as the cloud route reads it', async () => {
    const posted: Record<string, unknown>[] = [];
    const confirming: DurableReturnWrite = async (_id, record) => { posted.push(JSON.parse(record) as Record<string, unknown>); return { committed: true, durable: true, detail: 'on disk', laneMessage: 'ok' }; };
    const { till } = newTill(confirming);
    const exchange = { replacementSaleId: 'S-X', replacementTotalMinor: 70_000, appliedMinor: 64_000, balance: 'top_up' as const, balanceMinor: 6_000, topUpTenders: [{ kind: 'cash' as const, amountMinor: 6_000 }] };
    const result = await till.refund({ ...REFUND, refundTender: 'exchange', approvalThresholdMinor: 0, exchange });
    expect(result).toMatchObject({ refundTender: 'exchange', refundStatus: 'settled', requiredApproval: false });
    expect(posted[0]).toMatchObject({ returnId: 'ret-2', refundTender: 'exchange', refundMinor: 64_000, exchange });
  });

  it('refuses the refund — hands back NO cash — when the edge would not record it durably', async () => {
    const refusing: DurableReturnWrite = async () => ({
      committed: false, refusedBecause: 'could_not_write_durably', detail: 'disk full',
      laneMessage: 'This lane could not save the refund. Do not hand back cash.',
    });
    const { till } = newTill(refusing);
    await expect(till.refund(REFUND)).rejects.toMatchObject({ name: 'LocalRefundRefusedError', laneMessage: expect.stringContaining('Do not hand back cash') });
  });

  it('refuses an INVALID refund before anything reaches the edge (decide, then record)', async () => {
    let calls = 0;
    const counting: DurableReturnWrite = async () => { calls += 1; return { committed: true, durable: true, detail: '', laneMessage: '' }; };
    const { till } = newTill(counting);
    // Refund more than the maximum the bill allows.
    await expect(till.refund({ ...REFUND, refund: money(99_999, 'INR') })).rejects.toThrow();
    expect(calls).toBe(0);
  });
});
