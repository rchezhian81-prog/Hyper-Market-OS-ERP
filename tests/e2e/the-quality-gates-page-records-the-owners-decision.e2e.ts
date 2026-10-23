import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';

/**
 * QG-12 (roadmap §22 "Every gate ends GO, HOLD or REWORK with evidence; silence is not approval"; §36; OB-288 gates lane)
 * — the Quality gates page, in a real browser, on the PRODUCTION API over real PostgreSQL:
 *
 *   • opening the page writes nothing and reads nothing until a release is chosen;
 *   • every gate of a fresh release reads "Not decided — silence is not approval" (an icon AND words), never GO;
 *   • an open HIGH container-image finding stands against QG-06 and QG-03 and is named on their rows;
 *   • the owner's GO on QG-06 is refused in head office's own words and nothing is recorded;
 *   • the owner's HOLD, with evidence and a reason, is recorded in the owner's name and shown;
 *   • the br-1 manager reads the register but is offered no decision; Tamil; after an API RESTART it all reads back.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['gates', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');

const IMAGE_FINDING = {
  tool: 'trivy-image', source: 'container', runId: 'ci-e2e-1', scannedAt: '2026-10-23T08:00:00.000Z', complete: true,
  observations: [{ fingerprint: 'trivy-image|sre-api:ci|openssl|CVE-2026-0042', source: 'container', tool: 'trivy-image', ruleId: 'CVE-2026-0042', title: 'openssl 3.0.1: synthetic high vulnerability', severity: 'high', toolSeverity: 'HIGH', location: 'sre-api:ci (alpine)' }],
};

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the Quality gates page (QG-12) on the production API, in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/gates', html: 'gates.html', dataGlobal: 'gatesData' },
      seed: async (cloud) => {
        await ok(cloud.request({ method: 'POST', path: '/v1/compliance/finding-scans', userId: OWNER, idempotencyKey: 'scan-1', body: { report: IMAGE_FINDING } }), 'import the image scan');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string) => {
    const context = await browser.newContext();
    await shop.signIn(context, who, who === MGR ? 'br-1' : undefined);
    const page = await context.newPage();
    const writes: string[] = []; const reads: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (!u.pathname.startsWith('/v1/')) return; (r.method() === 'GET' ? reads : writes).push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}/gates`, { waitUntil: 'load' });
    return { page, writes, reads, errors, close: () => context.close() };
  };
  const showRelease = async (page: Page, release: string): Promise<void> => {
    await page.selectOption('#release', release);
    await page.click('#show');
    await page.locator('#gates li.row').first().waitFor({ timeout: 15_000 });
  };
  const row = (page: Page, gate: string) => page.locator(`#gates li.row[data-gate="${gate}"]`);

  it('every gate starts "Not decided"; GO over a high finding is refused in head office\'s words; the owner\'s HOLD is recorded with its evidence', async () => {
    const s = await open(OWNER);
    try {
      expect(s.writes, 'nothing is written on open').toEqual([]);
      expect(s.reads, 'nothing is read before a release is chosen').toEqual([]);
      await showRelease(s.page, 'R5');
      expect(await s.page.locator('#gates li.row').count()).toBe(12);
      expect(await s.page.locator('#gates li.row[data-state="undecided"]').count()).toBe(12);
      expect(await row(s.page, 'QG-01').locator('.state').innerText()).toMatch(/○\s*Not decided — silence is not approval/);
      expect(await s.page.locator('#counts [data-count="undecided"]').innerText()).toMatch(/Not decided: 12/);
      // The high finding stands against QG-06 and QG-03, by name.
      for (const gate of ['QG-06', 'QG-03']) expect(await row(s.page, gate).locator('.blockers').innerText()).toMatch(/Security finding — open high finding "openssl 3\.0\.1: synthetic high vulnerability"/);

      // GO on QG-06 is head office's refusal, shown in its words; nothing is recorded.
      await s.page.selectOption('#decide-gate', 'QG-06');
      await s.page.check('input[name="decision"][value="GO"]');
      await s.page.fill('#evidence-label', 'CI run');
      await s.page.fill('#evidence-ref', 'https://example.test/ci/1');
      await s.page.fill('#rationale', 'trying to pass it');
      await s.page.click('#record');
      await s.page.waitForFunction(() => /QG-06 cannot be GO while/.test((globalThis as unknown as { document: { getElementById(x: string): { textContent: string | null } | null } }).document.getElementById('decide-status')?.textContent ?? ''), undefined, { timeout: 15_000 });
      expect(await s.page.textContent('#decide-status')).toMatch(/^Head office refused: QG-06 cannot be GO while 1 thing\(s\) block it: open high finding/);
      expect((await shop.cloud().request({ method: 'GET', path: '/v1/compliance/gate-decisions/QG-06/R5', userId: OWNER })).body).toMatchObject({ count: 0 });

      // No evidence → refused on the screen, nothing sent.
      const before = s.writes.length;
      await s.page.check('input[name="decision"][value="HOLD"]');
      await s.page.fill('#evidence-ref', '');
      await s.page.click('#record');
      expect(await s.page.textContent('#decide-status')).toBe('A decision needs evidence: say what it is and where to find it.');
      expect(s.writes.length).toBe(before);

      // HOLD with evidence and a reason: recorded in the owner's name.
      await s.page.fill('#evidence-label', 'Container scan: one open high finding');
      await s.page.fill('#evidence-ref', 'scan-reports-security/trivy-image.findings.json');
      await s.page.fill('#rationale', 'Hold until the image is rebuilt and the scan is clean');
      await s.page.click('#record');
      await s.page.waitForFunction(() => (globalThis as unknown as { document: { querySelector(x: string): { getAttribute(a: string): string | null } | null } }).document.querySelector('#gates li.row[data-gate="QG-06"]')?.getAttribute('data-state') === 'HOLD', undefined, { timeout: 15_000 });
      expect(await s.page.textContent('#decide-status')).toBe('✓ Recorded at head office, in your name.');
      const q6 = await row(s.page, 'QG-06').innerText();
      expect(q6).toMatch(/⏸\s*HOLD — waiting/);
      expect(q6).toMatch(/Decided by: u-owner/);
      expect(q6).toMatch(/Evidence: Container scan: one open high finding — scan-reports-security\/trivy-image\.findings\.json/);
      expect(s.writes.filter((w) => w.startsWith('POST /v1/compliance/gate-decisions/QG-06/R5'))).toHaveLength(2); // the refused GO and the HOLD
      // Tamil.
      await s.page.click('#lang');
      expect(await row(s.page, 'QG-01').locator('.state').innerText()).toMatch(/முடிவு இல்லை — மௌனம் ஒப்புதல் அல்ல/);
      expect(await s.page.textContent('#page-h')).toBe('தர வாயில்கள்');
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 180_000);

  it('the manager reads the register but is offered no decision; after an API restart the owner\'s HOLD reads back', async () => {
    let s = await open(MGR);
    try {
      await showRelease(s.page, 'R5');
      expect(await s.page.locator('#decide-form').isHidden()).toBe(true);
      expect(await s.page.textContent('#decide-not')).toBe('Deciding a gate is the owner\'s — you can read the register.');
      expect((await shop.cloud().request({ method: 'POST', path: '/v1/compliance/gate-decisions/QG-01/R5', userId: MGR, idempotencyKey: 'mgr-try', body: { decision: 'GO', evidence: [{ label: 'x', ref: 'y' }], rationale: 'z' } })).status).toBe(403);
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    await shop.restart();
    s = await open(OWNER);
    try {
      await showRelease(s.page, 'R5');
      expect(await row(s.page, 'QG-06').getAttribute('data-state')).toBe('HOLD');
      expect(await s.page.locator('#gates li.row[data-state="undecided"]').count()).toBe(11);
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 180_000);
});
