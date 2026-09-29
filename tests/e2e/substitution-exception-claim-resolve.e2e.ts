import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

/**
 * **A queue member claims and resolves a delivery exception, in a real browser (M19-FR-01 · Item 2 · API-07 · §28 —
 * the E2E matrix).**
 *
 * Every layer of the exception inbox — the tested ownedWorklist / presentWorklist, the session model, the act
 * port — is unit- and integration-tested. The one thing units cannot prove is that a person, in an actual
 * browser, clicking **Claim** on a row and then **Resolve** with a reason code and the words makes their acts
 * reach the cloud under their own session, and that the exception then reads as theirs and finally drops off.
 * This drives headless Chromium against a stub cloud to prove exactly that end to end:
 *
 *   • an authorised queue member (order.read + order.exception.work) → Claim POSTs to
 *     /v1/orders/substitution-exceptions/:exceptionId/claim; the worklist is re-READ and the row now reads as
 *     held by them and the work form appears; Resolve POSTs {reasonCode, detail} to …/resolve; the row drops
 *     off once the worklist is re-read (a read, never a client-side move);
 *   • a read-only user (order.read only) → no Claim button, no work form, and NOTHING is sent;
 *   • a resolve with no reason code → refused client-side, nothing sent (a resolution with no reason is not a
 *     record — hard rule #6).
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
    querySelector(selector: string): { readonly hidden?: boolean } | null;
  };
}

const ID = 'ord-77:line-2:refund_due';
const BASE_EXCEPTION = {
  exceptionId: ID, orderId: 'ord-77', lineId: 'line-2', kind: 'refund_due', amountMinor: 12500,
  detail: 'Substitute cheaper than ordered — ₹125.00 to refund', owner: 'finance_recon_queue', state: 'open',
  proposedBy: 'u-picker', reasonCode: 'SUB-REFUND-DUE', raisedAt: '2026-09-29T08:00:00.000Z',
  sla: { ageMinutes: 45, dueAt: '2026-09-29T10:00:00.000Z', breached: false },
};
const QUEUES_ONE = { fulfilment_supervisor: 0, customer_service_desk: 0, finance_recon_queue: 1, duty_manager: 0 };
const QUEUES_NONE = { fulfilment_supervisor: 0, customer_service_desk: 0, finance_recon_queue: 0, duty_manager: 0 };
type Phase = 'open' | 'claimed' | 'resolved';
const worklistFor = (phase: Phase) => phase === 'open'
  ? { exceptions: [BASE_EXCEPTION], count: 1, atRiskMinor: 12500, open: { count: 1, atRiskMinor: 12500, breached: 0 }, queues: QUEUES_ONE }
  : phase === 'claimed'
    ? { exceptions: [{ ...BASE_EXCEPTION, state: 'in_progress', assignedTo: 'u-desk' }], count: 1, atRiskMinor: 12500, open: { count: 1, atRiskMinor: 12500, breached: 0 }, queues: QUEUES_ONE }
    : { exceptions: [{ ...BASE_EXCEPTION, state: 'resolved', assignedTo: 'u-desk' }], count: 1, atRiskMinor: 12500, open: { count: 0, atRiskMinor: 0, breached: 0 }, queues: QUEUES_NONE };

interface Recorder {
  inboxData: Record<string, unknown>;
  phase: Phase;
  readonly requests: { method: string; path: string; body: unknown }[];
}

/** A server that BOTH serves the shell (GET, the member's context injected) AND answers the routes the inbox
 *  touches — the claim / release / resolve POSTs (exceptionId in the URL) and the worklist GET — on the SAME
 *  origin, so `credentials: 'same-origin'` and a relative `/v1/...` reach it exactly as in production. */
