// Concession invoices (Round 4d · M27-FR-03) — the Concessions page's invoice part. The session
// (apps/web-erp/src/concession-invoices-session.ts, in the bundle as window.concessionInvoices) does every call and rule; this
// draws it in the shared office parts (window.sreOffice: fields, summary cards, a register) and reads the period from the
// page's own "money" fields (counter, from, to, banked, metered). Nothing is written on open. Every word has a Tamil twin.

const $ = (id) => document.getElementById(id);
const api = window.concessionInvoices ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, manage: false, configure: false };
const lang = () => (document.documentElement.lang === 'ta' ? 'ta' : 'en');
const t = (k) => (api === null ? k : api.words(lang(), k));
const both = (k) => ({ en: api === null ? k : api.words('en', k), ta: api === null ? k : api.words('ta', k) });
const office = () => window.sreOffice ?? null;
const period = () => ({ contractId: $('m-contract')?.value ?? '', from: $('m-from')?.value ?? '', to: $('m-to')?.value ?? '', banked: $('m-banked')?.value ?? '', metered: $('m-metered')?.value ?? '' });
const say = (out, good) => { $('ci-status').textContent = out.result === 'ok' ? good : api.outcomeWords(lang(), out); };

let gst = null; let preview = null; let list = null; let register = null;

function paintGst() {
  if (gst === null) { $('ci-gst').textContent = ''; return; }
  $('ci-gst').textContent = gst.gstTreatment === null ? t('gstNotSet')
    : `${t('gstH')}: ${t('rent')} ${gst.gstTreatment.rentBps / 100}% · ${t('revenue_share')} ${gst.gstTreatment.revenueShareBps / 100}% · ${t('utilities')} ${gst.gstTreatment.utilitiesBps / 100}% · ${t(gst.gstTreatment.supply === 'inter_state' ? 'across' : 'within')} · ${t('gstSet')} ${gst.gstTreatment.setBy}`;
}
function paintGstForm() {
  const o = office(); if (o === null || !may.configure) return;
  $('ci-gst-form').hidden = false;
  const kept = new Map([...$('ci-gst-fields').querySelectorAll('input, select')].map((i) => [i.id, i.value]));
  $('ci-gst-fields').replaceChildren(
    o.field({ id: 'ci-rent', label: both('rentPct'), required: true, inputmode: 'decimal' }), o.field({ id: 'ci-share', label: both('sharePct'), required: true, inputmode: 'decimal' }),
    o.field({ id: 'ci-util', label: both('utilitiesPct'), required: true, inputmode: 'decimal' }),
    o.field({ id: 'ci-supply', label: both('supply'), type: 'select', options: [{ value: 'intra_state', label: both('within') }, { value: 'inter_state', label: both('across') }] }),
    o.field({ id: 'ci-note', label: both('note') }),
  );
  for (const [id, v] of kept) if ($(id) && v !== '') $(id).value = v;
}
function paintPreview() {
  const o = office(); if (o === null) return;
  if (preview === null) { $('ci-figs').replaceChildren(); return; }
  const p = preview;
  const cards = [
    ...(p.lines ?? []).map((l) => ({ label: both(l.kind), value: api.rupees(l.taxableMinor), note: `${t('taxable')} · ${t('gst')} ${l.rateBps / 100}% = ${api.rupees(l.cgstMinor + l.sgstMinor + l.igstMinor)}` })),
    { label: both('total'), value: api.rupees(p.invoiceTotalMinor) },
    { label: both('collected'), value: api.rupees(p.collectedForThemMinor) },
    p.netPayableToThemMinor >= 0 ? { label: both('net'), value: api.rupees(p.netPayableToThemMinor) } : { label: both('theyOwe'), value: api.rupees(-p.netPayableToThemMinor), tone: 'pending' },
    { label: both('deposit'), value: api.rupees(p.depositHeldMinor) },
  ];
  o.cards($('ci-figs'), cards);
  if (p.reconciles === false) $('ci-status').textContent = t('notReconciled');
}
function paintList() {
  const o = office(); if (o === null) return;
  const host = $('ci-list');
  if (register === null || !host.contains($('cinvoices-table'))) {
    register = o.table(host, {
      id: 'cinvoices', label: both('listH'), bodyId: 'ci-rows', rows: null, rowKey: (i) => i.invoiceId,
      empty: { title: both('none'), detail: both('invoicesLead') },
      columns: [
        { key: 'number', label: both('listH'), sort: 'text' }, { key: 'period', label: both('period'), value: (i) => `${i.from} – ${i.to}` },
        { key: 'total', label: both('total'), align: 'end', value: (i) => api.rupees(i.invoiceTotalMinor) },
        { key: 'net', label: both('net'), align: 'end', value: (i) => api.rupees(i.netPayableToThemMinor) },
        { key: 'ledger', label: both('ledgerAgrees'), value: (i) => both(list.reconcile.find((r) => r.invoiceId === i.invoiceId)?.agrees ? 'ledgerAgrees' : 'ledgerDiffers'), render: (i) => { const a = list.reconcile.find((r) => r.invoiceId === i.invoiceId)?.agrees === true; return o.chip(a ? 'ok' : 'error', t(a ? 'ledgerAgrees' : 'ledgerDiffers')); } },
      ],
    });
  }
  if (list !== null) register.setRows(list.invoices); else register.setRows(null);
}
function paintWords() {
  for (const [id, k] of [['ci-h', 'invoicesH'], ['ci-lead', 'invoicesLead'], ['ci-preview-text', 'preview'], ['ci-ask-text', 'ask'], ['ci-issue-text', 'issue'], ['ci-list-h', 'listH'], ['ci-save-gst-text', 'saveGst']]) $(id).textContent = t(k);
  paintGst(); paintGstForm(); paintPreview(); paintList();
}

