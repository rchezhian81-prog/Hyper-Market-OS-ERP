// Customer satisfaction (U6 · M21-FR-04) — the page over head office's service report and a customer's rating of a case that
// has been dealt with. The session (apps/web-erp/src/satisfaction-session.ts, in the bundle as window.satisfaction) does every
// call and every rule; this page lays out what it is told on the shared office parts (window.sreOffice: cards, table, state,
// chips, fields). The rating is recorded in the case's OWN customer's name — never typed. Every word this page adds has a
// Tamil twin; head office's own sentences stay in English (OB-553, OB-699).

const $ = (id) => document.getElementById(id);
const api = window.satisfaction ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, manage: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
const both = (k) => ({ en: api.words('en', k), ta: api.words('ta', k) });
const office = () => window.sreOffice ?? null;
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
const shopTime = (at) => (!at ? '' : window.sreShopDay?.dateTimeOf(at) ?? at);
const customerName = (ref) => { const o = office(); const n = o && typeof o.nameOf === 'function' ? o.nameOf('customer', ref) : ref; return n && n !== ref ? `${n} (${ref})` : ref; };
const caseWanted = new URL(location.href).searchParams.get('case') ?? '';
/** U1 (design system §1.3): a greyed button says why — the shared `.sre-why` note beside it, in the reader's language. */
function whyDisabled(btn, why) {
  const words = why === '' || why === undefined || why === null ? '' : typeof why === 'string' ? why : (why[lang] ?? why.en);
  let note = btn.nextElementSibling;
  if (!(note && note.classList.contains('sre-why'))) { note = document.createElement('small'); note.className = 'sre-why'; note.id = `${btn.id}-why`; btn.after(note); }
  note.textContent = words; note.hidden = words === '';
  if (words === '') { btn.removeAttribute('title'); btn.removeAttribute('aria-describedby'); } else { btn.title = words; btn.setAttribute('aria-describedby', note.id); }
}

let report = null; let reportOutcome = null;
let cases = null; let casesOutcome = null;
let picked = null; let score = '';
let fields = null;

document.addEventListener('sre:chrome', () => { buildForm(); paint(); });

function stateOr(host, outcome) { const o = office(); if (o !== null) o.state(host, o.stateOf(outcome), { title: api.outcomeWords(lang, outcome) }); }

/** The report as cards: CSAT with its response rate beside it, never a score on its own (six replies are six people). */
function paintReport() {
  const o = office();
  $('report-cards').replaceChildren(); $('report-detail').textContent = '';
  if (reportOutcome !== null) { $('report-status').textContent = api.outcomeWords(lang, reportOutcome); stateOr($('report-cards'), reportOutcome); return; }
  if (report === null) { $('report-status').textContent = t('reading'); if (o !== null) o.state($('report-cards'), 'loading'); return; }
  $('report-status').textContent = ''; $('report-detail').textContent = report.detail;
  if (o === null) return;
  const csat = report.csat === 'no_responses' ? null : (report.csat / 100).toFixed(2);
  const rate = report.responseRateBps === 'not_meaningful' ? null : `${(report.responseRateBps / 100).toFixed(1)}%`;
  o.cards($('report-cards'), [
    { label: t('csat'), value: csat, note: csat === null ? t('noResponses') : undefined, tone: csat === null ? 'pending' : undefined, icon: 'circle-check' },
    { label: t('responseRate'), value: rate, note: rate === null ? t('notMeaningful') : undefined, icon: 'percent' },
    { label: t('casesCount'), value: report.cases, icon: 'list' },
    { label: t('resolved'), value: report.resolved, icon: 'badge-check' },
  ]);
}

const stateChip = (o, c) => o.recordChip(c.state === 'resolved' ? 'completed' : c.state === 'waiting_on_customer' ? 'waiting' : c.state, c.state === 'resolved' ? { en: 'resolved', ta: 'தீர்க்கப்பட்டது' } : undefined);

/** The cases a customer can rate first; "Choose" opens the rating panel for that case. */
function paintCases() {
  const o = office();
  $('cases-table').replaceChildren();
  if (casesOutcome !== null) { $('cases-status').textContent = api.outcomeWords(lang, casesOutcome); stateOr($('cases-table'), casesOutcome); return; }
  if (cases === null) { $('cases-status').textContent = t('reading'); if (o !== null) o.state($('cases-table'), 'loading'); return; }
  $('cases-status').textContent = '';
  if (o === null) return;
  if (cases.length === 0) { o.state($('cases-table'), 'empty', { title: t('noCases'), detail: t('noCasesDetail') }); return; }
  o.table($('cases-table'), {
    id: 'cases', label: both('casesH'), rows: cases, pageSize: 10, sortable: true,
    rowKey: (c) => c.caseId, rowData: (c) => ({ case: c.caseId, state: c.state, ratable: String(c.ratable) }),
    columns: [
      { key: 'caseId', label: both('caseCol'), sort: 'text' },
      { key: 'customerRef', label: both('customer'), sort: 'text', value: (c) => customerName(c.customerRef) },
      { key: 'kind', label: both('kindCol'), sort: 'text', value: (c) => t(`kind_${c.kind}`) },
      { key: 'state', label: both('state'), sort: 'text', value: (c) => c.state, render: (c) => stateChip(o, c) },
      { key: 'summary', label: both('summary') },
      { key: 'resolvedAt', label: both('resolvedCol'), sort: 'text', value: (c) => (c.resolvedAt ? shopTime(c.resolvedAt) : null) },
      { key: 'ratable', label: both('ratable'), sort: 'text', value: (c) => (c.ratable ? t('yes') : t('notRatable')), render: (c) => o.chip(c.ratable ? 'ok' : 'pending', c.ratable ? t('yes') : t('notRatable')) },
      { key: 'choose', label: both('choose'), sort: false, render: (c) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'sre-btn sre-btn-quiet'; b.dataset.choose = c.caseId; b.textContent = t('choose'); b.addEventListener('click', () => { choose(c); }); return b; } },
    ],
    empty: { title: t('noCases'), detail: t('noCasesDetail') },
  });
}

