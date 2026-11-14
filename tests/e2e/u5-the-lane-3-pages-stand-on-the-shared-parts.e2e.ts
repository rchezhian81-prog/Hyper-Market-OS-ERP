import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startOfficeShop, PEOPLE, type OfficeShop } from './lib/office-shop';
import { ERP_NAVIGATION } from '../../apps/web-erp/src/navigation';

/**
 * **U5 · G17 · G13 · G16 (UI/UX gap audit, 1 Nov 2026 · P-07 · NFR-13): every lane-3 office page (finance, owner, CRM) stands on
 * the chrome's shared parts.**
 *
 * The audit found that none of the office pages used the shared parts beyond W1's five touches: lists were plain tables the
 * chrome only classed, record states were ⚠/✓ characters or page-own pills, fields had no visible label, and four pages
 * scrolled sideways on a phone. Group C put the parts in the chrome (U5); this test opens every lane-3 page on the REAL
 * store computer fed by the REAL head office, as the role that opens it, at a desk and on a 360px phone, and holds four
 * rules a reader can see:
 *   1. every `<table>` on the page is the chrome's register (`.sre-datatable`) — no raw table a page drew itself;
 *   2. no page-own state mark — a `.pill` / `.tag` / `.badge` / `.status` element, or a ⚠ ✓ ✗ ✕ character in a text leaf
 *      outside the chrome's chip (`.sre-chip`): a record's state is the one chip, word + icon;
 *   3. every visible input, select and textarea has a visible label (a `<label for>`, a wrapping label, an `aria-label`,
 *      or the chrome's field/date/pick row);
 *   4. at 360px nothing scrolls sideways (the document is no wider than the phone).
 * The findings per page are written to the scratchpad for the builder; the assertion is zero on every page.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DESK = { viewport: { width: 1280, height: 900 } };
const PHONE = { viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const REPORT = process.env['U5_REPORT_DIR'];

const A = PEOPLE.accountant, M = PEOPLE.manager, O = PEOPLE.owner;
/** The lane-3 pages (the audit's lane table); Bill findings was rebuilt by its own group and has its own test. */
export const LANE_3: readonly { id: string; who: string }[] = [
  { id: 'finance', who: A }, { id: 'day-book', who: A }, { id: 'finance-close', who: A }, { id: 'reconciliation', who: A },
  { id: 'tally-files', who: A }, { id: 'promotion-funding', who: A }, { id: 'concessions', who: A }, { id: 'gst-reconciliation', who: M },
  { id: 'gst-returns', who: A }, { id: 'itc-review', who: A }, { id: 'cash-office', who: M }, { id: 'day-reopen', who: A },
  { id: 'basket-affinity', who: A }, { id: 'branch-compare', who: M }, { id: 'company-report', who: A }, { id: 'morning-brief', who: M },
  { id: 'owner-alerts', who: M }, { id: 'reporting', who: A }, { id: 'waste-analytics', who: M }, { id: 'b2b', who: A },
  { id: 'campaigns', who: M }, { id: 'customers', who: M }, { id: 'loyalty-desk', who: M }, { id: 'online-store', who: O },
  { id: 'quotations', who: M }, { id: 'return-governance', who: A }, { id: 'service', who: M }, { id: 'service-desk', who: M },
  { id: 'stored-value', who: A },
];

export interface Finding { readonly rule: 'raw-table' | 'own-state-mark' | 'empty-as-text' | 'unlabelled-field' | 'sideways'; readonly where: string; readonly text?: string }

