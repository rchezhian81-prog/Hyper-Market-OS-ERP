// Input tax credit through GSTR-2B — the accountant's review (R3 · A17 · OB-145 "A"). The accountant uploads the month's
// GSTR-2B file as downloaded from the GST portal; head office reads it, matches every line against the shop's own
// three-way-matched bills (supplier GSTIN + invoice number + date + tax) and this page shows exactly what it answered:
// each line's match and its person's action, the bills the 2B does not carry, the lines the books do not, and the credit
// that may be claimed — "not reconciled" with the reason while any line awaits a person, never a zero. Each line is
// accepted, rejected or kept pending by the person signed in; a reject or a pending needs a reason. Head office decides
// whether an action stands (only a matched line may be accepted). No prompt/confirm/alert; nothing on a timer.

const el = (id) => document.getElementById(id);
let lang = document.documentElement.lang === 'ta' ? 'ta' : 'en';

const WORDS = {
  en: {
    title: 'Input tax credit', langName: 'தமிழ்',
    lead: 'Upload the month\'s GSTR-2B from the GST portal. Every line is matched with the bills in the books; each one must be accepted, rejected or kept pending by a person. Only accepted lines are claimed in GSTR-3B.',
    month: 'Month', show: 'Show', file: 'GSTR-2B file from the GST portal (JSON)', upload: 'Upload',
    linesHeading: 'Lines in the GSTR-2B', missingHeading: 'Bills in the books missing from the GSTR-2B',
    notUploaded: 'No GSTR-2B has been uploaded for this month yet.',
    claimable: 'Credit to claim', notReconciled: 'Not reconciled', reconciled: 'Reconciled',
    awaiting: 'Awaiting a person', accepted: 'Accepted', rejected: 'Rejected', pending: 'Pending', reversed: 'Reversed',
    matched: 'Matches the books', differs: 'Differs from the books', not_in_books: 'No bill in the books', in_an_earlier_2b: 'Already in an earlier GSTR-2B',
    differsOn: 'differs on', date: 'date', igst: 'IGST', cgst: 'CGST', sgst: 'SGST', cess: 'cess',
    supplier: 'Supplier', invoiceNo: 'Invoice', invoiceDate: 'Date', tax: 'Tax', by: 'By', reasonLabel: 'Reason',
    accept: 'Accept', reject: 'Reject', keepPending: 'Keep pending',
    needReason: 'Write the reason first — a reject or a pending needs one.',
    done: 'Recorded', refused: 'Not recorded', uploaded: 'Uploaded', alreadyUploaded: 'This file was already uploaded',
    noFile: 'Choose the GSTR-2B file first.', notJson: 'That file is not a GSTR-2B JSON file.', noMonth: 'Choose the month first.',
    unreachable: 'Head office could not be reached. Nothing was recorded — try again.',
    cannotRead: 'The ITC review could not be read from head office. Nothing here is current.',
    missingNone: 'Every bill in the books for this month is in the GSTR-2B.',
    lines: 'line(s)',
  },
  ta: {
    title: 'உள்ளீட்டு வரி வரவு', langName: 'English',
    lead: 'GST இணையதளத்திலிருந்து மாதத்தின் GSTR-2B கோப்பைப் பதிவேற்றுங்கள். ஒவ்வொரு வரியும் கணக்குகளில் உள்ள பில்களுடன் ஒப்பிடப்படும்; ஒவ்வொன்றையும் ஒருவர் ஏற்க, நிராகரிக்க அல்லது நிலுவையில் வைக்க வேண்டும். ஏற்கப்பட்ட வரிகள் மட்டுமே GSTR-3B-ல் கோரப்படும்.',
    month: 'மாதம்', show: 'காட்டு', file: 'GST இணையதளத்தின் GSTR-2B கோப்பு (JSON)', upload: 'பதிவேற்று',
    linesHeading: 'GSTR-2B-ல் உள்ள வரிகள்', missingHeading: 'GSTR-2B-ல் இல்லாத கணக்குப் பில்கள்',
    notUploaded: 'இந்த மாதத்திற்கு இன்னும் GSTR-2B பதிவேற்றப்படவில்லை.',
    claimable: 'கோர வேண்டிய வரவு', notReconciled: 'சரிபார்க்கப்படவில்லை', reconciled: 'சரிபார்க்கப்பட்டது',
    awaiting: 'ஒருவரின் முடிவுக்குக் காத்திருக்கிறது', accepted: 'ஏற்கப்பட்டது', rejected: 'நிராகரிக்கப்பட்டது', pending: 'நிலுவை', reversed: 'திருப்பப்பட்டது',
    matched: 'கணக்குகளுடன் பொருந்துகிறது', differs: 'கணக்குகளிலிருந்து வேறுபடுகிறது', not_in_books: 'கணக்குகளில் பில் இல்லை', in_an_earlier_2b: 'முந்தைய GSTR-2B-ல் ஏற்கனவே உள்ளது',
    differsOn: 'வேறுபாடு', date: 'தேதி', igst: 'IGST', cgst: 'CGST', sgst: 'SGST', cess: 'செஸ்',
    supplier: 'விநியோகஸ்தர்', invoiceNo: 'பில்', invoiceDate: 'தேதி', tax: 'வரி', by: 'செய்தவர்', reasonLabel: 'காரணம்',
    accept: 'ஏற்கவும்', reject: 'நிராகரிக்கவும்', keepPending: 'நிலுவையில் வைக்கவும்',
    needReason: 'முதலில் காரணத்தை எழுதுங்கள் — நிராகரிக்கவோ நிலுவையில் வைக்கவோ காரணம் தேவை.',
    done: 'பதிவு செய்யப்பட்டது', refused: 'பதிவு செய்யப்படவில்லை', uploaded: 'பதிவேற்றப்பட்டது', alreadyUploaded: 'இந்தக் கோப்பு ஏற்கனவே பதிவேற்றப்பட்டது',
    noFile: 'முதலில் GSTR-2B கோப்பைத் தேர்ந்தெடுங்கள்.', notJson: 'அந்தக் கோப்பு GSTR-2B JSON கோப்பு அல்ல.', noMonth: 'முதலில் மாதத்தைத் தேர்ந்தெடுங்கள்.',
    unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை. எதுவும் பதிவு செய்யப்படவில்லை — மீண்டும் முயலவும்.',
    cannotRead: 'ITC மதிப்பாய்வைத் தலைமை அலுவலகத்திலிருந்து படிக்க முடியவில்லை. இங்குள்ளவை தற்போதையவை அல்ல.',
    missingNone: 'இந்த மாதத்தின் ஒவ்வொரு கணக்குப் பில்லும் GSTR-2B-ல் உள்ளது.',
    lines: 'வரி(கள்)',
  },
};
const t = (key) => WORDS[lang]?.[key] ?? WORDS.en[key] ?? key;
const rupees = (minor) => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const taxOf = (x) => (x.igstMinor ?? 0) + (x.cgstMinor ?? 0) + (x.sgstMinor ?? 0) + (x.cessMinor ?? 0);
const STATE_TONE = { accepted: 'ok', rejected: 'idle', pending: 'degraded', awaiting_a_person: 'error' };
const STATE_ICON = { accepted: '✓', rejected: '✕', pending: '⏸', awaiting_a_person: '⚠' };
const STATE_WORD = { accepted: 'accepted', rejected: 'rejected', pending: 'pending', awaiting_a_person: 'awaiting' };

