// Queue till — the view layer (D04-FR-05 mobile POS and queue-busting). It renders the basket and dispatches the staff
// member's scans and taps; every rule lives in the TESTED models — the till's own session (`apps/pos`, booted by
// `apps/queue-pos/src/browser-entry.ts` against the store computer's signed pack) and the queue session on top of it,
// attached as `window.queueSession`.
//
// What this file holds:
//   1. A scan is a scan. A scanner is a keyboard that types fast and presses Enter; codes are collected globally and
//      flushed on Enter, exactly as at the till. "Key a code" opens the on-screen keypad for a label that will not scan.
//   2. The price is the till's. Every line is priced, offered and gated by the till's own session from the signed pack;
//      the age and pack-date questions block exactly as at the till.
//   3. Two ways to finish: hand the basket to a till by a four-digit code (always), or — only where the shop switched
//      `payments.mobile_pos` on, and never in the mirror pilot — take a card or UPI payment through the store computer.
//      There is no cash button: the owner decided a handheld takes no cash (OB-372). It prints nothing either: the paper
//      bill is printed at a till or the service desk by its number (OB-373).
//   4. No `prompt`, `confirm` or `alert`, and the banner does not fade.

const el = (id) => document.getElementById(id);
const mark = (name, size = 20) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, size) : null);
/** Words with the set's icon beside them; with no icon set loaded, the words stand alone — they are the signal. */
function say(node, text, icon) {
  const m = icon ? mark(icon) : null;
  if (m === null) { node.replaceChildren(text); return; }
  const pair = document.createElement('span');
  pair.className = 'sre-with-icon';
  pair.append(m, text);
  node.replaceChildren(pair);
}
function paintIconSlots() {
  for (const slot of document.querySelectorAll('[data-sre-icon]')) {
    if (slot.firstElementChild !== null) continue;
    const m = mark(slot.dataset.sreIcon, 18);
    if (m !== null) slot.append(m);
  }
}
const inr = (minor) => '₹' + (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── Words ───────────────────────────────────────────────────────────────────

const WORDS = {
  en: {
    title: 'Queue till', notBuilt: 'The queue till\'s programme is not on this store computer. Ask the manager.',
    signedInAs: 'Signed in', notSignedIn: 'Not signed in', boxUp: 'Store computer connected', boxDown: 'Store computer not answering — scanning goes on; hand over and payment wait for it',
    empty: 'Scan the customer\'s items. Each line is priced by the shop\'s own price list.', toPay: 'To pay',
    key: 'Key a code', waitingBtn: 'Waiting baskets', card: 'Card', upi: 'UPI', handover: 'Hand to a till',
    paymentsOff: 'This handheld does not take payments — hand each basket to a till.', mirror: 'Mirror pilot: the old system takes the money. Hand each basket to a till.',
    keyTitle: 'Key the barcode', keyHint: 'The digits under the barcode.', cancel: 'Cancel', ok: 'OK', read: 'Read this',
    lineWhat: 'This line', qtyBtn: 'Change the quantity', voidBtn: 'Take this line off', qtyTitle: 'How many?',
    voidTitle: 'Why is this line coming off?', reasonMistake: 'Scanned by mistake', reasonChanged: 'Customer changed their mind', reasonDamaged: 'Damaged item',
    voided: 'Line taken off.', ageCheck: 'Age check', ageQuestion: '{item} is age restricted. Check the customer\'s identification: are they {age} or over?',
    ageYes: 'Yes — {age} or over', ageNo: 'No — do not sell', ageNotSold: '{item} was not added: the customer could not show they are old enough.',
    packCheck: 'Date check — look at the pack', packQuestion: '{item} is perishable. Is the date printed on the pack still good today?',
    packYes: 'Yes — date is good', packNo: 'No — past its date', packNotSold: '{item} was not added: its date has passed. Put it aside for the manager.',
    handedTitle: 'Basket handed over', handedNext: 'Next customer', handedTell: 'Tell the customer this code. Any till on this store computer brings the basket up and prices it.',
    nothingToHand: 'Scan the items first.', waitingTitle: 'Baskets waiting for a till', noneWaiting: 'No basket from this handheld is waiting for a till.',
    giveUpTitle: 'Give this basket up?', giveUpReasonTitle: 'Why is it given up?', reasonLeft: 'Customer left the queue', reasonRescanned: 'Scanned again at the till',
    givenUp: 'Basket given up. It stays on the record.', lines: 'lines',
    payTitle: 'Use the card machine for {amount}. What did it say?', approved: 'Approved', declined: 'Declined', noAnswer: 'No answer',
    declinedMsg: 'The payment was declined. Nothing was saved — try again, or hand the basket to a till.',
    noAnswerMsg: 'The machine did not answer. It is recorded on the store computer and is NOT counted as paid. Check it before asking again.',
    checkPayment: 'Check the payment', paidTitle: 'Paid', billTitle: 'The customer\'s bill',
    printAtTill: 'Ask at a till or the service desk to print this bill: bill number {number}. This handheld does not print.',
    machineRefTitle: 'The approval number on the machine\'s slip', machineRefHint: 'Letters and digits from the slip — never the card number.',
    noReceipt: 'The store computer gave no bill number, so no money was taken.', nothingToPay: 'There is nothing to pay.',
    readThis: 'I have read this',
  },
  ta: {
    title: 'வரிசை பில்லிங்', notBuilt: 'வரிசை பில்லிங் நிரல் இந்தக் கடை கணினியில் இல்லை. மேலாளரிடம் கேட்கவும்.',
    signedInAs: 'உள்நுழைந்தவர்', notSignedIn: 'உள்நுழையவில்லை', boxUp: 'கடை கணினி இணைப்பில் உள்ளது', boxDown: 'கடை கணினி பதிலளிக்கவில்லை — ஸ்கேன் தொடரும்; ஒப்படைப்பும் கட்டணமும் காத்திருக்கும்',
    empty: 'வாடிக்கையாளரின் பொருட்களை ஸ்கேன் செய்யவும். ஒவ்வொரு வரியும் கடையின் சொந்த விலைப் பட்டியலால் விலையிடப்படும்.', toPay: 'செலுத்த வேண்டியது',
    key: 'குறியீட்டை உள்ளிடு', waitingBtn: 'காத்திருக்கும் கூடைகள்', card: 'அட்டை', upi: 'UPI', handover: 'பில்லிங்குக்கு ஒப்படை',
    paymentsOff: 'இந்தக் கருவி கட்டணம் பெறாது — ஒவ்வொரு கூடையையும் பில்லிங்குக்கு ஒப்படைக்கவும்.', mirror: 'மிரர் சோதனை: பழைய அமைப்பு பணம் பெறும். கூடையை பில்லிங்குக்கு ஒப்படைக்கவும்.',
    keyTitle: 'பார்கோடை உள்ளிடவும்', keyHint: 'பார்கோடின் கீழ் உள்ள இலக்கங்கள்.', cancel: 'ரத்து', ok: 'சரி', read: 'இதைப் படிக்கவும்',
    lineWhat: 'இந்த வரி', qtyBtn: 'அளவை மாற்று', voidBtn: 'இந்த வரியை நீக்கு', qtyTitle: 'எத்தனை?',
    voidTitle: 'இந்த வரி ஏன் நீக்கப்படுகிறது?', reasonMistake: 'தவறாக ஸ்கேன் செய்யப்பட்டது', reasonChanged: 'வாடிக்கையாளர் மனம் மாறினார்', reasonDamaged: 'சேதமடைந்த பொருள்',
    voided: 'வரி நீக்கப்பட்டது.', ageCheck: 'வயது சரிபார்ப்பு', ageQuestion: '{item} வயது கட்டுப்பாடுள்ள பொருள். வாடிக்கையாளரின் அடையாளத்தைச் சரிபார்க்கவும்: அவர் {age} வயது அல்லது அதற்கு மேலா?',
    ageYes: 'ஆம் — {age} அல்லது மேல்', ageNo: 'இல்லை — விற்க வேண்டாம்', ageNotSold: '{item} சேர்க்கப்படவில்லை: வாடிக்கையாளர் வயதைக் காட்ட முடியவில்லை.',
    packCheck: 'தேதி சரிபார்ப்பு — பொதியைப் பாருங்கள்', packQuestion: '{item} விரைவில் கெடும் பொருள். பொதியில் அச்சிடப்பட்ட தேதி இன்று செல்லுபடியாகுமா?',
    packYes: 'ஆம் — தேதி சரி', packNo: 'இல்லை — தேதி கடந்துவிட்டது', packNotSold: '{item} சேர்க்கப்படவில்லை: அதன் தேதி கடந்துவிட்டது. மேலாளருக்காக தனியாக வையுங்கள்.',
    handedTitle: 'கூடை ஒப்படைக்கப்பட்டது', handedNext: 'அடுத்த வாடிக்கையாளர்', handedTell: 'இந்தக் குறியீட்டை வாடிக்கையாளரிடம் சொல்லவும். இந்தக் கடை கணினியின் எந்த பில்லிங்கும் கூடையை எடுத்து விலையிடும்.',
    nothingToHand: 'முதலில் பொருட்களை ஸ்கேன் செய்யவும்.', waitingTitle: 'பில்லிங்குக்குக் காத்திருக்கும் கூடைகள்', noneWaiting: 'இந்தக் கருவியிலிருந்து எந்தக் கூடையும் காத்திருக்கவில்லை.',
    giveUpTitle: 'இந்தக் கூடையைக் கைவிடவா?', giveUpReasonTitle: 'ஏன் கைவிடப்படுகிறது?', reasonLeft: 'வாடிக்கையாளர் வரிசையை விட்டுச் சென்றார்', reasonRescanned: 'பில்லிங்கில் மீண்டும் ஸ்கேன் செய்யப்பட்டது',
    givenUp: 'கூடை கைவிடப்பட்டது. அது பதிவில் இருக்கும்.', lines: 'வரிகள்',
    payTitle: '{amount}-க்கு அட்டை இயந்திரத்தைப் பயன்படுத்தவும். அது என்ன சொன்னது?', approved: 'ஏற்கப்பட்டது', declined: 'மறுக்கப்பட்டது', noAnswer: 'பதில் இல்லை',
    declinedMsg: 'கட்டணம் மறுக்கப்பட்டது. எதுவும் சேமிக்கப்படவில்லை — மீண்டும் முயலவும் அல்லது கூடையை பில்லிங்குக்கு ஒப்படைக்கவும்.',
    noAnswerMsg: 'இயந்திரம் பதிலளிக்கவில்லை. அது கடை கணினியில் பதிவாகியுள்ளது; செலுத்தியதாகக் கணக்கிடப்படவில்லை. மீண்டும் கேட்கும் முன் சரிபார்க்கவும்.',
    checkPayment: 'கட்டணத்தைச் சரிபார்', paidTitle: 'செலுத்தப்பட்டது', billTitle: 'வாடிக்கையாளரின் பில்',
    printAtTill: 'இந்த பில்லை அச்சிட ஏதேனும் பில்லிங் கவுண்டர் அல்லது சேவை மேசையில் கேளுங்கள்: பில் எண் {number}. இந்தக் கையடக்கக் கருவி அச்சிடாது.',
    machineRefTitle: 'இயந்திரச் சீட்டில் உள்ள ஒப்புதல் எண்', machineRefHint: 'சீட்டில் உள்ள எழுத்துகளும் இலக்கங்களும் — அட்டை எண் ஒருபோதும் வேண்டாம்.',
    noReceipt: 'கடை கணினி பில் எண் தரவில்லை; பணம் பெறப்படவில்லை.', nothingToPay: 'செலுத்த எதுவும் இல்லை.',
    readThis: 'இதைப் படித்தேன்',
  },
};
let lang = 'en';
const t = (key) => WORDS[lang][key] ?? WORDS.en[key] ?? key;
const fill = (words, values) => Object.entries(values).reduce((w, [k, v]) => w.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v)), words);

