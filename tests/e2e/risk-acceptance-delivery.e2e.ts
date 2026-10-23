import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

/**
 * **The compliance owner accepts a risk, in a real browser (M34-FR-04 · API-11 · §28 — the E2E matrix).**
 *
 * Every layer of the risk-acceptance desk — the tested acceptRisk/blockedGates engine, the session model, the
 * accept port — is unit- and integration-tested. The one thing units cannot prove is that a compliance owner, in
 * an ACTUAL browser, picking a risk + a rationale and clicking **"Accept the risk"** makes their decision reach
 * the cloud under their own session, and that the gate then unblocks. This drives headless Chromium against a
 * stub cloud to prove exactly that end to end:
 *
 *   • an authorised owner (compliance.risk.read + compliance.risk.manage) → the accept POSTs {rationale} to
 *     /v1/compliance/risks/:riskId/acceptance under their own session, the result strip shows, and the blocked
 *     gate drops off once the worklist is re-read (a read, never a client-side move);
 *   • a read-only user (compliance.risk.read only) → the accept form is not even rendered, and NOTHING is sent;
 *   • an empty rationale → refused client-side, nothing sent (an acceptance with no reason is not a record — the
 *     engine refuses a blank reason server-side, and the screen never even tries).
 *
 * The browser binary is the environment's pre-installed Chromium; where none is present the suite SKIPS rather
 * than failing, exactly like the cash-office sign-off suite it mirrors.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';

interface BrowserGlobals {
  readonly document: {
    querySelectorAll(selector: string): { readonly length: number };
  };
}

/** One gate blocked by an open critical risk — the desk's to work. The shape `GET /v1/compliance/gates/blocked`
 *  hands each row over (one per gate × risk); accepting the risk clears it. */
const ONE_BLOCK = {
  gate: 'QG-04', riskId: 'risk-unencrypted-backups', title: 'Unencrypted backups',
  severity: 'critical', ownerUserId: 'u-seclead', reason: 'open critical risk on this gate',
};

interface Recorder {
  riskAcceptanceData: Record<string, unknown>;
  acceptStatus: number;
  accepted: boolean;
  readonly requests: { method: string; path: string; body: unknown }[];
  /** OB-330: the security reviewer head office holds (undefined: the read is refused, so "not known"). */
  reviewer?: { userId: string; displayName: string } | null;
  ownerSigned?: boolean;
}

/** A server that BOTH serves the shell (GET, owner context injected) AND answers the two routes the desk
 *  touches — the accept POST (riskId in the URL) and the blocked-gates GET — on the SAME origin, so
 *  `credentials: 'same-origin'` and a relative `/v1/...` reach it exactly as in production. Once the risk is
 *  accepted the GET returns no blocked gates, so the row drops off on re-read. */
