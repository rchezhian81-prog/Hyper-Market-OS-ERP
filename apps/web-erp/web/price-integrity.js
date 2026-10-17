// Price mismatches — the page over head office's D-7 ageing report (OB-154 · OB-163). A read only: the session
// (apps/web-erp/src/store-ops-session.ts, in the bundle as window.storeOps) asks head office for the report of one store
// and the page shows it in the owner's four bands, legal exposure first, exactly as head office ordered it. Nothing is
// written, nothing is decided here; a person fixes the label or the list. Every word has a Tamil twin.

const $ = (id) => document.getElementById(id);
const api = window.storeOps ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, readPrices: false };

let lang = 'en';
const t = (k, slots) => (api === null ? k : api.words(lang, k, slots));
const day = (iso) => (typeof iso === 'string' ? iso.slice(0, 10) : '');
let report = null;

function cell(text) { const td = document.createElement('td'); td.textContent = text; return td; }

function paint() {
  document.title = `SRE ${t('prTitle')}`;
  for (const [id, k] of [['title-text', 'prTitle'], ['page-h', 'prTitle'], ['lead', 'prLead'], ['l-branch', 'prBranch'], ['show', 'prShow'],
    ['c-product', 'prColProduct'], ['c-where', 'prColWhere'], ['c-record', 'prColRecord'], ['c-shown', 'prColShown'], ['c-since', 'prColSince'], ['c-band', 'prColBand']]) $(id).textContent = t(k);
  $('list-h').textContent = t('prTitle');
  $('lang').textContent = t('lang');
  $('whoami').textContent = window.storeOpsData?.userId ?? '';
  $('nobody').hidden = may.named; $('nobody').textContent = t('nobody');
  // OB-163: always the owner's four bands, in his order, with how many are open in each.
  const counts = new Map((report?.byBand ?? []).map((b) => [b.band, b.count]));
  $('bands').replaceChildren(...(api?.bands ?? []).map((band) => {
    const panel = document.createElement('div'); panel.className = 'panel'; panel.dataset.band = band;
    const n = counts.get(band) ?? 0;
    if (n > 0) panel.classList.add('attention');
    const k = document.createElement('span'); k.className = 'k'; k.textContent = api.bandWords(lang, band);
    const v = document.createElement('span'); v.className = 'v'; v.textContent = report === null ? '—' : String(n);
    panel.append(k, v);
    return panel;
  }));
  const rows = report?.exceptions ?? [];
  $('rows').replaceChildren(...rows.map((x) => {
    const tr = document.createElement('tr');
    tr.dataset.product = x.productId; tr.dataset.surface = x.surface; tr.dataset.kind = x.kind; tr.dataset.band = x.band;
    tr.append(cell(x.productId), cell(`${api.surfaceWords(lang, x.surface)} — ${api.kindWords(lang, x.kind)}`), cell(api.rupees(x.recordMinor)),
      cell(x.surfaceMinor === undefined ? '—' : api.rupees(x.surfaceMinor)), cell(day(x.openSince)), cell(api.bandWords(lang, x.band)));
    tr.title = x.detail;
    return tr;
  }));
  $('none').hidden = report === null || rows.length > 0; $('none').textContent = t('prNone');
}

async function show(event) {
  event?.preventDefault();
  const out = await session.priceAgeing($('branch').value);
  if (out.result === 'ok') {
    report = out.value;
    $('page-status').className = 'status'; $('page-status').textContent = t('prChecked', { n: report.productsChecked });
  } else {
    report = null;
    $('page-status').className = 'status err'; $('page-status').textContent = api.outcomeWords(lang, out);
  }
  paint();
}

$('ask').addEventListener('submit', (e) => { void show(e); });
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (may.named && !may.readPrices) { $('page-status').className = 'status err'; $('page-status').textContent = t('cannotRead'); $('show').disabled = true; }

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}
