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
  approvalRequestRoutes, type ApprovalDecision, type ApprovalPort, type ApprovalRequestDeps, type ApprovalState,
} from '../../services/identity/src/approval-requests';
import { financeRoutes, type ControlTotalCheck, type PeriodState } from '../../services/finance/src/index';

/**
 * **A month is closed and reopened at head office, by two people, from a real browser (M23-FR-04 · QG-07 · ADR-0024 ·
 * §28 · audit PA-03 · ADR-0013 — the E2E matrix).**
 *
 * The session model, its words and the browser ports are unit-tested; head office's engine and month routes are
 * integration-tested. The one thing units cannot prove is that a person using the ACTUAL Finance page makes the right
 * writes reach head office under their own session — and that no signer's or approver's name exists anywhere on the
 * page any more. This drives headless Chromium against a stub head office that MOUNTS THE REAL ROUTES — the approval
 * engine's `approvalRequestRoutes` and finance's `financeRoutes` (period close and reopen) — over in-memory storage,
 * with the pipeline's one job here (the caller's permission for the route) done in front of them:
 *
 *   • CLOSE: "Close the month" before asking says nobody was asked (nothing sent); **Ask for the signature** records
 *     the closer's own `period_close` request for exactly `{ period }`; "Close the month" while it waits says so;
 *     once the ACCOUNTANT approves it in their own session, "Close the month" posts `{ approvalId }` — no signer named —
 *     head office closes the month, signed by the accountant, and uses the approval once; the page then offers reopening;
 *   • REOPEN: the typed approver box is gone; Ask without a reason is refused on the page; **Ask for approval** records
 *     `{ reason, period }`; a reason changed after asking is not what was approved (nothing sent); with the approval,
 *     "Reopen the month" posts `{ reason, approvalId }` and head office reopens it;
 *   • rejected → who and why, in English and Tamil; head office's own refusal (the signer posted into the month) →
 *     plain words, the month stays open and the signature is not spent;
 *   • a typed signer or approver sent straight to head office is refused by name;
 *   • the steps pass the same accessibility audit as every page (48px targets, labels), in English and Tamil;
 *   • a page with no head office behind it (the sample) asks nothing and closes nothing, and says so.
 *
 * The browser binary is the environment's pre-installed Chromium; where none is present the suite SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';

const TENANT = 'tenant';
const PERIOD = '2026-09';
const NOW = '2026-10-07T05:00:00.000Z';
/** The owner closes the month (holds `finance.period.close`, and may also sign — but never their own request). */
const CLOSER = 'u-owner';
/** The accountant may sign a month (`finance.period.sign`) but not close one. */
const ACCOUNTANT = 'u-accountant';
const PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  [CLOSER]: ['identity.self.read', 'finance.period.read', 'finance.period.close', 'finance.period.sign'],
  [ACCOUNTANT]: ['identity.self.read', 'finance.period.read', 'finance.period.sign'],
};

const REASON = 'supplier credit note for August arrived late';

/** Head office's own control totals for the month: two sides from two places, agreeing exactly. */
const AGREEING: readonly ControlTotalCheck[] = [
  { name: 'Takings', leftMinor: 100_000_00, rightMinor: 100_000_00, leftDerivation: 'sales ledger', rightDerivation: 'bank deposits' },
];

interface Recorded { readonly method: string; readonly path: string; readonly body: unknown; readonly headers: Record<string, string | string[] | undefined>; }

/** Head office, in memory: the approval engine's records, each month's state, and who posted into it. */
interface HeadOffice {
  readonly requests: Recorded[];
  readonly approvals: Map<string, ApprovalState>;
  readonly versions: Map<string, number>;
  readonly periods: Map<string, PeriodState>;
  readonly closedBy: Map<string, string>;
  posters: readonly string[];
  financeData: Record<string, unknown> | undefined;
  readonly router: Router;
}

