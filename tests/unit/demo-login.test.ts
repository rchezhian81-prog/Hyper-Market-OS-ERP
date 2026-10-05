// DEMO-ONLY sign-in (hosted demo pilot, defect H-01). Proves: it mints exactly what the REAL API
// verifier accepts, only for synthetic pilot-* users, in a Secure/HttpOnly/SameSite=Strict cookie,
// single-factor (so step-up routes still refuse it); wrong passwords are refused and throttled with
// no user enumeration; no open redirect; no cross-site form posts; and it refuses to start anywhere
// but the synthetic demo tenant.

import { describe, it, expect } from 'vitest';
import { verifyToken } from '../../services/identity/src/token';
import { PILOT_DEMO_TENANT } from '../../db/seed/pilot/dataset';
import {
  addLogin, COOKIE_GRACE_SECONDS, COOKIE_NAME, createDemoLoginHandler, FailureThrottle, generatePassword, loginFileProblems,
  passwordMatches, hashPassword, safeNext, SESSION_SECONDS, startupRefusals, WRONG_CREDENTIALS,
  type DemoLoginFile, type LoginRequest,
} from '../../infra/pilot/demo-login/login';
import {
  COPY_KEYS, LOGIN_COPY, LOGIN_CSS, LOGIN_CSS_PATH, LOGIN_CSS_VERSION, LOGIN_JS, LOGIN_JS_PATH, LOGIN_JS_VERSION,
} from '../../infra/pilot/demo-login/ui';

const IDP = {
  secret: ['demo', 'login', 'unit', 'test', 'key'].join('-').padEnd(48, '0'),
  issuer: 'https://pilot-idp.test',
  audience: 'sre-retail-os-api',
};
const NOW = Date.parse('2026-09-27T10:00:00Z');
const PASSWORD = ['Correct', 'Horse', '42'].join('-');
const WRONG = ['wrong', 'one', '7'].join('-');
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

const HOST = 'demo.example'; // any host name: the sign-in compares Origin against the Host it was reached by
const post = (body: Record<string, string>, headers: Record<string, string> = {}): LoginRequest => ({
  method: 'POST', url: '/login/', body: new URLSearchParams(body).toString(),
  headers: { host: HOST, origin: `https://${HOST}`, 'x-forwarded-for': '203.0.113.10', ...headers },
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
    // The cookie outlives the token by a day of grace, so the next visit can say "your session has ended" and drop it.
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', `Max-Age=${SESSION_SECONDS + COOKIE_GRACE_SECONDS}`]) expect(cookie).toContain(attr);
  });

  it('with no screen asked for, lands IN the product — the store workspace — never on a list of shells (OB-16)', () => {
    const { handle } = setup();
    const res = handle(post({ login: 'ravi.cashier', password: PASSWORD }));
    expect(res.status).toBe(303);
    expect(res.headers['location']).toBe('/store/manager/');
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
    expect(home.body).toMatch(/Signed in as<\/span> pilot-cashier</);
    // The account page (OB-16): who you are, ONE way into the product, sign out — no list of shells, no second world.
    expect(home.body).toContain('href="/store/manager/"');
    expect(home.body).toContain('Open the store workspace');
    expect(home.body).not.toContain('Live on this demo');
    expect(home.body).not.toContain('Not on this demo yet');
    expect(home.body).not.toContain('href="/erp/');
    expect(home.body).not.toMatch(/demo/i);
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
      expect(safeNext(bad)).toBe('/store/manager/');
    }
    expect(safeNext('/supplier/')).toBe('/supplier/');
    expect(safeNext('/login/')).toBe('/login/');
    // No particular screen asked for → the product itself: the store computer's workspace (OB-16).
    expect(safeNext(undefined)).toBe('/store/manager/');
  });

  it('escapes what it echoes back into the page', () => {
    const { handle } = setup();
    const res = handle({ method: 'GET', url: '/login/?next=/erp/%22%3E%3Cscript%3E', body: '', headers: {} });
    expect(res.body).not.toContain('"><script>');
  });

  it('serves a strict content-security policy — self only, nothing inline — and no-store', () => {
    const res = setup().handle({ method: 'GET', url: '/login/', body: '', headers: {} });
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; style-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it("uses Referrer-Policy same-origin — under no-referrer a browser posts the form with Origin: null and every sign-in is refused", () => {
    const res = setup().handle({ method: 'GET', url: '/login/', body: '', headers: {} });
    expect(res.headers['referrer-policy']).toBe('same-origin');
  });
});

