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
// No stop touches the network. Every stop is local and queues to the device (§31 delivery row); the one
// call this file makes is a read of the store computer's sync status, for the badge (design system §1 rule 4).

// OB-607: a moment is shown at the SHOP's clock (its zone, as the store computer told the page) — never this device's.
const shopWhen = (value) => window.sreShopDay?.dateTimeOf(value) ?? '';
// OB-607: a time of day is the SHOP's clock (its zone, as the store computer told the page) — never this device's.
const shopTimeOf = (value) => window.sreShopDay?.timeOf(value) ?? '';
const el = (id) => document.getElementById(id);

// ── OB-205: an icon from the one set beside the words ───────────────────────
// `say` writes an element's words with the set's icon in front of them. The element's text stays exactly the words (an
// SVG adds none), so nothing that reads it changes; with no icon set loaded, the words stand alone — they are the signal.
const mark = (name, size = 20) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, size) : null);
function say(node, text, icon) {
  const m = icon ? mark(icon) : null;
  if (m === null) { node.replaceChildren(text); return; }
  // The icon and its words travel as one pair (`sre-with-icon`), so the icon is never found apart from its words.
  const pair = document.createElement('span');
  pair.className = 'sre-with-icon';
  pair.append(m, text);
  node.replaceChildren(pair);
}
/** The slots the markup — and the store box's sign-in strip above this screen — leave for an icon (`data-sre-icon`). */
function paintIconSlots() {
  for (const slot of document.querySelectorAll('[data-sre-icon]')) {
    if (slot.firstElementChild !== null) continue;
    const m = mark(slot.dataset.sreIcon, 18);
    if (m !== null) slot.append(m);
  }
}
/** The banner's shape beside its words: a tick when it went through, a stop when it did not — never the colour alone. */
function bannerMark(good) {
  const shape = mark(good ? 'circle-check' : 'circle-alert', 28);
  el('banner-mark').replaceChildren(...(shape === null ? [] : [shape]));
}
/** The shape a sent record's state wears beside its words (the five shared states). */
const STATE_ICON = { saved_here: 'clock', retrying: 'refresh-cw', handed_to_box: 'store', posted: 'circle-check', refused: 'circle-alert' };
/** "3 of 8 done" — the progress words, with the two numbers put in. */
const progressWords = (template, n, total) => template.replace('{n}', String(n)).replace('{total}', String(total));
/** The bar under the progress words: drawn only when there is a total to measure against (never a made-up zero). */
function paintMeter(n, total) {
  el('progress-meter').hidden = !(total > 0);
  if (total > 0) el('progress-bar').style.transform = `scaleX(${Math.min(1, Math.max(0, n / total))})`;
}

