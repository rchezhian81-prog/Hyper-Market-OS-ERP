// The GST and statutory tax desk on the GST returns page (W5 · route audit bundle 2 · API-09 · M23 · A14 · A18 · A19 ·
// A24 · OB-143 · OB-191 · OB-428 · OB-432 · OB-433). The view only: every call and every check lives in the tested session
// (apps/web-erp/src/gst-desk-session.ts, attached as window.gstDesk). It draws what head office answered — GSTR-1 for the
// month and its GSTN file (to upload by hand; nothing is filed here), the owner's warning window, GSTR-9C reasons, reverse
// charge and TDS — and says "not set" where the CA has not filled a list, never a figure of its own. Each part is shown
// only to a person whose role may use it; head office re-checks every one. No prompt/confirm/alert; nothing on a timer.

const desk = window.gstDesk ?? null;
const el = (id) => document.getElementById(id);
let lang = document.documentElement.lang === 'ta' ? 'ta' : 'en';
const w = (k) => (desk === null ? k : desk.words(lang, k));
const rupees = (m) => (desk === null ? String(m) : desk.rupees(m));
const pct = (bps) => `${(bps / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}%`;
const taxOf = (h) => (h?.cgstMinor ?? 0) + (h?.sgstMinor ?? 0) + (h?.igstMinor ?? 0);

// ── small builders: every word carries data-w so a language switch re-words it in place ────────────────────────────────
function node(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'w') { n.dataset.w = v; n.textContent = w(v); } else if (k === 'text') n.textContent = v;
    else if (k === 'class') n.className = v; else if (k.startsWith('data-')) n.setAttribute(k, v); else n[k] = v;
  }
  n.append(...kids);
  return n;
}
function field(id, wordKey, attrs = {}) {
  const input = node('input', { id, autocomplete: 'off', ...attrs });
  return node('label', { htmlFor: id }, node('span', { w: wordKey }), input);
}
function choice(id, wordKey, options) {
  const select = node('select', { id });
  for (const [value, key] of options) select.append(node('option', { value, ...(key === null ? { text: '—' } : { w: key }) }));
  return node('label', { htmlFor: id }, node('span', { w: wordKey }), select);
}
const val = (id) => el(id)?.value ?? '';
function said(id, out, okText) {
  const p = el(id);
  if (p === null) return;
  p.className = `said tone-${out.result === 'ok' ? 'ok' : 'error'}`;
  p.textContent = out.result === 'ok' ? okText : desk.outcomeWords(lang, out);
}
function table(head, rows, numeric = []) {
  const t = node('table');
  const tr = node('tr');
  head.forEach((h, i) => tr.append(node('th', { ...(numeric.includes(i) ? { class: 'n' } : {}), ...(typeof h === 'string' && h.startsWith('@') ? { w: h.slice(1) } : { text: h }) })));
  t.append(node('thead', {}, tr));
  const body = node('tbody');
  for (const r of rows) {
    const row = node('tr');
    r.forEach((c, i) => row.append(node('td', { ...(numeric.includes(i) ? { class: 'n' } : {}), text: String(c) })));
    body.append(row);
  }
  t.append(body);
  return node('div', { class: 'table-wrap' }, t);
}
async function busy(btn, fn) { btn.disabled = true; try { await fn(); } finally { btn.disabled = false; } }
const lastMonth = () => { if (window.sreShopDay === undefined) return ''; const ym = window.sreShopDay.lastMonth(); return `${ym.slice(5, 7)}${ym.slice(0, 4)}`; };

