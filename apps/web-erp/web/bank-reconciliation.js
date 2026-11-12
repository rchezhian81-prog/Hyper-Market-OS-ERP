// Bank reconciliation (U6 · M23-FR-03 · QG-07 · P-08) — the page over head office's line-by-line routes. The session
// (apps/web-erp/src/bank-reconciliation-session.ts, in the bundle as window.bankReconciliation) does every call and every
// rule; this page lays out what it is told, on the shared office parts (window.sreOffice: cards, table, state, chip, field,
// pickable, confirm). It reads head office as it opens (GETs only); a fact is recorded only after the confirm sheet.
// Every word this page adds has a Tamil twin (OB-699); head office's own sentences stay in English.

const $ = (id) => document.getElementById(id);
const api = window.bankReconciliation ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, manage: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
const both = (k) => (api === null ? { en: k, ta: k } : { en: api.words('en', k), ta: api.words('ta', k) });
const office = () => window.sreOffice ?? null;
const shopTime = (at) => (at === null || at === '' ? '' : window.sreShopDay?.dateTimeOf(at) ?? at);
const shopDay = (iso) => (window.sreOffice && typeof window.sreOffice.dateWords === 'function' ? window.sreOffice.dateWords(iso) : iso);
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
const fill = (words, values) => Object.entries(values).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), words);
const nameOf = (kind, id) => { const o = office(); return o && typeof o.nameOf === 'function' ? o.nameOf(kind, id) : id; };
const personWords = (id) => { const n = nameOf('person', id); return n && n !== id ? `${n} (${id})` : id; };

let data = null; let outcome = null; let readAt = null; let chosenStatement = '';
let statementChoice = null;
let ownerWired = false;

/** A select on the shared field part, re-made with the given options; keeps the chosen value when it still exists. */
function selectField(hostId, id, labelKey, options, placeholderKey) {
  const o = office(); const host = $(hostId); if (o === null || host === null) return null;
  const current = $(id)?.value ?? '';
  const field = o.field({ id, label: both(labelKey), type: 'select', options: [{ value: '', label: t(placeholderKey) }, ...options] });
  host.replaceChildren(field);
  const sel = $(id); if (sel && options.some((x) => x.value === current)) sel.value = current;
  return sel;
}

const matchChip = (m) => {
  const o = office(); if (o === null) return document.createTextNode(t(m.kind));
  if (m.kind === 'provider_payout') return o.chip('ok', `${t('provider_payout')} · ${t('batch')} ${m.batchId}`);
  if (m.kind === 'cash_deposit') return o.chip('ok', `${t('cash_deposit')} · ${t('slip')} ${m.slipRef}`);
  if (m.kind === 'exception') return o.chip(m.state === 'resolved' ? 'ok' : m.overdue ? 'error' : 'pending', `${t('exception')} · ${m.state === 'resolved' ? t('resolved') : m.overdue ? t('overdue') : t('open')}`);
  return o.chip('degraded', t('unmatched'));
};

function paintSummary() {
  const o = office(); $('cards').replaceChildren(); $('adds-up').textContent = '';
  if (o === null || data === null || data.totals === null) return;
  const x = data.totals;
  o.cards($('cards'), [
    { label: both('cLines'), value: x.lines, icon: 'list' },
    { label: both('cMatched'), value: x.matched, tone: 'ok', icon: 'check' },
    { label: both('cUnmatched'), value: x.unmatched, tone: x.unmatched > 0 ? 'degraded' : 'ok', icon: 'triangle-alert', note: `${t('cUnmatchedValue')} ${api.rupees(x.unmatchedMinor)}` },
    { label: both('cOpen'), value: x.openExceptions, tone: x.openExceptions > 0 ? 'pending' : undefined, icon: 'circle-help', note: x.overdueExceptions > 0 ? `${t('cOverdue')} ${x.overdueExceptions}` : undefined },
    { label: both('cCredits'), value: api.rupees(x.creditsMinor), icon: 'arrow-down' },
    { label: both('cDebits'), value: api.rupees(x.debitsMinor), icon: 'arrow-up' },
  ]);
  $('adds-up').textContent = data.statementAddsUp === true ? t('addsUp') : data.statementAddsUp === false ? t('doesNotAddUp') : '';
}

