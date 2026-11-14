import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Locator } from 'playwright-core';
import { startInboxShop, OWNER, type InboxShop } from './lib/ai-inbox-shop';
import { confirmIt, goBack, sheetOpens } from './lib/confirm-sheet';

/**
 * **MG-09 — the delta LOADED, exactly once, from the Old system checks page (U6 · §27 Migration "delta load" · GT-04 · hard
 * rules #6, #7, #10) — in a real browser, on the PRODUCTION API over real PostgreSQL.**
 *
 * The audit (lane 4) found the delta load, the trial load and source profiling "not found as their own steps". Now the
 * page carries the twelve controls as a ladder, and the delta's LOAD is its own step: the owner reads a changes file (the
 * route's own columns), sees the changes as a register before anything is sent, names the extract's moment on the shared
 * dd/mm/yyyy field, and loads them behind the confirm sheet — two stock changes land, a kind head office does not apply is
 * refused by name; the same file loaded again changes nothing ("already applied", a success); a change dated before the
 * extract is refused as already in it. Synthetic data, a fresh tenant. Needs DATABASE_URL and Chromium; else it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['u6', 'delta', 'load', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');

const CHANGES = [
  'changeKey,entity,legacyId,operation,changedAt,deltaQty,locationId,uom,unitCostMinor',
  'd-in,stock,P-DAL,update,2026-10-09T08:00:00.000Z,20,S1,ea,12000',
  'd-out,stock,P-DAL,update,2026-10-09T09:00:00.000Z,-5,S1,ea,',
  'd-cust,customer,C-901,insert,2026-10-09T09:30:00.000Z,,,,',
].join('\n');
const EARLY = [
  'changeKey,entity,legacyId,operation,changedAt,deltaQty,locationId,uom,unitCostMinor',
  'd-early,stock,P-DAL,update,2026-10-01T08:00:00.000Z,3,S1,ea,12000',
].join('\n');

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the Old system checks page loads the delta exactly once (MG-09 · U6)', () => {
  let browser: Browser;
  let shop: InboxShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/old-system', html: 'old-system.html', dataGlobal: 'oldSystemData' },
      seed: async () => { /* a fresh synthetic tenant: the delta is the first thing that moves stock */ },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const saysSoon = (loc: Locator, re: RegExp | string) => expect.poll(async () => (await loc.count()) === 0 ? '' : loc.first().innerText(), { timeout: 15_000 }).toMatch(re);
  const countSoon = (loc: Locator, n: number) => expect.poll(() => loc.count(), { timeout: 15_000 }).toBe(n);

  it('the ladder, the changes read and shown before sending, the load behind the sheet, the second load that changes nothing, the early change refused', async () => {
    const context = await browser.newContext();
    await shop.signIn(context, OWNER);
    const page = await context.newPage();
    const errors: string[] = []; const writes: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}/old-system`, { waitUntil: 'load' });
    try {
      // the twelve controls as their own steps, MG-09 as two (find, then load); each a 44px link to its section
      await countSoon(page.locator('#steps-list a'), 13);
      // the link's words are its control code and its step on one line (innerText joins the two with a space or a newline)
      const steps = (await page.locator('#steps-list a').allInnerTexts()).map((x) => x.replace(/\s+/g, ' '));
      expect(steps.some((x) => /MG-01 Source profiling/.test(x)), steps.join(' | ')).toBe(true);
      expect(steps.some((x) => /MG-05 Trial load/.test(x))).toBe(true);
      expect(steps.some((x) => /MG-09 Delta — the changes loaded, exactly once/.test(x))).toBe(true);
      const box = await page.locator('#steps-list a[data-step="delta"]').boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(writes, 'nothing is written on open').toEqual([]);
      await expect.poll(() => page.locator('#delta').isVisible()).toBe(true);

      // read the file: the changes are shown as a register, nothing sent
      await page.locator('#delta-file').setInputFiles({ name: 'changes.csv', mimeType: 'text/csv', buffer: Buffer.from(CHANGES) });
      await page.click('#delta-read');
      await saysSoon(page.locator('#delta-status'), /3 changes read from the file — nothing sent yet/);
      await countSoon(page.locator('#delta-rows tr[data-change]'), 3);
      expect(writes).toEqual([]);

      // no cutoff → refused in words before anything is sent
      await page.click('#delta-load');
      await saysSoon(page.locator('#delta-status'), /Say the day the final extract was taken first/);
      expect(writes).toEqual([]);

      // the extract's moment on the shared dd/mm/yyyy field; Go back sends nothing
      await page.fill('#delta-cutoff', '09/10/2026');
      await page.fill('#delta-time', '00:00');
      await page.click('#delta-load');
      expect(await sheetOpens(page)).toMatch(/Load these changes into the shop\?/);
      await saysSoon(page.locator('.sre-confirm'), /3 changes made in the old system after 9 Oct 2026/);
      await goBack(page);
      expect(writes).toEqual([]);

      // the load: two stock changes applied, the customer change refused by name — never counted
      await page.click('#delta-load');
      await sheetOpens(page); await confirmIt(page);
      await saysSoon(page.locator('#delta-status'), /applied: 2 · already applied: 0 · refused: 1 · net stock: 15/);
      expect(writes).toEqual(['POST /v1/migration/deltas']);
      await saysSoon(page.locator('#delta-result li[data-change="d-in"]'), /applied/);
      expect(await page.locator('#delta-result li[data-change="d-cust"]').getAttribute('data-outcome')).toBe('refused_unsupported_entity');
      await saysSoon(page.locator('#delta-result li[data-change="d-cust"]'), /a kind head office does not apply/);
      // the stock really moved, once: head office's own availability read
      const onHand = await shop.cloud().request({ method: 'GET', path: '/v1/inventory/availability?productId=P-DAL', userId: OWNER });
      expect((onHand.body as { rows: { locationId: string; onHandMinor: number }[] }).rows.find((r) => r.locationId === 'S1')?.onHandMinor).toBe(15);

      // the same file again: already applied, a success; the stock does not move twice
      await page.click('#delta-load');
      await sheetOpens(page); await confirmIt(page);
      await saysSoon(page.locator('#delta-status'), /applied: 0 · already applied: 2 · refused: 1/);
      expect(await page.locator('#delta-result li[data-change="d-in"]').getAttribute('data-outcome')).toBe('already_applied');
      const again = await shop.cloud().request({ method: 'GET', path: '/v1/inventory/availability?productId=P-DAL', userId: OWNER });
      expect((again.body as { rows: { locationId: string; onHandMinor: number }[] }).rows.find((r) => r.locationId === 'S1')?.onHandMinor).toBe(15);

      // a change dated before the extract: refused as already in the extract
      await page.locator('#delta-file').setInputFiles({ name: 'early.csv', mimeType: 'text/csv', buffer: Buffer.from(EARLY) });
      await page.click('#delta-read');
      await saysSoon(page.locator('#delta-status'), /1 changes read/);
      await page.click('#delta-load');
      await sheetOpens(page); await confirmIt(page);
      await saysSoon(page.locator('#delta-status'), /applied: 0 · already applied: 0 · refused: 1/);
      expect(await page.locator('#delta-result li[data-change="d-early"]').getAttribute('data-outcome')).toBe('refused_before_cutoff');

      // a file that cannot be read is refused by row and by name, and nothing is sent
      const sent = writes.length;
      await page.locator('#delta-file').setInputFiles({ name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from('changeKey,entity,legacyId,operation,changedAt\nd-x,stock,P-1,upsert,2026-10-09T08:00:00.000Z') });
      await page.click('#delta-read');
      await saysSoon(page.locator('#delta-status'), /Row 2 cannot be read: "operation"/);
      expect(writes.length).toBe(sent);

      // Tamil: the step, the ladder and the outcomes in the reader's language
      await page.click('#lang');
      await saysSoon(page.locator('#delta-h'), 'இறுதி ஏற்றுமதிக்குப் பின் நடந்த மாற்றங்களை ஏற்று');
      await saysSoon(page.locator('#steps-list a[data-step="delta"]'), /ஒரே ஒரு முறை/);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });
});
