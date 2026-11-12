// Store events — the page over head office's D-24 routes (R4 · OB-220 · signed OB-227). The session (apps/web-erp/src/
// demand-events-session.ts, in the bundle as window.demandEvents) asks head office; this page only shows its answers: the
// events in the store's calendar with how each effect is known ("manager's estimate" until back-tested), the next 7 days
// of a product's forecast with every event named on the day it changes and the correction from the last 7 days beside its
// back-test error, and the weather link — switched off. Nothing is written on open. Every word has a Tamil twin.

const $ = (id) => document.getElementById(id);

// U5 · G17: the chrome's shared parts (window.sreOffice) may load after this page — each part is drawn once it is there,
// and the page keeps its words meanwhile.
const office = () => window.sreOffice ?? null;
const whenChrome = (fn) => { if (window.sreOffice) fn(); else document.addEventListener('sre:chrome', fn, { once: true }); };
const dateOf = (id) => { const o = office(); return o && typeof o.dateOf === 'function' ? (o.dateOf(id) ?? '') : ($(id)?.value ?? ''); };
const api = window.demandEvents ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, manage: false };

let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
let events = null;
let forecast = null;


const paintPickers = () => {}; // U5: the chrome's `pickable` keeps its own words on the toggle
/** The signed-in person's own store, from the chrome (sreOffice.me) or the store computer's directory — '' when not known. */
function myStore() {
  const office = window.sreOffice;
  const me = office && typeof office.me === 'function' ? office.me() : null;
  return (me && me.storeId) || (window.sreDirectory && window.sreDirectory.store && window.sreDirectory.store.id) || '';
}
const prefillStore = () => { if ($('store').value.trim() === '') { const id = myStore(); if (id !== '') $('store').value = id; } };
/** The products an event is limited to, chosen one by one: { id, name }. The hidden #products carries the ids the session reads. */
let pickedProducts = [];
function paintPickedProducts() {
  $('products').value = pickedProducts.map((p) => p.id).join(',');
  $('product-list').replaceChildren(...(pickedProducts.length === 0 ? [] : pickedProducts.map((p) => {
    const li = el('li'); li.dataset.product = p.id;
    const remove = el('button', 'sre-btn sre-btn-quiet', t('remove')); remove.type = 'button';
    remove.setAttribute('aria-label', `${t('remove')} ${p.name}`);
    remove.addEventListener('click', () => { pickedProducts = pickedProducts.filter((x) => x.id !== p.id); paintPickedProducts(); });
    li.append(el('span', '', p.name === p.id ? p.id : `${p.name} (${p.id})`), remove);
    return li;
  })));
}
/** What the typed effect means, in words beside the box ("That means orders 50% higher than usual."). */
function paintEffectWords() {
  const effect = Number($('effect').value);
  const pct = Number.isFinite(effect) && effect > 0 && $('effect').value.trim() !== '' ? Math.round(Math.abs(effect - 1) * 100) : null;
  const w = (k) => api.words(lang, k);
  $('effect-words').textContent = pct === null ? '' : w('effectHint').replace('{effect}', pct === 0 ? w('effectSame') : w(effect > 1 ? 'effectMore' : 'effectLess').replace('{pct}', String(pct)));
}
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
let forecastTable = null;
/** The next seven days on the chrome's register: the day, the forecast, the corrected figure, the events named on that day. */
function paintForecast(days) {
  const o = office(); const host = $('forecast');
  host.hidden = forecast === null;
  if (!o || forecast === null) return;
  const both = (k) => ({ en: api.words('en', k), ta: api.words('ta', k) });
  if (forecastTable === null || !forecastTable.connected()) {
    forecastTable = o.table(host, {
      id: 'forecast', label: both('forecastH'), pageSize: 14, sortable: false, search: false, count: false, bodyId: 'forecast-rows', rows: null,
      rowKey: (d) => d.day, rowData: (d) => ({ day: d.day, events: d.appliedSignals.join('|') }),
      columns: [
        { key: 'day', label: both('day'), value: (d) => d.day }, { key: 'forecast', label: both('forecastCol'), align: 'end', value: (d) => String(d.forecastQty) },
        { key: 'corrected', label: both('correctedCol'), align: 'end', value: (d) => (d.correctedQty === null ? null : String(d.correctedQty)) },
        { key: 'events', label: both('eventsCol'), value: (d) => d.appliedSignals.join(', '), render: (d) => (d.appliedSignals.length === 0 ? document.createTextNode('') : document.createTextNode(d.appliedSignals.join(', '))) },
      ],
    });
  }
  forecastTable.setRows(days);
}
function say(id, out, good) { $(id).className = `status ${good ? 'good' : 'err'}`; $(id).textContent = good ? out : api.outcomeWords(lang, out); }
const fill = (s, vars) => Object.entries(vars).reduce((acc, [k, v]) => acc.replace(`{${k}}`, v), s);
const pct = (x) => `${(x * 100).toFixed(1)}%`;

