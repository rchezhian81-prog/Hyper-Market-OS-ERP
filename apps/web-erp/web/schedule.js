// Staff schedule — the page over head office's D-9 routes (OB-142 "A", OB-181). The session (apps/web-erp/src/schedule-
// session.ts, in the bundle as window.schedule) asks head office; this page only shows its answers: staff needed per hour,
// the draft roster with every uncovered slot and breach by name, the Shops Act limits (a limit the CA has not filled is
// shown as not checked, never given a number), the labour cost reported and never capped, a manager's commit, and actual
// attendance against the roster. Nothing is written on open. Every word has a Tamil twin.

const $ = (id) => document.getElementById(id);
const api = window.schedule ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, draft: false, commit: false };

let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
let demand = null;
let draft = null;
let actuals = null;
const two = (n) => String(n).padStart(2, '0');

function li(text, attrs = {}) { const el = document.createElement('li'); el.className = 'row'; el.textContent = text; for (const [k, v] of Object.entries(attrs)) el.dataset[k] = v; return el; }
function row(cells, attrs = {}) {
  const tr = document.createElement('tr');
  for (const c of cells) { const td = document.createElement('td'); td.textContent = c; tr.append(td); }
  for (const [k, v] of Object.entries(attrs)) tr.dataset[k] = v;
  return tr;
}
function say(id, out, good) { $(id).className = `status ${good ? 'good' : 'err'}`; $(id).textContent = good ? out : api.outcomeWords(lang, out); }

function paint() {
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title-text', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['l-branch', 'branch'], ['l-week', 'week'], ['show', 'show'], ['draft', 'draft'], ['actuals', 'actuals'],
    ['limits-h', 'limitsH'], ['demand-h', 'demandH'], ['draft-h', 'draftH'], ['uncovered-h', 'uncoveredH'], ['breaches-h', 'breachesH'], ['cost-h', 'costH'], ['commit', 'commit'], ['actuals-h', 'actualsH']]) $(id).textContent = t(k);
  $('lang').textContent = t('lang');
  $('whoami').textContent = window.scheduleData?.userId ?? '';
  $('nobody').hidden = may.named; $('nobody').textContent = t('nobody');
  $('draft').disabled = !may.draft; $('commit').disabled = !may.commit || draft === null || draft.committedBy !== null;

  const limits = demand?.workingTime?.limits ?? [];
  $('all-pending').hidden = !(demand?.workingTime?.allPending); $('all-pending').textContent = t('allPending');
  $('limits').replaceChildren(...limits.map((l) => li(`${l.label} — ${l.status === 'in_force' ? `${t('inForce')}: ${l.value}` : `${t('pending')} (${l.missing ?? ''})`}`, { key: l.key, status: l.status })));

  $('hours').replaceChildren(...Object.entries(demand?.staffHoursByRole ?? {}).map(([role, h]) => {
    const p = document.createElement('div'); p.className = 'panel'; p.dataset.role = role;
    const k = document.createElement('span'); k.className = 'k'; k.textContent = role;
    const v = document.createElement('span'); v.className = 'v'; v.textContent = `${h} ${t('staffHours')}`;
    p.append(k, v); return p;
  }));
  const notSet = demand?.rolesNotForecast ?? [];
  $('not-set').hidden = notSet.length === 0; $('not-set').textContent = `${t('notSet')} ${notSet.map((r) => r.role).join(', ')}`;
  $('demand-rows').replaceChildren(...(demand?.slots ?? []).map((s) => row([s.date, `${two(s.hour)}:00–${two(s.hour + 1)}:00`, s.role, String(s.staffNeeded)], { date: s.date, hour: String(s.hour), role: s.role })));

  $('draft-section').hidden = draft === null;
  if (draft !== null) {
    const d = draft.draft;
    $('draft-state').textContent = draft.committedBy === null ? t('drafted') : `${t('committed')} ${draft.committedBy}`;
    const who = new Map(d.assignments.map((a) => [a.shiftId, a.employeeId]));
    $('draft-rows').replaceChildren(...d.shifts.map((s) => row([s.date, `${two(s.startHour)}:00–${two(s.endHour)}:00`, s.role, who.get(s.shiftId) ?? '—'], { shift: s.shiftId, employee: who.get(s.shiftId) ?? '' })));
    $('uncovered').replaceChildren(...(d.uncovered.length === 0 ? [li(t('noneUncovered'), { none: 'true' })] : d.uncovered.map((u) => li(u.detail, { uncovered: u.shiftId, reason: u.reason }))));
    $('breaches').replaceChildren(...(d.breaches.length === 0 ? [li(t('noneBreaches'), { none: 'true' })] : d.breaches.map((b) => li(b.detail, { breach: b.rule }))));
    $('cost').replaceChildren(...d.cost.lines.map((c) => li(`${c.name} (${c.employeeId}) — ${c.minutes} ${t('minutes')} — ${c.costMinor === null ? t('notCosted') : api.rupees(c.costMinor)}`, { employee: c.employeeId, costed: String(c.costMinor !== null) })));
  }
  $('actuals-section').hidden = actuals === null;
  $('actual-rows').replaceChildren(...(actuals?.rows ?? []).map((r) => row([r.employeeId, r.date, `${t('rostered')} ${r.rosteredMinutes} ${t('minutes')}`, r.actualMinutes === null ? t('not_recorded') : `${t('actual')} ${r.actualMinutes} ${t('minutes')}`, t(r.status)], { employee: r.employeeId, date: r.date, status: r.status })));
}

const branch = () => $('branch').value;
const week = () => $('week').value;
async function show(event) {
  event?.preventDefault();
  const out = await session.demand(branch(), week());
  if (out.result === 'ok') { demand = out.value; $('page-status').className = 'status'; $('page-status').textContent = ''; } else { demand = null; say('page-status', out, false); }
  paint();
}
async function makeDraft() {
  const out = await session.draft(branch(), week());
  if (out.result === 'ok') { draft = out.value.draft; say('page-status', t('drafted'), true); if (demand === null) await show(); } else say('page-status', out, false);
  paint();
}
async function commit() {
  if (draft === null) return;
  const out = await session.commit(draft.draftId);
  if (out.result === 'ok') { draft = out.value.draft; say('commit-status', `${t('committed')} ${draft.committedBy}`, true); } else say('commit-status', out, false);
  paint();
}
async function showActuals() {
  const out = await session.actuals(branch(), week());
  if (out.result === 'ok') actuals = out.value; else { actuals = null; say('page-status', out, false); }
  paint();
}

$('ask').addEventListener('submit', (e) => { void show(e); });
$('draft').addEventListener('click', () => { void makeDraft(); });
$('commit').addEventListener('click', () => { void commit(); });
$('actuals').addEventListener('click', () => { void showActuals(); });
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (may.named && !may.read) { $('page-status').className = 'status err'; $('page-status').textContent = t('cannotRead'); $('show').disabled = true; }

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}
