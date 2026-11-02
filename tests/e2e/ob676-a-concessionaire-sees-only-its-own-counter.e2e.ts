import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startInboxShop, ok, OWNER, type InboxShop } from './lib/ai-inbox-shop';

/**
 * **OB-676 "A" (owner, 2 Nov 2026, in writing) · M27-FR-02 "only the concessionaire accesses it" · M27-FR-03 — a
 * concessionaire signs in with ITS OWN login and sees only its own counter, in a real browser, on the PRODUCTION API over
 * real PostgreSQL (synthetic data).**
 *
 * The concessionaire's portal (apps/concession-app/web) is served in front of the real API (no stub); who is looking comes
 * from head office's own `GET /v1/identity/me`; every `/v1` call goes to the API under the login's own token, and the
 * concessionaire is the one its approved outside-party invite binds it to — never the request. The logins are given the
 * governed way (OB-76): the owner (who manages concessions) INVITES each, the accountant (a DIFFERENT person who also manages
 * them) APPROVES it; no password is typed anywhere.
 *
 *   • the jeweller's login sees its counter (terms, whether it may trade and why not, the deposit held for it), its own sale, the gold it owns on the
 *     shop's shelves and "no invoice yet" — never the mobile counter's sale or phones, nor the shop's own rice — and not one
 *     write leaves the page;
 *   • the mobile counter's login sees only its own;
 *   • a login invited but not yet approved holds nothing and is shown nothing;
 *   • after a RESTART of the API the jeweller reads the same; the page reads in Tamil; no page errors.
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['ob676', 'concession', 'portal', 'e2e', 'key'].join('-').padEnd(48, '0');
const ACCOUNTANT = 'u-acct-con'; const JEWEL = 'u-jewel'; const MOBILE = 'u-mobile'; const PENDING = 'u-pending';
const day = (offset: number): string => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
type Doc = { document: { querySelectorAll(x: string): { length: number }; getElementById(id: string): { hidden: boolean; textContent: string | null } | null } };

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('OB-676 — a concessionaire sees only its own counter (M27-FR-02), on the production API in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'concession-app'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/', html: 'index.html', dataGlobal: 'concessionData', webDir: 'apps/concession-app/web' },
      seed: async (cloud) => {
        let n = 0;
        const as = (path: string, body: unknown, userId = OWNER, method: 'POST' | 'PUT' = 'POST') => ok(cloud.request({ method, path, userId, idempotencyKey: `seed-${n += 1}`, body }), path);
        await as('/v1/platform/entitlements/dept.concession', { enabled: true }, OWNER, 'PUT');
        await cloud.grant(ACCOUNTANT, 'accountant');
        const contract = (who: string, name: string, share: number) => ({ concessionaireId: who, name, branchId: 'br-1', startsOn: day(-30), endsOn: day(300), basis: 'revenue_share', revenueShareBps: share, depositMinor: 50_000, insuranceUntil: day(200), licenceUntil: day(200) });
        await as('/v1/concession/contracts/C-JWL', contract('JWL-1', 'Jewellery counter', 1_500));
        await as('/v1/concession/contracts/C-MOB', contract('MOB-1', 'Mobile counter', 1_000));
        await as('/v1/concession/concessionaires/JWL-1/deposit-movements/dep-1', { kind: 'received', amountMinor: 50_000 });
        await as('/v1/concession/contracts/C-JWL/sales', { saleId: 'S-J1', grossMinor: 250_000, taxMinor: 7_500, tenderedTo: 'store_till' });
        await as('/v1/concession/contracts/C-MOB/sales', { saleId: 'S-M1', grossMinor: 999_900, taxMinor: 0, tenderedTo: 'store_till' });
        const at = new Date().toISOString();
        await as('/v1/inventory/movements', { movementId: 'g1', productId: 'GOLD-CHAIN', locationId: 'br-1', kind: 'received', quantityMinor: 2, uom: 'each', unitCostMinor: 2_000_000, ownership: 'concession', ownerId: 'JWL-1', occurredAt: at, enteredBy: OWNER });
        await as('/v1/inventory/movements', { movementId: 'm1', productId: 'PHONE-X', locationId: 'br-1', kind: 'received', quantityMinor: 5, uom: 'each', unitCostMinor: 1_000_000, ownership: 'concession', ownerId: 'MOB-1', occurredAt: at, enteredBy: OWNER });
        await as('/v1/inventory/movements', { movementId: 'r1', productId: 'RICE', locationId: 'br-1', kind: 'received', quantityMinor: 10, uom: 'each', unitCostMinor: 5_000, occurredAt: at, enteredBy: OWNER });
        // The logins: each a named person, bound to its own concessionaire through the governed two-person path (OB-76).
        await expect(cloud.grant(JEWEL, 'concessionaire')).rejects.toThrow(/outside_party_login_holds_only_its_role/);
        for (const [party, userId, displayName] of [['JWL-1', JEWEL, 'Lakshmi Narayanan'], ['MOB-1', MOBILE, 'Arun Prakash'], ['JWL-1', PENDING, 'Divya Shankar']] as const) {
          await as(`/v1/identity/outside-logins/concessionaires/${party}/invites/inv-${userId}`, { userId, displayName });
          if (userId !== PENDING) await as(`/v1/identity/outside-logins/concessionaires/invites/inv-${userId}/approve`, {}, ACCOUNTANT);
        }
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string, waitFor = '#sales li.row') => {
    const context = await browser.newContext();
    await shop.signIn(context, who);
    const page = await context.newPage();
    const requests: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/')) requests.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}/`, { waitUntil: 'load' });
    await page.waitForFunction((sel) => (globalThis as unknown as Doc).document.querySelectorAll(sel).length > 0, waitFor, { timeout: 15_000 });
    return { page, requests, errors, close: async () => { await page.waitForLoadState('networkidle').catch(() => {}); await context.close(); } };
  };

  it('the jeweller sees its own counter, sale, gold and "no invoice yet" — never the mobile counter\'s or the shop\'s own — and writes nothing; a restart reads the same; Tamil', async () => {
    let s = await open(JEWEL);
    try {
      expect(await s.page.locator('#counters li.row').count()).toBe(1);
      const counter = await s.page.innerText('#counters li.row');
      expect(counter).toContain('Jewellery counter (C-JWL) · Store br-1');
      // Recorded without a second person's approval, the contract may not trade (M27-FR-01) — the portal says so, and why.
      expect(counter).toMatch(/May NOT trade today: .+/);
      expect(counter).toContain('Revenue share: 15.00%');
      expect(await s.page.innerText('#deposit')).toBe('Deposit held for you: ₹500.00');
      expect(await s.page.locator('#sales li.row').count()).toBe(1);
      expect(await s.page.innerText('#sales')).toContain('S-J1 · C-JWL');
      expect(await s.page.innerText('#sales-total')).toBe('Total of these sales: ₹2,500.00');
      expect(await s.page.locator('#stock li.row').count()).toBe(1);
      expect(await s.page.innerText('#stock li.row')).toMatch(/Product: GOLD-CHAIN[\s\S]*₹40,000\.00[\s\S]*Place: br-1[\s\S]*On hand: 2/);
      expect(await s.page.innerText('#invoices-note')).toBe('No invoice has been issued to you yet.');
      const all = await s.page.innerText('main');
      for (const other of ['Mobile counter', 'S-M1', 'PHONE-X', 'RICE', '₹9,999.00']) expect(all, other).not.toContain(other);
      for (const f of ['counters', 'sales', 'stock', 'invoices']) expect(s.requests).toContain(`GET /v1/concession-portal/me/${f}`);
      expect(s.requests.every((r) => r.startsWith('GET ')), 'not one write leaves the portal').toBe(true);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    await shop.restart();
    s = await open(JEWEL);
    try {
      expect(await s.page.locator('#sales li.row').count()).toBe(1);
      expect(await s.page.innerText('#title')).toBe('Your counter at SRE');
      await s.page.click('#lang');
      await s.page.waitForFunction(() => /[஀-௿]/.test((globalThis as unknown as Doc).document.getElementById('title')?.textContent ?? ''), undefined, { timeout: 10_000 });
      expect(await s.page.innerText('#counters li.row')).toContain('இன்று வியாபாரம் செய்ய முடியாது');
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 180_000);

  it('the mobile counter\'s login sees only its own; a login not yet approved is told the page is not for it and shown nothing', async () => {
    let s = await open(MOBILE);
    try {
      const all = await s.page.innerText('main');
      expect(all).toContain('Mobile counter (C-MOB)');
      expect(all).toContain('PHONE-X');
      for (const other of ['Jewellery counter', 'S-J1', 'GOLD-CHAIN']) expect(all, other).not.toContain(other);
    } finally { await s.close(); }

    s = await open(PENDING, '#state:not([hidden])');
    try {
      // Not yet approved, the login holds no role at all: head office names nobody with any right here, and the page shows nothing.
      expect(await s.page.innerText('#state')).toMatch(/Nobody is signed in on this page|This page is for a concessionaire’s own login only/);
      expect(await s.page.isHidden('#counters-section')).toBe(true);
      expect(s.requests.every((r) => r.startsWith('GET '))).toBe(true);
    } finally { await s.close(); }
  }, 120_000);
});
