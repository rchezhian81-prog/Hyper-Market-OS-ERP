import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

/**
 * **A receipt template is drafted, approved by a SECOND person and published, in a real browser (M01-FR-02 · API-01 · §28 — the E2E matrix).**
 *
 * Every layer — the tested @sre/org template engine, the routes, the session model, the act port — is unit- and
 * integration-tested. The one thing units cannot prove is that a setup person, in an actual browser, typing the
 * store's header and clicking **"Save as a draft"** makes the draft reach the cloud under their own session; that
 * the SAME person is then offered no approve (and told why); that a second person approving and publishing makes
 * the version in force appear because the kind was re-read. This drives headless Chromium against a stub cloud
 * to prove exactly that end to end:
 *
 *   • the owner (setup.read + setup.write) → the receipt kind reads as "nothing in force"; the draft POSTs to
 *     /v1/org/document-templates/receipt/versions under their own session with an idempotency key; the kind is
 *     re-read (a GET) and v1 appears as a draft; no approve button for its maker, the §28 sentence instead;
 *   • a platform admin → approve is offered on the owner's draft; the click POSTs approve, then publish is offered
 *     and POSTs publish; the register re-reads as "v1 in force";
 *   • a store manager (setup.read only) → no draft form, no buttons, NOTHING is sent;
 *   • the owner types a malformed GSTIN → refused on the page before any POST, the GSTIN named.
 *
 * The browser binary is the environment's pre-installed Chromium; where none is present the suite SKIPS rather
 * than failing, exactly like the day-book delivery suite it mirrors.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';

interface BrowserGlobals {
  readonly document: {
    querySelectorAll(selector: string): { readonly length: number };
    getElementById(id: string): { readonly hidden: boolean; readonly textContent: string | null } | null;
  };
}

interface Version { kind: string; version: number; state: string; content: unknown; note?: string; authoredBy: string; authoredAt: string; approvedBy?: string; publishedBy?: string; supersededBy?: number }
interface Recorder {
  screenData: Record<string, unknown>;
  /** Who the cloud records as acting — the stub's stand-in for the session cookie. */
  actor: string;
  versions: Version[];
  readonly requests: { method: string; path: string; headers: Record<string, string | string[] | undefined>; body: unknown }[];
}

const KINDS = ['receipt', 'invoice', 'purchase_order', 'grn', 'statement'];
const readBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? undefined : JSON.parse(text) as unknown;
};

/** A server that BOTH serves the shell (GET, the person's context injected) AND answers the routes the screen
 *  touches — the register and kind GETs, the draft / approve / publish POSTs — on the SAME origin, so
 *  `credentials: 'same-origin'` and a relative `/v1/...` reach it exactly as in production. */