function paintLines() {
  const o = office(); const host = $('lines-table'); host.replaceChildren(); $('lines-note').textContent = '';
  if (o === null) return;
  if (outcome !== null) { o.state(host, o.stateOf(outcome), { title: api.outcomeWords(lang, outcome), detail: t('notReadDetail') }); return; }
  if (data === null) { o.state(host, 'loading'); return; }
  if (data.statement === null) { o.state(host, 'empty', { title: t('noStatements'), detail: t('noStatementsDetail'), action: () => { window.location.href = '../settlement/'; }, actionLabel: t('importPage') }); return; }
  if (data.lines.length === 0) { o.state(host, 'empty', { title: t('noLines'), detail: t('noLinesDetail') }); return; }
  $('lines-note').textContent = t('headOfficeEnglish');
  o.table(host, {
    id: 'bank-lines', label: both('linesH'), rows: data.lines, pageSize: 20, sortable: true,
    rowKey: (l) => l.lineId, rowData: (l) => ({ line: l.lineId, match: l.match.kind, state: l.match.kind === 'exception' ? l.match.state : '' }),
    columns: [
      { key: 'date', label: both('date'), sort: 'text', value: (l) => shopDay(l.date) },
      { key: 'amountMinor', label: both('amount'), sort: 'number', align: 'end', value: (l) => api.rupees(l.amountMinor) },
      { key: 'reference', label: both('reference'), sort: 'text', value: (l) => (l.narrative ? `${l.reference} — ${l.narrative}` : l.reference) },
      { key: 'match', label: both('match'), sort: false, value: (l) => t(l.match.kind), render: (l) => matchChip(l.match) },
      { key: 'owner', label: both('owner'), sort: false, value: (l) => (l.match.kind === 'exception' ? personWords(l.match.ownerUserId) : null) },
      { key: 'action', label: both('action'), sort: false, render: (l) => {
        if (!may.manage) return null;
        if (l.match.kind === 'unmatched') { const b = document.createElement('button'); b.type = 'button'; b.className = 'sre-btn sre-btn-quiet'; b.textContent = t('pickLine'); b.dataset.raiseLine = l.lineId; b.addEventListener('click', () => { if ($('line')) $('line').value = l.lineId; $('raise').scrollIntoView({ block: 'start' }); $('owner').focus(); }); return b; }
        if (l.match.kind === 'exception' && l.match.state === 'open') { const b = document.createElement('button'); b.type = 'button'; b.className = 'sre-btn sre-btn-quiet'; b.textContent = t('pickException'); b.dataset.resolveException = l.match.exceptionId; b.addEventListener('click', () => { if ($('exception')) $('exception').value = l.match.exceptionId; $('resolve').scrollIntoView({ block: 'start' }); $('reason').focus(); }); return b; }
        return null;
      } },
    ],
    empty: { title: t('noLines'), detail: t('noLinesDetail') },
  });
}

function paintExceptions() {
  const o = office(); const host = $('exceptions-table'); host.replaceChildren(); $('exceptions-note').textContent = '';
  if (o === null || data === null || data.statement === null) return;
  if (data.exceptions.length === 0) { o.state(host, 'empty', { title: t('exceptionsNone'), detail: t('exceptionsNoneDetail') }); return; }
  $('exceptions-note').textContent = t('headOfficeEnglish');
  o.table(host, {
    id: 'bank-exceptions', label: both('exceptionsH'), rows: data.exceptions, pageSize: 10, sortable: true,
    rowKey: (e) => e.exceptionId, rowData: (e) => ({ exception: e.exceptionId, state: e.state }),
    columns: [
      { key: 'exceptionId', label: both('exceptionField'), sort: 'text' },
      { key: 'lineId', label: both('line'), sort: 'text' },
      { key: 'amountMinor', label: both('value'), sort: 'number', align: 'end', value: (e) => api.rupees(e.amountMinor) },
      { key: 'ownerUserId', label: both('owner'), sort: 'text', value: (e) => personWords(e.ownerUserId) },
      { key: 'state', label: both('state'), sort: 'text', value: (e) => (e.state === 'resolved' ? t('resolved') : e.overdue ? t('overdue') : t('open')), render: (e) => o.chip(e.state === 'resolved' ? 'ok' : e.overdue ? 'error' : 'pending', e.state === 'resolved' ? t('resolved') : e.overdue ? t('overdue') : t('open')) },
      { key: 'raisedOn', label: both('raisedOn'), sort: 'text', value: (e) => `${shopDay(e.raisedOn)} · ${personWords(e.raisedBy)}` },
      { key: 'resolution', label: both('outcome'), sort: false, value: (e) => (e.resolution ? `${t(e.resolution.outcome)} · ${e.resolution.reason}${e.resolution.matchedTo ? ` · ${t('matchedTo')}: ${e.resolution.matchedTo}` : ''} · ${personWords(e.resolution.by)}` : (e.note ?? null)) },
    ],
    empty: { title: t('exceptionsNone'), detail: t('exceptionsNoneDetail') },
  });
}

