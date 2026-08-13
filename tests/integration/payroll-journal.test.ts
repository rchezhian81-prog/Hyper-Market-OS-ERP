import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Payroll accounting journal (WP3 inc6): a locked pay run's totals → a balanced double-entry journal.
// Confidential — owner-gated. Refuses a non-locked run and an unbalanced set of totals.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TOTALS = {
  grossMinor: 1_600_000, pfEmployeeMinor: 144_000, pfEmployerMinor: 144_000,
  esiEmployeeMinor: 12_000, esiEmployerMinor: 52_000, professionalTaxMinor: 2_250, tdsMinor: 50_000, netMinor: 1_391_750,
};
const lockedEvents = [
  { kind: 'drafted', payPeriod: '2026-08', by: 'maker', at: 't0' },
  { kind: 'submitted', by: 'maker', at: 't1' },
  { kind: 'approved', by: 'checker', at: 't2' },
  { kind: 'locked', at: 't3' },
];
const approvedEvents = lockedEvents.slice(0, 3);

const post = (h: ApiHarness, u: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/hr/payroll/journal', userId: u, tenantId: A, idempotencyKey: key, body });

describe('POST /v1/hr/payroll/journal', () => {
  it('builds a balanced journal from a locked run', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const j = (await post(h, 'u-owner', { payRunId: 'pr1', events: lockedEvents, totals: TOTALS }, 'j1')).body as {
      totalDebitMinor: number; totalCreditMinor: number; balanced: boolean; lines: unknown[];
    };
    expect(j.totalDebitMinor).toBe(1_796_000);
    expect(j.totalCreditMinor).toBe(1_796_000);
    expect(j.balanced).toBe(true);
  });

  it('refuses a non-locked run and an unbalanced set of totals', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect((await post(h, 'u-owner', { payRunId: 'pr2', events: approvedEvents, totals: TOTALS }, 'j2')).status).toBe(422); // not locked
    expect((await post(h, 'u-owner', { payRunId: 'pr3', events: lockedEvents, totals: { ...TOTALS, netMinor: 1_500_000 } }, 'j3')).status).toBe(422); // unbalanced
  });

  it('refuses malformed input and gates on the confidential permission', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier'); // no payroll.statutory.read
    expect((await post(h, 'u-owner', { payRunId: 'pr4', events: lockedEvents }, 'j4')).status).toBe(400); // no totals
    expect((await post(h, 'u-cash', { payRunId: 'pr5', events: lockedEvents, totals: TOTALS }, 'j5')).status).toBe(403);
  });
});