let review = null;
let readFailed = false;
/** One key per line while head office's answer is lost — a retry is then the same action, never two. */
const pendingKeys = new Map();

function period() { return el('period').value.trim(); }

function tell(ok, text) {
  const r = el('result');
  r.hidden = false;
  r.className = `result tone-${ok ? 'ok' : 'error'}`;
  r.textContent = text;
}

function field(labelKey, control) {
  const label = document.createElement('label');
  const span = document.createElement('span'); span.textContent = t(labelKey);
  label.append(span, control);
  return label;
}

function fact(facts, text) { const s = document.createElement('span'); s.textContent = text; facts.append(s); }

function lineRow(l) {
  const li = document.createElement('li');
  li.className = `row tone-${STATE_TONE[l.state] ?? 'idle'}`;
  li.dataset.line = l.lineId; li.dataset.invoice = l.invoiceNo; li.dataset.match = l.match; li.dataset.state = l.state;
  const head = document.createElement('div'); head.className = 'head';
  const headline = document.createElement('span'); headline.className = 'headline';
  headline.textContent = `${l.supplierName ?? l.supplierGstin} — ${t('invoiceNo')} ${l.invoiceNo}`;
  const state = document.createElement('span'); state.className = 'state';
  const icon = document.createElement('span'); icon.setAttribute('aria-hidden', 'true'); icon.textContent = STATE_ICON[l.state] ?? '•';
  const word = document.createElement('span'); word.className = 'word'; word.textContent = t(STATE_WORD[l.state] ?? l.state);
  state.append(icon, word);
  head.append(headline, state);
  const facts = document.createElement('div'); facts.className = 'facts';
  const match = document.createElement('span'); match.className = 'match';
  match.textContent = l.match === 'differs' ? `${t('differs')} — ${t('differsOn')} ${l.differences.map((d) => t(d)).join(', ')}` : t(l.match);
  facts.append(match);
  fact(facts, `${t('supplier')}: ${l.supplierGstin}`);
  fact(facts, `${t('invoiceDate')}: ${l.invoiceDate}`);
  fact(facts, `${t('tax')}: ${rupees(taxOf(l))}`);
  if (l.actedBy) fact(facts, `${t('by')}: ${l.actedBy}${l.reason ? ` — ${l.reason}` : ''}`);
  li.append(head, facts, actionForm(l));
  return li;
}

