// Stock health — the view layer (M08, API-04, P-03, P-08). Every rule lives in the TESTED session model
// (apps/web-erp/src/inventory-health-session.ts), attached as window.stockHealthSession, built on packages/ui.
// This file only draws what the session hands it: what needs attention first (negative stock worst-first), the
// honest gaps named (uncosted / not-meaningful, never a guessed zero), then the headline numbers. It is
// READ-ONLY — it changes nothing. Refresh re-reads the numbers live (a GET); offline the screen keeps its view
// and the stale strip says the page is what the box last told it. No prompt/confirm/alert.

// OB-607: a moment is shown at the SHOP's clock (its zone, as the store computer told the page) — never this device's.
const shopWhen = (value) => window.sreShopDay?.dateTimeOf(value) ?? '';
const el = (id) => document.getElementById(id);
let lang = 'en';
// U5 · G17: the chrome's shared parts (window.sreOffice) may load after this page — each part is drawn once it is there,
// and the page keeps its words meanwhile.
const office = () => window.sreOffice ?? null;
const whenChrome = (fn) => { if (window.sreOffice) fn(); else document.addEventListener('sre:chrome', fn, { once: true }); };
/** The chrome's state kind for a screen state's tone: an error is an error, a doubt is "not known", the rest is "nothing yet". */
const stateKindOf = (tone) => (tone === 'error' ? 'error' : tone === 'degraded' ? 'unknown' : 'empty');

