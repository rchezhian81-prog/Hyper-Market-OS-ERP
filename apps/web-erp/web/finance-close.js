// Month-end — the view layer. Every rule lives in head office's routes; every word and reading in the TESTED session
// model (`apps/web-erp/src/finance-close-session.ts`), attached as `window.financeCloseSession` / `financeCloseKit`.
// The page draws what head office answered, sends a person's action in their own session (one idempotency key per
// click), then reads again so what is shown is what head office kept. Nothing is written when the page opens.

const $ = (id) => document.getElementById(id);

// ── U2b (UI/UX gap audit G14 · NFR-08): a date is written as the shop writes it — dd/mm/yyyy on the chrome's shared ──────
// field, the shop's calendar (31/02 refused beside the field), ISO to head office. A value already on the plain field is
// carried over; the plain field stays until the chrome is there, so the page is never dead.
const shopDates = new Map();
function repaintShopDates() { const l = document.documentElement.lang === 'ta' ? 'ta' : 'en'; for (const [id, words] of shopDates) { const lab = document.getElementById(id)?.closest('.sre-field')?.querySelector('.sre-field-label'); if (lab && lab.firstChild) lab.firstChild.textContent = words[l] ?? words.en; } }
function shopDate(id, words, opts = {}) {
  const office = window.sreOffice; const input = document.getElementById(id);
  if (!office || typeof office.dateField !== 'function') { document.addEventListener('sre:chrome', () => shopDate(id, words, opts), { once: true }); return; }
  if (input === null || shopDates.has(id)) return;
  const typed = input.value.trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(typed) ? typed : (typeof office.parseShopDate === 'function' ? office.parseShopDate(typed) : null);
  const field = office.dateField({ id, label: words, required: opts.required === true, ...(iso ? { value: iso } : {}) });
  if (!field) return;
  (input.closest('label') ?? input).replaceWith(field);
  shopDates.set(id, words);
  repaintShopDates();
}
const dateOf = (id) => (shopDates.has(id) ? (window.sreOffice.dateValue(id) ?? '') : (document.getElementById(id)?.value ?? ''));
const session = window.financeCloseSession ?? null;
/** OB-567: closing and reopening the month — only on this page (tested in `month-close-session.ts`). */
const month = window.monthCloseSession ?? null;
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
// W1: a figure is the shared summary card — its label, then the figure as head office gave it (never a made-up nought)
const tile = (value, label, id) => { const t = node('div', { className: 'tile sre-summary-card' }, node('small', { className: 'sre-summary-label', textContent: label }), node('b', { className: 'sre-summary-value', textContent: value })); if (id) t.dataset.tile = id; return t; };

// ── W1: the shared states for a list (window.sreOffice): reading · nothing yet · could not be read · not your role ──
// An empty list here was READ from head office — it says what is (not) there and that it is not a check of the month.
const W1 = {
  en: { emptyDetail: 'Read from head office just now. An empty list means there is nothing here to act on — it is not a check that the month is right.' },
  ta: { emptyDetail: 'இப்போதுதான் தலைமை அலுவலகத்திலிருந்து படிக்கப்பட்டது. காலியான பட்டியல் என்றால் இங்கு செய்ய எதுவும் இல்லை — மாதம் சரி என்ற சோதனை அல்ல.' },
};
const office = () => window.sreOffice ?? null;
/** Put a state into a list as one item: `kind` is the shared state's name; `title` the page's own words for it. */
function listState(list, kind, title, detail) {
  const o = office();
  const li = node('li', { className: `empty empty-state` });
  if (o) li.append(o.state(null, kind, { title, ...(detail === undefined ? {} : { detail }) })); else li.textContent = title;
  list.replaceChildren(li);
}
/** The state for an answer that is not `done`, in the page's own words from head office's answer. */
function listStateFor(list, r) {
  const kind = r.kind === 'unreachable' ? 'offline' : r.kind === 'not_allowed' || (r.kind === 'refused' && (r.status === 401 || r.status === 403)) ? 'denied' : 'error';
  listState(list, kind, kit.sayOutcome(lang, r, '').text);
}
document.addEventListener('sre:chrome', () => { renderPayments(); renderAssets(); });
async function busy(button, work) { button.disabled = true; try { await work(); } finally { button.disabled = false; } }

// ── Card and UPI with no answer ─────────────────────────────────────────────────────────────────────────────

