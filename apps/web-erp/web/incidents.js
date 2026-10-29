// Incidents and recovery drills — the page over head office's incident and drill registers (M35-FR-02/04 · WF-20 · §32).
// It holds no rule: the session (apps/web-erp/src/incidents-session.ts, in the bundle as window.incidents) reads and
// writes head office's own routes in the signed-in person's session, refuses only blank or malformed input before a
// POST, and hands every refusal back in head office's words. Nothing is written on open; after each act the register
// and the open record are read again from head office. Every word has a Tamil twin and follows the one toggle.

const $ = (id) => document.getElementById(id);
const api = window.incidents ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, readIncidents: false, manageIncidents: false, readDrills: false, recordDrills: false };

let lang = 'en';
const t = (k, slots) => (api === null ? k : api.words(lang, k, slots));
// OB-607: a moment is shown at the SHOP's clock (its zone, as the store computer told the page) — never the UTC clock.
const when = (iso) => (typeof iso === 'string' ? window.sreShopDay?.dateTimeOf(iso) ?? '' : '');

let board = null; // { incidents, open } | null
let register = null; // DrillRegister | null
let targets = [];
let current = null; // IncidentDetail | null
let tab = 'incidents';

function say(el, out, good) {
  el.className = `status ${out.result === 'ok' ? 'good' : 'err'}`;
  el.textContent = out.result === 'ok' ? good : api.outcomeWords(lang, out);
}

function paintSummary() {
  const s = api.summarise(board?.incidents ?? null, register);
  $('v-open').textContent = s.openIncidents === null ? '—' : String(s.openIncidents);
  $('p-open').classList.toggle('attention', (s.openIncidents ?? 0) > 0);
  $('v-actions').textContent = s.openActions === null ? '—' : String(s.openActions);
  $('p-actions').classList.toggle('attention', (s.openActions ?? 0) > 0);
  $('v-drills').textContent = s.drills === null ? '—' : t('drillsLine', { passed: s.drills.passed, missed: s.drills.missed });
  $('p-drills').classList.toggle('attention', (s.drills?.missed ?? 0) > 0);
  $('v-posture').textContent = s.posture === null ? '—'
    : s.posture.length === 0 ? t('postureNone') : s.posture.map((p) => `${p.service}: ${p.passed ? t('passed') : t('missed')}`).join(' · ');
  $('p-posture').classList.toggle('attention', s.posture === null || s.posture.length === 0 || s.posture.some((p) => !p.passed));
}

function cell(text, cls) { const td = document.createElement('td'); if (cls) { const span = document.createElement('span'); span.className = cls; span.textContent = text; td.append(span); } else td.textContent = text; return td; }

function paintIncidents() {
  const body = $('incident-rows');
  body.replaceChildren();
  const rows = board?.incidents ?? [];
  $('no-incidents').hidden = board === null || rows.length > 0;
  $('no-incidents').textContent = t('noIncidents');
  for (const i of rows) {
    const tr = document.createElement('tr');
    tr.dataset.incident = i.incidentId;
    tr.dataset.state = i.state;
    tr.tabIndex = 0;
    tr.append(cell(i.title), cell(t(i.severity), `tag ${i.severity}`), cell(i.state === 'open' ? t('stateOpen') : t('stateClosed')), cell(`${when(i.openedAt)} · ${i.openedBy}`), cell(String(i.openActions)), cell(i.hasPostmortem ? t('yes') : t('no')));
    const open = () => { void openRecord(i.incidentId); };
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    body.append(tr);
  }
}

function paintDrills() {
  const body = $('drill-rows');
  body.replaceChildren();
  const rows = register?.drills ?? [];
  $('no-drills').hidden = register === null || rows.length > 0;
  $('no-drills').textContent = t('noDrills');
  for (const d of rows) {
    const tr = document.createElement('tr');
    tr.dataset.drill = d.drillId;
    tr.dataset.passed = String(d.result.passed);
    tr.append(cell(d.drillId), cell(d.result.service), cell(`${d.result.passed ? t('passed') : t('missed')} — ${d.result.detail}`, `tag ${d.result.passed ? 'passed' : 'missed'}`), cell(when(d.drilledAt)), cell(d.drilledBy));
    body.append(tr);
  }
  const select = $('d-service');
  if (select.options.length !== targets.length) {
    select.replaceChildren(...targets.map((x) => { const o = document.createElement('option'); o.value = x.service; o.textContent = x.service; return o; }));
  }
  $('drill-form').hidden = !may.recordDrills;
}

function li(text, extra) { const el = document.createElement('li'); el.textContent = text; if (extra) el.append(extra); return el; }

