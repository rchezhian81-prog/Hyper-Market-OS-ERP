// Month-end — the view layer. Every rule lives in head office's routes; every word and reading in the TESTED session
// model (`apps/web-erp/src/finance-close-session.ts`), attached as `window.financeCloseSession` / `financeCloseKit`.
// The page draws what head office answered, sends a person's action in their own session (one idempotency key per
// click), then reads again so what is shown is what head office kept. Nothing is written when the page opens.

const $ = (id) => document.getElementById(id);
const session = window.financeCloseSession ?? null;
const kit = window.financeCloseKit ?? null;
let lang = 'en';
const w = (key, fill) => (kit === null ? key : kit.closeWords(lang)(key, fill));
const inr = (minor) => (kit === null ? String(minor) : kit.rupees(minor));
const may = session?.may ?? { read: false, resolve: false, post: false, budget: false };

let tab = 'payments';
let cache = { payments: null, pl: null, stock: null, budget: null, assets: null };

function status(id, out, good) {
  const el = $(id);
  if (out === null) { el.className = 'status'; el.textContent = ''; return; }
  const said = kit.sayOutcome(lang, out, good);
  el.className = `status ${said.ok ? 'good' : 'err'}`;
  el.textContent = said.text;
}
function note(id, text, cls = '') { const el = $(id); el.className = `status ${cls}`; el.textContent = text; }
const period = () => $('period').value;
const node = (tag, props = {}, ...kids) => { const n = document.createElement(tag); Object.assign(n, props); n.append(...kids); return n; };
const tile = (value, label, id) => { const t = node('div', { className: 'tile' }, node('b', { textContent: value }), node('small', { textContent: label })); if (id) t.dataset.tile = id; return t; };
async function busy(button, work) { button.disabled = true; try { await work(); } finally { button.disabled = false; } }

// ── Card and UPI with no answer ─────────────────────────────────────────────────────────────────────────────

function renderPayments() {
  const list = $('pay-list'); const tiles = $('pay-tiles');
  // A drawer a person has open stays open (and keeps what they typed) when head office's list is read again.
  const opened = new Map([...list.querySelectorAll('li[data-attempt] details.resolve[open]')].map((d) => [d.closest('li').dataset.attempt, d]));
  list.replaceChildren(); tiles.replaceChildren();
  const r = cache.payments;
  if (r === null) return;
  if (r.kind !== 'done') { status('pay-status', r, ''); return; }
  const v = r.body;
  tiles.append(tile(String(v.open), w('open'), 'open'), tile(inr(v.openMinor.card), w('openCard'), 'card'), tile(inr(v.openMinor.upi), w('openUpi'), 'upi'),
    tile(inr(v.owedToCustomersMinor), w('owed'), 'owed'), tile(String(v.flagged.length), w('flagged'), 'flagged'));
  if (v.exceptions.length === 0) { list.append(node('li', { className: 'empty', textContent: w('noPayments') })); return; }
  for (const e of v.exceptions) {
    const li = node('li', { className: `${e.state === 'open' ? 'open' : ''} ${v.flagged.includes(e.attemptId) ? 'flagged' : ''}` });
    li.dataset.attempt = e.attemptId;
    li.append(node('div', { className: 'head' },
      node('span', { className: 'amt', textContent: `${e.kind === 'card' ? w('kindCard') : w('kindUpi')} ${inr(e.amountMinor)}` }),
      node('span', { className: 'state', textContent: kit.paymentStateWords(lang, e) }),
      node('span', { className: 'facts', textContent: `${e.attemptId} · ${e.storeId || '—'} · ${e.laneId} · ${e.billRef} · ${e.tradingDay}` })));
    const stage = e.stage === 'raised' ? w('stageRaised') : w('stageCarried');
    const who = e.closedBy === null ? '' : ` · ${w('closedBy')} ${e.closedBy}${e.approvedBy === null ? '' : ` · ${w('approvedBy')} ${e.approvedBy}`}${e.reason ? ` · ${w('why')}: ${e.reason}` : ''}`;
    li.append(node('p', { className: 'facts', textContent: `${stage}${who}` }));
    if (e.governanceFlags.length > 0) li.append(node('p', { className: 'flags', textContent: w('flagsLine', { flags: e.governanceFlags.map((f) => kit.flagWords(lang, f)).join('; ') }) }));
    if (e.resolution !== null) li.append(node('p', { className: 'facts', textContent: `${e.resolution.via} · ${e.resolution.by} · ${e.resolution.resolvedAt}${e.resolution.detail ? ` · ${e.resolution.detail}` : ''}` }));
    for (const c of e.conflicts) li.append(node('p', { className: 'conflict', textContent: `${w('conflict')}: ${kit.conflictWords(lang, c)}` }));
    if (e.lateAnswer !== null) li.append(node('p', { className: 'facts', textContent: `${w('lateAnswer')}: ${e.lateAnswer.outcome} · ${e.lateAnswer.answeredBy} / ${e.lateAnswer.approvedBy}` }));
    if (e.state === 'open' && may.resolve) li.append(opened.get(e.attemptId) ?? resolveDrawer(e));
    list.append(li);
  }
}