const inr = (minor) =>
  '₹' + (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── Words ───────────────────────────────────────────────────────────────────

const WORDS = {
  en: {
    // OB-521 (R8-A)
    updateApp: 'Update this app',
    noBoxLink: 'not connected to a store computer', checkingBox: 'checking the store computer…',
    boxNotAnswering: 'store computer not answering', boxOnline: 'store computer online',
    noCloud: 'store computer cannot reach head office', cloudLoginRefused: 'store computer\'s head office login needs renewing', cloudNotSetUp: 'no head office link set up',
    cloudUnknown: 'head office not checked yet', lastContact: 'last contact',
    staleShell: 'No signal. This is the route this phone was last given, at',
    myRoute: 'My route', stopsDone: 'stops done', progressOf: '{n} of {total} stops done', waiting: 'waiting to sync', allSent: 'everything sent',
    cashCarrying: 'Cash you are carrying', collect: 'Collect', prepaid: 'Already paid',
    delivered: 'Delivered', couldNotDeliver: 'Could not deliver', endOfShift: 'End of shift — hand cash over',
    partlyDelivered: 'Partly delivered', partialOk: 'Recorded as partly delivered',
    sentHeading: 'Sent from this phone', nothingSent: 'nothing sent yet',
    cancel: 'Cancel', ok: 'OK', read: 'Please read this',
    tapStopFirst: 'Tap the stop you are at first.',
    howProved: 'How did you prove the delivery?', photo: 'Photo at the door', otp: 'Customer’s 4-digit code',
    signature: 'Customer signs on the screen',
    codeTitle: 'Ask the customer for the 4 numbers in their app', codeHint: 'Type the 4 numbers the customer reads out.',
    codeFormat: 'The code is 4 numbers. Ask the customer to read it again.',
    codeLater: 'The code is checked at head office when this phone is back on the shop wifi.',
    takePhoto: 'Take a photo of the parcel at the door', openCamera: 'Open the camera', retake: 'Take it again',
    photoHint: 'Only the parcel and the door — not the customer’s face.',
    signHere: 'Ask the customer to sign with a finger', clear: 'Clear', done: 'Done',
    imageError: 'The picture could not be kept. Take it again.',
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
    // WF-16 (driver): online returns to collect.
    returnsHeading: 'Returns to collect', bookedFor: 'Booked for',
    noMoneyAtDoor: 'No money changes hands at the door. The shop refunds the customer later, after the goods are back and counted.',
    whatAtReturn: 'What happened at this return?', collectedAction: 'Collected — record what I took', notCollectedAction: 'Not collected',
    howManyTook: 'How many did you take of', bookedQty: 'Booked', moreThanBooked: 'More than was booked — this cannot be recorded.',
    whyNotCollected: 'Why was nothing collected?', customerNotAvailable: 'Customer not available', nothingHandedOver: 'Customer handed nothing over',
    collectedOk: 'Recorded as collected', notCollectedOk: 'Recorded as not collected', collectionDone: 'That return is already collected.',
    notRecorded: 'Not recorded', nothingTaken: 'You took nothing. Record it as “Not collected” instead.',
  },
  ta: {
    updateApp: 'இந்தச் செயலியைப் புதுப்பிக்கவும்',
    noBoxLink: 'கடை கணினியுடன் இணைக்கப்படவில்லை', checkingBox: 'கடை கணினியைச் சரிபார்க்கிறது…',
    boxNotAnswering: 'கடை கணினி பதிலளிக்கவில்லை', boxOnline: 'கடை கணினி இணைப்பில்',
    noCloud: 'கடை கணினி தலைமை அலுவலகத்தை அடைய முடியவில்லை', cloudLoginRefused: 'கடை கணினியின் தலைமை அலுவலக உள்நுழைவைப் புதுப்பிக்க வேண்டும்', cloudNotSetUp: 'தலைமை அலுவலக இணைப்பு அமைக்கப்படவில்லை',
    cloudUnknown: 'தலைமை அலுவலகம் இன்னும் சரிபார்க்கப்படவில்லை', lastContact: 'கடைசித் தொடர்பு',
    staleShell: 'சிக்னல் இல்லை. இந்த ஃபோனுக்குக் கடைசியாகக் கொடுக்கப்பட்ட வழி இதுதான்:',
    myRoute: 'என் வழி', stopsDone: 'நிறுத்தங்கள் முடிந்தன', progressOf: '{total} இல் {n} நிறுத்தங்கள் முடிந்தன', waiting: 'அனுப்பக் காத்திருக்கிறது', allSent: 'அனைத்தும் அனுப்பப்பட்டன',
    cashCarrying: 'நீங்கள் வைத்திருக்கும் பணம்', collect: 'வாங்க வேண்டியது', prepaid: 'ஏற்கனவே செலுத்தப்பட்டது',
    delivered: 'கொடுக்கப்பட்டது', couldNotDeliver: 'கொடுக்க முடியவில்லை', endOfShift: 'ஷிப்ட் முடிவு — பணத்தை ஒப்படை',
    partlyDelivered: 'ஓரளவு கொடுக்கப்பட்டது', partialOk: 'ஓரளவு கொடுக்கப்பட்டதாக பதிவானது',
    sentHeading: 'இந்த ஃபோனிலிருந்து அனுப்பப்பட்டவை', nothingSent: 'இன்னும் எதுவும் அனுப்பப்படவில்லை',
    cancel: 'ரத்து', ok: 'சரி', read: 'இதைப் படிக்கவும்',
    tapStopFirst: 'முதலில் நீங்கள் இருக்கும் நிறுத்தத்தைத் தொடவும்.',
    howProved: 'கொடுத்ததை எப்படி நிரூபித்தீர்கள்?', photo: 'வாசலில் புகைப்படம்', otp: 'வாடிக்கையாளரின் 4 இலக்கக் குறியீடு',
    signature: 'வாடிக்கையாளர் திரையில் கையொப்பம்',
    codeTitle: 'வாடிக்கையாளரின் செயலியில் உள்ள 4 எண்களைக் கேளுங்கள்', codeHint: 'வாடிக்கையாளர் படிக்கும் 4 எண்களைத் தட்டச்சு செய்யவும்.',
    codeFormat: 'குறியீடு 4 எண்கள். வாடிக்கையாளரை மீண்டும் படிக்கச் சொல்லுங்கள்.',
    codeLater: 'இந்த ஃபோன் கடை வைஃபைக்குத் திரும்பியதும் குறியீடு தலைமை அலுவலகத்தில் சரிபார்க்கப்படும்.',
    takePhoto: 'வாசலில் பொதியைப் புகைப்படம் எடுக்கவும்', openCamera: 'கேமராவைத் திற', retake: 'மீண்டும் எடு',
    photoHint: 'பொதியும் வாசலும் மட்டும் — வாடிக்கையாளரின் முகம் வேண்டாம்.',
    signHere: 'வாடிக்கையாளரை விரலால் கையொப்பமிடச் சொல்லுங்கள்', clear: 'அழி', done: 'முடிந்தது',
    imageError: 'படத்தை வைத்திருக்க முடியவில்லை. மீண்டும் எடுக்கவும்.',
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
    returnsHeading: 'திரும்பப் பெற வேண்டியவை', bookedFor: 'முன்பதிவு நாள்',
    noMoneyAtDoor: 'வாசலில் பணம் கொடுக்கவோ வாங்கவோ வேண்டாம். பொருள் கடைக்கு வந்து எண்ணிய பின் கடை வாடிக்கையாளருக்குப் பணத்தைத் திருப்பித் தரும்.',
    whatAtReturn: 'இந்தத் திருப்பலில் என்ன நடந்தது?', collectedAction: 'எடுத்தேன் — எடுத்ததைப் பதிவு செய்', notCollectedAction: 'எடுக்கவில்லை',
    howManyTook: 'எத்தனை எடுத்தீர்கள்:', bookedQty: 'முன்பதிவு', moreThanBooked: 'முன்பதிவை விட அதிகம் — இதைப் பதிவு செய்ய முடியாது.',
    whyNotCollected: 'ஏன் எதுவும் எடுக்கவில்லை?', customerNotAvailable: 'வாடிக்கையாளர் இல்லை', nothingHandedOver: 'வாடிக்கையாளர் எதுவும் தரவில்லை',
    collectedOk: 'எடுக்கப்பட்டதாகப் பதிவானது', notCollectedOk: 'எடுக்கவில்லை என்று பதிவானது', collectionDone: 'அந்தத் திருப்பல் ஏற்கனவே எடுக்கப்பட்டது.',
    notRecorded: 'பதிவாகவில்லை', nothingTaken: 'நீங்கள் எதுவும் எடுக்கவில்லை. “எடுக்கவில்லை” என்று பதிவு செய்யவும்.',
  },
};
let lang = 'en';
const t = (key) => WORDS[lang][key] ?? WORDS.en[key];

// OB-521 (R8-A): on a withdrawn or too-old build the session refuses to START new work (the work in hand is finished) —
// said in its own words, English or Tamil. The policy comes from the store computer's signed pack: with the page, then
// every badge refresh (`/lane/sync-status`); the bundle keeps the last one on this device for a reload with no signal.
function versionRefused(e) {
  if (!e || e.name !== 'NewWorkRefusedError') return false;
  tell(t('updateApp'), lang === 'ta' ? e.laneMessageTa : e.laneMessage);
  return true;
}

/** What a stop's state is called, in both languages. Guarded against the model's own union. */
const STATE_WORDS = {
  assigned: { en: 'Waiting', ta: 'காத்திருக்கிறது' },
  picked_up: { en: 'Picked up', ta: 'எடுக்கப்பட்டது' },
  out_for_delivery: { en: 'On the way', ta: 'வழியில்' },
  attempted: { en: 'At the door', ta: 'வாசலில்' },
  delivered: { en: 'Delivered', ta: 'கொடுக்கப்பட்டது' },
  partially_delivered: { en: 'Partly delivered', ta: 'ஓரளவு கொடுக்கப்பட்டது' },
  failed: { en: 'Not delivered', ta: 'கொடுக்கப்படவில்லை' },
  returned_to_origin: { en: 'Back to store', ta: 'கடைக்குத் திரும்பியது' },
};

/**
 * Where a queued outcome, the settlement or the handover is — the FIVE shared device states
 * (`packages/sync/src/device-relay.ts`), in both languages (SP-3c-ii). The phone's own "saved" is never shown as "sent":
 * only the store computer's word says head office has it (P-08). For a driver carrying cash that is the difference between a
 * record and a rumour. A guardrail binds these to the shared list.
 */
/** The shape each stop's state wears beside its words (OB-205). */
const STOP_ICON = { assigned: 'clock', picked_up: 'package', out_for_delivery: 'truck', attempted: 'navigation', delivered: 'circle-check', partially_delivered: 'package-minus', failed: 'circle-alert', returned_to_origin: 'rotate-ccw' };

const SENT_STATE_WORDS = {
  saved_here: { en: 'Saved on this phone — not yet with the store computer', ta: 'இந்த ஃபோனில் சேமிக்கப்பட்டது — கடை கணினிக்கு இன்னும் செல்லவில்லை' },
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
/** The kinds of work this phone sends (the session's `SENT_WORK_KINDS`). */
const KIND_WORDS = {
  stop: { en: 'Stop', ta: 'நிறுத்தம்' },
  settlement: { en: 'Shift settled', ta: 'ஷிப்ட் கணக்கு' },
  handover: { en: 'Cash handed over', ta: 'பணம் ஒப்படைப்பு' },
  collection: { en: 'Return collection', ta: 'திருப்பல் சேகரிப்பு' },
  proof: { en: 'Proof picture', ta: 'நிரூபணப் படம்' },
};

/** WF-16 (driver): a return collection's state, in both languages, and the shape it wears beside the words. */
const COLLECTION_STATE_WORDS = {
  booked: { en: 'To collect', ta: 'எடுக்க வேண்டும்' },
  collected: { en: 'Collected', ta: 'எடுக்கப்பட்டது' },
  not_collected: { en: 'Not collected', ta: 'எடுக்கப்படவில்லை' },
};
const COLLECTION_ICON = { booked: 'package', collected: 'package-check', not_collected: 'circle-alert' };
/** Why nothing was collected — chosen, never typed; head office reads the same two words (the session's list). */
const MISS_REASONS = [
  { code: 'customer_not_available', word: 'customerNotAvailable' },
  { code: 'nothing_handed_over', word: 'nothingHandedOver' },
];

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
  { kind: 'otp', word: 'otp' },
  { kind: 'photo', word: 'photo' },
  { kind: 'signature', word: 'signature' },
];

/** The largest proof picture the session keeps, in base64 characters (the package's PROOF_IMAGE_MAX_BASE64 is 60,000). */
const IMAGE_LIMIT = 58_000;

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
      if (!proof || (proof.kind !== 'otp' && !proof.image)) { const e = new Error('proof'); e.name = 'ProofRequiredError'; throw e; }
      const s = find(id);
      s.state = 'delivered';
      s.codCollectedMinor = o?.codCollectedMinor ?? 0;
      return s;
    },
    deliverPartial: (id, proof, o) => {
      if (!proof || (proof.kind !== 'otp' && !proof.image)) { const e = new Error('proof'); e.name = 'ProofRequiredError'; throw e; }
      const s = find(id);
      s.state = 'partially_delivered';
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
  bannerMark(good === true);
  el('banner').hidden = false;
  el('banner-ok').textContent = t('ok');
  el('banner-ok').focus();
}
el('banner-ok').addEventListener('click', () => { el('banner').hidden = true; });

