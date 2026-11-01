import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * **The static pages switch language like every other screen (U0 · G20 of the UI/UX gap audit, 1 Nov 2026 · design
 * system §1 rule 6 · NFR-08).** The concession tag page and the customer sign-in printed both languages at once with no
 * toggle. Now each word is in the page in both languages (`<span lang="en">` beside `<span lang="ta">`), the stylesheet
 * shows one language at a time, the `#lang` button switches `<html lang>` and the choice is remembered on the device,
 * and every sentence the script writes carries both languages.
 *
 * The public site's home and subscribe pages are English marketing copy with a few Tamil lines marked per block; a toggle
 * there needs the whole copy in Tamil (U3, owner decision 1 of the audit) and is deliberately not claimed here.
 */

const PAGES = [
  { html: 'apps/pos/web/concession-tag.html', js: 'apps/pos/web/concession-tag.js' },
  { html: 'apps/customer-app/web/login.html', js: 'apps/customer-app/web/login.js' },
];

describe('the concession tag page and the customer sign-in switch language', () => {
  for (const p of PAGES) {
    const html = readFileSync(p.html, 'utf8');
    const js = readFileSync(p.js, 'utf8');

    it(`${p.html}: a #lang toggle, one language shown at a time, English by default`, () => {
      expect(html).toMatch(/<html lang="en">/);
      expect(html).toMatch(/<button id="lang" type="button"[^>]*aria-label="Language"/);
      expect(html).toMatch(/html:not\(\[lang="ta"\]\) \[lang="ta"\], html\[lang="ta"\] \[lang="en"\] \{ display: none; \}/);
    });

    it(`${p.html}: every Tamil span has its English twin beside it — nothing is one language only`, () => {
      const ta = (html.match(/<span lang="ta">/g) ?? []).length;
      const en = (html.match(/<span lang="en">/g) ?? []).length;
      expect(ta).toBeGreaterThan(5);
      expect(en, 'as many English spans as Tamil ones').toBe(ta);
      // no Tamil span still carries the old "/ " separator from the both-at-once layout
      expect(html).not.toMatch(/<span lang="ta">\/ /);
    });

    it(`${p.js}: the toggle sets <html lang>, remembers the choice, and every scripted sentence carries both languages`, () => {
      expect(js).toMatch(/localStorage\.setItem\(LANG_KEY, next\)/);
      expect(js).toMatch(/document\.documentElement\.lang = remembered\(\)/);
      // a status written as a bare English string would show English on the Tamil screen
      for (const line of js.split('\n').filter((l) => /setStatus\('|setResult\('/.test(l))) expect(line.trim(), line).toMatch(/^setResult\(''\);$/);
      expect(js).not.toMatch(/' \/ [஀-௿]/);
    });
  }
});
