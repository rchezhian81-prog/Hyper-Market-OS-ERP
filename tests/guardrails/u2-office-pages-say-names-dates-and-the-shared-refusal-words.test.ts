import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * **U2 (UI/UX gap audit, 2 Nov 2026) — group D's rules, held statically (G5 · G10 · G14 · G16 · P-07 · P-08 · NFR-08).**
 *
 *   • The signed-in person's own store is filled in on the office pages that used to ask for a "Store" to be typed, and
 *     said by NAME beside the field, in both languages (`ownStore`, the `yourStore` words).
 *   • A name where an id was shown: Store computers (store, store computer, time zone), Category rules (the category's
 *     name), Stock health (product and place) — never a raw `u-…`, `Asia/Kolkata` or `p-milk @ S1` where a name is known.
 *   • A date a shop person reads: no page or session tells a person to type "YYYY-MM-DD" / "YYYY-MM" any more; the pages
 *     that carried such fields go through the chrome's shared date field (`shopDate` / `dateOf`), the Tally files month is
 *     a named list.
 *   • The thirteen plain views that built their own refusal line now take the chrome's three-part words
 *     (`sreOffice.refusalWords`) and never print a bare HTTP status.
 *
 * The audit's own commit (`be62d0a`) holds the files as they were, so the rules are shown to bite rather than to be vacuous.
 */

const AUDIT_COMMIT = 'be62d0a';
const read = (path: string): string => readFileSync(path, 'utf8');
const was = (path: string): string => execFileSync('git', ['show', `${AUDIT_COMMIT}:${path}`], { encoding: 'utf8' });

const PLAIN_VIEWS = ['ai-drafts', 'ai', 'epr', 'gst-returns-ho', 'itc-review', 'organisation', 'posh-report', 'price-lists', 'product-categories', 'product-content', 'product-details', 'product-merges', 'tax-rates'];
/** A refusal line that ends in the bare status when head office gave no sentence — the thing U2 removes. */
const RAW_STATUS = /\$\{t\('refused'\)\}:? \$\{[^}]*whatHappened \?\? (?:out|res)\.status\}/;

const OWN_STORE_PAGES: readonly (readonly [page: string, session: string, input: string])[] = [
  ['floor-heat-map', 'floor-heat-map-session', 'store'],
  ['planogram-compliance', 'planogram-bays-session', 'store'],
  ['dispatch', 'dispatch-session', 'store'],
  ['dock-diary', 'dock-diary-session', 'd-store'],
  ['facilities-office', 'facilities-office-session', 'office-branch'],
];

const DATE_PAGES: readonly (readonly [page: string, ids: readonly string[]])[] = [
  ['floor-heat-map', ['from', 'to']], ['supplier-scorecard', ['from', 'to', 'k-starts', 'k-ends']], ['basket-affinity', ['from', 'to']],
  ['waste-analytics', ['from', 'to']], ['blanket-orders', ['p-from', 'p-to']], ['branch-compare', ['c-from', 'c-to']],
  ['offer-results', ['b-from', 'b-to']], ['day-book', ['day']], ['dispatch', ['run-date', 'till-day']], ['dock-diary', ['d-date']],
  ['facilities-office', ['office-asof']],
  // the second batch
  ['incidents', ['a-due']], ['certificates', ['c-issued', 'c-until']], ['help', ['d-on']], ['schedule', ['week']], ['findings', ['a-day']],
  ['rebates', ['s-starts', 's-ends', 'm-on']], ['appointment-letters', ['mk-from']], ['adoption', ['t-due', 'pr-from', 'pr-to']],
  ['tax-rates', ['g-from', 'c-from']], ['price-lists', ['p-from', 'p-to']], ['product-details', ['m-from']],
];

const FORMAT_FREE_SESSIONS = ['dispatch-session', 'till-delivery-desk-session', 'dock-diary-session', 'blanket-orders-session', 'branch-compare-session', 'tally-files-session', 'day-book-session'];

