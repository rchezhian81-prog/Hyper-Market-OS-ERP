import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { auditPage } from './lib/a11y-audit';
import { ApiError, buildRouter, type Method, type Router } from '../../services/kernel/src/index';
import { peopleRoutes, foldPeople, type PersonSignInEvent } from '../../services/identity/src/people';
import type { DirectoryPerson } from '../../services/identity/src/identity-directory';

/**
 * **The platform administrator gives a named person a sign-in from the Admin screen — in a real browser
 * (OB-15-c-2 · M02-FR-01 · SEC-03 · §28 · hard rule #4).**
 *
 * The session model and its words are unit-tested; head office's route is unit-tested and proved against a real
 * Keycloak. What only a browser can prove is that a person using the ACTUAL Admin page gets the rules and the one-time
 * password the way they are meant to. Headless Chromium against a stub head office that MOUNTS THE REAL ROUTE
 * (`peopleRoutes`, over an in-memory append-only log folded by the real `foldPeople`; the identity server stood in for):
 *   • a shared name ("cashier2") and the administrator's own name are refused ON THE PAGE — nothing is sent;
 *   • a named person: ONE POST of `{ signInName, displayName }` with an idempotency key — no password, no approver;
 *     the one-time password is shown once, with the hand-over words, and is nowhere else — not in storage, not in any
 *     attribute; "I have handed it over" takes it off the page; the list shows the person;
 *   • head office's own refusals in plain words (a person already holding a role), in English and Tamil;
 *   • a lost link gives nothing and says so;
 *   • somebody without the administrator's authority sees no form, with a plain sentence why;
 *   • the page passes the accessibility audit (48px targets, labels) in English and Tamil.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';
const NOW = '2026-10-08T05:00:00.000Z';

const ADMIN = 'u-platform-admin';
const OWNER = 'u-owner';
const PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  [ADMIN]: ['identity.self.read', 'platform.person.provision', 'platform.person.read'],
  [OWNER]: ['identity.self.read', 'identity.role.grant'],
};
/** Somebody who already holds a role: head office refuses them a sign-in made here. */
const HOLDER = 'ravi.s';
const PASSWORD = /^[2-9A-HJ-NP-Z]{4}(-[2-9A-HJ-NP-Z]{4}){3}$/;

interface Recorded { readonly method: string; readonly path: string; readonly body: unknown; readonly headers: Record<string, string | string[] | undefined> }

interface HeadOffice {
  readonly requests: Recorded[];
  readonly events: PersonSignInEvent[];
  readonly issued: DirectoryPerson[];
  signedIn: string;
  offline: boolean;
  readonly screenData: Record<string, unknown>;
  readonly router: Router;
}

function newHeadOffice(signedIn = ADMIN): HeadOffice {
  const events: PersonSignInEvent[] = [];
  const issued: DirectoryPerson[] = [];
  const built = buildRouter([...peopleRoutes({
    now: () => NOW,
    people: () => foldPeople(events),
    recordPerson: (_t, e) => { events.push(e); },
    holdsAnyRole: (_t, userId) => userId === HOLDER,
    directory: { issue: async (p) => { issued.push(p); return { result: 'issued', resumed: false }; }, end: async () => 'none' },
  })]);
  if (!built.ok || built.router === undefined) throw new Error(JSON.stringify(built.refusals));
  return {
    requests: [], events, issued, signedIn, offline: false, router: built.router,
    screenData: { userId: signedIn, permissions: PERMISSIONS[signedIn] ?? [], storeId: 'store-1', now: NOW, dormantAfterDays: 60 },
  };
}

async function call(ho: HeadOffice, method: Method, path: string, body: unknown, key?: string): Promise<{ status: number; body: unknown }> {
  const matched = ho.router.match(method, path);
  if (matched === undefined) return { status: 404, body: { error: { code: 'not_found', whatHappened: `No route ${method} ${path}.` } } };
  if (!(PERMISSIONS[ho.signedIn] ?? []).includes(matched.route.permission)) {
    return { status: 403, body: { error: { code: 'forbidden', whatHappened: `This account does not hold "${matched.route.permission}".` } } };
  }
  try {
    const out = await matched.route.handler({ tenantId: 'tenant', userId: ho.signedIn, branchId: null, params: matched.params, query: {}, body, traceId: 't', ...(key === undefined ? {} : { idempotencyKey: key }) });
    return { status: out.status, body: out.body };
  } catch (e) {
    if (e instanceof ApiError) return { status: e.status, body: { error: e.body } };
    return { status: 500, body: { error: { code: 'internal', whatHappened: String(e) } } };
  }
}

