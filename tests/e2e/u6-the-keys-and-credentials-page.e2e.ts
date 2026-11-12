import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page, type Locator } from 'playwright-core';
import { startInboxShop, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import { auditPage } from './lib/a11y-audit';
import { confirmIt, goBack, sheetOpens } from './lib/confirm-sheet';

/**
 * **The Keys and credentials page (U6 · §27 Admin/Security "keys" · M32-FR-03 · SEC-04 · hard rule 4) — in a real
 * browser, on the PRODUCTION API over real PostgreSQL, through the store computer's own door.**
 *
 * The UI/UX gap audit (lane 4, 1 Nov 2026) found no screen naming the shop's keys and credentials. Now: the owner opens the
 * page and reads every secret as a register (what it protects, who owns it, its state as a chip, when its change is due in
 * words), the counts as cards, head office's review (the overdue one named), and the use over 30 days; changes a secret
 * over behind the confirm sheet (the old version keeps a grace); revokes one at once with a reason behind the danger sheet
 * and reads what will break; cuts a person's sign-ins; reads it all in Tamil with head office's own sentences left in
 * English; on a 360px phone with no sideways scroll. A store manager is told the page is not for their role. No value of
 * any secret ever reaches the screen. Synthetic data, a fresh tenant. Needs DATABASE_URL and Chromium; else it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['u6', 'keys', 'page', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the Keys and credentials page (U6 · M32-FR-03)', () => {
  let browser: Browser;
  let shop: InboxShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/keys', html: 'keys.html', dataGlobal: 'keysData' },
      seed: async (cloud) => {
        const owner = (path: string, body: unknown, key: string) => cloud.request({ method: 'POST', path, userId: OWNER, idempotencyKey: key, body });
        // Two synthetic secret REFERENCES (never a value): the card payments one, last changed long ago (overdue on a 30-day
        // policy), and the GST portal one, in date on a yearly policy.
        const a = await owner('/v1/integration/secrets/sec-pay', { kind: 'payment_provider', vaultRef: 'vault://payments/live#v1', owner: OWNER, protects: 'card payments at the tills', rotateEveryDays: 30, environment: 'production', lastRotatedOn: '2025-01-01' }, 'seed-sec-pay');
        if (a.status !== 201) throw new Error(`sec-pay: ${a.status} ${JSON.stringify(a.body)}`);
        const b = await owner('/v1/integration/secrets/sec-gst', { kind: 'gst_portal', vaultRef: 'vault://gst/portal#v1', owner: OWNER, protects: 'filing GST returns', rotateEveryDays: 365, environment: 'production' }, 'seed-sec-gst');
        if (b.status !== 201) throw new Error(`sec-gst: ${b.status} ${JSON.stringify(b.body)}`);
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string, viewport?: { width: number; height: number }) => {
    const context = await browser.newContext(viewport === undefined ? {} : { viewport, isMobile: true, hasTouch: true });
    await shop.signIn(context, who, who === MGR ? 'br-1' : undefined);
    const page = await context.newPage();
    const errors: string[] = []; const writes: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}/keys`, { waitUntil: 'load' });
    return { page, errors, writes, close: () => context.close() };
  };
  const rowOf = (page: Page, secretId: string) => page.locator(`#inv-table tr[data-secret="${secretId}"]`);
  /** vitest's expect carries no Playwright matchers: the page is read and polled instead. */
  const saysSoon = (loc: Locator, re: RegExp | string) => expect.poll(async () => (await loc.count()) === 0 ? '' : loc.first().innerText(), { timeout: 15_000 }).toMatch(re);
  const attrSoon = (loc: Locator, name: string, value: string) => expect.poll(() => loc.first().getAttribute(name), { timeout: 15_000 }).toBe(value);
  const countSoon = (loc: Locator, n: number) => expect.poll(() => loc.count(), { timeout: 15_000 }).toBe(n);

  it('the owner reads the inventory, the counts, the review and the use; changes a secret over, revokes one and cuts a sign-in — each behind the confirm sheet', async () => {
    const s = await open(OWNER);
    try {
      await expect.poll(() => rowOf(s.page, 'sec-pay').count(), { timeout: 15_000 }).toBe(1);
      expect(s.writes.filter((w) => !w.endsWith('/secrets/review')), 'nothing is written on open (the review is a read that head office takes as a POST)').toEqual([]);
      expect(s.errors).toEqual([]);
      // the register: state as a chip, the change due in words, the owner by name
      await attrSoon(rowOf(s.page, 'sec-pay'), 'data-due', 'overdue');
      await saysSoon(rowOf(s.page, 'sec-pay'), /overdue by \d+ days \(was due 31 Jan 2025\)/);
      await saysSoon(rowOf(s.page, 'sec-pay').locator('.sre-chip'), 'in use');
      await attrSoon(rowOf(s.page, 'sec-gst'), 'data-due', 'ok');
      await saysSoon(rowOf(s.page, 'sec-gst'), /due in \d+ days/);
      // a secret's VALUE never reaches the screen: the page shows references and words only
      const html = await s.page.content();
      expect(html).not.toMatch(/sk_live|sk_test|BEGIN (RSA |EC )?PRIVATE KEY|whsec_/i);
      // the cards count what the register shows
      const card = (label: string) => s.page.locator('#inv-cards .sre-summary-card', { hasText: label }).locator('.sre-summary-value');
      await saysSoon(card('In use'), /^2$/);
      await saysSoon(card('Change overdue'), /^1$/);
      await saysSoon(card('Revoked'), /^0$/);
      // head office's review names the overdue one; its sentence stays English
      const overdueId = 'sec-pay'; // an inventory row's id, not a credential: the page never holds a secret value
      const finding = s.page.locator(`#rev-table tr[data-secret="${overdueId}"][data-finding="overdue_rotation"]`);
      await countSoon(finding, 1);
      await saysSoon(finding.locator('[lang="en"]'), /card payments at the tills/);
      // the use over 30 days: nothing used yet, said as such, never "all clear"
      await saysSoon(s.page.locator('#use-table .sre-state[data-state="empty"]'), 'No machine credential was used');
      // the other credentials' pages, as links
      await countSoon(s.page.locator('#where-cards a[href="../partners/"]'), 1);

      // ── change sec-pay over, with a 7-day grace, behind the sheet; Go back sends nothing
      await s.page.selectOption('#rot-which', 'sec-pay');
      await s.page.fill('#rot-ref', 'vault://payments/live#v2');
      await s.page.fill('#rot-grace', '7');
      const before = s.writes.length;
      await s.page.click('#rot-btn');
      expect(await sheetOpens(s.page)).toMatch(/Change this secret over\?/);
      await saysSoon(s.page.locator('.sre-confirm'), 'stays valid for 7 days');
      await goBack(s.page);
      expect(s.writes.length, 'Go back sent nothing').toBe(before);
      await s.page.click('#rot-btn');
      await sheetOpens(s.page);
      await confirmIt(s.page);
      await saysSoon(s.page.locator('#rot-status'), 'Changed over');
      expect(s.writes).toContain('POST /v1/integration/secrets/sec-pay/rotation');
      // head office records version 2, changed today (the old version keeps its grace): the change is no longer overdue
      await attrSoon(rowOf(s.page, 'sec-pay'), 'data-due', 'ok');
      await saysSoon(rowOf(s.page, 'sec-pay'), /due in 30 days/);
      await saysSoon(rowOf(s.page, 'sec-pay').locator('.sre-chip'), 'in use');
      await saysSoon(card('Change overdue'), /^0$/);

      // ── a key typed where a reference belongs is refused before anything is sent
      await s.page.selectOption('#rot-which', 'sec-gst');
      await s.page.fill('#rot-ref', 'sk_live_abcdef123456');
      const sent = s.writes.length;
      await s.page.click('#rot-btn');
      await sheetOpens(s.page); await confirmIt(s.page);
      await saysSoon(s.page.locator('#rot-status'), 'looks like a key itself');
      expect(s.writes.length, 'a key is never sent').toBe(sent);

      // ── revoke sec-gst at once, with a reason, behind the DANGER sheet
      await s.page.selectOption('#rvk-which', 'sec-gst');
      await s.page.fill('#rvk-reason', 'the laptop that held it was stolen');
      await s.page.click('#rvk-btn');
      expect(await sheetOpens(s.page)).toMatch(/Revoke this secret now\?/);
      expect(await s.page.locator('.sre-confirm [data-tone="danger"], .sre-confirm.danger, .sre-confirm .sre-btn-danger').count(), 'the danger sheet').toBeGreaterThan(0);
      await confirmIt(s.page);
      await saysSoon(s.page.locator('#rvk-status'), 'Revoked');
      await saysSoon(s.page.locator('#rvk-breaks'), 'No live connection pointed at it');
      expect(s.writes).toContain('POST /v1/integration/secrets/sec-gst/revocation');
      await expect.poll(() => rowOf(s.page, 'sec-gst').getAttribute('data-state'), { timeout: 15_000 }).toBe('revoked');
      await saysSoon(card('Revoked'), /^1$/);

      // ── cut a person's sign-ins
      await s.page.selectOption('#tok-target', 'user');
      await s.page.fill('#tok-who', 'u-ravi');
      await s.page.selectOption('#tok-reason', 'security');
      await s.page.click('#tok-btn');
      expect(await sheetOpens(s.page)).toMatch(/Cut these sign-ins\?/);
      await confirmIt(s.page);
      await saysSoon(s.page.locator('#tok-status'), 'Cut.');
      await countSoon(s.page.locator('#tok-table tr[data-who="u-ravi"]'), 1);
      expect(s.writes).toContain('POST /v1/identity/token-revocations');
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  });

  it('reads in Tamil with head office\'s sentences left in English, fits a 360px phone, and tells a store manager it is not for their role', async () => {
    const s = await open(OWNER, { width: 360, height: 740 });
    try {
      await expect.poll(() => rowOf(s.page, 'sec-pay').count(), { timeout: 15_000 }).toBe(1);
      expect(await auditPage(s.page, { expectLang: 'en' })).toEqual([]);
      await s.page.click('#lang');
      await saysSoon(s.page.locator('#page-h'), 'சாவிகளும் சான்றுகளும்');
      await saysSoon(s.page.locator('#inv-h'), 'ரகசியங்கள்');
      // the state chip in Tamil, whichever state the earlier test left it in (in use / changing over)
      await saysSoon(rowOf(s.page, 'sec-pay').locator('.sre-chip'), /பயன்பாட்டில்|மாறிக்கொண்டிருக்கிறது/);
      // the register's own words follow the toggle; head office's finding sentence is marked as English
      const english = s.page.locator('#rev-table [lang="en"]');
      if ((await english.count()) > 0) expect(await english.first().innerText()).toMatch(/[A-Za-z]/);
      expect(await auditPage(s.page, { expectLang: 'ta' })).toEqual([]);
      const overflow = await s.page.evaluate(() => { const d = (globalThis as unknown as { document: { documentElement: { scrollWidth: number; clientWidth: number } } }).document.documentElement; return d.scrollWidth - d.clientWidth; });
      expect(overflow, 'no sideways scroll on a phone').toBeLessThanOrEqual(0);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    const m = await open(MGR);
    try {
      await saysSoon(m.page.locator('#page-status'), 'Your role does not include this');
      expect(await m.page.locator('#inv').isHidden()).toBe(true);
      expect(await m.page.locator('#rot').isHidden()).toBe(true);
      expect(await m.page.locator('#tok').isHidden()).toBe(true);
      expect(m.writes.filter((w) => !w.endsWith('/secrets/review'))).toEqual([]);
    } finally { await m.close(); }
  });
});
