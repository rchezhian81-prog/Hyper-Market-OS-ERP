import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { auditPage } from './lib/a11y-audit';
import {
  addLogin, COOKIE_NAME, createDemoLoginHandler, FailureThrottle, SESSION_SECONDS, WRONG_CREDENTIALS, type DemoLoginFile,
} from '../../infra/pilot/demo-login/login';
import { LOGIN_COPY } from '../../infra/pilot/demo-login/ui';

/**
 * **The sign-in page in the owner's approved design, in a real browser (UX-3 · OB-18 · P-04 · P-07 · P-08 · NFR-07).**
 *
 * The unit suite proves what the server sends. This drives headless Chromium against the REAL sign-in service (the
 * handler `main.ts` serves, behind a tiny stand-in for the store workspace it lands on) to prove what a person meets:
 *
 *   • at a desk (1280) the two-column page — the intro beside the card — and on a phone (390, and a 320 low-spec one)
 *     the card alone, with no horizontal scrolling; the WCAG 2.2 AA audit clean at every width, in English and in Tamil;
 *   • the language switch changes every word on the page and the document's language, and is remembered on reload;
 *   • show/hide reveals the password and says so; the help dialog opens, traps focus, closes on Escape and returns
 *     focus to the button that opened it;
 *   • an empty submit is stopped in the browser with the field named; a wrong password comes back from the SERVER as
 *     one generic alert, the login still in its field, the password never in the page;
 *   • a right password lands IN the workspace with the HttpOnly, Secure, SameSite=Strict cookie — and a second click
 *     while the first submit is pending sends NOTHING (one POST, the button busy and saying so);
 *   • after the shift the same cookie is met with "your session has ended", once, and the cookie is dropped;
 *   • nothing on the page violates its content-security policy and no script error is thrown.
 *
 * Screenshots for the owner are written only when SRE_SHOTS names a directory. The browser is the environment's
 * pre-installed Chromium; where none is present the suite SKIPS rather than failing (CI provides one, GT-01).
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const SHOTS = process.env['SRE_SHOTS'];

const IDP = { secret: ['sign', 'in', 'page', 'e2e', 'key'].join('-').padEnd(48, '0'), issuer: 'https://pilot-idp.test', audience: 'sre-retail-os-api' };
const PASSWORD = ['Right', 'Horse', '42'].join('-');
const FILE: DemoLoginFile = addLogin({ version: 1, logins: [] }, {
  login: 'ravi.cashier', userId: 'pilot-cashier', password: PASSWORD, createdBy: 'e2e', now: new Date('2026-10-05T09:00:00Z'),
});

interface Stand {
  readonly base: string;
  readonly posts: () => number;
  readonly advance: (ms: number) => void;
  /** Hold every sign-in POST until the returned release is called — the "slow server", without racing a clock. */
  readonly holdPosts: () => () => void;
  /** How many sign-in POSTs have arrived and are being held right now. */
  readonly heldCount: () => number;
  readonly stop: () => Promise<void>;
}

/** The real handler behind a real HTTP server, plus `/store/manager/` standing in for the workspace it lands on. */
function stand(): Promise<Stand> {
  let now = Date.parse('2026-10-05T09:00:00Z');
  let posts = 0;
  let held: (() => void)[] | null = null;
  const handle = createDemoLoginHandler({ logins: () => FILE, idp: IDP, throttle: new FailureThrottle(), now: () => now, audit: () => {} });
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { chunks.push(c); });
    req.on('end', () => {
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : v;
      const url = req.url ?? '/';
      if (url.startsWith('/store/')) {
        const signedIn = (headers['cookie'] ?? '').includes(`${COOKIE_NAME}=`);
        res.writeHead(signedIn ? 200 : 401, { 'content-type': 'text/html; charset=utf-8' })
          .end(signedIn ? '<!doctype html><title>Workspace</title><h1 id="workspace">WORKSPACE</h1>' : 'no session');
        return;
      }
      const request = { method: req.method ?? 'GET', url, headers, body: Buffer.concat(chunks).toString('utf8') };
      const answer = (): void => {
        if (request.method === 'POST') posts += 1;
        const out = handle(request);
        res.writeHead(out.status, out.headers).end(out.body);
      };
      if (request.method === 'POST' && held !== null) held.push(answer); else answer();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({
        // "localhost" is a secure context, so the Secure cookie is accepted over plain http here — as https does on the box.
        base: `http://localhost:${port}`,
        posts: () => posts,
        advance: (ms) => { now += ms; },
        holdPosts: () => {
          held = [];
          return () => { const waiting = held ?? []; held = null; for (const go of waiting) go(); };
        },
        heldCount: () => held?.length ?? 0,
        stop: () => new Promise((done) => { server.close(() => { done(); }); server.closeAllConnections(); }),
      });
    });
  });
}

