// Store manager shell — the view layer. It renders what the store knows and dispatches manager
// intents; every rule lives in the TESTED session model (`apps/web-erp/src/manager-session.ts`),
// attached as `window.managerSession`.
//
// ── What this file is careful about ─────────────────────────────────────────
//
// **1. "Not known" is rendered as loudly as a problem, because it is one.** Four figures run this
// screen — approvals, exceptions, unsent items, tasks — and each can come back as a count or as
// *I could not read that*. A screen that painted the second as `0` would let a manager lock a
// trading day on the strength of a page that had never spoken to the store. So an unknown figure
// gets the red edge, the words, and the reason.
//
// **2. The day close renders a LIST.** The model hands back every blocker at once with the actual
// items behind it. Clearing an exception only to be told about unsent sales is two trips to the
// same screen at eleven at night. The list is shortened for display and says how many more — the
// count beside it is always the true one.
//
// **3. The reason for a decision is a code from the model, never a sentence from here.** The view
// holds the words in two languages; the audit trail gets the code. "ok fine" cannot be reported on
// a year later, and a screen that composed its own reason strings would guarantee that is what the
// trail fills up with.
//
// **4. No `prompt`, `confirm` or `alert`, and the banner does not fade** — the same two decisions
// the till screen holds, for the same reasons.
//
// Nothing here calls the network. What this screen was told arrives as a last-synced payload and
// is never presented as live.

const el = (id) => document.getElementById(id);

