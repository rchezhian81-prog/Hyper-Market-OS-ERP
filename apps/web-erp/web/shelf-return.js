// Return to supplier — the view layer of the box on the Quarantine page (S1 · batch 18c · OB-872). Every word and every
// request live in the TESTED session model (apps/web-erp/src/shelf-return-session.ts, window.shelfReturnSession); this file
// draws the form, sends a press through it, and lists what has gone back. Reached also from an Expiry row
// (`/quarantine?return=1&product=…&batch=…&qty=…&reason=…`), which fills the form; nothing is sent until the button.

const $ = (id) => document.getElementById(id);
const api = window.shelfReturnSession ?? null;
const lang = () => (document.documentElement.lang === 'ta' ? 'ta' : 'en');
const w = (k) => (api === null ? k : api.words(lang(), k));
let suppliers = [];
let rows = [];

function paintWords() {
  if (api === null) return;
  $('rts-h').textContent = w('heading');
  $('rts-lede').textContent = w('lede');
  for (const k of ['product', 'place', 'batch', 'qty', 'supplier', 'note', 'value']) $(`rts-l-${k}`).textContent = w(k === 'product' ? 'item' : k === 'reason' ? 'why' : k);
  $('rts-l-reason').textContent = w('why');
  $('rts-send').textContent = w('send');
  $('rts-ask').textContent = w('ask');
  $('rts-list-h').textContent = w('listHeading');
  const reason = $('rts-reason'); const keep = reason.value;
  reason.replaceChildren(...['expired', 'near_expiry', 'damaged'].map((r) => { const o = document.createElement('option'); o.value = r; o.textContent = w(r); return o; }));
  if (keep) reason.value = keep;
  const sup = $('rts-supplier'); const keepS = sup.value;
  const first = document.createElement('option'); first.value = ''; first.textContent = w('pickSupplier');
  sup.replaceChildren(first, ...suppliers.map((s) => { const o = document.createElement('option'); o.value = s.supplierId; o.textContent = s.name; return o; }));
  if (keepS) sup.value = keepS;
  paintList();
}

function paintList() {
  const ul = $('rts-list');
  if (rows.length === 0) { const li = document.createElement('li'); li.textContent = w('none'); ul.replaceChildren(li); return; }
  const name = (id) => suppliers.find((s) => s.supplierId === id)?.name ?? id;
  ul.replaceChildren(...rows.map((r) => {
    const li = document.createElement('li'); li.dataset.return = r.returnId;
    const text = document.createElement('span');
    text.textContent = `${r.documentNumber} · ${r.productId} × ${r.quantityMinor} · ${name(r.supplierId)} · ${w(r.reason)} · ${w('debitNote')} ${r.debitNoteNumber} · ₹${(r.valueMinor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
    li.append(text);
    const printer = printNoteButton(r);
    if (printer !== null) li.append(' ', printer);
    return li;
  }));
}

/**
 * Pending 5: "Print return note" — the return on the shared A4 sheet (`window.srePrint`, batch 18b): its RTS number, the
 * SDN debit note, the batch and expiry, why, who, and where the debit note stands. Read from head office; a note opened
 * once prints again with the internet off. Read-only: it changes no stock and no money.
 */
function printNoteButton(r) {
  if (!window.srePrint) return null;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'sre-btn print-rts';
  b.dataset.return = r.returnId;
  b.textContent = w('printNote');
  b.setAttribute('aria-label', w('printNoteFor').replace('{n}', r.documentNumber));
  b.addEventListener('click', () => { void window.srePrint.openPrint({ kind: 'supplier_return', id: r.returnId }); });
  return b;
}

const form = () => ({
  productId: $('rts-product').value, locationId: $('rts-place').value, batchId: $('rts-batch').value, qty: $('rts-qty').value,
  supplierId: $('rts-supplier').value, reason: $('rts-reason').value, note: $('rts-note').value, valueRupees: $('rts-value').value,
});

function say(out) {
  const st = $('rts-status');
  st.textContent = api.outcomeWords(lang(), out);
  st.className = `status ${out.kind === 'returned' || out.kind === 'asked' ? 'good' : 'err'}`;
  $('rts-ask').hidden = out.kind !== 'needs_approval';
}

async function load() {
  const got = await api.read();
  if (got === null) return;
  suppliers = got.suppliers; rows = got.rows;
  paintWords();
}

/** Fill the form from a held batch or an Expiry row; the person still checks it and presses the button. */
window.shelfReturnPrefill = (p) => {
  if (api === null || !api.may) return;
  if (p.productId) $('rts-product').value = p.productId;
  if (p.batchId) $('rts-batch').value = p.batchId;
  if (p.qty) $('rts-qty').value = String(p.qty);
  if (p.locationId) $('rts-place').value = p.locationId;
  if (p.reason) $('rts-reason').value = p.reason;
  $('return-section').scrollIntoView({ block: 'start' });
  $('rts-qty').focus();
};

if (api !== null && api.may) {
  $('return-section').hidden = false;
  paintWords();
  $('rts-send').addEventListener('click', async () => {
    $('rts-send').disabled = true;
    try {
      const out = await api.send(form());
      say(out);
      if (out.kind === 'returned') { for (const id of ['rts-qty', 'rts-note', 'rts-value', 'rts-batch']) $(id).value = ''; await load(); }
    } finally { $('rts-send').disabled = false; }
  });
  $('rts-ask').addEventListener('click', async () => {
    $('rts-ask').disabled = true;
    try {
      const f = form();
      const out = await api.askApproval(f, `Return ${f.qty} × ${f.productId} to ${f.supplierId} (${w(f.reason)})`);
      say(out);
    } finally { $('rts-ask').disabled = false; }
  });
  $('lang').addEventListener('click', () => { setTimeout(paintWords, 0); });
  document.addEventListener('sre:chrome', () => paintWords());
  const q = new URLSearchParams(location.search);
  void load().then(() => {
    if (q.get('return') === '1') window.shelfReturnPrefill({ productId: q.get('product'), batchId: q.get('batch'), qty: q.get('qty'), locationId: q.get('place'), reason: q.get('reason') });
  });
}
