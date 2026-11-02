// Store events — the page over head office's D-24 routes (R4 · OB-220 · signed OB-227). The session (apps/web-erp/src/
// demand-events-session.ts, in the bundle as window.demandEvents) asks head office; this page only shows its answers: the
// events in the store's calendar with how each effect is known ("manager's estimate" until back-tested), the next 7 days
// of a product's forecast with every event named on the day it changes and the correction from the last 7 days beside its
// back-test error, and the weather link — switched off. Nothing is written on open. Every word has a Tamil twin.

const $ = (id) => document.getElementById(id);
const api = window.demandEvents ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, manage: false };

let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
let events = null;
let forecast = null;

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function row(cells, attrs = {}) {
  const tr = document.createElement('tr');
  for (const c of cells) { const td = document.createElement('td'); td.textContent = c; tr.append(td); }
  for (const [k, v] of Object.entries(attrs)) tr.dataset[k] = v;
  return tr;
}
function say(id, out, good) { $(id).className = `status ${good ? 'good' : 'err'}`; $(id).textContent = good ? out : api.outcomeWords(lang, out); }
const fill = (s, vars) => Object.entries(vars).reduce((acc, [k, v]) => acc.replace(`{${k}}`, v), s);
const pct = (x) => `${(x * 100).toFixed(1)}%`;

function paint() {
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title-text', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['l-store', 'store'], ['show', 'show'], ['record-h', 'recordH'], ['l-label', 'label'], ['l-kind', 'kind'], ['o-festival', 'festival'], ['o-local', 'local_event'],
    ['l-ev-from', 'from'], ['l-ev-to', 'to'], ['l-effect', 'effect'], ['l-products', 'products'], ['save', 'save'], ['events-h', 'eventsH'], ['forecast-h', 'forecastH'], ['l-product', 'product'], ['forecast', 'forecast']]) $(id).textContent = t(k);
  $('lang').textContent = t('lang');
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
  $('forecast-rows').replaceChildren(...(forecast === null ? [] : [row([t('day'), t('forecastCol'), t('correctedCol'), t('eventsCol')], { head: 'true' }), ...days.map((d) => row([d.day, String(d.forecastQty), d.correctedQty === null ? '—' : String(d.correctedQty), d.appliedSignals.join(', ')], { day: d.day, events: d.appliedSignals.join('|') }))]));
  $('backtest').textContent = sh === undefined ? '' : `${fill(t('factor'), { factor: String(sh.correction.factor) })} ${sh.backtest.notBackTested ? t('notBackTested') : fill(t('backtest'), { days: String(sh.backtest.testedDays), plain: pct(sh.backtest.plainWape), corrected: pct(sh.backtest.correctedWape) })}`;
}

const store = () => $('store').value;
// U1 · OB-626 (design system §1.3, §27.1): a money/stock click asks the shared consequence-and-confirm sheet first.
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
  // U1 · OB-626: the consequence-and-confirm sheet before the event changes the forecasts — Go back sends nothing.
  const effect = Number($('effect').value);
  const pct = Number.isFinite(effect) && effect > 0 ? Math.round(Math.abs(effect - 1) * 100) : null;
  const w = (l, k) => api.words(l, k);
  const effectWords = (l) => (pct === null ? $('effect').value : pct === 0 ? w(l, 'effectSame') : w(l, effect > 1 ? 'effectMore' : 'effectLess').replace('{pct}', String(pct)));
  const productsWords = (l) => ($('products').value.trim() === '' ? w(l, 'allProducts') : $('products').value.trim());
  const sub = (l, key) => String(w(l, key)).replace('{label}', $('label').value.trim()).replace('{kind}', w(l, $('kind').value)).replace('{from}', $('ev-from').value).replace('{to}', $('ev-to').value).replace('{effect}', effectWords(l)).replace('{products}', productsWords(l)).replace('{store}', store());
  // An incomplete form skips the sheet and gets the session's own words on what is missing (nothing is sent either way).
  const complete = store().trim() !== '' && $('label').value.trim() !== '' && $('ev-from').value !== '' && $('ev-to').value !== '' && pct !== null;
  const answer = !complete ? { ok: true } : await confirmFirst({ title: { en: sub('en', 'confirmTitle'), ta: sub('ta', 'confirmTitle') }, detail: { en: sub('en', 'confirmDetail'), ta: sub('ta', 'confirmDetail') }, authority: { en: sub('en', 'confirmAuthority'), ta: sub('ta', 'confirmAuthority') }, confirmLabel: { en: w('en', 'confirmLabel'), ta: w('ta', 'confirmLabel') }, tone: 'primary' });
  if (answer === 'unavailable') { say('record-status', t('confirmUnavailable'), false); return; }
  if (answer === null) return;
  const out = await session.record({ storeId: store(), label: $('label').value, kind: $('kind').value, from: $('ev-from').value, to: $('ev-to').value, effect: $('effect').value, products: $('products').value });
  if (out.result === 'ok') { say('record-status', t('recorded'), true); await show(); } else say('record-status', out, false);
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
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (may.named && !may.read) { $('page-status').className = 'status err'; $('page-status').textContent = t('cannotRead'); }

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}
