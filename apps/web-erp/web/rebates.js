// Supplier rebates (M06-FR-03 · D03-FR-03 · OB-404 · QG-02) — the page over head office's own rebate record. The session
// (apps/web-erp/src/rebates-session.ts, in the bundle as window.rebates) does every call; this page lays out what it is
// told. Nothing is read on open; every write is a click. Every word has a Tamil twin; every button its icon.

const $ = (id) => document.getElementById(id);
const api = window.rebates ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, claim: false, receipt: false, setPeriod: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function button(words, act, iconName, quiet) {
  const b = document.createElement('button'); b.type = 'button'; b.dataset.act = act; if (quiet) b.className = 'quiet';
  const i = icon(iconName); if (i !== null) b.append(i);
  b.append(text('span', words)); return b;
}
function field(cls, placeholder, value) { const i = document.createElement('input'); i.className = cls; i.placeholder = placeholder; i.autocomplete = 'off'; if (value) i.value = value; i.setAttribute('aria-label', placeholder); return i; }
const say = (id, out) => { $(id).textContent = api.outcomeWords(lang, out); };
const rs = (minor) => api.rupees(minor);
let reg = null;
let doc = null;

function paintScheme(s) {
  const li = document.createElement('li'); li.dataset.scheme = s.schemeId;
  if (s.findings.length > 0) li.className = 'attention';
  li.append(text('strong', `${t('scheme')} ${s.schemeId} · ${t('supplier')} ${s.supplierId} · ${t('rate')} ${(s.rateBp / 100).toFixed(2)}% · ${s.startsOn} – ${s.endsOn}`));
  li.append(text('span', `${t('earned')} ${rs(s.accruedMinor)} · ${t('received')} ${rs(s.receivedMinor)} · ${t('outstanding')} ${rs(s.outstandingMinor)} · ${t('claimed')} ${rs(s.openClaimedMinor)} · ${t('claimable')} ${rs(s.claimableMinor)}`, 'figures'));
  for (const f of s.findings) li.append(text('span', `⚠ ${t(`f_${f}`)}`, 'finding'));
  li.append(text('span', `${t('accrualsH')}: ${s.accruals.length === 0 ? t('noAccruals') : s.accruals.map((a) => `${a.periodFrom ?? '?'} – ${a.periodTo ?? '?'} ${rs(a.accruedMinor)}`).join(' · ')}`, 'meta'));
  li.append(text('span', `${t('receiptsH')}: ${s.receipts.length === 0 ? t('noReceipts') : s.receipts.map((r) => `${r.receivedOn} ${rs(r.amountMinor)} (${r.reference}; ${t('matchedTo')} ${rs(r.matchedMinor)})`).join(' · ')}`, 'meta'));
  return li;
}
function paintClaim(c) {
  const li = document.createElement('li'); li.dataset.claim = c.claimId; li.dataset.state = c.state;
  if (c.overdue === true) li.className = 'attention';
  li.append(text('strong', `${t('claim')} ${c.claimId} · ${t('scheme')} ${c.schemeId} · ${t('supplier')} ${c.supplierId} · ${t('amount')} ${rs(c.amountMinor)} · ${t(`st_${c.state}`)}`));
  const when = c.sent === undefined ? '' : `${t('sentOn')} ${c.sent.sentOn} · ${t('dueOn')} ${c.dueOn ?? '—'} · `;
  li.append(text('span', `${when}${t('paid')} ${rs(c.matchedMinor)} · ${t('left')} ${rs(c.unansweredMinor)}`, 'figures'));
  if (c.overdue === true) li.append(text('span', `⚠ ${t('overdue')}`, 'finding overdue'));
  if (c.overdue === 'not_set') li.append(text('span', `○ ${t('dueNotSet')}`, 'finding'));
  if (c.withdrawn !== undefined) li.append(text('span', c.withdrawn.reason, 'meta'));
  const acts = document.createElement('div'); acts.className = 'acts';
  acts.append(button(t('print'), 'doc', 'file-text', true));
  if (may.claim && c.state === 'raised') {
    acts.append(button(t('ask'), 'ask', 'send'));
    acts.append(field('sent-on', t('sentDay'), reg?.today ?? ''));
    acts.append(button(t('send'), 'send', 'check'));
  }
  if (may.claim && (c.state === 'raised' || c.state === 'sent' || c.state === 'partly_answered')) {
    acts.append(field('withdraw-why', t('withdrawWhy')));
    acts.append(button(t('withdraw'), 'withdraw', 'x', true));
  }
  li.append(acts);
  li.append(text('p', '', 'status claim-status'));
  return li;
}
function paintUnmatched(r) {
  const li = document.createElement('li'); li.dataset.receipt = r.receiptId; li.className = 'attention';
  li.append(text('span', `${t('scheme')} ${r.schemeId} · ${r.receivedOn} · ${rs(r.amountMinor)} · ${t('left')} ${rs(r.leftToMatchMinor)}`));
  if (may.receipt) {
    const acts = document.createElement('div'); acts.className = 'acts';
    acts.append(field('match-claim', t('matchClaim')));
    acts.append(button(t('match'), 'match', 'check'));
    li.append(acts);
  }
  li.append(text('p', '', 'status claim-status'));
  return li;
}
function paintRegister() {
  for (const id of ['scheme-rows', 'claim-rows', 'unmatched-rows']) $(id).replaceChildren();
  $('r-period').textContent = ''; $('claims-h').textContent = ''; $('unmatched-h').textContent = '';
  if (reg === null) return;
  $('r-period').textContent = `${t('periodH')}: ${reg.answerPeriod.state === 'set' ? `${reg.answerPeriod.days} ${t('periodIs')}` : t('periodNotSet')}`;
  if (reg.schemes.length === 0) $('scheme-rows').append(text('li', `○ ${t('none')}`));
  for (const s of reg.schemes) $('scheme-rows').append(paintScheme(s));
  $('claims-h').textContent = t('claimsH');
  if (reg.claims.length === 0) $('claim-rows').append(text('li', `○ ${t('noClaims')}`));
  for (const c of reg.claims) $('claim-rows').append(paintClaim(c));
  if (reg.unmatchedReceipts.length > 0) {
    $('unmatched-h').textContent = t('unmatchedH');
    for (const r of reg.unmatchedReceipts) $('unmatched-rows').append(paintUnmatched(r));
  }
}
function paintDocument() {
  $('doc').hidden = doc === null;
  $('doc-body').replaceChildren();
  if (doc === null) return;
  const d = doc.document;
  $('doc-h').textContent = `${lang === 'ta' ? d.titleTa : d.title} ${d.claimNumber}`;
  $('doc-draft').hidden = doc.printable; $('doc-draft').textContent = t('docDraft');
  $('doc-print').hidden = !doc.printable;
  const lines = [
    `${t('docFrom')}: ${d.from === null ? t('docNotOnRecord') : `${d.from.name}${d.from.gstin ? ` (GSTIN ${d.from.gstin})` : ''}`}`,
    `${t('docTo')}: ${d.to.name ?? d.to.supplierId} (${d.to.supplierId})`,
    `${t('scheme')} ${d.scheme.schemeId}${d.scheme.rateBp === undefined ? '' : ` · ${(d.scheme.rateBp / 100).toFixed(2)}% · ${d.scheme.startsOn} – ${d.scheme.endsOn}`}`,
    ...d.earnedFrom.map((a) => `${t('earned')} ${a.periodFrom ?? '?'} – ${a.periodTo ?? '?'}: ${rs(a.accruedMinor)}`),
    `${t('amount')}: ${rs(d.amountClaimedMinor)}`,
    `${t('sentOn')}: ${d.sentOn ?? '—'} · ${t('dueOn')}: ${d.answerDueOn ?? (d.answerDue === 'not_set' ? t('dueNotSet') : '—')}`,
    `${t('paid')}: ${rs(d.paidMinor)} · ${t('left')}: ${rs(d.leftToPayMinor)}`,
    `${t('docWords')} ${rs(d.amountClaimedMinor)} — ${d.words}`,
  ];
  for (const l of lines) $('doc-body').append(text('p', l));
}
function paint() {
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['register-h', 'registerH'], ['r-show-text', 'show'], ['raise-h', 'raiseH'], ['c-scheme-l', 'schemeId'], ['c-amount-l', 'amountRs'], ['c-note-l', 'note'], ['c-raise-text', 'raise'],
    ['receipt-h', 'receiptH'], ['m-scheme-l', 'schemeId'], ['m-amount-l', 'amount'], ['m-on-l', 'receivedOn'], ['m-ref-l', 'reference'], ['m-claim-l', 'forClaim'], ['m-record-text', 'recordReceipt'],
    ['period-h', 'periodH'], ['p-days-l', 'days'], ['p-why-l', 'why'], ['p-set-text', 'setPeriod'], ['p-clear-text', 'clearPeriod'], ['doc-print-text', 'printNow']]) $(id).textContent = t(key);
  paintRegister(); paintDocument();
}
async function showRegister() {
  const out = await session.register();
  if (out.result !== 'ok') { reg = null; say('r-status', out); paintRegister(); return; }
  reg = out.value; $('r-status').textContent = ''; paintRegister();
}
async function onClaimClick(e) {
  const b = e.target.closest('button[data-act]'); if (b === null) return;
  const li = b.closest('li'); const status = li.querySelector('.claim-status');
  if (li.dataset.receipt !== undefined) {
    const out = await session.match(li.querySelector('input.match-claim').value, li.dataset.receipt);
    status.textContent = api.outcomeWords(lang, out);
    if (out.result === 'ok') await showRegister();
    return;
  }
  const c = reg?.claims.find((x) => x.claimId === li.dataset.claim); if (c === undefined) return;
  const act = b.dataset.act;
  if (act === 'doc') {
    const out = await session.document(c.claimId);
    if (out.result !== 'ok') { status.textContent = api.outcomeWords(lang, out); return; }
    doc = out.value; paintDocument(); $('doc').scrollIntoView?.({ block: 'start' });
    return;
  }
  const out = act === 'ask' ? await session.askApproval(c)
    : act === 'send' ? await session.send(c, li.querySelector('input.sent-on').value)
    : await session.withdraw(c.claimId, li.querySelector('input.withdraw-why').value);
  if (out.result === 'ok' && act !== 'ask') { await showRegister(); const again = $('claim-rows').querySelector(`li[data-claim="${CSS.escape(c.claimId)}"] .claim-status`); if (again !== null) again.textContent = api.outcomeWords(lang, out); return; }
  status.textContent = api.outcomeWords(lang, out);
}

