import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startOfficeShop, PEOPLE, type OfficeShop } from './lib/office-shop';

/**
 * **Round U3 of the UI/UX gap audit (OB-699, decision 1 = B): the PRODUCT's own words are in Tamil on the Tamil screen —
 * lanes 1 and 2 of the audit (products, buying, receiving, inventory, warehouse, waste, delivery exceptions).**
 *
 * The audit's sweep (1 Nov 2026, G2) found English fragments on 56 of 126 office pages after the Tamil toggle. Under
 * OB-699 every word the PAGE itself prints — labels, hints, captions, button words, state words, "Not known" reasons,
 * chip labels, column headings — is carried in both languages; a product word head office or the store computer sends
 * (a note, a figure's reason, a question) is shown in the page's language; only a FINDING head office wrote about the
 * shop's own data stays in English, and the page says so once.
 *
 * Each page below is opened on the REAL store computer fed by the REAL head office, as the role the audit opened it as,
 * switched to Tamil, and every visible text node is read: a run of two or more English words that is not a name, an id, a
 * code, an acronym or a listed finding is a failure, named with where it sits. Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DESK = { viewport: { width: 1280, height: 860 } };

const PAGES: { readonly id: string; readonly path: string; readonly who: string }[] = [
  { id: 'approval-requests', path: '/approvals', who: PEOPLE.cashier },
  { id: 'ai-drafts', path: '/ai-drafts', who: PEOPLE.manager },
  { id: 'operations', path: '/operations', who: PEOPLE.manager },
  { id: 'products', path: '/products', who: PEOPLE.cashier },
  { id: 'pricing', path: '/pricing', who: PEOPLE.manager },
  { id: 'promotions', path: '/promotions', who: PEOPLE.manager },
  { id: 'category-policy', path: '/category-policy', who: PEOPLE.cashier },
  { id: 'product-publish-review', path: '/product-publish-review', who: PEOPLE.owner },
  { id: 'product-details', path: '/product-details', who: PEOPLE.cashier },
  { id: 'product-categories', path: '/product-categories', who: PEOPLE.cashier },
  { id: 'product-merges', path: '/product-merges', who: PEOPLE.cashier },
  { id: 'tax-rates', path: '/tax-rates', who: PEOPLE.cashier },
  { id: 'price-integrity', path: '/price-integrity', who: PEOPLE.manager },
  { id: 'product-content', path: '/product-content', who: PEOPLE.cashier },
  { id: 'data-quality', path: '/data-quality', who: PEOPLE.manager },
  { id: 'offer-results', path: '/offer-results', who: PEOPLE.manager },
  { id: 'shelf-tags', path: '/shelf-tags', who: PEOPLE.cashier },
  { id: 'buying', path: '/buying/', who: PEOPLE.accountant },
  { id: 'requisitions', path: '/requisitions', who: PEOPLE.accountant },
  { id: 'suppliers', path: '/suppliers', who: PEOPLE.accountant },
  { id: 'supplier-scorecard', path: '/supplier-scorecard', who: PEOPLE.accountant },
  { id: 'supplier-submissions', path: '/supplier-submissions', who: PEOPLE.manager },
  { id: 'rebates', path: '/rebates', who: PEOPLE.accountant },
  { id: 'blanket-orders', path: '/blanket-orders', who: PEOPLE.accountant },
  { id: 'goods-receipt', path: '/goods-receipt', who: PEOPLE.accountant },
  { id: 'dock-diary', path: '/dock-diary', who: PEOPLE.manager },
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
  { id: 'dispatch', path: '/dispatch', who: PEOPLE.manager },
  { id: 'order-refunds', path: '/order-refunds', who: PEOPLE.manager },
  { id: 'substitution-exceptions', path: '/substitution-exceptions', who: PEOPLE.manager },
  { id: 'epr', path: '/epr', who: PEOPLE.manager },
  { id: 'gates', path: '/gates', who: PEOPLE.manager },
  { id: 'related-parties', path: '/related-parties', who: PEOPLE.accountant },
  { id: 'risk-acceptance', path: '/risk-acceptance', who: PEOPLE.manager },
];

/**
 * Words that are not the product's own: the shop's and people's names and ids from the harness seed, product names,
 * codes, acronyms a Tamil reader also uses, and the language toggle's own word. A role NAME ("Store manager") comes from
 * head office's role catalogue (Group T1 carries it in both languages this round) and is allowed here on purpose.
 */
