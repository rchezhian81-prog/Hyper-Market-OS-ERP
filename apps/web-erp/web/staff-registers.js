// W5 (C18 · OB-156 · P-08) — record a day of leave and read the three statutory registers (attendance, leave, holidays), a
// section of the Staff list page. The session (apps/web-erp/src/working-time-session.ts, in the bundle as
// window.workingTime) does every call and every rule; this file lays out what it is told. A day of leave is a new record —
// cancelling one is another record, never an edit (hard rule #2). A rostered day with no attendance is shown as such, never
// assumed present or absent; a leave rule not set yet says NOT CHECKED. Every word has a Tamil twin.

const $ = (id) => document.getElementById(id);
const api = window.workingTime ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, rosterManage: false, registers: false };
const lang = () => (document.documentElement.lang === 'ta' ? 'ta' : 'en');
const t = (k) => (api === null ? k : api.words(lang(), k));
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
function el(tag, attrs = {}, ...kids) { const n = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'text') n.textContent = v; else if (k === 'cls') n.className = v; else n.setAttribute(k, v); } n.append(...kids); return n; }
function btn(id, words, iconName) { const b = el('button', { type: 'button', id }); const i = icon(iconName); if (i !== null) b.append(i); b.append(el('span', { text: words })); return b; }
function field(id, words, attrs = {}) { const tag = attrs.tag ?? 'input'; const a = { ...attrs }; delete a.tag; return el('label', { for: id }, el('span', { text: words }), el(tag, { id, autocomplete: 'off', ...a })); }
function select(id, words, options) { const s = el('select', { id }); for (const [v, w] of options) s.append(el('option', { value: v, text: w })); return el('label', { for: id }, el('span', { text: words }), s); }
const statusLine = (id) => el('p', { id, cls: 'status', role: 'status', 'aria-live': 'polite' });
const val = (id) => $(id)?.value ?? '';
const say = (id, out, okWords = '') => { $(id).textContent = out.result === 'ok' ? okWords : api.outcomeWords(lang(), out); };

let leaveDone = null; let reg = null; let which = 'attendance';

function leaveWords(r) {
  const l = r.leave ?? {};
  const check = r.check === 'checked' ? `${t('checked')}${r.balanceAfter !== undefined ? ` · ${r.balanceAfter} ${t('balanceAfter')}` : ''}` : `${t('notChecked')}${r.notCheckedBecause ? ` — ${r.notCheckedBecause}` : ''}`;
  return `${l.employeeId} · ${l.date} · ${t(l.leaveType ?? 'annual')} · ${l.kind === 'cancelled' ? t('cancelled') : t('taken')} · ${check}`;
}

function registerNode() {
  if (reg === null) return el('div', { id: 'hr-reg-out' });
  const box = el('div', { id: 'hr-reg-out', cls: 'wide', 'data-register': reg.register });
  if (reg.register === 'attendance') {
    const tb = el('table', { cls: 'reg' }, el('tr', {}, ...['employee', 'present', 'hours', 'notRecorded'].map((k) => el('th', { text: t(k) }))));
    for (const r of reg.rows ?? []) tb.append(el('tr', { 'data-employee': r.employeeId }, el('td', { text: `${r.employeeId} · ${r.name}` }), el('td', { text: String(r.daysPresent) }), el('td', { text: String(r.hoursTotal) }), el('td', { text: String(r.daysNotRecorded) })));
    box.append(tb);
  } else if (reg.register === 'leave') {
    const tb = el('table', { cls: 'reg' }, el('tr', {}, ...['employee', 'annual', 'earned', 'takenDays', 'balance'].map((k) => el('th', { text: t(k) }))));
    for (const r of reg.rows ?? []) {
      tb.append(el('tr', { 'data-employee': r.employeeId }, el('td', { text: `${r.employeeId} · ${r.name}` }), el('td', { text: r.accrual === 'in_force' ? t('inForce') : t('pending') }),
        el('td', { text: r.earned === null ? t('pending') : String(r.earned) }), el('td', { text: String(r.taken) }), el('td', { text: r.balance === null ? t('pending') : String(r.balance) })));
      for (const o of r.otherLeave ?? []) if (o.taken > 0) tb.append(el('tr', { 'data-employee': r.employeeId, 'data-type': o.type }, el('td', { text: '' }), el('td', { text: o.label }), el('td', { text: o.check === 'checked' ? String(o.entitlement) : t('notChecked') }), el('td', { text: String(o.taken) }), el('td', { text: o.balance === null ? '—' : String(o.balance) })));
    }
    box.append(tb);
  } else {
    const ul = el('ul', { cls: 'rows' });
    for (const p of reg.people ?? []) {
      const weeks = (p.weeks ?? []).map((w) => `${w.weekStart}: ${w.daysOff.length} ${t('daysOff')} · ${t('weeklyHoliday')} ${w.weeklyHolidayGiven === null ? t('notJudged') : w.weeklyHolidayGiven ? t('given') : t('notGiven')}`);
      ul.append(el('li', { 'data-employee': p.employeeId, 'data-state': (p.weeks ?? []).some((w) => w.weeklyHolidayGiven === false) ? 'breach' : '' }, el('strong', { text: `${p.employeeId} · ${p.name}` }), ...weeks.map((w) => el('span', { cls: 'meta', text: w }))));
    }
    for (const h of reg.publicHolidays ?? []) ul.append(el('li', { 'data-holiday': h.date }, el('strong', { text: `${h.date} · ${h.name}` }), el('span', { cls: 'meta', text: `${t('workedBy')}: ${h.workedBy.length === 0 ? t('nobodyWorked') : h.workedBy.join(', ')}` })));
    box.append(ul);
  }
  for (const n of reg.limitsNotChecked ?? []) box.append(el('p', { cls: 'meta', text: `${t('notCheckedList')} ${n.label} — ${n.missing}` }));
  for (const n of reg.leaveTypesNotChecked ?? []) box.append(el('p', { cls: 'meta', text: `${t('notCheckedList')} ${n.label} — ${n.missing}` }));
  if (reg.format) box.append(el('p', { cls: 'meta', text: typeof reg.format === 'string' ? reg.format : '' }));
  return box;
}

