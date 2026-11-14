// Supplier scorecard — the page over head office's D-10 route. The session (apps/web-erp/src/supplier-scorecard-session.ts,
// in the bundle as window.supplierScorecard) asks head office; this page only shows its answer: five figures built from
// the supplier's own purchase orders, goods receipts and matched invoices, each "Not rated" with its reason when head office
// cannot rate it — never a number. Nothing is written. Every word has a Tamil twin (in the session's copy).

const $ = (id) => document.getElementById(id);

// ── U2b (UI/UX gap audit G5 · P-07): a thing is PICKED by name through the chrome's picker, never typed as a code ───────
// The field keeps the id the page sends (the typed code stays possible when the list cannot be read — head office down,
// no right — so the form is never a dead end, P-01 · P-08); the chrome's sheet finds it by name, code or barcode and the
// name is shown beside the field. Mounted when the chrome is there (a page that paints first listens for `sre:chrome`).
// (one line on purpose: the page's own `  en: {` / `  ta: {` blocks stay the first ones the screen guardrails find)
const pickWords = { en: { choose: 'Choose…', pickProduct: 'Which product?', pickSupplier: 'Which supplier?', pickStore: 'Which store?', pickCustomer: 'Which customer?' }, ta: { choose: 'தேர்ந்தெடு…', pickProduct: 'எந்தப் பொருள்?', pickSupplier: 'எந்த விநியோகஸ்தர்?', pickStore: 'எந்தக் கடை?', pickCustomer: 'எந்த வாடிக்கையாளர்?' } };
const pickRepaints = [];
const repaintPickers = () => { for (const f of pickRepaints) f(); };
// U7 (Group C2): the picker is the chrome's ONE copy (`sreOffice.pickable`) — "Choose…" beside the field, the picked id in
// the field the page sends, the name beside it, the typed code the fallback; a kind may follow the form (null = no list,
// so no button). The page keeps its element ids (`#<id>-pick`, `#<id>-name`) and its own titles in both languages.
function pickable(inputId, kind, titleKey, extra = {}) {
  const office = window.sreOffice;
  if (!office || typeof office.pickable !== 'function') { document.addEventListener('sre:chrome', () => pickable(inputId, kind, titleKey, extra), { once: true }); return; }
  const titleNow = () => (typeof titleKey === 'function' ? titleKey() : titleKey);
  const row = office.pickable(inputId, typeof kind === 'function' ? null : kind, null, { ...extra, ...(typeof kind === 'function' ? { kindOf: kind } : {}), titleOf: () => ({ en: pickWords.en[titleNow()], ta: pickWords.ta[titleNow()] }) });
  if (row && typeof row.sreRepaint === 'function') pickRepaints.push(row.sreRepaint);
}
const api = window.supplierScorecard ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false };

let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));