/** Five 44px score buttons (one tap), the comment as a shared field; the customer is the case's own, shown and never typed. */
function buildForm() {
  const o = office();
  if (o === null || fields !== null || typeof o.field !== 'function') return;
  fields = { comment: o.field({ id: 'r-comment', label: both('comment'), type: 'text' }) };
  $('rate-fields').replaceChildren(fields.comment);
  const host = $('scores'); host.replaceChildren();
  for (const n of ['1', '2', '3', '4', '5']) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'sre-btn'; b.id = `s-${n}`; b.dataset.score = n; b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => { score = n; for (const x of host.querySelectorAll('button')) x.setAttribute('aria-pressed', String(x.dataset.score === n)); paintRecord(); });
    host.append(b);
  }
  paintScores();
}
function paintScores() { for (const b of $('scores').querySelectorAll('button')) b.textContent = `${b.dataset.score} · ${t(`s${b.dataset.score}`)}`; }
function paintRecord() {
  const btn = $('r-record');
  const why = picked === null ? both('needCase') : !picked.ratable ? both('notRatable') : picked.customerRef === '' ? both('needCustomer') : score === '' ? both('needScore') : '';
  btn.disabled = why !== ''; whyDisabled(btn, why);
}

function paint() {
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  document.title = `SRE ${t('title')}`;
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['report-h', 'reportH'], ['cases-h', 'casesH'], ['cases-lead', 'casesLead'], ['rate-h', 'rateH'], ['score-l', 'score'], ['r-record-text', 'record'], ['r-back-text', 'back'], ['english-note', 'headOfficeEnglish']]) { const n = $(id); if (n) n.textContent = t(key); }
  $('score-l').textContent = `${t('score')} — ${t('scoreHint')}`;
  if (fields !== null) { const lab = $('r-comment')?.closest('.sre-field')?.querySelector('.sre-field-label'); if (lab) lab.textContent = t('comment'); paintScores(); paintRecord(); }
  if (picked !== null) {
    $('rate-facts').replaceChildren(...[`${t('forCase')}: ${picked.caseId} · ${t(`kind_${picked.kind}`)} · ${picked.summary}`, `${t('forCustomer')}: ${customerName(picked.customerRef)}`]
      .map((line) => { const s = document.createElement('span'); s.textContent = line; return s; }));
  }
  paintReport(); paintCases();
}

async function loadReport() { const out = await session.report(); if (out.result === 'ok') { report = out.value; reportOutcome = null; } else { report = null; reportOutcome = out; } paintReport(); }
async function loadCases() {
  const out = await session.cases();
  if (out.result === 'ok') { cases = out.value; casesOutcome = null; } else { cases = null; casesOutcome = out; }
  paintCases();
  if (picked === null && caseWanted !== '' && cases !== null) { const c = cases.find((x) => x.caseId === caseWanted); if (c !== undefined) choose(c); }
}
function choose(c) {
  picked = c; score = ''; $('r-status').textContent = ''; $('r-status').dataset.outcome = '';
  for (const x of $('scores').querySelectorAll('button')) x.setAttribute('aria-pressed', 'false');
  $('rate').hidden = false; paint(); $('rate').scrollIntoView({ block: 'start' });
}
function unchoose() { picked = null; $('rate').hidden = true; paint(); $('cases').scrollIntoView({ block: 'start' }); }

async function submit(event) {
  event.preventDefault();
  if (picked === null) { $('r-status').textContent = t('needCase'); return; }
  $('r-status').textContent = t('reading');
  const out = await session.record({ caseId: picked.caseId, customerRef: picked.customerRef, score, comment: $('r-comment')?.value ?? '' });
  if (out.result !== 'ok') { $('r-status').textContent = api.outcomeWords(lang, out); $('r-status').dataset.outcome = 'refused'; return; }
  $('r-status').textContent = t('recorded'); $('r-status').dataset.outcome = 'recorded';
  void loadReport();
}

for (const [id, name] of [['r-record', 'badge-check'], ['r-back', 'rotate-ccw']]) { const i = icon(name); if (i !== null) $(id).prepend(i); }
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
$('rate-form').addEventListener('submit', (e) => { void submit(e); });
$('r-back').addEventListener('click', unchoose);
paint();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.read) $('page-status').textContent = t('cannotRead');
else {
  $('report').hidden = false; $('cases').hidden = false;
  if (!may.manage) $('page-status').textContent = t('cannotManage');
  void loadReport(); void loadCases();
}
