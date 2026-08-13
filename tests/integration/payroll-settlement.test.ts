import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Payroll full-and-final settlement (WP3 inc7): a leaver's earnings − recoveries → a signed net, for review.
// Confidential — owner-gated. Refuses malformed input and a settlement schedule gap.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const post = (h: ApiHarness, u: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/hr/payroll/settlement', userId: u, tenantId: A, idempotencyKey: key, body });

describe('POST /v1/hr/payroll/settlement', () => {
  it('computes a positive settlement payable to the employee', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const s = (await post(h, 'u-owner', {
      onDate: '2026-08-31',
      pendingSalaryMinor: 2_000_000,
      leaveEncashment: { unusedLeaveDays: 10, perDayBasicMinor: 100_000 },
      gratuity: { completedYears: 10, lastDrawnBasicDaMinor: 2_600_000 },
      noticeRecoveryMinor: 500_000,
      loanRecoveryMinor: 2_000_000,
    }, 's1')).body as { grossEarningsMinor: number; netSettlementMinor: number; payableToEmployee: boolean; confirmWithCa: boolean };
    expect(s.grossEarningsMinor).toBe(18_000_000);
    expect(s.netSettlementMinor).toBe(15_500_000);
    expect(s.payableToEmployee).toBe(true);
    expect(s.confirmWithCa).toBe(true);
  });

  it('refuses malformed input and a schedule gap', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect((await post(h, 'u-owner', { pendingSalaryMinor: 2_000_000 }, 's2')).status).toBe(400); // no onDate
    expect((await post(h, 'u-owner', { onDate: '2026-08-31' }, 's3')).status).toBe(400); // no pendingSalaryMinor
    expect((await post(h, 'u-owner', { onDate: '2000-01-01', pendingSalaryMinor: 1_000 }, 's4')).status).toBe(400); // before earliest schedule
    expect((await post(h, 'u-owner', { onDate: '2026-08-31', pendingSalaryMinor: -1 }, 's5')).status).toBe(400); // negative
  });

  it('gates on the confidential payroll permission', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier'); // no payroll.statutory.read
    expect((await post(h, 'u-cash', { onDate: '2026-08-31', pendingSalaryMinor: 2_000_000 }, 's6')).status).toBe(403);
  });
});
