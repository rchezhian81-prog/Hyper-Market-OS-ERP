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
import { LOGIN_COPY, LOGIN_CSS, LOGIN_CSS_PATH, LOGIN_JS, LOGIN_JS_PATH, renderAccount, renderPlain, renderSignIn } from './ui';
import { PILOT_DEMO_TENANT, PILOT_MACHINE_USERS } from '../../../db/seed/pilot/dataset';

/** The synthetic demo tenant — the SAME id the seed lays down (a UUID; see db/seed/pilot/dataset.ts). */
export const DEMO_TENANT = PILOT_DEMO_TENANT;
export const COOKIE_NAME = 'sre_demo_session';
/** One shift. Short enough that a forgotten sign-out expires the same day. */
export const SESSION_SECONDS = 8 * 60 * 60;
/**
 * The cookie outlives the token by this much, so that the NEXT visit still carries the (useless, expired) token and the
 * sign-in page can say truthfully "your session has ended" — and clear it. The token itself is dead at SESSION_SECONDS:
 * the API verifies expiry on every call, and the sign-in's own gate refuses it, so the grace changes nothing anyone can do.
 */
export const COOKIE_GRACE_SECONDS = 24 * 60 * 60;

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
    if (PILOT_MACHINE_USERS.includes(l.userId)) problems.push(`login "${l.login}" maps to "${l.userId}", a machine identity — no person signs in as the store box`);
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
  // The DEMO store box (ADR-0016): screens served by the demo store edge itself.
  ['/store/', 'Demo store box — any screen it serves'],
];

/** Where a sign-in lands when nothing asked for a particular screen: the demo home below, never an empty shell. */
export const DEMO_HOME = '/login/';
/** Where a sign-in lands when nothing was asked for: the product — the store computer's workspace, not a list of shells (OB-16). */
export const LANDING = '/store/manager/';


/** The account page for a signed-in visitor (OB-16): who you are, the ONE way into the product, sign out. */
export function homePage(who: string): string {
  return renderAccount(who, LANDING);
}

/** Only a same-origin path to one of the shells (or the demo home) is a valid place to go back to (no open redirect). */
export function safeNext(next: string | undefined): string {
  if (next === undefined) return LANDING;
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return LANDING;
  return next === DEMO_HOME || SHELLS.some(([p]) => next.startsWith(p)) ? next : LANDING;
}

/**
 * The sign-in page in the owner's approved design (UX-3 · OB-18; markup, styles, script and words in ./ui.ts). `error` is
 * one of OUR generic sentences — never anything the request carried. `expired` is the server's own observation: a session
 * cookie arrived that no longer verifies.
 */
export function formPage(next: string, error?: string, expired = false): string {
  return renderSignIn({ next, error, expired });
}

/** ONE sentence for a wrong password AND an unknown login (no user enumeration) — the design's words, translated by the page's language switch. */
export const WRONG_CREDENTIALS = LOGIN_COPY.en.invalid;

const SECURITY_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  // Nothing inline: the page's stylesheet and script are served by this same service (below) under a content hash, so the
  // policy names no 'unsafe-inline' anywhere. Nothing is fetched from anywhere else (icons are inline SVG, fonts the system's).
  'content-security-policy': "default-src 'none'; style-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
  // NOT 'no-referrer': under it Chrome sends `Origin: null` on the sign-in form's POST, which the
  // cross-site check (rightly) refuses — every real browser sign-in failed 403 on the demo box, 28 Sep
  // 2026. 'same-origin' gives our own form its true Origin and still sends nothing to other sites.
  'referrer-policy': 'same-origin',
};

/** The page's own two assets. Their address carries a content hash (`?v=`), so a release moves the address and the copy a browser keeps can be long-lived. */
const ASSETS: Readonly<Record<string, { readonly type: string; readonly body: string }>> = {
  [LOGIN_CSS_PATH]: { type: 'text/css; charset=utf-8', body: LOGIN_CSS },
  [LOGIN_JS_PATH]: { type: 'text/javascript; charset=utf-8', body: LOGIN_JS },
};
const ASSET_HEADERS = {
  'cache-control': 'public, max-age=31536000, immutable',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
};

export function cookieOf(headers: LoginRequest['headers']): string | undefined {
  const raw = headers['cookie'];
  if (raw === undefined) return undefined;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE_NAME) return v.join('=');
  }
  return undefined;
}

const sessionCookie = (token: string): string =>
  `${COOKIE_NAME}=${token}; Path=/; Max-Age=${SESSION_SECONDS + COOKIE_GRACE_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
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

    const asset = req.method === 'GET' ? ASSETS[path] : undefined;
    if (asset !== undefined) return { status: 200, headers: { ...ASSET_HEADERS, 'content-type': asset.type }, body: asset.body };

    if (req.method === 'GET' && (path === '/login/' || path === '/login')) {
      const token = cookieOf(req.headers);
      const verdict = token === undefined ? undefined : verifyToken(token, deps.idp, deps.now());
      if (verdict?.ok === true && verdict.principal !== undefined) {
        return html(200, homePage(verdict.principal.userId));
      }
      // A session cookie that no longer verifies IS the session having ended: say so, once, and drop the dead cookie.
      const expired = token !== undefined;
      return html(200, formPage(safeNext(url.searchParams.get('next') ?? undefined), undefined, expired), expired ? { 'set-cookie': clearedCookie } : {});
    }

    if (req.method === 'POST' && (path === '/login/' || path === '/login')) {
      if (crossSite(req)) return html(403, renderPlain('Refused', 'This sign-in did not come from this site, so it was refused.'));
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
        return html(401, formPage(next, WRONG_CREDENTIALS));
      }

      deps.throttle.succeed(`ip:${ip}`);
      deps.throttle.succeed(`login:${login}`);
      const token = idp.issue({ sub: entry.userId, tenantId: DEMO_TENANT, ttlSeconds: SESSION_SECONDS, amr: ['pwd'] });
      deps.audit({ event: 'demo_login_succeeded', login, userId: entry.userId, ip });
      return redirect(next, sessionCookie(token));
    }

    if (req.method === 'POST' && path === '/login/logout') {
      if (crossSite(req)) return html(403, renderPlain('Refused', 'This request did not come from this site, so it was refused.'));
      deps.audit({ event: 'demo_logout', ip });
      return redirect('/login/', clearedCookie);
    }

    return html(404, renderPlain('Not found', 'There is no such page here.'));
  };
}
