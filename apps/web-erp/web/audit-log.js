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

let check = null; let rebuilt = null;
// U7 (OB-726): the found changes are ONE page at a time from head office, on the chrome's register (its loader); the
// page's own boxes narrow the search, the register's search box and column sort go to head office too.
let table = null; let boxes = null; // the register (built once); the boxes as last pressed (null until the first search)
const pair = (k) => ({ en: api === null ? k : api.words('en', k), ta: api === null ? k : api.words('ta', k) });

/** One record as a card — the rebuilt history of one thing (a short list) still reads this way. */
function row(r) {
  // The record as head office holds it (field names and values) is its data: shown as it is, marked English (OB-699).
  const li = document.createElement('li'); li.dataset.sequence = String(r.sequence); li.dataset.action = r.action; li.dataset.object = `${r.objectType}/${r.objectId}`;
  const head = document.createElement('div'); head.className = 'head';
  const ident = text('h4', `${r.action} — ${r.objectType} ${r.objectId}`); ident.setAttribute('lang', 'en'); // the record's own identifiers
  head.append(ident, text('span', `#${r.sequence} · ${api.moment(r.at)}`, 'meta'));
  li.append(head, text('p', `${t('who')} ${r.actorId} · ${t('where')} ${r.branchId ?? t('headOffice')}`, 'meta'), record(r));
  return li;
}

function paintRows() {
  const o = window.sreOffice ?? null; const host = $('rows-host');
  if (o === null || host === null || !may.read || boxes === null) return;
  if (table !== null && table.connected()) return;
  table = o.table(host, {
    id: 'audit-rows', label: pair('searchH'), pageSize: 10, sortable: true, bodyId: 'rows', loader: pageOfChanges,
    rowKey: (r) => String(r.sequence), rowData: (r) => ({ sequence: String(r.sequence), action: r.action, object: `${r.objectType}/${r.objectId}` }),
    columns: [
      { key: 'at', label: pair('cWhen'), value: (r) => `#${r.sequence} · ${api.moment(r.at)}` },
      { key: 'change', label: pair('cChange'), value: (r) => `${r.action} — ${r.objectType} ${r.objectId}`, render: (r) => { const n = text('span', `${r.action} — ${r.objectType} ${r.objectId}`); n.setAttribute('lang', 'en'); return n; } },
      { key: 'who', label: pair('cWho'), value: (r) => `${t('who')} ${r.actorId} · ${t('where')} ${r.branchId ?? t('headOffice')}` },
      { key: 'record', label: pair('cRecord'), sort: false, value: (r) => `${t('before')}: ${api.stateWords(r.before)} ${t('after')}: ${api.stateWords(r.after)}`, render: record },
    ],
    empty: { title: pair('none') },
  });
}

/** The record as head office holds it (field names and values) is its data: shown as it is, marked English (OB-699). */
function record(r) {
  const wrap = document.createElement('div');
  const dump = (label, state) => { const p = document.createElement('p'); p.append(document.createTextNode(`${label}: `)); const code = document.createElement('span'); code.setAttribute('lang', 'en'); code.textContent = api.stateWords(state); p.append(code); return p; };
  wrap.append(dump(t('before'), r.before), dump(t('after'), r.after));
  if (r.reason !== undefined) wrap.append(text('p', `${t('why')}: ${r.reason}`, 'meta'));
  if (r.approvalId !== undefined) wrap.append(text('p', `${t('approval')}: ${r.approvalId}`, 'meta'));
  return wrap;
}

/** U7: the register's loader — one page of the trail from head office; the count (or why there is none) said above it. */
let lastRead = null; // head office's last answer to the register's read — said again in the other language on the toggle
function sayFound() {
  if (lastRead === null) return;
  $('search-status').textContent = lastRead.result === 'ok' ? `${lastRead.value.total} ${t('found')}` : api.outcomeWords(lang, lastRead);
}
async function pageOfChanges(ask) {
  const out = await session.page(boxes ?? {}, ask);
  lastRead = out; sayFound();
  if (out.result === 'ok') return { rows: out.value.rows, total: out.value.total };
  const words = (l) => api.outcomeWords(l, out);
  return { state: out.result === 'lost_link' ? 'offline' : out.result === 'refused' && out.status === 403 ? 'denied' : 'error', stateOpts: { title: { en: words('en'), ta: words('ta') } } };
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
  paintRows(); paintCheck(); paintRebuilt(); sayFound();
}

async function find(e) {
  e?.preventDefault();
  $('search-status').textContent = t('reading');
  boxes = { actorId: $('q-actor').value, objectType: $('q-type').value, objectId: $('q-id').value, action: $('q-action').value, from: $('q-from').value, until: $('q-until').value };
  // A register already drawn reads page 1 again with the new boxes; drawn for the first time, it reads by itself.
  if (table !== null && table.connected()) await table.reload(); else paintRows();
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
  document.addEventListener('sre:chrome', () => { paintRows(); }); // the chrome's parts arrive after this script
}
