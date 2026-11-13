import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { expectChromePickableKeepsTheRules, expectChromeShopDateKeepsTheRules } from '../support/picker-pins';

/**
 * **U7 · Group C2 (UI/UX audit G5 · G14 · notes-P1 / notes-T2): the lane-1 office pages hand their pickers and their
 * dd/mm/yyyy fields to the chrome's ONE copy (`sreOffice.pickable` / `sreOffice.shopDate`) — P-07 · NFR-08.**
 * Twelve pages each carried their own copy of the picker lines and the date lines, and each repainted the date field's
 * label and hint by hand on the language toggle (`repaintShopDates`). A fix in one copy never reached the others. The
 * chrome now repaints its own fields on the toggle; a page keeps only a thin adapter that keeps its element ids.
 */

const PAGES = ['blanket-orders', 'catalogue', 'demand-events', 'dispatch', 'dock-diary', 'facilities-office', 'floor-heat-map', 'offer-results', 'product-details', 'rebates', 'supplier-scorecard', 'tax-rates'] as const;
const web = (p: string): string => readFileSync(`apps/web-erp/web/${p}.js`, 'utf8');
const CHROME = readFileSync('apps/web-erp/web/sre-chrome.js', 'utf8');

describe('U7: the office pages hand pickers and dates to the chrome', () => {
  it.each(PAGES)('%s carries no copy of its own: no hand-built date field, no hand-repainted label, no hand-built picker', (p) => {
    const js = web(p);
    expect(js, `${p} builds the date field itself`).not.toContain('office.dateField(');
    expect(js, `${p} repaints the date field's words by hand`).not.toMatch(/function repaintShopDates\(\)/);
    expect(js, `${p} builds a picker row itself`).not.toMatch(/row\.className = 'pick-row'/);
    expect(js, `${p} opens the picker itself instead of handing the field over`).not.toMatch(/await office\.pick\(\{ kind: k/);
    // where the page has dates or pickers, they go through the chrome's copy
    if (/shopDate\('/.test(js)) expect(js, `${p}: dates through the chrome`).toMatch(/\.shopDate\(/);
    if (/pickable\(/.test(js)) expect(js, `${p}: pickers through the chrome`).toMatch(/\.pickable\(/);
  });

  it('the chrome\'s copy holds every rule the page copies held — and a kind that follows the form hides "Choose…" when no list exists', () => {
    expectChromePickableKeepsTheRules();
    expectChromeShopDateKeepsTheRules();
    expect(CHROME).toContain('const paint = () => { btn.hidden = kindNow() === null;');
    expect(CHROME, 'a page that recomputes as a person types hears the pick').toMatch(/input\.dispatchEvent\(new Event\('input', \{ bubbles: true \}\)\);\n\s+name\.textContent = typeof picked\.name/);
    expect(CHROME, 'a page can repaint its pickers when its form changes').toContain('row.sreRepaint = paint;');
  });

  it.each(['scales', 'incidents', 'store-computers', 'fleet'])('%s draws its summary figures as the chrome\'s cards — "Not known", never a dash, once the chrome is there (notes-P4)', (p) => {
    const js = web(p);
    expect(js, `${p} does not hand its figures to the cards part`).toMatch(/o\.cards\(/);
    expect(js, `${p} never repaints as cards when the chrome arrives`).toMatch(/addEventListener\('sre:chrome', \(\) => (?:\{ if \(api !== null\) paintSummary\(\); \}|paint\(\))/);
  });
  it('the cards part keeps a page\'s own element ids on its parts', () => {
    expect(CHROME).toContain('if (c.ids?.card) card.id = c.ids.card;');
    expect(CHROME).toContain('if (c.ids?.value) value.id = c.ids.value;');
  });
});

