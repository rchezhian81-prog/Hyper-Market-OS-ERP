import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

/**
 * **A business customer reads its own account, in a real browser (M22-FR-04 · API-09 · §35 · P-08 — the E2E matrix).**
 *
 * Every layer of the B2B portal — the tested `createB2BPortalSession`, the served page, the browser read fetches —
 * is unit- and integration-tested. The one thing units cannot prove is that a credit customer, in an ACTUAL
 * browser, opening the portal sees its credit account, its invoices with the overdue one marked, its statement
 * aged into buckets and the documents issued to it; that a login WITHOUT a grant is told so rather than shown a
 * zero; and that the screen never writes a thing. This drives headless Chromium against a stub cloud to prove
 * exactly that end to end:
 *
 *   • a login with every grant → all four feeds read LIVE on load, the account panel shows the figures, the
 *     overdue invoice reads as an error, the statement shows its buckets, the documents list, and across the
 *     whole session NOT ONE write verb leaves the screen;
 *   • a login with `view_invoices` only → the account and the statement answer 403 `no_grant` and the screen
 *     says "your login cannot see …" (never ₹0.00), while invoices and documents still show;
 *   • a login WITHOUT b2b.portal.self → the not-a-business-customer-login state and none of the data.
 *
 * The feeds are read exactly as in production — `GET /v1/b2b-portal/me/{account,invoices,statement,documents}` —
 * over `credentials: 'same-origin'` on the same origin that serves the page, each scoped to the caller's OWN
 * customer ON THE SERVER (the browser has no customer id to send). The B2B portal is CLOUD-served (its own app
 * bundle), so the e2e serves apps/b2b-app/web the same way the cloud web tier would. The browser binary is the
 * environment's pre-installed Chromium; where none is present the suite SKIPS rather than failing.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/b2b-app/web';

interface BrowserGlobals {
  readonly document: {
    querySelectorAll(selector: string): { readonly length: number };
    getElementById(id: string): { readonly hidden: boolean } | null;
  };
}

const ACCOUNT = { customerId: 'c-caterer', hasCreditAccount: true, creditLimitMinor: 5_000_000, currency: 'INR', outstandingMinor: 1_250_000, availableCreditMinor: 3_750_000 };
const INVOICES = {
  customerId: 'c-caterer', count: 2, outstandingMinor: 1_250_000, asAt: '2026-09-29T10:00:00.000Z',
  invoices: [
    { invoiceId: 'inv-7', number: 'INV-0007', issuedOn: '2026-07-31', dueOn: '2026-08-15', grossMinor: 750_000, settledMinor: 0, outstandingMinor: 750_000, disputed: false },
    { invoiceId: 'inv-9', number: 'INV-0009', issuedOn: '2026-09-20', dueOn: '2099-12-31', grossMinor: 500_000, settledMinor: 0, outstandingMinor: 500_000, disputed: false },
  ],
};
const STATEMENT = {
  customerId: 'c-caterer', asAt: '2026-09-29',
  ageing: { customerId: 'c-caterer', asAt: '2026-09-29', totalOutstandingMinor: 1_250_000, overdueMinor: 750_000, disputedMinor: 0, chaseableMinor: 750_000, buckets: { not_due: 500_000, due_0_30: 0, due_31_60: 750_000, due_61_90: 0, due_90_plus: 0 }, items: [], detail: '750000 overdue' },
};
const DOCUMENTS = {
  customerId: 'c-caterer', count: 2, asAt: '2026-09-29T10:00:00.000Z',
  documents: [
    { documentId: 'd-q1', kind: 'quotation', number: 'Q-0001', grossMinor: 300_000, validUntil: '2026-10-15' },
    { documentId: 'd-inv7', kind: 'tax_invoice', number: 'INV-0007', grossMinor: 750_000, derivedFrom: 'd-ch1' },
  ],
};

interface Recorder {
  b2bData: Record<string, unknown>;
  /** The grants the staff binding carries — the server refuses a feed the login has no grant for. */
  grants: readonly string[];
  bound: boolean;
  readonly requests: { method: string; path: string }[];
}

/** Serves the b2b-app page AND answers the four read-only feeds on the SAME origin. A feed the login has no
 *  grant for is 403 `no_grant`; a login bound to no customer is 403 `not_a_b2b_login` — the same re-checks the
 *  real server runs (§35). Any write would be recorded and caught. */
async function startPageAndCloud(rec: Recorder): Promise<{ base: string; stop: () => Promise<void> }> {
  const FEEDS: Record<string, { grant: string; body: unknown }> = {
    '/v1/b2b-portal/me/account': { grant: 'view_statement', body: ACCOUNT },
    '/v1/b2b-portal/me/invoices': { grant: 'view_invoices', body: INVOICES },
    '/v1/b2b-portal/me/statement': { grant: 'view_statement', body: STATEMENT },
    '/v1/b2b-portal/me/documents': { grant: 'view_invoices', body: DOCUMENTS },
  };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      const feed = FEEDS[path];
      if (req.method === 'GET' && feed !== undefined) {
        rec.requests.push({ method: 'GET', path });
        const refuse = (code: string) => { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code, traceId: 't' } })); };
        if (!rec.bound) { refuse('not_a_b2b_login'); return; }
        if (!rec.grants.includes(feed.grant)) { refuse('no_grant'); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(feed.body));
        return;
      }
      if (req.method !== 'GET') rec.requests.push({ method: req.method ?? '?', path }); // any write would be caught here

      const file = path === '/' || path === '/index.html' ? 'index.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.webmanifest') ? 'application/manifest+json' : 'application/octet-stream';
        let body = buf.toString('utf8');
        if (file.endsWith('.html')) {
          const inject = `<script>window.b2bData = ${JSON.stringify(rec.b2bData).replace(/</g, '\\u003c')};</script>`;
          body = body.replace('<!--SCREEN-DATA-->', inject);
        }
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(body);
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
      resolve({ base: `http://127.0.0.1:${port}`, stop: () => new Promise((done) => { server.close(() => { done(); }); }) });
    });
  });
}

