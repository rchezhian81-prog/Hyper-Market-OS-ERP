import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

/**
 * **A shop-floor operator records a stock loss, in a real browser (M28-FR-01 · API-04 · §28 — the E2E matrix).**
 *
 * Every layer of the write-off capture desk — the tested write-off route + engine, the DOM-free session model,
 * the capture port — is unit- and integration-tested. The one thing units cannot prove is that an operator, in
 * an ACTUAL browser, filling the item + quantity + value + a chosen loss-type chip and clicking **"Record the
 * loss"** makes their decision reach the governed write-off route under their OWN session, and — the money/stock
 * point — that the screen refuses the wrong cases BEFORE any POST leaves the machine. This drives headless
 * Chromium against a stub cloud to prove exactly that end to end:
 *
 *   • an authorised raiser (inventory.movement.append), an IMMATERIAL loss → the record POSTs
 *     {productId, locationId, qty, uom, lossType, reasonCode, valueMinor} to /v1/inventory/write-off/:id under
 *     their own session, with the idempotency-key riding as both the URL id and the header, and no invented
 *     evidence or approver; the result strip shows and the form clears for the next loss;
 *   • a MATERIAL loss (at/above the injected store limit) with NO evidence → refused CLIENT-SIDE, nothing sent;
 *   • a MATERIAL loss with evidence but NO separate approver → refused client-side, nothing sent (§28);
 *   • a MATERIAL loss the raiser tries to approve THEMSELVES → refused client-side, nothing sent (§28);
 *   • a MATERIAL loss with evidence AND a separate approver → POSTs, carrying evidenceRef + approvedBy;
 *   • a user WITHOUT the permission → the form is not even rendered, and NOTHING is sent.
 *
 * The browser binary is the environment's pre-installed Chromium; where none is present the suite SKIPS rather
 * than failing, exactly like the loss-prevention close-delivery suite it mirrors.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';

/** ₹500 — the material-loss line, injected as the tenant policy (the server enforces the same number). */
const THRESHOLD_MINOR = 50000;

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly idempotencyKey: string | undefined;
  readonly body: Record<string, unknown> | undefined;
}

interface Recorder {
  writeOffCaptureData: Record<string, unknown>;
  /** The HTTP status the stub write-off route answers with (201 records, 409 duplicate, 422 governance…). */
  postStatus: number;
  /** A 422's error code, so the port can map it (write_off_needs_evidence, approver_may_not_approve…). */
  postErrorCode: string | undefined;
  readonly requests: Recorded[];
}

/** A server that BOTH serves the shell (GET, operator context injected) AND answers the governed write-off route
 *  (POST /v1/inventory/write-off/:id) on the SAME origin, so `credentials: 'same-origin'` and a relative
 *  `/v1/...` reach it exactly as in production. It records the method, path, idempotency-key header and body of
 *  everything it is sent, so a test can prove what left the browser — and, crucially, what did NOT. */
