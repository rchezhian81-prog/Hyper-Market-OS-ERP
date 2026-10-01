import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * **The ERP's forty-seven pages are one product (Stage G slice 5a · design system §1 rules 4 · 6 · 7, §5, §7; the
 * forty-seventh, Suppliers, arrived at SP-7d).**
 *
 * Before this slice one page in forty-six had a sync badge, the language toggle carried two different labels,
 * every page drew its own "served from cache" strip, and forty-four had no heading. Now `sre-chrome.js` is the one
 * badge, strip and toggle, loaded after each page's own script; the foundation's `h1.who` is the one heading; and
 * every word a page shows has a Tamil twin. This file keeps all of that true for a forty-seventh page too.
 */

const WEB = 'apps/web-erp/web';
const PAGES = readdirSync(WEB).filter((f) => f.endsWith('.html')).sort();
const SCRIPTS = readdirSync(WEB).filter((f) => f.endsWith('.js') && !f.endsWith('.bundle.js') && !['sw.js', 'sre-chrome.js'].includes(f)).sort();
const read = (f: string): string => readFileSync(join(WEB, f), 'utf8');
const CHROME = read('sre-chrome.js');
const SW = read('sw.js');
const styleOf = (html: string): string => html.slice(html.indexOf('<style>'), html.indexOf('</style>')).replace(/\/\*[\s\S]*?\*\//g, '');
const code = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

describe('every page carries the one chrome', () => {
  it('finds the forty-nine pages', () => {
    expect(PAGES.length).toBe(49);
  });

  it('loads sre-chrome.js AFTER its own script, so the page\'s words come first and the chrome finishes the frame', () => {
    for (const page of PAGES) {
      const html = read(page);
      const chrome = html.lastIndexOf('<script type="module" src="./sre-chrome.js"></script>');
      expect(chrome, `${page} does not load the chrome`).toBeGreaterThan(-1);
      const own = [...html.matchAll(/<script (?:type="module" src="\.\/(?!sre-chrome)[^"]+"|src="\.\/(?!sre-chrome)[^"]+" type="module")><\/script>/g)];
      expect(own.length, `${page} has no script of its own`).toBeGreaterThan(0);
      for (const m of own) expect(m.index!, `${page} loads the chrome before ${m[0]}`).toBeLessThan(chrome);
    }
  });

  it('the service worker precaches the chrome with the shell, so a cached page keeps its badge and strip', () => {
    expect(SW).toMatch(/const SHELL = \[[^\]]*'\.\/sre-chrome\.js'/);
  });

  it('has exactly one h1 — the header line, styled as the line it is by the foundation', () => {
    for (const page of PAGES) {
      const html = read(page);
      expect((html.match(/<h1\b/g) ?? []).length, `${page} h1 count`).toBe(1);
    }
    expect(readFileSync('packages/ui/web/sre-foundation.css', 'utf8')).toMatch(/h1\.who \{ margin:0; font-size:17px; \}/);
  });

  it('keeps no language-toggle override, no 40px control, no red strip, and no white words on the signal red', () => {
    for (const page of PAGES) {
      const style = styleOf(read(page));
      expect(style, `${page} overrides .lang`).not.toMatch(/\.lang\s*\{/);
      expect(style, `${page} keeps a 40px control`).not.toMatch(/min-height:\s*40px/);
      expect(style, `${page} paints the nobody strip red`).not.toMatch(/\.nobody\s*\{[^}]*var\(--danger\)/);
      expect(style, `${page} writes white on the signal red`).not.toMatch(/background:\s*var\(--danger\);\s*color:\s*#fff/);
    }
  });

  it('draws the strip and the badge ONCE — no page keeps its own copy', () => {
    for (const script of SCRIPTS) {
      const src = code(read(script));
      expect(src, `${script} still draws its own cache strip`).not.toMatch(/function paintStale/);
      expect(src, `${script} still carries its own strip words`).not.toMatch(/staleShell/);
      expect(src, `${script} still polls the sync status itself`).not.toMatch(/lane\/sync-status/);
    }
  });
});

describe('the chrome itself', () => {
  it('asks the store computer at the address the page was served from — never a guessed one — read-only and bounded', () => {
    expect(CHROME).toMatch(/typeof window\.laneWriteBase === 'string' \? window\.laneWriteBase : null/);
    expect(CHROME).not.toMatch(/127\.0\.0\.1|localhost|:8090/);
    expect(CHROME).toMatch(/fetch\(`\$\{base\}\/lane\/sync-status`, \{ cache: 'no-store', signal: ctl\.signal \}\)/);
    expect(CHROME).toMatch(/setTimeout\(\(\) => ctl\.abort\(\), 3000\)/);
    expect(CHROME).not.toMatch(/method: 'POST'/);
  });

  it('has a word in both languages for every state it can show, and every word it names is shown', () => {
    const en = CHROME.slice(CHROME.indexOf('    en: {'), CHROME.indexOf('    ta: {'));
    const ta = CHROME.slice(CHROME.indexOf('    ta: {'), CHROME.indexOf('  };'));
    const keys = [...en.matchAll(/(\w+): '/g)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThanOrEqual(11);
    for (const key of keys) {
      expect(ta, `no Tamil for ${key}`).toMatch(new RegExp(`\\b${key}: '`));
      expect(CHROME, `${key} is never shown`).toContain(`t('${key}')`);
    }
  });

  it('repaints when the page changes the language, however it changes it', () => {
    expect(CHROME).toMatch(/new MutationObserver\(repaint\)\.observe\(document\.documentElement, \{ attributes: true, attributeFilter: \['lang'\] \}\)/);
  });

  it('lets a page keep sharper strip wording on the element — and the manager does, about closing the day', () => {
    expect(CHROME).toMatch(/strip\.dataset\[lang\(\)\]/);
    const manager = read('index.html');
    expect(manager).toMatch(/id="stale" hidden role="status" data-en="[^"]*do not close the day on it[^"]*" data-ta="[^"]+"/);
  });

  it('says the time in the reader\'s own local time', () => {
    expect(CHROME).toMatch(/new Date\(at\)\.toLocaleString\(\)/);
  });
});

describe('the one menu (Stage G slice 5b · §27 role surfaces · P-07 · P-04)', () => {
  it('is drawn ONLY from what the store computer injected — the chrome hard-codes no path and no screen name', () => {
    expect(CHROME).toMatch(/window\.sreNavigation && typeof window\.sreNavigation === 'object'/);
    expect(CHROME).not.toMatch(/href\s*=\s*['"`]\//);
    expect(CHROME).not.toMatch(/['"`]\/(?:manager|counts|catalogue|admin|finance|reporting|buying)\//);
    expect(CHROME).toMatch(/link\.href = item\.path/);
  });

  it('draws nothing when the page was opened off the box, and the stated reason when the box could offer nothing', () => {
    expect(CHROME).toMatch(/const nav = navigation\(\);\n\s+if \(!nav\) return;/);
    expect(CHROME).toMatch(/nav\.why === 'no_roles' \? t\('noRoles'\) : t\('noUser'\)/);
  });

  it('is a real menu: a button that says what it opens, a nav landmark named differently from the in-page tabs, Escape to close, focus returned', () => {
    expect(CHROME).toMatch(/button\.setAttribute\('aria-expanded', 'false'\)/);
    expect(CHROME).toMatch(/button\.setAttribute\('aria-controls', 'sre-menu'\)/);
    expect(CHROME).toMatch(/document\.createElement\('nav'\)/);
    expect(CHROME).toMatch(/panel\.setAttribute\('aria-label', t\('screens'\)\)/);
    expect(CHROME).not.toMatch(/'Sections'/); // the in-page tabs' label; two landmarks with one name would be a lie
    expect(CHROME).toMatch(/event\.key === 'Escape'/);
    expect(CHROME).toMatch(/button\.focus\(\)/);
    expect(CHROME).toMatch(/link\.setAttribute\('aria-current', 'page'\)/);
  });

  it('opens the tab a menu link asked for, on a page that has it, without fighting a page that already did', () => {
    expect(CHROME).toMatch(/new URLSearchParams\(window\.location\.search\)\.get\('tab'\)/);
    expect(CHROME).toMatch(/byId\(`tab-\$\{wanted\}`\)/);
    expect(CHROME).toMatch(/tab\.getAttribute\('aria-current'\) !== 'page'\) tab\.click\(\)/);
  });

  it('no page draws a cross-page link of its own — the menu is the one way between screens', () => {
    for (const page of PAGES) {
      expect(read(page), `${page} links to another page itself`).not.toMatch(/href="(?:\.\/[a-z-]+\.html|\/[a-z])/);
    }
    for (const script of SCRIPTS) {
      expect(code(read(script)), `${script} builds a cross-page link itself`).not.toMatch(/\.href = ['"`]\.?\/[a-z-]+(?:\.html|\/)/);
    }
  });

  it('the foundation styles the menu at the touch target, and the copies agree', () => {
    const css = readFileSync('packages/ui/web/sre-foundation.css', 'utf8');
    expect(css).toMatch(/\.sre-menu-button \{ min-height: var\(--tap\); min-width: var\(--tap\);/);
    expect(css).toMatch(/\.sre-menu a \{ display: flex; align-items: center; min-height: var\(--tap\);/);
    expect(css).toMatch(/\.sre-menu a\[aria-current="page"\]/);
    expect(read('sre-foundation.css')).toBe(css);
  });
});

/** Every `en: {` block in a source, paired with the `ta: {` block that follows it, as key lists. */
function bilingualBlocks(source: string): { en: string[]; ta: string[]; at: number }[] {
  const blocks: { en: string[]; ta: string[]; at: number }[] = [];
  const grab = (from: number): { keys: string[]; end: number } => {
    let depth = 0; let i = from;
    for (; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') { depth--; if (depth === 0) break; }
    }
    const body = source.slice(from, i + 1);
    return { keys: [...body.matchAll(/(?:^|[{,]\s*)([A-Za-z_]\w*):\s*(?:['"`]|\w)/gm)].map((m) => m[1]!), end: i };
  };
  const re = /\ben:\s*\{/g;
  for (const m of source.matchAll(re)) {
    const en = grab(m.index! + m[0].length - 1);
    const taAt = source.indexOf('ta:', en.end);
    if (taAt < 0) continue;
    const taBrace = source.indexOf('{', taAt);
    const ta = grab(taBrace);
    blocks.push({ en: en.keys, ta: ta.keys, at: m.index! });
  }
  return blocks;
}

describe('every word on every page has a Tamil twin (design system §1 rule 6 · NFR-08)', () => {
  /** Pages whose words live in a tested session model rather than the page script. */
  const SESSION_WORDS: Record<string, string> = {
    'payroll.js': 'apps/web-erp/src/payroll-session.ts',
    'payroll-payslip.js': 'apps/web-erp/src/payroll-ess-session.ts',
  };
  // No page is English-only any more: the erasure console and the company report joined the toggle in slice 5c.
  for (const script of SCRIPTS) {
    it(`${script}: every English key has a Tamil key`, () => {
      const source = script in SESSION_WORDS ? readFileSync(SESSION_WORDS[script]!, 'utf8') : read(script);
      const blocks = bilingualBlocks(source);
      expect(blocks.length, `${script} has no en/ta word table`).toBeGreaterThan(0);
      for (const b of blocks) {
        const missing = b.en.filter((k) => !b.ta.includes(k));
        expect(missing, `${script} block at ${b.at}: no Tamil for`).toEqual([]);
        expect(b.en.length).toBeGreaterThan(0);
      }
    });
  }

  it('tripwire — the pairing detector reports a missing twin', () => {
    const [b] = bilingualBlocks("const W = { en: { a: 'x', b: 'y' }, ta: { a: 'எ' } };");
    expect(b!.en).toEqual(['a', 'b']);
    expect(b!.ta).toEqual(['a']);
  });
});
