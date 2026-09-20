import { describe, it, expect } from 'vitest';
import {
  assessReturnEligibility, readReturnWindowDays, isDataFault,
} from '../../packages/returns/src/index';

// Return eligibility under the shop's return window (M13-FR-02). Pure: the caller supplies both
// timestamps, the policy window (the owner's number — AVR-07, never invented here), and whether a
// genuine §28 override is present. The acceptance criterion these pin: *an out-of-window return is
// blocked per policy*, and — secure by default — an unset window blocks too, while a supervisor
// override can clear either. A return dated before its sale, or on an unreadable date, is a data
// fault no override can wave through.

const SOLD = '2026-08-01T10:00:00.000Z';
const at = (iso: string) => iso;

describe('assessReturnEligibility — the return window (M13-FR-02)', () => {
  it('a return inside the window is eligible with no override needed', () => {
    const r = assessReturnEligibility({ soldAt: SOLD, returnedAt: at('2026-08-06T10:00:00.000Z'), returnWindowDays: 7 });
    expect(r.status).toBe('within_window');
    expect(r.eligible).toBe(true);
    expect(r.requiresOverride).toBe(false);
    expect(r.overridden).toBe(false);
    expect(r.ageDays).toBe(5);
  });

  it('a return on the last day of the window is still within it (boundary inclusive)', () => {
    const r = assessReturnEligibility({ soldAt: SOLD, returnedAt: at('2026-08-08T10:00:00.000Z'), returnWindowDays: 7 });
    expect(r.status).toBe('within_window');
    expect(r.eligible).toBe(true);
    expect(r.ageDays).toBe(7);
  });

  it('a same-instant return is age 0 and within any window', () => {
    const r = assessReturnEligibility({ soldAt: SOLD, returnedAt: SOLD, returnWindowDays: 0 });
    expect(r.status).toBe('within_window');
    expect(r.eligible).toBe(true);
    expect(r.ageDays).toBe(0);
  });

  it('BLOCKS an out-of-window return with no override (the FR-02 acceptance)', () => {
    const r = assessReturnEligibility({ soldAt: SOLD, returnedAt: at('2026-08-10T10:00:00.000Z'), returnWindowDays: 7 });
    expect(r.status).toBe('outside_window');
    expect(r.eligible).toBe(false);
    expect(r.requiresOverride).toBe(true);
    expect(r.overridden).toBe(false);
    expect(r.ageDays).toBe(9);
  });

  it('a supervisor override clears an out-of-window return', () => {
    const r = assessReturnEligibility({ soldAt: SOLD, returnedAt: at('2026-08-10T10:00:00.000Z'), returnWindowDays: 7, hasAuthorisedOverride: true });
    expect(r.status).toBe('outside_window');
    expect(r.eligible).toBe(true);
    expect(r.requiresOverride).toBe(true);
    expect(r.overridden).toBe(true);
  });

  it('an override on an in-window return is not marked as used (nothing to override)', () => {
    const r = assessReturnEligibility({ soldAt: SOLD, returnedAt: at('2026-08-03T10:00:00.000Z'), returnWindowDays: 7, hasAuthorisedOverride: true });
    expect(r.status).toBe('within_window');
    expect(r.eligible).toBe(true);
    expect(r.requiresOverride).toBe(false);
    expect(r.overridden).toBe(false);
  });
});

describe('assessReturnEligibility — secure by default when no window is set', () => {
  it('BLOCKS when the window is not set (undefined) — never a silent free pass', () => {
    const r = assessReturnEligibility({ soldAt: SOLD, returnedAt: at('2026-08-02T10:00:00.000Z') });
    expect(r.status).toBe('window_not_set');
    expect(r.eligible).toBe(false);
    expect(r.requiresOverride).toBe(true);
    expect(r.ageDays).toBe(1);
  });

  it('a supervisor override clears an unset-window return', () => {
    const r = assessReturnEligibility({ soldAt: SOLD, returnedAt: at('2026-08-02T10:00:00.000Z'), hasAuthorisedOverride: true });
    expect(r.status).toBe('window_not_set');
    expect(r.eligible).toBe(true);
    expect(r.overridden).toBe(true);
  });

  it('an invalid window (negative or fractional) is treated as not set, not as a huge window', () => {
    for (const bad of [-1, 2.5, Number.NaN]) {
      const r = assessReturnEligibility({ soldAt: SOLD, returnedAt: at('2026-09-01T10:00:00.000Z'), returnWindowDays: bad });
      expect(r.status).toBe('window_not_set');
      expect(r.eligible).toBe(false);
    }
  });
});

describe('assessReturnEligibility — data faults no override can clear', () => {
  it('a return dated before its sale is refused outright and is not overridable', () => {
    const r = assessReturnEligibility({ soldAt: SOLD, returnedAt: at('2026-07-31T10:00:00.000Z'), returnWindowDays: 7, hasAuthorisedOverride: true });
    expect(r.status).toBe('return_before_sale');
    expect(r.eligible).toBe(false);
    expect(r.requiresOverride).toBe(false);
    expect(r.overridden).toBe(false);
    expect(isDataFault(r.status)).toBe(true);
  });

  it('an unreadable timestamp is refused outright and is not overridable', () => {
    const r = assessReturnEligibility({ soldAt: 'not-a-date', returnedAt: at('2026-08-02T10:00:00.000Z'), returnWindowDays: 7, hasAuthorisedOverride: true });
    expect(r.status).toBe('unreadable_dates');
    expect(r.eligible).toBe(false);
    expect(r.requiresOverride).toBe(false);
    expect(Number.isNaN(r.ageDays)).toBe(true);
    expect(isDataFault(r.status)).toBe(true);
  });

  it('isDataFault is false for the policy statuses (they can be authorised)', () => {
    expect(isDataFault('within_window')).toBe(false);
    expect(isDataFault('outside_window')).toBe(false);
    expect(isDataFault('window_not_set')).toBe(false);
  });
});

describe('readReturnWindowDays — the window is config, never a per-request input', () => {
  it('accepts a whole non-negative number of days', () => {
    expect(readReturnWindowDays({ returnWindowDays: 7 })).toBe(7);
    expect(readReturnWindowDays({ returnWindowDays: 0 })).toBe(0);
    expect(readReturnWindowDays({ returnWindowDays: 30 })).toBe(30);
  });

  it('rejects a negative, fractional, non-numeric, or missing window', () => {
    expect(readReturnWindowDays({ returnWindowDays: -1 })).toBe('invalid');
    expect(readReturnWindowDays({ returnWindowDays: 2.5 })).toBe('invalid');
    expect(readReturnWindowDays({ returnWindowDays: '7' })).toBe('invalid');
    expect(readReturnWindowDays({})).toBe('invalid');
    expect(readReturnWindowDays(null)).toBe('invalid');
    expect(readReturnWindowDays([7])).toBe('invalid');
    expect(readReturnWindowDays(7)).toBe('invalid');
  });
});
