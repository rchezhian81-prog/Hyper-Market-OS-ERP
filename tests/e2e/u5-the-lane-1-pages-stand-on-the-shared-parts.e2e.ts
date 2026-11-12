import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startOfficeShop, PEOPLE, type OfficeShop } from './lib/office-shop';

/**
 * **Round U5 of the UI/UX gap audit (G17 · G13 · G16 · G11): lane 1 of the office — products, pricing, buying, suppliers,
 * receiving — stands on the chrome's shared parts.**
 *
 * The audit (1 Nov 2026) found that no office page used the shared parts beyond W1's five touches: lists were plain
 * tables the chrome only classes (no search, no sort, no paging, sideways scroll on a phone), record states were plain
 * words or ⚠/✓ characters, and fields stood without a visible label. Each lane-1 page is opened on the REAL store
 * computer fed by the REAL head office, as the role the audit opened it as, and read as rendered:
 *   1. every `<table>` is the register part (`sreOffice.table`, inside `.sre-datatable`) — a plain table is a finding;
 *   2. no page-own state pill/tag and no ⚠ ✓ ✗ ✕ character stands in for the tone chip;
 *   3. every visible input, select and textarea has a visible label (a `<label for>`, a wrapping label, or an aria name);
 *   4. on a 360px phone nothing reaches past the viewport.
 * Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DESK = { viewport: { width: 1280, height: 860 } };
const PHONE = { viewport: { width: 360, height: 640 }, hasTouch: true, isMobile: true };

export const LANE_1_PAGES: { readonly id: string; readonly path: string; readonly who: string }[] = [
  { id: 'approval-requests', path: '/approvals', who: PEOPLE.manager },
  { id: 'ai-drafts', path: '/ai-drafts', who: PEOPLE.manager },
  { id: 'operations', path: '/operations', who: PEOPLE.manager },
  { id: 'products', path: '/products', who: PEOPLE.manager },
  { id: 'pricing', path: '/pricing', who: PEOPLE.manager },
  { id: 'promotions', path: '/promotions', who: PEOPLE.manager },
  { id: 'category-policy', path: '/category-policy', who: PEOPLE.manager },
  { id: 'product-publish-review', path: '/product-publish-review', who: PEOPLE.owner },
  { id: 'product-details', path: '/product-details', who: PEOPLE.manager },
  { id: 'product-categories', path: '/product-categories', who: PEOPLE.manager },
  { id: 'product-merges', path: '/product-merges', who: PEOPLE.manager },
  { id: 'tax-rates', path: '/tax-rates', who: PEOPLE.manager },
  { id: 'price-lists', path: '/price-lists', who: PEOPLE.manager },
  { id: 'price-integrity', path: '/price-integrity', who: PEOPLE.manager },
  { id: 'product-content', path: '/product-content', who: PEOPLE.manager },
  { id: 'data-quality', path: '/data-quality', who: PEOPLE.manager },
  { id: 'offer-results', path: '/offer-results', who: PEOPLE.manager },
  { id: 'shelf-tags', path: '/shelf-tags', who: PEOPLE.manager },
  { id: 'buying', path: '/buying/', who: PEOPLE.manager },
  { id: 'requisitions', path: '/requisitions', who: PEOPLE.manager },
  { id: 'supplier-bills', path: '/supplier-bills', who: PEOPLE.accountant },
  { id: 'suppliers', path: '/suppliers', who: PEOPLE.manager },
  { id: 'supplier-scorecard', path: '/supplier-scorecard', who: PEOPLE.manager },
  { id: 'supplier-submissions', path: '/supplier-submissions', who: PEOPLE.manager },
  { id: 'rebates', path: '/rebates', who: PEOPLE.manager },
  { id: 'blanket-orders', path: '/blanket-orders', who: PEOPLE.manager },
  { id: 'goods-receipt', path: '/goods-receipt', who: PEOPLE.manager },
  { id: 'dock-diary', path: '/dock-diary', who: PEOPLE.manager },
];

interface Reading {
  readonly plainTables: string[];
  readonly pills: string[];
  readonly marks: string[];
  readonly unlabelled: string[];
}

/** What the rendered page shows that is not a shared part. */
export const readParts = (page: Page): Promise<Reading> => page.evaluate(`(() => {
  const isShown = (el) => { if (!el) return false; const s = getComputedStyle(el); if (s.display === 'none' || s.visibility === 'hidden') return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '');
  const plainTables = [];
  for (const t of document.querySelectorAll('main table')) {
    if (t.closest('.sre-datatable')) continue;
    if (!isShown(t) && !t.closest('[hidden]') && t.closest('section,div')?.hidden !== true) { /* a hidden tab's table is still the page's: counted */ }
    plainTables.push(name(t) + ' (' + (t.getAttribute('aria-labelledby') || t.getAttribute('aria-label') || '') + ')');
  }
  const pills = [];
  for (const el of document.querySelectorAll('main .pill, main .tag, main .state-pill, main .badge-state')) {
    if (el.closest('.sre-chip')) continue;
    pills.push(name(el) + ': ' + (el.textContent || '').trim().slice(0, 40));
  }
  const marks = [];
  const walker = document.createTreeWalker(document.querySelector('main') || document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const text = (n.nodeValue || '').trim();
    if (text === '') continue;
    const el = n.parentElement;
    if (!el || el.closest('script,style,noscript,template,[aria-hidden="true"]')) continue;
    if (el.closest('.sre-chip, .sre-state, svg')) continue;
    if (/[⚠✓✗✕✔✘]/.test(text)) marks.push(name(el) + ': ' + text.slice(0, 50));
  }
  const unlabelled = [];
  for (const c of document.querySelectorAll('main input, main select, main textarea')) {
    if (c.type === 'hidden' || c.type === 'submit' || c.type === 'button') continue;
    if (!isShown(c)) continue;
    if (c.getAttribute('aria-label') || c.getAttribute('aria-labelledby')) continue;
    if (c.closest('label')) continue;
    if (c.id && document.querySelector('label[for="' + CSS.escape(c.id) + '"]')) {
      const lab = document.querySelector('label[for="' + CSS.escape(c.id) + '"]');
      if (isShown(lab) && (lab.textContent || '').trim() !== '') continue;
    }
    unlabelled.push(name(c));
  }
  return { plainTables, pills, marks, unlabelled };
})()`) as Promise<Reading>;

