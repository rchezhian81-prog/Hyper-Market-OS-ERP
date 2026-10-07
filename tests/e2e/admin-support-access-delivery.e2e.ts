import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { auditPage } from './lib/a11y-audit';
import { ApiError, buildRouter, type Method, type Router } from '../../services/kernel/src/index';
import {
  projectSupportAccess, supportAccessLifecycleRoutes, type SupportAccessEvent, type SupportAccessRecord,
} from '../../services/platform/src/support-access-lifecycle';

/**
 * **Outside access is decided by the OWNER, in their own session, on head office's own lifecycle — in a real browser
 * (M33-FR-03 · SEC-11 · §28 · ADR-0024 · audit PA-03, register "the admin support grant" — the E2E matrix).**
 *
 * The admin screen used to carry a local "let somebody in" form whose approver was a name typed into a box, and whose
 * grant never reached head office. The session model, its words and the browser port are unit-tested; the lifecycle is
 * integration-tested. The one thing units cannot prove is that a person using the ACTUAL Admin page sees what head
 * office holds and that their presses reach head office under their own session, naming nobody. This drives headless
 * Chromium against a stub head office that MOUNTS THE REAL ROUTES — `supportAccessLifecycleRoutes` over an in-memory,
 * append-only event log folded by the real `projectSupportAccess` — with the pipeline's one job here (the caller's
 * permission for the route) done in front of them:
 *
 *   • a support person files a request through the REAL request route (their own act — the page files nothing);
 *   • the owner opens the page: the request is listed with who, why, what and for how long; there is no requester,
 *     scope, minutes-to-grant or approver box anywhere;
 *   • a window LONGER than asked is refused on the page in plain words — nothing is POSTed;
 *   • a SHORTER window is approved: one POST of `{ decision, grantedMinutes }` with an idempotency key and no decider;
 *     head office records the owner as the decider and the session shows as live, with its minutes left;
 *   • a second request is rejected: `{ decision: 'rejected' }`; head office records it, and the page says so;
 *   • the live session is ended early through the real end route, and shows as ended;
 *   • head office's own refusals in plain words, in English and Tamil: 409 already decided, 422 a forbidden scope,
 *     403 not permitted; a lost link decides nothing and says so; the person's own request is shown, never offered;
 *   • a person without the owner's authority sees the list read-only, with a plain sentence why — and sends nothing;
 *   • the page passes the same accessibility audit as every page (48px targets, labels), in English and Tamil;
 *   • a page with no head office behind it (the sample) says so and sends nothing.
 *
 * The browser binary is the environment's pre-installed Chromium; where none is present the suite SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';

const TENANT = 'tenant';
/** 10:30 in the shop (IST). */
const NOW = '2026-10-07T05:00:00.000Z';
const at = (minutes: number): string => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();

/** The owner decides outside access (and, like the owner role, may also file a request of their own). */
const OWNER = 'u-owner';
/** An outside support person: may file a request, nothing else. */
const SUPPORT = 'u-support';
/** The store manager may READ outside access, not decide it. */
const MANAGER = 'u-manager';
const PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  [OWNER]: ['identity.self.read', 'platform.support.request', 'platform.support.grant', 'platform.support.read'],
  [SUPPORT]: ['identity.self.read', 'platform.support.request'],
  [MANAGER]: ['identity.self.read', 'platform.support.read'],
};

const DECISION = '/v1/platform/support-access/requests/';
const END = '/v1/platform/support-access/sessions/';

interface Recorded { readonly method: string; readonly path: string; readonly body: unknown; readonly headers: Record<string, string | string[] | undefined>; }

/** Head office, in memory: the append-only support-access log, its clock, and every request the page made. */
interface HeadOffice {
  readonly requests: Recorded[];
  readonly events: SupportAccessEvent[];
  clock: string;
  /** Who the page is signed in as. */
  signedIn: string;
  /** When true, every head-office call is cut mid-flight (the link is down). */
  offline: boolean;
  /** What the store computer tells the page (`window.adminData`), or nothing (the sample). */
  screenData: Record<string, unknown> | undefined;
  readonly router: Router;
  record(id: string): SupportAccessRecord | undefined;
}

