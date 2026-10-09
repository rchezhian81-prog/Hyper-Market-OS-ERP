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
import { writeOffRoutes, type StoredWriteOff } from '../../services/inventory/src/write-off';

/**
 * **A shop-floor loss is recorded from a real browser — a big one by two people (M28-FR-01 · API-04 · §28 · ADR-0024 ·
 * audit PA-03 — the E2E matrix).**
 *
 * The session model, its words and the browser ports are unit-tested; head office's engine and the write-off route are
 * integration-tested. The one thing units cannot prove is that a person using the ACTUAL "Record a loss" page makes the
 * right writes reach head office under their own session — and that no approver's name exists anywhere on the page any
 * more. This drives headless Chromium against a stub head office that MOUNTS THE REAL ROUTES — the approval engine's
 * `approvalRequestRoutes` and the inventory service's `writeOffRoutes` — over in-memory storage, with the pipeline's one
 * job here (the caller's permission for the route) done in front of them:
 *
 *   • a SMALL loss (below the ₹500 limit) is recorded on the raiser's own, exactly as before: one POST, no approval,
 *     no evidence invented, the operation id as both the URL id and the idempotency key; the form clears;
 *   • a BIG loss: there is no approver box; "Record the loss" before asking says nobody was asked (nothing sent);
 *     **Ask for approval** without a reason is refused on the page; with one it records the owner's own
 *     `stock_write_off` request for EXACTLY the body the record will send plus the write-off id, for the loss's value —
 *     waiting; "Record the loss" while it waits says so; once the STORE MANAGER approves it in their own session,
 *     "Record the loss" posts the loss with `approvalId` and no `approvedBy`; head office records it, approved by the
 *     manager, and spends the approval once;
 *   • rejected → who and why, in English and Tamil; a figure changed after asking is not what was approved (nothing
 *     sent); head office's own refusal (stock the store does not own) → plain words;
 *   • a loss asked about on an earlier visit comes back under "Losses you asked approval for" and is carried on and
 *     recorded with exactly that approval;
 *   • a typed approver sent straight to head office is refused by name;
 *   • a cashier (no `inventory.movement.append`) sees no form and sends nothing;
 *   • the page passes the same accessibility audit as every page (48px targets, labels), in English and Tamil;
 *   • a page with no head office behind it (the sample) asks nothing and records nothing, and says so.
 *
 * The browser binary is the environment's pre-installed Chromium; where none is present the suite SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';

const TENANT = 'tenant';
const NOW = '2026-10-07T05:00:00.000Z';
/** The owner raises the loss (and handles stock — but never approves their own). */
const OWNER = 'u-owner';
/** The store manager handles stock too: the second person. */
const MANAGER = 'u-manager';
/** A cashier sells; they do not move stock. */
const CASHIER = 'u-cashier';
const PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  [OWNER]: ['identity.self.read', 'inventory.movement.append', 'waste.view'],
  [MANAGER]: ['identity.self.read', 'inventory.movement.append', 'waste.view'],
  [CASHIER]: ['identity.self.read', 'pos.sale.create'],
};
/** ₹500 — the material-loss line: head office's own (its default) and the one the page is told. */
const THRESHOLD_MINOR = 50_000;
const WHY = 'rats got into the sacks overnight';
const WRITE_OFF = '/v1/inventory/write-off/';
const ASK = '/v1/approvals/requests';

interface Recorded { readonly method: string; readonly path: string; readonly body: unknown; readonly headers: Record<string, string | string[] | undefined>; }

/** Head office, in memory: the approval engine's records and the write-offs it has recorded. */
interface HeadOffice {
  readonly requests: Recorded[];
  readonly approvals: Map<string, ApprovalState>;
  readonly writeOffs: Map<string, StoredWriteOff>;
  /** Who the page is signed in as. */
  signedIn: string;
  /** What the store computer tells the page (`window.writeOffCaptureData`), or nothing (the sample). */
  screenData: Record<string, unknown> | undefined;
  readonly router: Router;
}

