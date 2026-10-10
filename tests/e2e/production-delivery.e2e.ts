import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

/**
 * **The QC operator releases a finished batch for sale, in a real browser (M11-FR-03 · API-04 · §28 — the E2E matrix).**
 *
 * Every layer of the production quality-release desk — the tested session model, the release port, the board
 * fold — is unit- and integration-tested. The one thing units cannot prove is that a QC operator, in an ACTUAL
 * browser, seeing a finished batch still in quarantine and clicking **"Release for sale"**, makes that decision
 * reach the cloud under their OWN session, and that the batch then drops off the board. This drives headless
 * Chromium against a stub cloud to prove exactly that end to end:
 *
 *   • an authorised QC operator (production.read + production.release) → clicking Release POSTs
 *     {qcPassed:true} to /v1/production/runs/:runId/release under their own session; the batch then drops off
 *     the board once it is re-READ (the server now folds it released:true — a re-derive, never a client shuffle);
 *   • a read-only user (production.read only) → sees the board but is offered NO release/hold buttons, so no
 *     write can even be started (P-04 least privilege: the server re-checks too, but the screen never offers it).
 *
 * Freshly-made food is not for sale because it exists; it is for sale when a human has looked at it and released
 * it (hard rule #5 — no AI releases food for sale). The board is read live from a single GET
 * (/v1/production/runs), exactly as in production. The browser binary is the environment's pre-installed
 * Chromium; where none is present the suite SKIPS rather than failing, exactly like the rostering delivery suite
 * it mirrors.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';

interface BrowserGlobals {
  readonly document: {
    querySelectorAll(selector: string): { readonly length: number };
  };
}

/** One finished bakery batch still in quarantine — a real, releasable run. The board hands back its full shape;
 *  once released, the server folds it `released: true`, so the screen (which shows only un-released runs) drops
 *  it on the next read. */
const RUN_ID = 'run-loaf';
const RUN = {
  runId: RUN_ID, departmentId: 'bakery', outputProductId: 'p-loaf', outputBatchId: 'B-run-loaf',
  outputQuantityMinor: 12000, outputUom: 'ea', expiresAt: '2026-09-28T00:00:00.000Z',
  outputUnitCostMinor: 25000, currency: 'INR', costKnown: true, uncostedProducts: [],
  yieldVerdict: 'as_expected', exceptions: [], released: false,
};

interface Recorder {
  productionData: Record<string, unknown>;
  releaseStatus: number;
  released: boolean;
  readonly requests: { method: string; path: string; body: unknown; idempotencyKey?: string | undefined }[];
  /** FUL-13: how the run and label routes answer (201/200 or a refusal), and the runs recorded so far. */
  runStatus?: number;
  labelStatus?: number;
  extraRuns?: Record<string, unknown>[];
}

/** A server that BOTH serves the shell (GET, operator context injected) AND answers the two routes the desk
 *  touches — the release POST (runId in the URL) and the read-only board GET (/v1/production/runs) — on the SAME
 *  origin, so `credentials: 'same-origin'` and a relative `/v1/...` reach it exactly as in production. Once a
 *  release is recorded, the board returns the run folded `released: true`, so a released batch drops off on
 *  re-read (a server re-derive, never a client-side shuffle). */