function renderPayments() {
  const list = $('pay-list'); const tiles = $('pay-tiles');
  // A drawer a person has open stays open (and keeps what they typed) when head office's list is read again.
  const opened = new Map([...list.querySelectorAll('li[data-attempt] details.resolve[open]')].map((d) => [d.closest('li').dataset.attempt, d]));
  list.replaceChildren(); tiles.replaceChildren();
  const r = cache.payments;
  if (r === null) { if (may.read) listState(list, 'loading', w('reading')); return; }
  if (r.kind !== 'done') { status('pay-status', r, ''); listStateFor(list, r); return; }
  const v = r.body;
  tiles.append(tile(String(v.open), w('open'), 'open'), tile(inr(v.openMinor.card), w('openCard'), 'card'), tile(inr(v.openMinor.upi), w('openUpi'), 'upi'),
    tile(inr(v.owedToCustomersMinor), w('owed'), 'owed'), tile(String(v.flagged.length), w('flagged'), 'flagged'));
  if (v.exceptions.length === 0) { listState(list, 'empty', w('noPayments'), W1[lang]?.emptyDetail ?? W1.en.emptyDetail); return; }
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
  const go = node('button', { type: 'button', className: 'sre-btn go', textContent: w('resolve') });
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
  // U5 (G17): the statement as the chrome's register — a heading row per section, the lines, the totals; no sorting or
  // search (a statement keeps its order), the figures right-aligned, the rows stacking on a phone.
  const lines = [
    { kind: 'heading', account: w('income'), amountMinor: null },
    ...v.income.map((x) => ({ kind: 'line', account: x.account, amountMinor: x.amountMinor })),
    { kind: 'total', account: w('totalIncome'), amountMinor: v.totalIncomeMinor },
    { kind: 'heading', account: w('expenses'), amountMinor: null },
    ...v.expenses.map((x) => ({ kind: 'line', account: x.account, amountMinor: x.amountMinor })),
    { kind: 'total', account: w('totalExpenses'), amountMinor: v.totalExpensesMinor },
    { kind: 'total', account: w('net'), amountMinor: v.netMinor },
  ];
  const o = office();
  if (o !== null) {
    o.table(table, {
      id: 'finance-pl', label: w('plH'), bodyId: 'pl-rows', pageSize: 500, search: false, count: false, sortable: false,
      rowKey: (x, i) => `${x.kind}-${x.account}-${i}`, rowData: (x) => ({ account: x.account, kind: x.kind }), rows: lines,
      columns: [
        { key: 'account', label: w('account'), sort: false },
        { key: 'amountMinor', label: '₹', align: 'end', sort: false, render: (x) => (x.amountMinor === null ? '' : inr(x.amountMinor)) },
      ],
    });
  }
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

// OB-698: before money or stock moves, the shared confirm sheet (the chrome's) says what will happen in the person's own
// words and asks for their word. Go back sends nothing. The words live here, in both languages, filled with the month.
const officeWithSheet = () => (window.sreOffice && typeof window.sreOffice.confirm === 'function' ? Promise.resolve(window.sreOffice) : new Promise((resolve) => document.addEventListener('sre:chrome', () => resolve(window.sreOffice), { once: true })));
const fillIn = (text, values) => Object.entries(values).reduce((acc, [k, v]) => acc.split(`{${k}}`).join(String(v)), text);
const MONTHS = { en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'], ta: ['ஜனவரி', 'பிப்ரவரி', 'மார்ச்', 'ஏப்ரல்', 'மே', 'ஜூன்', 'ஜூலை', 'ஆகஸ்ட்', 'செப்டம்பர்', 'அக்டோபர்', 'நவம்பர்', 'டிசம்பர்'] };
/** The month in words from its own digits (never the device's clock or zone, OB-606): 2026-10 → "October 2026". */
const monthInWords = (p, l) => { const m = /^(\d{4})-(\d{2})$/.exec(p); if (!m) return p; const name = MONTHS[l === 'ta' ? 'ta' : 'en'][Number(m[2]) - 1]; return name === undefined ? p : `${name} ${m[1]}`; };
const CONFIRM_WORDS = {
  en: {
    authority: 'In your name. Where a second person\'s signature or approval was asked for, head office uses it and refuses without it.',
    adjustTitle: 'The month-end stock adjustment for {m} will be posted to the accounts', adjustDetail: 'The valuation head office read becomes a journal in the books for that month. Nothing posts twice. The month\'s profit and loss changes with it.', adjustLabel: 'Post the adjustment',
    closeTitle: 'The month {m} will be closed', closeDetail: 'No day of {m} can be posted or changed after this; Tally files and GST returns are built from what is in the books now. Reopening needs the owner\'s approval and a reason.', closeLabel: 'Close the month',
    reopenTitle: 'The month {m} will be reopened', reopenDetail: 'Days of {m} can be posted and changed again, and every file built from the closed month is out of date until it is closed once more.', reopenLabel: 'Reopen the month',
    depTitle: 'Depreciation for {m} will be posted for every asset in service', depDetail: 'One journal per asset, once per month. Running it again posts nothing twice.', depLabel: 'Post depreciation',
  },
  ta: {
    authority: 'உங்கள் பெயரில். இரண்டாவது நபரின் கையொப்பமோ அனுமதியோ கேட்கப்பட்ட இடத்தில் தலைமை அலுவலகம் அதைப் பயன்படுத்தும்; அது இல்லாமல் மறுக்கும்.',
    adjustTitle: '{m} மாத இறுதி சரக்கு சரிசெய்தல் கணக்குகளில் பதியப்படும்', adjustDetail: 'தலைமை அலுவலகம் படித்த மதிப்பீடு அந்த மாதத்தின் புத்தகங்களில் ஒரு பதிவாகும். எதுவும் இருமுறை பதியப்படாது. மாதத்தின் லாப நட்டம் அதனுடன் மாறும்.', adjustLabel: 'சரிசெய்தலைப் பதி',
    closeTitle: '{m} மாதம் மூடப்படும்', closeDetail: 'இதன் பிறகு {m} மாதத்தின் எந்த நாளையும் பதியவோ மாற்றவோ முடியாது; டாலி கோப்புகளும் ஜிஎஸ்டி ரிட்டர்ன்களும் இப்போது புத்தகங்களில் உள்ளதிலிருந்து உருவாக்கப்படும். மீண்டும் திறக்க உரிமையாளரின் அனுமதியும் காரணமும் தேவை.', closeLabel: 'மாதத்தை மூடு',
    reopenTitle: '{m} மாதம் மீண்டும் திறக்கப்படும்', reopenDetail: '{m} மாதத்தின் நாட்களை மீண்டும் பதியவும் மாற்றவும் முடியும்; மூடிய மாதத்திலிருந்து உருவாக்கிய ஒவ்வொரு கோப்பும் மீண்டும் மூடும் வரை காலாவதியானது.', reopenLabel: 'மாதத்தை மீண்டும் திற',
    depTitle: '{m} மாதத்திற்கான தேய்மானம் பயன்பாட்டில் உள்ள ஒவ்வொரு சொத்துக்கும் பதியப்படும்', depDetail: 'ஒரு சொத்துக்கு ஒரு பதிவு, மாதத்திற்கு ஒருமுறை. மீண்டும் இயக்கினால் எதுவும் இருமுறை பதியப்படாது.', depLabel: 'தேய்மானத்தைப் பதி',
  },
};
const confirmSheet = async (kind, tone = 'primary') => {
  const pair = (key) => ({ en: fillIn(CONFIRM_WORDS.en[key], { m: monthInWords(period(), 'en') }), ta: fillIn(CONFIRM_WORDS.ta[key], { m: monthInWords(period(), 'ta') }) });
  return (await officeWithSheet()).confirm({ title: pair(`${kind}Title`), detail: pair(`${kind}Detail`), authority: pair('authority'), confirmLabel: pair(`${kind}Label`), tone });
};
$('post-adjustment').addEventListener('click', () => busy($('post-adjustment'), async () => {
  if (!(await confirmSheet('adjust')).ok) return;
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
  // U5 (G17): budget against actual on the chrome's register — sortable by any column, searchable, the figures right-aligned.
  const o = office();
  if (o !== null) {
    o.table(table, {
      id: 'finance-budget', label: w('budgetH'), bodyId: 'budget-rows', pageSize: 100, sortable: true, count: false,
      rowKey: (x) => x.account, rowData: (x) => ({ account: x.account }),
      rows: [...v.rows.map((x) => ({ ...x, unbudgeted: false })), ...v.unbudgeted.map((x) => ({ account: x.account, budgetMinor: null, actualMinor: x.actualMinor, varianceMinor: null, unbudgeted: true }))],
      columns: [
        { key: 'account', label: w('account'), sort: 'text', render: (x) => (x.unbudgeted ? `${x.account} — ${w('unbudgeted')}` : x.account) },
        { key: 'budgetMinor', label: w('budgetCol'), align: 'end', sort: 'number', render: (x) => (x.budgetMinor === null ? '—' : inr(x.budgetMinor)) },
        { key: 'actualMinor', label: w('actual'), align: 'end', sort: 'number', render: (x) => inr(x.actualMinor) },
        { key: 'varianceMinor', label: w('variance'), align: 'end', sort: 'number', render: (x) => (x.varianceMinor === null ? '—' : inr(x.varianceMinor)) },
      ],
    });
  }
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
  if (r.kind !== 'done') { status('assets-status', r, ''); listStateFor(list, r); return; }
  if (r.body.assets.length === 0) listState(list, 'empty', w('noAssets'), W1[lang]?.emptyDetail ?? W1.en.emptyDetail);
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
    usefulLifeMonths: /^\d+$/.test($('a-life').value.trim()) ? Number($('a-life').value.trim()) : NaN, inServiceDate: dateOf('a-in'),
  });
  status('asset-add-status', out, w('assetAdded'));
  await loadAssets();
}));
$('run-depreciation').addEventListener('click', () => busy($('run-depreciation'), async () => {
  if (!(await confirmSheet('dep')).ok) return;
  const out = await session.runDepreciation(period());
  if (out.kind === 'done') {
    const parts = [out.body.posted.length > 0 ? w('ranPosted', { n: out.body.posted.length }) : w('ranNothing')];
    if (out.body.exceptions.length > 0) parts.push(w('ranExceptions', { what: out.body.exceptions.map((x) => `${x.entryId} (${x.detail})`).join('; ') }));
    note('run-status', parts.join(' '), out.body.exceptions.length > 0 ? 'err' : 'good');
  } else status('run-status', out, '');
  await loadAssets();
}));

