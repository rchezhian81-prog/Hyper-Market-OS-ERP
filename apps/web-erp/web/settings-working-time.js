// W5 (C18 · OB-152 · OB-155 · OB-156 · OB-181) — the working-time limits, leave types and declared public holidays, a
// section of the Settings page. The session (apps/web-erp/src/working-time-session.ts, in the bundle as window.workingTime)
// does every call and every rule; this file lays out what it is told. A limit nobody has filled shows "not set" — never a
// default. Only the owner fills them (hr.compliance.configure); a store manager sees them. Every word has a Tamil twin.

const $ = (id) => document.getElementById(id);
const api = window.workingTime ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, configure: false };
const lang = () => (document.documentElement.lang === 'ta' ? 'ta' : 'en');
const t = (k) => (api === null ? k : api.words(lang(), k));
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
function el(tag, attrs = {}, ...kids) { const n = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'text') n.textContent = v; else if (k === 'cls') n.className = v; else n.setAttribute(k, v); } n.append(...kids); return n; }
function btn(id, words, iconName) { const b = el('button', { type: 'button', id }); const i = icon(iconName); if (i !== null) b.append(i); b.append(el('span', { text: words })); return b; }
function field(id, words, attrs = {}) { const tag = attrs.tag ?? 'input'; const a = { ...attrs }; delete a.tag; return el('label', { for: id }, el('span', { text: words }), el(tag, { id, autocomplete: 'off', ...a })); }
const statusLine = (id) => el('p', { id, cls: 'status', role: 'status', 'aria-live': 'polite' });
const val = (id) => $(id)?.value ?? '';
const say = (id, out, okWords = '') => { $(id).textContent = out.result === 'ok' ? okWords : api.outcomeWords(lang(), out); };

let wt = null;

function paint() {
  const typed = {}; for (const n of $('working-time').querySelectorAll('input, select, textarea')) typed[n.id] = n.value;
  const root = $('working-time');
  root.replaceChildren(el('h2', { id: 'wt-h', text: t('wtH') }), el('p', { cls: 'meta', text: t('wtLead') }), statusLine('wt-status'));
  if (wt !== null) {
    const limits = el('ul', { cls: 'rows', id: 'wt-limits' });
    for (const l of wt.limits ?? []) limits.append(el('li', { 'data-limit': l.key, 'data-state': l.status }, el('strong', { text: l.label }), el('span', { cls: 'meta', text: l.status === 'in_force' ? `${l.value} ${l.unit} · ${t('inForce')}` : `${t('pending')}${l.missing ? ` — ${l.missing}` : ''}` })));
    root.append(limits, el('p', { cls: 'meta', id: 'wt-week', text: `${t('rosterWeek')}: ${wt.rosterWeek?.words ?? ''}` }));
    const leave = el('ul', { cls: 'rows', id: 'wt-leave' });
    for (const l of wt.leaveTypes ?? []) leave.append(el('li', { 'data-leave': l.key, 'data-state': l.status }, el('strong', { text: l.label }), el('span', { cls: 'meta', text: l.status === 'in_force' ? `${l.daysPerYear} · ${t('carryOver')} ${l.carryOverMaxDays} · ${t('inForce')}` : `${t('pending')}${l.missing ? ` — ${l.missing}` : ''}` })));
    root.append(el('h3', { text: t('leaveTypesH') }), leave);
    const hol = wt.publicHolidays ?? { dates: [], status: 'pending' };
    const hl = el('ul', { cls: 'rows', id: 'wt-holidays', 'data-state': hol.status });
    for (const d of hol.dates ?? []) hl.append(el('li', { text: `${d.date} · ${d.name}` }));
    root.append(el('h3', { text: `${t('holidaysH')} · ${hol.status === 'in_force' ? t('inForce') : t('pending')}` }), hl);
  }
  if (may.configure && wt !== null) {
    const pick = el('select', { id: 'wt-key' }); for (const l of wt.limits ?? []) pick.append(el('option', { value: l.key, text: l.label }));
    root.append(el('h3', { text: t('limit') }), el('div', { cls: 'row-form' }, el('label', { for: 'wt-key' }, el('span', { text: t('limit') }), pick), field('wt-value', t('value'), { inputmode: 'numeric' }), field('wt-source', t('source')), field('wt-conf', t('confirmation')), btn('wt-save', t('save'), 'check')), statusLine('wt-save-status'));
    const lt = el('select', { id: 'wt-lt' }); for (const k of api.leaveTypes) lt.append(el('option', { value: k, text: t(k) }));
    root.append(el('h3', { text: t('leaveTypesH') }), el('div', { cls: 'row-form' }, el('label', { for: 'wt-lt' }, el('span', { text: t('leaveType') }), lt), field('wt-lt-days', t('daysPerYear'), { inputmode: 'numeric' }), field('wt-lt-carry', t('carryOver'), { inputmode: 'numeric' }), field('wt-lt-source', t('source')), field('wt-lt-conf', t('confirmation')), btn('wt-lt-save', t('save'), 'check')), statusLine('wt-lt-status'));
    root.append(el('h3', { text: t('holidaysH') }), el('div', { cls: 'row-form' }, field('wt-hol', t('holidaysHelp'), { tag: 'textarea', rows: '4' }), field('wt-hol-source', t('source')), field('wt-hol-conf', t('confirmation')), btn('wt-hol-save', t('save'), 'calendar-days')), statusLine('wt-hol-status'));
  }
  for (const [id, v] of Object.entries(typed)) { const n = $(id); if (n !== null) n.value = v; }
  wire();
}

async function load() {
  $('wt-status').textContent = t('reading');
  const out = await session.settings();
  wt = out.result === 'ok' ? out.value : null;
  paint(); say('wt-status', out);
}

function wire() {
  const on = (id, f) => { const b = $(id); if (b !== null) b.addEventListener('click', f); };
  const after = async (id, out) => { if (out.result === 'ok') { await load(); } say(id, out, t('saved')); };
  on('wt-save', async () => after('wt-save-status', await session.setLimit(val('wt-key'), { value: val('wt-value'), source: val('wt-source'), confirmation: val('wt-conf') })));
  on('wt-lt-save', async () => after('wt-lt-status', await session.setLeaveType(val('wt-lt'), { daysPerYear: val('wt-lt-days'), carryOverMaxDays: val('wt-lt-carry'), source: val('wt-lt-source'), confirmation: val('wt-lt-conf') })));
  on('wt-hol-save', async () => after('wt-hol-status', await session.setHolidays({ lines: val('wt-hol'), source: val('wt-hol-source'), confirmation: val('wt-hol-conf') })));
}

if (api !== null && $('working-time') !== null && may.named && may.read) {
  $('working-time').hidden = false;
  $('lang').addEventListener('click', () => { paint(); });
  paint();
  void load();
}