const NOT_WORDS = [
  'SRE Hyper Market', 'SRE Retail', 'Hyper Market', 'Toned milk 500 ml', 'English',
  'Store manager', 'Owner', 'Cashier', 'Accountant', 'Platform administrator', 'Security reviewer', 'Internal Committee member',
  // a time format, and the quality gates' recorded verdict words (the record's own values, shown as recorded)
  'HH:MM', 'GO, HOLD', 'REWORK', 'GO', 'HOLD',
];
const TOKEN = /\b(?:GST|GSTR|GSTIN|UPI|MRP|HSN|EPR|CPCB|B2B|BIS|FSSAI|ITC|PAN|QR|PIN|ID|OK|AI|CCTV|SKU|PO|GRN|ASN|RFQ|RTO|COD|DLQ|API|CA|ESS|POSH|CERT-In|NA|OB-\d+|A\d{2}|M-\d{3}|[A-Z]{1,3}-?\d+|[up]-[a-z0-9-]+|S1|C1|br-\d|lane-\d|[a-z0-9]+-[a-z0-9-]+|\d[\d.,:/-]*|\d+\s?(?:ml|kg|g|l|pcs?))\b/g;
const ENGLISH_RUN = /[A-Za-z][A-Za-z'’]+(?:[\s,;:()/'’-]+[A-Za-z][A-Za-z'’]+)+/;

interface Fragment { readonly where: string; readonly text: string }

/** Every visible text node of the page as rendered, with the element it sits in. */
const visibleTexts = (page: Page): Promise<Fragment[]> => page.evaluate(`(() => {
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const isShown = (el) => { if (!el) return false; const s = getComputedStyle(el); if (s.display === 'none' || s.visibility === 'hidden') return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  let n;
  while ((n = walker.nextNode())) {
    const text = (n.nodeValue || '').replace(/\\s+/g, ' ').trim();
    if (text === '') continue;
    const el = n.parentElement;
    if (!el) continue;
    if (el.closest('script,style,noscript,template,[aria-hidden="true"],[hidden]')) continue;
    if (!isShown(el)) continue;
    const id = el.id ? '#' + el.id : '';
    const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
    out.push({ where: el.tagName.toLowerCase() + id + cls, text });
  }
  return out;
})()`) as Promise<Fragment[]>;

/** The English runs a Tamil reader would meet, after the names, ids, codes and acronyms are set aside. */
export function englishLeftIn(fragments: readonly Fragment[], allowed: readonly string[] = []): Fragment[] {
  const found: Fragment[] = [];
  for (const f of fragments) {
    let text = f.text;
    for (const w of [...NOT_WORDS, ...allowed]) text = text.split(w).join(' ');
    text = text.replace(TOKEN, ' ');
    const m = ENGLISH_RUN.exec(text);
    if (m !== null) found.push({ where: f.where, text: f.text });
  }
  return found;
}

const OUT = '/tmp/claude-0/-home-user-Hyper-Market-OS-ERP/f0035d2b-5c09-50ed-bcac-13d7de201707/scratchpad/u356/t2-sweep';

describe.skipIf(!existsSync(CHROMIUM))('U3 (OB-699): lanes 1 and 2 — the product\'s own words are Tamil after the toggle', () => {
  let browser: Browser;
  let shop: OfficeShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    shop = await startOfficeShop(browser);
    mkdirSync(OUT, { recursive: true });
  }, 300_000);
  afterAll(async () => { await shop?.stop(); await browser?.close(); });

  for (const p of PAGES) {
    it(`${p.id}: no English the page itself wrote is left on the Tamil screen`, async () => {
      const s = await shop.asPerson(p.who, DESK as never);
      try {
        await s.page.goto(`${shop.base}${p.path}`, { waitUntil: 'load' });
        await s.page.waitForFunction('globalThis.sreChrome !== undefined');
        await s.page.waitForLoadState('networkidle').catch(() => {});
        await s.page.waitForTimeout(400);
        await s.page.click('#lang');
        await s.page.waitForTimeout(400);
        expect(await s.page.getAttribute('html', 'lang')).toBe('ta');
        const left = englishLeftIn(await visibleTexts(s.page));
        writeFileSync(`${OUT}/${p.id}.json`, JSON.stringify(left, null, 1));
        expect(left.map((f) => `${f.where}: ${f.text}`), `${p.id}: English left on the Tamil screen`).toEqual([]);
        expect(s.errors).toEqual([]);
      } finally { await s.context.close(); }
    }, 120_000);
  }
});
