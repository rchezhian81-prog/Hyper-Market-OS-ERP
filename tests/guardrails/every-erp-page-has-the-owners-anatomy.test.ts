import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';

/**
 * **UX-1c (OB-13 · OB-14 "the look first"): every back-office page has the owner's page anatomy — a head with the
 * module above the title and the purpose line under it, the subpages as tiles, every table a register, the sheet as
 * a record drawer at a desk — drawn by the one chrome from what the page already has.**
 *
 * What this pins, file by file (the rendered proof is tests/e2e/the-erp-pages-meet-the-spec.e2e.ts):
 *   1. the foundation carries the anatomy rules, scoped so the till's and the handhelds' sheets are untouched, and
 *      nothing a person must read in them is under 14px (design system §3.2);
 *   2. the chrome paints the head, the tiles and the registers, follows the page's own repaints, keeps a tile's
 *      accessible name exactly the label the page wrote, and has the count's words in both languages;
 *   3. every page has a title (`h2`) in `main` for the head to mark; every tab names a section (`tab-x` ↔ `view-x`);
 *   4. no page keeps a sheet placement or size rule of its own — the drawer is the foundation's, once;
 *   5. the till keeps its own sheet (UX-1b: layouts unchanged).
 */

const WEB = 'apps/web-erp/web';
const pages = readdirSync(WEB).filter((f) => f.endsWith('.html')).sort();
const read = (p: string): string => readFileSync(p, 'utf8');
const styleOf = (html: string): string => (/<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
const FOUNDATION = read('packages/ui/web/sre-foundation.css');
const CHROME = read(`${WEB}/sre-chrome.js`);
const ANATOMY = FOUNDATION.slice(FOUNDATION.indexOf('The page anatomy (OB-13'));

describe('the foundation carries the anatomy', () => {
  it('has the head, the tile strip, the register and the record drawer', () => {
    expect(ANATOMY).toMatch(/\[data-sre-head\] > \.sre-eyebrow \{/);
    expect(ANATOMY).toMatch(/\[data-sre-head\] > h2 \{/);
    expect(ANATOMY).toMatch(/\[data-sre-head\] > p\.lead \{/);
    expect(ANATOMY).toMatch(/\.sre-tabs \{ display: grid; grid-auto-flow: column;/);
    expect(ANATOMY).toMatch(/\.sre-tab\[aria-current="page"\] \{ border-top-color: var\(--accent\);/);
    expect(ANATOMY).toMatch(/\.sre-register th \{/);
    expect(ANATOMY).toMatch(/@media \(min-width: 1000px\) \{[\s\S]*place-items: stretch end;[\s\S]*height: 100%; max-height: none; border-radius: 0;/);
  });

  it('scopes the sheet and drawer rules to the back office, so the till\'s and the handhelds\' sheets keep their layout (UX-1b)', () => {
    for (const line of ANATOMY.split('\n').filter((l) => /\.sheet|\.sre-sheet/.test(l) && /\{/.test(l))) {
      for (const selector of line.split('{')[0]!.split(',')) expect(selector.trim(), line).toMatch(/^body\.sre-shell /);
    }
    expect(styleOf(read('apps/pos/web/index.html'))).toMatch(/\.sheet \{/);
  });

  it('nothing a person must read in the anatomy is under 14px', () => {
    for (const m of ANATOMY.matchAll(/font-size: (\d+)px/g)) expect(Number(m[1]), m[0]).toBeGreaterThanOrEqual(14);
  });
});

describe('the chrome paints it from what the page has', () => {
  it('marks the head, wraps the tabs as tiles, classes the tables, and repaints when the page does', () => {
    expect(CHROME).toMatch(/function paintHead\(\)/);
    expect(CHROME).toMatch(/setAttribute\('data-sre-head', ''\)/);
    expect(CHROME).toMatch(/eyebrow\.className = 'sre-eyebrow'/);
    expect(CHROME).toMatch(/function paintTabs\(\)/);
    expect(CHROME).toMatch(/tabs\.classList\.add\('sre-tabs'\)/);
    expect(CHROME).toMatch(/button\.classList\.add\('sre-tab'\)/);
    expect(CHROME).toMatch(/function paintRegisters\(\)[\s\S]*classList\.add\('sre-register'\)/);
    expect(CHROME).toMatch(/function repaint\(\) \{[^}]*paintAnatomy\(\); \}/);
    expect(CHROME).toMatch(/new MutationObserver\(scheduleAnatomy\)\.observe\(mainEl, \{ childList: true, subtree: true, attributes: true, attributeFilter: \['hidden'\] \}\)/);
    expect(CHROME).toMatch(/new MutationObserver\(scheduleAnatomy\)\.observe\(tabsEl, \{ childList: true, subtree: true \}\)/);
  });

  it('keeps a tile\'s accessible name exactly the label the page wrote, and describes it with the purpose and the count', () => {
    expect(CHROME).toMatch(/button\.setAttribute\('aria-label', title\.textContent\)/);
    expect(CHROME).toMatch(/setAttribute\('aria-describedby', `\$\{d\.id\} \$\{c\.id\}`\)/);
  });

  it('writes only what changed, so its own repaint cannot loop through the observers', () => {
    expect(CHROME).toMatch(/const setText = \(el, text\) => \{ if \(el\.textContent !== text\) el\.textContent = text; \};/);
    expect(CHROME).toMatch(/if \(button\.getAttribute\('aria-label'\) !== title\.textContent\)/);
    expect(CHROME).toMatch(/requestAnimationFrame\(\(\) => \{ anatomyQueued = false; paintAnatomy\(\); \}\)/);
  });

  it('counts the rows a page painted — table rows and list rows — never a figure tile; a closed subpage\'s list still counts', () => {
    expect(CHROME).toMatch(/querySelectorAll\('tbody > tr, \.rows > li, \.sre-rows > li, \.sre-row'\)\]\.filter\(\(row\) => shownWithin\(row, section\)\)/);
    expect(CHROME).toMatch(/const shownWithin = \(el, root\) => \{ for \(let n = el; n && n !== root; n = n\.parentElement\) if \(n\.hidden\) return false; return true; \};/);
  });

  it('has the count\'s words in both languages, with the number in them', () => {
    expect(CHROME).toMatch(/inList: '\{n\} in the list'/);
    expect(CHROME).toMatch(/inList: 'பட்டியலில் \{n\}'/);
    expect(CHROME).toMatch(/t\('inList'\)\.replace\('\{n\}', String\(n\)\)/);
  });

  it('takes the eyebrow from the rail: the group whose item is current, in the reader\'s language, and none off the box', () => {
    expect(CHROME).toMatch(/function currentGroup\(\)[\s\S]*nav\.groups\.find\(\(g\) => \(g\.items \?\? \[\]\)\.some\(\(item\) => isCurrent\(item\)\)\)/);
    expect(CHROME).toMatch(/if \(!group\) \{ if \(eyebrow\) eyebrow\.remove\(\); return; \}/);
  });
});

describe('every page gives the chrome what it needs', () => {
  it('has a title in main for the head to mark', () => {
    for (const f of pages) {
      const main = /<main>([\s\S]*?)<\/main>/.exec(read(`${WEB}/${f}`))?.[1] ?? '';
      expect(main, `${f} has no <h2> in <main>`).toMatch(/<h2[ >]/);
    }
  });

  it('every tab names a section — tab-x opens view-x — on every page with a tab strip', () => {
    let tabbed = 0;
    for (const f of pages) {
      const html = read(`${WEB}/${f}`);
      const tabs = [...html.matchAll(/<button id="tab-([a-z0-9-]+)"/g)].map((m) => m[1]);
      if (tabs.length === 0) continue;
      tabbed += 1;
      expect(html, `${f} tabs are the one strip`).toMatch(/<nav id="tabs"/);
      for (const id of tabs) expect(html, `${f}: tab-${id} has no view-${id}`).toMatch(new RegExp(`<section id="view-${id}"`));
    }
    expect(tabbed).toBeGreaterThanOrEqual(11);
  });

  it('keeps no sheet placement or size rule of its own — the record drawer is the foundation\'s, once', () => {
    const offenders: string[] = [];
    for (const f of pages) {
      const css = styleOf(read(`${WEB}/${f}`));
      for (const sel of ['.sheet {', '.sheet{', '.sheet[hidden]', '.sheet-inner {', '.sheet-inner{', '.sheet .card {', '.sre-sheet {', '.sre-sheet-inner {']) {
        if (css.includes(sel)) offenders.push(`${f}: ${sel}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('a page with a sheet marks it the way the drawer expects: class="sheet" with a sheet-inner or a card', () => {
    let sheets = 0;
    for (const f of pages) {
      const html = read(`${WEB}/${f}`);
      if (!/class="sheet"/.test(html)) continue;
      sheets += 1;
      expect(html, `${f}`).toMatch(/class="sheet"[^>]*role="dialog"/);
      expect(html, `${f}`).toMatch(/class="(sheet-inner|card)"/);
    }
    // Five since 2b-vi-b: the Products & prices page lost its approver-picking sheet — a second person now approves
    // a loss-making price on their own Approvals page (ADR-0024), so that page has no sheet at all. Four since
    // 2b-vi-c-4: the buyer's page lost its "who checked this bill?" sheet — the check is a second person's own act at
    // head office.
    expect(sheets).toBe(4);
  });
});
