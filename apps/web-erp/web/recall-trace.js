// Recalls and trace — the view (M10-FR-03 · M10-FR-04 · WF-09 · P-07 · OB-297 · OB-328 · OB-329). A thin client over
// head office: it starts or opens a recall, traces forward and backward, reads the recall's call list and lets the owner
// switch recall SMS. Head office decides everything — who may, what is blocked, who is on the list, who may be messaged —
// and this page shows exactly what it answered. Each write keeps its idempotency key until head office answers, so a
// retry after a lost answer is the same request. No prompt/confirm/alert; nothing on a timer; nothing written on open.

const el = (id) => document.getElementById(id);
let lang = document.documentElement.lang === 'ta' ? 'ta' : 'en';
const DATA = window.recallTraceData ?? {};
const PERMS = Array.isArray(DATA.permissions) ? DATA.permissions : null; // null: not told — head office decides

const WORDS = {
  en: {
    title: 'Recalls and trace', langName: 'தமிழ்',
    lead: 'Start a recall and see what head office did at once: the tills stop selling it, the owners are alerted, open orders are listed. Trace a batch forward to the customers, or a bill or a customer back to the lots and suppliers. Call every customer the shop knows bought it.',
    tabRecalls: 'Recalls', tabTrace: 'Trace', tabCalls: 'Call list', tabMessages: 'SMS notices',
    recallsH: 'Start or open a recall', batchLabel: 'Batch (as printed)', reasonLabel: 'Why (the supplier\'s notice, the inspector\'s order)',
    start: 'Start the recall', open: 'Open this recall', listH: 'All recalls — open first', noneYet: 'No recall has been started.',
    detailH: 'Recall of batch', statusOpen: 'Open', statusClosed: 'Closed', startedBy: 'Started by', since: 'Since', closedAt: 'Closed',
    evidenceLabel: 'Closure evidence (where the contact log and disposal are recorded)', close: 'Close with evidence',
    tillsPublished: 'The tills\' catalogue v{v} now refuses it, offline too.', tillsAlready: 'The tills already refuse it.',
    tillsNot: 'NOT yet blocked at the tills: {d}', ownersTold: 'The owners were alerted ({n}). Acknowledge within 15 minutes.',
    ownersNot: 'The owners were not alerted: {d}', openOrders: 'Purchase orders still open for it: {list}.', noOrders: 'No purchase order is open for it.',
    alreadyOpen: 'This batch is already under recall — nothing new was started.', started: 'Recall started', closedOk: 'Recall closed with evidence.',
    refused: 'Not done', unreachable: 'Head office could not be reached. Nothing was changed — try again.', cannotRead: 'Head office could not be read. Nothing here is current.',
    needBatch: 'Key the batch first.', needReason: 'Give the reason first.', needEvidence: 'Give the closure evidence first.',
    traceH: 'Trace a batch, a bill or a customer', kindLabel: 'Trace from', kindBatch: 'A batch → who bought it (forward)', kindSale: 'A bill → lots and suppliers (backward)', kindCustomer: 'A customer → lots and suppliers (backward)',
    refLabel: 'Batch, bill (sale id) or customer reference', run: 'Trace', gapsH: 'What the shop cannot say (gaps)',
    colHop: 'Step', colDate: 'Date', colFrom: 'From', colTo: 'To', colRef: 'Record', colQty: 'Quantity',
    colBatch: 'Lot', colDepth: 'Reached through', colReceipts: 'Came on', colSupplier: 'Supplier',
    traceRows: '{n} step(s) on the road.', traceComplete: 'Nothing is missing.', traceGaps: '{n} gap(s) — read them below.',
    backSummary: '{s} bill(s), {b} lot(s), {p} supplier(s).', notKnown: 'not known',
    callsH: 'Recall call list', loadCalls: 'Show the call list', callsBatch: 'Recalled batch',
    callsSummary: '{n} customer(s) to call; {s} also said yes to service messages by SMS; {a} sale(s) named nobody (put the notice at the entrance).',
    nameNotOnRecord: 'Name not on record — ask at the desk', phone: 'Phone ends', noPhone: 'No phone on record', bought: 'Bought', lot: 'lot', madeFrom: 'made from lot', estimate: 'estimate',
    serviceYes: 'Service messages: yes by {c}', serviceNone: 'Service messages: no yes on record',
    said_no_to_promotions: 'said no to promotions — safety call only',
    said_no_to_service_messages: 'said no to service messages — safety call only; no message is sent',
    no_answer_on_service_messages: 'no answer on service messages — call only; no message is sent',
    messagesH: 'Recall SMS notices', switchOn: 'Switch recall SMS on', switchOff: 'Switch recall SMS off', switchReason: 'Why (kept on the record)',
    stateOn: 'Recall SMS is ON (by {by}: {why}).', stateOff: 'Recall SMS is OFF. Call the customers on the list.', noProvider: 'No SMS provider is connected, so nothing can be sent.',
    sendH: 'Send the recall SMS', textLabel: 'The message (10 to 480 characters)', send: 'Send to customers who said yes',
    sentSay: 'Sent: {s}. Failed: {f}. Already told: {a}. Without SMS consent (call them): {n}.', switched: 'Recorded.',
  },
  ta: {
    title: 'திரும்பப்பெறலும் தடமறிதலும்', langName: 'English',
    lead: 'திரும்பப்பெறலைத் தொடங்கி, தலைமை அலுவலகம் உடனே செய்ததைப் பாருங்கள்: பில் கவுண்டர்கள் விற்பதை நிறுத்தும், உரிமையாளர்களுக்கு எச்சரிக்கை செல்லும், திறந்த ஆர்டர்கள் பட்டியலிடப்படும். ஒரு தொகுதியை வாடிக்கையாளர்கள் வரை முன்னோக்கியும், ஒரு பில் அல்லது வாடிக்கையாளரை தொகுதிகள் மற்றும் சப்ளையர்கள் வரை பின்னோக்கியும் தடமறியுங்கள். வாங்கியதாகத் தெரிந்த ஒவ்வொரு வாடிக்கையாளரையும் அழையுங்கள்.',
    tabRecalls: 'திரும்பப்பெறல்கள்', tabTrace: 'தடமறிதல்', tabCalls: 'அழைப்புப் பட்டியல்', tabMessages: 'SMS அறிவிப்புகள்',
    recallsH: 'திரும்பப்பெறலைத் தொடங்கு அல்லது திற', batchLabel: 'தொகுதி (அச்சிட்டபடி)', reasonLabel: 'ஏன் (சப்ளையர் அறிவிப்பு, ஆய்வாளர் உத்தரவு)',
    start: 'திரும்பப்பெறலைத் தொடங்கு', open: 'இந்தத் திரும்பப்பெறலைத் திற', listH: 'எல்லாத் திரும்பப்பெறல்களும் — திறந்தவை முதலில்', noneYet: 'எந்தத் திரும்பப்பெறலும் தொடங்கப்படவில்லை.',
    detailH: 'தொகுதியின் திரும்பப்பெறல்', statusOpen: 'திறந்துள்ளது', statusClosed: 'மூடப்பட்டது', startedBy: 'தொடங்கியவர்', since: 'முதல்', closedAt: 'மூடப்பட்டது',
    evidenceLabel: 'மூடுவதற்கான சான்று (தொடர்புப் பதிவும் அப்புறப்படுத்தலும் எங்கே பதிவாகியுள்ளன)', close: 'சான்றுடன் மூடு',
    tillsPublished: 'பில் கவுண்டர்களின் பட்டியல் v{v} இப்போது இதை மறுக்கிறது, இணையம் இல்லாவிட்டாலும்.', tillsAlready: 'பில் கவுண்டர்கள் ஏற்கனவே இதை மறுக்கின்றன.',
    tillsNot: 'பில் கவுண்டர்களில் இன்னும் தடுக்கப்படவில்லை: {d}', ownersTold: 'உரிமையாளர்களுக்கு எச்சரிக்கை சென்றது ({n}). 15 நிமிடங்களுக்குள் ஒப்புக்கொள்ளவும்.',
    ownersNot: 'உரிமையாளர்களுக்கு எச்சரிக்கை செல்லவில்லை: {d}', openOrders: 'இதற்கு இன்னும் திறந்துள்ள கொள்முதல் ஆர்டர்கள்: {list}.', noOrders: 'இதற்கு எந்தக் கொள்முதல் ஆர்டரும் திறந்து இல்லை.',
    alreadyOpen: 'இந்தத் தொகுதி ஏற்கனவே திரும்பப்பெறலில் உள்ளது — புதிதாக எதுவும் தொடங்கப்படவில்லை.', started: 'திரும்பப்பெறல் தொடங்கப்பட்டது', closedOk: 'திரும்பப்பெறல் சான்றுடன் மூடப்பட்டது.',
    refused: 'செய்யப்படவில்லை', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை. எதுவும் மாறவில்லை — மீண்டும் முயலவும்.', cannotRead: 'தலைமை அலுவலகத்திலிருந்து படிக்க முடியவில்லை. இங்குள்ளவை தற்போதையவை அல்ல.',
    needBatch: 'முதலில் தொகுதியை உள்ளிடவும்.', needReason: 'முதலில் காரணத்தைக் கொடுக்கவும்.', needEvidence: 'முதலில் மூடுவதற்கான சான்றைக் கொடுக்கவும்.',
    traceH: 'ஒரு தொகுதி, பில் அல்லது வாடிக்கையாளரைத் தடமறி', kindLabel: 'எங்கிருந்து தடமறிவது', kindBatch: 'ஒரு தொகுதி → யார் வாங்கினார்கள் (முன்னோக்கி)', kindSale: 'ஒரு பில் → தொகுதிகளும் சப்ளையர்களும் (பின்னோக்கி)', kindCustomer: 'ஒரு வாடிக்கையாளர் → தொகுதிகளும் சப்ளையர்களும் (பின்னோக்கி)',
    refLabel: 'தொகுதி, பில் (விற்பனை எண்) அல்லது வாடிக்கையாளர் குறிப்பு', run: 'தடமறி', gapsH: 'கடைக்குத் தெரியாதவை (இடைவெளிகள்)',
    colHop: 'படி', colDate: 'தேதி', colFrom: 'இருந்து', colTo: 'வரை', colRef: 'பதிவு', colQty: 'அளவு',
    colBatch: 'தொகுதி', colDepth: 'எவ்வழியாக', colReceipts: 'வந்த பதிவு', colSupplier: 'சப்ளையர்',
    traceRows: 'பாதையில் {n} படி(கள்).', traceComplete: 'எதுவும் விடுபடவில்லை.', traceGaps: '{n} இடைவெளி(கள்) — கீழே படிக்கவும்.',
    backSummary: '{s} பில்(கள்), {b} தொகுதி(கள்), {p} சப்ளையர்(கள்).', notKnown: 'தெரியவில்லை',
    callsH: 'திரும்பப்பெறல் அழைப்புப் பட்டியல்', loadCalls: 'அழைப்புப் பட்டியலைக் காட்டு', callsBatch: 'திரும்பப்பெறப்பட்ட தொகுதி',
    callsSummary: 'அழைக்க வேண்டியவர்கள் {n}; அவர்களில் {s} பேர் SMS மூலம் சேவைச் செய்திகளுக்கு ஒப்புதல் அளித்தனர்; {a} விற்பனைகளில் யாருடைய பெயரும் இல்லை (நுழைவாயிலில் அறிவிப்பை வைக்கவும்).',
    nameNotOnRecord: 'பெயர் பதிவில் இல்லை — மேசையில் கேட்கவும்', phone: 'கைபேசி கடைசி இலக்கங்கள்', noPhone: 'கைபேசி எண் பதிவில் இல்லை', bought: 'வாங்கியது', lot: 'தொகுதி', madeFrom: 'இதிலிருந்து தயாரிக்கப்பட்டது', estimate: 'மதிப்பீடு',
    serviceYes: 'சேவைச் செய்திகள்: {c} மூலம் ஒப்புதல்', serviceNone: 'சேவைச் செய்திகள்: ஒப்புதல் பதிவில் இல்லை',
    said_no_to_promotions: 'விளம்பரங்கள் வேண்டாம் என்றார் — பாதுகாப்பு அழைப்பு மட்டும்',
    said_no_to_service_messages: 'சேவைச் செய்திகள் வேண்டாம் என்றார் — பாதுகாப்பு அழைப்பு மட்டும்; செய்தி அனுப்பப்படாது',
    no_answer_on_service_messages: 'சேவைச் செய்திகள் பற்றிப் பதில் இல்லை — அழைப்பு மட்டும்; செய்தி அனுப்பப்படாது',
    messagesH: 'திரும்பப்பெறல் SMS அறிவிப்புகள்', switchOn: 'திரும்பப்பெறல் SMS-ஐ இயக்கு', switchOff: 'திரும்பப்பெறல் SMS-ஐ நிறுத்து', switchReason: 'ஏன் (பதிவில் வைக்கப்படும்)',
    stateOn: 'திரும்பப்பெறல் SMS இயக்கத்தில் உள்ளது ({by}: {why}).', stateOff: 'திரும்பப்பெறல் SMS நிறுத்தப்பட்டுள்ளது. பட்டியலில் உள்ள வாடிக்கையாளர்களை அழைக்கவும்.', noProvider: 'SMS வழங்குநர் இணைக்கப்படவில்லை, எனவே எதையும் அனுப்ப முடியாது.',
    sendH: 'திரும்பப்பெறல் SMS அனுப்பு', textLabel: 'செய்தி (10 முதல் 480 எழுத்துகள்)', send: 'ஒப்புதல் அளித்தவர்களுக்கு அனுப்பு',
    sentSay: 'அனுப்பப்பட்டது: {s}. தோல்வி: {f}. ஏற்கனவே தெரிவிக்கப்பட்டது: {a}. SMS ஒப்புதல் இல்லாதவர்கள் (அழைக்கவும்): {n}.', switched: 'பதிவு செய்யப்பட்டது.',
  },
};
const t = (key, vars = {}) => String(WORDS[lang]?.[key] ?? WORDS.en[key] ?? key).replace(/\{(\w+)\}/g, (_m, k) => String(vars[k] ?? ''));
const BASIS = { en: 'Data-law basis to be confirmed by your CA or lawyer.', ta: 'தரவுச் சட்ட அடிப்படையை உங்கள் பட்டயக் கணக்காளர் அல்லது வழக்கறிஞர் உறுதிப்படுத்த வேண்டும்.' };

