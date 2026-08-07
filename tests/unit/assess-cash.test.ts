import { describe, it, expect } from 'vitest';
import { assessCashMovement, type StoredCashMovement, type CashMovementRequest } from '../../packages/cash/src/index';

// The cloud-side till-cash guard (M14-FR-01). Pure: prior chain in, a signed delta or a typed refusal
// out. The integration test drives it through the real API; these pin the rules a wire test reaches
// awkwardly — one custodian, no overdraw, and the idempotent self-exclusion.

const req = (over: Partial<CashMovementRequest> = {}): CashMovementRequest =>
  ({ movementId: 'm', tillId: 'T1', kind: 'pickup', amountMinor: 10, custodianId: 'c1', ...over });

const held: StoredCashMovement[] = [{ movementId: 'f1', tillId: 'T1', kind: 'float_issue', deltaMinor: 100, custodianId: 'c1' }];

describe('assessCashMovement keeps a till to one custodian and never overdrawn', () => {
  it('issues a free till and refuses issuing a held one', () => {
    expect(assessCashMovement({ priorMovements: [], request: req({ kind: 'float_issue', amountMinor: 100 }) })).toMatchObject({ ok: true, custodianAfter: 'c1', balanceAfterMinor: 100 });
    expect(assessCashMovement({ priorMovements: held, request: req({ movementId: 'f2', kind: 'float_issue', amountMinor: 50, custodianId: 'c2' }) }).refusedBecause).toBe('till_already_assigned');
  });

  it('refuses a movement by a non-custodian and an overdraw', () => {
    expect(assessCashMovement({ priorMovements: held, request: req({ custodianId: 'c9' }) }).refusedBecause).toBe('till_not_held_by_this_custodian');
    expect(assessCashMovement({ priorMovements: held, request: req({ amountMinor: 150 }) }).refusedBecause).toBe('insufficient_till_cash');
  });

  it('closes custody on float_return', () => {
    expect(assessCashMovement({ priorMovements: held, request: req({ kind: 'float_return', amountMinor: 100 }) })).toMatchObject({ ok: true, custodianAfter: null, balanceAfterMinor: 0 });
  });

  it('does not count a movement against itself (idempotent retry)', () => {
    // The pickup already sits in the chain. Re-assessing it must not read its own −40 as prior.
    const chain: StoredCashMovement[] = [...held, { movementId: 'p1', tillId: 'T1', kind: 'pickup', deltaMinor: -40, custodianId: 'c1' }];
    expect(assessCashMovement({ priorMovements: chain, request: req({ movementId: 'p1', kind: 'pickup', amountMinor: 40 }) })).toMatchObject({ ok: true, balanceAfterMinor: 60 });
  });
});