const session = window.queueSession;
const till = session ? session.till : null;
let signedIn = false;
let boxUp = null;

// ── The banner: no timer; its shape beside the words ────────────────────────
function tell(title, text, good = false, bill = '') {
  el('banner').className = good ? 'banner good' : 'banner';
  const shape = mark(good ? 'circle-check' : 'circle-alert', 28);
  el('banner-mark').replaceChildren(...(shape === null ? [] : [shape]));
  el('banner-title').textContent = title;
  el('banner-text').textContent = text;
  el('banner-bill').textContent = bill;
  el('banner-ok').textContent = t('readThis');
  el('banner').hidden = false;
  el('banner-ok').focus();
}
el('banner-ok').addEventListener('click', () => { el('banner').hidden = true; });
const wordsOf = (r) => (lang === 'ta' && r && typeof r.laneMessageTa === 'string' ? r.laneMessageTa : r && typeof r.laneMessage === 'string' ? r.laneMessage : '');
// OB-521 (R8-A): a refusal that carries its own Tamil words (a new basket on a withdrawn or too-old build) says them in Tamil.
const errorWords = (e) => (e && lang === 'ta' && typeof e.laneMessageTa === 'string' ? e.laneMessageTa
  : e && typeof e.laneMessage === 'string' ? e.laneMessage : String(e && e.message ? e.message : e));

