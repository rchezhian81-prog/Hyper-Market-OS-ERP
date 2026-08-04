import { describe, it, expect } from 'vitest';
import {
  dispatchTransfer,
  receiveTransfer,
  proposeAllocation,
  TransferRefusedError,
  type AvailableLot,
  type Transfer,
} from '../../packages/warehouse/src/index';
import { projectStock, availableToSell, quantityInState } from '../../packages/stock/src/index';
import { money } from '../../packages/contracts/src/money';

// M09-FR-03 — a transfer is the one movement that is in two places at once, which is
// exactly where shops lose it. The van is a place.

const INR = 'INR' as const;

const TRANSFER: Transfer = {
  transferId: 'tr-1',
  fromLocationId: 'warehouse',
  toLocationId: 'store-2',
  lines: [
    { productId: 'p-rice', batchId: 'B1', quantityMinor: 60, uom: 'ea', unitCost: money(4_000, INR) },
  ],
  state: 'approved',
  requestedBy: 'wh-1',
};

const AVAILABLE: AvailableLot[] = [
  { productId: 'p-rice', batchId: 'B1', quantityMinor: 200, state: 'on_hand' },
];

const APPROVAL = { subjectRef: 'tr-1', status: 'approved' as const, decidedBy: 'manager-1' };

describe('dispatch — in transit is visible and deliberately not sellable', () => {
  it('takes stock out of the source and puts it in transit AT THE DESTINATION', () => {
    const { transfer, movements } = dispatchTransfer({
      transfer: TRANSFER,
      approval: APPROVAL,
      available: AVAILABLE,
      at: '2026-08-06T08:00:00Z',
    });
    expect(transfer.state).toBe('in_transit');
    expect(movements).toHaveLength(2);

    const projection = projectStock(movements, { allowNegative: true });
    // The destination can SEE it coming...
    expect(quantityInState(projection, 'in_transit', 'p-rice')).toBe(60);
    // ...and cannot sell it. It exists in exactly one place: the van.
    expect(availableToSell(projection, 'p-rice', 'store-2')).toBe(0);
  });

  it('needs approval from someone other than the requester (§28)', () => {
    expect(() =>
      dispatchTransfer({ transfer: TRANSFER, available: AVAILABLE, at: '2026-08-06T08:00:00Z' }),
    ).toThrow(TransferRefusedError);
    expect(() =>
      dispatchTransfer({
        transfer: TRANSFER,
        approval: { ...APPROVAL, decidedBy: 'wh-1' },
        available: AVAILABLE,
        at: '2026-08-06T08:00:00Z',
      }),
    ).toThrow(/other than the person who requested it/);
  });

  it('never sends quarantined, expired, damaged or recalled stock to another branch', () => {
    for (const state of ['quarantine', 'expired', 'damaged'] as const) {
      expect(() =>
        dispatchTransfer({
          transfer: TRANSFER,
          approval: APPROVAL,
          available: [{ productId: 'p-rice', batchId: 'B1', quantityMinor: 200, state }],
          at: '2026-08-06T08:00:00Z',
        }),
      ).toThrow(/moves the problem, it does not solve it/);
    }
    expect(() =>
      dispatchTransfer({
        transfer: TRANSFER,
        approval: APPROVAL,
        available: [{ ...AVAILABLE[0]!, recalled: true }],
        at: '2026-08-06T08:00:00Z',
      }),
    ).toThrow(/recalled/);
  });

  it('refuses to send more than there is, and a transfer to the same place', () => {
    expect(() =>
      dispatchTransfer({
        transfer: TRANSFER,
        approval: APPROVAL,
        available: [{ ...AVAILABLE[0]!, quantityMinor: 10 }],
        at: '2026-08-06T08:00:00Z',
      }),
    ).toThrow(/only 10 of p-rice available/);
    expect(() =>
      dispatchTransfer({
        transfer: { ...TRANSFER, toLocationId: 'warehouse' },
        approval: APPROVAL,
        available: AVAILABLE,
        at: '2026-08-06T08:00:00Z',
      }),
    ).toThrow(/not a transfer/);
  });
});