/** A button's word with its icon beside it (OB-201: never an icon alone). */
function label(button, icon, key) {
  const word = t(key);
  button.setAttribute('aria-label', word);
  if (window.sreIcon && typeof window.sreIcon.withWord === 'function') button.replaceChildren(window.sreIcon.withWord(icon, word));
  else button.textContent = word;
}

let tab = 'recalls';
let recalls = [];
let recallsFailed = false;
let opened = null; // { recall, after?: start reply }
let traceReply = null; let traceKind = 'batch';
let callReply = null;
let switchReply = null;
const pending = new Map(); // action → idempotency key, kept until head office answers

const keyFor = (action) => { if (!pending.has(action)) pending.set(action, `${action}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`); return pending.get(action); };

function tell(ok, text) {
  const r = el('result');
  r.hidden = false;
  r.className = `result tone-${ok ? 'ok' : 'error'}`;
  r.textContent = text;
}

async function call(method, path, body, action) {
  const headers = { 'content-type': 'application/json' };
  if (method === 'POST') headers['idempotency-key'] = keyFor(action ?? path);
  const res = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const answer = await res.json().catch(() => ({}));
  if (method === 'POST') pending.delete(action ?? path);
  return { ok: res.ok, status: res.status, body: answer };
}
const refusal = (r) => `${t('refused')}: ${r.body?.error?.whatHappened ?? r.status} ${r.body?.error?.nextSafeAction ?? ''}`.trim();
const enc = encodeURIComponent;

