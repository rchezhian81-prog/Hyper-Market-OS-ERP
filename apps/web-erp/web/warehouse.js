// Warehouse supervisor — the view layer (M09 / OA-9). It renders the oversight the box served and
// holds NO rule of its own; every derivation (occupancy, exceptions) lives in the tested session model
// (`apps/web-erp/src/warehouse-supervisor-session.ts`), attached as `window.warehouseSupervisorSession`
// and built from the SAME `warehouse` data the handheld reads — so the floor and the office cannot
// disagree.
//
// ── What this file exists to hold ───────────────────────────────────────────
//
// **"I have not been told" is not "all clear".** The session answers `known: false` for stock and
// exceptions when the box was never sent the bin contents; this screen shows that plainly rather than
// an empty, healthy-looking warehouse — the same rule the manager's day close holds (P-08).
//
// Every word is English and Tamil, keyed to the session's `WAREHOUSE_EXCEPTION_KINDS`; a completeness
// tripwire fails the build if either language lacks one.
// NOTE: the Tamil below is pending a native-speaker review before go-live (OWNER-ACTION OA-10).

const el = (id) => document.getElementById(id);

const WORDS = {
  en: {
    staleShell: 'No connection to the store computer. This page is what it was last told, at',
    sample: "Sample data — this is not the shop's own warehouse.",
    who: 'Warehouse supervisor',
    binsHeading: 'Bins', binsLead: 'Configuration and how full each bin is.',
    colBin: 'Bin', colZone: 'Zone', colKind: 'Kind', colCapacity: 'Capacity', colUsed: 'Used', colFree: 'Free', colFull: 'Full',
    pickable: 'pickable', holding: 'holding',
    stockHeading: 'Stock in the bins', colProduct: 'Product', colBatch: 'Batch', colQty: 'Quantity',
    exHeading: 'Exceptions', exNone: 'No exceptions — the warehouse is in order.',
    notKnownStock: 'The store box has not been sent the current bin contents, so stock cannot be shown. This is not an empty warehouse — it is one this office has not been told about yet.',
    notKnownEx: 'The store box has not been sent the current bin contents, so exceptions cannot be checked. Not knowing is not the same as none.',
    // exception kinds, keyed to WAREHOUSE_EXCEPTION_KINDS
    negative_stock: 'Impossible negative stock', over_capacity: 'Bin over capacity', recalled_in_pickable_bin: 'Recalled stock in a pickable bin',
  },
  ta: {
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:',
    sample: 'மாதிரி தரவு — இது கடையின் சொந்தக் கிடங்கு அல்ல.',
    who: 'கிடங்கு மேற்பார்வையாளர்',
    binsHeading: 'இடங்கள்', binsLead: 'அமைப்பு மற்றும் ஒவ்வொரு இடமும் எவ்வளவு நிரம்பியுள்ளது.',
    colBin: 'இடம்', colZone: 'மண்டலம்', colKind: 'வகை', colCapacity: 'கொள்ளளவு', colUsed: 'பயன்பட்டது', colFree: 'மீதம்', colFull: 'நிரம்பியது',
    pickable: 'எடுக்கும்', holding: 'சேமிப்பு',
    stockHeading: 'இடங்களில் உள்ள சரக்கு', colProduct: 'பொருள்', colBatch: 'தொகுதி', colQty: 'அளவு',
    exHeading: 'விதிவிலக்குகள்', exNone: 'விதிவிலக்குகள் இல்லை — கிடங்கு ஒழுங்காக உள்ளது.',
    notKnownStock: 'கடை கணினி தற்போதைய இட உள்ளடக்கத்தை அனுப்பவில்லை, எனவே சரக்கைக் காட்ட முடியாது. இது காலி கிடங்கு அல்ல — இந்த அலுவலகத்திற்கு இன்னும் தெரிவிக்கப்படவில்லை.',
    notKnownEx: 'கடை கணினி தற்போதைய இட உள்ளடக்கத்தை அனுப்பவில்லை, எனவே விதிவிலக்குகளைச் சரிபார்க்க முடியாது. தெரியாதது என்பது இல்லை என்பது அல்ல.',
    negative_stock: 'சாத்தியமற்ற எதிர்மறை சரக்கு', over_capacity: 'இடம் கொள்ளளவைத் தாண்டியது', recalled_in_pickable_bin: 'எடுக்கும் இடத்தில் திரும்பப் பெற்ற சரக்கு',
  },
};
let lang = 'en';
const t = (key) => WORDS[lang][key] ?? WORDS.en[key] ?? key;

