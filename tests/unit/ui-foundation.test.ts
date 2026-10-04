import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { checkContrast, checkPalette, WCAG, type PalettePair } from '../../packages/a11y/src/contrast';

/**
 * **The one visual foundation is readable, pair by pair (Stage G slice 1 · design system §3 · NFR-07 · QG-02).**
 *
 * `packages/ui/web/sre-foundation.css` is the palette every screen now imports. A palette is a set of PAIRS —
 * words on a surface — and WCAG 2.2 AA is a property of pairs, not of colours. So this reads the tokens out of
 * the stylesheet itself (not a copy of them in a test, which is how a palette and its proof drift apart) and puts
 * every pair a screen actually renders through `packages/a11y`.
 *
 * The finding this file exists to keep fixed: **no single red can be both readable text on a dark panel and a
 * surface under white text** — #ef4444 is 3.9:1 as words on a panel and 3.8:1 under white, both short of 4.5:1.
 * The screens used one `--danger` for both and both failed. The foundation therefore carries three reds, and this
 * proves each does the one job it is for.
 */

const CSS = readFileSync('packages/ui/web/sre-foundation.css', 'utf8');

/**
 * The tokens of one SET, `var()` aliases resolved, so `--good` and `--ok` are compared as the same value. The LIGHT set
 * is the first `:root {` block (the owner's look, OB-13); the DARK set is `:root[data-theme="dark"]` laid over it — it
 * overrides values and inherits the aliases, exactly as the cascade does for a shell that pins `data-theme="dark"`.
 */
function tokens(css: string, theme: 'light' | 'dark' = 'light'): Record<string, string> {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const light = /:root\s*{([^}]*)}/.exec(clean)?.[1] ?? '';
  const dark = /:root\[data-theme="dark"\]\s*{([^}]*)}/.exec(clean)?.[1] ?? '';
  const raw: Record<string, string> = {};
  for (const block of theme === 'dark' ? [light, dark] : [light]) {
    for (const [, name, value] of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) raw[name!] = value!.trim();
  }
  const resolve = (v: string, depth = 0): string => {
    const alias = /^var\((--[a-z0-9-]+)\)$/.exec(v);
    if (!alias || depth > 5) return v;
    return resolve(raw[alias[1]!] ?? v, depth + 1);
  };
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, resolve(v)]));
}

const T = tokens(CSS);
const DARK = tokens(CSS, 'dark');
const SETS = [['light', T], ['dark', DARK]] as const;