async function readFor() {
  const g = await session.gstTreatment(); if (g.result === 'ok') gst = g.value; paintGst();
  const contractId = period().contractId;
  if (contractId === '') return;
  const l = await session.invoices(contractId);
  list = l.result === 'ok' ? l.value : null; paintList();
  if (may.manage) { const a = await session.approvedFor(contractId); $('ci-issue').hidden = !(a.result === 'ok' && a.value.length > 0); }
}

$('ci-preview')?.addEventListener('click', async () => {
  $('ci-status').textContent = '';
  const out = await session.preview(period());
  preview = out.result === 'ok' ? out.value : null;
  if (out.result !== 'ok') say(out, '');
  $('ci-ask').hidden = !(may.manage && out.result === 'ok' && out.value.reconciles !== false);
  paintPreview(); void readFor();
});
$('ci-ask')?.addEventListener('click', async () => {
  if (preview === null) return;
  const out = await session.ask(period(), preview.invoiceTotalMinor);
  say(out, t('asked'));
});
$('ci-issue')?.addEventListener('click', async () => {
  const a = await session.approvedFor(period().contractId);
  if (a.result !== 'ok' || a.value.length === 0) { $('ci-status').textContent = a.result === 'ok' ? t('noApproved') : api.outcomeWords(lang(), a); return; }
  const out = await session.issue(a.value[0]);
  say(out, out.result === 'ok' ? `${t('issued')} ${out.value.invoice.number}.` : '');
  void readFor();
});
$('ci-gst-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const o = office(); if (o !== null && !o.check($('ci-gst-form'))) return;
  const out = await session.setGst({ rent: $('ci-rent').value, share: $('ci-share').value, utilities: $('ci-util').value, supply: $('ci-supply').value, note: $('ci-note').value });
  say(out, out.result === 'ok' ? `${t('gstSaved')} ${out.value.version}.` : '');
  void readFor();
});
$('m-contract')?.addEventListener('change', () => { void readFor(); });
document.addEventListener('sre:chrome', paintWords);
new MutationObserver(paintWords).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
if (session !== null && may.read) {
  // The section shows with the page's own money section (it is hidden while the feature is off).
  const money = $('money');
  const follow = () => { $('invoices').hidden = money === null || money.hidden; };
  if (money !== null) new MutationObserver(follow).observe(money, { attributes: true, attributeFilter: ['hidden'] });
  follow(); paintWords(); void readFor();
}
