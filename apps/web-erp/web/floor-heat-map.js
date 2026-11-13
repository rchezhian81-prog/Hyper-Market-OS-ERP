// Floor heat map — the page over head office's heat map (M04-FR-04 · OB-308). The session
// (apps/web-erp/src/floor-heat-map-session.ts, in the bundle as window.floorHeatMap) asks head office on a click; this page
// lays the shop floor out seen from above, each shelf area a box at its own coordinates, coloured by sales or margin per
// square foot on the foundation's ONE-hue heat scale (darker earns more). An area whose figure is not known is plain with
// a dashed edge and the words "not known", never a colour of the scale. Every area is also a row in a table (the figure, the heat, the notes in words); hovering or focusing an
// area shows its figures. Every word has a Tamil twin; every button carries an icon beside its word.

const $ = (id) => document.getElementById(id);
const api = window.floorHeatMap ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false };

let lang = 'en';
let measure = 'sales';
let heat = null;
const t = (k) => (api === null ? k : api.words(lang, k));

const wordsIn = (l, k) => (api === null ? k : api.words(l, k)); // the page's own words, for either language (null off the box)
// U5 · G17: the chrome's shared parts (window.sreOffice) may load after this page — each part is drawn once it is there,
// and the page keeps its words meanwhile.
const office = () => window.sreOffice ?? null;
const dateOf = (id) => { const o = office(); return o && typeof o.dateOf === 'function' ? (o.dateOf(id) ?? '') : ($(id)?.value ?? ''); };
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
for (const [id, name] of [['m-sales', 'indian-rupee'], ['m-margin', 'percent'], ['show', 'layout-grid']]) { const i = icon(name); if (i !== null) $(id).prepend(i); }

// The reading window: this month so far — the SHOP's today and month (never the browser's own date, which is still
// yesterday in the shop from 18:30 UTC on a browser set to UTC) — until the person chooses other days.
const today = api === null ? '' : api.todayAtShop();
$('from').value = today === '' ? '' : `${today.slice(0, 7)}-01`;
$('to').value = today;

function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function say(out) { $('page-status').className = 'status err'; $('page-status').textContent = api.outcomeWords(lang, out); }

function drawMap() {
  const floor = $('floor');
  floor.replaceChildren();
  floor.style.aspectRatio = `${heat.widthFt} / ${heat.depthFt}`;
  floor.setAttribute('aria-label', t('mapLabel'));
  const pct = (n, of) => `${(n * 100) / of}%`;
  for (const a of heat.areas) {
    const band = api.heatBand(a.heat);
    const box = document.createElement('div');
    box.className = 'area';
    box.tabIndex = 0;
    box.dataset.area = a.areaId;
    box.dataset.band = band === null ? 'unknown' : String(band);
    // Front of the shop at the bottom: the plan's y runs from the front, the screen's from the top.
    box.style.left = pct(a.x, heat.widthFt);
    box.style.top = pct(heat.depthFt - a.y - a.depth, heat.depthFt);
    box.style.width = pct(a.width, heat.widthFt);
    box.style.height = pct(a.depth, heat.depthFt);
    box.textContent = a.heat === null ? `${api.areaName(lang, a)} · ${t('notKnown')}` : api.areaName(lang, a);
    box.setAttribute('aria-label', `${api.areaName(lang, a)}: ${api.figureWords(lang, a, measure)}`);
    const show = (ev) => {
      const tip = $('tip');
      tip.replaceChildren(text('strong', api.areaName(lang, a)), document.createElement('br'), text('span', `${t(measure)}: ${api.figureWords(lang, a, measure)}`), document.createElement('br'), text('span', `${t('sqft')}: ${a.squareFeet}`));
      for (const n of api.areaNotes(lang, a, measure)) { tip.append(document.createElement('br'), text('span', n)); }
      const r = box.getBoundingClientRect();
      tip.style.left = `${Math.max(8, Math.min(window.innerWidth - 270, (ev.clientX ?? r.left + r.width / 2) + 12))}px`;
      tip.style.top = `${(ev.clientY ?? r.top + r.height / 2) + 12}px`;
      tip.hidden = false;
    };
    box.addEventListener('pointermove', show); box.addEventListener('focus', show);
    box.addEventListener('pointerleave', () => { $('tip').hidden = true; }); box.addEventListener('blur', () => { $('tip').hidden = true; });
    floor.append(box);
  }
}

