// SIGNING A PERSON IN THROUGH THE IDENTITY SERVER (OB-15-b · ADR-0019 · M02-FR-01 · SEC-02/03 · hard rule #4).
//
// The screens are served behind one front door (the proxy). This is the small service that front door asks "who is
// this?" for every screen and every head-office call — the job the pilot sign-in did with a password file of its own.
// Here the identity server (Keycloak) does the signing in; this service only:
//
//   1. sends the person to the identity server's own page (`/login/` → the authorisation request), with PKCE (S256), a
//      one-time `state` and a `nonce`, remembered here for ten minutes and used once;
//   2. takes the one-time code back (`/login/callback`), exchanges it on the private network, and BELIEVES the result only
//      after head office's own checker (`verifyToken`, RS256 against the identity server's published keys) accepts the
//      access token — the same check the API makes on every call;
//   3. keeps the sign-in HERE, not in the browser: the browser holds a random session id in an HttpOnly, Secure,
//      SameSite=Strict cookie, and this service keeps only a hash of it beside the tokens;
//   4. answers the front door (`/login/verify`, `/login/verify-sell`) with the person (`X-Sre-User`) and a CURRENT access
//      token (`X-Sre-Bearer`) — renewed with the refresh token before it runs out — or 401;
//   5. signs out (`POST /login/logout`): the session ends here at once, and the identity server is asked to end its own.
//
// It mints nothing and holds no password: every token it holds was signed by the identity server, and it can check one
// but never make one. Sessions live in memory — a restart signs everybody out (they sign in again); said in the runbook.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { verifyToken, type TokenPolicy } from './token';

/** Where the identity server is, and what this service is called there. */
export interface SignInSettings {
  /** The realm's public address — what the browser is sent to, and the `iss` every token must carry. */
  readonly issuer: string;
  /** The same realm on the private network, for the code exchange and refreshes (no trip out through the internet). */
  readonly internalIssuer: string;
  /** This product's public client id in the realm. */
  readonly clientId: string;
  /** The screens' own public address: sign-in returns to `${origin}/login/callback`. */
  readonly origin: string;
}

export interface SignInDeps {
  readonly settings: SignInSettings;
  /** The checker the API itself uses — RS256 against the identity server's published keys (`jwks.ts`). */
  readonly policy: TokenPolicy;
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => number;
  /** For the operator's log: sign-ins, sign-outs, refusals. Never a token, a code or a session id. */
  readonly audit: (line: Record<string, unknown>) => void;
  /** Asks head office what this person may do — for the till's door (`/login/verify-sell`). */
  readonly fetchMe?: (bearer: string, forwardedFor: string) => Promise<{ status: number; body: unknown }>;
}

export interface SignInRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
}
export interface SignInResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export const SESSION_COOKIE = 'sre_session';
/** The longest a session lasts here whatever the identity server says: one shift. */
export const SESSION_MAX_SECONDS = 10 * 60 * 60;
/** How long a started sign-in may take before its one-time state is forgotten. */
export const PENDING_SECONDS = 10 * 60;
/** Renew the access token when it has less than this left. */
export const REFRESH_MARGIN_SECONDS = 60;
/** The permission the till's door asks for (the same one the pilot gate checked). */
export const SELL_PERMISSION = 'pos.sale.sync';
/** Where a sign-in lands when nothing asked for a particular screen: the store computer's workspace (OB-16). */
export const LANDING = '/store/manager/';

interface Session {
  readonly userId: string;
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string | undefined;
  readonly idToken: string | undefined;
  readonly startedAt: number;
}
interface Pending { readonly verifier: string; readonly nonce: string; readonly next: string; readonly at: number }

const b64url = (n: number): string => randomBytes(n).toString('base64url');
const sha256 = (s: string): string => createHash('sha256').update(s).digest('base64url');
const payloadOf = (jwt: string): Record<string, unknown> => {
  try { return JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>; } catch { return {}; }
};

/** Only a same-origin path is a place to go back to after signing in (no open redirect). */
export function safeNext(next: string | null | undefined): string {
  if (next === null || next === undefined || next === '') return LANDING;
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\') || next.startsWith('/login')) return LANDING;
  return next;
}

