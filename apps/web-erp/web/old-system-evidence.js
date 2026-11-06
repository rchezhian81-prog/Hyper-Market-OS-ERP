// Old system checks — the switch-over EVIDENCE sections (W5 · MG-10 · MG-11 · OD-05 · GT-02): who ran the extraction, the
// six outside witnesses, where the twelve kinds of record stand, the signed page; the owner's acceptance in his own name;
// the owner's four going-back limits ("not set" until he sets each); the books side of a parallel day, a name on each
// difference, the printable sheet; confirming and reconciling a decided rollback. The session
// (apps/web-erp/src/cutover-evidence-session.ts, in the bundle as window.oldSystem.evidence) asks head office; this script
// holds only what the person is typing and the files chosen, and shows every answer in head office's words — each state an
// icon AND words. Nothing is read on open and nothing on a timer. Every word has a Tamil twin. No prompt, confirm or alert.

const $ = (id) => document.getElementById(id);
const api = window.oldSystem?.evidence ?? null;
const session = api?.session ?? null;

let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
let witnessFor = 'count';
let booksTemplates = [];
const pendingReports = [];
let openDiffs = [];

function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function item(tone, head, ...lines) {
  const li = document.createElement('li');
  li.className = `tone-${tone}`;
  li.append(text('div', head, 'verdict'), ...lines.filter((l) => l !== '' && l !== undefined).map((l) => text('div', l, 'facts')));
  return li;
}
function say(id, out) { $(id).className = 'status err'; $(id).textContent = api.outcomeWords(lang, out); }
function good(id, words) { $(id).className = 'status good'; $(id).textContent = `✓ ${words}`; }
function warn(id, words) { $(id).className = 'status err'; $(id).textContent = `⚠ ${words}`; }
function options(sel, values, wordOf, blank = true) {
  const chosen = sel.value;
  sel.replaceChildren(...(blank ? [text('option', '')] : []), ...values.map((v) => { const o = text('option', wordOf(v)); o.value = v; return o; }));
  if (blank) sel.firstChild.value = '';
  if (values.includes(chosen)) sel.value = chosen;
}
const textOf = async (input) => { const f = input?.files?.[0]; return f === undefined ? '' : f.text(); };

// ── the files each witness reads ──────────────────────────────────────────────────────────────────────────
const FILES = {
  count: ['count_lines', 'count_counted'], suppliers: ['supplier_items'], bank: ['bank_takings', 'bank_credits', 'bank_terms'],
  tax: ['tax_returns', 'tax_lines'], books: ['books_accounts', 'books_opening'], loyalty: ['loyalty_balances', 'loyalty_confirmations'],
};
const FIELDS = {
  planId: 'wit-plan', plannedBy: 'wit-planner', seed: 'wit-seed', suppliersAsked: 'wit-asked', periodStart: 'wit-pstart', periodEnd: 'wit-pend',
  stmtFrom: 'wit-sfrom', stmtTo: 'wit-sto', periodsExpected: 'wit-periods', entity: 'wit-entity', periodEndAcc: 'wit-pe', preparedBy: 'wit-prep',
  signedOn: 'wit-signed', membership: 'wit-member', cutoverDate: 'wit-cutdate', sampleSource: 'wit-source', pointCost: 'wit-cost',
};
function template(file) {
  const a = text('a', t('template'), 'quiet-link');
  a.href = `data:text/csv;charset=utf-8,${encodeURIComponent(api.templateOf(file))}`;
  a.download = `${file.replace(/_/g, '-')}-template.csv`;
  a.dataset.template = file;
  return a;
}
function paintWitness() {
  witnessFor = $('wit-which').value || 'count';
  for (const g of document.querySelectorAll('#ver [data-witness]')) g.hidden = !g.dataset.witness.split(' ').includes(witnessFor);
  $('wit-files').replaceChildren(...FILES[witnessFor].flatMap((f) => {
    const label = document.createElement('label');
    label.htmlFor = `wit-file-${f}`;
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.csv,text/csv'; input.id = `wit-file-${f}`; input.dataset.file = f;
    label.append(text('span', t(`f_${f}`)), input);
    return [label, template(f)];
  }));
}

