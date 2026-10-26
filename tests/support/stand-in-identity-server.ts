// A STAND-IN IDENTITY SERVER for the store computer's head-office sign-in tests (OB-388 · ADR-0029).
//
// It plays Keycloak's part the way a browser meets it: a discovery document, the published keys, an authorisation page
// with a login form (username, password and — for a person who has one — the one-time code), a token endpoint that checks
// PKCE and issues RS256 tokens carrying the product's claims (`sre_user_id`, `tenant_id`, `amr`, our audience), refreshes
// (refused once a person is switched off — a leaver), and a sign-out page. Keys and passwords are made at run time; the
// product code under test signs nothing. Everything about it can be changed by the test: a person's shop, their second
// step, how long a token lives, whether the server answers at all.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';

export interface StandInPerson {
  readonly username: string;
  readonly password: string;
  /** The product's person (`sre_user_id`). */
  readonly sreUserId: string;
  /** The shop the realm puts in the token (`tenant_id`). */
  tenantId: string;
  /** Has a one-time code set up (a second step); the code this stand-in accepts is `otp`. */
  otp?: string;
  /** Switched off (a leaver): no sign-in, no refresh. */
  disabled?: boolean;
}

export interface StandInIdentityServer {
  /** `http://localhost:<port>/realms/sre-store` — a DIFFERENT site from the store PC's 127.0.0.1, as a real one is. */
  readonly issuer: string;
  readonly publicKey: KeyObject;
  readonly people: Map<string, StandInPerson>;
  /** How long each access token lives, in seconds (default 300). */
  accessSeconds: number;
  /** What it has been asked, for the test to read. */
  readonly asked: string[];
  /** Stop answering (the line is down); `up()` answers again on the same address. */
  down(): Promise<void>;
  up(): Promise<void>;
  stop(): Promise<void>;
}

