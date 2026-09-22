import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

/**
 * **The manager assigns to a short shift, in a real browser (M25-FR-01 · API-11 · §28 — the E2E matrix).**
 *
 * Every layer of the rostering desk — the tested `rosterGaps` fold, the session model, the assign port — is
 * unit- and integration-tested. The one thing units cannot prove is that a manager, in an ACTUAL browser,
 * picking a short shift + an eligible person and clicking **"Assign to the shift"** makes their decision reach
 * the cloud under their own session, and that the gap then drops off. This drives headless Chromium against a
 * stub cloud to prove exactly that end to end:
 *
 *   • an authorised manager (workforce.roster.read + workforce.roster.manage) → the assign POSTs {role} to
 *     /v1/hr/workforce/shifts/:shiftId/assignments/:employeeId under their own session, the result strip shows,
 *     and the gap drops off once the worklist is re-read (a read, never a client-side move);
 *   • a read-only user (workforce.roster.read only) → the assign form is not even rendered, and NOTHING is sent
 *     (P-04 least privilege: the server re-checks too, but the screen never even offers it).
 *
 * The roster gaps and the staff who can fill them are read live from TWO GETs (/roster + /roster-gaps), exactly
 * as in production. The browser binary is the environment's pre-installed Chromium; where none is present the
 * suite SKIPS rather than failing, exactly like the cash-office sign-off delivery suite it mirrors.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';

interface BrowserGlobals {
  readonly document: {
    querySelectorAll(selector: string): { readonly length: number };
  };
}

/** The stored roster the two read routes hand back. One shift short of a cashier, one active cashier who can
 *  fill it (not yet assigned), so the gap is real and Asha is the one eligible person. */
const SHIFT_ID = 'S-1';
const ROLE = 'cashier';
const EMPLOYEE = { employeeId: 'e-asha', name: 'Asha', branchId: 'br-1', roles: [ROLE], active: true };
const SHIFT = { shiftId: SHIFT_ID, branchId: 'br-1', startsAt: '2026-09-27T06:00:00.000Z', endsAt: '2026-09-27T14:00:00.000Z', requiredRoles: [{ role: ROLE, count: 1 }] };
const GAP = { shiftId: SHIFT_ID, role: ROLE, startsAt: SHIFT.startsAt, needed: 1, assigned: 0, short: 1, detail: '2026-09-27 06:00 has NOBODY rostered as cashier' };

interface Recorder {
  rosteringData: Record<string, unknown>;
  assignStatus: number;
  assigned: boolean;
  readonly requests: { method: string; path: string; body: unknown }[];
}

/** A server that BOTH serves the shell (GET, manager context injected) AND answers the three routes the desk
 *  touches — the assign POST (shift + employee in the URL) and the two read-only worklist GETs (/roster for the
 *  staff/shifts/assignments context, /roster-gaps for the folded gaps) — on the SAME origin, so
 *  `credentials: 'same-origin'` and a relative `/v1/...` reach it exactly as in production. Once an assignment is
 *  recorded, /roster-gaps returns nothing and /roster carries the new assignment, so a filled gap drops off on
 *  re-read (a server re-derive, never a client-side shuffle). */
async function startShellAndCloud(rec: Recorder): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      if (req.method === 'POST' && path.startsWith('/v1/hr/workforce/shifts/') && path.includes('/assignments/')) {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8');
        rec.requests.push({ method: 'POST', path, body: raw === '' ? undefined : JSON.parse(raw) });
        if (rec.assignStatus >= 200 && rec.assignStatus < 300) rec.assigned = true;
        res.writeHead(rec.assignStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ assignment: { shiftId: SHIFT_ID, employeeId: EMPLOYEE.employeeId, role: ROLE } }));
        return;
      }
      if (req.method === 'GET' && path === '/v1/hr/workforce/roster') {
        rec.requests.push({ method: 'GET', path, body: undefined });
        const assignments = rec.assigned ? [{ shiftId: SHIFT_ID, employeeId: EMPLOYEE.employeeId, role: ROLE }] : [];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ employees: [EMPLOYEE], shifts: [SHIFT], assignments }));
        return;
      }
      if (req.method === 'GET' && path === '/v1/hr/workforce/roster-gaps') {
        rec.requests.push({ method: 'GET', path, body: undefined });
        const gaps = rec.assigned ? [] : [GAP];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ gaps, gapCount: gaps.length, unstaffed: gaps.length, shiftsChecked: 1 }));
        return;
      }
      const file = path === '/' || path === '/rostering' ? 'rostering.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
        let body = buf.toString('utf8');
        if (file.endsWith('.html')) {
          const inject = `<script>window.rosteringData = ${JSON.stringify(rec.rosteringData).replace(/</g, '\\u003c')};</script>`;
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

describe.skipIf(!HAVE_BROWSER)('the manager assigns to a short shift, end to end in a real browser (M25-FR-01)', () => {
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
    // The worklist is read live on load (two GETs), so the gap only appears once the reads resolve.
    await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rows .row').length > 0, undefined, { timeout: 10_000 });
    return { srv, context, page, teardown: async () => { await context.close(); await srv.stop(); } };
  };

  it('an authorised manager: picking a short shift + an eligible person and clicking assign POSTs it, and the gap drops off', async () => {
    const rec: Recorder = { rosteringData: manager('u-manager', ['workforce.roster.read', 'workforce.roster.manage']), assignStatus: 200, assigned: false, requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      expect(await page.locator('#rows .row').count()).toBe(1);
      // The assign form is offered (the manager holds workforce.roster.manage).
      expect(await page.locator('#assigner').getAttribute('hidden')).toBeNull();
      // The one eligible person (Asha) is offered for the gap.
      expect(await page.locator('#assign-who option').count()).toBe(1);

      await page.selectOption('#assign-gap', { index: 0 });
      await page.selectOption('#assign-who', EMPLOYEE.employeeId);
      await page.click('#assign');

      // The gap drops off because the worklist was re-READ (server re-derive), not shuffled client-side.
      await page.waitForFunction(
        () => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rows .row').length === 0,
        undefined, { timeout: 10_000 },
      );
      const post = rec.requests.find((r) => r.method === 'POST' && r.path === `/v1/hr/workforce/shifts/${SHIFT_ID}/assignments/${EMPLOYEE.employeeId}`);
      expect(post, 'the assignment was not POSTed to the shift/employee URL').toBeDefined();
      expect((post!.body as { role?: string }).role).toBe(ROLE);

      // The gaps read runs at least twice: once on load, once after the assign to re-derive.
      expect(rec.requests.filter((r) => r.method === 'GET' && r.path === '/v1/hr/workforce/roster-gaps').length).toBeGreaterThanOrEqual(2);
      expect(await page.locator('#rows .row').count()).toBe(0);
      expect(await page.locator('#result').getAttribute('hidden')).toBeNull();
    } finally {
      await teardown();
    }
  });

  it('a read-only user sends NOTHING — the assign form is not rendered', async () => {
    const rec: Recorder = { rosteringData: manager('u-readonly', ['workforce.roster.read']), assignStatus: 200, assigned: false, requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      expect(await page.locator('#rows .row').count()).toBe(1); // they can see the gaps
      expect(await page.locator('#assigner').getAttribute('hidden')).not.toBeNull(); // the form is hidden
      expect(rec.requests.some((r) => r.method === 'POST')).toBe(false);
    } finally {
      await teardown();
    }
  });
});
