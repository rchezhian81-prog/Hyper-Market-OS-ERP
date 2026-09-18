import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';

/**
 * **An accountant/owner reopens a locked day, in a real browser, and it reaches the store computer
 * (M14-FR-04 · §28 · P-08).**
 *
 * Every layer of the reopen — the tested engine, the box's authoritative `reopenDay`, the lane socket, the
 * session model — is unit- and integration-tested. The one thing units cannot prove is that an authorised
 * person, in an ACTUAL browser, picking a locked day + a reason + a NAMED approver and clicking **"Reopen the
 * day"** makes the reopen reach the box (cross-port, CORS and all), and that a self-approval is refused before
 * anything is sent. This drives headless Chromium against a REAL edge to prove exactly that:
 *
 *   • the shell is served (with the reopener's context + the locked-day worklist + the box's lane address
 *     injected) by a small server standing in for the ERP host; the reopen itself POSTs cross-port to the REAL
 *     box lane, which finds the locked day in its own log, runs the §28 engine, and records `StoreDayReopened`;
 *   • a self-approval (approver == reopener) is refused CLIENT-SIDE — nothing is sent, and the box is untouched.
 *
 * The browser binary is the environment's pre-installed Chromium; where none is present the suite SKIPS rather
 * than failing, exactly like the sibling delivery suites.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';
const KEY = ['day', 'reopen', 'e2e', 'pack', 'signing', 'key'].join('-').padEnd(48, '0');
const PACK_JSON = JSON.stringify({ version: 1, policies: { tradingDayCutoff: '02:00' }, lossPreventionRules: [] });

interface BrowserGlobals {
  readonly document: { querySelectorAll(selector: string): { readonly length: number } };
}

/** A small server that serves the day-reopen shell with the reopener's context, the locked-day worklist, and
 *  the box's lane address injected — standing in for the ERP host. The reopen itself does NOT come here; it
 *  POSTs cross-port to the real box lane (laneWriteBase). It also answers the locked-day GET so a live refresh
 *  is clean, returning the same locked day. */
async function startShell(dayReopenData: Record<string, unknown>, laneWriteBase: string, lockedDay: Record<string, unknown>): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      if (req.method === 'GET' && path === '/v1/pos/day-close') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ dayCloses: [{ ...lockedDay, locked: true }], lockedCount: 1 }));
        return;
      }
      const file = path === '/' || path === '/day-reopen' ? 'day-reopen.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
        let body = buf.toString('utf8');
        if (file.endsWith('.html')) {
          const inject = `<script>window.dayReopenData = ${JSON.stringify(dayReopenData).replace(/</g, '\\u003c')};</script>`
            + `<script>window.laneWriteBase = ${JSON.stringify(laneWriteBase)};</script>`;
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

const person = (userId: string, permissions: readonly string[]): Record<string, unknown> => ({ userId, permissions });

describe.skipIf(!HAVE_BROWSER)('an accountant/owner reopens a locked day, end to end in a real browser (M14-FR-04)', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    // Build the CURRENT web-erp bundle so the browser runs this branch's code, not a stale artifact.
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);

  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  /** A real box (no cloud) with ONE locked day on its log, ready to be reopened over its lane. */
  async function boxWithALockedDay(): Promise<{ edge: EdgeProcess; laneBase: string; dayCloseId: string; tradingDay: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'sre-day-reopen-'));
    dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, PACK_JSON, 'utf8');
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_PACK_FILE: packFile,
    }, () => {}))!;
    stops.push(() => edge.stop());
    const dayCloseId = 'dc-e2e';
    const closed = await edge.closeDay({ dayCloseId, closedBy: 'manager' });
    if (!closed.closed) throw new Error(`could not seed a locked day: ${closed.reason}`);
    return { edge, laneBase: `http://127.0.0.1:${edge.lane!.port}`, dayCloseId, tradingDay: closed.tradingDay };
  }

  const openScreen = async (base: string) => {
    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`${base}/day-reopen`, { waitUntil: 'load' });
    // The injected worklist means the locked row is there on load; wait for it so the form has rendered.
    await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rows .row').length > 0, undefined, { timeout: 10_000 });
    return page;
  };

  it('an authorised reopener: picking a day + reason + a DIFFERENT approver and clicking reopens it ON THE BOX', async () => {
    const { edge, laneBase, dayCloseId, tradingDay } = await boxWithALockedDay();
    const lockedDay = { dayCloseId, tradingDay, closedBy: 'manager', closedAt: '2026-09-18T02:05:00.000Z' };
    const shell = await startShell(person('u-owner', ['till.dayclose.read', 'till.dayclose.approve']), laneBase, lockedDay);
    stops.push(shell.stop);
    const page = await openScreen(shell.base);

    // The reopen form is offered (the reopener holds till.dayclose.approve).
    expect(await page.locator('#reopener').getAttribute('hidden')).toBeNull();
    await page.selectOption('#reopen-day', dayCloseId);
    await page.fill('#reopen-reason', 'wrong float found next morning');
    await page.fill('#reopen-approver', 'u-accountant'); // a DIFFERENT person (§28)
    await page.click('#do-reopen');

    // The result strip confirms it, and — the proof — the reopen reached the BOX: a durable StoreDayReopened on
    // the box's day-close log, queued for the cloud.
    await page.waitForSelector('#result.tone-ok:not([hidden])', { timeout: 10_000 });
    expect(edge.dayCloseOutbox.pending().map((i) => i.event.type)).toContain('StoreDayReopened');
    const records = await readLog(edge.dayCloseLog.path);
    const reopens = records.filter((r) => r.ok === true).map((r) => JSON.parse(r.record) as { dayCloseId?: string; reopenedBy?: string; approvedBy?: string }).filter((p) => typeof p.reopenedBy === 'string');
    expect(reopens).toHaveLength(1);
    expect(reopens[0]).toMatchObject({ dayCloseId, reopenedBy: 'u-owner', approvedBy: 'u-accountant' });
  });

  it('a self-approval is refused CLIENT-SIDE (§28) — nothing is sent and the box is untouched', async () => {
    const { edge, laneBase, dayCloseId, tradingDay } = await boxWithALockedDay();
    const lockedDay = { dayCloseId, tradingDay, closedBy: 'manager', closedAt: '2026-09-18T02:05:00.000Z' };
    const shell = await startShell(person('u-owner', ['till.dayclose.read', 'till.dayclose.approve']), laneBase, lockedDay);
    stops.push(shell.stop);
    const page = await openScreen(shell.base);

    await page.selectOption('#reopen-day', dayCloseId);
    await page.fill('#reopen-reason', 'trying to approve my own reopen');
    await page.fill('#reopen-approver', 'u-owner'); // the reopener names THEMSELVES — a self-approval
    await page.click('#do-reopen');

    // The screen refuses it (an error result), and nothing reached the box — no reopen on the log.
    await page.waitForSelector('#result.tone-error:not([hidden])', { timeout: 10_000 });
    const records = await readLog(edge.dayCloseLog.path);
    const reopens = records.filter((r) => r.ok === true).map((r) => JSON.parse(r.record) as { reopenedBy?: string }).filter((p) => typeof p.reopenedBy === 'string');
    expect(reopens).toHaveLength(0);
    expect(edge.dayCloseOutbox.pending().map((i) => i.event.type)).not.toContain('StoreDayReopened');
  });
});
