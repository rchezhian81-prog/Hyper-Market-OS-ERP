import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * **U5 · the chrome's shared parts, so no office page needs a list, a state, a card, a chip or a field of its own
 * (UI/UX gap audit G11 · G13 · G17 · P-07 · P-08 · NFR-08).**
 *
 * Round U5 puts every office page on the parts ONE chrome draws. This pins what the pages lean on: the register with
 * search, a visible sort direction (words, not an arrow alone), paging and a count; the record chip that turns a
 * lifecycle state into the tone and the words; `pickable` and `shopDate`, the page-side adapters the U2/U2b groups had to
 * paste into thirteen scripts, now in the chrome; the tax-class picker kind; the product picker's fallback to the store
 * computer's own signed catalogue when head office cannot be reached (P-01); and the phone chrome that shows the page's
 * name ONCE and folds the rest behind the menu (G11). Every word in both languages; no literal colour. The rendered
 * behaviour is proven in tests/e2e/u5-the-chrome-shared-parts-on-a-phone-and-a-desk.e2e.ts.
 */

const CHROME = readFileSync('apps/web-erp/web/sre-chrome.js', 'utf8');
const FOUNDATION = readFileSync('packages/ui/web/sre-foundation.css', 'utf8');
const SERVER = readFileSync('edge/store-edge/src/screen-server.ts', 'utf8');
const code = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

/** The keys of one `{ en: {...}, ta: {...} }` word table named `name` — the two languages must carry the same keys. */
function wordKeys(source: string, name: string): { en: string[]; ta: string[] } {
  const start = source.indexOf(`const ${name} = {`);
  expect(start, `${name} is in the chrome`).toBeGreaterThan(-1);
  const block = code(source.slice(start, source.indexOf('\n  };', start)));
  const part = (lang: 'en' | 'ta'): string[] => {
    const from = block.indexOf(`\n    ${lang}: {`);
    const to = block.indexOf('\n    },', from);
    return [...block.slice(from, to).matchAll(/(?:^|[\s{,])(?:'([^']+)'|([A-Za-z_][A-Za-z0-9_]*)):\s/g)].map((m) => m[1] ?? m[2]!).filter((k) => k !== lang);
  };
  return { en: part('en'), ta: part('ta') };
}

describe('U5: the chrome carries the shared parts every office page stands on', () => {
  it('exports pickable, shopDate, setShopDate, dateOf and recordChip on sreOffice, beside the W1 and U2 parts', () => {
    for (const name of ['pickable: officePickable', 'shopDate: officeShopDate', 'setShopDate', 'dateOf: dateValue', 'recordChip: officeRecordChip', 'table: officeTable', 'state: officeState', 'cards: officeCards', 'chip: officeChip', 'field: officeField']) {
      expect(CHROME, name).toContain(name);
    }
  });

  it('the register says its sort direction in words beside the heading, can be searched and paged, and stacks its rows on a phone instead of scrolling sideways', () => {
    expect(CHROME).toContain("sortedAsc:");
    expect(CHROME).toContain("sortedDesc:");
    expect(CHROME).toContain("dir.className = 'sre-sort-dir'");
    expect(CHROME).toContain("opts.sortable === true");
    expect(CHROME).toContain("opts.search !== false");
    expect(CHROME).toContain("td.dataset.label = said(col.label)");
    expect(FOUNDATION).toMatch(/@media \(max-width: 519px\)[\s\S]*\.sre-register td::before \{ content: attr\(data-label\)/);
    expect(FOUNDATION).toMatch(/@media \(max-width: 519px\)[\s\S]*\.sre-datatable-body > \.sre-scroll-x \{ overflow-x: hidden/);
  });

  it('a record chip turns a lifecycle state into the tone and the words of both languages — never a bare pill or a ⚠ character', () => {
    expect(CHROME).toContain('const RECORD_STATES = ');
    for (const state of ['draft', 'pending', 'approved', 'rejected', 'open', 'closed', 'done', 'cancelled', 'active', 'held', 'sent', 'failed', 'unknown']) {
      expect(CHROME, `state ${state}`).toMatch(new RegExp(`${state}: \\{ tone: '[a-z]+', en: '[^']+', ta: '[^']+' \\}`));
    }
    expect(CHROME).toContain("function officeRecordChip(state, label)");
  });

  it('pickable and shopDate are the U2 adapters, in the chrome: the typed id stays the fallback, the name is shown beside, a date is sent as ISO', () => {
    expect(CHROME).toContain('function officePickable(target, kind, title, extra = {})');
    expect(CHROME).toContain("input.dataset.pickable = 'on'");
    expect(CHROME).toContain("name.className = 'sre-pick-name'");
    expect(CHROME).toContain('function officeShopDate(id, label, opts = {})');
    expect(CHROME).toContain('const setShopDate = (id, iso)');
    // the labels of both follow the language toggle like every other word
    expect(CHROME).toMatch(/function repaintAdapters\(\)/);
  });

  it('the picker knows a tax class (HSN by code or by the products under it) and falls back to the store computer\'s own signed catalogue for a product when head office cannot be reached', () => {
    expect(CHROME).toContain("'tax-class'");
    expect(CHROME).toContain("'pick_tax-class':");
    expect(CHROME).toContain("'pickHint_tax-class':");
    expect(CHROME).toContain("'/directory/products'");
    expect(CHROME).toContain('pickFromBox:');
    expect(code(SERVER)).toContain("const DIRECTORY_PRODUCTS_PATH = '/directory/products'");
    expect(code(SERVER)).toMatch(/doorPath === DIRECTORY_PRODUCTS_PATH/);
  });

  it('the phone chrome shows the page\'s name once and folds the breadcrumb, pin and find behind the menu (G11)', () => {
    expect(CHROME).toContain("const phone = window.matchMedia('(max-width: 519px)')");
    expect(CHROME).toMatch(/function foldTopline\(\)/);
    expect(FOUNDATION).toMatch(/@media \(max-width: 519px\)[\s\S]*\.sre-crumbs \{ display: none; \}/);
    expect(FOUNDATION).toMatch(/@media \(max-width: 519px\)[\s\S]*\[data-sre-head\] > \.sre-eyebrow \{ display: none; \}/);
    // a subpage tile says its whole purpose line, never "Saved on this scr…"
    expect(FOUNDATION).not.toMatch(/\.sre-tab \.d \{[^}]*white-space: nowrap/);
  });

  it('every chrome word is in English and Tamil, and the new rules use tokens, not literal colours', () => {
    for (const table of ['WORDS', 'OFFICE_WORDS']) {
      const { en, ta } = wordKeys(CHROME, table);
      expect(en.length, `${table} has words`).toBeGreaterThan(10);
      expect(ta.filter((k) => !en.includes(k)), `${table}: Tamil keys with no English`).toEqual([]);
      expect(en.filter((k) => !ta.includes(k)), `${table}: English keys with no Tamil`).toEqual([]);
    }
    const u5 = FOUNDATION.slice(FOUNDATION.indexOf('/* ── U5'));
    expect(u5.length, 'the U5 block is in the foundation').toBeGreaterThan(100);
    expect(u5).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    expect(code(CHROME)).not.toMatch(/style\.(color|background)\s*=\s*'#/);
  });
});