// ── The panel ───────────────────────────────────────────────────────────────

let sheetResolve = null;
let onEntryChange = null;
/** 'number' (an amount: a leading zero is dropped) or 'code' (the customer's four digits: every digit counts). */
let entryMode = 'number';

function ask({ title, mode, hint = '', initial = '0', options = [], onChange = null }) {
  const keyed = mode === 'number' || mode === 'code';
  entryMode = mode;
  say(el('sheet-title'), title, mode === 'code' ? 'key-round' : mode === 'number' ? 'calculator' : 'list');
  el('entry-hint').textContent = hint;
  el('entry').textContent = mode === 'code' ? '' : initial;
  el('entry').hidden = !keyed;
  el('keypad').hidden = !keyed;
  el('choices').hidden = mode !== 'choice';
  el('sheet-ok').hidden = !keyed;
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
    if (entryMode === 'code') {
      // Four digits, each one counted — "0042" is a code, not forty-two.
      el('entry').textContent = key === 'C' ? '' : key === '⌫' ? current.slice(0, -1) : (current.length < 4 ? current + key : current);
      return;
    }
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

  say(el('count-title'), t('countCash'), 'banknote');
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

/** A stop nothing more happens at on this route. A failed stop routed to try again is NOT one — it comes round. */
const TERMINAL = new Set(['delivered', 'partially_delivered', 'returned_to_origin', 'failed']);

/**
 * The stop the driver is at: the first on the route that is not finished.
 *
 * Selected on the driver's behalf, so the stop they are standing at is the one the buttons act on without a
 * tap first — the spec's rows (capture proof ≤ 3 · record COD ≤ 3 · mark failed with reason ≤ 3) are counted
 * from the doorstep, and a tap to say "this one" on every stop would spend a third of the budget on the
 * obvious (delivery.md). A driver who is somewhere else on the route taps that stop instead, and the choice
 * holds until that stop is finished. The selected stop is outlined, and every outcome names its area.
 */
function currentStop() {
  return session.route().find((s) => !TERMINAL.has(s.state)) ?? null;
}

/**
 * Where each outcome, the settlement and the handover have got to (SP-3c-ii): read from the DURABLE device queue plus the
 * store computer's own word, so the list is the same after the app is closed — the proof a delivery and its cash were not
 * lost with the phone. A refusal carries its reason, because a person has to act on it. Nothing here is a rule.
 */
function renderSent() {
  const sent = real && typeof real.sentWork === 'function' ? real.sentWork().slice(0, 12) : [];
  say(el('sent-heading'), t('sentHeading'), 'send');
  el('sent-heading').dataset.count = String(sent.length);
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
    say(state, words(SENT_STATE_WORDS, w.state), STATE_ICON[w.state]);
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

/** A booked line's name in the reader's language, from the store's catalogue when the box knew it; else its product id. */
const lineName = (line) => (lang === 'ta' && line.nameTa ? line.nameTa : line.name ?? line.productId);

/**
 * WF-16 (driver): the online returns booked for collection on this route. Each is a card like a stop — the area, the return
 * and order references (never a customer), the booked lines, and its state as a chip with its shape. Tapping it asks what
 * happened at the door. Nothing here moves money: the note says so in words.
 */
function renderCollections() {
  const list = typeof session.collections === 'function' ? session.collections() : [];
  say(el('returns-heading'), t('returnsHeading'), 'rotate-ccw');
  el('returns-heading').dataset.count = String(list.length);
  el('returns-heading').hidden = list.length === 0;
  el('returns-note').hidden = list.length === 0;
  el('returns-note').textContent = t('noMoneyAtDoor');
  el('collections').replaceChildren(...list.map((c) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `stop pickup ${c.state}`;
    card.dataset.returnId = c.returnId;
    card.dataset.state = c.state;
    const area = document.createElement('span');
    area.className = 'area';
    area.textContent = c.area;
    const refs = document.createElement('span');
    refs.className = 'order';
    refs.textContent = `${c.returnId} · ${c.orderRef} · ${t('bookedFor')} ${c.collectOn}`;
    const lines = document.createElement('span');
    lines.className = 'lines';
    const taken = new Map((c.taken ?? []).map((l) => [l.productId, l.collectedMinor]));
    lines.textContent = c.lines.map((l) => (c.state === 'collected' ? `${taken.get(l.productId) ?? 0} / ${l.quantityMinor}` : String(l.quantityMinor)) + ` × ${lineName(l)}`).join(' · ');
    const state = document.createElement('span');
    state.className = 'state';
    const missed = c.state === 'not_collected' && c.lastMissReason ? ` · ${t(MISS_REASONS.find((r) => r.code === c.lastMissReason)?.word ?? '')}` : '';
    say(state, `${words(COLLECTION_STATE_WORDS, c.state)}${missed}`, COLLECTION_ICON[c.state] ?? 'package');
    card.append(area, refs, lines, state);
    card.addEventListener('click', () => { void atReturn(c.returnId); });
    return card;
  }));
}

/**
 * At a return's door: "Collected" — then, line by line on the keypad, how many of each booked line he took (starting at the
 * booked number; more than booked is said as he types and refused by name) — or "Not collected" with one of two reasons.
 * The session decides and queues; this only asks. Nothing is refunded and no money is taken.
 */
async function atReturn(returnId) {
  const c = session.collections().find((x) => x.returnId === returnId);
  if (!c) return;
  if (c.state === 'collected') { tell(t('read'), t('collectionDone')); return; }
  const what = await ask({
    title: `${t('whatAtReturn')} · ${c.area}`,
    mode: 'choice',
    options: [{ value: 'collected', label: t('collectedAction') }, { value: 'not_collected', label: t('notCollectedAction') }],
  });
  if (what === null) return;
  try {
    if (what === 'not_collected') {
      const reason = await ask({ title: t('whyNotCollected'), mode: 'choice', options: MISS_REASONS.map((r) => ({ value: r.code, label: t(r.word) })) });
      if (reason === null) return;
      session.notCollected(returnId, reason);
      tell(t('notCollectedOk'), `${c.area} · ${t(MISS_REASONS.find((r) => r.code === reason).word)}`, true);
    } else {
      const lines = [];
      for (const l of c.lines) {
        const answer = await ask({
          title: `${t('howManyTook')} ${lineName(l)}?`,
          mode: 'number',
          hint: `${t('bookedQty')}: ${l.quantityMinor}`,
          initial: String(l.quantityMinor),
          onChange: (n) => (n > l.quantityMinor ? t('moreThanBooked') : `${t('bookedQty')}: ${l.quantityMinor}`),
        });
        if (answer === null) return;
        lines.push({ productId: l.productId, collectedMinor: Number(answer) });
      }
      session.collect(returnId, lines);
      const took = lines.filter((x) => x.collectedMinor > 0).map((x) => `${x.collectedMinor} × ${lineName(c.lines.find((b) => b.productId === x.productId))}`).join(', ');
      tell(t('collectedOk'), `${c.area} · ${took}`, true);
    }
    void syncToBox();
  } catch (e) {
    if (versionRefused(e)) { render(); return; }
    // Refused by the session BY NAME — nothing was queued. Said in the reader's words, with the model's own detail beside.
    const name = e && e.name === 'CollectionLinesError' ? e.code : null;
    const words2 = name === 'more_than_booked' ? t('moreThanBooked') : name === 'nothing_collected' ? t('nothingTaken') : null;
    tell(t('notRecorded'), words2 === null ? String(e && e.message ? e.message : e) : `${words2} (${e.message})`);
  }
  render();
}

/**
 * Hand the queued work to the store computer and learn where it has got to (SP-3c-ii). The relay is the composition root's
 * (`window.driverRelay`), present only when the box served this page over its device socket — on the shop wifi, before the
 * van leaves and when it is back. Called after every accepted action and every ten seconds; out on the road the calls simply
 * fail, the queue is untouched, and the state words say "saved here".
 */
async function syncToBox() {
  const relay = window.driverRelay;
  if (!relay) return;
  try {
    await relay.syncNow();
  } catch {
    /* the queue is untouched; the state words say "saved here" */
  }
  render();
}
const syncTimer = setInterval(() => { void syncToBox(); }, 10_000);
// Verifier hh L3: when the sign-in ends the screen locks (the strip's script); this screen's timers stop with it.
(window.phoneSignInOnLock = Array.isArray(window.phoneSignInOnLock) ? window.phoneSignInOnLock : []).push(() => clearInterval(syncTimer));

function render() {
  const stops = session.route();
  const progress = session.progress();
  const chosen = selected();
  if (chosen === null || TERMINAL.has(chosen.state)) selectedStopId = currentStop()?.stopId ?? null;
  el('route').firstChild.textContent = `${t('myRoute')} · ${session.routeId ?? ''} `;
  el('progress').textContent = progressWords(t('progressOf'), progress.delivered, progress.total);
  paintMeter(progress.delivered, progress.total);

  el('empty').hidden = stops.length > 0 || (typeof session.collections === 'function' && session.collections().length > 0);
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
    say(state, words(STATE_WORDS, stop.state), STOP_ICON[stop.state] ?? 'clock');

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
  say(el('deliver'), t('delivered'), 'circle-check');
  say(el('delivered-partial'), t('partlyDelivered'), 'package-minus');
  say(el('failed'), t('couldNotDeliver'), 'circle-alert');
  say(el('handover'), t('endOfShift'), 'wallet');
  renderCollections();
  renderQueue();
}

// ── Capturing the proof (OB-294 · M19-FR-03: captured, never typed) ─────────
//
// A photo is the phone camera's own picture, made small on the phone (a cheap phone's storage, the shop wifi) and handed to
// the session, which fingerprints it and queues it as its own record. A signature is the customer's finger on the screen.
// The code is the four digits the customer reads out of their app. Nothing here is a rule — the session decides.

/** Shrink a picture to a proof image: at most 640 px on its longest side, JPEG, under the session's limit. */
async function shrinkPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = url; });
    let max = 640;
    let quality = 0.6;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight, 1));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const g = canvas.getContext('2d');
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, canvas.width, canvas.height);
      g.drawImage(img, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL('image/jpeg', quality).split(',')[1] ?? '';
      if (data.length > 0 && data.length <= IMAGE_LIMIT) return { mediaType: 'image/jpeg', contentBase64: data };
      max = Math.round(max * 0.75);
      quality = Math.max(0.3, quality - 0.1);
    }
    return null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The photo panel: open the camera; the picture it hands back is used (or refused — take it again). Null on Cancel. */
