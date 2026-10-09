import { describe, it, expect } from 'vitest';
import {
  readTillCashRecord, foldTillCash, decideCashMovement, decideShiftClose, shiftFigures, cashIntoDrawer,
  toCloudCashMovement, toCloudShiftClose, tillCashEventFactory, DEFAULT_CASH_TOLERANCE_MINOR,
  type TillCashRecord, type TillCashMovementRecord,
} from '../../edge/store-edge/src/till-cash';

/**
 * **The till's cash, as the store box decides and records it (SP-4c · F10 · M14-FR-01 · M14-FR-02).**
 *
 * The pure half of the box's cash: how its log folds back into "who holds the till and since when", how a movement is
 * judged against that chain with the same guard head office runs, how the shift's figures are worked out from the box's
 * OWN records (the float and pickups here, the cash taken on the sale log, the cash refunded on the return log), how the
 * close is decided against the cashier's blind count, and how each record becomes the event head office receives — minted
 * identically live and on a restart, so a re-send dedupes.
 */

const LANE = 'lane-1';
const at = (h: number, m = 0): string => `2026-09-30T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
const state = (records: readonly TillCashRecord[]) => foldTillCash(records, LANE);

const float = (movementId: string, amountMinor: number, when: string, custodianId = 'u-meena'): TillCashMovementRecord => ({
  kind: 'movement', movementId, tillId: LANE, laneId: LANE, movementKind: 'float_issue', amountMinor, deltaMinor: amountMinor, currency: 'INR',
  custodianId, performedBy: custodianId, tradingDay: '2026-09-30', at: when,
});
const pickup = (movementId: string, amountMinor: number, when: string, custodianId = 'u-meena'): TillCashMovementRecord => ({
  ...float(movementId, amountMinor, when, custodianId), movementKind: 'pickup', deltaMinor: -amountMinor,
});

const sale = (id: string, committedAt: string, total: number, tenders: { kind: string; minor: number }[], laneId: string | undefined = LANE) => ({
  id, laneId, committedAt, total, tenders: tenders.map((t) => ({ kind: t.kind, amount: { minor: t.minor } })),
});

describe('the box folds its cash log into the till\'s state', () => {
  it('a float opens custody; a pickup reduces the movements balance; a close ends custody and restarts the chain', () => {
    const s1 = state([float('m1', 200_000, at(9))]);
    expect(s1).toMatchObject({ custodian: 'u-meena', balanceMinor: 200_000, openedAt: at(9) });
    const s2 = state([float('m1', 200_000, at(9)), pickup('m2', 50_000, at(12))]);
    expect(s2.balanceMinor).toBe(150_000);
    expect(s2.movementsSinceOpen.map((m) => m.movementId)).toEqual(['m1', 'm2']);
    const closed = decideShiftClose({
      state: s2, laneId: LANE, tradingDay: '2026-09-30', toleranceMinor: 10_000,
      request: { shiftId: 'sh-1', closedAt: at(20), cashierId: 'u-meena', countedMinor: 150_000 },
      figures: { openingFloatMinor: 200_000, pickupsMinor: 50_000, cashSalesMinor: 0, cashRefundsMinor: 0 },
    });
    expect(closed.ok).toBe(true);
    const s3 = state([float('m1', 200_000, at(9)), pickup('m2', 50_000, at(12)), (closed as { record: TillCashRecord }).record]);
    expect(s3).toMatchObject({ custodian: null, balanceMinor: 0, openedAt: null, movementsSinceOpen: [] });
    expect(s3.lastClose?.shiftId).toBe('sh-1');
    expect([...s3.movementIds]).toEqual(['m1', 'm2']);
    expect([...s3.shiftIds]).toEqual(['sh-1']);
  });

  it('the same movement twice on the log is one movement; another till\'s records are not this till\'s', () => {
    const twice = state([float('m1', 200_000, at(9)), float('m1', 200_000, at(9))]);
    expect(twice.balanceMinor).toBe(200_000);
    const other = { ...float('x1', 999, at(9)), tillId: 'lane-9', laneId: 'lane-9' };
    expect(state([other]).custodian).toBeNull();
  });

  it('reads its own records back strictly and refuses to repair anything else', () => {
    const rec = float('m1', 200_000, at(9));
    expect(readTillCashRecord(JSON.parse(JSON.stringify(rec)))).toEqual(rec);
    expect(readTillCashRecord({ kind: 'movement', movementId: 'm1' })).toBeUndefined();
    expect(readTillCashRecord({ ...rec, movementKind: 'bribe' })).toBeUndefined();
    expect(readTillCashRecord('not a record')).toBeUndefined();
    expect(readTillCashRecord({ kind: 'close', shiftId: 'sh-1' })).toBeUndefined();
  });
});

describe('a cash movement is judged against the till\'s own chain — the same guard head office runs', () => {
  const decide = (records: readonly TillCashRecord[], request: Parameters<typeof decideCashMovement>[0]['request'], tradingCashMinor = 0) =>
    decideCashMovement({ state: state(records), request, laneId: LANE, tradingDay: '2026-09-30', tradingCashMinor });
  const req = (movementId: string, movementKind: TillCashMovementRecord['movementKind'], amountMinor: number, custodianId = 'u-meena') =>
    ({ movementId, movementKind, amountMinor, at: at(10), custodianId, performedBy: custodianId });

  it('a float on a free till opens custody; a second float while it is held is refused', () => {
    const first = decide([], req('m1', 'float_issue', 200_000));
    expect(first.ok).toBe(true);
    expect(first.ok && first.record).toMatchObject({ kind: 'movement', tillId: LANE, laneId: LANE, deltaMinor: 200_000, custodianId: 'u-meena', tradingDay: '2026-09-30' });
    expect(first.ok && first.custodianAfter).toBe('u-meena');
    const second = decide([float('m1', 200_000, at(9))], req('m2', 'float_issue', 100_000, 'u-ravi'));
    expect(second).toMatchObject({ ok: false, refusedBecause: 'till_already_assigned' });
  });

  it('a pickup by somebody who does not hold the till is refused; by the holder it is a negative delta', () => {
    const held = [float('m1', 200_000, at(9))];
    expect(decide(held, req('m2', 'pickup', 50_000, 'u-ravi'))).toMatchObject({ ok: false, refusedBecause: 'till_not_held_by_this_custodian' });
    expect(decide([], req('m2', 'pickup', 50_000))).toMatchObject({ ok: false, refusedBecause: 'till_not_held_by_this_custodian' });
    const ok = decide(held, req('m2', 'pickup', 50_000));
    expect(ok.ok && ok.record.deltaMinor).toBe(-50_000);
  });

  it('a pickup larger than float + takings is an overdraw; the morning\'s cash sales make a big pickup legitimate', () => {
    const held = [float('m1', 200_000, at(9))];
    expect(decide(held, req('m2', 'pickup', 250_000))).toMatchObject({ ok: false, refusedBecause: 'insufficient_till_cash' });
    // ₹3,000 of cash sales since the float: a ₹2,500 pickup is the takings going to the safe, not an overdraw.
    expect(decide(held, req('m2', 'pickup', 250_000), 300_000).ok).toBe(true);
  });

  it('refuses a non-positive amount and a kind that is not a cash movement', () => {
    expect(decide([], req('m1', 'float_issue', 0))).toMatchObject({ ok: false, refusedBecause: 'amount_not_positive' });
    expect(decide([], req('m1', 'bribe' as never, 100))).toMatchObject({ ok: false, refusedBecause: 'not_a_cash_movement' });
  });
});

describe('the cash a sale puts in the drawer', () => {
  it('is the cash tendered less the change handed back, and nothing for a card sale', () => {
    expect(cashIntoDrawer(sale('S-1', at(10), 48_000, [{ kind: 'cash', minor: 50_000 }]))).toBe(48_000); // ₹500 on ₹480 → ₹20 change
    expect(cashIntoDrawer(sale('S-2', at(10), 48_000, [{ kind: 'card', minor: 48_000 }]))).toBe(0);
    // A split: ₹300 by card and ₹200 cash on a ₹480 bill — ₹20 change comes out of the cash.
    expect(cashIntoDrawer(sale('S-3', at(10), 48_000, [{ kind: 'card', minor: 30_000 }, { kind: 'cash', minor: 20_000 }]))).toBe(18_000);
    // The cloud's own shape is read too.
    expect(cashIntoDrawer({ totalMinor: 16_000, tenders: [{ kind: 'cash', amountMinor: 20_000 }] })).toBe(16_000);
    expect(cashIntoDrawer(undefined)).toBe(0);
  });
});

describe('the cash an EXCHANGE moves at the drawer (SP-9b-ii · M14-FR-02)', () => {
  it('counts only a balance refunded in cash as cash out; the credit never left the drawer, and a cash top-up came in on the replacement sale', () => {
    const figures = shiftFigures({
      state: state([float('m1', 100_000, at(9))]), laneId: LANE, closedAt: at(20),
      sales: [
        // The replacement sale on a top-up exchange: ₹700 paid with ₹640 of exchange credit and ₹60 cash → ₹60 into the drawer.
        sale('S-X1', at(10), 70_000, [{ kind: 'exchange_credit', minor: 64_000 }, { kind: 'cash', minor: 6_000 }]),
      ],
      returns: [
        // The returning half of that exchange: ₹640 credited, nothing out — refundTender 'exchange', balance top_up.
        { returnId: 'X1', laneId: LANE, processedAt: at(10), refundMinor: 64_000, refundTender: 'exchange', exchange: { balance: 'top_up', balanceMinor: 6_000, topUpTenders: [{ kind: 'cash', amountMinor: 6_000 }] } },
        // An exchange where the shop refunded a ₹40 balance in cash → ₹40 out, not the ₹640 credited.
        { returnId: 'X2', laneId: LANE, processedAt: at(11), refundMinor: 64_000, refundTender: 'exchange', exchange: { balance: 'refund', balanceMinor: 4_000, balanceTender: 'cash' } },
        // The same, refunded to a card: nothing out of the drawer.
        { returnId: 'X3', laneId: LANE, processedAt: at(12), refundMinor: 64_000, refundTender: 'exchange', exchange: { balance: 'refund', balanceMinor: 4_000, balanceTender: 'card' } },
        // A plain cash refund still counts in full.
        { returnId: 'R-9', laneId: LANE, processedAt: at(13), refundMinor: 8_000, refundTender: 'cash' },
      ],
    });
    expect(figures.cashSalesMinor).toBe(6_000);
    expect(figures.cashRefundsMinor).toBe(4_000 + 8_000);
  });
});

describe('the shift\'s figures come from what the BOX recorded, never from the till', () => {
  const opened = [float('m1', 200_000, at(9)), pickup('m2', 50_000, at(13)), { ...float('m3', 10_000, at(14)), movementKind: 'loan' as const }];

  it('float + loans open the drawer, pickups and drops empty it, the sale log says what cash came in, the return log what went back', () => {
    const figures = shiftFigures({
      state: state(opened), laneId: LANE, closedAt: at(20),
      sales: [
        sale('S-1', at(10), 48_000, [{ kind: 'cash', minor: 50_000 }]),          // ₹480 cash, ₹20 change
        sale('S-2', at(11), 30_000, [{ kind: 'card', minor: 30_000 }]),          // card — no cash
        sale('S-3', at(8), 99_900, [{ kind: 'cash', minor: 99_900 }]),           // BEFORE the float: not this shift
        sale('S-4', at(12), 20_000, [{ kind: 'cash', minor: 20_000 }], 'lane-9'), // another lane's sale
        sale('S-5', at(15), 16_000, [{ kind: 'cash', minor: 16_000 }], undefined), // an old record naming no lane: this lane's
      ],
      returns: [
        { returnId: 'R-1', laneId: LANE, processedAt: at(16), refundMinor: 8_000, refundTender: 'cash' },
        { returnId: 'R-2', laneId: LANE, processedAt: at(16), refundMinor: 5_000, refundTender: 'card' },
        { returnId: 'R-3', laneId: LANE, processedAt: at(7), refundMinor: 5_000, refundTender: 'cash' }, // before the float
      ],
    });
    expect(figures).toEqual({ openingFloatMinor: 210_000, pickupsMinor: 50_000, cashSalesMinor: 64_000, cashRefundsMinor: 8_000 });
  });

  it('a till with no float has an empty window: nothing counts', () => {
    expect(shiftFigures({ state: state([]), laneId: LANE, closedAt: at(20), sales: [sale('S-1', at(10), 100, [{ kind: 'cash', minor: 100 }])], returns: [] }))
      .toEqual({ openingFloatMinor: 0, pickupsMinor: 0, cashSalesMinor: 0, cashRefundsMinor: 0 });
  });
});

describe('the close is decided against the blind count with the same rule head office runs', () => {
  const held = state([float('m1', 200_000, at(9)), pickup('m2', 50_000, at(13))]);
  const figures = { openingFloatMinor: 200_000, pickupsMinor: 50_000, cashSalesMinor: 64_000, cashRefundsMinor: 8_000 }; // expected 206,000
  const close = (countedMinor: number, over: Partial<{ reasonCode: string; cashierId: string; toleranceMinor: number | undefined; state: typeof held }> = {}) =>
    decideShiftClose({
      state: over.state ?? held, laneId: LANE, tradingDay: '2026-09-30', figures,
      toleranceMinor: 'toleranceMinor' in over ? over.toleranceMinor : 10_000,
      request: { shiftId: 'sh-1', closedAt: at(20), cashierId: over.cashierId ?? 'u-meena', countedMinor, ...(over.reasonCode === undefined ? {} : { reasonCode: over.reasonCode }) },
    });

  it('balanced: the record carries every figure, the window, the day and the tolerance it was judged by', () => {
    const d = close(206_000);
    expect(d.ok).toBe(true);
    expect(d.ok && d.record).toMatchObject({
      kind: 'close', shiftId: 'sh-1', tillId: LANE, laneId: LANE, cashierId: 'u-meena', tradingDay: '2026-09-30', openedAt: at(9), closedAt: at(20),
      ...figures, countedMinor: 206_000, expectedMinor: 206_000, varianceMinor: 0, exceptionRaised: false, reasonCode: null, toleranceMinor: 10_000, toleranceKnown: true,
    });
  });

  it('a material short with no reason is refused and SAYS the variance — the count is already made, so the figure can no longer anchor it', () => {
    expect(close(180_000)).toMatchObject({ ok: false, refusedBecause: 'material_variance_needs_a_reason', varianceMinor: -26_000 });
    const withReason = close(180_000, { reasonCode: 'miscount' });
    expect(withReason.ok && withReason.record).toMatchObject({ varianceMinor: -26_000, exceptionRaised: true, reasonCode: 'miscount' });
  });

  it('an immaterial difference closes without a reason', () => {
    expect(close(201_000).ok && (close(201_000) as { record: { exceptionRaised: boolean } }).record.exceptionRaised).toBe(false);
  });

  it('only the custodian closes; no float means no shift; the count must be a whole amount', () => {
    expect(close(206_000, { cashierId: 'u-ravi' })).toMatchObject({ ok: false, refusedBecause: 'not_the_custodian' });
    expect(close(206_000, { state: state([]) })).toMatchObject({ ok: false, refusedBecause: 'no_open_shift' });
    expect(close(20.5)).toMatchObject({ ok: false, refusedBecause: 'count_not_a_whole_amount' });
    expect(close(-1)).toMatchObject({ ok: false, refusedBecause: 'count_not_a_whole_amount' });
  });

  it('PF-08: a note-by-note count that does not add up, or names a note that does not exist, is refused at the drawer', () => {
    const withNotes = (countedMinor: number, denominations: { denominationMinor: number; count: number }[]) => decideShiftClose({
      state: held, laneId: LANE, tradingDay: '2026-09-30', figures, toleranceMinor: 10_000,
      request: { shiftId: 'sh-1', closedAt: at(20), cashierId: 'u-meena', countedMinor, denominations },
    });
    // 4 × ₹500 + 6 × ₹10 = ₹2,060 — adds up: closes.
    expect(withNotes(206_000, [{ denominationMinor: 50_000, count: 4 }, { denominationMinor: 1_000, count: 6 }]).ok).toBe(true);
    // The notes add to ₹2,000 but ₹2,060 was declared.
    expect(withNotes(206_000, [{ denominationMinor: 50_000, count: 4 }])).toMatchObject({ ok: false, refusedBecause: 'denominations_do_not_add_up' });
    // A ₹300 note does not exist.
    expect(withNotes(30_000, [{ denominationMinor: 30_000, count: 1 }])).toMatchObject({ ok: false, refusedBecause: 'denominations_do_not_add_up' });
  });

  it('a pack that names no cash tolerance makes the box apply its default AND say so', () => {
    const d = close(206_000, { toleranceMinor: undefined });
    expect(d.ok && d.record).toMatchObject({ toleranceMinor: DEFAULT_CASH_TOLERANCE_MINOR, toleranceKnown: false });
  });
});

describe('a record becomes the event head office receives — the same event live and on a restart', () => {
  const factory = tillCashEventFactory('t-sre');
  it('a movement → CashMovement on the till\'s own movement id; a close → TillClosed on the shift id', () => {
    const m = float('m1', 200_000, at(9));
    const e = factory(JSON.stringify(m), 0)!;
    expect(e).toMatchObject({ id: 'edge-cash-m1', type: 'CashMovement', idempotencyKey: 'edge-cash-t-sre-m1', occurredAt: at(9), source: 'edge/lane' });
    expect(e.payload).toEqual(toCloudCashMovement(m));
    expect(e.payload).toMatchObject({ movementId: 'm1', tillId: LANE, laneId: LANE, kind: 'float_issue', amountMinor: 200_000, deltaMinor: 200_000, custodianId: 'u-meena', performedBy: 'u-meena', tradingDay: '2026-09-30', at: at(9) });

    const c = decideShiftClose({
      state: state([m]), laneId: LANE, tradingDay: '2026-09-30', toleranceMinor: 10_000,
      request: { shiftId: 'sh-1', closedAt: at(20), cashierId: 'u-meena', countedMinor: 200_000, denominations: [{ denominationMinor: 50_000, count: 4 }] },
      figures: { openingFloatMinor: 200_000, pickupsMinor: 0, cashSalesMinor: 0, cashRefundsMinor: 0 },
    });
    const record = (c as { record: TillCashRecord }).record;
    const ce = factory(JSON.stringify(record), 1)!;
    expect(ce).toMatchObject({ id: 'edge-shift-close-sh-1', type: 'TillClosed', idempotencyKey: 'edge-shift-close-t-sre-sh-1', occurredAt: at(20) });
    expect(ce.payload).toEqual(toCloudShiftClose(record as never));
    expect(ce.payload).toMatchObject({ shiftId: 'sh-1', tillId: LANE, cashierId: 'u-meena', expectedMinor: 200_000, varianceMinor: 0, toleranceKnown: true, denominations: [{ denominationMinor: 50_000, count: 4 }] });
    expect((ce.payload as Record<string, unknown>)['kind']).toBeUndefined();
  });

  it('minted twice from the same record, it is the same event — so a restart re-send dedupes at the cloud', () => {
    const m = JSON.stringify(float('m1', 200_000, at(9)));
    expect(factory(m, 0)).toEqual(factory(m, 7));
  });

  it('a record that does not read back is no event — the pipeline surfaces it as malformed, never repairs it', () => {
    expect(factory('not json', 0)).toBeUndefined();
    expect(factory(JSON.stringify({ kind: 'movement', movementId: 'm1' }), 0)).toBeUndefined();
  });
});

describe('the store computer\'s seal on who did it travels with the till\'s cash (ADR-0023 · PF-02)', () => {
  const operatorVerified = { userId: 'u-meena', via: 'pin', laneId: 'lane-1', seal: 'c'.repeat(64) };
  const movement: TillCashMovementRecord = {
    kind: 'movement', movementId: 'm-seal', tillId: 'lane-1', laneId: 'lane-1', movementKind: 'float_issue', amountMinor: 1000, deltaMinor: 1000,
    currency: 'INR', custodianId: 'u-meena', performedBy: 'u-meena', tradingDay: '2026-10-06', at: '2026-10-06T09:00:00.000Z', operatorVerified,
  };
  it('reads it back off the disk as written, and sends it to head office', () => {
    const back = readTillCashRecord(JSON.parse(JSON.stringify(movement)));
    expect(back).toMatchObject({ operatorVerified });
    expect(toCloudCashMovement(back as TillCashMovementRecord)).toMatchObject({ operatorVerified });
  });
  it('a record whose stamp is half there reads back without one — never a repaired stamp', () => {
    const half = { ...movement, operatorVerified: { userId: 'u-meena', via: 'pin' } };
    const back = readTillCashRecord(JSON.parse(JSON.stringify(half)));
    expect(back).toBeDefined();
    expect('operatorVerified' in (back as object)).toBe(false);
    expect('operatorVerified' in toCloudCashMovement(back as TillCashMovementRecord)).toBe(false);
  });
});