// ── GSTR-1 for the month ──────────────────────────────────────────────────────────────────────────────────────────────
let g1Last = null;
function paintG1Out() {
  const out = el('g1-out');
  out.replaceChildren();
  if (g1Last === null) return;
  const { kind, v } = g1Last;
  if (kind === 'return') {
    // Head office's own totals and lines, as it answered them — this page adds nothing up.
    out.append(node('ul', { class: 'list', id: 'g1-return' },
      node('li', { 'data-part': 'totals', text: `${v.documentCount ?? 0} ${w('documents')} · ${w('taxable')} ${rupees(v.totalTaxableMinor ?? 0)} · ${w('tax')} ${rupees(v.totalTaxMinor ?? 0)}` }),
      node('li', { 'data-part': 'b2b', text: `${w('b2b')}: ${(v.b2b ?? []).length}${(v.b2b ?? []).length === 0 ? '' : ` — ${v.b2b.map((i) => `${i.invoiceNumber} (${i.recipientGstin}) ${rupees(i.invoiceValueMinor)}`).join(' · ')}`}` }),
      node('li', { 'data-part': 'b2c', text: `${w('b2c')}: ${(v.b2c ?? []).map((r) => `${pct(r.rateBps)} ${rupees(r.taxableMinor)}`).join(' · ') || '—'}` }),
      node('li', { 'data-part': 'notes', text: `${w('notes')}: ${(v.creditDebitNotes?.registered ?? []).length + (v.creditDebitNotes?.unregistered ?? []).length}` })));
    out.append(hsnTable(v.hsn?.rows ?? []));
  } else if (kind === 'table12') {
    out.append(node('p', { class: 'said', 'data-part': 'table12', text: `${v.documentCount ?? 0} ${w('documents')} · ${w('taxable')} ${rupees(v.totalTaxableMinor ?? 0)} · ${w('tax')} ${rupees(v.totalTaxMinor ?? 0)}` }), hsnTable(v.rows ?? []));
  } else if (kind === 'fromSales') {
    const net = v.net ?? { rows: [] };
    out.append(node('p', { class: 'said', 'data-part': 'from-sales', text: `${v.soldLineCount ?? 0} ${w('soldLines')} · ${v.returnedLineCount ?? 0} ${w('returnedLines')} · ${w('net')}: ${w('taxable')} ${rupees(net.netTaxableMinor ?? 0)} · ${w('tax')} ${rupees(net.netTaxMinor ?? 0)}` }),
      table(['HSN', '@rate', '@qty', '@taxable', 'CGST', 'SGST', 'IGST'], (net.rows ?? []).map((r) => [r.hsnCode, pct(r.rateBps), r.netQuantityMinor, rupees(r.netTaxableMinor), rupees(r.netCgstMinor), rupees(r.netSgstMinor), rupees(r.netIgstMinor)]), [2, 3, 4, 5, 6]));
    const unmapped = [...(v.unmapped ?? []), ...(v.returnsUnmapped ?? [])];
    if (unmapped.length > 0) out.append(node('p', { class: 'said tone-error', id: 'g1-unmapped', text: `${unmapped.length} ${w('unmapped')}: ${unmapped.map((u) => u.productId ?? u).join(', ')}` }));
  }
}
function hsnTable(rows) {
  return table(['HSN', '@rate', '@qty', '@taxable', 'CGST', 'SGST', 'IGST'], rows.map((r) => [r.hsnCode, pct(r.rateBps), r.quantityMinor, rupees(r.taxableMinor), rupees(r.cgstMinor), rupees(r.sgstMinor), rupees(r.igstMinor)]), [2, 3, 4, 5, 6]);
}
function buildG1() {
  const box = el('d-g1');
  const f = node('form', { id: 'g1-form' },
    field('g1-month', 'month', { inputMode: 'numeric', maxLength: 6, value: lastMonth() }),
    field('g1-gstin', 'gstin', { maxLength: 15 }),
    field('g1-turnover', 'turnover', { inputMode: 'decimal' }),
    node('button', { type: 'button', id: 'g1-return', class: 'quiet', w: 'showReturn' }),
    node('button', { type: 'button', id: 'g1-t12', class: 'quiet', w: 'showT12' }),
    node('button', { type: 'button', id: 'g1-t12s', class: 'quiet', w: 'showT12Sales' }),
    node('button', { type: 'button', id: 'g1-file', w: 'download' }));
  f.addEventListener('submit', (e) => e.preventDefault());
  box.replaceChildren(node('h3', { w: 'g1H' }), node('p', { class: 'lead2', w: 'g1Lead' }), f, node('p', { class: 'said', id: 'g1-said', role: 'status' }), node('div', { id: 'g1-out' }));
  const show = (btn, kind, ask) => btn.addEventListener('click', () => void busy(btn, async () => {
    el('g1-said').textContent = w('reading');
    const out = await ask();
    if (out.result === 'ok') { g1Last = { kind, v: out.value }; el('g1-said').textContent = ''; el('g1-said').className = 'said'; } else { g1Last = null; said('g1-said', out, ''); }
    paintG1Out();
  }));
  show(el('g1-return'), 'return', () => desk.session.gstr1Return(val('g1-month')));
  show(el('g1-t12'), 'table12', () => desk.session.table12(val('g1-month')));
  show(el('g1-t12s'), 'fromSales', () => desk.session.table12FromSales(val('g1-month'), val('g1-turnover')));
  el('g1-file').addEventListener('click', () => void busy(el('g1-file'), async () => {
    const out = await desk.session.gstnFile(val('g1-month'), val('g1-gstin'));
    if (out.result !== 'ok') { said('g1-said', out, ''); return; }
    // The file head office made, saved as it gave it — the person uploads it on the portal (nothing is filed here).
    const url = URL.createObjectURL(new Blob([out.value.text], { type: 'application/json' }));
    const a = node('a', { href: url, download: out.value.fileName });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    el('g1-said').dataset.file = out.value.fileName;
    said('g1-said', out, `${out.value.fileName} — ${w('fileNote')}`);
  }));
}

