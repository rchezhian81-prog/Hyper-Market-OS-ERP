// R4 Lane 2 — the customer app served the way the store box serves it, over the REAL API kernel (in memory), for the
// online-store browser journeys. One Node server: the app's own files with `window.shopData` injected (from the shop's
// published pack), the auth backend with the production OTP engines and the local test IdP (a minter never enters the
// page), and every `/v1/*` call handed straight to the API. Synthetic data only.

import { readFile } from 'node:fs/promises';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { beginOtpChallenge, verifyOtp, type OtpChallenge } from '../../../packages/identity/src/index';
import { createOtpSimulator } from '../../support/otp-simulator';
import { TEST_IDP, type ApiHarness } from '../../support/api-harness';

const WEB_DIR = 'apps/customer-app/web';
const DATA_MARKER = '<!--SCREEN-DATA-->';

export interface CustomerShop {
  readonly base: string;
  readonly sms: ReturnType<typeof createOtpSimulator>;
  /** Every non-read call the app made to the shop. */
  readonly writes: { method: string; path: string }[];
  stop(): Promise<void>;
}

export async function startCustomerShop(input: {
  readonly h: ApiHarness; readonly tenantId: string; readonly subject: string; readonly shopData: () => Promise<Record<string, unknown>>;
}): Promise<CustomerShop> {
  const { h, tenantId: T, subject } = input;
  const sms = createOtpSimulator();
  const challenges = new Map<string, OtpChallenge>();
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
      const [path = '/'] = (req.url ?? '/').split('?');
      if (req.method === 'POST' && path === '/auth/otp/begin') {
        const body = await readBody(req);
        const challengeId = `c-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const begun = beginOtpChallenge({ challengeId, tenantId: T, phoneNumber: String(body['phoneNumber'] ?? ''), purpose: 'login', now: new Date().toISOString() });
        challenges.set(challengeId, begun.challenge);
        sms.send({ phoneNumber: begun.challenge.phoneNumber, code: begun.code, purpose: 'login', tenantId: T });
        sendJson(res, 200, { ok: true, challengeId });
        return;
      }
      if (req.method === 'POST' && path === '/auth/otp/verify') {
        const body = await readBody(req);
        const challenge = challenges.get(String(body['challengeId'] ?? ''));
        if (challenge === undefined) { sendJson(res, 200, { ok: false, reason: 'unknown_challenge' }); return; }
        const v = verifyOtp({ challenge, tenantId: T, submittedCode: String(body['code'] ?? ''), now: new Date().toISOString() });
        if (!v.verified) { sendJson(res, 200, { ok: false, reason: v.outcome }); return; }
        challenges.set(challenge.challengeId, v.challenge);
        await h.provisionRole(T, subject, 'customer');
        sendJson(res, 200, { ok: true, token: TEST_IDP.issue({ sub: subject, tenantId: T, amr: ['otp'] }), sessionId: `s-${Date.now()}` });
        return;
      }
      if (req.method === 'POST' && path === '/auth/signout') { sendJson(res, 200, { ok: true }); return; }
      if (path.startsWith('/v1/')) {
        const auth = req.headers['authorization'] ?? '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
        const key = req.headers['idempotency-key'];
        const body = req.method === 'POST' ? await readBody(req) : undefined;
        if (req.method !== 'GET') writes.push({ method: req.method ?? '?', path });
        const out = await h.raw({ method: (req.method ?? 'GET') as 'GET' | 'POST', path, ...(token === undefined ? {} : { token }), ...(body === undefined ? {} : { body }), ...(typeof key === 'string' ? { idempotencyKey: key } : {}) });
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