function capturePhoto() {
  let image = null;
  say(el('photo-title'), t('takePhoto'), 'scan-line');
  el('photo-hint').textContent = t('photoHint');
  say(el('photo-open'), t('openCamera'), 'scan-line');
  el('photo-cancel').textContent = t('cancel');
  el('photo-input').value = '';
  el('photo').hidden = false;
  return new Promise((resolve) => {
    const finish = (answer) => { el('photo').hidden = true; el('photo-input').onchange = null; el('photo-cancel').onclick = null; resolve(answer); };
    el('photo-input').onchange = async () => {
      const file = el('photo-input').files?.[0];
      if (!file) return;
      image = await shrinkPhoto(file);
      if (image === null) { el('photo-hint').textContent = t('imageError'); say(el('photo-open'), t('retake'), 'refresh-cw'); return; }
      // The phone's own camera already asked "use this photo?" — so the picture it hands back is used at once, keeping the
      // doorstep to three taps (delivery.md budget). "Take it again" stays offered while a bad picture is refused.
      finish(image);
    };
    el('photo-cancel').onclick = () => finish(null);
  });
}

/** The signature panel: the customer signs with a finger; Done is offered once there is a stroke. */
function captureSignature() {
  const pad = el('sign-pad');
  const g = pad.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, pad.width, pad.height);
  g.strokeStyle = '#111111';
  g.lineWidth = 3;
  g.lineCap = 'round';
  let drawing = false;
  let strokes = 0;
  const at = (e) => { const r = pad.getBoundingClientRect(); return [((e.clientX - r.left) * pad.width) / r.width, ((e.clientY - r.top) * pad.height) / r.height]; };
  say(el('sign-title'), t('signHere'), 'hand');
  el('sign-clear').textContent = t('clear');
  el('sign-done').textContent = t('done');
  el('sign-cancel').textContent = t('cancel');
  el('sign-done').disabled = true;
  el('sign').hidden = false;
  pad.onpointerdown = (e) => { drawing = true; const [x, y] = at(e); g.beginPath(); g.moveTo(x, y); pad.setPointerCapture?.(e.pointerId); };
  pad.onpointermove = (e) => { if (!drawing) return; const [x, y] = at(e); g.lineTo(x, y); g.stroke(); };
  pad.onpointerup = () => { if (drawing) { strokes += 1; el('sign-done').disabled = false; } drawing = false; };
  return new Promise((resolve) => {
    const finish = (answer) => { el('sign').hidden = true; pad.onpointerdown = null; pad.onpointermove = null; pad.onpointerup = null; resolve(answer); };
    el('sign-clear').onclick = () => { g.fillStyle = '#ffffff'; g.fillRect(0, 0, pad.width, pad.height); strokes = 0; el('sign-done').disabled = true; };
    el('sign-done').onclick = () => {
      if (strokes === 0) return;
      let data = pad.toDataURL('image/png').split(',')[1] ?? '';
      let mediaType = 'image/png';
      if (data.length > IMAGE_LIMIT) { data = pad.toDataURL('image/jpeg', 0.6).split(',')[1] ?? ''; mediaType = 'image/jpeg'; }
      finish(data.length > 0 && data.length <= IMAGE_LIMIT ? { mediaType, contentBase64: data } : null);
    };
    el('sign-cancel').onclick = () => finish(null);
  });
}