function paint() {
  const typed = {}; for (const n of $('hr-registers').querySelectorAll('input, select, textarea')) typed[n.id] = n.value;
  const root = $('hr-registers'); root.replaceChildren();
  if (may.rosterManage) {
    root.append(el('h3', { id: 'hr-leave-h', text: t('leaveH') }), el('div', { cls: 'row-form' },
      field('hr-lv-emp', t('employee')), field('hr-lv-date', t('date'), { type: 'date' }),
      select('hr-lv-type', t('leaveType'), api.leaveKinds.map((k) => [k, t(k)])), select('hr-lv-kind', t('kind'), [['taken', t('taken')], ['cancelled', t('cancelled')]]),
      field('hr-lv-note', t('note')), btn('hr-lv-save', t('recordLeave'), 'calendar-check')), statusLine('hr-lv-status'));
    if (leaveDone !== null) root.append(el('p', { cls: 'meta', id: 'hr-lv-done', text: leaveWords(leaveDone) }));
  }
  if (may.registers) {
    root.append(el('h3', { id: may.rosterManage ? 'hr-reg-h' : 'hr-leave-h', text: t('registersH') }), el('div', { cls: 'row-form' },
      select('hr-reg-which', t('register'), [['attendance', t('attendance')], ['leave', t('leave')], ['holidays', t('holidays')]]),
      field('hr-reg-from', t('from'), { type: 'date' }), field('hr-reg-to', t('to'), { type: 'date' }), field('hr-reg-asof', t('asOf'), { type: 'date' }), field('hr-reg-store', t('store')),
      btn('hr-reg-show', t('show'), 'clipboard-list')), statusLine('hr-reg-status'), registerNode());
  }
  for (const [id, v] of Object.entries(typed)) { const n = $(id); if (n !== null) n.value = v; }
  if ($('hr-reg-which') !== null && typed['hr-reg-which'] === undefined) $('hr-reg-which').value = which;
  wire();
}

function wire() {
  const on = (id, f) => { const b = $(id); if (b !== null) b.addEventListener('click', f); };
  on('hr-lv-save', async () => {
    const out = await session.recordLeave(val('hr-lv-emp'), val('hr-lv-date'), { kind: val('hr-lv-kind') === 'cancelled' ? 'cancelled' : 'taken', leaveType: val('hr-lv-type'), note: val('hr-lv-note') });
    if (out.result === 'ok') { leaveDone = out.value; paint(); }
    say('hr-lv-status', out, t('saved'));
  });
  on('hr-reg-show', async () => {
    which = val('hr-reg-which');
    $('hr-reg-status').textContent = t('reading');
    const out = await session.register(which, { from: val('hr-reg-from'), to: val('hr-reg-to'), asOf: val('hr-reg-asof'), branchId: val('hr-reg-store') });
    reg = out.result === 'ok' ? out.value : null; paint(); say('hr-reg-status', out);
  });
}

if (api !== null && $('hr-registers') !== null && may.named && (may.rosterManage || may.registers)) {
  $('hr-registers').hidden = false;
  $('lang').addEventListener('click', () => { paint(); });
  paint();
}
