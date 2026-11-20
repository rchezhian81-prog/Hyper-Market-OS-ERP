// Supplier bills — the second person's check of a typed bill, and debit notes (W4 · WF-05 · M07 · §28 · hard rules #2 #10).
// Every rule lives in the TESTED session (apps/web-erp/src/supplier-bills-to-the-books-session.ts, window.billCheck). This
// file only reads the typing form, draws the checks asked for and a supplier's debit notes, and passes each click through:
// the typed bill is asked to be checked by a second person (who approves it on their own Approvals page), then saved here
// exactly as checked, naming that approval; a debit note is issued its number once. Nothing is read on open.
// No prompt/confirm/alert.

const $ = (id) => document.getElementById(id);
const bc = window.billCheck ?? null;
let lang = document.documentElement.lang === 'ta' ? 'ta' : 'en';
const w = (k) => bc.words(lang, k);
const money = (minor) => bc.rupees(minor);
let asked = null; let account = null;

function el(tag, words, cls) { const n = document.createElement(tag); if (words !== undefined) n.textContent = words; if (cls) n.className = cls; return n; }
const status = (node, out, good) => { node.textContent = bc.outcomeWords(lang, out, good); node.dataset.result = out.result; };

/** The bill as typed in the typing form — the same body "Save this bill" sends (the scan it was typed from named). */
function typedBill() {
  const lines = [...document.querySelectorAll('#type-lines tr[data-row]')].map((tr) => {
    const v = (f) => tr.querySelector(`.t-${f}`)?.value ?? '';
    return { productId: v('productId'), quantity: v('quantity'), unitPrice: v('unitPrice'), amount: v('amount'), cgst: v('cgst'), sgst: v('sgst') };
  }).filter((l) => Object.values(l).some((x) => String(x).trim() !== ''));
  return bc.typedBody({
    invoiceId: $('type-invoice').value, supplierId: $('type-supplier').value, poId: $('type-po').value, total: $('type-total').value, lines,
    documentId: $('type-invoice').dataset.doc ?? '', charges: { freight: $('type-freight').value, duty: $('type-duty').value, other: $('type-other').value },
    roundOff: $('type-round-off').value, // OB-866 B: the paper's round off — checked by the second person with the rest
  });
}

/** Batch 20b · A2: the typed lines whose GST rate differs from the item's — the bill itself is sent unchanged. */
function rateSecondLook() {
  const lines = [...document.querySelectorAll('#type-lines tr[data-row]')].map((tr) => {
    const rate = tr.querySelector('.t-rate');
    const bps = rate?.dataset.itemBps;
    return { productId: tr.querySelector('.t-productId')?.value ?? '', rate: rate?.value ?? '', itemBps: bps === undefined || bps === '' ? undefined : Number(bps) };
  }).filter((l) => l.productId.trim() !== '');
  return typeof bc.rateSecondLook === 'function' ? bc.rateSecondLook(lines) : [];
}

function paintChecks() {
  const ul = $('chk-list'); ul.replaceChildren();
  if (asked === null) return;
  const open = asked.filter((r) => r.status !== 'used');
  if (open.length === 0) { ul.append(el('li', w('checksNone'))); return; }
  for (const r of open) {
    const li = document.createElement('li'); li.dataset.check = r.subjectRef; li.dataset.status = r.status;
    li.append(el('strong', `${r.summary} — ${w(r.status)}`));
    if (r.decidedBy) li.append(el('span', `${w('checkedBy')} ${r.decidedBy}${r.decisionReason ? ` — ${r.decisionReason}` : ''}`, 'muted'));
    if (r.status === 'approved') {
      const go = el('button', w('saveChecked'), 'chk-save'); go.type = 'button';
      go.addEventListener('click', async () => {
        const out = await bc.session.saveChecked(r);
        $('chk-status').dataset.result = out.result;
        $('chk-status').textContent = out.result === 'ok' ? `${w('savedChecked')} ${out.value.approvedBy ?? r.decidedBy ?? ''} — ${out.value.invoiceId}.` : bc.outcomeWords(lang, out, '');
        if (out.result === 'ok') { window.dispatchEvent(new Event('sre-bills-changed')); await showChecks(); }
      });
      li.append(go);
    }
    ul.append(li);
  }
}
async function showChecks() {
  const out = await bc.session.asked();
  if (out.result !== 'ok') { status($('chk-status'), out, ''); return; }
  asked = out.value; paintChecks();
}

