// Card, UPI and bank (W3 · M23-FR-03) — the page over head office's settlement, bank-statement, cash-deposit and payment-
// dispute routes. The session (apps/web-erp/src/settlement-bank-session.ts, in the bundle as window.settlementBank) does
// every call and every check; this page lays out what it is told. It READS the statements, deposits, open cases and
// disputes as it opens; nothing is written until a person clicks. Every word has a Tamil twin; head office's own sentences
// stay in English.

const $ = (id) => document.getElementById(id);
const api = window.settlementBank ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, import: false, investigate: false, disputes: false, recordDispute: false };
let lang = 'en';
const t = (k, fill) => (api === null ? k : api.words(lang, k, fill));
const rs = (minor) => (api === null ? String(minor) : api.rupees(minor));
const say = (id, out, good) => { $(id).textContent = out.result === 'ok' ? good : api.outcomeWords(lang, out); };
const today = () => (api === null ? '' : api.today());
function el(tag, text, cls) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; }
function input(cls, label, value) { const i = document.createElement('input'); i.className = cls; i.autocomplete = 'off'; i.placeholder = label; i.setAttribute('aria-label', label); if (value) i.value = value; return i; }
function button(text, act, quiet) { const b = el('button', text, quiet ? 'quiet' : undefined); b.type = 'button'; b.dataset.act = act; return b; }
const readFile = (id) => new Promise((resolve) => {
  const f = $(id).files?.[0];
  if (f === undefined) { resolve({ text: '', name: '' }); return; }
  const r = new FileReader(); r.onload = () => resolve({ text: String(r.result ?? ''), name: f.name }); r.onerror = () => resolve({ text: '', name: f.name }); r.readAsText(f);
});

let statements = null; let deposits = null; let review = null; let cases = null; let disputes = null;

// ── Statements and deposits ───────────────────────────────────────────────────────────────────────────────
function paintBank() {
  const sRows = $('statement-rows'); sRows.replaceChildren();
  if (statements !== null) {
    if (statements.length === 0) sRows.append(el('li', `○ ${t('noStatements')}`));
    for (const s of statements) {
      const li = el('li'); li.dataset.statement = s.statementId;
      li.append(el('strong', `${s.statementId} · ${s.accountRef} · ${s.fromDate} – ${s.toDate}`));
      li.append(el('span', `${rs(s.openingMinor)} → ${rs(s.closingMinor)} · ${s.lines} ${t('lines')} · ${t('loadedBy')} ${s.provenance.importedBy}${s.provenance.sourceName ? ` · ${s.provenance.sourceName}` : ''}`, 'meta'));
      sRows.append(li);
    }
  }
  const dRows = $('deposit-rows'); dRows.replaceChildren(); $('deposit-totals').textContent = '';
  if (deposits === null) return;
  $('deposit-totals').textContent = t('depTotals', { recorded: rs(deposits.recordedMinor), inBank: rs(deposits.inBankMinor), notInBank: deposits.notInBank });
  if (deposits.deposits.length === 0) dRows.append(el('li', `○ ${t('noDeposits')}`));
  for (const d of deposits.deposits) {
    const li = el('li', undefined, d.state === 'not_in_bank' ? 'attention' : d.state === 'in_bank' ? 'good' : ''); li.dataset.deposit = d.depositId; li.dataset.state = d.state;
    li.append(el('strong', `${d.depositedOn} · ${rs(d.amountMinor)} · ${d.slipRef} · ${d.accountRef}`));
    li.append(el('span', `${t(`dep_${d.state}`)}${d.bankLine ? ` · ${d.bankLine.statementId} ${d.bankLine.date}` : ''}${d.cancelled ? ` · ${d.cancelled.reason} (${d.cancelled.by})` : ''}`, 'meta'));
    if (may.import && d.state !== 'cancelled') {
      const acts = el('div', undefined, 'acts');
      acts.append(input('cancel-why', t('depCancelWhy')), button(t('depCancel'), 'cancel', true));
      li.append(acts);
    }
    li.append(el('p', '', 'status row-status'));
    dRows.append(li);
  }
}
async function loadBank() {
  const [s, d] = await Promise.all([session.statements(), session.deposits()]);
  statements = s.result === 'ok' ? s.value.statements : null;
  deposits = d.result === 'ok' ? d.value : null;
  if (s.result !== 'ok') $('dep-status').textContent = api.outcomeWords(lang, s);
  else if (d.result !== 'ok') $('dep-status').textContent = api.outcomeWords(lang, d);
  paintBank();
}