/** Where the phone is, at the hand-over only — or nothing. Never a block: no permission or no fix is simply "no location". */
function whereAmI() {
  const geo = navigator.geolocation;
  if (!geo || typeof geo.getCurrentPosition !== 'function') return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 8_000);
    geo.getCurrentPosition(
      (p) => { clearTimeout(timer); resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracyMetres: Math.round(p.coords.accuracy ?? 0) }); },
      () => { clearTimeout(timer); resolve(undefined); },
      { enableHighAccuracy: true, timeout: 7_000, maximumAge: 60_000 },
    );
  });
}

/** Ask how the delivery was proved, then CAPTURE it. Resolves the proof the session takes, or null when the driver cancels. */
async function askProof(title) {
  const kind = await ask({ title, mode: 'choice', options: PROOF_KINDS.map((p) => ({ value: p.kind, label: t(p.word) })) });
  if (kind === null) return null;
  if (kind === 'otp') {
    const code = await ask({ title: t('codeTitle'), mode: 'code', hint: t('codeHint') });
    if (code === null) return null;
    return { kind: 'otp', code: String(code) };
  }
  const image = kind === 'photo' ? await capturePhoto() : await captureSignature();
  if (image === null) return null;
  return { kind, image };
}

/** The words for a refusal the session raised at capture, in the reader's language. */
function proofRefusal(e) {
  const name = e && e.name;
  if (name === 'ProofRequiredError' || name === 'ProofNotCapturedError') return t('noProof');
  if (name === 'DeliveryCodeFormatError') return t('codeFormat');
  if (name === 'ProofImageError') return t('imageError');
  return String(e && e.message ? e.message : e);
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

  // Proof FIRST — the order it happens at the door, and the session refuses a hand-over without it.
  const proof = await askProof(t('howProved'));
  if (proof === null) { tell(t('read'), t('noProof')); return; }

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

  // Where the phone is, at the hand-over only (D09-FR-05): head office compares it with the stored address and keeps only
  // the verdict. No permission or no fix is "no location" — it never stops a delivery.
  const deviceFix = await whereAmI();
  try {
    if (stop.state === 'assigned') session.depart(stop.stopId);
    session.deliver(stop.stopId, proof, { codCollectedMinor: collected, codMethod: method, ...(deviceFix === undefined ? {} : { deviceFix }) });
    tell(t('deliveredOk'), `${stop.area}${collected > 0 ? ` · ${inr(collected)}` : ''}${proof.kind === 'otp' ? ` — ${t('codeLater')}` : ''}`, true);
    void syncToBox();
  } catch (e) {
    if (versionRefused(e)) { render(); return; }
    tell(t('read'), proofRefusal(e));
  }
  render();
});

