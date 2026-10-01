// Picker handheld — the view layer. It renders the assigned wave and dispatches the picker's
// scans; every rule lives in the TESTED session model (`apps/picker-app/src/pick-session.ts`),
// attached as `window.pickSession`.
//
// ── What this file exists to hold ───────────────────────────────────────────
//
// **1. A scan is a scan.** The spec says every pick is scan bin → scan item → confirm, and the only
// way that stays true is if the screen offers **no way to type a product code**. There is no input
// box anywhere in this shell. A retail scanner is a keyboard that types fast and presses Enter, so
// codes are collected globally and flushed on Enter — exactly as the till does, and for the same
// reason: an input that can lose focus is how a barcode lands in a quantity field.
//
// **2. A substitution needs the customer's own confirmation, and it is not a tick box.** The model
// requires a reference that can be looked up afterwards. A checkbox labelled "customer confirmed"
// is one a picker with eleven lines left taps in half a second, and afterwards nobody can tell an
// agreed swap from a guessed one.
//
// **3. The next step is always spelled out.** A handheld user should never have to work out where
// they are in a sequence. The footer says, in words, which of the three steps comes next.
//
// **4. No `prompt`, `confirm` or `alert`, and the banner does not fade** — the same two decisions
// the till and the manager's screen hold.
//
// No scan touches the network. Every scan is local and queues to the device (§31 picking row); the calls this file
// makes are a read of the store computer's sync status, for the badge (design system §1 rule 4), and — through the
// composition root's relay, when the box served this page — the hand-over of the queue to the store computer (SP-3c-i).

const el = (id) => document.getElementById(id);

