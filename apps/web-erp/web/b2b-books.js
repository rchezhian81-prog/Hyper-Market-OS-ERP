// Business customers · "Chasing, the books and the order chain" (W5 · M22-FR-01/02/04 · M23). Every rule and word lives in
// the TESTED session (apps/web-erp/src/b2b-books-session.ts, window.b2bBooks); this file draws what head office answered.
// Each read is a click; nothing is written and nothing is sent to a customer from here. The day starts at the shop's own
// date. No prompt/confirm/alert.

const $ = (id) => document.getElementById(id);
const api = window.b2bBooks ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, reconcile: false, documents: false };
const lang = () => (document.documentElement.lang === 'ta' ? 'ta' : 'en');
const w = (k, fill) => (api === null ? k : api.words(lang(), k, fill));
const node = (tag, props = {}, ...kids) => { const n = document.createElement(tag); Object.assign(n, props); n.append(...kids); return n; };
const fig = (label, value, key) => { const d = node('div', {}, node('span', { className: 'meta', textContent: label }), node('strong', { textContent: value })); d.dataset.fig = key; return d; };
function say(text, cls = '') { $('bk-status').textContent = text; $('bk-status').dataset.result = cls; }

let shown = null; // { kind, value }

function paint() {
  for (const [id, k] of [['bk-h', 'bkH'], ['bk-lede', 'bkLede'], ['bk-customer-l', 'customer'], ['bk-asof-l', 'asOf'], ['bk-order-l', 'order'],
    ['bk-dunning-text', 'dunning'], ['bk-reconcile-text', 'reconcile'], ['bk-chain-text', 'chain'], ['bk-probing-text', 'probing']]) $(id).textContent = w(k);
  const figs = $('bk-figs'); const rows = $('bk-rows'); figs.replaceChildren(); rows.replaceChildren();
  if (shown === null) return;
  const v = shown.value; const r = api.rupees;
  if (shown.kind === 'dunning') {
    figs.append(fig(w('dunning'), w(`step_${v.step}`), 'step'), fig(w('chaseable'), r(v.chaseableMinor), 'chaseable'), fig(w('worst'), String(v.worstDaysOverdue), 'worst'));
    rows.append(node('li', { textContent: v.detail }));
    if (v.needsHuman) rows.append(node('li', { textContent: w('needsPerson') }));
  } else if (shown.kind === 'reconcile') {
    figs.append(fig(w('portal'), r(v.portalOutstandingMinor), 'portal'), fig(w('books'), r(v.financeOutstandingMinor), 'books'), fig(w('difference'), r(v.differenceMinor), 'difference'));
    rows.append(node('li', { textContent: `${v.agrees ? w('agrees') : w('differs')} — ${v.detail}` }));
  } else if (shown.kind === 'chain') {
    figs.append(fig(w('ordered'), r(v.orderedMinor), 'ordered'), fig(w('delivered'), r(v.deliveredMinor), 'delivered'), fig(w('billed'), r(v.invoicedMinor), 'billed'),
      fig(w('undelivered'), r(v.undeliveredMinor), 'undelivered'), fig(w('unbilled'), r(v.uninvoicedMinor), 'unbilled'));
    rows.append(node('li', { textContent: v.complete ? w('complete') : v.detail }));
  } else if (shown.kind === 'probing') {
    rows.append(node('li', { className: 'meta', textContent: w('threshold', { threshold: v.threshold }) }));
    if (v.probing.length === 0) rows.append(node('li', { textContent: w('noProbing', { threshold: v.threshold }) }));
    for (const p of v.probing) {
      const li = node('li', { textContent: `${w('probingRow', { user: p.userId, customer: p.customerId, attempts: p.attempts, targets: p.distinctTargets })} — ${p.detail}` });
      li.dataset.probe = p.userId; rows.append(li);
    }
  }
}

async function run(kind, button, work) {
  button.disabled = true;
  try {
    const out = await work();
    if (out.result !== 'ok') { shown = null; paint(); say(api.outcomeWords(lang(), out), 'err'); return; }
    shown = { kind, value: out.value }; say('', 'ok'); paint();
  } finally { button.disabled = false; }
}

if (api !== null && may.read) {
  $('bk').hidden = false;
  $('bk-asof').value = api.today();
  $('bk-reconcile').hidden = !may.reconcile;
  $('bk-chain').hidden = !may.documents;
  $('bk-order').closest('label').hidden = !may.documents;
  // The customer the desk has open, if any — the person can type another.
  const opened = $('c-id')?.value?.trim() ?? '';
  if (opened !== '') $('bk-customer').value = opened;
  $('c-open')?.addEventListener('click', () => { const c = $('c-id').value.trim(); if (c !== '') $('bk-customer').value = c; });
  paint();
  new MutationObserver(paint).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  const customer = () => $('bk-customer').value; const asOf = () => $('bk-asof').value;
  $('bk-dunning').addEventListener('click', () => run('dunning', $('bk-dunning'), () => session.dunning(customer(), asOf())));
  $('bk-reconcile').addEventListener('click', () => run('reconcile', $('bk-reconcile'), () => session.reconciliation(customer(), asOf())));
  $('bk-chain').addEventListener('click', () => run('chain', $('bk-chain'), () => session.chain(customer(), $('bk-order').value)));
  $('bk-probing').addEventListener('click', () => run('probing', $('bk-probing'), () => session.probing()));
}
