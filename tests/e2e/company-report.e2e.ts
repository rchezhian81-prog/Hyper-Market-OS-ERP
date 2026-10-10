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
 *   • a manager of ONE branch, signed in as themselves, sees only that branch — the server's scope, not the page's.
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
      await page.goto(`${shell.base}/company-report?node=co-1&period=${PERIOD}`, { waitUntil: 'load' });

      await page.locator('.kpi .v[data-measure="grossMinor"]', { hasText: /3,500\.00/ }).waitFor({ timeout: 10_000 });
      await page.locator('#freshness.stale').waitFor({ timeout: 10_000 });
      await page.locator('#missing', { hasText: 'br-3' }).waitFor({ timeout: 10_000 });
      await page.locator('#reconcile', { hasText: /does NOT reconcile/i }).waitFor({ timeout: 10_000 });

      await page.locator('#rows tr:nth-child(2)').waitFor({ timeout: 10_000 });
      const branchRows = page.locator('#rows tr');
      expect(await branchRows.count()).toBe(2);
      expect(await branchRows.first().getAttribute('data-branch')).toBe('br-2');

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
