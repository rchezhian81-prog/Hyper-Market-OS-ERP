// Payables and receivables (U6 · M23-FR-01 · QG-07 · P-08) — the page over head office's payables and receivables routes.
// The session (apps/web-erp/src/payables-receivables-session.ts, in the bundle as window.payablesReceivables) does every
// call and every rule; this page lays out what it is told, on the shared office parts (window.sreOffice: cards, table,
// state, chip, confirm). It reads head office as it opens (GETs only); the one write — posting the payables — goes behind
// the shared confirm sheet (OB-698). Every word this page adds has a Tamil twin (OB-699); head office's own stay English.

const $ = (id) => document.getElementById(id);
const api = window.payablesReceivables ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, post: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
const both = (k) => (api === null ? { en: k, ta: k } : { en: api.words('en', k), ta: api.words('ta', k) });
const office = () => window.sreOffice ?? null;
const shopTime = (at) => (at === null || at === '' ? '' : window.sreShopDay?.dateTimeOf(at) ?? at);
const shopDay = (iso) => (window.sreOffice && typeof window.sreOffice.dateWords === 'function' ? window.sreOffice.dateWords(iso) : iso);
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
const fill = (words, values) => Object.entries(values).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), words);
const nameOf = (kind, id) => { const o = office(); const n = o && typeof o.nameOf === 'function' ? o.nameOf(kind, id) : id; return n && n !== id ? `${n} (${id})` : id; };
/** A greyed button says why (U1 · design system §1.3): the words beside it, in the reader's language; '' takes them away. */
function whyDisabled(btn, why) {
  const words = why === '' || why === undefined || why === null ? '' : typeof why === 'string' ? why : (why[lang] ?? why.en);
  let note = btn.nextElementSibling;
  if (!(note && note.classList.contains('sre-why'))) { note = document.createElement('small'); note.className = 'sre-why'; note.id = `${btn.id}-why`; btn.after(note); }
  note.textContent = words; note.hidden = words === '';
  if (words === '') { btn.removeAttribute('title'); btn.removeAttribute('aria-describedby'); } else { btn.title = words; btn.setAttribute('aria-describedby', note.id); }
}
const agreeChip = (agrees) => { const o = office(); return o === null ? document.createTextNode(agrees ? t('agrees') : t('differs')) : o.chip(agrees ? 'ok' : 'error', agrees ? t('agrees') : t('differs')); };

let ap = null; let apOutcome = null; let apAt = null;
let ar = null; let arOutcome = null; let arAt = null;