// ── MG-11 who ran the extraction, the witnesses, the twelve, the page ─────────────────────────────────────
async function recordRun() {
  const out = await session.recordExtractionRun({ runId: $('run-id').value, operatorId: $('run-operator').value, sources: $('run-sources').value, note: $('run-note').value });
  if (out.result !== 'ok') { say('run-status', out); return; }
  good('run-status', `${t('runRecorded')} ${out.value.run.operatorId} (${out.value.run.runId})`);
  $('run-status').dataset.run = out.value.run.runId;
}
const verdictTone = (v) => (v === 'proved' ? 'ok' : v === 'proved_with_differences' ? 'degraded' : 'error');
const verdictMark = (v) => (v === 'proved' ? '✓' : v === 'proved_with_differences' ? '◐' : '⚠');
function findingItem(f) {
  const figure = f.figureMinor === undefined ? (f.figureLabel ?? '') : api.rupees(f.figureMinor);
  const li = item(verdictTone(f.verdict), `${verdictMark(f.verdict)} ${t(`d_${f.domain}`)} — ${t(`v_${f.verdict}`)}${figure === '' ? '' : ` · ${figure}`}`,
    f.recordedBy === undefined ? '' : `${t('findingBy')} ${f.recordedBy}${f.evidenceRef === undefined ? '' : ` · ${f.evidenceRef}`}`,
    `${t('cannotProve')} ${f.whatItCannotProve}`, f.ownerAction === '' ? '' : `${t('ownerDo')} ${f.ownerAction}`);
  li.dataset.domain = f.domain;
  li.dataset.verdict = f.verdict;
  return li;
}
async function recordWitness() {
  const fields = { evidenceRef: $('wit-ref').value };
  for (const [k, id] of Object.entries(FIELDS)) fields[k] = $(id).value;
  const files = {};
  for (const input of $('wit-files').querySelectorAll('input[type=file]')) files[input.dataset.file] = await textOf(input);
  const out = await session.witness(witnessFor, { fields, files });
  if (out.result !== 'ok') { say('wit-status', out); $('wit-result').replaceChildren(); return; }
  good('wit-status', t('witRecorded'));
  $('wit-result').replaceChildren(...out.value.findings.map(findingItem));
}
async function showProgress() {
  const out = await session.progress();
  if (out.result !== 'ok') { say('prog-status', out); $('prog-list').replaceChildren(); return; }
  const p = out.value;
  const head = `${p.covered.length} ${t('coveredK')} · ${p.signaturesOverThisPage} ${t('signaturesK')}`;
  if (p.missing.length === 0) good('prog-status', head); else warn('prog-status', `${head} · ${t('missingK')}: ${p.missing.map((d) => t(`d_${d}`)).join(', ')}`);
  $('prog-status').dataset.covered = String(p.covered.length);
  const latest = new Map(p.findings.map((f) => [f.domain, f]));
  $('prog-list').replaceChildren(
    ...(p.ownerKnown ? [] : [item('error', `⚠ ${t('ownerUnknown')}`)]),
    ...(p.extractionOperatorKnown ? [] : [item('error', `⚠ ${t('operatorUnknown')}`)]),
    ...api.dataDomains.map((d) => {
      const f = latest.get(d);
      if (f !== undefined) return findingItem(f);
      const li = item('idle', `○ ${t(`d_${d}`)} — ${t('missingK')}`);
      li.dataset.domain = d; li.dataset.verdict = 'missing';
      return li;
    }),
  );
}
function showKept(prefix, name, markdown) {
  $(`${prefix}-text`).textContent = markdown; $(`${prefix}-text`).hidden = false;
  const f = api.keptFile(name, markdown);
  $(`${prefix}-save`).href = f.href; $(`${prefix}-save`).download = f.name; $(`${prefix}-save`).hidden = false;
  $(`${prefix}-print`).hidden = false;
}
function printOnly(prefix, sectionId) {
  // Print just that page: the section and its text carry `.printing` while the browser's own print runs.
  document.body.classList.add('printing'); $(sectionId).classList.add('printing'); $(`${prefix}-text`).classList.add('printing');
  const done = () => { document.body.classList.remove('printing'); $(sectionId).classList.remove('printing'); $(`${prefix}-text`).classList.remove('printing'); };
  window.addEventListener('afterprint', done, { once: true });
  window.print();
}
async function showPage() {
  const out = await session.page();
  if (out.result !== 'ok') { say('vpage-status', out); $('vpage-text').hidden = true; $('vpage-save').hidden = true; $('vpage-print').hidden = true; return; }
  good('vpage-status', `${out.value.signatures} ${t('pageSigs')}`);
  $('vpage-status').dataset.signatures = String(out.value.signatures);
  showKept('vpage', 'verification-page.md', out.value.markdown);
}
async function signPage() {
  const out = await session.signPage($('vpage-statement').value);
  if (out.result !== 'ok') { say('vsign-status', out); return; }
  $('vpage-statement').value = '';
  good('vsign-status', `${t('signed')} ${out.value.signatures}`);
  $('vsign-status').dataset.signatures = String(out.value.signatures);
}

