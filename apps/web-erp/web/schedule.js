// Staff schedule — the page over head office's D-9 routes (OB-142 "A", OB-181). The session (apps/web-erp/src/schedule-
// session.ts, in the bundle as window.schedule) asks head office; this page only shows its answers: staff needed per hour,
// the draft roster with every uncovered slot and breach by name, the Shops Act limits (a limit the CA has not filled is
// shown as not checked, never given a number), the labour cost reported and never capped, a manager's commit, and actual
// attendance against the roster. Nothing is written on open. Every word has a Tamil twin.

const $ = (id) => document.getElementById(id);
// ── U2b (UI/UX gap audit G5 · G14 · P-07): a thing is PICKED by name through the chrome's picker, never typed as a code,
// and a date is written as the shop writes it (dd/mm/yyyy) through the chrome's shared field. The field keeps the id the
// page sends (the typed code stays possible when the list cannot be read — head office down, no right — so the form is
// never a dead end, P-01 · P-08); the chrome's sheet finds the thing by name, code or barcode and the name is shown beside
// the field. Mounted when the chrome is there (a page that paints first listens for `sre:chrome`); off the box nothing
// changes. The same six-line pattern as the U2 pages (store-tasks, delegation, floor-heat-map).
const u2bWords = Object.freeze({ en: { choose: 'Choose…', pickProduct: 'Which product?', pickPlace: 'Which place in the store?', pickPerson: 'Which person?', pickStore: 'Which store?', pickCustomer: 'Which customer?', pickApproval: 'Which approval?', pickSupplier: 'Which supplier?', yourStore: 'your store' }, ta: { choose: 'தேர்ந்தெடு…', pickProduct: 'எந்தப் பொருள்?', pickPlace: 'கடையில் எந்த இடம்?', pickPerson: 'எந்த நபர்?', pickStore: 'எந்தக் கடை?', pickCustomer: 'எந்த வாடிக்கையாளர்?', pickApproval: 'எந்த அனுமதி?', pickSupplier: 'எந்த விநியோகஸ்தர்?', yourStore: 'உங்கள் கடை' } }); // one line on purpose: a page's own word tables start a line with `en: {`
const u2bLang = () => (document.documentElement.lang === 'ta' ? 'ta' : 'en');
const u2bWord = (k) => u2bWords[u2bLang()][k] ?? u2bWords.en[k];
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
// The signed-in person's own store filled in (changeable), its NAME said beside the field; nothing filled off the box.
const ownStores = new Set();
function ownStore(inputId) {
  ownStores.add(inputId);
  const me = window.sreOffice?.me?.() ?? null;
  const input = document.getElementById(inputId);
  if (me === null || !me.storeId || input === null) return;
  if (input.value.trim() === '') input.value = me.storeId;
  let note = document.getElementById(`${inputId}-own`);
  if (note === null) { note = document.createElement('small'); note.id = `${inputId}-own`; note.className = 'sre-why own-store'; (input.closest('.pick-row') ?? input).after(note); }
  note.textContent = `${me.storeName ?? me.storeId} — ${u2bWord('yourStore')}`;
}
// the pickers' words and the shared fields' labels follow the language toggle like the page's own words
new MutationObserver(() => { repaintPickers(); if (typeof repaintShopDates === 'function') repaintShopDates(); if (typeof ownStores !== 'undefined') for (const id of ownStores) ownStore(id); }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
// ── U2b end
const api = window.schedule ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, draft: false, commit: false };

let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));

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
let demand = null;
let draft = null;
let actuals = null;
const two = (n) => String(n).padStart(2, '0');

function li(text, attrs = {}) { const el = document.createElement('li'); el.className = 'row'; el.textContent = text; for (const [k, v] of Object.entries(attrs)) el.dataset[k] = v; return el; }
const STATUS_STATE = { as_rostered: 'ok', short: 'error', absent: 'error', over: 'warning', worked_unrostered: 'warning', not_recorded: 'unknown' };
function say(id, out, good) { $(id).className = `status ${good ? 'good' : 'err'}`; $(id).textContent = good ? out : api.outcomeWords(lang, out); }

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
const recordChip = (state, label) => { const o = window.sreOffice; if (o && typeof o.recordChip === 'function') return o.recordChip(state, label); const s = document.createElement('span'); s.className = 'sre-chip'; s.textContent = typeof label === 'string' ? label : state; return s; };
const W = (k) => ({ en: wordsIn('en', k), ta: wordsIn('ta', k) });
const nameOf = (kind, id) => { const o = window.sreOffice; const key = id ?? ''; return o && typeof o.nameOf === 'function' && key !== '' ? (o.nameOf(kind, key) || key) : key; };

