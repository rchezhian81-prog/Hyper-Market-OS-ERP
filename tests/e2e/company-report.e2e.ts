import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startRealCloud, type RealCloud } from '../support/real-store';
import { TEST_IDP } from '../support/api-harness';

/**
 * **Company-wide report drill-down, end to end in a real browser against the PRODUCTION API (audit EA-04 · M01 / M29 /
 * D13 / M30-FR-02).**
 *
 * Until EA-04 this page fetched `/consolidation` and `/consolidation/export` — paths only the test's own stub server
 * answered; the production API returned 404 for both. Now the page asks `GET /v1/consolidation` and
 * `POST /v1/consolidation/export` on its own origin under the signed-in person's session, and this test serves it in
 * front of the REAL API assembly (`startApi`, as the application role over real PostgreSQL) — the shell plays only the
 * part the sign-in proxy plays in a deployment: it puts the signed-in person's token on each `/v1` request. The
 * branches' contributions are seeded through the real ingest route.
 *
 * It proves, through Chromium:
 *   • a company total across the branches that reported (Anna Nagar + T. Nagar), shown in rupees;
 *   • shown HONESTLY — a stale branch drops the badge to "stale", a silent branch (Velachery) is NAMED missing and the
 *     node does not reconcile (P-08);
 *   • drill from the total to the per-branch contributors, worst-first;
 *   • a branch view RECOMPUTES the total and NAMES what was withheld (§28);
 *   • export goes through head office's authorised, logged path — a branch view exports only its branch, the company
 *     view all of them — and the export is on head office's export log;
 *   • a manager of ONE branch, signed in as themselves, sees only that branch — the server's scope, not the page's;
 *   • OB-391: the company and every branch NAME are head office's own (`GET /v1/org/nodes`) — the page writes none in.
 *
 * A second suite (no database needed) serves the page in front of a stand-in head office to prove the OB-391 edges:
 * two companies give a company choice and each its own branches; a refused or an unreachable organisation read is said
 * in plain words and no figure is shown; a company with no name is shown by its id, never by an invented name.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const DATABASE_URL = process.env['DATABASE_URL'];
const WEB_DIR = 'apps/web-erp/web';
const KEY = ['company', 'report', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');
const OWNER = 'u-owner';
const MGR1 = 'u-mgr-br1';

const PERIOD = new Date().toISOString().slice(0, 7);
const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();

interface Shell { base: string; stop: () => Promise<void> }

/**
 * The page's origin: static files from the web-erp dir, and every `/v1` request forwarded to the REAL API with the
 * signed-in person's token — the person named by the `who` cookie the test sets on the browser context.
 */
async function startShell(cloud: RealCloud): Promise<Shell> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname.startsWith('/v1/')) {
        const who = /(?:^|;\s*)who=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? OWNER;
        const branch = /(?:^|;\s*)branch=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const token = TEST_IDP.issue({ sub: who, tenantId: cloud.tenantId, ...(branch === undefined ? {} : { branchId: branch }) });
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
      const file = url.pathname === '/' || url.pathname === '/company-report' ? 'company-report.html' : url.pathname.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(buf);
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
      resolve({ base: `http://127.0.0.1:${port}`, stop: () => new Promise((done) => { server.close(() => { done(); }); server.closeAllConnections(); }) });
    });
  });
}

