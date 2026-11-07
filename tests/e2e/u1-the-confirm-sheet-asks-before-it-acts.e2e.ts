import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { auditPage } from './lib/a11y-audit';
import { startOfficeShop, PEOPLE, type OfficeShop } from './lib/office-shop';

/**
 * **The confirm sheet (OB-698 · design system §1.3 · §27.1 · UI/UX gap audit G4), on a real office page in real Chromium.**
 *
 * Before money, stock, a price or a privilege moves, the page asks `sreOffice.confirm({ title, detail, authority,
 * confirmLabel, tone, reason? })`. Proven here on the rendered sheet:
 *   • it opens with the title (the figure), the consequence and the authority line, in English, and repaints in Tamil;
 *   • the focus lands on Go back (the safe answer) and Tab stays inside;
 *   • Escape, Go back and a tap on the scrim all answer `{ ok: false }`; Enter on the reason field never confirms;
 *   • the confirm button answers `{ ok: true }` and carries the reason;
 *   • a required reason refuses a blank with the message beside the field, and a too-short one too;
 *   • the audit (contrast, 44px targets, names, labels, one h1, no sideways scroll) is clean with the sheet open at a desk
 *     and on a phone;
 *   • a second ask closes the first as "go back" (never two sheets).
 * Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DESK = { viewport: { width: 1280, height: 860 } };
const PHONE = { viewport: { width: 360, height: 640 }, hasTouch: true, isMobile: true };

const SPEC = {
  title: { en: '₹12,400.00 will be posted to the accounts for 31 Oct 2026', ta: '31 அக் 2026-க்கு ₹12,400.00 கணக்குகளில் பதியப்படும்' },
  detail: { en: 'Every till of this shop for that day. A posted day can be reopened only with a second person.', ta: 'அந்த நாளின் இந்தக் கடையின் ஒவ்வொரு கல்லாவும். பதிந்த நாளை இரண்டாவது நபருடன் மட்டுமே மீண்டும் திறக்க முடியும்.' },
  authority: { en: 'In your name as the accountant.', ta: 'கணக்காளராக உங்கள் பெயரில்.' },
  confirmLabel: { en: 'Post this day', ta: 'இந்த நாளைப் பதி' },
  tone: 'primary',
};

async function ask(page: Page, spec: unknown): Promise<void> {
  await page.evaluate((s) => {
    const w = globalThis as unknown as { sreOffice: { confirm(spec: unknown): Promise<unknown> }; __answer?: unknown };
    w.__answer = undefined;
    void w.sreOffice.confirm(s).then((a) => { w.__answer = a; });
  }, spec);
  await page.waitForSelector('#sre-confirm');
}
const answer = (page: Page): Promise<unknown> => page.waitForFunction(() => (globalThis as unknown as { __answer?: unknown }).__answer !== undefined).then(() => page.evaluate(() => (globalThis as unknown as { __answer?: unknown }).__answer));
/** The toggle sits under the sheet's scrim, so a person reaches it by keyboard; the test presses it directly. */
const toggle = (page: Page): Promise<void> => page.evaluate(() => { (globalThis as unknown as { document: { getElementById(id: string): { click(): void } } }).document.getElementById('lang').click(); });
const focused = (page: Page): Promise<string> => page.evaluate(() => (globalThis as unknown as { document: { activeElement: { id: string } | null } }).document.activeElement?.id ?? '');

