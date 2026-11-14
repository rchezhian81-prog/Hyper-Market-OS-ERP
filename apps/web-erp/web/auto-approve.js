// Auto-approve limits (CR-01 OI-12 · OB-712) — the page over head office's auto-approve routes. The session
// (apps/web-erp/src/auto-approve-session.ts, in the bundle as window.autoApprove) does every call and every check; this page
// lays out what it is told. It reads as it opens; every act is an explicit press, and confirming a change opens the shared
// consequence-and-confirm sheet first (OB-698). Every word this page adds has a Tamil twin; head office's own sentences stay
// in English (OB-553). No `prompt`, `confirm` or `alert`.

const $ = (id) => document.getElementById(id);
const api = window.autoApprove ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, propose: false, confirm: false, stop: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
let view = null;
const shopWhen = (v) => window.sreShopDay?.dateTimeOf(v) ?? v;

function el(tag, attrs = {}, text) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text !== undefined) n.textContent = text;
  return n;
}
const kindName = (kind) => { const k = view?.kinds.find((x) => x.kind === kind); return k === undefined ? kind : (lang === 'ta' ? k.nameTa : k.nameEn); };
const kindMeasure = (kind) => view?.kinds.find((x) => x.kind === kind)?.measure ?? 'value_minor';

// `null` = the person went back (nothing is sent); 'unavailable' = the sheet could not open (said, never silent).
async function confirmFirst() {
  const office = window.sreOffice;
  if (!office || typeof office.confirm !== 'function') return 'unavailable';
  const w = (k) => ({ en: api.words('en', k), ta: api.words('ta', k) });
  const answer = await office.confirm({ title: w('confirmTitle'), detail: w('confirmDetail'), authority: w('confirmAuthority'), confirmLabel: w('confirmLabel'), tone: 'primary' });
  return answer && answer.ok === true ? answer : null;
}

function paintSwitch() {
  if (view === null) return;
  $('switch').dataset.running = String(view.running);
  $('switch-state').textContent = view.running ? t('running') : t('stopped');
  $('switch-who').textContent = view.running && view.startedBy !== null
    ? `${t('startedBy')} ${view.startedBy.askedBy}, ${t('confirmedBy')} ${view.startedBy.confirmedBy} · ${shopWhen(view.startedBy.at)}`
    : view.stoppedBy !== null ? `${t('stoppedBy')} ${view.stoppedBy.by} · ${shopWhen(view.stoppedBy.at)} — ${t('because')}: ${view.stoppedBy.reason}` : t('neverStarted');
  $('stop-form').hidden = !(may.stop && view.running);
  $('start-form').hidden = !(may.propose && !view.running && !view.pending.some((p) => p.action === 'resume'));
}

function paintKinds() {
  const list = $('kind-list'); list.replaceChildren();
  if (view === null) return;
  for (const k of view.kinds) {
    const li = el('li', { 'data-kind': k.kind, 'data-set': String(k.rule !== null) });
    li.append(el('h4', {}, lang === 'ta' ? k.nameTa : k.nameEn));
    li.append(el('p', { class: 'limit' }, k.rule === null ? t('noLimit') : `${t('limitIs')} ${api.limitWords(k.measure, k.rule.limit)}`));
    if (k.rule !== null) li.append(el('p', { class: 'meta' }, `${t('setBy')} ${k.rule.askedBy}, ${t('confirmedBy')} ${k.rule.confirmedBy} · ${shopWhen(k.rule.confirmedAt)} — ${k.rule.reason}`));
    li.append(el('p', { class: 'meta' }, `${t('usual')} ${lang === 'ta' ? k.usualTa : k.usualEn}`));
    if (may.propose) {
      const form = el('form', { class: 'row-form ask' });
      const lim = el('label'); lim.append(el('span', {}, k.measure === 'percent_bps' ? t('newLimitPercent') : t('newLimitRupees')), el('input', { class: 'limit-in', inputmode: 'decimal', autocomplete: 'off' }));
      const why = el('label'); why.append(el('span', {}, t('why')), el('input', { class: 'reason-in', autocomplete: 'off' }));
      const ask = el('button', { type: 'submit', class: 'sre-btn sre-btn-primary ask-limit' }, t('askLimit'));
      form.append(lim, why, ask);
      if (k.rule !== null) {
        const rm = el('button', { type: 'button', class: 'sre-btn remove-limit' }, t('askRemove'));
        rm.addEventListener('click', async () => report('limits-status', await session.askRemove(k, form.querySelector('.reason-in').value), 'limitAsked'));
        form.append(rm);
      }
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        report('limits-status', await session.askLimit(k, { limit: form.querySelector('.limit-in').value, reason: form.querySelector('.reason-in').value }), 'limitAsked');
      });
      li.append(form);
    }
    list.append(li);
  }
}

function actWords(p) {
  if (p.action === 'resume') return t('actResume');
  if (p.action === 'remove_limit') return `${t('actRemove')} ${kindName(p.kind)}`;
  return `${t('actSet')} ${kindName(p.kind)}: ${api.limitWords(kindMeasure(p.kind), p.limit ?? 0)}`;
}

