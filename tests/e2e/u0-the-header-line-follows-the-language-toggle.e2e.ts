import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startOfficeShop, PEOPLE, type OfficeShop } from './lib/office-shop';
import { ERP_NAVIGATION } from '../../apps/web-erp/src/navigation';

/**
 * **U0 · G1 (UI/UX gap audit, 1 Nov 2026 · design system §1 rule 6 · NFR-08): the header line follows the language toggle.**
 *
 * Thirty-five office pages kept their English heading after the Tamil toggle: each page repaints its own `#title` from its
 * dictionary, but the header line (`h1.who`) was a text node nobody repainted. The chrome now repaints it ONCE for every
 * page, from the menu's own name for that screen in the reader's language — the same words the rail shows — and only when
 * the heading IS the menu's name (a page with its own heading, such as Today's store workspace line, keeps it).
 *
 * On the REAL store computer fed by the REAL head office (office-shop), as the roles that open each page.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DESK = { viewport: { width: 1280, height: 860 } };
const PAGES: { id: string; who: string }[] = [
  { id: 'cash-office', who: PEOPLE.manager },
  { id: 'day-book', who: PEOPLE.accountant },
  { id: 'ess', who: PEOPLE.cashier },
  { id: 'checklist', who: PEOPLE.manager },
  { id: 'approval-requests', who: PEOPLE.cashier },
  { id: 'rostering', who: PEOPLE.manager },
];

describe.skipIf(!existsSync(CHROMIUM))('U0: the header line follows the language toggle', () => {
  let browser: Browser;
  let shop: OfficeShop;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    shop = await startOfficeShop(browser);
  }, 300_000);
  afterAll(async () => { await shop?.stop(); await browser?.close(); });

  const heading = (page: import('playwright-core').Page): Promise<string> =>
    page.$eval('header h1.who', (h1) => [...h1.childNodes].filter((n) => !(n instanceof (globalThis as unknown as { HTMLElement: new () => unknown }).HTMLElement && (n as unknown as { id: string }).id === 'whoami')).map((n) => n.textContent ?? '').join('').replace(/\s+/g, ' ').trim());

  it('six pages of the old template: the heading is the menu\'s name in English, then in Tamil after the toggle, then English again', async () => {
    for (const p of PAGES) {
      const item = ERP_NAVIGATION.find((i) => i.id === p.id)!;
      const s = await shop.asPerson(p.who, DESK);
      await s.page.goto(`${shop.base}${item.path}`, { waitUntil: 'load' });
      await s.page.waitForFunction('globalThis.sreChrome !== undefined');
      expect(await heading(s.page), `${p.id} in English`).toBe(item.label);
      await s.page.click('#lang');
      await s.page.waitForTimeout(300);
      expect(await s.page.getAttribute('html', 'lang'), p.id).toBe('ta');
      expect(await heading(s.page), `${p.id} after the toggle`).toBe(item.labelTa);
      await s.page.click('#lang');
      await s.page.waitForTimeout(300);
      expect(await heading(s.page), `${p.id} back in English`).toBe(item.label);
      expect(s.errors, p.id).toEqual([]);
      await s.context.close();
    }
  }, 120_000);

  it('a page with its own heading keeps it: Today\'s store workspace line is not the menu\'s word', async () => {
    const s = await shop.asPerson(PEOPLE.manager, DESK);
    await s.page.goto(`${shop.base}/manager/`, { waitUntil: 'load' });
    await s.page.waitForFunction('globalThis.sreChrome !== undefined');
    const before = await heading(s.page);
    expect(before).not.toBe('Today');
    await s.page.click('#lang');
    await s.page.waitForTimeout(300);
    const after = await heading(s.page);
    expect(after).not.toBe('இன்று');
    expect(after === before || /[஀-௿]/.test(after), 'the page translates its own heading, or keeps it').toBe(true);
    await s.context.close();
  });
});
