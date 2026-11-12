import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { beforeFixture } from '../support/before-fixture';

/**
 * **A shop person picks a thing by its NAME, never types its code; a date reads dd/mm/yyyy; an id is shown as a name
 * (U2 · UI/UX gap audit G5 · G14 · G16 · P-07 · NFR-08).**
 *
 * The picker, the pick field, the date field, `nameOf`, `me` and the three-part refusal words live in the one chrome every
 * office page loads (precached: the pack's people and places are there with head office down, P-01). This pins the
 * decisions that are easy to undo by accident: the exports, the sheet as a real dialog with Escape as the way out, the
 * typed-code fallback so a list that cannot be read is never a dead end, no browser dialog anywhere, the refusal words
 * having ONE source (`refusal-words.ts` through the bundle, never a copy in the chrome that could drift), and the ten
 * pages the audit called HARD no longer asking for an id or a code to be typed. The rendered behaviour is proven in
 * tests/e2e/u2-the-picker-finds-a-thing-by-its-name.e2e.ts.
 */

const CHROME = readFileSync('apps/web-erp/web/sre-chrome.js', 'utf8');
const FOUNDATION = readFileSync('packages/ui/web/sre-foundation.css', 'utf8');
const ENTRY = readFileSync('apps/web-erp/src/browser-entry.ts', 'utf8');
const DIRECTORY = readFileSync('edge/store-edge/src/screen-directory.ts', 'utf8');
const SERVER = readFileSync('edge/store-edge/src/screen-server.ts', 'utf8');
const code = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