// ── Close or reopen the month (OB-567 · ADR-0024 · §28) ───────────────────────────────────────────────────────
// Head office's own word on whether the month is closed decides which step shows; every step is the person's own, in
// their own session, on a click; head office checks its own figures and says what stops it — shown in its words.

const mw = (key) => (month === null ? key : month.text(lang, key));
let monthState = null;
/** The reason a reopen was last asked with — "Reopen the month" sends exactly that reason. */
let reopenAskedFor = null;

function paintMonthState() {
  const line = $('month-state');
  if (monthState === null) { line.textContent = ''; return; }
  const p = month.presentState(lang, monthState);
  line.textContent = `${p.icon} ${p.label}`;
  line.dataset.tone = p.tone;
  const offer = month.mayClose && monthState.known;
  $('close-box').hidden = !(offer && !monthState.closed);
  $('reopen-box').hidden = !(offer && monthState.closed);
  if (monthState.known && !month.mayClose) note('month-status', mw('mayNot'));
  // Once the reopen was asked for with exactly the reason in the box, "Reopen the month" is the main action.
  const asked = reopenAskedFor !== null && reopenAskedFor === $('reopen-reason').value.trim();
  $('ask-reopen').classList.toggle('quiet', asked);
  $('reopen').classList.toggle('quiet', !asked);
}
$('reopen-reason').addEventListener('input', () => { if (monthState !== null) paintMonthState(); });
function paintRequest(id, presented) {
  const line = $(id);
  if (presented === null) { line.hidden = true; line.textContent = ''; return; }
  line.hidden = false;
  line.textContent = `${presented.icon} ${mw('yourRequest')}: ${presented.label}`;
}
async function loadMonth() {
  if (month === null) return;
  if (period() === '') { monthState = null; paintMonthState(); note('month-status', mw('pickMonth'), 'err'); return; }
  monthState = await month.state(period());
  paintMonthState();
  const mine = await month.yourRequests(lang, period());
  paintRequest('close-request', mine.close);
  paintRequest('reopen-request', mine.reopen);
  if (mine.state === 'read') reopenAskedFor = mine.reopenReason === null ? null : mine.reopenReason.trim();
  // A reopen still in play carries its reason: put it back in the box, so "Reopen the month" sends exactly it.
  if (mine.reopenReason !== null && $('reopen-reason').value.trim() === '') $('reopen-reason').value = mine.reopenReason;
  paintMonthState();
}
/** Say what happened, in the model's own words (both languages, tested) — then read head office again. */
async function said(presented) {
  note('month-status', `${presented.icon} ${presented.label}`, presented.tone === 'ok' ? 'good' : presented.tone === 'error' ? 'err' : '');
  const keep = $('month-status').textContent; const cls = $('month-status').className;
  await loadMonth();
  $('month-status').textContent = keep; $('month-status').className = cls;
}
$('ask-close').addEventListener('click', () => busy($('ask-close'), async () => {
  const outcome = await month.askToClose(lang, period(), $('close-why').value);
  if (outcome.kind === 'asked') $('close-why').value = '';
  await said(month.presentAskOutcome(lang, 'close', outcome));
}));
$('close-month').addEventListener('click', () => busy($('close-month'), async () => {
  if (!(await confirmSheet('close', 'danger')).ok) return;
  await said(month.presentUseOutcome(lang, 'close', await month.closeWithApproval(period())));
}));
$('ask-reopen').addEventListener('click', () => busy($('ask-reopen'), async () => {
  const reason = $('reopen-reason').value;
  const outcome = await month.askToReopen(lang, period(), reason);
  // The reason STAYS in the box: the reopen sends exactly the reason that was approved.
  if (outcome.kind === 'asked') reopenAskedFor = reason.trim();
  await said(month.presentAskOutcome(lang, 'reopen', outcome));
}));
$('reopen').addEventListener('click', () => busy($('reopen'), async () => {
  if (!(await confirmSheet('reopen', 'danger')).ok) return;
  const outcome = await month.reopenWithApproval(period(), $('reopen-reason').value);
  if (outcome.kind === 'done') { reopenAskedFor = null; $('reopen-reason').value = ''; }
  await said(month.presentUseOutcome(lang, 'reopen', outcome));
}));