function actionForm(l) {
  const form = document.createElement('form');
  form.className = 'decide';
  const reason = document.createElement('input'); reason.className = 'reason'; reason.name = 'reason'; reason.autocomplete = 'off';
  const button = (cls, key, action) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = `act ${cls}`; b.textContent = t(key);
    b.addEventListener('click', () => { void decide(l, action, reason.value.trim(), form); });
    return b;
  };
  const accept = button('accept', 'accept', 'accept');
  // Only a matched line may be accepted — head office refuses it otherwise; the page does not offer what would be refused.
  accept.disabled = l.match !== 'matched';
  form.append(field('reasonLabel', reason), accept, button('quiet reject', 'reject', 'reject'), button('quiet keep', 'keepPending', 'pending'));
  return form;
}

function missingRow(b) {
  const li = document.createElement('li');
  li.className = 'row tone-degraded';
  li.dataset.invoice = b.supplierInvoiceNo ?? b.invoiceId;
  const head = document.createElement('div'); head.className = 'head';
  const headline = document.createElement('span'); headline.className = 'headline'; headline.textContent = `${t('invoiceNo')} ${b.supplierInvoiceNo} (${b.invoiceId})`;
  head.append(headline);
  const facts = document.createElement('div'); facts.className = 'facts';
  fact(facts, `${t('supplier')}: ${b.supplierGstin}`);
  fact(facts, `${t('invoiceDate')}: ${b.supplierInvoiceDate}`);
  fact(facts, `${t('tax')}: ${rupees(taxOf(b))}`);
  li.append(head, facts);
  return li;
}

function panel(key, value) {
  const p = document.createElement('div'); p.className = 'panel'; p.dataset.panel = key;
  const k = document.createElement('span'); k.className = 'k'; k.textContent = t(key);
  const v = document.createElement('span'); v.className = 'v'; v.textContent = value;
  p.append(k, v);
  return p;
}

