// Driver's phone — the view layer. It renders the assigned route and dispatches what the driver
// does at a doorstep; every rule lives in the TESTED session model
// (`apps/delivery-app/src/route-session.ts`), attached as `window.routeSession`.
//
// ── What this file exists to hold ───────────────────────────────────────────
//
// **1. Cash is the thing that has to be right.** The amount to collect is the biggest element on a
// stop, and the collected amount is asked for on its own screen with a keypad, not buried in a
// form. A driver mis-reading ₹2,500 as ₹250 at a doorstep is not a display bug, it is money.
//
// **2. Nothing is delivered without proof.** The model refuses it. This screen asks for the proof
// FIRST, so the order of events on the phone is the same as the order of events on the doorstep.
//
// **3. Card is not offered at all.** COD is cash or UPI (hard rule #3). The engine refuses a card
// method; the screen never presents one, so the refusal is something a driver cannot walk into.
//
// **4. The cash count at handover is blind.** The driver is never shown what they should be
// holding before they count it — the same control the till drawer and the stock count use. Shown
// "you should have ₹6,000", people hand over ₹6,000 and count nothing.
//
// **5. No `prompt`, `confirm` or `alert`, and the banner does not fade.**
//
// Nothing here calls the network. Every stop is local and queues to the device (§31 delivery row).

const el = (id) => document.getElementById(id);

