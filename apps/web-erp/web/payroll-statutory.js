// W5 (C15 · C16 · C19 · OB-208 · OB-209 · OB-228) — the statutory pay checks, a section of the Payroll page. The session
// (apps/web-erp/src/payroll-statutory-session.ts, in the bundle as window.payrollStatutory) does every call and every rule;
// this file lays out what it is told. COMPUTE AND SHOW ONLY: there is no issue, approve, lock or bank-file button here.
// Online-first like the rest of payroll: nothing is cached or kept in the browser; the CA's figures are read live as the
// page opens, everything else when a person presses a button. Every word has a Tamil twin.

const $ = (id) => document.getElementById(id);
const api = window.payrollStatutory ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, statutory: false, legalRead: false, legalSet: false };
const lang = () => (document.documentElement.lang === 'ta' ? 'ta' : 'en');
const t = (k) => (api === null ? k : api.words(lang(), k));
const money = (m) => (api === null ? String(m) : api.rupees(m));
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
function el(tag, attrs = {}, ...kids) { const n = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'text') n.textContent = v; else if (k === 'cls') n.className = v; else n.setAttribute(k, v); } n.append(...kids); return n; }
function btn(id, words, iconName, cls) { const b = el('button', { type: 'button', id, ...(cls ? { cls } : {}) }); const i = icon(iconName); if (i !== null) b.append(i); b.append(el('span', { text: words })); return b; }
function field(id, words, attrs = {}) { const tag = attrs.tag ?? 'input'; const a = { ...attrs }; delete a.tag; return el('label', { for: id }, el('span', { text: words }), el(tag, { id, autocomplete: 'off', ...a })); }
function statusLine(id) { return el('p', { id, cls: 'muted', role: 'status', 'aria-live': 'polite' }); }
const val = (id) => $(id)?.value ?? '';
const say = (id, out, okWords = '') => { $(id).textContent = out.result === 'ok' ? okWords : api.outcomeWords(lang(), out); };

let legal = null; let prepared = null; let check = null; let contrib = null; let late = null; let issued = null;

function legalNode() {
  const box = el('div', { id: 'ps-legal' }, el('h3', { text: t('legalH') }), el('p', { cls: 'lead', text: t('legalLead') }), statusLine('ps-legal-status'));
  const rows = el('div', { cls: 'depts', id: 'ps-figures' });
  if (legal !== null) {
    for (const f of legal.figures ?? []) rows.append(el('div', { cls: 'row', 'data-figure': f.key, 'data-state': f.status }, el('span', { text: f.label }), el('span', { text: f.status === 'confirmed' ? `${f.value} ${f.unit} · ${t('confirmed')}` : `${t('not_confirmed')}${f.missing ? ` — ${f.missing}` : ''}` })));
    box.append(rows, el('p', { cls: 'muted', text: t('overtimeFloor') }));
    const classes = el('div', { cls: 'depts', id: 'ps-classes' });
    if ((legal.minimumWages ?? []).length === 0) classes.append(el('div', { cls: 'row', text: t('noClasses') }));
    for (const c of legal.minimumWages ?? []) classes.append(el('div', { cls: 'row', 'data-class': c.classId, 'data-state': c.status }, el('span', { text: `${c.label} (${c.roles.join(', ')})` }), el('span', { text: `${money(c.monthlyMinor)} · ${t(c.status)}` })));
    box.append(el('h3', { text: t('minWageH') }), classes);
    const parts = el('div', { id: 'ps-particulars', cls: 'depts', 'data-state': legal.particulars?.status ?? 'not_confirmed' });
    const chosen = new Set(legal.particulars?.particulars ?? []);
    for (const p of legal.particulars?.catalogue ?? []) {
      const cb = el('input', { type: 'checkbox', id: `ps-part-${p.key}`, value: p.key }); cb.checked = chosen.has(p.key); cb.disabled = !may.legalSet;
      parts.append(el('label', { cls: 'row', for: `ps-part-${p.key}` }, el('span', { text: p.label ?? p.key }), cb));
    }
    box.append(el('h3', { text: `${t('particularsH')} · ${t(legal.particulars?.status ?? 'not_confirmed')}` }), parts);
  }
  if (may.legalSet && legal !== null) {
    const pick = el('select', { id: 'ps-fig-key' });
    for (const f of legal.figures ?? []) pick.append(el('option', { value: f.key, text: f.label }));
    box.append(el('div', { cls: 'actions' }, el('label', { for: 'ps-fig-key' }, el('span', { text: t('figure') }), pick), field('ps-fig-value', t('value'), { inputmode: 'numeric' }),
      field('ps-fig-source', t('source')), field('ps-fig-conf', t('confirmation')), btn('ps-fig-save', t('save'), 'check')), statusLine('ps-fig-status'));
    box.append(el('div', { cls: 'actions' }, field('ps-mw-id', t('classId')), field('ps-mw-label', t('classLabel')), field('ps-mw-roles', t('classRoles')), field('ps-mw-monthly', t('monthly'), { inputmode: 'decimal' }),
      field('ps-mw-source', t('source')), field('ps-mw-conf', t('confirmation')), btn('ps-mw-save', t('save'), 'check')), statusLine('ps-mw-status'));
    box.append(el('div', { cls: 'actions' }, field('ps-pt-source', t('source')), field('ps-pt-conf', t('confirmation')), btn('ps-pt-save', t('particularsSave'), 'check')), statusLine('ps-pt-status'));
  }
  return box;
}