function paint() {
  document.title = `SRE ${t('title')}`;
  el('who').firstChild.textContent = `${t('title')} `;
  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('lang').textContent = t('langName');
  el('whoami').textContent = window.itcReviewData?.userId ?? '';
  el('l-period').textContent = t('month'); el('show').textContent = t('show');
  el('l-file').textContent = t('file'); el('send-file').textContent = t('upload');
  const state = el('state');
  state.hidden = !readFailed && (review === null || review.imported);
  state.textContent = readFailed ? t('cannotRead') : review !== null && !review.imported ? t('notUploaded') : '';
  const claim = el('claim');
  if (review === null || readFailed) { claim.textContent = ''; claim.className = 'claim'; }
  else if (review.claim.status === 'reconciled') { claim.className = 'claim'; claim.textContent = `${t('reconciled')} — ${t('claimable')}: ${rupees(taxOf(review.claim))}`; }
  else { claim.className = 'claim tone-error'; claim.textContent = `${t('notReconciled')}: ${review.claim.reason}`; }
  const totals = review?.totals;
  el('panels').replaceChildren(...(totals === undefined || readFailed ? [] : [
    panel('accepted', rupees(taxOf(totals.accepted))), panel('pending', rupees(taxOf(totals.pending))),
    panel('rejected', rupees(taxOf(totals.rejected))), panel('awaiting', `${totals.awaitingCount} ${t('lines')}`),
    panel('reversed', rupees(taxOf(totals.reversed))),
  ]));
  const lines = readFailed ? [] : review?.lines ?? [];
  el('lines-heading').hidden = lines.length === 0; el('lines-heading').textContent = t('linesHeading');
  el('rows').replaceChildren(...lines.map(lineRow));
  const missing = readFailed ? [] : review?.exceptions.missingFrom2b ?? [];
  el('missing-heading').hidden = review === null || readFailed; el('missing-heading').textContent = missing.length === 0 ? t('missingNone') : t('missingHeading');
  el('missing-rows').replaceChildren(...missing.map(missingRow));
}

async function refresh() {
  const p = period();
  if (p === '') { review = null; paint(); return; }
  try {
    const res = await fetch(`/v1/finance/itc/${encodeURIComponent(p)}`, { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    review = await res.json();
    readFailed = false;
  } catch {
    review = null; readFailed = true;
  }
  paint();
}

async function post(path, body, key) {
  const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body) });
  return { ok: res.ok, answer: await res.json().catch(() => ({})), status: res.status };
}
const refusal = (out) => `${t('refused')}: ${out.answer?.error?.whatHappened ?? out.status} ${out.answer?.error?.nextSafeAction ?? ''}`.trim();
const newKey = (what) => `itc-${what}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

async function decide(line, action, reason, form) {
  if (action !== 'accept' && reason === '') { tell(false, t('needReason')); return; }
  const slot = `${line.lineId}:${action}:${reason}`;
  const key = pendingKeys.get(slot) ?? newKey(line.lineId);
  pendingKeys.set(slot, key);
  for (const b of form.querySelectorAll('button')) b.disabled = true;
  try {
    const out = await post(`/v1/finance/itc/${encodeURIComponent(period())}/lines/${encodeURIComponent(line.lineId)}/action`, { action, ...(reason === '' ? {} : { reason }) }, key);
    pendingKeys.delete(slot);
    if (out.ok) tell(true, `${t('done')}: ${line.invoiceNo} — ${t(STATE_WORD[out.answer.state] ?? out.answer.state)}`);
    else tell(false, refusal(out));
  } catch {
    tell(false, t('unreachable'));
  }
  await refresh();
}

async function upload(event) {
  event.preventDefault();
  const p = period();
  if (p === '') { tell(false, t('noMonth')); return; }
  const file = el('file').files?.[0];
  if (file === undefined) { tell(false, t('noFile')); return; }
  let statement;
  try { statement = JSON.parse(await file.text()); } catch { tell(false, t('notJson')); return; }
  try {
    const out = await post(`/v1/finance/itc/${encodeURIComponent(p)}/statement`, { statement }, newKey(`upload-${p}`));
    if (out.ok) tell(true, `${out.answer.alreadyUploaded ? t('alreadyUploaded') : t('uploaded')}: ${p} — ${out.answer.lines} ${t('lines')}`);
    else tell(false, refusal(out));
  } catch {
    tell(false, t('unreachable'));
  }
  await refresh();
}

el('ask').addEventListener('submit', (event) => { event.preventDefault(); void refresh(); });
el('upload').addEventListener('submit', (event) => { void upload(event); });
el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
const asked = new URLSearchParams(location.search).get('period');
if (asked !== null && /^\d{4}-\d{2}$/.test(asked)) el('period').value = asked;
paint();
void refresh();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