async function startShellAndCloud(rec: Recorder): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [rawPath = '/'] = (req.url ?? '/').split('?');
      const path = decodeURIComponent(rawPath);
      const act = /^\/v1\/orders\/substitution-exceptions\/(.+)\/(claim|release|resolve)$/.exec(path);
      if (req.method === 'POST' && act !== null) {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8');
        rec.requests.push({ method: 'POST', path, body: raw === '' ? undefined : JSON.parse(raw) });
        if (act[2] === 'claim') rec.phase = 'claimed';
        if (act[2] === 'resolve') rec.phase = 'resolved';
        if (act[2] === 'release') rec.phase = 'open';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ exception: { exceptionId: act[1], state: rec.phase === 'claimed' ? 'in_progress' : rec.phase } }));
        return;
      }
      if (req.method === 'GET' && path === '/v1/orders/substitution-exceptions') {
        rec.requests.push({ method: 'GET', path, body: undefined });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(worklistFor(rec.phase)));
        return;
      }
      const file = path === '/' || path === '/substitution-exceptions' ? 'substitution-exceptions.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        let body = buf.toString('utf8');
        if (file.endsWith('.html')) {
          const inject = `<script>window.substitutionExceptionInboxData = ${JSON.stringify(rec.inboxData).replace(/</g, '\\u003c')};</script>`;
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

const member = (permissions: readonly string[], phase: Phase = 'open'): Record<string, unknown> => ({
  userId: 'u-desk', tenantId: 't1', permissions, worklist: worklistFor(phase),
});

describe.skipIf(!HAVE_BROWSER)('a queue member claims and resolves a delivery exception, end to end in a real browser (M19-FR-01)', () => {
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
    await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rows .row').length > 0, undefined, { timeout: 10_000 });
    return { srv, context, page, teardown: async () => { await context.close(); await srv.stop(); } };
  };

  it('an authorised member: Claim POSTs and the row becomes theirs; Resolve with a reason + the words POSTs and the row drops off', async () => {
    const rec: Recorder = { inboxData: member(['order.read', 'order.exception.work']), phase: 'open', requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      expect(await page.locator('#rows .row').count()).toBe(1);
      // Nothing is held yet, so the work form is not offered; the open row offers Claim.
      expect(await page.locator('#worker').getAttribute('hidden')).not.toBeNull();
      await page.click('#rows .row button.claim');

      // After the claim the worklist is re-READ: the row is now held by this member and the work form appears.
      await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.querySelector('#worker')?.hidden === false, undefined, { timeout: 10_000 });
      const claim = rec.requests.find((r) => r.method === 'POST' && r.path === `/v1/orders/substitution-exceptions/${ID}/claim`);
      expect(claim, 'the claim was not POSTed to the exception URL').toBeDefined();
      expect(await page.locator('#rows .row button.claim').count()).toBe(0); // no longer open — nothing to claim

      await page.selectOption('#work-item', ID);
      await page.fill('#work-reason', 'REFUNDED');
      await page.fill('#work-detail', 'refunded ₹125 to the original card and told the customer');
      await page.click('#resolve');

      // The row drops off because the worklist was re-READ (server re-derive), not shuffled client-side.
      await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rows .row').length === 0, undefined, { timeout: 10_000 });
      const resolve = rec.requests.find((r) => r.method === 'POST' && r.path === `/v1/orders/substitution-exceptions/${ID}/resolve`);
      expect(resolve, 'the resolve was not POSTed to the exception URL').toBeDefined();
      expect(resolve!.body).toEqual({ reasonCode: 'REFUNDED', detail: 'refunded ₹125 to the original card and told the customer' });
      expect(rec.requests.filter((r) => r.method === 'GET' && r.path === '/v1/orders/substitution-exceptions').length).toBeGreaterThanOrEqual(2);
      expect(await page.locator('#result').getAttribute('hidden')).toBeNull();
    } finally {
      await teardown();
    }
  });

  it('a read-only user sends NOTHING — no Claim button and no work form', async () => {
    const rec: Recorder = { inboxData: member(['order.read']), phase: 'open', requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      expect(await page.locator('#rows .row').count()).toBe(1);
      expect(await page.locator('#rows .row button.claim').count()).toBe(0);
      expect(await page.locator('#worker').getAttribute('hidden')).not.toBeNull();
      expect(rec.requests.some((r) => r.method === 'POST')).toBe(false);
    } finally {
      await teardown();
    }
  });

  it('a resolve with no reason code is refused client-side — nothing is sent and the exception stays held', async () => {
    const rec: Recorder = { inboxData: member(['order.read', 'order.exception.work'], 'claimed'), phase: 'claimed', requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.querySelector('#worker')?.hidden === false, undefined, { timeout: 10_000 });
      await page.fill('#work-detail', 'some words but no reason code');
      await page.click('#resolve');
      await page.waitForSelector('#result:not([hidden])', { timeout: 10_000 });
      expect(rec.requests.some((r) => r.method === 'POST')).toBe(false);
      expect(await page.locator('#rows .row').count()).toBe(1);
    } finally {
      await teardown();
    }
  });
});
