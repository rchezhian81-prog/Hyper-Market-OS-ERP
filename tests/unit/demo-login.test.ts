// DEMO-ONLY sign-in (hosted demo pilot, defect H-01). Proves: it mints exactly what the REAL API
// verifier accepts, only for synthetic pilot-* users, in a Secure/HttpOnly/SameSite=Strict cookie,
// single-factor (so step-up routes still refuse it); wrong passwords are refused and throttled with
// no user enumeration; no open redirect; no cross-site form posts; and it refuses to start anywhere
// but the synthetic demo tenant.

import { describe, it, expect } from 'vitest';
import { verifyToken } from '../../services/identity/src/token';
import { PILOT_DEMO_TENANT } from '../../db/seed/pilot/dataset';
import {
  addLogin, COOKIE_NAME, createDemoLoginHandler, FailureThrottle, generatePassword, loginFileProblems,
  passwordMatches, hashPassword, safeNext, SESSION_SECONDS, startupRefusals,
  type DemoLoginFile, type LoginRequest,
} from '../../infra/pilot/demo-login/login';

const IDP = {
  secret: ['demo', 'login', 'unit', 'test', 'key'].join('-').padEnd(48, '0'),
  issuer: 'https://pilot-idp.test',
  audience: 'sre-retail-os-api',
};
const NOW = Date.parse('2026-09-27T10:00:00Z');
const PASSWORD = ['Correct', 'Horse', '42'].join('-');
const FILE: DemoLoginFile = addLogin({ version: 1, logins: [] }, {
  login: 'ravi.cashier', userId: 'pilot-cashier', password: PASSWORD, createdBy: 'test', now: new Date(NOW),
});

function setup(nowMs = NOW) {
  let now = nowMs;
  const audit: Record<string, unknown>[] = [];
  const handle = createDemoLoginHandler({
    logins: () => FILE, idp: IDP, throttle: new FailureThrottle(), now: () => now, audit: (l) => { audit.push(l); },
  });
  return { handle, audit, advance: (ms: number) => { now += ms; } };
}

const HOST = '45.195.229.215';
const post = (body: Record<string, string>, headers: Record<string, string> = {}): LoginRequest => ({
  method: 'POST', url: '/login/', body: new URLSearchParams(body).toString(),
  headers: { host: HOST, origin: `https://${HOST}`, 'x-forwarded-for': '203.0.113.9', ...headers },
});
const tokenFrom = (setCookie: string | string[] | undefined): string =>
  String(setCookie).split(';')[0]!.slice(`${COOKIE_NAME}=`.length);

describe('demo sign-in — a good sign-in', () => {
  it('sets a Secure, HttpOnly, SameSite=Strict session cookie and returns to the shell', () => {
    const { handle } = setup();
    const res = handle(post({ login: 'ravi.cashier', password: PASSWORD, next: '/pos/' }));
    expect(res.status).toBe(303);
    expect(res.headers['location']).toBe('/pos/');
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(new RegExp(`^${COOKIE_NAME}=`));
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', `Max-Age=${SESSION_SECONDS}`]) expect(cookie).toContain(attr);
  });

  it('mints a token the REAL API verifier accepts, as the mapped synthetic user in the demo tenant', () => {
    const { handle } = setup();
    const res = handle(post({ login: 'RAVI.cashier ', password: PASSWORD }));
    const verdict = verifyToken(tokenFrom(res.headers['set-cookie']), IDP, NOW);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.principal?.userId).toBe('pilot-cashier');
    expect(verdict.principal?.tenantId).toBe(PILOT_DEMO_TENANT);
  });

  it('is honestly single-factor — amr is pwd only, so a step-up (MFA) route still refuses it', () => {
    const { handle } = setup();
    const verdict = verifyToken(tokenFrom(handle(post({ login: 'ravi.cashier', password: PASSWORD })).headers['set-cookie']), IDP, NOW);
    expect(verdict.ok && verdict.principal?.amr).toEqual(['pwd']);
  });

  it('expires after one shift', () => {
    const { handle } = setup();
    const token = tokenFrom(handle(post({ login: 'ravi.cashier', password: PASSWORD })).headers['set-cookie']);
    expect(verifyToken(token, IDP, NOW + (SESSION_SECONDS + 120) * 1000).ok).toBe(false);
  });

  it('records the sign-in on the audit trail, never the password', () => {
    const { handle, audit } = setup();
    handle(post({ login: 'ravi.cashier', password: PASSWORD }));
    expect(audit).toEqual([expect.objectContaining({ event: 'demo_login_succeeded', login: 'ravi.cashier', userId: 'pilot-cashier' })]);
    expect(JSON.stringify(audit)).not.toContain(PASSWORD);
  });

  it('a signed-in visitor sees who they are and a sign-out; sign-out clears the cookie', () => {
    const { handle } = setup();
    const token = tokenFrom(handle(post({ login: 'ravi.cashier', password: PASSWORD })).headers['set-cookie']);
    const home = handle({ method: 'GET', url: '/login/', body: '', headers: { cookie: `a=b; ${COOKIE_NAME}=${token}` } });
    expect(home.status).toBe(200);
    expect(home.body).toContain('Signed in as pilot-cashier');
    const out = handle({ method: 'POST', url: '/login/logout', body: '', headers: { host: HOST, origin: `https://${HOST}` } });
    expect(out.status).toBe(303);
    expect(String(out.headers['set-cookie'])).toMatch(/Max-Age=0/);
  });
});

