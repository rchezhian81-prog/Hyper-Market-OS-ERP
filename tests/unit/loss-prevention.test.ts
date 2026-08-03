import { describe, it, expect } from 'vitest';
import {
  evaluateLossPrevention,
  type ActivityEvent,
  type LpRule,
} from '../../packages/loss-prevention/src/index';

// Loss prevention surfaces risky patterns as linked exceptions, never acts, and is
// driven entirely by configurable rules (M15-FR-01 / P-03).

const AT = '2026-08-02T15:00:00Z';

function ev(
  txnId: string,
  kind: ActivityEvent['kind'],
  cashierId: string,
  valueMinor?: number,
): ActivityEvent {
  return { txnId, kind, cashierId, valueMinor, at: AT };
}

describe('evaluateLossPrevention', () => {
  it('raises no exception when activity is within the rules', () => {
    const rules: LpRule[] = [{ kind: 'void', maxCount: 5 }];
    const events = [ev('t1', 'void', 'c1'), ev('t2', 'void', 'c1')];
    expect(evaluateLossPrevention(events, rules)).toEqual([]);
  });

  it('flags a high void count and links every offending transaction', () => {
    const rules: LpRule[] = [{ kind: 'void', maxCount: 2 }];
    const events = [
      ev('t1', 'void', 'c1'),
      ev('t2', 'void', 'c1'),
      ev('t3', 'void', 'c1'),
    ];
    const [exc, ...rest] = evaluateLossPrevention(events, rules);
    expect(rest).toHaveLength(0);
    expect(exc?.breach).toBe('count');
    expect(exc?.observed).toBe(3);
    expect(exc?.limit).toBe(2);
    expect(exc?.linkedTxnIds).toEqual(['t1', 't2', 't3']);
  });

  it('flags a refund total-value breach', () => {
    const rules: LpRule[] = [{ kind: 'refund', maxTotalValueMinor: 100_00 }];
    const events = [
      ev('r1', 'refund', 'c1', 60_00),
      ev('r2', 'refund', 'c1', 70_00), // total ₹130 > ₹100
    ];
    const exceptions = evaluateLossPrevention(events, rules);
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]?.breach).toBe('total_value');
    expect(exceptions[0]?.observed).toBe(130_00);
    expect(exceptions[0]?.linkedTxnIds).toEqual(['r1', 'r2']);
  });

  it('flags a single oversized discount and links only that transaction', () => {
    const rules: LpRule[] = [{ kind: 'discount', maxSingleValueMinor: 50_00 }];
    const events = [
      ev('d1', 'discount', 'c1', 20_00),
      ev('d2', 'discount', 'c1', 80_00), // single ₹80 > ₹50
    ];
    const exceptions = evaluateLossPrevention(events, rules);
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]?.breach).toBe('single_value');
    expect(exceptions[0]?.observed).toBe(80_00);
    expect(exceptions[0]?.linkedTxnIds).toEqual(['d2']);
  });

  it('escalates a spike past the configured multiple', () => {
    const rules: LpRule[] = [{ kind: 'no_sale', maxCount: 3, escalateAtMultiple: 3 }];
    const events = Array.from({ length: 9 }, (_, i) => ev(`n${i}`, 'no_sale', 'c1')); // 9 = 3×3
    const exceptions = evaluateLossPrevention(events, rules);
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]?.severity).toBe('escalate');
  });

  it('flags (does not escalate) a breach below the escalation multiple', () => {
    const rules: LpRule[] = [{ kind: 'no_sale', maxCount: 3, escalateAtMultiple: 3 }];
    const events = Array.from({ length: 4 }, (_, i) => ev(`n${i}`, 'no_sale', 'c1'));
    const exceptions = evaluateLossPrevention(events, rules);
    expect(exceptions[0]?.severity).toBe('flag');
  });

  it('evaluates each cashier independently', () => {
    const rules: LpRule[] = [{ kind: 'void', maxCount: 1 }];
    const events = [
      ev('t1', 'void', 'c1'),
      ev('t2', 'void', 'c1'), // c1 breaches (2 > 1)
      ev('t3', 'void', 'c2'), // c2 does not (1)
    ];
    const exceptions = evaluateLossPrevention(events, rules);
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]?.cashierId).toBe('c1');
  });

  it('ignores kinds with no configured rule (a store enables what it wants)', () => {
    const rules: LpRule[] = [{ kind: 'void', maxCount: 0 }];
    const events = [ev('r1', 'refund', 'c1', 999_00)]; // no refund rule → ignored
    expect(evaluateLossPrevention(events, rules)).toEqual([]);
  });

  it('can raise multiple breaches for one kind (count and value together)', () => {
    const rules: LpRule[] = [{ kind: 'refund', maxCount: 1, maxTotalValueMinor: 50_00 }];
    const events = [
      ev('r1', 'refund', 'c1', 40_00),
      ev('r2', 'refund', 'c1', 40_00), // count 2 > 1 AND total ₹80 > ₹50
    ];
    const breaches = evaluateLossPrevention(events, rules).map((e) => e.breach);
    expect(breaches).toEqual(['count', 'total_value']);
  });
});
