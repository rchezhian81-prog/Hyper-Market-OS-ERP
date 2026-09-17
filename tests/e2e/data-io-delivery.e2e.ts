import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

/**
 * **The operator exports data and loads a file, in a real browser (M30-FR-01/02/03 · API-03 · §28 — the E2E matrix).**
 *
 * Every layer of the import/export console — the tested engines (validateImport/commitImport, the export engine),
 * the DOM-free session model, the injected ports — is unit- and integration-tested. The one thing units cannot
 * prove is that an operator, in an ACTUAL browser, clicking **Export** and clicking **Load** makes the audited
 * writes reach the cloud under their own session, and that self-approval never leaves the screen. This drives
 * headless Chromium against a stub cloud to prove exactly that, end to end:
 *
 *   • an authorised operator (export.read) → clicking Export on a domain POSTs to /v1/export/:domain under their
 *     own session, the result strip shows, and the recent-exports log RE-READS (a GET, never a client-side push);
 *   • an operator without export.read → the export list is not even rendered (the panel is locked), and NOTHING
 *     is POSTed;
 *   • the import path — pick a template, paste a clean file, **Check** it (POST /v1/import/validate → a preview),
 *     then **Load** it with a SEPARATE approver (POST /v1/import/commit) succeeds; but naming YOURSELF as the
 *     approver is refused on the screen (§28) and NOTHING is POSTed — the uploader may never approve their own.
 *
 * The browser binary is the environment's pre-installed Chromium; where none is present the suite SKIPS rather
 * than failing, exactly like the loss-prevention close-delivery suite it mirrors.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';

interface BrowserGlobals {
  readonly document: {
    querySelectorAll(selector: string): { readonly length: number };
  };
}

/** The store's one shipped import template — the box carries the full column spec (validate/commit take it in the
 *  body), so the screen can resolve a templateId to a whole template with no "list templates" round trip. */
const TEMPLATE = {
  id: 'products-basic', domain: 'products', label: 'Products (SKU, name, price)', financial: false,
  columns: [{ name: 'sku', type: 'text' }, { name: 'name', type: 'text' }, { name: 'price', type: 'money_minor' }],
  keyColumns: ['sku'],
};

/** What GET /v1/export hands over — the exportable domains, with which columns are sensitive (P-04). */
const EXPORT_DOMAINS = [
  { domain: 'products', requires: 'catalogue.pack.read', columns: [{ name: 'sku', type: 'text', sensitive: false }, { name: 'cost', type: 'money_minor', sensitive: true }] },
  { domain: 'suppliers', requires: 'supplier.read', columns: [{ name: 'code', type: 'text', sensitive: false }] },
];

/** The preview a clean 2-row file gets back from POST /v1/import/validate — the shape validateImport returns. */
const CLEAN_PREVIEW = {
  totalRows: 2, validCount: 2, errorRowCount: 0, errors: [] as unknown[],
  duplicatesForReview: [] as unknown[], commitReady: true,
};

interface ExportRow { userId: string; domain: string; at: string; rowCount: number; redactedColumns: readonly string[]; }
interface Recorder {
  data: Record<string, unknown>;
  exports: ExportRow[];
  readonly requests: { method: string; path: string; body: unknown }[];
}

/** A server that BOTH serves the shell (GET, operator context injected) AND answers the five routes the console
 *  touches — the export catalogue + log GETs, the export POST (domain in the URL), and the validate + commit
 *  POSTs — on the SAME origin, so `credentials: 'same-origin'` and a relative `/v1/...` reach it exactly as in
 *  production. The commit route enforces §28 server-side too (self-approval → 403), mirroring the real engine. */