function paint() {
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title-text', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['l-store', 'store'], ['show', 'show'], ['record-h', 'recordH'], ['l-label', 'label'], ['l-kind', 'kind'], ['o-festival', 'festival'], ['o-local', 'local_event'],
    ['l-ev-from', 'from'], ['l-ev-to', 'to'], ['l-effect', 'effect'], ['l-products', 'products'], ['save', 'save'], ['events-h', 'eventsH'], ['forecast-h', 'forecastH'], ['l-product', 'product'], ['forecast', 'forecast']]) { const n = $(id); if (n) n.textContent = t(k); }
  $('lang').textContent = t('lang');
  $('products-hint').textContent = t('allProductsHint'); $('add-product').textContent = t('addProduct');
  paintPickers(); paintPickedProducts(); paintEffectWords();
  $('whoami').textContent = window.demandEventsData?.userId ?? '';
  $('nobody').hidden = may.named; $('nobody').textContent = t('nobody');
  $('save').disabled = !may.manage; $('show').disabled = !may.read; $('forecast').disabled = !may.read;
  whyDisabled($('save'), may.manage ? '' : 'role'); whyDisabled($('show'), may.read ? '' : 'role'); whyDisabled($('forecast'), may.read ? '' : 'role');
  const weather = forecast?.weather ?? events?.weather;
  $('weather').textContent = weather?.detail ?? ''; $('weather').dataset.state = weather?.state ?? '';

  $('events').replaceChildren(...(events === null ? [] : events.events.length === 0 ? [el('li', 'row', t('noEvents'))] : events.events.map((e) => {
    const li = el('li', `row ${e.effect.basis === 'manager_estimate' ? 'tone-degraded' : 'tone-ok'}`); li.dataset.event = e.eventId; li.dataset.basis = e.effect.basis;
    li.append(el('strong', '', `${e.label} — ${t(e.kind)}`), el('span', 'facts', `${e.from} → ${e.to} · ${api.effectWords(lang, e)} · ${e.productIds?.length ? e.productIds.join(', ') : t('allProducts')}`));
    if (may.manage) {
      const f = el('form'); const label = el('label'); const input = el('input'); input.className = 'withdraw-reason'; input.autocomplete = 'off';
      label.append(el('span', '', t('withdrawReason')), input);
      const b = el('button', 'withdraw', t('withdraw')); b.type = 'submit';
      f.append(label, b);
      f.addEventListener('submit', (ev) => { ev.preventDefault(); void withdraw(e.eventId, input.value); });
      li.append(f);
    }
    return li;
  })));

  const sh = forecast?.shortHorizon;
  const days = sh?.horizon ?? (forecast?.horizon ?? []).map((d) => ({ ...d, correctedQty: null }));
  paintForecast(days);
  $('backtest').textContent = sh === undefined ? '' : `${fill(t('factor'), { factor: String(sh.correction.factor) })} ${sh.backtest.notBackTested ? t('notBackTested') : fill(t('backtest'), { days: String(sh.backtest.testedDays), plain: pct(sh.backtest.plainWape), corrected: pct(sh.backtest.correctedWape) })}`;
}

const store = () => $('store').value;
// U1 · OB-698 (design system §1.3, §27.1): a money/stock click asks the shared consequence-and-confirm sheet first.
// `null` = the person went back (nothing is sent); 'unavailable' = the sheet could not open (said, never silent).
async function confirmFirst(spec) {
  const office = window.sreOffice;
  if (!office || typeof office.confirm !== 'function') return 'unavailable';
  const answer = await office.confirm(spec);
  return answer && answer.ok === true ? answer : null;
}


/** A greyed button says why (U1 · G3 · design system §4 "disabled state explains why"): the reason is the button's tooltip
 *  and the words beside it, in the reader's language. `why` is 'role' (your role may not) or a page's own { en, ta } pair;
 *  '' takes the words away. */
const WHY_WORDS = {
  role: { en: 'Your role may not do this.', ta: 'உங்கள் பங்குக்கு இதைச் செய்ய அனுமதி இல்லை.' },
};
function whyDisabled(btn, why) {
  const tongue = document.documentElement.lang === 'ta' ? 'ta' : 'en';
  const words = why === '' || why === undefined || why === null ? '' : typeof why === 'string' ? (WHY_WORDS[why]?.[tongue] ?? why) : (why[tongue] ?? why.en);
  let note = btn.nextElementSibling;
  if (!(note && note.classList.contains('sre-why'))) {
    note = document.createElement('small'); note.className = 'sre-why';
    note.id = `${btn.id}-why`;
    btn.after(note);
  }
  note.textContent = words; note.hidden = words === '';
  if (words === '') { btn.removeAttribute('title'); btn.removeAttribute('aria-describedby'); } else { btn.title = words; btn.setAttribute('aria-describedby', note.id); }
}