function newHeadOffice(opts: { readonly closed?: boolean; readonly financeData?: Record<string, unknown> | 'none' } = {}): HeadOffice {
  const approvals = new Map<string, ApprovalState>();
  const versions = new Map<string, number>();
  const periods = new Map<string, PeriodState>([[PERIOD, opts.closed === true ? 'closed' : 'open']]);
  const closedBy = new Map<string, string>();
  const bump = (id: string): void => { versions.set(id, (versions.get(id) ?? 0) + 1); };
  const permissionsOfUser = (_t: string, userId: string): readonly string[] | undefined => PERMISSIONS[userId];

  const engine: ApprovalRequestDeps = {
    recordRequest: (_t, request) => { approvals.set(request.requestId, { request }); bump(request.requestId); },
    recordDecision: (_t, decision: ApprovalDecision) => {
      const s = approvals.get(decision.requestId)!;
      if (s.decision !== undefined) return s.decision;
      approvals.set(decision.requestId, { ...s, decision });
      bump(decision.requestId);
      return decision;
    },
    approvalState: (_t, id) => approvals.get(id),
    approvalVersion: (_t, id) => versions.get(id) ?? 0,
    allRequests: () => [...approvals.values()],
    permissionsOfUser,
    now: () => NOW,
  };
  const port: ApprovalPort = {
    approvalState: (_t, id) => approvals.get(id),
    approvalVersion: (_t, id) => versions.get(id) ?? 0,
    spendApproval: (_t, id, usedBy) => {
      const s = approvals.get(id);
      if (s === undefined || s.usedBy !== undefined) return false;
      approvals.set(id, { ...s, usedBy });
      bump(id);
      return true;
    },
    permissionsOfUser,
  };
  const ho: HeadOffice = {
    requests: [], approvals, versions, periods, closedBy, posters: ['u-cashier-sync'], financeData: undefined,
    router: undefined as unknown as Router,
  };
  const built = buildRouter([
    ...approvalRequestRoutes(engine),
    ...financeRoutes({
      periodStates: () => periods,
      nextOpenPeriod: () => '2026-10',
      appendJournal: () => {},
      controlTotals: () => AGREEING,
      postersIn: () => ho.posters,
      markClosed: (_t, period, signedBy) => { periods.set(period, 'closed'); closedBy.set(period, signedBy); },
      markReopened: (_t, period) => { periods.set(period, 'open'); },
      approvals: port,
      now: () => NOW,
    }),
  ]);
  if (!built.ok || built.router === undefined) throw new Error(`stub head office refused its routes: ${JSON.stringify(built.refusals)}`);
  (ho as { router: Router }).router = built.router;
  ho.financeData = opts.financeData === 'none' ? undefined : opts.financeData ?? {
    userId: CLOSER, storeId: 'store-1', now: NOW, period: PERIOD, tradingDayCutoff: '02:00',
    journalPrefixes: { takings: 'SALES', tax: 'GST', refunds: 'REFUND' },
    ledger: { takingsMinor: 100_000_00, taxMinor: 5_000_00, refundsMinor: 2_000_00, billCount: 412 },
    postings: [
      { postingId: 'P-1', idempotencyKey: 'k-1', period: PERIOD, journalRef: 'SALES-001', debitMinor: 100_000_00, creditMinor: 100_000_00, state: 'posted', attempts: 1, queuedAt: '2026-09-30T23:00:00.000Z' },
      { postingId: 'P-2', idempotencyKey: 'k-2', period: PERIOD, journalRef: 'GST-001', debitMinor: 5_000_00, creditMinor: 5_000_00, state: 'posted', attempts: 1, queuedAt: '2026-09-30T23:00:00.000Z' },
      { postingId: 'P-3', idempotencyKey: 'k-3', period: PERIOD, journalRef: 'REFUND-001', debitMinor: 2_000_00, creditMinor: 2_000_00, state: 'posted', attempts: 1, queuedAt: '2026-09-30T23:00:00.000Z' },
    ],
    periodState: opts.closed === true ? { closed: true, closedBy: CLOSER, closedAt: '2026-10-02T10:00:00.000Z' } : { closed: false },
    unsentSyncCount: 0, openExceptionCount: 0,
  };
  return ho;
}