// ── the owner's warning window before the 3-year bar (A19 · OB-191) ──────────────────────────────────────────────────────
function buildTimeBar() {
  const box = el('d-timebar');
  if (!desk.session.may.setTimeBar) { box.replaceChildren(); return; }
  const f = node('form', { id: 'tb-form' }, field('tb-days', 'days', { inputMode: 'numeric', maxLength: 4 }), field('tb-reason', 'reason'), node('button', { type: 'submit', id: 'tb-save', w: 'saveDays' }));
  f.addEventListener('submit', (e) => { e.preventDefault(); void busy(el('tb-save'), async () => {
    const out = await desk.session.setTimeBarDays(val('tb-days'), val('tb-reason'));
    said('tb-said', out, `${w('daysSaved')}: ${out.result === 'ok' ? out.value.days : ''}`);
  }); });
  box.replaceChildren(node('h3', { w: 'timeBarH' }), node('p', { class: 'lead2', w: 'timeBarLead' }), f, node('p', { class: 'said', id: 'tb-said', role: 'status' }));
}

// ── GSTR-9C reasons (A18) ─────────────────────────────────────────────────────────────────────────────────────────────
let c9Last = null;
function paintC9() {
  const list = el('c9-list');
  list.replaceChildren();
  if (c9Last === null) return;
  const diffs = c9Last.differences ?? [];
  if (diffs.length === 0) { list.append(node('li', { 'data-code': 'none', w: 'noDiff' })); return; }
  for (const d of diffs) {
    const li = node('li', { 'data-period': d.period, 'data-code': d.code, 'data-explained': String(d.explained) },
      node('span', { class: 'word', text: `${d.period} — ${w(`c_${d.code}`)} · ${d.explained ? w('explained') : w('open')}` }),
      node('span', { text: `${w('turnoverDiff')} ${rupees(d.turnoverMinor)} · ${w('taxDiff')} ${rupees(d.taxMinor)}${d.reason ? ` — ${d.reason}${d.reasonBy ? ` (${d.reasonBy})` : ''}` : ''}` }));
    if (!d.explained && desk.session.may.giveReason) {
      const id = `c9-r-${d.period}-${d.code}`;
      const f = node('form', {}, field(id, 'reason'), node('button', { type: 'submit', class: 'quiet', w: 'saveReason' }));
      f.addEventListener('submit', (e) => { e.preventDefault(); void busy(f.querySelector('button'), async () => {
        const out = await desk.session.give9cReason(c9Last.fy, d.period, d.code, val(id));
        said('c9-said', out, `${w('reasonSaved')}: ${d.period}`);
        if (out.result === 'ok') { c9Last = { ...out.value.gstr9c, fy: c9Last.fy }; paintC9(); }
      }); });
      li.append(f);
    }
    list.append(li);
  }
}
function buildC9() {
  const box = el('d-9c');
  const f = node('form', { id: 'c9-form' }, field('c9-fy', 'fy', { maxLength: 7, value: desk.fyOfMonth(lastMonth()) ?? '' }), node('button', { type: 'submit', id: 'c9-show', class: 'quiet', w: 'showFy' }));
  f.addEventListener('submit', (e) => { e.preventDefault(); void busy(el('c9-show'), async () => {
    const fy = val('c9-fy').trim();
    const out = await desk.session.gstr9c(fy);
    if (out.result === 'ok') { c9Last = { ...out.value, fy }; el('c9-said').textContent = ''; el('c9-said').className = 'said'; } else { c9Last = null; said('c9-said', out, ''); }
    paintC9();
  }); });
  box.replaceChildren(node('h3', { w: 'g9cH' }), node('p', { class: 'lead2', w: 'g9cLead' }), f, node('p', { class: 'said', id: 'c9-said', role: 'status' }), node('ul', { class: 'list', id: 'c9-list', 'aria-label': 'GSTR-9C differences' }));
}