export function cookieOf(headers: SignInRequest['headers'], name = SESSION_COOKIE): string | undefined {
  for (const part of (headers['cookie'] ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

const NO_STORE = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin' };

export function createSignInHandler(deps: SignInDeps): (req: SignInRequest) => Promise<SignInResponse> {
  const { settings } = deps;
  const sessions = new Map<string, Session>();
  const pending = new Map<string, Pending>();
  const callback = `${settings.origin.replace(/\/+$/, '')}/login/callback`;
  const endpoint = (name: 'auth' | 'token' | 'logout', internal: boolean): string =>
    `${(internal ? settings.internalIssuer : settings.issuer).replace(/\/+$/, '')}/protocol/openid-connect/${name}`;

  const cookie = (value: string, maxAge: number): string =>
    `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
  const redirect = (to: string, setCookie?: string): SignInResponse =>
    ({ status: 303, headers: { ...NO_STORE, location: to, ...(setCookie === undefined ? {} : { 'set-cookie': setCookie }) }, body: '' });
  const plain = (status: number, extra: Record<string, string> = {}): SignInResponse => ({ status, headers: { ...NO_STORE, ...extra }, body: '' });
  const page = (status: number, title: string, text: string): SignInResponse => ({
    status,
    headers: { ...NO_STORE, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" },
    body: `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} — SRE Retail OS</title><body><h1>${title}</h1><p>${text}</p><p><a href="/login/">Sign in</a></p></body></html>`,
  });

  /** Forget everything older than it may be: started sign-ins after ten minutes, sessions after a shift. */
  const sweep = (nowMs: number): void => {
    for (const [k, p] of pending) if (nowMs - p.at > PENDING_SECONDS * 1000) pending.delete(k);
    for (const [k, s] of sessions) if (nowMs - s.startedAt > SESSION_MAX_SECONDS * 1000) sessions.delete(k);
  };

  /** The identity server's answer to a code exchange or a refresh, checked by head office's own checker. */
  const tokensFrom = async (form: Record<string, string>): Promise<{ ok: true; access: string; refresh?: string; id?: string; userId: string; exp: number } | { ok: false; why: string }> => {
    let res: Response;
    try {
      res = await deps.fetch(endpoint('token', true), {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ client_id: settings.clientId, ...form }).toString(),
      });
    } catch (e) {
      return { ok: false, why: `the identity server could not be reached: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (!res.ok) return { ok: false, why: `the identity server answered ${res.status}` };
    const body = await res.json() as { access_token?: unknown; refresh_token?: unknown; id_token?: unknown };
    if (typeof body.access_token !== 'string') return { ok: false, why: 'the identity server gave no access token' };
    const verdict = verifyToken(body.access_token, deps.policy, deps.now());
    if (!verdict.ok || verdict.principal === undefined) return { ok: false, why: `the token was not believed (${verdict.refusedBecause ?? 'unknown'})` };
    const exp = payloadOf(body.access_token)['exp'];
    return {
      ok: true, access: body.access_token, userId: verdict.principal.userId, exp: typeof exp === 'number' ? exp * 1000 : deps.now(),
      ...(typeof body.refresh_token === 'string' ? { refresh: body.refresh_token } : {}),
      ...(typeof body.id_token === 'string' ? { id: body.id_token } : {}),
    };
  };

  /** The session a request carries, renewed if it is about to run out; `undefined` when there is none (or it ended). */
  const current = async (req: SignInRequest): Promise<{ key: string; session: Session } | undefined> => {
    const id = cookieOf(req.headers);
    if (id === undefined || id === '') return undefined;
    const key = sha256(id);
    const session = sessions.get(key);
    if (session === undefined) return undefined;
    const nowMs = deps.now();
    if (nowMs - session.startedAt > SESSION_MAX_SECONDS * 1000) { sessions.delete(key); return undefined; }
    if (session.accessExpiresAt - nowMs > REFRESH_MARGIN_SECONDS * 1000) return { key, session };
    if (session.refreshToken === undefined) { sessions.delete(key); return undefined; }
    const renewed = await tokensFrom({ grant_type: 'refresh_token', refresh_token: session.refreshToken });
    if (!renewed.ok || renewed.userId !== session.userId) {
      // The identity server ended it (signed out elsewhere, disabled, locked, session expired) — so it ends here too.
      sessions.delete(key);
      deps.audit({ event: 'session_ended_at_identity_server', userId: session.userId, why: renewed.ok ? 'person changed' : renewed.why });
      return undefined;
    }
    session.accessToken = renewed.access;
    session.accessExpiresAt = renewed.exp;
    if (renewed.refresh !== undefined) session.refreshToken = renewed.refresh;
    return { key, session };
  };

  return async (req) => {
    const url = new URL(req.url, 'https://sign-in.invalid');
    const path = url.pathname;
    const nowMs = deps.now();
    sweep(nowMs);

    // ── Start: send the person to the identity server's own sign-in page ───────────────────────────────────────────
    if (req.method === 'GET' && (path === '/login/' || path === '/login')) {
      const here = await current(req);
      if (here !== undefined) return redirect(safeNext(url.searchParams.get('next')));
      const state = b64url(24);
      const verifier = b64url(48);
      const nonce = b64url(24);
      if (pending.size > 10_000) return page(503, 'Busy', 'Too many sign-ins are starting at once. Try again in a minute.');
      pending.set(state, { verifier, nonce, next: safeNext(url.searchParams.get('next')), at: nowMs });
      const auth = new URL(endpoint('auth', false));
      auth.search = new URLSearchParams({
        client_id: settings.clientId, response_type: 'code', scope: 'openid', redirect_uri: callback,
        state, nonce, code_challenge: sha256(verifier), code_challenge_method: 'S256',
      }).toString();
      return redirect(auth.toString());
    }

    // ── Return: exchange the one-time code, believe the result only once head office's checker does ─────────────────
    if (req.method === 'GET' && path === '/login/callback') {
      const state = url.searchParams.get('state') ?? '';
      const code = url.searchParams.get('code') ?? '';
      const started = pending.get(state);
      pending.delete(state); // one use, whatever happens next
      if (url.searchParams.get('error') !== null) {
        return page(401, 'Not signed in', 'The sign-in was not completed. Nothing was changed.');
      }
      if (started === undefined || code === '') {
        deps.audit({ event: 'sign_in_refused', why: 'unknown or used state' });
        return page(400, 'Sign-in expired', 'This sign-in link was already used or is too old. Start again.');
      }
      const got = await tokensFrom({ grant_type: 'authorization_code', code, redirect_uri: callback, code_verifier: started.verifier });
      if (!got.ok) {
        deps.audit({ event: 'sign_in_refused', why: got.why });
        return page(401, 'Not signed in', 'The sign-in could not be confirmed. Nothing was changed. Start again.');
      }
      // The ID token must answer THIS sign-in's nonce — a token minted for another browser's sign-in is refused.
      if (got.id === undefined || payloadOf(got.id)['nonce'] !== started.nonce) {
        deps.audit({ event: 'sign_in_refused', why: 'nonce does not match' });
        return page(401, 'Not signed in', 'The sign-in could not be confirmed. Nothing was changed. Start again.');
      }
      const id = b64url(32);
      sessions.set(sha256(id), {
        userId: got.userId, accessToken: got.access, accessExpiresAt: got.exp, refreshToken: got.refresh, idToken: got.id, startedAt: nowMs,
      });
      deps.audit({ event: 'signed_in', userId: got.userId });
      return redirect(started.next, cookie(id, SESSION_MAX_SECONDS));
    }

    // ── The front door's question, for every screen and every head-office call ───────────────────────────────────────
    if (req.method === 'GET' && (path === '/login/verify' || path === '/login/verify-sell')) {
      const here = await current(req);
      if (here === undefined) return plain(401);
      const answer = { 'x-sre-user': here.session.userId, 'x-sre-bearer': `Bearer ${here.session.accessToken}` };
      if (path === '/login/verify') return plain(204, answer);
      if (deps.fetchMe === undefined) return plain(403);
      const me = await deps.fetchMe(here.session.accessToken, req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown');
      if (me.status === 401) return plain(401);
      const perms = (me.body as { permissions?: unknown } | undefined)?.permissions;
      return me.status === 200 && Array.isArray(perms) && perms.includes(SELL_PERMISSION) ? plain(204, answer) : plain(403);
    }

    // ── Sign out: the session ends here at once; the identity server is asked to end its own ────────────────────────
    if (req.method === 'POST' && path === '/login/logout') {
      const origin = req.headers['origin'];
      if (origin !== undefined && (origin === 'null' || !sameOrigin(origin, settings.origin))) {
        return page(403, 'Refused', 'This request did not come from this site, so it was refused.');
      }
      const here = cookieOf(req.headers);
      const session = here === undefined ? undefined : sessions.get(sha256(here));
      if (here !== undefined) sessions.delete(sha256(here));
      if (session !== undefined) deps.audit({ event: 'signed_out', userId: session.userId });
      const out = new URL(endpoint('logout', false));
      out.search = new URLSearchParams({
        client_id: settings.clientId, post_logout_redirect_uri: `${settings.origin.replace(/\/+$/, '')}/login/`,
        ...(session?.idToken === undefined ? {} : { id_token_hint: session.idToken }),
      }).toString();
      return redirect(out.toString(), cookie('', 0));
    }

    return page(404, 'Not found', 'There is no such page here.');
  };
}

function sameOrigin(a: string, b: string): boolean {
  try {
    const x = Buffer.from(new URL(a).origin);
    const y = Buffer.from(new URL(b).origin);
    return x.length === y.length && timingSafeEqual(x, y);
  } catch { return false; }
}
