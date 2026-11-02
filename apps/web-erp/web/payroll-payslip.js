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
  btn.type = 'button'; btn.textContent = t('reauthNeeded'); btn.disabled = !view.online; whyDisabled(btn, view.online ? '' : 'offline');
  btn.addEventListener('click', () => { globalThis.payrollReauth?.(); render(); });
  box.append(btn);
}

function render() {
  if (window.payrollEssLive) return; // OB-380: the store computer's live view draws itself (renderLive)
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
  paintPayslip(view.payslip);
  renderReauth(view);

  const actions = el('actions');
  actions.replaceChildren();
  const btn = document.createElement('button'); btn.classList.add('sre-btn');
  btn.type = 'button'; btn.textContent = t('actExport'); btn.disabled = !view.online; whyDisabled(btn, view.online ? '' : 'offline');
  btn.addEventListener('click', () => {
    const outcome = session.can('exportOwnPayslip');
    if (outcome.ok) tell(t('actExport'), outcome.detail, true);
    else tell(t('title'), outcome.refusalLabelKey ? t(outcome.refusalLabelKey) : outcome.detail);
  });
  actions.append(btn);
}

/** Draw one payslip view (the model's, or head office's own redacted view on the store computer). */
function paintPayslip(p) {

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
}

el('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  render();
});
globalThis.addEventListener?.('online', render);
globalThis.addEventListener?.('offline', render);

// ── OB-380: served by the store computer — the person's OWN payslip, read live from head office, read only ──────────
// The box carries only who is looking; head office answers for the signed-in person alone (self-scoped, redacted). No
// figure is drawn until head office has answered; "none issued yet" and "cannot be reached" are said, never a demo.
const live = window.payrollEssLive ?? null;
let liveOut = null;

function renderLive() {
  const w = (k) => live.words(lang, k);
  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('lang').textContent = t('langName');
  el('demo').hidden = true;
  el('offline').hidden = true;
  el('nobody').hidden = live.session.may.named;
  el('nobody').textContent = live.session.may.named ? '' : w('nobody');
  const ok = liveOut !== null && liveOut.result === 'ok' && liveOut.value.issued === true && liveOut.value.view !== undefined;
  el('whoami').textContent = ok ? `${liveOut.value.view.employeeId} · ${liveOut.value.view.payPeriod}` : '';
  el('payslip').hidden = !ok;
  el('state').hidden = ok;
  if (ok) {
    paintPayslip(liveOut.value.view);
    el('reauth').replaceChildren();
    el('actions').replaceChildren();
    return;
  }
  const said = liveOut === null ? w('reading') : liveOut.result === 'ok' ? w('noneIssued') : live.outcome(lang, liveOut);
  el('state').className = `state tone-${liveOut === null ? 'idle' : liveOut.result === 'ok' ? 'idle' : 'error'}`;
  el('state-icon').textContent = liveOut === null ? '…' : liveOut.result === 'ok' ? 'ℹ' : '✕';
  el('state-text').textContent = said;
}

if (live !== null) {
  el('lang').addEventListener('click', renderLive);
  renderLive();
  live.session.readOwn().then((out) => { liveOut = out; renderLive(); });
} else {
  render();
}

// NOTE: no navigator.serviceWorker.register here, by design — the payslip is online-first and must never be
// cached on the device (owner directive). Do not add one.

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