describe.skipIf(!HAVE_BROWSER || DATABASE_URL === undefined)('company-wide report on the PRODUCTION API, in a real browser (EA-04 · M01/M29/D13)', () => {
  let browser: Browser;
  let cloud: RealCloud;
  let shell: Shell;

  beforeAll(async () => {
    cloud = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId: randomUUID(), owner: OWNER, packSigningKey: KEY });
    // OB-391: the company and its branches, each with the name head office keeps — the page shows these and only these.
    expect((await cloud.request({ method: 'POST', path: '/v1/org/nodes/co-1', userId: OWNER, idempotencyKey: 'org-co-1', body: { kind: 'company', name: 'Test Company One' } })).status).toBeLessThan(300);
    for (const [b, name] of [['br-1', 'Test Branch North'], ['br-2', 'Test Branch South'], ['br-3', 'Test Branch East']] as const) {
      const r = await cloud.request({ method: 'POST', path: `/v1/org/nodes/${b}`, userId: OWNER, idempotencyKey: `org-${b}`, body: { kind: 'branch', name, parentId: 'co-1', companyId: 'co-1' } });
      expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    }
    // A manager of ONE branch (br-1): asked for by u-hr, approved by the owner — two acts.
    const gid = `grant-${MGR1}`;
    expect((await cloud.request({ method: 'POST', path: '/v1/identity/grants', userId: 'u-hr', idempotencyKey: `${gid}-ask`, body: { grantId: gid, userId: MGR1, roleId: 'store_manager', branchScope: ['br-1'], reason: 'br-1 only' } })).status).toBe(202);
    expect((await cloud.request({ method: 'POST', path: `/v1/identity/grants/${gid}/approve`, userId: OWNER, idempotencyKey: `${gid}-approve`, body: {} })).status).toBe(201);
    // Three branches under co-1; br-1 reported 30 minutes ago (fresh), br-2 two days ago (stale), br-3 never.
    for (const b of ['br-1', 'br-2', 'br-3']) {
      expect((await cloud.request({ method: 'POST', path: '/v1/consolidation/memberships', userId: OWNER, idempotencyKey: `mem-${b}`, body: { branchId: b, parentId: 'co-1', from: '2026-01-01' } })).status).toBe(201);
    }
    for (const [b, gross, net, refreshed] of [['br-1', 100_000, 90_000, ago(30)], ['br-2', 250_000, 225_000, ago(2 * 24 * 60)]] as const) {
      const r = await cloud.request({ method: 'POST', path: '/v1/consolidation/contributions', userId: OWNER, idempotencyKey: `con-${b}`, body: { branchId: b, period: PERIOD, family: 'sales', measures: { grossMinor: gross, netMinor: net }, lastRefreshAt: refreshed, revision: 1 } });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    shell = await startShell(cloud);
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await shell?.stop();
    await cloud?.stop();
  });

  const signedInAs = async (who: string, branch?: string): Promise<{ page: Page; close: () => Promise<void> }> => {
    const context = await browser.newContext();
    const host = new URL(shell.base).hostname;
    await context.addCookies([{ name: 'who', value: who, domain: host, path: '/' }, ...(branch === undefined ? [] : [{ name: 'branch', value: branch, domain: host, path: '/' }])]);
    const page = await context.newPage();
    return { page, close: () => context.close() };
  };

  it('the owner sees the honest company total, drills to branches, recomputes on scope, and exports through head office', async () => {
    const { page, close } = await signedInAs(OWNER);
    const asked: string[] = [];
    page.on('request', (r) => { if (new URL(r.url()).pathname.startsWith('/')) asked.push(`${r.method()} ${new URL(r.url()).pathname}`); });
    try {
      // OB-391: no node in the address — the page takes head office's one company.
      await page.goto(`${shell.base}/company-report?period=${PERIOD}`, { waitUntil: 'load' });

      await page.locator('.kpi .v[data-measure="grossMinor"]', { hasText: /3,500\.00/ }).waitFor({ timeout: 10_000 });
      // Every name is head office's: the scope list and the rows carry the branches it keeps, by its names.
      await page.locator('#scope option', { hasText: 'Test Branch North — branch only' }).waitFor({ state: 'attached', timeout: 10_000 });
      expect(await page.$$eval('#scope option', (o) => o.map((x) => x.textContent))).toEqual(['Whole company', 'Test Branch East — branch only', 'Test Branch North — branch only', 'Test Branch South — branch only']);
      await page.locator('#missing', { hasText: 'Test Branch East (br-3)' }).waitFor({ timeout: 10_000 });
      expect(asked).toContain('GET /v1/org/nodes');
      await page.locator('#freshness.stale').waitFor({ timeout: 10_000 });
      await page.locator('#missing', { hasText: 'br-3' }).waitFor({ timeout: 10_000 });
      await page.locator('#reconcile', { hasText: /does NOT reconcile/i }).waitFor({ timeout: 10_000 });

      await page.locator('#rows tr:nth-child(2)').waitFor({ timeout: 10_000 });
      const branchRows = page.locator('#rows tr');
      expect(await branchRows.count()).toBe(2);
      expect(await branchRows.first().getAttribute('data-branch')).toBe('br-2');
      expect(await branchRows.first().textContent()).toContain('Test Branch South (br-2)');

      await page.selectOption('#scope', 'br-1');
      await page.locator('.kpi .v[data-measure="grossMinor"]', { hasText: /1,000\.00/ }).waitFor({ timeout: 10_000 });
      await page.locator('#withheld', { hasText: 'br-2' }).waitFor({ timeout: 10_000 });

      await page.click('#export');
      await page.locator('#export-status', { hasText: /Exported 1 branch/ }).waitFor({ timeout: 10_000 });
      const scopedCsv = await page.locator('#preview').textContent();
      expect(scopedCsv).toContain('br-1');
      expect(scopedCsv).not.toContain('br-2');

      await page.selectOption('#scope', 'all');
      await page.locator('.kpi .v[data-measure="grossMinor"]', { hasText: /3,500\.00/ }).waitFor({ timeout: 10_000 });
      await page.click('#export');
      await page.locator('#export-status', { hasText: /Exported 2 branch/ }).waitFor({ timeout: 10_000 });
      const companyCsv = await page.locator('#preview').textContent();
      expect(companyCsv).toContain('br-1');
      expect(companyCsv).toContain('br-2');

      // Only the production routes were asked — never the old stub paths.
      expect(asked.filter((a) => a.includes('consolidation'))).toEqual(expect.arrayContaining(['GET /v1/consolidation', 'POST /v1/consolidation/export']));
      expect(asked.some((a) => / \/consolidation/.test(a))).toBe(false);
      // Both exports are on head office's export log, in the owner's name.
      const log = (await cloud.request({ method: 'GET', path: '/v1/exports', userId: OWNER })).body as { exports: { domain: string; userId: string; rowCount: number }[] };
      const mine = log.exports.filter((e) => e.domain === 'reporting.consolidation');
      expect(mine.map((e) => e.rowCount).sort()).toEqual([1, 2]);
      expect(mine.every((e) => e.userId === OWNER)).toBe(true);
    } finally {
      await close();
    }
  }, 60_000);

  it('a manager of one branch, signed in as themselves, sees and exports only that branch — the server\'s scope', async () => {
    const { page, close } = await signedInAs(MGR1, 'br-1');
    try {
      await page.goto(`${shell.base}/company-report?node=co-1&period=${PERIOD}`, { waitUntil: 'load' });
      await page.locator('.kpi .v[data-measure="grossMinor"]', { hasText: /1,000\.00/ }).waitFor({ timeout: 10_000 });
      await page.locator('#withheld', { hasText: 'Test Branch South (br-2)' }).waitFor({ timeout: 10_000 });
      await page.locator('#withheld', { hasText: 'br-2' }).waitFor({ timeout: 10_000 });
      await page.click('#export');
      await page.locator('#export-status', { hasText: /Exported 1 branch/ }).waitFor({ timeout: 10_000 });
      expect(await page.locator('#preview').textContent()).not.toContain('br-2');
      // Asking for a branch they do not hold is refused by head office, and the page says it cannot show it.
      await page.selectOption('#scope', 'br-2');
      await page.locator('#missing', { hasText: /cannot be reached|nothing on this page is current/i }).waitFor({ timeout: 10_000 });
    } finally {
      await close();
    }
  }, 60_000);
});

