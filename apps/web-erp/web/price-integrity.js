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
// R1c: this device's own date of a moment, never its UTC date.
// OB-606: a moment is shown on the SHOP's date (its zone), never this device's; a plain date is already a date.
const day = (iso) => (typeof iso === 'string' ? (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : (window.sreShopDay?.dateOf(iso) ?? '')) : '');
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

// ── W3 · D06-FR-06: a shelf walk — record what each surface shows, then check the walk against head office's price ──
const checks = window.priceChecks ?? null;
const cw = (k, slots) => (checks === null ? k : checks.words(lang, k, slots));
const walk = []; // the observations recorded on this page, as head office kept them
let checkReport = null;

function findingLine(f) {
  const li = document.createElement('li');
  li.className = `row ${f.kind === 'overcharge_risk' ? 'tone-error' : 'tone-degraded'}`;
  li.dataset.product = f.productId; li.dataset.kind = f.kind;
  const head = document.createElement('div'); head.className = 'head';
  const what = document.createElement('strong'); what.textContent = `${f.productId} — ${cw(`s_${f.surface}`)} ${cw(`k_${f.kind}`)}`;
  const figures = document.createElement('span'); figures.className = 'state';
  figures.textContent = `${cw('shownWord')} ${f.displayedMinor === null ? '—' : checks.rupees(f.displayedMinor)} · ${cw('till')} ${checks.rupees(f.posPriceMinor)}`;
  head.append(what, figures);
  const facts = document.createElement('div'); facts.className = 'facts'; facts.textContent = f.shelfAddress ?? '';
  li.append(head, facts); li.title = f.detail;
  return li;
}

function paintWalk() {
  if (checks === null) return;
  $('walk').hidden = !checks.session.may.audit;
  for (const [id, k] of [['record-h', 'recordH'], ['record-lead', 'recordLead'], ['l-w-product', 'product'], ['l-w-surface', 'surface'], ['l-w-shown', 'shown'], ['l-w-shelf', 'shelfAddress'],
    ['w-record', 'record'], ['walk-list-h', 'recordedList'], ['check-h', 'checkH'], ['check-lead', 'checkLead'], ['w-check', 'check']]) $(id).textContent = cw(k);
  const chosen = $('w-surface').value || 'shelf_label';
  $('w-surface').replaceChildren(...checks.surfaces.map((s) => { const o = document.createElement('option'); o.value = s; o.textContent = cw(`s_${s}`); return o; }));
  $('w-surface').value = chosen;
  $('walk-rows').replaceChildren(...(walk.length === 0 ? [Object.assign(document.createElement('li'), { className: 'muted', textContent: cw('noneRecorded') })] : walk.map((o) => {
    const li = document.createElement('li'); li.className = 'row'; li.dataset.observation = o.observationId; li.dataset.product = o.productId;
    li.textContent = `${o.productId} — ${cw(`s_${o.surface}`)} ${checks.rupees(o.priceMinor)}${o.shelfAddress === undefined ? '' : ` · ${o.shelfAddress}`}`;
    return li;
  })));
  const box = $('check-result');
  if (checkReport === null) { box.replaceChildren(); return; }
  const parts = [];
  if (checkReport.overchargeRisks.length > 0) {
    const h = document.createElement('h3'); h.id = 'risks-h'; h.textContent = cw('risksH');
    const ul = document.createElement('ul'); ul.className = 'rows'; ul.id = 'risk-rows'; ul.append(...checkReport.overchargeRisks.map(findingLine));
    parts.push(h, ul);
  }
  if (checkReport.other.length > 0) {
    const h = document.createElement('h3'); h.textContent = cw('otherH');
    const ul = document.createElement('ul'); ul.className = 'rows'; ul.id = 'other-rows'; ul.append(...checkReport.other.map(findingLine));
    parts.push(h, ul);
  }
  if (checkReport.noPriceOfRecord.length > 0) parts.push(Object.assign(document.createElement('p'), { className: 'muted', id: 'no-price-of-record', textContent: `${cw('noPriceOfRecord')} ${checkReport.noPriceOfRecord.join(', ')}` }));
  box.replaceChildren(...parts);
}

$('record-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (checks === null) return;
  $('record-status').className = 'status'; $('record-status').textContent = cw('saving');
  const out = await checks.session.record({ branchId: $('branch').value, productId: $('w-product').value, surface: $('w-surface').value, shown: $('w-shown').value, shelfAddress: $('w-shelf').value });
  if (out.result === 'ok') {
    walk.push(out.value);
    $('record-status').className = 'status good'; $('record-status').textContent = `${cw('recorded')} ${out.value.productId} ${checks.rupees(out.value.priceMinor)}.`;
    $('w-product').value = ''; $('w-shown').value = ''; $('w-shelf').value = '';
  } else { $('record-status').className = 'status err'; $('record-status').textContent = checks.outcomeWords(lang, out); }
  paintWalk();
});
$('w-check').addEventListener('click', async () => {
  if (checks === null) return;
  $('check-status').className = 'status'; $('check-status').textContent = cw('checking');
  const out = await checks.session.check($('branch').value, walk);
  if (out.result === 'ok') {
    checkReport = out.value;
    const agree = out.value.overchargeRisks.length === 0 && out.value.other.length === 0;
    $('check-status').className = agree ? 'status good' : 'status';
    $('check-status').textContent = `${cw('checked', { n: out.value.productsChecked })}${agree && out.value.productsChecked > 0 ? ` ${cw('allAgree')}` : ''}`;
    if (may.readPrices && $('branch').value.trim() !== '') await show(); // the ageing report learns the walk too
  } else { checkReport = null; $('check-status').className = 'status err'; $('check-status').textContent = checks.outcomeWords(lang, out); }
  paintWalk();
});

$('ask').addEventListener('submit', (e) => { void show(e); });
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); paintWalk(); });
paint();
paintWalk();
if (may.named && !may.readPrices) { $('page-status').className = 'status err'; $('page-status').textContent = t('cannotRead'); $('show').disabled = true; }

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}
