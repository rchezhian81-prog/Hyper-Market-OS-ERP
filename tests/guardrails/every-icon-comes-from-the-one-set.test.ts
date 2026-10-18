import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ERP_NAVIGATION, NAV_GROUP_LABELS } from '../../apps/web-erp/src/navigation';
import { screenAppDirs } from '../../scripts/sync-ui-foundation.mjs';

/**
 * **One icon set, everywhere, and never an icon on its own (OB-201 "Icons A", 18 Oct 2026 · design system §3.4).**
 *
 * The owner chose thin line icons (outline, about 1.5px stroke, 24px grid, round caps and joins), ONE set used on
 * every screen, built in so they draw with no network, each one paired with its word. This file keeps that true:
 *
 *   1. the set is `packages/ui/web/sre-icons.js`, and every shape in it is the owner's approved pack's own (Lucide),
 *      drawn at 1.5px on the 24 grid with round caps and joins — `indian-rupee` alone comes from Lucide directly;
 *   2. it is vendored honestly: the licence and the attribution note are kept beside it, the notices travel in every
 *      copy, and only the icons a screen uses are in it;
 *   3. it needs no network and no other drawing: no fetch, no font, no URL; no page draws an SVG of its own;
 *   4. every icon a screen names is in the set — every workspace, every screen in the menu catalogue, every figure
 *      on the Today page, every control of the chrome, every status tone;
 *   5. an icon is never the only signal: the SVG is hidden from screen readers and cannot take focus, and the helpers
 *      refuse a chip or an icon-with-word whose word is blank (the rendered proof is
 *      tests/e2e/the-chrome-wears-the-one-icon-set.e2e.ts);
 *   6. every screen links the set once, after the look and before its own scripts, and its worker precaches it.
 */

const SOURCE = 'packages/ui/web/sre-icons.js';
const ICONS_JS = readFileSync(SOURCE, 'utf8');
const CHROME = readFileSync('apps/web-erp/web/sre-chrome.js', 'utf8');
const PACK_JS = readFileSync('docs/design/reference/professional-pack-2026-10-04/source/icons.js', 'utf8');
type Shape = [string, Record<string, string>][];

/** The set's table, read from the source itself: one `"name": [...],` line per icon. */
function setOf(source: string): Record<string, Shape> {
  const body = source.slice(source.indexOf('const ICONS = Object.freeze({'), source.indexOf('  });'));
  const out: Record<string, Shape> = {};
  for (const [, name, shape] of body.matchAll(/^ {4}"([a-z0-9-]+)": (\[.*\]),$/gm)) out[name!] = JSON.parse(shape!) as Shape;
  return out;
}
const SET = setOf(ICONS_JS);
const NAMES = Object.keys(SET);
const PACK = new Function(`return ${/const ICONS=(\{.*?\});/s.exec(PACK_JS)![1]!}`)() as Record<string, Shape>;
/** Lucide's own shapes that are not in the owner's pack — each named in the attribution note. */
const FROM_LUCIDE = ['indian-rupee'];

/** An object literal in a source, `const NAME = Object.freeze({...})`, evaluated. */
const frozen = (source: string, name: string): Record<string, string> => {
  const m = new RegExp(`const ${name} = Object\\.freeze\\((\\{[\\s\\S]*?\\})\\);`).exec(source);
  expect(m, `${name} is not declared`).not.toBeNull();
  return new Function(`return ${m![1]!}`)() as Record<string, string>;
};
const GROUP_ICONS = frozen(CHROME, 'GROUP_ICONS');
const ITEM_ICONS = frozen(CHROME, 'ITEM_ICONS');
const FIGURE_ICONS = frozen(CHROME, 'FIGURE_ICONS');
const CHROME_ICONS = frozen(CHROME, 'CHROME_ICONS');
const TONES = frozen(ICONS_JS, 'TONES');
const DOT_SHAPES = new Function(`return ${/const DOT_SHAPES = (\[[\s\S]*?\]);/.exec(ICONS_JS)![1]!}`)() as [string, string][];

const apps = screenAppDirs();
const pages = apps.flatMap((a) => readdirSync(`apps/${a}/web`).filter((f) => f.endsWith('.html')).map((f) => `apps/${a}/web/${f}`));
const scripts = apps.flatMap((a) => readdirSync(`apps/${a}/web`).filter((f) => f.endsWith('.js') && !f.endsWith('.bundle.js')).map((f) => `apps/${a}/web/${f}`));
/** Every `sreIcon('name'` a screen's own code (or the shared files) names literally. */
const literalNames = (): string[] => [...scripts, 'packages/ui/web/sre-update.js'].flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/sreIcon\('([a-z0-9-]+)'/g)].map((m) => m[1]!));

