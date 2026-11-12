// Tally files — the accountant's daily Tally import files (OB-293 · M23-FR-01/04 · M32-FR-04 · D10-FR-06). The session
// (apps/web-erp/src/tally-files-session.ts, in the bundle as window.tallyFiles) asks head office on a click; this page
// lists the dead letter FIRST (a day Tally could not be given, with the reason, never hidden), then every day's file with
// what it carries by family; downloads a day's XML; requeues a dead day with the words of what was fixed; and shows a
// month's trial balance with each department's sales, cost and margin tied to the ledger (OB-340). Every state is an icon
// AND words. Every word has a Tamil twin.

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
// U5 (G13): a status line's mark is the one icon set's shape for its tone, never a ✓ / ⚠ / ○ character beside the words.
const toneIcon = (tone, size = 18) => (window.sreIcon && typeof window.sreIcon.forTone === 'function' && typeof window.sreIcon === 'function' ? window.sreIcon(window.sreIcon.forTone(tone), size) : null);
function status(where, tone, words) {
  const el = $(where); el.className = `status ${tone === 'ok' ? 'good' : tone === 'error' ? 'err' : ''}`.trim();
  const mark = toneIcon(tone); el.replaceChildren(...(mark ? [mark, ' '] : []), words);
}
function good(where, words) { status(where, 'ok', words); }
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function button(words, iconName, onClick, cls) {
  const b = document.createElement('button'); b.classList.add('sre-btn'); b.type = 'button'; if (cls) b.className = cls;
  const i = icon(iconName); if (i !== null) b.append(i, ' ');
  b.append(text('span', words)); b.addEventListener('click', onClick); return b;
}
const TONE = { posted: 'ok', queued: 'degraded', dead_lettered: 'error' };
/** A posting's state as the chrome's chip (the tone's shape and the word), never a glyph. */
function stateChip(state) {
  const o = window.sreOffice; const words = t(`s_${state}`);
  if (o && typeof o.chip === 'function') return o.chip(TONE[state] ?? 'idle', words);
  return text('span', words, 'sre-chip');
}
/** An empty list is the shared state part — what the list covers, never a bare line. */
function emptyRow(words) {
  const li = document.createElement('li'); li.className = 'empty';
  const o = window.sreOffice;
  if (o && typeof o.state === 'function') li.append(o.state(null, 'empty', { title: words, detail: '' })); else li.textContent = words;
  return li;
}
/** A figure head office does not know, by name (never a zero). */
function notKnownCell(words) { const span = text('span', words, 'sre-unknown'); const mark = typeof window.sreIcon === 'function' ? window.sreIcon('circle-help', 16) : null; if (mark) { mark.style.marginInlineEnd = '6px'; span.prepend(mark); } return span; }