function newHeadOffice(opts: { readonly signedIn?: string; readonly screenData?: 'none'; readonly permissionsOnPage?: readonly string[] } = {}): HeadOffice {
  const events: SupportAccessEvent[] = [];
  const keys = new Set<string>();
  const signedIn = opts.signedIn ?? OWNER;
  const ho: HeadOffice = {
    requests: [], events, clock: NOW, signedIn, offline: false,
    screenData: opts.screenData === 'none' ? undefined : {
      userId: signedIn, permissions: opts.permissionsOnPage ?? PERMISSIONS[signedIn] ?? [], storeId: 'store-1', now: NOW, dormantAfterDays: 60,
    },
    router: undefined as unknown as Router,
    record: (id) => projectSupportAccess(events).find((r) => r.requestId === id),
  };
  const built = buildRouter([...supportAccessLifecycleRoutes({
    records: () => projectSupportAccess(events),
    // Append-only and idempotent on the key, as the real store is.
    recordEvent: (_t, event, key) => { if (keys.has(key)) return; keys.add(key); events.push(event); },
    now: () => ho.clock,
  })]);
  if (!built.ok || built.router === undefined) throw new Error(`stub head office refused its routes: ${JSON.stringify(built.refusals)}`);
  (ho as { router: Router }).router = built.router;
  return ho;
}

/** Call a REAL route as a signed-in person: the pipeline's permission check, then the route's own handler. */
async function call(ho: HeadOffice, userId: string, method: Method, path: string, body: unknown, idempotencyKey?: string): Promise<{ status: number; body: unknown }> {
  const matched = ho.router.match(method, path);
  if (matched === undefined) return { status: 404, body: { error: { code: 'not_found', whatHappened: `No route ${method} ${path}.` } } };
  if (!(PERMISSIONS[userId] ?? []).includes(matched.route.permission)) {
    return { status: 403, body: { error: { code: 'forbidden', whatHappened: `This account does not hold "${matched.route.permission}".` } } };
  }
  try {
    const out = await matched.route.handler({
      tenantId: TENANT, userId, branchId: null, params: matched.params, query: {}, body, traceId: 'trace-e2e',
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    });
    return { status: out.status, body: out.body };
  } catch (e) {
    if (e instanceof ApiError) return { status: e.status, body: { error: e.body } };
    return { status: 500, body: { error: { code: 'internal', whatHappened: String(e) } } };
  }
}

let filed = 0;
/** A person files a support request through the REAL request route, in THEIR own session — never from the page. */
async function fileRequest(ho: HeadOffice, by: string, requestId: string, over: Record<string, unknown> = {}): Promise<void> {
  filed += 1;
  const answer = await call(ho, by, 'POST', '/v1/platform/support-access/requests', {
    requestId, requesterName: 'Ravi (vendor support)', reason: 'checking why last night’s settlement file was imported twice',
    scopes: ['read:settlements', 'read:sales'], minutes: 120, ...over,
  }, `file-${requestId}-${filed}`);
  expect(answer.status, JSON.stringify(answer.body)).toBe(201);
}

