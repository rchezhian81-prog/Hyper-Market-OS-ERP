import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

/**
 * **The manager signs off a checklist, in a real browser (M25-FR-02 · API-11 · §28 — the E2E matrix).**
 *
 * Every layer of the checklist desk — the tested `assessChecklist` fold, the session model, the submit port — is
 * unit- and integration-tested. The one thing units cannot prove is that a manager, in an ACTUAL browser,
 * ticking the outstanding blocking item and clicking **"Sign and submit"** makes their decision reach the cloud
 * under their own session, and that the checklist then re-reads as done. This drives headless Chromium against a
 * stub cloud to prove exactly that end to end:
 *
 *   • an authorised manager (workforce.checklist.read + workforce.roster.manage) → ticks the blocking item and
 *     signs; the POST carries {kind, items[safe done], signedBy} to /v1/hr/workforce/checklists/:checklistId
 *     under their own session, and on the worklist RE-READ the now-signed, unblocked checklist reads complete
 *     (its sign button drops off — a server re-derive, never a client-side move);
 *   • a read-only user (workforce.checklist.read only) → sees the checklist rows but NO sign button, and NOTHING
 *     is sent (P-04 least privilege: the server re-checks too, but the screen never even offers it).
 *
 * The browser binary is the environment's pre-installed Chromium; where none is present the suite SKIPS rather
 * than failing, exactly like the rostering delivery suite it mirrors.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';

interface BrowserGlobals {
  readonly document: {
    querySelectorAll(selector: string): { readonly length: number };
  };
}

/** The stored closing checklist the read route hands back: one BLOCKING item still outstanding (the safe) and
 *  one already done (the lights), nobody signed — so it assesses `blocked_item` until a manager ticks the safe
 *  and signs. */
const CHECKLIST_ID = 'C-close';
const BLOCKED = {
  checklistId: CHECKLIST_ID, kind: 'closing', signedBy: null, forDate: '2026-09-27',
  items: [
    { itemId: 'safe', description: 'lock the safe', done: false, blocking: true },
    { itemId: 'lights', description: 'switch off the lights', done: true, blocking: false },
  ],
};
/** After the sign: the same checklist, all items done and signed — so the re-read assesses `complete`. */
const SIGNED = {
  checklistId: CHECKLIST_ID, kind: 'closing', signedBy: 'u-manager', forDate: '2026-09-27',
  items: [
    { itemId: 'safe', description: 'lock the safe', done: true, blocking: true },
    { itemId: 'lights', description: 'switch off the lights', done: true, blocking: false },
  ],
};

interface Recorder {
  checklistData: Record<string, unknown>;
  submitStatus: number;
  signed: boolean;
  readonly requests: { method: string; path: string; body: unknown }[];
}

/** A server that BOTH serves the shell (GET, manager context injected) AND answers the two routes the desk
 *  touches — the sign-off POST (checklistId in the URL) and the checklist worklist GET — on the SAME origin, so
 *  `credentials: 'same-origin'` and a relative `/v1/...` reach it exactly as in production. Once signed, the GET
 *  returns the signed+complete checklist, so a signed checklist re-reads as done (a server re-derive). */
async function startShellAndCloud(rec: Recorder): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      if (req.method === 'POST' && path.startsWith('/v1/hr/workforce/checklists/')) {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8');
        rec.requests.push({ method: 'POST', path, body: raw === '' ? undefined : JSON.parse(raw) });
        if (rec.submitStatus >= 200 && rec.submitStatus < 300) rec.signed = true;
        res.writeHead(rec.submitStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ checklist: SIGNED }));
        return;
      }
      if (req.method === 'GET' && path === '/v1/hr/workforce/checklists') {
        rec.requests.push({ method: 'GET', path, body: undefined });
        const checklists = [rec.signed ? SIGNED : BLOCKED];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ checklists, count: 1, blocked: rec.signed ? 0 : 1 }));
        return;
      }
      const file = path === '/' || path === '/checklist' ? 'checklist.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
        let body = buf.toString('utf8');
        if (file.endsWith('.html')) {
          const inject = `<script>window.checklistData = ${JSON.stringify(rec.checklistData).replace(/</g, '\\u003c')};</script>`;
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

const manager = (userId: string, permissions: readonly string[]): Record<string, unknown> => ({
  userId, permissions,
});

describe.skipIf(!HAVE_BROWSER)('the manager signs off a checklist, end to end in a real browser (M25-FR-02)', () => {
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
    // The worklist is read live on load (a GET), so the checklist only appears once the read resolves.
    await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rows .row').length > 0, undefined, { timeout: 10_000 });
    return { srv, context, page, teardown: async () => { await context.close(); await srv.stop(); } };
  };

  it('an authorised manager: ticking the blocking item and clicking sign POSTs it, and the checklist re-reads done', async () => {
    const rec: Recorder = { checklistData: manager('u-manager', ['workforce.checklist.read', 'workforce.roster.manage']), submitStatus: 200, signed: false, requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      expect(await page.locator('#rows .row').count()).toBe(1);
      // The sign button is offered (the manager holds workforce.roster.manage) and the checklist is not yet done.
      expect(await page.locator('#rows .row button.sign').count()).toBe(1);

      // Tick the outstanding blocking item, then sign.
      await page.check('#rows .row input[data-item-id="safe"]');
      await page.click('#rows .row button.sign');

      // The sign button drops off because the worklist was re-READ and the checklist now assesses complete.
      await page.waitForFunction(
        () => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rows .row button.sign').length === 0,
        undefined, { timeout: 10_000 },
      );
      const post = rec.requests.find((r) => r.method === 'POST' && r.path === `/v1/hr/workforce/checklists/${CHECKLIST_ID}`);
      expect(post, 'the sign-off was not POSTed to the checklist URL').toBeDefined();
      const body = post!.body as { signedBy?: string; kind?: string; items?: { itemId: string; done: boolean }[] };
      expect(body.signedBy).toBe('u-manager');
      expect(body.kind).toBe('closing');
      expect(body.items?.find((i) => i.itemId === 'safe')?.done).toBe(true);

      // The worklist read runs at least twice: once on load, once after the sign to re-derive.
      expect(rec.requests.filter((r) => r.method === 'GET' && r.path === '/v1/hr/workforce/checklists').length).toBeGreaterThanOrEqual(2);
      expect(await page.locator('#result').getAttribute('hidden')).toBeNull();
    } finally {
      await teardown();
    }
  });

  it('a read-only user sends NOTHING — no sign button is rendered', async () => {
    const rec: Recorder = { checklistData: manager('u-readonly', ['workforce.checklist.read']), submitStatus: 200, signed: false, requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      expect(await page.locator('#rows .row').count()).toBe(1); // they can see the checklist
      expect(await page.locator('#rows .row button.sign').count()).toBe(0); // but no sign button
      expect(rec.requests.some((r) => r.method === 'POST')).toBe(false);
    } finally {
      await teardown();
    }
  });
});
