import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

/**
 * **The operator exports data and loads a file under the two-person rule, in a real browser (M30-FR-01/02/03 · API-03 ·
 * §28 · ADR-0024 — the E2E matrix).**
 *
 * Every layer of the import/export console — the tested engines (validateImport/commitImport, the export engine, head
 * office's maker-checker engine), the DOM-free session model, the injected ports — is unit- and integration-tested.
 * The one thing units cannot prove is that an operator, in an ACTUAL browser, clicking **Export**, **Ask for
 * approval** and **Load it**, makes the right writes reach head office under their own session — and that no typed
 * approver's name exists anywhere on the screen any more. This drives headless Chromium against a stub head office
 * that behaves like the real routes (validate returns the file's check code; the approval engine records the
 * uploader's request; the commit refuses a typed approver, needs an APPROVED request for this job and this exact file,
 * and spends it once):
 *
 *   • an authorised operator (export.read) → clicking Export on a domain POSTs to /v1/export/:domain under their
 *     own session, the result strip shows, and the recent-exports log RE-READS (a GET, never a client-side push);
 *   • an operator without export.read → the export list is not even rendered (the panel is locked), and NOTHING
 *     is POSTed;
 *   • the import path — Check (a preview), Load before asking (refused on the screen, nothing POSTed), Ask for approval
 *     (the uploader's own request: kind data_import_commit, the job, the file's check code, the reason), Load while it
 *     waits (refused, nothing POSTed), then — once a DIFFERENT person approves it in their own session — Load commits
 *     naming the approved request's id, with no approver and no uploader named in the body;
 *   • a rejected request → the screen says who rejected it and why, and nothing is POSTed to commit;
 *   • the file changed after asking → the screen says the file changed and to ask again, and nothing is POSTed.
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
  };
}

/** The store's one shipped import template — the box carries the full column spec (validate/commit take it in the
 *  body), so the screen can resolve a templateId to a whole template with no "list templates" round trip. */
const TEMPLATE = {
  id: 'products-basic', domain: 'products', label: 'Products (SKU, name, price)', financial: false,
  columns: [{ name: 'sku', type: 'text' }, { name: 'name', type: 'text' }, { name: 'price', type: 'money_minor' }],
  keyColumns: ['sku'],
};

/** What GET /v1/export hands over — the exportable domains, with which columns are sensitive (P-04). */
const EXPORT_DOMAINS = [
  { domain: 'products', requires: 'catalogue.pack.read', columns: [{ name: 'sku', type: 'text', sensitive: false }, { name: 'cost', type: 'money_minor', sensitive: true }] },
  { domain: 'suppliers', requires: 'supplier.read', columns: [{ name: 'code', type: 'text', sensitive: false }] },
];

/** The preview a clean 2-row file gets back from POST /v1/import/validate — the shape validateImport returns. */
const CLEAN_PREVIEW = {
  totalRows: 2, validCount: 2, errorRowCount: 0, errors: [] as unknown[],
  duplicatesForReview: [] as unknown[], commitReady: true,
};

/** The stub's check code: like the real route, over the template, the file and the declared total — so a changed file
 *  gets a different code. */
const checkCodeOf = (body: { template?: unknown; text?: unknown; declaredTotalMinor?: unknown }): string =>
  createHash('sha256').update(JSON.stringify([body.template ?? null, body.text ?? null, body.declaredTotalMinor ?? null])).digest('hex');

interface ApprovalRow {
  requestId: string; kind: string; label: string; subjectRef: string; valueMinor: number | null;
  details: Record<string, unknown>; summary: string; reason: string; requestedBy: string; requestedAt: string;
  status: 'waiting' | 'approved' | 'rejected' | 'expired' | 'used';
  decidedBy?: string; decisionReason?: string; decidedAt?: string; expiresAt?: string | null; usedBy?: string;
}
interface ExportRow { userId: string; domain: string; at: string; rowCount: number; redactedColumns: readonly string[]; }
interface Recorder {
  data: Record<string, unknown>;
  exports: ExportRow[];
  approvals: ApprovalRow[];
  readonly requests: { method: string; path: string; body: unknown; headers: Record<string, string | string[] | undefined> }[];
}

/** The signed-in caller, as head office knows it from the session (never from a body value). */
const CALLER = 'u-op';