function paintDebitNotes() {
  const ul = $('dn-list'); ul.replaceChildren();
  if (account === null) return;
  $('dn-owed').textContent = account.totals ? `${w('dnOwed')}: ${money(account.totals.owedMinor)}` : '';
  paintShelfNotes();
  // OB-879: an accepted shelf-return note is listed with the shelf notes below, not twice.
  const shelfRefs = new Set((account.shelfReturnDebitNotes ?? []).map((d) => d.debitNoteRef));
  const notes = account.debitNotes.filter((d) => !shelfRefs.has(d.debitNoteRef));
  if (notes.length === 0) { ul.append(el('li', w('dnNone'))); return; }
  for (const d of notes) {
    const li = document.createElement('li'); li.dataset.debitNote = d.debitNoteRef; li.dataset.issued = String(d.number !== null);
    li.append(el('strong', `${d.debitNoteRef} · ${d.productId} × ${d.quantityMinor} · ${money(d.valueMinor)} — ${d.number === null ? w('dnNotIssued') : `${w('dnIssued')} ${d.number}`}`));
    if (d.reason) li.append(el('span', d.reason, 'muted'));
    if (d.number === null) {
      const go = el('button', w('dnIssue'), 'dn-issue'); go.type = 'button';
      go.addEventListener('click', async () => {
        const out = await bc.session.issueDebitNote(account.supplierId, d.debitNoteRef);
        $('dn-status').dataset.result = out.result;
        $('dn-status').textContent = out.result === 'ok' ? `${w('dnIssued')} ${out.value.number}.` : bc.outcomeWords(lang, out, '');
        if (out.result === 'ok') await showDebitNotes();
      });
      li.append(go);
    }
    ul.append(li);
  }
}
/** OB-879: the debit notes for shelf stock sent back — waiting ones offer "Supplier accepted"; accepted ones say what came off. */
function paintShelfNotes() {
  const ul = $('dn-shelf'); ul.replaceChildren();
  if (account === null) return;
  const shelf = account.shelfReturnDebitNotes ?? [];
  if (shelf.length === 0) { ul.append(el('li', w('shelfNone'), 'muted')); return; }
  for (const d of shelf) {
    const li = document.createElement('li'); li.dataset.shelfNote = d.debitNoteRef; li.dataset.state = d.state;
    const head = `${d.number ?? d.debitNoteRef}${d.returnNumber ? ` (${d.returnNumber})` : ''} · ${d.productId} × ${d.quantityMinor} · ${money(d.valueMinor)}`;
    const a = d.acceptance;
    li.append(el('strong', a === null ? `${head} — ${w('shelfWaiting')}` : `${head} — ${w('shelfAccepted')} ${a.supplierCreditNoteNo} · ${a.supplierCreditNoteDate} · ${money(a.acceptedMinor)} ${w('shelfTakenOff')}`, 'shelf-head'));
    const gstBack = a?.gst ? a.gst.cgstMinor + a.gst.sgstMinor + a.gst.igstMinor : 0;
    if (gstBack > 0) li.append(el('span', `${money(gstBack)} ${w('shelfGstReversed')}`, 'muted shelf-gst'));
    if (a !== null && a.differenceMinor > 0) li.append(el('span', `${money(a.differenceMinor)} ${w('shelfNotAccepted')}${a.reason ? ` — ${a.reason}` : ''}`, 'muted shelf-diff'));
    if (a === null) {
      const box = (cls, label, type) => { const l = document.createElement('label'); l.append(el('span', label)); const i = document.createElement('input'); i.className = cls; i.type = type; i.autocomplete = 'off'; l.append(i); return l; };
      li.append(box('shelf-cn', w('shelfCnNo'), 'text'), box('shelf-date', w('shelfCnDate'), 'date'), box('shelf-amount', w('shelfAmount'), 'text'), box('shelf-reason', w('shelfReason'), 'text'),
        // OB-881 B: the GST the supplier's credit note shows, by head — optional.
        box('shelf-cgst', w('shelfCgst'), 'text'), box('shelf-sgst', w('shelfSgst'), 'text'), box('shelf-igst', w('shelfIgst'), 'text'));
      const go = el('button', w('shelfAccept'), 'shelf-accept sre-btn'); go.type = 'button';
      go.addEventListener('click', async () => {
        const v = (cls) => li.querySelector(`.${cls}`)?.value ?? '';
        const out = await bc.session.acceptShelfNote(account.supplierId, d.debitNoteRef, { creditNoteNo: v('shelf-cn'), creditNoteDate: v('shelf-date'), accepted: v('shelf-amount'), reason: v('shelf-reason'), cgst: v('shelf-cgst'), sgst: v('shelf-sgst'), igst: v('shelf-igst') });
        $('dn-status').dataset.result = out.result;
        $('dn-status').textContent = out.result === 'ok' ? `${w('shelfDone')} ${money(out.value.acceptance.acceptedMinor)}.` : bc.outcomeWords(lang, out, '');
        if (out.result === 'ok') await showDebitNotes();
      });
      li.append(go);
    }
    ul.append(li);
  }
}
async function showDebitNotes() {
  const supplierId = $('dn-supplier').value;
  const out = await bc.session.account(supplierId);
  if (out.result !== 'ok') { status($('dn-status'), out, ''); return; }
  account = { ...out.value, supplierId: supplierId.trim() }; paintDebitNotes();
}

function paintWords() {
  for (const [id, k] of [['chk-h', 'checkH'], ['chk-lede', 'checkLead'], ['chk-show', 'checksH'], ['type-ask', 'askCheck'],
    ['dn-h', 'dnH'], ['dn-lede', 'dnLead'], ['l-dn-supplier', 'dnSupplierL'], ['dn-show', 'dnShow'], ['dn-shelf-h', 'shelfH']]) $(id).textContent = w(k);
  paintChecks(); paintDebitNotes();
}

if (bc !== null && (bc.session.may.capture || bc.session.may.match)) {
  $('chk-section').hidden = false;
  $('chk-show').hidden = !bc.session.may.capture;
  $('type-ask').hidden = !bc.session.may.capture;
  $('dn-part').hidden = !bc.session.may.match;
  paintWords();
  $('chk-show').addEventListener('click', () => { void showChecks(); });
  $('dn-show').addEventListener('click', () => { void showDebitNotes(); });
  $('type-ask').addEventListener('click', async () => {
    const typed = typedBill();
    if (!typed.ok) { $('type-status').dataset.result = 'invalid'; $('type-status').textContent = w(typed.problem === 'needs_invoice_supplier_total' ? 'needBill' : 'notMoney'); return; }
    const out = await bc.session.askCheck({ invoiceId: typed.invoiceId, body: typed.body, secondLook: rateSecondLook() });
    status($('type-status'), out, 'askedCheck');
    if (out.result === 'ok') await showChecks();
  });
  // The page's one language toggle (supplier-bills.js flips it first); this section follows.
  $('lang').addEventListener('click', () => { lang = document.documentElement.lang === 'ta' ? 'ta' : 'en'; paintWords(); });
}
