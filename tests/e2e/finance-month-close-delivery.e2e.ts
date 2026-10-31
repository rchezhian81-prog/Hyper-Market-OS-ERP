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
import { financeRoutes, type ControlTotalCheck, type PeriodState, type JournalEntry } from '../../services/finance/src/index';
import { budgetAssetRoutes, type BudgetVersion, type FixedAssetFact } from '../../services/finance/src/budgets-assets';

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
 *   • CLOSE (OB-567, owner, 31 Oct 2026): the month is closed ONLY on head office's Month-end page. The Finance page
 *     offers no close of its own: it says so in English and Tamil, links to the Month-end page, and sends nothing; once
 *     head office has the month closed, the page reads it as closed and signed and offers reopening;
 *   • REOPEN: the typed approver box is gone; Ask without a reason is refused on the page; **Ask for approval** records
 *     `{ reason, period }`; a reason changed after asking is not what was approved (nothing sent); with the approval,
 *     "Reopen the month" posts `{ reason, approvalId }` and head office reopens it;
 *   • rejected → who and why, in English and Tamil (on the reopen); nothing is sent and the month stays closed;
 *   • a typed signer or approver sent straight to head office is refused by name;
 *   • the steps pass the same accessibility audit as every page (48px targets, labels), in English and Tamil;
 *   • a page with no head office behind it (the sample) asks nothing and closes nothing.
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

