import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { chartModel, drawChart, CHART_WORDS, type ChartSpec, type ChartDocument, type ChartNode } from '../../packages/ui/src/charts';
import { checkContrast, WCAG } from '../../packages/a11y/src/contrast';

/**
 * **The one chart drawing is honest (UI-3 · P-08 · NFR-07/08 · design system §4.4).**
 *
 * The owner app and the report pages draw a figure over time or a comparison as a simple chart. These are the rules a
 * chart must keep before anybody quotes from it: bars measured from zero against the largest, a figure that was not read
 * is "Not known" and has NO bar (never a nought), a value below zero is drawn differently and keeps its minus sign in the
 * words, the chart never formats a figure itself, every word in English and Tamil, a table behind every chart drawn from
 * the same rows, and every colour a token that reads in both the light and the dark set.
 */

const spec = (rows: ChartSpec['rows'], kind: ChartSpec['kind'] = 'bars'): ChartSpec => ({
  id: 't', kind, title: { en: 'Takings by hour', ta: 'மணி வாரியாக வசூல்' }, covers: 'Main store · 1 Nov 2026',
  labelHeading: 'Hour', valueHeading: 'Taken', rows,
});

describe('the chart model', () => {
  it('measures every bar from zero against the largest figure', () => {
    const m = chartModel(spec([
      { key: 'a', label: 'A', value: 40_000, text: '₹400.00' },
      { key: 'b', label: 'B', value: 10_000, text: '₹100.00' },
      { key: 'c', label: 'C', value: 0, text: '₹0.00' },
    ]));
    expect(m.rows.map((r) => r.pct)).toEqual([100, 25, 0]);
    expect(m.rows.map((r) => r.text)).toEqual(['₹400.00', '₹100.00', '₹0.00']);
    expect(m.unknownCount).toBe(0);
  });

  it('draws a figure that was not read as "Not known" with no bar — never as nought — and counts it', () => {
    const m = chartModel(spec([
      { key: 'a', label: 'A', value: 500, text: '₹5.00' },
      { key: 'b', label: 'B', value: null },
      { key: 'c', label: 'C', value: undefined },
      { key: 'd', label: 'D', value: Number.NaN },
    ]));
    expect(m.rows.map((r) => [r.known, r.text, r.pct])).toEqual([[true, '₹5.00', 100], [false, 'Not known', 0], [false, 'Not known', 0], [false, 'Not known', 0]]);
    expect(m.unknownCount).toBe(3);
    // Tamil words for the same gap
    expect(chartModel(spec([{ key: 'b', label: 'B', value: null }]), 'ta').rows[0]!.text).toBe('தெரியவில்லை');
  });

  it('keeps a value below zero below zero — measured by its size, marked as negative, its minus sign in the words', () => {
    const m = chartModel(spec([
      { key: 'up', label: 'Up', value: 2_000, text: '₹20.00' },
      { key: 'down', label: 'Down', value: -4_000, text: '−₹40.00' },
    ]));
    expect(m.rows.map((r) => [r.pct, r.negative, r.text])).toEqual([[50, false, '₹20.00'], [100, true, '−₹40.00']]);
  });

  it('never formats a figure itself: a known figure with no words is refused', () => {
    expect(() => chartModel(spec([{ key: 'a', label: 'A', value: 12 }]))).toThrow(/no words for it/);
  });

  it('every word in English and Tamil, the page\'s own words in the reader\'s language', () => {
    for (const key of Object.keys(CHART_WORDS.en)) expect(CHART_WORDS.ta[key], key).toBeTruthy();
    expect(Object.keys(CHART_WORDS.ta).sort()).toEqual(Object.keys(CHART_WORDS.en).sort());
    expect(chartModel(spec([]), 'ta').title).toBe('மணி வாரியாக வசூல்');
    expect(chartModel(spec([]), 'en').title).toBe('Takings by hour');
  });

  it('an empty chart says nothing was read — it is never an all-clear', () => {
    const m = chartModel(spec([]));
    expect(m.empty).toBe(true);
    expect(m.emptyText).toMatch(/does not mean the figure is nought/);
  });

  it('labels every column when there are few, and every k-th when there are many (a phone cannot hold 24 labels)', () => {
    const hours = Array.from({ length: 24 }, (_, h) => ({ key: String(h), label: `${h}`, value: h, text: String(h) }));
    expect(chartModel(spec(hours.slice(0, 12), 'columns')).labelEvery).toBe(1);
    expect(chartModel(spec(hours, 'columns')).labelEvery).toBe(3);
  });
});