function resolveDrawer(e) {
  const d = node('details', { className: 'resolve' });
  d.append(node('summary', { textContent: w('resolveH') }));
  const found = node('select', { className: 'found' });
  for (const [v, k] of [['captured', 'foundCaptured'], ['declined', 'foundDeclined'], ['voided', 'foundVoided'], ['nothing', 'foundNothing']]) found.append(node('option', { value: v, textContent: w(k) }));
  const amount = node('input', { className: 'amount', inputMode: 'decimal', value: (e.amountMinor / 100).toFixed(2) });
  const at = node('input', { className: 'at', type: 'datetime-local' });
  const complete = node('input', { className: 'complete', type: 'checkbox' });
  const go = node('button', { type: 'button', className: 'go', textContent: w('resolve') });
  const line = node('p', { className: 'status', role: 'status' });
  d.append(node('div', { className: 'row' },
    node('label', {}, node('span', { textContent: w('found') }), found),
    node('label', {}, node('span', { textContent: w('amount') }), amount),
    node('label', {}, node('span', { textContent: w('when') }), at)),
  node('label', { className: 'check' }, complete, node('span', { textContent: w('complete') })), go, line);
  go.addEventListener('click', () => busy(go, async () => {
    const minor = kit.paiseOf(amount.value);
    const out = await session.resolvePayment(e.attemptId, { found: found.value, amountMinor: minor ?? -1, at: at.value, statementComplete: complete.checked });
    const said = kit.sayOutcome(lang, out, out.kind === 'done' && out.body?.alreadyResolved ? w('alreadyResolved') : w('resolved'));
    note('pay-status', said.text, said.ok ? 'good' : 'err');
    await loadPayments(false);
  }));
  return d;
}

async function loadPayments(clear = true) {
  if (clear) note('pay-status', w('reading'));
  cache.payments = await session.paymentExceptions();
  if (clear || cache.payments.kind !== 'done') status('pay-status', cache.payments.kind === 'done' ? null : cache.payments, '');
  renderPayments();
}

// ── Profit and loss ─────────────────────────────────────────────────────────────────────────────────────────

