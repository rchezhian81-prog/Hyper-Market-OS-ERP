import { describe, it, expect } from 'vitest';
import {
  recordCashMovement,
  tillBalanceMinor,
  tillCustodian,
  InvalidCashAmountError,
  TillAlreadyAssignedError,
  TillNotAssignedError,
  InsufficientTillCashError,
} from '../../packages/cash/src/index';
import { money } from '../../packages/contracts/src/money';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';

// Cash movements are an append-only chain: one custodian per till at a time, no
// overdraw, and the balance/custodian are always projected from events (M14-FR-01).

const AT = '2026-08-02T08:00:00Z';

function newLedger() {
  return new Ledger(new InMemoryLedgerStore());
}

function move(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mv-1',
    tillId: 'till-1',
    laneId: 'lane-1',
    kind: 'float_issue' as const,
    amount: money(2_000_00, 'INR'),
    custodianId: 'clerk-1',
    performedBy: 'cashoffice-1',
    at: AT,
    tradingDay: '2026-08-02',
    ...overrides,
  };
}

describe('recordCashMovement', () => {
  it('issues a float, assigns custody, and increases the till balance', () => {
    const ledger = newLedger();
    const outbox = new SyncOutbox();
    const result = recordCashMovement(move(), ledger, outbox);

    expect(result.tillBalance).toEqual(money(2_000_00, 'INR'));
    expect(tillCustodian(ledger, 'till-1')).toBe('clerk-1');
    expect(outbox.pending()[0]?.event.type).toBe('CashMovement');
  });

  it('rejects a non-positive amount', () => {
    const ledger = newLedger();
    const outbox = new SyncOutbox();
    expect(() => recordCashMovement(move({ amount: money(0, 'INR') }), ledger, outbox)).toThrow(
      InvalidCashAmountError,
    );
  });

  it('will not issue a till that already has an open custody (one custodian)', () => {
    const ledger = newLedger();
    const outbox = new SyncOutbox();
    recordCashMovement(move(), ledger, outbox); // clerk-1 holds till-1
    expect(() =>
      recordCashMovement(
        move({ id: 'mv-2', custodianId: 'clerk-2' }), // a second cashier
        ledger,
        outbox,
      ),
    ).toThrow(TillAlreadyAssignedError);
  });

  it('a pickup by the custodian moves cash out of the till (auditable chain)', () => {
    const ledger = newLedger();
    const outbox = new SyncOutbox();
    recordCashMovement(move(), ledger, outbox); // float ₹2,000
    const pickup = recordCashMovement(
      move({ id: 'mv-2', kind: 'pickup', amount: money(500_00, 'INR') }),
      ledger,
      outbox,
    );
    expect(pickup.tillBalance).toEqual(money(1_500_00, 'INR'));
    expect(tillBalanceMinor(ledger, 'till-1')).toBe(1_500_00);
  });

  it('blocks a movement by someone who is not the current custodian', () => {
    const ledger = newLedger();
    const outbox = new SyncOutbox();
    recordCashMovement(move(), ledger, outbox); // clerk-1 holds till-1
    expect(() =>
      recordCashMovement(
        move({ id: 'mv-2', kind: 'pickup', amount: money(100_00, 'INR'), custodianId: 'clerk-2' }),
        ledger,
        outbox,
      ),
    ).toThrow(TillNotAssignedError);
  });

  it('will not take out more than the till holds (no overdraw)', () => {
    const ledger = newLedger();
    const outbox = new SyncOutbox();
    recordCashMovement(move(), ledger, outbox); // float ₹2,000
    expect(() =>
      recordCashMovement(
        move({ id: 'mv-2', kind: 'safe_drop', amount: money(2_500_00, 'INR') }),
        ledger,
        outbox,
      ),
    ).toThrow(InsufficientTillCashError);
  });

  it('float_return closes the custody so the till can be re-issued', () => {
    const ledger = newLedger();
    const outbox = new SyncOutbox();
    recordCashMovement(move(), ledger, outbox); // clerk-1 holds till-1, ₹2,000
    recordCashMovement(
      move({ id: 'mv-2', kind: 'float_return', amount: money(2_000_00, 'INR') }),
      ledger,
      outbox,
    );
    expect(tillCustodian(ledger, 'till-1')).toBeNull();
    expect(tillBalanceMinor(ledger, 'till-1')).toBe(0);
    // now a different cashier can be issued the till
    const reissue = recordCashMovement(
      move({ id: 'mv-3', custodianId: 'clerk-2' }),
      ledger,
      outbox,
    );
    expect(reissue.tillBalance).toEqual(money(2_000_00, 'INR'));
    expect(tillCustodian(ledger, 'till-1')).toBe('clerk-2');
  });

  it('is idempotent on the movement id', () => {
    const ledger = newLedger();
    const outbox = new SyncOutbox();
    recordCashMovement(move(), ledger, outbox);
    recordCashMovement(move(), ledger, outbox);
    expect(ledger.entries()).toHaveLength(1);
    expect(outbox.unsentCount()).toBe(1);
  });
});