// ── The sheet: a keypad, a text field, or a list of choices ─────────────────
let sheetDone = null;
let sheetMode = 'number';
let entry = '';
function openSheet({ title, hint = '', mode, choices = [] }) {
  el('sheet-title').textContent = title;
  el('sheet-hint').textContent = hint;
  sheetMode = mode;
  entry = '';
  el('entry').textContent = '0';
  el('entry').hidden = mode !== 'number';
  el('keypad').hidden = mode !== 'number';
  el('entry-text').hidden = mode !== 'text';
  el('entry-text').value = '';
  el('entry-text').setAttribute('aria-label', title);
  el('choices').hidden = mode !== 'choice';
  el('sheet-ok').hidden = mode === 'choice';
  el('sheet-ok').textContent = t('ok');
  el('sheet-cancel').textContent = t('cancel');
  el('choices').replaceChildren(...choices.map((c) => {
    const b = document.createElement('button');
    b.type = 'button';
    say(b, c.label, c.icon);
    b.addEventListener('click', () => closeSheet(c.value));
    return b;
  }));
  el('sheet').hidden = false;
  if (mode === 'text') el('entry-text').focus();
  return new Promise((resolve) => { sheetDone = resolve; });
}
function closeSheet(value) {
  el('sheet').hidden = true;
  const done = sheetDone;
  sheetDone = null;
  if (done) done(value);
}
const choose = (title, choices, hint = '') => openSheet({ title, hint, mode: 'choice', choices });
const askNumber = (title, hint = '') => openSheet({ title, hint, mode: 'number' });
const askText = (title, hint = '') => openSheet({ title, hint, mode: 'text' });
for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', 'C']) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = k;
  b.addEventListener('click', () => {
    if (k === '⌫') entry = entry.slice(0, -1); else if (k === 'C') entry = ''; else if (entry.length < 20) entry += k;
    el('entry').textContent = entry === '' ? '0' : entry;
  });
  el('keypad').append(b);
}
el('sheet-cancel').addEventListener('click', () => closeSheet(null));
el('sheet-ok').addEventListener('click', () => closeSheet(sheetMode === 'text' ? el('entry-text').value.trim() : entry));