function renderPl() {
  const table = $('pl-table'); const tiles = $('pl-tiles'); const notes = $('pl-notes');
  table.replaceChildren(); tiles.replaceChildren(); notes.replaceChildren();
  const r = cache.pl;
  if (r === null) return;
  if (r.kind !== 'done') { status('pl-status', r, ''); return; }
  const v = r.body;
  note('pl-status', `${w('periodState')}: ${v.periodState}${v.journals === 0 ? ` — ${w('noJournals')}` : ''}`);
  tiles.append(tile(inr(v.totalIncomeMinor), w('totalIncome'), 'income'), tile(inr(v.totalExpensesMinor), w('totalExpenses'), 'expenses'), tile(inr(v.netMinor), w('net'), 'net'));
  if (v.grossMargin !== null) tiles.append(tile(`${inr(v.grossMargin.grossMarginMinor)}${v.grossMargin.marginBps === null ? '' : ` (${(v.grossMargin.marginBps / 100).toFixed(1)}%)`}`, w('grossMargin'), 'margin'));
  const head = node('tr', {}, node('th', { textContent: w('account') }), node('th', { className: 'n', textContent: '₹' }));
  table.append(head);
  const section = (title, rows, total) => {
    table.append(node('tr', {}, node('th', { colSpan: 2, textContent: title })));
    for (const x of rows) { const tr = node('tr', {}, node('td', { textContent: x.account }), node('td', { className: 'n', textContent: inr(x.amountMinor) })); tr.dataset.account = x.account; table.append(tr); }
    table.append(node('tr', { className: 'total' }, node('td', { textContent: total[0] }), node('td', { className: 'n', textContent: inr(total[1]) })));
  };
  section(w('income'), v.income, [w('totalIncome'), v.totalIncomeMinor]);
  section(w('expenses'), v.expenses, [w('totalExpenses'), v.totalExpensesMinor]);
  table.append(node('tr', { className: 'total' }, node('td', { textContent: w('net') }), node('td', { className: 'n', textContent: inr(v.netMinor) })));
  for (const n of v.notInTheBooks) notes.append(node('li', { textContent: n }));
  if (v.unclassified.length > 0) notes.append(node('li', { textContent: `${w('unclassified')}: ${v.unclassified.map((u) => `${u.account} ${inr(u.netDebitMinor)}`).join(', ')}` }));
}
async function loadPl() {
  if (period() === '') return;
  note('pl-status', w('reading'));
  cache.pl = await session.profitAndLoss(period());
  renderPl();
}

// ── Month-end stock adjustment ──────────────────────────────────────────────────────────────────────────────

function renderStock() {
  const tiles = $('stock-tiles'); const list = $('stock-blockers');
  tiles.replaceChildren(); list.replaceChildren(); $('stock-posted').textContent = '';
  const r = cache.stock;
  $('post-adjustment').hidden = !may.post;
  if (r === null) return;
  if (r.kind !== 'done') { status('stock-status', r, ''); return; }
  note('stock-status', '');
  const v = r.body; const f = v.figures; const b = v.blockers;
  tiles.append(tile(inr(v.valuation.closingValueMinor), w('closingValue'), 'closing'), tile(inr(v.valuation.purchases.purchasesMinor), w('purchases'), 'purchases'));
  if (f !== null) tiles.append(tile(inr(f.booksInventoryBeforeMinor), w('booksBefore'), 'books'), tile(inr(f.costOfSalesMinor), w('cogs'), 'cogs'), tile(inr(f.inventoryChangeMinor), w('change'), 'change'));
  const add = (text, kind) => { const li = node('li', { textContent: text }); li.dataset.kind = kind; list.append(li); };
  for (const p of b.unvaluedProducts) add(w('unvaluedProduct', { name: p.name, store: p.storeId, qty: p.onHandMinor, uom: p.uom }), 'unvalued');
  for (const x of b.unvaluedReceipts) add(w('unvaluedReceipt', { what: x }), 'receipt');
  for (const x of b.heldWriteOffs) add(w('held', { what: x }), 'held');
  for (const x of b.outstandingPostings) add(w('outstanding', { what: x }), 'outstanding');
  if (b.notMapped) add(w('notMapped'), 'map');
  if (!b.any) list.append(node('li', { className: 'none', textContent: w('noBlockers') }));
  if (v.posted !== null) { $('stock-posted').textContent = `${w('alreadyPosted')} ${w('postedBy')} ${v.posted.postedBy}. ${v.posted.narrative}`; $('post-adjustment').hidden = true; }
}
async function loadStock() {
  if (period() === '') return;
  note('stock-status', w('reading'));
  cache.stock = await session.stockValuation(period());
  renderStock();
}
$('post-adjustment').addEventListener('click', () => busy($('post-adjustment'), async () => {
  const out = await session.postStockAdjustment(period());
  status('post-status', out, out.kind === 'done' && out.body?.alreadyPosted ? w('alreadyPosted') : w('adjustmentPosted'));
  await loadStock();
}));

