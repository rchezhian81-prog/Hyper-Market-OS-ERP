// DEMO-ONLY sign-in for the hosted demo pilot (owner decision 27 Sep 2026, defect H-01).
//
// ── What this is ─────────────────────────────────────────────────────────────
// The API trusts only a signed bearer token and never issues one (hard rule #4); the shells call
// `/v1/...` same-origin with the browser's cookie. Until a real identity provider is chosen (OA-4),
// nothing gave a browser a token — so no one could use a shell. This is the stand-in for that IdP on
// the DEMO box only: a person signs in with their own demo login and password; it mints the same
// HS256 token the test IdP mints and puts it in an HttpOnly, Secure, SameSite=Strict cookie; the
// HTTPS front (`infra/compose/nginx.pilot.conf`) turns that cookie into `Authorization: Bearer` for
// `/v1/` only. The API is unchanged and verifies exactly as it always does.
//
// ── Why it cannot reach the real store ───────────────────────────────────────
// • It lives in infra/pilot — never services/, apps/, edge/ or packages/ (guardrail
//   `no-test-idp-in-production`) — and runs only as the `demo-login` service of the PILOT compose
//   overlay; the base (store) compose file has no such service (guardrail `demo-login-is-pilot-only`).
// • It refuses to start unless DEMO_LOGIN_ENABLED=1, the tenant is the synthetic demo tenant (PILOT_DEMO_TENANT), and
//   MIGRATION_TARGET_KIND is not `production` (`startupRefusals`).
// • It only signs in `pilot-*` synthetic users, one login per user (no shared logins, hard rule #4).
//
// ── What it deliberately does NOT do ─────────────────────────────────────────
// • It records `amr: ['pwd']` — single factor, honestly. The two §28 step-up routes (privilege grant,
//   erasure) need a fresh MFA re-auth, so they REFUSE a demo session. That is the correct outcome.
// • Sign-out clears the cookie; the token itself stays valid until it expires (SESSION_SECONDS),
//   because the API holds no session state. Documented in KNOWN-LIMITATIONS.

import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { LocalIdp } from '../../../tests/support/local-idp';
import { verifyToken } from '../../../services/identity/src/token';
import { DEMO_BANNER_TEXT_EN, DEMO_BANNER_TEXT_TA } from '../../../packages/ui/src/demo-banner';
import { PILOT_DEMO_TENANT } from '../../../db/seed/pilot/dataset';

/** The synthetic demo tenant — the SAME id the seed lays down (a UUID; see db/seed/pilot/dataset.ts). */
export const DEMO_TENANT = PILOT_DEMO_TENANT;
export const COOKIE_NAME = 'sre_demo_session';
/** One shift. Short enough that a forgotten sign-out expires the same day. */
export const SESSION_SECONDS = 8 * 60 * 60;

// ── Credentials ──────────────────────────────────────────────────────────────

export interface DemoLogin {
  /** What the person types, e.g. `ravi.cashier`. */
  readonly login: string;
  /** The seeded synthetic user it signs in as, e.g. `pilot-cashier`. */
  readonly userId: string;
  readonly salt: string;
  readonly hash: string;
  readonly createdAt: string;
  readonly createdBy: string;
}

export interface DemoLoginFile {
  readonly version: 1;
  readonly logins: readonly DemoLogin[];
}

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const KEY_LEN = 64;
const LOGIN_SHAPE = /^[a-z0-9][a-z0-9._-]{2,39}$/;

export function hashPassword(password: string, salt: Buffer = randomBytes(16)): { salt: string; hash: string } {
  return { salt: salt.toString('base64'), hash: scryptSync(password, salt, KEY_LEN, SCRYPT).toString('base64') };
}

/** A fixed decoy so an unknown login costs the same scrypt as a known one (no user enumeration by timing). */
const DECOY = hashPassword('decoy-password-never-valid', Buffer.alloc(16, 7));

