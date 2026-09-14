// Employee self-service (ESS) — the view layer. Every rule lives in the TESTED session model
// (apps/web-erp/src/ess-session.ts), attached as window.essSession. This file only draws what the session
// hands it: the employee's rota rows and payslip rows, each with a status that is never a bare colour (an icon
// and a word ride with it). The data is refreshed LIVE from the two self-scoped reads via window.essLive;
// offline the shell keeps what it was last told and says so. No prompt/confirm/alert.

const el = (id) => document.getElementById(id);
let lang = 'en';

/** A stand-in with the same surface as the bundled session, so the shell always opens (and says so). */
function sampleSession() {
  const CHROME = {
    en: { title: 'My self-service', lead: 'Sample view. Connect the store computer to see your own rota and payslip.', langName: 'தமிழ்',
      sampleData: 'Sample data — this is not your record.', staleShell: 'No connection to the store computer. This page is what it was last told, at', nobodyNamed: '' },
    ta: { title: 'எனது சுய-சேவை', lead: 'மாதிரிக் காட்சி. உங்கள் சொந்த அட்டவணை மற்றும் ஊதியச் சீட்டைப் பார்க்க கடை கணினியை இணைக்கவும்.', langName: 'English',
      sampleData: 'மாதிரித் தகவல் — இது உங்கள் பதிவு அல்ல.', staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', nobodyNamed: '' },
  };
  const row = (id, section, headline, tone, icon, label, detail) => ({
    id, section, headline, detail, status: { tone, icon, label, announcement: `${headline}: ${label}`, needsAttention: false },
  });
  const rows = (l) => l === 'ta'
    ? [row('shift-x', 'rota', 'காசாளர்', 'ok', '✓', 'பணியில்', 'ஞாயிறு 06:00–14:00 · b1'), row('pay-net', 'pay', 'கையில் கிடைக்கும் ஊதியம்', 'ok', '✓', '₹17,400.00', 'ஊதியக் காலம் 2026-08')]
    : [row('shift-x', 'rota', 'cashier', 'ok', '✓', 'Rostered', 'Sun 06:00–14:00 · b1'), row('pay-net', 'pay', 'Take-home pay', 'ok', '✓', '₹17,400.00', 'Pay period 2026-08')];
  return {
    text: (l, key) => CHROME[l]?.[key] ?? CHROME.en[key] ?? key,
    view: (l) => ({ screenState: { tone: 'ok', icon: '✓', label: '', announcement: '', needsAttention: false }, rows: rows(l), nobodyNamed: false }),
  };
}

const real = window.essSession;
let session = real ?? sampleSession();
const t = (key) => session.text(lang, key);

function rowNode(r) {
  const li = document.createElement('li');
  li.className = `row tone-${r.status.tone}`;

  const head = document.createElement('div');
  head.className = 'head';
  const cat = document.createElement('span'); cat.className = 'cat'; cat.textContent = r.headline;
  const status = document.createElement('span');
  status.className = 'status';
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = r.status.icon;
  const slabel = document.createElement('span'); slabel.textContent = r.status.label;
  status.append(icon, slabel);
  status.setAttribute('aria-label', r.status.announcement || r.status.label);
  head.append(cat, status);
  li.append(head);

  if (r.detail) { const d = document.createElement('p'); d.className = 'detail'; d.textContent = r.detail; li.append(d); }
  return li;
}

function paint() {
  const view = session.view(lang);

  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('whoami').textContent = window.essData?.userId ?? '';
  el('lang').textContent = t('langName');

  const nobody = el('nobody');
  nobody.hidden = !view.nobodyNamed;
  nobody.textContent = view.nobodyNamed ? t('nobodyNamed') : '';

  el('rows').replaceChildren(...view.rows.map(rowNode));

  const state = el('state');
  if (view.rows.length === 0) {
    state.hidden = false;
    state.className = `state tone-${view.screenState.tone}`;
    el('state-icon').textContent = view.screenState.icon;
    el('state-text').textContent = view.screenState.label;
  } else {
    state.hidden = true;
  }
}

el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); paintStale(); });

el('sample').hidden = real !== undefined;
el('sample').textContent = t('sampleData');
paint();

// Upgrade in place from the two live self-service reads; offline this silently keeps the cached view.
async function refresh() {
  const api = window.essLive;
  if (!api || typeof api.refresh !== 'function') return;
  const data = await api.refresh();
  if (data && (data.roster || data.payslip)) { session = api.present(data); paint(); paintStale(); }
}
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
