import { describe, it, expect } from 'vitest';
import {
  createCustomerSignInHandler, CUSTOMER_SESSION_COOKIE, CUSTOMER_STEP_UP_POLICY, NO_SIGNER, NO_SMS_PROVIDER,
  type CustomerSessionSigner, type CustomerSignInDeps, type CustomerSignInRequest, type CustomerSignInResponse,
} from '../../services/identity/src/customer-sign-in';
import { customerSignInSettingsProblems } from '../../services/identity/src/customer-sign-in-main';
import { createOtpSimulator } from '../support/otp-simulator';

/**
 * **The customer sign-in service: a code to the customer's phone, on the shared OTP engine (M20-FR-01 · WF-13 · OB-222 ·
 * SEC-03/04 · ADR-0031 · hard rule #4).**
 *
 * It proves: with no SMS provider (the product as shipped) asking for a code is REFUSED in plain words and nothing is
 * sent; with no signer, likewise; with the recording SMS transport and a test signer a customer signs in, the session
 * lives on the server behind an HttpOnly + Secure + SameSite=Strict cookie scoped to /auth/otp/, a reload gets a current
 * token again, a money change needs more than a code, and sign-out ends the session so the old cookie is refused; codes
 * are single use; the number and the address are rate-limited and locked out after wrong codes; a request from another
 * site is refused; and NO phone number and NO code reach a log line.
 */

const ORIGIN = 'https://shop.example.test';
const PHONE = '9876543210';
const PHONE_TYPED = '+91 98765 43210';

function rig(over: Partial<CustomerSignInDeps> = {}) {
  const clock = { now: Date.parse('2026-10-27T10:00:00.000Z') };
  const sms = createOtpSimulator();
  const audit: Record<string, unknown>[] = [];
  let n = 0;
  const signer: CustomerSessionSigner & { calls: number } = {
    name: 'test signer', calls: 0,
    signIn: async ({ phoneNumber, authTimeMs }) => { signer.calls += 1; return { subject: `cust-${phoneNumber.slice(-4)}`, token: `tok-${signer.calls}-${authTimeMs}`, expiresAtMs: clock.now + 600_000 }; },
  };
  const handle = createCustomerSignInHandler({
    tenantId: 't-sre', origin: ORIGIN, sender: sms, signer, stepUp: CUSTOMER_STEP_UP_POLICY,
    now: () => clock.now, audit: (l) => { audit.push(l); }, randomId: (b) => `id${(n += 1)}-${'x'.repeat(b)}`, ...over,
  });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}, address = '203.0.113.7'): Promise<CustomerSignInResponse> => handle({
    method: 'POST', url: path, body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-forwarded-for': address, ...headers },
  } as CustomerSignInRequest);
  const parse = (r: CustomerSignInResponse) => JSON.parse(r.body) as Record<string, unknown> & { error?: { code: string; whatHappened: string } };
  const cookieOf = (r: CustomerSignInResponse): string => /sre_customer_session=([^;]*)/.exec(r.headers['set-cookie'] ?? '')?.[1] ?? '';
  const signIn = async (): Promise<{ cookie: string; body: Record<string, unknown> }> => {
    const b = parse(await post('/auth/otp/begin', { phoneNumber: PHONE_TYPED }));
    const v = await post('/auth/otp/verify', { challengeId: b['challengeId'], code: sms.codeFor(PHONE) });
    expect(v.status).toBe(200);
    return { cookie: cookieOf(v), body: parse(v) };
  };
  return { clock, sms, audit, signer, handle, post, parse, cookieOf, signIn };
}