function row(p) {
  const li = document.createElement('li');
  const settled = p.correctedBy !== null && p.correctedBy.state === 'posted';
  li.className = `row tone-${settled ? 'ok' : TONE[p.state]}`;
  li.dataset.posting = p.postingId; li.dataset.state = p.state; li.dataset.day = p.day;
  const head = document.createElement('div'); head.className = 'head';
  head.append(text('strong', `${t('dayK')} ${p.day}${p.sequence > 1 ? ` (${p.sequence})` : ''}`), stateChip(p.state));
  li.append(head);
  const facts = document.createElement('div'); facts.className = 'facts';
  facts.append(text('span', `${p.journals} ${t('journalsK')} · ${t('debitK')} ${api.rupees(p.debitMinor)} · ${t('creditK')} ${api.rupees(p.creditMinor)} · ${p.attempts} ${t('attemptsK')}`));
  if (p.file !== null) for (const f of p.file.byFamily) { const s = text('span', `${api.familyWords(outbox, lang, f.family)}: ${f.journals} ${t('journalsK')} · ${api.rupees(f.debitMinor)}`); s.dataset.family = f.family; facts.append(s); }
  if (p.lastFailure !== null) facts.append(text('span', `${t('whyK')}: ${p.lastFailure}`, 'why'));
  if (p.waitingFor === 'ledger_names') facts.append(text('span', t('noNames')));
  if (p.nextAttemptAt !== null) facts.append(text('span', `${t('nextK')}: ${p.nextAttemptAt}`));
  if (p.corrects !== null) facts.append(text('span', `${t('correctsK')} ${p.corrects}`));
  if (p.correctedBy !== null) { const c = text('span', `${t('correctedByK')} ${p.correctedBy.postingId} — `, 'corrected'); c.append(stateChip(p.correctedBy.state)); facts.append(c); }
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

// U2 · G14 (UI/UX gap audit): the month is PICKED from the last 24 months, named in the reader's language — never typed as
// "YYYY-MM". The value the page sends stays "YYYY-MM"; the choice survives a language change.
const MONTHS = {
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  ta: ['ஜனவரி', 'பிப்ரவரி', 'மார்ச்', 'ஏப்ரல்', 'மே', 'ஜூன்', 'ஜூலை', 'ஆகஸ்ட்', 'செப்டம்பர்', 'அக்டோபர்', 'நவம்பர்', 'டிசம்பர்'],
};
function monthChoices() {
  // The SHOP's today (the store computer's clock, OB-606) — never the device's clock. With no shop clock (the page opened
  // off the box) there is no honest month to anchor on, and the plain month field stays as it was.
  const shopToday = window.sreShopDay?.today?.() ?? null;
  if (shopToday === null) return null;
  const y = Number(shopToday.slice(0, 4)); const m = Number(shopToday.slice(5, 7));
  return Array.from({ length: 24 }, (_, i) => { const n = y * 12 + (m - 1) - i; return `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}`; });
}
function paintMonthList() {
  const was = $('tb-month');
  const choices = monthChoices();
  if (was === null || choices === null) return;
  const chosen = was.value;
  const select = was.tagName === 'SELECT' ? was : Object.assign(document.createElement('select'), { id: 'tb-month' });
  select.className = 'sre-select';
  select.replaceChildren(...choices.map((ym) => { const o = document.createElement('option'); o.value = ym; o.textContent = `${(MONTHS[lang] ?? MONTHS.en)[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`; return o; }));
  if (was !== select) was.replaceWith(select);
  if ([...select.options].some((o) => o.value === chosen)) select.value = chosen;
}

function paint() {
  paintMonthList();
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title-text', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['read-text', 'read'], ['run-text', 'run'],
    ['posted-k', 'postedK'], ['queued-k', 'queuedK'], ['dead-k', 'deadK'], ['company-k', 'companyK'], ['dead-h', 'deadH'], ['files-h', 'filesH'],
    ['tb-h', 'tbH'], ['tb-month-l', 'monthL'], ['tb-read-text', 'tbRead'], ['dept-h', 'deptH']]) $(id).textContent = t(k);
  $('lang').textContent = t('lang');
  $('whoami').textContent = window.tallyFilesData?.userId ?? '';
  $('nobody').hidden = may.named; $('nobody').textContent = t('nobody');
  $('read').disabled = !may.read; $('tb-read').disabled = !may.read; $('run').disabled = !may.configure;
  whyDisabled($('read'), may.read ? '' : 'role'); whyDisabled($('tb-read'), may.read ? '' : 'role'); whyDisabled($('run'), may.configure ? '' : 'role');
  $('tiles').hidden = outbox === null; $('dead-section').hidden = outbox === null; $('files-section').hidden = outbox === null;
  if (outbox !== null) {
    // U5: the tiles carry the figure and a tone (the shape beside the label), never a glyph in the figure
    const tile = (id, value, tone) => { const b = $(id); b.textContent = value; b.closest('.tile').dataset.tone = tone; };
    tile('posted-n', String(outbox.counts.posted), 'ok');
    tile('queued-n', String(outbox.counts.queued), outbox.counts.queued > 0 ? 'degraded' : 'idle');
    tile('dead-n', String(outbox.openDeadLetters), outbox.openDeadLetters > 0 ? 'error' : 'ok');
    if (outbox.ledgerNames === null) { $('company-n').replaceChildren(notKnownCell(t('notNamed'))); $('company-n').closest('.tile').dataset.tone = 'degraded'; } else tile('company-n', outbox.ledgerNames.companyName, 'ok');
    $('no-names').hidden = outbox.waitingFor !== 'ledger_names'; if (outbox.waitingFor === 'ledger_names') status('no-names', 'degraded', t('noNames'));
    $('dead').replaceChildren(...(outbox.deadLetters.length === 0 ? [emptyRow(t('noDead'))] : outbox.deadLetters.map(row)));
    $('files').replaceChildren(...(outbox.postings.length === 0 ? [emptyRow(t('noFiles'))] : outbox.postings.map(row)));
  }
  $('tb-wrap').hidden = tb === null;
  const o = window.sreOffice;
  if (tb !== null && o && typeof o.table === 'function') {
    // U5 (G17): the trial balance on the chrome's register — sortable, searchable, the figures right-aligned, the rows stacking on a phone.
    const both = (k) => ({ en: api.words('en', k), ta: api.words('ta', k) });
    o.table($('tb-wrap'), {
      id: 'tally-trial-balance', label: both('tbH'), bodyId: 'tb-rows', pageSize: 50, sortable: true, count: false,
      rowKey: (r) => r.account, rowData: (r) => ({ account: r.account }), rows: [...tb.rows],
      columns: [
        { key: 'account', label: both('accountK'), sort: 'text' },
        { key: 'accountClass', label: both('classK'), sort: 'text', filter: true, value: (r) => r.accountClass ?? t('unclassed'), render: (r) => (r.accountClass ?? notKnownCell(t('unclassed'))) },
        { key: 'periodDebitMinor', label: both('debitK'), align: 'end', sort: 'number', render: (r) => api.rupees(r.periodDebitMinor) },
        { key: 'periodCreditMinor', label: both('creditK'), align: 'end', sort: 'number', render: (r) => api.rupees(r.periodCreditMinor) },
        { key: 'closingNetDebitMinor', label: both('closingK'), align: 'end', sort: 'number', render: (r) => api.rupees(r.closingNetDebitMinor) },
      ],
    });
  }
  // OB-340: each department's sales as the ledger holds them, its goods' cost at the average buying cost, and the margin —
  // a cost that is not known is said in words (never a zero), and the tie to the ledger's revenue is shown.
  const d = tb?.departments ?? null;
  $('dept-wrap').hidden = d === null || d.departments.length === 0;
  if (d !== null && d.departments.length > 0 && o && typeof o.table === 'function') {
    status('dept-tie', d.ties ? 'ok' : 'error', d.ties ? t('deptTies') : t('deptNoTie'));
    const both = (k) => ({ en: api.words('en', k), ta: api.words('ta', k) });
    const pct = (r) => (r.marginBps === null ? '' : ` (${(r.marginBps / 100).toFixed(1)}%)`);
    o.table($('dept-table'), {
      id: 'tally-departments', label: both('deptH'), bodyId: 'dept-rows', pageSize: 50, sortable: true, search: false, count: false,
      rowKey: (r) => r.departmentId, rowData: (r) => ({ department: r.departmentId }), rows: [...d.departments],
      columns: [
        { key: 'name', label: both('deptK'), sort: 'text', value: (r) => r.name ?? r.departmentId, render: (r) => { const name = text('span', r.name ?? r.departmentId); if (r.notCosted.length > 0) name.append(text('span', ` ${t('notCostedK')}: ${r.notCosted.join(', ')}`, 'why')); return name; } },
        { key: 'salesMinor', label: both('salesK'), align: 'end', sort: 'number', render: (r) => api.rupees(r.salesMinor) },
        { key: 'costMinor', label: both('costK'), align: 'end', sort: 'number', render: (r) => (r.costMinor === null ? notKnownCell(t('notKnown')) : api.rupees(r.costMinor)) },
        { key: 'marginMinor', label: both('marginK'), align: 'end', sort: 'number', render: (r) => (r.marginMinor === null ? notKnownCell(t('notKnown')) : `${api.rupees(r.marginMinor)}${pct(r)}`) },
      ],
    });
    $('dept-rest').textContent = `${t('notInDeptK')}: ${api.rupees(d.notInADepartmentMinor)} · ${t('ledgerK')}: ${api.rupees(d.ledgerRevenueMinor)}`;
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
  status('page-status', v.deadLettered > 0 ? 'degraded' : 'ok', v.posted + v.queued + v.deadLettered === 0 ? t('runNone') : `${t('runDone')} ${v.posted} ${t('postedK').toLowerCase()} · ${v.deadLettered} ${t('deadK').toLowerCase()}`);
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
  if (tb.rows.length === 0) status('tb-status', 'idle', tb.detail); else status('tb-status', tb.balanced ? 'ok' : 'error', tb.balanced ? t('balanced') : `${t('outBy')} ${api.rupees(tb.outByMinor)}`);
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