function paint() {
  repaintShopDates();
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title-text', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['l-branch', 'branch'], ['l-week', 'week'], ['show', 'show'], ['draft', 'draft'], ['actuals', 'actuals'],
    ['limits-h', 'limitsH'], ['demand-h', 'demandH'], ['draft-h', 'draftH'], ['uncovered-h', 'uncoveredH'], ['breaches-h', 'breachesH'], ['cost-h', 'costH'], ['commit', 'commit'], ['actuals-h', 'actualsH']]) { const n = $(id); if (n) n.textContent = t(k); }
  $('lang').textContent = t('lang');
  $('whoami').textContent = window.scheduleData?.userId ?? '';
  $('nobody').hidden = may.named; $('nobody').textContent = t('nobody');
  $('draft').disabled = !may.draft; $('commit').disabled = !may.commit || draft === null || draft.committedBy !== null;
  whyDisabled($('draft'), may.draft ? '' : 'role');
  whyDisabled($('commit'), !may.commit ? 'role' : draft === null ? { en: 'Draft the roster first.', ta: 'முதலில் அட்டவணையை வரைவு செய்யவும்.' } : draft.committedBy !== null ? { en: 'This roster is already committed.', ta: 'இந்த அட்டவணை ஏற்கனவே உறுதிசெய்யப்பட்டது.' } : '');

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
  // the staff needed per hour and role, as the register (nothing is read until the person presses Show — then it says so)
  register('demand-host', {
    id: 'demand', label: W('demandH'), bodyId: 'demand-rows', sortable: true, pageSize: 24, search: false,
    rowKey: (s) => `${s.date}:${s.hour}:${s.role}`, rowData: (s) => ({ date: s.date, hour: String(s.hour), role: s.role }),
    columns: [
      { key: 'date', label: W('colDate') },
      { key: 'hour', label: W('colHours'), sort: 'number', value: (s) => s.hour, render: (s) => document.createTextNode(`${two(s.hour)}:00–${two(s.hour + 1)}:00`) },
      { key: 'role', label: W('colRole'), filter: true },
      { key: 'staffNeeded', label: W('colStaffNeeded'), sort: 'number', align: 'end', value: (s) => s.staffNeeded },
    ],
    rows: demand === null ? null : (demand.slots ?? []),
    ...(demand === null ? { state: shown ? 'unknown' : 'empty', stateOpts: { title: W('notShownYet') } } : {}),
    empty: { title: W('noDemand') },
  });

  $('draft-section').hidden = draft === null;
  if (draft !== null) {
    const d = draft.draft;
    $('draft-state').textContent = draft.committedBy === null ? t('drafted') : `${t('committed')} ${draft.committedBy}`;
    const who = new Map(d.assignments.map((a) => [a.shiftId, a.employeeId]));
    register('draft-host', {
      id: 'draft', label: W('draftH'), bodyId: 'draft-rows', sortable: true, pageSize: 20,
      rowKey: (s) => s.shiftId, rowData: (s) => ({ shift: s.shiftId, employee: who.get(s.shiftId) ?? '' }),
      columns: [
        { key: 'date', label: W('colDate') },
        { key: 'startHour', label: W('colHours'), sort: 'number', value: (s) => s.startHour, render: (s) => document.createTextNode(`${two(s.startHour)}:00–${two(s.endHour)}:00`) },
        { key: 'role', label: W('colRole'), filter: true },
        { key: 'employee', label: W('colEmployee'), value: (s) => (who.has(s.shiftId) ? nameOf('person', who.get(s.shiftId)) : null) },
      ],
      rows: d.shifts, empty: { title: W('noShifts') },
    });
    $('uncovered').replaceChildren(...(d.uncovered.length === 0 ? [li(t('noneUncovered'), { none: 'true' })] : d.uncovered.map((u) => li(u.detail, { uncovered: u.shiftId, reason: u.reason }))));
    $('breaches').replaceChildren(...(d.breaches.length === 0 ? [li(t('noneBreaches'), { none: 'true' })] : d.breaches.map((b) => li(b.detail, { breach: b.rule }))));
    $('cost').replaceChildren(...d.cost.lines.map((c) => li(`${c.name} (${c.employeeId}) — ${c.minutes} ${t('minutes')} — ${c.costMinor === null ? t('notCosted') : api.rupees(c.costMinor)}`, { employee: c.employeeId, costed: String(c.costMinor !== null) })));
  }
  $('actuals-section').hidden = actuals === null;
  if (actuals !== null) {
    register('actual-host', {
      id: 'actuals', label: W('actualsH'), bodyId: 'actual-rows', sortable: true, pageSize: 20,
      rowKey: (r) => `${r.employeeId}:${r.date}`, rowData: (r) => ({ employee: r.employeeId, date: r.date, status: r.status }),
      columns: [
        { key: 'employeeId', label: W('colEmployee'), value: (r) => nameOf('person', r.employeeId) },
        { key: 'date', label: W('colDate') },
        { key: 'rosteredMinutes', label: W('rostered'), sort: 'number', value: (r) => r.rosteredMinutes, render: (r) => document.createTextNode(`${r.rosteredMinutes} ${t('minutes')}`) },
        { key: 'actualMinutes', label: W('actual'), sort: 'number', value: (r) => r.actualMinutes, render: (r) => document.createTextNode(r.actualMinutes === null ? t('not_recorded') : `${r.actualMinutes} ${t('minutes')}`) },
        // the day's outcome as the one chip: as rostered → ok, short / absent → error, over / worked unrostered → degraded, not recorded → unknown
        { key: 'status', label: W('colStatus'), filter: true, value: (r) => t(r.status), render: (r) => recordChip(STATUS_STATE[r.status] ?? 'unknown', t(r.status)) },
      ],
      rows: actuals.rows ?? [], empty: { title: W('noActuals') },
    });
  }
}