// ── recalls ───────────────────────────────────────────────────────────────────────────────────────────────────────────

async function loadRecalls() {
  try {
    const r = await call('GET', '/v1/quality/recalls');
    if (!r.ok) throw new Error(String(r.status));
    recalls = Array.isArray(r.body.recalls) ? r.body.recalls : [];
    recallsFailed = false;
  } catch { recallsFailed = true; }
  paint();
}

function afterStartLines(after) {
  const lines = [];
  const tp = after.tillPack ?? {};
  if (tp.published === true) lines.push(t('tillsPublished', { v: tp.version }));
  else if (tp.onPack === true) lines.push(t('tillsAlready'));
  else lines.push(t('tillsNot', { d: tp.detail ?? '' }));
  const oa = after.ownerAlert ?? {};
  if (oa.raised === true) lines.push(t('ownersTold', { n: (oa.to ?? []).length }));
  else lines.push(t('ownersNot', { d: oa.why ?? oa.detail ?? '' }));
  const po = Array.isArray(after.openPurchaseOrders) ? after.openPurchaseOrders : [];
  lines.push(po.length === 0 ? t('noOrders') : t('openOrders', { list: po.map((o) => o.poId).join(', ') }));
  return lines;
}

async function startRecall() {
  const batch = el('r-batch').value.trim();
  const reason = el('r-reason').value.trim();
  if (batch === '') { tell(false, t('needBatch')); return; }
  if (reason === '') { tell(false, t('needReason')); return; }
  el('r-start').disabled = true;
  try {
    const r = await call('POST', `/v1/quality/recalls/${enc(batch)}`, { reason }, `recall-${batch}`);
    if (!r.ok) { tell(false, refusal(r)); return; }
    opened = { recall: r.body.recall, after: r.status === 201 ? r.body : null };
    tell(true, r.body.alreadyOpen === true ? t('alreadyOpen') : [`${t('started')}: ${batch}`, ...afterStartLines(r.body)].join('\n'));
    el('c-batch').value = batch; el('m-batch').value = batch;
  } catch { tell(false, t('unreachable')); } finally { el('r-start').disabled = false; }
  await loadRecalls();
}