export function passwordMatches(password: string, entry: { salt: string; hash: string }): boolean {
  const expected = Buffer.from(entry.hash, 'base64');
  const got = scryptSync(password, Buffer.from(entry.salt, 'base64'), KEY_LEN, SCRYPT);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

/** 16 characters from an unambiguous alphabet (~80 bits) — generated on the box, shown once. */
export function generatePassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 16; i += 1) out += alphabet[randomInt(alphabet.length)];
  return out;
}

/** Why a credentials file is unusable. Empty = valid. */
export function loginFileProblems(file: unknown): string[] {
  const problems: string[] = [];
  const f = file as Partial<DemoLoginFile> | null;
  if (f === null || typeof f !== 'object' || f.version !== 1 || !Array.isArray(f.logins)) {
    return ['not a version-1 demo login file'];
  }
  const logins = new Set<string>();
  const users = new Set<string>();
  for (const l of f.logins) {
    if (!LOGIN_SHAPE.test(l.login ?? '')) problems.push(`login "${l.login}" is not a valid login name`);
    if (!(l.userId ?? '').startsWith('pilot-')) problems.push(`login "${l.login}" maps to "${l.userId}", which is not a synthetic pilot-* user`);
    if (logins.has(l.login)) problems.push(`login "${l.login}" appears twice`);
    // One person per identity: two logins on one user would make the audit trail unable to say who.
    if (users.has(l.userId)) problems.push(`user "${l.userId}" has more than one login (no shared identities)`);
    logins.add(l.login);
    users.add(l.userId);
  }
  return problems;
}

/** Add a login (pure). Refuses a duplicate login or a second login for the same user. */
export function addLogin(
  file: DemoLoginFile, input: { login: string; userId: string; password: string; createdBy: string; now: Date },
): DemoLoginFile {
  const { salt, hash } = hashPassword(input.password);
  const next: DemoLoginFile = {
    version: 1,
    logins: [...file.logins, {
      login: input.login, userId: input.userId, salt, hash,
      createdAt: input.now.toISOString(), createdBy: input.createdBy,
    }],
  };
  const problems = loginFileProblems(next);
  if (problems.length > 0) throw new Error(problems.join('; '));
  return next;
}

// ── Failed-attempt throttle ──────────────────────────────────────────────────

/** After `threshold` failures a key is locked, doubling from `baseSeconds` up to `maxSeconds`. */
export class FailureThrottle {
  private readonly state = new Map<string, { failures: number; lockedUntilMs: number }>();
  constructor(private readonly cfg = { threshold: 5, baseSeconds: 30, maxSeconds: 900 }) {}

  lockedFor(key: string, nowMs: number): number {
    const s = this.state.get(key);
    return s === undefined || s.lockedUntilMs <= nowMs ? 0 : Math.ceil((s.lockedUntilMs - nowMs) / 1000);
  }

  fail(key: string, nowMs: number): void {
    const s = this.state.get(key) ?? { failures: 0, lockedUntilMs: 0 };
    s.failures += 1;
    if (s.failures >= this.cfg.threshold) {
      const seconds = Math.min(this.cfg.maxSeconds, this.cfg.baseSeconds * 2 ** (s.failures - this.cfg.threshold));
      s.lockedUntilMs = nowMs + seconds * 1000;
    }
    this.state.set(key, s);
  }

  succeed(key: string): void { this.state.delete(key); }
}

// ── Start-up guard ───────────────────────────────────────────────────────────

export interface DemoLoginSettings {
  readonly DEMO_LOGIN_ENABLED?: string;
  readonly DEMO_TENANT_ID?: string;
  readonly MIGRATION_TARGET_KIND?: string;
  readonly IDP_SIGNING_KEY?: string;
  readonly IDP_ISSUER?: string;
  readonly IDP_AUDIENCE?: string;
}

