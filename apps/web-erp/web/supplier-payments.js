// Suppliers · "Record a payment to a supplier" (W5 · M23-FR-01 · §28). Every rule and word lives in the TESTED session
// (apps/web-erp/src/supplier-payment-session.ts, window.supplierPayments). It RECORDS that money was paid — no money moves
// from this page. Ask → a different person approves on their Approvals page → record here, naming that approval; what is
// recorded is exactly what was approved. Nothing is read on open. No prompt/confirm/alert.
// U7 · OB-724: the same section is on the Suppliers page AND the Supplier bills page; the supplier is picked by name, the day
// is the shop's dd/mm/yyyy field, the bills it settles are ticked from the supplier's matched, unpaid bills (D-047), and
// recording asks the shared confirm sheet first.
// OB-807 A (owner, in writing): asked and approved on the amount and the bills; the day it was paid and its reference are
// typed in the "record it when paid" boxes once the money has gone, and go with the approved line when it is recorded.

const $ = (id) => document.getElementById(id);
const api = window.supplierPayments ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, pay: false };
const lang = () => (document.documentElement.lang === 'ta' ? 'ta' : 'en');
const w = (k, fill) => (api === null ? k : api.words(lang(), k, fill));
const node = (tag, props = {}, ...kids) => { const n = document.createElement(tag); Object.assign(n, props); n.append(...kids); return n; };
function say(id, text, result = '') { const el = $(id); el.textContent = text; el.dataset.result = result; }

let asks = null;
const office = () => window.sreOffice ?? null;
const supplierName = (id) => { const o = office(); const n = o ? o.nameOf('supplier', id) : id; return n && n !== id ? `${n} (${id})` : id; };
const dayWords = (iso) => window.sreShopDay?.dateOf(iso) ?? iso;
const paidOnValue = () => { const o = office(); const iso = o ? o.dateOf('pay-on') : null; return typeof iso === 'string' && iso !== '' ? iso : ($('pay-on')?.value ?? ''); };
const settlesWords = (d) => (Array.isArray(d.settles) && d.settles.length > 0 ? ` · ${w('settlesShown', { bills: d.settles.join(', ') })}` : '');

/** Recording is money (OB-698): the confirm sheet says the figure, the supplier, the day, how and the reference first. */
async function confirmed(a, paid) {
  const o = office(); if (o === null) return true;
  const d = { ...a.details, paidOn: a.details.paidOn ?? paid.paidOn, reference: a.details.reference ?? paid.reference };
  const out = await o.confirm({
    title: w('confirmTitle', { amount: api.rupees(Number(d.amountMinor)), supplier: supplierName(String(d.supplierId)) }),
    detail: w('confirmDetail', { day: dayWords(String(d.paidOn)), method: w(`m_${String(d.method)}`), ref: String(d.reference) }) + settlesWords(d),
    authority: w('confirmAuthority', { approver: a.decidedBy ? (o.nameOf('person', a.decidedBy) || a.decidedBy) : '—' }), confirmLabel: w('confirmLabel'), tone: 'primary',
  });
  return out.ok === true;
}

function paint() {
  for (const [id, k] of [['pay-h', 'payH'], ['pay-lead', 'payLede'], ['l-pay-supplier', 'supplier'], ['l-pay-amount', 'amount'], ['l-pay-on', 'paidOn'], ['l-pay-method', 'method'], ['l-pay-ref', 'reference'],
    ['pay-record-h', 'recordH'], ['pay-record-lead', 'recordLede'], ['pay-ask', 'ask'], ['pay-asks-h', 'myAsksH'], ['pay-asks-show', 'showAsks'], ['l-pay-settles', 'settles']]) { const n = $(id); if (n) n.textContent = w(k); }
  const sel = $('pay-method'); const keep = sel.value;
  sel.replaceChildren(...api.methods.map((m) => node('option', { value: m, textContent: w(`m_${m}`) })));
  if (keep !== '') sel.value = keep;
  if ($('pay-bills-list') !== null) drawBills();
  const list = $('pay-asks'); list.replaceChildren();
  if (asks === null) return;
  if (asks.length === 0) { list.append(node('li', { textContent: w('noAsks') })); return; }
  for (const a of asks) {
    const d = a.details;
    const li = node('li'); li.dataset.ask = a.requestId; li.dataset.status = a.status;
    const when = d.paidOn === undefined ? '' : ` · ${dayWords(String(d.paidOn))} · ${String(d.reference)}`;
    li.append(node('strong', { textContent: `${supplierName(String(d.supplierId))} · ${api.rupees(Number(d.amountMinor))} · ${w(`m_${String(d.method)}`)}${when}${settlesWords(d)}` }), ' ',
      node('span', { className: 'note', textContent: `${w(`st_${a.status}`)}${a.decidedBy ? ` · ${a.decidedBy}` : ''}` }));
    if (a.status === 'approved') {
      const go = node('button', { type: 'button', className: 'act sre-btn pay-record', textContent: w('record') });
      go.addEventListener('click', async () => {
        go.disabled = true;
        try {
          // OB-807 A: the day it was paid and its reference, typed now that the money has gone.
          const paid = { paidOn: paidOnValue(), reference: $('pay-ref').value };
          if (a.details.paidOn === undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(paid.paidOn) || paid.reference.trim() === '')) { say('pay-status', w('needPaid'), 'err'); return; }
          if (a.details.paidOn === undefined && paid.paidOn > api.today()) { say('pay-status', w('paidInFuture'), 'err'); return; }
          if (!(await confirmed(a, paid))) { say('pay-status', w('notConfirmed'), 'err'); return; }
          const out = await session.record(a, paid);
          if (out.result !== 'ok') { say('pay-status', api.outcomeWords(lang(), out), 'err'); return; }
          say('pay-status', out.value.alreadyRecorded ? w('already') : w('recorded', { owed: api.rupees(out.value.owedMinor ?? 0) }), 'ok');
          await loadAsks();
        } finally { go.disabled = false; }
      });
      li.append(go);
    }
    list.append(li);
  }
}

