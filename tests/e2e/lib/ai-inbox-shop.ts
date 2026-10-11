// The shared fixture for the three connected AI-inbox browser journeys (audit EA-09 · A06 / A08 / A10).
//
// A REAL API (`startRealCloud` — the production assembly over real PostgreSQL) and a shell that plays exactly the two
// parts a deployment's front door plays: it serves the web-erp page with the screen data the store computer injects
// (who is looking and what they may do — read here from head office's own `GET /v1/identity/me` for that person, never
// typed in the test), and it forwards every `/v1` request to the API with the signed-in person's token. Nothing in
// between answers for the API: no stub, no flipped fixture.

import { readFile } from 'node:fs/promises';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright-core';
import { startRealCloud, type RealCloud } from '../../support/real-store';
import { TEST_IDP } from '../../support/api-harness';

export const OWNER = 'u-owner';
/** A store manager whose grant reaches ONE branch, br-1 — holds the AI inbox read and set-aside permissions. */
export const MGR = 'u-mgr-br1';
const WEB_DIR = 'apps/web-erp/web';

export interface InboxShop {
  /** The API now serving (replaced on `restart`). */
  cloud(): RealCloud;
  /** The shell's origin. */
  readonly base: string;
  /** Stop the API and start it again over the same database and shop — a restart. */
  restart(): Promise<void>;
  /** A browser context signed in as `who` (at `branch`). */
  signIn(context: BrowserContext, who: string, branch?: string): Promise<void>;
  stop(): Promise<void>;
}

export async function ok(p: Promise<{ status: number; body: unknown }>, label: string): Promise<void> {
  const r = await p;
  if (r.status >= 300) throw new Error(`${label}: ${r.status} ${JSON.stringify(r.body)}`);
}

/**
 * Start the shop: the real API, the br-1 manager's grant (asked by one person, approved by the owner), and the
 * agents switched on by name with the kill switch off. `seed` lays down the governed records the inbox reads.
 */
export async function startInboxShop(input: {
  readonly databaseUrl: string; readonly tenantId: string; readonly signingKey: string;
  /** The page: its html file, and the window global the store computer injects for it. */
  readonly page: { readonly path: string; readonly html: string; readonly dataGlobal: string };
  readonly seed: (cloud: RealCloud) => Promise<void>;
}): Promise<InboxShop> {
  let cloud = await startRealCloud({ databaseUrl: input.databaseUrl, tenantId: input.tenantId, owner: OWNER, packSigningKey: input.signingKey });
  const gid = `grant-${MGR}`;
  await ok(cloud.request({ method: 'POST', path: '/v1/identity/grants', userId: 'u-hr', idempotencyKey: `${gid}-ask`, body: { grantId: gid, userId: MGR, roleId: 'store_manager', branchScope: ['br-1'], reason: 'br-1 only' } }), 'ask grant');
  await ok(cloud.request({ method: 'POST', path: `/v1/identity/grants/${gid}/approve`, userId: OWNER, idempotencyKey: `${gid}-approve`, body: {} }), 'approve grant');
  await input.seed(cloud);
  await ok(cloud.request({ method: 'PUT', path: '/v1/ai/kill-switch', userId: OWNER, idempotencyKey: 'unkill', body: { on: false } }), 'unkill');
  await ok(cloud.request({ method: 'PUT', path: '/v1/ai/agents/enabled', userId: OWNER, idempotencyKey: 'enable', body: { agents: ['A06', 'A08', 'A10'] } }), 'enable');

  const tokenFor = (req: IncomingMessage): string => {
    const cookie = req.headers.cookie ?? '';
    const who = /(?:^|;\s*)who=([^;]+)/.exec(cookie)?.[1] ?? OWNER;
    const branch = /(?:^|;\s*)branch=([^;]+)/.exec(cookie)?.[1];
    return TEST_IDP.issue({ sub: who, tenantId: input.tenantId, ...(branch === undefined ? {} : { branchId: branch }) });
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const token = tokenFor(req);
      if (url.pathname.startsWith('/v1/')) {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const upstream = await fetch(`${cloud.baseUrl}${url.pathname}${url.search}`, {
          method: req.method ?? 'GET',
          headers: {
            authorization: `Bearer ${token}`,
            ...(req.headers['content-type'] === undefined ? {} : { 'content-type': String(req.headers['content-type']) }),
            ...(req.headers['idempotency-key'] === undefined ? {} : { 'idempotency-key': String(req.headers['idempotency-key']) }),
          },
          ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
        });
        res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
        res.end(Buffer.from(await upstream.arrayBuffer()));
        return;
      }
      const file = url.pathname === '/' || url.pathname === input.page.path ? input.page.html : url.pathname.replace(/^\//, '');
      try {
        let body = (await readFile(join(WEB_DIR, file))).toString('utf8');
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        if (file.endsWith('.html')) {
          // What the store computer tells the screen: who is looking and what they hold — head office's answer.
          const me = await fetch(`${cloud.baseUrl}/v1/identity/me`, { headers: { authorization: `Bearer ${token}` } });
          const who = (await me.json()) as { userId: string; permissions: string[] };
          const data = { userId: who.userId, permissions: who.permissions };
          body = body.replace('<!--SCREEN-DATA-->', `<script>window.${input.page.dataGlobal} = ${JSON.stringify(data).replace(/</g, '\\u003c')};</script>`);
        }
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end('not found');
      }
    })();
  });
  const base = await new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(`http://127.0.0.1:${typeof addr === 'object' && addr !== null ? addr.port : 0}`);
    });
  });

  return {
    cloud: () => cloud,
    base,
    restart: async () => {
      await cloud.stop();
      cloud = await startRealCloud({ databaseUrl: input.databaseUrl, tenantId: input.tenantId, owner: OWNER, packSigningKey: input.signingKey });
    },
    signIn: async (context, who, branch) => {
      const host = new URL(base).hostname;
      await context.addCookies([{ name: 'who', value: who, domain: host, path: '/' }, ...(branch === undefined ? [] : [{ name: 'branch', value: branch, domain: host, path: '/' }])]);
    },
    stop: async () => {
      await new Promise<void>((done) => { server.close(() => { done(); }); server.closeAllConnections(); });
      await cloud.stop();
    },
  };
}