const inr = (minor) =>
  '₹' + (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── Words ───────────────────────────────────────────────────────────────────

const WORDS = {
  en: {
    noBoxLink: 'not connected to a store computer', checkingBox: 'checking the store computer…',
    boxNotAnswering: 'store computer not answering', boxOnline: 'store computer online',
    noCloud: 'store computer cannot reach head office', cloudNotSetUp: 'no head office link set up',
    cloudUnknown: 'head office not checked yet', lastContact: 'last contact',
    staleShell: 'No connection to the store computer. This is the work this handheld was last given, at',
    myWave: 'My wave', done: 'done', waiting: 'waiting to sync', allSent: 'everything sent',
    sentHeading: 'Sent from this handheld', nothingSent: 'nothing sent yet',
    noShelfAddress: 'no shelf address — look for it', walkedIn: 'Walked in',
    scanTheBin: 'Scan the bin', scanTheItem: 'Scan the item', confirmQty: 'Confirm how many',
    stepBin: 'Step 1 of 3 — walk to the bin and scan it',
    stepItem: 'Step 2 of 3 — scan the item in your hand',
    stepQty: 'Step 3 of 3 — say how many you are taking',
    stepPickALine: 'Scan the bin you are at, or tap a line, to start', stepAllDone: 'Every line is resolved — pack the crate',
    waitingForScan: 'Waiting for a scan…', pointAndPull: 'Point the scanner and pull the trigger.',
    cancel: 'Cancel', ok: 'OK', substitute: 'Substitute', problem: 'Problem', packCrate: 'Pack the crate',
    howMany: 'How many are you taking?', howManyGrams: 'How many grams?',
    required: 'Asked for', picked: 'Picked', short: 'Short', substituted: 'Swapped',
    qualityFailed: 'Quality — rejected', pending: 'Not done yet',
    read: 'Please read this', tapLineFirst: 'Tap a line first.',
    wrongItem: 'That is not the item on this line. Check the label and scan again.',
    wrongBin: 'That is not the bin for this line. Walk to the bin shown and scan it.',
    alreadyDone: 'That line is already finished.',
    noWave: 'No wave has been given to this handheld yet.',
    noWaveBody: 'Nothing is wrong. When a wave is assigned to you it will appear here on its own.',
    scanSubstitute: 'Scan the item you are swapping in',
    customerRef: 'The customer’s approval reference',
    customerRefHint: 'The message, call or chat reference where the customer agreed. Not a tick box — this is looked up if they dispute it.',
    substituteNeedsCustomer: 'A swap needs the customer to have agreed, and needs the reference where they agreed. If you cannot get that, mark the item unavailable instead.',
    whatIsWrong: 'What is wrong?', outOfStock: 'None on the shelf', damagedItem: 'Damaged',
    outOfDate: 'Out of date', wrongLabel: 'Label does not match', tooRipe: 'Too ripe / poor quality',
    notFound: 'Cannot find it',
    markedUnavailable: 'Marked as none available', markedQuality: 'Rejected on quality',
    swapDone: 'Swap recorded', pickedOk: 'Picked',
    packBlocked: 'The crate cannot be packed yet', linesLeft: 'line(s) still to do.',
    packTitle: 'Pack the crate', packTemp: 'Cold-chain temperature in °C',
    packSeal: 'Scan the tamper seal', packedOk: 'Crate packed', manifestLines: 'items on the manifest',
    manifestValue: 'Value', sampleWave: 'Sample wave — this is not real work.',
    tooMany: 'That is more than the order asked for.',
    substituteFirst: 'Mark the item unavailable first, then record the swap.',
  },
  ta: {
    noBoxLink: 'கடை கணினியுடன் இணைக்கப்படவில்லை', checkingBox: 'கடை கணினியைச் சரிபார்க்கிறது…',
    boxNotAnswering: 'கடை கணினி பதிலளிக்கவில்லை', boxOnline: 'கடை கணினி இணைப்பில்',
    noCloud: 'கடை கணினி தலைமை அலுவலகத்தை அடைய முடியவில்லை', cloudNotSetUp: 'தலைமை அலுவலக இணைப்பு அமைக்கப்படவில்லை',
    cloudUnknown: 'தலைமை அலுவலகம் இன்னும் சரிபார்க்கப்படவில்லை', lastContact: 'கடைசித் தொடர்பு',
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்த ஹேண்ட்ஹெல்டுக்குக் கடைசியாகக் கொடுக்கப்பட்ட வேலை இதுதான்:',
    myWave: 'என் வேலை', done: 'முடிந்தது', waiting: 'அனுப்பக் காத்திருக்கிறது', allSent: 'அனைத்தும் அனுப்பப்பட்டன',
    noShelfAddress: 'அலமாரி முகவரி இல்லை — தேடிப் பாருங்கள்', walkedIn: 'நடக்கும் வரிசை',
    sentHeading: 'இந்தக் கருவியிலிருந்து அனுப்பப்பட்டவை', nothingSent: 'இன்னும் எதுவும் அனுப்பப்படவில்லை',
    scanTheBin: 'இடத்தை ஸ்கேன் செய்யவும்', scanTheItem: 'பொருளை ஸ்கேன் செய்யவும்', confirmQty: 'எத்தனை என்று உறுதி செய்யவும்',
    stepBin: 'படி 1 / 3 — இடத்திற்குச் சென்று ஸ்கேன் செய்யவும்',
    stepItem: 'படி 2 / 3 — கையில் உள்ள பொருளை ஸ்கேன் செய்யவும்',
    stepQty: 'படி 3 / 3 — எத்தனை எடுக்கிறீர்கள் என்று சொல்லவும்',
    stepPickALine: 'நீங்கள் இருக்கும் இடத்தை ஸ்கேன் செய்யவும், அல்லது தொடங்க ஒரு வரியைத் தொடவும்', stepAllDone: 'எல்லா வரிகளும் முடிந்தன — கிரேட்டை பேக் செய்யவும்',
    waitingForScan: 'ஸ்கேனுக்காகக் காத்திருக்கிறது…', pointAndPull: 'ஸ்கேனரை நோக்கி டிரிக்கரை அழுத்தவும்.',
    cancel: 'ரத்து', ok: 'சரி', substitute: 'மாற்று', problem: 'பிரச்சனை', packCrate: 'கிரேட்டை பேக் செய்',
    howMany: 'எத்தனை எடுக்கிறீர்கள்?', howManyGrams: 'எத்தனை கிராம்?',
    required: 'கேட்டது', picked: 'எடுக்கப்பட்டது', short: 'குறைவு', substituted: 'மாற்றப்பட்டது',
    qualityFailed: 'தரம் — நிராகரிக்கப்பட்டது', pending: 'இன்னும் முடியவில்லை',
    read: 'இதைப் படிக்கவும்', tapLineFirst: 'முதலில் ஒரு வரியைத் தொடவும்.',
    wrongItem: 'இது இந்த வரியின் பொருள் அல்ல. லேபிளைச் சரிபார்த்து மீண்டும் ஸ்கேன் செய்யவும்.',
    wrongBin: 'இது இந்த வரியின் இடம் அல்ல. காட்டப்பட்ட இடத்திற்குச் சென்று ஸ்கேன் செய்யவும்.',
    alreadyDone: 'அந்த வரி ஏற்கனவே முடிந்துவிட்டது.',
    noWave: 'இந்த கருவிக்கு இதுவரை வேலை தரப்படவில்லை.',
    noWaveBody: 'எந்தப் பிரச்சனையும் இல்லை. உங்களுக்கு வேலை ஒதுக்கப்பட்டால் அது தானாகவே இங்கே தோன்றும்.',
    scanSubstitute: 'மாற்றாகத் தரும் பொருளை ஸ்கேன் செய்யவும்',
    customerRef: 'வாடிக்கையாளரின் ஒப்புதல் குறிப்பு',
    customerRefHint: 'வாடிக்கையாளர் ஒப்புக்கொண்ட செய்தி, அழைப்பு அல்லது சாட் குறிப்பு. இது ஒரு டிக் அல்ல — தகராறு வந்தால் இதைத் தேடிப் பார்ப்போம்.',
    substituteNeedsCustomer: 'மாற்றத்திற்கு வாடிக்கையாளர் ஒப்புக்கொள்ள வேண்டும், அந்த ஒப்புதலின் குறிப்பும் தேவை. அது கிடைக்கவில்லை என்றால் பொருள் இல்லை என்று குறிக்கவும்.',
    whatIsWrong: 'என்ன பிரச்சனை?', outOfStock: 'அடுக்கில் இல்லை', damagedItem: 'சேதமடைந்தது',
    outOfDate: 'காலாவதி', wrongLabel: 'லேபிள் பொருந்தவில்லை', tooRipe: 'அதிகம் பழுத்தது / தரம் குறைவு',
    notFound: 'கண்டுபிடிக்க முடியவில்லை',
    markedUnavailable: 'பொருள் இல்லை என்று குறிக்கப்பட்டது', markedQuality: 'தரக் காரணத்தால் நிராகரிக்கப்பட்டது',
    swapDone: 'மாற்றம் பதிவானது', pickedOk: 'எடுக்கப்பட்டது',
    packBlocked: 'கிரேட்டை இன்னும் பேக் செய்ய முடியாது', linesLeft: 'வரி(கள்) இன்னும் மீதம்.',
    packTitle: 'கிரேட்டை பேக் செய்', packTemp: 'குளிர் சங்கிலி வெப்பநிலை °C',
    packSeal: 'சீலை ஸ்கேன் செய்யவும்', packedOk: 'கிரேட் பேக் ஆனது', manifestLines: 'பொருட்கள் பட்டியலில்',
    manifestValue: 'மதிப்பு', sampleWave: 'மாதிரி வேலை — இது உண்மையான வேலை அல்ல.',
    tooMany: 'ஆர்டரில் கேட்டதை விட இது அதிகம்.',
    substituteFirst: 'முதலில் பொருள் இல்லை என்று குறித்துவிட்டு, பிறகு மாற்றத்தைப் பதிவு செய்யவும்.',
  },
};
let lang = 'en';
const t = (key) => WORDS[lang][key] ?? WORDS.en[key];

/** What a line's state is called, in both languages. Guarded against the model's own union. */
const STATE_WORDS = {
  pending: { en: 'Not done yet', ta: 'இன்னும் முடியவில்லை' },
  picked: { en: 'Picked', ta: 'எடுக்கப்பட்டது' },
  short: { en: 'Short', ta: 'குறைவு' },
  substituted: { en: 'Swapped', ta: 'மாற்றப்பட்டது' },
  quality_failed: { en: 'Quality — rejected', ta: 'தரம் — நிராகரிக்கப்பட்டது' },
};

/**
 * Where a queued outcome or pack is — the FIVE shared device states (`packages/sync/src/device-relay.ts`), in both
 * languages (SP-3c-i). The device's own "saved" is never shown as "sent": only the store computer's word says head office
 * has it (P-08). A guardrail binds these to the shared list.
 */
const SENT_STATE_WORDS = {
  saved_here: { en: 'Saved on this handheld — not yet with the store computer', ta: 'இந்தக் கருவியில் சேமிக்கப்பட்டது — கடை கணினிக்கு இன்னும் செல்லவில்லை' },
  retrying: { en: 'Retrying — the store computer did not take it yet', ta: 'மீண்டும் முயற்சி — கடை கணினி இன்னும் ஏற்கவில்லை' },
  handed_to_box: { en: 'With the store computer', ta: 'கடை கணினியிடம் உள்ளது' },
  posted: { en: 'Posted at head office', ta: 'தலைமை அலுவலகத்தில் பதிவானது' },
  refused: { en: 'Refused — a person must look', ta: 'மறுக்கப்பட்டது — ஒருவர் பார்க்க வேண்டும்' },
};
/** The same five, short, for the badge's count line. */
const STATE_SHORT = {
  saved_here: { en: 'saved here', ta: 'இங்கே சேமிப்பு' },
  retrying: { en: 'retrying', ta: 'மீண்டும் முயற்சி' },
  handed_to_box: { en: 'with the store computer', ta: 'கடை கணினியிடம்' },
  posted: { en: 'posted', ta: 'பதிவாகியது' },
  refused: { en: 'refused', ta: 'மறுக்கப்பட்டது' },
};
/** The kinds of work this handheld sends (the session's `SENT_WORK_KINDS`). */
const KIND_WORDS = {
  line: { en: 'Line', ta: 'வரி' },
  pack: { en: 'Crate packed', ta: 'கிரேட் பேக் ஆனது' },
};

/**
 * Why a line could not be picked. Chosen, never typed.
 *
 * `quality` reasons take the line out of the crate; the rest mark it unavailable. The distinction
 * matters downstream — a rejected tomato is a waste record, an empty shelf is a replenishment
 * problem — and asking the picker to pick from a list is the only way to tell them apart later.
 */
const PROBLEMS = [
  { code: 'out_of_stock', kind: 'unavailable', word: 'outOfStock' },
  { code: 'not_found', kind: 'unavailable', word: 'notFound' },
  { code: 'damaged', kind: 'quality', word: 'damagedItem' },
  { code: 'expired', kind: 'quality', word: 'outOfDate' },
  { code: 'poor_quality', kind: 'quality', word: 'tooRipe' },
  { code: 'label_mismatch', kind: 'quality', word: 'wrongLabel' },
];

const words = (map, key) => (map[key]?.[lang] ?? map[key]?.en ?? String(key).replace(/_/g, ' '));

/**
 * Sample wave with the same surface as the bundled `PickSession`, so the layout is runnable and
 * usability-testable before a real wave is assigned. Replaced at build time by the tested model.
 * Whenever it is in use the header says so.
 */
function sampleWave() {
  const lines = [
    { lineId: 'l1', orderRef: 'ORD-1', productId: '8901234567890', description: 'Rice 1kg', bin: 'A-01', requiredQty: 2, uom: 'ea', state: 'pending', pickedQty: 0, finalPrice: { minor: 0, currency: 'INR' } },
    { lineId: 'l2', orderRef: 'ORD-1', productId: '8901234500007', description: 'Tomato', bin: 'B-04', requiredQty: 1500, uom: 'kg', state: 'pending', pickedQty: 0, finalPrice: { minor: 0, currency: 'INR' } },
  ];
  let bin = null;
  const find = (id) => lines.find((l) => l.lineId === id);
  return {
    waveId: 'sample',
    work: () => lines.slice(),
    progress: () => {
      const pending = lines.filter((l) => l.state === 'pending').length;
      return { total: lines.length, resolved: lines.length - pending, pending, complete: pending === 0 };
    },
    scanBin: (b) => { bin = b; },
    pick: (id, scanned, qty) => {
      const line = find(id);
      if (bin !== line.bin) { const e = new Error('bin'); e.name = 'BinNotScannedError'; throw e; }
      if (scanned !== line.productId) { const e = new Error('item'); e.name = 'WrongItemError'; throw e; }
      line.state = qty < line.requiredQty ? 'short' : 'picked';
      line.pickedQty = qty;
      return line;
    },
    substitute: (id, sub, ref) => {
      if (!ref || !ref.trim()) { const e = new Error('evidence'); e.name = 'SubstitutionEvidenceRequiredError'; throw e; }
      const line = find(id);
      line.state = 'substituted';
      line.substituteProductId = sub;
      line.pickedQty = line.requiredQty;
      return line;
    },
    failQuality: (id) => { const l = find(id); l.state = 'quality_failed'; return l; },
    markUnavailable: (id) => { const l = find(id); l.state = 'short'; return l; },
    pack: () => ({ waveId: 'sample', lines: lines.filter((l) => l.pickedQty > 0), totalValue: { minor: 0, currency: 'INR' } }),
  };
}

const real = window.pickSession;
const session = real ?? sampleWave();
const outbox = window.pickerOutbox ?? null;

let selectedLineId = null;

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

// ── The number / choice panel ───────────────────────────────────────────────

let sheetResolve = null;

function ask({ title, mode, hint = '', initial = '0', options = [] }) {
  el('sheet-title').textContent = title;
  el('entry-hint').textContent = hint;
  el('entry').textContent = initial;
  el('entry').hidden = mode !== 'number';
  el('keypad').hidden = mode !== 'number';
  el('choices').hidden = mode !== 'choice';
  el('sheet-ok').hidden = mode !== 'number';
  el('sheet-cancel').textContent = t('cancel');
  el('sheet-ok').textContent = t('ok');

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
    el('entry').textContent = key === 'C' ? '0'
      : key === '⌫' ? (current.length > 1 ? current.slice(0, -1) : '0')
        : (current === '0' ? key : current + key);
  });
  return button;
}));
el('sheet-cancel').addEventListener('click', () => { closeSheet(null); });
el('sheet-ok').addEventListener('click', () => { closeSheet(el('entry').textContent); });