describe('U2 · the thirteen plain views take the shared three-part refusal words', () => {
  it('every view routes its refusal through refusalLine → sreOffice.refusalWords, and none prints a bare status any more', () => {
    for (const view of PLAIN_VIEWS) {
      const source = read(`apps/web-erp/web/${view}.js`);
      expect(source, `${view}: no refusalLine helper`).toMatch(/const refusalLine = \(status, err\) =>/);
      expect(source, `${view}: the helper does not reach the chrome's words`).toContain("office.refusalWords({ status, code: err?.code, whatHappened: err?.whatHappened, nextSafeAction: err?.nextSafeAction })");
      expect(source, `${view}: the helper is never used`).toMatch(/refusalLine\((?:out|res)\.status, /);
      expect(source, `${view}: still prints a bare HTTP status`).not.toMatch(RAW_STATUS);
    }
  });

  it('bites: the views as the audit found them printed the bare status', () => {
    const bitten = PLAIN_VIEWS.filter((view) => RAW_STATUS.test(was(`apps/web-erp/web/${view}.js`)));
    expect(bitten.length).toBeGreaterThanOrEqual(8);
  });
});

describe('U2 · a name where an id was shown (G16)', () => {
  it('Store computers says the store, the store computer and the time zone by name', () => {
    const source = read('apps/web-erp/web/store-computers.js');
    expect(source).toMatch(/const nameOf = \(kind, id\) =>/);
    for (const raw of ['cell(b.storeId)', 'cell(z.storeId)', 'cell(u.storeId)', 'cell(z.machineTimeZone)', 'cell(b.computer)']) expect(source, `raw id still shown: ${raw}`).not.toContain(raw);
    expect(source).toContain("cell(nameOf('zone', z.machineTimeZone))");
    expect(source).toContain("cell(nameOf('person', b.computer))");
    expect(was('apps/web-erp/web/store-computers.js'), 'the audit-day page did show the raw store id').toContain('cell(z.storeId)');
  });

  it('Category rules shows the category by name; Stock health the product and the place', () => {
    const categories = read('apps/web-erp/web/category-policy.js');
    expect(categories).toContain('cat.textContent = categoryName(c.categoryId);');
    expect(categories).toContain("window.categoryPolicyData?.categoryNames");
    expect(categories).toContain("o.nameOf('category', id)");
    const stock = read('apps/web-erp/web/stock-health.js');
    expect(stock).toContain("`${nameOf('product', s.productId)} @ ${nameOf('place', s.locationId)}`");
    expect(stock).not.toContain('`${s.productId} @ ${s.locationId}`');
  });
});

describe('U2 · the person\'s own store is filled in and named (G5)', () => {
  it('each page fills its store from sreOffice.me, says the name beside it, and carries the words in both languages', () => {
    for (const [page, session, input] of OWN_STORE_PAGES) {
      const source = read(`apps/web-erp/web/${page}.js`);
      expect(source, `${page}: no ownStore`).toMatch(/function ownStore\(inputId\)/);
      expect(source, `${page}: ownStore never called for #${input}`).toContain(`ownStore('${input}')`);
      expect(source, `${page}: does not fill in once the chrome is there`).toContain("document.addEventListener('sre:chrome'");
      const words = read(`apps/web-erp/src/${session}.ts`);
      expect(words, `${session}: no English "your store"`).toContain("yourStore: 'your store'");
      expect(words, `${session}: no Tamil "your store"`).toContain("yourStore: 'உங்கள் கடை'");
    }
    expect(was('apps/web-erp/web/floor-heat-map.js')).not.toContain('ownStore(');
  });
});

describe('U2 · a date a shop person reads (G14)', () => {
  it('no office session or page label tells a person to type YYYY-MM-DD or YYYY-MM any more', () => {
    for (const session of FORMAT_FREE_SESSIONS) {
      const source = read(`apps/web-erp/src/${session}.ts`);
      // a word a person reads: the dictionary strings — not the regex that checks the ISO the page sends
      const spoken = [...source.matchAll(/'([^'\n]*YYYY-MM[^'\n]*)'/g)].map((m) => m[1]);
      expect(spoken, `${session}: still tells a person the format`).toEqual([]);
    }
    for (const page of ['dispatch', 'blanket-orders', 'dock-diary', 'tally-files']) {
      const html = read(`apps/web-erp/web/${page}.html`);
      expect(html, `${page}: a format in a label`).not.toMatch(/YYYY-MM/);
      expect(html, `${page}: a placeholder teaches a date`).not.toMatch(/placeholder="2026-/);
    }
    expect(was('apps/web-erp/src/dispatch-session.ts')).toMatch(/Run date \(YYYY-MM-DD\)/);
  });

  it('every page with a date goes through the shared field and reads ISO through dateOf, and the Tally month is a named list', () => {
    for (const [page, ids] of DATE_PAGES) {
      const source = read(`apps/web-erp/web/${page}.js`);
      expect(source, `${page}: no shopDate helper`).toMatch(/function shopDate\(id, words, opts = \{\}\)/);
      expect(source, `${page}: labels do not follow the toggle`).toMatch(/function repaintShopDates\(\)/);
      for (const id of ids) {
        expect(source, `${page}: #${id} never converted`).toContain(`shopDate('${id}'`);
        expect(source, `${page}: #${id} still read as the raw input`).not.toMatch(new RegExp(`(?:\\$|el)\\('${id}'\\)\\.value(?! =)`));
      }
    }
    const tally = read('apps/web-erp/web/tally-files.js');
    expect(tally).toMatch(/function paintMonthList\(\)/);
    expect(tally).toContain("'ஜனவரி'");
    expect(tally).toMatch(/length: 24/);
  });
});
