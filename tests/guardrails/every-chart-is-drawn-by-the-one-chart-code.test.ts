import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { screenAppDirs } from '../../scripts/sync-ui-foundation.mjs';

/**
 * **Every chart is drawn by the one chart code, offline, with its source said (UI-3 · P-01 · P-08 · design system §4.4).**
 *
 * The owner app and the report pages draw a figure over time or a comparison as a simple chart. A chart is the easiest
 * place for a screen to start lying — a library fetched from the internet that is not there when the line is down, a
 * bar drawn for a figure nobody read, a picture with no words behind it. So:
 *
 *   1. charts are drawn ONLY by `packages/ui/src/charts.ts` (inline SVG, in each app's own bundle — which every service
 *      worker already precaches), never by a library: no screen loads a script from the internet, and no screen's own
 *      script draws an SVG (the icon guardrail keeps that rule; this file keeps the chart side of it);
 *   2. the chart code reaches nothing on the network and writes no markup as text;
 *   3. the drawing is hidden from screen readers and a table of the same rows is always drawn behind it;
 *   4. every page that draws a chart says what it covers (`covers:`) — a chart never floats free of its dates and store;
 *   5. both bundles that serve chart pages put it on the page (`attachCharts`).
 */

const CHARTS = readFileSync('packages/ui/src/charts.ts', 'utf8');
const code = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const apps = screenAppDirs();
const files = (ext: string): string[] => apps.flatMap((a) => readdirSync(`apps/${a}/web`).filter((f) => f.endsWith(ext) && !f.endsWith('.bundle.js')).map((f) => `apps/${a}/web/${f}`));

describe('the one chart code', () => {
  it('needs no network and writes no markup as text', () => {
    expect(code(CHARTS)).not.toMatch(/\bfetch\(|XMLHttpRequest|import\(|https?:\/\/(?!www\.w3\.org\/2000\/svg)|url\(|innerHTML|outerHTML|insertAdjacentHTML/);
  });

  it('hides the picture from screen readers and always draws the table of the same rows', () => {
    const c = code(CHARTS);
    expect(c).toMatch(/drawing\.setAttribute\('aria-hidden', 'true'\)/);
    expect(c).toMatch(/el\('table', 'sre-chart-table'\)/);
    expect(c).toMatch(/for \(const row of model\.rows\) \{\s*const tr = el\('tr'\)/);
  });

  it('draws nothing for a figure that was not read', () => {
    // Only a KNOWN row with a length gets a bar; the unknown row's words are the chart's own "Not known".
    expect(code(CHARTS).match(/if \(row\.known && row\.pct > 0\)/g)?.length).toBe(2);
  });

  it('no screen loads a script or a chart library from the internet', () => {
    for (const page of files('.html')) {
      const html = readFileSync(page, 'utf8');
      expect(html, `${page} loads a script from the internet`).not.toMatch(/<script[^>]+src="(https?:)?\/\//);
      expect(html, `${page} names a chart library`).not.toMatch(/\b(chart\.js|chartjs|d3\.v\d|echarts|highcharts|apexcharts|plotly)\b/i);
    }
  });

  it('every page that draws a chart says what it covers', () => {
    const drawing = files('.js').filter((f) => /sreCharts\??\.draw\(/.test(readFileSync(f, 'utf8')));
    expect(drawing.length, 'no page draws a chart — the detector found nothing').toBeGreaterThan(0);
    for (const f of drawing) expect(code(readFileSync(f, 'utf8')), `${f} draws a chart without saying what it covers`).toMatch(/covers:/);
  });

  it('is put on the page by the bundles of the apps that draw charts', () => {
    for (const entry of ['apps/web-erp/src/browser-entry.ts', 'apps/owner-app/src/browser-entry.ts']) {
      expect(code(readFileSync(entry, 'utf8')), entry).toMatch(/attachCharts\(/);
    }
  });

  it('tripwire — the network detector fires', () => {
    expect(/\bfetch\(|innerHTML/.test("fetch('x')")).toBe(true);
  });
});