const posts = (ho: HeadOffice, prefix: string): Recorded[] => ho.requests.filter((r) => r.method === 'POST' && r.path.startsWith(prefix));

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
        // The link is down: the call never gets an answer.
        if (ho.offline) { req.socket.destroy(); return; }
        // The page is the signed-in person's own session — head office knows them from the sign-in, never from a body.
        const key = req.headers['idempotency-key'];
        const answer = await call(ho, ho.signedIn, method, path, body, typeof key === 'string' ? key : undefined);
        res.writeHead(answer.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer.body));
        return;
      }
      const file = path === '/' ? 'admin.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        let out = buf.toString('utf8');
        if (file.endsWith('.html') && ho.screenData !== undefined) {
          out = out.replace('<!--SCREEN-DATA-->', `<script>window.adminData = ${JSON.stringify(ho.screenData).replace(/</g, '\\u003c')};</script>`);
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

/** The slice of the browser's globals these callbacks touch, cast structurally inside each evaluate. */
interface BrowserGlobals {
  readonly adminSession?: { readonly connected: boolean };
  readonly document: { getElementById(id: string): { hidden: boolean; textContent: string | null } | null };
}

describe.skipIf(!HAVE_BROWSER)('outside access is decided by the owner in their own session, on head office’s lifecycle — end to end in a real browser (M33-FR-03 · PA-03)', () => {
  let browser: Browser;

  beforeAll(async () => {
    // Build the CURRENT web-erp bundle so the browser runs this branch's code, not a stale artifact.
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  /** Open the page wired to the stub head office (or, with no screen data, on its sample stand-in), and wait for its
   *  first read of head office to be painted. */
  const openPage = async (ho: HeadOffice) => {
    const srv = await startHeadOffice(ho);
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    if (ho.screenData !== undefined) {
      await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).adminSession?.connected === true, undefined, { timeout: 10_000 });
      await page.waitForFunction(() => !/Asking head office/.test((globalThis as unknown as BrowserGlobals).document.getElementById('support-source-text')?.textContent ?? 'Asking head office'), undefined, { timeout: 10_000 });
    }
    return { page, errors, teardown: async () => { await context.close(); await srv.stop(); } };
  };

  /** Click, wait for the answer line to say THIS click's answer, and read it. */
  const clickFor = async (page: Page, click: () => Promise<void>, expected: RegExp): Promise<{ text: string; cls: string }> => {
    await click();
    await page.waitForFunction(
      (source) => {
        const doc = (globalThis as unknown as BrowserGlobals).document;
        const result = doc.getElementById('support-result');
        return result !== null && !result.hidden && new RegExp(source).test(doc.getElementById('support-result-text')?.textContent ?? '');
      },
      expected.source, { timeout: 10_000 },
    );
    return { text: ((await page.textContent('#support-result-text')) ?? '').trim(), cls: (await page.getAttribute('#support-result', 'class')) ?? '' };
  };

  const waitingRow = (page: Page, who: string) => page.locator('#waiting-list li.wait', { hasText: who });
  /** Press "Check again" and wait for head office's answer to be painted (the button is busy until then). */
  const checkAgain = async (page: Page): Promise<void> => {
    await page.click('#support-check');
    await page.waitForFunction(() => !(globalThis as unknown as { document: { getElementById(id: string): { disabled: boolean } | null } }).document.getElementById('support-check')?.disabled, undefined, { timeout: 10_000 });
  };

  it('a support person files; the owner approves a SHORTER window on the page; it is live; a second request is rejected; the session is ended early', async () => {
    const ho = newHeadOffice();
    await fileRequest(ho, SUPPORT, 'sup-1');
    ho.clock = at(2);
    const { page, errors, teardown } = await openPage(ho);
    try {
      // No box on this page for a requester, a scope list, minutes to grant, or an approver.
      for (const id of ['#approver', '#who-in', '#scopes', '#grant', '#grant-reason', '#minutes']) {
        expect(await page.locator(id).count(), `the page still has ${id}`).toBe(0);
      }
      expect((await page.textContent('#support-source-text'))?.trim()).toBe('From head office, as at 07-10-2026 10:32.');
      expect((await page.textContent('#waiting-title'))?.trim()).toBe('Waiting for your decision');
      const row = waitingRow(page, 'Ravi (vendor support)');
      expect(await row.count()).toBe(1);
      const said = (await row.textContent()) ?? '';
      expect(said).toContain('Ravi (vendor support) — for 120 minutes');
      expect(said).toContain('Why: checking why last night’s settlement file was imported twice');
      expect(said).toContain('Wants to see: read:settlements, read:sales');
      expect(said).toContain(`Asked by: Ravi (vendor support) (${SUPPORT}) · Asked at: 07-10-2026 10:30`);
      expect((await row.locator('label').textContent())?.trim()).toBe('Let them in for fewer minutes (optional — at most 120)');
      expect(await page.isHidden('#cannot-decide')).toBe(true);
      // Nothing was written on load.
      expect(ho.requests.filter((r) => r.method !== 'GET'), 'the page wrote something on load').toEqual([]);

      // LONGER than asked: refused on the page, in plain words — nothing sent.
      await row.locator('input.minutes').fill('150');
      const longer = await clickFor(page, () => row.locator('button.approve').click(), /never lengthen/);
      expect(longer.text).toBe('You can only shorten the time, never lengthen it. They asked for 120 minutes; 150 is longer. Nothing was sent.');
      expect(longer.cls).toContain('tone-error');
      expect(posts(ho, DECISION), 'a longer window was sent').toHaveLength(0);

      // SHORTER: one POST of the decision and the minutes — no decider, an idempotency key, the owner's own session.
      await row.locator('input.minutes').fill('45');
      const approved = await clickFor(page, () => row.locator('button.approve').click(), /^Approved\./);
      expect(approved.text).toBe('Approved. Ravi (vendor support) may see read:settlements, read:sales for 45 minutes, until 07-10-2026 11:17. It ends by itself.');
      expect(approved.cls).toContain('tone-ok');
      const sent = posts(ho, DECISION);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.path).toBe('/v1/platform/support-access/requests/sup-1/decision');
      expect(sent[0]!.body).toEqual({ decision: 'approved', grantedMinutes: 45 });
      for (const typed of ['decidedBy', 'approvedBy', 'approval', 'requesterId']) expect(sent[0]!.body).not.toHaveProperty(typed);
      expect(sent[0]!.headers['idempotency-key'], 'the decision carries an idempotency key').toBeTruthy();
      // Head office recorded the OWNER as the decider — from the sign-in — and a 45-minute window.
      expect(ho.record('sup-1')).toMatchObject({ status: 'approved', decidedBy: OWNER, session: { approvedBy: OWNER, requesterId: SUPPORT, expiresAt: '2026-10-07T05:47:00Z' } });

      // Read again: nothing waits; Ravi is live, drawn as the loudest thing on the page.
      await page.waitForSelector('#nothing-waiting:not([hidden])');
      expect((await page.textContent('#nothing-waiting'))?.trim()).toBe('Nobody is waiting for a decision.');
      const live = page.locator('#support-list .row.live');
      expect(await live.count()).toBe(1);
      expect((await live.locator('strong').textContent())?.trim()).toBe('Ravi (vendor support) — IN YOUR DATA NOW (45 minutes left)');
      expect(await live.textContent()).toContain('from 07-10-2026 10:32 until 07-10-2026 11:17');
      expect(await live.textContent()).toContain(`approved by ${OWNER}`);

      // A second request, filed by the support person; the owner checks again and REJECTS it.
      ho.clock = at(5);
      await fileRequest(ho, SUPPORT, 'sup-2', { requesterName: 'Kumar (till vendor)', reason: 'reading the till error log after the 9am freeze', scopes: ['read:devices'], minutes: 30 });
      await checkAgain(page);
      const second = waitingRow(page, 'Kumar (till vendor)');
      await second.waitFor();
      const rejected = await clickFor(page, () => second.locator('button.reject').click(), /^Rejected\./);
      expect(rejected.text).toBe('Rejected. Kumar (till vendor) was not let in.');
      expect(posts(ho, DECISION)[1]!.body).toEqual({ decision: 'rejected' });
      expect(ho.record('sup-2')).toMatchObject({ status: 'rejected', decidedBy: OWNER });
      expect(ho.record('sup-2')?.session, 'a rejected request let somebody in').toBeUndefined();
      expect(await waitingRow(page, 'Kumar (till vendor)').count()).toBe(0);

      // END Ravi's session early — the real end route, the owner's own session.
      ho.clock = at(10);
      const ended = await clickFor(page, () => page.locator('#support-list .row.live button.end').click(), /^Ended\./);
      expect(ended.text).toBe('Ended. Ravi (vendor support) can no longer see your data — from 07-10-2026 10:40.');
      expect(posts(ho, END).map((r) => r.path)).toEqual(['/v1/platform/support-access/sessions/sup-1/end']);
      expect(posts(ho, END)[0]!.headers['idempotency-key']).toBeTruthy();
      expect(ho.record('sup-1')?.session?.endedAt).toBe(at(10));
      expect(await page.locator('#support-list .row.live').count()).toBe(0);
      const over = page.locator('#support-list .row.over');
      expect((await over.locator('strong').textContent())?.trim()).toBe('Ravi (vendor support) — finished');
      expect(await over.textContent()).toContain('ended early at 07-10-2026 10:40');
      expect(errors).toEqual([]);
    } finally {
      await teardown();
    }
  });

  it('head office’s own refusals are plain words — 409 already decided, 422 a forbidden scope (in Tamil too) — and the owner’s own request is never offered', async () => {
    const ho = newHeadOffice();
    await fileRequest(ho, SUPPORT, 'sup-3', { requesterName: 'Selvi (vendor support)' });
    await fileRequest(ho, SUPPORT, 'sup-4', { requesterName: 'Arun (payments vendor)', scopes: ['payment.commit'], minutes: 30 });
    // The owner filed one of their own (the owner role may file) — someone else must decide it.
    await fileRequest(ho, OWNER, 'sup-5', { requesterName: 'The owner, for the accountant', scopes: ['read:ledgers'], minutes: 20 });
    ho.clock = at(1);
    const { page, errors, teardown } = await openPage(ho);
    try {
      // §28: the owner's own request is shown, with why they cannot decide it — and no buttons.
      const own = waitingRow(page, 'The owner, for the accountant');
      expect((await own.locator('.own').textContent())?.trim()).toBe('You asked for this, so someone else must decide it.');
      expect(await own.locator('button').count()).toBe(0);

      // 409: the owner decided sup-3 in another tab meanwhile; this page's press is told so — and the list re-reads.
      const decidedElsewhere = await call(ho, OWNER, 'POST', '/v1/platform/support-access/requests/sup-3/decision', { decision: 'approved' }, 'other-tab');
      expect(decidedElsewhere.status).toBe(200);
      const stale = waitingRow(page, 'Selvi (vendor support)');
      const already = await clickFor(page, () => stale.locator('button.approve').click(), /already decided/);
      expect(already.text).toBe('Someone already decided this request: Request \'sup-3\' is already approved.');
      expect(already.cls).toContain('tone-degraded');
      await page.waitForFunction(() => !/Selvi/.test((globalThis as unknown as BrowserGlobals).document.getElementById('waiting-list')?.textContent ?? ''));

      // 422: support may never hold a money scope — head office's rule, in head office's words; nobody let in.
      const money = waitingRow(page, 'Arun (payments vendor)');
      const refused = await clickFor(page, () => money.locator('button.approve').click(), /rules refused/);
      expect(refused.text).toBe('Head office’s rules refused this, and nobody was let in: support may never hold payment.commit — the people who fix the system do not approve its money');
      expect(refused.cls).toContain('tone-error');
      expect(ho.record('sup-4')).toMatchObject({ status: 'pending' });
      expect(ho.record('sup-4')?.session).toBeUndefined();

      // The answer on screen is said again in Tamil, and the page's own words are Tamil.
      await page.click('#lang');
      await page.waitForFunction('document.documentElement.lang === "ta"');
      expect((await page.textContent('#support-result-text'))?.trim())
        .toBe('தலைமை அலுவலகத்தின் விதிகள் இதை மறுத்தன, யாரும் உள்ளே அனுமதிக்கப்படவில்லை: support may never hold payment.commit — the people who fix the system do not approve its money');
      expect((await page.textContent('#waiting-title'))?.trim()).toBe('உங்கள் முடிவுக்காகக் காத்திருப்பவை');
      expect((await waitingRow(page, 'Arun (payments vendor)').locator('button.approve').textContent())?.trim()).toBe('அனுமதி');
      expect((await waitingRow(page, 'Arun (payments vendor)').locator('button.reject').textContent())?.trim()).toBe('மறு');
      expect((await page.textContent('#support-check'))?.trim()).toBe('மீண்டும் சரிபார்');
      expect(errors).toEqual([]);
    } finally {
      await teardown();
    }
  });

  it('a lost link decides nothing and says so; until head office answers again, nothing can be decided at all', async () => {
    const ho = newHeadOffice();
    await fileRequest(ho, SUPPORT, 'sup-6');
    const { page, teardown } = await openPage(ho);
    try {
      ho.offline = true;
      const row = waitingRow(page, 'Ravi (vendor support)');
      const lost = await clickFor(page, () => row.locator('button.approve').click(), /No connection/);
      expect(lost.text).toBe('No connection to head office — nothing was decided. Try again.');
      expect(ho.record('sup-6')).toMatchObject({ status: 'pending' });

      // Check again while still cut off: the page says what it last knew, and that nothing can be decided.
      await checkAgain(page);
      expect((await page.textContent('#support-source-text'))?.trim())
        .toBe('No connection to head office. What is shown is what head office said at 07-10-2026 10:30 — nothing can be decided until it answers again. Press “Check again”.');
      expect((await page.textContent('#cannot-decide'))?.trim()).toBe('Head office has not answered, so nothing can be decided until it does. Press “Check again”.');
      expect(await waitingRow(page, 'Ravi (vendor support)').locator('button').count(), 'decisions offered against a stale list').toBe(0);
      expect(await page.isHidden('#nothing-waiting'), 'a list head office did not give read as "nobody is waiting"').toBe(true);

      // Back online: check again, and it can be decided.
      ho.offline = false;
      await checkAgain(page);
      expect((await page.textContent('#support-source-text'))?.trim()).toBe('From head office, as at 07-10-2026 10:30.');
      expect(await waitingRow(page, 'Ravi (vendor support)').locator('button.approve').count()).toBe(1);
    } finally {
      await teardown();
    }
  });

  it('a person without the owner’s authority sees the list read-only, with a plain sentence why — and head office is still the gate', async () => {
    const ho = newHeadOffice({ signedIn: MANAGER });
    await fileRequest(ho, SUPPORT, 'sup-7');
    const { page, errors, teardown } = await openPage(ho);
    try {
      const row = waitingRow(page, 'Ravi (vendor support)');
      expect(await row.count(), 'the waiting list is still shown').toBe(1);
      expect((await page.textContent('#cannot-decide'))?.trim()).toBe('You can see these requests, but only the owner decides who is let in, and you do not hold that permission.');
      expect(await row.locator('button, input').count()).toBe(0);
      expect(ho.requests.filter((r) => r.method !== 'GET'), 'a reader sent something').toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await teardown();
    }

    // The store computer's word is stale — it says this manager may decide — but head office does not agree: 403.
    const stale = newHeadOffice({ signedIn: MANAGER, permissionsOnPage: [...PERMISSIONS[MANAGER]!, 'platform.support.grant'] });
    await fileRequest(stale, SUPPORT, 'sup-8');
    const second = await openPage(stale);
    try {
      const forbidden = await clickFor(second.page, () => waitingRow(second.page, 'Ravi (vendor support)').locator('button.approve').click(), /not permitted/);
      expect(forbidden.text).toBe('Head office says you are not permitted to decide outside access. Nothing was decided.');
      expect(stale.record('sup-8')).toMatchObject({ status: 'pending' });
    } finally {
      await second.teardown();
    }
  });

  it('the waiting request, the decision and a live session pass the same accessibility audit as every page — in English and in Tamil', async () => {
    const ho = newHeadOffice();
    await fileRequest(ho, SUPPORT, 'sup-9');
    await fileRequest(ho, SUPPORT, 'sup-10', { requesterName: 'Kumar (till vendor)', scopes: ['read:devices'], minutes: 30 });
    await call(ho, OWNER, 'POST', '/v1/platform/support-access/requests/sup-10/decision', { decision: 'approved' }, 'pre-approve');
    const { page, teardown } = await openPage(ho);
    try {
      await clickFor(page, () => waitingRow(page, 'Ravi (vendor support)').locator('button.approve').click(), /^Approved\./);
      await fileRequest(ho, SUPPORT, 'sup-11', { requesterName: 'Meena (label printer vendor)', scopes: ['read:printers'], minutes: 15 });
      await checkAgain(page);
      await waitingRow(page, 'Meena (label printer vendor)').waitFor();
      expect(await auditPage(page, { minTarget: 48 }), 'the waiting request, the answer and the live sessions').toEqual([]);
      await page.click('#lang');
      await page.waitForFunction('document.documentElement.lang === "ta"');
      expect(await auditPage(page, { minTarget: 48, expectLang: 'ta' }), 'the same in Tamil').toEqual([]);
    } finally {
      await teardown();
    }
  });

  it('a page with no head office behind it says so, shows nothing to decide, and sends nothing', async () => {
    const ho = newHeadOffice({ screenData: 'none' });
    await fileRequest(ho, SUPPORT, 'sup-12');
    const { page, errors, teardown } = await openPage(ho);
    try {
      expect(await page.isHidden('#sample')).toBe(false);
      await page.waitForFunction(() => /not connected to head office/.test((globalThis as unknown as BrowserGlobals).document.getElementById('support-source-text')?.textContent ?? ''));
      expect((await page.textContent('#support-source-text'))?.trim())
        .toBe('This is sample data and is not connected to head office — nothing is shown as waiting and nothing can be decided here.');
      expect(await page.isHidden('#support-decisions')).toBe(true);
      expect(await page.isHidden('#support-check')).toBe(true);
      expect(await page.locator('#support-list button').count()).toBe(0);
      expect(ho.requests, 'the sample called head office').toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await teardown();
    }
  });
});