// ── reverse charge (A14 · OB-143) ─────────────────────────────────────────────────────────────────────────────────────
let rcmHeads = null;
let rcmReg = null;
async function loadHeads() {
  const out = await desk.session.rcmHeads();
  rcmHeads = out.result === 'ok' ? out.value : null;
  if (out.result !== 'ok') said('rcm-said', out, '');
  paintHeads();
}
function paintHeads() {
  const state = el('rcm-state');
  const list = el('rcm-heads');
  list.replaceChildren();
  if (rcmHeads === null) { state.textContent = ''; return; }
  const heads = rcmHeads.heads ?? [];
  state.dataset.state = heads.length === 0 ? 'not_set' : rcmHeads.switchedOn ? 'on' : 'off';
  state.textContent = `${rcmHeads.switchedOn ? w('switchedOn') : w('switchedOff')}${heads.length === 0 ? ` — ${w('notSet')}` : ''}`;
  for (const h of heads) {
    const li = node('li', { 'data-head': h.headCode }, node('span', { class: 'word', text: `${h.headCode} — ${h.name} · ${pct(h.rateBps)}` }), node('span', { text: `${h.notifiedUnder}${h.setBy ? ` · ${h.setBy}` : ''}` }));
    if (desk.session.may.configureRcm) {
      const id = `rcm-retire-${h.headCode}`;
      const f = node('form', {}, field(id, 'reason'), node('button', { type: 'submit', class: 'quiet', w: 'retire' }));
      f.addEventListener('submit', (e) => { e.preventDefault(); void busy(f.querySelector('button'), async () => {
        const out = await desk.session.retireRcmHead(h.headCode, val(id));
        said('rcm-said', out, `${w('headRetired')}: ${h.headCode}`);
        if (out.result === 'ok') await loadHeads();
      }); });
      li.append(f);
    }
    list.append(li);
  }
}
function paintRegister() {
  const out = el('rcm-reg');
  out.replaceChildren();
  if (rcmReg === null) return;
  const v = rcmReg;
  const invoiceOf = new Map((v.selfInvoices ?? []).map((s) => [s.purchaseId, s]));
  const paid = new Set((v.payments ?? []).map((p) => p.number));
  if (v.liability !== undefined) out.append(node('p', { class: 'said', 'data-part': 'rcm-figures', text: `${w('liability')}: ${rupees(taxOf(v.liability))} · ${w('itcPaid')}: ${rupees(taxOf(v.itcPaid))} · ${(v.unpaid ?? []).length} ${w('unpaid')}` }));
  const purchases = v.purchases ?? [];
  if (purchases.length === 0) { out.append(node('p', { class: 'said', w: 'noPurchases' })); return; }
  const list = node('ul', { class: 'list', id: 'rcm-purchases' });
  for (const p of purchases) {
    const inv = invoiceOf.get(p.purchaseId);
    const li = node('li', { 'data-purchase': p.purchaseId, 'data-decision': p.decision },
      node('span', { class: 'word', text: `${p.supplyDate} · ${p.supplierId} · ${rupees(p.taxableMinor)} — ${p.description}` }),
      node('span', { text: `${inv === undefined ? w('noSelfInvoice') : `${w('selfInvoice')} ${inv.number}${paid.has(inv.number) ? ` · ${w('deposited')}` : ''}`} — ${p.decisionDetail}` }));
    if (inv !== undefined && !paid.has(inv.number) && desk.session.may.payRcm) {
      const a = `rcm-ch-${p.purchaseId}`; const b = `rcm-on-${p.purchaseId}`;
      const f = node('form', {}, field(a, 'challanRef'), field(b, 'paidOn', { type: 'date' }), node('button', { type: 'submit', class: 'quiet', w: 'markPaid' }));
      f.addEventListener('submit', (e) => { e.preventDefault(); void busy(f.querySelector('button'), async () => {
        const out2 = await desk.session.markRcmPaid(p.purchaseId, val(a), val(b));
        said('rcm-said', out2, `${w('paidSaved')} ${out2.result === 'ok' ? out2.value.itcAvailableFrom : ''}`);
        if (out2.result === 'ok') await loadRegister();
      }); });
      li.append(f);
    }
    list.append(li);
  }
  out.append(list);
  if ((v.exceptions ?? []).length > 0) out.append(node('p', { class: 'said tone-error', text: `${v.exceptions.length} ${w('exceptions')}: ${v.exceptions.map((x) => x.detail).join('; ')}` }));
}
async function loadRegister() {
  const out = await desk.session.rcmRegister(val('rcm-month'));
  rcmReg = out.result === 'ok' ? out.value : null;
  if (out.result !== 'ok') said('rcm-said', out, '');
  paintRegister();
}
function buildRcm() {
  const box = el('d-rcm');
  if (!desk.session.may.readRcm) { box.replaceChildren(); return; }
  const kids = [node('h3', { w: 'rcmH' }), node('p', { class: 'lead2', w: 'rcmLead' }), node('p', { class: 'said', id: 'rcm-state', role: 'status' }), node('p', { class: 'said', id: 'rcm-said', role: 'status' }),
    node('h3', { w: 'headsH' }), node('ul', { class: 'list', id: 'rcm-heads', 'aria-label': 'Reverse-charge heads' })];
  if (desk.session.may.configureRcm) {
    const f = node('form', { id: 'rcm-head-form' }, field('rcm-code', 'headCode', { maxLength: 16 }), field('rcm-name', 'headName'), field('rcm-rate', 'ratePct', { inputMode: 'decimal' }), field('rcm-cite', 'notifiedUnder'), node('button', { type: 'submit', id: 'rcm-head-save', w: 'saveHead' }));
    f.addEventListener('submit', (e) => { e.preventDefault(); void busy(el('rcm-head-save'), async () => {
      const out = await desk.session.setRcmHead({ headCode: val('rcm-code'), name: val('rcm-name'), rate: val('rcm-rate'), notifiedUnder: val('rcm-cite') });
      said('rcm-said', out, `${w('headSaved')}: ${val('rcm-code').trim().toUpperCase()}`);
      if (out.result === 'ok') await loadHeads();
    }); });
    kids.push(f);
  }
  if (desk.session.may.recordRcm) {
    const f = node('form', { id: 'rcm-buy-form' }, field('rcm-supplier', 'supplierId'), field('rcm-date', 'supplyDate', { type: 'date' }), field('rcm-taxable', 'taxableRs', { inputMode: 'decimal' }),
      choice('rcm-place', 'place', [['', null], ['intra_state', 'intra'], ['inter_state', 'inter']]), field('rcm-desc', 'description'), field('rcm-head', 'headOptional', { maxLength: 16 }),
      node('button', { type: 'submit', id: 'rcm-buy', w: 'recordPurchase' }));
    f.addEventListener('submit', (e) => { e.preventDefault(); void busy(el('rcm-buy'), async () => {
      const out = await desk.session.recordRcmPurchase({ supplierId: val('rcm-supplier'), supplyDate: val('rcm-date'), taxable: val('rcm-taxable'), placeOfSupply: val('rcm-place'), description: val('rcm-desc'), headCode: val('rcm-head') });
      said('rcm-said', out, `${w('purchaseSaved')}: ${out.result === 'ok' ? `${out.value.purchase?.purchaseId} — ${out.value.decision?.detail ?? ''}` : ''}`);
      if (out.result === 'ok' && val('rcm-month') !== '') await loadRegister();
    }); });
    kids.push(node('h3', { w: 'purchaseH' }), f);
  }
  const reg = node('form', { id: 'rcm-reg-form' }, field('rcm-month', 'month', { inputMode: 'numeric', maxLength: 6, value: lastMonth() }), node('button', { type: 'submit', id: 'rcm-show', class: 'quiet', w: 'showRegister' }));
  reg.addEventListener('submit', (e) => { e.preventDefault(); void busy(el('rcm-show'), loadRegister); });
  kids.push(node('h3', { w: 'registerH' }), reg, node('div', { id: 'rcm-reg' }));
  box.replaceChildren(...kids);
  void loadHeads();
}

