// Compensation (U6 · M21-FR-03 · §28 · OB-698) — the page over head office's compensation routes and the approvals engine. The
// session (apps/web-erp/src/compensation-session.ts, in the bundle as window.compensation) does every call and every rule;
// this page lays out what it is told on the shared office parts (window.sreOffice: cards, table, state, chips, fields, the
// confirm sheet). Within the person's own authority a compensation is GIVEN after one confirm; above it the page ASKS a
// second person on the Approvals page and gives it only with that approval; above the desk ceiling nothing is sent. Every
// word this page adds has a Tamil twin; head office's own sentences stay in English (OB-553, OB-699).

const $ = (id) => document.getElementById(id);
const api = window.compensation ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, manage: false, approve: false };
let lang = 'en';
// Opened without the store computer's screen data (no session in the bundle): the page says so on the shared state, in both
// languages, and reads and writes nothing — never a crash (P-08).
const OFF = {
  en: { title: 'Compensation', offTitle: 'Not answered', offDetail: 'This page was opened without the store computer, so who you are and what head office holds are not known here. Open it from the store computer\'s menu. Nothing was read or changed.' },
  ta: { title: 'இழப்பீடு', offTitle: 'பதில் இல்லை', offDetail: 'இந்தப் பக்கம் கடைக் கணினி இல்லாமல் திறக்கப்பட்டது, எனவே நீங்கள் யார், தலைமை அலுவலகம் என்ன வைத்திருக்கிறது என்பது இங்கே தெரியாது. கடைக் கணினியின் பட்டியலிலிருந்து திறங்கள். எதுவும் படிக்கப்படவில்லை, மாற்றப்படவில்லை.' },
};
const t = (k) => (api === null ? (OFF[lang][k] ?? OFF.en[k] ?? '') : api.words(lang, k));
const both = (k) => (api === null ? { en: OFF.en[k] ?? '', ta: OFF.ta[k] ?? '' } : { en: api.words('en', k), ta: api.words('ta', k) });
/** The no-data state, drawn with the shared part once the chrome is there (or as plain words before it). */
function paintOff() {
  const host = document.getElementById('page-status');
  const o = window.sreOffice ?? null;
  if (o !== null && typeof o.state === 'function') o.state(host, 'unknown', { title: t('offTitle'), detail: t('offDetail') });
  else host.textContent = `${t('offTitle')} — ${t('offDetail')}`;
}
const fillIn = (text, values) => Object.entries(values).reduce((acc, [k, v]) => acc.split(`{${k}}`).join(String(v)), text);
const office = () => window.sreOffice ?? null;
const chrome = () => (window.sreOffice && typeof window.sreOffice.confirm === 'function' ? Promise.resolve(window.sreOffice) : new Promise((resolve) => document.addEventListener('sre:chrome', () => resolve(window.sreOffice), { once: true })));
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
const shopTime = (at) => (!at ? '' : window.sreShopDay?.dateTimeOf(at) ?? at);
const customerName = (ref) => { const o = office(); const n = o && typeof o.nameOf === 'function' ? o.nameOf('customer', ref) : ref; return n && n !== ref ? `${n} (${ref})` : ref; };
const caseWanted = new URL(location.href).searchParams.get('case') ?? '';
/** U1 (design system §1.3): a greyed button says why — the shared `.sre-why` note beside it, in the reader's language. */
function whyDisabled(btn, why) {
  const words = why === '' || why === undefined || why === null ? '' : typeof why === 'string' ? why : (why[lang] ?? why.en);
  let note = btn.nextElementSibling;
  if (!(note && note.classList.contains('sre-why'))) { note = document.createElement('small'); note.className = 'sre-why'; note.id = `${btn.id}-why`; btn.after(note); }
  note.textContent = words; note.hidden = words === '';
  if (words === '') { btn.removeAttribute('title'); btn.removeAttribute('aria-describedby'); } else { btn.title = words; btn.setAttribute('aria-describedby', note.id); }
}

let limits = null; let limitsOutcome = null;
let cases = null; let casesOutcome = null;
let picked = null; // the case chosen
let given = null; let givenOutcome = null;
let asked = null; let askedOutcome = null;
let fields = null; // the form's shared fields, built once the chrome is there

document.addEventListener('sre:chrome', () => { buildForm(); paint(); });

function stateOr(host, outcome, title, detail) {
  const o = office();
  if (o === null) return;
  o.state(host, o.stateOf(outcome), { title: title ?? api.outcomeWords(lang, outcome), detail: detail ?? '' });
}

