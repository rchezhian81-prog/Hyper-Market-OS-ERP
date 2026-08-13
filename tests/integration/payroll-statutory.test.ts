import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Payroll statutory-deduction preview (priority 16): PF/ESI/TN Professional Tax on effective-dated rate
// tables, for review. Confidential — owner-gated.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const post = (h: ApiHarness, u: string, path: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path, userId: u, tenantId: A, idempotencyKey: key, body });

describe('POST /v1/hr/payroll/statutory-deductions', () => {
  it('computes PF (capped) + ESI (within ceiling) + net', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const r = (await post(h, 'u-owner', '/v1/hr/payroll/statutory-deductions', { onDate: '2026-08-01', grossMinor: 1_800_000, pfWageMinor: 1_800_000 }, 'd1')).body as {
      pfEmployeeMinor: number; esiApplicable: boolean; esiEmployeeMinor: number; netPayMinor: number; confirmWithCa: boolean;
    };
    expect(r.pfEmployeeMinor).toBe(180_000);
    expect(r.esiApplicable).toBe(true);
    expect(r.esiEmployeeMinor).toBe(13_500);
    expect(r.netPayMinor).toBe(1_606_500);
    expect(r.confirmWithCa).toBe(true);
  });

  it('drops ESI above the gross ceiling', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const r = (await post(h, 'u-owner', '/v1/hr/payroll/statutory-deductions', { onDate: '2026-08-01', grossMinor: 2_500_000, pfWageMinor: 2_000_000 }, 'd2')).body as { esiApplicable: boolean; netPayMinor: number };
    expect(r.esiApplicable).toBe(false);
    expect(r.netPayMinor).toBe(2_320_000);
  });

  it('refuses a pre-schedule date and missing fields; gates on the confidential permission', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier'); // no payroll.statutory.read
    expect((await post(h, 'u-owner', '/v1/hr/payroll/statutory-deductions', { onDate: '2019-01-01', grossMinor: 1_800_000, pfWageMinor: 1_800_000 }, 'd3')).status).toBe(400);
    expect((await post(h, 'u-owner', '/v1/hr/payroll/statutory-deductions', { onDate: '2026-08-01' }, 'd4')).status).toBe(400);
    expect((await post(h, 'u-cash', '/v1/hr/payroll/statutory-deductions', { onDate: '2026-08-01', grossMinor: 1_800_000, pfWageMinor: 1_800_000 }, 'd5')).status).toBe(403);
  });
});

describe('POST /v1/hr/payroll/professional-tax-tn', () => {
  it('reads the TN half-yearly slab', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const r = (await post(h, 'u-owner', '/v1/hr/payroll/professional-tax-tn', { onDate: '2026-08-01', halfYearlyIncomeMinor: 2_500_000 }, 'p1')).body as { ptHalfYearlyMinor: number };
    expect(r.ptHalfYearlyMinor).toBe(13_500);
  });
});
