import { describe, it, expect } from 'vitest';
import {
  transitionOrder,
  canCancel,
  isTerminal,
  InvalidOrderTransitionError,
  reserveStock,
  releaseReservation,
  reservedQty,
  availableToPromise,
  OversellError,
  InvalidReservationError,
  type OrderState,
} from '../../packages/orders/src/index';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';

// One order lifecycle across channels, and stock reservation that never oversells
// (M18-FR-01/02 / §6.2).

const AT = '2026-08-02T22:00:00Z';

describe('order lifecycle', () => {
  it('walks the happy path to delivered', () => {
    let state: OrderState = 'placed';
    for (const event of ['confirm', 'pick', 'pack', 'dispatch', 'deliver'] as const) {
      state = transitionOrder(state, event);
    }
    expect(state).toBe('delivered');
    expect(isTerminal(state)).toBe(true);
  });

  it('supports a pickup order collected at the store', () => {
    let state: OrderState = 'packed';
    state = transitionOrder(state, 'collect');
    expect(state).toBe('collected');
    expect(isTerminal(state)).toBe(true);
  });

  it('refuses an illegal transition', () => {
    expect(() => transitionOrder('placed', 'deliver')).toThrow(InvalidOrderTransitionError);
    expect(() => transitionOrder('delivered', 'cancel')).toThrow(InvalidOrderTransitionError);
  });

  it('allows cancellation up to packed but not after dispatch', () => {
    expect(canCancel('placed')).toBe(true);
    expect(canCancel('packed')).toBe(true);
    expect(canCancel('dispatched')).toBe(false);
  });
});

describe('stock reservation', () => {
  function newLedger() {
    return new Ledger(new InMemoryLedgerStore());
  }
  function reserve(id: string, productId: string, qty: number) {
    return { id, orderId: `ord-${id}`, productId, qty, at: AT, source: 'oms' };
  }

  it('reserves stock and reduces available-to-promise', () => {
    const ledger = newLedger();
    const outbox = new SyncOutbox();
    const result = reserveStock(reserve('r1', 'p1', 3), ledger, outbox, 10);
    expect(result.reservedQty).toBe(3);
    expect(result.availableToPromise).toBe(7);
    expect(outbox.pending()[0]?.event.type).toBe('StockReserved');
  });

  it('never oversells — refuses a reservation beyond available', () => {
    const ledger = newLedger();
    const outbox = new SyncOutbox();
    reserveStock(reserve('r1', 'p1', 8), ledger, outbox, 10); // 8 of 10 reserved
    expect(() => reserveStock(reserve('r2', 'p1', 5), ledger, outbox, 10)).toThrow(OversellError);
    expect(reservedQty(ledger, 'p1')).toBe(8); // unchanged
  });

  it('a walk-in sees reserved stock removed from availability', () => {
    const ledger = newLedger();
    const outbox = new SyncOutbox();
    reserveStock(reserve('r1', 'p1', 4), ledger, outbox, 10);
    expect(availableToPromise(ledger, 'p1', 10)).toBe(6); // walk-in can buy 6, not 10
  });

  it('releasing a reservation restores availability (cancellation)', () => {
    const ledger = newLedger();
    const outbox = new SyncOutbox();
    reserveStock(reserve('r1', 'p1', 4), ledger, outbox, 10);
    releaseReservation(reserve('r1', 'p1', 4), ledger, outbox);
    expect(reservedQty(ledger, 'p1')).toBe(0);
    expect(availableToPromise(ledger, 'p1', 10)).toBe(10);
  });

  it('rejects a non-positive reservation', () => {
    const ledger = newLedger();
    const outbox = new SyncOutbox();
    expect(() => reserveStock(reserve('r1', 'p1', 0), ledger, outbox, 10)).toThrow(
      InvalidReservationError,
    );
  });

  it('is idempotent on the reservation id (a replay does not double-reserve)', () => {
    const ledger = newLedger();
    const outbox = new SyncOutbox();
    reserveStock(reserve('r1', 'p1', 3), ledger, outbox, 10);
    reserveStock(reserve('r1', 'p1', 3), ledger, outbox, 10); // replay
    expect(reservedQty(ledger, 'p1')).toBe(3);
    expect(ledger.entries()).toHaveLength(1);
  });
});
