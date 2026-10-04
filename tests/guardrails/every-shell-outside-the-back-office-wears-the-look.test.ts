import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { BACK_OFFICE, UPDATE_FILE, UPDATE_SOURCE, copiesOf, screenAppDirs, shellOf } from '../../scripts/sync-ui-foundation.mjs';

/**
 * **UX-1b (OB-13 "A", OB-14 "c" — the look first): every shell outside the back office wears the one light look, keeps
 * its own layout and touch targets, and announces a new version the way the back office does.**
 *
 * The till, the concession tag, the picker, driver and warehouse handhelds, the owner, customer, B2B and supplier
 * shells took only the PALETTE in this slice. This file pins what that means, file by file:
 *
 *   1. every such page includes the shared "new version" strip script once, after the foundation link, and the back
 *      office does NOT (its chrome draws the same strip) — one implementation per family, never two;
 *   2. every copy of the script is the source byte for byte, and the sync script names the same copies;
 *   3. every worker outside the back office precaches it, so the strip itself opens with no network (P-01);
 *   4. the script does what the chrome's does: listens for a controller change, ignores the first controller, speaks
 *      both languages, and reloads only when the person presses the button (never a silent swap, P-08);
 *   5. the signal red is never a surface under words, on any page: the light `--error` is 3.9:1 under white and is a
 *      dot or an edge by design (design system §3.2, the three-reds rule) — a banner or a button uses `--danger-surface`;
 *   6. the targets are untouched: each shell keeps the `--tap` it declared before the palette changed (56 / 60 / 64 / 48).
 */

const apps = screenAppDirs();
const outside = apps.filter((a) => a !== BACK_OFFICE);
const pagesOf = (app: string): string[] => readdirSync(`apps/${app}/web`).filter((f) => f.endsWith('.html')).sort().map((f) => `apps/${app}/web/${f}`);
const read = (p: string): string => readFileSync(p, 'utf8');
const styleOf = (html: string): string => (/<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
const SCRIPT_TAG = '<script src="./sre-update.js" defer></script>';

/** The detector for rule 5, kept as a function so the tripwire can prove it fires. */
export function signalRedUnderWords(css: string): string[] {
  const offenders: string[] = [];
  for (const block of css.match(/[^{}]+\{[^}]*\}/g) ?? []) {
    if (/background:\s*var\(--(danger|error)\)/.test(block) && /(?<![a-z-])color:/.test(block)) offenders.push(block.trim().split('{')[0]!.trim());
  }
  return offenders;
}

