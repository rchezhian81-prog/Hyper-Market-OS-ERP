import { describe, it, expect } from 'vitest';
import {
  suspendBill,
  resumeBill,
  abandonBill,
  staleBills,
  SerialisedSuspendedBillStore,
  type SuspendedLine,
  type SuspensionPolicy,
} from '../../packages/suspended-sales/src/suspended-bill';

// M12-FR-02 acceptance: "a suspended bill survives a lane restart and can be recalled".
// Everything else here exists because a parked bill is the shape of a double charge.

const LINES: SuspendedLine[] = [
  { lineId: 'l-1', productId: 'p-rice', description: 'Rice 5kg', unitPriceMinor: 45_000, quantityMinor: 1, uom: 'ea', taxBps: 500, voided: false },
  { lineId: 'l-2', productId: 'p-oil', description: 'Sunflower oil 1L', unitPriceMinor: 18_000, quantityMinor: 2, uom: 'ea', taxBps: 500, voided: false },
];

function park(
  store: SerialisedSuspendedBillStore,
  overrides: Partial<Parameters<typeof suspendBill>[0]> = {},
  policy: SuspensionPolicy = {},
) {
  return suspendBill(
    {
      billId: 'B-1',
      tenantId: 't-1',
      storeId: 'store-1',
      laneId: 'lane-1',
      cashierId: 'u-cashier-1',
      tradingDay: '2026-08-04',
      currency: 'INR',
      lines: LINES,
      at: '2026-08-04T10:00:00Z',
      ...overrides,
    },
    store,
    policy,
  );
}

describe('suspended bills — surviving the restart (M12-FR-02)', () => {
  it('parks a basket as serialised state', () => {
    const store = new SerialisedSuspendedBillStore();
    const result = park(store);
    expect(result.suspended).toBe(true);
    expect(result.bill?.state).toBe('suspended');
    expect(result.bill?.lines).toHaveLength(2);
  });

  it('SURVIVES A LANE RESTART — the whole point of the requirement', () => {
    const store = new SerialisedSuspendedBillStore();
    park(store);

    // The till reboots. Everything in memory is gone; only what was written survives.
    const onDisk = store.serialise();
    const afterRestart = SerialisedSuspendedBillStore.hydrate(onDisk);

    const recovered = afterRestart.get('B-1');
    expect(recovered?.billId).toBe('B-1');
    expect(recovered?.lines).toEqual(LINES);
    expect(recovered?.state).toBe('suspended');

    // And it can be resumed on the lane that comes back up.
    const resumed = resumeBill(
      { billId: 'B-1', byUserId: 'u-cashier-1', onLaneId: 'lane-1', storeId: 'store-1', at: '2026-08-04T10:20:00Z' },
      afterRestart,
    );
    expect(resumed.resumed).toBe(true);
    expect(resumed.bill?.lines).toEqual(LINES);
    expect(resumed.minutesParked).toBe(20);
  });

  it('refuses to park an empty basket, and parks only the live lines', () => {
    const store = new SerialisedSuspendedBillStore();
    const empty = park(store, {
      lines: [{ ...LINES[0]!, voided: true, voidReason: 'customer changed their mind' }],
    });
    expect(empty.suspended).toBe(false);
    expect(empty.outcome).toBe('empty_basket');

    const mixed = park(store, {
      lines: [LINES[0]!, { ...LINES[1]!, voided: true, voidReason: 'wrong size' }],
    });
    expect(mixed.suspended).toBe(true);
    // The voided line stays in the session's audit trail, not in the basket the
    // customer comes back to.
    expect(mixed.bill?.lines).toEqual([LINES[0]]);
  });

  it('refuses to park the same bill id twice', () => {
    const store = new SerialisedSuspendedBillStore();
    park(store);
    const again = park(store);
    expect(again.suspended).toBe(false);
    expect(again.outcome).toBe('already_exists');
    expect(again.detail).toContain('second copy of the same basket');
  });

  it('enforces the per-lane limit so one lane cannot hoard parked bills', () => {
    const store = new SerialisedSuspendedBillStore();
    for (let i = 1; i <= 3; i += 1) park(store, { billId: `B-${i}` }, { maxPerLane: 3 });
    const fourth = park(store, { billId: 'B-4' }, { maxPerLane: 3 });
    expect(fourth.suspended).toBe(false);
    expect(fourth.outcome).toBe('lane_limit_reached');
  });

  it('requires a reason when the tenant configures one', () => {
    const store = new SerialisedSuspendedBillStore();
    const noReason = park(store, {}, { reasonRequired: true });
    expect(noReason.outcome).toBe('reason_required');

    const withReason = park(store, { reason: 'customer went back for milk' }, { reasonRequired: true });
    expect(withReason.suspended).toBe(true);
    expect(withReason.bill?.reason).toBe('customer went back for milk');
  });
});