/** The desk's limits as cards: the agent's own, the ceiling, and what THIS person may give alone. */
function paintLimits() {
  const o = office();
  $('limits-cards').replaceChildren(); $('limits-source').textContent = '';
  if (limitsOutcome !== null) { $('limits-status').textContent = api.outcomeWords(lang, limitsOutcome); stateOr($('limits-cards'), limitsOutcome); return; }
  if (limits === null) { $('limits-status').textContent = t('reading'); if (o !== null) o.state($('limits-cards'), 'loading'); return; }
  $('limits-status').textContent = '';
  $('limits-source').textContent = limits.isStandard ? t('standard') : t('shopsOwn');
  if (o === null) return;
  o.cards($('limits-cards'), [
    { label: t('agentAlone'), value: api.rupees(limits.agentAuthorityMinor), icon: 'user-round' },
    { label: t('ceiling'), value: api.rupees(limits.deskCeilingMinor), icon: 'shield-check' },
    { label: t('yours'), value: api.rupees(limits.ownAuthorityMinor), tone: may.approve ? 'ok' : undefined, icon: 'badge-check' },
  ]);
}

const stateChip = (o, state) => o.recordChip(state === 'resolved' ? 'completed' : state === 'waiting_on_customer' ? 'waiting' : state, state === 'resolved' ? { en: 'resolved', ta: 'தீர்க்கப்பட்டது' } : undefined);

/** Every case as a register with search and paging; "Choose" opens the case's own panel. */
function paintCases() {
  const o = office();
  $('cases-table').replaceChildren();
  if (casesOutcome !== null) { $('cases-status').textContent = api.outcomeWords(lang, casesOutcome); stateOr($('cases-table'), casesOutcome); return; }
  if (cases === null) { $('cases-status').textContent = t('reading'); if (o !== null) o.state($('cases-table'), 'loading'); return; }
  $('cases-status').textContent = '';
  if (o === null) return;
  if (cases.length === 0) { o.state($('cases-table'), 'empty', { title: t('noCases'), detail: t('noCasesDetail') }); return; }
  o.table($('cases-table'), {
    id: 'cases', label: both('casesH'), rows: cases, pageSize: 10, sortable: true,
    rowKey: (c) => c.caseId, rowData: (c) => ({ case: c.caseId, state: c.state }),
    columns: [
      { key: 'caseId', label: both('caseCol'), sort: 'text' },
      { key: 'customerRef', label: both('customer'), sort: 'text', value: (c) => customerName(c.customerRef) },
      { key: 'kind', label: both('kindCol'), sort: 'text', value: (c) => (api.caseKind(lang, c.kind)) },
      { key: 'state', label: both('state'), sort: 'text', value: (c) => c.state, render: (c) => stateChip(o, c.state) },
      { key: 'summary', label: both('summary') },
      { key: 'openedAt', label: both('opened'), sort: 'text', value: (c) => shopTime(c.openedAt) },
      { key: 'choose', label: both('choose'), sort: false, render: (c) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'sre-btn sre-btn-quiet'; b.dataset.choose = c.caseId; b.textContent = t('choose'); b.addEventListener('click', () => { void choose(c); }); return b; } },
    ],
    empty: { title: t('noCases'), detail: t('noCasesDetail') },
  });
}