// ── The basket ──────────────────────────────────────────────────────────────
function render() {
  el('title').firstChild.textContent = t('title');
  el('lang').lastChild.textContent = 'EN / த';
  el('total-label').textContent = t('toPay');
  say(el('key'), t('key'), 'scan-barcode');
  say(el('waiting'), t('waitingBtn'), 'list-checks');
  say(el('card'), t('card'), 'wallet');
  say(el('upi'), t('upi'), 'monitor-smartphone');
  say(el('handover'), t('handover'), 'send');
  const ctx = window.queuePos || {};
  el('who').textContent = signedIn && ctx.signedIn ? `${t('signedInAs')}: ${ctx.signedIn.displayName}` : t('notSignedIn');
  el('box').className = boxUp === false ? 'box down' : 'box';
  el('box-text').textContent = boxUp === false ? t('boxDown') : t('boxUp');
  if (!session) { el('notice').hidden = false; el('notice').textContent = t('notBuilt'); return; }
  const pays = session.paymentsHere();
  el('card').hidden = !pays;
  el('upi').hidden = !pays;
  const why = till.mirrorPilot() ? t('mirror') : pays ? '' : t('paymentsOff');
  el('notice').hidden = why === '';
  el('notice').textContent = why;
  const lines = till.basket();
  el('empty').hidden = lines.length > 0;
  el('empty').textContent = t('empty');
  el('lines').replaceChildren(...lines.map((l) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = l.voided ? 'line voided' : 'line';
    b.dataset.lineId = l.lineId;
    const what = document.createElement('span'); what.className = 'what'; what.textContent = l.description;
    const qty = document.createElement('span'); qty.className = 'qty'; qty.textContent = l.qtyText || `× ${l.qty}`;
    const amount = document.createElement('span'); amount.className = 'amount'; amount.textContent = inr(l.amountMinor);
    b.append(what, qty, amount);
    if (!l.voided) b.addEventListener('click', () => { void lineMenu(l); });
    return b;
  }));
  el('total').textContent = inr(till.payableMinor());
  paintIconSlots();
}