describe('resuming is a claim, not a read', () => {
  it('REFUSES THE SECOND RESUME — the double charge this exists to stop', () => {
    const store = new SerialisedSuspendedBillStore();
    park(store);

    const first = resumeBill(
      { billId: 'B-1', byUserId: 'u-cashier-1', onLaneId: 'lane-1', storeId: 'store-1', at: '2026-08-04T10:05:00Z' },
      store,
    );
    expect(first.resumed).toBe(true);

    const second = resumeBill(
      { billId: 'B-1', byUserId: 'u-cashier-2', onLaneId: 'lane-1', storeId: 'store-1', at: '2026-08-04T10:06:00Z' },
      store,
    );
    expect(second.resumed).toBe(false);
    expect(second.outcome).toBe('already_resumed');
    expect(second.detail).toContain('charge the customer twice');
    // And it names who already has it, so the second cashier can go and ask.
    expect(second.detail).toContain('u-cashier-1');
  });

  it('refuses another lane by default, and allows it when the tenant chooses to', () => {
    const store = new SerialisedSuspendedBillStore();
    park(store);

    const otherLane = resumeBill(
      { billId: 'B-1', byUserId: 'u-cashier-2', onLaneId: 'lane-2', storeId: 'store-1', at: '2026-08-04T10:05:00Z' },
      store,
    );
    expect(otherLane.resumed).toBe(false);
    expect(otherLane.outcome).toBe('other_lane');

    const allowed = resumeBill(
      { billId: 'B-1', byUserId: 'u-cashier-2', onLaneId: 'lane-2', storeId: 'store-1', at: '2026-08-04T10:05:00Z' },
      store,
      { allowCrossLaneRecall: true },
    );
    expect(allowed.resumed).toBe(true);
    expect(allowed.bill?.resumedOnLaneId).toBe('lane-2');
  });

  it('never lets a bill cross to another shop', () => {
    const store = new SerialisedSuspendedBillStore();
    park(store);
    const elsewhere = resumeBill(
      { billId: 'B-1', byUserId: 'u-x', onLaneId: 'lane-1', storeId: 'branch-2', at: '2026-08-04T10:05:00Z' },
      store,
      { allowCrossLaneRecall: true },
    );
    expect(elsewhere.resumed).toBe(false);
    expect(elsewhere.outcome).toBe('other_store');
  });

  it('resumes a stale bill but DEMANDS A RE-PRICE rather than charging old money', () => {
    const store = new SerialisedSuspendedBillStore();
    park(store);

    // Parked at 10:00, resumed at 18:30 — the lunchtime promotion has ended since.
    const late = resumeBill(
      { billId: 'B-1', byUserId: 'u-cashier-1', onLaneId: 'lane-1', storeId: 'store-1', at: '2026-08-04T18:30:00Z' },
      store,
      { repriceAfterMinutes: 240 },
    );
    // It still resumes — refusing would strand the customer at the counter.
    expect(late.resumed).toBe(true);
    expect(late.repriceRequired).toBe(true);
    expect(late.minutesParked).toBe(510);
    expect(late.detail).toContain('re-priced before tendering');
  });

  it('does not demand a re-price inside the window', () => {
    const store = new SerialisedSuspendedBillStore();
    park(store);
    const soon = resumeBill(
      { billId: 'B-1', byUserId: 'u-cashier-1', onLaneId: 'lane-1', storeId: 'store-1', at: '2026-08-04T11:30:00Z' },
      store,
      { repriceAfterMinutes: 240 },
    );
    expect(soon.repriceRequired).toBeUndefined();
  });

  it('refuses to resume a bill nobody parked', () => {
    const store = new SerialisedSuspendedBillStore();
    const missing = resumeBill(
      { billId: 'B-NOPE', byUserId: 'u-1', onLaneId: 'lane-1', storeId: 'store-1', at: '2026-08-04T10:05:00Z' },
      store,
    );
    expect(missing.outcome).toBe('not_found');
  });
});