// ── Budget and assets ───────────────────────────────────────────────────────────────────────────────────────

function budgetLine(account = '', amount = '') {
  const wrap = node('div', { className: 'row budget-line' });
  wrap.append(node('label', {}, node('span', { textContent: w('account') }), node('input', { className: 'b-account', value: account, autocomplete: 'off' })),
    node('label', {}, node('span', { textContent: `${w('budgetCol')} (₹)` }), node('input', { className: 'b-amount', value: amount, inputMode: 'decimal', autocomplete: 'off' })));
  $('budget-lines').append(wrap);
}
function renderBudget() {
  const table = $('budget-table'); table.replaceChildren();
  $('budget-edit').hidden = !may.budget;
  const r = cache.budget;
  if (r === null) return;
  if (r.kind !== 'done') { status('budget-status', r, ''); return; }
  const v = r.body;
  note('budget-status', v.budget === null ? w('noBudget') : `${w('version')} ${v.budget.version} · ${v.budget.setBy} · ${v.budget.at}${v.budget.reason ? ` · ${v.budget.reason}` : ''}`);
  table.append(node('tr', {}, node('th', { textContent: w('account') }), node('th', { className: 'n', textContent: w('budgetCol') }), node('th', { className: 'n', textContent: w('actual') }), node('th', { className: 'n', textContent: w('variance') })));
  for (const x of v.rows) { const tr = node('tr', {}, node('td', { textContent: x.account }), node('td', { className: 'n', textContent: inr(x.budgetMinor) }), node('td', { className: 'n', textContent: inr(x.actualMinor) }), node('td', { className: 'n', textContent: inr(x.varianceMinor) })); tr.dataset.account = x.account; table.append(tr); }
  for (const x of v.unbudgeted) { const tr = node('tr', {}, node('td', { textContent: `${x.account} — ${w('unbudgeted')}` }), node('td', { className: 'n', textContent: '—' }), node('td', { className: 'n', textContent: inr(x.actualMinor) }), node('td', { className: 'n', textContent: '—' })); tr.dataset.account = x.account; table.append(tr); }
  if (may.budget && $('budget-lines').childElementCount === 0) {
    for (const l of v.budget?.lines ?? []) budgetLine(l.account, (l.amountMinor / 100).toFixed(2));
    if ($('budget-lines').childElementCount === 0) budgetLine();
  }
}
function renderAssets() {
  const list = $('assets-list');
  const opened = new Map([...list.querySelectorAll('li[data-asset] details[open]')].map((d) => [d.closest('li').dataset.asset, d]));
  list.replaceChildren();
  $('asset-add').hidden = !may.post;
  $('run-depreciation').hidden = !may.post;
  const r = cache.assets;
  if (r === null) return;
  if (r.kind !== 'done') { status('assets-status', r, ''); return; }
  if (r.body.assets.length === 0) list.append(node('li', { className: 'empty', textContent: w('noAssets') }));
  for (const a of r.body.assets) {
    const li = node('li'); li.dataset.asset = a.assetId;
    li.append(node('div', { className: 'head' }, node('span', { className: 'amt', textContent: a.name }), node('span', { className: 'state', textContent: a.state === 'in_use' ? w('inUse') : w('disposed') }),
      node('span', { className: 'facts', textContent: `${a.assetId} · ${a.category} · ${a.storeId}` })));
    li.append(node('p', { className: 'facts', textContent: `${w('cost')} ${inr(a.costMinor)} · ${inr(a.monthlyMinor)} ${w('monthly')} · ${w('depreciated')} ${inr(a.depreciationPostedMinor)} · ${w('bookValue')} ${inr(a.bookValueMinor)} · ${w('inService')} ${a.inServiceDate}` }));
    for (const t of a.transfers) li.append(node('p', { className: 'facts', textContent: `${t.on}: ${t.fromStoreId} → ${t.toStoreId} (${t.reason})` }));
    if (a.disposal !== null) li.append(node('p', { className: 'facts', textContent: `${w('disposeOn')} ${a.disposal.on} · ${w('proceeds')} ${inr(a.disposal.proceedsMinor)} (${a.disposal.reason})` }));
    if (may.post && a.state === 'in_use') li.append(opened.get(a.assetId) ?? assetDrawer(a));
    list.append(li);
  }
}
function assetDrawer(a) {
  const d = node('details'); d.append(node('summary', { textContent: `${w('move')} / ${w('dispose')}` }));
  const to = node('input', { className: 'to', autocomplete: 'off' }); const on = node('input', { className: 'on', type: 'date' });
  const why = node('input', { className: 'why', autocomplete: 'off', maxLength: 300 });
  const proceeds = node('input', { className: 'proceeds', inputMode: 'decimal', autocomplete: 'off' });
  const move = node('button', { type: 'button', className: 'move', textContent: w('move') });
  const dispose = node('button', { type: 'button', className: 'dispose quiet', textContent: w('dispose') });
  d.append(node('div', { className: 'row' },
    node('label', {}, node('span', { textContent: w('moveTo') }), to), node('label', {}, node('span', { textContent: w('moveOn') }), on),
    node('label', {}, node('span', { textContent: w('reason') }), why), node('label', {}, node('span', { textContent: w('proceeds') }), proceeds)), node('div', { className: 'row' }, move, dispose));
  move.addEventListener('click', () => busy(move, async () => { status('assets-status', await session.moveAsset(a.assetId, to.value, on.value, why.value), w('moved')); await loadAssets(); }));
  dispose.addEventListener('click', () => busy(dispose, async () => { status('assets-status', await session.disposeAsset(a.assetId, on.value, kit.paiseOf(proceeds.value) ?? -1, why.value), w('disposedDone')); await loadAssets(); }));
  return d;
}
async function loadBudget() { if (period() === '') return; cache.budget = await session.budget(period()); renderBudget(); }
async function loadAssets() { cache.assets = await session.assets(); renderAssets(); }
$('budget-add-line').addEventListener('click', () => budgetLine());
$('budget-save').addEventListener('click', () => busy($('budget-save'), async () => {
  const lines = [...document.querySelectorAll('#budget-lines .budget-line')].map((row) => ({ account: row.querySelector('.b-account').value, amountMinor: kit.paiseOf(row.querySelector('.b-amount').value) ?? -1 }))
    .filter((l) => l.account.trim() !== '' || l.amountMinor !== -1);
  status('budget-save-status', await session.setBudget(period(), lines, $('budget-reason').value), w('budgetSaved'));
  await loadBudget();
}));
$('asset-add-go').addEventListener('click', () => busy($('asset-add-go'), async () => {
  const out = await session.addAsset({
    assetId: $('a-id').value, name: $('a-name').value, category: $('a-category').value, storeId: $('a-store').value,
    costMinor: kit.paiseOf($('a-cost').value) ?? NaN, salvageMinor: kit.paiseOf($('a-salvage').value) ?? NaN,
    usefulLifeMonths: /^\d+$/.test($('a-life').value.trim()) ? Number($('a-life').value.trim()) : NaN, inServiceDate: $('a-in').value,
  });
  status('asset-add-status', out, w('assetAdded'));
  await loadAssets();
}));
$('run-depreciation').addEventListener('click', () => busy($('run-depreciation'), async () => {
  const out = await session.runDepreciation(period());
  if (out.kind === 'done') {
    const parts = [out.body.posted.length > 0 ? w('ranPosted', { n: out.body.posted.length }) : w('ranNothing')];
    if (out.body.exceptions.length > 0) parts.push(w('ranExceptions', { what: out.body.exceptions.map((x) => `${x.entryId} (${x.detail})`).join('; ') }));
    note('run-status', parts.join(' '), out.body.exceptions.length > 0 ? 'err' : 'good');
  } else status('run-status', out, '');
  await loadAssets();
}));

