import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startOfficeShop, PEOPLE, type OfficeShop } from './lib/office-shop';

/**
 * **Round U5 of the UI/UX gap audit (G17 · G13 · G16 · G9): every lane-2 office page stands on the chrome's shared
 * parts** — inventory, floor, production, waste, orders and operations (29 pages, `docs/audit/ui-ux-gap-audit-2026-11-01/lane-2.md`).
 *
 * On the REAL store computer fed by the REAL head office, each page is opened as the role the audit opened it as, at a
 * desk and on a 360px phone, and the rendered page must hold:
 *   • no raw `<table>` outside the register (`sreOffice.table`, `.sre-datatable`) — a list is the shared register, with
 *     its search, sort words, paging and count;
 *   • no page-own `.pill` / `.tag` state word — a record's state is the one chip (`sreOffice.chip` / `recordChip`);
 *   • no field a person types into without a visible label (a `<label for>`, a wrapping label, or an aria name);
 *   • no state drawn as a bare ⚠ / ✓ / ✕ / ▲ / ▼ character, and no figure drawn as a dash ("—" / "–") where "Not known" is
 *     the honest word (G6 · G13);
 *   • no native browser date box (the shop's dd/mm/yyyy field is the chrome's, G14);
 *   • no sideways scroll on the phone (the page is no wider than the viewport);
 *   • no page error.
 * Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DESK = { viewport: { width: 1280, height: 860 } };
const PHONE = { viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 };

export const LANE_2_PAGES: { readonly id: string; readonly path: string; readonly who: string }[] = [
  { id: 'indents', path: '/indents', who: PEOPLE.cashier },
  { id: 'counts', path: '/counts', who: PEOPLE.manager },
  { id: 'demand-events', path: '/demand-events', who: PEOPLE.manager },
  { id: 'packaging', path: '/packaging', who: PEOPLE.manager },
  { id: 'stock-health', path: '/stock-health', who: PEOPLE.manager },
  { id: 'transfers', path: '/transfers', who: PEOPLE.manager },
  { id: 'warehouse-supervisor', path: '/warehouse-supervisor/', who: PEOPLE.manager },
  { id: 'count-plans', path: '/count-plans', who: PEOPLE.manager },
  { id: 'facilities', path: '/facilities/', who: PEOPLE.manager },
  { id: 'food-safety', path: '/food-safety', who: PEOPLE.manager },
  { id: 'floor-heat-map', path: '/floor-heat-map', who: PEOPLE.manager },
  { id: 'merchandising', path: '/merchandising/', who: PEOPLE.manager },
  { id: 'planogram-compliance', path: '/planogram-compliance', who: PEOPLE.manager },
  { id: 'production', path: '/production/', who: PEOPLE.manager },
  { id: 'expiry', path: '/expiry/', who: PEOPLE.manager },
  { id: 'held-returns', path: '/held-returns', who: PEOPLE.manager },
  { id: 'recall-trace', path: '/recall-trace', who: PEOPLE.manager },
  { id: 'scrap', path: '/scrap', who: PEOPLE.accountant },
  { id: 'unsellable', path: '/unsellable', who: PEOPLE.manager },
  { id: 'waste', path: '/waste', who: PEOPLE.manager },
  { id: 'write-off-capture', path: '/write-off-capture', who: PEOPLE.manager },
  { id: 'dispatch', path: '/dispatch', who: PEOPLE.manager },
  { id: 'order-refunds', path: '/order-refunds', who: PEOPLE.manager },
  { id: 'substitution-exceptions', path: '/substitution-exceptions', who: PEOPLE.manager },
  { id: 'epr', path: '/epr', who: PEOPLE.manager },
  { id: 'gates', path: '/gates', who: PEOPLE.manager },
  { id: 'loss-prevention', path: '/loss-prevention', who: PEOPLE.accountant },
  { id: 'related-parties', path: '/related-parties', who: PEOPLE.accountant },
  { id: 'risk-acceptance', path: '/risk-acceptance', who: PEOPLE.manager },
];

interface Reading {
  readonly rawTables: string[];
  readonly pills: string[];
  readonly unlabelled: string[];
  readonly marks: string[];
  readonly dashes: string[];
  readonly nativeDates: string[];
  readonly scrollWidth: number;
  readonly clientWidth: number;
}

/** What the rendered page holds, read in the browser: raw tables, page-own state pills, unlabelled fields, its width. */
export const readParts = (page: Page): Promise<Reading> => page.evaluate(`(() => {
  const shown = (el) => { const s = getComputedStyle(el); if (s.display === 'none' || s.visibility === 'hidden') return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const where = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '');
  const rawTables = [...document.querySelectorAll('table')].filter((t) => !t.closest('.sre-datatable') && !t.closest('#sre-drawer')).map(where);
  const pills = [...document.querySelectorAll('.pill, .tag, [class*="pill-"], [class*="status-"]')].filter((el) => shown(el) && !el.closest('.sre-chip') && !el.classList.contains('sre-chip') && !el.closest('.sre-chrome, header.sre-header, nav')).map((el) => where(el) + ': ' + (el.textContent || '').trim().slice(0, 40));
  const fields = [...document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea')].filter(shown);
  const labelled = (el) => {
    if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return true;
    if (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')) return true;
    const wrap = el.closest('label');
    return !!(wrap && (wrap.textContent || '').trim() !== '');
  };
  const unlabelled = fields.filter((el) => !labelled(el)).map(where);
  const texts = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const text = (n.nodeValue || '').replace(/\\s+/g, ' ').trim();
    const el = n.parentElement;
    if (text === '' || !el || el.closest('script,style,noscript,template,[aria-hidden="true"],[hidden],.sre-chrome,header.sre-header') || !shown(el)) continue;
    texts.push({ el, text });
  }
  const marks = texts.filter((x) => /^[⚠✓✔✕✗▲▼●○]/.test(x.text) || /\\s[⚠✓✔✕✗▲▼]\\s/.test(x.text)).map((x) => where(x.el) + ': ' + x.text.slice(0, 40));
  const dashes = texts.filter((x) => /^[—–-]$/.test(x.text)).map((x) => where(x.el));
  const nativeDates = [...document.querySelectorAll('input[type="date"]')].filter(shown).map(where);
  return { rawTables, pills, unlabelled, marks, dashes, nativeDates, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth };
})()`) as Promise<Reading>;

