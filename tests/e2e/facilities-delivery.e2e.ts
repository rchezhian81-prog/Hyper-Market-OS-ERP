import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

/**
 * **A safety check is done by one person and verified by ANOTHER, each in a real browser under their own sign-in
 * (M26-FR-03 · API-11 · §28 · Wave 2b audit PA-03 — the E2E matrix).**
 *
 * The audit executed a facilities verification with two typed, unprovisioned names and got 200: a name in a body is
 * a claim, a sign-in is a fact. The cloud now takes the completer and the verifier from the sign-in, and refuses a
 * body that names anyone. This drives headless Chromium against a stub cloud to prove the screen follows:
 *
 *   • the facilities manager (u-fm) fills the evidence and clicks **Mark done** → the POST carries
 *     { completedBy: 'u-fm', evidenceRefs } and NO verifiedBy (there is no box to type one); the cloud answers 202
 *     "waiting for a second person"; the screen says so, re-reads, and the row shows "Done by u-fm" with NO Verify
 *     button for its own completer — and no second Mark done;
 *   • a DIFFERENT manager (u-manager) opens the same screen under their own sign-in → the row offers **Verify**; the
 *     click POSTs an EMPTY body to /v1/facilities/tasks/:taskId/verify (the verifier is the sign-in), and the check
 *     drops off once the overdue list is re-READ (a server re-derive, never a client shuffle);
 *   • a read-only user (facilities.overdue.read only) sees the list and is offered neither action, so nothing is sent.
 *
 * The overdue list is read live from a single GET (/v1/facilities/overdue?asOf=), exactly as in production. The
 * browser binary is the environment's pre-installed Chromium; where none is present the suite SKIPS rather than failing.
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

type TaskState = 'open' | 'awaiting' | 'done';
interface Recorder {
  facilitiesData: Record<string, unknown>;
  state: TaskState;
  readonly requests: { method: string; path: string; body: unknown }[];
}

/** A server that BOTH serves the shell (GET, the signed-in person's context injected) AND answers the three routes
 *  the desk touches — complete, verify, and the read-only overdue GET — on the SAME origin, so
 *  `credentials: 'same-origin'` and a relative `/v1/...` reach it exactly as in production. Its state follows the
 *  cloud's rule: a safety check marked done WAITS (202) until a second person verifies it; only then is it no longer
 *  overdue. The state is shared between the two people's sessions, as the cloud's is. */
async function startShellAndCloud(rec: Recorder): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      const json = (status: number, body: unknown): void => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.method === 'POST' && path.startsWith('/v1/facilities/tasks/')) {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8');
        rec.requests.push({ method: 'POST', path, body: raw === '' ? undefined : JSON.parse(raw) });
        if (path.endsWith('/complete')) {
          rec.state = 'awaiting';
          json(202, { taskId: TASK_ID, scheduleId: TASK.scheduleId, accepted: false, outcome: 'not_verified', awaitingVerification: true, completedBy: 'u-fm' });
          return;
        }
        if (path.endsWith('/verify')) {
          rec.state = 'done';
          json(200, { taskId: TASK_ID, scheduleId: TASK.scheduleId, accepted: true, outcome: 'complete', verifiedBy: 'u-manager' });
          return;
        }
      }
      if (req.method === 'GET' && path === '/v1/facilities/overdue') {
        rec.requests.push({ method: 'GET', path, body: undefined });
        const overdue = rec.state === 'done' ? [] : rec.state === 'awaiting'
          ? [{ ...TASK, awaitingVerification: true, completedBy: 'u-fm', completedOn: '2026-09-22' }]
          : [{ ...TASK, awaitingVerification: false }];
        json(200, { overdue, complianceRisks: overdue.length, asAt: '2026-09-22T00:00:00.000Z' });
        return;
      }
      const file = path === '/' || path === '/facilities' ? 'facilities.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
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
      resolve({ base: `http://127.0.0.1:${port}`, stop: () => new Promise((done) => { server.close(() => { done(); }); server.closeAllConnections(); }) });
    });
  });
}

const manager = (userId: string, permissions: readonly string[]): Record<string, unknown> => ({
  userId, permissions,
});

const RECORD = ['facilities.overdue.read', 'facilities.task.record'];
/** Runs INSIDE the page — it may use only its argument (the browser sees no test-side variable). */
const rowsAre = (expected: number): boolean => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rows .row').length === expected;