function paintAp() {
  const o = office();
  for (const id of ['ap-cards', 'ap-suppliers', 'ap-exceptions', 'ap-journals']) $(id).replaceChildren();
  $('ap-covers').textContent = ''; $('ap-derivations').textContent = ''; $('ap-exceptions-note').textContent = '';
  if (o === null) return;
  if (apOutcome !== null) { $('ap-status').textContent = api.outcomeWords(lang, apOutcome); o.state($('ap-suppliers'), o.stateOf(apOutcome), { title: api.outcomeWords(lang, apOutcome), detail: t('notReadDetail') }); return; }
  if (ap === null) { $('ap-status').textContent = ''; o.state($('ap-suppliers'), 'loading'); return; }
  $('ap-status').textContent = '';
  const r = ap.reconciliation;
  $('ap-covers').textContent = `${t('readAt')} ${shopTime(apAt)}`;
  const unposted = r.suppliers.reduce((n, s) => n + s.unposted.length, 0);
  o.cards($('ap-cards'), [
    { label: both('cRegisterOwed'), value: api.rupees(r.registerOwedMinor), icon: 'file-text' },
    { label: both('cLedgerOwed'), value: api.rupees(r.ledgerOwedMinor), icon: 'book' },
    { label: both('cDifference'), value: api.rupees(r.differenceMinor), tone: r.differenceMinor === 0 ? 'ok' : 'error', icon: r.differenceMinor === 0 ? 'check' : 'triangle-alert' },
    { label: both('cSuppliers'), value: r.suppliers.length, icon: 'users' },
    { label: both('cUnposted'), value: unposted, tone: unposted > 0 ? 'pending' : 'ok', icon: 'clock' },
    { label: both('cOpenExceptions'), value: ap.open, tone: ap.open > 0 ? 'error' : 'ok', icon: 'circle-alert' },
    { label: both('cControl'), value: r.controlAccount ?? null, note: r.controlAccount === null ? t('noControl') : undefined, icon: 'hash' },
  ]);
  if (r.leftDerivation || r.rightDerivation) $('ap-derivations').textContent = `${fill(t('leftRight'), { left: r.leftDerivation ?? '', right: r.rightDerivation ?? '' })} ${t('headOfficeEnglish')}`;
  $('post').hidden = !may.post;
  if (may.post) { $('post').disabled = unposted === 0; whyDisabled($('post'), unposted === 0 ? both('nothingToPost') : ''); }
  if (r.suppliers.length === 0) o.state($('ap-suppliers'), 'empty', { title: t('apNone'), detail: t('apNoneDetail') });
  else {
    o.table($('ap-suppliers'), {
      id: 'ap-suppliers-table', label: both('suppliersH'), rows: r.suppliers, pageSize: 20, sortable: true,
      rowKey: (s) => s.supplierId, rowData: (s) => ({ supplier: s.supplierId, agrees: String(s.agrees) }),
      columns: [
        { key: 'supplierId', label: both('supplier'), sort: 'text', value: (s) => nameOf('supplier', s.supplierId) },
        { key: 'registerOwedMinor', label: both('registerOwed'), sort: 'number', align: 'end', value: (s) => api.rupees(s.registerOwedMinor) },
        { key: 'ledgerOwedMinor', label: both('ledgerOwed'), sort: 'number', align: 'end', value: (s) => api.rupees(s.ledgerOwedMinor) },
        { key: 'differenceMinor', label: both('difference'), sort: 'number', align: 'end', value: (s) => api.rupees(s.differenceMinor) },
        { key: 'unposted', label: both('unposted'), sort: 'number', align: 'end', value: (s) => s.unposted.length },
        { key: 'agrees', label: both('state'), sort: 'text', value: (s) => (s.agrees ? t('agrees') : t('differs')), render: (s) => agreeChip(s.agrees) },
      ],
      empty: { title: t('apNone'), detail: t('apNoneDetail') },
    });
  }
  if (ap.exceptions.length === 0) o.state($('ap-exceptions'), 'empty', { title: t('exceptionsNone'), detail: t('exceptionsNoneDetail') });
  else {
    $('ap-exceptions-note').textContent = t('headOfficeEnglish');
    o.table($('ap-exceptions'), {
      id: 'ap-exceptions-table', label: both('exceptionsH'), rows: ap.exceptions, pageSize: 10, sortable: true,
      rowKey: (e) => e.exceptionId, rowData: (e) => ({ exception: e.exceptionId, state: e.state }),
      columns: [
        { key: 'state', label: both('state'), sort: 'text', value: (e) => t(e.state), render: (e) => o.recordChip(e.state) },
        { key: 'supplierId', label: both('supplier'), sort: 'text', value: (e) => (e.supplierId ? nameOf('supplier', e.supplierId) : null) },
        { key: 'kind', label: both('kind'), sort: 'text' },
        { key: 'reason', label: both('reason'), sort: 'text' },
        { key: 'detail', label: both('detail'), sort: false, value: (e) => e.detail ?? null },
        { key: 'raisedAt', label: both('raisedAt'), sort: 'text', value: (e) => (e.raisedAt ? shopTime(e.raisedAt) : null) },
      ],
      empty: { title: t('exceptionsNone'), detail: t('exceptionsNoneDetail') },
    });
  }
  if (ap.journals.length === 0) o.state($('ap-journals'), 'empty', { title: t('journalsNone'), detail: t('journalsNoneDetail') });
  else {
    o.table($('ap-journals'), {
      id: 'ap-journals-table', label: both('journalsH'), rows: ap.journals, pageSize: 10, sortable: true,
      rowKey: (j) => j.entryId, rowData: (j) => ({ entry: j.entryId, supplier: j.supplierId }),
      columns: [
        { key: 'entryId', label: both('entry'), sort: 'text' },
        { key: 'period', label: both('period'), sort: 'text' },
        { key: 'documentDate', label: both('documentDate'), sort: 'text', value: (j) => shopDay(j.documentDate) },
        { key: 'supplierId', label: both('supplier'), sort: 'text', value: (j) => nameOf('supplier', j.supplierId) },
        { key: 'kind', label: both('kind'), sort: 'text' },
        { key: 'amount', label: both('amount'), sort: 'number', align: 'end', value: (j) => api.rupees(api.journalAmountMinor(j)) },
        { key: 'postedBy', label: both('postedBy'), sort: 'text', value: (j) => nameOf('person', j.postedBy) },
      ],
      empty: { title: t('journalsNone'), detail: t('journalsNoneDetail') },
    });
  }
}