function paintPending() {
  const list = $('pending-list'); list.replaceChildren();
  if (view === null) return;
  if (view.pending.length === 0) { list.append(el('li', { class: 'empty' }, t('nonePending'))); return; }
  for (const p of view.pending) {
    const li = el('li', { 'data-request': p.requestId });
    li.append(el('h4', {}, actWords(p)));
    li.append(el('p', { class: 'meta' }, `${t('askedBy')} ${p.requestedBy} · ${shopWhen(p.requestedAt)} — ${p.reason}`));
    if (p.mine) li.append(el('p', { class: 'mine' }, t('yours')));
    if (may.confirm && !p.mine) {
      const form = el('form', { class: 'row-form' });
      const why = el('label'); why.append(el('span', {}, t('refuseReason')), el('input', { class: 'reason-in', autocomplete: 'off' }));
      const ok = el('button', { type: 'button', class: 'sre-btn sre-btn-primary confirm' }, t('confirm'));
      const no = el('button', { type: 'button', class: 'sre-btn refuse' }, t('refuse'));
      ok.addEventListener('click', async () => {
        const answer = await confirmFirst();
        if (answer === 'unavailable') { $('pending-status').textContent = t('confirmUnavailable'); return; }
        if (answer === null) return;
        report('pending-status', await session.decide(p.requestId, 'confirmed', ''), 'confirmed');
      });
      no.addEventListener('click', async () => report('pending-status', await session.decide(p.requestId, 'refused', form.querySelector('.reason-in').value), 'refusedDone'));
      form.append(why, ok, no);
      li.append(form);
    }
    list.append(li);
  }
}

function paintRest() {
  if (view === null) return;
  $('never-list').replaceChildren(...view.never.map((n) => el('li', { 'data-never': n }, t(`never_${n}`))));
  const d = $('decision-list'); d.replaceChildren();
  if (view.decisions.length === 0) d.append(el('li', { class: 'empty' }, t('noDecisions')));
  for (const x of view.decisions) {
    const li = el('li', { 'data-outcome': x.outcome, 'data-proposal': x.proposalId });
    li.append(el('h4', {}, `${x.outcome === 'auto_approved' ? t('approvedByRule') : t('waits')} · ${x.proposalId}`));
    li.append(el('p', { class: 'meta' }, `${shopWhen(x.at)} — ${x.detail}`));
    d.append(li);
  }
  const h = $('history-list'); h.replaceChildren();
  if (view.history.length === 0) h.append(el('li', { class: 'empty' }, t('noHistory')));
  for (const x of [...view.history].reverse()) {
    const li = el('li', { 'data-request': x.requestId });
    li.append(el('h4', {}, `${actWords(x)} — ${x.decision === 'confirmed' ? t('wasConfirmed') : t('wasRefused')}`));
    li.append(el('p', { class: 'meta' }, `${t('askedBy')} ${x.askedBy}, ${x.decidedBy} · ${shopWhen(x.decidedAt)} — ${x.reason}`));
    h.append(li);
  }
}

function paintAll() { paintSwitch(); paintKinds(); paintPending(); paintRest(); }

function paint() {
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  document.title = `SRE ${t('title')}`;
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['switch-h', 'switchH'], ['stop-reason-l', 'stopReason'], ['stop-text', 'stop'], ['start-reason-l', 'startReason'], ['start-text', 'askStart'],
    ['limits-h', 'limitsH'], ['pending-h', 'pendingH'], ['never-h', 'neverH'], ['never-lead', 'neverLead'], ['decisions-h', 'decisionsH'], ['history-h', 'historyH']]) $(id).textContent = t(key);
  paintAll();
}

/** Show the outcome of an act: on success, the fresh read head office returned; otherwise its words (or the page's). */
function report(statusId, out, doneKey) {
  if (out.result === 'ok') { view = out.value; paintAll(); $(statusId).textContent = t(doneKey); } else $(statusId).textContent = api.outcomeWords(lang, out);
  document.body.dataset.autoApproveActs = String(Number(document.body.dataset.autoApproveActs ?? '0') + 1);
}

async function load() {
  $('page-status').textContent = t('reading');
  const out = await session.read();
  if (out.result === 'ok') { view = out.value; $('page-status').textContent = may.propose || may.confirm ? '' : t('readOnly'); } else { view = null; $('page-status').textContent = api.outcomeWords(lang, out); }
  for (const id of ['switch', 'limits', 'pending', 'never', 'decisions', 'history']) $(id).hidden = view === null;
  paintAll();
  document.body.dataset.autoApprove = view === null ? 'no' : 'ok';
}

$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
$('stop-form').addEventListener('submit', async (e) => { e.preventDefault(); report('switch-status', await session.stop($('stop-reason').value), 'stoppedNow'); });
$('start-form').addEventListener('submit', async (e) => { e.preventDefault(); if (view !== null) report('switch-status', await session.askStart(view, $('start-reason').value), 'startAsked'); });
paint();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.read) $('page-status').textContent = t('cannotRead');
else void load();