describe('the shells outside the back office', () => {
  it('are the eight apps the owner\'s staff and customers hold in their hands or stand at', () => {
    expect(outside).toEqual(['b2b-app', 'customer-app', 'delivery-app', 'owner-app', 'picker-app', 'pos', 'supplier-app', 'warehouse-app']);
    expect(outside.flatMap(pagesOf).length).toBeGreaterThanOrEqual(10);
  });

  it('every page includes the shared "new version" strip script exactly once, after the foundation link', () => {
    for (const p of outside.flatMap(pagesOf)) {
      const html = read(p);
      expect(html.split(SCRIPT_TAG).length - 1, `${p} includes ${UPDATE_FILE}`).toBe(1);
      expect(html.indexOf(SCRIPT_TAG), `${p} loads the strip after the look`).toBeGreaterThan(html.indexOf('href="./sre-foundation.css"'));
    }
  });

  it('the back office does not include it — its chrome draws the same strip, so there is one implementation per family', () => {
    for (const p of pagesOf(BACK_OFFICE)) expect(read(p), `${p}`).not.toMatch(/sre-update\.js/);
    expect(existsSync(`apps/${BACK_OFFICE}/web/${UPDATE_FILE}`)).toBe(false);
    expect(read(`apps/${BACK_OFFICE}/web/sre-chrome.js`)).toMatch(/controllerchange/);
    expect(copiesOf(BACK_OFFICE)).toEqual([`apps/${BACK_OFFICE}/web/sre-foundation.css`]);
  });

  it('every copy of the script is the source byte for byte, and the sync script names the same copies', () => {
    const source = readFileSync(UPDATE_SOURCE);
    for (const app of outside) {
      const copy = `apps/${app}/web/${UPDATE_FILE}`;
      expect(existsSync(copy), `${copy} exists`).toBe(true);
      expect(readFileSync(copy).equals(source), `${copy} is the source`).toBe(true);
      expect(copiesOf(app)).toEqual([`apps/${app}/web/sre-foundation.css`, copy]);
    }
  });

  it('every worker outside the back office precaches the strip, so it opens with no network; the back office worker does not carry it', () => {
    for (const app of outside) expect(shellOf(read(`apps/${app}/web/sw.js`)), `apps/${app}/web/sw.js`).toContain(UPDATE_FILE);
    expect(shellOf(read(`apps/${BACK_OFFICE}/web/sw.js`))).not.toContain(UPDATE_FILE);
  });

  it('the script does what the chrome\'s strip does: a controller change after the first, both languages, reload only on the button', () => {
    const js = read(UPDATE_SOURCE);
    expect(js).toMatch(/navigator\.serviceWorker\.addEventListener\('controllerchange'/);
    expect(js).toMatch(/let hadController = navigator\.serviceWorker\.controller !== null;/);
    expect(js).toMatch(/if \(hadController\) \{ updateReady = true; paint\(\); \}/);
    expect(js).toMatch(/strip\.id = 'sre-update'/);
    expect(js).toMatch(/strip\.className = 'stale sre-update'/);
    expect(js).toMatch(/setAttribute\('role', 'status'\)/);
    expect(js).toMatch(/en: \{ newVersion: '[^']+', reload: 'Reload' \}/);
    expect(js).toMatch(/ta: \{ newVersion: '[^']+', reload: '[^']+' \}/);
    expect(js.match(/reload\(\)/g)?.length, 'reload happens in one place: the button').toBe(1);
    expect(js).toMatch(/button\.addEventListener\('click', \(\) => window\.location\.reload\(\)\)/);
    expect(js).toMatch(/attributeFilter: \['lang'\]/);
    expect(js).toMatch(/'serviceWorker' in navigator/);
  });

  it('the strip wears the words the back office uses, so one deploy says the same thing on every screen', () => {
    const js = read(UPDATE_SOURCE);
    const chrome = read(`apps/${BACK_OFFICE}/web/sre-chrome.js`);
    for (const key of ['newVersion', 'reload']) {
      const inChrome = [...chrome.matchAll(new RegExp(`${key}: '([^']+)'`, 'g'))].map((m) => m[1]);
      const inScript = [...js.matchAll(new RegExp(`${key}: '([^']+)'`, 'g'))].map((m) => m[1]);
      expect(inScript, key).toEqual(inChrome);
    }
  });
});

describe('the signal red is never a surface under words — on any screen (design system §3.2)', () => {
  it('no style block paints --danger or --error as a background and sets a text colour in the same block', () => {
    const offenders = apps.flatMap(pagesOf).flatMap((p) => signalRedUnderWords(styleOf(read(p))).map((sel) => `${p}: ${sel}`));
    expect(offenders).toEqual([]);
  });

  it('tripwire — the detector fires on white words on the signal red, and stays quiet for a dot or an edge', () => {
    expect(signalRedUnderWords('.banner { background: var(--danger); color: #fff; }')).toEqual(['.banner']);
    expect(signalRedUnderWords('.dot.missing { background: var(--danger); }')).toEqual([]);
    expect(signalRedUnderWords('.row { border-left: 5px solid var(--danger); color: var(--ink); }')).toEqual([]);
    expect(signalRedUnderWords('.ok { background: var(--danger-surface); color: var(--on-danger); }')).toEqual([]);
  });
});

describe('the targets are untouched — palette only', () => {
  const DECLARED: Record<string, number> = { 'apps/pos/web/index.html': 56, 'apps/picker-app/web/index.html': 64, 'apps/warehouse-app/web/index.html': 64, 'apps/delivery-app/web/index.html': 60, 'apps/owner-app/web/index.html': 48, 'apps/customer-app/web/index.html': 48 };

  it('each shell keeps the --tap it declared before the palette changed', () => {
    for (const [p, px] of Object.entries(DECLARED)) {
      const m = /:root \{ --tap: (\d+)px; \}/.exec(styleOf(read(p)));
      expect(m, `${p} declares its own --tap`).not.toBeNull();
      expect(Number(m![1]), `${p} --tap`).toBeGreaterThanOrEqual(px);
    }
  });
});