/** The four rules, read from the rendered page outside the chrome. */
export async function partsFindings(page: Page, width: number): Promise<Finding[]> {
  return page.evaluate((viewport) => {
    interface El { tagName: string; id: string; className: string; classList: { length: number; [i: number]: string; contains(c: string): boolean }; parentElement: El | null; closest(sel: string): El | null; matches(sel: string): boolean; getBoundingClientRect(): { width: number; height: number }; querySelectorAll(sel: string): ArrayLike<El>; querySelector(sel: string): El | null; textContent: string | null; getAttribute(n: string): string | null; hasAttribute(n: string): boolean; hidden: boolean }
    interface TextNode { textContent: string | null; parentElement: El | null }
    interface Doc { body: El; documentElement: { scrollWidth: number }; createTreeWalker(root: El, what: number): { nextNode(): TextNode | null }; querySelectorAll(sel: string): ArrayLike<El>; querySelector(sel: string): El | null; getElementById(id: string): El | null }
    const g = globalThis as unknown as { document: Doc; getComputedStyle(el: El): { display: string; visibility: string } };
    const d = g.document;
    const out: { rule: 'raw-table' | 'own-state-mark' | 'empty-as-text' | 'unlabelled-field' | 'sideways'; where: string; text?: string }[] = [];
    const CHROME = 'nav#sre-menu, #sre-page > header, .sre-strip, .sre-sheet, .sre-badge, .sre-pager, [data-sre-chrome], .sre-confirm, .sre-pick, #sre-menu-sheet, .sre-picker, .sre-datatable';
    const inChrome = (el: El): boolean => el.closest(CHROME) !== null;
    const visible = (el: El): boolean => { const r = el.getBoundingClientRect(); const cs = g.getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && (r.width > 0 || r.height > 0); };
    const path = (el: El): string => { const parts: string[] = []; let e: El | null = el; let n = 0; while (e && n < 4 && e.tagName.toLowerCase() !== 'body') { parts.unshift(e.tagName.toLowerCase() + (e.id ? `#${e.id}` : '') + (e.classList.length ? `.${e.classList[0]}` : '')); e = e.parentElement; n += 1; } return parts.join(' > '); };
    const main = d.querySelector('main') ?? d.body;
    // 1. raw tables — shown or not (a hidden one shows the moment head office answers); the shared chart's own
    //    accessible table (`.sre-chart-table`, design system §4 charts) is a shared part, not a page's table
    for (const t of Array.from(main.querySelectorAll('table'))) {
      if (t.closest('.sre-datatable') === null && !t.classList.contains('sre-chart-table')) out.push({ rule: 'raw-table', where: path(t) });
    }
    // 2. page-own state marks: a pill / tag / badge / tone class, an inline "status" word, a ⚠ ✓ ✗ — ○ ● glyph as a mark
    const GLYPH = /^[⚠✓✗✕✔✘○●▲■◆►—–-]\s*/;
    for (const el of Array.from(main.querySelectorAll('[class]'))) {
      if (!visible(el) || inChrome(el) || el.closest('.sre-chip') !== null) continue;
      const classes = Array.from({ length: el.classList.length }, (_, i) => el.classList[i]!);
      const tag = el.tagName.toLowerCase();
      const inline = ['span', 'b', 'strong', 'em', 'i', 'small', 'li', 'td'].includes(tag);
      // a tone class on a block (a row's stripe) is a mark of its own only when the row carries no chip for its state
      // (an outcome line — `.result` / `.said` / `.answer-line`, the design system's "toast / error banner" — is not a record's state)
      const toneClass = classes.some((c) => /^tone-[a-z]+$/.test(c)) && !classes.some((c) => /^(result|said|answer-line)$/.test(c)) && (inline || el.querySelector('.sre-chip') === null);
      if (classes.some((c) => /^(pill|tag|badge|lifecycle)$/.test(c)) || toneClass || (inline && classes.some((c) => /^(status|state)$/.test(c)))) out.push({ rule: 'own-state-mark', where: path(el), text: (el.textContent ?? '').trim().slice(0, 40) });
    }
    const walker = d.createTreeWalker(main, 4);
    let node: TextNode | null;
    while ((node = walker.nextNode())) {
      const text = (node.textContent ?? '').trim();
      const parent = node.parentElement;
      if (!parent || text === '' || !visible(parent) || inChrome(parent)) continue;
      if (/[⚠✓✗✕✔✘]/.test(text) && parent.closest('.sre-chip, .sre-icon, svg') === null) out.push({ rule: 'own-state-mark', where: path(parent), text: text.slice(0, 40) });
    }
    // 2b. an empty / not-read / refused view said as a plain line, not the shared state part
    for (const el of Array.from(main.querySelectorAll('p, div, li'))) {
      if (!visible(el) || inChrome(el) || el.closest('.sre-state') !== null || el.querySelector('.sre-state') !== null) continue;
      // U7: main's W5 shared section scripts now draw their empty / refused / reading views as the state part too — held to the rule.
      const classes = Array.from({ length: el.classList.length }, (_, i) => el.classList[i]!);
      if (!classes.some((c) => /^(status|state|result|said|empty|lead)$/.test(c))) continue;
      const own = (el.textContent ?? '').replace(/\s+/g, ' ').trim().replace(GLYPH, '');
      if (/^(No |None |Nothing |Not (read|known|compared|yet|shown)|Head office (cannot|could not|has not)|Reading|Loading)/.test(own) || /^(எதுவும்|இல்லை|எந்த|இன்னும்|தலைமை அலுவலகத்தை)/.test(own)) out.push({ rule: 'empty-as-text', where: path(el), text: own.slice(0, 50) });
    }
    // 3. unlabelled fields
    for (const f of Array.from(main.querySelectorAll('input, select, textarea'))) {
      const type = (f.getAttribute('type') ?? 'text').toLowerCase();
      if (['hidden', 'submit', 'button', 'checkbox', 'radio'].includes(type) || !visible(f) || inChrome(f)) continue;
      const id = f.id;
      const labelled = (id !== '' && Array.from(d.querySelectorAll(`label[for="${id}"]`)).some((l) => visible(l) && (l.textContent ?? '').trim() !== ''))
        || (f.closest('label') !== null && ((f.closest('label')!.textContent ?? '').trim() !== ''))
        || ((f.getAttribute('aria-label') ?? '').trim() !== '')
        || (f.getAttribute('aria-labelledby') !== null && Array.from((f.getAttribute('aria-labelledby') ?? '').split(/\s+/)).some((lid) => { const l = d.getElementById(lid); return l !== null && (l.textContent ?? '').trim() !== ''; }))
        || f.closest('.sre-field, .sre-date, .sre-pick-row') !== null;
      if (!labelled) out.push({ rule: 'unlabelled-field', where: path(f), text: f.getAttribute('placeholder') ?? '' });
    }
    // 4. sideways scroll
    if (d.documentElement.scrollWidth > viewport + 1) out.push({ rule: 'sideways', where: 'document', text: `${d.documentElement.scrollWidth}px wide in ${viewport}` });
    return out;
  }, width);
}

