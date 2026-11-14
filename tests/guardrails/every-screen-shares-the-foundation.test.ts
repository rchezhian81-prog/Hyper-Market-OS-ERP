import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';

/**
 * **Every screen imports the ONE visual foundation — and never re-declares it (Stage G slice 1 · QG-02 · P-07).**
 *
 * Before this, fifty-six pages each carried their own copy of the palette, the type stack and the fixtures every
 * screen shares (the sync badge, the language toggle, the sample / cached / nobody strips). Two dialects of token
 * names had grown (`--ok/--degraded/--error/--idle` on 33 pages, `--good/--warn/--danger` on 15), four pages had a
 * light palette of their own, the touch target varied 48/52/56/60/64, and 56 `font:` shorthands each reset the
 * family — so a Tamil face could be present on one screen and absent on the next. That is not one product.
 *
 * Now `packages/ui/web/sre-foundation.css` is the source; each `apps/<app>/web/sre-foundation.css` is a tracked,
 * byte-identical copy (each screen is served from its own folder and precaches its own files, P-01); and every page
 * links it before its own `<style>`. This file keeps all of that true:
 *
 *   1. every page links the foundation, once, before its own styles;
 *   2. every copy is byte-identical to the source, and the sync script's own `--check` agrees;
 *   3. every service worker precaches it, so a lane opens with the right look and no network;
 *   4. a page's `:root` declares ONLY its touch target — never a colour, never a font (that is the drift this fixes);
 *   5. no page names a literal font stack; the shared stack is the only one;
 *   6. red WORDS use the readable red, never the signal red (the pre-existing 3.9:1 failure on every screen);
 *   7. the store box serves `.css` as `text/css` — a browser in standards mode refuses a stylesheet served as anything else.
 *
 * The marketing site (`apps/site`) has its own identity on purpose and is not a screen.
 */

const SOURCE = 'packages/ui/web/sre-foundation.css';
const LINK = '<link rel="stylesheet" href="./sre-foundation.css" />';
const NOT_A_SCREEN = new Set(['site']);

const apps = readdirSync('apps')
  .filter((a) => !NOT_A_SCREEN.has(a))
  .filter((a) => existsSync(`apps/${a}/web`) && statSync(`apps/${a}/web`).isDirectory()
    && readdirSync(`apps/${a}/web`).some((f) => f.endsWith('.html')))
  .sort();
const pages = apps.flatMap((a) => readdirSync(`apps/${a}/web`).filter((f) => f.endsWith('.html')).sort().map((f) => `apps/${a}/web/${f}`));
const read = (p: string): string => readFileSync(p, 'utf8');
const styleOf = (html: string): string => (/<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '');

/** The detector, kept as a function so the tripwire below can prove it fires. */
const linksTheFoundation = (html: string): boolean => {
  const at = html.indexOf(LINK);
  const style = html.indexOf('<style>');
  return at !== -1 && html.indexOf(LINK, at + 1) === -1 && style !== -1 && at < style;
};

describe('the screens this covers', () => {
  it('finds the thirteen screen apps and their pages, and leaves the marketing site alone', () => {
    // OB-676 (M27-FR-02): the concessionaire's own counter portal joined.
    // OB-288 P6: the self-checkout lane and the price kiosk joined (R8-3 · D14-FR-02); Pkg 6b: the queue till (D04-FR-05).
    expect(apps).toEqual(['b2b-app', 'concession-app', 'customer-app', 'delivery-app', 'owner-app', 'picker-app', 'pos', 'price-kiosk', 'queue-pos', 'self-checkout', 'supplier-app', 'warehouse-app', 'web-erp']);
    expect(pages.length).toBeGreaterThanOrEqual(56);
    expect(pages.some((p) => p.startsWith('apps/site/'))).toBe(false);
  });
});

describe('one stylesheet, linked by every page', () => {
  it('every page links ./sre-foundation.css exactly once, before its own <style>', () => {
    const missing = pages.filter((p) => !linksTheFoundation(read(p)));
    expect(missing, 'pages that do not import the foundation first').toEqual([]);
  });

  it('tripwire — the detector fires on a page without the link, and on one that links it after its own styles', () => {
    expect(linksTheFoundation('<html><head><style>body{}</style></head></html>')).toBe(false);
    expect(linksTheFoundation(`<html><head><style>body{}</style>${LINK}</head></html>`)).toBe(false);
    expect(linksTheFoundation(`<html><head>${LINK}<style>body{}</style></head></html>`)).toBe(true);
  });
});

