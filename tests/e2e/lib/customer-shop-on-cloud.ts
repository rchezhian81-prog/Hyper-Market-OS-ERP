// W3 · WF-16 — the customer app served the way the store box serves it, over the PRODUCTION API on real PostgreSQL (the
// same `startRealCloud` the office pages of a connected journey use), so a customer's act in the app and the office's answer
// on its own page meet in ONE head office. One Node server: the app's own files with `window.shopData` injected, the REAL
// customer sign-in service at `/auth/otp/*` (services/identity/src/customer-sign-in.ts, with the recording SMS transport and
// the local test IdP as its signer — a minter never enters the page), and every `/v1/*` call forwarded to the API with the
// app's own bearer token. The customer's login is given BEFORE, the way the product gives any app customer's login — the
// outside-login invite (OB-76) bound to the customer's record, invited by one person and approved by another
// (`inviteAppCustomer`); this server never grants a role. Synthetic data only.

import { readFile } from 'node:fs/promises';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { OtpSimulator } from '../../support/otp-simulator';
import { mountCustomerSignIn, testCustomerSigner } from '../../support/customer-sign-in-test-ports';
import { TEST_IDP } from '../../support/api-harness';
import type { RealCloud } from '../../support/real-store';

const WEB_DIR = 'apps/customer-app/web';
const DATA_MARKER = '<!--SCREEN-DATA-->';

export interface CloudCustomerShop {
  readonly base: string;
  readonly sms: OtpSimulator;
  /** Every non-read call the app made to head office. */
  readonly writes: { method: string; path: string }[];
  stop(): Promise<void>;
}

/**
 * OB-76: an app customer's login, the governed way — the customer's record exists (a loyalty movement makes it), a store
 * manager INVITES the login bound to it, and the owner (a different person who also manages customers) APPROVES.
 */
export async function inviteAppCustomer(cloud: RealCloud, input: { readonly customerId: string; readonly displayName: string; readonly inviter: string; readonly inviterBranch?: string; readonly approver: string }): Promise<void> {
  const step = async (what: string, r: Promise<{ status: number; body: unknown }>) => { const a = await r; if (a.status >= 300) throw new Error(`${what}: ${a.status} ${JSON.stringify(a.body)}`); };
  const id = encodeURIComponent(input.customerId);
  await step('customer record', cloud.request({ method: 'POST', path: `/v1/customers/${id}/points`, userId: cloud.owner, idempotencyKey: `rec-${input.customerId}`, body: { movementId: `pm-${input.customerId}`, kind: 'earn', points: 1 } }));
  await step('invite', cloud.request({ method: 'POST', path: `/v1/identity/outside-logins/customers/${id}/invites/inv-${input.customerId}`, userId: input.inviter, ...(input.inviterBranch === undefined ? {} : { branchId: input.inviterBranch }), idempotencyKey: `inv-${input.customerId}`, body: { displayName: input.displayName } }));
  await step('approve', cloud.request({ method: 'POST', path: `/v1/identity/outside-logins/customers/invites/inv-${input.customerId}/approve`, userId: input.approver, idempotencyKey: `appr-${input.customerId}`, body: {} }));
}

export async function startCustomerShopOnCloud(input: {
  readonly cloud: () => RealCloud; readonly subject: string; readonly shopData: () => Promise<Record<string, unknown>>;
}): Promise<CloudCustomerShop> {
  const auth = mountCustomerSignIn({ tenantId: input.cloud().tenantId, signer: testCustomerSigner({ idp: TEST_IDP, subjectFor: () => input.subject }) });
  const writes: { method: string; path: string }[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (await auth.handle(req, res)) return;
      if (url.pathname.startsWith('/v1/')) {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        if (req.method !== 'GET') writes.push({ method: req.method ?? '?', path: url.pathname });
        const upstream = await fetch(`${input.cloud().baseUrl}${url.pathname}${url.search}`, {
          method: req.method ?? 'GET',
          headers: {
            ...(req.headers.authorization === undefined ? {} : { authorization: String(req.headers.authorization) }),
            ...(req.headers['content-type'] === undefined ? {} : { 'content-type': String(req.headers['content-type']) }),
            ...(req.headers['idempotency-key'] === undefined ? {} : { 'idempotency-key': String(req.headers['idempotency-key']) }),
          },
          ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
        });
        res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' });
        res.end(Buffer.from(await upstream.arrayBuffer()));
        return;
      }
      const file = url.pathname === '/' || url.pathname === '/index.html' ? 'index.html' : url.pathname.replace(/^\//, '');
      try {
        let text = (await readFile(join(WEB_DIR, file))).toString('utf8');
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.webmanifest') ? 'application/manifest+json' : 'application/octet-stream';
        if (file === 'index.html') text = text.replace(DATA_MARKER, `<script>window.shopData = ${JSON.stringify(await input.shopData()).replace(/</g, '\\u003c')};</script>`);
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(text);
      } catch {
        res.writeHead(404);
        res.end('not found');
      }
    })();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({ base: `http://127.0.0.1:${port}`, sms: auth.sms, writes, stop: () => new Promise((done) => { server.close(() => { done(); }); server.closeAllConnections(); }) });
    });
  });
}