/**
 * A PARTIAL delivery — the customer kept some of the order.
 *
 * The same proof-then-money order as a full delivery, because it happens at the same doorstep and the
 * model refuses it without proof. What differs is meaning: this is a **terminal** outcome, the cash
 * recorded is only what was taken for the goods handed over, and the undelivered remainder is settled
 * downstream (never a driver "short"). The button exists so this real situation is a recorded outcome
 * rather than a driver forcing a full "delivered" or a "failed" onto a stop that was neither.
 */
el('delivered-partial').addEventListener('click', async () => {
  const stop = selected();
  if (stop === null) { tell(t('read'), t('tapStopFirst')); return; }
  if (stop.state === 'delivered' || stop.state === 'partially_delivered' || stop.state === 'returned_to_origin') {
    tell(t('read'), t('stopDone')); return;
  }

  // Proof FIRST — the order it happens at the door, and the session refuses a hand-over without it.
  const proof = await askProof(t('howProved'));
  if (proof === null) { tell(t('read'), t('noProof')); return; }

  let collected = 0;
  let method;
  if (stop.codMinor > 0) {
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

  const deviceFix = await whereAmI();
  try {
    if (stop.state === 'assigned') session.depart(stop.stopId);
    session.deliverPartial(stop.stopId, proof, { codCollectedMinor: collected, codMethod: method, ...(deviceFix === undefined ? {} : { deviceFix }) });
    tell(t('partialOk'), `${stop.area}${collected > 0 ? ` · ${inr(collected)}` : ''}${proof.kind === 'otp' ? ` — ${t('codeLater')}` : ''}`, true);
    void syncToBox();
  } catch (e) {
    if (versionRefused(e)) { render(); return; }
    tell(t('read'), proofRefusal(e));
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
    void syncToBox();
  } catch (e) {
    if (versionRefused(e)) { render(); return; }
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
    // End of shift is when the day's COD is reconciled (M19-FR-04): the settlement — expected against collected, every short
    // or over a valued exception — is queued FIRST, then the counted handover against it. Both travel whatever they say.
    if (typeof session.settle === 'function') session.settle();
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
  el('sample').textContent = t('sampleRoute');
  el('empty').textContent = `${t('noRoute')} ${t('noRouteBody')}`;
  render();
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

/** A store-computer time on the SHOP's clock (OB-607: its zone as the box served it, never this device's own), HH:MM. */
function clock(iso) {
  return shopTimeOf(iso);
}

function paintBadge() {
  const dot = el('queue-dot');
  const unsent = outbox === null ? 0 : outbox.unsentCount();
  dot.classList.remove('waiting', 'error', 'idle', 'degraded');
  // Words as well as a dot — one man in twelve cannot tell the two colours apart. The first line counts THIS phone's work by
  // where each piece is (SP-3c-ii): saved here · retrying · with the store computer · posted · refused — never a bare "sent"
  // (P-08). Without a session it falls back to the queue's own unsent count.
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
      boxWords = `${s.cloud === 'offline' ? t('noCloud') : s.cloud === 'login_refused' ? t('cloudLoginRefused') : s.cloud === 'not_configured' ? t('cloudNotSetUp') : t('cloudUnknown')}${when}`;
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
    // OB-521: the app version policy as the store computer's signed pack has it now (only an answer from the box changes it).
    if (box.reachable && box.status && 'appVersionPolicy' in box.status) window.driverVersion?.apply(box.status.appVersionPolicy);
  } catch {
    box = { asked: true, reachable: false, status: null };
  } finally {
    clearTimeout(timer);
  }
  paintBadge();
}
window.driverBadge = { refresh: refreshBadge, state: () => box };
void refreshBadge();
const badgeTimer = setInterval(() => { void refreshBadge(); }, 10_000);
window.phoneSignInOnLock.push(() => clearInterval(badgeTimer));

// ── Boot ────────────────────────────────────────────────────────────────────

el('sample').hidden = real !== undefined;
el('sample').textContent = t('sampleRoute');
paintIconSlots();

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
  // OB-607: the SHOP's clock (the zone the store computer served), never this device's own — a phone or laptop set to
  // another zone read the shop's 01:00 as its own evening.
  strip.textContent = `${t('staleShell')} ${shopWhen(at)}`;
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