async function startShellAndCloud(rec: Recorder): Promise<{ base: string; stop: () => Promise<void> }> {
  const readBody = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    return raw === '' ? undefined : JSON.parse(raw);
  };
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');

      if (req.method === 'POST' && path.startsWith('/v1/export/')) {
        const domain = decodeURIComponent(path.slice('/v1/export/'.length));
        rec.requests.push({ method: 'POST', path, body: await readBody(req) });
        // An export happened: the log grows (newest first) — the screen re-READS it, never pushes to it.
        rec.exports.unshift({ userId: 'u-op', domain, at: '2026-09-17T10:00:00.000Z', rowCount: 42, redactedColumns: ['cost'] });
        json(res, 200, { ok: true, domain, rowCount: 42 });
        return;
      }
      if (req.method === 'GET' && path === '/v1/export') {
        rec.requests.push({ method: 'GET', path, body: undefined });
        json(res, 200, { domains: EXPORT_DOMAINS });
        return;
      }
      if (req.method === 'GET' && path === '/v1/exports') {
        rec.requests.push({ method: 'GET', path, body: undefined });
        json(res, 200, { exports: rec.exports });
        return;
      }
      if (req.method === 'POST' && path === '/v1/import/validate') {
        rec.requests.push({ method: 'POST', path, body: await readBody(req) });
        json(res, 200, { preview: CLEAN_PREVIEW });
        return;
      }
      if (req.method === 'POST' && path === '/v1/import/commit') {
        const body = await readBody(req) as { approval?: { decidedBy?: string }; uploadedBy?: string } | undefined;
        rec.requests.push({ method: 'POST', path, body });
        // §28 on the server too: the uploader may never approve their own load.
        if (body?.approval?.decidedBy !== undefined && body.approval.decidedBy === body.uploadedBy) {
          json(res, 403, { error: { code: 'self_approved' } });
          return;
        }
        json(res, 200, { ok: true, jobId: (body as { jobId?: string } | undefined)?.jobId });
        return;
      }

      const file = path === '/' || path === '/data-io' ? 'data-io.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
        let out = buf.toString('utf8');
        if (file.endsWith('.html')) {
          const inject = `<script>window.dataIoData = ${JSON.stringify(rec.data).replace(/</g, '\\u003c')};</script>`;
          out = out.replace('<!--SCREEN-DATA-->', inject);
        }
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(out);
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

const operator = (permissions: readonly string[]): Record<string, unknown> => ({
  userId: 'u-op', permissions, importTemplates: [TEMPLATE],
});

const CLEAN_FILE = 'sku,name,price\nRICE5,Rice 5kg,45000\nDAL1,Dal 1kg,12000';