const inr = (minor) =>
  '₹' + (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── Words ───────────────────────────────────────────────────────────────────

const WORDS = {
  en: {
    staleShell: 'No signal. This is the route this phone was last given, at',
    myRoute: 'My route', stopsDone: 'stops done', waiting: 'waiting to sync', allSent: 'everything sent',
    cashCarrying: 'Cash you are carrying', collect: 'Collect', prepaid: 'Already paid',
    delivered: 'Delivered', couldNotDeliver: 'Could not deliver', endOfShift: 'End of shift — hand cash over',
    cancel: 'Cancel', ok: 'OK', read: 'Please read this',
    tapStopFirst: 'Tap the stop you are at first.',
    howProved: 'How did you prove the delivery?', photo: 'Photo at the door', otp: 'Customer’s OTP',
    signature: 'Customer signed', proofRef: 'Enter the OTP or reference',
    howPaid: 'How did the customer pay?', cash: 'Cash', upi: 'UPI',
    howMuchCollected: 'How much did you collect?', expected: 'Order says',
    collectedLess: 'That is less than the order says. It will be reported as short — that is fine if it is what happened.',
    collectedMore: 'That is more than the order says. It will be reported as over.',
    deliveredOk: 'Delivered', failedOk: 'Recorded as not delivered',
    whyFailed: 'Why could you not deliver?', nobodyIn: 'Nobody at home', refused: 'Customer refused it',
    wrongAddress: 'Address is wrong', cannotFind: 'Cannot find the address', noCash: 'Customer had no cash',
    damagedGoods: 'Goods damaged on the way',
    thenWhat: 'What happens to it now?', tryAgain: 'Try again later today', backToStore: 'Take it back to the store',
    countCash: 'Count the cash', countHint: 'Count what is actually in your bag. Nothing on this screen tells you the number to match — that is on purpose.',
    counted: 'Counted', handOver: 'Hand over',
    balanced: 'The cash matches exactly.', over: 'You have more than the day recorded, by',
    short: 'You have less than the day recorded, by',
    materialVariance: 'This difference is big enough that the cash office must be told. Do not hand the money over until somebody from the office is with you.',
    noRoute: 'No route has been given to this phone yet.',
    noRouteBody: 'Nothing is wrong. When a route is assigned to you it will appear here on its own.',
    sampleRoute: 'Sample route — this is not real work.',
    contributionFlag: 'stop(s) cost more to deliver than the rule allows — the office has been told.',
    noProof: 'A delivery is not complete without proof. Take a photo, get the OTP, or get a signature.',
    stopDone: 'That stop is already finished.',
    outForDelivery: 'On the way', assigned: 'Waiting', failedState: 'Not delivered', returnedState: 'Back to store',
    deliveredState: 'Delivered',
  },
  ta: {
    staleShell: 'சிக்னல் இல்லை. இந்த ஃபோனுக்குக் கடைசியாகக் கொடுக்கப்பட்ட வழி இதுதான்:',
    myRoute: 'என் வழி', stopsDone: 'நிறுத்தங்கள் முடிந்தன', waiting: 'அனுப்பக் காத்திருக்கிறது', allSent: 'அனைத்தும் அனுப்பப்பட்டன',
    cashCarrying: 'நீங்கள் வைத்திருக்கும் பணம்', collect: 'வாங்க வேண்டியது', prepaid: 'ஏற்கனவே செலுத்தப்பட்டது',
    delivered: 'கொடுக்கப்பட்டது', couldNotDeliver: 'கொடுக்க முடியவில்லை', endOfShift: 'ஷிப்ட் முடிவு — பணத்தை ஒப்படை',
    cancel: 'ரத்து', ok: 'சரி', read: 'இதைப் படிக்கவும்',
    tapStopFirst: 'முதலில் நீங்கள் இருக்கும் நிறுத்தத்தைத் தொடவும்.',
    howProved: 'கொடுத்ததை எப்படி நிரூபித்தீர்கள்?', photo: 'வாசலில் புகைப்படம்', otp: 'வாடிக்கையாளரின் OTP',
    signature: 'வாடிக்கையாளர் கையொப்பம்', proofRef: 'OTP அல்லது குறிப்பை உள்ளிடவும்',
    howPaid: 'வாடிக்கையாளர் எப்படி பணம் தந்தார்?', cash: 'ரொக்கம்', upi: 'UPI',
    howMuchCollected: 'எவ்வளவு வாங்கினீர்கள்?', expected: 'ஆர்டரில் உள்ளது',
    collectedLess: 'இது ஆர்டரில் உள்ளதை விடக் குறைவு. குறைவாகப் பதிவு செய்யப்படும் — நடந்தது அதுவென்றால் பரவாயில்லை.',
    collectedMore: 'இது ஆர்டரில் உள்ளதை விட அதிகம். அதிகமாகப் பதிவு செய்யப்படும்.',
    deliveredOk: 'கொடுக்கப்பட்டது', failedOk: 'கொடுக்கவில்லை என்று பதிவானது',
    whyFailed: 'ஏன் கொடுக்க முடியவில்லை?', nobodyIn: 'வீட்டில் யாரும் இல்லை', refused: 'வாடிக்கையாளர் மறுத்தார்',
    wrongAddress: 'முகவரி தவறு', cannotFind: 'முகவரியைக் கண்டுபிடிக்க முடியவில்லை', noCash: 'வாடிக்கையாளரிடம் பணம் இல்லை',
    damagedGoods: 'வழியில் பொருள் சேதமானது',
    thenWhat: 'இப்போது இதை என்ன செய்வது?', tryAgain: 'இன்று மீண்டும் முயற்சி', backToStore: 'கடைக்குத் திருப்பி',
    countCash: 'பணத்தை எண்ணவும்', countHint: 'உங்கள் பையில் உள்ளதை எண்ணவும். எவ்வளவு இருக்க வேண்டும் என்று இந்தத் திரை சொல்லாது — அது வேண்டுமென்றே.',
    counted: 'எண்ணப்பட்டது', handOver: 'ஒப்படை',
    balanced: 'பணம் சரியாகப் பொருந்துகிறது.', over: 'பதிவானதை விட அதிகம்',
    short: 'பதிவானதை விடக் குறைவு',
    materialVariance: 'இந்த வித்தியாசம் பெரியது. பணப் பிரிவுக்குச் சொல்ல வேண்டும். அலுவலகத்திலிருந்து ஒருவர் வரும் வரை பணத்தை ஒப்படைக்க வேண்டாம்.',
    noRoute: 'இந்த ஃபோனுக்கு இதுவரை வழி தரப்படவில்லை.',
    noRouteBody: 'எந்தப் பிரச்சனையும் இல்லை. உங்களுக்கு வழி ஒதுக்கப்பட்டால் அது தானாகவே இங்கே தோன்றும்.',
    sampleRoute: 'மாதிரி வழி — இது உண்மையான வேலை அல்ல.',
    contributionFlag: 'நிறுத்தம்(ங்கள்) விதி அனுமதிப்பதை விட அதிக செலவு — அலுவலகத்திற்குத் தெரிவிக்கப்பட்டது.',
    noProof: 'ஆதாரம் இல்லாமல் கொடுத்தது முழுமையாகாது. புகைப்படம், OTP அல்லது கையொப்பம் பெறவும்.',
    stopDone: 'அந்த நிறுத்தம் ஏற்கனவே முடிந்துவிட்டது.',
    outForDelivery: 'வழியில்', assigned: 'காத்திருக்கிறது', failedState: 'கொடுக்கப்படவில்லை', returnedState: 'கடைக்குத் திரும்பியது',
    deliveredState: 'கொடுக்கப்பட்டது',
  },
};
let lang = 'en';
const t = (key) => WORDS[lang][key] ?? WORDS.en[key];

/** What a stop's state is called, in both languages. Guarded against the model's own union. */
const STATE_WORDS = {
  assigned: { en: 'Waiting', ta: 'காத்திருக்கிறது' },
  out_for_delivery: { en: 'On the way', ta: 'வழியில்' },
  delivered: { en: 'Delivered', ta: 'கொடுக்கப்பட்டது' },
  failed: { en: 'Not delivered', ta: 'கொடுக்கப்படவில்லை' },
  returned_to_origin: { en: 'Back to store', ta: 'கடைக்குத் திரும்பியது' },
};

/** Why a delivery failed. Chosen, never typed — it routes the order and is reported on later. */
const FAILURE_REASONS = [
  { code: 'nobody_home', word: 'nobodyIn' },
  { code: 'customer_refused', word: 'refused' },
  { code: 'wrong_address', word: 'wrongAddress' },
  { code: 'address_not_found', word: 'cannotFind' },
  { code: 'customer_had_no_cash', word: 'noCash' },
  { code: 'goods_damaged', word: 'damagedGoods' },
];

/**
 * How a delivery is proved. **Card is not on this list and never will be** — COD is cash or UPI
 * (hard rule #3), and a method the screen cannot offer is a refusal a driver cannot walk into.
 */
const PROOF_KINDS = [
  { kind: 'photo', word: 'photo', needsRef: false },
  { kind: 'otp', word: 'otp', needsRef: true },
  { kind: 'signature', word: 'signature', needsRef: false },
];

const PAY_METHODS = [{ method: 'cash', word: 'cash' }, { method: 'upi', word: 'upi' }];

/** Indian notes in paise, largest first — the order a bag of cash is counted in. */
const DENOMS = [50_000, 20_000, 10_000, 5_000, 2_000, 1_000, 500];

const words = (map, key) => (map[key]?.[lang] ?? map[key]?.en ?? String(key).replace(/_/g, ' '));

/**
 * Sample route with the same surface as the bundled `RouteSession`, so the layout is runnable
 * before a real route is assigned. Replaced at build time by the tested model, and whenever it is
 * in use the header says so.
 */
function sampleRoute() {
  const stops = [
    { stopId: 's1', orderRef: 'ORD-1041', area: 'Anna Nagar, 3rd St', codMinor: 250_00, state: 'assigned' },
    { stopId: 's2', orderRef: 'ORD-1044', area: 'Gandhipuram', codMinor: 0, state: 'assigned' },
  ];
  const find = (id) => stops.find((s) => s.stopId === id);
  return {
    routeId: 'sample',
    route: () => stops.slice(),
    progress: () => {
      const remaining = stops.filter((s) => s.state === 'assigned' || s.state === 'out_for_delivery').length;
      return { total: stops.length, delivered: stops.filter((s) => s.state === 'delivered').length,
        failed: 0, returned: 0, remaining, complete: remaining === 0 };
    },
    depart: (id) => { const s = find(id); s.state = 'out_for_delivery'; return s; },
    deliver: (id, proof, o) => {
      if (!proof) { const e = new Error('proof'); e.name = 'ProofRequiredError'; throw e; }
      const s = find(id);
      s.state = 'delivered';
      s.codCollectedMinor = o?.codCollectedMinor ?? 0;
      return s;
    },
    fail: (id, reason) => { const s = find(id); s.state = 'failed'; s.failureReason = reason; return s; },
    reattempt: (id) => { const s = find(id); s.state = 'out_for_delivery'; return s; },
    returnToOrigin: (id) => { const s = find(id); s.state = 'returned_to_origin'; return s; },
    contributionFlags: () => [],
    codHeld: () => ({ minor: stops.filter((s) => s.state === 'delivered').reduce((n, s) => n + (s.codCollectedMinor ?? 0), 0), currency: 'INR' }),
    handOver: ({ countedMinor }) => ({ countedMinor, recordedMinor: countedMinor, varianceMinor: 0, material: false }),
  };
}

const real = window.routeSession;
const session = real ?? sampleRoute();
const outbox = window.driverOutbox ?? null;
const TOLERANCE = window.driverHandoverToleranceMinor ?? 10_000;

let selectedStopId = null;

// ── The banner ──────────────────────────────────────────────────────────────

function tell(title, message, good = false) {
  el('banner-title').textContent = title;
  el('banner-text').textContent = message;
  el('banner').classList.toggle('good', good === true);
  el('banner').hidden = false;
  el('banner-ok').textContent = t('ok');
  el('banner-ok').focus();
}
el('banner-ok').addEventListener('click', () => { el('banner').hidden = true; });

// ── The panel ───────────────────────────────────────────────────────────────

let sheetResolve = null;
let onEntryChange = null;

function ask({ title, mode, hint = '', initial = '0', options = [], onChange = null }) {
  el('sheet-title').textContent = title;
  el('entry-hint').textContent = hint;
  el('entry').textContent = initial;
  el('entry').hidden = mode !== 'number';
  el('keypad').hidden = mode !== 'number';
  el('choices').hidden = mode !== 'choice';
  el('sheet-ok').hidden = mode !== 'number';
  el('sheet-cancel').textContent = t('cancel');
  el('sheet-ok').textContent = t('ok');
  onEntryChange = onChange;

  if (mode === 'choice') {
    el('choices').replaceChildren(...options.map((option) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = option.label;
      button.addEventListener('click', () => { closeSheet(option.value); });
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
el('sheet-ok').addEventListener('click', () => { closeSheet(el('entry').textContent); });

// ── Counting the cash, blind ────────────────────────────────────────────────
//
// Nothing on this panel says what the driver should be holding, and the model offers no way to ask
// before a count is given. It is the same control the till drawer and the stock count use, and it
// is worth being structural in all three.

let countResolve = null;

function countCash() {
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

  el('count-title').textContent = t('countCash');
  el('count-hint').textContent = t('countHint');
  el('count-cancel').textContent = t('cancel');
  el('count-ok').textContent = t('handOver');
  paint();
  el('count').hidden = false;
  return new Promise((resolve) => {
    countResolve = (accepted) => resolve(accepted ? total() : null);
  });
}
el('count-cancel').addEventListener('click', () => { el('count').hidden = true; countResolve?.(false); countResolve = null; });
el('count-ok').addEventListener('click', () => { el('count').hidden = true; countResolve?.(true); countResolve = null; });

// ── Rendering ───────────────────────────────────────────────────────────────

const selected = () => session.route().find((s) => s.stopId === selectedStopId) ?? null;

function renderQueue() {
  if (outbox === null) { el('queue-text').textContent = ''; return; }
  const unsent = outbox.unsentCount();
  el('queue-dot').classList.toggle('waiting', unsent > 0);
  el('queue-text').textContent = unsent === 0 ? t('allSent') : `${unsent} ${t('waiting')}`;
}

function render() {
  const stops = session.route();
  const progress = session.progress();
  el('route').firstChild.textContent = `${t('myRoute')} · ${session.routeId ?? ''} `;
  el('progress').textContent = `${progress.delivered}/${progress.total} ${t('stopsDone')}`;

  el('empty').hidden = stops.length > 0;
  el('stops').replaceChildren(...stops.map((stop) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `stop ${stop.state}`;
    row.setAttribute('aria-selected', stop.stopId === selectedStopId ? 'true' : 'false');

    const area = document.createElement('span');
    area.className = 'area';
    area.textContent = stop.area;
    const order = document.createElement('span');
    order.className = 'order';
    // The order reference travels; the customer's name and number never reach this device (§31).
    order.textContent = stop.orderRef;
    const cod = document.createElement('span');
    cod.className = stop.codMinor > 0 ? 'cod' : 'cod prepaid';
    cod.textContent = stop.codMinor > 0 ? `${t('collect')} ${inr(stop.codMinor)}` : t('prepaid');
    const state = document.createElement('span');
    state.className = 'state';
    state.textContent = words(STATE_WORDS, stop.state);

    row.append(area, order, cod, state);
    if (stop.contributionFlag) {
      const flag = document.createElement('span');
      flag.className = 'flag';
      flag.textContent = stop.contributionFlag;
      row.append(flag);
    }
    row.addEventListener('click', () => { selectedStopId = stop.stopId; render(); });
    return row;
  }));

  // Stops the contribution rule flagged — surfaced, never buried (D09).
  const flags = session.contributionFlags();
  el('flagged').hidden = flags.length === 0;
  el('flagged').textContent = `${flags.length} ${t('contributionFlag')}`;

  el('held-label').textContent = t('cashCarrying');
  el('held').textContent = inr(session.codHeld().minor);
  el('deliver').textContent = t('delivered');
  el('failed').textContent = t('couldNotDeliver');
  el('handover').textContent = t('endOfShift');
  renderQueue();
}

// ── At the doorstep ─────────────────────────────────────────────────────────

/**
 * Complete a delivery.
 *
 * **Proof first**, because that is the order it happens at the door and because the model refuses a
 * delivery without it. Then the money, on its own screen with a keypad — a driver mis-reading
 * ₹2,500 as ₹250 at a doorstep is not a display bug.
 */
el('deliver').addEventListener('click', async () => {
  const stop = selected();
  if (stop === null) { tell(t('read'), t('tapStopFirst')); return; }
  if (stop.state === 'delivered' || stop.state === 'returned_to_origin') { tell(t('read'), t('stopDone')); return; }

  const kind = await ask({
    title: t('howProved'),
    mode: 'choice',
    options: PROOF_KINDS.map((p) => ({ value: p.kind, label: t(p.word) })),
  });
  if (kind === null) return;

  let ref = kind;
  if (PROOF_KINDS.find((p) => p.kind === kind)?.needsRef) {
    const entered = await ask({ title: t('proofRef'), mode: 'number' });
    if (entered === null) return;
    ref = String(entered);
  }

  let collected = 0;
  let method;
  if (stop.codMinor > 0) {
    // Cash or UPI only. Card is not on the list, so the engine's refusal (hard rule #3) is one a
    // driver can never walk into at a doorstep with a customer waiting.
    method = await ask({
      title: t('howPaid'),
      mode: 'choice',
      options: PAY_METHODS.map((p) => ({ value: p.method, label: t(p.word) })),
    });
    if (method === null) return;

    const answer = await ask({
      title: t('howMuchCollected'),
      mode: 'number',
      hint: `${t('expected')}: ${inr(stop.codMinor)}`,
      initial: String(Math.round(stop.codMinor / 100)),
      // Said as they type, in words. A short or over collection is fine if it is what happened —
      // what is not fine is a driver not noticing which one they just recorded.
      onChange: (rupees) => {
        const minor = Math.round(rupees * 100);
        if (minor < stop.codMinor) return t('collectedLess');
        if (minor > stop.codMinor) return t('collectedMore');
        return '';
      },
    });
    if (answer === null) return;
    collected = Math.round(Number(answer) * 100);
  }

  try {
    if (stop.state === 'assigned') session.depart(stop.stopId);
    session.deliver(stop.stopId, { kind, ref }, { codCollectedMinor: collected, codMethod: method });
    tell(t('deliveredOk'), `${stop.area}${collected > 0 ? ` · ${inr(collected)}` : ''}`, true);
  } catch (e) {
    tell(t('read'), e && e.name === 'ProofRequiredError' ? t('noProof') : String(e && e.message ? e.message : e));
  }
  render();
});

/**
 * A delivery that did not happen.
 *
 * The reason is chosen and mandatory, and the stop is then routed — try again, or back to the
 * store. A failed delivery is never just left: it is somebody's order and somebody's goods, and
 * the two of them are in different places until this is answered.
 */
el('failed').addEventListener('click', async () => {
  const stop = selected();
  if (stop === null) { tell(t('read'), t('tapStopFirst')); return; }
  if (stop.state === 'delivered') { tell(t('read'), t('stopDone')); return; }

  const reason = await ask({
    title: t('whyFailed'),
    mode: 'choice',
    options: FAILURE_REASONS.map((r) => ({ value: r.code, label: t(r.word) })),
  });
  if (reason === null) return;

  try {
    if (stop.state === 'assigned') session.depart(stop.stopId);
    session.fail(stop.stopId, reason);

    const next = await ask({
      title: t('thenWhat'),
      mode: 'choice',
      options: [
        { value: 'reattempt', label: t('tryAgain') },
        { value: 'rto', label: t('backToStore') },
      ],
    });
    if (next === 'reattempt') session.reattempt(stop.stopId);
    if (next === 'rto') session.returnToOrigin(stop.stopId);
    tell(t('failedOk'), stop.area, true);
  } catch (e) {
    tell(t('read'), String(e && e.message ? e.message : e));
  }
  render();
});

/**
 * End of shift.
 *
 * The count comes first and the recorded figure is never on screen before it. What comes back
 * carries the difference, and a material one is not a number to note down — it is an instruction
 * not to hand the money over until somebody from the office is there.
 */
el('handover').addEventListener('click', async () => {
  const counted = await countCash();
  if (counted === null) return;

  try {
    const result = session.handOver({
      countedMinor: counted,
      at: new Date().toISOString(),
      toleranceMinor: TOLERANCE,
    });
    const variance = result.varianceMinor;
    const headline = variance === 0 ? t('balanced')
      : variance > 0 ? `${t('over')} ${inr(variance)}`
        : `${t('short')} ${inr(-variance)}`;
    // The recorded figure may be shown NOW — it can no longer influence what was counted.
    tell(headline, result.material ? t('materialVariance') : `${t('counted')}: ${inr(counted)}`, !result.material);
  } catch (e) {
    tell(t('read'), String(e && e.message ? e.message : e));
  }
  render();
});

// ── Language ────────────────────────────────────────────────────────────────

el('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  el('sample').textContent = t('sampleRoute');
  el('empty').textContent = `${t('noRoute')} ${t('noRouteBody')}`;
  render();
});

// ── Boot ────────────────────────────────────────────────────────────────────

el('sample').hidden = real !== undefined;
el('sample').textContent = t('sampleRoute');

const storageProblem = window.driverStorageProblem;
el('storage').hidden = !storageProblem;
if (storageProblem) el('storage').textContent = storageProblem;

if (real === undefined && window.driverData !== undefined) {
  el('empty').hidden = false;
  el('empty').textContent = `${t('noRoute')} ${t('noRouteBody')}`;
} else {
  render();
}

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