const branch = () => $('branch').value;
const week = () => dateOf('week');
let shown = false; // the person has pressed Show at least once — before that the register says what to do, not "loading"
async function show(event) {
  event?.preventDefault();
  shown = true;
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
  // OB-698 A (U1): the roster is committed only through the shared confirm sheet — the week, how many shifts and people.
  if (!window.sreOffice || typeof window.sreOffice.confirm !== 'function') { $('commit-status').className = 'status err'; $('commit-status').textContent = t('noChrome'); return; }
  const vars = { week: draft.weekStart, shifts: String(draft.draft.shifts.length), people: String(new Set(draft.draft.assignments.map((a) => a.employeeId)).size), uncovered: String(draft.draft.uncovered.length) };
  const said = (key) => ({ en: Object.entries(vars).reduce((acc, [k, v]) => acc.split(`{${k}}`).join(v), api.words('en', key)), ta: Object.entries(vars).reduce((acc, [k, v]) => acc.split(`{${k}}`).join(v), api.words('ta', key)) });
  const answer = await window.sreOffice.confirm({ title: said('confirmCommit'), detail: said('confirmCommitDetail'), authority: said('confirmCommitAuthority'), confirmLabel: said('commit'), tone: 'primary' });
  if (!answer.ok) { $('commit-status').className = 'status'; $('commit-status').textContent = t('notCommitted'); return; }
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

/** A greyed button says why (U1 · G3 · design system §4 "disabled state explains why"): the reason is the button's tooltip
 *  and the words beside it, in the reader's language. `why` is 'role' (your role may not), 'offline' (head office cannot
 *  be reached), a page's own { en, ta } pair or sentence; '' takes the words away. */
function whyWords() {
  return {
  role: { en: 'Your role may not do this.', ta: 'உங்கள் பங்குக்கு இதைச் செய்ய அனுமதி இல்லை.' },
  offline: { en: 'Head office cannot be reached, so this cannot be done now.', ta: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை, எனவே இப்போது இதைச் செய்ய முடியாது.' },
  };
}
function whyDisabled(btn, why) {
  const tongue = document.documentElement.lang === 'ta' ? 'ta' : 'en';
  const words = why === '' || why === undefined || why === null ? '' : typeof why === 'string' ? (whyWords()[why]?.[tongue] ?? why) : (why[tongue] ?? why.en);
  let note = btn.nextElementSibling;
  if (!(note && note.classList.contains('sre-why'))) {
    note = document.createElement('small'); note.className = 'sre-why';
    note.id = `${btn.id || `b${Math.random().toString(36).slice(2, 7)}`}-why`;
    btn.after(note);
  }
  note.textContent = words; note.hidden = words === '';
  if (words === '') { btn.removeAttribute('title'); btn.removeAttribute('aria-describedby'); } else { btn.title = words; btn.setAttribute('aria-describedby', note.id); }
}
// the chrome loads after this script: its shared date fields replace the plain ones once it is there
document.addEventListener('sre:chrome', () => { shopDate('week', { en: wordsIn('en', 'week'), ta: wordsIn('ta', 'week') }); paint(); }, { once: true });

// ── U2b (G5): the store is the person's own, said by name, and can be picked
pickable('branch', 'store', 'pickStore');
ownStore('branch');
document.addEventListener('sre:chrome', () => ownStore('branch'), { once: true });
