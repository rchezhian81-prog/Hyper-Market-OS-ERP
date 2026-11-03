// Wave 4 (operations, service and the owner's day): the shared fixture for the W4 office-page browser journeys.
//
// Head office is the PRODUCTION API surface (`buildSurface` through the real router, `apiHarness`) — over real PostgreSQL
// (`SqlEventStore` + `SqlIdempotencyStore`, the migrations run) when DATABASE_URL is set, in memory otherwise. The shell plays
// exactly the two parts a deployment's front door plays: it serves the web-erp page with the screen data the store computer
// injects (who is looking and what they may do — read from head office's own `GET /v1/identity/me` for that person, never
// typed in the test), and it forwards every `/v1` request to head office under the signed-in person's token. Nothing in
// between answers for head office. `restart()` builds a new head office over the same database (a restart).
// Synthetic data only: a fresh random tenant per run.

import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Pool } from 'pg';
import type { Browser, Page } from 'playwright-core';
import { apiHarness, TEST_IDP, type ApiHarness } from '../../support/api-harness';
import { SqlIdempotencyStore, type HttpRequest } from '../../../services/kernel/src/index';
import { pgPoolClient } from '../../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../../packages/persistence/src/event-store';
import { runMigrations } from '../../../packages/persistence/src/migrations';

const WEB_DIR = 'apps/web-erp/web';

export interface W4Shop {
  /** Head office now serving (replaced on `restart`). */
  ho(): ApiHarness;
  readonly tenantId: string;
  readonly base: string;
  /** 'PostgreSQL' or 'memory' — what head office keeps its records on in this run. */
  readonly backing: string;
  restart(): Promise<void>;
  stop(): Promise<void>;
}

export interface OpenPage { readonly page: Page; readonly errors: string[]; readonly writes: string[]; close(): Promise<void> }

/** Start head office and the shell. `pages` maps a path (e.g. `/failed-jobs`) to its html file and the window global. */
export async function startW4Shop(input: {
  readonly tenantId: string;
  readonly databaseUrl: string | undefined;
  readonly pages: Readonly<Record<string, { readonly html: string; readonly dataGlobal: string }>>;
  /** More of head office's own composition (e.g. the recording message transport stand-in — never a live provider). */
  readonly harness?: Pick<NonNullable<Parameters<typeof apiHarness>[0]>, 'notificationTransport'>;
}): Promise<W4Shop> {
  const extra = input.harness ?? {};
  let pool: Pool | undefined;
  const build = (): ApiHarness => {
    if (pool === undefined) return apiHarness({ ...extra });
    const sql = pgPoolClient(pool);
    return apiHarness({ ...extra, store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) });
  };
  if (input.databaseUrl !== undefined) {
    pool = new Pool({ connectionString: input.databaseUrl, max: 6, options: '-c app.tenant_id=*' });
    await runMigrations(pgPoolClient(pool), readdirSync('db/migrations').filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(join('db/migrations', name), 'utf8') })));
  }
  let h = build();
  const memory: ApiHarness | undefined = pool === undefined ? h : undefined;

  const tokenFor = (req: IncomingMessage): string => {
    const cookie = req.headers.cookie ?? '';
    const who = /(?:^|;\s*)who=([^;]+)/.exec(cookie)?.[1] ?? 'nobody';
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
        const reply = await h.raw({
          method: (req.method ?? 'GET') as HttpRequest['method'], path: url.pathname, query: Object.fromEntries(url.searchParams), token,
          ...(req.headers['idempotency-key'] === undefined ? {} : { idempotencyKey: String(req.headers['idempotency-key']) }),
          ...(chunks.length === 0 ? {} : { body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }),
        });
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body ?? {}));
        return;
      }
      const page = input.pages[url.pathname];
      const file = page?.html ?? url.pathname.replace(/^\//, '');
      try {
        let body = (await readFile(join(WEB_DIR, file))).toString('utf8');
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        if (page !== undefined) {
          // What the store computer tells the screen: who is looking and what they hold — head office's own answer.
          const me = await h.raw({ method: 'GET', path: '/v1/identity/me', token });
          const who = (me.status === 200 ? me.body : {}) as { userId?: string; permissions?: string[] };
          const data = who.userId === undefined ? {} : { userId: who.userId, permissions: who.permissions ?? [] };
          body = body.replace('<!--SCREEN-DATA-->', `<script>window.${page.dataGlobal} = ${JSON.stringify(data).replace(/</g, '\\u003c')};</script>`);
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
    ho: () => h,
    tenantId: input.tenantId,
    base,
    backing: pool === undefined ? 'memory' : 'PostgreSQL',
    // On PostgreSQL a restart is a new head office over the same database; in memory, over the same store.
    restart: async () => { h = pool === undefined ? apiHarness({ ...extra, store: memory!.store }) : build(); },
    stop: async () => {
      await new Promise<void>((done) => { server.close(() => { done(); }); server.closeAllConnections(); });
      await pool?.end();
    },
  };
}

/** Open a page in a real browser AS a person (at `branch`): every write it sends is listed, every page error kept. */
export async function openAs(shop: W4Shop, browser: Browser, who: string, path: string, branch?: string): Promise<OpenPage> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  const host = new URL(shop.base).hostname;
  await context.addCookies([{ name: 'who', value: who, domain: host, path: '/' }, ...(branch === undefined ? [] : [{ name: 'branch', value: branch, domain: host, path: '/' }])]);
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors: string[] = [];
  const writes: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
  const res = await page.goto(`${shop.base}${path}`, { waitUntil: 'load' });
  if (res?.status() !== 200) throw new Error(`${path} as ${who}: the shell answered ${res?.status()}`);
  return { page, errors, writes, close: () => context.close() };
}

/** Wait until the text of `sel` matches `expected` (the page repaints after a fetch — never read straight after a click). */
export async function says(page: Page, sel: string, expected: RegExp, timeout = 15_000): Promise<void> {
  try {
    await page.waitForFunction(([s, source, flags]) => new RegExp(source!, flags).test((globalThis as unknown as { document: { querySelector(x: string): { textContent: string | null } | null } }).document.querySelector(s!)?.textContent ?? ''), [sel, expected.source, expected.flags], { timeout });
  } catch (e) {
    const now = await page.textContent(sel).catch(() => null);
    throw new Error(`${sel} never read ${String(expected)}; it reads: ${JSON.stringify(now)} (${e instanceof Error ? e.message.split('\n')[0] : String(e)})`);
  }
}
