import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

/**
 * **The facilities manager marks an overdue check done, in a real browser (M26-FR-03 · API-11 · §28 — the E2E matrix).**
 *
 * Every layer of the facilities desk — the tested `findOverdue` fold, the session model, the complete port — is
 * unit- and integration-tested. The one thing units cannot prove is that a facilities manager, in an ACTUAL
 * browser, seeing an overdue compliance check and clicking **"Mark done"** (with the evidence + a second verifier
 * they typed in), makes that decision reach the cloud under their OWN session, and that the check then drops off
 * the overdue list. This drives headless Chromium against a stub cloud to prove exactly that end to end:
 *
 *   • an authorised manager (facilities.overdue.read + facilities.task.record) → filling the evidence + verifier
 *     and clicking Mark done POSTs { completedBy, evidenceRefs, verifiedBy } to
 *     /v1/facilities/tasks/:taskId/complete under their own session; the check then drops off once the overdue
 *     list is re-READ (the server re-derives it — a completed check is no longer overdue — never a client shuffle);
 *   • a read-only user (facilities.overdue.read only) → sees the overdue list but is offered NO mark-done button,
 *     so no write can even be started (P-04 least privilege: the server re-checks too, but the screen never even
 *     offers it).
 *
 * A tick is worth nothing at an inspection; the server refuses a completion with no required evidence or a
 * self-verified safety check (§28), which this screen never fakes. The overdue list is read live from a single
 * GET (/v1/facilities/overdue?asOf=), exactly as in production. The browser binary is the environment's
 * pre-installed Chromium; where none is present the suite SKIPS rather than failing, like the sibling suites.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';

interface BrowserGlobals {
  readonly document: {
    querySelectorAll(selector: string): { readonly length: number };
  };
}

/** One overdue fire-safety check — a real, compliance-linked miss the manager must close out. Once completed the
 *  server no longer lists it as overdue (a completed check is not overdue), so it drops off on the next read. */
const TASK_ID = 'task-fire';
const TASK = {
  taskId: TASK_ID, scheduleId: 's-fire', title: 'Fire extinguisher check', category: 'fire_safety',
  dueOn: '2026-09-12', daysOverdue: 9, level: 'compliance_risk', escalateTo: 'owner', complianceLinked: true,
  detail: '"Fire extinguisher check" is 9 day(s) overdue and a regulator would care — escalated to owner',
};

interface Recorder {
  facilitiesData: Record<string, unknown>;
  completeStatus: number;
  done: boolean;
  readonly requests: { method: string; path: string; body: unknown }[];
}

/** A server that BOTH serves the shell (GET, manager context injected) AND answers the two routes the desk
 *  touches — the complete POST (taskId in the URL) and the read-only overdue GET (/v1/facilities/overdue) — on
 *  the SAME origin, so `credentials: 'same-origin'` and a relative `/v1/...` reach it exactly as in production.
 *  Once a completion is recorded, the overdue list comes back empty, so a done check drops off on re-read (a
 *  server re-derive, never a client-side shuffle). */
async function startShellAndCloud(rec: Recorder): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      if (req.method === 'POST' && path.startsWith('/v1/facilities/tasks/') && path.endsWith('/complete')) {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8');
        rec.requests.push({ method: 'POST', path, body: raw === '' ? undefined : JSON.parse(raw) });
        if (rec.completeStatus >= 200 && rec.completeStatus < 300) rec.done = true;
        res.writeHead(rec.completeStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ taskId: TASK_ID, scheduleId: TASK.scheduleId, accepted: rec.done, outcome: rec.done ? 'complete' : 'evidence_missing' }));
        return;
      }
      if (req.method === 'GET' && path === '/v1/facilities/overdue') {
        rec.requests.push({ method: 'GET', path, body: undefined });
        const overdue = rec.done ? [] : [TASK];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ overdue, complianceRisks: overdue.length, asAt: '2026-09-22T00:00:00.000Z' }));
        return;
      }
      const file = path === '/' || path === '/facilities' ? 'facilities.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
        let body = buf.toString('utf8');
        if (file.endsWith('.html')) {
          const inject = `<script>window.facilitiesData = ${JSON.stringify(rec.facilitiesData).replace(/</g, '\\u003c')};</script>`;
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

describe.skipIf(!HAVE_BROWSER)('the facilities manager marks an overdue check done, end to end in a real browser (M26-FR-03)', () => {
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
    // The overdue list is read live on load (one GET), so the check only appears once the read resolves.
    await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rows .row').length > 0, undefined, { timeout: 10_000 });
    return { srv, context, page, teardown: async () => { await context.close(); await srv.stop(); } };
  };

  it('an authorised manager: filling evidence + verifier and clicking Mark done POSTs it, and the check drops off', async () => {
    const rec: Recorder = { facilitiesData: manager('u-fm', ['facilities.overdue.read', 'facilities.task.record']), completeStatus: 200, done: false, requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      expect(await page.locator('#rows .row').count()).toBe(1);
      // The mark-done control is offered (the manager holds facilities.task.record).
      expect(await page.locator('#rows button.complete').count()).toBe(1);

      await page.fill('#rows input.evidence', 'photo-123');
      await page.fill('#rows input.verifier', 'u-manager');
      await page.click('#rows button.complete');

      // The check drops off because the overdue list was re-READ (server re-derive), not shuffled client-side.
      await page.waitForFunction(
        () => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rows .row').length === 0,
        undefined, { timeout: 10_000 },
      );
      const post = rec.requests.find((r) => r.method === 'POST' && r.path === `/v1/facilities/tasks/${TASK_ID}/complete`);
      expect(post, 'the completion was not POSTed to the task/complete URL').toBeDefined();
      const body = post!.body as { completedBy?: string; evidenceRefs?: string[]; verifiedBy?: string };
      expect(body.completedBy).toBe('u-fm'); // recorded in the manager's OWN name, never a body-supplied value
      expect(body.evidenceRefs).toEqual(['photo-123']);
      expect(body.verifiedBy).toBe('u-manager');

      // The overdue read runs at least twice: once on load, once after the completion to re-derive.
      expect(rec.requests.filter((r) => r.method === 'GET' && r.path === '/v1/facilities/overdue').length).toBeGreaterThanOrEqual(2);
      expect(await page.locator('#rows .row').count()).toBe(0);
      expect(await page.locator('#result').getAttribute('hidden')).toBeNull();
    } finally {
      await teardown();
    }
  });

  it('a read-only user sends NOTHING — no mark-done button is rendered', async () => {
    const rec: Recorder = { facilitiesData: manager('u-readonly', ['facilities.overdue.read']), completeStatus: 200, done: false, requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      expect(await page.locator('#rows .row').count()).toBe(1); // they can see the overdue list
      expect(await page.locator('#rows button.complete').count()).toBe(0); // but no way to mark done
      expect(rec.requests.some((r) => r.method === 'POST')).toBe(false);
    } finally {
      await teardown();
    }
  });
});
