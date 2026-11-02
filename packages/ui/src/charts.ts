// The one chart drawing (UI-3 · P-01 · P-03 · P-08 · NFR-07/08 · design system §4.4).
//
// The owner said (1 Nov 2026) the owner app and the reports were hard to read. Where a figure over time or a comparison
// is the point — takings by hour, sales by department, waste by reason, branch against branch — a page may draw it as
// a simple chart. This is the only place a chart is drawn, so every chart in the product reads the same way:
//
//   • **No library and no network.** Inline SVG, built here and bundled into each app's own bundle (which every
//     service worker already precaches), so a chart opens with the line down exactly as the figures beside it (P-01).
//   • **Honest.** It draws only the values the page hands it — each one a real read — and draws nothing for a value it
//     was not given: that row says "Not known", never a zero-length bar that reads as nought (P-08). Bars start at
//     zero; a value below zero is drawn as an outline, with its minus sign in the words. No 3-D, no trimmed axis.
//   • **Colour is never the only signal.** One series, so colour carries no meaning; every bar has its value printed in
//     words beside it (the horizontal form) or in the table (the over-time form), and the highlighted bar has a word.
//   • **A table behind every chart.** The drawing is hidden from screen readers; the same figures sit in a real
//     `<table>` that a screen reader reads, and that anyone can show in place of the chart with one button.
//   • **Light and dark.** Every colour is a foundation token (`--accent`, `--line`, `--muted`, `--warn`), so the
//     dark set follows with no extra work.
//   • **English and Tamil.** The page passes its words as plain text or `{ en, ta }` and the reader's language.
//
// The arithmetic (how long each bar is) is a pure function, `chartModel`, tested on its own. `drawChart` turns the model
// into elements with a document it is handed, so importing this module never needs a browser.

export type ChartWords = string | { readonly en: string; readonly ta: string };
export type ChartLang = 'en' | 'ta';

export interface ChartRow {
  /** A stable key for the row (a branch id, an hour, a reason code). */
  readonly key: string;
  /** What the row is, in the reader's words. */
  readonly label: ChartWords;
  /** The figure as read — `null` or `undefined` when it is not known, which is drawn as "Not known", never as 0. */
  readonly value: number | null | undefined;
  /** The figure as the page writes it (₹1,234.00, 12 bills). Required when `value` is known: the chart never formats money. */
  readonly text?: string;
  /** A word for a highlighted row ("today", "now") — so a highlight is never colour alone. */
  readonly mark?: ChartWords;
}

export interface ChartSpec {
  /** Unique on the page; the figure carries it as `data-chart`. */
  readonly id: string;
  /** The chart's heading — what it shows. */
  readonly title: ChartWords;
  /** What it covers — the dates, the store, the scope — and when it was read. Required: a chart never floats free of its source. */
  readonly covers: ChartWords;
  /** `bars` (a comparison, one row each, longest first if the page sorts it so) or `columns` (a figure over time, in order). */
  readonly kind: 'bars' | 'columns';
  /** The table's two column headings. */
  readonly labelHeading: ChartWords;
  readonly valueHeading: ChartWords;
  readonly rows: readonly ChartRow[];
  /** Words for an empty chart — what it covers and that nothing was read (an empty chart is never "all clear"). */
  readonly empty?: ChartWords;
}

export interface ModelRow {
  readonly key: string;
  readonly label: string;
  readonly known: boolean;
  /** The words drawn for the value: the page's own text, or "Not known". */
  readonly text: string;
  /** Bar length as a share of the longest, 0–100, rounded to 0.1. 0 for an unknown row (and it has no bar at all). */
  readonly pct: number;
  readonly negative: boolean;
  readonly mark: string | null;
}

export interface ChartModel {
  readonly id: string;
  readonly kind: 'bars' | 'columns';
  readonly title: string;
  readonly covers: string;
  readonly labelHeading: string;
  readonly valueHeading: string;
  readonly rows: readonly ModelRow[];
  /** How many rows have no figure — said under the chart, so a gap is never silent. */
  readonly unknownCount: number;
  /** True when no row was given at all. */
  readonly empty: boolean;
  readonly emptyText: string;
  /** For the `columns` form: which rows carry a label under them (all when few, every k-th when many). */
  readonly labelEvery: number;
}

export const CHART_WORDS: Readonly<Record<ChartLang, Readonly<Record<string, string>>>> = Object.freeze({
  en: Object.freeze({
    notKnown: 'Not known',
    showTable: 'Show the figures as a table',
    showChart: 'Show the chart',
    unknownRows: '{n} without a figure — shown as "Not known", not as nought.',
    empty: 'Nothing was read for this chart, so nothing is drawn. This does not mean the figure is nought.',
  }),
  ta: Object.freeze({
    notKnown: 'தெரியவில்லை',
    showTable: 'எண்களை அட்டவணையாகக் காட்டு',
    showChart: 'வரைபடத்தைக் காட்டு',
    unknownRows: '{n} எண் இல்லாதவை — பூஜ்ஜியமாக அல்ல, "தெரியவில்லை" என்று காட்டப்பட்டுள்ளது.',
    empty: 'இந்த வரைபடத்திற்கு எதுவும் படிக்கப்படவில்லை, எனவே எதுவும் வரையப்படவில்லை. இது எண் பூஜ்ஜியம் என்று பொருளல்ல.',
  }),
});