// ── Waiting for a scan ──────────────────────────────────────────────────────
//
// A panel with NO input box. The picker points the scanner and pulls the trigger; there is nothing
// to type into and nothing to lose focus, which is the only way "every pick is a scan" survives a
// busy afternoon.

let scanResolve = null;
/** Answers a scan can have besides a code: the picker chose an alternative offered on the panel. */
const SUBSTITUTE = Symbol('substitute');
const PROBLEM = Symbol('problem');

/**
 * `offer` puts Substitute and Problem on the panel. It is true at the ITEM step only, because the shelf
 * is where a shortage is found: record a substitution = Substitute → scan the swap → scan the customer's
 * reference (3); flag a quality fail = Problem → the reason (2). That is the spec's budget, met from the
 * place the picker is standing rather than after a walk back to the list (picker-packer.md).
 */
function awaitScan(title, hint, offer = false) {
  el('scan-title').textContent = title;
  el('scan-awaiting').textContent = t('waitingForScan');
  el('scan-hint').textContent = hint;
  el('scan-cancel').textContent = t('cancel');
  el('scan-substitute').textContent = t('substitute');
  el('scan-problem').textContent = t('problem');
  el('scan-substitute').hidden = !offer;
  el('scan-problem').hidden = !offer;
  el('scan').hidden = false;
  return new Promise((resolve) => { scanResolve = resolve; });
}
function settleScan(answer) {
  el('scan').hidden = true;
  const resolve = scanResolve;
  scanResolve = null;
  if (resolve) resolve(answer);
}
el('scan-cancel').addEventListener('click', () => { settleScan(null); });
el('scan-substitute').addEventListener('click', () => { settleScan(SUBSTITUTE); });
el('scan-problem').addEventListener('click', () => { settleScan(PROBLEM); });