async function lineMenu(line) {
  const what = await choose(`${t('lineWhat')}: ${line.description}`, [
    { value: 'qty', label: t('qtyBtn'), icon: 'calculator' },
    { value: 'void', label: t('voidBtn'), icon: 'x' },
  ]);
  if (what === 'qty') {
    const n = await askNumber(t('qtyTitle'));
    if (n === null || n === '' || Number(n) < 1) return;
    try { till.setQuantity(line.lineId, Number(n)); } catch (e) { tell(t('read'), errorWords(e)); }
    render();
  } else if (what === 'void') {
    const reason = await choose(t('voidTitle'), [
      { value: t('reasonMistake'), label: t('reasonMistake') }, { value: t('reasonChanged'), label: t('reasonChanged') }, { value: t('reasonDamaged'), label: t('reasonDamaged') },
    ]);
    if (reason === null) return;
    const r = await till.voidAtTill(line.lineId, reason);
    render();
    if (!r.ok) tell(t('read'), r.laneMessage); else tell(t('voided'), '', true);
  }
}

// ── Scanning: the till's own rules, including the questions that block ─────
async function scan(code) {
  if (!session) return;
  try {
    session.scan(code);
    render();
  } catch (e) {
    if (e && e.name === 'AgeCheckRequiredError') { await askAge(e, () => scan(code)); return; }
    if (e && e.name === 'PackDateCheckRequiredError') { await askPackDate(e, () => scan(code)); return; }
    tell(t('read'), errorWords(e));
  }
}
async function askAge(refusal, retry) {
  const v = { item: refusal.description, age: refusal.minimumAge };
  const answer = await choose(fill(t('ageQuestion'), v), [{ value: 'yes', label: fill(t('ageYes'), v), icon: 'check' }, { value: 'no', label: t('ageNo'), icon: 'x' }], t('ageCheck'));
  if (answer === null) return;
  const at = new Date().toISOString();
  try {
    if (answer === 'yes') { till.confirmAge(refusal.minimumAge, at, refusal.productId); await retry(); return; }
    till.refuseAge(refusal.minimumAge, at, refusal.productId);
    tell(t('ageCheck'), fill(t('ageNotSold'), v));
  } catch (e) { tell(t('read'), errorWords(e)); }
  render();
}
async function askPackDate(refusal, retry) {
  const v = { item: refusal.description };
  const answer = await choose(fill(t('packQuestion'), v), [{ value: 'yes', label: t('packYes'), icon: 'check' }, { value: 'no', label: t('packNo'), icon: 'x' }], t('packCheck'));
  if (answer === null) return;
  const at = new Date().toISOString();
  try {
    if (answer === 'yes') { till.confirmPackDate(refusal.productId, at); await retry(); return; }
    till.refusePackDate(refusal.productId, at);
    tell(t('packCheck'), fill(t('packNotSold'), v));
  } catch (e) { tell(t('read'), errorWords(e)); }
  render();
}
let scanBuffer = '';
window.addEventListener('keydown', (event) => {
  if (!el('sheet').hidden || !el('banner').hidden || !el('handed').hidden) return;
  if (event.key === 'Enter') {
    const code = scanBuffer.replace(/[^0-9A-Za-z()\]]/g, '');
    scanBuffer = '';
    if (code.length < 6) return;
    event.preventDefault();
    void scan(code);
    return;
  }
  if (event.key.length === 1) scanBuffer += event.key;
});
el('key').addEventListener('click', async () => {
  const code = await askNumber(t('keyTitle'), t('keyHint'));
  if (code !== null && code !== '') await scan(code);
});

