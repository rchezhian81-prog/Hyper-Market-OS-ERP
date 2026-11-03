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
  });
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
  if (account.debitNotes.length === 0) { ul.append(el('li', w('dnNone'))); return; }
  for (const d of account.debitNotes) {
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
async function showDebitNotes() {
  const supplierId = $('dn-supplier').value;
  const out = await bc.session.account(supplierId);
  if (out.result !== 'ok') { status($('dn-status'), out, ''); return; }
  account = { ...out.value, supplierId: supplierId.trim() }; paintDebitNotes();
}

function paintWords() {
  for (const [id, k] of [['chk-h', 'checkH'], ['chk-lede', 'checkLead'], ['chk-show', 'checksH'], ['type-ask', 'askCheck'],
    ['dn-h', 'dnH'], ['dn-lede', 'dnLead'], ['l-dn-supplier', 'dnSupplierL'], ['dn-show', 'dnShow']]) $(id).textContent = w(k);
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
    const out = await bc.session.askCheck({ invoiceId: typed.invoiceId, body: typed.body });
    status($('type-status'), out, 'askedCheck');
    if (out.result === 'ok') await showChecks();
  });
  // The page's one language toggle (supplier-bills.js flips it first); this section follows.
  $('lang').addEventListener('click', () => { lang = document.documentElement.lang === 'ta' ? 'ta' : 'en'; paintWords(); });
}
