// Month-end · "Into the books" and "For the CA" (W5 · M23-FR-01/04 · D10-FR-01 · D09-FR-06 · D02-FR-06). Every rule and
// every word lives in the TESTED session (apps/web-erp/src/books-postings-session.ts, window.booksPostings); this file only
// draws what head office answered and passes each click through. Nothing is read on open; every read is a click or the tab
// opening; every post is one explicit click. No prompt/confirm/alert.

const $ = (id) => document.getElementById(id);
const api = window.booksPostings ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, post: false };
const lang = () => (document.documentElement.lang === 'ta' ? 'ta' : 'en');
const w = (k, fill) => (api === null ? k : api.words(lang(), k, fill));
const inr = (minor) => (minor === null || minor === undefined ? w('notChecked') : api.rupees(minor));
const node = (tag, props = {}, ...kids) => { const n = document.createElement(tag); Object.assign(n, props); n.append(...kids); return n; };
const period = () => $('period')?.value ?? '';
function say(id, text, cls = '') { const el = $(id); if (el) { el.className = `status ${cls}`; el.textContent = text; } }
async function busy(button, work) { button.disabled = true; try { await work(); } finally { button.disabled = false; } }
const tile = (value, label, key) => { const t = node('div', { className: 'tile sre-summary-card' }, node('small', { className: 'sre-summary-label', textContent: label }), node('b', { className: 'sre-summary-value', textContent: value })); t.dataset.tile = key; return t; };

const views = { b2b: null, stock: null, losses: null, fleet: null, display: null };
let evidence = null; let results = null; let pack = null; let centres = null;

// ── Into the books ──────────────────────────────────────────────────────────────────────────────────────────

function streamBox(stream) {
  let box = $(`bk-${stream}`);
  if (box !== null) return box;
  box = node('div', { id: `bk-${stream}`, className: 'month-step' });
  box.dataset.stream = stream;
  box.append(
    node('h3', { id: `bk-${stream}-h` }),
    node('div', { className: 'row' }, node('button', { id: `bk-${stream}-read`, type: 'button', className: 'quiet' }), ...(stream === 'display' ? [] : [node('button', { id: `bk-${stream}-post`, type: 'button', hidden: !may.post })])),
    node('p', { id: `bk-${stream}-status`, className: 'status', role: 'status' }),
    node('div', { id: `bk-${stream}-tiles`, className: 'tiles sre-summary' }),
    node('ul', { id: `bk-${stream}-rows`, className: 'register' }),
    node('ul', { id: `bk-${stream}-ex`, className: 'blockers' }),
  );
  $('books-streams').append(box);
  $(`bk-${stream}-read`).addEventListener('click', () => busy($(`bk-${stream}-read`), () => readStream(stream)));
  if (stream !== 'display') $(`bk-${stream}-post`).addEventListener('click', () => busy($(`bk-${stream}-post`), () => postStream(stream)));
  return box;
}

function paintStream(stream) {
  streamBox(stream);
  $(`bk-${stream}-h`).textContent = w(`${stream}H`);
  $(`bk-${stream}-read`).textContent = w('read');
  if (stream !== 'display') $(`bk-${stream}-post`).textContent = w('post');
  const tiles = $(`bk-${stream}-tiles`); const rows = $(`bk-${stream}-rows`);
  tiles.replaceChildren(); rows.replaceChildren();
  const v = views[stream];
  if (v === null) return;
  if (stream === 'display') { paintDisplay(v, tiles, rows); return; }
  if (!v.connected) { say(`bk-${stream}-status`, v.detail ?? w('notConnected')); return; }
  tiles.append(tile(String(v.inRegister), w('inRegister'), 'in'), tile(String(v.inBooks), w('inBooks'), 'posted'), tile(String(v.waiting), w('waiting'), 'waiting'),
    tile(inr(v.valueMinor), w('valueRegister'), 'value'), tile(inr(v.postedValueMinor), w('valueBooks'), 'posted-value'));
  if (v.unvalued > 0) tiles.append(tile(String(v.unvalued), w('unvalued'), 'unvalued'));
  // The fleet register says which kinds the map cannot post (not posted, not zero) — shown whether or not there are rows.
  if (v.detail !== null && stream === 'fleet') say(`bk-${stream}-status`, v.detail);
  if (v.rows.length === 0) { rows.append(node('li', { className: 'empty-state', textContent: w('noRows') })); return; }
  for (const r of v.rows) {
    const li = node('li', { className: r.posted ? '' : 'open' });
    li.dataset.row = r.id; li.dataset.posted = String(r.posted);
    li.append(node('div', { className: 'head' }, node('span', { className: 'amt', textContent: r.valueMinor === null ? w('unvalued') : api.rupees(r.valueMinor) }), node('span', { textContent: r.posted ? w('isPosted') : w('notYet') })),
      node('p', { className: 'facts', textContent: `${r.id} · ${r.what}` }));
    rows.append(li);
  }
}