function paintForms() {
  if (data === null || data.statement === null) { $('raise').hidden = true; $('resolve').hidden = true; return; }
  $('raise').hidden = !may.manage; $('resolve').hidden = !may.manage;
  if (!may.manage) return;
  const unmatched = data.lines.filter((l) => l.match.kind === 'unmatched').map((l) => ({ value: l.lineId, label: `${shopDay(l.date)} · ${api.rupees(l.amountMinor)} · ${l.reference}` }));
  selectField('line-field', 'line', 'line', unmatched, 'chooseLine');
  const open = data.exceptions.filter((e) => e.state === 'open').map((e) => ({ value: e.exceptionId, label: `${e.exceptionId} · ${api.rupees(e.amountMinor)} · ${personWords(e.ownerUserId)}` }));
  selectField('exception-field', 'exception', 'exceptionField', open, 'chooseException');
  selectField('outcome-field', 'outcome', 'outcome', api.outcomes.map((x) => ({ value: x, label: t(x) })), 'needOutcome');
  const o = office();
  if (o !== null && !ownerWired && typeof o.pickable === 'function') { o.pickable('owner', 'person', both('ownerField'), { allowCode: true }); ownerWired = true; }
}

function paintChoose() {
  if (data === null) return;
  statementChoice = selectField('statement-field', 'statement', 'chooseStatement', data.statements.map((s) => ({ value: s.statementId, label: `${s.statementId} · ${s.accountRef} · ${shopDay(s.fromDate)} – ${shopDay(s.toDate)}` })), 'chooseStatement');
  if (statementChoice && data.statement) statementChoice.value = data.statement.statementId;
  $('covers').textContent = data.statement === null ? '' : fill(t('covers'), { id: data.statement.statementId, account: data.statement.accountRef, from: shopDay(data.statement.fromDate), to: shopDay(data.statement.toDate), time: shopTime(readAt) });
}

function paint() {
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  document.title = `SRE ${t('title')}`;
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['choose-h', 'statement'], ['show-text', 'show'], ['reload-text', 'reload'], ['import-text', 'importPage'], ['summary-h', 'cLines'], ['lines-h', 'linesH'],
    ['raise-h', 'raiseH'], ['raise-lead', 'raiseLead'], ['owner-l', 'ownerField'], ['note-l', 'note'], ['raise-text', 'raise'],
    ['resolve-h', 'resolveH'], ['resolve-lead', 'resolveLead'], ['reason-l', 'reason'], ['matched-to-l', 'matchedTo'], ['resolve-text', 'resolve'], ['exceptions-h', 'exceptionsH']]) { const n = $(id); if (n) n.textContent = t(key); }
  paintChoose(); paintSummary(); paintLines(); paintForms(); paintExceptions();
}

async function load(statementId) {
  $('read-status').textContent = t('reading');
  const out = await session.read(statementId);
  if (out.result === 'ok') { data = out.value; outcome = null; readAt = new Date().toISOString(); chosenStatement = data.statement?.statementId ?? ''; } else { data = null; outcome = out; }
  $('read-status').textContent = outcome === null ? '' : api.outcomeWords(lang, outcome);
  for (const id of ['summary', 'lines', 'exceptions']) $(id).hidden = outcome !== null || data === null || data.statement === null;
  if (data !== null && data.statement === null) $('lines').hidden = false;
  paint();
}