describe.skipIf(!existsSync(CHROMIUM))('U5: the lane-3 pages stand on the shared parts', () => {
  let browser: Browser;
  let shop: OfficeShop;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    shop = await startOfficeShop(browser);
  }, 300_000);
  afterAll(async () => { await shop?.stop(); await browser?.close(); });

  const sweep = async (device: typeof DESK | typeof PHONE, label: string): Promise<void> => {
    const found: Record<string, Finding[]> = {};
    for (const p of LANE_3) {
      const item = ERP_NAVIGATION.find((i) => i.id === p.id);
      expect(item, `${p.id} is a menu item`).toBeDefined();
      const s = await shop.asPerson(p.who, device);
      await s.page.goto(`${shop.base}${item!.path}`, { waitUntil: 'load' });
      await s.page.waitForFunction('globalThis.sreChrome !== undefined');
      await s.page.waitForLoadState('networkidle').catch(() => {});
      await s.page.waitForTimeout(500);
      const findings = await partsFindings(s.page, device.viewport.width);
      const unique = [...new Map(findings.map((f) => [`${f.rule}|${f.where}|${f.text ?? ''}`, f])).values()];
      if (unique.length > 0) found[p.id] = unique;
      await s.context.close();
    }
    if (REPORT) { mkdirSync(REPORT, { recursive: true }); writeFileSync(`${REPORT}/lane-3-${label}.json`, JSON.stringify(found, null, 2)); }
    const summary = Object.entries(found).map(([id, f]) => `${id}: ${f.length} — ${f.slice(0, 5).map((x) => `${x.rule} @ ${x.where}${x.text ? ` "${x.text}"` : ''}`).join('; ')}`).join('\n');
    expect(Object.keys(found), `pages off the shared parts (${label}):\n${summary}`).toEqual([]);
  };

  it('at a desk: every list is the register, every state a chip, every field labelled', async () => { await sweep(DESK, 'desk'); }, 600_000);
  it('on a 360px phone: the same, and nothing scrolls sideways', async () => { await sweep(PHONE, 'phone'); }, 600_000);
});
