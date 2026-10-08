import { describe, it, expect } from 'vitest';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createSignInHandler, safeNext, SESSION_COOKIE, type SignInRequest, type SignInResponse } from '../../services/identity/src/sign-in';
import type { TokenPolicy } from '../../services/identity/src/token';

/**
 * **The sign-in service: the front door's "who is this?", answered from the identity server's own sign-in
 * (OB-15-b · ADR-0019 · M02-FR-01 · SEC-02 · hard rule #4).**
 *
 * A stand-in identity server (keys and tokens made at run time — the test plays the server; the service under test signs
 * nothing) proves the service: sends the person away with PKCE, state and nonce; takes the code back once; believes the
 * result only when head office's own checker does; keeps the session server-side behind a random cookie; answers the
 * front door with the person and a current token, renewing it before it runs out; ends a session the identity server
 * ended; checks the till's permission; signs out at both ends; never sends a person to another site.
 */

const ISSUER = 'https://shop.example.test/auth/realms/sre-store';
const INTERNAL = 'http://idp:8080/auth/realms/sre-store';
const ORIGIN = 'https://shop.example.test';
const AUD = 'sre-retail-os-api';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url');
const jwt = (payload: Record<string, unknown>): string => {
  const h = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
  const p = b64(payload);
  return `${h}.${p}.${sign('RSA-SHA256', Buffer.from(`${h}.${p}`), keys.privateKey).toString('base64url')}`;
};

/** A stand-in identity server: hands out a code per sign-in, checks PKCE on exchange, and renews or refuses refreshes. */
function idp(clock: { now: number }) {
  const codes = new Map<string, { challenge: string; nonce: string; user: string }>();
  let refreshAllowed = true;
  let issued = 0;
  const access = (user: string) => jwt({
    iss: ISSUER, aud: [AUD], sub: 'kc-uuid', sre_user_id: user, tenant_id: 'tenant-a',
    iat: Math.floor(clock.now / 1000), exp: Math.floor(clock.now / 1000) + 300, n: (issued += 1),
  });
  const fetch = (async (url: string, init?: RequestInit) => {
    expect(url).toBe(`${INTERNAL}/protocol/openid-connect/token`); // exchanges go over the private network only
    const form = new URLSearchParams(String(init?.body));
    if (form.get('grant_type') === 'authorization_code') {
      const c = codes.get(form.get('code') ?? '');
      codes.delete(form.get('code') ?? '');
      const verifier = form.get('code_verifier') ?? '';
      if (c === undefined || createHash('sha256').update(verifier).digest('base64url') !== c.challenge) return new Response('{"error":"invalid_grant"}', { status: 400 });
      return new Response(JSON.stringify({ access_token: access(c.user), refresh_token: `r-${c.user}`, id_token: jwt({ nonce: c.nonce, sub: 'kc-uuid' }) }));
    }
    if (form.get('grant_type') === 'refresh_token') {
      if (!refreshAllowed) return new Response('{"error":"invalid_grant"}', { status: 400 });
      return new Response(JSON.stringify({ access_token: access((form.get('refresh_token') ?? '').slice(2)), refresh_token: form.get('refresh_token') }));
    }
    return new Response('{}', { status: 400 });
  }) as unknown as typeof globalThis.fetch;
  return {
    fetch,
    /** The person signs in on the identity server's page: it issues a code bound to the request's PKCE challenge and nonce. */
    approve(authUrl: string, user: string): string {
      const u = new URL(authUrl);
      const code = randomBytes(8).toString('hex');
      codes.set(code, { challenge: u.searchParams.get('code_challenge')!, nonce: u.searchParams.get('nonce')!, user });
      return `/login/callback?${new URLSearchParams({ code, state: u.searchParams.get('state')! })}`;
    },
    endSessions(): void { refreshAllowed = false; },
  };
}