function paintDisplay(v, tiles, rows) {
  tiles.append(tile(api.rupees(v.fundingMinor), w('funding'), 'funding'), tile(api.rupees(v.receivedMinor), w('received'), 'received'), tile(api.rupees(v.ledgerMinor), w('ledger'), 'ledger'));
  if (v.incomeAccount === null) say('bk-display-status', w('unmappedAccount'), 'err');
  if (v.lines.length === 0) { rows.append(node('li', { className: 'empty-state', textContent: w('noRows') })); return; }
  for (const l of v.lines) {
    const li = node('li', { className: l.findings.length > 0 ? 'flagged' : '' });
    li.dataset.contract = l.contractId;
    li.append(
      node('div', { className: 'head' }, node('strong', { textContent: `${l.contractId} · ${l.supplierId} · ${l.storeId}` }), node('span', { textContent: l.agrees ? w('agrees') : w('differs') })),
      node('p', { className: 'facts', textContent: `${w('funding')} ${api.rupees(l.fundingMinor)} · ${w('received')} ${api.rupees(l.receivedMinor)} · ${w('outstanding')} ${api.rupees(l.outstandingMinor)} · ${w('ledger')} ${api.rupees(l.ledgerMinor)}` }),
    );
    if (l.findings.length > 0) li.append(node('p', { className: 'flags', textContent: l.findings.map((f) => w(`finding_${f}`)).join(' · ') }));
    if (may.post && l.outstandingMinor > 0) {
      const f = (k, extra = {}) => { const input = node('input', { className: `rc-${k}`, autocomplete: 'off', ...extra }); return { label: node('label', {}, node('span', { textContent: w(k === 'amount' ? 'receiptAmount' : k === 'on' ? 'receiptOn' : 'receiptRef') }), input), input }; };
      const amount = f('amount', { inputMode: 'decimal' }); const on = f('on', { type: 'date' }); const ref = f('ref');
      const go = node('button', { type: 'button', className: 'rc-record', textContent: w('recordReceipt') });
      const st = node('p', { className: 'status rc-status', role: 'status' });
      go.addEventListener('click', () => busy(go, async () => {
        const out = await session.recordReceipt(l.contractId, { amountRupees: amount.input.value, receivedOn: on.input.value, reference: ref.input.value });
        if (out.result !== 'ok') { st.className = 'status rc-status err'; st.textContent = api.outcomeWords(lang(), out); return; }
        await readStream('display');
        say('bk-display-status', out.value.alreadyRecorded ? w('receiptAgain') : w('receiptDone', { left: api.rupees(out.value.outstandingMinor ?? 0) }), 'good');
      }));
      li.append(node('div', { className: 'row' }, amount.label, on.label, ref.label), go, st);
    }
    rows.append(li);
  }
}

async function readStream(stream) {
  say(`bk-${stream}-status`, w('reading'));
  const out = stream === 'display' ? await session.displayFunding() : await session.read(stream);
  if (out.result !== 'ok') { views[stream] = null; paintStream(stream); say(`bk-${stream}-status`, api.outcomeWords(lang(), out), 'err'); return; }
  views[stream] = out.value; say(`bk-${stream}-status`, ''); paintStream(stream);
}