// ── OD-05 the owner's acceptance ──────────────────────────────────────────────────────────────────────────
async function accept() {
  const out = await session.accept($('acc-domain').value, $('acc-reason').value);
  if (out.result !== 'ok') { say('acc-status', out); return; }
  $('acc-reason').value = '';
  good('acc-status', `${t('accepted')} ${t(`d_${out.value.domain}`)} — ${out.value.acceptedBy} · ${out.value.acceptedOn} — “${out.value.reason}”`);
  $('acc-status').dataset.accepted = out.value.domain;
}

// ── MG-11 the owner's going-back limits ───────────────────────────────────────────────────────────────────
const limitWords = (n, v) => (v === null || v === undefined ? t('notSetK') : n === 'controlTotalDifferenceMinor' ? api.rupees(v) : String(v));
function paintLimits(read) {
  const l = read.limits;
  const notSet = read.notSet ?? api.limitNames;
  if (notSet.length === 0) good('lim-status', t('allSet')); else warn('lim-status', `${notSet.length} ${t('someNotSet')}`);
  $('lim-status').dataset.notSet = String(notSet.length);
  $('lim-list').replaceChildren(
    ...api.limitNames.map((n) => {
      const v = l === null || l === undefined ? null : l[n];
      const li = item(v === null ? 'error' : 'ok', `${v === null ? '○' : '✓'} ${t(`lim_${n}`)}: ${limitWords(n, v)}`);
      li.dataset.limit = n; li.dataset.set = String(v !== null);
      return li;
    }),
    ...(l === null || l === undefined ? [] : [item('idle', `${t('setByK')} ${l.setBy} · ${l.setAt} · ${t('versionK')} ${l.version}`)]),
    ...(read.backup === undefined ? [] : [item(read.backup.state === 'passed' ? 'ok' : read.backup.state === 'failed' ? 'error' : 'idle', `${t('backupK')} ${read.backup.state}`, read.backup.evidence)]),
  );
  // What is held fills the fields: money in rupees as the owner typed it; "not set" stays empty.
  if (l !== null && l !== undefined) for (const n of api.limitNames) $(`lim-${n}`).value = l[n] === null ? '' : n === 'controlTotalDifferenceMinor' ? (l[n] / 100).toFixed(2) : String(l[n]);
}
async function showLimits() {
  const out = await session.limits();
  if (out.result !== 'ok') { say('lim-status', out); return; }
  paintLimits(out.value);
}
async function setLimits() {
  const draft = Object.fromEntries(api.limitNames.map((n) => [n, $(`lim-${n}`).value]));
  const out = await session.setLimits(draft);
  if (out.result !== 'ok') { say('lim-status', out); return; }
  await showLimits();
}