// ── Rendering ───────────────────────────────────────────────────────────────

function selected() {
  return session.work().find((l) => l.lineId === selectedLineId) ?? null;
}

/**
 * Which of the three steps comes next, in words, and it ADVANCES.
 *
 * The first version of this only ever said "step 1 of 3" — the words for the other two existed and
 * were never rendered. That is worse than having no indicator: a picker who is told step 1 while
 * standing at step 3 stops reading it, and then it is furniture. Found by a guardrail asking why
 * two translated strings were never used.
 */
let step = 'idle';

function renderStep() {
  const line = selected();
  const progress = session.progress();
  const say = (words, detail = '') => {
    el('step').firstChild.textContent = words;
    el('step-detail').textContent = detail;
  };

  if (step === 'bin' && line !== null) return say(t('stepBin'), `${line.bin} · ${line.description}`);
  if (step === 'item' && line !== null) return say(t('stepItem'), line.description);
  if (step === 'qty' && line !== null) return say(t('stepQty'), line.description);
  if (progress.complete) return say(t('stepAllDone'));
  if (line === null || line.state !== 'pending') return say(t('stepPickALine'));
  return say(t('stepBin'), `${line.bin} · ${line.description}`);
}

/**
 * Where each outcome and the pack have got to (SP-3c-i): read from the DURABLE device queue plus the store computer's own
 * word, so the list is the same after the app is closed — the proof a scan was not lost with it. A refusal carries its
 * reason, because a person has to act on it. Nothing here is a rule; the session owns the states.
 */
