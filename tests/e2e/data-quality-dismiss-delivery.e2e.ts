import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

/**
 * **The steward sets a finding aside, in a real browser (A08 · API-13 — the E2E matrix).**
 *
 * Every layer of the Data Quality inbox — the tested worklist engine, the session model, the dismiss port — is
 * unit- and integration-tested. The one thing units cannot prove is that a person pressing **"Not a problem"**
 * in an actual browser makes their decision reach the cloud, under their own session, and that the row then
 * moves. This drives headless Chromium against a stub cloud to prove exactly that end to end:
 *
 *   • an authorised steward → typing a reason and clicking dismiss POSTs {findingId, reason} to
 *     /v1/ai/data-quality/dismissals under the steward's own session, the result strip shows, and the row
 *     moves from "to look at" to "set aside" once the worklist is re-read (a read, never a client-side move);
 *   • a steward with only READ access → the dismiss control is not even rendered, and NOTHING is sent (the
 *     client cannot dismiss under a grant it does not hold — the server would refuse it anyway, but it never
 *     even asks);
 *   • an empty reason → refused client-side, nothing sent (a set-aside with no reason is not a record).
 *
 * The browser binary is the environment's pre-installed Chromium; where none is present the suite SKIPS rather
 * than failing, exactly like the offline-open and publish-delivery suites.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';

/** The slice of the browser's globals these callbacks touch, cast structurally inside each page.evaluate so this
 *  file needs no DOM lib. The cast is erased at compile time; the browser receives plain globalThis. */
interface BrowserGlobals {
  readonly document: {
    querySelectorAll(selector: string): { readonly length: number };
    querySelector(selector: string): { readonly value?: string } | null;
  };
}

/** One open suspicious-mapping finding — the steward's to judge. Mapping keeps the injected worklist minimal
 *  (no product-master evidence shape); the dismiss path is identical whatever the finding's source. */
const OPEN_ENTRY = {
  source: 'mapping' as const, status: 'open' as const,
  finding: {
    findingId: 'f-hsn',
    headline: 'Imports from "acme-foods" keep failing on the "hsn" column',
    detail: 'We do not recognise this supplier’s "hsn" codes — agree a code list with them.',
    sourceId: 'acme-foods', column: 'hsn',
  },
};
const DISMISSED_ENTRY = {
  ...OPEN_ENTRY, status: 'dismissed' as const,
  dismissal: { by: 'u-steward', at: '2026-09-14T09:00:00.000Z', reason: 'agreed a code list' },
};
const OPEN_WORKLIST = { agentActive: true, open: [OPEN_ENTRY], dismissed: [] };
const DISMISSED_WORKLIST = { agentActive: true, open: [], dismissed: [DISMISSED_ENTRY] };

/** What the ERP injects about the signed-in steward, mutated per scenario. */
interface Recorder {
  inboxData: Record<string, unknown>;
  dismissStatus: number;
  /** Flips true after a recorded dismiss, so the worklist GET then returns the moved row (a server re-derive). */
  dismissed: boolean;
  readonly requests: { method: string; path: string; body: unknown }[];
}

/** A server that BOTH serves the shell (GET, steward context injected) AND answers the two routes the inbox
 *  touches — the dismiss POST and the worklist GET — on the SAME origin, so `credentials: 'same-origin'` and a
 *  relative `/v1/...` reach it exactly as in production. */