for (const [id, name] of [['r-show', 'search'], ['c-raise', 'list-plus'], ['m-record', 'banknote'], ['p-set', 'check'], ['doc-print', 'file-text']]) { const i = icon(name); if (i !== null) $(id).prepend(i); }
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.read) $('page-status').textContent = t('cannotRead');
else {
  $('register').hidden = false;
  $('r-show').addEventListener('click', () => { void showRegister(); });
  $('claim-rows').addEventListener('click', (e) => { void onClaimClick(e); });
  $('unmatched-rows').addEventListener('click', (e) => { void onClaimClick(e); });
  $('doc-print').addEventListener('click', () => { window.print(); });
  if (may.claim) {
    $('raise').hidden = false;
    $('c-raise').addEventListener('click', async () => {
      const out = await session.raise({ schemeId: $('c-scheme').value, amountRupees: $('c-amount').value, note: $('c-note').value });
      say('c-status', out);
      if (out.result === 'ok') await showRegister();
    });
  }
  if (may.receipt) {
    $('receipt').hidden = false;
    $('m-record').addEventListener('click', async () => {
      const out = await session.receipt({ schemeId: $('m-scheme').value, amountRupees: $('m-amount').value, receivedOn: $('m-on').value, reference: $('m-ref').value, claimId: $('m-claim').value });
      say('m-status', out);
      if (out.result === 'ok') await showRegister();
    });
  }
  if (may.setPeriod) {
    $('period').hidden = false;
    $('p-set').addEventListener('click', async () => { const out = await session.setPeriod($('p-days').value); say('p-status', out); if (out.result === 'ok') await showRegister(); });
    $('p-clear').addEventListener('click', async () => { const out = await session.clearPeriod($('p-why').value); say('p-status', out); if (out.result === 'ok') await showRegister(); });
  }
}