function renderSent() {
  const sent = real && typeof real.sentWork === 'function' ? real.sentWork().slice(0, 12) : [];
  el('sent-heading').textContent = t('sentHeading');
  el('sent-heading').hidden = sent.length === 0;
  const host = el('sent-work');
  host.textContent = '';
  for (const w of sent) {
    const row = document.createElement('div');
    row.className = `sent ${w.state}`;
    row.dataset.state = w.state;
    row.dataset.kind = w.kind;
    row.dataset.id = w.id;
    const what = document.createElement('div');
    what.className = 'what';
    what.textContent = `${words(KIND_WORDS, w.kind)} · ${w.what} — ${w.detail}`;
    const state = document.createElement('div');
    state.className = `pill ${w.state}`;
    state.textContent = words(SENT_STATE_WORDS, w.state);
    row.append(what, state);
    if (w.reason) {
      const why = document.createElement('div');
      why.className = 'why';
      why.textContent = w.reason;
      row.append(why);
    }
    host.append(row);
  }
}

function renderQueue() {
  renderSent();
  paintBadge();
}

/**
 * Hand the queued work to the store computer and learn where it has got to (SP-3c-i). The relay is the composition
 * root's (`window.pickerRelay`), present only when the box served this page over its device socket. Called after every
 * accepted action and every ten seconds; a failure leaves the queue untouched and the state words say "saved here".
 */
async function syncToBox() {
  const relay = window.pickerRelay;
  if (!relay) return;
  try {
    await relay.syncNow();
  } catch {
    /* the queue is untouched; the state words say "saved here" */
  }
  render();
}
setInterval(() => { void syncToBox(); }, 10_000);

