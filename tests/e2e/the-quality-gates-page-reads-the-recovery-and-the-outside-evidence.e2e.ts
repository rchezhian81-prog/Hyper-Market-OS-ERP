import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';

/**
 * QG-08 · QG-04 · QG-05 · QG-06 (roadmap §22, §32, §35.1; W3) — the Quality gates page, in a real browser, on the
 * PRODUCTION API over real PostgreSQL:
 *
 *   • QG-08 — the recovery reading: with three rehearsals passed and the incident escalation FAILED (20 minutes against the
 *     §32 15-minute target), the QG-08 row names it as its blocker, in head office's words; when the escalation is rehearsed
 *     again within target the row says nothing blocks it — the reading, not a typed box;
 *   • QG-04 / QG-05 / QG-06 — the outside evidence: a fresh shop's five outside tests each read ○ "nothing on file", never ✓,
 *     and block their gates by name; the pen test does not block R2 (not customer-facing) but does block R5;
 *   • the owner records a 340 ms scan-to-line through the screen — head office works out it FAILED (the page sends only the
 *     figure) and the QG-05 row says "FAILED — p95 340 ms against the 300 ms target"; then 280 ms passes;
 *   • the br-1 manager reads it all but is offered no recording; after an API RESTART it reads back.
 *
 * Synthetic data, a fresh tenant. Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['gates', 'recovery', 'e2e', 'key'].join('-').padEnd(48, '0');

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the Quality gates page reads the recovery and the outside evidence (QG-08 · QG-04/05/06)', () => {
  let browser: Browser;
  let shop: InboxShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/gates', html: 'gates.html', dataGlobal: 'gatesData' },
      seed: async (cloud) => {
        for (const [kind, secs] of [['backup_restore', 3_600], ['store_recovery', 600], ['rollback', 900]] as const) {
          await ok(cloud.request({ method: 'POST', path: '/v1/platform/dr-drills', userId: OWNER, idempotencyKey: `drill-${kind}`, body: { drillId: `q4-${kind}`, rehearsal: kind, dataLossSeconds: 0, recoverySeconds: secs } }), kind);
        }
        // Incident escalation acknowledged in 20 minutes — over the §32 15-minute target: a FAILED rehearsal, kept.
        await ok(cloud.request({ method: 'POST', path: '/v1/platform/dr-drills', userId: OWNER, idempotencyKey: 'drill-esc-1', body: { drillId: 'q4-esc-1', rehearsal: 'incident_escalation', dataLossSeconds: 0, recoverySeconds: 1_200 } }), 'esc fail');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string) => {
    const context = await browser.newContext();
    await shop.signIn(context, who, who === MGR ? 'br-1' : undefined);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${shop.base}/gates`, { waitUntil: 'load' });
    return { page, errors, close: () => context.close() };
  };
  const showRelease = async (page: Page, release: string): Promise<void> => {
    await page.selectOption('#release', release);
    await page.click('#show');
    await page.locator('#gates li.row').first().waitFor({ timeout: 15_000 });
    await page.locator('#outside-list li').first().waitFor({ timeout: 15_000 });
  };
  const row = (page: Page, gate: string) => page.locator(`#gates li.row[data-gate="${gate}"]`);

  it('QG-08 names the failed escalation until it is rehearsed within target; the outside tests read "nothing on file" and block; the owner\'s 340 ms is worked out as FAILED', async () => {
    const s = await open(OWNER);
    try {
      await showRelease(s.page, 'R2');
      // QG-08: the reading names the failed rehearsal — head office's words, on the row.
      const qg08 = await row(s.page, 'QG-08').locator('.blockers').innerText();
      expect(qg08).toMatch(/Check — QG-08 rehearsals not all passed — Incident escalation: failed/);
      expect(qg08).not.toMatch(/Backup restore|Store recovery|Rollback:/);
      // The outside evidence: five tests, each ○ nothing on file — never ✓.
      expect(await s.page.locator('#outside-list li').count()).toBe(5);
      expect(await s.page.locator('#outside-list li[data-standing="nothing_on_file"]').count()).toBe(5);
      expect(await s.page.locator('#outside-list li[data-kind="scan_to_line_p95"]').innerText()).toMatch(/○\s*Scan-to-line speed, ≤300 ms \(QG-05\) — nothing on file/);
      expect(await row(s.page, 'QG-05').locator('.blockers').innerText()).toMatch(/Scan-to-line speed on certified pilot hardware: nothing on file — not passed until it is done and recorded/);
      expect(await row(s.page, 'QG-04').locator('.blockers').innerText()).toMatch(/72-hour offline trading simulation: nothing on file[\s\S]*no store computer has reported its sync/);
      // R2 is not customer-facing: no pen-test blocker on QG-06.
      expect(await row(s.page, 'QG-06').locator('.blockers').count()).toBe(0);

      // The owner records a 340 ms scan-to-line through the screen: the page sends the figure, head office says FAILED.
      await s.page.selectOption('#outside-kind', 'scan_to_line_p95');
      expect(await s.page.locator('#outside-result-wrap').isHidden()).toBe(true); // a timing has no "result" to type
      await s.page.fill('#outside-ms', '340');
      await s.page.fill('#outside-on', '2026-11-01');
      await s.page.fill('#outside-where', 'certified store PC, lanes 1-4 (synthetic rehearsal)');
      await s.page.fill('#outside-ref', 'docs/evidence/scan-speed-2026-11-01.md');
      await s.page.fill('#outside-statement', 'timed a thousand scans with the shop open');
      await s.page.click('#outside-record');
      await s.page.locator('#outside-status.good').waitFor({ timeout: 15_000 });
      await s.page.locator('#outside-list li[data-kind="scan_to_line_p95"][data-standing="failed"]').waitFor({ timeout: 15_000 });
      expect(await s.page.locator('#outside-list li[data-kind="scan_to_line_p95"]').innerText()).toMatch(/⚠\s*Scan-to-line speed, ≤300 ms \(QG-05\) — failed · p95 340 ms · latest: 2026-11-01/);
      expect(await row(s.page, 'QG-05').locator('.blockers').innerText()).toMatch(/FAILED — p95 340 ms against the 300 ms target/);
      // A step the screen refuses before asking: a timing typed with a decimal.
      await s.page.fill('#outside-ms', '2.5');
      await s.page.click('#outside-record');
      expect(await s.page.locator('#outside-status').innerText()).toBe('Type the measured p95 in whole milliseconds.');

      // R5: the pen test now blocks QG-06, by name.
      await showRelease(s.page, 'R5');
      expect(await row(s.page, 'QG-06').locator('.blockers').innerText()).toMatch(/Independent penetration test: nothing on file/);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    // The escalation is rehearsed again within target (10 minutes): QG-08 has nothing blocking it now.
    await ok(shop.cloud().request({ method: 'POST', path: '/v1/platform/dr-drills', userId: OWNER, idempotencyKey: 'drill-esc-2', body: { drillId: 'q4-esc-2', rehearsal: 'incident_escalation', dataLossSeconds: 0, recoverySeconds: 600 } }), 'esc pass');
    const again = await open(OWNER);
    try {
      await showRelease(again.page, 'R2');
      expect(await row(again.page, 'QG-08').locator('.blockers').count()).toBe(0);
      expect(await row(again.page, 'QG-08').innerText()).toMatch(/Nothing blocks this gate now\./);
      expect(await row(again.page, 'QG-08').getAttribute('data-state')).toBe('undecided'); // a reading is evidence, never a decision
    } finally { await again.close(); }
  }, 180_000);

  it('the br-1 manager reads the outside evidence but is offered no recording; Tamil; after an API restart it reads back', async () => {
    await shop.restart();
    const s = await open(MGR);
    try {
      await showRelease(s.page, 'R2');
      expect(await s.page.locator('#outside-form').isHidden()).toBe(true);
      expect(await s.page.locator('#outside-not').innerText()).toBe('Recording outside evidence is the owner\'s — you can read it.');
      expect(await s.page.locator('#outside-list li[data-kind="scan_to_line_p95"]').getAttribute('data-standing')).toBe('failed');
      await s.page.click('#lang');
      expect(await s.page.locator('#outside-h').innerText()).toBe('வெளிச் சான்று (மென்பொருள் தானே செய்ய முடியாத சோதனைகள்)');
      expect(await s.page.locator('#outside-list li[data-kind="independent_pentest"]').innerText()).toMatch(/சுயாதீன ஊடுருவல் சோதனை \(QG-06, R4 முதல்\) — பதிவில் எதுவும் இல்லை/);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 120_000);
});
