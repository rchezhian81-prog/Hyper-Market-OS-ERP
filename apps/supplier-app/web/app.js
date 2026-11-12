// Supplier portal — the view layer (M24-FR-01, API-03, §35, P-03, P-04). Every rule lives in the TESTED session
// model (apps/supplier-app/src/supplier-portal-session.ts), attached as window.supplierPortalSession by the
// bundle, built on packages/ui + packages/a11y. This file only DRAWS what the session hands it: what the
// supplier sent (waiting-on-us first, then processed) and its statement (the money we owe it, disputed shown
// separately) — each row a tone AND an icon AND a word, never colour alone. It changes nothing but ONE thing: the
// "Delivery update" form (OB-362) for one of the supplier's OWN open orders, which the bundle sends
// (window.supplierPortal.sendDeliveryUpdate — this file issues no write verb itself) — and, since OB-389, the "Top-up
// proposal" form for the supplier's OWN vendor-managed items at one store (window.supplierPortal.sendTopUpProposal),
// which waits for a buyer and orders nothing — and, since OB-624, the "Invoice" and "Delivery note (ASN)" forms
// (window.supplierPortal.sendInvoice / sendAsn), each waiting for a buyer to accept it. Refresh re-reads the feeds (GETs).
// Offline the screen keeps its view and the stale strip says the page is what it was last shown; an update not sent is
// said so. No prompt/confirm/alert.

// OB-607: a moment is shown at the SHOP's clock (its zone, as the store computer told the page) — never this device's.
const shopWhen = (value) => window.sreShopDay?.dateTimeOf(value) ?? '';
const el = (id) => document.getElementById(id);
let lang = 'en';

/** A stand-in with the same surface as the bundled session, so the shell always opens (and says so). Renders a
 *  calm all-clear so the screen is never blank offline. */
function sampleSession() {
  const CHROME = {
    en: {
      title: 'Your account with SRE', langName: 'தமிழ்',
      lead: 'Sample supplier portal. Sign in to see your own account.',
      refresh: 'Refresh', asOfLabel: 'As of',
      sentHeading: 'What you have sent us', sentNone: 'You have not sent us anything yet.',
      statementHeading: 'Your statement',
      sampleData: 'Sample data — this is not your account.', staleShell: 'No connection. This page is what you were last shown, at',
    },
    ta: {
      title: 'SRE உடன் உங்கள் கணக்கு', langName: 'English',
      lead: 'மாதிரி சப்ளையர் போர்ட்டல். உங்கள் கணக்கைப் பார்க்க உள்நுழையவும்.',
      refresh: 'புதுப்பி', asOfLabel: 'நிலவரம்',
      sentHeading: 'நீங்கள் அனுப்பியவை', sentNone: 'நீங்கள் இன்னும் எதையும் அனுப்பவில்லை.',
      statementHeading: 'உங்கள் அறிக்கை',
      sampleData: 'மாதிரித் தகவல் — இது உங்கள் கணக்கு அல்ல.', staleShell: 'இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகக் காட்டப்பட்டது:',
    },
  };
  return {
    text: (l, key) => CHROME[l]?.[key] ?? CHROME.en[key] ?? key,
    view: () => ({
      screenState: { tone: 'ok', icon: '✓', label: '', announcement: '', needsAttention: false },
      awaiting: [], processed: [], statement: null, statementInaccessible: false, awaitingCount: 0, notIdentified: false, anyAttention: false,
    }),
  };
}

let session = window.supplierPortalSession ?? sampleSession();
const t = (key) => session.text(lang, key);

/** One submission row: kind headline, a state (icon+word, never colour alone), and language-neutral facts. */
function submissionNode(s) {
  const li = document.createElement('li');
  li.className = `row tone-${s.status.tone}`;

  const head = document.createElement('div');
  head.className = 'head';
  const headline = document.createElement('span');
  headline.className = 'headline';
  headline.textContent = s.kindLabel;
  head.append(headline);

  const state = document.createElement('span');
  state.className = 'status';
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = s.status.icon;
  const slabel = document.createElement('span'); slabel.textContent = s.status.label;
  state.append(icon, slabel);
  state.setAttribute('aria-label', s.status.announcement || s.status.label);

  li.append(head, state);

  const facts = document.createElement('div');
  facts.className = 'facts';
  const ref = document.createElement('span'); ref.textContent = s.submissionId;
  const when = document.createElement('span'); when.textContent = s.receivedAt;
  facts.append(ref, when);
  li.append(facts);
  return li;
}