/** A tiny stand-in document: enough to prove the drawing's structure without a browser (the browser tests prove the look). */
function fakeDoc(): ChartDocument {
  const make = (tag: string, ns?: string): ChartNode & { tag: string; ns?: string; attrs: Record<string, string>; children: unknown[]; listeners: Record<string, () => void>; classes: Set<string> } => {
    const node = {
      tag, ns, attrs: {} as Record<string, string>, children: [] as unknown[], listeners: {} as Record<string, () => void>, classes: new Set<string>(),
      textContent: null as string | null, hidden: false, dataset: {} as Record<string, string | undefined>,
      get className(): string { return [...node.classes].join(' '); },
      set className(v: string) { node.classes = new Set(v.split(' ').filter(Boolean)); },
      setAttribute(n: string, v: string) { node.attrs[n] = v; },
      append(...n: unknown[]) { node.children.push(...n); },
      addEventListener(t: string, fn: () => void) { node.listeners[t] = fn; },
      classList: { toggle: (name: string, force?: boolean) => { const on = force ?? !node.classes.has(name); if (on) node.classes.add(name); else node.classes.delete(name); return on; } },
    };
    return node as never;
  };
  return { createElement: (t) => make(t), createElementNS: (ns, t) => make(t, ns) };
}
type Fake = { tag: string; ns?: string; attrs: Record<string, string>; children: Fake[]; textContent: string | null; hidden: boolean; className: string; listeners: Record<string, () => void>; dataset: Record<string, string> };
const all = (n: Fake): Fake[] => [n, ...n.children.flatMap(all)];