async function startShellAndCloud(rec: Recorder): Promise<{ base: string; stop: () => Promise<void> }> {
  const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const current = (kind: string) => rec.versions.filter((v) => v.kind === kind && v.state === 'published').sort((a, b) => b.version - a.version)[0] ?? null;
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      const body = await readBody(req);
      if (path.startsWith('/v1/')) rec.requests.push({ method: req.method ?? 'GET', path, headers: req.headers, body });

      if (req.method === 'GET' && path === '/v1/org/document-templates') {
        return json(res, 200, { kinds: KINDS.map((kind) => ({ kind, current: current(kind), versions: rec.versions.filter((v) => v.kind === kind).length })), asAt: '2026-09-29T09:00:00.000Z' });
      }
      const kindRead = /^\/v1\/org\/document-templates\/([a-z_]+)$/.exec(path);
      if (req.method === 'GET' && kindRead !== null) {
        return json(res, 200, { kind: kindRead[1], current: current(kindRead[1]!), versions: rec.versions.filter((v) => v.kind === kindRead[1]), asAt: '2026-09-29T09:00:00.000Z' });
      }
      const draft = /^\/v1\/org\/document-templates\/([a-z_]+)\/versions$/.exec(path);
      if (req.method === 'POST' && draft !== null) {
        const b = body as { content: unknown; note?: string };
        const version: Version = { kind: draft[1]!, version: rec.versions.filter((v) => v.kind === draft[1]).length + 1, state: 'draft', content: b.content, ...(b.note === undefined ? {} : { note: b.note }), authoredBy: rec.actor, authoredAt: '2026-09-29T09:01:00.000Z' };
        rec.versions.push(version);
        return json(res, 201, version);
      }
      const act = /^\/v1\/org\/document-templates\/([a-z_]+)\/versions\/(\d+)\/(approve|publish)$/.exec(path);
      if (req.method === 'POST' && act !== null) {
        const v = rec.versions.find((x) => x.kind === act[1] && x.version === Number(act[2]));
        if (v === undefined) return json(res, 404, { error: { code: 'not_found' } });
        if (act[3] === 'approve') {
          if (v.authoredBy === rec.actor) return json(res, 403, { error: { code: 'maker_cannot_approve', whatHappened: 'the maker cannot approve', wasItSaved: 'not_saved', nextSafeAction: 'ask a second person' } });
          if (v.state !== 'draft') return json(res, 409, { error: { code: 'not_a_draft' } });
          Object.assign(v, { state: 'approved', approvedBy: rec.actor });
          return json(res, 200, v);
        }
        if (v.state !== 'approved') return json(res, 409, { error: { code: 'not_approved' } });
        const previous = current(v.kind);
        if (previous !== null) Object.assign(previous, { state: 'superseded', supersededBy: v.version });
        Object.assign(v, { state: 'published', publishedBy: rec.actor });
        return json(res, 200, { ...v, ...(previous === null ? {} : { supersededVersion: previous.version }) });
      }

      const file = path === '/' || path === '/document-templates' ? 'document-templates.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        let text = buf.toString('utf8');
        if (file.endsWith('.html')) {
          const inject = `<script>window.documentTemplatesData = ${JSON.stringify(rec.screenData).replace(/</g, '\\u003c')};</script>`;
          text = text.replace('<!--SCREEN-DATA-->', inject);
        }
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
      resolve({ base: `http://127.0.0.1:${port}`, stop: () => new Promise((done) => { server.close(() => { done(); }); server.closeAllConnections(); }) });
    });
  });
}

const user = (userId: string, permissions: readonly string[]): Record<string, unknown> => ({ userId, tenantId: 't1', permissions });
const OWNER_DRAFT: Version = { kind: 'receipt', version: 1, state: 'draft', content: { header: ['SRE Hyper Market', 'GSTIN: 33ABCDE1234F1Z5'], footer: ['Thank you'], language: 'en_ta', paperFormat: 'thermal-80' }, note: 'first bill layout', authoredBy: 'u-owner', authoredAt: '2026-09-29T08:00:00.000Z' };

