// Supplier scorecard — the page over head office's D-10 route. The session (apps/web-erp/src/supplier-scorecard-session.ts,
// in the bundle as window.supplierScorecard) asks head office; this page only shows its answer: five figures built from
// the supplier's own purchase orders, goods receipts and matched invoices, each "Not rated" with its reason when head office
// cannot rate it — never a number. Nothing is written. Every word has a Tamil twin (in the session's copy).

const $ = (id) => document.getElementById(id);
const api = window.supplierScorecard ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false };

let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));

// U2 · G14 (UI/UX gap audit): a date a shop person reads — dd/mm/yyyy in the chrome's shared field (`sreOffice.dateField`),
// while the page goes on sending ISO (`dateOf`). Before the chrome has loaded, or off the box, the field stays as it was.
const wordsIn = (l, k) => (api === null ? k : api.words(l, k)); // the page's own words, for either language (null off the box)
const shopDates = new Map();
/** The shared fields' labels follow the language toggle like the page's own words do. */
function repaintShopDates() { const l = document.documentElement.lang === 'ta' ? 'ta' : 'en'; for (const [id, words] of shopDates) { const lab = $(id)?.closest('.sre-field')?.querySelector('.sre-field-label'); if (lab && lab.firstChild) lab.firstChild.textContent = words[l] ?? words.en; } }
function shopDate(id, words, opts = {}) {
  const office = window.sreOffice; const input = $(id);
  if (!office || typeof office.dateField !== 'function' || input === null || shopDates.has(id)) return;
  // a value already on the plain field is carried over — ISO as the page set it, or dd/mm/yyyy as a person typed it
  const typed = input.value.trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(typed) ? typed : (typeof office.parseShopDate === 'function' ? office.parseShopDate(typed) : null);
  const field = office.dateField({ id, label: words, required: opts.required === true, ...(iso ? { value: iso } : {}), ...(opts.hint ? { hint: opts.hint } : {}) });
  (input.closest('label') ?? input).replaceWith(field);
  shopDates.set(id, words);
}
const dateOf = (id) => (shopDates.has(id) ? (window.sreOffice.dateValue(id) ?? '') : ($(id)?.value ?? ''));
let card = null;
let contractId = null;
// FG-4 · D03-FR-05: the price variance shown (the roll-ups), and the drill-through open on it (the lines behind one row).
let ppv = null;
let drill = null; // { kind: 'product' | 'receipt', key, view }
let ppvAsked = null; // the supplier and period the variance was asked for — a drill asks the same

/** Rejection rate is a rate (lower is better); the other four are scores (higher is better). */
function toneOf(figure, r) {
  if (r.kind !== 'rated') return 'unknown';
  if (figure === 'rejectionRate') return r.bp > 200 ? 'degraded' : 'ok';
  return r.bp < 9_000 ? 'degraded' : 'ok';
}

function panel(figure, r) {
  const p = document.createElement('div');
  const tone = toneOf(figure, r);
  p.className = `panel tone-${tone}`;
  p.dataset.figure = figure;
  p.dataset.rated = String(r.kind === 'rated');
  const k = document.createElement('span'); k.className = 'k'; k.textContent = t(figure);
  const v = document.createElement('span'); v.className = 'v'; v.textContent = api.ratingWords(lang, r);
  const hint = document.createElement('span'); hint.className = 'hint'; hint.textContent = t(`${figure}Hint`);
  // The tone's shape beside the figure's name — never the only signal (the words say it too).
  if (typeof window.sreIcon === 'function' && typeof window.sreIcon.forTone === 'function') {
    const icon = window.sreIcon(window.sreIcon.forTone(tone), 18);
    if (icon) k.prepend(icon, ' ');
  }
  p.append(k, v, hint);
  return p;
}