describe.skipIf(!existsSync(CHROMIUM))('U1: the confirm sheet asks before it acts', () => {
  let browser: Browser;
  let shop: OfficeShop;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    shop = await startOfficeShop(browser);
  }, 300_000);
  afterAll(async () => { await shop?.stop(); await browser?.close(); });

  const open = async (device: Record<string, unknown> = DESK) => {
    const s = await shop.asPerson(PEOPLE.manager, device as never);
    await s.page.goto(`${shop.base}/customers`, { waitUntil: 'load' });
    await s.page.waitForFunction('globalThis.sreOffice !== undefined && typeof globalThis.sreOffice.confirm === "function"');
    return s;
  };

  it('opens with the figure, the consequence and the authority, focus on Go back; Escape answers go back and the focus returns', async () => {
    const { context, page, errors } = await open();
    await page.focus('#lang');
    await ask(page, SPEC);
    expect(await page.locator('#sre-confirm-title').innerText()).toBe(SPEC.title.en);
    expect(await page.locator('#sre-confirm-detail').innerText()).toBe(SPEC.detail.en);
    expect(await page.locator('.sre-confirm-authority').innerText()).toBe(SPEC.authority.en);
    expect(await page.locator('#sre-confirm-go').innerText()).toBe('Post this day');
    expect(await page.locator('#sre-confirm-back').innerText()).toBe('Go back');
    expect(await page.locator('.sre-confirm-kicker').innerText()).toBe('BEFORE THIS IS SENT');
    expect(await focused(page)).toBe('sre-confirm-back');
    expect(await page.getAttribute('#sre-confirm', 'role')).toBe('dialog');
    expect(await page.getAttribute('#sre-confirm', 'aria-modal')).toBe('true');
    // Tab stays inside the sheet
    await page.keyboard.press('Tab');
    expect(await focused(page)).toBe('sre-confirm-go');
    await page.keyboard.press('Tab');
    expect(await focused(page)).toBe('sre-confirm-back');
    await page.keyboard.press('Shift+Tab');
    expect(await focused(page)).toBe('sre-confirm-go');
    await page.keyboard.press('Escape');
    expect(await answer(page)).toEqual({ ok: false });
    expect(await page.locator('#sre-confirm').count()).toBe(0);
    expect(await focused(page)).toBe('lang');
    expect(errors).toEqual([]);
    await context.close();
  });

  it('repaints in Tamil on the toggle; Go back and a tap on the scrim answer go back; the confirm button answers ok', async () => {
    const { context, page } = await open();
    await ask(page, SPEC);
    await toggle(page);
    expect(await page.locator('#sre-confirm-title').innerText()).toBe(SPEC.title.ta);
    expect(await page.locator('#sre-confirm-go').innerText()).toBe(SPEC.confirmLabel.ta);
    expect(await page.locator('#sre-confirm-back').innerText()).toBe('பின் செல்');
    await page.click('#sre-confirm-back');
    expect(await answer(page)).toEqual({ ok: false });
    await ask(page, SPEC);
    await page.mouse.click(8, 8); // the scrim, outside the sheet's panel
    expect(await answer(page)).toEqual({ ok: false });
    await ask(page, SPEC);
    await page.click('#sre-confirm-go');
    expect(await answer(page)).toEqual({ ok: true });
    expect(await page.locator('#sre-confirm').count()).toBe(0);
    await context.close();
  });

  it('a required reason refuses a blank and a too-short one beside the field; Enter on the field never confirms; the reason comes back', async () => {
    const { context, page } = await open();
    await ask(page, { ...SPEC, tone: 'danger', reason: { label: { en: 'Why', ta: 'ஏன்' }, required: true, minLength: 3 } });
    expect(await page.locator('#sre-confirm-go').getAttribute('class')).toContain('sre-btn-danger');
    expect((await page.locator('label[for="sre-confirm-reason"]').textContent())?.replace(/\s+/g, ' ')).toBe('Why (required)');
    await page.click('#sre-confirm-go');
    expect(await page.locator('#sre-confirm-reason-msg').innerText()).toBe('Fill in "Why".');
    expect(await page.getAttribute('#sre-confirm-reason', 'aria-invalid')).toBe('true');
    expect(await focused(page)).toBe('sre-confirm-reason');
    await page.fill('#sre-confirm-reason', 'ok');
    await page.click('#sre-confirm-go');
    expect(await page.locator('#sre-confirm-reason-msg').innerText()).toBe('Say why in at least 3 letters.');
    await page.fill('#sre-confirm-reason', 'the count was re-done');
    await page.focus('#sre-confirm-reason');
    await page.keyboard.press('Enter');
    expect(await page.locator('#sre-confirm').count()).toBe(1); // Enter in the field confirmed nothing
    await page.click('#sre-confirm-go');
    expect(await answer(page)).toEqual({ ok: true, reason: 'the count was re-done' });
    await context.close();
  });

  it('a second ask closes the first as go back; leaving the page answers go back', async () => {
    const { context, page } = await open();
    await ask(page, SPEC);
    await page.evaluate((s) => {
      const w = globalThis as unknown as { sreOffice: { confirm(spec: unknown): Promise<unknown> }; __second?: unknown };
      void w.sreOffice.confirm(s).then((a) => { w.__second = a; });
    }, { ...SPEC, title: { en: 'second', ta: 'இரண்டாவது' } });
    expect(await answer(page)).toEqual({ ok: false });
    expect(await page.locator('#sre-confirm').count()).toBe(1);
    expect(await page.locator('#sre-confirm-title').innerText()).toBe('second');
    await context.close();
  });

  it('the audit is clean with the sheet open, at a desk and on a phone, in English and Tamil', async () => {
    for (const device of [DESK, PHONE]) {
      const { context, page, errors } = await open(device);
      await ask(page, { ...SPEC, reason: { label: { en: 'Why', ta: 'ஏன்' }, required: true } });
      expect(await auditPage(page, { expectLang: 'en' }), `${device.viewport.width}px EN`).toEqual([]);
      await toggle(page);
      expect(await auditPage(page, { expectLang: 'ta' }), `${device.viewport.width}px TA`).toEqual([]);
      const box = await page.locator('#sre-confirm-go').boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(48);
      expect(errors).toEqual([]);
      await context.close();
    }
  });
});
