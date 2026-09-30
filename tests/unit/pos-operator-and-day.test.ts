import { describe, it, expect } from 'vitest';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { NoOperatorError, NoLaneError } from '../../apps/pos/src/session';
import { inMemoryTillBox } from '../support/in-memory-till-box';

/**
 * **The till names who rang the sale, on which lane, on which day — or refuses (SP-4b · F09 · §28 · hard rule #4).**
 *
 * Before SP-4b `bootPos()` with no configuration wrote cashier `cashier`, lane `lane-1` and trading day `1970-01-01` on
 * every sale. Now the lane comes from the box, the cashier signs in, and the day is worked out at the moment the money
 * is taken, per the shop's cut-off — and where any of the three is missing the till refuses to take payment, in words.
 */

const written: Record<string, unknown>[] = [];
const durable = async (_id: string, record: string) => {
  written.push(JSON.parse(record) as Record<string, unknown>);
  return { committed: true as const, durable: true as const, detail: 'test', laneMessage: 'saved' };
};
const ring = (view: ReturnType<typeof bootPos>, saleId: string, at: string) => {
  view.scan({ productId: 'P1', description: 'Toor dal 1kg', unitPriceMinor: 16_000, qty: 1 });
  return view.tenderCash(saleId, `R-${saleId}`, at);
};

describe('who, where and which day on every sale', () => {
  it('refuses to take payment while nobody is signed in — in the cashier\'s words — and takes it once somebody is', async () => {
    written.length = 0;
    const view = bootPos({ laneId: 'lane-7', tradingDayCutoff: '02:00', durable });
    expect(view.operator()).toBeUndefined();
    await expect(ring(view, 'S-1', '2026-09-30T10:00:00.000Z')).rejects.toBeInstanceOf(NoOperatorError);
    await expect(ring(view, 'S-1', '2026-09-30T10:00:00.000Z')).rejects.toMatchObject({ laneMessage: expect.stringContaining('Sign in with your staff code') });
    expect(written).toHaveLength(0);

    view.signIn('u-meena');
    expect(view.operator()).toBe('u-meena');
    expect(await ring(view, 'S-1', '2026-09-30T10:00:00.000Z')).toBe('R-S-1');
    expect(written[0]).toMatchObject({ cashierId: 'u-meena', laneId: 'lane-7', tradingDay: '2026-09-30', committedAt: '2026-09-30T10:00:00.000Z' });
    // Nothing placeholder-shaped anywhere on the record.
    expect(JSON.stringify(written[0])).not.toMatch(/1970-01-01|"cashier"|lane-1/);
  });

  it('the till (drawer and close) follows the same person: refused while nobody is signed in, named once somebody is, refused again after sign-out', async () => {
    const box = inMemoryTillBox({ laneId: 'lane-7' });
    const view = bootPos({ laneId: 'lane-7', durable, ...box.ports });
    // Exactly what a cashier knows — which shift, when, what was counted (SP-4c · F10). The box works the rest out.
    const closing = { shiftId: 'SH-1', closedAt: '2026-09-30T14:00:00.000Z', countedMinor: 50_000 };
    expect(view.till.operator()).toBeUndefined();
    await expect(view.till.close(closing)).rejects.toBeInstanceOf(NoOperatorError);
    await expect(view.till.moveCash({ kind: 'float_issue', amountMinor: 50_000, at: '2026-09-30T09:00:00.000Z' })).rejects.toBeInstanceOf(NoOperatorError);
    view.signIn('u-meena');
    expect(view.till.operator()).toBe('u-meena');
    expect(view.operator()).toBe('u-meena');
    // Signed in: the float is recorded on the box in the cashier's name, and the close names them too.
    expect(await view.till.moveCash({ kind: 'float_issue', amountMinor: 50_000, at: '2026-09-30T09:00:00.000Z' })).toMatchObject({ committed: true, custodian: 'u-meena' });
    expect(await view.till.close(closing)).toMatchObject({ closed: true, varianceMinor: 0 });
    expect(box.records.map((r) => (r.kind === 'close' ? r.cashierId : r.custodianId))).toEqual(['u-meena', 'u-meena']);
    view.signOut();
    expect(view.till.operator()).toBeUndefined();
    await expect(view.till.close(closing)).rejects.toBeInstanceOf(NoOperatorError);
    // A till with a cashier but no lane refuses the close too — the lane is the box's word, never assumed.
    const noLane = bootPos({ cashierId: 'u-meena', durable, ...box.ports });
    await expect(noLane.till.close(closing)).rejects.toBeInstanceOf(NoLaneError);
    expect(box.records).toHaveLength(2);
  });

  it('a till the box never gave a lane refuses payment even with a cashier signed in', async () => {
    written.length = 0;
    const view = bootPos({ cashierId: 'u-meena', durable });
    expect(view.lane().laneId).toBeNull();
    await expect(ring(view, 'S-2', '2026-09-30T10:00:00.000Z')).rejects.toBeInstanceOf(NoLaneError);
    await expect(ring(view, 'S-2', '2026-09-30T10:00:00.000Z')).rejects.toMatchObject({ laneMessage: expect.stringContaining('no lane id') });
    expect(written).toHaveLength(0);
  });

  it('dates each sale at the moment it is taken, per the shop\'s cut-off — a till open past the cut-off moves to the new day by itself', async () => {
    written.length = 0;
    // The machine's zone is whatever CI runs in; ask the till what day each instant is and check the sale agrees.
    const view = bootPos({ laneId: 'lane-7', cashierId: 'u-meena', tradingDayCutoff: '02:00', durable });
    const before = '2026-09-30T20:00:00.000Z';
    const after = '2026-10-01T03:00:00.000Z';
    await ring(view, 'S-a', before);
    view.newSale();
    await ring(view, 'S-b', after);
    expect(written[0]?.['tradingDay']).toBe(view.lane().tradingDayAt(before));
    expect(written[1]?.['tradingDay']).toBe(view.lane().tradingDayAt(after));
    expect(written[1]?.['tradingDay']).not.toBe(written[0]?.['tradingDay']);
    // A fixed day (a test or replay) still wins when it is given explicitly.
    const fixed = bootPos({ laneId: 'lane-7', cashierId: 'u-meena', tradingDay: '2026-08-05', durable });
    await ring(fixed, 'S-c', after);
    expect(written[2]?.['tradingDay']).toBe('2026-08-05');
  });

  it('a blank staff code is not a sign-in', () => {
    const view = bootPos({ laneId: 'lane-7', durable });
    expect(() => view.signIn('   ')).toThrow(RangeError);
    expect(view.operator()).toBeUndefined();
  });
});
