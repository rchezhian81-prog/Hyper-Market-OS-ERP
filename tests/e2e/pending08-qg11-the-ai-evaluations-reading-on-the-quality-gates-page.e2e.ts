import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, OWNER, MGR, ok, type InboxShop } from './lib/ai-inbox-shop';

/**
 * **QG-11 (roadmap §22 "Accuracy/safety evaluations, authority, evidence, human override, budgets and kill switch pass") — the
 * AI gate's reading on the Quality gates page, in a real browser, on the PRODUCTION API over real PostgreSQL.**
 *
 * The page reads head office's own AI control (GET /v1/ai/control) with the register and shows, on the QG-11 row, each agent
 * in the evaluation set with its latest run, the kill switch and the budgets — an icon AND words, English and Tamil:
 *   • the shop as it is today has no model connected (OB-296; live provider EX-12): every agent "no evaluation has been run
 *     yet" and the gate HOLDS until R8 (OB-382);
 *   • an evaluation the owner runs reaches no model: it is shown NOT COMPLETE — it proves nothing;
 *   • a scoped kill switch and a shop budget are said as head office holds them; the store manager reads the same reading;
 *   • QG-11 still reads "Not decided — silence is not approval": a reading is never a decision;
 *   • OB-935 (owner decided A): pressing GO on QG-11 is head office's refusal, naming each assistant without a complete,
 *     passing evaluation, in plain words — nothing recorded; HOLD is recorded in the owner's name.
 * Synthetic data only. Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['pending08', 'qg11', 'e2e', 'key'].join('-').padEnd(48, '0');
const SHOTS = process.env['QG11_SHOTS_DIR'];

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('QG-11: the AI evaluations reading on the Quality gates page, connected on PostgreSQL', () => {
  let browser: Browser;
  let shop: InboxShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/gates', html: 'gates.html', dataGlobal: 'gatesData' },
      seed: async () => { /* a fresh synthetic tenant: no evaluation has been run */ },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    if (SHOTS !== undefined) mkdirSync(SHOTS, { recursive: true });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string, branch?: string) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await shop.signIn(context, who, branch);
    const page = await context.newPage();
    const errors: string[] = []; const writes: string[] = []; const reads: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/')) (r.method() === 'GET' ? reads : writes).push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}/gates`, { waitUntil: 'load' });
    await page.selectOption('#release', 'R8');
    await page.click('#show');
    await page.locator('#gates li.row').first().waitFor({ timeout: 15_000 });
    return { page, errors, writes, reads, close: () => context.close() };
  };
  const qg11 = (page: Page) => page.locator('#gates li.row[data-gate="QG-11"]');
  const standing = async (page: Page, want: string): Promise<string> => {
    await page.locator(`#qg11-reading[data-qg11="${want}"]`).waitFor({ timeout: 15_000 });
    return page.locator('#qg11-reading').innerText();
  };
  const shoot = async (page: Page, name: string) => { if (SHOTS !== undefined) await qg11(page).screenshot({ path: join(SHOTS, name) }); };

  it('no model: every agent listed and the gate HOLDS; an evaluation NOT COMPLETE; the kill switch and budget in words; Tamil; never decided', async () => {
    // ── As the shop is today: no model connected. Every agent in the set, none run; the gate HOLDS.
    let s = await open(OWNER);
    try {
      const said = await standing(s.page, 'no_live_model');
      expect(said).toContain('HOLD — no live model is connected (OB-296; live provider EX-12), so no agent\'s evaluation can be complete.');
      expect(said).toMatch(/A01 · .+ — no evaluation has been run yet/);
      expect(await s.page.locator('#qg11-reading ul.qg11-agents > li[data-state="not_run"]').count()).toBeGreaterThan(1);
      expect(said).toContain('Model: none connected — the assistants work on tested rules only.');
      expect(said).toContain('QG-11 holds until every agent in the evaluation set has a complete, passing evaluation against a live model (R8, OB-382).');
      expect(said).not.toMatch(/evidence for the owner's QG-11 decision/);
      expect(await qg11(s.page).getAttribute('data-state')).toBe('undecided');
      expect(await qg11(s.page).locator('.state').innerText()).toMatch(/Not decided — silence is not approval/);
      expect(s.reads).toContain('GET /v1/ai/control'); // read with the register, on the click
      expect(s.writes, 'reading the gates writes nothing').toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    // ── The owner runs A06's evaluation (it reaches no model); a scoped kill switch and a shop budget are set at head office.
    const c = shop.cloud();
    const run = await c.request({ method: 'POST', path: '/v1/ai/evaluations/A06', userId: OWNER, idempotencyKey: 'eval-a06-no-model' });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    expect((run.body as { run: { complete: boolean } }).run.complete).toBe(false);
    await ok(c.request({ method: 'PUT', path: '/v1/ai/budget', userId: OWNER, idempotencyKey: 'cap', body: { capMinor: 500_000, periodEnds: '2099-01-01T00:00:00.000Z' } }), 'cap');
    await ok(c.request({ method: 'POST', path: '/v1/ai/kill-switches', userId: OWNER, idempotencyKey: 'ks-a08', body: { scope: 'single_agent', agentId: 'A08', reason: 'held back while its cases are checked' } }), 'kill A08');

    s = await open(OWNER);
    try {
      const said = await standing(s.page, 'no_live_model');
      const a06 = s.page.locator('#qg11-reading ul.qg11-agents > li[data-agent="A06"]');
      expect(await a06.getAttribute('data-state')).toBe('not_complete');
      expect(await a06.innerText()).toMatch(/A06 · .+ — NOT COMPLETE: it did not reach a model, so it proves nothing · run evr-A06-/);
      expect(said).toContain('Kill switch: 1 switch is stopping an assistant (A08).');
      expect(said).toContain('Shop AI budget: ₹5,000.00 a month, ₹0.00 spent (platform ceiling ₹15,000.00).');
      expect(said).toContain('Agents with a budget of their own: none — only the shop budget applies.');
      await shoot(s.page, 'qg11-row-en.png');
      // Tamil: the reading's own words switch with the page.
      await s.page.click('#lang');
      await s.page.locator('#qg11-reading h4', { hasText: 'செயற்கை நுண்ணறிவுச் சோதனைகள்' }).waitFor({ timeout: 15_000 });
      const ta = await s.page.locator('#qg11-reading').innerText();
      expect(ta).toContain('நிறுத்தம் — நேரடி மாதிரி எதுவும் இணைக்கப்படவில்லை');
      expect(ta).toContain('முழுமையில்லை');
      expect(ta).toContain('QG-11 நிறுத்தி வைக்கப்படுகிறது');
      await shoot(s.page, 'qg11-row-ta.png');
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    // ── The store manager, who reads the register, reads the same reading.
    s = await open(MGR, 'br-1');
    try {
      const said = await standing(s.page, 'no_live_model');
      expect(said).toMatch(/A06 · .+ — NOT COMPLETE/);
      expect(said).toContain('Kill switch: 1 switch is stopping an assistant (A08).');
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    expect((await shop.cloud().request({ method: 'GET', path: '/v1/compliance/gate-decisions/QG-11/R8', userId: OWNER })).body).toMatchObject({ count: 0 });

    // ── OB-935 (owner decided A, 27 Nov 2026): GO on QG-11 is head office's refusal, naming the assistants, in plain words;
    //    nothing is recorded. HOLD with evidence is recorded in the owner's name.
    s = await open(OWNER);
    try {
      const said = await standing(s.page, 'no_live_model');
      expect(said).toContain('Head office refuses GO on QG-11 until then (owner\'s decision, 27 Nov 2026 — OB-935); HOLD and REWORK can still be recorded.');
      expect(await qg11(s.page).locator('.blockers').innerText()).toMatch(/A06 · .+'s latest evaluation \(run evr-A06-[^)]+\) is NOT COMPLETE — it never reached a model, so it proves nothing/);
      await s.page.selectOption('#decide-gate', 'QG-11');
      await s.page.check('input[name="decision"][value="GO"]');
      await s.page.fill('#evidence-label', 'The AI evaluations reading');
      await s.page.fill('#evidence-ref', 'Quality gates page, QG-11 row');
      await s.page.fill('#rationale', 'trying to pass it');
      await s.page.click('#record');
      await s.page.waitForFunction(() => /QG-11 cannot be GO while/.test((globalThis as unknown as { document: { getElementById(x: string): { textContent: string | null } | null } }).document.getElementById('decide-status')?.textContent ?? ''), undefined, { timeout: 15_000 });
      const refused = (await s.page.textContent('#decide-status')) ?? '';
      expect(refused).toMatch(/^Head office refused: QG-11 cannot be GO while \d+ thing\(s\) block it: /);
      expect(refused).toMatch(/A01 · [^;]+ has no evaluation on record — it needs a complete, passing evaluation against a live model \(no model is connected yet — EX-12, OB-296; live models are due at R8, OB-382\)/);
      expect(refused).toMatch(/A06 · [^;]+'s latest evaluation \(run evr-A06-[^)]+\) is NOT COMPLETE/);
      if (SHOTS !== undefined) await s.page.locator('#decide-section').screenshot({ path: join(SHOTS, 'qg11-go-refused-en.png') });
      expect((await shop.cloud().request({ method: 'GET', path: '/v1/compliance/gate-decisions/QG-11/R8', userId: OWNER })).body).toMatchObject({ count: 0 });

      await s.page.check('input[name="decision"][value="HOLD"]');
      await s.page.fill('#rationale', 'Hold until every assistant passes against a live model (R8)');
      await s.page.click('#record');
      await s.page.waitForFunction(() => (globalThis as unknown as { document: { querySelector(x: string): { getAttribute(a: string): string | null } | null } }).document.querySelector('#gates li.row[data-gate="QG-11"]')?.getAttribute('data-state') === 'HOLD', undefined, { timeout: 15_000 });
      expect(await s.page.textContent('#decide-status')).toContain('Recorded at head office, in your name.');
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    const hist = (await shop.cloud().request({ method: 'GET', path: '/v1/compliance/gate-decisions/QG-11/R8', userId: OWNER })).body as { history: { decision: string; decidedBy: string }[] };
    expect(hist.history.map((d) => [d.decision, d.decidedBy])).toEqual([['HOLD', OWNER]]);
  }, 240_000);
});
