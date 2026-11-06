// Delivery area and slots — how far the shop delivers, its fee and minimum order, and its delivery slots with how full each
// is (W3 · M18-FR-01/03 · D08 · AVR-13). The session (apps/web-erp/src/delivery-area-session.ts, in the bundle as
// window.deliveryArea) asks head office; this page shows its answers. Every figure reads "not set" until the owner types it —
// head office's standard 10 km is never shown as his own number. Every word has a Tamil twin. Nothing on a timer.

const $ = (id) => document.getElementById(id);

/** A greyed button says why (U1 · G3 · design system §4 "disabled state explains why"): the reason is the button's tooltip
 *  and the words beside it, in the reader's language. `why` is 'role' (your role may not), 'offline' (head office cannot
 *  be reached), a page's own { en, ta } pair or sentence; '' takes the words away. */
const WHY_WORDS = {
  role: { en: 'Your role may not do this.', ta: 'உங்கள் பங்குக்கு இதைச் செய்ய அனுமதி இல்லை.' },
  offline: { en: 'Head office cannot be reached, so this cannot be done now.', ta: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை, எனவே இப்போது இதைச் செய்ய முடியாது.' },
};
function whyDisabled(btn, why) {
  const tongue = document.documentElement.lang === 'ta' ? 'ta' : 'en';
  const words = why === '' || why === undefined || why === null ? '' : typeof why === 'string' ? (WHY_WORDS[why]?.[tongue] ?? why) : (why[tongue] ?? why.en);
  let note = btn.nextElementSibling;
  if (!(note && note.classList.contains('sre-why'))) {
    note = document.createElement('small'); note.className = 'sre-why';
    note.id = `${btn.id || `b${Math.random().toString(36).slice(2, 7)}`}-why`;
    btn.after(note);
  }
  note.textContent = words; note.hidden = words === '';
  if (words === '') { btn.removeAttribute('title'); btn.removeAttribute('aria-describedby'); } else { btn.title = words; btn.setAttribute('aria-describedby', note.id); }
}
const api = window.deliveryArea ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, set: false };

let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
let area = null;
let history = null;
let slots = null;
let places = null;

const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
for (const [id, name] of [['show-area', 'search'], ['save-area', 'circle-check'], ['show-history', 'history'], ['show-slots', 'calendar-days'], ['save-slots', 'circle-check'], ['show-places', 'store'], ['save-place', 'circle-check']]) { const i = icon(name); if (i !== null) $(id).prepend(i); }

function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function bad(where, out) { $(where).className = 'status err'; $(where).textContent = `⚠ ${api.outcomeWords(lang, out)}`; }
function good(where, words) { $(where).className = 'status good'; $(where).textContent = `✓ ${words}`; }
// The shop's own clock time (api.moment reads the shop's zone, never the device's): "YYYY-MM-DD HH:MM" → "HH:MM".
const hhmm = (iso) => api.moment(iso).split(' ')[1] ?? '';

function paintArea() {
  if (area === null) { $('area').replaceChildren(); $('area-default').hidden = true; return; }
  const shown = api.shown(lang, area);
  $('area').replaceChildren(...[['radius', shown.radius], ['minimum', shown.minimum], ['fee', shown.fee], ['freeAbove', shown.freeAbove], ['from', shown.from]].flatMap(([k, v]) => {
    const dd = text('dd', v); dd.dataset.field = k; if (v === t('notSet')) dd.className = 'unset';
    return [text('dt', t(k)), dd];
  }));
  $('area-default').hidden = !shown.isDefault; $('area-default').textContent = `○ ${t('usingDefault')}`;
}

function paintHistory() {
  if (history === null) { $('history').replaceChildren(); return; }
  if (history.length === 0) { $('history').replaceChildren(text('li', `○ ${t('noHistory')}`, 'row')); return; }
  $('history').replaceChildren(...history.map((p) => {
    const li = document.createElement('li'); li.className = 'row'; li.dataset.from = p.effectiveFrom;
    const s = api.shown(lang, { policy: p.policy, source: 'scheduled', effectiveFrom: p.effectiveFrom, on: p.effectiveFrom });
    li.append(text('strong', `${t('from')} ${p.effectiveFrom}`));
    li.append(text('span', `${t('radius')}: ${s.radius} · ${t('minimum')}: ${s.minimum} · ${t('fee')}: ${s.fee} · ${t('freeAbove')}: ${s.freeAbove}`, 'facts'));
    return li;
  }));
}