// U2 · G14 (UI/UX gap audit): a date a shop person reads — dd/mm/yyyy in the chrome's shared field (`sreOffice.dateField`),
// while the page goes on sending ISO (`dateOf`). Before the chrome has loaded, or off the box, the field stays as it was.
const wordsIn = (l, k) => (api === null ? k : api.words(l, k)); // the page's own words, for either language (null off the box)
// U7 (Group C2): the shared dd/mm/yyyy field is the chrome's ONE copy (`sreOffice.shopDate`) — its label, "(required)"
// and hint follow the language toggle inside the chrome; the page keeps its element ids and reads ISO back through
// `sreOffice.dateOf`. Before the chrome has loaded, or off the box, the plain field stays, so the page is never dead.
const shopDates = new Set();
function shopDate(id, words, opts = {}) {
  const o = window.sreOffice;
  if (!o || typeof o.shopDate !== 'function') { document.addEventListener('sre:chrome', () => shopDate(id, words, opts), { once: true }); return; }
  if (shopDates.has(id)) return;
  if (o.shopDate(id, words, opts) !== null) shopDates.add(id);
}
const dateOf = (id) => { const o = window.sreOffice; return shopDates.has(id) && o && typeof o.dateOf === 'function' ? (o.dateOf(id) ?? '') : (document.getElementById(id)?.value ?? ''); };
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
// U5 (G17): the roll-ups, the receipt lines and the contracts stand on the chrome's register part — built once per host,
// fed by setRows; the column words are pairs, so the chrome repaints them on the toggle. A figure over the agreed price is
// said with the warning chip beside it, never by colour alone.
const pair = (k) => ({ en: api === null ? k : api.words('en', k), ta: api === null ? k : api.words('ta', k) });
const tables = {};
function register(host, spec) { if (!window.sreOffice) return null; const have = tables[spec.id]; if (have && have.connected()) return have; tables[spec.id] = window.sreOffice.table(host, spec); return tables[spec.id]; }
function over(text, isOver) { if (!isOver) return text; const s = document.createElement('span'); s.append(window.sreOffice.recordChip('warning', text)); return s; }
function rollupRows(host, rows, kind) {
  const reg = register(host, {
    id: `ppv-${kind}`, label: pair(kind === 'product' ? 'ppvByProduct' : 'ppvByReceipt'), pageSize: 10, sortable: true,
    columns: [
      { key: 'key', label: pair(kind === 'product' ? 'ppvProduct' : 'ppvReceipt'), value: (r) => (kind === 'product' ? (window.sreOffice.nameOf('product', r.key) ?? r.key) : r.key) },
      { key: 'compared', label: pair('ppvCompared'), value: (r) => `${r.comparedLines}/${r.lines}`, align: 'end' },
      { key: 'received', label: pair('ppvReceived'), value: (r) => api.signedRupees(r.receivedValueMinor).replace('+', ''), align: 'end' },
      { key: 'agreed', label: pair('ppvAgreed'), value: (r) => api.signedRupees(r.orderValueMinor).replace('+', ''), align: 'end' },
      { key: 'variance', label: pair('ppvVariance'), value: (r) => api.signedRupees(r.varianceMinor), sort: 'number', align: 'end', render: (r) => over(api.signedRupees(r.varianceMinor), r.varianceMinor > 0) },
      { key: 'contract', label: pair('ppvVsContract'), value: (r) => (r.contractLines === 0 ? t('ppvNoContract') : api.signedRupees(r.contractVarianceMinor)), align: 'end', render: (r) => over(r.contractLines === 0 ? t('ppvNoContract') : api.signedRupees(r.contractVarianceMinor), r.contractVarianceMinor > 0) },
      { key: 'open', label: pair('ppvOpen'), sort: false, value: () => t('ppvOpen'), render: (r) => { const open = document.createElement('button'); open.classList.add('sre-btn'); open.type = 'button'; open.dataset.drill = kind; open.dataset.key = r.key; open.append(t('ppvOpen')); withIcon(open, 'list'); open.addEventListener('click', () => { void openDrill(kind, r.key); }); return open; } },
    ],
    rowKey: (r) => r.key, rowData: (r) => ({ key: r.key }),
    empty: { title: pair('ppvNothing') },
  });
  reg.setRows(rows);
}
function lineRows(host, lines) {
  const reg = register(host, {
    id: 'ppv-lines', label: pair('ppvLines'), pageSize: 10, sortable: true,
    columns: [
      { key: 'receipt', label: pair('ppvReceipt'), value: (l) => `${l.receiptNumber} · ${l.receivedOn}` },
      { key: 'product', label: pair('ppvProduct'), value: (l) => window.sreOffice.nameOf('product', l.productId) ?? l.productId },
      { key: 'order', label: pair('ppvOrder'), value: (l) => l.poNumber ?? null },
      { key: 'kept', label: pair('ppvKept'), value: (l) => `${l.keptMinor} ${l.uom}`, align: 'end' },
      { key: 'received', label: pair('ppvReceived'), value: (l) => (api.receivedCostWords ? api.receivedCostWords(lang, l) : (l.receivedUnitCost === null ? null : api.costWords(l.receivedUnitCost))), align: 'end' },
      { key: 'agreed', label: pair('ppvAgreed'), value: (l) => (l.order === undefined ? `${t('ppvNotCompared')} ${t(`nc_${l.notCompared}`)}` : api.costWords(l.order.unitCost) + (l.order.basis === 'blanket_release' ? ` (${t('ppvBlanket')})` : '')), align: 'end' },
      { key: 'variance', label: pair('ppvVariance'), value: (l) => (l.order === undefined ? null : api.signedRupees(l.order.varianceMinor)), align: 'end', render: (l) => (l.order === undefined ? null : over(api.signedRupees(l.order.varianceMinor), l.order.varianceMinor > 0)) },
      { key: 'contract', label: pair('ppvContract'), value: (l) => (l.contract === undefined ? t('ppvNoContract') : `${api.costWords(l.contract.unitCost)} (${l.contract.agreementId})`), align: 'end' },
      { key: 'vsContract', label: pair('ppvVsContract'), value: (l) => (l.contract === undefined ? null : api.signedRupees(l.contract.varianceMinor)), align: 'end', render: (l) => (l.contract === undefined ? null : over(api.signedRupees(l.contract.varianceMinor), l.contract.varianceMinor > 0)) },
    ],
    rowKey: (l) => `${l.grnId}|${l.productId}`, rowData: (l) => ({ grn: l.grnId, product: l.productId }),
    empty: { title: pair('ppvNothing') },
  });
  if (reg === null) return;
  reg.setRows(lines);
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
  const tpair = (k) => ({ en: terms === null ? k : terms.words('en', k), ta: terms === null ? k : terms.words('ta', k) });
  const reg = register($('contracts'), {
    id: 'contracts', label: tpair('contractsH'), pageSize: 10, sortable: true,
    columns: [
      { key: 'contract', label: tpair('contractId'), value: (a) => a.contractId },
      { key: 'supplier', label: tpair('supplier'), value: (a) => window.sreOffice.nameOf('supplier', a.supplierId) ?? a.supplierId },
      // G13: where the contract stands is the one record chip — in force / ending soon / ended / not yet approved
      { key: 'finding', label: tpair('contractsH'), value: (a) => tt(`f_${a.finding}`), render: (a) => window.sreOffice.recordChip(a.finding === 'active' ? 'active' : a.finding === 'expiring_soon' ? 'due' : a.finding === 'expired' ? 'expired' : 'pending', tt(`f_${a.finding}`)) },
      { key: 'days', label: tpair('daysLeft'), value: (a) => a.daysRemaining, sort: 'number', align: 'end', render: (a) => document.createTextNode(`${a.daysRemaining} ${tt('daysLeft')}`) },
    ],
    rowKey: (a) => a.contractId, rowData: (a) => ({ contract: a.contractId, finding: a.finding }),
    empty: { title: tpair('noContracts') },
  });
  if (reg === null) return;
  if (contracts === null) reg.setState('unknown'); else reg.setRows(contracts);
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
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); repaintPickers(); paintPpv(); paintContracts(); });
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

pickable('supplier', 'supplier', 'pickSupplier');
// U5: the chrome's parts arrive after this script (sre-chrome.js is the page's last script) — paint again once they are here.
document.addEventListener('sre:chrome', () => { paint(); paintContracts(); }, { once: true });