// ── The frame ───────────────────────────────────────────────────────────────────────────────────────────────

const TABS = ['payments', 'pl', 'stock', 'plan'];
async function show(name) {
  tab = name;
  for (const t of TABS) { $(`view-${t}`).hidden = t !== name; $(`tab-${t}`).setAttribute('aria-current', t === name ? 'page' : 'false'); }
  if (!may.read) return;
  if (name === 'payments') await loadPayments();
  if (name === 'pl') await loadPl();
  if (name === 'stock') await loadStock();
  if (name === 'plan') { await loadBudget(); await loadAssets(); }
}
for (const t of TABS) $(`tab-${t}`).addEventListener('click', () => { void show(t); });
$('period').addEventListener('change', () => { cache = { ...cache, pl: null, stock: null, budget: null }; $('budget-lines').replaceChildren(); void show(tab); });

function paintWords() {
  document.title = `SRE ${w('title')}`;
  for (const [id, k] of [['title', 'title'], ['purpose', 'purpose'], ['l-period', 'month'], ['tab-payments', 'tabPayments'], ['tab-pl', 'tabPl'], ['tab-stock', 'tabStock'], ['tab-plan', 'tabPlan'],
    ['pay-h', 'payH'], ['pay-lede', 'payLede'], ['pl-h', 'plH'], ['pl-lede', 'plLede'], ['stock-h', 'stockH'], ['stock-lede', 'stockLede'], ['blockers-h', 'blockersH'], ['post-adjustment', 'postAdjustment'],
    ['budget-h', 'budgetH'], ['budget-lede', 'budgetLede'], ['budget-add-line', 'addLine'], ['l-budget-reason', 'reason'], ['budget-save', 'saveBudget'],
    ['assets-h', 'assetsH'], ['assets-lede', 'assetsLede'], ['asset-add-h', 'addAsset'], ['l-a-id', 'assetId'], ['l-a-name', 'assetName'], ['l-a-category', 'category'], ['l-a-store', 'store'],
    ['l-a-cost', 'cost'], ['l-a-salvage', 'salvage'], ['l-a-life', 'life'], ['l-a-in', 'inService'], ['asset-add-go', 'addAsset'], ['run-h', 'runH'], ['run-lede', 'runLede'], ['run-depreciation', 'run']]) {
    const el = $(id);
    if (el) el.textContent = w(k);
  }
  const nobody = $('nobody');
  nobody.hidden = session !== null;
  nobody.textContent = w('nobody');
  if (session !== null && !may.read) note('page-status', w('cannotRead'), 'err');
  else if (session !== null && !may.post && !may.resolve && !may.budget) note('page-status', w('readOnly'));
}

$('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  paintWords();
  $('pay-list').replaceChildren(); $('assets-list').replaceChildren(); // drawers are drawn again in the new language
  renderPayments(); renderPl(); renderStock(); renderBudget(); renderAssets();
});

paintWords();
if (session !== null) {
  $('period').value = session.period;
  if (!may.read) { $('tabs').hidden = true; for (const t of TABS) $(`view-${t}`).hidden = true; } else void show('payments');
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}