describe.skipIf(!HAVE_BROWSER)('the operator exports data and loads a file, end to end in a real browser (M30)', () => {
  let browser: Browser;

  beforeAll(async () => {
    // Build the CURRENT web-erp bundle so the browser runs this branch's code, not a stale artifact.
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  const openScreen = async (rec: Recorder) => {
    const srv = await startShellAndCloud(rec);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    return { srv, context, page, teardown: async () => { await context.close(); await srv.stop(); } };
  };

  it('an authorised operator: clicking Export POSTs it under their session, and the recent log re-reads', async () => {
    const rec: Recorder = { data: operator(['export.read']), exports: [], requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      // The catalogue is read LIVE on load (GET /v1/export), so the domains only appear after the read resolves.
      await page.waitForFunction(
        () => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#export-domains .row').length > 0,
        undefined, { timeout: 10_000 },
      );
      expect(await page.locator('#export-domains .row').count()).toBe(2);
      // The log starts empty — one placeholder row, no real export yet.
      expect(rec.requests.filter((r) => r.method === 'POST').length).toBe(0);

      await page.click('.export-btn[data-domain="products"]');

      // The export reached the cloud under the operator's own session, at the domain URL.
      await page.waitForFunction(
        () => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#recent-exports .row strong').length > 0,
        undefined, { timeout: 10_000 },
      );
      const post = rec.requests.find((r) => r.method === 'POST' && r.path === '/v1/export/products');
      expect(post, 'the export was not POSTed to the domain URL').toBeDefined();

      // The log RE-READ (a GET after the export), not a client-side shuffle — the new row shows the domain.
      expect(rec.requests.filter((r) => r.method === 'GET' && r.path === '/v1/exports').length).toBeGreaterThanOrEqual(2);
      expect(await page.locator('#recent-exports').textContent()).toContain('products');
      expect(await page.locator('#export-result').getAttribute('hidden')).toBeNull();
    } finally {
      await teardown();
    }
  });

  it('an operator without export.read sends NOTHING — the export list is not rendered, the panel is locked', async () => {
    const rec: Recorder = { data: operator([]), exports: [], requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      await page.waitForSelector('#export-locked:not([hidden])', { timeout: 10_000 });
      expect(await page.locator('#export-domains').getAttribute('hidden')).not.toBeNull(); // list hidden
      expect(await page.locator('.export-btn').count()).toBe(0); // no export button exists to click
      expect(rec.requests.some((r) => r.method === 'POST'), 'a locked operator must POST nothing').toBe(false);
    } finally {
      await teardown();
    }
  });

  it('the import path: Check previews the file, then Load with a SEPARATE approver commits it', async () => {
    const rec: Recorder = { data: operator(['purchase.import.read', 'purchase.import.record']), exports: [], requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      await page.waitForSelector('#import-form:not([hidden])', { timeout: 10_000 });

      await page.selectOption('#import-template', 'products-basic');
      await page.fill('#import-file', CLEAN_FILE);
      await page.click('#validate');

      // Check → a preview, from POST /v1/import/validate (a read; writes nothing).
      await page.waitForSelector('#preview:not([hidden])', { timeout: 10_000 });
      expect(await page.locator('#preview').getAttribute('class')).toContain('ready');
      const validate = rec.requests.find((r) => r.method === 'POST' && r.path === '/v1/import/validate');
      expect(validate, 'Check did not POST to /v1/import/validate').toBeDefined();
      expect((validate!.body as { template?: { id?: string } }).template?.id).toBe('products-basic');
      expect(rec.requests.some((r) => r.path === '/v1/import/commit')).toBe(false); // nothing committed yet

      // Load with a SEPARATE approver (§28: not the uploader u-op).
      await page.fill('#import-job', 'sept-price-refresh');
      await page.fill('#import-approver', 'u-owner');
      await page.click('#commit');

      await page.waitForSelector('#commit-result:not([hidden])', { timeout: 10_000 });
      const commit = rec.requests.find((r) => r.method === 'POST' && r.path === '/v1/import/commit');
      expect(commit, 'Load did not POST to /v1/import/commit').toBeDefined();
      const body = commit!.body as { jobId?: string; approval?: { decidedBy?: string; status?: string }; uploadedBy?: string };
      expect(body.jobId).toBe('sept-price-refresh');
      expect(body.approval?.decidedBy).toBe('u-owner');
      expect(body.approval?.status).toBe('approved');
      expect(body.uploadedBy).toBe('u-op'); // the uploader is the caller's OWN session, never the named approver
      expect(await page.locator('#commit-result').getAttribute('class')).toContain('tone-ok');
    } finally {
      await teardown();
    }
  });

  it('naming YOURSELF as the approver is refused on the screen — nothing is POSTed to commit (§28)', async () => {
    const rec: Recorder = { data: operator(['purchase.import.read', 'purchase.import.record']), exports: [], requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      await page.waitForSelector('#import-form:not([hidden])', { timeout: 10_000 });

      await page.selectOption('#import-template', 'products-basic');
      await page.fill('#import-file', CLEAN_FILE);
      await page.fill('#import-job', 'sept-price-refresh');
      await page.fill('#import-approver', 'u-op'); // the uploader naming themselves — a self-approval
      await page.click('#commit');

      // The screen refuses it BEFORE any POST — the commit never leaves the browser.
      await page.waitForSelector('#commit-result:not([hidden])', { timeout: 10_000 });
      expect(await page.locator('#commit-result').getAttribute('class')).toContain('tone-error');
      expect(rec.requests.some((r) => r.path === '/v1/import/commit'), 'a self-approval must not be POSTed').toBe(false);
    } finally {
      await teardown();
    }
  });
});