function paintRecord() {
  const i = current;
  if (i === null) return;
  const open = i.state === 'open';
  $('r-title').textContent = `${i.title} (${t(i.severity)})`;
  $('r-meta').textContent = `${i.incidentId} · ${t('openedLine', { by: i.openedBy, at: when(i.openedAt) })}${i.state === 'closed' ? ` · ${t('closedLine', { by: i.closedBy ?? '', at: when(i.closedAt), note: i.closingNote ?? '' })}` : ''}`;
  $('r-summary').textContent = i.summary;
  const tl = $('r-timeline');
  tl.replaceChildren(...(i.timeline.length === 0 ? [li(t('noTimeline'))] : i.timeline.map((e) => li(`${when(e.happenedAt)} — ${e.note} (${e.by})`))));
  const acts = $('r-actions');
  acts.replaceChildren(...(i.actions.length === 0 ? [li(t('noActions'))] : i.actions.map((a) => {
    const done = a.doneAt !== undefined;
    const text = `${a.description} — ${t('owner')} ${a.ownerUserId}, ${t('due')} ${a.dueOn}${done ? ` — ${t('doneBy')} ${a.doneBy}: ${a.doneNote ?? ''}` : ''}`;
    const row = li(text);
    row.dataset.action = a.actionId;
    row.dataset.done = String(done);
    if (!done && open && may.manageIncidents) {
      const note = document.createElement('input'); note.placeholder = t('doneNote'); note.setAttribute('aria-label', t('doneNote')); note.dataset.role = 'done-note';
      const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = t('markDone'); btn.dataset.act = 'done';
      btn.addEventListener('click', async () => {
        const out = await session.markActionDone(i.incidentId, a.actionId, note.value);
        say($('record-status'), out, t('actionDone'));
        if (out.result === 'ok') await refreshAll(i.incidentId);
      });
      row.append(note, btn);
    }
    return row;
  })));
  const pm = i.postmortem;
  $('r-pm').replaceChildren(...(pm === null ? [Object.assign(document.createElement('p'), { className: 'muted', textContent: t('noPm') })]
    : [`${t('pmCause')}: ${pm.cause}`, `${t('pmImpact')}: ${pm.impact}`, `${t('pmChange')}: ${pm.whatToChange}`, ...(pm.whatWentWell ? [`${t('pmWell')}: ${pm.whatWentWell}`] : []), `v${pm.version} · ${pm.by} · ${when(pm.at)}`]
      .map((line) => Object.assign(document.createElement('p'), { textContent: line }))));
  for (const id of ['r-timeline-form', 'r-action-form', 'r-pm-form', 'r-close-form']) $(id).hidden = !(open && may.manageIncidents);
}

function paintWords() {
  document.title = `SRE ${t('title')}`;
  const pairs = [['title', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['open-new', 'newIncident'], ['k-open', 'sumOpen'], ['k-actions', 'sumActions'], ['k-drills', 'sumDrills'], ['k-posture', 'sumPosture'],
    ['tab-incidents', 'tabIncidents'], ['tab-drills', 'tabDrills'], ['incidents-h', 'tabIncidents'], ['incidents-lead', 'incidentsLead'], ['drills-h', 'tabDrills'], ['drills-lead', 'drillsLead'],
    ['c-incident', 'colIncident'], ['c-severity', 'colSeverity'], ['c-state', 'colState'], ['c-opened', 'colOpened'], ['c-followups', 'colFollowUps'], ['c-pm', 'colPostmortem'],
    ['c-drill', 'colDrill'], ['c-service', 'colService'], ['c-result', 'colResult'], ['c-when', 'colWhen'], ['c-by', 'colBy'],
    ['drill-form-h', 'recordDrill'], ['l-d-id', 'dId'], ['l-d-service', 'dService'], ['l-d-loss', 'dLoss'], ['l-d-back', 'dBack'], ['d-save', 'saveDrill'],
    ['new-h', 'newIncident'], ['l-n-title', 'fTitle'], ['l-n-severity', 'fSeverity'], ['l-n-summary', 'fSummary'], ['n-save', 'save'], ['n-cancel', 'cancel'], ['o-sev1', 'sev1'], ['o-sev2', 'sev2'], ['o-sev3', 'sev3'],
    ['r-close', 'cancel'], ['r-timeline-h', 'timeline'], ['l-t-when', 'tlWhen'], ['l-t-note', 'tlNote'], ['t-add', 'addTimeline'], ['r-actions-h', 'actions'], ['l-a-desc', 'aDesc'], ['l-a-owner', 'aOwner'], ['l-a-due', 'aDue'], ['a-add', 'addAction'],
    ['r-pm-h', 'postmortem'], ['l-pm-cause', 'pmCause'], ['l-pm-impact', 'pmImpact'], ['l-pm-change', 'pmChange'], ['l-pm-well', 'pmWell'], ['pm-save', 'savePm'], ['l-c-note', 'closeNote'], ['c-close', 'close']];
  for (const [id, k] of pairs) { const el = $(id); if (el) el.textContent = t(k); }
  $('lang').textContent = t('lang');
  $('open-new').hidden = !may.manageIncidents;
  const nobody = $('nobody');
  nobody.hidden = may.named;
  nobody.textContent = t('nobody');
  if (may.named && !may.readIncidents && !may.readDrills) { $('page-status').className = 'status err'; $('page-status').textContent = t('cannotRead'); }
  else if (may.named && !may.manageIncidents) { $('page-status').className = 'status'; $('page-status').textContent = t('readOnly'); }
}

function showTab(which) {
  tab = which;
  $('view-incidents').hidden = which !== 'incidents';
  $('view-drills').hidden = which !== 'drills';
  for (const [id, on] of [['tab-incidents', which === 'incidents'], ['tab-drills', which === 'drills']]) {
    if (on) $(id).setAttribute('aria-current', 'page'); else $(id).removeAttribute('aria-current');
  }
}

async function load() {
  if (session === null || !may.named) return;
  const reads = [];
  if (may.readIncidents) reads.push(session.board().then((out) => { if (out.result === 'ok') board = out.value; else say($('page-status'), out, ''); }));
  if (may.readDrills) {
    reads.push(session.drills().then((out) => { if (out.result === 'ok') register = out.value; else say($('page-status'), out, ''); }));
    reads.push(session.targets().then((out) => { if (out.result === 'ok') targets = out.value; }));
  }
  await Promise.all(reads);
  paintSummary(); paintIncidents(); paintDrills();
}

async function openRecord(incidentId) {
  const out = await session.incident(incidentId);
  if (out.result !== 'ok') { say($('page-status'), out, ''); return; }
  current = out.value;
  $('record-status').textContent = '';
  $('sheet').dataset.incident = incidentId;
  paintRecord();
  $('sheet').hidden = false;
}

async function refreshAll(incidentId) {
  await load();
  if (incidentId !== undefined) {
    const out = await session.incident(incidentId);
    if (out.result === 'ok') { current = out.value; paintRecord(); }
  }
}

$('open-new').addEventListener('click', () => { $('new-status').textContent = ''; $('new-sheet').hidden = false; $('n-title').focus(); });
$('n-cancel').addEventListener('click', () => { $('new-sheet').hidden = true; });
$('r-close').addEventListener('click', () => { $('sheet').hidden = true; current = null; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('new-sheet').hidden = true; $('sheet').hidden = true; } });
$('tab-incidents').addEventListener('click', () => showTab('incidents'));
$('tab-drills').addEventListener('click', () => showTab('drills'));