describe('the chrome carries the picker and the date field', () => {
  it('exports pick, pickField, pickedValue, setPicked, dateField, dateValue, dateWords, nameOf, me and refusalWords on sreOffice', () => {
    for (const name of ['pick: officePick', 'pickField: officePickField', 'pickedValue', 'setPicked', 'dateField: officeDateField', 'dateValue', 'dateWords', 'nameOf', 'me', 'refusalWords: officeRefusalWords']) {
      expect(CHROME, name).toContain(name);
    }
    expect(CHROME).toMatch(/window\.sreOffice = Object\.freeze\(\{[\s\S]*pick: officePick[\s\S]*\}\);/);
  });

  it('the picker is a real dialog: the search box takes the focus, Escape is the way out, rows are buttons, and a list that cannot be read offers "type the code instead"', () => {
    expect(CHROME).toContain("sheet.className = 'sre-sheet sre-picker'");
    expect(CHROME).toContain("sheet.setAttribute('role', 'dialog')");
    expect(CHROME).toMatch(/search\.focus\(\);/);
    expect(CHROME).toMatch(/if \(e\.key === 'Escape'\) \{ e\.preventDefault\(\); finish\(\{ ok: false \}\);/);
    expect(CHROME).toContain("b.className = 'sre-picker-row'");
    expect(CHROME).toContain("codeWrap.hidden = !spec.allowCode;");
    expect(CHROME).toContain("typed: true");
    // the lists: the pack's people and places first (offline), head office's own routes for the rest, in the person's session
    expect(CHROME).toContain("if (d && d.known && d.known.people) return { state: 'ok', rows: d.people.map(");
    expect(CHROME).toContain("product: '/v1/catalogue/products', supplier: '/v1/purchase/suppliers', customer: '/v1/customer/overview', approval: '/v1/approvals/requests'");
    expect(CHROME).toContain("credentials: 'same-origin'");
    expect(CHROME).toMatch(/if \(res\.status === 401 \|\| res\.status === 403\) return \{ state: 'denied' \};/);
    // rows are 44px targets in the foundation
    expect(FOUNDATION).toMatch(/\.sre-picker-row \{[^}]*min-height: var\(--tap\)/);
    expect(FOUNDATION).toMatch(/\.sre-pick-row \.sre-btn \{ min-height: var\(--tap\); \}/);
  });

  it('the date field reads day/month/year and refuses a day that does not exist; dateWords knows the Tamil months', () => {
    // U5: the placeholder is a word of the chrome's, so it follows the toggle like the hint and "(required)" (NFR-08)
    expect(CHROME).toContain("control.placeholder = ow('datePlaceholder');");
    expect(CHROME).toContain("datePlaceholder: 'dd/mm/yyyy'");
    expect(CHROME).toMatch(/if \(mo < 1 \|\| mo > 12 \|\| d < 1 \|\| d > daysIn\(y, mo\)/);
    expect(CHROME).toMatch(/const TA_MONTHS = \['ஜன', 'பிப்'/);
    for (const key of ['dateHint', 'datePlaceholder', 'dateBad', 'dateTooEarly', 'dateTooLate', 'typeCodeInstead', 'useThisCode', 'choose', 'nothingChosen', 'pickSearch', 'pickCount', 'pickMore']) {
      const en = CHROME.slice(CHROME.indexOf('  const OFFICE_WORDS = {'), CHROME.indexOf('    ta: {', CHROME.indexOf('  const OFFICE_WORDS = {')));
      const ta = CHROME.slice(CHROME.indexOf('    ta: {', CHROME.indexOf('  const OFFICE_WORDS = {')), CHROME.indexOf('  const ow = (key)'));
      expect(en, `no English for ${key}`).toMatch(new RegExp(`\\b${key}: '`));
      expect(ta, `no Tamil for ${key}`).toMatch(new RegExp(`\\b${key}: '`));
    }
  });

  it('the store computer injects the directory from the signed pack on every office page, and the chrome reads it — never a guess', () => {
    expect(SERVER).toContain("sreDirectory: directoryPayload(snap.pack, signedIn)");
    expect(DIRECTORY).toMatch(/known: \{ people: pack\.people\.known/);
    expect(CHROME).toContain("const directory = () => (window.sreDirectory && typeof window.sreDirectory === 'object' ? window.sreDirectory : null);");
    // a name the pack does not hold falls back to the id, never to a blank or a made-up name
    expect(CHROME).toMatch(/return cached \? cached\.name : key;/);
  });

  it('the refusal words have one source: the bundle exposes refusal-words.ts and the chrome delegates to it — no copied tables', () => {
    expect(ENTRY).toMatch(/import \{ refusalWords as refusalWordsOf[^}]*\} from '\.\/refusal-words'/);
    expect(ENTRY).toContain("sreRefusalWords = Object.freeze({ refusalWords: refusalWordsOf");
    expect(CHROME).toContain("if (words && typeof words.refusalWords === 'function') return words.refusalWords(lang(), out ?? {});");
    // the cause table lives in refusal-words.ts only
    expect(code(CHROME)).not.toContain("permission_denied: 'no_permission'");
  });

  it('never asks anything through the browser', () => {
    expect([...code(CHROME).matchAll(/(?<![.\w])(prompt|confirm|alert)\s*\(/g)].map((m) => m[1])).toEqual([]);
  });

  /**
   * The ten pages the audit called HARD because a person had to type an id or a code (G5). Once a page takes the thing
   * by its name, its label no longer says "id" or "code" to be typed. This part goes green as the other U2 builders
   * finish each page; it bites on the audit commit by construction (the next test).
   */
  const HARD_PAGES = ['buying', 'count-plans', 'packaging', 'demand-events', 'scrap', 'write-off-capture', 'store-tasks', 'delegation', 'quotations', 'service-desk'];
  // a label or a word pair that tells a person to TYPE an id or a code: "<label>Product id</label>", "Place (location id)",
  // "Products to count (ids, one per line…)", "Supplier code", "Approval id"
  const TYPED_ID_LABEL = /<label[^>]*>[^<]*\b(?:id|ids|code|codes)\b[^<]*<\/label>|'[A-Z][A-Za-z ,/-]*\([^)'\n]*\b(?:id|ids|code|codes)\b[^)'\n]*\)[^'\n]*'|'[A-Za-z ]*\b(?:product|supplier|store|branch|location|staff|employee|person|customer|item|approval|case|scheme)\s+(?:id|ids|code|codes|number)\b[^'\n]*'/i;
  const typedIdLabels = (html: string, js: string): string[] => [...`${html}\n${js}`.matchAll(new RegExp(TYPED_ID_LABEL.source, 'gi'))].map((m) => m[0].replace(/\s+/g, ' ').slice(0, 80));

  it('the ten HARD pages no longer label a field as an id or a code to be typed', () => {
    const left: string[] = [];
    for (const page of HARD_PAGES) {
      const html = readFileSync(`apps/web-erp/web/${page}.html`, 'utf8');
      const js = readFileSync(`apps/web-erp/web/${page}.js`, 'utf8');
      const session = existsSync(`apps/web-erp/src/${page}-session.ts`) ? readFileSync(`apps/web-erp/src/${page}-session.ts`, 'utf8') : '';
      for (const hit of typedIdLabels(html, `${js}\n${session}`)) left.push(`${page}: ${hit}`);
    }
    expect(left).toEqual([]);
  });

  it('bites: the pages as the audit found them (commit be62d0a) asked for ids and codes by name', () => {
    const html = beforeFixture('be62d0a', 'apps/web-erp/web/count-plans.html');
    const js = beforeFixture('be62d0a', 'apps/web-erp/web/count-plans.js');
    const session = beforeFixture('be62d0a', 'apps/web-erp/src/count-plans-session.ts');
    expect(typedIdLabels(html, `${js}\n${session}`).length).toBeGreaterThan(0);
  });
});
