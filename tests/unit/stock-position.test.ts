import { describe, it, expect } from 'vitest';
import {
  projectStock,
  availableToSell,
  physicalStock,
  quantityInState,
  explainAvailability,
  sellableStates,
  NegativeStockError,
  NeverSellableStateError,
  InvalidMovementError,
  type StockMovement,
} from '../../packages/stock/src/index';

// M08-FR-02 / §6.2 — only truly sellable stock is available. Reserved, quarantined,
// damaged, expired and in-transit stock is visible but NOT sellable, and the
// position is always projected from movements, never stored.

const AT = '2026-08-01T10:00:00Z';

function mv(over: Partial<StockMovement> & { movementId: string }): StockMovement {
  return {
    productId: 'rice',
    locationId: 'store-1',
    batchId: null,
    from: null,
    to: 'on_hand',
    quantityMinor: 0,
    uom: 'each',
    at: AT,
    ...over,
  };
}

const RECEIVE_12 = mv({ movementId: 'm1', from: null, to: 'on_hand', quantityMinor: 12 });

describe('projectStock — availability derived from state (M08-FR-02)', () => {
  it('counts a plain goods receipt as available', () => {
    const projection = projectStock([RECEIVE_12]);
    expect(availableToSell(projection, 'rice')).toBe(12);
    expect(physicalStock(projection, 'rice')).toBe(12);
  });

  it('removes reserved stock from what a walk-in can buy (no oversell, §6.2)', () => {
    const projection = projectStock([
      RECEIVE_12,
      mv({ movementId: 'm2', from: 'on_hand', to: 'reserved', quantityMinor: 4 }),
    ]);
    // The acceptance test: an online reservation reduces what the shop can sell.
    expect(availableToSell(projection, 'rice')).toBe(8);
    // ...but the stock is still physically in the building.
    expect(physicalStock(projection, 'rice')).toBe(12);
  });

  it('never counts quarantined or expired stock as sellable', () => {
    const projection = projectStock([
      RECEIVE_12,
      mv({ movementId: 'm2', from: 'on_hand', to: 'quarantine', quantityMinor: 3 }),
      mv({ movementId: 'm3', from: 'on_hand', to: 'expired', quantityMinor: 2 }),
    ]);
    expect(availableToSell(projection, 'rice')).toBe(7);
    expect(quantityInState(projection, 'quarantine', 'rice')).toBe(3);
    expect(quantityInState(projection, 'expired', 'rice')).toBe(2);
  });

  it('shows in-transit stock without counting it as available at the destination', () => {
    const projection = projectStock([
      mv({ movementId: 'm1', from: null, to: 'in_transit', quantityMinor: 5, locationId: 'store-2' }),
    ]);
    expect(availableToSell(projection, 'rice', 'store-2')).toBe(0);
    expect(quantityInState(projection, 'in_transit')).toBe(5);
    // Not in the building yet, so not part of the physical count either.
    expect(physicalStock(projection, 'rice', 'store-2')).toBe(0);

    const arrived = projectStock([
      mv({ movementId: 'm1', from: null, to: 'in_transit', quantityMinor: 5, locationId: 'store-2' }),
      mv({ movementId: 'm2', from: 'in_transit', to: 'on_hand', quantityMinor: 5, locationId: 'store-2' }),
    ]);
    expect(availableToSell(arrived, 'rice', 'store-2')).toBe(5);
  });

  it('the 12-that-is-really-0 case, explained in words a manager can act on', () => {
    const projection = projectStock([
      RECEIVE_12,
      mv({ movementId: 'm2', from: 'on_hand', to: 'reserved', quantityMinor: 4 }),
      mv({ movementId: 'm3', from: 'on_hand', to: 'quarantine', quantityMinor: 3 }),
      mv({ movementId: 'm4', from: 'on_hand', to: 'expired', quantityMinor: 2 }),
      mv({ movementId: 'm5', from: 'on_hand', to: 'damaged', quantityMinor: 3 }),
    ]);
    expect(physicalStock(projection, 'rice')).toBe(12);
    expect(availableToSell(projection, 'rice')).toBe(0);
    expect(explainAvailability(projection, 'rice')).toBe(
      '0 available — 4 reserved, 3 quarantine, 3 damaged, 2 expired not sellable',
    );
  });

  it('tracks each batch and location separately, never as one lump', () => {
    const projection = projectStock([
      mv({ movementId: 'm1', batchId: 'B1', quantityMinor: 5 }),
      mv({ movementId: 'm2', batchId: 'B2', quantityMinor: 7 }),
      mv({ movementId: 'm3', batchId: 'B1', quantityMinor: 4, locationId: 'store-2' }),
    ]);
    expect(projection.positions).toHaveLength(3);
    expect(availableToSell(projection, 'rice', 'store-1')).toBe(12);
    expect(availableToSell(projection, 'rice', 'store-2')).toBe(4);
    expect(availableToSell(projection, 'rice')).toBe(16);
  });

  it('a sale takes stock out of the business and out of availability', () => {
    const projection = projectStock([
      RECEIVE_12,
      mv({ movementId: 'm2', from: 'on_hand', to: null, quantityMinor: 5 }),
    ]);
    expect(availableToSell(projection, 'rice')).toBe(7);
    expect(physicalStock(projection, 'rice')).toBe(7);
  });

  it('releases a reservation and a quarantine back to sellable', () => {
    const projection = projectStock([
      RECEIVE_12,
      mv({ movementId: 'm2', from: 'on_hand', to: 'reserved', quantityMinor: 4 }),
      mv({ movementId: 'm3', from: 'reserved', to: 'on_hand', quantityMinor: 4 }),
      mv({ movementId: 'm4', from: 'on_hand', to: 'quarantine', quantityMinor: 2 }),
      mv({ movementId: 'm5', from: 'quarantine', to: 'on_hand', quantityMinor: 2 }),
    ]);
    expect(availableToSell(projection, 'rice')).toBe(12);
  });
});

