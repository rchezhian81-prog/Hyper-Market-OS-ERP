// Tally files — the accountant's daily Tally import files (OB-293 · M23-FR-01/04 · M32-FR-04 · D10-FR-06). The session
// (apps/web-erp/src/tally-files-session.ts, in the bundle as window.tallyFiles) asks head office on a click; this page
// lists the dead letter FIRST (a day Tally could not be given, with the reason, never hidden), then every day's file with
// what it carries by family; downloads a day's XML; requeues a dead day with the words of what was fixed; and shows a
// month's trial balance. Every state is an icon AND words. Every word has a Tamil twin.

const $ = (id) => document.getElementById(id);
const api = window.tallyFiles ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, configure: false };

let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
let outbox = null;
let tb = null;

const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
for (const [id, name] of [['read', 'search'], ['run', 'refresh-cw'], ['tb-read', 'calculator']]) { const i = icon(name); if (i !== null) $(id).prepend(i, ' '); }

function say(where, out) { $(where).className = 'status err'; $(where).textContent = api.outcomeWords(lang, out); }
function good(where, words) { $(where).className = 'status good'; $(where).textContent = `✓ ${words}`; }
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function button(words, iconName, onClick, cls) {
  const b = document.createElement('button'); b.type = 'button'; if (cls) b.className = cls;
  const i = icon(iconName); if (i !== null) b.append(i, ' ');
  b.append(text('span', words)); b.addEventListener('click', onClick); return b;
}
const MARK = { posted: '✓', queued: '⏱', dead_lettered: '⚠' };
const TONE = { posted: 'ok', queued: 'degraded', dead_lettered: 'error' };

function row(p) {
  const li = document.createElement('li');
  const settled = p.correctedBy !== null && p.correctedBy.state === 'posted';
  li.className = `row tone-${settled ? 'ok' : TONE[p.state]}`;
  li.dataset.posting = p.postingId; li.dataset.state = p.state; li.dataset.day = p.day;
  li.append(text('strong', `${MARK[p.state]} ${t('dayK')} ${p.day}${p.sequence > 1 ? ` (${p.sequence})` : ''} — ${t(`s_${p.state}`)}`));
  const facts = document.createElement('div'); facts.className = 'facts';
  facts.append(text('span', `${p.journals} ${t('journalsK')} · ${t('debitK')} ${api.rupees(p.debitMinor)} · ${t('creditK')} ${api.rupees(p.creditMinor)} · ${p.attempts} ${t('attemptsK')}`));
  if (p.file !== null) for (const f of p.file.byFamily) { const s = text('span', `${api.familyWords(outbox, lang, f.family)}: ${f.journals} ${t('journalsK')} · ${api.rupees(f.debitMinor)}`); s.dataset.family = f.family; facts.append(s); }
  if (p.lastFailure !== null) facts.append(text('span', `⚠ ${t('whyK')}: ${p.lastFailure}`, 'why'));
  if (p.waitingFor === 'ledger_names') facts.append(text('span', `⏱ ${t('noNames')}`));
  if (p.nextAttemptAt !== null) facts.append(text('span', `⏱ ${t('nextK')}: ${p.nextAttemptAt}`));
  if (p.corrects !== null) facts.append(text('span', `↺ ${t('correctsK')} ${p.corrects}`));
  if (p.correctedBy !== null) facts.append(text('span', `↺ ${t('correctedByK')} ${p.correctedBy.postingId} — ${MARK[p.correctedBy.state]} ${t(`s_${p.correctedBy.state}`)}`, 'corrected'));
  li.append(facts);
  const actions = document.createElement('div'); actions.className = 'actions';
  if (p.state === 'posted') actions.append(button(t('download'), 'file-text', () => { void download(p.postingId); }));
  if (p.state === 'dead_lettered' && p.correctedBy === null && may.configure) {
    const label = document.createElement('label');
    const input = document.createElement('input'); input.className = 'reason'; input.autocomplete = 'off';
    label.append(text('span', t('reasonL')), input);
    actions.append(label, button(t('requeue'), 'rotate-ccw', () => { void requeue(p.postingId, input.value); }, 'quiet'));
  }
  if (actions.children.length > 0) li.append(actions);
  return li;
}

