// Day book — the view layer (M23-FR-01, API-09). Every rule lives in the TESTED session model
// (apps/web-erp/src/day-book-session.ts), attached as window.dayBookSession, built on packages/ui over the tested
// buildDayBook / postDayBook engine. This file only draws what the session hands it: the trading day's posted
// journals (kind, amount, receipts covered, period, posted-late marked), the accounts they move, and the
// exceptions (open = error, resolved = ok), then the one act — POST the day — which runs ONLY on an explicit
// click, never on load; on success the day is re-read (a GET). No prompt/confirm/alert.

const el = (id) => document.getElementById(id);
let lang = 'en';

/** Yesterday in the store's local calendar — the day an accountant usually posts in the morning. */
function defaultDay() {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A stand-in with the same surface as the bundled session, so the shell always opens (and says so). */
function sampleSession() {
  const CHROME = {
    en: { title: 'Day book', langName: 'தமிழ்',
      lead: 'Sample day book. Connect the store computer to post your own days.',
      dayLabel: 'Trading day', loadBtn: 'Show the day', postBtn: 'Post this day to the accounts',
      notPosted: 'Nothing posted for this day yet.', postedSummary: 'journals posted', salesTotalLabel: 'Sales posted', returnsTotalLabel: 'Returns posted', coveredLabel: 'Receipts covered', openLabel: 'open exceptions',
      journalsHeading: 'Journals', accountsHeading: 'Accounts moved', exceptionsHeading: 'Exceptions', noExceptions: 'No exceptions on this day.',
      sourcesLabel: 'Receipts', periodLabel: 'Period', postedByLabel: 'Posted by', debitLabel: 'Debit', creditLabel: 'Credit', balanceLabel: 'Balance',
      sampleData: 'Sample data — this is not your shop.', nobodyNamed: '' },
    ta: { title: 'நாள் புத்தகம்', langName: 'English',
      lead: 'மாதிரி நாள் புத்தகம். உங்கள் நாட்களைப் பதிவு செய்ய கடை கணினியை இணைக்கவும்.',
      dayLabel: 'வர்த்தக நாள்', loadBtn: 'நாளைக் காட்டு', postBtn: 'இந்த நாளைக் கணக்குகளில் பதிவு செய்',
      notPosted: 'இந்த நாளுக்கு இன்னும் எதுவும் பதிவு செய்யப்படவில்லை.', postedSummary: 'ஜர்னல்கள் பதிவு செய்யப்பட்டன', salesTotalLabel: 'பதிவான விற்பனை', returnsTotalLabel: 'பதிவான திருப்பங்கள்', coveredLabel: 'உள்ளடக்கிய ரசீதுகள்', openLabel: 'திறந்த விதிவிலக்குகள்',
      journalsHeading: 'ஜர்னல்கள்', accountsHeading: 'நகர்ந்த கணக்குகள்', exceptionsHeading: 'விதிவிலக்குகள்', noExceptions: 'இந்த நாளில் விதிவிலக்குகள் இல்லை.',
      sourcesLabel: 'ரசீதுகள்', periodLabel: 'காலம்', postedByLabel: 'பதிவு செய்தவர்', debitLabel: 'பற்று', creditLabel: 'வரவு', balanceLabel: 'இருப்பு',
      sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.', nobodyNamed: '' },
  };
  const journal = (l) => ({
    entryId: 'daybook:sample:sale:1', kind: 'sale', kindLabel: l === 'ta' ? 'விற்பனை' : 'Sales', amount: '₹1,23,456.00', amountMinor: 12345600, sources: 412,
    period: '2026-09', documentDate: '2026-09-28', late: false, belongsTo: null, postedBy: 'accountant', narrative: 'Day book 2026-09-28 — sale',
    lines: [{ accountCode: '1210', debit: '₹1,23,456.00', credit: '₹0.00' }, { accountCode: '4000', debit: '₹0.00', credit: '₹1,17,577.14' }, { accountCode: '2310', debit: '₹0.00', credit: '₹5,878.86' }],
    status: { tone: 'ok', icon: '✓', label: l === 'ta' ? 'பதிவு செய்யப்பட்டது' : 'Posted', announcement: 'posted', needsAttention: false },
  });
  return {
    text: (l, key) => CHROME[l]?.[key] ?? CHROME.en[key] ?? key,
    view: (l) => ({
      screenState: { tone: 'ok', icon: '✓', label: '', announcement: '', needsAttention: false },
      tradingDay: '2026-09-28', posted: true, journals: [journal(l)],
      accounts: [{ accountCode: '1210', debit: '₹1,23,456.00', credit: '₹0.00', balance: '₹1,23,456.00', balanceMinor: 12345600 }],
      exceptions: [], openCount: 0, resolvedCount: 0, covered: 412, salesTotal: '₹1,23,456.00', returnsTotal: null, nobodyNamed: false, mayPost: true,
    }),
    post: async () => ({ result: 'lost_link' }),
    presentPostResult: (l, r) => ({ tone: r.result === 'posted' ? 'ok' : r.result === 'lost_link' ? 'degraded' : 'error', icon: r.result === 'posted' ? '✓' : r.result === 'lost_link' ? '⚠' : '✕', label: '', announcement: '', needsAttention: r.result !== 'posted' }),
  };
}

let session = window.dayBookSession ?? sampleSession();
const t = (key) => session.text(lang, key);

function statusNode(status) {
  const s = document.createElement('span');
  s.className = 'status';
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = status.icon;
  const label = document.createElement('span'); label.textContent = status.label;
  s.append(icon, label);
  s.setAttribute('aria-label', status.announcement || status.label);
  return s;
}

function journalNode(j) {
  const li = document.createElement('li');
  li.className = `row tone-${j.status.tone}`;
  const head = document.createElement('div'); head.className = 'head';
  const headline = document.createElement('span'); headline.className = 'headline'; headline.textContent = j.kindLabel;
  const value = document.createElement('span'); value.className = 'value'; value.textContent = j.amount;
  head.append(headline, value);
  const facts = document.createElement('div'); facts.className = 'facts';
  const src = document.createElement('span'); src.textContent = `${t('sourcesLabel')}: ${j.sources}`;
  const period = document.createElement('span'); period.textContent = `${t('periodLabel')}: ${j.period}${j.late ? ` (${j.belongsTo})` : ''}`;
  const by = document.createElement('span'); by.textContent = `${t('postedByLabel')}: ${j.postedBy}`;
  facts.append(src, period, by);
  const lines = document.createElement('div'); lines.className = 'lines';
  for (const l of j.lines) {
    const row = document.createElement('span');
    const acc = document.createElement('b'); acc.textContent = l.accountCode;
    const amt = document.createElement('i'); amt.textContent = `${t('debitLabel')} ${l.debit} · ${t('creditLabel')} ${l.credit}`;
    row.append(acc, amt); lines.append(row);
  }
  li.append(head, statusNode(j.status), facts, lines);
  return li;
}

function exceptionNode(e) {
  const li = document.createElement('li');
  li.className = `row tone-${e.status.tone}`;
  const head = document.createElement('div'); head.className = 'head';
  const headline = document.createElement('span'); headline.className = 'headline'; headline.textContent = e.reasonLabel;
  const value = document.createElement('span'); value.className = 'value'; value.textContent = e.kind ?? e.sourceKind;
  head.append(headline, value);
  const facts = document.createElement('div'); facts.className = 'facts';
  const detail = document.createElement('span'); detail.textContent = e.detail;
  const src = document.createElement('span'); src.textContent = `${t('sourcesLabel')}: ${e.sourceCount}`;
  facts.append(detail, src);
  li.append(head, statusNode(e.status), facts);
  return li;
}

function paint() {
  const view = session.view(lang);

  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('whoami').textContent = window.dayBookData?.userId ?? '';
  el('lang').textContent = t('langName');
  el('day-label').textContent = t('dayLabel');
  el('load').textContent = t('loadBtn');
  el('post').textContent = t('postBtn');

  const nobody = el('nobody');
  nobody.hidden = !view.nobodyNamed;
  nobody.textContent = view.nobodyNamed ? t('nobodyNamed') : '';

  // The post action — only for a user who holds finance.journal.post; the server re-checks and needs a posting map.
  el('post').hidden = !(view.mayPost && !view.nobodyNamed && view.screenState.tone !== 'error');

  const permitted = view.screenState.tone !== 'error';
  el('posted-state').textContent = !permitted ? '' : view.posted ? `${view.journals.length} ${t('postedSummary')}` : t('notPosted');
  el('sales-total').textContent = view.salesTotal === null ? '' : `${t('salesTotalLabel')}: ${view.salesTotal}`;
  el('returns-total').textContent = view.returnsTotal === null ? '' : `${t('returnsTotalLabel')}: ${view.returnsTotal}`;
  el('covered').textContent = view.posted ? `${t('coveredLabel')}: ${view.covered}` : '';
  el('open-count').textContent = view.openCount === 0 ? '' : `${view.openCount} ${t('openLabel')}`;

  el('journals-heading').hidden = view.journals.length === 0;
  el('journals-heading').textContent = t('journalsHeading');
  el('journals').replaceChildren(...view.journals.map((j) => journalNode(j)));

  el('accounts-heading').hidden = view.accounts.length === 0;
  el('accounts-heading').textContent = t('accountsHeading');
  el('accounts').hidden = view.accounts.length === 0;
  el('th-account').textContent = t('accountsHeading');
  el('th-debit').textContent = t('debitLabel');
  el('th-credit').textContent = t('creditLabel');
  el('th-balance').textContent = t('balanceLabel');
  el('accounts-body').replaceChildren(...view.accounts.map((a) => {
    const tr = document.createElement('tr');
    for (const v of [a.accountCode, a.debit, a.credit, a.balance]) { const td = document.createElement('td'); td.textContent = v; tr.append(td); }
    return tr;
  }));

  el('exceptions-heading').hidden = !permitted || (view.exceptions.length === 0 && !view.posted);
  el('exceptions-heading').textContent = t('exceptionsHeading');
  el('exceptions').replaceChildren(...view.exceptions.map((e) => exceptionNode(e)));
  el('no-exceptions').hidden = !(permitted && view.posted && view.exceptions.length === 0);
  el('no-exceptions').textContent = t('noExceptions');

  const state = el('state');
  if (!permitted || (view.journals.length === 0 && view.exceptions.length === 0)) {
    state.hidden = false;
    state.className = `state tone-${view.screenState.tone}`;
    el('state-icon').textContent = view.screenState.icon;
    el('state-text').textContent = view.screenState.label;
  } else {
    state.hidden = true;
  }
}

function paintResult(presentation) {
  const result = el('result');
  if (!result) return;
  result.hidden = false;
  result.className = `result tone-${presentation.tone}`;
  el('result-icon').textContent = presentation.icon;
  el('result-text').textContent = presentation.label;
  result.setAttribute('aria-label', presentation.announcement || presentation.label);
}

// The accountant's posting — a HUMAN write that runs ONLY on this explicit click, never on load. On success the
// day is re-read (a GET) so the journals shown are the cloud's. The server needs a posting map and is idempotent
// on the day; the screen never fakes a posting.
el('post').addEventListener('click', () => {
  void (async () => {
    const result = await session.post(el('day').value);
    paintResult(session.presentPostResult(lang, result));
    if (result.result === 'posted' || result.result === 'nothing_new') await refresh();
  })();
});
el('load').addEventListener('click', () => { el('result').hidden = true; void refresh(); });
el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });

el('day').value = defaultDay();
el('sample').hidden = window.dayBookSession !== undefined;
el('sample').textContent = t('sampleData');
paint();

// Read the day (a GET — read-only). Offline or refused, the screen keeps its current view and the stale strip
// already says the page is what the box last told it.
async function refresh() {
  const api = window.dayBook;
  if (!api || typeof api.refresh !== 'function') return;
  const data = await api.refresh(el('day').value);
  if (data) { session = api.present(data); paint(); }
}
refresh();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