describe('the customer sign-in service', () => {
  it('with NO SMS provider (as shipped, OB-222) asking for a code is refused in plain words and nothing is sent', async () => {
    const r = rig({ sender: undefined });
    const out = await r.post('/auth/otp/begin', { phoneNumber: PHONE });
    expect(out.status).toBe(503);
    expect(r.parse(out)).toMatchObject({ ok: false, reason: 'sms_provider_not_configured', error: NO_SMS_PROVIDER });
    expect(r.parse(out).error?.whatHappened).toContain('No code was sent');
    expect(r.signer.calls).toBe(0);
  });

  it('with NO signer chosen (ADR-0031) asking for a code is refused before anything is sent', async () => {
    const r = rig({ signer: undefined });
    const out = await r.post('/auth/otp/begin', { phoneNumber: PHONE });
    expect(out.status).toBe(503);
    expect(r.parse(out).error).toEqual(NO_SIGNER);
    expect(r.sms.codeFor(PHONE)).toBeUndefined();
    expect((await r.post('/auth/otp/verify', { challengeId: 'x', code: '123456' })).status).toBe(503);
  });

  it('signs a customer in: the code reaches the phone, the session cookie is HttpOnly, Secure, SameSite=Strict and scoped', async () => {
    const r = rig();
    const begin = await r.post('/auth/otp/begin', { phoneNumber: PHONE_TYPED });
    expect(begin.status).toBe(200);
    const b = r.parse(begin);
    expect(b['ok']).toBe(true);
    expect(JSON.stringify(b)).not.toContain(r.sms.codeFor(PHONE)!); // the code goes to the phone, never to the page
    const verify = await r.post('/auth/otp/verify', { challengeId: b['challengeId'], code: r.sms.codeFor(PHONE) });
    expect(verify.status).toBe(200);
    expect(r.parse(verify)).toMatchObject({ ok: true, token: expect.stringMatching(/^tok-1-/) });
    const set = verify.headers['set-cookie']!;
    expect(set).toMatch(new RegExp(`^${CUSTOMER_SESSION_COOKIE}=[^;]+; Path=/auth/otp/; Max-Age=43200; HttpOnly; Secure; SameSite=Strict$`));
    expect(verify.headers['cache-control']).toBe('no-store');
  });

  it('a code is single use, a wrong one spends a try, and an unknown challenge is refused', async () => {
    const r = rig();
    const b = r.parse(await r.post('/auth/otp/begin', { phoneNumber: PHONE }));
    const code = r.sms.codeFor(PHONE)!;
    const wrong = code === '000000' ? '111111' : '000000';
    const w = await r.post('/auth/otp/verify', { challengeId: b['challengeId'], code: wrong });
    expect(w.status).toBe(401);
    expect(r.parse(w).reason).toBe('wrong_code');
    expect((await r.post('/auth/otp/verify', { challengeId: b['challengeId'], code })).status).toBe(200);
    const again = await r.post('/auth/otp/verify', { challengeId: b['challengeId'], code });
    expect(again.status).toBe(400);
    expect(r.parse(again).reason).toBe('no_such_code');
  });

  it('a code runs out after five minutes', async () => {
    const r = rig();
    const b = r.parse(await r.post('/auth/otp/begin', { phoneNumber: PHONE }));
    r.clock.now += 5 * 60_000 + 1_000;
    const out = await r.post('/auth/otp/verify', { challengeId: b['challengeId'], code: r.sms.codeFor(PHONE) });
    expect(out.status).toBe(400); // swept: an expired code is simply gone
  });

  it('refuses a number that is not a 10-digit Indian mobile', async () => {
    const r = rig();
    const out = await r.post('/auth/otp/begin', { phoneNumber: '12345' });
    expect(out.status).toBe(400);
    expect(r.parse(out).reason).toBe('not_a_mobile_number');
  });

  it('the session lives on the server: a reload gets a current token, sign-out ends it and the old cookie is refused', async () => {
    const r = rig();
    const { cookie } = await r.signIn();
    const reload = await r.post('/auth/otp/session', {}, { cookie: `${CUSTOMER_SESSION_COOKIE}=${cookie}` });
    expect(reload.status).toBe(200);
    expect(r.parse(reload)['token']).toMatch(/^tok-1-/);
    // Near its end the token is renewed from the signer, keeping the original sign-in time.
    r.clock.now += 9.5 * 60_000;
    const renewed = r.parse(await r.post('/auth/otp/session', {}, { cookie: `${CUSTOMER_SESSION_COOKIE}=${cookie}` }));
    expect(renewed['token']).toMatch(/^tok-2-/);
    const out = await r.post('/auth/otp/signout', {}, { cookie: `${CUSTOMER_SESSION_COOKIE}=${cookie}` });
    expect(r.parse(out)).toMatchObject({ ok: true, signedOut: true });
    expect(out.headers['set-cookie']).toMatch(/Max-Age=0; HttpOnly; Secure; SameSite=Strict/);
    const replay = await r.post('/auth/otp/session', {}, { cookie: `${CUSTOMER_SESSION_COOKIE}=${cookie}` });
    expect(replay.status).toBe(401);
    expect(r.parse(await r.post('/auth/otp/check', { action: 'view_orders' }, { cookie: `${CUSTOMER_SESSION_COOKIE}=${cookie}` }))['outcome']).toBe('session_invalid');
  });

  it('a session ends after twelve hours whatever the token says', async () => {
    const r = rig();
    const { cookie } = await r.signIn();
    r.clock.now += 12 * 3600_000 + 1_000;
    expect((await r.post('/auth/otp/session', {}, { cookie: `${CUSTOMER_SESSION_COOKIE}=${cookie}` })).status).toBe(401);
  });

  it('an SMS-code session may view orders; a money change needs the app-based factor (step-up)', async () => {
    const r = rig();
    const { cookie } = await r.signIn();
    const c = { cookie: `${CUSTOMER_SESSION_COOKIE}=${cookie}` };
    expect(r.parse(await r.post('/auth/otp/check', { action: 'view_orders' }, c))['outcome']).toBe('allowed');
    expect(r.parse(await r.post('/auth/otp/check', { action: 'change_bank_details' }, c))['outcome']).toBe('needs_second_factor');
  });

  it('caps codes per number: three back-to-back, then one every ten minutes', async () => {
    const r = rig();
    for (let i = 0; i < 3; i += 1) expect((await r.post('/auth/otp/begin', { phoneNumber: PHONE }, {}, `198.51.100.${i}`)).status).toBe(200);
    const fourth = await r.post('/auth/otp/begin', { phoneNumber: PHONE }, {}, '198.51.100.9');
    expect(fourth.status).toBe(429);
    expect(r.parse(fourth).reason).toBe('too_many_tries');
    expect(Number(fourth.headers['retry-after'])).toBeGreaterThan(0);
    r.clock.now += 600_000;
    expect((await r.post('/auth/otp/begin', { phoneNumber: PHONE }, {}, '198.51.100.9')).status).toBe(200);
  });

  it('caps codes per address: ten numbers from one connection, then refused', async () => {
    const r = rig();
    for (let i = 0; i < 10; i += 1) expect((await r.post('/auth/otp/begin', { phoneNumber: `98765432${String(i).padStart(2, '0')}` })).status).toBe(200);
    expect((await r.post('/auth/otp/begin', { phoneNumber: '9876543299' })).status).toBe(429);
  });

  it('locks a number out after five wrong codes — even from new addresses and with a fresh code — and lifts after the cool-down', async () => {
    const r = rig();
    const wrongFor = (code: string) => (code === '000000' ? '111111' : '000000');
    let b = r.parse(await r.post('/auth/otp/begin', { phoneNumber: PHONE }, {}, '192.0.2.1'));
    for (let i = 0; i < 5; i += 1) {
      if (i === 3) b = r.parse(await r.post('/auth/otp/begin', { phoneNumber: PHONE }, {}, '192.0.2.1'));
      expect((await r.post('/auth/otp/verify', { challengeId: b['challengeId'], code: wrongFor(r.sms.codeFor(PHONE)!) }, {}, `192.0.2.${10 + i}`)).status).toBe(401);
    }
    // Locked: the right code is refused, and no new code is sent.
    const right = await r.post('/auth/otp/verify', { challengeId: b['challengeId'], code: r.sms.codeFor(PHONE) }, {}, '192.0.2.99');
    expect(right.status).toBe(429);
    expect((await r.post('/auth/otp/begin', { phoneNumber: PHONE }, {}, '192.0.2.98')).status).toBe(429);
    r.clock.now += 5 * 60_000 + 1_000;
    const fresh = r.parse(await r.post('/auth/otp/begin', { phoneNumber: PHONE }, {}, '192.0.2.97'));
    expect(fresh['ok']).toBe(true);
    expect((await r.post('/auth/otp/verify', { challengeId: fresh['challengeId'], code: r.sms.codeFor(PHONE) }, {}, '192.0.2.97')).status).toBe(200);
  });

  it('locks an address out after ten wrong codes across numbers', async () => {
    const r = rig();
    for (let i = 0; i < 10; i += 1) expect((await r.post('/auth/otp/verify', { challengeId: `guess-${i}`, code: '123456' })).status).toBe(400);
    expect((await r.post('/auth/otp/verify', { challengeId: 'guess-x', code: '123456' })).status).toBe(429);
  });

  it('refuses a request from another site, a non-JSON body and a GET', async () => {
    const r = rig();
    expect((await r.post('/auth/otp/begin', { phoneNumber: PHONE }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await r.post('/auth/otp/begin', { phoneNumber: PHONE }, { origin: 'null' })).status).toBe(403);
    expect((await r.post('/auth/otp/begin', { phoneNumber: PHONE }, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await r.handle({ method: 'GET', url: '/auth/otp/begin', headers: {}, body: '' })).status).toBe(405);
    expect(r.sms.codeFor(PHONE)).toBeUndefined();
  });

  it('a failed SMS send keeps no waiting code and says so', async () => {
    const r = rig({ sender: { channel: 'sms', send: () => { throw new Error('provider down'); } } });
    const out = await r.post('/auth/otp/begin', { phoneNumber: PHONE });
    expect(out.status).toBe(502);
    expect(r.parse(out).reason).toBe('code_not_sent');
  });

  it('a signer that refuses leaves the customer signed out, said plainly', async () => {
    const r = rig({ signer: { name: 'down', signIn: async () => { throw new Error('identity server unreachable'); } } });
    const b = r.parse(await r.post('/auth/otp/begin', { phoneNumber: PHONE }));
    const out = await r.post('/auth/otp/verify', { challengeId: b['challengeId'], code: r.sms.codeFor(PHONE) });
    expect(out.status).toBe(503);
    expect(out.headers['set-cookie']).toBeUndefined();
  });

  it('NO phone number, NO code, NO challenge id and NO token reach any log line', async () => {
    const r = rig();
    const { body } = await r.signIn();
    const b = r.parse(await r.post('/auth/otp/begin', { phoneNumber: PHONE }));
    await r.post('/auth/otp/verify', { challengeId: b['challengeId'], code: '000001' });
    await r.post('/auth/otp/signout', {});
    const log = JSON.stringify(r.audit);
    expect(r.audit.map((l) => l['event'])).toEqual(expect.arrayContaining(['customer_code_sent', 'customer_signed_in', 'customer_sign_in_refused']));
    expect(log).not.toContain(PHONE);
    expect(log).not.toContain('98765');
    expect(log).not.toContain(r.sms.codeFor(PHONE)!);
    expect(log).not.toContain(String(b['challengeId']));
    expect(log).not.toContain(String(body['token']));
  });

  it('the process refuses to start without its origin (https) and its shop', () => {
    expect(customerSignInSettingsProblems({})).toHaveLength(2);
    expect(customerSignInSettingsProblems({ CUSTOMER_SIGN_IN_ORIGIN: 'http://shop.example', CUSTOMER_SIGN_IN_TENANT_ID: 't' })[0]).toContain('must be an https address');
    expect(customerSignInSettingsProblems({ CUSTOMER_SIGN_IN_ORIGIN: ORIGIN, CUSTOMER_SIGN_IN_TENANT_ID: 't' })).toEqual([]);
  });
});
