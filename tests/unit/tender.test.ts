import { describe, it, expect } from 'vitest';
import { settle, type Tender } from '../../packages/tender/src/index';
import { money } from '../../packages/contracts/src/money';

// Tender settlement (M12-FR-03): split tenders must balance to the total, and a
// pending/uncertain tender never counts as paid (no fake approval).

const cash = (minor: number, status: Tender['status'] = 'settled'): Tender => ({
  kind: 'cash',
  amount: money(minor, 'INR'),
  status,
});
const card = (minor: number, status: Tender['status']): Tender => ({
  kind: 'card',
  amount: money(minor, 'INR'),
  status,
});

describe('settle', () => {
  it('fully pays with exact cash', () => {
    const s = settle(money(35_40, 'INR'), [cash(35_40)]);
    expect(s.fullyPaid).toBe(true);
    expect(s.outstanding.minor).toBe(0);
    expect(s.changeDue.minor).toBe(0);
  });

  it('balances a split tender (card + cash) to the total', () => {
    const s = settle(money(35_40, 'INR'), [card(20_00, 'settled'), cash(15_40)]);
    expect(s.settled.minor).toBe(35_40);
    expect(s.fullyPaid).toBe(true);
    expect(s.outstanding.minor).toBe(0);
  });

  it('does NOT count a pending card tender as paid (no fake approval)', () => {
    const s = settle(money(35_40, 'INR'), [card(35_40, 'pending')]);
    expect(s.fullyPaid).toBe(false);
    expect(s.settled.minor).toBe(0);
    expect(s.pending.minor).toBe(35_40);
    expect(s.outstanding.minor).toBe(35_40);
  });

  it('treats an uncertain tender the same as pending', () => {
    const s = settle(money(100_00, 'INR'), [card(100_00, 'uncertain')]);
    expect(s.fullyPaid).toBe(false);
    expect(s.pending.minor).toBe(100_00);
  });

  it('ignores a declined tender entirely', () => {
    const s = settle(money(50_00, 'INR'), [card(50_00, 'declined'), cash(50_00)]);
    expect(s.settled.minor).toBe(50_00);
    expect(s.pending.minor).toBe(0);
    expect(s.fullyPaid).toBe(true);
  });

  it('returns change due when overpaid with cash', () => {
    const s = settle(money(35_00, 'INR'), [cash(40_00)]);
    expect(s.fullyPaid).toBe(true);
    expect(s.changeDue.minor).toBe(5_00);
  });

  it('reports the outstanding amount on a partial payment', () => {
    const s = settle(money(35_40, 'INR'), [cash(20_00)]);
    expect(s.fullyPaid).toBe(false);
    expect(s.outstanding.minor).toBe(15_40);
    expect(s.changeDue.minor).toBe(0);
  });
});
