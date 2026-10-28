import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startCustomerSignIn } from '../../services/identity/src/customer-sign-in-main';
import { mountCustomerSignIn, testCustomerSigner, type MountedCustomerSignIn } from '../support/customer-sign-in-test-ports';
import { TEST_IDP } from '../support/api-harness';

/**
 * **The customer portal sign-in, end to end in a real browser, on the REAL customer sign-in service (M20-FR-01 · WF-13 ·
 * M02 · ADR-0031).**
 *
 * The page (apps/customer-app/web/login.html) is served by a small Node server that hands every `/auth/otp/*` call to
 * the production handler (`services/identity/src/customer-sign-in.ts`) — the stand-in auth backend this test used to
 * carry is gone. The handler runs with the recording SMS transport and the local test identity provider as its signer
 * (both from tests/support; the page holds no minter and no key).
 *
 * It proves, through Chromium:
 *   • phone → the code that reached the "phone" → signed in, the session cookie HttpOnly (the page cannot read it);
 *   • an ordinary action (view orders) is allowed; a money change (change bank details) asks for more (step-up);
 *   • sign-out ends the session on the service: the OLD session cookie, put back into the browser and replayed, is
 *     refused (`session_invalid`);
 *   • and the product as shipped — the very process `customer-sign-in-main` starts, with NO SMS provider (OB-222) —
 *     refuses to send a code, and the page says so in plain words (English and Tamil).
 *
 * Self-skips where no browser is present, like every other e2e.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/customer-app/web';
const TENANT = 't-sre';
const PHONE = '+91 90000 00000';
const NUMBER = '9000000000';

/** Serves the login page; `/auth/otp/*` goes to `auth` (the real handler), or is proxied to `upstream`. */
async function startPage(auth: MountedCustomerSignIn | { upstream: string }): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      if ('handle' in auth) {
        if (await auth.handle(req, res)) return;
      } else if (path.startsWith('/auth/otp/')) {
        const body = await new Promise<string>((r) => { let d = ''; req.on('data', (c) => { d += String(c); }); req.on('end', () => r(d)); });
        const out = await fetch(`${auth.upstream}${path}`, { method: req.method ?? 'POST', headers: { 'content-type': req.headers['content-type'] ?? '' }, body });
        res.writeHead(out.status, { 'content-type': 'application/json' });
        res.end(await out.text());
        return;
      }
      const file = path === '/' || path === '/login' ? 'login.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(buf);
      } catch { res.writeHead(404); res.end('not found'); }
    })();
  });
  return new Promise((resolve) => {
    // `localhost`, not a bare IP: the browser treats it as a secure context, so the service's Secure cookie is kept.
    server.listen(0, 'localhost', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({ base: `http://localhost:${port}`, stop: () => new Promise((done) => { server.close(() => { done(); }); server.closeAllConnections(); }) });
    });
  });
}

describe.skipIf(!HAVE_BROWSER)('customer portal sign-in, end to end in a real browser, on the real service (M20-FR-01)', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true, executablePath: CHROMIUM }); }, 60_000);
  afterAll(async () => { await browser?.close(); });

  it('signs in by a code, allows an ordinary action, steps up a money change, and ends the session on sign-out', async () => {
    const signer = testCustomerSigner({ idp: TEST_IDP, subjectFor: (n) => `cust-${n.slice(-4)}` });
    const auth = mountCustomerSignIn({ tenantId: TENANT, signer });
    const site = await startPage(auth);
    const context = await browser.newContext();
    const page: Page = await context.newPage();
    try {
      await page.goto(`${site.base}/login`, { waitUntil: 'load' });
      await page.fill('#phone', PHONE);
      await page.click('#send-code');
      await page.waitForSelector('#step-code:not([hidden])', { timeout: 10_000 });

      const code = auth.sms.codeFor(NUMBER);
      expect(code).toMatch(/^\d{6}$/);
      await page.fill('#code', code ?? '');
      await page.click('#verify');
      await page.waitForSelector('#step-account:not([hidden])', { timeout: 10_000 });
      await page.locator('#status', { hasText: 'Signed in' }).waitFor({ timeout: 10_000 });
      expect(signer.signedIn).toEqual(['cust-0000']);

      // The session cookie is the service's, HttpOnly: the page's own script cannot see it.
      const cookies = await context.cookies();
      const session = cookies.find((c) => c.name === 'sre_customer_session');
      expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/auth/otp/' });
      expect(await page.evaluate(() => (globalThis as unknown as { document: { cookie: string } }).document.cookie)).not.toContain('sre_customer_session');

      await page.click('#view-orders');
      await page.locator('#result', { hasText: 'orders are shown' }).waitFor({ timeout: 10_000 });
      await page.click('#change-bank');
      await page.locator('#result', { hasText: 'Extra verification needed' }).waitFor({ timeout: 10_000 });

      await page.click('#sign-out');
      await page.locator('#status', { hasText: 'Signed out' }).waitFor({ timeout: 10_000 });
      expect((await context.cookies()).find((c) => c.name === 'sre_customer_session')).toBeUndefined();

      // Put the OLD cookie back and replay: the service ended that session, so it is refused.
      await context.addCookies([session!]);
      const replayed = await page.evaluate(async () => {
        const g = globalThis as unknown as { fetch(input: string, init: unknown): Promise<{ json(): Promise<{ outcome?: string }> }> };
        const r = await g.fetch('/auth/otp/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'view_orders' }) });
        return (await r.json()).outcome;
      });
      expect(replayed).toBe('session_invalid');
      // And no line the service logged carries the number or the code.
      expect(JSON.stringify(auth.audit)).not.toContain(NUMBER);
      expect(JSON.stringify(auth.audit)).not.toContain(code);
    } finally {
      await context.close();
      await site.stop();
    }
  }, 60_000);

  it('as shipped — no SMS provider connected (OB-222) — the real process refuses to send a code and the page says so', async () => {
    const lines: string[] = [];
    const svc = startCustomerSignIn({ env: { CUSTOMER_SIGN_IN_ORIGIN: 'https://shop.example.test', CUSTOMER_SIGN_IN_TENANT_ID: TENANT }, port: 0, log: (l) => { lines.push(l); } });
    await new Promise<void>((r) => { if (svc.listening) r(); else svc.once('listening', () => r()); });
    const port = (svc.address() as { port: number }).port;
    const site = await startPage({ upstream: `http://127.0.0.1:${port}` });
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${site.base}/login`, { waitUntil: 'load' });
      await page.fill('#phone', PHONE);
      await page.click('#send-code');
      await page.locator('#status', { hasText: 'no SMS provider is connected' }).waitFor({ timeout: 10_000 });
      expect(await page.textContent('#status')).toContain('குறியீடு அனுப்பப்படவில்லை');
      expect(await page.isHidden('#step-code')).toBe(true);
      expect(lines.join('\n')).toContain('NO PROVIDER CONNECTED');
      expect(lines.join('\n')).not.toContain(NUMBER);
    } finally {
      await context.close();
      await site.stop();
      await new Promise((r) => svc.close(r));
    }
  }, 60_000);
});
