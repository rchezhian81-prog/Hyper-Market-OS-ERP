import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { beforeFixture } from '../support/before-fixture';

/**
 * **U2 · G5 of the UI/UX gap audit (2 Nov 2026): on the HARD buying and stock pages a thing is PICKED by name, never
 * typed as a code (P-07 · NFR-13).**
 *
 * Five pages asked a shop person to type a supplier code, an item code, a place id, a branch code and product ids. Each
 * id field now carries a "Choose…" button that opens the chrome's shared picker (`sreOffice.pick`) and writes the picked
 * id into the SAME field — the page sends exactly the id it always sent — with the thing's name shown beside it; the
 * field stays typeable so that, with head office down or no right to the list, typing the code is the fallback and the
 * form is never a dead end (P-01 · P-08). The person's own store is filled in where a store or branch was typed. Every
 * new word has its Tamil twin. The audit's own commit (`be62d0a`) holds the pages as they were, so the rule is proven
 * to bite, not just to hold.
 */

const web = (f: string): string => readFileSync(`apps/web-erp/web/${f}`, 'utf8');
const src = (f: string): string => readFileSync(`apps/web-erp/src/${f}`, 'utf8');
const before = (path: string): string => beforeFixture('be62d0a', path);

const PAGES = [
  { page: 'buying.js', pickers: ["pickerBeside(el('po-supplier'), 'supplier'", "pickerBeside(el('po-product'), 'product'", "pickerBeside(el('po-store'), 'store'"], words: 'web/buying.js', store: "el('po-store').value = id" },
  { page: 'count-plans.js', pickers: ["pickerBeside($('place'), 'place'", "kind: 'product'"], words: 'src/count-plans-session.ts', store: 'scope: { storeId: myStore() }', prefills: false },
  { page: 'packaging.js', pickers: ["pickerBeside($('q-branch'), 'store'", "pickerBeside($('m-branch'), 'store'"], words: 'src/packaging-session.ts', store: "for (const f of ['q-branch', 'm-branch'])" },
  { page: 'demand-events.js', pickers: ["pickerBeside($('store'), 'store'", "pickerBeside($('product'), 'product'", "kind: 'product'"], words: 'src/demand-events-session.ts', store: "$('store').value = id" },
  { page: 'scrap.js', pickers: ["pickerBeside($('v-branch'), 'store'", "pickerBeside($('s-branch'), 'store'"], words: 'src/scrap-session.ts', store: "for (const f of ['v-branch', 's-branch'])" },
] as const;

const wordsOf = (path: string): string => (path.startsWith('web/') ? web(path.slice(4)) : src(path.slice(4)));

describe('U2 · G5: the HARD pages pick by name', () => {
  it.each(PAGES)('$page opens the shared picker for each id it used to ask typed, and fills in the person\'s store', ({ page, pickers, store, ...rest }) => {
    const prefills = (rest as { prefills?: boolean }).prefills;
    const js = web(page);
    for (const call of pickers) expect(js, `${page} lacks ${call}`).toContain(call);
    // the picker writes into the field the page already sends, with the typed code left as the fallback
    expect(js).toMatch(/if \(!office \|\| typeof office\.pick !== 'function'\) \{[^}]*pickUnavailable/);
    expect(js).toContain('allowCode: true');
    expect(js).toContain('input.value = picked.id;');
    expect(js).toContain(store);
    // a page that fills a field in waits for the chrome too (it may load after the page); the place picker's scope is read at pick time
    if (prefills !== false) expect(js).toContain("document.addEventListener('sre:chrome'");
  });

  it.each(PAGES)('$page says "Choose…", "which …?" and the fallback in English and Tamil', ({ words }) => {
    const text = wordsOf(words);
    for (const key of ['choose', 'pickUnavailable']) {
      expect(text, `${words}: ${key} in English`).toMatch(new RegExp(`${key}: '[^']*[A-Za-z]`));
      expect(text, `${words}: ${key} in Tamil`).toMatch(new RegExp(`${key}: '[^']*[\\u0B80-\\u0BFF]`));
    }
    expect(text).toMatch(/which[A-Z][a-z]+: '[^']*\?'/);
  });

  it('no label on the five pages asks for a code or an id to be typed any more (Packaging\'s own item id excepted: a crate type is registered on that page by the id the shop gives it, and no list of them exists yet — U2b)', () => {
    const texts = [web('buying.js'), src('count-plans-session.ts'), src('packaging-session.ts').replace(/\bitem: '[^']*'/g, ''), src('demand-events-session.ts'), src('scrap-session.ts')];
    for (const text of texts) {
      expect(text).not.toMatch(/\b(item|supplier|branch|product|place|store)[A-Za-z]*: '[^']*\b(code|id)\b[^']*'/i);
      expect(text).not.toContain('(location id)');
    }
  });

  it('Count plans and Store events build the product list one pick at a time, with Remove, the bulk box second', () => {
    const cp = web('count-plans.js'); const cph = web('count-plans.html');
    expect(cph).toContain('id="product-list"'); expect(cph).toContain('id="add-product"');
    expect(cp).toContain("productsText: productsText()");
    expect(cp).toContain("[...pickedProducts.map((p) => p.id), $('products').value].join('\\n')");
    expect(cp).toMatch(/textContent: t\('remove'\)/);
    const de = web('demand-events.js'); const deh = web('demand-events.html');
    expect(deh).toContain('<input id="products" type="hidden" />');
    expect(de).toContain("$('products').value = pickedProducts.map((p) => p.id).join(',')");
    // the typed multiplier is said in words beside the box ("50% higher than usual")
    expect(de).toContain("$('effect').addEventListener('input', paintEffectWords)");
    expect(src('demand-events-session.ts')).toMatch(/effectHint: '[^']*\{effect\}[^']*'/);
  });

  it('bites: the audit-day pages asked for typed codes and had no picker', () => {
    const old = before('apps/web-erp/web/buying.js');
    expect(old).not.toContain('pickerBeside(');
    expect(old).toContain("itemCode: 'Item code'");
    expect(before('apps/web-erp/src/count-plans-session.ts')).toContain("place: 'Place (location id)'");
    expect(before('apps/web-erp/src/scrap-session.ts')).toContain("branch: 'Branch code'");
  });
});