describe('the drawing', () => {
  it('hides the picture from screen readers and puts the same figures in a table, row for row', () => {
    const fig = drawChart(fakeDoc(), null, spec([
      { key: 'a', label: 'Grocery', value: 900, text: '₹9.00' },
      { key: 'b', label: 'Dairy', value: null },
    ])) as unknown as Fake;
    const nodes = all(fig);
    const drawing = nodes.find((n) => n.className.includes('sre-chart-drawing'))!;
    expect(drawing.attrs['aria-hidden']).toBe('true');
    // one bar — for the known row only
    expect(nodes.filter((n) => n.tag === 'rect').length).toBe(1);
    expect(nodes.filter((n) => n.tag === 'svg').every((n) => n.ns === 'http://www.w3.org/2000/svg')).toBe(true);
    const cells = nodes.filter((n) => n.tag === 'tbody').flatMap((b) => b.children).map((tr) => tr.children.map((c) => c.textContent));
    expect(cells).toEqual([['Grocery', '₹9.00'], ['Dairy', 'Not known']]);
    // the caption of the table says what it covers
    expect(nodes.find((n) => n.tag === 'caption')!.textContent).toBe('Takings by hour — Main store · 1 Nov 2026');
    expect(nodes.find((n) => n.className.includes('sre-chart-gap'))!.textContent).toMatch(/^1 without a figure/);
  });

  it('one button shows the table in place of the picture, and back — and says which it is', () => {
    const fig = drawChart(fakeDoc(), null, spec([{ key: 'a', label: 'A', value: 1, text: '1' }])) as unknown as Fake;
    const nodes = all(fig);
    const toggle = nodes.find((n) => n.tag === 'button')!;
    const wrap = nodes.find((n) => n.className.includes('sre-chart-table-wrap'))!;
    const drawing = nodes.find((n) => n.className.includes('sre-chart-drawing'))!;
    expect([toggle.textContent, toggle.attrs['aria-pressed'], wrap.className.includes('sr-only'), drawing.hidden]).toEqual(['Show the figures as a table', 'false', true, false]);
    toggle.listeners['click']!();
    expect([toggle.textContent, toggle.attrs['aria-pressed'], wrap.className.includes('sr-only'), drawing.hidden]).toEqual(['Show the chart', 'true', false, true]);
    toggle.listeners['click']!();
    expect(wrap.className.includes('sr-only')).toBe(true);
  });

  it('a figure over a column near either edge lines up with that edge, so it never pokes past a phone screen\'s side', () => {
    const days = Array.from({ length: 6 }, (_, i) => ({ key: `d${i}`, label: `${i + 1}`, value: i === 5 ? 2500 : 100, text: `₹${i}` }));
    const cols = all(drawChart(fakeDoc(), null, spec(days, 'columns')) as unknown as Fake).filter((n) => n.className.split(' ').includes('sre-chart-col'));
    expect(cols.map((c) => (c.className.includes('sre-chart-col-start') ? 'start' : c.className.includes('sre-chart-col-end') ? 'end' : 'mid'))).toEqual(['start', 'start', 'mid', 'mid', 'end', 'end']);
    const css = readFileSync('packages/ui/web/sre-foundation.css', 'utf8');
    expect(css).toContain('.sre-chart-col-start > .sre-chart-top { justify-self: start; }');
    expect(css).toContain('.sre-chart-col-end > .sre-chart-top { justify-self: end; }');
    // the column's own track is held to the column's width — otherwise a wide figure widens the track past the column
    expect(css).toMatch(/\.sre-chart-col \{ display: grid; grid-template-columns: minmax\(0, 1fr\);/);
  });

  it('draws no picture at all for an empty chart — only the words that nothing was read', () => {
    const nodes = all(drawChart(fakeDoc(), null, spec([])) as unknown as Fake);
    expect(nodes.some((n) => n.tag === 'svg')).toBe(false);
    expect(nodes.find((n) => n.className === 'sre-chart-empty')!.textContent).toMatch(/nothing is drawn/);
  });
});

describe('the chart colours are tokens that read in both sets', () => {
  const CSS = readFileSync('packages/ui/web/sre-foundation.css', 'utf8');
  const clean = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const tokens = (theme: 'light' | 'dark'): Record<string, string> => {
    const light = /:root\s*{([^}]*)}/.exec(clean)?.[1] ?? '';
    const dark = /:root\[data-theme="dark"\]\s*{([^}]*)}/.exec(clean)?.[1] ?? '';
    const raw: Record<string, string> = {};
    for (const block of theme === 'dark' ? [light, dark] : [light]) for (const [, n, v] of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) raw[n!] = v!.trim();
    const resolve = (v: string, d = 0): string => { const a = /^var\((--[a-z0-9-]+)\)$/.exec(v); return !a || d > 5 ? v : resolve(raw[a[1]!] ?? v, d + 1); };
    return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, resolve(v)]));
  };
  const chartCss = clean.slice(clean.indexOf('.sre-chart {'));

  it('uses only foundation tokens — no colour of its own', () => {
    expect(chartCss).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
  });

  for (const theme of ['light', 'dark'] as const) {
    it(`reads in the ${theme} set: words at AA, the bar against its track and the panel at the non-text bar`, () => {
      const T = tokens(theme);
      for (const [fg, bg] of [['--ink', '--panel'], ['--warn', '--panel'], ['--muted', '--panel']] as const) {
        const c = checkContrast({ foreground: T[fg]!, background: T[bg]! });
        expect(c.passes, `${theme} ${fg} on ${bg}: ${c.detail}`).toBe(true);
      }
      for (const [fg, bg] of [['--accent', '--panel-2'], ['--accent', '--panel'], ['--error', '--panel']] as const) {
        const c = checkContrast({ foreground: T[fg]!, background: T[bg]!, required: WCAG.aaNonText });
        expect(c.passes, `${theme} ${fg} on ${bg}: ${c.detail}`).toBe(true);
      }
    });
  }
});