// ── MG-10 the books side of a day, the differences, the sheet ─────────────────────────────────────────────
function paintBooksColumns() {
  const spec = booksTemplates.find((x) => x.report === $('books-report').value);
  $('books-columns').replaceChildren(...(spec === undefined ? [] : spec.fields.map((f) => {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'text'; input.autocomplete = 'off'; input.dataset.field = f.key; input.id = `books-col-${f.key}`; label.htmlFor = input.id;
    label.append(text('span', `${t('booksColumn')} ${f.words[lang] ?? f.words.en}${f.required ? ' *' : ''}`), input);
    return label;
  })));
}
function paintPending() {
  $('books-pending').replaceChildren(...(pendingReports.length === 0 ? [text('li', t('reportsNone'), 'facts')] : pendingReports.map((r, i) => {
    const spec = booksTemplates.find((x) => x.report === r.report);
    const li = item('idle', `${spec?.words[lang] ?? r.report} · ${r.label}`);
    const rm = text('button', '✕', 'quiet'); rm.type = 'button'; rm.addEventListener('click', () => { pendingReports.splice(i, 1); paintPending(); });
    li.append(rm); li.dataset.report = r.report;
    return li;
  })));
}
async function showBooks() {
  const out = await session.booksDay($('books-date').value);
  if (out.result !== 'ok') { say('books-status', out); return; }
  booksTemplates = out.value.templates;
  $('books-status').textContent = '';
  options($('books-report'), booksTemplates.map((x) => x.report), (v) => booksTemplates.find((x) => x.report === v)?.words[lang] ?? v);
  paintBooksColumns();
  const r = out.value.record;
  $('books-held').replaceChildren(r === null ? text('li', t('booksNoneHeld'), 'facts')
    : item(r.notCompared.length === 0 ? 'ok' : 'degraded', `${t('booksHeld')} ${r.reports.map((x) => booksTemplates.find((s) => s.report === x)?.words[lang] ?? x).join(', ')}`, `${r.lines} · ${r.by} · ${r.at}`));
  paintPending();
}
async function addReport() {
  const spec = booksTemplates.find((x) => x.report === $('books-report').value);
  if (booksTemplates.length === 0) { warn('books-status', t('booksFirst')); return; }
  if (spec === undefined) { warn('books-status', t('noReport')); return; }
  if (pendingReports.some((r) => r.report === spec.report)) { warn('books-status', t('sameReport')); return; }
  const f = $('books-file').files?.[0];
  if (f === undefined) { warn('books-status', t('chooseFile')); return; }
  const mapping = Object.fromEntries([...$('books-columns').querySelectorAll('input')].map((i) => [i.dataset.field, i.value]));
  pendingReports.push({ report: spec.report, csv: await f.text(), mapping, dateOrder: $('books-order').value, label: f.name });
  $('books-status').textContent = '';
  $('books-file').value = '';
  paintPending();
}
async function recordBooks() {
  const out = await session.recordBooks($('books-date').value, pendingReports, booksTemplates);
  if (out.result !== 'ok') { say('books-status', out); return; }
  const r = out.value;
  const words = `${r.detail} · ${r.differences} ${t('differencesK')}${r.notCompared.length === 0 ? '' : ` · ${r.notCompared.length} ${t('notComparedK')}`}`;
  pendingReports.splice(0);
  await showBooks();
  if (r.differences === 0 && r.notCompared.length === 0) good('books-status', words); else warn('books-status', words);
  $('books-status').dataset.differences = String(r.differences);
}
async function showDiffs() {
  const out = await session.parallel();
  if (out.result !== 'ok') { say('pdiff-status', out); return; }
  const p = out.value;
  $('pdiff-status').textContent = '';
  if (!p.started || p.position === undefined) { warn('pdiff-pos', p.detail); openDiffs = []; $('pdiff-list').replaceChildren(); options($('pdiff-which'), [], (v) => v); return; }
  const pos = p.position;
  (pos.sufficient ? good : warn)('pdiff-pos', `${pos.consecutiveCleanDays} ${t('cleanDaysK')} · ${t('atStakeK')} ${api.rupees(pos.valueAtStakeMinor)} — ${pos.detail}`);
  openDiffs = pos.openDifferences;
  $('pdiff-list').replaceChildren(...(openDiffs.length === 0 ? [text('li', t('diffsNone'), 'facts')] : openDiffs.map((d) => {
    const li = item(d.ownerUserId === undefined ? 'error' : 'degraded', `${d.ownerUserId === undefined ? '⚠' : '◐'} ${d.differenceId} · ${d.businessDate} · ${d.area}${d.subject === undefined ? '' : ` · ${d.subject}`} · ${d.difference}`,
      d.ownerUserId === undefined ? t('unownedK') : `${t('ownerK')} ${d.ownerUserId}${d.wrongSide === undefined ? '' : ` · ${t(`ws_${d.wrongSide}`)}`}${d.explanation === undefined ? '' : ` — “${d.explanation}”`}`);
    li.dataset.difference = d.differenceId; li.dataset.owned = String(d.ownerUserId !== undefined);
    return li;
  })));
  options($('pdiff-which'), openDiffs.map((d) => d.differenceId), (v) => v);
}
async function ownDiff() {
  const out = await session.ownDifference($('pdiff-which').value, $('pdiff-explain').value, $('pdiff-wrong').value);
  if (out.result !== 'ok') { say('pdiff-status', out); return; }
  $('pdiff-explain').value = '';
  await showDiffs();
  good('pdiff-status', `${t('owned')} ${out.value.detail}`);
  $('pdiff-status').dataset.state = out.value.difference.status;
}
async function showSheet() {
  const out = await session.sheet();
  if (out.result !== 'ok') { say('sheet-status', out); $('sheet-text').hidden = true; $('sheet-save').hidden = true; $('sheet-print').hidden = true; return; }
  $('sheet-status').textContent = '';
  showKept('sheet', 'parallel-run-sheet.md', out.value.markdown);
}