describe('demo sign-in — the page in the owner\'s approved design (UX-3 · OB-18)', () => {
  const GET = (url: string, headers: Record<string, string> = {}) => setup().handle({ method: 'GET', url, body: '', headers });

  it('wears the design: the S+ mark, the sage canvas, the white card, labelled inputs, ONE primary Sign in — and no word "demo"', () => {
    const { body } = GET('/login/');
    expect(body).toContain('<div id="sre-login" lang="en">');
    expect(body).toContain('<div class="sl-mark" aria-hidden="true">S<span>+</span></div>');
    expect(body).toContain('<div class="sl-login-card">');
    expect(body).toContain('<h1 id="sl-welcome" data-copy="welcome">Welcome back.</h1>');
    expect(body).toContain('<form id="sl-form" method="post" action="/login/">');
    expect(body).toContain('<label for="login" data-copy="staffId">');
    expect(body).toContain('<label for="password" data-copy="passwordLabel">');
    expect(body).toContain('autocomplete="username"');
    expect(body).toContain('autocomplete="current-password"');
    expect(body.match(/type="submit"/g)).toHaveLength(1);
    expect(body).toMatch(/<button id="sl-submit" class="sl-submit" type="submit">/); // enabled by the server: the form works with no script
    expect(body).toMatch(/<h1[ >]/g);
    expect(body.match(/<h1[ >]/g)).toHaveLength(1);
    expect(body).not.toMatch(/demo/i);
    // Never a role selector before sign-in, never "Remember me", no sample values in the fields.
    expect(body).not.toMatch(/<select|remember me|value="[^"]+"\s+(?:id="login"|id="password")/i);
    expect(body).not.toMatch(/<input[^>]*id="(?:login|password)"[^>]*\svalue=/);
  });

  it('nothing is inline and nothing is fetched from elsewhere: the stylesheet and the script are the service\'s own, under a content hash, long-cacheable', () => {
    const { body } = GET('/login/');
    expect(body).not.toMatch(/<style[\s>]/);
    expect(body).not.toMatch(/<script(?![^>]*\bsrc=)/);
    expect(body).not.toMatch(/\sstyle="/);
    expect(body).not.toMatch(/\son[a-z]+="/i);
    expect(body).not.toMatch(/https?:\/\//); // no CDN, no external font, no image from anywhere
    expect(body).toContain(`<link rel="stylesheet" href="${LOGIN_CSS_PATH}?v=${LOGIN_CSS_VERSION}">`);
    expect(body).toContain(`<script src="${LOGIN_JS_PATH}?v=${LOGIN_JS_VERSION}" defer></script>`);
    expect(LOGIN_CSS_VERSION).toMatch(/^[0-9a-f]{12}$/);

    const css = GET(`${LOGIN_CSS_PATH}?v=${LOGIN_CSS_VERSION}`);
    expect(css.status).toBe(200);
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(css.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(css.headers['x-content-type-options']).toBe('nosniff');
    expect(css.body).toBe(LOGIN_CSS);
    const js = GET(LOGIN_JS_PATH);
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(js.body).toBe(LOGIN_JS);
    expect(GET('/login/other.js').status).toBe(404);
    // The fonts are the system's (with Tamil coverage) — the stylesheet names no font file and no font host.
    expect(LOGIN_CSS).not.toMatch(/@font-face|url\(/);
    expect(LOGIN_CSS).toContain('"Noto Sans Tamil"');
    // The design system's floor (§3.2): no fixed size under 12.5px anywhere (uppercase letter-spaced labels), the practice strip at 14px.
    for (const m of LOGIN_CSS.matchAll(/font-size:(\d+(?:\.\d+)?)px/g)) expect(Number(m[1]), m[0]).toBeGreaterThanOrEqual(12.5);
    expect(LOGIN_CSS).toMatch(/\.sl-strip\{[^}]*font-size:14px/);
  });

  it('the connection line says only what this server knows — the ONLINE sign-in is available — and never claims offline access or a running store computer', () => {
    const { body } = GET('/login/');
    expect(body).toContain('data-copy="connectionOnline">Online sign-in available<');
    expect(body).not.toMatch(/offline access available|offline sign-in|store computer is (?:running|ready|online)/i);
    // No sample state, no preview picker, no simulated success — the prototype's demonstration gear stays out of the product.
    expect(body).not.toMatch(/data-state=|preview|sample|prototype|simulat/i);
    expect(LOGIN_JS).not.toMatch(/preview|simulat|setState\(|data-state/i);
  });

  it('the script never stores or sends a password: it keeps only the language choice', () => {
    expect(LOGIN_JS).toMatch(/localStorage\.setItem\('sre\.lang'/);
    expect(LOGIN_JS.match(/localStorage\.(?:setItem|getItem)\(/g)).toHaveLength(2); // the one key, read and written
    expect(LOGIN_JS).not.toMatch(/sessionStorage|document\.cookie|fetch\(|XMLHttpRequest|navigator\.sendBeacon|console\./);
    expect(LOGIN_JS).not.toMatch(/password\.value(?!\))/); // the password's VALUE is read only to check it is not empty
  });

  it('English and Tamil carry the same words: every key in both, none empty — and every visible sentence is marked for the switch', () => {
    expect(Object.keys(LOGIN_COPY.ta).sort()).toEqual([...COPY_KEYS].sort());
    for (const key of COPY_KEYS) {
      expect(LOGIN_COPY.en[key].trim(), key).not.toBe('');
      expect(LOGIN_COPY.ta[key].trim(), key).not.toBe('');
    }
    expect(LOGIN_JS).toContain('"ta":'); // the words travel with the script, so the switch needs no round trip
    const { body } = GET('/login/');
    for (const key of ['strip', 'help', 'eyebrow', 'hero1', 'hero2', 'heroCopy', 'staffAccess', 'welcome', 'subtitle', 'staffId', 'passwordLabel', 'needHelp', 'personal', 'details', 'footer', 'connectionOnline', 'gotIt'] as const) {
      expect(body, key).toContain(`data-copy="${key}"`);
    }
    expect(body).toContain('<button type="button" data-language="ta" lang="ta" aria-pressed="false">தமிழ்</button>');
  });

  it('a session that has ended is said so, once — the dead cookie is dropped; a first visit says nothing of the kind', () => {
    const { handle, advance } = setup();
    const token = tokenFrom(handle(post({ login: 'ravi.cashier', password: PASSWORD })).headers['set-cookie']);
    advance((SESSION_SECONDS + 60) * 1000);
    const back = handle({ method: 'GET', url: '/login/?next=/store/manager/', body: '', headers: { cookie: `${COOKIE_NAME}=${token}` } });
    expect(back.status).toBe(200);
    expect(back.body).toContain('data-copy="expired">Your session has ended. Sign in again to continue.<');
    expect(back.body).toContain('<input type="hidden" name="next" value="/store/manager/">');
    expect(String(back.headers['set-cookie'])).toMatch(/Max-Age=0/);
    const fresh = handle({ method: 'GET', url: '/login/', body: '', headers: {} });
    expect(fresh.body).not.toContain('data-copy="expired"');
    expect(fresh.headers['set-cookie']).toBeUndefined();
  });

  it('a wrong sign-in shows the design\'s ONE generic sentence as an alert, marks the field, and never echoes the password', () => {
    const { handle } = setup();
    const res = handle(post({ login: 'ravi.cashier', password: WRONG }));
    expect(res.status).toBe(401);
    expect(WRONG_CREDENTIALS).toBe(LOGIN_COPY.en.invalid);
    expect(res.body).toContain(`<div id="sl-form-message" class="sl-message" role="alert" data-tone="red" data-copy="invalid">${WRONG_CREDENTIALS}</div>`);
    expect(res.body).toMatch(/<input id="login"[^>]*aria-invalid="true">/);
    expect(res.body).not.toContain(WRONG);
    expect(res.body).not.toContain('ravi.cashier'); // the login is not echoed either: the browser keeps what was typed, the server repeats nothing
    const locked = setup();
    for (let i = 0; i < 5; i += 1) locked.handle(post({ login: 'ravi.cashier', password: `bad-${i}` }));
    const lock = locked.handle(post({ login: 'ravi.cashier', password: PASSWORD }));
    expect(lock.body).toMatch(/<div id="sl-form-message" class="sl-message" role="alert" data-tone="red">Too many wrong attempts\. Try again in \d+ seconds\.<\/div>/);
  });

  it('a refusal and a miss are plain pages in the same shell: no form, nothing echoed but our own sentence', () => {
    const refused = setup().handle(post({ login: 'ravi.cashier', password: PASSWORD }, { origin: 'https://evil.example' }));
    expect(refused.status).toBe(403);
    expect(refused.body).not.toContain('<form');
    expect(refused.body).toContain('did not come from this site');
    expect(refused.body).toContain('class="sl-mark"'); // the same shell, so it still looks like the product
    const missing = GET('/login/nowhere');
    expect(missing.status).toBe(404);
    expect(missing.body).not.toContain('<form');
    expect(missing.body).not.toContain('nowhere');
  });

  it('the account page is in the same design: who you are, the one way into the product, sign out — one h1', () => {
    const { handle } = setup();
    const token = tokenFrom(handle(post({ login: 'ravi.cashier', password: PASSWORD })).headers['set-cookie']);
    const home = handle({ method: 'GET', url: '/login/', body: '', headers: { cookie: `${COOKIE_NAME}=${token}` } });
    expect(home.body).toContain('<a class="sl-submit" href="/store/manager/">');
    expect(home.body).toContain('<form method="post" action="/login/logout"><button type="submit" class="sl-secondary" data-copy="signOut">Sign out</button></form>');
    expect(home.body.match(/<h1[ >]/g)).toHaveLength(1);
    expect(home.body).not.toContain('<input'); // no sign-in form for somebody already signed in
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
