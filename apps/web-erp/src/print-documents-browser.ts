// Batch 18b · R1 / P1 / B2 — the Print button's sheet (M31-FR-02 · WF-03): a purchase order, a goods receipt (GRN) or a
// supplier's statement laid out on an A4 page, then the browser's own Print / Save as PDF. No PDF library, nothing from the
// internet: the page's look is in the shared stylesheet every office page already holds (`sre-foundation.css`,
// `.sre-print-*`), and `@media print` prints the page alone.
//
// What it prints comes from head office's print view (`GET /v1/documents/print/...`, read under the person's own session).
// Each view read is kept on this computer, so a document opened once prints again with the internet off — the page then
// says it is the copy kept here and when head office read it (P-08). A refusal (not found, still a draft, not your branch)
// is said in head office's words; nothing is printed in its place.

import { printLayout, printWord, type PrintKind, type PrintLang, type PrintLayout, type PrintView } from '../../../packages/documents/src/print-view';

const PATHS: Readonly<Record<PrintKind, string>> = Object.freeze({
  purchase_order: '/v1/documents/print/purchase-orders/',
  goods_receipt: '/v1/documents/print/goods-receipts/',
  supplier_statement: '/v1/documents/print/supplier-statements/',
});

export type PrintRead =
  | { readonly state: 'live' | 'kept'; readonly view: PrintView }
  | { readonly state: 'refused'; readonly words: string }
  | { readonly state: 'offline' };

interface Storage { getItem(k: string): string | null; setItem(k: string, v: string): void }
const keyOf = (kind: PrintKind, id: string): string => `sre.print.${kind}.${id}`;

