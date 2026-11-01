// Open and close branches (Round 4c · M01-FR-04) — the page over head office's governed branch lifecycle. The session
// (apps/web-erp/src/branches-session.ts, in the bundle as window.branches) does every call and every rule; this page lays out
// what it is told. It reads the branches as it opens; checking, asking and changing are explicit presses. Every word this page
// adds has a Tamil twin; head office's own sentences stay in English (OB-553).

const $ = (id) => document.getElementById(id);
const api = window.branches ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, change: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function button(words, cls, onClick) { const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.textContent = words; b.addEventListener('click', onClick); return b; }
function field(labelWords, id, type) { const l = document.createElement('label'); l.htmlFor = id; l.append(text('span', labelWords)); const i = document.createElement('input'); i.id = id; i.autocomplete = 'off'; if (type) i.type = type; l.append(i); return { label: l, input: i }; }

let branches = null;

function changeNode(b, transition) {
  const box = document.createElement('div'); box.className = 'change'; box.dataset.transition = transition;
  const status = text('p', '', 'status'); status.setAttribute('role', 'status');
  const found = document.createElement('div');
  const why = field(t('reason'), `why-${b.branchId}-${transition}`);
  const reopens = field(t('reopensOn'), `reopens-${b.branchId}-${transition}`, 'date');
  if (transition !== 'temporarily_close') reopens.label.hidden = true;
  const acts = document.createElement('div'); acts.className = 'acts';
  let requestId = null;
  acts.append(why.label, reopens.label,
    button(t('check'), 'quiet', async () => {
      status.textContent = t('reading'); found.replaceChildren();
      const out = await session.readiness(b.branchId, transition);
      if (out.result !== 'ok') { status.textContent = api.outcomeWords(lang, out); return; }
      const r = out.value; const m = r.measured;
      const real = r.blockers.filter((x) => x.code !== 'approval_required');
      status.textContent = real.length === 0 ? (r.blockers.length === 0 ? t('readyNoApproval') : t('ready')) : '';
      found.append(text('p', `${t('measured')}: ${t('stock')} ${api.rupees(m.stockMinor)} · ${t('cash')} ${api.rupees(m.cashMinor)} · ${t('open')} ${m.openDocuments} · ${t('unsent')} ${m.unsentSyncItems ?? m.syncStateUnknown} · ${t('shifts')} ${m.openShifts} · ${t('exceptions')} ${m.unresolvedExceptions}`, 'meta'));
      if (real.length > 0) { found.append(text('p', t('blockers'))); const ul = document.createElement('ul'); ul.className = 'why'; for (const x of real) ul.append(text('li', x.detail)); found.append(ul); }
    }));
  if (may.change) {
    acts.append(button(transition === 'reopen' ? t('t_reopen') : t('ask'), 'quiet', async () => {
      status.textContent = t('reading');
      const out = await session.ask(b.branchId, transition, why.input.value, reopens.input.value);
      if (out.result !== 'ok') { status.textContent = api.outcomeWords(lang, out); return; }
      if ('done' in out.value) { status.textContent = t('done').replace('{state}', t(`state_${out.value.done}`)); void load(); return; }
      requestId = out.value.requestId; status.textContent = t('asked'); sendBtn.hidden = false;
    }));
  }
  const sendBtn = button(t('send'), 'quiet', async () => {
    if (requestId === null) return;
    status.textContent = t('reading');
    const out = await session.send(b.branchId, transition, why.input.value, reopens.input.value, requestId);
    if (out.result !== 'ok') { status.textContent = api.outcomeWords(lang, out); return; }
    if ('waiting' in out.value) { status.textContent = t('waiting'); return; }
    status.textContent = t('done').replace('{state}', t(`state_${out.value.done}`)); void load();
  });
  sendBtn.hidden = true; acts.append(sendBtn);
  box.append(text('h4', t(`t_${transition}`)), acts, status, found);
  return box;
}

function paint() {
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  document.title = `SRE ${t('title')}`;
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  $('list-h').textContent = t('listH');
  const ul = $('rows'); ul.replaceChildren();
  if (branches === null) return;
  if (branches.length === 0) { ul.append(text('li', t('none'), 'meta')); return; }
  for (const b of branches) {
    const li = document.createElement('li'); li.dataset.branch = b.branchId; li.dataset.state = b.state; li.className = b.state;
    const head = document.createElement('div'); head.className = 'head';
    head.append(text('h4', `${b.name} (${b.branchId})`), text('span', t(`state_${b.state}`), 'meta'));
    li.append(head);
    for (const tr of api.next[b.state]) li.append(changeNode(b, tr));
    const hist = document.createElement('div');
    li.append(button(t('history'), 'quiet', async () => {
      const out = await session.history(b.branchId);
      hist.replaceChildren();
      if (out.result !== 'ok') { hist.append(text('p', api.outcomeWords(lang, out), 'status')); return; }
      if (out.value.length === 0) { hist.append(text('p', t('noHistory'), 'meta')); return; }
      const h = document.createElement('ul'); h.className = 'why';
      for (const r of out.value) h.append(text('li', `${api.moment(r.at)} · ${t(`t_${r.transition}`)} · ${t('by')} ${r.requestedBy} · ${r.approvedBy === null ? t('noApproval') : `${t('approvedBy')} ${r.approvedBy}`} · ${r.reason}`));
      hist.append(h);
    }), hist);
    ul.append(li);
  }
}

async function load() {
  $('list-status').textContent = t('reading');
  const out = await session.branches();
  if (out.result === 'ok') { branches = out.value; $('list-status').textContent = ''; } else { branches = null; $('list-status').textContent = api.outcomeWords(lang, out); }
  paint();
}

$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.read) $('page-status').textContent = t('cannotRead');
else { $('list').hidden = false; if (!may.change) $('page-status').textContent = t('cannotChange'); void load(); }