async function openRecall(batchId) {
  const batch = (batchId ?? el('r-batch').value).trim();
  if (batch === '') { tell(false, t('needBatch')); return; }
  try {
    const r = await call('GET', `/v1/quality/recalls/${enc(batch)}`);
    if (!r.ok) { tell(false, refusal(r)); return; }
    opened = { recall: r.body.recall, after: null };
    el('r-batch').value = batch; el('c-batch').value = batch; el('m-batch').value = batch;
  } catch { tell(false, t('unreachable')); }
  paint();
}

async function closeRecall() {
  if (opened === null) return;
  const evidenceRef = el('r-evidence').value.trim();
  if (evidenceRef === '') { tell(false, t('needEvidence')); return; }
  el('r-close').disabled = true;
  try {
    const r = await call('POST', `/v1/quality/recalls/${enc(opened.recall.batchId)}/closure`, { evidenceRef }, `close-${opened.recall.batchId}`);
    if (!r.ok) { tell(false, refusal(r)); return; }
    opened = { recall: r.body.recall, after: null };
    tell(true, t('closedOk'));
  } catch { tell(false, t('unreachable')); } finally { el('r-close').disabled = false; }
  await loadRecalls();
}

function recallRow(r) {
  const li = document.createElement('li');
  li.className = r.status === 'open' ? 'tone-degraded' : '';
  li.dataset.batch = r.batchId;
  const head = document.createElement('strong');
  head.textContent = `${r.batchId} — ${t(r.status === 'open' ? 'statusOpen' : 'statusClosed')}`;
  const facts = document.createElement('div'); facts.className = 'facts';
  for (const text of [r.reason, `${t('startedBy')}: ${r.initiatedBy}`, `${t('since')}: ${new Date(r.initiatedAt).toLocaleString()}`, ...(r.closedAt ? [`${t('closedAt')}: ${new Date(r.closedAt).toLocaleString()} (${r.evidenceRef})`] : [])]) {
    const s = document.createElement('span'); s.textContent = text; facts.append(s);
  }
  const b = document.createElement('button'); b.type = 'button'; b.className = 'quiet open-one';
  label(b, 'search', 'open');
  b.addEventListener('click', () => { void openRecall(r.batchId); });
  li.append(head, facts, b);
  return li;
}

