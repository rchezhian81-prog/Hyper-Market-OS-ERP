import { describe, it, expect } from 'vitest';
import { dispatchTransfer, receiveTransfer, type Transfer } from '../../packages/warehouse/src/transfers';
import { dispatchPostings, receivePostings } from '../../services/inventory/src/warehouse-transfers';
import { countCorrection, countMovementId, priorCorrections, postedCorrections, type StoredReconciliation } from '../../services/inventory/src/counts';
import { checkMovement } from '../../services/inventory/src/index';

// SP-5 / SP-5b (audit findings F05, F06 · M08-FR-01/02/03 · M09-FR-03/04): the ONE authoritative effect each store
// operation posts to the M08 inventory projection — a transfer's dispatch and receipt, and a count's correction. These
// builders are what the routes append atomically with their own records; they are tested here as pure functions.

const AT = '2026-09-30T09:00:00.000Z';
const TRANSFER: Transfer = {
  transferId: 'T9', fromLocationId: 'WH', toLocationId: 'FLOOR', state: 'proposed', requestedBy: 'u-buyer',
  lines: [
    { productId: 'P1', batchId: null, quantityMinor: 10, uom: 'EA', unitCost: { minor: 999, currency: 'INR' } }, // the proposer's figure — never used as the value
    { productId: 'P2', batchId: 'B7', quantityMinor: 4, uom: 'EA', unitCost: { minor: 999, currency: 'INR' } },
  ],
};
const AVAILABLE = [
  { productId: 'P1', batchId: null, quantityMinor: 50, state: 'on_hand' as const },
  { productId: 'P2', batchId: 'B7', quantityMinor: 50, state: 'on_hand' as const },
];

describe('a transfer posts ONE effect per step to the M08 ledger (SP-5, F05)', () => {
  const dispatched = dispatchTransfer({ transfer: TRANSFER, approval: { subjectRef: 'T9', status: 'approved', decidedBy: 'u-boss' }, available: AVAILABLE, at: AT });
  const withCosts: Transfer = { ...dispatched.transfer, lineCostsMinor: [250, null] }; // head office's WH average per line; P2 unvalued there

  it('dispatch posts a transferred_out per line at the SOURCE under the engine\'s own -out- id, entered by the dispatcher', () => {
    const posted = dispatchPostings(withCosts, dispatched.movements, 'u-boss');
    expect(posted).toEqual([
      { movementId: 'T9-out-1', productId: 'P1', locationId: 'WH', kind: 'transferred_out', quantityMinor: 10, uom: 'EA', occurredAt: AT, enteredBy: 'u-boss', reason: 'transfer T9 dispatched to FLOOR' },
      { movementId: 'T9-out-2', productId: 'P2', locationId: 'WH', kind: 'transferred_out', quantityMinor: 4, uom: 'EA', occurredAt: AT, enteredBy: 'u-boss', reason: 'transfer T9 dispatched to FLOOR', batchId: 'B7' },
    ]);
    // Nothing is posted on-hand at the destination at dispatch: the stock is on the van (in transit), not sellable there.
    expect(posted.some((m) => m.locationId === 'FLOOR')).toBe(false);
    for (const m of posted) expect(checkMovement(m).ok).toBe(true);
  });

  it('receipt posts a transferred_in at the DESTINATION for what ARRIVED, carrying the source cost by line; a shortfall posts nothing', () => {
    const received = receiveTransfer({
      transfer: withCosts, receivedBy: 'u-floor', at: AT, currency: 'INR',
      counted: [{ productId: 'P1', batchId: null, quantityMinor: 8 }, { productId: 'P2', batchId: 'B7', quantityMinor: 4 }],
    });
    const posted = receivePostings(received.transfer, received.movements, 'u-floor');
    expect(posted).toEqual([
      { movementId: 'T9-recv-1', productId: 'P1', locationId: 'FLOOR', kind: 'transferred_in', quantityMinor: 8, uom: 'EA', occurredAt: AT, enteredBy: 'u-floor', reason: 'transfer T9 received from WH', unitCostMinor: 250 },
      { movementId: 'T9-recv-2', productId: 'P2', locationId: 'FLOOR', kind: 'transferred_in', quantityMinor: 4, uom: 'EA', occurredAt: AT, enteredBy: 'u-floor', reason: 'transfer T9 received from WH', batchId: 'B7' },
    ]);
    // The 2 that never arrived are the engine's valued exception, not a movement: no `wasted`, no negative, nothing quiet.
    expect(received.discrepancies).toEqual([expect.objectContaining({ productId: 'P1', differenceMinor: -2 })]);
    expect(posted.map((m) => m.movementId)).not.toContain('T9-shortfall-1');
    // The same result posted again is the same movements — the ids are the transfer step's, so a retry collapses (§31.1).
    expect(receivePostings(received.transfer, received.movements, 'u-floor')).toEqual(posted);
  });

  it('a transfer whose source stock was never costed arrives without a cost — unvalued at the destination, never priced at a guess', () => {
    const uncosted: Transfer = { ...dispatched.transfer }; // no lineCostsMinor at all
    const received = receiveTransfer({ transfer: uncosted, receivedBy: 'u-floor', at: AT, currency: 'INR', counted: [{ productId: 'P1', batchId: null, quantityMinor: 10 }] });
    expect(receivePostings(received.transfer, received.movements, 'u-floor')[0]).not.toHaveProperty('unitCostMinor');
  });
});

