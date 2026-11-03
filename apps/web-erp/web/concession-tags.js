// Concessions · "Counter sale lines" (W5 · M27-FR-02/03/04). Every rule and word lives in the TESTED session
// (apps/web-erp/src/concession-tags-session.ts, window.concessionTags); this file draws what head office answered and passes
// each click through. A correction is a new line naming the old one — nothing is edited. Nothing is read on open.
// No prompt/confirm/alert.

const $ = (id) => document.getElementById(id);
const api = window.concessionTags ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, record: false, manage: false };
const lang = () => (document.documentElement.lang === 'ta' ? 'ta' : 'en');
const w = (k, fill) => (api === null ? k : api.words(lang(), k, fill));
const node = (tag, props = {}, ...kids) => { const n = document.createElement(tag); Object.assign(n, props); n.append(...kids); return n; };
const fig = (label, value, key) => { const d = node('div', {}, node('span', { className: 'meta', textContent: label }), node('strong', { textContent: value })); d.dataset.fig = key; return d; };
function say(id, text, cls = '') { const el = $(id); el.textContent = text; el.dataset.result = cls; }
async function busy(button, work) { button.disabled = true; try { await work(); } finally { button.disabled = false; } }

const FIELDS = [['saleId', ''], ['lineId', ''], ['productId', ''], ['qty', 'numeric'], ['counterId', ''], ['tillId', ''], ['shiftId', ''], ['grossRs', 'decimal'], ['discountRs', 'decimal'], ['taxRs', 'decimal'], ['source', '']];
let list = null; let breaches = null; let valuation = null;

function paintFields() {
  const host = $('tg-fields');
  if (host.childElementCount > 0) { for (const [k] of FIELDS) host.querySelector(`[data-l="${k}"]`).textContent = w(k); return; }
  for (const [k, mode] of FIELDS) {
    const input = node('input', { id: `tg-f-${k}`, autocomplete: 'off', ...(mode === '' ? {} : { inputMode: mode }) });
    const span = node('span', { textContent: w(k) }); span.dataset.l = k;
    host.append(node('label', { htmlFor: `tg-f-${k}` }, span, input));
  }
}

function paintList() {
  const figs = $('tg-figs'); const rows = $('tg-rows'); figs.replaceChildren(); rows.replaceChildren();
  if (list === null) return;
  figs.append(fig(w('lines'), String(list.tags.length), 'lines'), fig(w('gross'), api.rupees(list.totals.grossMinor), 'gross'), fig(w('net'), api.rupees(list.totals.netMinor), 'net'), fig(w('commission'), api.rupees(list.totals.commissionMinor), 'commission'));
  if (list.tags.length === 0) { rows.append(node('li', { textContent: w('none') })); return; }
  for (const t of list.tags) {
    const li = node('li'); li.dataset.tag = t.tagId; li.dataset.kind = t.kind;
    li.append(node('strong', { textContent: `${t.tagId} · ${w(`kind_${t.kind}`)} · ${t.productId} × ${t.qty} · ${api.rupees(t.grossMinor)}` }), ' ',
      node('span', { className: 'meta', textContent: `${t.saleId}/${t.lineId} · ${w('commission')} ${api.rupees(t.commissionMinor)} · ${w(`st_${t.settlementStatus}`)} · ${t.capturedBy}${t.correctsTagId ? ` · ${w('corrects')} ${t.correctsTagId}` : ''}` }));
    if (may.record && (t.kind === 'sale' || t.kind === 'return')) {
      const box = node('details', { className: 'tg-correct' }, node('summary', { textContent: `${w('reverse')} / ${w('adjust')}` }));
      const inp = (cls, label, mode) => { const i = node('input', { className: cls, autocomplete: 'off', ...(mode ? { inputMode: mode } : {}) }); return { l: node('label', {}, node('span', { textContent: w(label) }), i), i }; };
      const reason = inp('tg-reason', 'reason'); const g = inp('tg-dg', 'grossDelta', 'decimal'); const d = inp('tg-dd', 'discountDelta', 'decimal'); const x = inp('tg-dt', 'taxDelta', 'decimal');
      const rev = node('button', { type: 'button', className: 'quiet tg-reverse', textContent: w('reverse') });
      const adj = node('button', { type: 'button', className: 'quiet tg-adjust', textContent: w('adjust') });
      const st = node('p', { className: 'status tg-correct-status', role: 'status' });
      const after = async (out) => { if (out.result !== 'ok') { st.textContent = api.outcomeWords(lang(), out); return; } await show(); say('tg-status', w('corrected'), 'ok'); };
      rev.addEventListener('click', () => busy(rev, async () => after(await session.reverse(currentContract(), t.tagId, reason.i.value))));
      adj.addEventListener('click', () => busy(adj, async () => after(await session.adjust(currentContract(), t.tagId, { grossRupees: g.i.value, discountRupees: d.i.value, taxRupees: x.i.value }, reason.i.value))));
      box.append(node('div', { className: 'row-form' }, reason.l, g.l, d.l, x.l), node('div', { className: 'actions' }, rev, adj), st);
      li.append(box);
    }
    rows.append(li);
  }
}

