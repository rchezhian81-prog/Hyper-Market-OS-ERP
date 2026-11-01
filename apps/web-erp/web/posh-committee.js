// The Internal Committee's annual report (Round 4c) — the committee's own page. The session
// (apps/web-erp/src/posh-committee-session.ts, in the bundle as window.poshCommittee) does every call and every rule; this page
// lays out what it is told. Counts only, never a complaint or a name. Making a report is an explicit press. Every word this
// page adds has a Tamil twin; head office's own sentences stay in English (OB-553).

const $ = (id) => document.getElementById(id);
const api = window.poshCommittee ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, committee: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function button(words, cls, onClick) { const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.textContent = words; b.addEventListener('click', onClick); return b; }

let years = null;
const reports = new Map();

function reportNode(r) {
  const box = document.createElement('div'); box.className = 'report'; box.dataset.year = String(r.year);
  const dl = document.createElement('dl');
  const pair = (k, v) => { dl.append(text('dt', k), text('dd', String(v))); };
  pair(t('pendingAtStart'), r.pendingAtStart); pair(t('received'), r.receivedInYear); pair(t('disposed'), r.disposedInYear);
  for (const k of ['upheld', 'not_upheld', 'conciliation', 'withdrawn']) pair(`  — ${t(k)}`, r.disposedByOutcome[k] ?? 0);
  pair(t('pendingAtEnd'), r.pendingAtEnd);
  box.append(dl, text('p', `${t('madeBy')} ${r.generatedBy} · ${api.moment(r.generatedAt)}`, 'meta'), text('p', `${t('law')}: ${r.law}`, 'meta'), text('p', `${t('note')}: ${r.formatNote}`, 'meta'));
  return box;
}

function paintYears() {
  const ul = $('rows'); ul.replaceChildren();
  if (years === null) return;
  if (years.length === 0) { ul.append(text('li', t('none'), 'meta')); return; }
  for (const y of years) {
    const li = document.createElement('li'); li.dataset.year = String(y.year); li.dataset.state = y.state; li.className = y.state;
    const head = document.createElement('div'); head.className = 'head';
    head.append(text('h4', `${t('year')} ${y.year}`), text('span', y.state === 'filed' ? `${t('filed')} ${y.filedOn}` : `${t(y.state)} · ${t('dueBy')} ${y.dueBy} · ${y.made ? t('made') : t('notMade')}`, 'meta'));
    li.append(head);
    const status = text('p', '', 'status'); status.setAttribute('role', 'status');
    const acts = document.createElement('div'); acts.className = 'acts';
    if (y.state !== 'filed') {
      acts.append(button(y.made ? t('makeAnother') : t('make'), y.made ? 'quiet' : '', async () => {
        status.textContent = t('reading');
        const out = await session.make(y.year);
        if (out.result !== 'ok') { status.textContent = api.outcomeWords(lang, out); return; }
        reports.set(y.year, out.value); status.textContent = '';
        void loadYears();
      }));
    }
    if (y.made) {
      acts.append(button(t('show'), 'quiet', async () => {
        status.textContent = t('reading');
        const out = await session.read(y.year);
        if (out.result !== 'ok') { status.textContent = api.outcomeWords(lang, out); return; }
        reports.set(y.year, out.value); status.textContent = ''; paintYears();
      }));
    }
    li.append(acts, status);
    const r = reports.get(y.year);
    if (r !== undefined) li.append(reportNode(r));
    ul.append(li);
  }
}

function paint() {
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  document.title = `SRE ${t('title')}`;
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['years-h', 'yearsH'], ['other-h', 'otherYearH'], ['other-year-l', 'otherYear'], ['other-show-text', 'show']]) $(id).textContent = t(key);
  paintYears();
}

async function loadYears() {
  $('years-status').textContent = t('reading');
  const out = await session.years();
  if (out.result === 'ok') { years = out.value; $('years-status').textContent = ''; } else { years = null; $('years-status').textContent = api.outcomeWords(lang, out); }
  paintYears();
}

$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
$('other-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('other-status').textContent = t('reading'); $('other-report').replaceChildren();
  const out = await session.read(Number($('other-year').value.trim()));
  if (out.result !== 'ok') { $('other-status').textContent = api.outcomeWords(lang, out); return; }
  $('other-status').textContent = ''; $('other-report').append(reportNode(out.value));
});
paint();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.committee) $('page-status').textContent = t('cannotRead');
else { $('years').hidden = false; void loadYears(); }