describe.skipIf(!HAVE_BROWSER)('a safety check is done by one person and verified by another, end to end in a real browser (M26-FR-03 · PA-03)', () => {
  let browser: Browser;

  beforeAll(async () => {
    // Build the CURRENT web-erp bundle so the browser runs this branch's code, not a stale artifact.
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  /** Open the screen as one signed-in person, on a server whose state the recorder holds. */
  const openAs = async (base: string, rec: Recorder, userId: string, permissions: readonly string[]) => {
    rec.facilitiesData = manager(userId, permissions);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${base}/`, { waitUntil: 'load' });
    // The overdue list is read live on load (one GET), so the check only appears once the read resolves.
    await page.waitForFunction(rowsAre, 1, { timeout: 10_000 });
    return { page, close: () => context.close() };
  };

  it('the facilities manager marks it done and sees it WAITING — no typed verifier, no Verify on their own work; a different manager verifies it and it drops off', async () => {
    const rec: Recorder = { facilitiesData: {}, state: 'open', requests: [] };
    const srv = await startShellAndCloud(rec);
    try {
      // ── the first person: the one who did the check ─────────────────────────────────────────────────────────
      const fm = await openAs(srv.base, rec, 'u-fm', RECORD);
      expect(await fm.page.locator('#rows button.complete').count()).toBe(1);
      expect(await fm.page.locator('#rows input.verifier').count(), 'there is no box to type a second person').toBe(0);
      expect(await fm.page.locator('#rows button.verify').count()).toBe(0);
      await fm.page.fill('#rows input.evidence', 'photo-123');
      await fm.page.click('#rows button.complete');
      await fm.page.waitForFunction(() => (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector('#rows .awaiting') !== null, undefined, { timeout: 10_000 });

      const post = rec.requests.find((r) => r.method === 'POST' && r.path === `/v1/facilities/tasks/${TASK_ID}/complete`);
      expect(post, 'the completion was not POSTed to the task/complete URL').toBeDefined();
      expect(post!.body).toEqual({ completedBy: 'u-fm', evidenceRefs: ['photo-123'] }); // never a verifiedBy
      // The screen says it was recorded and now waits — never "done".
      expect(await fm.page.locator('#result-text').textContent()).toContain('waits for a second person');
      // Re-read: the row stays, shows who did it, offers the completer no Verify and no second Mark done.
      expect(await fm.page.locator('#rows .row').count()).toBe(1);
      expect(await fm.page.locator('#rows .facts').textContent()).toContain('Done by: u-fm');
      expect(await fm.page.locator('#rows .awaiting').textContent()).toContain('a different person must verify it');
      expect(await fm.page.locator('#rows button.verify').count()).toBe(0);
      expect(await fm.page.locator('#rows button.complete').count()).toBe(0);
      await fm.close();

      // ── the second person: a different manager, under their own sign-in ─────────────────────────────────────
      const second = await openAs(srv.base, rec, 'u-manager', RECORD);
      expect(await second.page.locator('#rows .facts').textContent()).toContain('Done by: u-fm');
      expect(await second.page.locator('#rows button.verify').count()).toBe(1);
      await second.page.click('#rows button.verify');
      await second.page.waitForFunction(rowsAre, 0, { timeout: 10_000 });
      const verify = rec.requests.find((r) => r.method === 'POST' && r.path === `/v1/facilities/tasks/${TASK_ID}/verify`);
      expect(verify, 'the verification was not POSTed to the task/verify URL').toBeDefined();
      expect(verify!.body).toEqual({}); // who verifies is the sign-in — the body names nobody
      expect(await second.page.locator('#result-text').textContent()).toContain('Verified and recorded in your name');
      // The overdue read ran on each load and after each act — the list is re-derived, never shuffled client-side.
      expect(rec.requests.filter((r) => r.method === 'GET' && r.path === '/v1/facilities/overdue').length).toBeGreaterThanOrEqual(4);
      await second.close();
    } finally {
      await srv.stop();
    }
  });

  it('a read-only user sends NOTHING — neither Mark done nor Verify is rendered, even on a check that waits', async () => {
    const rec: Recorder = { facilitiesData: {}, state: 'awaiting', requests: [] };
    const srv = await startShellAndCloud(rec);
    try {
      const viewer = await openAs(srv.base, rec, 'u-readonly', ['facilities.overdue.read']);
      expect(await viewer.page.locator('#rows .row').count()).toBe(1); // they can see the overdue list
      expect(await viewer.page.locator('#rows button.complete').count()).toBe(0);
      expect(await viewer.page.locator('#rows button.verify').count()).toBe(0);
      expect(rec.requests.some((r) => r.method === 'POST')).toBe(false);
      await viewer.close();
    } finally {
      await srv.stop();
    }
  });
});
