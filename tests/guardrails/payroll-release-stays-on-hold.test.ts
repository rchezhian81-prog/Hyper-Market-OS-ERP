import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { apiHarness } from '../support/api-harness';
import { ERP_NAVIGATION } from '../../apps/web-erp/src/navigation';
import { PAY_RUN_RELEASE_ACTIONS, PAYROLL_RELEASE_STEP_UP } from '../../services/finance/src/pay-run-store';
import { payrollRoutes } from '../../services/finance/src/payroll';
import { statutoryPayRoutes } from '../../services/finance/src/statutory-pay';
import { eprRoutes } from '../../services/compliance/src/epr-store';

/**
 * **R4 · OB-209 — pay release stays on hold.** The owner (19 Oct 2026, in writing): "Keep on hold" — R4 computes and shows
 * payslips only; approving, locking and the bank file need a separate written GO. This guardrail keeps that true:
 *
 *   1. with the pilot's sign-in (no recent, MFA-backed re-authentication — the stand-in issuer records none), a pay-run
 *      APPROVE and LOCK and the salary BANK FILE are refused, and nothing is appended;
 *   2. the release steps still demand that re-authentication at the API boundary (the control is not loosened);
 *   3. the payroll pages stay off the store computer's menu (unserved);
 *   4. the R4 lane's pay code never reaches the release path: it imports nothing that builds a bank file or moves a pay
 *      run, writes no pay-run event, and none of its routes is a pay-run or bank-file route.
 *
 * Known limit, said here so nobody reads more into this test than it proves: a session that DOES carry a fresh MFA
 * re-authentication (the production identity provider) can still approve and lock. The hold rests on the pilot sign-in
 * carrying none and on the pages being unserved; a hard switch would be a change to the release path (owner decision).
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa209';
const PILOT = { authTimeFromNowSeconds: null, amr: null } as const;
const code = (r: { body: unknown }) => (r.body as { error?: { code?: string } }).error?.code;

describe('pay release stays on hold (OB-209)', () => {
  it('with the pilot sign-in, approve and lock are refused and not appended; the bank file is refused', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionOwner(A, 'u-owner-2');
    const step = (userId: string, body: unknown, key: string) => h.request({ method: 'POST', path: '/v1/hr/payroll/pay-run/pr-r4/append', userId, tenantId: A, idempotencyKey: key, body, ...PILOT });
    expect((await step('u-owner', { action: 'draft', payPeriod: '2030-05' }, 'd')).status).toBe(201);
    expect((await step('u-owner', { action: 'submit' }, 's')).status).toBe(200);
    const approve = await step('u-owner-2', { action: 'approve' }, 'a');
    expect(approve.status).toBe(403);
    expect(code(approve)).toBe('reauthentication_required');
    const lock = await step('u-owner-2', { action: 'lock' }, 'l');
    expect(lock.status).toBe(403);
    expect(code(lock)).toBe('reauthentication_required');
    const state = (await h.request({ method: 'GET', path: '/v1/hr/payroll/pay-run/pr-r4', userId: 'u-owner', tenantId: A })).body as { state: string };
    expect(state.state).toBe('submitted'); // nothing approved, nothing locked
    const bank = await h.request({ method: 'POST', path: '/v1/hr/payroll/bank-file', userId: 'u-owner', tenantId: A, idempotencyKey: 'b', body: { payRunId: 'pr-r4', lines: [] }, ...PILOT });
    expect(bank.status).toBe(403);
    expect(code(bank)).toBe('reauthentication_required');
  });

  it('the release steps still demand a fresh MFA re-authentication', () => {
    expect([...PAY_RUN_RELEASE_ACTIONS].sort()).toEqual(['approve', 'lock', 'reverse']);
    expect(PAYROLL_RELEASE_STEP_UP).toEqual({ withinSeconds: 300, amr: ['mfa'] });
    expect(payrollRoutes().find((r) => r.path === '/v1/hr/payroll/bank-file')?.reauth).toEqual(PAYROLL_RELEASE_STEP_UP);
  });

  it('the payroll pages stay off the store computer (unserved)', () => {
    for (const id of ['payroll', 'my-payslip']) expect(ERP_NAVIGATION.find((i) => i.id === id)?.served, id).toBe('unserved');
  });

  it('the R4 pay code never reaches the release path', () => {
    const files = [
      'services/finance/src/statutory-pay.ts', 'services/api/src/r4-pay-epr-adapters.ts',
      'packages/payroll/src/legal-settings.ts', 'packages/payroll/src/contribution-summary.ts', 'packages/payroll/src/overtime.ts',
      'packages/payroll/src/minimum-wage.ts', 'packages/payroll/src/payslip-particulars.ts', 'packages/payroll/src/statutory-payslip.ts',
    ];
    const code = (f: string) => readFileSync(f, 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    for (const f of files) {
      const src = code(f);
      for (const banned of ['buildBankFile', 'bank-file', 'evaluatePayRunTransition', 'foldPayRun', 'PayRunLifecycleRecorded', 'payRunAdapter', 'forPayRun', "kind: 'approved'", "kind: 'locked'"]) {
        expect(src.includes(banned), `${f} reaches the release path through "${banned}"`).toBe(false);
      }
    }
    const none = <T>(v: T) => () => v as never;
    const lanePaths = [
      ...statutoryPayRoutes(new Proxy({}, { get: () => none(undefined) }) as never),
      ...eprRoutes(new Proxy({}, { get: () => none(undefined) }) as never),
    ].map((r) => r.path);
    expect(lanePaths.length).toBeGreaterThan(10);
    for (const p of lanePaths) expect(p, p).not.toMatch(/pay-run|bank-file|journal|settlement/);
  });
});