describe('the copies are the source, byte for byte', () => {
  it('every screen app carries a copy identical to packages/ui/web/sre-foundation.css', () => {
    const source = readFileSync(SOURCE);
    for (const app of apps) {
      const copy = `apps/${app}/web/sre-foundation.css`;
      expect(existsSync(copy), `${copy} is missing — run: node scripts/sync-ui-foundation.mjs`).toBe(true);
      expect(readFileSync(copy).equals(source), `${copy} differs from the source — edit ${SOURCE} and run the sync`).toBe(true);
    }
  });

  it('the sync script agrees, in --check mode, without writing anything', () => {
    const before = apps.map((a) => statSync(`apps/${a}/web/sre-foundation.css`).mtimeMs);
    const out = execFileSync(process.execPath, ['scripts/sync-ui-foundation.mjs', '--check'], { encoding: 'utf8' });
    expect(out).toMatch(/sre-foundation\.css, sre-update\.js and fonts\/ matches packages\/ui\/web/);
    expect(apps.map((a) => statSync(`apps/${a}/web/sre-foundation.css`).mtimeMs)).toEqual(before);
  });

  it('every app build refreshes the copies first, so a screen is never built against a stale look', () => {
    expect(read('scripts/build-app.mjs')).toMatch(/syncFoundation\(\)/);
  });
});

describe('a lane opens with the right look and no network', () => {
  it('every service worker precaches the foundation in its SHELL', () => {
    for (const app of apps) {
      const sw = read(`apps/${app}/web/sw.js`);
      const shell = /const SHELL = \[([^\]]*)\]/.exec(sw)?.[1] ?? '';
      expect(shell, `apps/${app}/web/sw.js does not precache the foundation`).toContain("'./sre-foundation.css'");
    }
  });

  it('the store box serves a stylesheet as text/css, not as a download', () => {
    expect(read('edge/store-edge/src/screen-server.ts')).toMatch(/'\.css': 'text\/css; charset=utf-8'/);
  });

  // OB-728 (emerald and gold): the two faces are the app's own files, so a lane draws its words in them with the
  // internet down. Every app carries all nine and both licences, byte for byte; every worker precaches all nine.
  const FONTS = [
    ...[400, 500, 600, 700, 800].map((w) => `fonts/plus-jakarta-sans-${w}.woff2`),
    ...[400, 500, 600, 700].map((w) => `fonts/anek-tamil-${w}.woff2`),
  ];
  // OB-729 (owner, 14 Nov 2026): the customer app keeps the phone's own faces — its 150 KB first load on a weak link.
  const SYSTEM_TYPE = ['customer-app'];
  const fontApps = apps.filter((a) => !SYSTEM_TYPE.includes(a));
  it('the customer app keeps the phone\'s own faces: every page opts out, it carries no font file and its worker asks for none (OB-729)', () => {
    expect(fontApps.length).toBe(apps.length - 1);
    for (const app of SYSTEM_TYPE) {
      for (const p of pages.filter((x) => x.startsWith(`apps/${app}/`))) expect(read(p), p).toMatch(/<html lang="en" class="sre-system-type">/);
      expect(existsSync(`apps/${app}/web/fonts`)).toBe(false);
      expect(read(`apps/${app}/web/sw.js`)).not.toMatch(/woff2/);
    }
    expect(read(SOURCE)).toMatch(/html\.sre-system-type \{ --font: var\(--font-system\); \}/);
    // and no store screen opts out: the till, the handhelds, the kiosks and the back office draw the two faces
    for (const p of pages.filter((x) => !SYSTEM_TYPE.some((a) => x.startsWith(`apps/${a}/`)))) expect(read(p), p).not.toMatch(/sre-system-type/);
  });

  it('every screen app carries the nine font files and their two licences, identical to packages/ui/web/fonts', () => {
    for (const file of [...FONTS, 'fonts/OFL-plus-jakarta-sans.txt', 'fonts/OFL-anek-tamil.txt']) {
      const source = readFileSync(`packages/ui/web/${file}`);
      if (file.endsWith('.woff2')) expect(source.subarray(0, 4).toString('latin1'), `${file} is a woff2 file`).toBe('wOF2');
      else expect(source.toString('utf8')).toMatch(/SIL Open Font License, Version 1\.1/);
      for (const app of fontApps) expect(readFileSync(`apps/${app}/web/${file}`).equals(source), `apps/${app}/web/${file}`).toBe(true);
    }
  });

  it('every store page asks for the faces as it opens (sre-faces.js, once, before the icon set), so a scan never reads a font file mid-sale', () => {
    const source = readFileSync('packages/ui/web/sre-faces.js');
    for (const app of fontApps) {
      expect(readFileSync(`apps/${app}/web/sre-faces.js`).equals(source), `apps/${app}/web/sre-faces.js`).toBe(true);
      expect(read(`apps/${app}/web/sw.js`), `apps/${app}/web/sw.js`).toContain("'./sre-faces.js'");
    }
    for (const p of pages) {
      const html = read(p);
      const tag = '<script src="./sre-faces.js" defer></script>';
      if (SYSTEM_TYPE.some((a) => p.startsWith(`apps/${a}/`))) { expect(html, p).not.toContain('sre-faces.js'); continue; }
      expect(html.split(tag).length - 1, `${p} asks for the faces once`).toBe(1);
      expect(html.indexOf(tag), `${p}: the faces before the icon set`).toBeLessThan(html.indexOf('<script src="./sre-icons.js"'));
    }
    const code = source.toString('utf8');
    expect(code).toMatch(/sre-system-type/);
    expect(code).not.toMatch(/\bfetch\(|XMLHttpRequest|https?:\/\//);
  });

  it('every service worker precaches every font file, so a till opens in its face with no network', () => {
    for (const app of fontApps) {
      const shell = /const SHELL = \[([^\]]*)\]/.exec(read(`apps/${app}/web/sw.js`))?.[1] ?? '';
      for (const f of FONTS) expect(shell, `apps/${app}/web/sw.js does not precache ${f}`).toContain(`'./${f}'`);
    }
  });

  it('every door of the store box serves a font as font/woff2', () => {
    for (const door of ['screen-server.ts', 'device-server.ts', 'queue-pos-door.ts']) {
      expect(read(`edge/store-edge/src/${door}`), door).toMatch(/'\.woff2': 'font\/woff2'/);
    }
  });
});

