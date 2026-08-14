// Payroll — the view layer (owner directive; docs/design/screens/payroll.md). Every rule lives in the TESTED
// model (apps/web-erp/src/payroll-session.ts), attached as window.payrollSession, built on packages/payroll +
// packages/ui. This file draws what the model hands over and NOTHING more:
//
//   • it registers NO service worker — payroll is online-first and nothing sensitive is cached on this device;
//   • it writes NOTHING to localStorage, sessionStorage, IndexedDB or cookies;
//   • it shows every sensitive identifier already MASKED (the model masks; the view never un-masks);
//   • DEMO data is stamped "DEMO DATA — NOT REAL PAYROLL" and cannot be mistaken for real;
//   • offline, it says so and DISABLES submit / approve / lock / reverse (no final action on stale data).
//
// No prompt / confirm / alert.

const el = (id) => document.getElementById(id);
const inr = (minor) => (minor < 0 ? '-' : '') + '₹' + (Math.abs(minor) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

let lang = 'en';

/** A tiny stand-in only if the bundle failed to load at all — the real session (incl. DEMO) comes from the bundle. */
const session = window.payrollSession ?? {
  text: (_l, k) => k,
  view: () => ({ demo: true, online: true, mayView: false, nobodyNamed: false, payPeriod: '', stage: 'none', stageLabelKey: 'stageNone', employees: [], departments: [], totals: { count: 0, grossMinor: 0, totalDeductionsMinor: 0, netMinor: 0 }, blockingExceptionCount: 0, screenState: { tone: 'error', icon: '✕', label: 'Payroll could not load.', announcement: '', needsAttention: true } }),
  can: () => ({ ok: false, detail: 'not loaded' }),
};
const t = (key) => session.text(lang, key);

// ── the outcome banner ────────────────────────────────────────────────────────
function tell(title, message, good = false) {
  el('banner-title').textContent = title;
  el('banner-text').textContent = message;
  el('banner').classList.toggle('good', good === true);
  el('banner').hidden = false;
  el('banner-ok').focus();
}
el('banner-ok').addEventListener('click', () => { el('banner').hidden = true; });

// ── which actions each stage offers ─────────────────────────────────────────────
const STAGE_ACTIONS = {
  draft: ['submit'],
  submitted: ['approve', 'reject'],
  approved: ['lock'],
  locked: ['generateBankFile', 'bulkPayslipDownload', 'export', 'reverse'],
  reversed: [],
  none: [],
};
const ACTION_LABEL_KEY = {
  submit: 'submit', approve: 'approve', reject: 'reject', lock: 'lock', reverse: 'reverse',
  generateBankFile: 'actGenerateBankFile', bulkPayslipDownload: 'actBulkPayslip', export: 'actExport',
};

function personNode(p) {
  const li = document.createElement('li');
  li.className = `person tone-${p.status.tone}`;

  const top = document.createElement('div');
  top.className = 'top';
  const who = document.createElement('span');
  const name = document.createElement('span'); name.className = 'name'; name.textContent = p.name;
  const dept = document.createElement('span'); dept.className = 'dept'; dept.textContent = ` · ${p.department}`;
  who.append(name, dept);
  const status = document.createElement('span');
  status.className = 'status';
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = p.status.icon;
  const slabel = document.createElement('span'); slabel.textContent = p.status.label;
  status.append(icon, slabel);
  status.setAttribute('aria-label', p.status.announcement || p.status.label);
  top.append(who, status);

  const money = document.createElement('div');
  money.className = 'money';
  for (const [label, value, strong] of [[t('colGross'), p.grossMinor, false], [t('colDeductions'), p.totalDeductionsMinor, false], [t('colNet'), p.netPayMinor, true]]) {
    const s = document.createElement('span');
    s.innerHTML = '';
    const lab = document.createElement('small'); lab.style.color = 'var(--muted)'; lab.textContent = `${label} `;
    const val = strong ? document.createElement('b') : document.createElement('span'); val.textContent = inr(value);
    s.append(lab, val);
    money.append(s);
  }

  // Payment details — ALWAYS masked (the model already masked them; the view never has the raw value).
  const pay = document.createElement('div');
  pay.className = 'pay';
  for (const [label, value] of [[t('bank'), p.masked.bankAccountMasked], [t('ifsc'), p.ifsc ?? '—'], [t('pan'), p.masked.panMasked], [t('uan'), p.masked.uanMasked], [t('aadhaar'), p.masked.aadhaarMasked]]) {
    const s = document.createElement('span');
    const b = document.createElement('b'); b.textContent = value;
    s.append(`${label}: `, b);
    pay.append(s);
  }

  li.append(top, money, pay);
  return li;
}

function renderActions(view) {
  const box = el('actions');
  box.replaceChildren();
  const actions = STAGE_ACTIONS[view.stage] ?? [];
  if (actions.length === 0) return;

  let reasonInput = null;
  if (view.stage === 'locked') {
    reasonInput = document.createElement('input');
    reasonInput.id = 'reverse-reason';
    reasonInput.type = 'text';
    reasonInput.placeholder = t('reverseReason');
    reasonInput.setAttribute('aria-label', t('reverseReason'));
    box.append(reasonInput);
  }

  for (const action of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = t(ACTION_LABEL_KEY[action] ?? action);
    // Offline disables every state change — the directive's hard line.
    btn.disabled = !view.online;
    btn.addEventListener('click', () => {
      const opts = action === 'reverse' && reasonInput ? { reason: reasonInput.value } : undefined;
      const outcome = session.can(action, opts);
      if (outcome.ok) {
        // inc1/inc2 preview the DECISION; the audited commit + real MFA + file generation are the API path.
        tell(t(ACTION_LABEL_KEY[action] ?? action), outcome.detail, true);
      } else {
        tell(t('title'), outcome.refusalLabelKey ? t(outcome.refusalLabelKey) : outcome.detail);
      }
    });
    box.append(btn);
  }
}

/** The MFA re-auth step — a step, never a browser dialog. Confirming refreshes the sensitive-action window. */
function renderReauth(view) {
  const box = el('reauth');
  box.replaceChildren();
  // Only meaningful when there is a sensitive action available (a locked run, or a run awaiting approve/lock).
  const hasSensitive = ['submitted', 'approved', 'locked'].includes(view.stage);
  if (!hasSensitive || !view.mayView) return;
  if (view.reauthFresh) {
    const chip = document.createElement('span');
    chip.className = 'status';
    chip.textContent = `✓ ${t('reauthFresh')}`;
    box.append(chip);
    return;
  }
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = t('reauthNeeded');
  btn.disabled = !view.online;
  btn.addEventListener('click', () => {
    // Model the MFA success. The real MFA challenge is the API path; here it refreshes the client window.
    globalThis.payrollReauth?.();
    render();
  });
  box.append(btn);
}

function renderLocked(view) {
  const box = el('locked');
  const art = view.lockedArtifacts;
  if (!art) { box.hidden = true; return; }
  box.hidden = false;
  el('locked-title').textContent = t('lockedTitle');
  el('bank-records-label').textContent = t('bankFileRecords');
  el('bank-records').textContent = String(art.bankFile.recordCount);
  el('bank-total-label').textContent = t('bankFileTotal');
  el('bank-total').textContent = inr(art.bankFile.totalNetMinor);
  const rec = el('bank-reconciled');
  rec.textContent = `${art.bankFile.reconciledWithRun ? '✓' : '✕'} ${t(art.bankFile.reconciledWithRun ? 'bankFileReconciled' : 'bankFileNotReconciled')}`;
  el('journal-debit-label').textContent = t('journalDebit');
  el('journal-debit').textContent = art.journal.available ? inr(art.journal.totalDebitMinor) : '—';
  el('journal-credit-label').textContent = t('journalCredit');
  el('journal-credit').textContent = art.journal.available ? inr(art.journal.totalCreditMinor) : '—';
  const bal = el('journal-balanced');
  bal.textContent = !art.journal.available ? `— ${t('journalUnavailable')}` : `${art.journal.balanced ? '✓' : '✕'} ${t(art.journal.balanced ? 'journalBalanced' : 'journalNotBalanced')}`;
}

function render() {
  const view = session.view(lang);

  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('lang').textContent = t('langName');
  el('whoami').textContent = view.payPeriod ?? '';

  el('demo').hidden = !view.demo;
  el('demo').textContent = view.demo ? t('demoBanner') : '';
  el('offline').hidden = view.online;
  el('offline').textContent = view.online ? '' : t('offlineBanner');
  el('nobody').hidden = !view.nobodyNamed;
  el('nobody').textContent = view.nobodyNamed ? t('nobodyNamed') : '';

  // Stage badge (icon + word, never colour alone).
  el('stage-icon').textContent = view.screenState.icon;
  el('stage-label').textContent = t(view.stageLabelKey);
  el('stage-badge').setAttribute('aria-label', view.screenState.announcement || view.screenState.label);
  const who2 = [];
  if (view.submittedBy) who2.push(`${t('maker')}: ${view.submittedBy}`);
  if (view.approvedBy) who2.push(`${t('checker')}: ${view.approvedBy}`);
  el('stage-who').textContent = who2.join(' · ');

  el('totals').textContent = `${t('totals')}: ${view.totals.count} · ${t('colNet')} ${inr(view.totals.netMinor)}`;
  el('attention').textContent = view.blockingExceptionCount > 0 ? `${view.blockingExceptionCount} ${t('blockingCount')}` : (view.mayView ? t('allClear') : '');

  el('people').replaceChildren(...view.employees.map(personNode));

  el('depts-title').textContent = t('departmentSummary');
  el('depts').replaceChildren(...view.departments.map((d) => {
    const row = document.createElement('div'); row.className = 'row';
    const a = document.createElement('span'); a.textContent = `${d.department} (${d.count})`;
    const b = document.createElement('span'); b.textContent = `${t('colGross')} ${inr(d.grossMinor)} · ${t('colNet')} ${inr(d.netMinor)}`;
    row.append(a, b); return row;
  }));

  el('masked-note').textContent = t('maskedNote');
  renderLocked(view);
  renderReauth(view);
  renderActions(view);
}

el('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  render();
});

// Re-render when connectivity changes — the model reads `online()` live, so this flips the offline banner
// and disables/enables the action buttons without a reload.
globalThis.addEventListener?.('online', render);
globalThis.addEventListener?.('offline', render);

render();

// NOTE: no `navigator.serviceWorker.register` here, by design — payroll is online-first and must never cache
// sensitive data on the device (owner directive). Do not add one.
