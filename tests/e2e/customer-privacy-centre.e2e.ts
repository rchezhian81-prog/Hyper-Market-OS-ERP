import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { beginOtpChallenge, verifyOtp, type OtpChallenge } from '../../packages/identity/src/index';
import { createOtpSimulator } from '../support/otp-simulator';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';

/**
 * **The privacy centre, in a real browser, saves on the shop (audit FUL-06 · M16-FR-02/03 · M20-FR-04).**
 *
 * The audit's finding was a screen that said "done" for a consent switch and a data request that never left the phone.
 * Here a customer signs in by one-time code and, on the "My information" screen: switches marketing SMS on (the switch
 * moves only after the shop has it — the shop's consent ledger then holds it); with the connection cut, taps it again
 * and is told "Not saved" while the switch stays where it was; back online, switches it off (the ledger holds the
 * withdrawal); raises an erasure request, and the DPO's queue on the shop holds it under that customer.
 *
 * One Node server plays the store's reverse proxy, exactly as `customer-order-delivery.e2e.ts`: the app's own files with
 * `window.shopData` injected, the auth backend on the production OTP engines and the test IdP, and `/v1/*` handed to the
 * REAL API kernel. Self-skips where no browser is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/customer-app/web';
const DATA_MARKER = '<!--SCREEN-DATA-->';
const T = 'ab000000-0000-4000-8000-0000000f06e2';
const OWNER = 'u-owner';
const PHONE = '+919000000006';
const SUBJECT = 'cust-privacy-1';

const shopData = () => ({
  tenantId: T, customerRef: 'guest', packVersion: 1, locationId: 'L1',
  products: [{ productId: 'MILK', name: 'Aavin Milk 1L', categoryId: 'dairy', unitPriceMinor: 60_00, uom: 'each', barcodes: ['8901234567891'], status: 'active', availableMinor: 5, availabilityAgeMinutes: 1 }],
  consentPurposes: [{ purpose: 'marketing', channel: 'sms' }],
});

async function startStore(h: ApiHarness): Promise<{ base: string; sms: ReturnType<typeof createOtpSimulator>; stop: () => Promise<void> }> {
  const sms = createOtpSimulator();
  const challenges = new Map<string, OtpChallenge>();
  const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> => new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += String(c); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}') as Record<string, unknown>); } catch { resolve({}); } });
  });
  const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body ?? null));
  };
  const server: Server = createServer((req, res) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      if (req.method === 'POST' && path === '/auth/otp/begin') {
        const body = await readBody(req);
        const challengeId = `c-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const begun = beginOtpChallenge({ challengeId, tenantId: T, phoneNumber: String(body['phoneNumber'] ?? ''), purpose: 'login', now: new Date().toISOString() });
        challenges.set(challengeId, begun.challenge);
        sms.send({ phoneNumber: begun.challenge.phoneNumber, code: begun.code, purpose: 'login', tenantId: T });
        sendJson(res, 200, { ok: true, challengeId });
        return;
      }
      if (req.method === 'POST' && path === '/auth/otp/verify') {
        const body = await readBody(req);
        const challenge = challenges.get(String(body['challengeId'] ?? ''));
        if (challenge === undefined) { sendJson(res, 200, { ok: false, reason: 'unknown_challenge' }); return; }
        const v = verifyOtp({ challenge, tenantId: T, submittedCode: String(body['code'] ?? ''), now: new Date().toISOString() });
        if (!v.verified) { sendJson(res, 200, { ok: false, reason: v.outcome }); return; }
        await h.provisionRole(T, SUBJECT, 'customer');
        sendJson(res, 200, { ok: true, token: TEST_IDP.issue({ sub: SUBJECT, tenantId: T, amr: ['otp'] }), sessionId: `s-${Date.now()}` });
        return;
      }
      if (path.startsWith('/v1/')) {
        const auth = req.headers['authorization'] ?? '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
        const key = req.headers['idempotency-key'];
        const body = req.method === 'POST' ? await readBody(req) : undefined;
        const out = await h.raw({
          method: (req.method ?? 'GET') as 'GET' | 'POST', path,
          ...(token === undefined ? {} : { token }), ...(body === undefined ? {} : { body }),
          ...(typeof key === 'string' ? { idempotencyKey: key } : {}),
        });
        sendJson(res, out.status, out.body);
        return;
      }
      const file = path === '/' || path === '/index.html' ? 'index.html' : path.replace(/^\//, '');
      try {
        let text = (await readFile(join(WEB_DIR, file))).toString('utf8');
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        if (file === 'index.html') text = text.replace(DATA_MARKER, `<script>window.shopData = ${JSON.stringify(shopData()).replace(/</g, '\\u003c')};</script>`);
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(text);
      } catch { res.writeHead(404); res.end('not found'); }
    })();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({ base: `http://127.0.0.1:${port}`, sms, stop: () => new Promise((done) => { server.close(() => { done(); }); server.closeAllConnections(); }) });
    });
  });
}

const ledger = async (h: ApiHarness) =>
  ((await h.request({ method: 'GET', path: `/v1/customers/${SUBJECT}/consent`, userId: OWNER, tenantId: T })).body as { records: { given: boolean }[] }).records.map((r) => r.given);

describe.skipIf(!HAVE_BROWSER)('the privacy centre saves on the shop, in a real browser (FUL-06)', () => {
  let browser: Browser;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'customer-app'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);
  afterAll(async () => { await browser?.close(); });

  it('switch on → saved; offline → "Not saved", the switch stays; switch off → the withdrawal is on the ledger; a raised request reaches the DPO queue', async () => {
    const h = apiHarness();
    await h.seedOwner(T, OWNER);
    const store = await startStore(h);
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${store.base}/`, { waitUntil: 'load' });
      await page.waitForFunction(() => (globalThis as unknown as { document: { getElementById(id: string): { hidden: boolean } | null } }).document.getElementById('sample')?.hidden === true, undefined, { timeout: 10_000 });
      // Sign in by one-time code (the sign-in lives in the basket).
      await page.click('#tab-basket');
      await page.fill('#si-phone', PHONE);
      await page.click('#si-send');
      await page.waitForSelector('#si-step-code:not([hidden])', { timeout: 10_000 });
      await page.fill('#si-code', store.sms.codeFor(PHONE) ?? '');
      await page.click('#si-verify');
      await page.waitForSelector('#si-step-in:not([hidden])', { timeout: 10_000 });

      await page.click('#tab-privacy');
      const toggle = page.locator('#consent [role="switch"]').first();
      await toggle.waitFor();
      expect(await toggle.getAttribute('aria-checked')).toBe('false');

      // ON — the switch moves once the shop has it; the shop's ledger holds a grant.
      await toggle.click();
      await page.locator('#consent [role="switch"][aria-checked="true"]').waitFor({ timeout: 10_000 });
      expect(await ledger(h)).toEqual([true]);

      // OFFLINE — tapping it again saves nothing and SAYS so; the switch stays on; the ledger is unchanged.
      await context.setOffline(true);
      await page.locator('#consent [role="switch"]').first().click();
      await page.locator('#banner-text', { hasText: 'Not saved' }).waitFor({ timeout: 10_000 });
      expect(await page.locator('#consent [role="switch"]').first().getAttribute('aria-checked')).toBe('true');
      expect(await ledger(h)).toEqual([true]);
      await page.click('#banner-ok');

      // Back online — OFF; the withdrawal is the latest fact on the ledger.
      await context.setOffline(false);
      await page.locator('#consent [role="switch"]').first().click();
      await page.locator('#consent [role="switch"][aria-checked="false"]').waitFor({ timeout: 10_000 });
      expect(await ledger(h)).toEqual([true, false]);

      // Raise an erasure request — "We have your request" with the shop's reference, and the DPO queue holds it.
      await page.locator('#rights button').last().click();
      await page.locator('#banner-title', { hasText: 'We have your request' }).waitFor({ timeout: 10_000 });
      const said = await page.locator('#banner-text').textContent();
      const queue = ((await h.request({ method: 'GET', path: '/v1/privacy/data-requests', userId: OWNER, tenantId: T })).body as { queue: { requestId: string; customerRef: string; kind: string }[] }).queue;
      expect(queue).toEqual([expect.objectContaining({ customerRef: SUBJECT, kind: 'erasure' })]);
      expect(said).toContain(queue[0]!.requestId);
      expect(said).toMatch(/invoices and tax records/);
    } finally {
      await context.close();
      await store.stop();
    }
  }, 60_000);
});
