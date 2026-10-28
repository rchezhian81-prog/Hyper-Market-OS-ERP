// R4 Lane 2 — the customer app served the way the store box serves it, over the REAL API kernel (in memory), for the
// online-store browser journeys. One Node server: the app's own files with `window.shopData` injected (from the shop's
// published pack), the REAL customer sign-in service at `/auth/otp/*` (services/identity/src/customer-sign-in.ts, with
// the recording SMS transport and the local test IdP as its signer — a minter never enters the page), and every `/v1/*`
// call handed straight to the API. Synthetic data only.

import { readFile } from 'node:fs/promises';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { OtpSimulator } from '../../support/otp-simulator';
import { mountCustomerSignIn, testCustomerSigner } from '../../support/customer-sign-in-test-ports';
import { TEST_IDP, type ApiHarness } from '../../support/api-harness';

const WEB_DIR = 'apps/customer-app/web';
const DATA_MARKER = '<!--SCREEN-DATA-->';

export interface CustomerShop {
  readonly base: string;
  readonly sms: OtpSimulator;
  /** Every non-read call the app made to the shop. */
  readonly writes: { method: string; path: string }[];
  stop(): Promise<void>;
}

export async function startCustomerShop(input: {
  readonly h: ApiHarness; readonly tenantId: string; readonly subject: string; readonly shopData: () => Promise<Record<string, unknown>>;
}): Promise<CustomerShop> {
  const { h, tenantId: T, subject } = input;
  // Every number signs in as the one synthetic customer this shop is set up for, given the customer role on first sign-in.
  const auth = mountCustomerSignIn({ tenantId: T, signer: testCustomerSigner({ idp: TEST_IDP, subjectFor: () => subject, onSignIn: (s) => h.provisionRole(T, s, 'customer') }) });
  const sms = auth.sms;
  const writes: { method: string; path: string }[] = [];
  const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => { data += String(c); });
      req.on('end', () => { try { resolve(JSON.parse(data || '{}') as Record<string, unknown>); } catch { resolve({}); } });
    });
  const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body ?? null));
  };
  const server: Server = createServer((req, res) => {
    void (async () => {
      const [path = '/', search = ''] = (req.url ?? '/').split('?');
      const query = Object.fromEntries(new URLSearchParams(search));
      if (await auth.handle(req, res)) return;
      if (path.startsWith('/v1/')) {
        const auth = req.headers['authorization'] ?? '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
        const key = req.headers['idempotency-key'];
        const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : undefined;
        if (req.method !== 'GET') writes.push({ method: req.method ?? '?', path });
        const out = await h.raw({ method: (req.method ?? 'GET') as 'GET' | 'POST' | 'PUT', path, query, ...(token === undefined ? {} : { token }), ...(body === undefined ? {} : { body }), ...(typeof key === 'string' ? { idempotencyKey: key } : {}) });
        sendJson(res, out.status, out.body);
        return;
      }
      const file = path === '/' || path === '/index.html' ? 'index.html' : path.replace(/^\//, '');
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
      resolve({ base: `http://127.0.0.1:${port}`, sms, writes, stop: () => new Promise((done) => { server.close(() => { done(); }); server.closeAllConnections(); }) });
    });
  });
}
