// POS shell — the view layer. It renders basket state and dispatches cashier intents; every rule
// lives in the TESTED session model (`apps/pos/src/session.ts`), attached as `window.posSession`.
//
// ── Three decisions this file exists to hold ────────────────────────────────
//
// **1. No `prompt`, `confirm` or `alert`. Anywhere.** They were how the first version asked for a
// quantity and a void reason, and they are wrong for this screen in three separate ways: a browser
// prompt is a small text field with a system keyboard over it, unusable with a queue waiting and
// impossible with gloves; kiosk browsers block them outright, so the till would simply do nothing;
// and they cannot be styled, so the one screen that must be readable across a counter is not. Every
// question is now an on-screen panel with 56px targets.
//
// **2. The refusal banner does not fade.** When the till's disk refuses a sale, the cashier is told
// *do not take payment* — and that is the one message in this product that must not be missed. It
// is full width, it is not colour alone, and it stays until somebody acknowledges it. A toast that
// disappears after four seconds is a message that was missed by the person serving a customer.
//
// **3. Change due is computed as they type.** Miscounted change is the most common till error there
// is, and nobody should be doing that arithmetic in their head at speed with a queue waiting.
//
// Nothing here calls the network. The sale path goes to this till's own disk over loopback
// (ADR-0004), and the service worker caches the shell so the lane opens during an outage.

const el = (id) => document.getElementById(id);