function newHeadOffice(opts: { readonly signedIn?: string; readonly screenData?: 'none' } = {}): HeadOffice {
  const approvals = new Map<string, ApprovalState>();
  const versions = new Map<string, number>();
  const writeOffs = new Map<string, StoredWriteOff>();
  const bump = (id: string): void => { versions.set(id, (versions.get(id) ?? 0) + 1); };
  const permissionsOfUser = (_t: string, userId: string): readonly string[] | undefined => PERMISSIONS[userId];
  // Head office's clock moves a minute with every reading, so each request is newer than the one before it.
  let tick = 0;
  const now = (): string => new Date(Date.parse(NOW) + (tick++) * 60_000).toISOString();

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
    now,
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
  const signedIn = opts.signedIn ?? OWNER;
  const built = buildRouter([
    ...approvalRequestRoutes(engine),
    ...writeOffRoutes({
      writeOffExists: (_t, id) => writeOffs.has(id),
      writeOffs: () => [...writeOffs.values()],
      recordWriteOff: (_t, rec) => { writeOffs.set(rec.id, rec); },
      writeOffThreshold: () => undefined, // head office's default — ₹500
      recordWriteOffThreshold: () => {},
      approvals: port,
      // The concession bay holds a concessionaire's stock: the store's staff may not write it off.
      ownersOfStockAt: (_t, _p, locationId) => (locationId === 'concession-bay' ? [{ ownership: 'concession' as const, ownerId: 'conc-sweets' }] : []),
      // SF-05: head office's own cost of the stock — what a loss is valued from. Toor dal at ₹95 a sack (12 → ₹1,140); the
      // sweets at ₹80; anything else (the "Mystery box") has no cost held.
      unitCostAt: (_t, _l, productId) => ({ 'Toor dal 1kg': 9_500, 'Sweets box': 8_000 } as Record<string, number>)[productId],
      now,
    }),
  ]);
  if (!built.ok || built.router === undefined) throw new Error(`stub head office refused its routes: ${JSON.stringify(built.refusals)}`);
  return {
    requests: [], approvals, writeOffs, signedIn,
    screenData: opts.screenData === 'none' ? undefined
      : { userId: signedIn, permissions: PERMISSIONS[signedIn] ?? [], materialThresholdMinor: THRESHOLD_MINOR },
    router: built.router,
  };
}

/** Call a REAL route as a signed-in person: the pipeline's permission check, then the route's own handler. */
async function call(ho: HeadOffice, userId: string, method: Method, path: string, body: unknown, query: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  const matched = ho.router.match(method, path);
  if (matched === undefined) return { status: 404, body: { error: { code: 'not_found', whatHappened: `No route ${method} ${path}.` } } };
  if (!(PERMISSIONS[userId] ?? []).includes(matched.route.permission)) {
    return { status: 403, body: { error: { code: 'forbidden', whatHappened: `${userId} does not hold ${matched.route.permission}.` } } };
  }
  try {
    const out = await matched.route.handler({
      tenantId: TENANT, userId, branchId: null, params: matched.params, query, body, traceId: 'trace-e2e',
      ...(method === 'GET' ? {} : { idempotencyKey: 'key' }),
    });
    return { status: out.status, body: out.body };
  } catch (e) {
    if (e instanceof ApiError) return { status: e.status, body: { error: e.body } };
    return { status: 500, body: { error: { code: 'internal', whatHappened: String(e) } } };
  }
}

/** The store manager decides the owner's waiting request in THEIR own session — the real decide route, as their
 *  Approvals page does. */
async function decideAsManager(ho: HeadOffice, decision: 'approved' | 'rejected', reason: string): Promise<string> {
  const pending = [...ho.approvals.values()].filter((s) => s.decision === undefined);
  expect(pending, 'exactly one request waits for the store manager').toHaveLength(1);
  const requestId = pending[0]!.request.requestId;
  const answer = await call(ho, MANAGER, 'POST', `/v1/approvals/requests/${requestId}/decide`, { decision, reason });
  expect(answer.status).toBe(201);
  return requestId;
}

const posts = (ho: HeadOffice, prefix: string): Recorded[] => ho.requests.filter((r) => r.method === 'POST' && r.path.startsWith(prefix));

async function startHeadOffice(ho: HeadOffice): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/', qs = ''] = (req.url ?? '/').split('?');
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
        // The page is the signed-in person's own session — head office knows them from the sign-in, never from a body.
        const answer = await call(ho, ho.signedIn, method, path, body, Object.fromEntries(new URLSearchParams(qs)));
        res.writeHead(answer.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer.body));
        return;
      }
      const file = path === '/' ? 'write-off-capture.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        let out = buf.toString('utf8');
        if (file.endsWith('.html') && ho.screenData !== undefined) {
          out = out.replace('<!--SCREEN-DATA-->', `<script>window.writeOffCaptureData = ${JSON.stringify(ho.screenData).replace(/</g, '\\u003c')};</script>`);
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
  readonly writeOffCaptureSession?: { readonly connected: boolean };
  readonly document: { getElementById(id: string): { hidden: boolean; textContent: string | null } | null };
}

