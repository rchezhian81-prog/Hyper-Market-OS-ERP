import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

/**
 * **A supplier reads its own account, in a real browser (M24-FR-01 · API-03 · §35 — the E2E matrix).**
 *
 * Every layer of the supplier portal — the tested `createSupplierPortalSession`, the served page, the browser
 * read fetches — is unit- and integration-tested. The one thing units cannot prove is that a supplier, in an
 * ACTUAL browser, opening the portal sees what it sent us still WAITING on us at the top, sees its statement,
 * and that the screen never writes a thing. This drives headless Chromium against a stub cloud to prove exactly
 * that end to end:
 *
 *   • an authorised supplier login (supplier.portal.self) → both feeds read LIVE on load, the submission still
 *     AWAITING our decision leads (never a false "accepted" — §28), the statement panel shows the closing
 *     balance with the disputed amount kept separate, and across the whole session NOT ONE write verb
 *     (POST/PUT/PATCH/DELETE) leaves the screen unless the supplier sends the one form;
 *   • OB-362: the "Delivery update" form lists only the supplier's own open orders, refuses on the page before anything is
 *     sent, and sends exactly ONE `delivery_status` submission; a login without the grant is told so;
 *   • a login WITHOUT supplier.portal.self → sees the not-a-supplier-login state and NONE of the account data,
 *     even though the feeds exist (the server also answers 403 — defence in depth, P-04/§35).
 *
 * The two feeds are read exactly as in production — `GET /v1/supplier-portal/me/{submissions,statement}` — over
 * `credentials: 'same-origin'` on the same origin that serves the page, each scoped to the caller's OWN partner
 * id ON THE SERVER (the browser has no partner id to send). The supplier portal is CLOUD-served (its own app
 * bundle), so the e2e serves apps/supplier-app/web the same way the cloud web tier would. The browser binary is
 * the environment's pre-installed Chromium; where none is present the suite SKIPS rather than failing.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/supplier-app/web';

interface BrowserGlobals {
  readonly document: {
    querySelectorAll(selector: string): { readonly length: number };
    getElementById(id: string): { readonly hidden: boolean } | null;
  };
}

/** What the supplier sent us: one invoice STILL awaiting our decision (must lead), one processed acknowledgement. */
const SUBMISSIONS = [
  { submissionId: 'sub-ack', kind: 'po_acknowledgement', requiresReview: false, receivedAt: '2026-09-18T09:00:00Z' },
  { submissionId: 'sub-inv', kind: 'invoice', requiresReview: true, receivedAt: '2026-09-21T09:00:00Z' },
  // OB-288 commercial desks (M24-FR-02): a delivery update the supplier sent — processed (nobody reviews it), named as such.
  { submissionId: 'sub-ds', kind: 'delivery_status', requiresReview: false, receivedAt: '2026-09-20T09:00:00Z' },
];

/** The supplier's statement — ₹3,000 outstanding, ₹500 disputed shown separately, reconciling. */
const STATEMENT = {
  partnerId: 'p-acme', accessible: true, openingMinor: 0, invoicedMinor: 500000, debitedMinor: 0,
  creditedMinor: 0, paidMinor: 200000, closingMinor: 300000, disputedMinor: 50000, reconciles: true,
  detail: '300000 outstanding; 50000 disputed shown separately',
};

interface Recorder {
  supplierData: Record<string, unknown>;
  mayRead: boolean;
  readonly requests: { method: string; path: string; body?: unknown }[];
  /** OB-362: whether this login may send a delivery update (the order-communication grant). */
  mayUpdate?: boolean;
}

/** OB-362: the supplier's own open orders, as `/me/orders` answers (scoped on the server — never another supplier's). */
const ORDERS = [
  { poId: 'po-a1', number: 'PO-000001', issuedAt: '2026-10-20T09:00:00Z', deliverToLocationId: 'br-1', lines: 1 },
  // OB-606: issued at 19:30 UTC on the 21st — 01:00 on the 22nd in the shop; the portal shows the SHOP's date of issue.
  { poId: 'po-a3', number: 'PO-000003', issuedAt: '2026-10-21T19:30:00Z', deliverToLocationId: 'br-1', lines: 2 },
];

