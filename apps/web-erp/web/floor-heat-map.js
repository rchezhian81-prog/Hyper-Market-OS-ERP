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

const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
for (const [id, name] of [['m-sales', 'indian-rupee'], ['m-margin', 'percent'], ['show', 'layout-grid']]) { const i = icon(name); if (i !== null) $(id).prepend(i); }

// The reading window: this month so far, until the person chooses other days.
const today = new Date();
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
$('from').value = iso(new Date(today.getFullYear(), today.getMonth(), 1));
$('to').value = iso(today);

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
      for (const n of api.areaNotes(lang, a, measure)) { tip.append(document.createElement('br'), text('span', `⚠ ${n}`)); }
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

function drawTable() {
  $('th-fig').textContent = t(measure);
  const rows = [...heat.areas].sort((a, b) => (b.heat ?? -1) - (a.heat ?? -1) || (a.areaId < b.areaId ? -1 : 1)).map((a) => {
    const tr = document.createElement('tr');
    tr.dataset.area = a.areaId;
    const notes = api.areaNotes(lang, a, measure);
    tr.append(text('td', api.areaName(lang, a)), text('td', String(a.squareFeet), 'num'), text('td', api.figureWords(lang, a, measure), 'num fig'),
      text('td', a.heat === null ? `○ ${t('notKnown')}` : `${a.heat}`, 'num heat'), text('td', notes.length === 0 ? '' : notes.map((n) => `⚠ ${n}`).join(' · '), 'note'));
    return tr;
  });
  $('areas').querySelector('tbody').replaceChildren(...rows);
  const off = heat.notOnFloorPlan;
  $('off-plan').textContent = off.products.length === 0 ? `✓ ${t('offPlanNone')}` : `⚠ ${t('offPlan')}: ${off.products.join(', ')} (${api.rupees(off.salesMinor)})`;
}

function paint() {
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title-text', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['store-l', 'store'], ['from-l', 'from'], ['to-l', 'to'], ['m-sales-text', 'sales'], ['m-margin-text', 'margin'], ['show-text', 'show'], ['th-area', 'area'], ['th-sqft', 'sqft'], ['th-heat', 'heat'], ['th-note', 'note']]) $(id).textContent = t(k);
  $('lang').textContent = t('lang');
  $('whoami').textContent = window.floorHeatMapData?.userId ?? '';
  $('nobody').hidden = may.named; $('nobody').textContent = t('nobody');
  $('show').disabled = !may.read;
  $('m-sales').setAttribute('aria-pressed', String(measure === 'sales'));
  $('m-margin').setAttribute('aria-pressed', String(measure === 'margin'));
  $('map-section').hidden = heat === null;
  if (heat === null) return;
  $('map-h').textContent = `${t(measure)} · ${heat.storeId} · ${heat.from} – ${heat.to}`;
  $('map-meta').textContent = `${t('plan')} ${heat.planVersion} · ${t('asAt')} ${heat.asAt}`;
  drawMap(); drawLegend(); drawTable();
}

async function show() {
  const out = await session.read({ storeId: $('store').value, from: $('from').value, to: $('to').value, measure });
  if (out.result === 'ok') { heat = out.value; $('page-status').className = 'status'; $('page-status').textContent = ''; } else { heat = null; say(out); }
  paint();
}

$('show').addEventListener('click', () => { void show(); });
for (const m of ['sales', 'margin']) $(`m-${m}`).addEventListener('click', () => { measure = m; paint(); if (heat !== null) void show(); });
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (may.named && !may.read) { $('page-status').className = 'status err'; $('page-status').textContent = t('cannotRead'); }

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}