async function startShellAndCloud(rec: Recorder): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      if (req.method === 'POST' && path.startsWith('/v1/inventory/write-off/')) {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8');
        const key = req.headers['idempotency-key'];
        rec.requests.push({
          method: 'POST', path,
          idempotencyKey: Array.isArray(key) ? key[0] : key,
          body: raw === '' ? undefined : (JSON.parse(raw) as Record<string, unknown>),
        });
        res.writeHead(rec.postStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify(rec.postStatus === 201 ? { writeOffId: path.split('/').pop() } : { error: rec.postErrorCode ?? 'refused' }));
        return;
      }
      const file = path === '/' || path === '/write-off-capture' ? 'write-off-capture.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
        let body = buf.toString('utf8');
        if (file.endsWith('.html')) {
          const inject = `<script>window.writeOffCaptureData = ${JSON.stringify(rec.writeOffCaptureData).replace(/</g, '\\u003c')};</script>`;
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

const operator = (permissions: readonly string[]): Record<string, unknown> => ({
  userId: 'u-raiser', permissions, materialThresholdMinor: THRESHOLD_MINOR,
});

const posts = (rec: Recorder): Recorded[] => rec.requests.filter((r) => r.method === 'POST');

describe.skipIf(!HAVE_BROWSER)('a shop-floor operator records a stock loss, end to end in a real browser (M28-FR-01)', () => {
  let browser: Browser;

  beforeAll(async () => {
    // Build the CURRENT web-erp bundle so the browser runs this branch's code, not a stale artifact.
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  /** Open the screen and wait for the capture form (or, for a no-permission user, the not-permitted state). */
  const openScreen = async (rec: Recorder, expectForm: boolean) => {
    const srv = await startShellAndCloud(rec);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    if (expectForm) await page.waitForSelector('#capturer:not([hidden])', { timeout: 10_000 });
    else await page.waitForSelector('#state:not([hidden])', { timeout: 10_000 });
    return { srv, context, page, teardown: async () => { await context.close(); await srv.stop(); } };
  };

  /** Fill the loss form: the item, where, how many, its value (in ₹), and the chosen loss-type chip. */
  const fillLoss = async (
    page: import('playwright-core').Page,
    over: { product?: string; location?: string; qty?: string; valueRupees?: string; lossLabel?: string; evidence?: string; approver?: string } = {},
  ) => {
    await page.fill('#wo-product', over.product ?? 'P-milk-1L');
    await page.fill('#wo-location', over.location ?? 'aisle-3');
    await page.fill('#wo-qty', over.qty ?? '2');
    await page.fill('#wo-value', over.valueRupees ?? '100');
    await page.locator('#loss-types button.chip', { hasText: over.lossLabel ?? 'Damage' }).click();
    if (over.evidence !== undefined) await page.fill('#wo-evidence', over.evidence);
    if (over.approver !== undefined) await page.fill('#wo-approver', over.approver);
  };

  it('an authorised raiser records an immaterial loss — it POSTs to the write-off route, and the form clears', async () => {
    const rec: Recorder = { writeOffCaptureData: operator(['inventory.movement.append']), postStatus: 201, postErrorCode: undefined, requests: [] };
    const { page, teardown } = await openScreen(rec, true);
    try {
      await fillLoss(page, { valueRupees: '100', lossLabel: 'Damage' }); // ₹100 < ₹500 → immaterial
      await page.click('#record');
      await page.waitForSelector('#result:not([hidden])', { timeout: 10_000 });

      const sent = posts(rec);
      expect(sent.length, 'exactly one write-off was POSTed').toBe(1);
      const post = sent[0]!;
      expect(post.path.startsWith('/v1/inventory/write-off/')).toBe(true);
      // The operation identity rides as BOTH the URL id and the idempotency-key header (a re-send records once).
      const urlId = post.path.split('/').pop();
      expect(post.idempotencyKey, 'the idempotency-key header is the URL id').toBe(urlId);
      expect((urlId ?? '').length, 'a real operation id was minted').toBeGreaterThan(0);

      // The body carries the operator's choices — and no invented evidence or approver for a small loss.
      expect(post.body).toMatchObject({
        productId: 'P-milk-1L', locationId: 'aisle-3', qty: 2, uom: 'ea',
        lossType: 'damage', reasonCode: 'damage', valueMinor: 10000,
      });
      expect('writeOffId' in (post.body ?? {}), 'the id is in the URL, not the body').toBe(false);
      expect('evidenceRef' in (post.body ?? {}), 'a small loss invents no evidence').toBe(false);
      expect('approvedBy' in (post.body ?? {}), 'a small loss invents no approver').toBe(false);

      // On success the form clears for the next loss.
      expect(await page.locator('#wo-product').inputValue()).toBe('');
      expect(await page.locator('#result').getAttribute('hidden')).toBeNull();
    } finally {
      await teardown();
    }
  });

  it('a MATERIAL loss with NO evidence is refused client-side — nothing is sent', async () => {
    const rec: Recorder = { writeOffCaptureData: operator(['inventory.movement.append']), postStatus: 201, postErrorCode: undefined, requests: [] };
    const { page, teardown } = await openScreen(rec, true);
    try {
      await fillLoss(page, { valueRupees: '600', lossLabel: 'Damage' }); // ₹600 ≥ ₹500 → material, no evidence
      await page.click('#record');
      await page.waitForSelector('#result:not([hidden])', { timeout: 10_000 });
      expect(posts(rec).length, 'a material loss with no evidence must not leave the machine').toBe(0);
    } finally {
      await teardown();
    }
  });

  it('a MATERIAL loss with evidence but NO separate approver is refused client-side (§28) — nothing is sent', async () => {
    const rec: Recorder = { writeOffCaptureData: operator(['inventory.movement.append']), postStatus: 201, postErrorCode: undefined, requests: [] };
    const { page, teardown } = await openScreen(rec, true);
    try {
      await fillLoss(page, { valueRupees: '600', lossLabel: 'Damage', evidence: 'photo-2026-09-20' });
      await page.click('#record');
      await page.waitForSelector('#result:not([hidden])', { timeout: 10_000 });
      expect(posts(rec).length, 'a material loss with no approver must not leave the machine').toBe(0);
    } finally {
      await teardown();
    }
  });

  it('a MATERIAL loss the raiser tries to approve THEMSELVES is refused client-side (§28) — nothing is sent', async () => {
    const rec: Recorder = { writeOffCaptureData: operator(['inventory.movement.append']), postStatus: 201, postErrorCode: undefined, requests: [] };
    const { page, teardown } = await openScreen(rec, true);
    try {
      // The operator is u-raiser; naming themselves as approver is a §28 breach, refused before any POST.
      await fillLoss(page, { valueRupees: '600', lossLabel: 'Damage', evidence: 'photo-2026-09-20', approver: 'u-raiser' });
      await page.click('#record');
      await page.waitForSelector('#result:not([hidden])', { timeout: 10_000 });
      expect(posts(rec).length, 'the raiser approving their own loss must not leave the machine').toBe(0);
    } finally {
      await teardown();
    }
  });

  it('a MATERIAL loss with evidence AND a separate approver POSTs — carrying evidenceRef and approvedBy', async () => {
    const rec: Recorder = { writeOffCaptureData: operator(['inventory.movement.append']), postStatus: 201, postErrorCode: undefined, requests: [] };
    const { page, teardown } = await openScreen(rec, true);
    try {
      await fillLoss(page, { valueRupees: '600', lossLabel: 'Damage', evidence: 'photo-2026-09-20', approver: 'u-manager' });
      await page.click('#record');
      await page.waitForSelector('#result:not([hidden])', { timeout: 10_000 });

      const sent = posts(rec);
      expect(sent.length).toBe(1);
      expect(sent[0]!.body).toMatchObject({
        productId: 'P-milk-1L', locationId: 'aisle-3', qty: 2, uom: 'ea',
        lossType: 'damage', reasonCode: 'damage', valueMinor: 60000,
        evidenceRef: 'photo-2026-09-20', approvedBy: 'u-manager',
      });
    } finally {
      await teardown();
    }
  });

  it('a user WITHOUT the permission sees no form and sends NOTHING', async () => {
    const rec: Recorder = { writeOffCaptureData: operator([]), postStatus: 201, postErrorCode: undefined, requests: [] };
    const { page, teardown } = await openScreen(rec, false);
    try {
      // The capture form is not rendered at all — the not-permitted state is shown instead.
      expect(await page.locator('#capturer').getAttribute('hidden')).not.toBeNull();
      expect(await page.locator('#state').getAttribute('hidden')).toBeNull();
      expect(posts(rec).length, 'a user who cannot record a loss sends nothing').toBe(0);
    } finally {
      await teardown();
    }
  });
});