/** What was given on the chosen case, with who gave it and who approved it (PF-11: and whether it was carried out). */
function paintGiven() {
  const o = office();
  $('given-table').replaceChildren();
  if (picked === null) return;
  if (givenOutcome !== null) { $('given-status').textContent = api.outcomeWords(lang, givenOutcome); stateOr($('given-table'), givenOutcome); return; }
  if (given === null) { $('given-status').textContent = t('reading'); if (o !== null) o.state($('given-table'), 'loading'); return; }
  $('given-status').textContent = '';
  if (o === null) return;
  if (given.compensations.length === 0) { o.state($('given-table'), 'empty', { title: t('givenNone'), detail: t('givenNoneDetail') }); return; }
  const status = (x) => (x.fulfilment === undefined ? t('notCarried') : `${t(`f_${x.fulfilment.status}`) === `f_${x.fulfilment.status}` ? x.fulfilment.status : t(`f_${x.fulfilment.status}`)}${x.fulfilment.detail ? ` — ${x.fulfilment.detail}` : ''}`);
  o.table($('given-table'), {
    id: 'given', label: both('givenH'), rows: given.compensations, pageSize: 10, search: false,
    rowKey: (x) => x.compensationId ?? `${x.at}-${x.amountMinor}`, rowData: (x) => ({ compensation: x.compensationId ?? '', kind: x.kind, state: x.fulfilment?.status ?? 'none' }),
    columns: [
      { key: 'kind', label: both('kind'), value: (x) => t(`kind_${x.kind}`) },
      { key: 'amountMinor', label: both('amount'), sort: 'number', align: 'end', value: (x) => api.rupees(x.amountMinor) },
      { key: 'reason', label: both('reason') },
      { key: 'grantedBy', label: both('by'), value: (x) => (office()?.nameOf?.('person', x.grantedBy) ?? x.grantedBy) },
      { key: 'approvedBy', label: both('approvedBy'), value: (x) => (x.approvedBy === undefined ? null : (office()?.nameOf?.('person', x.approvedBy) ?? x.approvedBy)) },
      { key: 'at', label: both('when'), sort: 'text', value: (x) => shopTime(x.at) },
      { key: 'status', label: both('status'), value: status, render: (x) => { const s = x.fulfilment?.status; const w = document.createElement('span'); w.append(o.recordChip(s === undefined ? 'pending' : s === 'completed' ? 'done' : s, s === undefined ? t('notCarried') : undefined)); if (x.fulfilment?.detail) w.append(document.createTextNode(` ${x.fulfilment.detail}`)); return w; } },
    ],
  });
  $('case-facts').replaceChildren(...[
    `${t('caseCol')}: ${picked.caseId} · ${t('customer')}: ${customerName(picked.customerRef)}`,
    `${api.caseKind(lang, picked.kind)} · ${picked.summary}`,
    `${t('givenH')}: ${given.count} · ${api.rupees(given.totalMinor)}`,
  ].map((line) => { const s = document.createElement('span'); s.textContent = line; return s; }));
}

/** This case's approval requests — waiting, approved (then "Give it now"), rejected, used, expired — as head office says. */
function paintAsked() {
  const o = office();
  $('asked-table').replaceChildren();
  if (picked === null) return;
  if (askedOutcome !== null) { $('asked-status').textContent = api.outcomeWords(lang, askedOutcome); stateOr($('asked-table'), askedOutcome); return; }
  if (asked === null) { $('asked-status').textContent = t('reading'); if (o !== null) o.state($('asked-table'), 'loading'); return; }
  $('asked-status').textContent = '';
  if (o === null) return;
  if (asked.length === 0) { o.state($('asked-table'), 'empty', { title: t('askedNone'), detail: t('askedNoneDetail') }); return; }
  const statusWords = (r) => (t(`s_${r.status}`) === `s_${r.status}` ? r.status : t(`s_${r.status}`));
  const decider = (r) => (r.decidedBy !== undefined ? (office()?.nameOf?.('person', r.decidedBy) ?? r.decidedBy) : r.decider === undefined ? t('anyApprover') : r.decider.named ? (r.decider.displayName ?? '') : t('nobodyNamed'));
  o.table($('asked-table'), {
    id: 'asked', label: both('askedH'), rows: asked, pageSize: 10, search: false,
    rowKey: (r) => r.requestId, rowData: (r) => ({ request: r.requestId, status: r.status }),
    columns: [
      { key: 'requestId', label: { en: 'Request', ta: 'கோரிக்கை' } },
      { key: 'kind', label: both('kind'), value: (r) => t(`kind_${r.details?.kind ?? ''}`) },
      { key: 'valueMinor', label: both('reqAmount'), sort: 'number', align: 'end', value: (r) => (typeof r.valueMinor === 'number' ? api.rupees(r.valueMinor) : null) },
      { key: 'reason', label: both('reason') },
      { key: 'status', label: both('reqStatus'), value: statusWords, render: (r) => o.recordChip(r.status === 'waiting' ? 'waiting' : r.status === 'approved' ? 'approved' : r.status === 'rejected' ? 'rejected' : r.status === 'used' ? 'done' : r.status === 'expired' ? 'expired' : r.status, statusWords(r)) },
      { key: 'decider', label: both('reqDecider'), value: decider },
      { key: 'give', label: both('giveNow'), sort: false, render: (r) => {
        if (r.status !== 'approved' || !may.manage) return null;
        const b = document.createElement('button'); b.type = 'button'; b.className = 'sre-btn'; b.dataset.giveApproved = r.requestId; b.textContent = t('giveNow');
        b.addEventListener('click', () => { void giveApproved(r); }); return b;
      } },
    ],
  });
}

