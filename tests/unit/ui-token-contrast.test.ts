import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { checkPalette, type PalettePair } from '../../packages/a11y/src/contrast';

/**
 * **The refined look's key pairs meet WCAG 2.2 AA (OB-201 · design system §3.4 · NFR-07).**
 *
 * OB-201 polished the owner's approved sage look and added the tokens its components need: a hover surface, a body
 * text one step quieter than a heading, the primary action's hover and pressed shades, a stronger field edge, a red
 * button's hover, and the tinted status chips and badge. Each is a PAIR on the screen, and AA is a property of pairs —
 * so this reads the tokens out of the stylesheet itself (never a copy) and proves the words on every surface they are
 * drawn on at 4.5:1, and every edge, ring and icon that carries meaning at 3:1, in BOTH token sets.
 * (tests/unit/ui-foundation.test.ts keeps the pairs the look had before OB-201.)
 */

const CSS = readFileSync('packages/ui/web/sre-foundation.css', 'utf8');

function tokens(theme: 'light' | 'dark'): Record<string, string> {
  const clean = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const light = /\n:root \{([^}]*)\}/.exec(clean)?.[1] ?? '';
  const dark = /\n:root\[data-theme="dark"\] \{([^}]*)\}/.exec(clean)?.[1] ?? '';
  const raw: Record<string, string> = {};
  for (const body of theme === 'dark' ? [light, dark] : [light]) {
    for (const [, k, v] of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) raw[k!] = v!.trim();
  }
  const resolve = (v: string, depth = 0): string => {
    const alias = /^var\((--[a-z0-9-]+)\)$/.exec(v);
    return alias && depth < 6 ? resolve(raw[alias[1]!] ?? v, depth + 1) : v;
  };
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, resolve(v)]));
}
const SETS = [['light', tokens('light')], ['dark', tokens('dark')]] as const;

const text = (S: Record<string, string>): PalettePair[] => [
  // words on every surface
  { name: 'heading ink on the page', foreground: S['--ink']!, background: S['--bg']! },
  { name: 'heading ink on a panel', foreground: S['--ink']!, background: S['--panel']! },
  { name: 'ink on a row under the pointer', foreground: S['--ink']!, background: S['--hover']! },
  { name: 'ink on a selected row', foreground: S['--ink']!, background: S['--mint']! },
  { name: 'body copy on a panel', foreground: S['--ink-2']!, background: S['--panel']! },
  { name: 'body copy on the page', foreground: S['--ink-2']!, background: S['--bg']! },
  { name: 'secondary words on a panel', foreground: S['--muted']!, background: S['--panel']! },
  { name: 'secondary words on a row under the pointer', foreground: S['--muted']!, background: S['--hover']! },
  { name: 'secondary words on a register head', foreground: S['--muted']!, background: S['--panel-2']! },
  // the buttons, at rest, under the pointer and pressed
  { name: 'primary button', foreground: S['--on-accent']!, background: S['--accent']! },
  { name: 'primary button under the pointer', foreground: S['--on-accent']!, background: S['--accent-hover']! },
  { name: 'primary button pressed', foreground: S['--on-accent']!, background: S['--accent-press']! },
  { name: 'secondary button', foreground: S['--ink']!, background: S['--panel']! },
  { name: 'secondary button under the pointer', foreground: S['--ink']!, background: S['--hover']! },
  { name: 'quiet button', foreground: S['--muted']!, background: S['--panel']! },
  { name: 'quiet button under the pointer', foreground: S['--ink']!, background: S['--panel-2']! },
  { name: 'danger button', foreground: S['--on-danger']!, background: S['--danger-surface']! },
  { name: 'danger button under the pointer', foreground: S['--on-danger']!, background: S['--danger-hover']! },
  // the status chips and the badge: the words on their own tint
  { name: 'chip ok', foreground: S['--on-ok-surface']!, background: S['--ok-surface']! },
  { name: 'chip pending / degraded / not known', foreground: S['--on-warn-surface']!, background: S['--warn-surface']! },
  { name: 'chip error', foreground: S['--danger-text']!, background: S['--error-surface']! },
  { name: 'chip idle', foreground: S['--muted']!, background: S['--panel-2']! },
  { name: 'badge idle', foreground: S['--ink']!, background: S['--panel-2']! },
  { name: 'a not-known figure on a panel', foreground: S['--degraded']!, background: S['--panel']! },
  // the rail
  { name: 'a screen on the rail', foreground: S['--on-rail']!, background: S['--rail']! },
  { name: 'the current screen on the rail', foreground: S['--on-rail']!, background: S['--rail-2']! },
  { name: 'a workspace heading on the rail', foreground: S['--on-rail-muted']!, background: S['--rail']! },
];