/** Read the view from head office; keep it here; without head office, the copy kept here (or nothing — said). */
export async function readPrintView(kind: PrintKind, id: string, fetchFn: typeof fetch | undefined, storage: Storage | undefined): Promise<PrintRead> {
  const kept = (): PrintRead => {
    try {
      const v = storage?.getItem(keyOf(kind, id));
      const view = v === null || v === undefined ? null : (JSON.parse(v) as PrintView);
      return view !== null && view.kind === kind ? { state: 'kept', view } : { state: 'offline' };
    } catch { return { state: 'offline' }; }
  };
  if (fetchFn === undefined) return kept();
  let res: Response;
  try {
    res = await fetchFn(`${PATHS[kind]}${encodeURIComponent(id)}`, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  } catch { return kept(); }
  if (res.status === 200) {
    const body = (await res.json().catch(() => null)) as { view?: PrintView } | null;
    if (body === null || body.view === undefined) return kept();
    try { storage?.setItem(keyOf(kind, id), JSON.stringify(body.view)); } catch { /* a convenience: the next print offline may not have it */ }
    return { state: 'live', view: body.view };
  }
  if (res.status >= 500 || (res.status === 404 && !(res.headers.get('content-type') ?? '').includes('json'))) return kept();
  const body = (await res.json().catch(() => null)) as { whatHappened?: string; nextSafeAction?: string } | null;
  const words = [body?.whatHappened, body?.nextSafeAction].filter((x): x is string => typeof x === 'string' && x.trim() !== '').join(' ');
  return { state: 'refused', words: words === '' ? `Head office refused (${res.status}).` : words };
}

const SHEET_ID = 'sre-print-sheet';
const STYLE_ID = 'sre-print-style';
/**
 * The page's look, carried in this bundle (so it is on the store computer with no network): on screen the A4 page over the
 * office page with its two buttons; on paper the page ALONE, black on white whatever the screen's theme (paper has no dark
 * mode, so these are fixed print colours, not the screen's tokens), A4 with 12 mm margins.
 */
export const PRINT_CSS = ".sre-print-sheet { position: fixed; inset: 0; z-index: 60; overflow: auto; background: rgba(15, 23, 20, 0.55); padding: 16px; display: grid; justify-items: center; align-content: start; gap: 12px; }\n.sre-print-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; width: min(210mm, 100%); background: var(--panel); border-radius: var(--radius-lg); padding: 12px; }\n.sre-print-status { margin: 0; flex: 1 1 260px; font-size: 15px; color: var(--ink); }\n.sre-print-status:empty { display: none; }\n.sre-print-page { box-sizing: border-box; width: min(210mm, 100%); min-height: 297mm; padding: 14mm 12mm; background: #ffffff; color: #111111; font: 13px/1.45 var(--font, system-ui, sans-serif); box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25); }\n.sre-print-header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-start; gap: 12px; border-bottom: 2px solid #111111; padding-bottom: 8px; }\n.sre-print-title { margin: 0; font-size: 22px; line-height: 1.2; color: #111111; }\n.sre-print-head, .sre-print-facts { margin: 0; display: grid; gap: 2px; }\n.sre-print-head > div, .sre-print-facts > div { display: flex; gap: 8px; }\n.sre-print-head dt, .sre-print-facts dt { font-weight: 600; min-width: 9em; color: #333333; }\n.sre-print-head dd, .sre-print-facts dd { margin: 0; color: #111111; }\n.sre-print-head dd { font-weight: 700; font-variant-numeric: tabular-nums; }\n.sre-print-parties { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 12px 0; }\n.sre-print-party { border: 1px solid #999999; border-radius: 4px; padding: 8px 10px; }\n.sre-print-party h2 { margin: 0 0 4px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: #444444; }\n.sre-print-party p { margin: 0; }\n.sre-print-party .sre-print-party-name { font-size: 15px; font-weight: 700; }\n.sre-print-facts { margin: 0 0 12px; }\n.sre-print-lines, .sre-print-totals { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }\n.sre-print-lines th, .sre-print-lines td { border: 1px solid #999999; padding: 4px 6px; text-align: left; vertical-align: top; color: #111111; }\n.sre-print-lines th { background: #eeeeee; font-weight: 600; font-size: 12px; }\n.sre-print-lines .sre-end, .sre-print-totals .sre-end { text-align: right; }\n.sre-print-totals { width: auto; margin: 8px 0 0 auto; min-width: 50%; }\n.sre-print-totals th, .sre-print-totals td { padding: 3px 6px; text-align: left; font-weight: 400; color: #111111; }\n.sre-print-totals .sre-print-strong th, .sre-print-totals .sre-print-strong td { font-weight: 700; border-top: 2px solid #111111; }\n.sre-print-note { margin: 10px 0 0; font-size: 12px; color: #333333; }\n.sre-print-signatures { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; margin-top: 48px; }\n.sre-print-signature { display: grid; gap: 4px; text-align: center; font-size: 12px; color: #333333; }\n.sre-print-sign-line { display: block; border-bottom: 1px solid #111111; height: 36px; }\n.sre-print-footer { margin-top: 24px; font-size: 11px; color: #555555; }\n@media (max-width: 519px) { .sre-print-parties, .sre-print-signatures { grid-template-columns: 1fr; } .sre-print-page { min-height: 0; padding: 12px; } }\n@media print {\n  @page { size: A4; margin: 12mm; }\n  body.sre-printing > *:not(#sre-print-sheet) { display: none !important; }\n  body.sre-printing { background: #ffffff !important; }\n  body.sre-printing #sre-print-sheet { position: static; overflow: visible; background: none; padding: 0; display: block; }\n  body.sre-printing .sre-print-tools { display: none !important; }\n  body.sre-printing .sre-print-page { width: auto; min-height: 0; padding: 0; box-shadow: none; }\n  .sre-print-lines tr { break-inside: avoid; }\n  .sre-print-signatures { break-inside: avoid; }\n}";
function ensureStyle(): void {
  if (document().getElementById(STYLE_ID) !== null) return;
  const style = document().createElement('style');
  style.id = STYLE_ID;
  style.textContent = PRINT_CSS;
  (document() as unknown as { head: El }).head.append(style);
}
const TOOL_WORDS = {
  en: { print: 'Print / Save as PDF', close: 'Close', reading: 'Reading the document from head office…', offline: 'Head office cannot be reached and this computer keeps no copy of this document yet, so it cannot be printed now. Open it once while head office answers; after that it prints with the internet off.', refused: 'Head office did not give this document:' },
  ta: { print: 'அச்சிடு / PDF ஆகச் சேமி', close: 'மூடு', reading: 'தலைமை அலுவலகத்திலிருந்து ஆவணத்தைப் படிக்கிறது…', offline: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை, இந்த ஆவணத்தின் நகல் இந்தக் கணினியில் இன்னும் இல்லை, எனவே இப்போது அச்சிட முடியாது. தலைமை அலுவலகம் பதில் சொல்லும்போது ஒருமுறை திறக்கவும்; அதன் பின் இணையம் இல்லாமலும் அச்சிடலாம்.', refused: 'தலைமை அலுவலகம் இந்த ஆவணத்தைத் தரவில்லை:' },
} as const;

// The bundle is compiled without the DOM library (its models are DOM-free); this file reaches the page through these few
// shapes only.
interface El {
  className: string; id: string; textContent: string | null; type: string; disabled: boolean; scope: string; colSpan: number;
  readonly dataset: Record<string, string | undefined>;
  readonly classList: { add(c: string): void; remove(c: string): void };
  append(...nodes: El[]): void; remove(): void; focus(): void;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, fn: (e: { readonly key?: string }) => void): void;
}
interface Doc { createElement(tag: string): El; getElementById(id: string): El | null; readonly body: El; readonly documentElement: { readonly lang: string }; readonly activeElement: El | null }
interface Win { print(): void; fetch?: typeof fetch; localStorage?: Storage; sreShopDay?: { dateTimeOf(v: string): string } }
const document = (): Doc => (globalThis as unknown as { document: Doc }).document;
const page = (): Win => globalThis as unknown as Win;

function node(tag: string, cls?: string, text?: string): El {
  const n = document().createElement(tag);
  if (cls !== undefined) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** Draw the A4 page from the plan (DOM calls only — every value is text, never markup). */
export function drawPrintPage(layout: PrintLayout, footer: string): El {
  const sheetPage = node('article', 'sre-print-page');
  sheetPage.dataset['kind'] = layout.kind;
  const head = node('header', 'sre-print-header');
  const title = node('h1', 'sre-print-title', layout.title);
  title.id = 'sre-print-title';
  const facts = node('dl', 'sre-print-head');
  for (const f of layout.head) { const row = node('div'); row.append(node('dt', undefined, f.label), node('dd', undefined, f.value)); facts.append(row); }
  head.append(title, facts);
  const parties = node('section', 'sre-print-parties');
  for (const p of layout.parties) {
    const box = node('div', 'sre-print-party');
    box.append(node('h2', undefined, p.heading), node('p', 'sre-print-party-name', p.name));
    for (const l of p.lines) box.append(node('p', undefined, l));
    parties.append(box);
  }
  sheetPage.append(head, parties);
  if (layout.facts.length > 0) {
    const more = node('dl', 'sre-print-facts');
    for (const f of layout.facts) { const row = node('div'); row.append(node('dt', undefined, f.label), node('dd', undefined, f.value)); more.append(row); }
    sheetPage.append(more);
  }
  if (layout.table.head.length > 0) {
    const table = node('table', 'sre-print-lines');
    const thead = node('thead'); const hr = node('tr');
    layout.table.head.forEach((h, j) => { const th = node('th', layout.table.end[j] ? 'sre-end' : undefined, h); th.scope = 'col'; hr.append(th); });
    thead.append(hr);
    const tbody = node('tbody');
    if (layout.table.rows.length === 0) { const tr = node('tr'); const td = node('td', undefined, layout.table.empty); td.colSpan = layout.table.head.length; tr.append(td); tbody.append(tr); }
    for (const r of layout.table.rows) { const tr = node('tr'); r.forEach((c, j) => tr.append(node('td', layout.table.end[j] ? 'sre-end' : undefined, c))); tbody.append(tr); }
    table.append(thead, tbody);
    sheetPage.append(table);
  }
  const totals = node('table', 'sre-print-totals');
  const tb = node('tbody');
  for (const t of layout.totals) { const tr = node('tr', t.strong === true ? 'sre-print-strong' : undefined); const th = node('th', undefined, t.label); th.scope = 'row'; tr.append(th, node('td', 'sre-end', t.value)); tb.append(tr); }
  totals.append(tb);
  sheetPage.append(totals);
  for (const n of layout.notes) sheetPage.append(node('p', 'sre-print-note', n));
  const sigs = node('section', 'sre-print-signatures');
  for (const s of layout.signatures) { const box = node('div', 'sre-print-signature'); box.append(node('span', 'sre-print-sign-line'), node('span', undefined, s)); sigs.append(box); }
  sheetPage.append(sigs, node('footer', 'sre-print-footer', footer));
  return sheetPage;
}

function closeSheet(): void { document().getElementById(SHEET_ID)?.remove(); document().body.classList.remove('sre-printing'); }

/** The Print button: open the sheet, read the document, draw the A4 page; its first button prints (or saves a PDF). */
export async function openPrint(spec: { readonly kind: PrintKind; readonly id: string }): Promise<PrintRead['state']> {
  const lang: PrintLang = document().documentElement.lang === 'ta' ? 'ta' : 'en';
  const tw = TOOL_WORDS[lang];
  closeSheet();
  ensureStyle();
  const opener = document().activeElement;
  const sheet = node('div', 'sre-print-sheet');
  sheet.id = SHEET_ID;
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-labelledby', 'sre-print-title');
  sheet.dataset['kind'] = spec.kind;
  const tools = node('div', 'sre-print-tools');
  const go = node('button', 'sre-btn sre-btn-primary', tw.print); go.type = 'button'; go.id = 'sre-print-go'; go.disabled = true;
  const close = node('button', 'sre-btn', tw.close); close.type = 'button'; close.id = 'sre-print-close';
  const said = node('p', 'sre-print-status', tw.reading); said.id = 'sre-print-status'; said.setAttribute('role', 'status');
  tools.append(go, close, said);
  sheet.append(tools);
  document().body.append(sheet);
  document().body.classList.add('sre-printing');
  const finish = (): void => { closeSheet(); opener?.focus?.(); };
  close.addEventListener('click', finish);
  sheet.addEventListener('keydown', (e) => { if (e.key === 'Escape') finish(); });
  go.addEventListener('click', () => { page().print(); });
  close.focus();

  let storage: Storage | undefined;
  try { storage = page().localStorage; } catch { storage = undefined; }
  const fetchFn = page().fetch;
  const read = await readPrintView(spec.kind, spec.id, typeof fetchFn === 'function' ? fetchFn.bind(globalThis) : undefined, storage);
  sheet.dataset['state'] = read.state;
  if (read.state === 'offline') { said.textContent = tw.offline; return read.state; }
  if (read.state === 'refused') { said.textContent = `${tw.refused} ${read.words}`; return read.state; }
  const at = page().sreShopDay?.dateTimeOf(read.view.readAt) || read.view.readAt;
  const footer = (read.state === 'kept' ? printWord(lang, 'copyNote') : printWord(lang, 'printedAt')).split('{t}').join(at);
  said.textContent = read.state === 'kept' ? footer : '';
  sheet.append(drawPrintPage(printLayout(read.view, lang), footer));
  go.disabled = false;
  go.focus();
  return read.state;
}