function paint() {
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title-text', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['read-text', 'read'], ['run-text', 'run'],
    ['posted-k', 'postedK'], ['queued-k', 'queuedK'], ['dead-k', 'deadK'], ['company-k', 'companyK'], ['dead-h', 'deadH'], ['files-h', 'filesH'],
    ['tb-h', 'tbH'], ['tb-month-l', 'monthL'], ['tb-read-text', 'tbRead'], ['tb-account-h', 'accountK'], ['tb-class-h', 'classK'],
    ['tb-debit-h', 'debitK'], ['tb-credit-h', 'creditK'], ['tb-closing-h', 'closingK']]) $(id).textContent = t(k);
  $('lang').textContent = t('lang');
  $('whoami').textContent = window.tallyFilesData?.userId ?? '';
  $('nobody').hidden = may.named; $('nobody').textContent = t('nobody');
  $('read').disabled = !may.read; $('tb-read').disabled = !may.read; $('run').disabled = !may.configure;
  $('tiles').hidden = outbox === null; $('dead-section').hidden = outbox === null; $('files-section').hidden = outbox === null;
  if (outbox !== null) {
    $('posted-n').textContent = `✓ ${outbox.counts.posted}`;
    $('queued-n').textContent = `⏱ ${outbox.counts.queued}`;
    $('dead-n').textContent = `${outbox.openDeadLetters > 0 ? '⚠' : '✓'} ${outbox.openDeadLetters}`;
    $('company-n').textContent = outbox.ledgerNames === null ? `○ ${t('notNamed')}` : outbox.ledgerNames.companyName;
    $('no-names').hidden = outbox.waitingFor !== 'ledger_names'; $('no-names').textContent = `⏱ ${t('noNames')}`;
    $('dead').replaceChildren(...(outbox.deadLetters.length === 0 ? [text('li', `✓ ${t('noDead')}`, 'row tone-ok')] : outbox.deadLetters.map(row)));
    $('files').replaceChildren(...(outbox.postings.length === 0 ? [text('li', `○ ${t('noFiles')}`, 'row')] : outbox.postings.map(row)));
  }
  $('tb-wrap').hidden = tb === null;
  if (tb !== null) {
    $('tb-rows').replaceChildren(...tb.rows.map((r) => {
      const tr = document.createElement('tr'); tr.dataset.account = r.account;
      tr.append(text('td', r.account), text('td', r.accountClass ?? `○ ${t('unclassed')}`), text('td', api.rupees(r.periodDebitMinor), 'num'), text('td', api.rupees(r.periodCreditMinor), 'num'), text('td', api.rupees(r.closingNetDebitMinor), 'num'));
      return tr;
    }));
  }
}

async function show() {
  const out = await session.read();
  if (out.result === 'ok') { outbox = out.value; $('page-status').className = 'status'; $('page-status').textContent = ''; } else say('page-status', out);
  paint();
}

async function runNow() {
  const out = await session.run();
  if (out.result !== 'ok') { say('page-status', out); return; }
  await show();
  const v = out.value;
  good('page-status', v.posted + v.queued + v.deadLettered === 0 ? t('runNone') : `${t('runDone')} ✓ ${v.posted} · ⚠ ${v.deadLettered}`);
}

async function requeue(postingId, reason) {
  const out = await session.requeue(postingId, reason);
  if (out.result !== 'ok') { say('page-status', out); return; }
  await show();
  good('page-status', `${t('requeued')} ${out.value.posting?.postingId ?? out.value.alreadyRequeuedAs ?? postingId}`);
}

async function download(postingId) {
  const out = await session.download(postingId);
  if (out.result !== 'ok') { say('page-status', out); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([out.value.xml], { type: 'application/xml' }));
  a.download = out.value.fileName;
  document.body.append(a); a.click(); a.remove();
  const before = out.value.downloadedBefore.map((d) => `${d.by} (${d.at})`).join(', ');
  good('page-status', `${t('downloaded')} ${out.value.fileName}${before === '' ? '' : ` · ${t('downloadedBefore')} ${before}`}`);
}

async function showTb() {
  const out = await session.trialBalance($('tb-month').value);
  if (out.result !== 'ok') { tb = null; say('tb-status', out); paint(); return; }
  tb = out.value;
  $('tb-status').className = tb.balanced ? 'status good' : 'status err';
  $('tb-status').textContent = tb.rows.length === 0 ? `○ ${tb.detail}` : tb.balanced ? `✓ ${t('balanced')}` : `⚠ ${t('outBy')} ${api.rupees(tb.outByMinor)}`;
  paint();
}

$('read').addEventListener('click', () => { void show(); });
$('run').addEventListener('click', () => { void runNow(); });
$('tb-read').addEventListener('click', () => { void showTb(); });
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (may.named && !may.read) { $('page-status').className = 'status err'; $('page-status').textContent = t('cannotRead'); }

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}
