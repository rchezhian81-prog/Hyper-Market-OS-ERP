import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

/**
 * **U6 · M24-FR-01 · M24-FR-02 (UI/UX gap audit §27): a supplier answers a request for quotation and raises a claim, in a real
 * browser.** The portal reads `GET /v1/supplier-portal/me/rfqs` and `…/me/claims` live on load; each request shows its own
 * quote form (a price per unit and the days to deliver per line asked); the page refuses before anything is sent (a
 * half-filled line by product name, nothing quoted); the quote goes to the request's OWN route as one POST; the shop's claims
 * on the supplier read with their state and debit-note number (or "no number yet"); the claim form refuses before sending
 * (a zero amount, no reason) and sends ONE `claim` submission; a login without the submit grant sees the words, not the forms;
 * Tamil twin. Against a stub cloud, exactly as the delivery and rebates tests do; SKIPS without the pre-installed Chromium.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/supplier-app/web';

interface BrowserGlobals { readonly document: { querySelectorAll(selector: string): { readonly length: number }; getElementById(id: string): { readonly hidden: boolean } | null } }

const PARTNER = 'p-acme';
const ORDERS = [{ poId: 'po-a1', number: 'PO-000001', issuedAt: '2026-10-20T09:00:00Z', deliverToLocationId: 'br-1', lines: 1 }];
const RFQS = [
  { rfqId: 'rfq-1', requisitionId: 'rq-1', dueOn: '2099-11-20', note: 'per kg, delivered', sentAt: '2026-11-07T04:00:00Z', currency: 'INR', lines: [{ productId: 'rice', quantity: 10_000, uom: 'kg' }, { productId: 'dal', quantity: 4 }], replied: false, awaitingBuyer: false, answered: false, decision: null },
  { rfqId: 'rfq-0', requisitionId: 'rq-0', dueOn: '2026-10-01', sentAt: '2026-09-20T04:00:00Z', currency: 'INR', lines: [{ productId: 'rice', quantity: 5_000, uom: 'kg' }], replied: true, submissionId: 'rfq-rfq-0-p-acme-x', repliedAt: '2026-09-22T04:00:00Z', awaitingBuyer: false, answered: false, decision: 'rejected', reason: 'too dear' },
];
const CLAIMS = [
  { claimId: 'grn-1:p2', kind: 'debit_note', grnId: 'grn-1', poId: 'po-a1', productId: 'p2', quantityMinor: 2, valueMinor: 20_000, reason: 'damaged in transit', raisedAt: '2026-11-07T05:00:00Z', number: null, state: 'raised' },
  { claimId: 'grn-1:p1', kind: 'debit_note', grnId: 'grn-1', poId: 'po-a1', productId: 'p1', quantityMinor: 5_000, uom: 'kg', valueMinor: 21_000, reason: 'expired', raisedAt: '2026-11-07T05:00:00Z', number: 'DN-000001', state: 'issued' },
  { claimId: 'grn-1:p3:door', kind: 'refused_at_door', grnId: 'grn-1', poId: 'po-a1', productId: 'p3', quantityMinor: 1, valueMinor: 5_000, reason: 'wrong item', raisedAt: '2026-11-07T05:00:00Z', number: null, state: 'never_owed' },
];

interface Recorder { supplierData: Record<string, unknown>; readonly requests: { method: string; path: string; body?: unknown }[]; mayRespond: boolean }

async function startPageAndCloud(rec: Recorder): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      const feed = (payload: unknown) => { rec.requests.push({ method: req.method ?? 'GET', path }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
      if (req.method === 'GET' && path === '/v1/supplier-portal/me/submissions') return feed({ partnerId: PARTNER, submissions: [], asAt: '2026-11-07T00:00:00.000Z' });
      if (req.method === 'GET' && path === '/v1/supplier-portal/me/statement') return feed({ partnerId: PARTNER, accessible: true, openingMinor: 0, invoicedMinor: 0, debitedMinor: 0, creditedMinor: 0, paidMinor: 0, closingMinor: 0, disputedMinor: 0, reconciles: true, detail: 'nothing outstanding' });
      if (req.method === 'GET' && path === '/v1/supplier-portal/me/orders') return feed({ partnerId: PARTNER, ordersKnown: true, orders: ORDERS, mayUpdate: true, deliveryStatuses: ['dispatched', 'in_transit', 'delayed'] });
      if (req.method === 'GET' && path === '/v1/supplier-portal/me/rfqs') return feed({ partnerId: PARTNER, rfqsKnown: true, rfqs: RFQS, mayRespond: rec.mayRespond, asAt: '2026-11-07T00:00:00.000Z' });
      if (req.method === 'GET' && path === '/v1/supplier-portal/me/claims') return feed({ partnerId: PARTNER, claimsKnown: true, claims: CLAIMS, asAt: '2026-11-07T00:00:00.000Z' });
      if (req.method === 'GET' && (path === '/v1/supplier-portal/me/vmi' || path === '/v1/supplier-portal/me/rebate-claims')) { res.writeHead(404); res.end('{}'); return; }
      if (req.method === 'POST') {
        let raw = '';
        for await (const chunk of req) raw += String(chunk);
        const body = JSON.parse(raw) as Record<string, unknown>;
        rec.requests.push({ method: 'POST', path, body });
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ submissionId: typeof body['submissionId'] === 'string' ? body['submissionId'] : 'rfq-rfq-1-p-acme-h', requiresReview: true }));
        return;
      }
      const file = path === '/' || path === '/index.html' ? 'index.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        let body = buf.toString('utf8');
        if (file.endsWith('.html')) body = body.replace('<!--SCREEN-DATA-->', `<script>window.supplierData = ${JSON.stringify(rec.supplierData).replace(/</g, '\\u003c')};</script>`);
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(body);
      } catch { res.writeHead(404); res.end('not found'); }
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

describe.skipIf(!HAVE_BROWSER)('U6: a supplier answers a request for quotation and raises a claim on its portal (M24-FR-01 · M24-FR-02)', () => {
  let browser: Browser;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'supplier-app'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);
  afterAll(async () => { await browser?.close(); });

  it('the requests show with their state and a form each; a half-filled line is refused by name; the quote goes to the request\'s own route once', async () => {
    const rec: Recorder = { supplierData: { userId: 'u-acme', permissions: ['supplier.portal.self', 'supplier.portal.self.submit'] }, requests: [], mayRespond: true };
    const srv = await startPageAndCloud(rec);
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(`${srv.base}/`, { waitUntil: 'load' });
      await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rfqs-rows li.row').length === 2, undefined, { timeout: 10_000 });
      expect(await page.textContent('#rfqs-h')).toBe('Requests for quotation from us');
      const open = await page.locator('#rfqs-rows li[data-rfq="rfq-1"]').innerText();
      expect(open).toContain('Waiting for your quote');
      expect(open).toContain('Request rfq-1 · answer by 2099-11-20');
      expect(open).toContain('Our note: per kg, delivered');
      expect(open).toContain('rice × 10.000 kg');
      expect(open).toContain('dal × 4');
      const rejected = await page.locator('#rfqs-rows li[data-rfq="rfq-0"]').innerText();
      expect(rejected).toContain('Quote not accepted — too dear');
      expect(await page.getAttribute('#rfqs-rows li[data-rfq="rfq-0"]', 'data-state')).toBe('rejected');
      // every box has a label; the send button carries its icon and word
      for (const id of ['q-rfq-1-rice-price', 'q-rfq-1-rice-lead', 'q-rfq-1-dal-price', 'q-rfq-1-dal-lead']) expect(await page.locator(`label[for="${id}"]`).count(), id).toBe(1);
      expect(await page.locator('#q-rfq-1-send svg.sre-icon').count()).toBe(1);
      expect(await page.textContent('#q-rfq-1-send')).toBe('Send the quote');

      // refused on the page before anything leaves it
      await page.click('#q-rfq-1-send');
      expect(await page.textContent('#q-rfq-1-result')).toBe('⚠ Quote at least one line: a price and the days to deliver. Nothing was sent.');
      await page.fill('#q-rfq-1-rice-price', '42');
      await page.click('#q-rfq-1-send');
      expect(await page.textContent('#q-rfq-1-result')).toBe('⚠ rice: the days to deliver must be a whole number of days (0 to 999). Nothing was sent.');
      expect(rec.requests.filter((r) => r.method !== 'GET')).toEqual([]);
      // the typed price survives a language switch (the page keeps what was typed)
      await page.click('#lang');
      expect(await page.inputValue('#q-rfq-1-rice-price')).toBe('42');
      expect(await page.textContent('#rfqs-h')).toBe('எங்களிடமிருந்து விலைப்புள்ளிக் கோரிக்கைகள்');
      expect(await page.textContent('#q-rfq-1-send')).toBe('விலைப்புள்ளியை அனுப்பு');
      await page.click('#lang');
      await page.fill('#q-rfq-1-rice-lead', '3');
      await page.click('#q-rfq-1-send');
      await page.waitForFunction(() => (globalThis as unknown as { document: { getElementById(id: string): { dataset: { result?: string } } | null } }).document.getElementById('q-rfq-1-result')?.dataset.result === 'sent', undefined, { timeout: 10_000 });
      expect(await page.textContent('#q-rfq-1-result')).toBe('✓ Your quote was sent. It waits for a buyer.');
      const posts = rec.requests.filter((r) => r.method === 'POST');
      expect(posts).toEqual([{ method: 'POST', path: '/v1/supplier-portal/me/rfqs/rfq-1/quote', body: { lines: [{ productId: 'rice', unitCost: { minor: 4200, currency: 'INR' }, leadTimeDays: 3 }] } }]); // dal left blank: not quoted
      expect(errors).toEqual([]);
    } finally {
      await context.close();
      await srv.stop();
    }
  });

  it('the shop\'s claims on it read with their state and number; the claim form refuses before sending and sends ONE claim submission; without the grant, words not forms', async () => {
    const rec: Recorder = { supplierData: { userId: 'u-acme', permissions: ['supplier.portal.self', 'supplier.portal.self.submit'] }, requests: [], mayRespond: true };
    const srv = await startPageAndCloud(rec);
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(`${srv.base}/`, { waitUntil: 'load' });
      await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#claims-rows li.row').length === 3, undefined, { timeout: 10_000 });
      expect(await page.textContent('#claims-h')).toBe('Our claims on you');
      const raised = await page.locator('#claims-rows li[data-claim="grn-1:p2"]').innerText();
      expect(raised).toContain('Raised — debit note to follow');
      expect(raised).toContain('Debit note · order po-a1 · p2 × 2 · ₹200.00 · damaged in transit');
      expect(raised).toContain('no debit note number yet');
      const issued = await page.locator('#claims-rows li[data-claim="grn-1:p1"]').innerText();
      expect(issued).toContain('Debit note issued');
      expect(issued).toContain('p1 × 5.000 kg · ₹210.00');
      expect(issued).toContain('DN-000001');
      expect(await page.locator('#claims-rows li[data-claim="grn-1:p3:door"]').innerText()).toContain('Refused at the door — never owed');

      await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.getElementById('raise-form')?.hidden === false, undefined, { timeout: 10_000 });
      expect(await page.textContent('#raise-h')).toBe('Raise a claim on us');
      expect(await page.locator('#cl-order option').allTextContents()).toEqual(['Not against one of your orders', 'PO-000001 · 2026-10-20']);
      for (const id of ['cl-order', 'cl-amount', 'cl-why']) expect(await page.locator(`label[for="${id}"]`).count(), id).toBe(1);
      expect(await page.locator('#cl-send svg.sre-icon').count()).toBe(1);
      await page.click('#cl-send');
      expect(await page.textContent('#cl-result')).toBe('⚠ The amount must be rupees, e.g. 1250.00, above zero. Nothing was sent.');
      await page.fill('#cl-amount', '1250');
      await page.click('#cl-send');
      expect(await page.textContent('#cl-result')).toBe('⚠ Say why — what the claim is for. Nothing was sent.');
      expect(rec.requests.filter((r) => r.method !== 'GET')).toEqual([]);
      await page.selectOption('#cl-order', 'po-a1');
      await page.fill('#cl-why', 'short paid against invoice 77');
      await page.click('#cl-send');
      await page.waitForFunction(() => (globalThis as unknown as { document: { getElementById(id: string): { dataset: { result?: string } } | null } }).document.getElementById('cl-result')?.dataset.result === 'sent', undefined, { timeout: 10_000 });
      expect(await page.textContent('#cl-result')).toBe('✓ Your claim was sent. It waits for a buyer.');
      const posts = rec.requests.filter((r) => r.method === 'POST');
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({ path: '/v1/supplier-portal/me/submissions', body: { kind: 'claim', document: { poId: 'po-a1', claimMinor: 125_000, why: 'short paid against invoice 77' } } });
      expect(String((posts[0]!.body as { submissionId: string }).submissionId)).toMatch(/^clm-/);
      await page.click('#lang');
      expect(await page.textContent('#claims-h')).toBe('உங்கள் மீதான எங்கள் உரிமைக்கோரல்கள்');
      expect(await page.textContent('#raise-h')).toBe('எங்கள் மீது உரிமைக்கோரல் எழுப்பு');
      expect(errors).toEqual([]);
    } finally {
      await context.close();
      await srv.stop();
    }

    // Without the submit grant: the requests and the claims still read; both forms are replaced by the "ask us" line.
    const readOnly: Recorder = { supplierData: { userId: 'u-acme-ro', permissions: ['supplier.portal.self'] }, requests: [], mayRespond: false };
    const srv2 = await startPageAndCloud(readOnly);
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    try {
      await page2.goto(`${srv2.base}/`, { waitUntil: 'load' });
      await page2.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rfqs-rows li.row').length === 2, undefined, { timeout: 10_000 });
      expect(await page2.textContent('#rfqs-said')).toBe('Your login cannot send quotes. Ask us to turn it on. Nothing was sent.');
      expect(await page2.locator('#rfqs-rows li[data-rfq="rfq-1"] .du-form:not([hidden])').count()).toBe(0);
      expect(await page2.textContent('#raise-said')).toMatch(/cannot/);
      expect(await page2.locator('#raise-form:not([hidden])').count()).toBe(0);
      expect(readOnly.requests.every((r) => r.method === 'GET')).toBe(true);
    } finally {
      await context2.close();
      await srv2.stop();
    }
  });
});
