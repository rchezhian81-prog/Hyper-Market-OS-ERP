import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';

/**
 * **A checker approves or rejects what someone else asked for, in a real browser (ADR-0024 · audit PA-03 · M02-FR-03 ·
 * §28 — the E2E matrix).**
 *
 * Every layer of the Approvals page — the tested session model, the defensive row reader, the live fetch — is
 * unit-tested, and head office's engine is integration-tested. The one thing units cannot prove is that a person, in
 * an ACTUAL browser, OPENS the page and SEES what waits for them in plain words, and that pressing **Approve** or
 * **Reject** sends exactly one decision WITH THEIR WRITTEN REASON under their own session — and nothing at all
 * without one. This drives headless Chromium against a stub head office to prove it end to end:
 *
 *   • on open, the inbox is READ (a GET) and nothing is written; each waiting request shows the action, the summary,
 *     who asked, why and exactly what will happen; "What you asked for" shows each status in words;
 *   • Approve with no reason → refused on the page, NOTHING is POSTed;
 *   • Approve with a reason → one POST to /v1/approvals/requests/:id/decide with { decision, reason } and an
 *     idempotency key; the inbox is READ again and the decided request leaves "Waiting for you";
 *   • Reject with a reason → the same, with decision "rejected";
 *   • head office refuses (409 already decided, 403 not permitted) → its own words are shown, and the list re-reads.
 *
 * The browser binary is the environment's pre-installed Chromium; where none is present the suite SKIPS rather
 * than failing, exactly like the other back-office delivery suites.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';

interface Row {
  requestId: string; kind: string; label: string; subjectRef: string; valueMinor: number | null;
  details: Record<string, unknown>; summary: string; reason: string; requestedBy: string; requestedAt: string;
  status: 'waiting' | 'approved' | 'rejected' | 'expired' | 'used';
  decidedBy?: string; decisionReason?: string; decidedAt?: string; expiresAt?: string | null; usedBy?: string;
}

/** The checker looking at the page. */
const CHECKER = 'u-owner';

const waitingImport = (): Row => ({
  requestId: 'areq-imp', kind: 'data_import_commit', label: 'Apply a bulk import', subjectRef: 'sept-prices', valueMinor: null,
  details: { jobId: 'sept-prices', contentFingerprint: 'ab'.repeat(32) },
  summary: 'Load 120 rows (Products (SKU, name, price)) as "sept-prices"', reason: 'September price list from the supplier',
  requestedBy: 'u-buyer', requestedAt: '2026-10-07T04:00:00.000Z', status: 'waiting',
});
const waitingBank = (): Row => ({
  requestId: 'areq-bank', kind: 'supplier_bank_change', label: 'Change where a supplier is paid', subjectRef: 'SUP-7', valueMinor: 1250000,
  details: { supplierId: 'SUP-7', newAccountLast4: '4321' }, summary: 'Pay Sri Murugan Traders into the new account', reason: 'Supplier changed banks',
  requestedBy: 'u-acct', requestedAt: '2026-10-07T03:00:00.000Z', status: 'waiting',
});
const myRequests = (): Row[] => [
  { ...waitingImport(), requestId: 'areq-mine-1', requestedBy: CHECKER, subjectRef: 'oct-prices', summary: 'Load 80 rows (Products) as "oct-prices"', status: 'approved', decidedBy: 'u-mgr', decisionReason: 'checked', decidedAt: '2026-10-07T02:00:00.000Z', expiresAt: '2026-10-08T02:00:00.000Z', requestedAt: '2026-10-07T01:00:00.000Z' },
  { ...waitingImport(), requestId: 'areq-mine-2', requestedBy: CHECKER, subjectRef: 'bad-prices', summary: 'Load 5 rows (Products) as "bad-prices"', status: 'rejected', decidedBy: 'u-mgr', decisionReason: 'wrong supplier file', requestedAt: '2026-10-06T01:00:00.000Z' },
];

interface Recorder {
  data: Record<string, unknown>;
  waiting: Row[];
  mine: Row[];
  /** When set, the next decide is refused with this status + error body. */
  refuseNext?: { status: number; code: string; whatHappened: string };
  readonly requests: { method: string; path: string; body: unknown; headers: Record<string, string | string[] | undefined> }[];
}

/** A server that BOTH serves the page (GET, the checker's context injected) AND answers the two routes the page
 *  touches — the inbox GET and the decide POST — on the SAME origin, so `credentials: 'same-origin'` and a relative
 *  `/v1/...` reach it exactly as in production. It records EVERY request so the test can prove what was written. */