// U1 · OB-698: a fact is recorded only after the shared consequence-and-confirm sheet. `null` = went back; 'unavailable' = said.
async function confirmFirst(spec) {
  const o = office();
  if (!o || typeof o.confirm !== 'function') return 'unavailable';
  const answer = await o.confirm(spec);
  return answer && answer.ok === true ? answer : null;
}

async function raise(event) {
  event.preventDefault();
  const lineId = $('line')?.value ?? ''; const ownerUserId = $('owner').value.trim(); const note = $('note').value;
  const line = data?.lines.find((l) => l.lineId === lineId);
  if (line === undefined) { $('raise-status').textContent = t('needLine'); return; }
  if (ownerUserId === '') { $('raise-status').textContent = t('needOwner'); return; }
  const values = { line: lineId, amount: api.rupees(line.amountMinor), owner: personWords(ownerUserId) };
  const answer = await confirmFirst({ title: both('confirmRaiseTitle'), detail: { en: fill(api.words('en', 'confirmRaiseDetail'), values), ta: fill(api.words('ta', 'confirmRaiseDetail'), values) }, authority: both('authorityRaise'), confirmLabel: both('raise'), tone: 'warn' });
  if (answer === 'unavailable') { $('raise-status').textContent = t('confirmUnavailable'); return; }
  if (answer === null) return;
  const out = await session.raise({ statementId: data.statement.statementId, lineId, ownerUserId, note });
  $('raise-status').textContent = out.result === 'ok' ? t('raised') : api.outcomeWords(lang, out);
  if (out.result === 'ok') { $('note').value = ''; await load(chosenStatement); }
}

async function resolve(event) {
  event.preventDefault();
  const exceptionId = $('exception')?.value ?? ''; const outcomeKey = $('outcome')?.value ?? ''; const reason = $('reason').value; const matchedTo = $('matched-to').value;
  if (exceptionId === '') { $('resolve-status').textContent = t('needException'); return; }
  if (outcomeKey === '') { $('resolve-status').textContent = t('needOutcome'); return; }
  if (reason.trim() === '') { $('resolve-status').textContent = t('needReason'); return; }
  const values = { id: exceptionId, outcome: t(outcomeKey) };
  const answer = await confirmFirst({ title: both('confirmResolveTitle'), detail: { en: fill(api.words('en', 'confirmResolveDetail'), { id: exceptionId, outcome: api.words('en', outcomeKey) }), ta: fill(api.words('ta', 'confirmResolveDetail'), { id: exceptionId, outcome: api.words('ta', outcomeKey) }) }, authority: both('authorityResolve'), confirmLabel: both('resolve'), tone: 'warn', reason: { label: both('reason'), required: false, value: reason } });
  void values;
  if (answer === 'unavailable') { $('resolve-status').textContent = t('confirmUnavailable'); return; }
  if (answer === null) return;
  const out = await session.resolve(exceptionId, { outcome: outcomeKey, reason, matchedTo });
  $('resolve-status').textContent = out.result === 'ok' ? t('resolvedOk') : api.outcomeWords(lang, out);
  if (out.result === 'ok') { $('reason').value = ''; $('matched-to').value = ''; await load(chosenStatement); }
}

for (const [id, name] of [['reload', 'refresh-cw'], ['show', 'search']]) { const i = icon(name); if (i !== null) $(id).prepend(i); }
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
document.addEventListener('sre:chrome', () => { paint(); });
paint();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.read) $('page-status').textContent = t('cannotRead');
else {
  $('choose').hidden = false;
  if (!may.manage) $('page-status').textContent = t('cannotManage');
  $('choose-form').addEventListener('submit', (e) => { e.preventDefault(); void load($('statement')?.value ?? ''); });
  $('reload').addEventListener('click', () => { void load(chosenStatement); });
  $('raise-form').addEventListener('submit', (e) => { void raise(e); });
  $('resolve-form').addEventListener('submit', (e) => { void resolve(e); });
  void load();
}