/** Money in exact minor units → the shop's own display. */
function money(minor, currency) {
  const sym = currency === 'INR' ? '₹' : `${currency} `;
  return sym + (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** A KPI's typed value → a display string. A ratio the engine could not compute shows a dash (the reason rides
 *  as a note); days-of-cover is a plain number (its label carries the unit); turns/GMROI are shown as "×". */
function formatKpi(kpi) {
  const v = kpi.value;
  if (v.kind === 'money') return money(v.minor, v.currency);
  if (v.kind === 'not_meaningful') return null;
  const n = v.bp / 10000;
  return kpi.key === 'daysOfCover' ? String(Math.round(n)) : `${n.toFixed(2)}×`;
}

/** A stand-in with the same surface as the bundled session, so the shell always opens (and says so). It renders
 *  one settled OK signal so the screen is never blank offline. */
function sampleSession() {
  const CHROME = {
    en: {
      title: 'Stock health', langName: 'தமிழ்',
      lead: 'Sample stock health. Connect the store computer to see your own shop’s figures.',
      signalsHeading: 'What needs attention', kpisHeading: 'The numbers', asOfLabel: 'As of', refresh: 'Refresh',
      sampleData: 'Sample data — this is not your shop.', },
    ta: {
      title: 'சரக்கு நலன்', langName: 'English',
      lead: 'மாதிரி சரக்கு நலன். உங்கள் கடையின் எண்களைப் பார்க்க கடை கணினியை இணைக்கவும்.',
      signalsHeading: 'கவனம் தேவைப்படுவது', kpisHeading: 'எண்கள்', asOfLabel: 'நிலவரம்', refresh: 'புதுப்பி',
      sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.', },
  };
  return {
    text: (l, key) => CHROME[l]?.[key] ?? CHROME.en[key] ?? key,
    view: (l) => ({
      screenState: { tone: 'ok', icon: '✓', label: '', announcement: '', needsAttention: false },
      asOf: null,
      signals: [{
        kind: 'healthy',
        status: { tone: 'ok', icon: '✓', label: l === 'ta' ? 'சரக்கு நன்றாக உள்ளது' : 'Stock looks healthy', announcement: 'stock healthy', needsAttention: false },
        productId: null, locationId: null, amountMinor: null, currency: null, detail: '',
      }],
      kpis: [{ key: 'stockValue', label: l === 'ta' ? 'சரக்கு மதிப்பு' : 'Stock value', value: { kind: 'money', minor: 500_00, currency: 'INR' }, attention: false }],
      nobodyNamed: false,
    }),
  };
}

let session = window.stockHealthSession ?? sampleSession();
const t = (key) => session.text(lang, key);
const nameOf = (kind, id) => { const o = window.sreOffice; const key = id ?? ''; return o && typeof o.nameOf === 'function' && key !== '' ? (o.nameOf(kind, key) || key) : key; };

/** One health-signal row. Every row reads as a state — a tone AND an icon AND a word (colour is never alone). */
function signalNode(s) {
  const li = document.createElement('li');
  li.className = `row tone-${s.status.tone}`;

  const head = document.createElement('div');
  head.className = 'head';
  const headline = document.createElement('span');
  headline.className = 'headline';
  headline.textContent = s.status.label;
  head.append(headline);

  // U5 · G13: the state as the one chip (the tone's shape and the word), never a bare character
  const status = document.createElement('span');
  status.className = 'status';
  const o = office();
  if (o) status.append(o.chip(s.status.tone, s.status.label)); else status.textContent = s.status.label;
  status.setAttribute('aria-label', s.status.announcement || s.status.label);

  li.append(head, status);

  // The specifics, in language-neutral facts: the product/location for a negative row, or the value for a
  // money signal. The view reads the kind so it never shows rupees as units.
  const facts = document.createElement('div');
  facts.className = 'facts';
  if (s.kind === 'negative_stock' && s.productId !== null) {
    // U2 · G16: the product's and the place's NAME where the ids were shown (the id itself when no name is known)
    const where = document.createElement('span'); where.textContent = `${nameOf('product', s.productId)} @ ${nameOf('place', s.locationId)}`;
    facts.append(where);
    if (s.amountMinor !== null) { const qty = document.createElement('span'); qty.textContent = `${(s.amountMinor / 100).toLocaleString('en-IN')}`; facts.append(qty); }
    if (s.detail) { const act = document.createElement('span'); act.textContent = s.detail; facts.append(act); }
  } else if ((s.kind === 'uncosted_stock' || s.kind === 'aged_stock') && s.amountMinor !== null) {
    const val = document.createElement('span'); val.textContent = money(s.amountMinor, s.currency ?? 'INR'); facts.append(val);
  }
  if (facts.childElementCount > 0) li.append(facts);
  return li;
}

/** The headline numbers as summary cards: a figure the engine could not compute is "Not known" with its reason beside it. */
function paintKpis(kpis) {
  const o = office(); const host = el('kpis');
  if (!o) { host.replaceChildren(); return; }
  o.cards(host, kpis.map((k) => ({
    label: k.label,
    value: k.value.kind === 'not_meaningful' ? null : formatKpi(k),
    note: k.value.kind === 'not_meaningful' ? k.value.because : undefined,
    tone: k.attention ? 'degraded' : undefined,
  })));
}

function paint() {
  const view = session.view(lang);

  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('whoami').textContent = window.stockHealthData?.userId ?? '';
  el('lang').textContent = t('langName');
  el('refresh').textContent = t('refresh');

  el('asof').textContent = view.asOf ? `${t('asOfLabel')}: ${shopWhen(view.asOf)}` : '';

  // A not-permitted / nothing-yet state has no signals: show the state line rather than an empty list.
  const state = el('state');
  if (view.signals.length === 0) {
    state.hidden = false;
    const o = office();
    if (o) { const box = o.state(state, stateKindOf(view.screenState.tone), { title: view.screenState.label, detail: '' }); box.querySelector('strong').id = 'state-text'; }
    else { state.textContent = view.screenState.label; }
    state.setAttribute('aria-label', view.screenState.announcement || view.screenState.label);
    el('signals-heading').hidden = true;
    el('kpis-heading').hidden = true;
    el('rows').replaceChildren();
    el('kpis').replaceChildren();
    return;
  }

  state.hidden = true;
  el('signals-heading').hidden = false;
  el('signals-heading').textContent = t('signalsHeading');
  el('rows').replaceChildren(...view.signals.map((s) => signalNode(s)));

  el('kpis-heading').hidden = view.kpis.length === 0;
  el('kpis-heading').textContent = t('kpisHeading');
  paintKpis(view.kpis);
}

el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });

el('sample').hidden = window.stockHealthSession !== undefined;
el('sample').textContent = t('sampleData');
paint();
whenChrome(paint);

// Read the live stock-health figures (a GET — read-only). Offline or refused, the screen keeps its current view
// and the stale strip already says the page is what the box last told it. Nothing is written.
async function refresh() {
  const api = window.stockHealth;
  if (!api || typeof api.refresh !== 'function') return;
  const data = await api.refresh();
  if (data) { session = api.present(data); paint(); }
}
el('refresh').addEventListener('click', () => { void refresh(); });
refresh();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