// ── The frame ───────────────────────────────────────────────────────────────────────────────────────────────

// W5: 'books' and 'ca' are drawn by finance-close-books.js (their own session; each read is a click there).
const TABS = ['payments', 'pl', 'stock', 'plan', 'month', 'owed', 'books', 'ca'];
async function show(name) {
  tab = name;
  for (const t of TABS) { $(`view-${t}`).hidden = t !== name; $(`tab-${t}`).setAttribute('aria-current', t === name ? 'page' : 'false'); }
  if (!may.read) return;
  if (name === 'payments') await loadPayments();
  if (name === 'pl') await loadPl();
  if (name === 'stock') await loadStock();
  if (name === 'plan') { await loadBudget(); await loadAssets(); }
  if (name === 'month') { note('month-status', ''); await loadMonth(); }
  if (name === 'owed') await loadOwed();
}
for (const t of TABS) $(`tab-${t}`).addEventListener('click', () => { void show(t); });
$('period').addEventListener('change', () => { cache = { ...cache, pl: null, stock: null, budget: null }; monthState = null; reopenAskedFor = null; $('budget-lines').replaceChildren(); void show(tab); });

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
  if (month !== null) {
    for (const [id, k] of [['tab-month', 'tab'], ['month-h', 'heading'], ['month-lede', 'lede'], ['close-title', 'closeTitle'], ['close-lead', 'closeLead'],
      ['close-why-label', 'closeWhyLabel'], ['ask-close', 'askClose'], ['close-month', 'closeMonth'], ['close-note', 'closeNote'], ['reopen-title', 'reopenTitle'],
      ['reopen-lead', 'reopenLead'], ['reopen-reason-label', 'reopenReasonLabel'], ['ask-reopen', 'askReopen'], ['reopen', 'reopenIt']]) $(id).textContent = mw(k);
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
  repaintShopDates();
  $('pay-list').replaceChildren(); $('assets-list').replaceChildren(); // drawers are drawn again in the new language
  renderPayments(); renderPl(); renderStock(); renderBudget(); renderAssets();
  if (tab === 'month') void loadMonth();
  paintOwedWords(); renderOwed();
});