async function startShellAndCloud(rec: Recorder): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      // FUL-13: the staff's task routes — record a run, print a label — answered as the real routes answer.
      if (req.method === 'POST' && /^\/v1\/production\/runs\/[^/]+(\/label)?$/.test(path)) {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = raw === '' ? {} : JSON.parse(raw) as Record<string, unknown>;
        const key = req.headers['idempotency-key'];
        rec.requests.push({ method: 'POST', path, body, idempotencyKey: typeof key === 'string' ? key : undefined });
        const runId = decodeURIComponent(path.split('/')[4] ?? '');
        if (path.endsWith('/label')) {
          const status = rec.labelStatus ?? 200;
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(status < 300
            ? { runId, batchId: 'B-run-loaf', lines: [String(body['productName']), 'Batch: B-run-loaf', 'Use by: 2026-09-28', `MRP: Rs ${(Number(body['priceMinor']) / 100).toFixed(2)}`] }
            : { error: { code: 'incomplete_label', whatHappened: 'The cafe label needs an allergen declaration (food safety).', wasItSaved: 'not_saved', nextSafeAction: 'Add it.' } }));
          return;
        }
        const status = rec.runStatus ?? 201;
        if (status < 300) (rec.extraRuns ??= []).push({ ...RUN, runId, outputBatchId: String(body['outputBatchId']), outputProductId: 'p-cake', released: false });
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(status < 300 ? { runId } : { error: { code: 'insufficient_input', whatHappened: 'Only 300 g of FLOUR is on hand; the run needs 400 g.', wasItSaved: 'not_saved', nextSafeAction: 'Receive more flour.' } }));
        return;
      }
      if (req.method === 'POST' && path.startsWith('/v1/production/runs/') && path.endsWith('/release')) {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8');
        rec.requests.push({ method: 'POST', path, body: raw === '' ? undefined : JSON.parse(raw) });
        if (rec.releaseStatus >= 200 && rec.releaseStatus < 300) rec.released = true;
        res.writeHead(rec.releaseStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ run: { ...RUN, released: rec.released } }));
        return;
      }
      if (req.method === 'GET' && path === '/v1/production/runs') {
        rec.requests.push({ method: 'GET', path, body: undefined });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ runs: [{ ...RUN, released: rec.released }, ...(rec.extraRuns ?? [])], asAt: '2026-09-22T00:00:00.000Z' }));
        return;
      }
      const file = path === '/' || path === '/production' ? 'production.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        let body = buf.toString('utf8');
        if (file.endsWith('.html')) {
          const inject = `<script>window.productionData = ${JSON.stringify(rec.productionData).replace(/</g, '\\u003c')};</script>`;
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

const operator = (userId: string, permissions: readonly string[]): Record<string, unknown> => ({
  userId, permissions,
});

describe.skipIf(!HAVE_BROWSER)('the QC operator releases a batch for sale, end to end in a real browser (M11-FR-03)', () => {
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
    // The board is read live on load (one GET), so the batch only appears once the read resolves.
    await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rows .row').length > 0, undefined, { timeout: 10_000 });
    return { srv, context, page, teardown: async () => { await context.close(); await srv.stop(); } };
  };

  it('an authorised QC operator: clicking Release POSTs {qcPassed:true}, and the batch drops off on re-read', async () => {
    const rec: Recorder = { productionData: operator('u-qc', ['production.read', 'production.release']), releaseStatus: 200, released: false, requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      expect(await page.locator('#rows .row').count()).toBe(1);
      // The release/hold buttons are offered (the operator holds production.release).
      expect(await page.locator('#rows button.release').count()).toBe(1);
      expect(await page.locator('#rows button.hold').count()).toBe(1);

      await page.click('#rows button.release');

      // The batch drops off because the board was re-READ (server re-derive: it now folds released:true),
      // not shuffled client-side.
      await page.waitForFunction(
        () => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rows .row').length === 0,
        undefined, { timeout: 10_000 },
      );
      const post = rec.requests.find((r) => r.method === 'POST' && r.path === `/v1/production/runs/${RUN_ID}/release`);
      expect(post, 'the release was not POSTed to the run/release URL').toBeDefined();
      expect((post!.body as { qcPassed?: boolean }).qcPassed).toBe(true);

      // The board read runs at least twice: once on load, once after the release to re-derive.
      expect(rec.requests.filter((r) => r.method === 'GET' && r.path === '/v1/production/runs').length).toBeGreaterThanOrEqual(2);
      expect(await page.locator('#rows .row').count()).toBe(0);
      expect(await page.locator('#result').getAttribute('hidden')).toBeNull();
    } finally {
      await teardown();
    }
  });

  it('FUL-13 · the production staff record a run: exactly { recipeId, batches, actualOutputMinor, outputBatchId, locationId } under the run id, and the new batch appears on the board to release and to label', async () => {
    const rec: Recorder = { productionData: { ...operator('u-chef', ['production.read', 'production.plan.commit', 'production.recipe.manage']), productionLocationId: 'KITCHEN' }, releaseStatus: 200, released: false, requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      await page.waitForSelector('#runner:not([hidden])');
      expect(await page.inputValue('#run-location')).toBe('KITCHEN'); // the store computer's kitchen, pre-filled
      // A number that is not whole is refused on the screen; nothing is sent.
      await page.fill('#run-recipe', 'cake');
      await page.fill('#run-batches', '2.5');
      await page.fill('#run-output', '2');
      await page.fill('#run-batch', 'CAKE-11');
      await page.click('#run');
      await page.waitForSelector('#result:not([hidden])');
      expect((await page.textContent('#result-text')) ?? '').toContain('whole numbers');
      expect(rec.requests.filter((r) => r.method === 'POST')).toHaveLength(0);

      await page.fill('#run-batches', '2');
      await page.click('#run');
      await page.waitForFunction(() => ((globalThis as unknown as { document: { getElementById(id: string): { textContent: string | null } | null } }).document.getElementById('result-text')?.textContent ?? '').includes('Run recorded'), undefined, { timeout: 10_000 });
      const post = rec.requests.find((r) => r.method === 'POST' && /^\/v1\/production\/runs\/[^/]+$/.test(r.path))!;
      expect(post.body).toEqual({ recipeId: 'cake', batches: 2, actualOutputMinor: 2, outputBatchId: 'CAKE-11', locationId: 'KITCHEN' });
      expect(post.idempotencyKey).toBe(`run-${post.path.split('/')[4]}`);
      // The board is re-read: the new batch waits to be released AND can be labelled.
      await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rows .row').length === 2, undefined, { timeout: 10_000 });
      expect(await page.$$eval('#label-run option', (els) => els.map((e) => (e as unknown as { textContent: string }).textContent))).toContain('p-cake · CAKE-11');
      // No release control: this person makes food, they do not release it (§28).
      expect(await page.locator('#rows button.release').count()).toBe(0);

      // A cloud refusal is shown in its own words and never claimed as recorded.
      rec.runStatus = 422;
      await page.fill('#run-recipe', 'cake');
      await page.fill('#run-batches', '4');
      await page.fill('#run-output', '4');
      await page.fill('#run-batch', 'CAKE-12');
      await page.click('#run');
      await page.waitForFunction(() => ((globalThis as unknown as { document: { getElementById(id: string): { textContent: string | null } | null } }).document.getElementById('result-text')?.textContent ?? '').includes('Only 300 g of FLOUR'), undefined, { timeout: 10_000 });
    } finally {
      await teardown();
    }
  });

  it('FUL-13 · printing a label: the batch comes from the board, the price is exact paise, allergens a list; the rendered label shows; a missing legal field is refused in head office\'s words', async () => {
    const rec: Recorder = { productionData: operator('u-chef', ['production.read', 'production.recipe.manage']), releaseStatus: 200, released: false, requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      await page.waitForSelector('#labeller:not([hidden])');
      expect(await page.isHidden('#runner')).toBe(true);
      expect(((await page.textContent('#no-run')) ?? '').length).toBeGreaterThan(0);
      await page.selectOption('#label-run', 'run-loaf');
      await page.fill('#label-name', 'Brown loaf');
      await page.fill('#label-net', '400 g');
      await page.fill('#label-packer', 'SRE Hyper Market, TN');
      await page.fill('#label-price', '45.50');
      await page.fill('#label-allergens', 'wheat, milk');
      await page.click('#label');
      await page.waitForSelector('#label-out:not([hidden])', { timeout: 10_000 });
      const sent = rec.requests.find((r) => r.method === 'POST' && r.path === '/v1/production/runs/run-loaf/label')!;
      expect(sent.body).toEqual({ productName: 'Brown loaf', netQuantity: '400 g', packerDetails: 'SRE Hyper Market, TN', priceMinor: 4_550, allergens: ['wheat', 'milk'] });
      const printed = (await page.textContent('#label-out')) ?? '';
      expect(printed).toContain('Brown loaf');
      expect(printed).toContain('B-run-loaf');
      expect(printed).toContain('Rs 45.50');

      rec.labelStatus = 422;
      await page.click('#label');
      await page.waitForFunction(() => ((globalThis as unknown as { document: { getElementById(id: string): { textContent: string | null } | null } }).document.getElementById('result-text')?.textContent ?? '').includes('allergen declaration'), undefined, { timeout: 10_000 });
      expect(await page.isHidden('#label-out')).toBe(true);
    } finally {
      await teardown();
    }
  });

  it('a read-only user sends NOTHING — no release/hold buttons are rendered', async () => {
    const rec: Recorder = { productionData: operator('u-readonly', ['production.read']), releaseStatus: 200, released: false, requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      expect(await page.locator('#rows .row').count()).toBe(1); // they can see the board
      expect(await page.locator('#rows button.release').count()).toBe(0); // but no way to release
      expect(await page.locator('#rows button.hold').count()).toBe(0);
      expect(rec.requests.some((r) => r.method === 'POST')).toBe(false);
    } finally {
      await teardown();
    }
  });
});
