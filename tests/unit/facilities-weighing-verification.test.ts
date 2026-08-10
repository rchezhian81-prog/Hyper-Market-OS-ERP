import { describe, it, expect } from 'vitest';
import { weighingScaleVerification, InvalidScaleVerification } from '../../packages/facilities/src/weighing-verification';

// Roadmap v2.1 B6 — a scale whose Legal Metrology verification has lapsed may not be used for trade.

describe('weighingScaleVerification — B6', () => {
  it('is current (and does not block trading) well before the due date', () => {
    const r = weighingScaleVerification({ reverificationDueOn: '2027-01-01' }, '2026-08-10');
    expect(r.verificationCurrent).toBe(true);
    expect(r.tradingBlocked).toBe(false);
    expect(r.level).toBe('current');
    expect(r.daysRemaining).toBeGreaterThan(30);
  });

  it('warns (but still trades) within the notice window', () => {
    const r = weighingScaleVerification({ reverificationDueOn: '2026-08-25' }, '2026-08-10', 30);
    expect(r.verificationCurrent).toBe(true);
    expect(r.tradingBlocked).toBe(false);
    expect(r.level).toBe('due_soon');
    expect(r.daysRemaining).toBe(15);
  });

  it('treats the due date itself as the last valid trading day', () => {
    const r = weighingScaleVerification({ reverificationDueOn: '2026-08-10' }, '2026-08-10');
    expect(r.verificationCurrent).toBe(true);
    expect(r.daysRemaining).toBe(0);
  });

  it('BLOCKS trading once the verification has lapsed', () => {
    const r = weighingScaleVerification({ reverificationDueOn: '2026-08-01' }, '2026-08-10');
    expect(r.verificationCurrent).toBe(false);
    expect(r.tradingBlocked).toBe(true);
    expect(r.level).toBe('expired');
    expect(r.daysRemaining).toBe(-9);
    expect(r.detail).toContain('may not be used for trade');
  });

  it('rejects a bad date or a negative notice window', () => {
    expect(() => weighingScaleVerification({ reverificationDueOn: '01-08-2026' }, '2026-08-10')).toThrow(InvalidScaleVerification);
    expect(() => weighingScaleVerification({ reverificationDueOn: '2026-08-01' }, 'today')).toThrow(InvalidScaleVerification);
    expect(() => weighingScaleVerification({ reverificationDueOn: '2026-08-01' }, '2026-08-10', -1)).toThrow(InvalidScaleVerification);
  });
});