/** The statement panel — the named figures and the closing balance, with its reconcile status. */
function paintStatement(view) {
  const panel = el('statement');
  const inaccessible = el('statement-inaccessible');
  if (view.statement === null) {
    panel.hidden = true;
    inaccessible.hidden = !view.statementInaccessible;
    if (view.statementInaccessible) inaccessible.textContent = t('notAccessible');
    return;
  }
  inaccessible.hidden = true;
  panel.hidden = false;
  const s = view.statement;
  panel.className = `statement tone-${s.status.tone}`;
  const figs = [
    [t('openingLabel'), s.opening],
    [t('invoicedLabel'), s.invoiced],
    [t('creditedLabel'), s.credited],
    [t('debitedLabel'), s.debited],
    [t('paidLabel'), s.paid],
    [t('closingLabel'), s.closing],
    [t('disputedLabel'), s.disputed],
  ];
  const grid = document.createElement('div');
  grid.className = 'figs';
  for (const [label, value] of figs) {
    const fig = document.createElement('div'); fig.className = 'fig';
    const l = document.createElement('span'); l.className = 'f-label'; l.textContent = label;
    const v = document.createElement('span'); v.className = 'f-value'; v.textContent = value;
    fig.append(l, v); grid.append(fig);
  }
  const state = document.createElement('span');
  state.className = 'status';
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = s.status.icon;
  const slabel = document.createElement('span'); slabel.textContent = s.status.label;
  state.append(icon, slabel);
  state.setAttribute('aria-label', s.status.announcement || s.status.label);
  panel.replaceChildren(state, grid);
}

function paint() {
  const view = session.view(lang);

  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('whoami').textContent = window.supplierData?.userId ?? '';
  el('lang').textContent = t('langName');
  el('refresh').textContent = t('refresh');
  el('sent-heading').textContent = t('sentHeading');
  el('statement-heading').textContent = t('statementHeading');

  // A not-permitted screen (not a supplier login) has nothing to show: the state line stands in for everything.
  const notPermitted = view.screenState.tone === 'error' && view.awaiting.length === 0 && view.processed.length === 0 && view.statement === null && !view.statementInaccessible;
  const sections = ['sent-heading', 'awaiting', 'processed', 'sent-none', 'statement-heading', 'statement', 'statement-inaccessible'];
  const state = el('state');
  if (notPermitted) {
    state.hidden = false;
    state.className = `state tone-${view.screenState.tone}`;
    el('state-icon').textContent = view.screenState.icon;
    el('state-text').textContent = view.screenState.label;
    state.setAttribute('aria-label', view.screenState.announcement || view.screenState.label);
    for (const id of sections) el(id).hidden = true;
    el('delivery').hidden = true;
    el('vmi').hidden = true;
    el('invoice').hidden = true;
    el('asn').hidden = true;
    el('rfqs').hidden = true;
    el('claims').hidden = true;
    return;
  }
  state.hidden = true;
  for (const id of sections) el(id).hidden = false;

  // What you have sent us: waiting-on-us first, then processed; else the calm "none".
  el('awaiting').replaceChildren(...view.awaiting.map((s) => submissionNode(s)));
  el('processed').replaceChildren(...view.processed.map((s) => submissionNode(s)));
  const nothingSent = view.awaiting.length === 0 && view.processed.length === 0;
  el('awaiting').hidden = view.awaiting.length === 0;
  el('processed').hidden = view.processed.length === 0;
  el('sent-none').hidden = !nothingSent;
  el('sent-none').textContent = t('sentNone');

  paintStatement(view);
  paintDelivery();
  paintVmi();
  paintDocuments();
  paintRebates();
  paintRfqs();
  paintClaims();
}

// OB-362: the Delivery update form — the supplier's own open orders only; the bundle checks and sends it.
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
let ordersTried = false;
function paintDelivery() {
  const api = window.supplierPortal;
  const box = el('delivery');
  const feed = api && typeof api.orders === 'function' ? api.orders() : null;
  const v = session.view(lang);
  const notPermitted = v.screenState.tone === 'error' && v.awaiting.length === 0 && v.processed.length === 0 && v.statement === null && !v.statementInaccessible;
  box.hidden = window.supplierPortalSession === undefined || notPermitted;
  el('delivery-h').textContent = t('deliveryH');
  el('delivery-lead').textContent = t('deliveryLead');
  el('du-order-l').textContent = t('orderL'); el('du-status-l').textContent = t('statusL');
  el('du-expected-l').textContent = t('expectedL'); el('du-note-l').textContent = t('noteL');
  el('du-send-text').textContent = t('sendUpdate');
  const order = el('du-order');
  const keep = order.value;
  const opts = [new Option(t('chooseOrder'), '')];
  for (const o of feed?.orders ?? []) opts.push(new Option(`${o.number}${o.issuedAt && window.supplierPortal ? ` · ${window.supplierPortal.dateOf(o.issuedAt)}` : ''}`, o.poId));
  order.replaceChildren(...opts);
  if ([...order.options].some((x) => x.value === keep)) order.value = keep;
  const status = el('du-status');
  const keepStatus = status.value;
  status.replaceChildren(new Option('—', ''), ...['dispatched', 'in_transit', 'delayed'].map((k) => new Option(t(`status_${k}`), k)));
  status.value = keepStatus;
  const said = el('du-said');
  const usable = feed !== null && feed.ordersKnown && feed.mayUpdate && feed.orders.length > 0;
  said.textContent = feed === null ? (ordersTried ? t('ordersUnknown') : '') : !feed.ordersKnown ? t('ordersUnknown') : !feed.mayUpdate ? t('cannotUpdate') : feed.orders.length === 0 ? t('noOpenOrders') : '';
  said.hidden = said.textContent === '';
  el('du-form').hidden = !usable;
}
async function sendDelivery() {
  const api = window.supplierPortal;
  if (!api || typeof api.sendDeliveryUpdate !== 'function') return;
  const out = await api.sendDeliveryUpdate({ poId: el('du-order').value, status: el('du-status').value, expectedOn: el('du-expected').value, note: el('du-note').value });
  const st = el('du-result');
  st.className = `status-line ${out.result === 'sent' ? 'tone-ok' : 'tone-error'}`;
  st.textContent = out.result === 'sent' ? `✓ ${t('updateSent')}` : out.result === 'invalid' ? `⚠ ${t(out.why)}` : out.result === 'refused' ? `⚠ ${t('refusedSay')} ${out.whatHappened}` : `⚠ ${t('notSent')}`;
  st.dataset.result = out.result;
  if (out.result === 'sent') { el('du-note').value = ''; await refresh(); }
}
el('du-send').addEventListener('click', () => { void sendDelivery(); });

