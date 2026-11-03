// W5 · OB-684 (owner, 3 Nov 2026) · C15 · C16 · C19 · OB-208 — the "Payroll legal figures" page: the CA's legal figures and
// nothing else. The session (createPayrollLegalSession in apps/web-erp/src/payroll-statutory-session.ts, in the bundle as
// window.payrollLegal) does every call and every rule, and carries no payslip, no month's check and no total — so nobody's
// pay can be reached from here. Payroll rule: online-first — read live from head office as the page opens, nothing cached or
// kept in the browser. Every word has a Tamil twin.

const $ = (id) => document.getElementById(id);
const api = window.payrollLegal ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, legalRead: false, legalSet: false };
let current = document.documentElement.lang === 'ta' ? 'ta' : 'en';
const lang = () => current;
const t = (k) => (api === null ? k : api.words(lang(), k));
const money = (m) => (api === null ? String(m) : api.rupees(m));
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
function el(tag, attrs = {}, ...kids) { const n = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'text') n.textContent = v; else if (k === 'cls') n.className = v; else n.setAttribute(k, v); } n.append(...kids); return n; }
function btn(id, words, iconName) { const b = el('button', { type: 'button', id }); const i = icon(iconName); if (i !== null) b.append(i); b.append(el('span', { text: words })); return b; }
function field(id, words, attrs = {}) { return el('label', { for: id }, el('span', { text: words }), el('input', { id, autocomplete: 'off', ...attrs })); }
function statusLine(id) { return el('p', { id, cls: 'muted', role: 'status', 'aria-live': 'polite' }); }
const val = (id) => $(id)?.value ?? '';
const say = (id, out, okWords = '') => { $(id).textContent = out.result === 'ok' ? okWords : api.outcomeWords(lang(), out); };

let legal = null;

function legalNode() {
  const box = el('div', { id: 'pl-legal' }, el('h3', { text: t('legalH') }), el('p', { cls: 'lead', text: t('legalLead') }), statusLine('pl-legal-status'));
  if (legal === null) return box;
  const rows = el('div', { cls: 'depts', id: 'pl-figures' });
  for (const f of legal.figures ?? []) rows.append(el('div', { cls: 'row', 'data-figure': f.key, 'data-state': f.status }, el('span', { text: f.label }), el('span', { text: f.status === 'confirmed' ? `${f.value} ${f.unit} · ${t('confirmed')}` : `${t('not_confirmed')}${f.missing ? ` — ${f.missing}` : ''}` })));
  box.append(rows, el('p', { cls: 'muted', text: t('overtimeFloor') }));
  const classes = el('div', { cls: 'depts', id: 'pl-classes' });
  if ((legal.minimumWages ?? []).length === 0) classes.append(el('div', { cls: 'row', text: t('noClasses') }));
  for (const c of legal.minimumWages ?? []) classes.append(el('div', { cls: 'row', 'data-class': c.classId, 'data-state': c.status }, el('span', { text: `${c.label} (${c.roles.join(', ')})` }), el('span', { text: `${money(c.monthlyMinor)} · ${t(c.status)}` })));
  box.append(el('h3', { text: t('minWageH') }), classes);
  const parts = el('div', { id: 'pl-particulars', cls: 'depts', 'data-state': legal.particulars?.status ?? 'not_confirmed' });
  const chosen = new Set(legal.particulars?.particulars ?? []);
  for (const p of legal.particulars?.catalogue ?? []) {
    const cb = el('input', { type: 'checkbox', id: `pl-part-${p.key}`, value: p.key }); cb.checked = chosen.has(p.key); cb.disabled = !may.legalSet;
    parts.append(el('label', { cls: 'row', for: `pl-part-${p.key}` }, el('span', { text: p.label ?? p.key }), cb));
  }
  box.append(el('h3', { text: `${t('particularsH')} · ${t(legal.particulars?.status ?? 'not_confirmed')}` }), parts);
  if (may.legalSet) {
    const pick = el('select', { id: 'pl-fig-key' });
    for (const f of legal.figures ?? []) pick.append(el('option', { value: f.key, text: f.label }));
    box.append(el('div', { cls: 'actions' }, el('label', { for: 'pl-fig-key' }, el('span', { text: t('figure') }), pick), field('pl-fig-value', t('value'), { inputmode: 'numeric' }),
      field('pl-fig-source', t('source')), field('pl-fig-conf', t('confirmation')), btn('pl-fig-save', t('save'), 'check')), statusLine('pl-fig-status'));
    box.append(el('div', { cls: 'actions' }, field('pl-mw-id', t('classId')), field('pl-mw-label', t('classLabel')), field('pl-mw-roles', t('classRoles')), field('pl-mw-monthly', t('monthly'), { inputmode: 'decimal' }),
      field('pl-mw-source', t('source')), field('pl-mw-conf', t('confirmation')), btn('pl-mw-save', t('save'), 'check')), statusLine('pl-mw-status'));
    box.append(el('div', { cls: 'actions' }, field('pl-pt-source', t('source')), field('pl-pt-conf', t('confirmation')), btn('pl-pt-save', t('particularsSave'), 'check')), statusLine('pl-pt-status'));
  }
  return box;
}