async function postStream(stream) {
  const out = await session.post(stream);
  if (out.result !== 'ok') { say(`bk-${stream}-status`, api.outcomeWords(lang(), out), 'err'); return; }
  await readStream(stream);
  const ex = $(`bk-${stream}-ex`);
  ex.replaceChildren(...out.value.exceptions.map((e) => node('li', { textContent: w('notPosted', { id: e.sourceId ?? e.movementId ?? '', reason: e.reason, detail: e.detail }) })));
  say(`bk-${stream}-status`, out.value.posted.length > 0 ? w('posted', { count: out.value.posted.length }) : w('nothingPosted'), out.value.exceptions.length > 0 ? 'err' : 'good');
}

// ── For the CA ──────────────────────────────────────────────────────────────────────────────────────────────

const extra = () => [{ name: $('ca-x-name').value, booksRupees: $('ca-x-books').value, outsideRupees: $('ca-x-outside').value, method: $('ca-x-method').value }];
const checks = () => evidence?.checks ?? [];

function paintEvidence() {
  const list = $('ca-checks'); const missing = $('ca-missing');
  list.replaceChildren(); missing.replaceChildren();
  if (evidence === null) return;
  if (evidence.checks.length === 0) list.append(node('li', { className: 'empty-state', textContent: w('noChecks') }));
  for (const c of evidence.checks) {
    const agrees = c.leftMinor === c.rightMinor;
    const li = node('li', { className: agrees ? '' : 'flagged' }); li.dataset.check = c.name;
    li.append(node('div', { className: 'head' }, node('strong', { textContent: c.name }), node('span', { textContent: agrees ? w('agrees') : w('differs') })),
      node('p', { className: 'facts', textContent: `${w('left')}: ${api.rupees(c.leftMinor)} (${c.leftDerivation})` }),
      node('p', { className: 'facts', textContent: `${w('right')}: ${api.rupees(c.rightMinor)} (${c.rightDerivation})` }));
    list.append(li);
  }
  const n = (a) => (Array.isArray(a) ? a.length : 0);
  if (n(evidence.unsettledTenders) > 0) missing.append(node('li', { textContent: w('unsettled', { count: n(evidence.unsettledTenders) }) }));
  if (n(evidence.payoutsNotInBank) > 0) missing.append(node('li', { textContent: w('payoutsMissing', { count: n(evidence.payoutsNotInBank) }) }));
  if (n(evidence.depositsNotInBank) > 0) missing.append(node('li', { textContent: w('depositsMissing', { count: n(evidence.depositsNotInBank) }) }));
  for (const k of evidence.notChecked ?? []) missing.append(node('li', { textContent: `${w('notChecked')}: ${k}` }));
}

function paintResults() {
  const list = $('ca-results'); const statement = $('ca-statement');
  list.replaceChildren(); statement.replaceChildren();
  const rows = pack !== null ? pack.totals : results !== null ? results.results : [];
  for (const r of rows) {
    const li = node('li', { className: r.reconciles ? '' : 'flagged' }); li.dataset.total = r.name;
    li.append(node('div', { className: 'head' }, node('strong', { textContent: r.name }), node('span', { textContent: r.reconciles ? w('reconcilesYes') : w('reconcilesNo', { diff: api.rupees(r.differenceMinor) }) })),
      node('p', { className: 'facts', textContent: r.detail }));
    list.append(li);
  }
  if (pack !== null) {
    statement.append(node('li', { textContent: `${pack.signable ? w('signable') : w('notSignable')} — ${pack.verdict}` }));
    for (const line of pack.statement) statement.append(node('li', { textContent: line }));
    if (pack.deadLetteredFrom) statement.append(node('li', { textContent: `${w('deadFrom')}: ${pack.deadLetteredFrom}` }));
  }
}