/** OB-57: one budget version, one freezer on the register, and its September depreciation in the books. */
const PLAN_BUDGETS: readonly BudgetVersion[] = [{ period: PERIOD, version: 1, lines: [{ account: 'depreciation_expense', amountMinor: 12_000 }], setBy: 'u-owner', at: NOW, reason: 'first cut' }];
const PLAN_ASSETS: readonly FixedAssetFact[] = [{ kind: 'added', assetId: 'FRZ-1', name: 'Chest freezer 500L', category: 'freezer', storeId: 'store-2', costMinor: 120_000, salvageMinor: 0, usefulLifeMonths: 12, inServiceDate: '2026-09-01', by: 'u-owner', at: NOW }];
const PLAN_JOURNALS: readonly (JournalEntry & { fixedAsset: unknown })[] = [{
  entryId: 'fa-dep:FRZ-1:2026-09', period: PERIOD, documentDate: '2026-09-30', narrative: 'Depreciation of FRZ-1 for 2026-09', postedBy: 'u-accountant',
  lines: [{ accountCode: 'depreciation_expense', debitMinor: 10_000, creditMinor: 0 }, { accountCode: 'accumulated_depreciation', debitMinor: 0, creditMinor: 10_000 }],
  fixedAsset: { assetId: 'FRZ-1', kind: 'depreciation', month: PERIOD, storeId: 'store-2', amountMinor: 10_000 },
}];

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
    // OB-57: head office's budget and fixed-asset register, as the real routes read them (in memory here).
    ...budgetAssetRoutes({
      periodStates: () => periods, appendJournal: () => {}, now: () => NOW,
      budgets: async () => PLAN_BUDGETS, recordBudget: async () => true,
      assetFacts: async () => PLAN_ASSETS, recordAssetFact: async () => {},
      journals: async () => PLAN_JOURNALS, accountClasses: async () => ({ depreciation_expense: 'expense', accumulated_depreciation: 'asset', sales_revenue: 'income' }),
      postingMap: () => undefined,
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

  it('CLOSE (OB-567): no close on the Finance page — it says, in English and Tamil, that the month is closed on head office\'s Month-end page, and links there', async () => {
    const ho = newHeadOffice();
    const { page, errors, teardown } = await openFinance(ho);
    try {
      // The month's state still shows; the page carries no close step of its own — no button, no note box.
      expect(await page.textContent('#verdict')).toBe('These figures agree exactly and nothing is outstanding. They can be signed.');
      expect(await hidden(page, 'close-box')).toBe(false);
      expect(await hidden(page, 'reopen-box')).toBe(true);
      for (const gone of ['#ask-close', '#close-month', '#close-why', '#close-request']) {
        expect(await page.locator(gone).count(), `${gone} is still on the Finance page`).toBe(0);
      }
      expect(await page.locator('main input').count(), 'a box to type a signer or approver into is still on the page').toBe(0);
      expect((await page.textContent('#close-lead'))?.trim()).toBe('A month is closed on head office’s Month-end page, not on this page. This page shows whether the month is closed and its Tally files.');
      expect((await page.textContent('#month-end-link'))?.trim()).toBe('Open the Month-end page');
      // The link goes to the Month-end page of the menu (`/finance-close`), relative so a front's prefix is kept.
      expect(await page.getAttribute('#month-end-link', 'href')).toBe('../finance-close/');

      await page.click('#lang');
      await page.waitForFunction('document.documentElement.lang === "ta"');
      expect((await page.textContent('#close-lead'))?.trim()).toBe('மாதம் தலைமை அலுவலகத்தின் மாத இறுதி பக்கத்தில் மூடப்படுகிறது, இந்தப் பக்கத்தில் அல்ல. மாதம் மூடப்பட்டதா என்பதையும் அதன் Tally கோப்புகளையும் இந்தப் பக்கம் காட்டுகிறது.');
      expect((await page.textContent('#month-end-link'))?.trim()).toBe('மாத இறுதி பக்கத்தைத் திற');

      // Nothing on this page asked for a signature or closed anything.
      expect(posts(ho, '/v1/approvals/requests')).toHaveLength(0);
      expect(posts(ho, CLOSE_PATH)).toHaveLength(0);
      expect(errors).toEqual([]);
    } finally {
      await teardown();
    }
    // Once head office has the month closed (on its Month-end page), the Finance page reads it as closed and offers reopening.
    const closed = newHeadOffice({ closed: true });
    const after = await openFinance(closed);
    try {
      expect(await hidden(after.page, 'close-box')).toBe(true);
      expect(await hidden(after.page, 'reopen-box')).toBe(false);
      expect(after.errors).toEqual([]);
    } finally {
      await after.teardown();
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

  it('REJECTED says who and why, in English and Tamil — a rejected reopen sends nothing and the month stays closed', async () => {
    // OB-567: the Finance page no longer closes a month, so a rejection is proven on the step it still offers — the reopen.
    const ho = newHeadOffice({ closed: true });
    const { page, teardown } = await openFinance(ho);
    try {
      await page.fill('#reopen-reason', REASON);
      await clickFor(page, '#ask-reopen', /^Asked\./);
      await decideAsAccountant(ho, 'rejected', 'the credit note is not on file yet');
      expect((await clickFor(page, '#reopen', /rejected it/)).text)
        .toBe('Not reopened — u-accountant rejected it: “the credit note is not on file yet”. Settle what they said and ask again.');
      expect(posts(ho, REOPEN_PATH), 'a rejected reopen must not be sent').toHaveLength(0);
      await page.waitForSelector('#reopen-request:not([hidden])');
      expect((await page.textContent('#reopen-request'))?.trim()).toBe('✕Your request: Rejected by u-accountant: the credit note is not on file yet');

      await page.click('#lang');
      await page.waitForFunction('document.documentElement.lang === "ta"');
      const ta = await clickFor(page, '#reopen', /மறுத்தார்/);
      expect(ta.text).toBe('மீண்டும் திறக்கப்படவில்லை — u-accountant மறுத்தார்: “the credit note is not on file yet”. அவர் சொன்னதைச் சரிசெய்து மீண்டும் கேளுங்கள்.');
      expect(posts(ho, REOPEN_PATH)).toHaveLength(0);
      expect(ho.periods.get(PERIOD), 'the month stays closed').toBe('closed');
      expect(await hidden(page, 'reopen-box')).toBe(false);
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

  it('the steps pass the same accessibility audit as every page — in English and in Tamil', async () => {
    const ho = newHeadOffice();
    const { page, teardown } = await openFinance(ho);
    try {
      // Contrast, names, 48px targets, one language — with the "closed on the Month-end page" step showing (OB-567).
      expect(await auditPage(page, { minTarget: 48 }), 'the month-end step').toEqual([]);
      await page.click('#lang');
      await page.waitForFunction('document.documentElement.lang === "ta"');
      expect(await page.textContent('#month-end-link')).toBe('மாத இறுதி பக்கத்தைத் திற');
      expect(await auditPage(page, { minTarget: 48, expectLang: 'ta' }), 'the month-end step in Tamil').toEqual([]);
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
      // OB-567: the sample has no close step either — only where the month is closed.
      expect(await page.locator('#ask-close').count()).toBe(0);
      expect(await page.locator('#close-month').count()).toBe(0);
      expect(await hidden(page, 'close-box')).toBe(false);
      expect(ho.requests.filter((r) => r.method !== 'GET'), 'the sample sent something').toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await teardown();
    }
  });

  it('OB-57: the Budget and assets tab reads head office\'s budget against the books and the fixed-asset register — in English and Tamil', async () => {
    const ho = newHeadOffice();
    const { page, errors, teardown } = await openFinance(ho);
    try {
      await page.click('#tab-plan');
      await page.waitForFunction(() => ((globalThis as unknown as BrowserGlobals).document.getElementById('assets-list')?.textContent ?? '').includes('FRZ-1'), undefined, { timeout: 10_000 });
      const budget = (await page.textContent('#budget-list')) ?? '';
      expect(budget).toContain('version 1');
      expect(budget).toContain('depreciation_expense');
      expect(budget).toContain('budget ₹120.00 · books ₹100.00');
      expect(budget).toContain('−₹20.00');
      const assets = (await page.textContent('#assets-list')) ?? '';
      expect(assets).toContain('Chest freezer 500L (FRZ-1)');
      expect(assets).toContain('in use at store-2');
      expect(assets).toContain('book value ₹1,100.00');
      // The page only reads: no write went to head office.
      expect(ho.requests.filter((r) => r.method !== 'GET')).toEqual([]);
      await page.click('#lang');
      await page.waitForFunction(() => ((globalThis as unknown as BrowserGlobals).document.getElementById('assets-list')?.textContent ?? '').includes('புத்தக மதிப்பு'), undefined, { timeout: 10_000 });
      expect(await page.textContent('#plan-title')).toBe('பட்ஜெட் மற்றும் சொத்துகள்');
      expect(errors).toEqual([]);
    } finally {
      await teardown();
    }
  });
});