// OB-389: the Top-up proposal form — the supplier's own VMI items at one store; the bundle checks and sends it.
const fill = (text, vars) => text.replace(/\{(\w+)\}/g, (_m, k) => String(vars[k] ?? ''));
const typedQty = new Map(); // `${store}|${product}` → what the supplier typed, kept across repaints
function paintVmi() {
  const api = window.supplierPortal;
  const box = el('vmi');
  const feed = api && typeof api.vmi === 'function' ? api.vmi() : null;
  const v = session.view(lang);
  const notPermitted = v.screenState.tone === 'error' && v.awaiting.length === 0 && v.processed.length === 0 && v.statement === null && !v.statementInaccessible;
  box.hidden = window.supplierPortalSession === undefined || notPermitted;
  el('vmi-h').textContent = t('vmiH');
  el('vmi-lead').textContent = t('vmiLead');
  el('vmi-store-l').textContent = t('vmiStoreL');
  el('vmi-note-l').textContent = t('vmiNoteL');
  el('vmi-send-text').textContent = t('sendTopUp');
  const said = el('vmi-said');
  said.textContent = feed === null ? (ordersTried ? t('vmiUnknown') : '') : feed.items.length === 0 ? (feed.notSet ?? '') : !feed.mayPropose ? t('cannotPropose') : '';
  said.hidden = said.textContent === '';
  const usable = feed !== null && feed.items.length > 0 && feed.mayPropose;
  el('vmi-form').hidden = !usable;
  el('vmi-send').hidden = !usable;
  const store = el('vmi-store');
  const keep = store.value;
  const stores = [...new Set((feed?.items ?? []).map((i) => i.storeId))];
  store.replaceChildren(new Option(t('chooseStore'), ''), ...stores.map((s) => new Option(s, s)));
  if (stores.includes(keep)) store.value = keep; else if (stores.length === 1) store.value = stores[0];
  const here = usable ? feed.items.filter((i) => i.storeId === store.value) : [];
  el('vmi-items').replaceChildren(...here.map((i) => {
    const li = document.createElement('li');
    li.className = `row tone-${i.belowMinimum ? 'degraded' : 'ok'}`;
    li.dataset.product = i.productId;
    const head = document.createElement('div'); head.className = 'head';
    const name = document.createElement('span'); name.className = 'headline'; name.textContent = i.productId;
    head.append(name);
    if (i.belowMinimum) {
      const st = document.createElement('span'); st.className = 'status';
      const ic = document.createElement('span'); ic.className = 'icon'; ic.setAttribute('aria-hidden', 'true'); ic.textContent = '⚠';
      const w = document.createElement('span'); w.textContent = t('vmiBelowMin');
      st.append(ic, w); st.setAttribute('aria-label', t('vmiBelowMin'));
      head.append(st);
    }
    const facts = document.createElement('div'); facts.className = 'facts';
    facts.textContent = fill(t('vmiItemFacts'), { min: i.minQty, max: i.maxQty, onHand: i.onHand, onOrder: i.onOrder, room: i.room, uom: i.uom });
    const label = document.createElement('label'); label.className = 'vmi-qty';
    const lw = document.createElement('span'); lw.textContent = t('vmiQtyL');
    const input = document.createElement('input');
    input.inputMode = 'numeric'; input.autocomplete = 'off'; input.dataset.product = i.productId; input.className = 'vmi-qty-input';
    input.value = typedQty.get(`${i.storeId}|${i.productId}`) ?? '';
    input.addEventListener('input', () => { typedQty.set(`${i.storeId}|${i.productId}`, input.value); });
    label.append(lw, input);
    li.append(head, facts, label);
    return li;
  }));
  const proposals = feed?.proposals ?? [];
  el('vmi-proposals-h').hidden = proposals.length === 0;
  el('vmi-proposals-h').textContent = t('vmiProposalsH');
  el('vmi-proposals').replaceChildren(...proposals.map((p) => {
    const li = document.createElement('li');
    const tone = p.status === 'accepted' ? 'ok' : p.status === 'rejected' ? 'error' : 'degraded';
    li.className = `row tone-${tone}`;
    li.dataset.proposal = p.proposalId;
    const st = document.createElement('span'); st.className = 'status';
    const ic = document.createElement('span'); ic.className = 'icon'; ic.setAttribute('aria-hidden', 'true'); ic.textContent = p.status === 'accepted' ? '✓' : p.status === 'rejected' ? '✕' : '⏳';
    const word = t(p.status === 'accepted' ? 'vmiAccepted' : p.status === 'rejected' ? 'vmiRejected' : 'vmiAwaiting');
    const w = document.createElement('span'); w.textContent = `${word}${p.reason ? ` — ${p.reason}` : ''}`;
    st.append(ic, w); st.setAttribute('aria-label', word);
    const facts = document.createElement('div'); facts.className = 'facts';
    facts.textContent = `${p.storeId} · ${p.lines.map((l) => `${l.productId} × ${l.quantity}`).join(', ')} · ${p.proposedAt}`;
    li.append(st, facts);
    return li;
  }));
}
async function sendTopUp() {
  const api = window.supplierPortal;
  if (!api || typeof api.sendTopUpProposal !== 'function') return;
  const storeId = el('vmi-store').value;
  const quantities = {};
  for (const input of el('vmi-items').querySelectorAll('input.vmi-qty-input')) quantities[input.dataset.product] = input.value;
  const out = await api.sendTopUpProposal({ storeId, quantities, note: el('vmi-note').value });
  const st = el('vmi-result');
  st.className = `status-line ${out.result === 'sent' ? 'tone-ok' : 'tone-error'}`;
  st.textContent = out.result === 'sent' ? `✓ ${t('topUpSent')}` : out.result === 'invalid' ? `⚠ ${t(out.why)}${out.productId ? ` (${out.productId})` : ''}` : out.result === 'refused' ? `⚠ ${t('refusedSay')} ${out.whatHappened}` : `⚠ ${t('topUpNotSent')}`;
  st.dataset.result = out.result;
  if (out.result === 'sent') {
    el('vmi-note').value = '';
    for (const k of [...typedQty.keys()]) if (k.startsWith(`${storeId}|`)) typedQty.delete(k);
    await refresh();
  }
}
el('vmi-send').addEventListener('click', () => { void sendTopUp(); });