// ── The review and the cases ──────────────────────────────────────────────────────────────────────────────
function paintReview() {
  const tiles = $('rv-tiles'); tiles.replaceChildren(); $('rv-window').textContent = ''; $('exceptions-h').textContent = '';
  const rows = $('exception-rows'); rows.replaceChildren();
  if (review !== null) {
    for (const [k, v, id] of [['matched', `${review.matchedCount} · ${rs(review.matchedValueMinor)}`, 'matched'], ['awaiting', rs(review.awaitingValueMinor), 'awaiting'], ['atRisk', rs(review.atRiskValueMinor), 'at-risk']]) {
      const tile = el('div', undefined, 'tile'); tile.dataset.tile = id; tile.append(el('small', t(k)), el('b', v)); tiles.append(tile);
    }
    $('rv-window').textContent = t('windowSays', { from: review.window.from, to: review.window.to });
    $('exceptions-h').textContent = t('exceptionsH');
    const problems = review.exceptions.filter((e) => e.needsInvestigation);
    if (problems.length === 0) rows.append(el('li', `○ ${t('noExceptions')}`));
    for (const e of review.exceptions) {
      const li = el('li', undefined, e.needsInvestigation ? 'attention' : ''); li.dataset.ref = e.ref; li.dataset.finding = e.finding;
      li.append(el('strong', `${t(`f_${e.finding}`)} · ${e.ref} · ${rs(e.valueMinor)}`));
      if (e.detail) li.append(el('span', e.detail, 'meta'));
      if (may.investigate && e.needsInvestigation) {
        const acts = el('div', undefined, 'acts');
        acts.append(input('case-owner', t('owner')), input('case-due', t('dueBy')), button(t('openCase'), 'open'));
        li.append(acts);
      }
      li.append(el('p', '', 'status row-status'));
      rows.append(li);
    }
  }
  const cRows = $('case-rows'); cRows.replaceChildren(); $('cases-ageing').textContent = '';
  if (cases === null) return;
  $('cases-ageing').textContent = `${t('ageing')}: ${cases.ageing.map((a) => `${a.label} ${a.count} (${rs(a.valueMinor)})`).join(' · ')}`;
  if (cases.open.length === 0) cRows.append(el('li', `○ ${t('noCases')}`));
  for (const c of cases.open) {
    const li = el('li', undefined, 'attention'); li.dataset.case = c.investigationId;
    li.append(el('strong', `${c.investigationId} · ${t(`f_${c.finding}`)} · ${c.ref} · ${rs(c.valueMinor)}`));
    li.append(el('span', `${t('owner')}: ${c.ownerId} · ${t('dueBy')}: ${c.dueBy} · ${t('evidence')}: ${c.evidenceCount}`, 'meta'));
    if (may.investigate) {
      const ev = el('div', undefined, 'acts'); ev.append(input('case-evidence', t('evidence')), button(t('addEvidence'), 'evidence', true));
      const sel = document.createElement('select'); sel.className = 'case-outcome'; sel.setAttribute('aria-label', t('outcome'));
      sel.append(el('option', `— ${t('outcome')} —`)); sel.firstChild.value = '';
      for (const o of api.outcomes) { const opt = el('option', t(`o_${o}`)); opt.value = o; sel.append(opt); }
      const close = el('div', undefined, 'acts'); close.append(sel, input('case-note', t('note')), button(t('resolve'), 'resolve'));
      li.append(ev, close);
    }
    li.append(el('p', '', 'status row-status'));
    cRows.append(li);
  }
}
async function loadCases(asOf) {
  const out = await session.cases(asOf);
  cases = out.result === 'ok' ? out.value : null;
  if (out.result !== 'ok') $('rv-status').textContent = api.outcomeWords(lang, out);
  paintReview();
}
async function runReview() {
  $('rv-status').textContent = t('reading');
  const out = await session.review($('rv-date').value, $('rv-cycle').value);
  if (out.result !== 'ok') { review = null; say('rv-status', out, ''); paintReview(); return; }
  review = out.value; $('rv-status').textContent = review.detail ?? '';
  await loadCases($('rv-date').value);
}