describe('demo sign-in — refusals', () => {
  it('a wrong password and an unknown login get the SAME answer (no user enumeration)', () => {
    const { handle } = setup();
    const wrong = handle(post({ login: 'ravi.cashier', password: 'nope' }));
    const unknown = handle(post({ login: 'nobody.here', password: 'nope' }));
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toBe(unknown.body);
    expect(wrong.headers['set-cookie']).toBeUndefined();
  });

  it('locks after 5 failures — even the right password — and unlocks after the wait', () => {
    const { handle, audit, advance } = setup();
    for (let i = 0; i < 5; i += 1) handle(post({ login: 'ravi.cashier', password: `bad-${i}` }));
    const locked = handle(post({ login: 'ravi.cashier', password: PASSWORD }));
    expect(locked.status).toBe(429);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    expect(audit.some((a) => a['event'] === 'demo_login_locked')).toBe(true);
    advance(31_000);
    expect(handle(post({ login: 'ravi.cashier', password: PASSWORD })).status).toBe(303);
  });

  it('refuses a cross-site form post (and an opaque origin)', () => {
    const { handle } = setup();
    expect(handle(post({ login: 'ravi.cashier', password: PASSWORD }, { origin: 'https://evil.example' })).status).toBe(403);
    expect(handle(post({ login: 'ravi.cashier', password: PASSWORD }, { origin: 'null' })).status).toBe(403);
  });

  it('never redirects off-site (no open redirect)', () => {
    for (const bad of ['https://evil.example/', '//evil.example/', '/\\evil.example', 'javascript:alert(1)', '/v1/identity/grants']) {
      expect(safeNext(bad)).toBe('/erp/');
    }
    expect(safeNext('/supplier/')).toBe('/supplier/');
    expect(safeNext(undefined)).toBe('/erp/');
  });

  it('escapes what it echoes back into the page', () => {
    const { handle } = setup();
    const res = handle({ method: 'GET', url: '/login/?next=/erp/%22%3E%3Cscript%3E', body: '', headers: {} });
    expect(res.body).not.toContain('"><script>');
  });

  it('serves a strict content-security policy and no-store', () => {
    const res = setup().handle({ method: 'GET', url: '/login/', body: '', headers: {} });
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it("uses Referrer-Policy same-origin — under no-referrer a browser posts the form with Origin: null and every sign-in is refused", () => {
    const res = setup().handle({ method: 'GET', url: '/login/', body: '', headers: {} });
    expect(res.headers['referrer-policy']).toBe('same-origin');
  });
});

describe('demo sign-in — credentials', () => {
  it('stores only an scrypt hash, and verifies it', () => {
    expect(JSON.stringify(FILE)).not.toContain(PASSWORD);
    expect(passwordMatches(PASSWORD, FILE.logins[0]!)).toBe(true);
    expect(passwordMatches('wrong', FILE.logins[0]!)).toBe(false);
    const a = hashPassword('same');
    const b = hashPassword('same');
    expect(a.salt).not.toBe(b.salt); // salted: the same password never hashes the same twice
  });

  it('generates strong, unambiguous passwords', () => {
    const p = generatePassword();
    expect(p).toMatch(/^[a-km-zA-HJ-NP-Z2-9]{16}$/);
    expect(generatePassword()).not.toBe(p);
  });

  it('only synthetic pilot-* users, one login per person, one person per login', () => {
    const base = { password: 'x', createdBy: 't', now: new Date(NOW) };
    expect(() => addLogin(FILE, { ...base, login: 'owner.real', userId: 'sre-owner' })).toThrow(/not a synthetic pilot-\* user/);
    expect(() => addLogin(FILE, { ...base, login: 'ravi.cashier', userId: 'pilot-manager' })).toThrow(/appears twice/);
    expect(() => addLogin(FILE, { ...base, login: 'second.cashier', userId: 'pilot-cashier' })).toThrow(/more than one login/);
    expect(loginFileProblems({ nope: true })).toEqual(['not a version-1 demo login file']);
    // The store box's machine identity can never become a person's login.
    expect(() => addLogin(FILE, { ...base, login: 'someone', userId: 'pilot-store-edge' })).toThrow(/machine identity/);
  });
});

describe('demo sign-in — refuses to start anywhere but the demo', () => {
  const good = {
    DEMO_LOGIN_ENABLED: '1', DEMO_TENANT_ID: PILOT_DEMO_TENANT, MIGRATION_TARGET_KIND: 'rehearsal',
    IDP_SIGNING_KEY: 'k'.repeat(48), IDP_ISSUER: 'https://i', IDP_AUDIENCE: 'a',
  };
  it('starts with the demo settings', () => { expect(startupRefusals(good)).toEqual([]); });
  it('is OFF unless deliberately enabled', () => {
    expect(startupRefusals({ ...good, DEMO_LOGIN_ENABLED: undefined })).toEqual([expect.stringMatching(/off unless/)]);
  });
  it('never serves a real tenant, never production, never a placeholder key', () => {
    expect(startupRefusals({ ...good, DEMO_TENANT_ID: 'sre-hyper-market' })).toEqual([expect.stringMatching(/never serves a real tenant/)]);
    expect(startupRefusals({ ...good, MIGRATION_TARGET_KIND: 'production' })).toEqual([expect.stringMatching(/production/)]);
    expect(startupRefusals({ ...good, IDP_SIGNING_KEY: 'REPLACE_WITH_THE_TEST_IDP_KEY_xxxxxxxxxxxxx' })).toEqual([expect.stringMatching(/IDP_SIGNING_KEY/)]);
  });
});
