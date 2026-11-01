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
// UI-3: the words for the ranking's source line and its chart (the rest of the page's words are the session's own).
const UI3 = {
  en: { covers: '{by} · {from} to {to} · {scope} · head office answered at {time}', rank: 'Rank', share: 'of the total' },
  ta: { covers: '{by} · {from} முதல் {to} வரை · {scope} · தலைமை அலுவலகம் பதிலளித்த நேரம் {time}', rank: 'வரிசை', share: 'மொத்தத்தில்' },
};
const u3 = (k) => UI3[lang][k] ?? UI3.en[k];
const fillIn = (text, values) => Object.entries(values).reduce((w, [k, v]) => w.split(`{${k}}`).join(String(v)), text);
// UI-3: the shared office parts (window.sreOffice, from the chrome — a page that paints first listens for `sre:chrome`).
const office = () => window.sreOffice ?? null;
/** Set an element's words when it is on the page (the register replaces the plain table's headings with its own). */
const setText = (id, words) => { const n = $(id); if (n !== null) n.textContent = words; };
let asked = null; // what was asked, and when head office answered (OB-607: shown at the shop's clock)
let view = null;
let opened = null;

function labelOf(row) { return row.key === 'unattributed' ? t('unattributed') : row.label; }
function paintResult() {
  $('result').hidden = view === null;
  for (const id of ['r-rows', 'r-honesty', 'r-chart', 'r-cards']) $(id)?.replaceChildren();
  $('r-scope').textContent = ''; $('r-check').textContent = ''; $('r-total').textContent = ''; $('r-covers').textContent = '';
  if (view === null) return;
  if (asked !== null) {
    $('r-covers').textContent = fillIn(u3('covers'), {
      by: t(`by_${asked.by}`), from: asked.from, to: asked.to,
      scope: view.branchScope === null ? '' : `${t('scopeIs')} ${view.branchScope === 'all' ? t('scopeAll') : view.branchScope.join(', ')}`,
      time: window.sreShopDay?.dateTimeOf(asked.at) ?? asked.at,
    });
  }
  const scope = view.branchScope;
  if (scope !== null) $('r-scope').textContent = `${t('scopeIs')} ${scope === 'all' ? t('scopeAll') : scope.join(', ')}`;
  if (view.by === 'vendor') $('r-honesty').append(text('li', `ⓘ ${t('periodNote')}`));
  for (const d of view.drills) {
    if (!d.reconciles) $('r-honesty').append(text('li', `⚠ ${t('drillWrong')} ${d.figure} — ${d.discrepancy ?? ''}`, 'attention'));
    if (d.withheldCount > 0) $('r-honesty').append(text('li', `ⓘ ${d.withheldCount} ${t('withheld')} ${rs(d.withheldTotalMinor)}`));
  }
  if (view.notAvailable !== undefined) { $('r-check').textContent = `${t('notAvailable')} ${view.notAvailable}`; return; }
  const c = view.comparison;
  if (c === undefined || c.rows.length === 0) {
    $('r-check').textContent = `○ ${t('nothing')}`;
    // An empty ranking says what it covered — never an all-clear (P-08).
    office()?.state($('r-register'), 'empty', { title: t('nothing'), detail: $('r-covers').textContent });
    return;
  }
  $('r-check').textContent = c.reconciles ? `✓ ${t('reconciles')}` : `⚠ ${t('notReconciled')}`;
  $('r-check').className = c.reconciles ? '' : 'warn';
  const o = office();
  if (o !== null) {
    // UI-3: the figures as cards, the rows as the shared register — head office's order and figures, nothing added up here
    // beyond what the page already showed (the transactions are the rows' own counts).
    o.cards($('r-cards'), [
      { label: t('total'), value: rs(c.totalMinor), note: c.reconciles ? t('reconciles') : t('notReconciled'), tone: c.reconciles ? 'ok' : 'error', icon: 'indian-rupee' },
      { label: t('resultH'), value: c.rows.length, note: $('r-covers').textContent, icon: 'chart-column' },
    ]);
    o.table($('r-register'), {
      id: 'compare-rows', label: t('resultH'), bodyId: 'r-rows', pageSize: 50, rowKey: (r) => r.key,
      rows: c.rows.map((row, i) => ({ ...row, rank: i + 1 })),
      columns: [
        { key: 'rank', label: '#', sort: 'number', align: 'end' },
        { key: 'label', label: t('by'), sort: 'text', value: (r) => labelOf(r) },
        { key: 'valueMinor', label: t('total'), sort: 'number', align: 'end', render: (r) => rs(r.valueMinor) },
        { key: 'shareBps', label: t('share'), sort: 'number', align: 'end', render: (r) => api.share(r.shareBps) },
        { key: 'transactionCount', label: t('txns'), sort: 'number', align: 'end' },
        { key: 'open', label: t('open'), render: () => button(t('open'), 'open', 'search', true) },
      ],
    });
  } else c.rows.forEach((row, i) => {
    const tr = document.createElement('tr'); tr.dataset.key = row.key;
    const cells = [String(i + 1), labelOf(row), rs(row.valueMinor), api.share(row.shareBps), String(row.transactionCount)];
    cells.forEach((v, j) => { const td = text('td', v); if (j >= 2) td.className = 'num'; tr.append(td); });
    const td = document.createElement('td'); td.append(button(t('open'), 'open', 'search', true)); tr.append(td);
    $('r-rows').append(tr);
  });
  $('r-total').textContent = `${t('total')} ${rs(c.totalMinor)}`;
  // UI-3: the same rows as a chart — head office's own figures and order, each bar with its rupees and share in words.
  if (window.sreCharts !== undefined) {
    window.sreCharts.draw($('r-chart'), {
      id: 'compare', kind: 'bars', title: t(`by_${view.by}`), covers: $('r-covers').textContent,
      labelHeading: u3('rank'), valueHeading: t('total'),
      rows: c.rows.map((row) => ({ key: row.key, label: labelOf(row), value: row.valueMinor, text: `${rs(row.valueMinor)} · ${api.share(row.shareBps)} ${u3('share')}` })),
    }, lang);
    // The chart's own caption carries the source line, so it is not said twice.
    $('r-covers').hidden = true;
  }
}
function paintTxns() {
  $('txns').hidden = view === null || opened === null;
  $('tx-rows')?.replaceChildren();
  if (view === null || opened === null) return;
  const row = view.comparison?.rows.find((r) => r.key === opened);
  $('txns-h').textContent = `${t('txnH')} ${row === undefined ? opened : labelOf(row)}`;
  const txns = api.rowTransactions(view, opened);
  const o = office();
  if (o !== null) {
    o.table($('tx-register'), {
      id: 'compare-txns', label: $('txns-h').textContent, bodyId: 'tx-rows', pageSize: 50, rowKey: (x) => x.transactionId, rowData: (x) => ({ txn: x.transactionId }),
      rows: txns,
      columns: [
        { key: 'at', label: t('when'), sort: 'text' },
        { key: 'branchId', label: t('branch'), sort: 'text', filter: true },
        { key: 'what', label: t('what'), value: (x) => `${x.transactionId} · ${x.description}` },
        { key: 'amountMinor', label: t('amount'), sort: 'number', align: 'end', render: (x) => rs(x.amountMinor) },
      ],
    });
    return;
  }
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
    ['th-name', 'by'], ['th-value', 'total'], ['th-share', 'share'], ['th-count', 'txns'], ['tx-when', 'when'], ['tx-branch', 'branch'], ['tx-what', 'what'], ['tx-amount', 'amount'], ['tx-close-text', 'close']]) setText(id, t(key));
  if (api !== null) {
    const sel = $('c-by'); const keep = sel.value;
    sel.replaceChildren(...api.dimensions.map((d) => { const o = document.createElement('option'); o.value = d; o.textContent = t(`by_${d}`); return o; }));
    if (keep) sel.value = keep;
  }
  paintResult(); paintTxns();
}

// The chrome arrived after the first paint: draw the cards and registers with it.
document.addEventListener('sre:chrome', () => { paint(); });
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
    const ask = { by: $('c-by').value, from: $('c-from').value, to: $('c-to').value };
    const out = await session.compare(ask);
    asked = { ...ask, at: new Date().toISOString() };
    opened = null;
    if (out.result !== 'ok') { view = null; $('c-status').textContent = api.outcomeWords(lang, out); paint(); return; }
    view = out.value; paint();
  });
  $('r-register').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act="open"]'); if (b === null) return;
    opened = b.closest('tr').dataset.key; paintTxns(); $('txns').scrollIntoView?.({ block: 'start' });
  });
  $('tx-close').addEventListener('click', () => { opened = null; paintTxns(); });
}