// ── Payment disputes ──────────────────────────────────────────────────────────────────────────────────────
function paintDisputes() {
  const rows = $('dispute-rows'); rows.replaceChildren(); $('dispute-totals').textContent = '';
  if (disputes === null) return;
  $('dispute-totals').textContent = t('disputeTotals', { open: disputes.open, lost: rs(disputes.lostMinor) });
  if (disputes.disputes.length === 0) rows.append(el('li', `○ ${t('noDisputes')}`));
  for (const d of disputes.disputes) {
    const li = el('li', undefined, d.overdue || d.state === 'lost' ? 'attention' : d.state === 'won' ? 'good' : ''); li.dataset.dispute = d.disputeId; li.dataset.state = d.state;
    li.append(el('strong', `${d.disputeId} · ${t(`i_${d.instrument}`)} · ${d.providerRef} · ${rs(d.amountMinor)} · ${t(`ds_${d.state}`)}`));
    li.append(el('span', `${t('respondBy')} ${d.respondBy}${d.saleId ? ` · ${d.saleId}` : ''} · ${d.reason}${d.answeredLate ? ` · ${t('answeredLate')}` : ''}`, 'meta'));
    if (d.overdue) li.append(el('span', `⚠ ${t('overdueBy', { days: d.daysOverdue })}`, 'meta'));
    if (may.recordDispute && d.state === 'open') {
      const acts = el('div', undefined, 'acts'); acts.append(input('d-responded', t('respondedOn'), today()), input('d-evidence', t('evidenceRef')), button(t('answer'), 'answer'));
      li.append(acts);
    }
    if (may.recordDispute && (d.state === 'open' || d.state === 'answered')) {
      const acts = el('div', undefined, 'acts'); acts.append(input('d-decided', t('decidedOn'), today()), button(t('won'), 'won', true), button(t('lost'), 'lost', true));
      li.append(acts);
    }
    li.append(el('p', '', 'status row-status'));
    rows.append(li);
  }
}
async function loadDisputes() {
  const out = await session.disputes(today());
  disputes = out.result === 'ok' ? out.value : null;
  if (out.result !== 'ok') $('d-status').textContent = api.outcomeWords(lang, out);
  paintDisputes();
}

// ── Words ─────────────────────────────────────────────────────────────────────────────────────────────────
function paintWords() {
  document.title = `SRE ${t('title')}`;
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['load-h', 'loadH'], ['batch-h', 'batchH'], ['batch-file-l', 'batchFile'], ['batch-load-text', 'batchLoad'], ['statement-h', 'statementH'], ['st-id-l', 'stId'], ['st-account-l', 'stAccount'],
    ['st-from-l', 'stFrom'], ['st-to-l', 'stTo'], ['st-opening-l', 'stOpening'], ['st-closing-l', 'stClosing'], ['st-file-l', 'stFile'], ['st-load-text', 'stLoad'], ['statements-h', 'statementsH'],
    ['deposits-h', 'depositsH'], ['dep-on-l', 'depOn'], ['dep-amount-l', 'depAmount'], ['dep-slip-l', 'depSlip'], ['dep-account-l', 'depAccount'], ['dep-note-l', 'depNote'], ['dep-record-text', 'depRecord'],
    ['review-h', 'reviewH'], ['rv-date-l', 'asOf'], ['rv-cycle-l', 'cycle'], ['rv-go-text', 'review'], ['cases-h', 'casesH'],
    ['disputes-h', 'disputesH'], ['d-id-l', 'dId'], ['d-instrument-l', 'dInstrument'], ['d-i-upi', 'i_upi'], ['d-i-card', 'i_card'], ['d-ref-l', 'dRef'], ['d-amount-l', 'dAmount'], ['d-received-l', 'dReceived'],
    ['d-respond-by-l', 'dRespondBy'], ['d-reason-l', 'dReason'], ['d-sale-l', 'dSale'], ['d-record-text', 'dRecord']]) $(id).textContent = t(key);
}
function paintAll() { paintWords(); paintBank(); paintReview(); paintDisputes(); }

$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paintAll(); });
document.addEventListener('sre:chrome', () => paintAll());