describe('abandonment is evidence, not a delete (hard rule #6)', () => {
  it('keeps the record with who abandoned it and why', () => {
    const store = new SerialisedSuspendedBillStore();
    park(store);

    const noReason = abandonBill({ billId: 'B-1', byUserId: 'u-manager', reason: '  ', at: '2026-08-04T22:00:00Z' }, store);
    expect(noReason.abandoned).toBe(false);

    const done = abandonBill(
      { billId: 'B-1', byUserId: 'u-manager', reason: 'customer never returned', at: '2026-08-04T22:00:00Z' },
      store,
    );
    expect(done.abandoned).toBe(true);

    // Still there. Still readable. Still names the person.
    const kept = store.get('B-1');
    expect(kept?.state).toBe('abandoned');
    expect(kept?.abandonedBy).toBe('u-manager');
    expect(kept?.abandonReason).toBe('customer never returned');
    expect(kept?.lines).toEqual(LINES);
  });

  it('refuses to resume an abandoned bill', () => {
    const store = new SerialisedSuspendedBillStore();
    park(store);
    abandonBill({ billId: 'B-1', byUserId: 'u-manager', reason: 'end of day', at: '2026-08-04T22:00:00Z' }, store);
    const resumed = resumeBill(
      { billId: 'B-1', byUserId: 'u-cashier-1', onLaneId: 'lane-1', storeId: 'store-1', at: '2026-08-05T09:00:00Z' },
      store,
    );
    expect(resumed.resumed).toBe(false);
    expect(resumed.outcome).toBe('abandoned');
  });
});

describe('the parked-bill report the manager needs at close', () => {
  it('lists what is still on the lanes, oldest first, with its value', () => {
    const store = new SerialisedSuspendedBillStore();
    park(store, { billId: 'B-early', at: '2026-08-04T09:00:00Z' });
    park(store, { billId: 'B-late', at: '2026-08-04T20:30:00Z', laneId: 'lane-2' });
    park(store, { billId: 'B-gone', at: '2026-08-04T09:30:00Z', laneId: 'lane-3' });
    abandonBill({ billId: 'B-gone', byUserId: 'u-manager', reason: 'cleared', at: '2026-08-04T20:00:00Z' }, store);

    const report = staleBills(store, '2026-08-04T21:00:00Z', { repriceAfterMinutes: 240, abandonAfterMinutes: 600 });

    // The abandoned one is not "still on the lane" — it has been dealt with.
    expect(report.map((r) => r.billId)).toEqual(['B-early', 'B-late']);
    expect(report[0]?.minutesParked).toBe(720);
    // ₹450.00 + 2 × ₹180.00 = ₹810.00
    expect(report[0]?.valueMinor).toBe(81_000);
    expect(report[0]?.detail).toContain('nobody is coming back for it');
    expect(report[1]?.detail).toBe('parked 30 minutes');
  });
});