describe('the tokens the stylesheet declares', () => {
  it('carries both dialects the screens grew up with, resolving to ONE value each', () => {
    expect(T['--good']).toBe(T['--ok']);
    expect(T['--accent']).toBe(T['--ok']);
    expect(T['--warn']).toBe(T['--degraded']);
    expect(T['--danger']).toBe(T['--error']);
    expect(T['--accent-ink']).toBe(T['--on-accent']);
    expect(T['--nobody-surface']).toBe(T['--warn-surface']);
  });

  it('names a Tamil-capable face in the one font stack, and never a download', () => {
    expect(T['--font']).toMatch(/Noto Sans Tamil/);
    expect(T['--font']).toMatch(/Nirmala UI/);
    expect(T['--font']).toMatch(/^system-ui/);
    expect(CSS).not.toMatch(/@import|@font-face|url\(/);
  });

  it('declares the 48px minimum touch target the usability guardrails read — and the fixtures honour it', () => {
    expect(T['--tap']).toBe('48px');
    // The language toggle is a button a person taps on every screen; the 40px the pages grew up with was a
    // pre-existing breach of the ≥ 44px rule, and a foundation must not codify one.
    expect(/\.lang \{[^}]*min-height:\s*var\(--tap\)/.test(CSS)).toBe(true);
  });
});

describe('every text pair a screen renders meets WCAG 2.2 AA — in BOTH sets', () => {
  const pairsOf = (S: Record<string, string>): PalettePair[] => [
    { name: 'body text on the page', foreground: S['--ink']!, background: S['--bg']! },
    { name: 'body text on a panel', foreground: S['--ink']!, background: S['--panel']! },
    { name: 'body text on a plain button', foreground: S['--ink']!, background: S['--line']! },
    { name: 'body text in an input', foreground: S['--ink']!, background: S['--field']! },
    { name: 'muted text on a panel', foreground: S['--muted']!, background: S['--panel']! },
    { name: 'muted text on the page', foreground: S['--muted']!, background: S['--bg']! },
    { name: 'muted text on a secondary surface (a chip, a tag)', foreground: S['--muted']!, background: S['--panel-2']! },
    { name: 'muted text in an input (a placeholder-like hint)', foreground: S['--muted']!, background: S['--field']! },
    { name: 'the primary button', foreground: S['--on-accent']!, background: S['--accent']! },
    { name: 'a blue button', foreground: S['--on-info']!, background: S['--info']! },
    { name: 'the SAMPLE DATA strip', foreground: S['--on-warn']!, background: S['--degraded']! },
    { name: 'the served-from-cache strip', foreground: S['--on-info-surface']!, background: S['--info-surface']! },
    { name: 'the nobody-signed-in strip', foreground: S['--on-nobody-surface']!, background: S['--nobody-surface']! },
    { name: 'an amber strip (a flagged stop, a warning that is not an error)', foreground: S['--on-warn-surface']!, background: S['--warn-surface']! },
    { name: 'a green-tinted panel (a verdict that can be signed, a reassurance)', foreground: S['--on-ok-surface']!, background: S['--ok-surface']! },
    { name: 'red words on a panel', foreground: S['--danger-text']!, background: S['--panel']! },
    { name: 'red words on the page', foreground: S['--danger-text']!, background: S['--bg']! },
    { name: 'red words on a red-tinted panel (a blocker, a forbidden chip)', foreground: S['--danger-text']!, background: S['--error-surface']! },
    { name: 'a red button or banner', foreground: S['--on-danger']!, background: S['--danger-surface']! },
    { name: 'the practice-data banner, both stripes', foreground: S['--on-demo']!, background: S['--demo-surface']! },
    { name: 'the practice-data banner, second stripe', foreground: S['--on-demo']!, background: S['--demo-surface-2']! },
    { name: 'amber words on a panel (attention)', foreground: S['--degraded']!, background: S['--panel']! },
    { name: 'green words on a panel', foreground: S['--ok']!, background: S['--panel']! },
    { name: 'blue words on a panel', foreground: S['--info']!, background: S['--panel']! },
    { name: 'the current tab (page colour on ink)', foreground: S['--bg']!, background: S['--ink']! },
    { name: 'the skip link', foreground: S['--bg']!, background: S['--ink']! },
    { name: 'words on an idle surface', foreground: S['--on-idle']!, background: S['--idle']! },
    { name: 'the rail: a screen\'s name', foreground: S['--on-rail']!, background: S['--rail']! },
    { name: 'the rail: a group heading and the person\'s line', foreground: S['--on-rail-muted']!, background: S['--rail']! },
    { name: 'the rail: the current screen (an opaque step, never a translucent wash the audit cannot read)', foreground: S['--on-rail']!, background: S['--rail-2']! },
  ];

  it.each(SETS)('%s set — all of them, named, and the report names the worst', (_name, S) => {
    const report = checkPalette(pairsOf(S));
    expect(report.failures.map((f) => `${(f as { name?: string }).name}: ${f.detail}`)).toEqual([]);
    expect(report.passes).toBe(true);
    expect(report.worst).toBeDefined();
  });

  it.each(SETS)('%s set — proves the red split is necessary: the signal red fails BOTH text jobs, which is why there are three reds', (_name, S) => {
    // If this ever passes, a future palette may collapse the three back into one — and should.
    expect(checkContrast({ foreground: S['--error']!, background: S['--panel']! }).passes).toBe(false);
    expect(checkContrast({ foreground: S['--on-danger']!, background: S['--error']! }).passes).toBe(false);
    expect(checkContrast({ foreground: S['--danger-text']!, background: S['--panel']! }).passes).toBe(true);
    expect(checkContrast({ foreground: S['--on-danger']!, background: S['--danger-surface']! }).passes).toBe(true);
  });

  it('the dark set is the look every screen had before OB-13, kept for the shells UX-1b has not brought over', () => {
    expect(DARK['--bg']).toBe('#0f172a');
    expect(DARK['--panel']).toBe('#1e293b');
    expect(DARK['--ink']).toBe('#f8fafc');
    expect(DARK['--ok']).toBe('#22c55e');
    expect(DARK['--danger-text']).toBe('#fca5a5');
    expect(DARK['--tap']).toBe('48px');
    // and the light set is the owner's reference (design system §3.2)
    expect(T['--rail']).toBe('#192f27');
    expect(T['--accent']).toBe('#16614d');
    expect(T['--bg']).toBe('#f3f5f4');
    expect(T['--panel']).toBe('#ffffff');
    // a screen's look is a product decision, never the operating system's
    expect(CSS).not.toMatch(/prefers-color-scheme/);
  });
});

describe('the signals that are not words meet the 3:1 non-text bar on a panel — in BOTH sets', () => {
  it.each(SETS)('%s set — the four sync-badge dots, the focus ring, the info edge and the rail\'s mark', (_name, S) => {
    for (const [name, fg] of [['ok', S['--ok']], ['degraded', S['--degraded']], ['error', S['--error']], ['idle', S['--idle']], ['info', S['--info']], ['focus ring', S['--focus']]] as const) {
      const on = checkContrast({ foreground: fg!, background: S['--panel']!, size: 'non_text' });
      expect(on.passes, `${name} dot on a panel: ${on.detail}`).toBe(true);
      expect(on.required).toBe(WCAG.aaNonText);
    }
    const mark = checkContrast({ foreground: S['--rail-accent']!, background: S['--rail']!, size: 'non_text' });
    expect(mark.passes, `the current screen's mark on the rail: ${mark.detail}`).toBe(true);
  });
});

describe('the stylesheet stays a foundation, not a framework', () => {
  it('reaches no bare tag beyond the fixtures every screen carries and the base — its components are namespaced', () => {
    const noComments = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = [...noComments.matchAll(/(^|\n)([^@{}\n][^{}]*)\{/g)].map((m) => m[2]!.trim());
    const bareTags = selectors.flatMap((s) => s.split(',').map((x) => x.trim())).filter((s) => /^[a-z]+$/.test(s));
    expect(new Set(bareTags)).toEqual(new Set(['html', 'body', 'button', 'input', 'select', 'textarea', 'header']));
    expect(selectors.filter((s) => s.startsWith('.sre-')).length).toBeGreaterThan(20);
  });

  it('respects a person who asked for less motion or more contrast', () => {
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(CSS).toMatch(/@media \(prefers-contrast: more\)/);
    expect(CSS).toMatch(/html\[lang="ta"\]/);
  });
});