export const chartSay = (words: ChartWords | undefined, lang: ChartLang): string =>
  words === undefined ? '' : typeof words === 'string' ? words : (words[lang] ?? words.en);

const known = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * The chart, worked out: each row's words and bar length. Pure — no clock, no document.
 *
 * Every bar is measured from zero against the largest magnitude, so two bars can be compared by eye and the shortest
 * is never stretched to look bigger than it is. An unknown row has no bar and the words "Not known".
 */
export function chartModel(spec: ChartSpec, lang: ChartLang = 'en'): ChartModel {
  const words = CHART_WORDS[lang];
  const max = spec.rows.reduce((m, r) => (known(r.value) ? Math.max(m, Math.abs(r.value)) : m), 0);
  const rows: ModelRow[] = spec.rows.map((r) => {
    const isKnown = known(r.value);
    if (isKnown && (r.text === undefined || r.text === '')) {
      throw new Error(`chart ${spec.id}: row ${r.key} has a figure but no words for it — the chart never formats a figure itself`);
    }
    const pct = !isKnown || max === 0 ? 0 : Math.round((Math.abs(r.value as number) / max) * 1000) / 10;
    return {
      key: r.key,
      label: chartSay(r.label, lang),
      known: isKnown,
      text: isKnown ? (r.text as string) : words['notKnown']!,
      pct,
      negative: isKnown && (r.value as number) < 0,
      mark: r.mark === undefined ? null : chartSay(r.mark, lang),
    };
  });
  const unknownCount = rows.filter((r) => !r.known).length;
  return {
    id: spec.id,
    kind: spec.kind,
    title: chartSay(spec.title, lang),
    covers: chartSay(spec.covers, lang),
    labelHeading: chartSay(spec.labelHeading, lang),
    valueHeading: chartSay(spec.valueHeading, lang),
    rows,
    unknownCount,
    empty: rows.length === 0,
    emptyText: spec.empty === undefined ? words['empty']! : chartSay(spec.empty, lang),
    labelEvery: rows.length <= 12 ? 1 : Math.ceil(rows.length / 8),
  };
}

// ── Drawing ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The few DOM calls the drawing needs — structural, so the module imports without a browser. */
export interface ChartNode {
  className: string;
  textContent: string | null;
  hidden: boolean;
  readonly dataset: Record<string, string | undefined>;
  setAttribute(name: string, value: string): void;
  append(...nodes: ChartNode[]): void;
  addEventListener(type: string, fn: () => void): void;
  readonly classList: { toggle(name: string, force?: boolean): boolean };
}
export interface ChartHost { replaceChildren(...nodes: ChartNode[]): void }
export interface ChartDocument {
  createElement(tag: string): ChartNode;
  createElementNS(ns: string, tag: string): ChartNode;
}

const SVG = 'http://www.w3.org/2000/svg';

/**
 * Draw a chart into `host` (its children are replaced) and return the figure.
 *
 * The figure: a caption (title, what it covers), the drawing (hidden from screen readers), a line naming any row with
 * no figure, the table of the same figures (read by screen readers; shown in place of the drawing by the button), and
 * the button. The table is never a second source — it is drawn from the same model, row for row.
 */