describe.skipIf(!HAVE_BROWSER)('a stock loss is recorded at head office — a big one by two people — end to end in a real browser (M28-FR-01 · ADR-0024)', () => {
  let browser: Browser;

  beforeAll(async () => {
    // Build the CURRENT web-erp bundle so the browser runs this branch's code, not a stale artifact.
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  /** Open the page wired to the stub head office (or, with no screen data, on its sample stand-in). */
  const openPage = async (ho: HeadOffice, wired = true) => {
    const srv = await startHeadOffice(ho);
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    if (wired) await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).writeOffCaptureSession?.connected === true, undefined, { timeout: 10_000 });
    return { page, errors, base: srv.base, teardown: async () => { await context.close(); await srv.stop(); } };
  };

  /** SF-05: leave the quantity box (its `change`), so the page asks head office what the loss is worth — and wait until
   *  head office's figure is in the value box (locked) or head office has said it holds no cost (open). */
  const settleValue = async (page: Page, qty: string): Promise<void> => {
    await page.fill('#wo-qty', qty);
    await page.press('#wo-qty', 'Tab');
    // Wait for head office's answer for THIS quantity — the line from an earlier quantity may still be showing while the
    // new question is on its way (found on CI: 12 → 10 read the old ₹1,140 before the ₹950 arrived).
    await page.waitForFunction((n) => {
      const doc = (globalThis as unknown as BrowserGlobals).document;
      const hint = doc.getElementById('value-hint');
      const text = doc.getElementById('value-hint-text')?.textContent ?? '';
      return hint?.hidden === false && (text.includes(`: ${n} × `) || text.includes('holds no cost'));
    }, qty, { timeout: 10_000 });
  };
  /** Fill the loss: the item, where, how many, the chosen loss-type chip, and (optionally) the photo. The VALUE is head
   *  office's (SF-05) — typed only where head office holds no cost, or on the sample page with no head office behind it. */
  const fillLoss = async (page: Page, over: { product?: string; location?: string; qty?: string; rupees?: string; loss?: string; evidence?: string; sample?: boolean } = {}) => {
    await page.fill('#wo-product', over.product ?? 'Toor dal 1kg');
    await page.fill('#wo-location', over.location ?? 'aisle-3');
    if (over.sample === true) await page.fill('#wo-qty', over.qty ?? '12');
    else await settleValue(page, over.qty ?? '12');
    if (over.rupees !== undefined) await page.fill('#wo-value', over.rupees);
    await page.locator('#loss-types button.chip', { hasText: over.loss ?? 'Damage' }).click();
    if (over.evidence !== undefined) await page.fill('#wo-evidence', over.evidence);
  };

  /** Click, wait for the result line to say THIS click's answer, and read it. */
  const clickFor = async (page: Page, button: string, expected: RegExp): Promise<{ text: string; cls: string }> => {
    await page.click(button);
    await page.waitForFunction(
      (source) => {
        const doc = (globalThis as unknown as BrowserGlobals).document;
        const result = doc.getElementById('result');
        return result !== null && !result.hidden && new RegExp(source).test(doc.getElementById('result-text')?.textContent ?? '');
      },
      expected.source, { timeout: 10_000 },
    );
    return { text: ((await page.textContent('#result-text')) ?? '').trim(), cls: (await page.getAttribute('#result', 'class')) ?? '' };
  };

  const hidden = (page: Page, id: string) => page.evaluate((i) => (globalThis as unknown as BrowserGlobals).document.getElementById(i)?.hidden ?? true, id);

  it('a SMALL loss is recorded on the raiser’s own — one POST, no approval asked or named, and the form clears', async () => {
    const ho = newHeadOffice();
    const { page, errors, teardown } = await openPage(ho);
    try {
      await fillLoss(page, { qty: '1' }); // head office's value: 1 × ₹95 = ₹95 < ₹500 → small
      // SF-05: the value is head office's, shown and locked — nobody types it.
      expect((await page.textContent('#value-hint-text'))?.trim()).toBe('Head office\'s value: 1 × ₹95.00 = ₹95.00.');
      expect(await page.inputValue('#wo-value')).toBe('95.00');
      expect(await page.getAttribute('#wo-value', 'readonly'), 'the value box is locked').not.toBeNull();
      expect(await hidden(page, 'approval-step'), 'a small loss shows no approval step').toBe(true);
      const said = await clickFor(page, '#record', /^Loss recorded/);
      expect(said.text).toBe('Loss recorded. The shelf figure has come down.');
      expect(said.cls).toContain('tone-ok');

      const sent = posts(ho, WRITE_OFF);
      expect(sent, 'exactly one write-off was POSTed').toHaveLength(1);
      const urlId = sent[0]!.path.slice(WRITE_OFF.length);
      expect(urlId.length, 'a real operation id was minted').toBeGreaterThan(0);
      expect(sent[0]!.headers['idempotency-key'], 'the idempotency-key header is the URL id').toBe(urlId);
      expect(sent[0]!.body).toEqual({ productId: 'Toor dal 1kg', locationId: 'aisle-3', qty: 1, uom: 'ea', lossType: 'damage', reasonCode: 'damage', valueMinor: 9_500 });
      expect(posts(ho, ASK), 'a small loss asks nobody').toHaveLength(0);
      expect(ho.writeOffs.get(urlId)).toMatchObject({ raisedBy: OWNER, approvedBy: null, requiredApproval: false, valueMinor: 9_500, valueSource: 'stock_cost' });
      expect(await page.inputValue('#wo-product'), 'the form clears for the next loss').toBe('');
      expect(errors).toEqual([]);
    } finally {
      await teardown();
    }
  });

  it('a BIG loss: no approver box; ask, the store manager approves, and the record names that approval — and nothing else', async () => {
    const ho = newHeadOffice();
    const { page, errors, teardown } = await openPage(ho);
    try {
      expect(await page.locator('#wo-approver').count(), 'the typed approver box is still on the page').toBe(0);
      await fillLoss(page, { evidence: 'photo-17' }); // head office's value: 12 × ₹95 = ₹1,140 ≥ ₹500 → big
      expect(await hidden(page, 'approval-step'), 'a big loss shows the approval step').toBe(false);
      // One primary action at a time: asking is the next step, recording is not yet.
      expect(await page.getAttribute('#ask', 'class')).toContain('primary');
      expect(await page.getAttribute('#record', 'class')).not.toContain('primary');
      expect((await page.textContent('#material-hint-text'))?.trim()).toBe('This is a big loss — it needs a photo or witness, and a second person who handles stock must approve it.');

      // Record BEFORE asking: refused on the page, nothing sent.
      expect((await clickFor(page, '#record', /nobody has been asked/)).text)
        .toBe('Not recorded — nobody has been asked to approve this loss yet. Write why and press “Ask for approval” first.');
      expect(posts(ho, WRITE_OFF)).toHaveLength(0);

      // Ask with no reason: refused on the page, nothing asked.
      expect((await clickFor(page, '#ask', /Write why/)).text).toBe('Write why this is a loss, in a sentence — the person approving reads it. Nothing was asked.');
      expect(posts(ho, ASK)).toHaveLength(0);

      // Ask for approval — the owner's OWN request, for exactly this loss.
      await page.fill('#wo-why', WHY);
      const asked = await clickFor(page, '#ask', /^Asked\./);
      expect(asked.text).toBe('Asked. Waiting for a second person who handles stock (not you) to approve it on their Approvals page. Nothing is recorded yet. Write off 12 × Toor dal 1kg — damage, ₹1,140.00');
      expect(asked.cls).toContain('tone-degraded');
      const ask = posts(ho, ASK);
      expect(ask).toHaveLength(1);
      const askBody = ask[0]!.body as { subjectRef: string };
      const id = askBody.subjectRef;
      expect(id.length).toBeGreaterThan(0);
      const LOSS = { productId: 'Toor dal 1kg', locationId: 'aisle-3', qty: 12, uom: 'ea', lossType: 'damage', reasonCode: 'damage', valueMinor: 114_000, evidenceRef: 'photo-17' };
      expect(ask[0]!.body).toEqual({
        kind: 'stock_write_off', subjectRef: id, details: { ...LOSS, writeOffId: id }, valueMinor: 114_000,
        summary: 'Write off 12 × Toor dal 1kg — damage, ₹1,140.00', reason: WHY,
      });
      expect(ask[0]!.headers['idempotency-key'], 'the ask carries an idempotency key').toBeTruthy();
      expect(posts(ho, WRITE_OFF), 'asking records nothing').toHaveLength(0);
      // Asked: recording is now the next step.
      expect(await page.getAttribute('#record', 'class')).toContain('primary');
      expect(await page.getAttribute('#ask', 'class')).not.toContain('primary');
      // The ask is listed under "Losses you asked approval for".
      await page.waitForSelector('#your-losses:not([hidden])');
      expect((await page.textContent('#loss-requests'))).toContain('Waiting for a second person');

      // Record while it waits: says so, nothing sent.
      expect((await clickFor(page, '#record', /still waiting/)).text)
        .toBe('Not recorded — still waiting for a second person who handles stock (not you) to approve it on their Approvals page.');
      expect(posts(ho, WRITE_OFF)).toHaveLength(0);

      // The STORE MANAGER approves it, in their own session.
      const requestId = await decideAsManager(ho, 'approved', 'saw the torn sacks myself');

      // Record the loss — one POST naming the approval; no approver's name anywhere in it.
      const recorded = await clickFor(page, '#record', /^Loss recorded/);
      expect(recorded.text).toBe('Loss recorded. u-manager approved it, and that approval has now been used. The shelf figure has come down.');
      expect(recorded.cls).toContain('tone-ok');
      const sent = posts(ho, WRITE_OFF);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.path).toBe(`${WRITE_OFF}${id}`);
      expect(sent[0]!.headers['idempotency-key']).toBe(id);
      expect(sent[0]!.body).toEqual({ ...LOSS, approvalId: requestId });
      for (const typed of ['approvedBy', 'approval', 'rationale']) expect(sent[0]!.body).not.toHaveProperty(typed);

      // Head office recorded it — raised by the owner, approved by the manager — and used the approval once.
      expect(ho.writeOffs.get(id)).toMatchObject({ raisedBy: OWNER, approvedBy: MANAGER, requiredApproval: true, evidenceRef: 'photo-17', valueMinor: 114_000 });
      expect(ho.approvals.get(requestId)?.usedBy).toBe(`write-off:${id}`);
      // The form clears for the next loss, and the recorded loss is no longer listed.
      expect(await page.inputValue('#wo-product')).toBe('');
      expect(await page.inputValue('#wo-why')).toBe('');
      expect(await hidden(page, 'your-losses')).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await teardown();
    }
  });

  it('REJECTED says who and why, in English and Tamil; a figure changed after asking is not what was approved; head office’s own refusal is plain words', async () => {
    const ho = newHeadOffice();
    const { page, teardown } = await openPage(ho);
    try {
      await fillLoss(page, { evidence: 'photo-17' });
      await page.fill('#wo-why', WHY);
      await clickFor(page, '#ask', /^Asked\./);
      await decideAsManager(ho, 'rejected', 'count the sacks again — I see 10');
      expect((await clickFor(page, '#record', /rejected it/)).text)
        .toBe('Not recorded — u-manager rejected it: “count the sacks again — I see 10”. Change what they said and ask again.');
      expect(posts(ho, WRITE_OFF), 'a rejected loss must not be sent').toHaveLength(0);

      await page.click('#lang');
      await page.waitForFunction('document.documentElement.lang === "ta"');
      // The answer already on screen is said again in Tamil.
      expect((await page.textContent('#result-text'))?.trim()).toBe('பதிவு செய்யப்படவில்லை — u-manager மறுத்தார்: “count the sacks again — I see 10”. அவர் சொன்னதை மாற்றி மீண்டும் கேளுங்கள்.');
      expect(await page.textContent('#ask')).toBe('அனுமதி கேள்');
      expect(await page.textContent('#record')).toBe('இழப்பைப் பதிவு செய்');
      expect(await page.textContent('#why-label')).toBe('இது ஏன் இழப்பு? (அனுமதிப்பவர் இதைப் படிப்பார்)');
      expect((await clickFor(page, '#record', /மறுத்தார்/)).text)
        .toBe('பதிவு செய்யப்படவில்லை — u-manager மறுத்தார்: “count the sacks again — I see 10”. அவர் சொன்னதை மாற்றி மீண்டும் கேளுங்கள்.');
      expect(posts(ho, WRITE_OFF)).toHaveLength(0);
      await page.click('#lang');
      await page.waitForFunction('document.documentElement.lang === "en"');

      // Recount: ask again for 10 sacks; approved; then the quantity is changed again before recording.
      await settleValue(page, '10');
      expect(await page.inputValue('#wo-value')).toBe('950.00'); // head office's: 10 × ₹95
      await page.fill('#wo-why', `${WHY}; recounted: 10 sacks`);
      await clickFor(page, '#ask', /^Asked\./);
      await decideAsManager(ho, 'approved', 'agreed, 10');
      await page.fill('#wo-qty', '11');
      expect((await clickFor(page, '#record', /not exactly the loss that was approved/)).text)
        .toBe('Not recorded — this is not exactly the loss that was approved (something changed after you asked). Ask for approval again for exactly this.');
      expect(posts(ho, WRITE_OFF), 'a changed loss must not be sent').toHaveLength(0);
      await settleValue(page, '10');
      expect((await clickFor(page, '#record', /^Loss recorded/)).text).toContain('u-manager approved it');
      expect(posts(ho, WRITE_OFF)).toHaveLength(1);

      // Head office's own refusal: the concession bay's stock is not the store's to write off.
      await fillLoss(page, { location: 'concession-bay', qty: '1', loss: 'Expired', product: 'Sweets box' }); // ₹80, small
      expect((await clickFor(page, '#record', /belongs to someone else/)).text)
        .toBe('Not recorded — some of this item at that place belongs to someone else (a concession or consignment supplier, or a customer). Store staff cannot write off stock the store does not own; its owner records that loss.');
      expect(posts(ho, WRITE_OFF)).toHaveLength(2);
      expect(ho.writeOffs.size, 'the refused loss was not recorded').toBe(1);
    } finally {
      await teardown();
    }
  });

  it('a loss asked about on an earlier visit comes back, and is carried on and recorded with exactly that approval', async () => {
    const ho = newHeadOffice();
    const first = await openPage(ho);
    let id = '';
    try {
      await fillLoss(first.page, { evidence: 'witness: Murugan (stores)' });
      await first.page.fill('#wo-why', WHY);
      await clickFor(first.page, '#ask', /^Asked\./);
      id = (posts(ho, ASK)[0]!.body as { subjectRef: string }).subjectRef;
    } finally {
      await first.teardown();
    }
    const requestId = await decideAsManager(ho, 'approved', 'seen it');

    // A new visit: the form is empty and has a new id — the approved loss is listed with who approved it.
    const { page, errors, teardown } = await openPage(ho);
    try {
      await page.waitForSelector('#your-losses:not([hidden])');
      expect((await page.textContent('#your-losses-title'))?.trim()).toBe('Losses you asked approval for');
      expect((await page.textContent('#loss-requests'))).toContain('Write off 12 × Toor dal 1kg — damage, ₹1,140.00');
      expect((await page.textContent('#loss-requests'))).toContain('Approved by u-manager');
      await page.click('#loss-requests button.carry');
      expect(await page.inputValue('#wo-product')).toBe('Toor dal 1kg');
      expect(await page.inputValue('#wo-value')).toBe('1140.00');
      expect(await page.inputValue('#wo-evidence')).toBe('witness: Murugan (stores)');
      expect(await page.getAttribute('#loss-types button.chip.chosen', 'aria-pressed')).toBe('true');
      expect(await page.getAttribute('#record', 'class'), 'an approved loss: recording is the next step').toContain('primary');
      expect(await page.getAttribute('#ask', 'class')).not.toContain('primary');
      const recorded = await clickFor(page, '#record', /^Loss recorded/);
      expect(recorded.text).toContain('u-manager approved it');
      const sent = posts(ho, WRITE_OFF);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.path).toBe(`${WRITE_OFF}${id}`);
      expect((sent[0]!.body as Record<string, unknown>)['approvalId']).toBe(requestId);
      expect(ho.writeOffs.get(id)).toMatchObject({ approvedBy: MANAGER, evidenceRef: 'witness: Murugan (stores)' });
      expect(errors).toEqual([]);
    } finally {
      await teardown();
    }
  });

  it('head office refuses a typed approver by name — the page could not send one anyway', async () => {
    const ho = newHeadOffice();
    const { page, teardown } = await openPage(ho);
    try {
      const sent = await page.evaluate(async (path) => {
        const res = await fetch(path, {
          method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'typed-1' },
          body: JSON.stringify({ productId: 'P1', locationId: 'aisle-3', qty: 12, uom: 'ea', lossType: 'damage', reasonCode: 'damage', valueMinor: 114000, evidenceRef: 'photo-1', approvedBy: 'u-manager' }),
        });
        return { status: res.status, body: await res.json() as { error?: { code?: string } } };
      }, `${WRITE_OFF}typed-1`);
      expect(sent).toMatchObject({ status: 422, body: { error: { code: 'approver_named_without_approval' } } });
      expect(ho.writeOffs.size).toBe(0);
    } finally {
      await teardown();
    }
  });

  it('SF-05 — head office holds no cost for this stock: the value is typed, and even a small one needs a second person', async () => {
    const ho = newHeadOffice();
    const { page, errors, teardown } = await openPage(ho);
    try {
      await fillLoss(page, { product: 'Mystery box', qty: '1', rupees: '20', evidence: 'photo-9' }); // ₹20 typed — far under the ₹500 line
      expect((await page.textContent('#value-hint-text'))?.trim()).toMatch(/^Head office holds no cost for this stock\. Type the value/);
      expect(await page.getAttribute('#wo-value', 'readonly'), 'the value box stays open to type').toBeNull();
      expect(await hidden(page, 'approval-step'), 'a loss head office cannot value always needs the second person').toBe(false);
      expect((await clickFor(page, '#record', /nobody has been asked/)).text).toMatch(/^Not recorded — nobody has been asked/);
      expect(posts(ho, WRITE_OFF), 'never sent on the raiser\'s own').toHaveLength(0);
      expect(errors).toEqual([]);
    } finally {
      await teardown();
    }
  });

  it('a cashier (no inventory.movement.append) sees no form and sends NOTHING', async () => {
    const ho = newHeadOffice({ signedIn: CASHIER });
    const { page, teardown } = await openPage(ho, false);
    try {
      await page.waitForSelector('#state:not([hidden])', { timeout: 10_000 });
      expect(await hidden(page, 'capturer')).toBe(true);
      expect((await page.textContent('#state-text'))?.trim()).toBe('You do not have permission to record a loss.');
      expect(ho.requests.filter((r) => r.method !== 'GET'), 'a user who cannot record a loss sends nothing').toEqual([]);
    } finally {
      await teardown();
    }
  });

  it('the form, the approval step and the list pass the same accessibility audit as every page — in English and in Tamil', async () => {
    const ho = newHeadOffice();
    const { page, teardown } = await openPage(ho);
    try {
      await fillLoss(page, { evidence: 'photo-17' });
      await page.fill('#wo-why', WHY);
      await clickFor(page, '#ask', /^Asked\./);
      await page.waitForSelector('#your-losses:not([hidden])');
      expect(await auditPage(page, { minTarget: 48 }), 'the big-loss step, its answer and the list').toEqual([]);
      await page.click('#lang');
      await page.waitForFunction('document.documentElement.lang === "ta"');
      await page.waitForFunction(() => /நீங்கள் அனுமதி கேட்ட இழப்புகள்/.test((globalThis as unknown as BrowserGlobals).document.getElementById('your-losses-title')?.textContent ?? ''));
      expect(await auditPage(page, { minTarget: 48, expectLang: 'ta' }), 'the same in Tamil').toEqual([]);
    } finally {
      await teardown();
    }
  });

  it('a page with no head office behind it asks nothing and records nothing — and says so', async () => {
    const ho = newHeadOffice({ screenData: 'none' });
    const { page, errors, teardown } = await openPage(ho, false);
    try {
      expect(await hidden(page, 'sample')).toBe(false);
      await fillLoss(page, { evidence: 'photo-17', rupees: '1140', sample: true });
      await page.fill('#wo-why', WHY);
      expect((await clickFor(page, '#ask', /not connected/)).text)
        .toBe('This is sample data and is not connected to the store computer or head office — nothing was asked and nothing was recorded.');
      expect((await clickFor(page, '#record', /not connected/)).cls).toContain('tone-error');
      expect(ho.requests.filter((r) => r.method !== 'GET'), 'the sample sent something').toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await teardown();
    }
  });
});
