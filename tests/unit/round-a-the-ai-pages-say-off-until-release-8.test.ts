import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * **OB-561 (owner, 31 Oct 2026, decision 5 of the screen gap audit) — the AI pages say plainly, in English and Tamil, that
 * the assistants are off until Release 8 (OB-382), instead of only a technical reason.**
 *
 * Round B (#852) named the technical reason ("no model pricing is set" instead of "switched off or out of budget"). That is
 * still true, but it is not why: the owner decided live AI stays off until Release 8. So each of the three AI pages —
 * Assistant drafts, Customer cases (its "ask the assistant" part) and AI control — now:
 *   • carries the plain sentence at the top, in its HTML (so it is there before any script runs) and in both languages in
 *     its words (so the language toggle repaints it);
 *   • on a refused draft (503 / 429) leads with that sentence and then gives head office's technical reason — Round B's
 *     wording is kept, after it, never replaced.
 * The browser test `round-a-office-pages-through-the-store-computer.e2e.ts` shows it on the served pages.
 */
const read = (f: string): string => readFileSync(`apps/web-erp/web/${f}`, 'utf8');
const TAMIL = /[஀-௿]/;
/** The `offUntilR8: '…'` lines of a page's WORDS, English first then Tamil. */
const wordsOf = (js: string): string[] => [...js.matchAll(/offUntilR8: '([^']+)'/g)].map((m) => m[1]!);

describe.each([
  { page: 'ai-drafts', tail: /do this work yourself/ },
  { page: 'service-desk', tail: /write the reply yourself/ },
  { page: 'ai', tail: /rule-based assistants/ },
])('the $page page says the assistants are off until Release 8', ({ page, tail }) => {
  const js = read(`${page}.js`);
  const html = read(`${page}.html`);

  it('has the sentence in English and in Tamil, naming Release 8 and the owner\'s decision', () => {
    const [en, ta] = wordsOf(js);
    expect(en).toMatch(/off until Release 8/);
    expect(en).toMatch(/the owner decided this on 31 October 2026/);
    expect(en).toMatch(tail);
    expect(ta).toMatch(TAMIL);
    expect(ta).toMatch(/வெளியீடு 8 வரை/);
    expect(ta).toMatch(/உரிமையாளர் எடுத்த முடிவு/);
  });

  it('shows it at the top of the page before any script runs, and repaints it in the reader\'s language', () => {
    const [en] = wordsOf(js);
    expect(html).toContain(`<p class="off-r8" id="off-r8" role="note">${en}</p>`);
    expect(js).toContain("['off-r8', 'offUntilR8']");
  });
});

describe('a refused draft leads with the plain reason, then the technical one (Round B kept)', () => {
  it('Assistant drafts: "off until Release 8" then "no model pricing" / "switched off or out of budget"', () => {
    const js = read('ai-drafts.js');
    expect(js).toContain("const notRunWords = (out) => `${t('offUntilR8')} ${out.body?.error?.code === 'no_pricing' ? t('noPricing') : t('stopped')}`;");
    expect(js).toMatch(/noPricing: 'The assistant cannot run: no model pricing is set/);
  });

  it('Customer cases: the same, on asking for a reply', () => {
    const js = read('service-desk.js');
    expect(js).toContain("el.textContent = `${t('offUntilR8')} ${out.body?.error?.code === 'no_pricing' ? t('noPricing') : t('stopped')}`;");
    expect(js).toMatch(/noPricing: 'The assistant cannot run: no model pricing is set for this shop yet — write the reply yourself\.'/);
  });
});