// Keep what a person typed across a repaint (a language switch or an answer).
function keep(fn) { const typed = {}; for (const n of $('legal-figures').querySelectorAll('input:not([type=checkbox]), select')) typed[n.id] = n.value; fn(); for (const [id, v] of Object.entries(typed)) { const n = $(id); if (n !== null) n.value = v; } }

function paint() {
  $('title-text').textContent = t('legalPageH'); $('page-h').textContent = t('legalPageH'); $('lead').textContent = t('legalPageLead');
  $('whoami').textContent = window.payrollLegalData?.userId ?? '';
  $('lang').textContent = current === 'en' ? 'தமிழ்' : 'English';
  if (!may.named) { $('page-status').textContent = t('nobody'); return; }
  if (!may.legalRead) { $('page-status').textContent = t('cannotReadLegal'); return; }
  keep(() => { $('legal-figures').replaceChildren(legalNode()); wire(); });
}

async function loadLegal() {
  $('pl-legal-status').textContent = t('reading');
  const out = await session.legalSettings();
  legal = out.result === 'ok' ? out.value : null;
  paint(); if (out.result !== 'ok') say('pl-legal-status', out);
}

function wire() {
  const on = (id, f) => { const b = $(id); if (b !== null) b.addEventListener('click', f); };
  on('pl-fig-save', async () => { const out = await session.setFigure(val('pl-fig-key'), { value: val('pl-fig-value'), source: val('pl-fig-source'), confirmation: val('pl-fig-conf') }); if (out.result === 'ok') { legal = out.value; paint(); } say('pl-fig-status', out, t('saved')); });
  on('pl-mw-save', async () => { const out = await session.setMinimumWage({ classId: val('pl-mw-id'), label: val('pl-mw-label'), roles: val('pl-mw-roles'), monthlyRupees: val('pl-mw-monthly'), source: val('pl-mw-source'), confirmation: val('pl-mw-conf') }); if (out.result === 'ok') { legal = out.value; paint(); } say('pl-mw-status', out, t('saved')); });
  on('pl-pt-save', async () => {
    const list = [...$('legal-figures').querySelectorAll('#pl-particulars input[type=checkbox]')].filter((c) => c.checked).map((c) => c.value);
    const out = await session.setParticulars(list, { source: val('pl-pt-source'), confirmation: val('pl-pt-conf') }); if (out.result === 'ok') { legal = out.value; paint(); } say('pl-pt-status', out, t('saved'));
  });
}

if (api !== null) {
  $('lang').addEventListener('click', () => { current = current === 'en' ? 'ta' : 'en'; document.documentElement.lang = current; paint(); });
  if (may.named && may.legalRead) $('legal-figures').hidden = false;
  paint();
  if (may.named && may.legalRead) void loadLegal();
}
