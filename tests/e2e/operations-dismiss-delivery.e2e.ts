import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

/**
 * **The operator sets a recommendation aside, in a real browser (A06 · API-13 — the E2E matrix).**
 *
 * Every layer of the Operations inbox — the tested recommend-runbook engine, the worklist fold, the session
 * model, the dismiss port — is unit- and integration-tested. The one thing units cannot prove is that a person
 * pressing **"Set aside"** in an actual browser makes their decision reach the cloud, under their own session,
 * and that the row then moves. This drives headless Chromium against a stub cloud to prove exactly that:
 *
 *   • an authorised operator → typing a reason and clicking set-aside POSTs {findingId, reason} to
 *     /v1/ai/operations/dismissals under the operator's own session, the result strip shows, and the row moves
 *     from "to act on" to "set aside" once the worklist is re-read (a read, never a client-side move);
 *   • an operator with only READ access → the set-aside control is not even rendered, and NOTHING is sent;
 *   • an empty reason → refused client-side, nothing sent (a set-aside with no reason is not a record).
 *
 * The browser binary is the environment's pre-installed Chromium; where none is present the suite SKIPS rather
 * than failing, exactly like the data-quality dismiss-delivery suite it mirrors.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';

interface BrowserGlobals {
  readonly document: {
    querySelectorAll(selector: string): { readonly length: number };
    querySelector(selector: string): { readonly value?: string } | null;
  };
}

/** One open operations recommendation — the operator's to act on. The finding id is the real A06 shape,
 *  `ops-runbook:<alertId>`; both are opaque to the screen (it echoes the id straight back on a set-aside). */
const OPEN_ENTRY = {
  status: 'open' as const,
  finding: {
    findingId: 'ops-runbook:dl-1',
    alertId: 'dl-1',
    component: 'dead_letter',
    status: 'degraded',
    headline: 'The dead-letter queue is growing',
    detail: 'Messages are parking and not draining.',
    runbook: 'Open the dead-letter queue, park the poison item, let the rest drain.',
  },
};
const DISMISSED_ENTRY = {
  ...OPEN_ENTRY, status: 'dismissed' as const,
  dismissal: { by: 'u-op', at: '2026-09-15T09:00:00.000Z', reason: 'the on-call operator is handling it' },
};
const OPEN_WORKLIST = { agentActive: true, open: [OPEN_ENTRY], dismissed: [] };
const DISMISSED_WORKLIST = { agentActive: true, open: [], dismissed: [DISMISSED_ENTRY] };

interface Recorder {
  inboxData: Record<string, unknown>;
  dismissStatus: number;
  dismissed: boolean;
  readonly requests: { method: string; path: string; body: unknown }[];
}

/** A server that BOTH serves the shell (GET, operator context injected) AND answers the two routes the inbox
 *  touches — the dismiss POST and the worklist GET — on the SAME origin, so `credentials: 'same-origin'` and a
 *  relative `/v1/...` reach it exactly as in production. */
async function startShellAndCloud(rec: Recorder): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      if (req.method === 'POST' && path === '/v1/ai/operations/dismissals') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8');
        rec.requests.push({ method: 'POST', path, body: raw === '' ? undefined : JSON.parse(raw) });
        if (rec.dismissStatus >= 200 && rec.dismissStatus < 300) rec.dismissed = true;
        res.writeHead(rec.dismissStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: rec.dismissStatus < 400 }));
        return;
      }
      if (req.method === 'GET' && path === '/v1/ai/operations/worklist') {
        rec.requests.push({ method: 'GET', path, body: undefined });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(rec.dismissed ? DISMISSED_WORKLIST : OPEN_WORKLIST));
        return;
      }
      const file = path === '/' || path === '/operations' ? 'operations.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
        let body = buf.toString('utf8');
        if (file.endsWith('.html')) {
          const inject = `<script>window.operationsInboxData = ${JSON.stringify(rec.inboxData).replace(/</g, '\\u003c')};</script>`;
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

const operator = (permissions: readonly string[]): Record<string, unknown> => ({
  userId: 'u-op', tenantId: 't1', permissions, worklist: OPEN_WORKLIST,
});

describe.skipIf(!HAVE_BROWSER)('the operator sets a recommendation aside, end to end in a real browser (A06)', () => {
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
    await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('.status').length > 0, undefined, { timeout: 10_000 });
    return { srv, context, page, teardown: async () => { await context.close(); await srv.stop(); } };
  };

  it('an authorised operator: typing a reason and clicking set-aside POSTs the decision, and the row moves to "set aside"', async () => {
    const rec: Recorder = { inboxData: operator(['ai.proposal.read', 'ai.suggestion.dismiss']), dismissStatus: 200, dismissed: false, requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      expect(await page.locator('#rows .row').count()).toBe(1);
      expect(await page.locator('#rows .act.dismiss').count()).toBe(1);

      await page.fill('#rows .reason', 'the on-call operator is handling it');
      await page.click('#rows .act.dismiss');

      await page.waitForFunction(
        () => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#dismissed-rows .row').length > 0,
        undefined, { timeout: 10_000 },
      );
      const post = rec.requests.find((r) => r.method === 'POST' && r.path === '/v1/ai/operations/dismissals');
      expect(post, 'the set-aside decision was not POSTed').toBeDefined();
      expect((post!.body as { findingId?: string }).findingId).toBe('ops-runbook:dl-1');
      expect((post!.body as { reason?: string }).reason).toBe('the on-call operator is handling it');

      // The row MOVED because the worklist was re-read (server re-derive), not shuffled client-side.
      expect(rec.requests.filter((r) => r.method === 'GET' && r.path === '/v1/ai/operations/worklist').length).toBeGreaterThanOrEqual(1);
      expect(await page.locator('#rows .row').count()).toBe(0);
      expect(await page.locator('#dismissed-rows .row').count()).toBe(1);
      expect(await page.locator('#result').getAttribute('hidden')).toBeNull();
    } finally {
      await teardown();
    }
  });

  it('a read-only operator sends NOTHING — the set-aside control is not rendered', async () => {
    const rec: Recorder = { inboxData: operator(['ai.proposal.read']), dismissStatus: 200, dismissed: false, requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      expect(await page.locator('#rows .row').count()).toBe(1);
      expect(await page.locator('#rows .act.dismiss').count()).toBe(0);
      expect(rec.requests.some((r) => r.method === 'POST')).toBe(false);
    } finally {
      await teardown();
    }
  });

  it('an empty reason is refused client-side — nothing is sent and the row stays open', async () => {
    const rec: Recorder = { inboxData: operator(['ai.proposal.read', 'ai.suggestion.dismiss']), dismissStatus: 200, dismissed: false, requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      await page.click('#rows .act.dismiss');
      await page.waitForSelector('#result:not([hidden])', { timeout: 10_000 });
      expect(rec.requests.some((r) => r.method === 'POST')).toBe(false);
      expect(await page.locator('#rows .row').count()).toBe(1);
      expect(await page.locator('#dismissed-rows .row').count()).toBe(0);
    } finally {
      await teardown();
    }
  });
});
