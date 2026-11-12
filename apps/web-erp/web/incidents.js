// Incidents and recovery drills — the page over head office's incident and drill registers (M35-FR-02/04 · WF-20 · §32).
// It holds no rule: the session (apps/web-erp/src/incidents-session.ts, in the bundle as window.incidents) reads and
// writes head office's own routes in the signed-in person's session, refuses only blank or malformed input before a
// POST, and hands every refusal back in head office's words. Nothing is written on open; after each act the register
// and the open record are read again from head office. Every word has a Tamil twin and follows the one toggle.

const $ = (id) => document.getElementById(id);
// ── U2b (UI/UX gap audit G5 · G14 · P-07): a thing is PICKED by name through the chrome's picker, never typed as a code,
// and a date is written as the shop writes it (dd/mm/yyyy) through the chrome's shared field. The field keeps the id the
// page sends (the typed code stays possible when the list cannot be read — head office down, no right — so the form is
// never a dead end, P-01 · P-08); the chrome's sheet finds the thing by name, code or barcode and the name is shown beside
// the field. Mounted when the chrome is there (a page that paints first listens for `sre:chrome`); off the box nothing
// changes. The same six-line pattern as the U2 pages (store-tasks, delegation, floor-heat-map).
const u2bWords = Object.freeze({ en: { choose: 'Choose…', pickProduct: 'Which product?', pickPlace: 'Which place in the store?', pickPerson: 'Which person?', pickStore: 'Which store?', pickCustomer: 'Which customer?', pickApproval: 'Which approval?', pickSupplier: 'Which supplier?', yourStore: 'your store' }, ta: { choose: 'தேர்ந்தெடு…', pickProduct: 'எந்தப் பொருள்?', pickPlace: 'கடையில் எந்த இடம்?', pickPerson: 'எந்த நபர்?', pickStore: 'எந்தக் கடை?', pickCustomer: 'எந்த வாடிக்கையாளர்?', pickApproval: 'எந்த அனுமதி?', pickSupplier: 'எந்த விநியோகஸ்தர்?', yourStore: 'உங்கள் கடை' } }); // one line on purpose: a page's own word tables start a line with `en: {`
const u2bRepaints = [];
const repaintPickers = () => { for (const f of u2bRepaints) f(); };
/** Mount the picker on an input the page built itself (no id needed); the id a pick gives lands in the input. */
function pickableEl(input, kind, titleKey, extra = {}) {
  // U5: the chrome's own adapter (`sreOffice.pickable`) draws the "Choose…" button (#<id>-pick) and the name beside (#<id>-name);
  // this page keeps only its title words and the per-field options. The typed code stays the fallback (never a dead end).
  const office = window.sreOffice;
  if (!office || typeof office.pickable !== 'function') return;
  office.pickable(input, kind, { en: u2bWords.en[titleKey] ?? titleKey, ta: u2bWords.ta[titleKey] ?? titleKey }, extra);
}
function pickable(inputId, kind, titleKey, extra = {}) {
  const input = document.getElementById(inputId);
  if (!input) return;
  if (!window.sreOffice || typeof window.sreOffice.pick !== 'function') { document.addEventListener('sre:chrome', () => pickable(inputId, kind, titleKey, extra), { once: true }); return; }
  pickableEl(input, kind, titleKey, extra);
}
// the pickers' words and the shared fields' labels follow the language toggle like the page's own words
new MutationObserver(() => { repaintPickers(); if (typeof repaintShopDates === 'function') repaintShopDates(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
// ── U2b end
const api = window.incidents ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, readIncidents: false, manageIncidents: false, readDrills: false, recordDrills: false };

let lang = 'en';
const t = (k, slots) => (api === null ? k : api.words(lang, k, slots));

// U2 · G14 (UI/UX gap audit): a date a shop person reads — dd/mm/yyyy in the chrome's shared field (`sreOffice.dateField`),
// while the page goes on sending ISO (`dateOf`). Before the chrome has loaded, or off the box, the field stays as it was.
const wordsIn = (l, k) => (api === null ? k : api.words(l, k)); // the page's own words, for either language (null off the box)
const shopDates = new Map();
/** The shared fields' labels follow the language toggle like the page's own words do. */
function repaintShopDates() { const l = document.documentElement.lang === 'ta' ? 'ta' : 'en'; for (const [id, words] of shopDates) { const lab = $(id)?.closest('.sre-field')?.querySelector('.sre-field-label'); if (lab && lab.firstChild) lab.firstChild.textContent = words[l] ?? words.en; } }
function shopDate(id, words, opts = {}) {
  // U5: the chrome's own adapter (`sreOffice.shopDate`) swaps the box for the shared dd/mm/yyyy field under the same id; the
  // page reads ISO back with `dateOf` and remembers which fields it swapped.
  const office = window.sreOffice;
  if (!office || typeof office.shopDate !== 'function') { document.addEventListener('sre:chrome', () => shopDate(id, words, opts), { once: true }); return; }
  if (shopDates.has(id)) return;
  if (office.shopDate(id, words, opts) !== null) shopDates.set(id, words);
}
const dateOf = (id) => (shopDates.has(id) ? (window.sreOffice.dateValue(id) ?? '') : ($(id)?.value ?? ''));
// OB-607: a moment is shown at the SHOP's clock (its zone, as the store computer told the page) — never the UTC clock.
const when = (iso) => (typeof iso === 'string' ? window.sreShopDay?.dateTimeOf(iso) ?? '' : '');

let board = null; // { incidents, open } | null
let drillRegister = null; // DrillRegister | null
let loaded = false; // head office has answered once (ok or refused)
let targets = [];
let current = null; // IncidentDetail | null
let tab = 'incidents';

function say(el, out, good) {
  el.className = `status ${out.result === 'ok' ? 'good' : 'err'}`;
  el.textContent = out.result === 'ok' ? good : api.outcomeWords(lang, out);
}

function paintSummary() {
  const s = api.summarise(board?.incidents ?? null, drillRegister);
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


// ── U5 · G17 (UI/UX gap audit): every list on this page is the chrome's register part (`sreOffice.table`) — search, sort
// with its direction in words, paging, a count line, rows that stack on a phone. The old `<tbody id>` is kept as the
// register's body id so the records' data attributes read the same. Before the chrome has loaded the host waits for it.
const registers = new Map();
function register(hostId, opts) {
  const host = $(hostId); const o = window.sreOffice;
  if (host === null) return null;
  if (!o || typeof o.table !== 'function') {
    if (!registers.has(hostId)) { registers.set(hostId, null); document.addEventListener('sre:chrome', () => { registers.delete(hostId); register(hostId, opts); }, { once: true }); }
    return null;
  }
  let c = registers.get(hostId) ?? null;
  if (c === null || !c.connected()) { c = o.table(host, opts); registers.set(hostId, c); }
  else if (opts.state) c.setState(opts.state, opts.stateOpts ?? {}); else c.setRows(opts.rows ?? null);
  return c;
}
const chip = (tone, label) => { const o = window.sreOffice; if (o && typeof o.chip === 'function') return o.chip(tone, label); const s = document.createElement('span'); s.className = 'sre-chip'; s.dataset.tone = tone; s.textContent = typeof label === 'string' ? label : (label?.en ?? ''); return s; };
const recordChip = (state, label) => { const o = window.sreOffice; if (o && typeof o.recordChip === 'function') return o.recordChip(state, label); return chip('idle', label ?? state); };
const W = (k) => ({ en: api === null ? k : api.words('en', k), ta: api === null ? k : api.words('ta', k) });

const SEVERITY_TONE = { sev1: 'error', sev2: 'degraded', sev3: 'pending' };
const nameOf = (kind, id) => { const o = window.sreOffice; const key = id ?? ''; return o && typeof o.nameOf === 'function' && key !== '' ? (o.nameOf(kind, key) || key) : key; };
function paintIncidents() {
  const rows = board?.incidents ?? [];
  const c = register('incident-host', {
    id: 'incidents', label: W('tabIncidents'), bodyId: 'incident-rows', sortable: true, pageSize: 10,
    rowKey: (i) => i.incidentId, rowData: (i) => ({ incident: i.incidentId, state: i.state }),
    columns: [
      { key: 'title', label: W('colIncident') },
      { key: 'severity', label: W('colSeverity'), filter: true, value: (i) => t(i.severity), render: (i) => chip(SEVERITY_TONE[i.severity] ?? 'unknown', t(i.severity)) },
      { key: 'state', label: W('colState'), filter: true, value: (i) => (i.state === 'open' ? t('stateOpen') : t('stateClosed')), render: (i) => recordChip(i.state === 'open' ? 'open' : 'closed', i.state === 'open' ? t('stateOpen') : t('stateClosed')) },
      { key: 'openedAt', label: W('colOpened'), value: (i) => `${when(i.openedAt)} · ${nameOf('person', i.openedBy)}` },
      { key: 'openActions', label: W('colFollowUps'), sort: 'number', align: 'end', value: (i) => i.openActions },
      { key: 'hasPostmortem', label: W('colPostmortem'), value: (i) => (i.hasPostmortem ? t('yes') : t('no')) },
      { key: 'open', label: W('openRecord'), sort: false, render: (i) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'sre-btn sre-btn-quiet'; b.dataset.act = 'open'; b.textContent = t('openRecord'); b.addEventListener('click', (e) => { e.stopPropagation(); void openRecord(i.incidentId); }); return b; } },
    ],
    rows: board === null ? null : rows,
    ...(board === null && loaded ? { state: 'unknown' } : {}),
    empty: { title: W('noIncidents') },
  });
  // a tap on the row itself still opens the record (the Open button is the named way)
  if (c !== null && !$('incident-host').dataset.wired) {
    $('incident-host').dataset.wired = '1';
    $('incident-host').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-incident]'); if (tr === null || e.target.closest('button')) return; void openRecord(tr.dataset.incident); });
  }
}

function paintDrills() {
  const rows = drillRegister?.drills ?? [];
  register('drill-host', {
    id: 'drills', label: W('tabDrills'), bodyId: 'drill-rows', sortable: true, pageSize: 10,
    rowKey: (d) => d.drillId, rowData: (d) => ({ drill: d.drillId, passed: String(d.result.passed) }),
    columns: [
      { key: 'drillId', label: W('colDrill') },
      { key: 'service', label: W('colService'), filter: true, value: (d) => d.result.service },
      // the drill's result as the one chip, head office's detail beside it
      { key: 'result', label: W('colResult'), value: (d) => `${d.result.passed ? t('passed') : t('missed')} — ${d.result.detail}`, render: (d) => { const f = document.createDocumentFragment(); f.append(chip(d.result.passed ? 'ok' : 'error', d.result.passed ? t('passed') : t('missed')), document.createTextNode(` — ${d.result.detail}`)); return f; } },
      { key: 'drilledAt', label: W('colWhen'), value: (d) => when(d.drilledAt) },
      { key: 'drilledBy', label: W('colBy'), value: (d) => nameOf('person', d.drilledBy) },
    ],
    rows: drillRegister === null ? null : rows,
    ...(drillRegister === null && loaded ? { state: 'unknown' } : {}),
    empty: { title: W('noDrills') },
  });
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
      const btn = document.createElement('button'); btn.classList.add('sre-btn'); btn.type = 'button'; btn.textContent = t('markDone'); btn.dataset.act = 'done';
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
  repaintShopDates();
  document.title = `SRE ${t('title')}`;
  const pairs = [['title', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['open-new', 'newIncident'], ['k-open', 'sumOpen'], ['k-actions', 'sumActions'], ['k-drills', 'sumDrills'], ['k-posture', 'sumPosture'],
    ['tab-incidents', 'tabIncidents'], ['tab-drills', 'tabDrills'], ['incidents-h', 'tabIncidents'], ['incidents-lead', 'incidentsLead'], ['drills-h', 'tabDrills'], ['drills-lead', 'drillsLead'],
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
    reads.push(session.drills().then((out) => { if (out.result === 'ok') drillRegister = out.value; else say($('page-status'), out, ''); }));
    reads.push(session.targets().then((out) => { if (out.result === 'ok') targets = out.value; }));
  }
  await Promise.all(reads);
  loaded = true;
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
  const out = await session.addAction(current.incidentId, { description: $('a-desc').value, ownerUserId: $('a-owner').value, dueOn: dateOf('a-due') });
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
// the chrome loads after this script: its shared date fields replace the plain ones once it is there
document.addEventListener('sre:chrome', () => { shopDate('a-due', { en: wordsIn('en', 'aDue'), ta: wordsIn('ta', 'aDue') }); paintWords(); }, { once: true });

// ── U2b (G5): the owner of a follow-up is picked by name
pickable('a-owner', 'person', 'pickPerson');
