// Goods receipt review — the view layer (M07-FR-02/03, API-04, P-03, P-08). Every rule lives in the TESTED
// session model (apps/web-erp/src/goods-receipt-session.ts), attached as window.goodsReceiptSession, built on
// packages/ui. This file only draws what the session hands it: deliveries needing a second person first (§28),
// then the ones with a valued difference from the order (worst money first), then the clean ones — each with its
// discrepancies named and valued. It captures and approves nothing (receiving is captured on the handheld). Its ONE
// write (Batch 2), on an explicit click, goes through the session's online port: a held line a second person disposed
// of as a RETURN has physically gone back to the supplier. Refresh re-reads the list live (a GET); offline the screen
// keeps its view and the stale strip says so. No prompt/confirm/alert.

const el = (id) => document.getElementById(id);
let lang = 'en';

/** Money in exact minor units → the shop's own display. */
function money(minor, currency) {
  const sym = currency === 'INR' ? '₹' : `${currency} `;
  return sym + (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** A quantity in minor units (×100) → a plain number for a person. */
function qty(minor) {
  return (minor / 100).toLocaleString('en-IN');
}

/** A stand-in with the same surface as the bundled session, so the shell always opens (and says so). It renders
 *  one clean delivery so the screen is never blank offline. */
function sampleSession() {
  const CHROME = {
    en: {
      title: 'Goods receipt review', langName: 'தமிழ்',
      lead: 'Sample deliveries. Connect the store computer to see your own shop’s receipts.',
      listHeading: 'Deliveries', asOfLabel: 'As of', refresh: 'Refresh',
      summaryDeliveries: 'deliveries', summaryNeedApproval: 'need a second person',
      receivedByLabel: 'Received by', warehouseLabel: 'Store/warehouse', noPo: 'No purchase order',
      sellableLabel: 'Became sellable', quarantinedLabel: 'Held back', rejectedLabel: 'Refused',
      discrepancyValueLabel: 'Value of the difference', unitsWord: 'units',
      sampleData: 'Sample data — this is not your shop.', },
    ta: {
      title: 'சரக்கு பெறுதல் மதிப்பாய்வு', langName: 'English',
      lead: 'மாதிரி டெலிவரிகள். உங்கள் கடையின் பெறுதல்களைப் பார்க்க கடை கணினியை இணைக்கவும்.',
      listHeading: 'டெலிவரிகள்', asOfLabel: 'நிலவரம்', refresh: 'புதுப்பி',
      summaryDeliveries: 'டெலிவரிகள்', summaryNeedApproval: 'இரண்டாம் நபர் தேவை',
      receivedByLabel: 'பெற்றவர்', warehouseLabel: 'கடை/கிடங்கு', noPo: 'கொள்முதல் ஆர்டர் இல்லை',
      sellableLabel: 'விற்பனைக்கு ஆனது', quarantinedLabel: 'தடுத்து வைக்கப்பட்டது', rejectedLabel: 'மறுக்கப்பட்டது',
      discrepancyValueLabel: 'வேறுபாட்டின் மதிப்பு', unitsWord: 'அலகுகள்',
      sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.', },
  };
  return {
    text: (l, key) => CHROME[l]?.[key] ?? CHROME.en[key] ?? key,
    view: (l) => ({
      screenState: { tone: 'ok', icon: '✓', label: '', announcement: '', needsAttention: false },
      asOf: null,
      receipts: [{
        status: { tone: 'ok', icon: '✓', label: l === 'ta' ? 'ஆர்டர் செய்தபடி பெறப்பட்டது' : 'Received as ordered', announcement: 'received clean', needsAttention: false },
        grnId: 'sample', number: 'GRN-SAMPLE', poId: 'PO-1', warehouseId: 'W1', receivedBy: '—', receivedAt: '',
        needsApproval: false, discrepancyValueMinor: 0, currency: 'INR',
        sellableMinor: 100_00, quarantinedMinor: 0, rejectedMinor: 0, discrepancies: [], returnLines: [],
      }],
      count: 1, needingApprovalCount: 0, nobodyNamed: false, canRecordReturn: false, awaitingReturn: [],
    }),
    recordReturn: async () => ({ outcome: 'no_link' }),
    presentReturnOutcome: () => ({ tone: 'degraded', icon: '⚠', label: '', announcement: '', needsAttention: true }),
  };
}

let session = window.goodsReceiptSession ?? sampleSession();
const t = (key) => session.text(lang, key);

/** One delivery row. Every row reads as a state — a tone AND an icon AND a word (colour is never alone). */
function receiptNode(r) {
  const li = document.createElement('li');
  li.className = `row tone-${r.status.tone}`;

  const head = document.createElement('div');
  head.className = 'head';
  const headline = document.createElement('span');
  headline.className = 'headline';
  headline.textContent = r.number;
  head.append(headline);

  const status = document.createElement('span');
  status.className = 'status';
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = r.status.icon;
  const slabel = document.createElement('span'); slabel.textContent = r.status.label;
  status.append(icon, slabel);
  status.setAttribute('aria-label', r.status.announcement || r.status.label);
  head.append(status);
  li.append(head);

  const facts = document.createElement('div');
  facts.className = 'facts';
  const fact = (text) => { const s = document.createElement('span'); s.textContent = text; facts.append(s); };
  if (r.receivedAt) fact(new Date(r.receivedAt).toLocaleString());
  fact(`${t('warehouseLabel')}: ${r.warehouseId}`);
  fact(`${t('receivedByLabel')}: ${r.receivedBy}`);
  fact(r.poId ?? t('noPo'));
  fact(`${t('sellableLabel')}: ${qty(r.sellableMinor)} ${t('unitsWord')}`);
  if (r.quarantinedMinor > 0) fact(`${t('quarantinedLabel')}: ${qty(r.quarantinedMinor)} ${t('unitsWord')}`);
  if (r.rejectedMinor > 0) fact(`${t('rejectedLabel')}: ${qty(r.rejectedMinor)} ${t('unitsWord')}`);
  if (r.discrepancyValueMinor > 0) fact(`${t('discrepancyValueLabel')}: ${money(r.discrepancyValueMinor, r.currency)}`);
  li.append(facts);

  // Each difference, named and valued (P-08) — worst money first, as the session ordered them.
  if (r.discrepancies.length > 0) {
    const diffs = document.createElement('ul');
    diffs.className = 'diffs';
    for (const d of r.discrepancies) {
      const item = document.createElement('li');
      item.className = 'diff';
      const word = document.createElement('span'); word.className = 'd-word'; word.textContent = d.label;
      const val = document.createElement('span'); val.className = 'd-val'; val.textContent = money(d.valueMinor, d.currency);
      item.append(word, val);
      if (d.detail) { const det = document.createElement('span'); det.className = 'd-detail'; det.textContent = d.detail; item.append(det); }
      diffs.append(item);
    }
    li.append(diffs);
  }
  // Batch 2: the held lines disposed of as a return — waiting to go back, or gone — in words, never only a colour.
  if ((r.returnLines ?? []).length > 0) {
    const returns = document.createElement('ul');
    returns.className = 'returns';
    for (const l of r.returnLines) {
      const item = document.createElement('li');
      item.dataset.lineId = l.lineId;
      item.dataset.state = l.state;
      const word = document.createElement('span'); word.className = 'r-word'; word.textContent = l.stateLabel;
      const what = document.createElement('span'); what.textContent = `${l.productId} × ${l.quantityLabel} · ${money(l.valueMinor, l.currency)}`;
      const who = document.createElement('span'); who.className = 'd-detail';
      who.textContent = `${t('decidedByLabel')} ${l.decidedBy}` + (l.returnedBy ? ` · ${t('returnedByLabel')} ${l.returnedBy}` : '');
      item.append(word, what, who);
      returns.append(item);
    }
    li.append(returns);
  }
  return li;
}

// ── going back to the supplier (Batch 2) ────────────────────────────────────

function paintReturner(view) {
  const returner = el('returner');
  el('no-return').hidden = true;
  const anyWaiting = view.receipts.some((r) => (r.returnLines ?? []).some((l) => l.state === 'awaiting_return'));
  if (!view.canRecordReturn) {
    returner.hidden = true;
    if (anyWaiting && !view.nobodyNamed && window.goodsReceiptSession !== undefined) { el('no-return').hidden = false; el('no-return').textContent = t('noReturn'); }
    return;
  }
  returner.hidden = false;
  el('return-heading').textContent = t('returnsHeading');
  el('return-line-label').textContent = t('returnChoiceLabel');
  el('return-reason-label').textContent = t('returnReasonLabel');
  el('return-reason').placeholder = t('returnReasonPlaceholder');
  el('return').textContent = t('returnBtn');
  const select = el('return-line');
  const chosen = select.value;
  select.replaceChildren(...view.awaitingReturn.map((a) => {
    const opt = document.createElement('option'); opt.value = `${a.grnId}|${a.line.lineId}`;
    opt.textContent = `${a.number} · ${a.line.productId} × ${a.line.quantityLabel} · ${money(a.line.valueMinor, a.line.currency)}`;
    return opt;
  }));
  if (chosen && view.awaitingReturn.some((a) => `${a.grnId}|${a.line.lineId}` === chosen)) select.value = chosen;
  const none = view.awaitingReturn.length === 0;
  el('return-none').hidden = !none;
  el('return-none').textContent = none ? t('returnNoneWaiting') : '';
  el('return-fields').hidden = none;
  el('return').hidden = none;
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
  el('whoami').textContent = window.goodsReceiptData?.userId ?? '';
  el('lang').textContent = t('langName');
  el('refresh').textContent = t('refresh');
  el('asof').textContent = view.asOf ? `${t('asOfLabel')}: ${new Date(view.asOf).toLocaleString()}` : '';
  paintReturner(view);

  // A not-permitted / nothing-yet state has no rows: show the state line rather than an empty list.
  const state = el('state');
  if (view.receipts.length === 0) {
    state.hidden = false;
    state.className = `state tone-${view.screenState.tone}`;
    el('state-icon').textContent = view.screenState.icon;
    el('state-text').textContent = view.screenState.label;
    state.setAttribute('aria-label', view.screenState.announcement || view.screenState.label);
    el('summary').hidden = true;
    el('list-heading').hidden = true;
    el('rows').replaceChildren();
    return;
  }

  state.hidden = true;
  el('summary').hidden = false;
  el('summary').textContent = `${view.count} ${t('summaryDeliveries')} · ${view.needingApprovalCount} ${t('summaryNeedApproval')}`;
  el('list-heading').hidden = false;
  el('list-heading').textContent = t('listHeading');
  el('rows').replaceChildren(...view.receipts.map((r) => receiptNode(r)));
}

// GONE BACK TO THE SUPPLIER — an online write under the reader's session, on this click only; the session checks the line
// is waiting (and not one needing a count first) before anything is sent; head office decides.
el('return').addEventListener('click', () => {
  void (async () => {
    const [grnId, lineId] = el('return-line').value.split('|');
    const outcome = await session.recordReturn({ grnId: grnId ?? '', lineId: lineId ?? '', reason: el('return-reason').value });
    paintResult(session.presentReturnOutcome(lang, outcome));
    if (outcome.outcome === 'returned' || outcome.outcome === 'already_returned') { el('return-reason').value = ''; await refresh(); }
  })();
});

el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });

el('sample').hidden = window.goodsReceiptSession !== undefined;
el('sample').textContent = t('sampleData');
paint();

// Read the live GRN list (a GET — read-only). Offline or refused, the screen keeps its current view and the
// stale strip already says the page is what the box last told it. Nothing is written.
async function refresh() {
  const api = window.goodsReceipt;
  if (!api || typeof api.refresh !== 'function') return;
  const data = await api.refresh();
  if (data) { session = api.present(data); window.goodsReceiptSession = session; paint(); }
}
el('refresh').addEventListener('click', () => { void refresh(); });
refresh();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