/** Exact minor units in, rupees out. The model never sees a float. */
const inr = (minor) =>
  '₹' + (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── Words ───────────────────────────────────────────────────────────────────
//
// Tamil is a first language for much of the floor staff, not a translation afterthought. Numbers
// are never translated — a total is a total in both.
const WORDS = {
  en: {
    scanToBegin: 'Scan an item to begin.', qty: 'Qty', void: 'Void', tender: 'Tender',
    cancel: 'Cancel', ok: 'OK', quantity: 'Quantity', cashReceived: 'Cash received',
    changeDue: 'Change due', online: 'Online', offline: 'Offline', unsent: 'Unsent',
    reasonForVoid: 'Reason for void', tapLineFirst: 'Tap a line first.',
    scanFirst: 'Scan an item first.', read: 'Please read this',
    notEnough: 'Not enough — the customer still owes',
    allSent: 'Everything on this lane has reached the cloud.',
    noCatalogue: 'This lane has no price list loaded, so it cannot scan. Tell the manager.',
    hold: 'Hold', recall: 'Recall', held: 'Basket held',
    howPaying: 'How is the customer paying?', cash: 'Cash', card: 'Card', upi: 'UPI',
    onHold: 'A basket is on hold. Tap Recall to bring it back.',
    tapTerminal: 'What did the card machine say?',
    approved: 'Approved', declined: 'Declined', noAnswer: 'It has not answered',
    declinedMsg: 'The payment was declined. The sale is NOT complete — do not hand over the goods. Ask for another payment method.',
    noAnswerMsg: 'The card machine has not answered, so we do not know whether the customer has paid. The sale is NOT complete — do not hand over the goods. Check the machine, and if it is unclear, ask the manager before trying again.',
  },
  ta: {
    scanToBegin: 'தொடங்க ஒரு பொருளை ஸ்கேன் செய்யவும்.', qty: 'எண்ணிக்கை', void: 'நீக்கு',
    tender: 'பணம் பெறு', cancel: 'ரத்து', ok: 'சரி', quantity: 'எண்ணிக்கை',
    cashReceived: 'பெற்ற பணம்', changeDue: 'மீதம் தர வேண்டியது', online: 'இணைப்பில்',
    offline: 'இணைப்பு இல்லை', unsent: 'அனுப்பப்படாதவை', reasonForVoid: 'நீக்கக் காரணம்',
    tapLineFirst: 'முதலில் ஒரு வரியைத் தொடவும்.', scanFirst: 'முதலில் ஒரு பொருளை ஸ்கேன் செய்யவும்.',
    read: 'இதைப் படிக்கவும்', notEnough: 'போதவில்லை — வாடிக்கையாளர் இன்னும் தர வேண்டியது',
    allSent: 'இந்த லேனில் உள்ள அனைத்தும் அனுப்பப்பட்டுவிட்டன.',
    noCatalogue: 'இந்த லேனில் விலைப் பட்டியல் இல்லை. மேலாளரிடம் சொல்லவும்.',
    hold: 'நிறுத்து', recall: 'திரும்பப் பெறு', held: 'கூடை நிறுத்தப்பட்டது',
    howPaying: 'வாடிக்கையாளர் எவ்வாறு பணம் தருகிறார்?', cash: 'ரொக்கம்', card: 'கார்டு', upi: 'UPI',
    onHold: 'ஒரு கூடை நிறுத்தி வைக்கப்பட்டுள்ளது. திரும்பப் பெற தட்டவும்.',
    tapTerminal: 'கார்டு இயந்திரம் என்ன சொன்னது?',
    approved: 'ஏற்கப்பட்டது', declined: 'மறுக்கப்பட்டது', noAnswer: 'பதில் இல்லை',
    declinedMsg: 'பணம் மறுக்கப்பட்டது. விற்பனை முடியவில்லை — பொருட்களைக் கொடுக்க வேண்டாம். வேறு முறையில் பணம் கேட்கவும்.',
    noAnswerMsg: 'கார்டு இயந்திரம் பதில் சொல்லவில்லை. வாடிக்கையாளர் பணம் செலுத்தினாரா என்று தெரியவில்லை. விற்பனை முடியவில்லை — பொருட்களைக் கொடுக்க வேண்டாம். இயந்திரத்தைச் சரிபார்க்கவும்; தெளிவில்லை என்றால் மேலாளரிடம் கேட்கவும்.',
  },
};
let lang = 'en';
const t = (key) => WORDS[lang][key] ?? WORDS.en[key];

/** Void reasons, preset. Free text at a till is a reason nobody can report on afterwards (M15). */
const VOID_REASONS = [
  { code: 'customer_changed_mind', en: 'Customer changed their mind', ta: 'வாடிக்கையாளர் மனம் மாறினார்' },
  { code: 'scanned_twice', en: 'Scanned twice', ta: 'இருமுறை ஸ்கேன் ஆனது' },
  { code: 'wrong_item', en: 'Wrong item', ta: 'தவறான பொருள்' },
  { code: 'price_query', en: 'Price query', ta: 'விலை சந்தேகம்' },
  { code: 'damaged', en: 'Damaged', ta: 'சேதமடைந்தது' },
];

/**
 * Stand-in with the same surface as the bundled PosSession, so the layout is runnable and
 * usability-testable before the bundler lands. Replaced at build time by the real, tested model —
 * the view never contains a pricing or tender rule.
 */
function demoSession() {
  const lines = [];
  let seq = 0;
  let held = false;
  return {
    scan({ productId, description, unitPriceMinor, qty }) {
      seq += 1;
      lines.push({ lineId: 'L' + seq, productId, description, unitPriceMinor, qty, voided: false });
    },
    setQuantity(lineId, qty) { const l = lines.find((x) => x.lineId === lineId); if (l) l.qty = qty; },
    voidLine(lineId) { const l = lines.find((x) => x.lineId === lineId); if (l) l.voided = true; },
    basket: () => lines.filter((l) => !l.voided).map((l) => ({
      lineId: l.lineId, description: l.description, qty: l.qty,
      amountMinor: l.unitPriceMinor * l.qty, requiresAgeCheck: false,
    })),
    payableMinor: () => lines.filter((l) => !l.voided)
      .reduce((sum, l) => sum + l.unitPriceMinor * l.qty, 0),
    syncBadge: () => ({ connection: 'online', unsentCount: 0 }),
    scanBarcode() { throw new Error('No price list on this lane.'); },
    hasCatalogue: () => false,
    tenderCash: (_id, number) => Promise.resolve(number),
    tenderCardOrUpi: ({ receiptNumber, outcome }) => (outcome === 'approved'
      ? Promise.resolve(receiptNumber)
      : Promise.reject(Object.assign(new Error('not paid'), { notPaid: outcome }))),
    suspend() { held = true; }, recall() { held = false; }, state: () => (held ? 'suspended' : 'selling'),
    newSale() { lines.length = 0; seq = 0; },
  };
}

const session = window.posSession ?? demoSession();
let selectedLineId = null;

// ── The banner ──────────────────────────────────────────────────────────────

/**
 * Say something the cashier must read, and keep saying it.
 *
 * No timeout. The words come from the model wherever there is a model — the session's
 * `laneMessage` is written for a cashier with a customer watching, and rewording it here would put
 * a second, untested version of the most important sentence in the product.
 */
function tell(title, message) {
  el('refusal-title').textContent = title;
  el('refusal-text').textContent = message;
  el('refusal').hidden = false;
  el('refusal-ok').textContent = t('ok');
  el('refusal-ok').focus();
}
el('refusal-ok').addEventListener('click', () => { el('refusal').hidden = true; });

// ── The panel ───────────────────────────────────────────────────────────────

let sheetResolve = null;
let onEntryChange = null;
let chosen = null;

/**
 * Ask the cashier something, on screen.
 *
 * Resolves with the answer, or `null` if cancelled. `mode` is `'number'` (keypad) or `'choice'`
 * (preset buttons) — the two shapes every question at a till actually takes.
 */
function ask({ title, mode, hint = '', initial = '0', onChange = null }) {
  el('sheet-title').textContent = title;
  el('entry-hint').textContent = hint;
  el('entry').textContent = initial;
  el('entry').hidden = mode !== 'number';
  el('keypad').hidden = mode !== 'number';
  el('reasons').hidden = mode !== 'choice';
  el('sheet-cancel').textContent = t('cancel');
  el('sheet-ok').textContent = t('ok');
  onEntryChange = onChange;
  chosen = null;

  if (mode === 'choice') {
    el('reasons').replaceChildren(...VOID_REASONS.map((reason) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = reason[lang] ?? reason.en;
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => {
        for (const other of el('reasons').children) other.setAttribute('aria-pressed', 'false');
        button.setAttribute('aria-pressed', 'true');
        chosen = reason.code;
      });
      return button;
    }));
  }

  el('sheet').hidden = false;
  return new Promise((resolve) => { sheetResolve = resolve; });
}