const login = (userId: string, permissions: readonly string[]): Record<string, unknown> => ({ userId, permissions });
const ALL_GRANTS = ['view_invoices', 'view_statement'];

describe.skipIf(!HAVE_BROWSER)('a business customer reads its own account end to end in a real browser (M22-FR-04)', () => {
  let browser: Browser;

  beforeAll(async () => {
    // Build the CURRENT b2b-app bundle so the browser runs this branch's code, not a stale artifact.
    execFileSync('node', ['scripts/build-app.mjs', 'b2b-app'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  const open = async (rec: Recorder) => {
    const srv = await startPageAndCloud(rec);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    return { srv, page, teardown: async () => { await context.close(); await srv.stop(); } };
  };

  it('a login with every grant sees its account, its invoices (the overdue one marked), its statement buckets and its documents — and writes nothing', async () => {
    const rec: Recorder = { b2bData: login('u-caterer', ['b2b.portal.self']), grants: ALL_GRANTS, bound: true, requests: [] };
    const { page, teardown } = await open(rec);
    try {
      // The feeds are read LIVE on load, so the rows only appear once those reads resolve.
      await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#invoices li.row').length > 0, undefined, { timeout: 10_000 });
      expect(await page.locator('#invoices li.row').count()).toBe(2);
      expect(await page.locator('#invoices li.row.tone-error').count()).toBe(1); // INV-0007 is overdue
      expect(await page.locator('#invoices li.row.tone-error').first().innerText()).toContain('INV-0007');

      expect(await page.locator('#account').getAttribute('hidden')).toBeNull();
      const accountText = await page.locator('#account').innerText();
      expect(accountText).toContain('₹50,000.00'); // the limit
      expect(accountText).toContain('₹12,500.00'); // what is owed
      expect(accountText).toContain('₹37,500.00'); // available

      expect(await page.locator('#statement').getAttribute('hidden')).toBeNull();
      const statementText = await page.locator('#statement').innerText();
      expect(statementText).toContain('₹7,500.00'); // overdue, in the 31–60 bucket
      expect(statementText).toContain('31–60 days overdue');

      expect(await page.locator('#documents li.row').count()).toBe(2);
      expect(await page.locator('#documents li.row').first().innerText()).toContain('Quotation Q-0001');

      // Every request the portal made was a READ. Not one write verb left the screen.
      expect(rec.requests.length).toBeGreaterThanOrEqual(4);
      expect(rec.requests.every((r) => r.method === 'GET')).toBe(true);
      for (const p of ['/v1/b2b-portal/me/account', '/v1/b2b-portal/me/invoices', '/v1/b2b-portal/me/statement', '/v1/b2b-portal/me/documents']) {
        expect(rec.requests.some((r) => r.path === p), `${p} was not read`).toBe(true);
      }
    } finally {
      await teardown();
    }
  });

  it('a login with view_invoices only is TOLD its login cannot see the account and statement — never shown ₹0.00 — while invoices and documents show', async () => {
    const rec: Recorder = { b2bData: login('u-caterer', ['b2b.portal.self']), grants: ['view_invoices'], bound: true, requests: [] };
    const { page, teardown } = await open(rec);
    try {
      await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#invoices li.row').length > 0, undefined, { timeout: 10_000 });
      await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.getElementById('statement-note')?.hidden === false, undefined, { timeout: 10_000 });
      expect(await page.locator('#account').getAttribute('hidden')).not.toBeNull();
      expect(await page.locator('#statement').getAttribute('hidden')).not.toBeNull();
      expect(await page.locator('#account-note').innerText()).toContain('cannot see the account balance');
      expect(await page.locator('#statement-note').innerText()).toContain('does not mean nothing is owed');
      // The refused feeds are shown as NOTES (a permission answer), not as panels carrying a zero balance.
      expect(await page.locator('#account-note').getAttribute('class')).toContain('note');
      expect(await page.locator('#statement-note').getAttribute('class')).toContain('note');
      expect(await page.locator('#invoices li.row').count()).toBe(2);
      expect(await page.locator('#documents li.row').count()).toBe(2);
      expect(rec.requests.every((r) => r.method === 'GET')).toBe(true);
    } finally {
      await teardown();
    }
  });

  it('a login without b2b.portal.self sees the account refused — no data', async () => {
    const rec: Recorder = { b2bData: login('u-stranger', []), grants: ALL_GRANTS, bound: false, requests: [] };
    const { page, teardown } = await open(rec);
    try {
      await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.getElementById('state')?.hidden === false, undefined, { timeout: 10_000 });
      expect(await page.locator('#state').getAttribute('class')).toContain('tone-error');
      expect(await page.locator('#invoices li.row').count()).toBe(0);
      expect(await page.locator('#documents li.row').count()).toBe(0);
      expect(await page.locator('#account').getAttribute('hidden')).not.toBeNull();
      expect(await page.locator('#statement').getAttribute('hidden')).not.toBeNull();
      expect(rec.requests.every((r) => r.method === 'GET')).toBe(true);
    } finally {
      await teardown();
    }
  });
});