async function startHeadOffice(ho: HeadOffice): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      const method = (req.method ?? 'GET') as Method;
      if (path.startsWith('/v1/')) {
        let body: unknown;
        if (method !== 'GET') {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const raw = Buffer.concat(chunks).toString('utf8');
          body = raw === '' ? undefined : JSON.parse(raw);
        }
        ho.requests.push({ method, path, body, headers: req.headers });
        if (ho.offline) { req.socket.destroy(); return; }
        const key = req.headers['idempotency-key'];
        const answer = await call(ho, method, path, body, typeof key === 'string' ? key : undefined);
        res.writeHead(answer.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(answer.body));
        return;
      }
      const file = path === '/' ? 'admin.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream';
        let out = buf.toString('utf8');
        if (file.endsWith('.html')) out = out.replace('<!--SCREEN-DATA-->', `<script>window.adminData = ${JSON.stringify(ho.screenData).replace(/</g, '\\u003c')};</script>`);
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(out);
      } catch {
        res.writeHead(404); res.end('not found');
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

/** The slice of the browser's globals these callbacks touch. */
interface Dom {
  readonly document: {
    getElementById(id: string): { hidden: boolean; textContent: string | null } | null;
    querySelectorAll(sel: string): ArrayLike<{ attributes: ArrayLike<{ value: string }> }>;
    readonly documentElement: { outerHTML: string };
  };
  readonly localStorage: Record<string, string>;
  readonly sessionStorage: Record<string, string>;
  readonly location: { href: string };
}

const posts = (ho: HeadOffice): Recorded[] => ho.requests.filter((r) => r.method === 'POST' && r.path === '/v1/identity/people');

describe.skipIf(!HAVE_BROWSER)('the administrator gives a named person a sign-in from the Admin screen — end to end in a real browser (OB-15-c-2)', () => {
  let browser: Browser;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);
  afterAll(async () => { await browser?.close(); });

  const openPage = async (ho: HeadOffice) => {
    const srv = await startHeadOffice(ho);
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    await page.click('#tab-people');
    await page.waitForFunction(() => {
      const d = (globalThis as unknown as Dom).document;
      return !/Asking head office/.test(d.getElementById('signins-source-text')?.textContent ?? 'Asking head office');
    }, undefined, { timeout: 10_000 });
    return { page, errors, teardown: async () => { await context.close(); await srv.stop(); } };
  };

  const answer = async (page: Page, expected: RegExp): Promise<string> => {
    await page.waitForFunction((src) => {
      const d = (globalThis as unknown as Dom).document;
      const line = d.getElementById('signins-result');
      return line !== null && !line.hidden && new RegExp(src).test(d.getElementById('signins-result-text')?.textContent ?? '');
    }, expected.source, { timeout: 10_000 });
    return ((await page.textContent('#signins-result-text')) ?? '').trim();
  };

  const give = async (page: Page, displayName: string, signInName: string): Promise<void> => {
    await page.fill('#signin-display', displayName);
    await page.fill('#signin-name', signInName);
    await page.click('#signin-issue');
  };

  it('a shared name and the administrator\'s own are refused on the page; a named person gets a sign-in and the password is shown once, then gone', async () => {
    const ho = newHeadOffice();
    const { page, errors, teardown } = await openPage(ho);
    try {
      expect((await page.textContent('#signins-source-text'))?.trim()).toMatch(/^Head office, as at /);
      expect((await page.textContent('#signins-list'))?.trim()).toBe('Nobody has been given a sign-in from here yet.');
      // No password box, no approver box.
      for (const sel of ['input[type=password]', '#approver', '#password']) expect(await page.locator(`#view-people ${sel}`).count(), sel).toBe(0);

      await give(page, 'Counter Two', 'cashier2');
      expect(await answer(page, /names a job, a place or a shared account/)).toBe('“cashier2” names a job, a place or a shared account, not a person. Use the person’s own name.');
      await give(page, 'Platform Admin', ADMIN);
      expect(await answer(page, /Nobody gives themselves/)).toContain('Nobody gives themselves a sign-in');
      expect(posts(ho), 'nothing was sent for a refusal the page can see').toHaveLength(0);

      await give(page, 'Asha  Kumar', 'Asha.K');
      expect(await answer(page, /Sign-in made for/)).toBe('Sign-in made for Asha Kumar (asha.k).');
      expect(posts(ho)).toHaveLength(1);
      const sent = posts(ho)[0]!;
      expect(sent.body).toEqual({ signInName: 'asha.k', displayName: 'Asha Kumar' });
      expect(typeof sent.headers['idempotency-key']).toBe('string');
      expect(ho.issued.map((p) => [p.username, p.secondFactor])).toEqual([['asha.k', true]]);

      const shown = ((await page.textContent('#handover-otp')) ?? '').trim();
      expect(shown).toMatch(PASSWORD);
      expect(shown).toBe(ho.issued[0]!.temporaryPassword);
      expect(((await page.textContent('#handover-words')) ?? '')).toContain('Give this to Asha Kumar yourself');
      // Nowhere but the panel's text: not in storage, not in any attribute.
      const elsewhere = await page.evaluate((pw) => {
        const g = globalThis as unknown as Dom;
        const inStorage = JSON.stringify({ ...g.localStorage }).includes(pw) || JSON.stringify({ ...g.sessionStorage }).includes(pw);
        const inAttribute = Array.from(g.document.querySelectorAll('*')).some((n) => Array.from(n.attributes).some((a) => a.value.includes(pw)));
        return { inStorage, inAttribute, inUrl: g.location.href.includes(pw) };
      }, shown);
      expect(elsewhere).toEqual({ inStorage: false, inAttribute: false, inUrl: false });
      expect(((await page.textContent('#signins-list')) ?? '')).toContain('Asha Kumar (asha.k)has a sign-in');

      await page.click('#handover-done');
      expect(await page.isHidden('#handover')).toBe(true);
      expect(await page.evaluate((pw) => (globalThis as unknown as Dom).document.documentElement.outerHTML.includes(pw), shown)).toBe(false);
      expect(errors).toEqual([]);
    } finally {
      await teardown();
    }
  });

  it('head office\'s own refusal is said in plain words, in English and Tamil; a lost link gives nothing and says so', async () => {
    const ho = newHeadOffice();
    const { page, teardown } = await openPage(ho);
    try {
      await give(page, 'Ravi Shankar', HOLDER);
      expect(await answer(page, /already holds a role/)).toContain('This person already holds a role.');
      await page.click('#lang');
      await page.waitForFunction('document.documentElement.lang === "ta"');
      expect(await answer(page, /பொறுப்பு/)).toContain('இவருக்கு ஏற்கனவே ஒரு பொறுப்பு உள்ளது');
      expect((await page.textContent('#signins-title'))?.trim()).toBe('உள்நுழைவுகள்');
      await page.click('#lang');
      await page.waitForFunction('document.documentElement.lang === "en"');

      ho.offline = true;
      await give(page, 'Meena Raj', 'meena.r');
      expect(await answer(page, /did not answer/)).toContain('Head office did not answer.');
      expect(await page.isHidden('#handover')).toBe(true);
    } finally {
      await teardown();
    }
  });

  it('somebody without the administrator\'s authority sees no form, with a plain sentence why, and sends nothing', async () => {
    const ho = newHeadOffice(OWNER);
    const { page, teardown } = await openPage(ho);
    try {
      expect(await page.isHidden('#signins-form')).toBe(true);
      expect((await page.textContent('#signins-cannot'))?.trim()).toBe('Only the platform administrator gives sign-ins.');
      expect((await page.textContent('#signins-source-text'))?.trim()).toBe('You may not see who has a sign-in.');
      expect(posts(ho)).toHaveLength(0);
    } finally {
      await teardown();
    }
  });

  it('the page passes the accessibility audit with the password showing, in English and Tamil', async () => {
    const ho = newHeadOffice();
    const { page, teardown } = await openPage(ho);
    try {
      await give(page, 'Asha Kumar', 'asha.k');
      await answer(page, /Sign-in made for/);
      expect(await auditPage(page, { minTarget: 48 }), 'the form, the password and the list').toEqual([]);
      // For a person to look at (never committed): E2E_SHOTS=<folder>.
      const shots = process.env['E2E_SHOTS'];
      if (shots !== undefined) await page.locator('#view-people').screenshot({ path: join(shots, 'people-sign-ins-en.png') });
      await page.click('#lang');
      await page.waitForFunction('document.documentElement.lang === "ta"');
      expect(await auditPage(page, { minTarget: 48, expectLang: 'ta' }), 'the same in Tamil').toEqual([]);
    } finally {
      await teardown();
    }
  });
});