function closeSheet(answer) {
  el('sheet').hidden = true;
  onEntryChange = null;
  const resolve = sheetResolve;
  sheetResolve = null;
  if (resolve) resolve(answer);
}

// The keypad, built once. `C` and `⌫` are as large as the digits, because correcting a mis-tap is
// as frequent as tapping and a cramped backspace is how a wrong quantity gets committed.
el('keypad').replaceChildren(...['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'].map((key) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = key;
  button.addEventListener('click', () => {
    const current = el('entry').textContent;
    const next = key === 'C' ? '0'
      : key === '⌫' ? (current.length > 1 ? current.slice(0, -1) : '0')
        : (current === '0' ? key : current + key);
    el('entry').textContent = next;
    if (onEntryChange) el('entry-hint').textContent = onEntryChange(Number(next));
  });
  return button;
}));

el('sheet-cancel').addEventListener('click', () => { closeSheet(null); });
el('sheet-ok').addEventListener('click', () => {
  closeSheet(el('reasons').hidden ? el('entry').textContent : chosen);
});

/**
 * Ask how the customer is paying, or what the machine said.
 *
 * A separate panel from `ask` because this is a **choice between three big things** with nothing
 * else on screen. It is the moment a cashier is most watched and least able to hunt for a control.
 */
function choose(title, options) {
  el('pay-title').textContent = title;
  el('pay-kinds').replaceChildren(...options.map((option) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = option.label;
    button.addEventListener('click', () => { el('pay').hidden = true; payResolve?.(option.value); payResolve = null; });
    return button;
  }));
  el('pay-cancel').textContent = t('cancel');
  el('pay').hidden = false;
  return new Promise((resolve) => { payResolve = resolve; });
}
let payResolve = null;
el('pay-cancel').addEventListener('click', () => { el('pay').hidden = true; payResolve?.(null); payResolve = null; });

