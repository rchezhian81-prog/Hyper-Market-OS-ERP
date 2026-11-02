// The concessionaire's own counter — the view layer (M27-FR-02 · M27-FR-03 · OB-676 "A" · API-09 · §35 · P-04 · P-08). Every
// rule lives in the TESTED session model (apps/concession-app/src/concession-portal-session.ts), attached as
// window.concessionPortalSession by the bundle. This file only DRAWS what the session hands it: the counters (each with
// whether it may trade today, in an icon AND words), the sales at them, the stock it owns on the shop's shelves and the
// invoices issued to it. A feed that could not be read is said so — never an empty list or a zero. It is READ-ONLY: it
// issues no write verb. Refresh re-reads the four feeds (GETs). No prompt/confirm/alert.

// OB-607: a moment is shown at the SHOP's clock — never this device's.
const shopWhen = (value) => window.sreShopDay?.dateTimeOf(value) ?? '';
const el = (id) => document.getElementById(id);
let lang = 'en';

/** A stand-in with the same surface as the bundled session, so the shell always opens (and says so). */
function sampleSession() {
  const WORDS = {
    en: { title: 'Your counter at SRE', langName: 'தமிழ்', refresh: 'Refresh', asOfLabel: 'As of', lead: 'Sample counter. Sign in with your own login to see your counter.',
      countersHeading: 'Your counters', salesHeading: 'Sales at your counters', stockHeading: 'Your stock on the shop’s shelves', invoicesHeading: 'Invoices issued to you',
      sampleData: 'Sample data — this is not your counter.', staleShell: 'No connection. This page is what you were last shown, at' },
    ta: { title: 'SRE-இல் உங்கள் கவுண்டர்', langName: 'English', refresh: 'புதுப்பி', asOfLabel: 'நிலவரம்', lead: 'மாதிரிக் கவுண்டர். உங்கள் கவுண்டரைப் பார்க்க உங்கள் சொந்த உள்நுழைவுடன் நுழையவும்.',
      countersHeading: 'உங்கள் கவுண்டர்கள்', salesHeading: 'உங்கள் கவுண்டர்களின் விற்பனை', stockHeading: 'கடை அலமாரிகளில் உங்கள் சரக்கு', invoicesHeading: 'உங்களுக்கு வழங்கிய விலைப்பட்டியல்கள்',
      sampleData: 'மாதிரித் தகவல் — இது உங்கள் கவுண்டர் அல்ல.', staleShell: 'இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகக் காட்டப்பட்டது:' },
  };
  return {
    text: (l, key) => WORDS[l]?.[key] ?? WORDS.en[key] ?? key,
    view: () => ({ screen: 'shown', screenStatus: { tone: 'ok', icon: '✓', label: '', announcement: '' }, counters: [], deposit: null, sales: [], salesTotal: null, stock: [], stockTotal: null, invoices: [], notes: {} }),
  };
}

let session = window.concessionPortalSession ?? sampleSession();
const t = (key) => session.text(lang, key);

function statusNode(status) {
  const node = document.createElement('span');
  node.className = 'status';
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = status.icon;
  const label = document.createElement('span'); label.textContent = status.label;
  node.append(icon, label);
  node.setAttribute('aria-label', status.announcement || status.label);
  return node;
}

function rowNode(tone, headline, value, facts, status, data) {
  const li = document.createElement('li');
  li.className = `row tone-${tone}`;
  Object.assign(li.dataset, data);
  const head = document.createElement('div'); head.className = 'head';
  const h = document.createElement('span'); h.className = 'headline'; h.textContent = headline;
  head.append(h);
  if (value !== null) { const v = document.createElement('span'); v.className = 'value'; v.textContent = value; head.append(v); }
  li.append(head);
  if (status !== null) li.append(statusNode(status));
  const f = document.createElement('div'); f.className = 'facts';
  for (const words of facts) { const s = document.createElement('span'); s.textContent = words; f.append(s); }
  li.append(f);
  return li;
}

function paintNote(feed, notes) {
  const p = el(`${feed}-note`);
  const note = notes[feed];
  p.hidden = note === undefined;
  if (note === undefined) return;
  p.className = note.tone === 'warn' ? 'note' : 'muted';
  p.textContent = note.words;
}

function paintTotal(id, label, value) {
  const p = el(id);
  p.hidden = value === null;
  p.textContent = value === null ? '' : `${t(label)}: ${value}`;
}

function paint() {
  const view = session.view(lang);
  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('whoami').textContent = window.concessionData?.userId ?? '';
  el('lang').textContent = t('langName');
  el('refresh').textContent = t('refresh');
  for (const f of ['counters', 'sales', 'stock', 'invoices']) el(`${f}-heading`).textContent = t(`${f}Heading`);

  const sections = ['counters-section', 'sales-section', 'stock-section', 'invoices-section'];
  const state = el('state');
  if (view.screen !== 'shown') {
    state.hidden = false;
    state.className = `state tone-${view.screenStatus.tone}`;
    el('state-icon').textContent = view.screenStatus.icon;
    el('state-text').textContent = view.screenStatus.label;
    for (const id of sections) el(id).hidden = true;
    return;
  }
  state.hidden = true;
  for (const id of sections) el(id).hidden = false;

  el('counters').replaceChildren(...view.counters.map((c) => rowNode(c.status.tone, c.headline, null, c.facts, c.status, { contract: c.contractId })));
  paintTotal('deposit', 'depositLabel', view.deposit);
  paintNote('counters', view.notes);

  el('sales').replaceChildren(...view.sales.map((s) => rowNode('idle', s.headline, s.amount, s.facts.map((x, i) => (i === 2 ? shopWhen(x) || x : x)), null, { sale: s.saleId })));
  paintTotal('sales-total', 'salesTotal', view.salesTotal);
  paintNote('sales', view.notes);

  el('stock').replaceChildren(...view.stock.map((l) => rowNode('idle', l.headline, l.value, l.facts, null, { line: l.key })));
  paintTotal('stock-total', 'stockTotal', view.stockTotal);
  paintNote('stock', view.notes);

  el('invoices').replaceChildren(...view.invoices.map((i) => rowNode('idle', i.headline, i.amount, i.facts, null, { invoice: i.invoiceId })));
  paintNote('invoices', view.notes);
}

el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); paintStale(); });

el('sample').hidden = window.concessionPortalSession !== undefined;
el('sample').textContent = t('sampleData');
paint();

// Read the live feeds (GETs — read-only). Offline, the screen keeps its current view; the stale strip says so.
async function refresh() {
  const api = window.concessionPortal;
  if (!api || typeof api.refresh !== 'function') return;
  const data = await api.refresh();
  if (data) {
    session = api.present(data);
    el('asof').textContent = `${t('asOfLabel')} ${shopWhen(data.asAt)}`;
    paint();
  }
}
el('refresh').addEventListener('click', () => { void refresh(); });
refresh();

function paintStale() {
  const at = window.shellCachedAt;
  const strip = el('stale');
  strip.hidden = at === undefined;
  if (at === undefined) return;
  strip.textContent = `${t('staleShell')} ${shopWhen(at)}`;
}
paintStale();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the portal still opens; it just will not be there without a network */
  });
}