// ── trace ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

async function runTrace() {
  const kind = el('t-kind').value;
  const ref = el('t-ref').value.trim();
  if (ref === '') { tell(false, t('needBatch')); return; }
  const path = kind === 'batch' ? `/v1/quality/lot-trace/${enc(ref)}/chain`
    : kind === 'sale' ? `/v1/quality/lot-trace/backward/sales/${enc(ref)}` : `/v1/quality/lot-trace/backward/customers/${enc(ref)}`;
  try {
    const r = await call('GET', path);
    if (!r.ok) { traceReply = null; tell(false, refusal(r)); paint(); return; }
    traceReply = r.body; traceKind = kind;
  } catch { tell(false, t('unreachable')); }
  paint();
}

function cell(text) { const td = document.createElement('td'); td.textContent = text; return td; }
function headRow(keys) { const tr = document.createElement('tr'); for (const k of keys) { const th = document.createElement('th'); th.textContent = t(k); tr.append(th); } return tr; }

function paintTrace() {
  const head = el('t-head'); const rows = el('t-rows'); const gaps = el('t-gaps');
  head.replaceChildren(); rows.replaceChildren(); gaps.replaceChildren();
  el('t-summary').textContent = '';
  el('t-gaps-h').hidden = true;
  if (traceReply === null) return;
  const g = Array.isArray(traceReply.gaps) ? traceReply.gaps : [];
  if (traceKind === 'batch') {
    head.append(headRow(['colHop', 'colDate', 'colFrom', 'colTo', 'colRef', 'colQty']));
    for (const r of traceReply.rows ?? []) {
      const tr = document.createElement('tr');
      tr.append(cell(r.hop), cell(r.date), cell(r.from), cell(r.to), cell(r.reference), cell(String(r.quantityMinor)));
      rows.append(tr);
    }
    el('t-summary').textContent = `${t('traceRows', { n: (traceReply.rows ?? []).length })} ${g.length === 0 ? t('traceComplete') : t('traceGaps', { n: g.length })}`;
  } else {
    head.append(headRow(['colBatch', 'colDepth', 'colReceipts', 'colSupplier']));
    for (const b of traceReply.batches ?? []) {
      const tr = document.createElement('tr');
      const receipts = (b.receipts ?? []).map((x) => x.reference).join('; ') || ((b.madeBy ?? []).map((m) => `run ${m.runId}`).join('; ') || t('notKnown'));
      const suppliers = [...new Set((b.receipts ?? []).map((x) => x.supplierId ?? t('notKnown')))].join(', ') || t('notKnown');
      tr.append(cell(b.batchId), cell((b.reachedFrom ?? []).join('; ')), cell(receipts), cell(suppliers));
      rows.append(tr);
    }
    el('t-summary').textContent = `${t('backSummary', { s: (traceReply.sales ?? []).length, b: (traceReply.batches ?? []).length, p: (traceReply.suppliers ?? []).length })} ${g.length === 0 ? t('traceComplete') : t('traceGaps', { n: g.length })}`;
  }
  el('t-gaps-h').hidden = g.length === 0;
  for (const text of g) { const li = document.createElement('li'); li.textContent = text; gaps.append(li); }
}

