// The sign-in service's process (OB-15-b · ADR-0019): reads its settings, holds the identity server's public keys, and
// answers the front door. Every setting arrives from the environment; nothing is written to disk; no secret is held
// (the product's client at the identity server is PUBLIC — PKCE, not a client secret, binds each sign-in).

import { createServer } from 'node:http';
import { jwksKeyring } from './jwks';
import { createSignInHandler, type SignInRequest } from './sign-in';

/** What is missing from the environment, in the operator's words; empty when the service can start. */
export function signInSettingsProblems(env: Readonly<Record<string, string | undefined>>): string[] {
  const need: ReadonlyArray<readonly [string, string]> = [
    ['SIGN_IN_ISSUER', "the identity server realm's public address (https://<address>/auth/realms/sre-store)"],
    ['SIGN_IN_INTERNAL_ISSUER', 'the same realm on the private network (http://idp:8080/auth/realms/sre-store)'],
    ['SIGN_IN_ORIGIN', "the screens' public address (https://<address>)"],
    ['IDP_AUDIENCE', "the API's name in the tokens (sre-retail-os-api)"],
  ];
  const problems = need.filter(([k]) => (env[k] ?? '').trim() === '').map(([k, what]) => `${k} is not set — ${what}`);
  for (const k of ['SIGN_IN_ISSUER', 'SIGN_IN_ORIGIN']) {
    const v = env[k];
    if (v !== undefined && v.trim() !== '' && !/^https:\/\//.test(v) && env['SIGN_IN_ALLOW_HTTP'] !== '1') {
      problems.push(`${k} must be an https address — a sign-in over plain http can be read on the way`);
    }
  }
  return problems;
}

function serve(): void {
  const env = process.env;
  const problems = signInSettingsProblems(env);
  if (problems.length > 0) {
    for (const p of problems) process.stderr.write(`sign-in REFUSED to start — ${p}\n`);
    process.exit(78);
  }
  const internal = env['SIGN_IN_INTERNAL_ISSUER']!.replace(/\/+$/, '');
  const keyring = jwksKeyring({
    url: `${internal}/protocol/openid-connect/certs`, fetch: globalThis.fetch,
    onProblem: (d) => { process.stderr.write(`sign-in: identity server: ${d}\n`); },
  });
  void keyring.refresh();
  const apiUrl = (env['API_INTERNAL_URL'] ?? 'http://api:8081').replace(/\/+$/, '');
  const handle = createSignInHandler({
    settings: { issuer: env['SIGN_IN_ISSUER']!, internalIssuer: internal, clientId: env['SIGN_IN_CLIENT_ID'] ?? 'sre-web', origin: env['SIGN_IN_ORIGIN']! },
    policy: {
      algorithm: 'RS256', secret: '', keyring, subjectClaim: 'sre_user_id',
      issuer: env['SIGN_IN_ISSUER']!, audience: env['IDP_AUDIENCE']!, maxLifetimeSeconds: Number(env['IDP_MAX_TOKEN_LIFETIME_SECONDS'] ?? '2678400'),
    },
    fetch: globalThis.fetch,
    now: () => Date.now(),
    audit: (line) => { process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`); },
    fetchMe: async (bearer, forwardedFor) => {
      const res = await fetch(`${apiUrl}/v1/identity/me`, {
        headers: { authorization: `Bearer ${bearer}`, accept: 'application/json', 'x-forwarded-for': forwardedFor },
        signal: AbortSignal.timeout(5000),
      });
      return { status: res.status, body: res.ok ? await res.json() as unknown : undefined };
    },
  });

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 8192) { res.writeHead(413).end(); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : v;
      const request: SignInRequest = { method: req.method ?? 'GET', url: req.url ?? '/', headers, body: Buffer.concat(chunks).toString('utf8') };
      handle(request).then(
        (out) => { res.writeHead(out.status, out.headers).end(out.body); },
        (err: unknown) => {
          process.stderr.write(`sign-in error: ${err instanceof Error ? err.message : String(err)}\n`);
          res.writeHead(503, { 'cache-control': 'no-store', 'content-type': 'text/plain' }).end('Sign-in is not available right now. Nothing was changed.');
        },
      );
    });
  });
  const port = Number(env['PORT'] ?? '8092');
  server.listen(port, () => process.stdout.write(`sign-in service on :${port} for ${env['SIGN_IN_ISSUER']}\n`));
  for (const s of ['SIGTERM', 'SIGINT'] as const) process.on(s, () => server.close(() => process.exit(0)));
}

if (process.argv[1] !== undefined && /sign-in(-main)?\.(m?js|ts)$/.test(process.argv[1])) serve();
