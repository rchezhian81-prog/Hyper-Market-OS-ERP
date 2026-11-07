import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * **U1 · OB-698 — every stock, price and money action on the pages group B owns asks the shared consequence-and-confirm
 * sheet before it sends, and carries the sheet's words in English AND Tamil (design system §1.3, §27.1, §1 rule 6).**
 *
 * Static, so it holds without a browser: the page (or its session) names the title, the consequence, the authority and
 * the verb for its sheet in both languages, the title carries the figure's placeholder, and the click handler reaches
 * `sreOffice.confirm` through `confirmFirst` before the send. The rendered proof — the sheet opens with the real figure,
 * Go back sends nothing, Confirm sends once — is each page's browser test. Bites by construction: the audit's commit
 * (be62d0a) holds none of these words on any of these pages.
 */

const WEB = 'apps/web-erp/web';
const SRC = 'apps/web-erp/src';
const read = (p: string): string => readFileSync(p, 'utf8');
const tamil = /[஀-௿]/;

/** Where each page keeps its words, the keys of its sheet, and the placeholder its title must carry. */
const PAGES: readonly { page: string; words: string; keys: readonly string[]; placeholder: string }[] = [
  { page: 'transfers', words: `${SRC}/transfers-session.ts`, keys: ['confirmSendTitle', 'confirmSendDetail', 'confirmSendAuthority', 'confirmSendLabel', 'confirmUnavailable'], placeholder: '{lines}' },
  { page: 'recall-trace', words: `${WEB}/recall-trace.js`, keys: ['confirmTitle', 'confirmDetail', 'confirmAuthority', 'confirmLabel', 'confirmUnavailable'], placeholder: '{batch}' },
  { page: 'expiry', words: `${WEB}/expiry.js`, keys: ['confirmTitle', 'confirmDetail', 'confirmAuthority', 'confirmLabel', 'confirmUnavailable'], placeholder: '{batch}' },
  { page: 'production', words: `${SRC}/production-session.ts`, keys: ['confirmReleaseTitle', 'confirmReleaseDetail', 'confirmReleaseAuthority', 'confirmReleaseLabel', 'confirmUnavailable'], placeholder: '{qty}' },
  { page: 'held-returns', words: `${WEB}/held-returns.js`, keys: ['confirmWriteOffTitle', 'confirmWriteOffDetail', 'confirmReturnTitle', 'confirmReturnDetail', 'confirmAuthority', 'confirmWriteOffLabel', 'confirmReturnLabel', 'confirmUnavailable'], placeholder: '{qty}' },
  { page: 'demand-events', words: `${SRC}/demand-events-session.ts`, keys: ['confirmTitle', 'confirmDetail', 'confirmAuthority', 'confirmLabel', 'effectMore', 'effectLess', 'effectSame', 'confirmUnavailable'], placeholder: '{effect}' },
  { page: 'offer-results', words: `${WEB}/offer-results.js`, keys: ['confirmTitle', 'confirmDetail', 'confirmAuthority', 'confirmLabel', 'confirmUnavailable'], placeholder: '{name}' },
  { page: 'write-off-capture', words: `${SRC}/write-off-capture-session.ts`, keys: ['confirmTitle', 'confirmDetail', 'confirmAuthority', 'confirmLabel', 'confirmUnavailable'], placeholder: '{value}' },
  { page: 'write-off-queue', words: `${SRC}/write-off-queue-session.ts`, keys: ['confirmTitle', 'confirmDetail', 'confirmAuthority', 'confirmLabel', 'confirmUnavailable'], placeholder: '{qty}' },
  { page: 'count-plans', words: `${SRC}/count-plans-session.ts`, keys: ['confirmTitle', 'confirmDetail', 'confirmAuthority', 'confirmLabel', 'confirmUnavailable'], placeholder: '{loss}' },
  { page: 'supplier-bills', words: `${SRC}/supplier-advances-session.ts`, keys: ['confirmTitle', 'confirmDetail', 'confirmAuthority', 'confirmLabel', 'confirmUnavailable'], placeholder: '{amount}' },
  { page: 'goods-receipt', words: `${SRC}/goods-receipt-session.ts`, keys: ['confirmReturnTitle', 'confirmReturnDetail', 'confirmReturnAuthority', 'confirmReturnLabel', 'confirmUnavailable'], placeholder: '{line}' },
  { page: 'scrap', words: `${SRC}/scrap-session.ts`, keys: ['confirmTitle', 'confirmDetail', 'confirmAuthority', 'confirmLabel', 'confirmUnavailable'], placeholder: '{kg}' },
  { page: 'packaging', words: `${SRC}/packaging-session.ts`, keys: ['confirmTitle', 'confirmDetail', 'confirmAuthority', 'confirmLabel', 'confirmUnavailable'], placeholder: '{qty}' },
  { page: 'catalogue', words: `${WEB}/catalogue.js`, keys: ['confirmPriceTitle', 'confirmPriceFrom', 'confirmPriceDetail', 'confirmPriceAuthority', 'confirmPriceAuthorityApproved', 'confirmPriceLabel', 'confirmUnavailable'], placeholder: '{price}' },
];

