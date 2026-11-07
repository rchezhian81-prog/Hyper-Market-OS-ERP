import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { auditPage, type A11yFinding } from './lib/a11y-audit';
import { startOfficeShop, PEOPLE, type OfficeShop } from './lib/office-shop';

/**
 * **Round U0 of the UI/UX gap audit (1 Nov 2026) — the six office pages the audit found unreadable, untappable or wider
 * than a phone, on the REAL store computer fed by the REAL head office (design system §1 rules 7 and 8, §3.2 · NFR-07).**
 *
 *   • Floor indents and Production: the stock-moving buttons ("Save the indent on this device", "Record the run", "Save the
 *     weights") were dark ink on the dark green button, 1.73:1 — now white on it, at a desk, on a phone and in Tamil;
 *   • Store setup: 26 switches were 26×26px (the bar is 44) and the page was 396px wide on a 360px phone; the prefix form's
 *     three inputs had no visible label;
 *   • Customers, the Offer tab of Products and prices, and the Warehouse supervisor page scrolled sideways on a phone
 *     (485 / 412 / 431px in 360); Warehouse's action buttons wore the information-blue tone instead of the one accent.
 *
 * Each page is opened as the role the audit opened it as and put through the product's own audit (contrast, targets, names,
 * labels, one heading, page language, no sideways scroll). Zero findings everywhere. Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DESK = { viewport: { width: 1280, height: 860 } };
const PHONE = { viewport: { width: 360, height: 640 }, hasTouch: true, isMobile: true };

const PAGES: { readonly id: string; readonly path: string; readonly who: string; readonly ready?: string }[] = [
  { id: 'indents', path: '/indents', who: PEOPLE.cashier },
  { id: 'production', path: '/production/', who: PEOPLE.manager },
  { id: 'store-setup', path: '/setup', who: PEOPLE.owner },
  { id: 'customers', path: '/customers', who: PEOPLE.manager },
  { id: 'offer', path: '/catalogue/?tab=promo', who: PEOPLE.manager },
  { id: 'warehouse-supervisor', path: '/warehouse-supervisor/', who: PEOPLE.manager },
];

/** The elements that reach past the viewport, so a sideways-scroll finding names its cause. */
const widest = (page: Page): Promise<string[]> => page.evaluate(`(() => {
  const w = document.documentElement.clientWidth;
  return Array.from(document.querySelectorAll('body *'))
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.right > w + 1 && r.width > 0)
    .filter(({ el }) => !Array.from(el.children).some((c) => c.getBoundingClientRect().right > w + 1))
    .slice(0, 8)
    .map(({ el, r }) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '') + ' right=' + Math.round(r.right));
})()`) as Promise<string[]>;

const said = (findings: A11yFinding[]): string => findings.map((f) => `${f.rule} ${f.selector}: ${f.detail}`).join('\n');

describe.skipIf(!existsSync(CHROMIUM))('U0: the office pages the audit flagged read clearly and fit a phone', () => {
  let browser: Browser;
  let shop: OfficeShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    shop = await startOfficeShop(browser);
  }, 300_000);
  afterAll(async () => { await shop?.stop(); await browser?.close(); });

  const open = async (who: string, path: string, device: Record<string, unknown>) => {
    const s = await shop.asPerson(who, device as never);
    await s.page.goto(`${shop.base}${path}`, { waitUntil: 'load' });
    await s.page.waitForFunction('globalThis.sreChrome !== undefined');
    await s.page.waitForLoadState('networkidle').catch(() => {});
    await s.page.waitForTimeout(400);
    return s;
  };

  for (const p of PAGES) {
    it(`${p.id}: clean at a desk in English and Tamil, and on a phone`, async () => {
      const desk = await open(p.who, p.path, DESK);
      try {
        const en = await auditPage(desk.page, { expectLang: 'en' });
        expect(en, `${p.id} desk EN\n${said(en)}`).toEqual([]);
        await desk.page.click('#lang');
        await desk.page.waitForTimeout(300);
        const ta = await auditPage(desk.page, { expectLang: 'ta' });
        expect(ta, `${p.id} desk TA\n${said(ta)}`).toEqual([]);
        expect(desk.errors).toEqual([]);
      } finally { await desk.context.close(); }

      const phone = await open(p.who, p.path, PHONE);
      try {
        const ph = await auditPage(phone.page, { expectLang: 'en' });
        const wide = ph.some((f) => f.rule === '1.4.10') ? await widest(phone.page) : [];
        expect(ph, `${p.id} phone\n${said(ph)}\nreaching past the viewport: ${wide.join(' | ')}`).toEqual([]);
        expect(phone.errors).toEqual([]);
      } finally { await phone.context.close(); }
    }, 120_000);
  }

  it('Store setup: every switch is a 44px target and the prefix form names its three fields', async () => {
    const s = await open(PEOPLE.owner, '/setup', DESK);
    try {
      const boxes = await s.page.$$eval('input.toggle', (els) => els.map((e) => { const r = (e as unknown as { getBoundingClientRect(): { width: number; height: number } }).getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
      expect(boxes.length).toBeGreaterThan(0);
      for (const [w, h] of boxes) { expect(w).toBeGreaterThanOrEqual(44); expect(h).toBeGreaterThanOrEqual(44); }
      for (const id of ['pn-store', 'pn-till', 'pn-prefix']) {
        const label = await s.page.$(`label[for="${id}"]`);
        expect(label, `a visible label for #${id}`).not.toBeNull();
        expect((await label!.innerText()).trim()).not.toBe('');
      }
    } finally { await s.context.close(); }
  }, 60_000);

  it('Warehouse: no action button wears the information tone; the one primary (Propose transfer) wears the accent, the other is secondary (U1 · G3)', async () => {
    const s = await open(PEOPLE.manager, '/warehouse-supervisor/', DESK);
    try {
      const styles = await s.page.$$eval('.card button.do', (els) => els.map((e) => ({ id: (e as unknown as { id: string }).id, bg: (globalThis as unknown as { getComputedStyle(e: unknown): { backgroundColor: string } }).getComputedStyle(e).backgroundColor })));
      const accent = await s.page.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`) as string;
      const info = await s.page.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--info').trim()`) as string;
      const toRgb = (hex: string): string => { const h = hex.replace('#', ''); return `rgb(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)})`; };
      expect(styles.length).toBeGreaterThan(0);
      for (const { bg } of styles) expect(bg).not.toBe(toRgb(info));
      expect(styles.find((x) => x.id === 't-do')?.bg, 'Propose transfer is the one primary').toBe(toRgb(accent));
      expect(styles.filter((x) => x.bg === toRgb(accent)), 'one primary at a time').toHaveLength(1);
    } finally { await s.context.close(); }
  }, 60_000);
});
