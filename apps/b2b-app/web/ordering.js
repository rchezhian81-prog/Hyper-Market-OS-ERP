// Business-customer portal — ASK, ORDER and PAY (W3 · M22-FR-04 · API-09 · OB-41 "A" · §28 · P-04 · P-08 · hard rule #3).
// Every rule lives in the TESTED session (apps/b2b-app/src/b2b-portal-ordering-session.ts, window.b2bOrdering). This file
// only draws what the session hands it and passes each click through: ask the shop for a quote (items and quantities —
// the shop prices it), place an order from one of the quotations the shop sent (at the quoted price; head office checks
// credit and stock), and tell the shop a bank transfer was sent (it stays "waiting" until the shop's finance team finds
// the money in its own bank). Nothing is read or written on open; "Show my orders and payments" is a click (GETs). No card
// or bank-account detail is asked. No prompt/confirm/alert.

const el = (id) => document.getElementById(id);
const ord = window.b2bOrdering ?? null;
let lang = document.documentElement.lang === 'ta' ? 'ta' : 'en';
const w = (k) => ord.words(lang, k);
const rupees = (minor) => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
let askRows = [{ productId: '', qty: '' }];

function li(text, cls, data) {
  const node = document.createElement('li');
  node.className = `row ${cls ?? ''}`.trim();
  for (const [k, v] of Object.entries(data ?? {})) node.dataset[k] = v;
  node.textContent = text;
  return node;
}
function say(id, out, good) { el(id).textContent = ord.outcomeWords(lang, out, good); el(id).dataset.result = out.result; }

function paintAskRows() {
  el('ask-lines').replaceChildren(...askRows.flatMap((r, i) => ['productId', 'qty'].map((field) => {
    const label = document.createElement('label'); label.className = 'field';
    const span = document.createElement('span'); span.textContent = w(field === 'productId' ? 'product' : 'qty');
    const input = document.createElement('input'); input.type = 'text'; input.id = `ask-${field}-${i}`; input.autocomplete = 'off'; input.value = r[field];
    if (field === 'qty') input.inputMode = 'numeric';
    input.addEventListener('input', () => { askRows[i] = { ...askRows[i], [field]: input.value }; });
    label.append(span, input);
    return label;
  })));
}

async function paintQuotations() {
  const out = await ord.session.openQuotations();
  const select = el('order-quote');
  const list = out.result === 'ok' ? out.value : [];
  select.replaceChildren(...list.map((q) => { const o = document.createElement('option'); o.value = q.documentId; o.textContent = `${q.number} · ${rupees(q.grossMinor)}${q.validUntil ? ` · ${q.validUntil}` : ''}`; return o; }));
  el('order-none').hidden = list.length > 0;
  el('order-none').textContent = out.result === 'ok' ? w('noQuotation') : ord.outcomeWords(lang, out, '');
  el('order-go').hidden = list.length === 0;
}

async function show() {
  const [orders, notes] = await Promise.all([ord.session.myOrders(), ord.session.myNotes()]);
  el('ord-body').hidden = false;
  el('ord-status').textContent = orders.result === 'ok' ? '' : ord.outcomeWords(lang, orders, '');
  const o = orders.result === 'ok' ? orders.value : { orders: [], quoteRequests: [] };
  el('ord-orders').replaceChildren(...(o.orders.length === 0 ? [li(w('ordersNone'), 'tone-idle')] : o.orders.map((x) => li(`${x.number} · ${rupees(x.grossMinor)}${x.derivedFrom ? ` · ${x.derivedFrom}` : ''}`, 'tone-ok', { order: x.orderId }))));
  el('ord-requests').replaceChildren(...(o.quoteRequests.length === 0 ? [li(w('requestsNone'), 'tone-idle')] : o.quoteRequests.map((r) => li(`${r.requestId} · ${r.lines.map((l) => `${l.productId} × ${l.qty}`).join(', ')}${r.note ? ` · ${r.note}` : ''}`, 'tone-idle', { request: r.requestId }))));
  if (notes.result === 'ok') {
    el('ord-owed').textContent = `${w('owedNow')}: ${rupees(notes.value.outstandingMinor)} · ${w('pendingNow')}: ${rupees(notes.value.pendingMinor)}`;
    el('ord-notes').replaceChildren(...(notes.value.notes.length === 0 ? [li(w('notesNone'), 'tone-idle')] : notes.value.notes.map((n) => li(
      `${rupees(n.amountMinor)} · ${n.transferredOn} · ${n.bankReference} · ${w(`st_${n.state}`)}${n.reason ? ` — ${n.reason}` : ''}`,
      n.state === 'matched' ? 'tone-ok' : n.state === 'rejected' ? 'tone-error' : 'tone-degraded', { note: n.noteId, state: n.state }))));
  } else {
    el('ord-owed').textContent = ord.outcomeWords(lang, notes, '');
    el('ord-notes').replaceChildren();
  }
  await paintQuotations();
}

function paintWords() {
  for (const [id, k] of [['ord-h', 'h'], ['ord-lead', 'lead'], ['ord-show', 'show'], ['ord-orders-h', 'ordersH'], ['ord-requests-h', 'requestsH'], ['ord-notes-h', 'notesH'],
    ['ask-h', 'askH'], ['ask-add', 'addLine'], ['l-ask-note', 'note'], ['ask-go', 'ask'], ['order-h', 'orderH'], ['l-order-quote', 'quotation'], ['order-go', 'order'],
    ['pay-h', 'payH'], ['l-pay-amount', 'amount'], ['l-pay-on', 'sentOn'], ['l-pay-ref', 'reference'], ['l-pay-against', 'against'], ['pay-go', 'pay']]) el(id).textContent = w(k);
  paintAskRows();
}

if (ord !== null && ord.session.may.named) {
  el('ordering').hidden = false;
  paintWords();
  el('ord-show').addEventListener('click', () => { void show(); });
  el('ask-add').addEventListener('click', () => { askRows = [...askRows, { productId: '', qty: '' }]; paintAskRows(); });
  el('ask-go').addEventListener('click', async () => {
    const out = await ord.session.askForQuote(askRows, el('ask-note').value);
    say('ask-status', out, 'askedNow');
    if (out.result === 'ok') { askRows = [{ productId: '', qty: '' }]; el('ask-note').value = ''; paintAskRows(); await show(); }
  });
  el('order-go').addEventListener('click', async () => {
    const out = await ord.session.placeOrder(el('order-quote').value);
    say('order-status', out, 'placedNow');
    if (out.result === 'ok') { el('order-status').textContent += ` ${out.value.number} · ${rupees(out.value.grossMinor)}`; await show(); }
  });
  el('pay-go').addEventListener('click', async () => {
    const out = await ord.session.tellPaid({ amountRupees: el('pay-amount').value, sentOn: el('pay-on').value, bankReference: el('pay-ref').value, against: el('pay-against').value });
    say('pay-status', out, 'paidNow');
    if (out.result === 'ok') { for (const id of ['pay-amount', 'pay-on', 'pay-ref', 'pay-against']) el(id).value = ''; await show(); }
  });
  // The page's one language toggle (app.js flips it first); this section follows.
  el('lang').addEventListener('click', () => { lang = document.documentElement.lang === 'ta' ? 'ta' : 'en'; paintWords(); });
}
