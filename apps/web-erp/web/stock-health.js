// Stock health — the view layer (M08, API-04, P-03, P-08). Every rule lives in the TESTED session model
// (apps/web-erp/src/inventory-health-session.ts), attached as window.stockHealthSession, built on packages/ui.
// This file only draws what the session hands it: what needs attention first (negative stock worst-first), the
// honest gaps named (uncosted / not-meaningful, never a guessed zero), then the headline numbers. It is
// READ-ONLY — it changes nothing. Refresh re-reads the numbers live (a GET); offline the screen keeps its view
// and the stale strip says the page is what the box last told it. No prompt/confirm/alert.

const el = (id) => document.getElementById(id);
let lang = 'en';

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
  if (v.kind === 'not_meaningful') return '—';
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
      sampleData: 'Sample data — this is not your shop.', staleShell: 'No connection to the store computer. This page is what it was last told, at',
    },
    ta: {
      title: 'சரக்கு நலன்', langName: 'English',
      lead: 'மாதிரி சரக்கு நலன். உங்கள் கடையின் எண்களைப் பார்க்க கடை கணினியை இணைக்கவும்.',
      signalsHeading: 'கவனம் தேவைப்படுவது', kpisHeading: 'எண்கள்', asOfLabel: 'நிலவரம்', refresh: 'புதுப்பி',
      sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.', staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:',
    },
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

  const status = document.createElement('span');
  status.className = 'status';
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = s.status.icon;
  const slabel = document.createElement('span'); slabel.textContent = s.status.label;
  status.append(icon, slabel);
  status.setAttribute('aria-label', s.status.announcement || s.status.label);

  li.append(head, status);

  // The specifics, in language-neutral facts: the product/location for a negative row, or the value for a
  // money signal. The view reads the kind so it never shows rupees as units.
  const facts = document.createElement('div');
  facts.className = 'facts';
  if (s.kind === 'negative_stock' && s.productId !== null) {
    const where = document.createElement('span'); where.textContent = `${s.productId} @ ${s.locationId}`;
    facts.append(where);
    if (s.amountMinor !== null) { const qty = document.createElement('span'); qty.textContent = `${(s.amountMinor / 100).toLocaleString('en-IN')}`; facts.append(qty); }
    if (s.detail) { const act = document.createElement('span'); act.textContent = s.detail; facts.append(act); }
  } else if ((s.kind === 'uncosted_stock' || s.kind === 'aged_stock') && s.amountMinor !== null) {
    const val = document.createElement('span'); val.textContent = money(s.amountMinor, s.currency ?? 'INR'); facts.append(val);
  }
  if (facts.childElementCount > 0) li.append(facts);
  return li;
}

function kpiNode(k) {
  const li = document.createElement('li');
  li.className = `kpi${k.attention ? ' attention' : ''}`;
  const label = document.createElement('span'); label.className = 'k-label'; label.textContent = k.label;
  const value = document.createElement('span'); value.className = 'k-value'; value.textContent = formatKpi(k);
  li.append(label, value);
  if (k.value.kind === 'not_meaningful') { const note = document.createElement('span'); note.className = 'k-note'; note.textContent = k.value.because; li.append(note); }
  return li;
}

function paint() {
  const view = session.view(lang);

  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('whoami').textContent = window.stockHealthData?.userId ?? '';
  el('lang').textContent = t('langName');
  el('refresh').textContent = t('refresh');

  el('asof').textContent = view.asOf ? `${t('asOfLabel')}: ${new Date(view.asOf).toLocaleString()}` : '';

  // A not-permitted / nothing-yet state has no signals: show the state line rather than an empty list.
  const state = el('state');
  if (view.signals.length === 0) {
    state.hidden = false;
    state.className = `state tone-${view.screenState.tone}`;
    el('state-icon').textContent = view.screenState.icon;
    el('state-text').textContent = view.screenState.label;
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
  el('kpis').replaceChildren(...view.kpis.map((k) => kpiNode(k)));
}

el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); paintStale(); });

el('sample').hidden = window.stockHealthSession !== undefined;
el('sample').textContent = t('sampleData');
paint();

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