describe.skipIf(!existsSync(CHROMIUM))('U5: the lane-2 office pages stand on the shared parts', () => {
  let browser: Browser;
  let shop: OfficeShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    shop = await startOfficeShop(browser);
  }, 300_000);
  afterAll(async () => { await shop?.stop(); await browser?.close(); });

  const open = async (who: string, path: string, device: object) => {
    const s = await shop.asPerson(who, device as never);
    await s.page.goto(`${shop.base}${path}`, { waitUntil: 'load' });
    await s.page.waitForFunction('globalThis.sreChrome !== undefined');
    await s.page.waitForLoadState('networkidle').catch(() => {});
    await s.page.waitForTimeout(400);
    return s;
  };

  for (const p of LANE_2_PAGES) {
    it(`${p.id}: registers, chips and labelled fields at a desk; no sideways scroll on a phone`, async () => {
      const desk = await open(p.who, p.path, DESK);
      try {
        const r = await readParts(desk.page);
        expect(r.rawTables, `${p.id}: a raw table outside the register`).toEqual([]);
        expect(r.pills, `${p.id}: a page-own state pill or tag`).toEqual([]);
        expect(r.unlabelled, `${p.id}: a field without a visible label`).toEqual([]);
        expect(r.marks, `${p.id}: a state drawn as a bare character`).toEqual([]);
        expect(r.dashes, `${p.id}: a dash where "Not known" is the word`).toEqual([]);
        expect(r.nativeDates, `${p.id}: a native browser date box`).toEqual([]);
        expect(desk.errors).toEqual([]);
      } finally { await desk.context.close(); }
      const phone = await open(p.who, p.path, PHONE);
      try {
        const r = await readParts(phone.page);
        expect(r.scrollWidth, `${p.id}: the phone page is wider than its screen (${r.scrollWidth} > ${r.clientWidth})`).toBeLessThanOrEqual(r.clientWidth);
        expect(phone.errors).toEqual([]);
      } finally { await phone.context.close(); }
    }, 120_000);
  }
});