async function startShellAndCloud(rec: Recorder): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      if (req.method === 'POST' && path === '/v1/ai/data-quality/dismissals') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8');
        rec.requests.push({ method: 'POST', path, body: raw === '' ? undefined : JSON.parse(raw) });
        if (rec.dismissStatus >= 200 && rec.dismissStatus < 300) rec.dismissed = true;
        res.writeHead(rec.dismissStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: rec.dismissStatus < 400 }));
        return;
      }
      if (req.method === 'GET' && path === '/v1/ai/data-quality/worklist') {
        rec.requests.push({ method: 'GET', path, body: undefined });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(rec.dismissed ? DISMISSED_WORKLIST : OPEN_WORKLIST));
        return;
      }
      const file = path === '/' || path === '/data-quality' ? 'data-quality.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
        let body = buf.toString('utf8');
        if (file.endsWith('.html')) {
          const inject = `<script>window.dataQualityInboxData = ${JSON.stringify(rec.inboxData).replace(/</g, '\\u003c')};</script>`;
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

const steward = (permissions: readonly string[]): Record<string, unknown> => ({
  userId: 'u-steward', tenantId: 't1', permissions, worklist: OPEN_WORKLIST,
});

describe.skipIf(!HAVE_BROWSER)('the steward dismisses a finding, end to end in a real browser (A08)', () => {
  let browser: Browser;

  beforeAll(async () => {
    // Build the CURRENT web-erp bundle so the browser runs this branch's code, not a stale artifact.
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  /** Open the inbox with the given steward context and wait for the rows to render. */
  const openScreen = async (rec: Recorder) => {
    const srv = await startShellAndCloud(rec);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('.status').length > 0, undefined, { timeout: 10_000 });
    return { srv, context, page, teardown: async () => { await context.close(); await srv.stop(); } };
  };

  it('an authorised steward: typing a reason and clicking dismiss POSTs the decision, and the row moves to "set aside"', async () => {
    const rec: Recorder = { inboxData: steward(['ai.proposal.read', 'ai.suggestion.dismiss']), dismissStatus: 200, dismissed: false, requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      // The open finding shows the steward's reason box + "Not a problem" button.
      expect(await page.locator('#rows .row').count()).toBe(1);
      expect(await page.locator('#rows .act.dismiss').count()).toBe(1);

      await page.fill('#rows .reason', 'agreed a code list');
      await page.click('#rows .act.dismiss');

      // The decision reached the cloud under the steward's own session, with the finding id and the reason.
      await page.waitForFunction(
        () => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#dismissed-rows .row').length > 0,
        undefined, { timeout: 10_000 },
      );
      const post = rec.requests.find((r) => r.method === 'POST' && r.path === '/v1/ai/data-quality/dismissals');
      expect(post, 'the dismiss decision was not POSTed').toBeDefined();
      expect((post!.body as { findingId?: string }).findingId).toBe('f-hsn');
      expect((post!.body as { reason?: string }).reason).toBe('agreed a code list');

      // The row MOVED because the worklist was re-read (server re-derive), not shuffled client-side.
      expect(rec.requests.filter((r) => r.method === 'GET' && r.path === '/v1/ai/data-quality/worklist').length).toBeGreaterThanOrEqual(1);
      expect(await page.locator('#rows .row').count()).toBe(0);
      expect(await page.locator('#dismissed-rows .row').count()).toBe(1);
      expect(await page.locator('#result').getAttribute('hidden')).toBeNull(); // the result strip is showing
    } finally {
      await teardown();
    }
  });

  it('a read-only steward sends NOTHING — the dismiss control is not rendered', async () => {
    const rec: Recorder = { inboxData: steward(['ai.proposal.read']), dismissStatus: 200, dismissed: false, requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      // The finding is visible to read, but there is no button to set it aside.
      expect(await page.locator('#rows .row').count()).toBe(1);
      expect(await page.locator('#rows .act.dismiss').count()).toBe(0);
      // Nothing was ever POSTed — the client cannot dismiss under a grant it does not hold.
      expect(rec.requests.some((r) => r.method === 'POST')).toBe(false);
    } finally {
      await teardown();
    }
  });

  it('an empty reason is refused client-side — nothing is sent and the row stays open', async () => {
    const rec: Recorder = { inboxData: steward(['ai.proposal.read', 'ai.suggestion.dismiss']), dismissStatus: 200, dismissed: false, requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      // Click dismiss with the reason box left blank.
      await page.click('#rows .act.dismiss');
      await page.waitForSelector('#result:not([hidden])', { timeout: 10_000 });
      // No decision reached the cloud, and the finding is still open — a set-aside with no reason is not a record.
      expect(rec.requests.some((r) => r.method === 'POST')).toBe(false);
      expect(await page.locator('#rows .row').count()).toBe(1);
      expect(await page.locator('#dismissed-rows .row').count()).toBe(0);
    } finally {
      await teardown();
    }
  });
});