function render() {
  const lines = session.work();
  const progress = session.progress();
  el('wave').firstChild.textContent = `${t('myWave')} · ${session.waveId ?? ''} `;
  el('progress').textContent = `${progress.resolved}/${progress.total} ${t('done')}`;
  // How this list came to be in the order it is in. A picker who believes it is in shelf order
  // when it is not walks it trusting a sequence nobody applied (M04-FR-02).
  const orderedBy = window.pickerData?.orderedBy;
  el('ordered-by').hidden = orderedBy === undefined;
  if (orderedBy !== undefined) el('ordered-by').textContent = `${t('walkedIn')}: ${orderedBy}`;

  el('empty').hidden = lines.length > 0;
  el('lines').replaceChildren(...lines.map((line) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `line ${line.state}`;
    row.setAttribute('aria-selected', line.lineId === selectedLineId ? 'true' : 'false');

    const bin = document.createElement('span');
    bin.className = 'bin';
    // The shelf address if the shop has one, else the bin. A line with NO shelf address says so:
    // it sits at the end of the walk, and a picker who is not told simply reads the route as wrong.
    bin.textContent = line.shelf ?? line.bin;
    if (line.unmapped === true) bin.classList.add('unmapped');
    const what = document.createElement('span');
    what.className = 'what';
    what.textContent = line.description;
    const qty = document.createElement('span');
    qty.className = 'qty';
    // Weighed lines are held in grams by the model; the picker thinks in kilos.
    const asQty = (n) => (line.uom === 'kg' ? `${(n / 1000).toFixed(3)} kg` : String(n));
    qty.textContent = `${t('required')} ${asQty(line.requiredQty)}` +
      (line.pickedQty > 0 ? ` · ${t('picked')} ${asQty(line.pickedQty)}` : '');
    const state = document.createElement('span');
    state.className = 'state';
    state.textContent = words(STATE_WORDS, line.state);

    row.append(bin, what, qty, state);
    row.addEventListener('click', () => { selectedLineId = line.lineId; startLine(line); });
    return row;
  }));

  el('pack').textContent = t('packCrate');
  el('substitute').textContent = t('substitute');
  el('problem').textContent = t('problem');
  renderStep();
  renderQueue();
}

// ── The three steps ─────────────────────────────────────────────────────────

/**
 * Scan the bin, scan the item, confirm the quantity.
 *
 * The order is the rule and the model enforces it — scanning the wrong bin or the wrong item is
 * refused there, not here. This function's job is only to ask for each scan in turn and to turn
 * the model's refusal into a sentence a picker can act on in an aisle.
 */
async function startLine(line, binCode = null) {
  step = 'bin';
  render();
  if (line.state !== 'pending') { step = 'idle'; tell(t('read'), t('alreadyDone')); return; }

  // Step 1 — the bin. Scanned straight from the list (the scan itself chose this line, so pick a line is
  // scan bin → scan item → confirm = 3, the spec's row exactly), or asked for here after a tap on the line.
  const scannedBin = binCode ?? await awaitScan(`${t('scanTheBin')} — ${line.bin}`, t('pointAndPull'));
  if (scannedBin === null) { step = 'idle'; render(); return; }
  session.scanBin(scannedBin);

  step = 'item';
  render();
  // Step 2 — the item, with the two honest alternatives on the panel (see awaitScan).
  const itemCode = await awaitScan(`${t('scanTheItem')} — ${line.description}`, t('pointAndPull'), true);
  if (itemCode === SUBSTITUTE) { step = 'idle'; render(); await substituteLine(line); return; }
  if (itemCode === PROBLEM) { step = 'idle'; render(); await reportProblem(line); return; }
  if (itemCode === null) { step = 'idle'; render(); return; }

  step = 'qty';
  render();
  const grams = line.uom === 'kg';
  const answer = await ask({
    title: grams ? t('howManyGrams') : t('howMany'),
    mode: 'number',
    hint: `${t('required')}: ${grams ? `${(line.requiredQty / 1000).toFixed(3)} kg` : line.requiredQty}`,
    initial: String(line.requiredQty),
  });
  step = 'idle';
  if (answer === null) { render(); return; }
  const qty = Number(answer);
  if (!Number.isInteger(qty) || qty <= 0) { render(); return; }
  if (qty > line.requiredQty) { tell(t('read'), t('tooMany')); render(); return; }

  try {
    session.pick(line.lineId, itemCode, qty);
    tell(t('pickedOk'), line.description, true);
    void syncToBox();
  } catch (e) {
    // The model's rule, translated into what to do about it in an aisle.
    const name = e && e.name;
    tell(t('read'),
      name === 'WrongItemError' ? t('wrongItem')
        : name === 'BinNotScannedError' ? t('wrongBin')
          : name === 'LineAlreadyResolvedError' ? t('alreadyDone')
            : String(e && e.message ? e.message : e));
  }
  render();
}

/**
 * Record a substitution.
 *
 * **The customer's confirmation is a reference, not a tick.** The model refuses an empty one, and
 * this panel says why in a sentence a picker can act on: if you cannot get the reference, mark the
 * item unavailable instead. That is the honest alternative, and it is one tap away.
 */
el('substitute').addEventListener('click', async () => {
  const line = selected();
  if (line === null) { tell(t('read'), t('tapLineFirst')); return; }
  await substituteLine(line);
});

