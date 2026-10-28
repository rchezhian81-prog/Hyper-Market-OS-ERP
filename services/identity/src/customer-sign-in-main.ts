// The customer sign-in service's process (M20-FR-01 · ADR-0031): reads its settings from the environment and answers
// `/auth/otp/*` behind the public proxy. Nothing is written to disk and no secret is held.
//
// It is composed with NO SMS provider and NO signer, because none is chosen (OB-222 keeps SMS off; ADR-0031 leaves the
// signer to the owner). So in this build every request for a code is refused in plain words and nothing is sent — and the
// service says so in its start-up line, so nobody mistakes "running" for "switched on" (P-08). Connecting a provider is a
// composition change here, made only after the owner's written decision.

import { createServer, type Server } from 'node:http';
import type { OtpSender } from '../../../packages/identity/src/index';
import { createCustomerSignInHandler, CUSTOMER_STEP_UP_POLICY, type CustomerSessionSigner, type CustomerSignInRequest } from './customer-sign-in';

/** What is missing from the environment, in the operator's words; empty when the service can start. */
export function customerSignInSettingsProblems(env: Readonly<Record<string, string | undefined>>): string[] {
  const problems: string[] = [];
  const origin = (env['CUSTOMER_SIGN_IN_ORIGIN'] ?? '').trim();
  if (origin === '') problems.push("CUSTOMER_SIGN_IN_ORIGIN is not set — the customer app's public address (https://<address>)");
  else if (!/^https:\/\//.test(origin) && env['CUSTOMER_SIGN_IN_ALLOW_HTTP'] !== '1') problems.push('CUSTOMER_SIGN_IN_ORIGIN must be an https address — a code sent over plain http can be read on the way');
  if ((env['CUSTOMER_SIGN_IN_TENANT_ID'] ?? '').trim() === '') problems.push('CUSTOMER_SIGN_IN_TENANT_ID is not set — the shop this public address serves');
  return problems;
}

/** Start the service on `port`. The ports are left out in production (none is chosen); a test may hand them in. */
export function startCustomerSignIn(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly port: number;
  readonly sender?: OtpSender;
  readonly signer?: CustomerSessionSigner;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}): Server {
  const log = input.log ?? ((line: string) => { process.stdout.write(`${line}\n`); });
  const handle = createCustomerSignInHandler({
    tenantId: input.env['CUSTOMER_SIGN_IN_TENANT_ID']!.trim(),
    origin: input.env['CUSTOMER_SIGN_IN_ORIGIN']!.trim(),
    ...(input.sender === undefined ? {} : { sender: input.sender }),
    ...(input.signer === undefined ? {} : { signer: input.signer }),
    stepUp: CUSTOMER_STEP_UP_POLICY,
    now: input.now ?? (() => Date.now()),
    audit: (line) => { log(JSON.stringify({ at: new Date().toISOString(), service: 'customer-sign-in', ...line })); },
  });
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 8192) { res.writeHead(413, { 'cache-control': 'no-store' }).end(); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : v;
      const request: CustomerSignInRequest = {
        method: req.method ?? 'GET', url: req.url ?? '/', headers, body: Buffer.concat(chunks).toString('utf8'),
        ...(req.socket.remoteAddress === undefined ? {} : { remoteAddress: req.socket.remoteAddress }),
      };
      handle(request).then(
        (out) => { res.writeHead(out.status, out.headers).end(out.body); },
        (err: unknown) => {
          // The message only — never the request, which carries a number or a code.
          log(JSON.stringify({ at: new Date().toISOString(), service: 'customer-sign-in', event: 'error', why: err instanceof Error ? err.name : 'unknown' }));
          res.writeHead(503, { 'cache-control': 'no-store', 'content-type': 'application/json' })
            .end(JSON.stringify({ ok: false, error: { code: 'sign_in_unavailable', whatHappened: 'Sign-in is not available right now.', wasItSaved: 'not_saved', nextSafeAction: 'Try again in a minute.' } }));
        },
      );
    });
  });
  server.listen(input.port, () => {
    log(`customer sign-in on :${input.port} for shop ${input.env['CUSTOMER_SIGN_IN_TENANT_ID']!.trim()} — `
      + `SMS: ${input.sender === undefined ? 'NO PROVIDER CONNECTED (OB-222): every request for a code is refused, nothing is sent' : `through ${input.sender.channel}`}; `
      + `signer: ${input.signer === undefined ? 'NONE CHOSEN (ADR-0031): nobody can be signed in' : input.signer.name}`);
  });
  return server;
}

function serve(): void {
  const problems = customerSignInSettingsProblems(process.env);
  if (problems.length > 0) {
    for (const p of problems) process.stderr.write(`customer sign-in REFUSED to start — ${p}\n`);
    process.exit(78);
  }
  const server = startCustomerSignIn({ env: process.env, port: Number(process.env['PORT'] ?? '8093') });
  for (const s of ['SIGTERM', 'SIGINT'] as const) process.on(s, () => server.close(() => process.exit(0)));
}

if (process.argv[1] !== undefined && /customer-sign-in(-main)?\.(m?js|ts)$/.test(process.argv[1])) serve();