// ── GT-02 confirm and reconcile going back ────────────────────────────────────────────────────────────────
async function confirmRollback() {
  const out = await session.confirmRollback($('rb-cutover').value, $('rb-bill').value, $('rb-from').value);
  if (out.result !== 'ok') { say('rb-confirm-status', out); return; }
  const r = out.value.rollback;
  good('rb-confirm-status', `${t('rbConfirmed')} ${r.execution?.legacyFirstBillRef ?? ''} · ${r.cutoverId} · ${r.state}`);
  $('rb-confirm-status').dataset.state = r.state;
}
async function reconcileRollback() {
  const out = await session.reconcileRollback($('rb-cutover').value, {
    newFromLocal: $('rb-newfrom').value, count: $('rb-count').value, total: $('rb-total').value, refunds: $('rb-refunds').value,
    refundsTotal: $('rb-refund-total').value, stockCsv: await textOf($('rb-stock')),
  });
  if (out.result !== 'ok') { say('rb-rec-status', out); return; }
  const c = out.value.reconciliation;
  if (out.value.demonstrated) good('rb-rec-status', t('rbReconciled'));
  else warn('rb-rec-status', `${t('rbNotReconciled')} ${(c.differences ?? []).join('; ') || (c.detail ?? '')}`);
  $('rb-rec-status').dataset.demonstrated = String(out.value.demonstrated);
}

// ── words, wiring ─────────────────────────────────────────────────────────────────────────────────────────
function paint() {
  if (api === null) return;
  for (const [id, k] of [['ver-h', 'verH'], ['ver-lead', 'verLead'], ['run-h', 'runH'], ['wit-h', 'witH'], ['prog-h', 'progH'], ['vpage-h', 'pageH'],
    ['acc-h', 'accH'], ['acc-lead', 'accLead'], ['lim-h', 'limH'], ['lim-lead', 'limLead'], ['books-h', 'booksH'], ['books-lead', 'booksLead'],
    ['pdiff-h', 'diffH'], ['sheet-h', 'sheetH'], ['rb-h', 'rbH'], ['rb-lead', 'rbLead']]) $(id).textContent = t(k);
  for (const n of document.querySelectorAll('[data-e]')) n.textContent = t(n.dataset.e);
  options($('wit-which'), [...api.witnesses], (v) => t(`w_${v}`), false);
  $('wit-which').value = witnessFor;
  options($('wit-source'), [...api.sampleSources], (v) => t(`ss_${v}`));
  options($('acc-domain'), [...api.dataDomains], (v) => t(`d_${v}`));
  options($('books-order'), [...api.dateOrders], (v) => t(`do_${v}`));
  options($('pdiff-wrong'), [...api.wrongSides], (v) => t(`ws_${v}`));
  if (booksTemplates.length > 0) options($('books-report'), booksTemplates.map((x) => x.report), (v) => booksTemplates.find((x) => x.report === v)?.words[lang] ?? v);
  const rbt = $('rb-stock-template');
  rbt.href = `data:text/csv;charset=utf-8,${encodeURIComponent(api.templateOf('rollback_stock'))}`; rbt.download = 'rollback-stock-template.csv';
  paintWitness();
  paintBooksColumns();
  paintPending();
}

if (api !== null) {
  const on = (id, fn) => $(id).addEventListener('click', () => { void fn(); });
  on('run-record', recordRun); on('wit-record', recordWitness); on('prog-show', showProgress); on('vpage-show', showPage); on('vpage-sign', signPage);
  on('vpage-print', () => printOnly('vpage', 'ver')); on('sheet-print', () => printOnly('sheet', 'books'));
  on('acc-accept', accept); on('lim-show', showLimits); on('lim-set', setLimits);
  on('books-show', showBooks); on('books-add', addReport); on('books-record', recordBooks); on('pdiff-show', showDiffs); on('pdiff-own', ownDiff); on('sheet-show', showSheet);
  on('rb-confirm', confirmRollback); on('rb-reconcile', reconcileRollback);
  $('wit-which').addEventListener('change', paintWitness);
  $('books-report').addEventListener('change', paintBooksColumns);
  $('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; paint(); });
  paint();
}