/** The elements that reach past a 360px viewport, so a sideways-scroll finding names its cause. */
const reachingPast = (page: Page, width: number): Promise<string[]> => page.evaluate(`(() => {
  const out = [];
  const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '');
  if (document.documentElement.scrollWidth <= ${width}) return out;
  for (const el of document.querySelectorAll('main *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0) continue;
    if (r.right > ${width} + 1 && !el.closest('.sre-scroll-x')) out.push(name(el) + ' right=' + Math.round(r.right));
    if (out.length > 12) break;
  }
  return out.length === 0 ? ['document scrollWidth ' + document.documentElement.scrollWidth] : out;
})()`) as Promise<string[]>;

const OUT = '/tmp/claude-0/-home-user-Hyper-Market-OS-ERP/f0035d2b-5c09-50ed-bcac-13d7de201707/scratchpad/u356/p1-sweep';

describe.skipIf(!existsSync(CHROMIUM))('U5 (G17 · G13 · G16 · G11): every lane-1 page stands on the shared parts', () => {
  let browser: Browser;
  let shop: OfficeShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    shop = await startOfficeShop(browser);
    mkdirSync(OUT, { recursive: true });
  }, 300_000);
  afterAll(async () => { await shop?.stop(); await browser?.close(); });

  const settle = async (page: Page): Promise<void> => {
    await page.waitForFunction('globalThis.sreChrome !== undefined');
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(400);
  };

  for (const p of LANE_1_PAGES) {
    it(`${p.id}: lists are the register, states are chips, fields are labelled, and it fits a phone`, async () => {
      const desk = await shop.asPerson(p.who, DESK as never);
      const phone = await shop.asPerson(p.who, PHONE as never);
      try {
        await desk.page.goto(`${shop.base}${p.path}`, { waitUntil: 'load' });
        await settle(desk.page);
        const read = await readParts(desk.page);
        await phone.page.goto(`${shop.base}${p.path}`, { waitUntil: 'load' });
        await settle(phone.page);
        const wide = await reachingPast(phone.page, 360);
        writeFileSync(`${OUT}/${p.id}.json`, JSON.stringify({ ...read, wide }, null, 1));
        expect(read.plainTables, `${p.id}: a plain <table> that is not the register part`).toEqual([]);
        expect([...read.pills, ...read.marks], `${p.id}: a page-own state pill or a ⚠/✓ character instead of the chip`).toEqual([]);
        expect(read.unlabelled, `${p.id}: a field without a visible label`).toEqual([]);
        expect(wide, `${p.id}: reaching past a 360px phone`).toEqual([]);
        expect(desk.errors).toEqual([]);
        expect(phone.errors).toEqual([]);
      } finally { await desk.context.close(); await phone.context.close(); }
    }, 120_000);
  }
});