// D03-FR-03 · OB-404: the rebate claims the shop has sent this supplier — read only. A due day the shop has not set is said.
const rupeesOf = (minor) => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
function paintRebates() {
  const api = window.supplierPortal;
  const feed = api && typeof api.rebateClaims === 'function' ? api.rebateClaims() : null;
  const v = session.view(lang);
  const notPermitted = v.screenState.tone === 'error' && v.awaiting.length === 0 && v.processed.length === 0 && v.statement === null && !v.statementInaccessible;
  el('rebates').hidden = window.supplierPortalSession === undefined || notPermitted;
  el('rebates-h').textContent = t('rebateH');
  el('rebates-lead').textContent = t('rebateLead');
  const said = el('rebates-said');
  said.textContent = feed === null ? (ordersTried ? t('rebateUnknown') : '') : !feed.claimsKnown ? t('rebateUnknown') : feed.claims.length === 0 ? t('rebateNone') : '';
  said.hidden = said.textContent === '';
  el('rebates-rows').replaceChildren(...(feed?.claims ?? []).map((c) => {
    const li = document.createElement('li');
    const tone = c.state === 'answered' ? 'ok' : c.state === 'withdrawn' ? 'muted' : 'degraded';
    li.className = `row tone-${tone}`;
    li.dataset.claim = c.claimId; li.dataset.state = c.state;
    const st = document.createElement('span'); st.className = 'status';
    const ic = document.createElement('span'); ic.className = 'icon'; ic.setAttribute('aria-hidden', 'true'); ic.textContent = c.state === 'answered' ? '✓' : c.state === 'withdrawn' ? '○' : '⏳';
    const w = document.createElement('span'); w.textContent = t(`rebate_${c.state}`);
    st.append(ic, w); st.setAttribute('aria-label', t(`rebate_${c.state}`));
    const facts = document.createElement('div'); facts.className = 'facts';
    facts.textContent = fill(t('rebateFacts'), { claim: c.claimId, scheme: c.schemeId, amount: rupeesOf(c.amountMinor), sent: c.sentOn, due: c.answerDueOn ?? t('rebateDueNotSet'), paid: rupeesOf(c.paidMinor), left: rupeesOf(c.leftToPayMinor) });
    li.append(st, facts);
    return li;
  }));
}
// OB-624: the Invoice and Delivery note (ASN) forms — the supplier's own documents; the bundle checks and sends each, and
// a buyer accepts it before it counts. The lines live in this page's memory as typed, so a repaint (a language switch, a
// refresh) never loses them.
const DOC_UNITS = ['ea', 'kg', 'L'];
const blankInvoiceLine = () => ({ productId: '', quantity: '', uom: 'ea', unitPrice: '' });
const blankAsnLine = () => ({ productId: '', quantity: '', uom: 'ea', batchId: '', expiry: '', manufacturedOn: '' });
const docLines = { inv: [blankInvoiceLine()], asn: [blankAsnLine()] };
const DOC_FIELDS = {
  inv: [['productId', 'lineItemL', 'text'], ['quantity', 'lineQtyL', 'decimal'], ['uom', 'lineUomL', 'unit'], ['unitPrice', 'linePriceL', 'decimal']],
  asn: [['productId', 'lineItemL', 'text'], ['quantity', 'lineQtyL', 'decimal'], ['uom', 'lineUomL', 'unit'], ['batchId', 'lineBatchL', 'text'], ['expiry', 'lineExpiryL', 'date'], ['manufacturedOn', 'lineMadeL', 'month']],
};
const typedPaise = (v) => { const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(v).trim()); return m === null ? null : Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')); };
const typedMinor = (v, uom) => { const places = uom === 'ea' ? 0 : 3; const m = /^(\d+)(?:\.(\d+))?$/.exec(String(v).trim()); if (m === null || (m[2] ?? '').length > places) return null; return Number(m[1]) * 10 ** places + Number((m[2] ?? '').padEnd(places, '0') || '0'); };
// What a line comes to, shown as the supplier types — the bundle's tested reader is still the one that decides.
const lineValue = (l) => { const q = typedMinor(l.quantity, l.uom); const p = typedPaise(l.unitPrice); if (q === null || p === null) return null; const scale = l.uom === 'ea' ? 1 : 1000; return Math.round((q * p) / scale); };
function paintDocLines(form) {
  const list = el(`${form}-lines`);
  list.replaceChildren(...docLines[form].map((line, i) => {
    const li = document.createElement('li');
    li.dataset.line = String(i + 1);
    const head = document.createElement('div'); head.className = 'doc-line-h';
    const name = document.createElement('span'); name.textContent = fill(t('lineN'), { n: i + 1 });
    head.append(name);
    if (docLines[form].length > 1) {
      const rm = document.createElement('button'); rm.type = 'button'; rm.className = 'secondary doc-remove'; rm.textContent = t('removeLine');
      rm.setAttribute('aria-label', `${t('removeLine')} — ${fill(t('lineN'), { n: i + 1 })}`);
      rm.addEventListener('click', () => { docLines[form].splice(i, 1); paintDocLines(form); paintInvoiceSum(); });
      head.append(rm);
    }
    li.append(head);
    for (const [field, labelKey, type] of DOC_FIELDS[form]) {
      const id = `${form}-l${i + 1}-${field}`;
      const label = document.createElement('label'); label.htmlFor = id;
      const lw = document.createElement('span'); lw.textContent = t(labelKey);
      let input;
      if (type === 'unit') {
        input = document.createElement('select');
        input.replaceChildren(...DOC_UNITS.map((u) => new Option(t(`uom_${u}`), u)));
        input.value = line[field];
        input.addEventListener('change', () => { line[field] = input.value; paintInvoiceSum(); });
      } else {
        input = document.createElement('input');
        input.autocomplete = 'off';
        if (type === 'decimal') input.inputMode = 'decimal';
        if (type === 'date') input.type = 'date';
        if (type === 'month') input.type = 'month';
        if (type === 'text') input.maxLength = 64;
        input.value = line[field];
        input.addEventListener('input', () => { line[field] = input.value; paintInvoiceSum(); });
      }
      input.id = id; input.dataset.field = field;
      label.append(lw, input);
      li.append(label);
    }
    return li;
  }));
}
function paintInvoiceSum() {
  const values = docLines.inv.filter((l) => l.productId.trim() !== '' || l.quantity.trim() !== '' || l.unitPrice.trim() !== '').map(lineValue);
  el('inv-sum').textContent = values.length > 0 && values.every((v) => v !== null) ? fill(t('linesAddUp'), { total: rupeesOf(values.reduce((a, b) => a + b, 0)) }) : '';
}
function paintDocuments() {
  const api = window.supplierPortal;
  const v = session.view(lang);
  const notPermitted = v.screenState.tone === 'error' && v.awaiting.length === 0 && v.processed.length === 0 && v.statement === null && !v.statementInaccessible;
  const feed = api && typeof api.orders === 'function' ? api.orders() : null;
  const may = api && typeof api.maySubmitDocuments === 'function' ? api.maySubmitDocuments() : false;
  for (const form of ['inv', 'asn']) {
    el(form === 'inv' ? 'invoice' : 'asn').hidden = window.supplierPortalSession === undefined || notPermitted;
    el(`${form}-h`).textContent = t(form === 'inv' ? 'invoiceH' : 'asnH');
    el(`${form}-lead`).textContent = t(form === 'inv' ? 'invoiceLead' : 'asnLead');
    el(`${form}-order-l`).textContent = t('docOrderL');
    el(`${form}-no-l`).textContent = t(form === 'inv' ? 'invoiceNoL' : 'asnNoL');
    el(`${form}-add-text`).textContent = t('addLine');
    el(`${form}-send-text`).textContent = t(form === 'inv' ? 'sendInvoice' : 'sendAsn');
    const order = el(`${form}-order`);
    const keep = order.value;
    order.replaceChildren(new Option(t('noOrder'), ''), ...(feed?.orders ?? []).map((o) => new Option(`${o.number}${o.issuedAt && api ? ` · ${api.dateOf(o.issuedAt)}` : ''}`, o.poId)));
    if ([...order.options].some((x) => x.value === keep)) order.value = keep;
    const said = el(`${form}-said`);
    said.textContent = may ? '' : t('cannotSubmit');
    said.hidden = said.textContent === '';
    el(`${form}-form`).hidden = !may;
    paintDocLines(form);
  }
  el('inv-total-l').textContent = t('invoiceTotalL');
  el('asn-expected-l').textContent = t('expectedAtL');
  paintInvoiceSum();
}
function documentResult(form, out) {
  const st = el(`${form}-result`);
  st.className = `status-line ${out.result === 'sent' ? 'tone-ok' : 'tone-error'}`;
  st.textContent = out.result === 'sent' ? `✓ ${t('docSent')}`
    : out.result === 'invalid' ? `⚠ ${fill(t(out.why), { n: out.line ?? '', lines: out.linesMinor === undefined ? '' : rupeesOf(out.linesMinor), total: out.totalMinor === undefined ? '' : rupeesOf(out.totalMinor) })}`
    : out.result === 'refused' ? `⚠ ${t('refusedSay')} ${out.whatHappened}` : `⚠ ${t('docNotSent')}`;
  st.dataset.result = out.result;
}
async function sendInvoice() {
  const api = window.supplierPortal;
  if (!api || typeof api.sendInvoice !== 'function') return;
  const out = await api.sendInvoice({ poId: el('inv-order').value, invoiceId: el('inv-no').value, lines: docLines.inv, total: el('inv-total').value });
  documentResult('inv', out);
  if (out.result === 'sent') { docLines.inv = [blankInvoiceLine()]; el('inv-no').value = ''; el('inv-total').value = ''; await refresh(); }
}
async function sendAsn() {
  const api = window.supplierPortal;
  if (!api || typeof api.sendAsn !== 'function') return;
  const out = await api.sendAsn({ poId: el('asn-order').value, asnId: el('asn-no').value, expectedAt: el('asn-expected').value, lines: docLines.asn });
  documentResult('asn', out);
  if (out.result === 'sent') { docLines.asn = [blankAsnLine()]; el('asn-no').value = ''; el('asn-expected').value = ''; await refresh(); }
}
el('inv-add').addEventListener('click', () => { docLines.inv.push(blankInvoiceLine()); paintDocLines('inv'); });
el('asn-add').addEventListener('click', () => { docLines.asn.push(blankAsnLine()); paintDocLines('asn'); });
el('inv-send').addEventListener('click', () => { void sendInvoice(); });
el('asn-send').addEventListener('click', () => { void sendAsn(); });
{ const i = icon('receipt-text'); if (i !== null) el('inv-send').prepend(i); }
{ const i = icon('clipboard-list'); if (i !== null) el('asn-send').prepend(i); }
el('vmi-store').addEventListener('change', () => { paintVmi(); });
{ const i = icon('package'); if (i !== null) el('vmi-send').prepend(i); }
{ const i = icon('truck'); if (i !== null) el('du-send').prepend(i); }

