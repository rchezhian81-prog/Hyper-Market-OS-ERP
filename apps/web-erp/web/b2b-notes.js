// Business customers — GST credit and debit notes (W3 · M23-FR-02 · OB-678 · OB-290 · §28 · hard rules #2 #10).
// Every rule lives in the TESTED session (apps/web-erp/src/b2b-notes-session.ts, window.b2bNotes). This file only draws the
// open customer's tax invoices, the notes asked for and issued, and passes each click through: every note (credit or debit)
// is worked out by head office and a second person's approval of exactly it is asked (OB-678 · OB-679) — once approved,
// "Issue the approved note" issues it. The page never sends invoice figures. Nothing is read on open.
// No prompt/confirm/alert.

const $ = (id) => document.getElementById(id);
const nt = window.b2bNotes ?? null;
let lang = document.documentElement.lang === 'ta' ? 'ta' : 'en';
const w = (k) => nt.words(lang, k);
const money = (minor) => nt.rupees(minor);
const REASONS = ['goods_returned', 'deficiency_in_service', 'post_supply_discount', 'price_correction', 'tax_rate_correction', 'order_cancelled'];
let customerId = null;

function el(tag, words, cls) { const n = document.createElement(tag); if (words !== undefined) n.textContent = words; if (cls) n.className = cls; return n; }
function select(cls, options) { const s = document.createElement('select'); s.className = cls; for (const [value, words] of options) { const o = document.createElement('option'); o.value = value; o.textContent = words; s.append(o); } return s; }
function labelled(words, control) { const l = document.createElement('label'); l.append(el('span', words), control); return l; }
const status = (out, good) => { $('cn-status').textContent = nt.outcomeWords(lang, out, good); $('cn-status').dataset.result = out.result; };
const currentCustomer = () => { const shown = ($('cust-h')?.textContent ?? '').trim(); return shown !== '' ? shown : ($('c-id')?.value ?? '').trim(); };

function paintInvoices(view) {
  const ul = $('cn-invoices'); ul.replaceChildren();
  if (view.invoices.length === 0) { ul.append(el('li', w('invoicesNone'))); return; }
  for (const inv of view.invoices) {
    const li = document.createElement('li'); li.dataset.invoice = inv.documentId;
    li.append(el('strong', `${inv.number} · ${inv.issuedOn} · ${money(inv.grossMinor)}${inv.recipientGstin ? ` · GSTIN ${inv.recipientGstin}` : ''}`));
    if (!inv.hasGstSplit) { li.append(el('span', w('noSplit'), 'meta')); ul.append(li); continue; }
    const typed = {};
    const rows = document.createElement('div'); rows.className = 'row-form';
    for (const l of inv.lines) {
      const input = document.createElement('input'); input.className = 'cn-line'; input.dataset.line = l.lineId; input.inputMode = 'decimal'; input.autocomplete = 'off';
      typed[l.lineId] = input;
      const label = labelled(`${l.description} × ${l.qty} (${l.rateBps / 100}%) — ${w('charged')} ${money(l.chargedMinor)} · ${w('credited')} ${money(l.creditedMinor)} · ${w('left')} ${money(l.leftMinor)}. ${w('lineValueL')}`, input);
      rows.append(label);
    }
    const kind = select('cn-kind', [['credit_note', w('kind_credit_note')], ['debit_note', w('kind_debit_note')]]);
    const reason = select('cn-reason', [['', '—'], ...REASONS.map((r) => [r, w(`reason_${r}`)])]);
    rows.append(labelled(w('kindL'), kind), labelled(w('reasonL'), reason));
    const go = document.createElement('button'); go.type = 'button'; go.className = 'cn-raise'; go.textContent = w('askCredit');
    go.addEventListener('click', async () => {
      const rupeesByLine = {}; for (const [k, i] of Object.entries(typed)) rupeesByLine[k] = i.value;
      const out = await nt.session.raise({ kind: kind.value, customerId: customerId ?? '', invoiceDocumentId: inv.documentId, reason: reason.value, rupeesByLine });
      status(out, 'askedNow');
      if (out.result === 'ok') await show();
    });
    li.append(rows, go); ul.append(li);
  }
}

function paintAsked(asked) {
  const ul = $('cn-asked'); ul.replaceChildren();
  for (const r of asked.filter((x) => x.details && x.details.customerId === customerId && x.status !== 'used')) {
    const li = document.createElement('li'); li.dataset.asked = r.requestId; li.dataset.status = r.status;
    li.append(el('strong', `${r.summary} — ${w(r.status)}`));
    if (r.decidedBy) li.append(el('span', `${w(r.status === 'rejected' ? 'rejectedBy' : 'approvedBy')} ${r.decidedBy}${r.decisionReason ? ` — ${r.decisionReason}` : ''}`, 'meta'));
    if (r.status === 'approved') {
      const go = document.createElement('button'); go.type = 'button'; go.className = 'cn-issue'; go.textContent = w('issueApproved');
      go.addEventListener('click', async () => { const out = await nt.session.issueApproved(r); status(out, 'issuedNow'); if (out.result === 'ok') await show(); });
      li.append(go);
    }
    ul.append(li);
  }
}