function rig() {
  const clock = { now: Date.parse('2026-10-08T09:00:00.000Z') };
  const server = idp(clock);
  const audit: Record<string, unknown>[] = [];
  const policy: TokenPolicy = {
    algorithm: 'RS256', secret: '', keyring: { get: (kid) => (kid === 'k1' ? keys.publicKey : undefined) }, subjectClaim: 'sre_user_id',
    issuer: ISSUER, audience: AUD, maxLifetimeSeconds: 3600,
  };
  const permissions = new Map<string, string[]>([['u-cash', ['pos.sale.sync']], ['u-acct', ['finance.period.sign']]]);
  const handle = createSignInHandler({
    settings: { issuer: ISSUER, internalIssuer: INTERNAL, clientId: 'sre-web', origin: ORIGIN },
    policy, fetch: server.fetch, now: () => clock.now, audit: (l) => { audit.push(l); },
    fetchMe: async (bearer) => {
      const user = JSON.parse(Buffer.from(bearer.split('.')[1]!, 'base64url').toString('utf8')).sre_user_id as string;
      return { status: 200, body: { permissions: permissions.get(user) ?? [] } };
    },
  });
  const go = (method: string, url: string, cookie?: string, headers: Record<string, string> = {}): Promise<SignInResponse> =>
    handle({ method, url, headers: { ...(cookie === undefined ? {} : { cookie: `${SESSION_COOKIE}=${cookie}` }), ...headers }, body: '' } as SignInRequest);
  const sessionOf = (res: SignInResponse): string => /sre_session=([^;]*)/.exec(res.headers['set-cookie'] ?? '')![1]!;
  /** Sign in end to end as `user`, starting at `next`; returns the session cookie value. */
  const signIn = async (user: string, next = '/store/manager/'): Promise<string> => {
    const start = await go('GET', `/login/?next=${encodeURIComponent(next)}`);
    const back = await go('GET', server.approve(start.headers['location']!, user));
    expect(back.status).toBe(303);
    expect(back.headers['location']).toBe(next);
    return sessionOf(back);
  };
  return { clock, server, audit, go, signIn, sessionOf };
}

describe('sending the person to the identity server', () => {
  it('redirects to the realm\'s own page with PKCE S256, a state, a nonce and our callback — never a password form of ours', async () => {
    const { go } = rig();
    const res = await go('GET', '/login/?next=/store/pos/');
    expect(res.status).toBe(303);
    const to = new URL(res.headers['location']!);
    expect(`${to.origin}${to.pathname}`).toBe(`${ISSUER}/protocol/openid-connect/auth`);
    expect(Object.fromEntries(to.searchParams)).toMatchObject({
      client_id: 'sre-web', response_type: 'code', scope: 'openid', redirect_uri: `${ORIGIN}/login/callback`, code_challenge_method: 'S256',
    });
    for (const k of ['state', 'nonce', 'code_challenge']) expect((to.searchParams.get(k) ?? '').length).toBeGreaterThanOrEqual(32);
  });
});

