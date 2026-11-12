// Stock-count review — the view layer. Every rule lives in the TESTED session model
// (apps/web-erp/src/counts-session.ts), attached as window.countsSession, built on packages/ui + the tested
// packages/counts reconciliation. This file only draws what the session hands it: the day's reconciled blind
// counts, the material variances (which needed a second approval) first, each with a status that is never a
// bare colour (an icon + a word ride with it), the direction and value at variance, and the counted vs system
// quantities. Read-only — nothing here reconciles a count. No prompt/confirm/alert.

const el = (id) => document.getElementById(id);
let lang = 'en';
// U5 · G17: the chrome's shared parts (window.sreOffice) may load after this page — each part is drawn once it is there,
// and the page keeps its words meanwhile.
const office = () => window.sreOffice ?? null;
const whenChrome = (fn) => { if (window.sreOffice) fn(); else document.addEventListener('sre:chrome', fn, { once: true }); };
/** The chrome's state kind for a screen state's tone: an error is an error, a doubt is "not known", the rest is "nothing yet". */
const stateKindOf = (tone) => (tone === 'error' ? 'error' : tone === 'degraded' ? 'unknown' : 'empty');

/** A stand-in with the same surface as the bundled session, so the shell always opens (and says so). */
function sampleSession() {
  const CHROME = {
    en: { title: 'Stock counts', lead: 'Sample counts. Connect the store computer to see your own.', langName: 'தமிழ்',
      attentionCount: 'needed approval', allClear: 'No material variances — nothing needed a second approval.', totalVariance: 'Value at variance today',
      // OB-205: the sample once showed the bare key "neededApproval"; it carries the session's own words now.
      neededApproval: 'Needed approval', approvedByLabel: 'Approved by', counterLabel: 'Counted by', valueNotKnown: 'Value not known',
      sampleData: 'Sample data — this is not your shop.', nobodyNamed: '' },
    ta: { title: 'சரக்கு எண்ணிக்கை', lead: 'மாதிரி எண்ணிக்கைகள். உங்கள் சொந்தவற்றைப் பார்க்க கடை கணினியை இணைக்கவும்.', langName: 'English',
      attentionCount: 'ஒப்புதல் தேவைப்பட்டது', allClear: 'பெரிய வேறுபாடுகள் இல்லை.', totalVariance: 'இன்று வேறுபட்ட மதிப்பு',
      neededApproval: 'ஒப்புதல் தேவைப்பட்டது', approvedByLabel: 'ஒப்புதல் அளித்தவர்', counterLabel: 'எண்ணியவர்', valueNotKnown: 'மதிப்பு தெரியவில்லை',
      sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.', nobodyNamed: '' },
  };
  const row = (productId, tone, icon, statusLabel, variance, value, counted, expected, needsAttention) => ({
    id: productId, productId, status: { tone, icon, label: statusLabel, announcement: `${productId}: ${statusLabel}`, needsAttention },
    needsAttention, variance, value, counted, expected, neededApproval: needsAttention,
  });
  const rows = (l) => l === 'ta'
    ? [row('அரிசி 5kg', 'error', '▼', 'குறைவு', '-4 ea', '₹2,400.00', '16 ea', '20 ea', true),
       row('பால்', 'degraded', '▲', 'அதிகம்', '+2 ea', '₹120.00', '14 ea', '12 ea', false)]
    : [row('Rice 5kg', 'error', '▼', 'Short', '-4 ea', '₹2,400.00', '16 ea', '20 ea', true),
       row('Milk', 'degraded', '▲', 'Over', '+2 ea', '₹120.00', '14 ea', '12 ea', false)];
  return {
    text: (l, key) => CHROME[l]?.[key] ?? CHROME.en[key] ?? key,
    view: (l) => {
      const r = rows(l);
      return { screenState: { tone: 'ok', icon: '✓', label: '', announcement: '', needsAttention: false },
        rows: r, attentionCount: r.filter((x) => x.needsAttention).length, total: r.length, totalValue: '₹2,520.00', nobodyNamed: false };
    },
  };
}

const real = window.countsSession;
const session = real ?? sampleSession();
const t = (key) => session.text(lang, key);
let attentionOnly = false;
const VIEW_WORDS = {
  en: { filterAll: 'Show all', filterAttention: 'Only the material ones', counted: 'Counted', system: 'System',
    colProd: 'Product', colStatus: 'Where it stands', colVariance: 'Difference', colValue: 'Value' },
  ta: { filterAll: 'அனைத்தையும் காட்டு', filterAttention: 'பெரியவை மட்டும்', counted: 'எண்ணப்பட்டது', system: 'கணினி',
    colProd: 'பொருள்', colStatus: 'நிலை', colVariance: 'வேறுபாடு', colValue: 'மதிப்பு' },
};
const vw = (key) => VIEW_WORDS[lang]?.[key] ?? VIEW_WORDS.en[key] ?? key;

/** OB-205: a shape from the one icon set (sre-icons.js), or null when the set is not loaded. */
const lineIcon = (name, size) => (window.sreIcon && typeof window.sreIcon === 'function' ? window.sreIcon(name, size) : null);
const both = (k) => ({ en: session.text('en', k), ta: session.text('ta', k) });
const bothV = (k) => ({ en: VIEW_WORDS.en[k], ta: VIEW_WORDS.ta[k] });
let register = null;
/** The counts on the chrome's register: product, where it stands (the one chip), counted, system, the difference, the value. */
function ensureRegister() {
  const o = office(); if (!o || register !== null) return register;
  register = o.table(el('register'), {
    id: 'counts', label: bothV('colProd'), pageSize: 10, sortable: true, rows: null,
    rowKey: (r) => r.id ?? r.productId, rowData: (r) => ({ product: r.productId, tone: r.status.tone, attention: String(r.needsAttention) }),
    columns: [
      { key: 'productId', label: bothV('colProd'), value: (r) => (o.nameOf('product', r.productId) || r.productId) },
      { key: 'status', label: bothV('colStatus'), filter: true, value: (r) => r.status.label, render: (r) => { const chip = o.chip(r.status.tone, r.status.label); chip.setAttribute('aria-label', r.status.announcement || r.status.label); chip.classList.add('status'); return chip; } },
      { key: 'counted', label: bothV('counted'), align: 'end', sort: false },
      { key: 'expected', label: bothV('system'), align: 'end', sort: false },
      { key: 'variance', label: bothV('colVariance'), align: 'end', sort: false },
      { key: 'value', label: bothV('colValue'), align: 'end', sort: false, value: (r) => (r.value === t('valueNotKnown') ? null : r.value) },
      { key: 'approval', label: both('neededApproval'), filter: true, value: (r) => (r.neededApproval ? t('neededApproval') : ''), render: (r) => (r.neededApproval ? o.chip('degraded', t('neededApproval')) : document.createTextNode('')) },
      { key: 'people', label: both('counterLabel'), sort: false, value: (r) => [r.counterId ? `${t('counterLabel')}: ${o.nameOf('person', r.counterId) || r.counterId}` : '', r.approvedBy ? `${t('approvedByLabel')}: ${o.nameOf('person', r.approvedBy) || r.approvedBy}` : ''].filter((x) => x !== '').join(' · ') },
    ],
  });
  return register;
}

function paint() {
  const view = session.view(lang);

  el('title').textContent = t('title');
  // OB-205: the page's one heading (the header line) speaks the reader's language too.
  el('who').firstChild.textContent = `${t('title')} `;
  el('lead').textContent = t('lead');
  el('whoami').textContent = window.countsData?.userId ?? '';
  el('lang').textContent = t('langName');
  const filterWords = document.createElement('span');
  filterWords.textContent = attentionOnly ? vw('filterAll') : vw('filterAttention');
  const filterMark = lineIcon(attentionOnly ? 'list' : 'triangle-alert', 18);
  el('filter').replaceChildren(...(filterMark ? [filterMark] : []), filterWords);
  el('filter').setAttribute('aria-pressed', attentionOnly ? 'true' : 'false');
  // The figures as summary cards: how many needed a second approval (and that none did, when none did), the value at variance.
  const o = office();
  if (o) {
    o.cards(el('stats'), [
      { label: both('attentionCount'), value: view.attentionCount, tone: view.attentionCount === 0 ? 'ok' : 'error', note: view.attentionCount === 0 ? both('allClear') : undefined },
      { label: both('totalVariance'), value: view.totalValue },
    ]);
  }

  const nobody = el('nobody');
  nobody.hidden = !view.nobodyNamed;
  nobody.textContent = view.nobodyNamed ? t('nobodyNamed') : '';

  const shown = attentionOnly ? view.rows.filter((r) => r.needsAttention) : view.rows;
  const state = el('state');
  el('register').hidden = shown.length === 0;
  if (shown.length === 0) {
    state.hidden = false;
    if (o) { const box = o.state(state, stateKindOf(view.screenState.tone), { title: view.screenState.label, detail: '' }); box.querySelector('strong').id = 'state-text'; }
    else state.textContent = view.screenState.label;
  } else {
    state.hidden = true;
    if (ensureRegister() !== null) { register.setRows(shown); register.repaint(); }
  }
}

el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
el('filter').addEventListener('click', () => { attentionOnly = !attentionOnly; paint(); });

el('sample').hidden = real !== undefined;
el('sample').textContent = t('sampleData');
paint();
whenChrome(paint);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