const DESK = { width: 1280, height: 860 };
const PHONE = { width: 390, height: 844 };
const SMALL = { width: 320, height: 640 };

/** What must never happen on the page: a script error, a policy violation, a resource that fails to load (a 401 on the sign-in POST itself is the expected answer to a wrong password). */
function watch(page: Page): { readonly problems: () => readonly string[] } {
  const problems: string[] = [];
  page.on('pageerror', (err) => { problems.push(`pageerror: ${err.message}`); });
  page.on('console', (msg) => { if (msg.type() === 'error' && /Content Security Policy|Refused to|Uncaught/.test(msg.text())) problems.push(`console: ${msg.text()}`); });
  page.on('response', (res) => {
    const url = new URL(res.url());
    const expected = (url.pathname === '/login/' && res.request().method() === 'POST') || url.pathname === '/favicon.ico';
    if (res.status() >= 400 && !expected) problems.push(`${res.status()} ${res.request().method()} ${url.pathname}${url.search}`);
  });
  return { problems: () => problems };
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS === undefined) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

describe.skipIf(!HAVE_BROWSER)('the sign-in page, in a real browser (UX-3 · OB-18)', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true, executablePath: CHROMIUM }); }, 60_000);
  afterAll(async () => { await browser?.close(); });

  it('shows the approved design at a desk and on phones, audit-clean in English and Tamil, with no policy violation', async () => {
    const s = await stand();
    const context = await browser.newContext({ viewport: DESK });
    const page = await context.newPage();
    const { problems } = watch(page);
    try {
      await page.goto(`${s.base}/login/`, { waitUntil: 'load' });
      expect(await page.title()).toBe('Sign in — SRE Hyper Market');
      // The two columns at a desk: the intro visible beside the card; one primary Sign in, enabled.
      expect(await page.isVisible('.sl-intro')).toBe(true);
      expect(await page.isVisible('.sl-login-card')).toBe(true);
      expect(await page.isEnabled('#sl-submit')).toBe(true);
      expect(await page.textContent('#sl-connection-text')).toBe('Online sign-in available');
      expect(await page.isVisible('#sl-reveal')).toBe(true); // the script arrived and switched the reveal on
      expect(await page.isHidden('#sl-state-notice')).toBe(true);
      expect(await auditPage(page, { expectLang: 'en' }), 'desk, English').toEqual([]);
      await shot(page, 'sign-in-desk-en');

      // Tamil: every marked word changes, the document says so, and the choice survives a reload.
      await page.click('[data-language="ta"]');
      expect(await page.getAttribute('html', 'lang')).toBe('ta');
      expect(await page.textContent('#sl-welcome')).toBe(LOGIN_COPY.ta.welcome);
      expect(await page.textContent('label[for="login"]')).toBe(LOGIN_COPY.ta.staffId);
      expect(await page.textContent('#sl-connection-text')).toBe(LOGIN_COPY.ta.connectionOnline);
      expect(await page.textContent('.sl-strip')).toBe(LOGIN_COPY.ta.strip);
      expect(await page.getAttribute('[data-language="ta"]', 'aria-pressed')).toBe('true');
      expect(await auditPage(page, { expectLang: 'ta' }), 'desk, Tamil').toEqual([]);
      await shot(page, 'sign-in-desk-ta');
      await page.reload({ waitUntil: 'load' });
      expect(await page.getAttribute('html', 'lang')).toBe('ta');
      await page.click('[data-language="en"]');
      expect(await page.textContent('#sl-welcome')).toBe('Welcome back.');

      for (const [name, viewport] of [['phone', PHONE], ['small', SMALL]] as const) {
        await page.setViewportSize(viewport);
        await page.reload({ waitUntil: 'load' });
        expect(await page.isHidden('.sl-intro'), `${name}: the decorative panel goes`).toBe(true);
        expect(await page.isVisible('.sl-login-card')).toBe(true);
        const scroll = await page.evaluate('[document.documentElement.scrollWidth, document.documentElement.clientWidth]') as [number, number];
        expect(scroll[0], `${name}: no horizontal scrolling`).toBeLessThanOrEqual(scroll[1] + 1);
        expect(await auditPage(page, { expectLang: 'en' }), `${name}, English`).toEqual([]);
        await page.click('[data-language="ta"]');
        expect(await auditPage(page, { expectLang: 'ta' }), `${name}, Tamil`).toEqual([]);
        await page.click('[data-language="en"]');
        await shot(page, `sign-in-${name}-en`);
      }
      expect(problems()).toEqual([]);
    } finally {
      await context.close();
      await s.stop();
    }
  });

  it('show/hide, the help dialog with focus kept and returned, and an empty submit stopped with the field named', async () => {
    const s = await stand();
    const context = await browser.newContext({ viewport: DESK });
    const page = await context.newPage();
    const { problems } = watch(page);
    try {
      await page.goto(`${s.base}/login/`, { waitUntil: 'load' });
      // Show / hide.
      await page.fill('#password', 'something');
      expect(await page.getAttribute('#password', 'type')).toBe('password');
      await page.click('#sl-reveal');
      expect(await page.getAttribute('#password', 'type')).toBe('text');
      expect(await page.textContent('#sl-reveal')).toBe('Hide');
      expect(await page.getAttribute('#sl-reveal', 'aria-pressed')).toBe('true');
      await page.click('#sl-reveal');
      expect(await page.getAttribute('#password', 'type')).toBe('password');
      expect(await page.textContent('#sl-reveal')).toBe('Show');

      // The help dialog: focus lands on Close, Tab cycles inside, Escape closes, focus returns to the opener.
      await page.focus('.sl-help-row [data-open="help"]');
      await page.keyboard.press('Enter');
      expect(await page.isVisible('#sl-dialog-host')).toBe(true);
      expect(await page.textContent('#sl-dialog-title')).toBe(LOGIN_COPY.en.helpTitle);
      expect(await page.evaluate('document.activeElement.id')).toBe('sl-dialog-close');
      await page.keyboard.press('Tab');
      expect(await page.evaluate('document.activeElement.id')).toBe('sl-dialog-done');
      await page.keyboard.press('Tab');
      expect(await page.evaluate('document.activeElement.id'), 'focus stays inside the dialog').toBe('sl-dialog-close');
      expect(await page.evaluate('document.querySelector(".sl-main").inert')).toBe(true);
      await shot(page, 'sign-in-help');
      await page.keyboard.press('Escape');
      expect(await page.isHidden('#sl-dialog-host')).toBe(true);
      expect(await page.evaluate('document.querySelector(".sl-main").inert')).toBe(false);
      expect(await page.evaluate('document.activeElement.getAttribute("data-copy")')).toBe('needHelp');

      // The connection dialog tells the truth about what this sign-in is.
      await page.click('#sl-connection-status [data-open="connection"]');
      expect(await page.textContent('#sl-dialog-title')).toBe(LOGIN_COPY.en.connectionTitle);
      expect(await page.textContent('#sl-dialog-copy')).toContain('does not say that a store computer is running');
      await page.click('#sl-dialog-done');
      expect(await page.isHidden('#sl-dialog-host')).toBe(true);

      // An empty submit never leaves the browser: the field is named, marked and focused.
      await page.fill('#password', '');
      await page.click('#sl-submit');
      expect(s.posts()).toBe(0);
      expect(await page.getAttribute('#sl-form-message', 'role')).toBe('alert');
      expect(await page.textContent('#sl-form-message')).toBe(LOGIN_COPY.en.requiredId);
      expect(await page.getAttribute('#login', 'aria-invalid')).toBe('true');
      expect(await page.evaluate('document.activeElement.id')).toBe('login');
      await page.fill('#login', 'ravi.cashier');
      expect(await page.getAttribute('#login', 'aria-invalid')).toBeNull(); // typing clears the mark
      await page.click('#sl-submit');
      expect(s.posts()).toBe(0);
      expect(await page.textContent('#sl-form-message')).toBe(LOGIN_COPY.en.requiredPassword);
      expect(await page.evaluate('document.activeElement.id')).toBe('password');
      expect(problems()).toEqual([]);
    } finally {
      await context.close();
      await s.stop();
    }
  });

  it('a wrong password is one generic alert from the server; a right one lands in the workspace with the cookie; a second click while pending sends nothing; after the shift the session is said to have ended', async () => {
    const s = await stand();
    const context = await browser.newContext({ viewport: PHONE });
    const page = await context.newPage();
    const { problems } = watch(page);
    try {
      await page.goto(`${s.base}/login/?next=/store/manager/`, { waitUntil: 'load' });
      await page.fill('#login', 'ravi.cashier');
      await page.fill('#password', 'not-the-password-9');
      await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.keyboard.press('Enter')]); // Enter submits
      expect(s.posts()).toBe(1);
      expect(await page.getAttribute('#sl-form-message', 'role')).toBe('alert');
      expect(await page.textContent('#sl-form-message')).toBe(WRONG_CREDENTIALS);
      expect(await page.getAttribute('#login', 'aria-invalid')).toBe('true');
      expect(await page.inputValue('#password')).toBe('');
      expect(await page.content()).not.toContain('not-the-password-9');
      expect(await page.inputValue('input[name="next"]')).toBe('/store/manager/');
      expect(await auditPage(page, { expectLang: 'en' }), 'the refusal, on a phone').toEqual([]);
      await shot(page, 'sign-in-wrong');
      // The same sentence in Tamil, because it is the ONE generic sentence and it is marked for the switch.
      await page.click('[data-language="ta"]');
      expect(await page.textContent('#sl-form-message')).toBe(LOGIN_COPY.ta.invalid);
      await page.click('[data-language="en"]');

      // The right password, with the server slow (its answer held until the test lets it go — no clock to race): the button
      // goes busy and says so, a second click sends nothing.
      const release = s.holdPosts();
      await page.fill('#login', 'ravi.cashier');
      await page.fill('#password', PASSWORD);
      // Once Chromium has the sign-in POST in flight it stops answering any DevTools call into the old page (even a bare
      // evaluate) until the answer comes — so a test that clicks and THEN reads the page races the browser, and hangs when
      // the POST wins with its answer held. Hence: the first click and the read of the busy button happen in ONE script
      // (nothing is sent until it ends); everything after it is watched at the server or done with real input.
      const box = await page.locator('#sl-submit').boundingBox();
      expect(box).not.toBeNull();
      const [busy, label] = await page.evaluate(`(() => {
        document.getElementById('sl-submit').click();
        return [document.getElementById('sl-submit').getAttribute('aria-busy'), document.getElementById('sl-submit-text').textContent];
      })()`) as [string | null, string | null];
      expect(busy).toBe('true');
      expect(label).toBe(LOGIN_COPY.en.signingIn);
      // The first submit is now provably pending: its POST has reached the server and is held there.
      await expect.poll(() => s.heldCount(), { timeout: 10_000 }).toBe(1);
      // The second click is a real one — a finger on the busy button (the input path still works while the POST is held).
      // Without the page's pending guard it sends a second POST within milliseconds; with it, nothing arrives.
      await page.mouse.click((box?.x ?? 0) + (box?.width ?? 0) / 2, (box?.y ?? 0) + (box?.height ?? 0) / 2);
      for (const until = Date.now() + 500; Date.now() < until;) {
        expect(s.heldCount(), 'the second click sent nothing').toBe(1);
        await new Promise((r) => { setTimeout(r, 10); });
      }
      expect(s.posts()).toBe(1); // answered so far: only the wrong password
      const landed = page.waitForURL(`${s.base}/store/manager/`, { waitUntil: 'load' });
      release();
      await landed;
      expect(s.posts()).toBe(2); // the wrong one and the right one — the second click sent nothing
      expect(await page.textContent('#workspace')).toBe('WORKSPACE');
      const cookie = (await context.cookies()).find((c) => c.name === COOKIE_NAME);
      expect(cookie).toBeDefined();
      expect(cookie?.httpOnly).toBe(true);
      expect(cookie?.secure).toBe(true);
      expect(cookie?.sameSite).toBe('Strict');

      // Signed in, the sign-in address is the account page.
      await page.goto(`${s.base}/login/`, { waitUntil: 'load' });
      expect(await page.textContent('#sl-welcome')).toBe('Signed in as pilot-cashier');
      expect(await page.getAttribute('a.sl-submit', 'href')).toBe('/store/manager/');
      expect(await auditPage(page, { expectLang: 'en' }), 'the account page').toEqual([]);
      await shot(page, 'account');

      // The shift ends: the same cookie is now met with the notice, once, and the browser's cookie is dropped.
      s.advance((SESSION_SECONDS + 60) * 1000);
      await page.goto(`${s.base}/login/?next=/store/manager/`, { waitUntil: 'load' });
      expect(await page.isVisible('#sl-state-notice')).toBe(true);
      expect(await page.textContent('#sl-state-text')).toBe(LOGIN_COPY.en.expired);
      expect((await context.cookies()).find((c) => c.name === COOKIE_NAME)).toBeUndefined();
      await shot(page, 'sign-in-expired');
      await page.reload({ waitUntil: 'load' });
      expect(await page.isHidden('#sl-state-notice'), 'said once').toBe(true);
      expect(problems()).toEqual([]);
    } finally {
      await context.close();
      await s.stop();
    }
  });
});
