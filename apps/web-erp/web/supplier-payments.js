// Suppliers · "Record a payment to a supplier" (W5 · M23-FR-01 · §28). Every rule and word lives in the TESTED session
// (apps/web-erp/src/supplier-payment-session.ts, window.supplierPayments). It RECORDS that money was paid — no money moves
// from this page. Ask → a different person approves on their Approvals page → record here, naming that approval; what is
// recorded is exactly what was approved. Nothing is read on open. No prompt/confirm/alert.

const $ = (id) => document.getElementById(id);
const api = window.supplierPayments ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, pay: false };
const lang = () => (document.documentElement.lang === 'ta' ? 'ta' : 'en');
const w = (k, fill) => (api === null ? k : api.words(lang(), k, fill));
const node = (tag, props = {}, ...kids) => { const n = document.createElement(tag); Object.assign(n, props); n.append(...kids); return n; };
function say(id, text, result = '') { const el = $(id); el.textContent = text; el.dataset.result = result; }

let asks = null;

function paint() {
  for (const [id, k] of [['pay-h', 'payH'], ['pay-lead', 'payLede'], ['l-pay-supplier', 'supplier'], ['l-pay-amount', 'amount'], ['l-pay-on', 'paidOn'], ['l-pay-method', 'method'], ['l-pay-ref', 'reference'],
    ['pay-ask', 'ask'], ['pay-asks-h', 'myAsksH'], ['pay-asks-show', 'showAsks']]) $(id).textContent = w(k);
  const sel = $('pay-method'); const keep = sel.value;
  sel.replaceChildren(...api.methods.map((m) => node('option', { value: m, textContent: w(`m_${m}`) })));
  if (keep !== '') sel.value = keep;
  const list = $('pay-asks'); list.replaceChildren();
  if (asks === null) return;
  if (asks.length === 0) { list.append(node('li', { textContent: w('noAsks') })); return; }
  for (const a of asks) {
    const d = a.details;
    const li = node('li'); li.dataset.ask = a.requestId; li.dataset.status = a.status;
    li.append(node('strong', { textContent: `${String(d.supplierId)} · ${api.rupees(Number(d.amountMinor))} · ${w(`m_${String(d.method)}`)} · ${String(d.paidOn)} · ${String(d.reference)}` }), ' ',
      node('span', { className: 'note', textContent: `${w(`st_${a.status}`)}${a.decidedBy ? ` · ${a.decidedBy}` : ''}` }));
    if (a.status === 'approved') {
      const go = node('button', { type: 'button', className: 'act pay-record', textContent: w('record') });
      go.addEventListener('click', async () => {
        go.disabled = true;
        try {
          const out = await session.record(a);
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

async function loadAsks() {
  const out = await session.myAsks();
  if (out.result !== 'ok') { asks = null; paint(); say('pay-status', api.outcomeWords(lang(), out), 'err'); return; }
  asks = out.value; paint();
}

if (api !== null && may.pay) {
  $('pay').hidden = false;
  $('pay-on').value = api.today();
  paint();
  new MutationObserver(paint).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  $('pay-ask').addEventListener('click', async () => {
    const b = $('pay-ask'); b.disabled = true;
    try {
      const out = await session.ask({ supplierId: $('pay-supplier').value, amountRupees: $('pay-amount').value, paidOn: $('pay-on').value, method: $('pay-method').value, reference: $('pay-ref').value });
      if (out.result !== 'ok') { say('pay-status', api.outcomeWords(lang(), out), 'err'); return; }
      say('pay-status', w('asked'), 'ok');
      await loadAsks();
    } finally { b.disabled = false; }
  });
  $('pay-asks-show').addEventListener('click', () => { void loadAsks(); });
}