const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url');
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export async function startStandInIdentityServer(input: { readonly audience?: string } = {}): Promise<StandInIdentityServer> {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = randomBytes(6).toString('hex');
  const audience = input.audience ?? 'sre-retail-os-api';
  const people = new Map<string, StandInPerson>();
  const pending = new Map<string, { redirect: string; state: string; nonce: string; challenge: string; prompt: string | null }>();
  const codes = new Map<string, { user: string; nonce: string; challenge: string; redirect: string; amr: readonly string[] }>();
  const refreshes = new Map<string, { user: string; amr: readonly string[] }>();
  const asked: string[] = [];
  let port = 0;
  let issuer = '';
  const jwt = (payload: Record<string, unknown>): string => {
    const h = b64({ alg: 'RS256', kid, typ: 'JWT' });
    const p = b64(payload);
    return `${h}.${p}.${sign('RSA-SHA256', Buffer.from(`${h}.${p}`), keys.privateKey).toString('base64url')}`;
  };
  const access = (person: StandInPerson, amr: readonly string[]): string => {
    const iat = Math.floor(Date.now() / 1000);
    return jwt({
      iss: issuer, aud: [audience], sub: `kc-${person.username}`, sre_user_id: person.sreUserId, tenant_id: person.tenantId,
      amr, iat, auth_time: iat, exp: iat + api.accessSeconds, jti: randomBytes(8).toString('hex'),
    });
  };
  const readBody = (req: IncomingMessage): Promise<string> => new Promise((resolve) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
  });
  const json = (res: ServerResponse, status: number, body: unknown): void => { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body)); };

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      const url = new URL(req.url ?? '/', issuer.replace(/\/realms\/.*/, ''));
      const path = url.pathname.replace(/^\/realms\/sre-store/, '');
      asked.push(`${req.method} ${path}`);
      if (path === '/.well-known/openid-configuration') { json(res, 200, { issuer, authorization_endpoint: `${issuer}/protocol/openid-connect/auth` }); return; }
      if (path === '/protocol/openid-connect/certs') {
        const jwk = keys.publicKey.export({ format: 'jwk' });
        json(res, 200, { keys: [{ ...jwk, kid, use: 'sig', alg: 'RS256' }] });
        return;
      }
      if (path === '/protocol/openid-connect/auth') {
        const id = randomBytes(12).toString('hex');
        pending.set(id, {
          redirect: url.searchParams.get('redirect_uri') ?? '', state: url.searchParams.get('state') ?? '', nonce: url.searchParams.get('nonce') ?? '',
          challenge: url.searchParams.get('code_challenge') ?? '', prompt: url.searchParams.get('prompt'),
        });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><html><body><h1 id="kc-title">Sign in to head office</h1>
<form id="kc-form-login" method="post" action="${esc(`${issuer}/login-actions/authenticate?session=${id}`)}">
<label>Username <input id="username" name="username"></label><label>Password <input id="password" name="password" type="password"></label>
<label>One-time code <input id="otp" name="otp"></label><button id="kc-login" type="submit">Sign in</button></form></body></html>`);
        return;
      }
      if (path === '/login-actions/authenticate' && req.method === 'POST') {
        const started = pending.get(url.searchParams.get('session') ?? '');
        const form = new URLSearchParams(await readBody(req));
        const person = people.get(form.get('username') ?? '');
        if (started === undefined || person === undefined || person.disabled === true || person.password !== form.get('password')) {
          res.writeHead(200, { 'content-type': 'text/html' }).end('<p id="kc-error">Invalid username or password.</p>');
          return;
        }
        // A person with a one-time code is asked for it; the code proves the second step (`otp` in `amr`).
        if (person.otp !== undefined && form.get('otp') !== person.otp) {
          res.writeHead(200, { 'content-type': 'text/html' }).end('<p id="kc-error">Invalid one-time code.</p>');
          return;
        }
        pending.delete(url.searchParams.get('session') ?? '');
        const code = randomBytes(12).toString('hex');
        codes.set(code, { user: person.username, nonce: started.nonce, challenge: started.challenge, redirect: started.redirect, amr: person.otp === undefined ? ['pwd'] : ['pwd', 'otp'] });
        const back = new URL(started.redirect);
        back.searchParams.set('code', code);
        back.searchParams.set('state', started.state);
        res.writeHead(302, { location: back.toString() }).end();
        return;
      }
      if (path === '/protocol/openid-connect/token' && req.method === 'POST') {
        const form = new URLSearchParams(await readBody(req));
        if (form.get('grant_type') === 'authorization_code') {
          const c = codes.get(form.get('code') ?? '');
          codes.delete(form.get('code') ?? '');
          const ok = c !== undefined && c.redirect === form.get('redirect_uri') && createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') === c.challenge;
          const person = c === undefined ? undefined : people.get(c.user);
          if (!ok || person === undefined) { json(res, 400, { error: 'invalid_grant' }); return; }
          const refresh = randomBytes(16).toString('hex');
          refreshes.set(refresh, { user: person.username, amr: c.amr });
          json(res, 200, { access_token: access(person, c.amr), refresh_token: refresh, id_token: jwt({ iss: issuer, aud: 'sre-web', sub: `kc-${person.username}`, nonce: c.nonce }) });
          return;
        }
        if (form.get('grant_type') === 'refresh_token') {
          const r = refreshes.get(form.get('refresh_token') ?? '');
          const person = r === undefined ? undefined : people.get(r.user);
          if (r === undefined || person === undefined || person.disabled === true) { json(res, 400, { error: 'invalid_grant' }); return; }
          json(res, 200, { access_token: access(person, r.amr), refresh_token: form.get('refresh_token') });
          return;
        }
        json(res, 400, { error: 'unsupported_grant_type' });
        return;
      }
      if (path === '/protocol/openid-connect/logout') { res.writeHead(200, { 'content-type': 'text/html' }).end('<p id="kc-logged-out">You are signed out.</p>'); return; }
      res.writeHead(404).end();
    })();
  };

  let server: Server = createServer(handler);
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve(); }); });
  port = (server.address() as AddressInfo).port;
  issuer = `http://localhost:${port}/realms/sre-store`;

  const api: StandInIdentityServer = {
    issuer, publicKey: keys.publicKey, people, accessSeconds: 300, asked,
    down: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
    up: async () => {
      server = createServer(handler);
      await new Promise<void>((resolve) => { server.listen(port, '127.0.0.1', () => { resolve(); }); });
    },
    stop: () => new Promise((resolve) => { if (!server.listening) { resolve(); return; } server.close(() => resolve()); server.closeAllConnections(); }),
  };
  return api;
}

/** A person with a password made at run time and, unless told otherwise, a one-time code (a second step). */
export function standInPerson(input: { readonly sreUserId: string; readonly tenantId: string; readonly secondStep?: boolean }): StandInPerson {
  return {
    username: input.sreUserId, password: randomBytes(12).toString('base64url'), sreUserId: input.sreUserId, tenantId: input.tenantId,
    ...(input.secondStep === false ? {} : { otp: String(100000 + (randomBytes(3).readUIntBE(0, 3) % 900000)) }),
  };
}
