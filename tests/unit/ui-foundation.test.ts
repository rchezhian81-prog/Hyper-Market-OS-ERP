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

/** The `:root` tokens, `var()` aliases resolved, so `--good` and `--ok` are compared as the same value. */
function tokens(css: string): Record<string, string> {
  const root = /:root\s*{([^}]*)}/.exec(css.replace(/\/\*[\s\S]*?\*\//g, ''))?.[1] ?? '';
  const raw: Record<string, string> = {};
  for (const [, name, value] of root.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) raw[name!] = value!.trim();
  const resolve = (v: string, depth = 0): string => {
    const alias = /^var\((--[a-z0-9-]+)\)$/.exec(v);
    if (!alias || depth > 5) return v;
    return resolve(raw[alias[1]!] ?? v, depth + 1);
  };
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, resolve(v)]));
}

const T = tokens(CSS);

describe('the tokens the stylesheet declares', () => {
  it('carries both dialects the screens grew up with, resolving to ONE value each', () => {
    expect(T['--good']).toBe(T['--ok']);
    expect(T['--accent']).toBe(T['--ok']);
    expect(T['--warn']).toBe(T['--degraded']);
    expect(T['--danger']).toBe(T['--error']);
    expect(T['--accent-ink']).toBe(T['--on-accent']);
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

describe('every text pair a screen renders meets WCAG 2.2 AA', () => {
  const pairs: PalettePair[] = [
    { name: 'body text on the page', foreground: T['--ink']!, background: T['--bg']! },
    { name: 'body text on a panel', foreground: T['--ink']!, background: T['--panel']! },
    { name: 'body text on a plain button', foreground: T['--ink']!, background: T['--line']! },
    { name: 'muted text on a panel', foreground: T['--muted']!, background: T['--panel']! },
    { name: 'muted text on the page', foreground: T['--muted']!, background: T['--bg']! },
    { name: 'muted text on a dark input', foreground: T['--muted']!, background: T['--panel-2']! },
    { name: 'the primary button', foreground: T['--on-accent']!, background: T['--accent']! },
    { name: 'the SAMPLE DATA strip', foreground: T['--on-warn']!, background: T['--degraded']! },
    { name: 'the served-from-cache strip', foreground: T['--on-info-surface']!, background: T['--info-surface']! },
    { name: 'the nobody-signed-in strip', foreground: T['--on-nobody-surface']!, background: T['--nobody-surface']! },
    { name: 'red words on a panel', foreground: T['--danger-text']!, background: T['--panel']! },
    { name: 'red words on the page', foreground: T['--danger-text']!, background: T['--bg']! },
    { name: 'a red button or banner', foreground: T['--on-danger']!, background: T['--danger-surface']! },
    { name: 'amber words on a panel (attention)', foreground: T['--degraded']!, background: T['--panel']! },
    { name: 'green words on a panel', foreground: T['--ok']!, background: T['--panel']! },
    { name: 'blue words on a panel', foreground: T['--info']!, background: T['--panel']! },
    { name: 'the current tab (page colour on ink)', foreground: T['--bg']!, background: T['--ink']! },
    { name: 'the skip link', foreground: T['--bg']!, background: T['--ink']! },
    { name: 'white words on an idle surface', foreground: T['--ink']!, background: T['--idle']! },
  ];

  it('all of them, named — and the report names the worst', () => {
    const report = checkPalette(pairs);
    expect(report.failures.map((f) => `${(f as { name?: string }).name}: ${f.detail}`)).toEqual([]);
    expect(report.passes).toBe(true);
    expect(report.worst).toBeDefined();
  });

  it('proves the red split is necessary: the signal red fails BOTH text jobs, which is why there are three reds', () => {
    // If this ever passes, a future palette may collapse the three back into one — and should.
    expect(checkContrast({ foreground: T['--error']!, background: T['--panel']! }).passes).toBe(false);
    expect(checkContrast({ foreground: T['--on-danger']!, background: T['--error']! }).passes).toBe(false);
    expect(checkContrast({ foreground: T['--danger-text']!, background: T['--panel']! }).passes).toBe(true);
    expect(checkContrast({ foreground: T['--on-danger']!, background: T['--danger-surface']! }).passes).toBe(true);
  });
});

describe('the signals that are not words meet the 3:1 non-text bar on a panel', () => {
  it('the four sync-badge dots, the focus ring and the info edge', () => {
    for (const [name, fg] of [['ok', T['--ok']], ['degraded', T['--degraded']], ['error', T['--error']], ['idle', T['--idle']], ['info', T['--info']], ['focus ring', T['--focus']]] as const) {
      const on = checkContrast({ foreground: fg!, background: T['--panel']!, size: 'non_text' });
      expect(on.passes, `${name} dot on a panel: ${on.detail}`).toBe(true);
      expect(on.required).toBe(WCAG.aaNonText);
    }
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