/** Call a REAL route as a signed-in person: the pipeline's permission check, then the route's own handler. */
async function call(ho: HeadOffice, userId: string, method: Method, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const matched = ho.router.match(method, path);
  if (matched === undefined) return { status: 404, body: { error: { code: 'not_found', whatHappened: `No route ${method} ${path}.` } } };
  if (!(PERMISSIONS[userId] ?? []).includes(matched.route.permission)) {
    return { status: 403, body: { error: { code: 'forbidden', whatHappened: `${userId} does not hold ${matched.route.permission}.` } } };
  }
  try {
    const out = await matched.route.handler({
      tenantId: TENANT, userId, branchId: null, params: matched.params, query: {}, body, traceId: 'trace-e2e',
      ...(method === 'GET' ? {} : { idempotencyKey: 'key' }),
    });
    return { status: out.status, body: out.body };
  } catch (e) {
    if (e instanceof ApiError) return { status: e.status, body: { error: e.body } };
    return { status: 500, body: { error: { code: 'internal', whatHappened: String(e) } } };
  }
}

/** The accountant decides the closer's request in THEIR own session — the real decide route, as their Approvals page does. */
async function decideAsAccountant(ho: HeadOffice, decision: 'approved' | 'rejected', reason: string): Promise<string> {
  const pending = [...ho.approvals.values()].filter((s) => s.decision === undefined);
  expect(pending, 'exactly one request waits for the accountant').toHaveLength(1);
  const requestId = pending[0]!.request.requestId;
  const answer = await call(ho, ACCOUNTANT, 'POST', `/v1/approvals/requests/${requestId}/decide`, { decision, reason });
  expect(answer.status).toBe(201);
  return requestId;
}

const posts = (ho: HeadOffice, path: string): Recorded[] => ho.requests.filter((r) => r.method === 'POST' && r.path === path);
const CLOSE_PATH = `/v1/finance/periods/${PERIOD}/close`;
const REOPEN_PATH = `/v1/finance/periods/${PERIOD}/reopen`;

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
        // The page is the closer's own session — head office knows them from the sign-in, never from a body value.
        const answer = await call(ho, CLOSER, method, path, body);
        res.writeHead(answer.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer.body));
        return;
      }
      const file = path === '/' ? 'finance.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        let out = buf.toString('utf8');
        if (file.endsWith('.html') && ho.financeData !== undefined) {
          out = out.replace('<!--SCREEN-DATA-->', `<script>window.financeData = ${JSON.stringify(ho.financeData).replace(/</g, '\\u003c')};</script>`);
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
  readonly financeSession?: { readonly connected: boolean };
  readonly document: { getElementById(id: string): { hidden: boolean; textContent: string | null } | null };
}