function paintNotes(view) {
  const ul = $('cn-notes'); ul.replaceChildren();
  if (view.notes.length === 0) { ul.append(el('li', w('notesNone'))); return; }
  for (const n of view.notes) {
    const li = document.createElement('li'); li.dataset.note = n.number; li.dataset.posting = n.posting.state;
    li.append(el('strong', `${n.number} · ${w(`kind_${n.kind}`)} · ${w('against')} ${n.againstInvoiceNumber} · ${money(n.taxableMinor)} + ${w('tax')} ${money(n.taxMinor)} = ${money(n.grossMinor)}`));
    li.append(el('span', `${n.issuedOn} · ${w(`reason_${n.reason}`)}${n.approvedBy ? ` · ${w('approvedBy')} ${n.approvedBy}` : ''}${n.taxAdjustable ? '' : ` · ⚠ ${w('notInWindow')}`}`, 'meta'));
    li.append(el('span', `${n.posting.state === 'waiting_for_posting_rule' ? '⚠ ' : ''}${w(`posting_${n.posting.state}`)}`, 'meta cn-posting'));
    ul.append(li);
  }
}

async function show() {
  customerId = currentCustomer();
  const out = await nt.session.read(customerId);
  if (out.result !== 'ok') { status(out, ''); return; }
  paintInvoices(out.value); paintNotes(out.value);
  const asked = await nt.session.asked();
  paintAsked(asked.result === 'ok' ? asked.value : []);
}

// W4 · M23-FR-02: the month's credit notes against the books, as head office read them from the posted ledger.
const signed = (minor) => `${minor > 0 ? '+' : minor < 0 ? '−' : ''}${money(Math.abs(minor))}`;
let reconciled = null;
function paintReconciliation(r) {
  const figs = $('cnr-figs'); figs.replaceChildren();
  const fig = (key, words, value) => { const d = el('div', undefined, 'fig'); d.dataset.fig = key; d.append(el('span', words, 'meta'), el('strong', value)); figs.append(d); };
  fig('notes', w('notesSide'), `${r.notesIssued} ${w('notesCount')} · ${money(r.notesTotalMinor)} (${w('valueL')} ${money(r.creditedTaxableMinor)} + ${w('gstL')} ${money(r.creditedTaxMinor)})`);
  fig('books', w('booksSide'), r.ledger.split === 'by_account'
    ? `${money(r.ledger.totalMinor)} (${w('valueL')} ${money(r.ledger.taxableMinor)} + ${w('gstL')} ${money(r.ledger.taxMinor)})`
    : `${money(r.ledger.totalMinor)} — ${w('splitUnknown')}`);
  fig('difference', w('diffL'), `${signed(r.differenceMinor)} — ${w(r.reconciles ? 'agrees' : 'differs')}`);
  figs.dataset.reconciles = String(r.reconciles);
  const ul = $('cnr-missing'); ul.replaceChildren();
  if (r.outsideTaxWindowMinor > 0) ul.append(el('li', `⚠ ${money(r.outsideTaxWindowMinor)} ${w('outsideWindow')}`, 'meta'));
  if (r.notInTheBooks.length === 0) { ul.append(el('li', w('missingNone'))); return; }
  ul.append(el('li', w('missingH'), 'meta'));
  for (const n of r.notInTheBooks) {
    const li = el('li', `⚠ ${n.number} · ${money(n.grossMinor)} · ${w(`state_${n.state}`)}${n.postedToPeriod ? ` ${n.postedToPeriod}` : ''}`);
    li.dataset.missing = n.number; li.dataset.state = n.state; ul.append(li);
  }
}
async function reconcile() {
  const out = await nt.session.reconcile($('cnr-period').value);
  $('cnr-status').dataset.result = out.result;
  if (out.result !== 'ok') { $('cnr-status').textContent = nt.outcomeWords(lang, out, ''); return; }
  $('cnr-status').textContent = '';
  reconciled = out.value; paintReconciliation(reconciled);
}

function paintWords() {
  for (const [id, k] of [['cn-h', 'h'], ['cn-lead', 'lead'], ['cn-show-text', 'show'], ['cn-asked-h', 'askedH'], ['cn-notes-h', 'notesH'],
    ['cnr-h', 'reconH'], ['cnr-lead', 'reconLead'], ['cnr-period-l', 'periodL'], ['cnr-show-text', 'reconShow']]) $(id).textContent = w(k);
  if (reconciled !== null) paintReconciliation(reconciled);
}

if (nt !== null && nt.session.may.issue) {
  $('cn').hidden = false;
  paintWords();
  $('cn-show').addEventListener('click', () => { void show(); });
  $('cnr-show').addEventListener('click', () => { void reconcile(); });
  // The page's one language toggle (b2b.js flips it first); this section follows.
  $('lang').addEventListener('click', () => { lang = document.documentElement.lang === 'ta' ? 'ta' : 'en'; paintWords(); if (customerId !== null) void show(); });
}
