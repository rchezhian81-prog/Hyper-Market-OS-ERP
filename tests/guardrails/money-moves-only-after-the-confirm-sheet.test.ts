import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * **OB-694 (2 Nov 2026 · UI/UX gap audit G4 · design system §1.3 · §27.1): on the finance and customer pages, money moves
 * only after the shared confirm sheet; the page's one primary action is marked; no page paints every button in the accent.**
 *
 * The rendered proof (the sheet's figure, Go back sends nothing, Confirm sends once) is in
 * tests/e2e/u1-money-moves-only-after-the-sheet.e2e.ts for the actions the office harness can reach. This file holds every
 * action on these pages to the rule statically, so a hurried edit cannot put the write back in front of the sheet:
 *   • each money, stock or privilege write is preceded, in its own handler, by the sheet (`office()).confirm(`, `confirmed(` or
 *     `confirmSheet(`);
 *   • the sheet's words exist in English and Tamil, as pairs with the same keys;
 *   • the page's HTML carries `.sre-btn-primary` (one marked primary) and no page-own `button { background: var(--accent)`;
 *   • no page asks through a browser dialog.
 */

const WEB = 'apps/web-erp/web';
const read = (f: string): string => readFileSync(`${WEB}/${f}`, 'utf8');
const code = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

/** page script → [the handler's opening line, the write it must not reach without the sheet] */
const ACTIONS: Record<string, [string, string][]> = {
  'day-book.js': [["el('post').addEventListener('click'", 'session.post(']],
  'finance-close.js': [["$('post-adjustment').addEventListener", 'session.postStockAdjustment('], ["$('close-month').addEventListener", 'month.closeWithApproval('], ["$('reopen').addEventListener", 'month.reopenWithApproval('], ["$('run-depreciation').addEventListener", 'session.runDepreciation(']],
  'promotion-funding.js': [["$('c-record').addEventListener", 'session.receipt(']],
  'cash-office.js': [["el('sign').addEventListener('click'", 'session.signOff(']],
  'campaigns.js': [['async function send()', 'session.send(']],
  'online-store.js': [["el('publish-store').addEventListener", "post('/v1/online-store/publish'"]],
  'order-refunds.js': [['async function issue()', 'session.issue(']],
  'service.js': [['async function putThrough()', 'session.refund(']],
  'b2b.js': [["inv.addEventListener('click'", 'session.invoice('], ["dc.addEventListener('click'", 'session.challan('], ["go.addEventListener('click', async () => { if (!(await confirmed('convert'", 'session.convertWithApproval(']],
};
const PAGES = ['day-book', 'finance-close', 'promotion-funding', 'cash-office', 'campaigns', 'online-store', 'order-refunds', 'service', 'b2b'];

describe('money moves only after the confirm sheet (OB-694)', () => {
  it('every money, stock or privilege write on these pages sits behind the sheet in its own handler', () => {
    const wrong: string[] = [];
    for (const [file, actions] of Object.entries(ACTIONS)) {
      const src = code(read(file));
      for (const [handler, write] of actions) {
        const at = src.indexOf(handler);
        if (at < 0) { wrong.push(`${file}: handler "${handler}" not found`); continue; }
        const body = src.slice(at, src.indexOf(write, at) + write.length);
        if (!body.includes(write)) { wrong.push(`${file}: "${write}" not found after "${handler}"`); continue; }
        if (!/office\(\)\)\.confirm\(|await confirmed\(|await confirmSheet\(/.test(body)) wrong.push(`${file}: "${write}" runs before the sheet`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('the sheet\'s words are pairs: every English key has its Tamil twin on every page (day book keeps its words in its session)', () => {
    for (const file of PAGES.filter((p) => p !== 'day-book')) {
      const src = read(`${file}.js`);
      const start = src.search(/const CONFIRM(_WORDS)? = \{/);
      const block = src.slice(start);
      const en = block.slice(block.indexOf('en: {'), block.indexOf('ta: {'));
      const ta = block.slice(block.indexOf('ta: {'), block.indexOf('\n};'));
      const keys = (s: string): string[] => [...s.matchAll(/\b([A-Za-z]+): '/g)].map((m) => m[1]!).filter((k) => k !== 'en' && k !== 'ta');
      expect(keys(en).length, `${file}: confirm words`).toBeGreaterThan(0);
      for (const k of keys(en)) expect(ta, `${file}: Tamil for ${k}`).toMatch(new RegExp(`\\b${k}: '`));
      expect(ta, `${file}: Tamil script`).toMatch(/[஀-௿]/);
    }
    const session = readFileSync('apps/web-erp/src/day-book-session.ts', 'utf8');
    for (const k of ['confirmTitle', 'confirmTitleNoFigure', 'confirmDetail', 'confirmAuthority', 'confirmLabel']) expect(session.match(new RegExp(`\\b${k}: '`, 'g'))?.length, `day book ${k} en+ta`).toBe(2);
  });

  it('each page marks its primary action with the shared class and paints no button of its own in the accent', () => {
    for (const file of PAGES) {
      const html = read(`${file}.html`);
      expect(html, `${file}: a marked primary`).toContain('sre-btn-primary');
      expect(html, `${file}: a page-own accent button`).not.toMatch(/\n\s*button(\.act)? \{[^\n]*background:\s*var\(--accent\)/);
      expect(html, `${file}: a page-own amber action`).not.toMatch(/button\.act \{[^\n]*var\(--degraded\)/);
    }
  });

  it('never asks through a browser dialog', () => {
    for (const file of PAGES) {
      const found = [...code(read(`${file}.js`)).matchAll(/(?<![.\w])(?:window\.)?(prompt|confirm|alert)\s*\(/g)].map((m) => m[1]);
      expect(found, file).toEqual([]);
    }
  });

  it('bites: before OB-694 the day book posted on the click alone', () => {
    const before = code(execFileSync('git', ['show', '7fb2406:apps/web-erp/web/day-book.js'], { encoding: 'utf8' }));
    const at = before.indexOf("el('post').addEventListener('click'");
    const body = before.slice(at, before.indexOf('session.post(', at));
    expect(body).not.toMatch(/office\(\)\)\.confirm\(/);
  });
});
