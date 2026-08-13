import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Payroll TDS preview (WP3 inc3) + folding TDS into a payslip. Confidential — owner-gated.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const post = (h: ApiHarness, u: string, path: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path, userId: u, tenantId: A, idempotencyKey: key, body });

describe('POST /v1/hr/payroll/tds', () => {
  it('computes the new-regime monthly TDS', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const r = (await post(h, 'u-owner', '/v1/hr/payroll/tds', { onDate: '2026-08-01', regime: 'new', annualGrossIncomeMinor: 150_000_000 }, 't1')).body as {
      tdsMonthlyMinor: number; annualTax: { totalTaxMinor: number }; confirmWithCa: boolean;
    };
    expect(r.annualTax.totalTaxMinor).toBe(9_750_000);
    expect(r.tdsMonthlyMinor).toBe(812_500);
    expect(r.confirmWithCa).toBe(true);
  });

  it('rebates to nil at ₹12,50,000 and refuses missing/bad input; gates on the permission', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier'); // no payroll.statutory.read
    const nil = (await post(h, 'u-owner', '/v1/hr/payroll/tds', { onDate: '2026-08-01', regime: 'new', annualGrossIncomeMinor: 125_000_000 }, 't2')).body as { tdsMonthlyMinor: number };
    expect(nil.tdsMonthlyMinor).toBe(0);
    expect((await post(h, 'u-owner', '/v1/hr/payroll/tds', { onDate: '2026-08-01', regime: 'sideways', annualGrossIncomeMinor: 100_000_000 }, 't3')).status).toBe(400);
    expect((await post(h, 'u-cash', '/v1/hr/payroll/tds', { onDate: '2026-08-01', regime: 'new', annualGrossIncomeMinor: 100_000_000 }, 't4')).status).toBe(403);
  });
});

describe('POST /v1/hr/payroll/payslip folds in TDS', () => {
  it('includes tdsMonthlyMinor in the payslip deductions and net', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const components = [{ code: 'BASIC', monthlyMinor: 1_200_000, partOfPfWage: true }, { code: 'HRA', monthlyMinor: 400_000 }];
    const p = (await post(h, 'u-owner', '/v1/hr/payroll/payslip', { onDate: '2026-08-01', components, attendance: { calendarDaysInMonth: 31, paidDays: 31 }, tdsMonthlyMinor: 50_000 }, 'pt1')).body as {
      statutory: { tdsMinor: number }; netPayMinor: number;
    };
    expect(p.statutory.tdsMinor).toBe(50_000);
    expect(p.netPayMinor).toBe(1_444_000 - 50_000);
  });
});