function preparedNode() {
  const box = el('div', { id: 'ps-prepare' }, el('h3', { text: t('prepareH') }),
    el('div', { cls: 'actions' }, field('ps-pr-emp', t('employee')), field('ps-pr-period', t('period'), { placeholder: 'YYYY-MM' }), field('ps-pr-date', t('payDate'), { type: 'date' }),
      field('ps-pr-days', t('paidDays'), { inputmode: 'numeric' }), field('ps-pr-basic', t('basic'), { inputmode: 'decimal' }), field('ps-pr-other', t('other'), { inputmode: 'decimal' }), btn('ps-pr-go', t('prepare'), 'calculator')),
    statusLine('ps-pr-status'));
  if (prepared !== null) {
    const p = prepared.payslip ?? {};
    const notChecked = prepared.notChecked ?? [];
    box.append(el('div', { cls: 'depts', id: 'ps-pr-result', 'data-employee': prepared.employeeId },
      el('div', { cls: 'row' }, el('span', { text: `${prepared.employeeId} · ${prepared.period}` }), el('span', { text: t('prepared') })),
      el('div', { cls: 'row' }, el('span', { text: t('gross') }), el('span', { text: money(p.grossMinor ?? 0) })),
      el('div', { cls: 'row' }, el('span', { text: t('net') }), el('span', { text: money(p.netPayMinor ?? 0) })),
      el('div', { cls: 'row' }, el('span', { text: t('hoursWorked') }), el('span', { text: String(Math.round((p.statutoryChecks?.hoursWorked?.totalWorkedMinutes ?? 0) / 6) / 10) })),
      el('div', { cls: 'row', id: 'ps-pr-notchecked' }, el('span', { text: notChecked.length === 0 ? t('allChecked') : `${t('notCheckedList')} ${notChecked.join('; ')}` }))));
  }
  return box;
}