describe.skipIf(!HAVE_BROWSER)('a receipt template is drafted, approved by a second person and published, end to end in a real browser (M01-FR-02)', () => {
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
    // The register is read on load; the receipt kind is the default choice and its versions are read too.
    await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#kinds li.row').length === 5, undefined, { timeout: 10_000 });
    await page.waitForFunction(() => {
      const d = (globalThis as unknown as BrowserGlobals).document;
      return d.getElementById('no-versions')?.hidden === false || d.querySelectorAll('#versions li.row').length > 0;
    }, undefined, { timeout: 10_000 });
    return { srv, context, page, teardown: async () => { await context.close(); await srv.stop(); } };
  };

  it('the owner drafts v1: it POSTs under their own session with an idempotency key, the kind is re-read, and the maker is offered NO approve — told why (§28)', async () => {
    const rec: Recorder = { screenData: user('u-owner', ['platform.setup.read', 'platform.setup.write']), actor: 'u-owner', versions: [], requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      expect(await page.locator('#kinds li.row').first().getAttribute('class')).toContain('tone-degraded'); // nothing in force → a warning
      expect(await page.locator('#kinds li.row').first().innerText()).toContain('defaults');
      expect(await page.locator('#draft-form').getAttribute('hidden')).toBeNull(); // the form is offered to a writer

      await page.fill('#header', 'SRE Hyper Market\n12 Bazaar Street, Tirunelveli 627001\nGSTIN: 33ABCDE1234F1Z5');
      await page.fill('#footer', 'Thank you — please visit again');
      await page.selectOption('#language', 'en_ta');
      await page.selectOption('#paper', 'thermal-80');
      await page.fill('#note', 'first bill layout');
      await page.click('#draft');

      await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#versions li.row').length === 1, undefined, { timeout: 10_000 });
      const post = rec.requests.find((r) => r.method === 'POST');
      expect(post?.path).toBe('/v1/org/document-templates/receipt/versions');
      expect(typeof post?.headers['idempotency-key']).toBe('string');
      expect(post?.body).toEqual({ content: { header: ['SRE Hyper Market', '12 Bazaar Street, Tirunelveli 627001', 'GSTIN: 33ABCDE1234F1Z5'], footer: ['Thank you — please visit again'], language: 'en_ta', paperFormat: 'thermal-80' }, note: 'first bill layout' });
      // The version shown came from the re-READ of the kind, not from the POST reply.
      expect(rec.requests.filter((r) => r.method === 'GET' && r.path === '/v1/org/document-templates/receipt').length).toBeGreaterThanOrEqual(2);
      expect(await page.locator('#result').getAttribute('class')).toContain('tone-ok');
      expect(await page.locator('#result').innerText()).toContain('version 1');
      const row = page.locator('#versions li.row').first();
      expect(await row.innerText()).toContain('v1');
      expect(await row.innerText()).toContain('waiting for a second person');
      expect(await row.locator('button[data-act="approve"]').count()).toBe(0); // the maker cannot approve
      expect(await row.innerText()).toContain('different person must approve');
      expect(rec.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    } finally {
      await teardown();
    }
  });

  it('a platform admin approves the owner\'s draft and publishes it: two POSTs in their own name; the register re-reads as v1 in force', async () => {
    const rec: Recorder = { screenData: user('u-padmin', ['platform.setup.read', 'platform.setup.write']), actor: 'u-padmin', versions: [{ ...OWNER_DRAFT }], requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      const row = page.locator('#versions li.row').first();
      expect(await row.locator('button[data-act="approve"]').count()).toBe(1); // a SECOND person is offered approve
      expect(await row.locator('button[data-act="publish"]').count()).toBe(0);
      await row.locator('button[data-act="approve"]').click();
      await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#versions button[data-act="publish"]').length === 1, undefined, { timeout: 10_000 });
      expect(rec.requests.filter((r) => r.method === 'POST').map((r) => r.path)).toEqual(['/v1/org/document-templates/receipt/versions/1/approve']);
      expect(await page.locator('#versions li.row').first().getAttribute('class')).toContain('tone-degraded'); // approved — an act pending

      await page.locator('#versions button[data-act="publish"]').click();
      await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#versions li.row.tone-ok').length === 1, undefined, { timeout: 10_000 });
      expect(rec.requests.filter((r) => r.method === 'POST').map((r) => r.path)).toEqual([
        '/v1/org/document-templates/receipt/versions/1/approve',
        '/v1/org/document-templates/receipt/versions/1/publish',
      ]);
      expect(await page.locator('#versions li.row').first().innerText()).toContain('In force');
      expect(await page.locator('#kinds li.row').first().getAttribute('class')).toContain('tone-ok');
      expect(await page.locator('#kinds li.row').first().innerText()).toContain('v1 in force');
      expect(await page.locator('#result').innerText()).toContain('Published version 1');
    } finally {
      await teardown();
    }
  });

  it('a store manager with read only sends NOTHING — no draft form, no act buttons', async () => {
    const rec: Recorder = { screenData: user('u-mgr', ['platform.setup.read']), actor: 'u-mgr', versions: [{ ...OWNER_DRAFT }], requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      expect(await page.locator('#draft-form').getAttribute('hidden')).not.toBeNull();
      expect(await page.locator('#versions button[data-act]').count()).toBe(0);
      expect(rec.requests.some((r) => r.method === 'POST')).toBe(false);
      expect(rec.requests.every((r) => r.method === 'GET')).toBe(true);
    } finally {
      await teardown();
    }
  });

  it('a malformed GSTIN is refused on the page before any POST — the GSTIN named, nothing sent', async () => {
    const rec: Recorder = { screenData: user('u-owner', ['platform.setup.read', 'platform.setup.write']), actor: 'u-owner', versions: [], requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      await page.fill('#header', 'SRE Hyper Market\nGSTIN: 33ABC');
      await page.fill('#footer', 'Thank you');
      await page.click('#draft');
      await page.waitForSelector('#result:not([hidden])', { timeout: 10_000 });
      expect(await page.locator('#result').getAttribute('class')).toContain('tone-error');
      expect(await page.locator('#result').innerText()).toContain('GSTIN');
      expect(rec.requests.some((r) => r.method === 'POST')).toBe(false);
      expect(await page.locator('#versions li.row').count()).toBe(0);
    } finally {
      await teardown();
    }
  });
});
