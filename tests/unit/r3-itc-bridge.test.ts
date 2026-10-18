import { describe, it, expect } from 'vitest';
import { itcPortFrom, reconciliationPeriodOf, reversalDetail } from '../../services/api/src/r3-itc-bridge';

/**
 * The R3 seam between GSTR-3B Table 4 (lane 1, MMYYYY, `detail`) and the A17 reconciliation (lane 2, YYYY-MM, `reason`):
 * the period is converted, the field mapped, the reversals stated as 4(B) and never netted.
 */

const NONE = { igstMinor: 0, cgstMinor: 0, sgstMinor: 0, cessMinor: 0 };

describe('the ITC bridge (GSTR-3B Table 4 ← A17)', () => {
  it('converts MMYYYY to YYYY-MM and refuses anything that is not a month', () => {
    expect(reconciliationPeriodOf('102026')).toBe('2026-10');
    expect(reconciliationPeriodOf('012027')).toBe('2027-01');
    expect(() => reconciliationPeriodOf('2026-10')).toThrow();
  });

  it('asks the reconciliation for YYYY-MM and maps `reason` to `detail` — never a zero', async () => {
    const asked: string[] = [];
    const port = itcPortFrom({ itcForPeriod: async (_t, p) => { asked.push(p); return { status: 'not_reconciled', reason: `no GSTR-2B has been uploaded for ${p}` }; } });
    const r = await port.itcForPeriod('t1', '102026');
    expect(asked).toEqual(['2026-10']);
    expect(r).toEqual({ status: 'not_reconciled', detail: 'ITC not reconciled for 102026 — no GSTR-2B has been uploaded for 2026-10' });
  });

  it('a period that is not a month is not reconciled, and the reconciliation is never asked', async () => {
    let asked = false;
    const port = itcPortFrom({ itcForPeriod: async () => { asked = true; return { status: 'reconciled', ...NONE }; } });
    const r = await port.itcForPeriod('t1', 'Q1-2026');
    expect(r.status).toBe('not_reconciled');
    expect(r.detail).toMatch(/not a month/);
    expect(asked).toBe(false);
  });

  it('passes the accepted figures through unchanged and writes what they are made of', async () => {
    const port = itcPortFrom({
      itcForPeriod: async () => ({ status: 'reconciled', igstMinor: 24_000, cgstMinor: 90_000, sgstMinor: 90_000, cessMinor: 0 }),
      reversals: async () => ({ reversed: NONE, count: 0, acceptedLines: 2 }),
    });
    const r = await port.itcForPeriod('t1', '102026');
    expect(r).toMatchObject({ status: 'reconciled', igstMinor: 24_000, cgstMinor: 90_000, sgstMinor: 90_000, cessMinor: 0 });
    expect(r.detail).toBe('Table 4(A)(5) is the GSTR-2B / IMS reconciliation of 2026-10: ₹2040.00 accepted from 2 accepted line(s) (IGST ₹240.00, CGST ₹900.00, SGST ₹900.00). Table 4(B) ITC reversed: none recorded for this month');
  });

  it('a reversal is stated as 4(B) and NOT netted off the 4(A) figure', async () => {
    const port = itcPortFrom({
      itcForPeriod: async () => ({ status: 'reconciled', igstMinor: 0, cgstMinor: 90_000, sgstMinor: 90_000, cessMinor: 0 }),
      reversals: async () => ({ reversed: { ...NONE, cgstMinor: 4_500, sgstMinor: 4_500 }, count: 1, acceptedLines: 1 }),
    });
    const r = await port.itcForPeriod('t1', '102026');
    expect(r).toMatchObject({ cgstMinor: 90_000, sgstMinor: 90_000 });
    expect(r.detail).toMatch(/Table 4\(B\) ITC reversed: CGST ₹45\.00, SGST ₹45\.00 \(₹90\.00 in 1 reversal\(s\)\) — reported on its own, NOT netted off 4\(A\)/);
  });

  it('a reversal already recorded in a month that is not reconciled is still said', async () => {
    const port = itcPortFrom({
      itcForPeriod: async () => ({ status: 'not_reconciled', reason: '1 line(s) of the 2026-10 GSTR-2B are awaiting a person' }),
      reversals: async () => ({ reversed: { ...NONE, igstMinor: 1_000 }, count: 1, acceptedLines: 0 }),
    });
    const r = await port.itcForPeriod('t1', '102026');
    expect(r.status).toBe('not_reconciled');
    expect(r.detail).toMatch(/awaiting a person\. Table 4\(B\) ITC reversed: IGST ₹10\.00/);
  });

  it('reversalDetail says "none" rather than nothing', () => {
    expect(reversalDetail({ reversed: NONE, count: 0, acceptedLines: 0 })).toBe('Table 4(B) ITC reversed: none recorded for this month');
  });
});