const real = window.warehouseSupervisorSession;
const data = window.warehouseSupervisorData;

function cell(text, cls) {
  const td = document.createElement('td');
  if (cls) td.className = cls;
  td.textContent = String(text);
  return td;
}
function headRow(keys) {
  const tr = document.createElement('tr');
  for (const k of keys) { const th = document.createElement('th'); th.textContent = t(k); tr.append(th); }
  return tr;
}

function renderBins() {
  const host = el('bins');
  host.textContent = '';
  if (real === undefined) return;
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  thead.append(headRow(['colBin', 'colZone', 'colKind', 'colCapacity', 'colUsed', 'colFree', 'colFull']));
  table.append(thead);
  const tbody = document.createElement('tbody');
  for (const b of real.bins()) {
    const tr = document.createElement('tr');
    const over = b.usedMinor !== null && b.usedMinor > b.capacityMinor;
    if (over) tr.className = 'over';
    tr.append(
      cell(b.binId), cell(b.zone ?? '—'), cell(b.pickable ? t('pickable') : t('holding')),
      cell(b.capacityMinor, 'num'),
      cell(b.usedMinor === null ? '—' : b.usedMinor, 'num'),
      cell(b.freeMinor === null ? '—' : b.freeMinor, 'num'),
      cell(b.pctFull === null ? '—' : `${b.pctFull}%`, 'num'),
    );
    tbody.append(tr);
  }
  table.append(tbody);
  host.append(table);
}

function renderStock() {
  const host = el('stock');
  host.textContent = '';
  if (real === undefined) return;
  const stock = real.stock();
  if (!stock.known) {
    const p = document.createElement('p'); p.className = 'notknown'; p.textContent = t('notKnownStock'); host.append(p);
    return;
  }
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  thead.append(headRow(['colBin', 'colProduct', 'colBatch', 'colQty']));
  table.append(thead);
  const tbody = document.createElement('tbody');
  for (const r of stock.rows) {
    const tr = document.createElement('tr');
    tr.append(cell(r.binId), cell(r.productId), cell(r.batchId ?? '—'), cell(r.quantityMinor, 'num'));
    tbody.append(tr);
  }
  table.append(tbody);
  host.append(table);
}

function renderExceptions() {
  const host = el('exceptions');
  host.textContent = '';
  if (real === undefined) return;
  const ex = real.exceptions();
  if (!ex.known) {
    const p = document.createElement('p'); p.className = 'notknown'; p.textContent = t('notKnownEx'); host.append(p);
    return;
  }
  if (ex.rows.length === 0) {
    const p = document.createElement('p'); p.className = 'ex-empty'; p.textContent = t('exNone'); host.append(p);
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'ex';
  for (const e of ex.rows) {
    const row = document.createElement('div');
    row.className = `row ${e.kind}`;
    const k = document.createElement('div'); k.className = 'kind'; k.textContent = t(e.kind);
    const d = document.createElement('div'); d.className = 'detail'; d.textContent = e.detail;
    row.append(k, d);
    wrap.append(row);
  }
  host.append(wrap);
}

function render() {
  el('who').firstChild.textContent = t('who');
  el('store').textContent = (data && data.storeId) || '';
  el('bins-heading').textContent = t('binsHeading');
  el('bins-lead').textContent = t('binsLead');
  el('stock-heading').textContent = t('stockHeading');
  el('ex-heading').textContent = t('exHeading');
  renderBins();
  renderStock();
  renderExceptions();
}

// ── Boot ────────────────────────────────────────────────────────────────────
el('sample').hidden = real !== undefined;
el('sample').textContent = t('sample');
render();

// ── Language ────────────────────────────────────────────────────────────────
el('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  el('sample').textContent = t('sample');
  render();
});

// ── The shell's own honesty about where this page came from (P-08) ───────────
function paintStale() {
  const at = window.shellCachedAt;
  const strip = el('stale');
  if (!strip) return;
  strip.hidden = at === undefined;
  if (at === undefined) return;
  strip.textContent = `${t('staleShell')} ${new Date(at).toLocaleString()}`;
}
paintStale();
el('lang').addEventListener('click', paintStale);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