// ── call list ─────────────────────────────────────────────────────────────────────────────────────────────────────────

async function loadCalls() {
  const batch = el('c-batch').value.trim();
  if (batch === '') { tell(false, t('needBatch')); return; }
  try {
    const r = await call('GET', `/v1/quality/recalls/${enc(batch)}/notice-list`);
    if (!r.ok) { callReply = null; tell(false, refusal(r)); paint(); return; }
    callReply = r.body;
  } catch { tell(false, t('unreachable')); }
  paint();
}

function callRow(c) {
  const li = document.createElement('li');
  li.dataset.customer = c.customerRef;
  const head = document.createElement('strong');
  head.className = 'name';
  head.textContent = c.name ?? t('nameNotOnRecord');
  const facts = document.createElement('div'); facts.className = 'facts';
  const add = (text, cls) => { const s = document.createElement('span'); s.textContent = text; if (cls) s.className = cls; facts.append(s); };
  add(c.phoneLast4 === null ? t('noPhone') : `${t('phone')}: …${c.phoneLast4}`, 'phone');
  for (const b of c.bought ?? []) add(`${t('bought')}: ${t('lot')} ${b.lot}${b.madeFromLot ? ` (${t('madeFrom')} ${b.madeFromLot})` : ''} · ${b.date}${b.estimate ? ` · ${t('estimate')}` : ''}`, 'lot');
  add((c.serviceMessagesOn ?? []).length === 0 ? t('serviceNone') : t('serviceYes', { c: c.serviceMessagesOn.join(', ') }));
  li.append(head, facts);
  for (const n of c.notes ?? []) { const p = document.createElement('span'); p.className = 'note'; p.textContent = t(n); li.append(p); }
  return li;
}

