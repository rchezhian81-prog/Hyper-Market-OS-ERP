// Refund-exceptions review screen — the view layer (M13-FR-01/03 · M17 · API-05). Every rule lives in the
// TESTED session model (apps/web-erp/src/return-governance-session.ts), attached as
// window.returnGovernanceSession, built on packages/ui. This file only draws what the session hands it: each
// flagged return (biggest refund first), with WHAT BROKE (its governance flags), the amount, who gave and
// approved it, the customer, the reason and when. READ-ONLY — a breach is worked out of band (the money
// already moved), so there is no write here at all. No prompt/confirm/alert.

const el = (id) => document.getElementById(id);
let lang = 'en';

/** A stand-in with the same surface as the bundled session, so the shell always opens (and says so). */
function sampleSession() {
  const CHROME = {
    en: { title: 'Refund exceptions', langName: 'தமிழ்',
      lead: 'Sample exceptions. Connect the store computer to see your own shop’s flagged refunds.',
      listHeading: 'To review', exceptionCount: 'to review', exposureLabel: 'Total refunded', allClear: 'No refund exceptions — every refund followed the rules.',
      returnLabel: 'Return', saleLabel: 'Original bill', noSale: 'No receipt', laneLabel: 'Lane', amountLabel: 'Refunded', tenderLabel: 'As',
      processedByLabel: 'Given by', approvedByLabel: 'Approved by', noneNamed: 'Nobody named', customerLabel: 'Customer', noCustomer: 'No customer captured',
      reasonLabel: 'Reason', whenLabel: 'When', flagsLabel: 'What broke',
      flagStoreCreditOverCap: 'Store credit above your cap (or no cap set)',
      sampleData: 'Sample data — this is not your shop.', staleShell: 'No connection to the store computer. This page is what it was last told, at', nobodyNamed: '' },
    ta: { title: 'திருப்பிப்பணம் விதிமீறல்கள்', langName: 'English',
      lead: 'மாதிரி விதிமீறல்கள். உங்கள் கடையின் கொடியிடப்பட்ட திருப்பிப்பணங்களைப் பார்க்க கடை கணினியை இணைக்கவும்.',
      listHeading: 'பரிசீலிக்க வேண்டியவை', exceptionCount: 'பரிசீலிக்க வேண்டியவை', exposureLabel: 'மொத்தத் திருப்பிப்பணம்', allClear: 'திருப்பிப்பண விதிமீறல்கள் இல்லை — ஒவ்வொரு திருப்பிப்பணமும் விதிகளைப் பின்பற்றியது.',
      returnLabel: 'திருப்பம்', saleLabel: 'அசல் பில்', noSale: 'ரசீது இல்லை', laneLabel: 'பாதை', amountLabel: 'திருப்பியது', tenderLabel: 'வகை',
      processedByLabel: 'வழங்கியவர்', approvedByLabel: 'அனுமதித்தவர்', noneNamed: 'யாரும் குறிப்பிடப்படவில்லை', customerLabel: 'வாடிக்கையாளர்', noCustomer: 'வாடிக்கையாளர் பதிவு இல்லை',
      reasonLabel: 'காரணம்', whenLabel: 'எப்போது', flagsLabel: 'என்ன மீறப்பட்டது',
      flagStoreCreditOverCap: 'உங்கள் வரம்பை மீறிய கடைக்கடன் (அல்லது வரம்பு இல்லை)',
      sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.', staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', nobodyNamed: '' },
  };
  const sampleRow = (l) => ({
    returnId: 'sample-RT-9', originalSaleId: 'S-9', laneId: 'lane-1', amount: '₹500.00', amountMinor: 50000,
    refundTender: 'store_credit', processedBy: 'u-lanecash', approvedBy: 'u-mgr', customerRef: 'c-asha',
    reasonCode: 'customer_changed_mind', processedAt: '',
    flags: [{ code: 'store_credit_over_cap', label: CHROME[l].flagStoreCreditOverCap }],
    status: { tone: 'degraded', icon: '⚠', label: l === 'ta' ? 'விதிமீறல்' : 'Exception', announcement: CHROME[l].flagStoreCreditOverCap, needsAttention: true },
    needsAttention: true,
  });
  return {
    text: (l, key) => CHROME[l]?.[key] ?? CHROME.en[key] ?? key,
    view: (l) => ({
      screenState: { tone: 'ok', icon: '✓', label: '', announcement: '', needsAttention: false },
      exceptions: [sampleRow(l)], exceptionCount: 1, totalRefunded: '₹500.00', totalRefundedMinor: 50000, nobodyNamed: false,
    }),
  };
}