async function startShellAndCloud(rec: Recorder): Promise<{ base: string; stop: () => Promise<void> }> {
  const readBody = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    return raw === '' ? undefined : JSON.parse(raw);
  };
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      if (path.startsWith('/v1/')) {
        const body = req.method === 'POST' ? await readBody(req) : undefined;
        rec.requests.push({ method: req.method ?? 'GET', path, body, headers: req.headers });
      }
      if (req.method === 'GET' && path === '/v1/approvals/requests') {
        json(res, 200, { waitingForMe: rec.waiting, mine: rec.mine, asAt: '2026-10-07T08:00:00.000Z' });
        return;
      }
      const decide = /^\/v1\/approvals\/requests\/([^/]+)\/decide$/.exec(path);
      if (req.method === 'POST' && decide !== null) {
        const requestId = decodeURIComponent(decide[1]!);
        const b = rec.requests[rec.requests.length - 1]!.body as { decision?: string; reason?: string };
        if (rec.refuseNext !== undefined) {
          const r = rec.refuseNext; rec.refuseNext = undefined;
          // Head office's state moved on (someone else decided it) — the re-read shows that.
          rec.waiting = rec.waiting.filter((w) => w.requestId !== requestId);
          json(res, r.status, { error: { code: r.code, whatHappened: r.whatHappened, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was decided.' } });
          return;
        }
        if ((b.decision !== 'approved' && b.decision !== 'rejected') || typeof b.reason !== 'string' || b.reason.trim() === '') {
          json(res, 400, { error: { code: 'not_readable_as_a_decision', whatHappened: 'A decision needs a reason.', wasItSaved: 'not_saved', nextSafeAction: '' } });
          return;
        }
        rec.waiting = rec.waiting.filter((w) => w.requestId !== requestId);
        json(res, 201, { requestId, decision: b.decision, decidedBy: CHECKER, reason: b.reason, decidedAt: '2026-10-07T08:01:00.000Z', expiresAt: null });
        return;
      }

      const file = path === '/' || path === '/approvals' ? 'approvals.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        let out = buf.toString('utf8');
        if (file.endsWith('.html')) {
          const inject = `<script>window.approvalsData = ${JSON.stringify(rec.data).replace(/</g, '\\u003c')};</script>`;
          out = out.replace('<!--SCREEN-DATA-->', inject);
        }
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(out);
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

const checker = (): Recorder => ({
  data: { userId: CHECKER, permissions: ['identity.self.read', 'purchase.import.record'] },
  waiting: [waitingImport(), waitingBank()], mine: myRequests(), requests: [],
});

const textOf = (page: Page, selector: string): Promise<string> => page.locator(selector).innerText();
const decisions = (rec: Recorder) => rec.requests.filter((r) => r.method === 'POST');

describe.skipIf(!HAVE_BROWSER)('a checker approves or rejects what someone else asked for, end to end in a real browser (ADR-0024 · §28)', () => {
  let browser: Browser;

  beforeAll(async () => {
    // Build the CURRENT web-erp bundle so the browser runs this branch's code, not a stale artifact.
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  const openPage = async (rec: Recorder) => {
    const srv = await startShellAndCloud(rec);
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    // The inbox is read LIVE on open; the live rows carry the real request ids (the sample's do not).
    await page.waitForSelector('#waiting li[data-request-id="areq-imp"]', { timeout: 10_000 });
    return { page, errors, teardown: async () => { await context.close(); await srv.stop(); } };
  };
  const waitResult = async (page: Page, expected: RegExp): Promise<string> => {
    await page.waitForFunction(
      (source) => {
        const doc = (globalThis as unknown as { document: { getElementById(i: string): { hidden: boolean; textContent: string | null } | null } }).document;
        const box = doc.getElementById('result');
        return box !== null && !box.hidden && new RegExp(source).test(doc.getElementById('result-text')?.textContent ?? '');
      },
      expected.source, { timeout: 10_000 },
    );
    return (await page.locator('#result-text').textContent()) ?? '';
  };

  it('on open: the inbox is READ, nothing is written, and each request is shown in plain words', async () => {
    const rec = checker();
    const { page, errors, teardown } = await openPage(rec);
    try {
      expect(rec.requests.filter((r) => r.method === 'GET' && r.path === '/v1/approvals/requests').length).toBeGreaterThanOrEqual(1);
      expect(decisions(rec), 'nothing is written on open').toEqual([]);
      expect(await page.locator('#sample').isHidden()).toBe(true);

      expect(await textOf(page, '#waiting-count')).toBe('2 waiting for you');
      // Biggest amount first: the bank change (₹12,500.00), then the import.
      expect(await page.locator('#waiting > li').evaluateAll((lis) => lis.map((li) => (li as unknown as { dataset: { requestId: string } }).dataset.requestId))).toEqual(['areq-bank', 'areq-imp']);
      const imp = await textOf(page, '#waiting li[data-request-id="areq-imp"]');
      expect(imp).toContain('Apply a bulk import');
      expect(imp).toContain('Load 120 rows (Products (SKU, name, price)) as "sept-prices"');
      expect(imp).toContain('Asked by: u-buyer');
      expect(imp).toContain('Why: September price list from the supplier');
      expect(imp).toContain('When: 07-10-2026 09:30');
      expect(imp).toContain('Load name: sept-prices');
      expect(imp).toContain('Waiting for your decision');
      const bank = await textOf(page, '#waiting li[data-request-id="areq-bank"]');
      expect(bank).toContain('₹12,500.00');
      expect(bank).toContain('Supplier: SUP-7');

      // What I asked for — each status in words, not colour.
      const mine = await textOf(page, '#mine');
      expect(mine).toContain('Approved by u-mgr — use it before 08-10-2026 07:30');
      expect(mine).toContain('Rejected by u-mgr: wrong supplier file');
      // Every reason box has a visible label.
      expect(await page.locator('#waiting label[for="reason-areq-imp"]').innerText()).toBe('Your reason (the person who asked will read it)');
      expect(errors).toEqual([]);
    } finally {
      await teardown();
    }
  });

  it('Approve with NO reason is refused on the page and NOTHING is sent; with a reason, exactly one decision is POSTed and the inbox re-reads', async () => {
    const rec = checker();
    const { page, errors, teardown } = await openPage(rec);
    try {
      const row = page.locator('#waiting li[data-request-id="areq-imp"]');
      await row.locator('button.approve').click();
      expect(await waitResult(page, /Write a reason first/)).toMatch(/^Write a reason first/);
      expect(await page.locator('#result').getAttribute('class')).toContain('tone-error');
      expect(decisions(rec), 'a decision without a reason must not leave the page').toEqual([]);

      const readsBefore = rec.requests.filter((r) => r.method === 'GET').length;
      await row.locator('input.reason').fill('Checked the prices against the supplier letter');
      await row.locator('button.approve').click();
      expect(await waitResult(page, /^Approved\./)).toBe('Approved. The person who asked can now go ahead — once.');

      const sent = decisions(rec);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.path).toBe('/v1/approvals/requests/areq-imp/decide');
      expect(sent[0]!.body).toEqual({ decision: 'approved', reason: 'Checked the prices against the supplier letter' });
      expect(sent[0]!.headers['idempotency-key'], 'the decision carries an idempotency key').toBeTruthy();
      // The inbox was READ again, and the decided request left "Waiting for you" because head office said so.
      await page.waitForSelector('#waiting li[data-request-id="areq-imp"]', { state: 'detached', timeout: 10_000 });
      expect(rec.requests.filter((r) => r.method === 'GET').length).toBeGreaterThan(readsBefore);
      expect(await textOf(page, '#waiting-count')).toBe('1 waiting for you');
      expect(errors).toEqual([]);
    } finally {
      await teardown();
    }
  });

  it('Reject with a reason sends "rejected" with that reason — and works the same in Tamil', async () => {
    const rec = checker();
    const { page, teardown } = await openPage(rec);
    try {
      await page.click('#lang');
      await page.waitForFunction('document.documentElement.lang === "ta"');
      const row = page.locator('#waiting li[data-request-id="areq-bank"]');
      expect(await row.locator('button.reject').innerText()).toBe('மறு');
      await row.locator('input.reason').fill('Call the supplier on the number we already have first');
      await row.locator('button.reject').click();
      expect(await waitResult(page, /மறுக்கப்பட்டது/)).toMatch(/^மறுக்கப்பட்டது/);
      const sent = decisions(rec);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.path).toBe('/v1/approvals/requests/areq-bank/decide');
      expect(sent[0]!.body).toEqual({ decision: 'rejected', reason: 'Call the supplier on the number we already have first' });
      await page.waitForSelector('#waiting li[data-request-id="areq-bank"]', { state: 'detached', timeout: 10_000 });
    } finally {
      await teardown();
    }
  });

  it('head office refuses: its own words are shown (409 already decided, 403 not permitted), and the list re-reads', async () => {
    const rec = checker();
    const { page, teardown } = await openPage(rec);
    try {
      rec.refuseNext = { status: 409, code: 'already_decided', whatHappened: 'This request was already approved by u-mgr.' };
      const imp = page.locator('#waiting li[data-request-id="areq-imp"]');
      await imp.locator('input.reason').fill('Looks right');
      await imp.locator('button.approve').click();
      expect(await waitResult(page, /already approved by u-mgr/)).toBe('Someone already decided this: This request was already approved by u-mgr.');
      await page.waitForSelector('#waiting li[data-request-id="areq-imp"]', { state: 'detached', timeout: 10_000 });

      rec.refuseNext = { status: 403, code: 'not_permitted_for_this_approval', whatHappened: 'u-owner may not approve "Change where a supplier is paid".' };
      const bank = page.locator('#waiting li[data-request-id="areq-bank"]');
      await bank.locator('input.reason').fill('Fine');
      await bank.locator('button.approve').click();
      expect(await waitResult(page, /may not approve/)).toBe('Not recorded: u-owner may not approve "Change where a supplier is paid".');
      expect(await page.locator('#result').getAttribute('class')).toContain('tone-error');
      expect(decisions(rec)).toHaveLength(2);
    } finally {
      await teardown();
    }
  });
});
