import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { consentStateOf, methodsAllowed, identityNumberFieldsIn, type BiometricConsentEvent } from '../../packages/workforce/src/biometric-consent';

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