const REC: StoredReconciliation = {
  countId: 'c-77', productId: 'P1', locationId: 'S1', binId: null, uom: 'EA', expectedMinor: 100, countedMinor: 97, varianceMinor: -3,
  valueMinor: 300, currency: 'INR', reasonCode: 'cycle_count', reconciled: false, adjusted: true, requiredApproval: false,
  counterId: 'u-counter', approvedBy: null, at: AT, pendingApproval: false, movementId: countMovementId('c-77'),
};

describe('a count correction is ONE compensating M08 movement (SP-5b, F06)', () => {
  it('missing stock posts `wasted`, found stock posts `adjusted`; the quantity is positive and the kind carries the sign', () => {
    const missing = countCorrection(REC)!;
    expect(missing.movement).toMatchObject({ movementId: 'count:c-77', productId: 'P1', locationId: 'S1', kind: 'wasted', quantityMinor: 3, uom: 'EA', occurredAt: AT, enteredBy: 'u-counter' });
    expect(missing.movement).not.toHaveProperty('approvedBy');
    expect(missing.movement.reason).toBe('count c-77 (cycle_count): counted 97, expected 100; immaterial under the tenant\'s count-approval threshold — no second approver required');
    expect(missing.bin).toBeUndefined();
    const found = countCorrection({ ...REC, countedMinor: 104, varianceMinor: 4 })!;
    expect(found.movement).toMatchObject({ kind: 'adjusted', quantityMinor: 4 });
  });

  it('an APPROVED held count names the approver and is dated at the decision; the ledger\'s own two-person rule holds', () => {
    const approved = countCorrection({ ...REC, requiredApproval: true, approvedBy: 'u-boss', decision: 'approved', decidedAt: '2026-09-30T10:00:00.000Z' })!;
    expect(approved.movement).toMatchObject({ approvedBy: 'u-boss', enteredBy: 'u-counter', occurredAt: '2026-09-30T10:00:00.000Z' });
    expect(approved.movement.reason).toContain('approved by u-boss');
    expect(checkMovement(approved.movement).ok).toBe(true);
  });

  it('a BIN count corrects the bin\'s occupancy too: out of the bin for stock missing, into it for stock found', () => {
    const bin = countCorrection({ ...REC, binId: 'BIN-A' })!;
    expect(bin.movement).toMatchObject({ locationId: 'S1', kind: 'wasted', quantityMinor: 3 });
    expect(bin.movement.reason).toContain('bin BIN-A');
    expect(bin.bin).toEqual({ commandId: 'count:c-77', movement: { movementId: 'count:c-77', productId: 'P1', locationId: 'BIN-A', batchId: null, from: 'on_hand', to: null, quantityMinor: 3, uom: 'EA', at: AT, reason: bin.movement.reason } });
    expect(countCorrection({ ...REC, binId: 'BIN-A', countedMinor: 102, varianceMinor: 2 })!.bin!.movement).toMatchObject({ from: null, to: 'on_hand', quantityMinor: 2 });
  });

  it('posts nothing for a match, a held or rejected count, or a record from before SP-5b (no unit / no movement id)', () => {
    expect(countCorrection({ ...REC, countedMinor: 100, varianceMinor: 0, adjusted: false, reconciled: true, movementId: null })).toBeUndefined();
    expect(countCorrection({ ...REC, adjusted: false, pendingApproval: true, movementId: null })).toBeUndefined();
    expect(countCorrection({ ...REC, adjusted: false, decision: 'rejected', movementId: null })).toBeUndefined();
    const legacy: StoredReconciliation = { ...REC, uom: undefined as unknown as string, movementId: undefined };
    expect(countCorrection(legacy)).toBeUndefined();
    // …and a legacy correction is still LAYERED on the position, while a posted one is never layered twice.
    expect(priorCorrections([legacy, REC])).toBe(-3);
    expect(postedCorrections([legacy, REC])).toBe(-3);
  });
});
