import { Tally } from './lib/tally';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Pool } from 'pg';
import { chromium, type Browser, type Page } from 'playwright-core';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import { approveStandInModel } from '../support/ai-approval';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import type { HttpRequest } from '../../services/kernel/src/index';
import type { ModelTransport, ModelTier, TierPricing } from '../../packages/ai/src/index';

/**
 * **Round 8 in a real browser — the service desk (WF-17 · A05 · M21-FR-03 complaint and compensation, M21-FR-04 SLA,
 * escalation and resolution) and the assistant's drafts screen (A09 · A07), on the
 * production API surface.** The pages are served from apps/web-erp/web and every `/v1` request goes, under the signed-in
 * person's own token, to the API exactly as `main.ts` composes it (`buildSurface` through the real router — over real
 * PostgreSQL when DATABASE_URL is set), with a deterministic stand-in for a model provider (none is chosen; an external
 * gate). The shell plays only the sign-in front's part: the person named by the `who` cookie, and the identity-only
 * payload the store box injects. Through Chromium:
 *
 *   • a desk person picks the complaint, asks the assistant for a reply, edits and approves it, sends it by phone (the
 *     first-reply clock turns "met"), resolves the case and records its root cause — the summary counts it;
 *   • an owner asks the assistant for campaign words; approving them is REFUSED to the asker (in words, on the page) and
 *     accepted from a second owner — the template turns approved;
 *   • the assistant's anomaly summary appears with its suggested order;
 *   • the page follows the language toggle into Tamil.
 * Without the pre-installed Chromium the suite SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const DATABASE_URL = process.env['DATABASE_URL'];
const WEB_DIR = 'apps/web-erp/web';
const OWNER = 'u-owner'; const OWNER2 = 'u-owner-2'; const DESK = 'u-desk';
const PRICING: Readonly<Record<ModelTier, TierPricing>> = {
  small: { inputPerMillionMinor: 1_000_000, outputPerMillionMinor: 2_000_000 },
  standard: { inputPerMillionMinor: 3_000_000, outputPerMillionMinor: 6_000_000 },
  complex: { inputPerMillionMinor: 9_000_000, outputPerMillionMinor: 18_000_000 },
};
const standIn: ModelTransport = (req) => {
  const own = req.evidence.filter((e) => !e.untrusted).map((e) => e.evidenceId);
  const base = { kind: 'reply' as const, inputTokens: 200, outputTokens: 40, elapsedMs: 50 };
  if (req.context.agentId === 'A05') return { ...base, text: 'We are sorry about this. A colleague will look into it today.', citedEvidenceIds: own.slice(0, 2) };
  if (req.context.agentId === 'A09') return { ...base, text: 'SRE Hyper Market: this week {offer}. Reply STOP to opt out.', citedEvidenceIds: own.slice(0, 1) };
  return { ...base, text: 'Investigate case-big first — the largest exposure.', citedEvidenceIds: own.slice(0, 1), proposals: [{ tool: 'prioritise_investigation', arguments: { order: ['case-big'] }, rationale: 'exposure' }] };
};

const PAYLOAD: Record<string, { global: string; permissions: Record<string, string[]> }> = {
  'service-desk.html': { global: 'serviceDeskData', permissions: { [DESK]: ['service.case.read', 'service.case.manage'] } },
  'ai-drafts.html': { global: 'aiDraftsData', permissions: { [OWNER]: ['ai.proposal.read', 'document.template.manage', 'lp.case.read', 'lp.case.manage'], [OWNER2]: ['ai.proposal.read', 'document.template.manage', 'lp.case.read', 'lp.case.manage'] } },
};

async function startShell(h: ApiHarness, tenantId: string): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const who = /(?:^|;\s*)who=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? OWNER;
      if (url.pathname.startsWith('/v1/')) {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const reply = await h.raw({
          method: (req.method ?? 'GET') as HttpRequest['method'], path: url.pathname, query: Object.fromEntries(url.searchParams),
          token: TEST_IDP.issue({ sub: who, tenantId }),
          ...(req.headers['idempotency-key'] === undefined ? {} : { idempotencyKey: String(req.headers['idempotency-key']) }),
          ...(chunks.length === 0 ? {} : { body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }),
        });
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
        return;
      }
      const file = url.pathname.replace(/^\//, '') || 'service-desk.html';
      try {
        let body = (await readFile(join(WEB_DIR, file))).toString('utf8');
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        const p = PAYLOAD[file];
        if (p !== undefined) body = body.replace('<!--SCREEN-DATA-->', `<script>window.${p.global} = ${JSON.stringify({ userId: who, permissions: p.permissions[who] ?? [] })};</script>`);
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

describe.skipIf(!HAVE_BROWSER)('the service desk and the assistant\'s drafts, in a real browser on the production API surface (round 8)', () => {
  let browser: Browser;
  let pool: Pool | undefined;
  let h: ApiHarness;
  let shell: { base: string; stop: () => Promise<void> };
  const T = randomUUID();
  const act = (method: 'POST' | 'PUT', path: string, userId: string, body: unknown) => h.request({ method, path, userId, tenantId: T, idempotencyKey: `seed-${randomUUID()}`, body });

  beforeAll(async () => {
    if (DATABASE_URL !== undefined) {
      pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
      await runMigrations(pgPoolClient(pool), readdirSync('db/migrations').filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join('db/migrations', name), 'utf8') })));
      const sql = pgPoolClient(pool);
      h = apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql), modelTransport: standIn, modelPricing: PRICING });
    } else {
      h = apiHarness({ modelTransport: standIn, modelPricing: PRICING });
    }
    await h.seedOwner(T, OWNER);
    await h.provisionOwner(T, OWNER2);
    await h.provisionRole(T, DESK, 'store_manager');
    await act('PUT', '/v1/ai/kill-switch', OWNER, { on: false, reason: 'e2e' });
    await act('PUT', '/v1/ai/budget', OWNER, { capMinor: 1_000_000, periodEnds: '2099-01-01T00:00:00.000Z' });
    await act('PUT', '/v1/ai/agents/enabled', OWNER, { expected: [], agents: ['A05', 'A07', 'A09'] });
    // AI-NFR-01 (OB-288 lane 4 · P1): only a model on the approved register may be called — evaluate and approve one.
    await approveStandInModel(h, { tenantId: T, userId: OWNER, pricing: PRICING, agent: 'A05' });
    await act('POST', '/v1/orders/ORD-9/promise', OWNER, { lines: [{ productId: 'MILK', quantityMinor: 2 }], locationId: 'store-1' });
    expect((await act('POST', '/v1/service/cases/K-1', DESK, { kind: 'complaint', customerRef: 'c-1', priority: 'normal', summary: 'The milk was sour', assignedTo: DESK, orderRef: 'ORD-9' })).status).toBe(201);
    // OB-390: a case that says how the customer reached the shop — in person — so the reply goes back that way by default.
    expect((await act('POST', '/v1/service/cases/K-2', DESK, { kind: 'complaint', customerRef: 'c-2', priority: 'normal', summary: 'The bread was stale', assignedTo: DESK, orderRef: 'ORD-9', channel: 'in_person' })).status).toBe(201);
    await act('POST', '/v1/customer/segments/policy', OWNER, { loyalAtOrders: 3 });
    for (const [i, days] of [5, 4, 3].entries()) await act('POST', `/v1/customer/facts/orders/C1-${i}`, OWNER, { customerRef: 'C1', at: new Date(Date.now() - days * 86_400_000).toISOString(), netMinor: 20_000, marginMinor: 6_000, channel: 'store' });
    for (const purpose of ['profiling', 'marketing']) await act('POST', '/v1/customers/C1/consent', OWNER, { purpose, channel: 'sms', given: true, evidence: 'e2e seed consent' });
    expect((await act('POST', '/v1/loss-prevention/cases/case-big', OWNER, { raisedFromRef: 'voidabuse:till-1', subjectRef: 'staff-9', summary: 'post-void refunds', valueMinor: 90_000, assignedTo: DESK })).status).toBe(201);
    shell = await startShell(h, T);
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);
  afterAll(async () => { await browser?.close(); await shell?.stop(); await pool?.end(); });

  const pageAs = async (who: string, file: string): Promise<{ page: Page; close: () => Promise<void> }> => {
    const context = await browser.newContext();
    await context.addCookies([{ name: 'who', value: who, url: shell.base }]);
    const page = await context.newPage();
    await page.goto(`${shell.base}/${file}`, { waitUntil: 'load' });
    return { page, close: () => context.close() };
  };

  it('WF-17: pick the complaint, ask for a reply, edit and approve it, send it by phone, resolve, record the root cause', async () => {
    const { page, close } = await pageAs(DESK, 'service-desk.html');
    try {
      await page.waitForSelector('#case-rows tr[data-case-id="K-1"]', { timeout: 10_000 });
      // The edited reply (not the frequent action QG-02 counts — that is the next test): open, ask, edit the words, approve
      // them, send by the channel (the select holds the first way, phone, as this case says none).
      await page.click('#case-rows tr[data-case-id="K-1"]');
      await page.waitForSelector('#case-section:not([hidden])');
      await page.click('#ask-draft');
      await page.waitForSelector('#draft-list .draft blockquote', { timeout: 10_000 });
      expect(await page.textContent('#draft-list .draft blockquote')).toContain('A colleague will look into it today.');
      expect(await page.textContent('#draft-status')).toContain('The assistant drafted a reply');
      expect(await page.$('#draft-list .draft button.approve-send'), 'a case with no channel offers no one-press send').toBeNull();
      await page.fill('#draft-list .draft textarea', 'Sorry about the milk on ORD-9 — a colleague will call you today.');
      await page.click('#draft-list .draft button.secondary >> text=Edit and approve');
      await page.waitForSelector('#draft-list .draft button.send', { timeout: 10_000 });
      await page.selectOption('#draft-list .draft select', 'phone');
      await page.click('#draft-list .draft button.send');
      await page.waitForSelector('#draft-list .draft .status.good', { timeout: 10_000 });
      expect(await page.textContent('#draft-list .draft .status.good')).toContain(`Sent by ${DESK} by Phone`);
      expect(await page.textContent('#draft-list .draft blockquote')).toBe('Sorry about the milk on ORD-9 — a colleague will call you today.');
      expect(await page.textContent('#first-badge')).toBe('met');

      await page.fill('#resolution', 'replacement delivered');
      await page.click('#resolve');
      await page.waitForFunction("document.querySelector('#rc-save')?.hasAttribute('disabled') === false", undefined, { timeout: 10_000 });
      await page.selectOption('#rc-cause', 'product_quality');
      await page.fill('#rc-note', 'the batch was sour at receipt');
      await page.click('#rc-save');
      await page.waitForSelector('#rc-summary li', { timeout: 10_000 });
      expect(await page.textContent('#rc-summary li')).toBe('Product quality: 1 case(s) (1 complaint(s))');
      expect(await page.textContent('#rc-missing')).toBe('Every resolved case has a root cause.');

      // Tamil follows the one toggle.
      await page.click('#lang');
      expect(await page.textContent('#title')).toBe('வாடிக்கையாளர் வழக்குகள்');
      expect(await page.textContent('#rc-summary li')).toContain('பொருளின் தரம்');
    } finally {
      await close();
    }
  }, 60_000);

  it('QG-02 (crm-service.md "open and reply to a case ≤3") · OB-390: open the case, ask the assistant, approve and send by the case\'s own channel — 3', async () => {
    const { page, close } = await pageAs(DESK, 'service-desk.html');
    try {
      await page.waitForSelector('#case-rows tr[data-case-id="K-2"]', { timeout: 10_000 });
      const taps = new Tally(page);
      await taps.tap('#case-rows tr[data-case-id="K-2"]');
      await page.waitForFunction("(document.querySelector('#case-facts')?.textContent ?? '').includes('came by In person')", undefined, { timeout: 10_000 });
      await taps.tap('#ask-draft');
      await page.waitForSelector('#draft-list .draft button.approve-send', { timeout: 10_000 });
      // The person reads the assistant's words, then one press approves them (in their name) and records the reply sent
      // the way the customer came — nothing reaches the customer before a person approves it (P-05).
      expect(await page.textContent('#draft-list .draft button.approve-send')).toBe('Approve and send by In person');
      await taps.tap('#draft-list .draft button.approve-send');
      await page.waitForSelector('#draft-list .draft .status.good', { timeout: 10_000 });
      expect(taps.reset(), 'open and reply to a case').toBeLessThanOrEqual(3);
      expect(await page.textContent('#draft-list .draft .status.good')).toBe(`Sent by ${DESK} by In person · Approved by ${DESK}`);
      const drafts = (await h.request({ method: 'GET', path: '/v1/service/cases/K-2/drafts', userId: DESK, tenantId: T })).body as { drafts: { decision: { decision: string; approvedBy: string } | null; sent?: { channel: string; sentBy: string } }[] };
      expect(drafts.drafts[0]).toMatchObject({ decision: { decision: 'approved', approvedBy: DESK }, sent: { channel: 'in_person', sentBy: DESK } });
      // Tamil names the way the case came.
      await page.click('#lang');
      expect(await page.textContent('#case-facts')).toContain('நேரில்');
    } finally {
      await close();
    }
  }, 60_000);

  it('A09 and A07: campaign words are refused to the asker and approved by a second person; the anomaly summary is shown', async () => {
    const first = await pageAs(OWNER, 'ai-drafts.html');
    try {
      await first.page.fill('#tpl-id', 'tpl-week');
      await first.page.click('#ask-campaign');
      await first.page.waitForSelector('#camp-list .card[data-template="tpl-week@1"] button', { timeout: 10_000 });
      expect(await first.page.textContent('#camp-list .card[data-template="tpl-week@1"] blockquote')).toContain('{offer}');
      await first.page.click('#camp-list .card[data-template="tpl-week@1"] button');
      await first.page.waitForFunction("(document.querySelector('#camp-status')?.textContent ?? '').includes('cannot also approve')", undefined, { timeout: 10_000 });
      // The anomaly summary, with its suggested order — nothing opened or closed.
      await first.page.click('#ask-summary');
      await first.page.waitForSelector('#anom-list .card', { timeout: 10_000 });
      expect(await first.page.textContent('#anom-list .card')).toContain('Suggested order: case-big');
    } finally {
      await first.close();
    }
    const second = await pageAs(OWNER2, 'ai-drafts.html');
    try {
      await second.page.waitForSelector('#camp-list .card[data-template="tpl-week@1"] button', { timeout: 10_000 });
      await second.page.click('#camp-list .card[data-template="tpl-week@1"] button');
      await second.page.waitForSelector('#camp-list .card[data-template="tpl-week@1"] .status.good', { timeout: 10_000 });
      expect(await second.page.textContent('#camp-list .card[data-template="tpl-week@1"] .status.good')).toBe(`Approved by ${OWNER2}`);
    } finally {
      await second.close();
    }
  }, 60_000);
});
