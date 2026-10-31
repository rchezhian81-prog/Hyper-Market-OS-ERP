import { Tally } from './lib/tally';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Pool } from 'pg';
import { chromium, type Browser, type Page } from 'playwright-core';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import type { HttpRequest } from '../../services/kernel/src/index';
import { simulatedTransport, type ModelTier, type TierPricing } from '../../packages/ai/src/index';
import { EVALUATION_SET, EVALUATION_SIMULATOR } from '../../services/ai/src/evaluation-set';

/**
 * **The AI control screen in a real browser, on the production API surface (OB-288 lane 4 · P1 · roadmap §27).**
 *
 * Before: the page bound a session from `window.aiData`, which nothing supplied — it always said "Sample data", and its
 * kill switch changed a list in the tab. Now, through Chromium, with every `/v1` request sent under the signed-in
 * person's own token to the API exactly as `main.ts` composes it (over real PostgreSQL when DATABASE_URL is set):
 *   • the page shows head office's live registry — no sample banner — and the assistants' state;
 *   • (re-audit 30 Oct 2026, AI-SCREEN) the owner sets the shop's AI spending limit and an assistant's own limit, and
 *     switches the assistants ON (and one off and on again) — all from the page, through head office's own routes; a limit
 *     above the ₹15,000 platform ceiling is refused in head office's words. Nothing here is seeded through the API any more;
 *   • a draft's "to act" is said in plain words, never as a raw route (O-2);
 *   • a reason is required before anything is sent; the owner STOPS one assistant and head office REFUSES its run (503);
 *   • the same person cannot start it again; a second owner does, with a reason, and the run is accepted again;
 *   • a draft is shown with its confidence and evidence and the owner APPROVES it — head office records it, committing
 *     nothing;
 *   • the owner runs an assistant's checks from the screen; an incident is reported, taken on and closed with a reason;
 *   • the screen follows the language toggle into Tamil, and says plainly when head office cannot be reached.
 * Without the pre-installed Chromium the suite SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const DATABASE_URL = process.env['DATABASE_URL'];
const WEB_DIR = 'apps/web-erp/web';
const OWNER = 'u-owner'; const OWNER2 = 'u-owner-2';
// As many checks as the evaluation set holds for A01 (it grows with the agent; never a hard-coded count).
const A01_CASES = EVALUATION_SET.filter((c) => c.agentId === 'A01').length;
const PERMS = ['ai.proposal.read', 'ai.killswitch.set', 'ai.proposal.decide', 'ai.model.approve', 'ai.evaluation.run', 'ai.incident.manage', 'ai.budget.set', 'ai.agent.enable', 'ai.agent.run'];
const PRICING: Readonly<Record<ModelTier, TierPricing>> = {
  small: { inputPerMillionMinor: 1_000_000, outputPerMillionMinor: 2_000_000 },
  standard: { inputPerMillionMinor: 3_000_000, outputPerMillionMinor: 6_000_000 },
  complex: { inputPerMillionMinor: 9_000_000, outputPerMillionMinor: 18_000_000 },
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
      const file = url.pathname.replace(/^\//, '') || 'ai.html';
      try {
        let body = (await readFile(join(WEB_DIR, file))).toString('utf8');
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        // The identity-only payload the store box / sign-in front injects: who is looking and their permission words.
        if (file === 'ai.html') body = body.replace('<!--SCREEN-DATA-->', `<script>window.aiData = ${JSON.stringify({ userId: who, permissions: PERMS })};</script>`);
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

describe.skipIf(!HAVE_BROWSER)('the AI control screen reaches head office, in a real browser on the production API surface (OB-288 lane 4 · P1)', () => {
  let browser: Browser;
  let pool: Pool | undefined;
  let h: ApiHarness;
  let shell: { base: string; stop: () => Promise<void> };
  const T = randomUUID();
  const act = (method: 'POST' | 'PUT', path: string, userId: string, body: unknown) => h.request({ method, path, userId, tenantId: T, idempotencyKey: `seed-${randomUUID()}`, body });

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    const transport = simulatedTransport(EVALUATION_SIMULATOR);
    if (DATABASE_URL !== undefined) {
      pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
      await runMigrations(pgPoolClient(pool), readdirSync('db/migrations').filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join('db/migrations', name), 'utf8') })));
      const sql = pgPoolClient(pool);
      h = apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql), modelTransport: transport, modelPricing: PRICING });
    } else {
      h = apiHarness({ modelTransport: transport, modelPricing: PRICING });
    }
    await h.seedOwner(T, OWNER);
    await h.provisionOwner(T, OWNER2);
    // The shop-wide switch stays the owner's own act OUTSIDE this page (the page never lifts it); the trial lifts it here.
    // The spending limits and switching the assistants on are done FROM THE PAGE, in the first journey below.
    await act('PUT', '/v1/ai/kill-switch', OWNER, { on: false, reason: 'e2e trial' });
    shell = await startShell(h, T);
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); await shell?.stop(); await pool?.end(); });

  const pageAs = async (who: string): Promise<{ page: Page; close: () => Promise<void> }> => {
    const context = await browser.newContext();
    await context.addCookies([{ name: 'who', value: who, url: shell.base }]);
    const page = await context.newPage();
    await page.goto(`${shell.base}/ai.html`, { waitUntil: 'load' });
    await page.waitForFunction("document.body.dataset.aiControl === 'ok'", undefined, { timeout: 15_000 });
    return { page, close: () => context.close() };
  };
  const reads = async (page: Page): Promise<number> => Number(await page.evaluate("document.body.dataset.aiReads ?? '0'"));
  const afterAct = async (page: Page, before: number): Promise<string> => {
    await page.waitForFunction(`Number(document.body.dataset.aiReads ?? '0') > ${before}`, undefined, { timeout: 15_000 });
    return (await page.textContent('#banner-text')) ?? '';
  };
  const bannerSays = async (page: Page, text: string): Promise<void> => {
    await page.waitForFunction(`!document.querySelector('#banner').hidden && (document.querySelector('#banner-text')?.textContent ?? '').includes(${JSON.stringify(text)})`, undefined, { timeout: 10_000 });
    await page.click('#banner-ok');
  };

  it('the owner sets the spending limits and switches the assistants on — from the page, through head office', async () => {
    const { page, close } = await pageAs(OWNER);
    const control = async () => (await h.request({ method: 'GET', path: '/v1/ai/control', userId: OWNER, tenantId: T })).body as { agents: { agentId: string; enabled: boolean; ceilingMinor: number | null; callsPerHour: number | null }[]; budget: { capMinor: number; periodEnds: string } };
    try {
      // Nothing is switched on and no limit is set: the page says so, and nothing runs.
      await page.click('#tab-agents');
      expect(await page.textContent('#agent-list .row[data-agent="A04"]')).toContain('not switched on');
      expect(await page.textContent('#enable-note')).toMatch(/It still only recommends/);
      const before = await act('POST', '/v1/ai/agents/A01/runs', OWNER, {});
      expect([before.status, (before.body as { error?: { code?: string } }).error?.code], 'nothing runs before it is switched on').toEqual([429, 'agent_not_permitted_here']);
      await page.click('#tab-cost');
      expect(await page.textContent('#cost-summary')).toContain('No AI limit is set for the shop');
      expect(await page.textContent('#limit-note')).toMatch(/connects no model.*OB-382/s);

      // A limit above the ₹15,000 platform ceiling (D3): refused in head office's words; nothing changed.
      await page.fill('#cap', '20000');
      let n = await reads(page);
      await page.click('#set-cap');
      await bannerSays(page, 'above the ₹15,000-a-month ceiling');
      expect((await control()).budget.capMinor).toBe(0);
      // Not money: refused on the page, nothing sent.
      await page.fill('#cap', 'a thousand');
      await page.click('#set-cap');
      await bannerSays(page, 'A limit is an amount in rupees');
      // The shop's limit: ₹1,000 until the end of the day chosen (the shop's clock).
      await page.fill('#cap', '1000');
      await page.fill('#period', '2099-01-31');
      n = await reads(page);
      await page.click('#set-cap');
      expect(await afterAct(page, n)).toMatch(/The shop’s AI limit is set/);
      await page.click('#banner-ok');
      expect((await control()).budget).toMatchObject({ capMinor: 100_000, periodEnds: '2099-01-31T18:29:00.000Z' });
      // One assistant's own limit, with a limit of requests an hour.
      await page.waitForSelector('#cost-list .row[data-agent="A01"] input.ceiling');
      await page.fill('#cost-list .row[data-agent="A01"] input.ceiling', '200');
      await page.fill('#cost-list .row[data-agent="A01"] input.rate', '30');
      n = await reads(page);
      await page.click('#cost-list .row[data-agent="A01"] button');
      expect(await afterAct(page, n)).toMatch(/The assistant’s limit is set/);
      await page.click('#banner-ok');
      expect((await control()).agents.find((a) => a.agentId === 'A01')).toMatchObject({ ceilingMinor: 20_000, callsPerHour: 30 });

      // Switch A01, A04 and A08 on — one press each; head office's list grows by exactly that one.
      await page.click('#tab-agents');
      for (const agent of ['A01', 'A04', 'A08']) {
        n = await reads(page);
        await page.click(`#agent-list .row[data-agent="${agent}"] button.enable-toggle[data-on="true"]`);
        expect(await afterAct(page, n)).toMatch(/Switched on\. It runs on its tested rules and only recommends/);
        await page.click('#banner-ok');
      }
      expect((await control()).agents.filter((a) => a.enabled).map((a) => a.agentId)).toEqual(['A01', 'A04', 'A08']);
      expect(await page.textContent('#agent-list .row[data-agent="A04"]')).toContain('running');
      // Switch A08 off: its run is refused; switch it on again: it runs. Nobody else's setting moved.
      n = await reads(page);
      await page.click('#agent-list .row[data-agent="A08"] button.enable-toggle[data-on="false"]');
      expect(await afterAct(page, n)).toMatch(/Switched off/);
      await page.click('#banner-ok');
      expect((await control()).agents.filter((a) => a.enabled).map((a) => a.agentId)).toEqual(['A01', 'A04']);
      const off = await act('POST', '/v1/ai/agents/A08/runs', OWNER, {});
      expect([off.status, (off.body as { error?: { code?: string } }).error?.code]).toEqual([429, 'agent_not_permitted_here']);
      // OB-557: while this screen still shows A08 off, the second owner switches A04 off elsewhere. Pressing "Switch on" for
      // A08 now is a change made against a stale list — head office refuses it by name, nothing of theirs is overwritten,
      // and the page says so in plain words and shows the latest.
      const elsewhere = await act('PUT', '/v1/ai/agents/enabled', OWNER2, { expected: ['A01', 'A04'], agents: ['A01'] });
      expect(elsewhere.status).toBe(200);
      n = await reads(page);
      await page.click('#agent-list .row[data-agent="A08"] button.enable-toggle[data-on="true"]');
      expect(await afterAct(page, n)).toMatch(/Somebody else changed which assistants are switched on since this screen read it\. Nothing was changed/);
      await page.click('#banner-ok');
      expect((await control()).agents.filter((a) => a.enabled).map((a) => a.agentId), 'the other owner\'s change stands').toEqual(['A01']);
      expect(await page.textContent('#agent-list .row[data-agent="A04"]')).toContain('not switched on');
      // On the list now shown: A04 and A08 switched on again, one press each.
      for (const agent of ['A04', 'A08']) {
        n = await reads(page);
        await page.click(`#agent-list .row[data-agent="${agent}"] button.enable-toggle[data-on="true"]`);
        expect(await afterAct(page, n)).toMatch(/Switched on/);
        await page.click('#banner-ok');
      }
      expect((await control()).agents.filter((a) => a.enabled).map((a) => a.agentId)).toEqual(['A01', 'A04', 'A08']);
      // A01's read-only insight lands on the register as a draft for the queue (the next journeys read it).
      expect((await act('POST', '/v1/ai/agents/A01/runs', OWNER, {})).status).toBe(200);
      // The new words have Tamil twins.
      await page.click('#lang');
      expect(await page.textContent('#agent-list .row[data-agent="A08"] button.enable-toggle')).toContain('நிறுத்தி வை');
      expect(await page.textContent('#limit-title')).toBe('செலவு வரம்புகளை அமை');
    } finally {
      await close();
    }
  }, 120_000);

  it('stop one assistant from the screen — head office refuses its run; only a different person starts it again', async () => {
    const { page, close } = await pageAs(OWNER);
    try {
      // Live, never a sample.
      expect(await page.isHidden('#unreachable')).toBe(true);
      expect(await page.textContent('body')).not.toContain('Sample data');
      await page.click('#tab-agents');
      expect(await page.textContent('#agent-list .row[data-agent="A04"]')).toContain('running');
      expect(await page.textContent('#forbidden-box')).toContain('issue refund');
      // QG-02 (ai-control.md "pull an agent's kill switch ≤2") · OB-390: the page opens on "Stop the AI"; each running
      // assistant has its own Stop button beside the reason — write why, press its button. Two. The reason stays required.
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction("document.body.dataset.aiControl === 'ok'", undefined, { timeout: 15_000 });
      expect(await page.isHidden('#view-switch'), 'the page opens on Stop the AI').toBe(false);
      await page.waitForSelector('#stop-one button[data-agent="A04"]');
      const taps = new Tally(page);

      // No reason → refused on the page, nothing is sent.
      await page.click('#stop-one button[data-agent="A04"]');
      await bannerSays(page, 'write the reason first');
      expect(((await h.request({ method: 'GET', path: '/v1/ai/kill-switches', userId: OWNER, tenantId: T })).body as { active: unknown[] }).active).toEqual([]);

      // With a reason → stopped at head office, and its run is refused.
      await taps.type('#pull-reason', 'the shopping assistant offered the wrong milk');
      const n = await reads(page);
      await taps.tap('#stop-one button[data-agent="A04"]');
      expect(await afterAct(page, n)).toMatch(/stopped 1 agent/);
      expect(taps.reset(), 'stop one assistant with its kill switch').toBeLessThanOrEqual(2);
      // A stopped assistant has no Stop button of its own any more; the others still do.
      await page.waitForFunction("document.querySelector('#stop-one button[data-agent=\"A04\"]') === null");
      expect(await page.$('#stop-one button[data-agent="A08"]')).not.toBeNull();
      await page.click('#banner-ok');
      await page.waitForSelector('#kill-list .row.stopped');
      expect(await page.textContent('#kill-list .row.stopped')).toContain('the shopping assistant offered the wrong milk');
      expect((await act('POST', '/v1/ai/agents/A04/runs', OWNER, {})).status).toBe(503);
      expect((await act('POST', '/v1/ai/agents/A08/runs', OWNER, {})).status).toBe(200); // the rest run on

      // The same person cannot start it again — refused on the page, nothing sent.
      await page.fill('#kill-list .row.stopped textarea', 'fixed');
      await page.click('#kill-list .row.stopped button');
      await bannerSays(page, 'a different person decides');
      expect((await act('POST', '/v1/ai/agents/A04/runs', OWNER, {})).status).toBe(503);
    } finally {
      await close();
    }
    const second = await pageAs(OWNER2);
    try {
      await second.page.waitForSelector('#kill-list .row.stopped');
      await second.page.fill('#kill-list .row.stopped textarea', 'the alternatives were checked against stock');
      const n = await reads(second.page);
      await second.page.click('#kill-list .row.stopped button');
      expect(await afterAct(second.page, n)).toMatch(/lifted the switch/);
      expect(await second.page.$('#kill-list .row.stopped')).toBeNull();
      expect((await act('POST', '/v1/ai/agents/A04/runs', OWNER, {})).status).toBe(200);
    } finally {
      await second.close();
    }
  }, 90_000);

  it('a draft shows its confidence and evidence; approving it records the decision and commits nothing', async () => {
    const { page, close } = await pageAs(OWNER);
    try {
      // QG-02 (ai-control.md): approve/reject an AI suggestion with reason — the queue, the reason, the decision: 3.
      const taps = new Tally(page);
      await taps.tap('#tab-queue');
      // A01's action list sits above the drafts: what needs a person today, from the records.
      expect(await page.textContent('#actions-box')).toMatch(/What needs you today/);
      const row = '#queue-list .row.held';
      await page.waitForSelector(row);
      const text = (await page.textContent(row)) ?? '';
      expect(text).toMatch(/Sure — a fact on record|Likely — check the evidence/);
      expect(text).toContain('What it cannot know');
      expect(text).toContain('what it rests on');
      // O-2: "to act" in plain words — never the raw route the draft names.
      const toAct = (await page.textContent(`${row} .where`)) ?? '';
      expect(toAct).toMatch(/^To act on it: \S/);
      expect(toAct).not.toMatch(/\/v1\/|POST |GET /);
      const id = await page.getAttribute(row, 'data-proposal');
      const n = await reads(page);
      await taps.type(`${row} textarea`, 'checked against the stock on hand');
      await taps.tap(`${row} button.primary`);
      expect(await afterAct(page, n)).toMatch(/Nothing has happened yet/);
      expect(taps.reset(), 'approve/reject an AI suggestion with reason').toBeLessThanOrEqual(3);
      const register = (await h.request({ method: 'GET', path: '/v1/ai/proposals', userId: OWNER, tenantId: T })).body as { proposals: { proposalId: string; outcome: { decision: string; by: string } | null }[]; committedAnything: boolean };
      expect(register.committedAnything).toBe(false);
      expect(register.proposals.find((p) => p.proposalId === id)!.outcome).toMatchObject({ decision: 'approved', by: OWNER });
      expect(await page.textContent(`#queue-list .row[data-proposal="${id}"]`)).toContain(`approved by ${OWNER}`);
    } finally {
      await close();
    }
  }, 60_000);

  it('runs an assistant\'s checks from the screen, and an incident is reported, taken on and closed with a reason', async () => {
    const { page, close } = await pageAs(OWNER);
    try {
      await page.click('#tab-models');
      expect(await page.textContent('#model-list')).toContain('No model is approved');
      expect(await page.textContent('#check-list .row[data-check="A01"]')).toContain('NEVER been checked');
      let n = await reads(page);
      await page.click('#check-list .row[data-check="A01"] button');
      expect(await afterAct(page, n)).toMatch(/The checks ran/);
      await page.click('#banner-ok');
      expect(await page.textContent('#check-list .row[data-check="A01"]')).toContain(`${A01_CASES}/${A01_CASES} passed`);

      await page.click('#tab-incidents');
      await page.selectOption('#raise-agent', 'A04');
      await page.fill('#raise-summary', 'It offered a milk that was not in stock');
      n = await reads(page);
      await page.click('#raise');
      expect(await afterAct(page, n)).toMatch(/A named person must now look into it/);
      await page.click('#banner-ok');
      const row = '#incident-list .row.refused';
      await page.waitForSelector(row);
      n = await reads(page);
      await page.click(`${row} button`);
      await afterAct(page, n);
      await page.click('#banner-ok');
      await page.waitForSelector('#incident-list .row.held textarea');
      await page.fill('#incident-list .row.held textarea', 'the alternatives now check stock at the store');
      n = await reads(page);
      await page.click('#incident-list .row.held button');
      expect(await afterAct(page, n)).toMatch(/Closed, with your reason/);
      await page.click('#banner-ok');
      expect(await page.textContent('#incident-list .row.closed')).toContain('the alternatives now check stock at the store');

      // Tamil follows the one toggle.
      await page.click('#lang');
      expect(await page.textContent('#tab-switch')).toContain('AI-ஐ நிறுத்து');
      expect(await page.textContent('#incidents-title')).toBe('நிகழ்வுகள்');
    } finally {
      await close();
    }
  }, 90_000);

  it('says plainly when head office cannot be reached — and shows nothing as current', async () => {
    const context = await browser.newContext();
    await context.addCookies([{ name: 'who', value: OWNER, url: shell.base }]);
    const page = await context.newPage();
    try {
      await page.route('**/v1/ai/control', (route) => route.abort());
      await page.goto(`${shell.base}/ai.html`, { waitUntil: 'load' });
      await page.waitForFunction("document.body.dataset.aiControl === 'unreachable'", undefined, { timeout: 15_000 });
      expect(await page.isVisible('#unreachable')).toBe(true);
      expect(await page.textContent('#kill-state')).toContain('Head office cannot be reached');
      expect(await page.$('#agent-list .row')).toBeNull();
    } finally {
      await context.close();
    }
  }, 60_000);
});
