// Suppliers — the view layer (M06-FR-01, M23-FR-01, M15-FR-03, §28, API-03, P-02, P-03, P-08). Every rule lives in
// the TESTED session model (apps/web-erp/src/suppliers-session.ts), attached as window.suppliersSession, built on
// packages/ui. This file only draws what the session hands it: every supplier the records name, needing a person
// first, each with its reasons in words, its hold, its verified bank account and the one balance the matched bills
// say. The list is read live (a GET) and Refresh re-reads it. The two writes — PROPOSE a supplier and APPROVE a
// proposed one with a reason — run ONLY on an explicit click, only where the reader holds the right, and the
// session refuses a self-approval before anything is sent (§28). No prompt/confirm/alert.

const el = (id) => document.getElementById(id);
let lang = 'en';

/** Money in exact minor units → the shop's own display. */
function money(minor, currency) {
  const sym = currency === 'INR' ? '₹' : `${currency} `;
  return sym + (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** A stand-in with the same surface as the bundled session, so the shell always opens (and says so). It renders one
 *  clean supplier so the screen is never blank offline, and offers no write (nothing to write to). */
function sampleSession() {
  const CHROME = {
    en: {
      title: 'Suppliers', langName: 'தமிழ்',
      lead: 'Sample suppliers. Connect the store computer to see your own shop’s suppliers.',
      listHeading: 'Suppliers', asOfLabel: 'As of', refresh: 'Refresh',
      summarySuppliers: 'suppliers', summaryNeedAttention: 'need a person', summaryOwed: 'owed in total',
      owedLabel: 'Owed', withheldLabel: 'Withheld', paidLabel: 'Paid', unmatchedLabel: 'bills not yet matched',
      blockedInvoicesLabel: 'bills blocked', pendingReturnsLabel: 'returns owed to us', proposedByLabel: 'Proposed by',
      approveOwnProposal: 'proposed by you — someone else must approve it',
      sampleData: 'Sample data — this is not your shop.', },
    ta: {
      title: 'விநியோகஸ்தர்கள்', langName: 'English',
      lead: 'மாதிரி விநியோகஸ்தர்கள். உங்கள் கடையின் விநியோகஸ்தர்களைப் பார்க்க கடை கணினியை இணைக்கவும்.',
      listHeading: 'விநியோகஸ்தர்கள்', asOfLabel: 'நிலவரம்', refresh: 'புதுப்பி',
      summarySuppliers: 'விநியோகஸ்தர்கள்', summaryNeedAttention: 'ஒருவரின் கவனம் தேவை', summaryOwed: 'மொத்தம் தர வேண்டியது',
      owedLabel: 'தர வேண்டியது', withheldLabel: 'நிறுத்தி வைத்தது', paidLabel: 'செலுத்தியது', unmatchedLabel: 'இன்னும் பொருத்தப்படாத பில்கள்',
      blockedInvoicesLabel: 'தடுக்கப்பட்ட பில்கள்', pendingReturnsLabel: 'நமக்குத் திருப்பித் தர வேண்டியவை', proposedByLabel: 'முன்மொழிந்தவர்',
      approveOwnProposal: 'நீங்கள் முன்மொழிந்தது — வேறு ஒருவர் ஒப்புதல் அளிக்க வேண்டும்',
      sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.', },
  };
  return {
    text: (l, key) => CHROME[l]?.[key] ?? CHROME.en[key] ?? key,
    view: (l) => ({
      screenState: { tone: 'ok', icon: '✓', label: '', announcement: '', needsAttention: false },
      asOf: null,
      suppliers: [{
        status: { tone: 'ok', icon: '✓', label: l === 'ta' ? 'சரியாக உள்ளது' : 'In order', announcement: 'in order', needsAttention: false },
        supplierId: 'SUP-SAMPLE', headline: l === 'ta' ? 'மாதிரி வர்த்தகர்கள்' : 'Sample Traders', masterStatus: 'active',
        masterLabel: l === 'ta' ? 'ஒப்புதல் பெற்ற விநியோகஸ்தர்' : 'Approved supplier', blocked: false, proposedBy: null,
        bankAccountRef: '****1234', bankLabel: l === 'ta' ? 'சரிபார்க்கப்பட்ட வங்கிக் கணக்கு ****1234' : 'Verified bank account ****1234',
        owedMinor: 0, withheldMinor: 0, paidMinor: 0, unmatchedInvoices: 0, blockedInvoices: 0, pendingReturns: 0, currency: 'INR',
        needsAttention: false, reasons: [], canApproveHere: false, ownProposal: false,
      }],
      count: 1, needingAttentionCount: 0, owedMinor: 0, canPropose: false, canApprove: false, approvable: [], nobodyNamed: false,
    }),
    approve: async () => ({ outcome: 'no_link' }),
    propose: async () => ({ outcome: 'no_link' }),
    presentApproveOutcome: () => ({ tone: 'degraded', icon: '⚠', label: '', announcement: '', needsAttention: true }),
    presentProposeOutcome: () => ({ tone: 'degraded', icon: '⚠', label: '', announcement: '', needsAttention: true }),
  };
}

let session = window.suppliersSession ?? sampleSession();
const t = (key) => session.text(lang, key);

/** One supplier row. Every row reads as a state — a tone AND an icon AND a word (colour is never alone). */
function supplierNode(s) {
  const li = document.createElement('li');
  li.className = `row tone-${s.status.tone}`;
  li.dataset.supplierId = s.supplierId;

  const head = document.createElement('div');
  head.className = 'head';
  const headline = document.createElement('span');
  headline.className = 'headline';
  headline.textContent = s.headline;
  if (s.headline !== s.supplierId) {
    const code = document.createElement('span'); code.className = 'code'; code.textContent = s.supplierId; headline.append(code);
  }
  head.append(headline);

  const status = document.createElement('span');
  status.className = 'status';
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = s.status.icon;
  const slabel = document.createElement('span'); slabel.textContent = s.status.label;
  status.append(icon, slabel);
  status.setAttribute('aria-label', s.status.announcement || s.status.label);
  head.append(status);
  li.append(head);

  const facts = document.createElement('div');
  facts.className = 'facts';
  const fact = (text, cls) => { const sp = document.createElement('span'); if (cls) sp.className = cls; sp.textContent = text; facts.append(sp); };
  fact(s.masterLabel);
  if (s.ownProposal) fact(t('approveOwnProposal'));
  else if (s.masterStatus === 'proposed' && s.proposedBy) fact(`${t('proposedByLabel')}: ${s.proposedBy}`);
  fact(s.bankLabel);
  fact(`${t('owedLabel')}: ${money(s.owedMinor, s.currency)}`, 'money');
  if (s.withheldMinor > 0) fact(`${t('withheldLabel')}: ${money(s.withheldMinor, s.currency)}`, 'money');
  if (s.paidMinor > 0) fact(`${t('paidLabel')}: ${money(s.paidMinor, s.currency)}`, 'money');
  if (s.unmatchedInvoices > 0) fact(`${s.unmatchedInvoices} ${t('unmatchedLabel')}`);
  if (s.blockedInvoices > 0) fact(`${s.blockedInvoices} ${t('blockedInvoicesLabel')}`);
  if (s.pendingReturns > 0) fact(`${s.pendingReturns} ${t('pendingReturnsLabel')}`);
  li.append(facts);

  // Every reason, in words (P-08) — in the order head office gave them.
  if (s.reasons.length > 0) {
    const reasons = document.createElement('ul');
    reasons.className = 'reasons';
    for (const r of s.reasons) {
      const item = document.createElement('li');
      item.className = 'reason';
      item.dataset.reason = r.reason;
      item.textContent = r.label;
      reasons.append(item);
    }
    li.append(reasons);
  }
  return li;
}

function paintApprover(view) {
  const approver = el('approver');
  el('no-approve').hidden = true;
  if (!view.canApprove) {
    approver.hidden = true;
    // A reader who can see the list but not approve is told so in words, once the list is there.
    if (view.suppliers.length > 0 && !view.nobodyNamed && window.suppliersSession !== undefined) {
      el('no-approve').hidden = false;
      el('no-approve').textContent = t('noApprove');
    }
    return;
  }
  approver.hidden = false;
  el('approve-heading').textContent = t('approveHeading');
  el('approve-supplier-label').textContent = t('approveChoiceLabel');
  el('approve-reason-label').textContent = t('approveReasonLabel');
  el('approve-reason').placeholder = t('approveReasonPlaceholder');
  el('approve').textContent = t('approveBtn');
  const select = el('approve-supplier');
  const chosen = select.value;
  select.replaceChildren(...view.approvable.map((s) => {
    const opt = document.createElement('option');
    opt.value = s.supplierId;
    opt.textContent = s.headline === s.supplierId ? s.supplierId : `${s.headline} (${s.supplierId})`;
    return opt;
  }));
  if (chosen && view.approvable.some((s) => s.supplierId === chosen)) select.value = chosen;
  const none = view.approvable.length === 0;
  el('approve-none').hidden = !none;
  el('approve-none').textContent = none ? t('approveNoneWaiting') : '';
  el('approve-fields').hidden = none;
  el('approve').hidden = none;
}

function paintProposer(view) {
  const proposer = el('proposer');
  el('no-propose').hidden = true;
  if (!view.canPropose) {
    proposer.hidden = true;
    if (view.suppliers.length > 0 && !view.nobodyNamed && window.suppliersSession !== undefined) {
      el('no-propose').hidden = false;
      el('no-propose').textContent = t('noPropose');
    }
    return;
  }
  proposer.hidden = false;
  el('propose-heading').textContent = t('proposeHeading');
  el('propose-code-label').textContent = t('proposeCodeLabel');
  el('propose-code').placeholder = t('proposeCodePlaceholder');
  el('propose-name-label').textContent = t('proposeNameLabel');
  el('propose-gstin-label').textContent = t('proposeGstinLabel');
  el('propose-phone-label').textContent = t('proposePhoneLabel');
  el('propose-email-label').textContent = t('proposeEmailLabel');
  el('propose-terms-label').textContent = t('proposeTermsLabel');
  el('propose').textContent = t('proposeBtn');
}

function paintResult(presentation) {
  const result = el('result');
  result.hidden = false;
  result.className = `result tone-${presentation.tone}`;
  el('result-icon').textContent = presentation.icon;
  el('result-text').textContent = presentation.label;
  result.setAttribute('aria-label', presentation.announcement || presentation.label);
}

function paint() {
  const view = session.view(lang);

  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('whoami').textContent = window.suppliersData?.userId ?? '';
  el('lang').textContent = t('langName');
  el('refresh').textContent = t('refresh');
  el('asof').textContent = view.asOf ? `${t('asOfLabel')}: ${new Date(view.asOf).toLocaleString()}` : '';

  // A not-permitted / nothing-yet state has no rows: show the state line rather than an empty list.
  const state = el('state');
  if (view.suppliers.length === 0) {
    state.hidden = false;
    state.className = `state tone-${view.screenState.tone}`;
    el('state-icon').textContent = view.screenState.icon;
    el('state-text').textContent = view.screenState.label;
    state.setAttribute('aria-label', view.screenState.announcement || view.screenState.label);
    el('summary').hidden = true;
    el('list-heading').hidden = true;
    el('rows').replaceChildren();
  } else {
    state.hidden = true;
    el('summary').hidden = false;
    const currency = view.suppliers[0]?.currency ?? 'INR';
    el('summary').textContent = `${view.count} ${t('summarySuppliers')} · ${view.needingAttentionCount} ${t('summaryNeedAttention')} · ${money(view.owedMinor, currency)} ${t('summaryOwed')}`;
    el('list-heading').hidden = false;
    el('list-heading').textContent = t('listHeading');
    el('rows').replaceChildren(...view.suppliers.map((s) => supplierNode(s)));
  }

  paintApprover(view);
  paintProposer(view);
}

// APPROVE — a HUMAN write that runs ONLY on this explicit click, never on load. The session refuses the proposer
// before anything is sent (§28); the server records the approver as the caller and refuses the proposer again. On
// success the list is re-read (a GET) so the supplier's "awaiting approval" drops off from head office's own answer.
el('approve').addEventListener('click', () => {
  void (async () => {
    const outcome = await session.approve(el('approve-supplier').value, el('approve-reason').value);
    paintResult(session.presentApproveOutcome(lang, outcome));
    if (outcome.outcome === 'approved' || outcome.outcome === 'already_approved') { el('approve-reason').value = ''; await refresh(); }
  })();
});

// PROPOSE — a HUMAN write on an explicit click. The session refuses a form with no code or name before anything is
// sent; the server records the proposer as the caller and SAYS a look-alike back, which is shown, never hidden.
el('propose').addEventListener('click', () => {
  void (async () => {
    const outcome = await session.propose({
      supplierId: el('propose-code').value, name: el('propose-name').value, gstin: el('propose-gstin').value,
      phone: el('propose-phone').value, email: el('propose-email').value, paymentTermsDays: el('propose-terms').value,
    });
    paintResult(session.presentProposeOutcome(lang, outcome));
    if (outcome.outcome === 'proposed' || outcome.outcome === 'updated') {
      for (const id of ['propose-code', 'propose-name', 'propose-gstin', 'propose-phone', 'propose-email', 'propose-terms']) el(id).value = '';
      await refresh();
    }
  })();
});

el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });

el('sample').hidden = window.suppliersSession !== undefined;
el('sample').textContent = t('sampleData');
paint();

// Read the live supplier list (a GET — read-only). Offline or refused, the screen keeps its current view and the
// stale strip already says the page is what the box last told it. Nothing is written.
async function refresh() {
  const api = window.suppliers;
  if (!api || typeof api.refresh !== 'function') return;
  const data = await api.refresh();
  // The live session becomes THE session — on the page and on the window — so what is shown and what is asked agree.
  if (data) { session = api.present(data); window.suppliersSession = session; paint(); }
}
el('refresh').addEventListener('click', () => { void refresh(); });
refresh();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