// ── messages ──────────────────────────────────────────────────────────────────────────────────────────────────────────

async function loadSwitch() {
  try {
    const r = await call('GET', '/v1/quality/recall-notices/switch');
    switchReply = r.ok ? r.body : null;
  } catch { switchReply = null; }
  paint();
}

async function setSwitch(on) {
  const reason = el('m-reason').value.trim();
  if (reason === '') { tell(false, t('needReason')); return; }
  try {
    const r = await call('POST', '/v1/quality/recall-notices/switch', { on, reason }, `switch-${on}`);
    tell(r.ok, r.ok ? t('switched') : refusal(r));
  } catch { tell(false, t('unreachable')); }
  await loadSwitch();
}

async function sendNotices() {
  const batch = el('m-batch').value.trim();
  if (batch === '') { tell(false, t('needBatch')); return; }
  el('m-send').disabled = true;
  try {
    const r = await call('POST', `/v1/quality/recalls/${enc(batch)}/notices`, { text: el('m-text').value }, `notices-${batch}`);
    tell(r.ok, r.ok ? t('sentSay', { s: (r.body.sent ?? []).length, f: (r.body.failed ?? []).length, a: (r.body.alreadyTold ?? []).length, n: (r.body.notOnSms ?? []).length }) : refusal(r));
  } catch { tell(false, t('unreachable')); } finally { el('m-send').disabled = false; }
}

// ── paint ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const TABS = ['recalls', 'trace', 'calls', 'messages'];
const TAB_WORD = { recalls: ['shield-alert', 'tabRecalls'], trace: ['git-branch', 'tabTrace'], calls: ['users', 'tabCalls'], messages: ['send', 'tabMessages'] };