/** Every reason the demo sign-in must not run here. Empty = allowed to start. */
export function startupRefusals(s: DemoLoginSettings): string[] {
  const out: string[] = [];
  if (s.DEMO_LOGIN_ENABLED !== '1') out.push('DEMO_LOGIN_ENABLED is not 1 — the demo sign-in is off unless deliberately switched on');
  if (s.DEMO_TENANT_ID !== DEMO_TENANT) out.push(`tenant "${s.DEMO_TENANT_ID ?? ''}" is not the synthetic "${DEMO_TENANT}" — the demo sign-in never serves a real tenant`);
  if (s.MIGRATION_TARGET_KIND === 'production') out.push('MIGRATION_TARGET_KIND is production — the demo sign-in never runs there (hard rule #7)');
  if ((s.IDP_SIGNING_KEY ?? '').length < 32 || (s.IDP_SIGNING_KEY ?? '').includes('REPLACE_WITH')) out.push('IDP_SIGNING_KEY is missing or too short');
  if ((s.IDP_ISSUER ?? '') === '' || (s.IDP_AUDIENCE ?? '') === '') out.push('IDP_ISSUER / IDP_AUDIENCE are not set');
  return out;
}

// ── HTTP handling (framework-free, so it is unit-testable without a socket) ──

export interface LoginRequest {
  readonly method: string;
  /** Path + query, as received (the front forwards `/login/...` unchanged). */
  readonly url: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
}

export interface LoginResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[]>;
  readonly body: string;
}

export interface DemoLoginDeps {
  readonly logins: () => DemoLoginFile;
  readonly idp: { readonly secret: string; readonly issuer: string; readonly audience: string };
  readonly throttle: FailureThrottle;
  readonly now: () => number;
  /** Where each sign-in / failure / sign-out is recorded (never a password). */
  readonly audit: (line: Record<string, unknown>) => void;
}

const SHELLS: ReadonlyArray<readonly [string, string]> = [
  ['/erp/', 'Store & back office (ERP)'], ['/pos/', 'Till (POS)'], ['/owner/', 'Owner'],
  ['/warehouse/', 'Warehouse'], ['/picker/', 'Picker'], ['/delivery/', 'Delivery'],
  ['/customer/', 'Customer'], ['/supplier/', 'Supplier portal'],
];