describe('coming back', () => {
  it('a completed sign-in becomes a server-side session behind a random, HttpOnly, Secure, SameSite=Strict cookie', async () => {
    const { go, server, sessionOf, audit } = rig();
    const start = await go('GET', '/login/?next=/store/pos/');
    const back = await go('GET', server.approve(start.headers['location']!, 'u-cash'));
    expect(back.status).toBe(303);
    expect(back.headers['location']).toBe('/store/pos/');
    expect(back.headers['set-cookie']).toMatch(/^sre_session=[A-Za-z0-9_-]{40,}; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Strict$/);
    // The browser holds only the random id: no token in the cookie.
    expect(sessionOf(back)).not.toMatch(/\./);
    expect(audit).toContainEqual({ event: 'signed_in', userId: 'u-cash' });
  });

  it('a state used twice, an unknown state, and a state older than ten minutes are refused', async () => {
    const { go, server, clock } = rig();
    const start = await go('GET', '/login/');
    const callback = server.approve(start.headers['location']!, 'u-cash');
    expect((await go('GET', callback)).status).toBe(303);
    expect((await go('GET', callback)).status).toBe(400);
    expect((await go('GET', '/login/callback?code=x&state=never-issued')).status).toBe(400);
    const late = await go('GET', '/login/');
    const lateCallback = server.approve(late.headers['location']!, 'u-cash');
    clock.now += 11 * 60_000;
    expect((await go('GET', lateCallback)).status).toBe(400);
  });

  it('a code whose PKCE verifier does not match, or an ID token answering another sign-in\'s nonce, makes no session', async () => {
    const { go, server } = rig();
    const a = await go('GET', '/login/');
    const b = await go('GET', '/login/');
    // The code issued for sign-in A, returned with sign-in B's state: B's verifier does not match A's challenge.
    const codeA = new URL(`https://x${server.approve(a.headers['location']!, 'u-cash')}`).searchParams.get('code')!;
    const stateB = new URL(b.headers['location']!).searchParams.get('state')!;
    const res = await go('GET', `/login/callback?code=${codeA}&state=${stateB}`);
    expect(res.status).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('the identity server saying the sign-in failed shows a plain refusal and makes no session', async () => {
    const { go } = rig();
    const start = await go('GET', '/login/');
    const state = new URL(start.headers['location']!).searchParams.get('state')!;
    const res = await go('GET', `/login/callback?error=access_denied&state=${state}`);
    expect(res.status).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('never sends a person to another site afterwards', () => {
    for (const bad of ['https://evil.test/', '//evil.test/x', '/\\evil', '/login/callback', '']) expect(safeNext(bad)).toBe('/store/manager/');
    expect(safeNext('/store/pos/?x=1')).toBe('/store/pos/?x=1');
  });
});

describe('the front door\'s question', () => {
  it('answers with the person and a current bearer token; no cookie, an unknown cookie, or a forged one → 401', async () => {
    const { go, signIn } = rig();
    const id = await signIn('u-cash');
    const ok = await go('GET', '/login/verify', id);
    expect(ok.status).toBe(204);
    expect(ok.headers['x-sre-user']).toBe('u-cash');
    expect(ok.headers['x-sre-bearer']).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect((await go('GET', '/login/verify')).status).toBe(401);
    expect((await go('GET', '/login/verify', randomBytes(32).toString('base64url'))).status).toBe(401);
  });

  it('renews the access token before it runs out; when the identity server has ended the session, it ends here too', async () => {
    const { go, signIn, clock, server, audit } = rig();
    const id = await signIn('u-cash');
    const first = (await go('GET', '/login/verify', id)).headers['x-sre-bearer'];
    clock.now += 4.5 * 60_000; // inside the last minute of a five-minute token
    const renewed = await go('GET', '/login/verify', id);
    expect(renewed.status).toBe(204);
    expect(renewed.headers['x-sre-bearer']).not.toBe(first);
    server.endSessions(); // e.g. the person was disabled, or signed out elsewhere
    clock.now += 4.5 * 60_000;
    expect((await go('GET', '/login/verify', id)).status).toBe(401);
    expect(audit.some((l) => l['event'] === 'session_ended_at_identity_server')).toBe(true);
    // …and it stays ended.
    expect((await go('GET', '/login/verify', id)).status).toBe(401);
  });

  it('the till\'s door lets in only a person whose grants allow selling', async () => {
    const { go, signIn } = rig();
    expect((await go('GET', '/login/verify-sell', await signIn('u-cash'))).status).toBe(204);
    expect((await go('GET', '/login/verify-sell', await signIn('u-acct'))).status).toBe(403);
  });

  it('a session lasts one shift at most, whatever the identity server would renew', async () => {
    const { go, signIn, clock } = rig();
    const id = await signIn('u-cash');
    for (let i = 0; i < 150; i += 1) { clock.now += 4.5 * 60_000; if ((await go('GET', '/login/verify', id)).status !== 204) break; }
    expect((await go('GET', '/login/verify', id)).status).toBe(401);
  });
});

describe('signing out', () => {
  it('ends the session here at once, clears the cookie, and sends the person to the identity server to end its own', async () => {
    const { go, signIn } = rig();
    const id = await signIn('u-cash');
    const out = await go('POST', '/login/logout', id, { origin: ORIGIN });
    expect(out.status).toBe(303);
    expect(out.headers['set-cookie']).toMatch(/^sre_session=; Path=\/; Max-Age=0;/);
    const to = new URL(out.headers['location']!);
    expect(`${to.origin}${to.pathname}`).toBe(`${ISSUER}/protocol/openid-connect/logout`);
    expect(to.searchParams.get('post_logout_redirect_uri')).toBe(`${ORIGIN}/login/`);
    expect(to.searchParams.get('id_token_hint')).toBeTruthy();
    expect((await go('GET', '/login/verify', id)).status).toBe(401);
  });

  it('a sign-out posted from another site is refused', async () => {
    const { go, signIn } = rig();
    const id = await signIn('u-cash');
    expect((await go('POST', '/login/logout', id, { origin: 'https://evil.test' })).status).toBe(403);
    expect((await go('GET', '/login/verify', id)).status).toBe(204);
  });
});

describe('the service refuses to start without what it needs', () => {
  it('names every missing setting, and refuses plain http unless explicitly allowed for a local proof', async () => {
    const { signInSettingsProblems } = await import('../../services/identity/src/sign-in-main');
    expect(signInSettingsProblems({})).toHaveLength(4);
    const good = { SIGN_IN_ISSUER: `${ISSUER}`, SIGN_IN_INTERNAL_ISSUER: INTERNAL, SIGN_IN_ORIGIN: ORIGIN, IDP_AUDIENCE: AUD };
    expect(signInSettingsProblems(good)).toEqual([]);
    expect(signInSettingsProblems({ ...good, SIGN_IN_ORIGIN: 'http://shop.example.test' })[0]).toMatch(/must be an https address/);
    expect(signInSettingsProblems({ ...good, SIGN_IN_ORIGIN: 'http://127.0.0.1:8099', SIGN_IN_ALLOW_HTTP: '1' })).toEqual([]);
  });
});