describe('a page owns its touch target and nothing else the foundation owns', () => {
  it('every :root on every page declares only --tap; no page keeps a theme block of its own', () => {
    const offenders: string[] = [];
    for (const p of pages) {
      const css = styleOf(read(p));
      for (const [, body] of css.matchAll(/:root\s*{([^}]*)}/g)) {
        const declared = [...body!.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]);
        const foreign = declared.filter((d) => d !== '--tap');
        if (foreign.length > 0) offenders.push(`${p}: ${foreign.join(' ')}`);
      }
      if (/:root(?::not\(|\[data-theme)/.test(css)) offenders.push(`${p}: keeps its own light/dark theme block`);
    }
    expect(offenders).toEqual([]);
  });

  it('every page that raises --tap raises it to at least the 48px the foundation sets', () => {
    for (const p of pages) {
      const tap = /--tap:\s*(\d+)px/.exec(styleOf(read(p)));
      if (tap) expect(Number(tap[1]), `${p} lowers the touch target`).toBeGreaterThanOrEqual(48);
    }
  });

  it('no page names a literal font stack — the shared stack is the only one', () => {
    const offenders = pages.filter((p) => /system-ui|-apple-system|Segoe UI|Roboto/.test(styleOf(read(p))));
    expect(offenders).toEqual([]);
    for (const p of pages) {
      for (const [, family] of styleOf(read(p)).matchAll(/font:\s*[\d.]+px\/[\d.]+\s+([^;]+);/g)) {
        expect(family!.trim(), `${p} uses a font stack of its own`).toMatch(/^var\(--(font|mono)\)$|monospace$/);
      }
    }
  });

  it('no page pins a set — the light default everywhere, the back office since UX-1a and every other shell since UX-1b (OB-13 "A", OB-14 "c")', () => {
    const outside = pages.filter((p) => !p.startsWith('apps/web-erp/'));
    expect(outside.length).toBeGreaterThanOrEqual(10);
    for (const p of pages) expect(read(p), `${p} pins a set; the light default is the look everywhere`).not.toMatch(/data-theme=/);
    // (the customer app's pages also carry the phone's-own-faces class, OB-729 — a type choice, never a colour set)
    for (const p of pages) expect(read(p)).toMatch(/<html lang="en"( class="sre-system-type")?>/);
  });

  it('the foundation carries both sets — the light default and the dark set under data-theme — and no media query chooses for a screen', () => {
    const css = read('packages/ui/web/sre-foundation.css');
    expect(css).toMatch(/\n:root \{/);
    expect(css).toMatch(/\n:root\[data-theme="dark"\] \{/);
    expect(css).not.toMatch(/prefers-color-scheme/);
    // the dark-theme literals the pages grew up with are gone from every screen (the back office in UX-1a, the rest in
    // UX-1b): every colour is a token, so one set serves them all
    for (const p of pages) {
      expect(styleOf(read(p)), `${p} still names a colour of its own`).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    }
  });

  it('red words use the readable red; the signal red is for dots, borders and icons', () => {
    const offenders = pages.filter((p) => /(?<![a-z-])color:\s*var\(--(danger|error)\)/.test(styleOf(read(p))));
    expect(offenders, 'pages that still write text in the signal red').toEqual([]);
  });
});
