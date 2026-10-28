// Business customers — the page over head office's B2B desk (M22-FR-01/02/04 · OB-288 package 3). The session
// (apps/web-erp/src/b2b-desk-session.ts, in the bundle as window.b2bDesk) does every call; this page lays out what it is
// told. A section shows only to a person whose role may use it; nothing is read before the person opens the page, and
// every write is a click. Prices are never typed: a quotation is priced from the customer's contract or the price list.
// Every word has a Tamil twin; every button carries an icon beside its word.

const $ = (id) => document.getElementById(id);
const api = window.b2bDesk ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, open: false, issue: false, readContracts: false, manageContracts: false, collect: false, readAccount: false, manageAccount: false, approveRecurring: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
const money = (minor) => (api === null ? String(minor) : api.rupees(minor));
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function button(words, iconName, act, quiet) { const b = document.createElement('button'); b.type = 'button'; if (quiet) b.className = 'quiet'; if (act) b.dataset.act = act; const i = icon(iconName); if (i !== null) b.append(i); b.append(text('span', words)); return b; }
function field(labelWords, cls, value) { const l = document.createElement('label'); l.append(text('span', labelWords)); const i = document.createElement('input'); i.autocomplete = 'off'; i.className = cls; if (value !== undefined) i.value = value; l.append(i); return { label: l, input: i }; }
const say = (id, out) => { $(id).textContent = api.outcomeWords(lang, out); };

let desk = null; let requests = null; let customerId = null; let customer = null; let ageing = null; let asked = []; let recurring = [];
const quoteLines = [{ productId: '', description: '', qty: '', taxPercent: '5' }];

function paintDesk() {
  const ul = $('c-rows'); ul.replaceChildren();
  if (desk === null) return;
  if (desk.customers.length === 0) ul.append(text('li', t('customersNone')));
  for (const c of desk.customers) {
    const li = document.createElement('li'); li.dataset.customer = c.customerId;
    const state = c.contract.inForce !== null ? `${t('inForce')}: ${c.contract.inForce}` : c.contract.blocked ? t('blocked') : c.contract.lapsed !== null ? t('lapsed') : t('noContract');
    li.append(text('strong', c.customerId), text('span', state, 'meta'));
    const open = button(t('open'), 'search', 'open', true);
    open.addEventListener('click', () => { $('c-id').value = c.customerId; void openCustomer(c.customerId); });
    li.append(open); ul.append(li);
  }
}
function paintRequests() {
  const ul = $('r-rows'); ul.replaceChildren();
  if (requests === null) return;
  if (requests.requests.length === 0) ul.append(text('li', t('requestsNone')));
  for (const r of requests.requests) {
    const li = document.createElement('li'); li.dataset.request = r.requestId;
    li.append(text('strong', `${r.customerId} — ${r.requestId}`), text('span', r.lines.map((l) => `${l.productId} × ${l.qty}`).join(' · ') + (r.note ? ` — ${r.note}` : ''), 'meta'));
    if (may.issue) {
      const use = button(t('useRequest'), 'file-text', 'use-request', true);
      use.addEventListener('click', async () => {
        $('c-id').value = r.customerId;
        quoteLines.splice(0, quoteLines.length, ...r.lines.map((l) => ({ productId: l.productId, description: l.productId, qty: String(l.qty), taxPercent: '5' })));
        await openCustomer(r.customerId);
      });
      li.append(use);
    }
    ul.append(li);
  }
}