// ── Rendering ───────────────────────────────────────────────────────────────

function render() {
  const lines = session.basket();
  el('lines').replaceChildren(...lines.map((line) => {
    const row = document.createElement('tr');
    if (line.lineId === selectedLineId) row.setAttribute('aria-selected', 'true');
    row.tabIndex = 0;
    row.addEventListener('click', () => { selectedLineId = line.lineId; render(); });
    for (const [text, cls] of [
      [line.description, ''], [String(line.qty), 'amount'], [inr(line.amountMinor), 'amount'],
    ]) {
      const cell = document.createElement('td');
      cell.textContent = text;
      if (cls) cell.className = cls;
      row.appendChild(cell);
    }
    return row;
  }));

  const suspended = session.state && session.state() === 'suspended';
  el('hold').textContent = suspended ? t('recall') : t('hold');
  el('empty').hidden = lines.length > 0 && !suspended;
  // A held basket must SAY it is held. A screen showing an empty basket when one is parked is how
  // the same customer's items get rung up twice.
  el('empty').textContent = suspended ? t('onHold') : t('scanToBegin');
  el('total').textContent = inr(session.payableMinor());

  const badge = session.syncBadge();
  const offline = badge.connection !== 'online';
  el('conn-dot').classList.toggle('offline', offline);
  // Words as well as a dot. A colour-only badge is invisible to one man in twelve, and this badge
  // is how a cashier knows whether the shop is behind.
  el('conn-text').textContent = offline ? t('offline') : t('online');
  el('unsent').textContent = `${t('unsent')}: ${badge.unsentCount}`;
}

// ── Cashier intents ─────────────────────────────────────────────────────────

el('qty').addEventListener('click', async () => {
  if (!selectedLineId) { tell(t('read'), t('tapLineFirst')); return; }
  const answer = await ask({ title: t('quantity'), mode: 'number', initial: '1' });
  if (answer === null) return;
  const qty = Number(answer);
  if (!Number.isInteger(qty) || qty <= 0) return;
  session.setQuantity(selectedLineId, qty);
  render();
});

el('void').addEventListener('click', async () => {
  if (!selectedLineId) { tell(t('read'), t('tapLineFirst')); return; }
  // A reason is mandatory (M15) and it is chosen, not typed.
  const reason = await ask({ title: t('reasonForVoid'), mode: 'choice' });
  if (!reason) return;
  session.voidLine(selectedLineId, reason);
  selectedLineId = null;
  render();
});

el('hold').addEventListener('click', () => {
  const suspended = session.state && session.state() === 'suspended';
  if (suspended) session.recall(); else session.suspend();
  selectedLineId = null;
  render();
});

el('tender').addEventListener('click', async () => {
  const payable = session.payableMinor();
  if (payable <= 0) { tell(t('read'), t('scanFirst')); return; }

  const kind = await choose(t('howPaying'), [
    { value: 'cash', label: `${t('cash')} — ${inr(payable)}` },
    { value: 'card', label: `${t('card')} — ${inr(payable)}` },
    { value: 'upi', label: `${t('upi')} — ${inr(payable)}` },
  ]);
  if (kind === null) return;
  if (kind !== 'cash') return takeCardOrUpi(kind, payable);

  const changeFor = (rupees) => Math.round(rupees * 100) - payable;
  const received = await ask({
    title: `${t('cashReceived')} — ${inr(payable)}`,
    mode: 'number',
    hint: `${t('notEnough')} ${inr(payable)}`,
    onChange: (rupees) => (changeFor(rupees) < 0
      ? `${t('notEnough')} ${inr(-changeFor(rupees))}`
      : `${t('changeDue')}: ${inr(changeFor(rupees))}`),
  });
  if (received === null) return;
  const change = changeFor(Number(received));
  if (change < 0) return; // the panel already said so, in words, as they typed

  const stamp = Date.now().toString(36);
  try {
    // Awaited, and the await is the guarantee: the receipt number does not exist until the sale is
    // on this till's disk (hard rule #1). There is nothing to print with before then.
    const receipt = await session.tenderCash(`S-${stamp}`, `R-${stamp.toUpperCase()}`, new Date().toISOString());
    tell(`${t('changeDue')}: ${inr(change)}`, receipt);
    session.newSale();
    selectedLineId = null;
    render();
  } catch (e) {
    // The model's words, unchanged.
    tell(t('read'), e && e.laneMessage ? e.laneMessage : String(e && e.message ? e.message : e));
  }
});