const nonText = (S: Record<string, string>): PalettePair[] => [
  // the ring and shape of a status dot, on the chip it sits in, and on a plain header
  { name: 'ok ring on its chip', foreground: S['--ok']!, background: S['--ok-surface']! },
  { name: 'amber ring on its chip', foreground: S['--degraded']!, background: S['--warn-surface']! },
  { name: 'red ring on its chip (the badge draws it in the readable red)', foreground: S['--danger-text']!, background: S['--error-surface']! },
  { name: 'idle ring on its chip', foreground: S['--idle']!, background: S['--panel-2']! },
  { name: 'ok ring on the header', foreground: S['--ok']!, background: S['--panel']! },
  { name: 'amber ring on the header', foreground: S['--degraded']!, background: S['--panel']! },
  { name: 'red ring on the header (the till, the handhelds)', foreground: S['--error']!, background: S['--panel']! },
  { name: 'idle ring on the header', foreground: S['--idle']!, background: S['--panel']! },
  // a chip's tone edge on the page it sits on
  { name: 'chip ok edge on a panel', foreground: S['--ok']!, background: S['--panel']! },
  { name: 'chip error edge on a panel', foreground: S['--error']!, background: S['--panel']! },
  // the edge of a field, the focus ring, an icon on the rail
  { name: 'a field\'s edge on a panel', foreground: S['--field-line']!, background: S['--panel']! },
  { name: 'a field\'s edge on the page', foreground: S['--field-line']!, background: S['--bg']! },
  { name: 'the focus ring on a panel', foreground: S['--focus']!, background: S['--panel']! },
  { name: 'the focus ring on the page', foreground: S['--focus']!, background: S['--bg']! },
  { name: 'a screen\'s icon on the rail', foreground: S['--on-rail-muted']!, background: S['--rail']! },
  { name: 'the current screen\'s icon and mark on the rail', foreground: S['--rail-accent']!, background: S['--rail-2']! },
  { name: 'a secondary icon (search, globe) on a panel', foreground: S['--muted']!, background: S['--panel']! },
];

describe('the refined look\'s key pairs (OB-201), in both sets', () => {
  it.each(SETS)('%s set — every word on every surface it is drawn on reaches 4.5:1', (_n, S) => {
    const report = checkPalette(text(S));
    expect(report.failures.map((f) => `${(f as { name?: string }).name}: ${f.detail}`)).toEqual([]);
  });

  it.each(SETS)('%s set — every edge, ring and icon that carries meaning reaches 3:1', (_n, S) => {
    const report = checkPalette(nonText(S).map((p) => ({ ...p, size: 'non_text' as const })));
    expect(report.failures.map((f) => `${(f as { name?: string }).name}: ${f.detail}`)).toEqual([]);
  });

  it('every token a pair names is declared — a missing token is a failure, not a pass', () => {
    for (const [name, S] of SETS) {
      for (const p of [...text(S), ...nonText(S)]) {
        expect(p.foreground, `${name}: ${p.name} foreground`).toMatch(/^#[0-9a-f]{6}$/i);
        expect(p.background, `${name}: ${p.name} background`).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  it('tripwire — the check fails a pair that is too faint', () => {
    expect(checkPalette([{ name: 'faint', foreground: '#dce3de', background: '#ffffff' }]).passes).toBe(false);
    expect(checkPalette([{ name: 'faint edge', foreground: '#dce3de', background: '#ffffff', size: 'non_text' }]).passes).toBe(false);
  });
});
