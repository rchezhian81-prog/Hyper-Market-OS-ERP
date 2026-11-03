// Production costs (W4 · M11-FR-02 · §28 "costing reviewed by Finance") — the page Finance reviews production costing
// on. The session (apps/web-erp/src/production-costs-session.ts, in the bundle as window.productionCosts) does the read and
// every rule; this lays out what head office answered in the shared office parts (window.sreOffice: summary cards, a
// register with a record drawer). A yield outside the recipe's range is an exception and leads, in words as well as tone;
// a run not valued says so, never ₹0. Nothing is written from here. Every word has a Tamil twin.

const $ = (id) => document.getElementById(id);
const api = window.productionCosts ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
const both = (k) => ({ en: api === null ? k : api.words('en', k), ta: api === null ? k : api.words('ta', k) });
const office = () => window.sreOffice ?? null;
function el(tag, text, cls) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; }

let read = null; let readOut = null; let register = null;
const shown = (r) => api.present(lang, r);

function paintCards() {
  const o = office(); if (o === null) return;
  o.cards($('cards'), [
    { label: both('cardRuns'), value: read === null ? null : read.runs.length },
    { label: both('cardExceptions'), value: read === null ? null : read.withExceptions, tone: read !== null && read.withExceptions > 0 ? 'error' : undefined },
    { label: both('cardNotValued'), value: read === null ? null : read.notValued, tone: read !== null && read.notValued > 0 ? 'degraded' : undefined },
  ]);
}

function drawer(r) {
  const o = office(); const p = shown(r); const box = el('div');
  box.append(o.facts([
    [both('recipe'), r.recipeId], [both('department'), r.departmentId], [both('place'), r.locationId], [both('by'), r.producedBy],
    [both('colMade'), p.made], [both('colInputCost'), p.inputCost], [both('colUnitCost'), p.unitCost], [both('colYield'), p.yieldWords],
  ]));
  for (const x of p.exceptionLines) box.append(el('p', `✕ ${x}`, 'exc'));
  if (p.notValuedLine !== null) box.append(el('p', `⚠ ${p.notValuedLine}`, 'warnc'));
  if (r.costBasis === 'registered_cost') box.append(el('p', t('basisRegistered'), 'status'));
  if (p.lines.length > 0) { box.append(el('h3', t('linesH'))); const ul = el('ul', undefined, 'cost-lines'); for (const l of p.lines) ul.append(el('li', l)); box.append(ul); }
  return box;
}

function paintRegister() {
  const o = office(); if (o === null || api === null) return;
  if (register === null || !$('costs-register').contains($('costs-table'))) {
    register = o.table($('costs-register'), {
      id: 'costs', label: both('register'), bodyId: 'cost-rows', pageSize: 20, rows: null, rowKey: (r) => r.runId,
      rowData: (r) => ({ run: r.runId, batch: r.outputBatchId, tone: shown(r).tone }),
      empty: { title: both('emptyTitle'), detail: both('emptyDetail') },
      columns: [
        { key: 'state', label: both('colState'), filter: true, value: (r) => shown(r).stateWord, render: (r) => { const p = shown(r); return o.chip(p.tone, p.stateWord); } },
        { key: 'when', label: both('colWhen'), sort: 'text', value: (r) => api.moment(r.at) },
        { key: 'batch', label: both('colBatch'), sort: 'text', value: (r) => r.outputBatchId },
        { key: 'product', label: both('colProduct'), value: (r) => r.outputProductId },
        { key: 'made', label: both('colMade'), align: 'end', value: (r) => shown(r).made },
        { key: 'inputCost', label: both('colInputCost'), align: 'end', value: (r) => shown(r).inputCost },
        { key: 'unitCost', label: both('colUnitCost'), align: 'end', value: (r) => shown(r).unitCost },
        { key: 'yield', label: both('colYield'), value: (r) => { const p = shown(r); return [p.yieldWords, ...p.exceptionLines, ...(p.notValuedLine === null ? [] : [p.notValuedLine])].join(' · '); } },
      ],
      drawer: { title: (r) => `${r.outputBatchId} — ${r.outputProductId}`, body: drawer },
    });
  }
  if (read !== null) register.setRows(read.runs);
  else if (readOut !== null) register.setState(readOut.result === 'invalid' ? 'denied' : o.stateOf(readOut), { detail: api.outcomeWords(lang, readOut) });
  else register.setRows(null);
  $('as-at').textContent = read === null ? '' : `${t('asAt')} ${api.moment(read.asAt)}`;
}

function paintWords() {
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead'); $('register-h').textContent = t('registerH');
  document.title = `SRE ${t('title')}`;
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
}
function paintAll() { paintCards(); paintRegister(); }

async function load() {
  $('page-status').textContent = t('reading');
  const out = await session.read();
  if (out.result === 'ok') { read = out.value; readOut = null; $('page-status').textContent = ''; } else { read = null; readOut = out; $('page-status').textContent = api.outcomeWords(lang, out); }
  paintAll();
}

$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paintWords(); register = null; paintAll(); });
document.addEventListener('sre:chrome', () => paintAll());

paintWords();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.read) $('page-status').textContent = t('cannotRead');
else { paintAll(); void load(); }