/** The form's shared fields, built once the chrome is there (the page keeps no field CSS of its own). */
function buildForm() {
  if (api === null) return;
  const o = office();
  if (o === null || fields !== null || typeof o.field !== 'function') return;
  const host = $('give-fields');
  fields = {
    kind: o.field({ id: 'g-kind', label: both('kind'), type: 'select', required: true, options: api.kinds.map((k) => ({ value: k, label: t(`kind_${k}`) })) }),
    rupees: o.field({ id: 'g-rupees', label: both('rupees'), type: 'text', required: true, inputmode: 'decimal' }),
    reason: o.field({ id: 'g-reason', label: both('why'), type: 'text', required: true }),
  };
  host.replaceChildren(fields.kind, fields.rupees, fields.reason);
  for (const id of ['g-kind', 'g-rupees', 'g-reason']) $(id)?.addEventListener('input', paintRoute);
  $('g-kind')?.addEventListener('change', paintRoute);
}

const typed = () => ({ kind: $('g-kind')?.value ?? '', rupees: $('g-rupees')?.value ?? '', reason: $('g-reason')?.value ?? '' });

/** The route the typed figures take, said BEFORE the press: give, ask, or over the ceiling — and the button's word follows. */
function paintRoute() {
  if (limits === null) { $('g-route').textContent = ''; return; }
  const plan = api.plan(typed(), limits);
  const btn = $('g-give');
  if (plan.result !== 'ok') {
    $('g-route').textContent = plan.why === 'overCeiling' ? t('routeOver') : '';
    $('g-give-text').textContent = t('give');
    btn.disabled = plan.why === 'overCeiling';
    whyDisabled(btn, plan.why === 'overCeiling' ? both('overCeiling') : '');
    return;
  }
  btn.disabled = false; whyDisabled(btn, '');
  $('g-route').textContent = plan.value.route === 'give' ? t('routeGive') : t('routeAsk');
  $('g-give-text').textContent = plan.value.route === 'give' ? t('give') : t('ask');
}

function paint() {
  if (api === null) { $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English'; paintOff(); return; }
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  document.title = `SRE ${t('title')}`;
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['limits-h', 'limitsH'], ['cases-h', 'casesH'], ['cases-lead', 'casesLead'], ['given-h', 'givenH'], ['asked-h', 'askedH'], ['form-h', 'formH'],
    ['g-back-text', 'back'], ['back-text', 'back'], ['english-note', 'headOfficeEnglish']]) { const n = $(id); if (n) n.textContent = t(key); }
  $('case-h').textContent = picked === null ? t('caseH') : `${t('caseH')} ${picked.caseId}`;
  if (fields !== null) {
    const o = office();
    for (const [k, id] of [['kind', 'g-kind'], ['rupees', 'g-rupees'], ['reason', 'g-reason']]) { const lab = $(id)?.closest('.sre-field')?.querySelector('.sre-field-label'); if (lab) lab.textContent = t(k === 'kind' ? 'kind' : k === 'rupees' ? 'rupees' : 'why'); }
    for (const opt of $('g-kind')?.options ?? []) opt.textContent = t(`kind_${opt.value}`);
    if (o !== null) paintRoute();
  }
  paintLimits(); paintCases(); paintGiven(); paintAsked();
}

async function loadLimits() { const out = await session.limits(); if (out.result === 'ok') { limits = out.value; limitsOutcome = null; } else { limits = null; limitsOutcome = out; } paintLimits(); paintRoute(); }
async function loadCases() {
  const out = await session.cases();
  if (out.result === 'ok') { cases = out.value; casesOutcome = null; } else { cases = null; casesOutcome = out; }
  paintCases();
  if (picked === null && caseWanted !== '' && cases !== null) { const c = cases.find((x) => x.caseId === caseWanted); if (c !== undefined) await choose(c); }
}
async function loadCase() {
  if (picked === null) return;
  const [g, a] = await Promise.all([session.given(picked.caseId), may.manage ? session.requests(picked.caseId) : Promise.resolve({ result: 'ok', value: [] })]);
  if (g.result === 'ok') { given = g.value; givenOutcome = null; } else { given = null; givenOutcome = g; }
  if (a.result === 'ok') { asked = a.value; askedOutcome = null; } else { asked = null; askedOutcome = a; }
  paintGiven(); paintAsked();
}
async function choose(c) {
  picked = c; given = null; givenOutcome = null; asked = null; askedOutcome = null;
  $('case').hidden = false; $('give-form').hidden = !may.manage; $('back').hidden = may.manage;
  $('g-status').textContent = '';
  paint();
  $('case').scrollIntoView({ block: 'start' });
  await loadCase();
}
function unchoose() { picked = null; $('case').hidden = true; paint(); $('cases').scrollIntoView({ block: 'start' }); }

