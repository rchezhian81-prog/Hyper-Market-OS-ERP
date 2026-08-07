import { describe, it, expect } from 'vitest';
import { STREAM_FOR } from '../../services/api/src/adapters';

// OB-01 · M20 · hard rule #2.
//
// A stream name is composed from caller-supplied parts, and two different things must never
// compose to one name. This is the same fault `packages/catalogue` had when it joined fields with
// nothing and two products canonicalised identically — caught there by a guardrail, and worth a
// test of its own here because of what shares a delivery stream: a driver's cash.

const { forCustomer, forDriverRun, forLocation, forInvoice } = STREAM_FOR;

describe('two different things never compose to one stream', () => {
  it('keeps a driver whose id looks like a date apart from a driver who is not', () => {
    // The case a hyphen gets wrong. `delivery-{driver}-{date}` is unambiguous only while a date is
    // exactly ten characters, and the moment it is not, two runs become one — which means the run
    // reconciliation settles cash against the wrong set of attempts.
    const a = forDriverRun('d-1-2026-08-05', '2026-08-06');
    const b = forDriverRun('d-1', '2026-08-05-2026-08-06');
    expect(a).not.toBe(b);
  });

  it('keeps every adjacent pair of runs distinct, including the awkward ones', () => {
    const runs: readonly (readonly [string, string])[] = [
      ['d-1', '2026-08-05'], ['d-1', '2026-08-06'], ['d-2', '2026-08-05'],
      ['d', '1-2026-08-05'], ['d-1-2026', '08-05'], ['d-1-2026-08', '05'],
      ['', '2026-08-05'], ['d-1', ''],
    ];
    const names = runs.map(([d, r]) => forDriverRun(d, r));
    expect(new Set(names).size).toBe(runs.length);
  });

  it('keeps the four kinds of stream apart from each other', () => {
    const names = [
      forCustomer('X'), forDriverRun('X', 'Y'), forLocation('X'), forInvoice('X'),
      forCustomer('X\u001fY'.replace('\u001f', '-')),
    ];
    expect(new Set(names).size).toBe(names.length);
  });

  it('REFUSES a part that contains the separator, rather than stripping it', () => {
    // Stripping produces a silently different stream, which is the failure this exists to prevent
    // rather than a smaller version of it.
    expect(() => forCustomer('C\u001f1')).toThrow(/unit separator/);
    expect(() => forDriverRun('d-1', '2026\u001f08')).toThrow(/unit separator/);
  });

  it('tripwire — ordinary ids still compose, so the guard is not refusing everything', () => {
    expect(forCustomer('C-001')).toContain('C-001');
    expect(forDriverRun('d-ravi', '2026-08-05')).toContain('d-ravi');
    expect(forInvoice('INV/2026/0042')).toContain('INV/2026/0042');
  });
});