/** Only a same-origin path to one of the shells is a valid place to go back to (no open redirect). */
export function safeNext(next: string | undefined): string {
  if (next === undefined) return '/erp/';
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return '/erp/';
  return SHELLS.some(([p]) => next.startsWith(p)) ? next : '/erp/';
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(title: string, inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — SRE demo</title>
<style>
body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#f6f6f4;color:#1b1b1b}
.demo{background:#ffd23f;color:#1b1b1b;font-weight:700;text-align:center;padding:.5rem 1rem}
main{max-width:26rem;margin:2rem auto;padding:0 1rem}
h1{font-size:1.4rem}label{display:block;margin:.8rem 0 .2rem;font-weight:600}
input{width:100%;box-sizing:border-box;padding:.7rem;font-size:1rem;border:1px solid #888;border-radius:.4rem}
button{margin-top:1.2rem;width:100%;padding:.8rem;font-size:1rem;font-weight:700;border:0;border-radius:.4rem;background:#1f5f99;color:#fff}
.err{background:#fde2e1;border-left:4px solid #b3261e;padding:.6rem .8rem}
ul{padding-left:1.1rem}a{color:#1f5f99}
</style></head><body>
<div class="demo" role="alert">${esc(DEMO_BANNER_TEXT_EN)}<br>${esc(DEMO_BANNER_TEXT_TA)}</div>
<main>${inner}</main></body></html>`;
}

const SECURITY_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

function formPage(next: string, error?: string): string {
  return page('Sign in', `<h1>Sign in to the demo</h1>
${error === undefined ? '' : `<p class="err" role="alert">${esc(error)}</p>`}
<form method="post" action="/login/">
<input type="hidden" name="next" value="${esc(next)}">
<label for="login">Login</label><input id="login" name="login" autocomplete="username" autocapitalize="none" required>
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Sign in</button></form>
<p>Your login is personal. Do not share it. This is a demo with made-up data.</p>`);
}

function cookieOf(headers: LoginRequest['headers']): string | undefined {
  const raw = headers['cookie'];
  if (raw === undefined) return undefined;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE_NAME) return v.join('=');
  }
  return undefined;
}

const sessionCookie = (token: string): string =>
  `${COOKIE_NAME}=${token}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
const clearedCookie = `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;

/** A cross-site form post is refused: if the browser says where the form came from, it must be us. */
function crossSite(req: LoginRequest): boolean {
  const origin = req.headers['origin'];
  if (origin === undefined) return false; // no Origin sent: the SameSite=Strict cookie still protects the API
  if (origin === 'null') return true;     // an opaque origin (sandboxed frame, data: page) is never us
  try { return new URL(origin).host !== req.headers['host']; } catch { return true; }
}

export function createDemoLoginHandler(deps: DemoLoginDeps): (req: LoginRequest) => LoginResponse {
  const idp = new LocalIdp({ ...deps.idp, now: deps.now });
  const html = (status: number, body: string, extra: Record<string, string | string[]> = {}): LoginResponse =>
    ({ status, headers: { ...SECURITY_HEADERS, ...extra }, body });
  const redirect = (to: string, cookie?: string): LoginResponse =>
    ({ status: 303, headers: { location: to, 'cache-control': 'no-store', ...(cookie === undefined ? {} : { 'set-cookie': cookie }) }, body: '' });

  return (req) => {
    const url = new URL(req.url, 'https://demo.invalid');
    const path = url.pathname;
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';

    if (req.method === 'GET' && (path === '/login/' || path === '/login')) {
      const token = cookieOf(req.headers);
      const verdict = token === undefined ? undefined : verifyToken(token, deps.idp, deps.now());
      if (verdict?.ok === true && verdict.principal !== undefined) {
        const who = verdict.principal.userId;
        return html(200, page('Signed in', `<h1>Signed in as ${esc(who)}</h1>
<p>Open a screen:</p><ul>${SHELLS.map(([p, label]) => `<li><a href="${p}">${esc(label)}</a></li>`).join('')}</ul>
<form method="post" action="/login/logout"><button type="submit">Sign out</button></form>`));
      }
      return html(200, formPage(safeNext(url.searchParams.get('next') ?? undefined)));
    }

    if (req.method === 'POST' && (path === '/login/' || path === '/login')) {
      if (crossSite(req)) return html(403, page('Refused', '<p class="err">This sign-in did not come from the demo site, so it was refused.</p>'));
      const form = new URLSearchParams(req.body);
      const login = (form.get('login') ?? '').trim().toLowerCase();
      const password = form.get('password') ?? '';
      const next = safeNext(form.get('next') ?? undefined);
      const nowMs = deps.now();

      const locked = Math.max(deps.throttle.lockedFor(`ip:${ip}`, nowMs), deps.throttle.lockedFor(`login:${login}`, nowMs));
      if (locked > 0) {
        deps.audit({ event: 'demo_login_locked', login, ip });
        return html(429, formPage(next, `Too many wrong attempts. Try again in ${locked} seconds.`), { 'retry-after': String(locked) });
      }

      const entry = deps.logins().logins.find((l) => l.login === login);
      // Always pay for one scrypt, known login or not, so timing does not reveal which logins exist.
      const ok = passwordMatches(password, entry ?? DECOY) && entry !== undefined;
      if (!ok) {
        deps.throttle.fail(`ip:${ip}`, nowMs);
        deps.throttle.fail(`login:${login}`, nowMs);
        deps.audit({ event: 'demo_login_failed', login, ip });
        return html(401, formPage(next, 'That login and password do not match.'));
      }

      deps.throttle.succeed(`ip:${ip}`);
      deps.throttle.succeed(`login:${login}`);
      const token = idp.issue({ sub: entry.userId, tenantId: DEMO_TENANT, ttlSeconds: SESSION_SECONDS, amr: ['pwd'] });
      deps.audit({ event: 'demo_login_succeeded', login, userId: entry.userId, ip });
      return redirect(next, sessionCookie(token));
    }

    if (req.method === 'POST' && path === '/login/logout') {
      if (crossSite(req)) return html(403, page('Refused', '<p class="err">Refused.</p>'));
      deps.audit({ event: 'demo_logout', ip });
      return redirect('/login/', clearedCookie);
    }

    return html(404, page('Not found', '<p>Not found. <a href="/login/">Sign in</a></p>'));
  };
}
