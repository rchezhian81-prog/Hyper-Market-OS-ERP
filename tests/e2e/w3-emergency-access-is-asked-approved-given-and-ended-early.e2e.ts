import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startInboxShop, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import { openAs } from './lib/w3-page';
import { says } from './lib/r4c-box-page';

/**
 * **W3 · D11-FR-02 (M02-FR-04 · SEC-11 · §28): emergency access, in a real browser, on the PRODUCTION API over real
 * PostgreSQL.** The store manager asks on the Emergency access page for exactly one grant (who, which role, which store,
 * for how long, why); nothing changes until the OWNER approves exactly that on his own Approvals page; the manager then
 * gives it, and it carries the end time fixed at that moment; the owner ends it early. Every step is head office's
 * record: the grant shows as ended early in the review, and the approval was used once.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['w3', 'emergency', 'key'].join('-').padEnd(48, '0');

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('Emergency access (D11-FR-02) on the production API, in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/emergency-access', html: 'emergency-access.html', dataGlobal: 'emergencyAccessData' },
      alsoPages: [{ path: '/approvals', html: 'approvals.html', dataGlobal: 'approvalsData' }],
      seed: async () => {},
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  it('the manager asks, the owner approves on his Approvals page, the manager gives it, the owner ends it early', async () => {
    // ── The manager asks ──
    let s = await openAs(shop, browser, MGR, '/emergency-access', 'br-1');
    try {
      await says(s.page, '#asks', /You have not asked for emergency access\./);
      expect(await s.page.isVisible('#review')).toBe(false); // the review is the owner's (identity.role.read)
      await s.page.fill('#e-person', 'u-support'); await s.page.fill('#e-role', 'cashier'); await s.page.fill('#e-stores', 'br-1');
      await s.page.fill('#e-minutes', '45');
      await s.page.click('#e-ask');
      await says(s.page, '#ask-status', /^Say why, specifically\.$/);
      expect(s.writes).toEqual([]); // refused before anything was sent
      await s.page.fill('#e-reason', 'cover the tills while the cash office PC is repaired');
      await s.page.click('#e-ask');
      await says(s.page, '#ask-status', /^Asked\. The owner decides it on the Approvals page/);
      await says(s.page, '#asks li[data-status="waiting"]', /u-support — cashier · br-1 · 45 minutes/);
      expect(await s.page.locator('#asks button').count(), 'nothing to give before the owner approves').toBe(0);
      expect(s.writes).toEqual(['POST /v1/approvals/requests']);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    // Nothing changed yet: no grant is on record.
    expect(((await shop.cloud().request({ method: 'GET', path: '/v1/access/emergency', userId: OWNER })).body as { count: number }).count).toBe(0);
    const mine = (await shop.cloud().request({ method: 'GET', path: '/v1/approvals/requests', userId: MGR, branchId: 'br-1' })).body as { mine: { requestId: string; kind: string; subjectRef: string }[] };
    const ask = mine.mine.find((r) => r.kind === 'emergency_access')!;

    // ── The owner approves it on his own Approvals page ──
    s = await openAs(shop, browser, OWNER, '/approvals');
    try {
      const row = s.page.locator(`#waiting li[data-request-id="${ask.requestId}"]`);
      await row.waitFor({ timeout: 15_000 });
      await row.locator('input.reason').fill('Agreed for the repair window only');
      await row.locator('button.approve').click();
      await row.waitFor({ state: 'detached', timeout: 15_000 });
      expect(s.writes).toEqual([`POST /v1/approvals/requests/${ask.requestId}/decide`]);
    } finally { await s.close(); }

    // ── The manager gives it ──
    s = await openAs(shop, browser, MGR, '/emergency-access', 'br-1');
    try {
      const row = s.page.locator(`#asks li[data-grant="${ask.subjectRef}"]`);
      await says(s.page, `#asks li[data-grant="${ask.subjectRef}"]`, /Approved — you can give it now \(u-owner\)/);
      await row.locator('button').click();
      await says(s.page, `#asks li[data-grant="${ask.subjectRef}"]`, /Given\. It ends on its own at \d{4}-\d{2}-\d{2} \d{2}:\d{2}\./);
      expect(s.writes).toEqual([`POST /v1/access/emergency/${ask.subjectRef}`]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    // ── The owner sees it live in the review and ends it early ──
    s = await openAs(shop, browser, OWNER, '/emergency-access');
    try {
      const row = s.page.locator(`#grants li[data-grant="${ask.subjectRef}"]`);
      await says(s.page, `#grants li[data-grant="${ask.subjectRef}"]`, /u-support — live.*for 45 minutes · approved by u-owner · cover the tills/);
      await row.locator('button').click();
      await says(s.page, `#grants li[data-grant="${ask.subjectRef}"]`, /u-support — ended early/);
      expect(s.writes).toEqual([`POST /v1/access/emergency/${ask.subjectRef}/revoke`]);
      await s.page.click('#lang');
      await says(s.page, '#review-h', /^ஒவ்வொரு அவசர அணுகலும்$/);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    const review = (await shop.cloud().request({ method: 'GET', path: '/v1/access/emergency', userId: OWNER })).body as { review: { grantId: string; endedEarly: boolean; active: boolean; approvedBy: string }[] };
    expect(review.review).toEqual([expect.objectContaining({ grantId: ask.subjectRef, endedEarly: true, active: false, approvedBy: OWNER })]);
    const after = (await shop.cloud().request({ method: 'GET', path: '/v1/approvals/requests', userId: MGR, branchId: 'br-1' })).body as { mine: { requestId: string; status: string }[] };
    expect(after.mine.find((r) => r.requestId === ask.requestId)?.status).toBe('used'); // the approval was spent once
  }, 240_000);
});