describe.skipIf(!HAVE_BROWSER)('the month close and reopen at head office, by two people, end to end in a real browser (M23-FR-04 · ADR-0024)', () => {
  let browser: Browser;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  /** Open the Finance page wired to the stub head office (or, with no screen data, on its sample stand-in). */
  const openFinance = async (ho: HeadOffice, wired = true) => {
    const srv = await startHeadOffice(ho);
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    if (wired) {
      await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).financeSession?.connected === true, undefined, { timeout: 10_000 });
    }
    return { page, errors, teardown: async () => { await context.close(); await srv.stop(); } };
  };

  /** Click, wait for the banner to say THIS click's answer, read it, and dismiss it (it covers the top of the page). */
  const clickFor = async (page: Page, button: string, expected: RegExp): Promise<{ title: string; text: string; cls: string }> => {
    await page.click(button);
    await page.waitForFunction(
      (source) => {
        const doc = (globalThis as unknown as BrowserGlobals).document;
        const banner = doc.getElementById('banner');
        return banner !== null && !banner.hidden && new RegExp(source).test(doc.getElementById('banner-text')?.textContent ?? '');
      },
      expected.source, { timeout: 10_000 },
    );
    const said = {
      title: ((await page.textContent('#banner-title')) ?? '').trim(),
      text: ((await page.textContent('#banner-text')) ?? '').trim(),
      cls: (await page.getAttribute('#banner', 'class')) ?? '',
    };
    await page.click('#banner-ok');
    return said;
  };

  const hidden = (page: Page, id: string) => page.evaluate((i) => (globalThis as unknown as BrowserGlobals).document.getElementById(i)?.hidden ?? true, id);

  it('CLOSE: ask for the signature, the accountant approves, and the close names that approval — and nothing else', async () => {
    const ho = newHeadOffice();
    const { page, errors, teardown } = await openFinance(ho);
    try {
      // The local evidence says the figures can be signed; the close step is on the page, the reopen step is not.
      expect(await page.textContent('#verdict')).toBe('These figures agree exactly and nothing is outstanding. They can be signed.');
      expect(await hidden(page, 'close-box')).toBe(false);
      expect(await hidden(page, 'reopen-box')).toBe(true);
      // The page's own controls (the shared chrome's menu search box aside): no box to type a name into.
      expect(await page.locator('main input').count(), 'a box to type a signer or approver into is still on the page').toBe(0);
      expect(await page.getAttribute('#ask-close', 'class')).toContain('primary');
      expect(await page.getAttribute('#close-month', 'class')).not.toContain('primary');

      // Close BEFORE asking: refused on the page, nothing sent.
      const early = await clickFor(page, '#close-month', /nobody has been asked/);
      expect(early.text).toBe('Not closed — nobody has been asked to sign it yet. Press “Ask for the signature” first.');
      expect(posts(ho, CLOSE_PATH)).toHaveLength(0);

      // Ask for the signature — the closer's OWN request, for exactly this month.
      await page.fill('#close-why', 'bank reconciled on the 3rd');
      const asked = await clickFor(page, '#ask-close', /^Asked\./);
      expect(asked.title).toBe('Waiting for approval');
      expect(asked.cls).toContain('pending');
      expect(asked.text).toBe('Asked. Waiting for someone who may sign a month — the accountant or the CA, not you — to approve it on their Approvals page. Nothing is closed yet. Close and sign September 2026');
      const ask = posts(ho, '/v1/approvals/requests');
      expect(ask).toHaveLength(1);
      expect(ask[0]!.body).toEqual({
        kind: 'period_close', subjectRef: PERIOD, details: { period: PERIOD }, valueMinor: null,
        summary: 'Close and sign September 2026', reason: 'bank reconciled on the 3rd',
      });
      expect(ask[0]!.headers['idempotency-key'], 'the ask carries an idempotency key').toBeTruthy();
      expect(posts(ho, CLOSE_PATH), 'asking closes nothing').toHaveLength(0);
      await page.waitForSelector('#close-request:not([hidden])');
      expect((await page.textContent('#close-request'))?.trim()).toBe('…Your request: Waiting for a second person');
      expect(await page.getAttribute('#close-month', 'class')).toContain('primary');
      expect(await page.getAttribute('#ask-close', 'class')).not.toContain('primary');

      // Close while it waits: says so, nothing sent.
      expect((await clickFor(page, '#close-month', /still waiting/)).text)
        .toBe('Not closed — still waiting for someone who may sign a month (the accountant or the CA — not you) to approve it on their Approvals page.');
      expect(posts(ho, CLOSE_PATH)).toHaveLength(0);

      // The ACCOUNTANT approves it, in their own session.
      const requestId = await decideAsAccountant(ho, 'approved', 'checked the bank and Tally for September');

      // Close the month — one POST naming the approval; no signer, no name, no reason in the body.
      const closed = await clickFor(page, '#close-month', /^Closed and signed/);
      expect(closed.title).toBe('Closed and signed');
      expect(closed.cls).toContain('good');
      expect(closed.text).toBe('Closed and signed. u-accountant signed it, and that approval has now been used. A closed month is never edited — a correction is a new entry in the open month.');
      const close = posts(ho, CLOSE_PATH);
      expect(close).toHaveLength(1);
      expect(close[0]!.body).toEqual({ approvalId: requestId });
      for (const typed of ['signedBy', 'approvedBy', 'approval', 'rationale']) expect(close[0]!.body).not.toHaveProperty(typed);
      expect(close[0]!.headers['idempotency-key'], 'the close carries an idempotency key').toBeTruthy();

      // Head office closed it, signed by the accountant, and used the signature once.
      expect(ho.periods.get(PERIOD)).toBe('closed');
      expect(ho.closedBy.get(PERIOD)).toBe(ACCOUNTANT);
      expect(ho.approvals.get(requestId)?.usedBy).toBe(`period-close:${PERIOD}`);

      // The page now reads the month as closed and signed, and offers reopening instead of closing.
      expect(await hidden(page, 'close-box')).toBe(true);
      expect(await hidden(page, 'reopen-box')).toBe(false);
      expect(await page.textContent('#blockers')).toContain(`closed by ${CLOSER} · signed by ${ACCOUNTANT}`);
      expect(errors).toEqual([]);
    } finally {
      await teardown();
    }
  });

  it('REOPEN: no approver box; write why, ask, the accountant approves, and the reopen sends exactly that reason', async () => {
    const ho = newHeadOffice({ closed: true });
    const { page, errors, teardown } = await openFinance(ho);
    try {
      expect(await hidden(page, 'reopen-box')).toBe(false);
      expect(await hidden(page, 'close-box')).toBe(true);
      expect(await page.locator('#reopen-approver, main input').count(), 'the typed approver box is still on the page').toBe(0);
      expect(await page.textContent('#reopen-reason-label')).toBe('Why does it need reopening?');

      // Ask with no reason: refused on the page, nothing asked.
      expect((await clickFor(page, '#ask-reopen', /Write why/)).text)
        .toBe('Write why the month needs reopening — the person approving reads it, and so will the auditor. Nothing was asked.');
      expect(posts(ho, '/v1/approvals/requests')).toHaveLength(0);

      // Ask for approval — for exactly this reason and this month.
      await page.fill('#reopen-reason', REASON);
      const asked = await clickFor(page, '#ask-reopen', /^Asked\./);
      expect(asked.cls).toContain('pending');
      expect(asked.text).toBe('Asked. Waiting for someone who may sign a month — the accountant or the CA, not you — to approve it on their Approvals page. The month stays closed until then. Reopen September 2026');
      const ask = posts(ho, '/v1/approvals/requests');
      expect(ask).toHaveLength(1);
      expect(ask[0]!.body).toEqual({
        kind: 'period_reopen', subjectRef: PERIOD, details: { reason: REASON, period: PERIOD }, valueMinor: null,
        summary: 'Reopen September 2026', reason: REASON,
      });
      // The reason stays in the box: the reopen sends exactly the reason that was approved.
      expect(await page.inputValue('#reopen-reason')).toBe(REASON);

      // Reopen while it waits: says so, nothing sent.
      expect((await clickFor(page, '#reopen', /still waiting/)).text)
        .toBe('Not reopened — still waiting for someone who may sign a month (the accountant or the CA — not you) to approve it on their Approvals page.');
      expect(posts(ho, REOPEN_PATH)).toHaveLength(0);

      const requestId = await decideAsAccountant(ho, 'approved', 'agreed — post the credit note into September');

      // A reason changed after asking is not what was approved: nothing sent.
      await page.fill('#reopen-reason', `${REASON}, and a GST correction`);
      expect((await clickFor(page, '#reopen', /not the one that was approved/)).text)
        .toBe('Not reopened — this reason is not the one that was approved (it changed after you asked). Ask for approval again with this reason.');
      expect(posts(ho, REOPEN_PATH)).toHaveLength(0);

      // The approved reason: one POST with { reason, approvalId } — no approver named.
      await page.fill('#reopen-reason', REASON);
      const reopened = await clickFor(page, '#reopen', /^Reopened\./);
      expect(reopened.title).toBe('Reopened');
      expect(reopened.text).toBe('Reopened. u-accountant approved it, and that approval has now been used. The month is open again, and it must be closed and signed again.');
      const reopen = posts(ho, REOPEN_PATH);
      expect(reopen).toHaveLength(1);
      expect(reopen[0]!.body).toEqual({ reason: REASON, approvalId: requestId });
      expect(reopen[0]!.body).not.toHaveProperty('approvedBy');
      expect(ho.periods.get(PERIOD)).toBe('open');
      expect(ho.approvals.get(requestId)?.usedBy).toBe(`period-reopen:${PERIOD}`);

      // The month is open again: the close step is back, the reopen step is gone.
      expect(await hidden(page, 'reopen-box')).toBe(true);
      expect(await hidden(page, 'close-box')).toBe(false);
      expect(errors).toEqual([]);
    } finally {
      await teardown();
    }
  });

  it('a request still in play is shown when the page is opened again, and its reason is put back in the box', async () => {
    const ho = newHeadOffice({ closed: true });
    // The reopen was asked for earlier (from another visit) and the accountant approved it since.
    await call(ho, CLOSER, 'POST', '/v1/approvals/requests', {
      kind: 'period_reopen', subjectRef: PERIOD, details: { reason: REASON, period: PERIOD }, valueMinor: null,
      summary: 'Reopen September 2026', reason: REASON,
    });
    const requestId = await decideAsAccountant(ho, 'approved', 'agreed');
    const { page, errors, teardown } = await openFinance(ho);
    try {
      await page.waitForSelector('#reopen-request:not([hidden])');
      expect((await page.textContent('#reopen-request'))?.trim()).toBe('✓Your request: Approved by u-accountant — use it before 08-10-2026 10:30');
      expect(await page.inputValue('#reopen-reason')).toBe(REASON);
      const reopened = await clickFor(page, '#reopen', /^Reopened\./);
      expect(reopened.title).toBe('Reopened');
      expect(posts(ho, REOPEN_PATH)[0]!.body).toEqual({ reason: REASON, approvalId: requestId });
      expect(errors).toEqual([]);
    } finally {
      await teardown();
    }
  });

  it('REJECTED says who and why, in English and Tamil; head office\'s own refusal is plain words and spends nothing', async () => {
    const ho = newHeadOffice();
    const { page, teardown } = await openFinance(ho);
    try {
      await clickFor(page, '#ask-close', /^Asked\./);
      await decideAsAccountant(ho, 'rejected', 'the cash count for the 14th is missing');
      expect((await clickFor(page, '#close-month', /rejected it/)).text)
        .toBe('Not closed — u-accountant rejected it: “the cash count for the 14th is missing”. Settle what they said and ask again.');
      expect(posts(ho, CLOSE_PATH), 'a rejected close must not be sent').toHaveLength(0);
      expect((await page.textContent('#close-request'))?.trim()).toBe('✕Your request: Rejected by u-accountant: the cash count for the 14th is missing');

      await page.click('#lang');
      await page.waitForFunction('document.documentElement.lang === "ta"');
      expect(await page.textContent('#ask-close')).toBe('கையெழுத்து கேள்');
      expect(await page.textContent('#close-month')).toBe('மாதத்தை மூடு');
      const ta = await clickFor(page, '#close-month', /மறுத்தார்/);
      expect(ta.text).toBe('மூடப்படவில்லை — u-accountant மறுத்தார்: “the cash count for the 14th is missing”. அவர் சொன்னதைச் சரிசெய்து மீண்டும் கேளுங்கள்.');
      expect(posts(ho, CLOSE_PATH)).toHaveLength(0);
      await page.click('#lang');
      await page.waitForFunction('document.documentElement.lang === "en"');

      // Ask again; the accountant approves — but they posted into the month, so head office refuses them as signer.
      await clickFor(page, '#ask-close', /^Asked\./);
      const second = await decideAsAccountant(ho, 'approved', 'fine now');
      ho.posters = ['u-cashier-sync', ACCOUNTANT];
      expect((await clickFor(page, '#close-month', /posted entries into this month/)).text)
        .toBe('Not closed — the person who signed also posted entries into this month, and cannot also certify that it is right. Ask again, and have someone else who may sign a month — who did not post into it — approve it.');
      expect(posts(ho, CLOSE_PATH)).toHaveLength(1);
      expect(ho.periods.get(PERIOD), 'the month stays open').toBe('open');
      expect(ho.approvals.get(second)?.usedBy, 'a refused close spends no signature').toBeUndefined();
      expect(await hidden(page, 'close-box')).toBe(false);
    } finally {
      await teardown();
    }
  });

  it('head office refuses a typed signer or approver by name — the page could not send one anyway', async () => {
    const ho = newHeadOffice();
    const { page, teardown } = await openFinance(ho);
    try {
      const sent = await page.evaluate(async (paths) => {
        const post = async (path: string, body: unknown) => {
          const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `k-${path}` }, body: JSON.stringify(body) });
          return { status: res.status, body: await res.json() as { error?: { code?: string } } };
        };
        return [await post(paths[0]!, { signedBy: 'u-accountant' }), await post(paths[1]!, { reason: 'late note', approvedBy: 'u-accountant' })];
      }, [CLOSE_PATH, REOPEN_PATH]);
      expect(sent[0]).toMatchObject({ status: 422, body: { error: { code: 'approver_named_without_approval' } } });
      expect(sent[1]).toMatchObject({ status: 422, body: { error: { code: 'approver_named_without_approval' } } });
      expect(ho.periods.get(PERIOD)).toBe('open');
    } finally {
      await teardown();
    }
  });

  it('the steps and the waiting banner pass the same accessibility audit as every page — in English and in Tamil', async () => {
    const ho = newHeadOffice();
    const { page, teardown } = await openFinance(ho);
    try {
      // Contrast, names, labels (the note box has one), 48px targets, one language — with the close step showing.
      expect(await auditPage(page, { minTarget: 48 }), 'the close step').toEqual([]);
      await page.click('#ask-close');
      await page.waitForSelector('#banner.pending:not([hidden])', { timeout: 10_000 });
      expect(await auditPage(page, { minTarget: 48 }), 'the waiting banner').toEqual([]);
      await page.click('#banner-ok');
      await page.click('#lang');
      await page.waitForFunction('document.documentElement.lang === "ta"');
      expect(await page.textContent('#close-why-label')).toBe('கையெழுத்திடுபவருக்கு ஒரு குறிப்பு (விருப்பமானால்)');
      expect(await auditPage(page, { minTarget: 48, expectLang: 'ta' }), 'the close step in Tamil').toEqual([]);
    } finally {
      await teardown();
    }
    const closed = newHeadOffice({ closed: true });
    const reopenPage = await openFinance(closed);
    try {
      expect(await auditPage(reopenPage.page, { minTarget: 48 }), 'the reopen step').toEqual([]);
      await reopenPage.page.click('#lang');
      await reopenPage.page.waitForFunction('document.documentElement.lang === "ta"');
      expect(await reopenPage.page.textContent('#ask-reopen')).toBe('அனுமதி கேள்');
      expect(await auditPage(reopenPage.page, { minTarget: 48, expectLang: 'ta' }), 'the reopen step in Tamil').toEqual([]);
    } finally {
      await reopenPage.teardown();
    }
  });

  it('a page with no head office behind it asks nothing and closes nothing — and says so', async () => {
    const ho = newHeadOffice({ financeData: 'none' });
    const { page, errors, teardown } = await openFinance(ho, false);
    try {
      expect(await hidden(page, 'sample')).toBe(false);
      const said = await clickFor(page, '#ask-close', /not connected to head office/);
      expect(said.text).toBe('This is sample data and is not connected to head office. Closing and reopening a month happen at head office, with a second person’s approval — nothing was asked and nothing was changed.');
      expect((await clickFor(page, '#close-month', /not connected to head office/)).title).toBe('Please read this');
      expect(ho.requests.filter((r) => r.method !== 'GET'), 'the sample sent something').toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await teardown();
    }
  });
});