export function drawChart(doc: ChartDocument, host: ChartHost | null, spec: ChartSpec, lang: ChartLang = 'en'): ChartNode {
  const model = chartModel(spec, lang);
  const words = CHART_WORDS[lang];
  const el = (tag: string, cls?: string, text?: string): ChartNode => {
    const n = doc.createElement(tag);
    if (cls !== undefined) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const svg = (tag: string, attrs: Record<string, string>): ChartNode => {
    const n = doc.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };

  const figure = el('figure', `sre-chart sre-chart-${model.kind}`);
  figure.dataset['chart'] = model.id;
  const caption = el('figcaption', 'sre-chart-caption');
  caption.append(el('strong', 'sre-chart-title', model.title), el('span', 'sre-chart-covers', model.covers));
  figure.append(caption);

  if (model.empty) {
    const none = el('p', 'sre-chart-empty', model.emptyText);
    none.setAttribute('role', 'status');
    figure.append(none);
    host?.replaceChildren(figure);
    return figure;
  }

  // The drawing. Hidden from screen readers: the table below is what they read.
  const drawing = el('div', 'sre-chart-drawing');
  drawing.setAttribute('aria-hidden', 'true');
  if (model.kind === 'bars') {
    for (const row of model.rows) {
      const line = el('div', `sre-chart-row${row.known ? '' : ' sre-chart-unknown'}${row.mark === null ? '' : ' sre-chart-marked'}`);
      line.dataset['key'] = row.key;
      const label = el('span', 'sre-chart-label', row.mark === null ? row.label : `${row.label} · ${row.mark}`);
      const track = svg('svg', { class: 'sre-chart-track', viewBox: '0 0 100 10', preserveAspectRatio: 'none', focusable: 'false' });
      if (row.known && row.pct > 0) {
        track.append(svg('rect', { class: `sre-chart-bar${row.negative ? ' sre-chart-negative' : ''}`, x: '0', y: '0', width: String(row.pct), height: '10' }));
      }
      line.append(label, track, el('span', 'sre-chart-value', row.text));
      drawing.append(line);
    }
  } else {
    // Over time: one column per row, in the order given (the page gives them in time order). The tallest is labelled
    // with its figure; every other figure is in the table — a column of 24 numbers would be unreadable on a phone.
    const cols = el('div', 'sre-chart-cols');
    let tallest = -1;
    model.rows.forEach((r, i) => { if (r.known && (tallest < 0 || r.pct > model.rows[tallest]!.pct)) tallest = i; });
    model.rows.forEach((row, i) => {
      // A figure on top is wider than its column; near either edge it lines up with that edge so it never pokes past
      // the screen's side on a phone (a sideways scroll), and stays centred over the middle columns.
      const n = model.rows.length;
      const edge = n < 2 ? '' : i < n / 3 ? ' sre-chart-col-start' : i >= (2 * n) / 3 ? ' sre-chart-col-end' : '';
      const col = el('div', `sre-chart-col${edge}${row.known ? '' : ' sre-chart-unknown'}${row.mark === null ? '' : ' sre-chart-marked'}`);
      col.dataset['key'] = row.key;
      col.append(el('span', 'sre-chart-top', i === tallest || row.mark !== null ? (row.mark === null ? row.text : `${row.mark} · ${row.text}`) : row.known ? '' : '?'));
      const bar = svg('svg', { class: 'sre-chart-stem', viewBox: '0 0 10 100', preserveAspectRatio: 'none', focusable: 'false' });
      if (row.known && row.pct > 0) {
        bar.append(svg('rect', { class: `sre-chart-bar${row.negative ? ' sre-chart-negative' : ''}`, x: '0', y: String(100 - row.pct), width: '10', height: String(row.pct) }));
      }
      col.append(bar, el('span', 'sre-chart-tick', i % model.labelEvery === 0 ? row.label : ''));
      cols.append(col);
    });
    drawing.append(cols);
  }
  figure.append(drawing);

  if (model.unknownCount > 0) figure.append(el('p', 'sre-chart-gap', words['unknownRows']!.split('{n}').join(String(model.unknownCount))));

  // The table — the same rows, the same words. Read by screen readers always; shown on screen by the button.
  const wrap = el('div', 'sre-chart-table-wrap sre-scroll-x sr-only');
  const table = el('table', 'sre-chart-table');
  table.append(el('caption', undefined, `${model.title} — ${model.covers}`));
  const head = el('thead');
  const hr = el('tr');
  for (const h of [model.labelHeading, model.valueHeading]) { const th = el('th', undefined, h); th.setAttribute('scope', 'col'); hr.append(th); }
  head.append(hr);
  const body = el('tbody');
  for (const row of model.rows) {
    const tr = el('tr');
    tr.dataset['key'] = row.key;
    const th = el('th', undefined, row.mark === null ? row.label : `${row.label} · ${row.mark}`);
    th.setAttribute('scope', 'row');
    tr.append(th, el('td', row.known ? 'sre-end' : 'sre-end sre-unknown', row.text));
    body.append(tr);
  }
  table.append(head, body);
  wrap.append(table);
  figure.append(wrap);

  const toggle = el('button', 'sre-btn sre-btn-quiet sre-chart-toggle', words['showTable']);
  toggle.setAttribute('type', 'button');
  toggle.setAttribute('aria-pressed', 'false');
  let asTable = false;
  toggle.addEventListener('click', () => {
    asTable = !asTable;
    drawing.hidden = asTable;
    wrap.classList.toggle('sr-only', !asTable);
    toggle.textContent = asTable ? words['showChart']! : words['showTable']!;
    toggle.setAttribute('aria-pressed', asTable ? 'true' : 'false');
  });
  figure.append(toggle);

  host?.replaceChildren(figure);
  return figure;
}

/** What a page reaches as `window.sreCharts`. `lang` defaults to the document's own language. */
export interface SreCharts {
  draw(host: ChartHost | null, spec: ChartSpec, lang?: ChartLang): ChartNode;
  model(spec: ChartSpec, lang?: ChartLang): ChartModel;
}

/** Put `window.sreCharts` on a page (each app's bundle calls this once). No-op outside a browser. */
export function attachCharts(win: unknown): void {
  const w = win as { sreCharts?: SreCharts; document?: ChartDocument & { documentElement?: { lang?: string } } } | undefined;
  if (w === undefined || w === null || w.document === undefined) return;
  const doc = w.document;
  const langOf = (asked?: ChartLang): ChartLang => asked ?? (doc.documentElement?.lang === 'ta' ? 'ta' : 'en');
  w.sreCharts = Object.freeze({
    draw: (host: ChartHost | null, spec: ChartSpec, lang?: ChartLang) => drawChart(doc, host, spec, langOf(lang)),
    model: (spec: ChartSpec, lang?: ChartLang) => chartModel(spec, langOf(lang)),
  });
}