// ── Hand the basket to a till ────────────────────────────────────────────────
el('handover').addEventListener('click', async () => {
  if (!session) return;
  if (till.basket().filter((l) => !l.voided).length === 0) { tell(t('read'), t('nothingToHand')); return; }
  const r = await session.handOver();
  render();
  if (!r.ok) { tell(t('read'), [wordsOf(r), ...(r.lines || [])].join('\n')); return; }
  el('handed-title').textContent = t('handedTitle');
  el('handed-code').textContent = r.code;
  el('handed-text').textContent = `${t('handedTell')}\n${wordsOf(r)}`;
  say(el('handed-next'), t('handedNext'), 'shopping-basket');
  el('handed').hidden = false;
});
el('handed-next').addEventListener('click', () => { el('handed').hidden = true; render(); });

el('waiting').addEventListener('click', async () => {
  if (!session) return;
  const w = await session.waiting();
  if (!w.ok) { tell(t('read'), w.laneMessage || ''); return; }
  if (w.baskets.length === 0) { tell(t('waitingTitle'), t('noneWaiting'), true); return; }
  const code = await choose(t('waitingTitle'), w.baskets.map((b) => ({ value: b.code, label: `${b.code} — ${b.lineCount} ${t('lines')} — ${inr(b.handheldTotalMinor)}`, icon: 'shopping-basket' })));
  if (code === null) return;
  const reason = await choose(t('giveUpReasonTitle'), [{ value: t('reasonLeft'), label: t('reasonLeft') }, { value: t('reasonRescanned'), label: t('reasonRescanned') }], t('giveUpTitle'));
  if (reason === null) return;
  const r = await session.giveUp(code, reason);
  tell(r.ok ? t('givenUp') : t('read'), r.ok ? '' : wordsOf(r), r.ok);
});

