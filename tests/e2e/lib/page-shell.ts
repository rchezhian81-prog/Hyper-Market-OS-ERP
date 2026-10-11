// A page's front door in front of the REAL API (audit SF-10 / EA-09 connected browser runs): serves one web-erp page with
// the screen data the store computer injects — who is looking and what they hold, read from head office's own
// `GET /v1/identity/me` for that person, never typed in the test — and forwards every `/v1` request to the API with the
// signed-in person's token (the `who` / `branch` cookies the test sets on the browser context). No stub answers for the API.

import { readFile } from 'node:fs/promises';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright-core';
import type { RealCloud } from '../../support/real-store';
import { TEST_IDP } from '../../support/api-harness';

const WEB_DIR = 'apps/web-erp/web';

export interface PageShell {
  readonly base: string;
  signIn(context: BrowserContext, who: string, branch?: string): Promise<void>;
  stop(): Promise<void>;
}

export async function startPageShell(input: {
  readonly cloud: () => RealCloud;
  /** The page: the path it answers on, its html file, and the window global the store computer injects for it. */
  readonly page: { readonly path: string; readonly html: string; readonly dataGlobal: string };
  /** Extra screen data the store computer would add (e.g. import templates). */
  readonly extra?: Record<string, unknown>;
}): Promise<PageShell> {
  const tokenFor = (req: IncomingMessage): string => {
    const cookie = req.headers.cookie ?? '';
    const who = /(?:^|;\s*)who=([^;]+)/.exec(cookie)?.[1] ?? input.cloud().owner;
    const branch = /(?:^|;\s*)branch=([^;]+)/.exec(cookie)?.[1];
    return TEST_IDP.issue({ sub: who, tenantId: input.cloud().tenantId, ...(branch === undefined ? {} : { branchId: branch }) });
  };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const token = tokenFor(req);
      if (url.pathname.startsWith('/v1/')) {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const upstream = await fetch(`${input.cloud().baseUrl}${url.pathname}${url.search}`, {
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
          const me = (await (await fetch(`${input.cloud().baseUrl}/v1/identity/me`, { headers: { authorization: `Bearer ${token}` } })).json()) as { userId: string; permissions: string[] };
          const data = { userId: me.userId, permissions: me.permissions, ...(input.extra ?? {}) };
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
    base,
    signIn: async (context, who, branch) => {
      const host = new URL(base).hostname;
      await context.addCookies([{ name: 'who', value: who, domain: host, path: '/' }, ...(branch === undefined ? [] : [{ name: 'branch', value: branch, domain: host, path: '/' }])]);
    },
    stop: () => new Promise<void>((done) => { server.close(() => { done(); }); server.closeAllConnections(); }),
  };
}