/** Exact minor units in, rupees out. The model never sees a float. */
const inr = (minor) =>
  '₹' + (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── Words ───────────────────────────────────────────────────────────────────
//
// Tamil is a first language for much of this store's staff, not a translation afterthought. A
// half-translated screen reads as unfinished exactly where somebody is relying on it.
const WORDS = {
  en: {
    manager: 'Store manager', tradingDay: 'Trading day', connected: 'Connected',
    notConnected: 'Not connected to the store', today: 'Today', approvals: 'Approvals',
    receive: 'Receive', count: 'Count', closeDay: 'Close the day',
    tapAFigure: 'Tap a figure to go to it.', waiting: 'waiting', youCanClear: 'you can clear',
    exceptionsLabel: 'Exceptions open', unsentLabel: 'Not yet sent to cloud', tasksLabel: 'Tasks today',
    approvalsLabel: 'Approvals waiting', notKnown: 'Not known', nothingWaiting: 'Nothing is waiting.',
    biggestFirst: 'Biggest first.', approve: 'Approve', reject: 'Reject', cancel: 'Cancel', ok: 'OK',
    whyApprove: 'Why are you approving this?', whyReject: 'Why are you rejecting this?',
    decided: 'Decided', requestedBy: 'asked for by', noValue: 'no value',
    read: 'Please read this', done: 'Done',
    deliveryNote: 'Delivery note number', poNumber: 'Purchase order number (leave empty if there is none)',
    itemCode: 'Item code', howMany: 'How many', addItem: 'Add this item', noItemsYet: 'No items added yet.',
    saveDelivery: 'Save the delivery', remove: 'Remove',
    needNumber: 'Give the delivery note a number first.', needLines: 'Add at least one item first.',
    needItem: 'Type an item code and how many.',
    received: 'Delivery saved', unmatchedWarning: 'There is no purchase order behind this delivery, so nobody can check the invoice against it. Tell the buyer today.',
    matchedNote: 'Stock is up to date. It will go to the cloud on its own.',
    productCode: 'Product code', whereIsIt: 'Where (aisle or bay)',
    enterCount: 'Enter the count', howManyOnShelf: 'How many are actually there?',
    countBlindHint: "Count what is actually on the shelf. This screen will not show you the system's figure first — that is on purpose.",
    whyDifferent: 'Why is it different?', needProduct: 'Type a product code and where it is.',
    countMatches: 'The count matches the system exactly.',
    countedMore: 'You counted more than the system had, by', countedFewer: 'You counted fewer than the system had, by',
    worth: 'worth', needsApproval: 'This difference is large enough that somebody else must approve it. It is recorded and waiting.',
    cannotValue: 'This screen does not know what that item is worth, so it cannot work out how much the difference costs — and a difference worth nothing would slip past the approval limit. Nothing has been changed.',
    checkOpen: 'Check what is still open', closeNow: 'Close the day now',
    closedNote: 'A closed day is locked. Anything found afterwards is a correction, not a change.',
    dayClosed: 'The day is closed and locked.', stillOpen: 'The day cannot close yet',
    andMore: 'and more', whatToDo: 'What to do',
    sampleData: 'Sample data — this is not your store.',
    countedSoFar: 'Counted', item: 'Item',
  },
  ta: {
    manager: 'கடை மேலாளர்', tradingDay: 'வியாபார நாள்', connected: 'இணைப்பில்',
    notConnected: 'கடையுடன் இணைப்பு இல்லை', today: 'இன்று', approvals: 'ஒப்புதல்கள்',
    receive: 'பொருள் பெறு', count: 'எண்ணிக்கை', closeDay: 'நாளை முடி',
    tapAFigure: 'ஒரு எண்ணைத் தொட்டால் அந்தத் திரைக்குச் செல்லும்.', waiting: 'காத்திருக்கிறது',
    youCanClear: 'நீங்கள் முடிக்கக்கூடியவை', exceptionsLabel: 'திறந்த விதிவிலக்குகள்',
    unsentLabel: 'கிளௌடுக்கு அனுப்பப்படாதவை', tasksLabel: 'இன்றைய பணிகள்',
    approvalsLabel: 'காத்திருக்கும் ஒப்புதல்கள்', notKnown: 'தெரியவில்லை',
    nothingWaiting: 'எதுவும் காத்திருக்கவில்லை.', biggestFirst: 'பெரியது முதலில்.',
    approve: 'ஒப்புதல்', reject: 'மறு', cancel: 'ரத்து', ok: 'சரி',
    whyApprove: 'ஏன் ஒப்புதல் அளிக்கிறீர்கள்?', whyReject: 'ஏன் மறுக்கிறீர்கள்?',
    decided: 'முடிவு பதிவாகியது', requestedBy: 'கேட்டவர்', noValue: 'மதிப்பு இல்லை',
    read: 'இதைப் படிக்கவும்', done: 'முடிந்தது',
    deliveryNote: 'டெலிவரி நோட்டு எண்', poNumber: 'கொள்முதல் ஆர்டர் எண் (இல்லையென்றால் காலியாக விடவும்)',
    itemCode: 'பொருள் குறியீடு', howMany: 'எத்தனை', addItem: 'இந்தப் பொருளைச் சேர்',
    noItemsYet: 'இன்னும் எந்தப் பொருளும் சேர்க்கப்படவில்லை.', saveDelivery: 'டெலிவரியைச் சேமி',
    remove: 'நீக்கு', needNumber: 'முதலில் டெலிவரி நோட்டு எண்ணைக் கொடுக்கவும்.',
    needLines: 'குறைந்தது ஒரு பொருளையாவது சேர்க்கவும்.', needItem: 'பொருள் குறியீடும் எண்ணிக்கையும் தேவை.',
    received: 'டெலிவரி சேமிக்கப்பட்டது',
    unmatchedWarning: 'இந்த டெலிவரிக்கு கொள்முதல் ஆர்டர் இல்லை. எனவே இன்வாய்ஸை யாரும் சரிபார்க்க முடியாது. இன்றே வாங்குபவரிடம் சொல்லவும்.',
    matchedNote: 'இருப்பு புதுப்பிக்கப்பட்டது. அது தானாகவே கிளௌடுக்குச் செல்லும்.',
    productCode: 'பொருள் குறியீடு', whereIsIt: 'எங்கே (அடுக்கு அல்லது இடம்)',
    enterCount: 'எண்ணிக்கையைப் பதிவு செய்', howManyOnShelf: 'உண்மையில் எத்தனை உள்ளன?',
    countBlindHint: 'அடுக்கில் உள்ளதை எண்ணவும். கணினியின் எண்ணிக்கையை இந்தத் திரை முதலில் காட்டாது — அது வேண்டுமென்றே.',
    whyDifferent: 'ஏன் வித்தியாசம்?', needProduct: 'பொருள் குறியீடும் இடமும் தேவை.',
    countMatches: 'எண்ணிக்கை கணினியுடன் சரியாகப் பொருந்துகிறது.',
    countedMore: 'கணினியில் உள்ளதை விட நீங்கள் எண்ணியது அதிகம்', countedFewer: 'கணினியில் உள்ளதை விட நீங்கள் எண்ணியது குறைவு',
    worth: 'மதிப்பு', needsApproval: 'இந்த வித்தியாசம் பெரியது. வேறு ஒருவர் ஒப்புதல் அளிக்க வேண்டும். பதிவு செய்யப்பட்டு காத்திருக்கிறது.',
    cannotValue: 'அந்தப் பொருளின் மதிப்பு இந்தத் திரைக்குத் தெரியாது. எனவே வித்தியாசத்தின் மதிப்பைக் கணக்கிட முடியாது — மதிப்பு இல்லாத வித்தியாசம் ஒப்புதல் வரம்பைத் தாண்டிவிடும். எதுவும் மாற்றப்படவில்லை.',
    checkOpen: 'இன்னும் என்ன மீதம் உள்ளது என்று பார்', closeNow: 'இப்போது நாளை முடி',
    closedNote: 'முடிக்கப்பட்ட நாள் பூட்டப்படும். பின்னர் கண்டறியப்படுவது திருத்தமே, மாற்றம் அல்ல.',
    dayClosed: 'நாள் முடிக்கப்பட்டு பூட்டப்பட்டது.', stillOpen: 'நாளை இன்னும் முடிக்க முடியாது',
    andMore: 'மேலும்', whatToDo: 'என்ன செய்ய வேண்டும்',
    sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
    countedSoFar: 'எண்ணப்பட்டது', item: 'பொருள்',
  },
};
let lang = 'en';
const t = (key) => WORDS[lang][key] ?? WORDS.en[key];

/**
 * One entry per `BlockerKind` in the model, in both languages.
 *
 * The model returns structure — kind, count, items — and never a sentence, so that the words can be
 * Tamil without the model holding two copies of them. A guardrail checks this map covers every kind
 * the model can produce, in both languages: adding a kind and forgetting the words would show a
 * manager a blank reason at exactly the moment they most need one.
 */
const BLOCKER_WORDS = {
  day_not_ended: {
    en: { title: 'The trading day has not ended yet', todo: 'Wait until after the cut-off time. The shop may still be trading.' },
    ta: { title: 'வியாபார நாள் இன்னும் முடியவில்லை', todo: 'நிர்ணயிக்கப்பட்ட நேரம் வரை காத்திருக்கவும். கடை இன்னும் வியாபாரத்தில் இருக்கலாம்.' },
  },
  exceptions_open: {
    en: { title: 'exception(s) are still open', todo: 'Clear each one below, then check again.' },
    ta: { title: 'விதிவிலக்கு(கள்) இன்னும் திறந்திருக்கின்றன', todo: 'கீழே உள்ள ஒவ்வொன்றையும் முடித்துவிட்டு மீண்டும் பார்க்கவும்.' },
  },
  items_unsent: {
    en: { title: 'item(s) have not reached the cloud', todo: 'Nothing is lost — they are saved in the store. Check the internet connection, then check again.' },
    ta: { title: 'பொருள்(கள்) கிளௌடுக்குச் செல்லவில்லை', todo: 'எதுவும் இழக்கப்படவில்லை — கடையில் சேமிக்கப்பட்டுள்ளன. இணைய இணைப்பைச் சரிபார்த்து மீண்டும் பார்க்கவும்.' },
  },
  cannot_see: {
    en: { title: 'This screen could not read one of the lists it must check', todo: 'The day must NOT be closed until it can. Tell whoever looks after the store computer.' },
    ta: { title: 'சரிபார்க்க வேண்டிய பட்டியல் ஒன்றை இந்தத் திரையால் படிக்க முடியவில்லை', todo: 'படிக்க முடியும் வரை நாளை முடிக்கக் கூடாது. கடை கணினியைப் பார்ப்பவரிடம் சொல்லவும்.' },
  },
  rules_refused: {
    en: { title: 'The day-close rules refused', todo: 'The screen and the rules disagree. Do not force it — report this.' },
    ta: { title: 'நாள் முடிப்பு விதிகள் மறுத்தன', todo: 'திரைக்கும் விதிகளுக்கும் ஒற்றுமை இல்லை. கட்டாயப்படுத்த வேண்டாம் — இதைத் தெரிவிக்கவும்.' },
  },
};

/**
 * Why a decision was refused — one entry per `DecideRefusal` in the model.
 *
 * A refusal shown as its raw code is a manager reading `self_approval_forbidden` off a screen and
 * tapping the button again, harder. Guarded the same way the blockers are.
 */
const REFUSAL_WORDS = {
  self_approval_forbidden: { en: 'You asked for this yourself, so somebody else has to decide it.', ta: 'இதை நீங்களே கேட்டீர்கள். எனவே வேறு ஒருவர் முடிவு செய்ய வேண்டும்.' },
  reason_required: { en: 'A reason has to be recorded with every decision.', ta: 'ஒவ்வொரு முடிவுக்கும் ஒரு காரணம் பதிவு செய்யப்பட வேண்டும்.' },
  out_of_scope: { en: 'This is not your branch to decide.', ta: 'இது உங்கள் கிளை அல்ல.' },
  exceeds_authority: { en: 'This is above your approval limit. Send it up.', ta: 'இது உங்கள் ஒப்புதல் வரம்பைத் தாண்டியது. மேலே அனுப்பவும்.' },
  request_not_found: { en: 'That request is no longer waiting. Somebody else may have decided it.', ta: 'அந்தக் கோரிக்கை இனி காத்திருக்கவில்லை. வேறு ஒருவர் முடிவு செய்திருக்கலாம்.' },
  unknown_reason_code: { en: 'That reason cannot be used for this decision.', ta: 'இந்த முடிவுக்கு அந்தக் காரணத்தைப் பயன்படுத்த முடியாது.' },
};

/** Why a queued request is not this manager's to decide (the workbench's `blockedReason`). */
const BLOCKED_WORDS = {
  own_request: { en: 'Your own request — somebody else must decide it', ta: 'உங்கள் சொந்தக் கோரிக்கை — வேறு ஒருவர் முடிவு செய்ய வேண்டும்' },
  out_of_scope: { en: 'Not your branch', ta: 'உங்கள் கிளை அல்ல' },
  exceeds_authority: { en: 'Above your approval limit — send it up', ta: 'உங்கள் ஒப்புதல் வரம்பைத் தாண்டியது — மேலே அனுப்பவும்' },
};

/**
 * Words for each reason code the model offers.
 *
 * The codes come from the model (`window.managerReasons`); only the words live here. A guardrail
 * checks every code in the model's catalogue has both languages, so adding a reason without
 * translating it fails the build rather than showing a manager a bare `not_enough_evidence`.
 */
const REASON_WORDS = {
  within_policy: { en: 'It is within policy', ta: 'இது கொள்கைக்கு உட்பட்டது' },
  checked_with_supplier: { en: 'I checked with the supplier', ta: 'சப்ளையரிடம் சரிபார்த்தேன்' },
  checked_the_stock: { en: 'I checked the stock myself', ta: 'இருப்பை நானே சரிபார்த்தேன்' },
  owner_instructed: { en: 'The owner told me to', ta: 'உரிமையாளர் சொன்னார்' },
  price_looks_wrong: { en: 'The price looks wrong', ta: 'விலை தவறாகத் தெரிகிறது' },
  not_enough_evidence: { en: 'Not enough proof', ta: 'போதுமான ஆதாரம் இல்லை' },
  against_policy: { en: 'Against policy', ta: 'கொள்கைக்கு எதிரானது' },
  ask_the_owner_first: { en: 'Ask the owner first', ta: 'முதலில் உரிமையாளரிடம் கேட்கவும்' },
};

/** What a request is about. An unknown type is shown as itself rather than hidden. */
const SUBJECT_WORDS = {
  price_change: { en: 'Price change', ta: 'விலை மாற்றம்' },
  stock_adjustment: { en: 'Stock adjustment', ta: 'இருப்புத் திருத்தம்' },
  refund: { en: 'Refund', ta: 'திரும்பப் பணம்' },
  purchase_order: { en: 'Purchase order', ta: 'கொள்முதல் ஆர்டர்' },
  day_reopen: { en: 'Reopen a closed day', ta: 'முடிக்கப்பட்ட நாளைத் திறத்தல்' },
  write_off: { en: 'Write-off', ta: 'எழுதித் தள்ளல்' },
};

/** Why a count differs. Chosen, never typed — a typed reason is one nobody can report on (M15). */
const COUNT_REASONS = [
  { code: 'shrinkage', en: 'Missing — probably theft', ta: 'காணவில்லை — திருட்டாக இருக்கலாம்' },
  { code: 'damage', en: 'Damaged', ta: 'சேதமடைந்தது' },
  { code: 'expiry', en: 'Out of date', ta: 'காலாவதி' },
  { code: 'miscount_earlier', en: 'An earlier count was wrong', ta: 'முந்தைய எண்ணிக்கை தவறு' },
  { code: 'wrong_item_scanned', en: 'Wrong item was scanned somewhere', ta: 'எங்கோ தவறான பொருள் ஸ்கேன் ஆனது' },
  { code: 'found_in_backroom', en: 'Found in the back room', ta: 'பின் அறையில் கிடைத்தது' },
];

const words = (map, key) => (map[key]?.[lang] ?? map[key]?.en ?? String(key).replace(/_/g, ' '));

/**
 * Stand-in with the same surface as the bundled `ManagerSession`, so the layout is runnable and
 * usability-testable before the bundler lands. Replaced at build time by the real, tested model.
 *
 * It deliberately shows a store that CANNOT close — two exceptions and three unsent sales. That is
 * the path worth rehearsing, and a demo that showed a clean close would teach a manager the button
 * always works. Whenever this stand-in is in use the header says so.
 */
function demoSession() {
  const requests = [
    { id: 'a1', subjectType: 'refund', subjectRef: 'R-2291', requestedBy: 'Meena (till 3)', branchId: 'b1', value: { minor: 249_900, currency: 'INR' }, status: 'pending' },
    { id: 'a2', subjectType: 'price_change', subjectRef: 'Toor dal 1kg', requestedBy: 'Karthik (buying)', branchId: 'b1', value: { minor: 45_000, currency: 'INR' }, status: 'pending' },
    { id: 'a3', subjectType: 'stock_adjustment', subjectRef: 'Aisle 4 count', requestedBy: 'you', branchId: 'b1', value: { minor: 812_000, currency: 'INR' }, status: 'pending' },
  ];
  const exceptions = [
    { id: 'e1', what: 'Till 3 is short by ₹420' },
    { id: 'e2', what: 'Nine voids by one cashier in an hour' },
  ];
  const unsent = [
    { id: 'u1', what: 'Sale from lane 2' }, { id: 'u2', what: 'Sale from lane 2' }, { id: 'u3', what: 'Sale from lane 5' },
  ];
  const decided = new Set();
  const open = () => exceptions.filter((e) => !decided.has(e.id));
  return {
    floor: () => ({
      tradingDay: 'sample',
      approvalsWaiting: { known: true, count: requests.length },
      approvalsIcanClear: { known: true, count: requests.filter((r) => r.requestedBy !== 'you').length },
      exceptions: { known: true, count: open().length },
      unsent: { known: true, count: unsent.length },
      tasks: { known: false, why: 'this is sample data' },
    }),
    approvalQueue: () => ({
      known: true,
      rows: [...requests].sort((a, b) => b.value.minor - a.value.minor).map((request) => ({
        request,
        actionable: request.requestedBy !== 'you',
        blockedReason: request.requestedBy === 'you' ? 'own_request' : undefined,
      })),
    }),
    decideApproval: ({ requestId }) => {
      const i = requests.findIndex((r) => r.id === requestId);
      if (i < 0) return { ok: false, refusal: 'request_not_found' };
      requests.splice(i, 1);
      return { ok: true, request: { id: requestId } };
    },
    receive: ({ poId }) => ({ receipt: { number: 'sample' }, unmatched: poId === null }),
    countStock: () => ({ counted: false, refusal: 'value_not_known', why: 'this is sample data' }),
    blockersForClose: () => [
      { kind: 'exceptions_open', count: open().length, items: open(), source: 'exceptions' },
      { kind: 'items_unsent', count: unsent.length, items: unsent, source: 'unsent' },
    ].filter((b) => b.count > 0),
    closeTheDay: () => ({ closed: false, blockers: [] }),
    exceptions: () => ({ known: true, items: open() }),
    tasks: () => ({ known: false, why: 'this is sample data' }),
  };
}

const real = window.managerSession;
const session = real ?? demoSession();
const REASONS = window.managerReasons ?? {
  approved: ['within_policy', 'checked_with_supplier', 'checked_the_stock', 'owner_instructed'],
  rejected: ['price_looks_wrong', 'not_enough_evidence', 'against_policy', 'ask_the_owner_first'],
};

// ── The banner ──────────────────────────────────────────────────────────────

/**
 * Say something the manager must read, and keep saying it.
 *
 * No timeout, for the same reason the till's has none: a message that fades is a message that was
 * missed, and "the day did not close" is not a message to miss.
 */
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

/**
 * Ask the manager something, on screen. `mode` is `'number'` (keypad) or `'choice'` (buttons).
 *
 * A choice resolves the moment it is tapped: an approval reason is one tap, not a tap and a
 * confirm, which is what keeps the whole decision inside the ≤3-tap budget (QG-02).
 */
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

// The keypad, built once. `C` and `⌫` are as large as the digits — correcting a mis-tap is as
// frequent as tapping, and a cramped backspace is how a wrong count gets committed.
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

// ── Navigation ──────────────────────────────────────────────────────────────

const VIEWS = ['home', 'approvals', 'receive', 'count', 'close'];
let view = 'home';

function show(next) {
  view = next;
  for (const name of VIEWS) {
    el(`view-${name}`).hidden = name !== next;
    el(`tab-${name}`).setAttribute('aria-current', name === next ? 'page' : 'false');
  }
  if (next === 'home') renderHome();
  if (next === 'approvals') renderApprovals();
  if (next === 'close') resetClose();
}
for (const name of VIEWS) el(`tab-${name}`).addEventListener('click', () => show(name));

// ── Home: four figures, and every one may say it does not know ──────────────

/** A figure that could not be read is not a zero, and it is not painted like one. */
function tile({ figure, label, note, goTo, attentionWhen }) {
  const box = document.createElement('div');
  box.className = 'tile';
  const n = document.createElement('div');
  n.className = 'n';
  if (figure.known) {
    n.textContent = String(figure.count);
    if (attentionWhen && attentionWhen(figure.count)) box.classList.add('attention');
  } else {
    n.classList.add('unknown');
    n.textContent = t('notKnown');
    box.classList.add('unknown');
  }
  const caption = document.createElement('div');
  caption.className = 'label';
  caption.textContent = label;
  const small = document.createElement('div');
  small.className = 'note';
  // The reason it does not know, in the model's own words — it is the only place that knows.
  small.textContent = figure.known ? (note ?? '') : figure.why;
  box.append(n, caption, small);
  if (goTo) {
    box.tabIndex = 0;
    box.setAttribute('role', 'button');
    box.addEventListener('click', () => show(goTo));
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') show(goTo); });
  }
  return box;
}

function renderHome() {
  const floor = session.floor();
  el('day').textContent = `${t('tradingDay')} ${floor.tradingDay}`;
  const clearable = floor.approvalsIcanClear;
  el('tiles').replaceChildren(
    tile({
      figure: floor.approvalsWaiting,
      label: t('approvalsLabel'),
      note: clearable.known ? `${clearable.count} ${t('youCanClear')}` : '',
      goTo: 'approvals',
      attentionWhen: (n) => n > 0,
    }),
    tile({ figure: floor.exceptions, label: t('exceptionsLabel'), goTo: 'close', attentionWhen: (n) => n > 0 }),
    tile({ figure: floor.unsent, label: t('unsentLabel'), goTo: 'close', attentionWhen: (n) => n > 0 }),
    tile({ figure: floor.tasks, label: t('tasksLabel') }),
  );

  // The link to the store is the same fact as "could I read the registers", so the badge says it.
  const blind = [floor.approvalsWaiting, floor.exceptions, floor.unsent].some((f) => !f.known);
  el('conn-dot').classList.toggle('unknown', blind);
  el('conn-text').textContent = blind ? t('notConnected') : t('connected');
}

// ── The approval inbox ──────────────────────────────────────────────────────

function renderApprovals() {
  const queue = session.approvalQueue();
  if (!queue.known) {
    // An empty list and an unreadable one look identical. Only one of them means "nothing to do".
    el('approval-rows').replaceChildren();
    el('approvals-empty').hidden = false;
    el('approvals-empty').textContent = `${t('notKnown')} — ${queue.why}`;
    return;
  }
  el('approvals-empty').hidden = queue.rows.length > 0;
  el('approvals-empty').textContent = t('nothingWaiting');

  el('approval-rows').replaceChildren(...queue.rows.map((row) => {
    const box = document.createElement('div');
    box.className = 'row';

    const what = document.createElement('div');
    what.className = 'what';
    what.textContent = `${words(SUBJECT_WORDS, row.request.subjectType)} · ${row.request.subjectRef}`;

    const value = document.createElement('div');
    value.className = 'value';
    value.textContent = row.request.value ? inr(row.request.value.minor) : t('noValue');

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${t('requestedBy')} ${row.request.requestedBy}`;

    box.append(what, value, meta);

    if (row.actionable) {
      const actions = document.createElement('div');
      actions.className = 'row-actions';
      for (const [decision, label, cls] of [
        ['approved', t('approve'), 'primary'], ['rejected', t('reject'), 'danger'],
      ]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = cls;
        button.textContent = label;
        button.addEventListener('click', () => decide(row.request, decision));
        actions.appendChild(button);
      }
      box.appendChild(actions);
    } else {
      // Never a button that will fail on submit. The reason is the whole row's message.
      const blocked = document.createElement('div');
      blocked.className = 'blocked';
      blocked.textContent = words(BLOCKED_WORDS, row.blockedReason);
      box.appendChild(blocked);
    }
    return box;
  }));
}

/**
 * Decide one request: tap Approve, tap a reason. Two taps, inside the ≤3 budget (QG-02).
 *
 * The reason offered comes from the model's catalogue for that decision, so "against policy" is
 * never on the approve list. The CODE is what is recorded.
 */
async function decide(request, decision) {
  const codes = decision === 'approved' ? REASONS.approved : REASONS.rejected;
  const reasonCode = await ask({
    title: decision === 'approved' ? t('whyApprove') : t('whyReject'),
    mode: 'choice',
    options: codes.map((code) => ({ value: code, label: words(REASON_WORDS, code) })),
  });
  if (reasonCode === null) return;

  const outcome = session.decideApproval({
    requestId: request.id, decision, reasonCode, decidedAt: new Date().toISOString(),
  });
  if (outcome.ok) {
    tell(t('decided'), `${words(SUBJECT_WORDS, request.subjectType)} · ${request.subjectRef}`, true);
  } else {
    // The refusal names a rule, so it is shown in words rather than swallowed or printed as a
    // code — a screen that quietly did nothing would have a manager tapping the button harder.
    tell(t('read'), words(REFUSAL_WORDS, outcome.refusal));
  }
  renderApprovals();
}

// ── Receiving ───────────────────────────────────────────────────────────────

let receiptLines = [];

function renderLines() {
  el('receive-empty').hidden = receiptLines.length > 0;
  el('receive-lines').replaceChildren(...receiptLines.map((line, index) => {
    const row = document.createElement('div');
    row.className = 'line-row';
    const name = document.createElement('span');
    name.textContent = line.productId;
    const qty = document.createElement('span');
    qty.className = 'q';
    qty.textContent = String(line.quantityMinor);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `${t('remove')} ${line.productId}`);
    remove.addEventListener('click', () => { receiptLines.splice(index, 1); renderLines(); });
    row.append(name, qty, remove);
    return row;
  }));
}

el('add-line').addEventListener('click', () => {
  const productId = el('grn-product').value.trim();
  const quantity = Number(el('grn-qty').value);
  if (productId === '' || !Number.isInteger(quantity) || quantity <= 0) {
    tell(t('read'), t('needItem'));
    return;
  }
  receiptLines.push({ productId, quantityMinor: quantity, uom: 'ea' });
  el('grn-product').value = '';
  el('grn-qty').value = '';
  el('grn-product').focus();
  renderLines();
});

el('save-receipt').addEventListener('click', () => {
  const number = el('grn-number').value.trim();
  if (number === '') { tell(t('read'), t('needNumber')); return; }
  if (receiptLines.length === 0) { tell(t('read'), t('needLines')); return; }
  const po = el('grn-po').value.trim();

  const stamp = Date.now().toString(36);
  try {
    const received = session.receive({
      grnId: `grn-${stamp}`,
      number,
      poId: po === '' ? null : po,
      receivedAt: new Date().toISOString(),
      lines: receiptLines,
    });
    // An unmatched delivery is SAID, not filed quietly. Nobody can check an invoice against a
    // purchase order that does not exist, and the person who can still fix that is the buyer today.
    tell(t('received'), received.unmatched ? t('unmatchedWarning') : t('matchedNote'), !received.unmatched);
    receiptLines = [];
    el('grn-number').value = '';
    el('grn-po').value = '';
    renderLines();
  } catch (e) {
    tell(t('read'), String(e && e.message ? e.message : e));
  }
});

// ── Counting ────────────────────────────────────────────────────────────────

/**
 * Count an item.
 *
 * **The expected quantity is nowhere on this path before the count is entered**, and the model
 * offers no way to ask for it. Shown "system says 100", people write 100 — not from dishonesty, but
 * because a number on a screen is an answer and counting is work. Same control as the till's drawer.
 */
el('enter-count').addEventListener('click', async () => {
  const productId = el('count-product').value.trim();
  const locationId = el('count-location').value.trim();
  if (productId === '' || locationId === '') { tell(t('read'), t('needProduct')); return; }

  const counted = await ask({ title: t('howManyOnShelf'), mode: 'number', hint: t('countBlindHint') });
  if (counted === null) return;
  const quantity = Number(counted);
  if (!Number.isInteger(quantity) || quantity < 0) return;

  const reasonCode = await ask({
    title: t('whyDifferent'),
    mode: 'choice',
    options: COUNT_REASONS.map((r) => ({ value: r.code, label: r[lang] ?? r.en })),
  });
  if (reasonCode === null) return;

  const stamp = Date.now().toString(36);
  let attempt;
  try {
    attempt = session.countStock({
      countId: `count-${stamp}`, productId, locationId, uom: 'ea',
      countedMinor: quantity, reasonCode, at: new Date().toISOString(),
    });
  } catch {
    // The engine refuses a material variance with no second approver (§28). The manager is told
    // what needs to happen rather than shown a validation error.
    tell(t('read'), t('needsApproval'));
    return;
  }

  if (!attempt.counted) {
    tell(t('read'), t('cannotValue'));
    return;
  }
  // The expected figure may be shown NOW: it can no longer influence what somebody wrote down.
  const result = attempt.result;
  if (result.varianceMinor === 0) { tell(t('done'), t('countMatches'), true); return; }
  const direction = result.varianceMinor > 0 ? t('countedMore') : t('countedFewer');
  const size = Math.abs(result.varianceMinor);
  tell(
    `${direction} ${size}`,
    `${t('worth')} ${inr(result.varianceValue.minor)}${result.requiredApproval ? ` — ${t('needsApproval')}` : ''}`,
  );
  el('count-product').value = '';
  el('count-location').value = '';
});

// ── Closing the day ─────────────────────────────────────────────────────────

function resetClose() {
  el('blockers').replaceChildren();
  el('do-close').hidden = true;
}

/** How many items of a blocker's list are shown before it says "and N more". */
const SHOWN = 5;

/**
 * Render the blockers.
 *
 * The list is shortened for display; the COUNT beside it is the model's and is always exact. A
 * shortened list that looked complete is how a manager clears three of eleven and goes home.
 */
function renderBlockers(blockers) {
  el('blockers').replaceChildren(...blockers.map((blocker) => {
    const words_ = BLOCKER_WORDS[blocker.kind]?.[lang] ?? BLOCKER_WORDS[blocker.kind]?.en ?? { title: blocker.kind, todo: '' };
    const box = document.createElement('div');
    box.className = 'blocker';

    const title = document.createElement('h3');
    // A count belongs in front of the sentence where there is one, and nowhere where there is not.
    title.textContent = blocker.count > 0 ? `${blocker.count} ${words_.title}` : words_.title;

    const todo = document.createElement('div');
    todo.className = 'todo';
    todo.textContent = `${t('whatToDo')}: ${words_.todo}`;
    box.append(title, todo);

    // The model's own words for what it could not read or why the rules refused.
    if (blocker.why) {
      const why = document.createElement('div');
      why.className = 'meta';
      why.textContent = `${blocker.source}: ${blocker.why}`;
      box.appendChild(why);
    }

    if (blocker.items.length > 0) {
      const list = document.createElement('ul');
      for (const item of blocker.items.slice(0, SHOWN)) {
        const li = document.createElement('li');
        li.textContent = item.what;
        list.appendChild(li);
      }
      if (blocker.items.length > SHOWN) {
        const li = document.createElement('li');
        li.textContent = `… ${t('andMore')}: ${blocker.items.length - SHOWN}`;
        list.appendChild(li);
      }
      box.appendChild(list);
    }
    return box;
  }));
}

/** Store-local wall-clock, as the trading-day rule expects it ("YYYY-MM-DDTHH:MM"). */
function localStamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

el('check-close').addEventListener('click', () => {
  const blockers = session.blockersForClose(localStamp());
  renderBlockers(blockers);
  // The close button only appears once there is nothing in the way — and it is the model's list
  // that decides that, not this screen's opinion of it.
  el('do-close').hidden = blockers.length > 0;
  if (blockers.length > 0) tell(t('stillOpen'), t('closedNote'));
});

el('do-close').addEventListener('click', () => {
  const stamp = Date.now().toString(36);
  const attempt = session.closeTheDay({
    dayCloseId: `dc-${stamp}`, closedAtLocal: localStamp(), closedAt: new Date().toISOString(),
  });
  if (attempt.closed) {
    tell(t('dayClosed'), t('closedNote'), true);
    el('do-close').hidden = true;
    el('blockers').replaceChildren();
    return;
  }
  // Something changed between the check and the tap — a sale rung on a lane, an exception raised.
  // The list is re-rendered rather than the tap being reported as success.
  renderBlockers(attempt.blockers);
  el('do-close').hidden = true;
  tell(t('stillOpen'), t('closedNote'));
});

// ── Language ────────────────────────────────────────────────────────────────

function paintChrome() {
  el('who').firstChild.textContent = `${t('manager')} `;
  el('tab-home').textContent = t('today');
  el('tab-approvals').textContent = t('approvals');
  el('tab-receive').textContent = t('receive');
  el('tab-count').textContent = t('count');
  el('tab-close').textContent = t('closeDay');
  el('home-title').textContent = t('today');
  el('home-lead').textContent = t('tapAFigure');
  el('approvals-title').textContent = t('approvals');
  el('approvals-lead').textContent = t('biggestFirst');
  el('receive-title').textContent = t('receive');
  el('grn-number-label').textContent = t('deliveryNote');
  el('grn-po-label').textContent = t('poNumber');
  el('grn-product-label').textContent = t('itemCode');
  el('grn-qty-label').textContent = t('howMany');
  el('add-line').textContent = t('addItem');
  el('receive-empty').textContent = t('noItemsYet');
  el('save-receipt').textContent = t('saveDelivery');
  el('count-title').textContent = t('count');
  el('count-lead').textContent = t('countBlindHint');
  el('count-product-label').textContent = t('productCode');
  el('count-location-label').textContent = t('whereIsIt');
  el('enter-count').textContent = t('enterCount');
  el('close-title').textContent = t('closeDay');
  el('close-lead').textContent = t('closedNote');
  el('check-close').textContent = t('checkOpen');
  el('do-close').textContent = t('closeNow');
  el('sample').textContent = t('sampleData');
}

el('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  paintChrome();
  show(view);
});

// ── Boot ────────────────────────────────────────────────────────────────────

// Sample figures must announce themselves. A manager acting on a number that came from nowhere is
// worse than a manager with no number at all.
el('sample').hidden = real !== undefined;

paintChrome();
renderLines();
show('home');