function paintCentres() {
  const table = $('centres-table'); table.replaceChildren();
  if (centres === null) return;
  const head = node('tr', {}, ...['', 'income', 'expense', 'profit', 'journals'].map((k, i) => node('th', { className: i === 0 ? '' : 'n', textContent: k === '' ? '' : w(k) })));
  table.append(head);
  for (const c of centres.centres) {
    const tr = node('tr', {}, node('td', { textContent: `${c.name ?? c.centre}${c.known ? '' : ` (${w('unknownCentre')})`}` }), node('td', { className: 'n', textContent: api.rupees(c.incomeMinor) }),
      node('td', { className: 'n', textContent: api.rupees(c.expenseMinor) }), node('td', { className: 'n', textContent: api.rupees(c.profitMinor) }), node('td', { className: 'n', textContent: String(c.journals) }));
    tr.dataset.centre = c.centre; table.append(tr);
  }
  const notes = [centres.detail, centres.ties ? w('ties') : w('noTie'), ...(centres.classesDefined ? [] : [w('classesMissing')]),
    `${w('unassigned')}: ${centres.unassigned.journals.length} ${w('journals')}`, ...(centres.attributedBps === null ? [] : [`${w('attributed')}: ${(centres.attributedBps / 100).toFixed(2)}%`])];
  say('centres-status', notes.join(' · '), centres.ties ? 'good' : 'err');
}

$('ca-evidence')?.addEventListener('click', () => busy($('ca-evidence'), async () => {
  say('ca-status', w('reading'));
  const out = await session.evidence(period());
  if (out.result !== 'ok') { evidence = null; paintEvidence(); say('ca-status', api.outcomeWords(lang(), out), 'err'); return; }
  evidence = out.value; results = null; pack = null; paintEvidence(); paintResults(); say('ca-status', '');
}));
$('ca-totals')?.addEventListener('click', () => busy($('ca-totals'), async () => {
  const out = await session.controlTotals(period(), checks(), extra());
  if (out.result !== 'ok') { say('ca-pack-status', api.outcomeWords(lang(), out), 'err'); return; }
  results = out.value; pack = null; paintResults();
  say('ca-pack-status', out.value.allReconcile ? w('allAgree') : w('someDiffer'), out.value.allReconcile ? 'good' : 'err');
}));
$('ca-pack')?.addEventListener('click', () => busy($('ca-pack'), async () => {
  const out = await session.evidencePack(period(), checks(), extra(), $('ca-cutoff').value);
  if (out.result !== 'ok') { say('ca-pack-status', api.outcomeWords(lang(), out), 'err'); return; }
  pack = out.value; paintResults();
  say('ca-pack-status', `${out.value.signable ? w('signable') : w('notSignable')} — ${out.value.verdict}`, out.value.signable ? 'good' : 'err');
}));
$('centres-show')?.addEventListener('click', () => busy($('centres-show'), async () => {
  say('centres-status', w('reading'));
  const out = await session.centres(period());
  if (out.result !== 'ok') { centres = null; paintCentres(); say('centres-status', api.outcomeWords(lang(), out), 'err'); return; }
  centres = out.value; paintCentres();
}));

// ── The frame ───────────────────────────────────────────────────────────────────────────────────────────────

function paintWords() {
  for (const [id, k] of [['tab-books', 'tabBooks'], ['tab-ca', 'tabCa'], ['books-h', 'booksH'], ['books-lede', 'booksLede'], ['ca-h', 'caH'], ['ca-lede', 'caLede'], ['ca-evidence', 'evidence'],
    ['ca-extra-h', 'addLine'], ['l-ca-x-name', 'lineName'], ['l-ca-x-books', 'lineBooks'], ['l-ca-x-outside', 'lineOutside'], ['l-ca-x-method', 'lineMethod'], ['l-ca-cutoff', 'cutoff'],
    ['ca-totals', 'checkTotals'], ['ca-pack', 'makePack'], ['centres-h', 'centresH'], ['centres-lede', 'centresLede'], ['centres-show', 'showCentres']]) {
    const el = $(id); if (el) el.textContent = w(k);
  }
  for (const s of api.streams) paintStream(s);
  paintEvidence(); paintResults(); paintCentres();
}

if (api !== null && may.read) {
  $('tab-books').hidden = false; $('tab-ca').hidden = false;
  paintWords();
  new MutationObserver(paintWords).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  $('period')?.addEventListener('change', () => { evidence = null; results = null; pack = null; centres = null; paintEvidence(); paintResults(); paintCentres(); });
} else if (api !== null) {
  // No book-reading permission: the two tabs stay hidden; head office would refuse each read anyway.
  $('tab-books').hidden = true; $('tab-ca').hidden = true;
}