$('n-save').addEventListener('click', async () => {
  const out = await session.openIncident({ title: $('n-title').value, severity: $('n-severity').value, summary: $('n-summary').value });
  say($('new-status'), out, t('opened'));
  if (out.result === 'ok') {
    $('n-title').value = ''; $('n-summary').value = '';
    $('new-sheet').hidden = true;
    say($('page-status'), out, t('opened'));
    await load();
    await openRecord(out.value.incidentId);
  }
});
$('t-add').addEventListener('click', async () => {
  const out = await session.addTimeline(current.incidentId, { happenedAt: $('t-when').value, note: $('t-note').value });
  say($('record-status'), out, t('timelineAdded'));
  if (out.result === 'ok') { $('t-note').value = ''; await refreshAll(current.incidentId); }
});
$('a-add').addEventListener('click', async () => {
  const out = await session.addAction(current.incidentId, { description: $('a-desc').value, ownerUserId: $('a-owner').value, dueOn: $('a-due').value });
  say($('record-status'), out, t('actionAdded'));
  if (out.result === 'ok') { $('a-desc').value = ''; $('a-owner').value = ''; await refreshAll(current.incidentId); }
});
$('pm-save').addEventListener('click', async () => {
  const out = await session.writePostmortem(current.incidentId, { cause: $('pm-cause').value, impact: $('pm-impact').value, whatToChange: $('pm-change').value, whatWentWell: $('pm-well').value });
  say($('record-status'), out, out.result === 'ok' ? t('pmSaved', { v: out.value.version }) : '');
  if (out.result === 'ok') await refreshAll(current.incidentId);
});
$('c-close').addEventListener('click', async () => {
  const out = await session.close(current.incidentId, $('c-note').value);
  say($('record-status'), out, t('closed'));
  if (out.result === 'ok') await refreshAll(current.incidentId);
});
$('d-save').addEventListener('click', async () => {
  const out = await session.recordDrill({ drillId: $('d-id').value, service: $('d-service').value, dataLossSeconds: $('d-loss').value, recoveryMinutes: $('d-back').value });
  say($('drill-status'), out, out.result === 'ok' ? t('drillSaved', { detail: out.value.detail }) : '');
  if (out.result === 'ok') { $('d-id').value = ''; await load(); }
});

$('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  paintWords(); paintSummary(); paintIncidents(); paintDrills(); paintRecord();
});

paintWords();
showTab(tab);
if (may.named && (may.readIncidents || may.readDrills)) { if ($('page-status').textContent === '') $('page-status').textContent = t('reading'); void load().then(() => { if ($('page-status').textContent === t('reading')) $('page-status').textContent = ''; }); }

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}
