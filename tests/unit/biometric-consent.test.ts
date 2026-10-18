import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { consentStateOf, methodsAllowed, identityNumberFieldsIn, fingerprintVerdict, methodsAllowedNow, signedNoticeRefs, type BiometricConsentEvent } from '../../packages/workforce/src/biometric-consent';
import { ROLE_CATALOGUE, OWNER_ROLE_ID } from '../../services/api/src/roles';

/** C21 (R3, OB-138): the consent fold, and the guardrails that no path uses a fingerprint without it or needs Aadhaar. */
const ev = (eventId: string, decision: BiometricConsentEvent['decision'], at: string, employeeId = 'u-anu'): BiometricConsentEvent => ({ eventId, employeeId, purpose: 'attendance', decision, noticeRef: 'v1', decidedBy: employeeId, at });

describe('C21 consent fold', () => {
  it('never asked → PIN only; given → fingerprint and PIN; withdrawn or refused → PIN only; the latest decides', () => {
    expect(consentStateOf([], 'u-anu').state).toBe('not_asked');
    expect(methodsAllowed('not_asked')).toEqual(['pin']);
    const h = [ev('1', 'given', '2026-10-01T00:00:00Z'), ev('2', 'withdrawn', '2026-10-02T00:00:00Z')];
    expect(consentStateOf(h, 'u-anu')).toMatchObject({ state: 'withdrawn', since: '2026-10-02T00:00:00Z' });
    expect(consentStateOf([...h, ev('3', 'given', '2026-10-03T00:00:00Z')], 'u-anu').state).toBe('given');
    expect(methodsAllowed('given')).toEqual(['fingerprint', 'pin']);
    expect(methodsAllowed('refused')).toEqual(['pin']);
    expect(consentStateOf([ev('1', 'given', '2026-10-01T00:00:00Z', 'u-other')], 'u-anu').state).toBe('not_asked'); // one person's consent is never another's
  });
  it('spots an identity number field by name', () => {
    expect(identityNumberFieldsIn({ aadhaarNumber: 'x', decision: 'given' })).toEqual(['aadhaarNumber']);
    expect(identityNumberFieldsIn({ AADHAR: 'x' })).toEqual(['AADHAR']);
    expect(identityNumberFieldsIn({ decision: 'given', noticeRef: 'v1' })).toEqual([]);
  });
});

describe('C21 guardrails', () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const route = strip(readFileSync('services/finance/src/biometric-consent.ts', 'utf8'));
  it('a fingerprint mark is refused unless consent is given — no override', () => {
    const at = route.indexOf("if (method === 'fingerprint')");
    const block = route.slice(at, route.indexOf('const now = deps.now()', at));
    expect(block).toContain("s.state !== 'given'");
    expect(block).toContain("'fingerprint_consent_not_given'");
    for (const bypass of ['override', 'force', "b['", 'manager']) expect(block).not.toContain(bypass);
  });
  it('consent is only ever the person\'s own, and nothing stores fingerprint data or an identity number', () => {
    expect(route).toContain('if (ctx.userId !== employeeId)');
    const engine = strip(readFileSync('packages/workforce/src/biometric-consent.ts', 'utf8'));
    expect(`${route}\n${engine}`).not.toMatch(/template|minutiae|fingerprintImage|aadhaarNumber\s*:/i);
    expect(route).toContain('refuseIdentityNumbers(ctx.body)');
  });
});

describe('OB-197: fingerprint consent rests on a notice the owner signed', () => {
  const notice = (noticeRef: string) => ({ noticeRef, status: 'signed_by_owner' as const, documentPath: 'docs/requirements/C21_FINGERPRINT_CONSENT_NOTICE_DRAFT_2026-10-18.md', signedBy: 'u-owner', signedAt: '2026-10-18T00:00:00Z' });
  it('no signed notice → refused by name (consent_notice_not_signed), PIN only — whatever was recorded', () => {
    const none = signedNoticeRefs([]);
    expect(fingerprintVerdict([], 'u-anu', none)).toMatchObject({ allowed: false, code: 'consent_notice_not_signed' });
    expect(fingerprintVerdict([ev('1', 'given', '2026-10-01T00:00:00Z')], 'u-anu', none)).toMatchObject({ allowed: false, code: 'consent_notice_not_signed' });
    expect(methodsAllowedNow(fingerprintVerdict([ev('1', 'given', '2026-10-01T00:00:00Z')], 'u-anu', none))).toEqual(['pin']);
  });
  it('a signed notice: given on it → fingerprint and PIN; given on another, unsigned notice → refused; not given → consent not given', () => {
    const signed = signedNoticeRefs([notice('v1')]);
    expect(fingerprintVerdict([ev('1', 'given', '2026-10-01T00:00:00Z')], 'u-anu', signed)).toEqual({ allowed: true, noticeRef: 'v1' });
    expect(methodsAllowedNow(fingerprintVerdict([ev('1', 'given', '2026-10-01T00:00:00Z')], 'u-anu', signed))).toEqual(['fingerprint', 'pin']);
    const onDraft = [{ ...ev('1', 'given', '2026-10-01T00:00:00Z'), noticeRef: 'v2-draft' }];
    expect(fingerprintVerdict(onDraft, 'u-anu', signed)).toMatchObject({ allowed: false, code: 'consent_notice_not_signed' });
    expect(fingerprintVerdict([], 'u-anu', signed)).toMatchObject({ allowed: false, code: 'fingerprint_consent_not_given' });
    expect(fingerprintVerdict([ev('1', 'given', '2026-10-01T00:00:00Z'), ev('2', 'withdrawn', '2026-10-02T00:00:00Z')], 'u-anu', signed)).toMatchObject({ allowed: false, code: 'fingerprint_consent_not_given' });
  });
  it('guardrail: only the owner role records a signed notice, and giving consent checks the signed notice — no override', () => {
    const holders = ROLE_CATALOGUE.filter((r) => r.permissions.includes('workforce.consent.notice.sign')).map((r) => r.id);
    expect(holders).toEqual([OWNER_ROLE_ID]);
    const strip = (x: string) => x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const route = strip(readFileSync('services/finance/src/biometric-consent.ts', 'utf8'));
    expect(route).toContain("permission: 'workforce.consent.notice.sign'");
    const at = route.indexOf("if (b['decision'] === 'given'");
    expect(at).toBeGreaterThan(0);
    const block = route.slice(at, route.indexOf('const e: BiometricConsentEvent', at));
    expect(block).toContain("'consent_notice_not_signed'");
    for (const bypass of ['override', 'force', 'manager']) expect(block).not.toContain(bypass);
    const mark = route.slice(route.indexOf("if (method === 'fingerprint')"), route.indexOf('const now = deps.now()'));
    expect(mark).toContain('fingerprintVerdict(');
  });
});
