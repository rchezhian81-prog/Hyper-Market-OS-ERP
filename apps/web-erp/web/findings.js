// Bill findings and attendance flags (OB-608 · P-03 · P-08) — the page over head office's sale findings and attendance-mark
// routes. The session (apps/web-erp/src/findings-session.ts, in the bundle as window.findings) does every call and every rule;
// this page lays out what it is told. It reads head office as it opens (GETs only); nothing is written. Every word this page
// adds has a Tamil twin; head office's own sentences stay in English (OB-553).

const $ = (id) => document.getElementById(id);
const api = window.findings ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, sales: false, attendance: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }

let bills = null; let billsOutcome = null; // head office's last answer, or why there is none
let marks = null; let marksOutcome = null;

function paintBills() {
  $('s-rows').replaceChildren(); $('s-counts').textContent = '';
  if (billsOutcome !== null) { $('s-status').textContent = api.outcomeWords(lang, billsOutcome); return; }
  if (bills === null) return;
  $('s-status').textContent = '';
  $('s-counts').textContent = `${bills.critical} · ${bills.material} · ${bills.informational}  (${t('counts')})`;
  if (bills.findings.length === 0) { $('s-rows').append(text('li', t('salesNone'), 'meta')); return; }
  $('s-rows').replaceChildren(...bills.findings.map((f) => {
    const li = document.createElement('li');
    li.className = f.severity === 'critical' ? 'tone-error' : 'tone-degraded';
    li.dataset.severity = f.severity; li.dataset.kind = f.kind; li.dataset.sale = f.saleId;
    const head = document.createElement('div'); head.className = 'head';
    head.append(text('span', `${f.severity === 'critical' ? '✕' : '⚠'} ${t(f.severity)}`, 'chip'), text('span', `${t('bill')} ${f.saleId}`, 'meta'));
    li.append(head, text('p', f.detail));
    const facts = [];
    if (f.productId !== undefined) facts.push(`${t('product')}: ${f.productId}`);
    if (f.differenceMinor !== undefined) facts.push(`${t('difference')}: ${api.rupees(f.differenceMinor)}`);
    if (facts.length > 0) li.append(text('p', facts.join(' · '), 'meta'));
    if (f.ownerAction !== '') li.append(text('p', `${t('todo')} ${f.ownerAction}`, 'meta'));
    return li;
  }));
}

function paintMarks() {
  $('a-rows').replaceChildren(); $('a-counts').textContent = '';
  if (marksOutcome !== null) { $('a-status').textContent = api.outcomeWords(lang, marksOutcome); return; }
  if (marks === null) return;
  $('a-status').textContent = '';
  $('a-counts').textContent = `${marks.marksRead} ${t('marksRead')} ${marks.flagged.length}`;
  if (marks.flagged.length === 0) { $('a-rows').append(text('li', t('attNone'), 'meta')); return; }
  $('a-rows').replaceChildren(...marks.flagged.map((m) => {
    const li = document.createElement('li'); li.className = 'tone-degraded';
    li.dataset.mark = m.markId; li.dataset.person = m.employeeId; li.dataset.flags = m.flags.join(' ');
    const head = document.createElement('div'); head.className = 'head';
    head.append(text('h4', `${m.name} (${m.employeeId})`), text('span', `${t(m.kind)} · ${api.moment(m.at)}`, 'meta'));
    li.append(head, ...m.flags.map((f) => text('p', `⚠ ${api.flagWords(lang, f)}`, 'chip')));
    if (m.flaggedOnArrival.length > 0) li.append(text('p', `${t('flaggedOnArrival')} ${m.flaggedOnArrival.map((f) => api.flagWords(lang, f)).join(', ')}`, 'meta'));
    return li;
  }));
}

function paint() {
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  document.title = `SRE ${t('title')}`;
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['sales-h', 'salesH'], ['sales-lead', 'salesLead'], ['s-reload-text', 'reload'], ['att-h', 'attendanceH'], ['att-lead', 'attendanceLead'],
    ['a-day-l', 'day'], ['a-show-text', 'show']]) $(id).textContent = t(key);
  paintBills(); paintMarks();
}

async function loadBills() {
  $('s-status').textContent = t('reading');
  const out = await session.bills();
  if (out.result === 'ok') { bills = out.value; billsOutcome = null; } else { bills = null; billsOutcome = out; }
  paintBills();
}
async function loadMarks(event) {
  event?.preventDefault();
  $('a-status').textContent = t('reading');
  const out = await session.attendance($('a-day').value);
  if (out.result === 'ok') { marks = out.value; marksOutcome = null; } else { marks = null; marksOutcome = out; }
  paintMarks();
}

for (const [id, name] of [['s-reload', 'refresh-cw'], ['a-show', 'search']]) { const i = icon(name); if (i !== null) $(id).prepend(i); }
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.sales && !may.attendance) $('page-status').textContent = t('cannotRead');
else {
  if (may.sales) { $('sales').hidden = false; $('s-reload').addEventListener('click', () => { void loadBills(); }); void loadBills(); }
  if (may.attendance) {
    $('attendance').hidden = false;
    $('a-day').value = session.today();
    $('a-ask').addEventListener('submit', (e) => { void loadMarks(e); });
    void loadMarks();
  }
}
