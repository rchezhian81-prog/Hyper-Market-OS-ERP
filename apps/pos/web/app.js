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
    staleShell: 'No connection to the store computer. Billing still works. This price list is what this lane was last given, at',
    scanToBegin: 'Scan an item to begin.', qty: 'Qty', void: 'Void', tender: 'Tender',
    cancel: 'Cancel', ok: 'OK', quantity: 'Quantity', cashReceived: 'Cash received',
    changeDue: 'Change due', online: 'Online', offline: 'Offline', unsent: 'Unsent',
    reasonForVoid: 'Reason for void', tapLineFirst: 'Tap a line first.',
    scanFirst: 'Scan an item first.', read: 'Please read this',
    notEnough: 'Not enough — the customer still owes',
    receiptsUsedUp: 'This till has used all its receipt numbers. Do not take money — tell the manager to load a new number range.',
    allSent: 'Everything on this lane has reached the cloud.',
    noCatalogue: 'This lane has no price list loaded, so it cannot scan. Tell the manager.',
    hold: 'Hold', recall: 'Recall', held: 'Basket held',
    howPaying: 'How is the customer paying?', cash: 'Cash', card: 'Card', upi: 'UPI',
    onHold: 'A basket is on hold. Tap Recall to bring it back.',
    tapTerminal: 'What did the card machine say?',
    approved: 'Approved', declined: 'Declined', noAnswer: 'It has not answered',
    more: 'More', pickup: 'Cash to safe', closeTill: 'Close till', refund: 'Refund',
    countDrawer: 'Count the drawer', counted: 'Counted', closeTillNow: 'Close till',
    amountToSafe: 'How much is going to the safe?', movedToSafe: 'Moved to the safe',
    over: 'Over by', short: 'Short by', balanced: 'The drawer balances exactly.',
    needsReason: 'This difference is large enough that a manager must be told. Do not put the money away — call the manager now.',
    countHint: 'Count what is actually in the drawer. Nothing on this screen tells you what it should be — that is on purpose.',
    refundFind: 'Scan the receipt, or key the bill number',
    refundFindHint: 'Scan the barcode on the customer receipt, or type the bill number and press OK',
    refundLookupFailed: 'Could not reach the store to look up that bill. Try again, or use another lane.',
    refundNotFound: 'No bill with that number was rung on this lane. Check the number, or look it up at the service desk.',
    refundNothingLeft: 'Everything on this bill has already been returned. Nothing more can come back.',
    refundWhichItem: 'Which item is coming back?',
    refundCanReturn: 'can return',
    refundHowMany: 'How many are coming back?',
    refundBadQty: 'That is more than can come back on this bill. Check the number.',
    refundReason: 'Why is it coming back?',
    refundAmount: 'How much to refund?',
    refundMax: 'Most you can refund',
    refundTooMuch: 'That is more than this bill allows —',
    refundGiving: 'Refunding',
    refundHow: 'How is the refund given?',
    storeCredit: 'Store credit',
    refundCondition: 'What condition is the item in?',
    dispResell: 'Good — back on the shelf',
    dispDamaged: 'Damaged — not for sale',
    refundManagerId: 'Manager: scan your badge or key your staff code',
    refundManagerHint: 'A different person from the cashier must approve a refund',
    refundNeedManager: 'A manager must approve this refund. Ask a manager — not yourself.',
    refundApproveReason: 'Manager: why is this refund approved?',
    refundDone: 'Refund recorded',
    refundPending: 'Refund pending',
    refundStop: 'Do not hand over cash',
    declinedMsg: 'The payment was declined. The sale is NOT complete — do not hand over the goods. Ask for another payment method.',
    noAnswerMsg: 'The card machine has not answered, so we do not know whether the customer has paid. The sale is NOT complete — do not hand over the goods. Check the machine, and if it is unclear, ask the manager before trying again.',
  },
  ta: {
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. பில் போடுவது வேலை செய்யும். இந்த விலைப் பட்டியல் இந்த லேனுக்குக் கடைசியாகக் கொடுக்கப்பட்டது:',
    scanToBegin: 'தொடங்க ஒரு பொருளை ஸ்கேன் செய்யவும்.', qty: 'எண்ணிக்கை', void: 'நீக்கு',
    tender: 'பணம் பெறு', cancel: 'ரத்து', ok: 'சரி', quantity: 'எண்ணிக்கை',
    cashReceived: 'பெற்ற பணம்', changeDue: 'மீதம் தர வேண்டியது', online: 'இணைப்பில்',
    offline: 'இணைப்பு இல்லை', unsent: 'அனுப்பப்படாதவை', reasonForVoid: 'நீக்கக் காரணம்',
    tapLineFirst: 'முதலில் ஒரு வரியைத் தொடவும்.', scanFirst: 'முதலில் ஒரு பொருளை ஸ்கேன் செய்யவும்.',
    read: 'இதைப் படிக்கவும்', notEnough: 'போதவில்லை — வாடிக்கையாளர் இன்னும் தர வேண்டியது',
    receiptsUsedUp: 'இந்த பணப்பெட்டியின் ரசீது எண்கள் முடிந்துவிட்டன. பணம் வாங்க வேண்டாம் — புதிய எண் வரம்பை ஏற்ற மேலாளரிடம் சொல்லவும்.',
    allSent: 'இந்த லேனில் உள்ள அனைத்தும் அனுப்பப்பட்டுவிட்டன.',
    noCatalogue: 'இந்த லேனில் விலைப் பட்டியல் இல்லை. மேலாளரிடம் சொல்லவும்.',
    hold: 'நிறுத்து', recall: 'திரும்பப் பெறு', held: 'கூடை நிறுத்தப்பட்டது',
    howPaying: 'வாடிக்கையாளர் எவ்வாறு பணம் தருகிறார்?', cash: 'ரொக்கம்', card: 'கார்டு', upi: 'UPI',
    onHold: 'ஒரு கூடை நிறுத்தி வைக்கப்பட்டுள்ளது. திரும்பப் பெற தட்டவும்.',
    tapTerminal: 'கார்டு இயந்திரம் என்ன சொன்னது?',
    approved: 'ஏற்கப்பட்டது', declined: 'மறுக்கப்பட்டது', noAnswer: 'பதில் இல்லை',
    more: 'மேலும்', pickup: 'பணத்தை பெட்டகத்திற்கு', closeTill: 'டில்லை மூடு', refund: 'திரும்பப் பணம்',
    countDrawer: 'டிராயரை எண்ணவும்', counted: 'எண்ணப்பட்டது', closeTillNow: 'டில்லை மூடு',
    amountToSafe: 'பெட்டகத்திற்கு எவ்வளவு?', movedToSafe: 'பெட்டகத்திற்கு மாற்றப்பட்டது',
    over: 'அதிகம்', short: 'குறைவு', balanced: 'டிராயர் சரியாக உள்ளது.',
    needsReason: 'இந்த வித்தியாசம் பெரியது. மேலாளரிடம் சொல்ல வேண்டும். பணத்தை வைக்க வேண்டாம் — உடனே மேலாளரை அழைக்கவும்.',
    countHint: 'டிராயரில் உள்ளதை எண்ணவும். எவ்வளவு இருக்க வேண்டும் என்பதை இந்தத் திரை சொல்லாது — அது வேண்டுமென்றே.',
    refundFind: 'ரசீதை ஸ்கேன் செய்யவும், அல்லது பில் எண்ணை உள்ளிடவும்',
    refundFindHint: 'வாடிக்கையாளர் ரசீதில் உள்ள பார்கோடை ஸ்கேன் செய்யவும், அல்லது பில் எண்ணை உள்ளிட்டு சரி அழுத்தவும்',
    refundLookupFailed: 'அந்த பில்லைப் பார்க்க கடை கணினியை அணுக முடியவில்லை. மீண்டும் முயற்சிக்கவும், அல்லது வேறு லேனைப் பயன்படுத்தவும்.',
    refundNotFound: 'அந்த எண்ணில் இந்த லேனில் எந்த பில்லும் இல்லை. எண்ணைச் சரிபார்க்கவும், அல்லது சேவை மையத்தில் பார்க்கவும்.',
    refundNothingLeft: 'இந்த பில்லில் உள்ள அனைத்தும் ஏற்கனவே திரும்பப் பெறப்பட்டன. மேலும் எதுவும் திரும்ப முடியாது.',
    refundWhichItem: 'எந்தப் பொருள் திரும்புகிறது?',
    refundCanReturn: 'திரும்ப முடியும்',
    refundHowMany: 'எத்தனை திரும்புகின்றன?',
    refundBadQty: 'இந்த பில்லில் திரும்ப முடிந்ததை விட அதிகம். எண்ணைச் சரிபார்க்கவும்.',
    refundReason: 'ஏன் திரும்புகிறது?',
    refundAmount: 'எவ்வளவு திரும்பத் தர வேண்டும்?',
    refundMax: 'திரும்பத் தரக்கூடிய அதிகபட்சம்',
    refundTooMuch: 'இந்த பில் அனுமதிப்பதை விட அதிகம் —',
    refundGiving: 'திரும்பத் தருவது',
    refundHow: 'திரும்பப் பணம் எப்படித் தரப்படுகிறது?',
    storeCredit: 'கடை வரவு',
    refundCondition: 'பொருளின் நிலை என்ன?',
    dispResell: 'நல்லது — அலமாரிக்குத் திரும்ப',
    dispDamaged: 'சேதம் — விற்பனைக்கு அல்ல',
    refundManagerId: 'மேலாளர்: உங்கள் அடையாள அட்டையை ஸ்கேன் செய்யவும் அல்லது ஊழியர் குறியீட்டை உள்ளிடவும்',
    refundManagerHint: 'திரும்பப் பணத்தை காசாளர் அல்லாத வேறு ஒருவர் அனுமதிக்க வேண்டும்',
    refundNeedManager: 'இந்த திரும்பப் பணத்தை ஒரு மேலாளர் அனுமதிக்க வேண்டும். உங்களை அல்ல — ஒரு மேலாளரிடம் கேளுங்கள்.',
    refundApproveReason: 'மேலாளர்: இந்த திரும்பப் பணம் ஏன் அனுமதிக்கப்படுகிறது?',
    refundDone: 'திரும்பப் பணம் பதிவு செய்யப்பட்டது',
    refundPending: 'திரும்பப் பணம் நிலுவையில்',
    refundStop: 'பணத்தைக் கொடுக்க வேண்டாம்',
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

/** Refund reasons, preset — free text at a till is a reason nobody can report on afterwards (M15). */
const REFUND_REASONS = [
  { code: 'damaged', en: 'Damaged / faulty', ta: 'சேதம் / குறை' },
  { code: 'wrong_item', en: 'Wrong item', ta: 'தவறான பொருள்' },
  { code: 'not_needed', en: 'No longer needed', ta: 'இனி தேவையில்லை' },
  { code: 'expired', en: 'Expired / out of date', ta: 'காலாவதி ஆனது' },
  { code: 'other', en: 'Other', ta: 'மற்றவை' },
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
    nextReceipt: () => 'R-' + Date.now().toString(36).toUpperCase(),
    tenderCash: (_id, number) => Promise.resolve(number),
    tenderCardOrUpi: ({ receiptNumber, outcome }) => (outcome === 'approved'
      ? Promise.resolve(receiptNumber)
      : Promise.reject(Object.assign(new Error('not paid'), { notPaid: outcome }))),
    suspend() { held = true; }, recall() { held = false; }, state: () => (held ? 'suspended' : 'selling'),
    newSale() { lines.length = 0; seq = 0; },
    // No real bills without the bundle, so a refund lookup finds nothing — the screen says so
    // honestly rather than pretending. The real, tested surface replaces this at build time.
    lookupRefund: () => Promise.resolve(null),
    till: {
      moveCash: ({ amountMinor }) => ({ tillBalance: { minor: -amountMinor } }),
      close: ({ countedMinor }) => ({
        countedCash: { minor: countedMinor }, variance: { minor: 0 },
        exceptionRaised: false, withinTolerance: true,
      }),
    },
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
function ask({ title, mode, hint = '', initial = '0', onChange = null, choices = VOID_REASONS }) {
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
    el('reasons').replaceChildren(...choices.map((reason) => {
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
  el('more').textContent = t('more');
  el('pay').hidden = false;
  return new Promise((resolve) => { payResolve = resolve; });
}
let payResolve = null;
el('pay-cancel').addEventListener('click', () => { el('pay').hidden = true; payResolve?.(null); payResolve = null; });

/** Indian notes and coins in paise, largest first — the order a drawer is counted in. */
const DENOMS = [50_000, 20_000, 10_000, 5_000, 2_000, 1_000, 500, 200, 100];

let countResolve = null;

/**
 * Count the drawer, by denomination.
 *
 * **The expected total appears nowhere on this panel**, and that is the entire design. Shown
 * "expected: ₹6,000", people write ₹6,000 — not from dishonesty, but because a number on a screen
 * is an answer and counting is work. A cash-up anchored to the expectation finds nothing, which is
 * the one thing a cash-up exists to do. Same control as the stock count.
 */
function countDrawer() {
  const counts = new Map(DENOMS.map((value) => [value, 0]));
  const total = () => [...counts].reduce((sum, [value, n]) => sum + value * n, 0);

  const paint = () => {
    el('count-total').textContent = `${t('counted')}: ${inr(total())}`;
    for (const value of DENOMS) el(`n-${value}`).textContent = String(counts.get(value));
  };

  el('denoms').replaceChildren(...DENOMS.map((value) => {
    const row = document.createElement('div');
    row.className = 'denom';
    const label = document.createElement('span');
    label.textContent = inr(value);
    const minus = document.createElement('button');
    minus.type = 'button';
    minus.textContent = '−';
    minus.setAttribute('aria-label', `one fewer ${inr(value)}`);
    const shown = document.createElement('span');
    shown.className = 'n';
    shown.id = `n-${value}`;
    shown.textContent = '0';
    const plus = document.createElement('button');
    plus.type = 'button';
    plus.textContent = '+';
    plus.setAttribute('aria-label', `one more ${inr(value)}`);
    minus.addEventListener('click', () => { counts.set(value, Math.max(0, counts.get(value) - 1)); paint(); });
    plus.addEventListener('click', () => { counts.set(value, counts.get(value) + 1); paint(); });
    row.append(label, minus, shown, plus);
    return row;
  }));

  el('count-title').textContent = t('countDrawer');
  el('count-hint').textContent = t('countHint');
  el('count-cancel').textContent = t('cancel');
  el('count-ok').textContent = t('closeTillNow');
  paint();
  el('count').hidden = false;
  return new Promise((resolve) => {
    countResolve = (accepted) => resolve(accepted ? total() : null);
  });
}
el('count-cancel').addEventListener('click', () => { el('count').hidden = true; countResolve?.(false); countResolve = null; });
el('count-ok').addEventListener('click', () => { el('count').hidden = true; countResolve?.(true); countResolve = null; });

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

  // The receipt number is drawn from this lane's gap-free reserved range (M01-FR-02). If the range
  // is spent the till stops rather than reuse a number — no money is taken, the manager is told.
  let receiptNumber;
  try {
    receiptNumber = session.nextReceipt ? session.nextReceipt() : `R-${Date.now().toString(36).toUpperCase()}`;
  } catch {
    tell(t('read'), t('receiptsUsedUp'));
    return;
  }
  try {
    // Awaited, and the await is the guarantee: the receipt number does not exist until the sale is
    // on this till's disk (hard rule #1). There is nothing to print with before then.
    const receipt = await session.tenderCash(`S-${receiptNumber}`, receiptNumber, new Date().toISOString());
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

  let receiptNumber;
  try {
    receiptNumber = session.nextReceipt ? session.nextReceipt() : `R-${Date.now().toString(36).toUpperCase()}`;
  } catch {
    tell(t('read'), t('receiptsUsedUp'));
    return;
  }
  try {
    const receipt = await session.tenderCardOrUpi({
      saleId: `S-${receiptNumber}`, receiptNumber,
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

el('more').addEventListener('click', async () => {
  const what = await choose(t('more'), [
    { value: 'pickup', label: t('pickup') },
    { value: 'refund', label: t('refund') },
    { value: 'close', label: t('closeTill') },
  ]);
  if (what === 'pickup') return takeCashToSafe();
  if (what === 'refund') return startRefund();
  if (what === 'close') return closeTheTill();
});

async function takeCashToSafe() {
  const amount = await ask({ title: t('amountToSafe'), mode: 'number' });
  if (amount === null) return;
  const minor = Math.round(Number(amount) * 100);
  if (minor <= 0) return;
  try {
    session.till.moveCash({ kind: 'pickup', amountMinor: minor, at: new Date().toISOString() });
    tell(t('movedToSafe'), inr(minor));
  } catch (e) {
    tell(t('read'), String(e && e.message ? e.message : e));
  }
}

/**
 * Ask for a receipt number or a staff code — SCANNED or keyed (the owner chose both). The receipt
 * carries a barcode and a staff badge carries a barcode, so a scan (fast keystrokes ending in Enter)
 * resolves at once; the on-screen number pad is the fallback for keying it by hand. The scan capture
 * is SCOPED to this panel and removed when it closes, so it never leaks into the sale screen's global
 * scanner (which stays off while a panel is open).
 */
function askScanOrKey({ title, hint = '' }) {
  return new Promise((resolve) => {
    let done = false;
    let buffer = '';
    const finish = (value) => {
      if (done) return;
      done = true;
      window.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === 'Enter') {
        const code = buffer;
        buffer = '';
        if (code.length >= 4) { closeSheet(null); finish(code); } // a scanner, not a person
        return;
      }
      if (/^[A-Za-z0-9._-]$/.test(event.key)) buffer += event.key;
    };
    window.addEventListener('keydown', onKey, true);
    // The keypad sheet is the manual fallback; whichever answers first wins.
    ask({ title, mode: 'number', hint }).then((typed) => finish(typed));
  });
}

/**
 * The refund. Money leaves the drawer, so honesty beats speed at every step and every rule is
 * enforced behind this view (M13). This file assembles the cashier's answers and shows the outcome —
 * it decides nothing: `lookupRefund` reads the bill from this lane's own disk, and `submit` runs the
 * tested refund engine + the till's durable-first write. Every outcome is the model's own words.
 */
async function startRefund() {
  // 1. Find the bill — scan the receipt, or key the bill number.
  const receipt = await askScanOrKey({ title: t('refundFind'), hint: t('refundFindHint') });
  if (receipt === null || receipt === '' || receipt === '0') return;

  let bill;
  try {
    bill = await session.lookupRefund(String(receipt));
  } catch {
    tell(t('refundStop'), t('refundLookupFailed'));
    return;
  }
  if (!bill) { tell(t('read'), t('refundNotFound')); return; }

  const returnable = bill.returnable.filter((l) => l.returnableMinor > 0);
  if (returnable.length === 0) { tell(t('read'), t('refundNothingLeft')); return; }

  // 2. Which item, and how many — capped at what is still returnable on the bill.
  const productId = await choose(t('refundWhichItem'), returnable.map((l) => ({
    value: l.productId, label: `${l.productId} — ${t('refundCanReturn')} ${l.returnableMinor}`,
  })));
  if (productId === null) return;
  const line = returnable.find((l) => l.productId === productId);

  const qtyAns = await ask({
    title: t('refundHowMany'), mode: 'number', initial: '1',
    hint: `${t('refundCanReturn')}: ${line.returnableMinor}`,
  });
  if (qtyAns === null) return;
  const qty = Number(qtyAns);
  if (!Number.isInteger(qty) || qty <= 0 || qty > line.returnableMinor) { tell(t('read'), t('refundBadQty')); return; }

  // 3. Reason (chosen, never typed — M15), and the condition the goods come back in (M13-FR-02).
  const reason = await ask({ title: t('refundReason'), mode: 'choice', choices: REFUND_REASONS });
  if (!reason) return;

  const disposition = await choose(t('refundCondition'), [
    { value: 'resell', label: t('dispResell') },
    { value: 'damaged', label: t('dispDamaged') },
  ]);
  if (disposition === null) return;

  // 4. The amount — shown against the ceiling as they type; the engine caps it too (M13-FR-03).
  const amount = await ask({
    title: t('refundAmount'), mode: 'number',
    hint: `${t('refundMax')}: ${inr(bill.maxRefundMinor)}`,
    onChange: (rupees) => (Math.round(rupees * 100) > bill.maxRefundMinor
      ? `${t('refundTooMuch')} ${inr(bill.maxRefundMinor)}`
      : `${t('refundGiving')}: ${inr(Math.round(rupees * 100))}`),
  });
  if (amount === null) return;
  const refundMinor = Math.round(Number(amount) * 100);
  if (refundMinor <= 0) return;

  const refundTender = await choose(t('refundHow'), [
    { value: 'cash', label: t('cash') },
    { value: 'card', label: t('card') },
    { value: 'upi', label: t('upi') },
    { value: 'store_credit', label: t('storeCredit') },
  ]);
  if (refundTender === null) return;

  // 5. A manager approves where the policy requires it (§28). The default is every refund; a manager
  // scans their badge or keys their staff code — a DIFFERENT person from the cashier, which the engine
  // enforces and the cloud re-verifies on sync.
  let approval;
  if (bill.needsApproval(refundMinor)) {
    const by = await askScanOrKey({ title: t('refundManagerId'), hint: t('refundManagerHint') });
    if (by === null || by === '' || by === '0') { tell(t('read'), t('refundNeedManager')); return; }
    const approveReason = await ask({ title: t('refundApproveReason'), mode: 'choice', choices: REFUND_REASONS });
    if (!approveReason) return;
    approval = { by: String(by), reason: approveReason };
  }

  // 6. The refund's own document number, from this lane's gap-free range, and its operation identity
  // (the idempotency key — a retry under the same id can never refund twice, RR-F03).
  let number;
  try {
    number = session.nextReceipt ? session.nextReceipt() : `R-${Date.now().toString(36).toUpperCase()}`;
  } catch {
    tell(t('read'), t('receiptsUsedUp'));
    return;
  }
  const returnId = `RT-${number}`;

  let outcome;
  try {
    outcome = await bill.submit({
      returnId, number, reasonCode: reason,
      lines: [{ productId, uom: line.uom, quantityMinor: qty, disposition }],
      refundMinor, refundTender,
      ...(approval ? { approval } : {}),
    });
  } catch (e) {
    // submit is written not to throw, but a lost connection to the store can still reject here — treat
    // it as a stop, never as a silent success.
    tell(t('refundStop'), e && e.laneMessage ? e.laneMessage : String(e && e.message ? e.message : e));
    return;
  }
  showRefundOutcome(outcome);
  render();
}

/**
 * One screen state per refund outcome, in the model's OWN words (`laneMessage`). The money-critical
 * four — refused, uncertain, conflict, not entitled — head with "Do not hand over cash", the one
 * instruction that must not be missed; settled and pending get their own headings; anything else is
 * the plain "please read this".
 */
function showRefundOutcome(outcome) {
  const stop = outcome.kind === 'refused' || outcome.kind === 'uncertain'
    || outcome.kind === 'conflict' || outcome.kind === 'not_entitled';
  const title = outcome.kind === 'settled' ? t('refundDone')
    : outcome.kind === 'pending' ? t('refundPending')
      : stop ? t('refundStop')
        : t('read');
  tell(title, outcome.laneMessage);
}

/**
 * Close the till.
 *
 * The count comes first and the expected figure is never on screen before it. What comes back
 * carries the variance, and a material one is not a number to note down — it is an instruction to
 * call the manager before the money is put away.
 */
async function closeTheTill() {
  const counted = await countDrawer();
  if (counted === null) return;
  try {
    const result = session.till.close({
      shiftId: `sh-${Date.now().toString(36)}`,
      closedAt: new Date().toISOString(),
      countedMinor: counted,
    });
    const variance = result.variance.minor;
    const headline = variance === 0 ? t('balanced')
      : variance > 0 ? `${t('over')} ${inr(variance)}`
        : `${t('short')} ${inr(-variance)}`;
    tell(headline, result.exceptionRaised ? t('needsReason') : `${t('counted')}: ${inr(counted)}`);
  } catch {
    // A material variance with no reason is refused by the model. The cashier is told what to DO
    // rather than shown a validation error — the error names a missing field, and at the end of a
    // long shift the instruction is what gets acted on.
    tell(t('read'), t('needsReason'));
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
  if (!el('sheet').hidden || !el('pay').hidden || !el('count').hidden || !el('refusal').hidden) return;
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

// ── The shell's own honesty about where this page came from ─────────────────
//
// The service worker keeps a copy of the last page the store box actually served, so this screen
// still opens when the box cannot be reached. That copy carries the time it was taken, and this
// says so. **A cached page shown as a live one is the fault this product exists to refuse** — it
// is not a stale label on a screen, it is somebody acting on figures from this morning believing
// they are from this minute (P-08).
function paintStale() {
  const at = window.shellCachedAt;
  const strip = el('stale');
  if (!strip) return;
  strip.hidden = at === undefined;
  if (at === undefined) return;
  // The device's own local time, because the person reading it is standing in the shop.
  strip.textContent = `${t('staleShell')} ${new Date(at).toLocaleString()}`;
}
paintStale();
el('lang').addEventListener('click', paintStale);

// The shell existed and nothing ever registered it, so nothing was ever cached and every one of
// these screens fell back to its sample data the moment the box was unreachable.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