function checkNode() {
  const box = el('div', { id: 'ps-check' }, el('h3', { text: t('checkH') }), el('div', { cls: 'actions' }, field('ps-ck-period', t('period'), { placeholder: 'YYYY-MM' }), btn('ps-ck-go', t('showCheck'), 'list-checks')), statusLine('ps-ck-status'));
  if (check !== null) {
    const says = el('div', { cls: 'depts', id: 'ps-ck-says' }, el('div', { cls: 'row' }, el('strong', { text: t('payRunSays') })));
    for (const s of check.payRunSays ?? []) says.append(el('div', { cls: 'row', text: s }));
    if ((check.payRunSays ?? []).length === 0) says.append(el('div', { cls: 'row', text: t('allChecked') }));
    const slips = el('div', { cls: 'depts', id: 'ps-ck-slips' }, el('div', { cls: 'row' }, el('strong', { text: t('payslipsPrepared') })));
    if ((check.payslips ?? []).length === 0) slips.append(el('div', { cls: 'row', text: t('nonePrepared') }));
    for (const p of check.payslips ?? []) slips.append(el('div', { cls: 'row', 'data-employee': p.employeeId }, el('span', { text: `${p.employeeId} · ${p.payDate} · ${t('preparedBy')} ${p.preparedBy}` }), el('span', { text: `${t('gross')} ${money(p.grossMinor)} · ${t('net')} ${money(p.netPayMinor)}` })));
    box.append(says, slips, el('p', { cls: 'muted', id: 'ps-ck-hold', text: check.release?.words ?? t('holdNote') }));
  }
  return box;
}

function contribNode() {
  const box = el('div', { id: 'ps-contrib' }, el('h3', { text: t('contribH') }),
    el('div', { cls: 'actions' }, field('ps-ct-period', t('period'), { placeholder: 'YYYY-MM' }), btn('ps-ct-show', t('showContrib'), 'scale')),
    el('div', { cls: 'actions' }, field('ps-ct-pfe', t('pfEmployee'), { inputmode: 'decimal' }), field('ps-ct-pfr', t('pfEmployer'), { inputmode: 'decimal' }), field('ps-ct-esie', t('esiEmployee'), { inputmode: 'decimal' }),
      field('ps-ct-esir', t('esiEmployer'), { inputmode: 'decimal' }), field('ps-ct-ref', t('reference')), btn('ps-ct-save', t('recordTotals'), 'check')),
    statusLine('ps-ct-status'));
  if (contrib !== null) {
    const r = el('div', { cls: 'depts', id: 'ps-ct-result', 'data-state': contrib.status }, el('div', { cls: 'row' }, el('strong', { text: t(contrib.status) })), el('div', { cls: 'row', text: contrib.detail ?? '' }));
    for (const e of contrib.exceptions ?? []) r.append(el('div', { cls: 'row', text: e.detail }));
    box.append(r);
  }
  return box;
}

function lateNode() {
  const box = el('div', { id: 'ps-late' }, el('h3', { text: t('lateH') }), el('div', { cls: 'actions' }, field('ps-lt-period', t('period'), { placeholder: 'YYYY-MM' }), btn('ps-lt-go', t('showLate'), 'clock')), statusLine('ps-lt-status'));
  if (late !== null) {
    const r = el('div', { cls: 'depts', id: 'ps-lt-rows' });
    if (late.exceptions.length === 0) r.append(el('div', { cls: 'row', text: t('noneLate') }));
    for (const e of late.exceptions) r.append(el('div', { cls: 'row', 'data-employee': e.employeeId, text: e.detail }));
    box.append(r);
  }
  return box;
}

function issuedNode() {
  const box = el('div', { id: 'ps-issued' }, el('h3', { text: t('issuedH') }), el('div', { cls: 'actions' }, field('ps-is-emp', t('employee')), btn('ps-is-go', t('showIssued'), 'search')), statusLine('ps-is-status'));
  if (issued !== null) {
    const r = el('div', { cls: 'depts', id: 'ps-is-rows' });
    if (issued.periods.length === 0) r.append(el('div', { cls: 'row', text: t('noneIssued') }));
    for (const p of issued.periods) r.append(el('div', { cls: 'row' }, el('span', { text: `${p.period} · ${p.onDate}` }), el('span', { text: money(p.netPayMinor) })));
    box.append(r);
  }
  return box;
}

// Keep what a person typed across a repaint (a language switch or an answer).
function keep(fn) { const typed = {}; for (const n of $('stat-checks').querySelectorAll('input:not([type=checkbox]), select')) typed[n.id] = n.value; fn(); for (const [id, v] of Object.entries(typed)) { const n = $(id); if (n !== null) n.value = v; } }

