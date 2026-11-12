// Audit log (Round 4c) — the page over head office's stored domain audit trail. The session
// (apps/web-erp/src/audit-log-session.ts, in the bundle as window.auditLog) does every call and every rule; this page lays out
// what it is told. Reads only: it searches as it opens and on each press; nothing is written, ever. Every word this page adds
// has a Tamil twin; head office's own sentences stay in English (OB-553).

const $ = (id) => document.getElementById(id);
const api = window.auditLog ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }

let rows = null; let check = null; let rebuilt = null;

function row(r) {
  // The record as head office holds it (field names and values) is its data: shown as it is, marked English (OB-699).
  const dump = (label, state) => { const p = document.createElement('p'); p.append(document.createTextNode(`${label}: `)); const code = document.createElement('span'); code.setAttribute('lang', 'en'); code.textContent = api.stateWords(state); p.append(code); return p; };
  const li = document.createElement('li'); li.dataset.sequence = String(r.sequence); li.dataset.action = r.action; li.dataset.object = `${r.objectType}/${r.objectId}`;
  const head = document.createElement('div'); head.className = 'head';
  const ident = text('h4', `${r.action} — ${r.objectType} ${r.objectId}`); ident.setAttribute('lang', 'en'); // the record's own identifiers
  head.append(ident, text('span', `#${r.sequence} · ${api.moment(r.at)}`, 'meta'));
  li.append(head, text('p', `${t('who')} ${r.actorId} · ${t('where')} ${r.branchId ?? t('headOffice')}`, 'meta'),
    dump(t('before'), r.before), dump(t('after'), r.after));
  if (r.reason !== undefined) li.append(text('p', `${t('why')}: ${r.reason}`, 'meta'));
  if (r.approvalId !== undefined) li.append(text('p', `${t('approval')}: ${r.approvalId}`, 'meta'));
  return li;
}

function paintRows() {
  $('rows').replaceChildren();
  if (rows === null) return;
  $('search-status').textContent = `${rows.length} ${t('found')}`;
  if (rows.length === 0) { $('rows').append(text('li', t('none'), 'meta')); return; }
  $('rows').replaceChildren(...rows.map(row));
}
function paintCheck() {
  $('findings').replaceChildren();
  if (check === null) return;
  $('verify-status').textContent = (check.intact ? `✓ ${t('intact')}` : `✕ ${t('broken')}`).replace('{n}', String(check.recordsChecked)).replace('{f}', String(check.findings.length));
  for (const f of check.findings) { const li = text('li', `${t('record')} #${f.sequence}: ${t(f.reason)}${f.detail === '' ? '' : ` — ${f.detail}`}`); li.className = 'tone-error'; $('findings').append(li); }
}
function paintRebuilt() {
  $('history').replaceChildren(); $('rebuilt-state').textContent = '';
  if (rebuilt === null) return;
  if (rebuilt.history.length === 0) { $('rebuild-status').textContent = t('noHistory'); return; }
  $('rebuild-status').textContent = `${rebuilt.history.length} ${t('changes')}`;
  $('rebuilt-state').textContent = `${t('stateNow')}: ${api.stateWords(rebuilt.state)}`;
  $('history').replaceChildren(...rebuilt.history.map(row));
}

function paint() {
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  document.title = `SRE ${t('title')}`;
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['search-h', 'searchH'], ['search-lead', 'searchLead'], ['q-actor-l', 'actor'], ['q-type-l', 'objectType'], ['q-id-l', 'objectId'], ['q-action-l', 'action'],
    ['q-from-l', 'from'], ['q-until-l', 'until'], ['q-find-text', 'find'], ['verify-h', 'verifyH'], ['verify-lead', 'verifyLead'], ['v-check-text', 'verify'],
    ['rebuild-h', 'rebuildH'], ['rebuild-lead', 'rebuildLead'], ['r-type-l', 'objectType'], ['r-id-l', 'objectId'], ['r-go-text', 'rebuild']]) $(id).textContent = t(key);
  paintRows(); paintCheck(); paintRebuilt();
}

async function find(e) {
  e?.preventDefault();
  $('search-status').textContent = t('reading');
  const out = await session.search({ actorId: $('q-actor').value, objectType: $('q-type').value, objectId: $('q-id').value, action: $('q-action').value, from: $('q-from').value, until: $('q-until').value });
  if (out.result === 'ok') { rows = out.value; paintRows(); } else { rows = null; paintRows(); $('search-status').textContent = api.outcomeWords(lang, out); }
}

for (const [id, name] of [['q-find', 'search'], ['v-check', 'shield-check']]) { const i = icon(name); if (i !== null) $(id).prepend(i); }
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.read) $('page-status').textContent = t('cannotRead');
else {
  for (const id of ['search', 'verify', 'rebuild']) $(id).hidden = false;
  $('search-form').addEventListener('submit', (e) => { void find(e); });
  $('v-check').addEventListener('click', async () => {
    $('verify-status').textContent = t('reading');
    const out = await session.verify();
    if (out.result === 'ok') { check = out.value; paintCheck(); } else { check = null; paintCheck(); $('verify-status').textContent = api.outcomeWords(lang, out); }
  });
  $('rebuild-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('rebuild-status').textContent = t('reading');
    const out = await session.rebuild($('r-type').value, $('r-id').value);
    if (out.result === 'ok') { rebuilt = out.value; paintRebuilt(); } else { rebuilt = null; paintRebuilt(); $('rebuild-status').textContent = api.outcomeWords(lang, out); }
  });
  void find();
}