function fig(label, value) { const d = document.createElement('div'); d.append(text('span', label, 'meta'), text('strong', value)); return d; }
function paintCustomer() {
  $('cust-h').textContent = customerId ?? '';
  const acct = $('acct'); acct.replaceChildren();
  const k = $('k-rows'); k.replaceChildren();
  if (customer === null) return;
  const a = customer.account;
  if (a === null) acct.append(text('p', t('noAccount'), 'meta'));
  else {
    acct.append(fig(t('limit'), money(a.creditLimitMinor)), fig(t('owed'), money(a.outstandingMinor)), fig(t('available'), money(a.availableCreditMinor)), fig(t('terms'), a.paymentTermsDays === null ? t('notSet') : String(a.paymentTermsDays)));
    // OB-416: the GSTIN the next tax invoice is made out to — or, said, that there is none (its invoices file as B2C).
    const g = a.gstin ?? null;
    const gf = fig(t('gstinFig'), g === null ? t('gstinNone') : `${g.gstin} — ${g.legalName} (${g.stateName}, ${g.stateCode})`);
    gf.id = 'acct-gstin'; acct.append(gf);
  }
  $('gstin-form').hidden = !(may.manageAccount && a !== null);
  // OB-427: a GSTIN on record may be removed (the registration was cancelled), with the reason typed above.
  const hasGstin = a !== null && (a.gstin ?? null) !== null;
  $('g-remove').hidden = !hasGstin; $('g-remove-note').hidden = !hasGstin;
  if (customer.contracts.length === 0) k.append(text('li', t('contractNone')));
  for (const c of customer.contracts) {
    const li = document.createElement('li'); li.dataset.contract = c.contractId;
    li.append(text('strong', `${c.contractId} — ${t(`standing_${c.standing}`)}`));
    const left = c.contractId === customer.contract.inForce && customer.contract.daysToExpiry !== null ? ` · ${customer.contract.daysToExpiry} ${t('daysLeft')}` : '';
    li.append(text('span', `${c.validFrom} → ${c.validTo} (${t('endsOn')})${left} · ${t(`onExpiry_${c.onExpiry}`)}`, 'meta'));
    li.append(text('span', c.prices.map((p) => `${p.productId} ${money(p.priceMinor)}`).join(' · '), 'meta'));
    if (c.approvedBy) li.append(text('span', `${t('approvedBy')} ${c.approvedBy}`, 'meta'));
    k.append(li);
  }
  paintAsked(); paintDocs(); paintAgeing();
}
function paintAsked() {
  const ul = $('k-asked'); ul.replaceChildren();
  for (const r of asked.filter((x) => x.subjectRef.startsWith(`${customerId}/`))) {
    if (r.status === 'used') continue;
    const li = document.createElement('li'); li.dataset.asked = r.requestId;
    li.append(text('strong', `${t('askedFor')}: ${r.subjectRef} — ${r.status}`));
    if (r.decidedBy) li.append(text('span', `${r.status === 'rejected' ? t('rejectedBy') : t('approvedBy')} ${r.decidedBy}${r.decisionReason ? ` — ${r.decisionReason}` : ''}`, 'meta'));
    if (r.status === 'approved' && r.kind === 'b2b_contract' && may.manageContracts) {
      const go = button(t('putInForce'), 'shield-check', 'put-in-force');
      go.addEventListener('click', async () => { const out = await session.putContractInForce(r); say('k-status', out); if (out.result === 'ok') await openCustomer(customerId); });
      li.append(go);
    }
    if (r.status === 'approved' && r.kind === 'b2b_credit_override' && may.issue) {
      const go = button(t('withApproval'), 'shield-check', 'order-with-approval');
      go.addEventListener('click', async () => { const out = await session.convertWithApproval(r); say('d-status', out); if (out.result === 'ok') await openCustomer(customerId); });
      li.append(go);
    }
    ul.append(li);
  }
}
function paintDocs() {
  const ul = $('d-rows'); ul.replaceChildren();
  const docs = customer?.documents ?? [];
  if (docs.length === 0) ul.append(text('li', t('docsNone')));
  for (const d of docs) {
    const li = document.createElement('li'); li.dataset.doc = d.documentId; li.dataset.kind = d.kind;
    li.append(text('strong', `${t(`kind_${d.kind}`)} ${d.number} — ${money(d.grossMinor)}${d.converted ? ` (${t('converted')})` : ''}`));
    // OB-416: a tax invoice names who it is made out to — the buyer's GSTIN, legal name and State as on the day it was issued.
    if (d.kind === 'tax_invoice') {
      const b = d.buyer ?? null;
      const bill = text('span', `${t('billTo')}: ${b === null ? t('billToNone') : `${b.legalName} · GSTIN ${b.gstin} · ${b.stateName} (${b.stateCode})`}`, 'meta');
      bill.dataset.billTo = b === null ? '' : b.gstin; li.append(bill);
    }
    const src = new Map((d.pricedFrom ?? []).map((p) => [p.lineId, p.priceSource]));
    li.append(text('span', d.lines.map((l) => `${l.description} × ${l.qty} @ ${money(l.unitPriceMinor)}${src.has(l.lineId) ? ` (${t(`src_${src.get(l.lineId)}`)})` : ''}`).join(' · '), 'meta'));
    if (d.kind === 'quotation' && !d.converted && may.issue) {
      const order = button(t('toOrder'), 'check', 'to-order');
      order.addEventListener('click', async () => {
        const out = await session.convert({ customerId, quotationId: d.documentId, locationId: d.locationId ?? $('q-store').value });
        say('d-status', out);
        if (out.result === 'refused' && (out.code === 'conversion_over_limit' || out.code === 'conversion_contract_expired')) {
          const ask = button(t('askOverride'), 'hand', 'ask-override', true);
          ask.addEventListener('click', async () => { const o = await session.askOverride({ customerId, quotationId: d.documentId, locationId: d.locationId ?? $('q-store').value, valueMinor: d.grossMinor, reason: out.whatHappened }); say('d-status', o); if (o.result === 'ok') await loadAsked(); });
          li.append(ask);
        }
        if (out.result === 'ok') await openCustomer(customerId);
      });
      li.append(order);
    }
    if (d.kind === 'sales_order' && may.issue) {
      const row = document.createElement('div'); row.className = 'row-form';
      const sent = {};
      for (const l of d.lines) { const f = field(`${t('dispatchedL')}: ${l.description}`, 'dispatched'); f.input.inputMode = 'numeric'; f.input.dataset.line = l.lineId; sent[l.lineId] = f.input; row.append(f.label); }
      // OB-426: the delivery State starts as the State of the customer's GSTIN, when one is on record — and can be changed.
      const pre = api.deliveryStatePrefill ? api.deliveryStatePrefill(customer.account) : null;
      const st = field(t('deliveryState'), 'delivery-state', pre === null ? '' : pre.stateCode);
      st.input.inputMode = 'numeric'; st.input.maxLength = 2;
      const stNote = text('span', pre === null ? t('deliveryBlank') : `${pre.stateName} (${pre.stateCode}) — ${t('deliveryFromGstin')}`, 'meta delivery-note');
      st.label.append(stNote);
      row.append(st.label);
      const pf = button(t('proforma'), 'file-text', 'proforma', true);
      pf.addEventListener('click', async () => { const o = await session.proforma(customerId, d.documentId); say('d-status', o); if (o.result === 'ok') await openCustomer(customerId); });
      const dc = button(t('challan'), 'truck', 'challan');
      dc.addEventListener('click', async () => { const map = {}; for (const [k, i] of Object.entries(sent)) map[k] = i.value; const o = await session.challan(customerId, d.documentId, map); say('d-status', o); if (o.result === 'ok') await openCustomer(customerId); });
      const inv = button(t('invoice'), 'receipt', 'invoice');
      inv.addEventListener('click', async () => { const o = await session.invoice(customerId, d.documentId, st.input.value); say('d-status', o); if (o.result === 'ok') await openCustomer(customerId); });
      const acts = document.createElement('div'); acts.className = 'actions'; acts.append(pf, dc, inv);
      li.append(row, acts);
    }
    ul.append(li);
  }
  const o = $('o-rows'); o.replaceChildren();
  for (const c of customer?.orders ?? []) {
    const li = document.createElement('li'); li.dataset.order = c.orderId;
    li.append(text('strong', c.number), text('span', `${t('ordered')} ${money(c.orderedMinor)} · ${t('delivered')} ${money(c.deliveredMinor)} · ${t('billed')} ${money(c.invoicedMinor)}${c.deliveredNotInvoicedMinor > 0 ? ` · ⚠ ${t('notBilled')} ${money(c.deliveredNotInvoicedMinor)}` : ''}`, 'meta'));
    o.append(li);
  }
}
// M22-FR-03: the customer's recurring orders — each with where it stands and the days it ran; approve, pause, try a day again.
function cadenceWords(r) { return r.cadence === 'weekly' ? `${t('recEveryWeek')} ${t(`wd${r.dayOf}`)}` : `${t('recEveryMonth')} ${r.dayOf}`; }
function paintRecurring() {
  const ul = $('rec-rows'); ul.replaceChildren();
  if (recurring.length === 0) ul.append(text('li', t('recurringNone')));
  for (const r of recurring) {
    const li = document.createElement('li'); li.dataset.recurring = r.scheduleId;
    const state = r.inForce ? t('recInForce') : r.pausedBy ? t('recPaused') : t('recWaiting');
    li.append(text('strong', `${r.scheduleId} — ${state}`), text('span', `${cadenceWords(r)} · ${t('recFrom')} ${r.templateQuotationId} · ${t('recStarts')} ${r.startsOn} · ${t('recProposedBy')} ${r.proposedBy}${r.approvedBy ? ` · ${t('approvedBy')} ${r.approvedBy}` : ''}`, 'meta'));
    if (r.pausedBy) li.append(text('span', `${t('recPausedBy')} ${r.pausedBy} — ${r.pauseReason ?? ''}`, 'meta'));
    const days = new Map();
    for (const run of r.runs) if (!days.has(run.on) || run.outcome === 'generated') days.set(run.on, run);
    for (const run of [...days.values()].sort((a, b) => b.on.localeCompare(a.on))) {
      const line = text('span', `${run.on}: ${run.outcome === 'generated' ? `${t('recMade')} ${run.orderId ?? ''}` : `⚠ ${t('recCouldNot')} — ${run.detail ?? ''}`}${run.ranBy === 'system:b2b-recurring' ? ` (${t('recByItself')})` : ''}`, 'meta');
      line.dataset.run = run.on; line.dataset.outcome = run.outcome; li.append(line);
      if (run.outcome === 'exception' && may.issue) {
        const again = button(t('recRetry'), 'refresh-cw', 'rec-retry', true);
        again.addEventListener('click', async () => { const o = await session.runRecurringDay(run.on); say('rec-status', o); if (o.result === 'ok') await loadRecurring(); });
        li.append(again);
      }
    }
    const acts = document.createElement('div'); acts.className = 'actions';
    if (!r.inForce && may.approveRecurring) {
      const ok = button(t('recApprove'), 'shield-check', 'rec-approve');
      ok.addEventListener('click', async () => { const o = await session.approveRecurring(r.scheduleId); say('rec-status', o); if (o.result === 'ok') await loadRecurring(); });
      acts.append(ok);
    }
    if (r.inForce && may.issue) {
      const why = field(t('pauseReasonL'), 'rec-reason');
      const stop = button(t('recPause'), 'pause', 'rec-pause', true);
      stop.addEventListener('click', async () => { const o = await session.pauseRecurring(r.scheduleId, why.input.value); say('rec-status', o); if (o.result === 'ok') await loadRecurring(); });
      li.append(why.label); acts.append(stop);
    }
    if (acts.childElementCount > 0) li.append(acts);
    ul.append(li);
  }
  const pick = $('rec-quote'); const was = pick.value; pick.replaceChildren();
  const none = document.createElement('option'); none.value = ''; none.textContent = t('recPickQuote'); pick.append(none);
  for (const d of (customer?.documents ?? []).filter((x) => x.kind === 'quotation')) { const o = document.createElement('option'); o.value = d.documentId; o.textContent = `${d.number} — ${money(d.grossMinor)}`; pick.append(o); }
  pick.value = was;
}
async function loadRecurring() { if (customerId === null) return; const o = await session.readRecurring(customerId); if (o.result === 'ok') recurring = o.value; else say('rec-status', o); paintRecurring(); }