/** Every `key: '…'` of a block, English then Tamil, by the order the two blocks appear in the file. */
function values(source: string, key: string): string[] {
  return [...source.matchAll(new RegExp(`\\b${key}:\\s*'((?:[^'\\\\]|\\\\.)*)'`, 'g'))].map((m) => m[1]!);
}

describe('U1 · OB-698: the stock, price and money actions carry their sheet\'s words in both languages', () => {
  for (const p of PAGES) {
    it(`${p.page}: title, consequence, authority and verb, English and Tamil, the title with ${p.placeholder}`, () => {
      const src = read(p.words);
      for (const key of p.keys) {
        const found = values(src, key);
        expect(found.length, `${p.page} names ${key} once in English and once in Tamil`).toBeGreaterThanOrEqual(2);
        expect(found[0], `${key} English`).not.toMatch(tamil);
        expect(found[1], `${key} Tamil`).toMatch(tamil);
        expect(found[0]!.length, `${key} says something`).toBeGreaterThan(3);
      }
      const titleKey = p.keys.find((k) => /Title$/.test(k))!;
      for (const v of values(src, titleKey).slice(0, 2)) expect(v, `${titleKey} carries the figure`).toContain(p.placeholder);
    });
  }

  it('every page reaches the shared sheet through confirmFirst, before its send, and says so when the sheet cannot open', () => {
    const pages = ['transfers', 'recall-trace', 'expiry', 'production', 'held-returns', 'demand-events', 'offer-results', 'write-off-capture', 'write-off-queue', 'count-plans', 'supplier-bills', 'goods-receipt', 'scrap', 'packaging', 'catalogue'];
    for (const page of pages) {
      const js = read(`${WEB}/${page}.js`);
      expect(js, `${page} defines confirmFirst`).toMatch(/async function confirmFirst\(spec\)/);
      expect(js, `${page} calls the chrome's sreOffice.confirm`).toMatch(/office\.confirm\(spec\)/);
      expect(js, `${page} refuses to send when the sheet cannot open`).toMatch(/'unavailable'/);
      expect(js, `${page} never asks through a browser dialog`).not.toMatch(/\bwindow\.confirm\(|(?<![.\w])confirm\(\s*['"`]/);
      const calls = js.match(/await confirmFirst\(/g) ?? [];
      expect(calls.length, `${page} asks before its action`).toBeGreaterThanOrEqual(1);
    }
  });

  it('the sheet carries a verb, never OK or Yes', () => {
    for (const p of PAGES) {
      const src = read(p.words);
      const labelKey = p.keys.find((k) => /Label$/.test(k))!;
      for (const v of values(src, labelKey).slice(0, 2)) expect(v.trim().toLowerCase(), `${p.page} ${labelKey}`).not.toMatch(/^(ok|yes|confirm|சரி|ஆம்)$/);
    }
  });

  it('G3: the page\'s one main action is marked primary and the rest are the foundation\'s buttons; no page paints a bare button in the accent', () => {
    const pages = ['transfers', 'recall-trace', 'expiry', 'production', 'held-returns', 'demand-events', 'offer-results', 'write-off-capture', 'count-plans', 'supplier-bills', 'goods-receipt', 'scrap', 'packaging', 'catalogue'];
    for (const page of pages) {
      const html = read(`${WEB}/${page}.html`);
      const css = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
      const painted = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => /^\s*button\s*$/.test(m[1]!) && /background[^;]*var\(--(accent|ok|good|info)\)/.test(m[2]!));
      expect(painted.map((m) => m[1]!.trim()), `${page} paints every bare button in the accent`).toEqual([]);
      const buttons = [...html.matchAll(/<button([^>]*)>/g)].map((m) => m[1]!).filter((a) => !/id="lang"|id="banner-ok"|id="tab-|class="[^"]*\blang\b/.test(a));
      const onFoundation = buttons.filter((a) => /\bsre-btn\b/.test(a));
      expect(onFoundation.length, `${page}: ${buttons.length - onFoundation.length} button(s) off the foundation`).toBe(buttons.length);
      expect(html.includes('sre-btn-primary') || read(`${WEB}/${page}.js`).includes('sre-btn-primary'), `${page} marks a primary action`).toBe(true);
    }
  });
});