const sheet = (kind, amountMinor, caseId, mode, approvedBy) => {
  const values = { amount: api.rupees(amountMinor), kind: '', case: caseId, limit: api.rupees(limits?.ownAuthorityMinor ?? 0), who: approvedBy ?? '' };
  const pair = (k) => ({ en: fillIn(api.words('en', k), { ...values, kind: api.words('en', `kind_${kind}`) }), ta: fillIn(api.words('ta', k), { ...values, kind: api.words('ta', `kind_${kind}`) }) });
  return mode === 'ask'
    ? { title: pair('confirmAsk'), detail: pair('confirmAskDetail'), authority: pair('authorityAsk'), confirmLabel: both('ask'), tone: 'primary' }
    : { title: pair('confirmGive'), detail: pair('confirmGiveDetail'), authority: approvedBy === undefined ? pair('authorityGive') : pair('authorityApproved'), confirmLabel: both('give'), tone: 'primary' };
};

/** The one press: within the limit GIVE (confirm first); above it ASK a second person (confirm first); over the ceiling nothing. */
async function submit(event) {
  event.preventDefault();
  if (picked === null || limits === null) { $('g-status').textContent = t('needCase'); return; }
  const plan = api.plan(typed(), limits);
  if (plan.result !== 'ok') { $('g-status').textContent = api.outcomeWords(lang, plan); return; }
  const { amountMinor, route } = plan.value; const { kind, reason } = typed();
  if (!(await (await chrome()).confirm(sheet(kind, amountMinor, picked.caseId, route))).ok) return;
  $('g-status').textContent = t('reading');
  if (route === 'give') {
    const out = await session.give(picked.caseId, { kind, amountMinor, reason });
    if (out.result !== 'ok') { $('g-status').textContent = api.outcomeWords(lang, out); return; }
    $('g-status').textContent = t('given'); $('g-status').dataset.outcome = 'given';
  } else {
    const out = await session.ask(picked.caseId, { kind, amountMinor, reason });
    if (out.result !== 'ok') { $('g-status').textContent = api.outcomeWords(lang, out); return; }
    const who = out.value.decider === undefined ? t('anyApprover') : out.value.decider.named ? (out.value.decider.displayName ?? '') : t('nobodyNamed');
    $('g-status').textContent = fillIn(t('asked'), { who }); $('g-status').dataset.outcome = 'asked';
  }
  $('g-rupees').value = ''; $('g-reason').value = ''; paintRoute();
  await loadCase();
}

/** An approved request: give exactly what was approved, with its approval, after the confirm sheet names the approver. */
async function giveApproved(r) {
  if (picked === null) return;
  const d = r.details ?? {};
  const approvedBy = r.decidedBy === undefined ? '' : (office()?.nameOf?.('person', r.decidedBy) ?? r.decidedBy);
  if (!(await (await chrome()).confirm(sheet(d.kind, Number(d.amountMinor), picked.caseId, 'give', approvedBy))).ok) return;
  $('g-status').textContent = t('reading');
  const out = await session.give(picked.caseId, { kind: String(d.kind ?? ''), amountMinor: Number(d.amountMinor), reason: String(d.reason ?? ''), approvalId: r.requestId });
  if (out.result !== 'ok') { $('g-status').textContent = api.outcomeWords(lang, out); return; }
  $('g-status').textContent = t('given'); $('g-status').dataset.outcome = 'given';
  await loadCase();
}

for (const [id, name] of [['g-give', 'badge-check'], ['g-back', 'rotate-ccw'], ['back', 'rotate-ccw']]) { const i = icon(name); if (i !== null) $(id).prepend(i); }
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
$('give-form').addEventListener('submit', (e) => { void submit(e); });
$('g-back').addEventListener('click', unchoose); $('back').addEventListener('click', unchoose);
paint();
if (api === null) { paintOff(); document.addEventListener('sre:chrome', paintOff); }
else if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.read) $('page-status').textContent = t('cannotRead');
else {
  $('limits').hidden = false; $('cases').hidden = false;
  if (!may.manage) $('page-status').textContent = t('cannotManage');
  void loadLimits(); void loadCases();
}
