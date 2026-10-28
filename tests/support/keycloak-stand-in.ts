// A stand-in for ONE customer realm of the identity server (Keycloak) — just the five calls the customer-realm signer makes
// (OB-510 · services/identity/src/keycloak-customer-signer.ts): the client's service sign-in, find a user, make a user, set a
// credential, and the password grant. It signs its tokens RS256 with a key made here and publishes that key, so the signer's
// own check (head office's `verifyToken`) runs for real. It MINTS, which is why it lives in tests/support: the
// `no-test-idp-in-production` guardrail keeps it out of production. The real identity server is proven by
// tests/integration/keycloak-customer-realm.test.ts (which skips without one).

import { generateKeyPairSync, createSign, randomUUID, type KeyObject } from 'node:crypto';

export interface KeycloakStandIn {
  readonly issuer: string;
  readonly realm: string;
  readonly clientSecret: string;
  readonly fetch: typeof globalThis.fetch;
  readonly keyring: { get(kid: string): KeyObject | undefined };
  /** Every call made, as "METHOD path" (form bodies are never kept). */
  readonly calls: string[];
  /** The accounts the realm holds (username → attributes / enabled). */
  readonly users: Map<string, { id: string; enabled: boolean; attributes: Record<string, string[]>; credential?: string }>;
  /** Every one-time credential set, in order (to prove each is fresh and none is reused). */
  readonly credentialsSet: string[];
  /** Break the realm on purpose. */
  readonly faults: { serviceSignIn?: number; tenantClaim?: string; subjectClaim?: string; disable?: boolean };
}

export function keycloakStandIn(input: { readonly base?: string; readonly realm?: string; readonly tenantId: string; readonly audience?: string; readonly now?: () => number }): KeycloakStandIn {
  const realm = input.realm ?? 'sre-store-customers';
  const issuer = `${input.base ?? 'http://idp.test:8080/auth'}/realms/${realm}`;
  const now = input.now ?? (() => Date.now());
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'stand-in-key';
  const clientSecret = `stand-in-${randomUUID()}`;
  const calls: string[] = [];
  const users = new Map<string, { id: string; enabled: boolean; attributes: Record<string, string[]>; credential?: string }>();
  const credentialsSet: string[] = [];
  const faults: KeycloakStandIn['faults'] = {};
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const sign = (claims: Record<string, unknown>): string => {
    const head = b64({ alg: 'RS256', typ: 'JWT', kid });
    const body = b64(claims);
    const s = createSign('RSA-SHA256'); s.update(`${head}.${body}`);
    return `${head}.${body}.${s.sign(privateKey).toString('base64url')}`;
  };
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const serviceTokens = new Set<string>();
  const fetchFn = (async (url: string | URL, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(String(url));
    const method = init.method ?? 'GET';
    calls.push(`${method} ${u.pathname}`);
    const t = Math.floor(now() / 1000);
    if (u.pathname === `${new URL(issuer).pathname}/protocol/openid-connect/token` && method === 'POST') {
      const f = new URLSearchParams(String(init.body));
      if (f.get('client_id') !== 'sre-customer-sign-in' || f.get('client_secret') !== clientSecret) return json(401, { error: 'unauthorized_client' });
      if (f.get('grant_type') === 'client_credentials') {
        if (faults.serviceSignIn !== undefined) return json(faults.serviceSignIn, { error: 'broken' });
        const token = sign({ iss: issuer, aud: input.audience ?? 'sre-retail-os-api', exp: t + 300, iat: t, azp: 'sre-customer-sign-in', tenant_id: input.tenantId });
        serviceTokens.add(token);
        return json(200, { access_token: token, expires_in: 300 });
      }
      if (f.get('grant_type') === 'password') {
        const user = users.get(f.get('username') ?? '');
        if (user === undefined || !user.enabled || user.credential === undefined || user.credential !== f.get('password')) return json(401, { error: 'invalid_grant' });
        return json(200, {
          access_token: sign({
            iss: issuer, aud: input.audience ?? 'sre-retail-os-api', exp: t + 900, iat: t, auth_time: t, jti: randomUUID(),
            tenant_id: faults.tenantClaim ?? input.tenantId, sre_user_id: faults.subjectClaim ?? user.attributes['sre_user_id']?.[0], amr: ['otp'],
          }),
          expires_in: 900,
        });
      }
      return json(400, { error: 'unsupported_grant_type' });
    }
    // The admin calls need the service token.
    const bearer = String((init.headers as Record<string, string> | undefined)?.['authorization'] ?? '').replace(/^Bearer /, '');
    const adminBase = new URL(issuer).pathname.replace(`/realms/${realm}`, `/admin/realms/${realm}`);
    if (!u.pathname.startsWith(adminBase)) return json(404, { error: 'not found' });
    if (!serviceTokens.has(bearer)) return json(401, { error: 'not authorised' });
    const rest = u.pathname.slice(adminBase.length);
    if (rest === '/users' && method === 'GET') {
      const want = u.searchParams.get('username') ?? '';
      return json(200, [...users.entries()].filter(([name]) => name === want).map(([username, x]) => ({ id: x.id, username, enabled: faults.disable === true ? false : x.enabled })));
    }
    if (rest === '/users' && method === 'POST') {
      const body = JSON.parse(String(init.body)) as { username: string; enabled: boolean; attributes: Record<string, string[]> };
      if (users.has(body.username)) return json(409, { errorMessage: 'User exists with same username' });
      users.set(body.username, { id: randomUUID(), enabled: body.enabled, attributes: body.attributes });
      return json(201, undefined, { location: `${issuer}/users/x` });
    }
    const reset = /^\/users\/([^/]+)\/reset-password$/.exec(rest);
    if (reset !== null && method === 'PUT') {
      const user = [...users.values()].find((x) => x.id === decodeURIComponent(reset[1]!));
      if (user === undefined) return json(404, { error: 'no user' });
      const body = JSON.parse(String(init.body)) as { type: string; value: string; temporary: boolean };
      if (body.type !== 'password' || body.temporary !== false || body.value.length < 32) return json(400, { error: 'invalid password' });
      user.credential = body.value;
      credentialsSet.push(body.value);
      return json(204, undefined);
    }
    return json(404, { error: 'not found' });
  }) as unknown as typeof globalThis.fetch;
  return { issuer, realm, clientSecret, fetch: fetchFn, keyring: { get: (k) => (k === kid ? publicKey : undefined) }, calls, users, credentialsSet, faults };
}