function paintAgeing() {
  const box = $('ageing'); box.replaceChildren();
  if (ageing === null) { box.append(text('p', t('ageingNone'), 'meta')); return; }
  box.append(fig(t('owed'), money(ageing.totalOutstandingMinor)), fig(t('overdue'), money(ageing.overdueMinor)), fig(t('disputed'), money(ageing.disputedMinor)), fig(t('chaseable'), money(ageing.chaseableMinor)));
}
function paintQuoteLines() {
  const ul = $('q-lines'); ul.replaceChildren();
  quoteLines.forEach((l, i) => {
    const li = document.createElement('li'); li.dataset.line = String(i);
    const row = document.createElement('div'); row.className = 'row-form';
    for (const [key, words] of [['productId', t('product')], ['description', t('description')], ['qty', t('qty')], ['taxPercent', t('tax')]]) {
      const f = field(words, `q-${key}`, l[key]);
      f.input.addEventListener('input', () => { l[key] = f.input.value; });
      row.append(f.label);
    }
    const rm = button(t('removeLine'), 'trash', 'remove-line', true);
    rm.addEventListener('click', () => { quoteLines.splice(i, 1); if (quoteLines.length === 0) quoteLines.push({ productId: '', description: '', qty: '', taxPercent: '5' }); paintQuoteLines(); });
    li.append(row, rm); ul.append(li);
  });
}