// ── W3 (D10-FR-04): what the shop owes customers ────────────────────────────────────────────────────────────
const owedApi = window.liabilities ?? null;
const ow = (k, fill) => (owedApi === null ? k : owedApi.words(lang, k, fill));
let owed = null;
function paintOwedWords() {
  if (owedApi === null) { $('tab-owed').hidden = true; return; }
  for (const [id, k] of [['tab-owed', 'tab'], ['owed-h', 'heading'], ['owed-lede', 'lede'], ['owed-show', 'show'], ['owed-post', 'post']]) $(id).textContent = ow(k);
}
function renderOwed() {
  const tiles = $('owed-tiles'); const list = $('owed-list'); tiles.replaceChildren(); list.replaceChildren();
  if (owed === null) return;
  const { loyalty, referral } = owed;
  const line = (key, title, heldText, booksText, diffMinor, agrees, extra) => {
    const li = node('li', { className: agrees ? '' : 'flagged' }); li.dataset.owed = key;
    li.append(node('div', { className: 'head' }, node('strong', { textContent: title }), node('span', { className: 'amt', textContent: agrees ? ow('agrees') : ow('differs') })));
    li.append(node('p', { className: 'facts', textContent: `${ow('held')}: ${heldText} · ${ow('books')}: ${booksText} · ${ow('difference')}: ${diffMinor === null ? ow('notKnown') : inr(diffMinor)}` }));
    for (const x of extra) li.append(node('p', { className: 'facts', textContent: x }));
    list.append(li);
  };
  tiles.append(tile(inr(loyalty.points.heldValueMinor), ow('loyaltyH'), 'points'), tile(inr(loyalty.storeCredit.heldMinor), ow('creditH'), 'credit'),
    tile(inr(referral.register.outstandingMinor), ow('referralH'), 'referral'));
  line('points', ow('loyaltyH'), `${ow('points', { points: loyalty.points.outstandingPoints, value: inr(loyalty.points.pointValuePaise) })} = ${inr(loyalty.points.heldValueMinor)}`, inr(loyalty.points.postedMinor), loyalty.points.differenceMinor, loyalty.points.reconciles, [`${ow('account')}: ${loyalty.points.account}`]);
  line('credit', ow('creditH'), inr(loyalty.storeCredit.heldMinor), inr(loyalty.storeCredit.postedMinor), loyalty.storeCredit.differenceMinor, loyalty.storeCredit.reconciles, [`${ow('account')}: ${loyalty.storeCredit.account}`]);
  line('referral', ow('referralH'), `${ow('owed')} ${inr(referral.register.outstandingMinor)}`, referral.booksMinor === null ? ow('notKnown') : inr(referral.booksMinor), referral.differenceMinor, referral.reconciles,
    [referral.account === null ? ow('notMapped') : `${ow('account')}: ${referral.account}`, ...(referral.unposted.length > 0 ? [ow('unposted', { count: referral.unposted.length })] : []), ...(referral.exception !== null && referral.account !== null ? [referral.exception.detail] : []), `${ow('coupons')}: ${referral.coupons.detail}`]);
}
async function loadOwed() {
  if (owedApi === null) return;
  note('owed-status', ow('reading'));
  const out = await owedApi.session.read();
  if (out.result !== 'ok') { owed = null; renderOwed(); note('owed-status', owedApi.outcomeWords(lang, out), 'err'); return; }
  owed = out.value; note('owed-status', ''); renderOwed();
}
$('owed-show').addEventListener('click', () => { void loadOwed(); });
$('owed-post').addEventListener('click', () => busy($('owed-post'), async () => {
  const out = await owedApi.session.postReferrals();
  if (out.result !== 'ok') { note('owed-status', owedApi.outcomeWords(lang, out), 'err'); return; }
  const said = [out.value.posted.length > 0 ? ow('posted', { count: out.value.posted.length }) : ow('nothingToPost'), ...out.value.exceptions.map((x) => ow('notPosted', { kind: x.kind, reason: x.reason }))].join(' ');
  await loadOwed();
  note('owed-status', said, out.value.exceptions.length > 0 ? 'err' : 'good');
}));
paintOwedWords();
if (owedApi !== null && owedApi.session.may.post) $('owed-post').hidden = false;

paintWords();
if (session !== null) {
  // A month to start on: the one head office names, else this month — never a blank every tab reads as 'pick a month'.
  $('period').value = session.period || new Date().toISOString().slice(0, 7);
  if (!may.read) { $('tabs').hidden = true; for (const t of TABS) $(`view-${t}`).hidden = true; } else void show('payments');
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}

if (kit !== null) shopDate('a-in', { en: kit.closeWords('en')('inService'), ta: kit.closeWords('ta')('inService') });