/** D03-FR-03 · OB-404: two claims the shop SENT this supplier — one waiting with no due day set yet, one partly paid. */
const REBATE_CLAIMS = [
  { claimId: 'RC-1', schemeId: 'rb-1', amountMinor: 150000, sentOn: '2026-10-27', answerDueOn: null, paidMinor: 0, leftToPayMinor: 150000, state: 'sent' },
  { claimId: 'RC-0', schemeId: 'rb-1', amountMinor: 90000, sentOn: '2026-09-01', answerDueOn: '2026-10-01', paidMinor: 40000, leftToPayMinor: 50000, state: 'partly_answered' },
];

/** A server that serves the supplier-app page AND answers the two read-only feeds on the SAME origin, so a
 *  relative `/v1/...` with `credentials: 'same-origin'` reaches it exactly as in production. A login without the
 *  supplier.portal.self grant is refused (403), the same re-check the real server runs (§35). */
async function startPageAndCloud(rec: Recorder): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      const feed = (payload: unknown) => {
        rec.requests.push({ method: req.method ?? 'GET', path });
        if (!rec.mayRead) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'not_a_supplier_login' } })); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.method === 'GET' && path === '/v1/supplier-portal/me/submissions') {
        feed({ partnerId: STATEMENT.partnerId, submissions: SUBMISSIONS, asAt: '2026-09-22T00:00:00.000Z' });
        return;
      }
      if (req.method === 'GET' && path === '/v1/supplier-portal/me/statement') {
        feed(STATEMENT);
        return;
      }
      if (req.method === 'GET' && path === '/v1/supplier-portal/me/orders') {
        feed({ partnerId: STATEMENT.partnerId, ordersKnown: true, orders: ORDERS, mayUpdate: rec.mayUpdate === true, deliveryStatuses: ['dispatched', 'in_transit', 'delayed'] });
        return;
      }
      // D03-FR-03 · OB-404: the rebate claims the shop has sent this supplier (read only; scoped on the server).
      if (req.method === 'GET' && path === '/v1/supplier-portal/me/rebate-claims') {
        feed({ partnerId: STATEMENT.partnerId, claimsKnown: true, claims: REBATE_CLAIMS, asAt: '2026-10-27T00:00:00.000Z' });
        return;
      }
      // OB-362: the ONE write — the delivery update, recorded with its body (the server re-checks the order is this supplier's).
      if (req.method === 'POST' && path === '/v1/supplier-portal/me/submissions') {
        let raw = '';
        for await (const chunk of req) raw += String(chunk);
        const body = JSON.parse(raw) as { submissionId: string; kind: string; document: { poId: string } };
        rec.requests.push({ method: 'POST', path, body });
        const own = ORDERS.some((o) => o.poId === body.document?.poId);
        res.writeHead(own ? 201 : 422, { 'content-type': 'application/json' });
        res.end(JSON.stringify(own ? { submissionId: body.submissionId, kind: body.kind, accepted: true } : { error: { code: 'not_your_order', whatHappened: 'that order belongs to another supplier' } }));
        return;
      }
      if (req.method !== 'GET') rec.requests.push({ method: req.method ?? '?', path }); // any write would be caught here

      const file = path === '/' || path === '/index.html' ? 'index.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.webmanifest') ? 'application/manifest+json' : 'application/octet-stream';
        let body = buf.toString('utf8');
        if (file.endsWith('.html')) {
          const inject = `<script>window.supplierData = ${JSON.stringify(rec.supplierData).replace(/</g, '\\u003c')};</script>`;
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

const login = (userId: string, permissions: readonly string[]): Record<string, unknown> => ({ userId, permissions });

describe.skipIf(!HAVE_BROWSER)('a supplier reads its own account end to end in a real browser (M24-FR-01)', () => {
  let browser: Browser;

  beforeAll(async () => {
    // Build the CURRENT supplier-app bundle so the browser runs this branch's code, not a stale artifact.
    execFileSync('node', ['scripts/build-app.mjs', 'supplier-app'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it('an authorised supplier sees the awaiting submission first and its statement — and writes nothing', async () => {
    const rec: Recorder = { supplierData: login('u-acme', ['supplier.portal.self']), mayRead: true, requests: [] };
    const srv = await startPageAndCloud(rec);
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${srv.base}/`, { waitUntil: 'load' });

      // The feeds are read LIVE on load, so the rows only appear once those reads resolve.
      await page.waitForFunction(
        () => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#awaiting li.row').length > 0,
        undefined, { timeout: 10_000 },
      );
      // The submission still AWAITING our decision leads — never a false "accepted" (§28).
      expect(await page.locator('#awaiting li.row').count()).toBe(1);
      expect(await page.locator('#awaiting li.row').first().innerText()).toContain('sub-inv');
      expect(await page.locator('#processed li.row').count()).toBe(2); // the acknowledgement we processed, and the delivery update
      expect(await page.locator('#processed').innerText()).toContain('Delivery update'); // named as what it is, never read as an invoice

      // The statement panel shows the closing balance and keeps the disputed amount separate.
      expect(await page.locator('#statement').getAttribute('hidden')).toBeNull();
      const statementText = await page.locator('#statement').innerText();
      expect(statementText).toContain('₹3,000.00'); // outstanding
      expect(statementText).toContain('₹500.00');    // disputed, shown separately

      // Every request the portal made was a READ. Not one write verb left the screen.
      expect(rec.requests.length).toBeGreaterThan(0);
      expect(rec.requests.every((r) => r.method === 'GET')).toBe(true);
      expect(rec.requests.some((r) => r.path === '/v1/supplier-portal/me/submissions')).toBe(true);
      expect(rec.requests.some((r) => r.path === '/v1/supplier-portal/me/statement')).toBe(true);
    } finally {
      await context.close();
      await srv.stop();
    }
  });

  it('D03-FR-03 · OB-404: the rebate claims the shop sent it — amount, due day ("not set" when the shop has not set it), paid and still to pay — read only, in Tamil too', async () => {
    const rec: Recorder = { supplierData: login('u-acme', ['supplier.portal.self']), mayRead: true, requests: [] };
    const srv = await startPageAndCloud(rec);
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(`${srv.base}/`, { waitUntil: 'load' });
      await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rebates-rows li.row').length === 2, undefined, { timeout: 10_000 });
      expect(await page.textContent('#rebates-h')).toBe('Rebate claims from us');
      const waiting = await page.locator('#rebates-rows li[data-claim="RC-1"]').innerText();
      expect(waiting).toContain('Waiting for your payment');
      expect(waiting).toContain('₹1,500.00');
      expect(waiting).toContain('due not set');
      const partly = await page.locator('#rebates-rows li[data-claim="RC-0"]').innerText();
      expect(partly).toContain('Partly paid');
      expect(partly).toContain('due 2026-10-01');
      expect(partly).toContain('still to pay ₹500.00');
      await page.click('#lang');
      expect(await page.textContent('#rebates-h')).toBe('எங்களிடமிருந்து தள்ளுபடிக் கோரிக்கைகள்');
      expect(rec.requests.some((r) => r.path === '/v1/supplier-portal/me/rebate-claims')).toBe(true);
      expect(rec.requests.every((r) => r.method === 'GET'), 'reading the claims writes nothing').toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
      await srv.stop();
    }
  });

  it('OB-362: the Delivery update form names only its own open orders, refuses before sending, and sends ONE delivery_status — in English and Tamil', async () => {
    const rec: Recorder = { supplierData: login('u-acme', ['supplier.portal.self', 'supplier.portal.self.submit']), mayRead: true, mayUpdate: true, requests: [] };
    const srv = await startPageAndCloud(rec);
    // OB-606: the supplier's device is in New York, not India — an order's date is still the shop's date of issue.
    const context = await browser.newContext({ timezoneId: 'America/New_York' });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(`${srv.base}/`, { waitUntil: 'load' });
      await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.getElementById('du-form')?.hidden === false, undefined, { timeout: 10_000 });
      expect(await page.textContent('#delivery-h')).toBe('Delivery update');
      // Its own open orders only (plus the "choose" prompt) — the server scoped them; the page adds none.
      expect(await page.locator('#du-order option').allTextContents()).toEqual(['Choose one of your open orders', 'PO-000001 · 2026-10-20', 'PO-000003 · 2026-10-22']);
      expect(await page.locator('#du-status option').allTextContents()).toEqual(['—', 'Dispatched', 'On the way', 'Delayed']);
      expect(await page.locator('#du-send svg.sre-icon').count()).toBe(1);
      for (const id of ['du-order', 'du-status', 'du-expected', 'du-note']) expect(await page.locator(`label[for="${id}"]`).count(), id).toBe(1);
      // Refused on the page before anything is sent.
      await page.click('#du-send');
      expect(await page.textContent('#du-result')).toBe('⚠ Choose your order first. Nothing was sent.');
      await page.selectOption('#du-order', 'po-a3');
      await page.click('#du-send');
      expect(await page.textContent('#du-result')).toBe('⚠ Say where it has got to. Nothing was sent.');
      await page.selectOption('#du-status', 'delayed');
      await page.click('#du-send');
      expect(await page.textContent('#du-result')).toBe('⚠ Give the day it should now arrive. Nothing was sent.');
      expect(rec.requests.filter((r) => r.method !== 'GET')).toEqual([]);
      await page.fill('#du-expected', '2026-10-28');
      await page.fill('#du-note', 'rain on the highway');
      await page.click('#du-send');
      await page.locator('#du-result[data-result="sent"]').waitFor({ timeout: 10_000 });
      expect(await page.textContent('#du-result')).toBe('✓ Sent — the buyer can see it.');
      // Exactly ONE write left the screen: the delivery_status submission, to the supplier's own route.
      const writes = rec.requests.filter((r) => r.method !== 'GET');
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({ method: 'POST', path: '/v1/supplier-portal/me/submissions', body: { kind: 'delivery_status', document: { poId: 'po-a3', status: 'delayed', expectedOn: '2026-10-28', note: 'rain on the highway' } } });
      expect((writes[0]!.body as { submissionId: string }).submissionId).toMatch(/^ds-po-a3-/);
      // Tamil.
      await page.click('#lang');
      expect(await page.textContent('#delivery-h')).toBe('டெலிவரி நிலவரம்');
      expect(await page.textContent('#du-send-text')).toBe('டெலிவரி நிலவரத்தை அனுப்பு');
      expect(errors).toEqual([]);
    } finally {
      await context.close();
      await srv.stop();
    }
  });

  it('OB-362: a login without the order-communication grant is told so and offered no form', async () => {
    const rec: Recorder = { supplierData: login('u-acme-view', ['supplier.portal.self']), mayRead: true, mayUpdate: false, requests: [] };
    const srv = await startPageAndCloud(rec);
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${srv.base}/`, { waitUntil: 'load' });
      await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.getElementById('du-said')?.hidden === false, undefined, { timeout: 10_000 });
      expect(await page.textContent('#du-said')).toBe('Your login cannot send delivery updates. Ask us to turn it on.');
      expect(await page.locator('#du-form').getAttribute('hidden')).not.toBeNull();
      expect(rec.requests.every((r) => r.method === 'GET')).toBe(true);
    } finally {
      await context.close();
      await srv.stop();
    }
  });

  it('a login without supplier.portal.self sees the account refused — no data, and the server answers 403', async () => {
    const rec: Recorder = { supplierData: login('u-stranger', []), mayRead: false, requests: [] };
    const srv = await startPageAndCloud(rec);
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${srv.base}/`, { waitUntil: 'load' });
      // The screen refuses on first paint (client-side mayRead is false); it stays refused after the load reads.
      await page.waitForFunction(
        () => (globalThis as unknown as BrowserGlobals).document.getElementById('state')?.hidden === false,
        undefined, { timeout: 10_000 },
      );
      expect(await page.locator('#state').getAttribute('class')).toContain('tone-error');
      // None of the account data is shown — the lists and the statement are hidden for a non-supplier login.
      expect(await page.locator('#awaiting li.row').count()).toBe(0);
      expect(await page.locator('#processed li.row').count()).toBe(0);
      expect(await page.locator('#statement').getAttribute('hidden')).not.toBeNull();
      expect(await page.locator('#delivery').getAttribute('hidden')).not.toBeNull(); // OB-362: no form either
      // Nothing the screen sent was a write.
      expect(rec.requests.every((r) => r.method === 'GET')).toBe(true);
    } finally {
      await context.close();
      await srv.stop();
    }
  });
});