function paint() {
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['customers-h', 'customersH'], ['c-id-l', 'customerId'], ['c-open-text', 'open'], ['r-h', 'requestsH'], ['acct-h', 'accountH'], ['k-h', 'contractsH'],
    ['propose-h', 'proposeH'], ['k-id-l', 'contractIdL'], ['k-from-l', 'validFrom'], ['k-to-l', 'validTo'], ['k-expiry-l', 'onExpiryL'], ['k-expiry-block', 'block'], ['k-expiry-fallback', 'fallback'], ['k-limit-l', 'limitL'], ['k-terms-l', 'termsL'], ['k-prices-l', 'pricesL'], ['k-note-l', 'noteL'], ['k-save-text', 'propose'], ['k-ask-text', 'askApproval'],
    ['quote-h', 'quoteH'], ['q-note', 'priceNote'], ['q-store-l', 'storeL'], ['q-days-l', 'validDays'], ['q-add-text', 'addLine'], ['q-issue-text', 'issueQuote'],
    ['docs-h', 'docsH'], ['o-h', 'ordersH'], ['collect-h', 'collectH'], ['pay-amount-l', 'receivedL'], ['pay-save-text', 'recordPayment'],
    ['gstin-h', 'gstinH'], ['gstin-note', 'gstinNote'], ['g-gstin-l', 'gstinL'], ['g-name-l', 'gstinNameL'], ['g-reason-l', 'gstinReasonL'], ['g-save-text', 'gstinSave'], ['g-remove-text', 'removeGstin'], ['g-remove-note', 'removeGstinNote'],
    ['rec-h', 'recurringH'], ['rec-lead', 'recurringLead'], ['rec-quote-l', 'recFromL'], ['rec-cadence-l', 'cadenceL'], ['rec-cadence-weekly', 'weekly'], ['rec-cadence-monthly', 'monthly'], ['rec-day-l', 'dayOfL'], ['rec-start-l', 'startsOnL'], ['rec-sp-l', 'salespersonL'], ['rec-save-text', 'recPropose']]) $(id).textContent = t(key);
  paintDesk(); paintRequests(); paintCustomer(); paintQuoteLines(); paintRecurring();
}

