import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Payroll payslip preview (WP3 inc2): earnings prorated for paid days → gross + PF wage → statutory → net.
// Confidential — owner-gated.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COMPONENTS = [
  { code: 'BASIC', monthlyMinor: 1_200_000, partOfPfWage: true },
  { code: 'HRA', monthlyMinor: 400_000 },
];

const post = (h: ApiHarness, u: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/hr/payroll/payslip', userId: u, tenantId: A, idempotencyKey: key, body });

describe('POST /v1/hr/payroll/payslip', () => {
  it('builds a full-month payslip: gross, PF wage, statutory and net', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const p = (await post(h, 'u-owner', { onDate: '2026-08-01', components: COMPONENTS, attendance: { calendarDaysInMonth: 31, paidDays: 31 } }, 'ps1')).body as {
      grossMinor: number; pfWageMinor: number; netPayMinor: number; confirmWithCa: boolean; statutory: { pfEmployeeMinor: number };
    };
    expect(p.grossMinor).toBe(1_600_000);
    expect(p.pfWageMinor).toBe(1_200_000);
    expect(p.statutory.pfEmployeeMinor).toBe(144_000);
    expect(p.netPayMinor).toBe(1_444_000);
    expect(p.confirmWithCa).toBe(true);
  });

  it('prorates for loss of pay', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const p = (await post(h, 'u-owner', { onDate: '2026-08-01', components: COMPONENTS, attendance: { calendarDaysInMonth: 30, paidDays: 15 } }, 'ps2')).body as { grossMinor: number; lopDays: number; netPayMinor: number };
    expect(p.grossMinor).toBe(800_000);
    expect(p.lopDays).toBe(15);
    expect(p.netPayMinor).toBe(722_000);
  });

  it('resolves a compensationHistory on the pay date', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const history = [
      { effectiveFrom: '2026-01-01', components: COMPONENTS },
      { effectiveFrom: '2026-09-01', components: [{ code: 'BASIC', monthlyMinor: 2_000_000, partOfPfWage: true }] },
    ];
    const p = (await post(h, 'u-owner', { onDate: '2026-08-01', compensationHistory: history, attendance: { calendarDaysInMonth: 31, paidDays: 31 } }, 'ps3')).body as { pfWageMinor: number };
    expect(p.pfWageMinor).toBe(1_200_000); // the August structure, not the September raise
  });

  it('refuses missing compensation and impossible attendance; gates on the confidential permission', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier'); // no payroll.statutory.read
    expect((await post(h, 'u-owner', { onDate: '2026-08-01', attendance: { calendarDaysInMonth: 31, paidDays: 31 } }, 'ps4')).status).toBe(400);
    expect((await post(h, 'u-owner', { onDate: '2026-08-01', components: COMPONENTS, attendance: { calendarDaysInMonth: 31, paidDays: 40 } }, 'ps5')).status).toBe(400);
    expect((await post(h, 'u-cash', { onDate: '2026-08-01', components: COMPONENTS, attendance: { calendarDaysInMonth: 31, paidDays: 31 } }, 'ps6')).status).toBe(403);
  });
});
