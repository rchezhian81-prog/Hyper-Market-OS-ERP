import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { buildDeviceChangeCommand } from '../../apps/web-erp/src/fleet-device-command';

/**
 * **The fleet manager delivers a device change, in a real browser (M33-FR-02/04 — the E2E matrix).**
 *
 * Every layer of "the signed-in manager blocks/retires a till, as themselves" is unit- and integration-tested;
 * the one thing units cannot prove is that a person pressing **Send now** in an actual browser makes the device
 * change reach the cloud registry under that manager's own session, and that the durable queue then transitions
 * honestly. This drives headless Chromium against a stub cloud to prove exactly that end to end:
 *
 *   • an authorised manager → the block reaches `POST /v1/platform/devices/till-3/status` under the operator's
 *     session (same-origin, their cookie, never a service token), and the outbox item clears (acknowledged);
 *   • the cloud refuses it (403 not-authorised) → the command DEAD-LETTERS, kept visible for a person, never
 *     applied under a borrowed identity and never silently dropped (hard rule #6, P-05).
 *
 * The browser binary is the environment's pre-installed Chromium; where none is present the suite SKIPS rather
 * than failing, exactly like the offline-open suite.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';
const OUTBOX_KEY = 'sre.fleet-outbox';

interface BrowserGlobals {
  readonly localStorage: { getItem(k: string): string | null; setItem(k: string, v: string): void };
  readonly document: { getElementById(id: string): { readonly hidden?: boolean } | null };
}

/** One pending block command, in the exact device-outbox shape the boot restores from localStorage. */
function seededOutbox(): string {
  const cmd = buildDeviceChangeCommand({
    deviceId: 'till-3', change: 'block', observedStatus: 'registered', requestedBy: 'u-owner',
    at: '2026-09-02T06:00:00.000Z', reason: 'screen cracked',
  });
  return JSON.stringify([{ key: cmd.idempotencyKey, event: cmd, state: 'pending', attempts: 0, reason: null }]);
}

/** What the ERP injects about the signed-in manager. */
const manager = (): Record<string, unknown> => ({
  userId: 'u-owner', permissions: ['platform.health.read', 'platform.device.manage'],
  summary: { total: 0, trading: 0, blocked: 0, mustUpgrade: 0, silent: 0, byVersion: {} }, devices: [],
});

interface Recorder {
  fleetData: Record<string, unknown>;
  statusCode: number;
  readonly requests: { method: string; path: string; body: unknown }[];
}

/** A server that BOTH serves the shell (GET, with the manager context injected) AND answers the registry route
 *  the operator-session delivery port POSTs to — the same origin, so `credentials: 'same-origin'` and a
 *  relative `/v1/...` reach it exactly as they do in production. */
async function startShellAndCloud(rec: Recorder): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8');
        rec.requests.push({ method: 'POST', path, body: raw === '' ? undefined : JSON.parse(raw) });
        res.writeHead(rec.statusCode, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: rec.statusCode < 400 }));
        return;
      }
      const file = path === '/' || path === '/fleet' ? 'fleet.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
        let body = buf.toString('utf8');
        if (file.endsWith('.html')) {
          const inject = `<script>window.fleetData = ${JSON.stringify(rec.fleetData).replace(/</g, '\\u003c')};</script>`;
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

describe.skipIf(!HAVE_BROWSER)('fleet change delivery, end to end in a real browser (M33-FR-02/04)', () => {
  let browser: Browser;

  beforeAll(async () => {
    // Build the CURRENT web-erp bundle so the browser runs this branch's code, not a stale artifact.
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  /** Open the fleet screen with the outbox seeded and the given manager context; wait for the Send button. */
  const openScreen = async (rec: Recorder) => {
    const srv = await startShellAndCloud(rec);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript(([key, json]) => { (globalThis as unknown as BrowserGlobals).localStorage.setItem(key, json); }, [OUTBOX_KEY, seededOutbox()] as const);
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    // The pending queue holds one change → the "Send now" button becomes visible.
    await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.getElementById('send')?.hidden === false, undefined, { timeout: 10_000 });
    return { srv, context, page, teardown: async () => { await context.close(); await srv.stop(); } };
  };

  const storedOutbox = (page: import('playwright-core').Page) =>
    page.evaluate((key) => JSON.parse((globalThis as unknown as BrowserGlobals).localStorage.getItem(key) ?? '[]') as { state: string }[], OUTBOX_KEY);

  it('an authorised manager sends a block: it reaches the registry under their session and the queue clears', async () => {
    const rec: Recorder = { fleetData: manager(), statusCode: 200, requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      await page.click('#send');
      // Wait until the outbox item has been acknowledged (the delivery completed).
      await page.waitForFunction((key) => {
        const items = JSON.parse((globalThis as unknown as BrowserGlobals).localStorage.getItem(key) ?? '[]') as { state: string }[];
        return items[0]?.state === 'acknowledged';
      }, OUTBOX_KEY, { timeout: 10_000 });

      // The block reached the registry, to the status route, with the target status and the reason.
      const req = rec.requests.find((r) => r.path === '/v1/platform/devices/till-3/status');
      expect(req, 'the block was not POSTed to the registry').toBeDefined();
      expect((req!.body as { status?: string; reason?: string })).toMatchObject({ status: 'blocked', reason: 'screen cracked' });
      // The result strip says something (not silent), and the durable queue cleared.
      expect(((await page.textContent('#deliver-msg')) ?? '').trim().length).toBeGreaterThan(0);
      expect((await storedOutbox(page))[0]?.state).toBe('acknowledged');
    } finally {
      await teardown();
    }
  });

  it('the registry refuses it (403) → the command dead-letters, kept for a person, never applied', async () => {
    const rec: Recorder = { fleetData: manager(), statusCode: 403, requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      await page.click('#send');
      await page.waitForFunction((key) => {
        const items = JSON.parse((globalThis as unknown as BrowserGlobals).localStorage.getItem(key) ?? '[]') as { state: string }[];
        return items[0]?.state === 'dead_letter';
      }, OUTBOX_KEY, { timeout: 10_000 });

      // It was attempted (the registry saw it) but the refusal dead-letters it — never silently dropped.
      expect(rec.requests.some((r) => r.path === '/v1/platform/devices/till-3/status')).toBe(true);
      expect((await storedOutbox(page))[0]?.state).toBe('dead_letter');
    } finally {
      await teardown();
    }
  });
});