function drawLegend() {
  const legend = $('legend');
  legend.replaceChildren(text('span', t('legendLow')));
  const swatch = (band) => { const sw = document.createElement('span'); sw.className = 'sw'; sw.dataset.band = band; sw.setAttribute('aria-hidden', 'true'); return sw; };
  for (let b = 0; b <= 4; b += 1) legend.append(swatch(String(b)));
  legend.append(text('span', t('legendHigh')), swatch('unknown'), text('span', t('legendUnknown')));
}

/** Every area as a row of the chrome's register: the figure, the heat as a number (or "Not known"), the notes in words. */
function drawTable() {
  const o = office(); if (!o) return;
  const rows = [...heat.areas].sort((a, b) => (b.heat ?? -1) - (a.heat ?? -1) || (a.areaId < b.areaId ? -1 : 1));
  const both = (k) => ({ en: wordsIn('en', k), ta: wordsIn('ta', k) });
  const span = (cls, text) => { const x = document.createElement('span'); x.className = cls; x.textContent = text; return x; };
  o.table($('areas'), {
    id: 'areas', label: both('mapLabel'), pageSize: 25, sortable: true, search: false, count: false, rows,
    rowKey: (a) => a.areaId, rowData: (a) => ({ area: a.areaId }),
    columns: [
      { key: 'area', label: both('thArea'), value: (a) => api.areaName(lang, a) },
      { key: 'sqft', label: both('thSqft'), sort: 'number', align: 'end', value: (a) => a.squareFeet },
      { key: 'fig', label: both(measure), sort: false, align: 'end', value: (a) => api.figureWords(lang, a, measure), render: (a) => span('fig', api.figureWords(lang, a, measure)) },
      { key: 'heat', label: both('thHeat'), sort: 'number', align: 'end', value: (a) => a.heat, render: (a) => span('heat', a.heat === null ? o.words('notKnown') : String(a.heat)) },
      { key: 'note', label: both('thNote'), sort: false, value: (a) => api.areaNotes(lang, a, measure).join(' · '), render: (a) => { const notes = api.areaNotes(lang, a, measure); const cell = document.createElement('span'); cell.className = 'note'; for (const n of notes) cell.append(o.chip('degraded', n)); return cell; } },
    ],
  });
  const off = heat.notOnFloorPlan;
  const offPlan = $('off-plan');
  offPlan.replaceChildren(off.products.length === 0
    ? o.chip('ok', t('offPlanNone'))
    : o.chip('degraded', `${t('offPlan')}: ${off.products.join(', ')} (${api.rupees(off.salesMinor)})`));
}