function paintSlots() {
  if (slots === null) { $('slots').replaceChildren(); $('service').textContent = ''; return; }
  const c = slots.deliveryService;
  if (c === null) { $('service').textContent = `○ ${t('noService')}`; $('service').dataset.state = 'not_set'; $('slots').replaceChildren(); return; }
  $('service').dataset.state = 'set';
  $('service').textContent = `${t('storeAt')}: ${c.storeLocation.lat}, ${c.storeLocation.lon} · ${t('slotsPerDay')}: ${c.slotsPerDay} · ${c.windowOpen}–${c.windowClose} · ${t('capacity')}: ${c.capacityPerSlot} · ${t('lead2')}: ${c.leadMinutes} · ${t('setBy')} ${c.setBy}, ${api.moment(c.setAt)}`;
  $('slots').replaceChildren(...(slots.slots ?? []).map((s) => {
    const full = s.taken >= s.capacity;
    const li = document.createElement('li'); li.className = `row tone-${full ? 'degraded' : 'ok'}`; li.dataset.slot = s.slotId;
    li.append(text('strong', `${full ? '⚠' : '○'} ${hhmm(s.startsAt)}–${hhmm(s.endsAt)} — ${s.taken} / ${s.capacity} ${t('slotTaken')}`));
    return li;
  }));
}

function paintPlaces() {
  if (places === null) { $('places').replaceChildren(); return; }
  if (places.length === 0) { $('places').replaceChildren(text('li', `○ ${t('noPlaces')}`, 'row')); return; }
  $('places').replaceChildren(...places.map((p) => {
    const li = document.createElement('li'); li.className = 'row tone-ok'; li.dataset.place = p.locationId; li.dataset.kind = p.kind;
    li.append(text('strong', `${p.locationId} — ${t(`kind_${p.kind}`)}`));
    li.append(text('span', [
      `${t('pickup')}: ${t(p.acceptsPickup ? 'yes' : 'no')}`, `${t('delivery')}: ${t(p.acceptsDelivery ? 'yes' : 'no')}`,
      `${t('radius')}: ${(p.deliveryRadiusMetres / 1000).toLocaleString('en-IN', { maximumFractionDigits: 3 })} ${t('km')}`,
      p.expressMinutes === undefined ? t('noExpress') : `${t('expressIn')} ${p.expressMinutes} ${t('minutes')}`,
      `${t('perSlotK')}: ${p.capacityPerSlot === undefined ? t('notSet') : p.capacityPerSlot}`,
      `${t('setBy')} ${p.setBy}, ${api.moment(p.setAt)}`,
    ].join(' · '), 'facts'));
    return li;
  }));
}

function paint() {
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title-text', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['area-h', 'areaH'], ['l-area-on', 'on'], ['show-area-text', 'showArea'],
    ['set-area-h', 'setAreaH'], ['l-a-from', 'startFrom'], ['l-a-radius', 'radiusKm'], ['l-a-minimum', 'minimumRs'], ['l-a-fee', 'feeRs'], ['l-a-free', 'freeAboveRs'], ['save-area-text', 'saveArea'],
    ['history-h', 'historyH'], ['show-history-text', 'showHistory'], ['slots-h', 'slotsH'], ['l-slots-day', 'day'], ['show-slots-text', 'showSlots'],
    ['set-slots-h', 'setSlotsH'], ['l-s-lat', 'lat'], ['l-s-lon', 'lon'], ['l-s-count', 'slotsPerDay'], ['l-s-open', 'open'], ['l-s-close', 'close'], ['l-s-capacity', 'capacity'], ['l-s-lead', 'lead2'], ['save-slots-text', 'saveSlots'],
    ['places-h', 'placesH'], ['places-lead', 'placesLead'], ['show-places-text', 'showPlaces'], ['l-p-id', 'placeId'], ['l-p-kind', 'kind'], ['l-p-lat', 'lat'], ['l-p-lon', 'lon'],
    ['l-p-radius', 'radiusPlace'], ['l-p-express', 'express'], ['l-p-slot', 'perSlot'], ['l-p-pickup', 'pickup'], ['l-p-delivery', 'delivery'], ['save-place-text', 'savePlace']]) $(id).textContent = t(k);
  for (const o of $('p-kind').options) o.textContent = t(`kind_${o.value}`);
  $('lang').textContent = t('lang');
  $('whoami').textContent = window.deliveryAreaData?.userId ?? '';
  $('nobody').hidden = may.named; $('nobody').textContent = t('nobody');
  for (const id of ['show-area', 'area-on', 'show-history', 'show-slots', 'slots-day', 'show-places']) $(id).disabled = !may.read;
  for (const id of ['show-area', 'show-history', 'show-slots', 'show-places']) whyDisabled($(id), may.read ? '' : 'role');
  for (const id of ['save-place', 'p-id', 'p-kind', 'p-lat', 'p-lon', 'p-radius', 'p-express', 'p-slot', 'p-pickup', 'p-delivery']) $(id).disabled = !may.set;
  whyDisabled($('save-place'), may.set ? '' : 'role');
  for (const id of ['save-area', 'a-from', 'a-radius', 'a-minimum', 'a-fee', 'a-free', 'save-slots', 's-lat', 's-lon', 's-count', 's-open', 's-close', 's-capacity', 's-lead']) $(id).disabled = !may.set;
  whyDisabled($('save-area'), may.set ? '' : 'role'); whyDisabled($('save-slots'), may.set ? '' : 'role');
  paintArea(); paintHistory(); paintSlots(); paintPlaces();
}

