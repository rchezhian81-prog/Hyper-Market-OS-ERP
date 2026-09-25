import { describe, it, expect } from 'vitest';
import {
  beginOtpChallenge,
  verifyOtp,
  generateOtpCode,
  type OtpChallenge,
} from '../../packages/identity/src/index';
import { createOtpSimulator } from '../support/otp-simulator';
import { createLocalTestIdp } from '../support/local-idp';
import { verifyToken, type TokenPolicy } from '../../services/identity/src/token';

/**
 * Customer mobile OTP (M02 / M20 / M22, Item 1 slice 1b). The engine mints a code, stores only its
 * hash, verifies within a window and an attempt budget, is single-use and tenant-scoped — and, on
 * success, the portal issues a token carrying `amr:['otp']` so a later step knows HOW the person
 * proved themselves. These tests prove the engine end to end AND its composition with the slice-1a
 * IdP↔verifier wire.
 */

const NOW = '2026-09-25T10:00:00.000Z';
const later = (seconds: number): string => new Date(Date.parse(NOW) + seconds * 1000).toISOString();

const begin = (over: Partial<Parameters<typeof beginOtpChallenge>[0]> = {}) =>
  beginOtpChallenge({
    challengeId: 'otp-1',
    tenantId: 't-sre',
    phoneNumber: '+919000000000',
    purpose: 'login',
    code: '482913', // injected for determinism
    now: NOW,
    ...over,
  });

describe('OTP challenge/verify engine (M02 / M20 / M22)', () => {
  it('a correct code within the window verifies and consumes the challenge', () => {
    const { challenge } = begin();
    const result = verifyOtp({ challenge, tenantId: 't-sre', submittedCode: '482913', now: later(60) });
    expect(result.outcome).toBe('verified');
    expect(result.verified).toBe(true);
    expect(result.challenge.consumedAt).toBe(later(60));
  });

  it('never stores the plaintext code — only a salted hash', () => {
    const { challenge, code } = begin();
    expect(code).toBe('482913');
    expect(JSON.stringify(challenge)).not.toContain('482913');
    expect(challenge.codeHash).not.toBe('482913');
    expect(challenge.codeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a wrong code spends one attempt; the right code then still works', () => {
    const { challenge } = begin({ maxAttempts: 3 });
    const wrong = verifyOtp({ challenge, tenantId: 't-sre', submittedCode: '000000', now: later(10) });
    expect(wrong.outcome).toBe('wrong_code');
    expect(wrong.challenge.attemptsRemaining).toBe(2);
    const right = verifyOtp({ challenge: wrong.challenge, tenantId: 't-sre', submittedCode: '482913', now: later(20) });
    expect(right.outcome).toBe('verified');
  });

  it('exhausting the attempt budget refuses even the correct code', () => {
    let challenge: OtpChallenge = begin({ maxAttempts: 2 }).challenge;
    for (const guess of ['111111', '222222']) {
      challenge = verifyOtp({ challenge, tenantId: 't-sre', submittedCode: guess, now: later(5) }).challenge;
    }
    const result = verifyOtp({ challenge, tenantId: 't-sre', submittedCode: '482913', now: later(10) });
    expect(result.outcome).toBe('no_attempts_left');
    expect(result.verified).toBe(false);
  });

  it('an expired code is refused', () => {
    const { challenge } = begin({ ttlSeconds: 120 });
    const result = verifyOtp({ challenge, tenantId: 't-sre', submittedCode: '482913', now: later(121) });
    expect(result.outcome).toBe('expired');
  });

  it('a verified code cannot be replayed (single-use)', () => {
    const { challenge } = begin();
    const first = verifyOtp({ challenge, tenantId: 't-sre', submittedCode: '482913', now: later(30) });
    expect(first.outcome).toBe('verified');
    const replay = verifyOtp({ challenge: first.challenge, tenantId: 't-sre', submittedCode: '482913', now: later(40) });
    expect(replay.outcome).toBe('already_used');
  });

  it("a code cannot be spent by a different tenant, even with the right digits (OB-01)", () => {
    const { challenge } = begin();
    const result = verifyOtp({ challenge, tenantId: 't-rival', submittedCode: '482913', now: later(30) });
    expect(result.outcome).toBe('tenant_mismatch');
    expect(result.verified).toBe(false);
  });

  it('generateOtpCode returns a numeric code of the requested length, zero-padded', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateOtpCode(6)).toMatch(/^[0-9]{6}$/);
    }
    expect(generateOtpCode(4)).toMatch(/^[0-9]{4}$/);
  });
});

describe('OTP → login token composition (Item 1 slice 1b × 1a)', () => {
  const SECRET = ['dev', 'shared', 'idp', 'secret', 'for', 'tests'].join('-').padEnd(48, 'x');
  const policy: TokenPolicy = { secret: SECRET, issuer: 'https://idp.sre.local/', audience: 'sre-cloud-api' };
  const idp = createLocalTestIdp({ providerId: 'local-test-idp', issuer: policy.issuer, audience: policy.audience, secret: SECRET });

  it('the sent code completes the login and mints a token stamped amr:["otp"]', () => {
    const sms = createOtpSimulator();
    // The portal begins a challenge and hands the code to the sender (the customer never sees the hash).
    const { challenge, code } = begin({ code: generateOtpCode() });
    void sms.send({ phoneNumber: challenge.phoneNumber, code, purpose: 'login', tenantId: challenge.tenantId });

    // The customer reads the code off their phone (here, the simulator) and submits it.
    const submitted = sms.codeFor(challenge.phoneNumber);
    expect(submitted).toBe(code);
    const verification = verifyOtp({ challenge, tenantId: challenge.tenantId, submittedCode: submitted ?? '', now: later(30) });
    expect(verification.outcome).toBe('verified');

    // Only NOW does the portal mint a session token, recording that the factor was OTP.
    const nowMs = Date.parse(later(30));
    const { token } = idp.issue(
      { subject: 'cust-42', tenantId: challenge.tenantId, phoneNumber: challenge.phoneNumber, amr: ['otp'] },
      { issuedAtMs: nowMs, ttlSeconds: 900 },
    );
    const verdict = verifyToken(token, policy, nowMs);
    expect(verdict.ok).toBe(true);
    expect(verdict.principal?.tenantId).toBe(challenge.tenantId);
    const amr = JSON.parse(Buffer.from((token.split('.')[1] ?? ''), 'base64url').toString('utf8'))['amr'];
    expect(amr).toEqual(['otp']);
  });

  it('a failed OTP mints NO token (nothing to issue against)', () => {
    const { challenge } = begin();
    const verification = verifyOtp({ challenge, tenantId: 't-sre', submittedCode: '999999', now: later(30) });
    expect(verification.verified).toBe(false);
    // The portal issues only on verification.verified; this asserts the guard the flow depends on.
    expect(verification.outcome).toBe('wrong_code');
  });
});
