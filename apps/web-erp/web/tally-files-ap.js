// Tally files — the month's supplier-bill file (W4 · WF-05 · M23-FR-04 · P-08). Every rule lives in the TESTED session
// (apps/web-erp/src/supplier-bills-to-the-books-session.ts, window.apTally). On a click this file asks head office for the
// month's supplier-bill vouchers as one Tally import file, says whether Tally's import check accepts it, names every
// voucher kept out (an account with no Tally ledger name), and offers the file to download. Nothing is read on open.
// No prompt/confirm/alert.

const $ = (id) => document.getElementById(id);
const ap = window.apTally ?? null;
let lang = document.documentElement.lang === 'ta' ? 'ta' : 'en';
const w = (k) => ap.words(lang, k);
let file = null;

function el(tag, words, cls) { const n = document.createElement(tag); if (words !== undefined) n.textContent = words; if (cls) n.className = cls; return n; }

function paint() {
  const ul = $('tap-rows'); ul.replaceChildren();
  $('tap-download').hidden = true;
  if (file === null) return;
  if (file.empty) { $('tap-status').textContent = w('tapEmpty'); $('tap-status').dataset.state = 'empty'; return; }
  const totals = file.controlTotals;
  $('tap-status').dataset.state = file.complete ? 'complete' : 'incomplete';
  $('tap-status').textContent = `${w('tapReady')} ${totals.voucherCount} ${w('tapVouchers')} · ${ap.rupees(totals.debitMinor)} — ${file.check.ok ? w('tapChecked') : `${w('tapNotChecked')} ${file.check.problems.join('; ')}`}`;
  for (const v of file.vouchers) { const li = el('li', v.entryId); li.dataset.voucher = v.entryId; ul.append(li); }
  if (!file.complete) {
    ul.append(el('li', w('tapIncomplete'), 'status err'));
    for (const e of file.exceptions) { const li = el('li', `⚠ ${e.entryId} · ${e.reason}${e.accountCodes ? ` · ${e.accountCodes.join(', ')}` : ''}`); li.dataset.keptOut = e.entryId; ul.append(li); }
  }
  $('tap-download').hidden = !(file.xml && file.check.ok);
}

async function show() {
  const out = await ap.session.vouchers($('tap-month').value);
  if (out.result !== 'ok') { file = null; paint(); $('tap-status').dataset.state = 'refused'; $('tap-status').textContent = ap.outcomeWords(lang, out, ''); return; }
  file = out.value; paint();
}

function paintWords() {
  for (const [id, k] of [['tap-h', 'tapH'], ['tap-lead', 'tapLead'], ['tap-month-l', 'tapPeriodL'], ['tap-read-text', 'tapShow'], ['tap-download-text', 'tapDownload']]) $(id).textContent = w(k);
  paint();
}

if (ap !== null && ap.session.may.read) {
  $('tap').hidden = false;
  paintWords();
  $('tap-read').addEventListener('click', () => { void show(); });
  $('tap-download').addEventListener('click', () => {
    if (file === null || !file.xml) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([file.xml], { type: 'application/xml' }));
    a.download = file.fileName;
    a.click();
  });
  // The page's one language toggle (tally-files.js flips it first); this section follows.
  $('lang').addEventListener('click', () => { lang = document.documentElement.lang === 'ta' ? 'ta' : 'en'; paintWords(); });
}