async function show(event) {
  event?.preventDefault();
  const out = await session.events(store());
  if (out.result === 'ok') { events = out.value; $('page-status').className = 'status'; $('page-status').textContent = ''; } else { events = null; say('page-status', out, false); }
  paint();
}
async function record(event) {
  event.preventDefault();
  // U1 · OB-698: the consequence-and-confirm sheet before the event changes the forecasts — Go back sends nothing.
  const effect = Number($('effect').value);
  const pct = Number.isFinite(effect) && effect > 0 ? Math.round(Math.abs(effect - 1) * 100) : null;
  const w = (l, k) => api.words(l, k);
  const effectWords = (l) => (pct === null ? $('effect').value : pct === 0 ? w(l, 'effectSame') : w(l, effect > 1 ? 'effectMore' : 'effectLess').replace('{pct}', String(pct)));
  const productsWords = (l) => (pickedProducts.length === 0 ? w(l, 'allProducts') : pickedProducts.map((p) => p.name).join(', '));
  const sub = (l, key) => String(w(l, key)).replace('{label}', $('label').value.trim()).replace('{kind}', w(l, $('kind').value)).replace('{from}', dateOf('ev-from')).replace('{to}', dateOf('ev-to')).replace('{effect}', effectWords(l)).replace('{products}', productsWords(l)).replace('{store}', store());
  // An incomplete form skips the sheet and gets the session's own words on what is missing (nothing is sent either way).
  const complete = store().trim() !== '' && $('label').value.trim() !== '' && dateOf('ev-from') !== '' && dateOf('ev-to') !== '' && pct !== null;
  const answer = !complete ? { ok: true } : await confirmFirst({ title: { en: sub('en', 'confirmTitle'), ta: sub('ta', 'confirmTitle') }, detail: { en: sub('en', 'confirmDetail'), ta: sub('ta', 'confirmDetail') }, authority: { en: sub('en', 'confirmAuthority'), ta: sub('ta', 'confirmAuthority') }, confirmLabel: { en: w('en', 'confirmLabel'), ta: w('ta', 'confirmLabel') }, tone: 'primary' });
  if (answer === 'unavailable') { say('record-status', t('confirmUnavailable'), false); return; }
  if (answer === null) return;
  const out = await session.record({ storeId: store(), label: $('label').value, kind: $('kind').value, from: dateOf('ev-from'), to: dateOf('ev-to'), effect: $('effect').value, products: $('products').value });
  if (out.result === 'ok') { say('record-status', t('recorded'), true); pickedProducts = []; paintPickedProducts(); await show(); } else say('record-status', out, false);
}
async function withdraw(eventId, reason) {
  const out = await session.withdraw(eventId, reason);
  if (out.result === 'ok') { say('withdraw-status', t('withdrawn'), true); await show(); } else say('withdraw-status', out, false);
}
async function showForecast(event) {
  event.preventDefault();
  const out = await session.forecast($('product').value);
  if (out.result === 'ok') { forecast = out.value; $('forecast-status').className = 'status'; $('forecast-status').textContent = ''; } else { forecast = null; say('forecast-status', out, false); }
  paint();
}

$('ask').addEventListener('submit', (e) => { void show(e); });
$('record').addEventListener('submit', (e) => { void record(e); });
$('fc').addEventListener('submit', (e) => { void showForecast(e); });
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); if (forecastTable !== null) forecastTable.repaint(); });
whenChrome(() => {
  const o = office(); const both = (k) => ({ en: api === null ? k : api.words('en', k), ta: api === null ? k : api.words('ta', k) });
  o.pickable($('store'), 'store', both('whichStore'));
  o.pickable($('product'), 'product', both('whichProduct'));
  if (api !== null) { o.shopDate('ev-from', both('from'), { required: true }); o.shopDate('ev-to', both('to'), { required: true }); }
});
$('add-product').addEventListener('click', async () => {
  const office = window.sreOffice;
  if (!office || typeof office.pick !== 'function') { say('record-status', t('pickUnavailable'), false); return; }
  const picked = await office.pick({ kind: 'product', title: { en: api.words('en', 'whichProduct'), ta: api.words('ta', 'whichProduct') }, allowCode: true });
  if (!picked || picked.ok !== true) return;
  if (!pickedProducts.some((p) => p.id === picked.id)) pickedProducts.push({ id: picked.id, name: picked.name || picked.id });
  paintPickedProducts();
});
$('effect').addEventListener('input', paintEffectWords);
paint();
prefillStore();
document.addEventListener('sre:chrome', prefillStore);
if (may.named && !may.read) { $('page-status').className = 'status err'; $('page-status').textContent = t('cannotRead'); }

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}

