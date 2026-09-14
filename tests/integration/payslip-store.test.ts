import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Payroll DURABLE issued-payslip store (M25 · ESS) on the live API. HR issues a payslip per (employee, period)
// — an append-only retained record (hard rule #6) — and an employee reads THEIR OWN latest via
// GET /v1/hr/payroll/my-payslip, self-redacted by the tested employeeSelfView (own money only; employer cost
// shown separately; never anyone else's). Issuing is confidential (payroll.statutory.read); the self read is
// the narrow, widely-held payroll.ess.self.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

// A minimal valid payslip — the fields employeeSelfView reads (earnings/statutory/gross/net/onDate).
const payslip = (over: Record<string, unknown> = {}) => ({
  onDate: '2026-08-31', calendarDaysInMonth: 31, paidDays: 31, lopDays: 0,
  earnings: [{ code: 'basic', earnedMinor: 2000000 }],
  grossMinor: 2000000, pfWageMinor: 2000000,
  statutory: { pfEmployeeMinor: 240000, esiEmployeeMinor: 0, professionalTaxMinor: 20000, tdsMinor: 0, pfEmployerMinor: 240000, esiEmployerMinor: 0 },
  netPayMinor: 1740000, confirmWithCa: true, detail: 'test payslip', ...over,
});

const issue = (h: ApiHarness, u: string, employeeId: string, period: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/hr/payroll/payslips/${employeeId}/${period}`, userId: u, tenantId: A, idempotencyKey: key, body });
const myPayslip = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/hr/payroll/my-payslip', userId: u, tenantId: A });
const payslipsFor = (h: ApiHarness, u: string, employeeId: string) =>
  h.request({ method: 'GET', path: `/v1/hr/payroll/payslips/${employeeId}`, userId: u, tenantId: A });
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

interface MyPayslip { readonly issued: boolean; readonly period?: string; readonly view?: { netPayMinor: number; deductions: unknown[]; employerContributions: { totalMinor: number } } }

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');                     // has payroll.statutory.read (issue) + payroll.ess.self
  await h.provisionRole(A, 'u-cash', 'cashier');       // has payroll.ess.self, NOT payroll.statutory.read
  return h;
}

describe('durable issued-payslip store (M25 · ESS)', () => {
  it('an employee reads their OWN latest payslip, self-redacted — issued:false before anything is issued', async () => {
    const h = await cast();
    // Nothing issued yet → issued:false, not a 404.
    expect(((await myPayslip(h, 'u-cash')).body as MyPayslip).issued).toBe(false);

    // HR issues two months for this employee (id === their login id, ESS self-scope).
    expect((await issue(h, 'u-owner', 'u-cash', '2026-07', { payslip: payslip({ onDate: '2026-07-31', netPayMinor: 1700000 }) }, 'k1')).status).toBe(200);
    expect((await issue(h, 'u-owner', 'u-cash', '2026-08', { payslip: payslip({ netPayMinor: 1740000 }) }, 'k2')).status).toBe(200);

    const mine = (await myPayslip(h, 'u-cash')).body as MyPayslip;
    expect(mine.issued).toBe(true);
    expect(mine.period).toBe('2026-08'); // the most recent pay period
    expect(mine.view?.netPayMinor).toBe(1740000);
    // Redacted: own deductions listed, employer contribution shown separately (a company cost, not deducted).
    expect(Array.isArray(mine.view?.deductions)).toBe(true);
    expect(mine.view?.employerContributions.totalMinor).toBe(240000); // PF employer
  });

  it('my-payslip only ever returns the caller\'s own — and it survives a restart', async () => {
    const h = await cast();
    await issue(h, 'u-owner', 'u-cash', '2026-08', { payslip: payslip({ netPayMinor: 1740000 }) }, 'k1');
    await issue(h, 'u-owner', 'someone-else', '2026-08', { payslip: payslip({ netPayMinor: 9999999 }) }, 'k2');
    // The cashier's own payslip is theirs, never the other person's.
    expect(((await myPayslip(h, 'u-cash')).body as MyPayslip).view?.netPayMinor).toBe(1740000);

    // Durable: a restart rebuilds the issued payslips from the log.
    const restarted = apiHarness({ store: h.store });
    expect(((await myPayslip(restarted, 'u-cash')).body as MyPayslip).view?.netPayMinor).toBe(1740000);
    // HR review lists the periods issued for a person.
    const list = (await payslipsFor(restarted, 'u-owner', 'u-cash')).body as { count: number };
    expect(list.count).toBe(1);
  });

  it('gates issuing on payroll.statutory.read and the HR list too; refuses a malformed payslip', async () => {
    const h = await cast();
    // A cashier cannot issue a payslip nor read the HR list (both need payroll.statutory.read).
    expect((await issue(h, 'u-cash', 'u-cash', '2026-08', { payslip: payslip() }, 'k1')).status).toBe(403);
    expect((await payslipsFor(h, 'u-cash', 'u-cash')).status).toBe(403);
    // A malformed payslip is refused, nothing stored.
    expect(codeOf(await issue(h, 'u-owner', 'u-cash', '2026-08', { payslip: { onDate: '2026-08-31' } }, 'k2'))).toBe('not_readable_as_an_issued_payslip');
  });
});
