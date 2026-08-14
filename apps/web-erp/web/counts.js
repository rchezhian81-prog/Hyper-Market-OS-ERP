// Stock-count review — the view layer. Every rule lives in the TESTED session model
// (apps/web-erp/src/counts-session.ts), attached as window.countsSession, built on packages/ui + the tested
// packages/counts reconciliation. This file only draws what the session hands it: the day's reconciled blind
// counts, the material variances (which needed a second approval) first, each with a status that is never a
// bare colour (an icon + a word ride with it), the direction and value at variance, and the counted vs system
// quantities. Read-only — nothing here reconciles a count. No prompt/confirm/alert.

const el = (id) => document.getElementById(id);
let lang = 'en';

/** A stand-in with the same surface as the bundled session, so the shell always opens (and says so). */
function sampleSession() {
  const CHROME = {
    en: { title: 'Stock counts', lead: 'Sample counts. Connect the store computer to see your own.', langName: 'தமிழ்',
      attentionCount: 'needed approval', allClear: 'No material variances — nothing needed a second approval.', totalVariance: 'Value at variance today',
      sampleData: 'Sample data — this is not your shop.', staleShell: 'No connection to the store computer. This page is what it was last told, at', nobodyNamed: '' },
    ta: { title: 'சரக்கு எண்ணிக்கை', lead: 'மாதிரி எண்ணிக்கைகள். உங்கள் சொந்தவற்றைப் பார்க்க கடை கணினியை இணைக்கவும்.', langName: 'English',
      attentionCount: 'ஒப்புதல் தேவைப்பட்டது', allClear: 'பெரிய வேறுபாடுகள் இல்லை.', totalVariance: 'இன்று வேறுபட்ட மதிப்பு',
      sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.', staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', nobodyNamed: '' },
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
  en: { filterAll: 'Show all', filterAttention: 'Only the material ones', counted: 'Counted', system: 'System' },
  ta: { filterAll: 'அனைத்தையும் காட்டு', filterAttention: 'பெரியவை மட்டும்', counted: 'எண்ணப்பட்டது', system: 'கணினி' },
};
const vw = (key) => VIEW_WORDS[lang]?.[key] ?? VIEW_WORDS.en[key] ?? key;

function rowNode(r) {
  const li = document.createElement('li');
  li.className = `row tone-${r.status.tone}`;

  const head = document.createElement('div');
  head.className = 'head';
  const prod = document.createElement('span'); prod.className = 'prod'; prod.textContent = r.productId;
  const val = document.createElement('span'); val.className = 'val'; val.textContent = `${r.variance} · ${r.value}`;
  head.append(prod, val);
  li.append(head);

  const status = document.createElement('div');
  status.className = 'status';
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = r.status.icon;
  const slabel = document.createElement('span'); slabel.textContent = r.status.label;
  status.append(icon, slabel);
  status.setAttribute('aria-label', r.status.announcement || r.status.label);
  li.append(status);

  const meta = document.createElement('div');
  meta.className = 'meta';
  const c = document.createElement('span'); c.textContent = `${vw('counted')} ${r.counted}`; meta.append(c);
  const e = document.createElement('span'); e.textContent = `${vw('system')} ${r.expected}`; meta.append(e);
  if (r.counterId) { const b = document.createElement('span'); b.textContent = `${t('counterLabel')}: ${r.counterId}`; meta.append(b); }
  li.append(meta);

  const badges = document.createElement('div');
  badges.className = 'badges';
  if (r.neededApproval) { const b = document.createElement('b'); b.className = 'warn'; b.textContent = t('neededApproval'); badges.append(b); }
  if (r.approvedBy) { const b = document.createElement('b'); b.className = 'muted'; b.textContent = `${t('approvedByLabel')}: ${r.approvedBy}`; badges.append(b); }
  if (badges.childNodes.length > 0) li.append(badges);

  return li;
}

function paint() {
  const view = session.view(lang);

  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('whoami').textContent = window.countsData?.userId ?? '';
  el('lang').textContent = t('langName');
  el('filter').textContent = attentionOnly ? vw('filterAll') : vw('filterAttention');
  el('filter').setAttribute('aria-pressed', attentionOnly ? 'true' : 'false');

  el('attention-count').textContent = view.attentionCount === 0 ? t('allClear') : `${view.attentionCount} ${t('attentionCount')}`;
  el('total').innerHTML = '';
  el('total').append(document.createTextNode(`${t('totalVariance')}: `));
  const b = document.createElement('b'); b.textContent = view.totalValue; el('total').append(b);

  const nobody = el('nobody');
  nobody.hidden = !view.nobodyNamed;
  nobody.textContent = view.nobodyNamed ? t('nobodyNamed') : '';

  const shown = attentionOnly ? view.rows.filter((r) => r.needsAttention) : view.rows;
  el('rows').replaceChildren(...shown.map(rowNode));

  const state = el('state');
  if (shown.length === 0) {
    state.hidden = false;
    state.className = `state tone-${view.screenState.tone}`;
    el('state-icon').textContent = view.screenState.icon;
    el('state-text').textContent = view.screenState.label;
  } else {
    state.hidden = true;
  }
}

el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); paintStale(); });
el('filter').addEventListener('click', () => { attentionOnly = !attentionOnly; paint(); });

el('sample').hidden = real !== undefined;
el('sample').textContent = t('sampleData');
paint();

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