/**
 * OB-391 edges, in a real browser, in front of a stand-in head office (no database): what `GET /v1/org/nodes` answers
 * decides the company, the branches and every name; when it refuses or cannot be reached the page says so and shows no
 * figure. The stand-in answers the roll-up with whatever branch the page asked for, so the names on the page can only have
 * come from the organisation read.
 */
describe.skipIf(!HAVE_BROWSER)('OB-391: the company report takes its company and branches from head office', () => {
  let browser: Browser;
  let server: Server;
  let base = '';
  let org: { status: number; body: unknown } | 'drop' = { status: 200, body: {} };
  const asked: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://x');
        if (url.pathname === '/v1/org/nodes') {
          asked.push('org');
          if (org === 'drop') { req.socket.destroy(); return; }
          res.writeHead(org.status, { 'content-type': 'application/json' }).end(JSON.stringify(org.body));
          return;
        }
        if (url.pathname === '/v1/consolidation') {
          asked.push(`consolidation ${url.searchParams.get('node')} ${url.searchParams.get('scope') ?? 'all'}`);
          const node = url.searchParams.get('node');
          const branches = node === 'C-TWO' ? ['B-WEST'] : ['B-NORTH', 'B-SOUTH'];
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
            measures: { grossMinor: 10_000 * branches.length }, freshness: { state: 'fresh' }, missingBranches: [], withheldByScope: [], reconciles: true,
            contributors: branches.map((b) => ({ branchId: b, measures: { grossMinor: 10_000, netMinor: 9_000 }, lastRefreshAt: '2026-10-26T04:00:00.000Z' })),
          }));
          return;
        }
        const file = url.pathname === '/company-report' ? 'company-report.html' : url.pathname.replace(/^\//, '');
        try {
          const buf = await readFile(join(WEB_DIR, file));
          const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
          res.writeHead(200, { 'content-type': `${type}; charset=utf-8` }).end(buf);
        } catch { res.writeHead(404).end(); }
      })();
    });
    await new Promise<void>((r) => { server.listen(0, '127.0.0.1', () => r()); });
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === 'object' && addr !== null ? addr.port : 0}`;
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);
  afterAll(async () => { await browser?.close(); server?.close(); });

  const open = async (): Promise<{ page: Page; close: () => Promise<void> }> => {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    await page.goto(`${base}/company-report`, { waitUntil: 'load' });
    return { page, close: () => context.close() };
  };

  it('two companies: a company choice, each with its own branches by head office\'s names; a nameless node shows its id', async () => {
    org = { status: 200, body: { nodes: [
      { nodeId: 'C-ONE', kind: 'company', name: 'Alpha Test Company', parentId: null, status: 'active' },
      { nodeId: 'C-TWO', kind: 'company', name: 'Beta Test Company', parentId: null, status: 'active' },
      { nodeId: 'B-NORTH', kind: 'branch', name: 'North Test Branch', parentId: 'C-ONE', companyId: 'C-ONE', status: 'active' },
      { nodeId: 'B-SOUTH', kind: 'branch', name: '', parentId: 'C-ONE', companyId: 'C-ONE', status: 'draft' },
      { nodeId: 'B-WEST', kind: 'branch', name: 'West Test Branch', parentId: 'C-TWO', companyId: 'C-TWO', status: 'active' },
      { nodeId: 'B-SHUT', kind: 'branch', name: 'Closed Test Branch', parentId: 'C-ONE', companyId: 'C-ONE', status: 'closed' },
    ] } };
    const { page, close } = await open();
    try {
      await page.locator('#rows tr[data-branch="B-NORTH"]', { hasText: 'North Test Branch (B-NORTH)' }).waitFor({ timeout: 10_000 });
      expect(await page.isVisible('#company-wrap')).toBe(true);
      expect(await page.$$eval('#company option', (o) => o.map((x) => x.textContent))).toEqual(['Alpha Test Company', 'Beta Test Company']);
      expect(await page.$$eval('#scope option', (o) => o.map((x) => x.textContent))).toEqual(['Whole company', 'B-SOUTH — branch only', 'North Test Branch — branch only']);
      expect(await page.textContent('#rows tr[data-branch="B-SOUTH"]')).toContain('B-SOUTH');
      await page.selectOption('#company', 'C-TWO');
      await page.locator('#rows tr[data-branch="B-WEST"]', { hasText: 'West Test Branch (B-WEST)' }).waitFor({ timeout: 10_000 });
      expect(await page.$$eval('#scope option', (o) => o.map((x) => x.textContent))).toEqual(['Whole company', 'West Test Branch — branch only']);
      expect(asked).toEqual(expect.arrayContaining(['org', 'consolidation C-ONE all', 'consolidation C-TWO all']));
      // The page's own words follow the language toggle; head office's names do not change.
      await page.click('#lang');
      await page.locator('#scope option', { hasText: 'West Test Branch — கிளை மட்டும்' }).waitFor({ state: 'attached', timeout: 10_000 });
    } finally { await close(); }
  }, 60_000);

  it('a refused organisation read, an unreachable head office and a head office with no company are each said — no figure shown', async () => {
    for (const [answer, words] of [
      [{ status: 403, body: { error: { code: 'forbidden' } } }, /would not tell this page the company's branches/],
      ['drop', /Head office cannot be reached/],
      [{ status: 200, body: { nodes: [] } }, /no company set up yet/],
    ] as const) {
      org = answer;
      asked.length = 0;
      const { page, close } = await open();
      try {
        await page.locator('#missing', { hasText: words }).waitFor({ timeout: 10_000 });
        expect(await page.locator('.kpi').count()).toBe(0);
        expect(asked.filter((a) => a.startsWith('consolidation'))).toEqual([]);
      } finally { await close(); }
    }
  }, 60_000);
});
