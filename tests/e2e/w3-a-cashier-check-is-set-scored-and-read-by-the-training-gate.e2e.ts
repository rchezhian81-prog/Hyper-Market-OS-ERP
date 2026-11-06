import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import { openAs } from './lib/w3-page';
import { says } from './lib/r4c-box-page';

/**
 * **W3 · OB-675 · QG-02 (roadmap §2.3 "Training success ≥ 90% role assessment (pilot) / ≥ 95% (final)"): the cashier's
 * scored check is set, its pass mark set by the owner, attempts recorded and read by the training gate — on the Training
 * checks page, in a real browser, on the PRODUCTION API over real PostgreSQL.**
 *
 *   • at first the cashier role reads "not set" for the check and the pass mark, nobody trained, NOT PASSED at both levels;
 *   • the br-1 manager writes the questions and the tasks and saves the check; the pass mark is not offered to her; an
 *     attempt is refused by head office in its words while the pass mark is not set;
 *   • the owner sets the pass mark (75%) on the same page;
 *   • the manager records Asha (all passed: 100%) and Bala (half: 50%, not passed) — head office works out the scores; the
 *     role reads 1 of 2 passed (50%), not passed; Bala's retake (100%) brings it to 2 of 2 — passed at the pilot and after;
 *   • the gate register (QG-02, R2 and R3) no longer names the cashier role; the attempts are all kept.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['w3', 'training', 'checks', 'key'].join('-').padEnd(48, '0');

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('Training checks (OB-675 · QG-02) on the production API, in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/training-checks', html: 'training-checks.html', dataGlobal: 'trainingChecksData' },
      seed: async (cloud) => {
        for (const [id, name] of [['u-cash-asha', 'Asha'], ['u-cash-bala', 'Bala']] as const) {
          await ok(cloud.request({ method: 'POST', path: `/v1/hr/workforce/employees/${id}`, userId: OWNER, idempotencyKey: `emp-${id}`, body: { name, branchId: 'br-1', roles: ['cashier'], active: true } }), `employee ${id}`);
        }
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  it('not set → the manager sets the check → the owner sets the pass mark → attempts and a retake → the gate reads it', async () => {
    const card = '#roles li[data-role="cashier"]';
    let s = await openAs(shop, browser, MGR, '/training-checks', 'br-1');
    try {
      await says(s.page, `${card} .summary`, /^Check: not set · Pass mark: not set$/);
      await says(s.page, `${card} .verdict`, /^Pilot \(90%\): ✕ not passed · After the pilot \(95%\): ✕ not passed$/);
      await says(s.page, `${card} .why`, /no check has been set for this role.*the pass mark is not set — the owner sets it.*nobody is trained for this role yet/s);
      expect(await s.page.locator(`${card} .set-mark`).count(), 'the pass mark is the owner\'s').toBe(0);
      await s.page.click(`${card} details.set-check summary`);
      await s.page.fill(`${card} textarea.questions`, 'The scanner cannot read a barcode — what do you do?\nWhen is a manager needed for a refund?');
      await s.page.fill(`${card} textarea.tasks`, 'Ring up a weighed item\nCount the drawer at the close');
      await s.page.click(`${card} .save-check`);
      await says(s.page, `${card} .status`, /^Saved\. This is the role's check now\.$/);
      await says(s.page, `${card} .summary`, /^Check: version 1 · 4 items · Pass mark: not set$/);
      // An attempt before the owner set the pass mark — head office refuses it in its words.
      await s.page.click(`${card} details.record summary`);
      await s.page.fill(`${card} input.person`, 'u-cash-asha');
      await s.page.click(`${card} .record-attempt`);
      await says(s.page, `${card} .status`, /^Head office refused: The pass mark for cashier is not set — the owner sets it — so an attempt cannot be judged\.$/);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    s = await openAs(shop, browser, OWNER, '/training-checks');
    try {
      await s.page.fill(`${card} input.mark`, '75');
      await s.page.click(`${card} .set-mark`);
      await says(s.page, `${card} .status`, /^Saved\. The pass mark is set\.$/);
      await says(s.page, `${card} .summary`, /Pass mark: 75%$/);
      await s.page.click('#lang');
      await says(s.page, '#reading-h', /^பணி வாரியாகப் பயிற்சி வாயில்$/);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    s = await openAs(shop, browser, MGR, '/training-checks', 'br-1');
    const record = async (who: string, ticks: readonly string[], expected: RegExp): Promise<void> => {
      // A save repaints the role, so the form is opened again each time.
      if (!(await s.page.locator(`${card} details.record`).evaluate((d) => (d as unknown as { open: boolean }).open))) await s.page.click(`${card} details.record summary`);
      await s.page.fill(`${card} input.person`, who);
      for (const item of ['q1', 'q2', 't1', 't2']) await s.page.setChecked(`${card} input[data-item="${item}"]`, ticks.includes(item));
      await s.page.click(`${card} .record-attempt`);
      await says(s.page, `${card} .status`, expected);
    };
    try {
      await record('u-cash-asha', ['q1', 'q2', 't1', 't2'], /^Recorded\. Score 100% \(pass mark 75%\) — passed\.$/);
      await record('u-cash-bala', ['q1', 't1'], /^Recorded\. Score 50% \(pass mark 75%\) — not passed\.$/);
      await says(s.page, `${card} .counts`, /^Trained: 2 · 1 passed \(50%\)$/);
      await says(s.page, `${card} li[data-person="u-cash-bala"]`, /^Bala \(u-cash-bala\) — latest 50%, not passed$/);
      await says(s.page, `${card} .why`, /1 of 2 trained passed \(50%\) — below the pilot 90%; not passed: Bala \(u-cash-bala, 50%\)/);
      // The retake is a new attempt; the latest counts.
      await record('u-cash-bala', ['q1', 'q2', 't1', 't2'], /^Recorded\. Score 100% \(pass mark 75%\) — passed\.$/);
      await says(s.page, `${card} .verdict`, /^Pilot \(90%\): ✓ passed · After the pilot \(95%\): ✓ passed$/);
      await says(s.page, `${card} .counts`, /^Trained: 2 · 2 passed \(100%\)$/);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    // The gate register reads the same: QG-02 no longer names the cashier role, before or after the pilot.
    for (const release of ['R2', 'R3']) {
      const reg = (await shop.cloud().request({ method: 'GET', path: `/v1/compliance/gate-register?release=${release}`, userId: OWNER })).body as { gates: { gate: string; blockers: { ref: string }[] }[] };
      const refs = reg.gates.find((g) => g.gate === 'QG-02')!.blockers.map((b) => b.ref);
      expect(refs, release).not.toContain('role-check:cashier');
      expect(refs, release).not.toContain('role-check:cashier:final');
    }
    const kept = (await shop.cloud().request({ method: 'GET', path: '/v1/hr/workforce/role-checks/cashier/attempts', userId: OWNER })).body as { attempts: { employeeId: string; scorePercent: number; recordedBy: string }[] };
    expect(kept.attempts.map((a) => [a.employeeId, a.scorePercent, a.recordedBy])).toEqual([['u-cash-asha', 100, MGR], ['u-cash-bala', 50, MGR], ['u-cash-bala', 100, MGR]]);
  }, 240_000);
});