function paint() {
  repaintShopDates();
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title-text', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['l-supplier', 'supplier'], ['l-from', 'from'], ['l-to', 'to'], ['show', 'show']]) { const n = $(id); if (n) n.textContent = t(k); }
  $('lang').textContent = t('lang');
  $('whoami').textContent = window.supplierScorecardData?.userId ?? '';
  $('nobody').hidden = may.named; $('nobody').textContent = t('nobody');
  $('show').disabled = !may.read; whyDisabled($('show'), may.read ? '' : 'role');
  $('card-section').hidden = card === null;
  if (card === null) return;
  $('card-h').textContent = `${card.supplierId} · ${card.period.from} – ${card.period.to}`;
  $('figures').replaceChildren(...api.figures.map((f) => panel(f, card[f])));
  $('counts').textContent = `${card.deliveries} ${t('deliveries')} · ${card.ordersInScope} ${t('orders')} · ${card.orderLinesOnTimeInFull}/${card.orderLines} ${t('lines')} ${t('onTimeLines')} · ${card.invoiceLinesChecked} ${t('invoiceLines')}, ${card.invoiceLinesAboveAgreedPrice} ${t('aboveAgreed')}`;
  $('lead-time').textContent = `${t('agreedLead')}: ${card.agreedLeadTimeDays === null ? t('noContract') : `${card.agreedLeadTimeDays} ${t('days')}${contractId === null ? '' : ` (${contractId})`}`}`
    + (card.averageLeadTimeDays === null ? '' : ` · ${t('averageLead')} ${card.averageLeadTimeDays} ${t('days')} · ${t('worstLead')} ${card.worstLeadTimeDays} ${t('days')}`);
  $('nothing').hidden = card.ordersWithNothingReceived.length === 0;
  $('nothing').textContent = `${t('nothingReceived')} ${card.ordersWithNothingReceived.join(', ')}`;
  $('summary').textContent = `${t('summary')}: ${card.summary}`;
  $('sources').textContent = t('sources');
}

const icon = (name, size = 18) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, size) : null);
// Icons always beside the words; added once (a repaint that keeps the element's children does not stack them).
const withIcon = (el, name) => { if ([...el.children].some((c) => c.tagName.toLowerCase() === 'svg')) return el; const i = icon(name); if (i) el.prepend(i, ' '); return el; };
function cell(text, cls) { const td = document.createElement('td'); td.textContent = text; if (cls) td.className = cls; return td; }
function head(table, cols) {
  const tr = document.createElement('tr');
  for (const [k, num] of cols) { const th = document.createElement('th'); th.textContent = t(k); if (num) th.className = 'num'; tr.append(th); }
  table.querySelector('thead').replaceChildren(tr);
}
function rollupRows(table, rows, kind) {
  head(table, [[kind === 'product' ? 'ppvProduct' : 'ppvReceipt', false], ['ppvCompared', true], ['ppvReceived', true], ['ppvAgreed', true], ['ppvVariance', true], ['ppvVsContract', true], ['ppvOpen', false]]);
  table.querySelector('tbody').replaceChildren(...rows.map((r) => {
    const tr = document.createElement('tr');
    tr.dataset.key = r.key;
    const open = document.createElement('button'); open.classList.add('sre-btn');
    open.type = 'button'; open.dataset.drill = kind; open.dataset.key = r.key;
    open.append(t('ppvOpen')); withIcon(open, 'list');
    open.addEventListener('click', () => { void openDrill(kind, r.key); });
    const td = document.createElement('td'); td.append(open);
    tr.append(
      cell(r.key), cell(`${r.comparedLines}/${r.lines}`, 'num'), cell(api.signedRupees(r.receivedValueMinor).replace('+', ''), 'num'), cell(api.signedRupees(r.orderValueMinor).replace('+', ''), 'num'),
      cell(api.signedRupees(r.varianceMinor), r.varianceMinor > 0 ? 'num over' : 'num'),
      cell(r.contractLines === 0 ? t('ppvNoContract') : api.signedRupees(r.contractVarianceMinor), r.contractVarianceMinor > 0 ? 'num over' : 'num'),
      td,
    );
    return tr;
  }));
}
function lineRows(table, lines) {
  head(table, [['ppvReceipt', false], ['ppvProduct', false], ['ppvOrder', false], ['ppvKept', true], ['ppvReceived', true], ['ppvAgreed', true], ['ppvVariance', true], ['ppvContract', true], ['ppvVsContract', true]]);
  table.querySelector('tbody').replaceChildren(...lines.map((l) => {
    const tr = document.createElement('tr');
    tr.dataset.grn = l.grnId; tr.dataset.product = l.productId;
    const order = l.order === undefined ? `${t('ppvNotCompared')} ${t(`nc_${l.notCompared}`)}` : api.costWords(l.order.unitCost) + (l.order.basis === 'blanket_release' ? ` (${t('ppvBlanket')})` : '');
    tr.append(
      cell(`${l.receiptNumber} · ${l.receivedOn}`), cell(l.productId), cell(l.poNumber ?? '—'), cell(`${l.keptMinor} ${l.uom}`, 'num'), cell(api.receivedCostWords ? api.receivedCostWords(lang, l) : (l.receivedUnitCost === null ? t('ppvNotYetBilled') : api.costWords(l.receivedUnitCost)), l.receivedUnitCost === null ? 'num not-billed' : 'num'),
      cell(order, 'num'), cell(l.order === undefined ? '—' : api.signedRupees(l.order.varianceMinor), l.order !== undefined && l.order.varianceMinor > 0 ? 'num over' : 'num'),
      cell(l.contract === undefined ? t('ppvNoContract') : `${api.costWords(l.contract.unitCost)} (${l.contract.agreementId})`, 'num'),
      cell(l.contract === undefined ? '—' : api.signedRupees(l.contract.varianceMinor), l.contract !== undefined && l.contract.varianceMinor > 0 ? 'num over' : 'num'),
    );
    return tr;
  }));
}