async function startShellAndCloud(rec: Recorder): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      // OB-330: the two-signature reads and writes.
      if (req.method === 'GET' && path === '/v1/compliance/risk-acceptances') {
        rec.requests.push({ method: 'GET', path, body: undefined });
        if (rec.reviewer === undefined) { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{}'); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ reviewer: rec.reviewer, mustBeFixed: rec.reviewer === null, risks: [{ riskId: ONE_BLOCK.riskId, owner: rec.ownerSigned === true ? { signedBy: 'u-compliance' } : null, securityReviewer: null }] }));
        return;
      }
      if ((req.method === 'PUT' && path === '/v1/compliance/security-reviewer') || (req.method === 'POST' && path.endsWith('/acceptance/review'))) {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, string>;
        rec.requests.push({ method: req.method, path, body });
        if (req.method === 'PUT') rec.reviewer = { userId: body['userId']!, displayName: body['displayName']! };
        else rec.accepted = true;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(req.method === 'PUT' ? { reviewer: rec.reviewer } : { status: 'accepted' }));
        return;
      }
      if (req.method === 'POST' && path.startsWith('/v1/compliance/risks/') && path.endsWith('/acceptance')) {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8');
        rec.requests.push({ method: 'POST', path, body: raw === '' ? undefined : JSON.parse(raw) });
        if (rec.acceptStatus === 202) rec.ownerSigned = true;
        else if (rec.acceptStatus >= 200 && rec.acceptStatus < 300) rec.accepted = true;
        res.writeHead(rec.acceptStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify(rec.acceptStatus === 422
          ? { error: { code: 'must_be_fixed_no_security_reviewer', whatHappened: 'no reviewer', wasItSaved: 'not_saved', nextSafeAction: 'fix it' } }
          : { riskId: ONE_BLOCK.riskId, status: rec.acceptStatus === 202 ? 'awaiting_second_signature' : rec.acceptStatus < 400 ? 'accepted' : 'open' }));
        return;
      }
      if (req.method === 'GET' && path === '/v1/compliance/gates/blocked') {
        rec.requests.push({ method: 'GET', path, body: undefined });
        const blocked = rec.accepted ? [] : [ONE_BLOCK];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ blocked, count: blocked.length, asAt: '2026-09-18T10:00:00.000Z' }));
        return;
      }
      const file = path === '/' || path === '/risk-acceptance' ? 'risk-acceptance.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        let body = buf.toString('utf8');
        if (file.endsWith('.html')) {
          const inject = `<script>window.riskAcceptanceData = ${JSON.stringify(rec.riskAcceptanceData).replace(/</g, '\\u003c')};</script>`;
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

const owner = (permissions: readonly string[]): Record<string, unknown> => ({
  userId: 'u-compliance', tenantId: 't1', permissions,
});

describe.skipIf(!HAVE_BROWSER)('the compliance owner accepts a risk, end to end in a real browser (M34-FR-04)', () => {
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
    // The blocked gates are read live on load (GET), so the row only appears once the read resolves.
    await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rows .row').length > 0, undefined, { timeout: 10_000 });
    return { srv, context, page, teardown: async () => { await context.close(); await srv.stop(); } };
  };

  it('an authorised owner: picking a risk + rationale and clicking accept POSTs it, and the gate drops off', async () => {
    const rec: Recorder = { riskAcceptanceData: owner(['compliance.risk.read', 'compliance.risk.manage']), acceptStatus: 200, accepted: false, requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      expect(await page.locator('#rows .row').count()).toBe(1);
      // The accept form is offered (the owner holds compliance.risk.manage).
      expect(await page.locator('#accepter').getAttribute('hidden')).toBeNull();

      await page.selectOption('#accept-risk', 'risk-unencrypted-backups');
      await page.fill('#accept-rationale', 'compensating control (offsite encrypted copy) in place until Q3; owner signed off');
      await page.click('#accept');

      // The gate drops off because the worklist was re-READ (server re-derive), not shuffled client-side.
      await page.waitForFunction(
        () => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rows .row').length === 0,
        undefined, { timeout: 10_000 },
      );
      const post = rec.requests.find((r) => r.method === 'POST' && r.path === '/v1/compliance/risks/risk-unencrypted-backups/acceptance');
      expect(post, 'the acceptance was not POSTed to the risk URL').toBeDefined();
      expect((post!.body as { rationale?: string }).rationale).toBe('compensating control (offsite encrypted copy) in place until Q3; owner signed off');

      expect(rec.requests.filter((r) => r.method === 'GET' && r.path === '/v1/compliance/gates/blocked').length).toBeGreaterThanOrEqual(2);
      expect(await page.locator('#rows .row').count()).toBe(0);
      expect(await page.locator('#result').getAttribute('hidden')).toBeNull();
    } finally {
      await teardown();
    }
  });

  it('a read-only user sends NOTHING — the accept form is not rendered', async () => {
    const rec: Recorder = { riskAcceptanceData: owner(['compliance.risk.read']), acceptStatus: 200, accepted: false, requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      expect(await page.locator('#rows .row').count()).toBe(1);
      expect(await page.locator('#accepter').getAttribute('hidden')).not.toBeNull(); // the form is hidden
      expect(rec.requests.some((r) => r.method === 'POST')).toBe(false);
    } finally {
      await teardown();
    }
  });

  it('an empty rationale is refused client-side — nothing is sent and the gate stays blocked', async () => {
    const rec: Recorder = { riskAcceptanceData: owner(['compliance.risk.read', 'compliance.risk.manage']), acceptStatus: 200, accepted: false, requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      await page.selectOption('#accept-risk', 'risk-unencrypted-backups');
      // Leave the rationale empty.
      await page.click('#accept');
      await page.waitForSelector('#result:not([hidden])', { timeout: 10_000 });
      expect(rec.requests.some((r) => r.method === 'POST')).toBe(false);
      expect(await page.locator('#rows .row').count()).toBe(1);
    } finally {
      await teardown();
    }
  });

  // ── OB-330 (owner, 23 Oct 2026): two signatures — the owner and the named security reviewer ─────────────────────────

  it('OB-330: with no reviewer named the screen says the risk must be fixed; the owner names the reviewer on screen; his signature then waits for the reviewer', async () => {
    const rec: Recorder = { riskAcceptanceData: owner(['compliance.risk.read', 'compliance.risk.manage', 'compliance.reviewer.name']), acceptStatus: 422, accepted: false, requests: [], reviewer: null };
    const { page, teardown } = await openScreen(rec);
    try {
      await page.waitForFunction(() => /must be fixed/.test((globalThis as unknown as { document: { getElementById(i: string): { textContent: string | null } | null } }).document.getElementById('reviewer-words')?.textContent ?? ''), undefined, { timeout: 10_000 });
      // Signing now is refused by head office: must be fixed.
      await page.selectOption('#accept-risk', 'risk-unencrypted-backups');
      expect((await page.locator('#accept').textContent())?.trim()).toBe('Sign as owner');
      await page.fill('#accept-rationale', 'offsite encrypted copy until Q3');
      await page.click('#accept');
      await page.waitForFunction(() => /must be fixed/.test((globalThis as unknown as { document: { getElementById(i: string): { textContent: string | null } | null } }).document.getElementById('result-text')?.textContent ?? ''), undefined, { timeout: 10_000 });
      // The owner names the reviewer — entered on screen, sent as entered.
      expect(await page.locator('#namer').getAttribute('hidden')).toBeNull();
      await page.fill('#reviewer-id', 'u-rev');
      await page.fill('#reviewer-name', 'R. Reviewer');
      await page.fill('#reviewer-reason', 'external security reviewer for the pilot');
      await page.click('#name-reviewer');
      await page.waitForFunction(() => /R\. Reviewer \(u-rev\)/.test((globalThis as unknown as { document: { getElementById(i: string): { textContent: string | null } | null } }).document.getElementById('reviewer-words')?.textContent ?? ''), undefined, { timeout: 10_000 });
      expect(rec.requests.find((r) => r.method === 'PUT')?.body).toEqual({ userId: 'u-rev', displayName: 'R. Reviewer', reason: 'external security reviewer for the pilot' });
      // Now the owner's signature is recorded and waits for the second person; the gate stays blocked.
      rec.acceptStatus = 202;
      await page.fill('#accept-rationale', 'offsite encrypted copy until Q3');
      await page.click('#accept');
      await page.waitForFunction(() => /second person/.test((globalThis as unknown as { document: { getElementById(i: string): { textContent: string | null } | null } }).document.getElementById('result-text')?.textContent ?? ''), undefined, { timeout: 10_000 });
      expect(await page.locator('#rows .row').count()).toBe(1);
      await page.waitForFunction(() => /Owner signed: u-compliance/.test((globalThis as unknown as { document: { getElementById(i: string): { textContent: string | null } | null } }).document.getElementById('rows')?.textContent ?? ''), undefined, { timeout: 10_000 });
      // In Tamil the reviewer panel and the button speak Tamil, with the icon beside the word.
      await page.click('#lang');
      expect(await page.locator('#accept').textContent()).toContain('உரிமையாளராகக் கையொப்பமிடு');
      expect(await page.locator('#accept svg').count()).toBe(1);
    } finally {
      await teardown();
    }
  });

  it('OB-330: the named reviewer signs as security reviewer, to the review route, and the gate drops off', async () => {
    const rec: Recorder = { riskAcceptanceData: { userId: 'u-rev', tenantId: 't1', permissions: ['compliance.risk.read'] }, acceptStatus: 200, accepted: false, requests: [], reviewer: { userId: 'u-rev', displayName: 'R. Reviewer' }, ownerSigned: true };
    const { page, teardown } = await openScreen(rec);
    try {
      await page.waitForFunction(() => /Sign as security reviewer/.test((globalThis as unknown as { document: { getElementById(i: string): { textContent: string | null } | null } }).document.getElementById('accept')?.textContent ?? ''), undefined, { timeout: 10_000 });
      expect(await page.locator('#namer').getAttribute('hidden')).not.toBeNull(); // only the owner names
      await page.selectOption('#accept-risk', 'risk-unencrypted-backups');
      await page.fill('#accept-rationale', 'offsite copy and restore test verified');
      await page.click('#accept');
      await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rows .row').length === 0, undefined, { timeout: 10_000 });
      expect(rec.requests.find((r) => r.method === 'POST')?.path).toBe('/v1/compliance/risks/risk-unencrypted-backups/acceptance/review');
    } finally {
      await teardown();
    }
  });
});
