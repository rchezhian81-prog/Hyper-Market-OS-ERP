// Compare side by side (M29-FR-02 · §27 Owner "branch comparison") — the page over head office's governed drill and compare.
// The session (apps/web-erp/src/branch-compare-session.ts, in the bundle as window.branchCompare) does every call; this page
// lays out what it is told. Nothing is read on open. Every word has a Tamil twin; every button its icon.

const $ = (id) => document.getElementById(id);
const api = window.branchCompare ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, compare: false, list: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function button(words, act, iconName, quiet) {
  const b = document.createElement('button'); b.type = 'button'; b.dataset.act = act; if (quiet) b.className = 'quiet';
  const i = icon(iconName); if (i !== null) b.append(i);
  b.append(text('span', words)); return b;
}
const rs = (minor) => api.rupees(minor);
let view = null;
let opened = null;

function labelOf(row) { return row.key === 'unattributed' ? t('unattributed') : row.label; }
function paintResult() {
  $('result').hidden = view === null;
  for (const id of ['r-rows', 'r-honesty']) $(id).replaceChildren();
  $('r-scope').textContent = ''; $('r-check').textContent = ''; $('r-total').textContent = '';
  if (view === null) return;
  const scope = view.branchScope;
  if (scope !== null) $('r-scope').textContent = `${t('scopeIs')} ${scope === 'all' ? t('scopeAll') : scope.join(', ')}`;
  if (view.by === 'vendor') $('r-honesty').append(text('li', `ⓘ ${t('periodNote')}`));
  for (const d of view.drills) {
    if (!d.reconciles) $('r-honesty').append(text('li', `⚠ ${t('drillWrong')} ${d.figure} — ${d.discrepancy ?? ''}`, 'attention'));
    if (d.withheldCount > 0) $('r-honesty').append(text('li', `ⓘ ${d.withheldCount} ${t('withheld')} ${rs(d.withheldTotalMinor)}`));
  }
  if (view.notAvailable !== undefined) { $('r-check').textContent = `${t('notAvailable')} ${view.notAvailable}`; return; }
  const c = view.comparison;
  if (c === undefined || c.rows.length === 0) { $('r-check').textContent = `○ ${t('nothing')}`; return; }
  $('r-check').textContent = c.reconciles ? `✓ ${t('reconciles')}` : `⚠ ${t('notReconciled')}`;
  $('r-check').className = c.reconciles ? '' : 'warn';
  c.rows.forEach((row, i) => {
    const tr = document.createElement('tr'); tr.dataset.key = row.key;
    const cells = [String(i + 1), labelOf(row), rs(row.valueMinor), api.share(row.shareBps), String(row.transactionCount)];
    cells.forEach((v, j) => { const td = text('td', v); if (j >= 2) td.className = 'num'; tr.append(td); });
    const td = document.createElement('td'); td.append(button(t('open'), 'open', 'search', true)); tr.append(td);
    $('r-rows').append(tr);
  });
  $('r-total').textContent = `${t('total')} ${rs(c.totalMinor)}`;
}
function paintTxns() {
  $('txns').hidden = view === null || opened === null;
  $('tx-rows').replaceChildren();
  if (view === null || opened === null) return;
  const row = view.comparison?.rows.find((r) => r.key === opened);
  $('txns-h').textContent = `${t('txnH')} ${row === undefined ? opened : labelOf(row)}`;
  for (const x of api.rowTransactions(view, opened)) {
    const tr = document.createElement('tr'); tr.dataset.txn = x.transactionId;
    [x.at, x.branchId, `${x.transactionId} · ${x.description}`, rs(x.amountMinor)].forEach((v, j) => { const td = text('td', v); if (j === 3) td.className = 'num'; tr.append(td); });
    $('tx-rows').append(tr);
  }
}
function paint() {
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['form-h', 'formH'], ['c-by-l', 'by'], ['c-from-l', 'from'], ['c-to-l', 'to'], ['c-go-text', 'go'], ['result-h', 'resultH'],
    ['th-name', 'by'], ['th-value', 'total'], ['th-share', 'share'], ['th-count', 'txns'], ['tx-when', 'when'], ['tx-branch', 'branch'], ['tx-what', 'what'], ['tx-amount', 'amount'], ['tx-close-text', 'close']]) $(id).textContent = t(key);
  if (api !== null) {
    const sel = $('c-by'); const keep = sel.value;
    sel.replaceChildren(...api.dimensions.map((d) => { const o = document.createElement('option'); o.value = d; o.textContent = t(`by_${d}`); return o; }));
    if (keep) sel.value = keep;
  }
  paintResult(); paintTxns();
}

for (const [id, name] of [['c-go', 'search'], ['tx-close', 'search-x']]) { const i = icon(name); if (i !== null) $(id).prepend(i); }
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.compare) $('page-status').textContent = t('cannotCompare');
else {
  const today = api.today();
  $('c-from').value = today; $('c-to').value = today;
  $('form').hidden = false;
  $('c-go').addEventListener('click', async () => {
    $('c-status').textContent = '';
    const out = await session.compare({ by: $('c-by').value, from: $('c-from').value, to: $('c-to').value });
    opened = null;
    if (out.result !== 'ok') { view = null; $('c-status').textContent = api.outcomeWords(lang, out); paint(); return; }
    view = out.value; paint();
  });
  $('r-rows').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act="open"]'); if (b === null) return;
    opened = b.closest('tr').dataset.key; paintTxns(); $('txns').scrollIntoView?.({ block: 'start' });
  });
  $('tx-close').addEventListener('click', () => { opened = null; paintTxns(); });
}