/** A server that BOTH serves the shell (GET, operator context injected) AND answers the routes the console touches —
 *  the export catalogue + log GETs, the export POST (domain in the URL), the validate + commit POSTs and the approval
 *  engine's ask + inbox — on the SAME origin, so `credentials: 'same-origin'` and a relative `/v1/...` reach it exactly
 *  as in production. The commit route refuses exactly as the real one does (ADR-0024). */
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
  const refuse = (res: ServerResponse, status: number, code: string, whatHappened: string) =>
    json(res, status, { error: { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was changed.' } });
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      const record = async (): Promise<unknown> => {
        const body = req.method === 'POST' ? await readBody(req) : undefined;
        rec.requests.push({ method: req.method ?? 'GET', path, body, headers: req.headers });
        return body;
      };

      if (req.method === 'POST' && path.startsWith('/v1/export/')) {
        const domain = decodeURIComponent(path.slice('/v1/export/'.length));
        await record();
        // An export happened: the log grows (newest first) — the screen re-READS it, never pushes to it.
        rec.exports.unshift({ userId: CALLER, domain, at: '2026-09-17T10:00:00.000Z', rowCount: 42, redactedColumns: ['cost'] });
        json(res, 200, { ok: true, domain, rowCount: 42 });
        return;
      }
      if (req.method === 'GET' && path === '/v1/export') { await record(); json(res, 200, { domains: EXPORT_DOMAINS }); return; }
      if (req.method === 'GET' && path === '/v1/exports') { await record(); json(res, 200, { exports: rec.exports }); return; }
      if (req.method === 'POST' && path === '/v1/import/validate') {
        const body = await record() as { template?: unknown; text?: unknown; declaredTotalMinor?: unknown };
        json(res, 200, { preview: CLEAN_PREVIEW, contentFingerprint: checkCodeOf(body) });
        return;
      }
      if (req.method === 'POST' && path === '/v1/approvals/requests') {
        const b = await record() as { kind?: string; subjectRef?: string; details?: Record<string, unknown>; valueMinor?: number | null; summary?: string; reason?: string };
        if (b.kind !== 'data_import_commit' || !b.subjectRef || !b.details || !b.summary || !b.reason) {
          refuse(res, 400, 'not_readable_as_an_approval_request', 'Not readable.');
          return;
        }
        const row: ApprovalRow = {
          requestId: `areq-${rec.approvals.length + 1}`, kind: b.kind, label: 'Apply a bulk import', subjectRef: b.subjectRef,
          valueMinor: b.valueMinor ?? null, details: b.details, summary: b.summary, reason: b.reason,
          requestedBy: CALLER, requestedAt: new Date(Date.parse('2026-10-07T04:00:00.000Z') + rec.approvals.length * 60_000).toISOString(), status: 'waiting',
        };
        rec.approvals.push(row);
        json(res, 201, row);
        return;
      }
      if (req.method === 'GET' && path === '/v1/approvals/requests') {
        await record();
        json(res, 200, { waitingForMe: [], mine: rec.approvals.filter((a) => a.requestedBy === CALLER), asAt: '2026-10-07T05:00:00.000Z' });
        return;
      }
      if (req.method === 'POST' && path === '/v1/import/commit') {
        const body = await record() as { jobId?: string; approvalId?: string; approval?: { decidedBy?: string }; uploadedBy?: string; template?: unknown; text?: unknown; declaredTotalMinor?: unknown } | undefined;
        if (body?.uploadedBy !== undefined && body.uploadedBy !== CALLER) { refuse(res, 403, 'actor_is_not_the_caller', 'The uploader is the signed-in caller.'); return; }
        if (typeof body?.approvalId !== 'string') {
          if (body?.approval?.decidedBy !== undefined) { refuse(res, 422, 'approver_named_without_approval', 'Naming a person is not their approval.'); return; }
          refuse(res, 422, 'no_approval', 'An import changes nothing until a second person approves it.');
          return;
        }
        const a = rec.approvals.find((x) => x.requestId === body.approvalId);
        if (a === undefined) { refuse(res, 422, 'approval_unknown', 'Head office has no such approval request.'); return; }
        if (a.status === 'used') { refuse(res, 422, 'approval_already_used', 'That approval was already used.'); return; }
        if (a.subjectRef !== body.jobId || a.requestedBy !== CALLER || a.details['contentFingerprint'] !== checkCodeOf(body) || a.details['jobId'] !== body.jobId) {
          refuse(res, 422, 'approval_does_not_match', 'That approval is not for exactly this.');
          return;
        }
        if (a.status === 'waiting') { refuse(res, 422, 'approval_still_waiting', 'That request has not been decided yet.'); return; }
        if (a.status === 'rejected') { refuse(res, 422, 'approval_rejected', `That request was rejected by ${a.decidedBy}: ${a.decisionReason}`); return; }
        a.status = 'used'; a.usedBy = `import-${body.jobId}`;
        json(res, 201, { committed: true, jobId: body.jobId });
        return;
      }

      const file = path === '/' || path === '/data-io' ? 'data-io.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        let out = buf.toString('utf8');
        if (file.endsWith('.html')) {
          const inject = `<script>window.dataIoData = ${JSON.stringify(rec.data).replace(/</g, '\\u003c')};</script>`;
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

const operator = (permissions: readonly string[]): Record<string, unknown> => ({
  userId: CALLER, permissions, importTemplates: [TEMPLATE],
});
const IMPORTER = ['purchase.import.read', 'purchase.import.record'];

const CLEAN_FILE = 'sku,name,price\nRICE5,Rice 5kg,45000\nDAL1,Dal 1kg,12000';

/** A different person decides the request in THEIR own session — here, head office's record of that decision. */
function decideAsSomeoneElse(rec: Recorder, requestId: string, decision: 'approved' | 'rejected', reason: string): void {
  const a = rec.approvals.find((x) => x.requestId === requestId)!;
  a.status = decision; a.decidedBy = 'u-owner'; a.decisionReason = reason; a.decidedAt = '2026-10-07T04:30:00.000Z';
  a.expiresAt = decision === 'approved' ? '2026-10-08T04:30:00.000Z' : null;
}

describe.skipIf(!HAVE_BROWSER)('the operator exports data and loads a file under the two-person rule, end to end in a real browser (M30 · ADR-0024)', () => {
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
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    return { srv, context, page, errors, teardown: async () => { await context.close(); await srv.stop(); } };
  };
  const posts = (rec: Recorder, path: string) => rec.requests.filter((r) => r.method === 'POST' && r.path === path);
  const resultText = async (page: Awaited<ReturnType<typeof openScreen>>['page'], id: string): Promise<string> =>
    ((await page.locator(`#${id}-text`).textContent()) ?? '').trim();
  /** Click, then wait for the result strip to show THIS click's answer (the strip is reused across clicks). */
  const clickFor = async (page: Awaited<ReturnType<typeof openScreen>>['page'], button: string, result: string, expected: RegExp): Promise<string> => {
    await page.click(button);
    await page.waitForFunction(
      ([id, source]) => {
        const doc = (globalThis as unknown as { document: { getElementById(i: string): { hidden: boolean; textContent: string | null } | null } }).document;
        const box = doc.getElementById(id);
        const words = doc.getElementById(`${id}-text`);
        return box !== null && !box.hidden && words !== null && new RegExp(source).test(words.textContent ?? '');
      },
      [result, expected.source] as const, { timeout: 10_000 },
    );
    return resultText(page, result);
  };

  it('an authorised operator: clicking Export POSTs it under their session, and the recent log re-reads', async () => {
    const rec: Recorder = { data: operator(['export.read']), exports: [], approvals: [], requests: [] };
    const { page, errors, teardown } = await openScreen(rec);
    try {
      // The catalogue is read LIVE on load (GET /v1/export), so the domains only appear after the read resolves.
      await page.waitForFunction(
        () => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#export-domains .row').length > 0,
        undefined, { timeout: 10_000 },
      );
      expect(await page.locator('#export-domains .row').count()).toBe(2);
      expect(rec.requests.filter((r) => r.method === 'POST').length).toBe(0); // nothing written on load

      await page.click('.export-btn[data-domain="products"]');

      await page.waitForFunction(
        () => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#recent-exports .row strong').length > 0,
        undefined, { timeout: 10_000 },
      );
      expect(posts(rec, '/v1/export/products'), 'the export was not POSTed to the domain URL').toHaveLength(1);
      // The log RE-READ (a GET after the export), not a client-side shuffle — the new row shows the domain.
      expect(rec.requests.filter((r) => r.method === 'GET' && r.path === '/v1/exports').length).toBeGreaterThanOrEqual(2);
      expect(await page.locator('#recent-exports').textContent()).toContain('products');
      expect(await page.locator('#export-result').getAttribute('hidden')).toBeNull();
      expect(errors).toEqual([]);
    } finally {
      await teardown();
    }
  });

  it('an operator without export.read sends NOTHING — the export list is not rendered, the panel is locked', async () => {
    const rec: Recorder = { data: operator([]), exports: [], approvals: [], requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      await page.waitForSelector('#export-locked:not([hidden])', { timeout: 10_000 });
      expect(await page.locator('#export-domains').getAttribute('hidden')).not.toBeNull(); // list hidden
      expect(await page.locator('.export-btn').count()).toBe(0); // no export button exists to click
      expect(rec.requests.some((r) => r.method === 'POST'), 'a locked operator must POST nothing').toBe(false);
    } finally {
      await teardown();
    }
  });

  it('the two-person import: Check, Ask for approval, wait, a DIFFERENT person approves, then Load names the approval', async () => {
    const rec: Recorder = { data: operator(IMPORTER), exports: [], approvals: [], requests: [] };
    const { page, errors, teardown } = await openScreen(rec);
    try {
      await page.waitForSelector('#import-form:not([hidden])', { timeout: 10_000 });
      // There is no box to type an approver into — anywhere on the page.
      expect(await page.locator('#import-approver').count()).toBe(0);
      expect(await page.locator('text=Approved by').count()).toBe(0);
      // The uploader's own requests are READ on open (a GET), and nothing is written on load.
      await page.waitForSelector('#my-requests:not([hidden])', { timeout: 10_000 });
      expect(await page.locator('#my-requests').textContent()).toContain('You have not asked for any load to be approved.');
      expect(rec.requests.some((r) => r.method === 'POST'), 'nothing is written on load').toBe(false);

      await page.selectOption('#import-template', 'products-basic');
      await page.fill('#import-file', CLEAN_FILE);
      await page.click('#validate');
      await page.waitForSelector('#preview:not([hidden])', { timeout: 10_000 });
      expect(await page.locator('#preview').getAttribute('class')).toContain('ready');
      const validate = posts(rec, '/v1/import/validate')[0];
      expect((validate!.body as { template?: { id?: string } }).template?.id).toBe('products-basic');
      const checkCode = checkCodeOf(validate!.body as object);

      // Load BEFORE asking: refused on the screen — nobody was asked — and nothing is POSTed to commit.
      await page.fill('#import-job', 'sept-price-refresh');
      expect(await clickFor(page, '#commit', 'commit-result', /nobody has been asked/)).toMatch(/^Not approved yet — nobody has been asked/);
      expect(posts(rec, '/v1/import/commit')).toHaveLength(0);

      // Ask without a reason: refused on the screen, nothing asked.
      expect(await clickFor(page, '#ask', 'ask-result', /Say why/)).toMatch(/Say why this load is needed/);
      expect(posts(rec, '/v1/approvals/requests')).toHaveLength(0);

      // Ask for approval — the uploader's OWN request: this job, this file's check code, the reason. No other person named.
      await page.fill('#import-why', 'September price list from the supplier');
      expect(await clickFor(page, '#ask', 'ask-result', /Waiting for a second person/)).toBe(
        'Asked. Waiting for a second person to approve: Load 2 rows (Products (SKU, name, price)) as "sept-price-refresh"');
      const ask = posts(rec, '/v1/approvals/requests');
      expect(ask).toHaveLength(1);
      expect(ask[0]!.body).toEqual({
        kind: 'data_import_commit', subjectRef: 'sept-price-refresh',
        details: { jobId: 'sept-price-refresh', contentFingerprint: checkCode }, valueMinor: null,
        summary: 'Load 2 rows (Products (SKU, name, price)) as "sept-price-refresh"', reason: 'September price list from the supplier',
      });
      expect(ask[0]!.headers['idempotency-key'], 'the ask carries an idempotency key').toBeTruthy();
      await page.waitForFunction(() => /Waiting for a second person/.test((globalThis as unknown as { document: { getElementById(i: string): { textContent: string | null } | null } }).document.getElementById('my-requests')?.textContent ?? ''), undefined, { timeout: 10_000 });

      // Load while it waits: refused on the screen, nothing POSTed.
      expect(await clickFor(page, '#commit', 'commit-result', /waiting for a second person/)).toMatch(/^Not approved yet — waiting for a second person/);
      expect(posts(rec, '/v1/import/commit')).toHaveLength(0);

      // A DIFFERENT person approves it, in their own session (on their Approvals page).
      decideAsSomeoneElse(rec, 'areq-1', 'approved', 'checked against the supplier letter');

      // Load — names the approved request's id; no approver, no uploader in the body.
      expect(await clickFor(page, '#commit', 'commit-result', /^Loaded\./)).toMatch(/^Loaded\. The approval has now been used/);
      const commit = posts(rec, '/v1/import/commit');
      expect(commit).toHaveLength(1);
      const body = commit[0]!.body as Record<string, unknown>;
      expect(body['jobId']).toBe('sept-price-refresh');
      expect(body['approvalId']).toBe('areq-1');
      expect(body).not.toHaveProperty('approval');
      expect(body).not.toHaveProperty('uploadedBy');
      expect(await page.locator('#commit-result').getAttribute('class')).toContain('tone-ok');
      // The list re-reads and shows the approval as used.
      await page.waitForFunction(() => /Used/.test((globalThis as unknown as { document: { getElementById(i: string): { textContent: string | null } | null } }).document.getElementById('my-requests')?.textContent ?? ''), undefined, { timeout: 10_000 });
      expect(errors).toEqual([]);
    } finally {
      await teardown();
    }
  });

  it('a REJECTED request: Load says who rejected it and why, and nothing is POSTed to commit', async () => {
    const rec: Recorder = { data: operator(IMPORTER), exports: [], approvals: [], requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      await page.waitForSelector('#import-form:not([hidden])', { timeout: 10_000 });
      await page.selectOption('#import-template', 'products-basic');
      await page.fill('#import-file', CLEAN_FILE);
      await page.fill('#import-job', 'sept-price-refresh');
      await page.fill('#import-why', 'September price list');
      await clickFor(page, '#ask', 'ask-result', /Waiting for a second person/);

      decideAsSomeoneElse(rec, 'areq-1', 'rejected', 'rice price is wrong');

      expect(await clickFor(page, '#commit', 'commit-result', /rejected it/)).toBe(
        'Not loaded — u-owner rejected it: "rice price is wrong". Fix what they said and ask again.');
      expect(await page.locator('#commit-result').getAttribute('class')).toContain('tone-error');
      expect(posts(rec, '/v1/import/commit'), 'a rejected load must not be POSTed').toHaveLength(0);
      await page.waitForFunction(() => /Rejected by u-owner: rice price is wrong/.test((globalThis as unknown as { document: { getElementById(i: string): { textContent: string | null } | null } }).document.getElementById('my-requests')?.textContent ?? ''), undefined, { timeout: 10_000 });

      // …and in Tamil, the same news carries the person and the reason.
      await page.click('#lang');
      await page.waitForFunction('document.documentElement.lang === "ta"');
      await page.click('#commit');
      await page.waitForFunction(() => /மறுத்தார்/.test((globalThis as unknown as { document: { getElementById(i: string): { textContent: string | null } | null } }).document.getElementById('commit-result-text')?.textContent ?? ''), undefined, { timeout: 10_000 });
      expect(await resultText(page, 'commit-result')).toContain('rice price is wrong');
      expect(posts(rec, '/v1/import/commit')).toHaveLength(0);
    } finally {
      await teardown();
    }
  });

  it('the file CHANGED after asking: Load says so and to ask again, and nothing is POSTed to commit', async () => {
    const rec: Recorder = { data: operator(IMPORTER), exports: [], approvals: [], requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      await page.waitForSelector('#import-form:not([hidden])', { timeout: 10_000 });
      await page.selectOption('#import-template', 'products-basic');
      await page.fill('#import-file', CLEAN_FILE);
      await page.fill('#import-job', 'sept-price-refresh');
      await page.fill('#import-why', 'September price list');
      await clickFor(page, '#ask', 'ask-result', /Waiting for a second person/);
      decideAsSomeoneElse(rec, 'areq-1', 'approved', 'fine');

      // The uploader edits a price AFTER the approval was given.
      await page.fill('#import-file', `${CLEAN_FILE.replace('45000', '49000')}`);
      expect(await clickFor(page, '#commit', 'commit-result', /changed after you asked/)).toMatch(/^Not loaded — the file .* changed after you asked\. Ask for approval again/);
      expect(posts(rec, '/v1/import/commit'), 'a changed file must not be POSTed under the old approval').toHaveLength(0);
    } finally {
      await teardown();
    }
  });
});