function paintAr() {
  const o = office();
  $('ar-cards').replaceChildren(); $('ar-customers').replaceChildren(); $('ar-covers').textContent = ''; $('ar-derivations').textContent = '';
  if (o === null) return;
  if (arOutcome !== null) { $('ar-status').textContent = api.outcomeWords(lang, arOutcome); o.state($('ar-customers'), o.stateOf(arOutcome), { title: api.outcomeWords(lang, arOutcome), detail: t('notReadDetail') }); return; }
  if (ar === null) { $('ar-status').textContent = ''; o.state($('ar-customers'), 'loading'); return; }
  $('ar-status').textContent = '';
  $('ar-covers').textContent = `${t('asAt')} ${shopDay(ar.asAt)} · ${t('readAt')} ${shopTime(arAt)}`;
  const x = ar.totals;
  o.cards($('ar-cards'), [
    { label: both('cCustomers'), value: x.customers, icon: 'users' },
    { label: both('cOutstanding'), value: api.rupees(x.outstandingMinor), icon: 'file-text' },
    { label: both('cInBooks'), value: api.rupees(x.financeOutstandingMinor), icon: 'book' },
    { label: both('cDifference'), value: api.rupees(x.differenceMinor), tone: x.differenceMinor === 0 ? 'ok' : 'error', icon: x.differenceMinor === 0 ? 'check' : 'triangle-alert', note: x.differing > 0 ? `${t('cDiffering')} ${x.differing}` : undefined },
    { label: both('cOverdue'), value: api.rupees(x.overdueMinor), tone: x.overdueMinor > 0 ? 'pending' : undefined, icon: 'clock' },
    { label: both('cDisputed'), value: api.rupees(x.disputedMinor), icon: 'circle-help' },
    { label: both('cChaseable'), value: api.rupees(x.chaseableMinor), icon: 'send' },
  ]);
  $('ar-derivations').textContent = `${fill(t('leftRight'), { left: ar.leftDerivation, right: ar.rightDerivation })} ${t('headOfficeEnglish')}`;
  if (ar.customers.length === 0) { o.state($('ar-customers'), 'empty', { title: t('arNone'), detail: t('arNoneDetail') }); return; }
  o.table($('ar-customers'), {
    id: 'ar-customers-table', label: both('customersH'), rows: ar.customers, pageSize: 20, sortable: true,
    rowKey: (c) => c.customerId, rowData: (c) => ({ customer: c.customerId, agrees: String(c.agrees) }),
    columns: [
      { key: 'customerId', label: both('customer'), sort: 'text', value: (c) => nameOf('customer', c.customerId) },
      { key: 'outstandingMinor', label: both('outstanding'), sort: 'number', align: 'end', value: (c) => api.rupees(c.outstandingMinor) },
      { key: 'financeOutstandingMinor', label: both('inBooks'), sort: 'number', align: 'end', value: (c) => api.rupees(c.financeOutstandingMinor) },
      { key: 'differenceMinor', label: both('difference'), sort: 'number', align: 'end', value: (c) => api.rupees(c.differenceMinor) },
      { key: 'agrees', label: both('state'), sort: 'text', value: (c) => (c.agrees ? t('agrees') : t('differs')), render: (c) => agreeChip(c.agrees) },
      { key: 'overdueMinor', label: both('overdue'), sort: 'number', align: 'end', value: (c) => api.rupees(c.overdueMinor) },
      { key: 'disputedMinor', label: both('disputed'), sort: 'number', align: 'end', value: (c) => api.rupees(c.disputedMinor) },
      { key: 'chaseableMinor', label: both('chaseable'), sort: 'number', align: 'end', value: (c) => api.rupees(c.chaseableMinor) },
      { key: 'invoices', label: both('invoices'), sort: 'number', align: 'end' },
    ],
    empty: { title: t('arNone'), detail: t('arNoneDetail') },
  });
}

