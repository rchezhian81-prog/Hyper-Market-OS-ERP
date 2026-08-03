import { describe, it, expect } from 'vitest';
import {
  earnPoints,
  burnPoints,
  reversePoints,
  pointsBalance,
  InvalidPointsError,
  InsufficientPointsError,
  OfflineCapExceededError,
} from '../../packages/loyalty/src/index';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';

// Loyalty points are money-like: append-only movements, balance projected, offline
// caps prevent double-spend, and the balance never goes negative (M17-FR-01).

const AT = '2026-08-02T19:00:00Z';

function newLedger() {
  return new Ledger(new InMemoryLedgerStore());
}

function earn(id: string, customerId: string, points: number) {
  return { id, customerId, points, at: AT, source: 'lane-1' };
}

describe('loyalty points', () => {
  it('earns points and projects the balance', () => {
    const ledger = newLedger();
    const outbox = new SyncOutbox();
    const result = earnPoints(earn('e1', 'c1', 100), ledger, outbox);
    expect(result.balance).toBe(100);
    expect(pointsBalance(ledger, 'c1')).toBe(100);
    expect(outbox.pending()[0]?.event.type).toBe('PointsMovement');
  });

  it('burns points down from the balance', () => {
    const ledger = newLedger();
    const outbox = new SyncOutbox();
    earnPoints(earn('e1', 'c1', 100), ledger, outbox);
    const result = burnPoints({ ...earn('b1', 'c1', 30) }, ledger, outbox);
    expect(result.delta).toBe(-30);
    expect(result.balance).toBe(70);
  });

  it('never lets the balance go negative', () => {
    const ledger = newLedger();
    const outbox = new SyncOutbox();
    earnPoints(earn('e1', 'c1', 20), ledger, outbox);
    expect(() => burnPoints({ ...earn('b1', 'c1', 50) }, ledger, outbox)).toThrow(
      InsufficientPointsError,
    );
    expect(pointsBalance(ledger, 'c1')).toBe(20); // unchanged
  });

  it('enforces the offline cap to prevent double-spend', () => {
    const ledger = newLedger();
    const outbox = new SyncOutbox();
    earnPoints(earn('e1', 'c1', 1000), ledger, outbox);
    expect(() =>
      burnPoints({ ...earn('b1', 'c1', 500), offline: true, offlineCap: 200 }, ledger, outbox),
    ).toThrow(OfflineCapExceededError);
    // within the cap is fine
    const ok = burnPoints({ ...earn('b2', 'c1', 150), offline: true, offlineCap: 200 }, ledger, outbox);
    expect(ok.balance).toBe(850);
  });

  it('reverses a burn as a compensating credit', () => {
    const ledger = newLedger();
    const outbox = new SyncOutbox();
    earnPoints(earn('e1', 'c1', 100), ledger, outbox);
    burnPoints({ ...earn('b1', 'c1', 40) }, ledger, outbox);
    const rev = reversePoints(earn('r1', 'c1', 40), ledger, outbox);
    expect(rev.reason).toBe('reversal');
    expect(rev.balance).toBe(100); // 100 − 40 + 40
  });

  it('keeps each customer balance separate', () => {
    const ledger = newLedger();
    const outbox = new SyncOutbox();
    earnPoints(earn('e1', 'c1', 100), ledger, outbox);
    earnPoints(earn('e2', 'c2', 30), ledger, outbox);
    expect(pointsBalance(ledger, 'c1')).toBe(100);
    expect(pointsBalance(ledger, 'c2')).toBe(30);
  });

  it('rejects a non-positive amount', () => {
    const ledger = newLedger();
    const outbox = new SyncOutbox();
    expect(() => earnPoints(earn('e1', 'c1', 0), ledger, outbox)).toThrow(InvalidPointsError);
  });

  it('is idempotent on the movement id (a replay does not re-burn)', () => {
    const ledger = newLedger();
    const outbox = new SyncOutbox();
    earnPoints(earn('e1', 'c1', 100), ledger, outbox);
    burnPoints({ ...earn('b1', 'c1', 40) }, ledger, outbox);
    burnPoints({ ...earn('b1', 'c1', 40) }, ledger, outbox); // replay same id
    expect(ledger.entries()).toHaveLength(2); // one earn + one burn
    expect(pointsBalance(ledger, 'c1')).toBe(60);
  });
});
