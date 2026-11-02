// Range gaps and own brand (W3 · D02-FR-04 · OB-319) — the report section of the Store groups and seasons page. The session
// (apps/web-erp/src/range-gaps-session.ts, in the bundle as window.rangeGaps) does the one read and every rule; this lays
// out what head office answered. A read only: nothing is written. Every word has a Tamil twin.

const $ = (id) => document.getElementById(id);
const api = window.rangeGaps ?? null;
const session = api?.session ?? null;
const lang = () => (document.documentElement.lang === 'ta' ? 'ta' : 'en');
const t = (k) => (api === null ? k : api.words(lang(), k));
let report = null; let lastOut = null;

function el(tag, text, attrs) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; for (const [k, v] of Object.entries(attrs ?? {})) n.setAttribute(k, v); return n; }
function table(id, heads, rows) {
  const wrap = el('div', undefined, { class: 'table-wrap' });
  const tb = el('table', undefined, { id });
  const head = el('thead'); const hr = el('tr'); for (const h of heads) hr.append(el('th', h)); head.append(hr);
  const body = el('tbody'); for (const r of rows) body.append(r);
  tb.append(head, body); wrap.append(tb); return wrap;
}
const tr = (cells, data) => { const r = el('tr'); for (const [k, v] of Object.entries(data ?? {})) r.dataset[k] = v; for (const c of cells) r.append(el('td', c)); return r; };
const margin = (s) => (s.products === 0 ? t('nothingSold') : s.marginBps === null ? `${t('notKnown')} ${s.costNotKnownFor.join(', ')}` : `${(s.marginBps / 100).toFixed(1)}%`);

function paint() {
  if (api === null || session === null) return;
  $('gaps').hidden = !session.may.read;
  for (const [id, k] of [['gaps-h', 'h'], ['gaps-lead', 'lead'], ['l-gfrom', 'from'], ['l-gto', 'to'], ['l-gbands', 'bands'], ['gaps-go', 'show']]) $(id).textContent = t(k);
  if (lastOut !== null && lastOut.result !== 'ok') $('gaps-status').textContent = api.outcomeWords(lang(), lastOut);
  const box = $('gaps-report');
  if (report === null) { box.replaceChildren(); return; }
  const cards = el('div', undefined, { class: 'gap-cards', id: 'gaps-cards' });
  for (const [k, v] of [['cardShort', report.totals.shortPicks], ['cardFailed', report.totals.failedSubstitutions], ['cardSearch', report.totals.searchesWithNoResult], ['cardOwn', report.privateLabelProducts]]) {
    const c = el('p', `${t(k)}: ${v}`, { class: 'muted' }); cards.append(c);
  }
  const parts = [cards, el('h4', t('gapsH'))];
  if (report.bandsChosenBy === 'none_sent_one_band') parts.push(el('p', t('oneBand'), { class: 'muted', id: 'one-band' }));
  parts.push(report.gaps.length === 0 ? el('p', t('noGaps'), { class: 'muted' })
    : table('gap-table', [t('colCategory'), t('colBand'), t('colShort'), t('colFailed'), t('colProducts')], report.gaps.map((g) => tr([g.categoryId ?? t('noCategory'), g.band, String(g.shortPicks), String(g.failedSubstitutions), g.products.join(', ')], { category: g.categoryId ?? '', band: g.band }))));
  parts.push(el('h4', t('searchH')));
  parts.push(report.searches.length === 0 ? el('p', t('noSearches'), { class: 'muted' })
    : table('search-table', [t('colWords'), t('colCount')], report.searches.map((s) => tr([s.words, String(s.count)], { words: s.words }))));
  parts.push(el('h4', t('plH')));
  parts.push(report.privateLabel.length === 0 ? el('p', t('noPl'), { class: 'muted' })
    : table('pl-table', [t('colCategory'), t('colOwn'), t('colBranded'), t('colOwnSales'), t('colBrandedSales')], report.privateLabel.map((r) => tr([r.categoryId ?? t('noCategory'), margin(r.own), margin(r.branded), api.rupees(r.own.netSalesMinor), api.rupees(r.branded.netSalesMinor)], { category: r.categoryId ?? '' }))));
  box.replaceChildren(...parts);
}

$('gaps-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (session === null) return;
  $('gaps-status').textContent = t('reading');
  const out = await session.read({ from: $('g-from').value, to: $('g-to').value, bands: $('g-bands').value });
  lastOut = out;
  report = out.result === 'ok' ? out.value : null;
  $('gaps-status').textContent = out.result === 'ok' ? '' : api.outcomeWords(lang(), out);
  paint();
});
new MutationObserver(paint).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
if (api !== null) { const today = api.today(); if ($('g-to').value === '') $('g-to').value = today; if ($('g-from').value === '') $('g-from').value = today; }
paint();
