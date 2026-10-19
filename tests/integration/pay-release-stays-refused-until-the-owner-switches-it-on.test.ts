import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { backings, openDatabase, closeDatabase, caller, codeOf } from '../support/r4-lane1';
import { STREAM, streamName } from '../../services/api/src/adapters';
import { PAY_RELEASE_SWITCH_STREAM } from '../../services/api/src/r4-pay-release-adapters';

/**
 * **R4 · OB-228 — the owner's hard pay-release switch (the real API, in memory and on real PostgreSQL, with a cold
 * restart).** The owner (19 Oct 2026, in writing): approve, lock and the salary bank file are refused outright
 * (`pay_release_switched_off`) until he switches release ON. The switch is his act alone, with a written reason,
 * appended (never overwritten) and audited; it starts OFF. It is IN ADDITION to the fresh-MFA hold: with the switch on,
 * the route goes on to its existing checks (step-up, maker ≠ checker, a locked run). Synthetic data only.
 */

beforeAll(openDatabase);
afterAll(closeDatabase);

const PILOT = { authTimeFromNowSeconds: null, amr: null } as const;
const LINES = [{ employeeId: 'e1', employeeName: 'Asha R', bankAccountNo: '123456789012', ifsc: 'HDFC0001234', netPayMinor: 1_444_000 }];

describe.each(backings())('pay release stays refused until the owner switches it on — on $name (OB-228)', ({ harness, restart }) => {
  it('off → refused; the owner switches on with a reason → the existing checks; off again → refused; nobody else can switch', async () => {
    let h: ApiHarness = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionOwner(T, 'u-owner-2');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-ca', 'chartered_accountant');
    const { req, ok } = caller(() => h, T);
    const step = (userId: string, body: unknown) => req('POST', '/v1/hr/payroll/pay-run/pr-1/append', body, userId);
    const sw = (userId: string, body: unknown) => req('POST', '/v1/hr/payroll/release-switch', body, userId);
    const state = async () => ((await ok(req('GET', '/v1/hr/payroll/pay-run/pr-1'), 'run')).body as { state: string }).state;
    const switchView = async () => (await ok(req('GET', '/v1/hr/payroll/release-switch'), 'switch')).body as { on: boolean; state: string; setBy: string | null; reason: string | null };

    // ── It starts OFF, said in words ────────────────────────────────────────────────────────────────────────────────
    const first = await switchView();
    expect(first).toMatchObject({ on: false, setBy: null, reason: null });
    expect(first.state).toMatch(/switched OFF/);
    await ok(step('u-owner', { action: 'draft', payPeriod: '2030-07', netTotalMinor: 1_444_000, employeeCount: 1 }), 'draft');
    await ok(step('u-owner', { action: 'submit' }), 'submit');
    const refused = await step('u-owner-2', { action: 'approve' }); // a fresh MFA sign-in (the harness default)
    expect(refused.status).toBe(409);
    expect(codeOf(refused)).toBe('pay_release_switched_off');
    expect(await state()).toBe('submitted');

    // ── Nobody but the owner can switch it; the owner must write why ────────────────────────────────────────────────
    expect((await sw('u-mgr', { on: true, reason: 'pay day' })).status).toBe(403);
    expect((await sw('u-ca', { on: true, reason: 'pay day' })).status).toBe(403);
    expect(codeOf(await sw('u-owner', { on: true }))).toBe('not_readable_as_a_pay_release_switch');
    expect(codeOf(await sw('u-owner', { on: true, reason: '   ' }))).toBe('not_readable_as_a_pay_release_switch');
    expect((await switchView()).on).toBe(false);

    // ── The owner switches it ON with a reason → the route goes on to its EXISTING checks ───────────────────────────
    await ok(sw('u-owner', { on: true, reason: 'CA signed the October pay run (synthetic)' }), 'switch on');
    // A COLD RESTART: the switch comes back from the store.
    h = restart(h);
    expect(await switchView()).toMatchObject({ on: true, setBy: 'u-owner', reason: 'CA signed the October pay run (synthetic)' });
    // Maker ≠ checker still applies: the maker cannot approve their own run …
    expect(codeOf(await step('u-owner', { action: 'approve' }))).toBe('pay_run_self_approval');
    // … a different person, with a fresh MFA sign-in, approves …
    await ok(step('u-owner-2', { action: 'approve' }), 'approve');
    expect(await state()).toBe('approved');
    // … and the MFA hold still stands (in addition, not instead): the pilot sign-in cannot lock.
    const pilotLock = await h.request({ method: 'POST', path: '/v1/hr/payroll/pay-run/pr-1/append', userId: 'u-owner-2', tenantId: T, idempotencyKey: `k-${randomUUID()}`, body: { action: 'lock' }, ...PILOT });
    expect(codeOf(pilotLock)).toBe('reauthentication_required');

    // ── Switched back OFF → refused again ───────────────────────────────────────────────────────────────────────────
    await ok(sw('u-owner', { on: false, reason: 'hold until the bank confirms (synthetic)' }), 'switch off');
    const lock = await step('u-owner-2', { action: 'lock' });
    expect(lock.status).toBe(409);
    expect(codeOf(lock)).toBe('pay_release_switched_off');
    expect(await state()).toBe('approved');
    // On again: lock, then the bank file reaches its own checks; off again: the bank file is refused.
    await ok(sw('u-owner', { on: true, reason: 'bank confirmed (synthetic)' }), 'switch on again');
    await ok(step('u-owner-2', { action: 'lock' }), 'lock');
    const file = await ok(req('POST', '/v1/hr/payroll/bank-file', { payRunId: 'pr-1', lines: LINES }), 'bank file');
    expect((file.body as { recordCount: number }).recordCount).toBe(1);
    await ok(sw('u-owner', { on: false, reason: 'paid; switch off (synthetic)' }), 'switch off again');
    const bank = await req('POST', '/v1/hr/payroll/bank-file', { payRunId: 'pr-1', lines: LINES });
    expect(bank.status).toBe(409);
    expect(codeOf(bank)).toBe('pay_release_switched_off');

    // ── Append-only and audited: every setting stays, each with who and why ────────────────────────────────────────
    const settings = (await h.store.readStream(T, PAY_RELEASE_SWITCH_STREAM)).map((e) => e.event.payload as { on: boolean; by: string; reason: string });
    expect(settings.map((s) => s.on)).toEqual([true, false, true, false]);
    expect(settings.every((s) => s.by === 'u-owner' && s.reason.length > 0)).toBe(true);
    const trail = (await h.store.readStream(T, streamName(STREAM.audit, 'domain-trail'), { type: 'AuditRecordSealed' }))
      .map((e) => e.event.payload as { action: string; actorId: string; after: Record<string, string> | null })
      .filter((a) => a.action === 'payroll.release.switch');
    expect(trail.map((a) => [a.actorId, a.after?.['on']])).toEqual([['u-owner', 'true'], ['u-owner', 'false'], ['u-owner', 'true'], ['u-owner', 'false']]);
  });
});