async function loadDesk() { const o = await session.readDesk(); if (o.result === 'ok') desk = o.value; else say('page-status', o); paintDesk(); }
async function loadRequests() { const o = await session.readQuoteRequests(); if (o.result === 'ok') requests = o.value; paintRequests(); }
async function loadAsked() { const o = await session.readMyRequests(); if (o.result === 'ok') asked = o.value; paintAsked(); }
async function openCustomer(id) {
  const o = await session.readCustomer(id);
  if (o.result !== 'ok') { say('cust-status', o); $('customer').hidden = false; return; }
  customerId = o.value.customerId; customer = o.value;
  const ag = may.readAccount ? await session.readAgeing(customerId) : { result: 'invalid', why: 'needCustomer' };
  ageing = ag.result === 'ok' ? ag.value : null;
  await loadAsked();
  $('customer').hidden = false; $('docs').hidden = false;
  $('quote').hidden = !may.issue; $('propose').hidden = !may.manageContracts; $('collect').hidden = !may.readAccount;
  $('pay-form').hidden = !may.collect; $('pay-save').hidden = !may.collect;
  $('recurring').hidden = false; $('rec-form').hidden = !may.issue;
  $('cust-status').textContent = '';
  paintCustomer(); paintQuoteLines();
  await loadRecurring();
  void loadDesk();
}
const contractInput = () => ({ customerId: customerId ?? $('c-id').value, contractId: $('k-id').value, validFrom: $('k-from').value, validTo: $('k-to').value, onExpiry: $('k-expiry').value, prices: $('k-prices').value, limitRupees: $('k-limit').value, termsDays: $('k-terms').value, note: $('k-note').value });

