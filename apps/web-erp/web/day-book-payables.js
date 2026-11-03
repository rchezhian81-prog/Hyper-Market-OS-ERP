// Day book — supplier bills in the books (W4 · WF-05 · M23-FR-01 · P-08 · hard rule #2). Every rule lives in the TESTED
// session (apps/web-erp/src/supplier-bills-to-the-books-session.ts, window.payablesBooks). This file draws, on a click, each
// supplier-bill journal head office holds, each one not in the books with why, and per supplier what the register owes
// beside what the books carry; "Put supplier bills in the books" asks head office to post from its own registers through
// the accountant's rules — nothing is typed. Nothing is read on open. No prompt/confirm/alert.

const $ = (id) => document.getElementById(id);
const pb = window.payablesBooks ?? null;
let lang = document.documentElement.lang === 'ta' ? 'ta' : 'en';
const w = (k) => pb.words(lang, k);
const money = (minor) => pb.rupees(minor);
let read = null; let lastPost = null;

function el(tag, words, cls) { const n = document.createElement(tag); if (words !== undefined) n.textContent = words; if (cls) n.className = cls; return n; }

function paint() {
  const sups = $('ap-suppliers'); const js = $('ap-journals'); const ex = $('ap-exceptions');
  sups.replaceChildren(); js.replaceChildren(); ex.replaceChildren();
  if (lastPost !== null) $('ap-status').textContent = lastPost.journals.length === 0 ? w('apNothing') : `${w('apPosted')} ${lastPost.journals.map((j) => `${w(`kind_${j.kind}`)} ${j.sourceId}`).join(' · ')}`;
  if (read === null) return;
  for (const s of read.reconciliation.suppliers ?? []) {
    const li = el('li', undefined, 'row'); li.dataset.supplier = s.supplierId; li.dataset.agrees = String(s.agrees);
    li.append(el('strong', `${s.supplierId} — ${w('apRegister')} ${money(s.registerOwedMinor)} · ${w('apBooks')} ${money(s.ledgerOwedMinor)} — ${w(s.agrees ? 'apAgrees' : 'apDiffers')}`));
    sups.append(li);
  }
  if (read.journals.length === 0) js.append(el('li', w('apJournalsNone'), 'muted'));
  for (const j of read.journals) {
    const li = el('li', undefined, 'row'); li.dataset.journal = j.entryId; li.dataset.kind = j.kind;
    const debit = j.lines.reduce((n, l) => n + l.debitMinor, 0);
    li.append(el('strong', `${w(`kind_${j.kind}`)} · ${j.sourceId} · ${j.supplierId} · ${money(debit)}`));
    li.append(el('div', `${j.documentDate} · ${j.period} · ${j.postedBy}`, 'facts'));
    li.append(el('div', j.lines.map((l) => `${l.accountCode} ${l.debitMinor > 0 ? `${w('dr')} ${money(l.debitMinor)}` : `${w('cr')} ${money(l.creditMinor)}`}`).join(' · '), 'lines'));
    js.append(li);
  }
  const open = read.exceptions.filter((e) => e.state === 'open');
  if (open.length > 0) ex.append(el('li', w('apExceptions'), 'muted'));
  for (const e of open) { const li = el('li', `⚠ ${w(`kind_${e.kind}`)} · ${e.reason}${e.detail ? ` — ${e.detail}` : ''}`, 'row'); li.dataset.exception = e.exceptionId; ex.append(li); }
}

async function show() {
  const out = await pb.session.read();
  if (out.result !== 'ok') { $('ap-status').textContent = pb.outcomeWords(lang, out, ''); return; }
  read = out.value; paint();
}

function paintWords() {
  for (const [id, k] of [['ap-heading', 'apH'], ['ap-lead', 'apLead'], ['ap-show', 'apShow'], ['ap-post', 'apPost']]) $(id).textContent = w(k);
  paint();
}

if (pb !== null && pb.session.may.read) {
  $('ap').hidden = false;
  $('ap-post').hidden = !pb.session.may.post;
  paintWords();
  $('ap-show').addEventListener('click', () => { lastPost = null; void show(); });
  $('ap-post').addEventListener('click', async () => {
    const out = await pb.session.post();
    if (out.result !== 'ok') { $('ap-status').textContent = pb.outcomeWords(lang, out, ''); return; }
    lastPost = out.value; await show();
  });
  // The page's one language toggle (day-book.js flips it first); this section follows.
  $('lang').addEventListener('click', () => { lang = document.documentElement.lang === 'ta' ? 'ta' : 'en'; paintWords(); });
}
