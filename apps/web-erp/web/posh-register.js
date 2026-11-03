// W5 (C20 · OB-157) — the Internal Committee's CONFIDENTIAL complaints register, a section of the committee's own page. The
// session (apps/web-erp/src/posh-register-session.ts, in the bundle as window.poshRegister) does every call and every rule;
// this file lays out what it is told. The register is read only when a committee member presses "Show the register" (each
// read is sealed into the access log), nothing is cached or kept
// in the browser, and anyone else is told plainly that the register is the committee's alone. Every word has a Tamil twin.

const $ = (id) => document.getElementById(id);
const api = window.poshRegister ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, record: false };
const lang = () => (document.documentElement.lang === 'ta' ? 'ta' : 'en');
const t = (k) => (api === null ? k : api.words(lang(), k));
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function button(words, iconName, cls, onClick) { const b = document.createElement('button'); b.type = 'button'; if (cls) b.className = cls; const i = icon(iconName); if (i !== null) b.append(i); b.append(text('span', words)); b.addEventListener('click', onClick); return b; }
function field(labelWords, input) { const l = document.createElement('label'); l.append(text('span', labelWords), input); return l; }
function input(id, attrs = {}) { const i = document.createElement(attrs.tag ?? 'input'); i.id = id; for (const [k, v] of Object.entries(attrs)) if (k !== 'tag') i.setAttribute(k, v); return i; }
const say = (node, out) => { node.textContent = out.result === 'ok' ? '' : api.outcomeWords(lang(), out); };

let register = null;
let log = null;

function stepForm(c) {
  const box = document.createElement('div'); box.className = 'row-form';
  const kind = input(`st-kind-${c.complaintId}`, { tag: 'select' });
  for (const k of c.status === 'received' ? ['inquiry_started', 'disposed'] : ['disposed']) { const o = document.createElement('option'); o.value = k; o.textContent = k === 'disposed' ? t('stepDisposed') : t(k); kind.append(o); }
  const on = input(`st-on-${c.complaintId}`, { type: 'date' });
  const outcome = input(`st-outcome-${c.complaintId}`, { tag: 'select' });
  { const o = document.createElement('option'); o.value = ''; o.textContent = '—'; outcome.append(o); }
  for (const k of api.outcomes) { const o = document.createElement('option'); o.value = k; o.textContent = t(k); outcome.append(o); }
  const note = input(`st-note-${c.complaintId}`, { autocomplete: 'off' });
  const status = text('p', '', 'status'); status.setAttribute('role', 'status');
  box.append(field(t('stepKind'), kind), field(t('stepOn'), on), field(t('outcome'), outcome), field(t('note'), note),
    button(t('saveStep'), 'list-plus', '', async () => {
      const out = await session.step(c.complaintId, { kind: kind.value, on: on.value, outcome: outcome.value, note: note.value });
      if (out.result !== 'ok') { say(status, out); return; }
      status.textContent = t('stepOk'); await loadRegister();
    }));
  const wrap = document.createElement('div'); wrap.append(text('h4', t('stepH')), box, status);
  return wrap;
}

function paintRegister() {
  const ul = $('reg-rows'); ul.replaceChildren();
  if (register === null) { $('reg-count').textContent = ''; return; }
  $('reg-count').textContent = `${register.count} ${t('count')} · ${register.open} ${t('open')}`;
  if (register.complaints.length === 0) { ul.append(text('li', t('none'), 'meta')); return; }
  for (const c of register.complaints) {
    const li = document.createElement('li'); li.dataset.complaint = c.complaintId; li.dataset.status = c.status;
    li.className = c.status === 'disposed' ? 'filed' : '';
    const head = document.createElement('div'); head.className = 'head';
    head.append(text('h4', `${c.complaintId} · ${t(c.status)}`), text('span', `${t('receivedOn')} ${c.receivedOn}`, 'meta'));
    const dl = document.createElement('dl');
    const pair = (k, v) => { dl.append(text('dt', k), text('dd', v)); };
    pair(t('complainant'), c.complainantRef); pair(t('respondent'), c.respondentRef); pair(t('summary'), c.summary);
    if (c.outcome !== undefined) pair(t('outcome'), `${t(c.outcome)} · ${t('disposedOn')} ${c.disposedOn ?? ''}`);
    li.append(head, dl);
    if (c.steps.length > 0) {
      const steps = document.createElement('ul'); steps.className = 'steps';
      for (const s of c.steps) steps.append(text('li', `${s.on} · ${s.kind === 'disposed' ? t('stepDisposed') : t(s.kind)}${s.outcome ? ` (${t(s.outcome)})` : ''}${s.note ? ` — ${s.note}` : ''} · ${t('recordedBy')} ${s.recordedBy}`));
      li.append(text('p', t('steps'), 'meta'), steps);
    }
    if (may.record && c.status !== 'disposed') li.append(stepForm(c));
    ul.append(li);
  }
}

function paintLog() {
  const ul = $('log-rows'); ul.replaceChildren();
  if (log === null) return;
  if (log.entries.length === 0) { ul.append(text('li', t('logNone'), 'meta')); return; }
  for (const e of log.entries) ul.append(text('li', `${api.moment(e.at)} · ${t('who')} ${e.actorId} · ${t('what')} ${e.action} · ${e.objectId}`));
}

function paint() {
  for (const [id, key] of [['reg-h', 'registerH'], ['reg-lead', 'registerLead'], ['rc-h', 'receiveH'], ['rc-on-l', 'receivedOn'], ['rc-c-l', 'complainant'], ['rc-r-l', 'respondent'], ['rc-s-l', 'summary'], ['rc-save-text', 'receive'], ['log-h', 'logH'], ['log-show-text', 'showLog'], ['reg-show-text', 'showRegister']]) $(id).textContent = t(key);
  paintRegister(); paintLog();
}

async function loadRegister() {
  $('reg-status').textContent = t('reading');
  const out = await session.register();
  if (out.result === 'ok') { register = out.value; $('reg-status').textContent = ''; } else { register = null; say($('reg-status'), out); }
  paintRegister();
}

if (api !== null && $('register') !== null) {
  $('register').hidden = false;
  $('lang').addEventListener('click', () => { paint(); });
  paint();
  if (!may.named) $('reg-status').textContent = t('nobody');
  else if (!may.read) $('reg-status').textContent = t('cannotRead');
  else {
    $('reg-body').hidden = false;
    $('receive').hidden = !may.record;
    $('reg-show').addEventListener('click', () => { void loadRegister(); });
    $('rc-save').addEventListener('click', async () => {
      const out = await session.receive({ receivedOn: $('rc-on').value, complainantRef: $('rc-c').value, respondentRef: $('rc-r').value, summary: $('rc-s').value });
      if (out.result !== 'ok') { say($('rc-status'), out); return; }
      $('rc-status').textContent = `${t('receivedOk')} ${out.value.complaintId}`;
      for (const id of ['rc-on', 'rc-c', 'rc-r', 'rc-s']) $(id).value = '';
      await loadRegister();
    });
    $('log-show').addEventListener('click', async () => {
      $('log-status').textContent = t('reading');
      const out = await session.accessLog();
      if (out.result === 'ok') { log = out.value; $('log-status').textContent = ''; } else { log = null; say($('log-status'), out); }
      paintLog();
    });
  }
}