async function showArea() {
  const out = await session.area($('area-on').value);
  if (out.result !== 'ok') { area = null; bad('area-status', out); paintArea(); return; }
  area = out.value; $('area-status').className = 'status'; $('area-status').textContent = '';
  paintArea();
}
async function showHistory() {
  const out = await session.history();
  if (out.result !== 'ok') { history = null; bad('history-status', out); paintHistory(); return; }
  history = out.value.schedule; $('history-status').className = 'status'; $('history-status').textContent = '';
  paintHistory();
}
async function saveArea() {
  const out = await session.setArea({ from: $('a-from').value, radiusKm: $('a-radius').value, minimum: $('a-minimum').value, fee: $('a-fee').value, freeAbove: $('a-free').value });
  if (out.result !== 'ok') { bad('set-area-status', out); return; }
  good('set-area-status', `${t('areaSaved')} ${out.value.period.effectiveFrom}.`);
  for (const id of ['a-radius', 'a-minimum', 'a-fee', 'a-free']) $(id).value = '';
  await showHistory();
  if ($('area-on').value !== '') await showArea();
}
async function showSlots() {
  const out = await session.slots($('slots-day').value);
  if (out.result !== 'ok') { slots = null; bad('slots-status', out); paintSlots(); return; }
  slots = out.value; $('slots-status').className = 'status'; $('slots-status').textContent = '';
  paintSlots();
}
async function saveSlots() {
  const out = await session.setSlots({ lat: $('s-lat').value, lon: $('s-lon').value, slotsPerDay: $('s-count').value, open: $('s-open').value, close: $('s-close').value, capacity: $('s-capacity').value, leadMinutes: $('s-lead').value });
  if (out.result !== 'ok') { bad('set-slots-status', out); return; }
  good('set-slots-status', t('slotsSaved'));
  if ($('slots-day').value !== '') await showSlots();
}

async function showPlaces() {
  const out = await session.places();
  if (out.result !== 'ok') { places = null; bad('places-status', out); paintPlaces(); return; }
  places = out.value.locations; $('places-status').className = 'status'; $('places-status').textContent = '';
  paintPlaces();
}
async function savePlace() {
  const out = await session.setPlace({ locationId: $('p-id').value, kind: $('p-kind').value, lat: $('p-lat').value, lon: $('p-lon').value, pickup: $('p-pickup').checked, delivery: $('p-delivery').checked, radiusKm: $('p-radius').value, expressMinutes: $('p-express').value, perSlot: $('p-slot').value });
  if (out.result !== 'ok') { bad('set-place-status', out); return; }
  good('set-place-status', `${t('placeSaved')} ${out.value.location.locationId}`);
  await showPlaces();
}
$('show-places').addEventListener('click', () => { void showPlaces(); });
$('save-place').addEventListener('click', () => { void savePlace(); });
// A dark store has no shop floor: it takes no pickup (head office refuses one too).
$('p-kind').addEventListener('change', () => { if ($('p-kind').value === 'dark_store') $('p-pickup').checked = false; $('p-pickup').disabled = !may.set || $('p-kind').value === 'dark_store'; });
$('show-area').addEventListener('click', () => { void showArea(); });
$('save-area').addEventListener('click', () => { void saveArea(); });
$('show-history').addEventListener('click', () => { void showHistory(); });
$('show-slots').addEventListener('click', () => { void showSlots(); });
$('save-slots').addEventListener('click', () => { void saveSlots(); });
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
if (api !== null) { const today = api.today(); $('area-on').value = today; $('slots-day').value = today; $('a-from').value = today; }
paint();
if (may.named && !may.read) { $('page-status').className = 'status err'; $('page-status').textContent = `⚠ ${t('cannotRead')}`; }

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}
