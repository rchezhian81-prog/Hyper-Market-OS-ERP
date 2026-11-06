import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startW4Shop, openAs, says, type W4Shop } from './lib/w4-office-shop';
import { aBranch } from '../support/a-branch';

/**
 * **W6 — two head-office routes no screen called, now on their pages, in a real browser, on the production API surface (over
 * real PostgreSQL when DATABASE_URL is set).** Synthetic data only.
 *   • Devices (M33-FR-04 · A-10 · P-08): the page reads head office's fleet health as the person. With no app version policy
 *     set it says the fleet cannot be judged — no counts, never "all well"; once the owner sets one, the real tills show, the
 *     one on a build below the minimum first ("Must update before trading"), in English and Tamil.
 *   • Loyalty (M17-FR-02 · OB-221 · OB-356): a referral reward the shop owes is paid out by the manager — how, and the store
 *     credit number — and another is let lapse with the reason; each leaves the list, and head office's liability register
 *     owes nothing more on either.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER = 'u-owner'; const MGR = 'u-mgr'; const CASH = 'u-cash';
const STORE = 'store-1';

describe.skipIf(!existsSync(CHROMIUM))('W6 · the Devices page reads fleet health; the Loyalty page pays out a referral reward', () => {
  let browser: Browser;
  let shop: W4Shop;
  const T = randomUUID();
  const as = (who: string, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) => shop.ho().request({ method, path, userId: who, tenantId: T, ...(method !== 'GET' ? { idempotencyKey: `seed-${randomUUID()}`, body: body ?? {} } : {}) });
  const must = async (p: ReturnType<typeof as>, what: string) => { const r = await p; if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`); return r.body as Record<string, unknown>; };

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startW4Shop({
      tenantId: T, databaseUrl: DATABASE_URL, pages: {
        '/fleet': { html: 'fleet.html', dataGlobal: 'fleetData' }, '/loyalty': { html: 'loyalty.html', dataGlobal: 'loyaltyDeskData' },
      },
    });
    const h = shop.ho();
    await h.seedOwner(T, OWNER);
    await h.enableFeature(T, 'loyalty');
    await aBranch(h, T, OWNER, STORE);
    await h.provisionRole(T, MGR, 'store_manager', [STORE]);
    await h.provisionRole(T, CASH, 'cashier', [STORE]);
    // Two tills on head office's registry: one current, one on a build below the minimum the owner will set.
    await must(as(OWNER, 'POST', '/v1/platform/devices/lane-1/register', { branchId: STORE, kind: 'pos_lane', label: 'Till 1', appVersion: '2.1.0' }), 'lane-1');
    await must(as(OWNER, 'POST', '/v1/platform/devices/lane-2/register', { branchId: STORE, kind: 'pos_lane', label: 'Till 2', appVersion: '1.9.0' }), 'lane-2');
    // Two referral rewards earned and owed (head office's referral assessment records each once; synthetic customers).
    for (const [id, reward] of [['ref-w6-a', 5_000], ['ref-w6-b', 2_500]] as const) {
      const r = await must(as(OWNER, 'POST', `/v1/loyalty/referrals/${id}`, { referrerRef: `c-${id}-1`, referredRef: `c-${id}-2`, referredPurchases: [{ netMinor: 60_000, at: new Date().toISOString() }], qualifyingSpendMinor: 50_000, rewardMinor: reward }), id);
      expect(r['payable']).toBe(true);
    }
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 240_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  it('Devices: no version policy → said, no counts; the owner sets one → the real tills, the one that must update first (M33-FR-04)', async () => {
    const before = await openAs(shop, browser, MGR, '/fleet', STORE);
    try {
      await says(before.page, '#health-text', /^Head office has no app version policy yet, so it cannot judge the devices\./);
      expect(await before.page.isHidden('#tiles')).toBe(true);
      expect(await before.page.textContent('#attention-count')).toBe('');
      expect(await before.page.isHidden('#state')).toBe(true); // never "No devices are registered yet" over a fleet nobody read
      // The read is a POST only because it may carry a body; it records nothing.
      expect(before.writes).toEqual(['POST /v1/platform/devices/fleet-health']);
      expect(before.errors).toEqual([]);
    } finally { await before.close(); }

    await must(as(OWNER, 'POST', '/v1/platform/version-policy', { policy: { currentVersion: '2.1.0', previousVersion: '2.0.0', minimumSupportedVersion: '2.0.0' } }), 'policy');
    const after = await openAs(shop, browser, MGR, '/fleet', STORE);
    try {
      await says(after.page, '#health-text', /^The fleet as head office holds it\.$/);
      await says(after.page, '#rows li:first-child', /Till 2.*Must update before trading/);
      await says(after.page, '#rows', /Till 1.*Up to date/);
      await says(after.page, '#tiles', /^2Devices/);
      await says(after.page, '#attention-count', /^1 need a look$/); // Till 2 must update; Till 1 checked in when it was registered
      await after.page.click('#lang');
      await says(after.page, '#health-text', /^தலைமை அலுவலகம் வைத்துள்ளபடி சாதனங்கள்\.$/);
      await says(after.page, '#rows li:first-child', /வர்த்தகத்திற்கு முன் புதுப்பிக்க வேண்டும்/);
      expect(after.errors).toEqual([]);
    } finally { await after.close(); }
  });

  it('Loyalty: the manager pays one referral reward out (store credit, its number) and lets the other lapse (why) — head office owes neither (M17-FR-02 · OB-221)', async () => {
    const c = await openAs(shop, browser, CASH, '/loyalty', STORE);
    try {
      expect(await c.page.isHidden('#desk-owed')).toBe(true); // a cashier cannot settle a referral: not offered
    } finally { await c.close(); }

    const l = await openAs(shop, browser, MGR, '/loyalty', STORE);
    try {
      expect(l.writes, 'nothing is written on open').toEqual([]);
      await l.page.click('#cd-owed-go');
      await says(l.page, '#cd-owed-list li[data-referral="ref-w6-a"]', /^ref-w6-a — ₹50\.00 owed/);
      await says(l.page, '#cd-owed-list li[data-referral="ref-w6-b"]', /^ref-w6-b — ₹25\.00 owed/);
      // A payout with no receipt number is refused before anything is sent.
      await l.page.selectOption('#cd-owed-ref-w6-a-how', 'store_credit');
      await l.page.click('#cd-owed-ref-w6-a-pay-go');
      await says(l.page, '#cd-owed-ref-w6-a-status', /^Fill in every box marked as needed\.$/);
      expect(l.writes).toEqual([]);
      await l.page.fill('#cd-owed-ref-w6-a-ref', 'SC-W6-77');
      await l.page.click('#cd-owed-ref-w6-a-pay-go');
      await says(l.page, '#cd-owed-status', /^Recorded as paid\.$/);
      await says(l.page, '#cd-owed-list', /^ref-w6-b — ₹25\.00 owed/);
      expect(await l.page.locator('#cd-owed-list li[data-referral="ref-w6-a"]').count()).toBe(0);
      await l.page.fill('#cd-owed-ref-w6-b-why', 'The customer declined the reward (synthetic)');
      await l.page.click('#cd-owed-ref-w6-b-lapse-go');
      await says(l.page, '#cd-owed-status', /^Recorded as lapsed\.$/);
      await says(l.page, '#cd-owed-list', /^No referral reward is waiting to be paid\.$/);
      expect(l.writes).toEqual(['POST /v1/loyalty/referrals/ref-w6-a/payout', 'POST /v1/loyalty/referrals/ref-w6-b/expire']);
      await l.page.click('#lang');
      await says(l.page, '#cd-owed-list', /^கொடுக்கக் காத்திருக்கும் பரிந்துரைப் பரிசு எதுவும் இல்லை\.$/);
      expect(l.errors).toEqual([]);
    } finally { await l.close(); }

    const reg = (await must(as(OWNER, 'GET', '/v1/finance/referral-liability'), 'liability'))['register'] as { outstandingMinor: number; referrals: { referralId: string; state: string; paidMinor: number; expiredMinor: number }[] };
    expect(reg.outstandingMinor).toBe(0);
    expect(reg.referrals.map((r) => [r.referralId, r.state, r.paidMinor, r.expiredMinor])).toEqual([['ref-w6-a', 'paid', 5_000, 0], ['ref-w6-b', 'expired', 0, 2_500]]);
  });
});