let session = window.returnGovernanceSession ?? sampleSession();
const t = (key) => session.text(lang, key);

function rowNode(r) {
  const li = document.createElement('li');
  li.className = `row tone-${r.status.tone}`;

  const head = document.createElement('div');
  head.className = 'head';
  const headline = document.createElement('span'); headline.className = 'headline'; headline.textContent = `${t('returnLabel')} ${r.returnId}`;
  const value = document.createElement('span'); value.className = 'value'; value.textContent = r.amount;
  head.append(headline, value);

  const status = document.createElement('span');
  status.className = 'status';
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = r.status.icon;
  const slabel = document.createElement('span'); slabel.textContent = r.status.label;
  status.append(icon, slabel);
  status.setAttribute('aria-label', r.status.announcement || r.status.label);

  // What broke — one chip per governance flag, each with the word (never a code).
  const flags = document.createElement('div'); flags.className = 'flags';
  const flagsLabel = document.createElement('span'); flagsLabel.className = 'flags-label'; flagsLabel.textContent = `${t('flagsLabel')}:`;
  flags.append(flagsLabel, ...r.flags.map((f) => {
    const chip = document.createElement('span'); chip.className = 'chip'; chip.textContent = f.label; return chip;
  }));

  const facts = document.createElement('div'); facts.className = 'facts';
  const sale = document.createElement('span'); sale.textContent = `${t('saleLabel')}: ${r.originalSaleId ?? t('noSale')}`;
  const lane = document.createElement('span'); lane.textContent = `${t('laneLabel')}: ${r.laneId}`;
  const tender = document.createElement('span'); tender.textContent = `${t('tenderLabel')}: ${r.refundTender}`;
  const by = document.createElement('span'); by.textContent = `${t('processedByLabel')}: ${r.processedBy}`;
  const appr = document.createElement('span'); appr.textContent = `${t('approvedByLabel')}: ${r.approvedBy}`;
  const cust = document.createElement('span'); cust.textContent = `${t('customerLabel')}: ${r.customerRef}`;
  const reason = document.createElement('span'); reason.textContent = `${t('reasonLabel')}: ${r.reasonCode}`;
  facts.append(sale, lane, tender, by, appr, cust, reason);
  if (r.processedAt) { const when = document.createElement('span'); when.textContent = `${t('whenLabel')}: ${new Date(r.processedAt).toLocaleString()}`; facts.append(when); }

  li.append(head, status, flags, facts);
  return li;
}

function paint() {
  const view = session.view(lang);

  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('whoami').textContent = window.returnGovernanceData?.userId ?? '';
  el('lang').textContent = t('langName');

  el('open-count').textContent = view.exceptionCount === 0 ? t('allClear') : `${view.exceptionCount} ${t('exceptionCount')}`;
  el('exposure').textContent = view.exceptionCount === 0 ? '' : `${t('exposureLabel')}: ${view.totalRefunded}`;

  const nobody = el('nobody');
  nobody.hidden = !view.nobodyNamed;
  nobody.textContent = view.nobodyNamed ? t('nobodyNamed') : '';

  el('list-heading').hidden = view.exceptions.length === 0;
  el('list-heading').textContent = t('listHeading');
  el('rows').replaceChildren(...view.exceptions.map((r) => rowNode(r)));

  const state = el('state');
  if (view.exceptions.length === 0) {
    state.hidden = false;
    state.className = `state tone-${view.screenState.tone}`;
    el('state-icon').textContent = view.screenState.icon;
    el('state-text').textContent = view.screenState.label;
  } else {
    state.hidden = true;
  }
}

el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); paintStale(); });

el('sample').hidden = window.returnGovernanceSession !== undefined;
el('sample').textContent = t('sampleData');
paint();

// Read the live exceptions (a GET — read-only). Offline or refused, the screen keeps its current view and the
// stale strip already says the page is what the box last told it.
async function refresh() {
  const api = window.returnGovernance;
  if (!api || typeof api.refresh !== 'function') return;
  const data = await api.refresh();
  if (data) { session = api.present(data); paint(); }
}
refresh();

function paintStale() {
  const at = window.shellCachedAt;
  const strip = el('stale');
  if (!strip) return;
  strip.hidden = at === undefined;
  if (at === undefined) return;
  strip.textContent = `${t('staleShell')} ${new Date(at).toLocaleString()}`;
}
paintStale();
el('lang').addEventListener('click', paintStale);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