// U6 · M24-FR-01: the requests for quotation the shop sent this supplier, each with its own quote form (a price per unit and
// the days to deliver, per line asked). What the supplier types lives in this page's memory, so a repaint never loses it.
// The bundle checks and sends each quote (window.supplierPortal.sendRfqQuote); a buyer accepts it before it counts.
const typedQuote = new Map(); // `${rfq}|${product}` → { unitPrice, leadTimeDays } as typed
const qtyWords = (l) => (l.uom === 'kg' || l.uom === 'L' ? `${(l.quantity / 1000).toFixed(3)} ${l.uom}` : String(l.quantity));
// Overdue is judged on the SHOP's day (OB-607); with no shop clock on the page the request reads open, never a guessed day.
const shopToday = () => (typeof window.sreShopDay?.today === 'function' ? window.sreShopDay.today() : null);
const rfqStateOf = (r) => { const today = shopToday(); return r.decision === 'accepted' ? 'accepted' : r.decision === 'rejected' ? 'rejected' : r.awaitingBuyer ? 'awaiting' : today !== null && today > r.dueOn ? 'overdue' : 'open'; };
function paintRfqs() {
  const api = window.supplierPortal;
  const feed = api && typeof api.rfqs === 'function' ? api.rfqs() : null;
  const v = session.view(lang);
  const notPermitted = v.screenState.tone === 'error' && v.awaiting.length === 0 && v.processed.length === 0 && v.statement === null && !v.statementInaccessible;
  el('rfqs').hidden = window.supplierPortalSession === undefined || notPermitted;
  el('rfqs-h').textContent = t('rfqH');
  el('rfqs-lead').textContent = t('rfqLead');
  const said = el('rfqs-said');
  said.textContent = feed === null ? (ordersTried ? t('rfqUnknown') : '') : !feed.rfqsKnown ? t('rfqUnknown') : feed.rfqs.length === 0 ? t('rfqNone') : !feed.mayRespond ? t('cannotQuote') : '';
  said.hidden = said.textContent === '';
  const mayQuote = feed !== null && feed.rfqsKnown && feed.mayRespond;
  el('rfqs-rows').replaceChildren(...(feed?.rfqs ?? []).map((r) => {
    const state = rfqStateOf(r);
    const li = document.createElement('li');
    const tone = state === 'accepted' ? 'ok' : state === 'rejected' || state === 'overdue' ? 'error' : 'degraded';
    li.className = `row tone-${tone}`;
    li.dataset.rfq = r.rfqId; li.dataset.state = state;
    const st = document.createElement('span'); st.className = 'status';
    const ic = document.createElement('span'); ic.className = 'icon'; ic.setAttribute('aria-hidden', 'true'); ic.textContent = state === 'accepted' ? '✓' : state === 'rejected' || state === 'overdue' ? '✕' : '⏳';
    const w = document.createElement('span'); w.textContent = `${t(`rfq_${state}`)}${state === 'rejected' && r.reason ? ` — ${r.reason}` : ''}`;
    st.append(ic, w); st.setAttribute('aria-label', t(`rfq_${state}`));
    const facts = document.createElement('div'); facts.className = 'facts';
    facts.textContent = `${fill(t('rfqFacts'), { rfq: r.rfqId, due: r.dueOn, sent: api ? api.dateOf(r.sentAt) : r.sentAt })}${r.note ? ` · ${t('rfqNoteL')}: ${r.note}` : ''}${r.replied && r.repliedAt ? ` · ${t('rfqRepliedAt')} ${shopWhen(r.repliedAt)}` : ''}`;
    li.append(st, facts);
    // One quote form per request: a price and the days for each line the shop asked for; a line left blank is not quoted.
    const form = document.createElement('div'); form.className = 'du-form';
    for (const line of r.lines) {
      const key = `${r.rfqId}|${line.productId}`;
      const typed = typedQuote.get(key) ?? { unitPrice: '', leadTimeDays: '' };
      const row = document.createElement('div'); row.className = 'facts';
      const name = document.createElement('span'); name.textContent = fill(t('rfqLineFacts'), { product: line.productId, qty: qtyWords(line) });
      const price = document.createElement('label'); price.htmlFor = `q-${r.rfqId}-${line.productId}-price`;
      const priceL = document.createElement('span'); priceL.textContent = t('rfqPriceL');
      const priceI = document.createElement('input'); priceI.id = price.htmlFor; priceI.inputMode = 'decimal'; priceI.autocomplete = 'off'; priceI.value = typed.unitPrice; priceI.disabled = !mayQuote;
      priceI.addEventListener('input', () => { typedQuote.set(key, { ...(typedQuote.get(key) ?? { unitPrice: '', leadTimeDays: '' }), unitPrice: priceI.value }); });
      price.append(priceL, priceI);
      const lead = document.createElement('label'); lead.htmlFor = `q-${r.rfqId}-${line.productId}-lead`;
      const leadL = document.createElement('span'); leadL.textContent = t('rfqLeadL');
      const leadI = document.createElement('input'); leadI.id = lead.htmlFor; leadI.inputMode = 'numeric'; leadI.autocomplete = 'off'; leadI.value = typed.leadTimeDays; leadI.disabled = !mayQuote;
      leadI.addEventListener('input', () => { typedQuote.set(key, { ...(typedQuote.get(key) ?? { unitPrice: '', leadTimeDays: '' }), leadTimeDays: leadI.value }); });
      lead.append(leadL, leadI);
      row.append(name, price, lead);
      form.append(row);
    }
    const send = document.createElement('button'); send.type = 'button'; send.id = `q-${r.rfqId}-send`; send.disabled = !mayQuote;
    const sendT = document.createElement('span'); sendT.textContent = t('sendQuote');
    { const i = icon('send'); if (i !== null) send.append(i); }
    send.append(sendT);
    send.addEventListener('click', () => { void sendQuote(r.rfqId); });
    const result = document.createElement('p'); result.className = 'status-line'; result.id = `q-${r.rfqId}-result`; result.setAttribute('role', 'status'); result.setAttribute('aria-live', 'polite');
    form.append(send);
    form.hidden = !mayQuote;
    li.append(form, result);
    return li;
  }));
}
async function sendQuote(rfqId) {
  const api = window.supplierPortal;
  if (!api || typeof api.sendRfqQuote !== 'function') return;
  const lines = {};
  for (const [key, typed] of typedQuote) { const [rfq, product] = key.split('|'); if (rfq === rfqId) lines[product] = typed; }
  const out = await api.sendRfqQuote({ rfqId, lines });
  const st = el(`q-${rfqId}-result`);
  if (!st) return;
  st.className = `status-line ${out.result === 'sent' ? 'tone-ok' : 'tone-error'}`;
  st.textContent = out.result === 'sent' ? `✓ ${t('quoteSent')}` : out.result === 'invalid' ? `⚠ ${fill(t(out.why), { product: out.productId ?? '' })}` : out.result === 'refused' ? `⚠ ${t('refusedSay')} ${out.whatHappened}` : `⚠ ${t('quoteNotSent')}`;
  st.dataset.result = out.result;
  if (out.result === 'sent') { await refresh(); const again = el(`q-${rfqId}-result`); if (again) { again.className = 'status-line tone-ok'; again.textContent = `✓ ${t('quoteSent')}`; again.dataset.result = 'sent'; } }
}

