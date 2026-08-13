import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Payroll employee self-service (WP3 inc8): an employee reads their OWN payslip and nothing else.
// Two controls: self-scope (the subject must be the authenticated caller) and a narrow permission
// (`payroll.ess.self`, held broadly, NOT the confidential `payroll.statutory.read`).

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const PAYSLIP = {
  onDate: '2026-08-31', calendarDaysInMonth: 31, paidDays: 31, lopDays: 0,
  earnings: [{ code: 'BASIC', fullMonthMinor: 2_000_000, earnedMinor: 2_000_000 }],
  grossMinor: 2_000_000, pfWageMinor: 2_000_000,
  statutory: {
    pfEmployeeMinor: 240_000, pfEmployerMinor: 240_000,
    esiApplicable: false, esiEmployeeMinor: 0, esiEmployerMinor: 0,
    professionalTaxMinor: 20_800, tdsMinor: 0,
    totalEmployeeDeductionMinor: 260_800, totalEmployerContributionMinor: 240_000,
    netPayMinor: 1_739_200, detail: 'stub',
  },
  netPayMinor: 1_739_200, confirmWithCa: true, detail: 'stub',
};

const post = (h: ApiHarness, u: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/hr/payroll/ess/self', userId: u, tenantId: A, idempotencyKey: key, body });

describe('POST /v1/hr/payroll/ess/self', () => {
  it('returns the caller’s own payslip view', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const v = (await post(h, 'u-owner', { employeeId: 'u-owner', payslip: PAYSLIP }, 'e1')).body as {
      employeeId: string; netPayMinor: number; employerContributions: { totalMinor: number }; deductions: { label: string }[];
    };
    expect(v.employeeId).toBe('u-owner');
    expect(v.netPayMinor).toBe(1_739_200);
    expect(v.employerContributions.totalMinor).toBe(240_000);
    expect(v.deductions.some((d) => /employer/i.test(d.label))).toBe(false);
  });

  it('refuses a request for another employee’s record even with the permission (self-scope)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier'); // cashier HOLDS payroll.ess.self
    expect((await post(h, 'u-cash', { employeeId: 'u-owner', payslip: PAYSLIP }, 'e2')).status).toBe(403); // asking for someone else
    expect((await post(h, 'u-cash', { employeeId: 'u-cash', payslip: PAYSLIP }, 'e3')).status).toBe(200); // own record is fine
  });

  it('refuses a caller without the self-service permission', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    // u-nobody is authenticated but holds no role → no payroll.ess.self → 403 even for their own id.
    expect((await post(h, 'u-nobody', { employeeId: 'u-nobody', payslip: PAYSLIP }, 'e4')).status).toBe(403);
  });

  it('refuses a malformed request', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect((await post(h, 'u-owner', { employeeId: 'u-owner' }, 'e5')).status).toBe(400); // no payslip
    expect((await post(h, 'u-owner', { payslip: PAYSLIP }, 'e6')).status).toBe(400); // no employeeId
    expect((await post(h, 'u-owner', { employeeId: 'u-owner', payslip: {} }, 'e7')).status).toBe(400); // empty payslip
  });
});