async function substituteLine(line) {
  if (line.state === 'picked' || line.state === 'substituted') { tell(t('read'), t('alreadyDone')); return; }

  const substituteCode = await awaitScan(t('scanSubstitute'), t('pointAndPull'));
  if (substituteCode === null) return;

  // The reference is SCANNED or read from the customer's message, never invented — there is no
  // free-text box on this screen at all, so the picker cannot type "yes" and move on.
  const approvalRef = await awaitScan(t('customerRef'), t('customerRefHint'));
  if (approvalRef === null) { tell(t('read'), t('substituteNeedsCustomer')); return; }

  try {
    session.substitute(line.lineId, substituteCode, approvalRef, line.requiredQty, line.unitPrice ?? { minor: 0, currency: 'INR' });
    tell(t('swapDone'), `${line.description} → ${substituteCode}`, true);
    void syncToBox();
  } catch (e) {
    const name = e && e.name;
    tell(t('read'),
      name === 'SubstitutionEvidenceRequiredError' || name === 'SubstitutionNotConfirmedError'
        ? t('substituteNeedsCustomer')
        : name === 'LineAlreadyResolvedError' ? t('substituteFirst')
          : String(e && e.message ? e.message : e));
  }
  render();
}

/** Something is wrong with the item. A chosen reason, never typed — it is reported on later. */
el('problem').addEventListener('click', async () => {
  const line = selected();
  if (line === null) { tell(t('read'), t('tapLineFirst')); return; }
  await reportProblem(line);
});

async function reportProblem(line) {
  const code = await ask({
    title: t('whatIsWrong'),
    mode: 'choice',
    options: PROBLEMS.map((p) => ({ value: p.code, label: t(p.word) })),
  });
  if (code === null) return;
  const problem = PROBLEMS.find((p) => p.code === code);

  try {
    // A quality rejection and an empty shelf are different facts downstream: one is waste, the
    // other is replenishment. Keeping them apart is why the picker chooses from a list.
    if (problem.kind === 'quality') {
      session.failQuality(line.lineId, code);
      tell(t('markedQuality'), line.description, true);
    } else {
      session.markUnavailable(line.lineId, code);
      tell(t('markedUnavailable'), line.description, true);
    }
    void syncToBox();
  } catch (e) {
    tell(t('read'), String(e && e.message ? e.message : e));
  }
  render();
}

/**
 * Pack the crate.
 *
 * Blocked by the model while any line is unresolved, and the screen says **how many are left**
 * rather than "cannot pack" — the same rule the manager's day close follows, for the same reason.
 */
el('pack').addEventListener('click', async () => {
  const progress = session.progress();
  if (!progress.complete) {
    tell(t('packBlocked'), `${progress.pending} ${t('linesLeft')}`);
    return;
  }

  const temperature = await ask({ title: t('packTemp'), mode: 'number', initial: '4' });
  if (temperature === null) return;
  const seal = await awaitScan(t('packSeal'), t('pointAndPull'));
  if (seal === null) return;

  try {
    const manifest = session.pack({
      packedBy: window.pickerData?.pickerId ?? 'picker',
      at: new Date().toISOString(),
      temperatureC: Number(temperature),
      tamperSealRef: seal,
    });
    tell(t('packedOk'),
      `${manifest.lines.length} ${t('manifestLines')} · ${t('manifestValue')} ${inr(manifest.totalValue.minor)}`,
      true);
    void syncToBox();
  } catch (e) {
    tell(t('read'), String(e && e.message ? e.message : e));
  }
  render();
});

// ── Language ────────────────────────────────────────────────────────────────

el('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  el('sample').textContent = t('sampleWave');
  el('empty').textContent = `${t('noWave')} ${t('noWaveBody')}`;
  render();
});

// ── The scanner ─────────────────────────────────────────────────────────────
//
// A shop scanner is a keyboard: it types the code very fast and presses Enter. There is
// deliberately **no input box to focus** anywhere in this shell — losing focus is how a scan goes
// into whatever was last tapped, and on a handheld that is a quantity field.

let scanBuffer = '';
window.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    const code = scanBuffer;
    scanBuffer = '';
    if (code.length < 3) return; // a person pressing Enter, not a scanner
    // A scanner's Enter is never a person's: left to the browser it also PRESSES whatever button has focus
    // (the line the picker just tapped, the Substitute they just chose) and the flow runs twice.
    event.preventDefault();
    if (scanResolve !== null) { settleScan(code); return; }
    // No panel is waiting for a scan and none is asking a question: a bin label scanned from the list IS
    // step 1. The scan chooses the line — the spec's "scan bin → scan item → confirm" starts at the bin,
    // not at a tap (picker-packer.md). An unknown code, or one that is no pending line's bin, does nothing.
    if (sheetResolve !== null) return;
    // A green banner (a pick that went through) yields to the next scan — a scan is a deliberate act, and
    // making the picker tap "read" after every good pick would spend a tap on the ten-times-a-day path.
    // A red one (a refusal) does not yield: it must be read before the next thing happens (rule 5).
    const banner = el('banner');
    if (!banner.hidden) { if (!banner.classList.contains('good')) return; banner.hidden = true; }
    const line = session.work().find((l) => l.state === 'pending' && (l.bin === code || l.shelf === code));
    if (line !== undefined) { selectedLineId = line.lineId; void startLine(line, code); }
    return;
  }
  // Codes here are alphanumeric: a bin is "A-01" and a seal reference is not all digits.
  if (/^[0-9A-Za-z-]$/.test(event.key)) scanBuffer += event.key;
});

