// Self-checkout lane — the view layer. Every rule lives in the TESTED lane model (`apps/self-checkout/src/
// self-checkout-lane.ts`), attached as `window.selfCheckout` over the till's own engine; this file only draws it.
//
// ── What this file holds ────────────────────────────────────────────────────
//
// 1. A scan is a scan. The customer has no box to type a product code into: a retail scanner is a keyboard that types
//    fast and presses Enter, so codes are collected globally and flushed on Enter — exactly as the till does.
// 2. The customer reads neutral words only. The specific reason, the decisions and the attendant notes live in the
//    Colleague panel, and every button there takes the colleague's own staff code and PIN, typed again each time.
// 3. No `prompt`, `confirm` or `alert`. Icons always beside words; English and Tamil.

// OB-607: a moment is shown at the SHOP's clock (its zone, as the store computer told the page) — never this device's.
const shopWhen = (value) => window.sreShopDay?.dateTimeOf(value) ?? '';
const el = (id) => document.getElementById(id);
const mark = (name, size = 22) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, size) : null);
function paintIconSlots() {
  for (const slot of document.querySelectorAll('[data-sre-icon]')) {
    if (slot.firstElementChild !== null) continue;
    const m = mark(slot.dataset.sreIcon, 22);
    if (m !== null) slot.append(m);
  }
}
const inr = (minor) => '₹' + (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const WORDS = {
  en: {
    title: 'Self-checkout', colleague: 'Colleague', total: 'Total', payCard: 'Pay by card', payUpi: 'Pay by UPI', next: 'Next customer',
    empty: 'Your items will appear here.', remove: 'Remove', staff: 'Staff code', pin: 'PIN', panel: 'Colleague', open: 'Open lane', close: 'Close lane', done: 'Done',
    machine: 'What did the machine say?', ref: 'Approval / reference number from the slip', approved: 'Approved', declined: 'Declined', noAnswer: 'It has not answered',
    nothing: 'Nothing is waiting for a colleague.', bill: 'Bill', attendant: 'Opened by', notOpened: 'Not open', recordedNot: 'The basket\'s record has not reached the store computer yet.',
    noBundle: 'This lane is not ready: its program did not load. Please use a staffed till.',
    staleShell: 'No connection to the store computer. This is the lane as it was last served, at',
    kinds: { age_check: 'Age check', pack_date_check: 'Date on the pack', weighed_item: 'Weighed item', item_refused: 'Item refused', not_found: 'Not found', random_audit: 'Random check', high_value_produce_pattern: 'Loose produce', void_pattern: 'Items removed', payment: 'Payment' },
    decisions: { old_enough: 'ID seen — old enough', not_old_enough: 'Not old enough — not sold', date_good: 'Date is good', date_passed: 'Date passed — not sold', sent_to_scale: 'Taken to the scale for a label', not_sold: 'Not sold here', item_taken_back: 'Item taken back', checked: 'Checked', noted: 'Noted' },
  },
  ta: {
    title: 'சுய-கட்டணம்', colleague: 'ஊழியர்', total: 'மொத்தம்', payCard: 'கார்டு மூலம் செலுத்து', payUpi: 'UPI மூலம் செலுத்து', next: 'அடுத்த வாடிக்கையாளர்',
    empty: 'உங்கள் பொருட்கள் இங்கே தெரியும்.', remove: 'நீக்கு', staff: 'ஊழியர் குறியீடு', pin: 'PIN', panel: 'ஊழியர்', open: 'வரிசையைத் திற', close: 'வரிசையை மூடு', done: 'முடிந்தது',
    machine: 'இயந்திரம் என்ன சொன்னது?', ref: 'சீட்டில் உள்ள ஒப்புதல் / குறிப்பு எண்', approved: 'ஒப்புதல் கிடைத்தது', declined: 'நிராகரிக்கப்பட்டது', noAnswer: 'பதில் வரவில்லை',
    nothing: 'ஊழியருக்காக எதுவும் காத்திருக்கவில்லை.', bill: 'பில்', attendant: 'திறந்தவர்', notOpened: 'திறக்கப்படவில்லை', recordedNot: 'இந்தக் கூடையின் பதிவு இன்னும் கடை கணினியை அடையவில்லை.',
    noBundle: 'இந்த வரிசை தயாராக இல்லை: அதன் நிரல் ஏற்றப்படவில்லை. ஊழியர் உள்ள கட்டண மையத்தைப் பயன்படுத்தவும்.',
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இது கடைசியாக வழங்கப்பட்ட வரிசை, நேரம்:',
    kinds: { age_check: 'வயது சரிபார்ப்பு', pack_date_check: 'பாக்கெட்டில் உள்ள தேதி', weighed_item: 'எடைபோடும் பொருள்', item_refused: 'விற்க முடியாத பொருள்', not_found: 'கிடைக்கவில்லை', random_audit: 'சீரற்ற சரிபார்ப்பு', high_value_produce_pattern: 'தளர்வான காய்கறி/பழம்', void_pattern: 'நீக்கப்பட்ட பொருட்கள்', payment: 'கட்டணம்' },
    decisions: { old_enough: 'அடையாளம் பார்த்தேன் — வயது சரி', not_old_enough: 'வயது போதாது — விற்கவில்லை', date_good: 'தேதி சரி', date_passed: 'தேதி கடந்தது — விற்கவில்லை', sent_to_scale: 'லேபிளுக்காக எடைக்கருவிக்கு எடுத்துச் சென்றேன்', not_sold: 'இங்கே விற்கவில்லை', item_taken_back: 'பொருள் திரும்பப் பெறப்பட்டது', checked: 'சரிபார்த்தேன்', noted: 'குறித்துக்கொண்டேன்' },
  },
};
let lang = 'en';
const t = (k) => WORDS[lang][k];
const words = (w) => (w === null || w === undefined ? '' : (lang === 'ta' ? w.ta : w.en));

const lane = window.selfCheckout;
let said = '';

function setWithIcon(node, icon, text) {
  const m = mark(icon, 30);
  node.replaceChildren(...(m === null ? [] : [m]), document.createTextNode(text));
}

function render() {
  el('title').firstChild.textContent = t('title');
  el('colleague-words').textContent = t('colleague');
  el('total-words').textContent = t('total');
  el('pay-card-words').textContent = t('payCard');
  el('pay-upi-words').textContent = t('payUpi');
  el('next-words').textContent = t('next');
  el('panel-title').textContent = t('panel');
  el('staff-label').textContent = t('staff');
  el('pin-label').textContent = t('pin');
  el('open-words').textContent = t('open');
  el('close-words').textContent = t('close');
  el('done-words').textContent = t('done');
  el('machine-title').textContent = t('machine');
  el('ref-label').textContent = t('ref');
  el('approved-words').textContent = t('approved');
  el('declined-words').textContent = t('declined');
  el('noanswer-words').textContent = t('noAnswer');
  if (lane === undefined) {
    setWithIcon(el('now'), 'circle-alert', t('noBundle'));
    el('now').className = 'now closed';
    el('pay-card').disabled = true; el('pay-upi').disabled = true;
    return;
  }
  const v = lane.view();
  el('subtitle').textContent = v.attendant === null ? t('notOpened') : `${t('attendant')}: ${v.attendant}`;
  const now = el('now');
  now.className = v.open ? (v.waitingForColleague ? 'now waiting' : 'now') : 'now closed';
  setWithIcon(now, v.open ? (v.waitingForColleague ? 'hand' : (v.receipt !== null ? 'circle-check' : 'scan-barcode')) : 'lock', words(v.customerNow));

  const basket = el('basket');
  basket.replaceChildren();
  for (const l of v.lines) {
    const row = document.createElement('div');
    row.className = 'line';
    const what = document.createElement('span');
    what.className = 'what';
    what.textContent = l.description;
    const qty = document.createElement('small');
    qty.textContent = l.qtyText;
    what.append(qty);
    const amount = document.createElement('span');
    amount.className = 'amount';
    amount.textContent = inr(l.amountMinor);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.dataset.line = l.lineId;
    const m = mark('trash', 20);
    remove.replaceChildren(...(m === null ? [] : [m]), document.createTextNode(t('remove')));
    remove.disabled = v.payment !== null || v.receipt !== null;
    remove.addEventListener('click', async () => { const a = await lane.removeLine(l.lineId); said = words(a.words); render(); });
    row.append(what, amount, remove);
    basket.append(row);
  }
  const empty = document.createElement('p');
  empty.className = 'empty'; empty.id = 'empty'; empty.textContent = t('empty'); empty.hidden = v.lines.length > 0;
  basket.append(empty);
  el('total').textContent = inr(v.totalMinor);
  const canPay = v.open && v.lines.length > 0 && v.payment === null && v.receipt === null && !v.interventions.some((i) => i.blocking);
  el('pay-card').disabled = !canPay; el('pay-upi').disabled = !canPay;
  el('receipt').hidden = v.receipt === null;
  el('receipt').textContent = v.receipt === null ? '' : `${t('bill')} ${v.receipt.number}`;
  el('next').hidden = v.receipt === null;

  // The colleague's panel: the specific words, the decisions, the payment, the notes.
  el('said').textContent = said;
  const items = el('items');
  items.replaceChildren();
  if (v.interventions.length === 0 && v.payment === null) {
    const p = document.createElement('p'); p.textContent = t('nothing'); items.append(p);
  }
  for (const i of v.interventions) {
    const box = document.createElement('div');
    box.className = 'item'; box.dataset.intervention = i.id; box.dataset.kind = i.kind;
    const kind = document.createElement('p'); kind.className = 'kind'; kind.textContent = WORDS[lang].kinds[i.kind] ?? i.kind;
    const detail = document.createElement('p'); detail.textContent = i.attendantDetail;
    const decisions = document.createElement('div'); decisions.className = 'decisions';
    for (const d of i.decisions) {
      const b = document.createElement('button');
      b.type = 'button'; b.dataset.decision = d;
      const m = mark(d.startsWith('not') || d.endsWith('passed') ? 'x' : 'check', 20);
      b.replaceChildren(...(m === null ? [] : [m]), document.createTextNode(WORDS[lang].decisions[d] ?? d));
      b.addEventListener('click', async () => {
        const a = await lane.settle(i.id, el('staff').value, el('pin').value, d);
        el('pin').value = '';
        said = `${words(a.words)}${a.detail ? ` — ${a.detail}` : ''}`;
        render();
      });
      decisions.append(b);
    }
    box.append(kind, detail, decisions);
    items.append(box);
  }
  el('machine').hidden = v.payment === null;
  const notes = el('notes');
  notes.replaceChildren(...v.attendantNotes.map((n) => { const li = document.createElement('li'); li.textContent = n; return li; }));
  if (v.receipt !== null && !v.receipt.basketRecorded) { const li = document.createElement('li'); li.textContent = t('recordedNot'); notes.append(li); }
  paintIconSlots();
}

async function pay(kind) {
  const a = await lane.pay(kind);
  said = `${words(a.words)}${a.detail ? ` — ${a.detail}` : ''}`;
  render();
}
async function confirm(outcome) {
  const a = await lane.confirmPayment(el('staff').value, el('pin').value, outcome, el('ref').value);
  el('pin').value = '';
  if (a.ok) el('ref').value = '';
  said = `${words(a.words)}${a.detail ? ` — ${a.detail}` : ''}`;
  render();
}

if (lane !== undefined) {
  el('pay-card').addEventListener('click', () => { void pay('card'); });
  el('pay-upi').addEventListener('click', () => { void pay('upi'); });
  el('next').addEventListener('click', () => { lane.nextCustomer(); said = ''; render(); });
  el('paid-approved').addEventListener('click', () => { void confirm('approved'); });
  el('paid-declined').addEventListener('click', () => { void confirm('declined'); });
  el('paid-noanswer').addEventListener('click', () => { void confirm('no_answer'); });
  el('open-lane').addEventListener('click', async () => {
    const a = await lane.openLane(el('staff').value, el('pin').value);
    el('pin').value = '';
    said = `${words(a.words)}${a.detail ? ` — ${a.detail}` : ''}`;
    render();
  });
  el('close-lane').addEventListener('click', async () => { const a = await lane.closeLane(); said = words(a.words); render(); });
}
el('colleague').addEventListener('click', () => { el('panel').hidden = false; render(); });
el('panel-done').addEventListener('click', () => { el('panel').hidden = true; el('pin').value = ''; said = ''; render(); });

// The scanner: a keyboard that types fast and presses Enter. Never while a colleague is typing in the panel.
let buffer = '';
document.addEventListener('keydown', (e) => {
  if (lane === undefined || e.target instanceof HTMLInputElement) return;
  if (e.key === 'Enter') {
    const code = buffer.trim();
    buffer = '';
    if (code !== '') { const a = lane.scan(code); said = words(a.words); render(); }
    return;
  }
  if (e.key.length === 1) buffer += e.key;
});

el('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  render();
});

// A copy the service worker served when the store computer could not be reached says so, and when (P-08).
function paintStale() {
  const at = window.shellCachedAt;
  const strip = el('stale');
  if (!strip) return;
  strip.hidden = at === undefined;
  if (at === undefined) return;
  strip.textContent = `${t('staleShell')} ${shopWhen(at)}`;
}
paintStale();
el('lang').addEventListener('click', paintStale);

render();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the lane still opens; it just will not be there without the store computer */
  });
}