function paintPpv() {
  for (const [id, k] of [['ppv-h', 'ppvTitle'], ['ppv-lead', 'ppvLead'], ['ppv-show-text', 'ppvShow'], ['ppv-h-product', 'ppvByProduct'], ['ppv-h-receipt', 'ppvByReceipt'], ['ppv-back-text', 'ppvBack']]) { const n = $(id); if (n) n.textContent = t(k); }
  for (const [id, name] of [['ppv-h', 'percent'], ['ppv-show', 'chart-column'], ['ppv-h-product', 'package'], ['ppv-h-receipt', 'receipt'], ['ppv-back', 'rotate-ccw']]) withIcon($(id), name);
  $('ppv-show').disabled = !may.read; whyDisabled($('ppv-show'), may.read ? '' : 'role');
  $('ppv-rollups').hidden = ppv === null || drill !== null;
  $('ppv-drill').hidden = drill === null;
  if (ppv !== null && drill === null) {
    const tot = ppv.totals;
    $('ppv-total').textContent = ppv.receipts === 0 ? t('ppvNothing')
      : `${t('ppvTotal')}: ${t('ppvVariance')} ${api.signedRupees(tot.varianceMinor)} · ${t('ppvVsContract')} ${tot.contractLines === 0 ? t('ppvNoContract') : api.signedRupees(tot.contractVarianceMinor)} · ${tot.comparedLines}/${tot.lines} ${t('ppvCompared')} · ${ppv.period.from} – ${ppv.period.to}`;
    const nc = api.notComparedWords(lang, tot.notCompared);
    $('ppv-nc').hidden = nc === ''; $('ppv-nc').textContent = nc;
    rollupRows($('ppv-products'), ppv.byProduct, 'product');
    rollupRows($('ppv-receipts'), ppv.byReceipt, 'receipt');
  }
  if (drill !== null) {
    $('ppv-drill-h').textContent = `${t('ppvLines')}: ${t(drill.kind === 'product' ? 'ppvProduct' : 'ppvReceipt')} ${drill.key}`;
    withIcon($('ppv-drill-h'), 'list');
    lineRows($('ppv-lines'), drill.view.lines);
  }
}

async function showPpv() {
  ppvAsked = { supplier: $('supplier').value, from: dateOf('from'), to: dateOf('to') };
  const out = await session.priceVariance(ppvAsked.supplier, ppvAsked.from, ppvAsked.to);
  drill = null;
  if (out.result === 'ok') { ppv = out.value; $('ppv-status').className = 'status'; $('ppv-status').textContent = ''; }
  else { ppv = null; $('ppv-status').className = 'status err'; $('ppv-status').textContent = api.outcomeWords(lang, out); }
  paintPpv();
}

async function openDrill(kind, key) {
  if (ppvAsked === null) return;
  const out = await session.priceVariance(ppvAsked.supplier, ppvAsked.from, ppvAsked.to, kind === 'product' ? { productId: key } : { grnId: key });
  if (out.result === 'ok') { drill = { kind, key, view: out.value }; $('ppv-status').className = 'status'; $('ppv-status').textContent = ''; }
  else { $('ppv-status').className = 'status err'; $('ppv-status').textContent = api.outcomeWords(lang, out); }
  paintPpv();
}

async function show(event) {
  event?.preventDefault();
  const out = await session.scorecard($('supplier').value, dateOf('from'), dateOf('to'));
  if (out.result === 'ok') { card = out.value.scorecard; contractId = out.value.contractId; $('page-status').className = 'status'; $('page-status').textContent = ''; }
  else { card = null; $('page-status').className = 'status err'; $('page-status').textContent = api.outcomeWords(lang, out); }
  paint();
}