// ── The sync badge — connection · unsent · freshness (design system §1 rule 4 · P-08) ────────────
//
// Two lines of words beside one dot. The first is THIS DEVICE's unsent count: the scans queued here
// and not yet drained. The second is the STORE COMPUTER's own account of itself — reachable or not,
// and when head office last answered it — asked at the address the page was served from. A handheld
// on the shop wifi never guesses an address: with no store computer named, the badge says so rather
// than inventing one, and a page opened from the device's cache says it is not connected.
let box = { asked: false, reachable: false, status: null };
const laneBase = () => (typeof window.laneWriteBase === 'string' ? window.laneWriteBase : null);

/** The device's clock face for a store-computer time — the person reading it is standing in the shop. */
function clock(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function paintBadge() {
  const dot = el('queue-dot');
  const unsent = outbox === null ? 0 : outbox.unsentCount();
  dot.classList.remove('waiting', 'error', 'idle', 'degraded');
  // Words as well as a dot — one man in twelve cannot tell the two colours apart. The first line counts THIS handheld's
  // work by where each piece is (SP-3c-i): saved here · retrying · with the store computer · posted · refused — never a
  // bare "sent" (P-08). Without a session it falls back to the queue's own unsent count.
  const sent = real && typeof real.sentWork === 'function' ? real.sentWork() : null;
  if (sent === null) el('queue-text').textContent = unsent === 0 ? t('allSent') : `${unsent} ${t('waiting')}`;
  else if (sent.length === 0) el('queue-text').textContent = t('nothingSent');
  else {
    const counts = {};
    for (const w of sent) counts[w.state] = (counts[w.state] ?? 0) + 1;
    const parts = [];
    for (const k of Object.keys(STATE_SHORT)) if (counts[k]) parts.push(`${counts[k]} ${words(STATE_SHORT, k)}`);
    el('queue-text').textContent = parts.join(' · ');
  }
  let refusedCount = 0;
  for (const w of sent ?? []) if (w.state === 'refused') refusedCount += 1;
  let boxWords;
  if (laneBase() === null) { dot.classList.add('idle'); boxWords = t('noBoxLink'); }
  else if (!box.asked) { dot.classList.add('idle'); boxWords = t('checkingBox'); }
  else if (!box.reachable) { dot.classList.add('error'); boxWords = t('boxNotAnswering'); }
  else {
    const s = box.status;
    const when = s.lastContactAt ? ` · ${t('lastContact')} ${clock(s.lastContactAt)}` : '';
    if (s.cloud === 'online') boxWords = `${t('boxOnline')}${when}`;
    else {
      dot.classList.add(s.cloud === 'unknown' || s.cloud === 'starting' ? 'idle' : 'degraded');
      boxWords = `${s.cloud === 'offline' ? t('noCloud') : s.cloud === 'not_configured' ? t('cloudNotSetUp') : t('cloudUnknown')}${when}`;
    }
  }
  // Work waiting on this device shows as waiting unless the store computer itself is down — that is worse; a refusal is
  // worse still, because a person has to act on it.
  if (unsent > 0 && !dot.classList.contains('error')) { dot.classList.remove('idle', 'degraded'); dot.classList.add('waiting'); }
  if (refusedCount > 0) { dot.classList.remove('idle', 'degraded', 'waiting'); dot.classList.add('error'); }
  el('box-text').textContent = boxWords;
}

async function refreshBadge() {
  const base = laneBase();
  if (base === null) { paintBadge(); return; }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 3000);
  try {
    const res = await fetch(`${base}/lane/sync-status`, { cache: 'no-store', signal: ctl.signal });
    box = res.ok ? { asked: true, reachable: true, status: await res.json() } : { asked: true, reachable: false, status: null };
  } catch {
    box = { asked: true, reachable: false, status: null };
  } finally {
    clearTimeout(timer);
  }
  paintBadge();
}
window.pickerBadge = { refresh: refreshBadge, state: () => box };
void refreshBadge();
setInterval(() => { void refreshBadge(); }, 10_000);

// ── Boot ────────────────────────────────────────────────────────────────────

el('sample').hidden = real !== undefined;
el('sample').textContent = t('sampleWave');

const storageProblem = window.pickerStorageProblem;
el('storage').hidden = !storageProblem;
if (storageProblem) el('storage').textContent = storageProblem;

if (real === undefined && window.pickerData !== undefined) {
  // The bundle is there and a payload arrived, but it carried no wave. Said plainly rather than
  // shown as an empty list, which reads like a wave already finished.
  el('empty').hidden = false;
  el('empty').textContent = `${t('noWave')} ${t('noWaveBody')}`;
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