$('batch-load').addEventListener('click', async () => {
  const f = await readFile('batch-file');
  const out = await session.importBatch(f.text, f.name);
  say('batch-status', out, t('batchDone'));
  if (out.result === 'ok' && review !== null) await runReview();
});
$('st-load').addEventListener('click', async () => {
  const f = await readFile('st-file');
  const out = await session.importStatement({ statementId: $('st-id').value, accountRef: $('st-account').value, fromDate: $('st-from').value, toDate: $('st-to').value, openingRupees: $('st-opening').value, closingRupees: $('st-closing').value, csv: f.text, sourceName: f.name });
  say('st-status', out, t('stDone'));
  if (out.result === 'ok') await loadBank();
});
$('dep-record').addEventListener('click', async () => {
  const out = await session.recordDeposit({ depositedOn: $('dep-on').value, amountRupees: $('dep-amount').value, slipRef: $('dep-slip').value, accountRef: $('dep-account').value, note: $('dep-note').value });
  say('dep-status', out, out.result === 'ok' && out.value.alreadyRecorded ? t('depAlready') : t('depDone'));
  if (out.result === 'ok') { for (const id of ['dep-amount', 'dep-slip', 'dep-note']) $(id).value = ''; await loadBank(); }
});
$('deposit-rows').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act="cancel"]'); if (b === null) return;
  const li = b.closest('li');
  const out = await session.cancelDeposit(li.dataset.deposit, li.querySelector('input.cancel-why').value);
  if (out.result === 'ok') { await loadBank(); $('dep-status').textContent = t('depCancelled'); return; }
  li.querySelector('.row-status').textContent = api.outcomeWords(lang, out);
});
$('rv-go').addEventListener('click', () => { void runReview(); });
$('exception-rows').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act="open"]'); if (b === null) return;
  const li = b.closest('li');
  const exception = review?.exceptions.find((x) => x.ref === li.dataset.ref && x.finding === li.dataset.finding); if (exception === undefined) return;
  const out = await session.openCase(exception, li.querySelector('input.case-owner').value, li.querySelector('input.case-due').value);
  if (out.result === 'ok') { await loadCases($('rv-date').value); }
  const again = $('exception-rows').querySelector(`li[data-ref="${CSS.escape(exception.ref)}"] .row-status`) ?? li.querySelector('.row-status');
  again.textContent = out.result === 'ok' ? t('caseOpened') : api.outcomeWords(lang, out);
});
$('case-rows').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]'); if (b === null) return;
  const li = b.closest('li'); const id = li.dataset.case;
  const out = b.dataset.act === 'evidence' ? await session.addEvidence(id, li.querySelector('input.case-evidence').value)
    : await session.resolve(id, li.querySelector('select.case-outcome').value, li.querySelector('input.case-note').value);
  if (out.result !== 'ok') { li.querySelector('.row-status').textContent = api.outcomeWords(lang, out); return; }
  await loadCases($('rv-date').value || today());
  const again = $('case-rows').querySelector(`li[data-case="${CSS.escape(id)}"] .row-status`);
  const words = b.dataset.act === 'evidence' ? t('evidenceAdded') : t('resolved');
  if (again !== null) again.textContent = words; else $('rv-status').textContent = `${id}: ${words}`;
});
$('d-record').addEventListener('click', async () => {
  const out = await session.recordDispute({ disputeId: $('d-id').value, instrument: $('d-instrument').value, providerRef: $('d-ref').value, amountRupees: $('d-amount').value, receivedOn: $('d-received').value, respondBy: $('d-respond-by').value, reason: $('d-reason').value, saleId: $('d-sale').value });
  say('d-status', out, out.result === 'ok' && out.value.alreadyRecorded ? t('dAlready') : t('dRecorded'));
  if (out.result === 'ok') await loadDisputes();
});
$('dispute-rows').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]'); if (b === null) return;
  const li = b.closest('li'); const id = li.dataset.dispute; const act = b.dataset.act;
  const out = act === 'answer' ? await session.answer(id, li.querySelector('input.d-responded').value, li.querySelector('input.d-evidence').value)
    : await session.decide(id, act, li.querySelector('input.d-decided').value);
  if (out.result !== 'ok') { li.querySelector('.row-status').textContent = api.outcomeWords(lang, out); return; }
  await loadDisputes();
  $('d-status').textContent = `${id}: ${act === 'answer' ? t('answered') : t('decided')}`;
});

paintWords();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.read && !may.disputes) $('page-status').textContent = t('cannotRead');
else {
  if (may.read) {
    $('bank').hidden = false; $('review').hidden = false;
    $('rv-date').value = today();
    void loadBank(); void loadCases(today());
  }
  if (may.import) { $('load').hidden = false; $('deposit-form').hidden = false; $('dep-on').value = today(); } else if (may.read) $('page-status').textContent = t('cannotImport');
  if (may.disputes) { $('disputes').hidden = false; $('dispute-form').hidden = !may.recordDispute; void loadDisputes(); }
}