function paintBreaches() {
  const rows = $('tg-breach-rows'); rows.replaceChildren();
  if (breaches === null) return;
  if (breaches.breaches.length === 0) { rows.append(node('li', { textContent: w('noBreaches') })); return; }
  for (const b of breaches.breaches) {
    const li = node('li', { textContent: `${b.day} · ${b.contractId} (${b.concessionaireId}) · ${b.saleId} · ${api.rupees(b.grossMinor)} — ${w('blockedBy')} ${b.blockedBy.join(', ')}` });
    li.dataset.breach = b.tagId; rows.append(li);
  }
}

function paintValuation() {
  const figs = $('tg-val-figs'); const rows = $('tg-val-rows'); figs.replaceChildren(); rows.replaceChildren();
  if (valuation === null) return;
  figs.append(fig(w('owned'), `${api.rupees(valuation.ownedValueMinor)} (${valuation.ownedLots} ${w('lots')})`, 'owned'), fig(w('excluded'), api.rupees(valuation.excludedValueMinor), 'excluded'));
  for (const e of valuation.excluded) rows.append(node('li', { textContent: `${e.ownership} · ${e.ownerId}: ${api.rupees(e.valueMinor)} (${e.lots} ${w('lots')})` }));
  rows.append(node('li', { className: 'meta', textContent: valuation.detail }));
}

function paint() {
  for (const [id, k] of [['tg-h', 'tagsH'], ['tg-lead', 'tagsLede'], ['tg-contract-l', 'contract'], ['tg-from-l', 'from'], ['tg-to-l', 'to'], ['tg-show-text', 'show'],
    ['tg-mark-charge-text', 'markCharge'], ['tg-mark-settled-text', 'markSettled'], ['tg-record-h', 'recordH'], ['tg-record-text', 'record'],
    ['tg-breaches-h', 'breachesH'], ['tg-breaches-text', 'showBreaches'], ['tg-val-h', 'valuationH'], ['tg-val-lead', 'valuationLede'], ['tg-branch-l', 'branch'], ['tg-val-text', 'showValuation']]) $(id).textContent = w(k);
  paintFields(); paintList(); paintBreaches(); paintValuation();
}

const currentContract = () => $('tg-contract').value;
async function show() {
  const out = await session.tags(currentContract(), $('tg-from').value, $('tg-to').value);
  if (out.result !== 'ok') { list = null; paintList(); say('tg-status', api.outcomeWords(lang(), out), 'err'); return; }
  list = out.value; say('tg-status', '', 'ok'); paintList();
}

if (api !== null && (may.read || may.record)) {
  $('tags').hidden = false;
  $('tg-record').hidden = !may.record;
  $('tg-show').hidden = !may.record;
  $('tg-mark-charge').hidden = !may.manage; $('tg-mark-settled').hidden = !may.manage;
  $('tg-breaches').hidden = !may.read; $('tg-val').hidden = !may.read;
  // The counter the money section has chosen, if any — the person can type another.
  const follow = () => { const c = $('m-contract')?.value ?? ''; if (c !== '') $('tg-contract').value = c; };
  follow();
  $('m-contract')?.addEventListener('change', follow);
  paint();
  new MutationObserver(paint).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  $('tg-show').addEventListener('click', () => busy($('tg-show'), show));
  for (const [id, status] of [['tg-mark-charge', 'included_in_charge'], ['tg-mark-settled', 'settled']]) {
    $(id).addEventListener('click', () => busy($(id), async () => {
      const out = await session.mark(currentContract(), status, $('tg-from').value, $('tg-to').value);
      if (out.result !== 'ok') { say('tg-status', api.outcomeWords(lang(), out), 'err'); return; }
      await show(); say('tg-status', w('marked', { count: out.value.marked }), 'ok');
    }));
  }
  $('tg-record-go').addEventListener('click', () => busy($('tg-record-go'), async () => {
    const v = (k) => $(`tg-f-${k}`).value;
    const out = await session.record(currentContract(), { saleId: v('saleId'), lineId: v('lineId'), productId: v('productId'), qty: v('qty'), counterId: v('counterId'), tillId: v('tillId'), shiftId: v('shiftId'), grossRupees: v('grossRs'), discountRupees: v('discountRs'), taxRupees: v('taxRs'), source: v('source') });
    if (out.result !== 'ok') { say('tg-record-status', api.outcomeWords(lang(), out), 'err'); return; }
    const r = out.value;
    say('tg-record-status', !r.captured ? w('alreadyThere') : r.trading && !r.trading.mayTrade ? w('cannotTrade', { why: r.trading.blockedBy.join(', ') }) : w('recorded'), r.trading && !r.trading.mayTrade ? 'err' : 'ok');
    await show();
  }));
  $('tg-breaches').addEventListener('click', () => busy($('tg-breaches'), async () => {
    const out = await session.breaches();
    if (out.result !== 'ok') { breaches = null; paintBreaches(); say('tg-status', api.outcomeWords(lang(), out), 'err'); return; }
    breaches = out.value; paintBreaches();
  }));
  $('tg-val').addEventListener('click', () => busy($('tg-val'), async () => {
    const out = await session.valuation($('tg-branch').value);
    if (out.result !== 'ok') { valuation = null; paintValuation(); say('tg-val-status', api.outcomeWords(lang(), out), 'err'); return; }
    valuation = out.value; say('tg-val-status', '', 'ok'); paintValuation();
  }));
}