// ── A DOM just big enough to run the helpers: elements, attributes, children, a class list, a do-nothing observer ──
interface FakeEl { tag: string; attrs: Record<string, string>; children: (FakeEl | string)[]; dataset: Record<string, string>; className: string; textContent: string; classes: Set<string> }
function fakeWindow(): { window: { sreIcon: ((name: string, size?: number) => FakeEl | null) & Record<string, (...a: never[]) => unknown> } } {
  const el = (tag: string): FakeEl & Record<string, unknown> => {
    const node: FakeEl & Record<string, unknown> = {
      tag, attrs: {}, children: [], dataset: {}, className: '', textContent: '', classes: new Set<string>(),
      setAttribute(k: string, v: string) { node.attrs[k] = v; },
      getAttribute(k: string) { return node.attrs[k] ?? null; },
      append(...c: FakeEl[]) { node.children.push(...c); },
      replaceChildren(...c: FakeEl[]) { node.children = [...c]; },
      get firstElementChild() { return node.children.find((c) => typeof c !== 'string') ?? null; },
      classList: { contains: (c: string) => node.classes.has(c) },
    };
    return node;
  };
  const document = { createElement: el, createElementNS: (_ns: string, tag: string) => el(tag), querySelectorAll: () => [] };
  const window = {} as { sreIcon: never };
  runInNewContext(ICONS_JS, { window, document, MutationObserver: class { observe(): void {} }, WeakSet });
  return { window } as never;
}