// ── income-tax TDS (A24 · OB-143) ─────────────────────────────────────────────────────────────────────────────────────
let tdsState = null;
/** The CA's working copy of the list while editing — saved whole (head office keeps every earlier version). */
let tdsDraft = null;
let q26 = null;
async function loadTds() {
  const out = await desk.session.tds();
  tdsState = out.result === 'ok' ? out.value : null;
  if (out.result !== 'ok') said('tds-said', out, '');
  const c = tdsState?.config ?? { sections: [], payees: [] };
  tdsDraft = {
    sections: (c.sections ?? []).map((s) => ({ section: s.section, label: s.label, rate: String(s.rateBps / 100), single: s.singleThresholdMinor === null ? '' : String(s.singleThresholdMinor / 100), aggregate: s.aggregateThresholdMinor === null ? '' : String(s.aggregateThresholdMinor / 100), onCrossing: s.onCrossing })),
    payees: (c.payees ?? []).map((p) => ({ supplierId: p.supplierId, tdsApplicable: p.tdsApplicable, section: p.section ?? '', pan: p.pan ?? '' })),
  };
  paintTds();
}
function paintTds() {
  const v = tdsState;
  el('tds-state').textContent = v === null ? '' : v.state;
  el('tds-state').dataset.enabled = v === null ? '' : String(v.enabled);
  const secs = el('tds-sections'); secs.replaceChildren();
  const pays = el('tds-payees'); pays.replaceChildren();
  if (v === null || tdsDraft === null) return;
  const ca = desk.session.may.configureTds;
  if (tdsDraft.sections.length === 0) secs.append(node('li', { 'data-section': 'none', w: 'noSections' }));
  tdsDraft.sections.forEach((s, i) => {
    const li = node('li', { 'data-section': s.section }, node('span', { class: 'word', text: `${s.section} — ${s.label} · ${s.rate}%` }),
      node('span', { text: `${s.single === '' ? '—' : `₹${s.single}`} / ${s.aggregate === '' ? '—' : `₹${s.aggregate}`} · ${w(s.onCrossing === 'this_payment' ? 'thisPayment' : 'wholeAggregate')}` }));
    if (ca) { const b = node('button', { type: 'button', class: 'quiet', w: 'removeSection' }); b.addEventListener('click', () => { tdsDraft.sections.splice(i, 1); paintTds(); }); li.append(b); }
    secs.append(li);
  });
  if (tdsDraft.payees.length === 0) pays.append(node('li', { 'data-payee': 'none', w: 'noPayees' }));
  tdsDraft.payees.forEach((p, i) => {
    const li = node('li', { 'data-payee': p.supplierId }, node('span', { class: 'word', text: `${p.supplierId} · ${w('applicable')}: ${w(p.tdsApplicable ? 'yes' : 'no')}${p.section ? ` · ${p.section}` : ''}${p.pan ? ` · PAN ${p.pan}` : ''}` }));
    if (ca) { const b = node('button', { type: 'button', class: 'quiet', w: 'removePayee' }); b.addEventListener('click', () => { tdsDraft.payees.splice(i, 1); paintTds(); }); li.append(b); }
    pays.append(li);
  });
  const liab = el('tds-liabilities'); liab.replaceChildren();
  liab.append(node('p', { class: 'said', 'data-part': 'open-liability', text: `${w('openLiability')}: ${rupees(v.openLiabilityMinor ?? 0)}` }));
  if ((v.liabilities ?? []).length > 0) {
    liab.append(table(['@payeeSupplier', '@section', '@paidOn', '@amountRs', 'TDS', ''], v.liabilities.map((l) => [l.supplierId, l.section, l.paidOn, rupees(l.grossMinor), rupees(l.tdsMinor), l.state === 'deposited' ? `${w('deposited')} ${l.challanRef ?? ''}` : `${w('liabilityWord')} (${l.paymentId})`]), [3, 4]));
  }
  paint26q();
}
function paint26q() {
  const out = el('q26-out');
  out.replaceChildren();
  if (q26 === null) return;
  if ((q26.rows ?? []).length === 0) { out.append(node('p', { class: 'said', w: 'noRows' })); return; }
  out.append(node('p', { class: 'said', 'data-part': '26q', text: `${w('total')} ${rupees(q26.totalTdsMinor)} · ${w('depositedTotal')} ${rupees(q26.depositedMinor)}${q26.undeposited.length > 0 ? ` · ${q26.undeposited.length} ${w('undeposited')}` : ''}${q26.withoutPan.length > 0 ? ` · ${q26.withoutPan.length} ${w('withoutPan')}` : ''}` }),
    table(['@section', '@payeeSupplier', 'PAN', '@paidOn', '@amountRs', 'TDS', '@challanRef'], q26.rows.map((r) => [r.section, r.supplierId, r.pan ?? '—', r.paidOn, rupees(r.grossMinor), rupees(r.tdsMinor), r.challanRef ?? '—']), [4, 5]));
}
function buildTds() {
  const box = el('d-tds');
  if (!desk.session.may.readTds) { box.replaceChildren(); return; }
  const kids = [node('h3', { w: 'tdsH' }), node('p', { class: 'lead2', w: 'tdsLead' }), node('p', { class: 'said', id: 'tds-state', role: 'status' }), node('p', { class: 'said', id: 'tds-said', role: 'status' }),
    node('h3', { w: 'sectionsH' }), node('ul', { class: 'list', id: 'tds-sections', 'aria-label': 'TDS sections' })];
  if (desk.session.may.configureTds) {
    const fs = node('form', { id: 'tds-sec-form' }, field('tds-sec', 'section', { maxLength: 8 }), field('tds-label', 'label'), field('tds-rate', 'ratePct', { inputMode: 'decimal' }), field('tds-single', 'singleRs', { inputMode: 'decimal' }), field('tds-agg', 'aggregateRs', { inputMode: 'decimal' }),
      choice('tds-cross', 'onCrossing', [['this_payment', 'thisPayment'], ['whole_aggregate', 'wholeAggregate']]), node('button', { type: 'submit', class: 'quiet', id: 'tds-sec-add', w: 'addSection' }));
    fs.addEventListener('submit', (e) => { e.preventDefault(); tdsDraft.sections.push({ section: val('tds-sec').trim().toUpperCase(), label: val('tds-label'), rate: val('tds-rate'), single: val('tds-single'), aggregate: val('tds-agg'), onCrossing: val('tds-cross') }); paintTds(); });
    kids.push(fs);
  }
  kids.push(node('h3', { w: 'payeesH' }), node('ul', { class: 'list', id: 'tds-payees', 'aria-label': 'TDS payees' }));
  if (desk.session.may.configureTds) {
    const fp = node('form', { id: 'tds-pay-form' }, field('tds-payee', 'payeeSupplier'), choice('tds-appl', 'applicable', [['yes', 'yes'], ['no', 'no']]), field('tds-psec', 'payeeSection', { maxLength: 8 }), field('tds-pan', 'pan', { maxLength: 10 }),
      node('button', { type: 'submit', class: 'quiet', id: 'tds-pay-add', w: 'addPayee' }));
    fp.addEventListener('submit', (e) => { e.preventDefault(); tdsDraft.payees.push({ supplierId: val('tds-payee').trim(), tdsApplicable: val('tds-appl') === 'yes', section: val('tds-psec'), pan: val('tds-pan') }); paintTds(); });
    const save = node('button', { type: 'button', id: 'tds-save', w: 'saveList' });
    save.addEventListener('click', () => void busy(save, async () => {
      const out = await desk.session.setTdsList(tdsDraft.sections, tdsDraft.payees);
      said('tds-said', out, `${w('listSaved')} ${out.result === 'ok' ? out.value.config?.version : ''}`);
      if (out.result === 'ok') await loadTds();
    }));
    kids.push(fp, save);
  }
  if (desk.session.may.switchTds) {
    const f = node('form', { id: 'tds-switch-form' }, field('tds-why', 'switchReason'), node('button', { type: 'button', id: 'tds-on', w: 'switchOn' }), node('button', { type: 'button', class: 'quiet', id: 'tds-off', w: 'switchOff' }));
    for (const [id, on] of [['tds-on', true], ['tds-off', false]]) {
      f.querySelector(`#${id}`).addEventListener('click', (e) => void busy(e.currentTarget, async () => {
        const out = await desk.session.switchTds(on, val('tds-why'));
        said('tds-said', out, `${w('switched')}: ${out.result === 'ok' ? out.value.state : ''}`);
        if (out.result === 'ok') await loadTds();
      }));
    }
    kids.push(f);
  }
  kids.push(node('h3', { w: 'liabilitiesH' }), node('div', { id: 'tds-liabilities' }));
  if (desk.session.may.recordChallan) {
    const f = node('form', { id: 'tds-ch-form' }, field('tds-ch-ref', 'challanRefT'), field('tds-ch-on', 'depositedOn', { type: 'date' }), field('tds-ch-ids', 'paymentIds'), field('tds-ch-amt', 'amountRs', { inputMode: 'decimal' }), node('button', { type: 'submit', id: 'tds-ch-save', w: 'recordChallan' }));
    f.addEventListener('submit', (e) => { e.preventDefault(); void busy(el('tds-ch-save'), async () => {
      const out = await desk.session.recordTdsChallan({ challanRef: val('tds-ch-ref'), depositedOn: val('tds-ch-on'), paymentIds: val('tds-ch-ids'), amount: val('tds-ch-amt') });
      said('tds-said', out, `${w('challanSaved')}: ${val('tds-ch-ref').trim()}`);
      if (out.result === 'ok') await loadTds();
    }); });
    kids.push(node('h3', { w: 'challanH' }), f);
  }
  const qf = node('form', { id: 'q26-form' }, field('q26-fy', 'fy', { maxLength: 7, value: desk.fyOfMonth(lastMonth()) ?? '' }), choice('q26-q', 'quarter', [['Q1', null], ['Q2', null], ['Q3', null], ['Q4', null]]), node('button', { type: 'submit', class: 'quiet', id: 'q26-show', w: 'show26q' }));
  for (const [i, o] of [...qf.querySelectorAll('#q26-q option')].entries()) o.textContent = `Q${i + 1}`;
  qf.addEventListener('submit', (e) => { e.preventDefault(); void busy(el('q26-show'), async () => {
    const out = await desk.session.form26q(val('q26-fy').trim(), val('q26-q'));
    q26 = out.result === 'ok' ? out.value : null;
    if (out.result !== 'ok') said('tds-said', out, '');
    paint26q();
  }); });
  kids.push(node('h3', { w: 'q26H' }), qf, node('div', { id: 'q26-out' }));
  box.replaceChildren(...kids);
  void loadTds();
}

function reword() {
  for (const n of el('desk').querySelectorAll('[data-w]')) n.textContent = w(n.dataset.w);
  // Repaint only the parts this person was shown (a part their role may not use was never built).
  paintG1Out(); paintC9();
  if (el('rcm-heads') !== null) { paintHeads(); paintRegister(); }
  if (el('tds-sections') !== null) paintTds();
}

if (desk === null) {
  el('desk').hidden = true;
} else {
  buildG1(); buildTimeBar(); buildC9(); buildRcm(); buildTds();
  el('lang').addEventListener('click', () => { lang = document.documentElement.lang === 'ta' ? 'ta' : 'en'; reword(); });
}