function paint() {
  el('page-h').textContent = t('title');
  el('title').firstChild.textContent = `${t('title')} `;
  el('lead').textContent = t('lead');
  el('lang').textContent = t('langName');
  el('whoami').textContent = DATA.userId ?? '';
  for (const id of TABS) {
    const b = el(`tab-${id}`);
    label(b, TAB_WORD[id][0], TAB_WORD[id][1]);
    if (id === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    el(`view-${id}`).hidden = id !== tab;
  }
  // recalls
  el('recalls-h').textContent = t('recallsH');
  el('l-r-batch').textContent = t('batchLabel'); el('l-r-reason').textContent = t('reasonLabel');
  label(el('r-start'), 'shield-alert', 'start'); label(el('r-open'), 'search', 'open');
  el('r-list-h').textContent = t('listH');
  el('r-none').hidden = !(recallsFailed || recalls.length === 0);
  el('r-none').textContent = recallsFailed ? t('cannotRead') : t('noneYet');
  el('r-rows').replaceChildren(...recalls.map(recallRow));
  const detail = el('r-detail');
  detail.hidden = opened === null;
  if (opened !== null) {
    const r = opened.recall;
    el('r-detail-h').textContent = `${t('detailH')} ${r.batchId} — ${t(r.status === 'open' ? 'statusOpen' : 'statusClosed')}`;
    const facts = el('r-facts');
    const lines = [r.reason, `${t('startedBy')}: ${r.initiatedBy}`, `${t('since')}: ${new Date(r.initiatedAt).toLocaleString()}`, ...(opened.after ? afterStartLines(opened.after) : [])];
    if (r.closedAt) lines.push(`${t('closedAt')}: ${new Date(r.closedAt).toLocaleString()} (${r.evidenceRef})`);
    facts.replaceChildren(...lines.map((x) => { const s = document.createElement('span'); s.textContent = x; return s; }));
    el('r-close-row').hidden = r.status !== 'open';
    el('l-r-evidence').textContent = t('evidenceLabel');
    label(el('r-close'), 'check', 'close');
  }
  // trace
  el('trace-h').textContent = t('traceH');
  el('l-t-kind').textContent = t('kindLabel'); el('l-t-ref').textContent = t('refLabel');
  const kind = el('t-kind'); const was = kind.value || 'batch';
  kind.replaceChildren(...[['batch', 'kindBatch'], ['sale', 'kindSale'], ['customer', 'kindCustomer']].map(([v, k]) => { const o = document.createElement('option'); o.value = v; o.textContent = t(k); return o; }));
  kind.value = was;
  label(el('t-run'), 'search', 'run');
  el('t-gaps-h').textContent = t('gapsH');
  paintTrace();
  // calls
  el('calls-h').textContent = t('callsH');
  el('c-basis').textContent = callReply?.dataLawBasis?.[lang] ?? BASIS[lang];
  el('l-c-batch').textContent = t('callsBatch');
  label(el('c-load'), 'users', 'loadCalls');
  el('c-summary').textContent = callReply === null ? '' : t('callsSummary', { n: callReply.callList.length, s: callReply.smsConsented, a: callReply.anonymousSales });
  el('c-rows').replaceChildren(...(callReply?.callList ?? []).map(callRow));
  // messages
  el('messages-h').textContent = t('messagesH');
  const sw = switchReply?.switch ?? null;
  const provider = switchReply?.messages?.providerConnected === true;
  el('m-state').textContent = switchReply === null ? '' : `${sw?.on === true ? t('stateOn', { by: sw.by, why: sw.reason }) : t('stateOff')}${provider ? '' : ` ${t('noProvider')}`}`;
  // The owner's alone: shown when the viewer holds the switch (or when nobody told the page — head office then decides).
  el('m-switch-box').hidden = PERMS !== null && !PERMS.includes('quality.recall.notice.switch');
  el('l-m-reason').textContent = t('switchReason');
  label(el('m-on'), 'send', 'switchOn'); label(el('m-off'), 'pause', 'switchOff');
  el('m-send-h').textContent = t('sendH');
  el('l-m-batch').textContent = t('callsBatch'); el('l-m-text').textContent = t('textLabel');
  label(el('m-send'), 'send', 'send');
}

for (const id of TABS) el(`tab-${id}`).addEventListener('click', () => { tab = id; paint(); if (id === 'messages') void loadSwitch(); });
el('r-start').addEventListener('click', () => { void startRecall(); });
el('r-open').addEventListener('click', () => { void openRecall(); });
el('r-close').addEventListener('click', () => { void closeRecall(); });
el('t-run').addEventListener('click', () => { void runTrace(); });
el('c-load').addEventListener('click', () => { void loadCalls(); });
el('m-on').addEventListener('click', () => { void setSwitch(true); });
el('m-off').addEventListener('click', () => { void setSwitch(false); });
el('m-send').addEventListener('click', () => { void sendNotices(); });
el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
void loadRecalls();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