describe('projectStock — policy and integrity', () => {
  it('lets a tenant sell from a damaged-goods bin if it chooses to', () => {
    const movements = [
      RECEIVE_12,
      mv({ movementId: 'm2', from: 'on_hand', to: 'damaged', quantityMinor: 3 }),
    ];
    expect(availableToSell(projectStock(movements), 'rice')).toBe(9);
    const clearance = projectStock(movements, { sellableStates: ['on_hand', 'damaged'] });
    expect(availableToSell(clearance, 'rice')).toBe(12);
  });

  it('refuses to let any tenant make quarantined or expired stock sellable', () => {
    expect(() => sellableStates({ sellableStates: ['on_hand', 'quarantine'] })).toThrow(
      NeverSellableStateError,
    );
    expect(() => projectStock([RECEIVE_12], { sellableStates: ['expired'] })).toThrow(
      NeverSellableStateError,
    );
  });

  it('blocks a movement that would take stock negative (M08-FR-03 default)', () => {
    expect(() =>
      projectStock([RECEIVE_12, mv({ movementId: 'm2', from: 'on_hand', to: null, quantityMinor: 20 })]),
    ).toThrow(NegativeStockError);
  });

  it('when a tenant permits negative stock, it becomes a visible exception (P-08)', () => {
    const projection = projectStock(
      [RECEIVE_12, mv({ movementId: 'm2', from: 'on_hand', to: null, quantityMinor: 20 })],
      { allowNegative: true },
    );
    expect(projection.exceptions).toHaveLength(1);
    expect(projection.exceptions[0]?.quantityMinor).toBe(-8);
    expect(projection.exceptions[0]?.detail).toContain('someone must explain it');
    expect(availableToSell(projection, 'rice')).toBe(-8);
  });

  it('refuses a movement that is not a movement at all', () => {
    expect(() => projectStock([mv({ movementId: 'm1', quantityMinor: 0 })])).toThrow(InvalidMovementError);
    expect(() =>
      projectStock([mv({ movementId: 'm1', from: null, to: null, quantityMinor: 5 })]),
    ).toThrow(InvalidMovementError);
    expect(() =>
      projectStock([mv({ movementId: 'm1', from: 'on_hand', to: 'on_hand', quantityMinor: 5 })]),
    ).toThrow(InvalidMovementError);
  });

  it('gives the same answer every time it is replayed (hard rule #2)', () => {
    const movements = [
      RECEIVE_12,
      mv({ movementId: 'm2', from: 'on_hand', to: 'reserved', quantityMinor: 4 }),
    ];
    expect(projectStock(movements)).toEqual(projectStock(movements));
  });
});