for (const [id, name] of [['c-open', 'search'], ['k-save', 'file-text'], ['k-ask', 'hand'], ['q-add', 'list-plus'], ['q-issue', 'send'], ['pay-save', 'banknote'], ['g-save', 'shield-check'], ['g-remove', 'trash'], ['rec-save', 'repeat']]) { const i = icon(name); if (i !== null) $(id).prepend(i); }
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (!may.named) { $('page-status').textContent = t('nobody'); }
else if (!may.open) { $('page-status').textContent = t('cannotRead'); }
else {
  $('customers').hidden = false; void loadDesk(); void loadRequests();
  $('c-open').addEventListener('click', () => { const id = $('c-id').value.trim(); if (id === '') { $('page-status').textContent = t('needCustomer'); return; } void openCustomer(id); });
  $('q-add').addEventListener('click', () => { quoteLines.push({ productId: '', description: '', qty: '', taxPercent: '5' }); paintQuoteLines(); });
  $('q-issue').addEventListener('click', async () => {
    const out = await session.quote({ customerId: customerId ?? '', locationId: $('q-store').value, lines: quoteLines, validForDays: $('q-days').value });
    say('q-status', out);
    if (out.result === 'ok') { quoteLines.splice(0, quoteLines.length, { productId: '', description: '', qty: '', taxPercent: '5' }); await openCustomer(customerId); }
  });
  $('k-save').addEventListener('click', async () => { const out = await session.proposeContract(contractInput()); say('k-status', out); if (out.result === 'ok') await openCustomer(customerId ?? $('c-id').value); });
  $('k-ask').addEventListener('click', async () => {
    // Ask with exactly the terms just saved (the same contract id), so the approver sees what will be put in force.
    const c = contractInput();
    if (c.contractId.trim() === '') { const saved = await session.proposeContract(c); say('k-status', saved); if (saved.result !== 'ok') return; $('k-id').value = saved.value.contract.contractId; c.contractId = saved.value.contract.contractId; }
    const out = await session.askContractApproval(c, $('k-note').value); say('k-status', out); if (out.result === 'ok') await loadAsked();
  });
  $('g-save').addEventListener('click', async () => {
    const out = await session.recordGstin({ customerId: customerId ?? '', gstin: $('g-gstin').value, legalName: $('g-name').value, reason: $('g-reason').value });
    say('g-status', out);
    if (out.result === 'ok') { $('g-gstin').value = ''; $('g-name').value = ''; $('g-reason').value = ''; await openCustomer(customerId); }
  });
  $('g-remove').addEventListener('click', async () => {
    const out = await session.removeGstin({ customerId: customerId ?? '', reason: $('g-reason').value });
    say('g-status', out);
    if (out.result === 'ok') { $('g-reason').value = ''; await openCustomer(customerId); }
  });
  $('rec-save').addEventListener('click', async () => {
    const out = await session.proposeRecurring({ customerId: customerId ?? '', quotationId: $('rec-quote').value, cadence: $('rec-cadence').value, dayOf: $('rec-day').value, startsOn: $('rec-start').value, salespersonId: $('rec-sp').value });
    say('rec-status', out);
    if (out.result === 'ok') { $('rec-day').value = ''; $('rec-sp').value = ''; await loadRecurring(); }
  });
  $('pay-save').addEventListener('click', async () => { const out = await session.recordPayment(customerId ?? '', $('pay-amount').value); say('pay-status', out); if (out.result === 'ok') await openCustomer(customerId); });
}