// ── D-047 (fix batch 3): the bills it settles — the chosen supplier's matched, unpaid bills as tick boxes, with the total ──
let openBills = null; // null: no supplier chosen yet; [] none waiting
let billsFor = '';
let billsWhy = ''; // a refusal's words, when head office would not say
let autoAmount = null; // the amount this section put in the box from the ticks (a typed amount is never overwritten)
const ticked = () => [...document.querySelectorAll('#pay-bills-list input[type="checkbox"]:checked')].map((b) => b.value);
function drawTotal() {
  const ids = new Set(ticked());
  const total = (openBills ?? []).filter((b) => ids.has(b.invoiceId)).reduce((s, b) => s + b.payableMinor, 0);
  $('pay-bills-total').textContent = openBills === null || openBills.length === 0 ? '' : ids.size === 0 ? w('billsNoneTicked') : w('billsTotal', { n: ids.size, total: api.rupees(total) });
  $('pay-bills-total').dataset.totalMinor = String(total);
  const box = $('pay-amount');
  if (ids.size > 0 && (box.value.trim() === '' || box.value === autoAmount)) { autoAmount = (total / 100).toFixed(2); box.value = autoAmount; }
}
function drawBills() {
  const keep = new Set(ticked());
  const note = $('pay-bills-note');
  note.textContent = billsWhy !== '' ? billsWhy : openBills === null ? w('billsPick') : openBills.length === 0 ? w('billsNone') : '';
  $('pay-bills-list').replaceChildren(...(openBills ?? []).map((b) => {
    const box = node('input', { type: 'checkbox', value: b.invoiceId, checked: keep.has(b.invoiceId) });
    box.dataset.amountMinor = String(b.payableMinor);
    box.addEventListener('change', drawTotal);
    const label = node('label', { className: 'inline' }, box, node('span', { textContent: w('billLine', { bill: b.invoiceId, amount: api.rupees(b.payableMinor) }) }));
    label.dataset.bill = b.invoiceId;
    return label;
  }));
  drawTotal();
}
async function loadBills() {
  const supplierId = $('pay-supplier').value.trim();
  if (supplierId === billsFor) return;
  billsFor = supplierId; openBills = supplierId === '' ? null : []; billsWhy = '';
  $('pay-bills-list').replaceChildren();
  if (supplierId === '') { drawBills(); return; }
  $('pay-bills-note').textContent = w('billsReading');
  const out = await session.openBills(supplierId);
  if (billsFor !== supplierId) return; // another supplier was chosen meanwhile
  if (out.result !== 'ok') { openBills = []; billsWhy = api.outcomeWords(lang(), out); } else openBills = out.value;
  drawBills();
}

async function loadAsks() {
  const out = await session.myAsks();
  if (out.result !== 'ok') { asks = null; paint(); say('pay-status', api.outcomeWords(lang(), out), 'err'); return; }
  asks = out.value; paint();
}

if (api !== null && may.pay) {
  $('pay').hidden = false;
  $('pay-on').value = api.today();
  // U7: pick the supplier by name (the code stays the fallback); the day in the shop's dd/mm/yyyy field.
  // The chrome loads after this script: adapt now if it is here, and again when it says it is (each adapter runs once).
  const adapt = () => { const o = office(); if (o !== null) { o.pickable('pay-supplier', 'supplier'); o.shopDate('pay-on', { en: api.words('en', 'paidOn'), ta: api.words('ta', 'paidOn') }, { required: true }); } };
  adapt();
  document.addEventListener('sre:chrome', adapt);
  for (const id of ['pay-ask', 'pay-asks-show']) $(id).classList.add('sre-btn');
  paint();
  new MutationObserver(paint).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  $('pay-ask').addEventListener('click', async () => {
    const b = $('pay-ask'); b.disabled = true;
    try {
      const out = await session.ask({ supplierId: $('pay-supplier').value, amountRupees: $('pay-amount').value, method: $('pay-method').value, settles: ticked().join(',') });
      if (out.result !== 'ok') { say('pay-status', api.outcomeWords(lang(), out), 'err'); return; }
      say('pay-status', w('asked'), 'ok');
      await loadAsks();
    } finally { b.disabled = false; }
  });
  $('pay-asks-show').addEventListener('click', () => { void loadAsks(); });
  // D-047: the supplier chosen (picked by name, or its code typed) → its matched bills not yet paid, as tick boxes.
  let typing = null;
  $('pay-supplier').addEventListener('change', () => { void loadBills(); });
  $('pay-supplier').addEventListener('input', () => { clearTimeout(typing); typing = setTimeout(() => { void loadBills(); }, 400); });
}
