import { describe, it, expect } from 'vitest';
import { assessPointsMovement, type StoredPointsMovement, type PointsMovementRequest } from '../../packages/loyalty/src/index';

// The cloud-side loyalty guard (M17-FR-01). Pure: given a customer's prior movements and a new one,
// it returns a signed delta or a typed refusal. The integration test drives it through the real API;
// these pin the arithmetic — the idempotent self-exclusion and the never-below-zero rule.

const req = (over: Partial<PointsMovementRequest> = {}): PointsMovementRequest =>
  ({ movementId: 'm', customerId: 'C1', kind: 'earn', points: 10, ...over });

const prior = (moves: StoredPointsMovement[], request: PointsMovementRequest) =>
  assessPointsMovement({ priorMovements: moves, request });

describe('assessPointsMovement keeps points money-like', () => {
  it('earns and burns against the projected balance', () => {
    const moves: StoredPointsMovement[] = [{ movementId: 'e1', customerId: 'C1', delta: 100 }];
    expect(prior(moves, req({ movementId: 'b1', kind: 'burn', points: 30 }))).toMatchObject({ ok: true, delta: -30, balanceAfter: 70 });
  });

  it('never lets a burn go below zero', () => {
    const moves: StoredPointsMovement[] = [{ movementId: 'e1', customerId: 'C1', delta: 50 }];
    expect(prior(moves, req({ movementId: 'b1', kind: 'burn', points: 80 }))).toMatchObject({ ok: false, refusedBecause: 'insufficient_points' });
  });

  it('refuses a non-positive amount', () => {
    expect(prior([], req({ points: 0 })).refusedBecause).toBe('points_not_positive');
    expect(prior([], req({ points: -5 })).refusedBecause).toBe('points_not_positive');
  });

  it('does not count a movement against itself (idempotent retry)', () => {
    // The burn already sits in the history. Re-assessing it must not read its own −40 as prior,
    // which would make an 80-point balance look like 40 and could wrongly refuse a valid burn.
    const moves: StoredPointsMovement[] = [
      { movementId: 'e1', customerId: 'C1', delta: 80 },
      { movementId: 'b1', customerId: 'C1', delta: -40 },
    ];
    expect(prior(moves, req({ movementId: 'b1', kind: 'burn', points: 40 }))).toMatchObject({ ok: true, balanceAfter: 40 });
  });

  it('ignores movements that belong to a different customer', () => {
    const moves: StoredPointsMovement[] = [{ movementId: 'x', customerId: 'C2', delta: 999 }];
    expect(prior(moves, req({ movementId: 'b1', kind: 'burn', points: 1 })).refusedBecause).toBe('insufficient_points');
  });
});