function paint() {
  keep(() => {
    const root = $('stat-checks'); root.replaceChildren(el('h2', { text: t('checkH') }), el('p', { cls: 'lead', id: 'ps-hold', text: t('holdNote') }));
    if (may.legalRead) root.append(legalNode());
    if (may.statutory) root.append(preparedNode(), checkNode(), contribNode(), lateNode(), issuedNode());
    wire();
  });
}

async function loadLegal() {
  $('ps-legal-status').textContent = t('reading');
  const out = await session.legalSettings();
  if (out.result === 'ok') legal = out.value; else legal = null;
  paint(); if (out.result !== 'ok') say('ps-legal-status', out);
}

function wire() {
  const on = (id, f) => { const b = $(id); if (b !== null) b.addEventListener('click', f); };
  on('ps-fig-save', async () => { const out = await session.setFigure(val('ps-fig-key'), { value: val('ps-fig-value'), source: val('ps-fig-source'), confirmation: val('ps-fig-conf') }); if (out.result === 'ok') { legal = out.value; paint(); } say('ps-fig-status', out, t('saved')); });
  on('ps-mw-save', async () => { const out = await session.setMinimumWage({ classId: val('ps-mw-id'), label: val('ps-mw-label'), roles: val('ps-mw-roles'), monthlyRupees: val('ps-mw-monthly'), source: val('ps-mw-source'), confirmation: val('ps-mw-conf') }); if (out.result === 'ok') { legal = out.value; paint(); } say('ps-mw-status', out, t('saved')); });
  on('ps-pt-save', async () => {
    const list = [...$('stat-checks').querySelectorAll('#ps-particulars input[type=checkbox]')].filter((c) => c.checked).map((c) => c.value);
    const out = await session.setParticulars(list, { source: val('ps-pt-source'), confirmation: val('ps-pt-conf') }); if (out.result === 'ok') { legal = out.value; paint(); } say('ps-pt-status', out, t('saved'));
  });
  on('ps-pr-go', async () => { $('ps-pr-status').textContent = t('reading'); const out = await session.prepare({ employeeId: val('ps-pr-emp'), period: val('ps-pr-period'), onDate: val('ps-pr-date'), paidDays: val('ps-pr-days'), basicRupees: val('ps-pr-basic'), otherRupees: val('ps-pr-other') }); if (out.result === 'ok') { prepared = out.value; paint(); } say('ps-pr-status', out, t('prepared')); });
  on('ps-ck-go', async () => { $('ps-ck-status').textContent = t('reading'); const out = await session.check(val('ps-ck-period')); check = out.result === 'ok' ? out.value : null; paint(); say('ps-ck-status', out); });
  on('ps-ct-show', async () => { $('ps-ct-status').textContent = t('reading'); const out = await session.contributions(val('ps-ct-period')); contrib = out.result === 'ok' ? out.value : null; paint(); say('ps-ct-status', out); });
  on('ps-ct-save', async () => { const out = await session.recordTotals(val('ps-ct-period'), { pfEmployee: val('ps-ct-pfe'), pfEmployer: val('ps-ct-pfr'), esiEmployee: val('ps-ct-esie'), esiEmployer: val('ps-ct-esir'), reference: val('ps-ct-ref') }); if (out.result === 'ok') { contrib = out.value.reconciliation ?? null; paint(); } say('ps-ct-status', out, t('saved')); });
  on('ps-lt-go', async () => { $('ps-lt-status').textContent = t('reading'); const out = await session.late(val('ps-lt-period')); late = out.result === 'ok' ? out.value : null; paint(); say('ps-lt-status', out); });
  on('ps-is-go', async () => { $('ps-is-status').textContent = t('reading'); const out = await session.issued(val('ps-is-emp')); issued = out.result === 'ok' ? out.value : null; paint(); say('ps-is-status', out); });
}

if (api !== null && $('stat-checks') !== null && may.named && (may.statutory || may.legalRead)) {
  $('stat-checks').hidden = false;
  $('lang').addEventListener('click', () => { paint(); });
  paint();
  if (may.legalRead) void loadLegal();
}
