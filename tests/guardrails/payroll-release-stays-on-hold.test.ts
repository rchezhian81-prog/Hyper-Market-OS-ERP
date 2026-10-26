import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { apiHarness } from '../support/api-harness';
import { ERP_NAVIGATION } from '../../apps/web-erp/src/navigation';
import { PAY_RUN_RELEASE_ACTIONS, PAYROLL_RELEASE_STEP_UP } from '../../services/finance/src/pay-run-store';
import { payrollRoutes } from '../../services/finance/src/payroll';
import { statutoryPayRoutes } from '../../services/finance/src/statutory-pay';
import { eprRoutes } from '../../services/compliance/src/epr-store';
import { PAY_RELEASE_SWITCH_PERMISSION } from '../../services/finance/src/pay-release-switch';
import { ROLE_CATALOGUE, OWNER_ROLE_ID } from '../../services/api/src/roles';

/**
 * **R4 · OB-209 — pay release stays on hold.** The owner (19 Oct 2026, in writing): "Keep on hold" — R4 computes and shows
 * payslips only; approving, locking and the bank file need a separate written GO. This guardrail keeps that true:
 *
 *   1. with the pilot's sign-in (no recent, MFA-backed re-authentication — the stand-in issuer records none), a pay-run
 *      APPROVE and LOCK and the salary BANK FILE are refused, and nothing is appended;
 *   2. the release steps still demand that re-authentication at the API boundary (the control is not loosened);
 *   3. the payroll pages stay off the store computer's menu (unserved) — until OB-380 (owner, 26 Oct 2026) had the store
 *      computer serve every office page. Since then the hold no longer rests on that: the box's payroll page is a
 *      READ-ONLY view of head office (payroll-live-session.ts has no write, the page draws no approve / lock / bank
 *      file), and the switch in 5 refuses those steps whatever page asks;
 *   4. the R4 lane's pay code never reaches the release path: it imports nothing that builds a bank file or moves a pay
 *      run, writes no pay-run event, and none of its routes is a pay-run or bank-file route.
 *
 *   5. OB-228 (the owner in writing, 19 Oct): a HARD pay-release switch, default OFF and the owner's act alone. Even a
 *      session that DOES carry a fresh MFA re-authentication is refused `pay_release_switched_off` on approve, lock and
 *      the bank file while it is off — and nothing is appended.
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

  it('OB-228: with a fresh MFA-stepped-up owner session, approve, lock and the bank file are refused while the switch is off', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionOwner(A, 'u-owner-2');
    // The harness default sign-in carries a fresh MFA re-authentication — the step-up hold is passed.
    const step = (userId: string, body: unknown, key: string) => h.request({ method: 'POST', path: '/v1/hr/payroll/pay-run/pr-sw/append', userId, tenantId: A, idempotencyKey: key, body });
    const sw = (on: boolean, key: string) => h.request({ method: 'POST', path: '/v1/hr/payroll/release-switch', userId: 'u-owner', tenantId: A, idempotencyKey: key, body: { on, reason: `guardrail ${on}` } });
    const runState = async () => ((await h.request({ method: 'GET', path: '/v1/hr/payroll/pay-run/pr-sw', userId: 'u-owner', tenantId: A })).body as { state: string }).state;
    const bank = (key: string) => h.request({ method: 'POST', path: '/v1/hr/payroll/bank-file', userId: 'u-owner', tenantId: A, idempotencyKey: key, body: { payRunId: 'pr-sw', lines: [] } });
    // It starts OFF.
    expect(((await h.request({ method: 'GET', path: '/v1/hr/payroll/release-switch', userId: 'u-owner', tenantId: A })).body as { on: boolean }).on).toBe(false);
    expect((await step('u-owner', { action: 'draft', payPeriod: '2030-06' }, 'd')).status).toBe(201);
    expect((await step('u-owner', { action: 'submit' }, 's')).status).toBe(200);
    const approve = await step('u-owner-2', { action: 'approve' }, 'a');
    expect(approve.status).toBe(409);
    expect(code(approve)).toBe('pay_release_switched_off');
    expect(await runState()).toBe('submitted');
    // Approve with the switch on, then off again: lock is refused, and nothing is locked.
    expect((await sw(true, 'on1')).status).toBe(201);
    expect((await step('u-owner-2', { action: 'approve' }, 'a2')).status).toBe(200);
    expect((await sw(false, 'off1')).status).toBe(201);
    const lock = await step('u-owner-2', { action: 'lock' }, 'l');
    expect(lock.status).toBe(409);
    expect(code(lock)).toBe('pay_release_switched_off');
    expect(await runState()).toBe('approved');
    // Locked with the switch on, then off again: the bank file is refused.
    expect((await sw(true, 'on2')).status).toBe(201);
    expect((await step('u-owner-2', { action: 'lock' }, 'l2')).status).toBe(200);
    expect((await sw(false, 'off2')).status).toBe(201);
    const file = await bank('b');
    expect(file.status).toBe(409);
    expect(code(file)).toBe('pay_release_switched_off');
  });

  it('OB-228: only the owner role holds the pay-release switch', () => {
    const holders = ROLE_CATALOGUE.filter((r) => r.permissions.includes(PAY_RELEASE_SWITCH_PERMISSION)).map((r) => r.id);
    expect(holders).toEqual([OWNER_ROLE_ID]);
  });

  it('the release steps still demand a fresh MFA re-authentication', () => {
    expect([...PAY_RUN_RELEASE_ACTIONS].sort()).toEqual(['approve', 'lock', 'reverse']);
    expect(PAYROLL_RELEASE_STEP_UP).toEqual({ withinSeconds: 300, amr: ['mfa'] });
    expect(payrollRoutes().find((r) => r.path === '/v1/hr/payroll/bank-file')?.reauth).toEqual(PAYROLL_RELEASE_STEP_UP);
  });

  it('OB-380: the store computer serves the payroll pages only as a read-only view — no write, no approve, lock or bank file', () => {
    for (const id of ['payroll', 'my-payslip']) expect(ERP_NAVIGATION.find((i) => i.id === id)?.served ?? 'box', id).toBe('box');
    const live = readFileSync('apps/web-erp/src/payroll-live-session.ts', 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(live.match(/call<[^>]+>\('(GET|POST|PUT)'/g)?.every((c) => c.endsWith("'GET'")), 'every head-office call the box page makes is a read').toBe(true);
    for (const banned of ['/append', 'bank-file', "'POST'", "'PUT'"]) expect(live.includes(banned), `the box's payroll session reaches "${banned}"`).toBe(false);
    const view = readFileSync('apps/web-erp/web/payroll.js', 'utf8');
    const liveView = view.slice(view.indexOf('const live = window.payrollLive'));
    for (const banned of ['STAGE_ACTIONS', 'renderActions', 'session.can(']) expect(liveView.includes(banned), `the box's payroll view draws "${banned}"`).toBe(false);
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