describe('the one set — its shapes are the owner\'s pack, drawn thin', () => {
  it('holds the icons a screen uses, each from the pack (Lucide), and names the ones that come from Lucide directly', () => {
    expect(NAMES.length).toBeGreaterThanOrEqual(80);
    for (const name of NAMES) {
      if (FROM_LUCIDE.includes(name)) { expect(PACK[name], `${name} is in the pack after all — take it from there`).toBeUndefined(); continue; }
      expect(PACK[name], `${name} is not in the owner's pack`).toBeDefined();
      expect(SET[name], `${name} differs from the owner's pack`).toEqual(PACK[name]);
    }
    for (const name of FROM_LUCIDE) expect(readFileSync('packages/ui/web/ICONS-ATTRIBUTION.md', 'utf8')).toContain(`\`${name}\``);
  });

  it('draws every icon at 1.5px on the 24 grid, outline, round caps and joins, in the colour of its words', () => {
    const { window } = fakeWindow();
    const svg = window.sreIcon('wallet')!;
    expect(svg.attrs).toMatchObject({
      viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5',
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: 'sre-icon', 'data-icon': 'wallet',
    });
    expect(svg.children.length).toBe(SET['wallet']!.length);
    expect(window.sreIcon('no-such-icon')).toBeNull();
    // the foundation agrees: the icon class carries the same stroke
    expect(readFileSync('packages/ui/web/sre-foundation.css', 'utf8')).toMatch(/\.sre-icon \{[^}]*stroke-width: 1\.5;/);
  });

  it('is vendored honestly — the licence, the attribution, and the notices in every copy', () => {
    expect(existsSync('packages/ui/web/ICONS-LICENSE.txt')).toBe(true);
    expect(readFileSync('packages/ui/web/ICONS-LICENSE.txt', 'utf8')).toMatch(/ISC License[\s\S]*Lucide Icons and Contributors/);
    expect(existsSync('packages/ui/web/ICONS-ATTRIBUTION.md')).toBe(true);
    expect(ICONS_JS).toMatch(/Lucide — ISC License\. Copyright \(c\) 2026 Lucide Icons and Contributors\./);
    expect(ICONS_JS).toMatch(/Feather — The MIT License \(MIT\)\. Copyright \(c\) 2013-present Cole Bemis\./);
    for (const app of apps) expect(readFileSync(`apps/${app}/web/sre-icons.js`, 'utf8'), `apps/${app}/web/sre-icons.js`).toBe(ICONS_JS);
  });

  it('needs no network and no font — and nothing else on a screen draws an SVG of its own', () => {
    const code = ICONS_JS.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    // (the SVG namespace is a name, not an address: nothing is ever fetched from it)
    expect(code).not.toMatch(/\bfetch\(|XMLHttpRequest|import\(|https?:\/\/(?!www\.w3\.org\/2000\/svg')|url\(|@font-face|innerHTML/);
    for (const f of scripts.filter((s) => !s.endsWith('/sre-icons.js'))) {
      expect(readFileSync(f, 'utf8'), `${f} draws an SVG itself — take it from the one set`).not.toMatch(/createElementNS\(|<svg/);
    }
    for (const p of pages) expect(readFileSync(p, 'utf8'), `${p} carries an inline SVG`).not.toMatch(/<svg/);
  });
});

describe('every icon a screen names is in the set — and the set holds only those', () => {
  const used = new Set<string>([
    ...Object.values(GROUP_ICONS), ...Object.values(ITEM_ICONS), ...Object.values(FIGURE_ICONS), ...Object.values(CHROME_ICONS),
    ...Object.values(TONES), ...DOT_SHAPES.map(([, shape]) => shape), 'check', ...literalNames(),
  ]);

  it('every name the chrome, the status tones, the dots and the screens use is an icon of the set', () => {
    const missing = [...used].filter((n) => !NAMES.includes(n));
    expect(missing).toEqual([]);
  });

  it('only the icons in use are vendored (no dead weight in the till\'s cache)', () => {
    expect(NAMES.filter((n) => !used.has(n))).toEqual([]);
  });

  it('every workspace has its shape, and every screen in the menu catalogue has its own', () => {
    for (const { en } of Object.values(NAV_GROUP_LABELS)) expect(GROUP_ICONS[en], `workspace "${en}" has no icon`).toBeDefined();
    for (const item of ERP_NAVIGATION) expect(ITEM_ICONS[item.id], `menu item "${item.id}" (${item.label}) has no icon`).toBeDefined();
    // and no stale mapping for an item the catalogue no longer has
    const ids = new Set(ERP_NAVIGATION.map((i) => i.id));
    expect(Object.keys(ITEM_ICONS).filter((id) => !ids.has(id))).toEqual([]);
  });

  it('every figure the Today page asks for resolves to an icon of the set', () => {
    const app = readFileSync('apps/web-erp/web/app.js', 'utf8');
    const asked = [...app.matchAll(/iconName: '([a-z]+)'/g)].map((m) => m[1]!);
    expect(asked.length).toBeGreaterThanOrEqual(5);
    for (const name of asked) expect(FIGURE_ICONS[name] ?? (NAMES.includes(name) ? name : undefined), `figure "${name}"`).toBeDefined();
  });

  it('every status tone of the design system has its shape: green ok, amber pending and degraded, red error, grey idle, and not known', () => {
    expect(Object.keys(TONES).sort()).toEqual(['degraded', 'error', 'idle', 'ok', 'pending', 'unknown']);
  });
});

describe('an icon is never the only signal (design system §3, §3.4)', () => {
  it('the SVG is hidden from a screen reader and cannot take focus — its word is the name', () => {
    const { window } = fakeWindow();
    expect(window.sreIcon('menu')!.attrs).toMatchObject({ 'aria-hidden': 'true', focusable: 'false' });
  });

  it('a status chip is the tone\'s shape AND its word; a blank word is refused', () => {
    const { window } = fakeWindow();
    const chip = window.sreIcon['chip']!({ tone: 'pending', label: 'Waiting for the second person' } as never) as FakeEl;
    expect(chip.className).toBe('sre-chip');
    expect(chip.dataset['tone']).toBe('pending');
    const [shape, words] = chip.children as FakeEl[];
    expect(shape!.attrs['data-icon']).toBe('clock');
    expect(words!.textContent).toBe('Waiting for the second person');
    expect(() => window.sreIcon['chip']!({ tone: 'error', label: '   ' } as never)).toThrow(/needs its word/);
    expect(() => window.sreIcon['chip']!({ tone: 'ok' } as never)).toThrow(/needs its word/);
    expect(() => window.sreIcon['withWord']!('wallet' as never, '' as never)).toThrow(/never the only signal/);
  });

  it('a status dot takes the shape of the state its screen already set — and keeps the screen\'s words', () => {
    const { window } = fakeWindow();
    const makeDot = (cls: string[]): FakeEl & Record<string, unknown> => {
      const d = { tag: 'span', attrs: {} as Record<string, string>, children: [] as FakeEl[], classes: new Set(cls) } as unknown as FakeEl & Record<string, unknown>;
      Object.assign(d, {
        setAttribute(k: string, v: string) { d.attrs[k] = v; }, getAttribute(k: string) { return d.attrs[k] ?? null; },
        replaceChildren(...c: FakeEl[]) { d.children = c; }, get firstElementChild() { return d.children[0] ?? null; },
        classList: { contains: (c: string) => d.classes.has(c) },
      });
      return d;
    };
    for (const [classes, shape] of [[[], 'check'], [['error'], 'x'], [['degraded'], 'clock'], [['waiting'], 'clock'], [['idle'], 'pause'], [['missing'], 'x'], [['stale'], 'clock']] as const) {
      const dot = makeDot([...classes]);
      window.sreIcon['statusDot']!(dot as never);
      expect(dot.attrs['data-sre-status'], `${classes.join(' ')}`).toBe('');
      expect((dot.children[0] as FakeEl).attrs['data-icon'], `${classes.join(' ') || 'ok'}`).toBe(shape);
    }
  });

  it('the chrome puts every icon beside its word: a link, the menu button, the toggle, the strips, the branch', () => {
    // the rail link: the screen's shape, then its name as text — the name alone is the link's text
    expect(CHROME).toMatch(/if \(shape\) link\.append\(shape\);\n\s+link\.append\(document\.createTextNode\(word\(item\.label\)\)\);/);
    expect(CHROME).toMatch(/button\.replaceChildren\(menuMark, document\.createTextNode\(t\('screens'\)\)\)/);
    expect(CHROME).toMatch(/toggle\.replaceChildren\(mark, document\.createTextNode\(t\('otherLanguage'\)\)\)/);
    expect(CHROME).toMatch(/strip\.firstElementChild\.lastElementChild\.textContent = t\('newVersion'\)/);
    expect(CHROME).toMatch(/setText\(words, `\$\{own \?\? t\('staleShell'\)\}/);
    // and the chrome draws through the one set only
    expect(CHROME).toMatch(/return window\.sreIcon\(shapeFor\(name\), size\);/);
    expect(CHROME).not.toMatch(/createElementNS|innerHTML/);
  });
});

describe('every screen carries the set, offline', () => {
  const TAG = '<script src="./sre-icons.js" defer></script>';

  it('every page links sre-icons.js once, after the look and before any script of its own', () => {
    for (const p of pages) {
      const html = readFileSync(p, 'utf8');
      expect(html.split(TAG).length - 1, `${p} links the icon set`).toBe(1);
      const at = html.indexOf(TAG);
      expect(at, `${p}: the icons come after the look`).toBeGreaterThan(html.indexOf('href="./sre-foundation.css"'));
      for (const m of html.matchAll(/<script [^>]*src="\.\/(?!sre-icons\.js)[^"]+"[^>]*><\/script>/g)) {
        expect(m.index!, `${p}: ${m[0]} loads before the icon set`).toBeGreaterThan(at);
      }
    }
  });

  it('every service worker precaches it, so an icon draws with the shop\'s internet off', () => {
    for (const app of apps) {
      const sw = readFileSync(`apps/${app}/web/sw.js`, 'utf8');
      expect(/const SHELL = \[([^\]]*)\]/.exec(sw)?.[1] ?? '', `apps/${app}/web/sw.js`).toContain("'./sre-icons.js'");
    }
  });

  it('the till\'s and the handhelds\' status dots opt in to their shape — and only a dot does', () => {
    for (const p of ['apps/pos/web/index.html', 'apps/warehouse-app/web/index.html', 'apps/picker-app/web/index.html', 'apps/delivery-app/web/index.html']) {
      expect(readFileSync(p, 'utf8'), p).toMatch(/<span class="dot" id="[a-z-]+-dot" data-sre-status/);
    }
    for (const p of pages) {
      for (const m of readFileSync(p, 'utf8').matchAll(/<[^>]*data-sre-status[^>]*>/g)) expect(m[0], p).toMatch(/^<span class="dot"/);
    }
  });

  it('tripwire — the set reader and the usage scan both bite', () => {
    expect(Object.keys(setOf('  const ICONS = Object.freeze({\n    "a-b": [["path",{"d":"M0 0"}]],\n  });'))).toEqual(['a-b']);
    const fake = 'x(sreIcon(\'not-in-the-set\'))';
    expect([...fake.matchAll(/sreIcon\('([a-z0-9-]+)'/g)].map((m) => m[1])).toEqual(['not-in-the-set']);
    expect(NAMES).not.toContain('not-in-the-set');
  });
});
