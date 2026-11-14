import { readFileSync } from 'node:fs';
import { expect } from 'vitest';

/**
 * The picker and date-field rules of U2/U2b, proven wherever they now live.
 *
 * U2 and U2b put each typed-id field on the chrome's picker through a few page-side lines (`pickerBeside`, `pickable`,
 * `dateable`, `shopDate`), and their tests pinned those lines on every page. Round U5 (Group C, 7 Nov 2026) folded the
 * same lines into the chrome ONCE — `sreOffice.pickable` and `sreOffice.shopDate` — and the pages now hand their field to
 * it. A pin on the page alone would no longer see the rules; a pin on the chrome alone would not see that a page uses
 * it. So a page passes when it puts the field on the picker by either route, and when it hands the field to the chrome,
 * the chrome's one copy must hold every rule the page-side copy held: the picked id lands in the SAME field the page
 * sends, the typed code stays the fallback (`allowCode` on unless a page turns it off — none may), the name is shown
 * beside it, the "Choose…" button is a 44px foundation button with a spoken name, and its words follow the toggle.
 */

const CHROME = (): string => readFileSync('apps/web-erp/web/sre-chrome.js', 'utf8');

const block = (src: string, start: string): string => {
  const at = src.indexOf(start);
  expect(at, `the chrome holds ${start}`).toBeGreaterThan(-1);
  const end = src.indexOf('\n  }\n', at);
  return src.slice(at, end === -1 ? at + 4000 : end);
};

/** The chrome's `sreOffice.pickable` keeps every rule the page-side picker lines kept. */
export function expectChromePickableKeepsTheRules(): void {
  const chrome = CHROME();
  expect(chrome).toMatch(/pickable: officePickable/);
  const f = block(chrome, 'function officePickable(');
  expect(f, 'the typed code stays the fallback').toContain('allowCode: extra.allowCode !== false');
  expect(f, 'the picked id lands in the field the page sends').toMatch(/else input\.value = id;/);
  expect(f, 'the name is shown beside the field').toContain("name.textContent = typeof picked.name === 'string' && picked.name !== id ? picked.name : '';");
  expect(f, 'a typed code clears the stale name').toContain("input.addEventListener('input', () => { name.textContent = ''; });");
  expect(f, 'Choose… is a 44px foundation button').toContain("btn.className = 'sre-btn sre-btn-quiet sre-pick-button'");
  expect(f, 'with a name a screen reader says').toContain("btn.setAttribute('aria-label'");
  expect(f, 'its words follow the language toggle').toContain('adapterRepaints.add(paint);');
}

/** The chrome's `sreOffice.shopDate` puts the shared dd/mm/yyyy field on the page's own date box, keeping its id. */
export function expectChromeShopDateKeepsTheRules(): void {
  const chrome = CHROME();
  expect(chrome).toMatch(/shopDate: officeShopDate/);
  const f = block(chrome, 'function officeShopDate(');
  expect(f, 'the shared field, same id').toContain('officeDateField({ id, label');
  expect(f, 'a value already there is carried over').toContain('parseShopDate(typed)');
  expect(f, 'the label follows the toggle').toContain('adapterRepaints.add(paint);');
  expect(chrome, 'the page reads ISO back').toMatch(/dateOf: dateValue/);
}

/** True when the page hands its fields to the chrome's adapters rather than carrying its own copy. */
export const usesChromePickable = (js: string): boolean => /\.pickable\(/.test(js);
export const usesChromeShopDate = (js: string): boolean => /\.shopDate\(/.test(js);

/** A page that hands fields to the chrome never switches the typed-code fallback off. */
export function expectNoFallbackSwitchedOff(js: string, file: string): void {
  expect(js, `${file} turns the typed-code fallback off`).not.toMatch(/allowCode: false/);
}