// U2 · G5 (UI/UX gap audit): the signed-in person's own store is filled in from the store computer (`sreOffice.me`) —
// the id stays what the page sends, the store's NAME is said beside it, and a person who may hold more than one store can
// still change it. Off the box, or before the chrome has loaded, nothing is filled in.
function ownStore(inputId) {
  const me = window.sreOffice?.me?.() ?? null;
  const input = $(inputId);
  if (me === null || !me.storeId || input === null) return;
  if (input.value.trim() === '') input.value = me.storeId;
  let note = document.getElementById(`${inputId}-own`);
  if (note === null) { note = document.createElement('small'); note.id = `${inputId}-own`; note.className = 'sre-why own-store'; input.after(note); }
  note.textContent = `${me.storeName ?? me.storeId} — ${t('yourStore')}`;
}
function paint() {
  ownStore('store');
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title-text', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['store-l', 'store'], ['from-l', 'from'], ['to-l', 'to'], ['m-sales-text', 'sales'], ['m-margin-text', 'margin'], ['show-text', 'show'], ['th-area', 'area'], ['th-sqft', 'sqft'], ['th-heat', 'heat'], ['th-note', 'note']]) { const n = $(id); if (n) n.textContent = t(k); }
  $('lang').textContent = t('lang');
  $('whoami').textContent = window.floorHeatMapData?.userId ?? '';
  $('nobody').hidden = may.named; $('nobody').textContent = t('nobody');
  $('show').disabled = !may.read; whyDisabled($('show'), may.read ? '' : 'role');
  $('m-sales').setAttribute('aria-pressed', String(measure === 'sales'));
  $('m-margin').setAttribute('aria-pressed', String(measure === 'margin'));
  $('map-section').hidden = heat === null;
  if (heat === null) return;
  $('map-h').textContent = `${t(measure)} · ${heat.storeId} · ${heat.from} – ${heat.to}`;
  $('map-meta').textContent = `${t('plan')} ${heat.planVersion} · ${t('asAt')} ${heat.asAt}`;
  drawMap(); drawLegend(); drawTable();
}

async function show() {
  const out = await session.read({ storeId: $('store').value, from: dateOf('from'), to: dateOf('to'), measure });
  if (out.result === 'ok') { heat = out.value; $('page-status').className = 'status'; $('page-status').textContent = ''; } else { heat = null; say(out); }
  paint();
}

$('show').addEventListener('click', () => { void show(); });
for (const m of ['sales', 'margin']) $(`m-${m}`).addEventListener('click', () => { measure = m; paint(); if (heat !== null) void show(); });
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
// Wave 2: the box names its own store, so the page starts on it (head office still answers only what the person may see).
if (typeof window.floorHeatMapData?.storeId === 'string' && $('store').value === '') $('store').value = window.floorHeatMapData.storeId;
paint();
if (may.named && !may.read) { $('page-status').className = 'status err'; $('page-status').textContent = t('cannotRead'); }

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}

/** A greyed button says why (U1 · G3 · design system §4 "disabled state explains why"): the reason is the button's tooltip
 *  and the words beside it, in the reader's language. `why` is 'role' (your role may not), 'offline' (head office cannot
 *  be reached), a page's own { en, ta } pair or sentence; '' takes the words away. */
function whyWords() {
  return {
  role: { en: 'Your role may not do this.', ta: 'உங்கள் பங்குக்கு இதைச் செய்ய அனுமதி இல்லை.' },
  offline: { en: 'Head office cannot be reached, so this cannot be done now.', ta: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை, எனவே இப்போது இதைச் செய்ய முடியாது.' },
  };
}
function whyDisabled(btn, why) {
  const tongue = document.documentElement.lang === 'ta' ? 'ta' : 'en';
  const words = why === '' || why === undefined || why === null ? '' : typeof why === 'string' ? (whyWords()[why]?.[tongue] ?? why) : (why[tongue] ?? why.en);
  let note = btn.nextElementSibling;
  if (!(note && note.classList.contains('sre-why'))) {
    note = document.createElement('small'); note.className = 'sre-why';
    note.id = `${btn.id || `b${Math.random().toString(36).slice(2, 7)}`}-why`;
    btn.after(note);
  }
  note.textContent = words; note.hidden = words === '';
  if (words === '') { btn.removeAttribute('title'); btn.removeAttribute('aria-describedby'); } else { btn.title = words; btn.setAttribute('aria-describedby', note.id); }
}
// the chrome (and `sreOffice.me`) loads after this script: fill the store in once it is there
document.addEventListener('sre:chrome', () => { const o = office(); o.shopDate('from', { en: wordsIn('en', 'from'), ta: wordsIn('ta', 'from') }); o.shopDate('to', { en: wordsIn('en', 'to'), ta: wordsIn('ta', 'to') }); paint(); });