/**
 * Card or UPI.
 *
 * The cashier tells the screen what the **machine** said, because the terminal is a separate box
 * and the till has no wire to it yet. Three answers, and the third is the one that matters: when
 * the machine has not come back, the honest state is *we do not know*, and the model marks that
 * tender `uncertain` so the sale cannot complete. The goods stay on the counter.
 *
 * Treating silence as success is how a shop hands over a trolley for a payment that never
 * happened, and the pressure to do it is highest exactly when it is worst — a customer waiting and
 * a queue behind them.
 */
async function takeCardOrUpi(kind, payable) {
  const outcome = await choose(`${t('tapTerminal')} — ${inr(payable)}`, [
    { value: 'approved', label: t('approved') },
    { value: 'declined', label: t('declined') },
    { value: 'no_answer', label: t('noAnswer') },
  ]);
  if (outcome === null) return;

  if (outcome !== 'approved') {
    // Said before anything is attempted, because there is nothing to attempt: an unpaid sale does
    // not commit, and the cashier needs the instruction, not the error.
    tell(t('read'), outcome === 'declined' ? t('declinedMsg') : t('noAnswerMsg'));
    return;
  }

  const stamp = Date.now().toString(36);
  try {
    const receipt = await session.tenderCardOrUpi({
      saleId: `S-${stamp}`, receiptNumber: `R-${stamp.toUpperCase()}`,
      atIsoUtc: new Date().toISOString(), kind, outcome,
    });
    tell(`${t('approved')} — ${kind === 'card' ? t('card') : t('upi')}`, receipt);
    session.newSale();
    selectedLineId = null;
    render();
  } catch (e) {
    tell(t('read'), e && e.laneMessage ? e.laneMessage : String(e && e.message ? e.message : e));
  }
}

el('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  el('qty').textContent = t('qty');
  el('void').textContent = t('void');
  el('tender').textContent = t('tender');
  el('pay-cancel').textContent = t('cancel');
  render();
});

el('unsent').addEventListener('click', () => {
  const badge = session.syncBadge();
  tell(`${t('unsent')}: ${badge.unsentCount}`, badge.unsentCount === 0
    ? t('allSent')
    : `${badge.unsentCount} sale(s) are saved on this lane and waiting to be sent. Nothing is lost — they go as soon as there is a connection.`);
});

// ── The scanner ─────────────────────────────────────────────────────────────
//
// A retail barcode scanner is a keyboard: it types the digits very fast and presses Enter. So there
// is deliberately **no input box to focus** — losing focus is how a scan goes into whatever was
// last tapped, which at a till is a quantity field, and a barcode typed into a quantity is a sale
// of nine hundred million units. Digits are collected globally and flushed on Enter.
let scanBuffer = '';
window.addEventListener('keydown', (event) => {
  // A panel is open; the scan is not for us.
  if (!el('sheet').hidden || !el('pay').hidden || !el('refusal').hidden) return;
  if (event.key === 'Enter') {
    const code = scanBuffer;
    scanBuffer = '';
    if (code.length < 6) return; // a person pressing Enter, not a scanner
    if (!session.hasCatalogue()) { tell(t('read'), t('noCatalogue')); return; }
    try {
      session.scanBarcode(code);
      render();
    } catch (e) {
      tell(t('read'), String(e && e.message ? e.message : e));
    }
    return;
  }
  if (/^[0-9]$/.test(event.key)) scanBuffer += event.key;
});

render();