describe('receipt — a shortfall is a valued exception, never a silent adjustment', () => {
  const dispatched = dispatchTransfer({
    transfer: TRANSFER,
    approval: APPROVAL,
    available: AVAILABLE,
    at: '2026-08-06T08:00:00Z',
  }).transfer;

  it('turns in-transit into on-hand for what arrived', () => {
    const result = receiveTransfer({
      transfer: dispatched,
      counted: [{ productId: 'p-rice', batchId: 'B1', quantityMinor: 60 }],
      receivedBy: 'store-2-mgr',
      at: '2026-08-06T14:00:00Z',
      currency: INR,
    });
    expect(result.transfer.state).toBe('received');
    expect(result.discrepancies).toEqual([]);
    expect(result.movements[0]?.from).toBe('in_transit');
    expect(result.movements[0]?.to).toBe('on_hand');
  });

  it('values what left and never arrived, and gives it an owner', () => {
    const result = receiveTransfer({
      transfer: dispatched,
      counted: [{ productId: 'p-rice', batchId: 'B1', quantityMinor: 52 }],
      receivedBy: 'store-2-mgr',
      at: '2026-08-06T14:00:00Z',
      currency: INR,
    });
    const gap = result.discrepancies[0];
    expect(gap?.differenceMinor).toBe(-8);
    expect(gap?.value).toEqual(money(32_000, INR)); // 8 × ₹40.00
    expect(gap?.detail).toContain('a miscount or a loss, and it needs an owner');

    // The missing 8 do not sit in transit for ever, and they are not absorbed:
    // they leave transit as a recorded shortfall carrying the exception above.
    const shortfall = result.movements.find((m) => m.movementId.includes('shortfall'));
    expect(shortfall?.quantityMinor).toBe(8);
    expect(shortfall?.reason).toContain('raised as an exception, not absorbed');
  });

  it('catches more arriving than was sent — the source count was wrong', () => {
    const result = receiveTransfer({
      transfer: dispatched,
      counted: [{ productId: 'p-rice', batchId: 'B1', quantityMinor: 65 }],
      receivedBy: 'store-2-mgr',
      at: '2026-08-06T14:00:00Z',
      currency: INR,
    });
    expect(result.discrepancies[0]?.detail).toContain('the source count was wrong');
    // Only what was actually dispatched can be received into stock.
    expect(result.movements[0]?.quantityMinor).toBe(60);
  });

  it('refuses to receive something that was never dispatched', () => {
    expect(() =>
      receiveTransfer({
        transfer: TRANSFER,
        counted: [],
        receivedBy: 'x',
        at: '2026-08-06T14:00:00Z',
        currency: INR,
      }),
    ).toThrow(/not in transit/);
  });
});

describe('allocation — advisory, and shared by days of cover', () => {
  it('gives everyone their shortfall when there is enough', () => {
    const proposals = proposeAllocation({
      productId: 'p-rice',
      fromLocationId: 'warehouse',
      availableMinor: 200,
      needs: [
        { locationId: 'store-1', productId: 'p-rice', shortfallMinor: 60, dailyDemandMinor: 5 },
        { locationId: 'store-2', productId: 'p-rice', shortfallMinor: 40, dailyDemandMinor: 50 },
      ],
    });
    expect(proposals.map((p) => p.quantityMinor)).toEqual([60, 40]);
    expect(proposals[0]?.detail).toContain('enough for everyone');
  });

  it('shares scarcity by rate of sale, not by raw shortfall', () => {
    // The trap: store-1 asks for more but sells 5 a day; store-2 sells 50.
    const proposals = proposeAllocation({
      productId: 'p-rice',
      fromLocationId: 'warehouse',
      availableMinor: 55,
      needs: [
        { locationId: 'store-1', productId: 'p-rice', shortfallMinor: 100, dailyDemandMinor: 5 },
        { locationId: 'store-2', productId: 'p-rice', shortfallMinor: 100, dailyDemandMinor: 50 },
      ],
    });
    const busy = proposals.find((p) => p.toLocationId === 'store-2');
    const quiet = proposals.find((p) => p.toLocationId === 'store-1');
    expect(busy!.quantityMinor).toBeGreaterThan(quiet!.quantityMinor);
    // Everything available is allocated — nothing is stranded by rounding.
    expect(proposals.reduce((s, p) => s + p.quantityMinor, 0)).toBe(55);
    expect(proposals[0]?.detail).toContain('similar days of cover');
  });

  it('reports days of cover, which is the reason for the split', () => {
    const proposals = proposeAllocation({
      productId: 'p-rice',
      fromLocationId: 'warehouse',
      availableMinor: 100,
      needs: [{ locationId: 'store-2', productId: 'p-rice', shortfallMinor: 100, dailyDemandMinor: 20 }],
    });
    expect(proposals[0]?.daysOfCover).toBe(5);
  });

  it('ignores locations that need nothing', () => {
    expect(
      proposeAllocation({
        productId: 'p-rice',
        fromLocationId: 'warehouse',
        availableMinor: 100,
        needs: [{ locationId: 'store-1', productId: 'p-rice', shortfallMinor: 0 }],
      }),
    ).toEqual([]);
  });
});