// M06-FR-03 (Round 4b): supplier contracts — its own tested session (window.supplierTerms).
const terms = window.supplierTerms ?? null;
const tt = (k) => (terms === null ? k : terms.words(lang, k));
let contracts = null;
function paintContracts() {
  for (const [id, key] of [['contracts-h', 'contractsH'], ['contracts-show-text', 'contractsShow'], ['contract-h', 'contractH'], ['contract-lead', 'contractLead'], ['k-id-l', 'contractId'],
    ['k-supplier-l', 'supplier'], ['k-starts-l', 'startsOn'], ['k-ends-l', 'endsOn'], ['k-lead-l', 'leadDays'], ['k-ask-text', 'ask'], ['k-record-text', 'record']]) { const n = $(id); if (n) n.textContent = tt(key); }
  const body = $('contracts').querySelector('tbody');
  body.replaceChildren();
  if (contracts === null) return;
  if (contracts.length === 0) { const tr = document.createElement('tr'); const td = document.createElement('td'); td.textContent = tt('noContracts'); tr.append(td); body.append(tr); return; }
  for (const a of contracts) {
    const tr = document.createElement('tr');
    tr.dataset.contract = a.contractId; tr.dataset.finding = a.finding;
    for (const [v, cls] of [[a.contractId, ''], [a.supplierId, ''], [tt(`f_${a.finding}`), a.finding === 'active' ? '' : 'over'], [`${a.daysRemaining} ${tt('daysLeft')}`, 'num']]) {
      const td = document.createElement('td'); td.textContent = v; if (cls) td.className = cls; tr.append(td);
    }
    body.append(tr);
  }
}
async function showContracts() {
  const out = await terms.session.contracts();
  if (out.result === 'ok') { contracts = out.value.alerts; $('contracts-status').className = 'status'; $('contracts-status').textContent = ''; }
  else { contracts = null; $('contracts-status').className = 'status err'; $('contracts-status').textContent = terms.outcomeWords(lang, out); }
  paintContracts();
}
const contractForm = () => ({ contractId: $('k-id').value, supplierId: $('k-supplier').value, startsOn: dateOf('k-starts'), endsOn: dateOf('k-ends'), leadDays: $('k-lead').value });
const kSay = (out) => { $('k-status').className = `status${out.result === 'ok' ? '' : ' err'}`; $('k-status').textContent = terms.outcomeWords(lang, out); };
if (terms !== null && terms.session.may.read) {
  $('contracts-section').hidden = false;
  $('contracts-show').addEventListener('click', () => { void showContracts(); });
  if (terms.session.may.manage) {
    $('contract-form').hidden = false;
    $('k-ask').addEventListener('click', async () => { kSay(await terms.session.askContract(contractForm())); });
    $('k-record').addEventListener('click', async () => { const out = await terms.session.recordContract(contractForm()); kSay(out); if (out.result === 'ok') await showContracts(); kSay(out); });
  }
}

$('ask').addEventListener('submit', (e) => { void show(e); });
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); paintPpv(); paintContracts(); });
$('ppv-show').addEventListener('click', () => { void showPpv(); });
$('ppv-back').addEventListener('click', () => { drill = null; paintPpv(); });
paint();
paintPpv();
paintContracts();
if (may.named && !may.read) { $('page-status').className = 'status err'; $('page-status').textContent = t('cannotRead'); }

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}

/** A greyed button says why (U1 · G3 · design system §4 "disabled state explains why"): the reason is the button's tooltip
 *  and the words beside it, in the reader's language. `why` is 'role' (your role may not), 'offline' (head office cannot
 *  be reached), a page's own { en, ta } pair or sentence; '' takes the words away. */
function whyWords() {
  return {
  role: { en: 'Your role may not do this.', ta: 'உங்கள் பங்குக்கு இதைச் செய்ய அனுமதி இல்லை.' },
  offline: { en: 'Head office cannot be reached, so this cannot be done now.', ta: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை, எனவே இப்போது இதைச் செய்ய முடியாது.' },
  };
}
function whyDisabled(btn, why) {
  const tongue = document.documentElement.lang === 'ta' ? 'ta' : 'en';
  const words = why === '' || why === undefined || why === null ? '' : typeof why === 'string' ? (whyWords()[why]?.[tongue] ?? why) : (why[tongue] ?? why.en);
  let note = btn.nextElementSibling;
  if (!(note && note.classList.contains('sre-why'))) {
    note = document.createElement('small'); note.className = 'sre-why';
    note.id = `${btn.id || `b${Math.random().toString(36).slice(2, 7)}`}-why`;
    btn.after(note);
  }
  note.textContent = words; note.hidden = words === '';
  if (words === '') { btn.removeAttribute('title'); btn.removeAttribute('aria-describedby'); } else { btn.title = words; btn.setAttribute('aria-describedby', note.id); }
}
// the chrome loads after this script: its shared date fields replace the plain ones once it is there
document.addEventListener('sre:chrome', () => { if (terms !== null) { shopDate('k-starts', { en: terms.words('en', 'startsOn'), ta: terms.words('ta', 'startsOn') }); shopDate('k-ends', { en: terms.words('en', 'endsOn'), ta: terms.words('ta', 'endsOn') }); } shopDate('from', { en: wordsIn('en', 'from'), ta: wordsIn('ta', 'from') }); shopDate('to', { en: wordsIn('en', 'to'), ta: wordsIn('ta', 'to') }); paint(); }, { once: true });
