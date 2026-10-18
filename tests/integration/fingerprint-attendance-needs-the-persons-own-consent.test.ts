import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { r3OpsBackings, tenantClient } from '../support/r3-ops-backings';
import { STREAM, streamName } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';

/**
 * C21 (R3, OB-138) — on the real API, in memory and on PostgreSQL, with a cold restart: "A person's fingerprint attendance
 * is used only after their own recorded consent for that specific purpose. Anyone may refuse or withdraw consent and use
 * the PIN method instead, with no other difference. Aadhaar is never required. Without consent, the fingerprint method is
 * refused by name."
 *
 * OB-197 "A" (owner, 18 Oct 2026, in writing, "We draft, you sign"): consent can be given only against a notice the owner
 * has signed. Until he has, the fingerprint method is refused by name (`consent_notice_not_signed`) and PIN works.
 */
const backings = r3OpsBackings();

describe.each(backings)('fingerprint attendance needs the person\'s own consent — on $name (C21)', ({ harness, restart }) => {
  it('not asked → refused by name, PIN works; own consent → fingerprint works; withdrawn → refused again, PIN identical; nobody consents for another; no Aadhaar', async () => {
    let h: ApiHarness = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-anu', 'cashier');
    const { req, ok, code } = tenantClient(() => h, T);
    await ok(req('POST', '/v1/hr/workforce/employees/u-anu', { name: 'Anu', branchId: 'S1', roles: ['cashier'], active: true }), 'employee');
    const mark = (id: string, method: string, at: string, extra: Record<string, unknown> = {}) => req('POST', `/v1/hr/workforce/attendance-marks/${id}`, { employeeId: 'u-anu', kind: 'in', method, at, ...extra }, 'u-anu');
    const consent = (id: string, decision: string, userId = 'u-anu', extra: Record<string, unknown> = {}) => req('POST', `/v1/hr/workforce/biometric-consent/u-anu/${id}`, { decision, noticeRef: 'BIO-NOTICE-v1', ...extra }, userId);

    // ── OB-197: no notice signed by the owner yet — the fingerprint method is not in use, by name; consent cannot be
    // given on the unsigned notice; PIN works ─────────────────────────────────────────────────────────────────────
    expect(code(await mark('m0', 'fingerprint', '2026-10-05T03:29:00.000Z'))).toBe('consent_notice_not_signed');
    expect(code(await consent('c-early', 'given'))).toBe('consent_notice_not_signed');
    expect((await ok(req('GET', '/v1/hr/workforce/biometric-consent/u-anu', undefined, 'u-anu'), 'state before')).body).toMatchObject({ state: 'not_asked', allowedMethods: ['pin'] });
    expect((await ok(req('GET', '/v1/hr/workforce/biometric-consent-notices', undefined, 'u-anu'), 'notices')).body).toMatchObject({ notices: [], fingerprintInUse: false });
    // Only the owner records the signature: not a manager, not the employee.
    const sign = (userId: string, ref = 'BIO-NOTICE-v1', body: Record<string, unknown> = { documentPath: 'docs/requirements/C21_FINGERPRINT_CONSENT_NOTICE_DRAFT_2026-10-18.md' }) => req('POST', `/v1/hr/workforce/biometric-consent-notices/${ref}/sign`, body, userId);
    expect((await sign('u-mgr')).status).toBe(403);
    expect((await sign('u-anu')).status).toBe(403);
    expect(code(await sign('u-owner', 'BIO-NOTICE-v1', {}))).toBe('not_readable_as_a_notice_signature');
    const signed = (await ok(sign('u-owner'), 'owner signs')).body as { notice: { status: string; signedBy: string } };
    expect(signed.notice).toMatchObject({ status: 'signed_by_owner', signedBy: 'u-owner' });
    expect((await ok(sign('u-owner'), 'sign again')).body).toMatchObject({ alreadySigned: true });
    // A different notice the owner has not signed still cannot carry a consent.
    expect(code(await consent('c-draft', 'given', 'u-anu', { noticeRef: 'BIO-NOTICE-v2-draft' }))).toBe('consent_notice_not_signed');

    // ── never asked: fingerprint refused by name; PIN works ─────────────────────────────────────────────────────
    expect(code(await mark('m1', 'fingerprint', '2026-10-05T03:30:00.000Z'))).toBe('fingerprint_consent_not_given');
    const pin1 = (await ok(mark('m2', 'pin', '2026-10-05T03:31:00.000Z'), 'pin mark')).body as { mark: Record<string, unknown> };
    // ── nobody records consent for another person, not even the owner or a manager ─────────────────────────────
    expect(code(await consent('c-x', 'given', 'u-mgr'))).toBe('consent_is_the_persons_own');
    expect(code(await consent('c-y', 'given', 'u-owner'))).toBe('consent_is_the_persons_own');
    // ── Aadhaar is never asked for, and never taken ─────────────────────────────────────────────────────────────
    expect(code(await consent('c-z', 'given', 'u-anu', { aadhaarNumber: '0000 0000 0000' }))).toBe('identity_number_not_collected');
    expect(code(await mark('m-z', 'pin', '2026-10-05T03:32:00.000Z', { aadhaar: 'x' }))).toBe('identity_number_not_collected');
    // ── her own consent, without any identity number: the fingerprint is then used ──────────────────────────────
    const given = (await ok(consent('c-1', 'given'), 'consent')).body as { state: string; allowedMethods: string[] };
    expect(given).toMatchObject({ state: 'given', allowedMethods: ['fingerprint', 'pin'] });

    h = restart(h); // ── COLD RESTART ──────────────────────────────────────────────────────────────────────────

    const fp = (await ok(mark('m3', 'fingerprint', '2026-10-06T03:30:00.000Z'), 'fingerprint mark')).body as { mark: Record<string, unknown> };
    // ── she withdraws: refused again by name; PIN records exactly the same shape ─────────────────────────────────
    await ok(consent('c-2', 'withdrawn'), 'withdraw');
    expect(code(await mark('m4', 'fingerprint', '2026-10-07T03:30:00.000Z'))).toBe('fingerprint_consent_not_given');
    const pin2 = (await ok(mark('m5', 'pin', '2026-10-07T03:31:00.000Z'), 'pin after withdrawal')).body as { mark: Record<string, unknown> };
    const shape = (m: Record<string, unknown>) => Object.keys(m).sort();
    expect(shape(pin2.mark)).toEqual(shape(fp.mark));
    expect(shape(pin1.mark)).toEqual(shape(fp.mark));
    const { method: _a, markId: _b, at: _c, date: _d, ...restFp } = fp.mark; void _a; void _b; void _c; void _d;
    const { method: _e, markId: _f, at: _g, date: _h, ...restPin } = pin2.mark; void _e; void _f; void _g; void _h;
    expect(restPin).toEqual(restFp); // no other difference

    // ── a refusal is just as good: PIN only ──────────────────────────────────────────────────────────────────────
    await ok(consent('c-3', 'refused'), 'refuse');
    const mine = (await ok(req('GET', '/v1/hr/workforce/biometric-consent/u-anu', undefined, 'u-anu'), 'my consent')).body as { state: string; history: { decision: string }[]; allowedMethods: string[]; identityNumberNeeded: boolean };
    expect(mine).toMatchObject({ state: 'refused', allowedMethods: ['pin'], identityNumberNeeded: false });
    expect(mine.history.map((x) => x.decision)).toEqual(['given', 'withdrawn', 'refused']); // append-only
    expect((await req('GET', '/v1/hr/workforce/biometric-consent/u-anu', undefined, 'u-mgr')).status).toBe(403);
    const team = (await ok(req('GET', '/v1/hr/workforce/biometric-consent', undefined, 'u-mgr'), 'team')).body as { people: { employeeId: string; state: string }[] };
    expect(team.people).toEqual([expect.objectContaining({ employeeId: 'u-anu', state: 'refused', allowedMethods: ['pin'] })]);
    const day = (await ok(req('GET', '/v1/hr/workforce/attendance-marks', undefined, 'u-mgr', { date: '2026-10-07' }), 'marks')).body as { marks: { markId: string; method: string }[] };
    expect(day.marks.map((m) => `${m.markId}:${m.method}`)).toEqual(['m5:pin']);
    // ── OB-197: a consent recorded on a notice the owner never signed (synthetic: written before the rule) is not relied on ──
    await ok(req('POST', '/v1/hr/workforce/employees/u-ravi', { name: 'Ravi', branchId: 'S1', roles: ['cashier'], active: true }), 'employee 2');
    await h.provisionRole(T, 'u-ravi', 'cashier');
    await h.store.append(T, streamName(STREAM.workforce, 'biometric-consent'), makeEvent({
      id: 'biometric-consent-legacy-1', type: 'BiometricConsentRecorded', occurredAt: '2026-10-04T00:00:00.000Z', idempotencyKey: `biometric-consent-${T}-legacy-1`, source: 'api/hr',
      payload: { eventId: 'legacy-1', employeeId: 'u-ravi', purpose: 'attendance', decision: 'given', noticeRef: 'BIO-NOTICE-v0-unsigned', decidedBy: 'u-ravi', at: '2026-10-04T00:00:00.000Z' },
    }));
    expect(code(await req('POST', '/v1/hr/workforce/attendance-marks/r1', { employeeId: 'u-ravi', kind: 'in', method: 'fingerprint', at: '2026-10-07T03:40:00.000Z' }, 'u-ravi'))).toBe('consent_notice_not_signed');
    expect((await ok(req('GET', '/v1/hr/workforce/biometric-consent/u-ravi', undefined, 'u-ravi'), 'ravi')).body).toMatchObject({ state: 'given', allowedMethods: ['pin'] });
    await ok(req('POST', '/v1/hr/workforce/attendance-marks/r2', { employeeId: 'u-ravi', kind: 'in', method: 'pin', at: '2026-10-07T03:41:00.000Z' }, 'u-ravi'), 'ravi pin');

    // A person cannot mark another's attendance.
    expect(code(await req('POST', '/v1/hr/workforce/attendance-marks/m9', { employeeId: 'u-anu', kind: 'in', method: 'pin' }, 'u-mgr'))).toBe('consent_is_the_persons_own');
  }, 60_000);
});
