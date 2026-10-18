import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * **The shared look's scale, and its motion, are the foundation's — once (OB-201 "Style A", 18 Oct 2026 · design
 * system §3.4).**
 *
 * The owner asked for the approved sage look made "premium, crisp, polished, smooth" without a new palette: a
 * disciplined spacing scale, a crisp type scale, hairline borders and a soft layered elevation, one radius scale,
 * smooth and restrained motion, better focus, and tabular figures for money and quantities. This file pins that the
 * foundation (`packages/ui/web/sre-foundation.css`, copied to every screen) defines each scale as tokens, and that its
 * motion is short, ease-out, on opacity and transform only, absent for a person who asked for less, and absent from
 * the till's scan and total.
 */

const CSS = readFileSync('packages/ui/web/sre-foundation.css', 'utf8');
const CLEAN = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
const block = (re: RegExp): string => re.exec(CLEAN)?.[1] ?? '';
const LIGHT = block(/\n:root \{([^}]*)\}/);
const DARK = block(/\n:root\[data-theme="dark"\] \{([^}]*)\}/);
const tokensOf = (body: string): Record<string, string> => Object.fromEntries([...body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
const T = tokensOf(LIGHT);
const D = tokensOf(DARK);
const px = (v: string | undefined): number => Number(/^([\d.]+)px$/.exec(v ?? '')?.[1] ?? NaN);
const ms = (v: string | undefined): number => Number(/^(\d+)ms$/.exec(v ?? '')?.[1] ?? NaN);

/** Every rule as [selectors, body], media blocks included (their inner rules), keyframes excluded. */
function rules(css: string): [string, string][] {
  const out: [string, string][] = [];
  const noFrames = css.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  for (const m of noFrames.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) out.push([m[1]!.trim(), m[2]!]);
  return out;
}
const RULES = rules(CLEAN);
const KEYFRAMES = [...CLEAN.matchAll(/@keyframes ([a-z-]+) \{((?:[^{}]*\{[^{}]*\})*)[^{}]*\}/g)].map((m) => ({ name: m[1]!, body: m[2]! }));

describe('the scales are tokens, in the light set (and the dark set keeps the elevation)', () => {
  it('a 4px spacing scale, rising', () => {
    const steps = ['--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--space-6', '--space-8', '--space-10'].map((k) => px(T[k]));
    expect(steps).toEqual([4, 8, 12, 16, 20, 24, 32, 40]);
    for (const s of steps) expect(s % 4).toBe(0);
    // the two names the screens grew up with sit ON the scale
    expect(px(T['--gap'])).toBe(px(T['--space-3']));
    expect(px(T['--pad'])).toBe(px(T['--space-4']));
  });

  it('a type scale that rises step by step, nothing a person reads under 14px, 12.5px for uppercase labels only', () => {
    const scale = ['--fs-sm', '--fs-base', '--fs-md', '--fs-lg', '--fs-xl', '--fs-2xl', '--fs-figure'].map((k) => px(T[k]));
    expect(scale.every((v, i) => i === 0 || v > scale[i - 1]!)).toBe(true);
    expect(Math.min(...scale)).toBe(14);
    expect(px(T['--fs-label'])).toBe(12.5);
    expect(px(T['--fs-base'])).toBe(px(T['--text']));
    expect(T['--leading-tight']).toBe('1.25');
    expect(T['--numbers']).toBe('tabular-nums lining-nums');
  });

  it('one radius scale — compact, as the owner\'s reference — and a pill', () => {
    const radii = ['--radius-sm', '--radius', '--radius-lg', '--radius-xl'].map((k) => px(T[k]));
    expect(radii).toEqual([4, 6, 8, 12]);
    expect(T['--radius-pill']).toBe('999px');
  });

  it('hairline borders and a soft, layered elevation: low opacity, tinted with the rail\'s forest, in both sets', () => {
    expect(T['--hairline']).toBe('1px');
    for (const set of [T, D]) {
      for (const k of ['--shadow-xs', '--shadow-sm', '--shadow-md', '--shadow-lg']) expect(set[k], k).toBeDefined();
    }
    for (const k of ['--shadow-sm', '--shadow-md', '--shadow-lg']) {
      const layers = T[k]!.split(/,(?![^(]*\))/);
      expect(layers.length, `${k} is two layers`).toBe(2);
      for (const layer of layers) {
        const alpha = Number(/rgba\(25, 47, 39, ([\d.]+)\)/.exec(layer)?.[1]);
        expect(alpha, `${k}: ${layer}`).toBeLessThanOrEqual(0.2);
      }
    }
  });

  it('motion durations of 120–200ms and an ease-out curve', () => {
    for (const k of ['--dur-fast', '--dur', '--dur-slow']) {
      expect(ms(T[k]), k).toBeGreaterThanOrEqual(120);
      expect(ms(T[k]), k).toBeLessThanOrEqual(200);
    }
    // a curve that starts fast and settles: the first control point rises above the diagonal
    const [x1, y1] = (/cubic-bezier\(([\d.]+), ([\d.]+), [\d.]+, [\d.]+\)/.exec(T['--ease-out'] ?? '') ?? []).slice(1).map(Number);
    expect(y1!).toBeGreaterThan(x1!);
  });

  it('a 3px focus ring, 2px clear of the control, with a soft halo on a field', () => {
    expect(CLEAN).toMatch(/\n:focus-visible \{ outline: 3px solid var\(--focus\); outline-offset: 2px; \}/);
    expect(CLEAN).toMatch(/input:focus-visible, select:focus-visible, textarea:focus-visible \{ box-shadow: 0 0 0 4px var\(--focus-halo\); \}/);
    expect(T['--focus-halo']).toMatch(/^rgba\(/);
  });

  it('tabular figures for money and quantities, on the classes the screens already use and on every register', () => {
    expect(CLEAN).toMatch(/\.tabular, \.money, \.qty, \.amount, \.total, \.n, \.sre-num \{ font-variant-numeric: var\(--numbers\); \}/);
    expect(RULES.find(([s]) => s === '.sre-register')?.[1]).toMatch(/font-variant-numeric: tabular-nums/);
  });

  it('is not a new palette: every colour the owner approved (OB-13) is the value it was', () => {
    expect(T).toMatchObject({ '--bg': '#f3f5f4', '--panel': '#ffffff', '--ink': '#25362e', '--ok': '#16614d', '--degraded': '#8a5e1b', '--danger-text': '#a03e36', '--rail': '#192f27', '--line': '#dce3de', '--muted': '#53625a', '--focus': '#0f4c3a' });
  });
});

describe('motion: short, ease-out, opacity and transform only — and never for a person who asked for less', () => {
  it('every transition moves only transform or opacity, timed by a duration token', () => {
    const transitions = RULES.flatMap(([sel, body]) => [...body.matchAll(/transition:\s*([^;]+);/g)].map((m) => ({ sel, value: m[1]!.trim() })))
      .filter((t) => !t.sel.includes('*')); // the reduced-motion reset
    expect(transitions.length).toBeGreaterThan(0);
    for (const { sel, value } of transitions) {
      for (const part of value.split(/,(?![^(]*\))/)) expect(part.trim(), sel).toMatch(/^(transform|opacity) var\(--dur(-fast|-slow)?\) var\(--ease-(out|in-out)\)$/);
    }
  });

  it('every animation is a keyframe of opacity and transform only, timed by a token — the skeleton\'s slow pulse the one loop', () => {
    expect(KEYFRAMES.length).toBeGreaterThan(0);
    for (const { name, body } of KEYFRAMES) {
      const props = [...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
      expect(props.filter((p) => p !== 'opacity' && p !== 'transform'), `@keyframes ${name}`).toEqual([]);
    }
    for (const [sel, body] of RULES) {
      for (const m of body.matchAll(/animation:\s*([^;]+);/g)) {
        if (sel.includes('*') || /none/.test(m[1]!)) continue;
        if (sel === '.sre-skeleton') { expect(m[1]).toMatch(/^sre-pulse /); continue; }
        expect(m[1]!.trim(), sel).toMatch(/^sre-[a-z-]+ var\(--dur(-fast|-slow)?\) var\(--ease-out\) both$/);
      }
    }
  });

  it('entering words never fade — they move in fully opaque; only the scrim (no words) and the skeleton (no words) change opacity', () => {
    for (const { name, body } of KEYFRAMES) {
      if (/opacity/.test(body)) expect(['sre-fade', 'sre-pulse'], `@keyframes ${name} fades`).toContain(name);
    }
    for (const [sel, body] of RULES) {
      if (/animation:\s*sre-fade\b/.test(body)) expect(sel).toBe('.sre-scrim');
      if (/animation:\s*sre-pulse\b/.test(body)) expect(sel).toBe('.sre-skeleton');
    }
  });

  it('a person who asked for less motion gets none: the duration tokens go to zero and every animation and transition stops', () => {
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(CLEAN)?.[1] ?? '';
    expect(reduced).toMatch(/:root \{ --dur-fast: 0ms; --dur: 0ms; --dur-slow: 0ms; \}/);
    expect(reduced).toMatch(/animation-duration: \.01ms !important;/);
    expect(reduced).toMatch(/transition-duration: \.01ms !important;/);
    expect(reduced).toMatch(/\.sre-skeleton \{ animation: none !important; \}/);
  });

  it('nothing animates on the till\'s scan or total: every animated rule is a named shared component or the back office\'s shell', () => {
    const ALLOWED = /^(\.sre-(btn|tab|update|toast|skeleton|scrim|menu)\b|body\.sre-shell )/;
    for (const [sel, body] of RULES) {
      if (!/(^|[;\s])(transition|animation)(-name)?:/.test(body) || sel.includes('*')) continue;
      for (const one of sel.split(',')) expect(one.trim(), `${sel} animates`).toMatch(ALLOWED);
    }
    // the till's own page sets no motion, and its scan and total never wear an animated class
    const till = readFileSync('apps/pos/web/index.html', 'utf8');
    const tillStyle = /<style>([\s\S]*?)<\/style>/.exec(till)?.[1] ?? '';
    expect(tillStyle).not.toMatch(/transition|animation/);
    const tillCode = readFileSync('apps/pos/web/app.js', 'utf8') + till;
    expect(tillCode).not.toMatch(/sre-(tab|toast|skeleton)\b/);
    // and the bare tags the till's scan and total are made of are never given motion by the foundation
    for (const [sel, body] of RULES) {
      if (!/(transition|animation):/.test(body)) continue;
      expect(sel).not.toMatch(/(^|,\s*)(table|td|tr|button|input|\.total|\.entry|\.sheet)\b/);
    }
  });

  it('tripwire — the rule reader sees a forbidden transition and a forbidden keyframe', () => {
    const bad = rules('.x { transition: width 300ms linear; }');
    expect(bad[0]![1]).toMatch(/transition: width/);
    const frames = [...'@keyframes boom { from { height: 0; } to { height: 10px; } }'.matchAll(/@keyframes ([a-z-]+) \{((?:[^{}]*\{[^{}]*\})*)[^{}]*\}/g)];
    expect([...frames[0]![2]!.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1])).toEqual(['height', 'height']);
  });
});