// ── Card or UPI, where the shop allows it: the attempt on the store computer BEFORE the machine is asked ──
async function pay(kind) {
  const payable = till.payableMinor();
  if (payable <= 0) { tell(t('read'), t('nothingToPay')); return; }
  let started = await till.startCardPayment(kind, payable);
  if (!started.ok && started.refusedBecause === 'unresolved_payment_on_this_bill' && started.attemptId) {
    const what = await choose(started.laneMessage, [{ value: 'check', label: t('checkPayment'), icon: 'refresh-cw' }]);
    if (what !== 'check') return;
    const checked = await till.checkCardPayment(started.attemptId);
    if (!checked.ok) { tell(t('read'), checked.laneMessage); return; }
    started = await till.startCardPayment(kind, payable);
  }
  let ref = null;
  let machineRef;
  if (!started.ok && started.refusedBecause === 'already_paid_on_this_bill' && started.attemptId) {
    ref = started.attemptId;
    machineRef = started.machineRef;
  } else {
    if (!started.ok || !started.attemptId) { tell(t('read'), wordsOf(started)); return; }
    const outcome = await choose(fill(t('payTitle'), { amount: inr(payable) }), [
      { value: 'approved', label: t('approved'), icon: 'circle-check' }, { value: 'declined', label: t('declined'), icon: 'x' }, { value: 'no_answer', label: t('noAnswer'), icon: 'clock' },
    ]);
    if (outcome === null) return;
    let said = outcome;
    if (outcome === 'approved' && till.realTrading()) {
      for (;;) {
        const typed = await askText(t('machineRefTitle'), t('machineRefHint'));
        if (typed === null) { said = 'no_answer'; break; }
        const read = till.readMachineRef(typed);
        if (read.ok) { machineRef = read.value; break; }
      }
    }
    const answered = said === 'approved' && machineRef ? await till.answerCardPayment(started.attemptId, said, undefined, machineRef) : await till.answerCardPayment(started.attemptId, said);
    if (!answered.ok) { tell(t('read'), answered.laneMessage); return; }
    if (said !== 'approved') { tell(t('read'), said === 'declined' ? t('declinedMsg') : t('noAnswerMsg')); return; }
    ref = started.attemptId;
  }
  let receiptNumber;
  try { receiptNumber = await till.nextReceipt(); } catch (e) { tell(t('read'), errorWords(e) || t('noReceipt')); return; }
  try {
    await till.tenderCardOrUpi({ saleId: `S-${receiptNumber}`, receiptNumber, atIsoUtc: new Date().toISOString(), kind, outcome: 'approved', ref, ...(machineRef ? { machineRef } : {}) });
    const bill = till.realTrading() ? till.taxInvoice({ language: lang }) : till.receiptLines();
    // OB-373 (owner, 25 Oct 2026): no printer on the handheld — the paper bill is printed at a till or the service desk by
    // its number, marked as a copy.
    tell(`${t('paidTitle')} — ${kind === 'card' ? t('card') : t('upi')} — ${receiptNumber}`, fill(t('printAtTill'), { number: receiptNumber }), true, bill && bill.ok ? bill.lines.join('\n') : '');
    session.newCustomer();
  } catch (e) {
    tell(t('read'), errorWords(e));
  }
  render();
}
el('card').addEventListener('click', () => { void pay('card'); });
el('upi').addEventListener('click', () => { void pay('upi'); });

el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; render(); });

// ── The store computer: is it answering? (P-08 — said, never assumed) ──────
async function checkBox() {
  try {
    const res = await fetch('/queue-pos/lane/sync-status', { headers: { accept: 'application/json' }, credentials: 'same-origin' });
    boxUp = res.ok;
    // OB-521 (R8-A): the app version policy as the store computer's signed pack has it now — a withdrawn or too-old build
    // finishes the basket on screen and starts no new one (only an answer from the box changes it).
    if (res.ok && till && typeof till.applyVersionPolicy === 'function') {
      const status = await res.json().catch(() => null);
      if (status && 'appVersionPolicy' in status) till.applyVersionPolicy(status.appVersionPolicy);
    }
  } catch { boxUp = false; }
  render();
}

if (session) {
  void session.ready.then((live) => { signedIn = live === true; render(); });
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => undefined);
render();
void checkBox();
setInterval(() => { void checkBox(); }, 30_000);
