// Employee self-service payslip — the view layer (owner directive; docs/design/screens/payroll.md).
// All rules live in the tested model (apps/web-erp/src/payroll-ess-session.ts), attached as
// window.payrollEssSession. Own-record only: the model refuses anything but the signed-in person's own
// payslip. This file registers NO service worker, writes NOTHING to browser storage, and shows a person only
// their own figures — a refusal shows no data at all. No prompt/confirm/alert.

const el = (id) => document.getElementById(id);
const inr = (minor) => (minor < 0 ? '-' : '') + '₹' + (Math.abs(minor) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
let lang = 'en';

const session = window.payrollEssSession ?? {
  text: (_l, k) => k,
  view: () => ({ demo: true, online: true, mayView: false, nobodyNamed: false, notYourRecord: false, available: false, reauthFresh: false, screenState: { tone: 'error', icon: '✕', label: 'Your payslip could not load.', announcement: '', needsAttention: true } }),
  can: () => ({ ok: false, detail: 'not loaded' }),
};
const t = (key) => session.text(lang, key);

function tell(title, message, good = false) {
  el('banner-title').textContent = title;
  el('banner-text').textContent = message;
  el('banner').classList.toggle('good', good === true);
  el('banner').hidden = false;
  el('banner-ok').focus();
}
el('banner-ok').addEventListener('click', () => { el('banner').hidden = true; });

function moneyRows(container, lines, labelOf) {
  el(container).replaceChildren(...lines.map((l) => {
    const row = document.createElement('div'); row.className = 'row';
    const a = document.createElement('span'); a.textContent = labelOf(l);
    const b = document.createElement('span'); b.textContent = inr(l.amountMinor);
    row.append(a, b); return row;
  }));
}

function renderReauth(view) {
  const box = el('reauth');
  box.replaceChildren();
  if (view.reauthFresh) {
    const chip = document.createElement('span'); chip.textContent = `✓ ${t('reauthFresh')}`; box.append(chip); return;
  }
  const btn = document.createElement('button');
  btn.type = 'button'; btn.textContent = t('reauthNeeded'); btn.disabled = !view.online;
  btn.addEventListener('click', () => { globalThis.payrollReauth?.(); render(); });
  box.append(btn);
}

function render() {
  const view = session.view(lang);

  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('lang').textContent = t('langName');
  el('whoami').textContent = view.payslip ? `${view.payslip.employeeId} · ${view.payslip.payPeriod}` : '';

  el('demo').hidden = !view.demo;
  el('demo').textContent = view.demo ? t('demoBanner') : '';
  el('offline').hidden = view.online;
  el('offline').textContent = view.online ? '' : t('offlineBanner');
  el('nobody').hidden = !view.nobodyNamed;
  el('nobody').textContent = view.nobodyNamed ? t('nobodyNamed') : '';

  const payslip = el('payslip');
  const state = el('state');
  if (!view.available) {
    // A refusal (not permitted / not your record / unavailable) shows a message and NO figures.
    payslip.hidden = true;
    state.hidden = false;
    state.className = `state tone-${view.screenState.tone}`;
    el('state-icon').textContent = view.screenState.icon;
    el('state-text').textContent = view.screenState.label;
    return;
  }
  state.hidden = true;
  payslip.hidden = false;
  const p = view.payslip;

  el('earnings-title').textContent = t('earningsTitle');
  moneyRows('earnings', p.earnings.map((e) => ({ amountMinor: e.amountMinor, code: e.code })), (l) => l.code);
  el('gross-label').textContent = t('gross');
  el('gross').textContent = inr(p.grossMinor);

  el('deductions-title').textContent = t('deductionsTitle');
  moneyRows('deductions', p.deductions, (l) => l.label);
  el('total-deductions-label').textContent = t('totalDeductions');
  el('total-deductions').textContent = inr(p.totalDeductionsMinor);

  el('net-label').textContent = t('net');
  el('net').textContent = inr(p.netPayMinor);

  el('employer-title').textContent = t('employerTitle');
  moneyRows('employer', p.employerContributions.lines, (l) => l.label);
  el('employer-note').textContent = p.employerContributions.note;

  const settlement = el('settlement');
  if (p.settlement) {
    settlement.hidden = false;
    el('settlement-title').textContent = t('settlementTitle');
    const lines = [
      ...p.settlement.earnings.map((l) => ({ amountMinor: l.amountMinor, label: `${t('settlementEarnings')}: ${l.label}` })),
      ...p.settlement.recoveries.map((l) => ({ amountMinor: -l.amountMinor, label: `${t('settlementRecoveries')}: ${l.label}` })),
    ];
    moneyRows('settlement-rows', lines, (l) => l.label);
    el('settlement-net-label').textContent = `${t('settlementNet')} — ${t(p.settlement.payableToEmployee ? 'settlementPayable' : 'settlementRecoverable')}`;
    el('settlement-net').textContent = inr(p.settlement.netSettlementMinor);
  } else {
    settlement.hidden = true;
  }

  el('confirm-ca').textContent = t('confirmWithCa');
  renderReauth(view);

  const actions = el('actions');
  actions.replaceChildren();
  const btn = document.createElement('button');
  btn.type = 'button'; btn.textContent = t('actExport'); btn.disabled = !view.online;
  btn.addEventListener('click', () => {
    const outcome = session.can('exportOwnPayslip');
    if (outcome.ok) tell(t('actExport'), outcome.detail, true);
    else tell(t('title'), outcome.refusalLabelKey ? t(outcome.refusalLabelKey) : outcome.detail);
  });
  actions.append(btn);
}

el('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  render();
});
globalThis.addEventListener?.('online', render);
globalThis.addEventListener?.('offline', render);

render();

// NOTE: no navigator.serviceWorker.register here, by design — the payslip is online-first and must never be
// cached on the device (owner directive). Do not add one.
