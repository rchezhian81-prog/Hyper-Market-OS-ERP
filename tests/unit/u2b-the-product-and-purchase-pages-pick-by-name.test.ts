import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * **U2b · G5 and G14 of the UI/UX gap audit (4 Nov 2026): the product and purchase pages pick a thing by NAME, never
 * typed as a code, and write every date as the shop writes it (P-07 · NFR-13 · NFR-08).**
 *
 * After the ten HARD pages (U2), these pages still asked a shop person to type a product id, a supplier code, a store
 * code, an item code: Product details, Duplicates and merges, Price lists, App content, Requisitions, Supplier scorecard,
 * Standing orders, Shelves & space. Each id field now carries a "Choose…" button that opens the chrome's shared picker
 * (`sreOffice.pick`) and writes the picked id into the SAME field — the page sends exactly the id it always sent — with
 * the thing's name beside it; the field stays typeable so that, with head office down or no right to the list, typing
 * the code is the fallback and the form is never a dead end (P-01 · P-08). Where a list exists on the page itself
 * (Rebates' schemes and claims, GST rates' classes) it is offered on the field. The remaining native and typed dates
 * (the catalogue's price and offer days, a supplier advance, an offer-funding receipt, a B2B contract and recurring
 * order, a store event, an asset's in-service day) go through the chrome's shared date field. Every new word has its
 * Tamil twin. The round's starting commit (`6bc69ed`) holds the pages as they were, so the rule is proven to bite.
 */

const web = (f: string): string => readFileSync(`apps/web-erp/web/${f}`, 'utf8');
const src = (f: string): string => readFileSync(`apps/web-erp/src/${f}`, 'utf8');
const before = (path: string): string => execFileSync('git', ['show', `6bc69ed:${path}`], { encoding: 'utf8' });

/** A label that asks a shop person to type an id or a code (a bare "HSN code" is the class itself and is allowed). */
const TYPED_ID_LABEL = /'[A-Z][^']*\b(?:product|supplier|store|branch|item|customer|scheme)\s+(?:id|ids|code|codes)\b[^']*'|\((?:parent product|store|item|location) (?:id|code)\)/;

const PICK_PAGES = [
  { page: 'product-details.js', pickers: ["pickable('product', 'product', 'pickProduct')", "pickable('r-parent', 'product', 'pickProduct')", "pickable(`bd-prod-${i}`, 'product', 'pickProduct')"], words: ['web/product-details.js'] },
  { page: 'product-merges.js', pickers: ["pickable('m-keep', 'product', 'pickProduct')", "pickable('m-drop', 'product', 'pickProduct')"], words: [] },
  { page: 'price-lists.js', pickers: ["pickable('p-product', 'product', 'pickProduct')", "pickable('p-ref', () => ({ store: 'store', customer: 'customer' })[$('p-scope').value] ?? null"], words: ['web/price-lists.js'] },
  { page: 'product-content.js', pickers: ["pickable('product', 'product', 'pickProduct')"], words: ['web/product-content.js'] },
  { page: 'requisitions.js', pickers: ["pickable(`new-productId-${i}`, 'product', 'pickProduct')", "pickable('quote-supplier', 'supplier', 'pickSupplier')", "pickable('order-store', 'store', 'pickStore')", "prefillStore('order-store')"], words: ['src/requisitions-session.ts'] },
  { page: 'supplier-scorecard.js', pickers: ["pickable('supplier', 'supplier', 'pickSupplier')"], words: ['src/supplier-scorecard-session.ts'] },
  { page: 'blanket-orders.js', pickers: ["pickable('p-supplier', 'supplier', 'pickSupplier')", "pickable('p-deliver', 'store', 'pickStore')", "prefillStore('p-deliver')"], words: ['src/blanket-orders-session.ts'] },
  { page: 'merchandising.js', pickers: ["pickable('count-product', 'product', 'pickProduct')", "pickable('drop-product', 'product', 'pickProduct')", "pickable('drop-replacement', 'product', 'pickProduct')"], words: ['web/merchandising.js'] },
] as const;

const wordsOf = (path: string): string => (path.startsWith('web/') ? web(path.slice(4)) : src(path.slice(4)));

describe('U2b · G5: the product and purchase pages pick by name', () => {
  it.each(PICK_PAGES)('$page opens the shared picker for each id it used to ask typed', ({ page, pickers, words }) => {
    const js = web(page);
    for (const call of pickers) expect(js, `${page} lacks ${call}`).toContain(call);
    // the chrome's picker, the typed code kept, the name beside the field, the picked id into the field the page sends
    expect(js).toContain("if (!office || typeof office.pick !== 'function') { document.addEventListener('sre:chrome'");
    expect(js).toContain('allowCode: true');
    expect(js).toContain("input.value = typeof extra.idOf === 'function' ? extra.idOf(picked) : String(picked.id ?? '');");
    expect(js).toContain("name.textContent = typeof picked.name === 'string' && picked.name !== input.value ? picked.name : '';");
    // the Choose… button is a 44px foundation button with a name a screen reader says
    expect(js).toContain("btn.className = 'sre-btn sre-btn-quiet pick'");
    expect(js).toContain("btn.setAttribute('aria-label', `${pw('choose')} ${pw(titleNow())}`)");
    // the words follow the language toggle
    expect(js).toContain('repaintPickers();');
    expect(js).toMatch(/const pickWords = \{ en: \{[^\n]*choose: 'Choose…'[^\n]*\}, ta: \{[^\n]*choose: 'தேர்ந்தெடு…'[^\n]*\} \};/);
    // no label on the page or its session asks for an id or a code to be typed any more
    for (const w of [`web/${page}`, `web/${page.replace('.js', '.html')}`, ...words]) expect(wordsOf(w), `${w} still asks for a typed id/code`).not.toMatch(TYPED_ID_LABEL);
  });

  it('a store price picks a store, a customer price a customer, and a zone or channel price has no list (typed, as before)', () => {
    const js = web('price-lists.js');
    expect(js).toContain("() => ($('p-scope').value === 'customer' ? 'pickCustomer' : 'pickStore')");
    expect(js).toContain("btn.hidden = kindNow() === null;");
    expect(js).toContain("$('p-scope').addEventListener('change', () => { paintRefs(); repaintPickers(); });");
  });

  it('a requisition line gets its picker each time the lines are drawn; Deliver to and a standing order\'s store start as the person\'s own store', () => {
    const req = web('requisitions.js');
    expect(req).toMatch(/for \(let i = 0; i < newLines\.length; i \+= 1\) pickable\(`new-productId-\$\{i\}`, 'product', 'pickProduct'\);/);
    for (const page of ['requisitions.js', 'blanket-orders.js']) {
      const js = web(page);
      expect(js).toContain("const id = me?.storeId ?? window.sreDirectory?.store?.id ?? '';");
      expect(js).toContain("if (!input || input.value.trim() !== '') return;"); // filled in only while empty — changeable
    }
  });

  it('Rebates offers the schemes and claims it read, and GST rates the classes head office lists, on the field itself (the code stays the value)', () => {
    expect(web('rebates.html')).toContain('<input id="c-scheme" autocomplete="off" list="scheme-list" />');
    expect(web('rebates.html')).toContain('<input id="m-scheme" autocomplete="off" list="scheme-list" />');
    expect(web('rebates.html')).toContain('<input id="m-claim" autocomplete="off" list="claim-list" />');
    expect(web('rebates.js')).toContain("$('scheme-list').replaceChildren(...reg.schemes.map(");
    expect(web('rebates.js')).toContain("$('claim-list').replaceChildren(...reg.claims.map(");
    expect(src('rebates-session.ts')).toContain("schemeId: 'Scheme'");
    expect(src('rebates-session.ts')).toContain("schemeId: 'திட்டம்'");
    expect(web('tax-rates.html')).toContain('list="hsn-list"');
    expect(web('tax-rates.js')).toContain("$('hsn-list').replaceChildren(...classes.map(");
  });

  it('every new word has its Tamil twin', () => {
    for (const { page } of PICK_PAGES) {
      const js = web(page);
      const en = /const pickWords = \{ en: \{([^}]*)\}, ta: \{([^}]*)\} \};/.exec(js);
      expect(en, `${page} has no picker words`).not.toBeNull();
      const keys = (block: string): string[] => [...block.matchAll(/\b([a-zA-Z]+): '/g)].map((m) => m[1]!);
      expect(keys(en![2]!)).toEqual(keys(en![1]!));
      expect(en![2]).toMatch(/[஀-௿]/);
    }
    const pairs: [string, string, string][] = [
      ['requisitions-session.ts', "product: 'Product'", "product: 'பொருள்'"], ['requisitions-session.ts', "supplier: 'Supplier'", "supplier: 'விநியோகஸ்தர்'"], ['requisitions-session.ts', "deliverTo: 'Deliver to'", "deliverTo: 'விநியோகிக்கும் இடம்'"],
      ['supplier-scorecard-session.ts', "supplier: 'Supplier'", "supplier: 'விநியோகஸ்தர்'"], ['blanket-orders-session.ts', "supplier: 'Supplier'", "supplier: 'விநியோகஸ்தர்'"],
      ['promotion-funding-session.ts', "receivedOn: 'Received on'", "receivedOn: 'பெற்ற நாள்'"],
    ];
    for (const [file, en, ta] of pairs) { expect(src(file)).toContain(en); expect(src(file)).toContain(ta); }
    for (const [file, en, ta] of [['merchandising.js', "itemCode: 'Item'", "itemCode: 'பொருள்'"], ['price-lists.js', "ref: 'Store, zone, channel or customer'", "ref: 'கடை, மண்டலம், வழி அல்லது வாடிக்கையாளர்'"], ['product-details.js', "product: 'Product'", "product: 'பொருள்'"]] as const) {
      expect(web(file)).toContain(en); expect(web(file)).toContain(ta);
    }
  });
});

describe('U2b · G14: the remaining dates are written as the shop writes them', () => {
  const DATE_PAGES: { page: string; fields: string[]; reads: string[] }[] = [
    { page: 'catalogue.js', fields: ['price-from', 'rule-starts', 'rule-ends'], reads: ["dateOf('price-from')", "startsOn: dateOf('rule-starts'), endsOn: dateOf('rule-ends')"] },
    { page: 'supplier-bills.js', fields: ['adv-on'], reads: ["paidOn: dateOf('adv-on')"] },
    { page: 'promotion-funding.js', fields: ['c-on'], reads: ["receivedOn: dateOf('c-on')"] },
    { page: 'b2b.js', fields: ['k-from', 'k-to', 'rec-start'], reads: ["validFrom: dateOf('k-from'), validTo: dateOf('k-to')", "dateOf('rec-start')"] },
    { page: 'demand-events.js', fields: ['ev-from', 'ev-to'], reads: ["from: dateOf('ev-from'), to: dateOf('ev-to')"] },
    { page: 'finance-close.js', fields: ['a-in'], reads: ["inServiceDate: dateOf('a-in')"] },
  ];
  it.each(DATE_PAGES)('$page mounts the shared date field on $fields and reads ISO through it', ({ page, fields, reads }) => {
    const js = web(page);
    for (const f of fields) expect(js, `${page} does not mount the shared date field on ${f}`).toMatch(new RegExp(`shopDate\\('${f}', \\{ en: `));
    for (const r of reads) expect(js, `${page} still reads the plain field`).toContain(r);
    expect(js).toContain("const field = office.dateField({ id, label: words, required: opts.required === true, ...(iso ? { value: iso } : {}) });");
    expect(js).toContain('repaintShopDates();');
    // the month lengths are the shared field's (calendar arithmetic) — this page reads no device clock for a day
    expect(js).not.toMatch(/new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/);
  });

  it('no page or session of this round tells a person to type a date format', () => {
    for (const f of ['promotion-funding-session.ts', 'b2b-desk-session.ts', 'demand-events-session.ts', 'requisitions-session.ts', 'blanket-orders-session.ts', 'supplier-scorecard-session.ts']) expect(src(f), f).not.toMatch(/YYYY-MM-DD/);
    expect(web('promotion-funding.js')).toMatch(/const REQUIRED_FIELDS = \[(?:(?!'c-on-l')[^\]])*\];/); // the shared field says "(required)" itself
    expect(web('promotion-funding.html')).not.toContain('placeholder="2026-10-26"');
  });
});

describe('the rule bites: the round\'s starting commit fails it', () => {
  it('Product details, Requisitions and Shelves & space asked for typed ids, and the catalogue read a native date', () => {
    expect(before('apps/web-erp/web/product-details.js')).toMatch(TYPED_ID_LABEL);
    expect(before('apps/web-erp/src/requisitions-session.ts')).toMatch(TYPED_ID_LABEL);
    expect(before('apps/web-erp/web/merchandising.js')).toMatch(TYPED_ID_LABEL);
    expect(before('apps/web-erp/web/product-details.js')).not.toContain("pickable('product'");
    expect(before('apps/web-erp/web/catalogue.js')).toContain("const from = el('price-from').value.trim();");
    expect(before('apps/web-erp/src/promotion-funding-session.ts')).toMatch(/YYYY-MM-DD/);
  });
});