function paint() {
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  document.title = `SRE ${t('title')}`;
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['reload-text', 'reload'], ['ap-h', 'apH'], ['ap-lead', 'apLead'], ['post-text', 'post'], ['ap-suppliers-h', 'suppliersH'], ['ap-exceptions-h', 'exceptionsH'], ['ap-journals-h', 'journalsH'],
    ['ar-h', 'arH'], ['ar-lead', 'arLead'], ['ar-customers-h', 'customersH']]) { const n = $(id); if (n) n.textContent = t(key); }
  paintAp(); paintAr();
}

async function loadAll() {
  $('ap-status').textContent = t('reading'); $('ar-status').textContent = t('reading');
  const [a, b] = await Promise.all([session.payables(), session.receivables()]);
  if (a.result === 'ok') { ap = a.value; apOutcome = null; apAt = new Date().toISOString(); } else { ap = null; apOutcome = a; }
  if (b.result === 'ok') { ar = b.value; arOutcome = null; arAt = new Date().toISOString(); } else { ar = null; arOutcome = b; }
  paint();
}

async function confirmFirst(spec) {
  const o = office();
  if (!o || typeof o.confirm !== 'function') return 'unavailable';
  const answer = await o.confirm(spec);
  return answer && answer.ok === true ? answer : null;
}

async function post() {
  if (ap === null) return;
  const unposted = ap.reconciliation.suppliers.reduce((n, s) => n + s.unposted.length, 0);
  const touched = ap.reconciliation.suppliers.filter((s) => s.unposted.length > 0).length;
  const values = { n: unposted, s: touched };
  const answer = await confirmFirst({ title: both('confirmPostTitle'), detail: { en: fill(api.words('en', 'confirmPostDetail'), values), ta: fill(api.words('ta', 'confirmPostDetail'), values) }, authority: both('confirmPostAuthority'), confirmLabel: both('post'), tone: 'warn' });
  if (answer === 'unavailable') { $('post-status').textContent = t('confirmUnavailable'); return; }
  if (answer === null) return;
  $('post-status').textContent = t('posting');
  const out = await session.post();
  $('post-status').textContent = out.result === 'ok' ? fill(t('posted'), { n: out.value.journals, x: out.value.exceptions }) : api.outcomeWords(lang, out);
  await loadAll();
}

const i = icon('refresh-cw'); if (i !== null) $('reload').prepend(i);
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
document.addEventListener('sre:chrome', () => { paint(); });
paint();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.read) $('page-status').textContent = t('cannotRead');
else {
  $('ap').hidden = false; $('ar').hidden = false;
  if (!may.post) $('page-status').textContent = t('cannotPost');
  $('reload').addEventListener('click', () => { void loadAll(); });
  $('post').addEventListener('click', () => { void post(); });
  void loadAll();
}
