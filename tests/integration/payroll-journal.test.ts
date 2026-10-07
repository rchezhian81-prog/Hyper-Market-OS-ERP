import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

import { recordedPayRun } from '../support/pay-run';

// Payroll accounting journal (WP3 inc6): a locked pay run's totals → a balanced double-entry journal.
// Confidential — owner-gated. Refuses a non-locked run and an unbalanced set of totals. Since 2b-vi-b-2 (audit PA-03)
// the run is the one head office RECORDED, never a history in the request; a recorded net total must be the journal's.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TOTALS = {
  grossMinor: 1_600_000, pfEmployeeMinor: 144_000, pfEmployerMinor: 144_000,
  esiEmployeeMinor: 12_000, esiEmployerMinor: 52_000, professionalTaxMinor: 2_250, tdsMinor: 50_000, netMinor: 1_391_750,
};

const post = (h: ApiHarness, u: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/hr/payroll/journal', userId: u, tenantId: A, idempotencyKey: key, body });
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
async function twoOwners(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionOwner(A, 'u-owner-2');
  return h;
}

describe('POST /v1/hr/payroll/journal', () => {
  it('builds a balanced journal from the recorded, locked run', async () => {
    const h = await twoOwners();
    await recordedPayRun(h, A, 'pr1', { maker: 'u-owner', checker: 'u-owner-2', netTotalMinor: 1_391_750 });
    const j = (await post(h, 'u-owner', { payRunId: 'pr1', totals: TOTALS }, 'j1')).body as {
      totalDebitMinor: number; totalCreditMinor: number; balanced: boolean; lines: unknown[];
    };
    expect(j.totalDebitMinor).toBe(1_796_000);
    expect(j.totalCreditMinor).toBe(1_796_000);
    expect(j.balanced).toBe(true);
  });

  it('refuses a history in the request, an unknown run, and totals that are not the approved run\'s', async () => {
    const h = await twoOwners();
    expect(codeOf(await post(h, 'u-owner', { payRunId: 'pr1', events: [{ kind: 'drafted', payPeriod: '2026-08', by: 'x', at: 't' }], totals: TOTALS }, 'j-typed'))).toBe('pay_run_is_read_from_the_record');
    expect(codeOf(await post(h, 'u-owner', { payRunId: 'pr-none', totals: TOTALS }, 'j-none'))).toBe('journal_no_run');
    await recordedPayRun(h, A, 'pr-fix', { maker: 'u-owner', checker: 'u-owner-2', netTotalMinor: 1_000_000 });
    expect(codeOf(await post(h, 'u-owner', { payRunId: 'pr-fix', totals: TOTALS }, 'j-fix'))).toBe('journal_does_not_match_the_run');
  });

  it('refuses a non-locked run and an unbalanced set of totals', async () => {
    const h = await twoOwners();
    await recordedPayRun(h, A, 'pr2', { maker: 'u-owner', checker: 'u-owner-2', stage: 'approved' });
    expect((await post(h, 'u-owner', { payRunId: 'pr2', totals: TOTALS }, 'j2')).status).toBe(422); // not locked
    await recordedPayRun(h, A, 'pr3', { maker: 'u-owner', checker: 'u-owner-2' });
    expect((await post(h, 'u-owner', { payRunId: 'pr3', totals: { ...TOTALS, netMinor: 1_500_000 } }, 'j3')).status).toBe(422); // unbalanced
  });

  it('refuses malformed input and gates on the confidential permission', async () => {
    const h = await twoOwners();
    await h.provisionRole(A, 'u-cash', 'cashier'); // no payroll.statutory.read
    expect((await post(h, 'u-owner', { payRunId: 'pr4' }, 'j4')).status).toBe(400); // no totals
    expect((await post(h, 'u-cash', { payRunId: 'pr5', totals: TOTALS }, 'j5')).status).toBe(403);
  });
});
