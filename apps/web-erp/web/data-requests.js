// Customer data requests (W3 · M16-FR-03) — the page over head office's data-rights routes. The session
// (apps/web-erp/src/data-requests-session.ts, in the bundle as window.dataRequests) does every call and every rule; this page
// lays out what it is told. It reads the queue as it opens; every step is an explicit press. Every word this page adds has a
// Tamil twin; head office's own sentences stay in English (OB-553).

const $ = (id) => document.getElementById(id);
const api = window.dataRequests ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, manage: false, approve: false, execute: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function button(words, cls) { const b = document.createElement('button'); b.type = 'button'; b.textContent = words; if (cls) b.className = cls; return b; }

let view = null;

function saveFile(name, contents) {
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.textContent = t('saveFile'); a.className = 'save';
  return a;
}

function heldList(categories) {
  const ul = document.createElement('ul'); ul.className = 'held';
  if (categories.length === 0) ul.append(text('li', t('nothingHeld'), 'meta'));
  for (const c of categories) {
    const li = text('li', `${c.category} — ${c.recordCount} ${t('records')}: ${c.fate === 'erase' ? t('willErase') : c.fate === 'minimise' ? t('willMinimise') : c.fate === 'keep' ? `${t('willKeep')} (${c.retentionBasis}${c.retainUntil ? `, ${c.retainUntil}` : ''})` : c.state}`);
    li.dataset.category = c.category; li.dataset.fate = c.fate;
    ul.append(li);
  }
  return ul;
}

function requestRow(r) {
  const li = document.createElement('li'); li.dataset.request = r.requestId; li.dataset.state = r.state; li.dataset.kind = r.kind;
  li.append(text('h4', `${r.customerRef} — ${t(`kind_${r.kind}`)} · ${t(`state_${r.state}`)}`),
    text('p', `${t('raised')} ${api.moment(r.raisedAt)} · ${t('due')} ${r.dueBy}${r.verifiedBy ? ` · ${r.verifiedBy}` : ''}`, 'meta'));
  const status = text('p', '', 'status'); status.setAttribute('role', 'status');
  const acts = document.createElement('div'); acts.className = 'acts';
  const after = (out, good, reload = true) => { status.textContent = out.result === 'ok' ? good : api.outcomeWords(lang, out); if (out.result === 'ok' && reload) void load(); };
  if (r.state === 'raised') {
    const l = document.createElement('label'); const id = `how-${r.requestId}`; l.htmlFor = id; l.append(text('span', t('verifiedHow')));
    const how = document.createElement('input'); how.id = id; how.className = 'how'; how.autocomplete = 'off'; l.append(how);
    const b = button(t('verify'), 'verify');
    b.addEventListener('click', async () => { status.textContent = t('reading'); after(await session.verify(r.requestId, how.value), t('checked')); });
    acts.append(l, b);
  } else if (r.kind === 'erasure') {
    const show = button(t('showHeld'), 'quiet show-held'); const box = document.createElement('div');
    show.addEventListener('click', async () => {
      status.textContent = t('reading');
      const out = await session.held(r.customerRef);
      if (out.result !== 'ok') { status.textContent = api.outcomeWords(lang, out); return; }
      status.textContent = ''; box.replaceChildren(text('p', t('heldH'), 'meta'), heldList(out.value.categories));
    });
    acts.append(show);
    if (may.approve) {
      const b = button(t('approve'), 'quiet approve');
      b.addEventListener('click', async () => { status.textContent = t('reading'); after(await session.approve(r.requestId), t('approved'), false); });
      acts.append(b);
    }
    if (may.execute) {
      const b = button(t('execute'), 'execute');
      b.addEventListener('click', async () => {
        status.textContent = t('reading');
        const out = await session.execute(r.requestId);
        if (out.result !== 'ok') { status.textContent = api.outcomeWords(lang, out); return; }
        status.textContent = t('executed');
        box.replaceChildren(text('p', t('statement'), 'meta'), text('p', out.value.customerStatement, 'statement'));
      });
      acts.append(b);
    }
    li.append(acts, status, box);
    return li;
  } else if (r.kind !== 'grievance') {
    const b = button(t('exportBtn'), 'export');
    b.addEventListener('click', async () => {
      status.textContent = t('reading');
      const out = await session.exportFor(r);
      if (out.result !== 'ok') { status.textContent = api.outcomeWords(lang, out); return; }
      status.textContent = t('exported');
      acts.append(saveFile(out.value.fileName, out.value.contents));
    });
    acts.append(b);
  }
  li.append(acts, status);
  return li;
}

function paintList() {
  $('rows').replaceChildren(); $('overdue').replaceChildren();
  if (view === null) return;
  if (view.queue.length === 0) $('rows').append(text('li', t('none'), 'meta'));
  for (const r of view.queue) $('rows').append(requestRow(r));
  $('late').hidden = false;
  if (view.overdue.length === 0) $('overdue').append(text('li', t('noneOverdue'), 'meta'));
  for (const r of view.overdue) { const li = text('li', `${r.customerRef} — ${t(`kind_${r.kind}`)} · ${t('due')} ${r.dueBy}`); li.dataset.request = r.requestId; $('overdue').append(li); }
}

function paint() {
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  document.title = `SRE ${t('title')}`;
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['demo-only', 'demoOnly'], ['record-h', 'recordH'], ['r-customer-l', 'customer'], ['r-kind-l', 'kind'], ['r-record-text', 'record'], ['queue-h', 'queueH'], ['overdue-h', 'overdueH']]) $(id).textContent = t(key);
  const sel = $('r-kind'); const was = sel.value;
  sel.replaceChildren(...(api?.kinds ?? []).map((k) => { const o = document.createElement('option'); o.value = k; o.textContent = t(`kind_${k}`); return o; }));
  if (was !== '') sel.value = was;
  paintList();
}

async function load() {
  $('list-status').textContent = t('reading');
  const out = await session.queue();
  if (out.result === 'ok') { view = out.value; $('list-status').textContent = ''; } else { view = null; $('list-status').textContent = api.outcomeWords(lang, out); }
  paintList();
}

$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
$('record-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('record-status').textContent = t('reading');
  const out = await session.raise($('r-customer').value, $('r-kind').value);
  $('record-status').textContent = out.result === 'ok' ? t('requested') : api.outcomeWords(lang, out);
  if (out.result === 'ok') void load();
});
paint();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.manage) { $('list').hidden = false; $('page-status').textContent = t('cannotRead'); void load(); }
else { $('list').hidden = false; $('record').hidden = false; void load(); }