// U6 · M07-FR-03 · M24-FR-02: the claims the shop holds AGAINST this supplier (read only), and the one form that raises the
// supplier's own claim on the shop — the bundle checks and sends it (window.supplierPortal.sendClaim); a buyer decides it.
function paintClaims() {
  const api = window.supplierPortal;
  const feed = api && typeof api.claims === 'function' ? api.claims() : null;
  const orders = api && typeof api.orders === 'function' ? api.orders() : null;
  const v = session.view(lang);
  const notPermitted = v.screenState.tone === 'error' && v.awaiting.length === 0 && v.processed.length === 0 && v.statement === null && !v.statementInaccessible;
  el('claims').hidden = window.supplierPortalSession === undefined || notPermitted;
  el('claims-h').textContent = t('claimsH');
  el('claims-lead').textContent = t('claimsLead');
  const said = el('claims-said');
  said.textContent = feed === null ? (ordersTried ? t('claimsUnknown') : '') : !feed.claimsKnown ? t('claimsUnknown') : feed.claims.length === 0 ? t('claimsNone') : '';
  said.hidden = said.textContent === '';
  el('claims-rows').replaceChildren(...(feed?.claims ?? []).map((c) => {
    const li = document.createElement('li');
    const tone = c.state === 'issued' || c.state === 'returned' ? 'ok' : c.state === 'never_owed' ? 'muted' : 'degraded';
    li.className = `row tone-${tone}`;
    li.dataset.claim = c.claimId; li.dataset.state = c.state;
    const st = document.createElement('span'); st.className = 'status';
    const ic = document.createElement('span'); ic.className = 'icon'; ic.setAttribute('aria-hidden', 'true'); ic.textContent = c.state === 'issued' || c.state === 'returned' ? '✓' : c.state === 'never_owed' ? '○' : '⏳';
    const w = document.createElement('span'); w.textContent = t(`claim_${c.state}`);
    st.append(ic, w); st.setAttribute('aria-label', t(`claim_${c.state}`));
    const facts = document.createElement('div'); facts.className = 'facts';
    facts.textContent = fill(t('claimFacts'), { kind: t(`claimKind_${c.kind}`), po: c.poId, product: c.productId, qty: qtyWords({ quantity: c.quantityMinor, uom: c.uom }), value: rupeesOf(c.valueMinor), reason: c.reason, raised: api ? api.dateOf(c.raisedAt) : c.raisedAt, number: c.number ?? t('claimNoNumber') });
    li.append(st, facts);
    return li;
  }));
  // The raise form: the supplier's own open orders to name (or none), the amount, why.
  el('raise-h').textContent = t('raiseH');
  el('raise-lead').textContent = t('raiseLead');
  el('cl-order-l').textContent = t('claimOrderL'); el('cl-amount-l').textContent = t('claimAmountL'); el('cl-why-l').textContent = t('claimWhyL');
  el('cl-send-text').textContent = t('sendClaim');
  const order = el('cl-order');
  const keep = order.value;
  const opts = [new Option(t('noOrder'), '')];
  for (const o of orders?.orders ?? []) opts.push(new Option(`${o.number}${o.issuedAt && api ? ` · ${api.dateOf(o.issuedAt)}` : ''}`, o.poId));
  order.replaceChildren(...opts);
  if ([...order.options].some((x) => x.value === keep)) order.value = keep;
  const may = api && typeof api.maySubmitDocuments === 'function' ? api.maySubmitDocuments() : false;
  const rsaid = el('raise-said');
  rsaid.textContent = !may ? t('cannotSubmit') : '';
  rsaid.hidden = rsaid.textContent === '';
  el('raise-form').hidden = !may;
}
async function sendClaim() {
  const api = window.supplierPortal;
  if (!api || typeof api.sendClaim !== 'function') return;
  const out = await api.sendClaim({ poId: el('cl-order').value, amount: el('cl-amount').value, why: el('cl-why').value });
  const st = el('cl-result');
  st.className = `status-line ${out.result === 'sent' ? 'tone-ok' : 'tone-error'}`;
  st.textContent = out.result === 'sent' ? `✓ ${t('claimSent')}` : out.result === 'invalid' ? `⚠ ${t(out.why)}` : out.result === 'refused' ? `⚠ ${t('refusedSay')} ${out.whatHappened}` : `⚠ ${t('claimNotSent')}`;
  st.dataset.result = out.result;
  if (out.result === 'sent') { el('cl-amount').value = ''; el('cl-why').value = ''; await refresh(); }
}
el('cl-send').addEventListener('click', () => { void sendClaim(); });
{ const i = icon('circle-alert'); if (i !== null) el('cl-send').prepend(i); }

el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); paintStale(); });

el('sample').hidden = window.supplierPortalSession !== undefined;
el('sample').textContent = t('sampleData');
paint();

// Read the live feeds (GETs — read-only). Offline or refused, the screen keeps its current view; the stale strip
// already says the page is what it was last shown. Nothing is written.
async function refresh() {
  const api = window.supplierPortal;
  if (!api || typeof api.refresh !== 'function') return;
  const data = await api.refresh();
  ordersTried = true;
  if (data) { session = api.present(data); paint(); } else { paintDelivery(); paintVmi(); paintDocuments(); paintRebates(); paintRfqs(); paintClaims(); }
}
el('refresh').addEventListener('click', () => { void refresh(); });

refresh();

function paintStale() {
  const at = window.shellCachedAt;
  const strip = el('stale');
  if (!strip) return;
  strip.hidden = at === undefined;
  if (at === undefined) return;
  strip.textContent = `${t('staleShell')} ${shopWhen(at)}`;
}
paintStale();
el('lang').addEventListener('click', paintStale);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the portal still opens; it just will not be there without a network */
  });
}
