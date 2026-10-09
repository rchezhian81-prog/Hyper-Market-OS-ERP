// Warehouse handheld — the view layer (M09 / OA-9). It renders the assigned work and dispatches the
// worker's scans; every rule lives in the TESTED session model
// (`apps/warehouse-app/src/warehouse-session.ts`), attached as `window.warehouseSession`, which
// orchestrates the authoritative receiving / warehouse / FEFO engines.
//
// ── What this file exists to hold ───────────────────────────────────────────
//
// **1. A scan is a scan.** Receiving, put-away and picking are scanner-first, and the only way that
// stays true is if the screen offers **no way to type a code**. A bin label scanned while nothing is
// asking for a scan is step 1 of a pick: it chooses the line that names that bin (the same rule as the
// picker handheld), then the item is scanned, then the quantity is confirmed — three, as the spec counts. There is no product/bin input box anywhere. A
// retail scanner is a keyboard that types fast and presses Enter, so codes are collected globally and
// flushed on Enter — the same as the till and the picker, and for the same reason: an input that can
// lose focus is how a barcode lands in the wrong field.
//
// **2. A refused scan must be FELT, not just seen.** Each result carries a colour, a word (English and
// Tamil), a sound and a buzz, because the worker may be in ear defenders in a cold store. The word is
// the model's own outcome code, translated here — never re-decided.
//
// **3. No `prompt`, `confirm` or `alert`, and the result banner does not fade** — the same decisions
// the till, the manager and the picker screens hold.
//
// No scan touches the network. Every scan is local and queues to the device (§31), and the tested session
// is what queued it — this file only shows the result. The one call it makes is a read of the store
// computer's sync status, for the badge (design system §1 rule 4).

const el = (id) => document.getElementById(id);

// ── Words ─────────────────────────────────────────────────────────────────
//
// The scan-feedback keys are the session's own `FEEDBACK_CODES`. A completeness tripwire
// (`tests/guardrails/the-warehouse-screen-speaks-both-languages.test.ts`) fails the build if either
// language is missing one, so a worker is never shown a blank reason when a scan is refused.
// NOTE: the Tamil below is pending a native-speaker review before go-live (OWNER-ACTION OA-10).

const WORDS = {
  en: {
    noBoxLink: 'not connected to a store computer', checkingBox: 'checking the store computer…',
    boxNotAnswering: 'store computer not answering', boxOnline: 'store computer online',
    noCloud: 'store computer cannot reach head office', cloudNotSetUp: 'no head office link set up',
    cloudUnknown: 'head office not checked yet', lastContact: 'last contact',
    staleShell: 'No connection to the store computer. This is the work this handheld was last given, at',
    goodsIn: 'Waiting to be put away', noWork: 'No warehouse work has been given to this handheld yet.',
    noWorkBody: 'Nothing is wrong. When work is assigned to you it will appear here on its own.',
    sample: 'Sample assignment — this is not real work.',
    receive: 'Receive a delivery', putAway: 'Put away — scan the bin',
    doneReceiving: 'Delivery complete — send the receipt',
    tempLabel: 'Arrival temperature, °C (chilled or frozen goods)',
    needTemp: 'The temperature must be a number of degrees',
    needTempDetail: 'Type the probe reading, for example 3.5 or -18, or leave the box empty for goods that are not chilled or frozen. Nothing was scanned.',
    scanBarcode: 'Scan the delivery barcode', scanBin: 'Scan the bin to put it in',
    pointAndPull: 'Point the scanner and pull the trigger.',
    cancel: 'Cancel', ok: 'OK', units: 'units',
    waiting: 'waiting to sync', allSent: 'everything sent',
    // where each accepted scan has got to (SP-3a): the list under the work, and the badge's first line
    sentHeading: 'Sent from this handheld', nothingSent: 'nothing sent yet',
    stepSelect: 'Tap an item to put away, or receive a delivery',
    stepScanBin: 'Scan the bin to put it in',
    recalledFlag: 'RECALLED — holding bin only', expiredFlag: 'EXPIRED — holding bin only',
    // picking an order line: scan the bin → scan the item → confirm
    toPick: 'To pick', pick: 'Pick — scan the bin', scanPickBin: 'Scan the bin shown', scanItem: 'Scan the item',
    confirmPick: 'Confirm the pick', confirm: 'Confirm', fromBin: 'from bin',
    stepPick: 'Scan a bin on the pick list to start picking, or tap an item',
    stepPickScanBin: 'Pick — scan the bin shown on the line',
    stepScanItem: 'Now scan the item', stepConfirm: 'Check the quantity, then confirm',
    // scan feedback, keyed by the session's outcome codes
    received: 'Received', unknown_barcode: 'Unknown barcode — set aside for someone to sort out',
    receiving_done: 'Receipt sent — head office will match the delivery to the order',
    nothing_received: 'Nothing has been received on this handheld for this delivery yet',
    over_delivery_needs_approval: 'More than ordered — a second person must approve it',
    dsd_needs_approval: 'No purchase order — a second person must approve it',
    price_change_refused: 'The price cannot be changed at the door',
    not_on_order: 'This is not on the purchase order',
    moved: 'Put away', duplicate_ignored: 'Already scanned — nothing changed',
    wrong_sku: 'That is not the item waiting to be put away',
    unknown_bin: 'Not a bin in this store — set aside for someone to sort out',
    bin_full: 'That bin is full — it would overflow',
    insufficient_goods_in: 'More than is waiting to be put away',
    insufficient_in_bin: 'The bin does not hold that many',
    not_pickable_state: 'This stock cannot go in a pickable bin — use a holding bin',
    recalled_into_pickable: 'Recalled stock cannot go in a pickable bin — use a holding bin',
    expired_into_pickable: 'Expired stock cannot go in a pickable bin — use a holding bin',
    invalid_command: 'That scan could not be used',
    picked: 'Picked', wrong_bin: 'That is not the bin for this line — walk to the bin shown and scan it',
    wrong_item: 'That is not the item on this line — check the label and scan again',
    not_on_pick_list: 'That line is not on this pick list',
    line_done: 'This line is already picked — nothing left to take',
    // a blind bin count (W2) and an adjustment request (W3) — SP-3b
    countBin: 'Count a bin', adjustStock: 'Adjust stock',
    scanCountBin: 'Scan the bin to count', scanCountItem: 'Scan an item in', doneCounting: 'Done counting',
    howMany: 'How many did you count?', blindHint: 'Enter what you see. The expected number is never shown here.',
    scanAdjustItem: 'Scan the item to adjust', adjustTitle: 'Adjust stock',
    missing: 'Missing / damaged (−)', found: 'Found (+)',
    chooseReason: 'Tap the reason — that records the request for a supervisor to approve',
    awaitingApproval: 'Recorded at head office — waiting for a supervisor to approve it',
    stepCountBin: 'Count — scan the bin', stepCountItem: 'Count — scan an item in the bin, or finish',
    stepCountQty: 'Enter what you counted', stepAdjustItem: 'Adjust — scan the item',
    stepAdjustReason: 'Set the quantity, then tap the reason',
    counted: 'Counted', adjustment_requested: 'Adjustment requested — waits for a supervisor',
    not_a_quantity: 'That is not a whole quantity', no_reason: 'Pick a reason from the list',
    // SP-8c: the back store issues against a floor indent — tap the line → scan the bin you take from → scan the item → confirm
    toIssue: 'To issue to the floor', issue: 'Issue to the floor — scan the bin', scanIssueBin: 'Scan the bin you are taking it from',
    confirmIssue: 'Confirm the issue', askedBy: 'asked by', owed: 'still owed',
    stepIssue: 'Tap an indent line to issue it to the floor', stepIssueScanBin: 'Scan the bin you are taking it from',
    issued: 'Issued to the floor', not_on_indent: 'Not on an indent this handheld holds', indent_line_done: 'This line is already fully issued',
    requester_cannot_issue: 'You raised this indent — a different person must issue it', bin_has_none: 'This bin holds none of that item — scan the bin the stock is in',
  },
  ta: {
    noBoxLink: 'கடை கணினியுடன் இணைக்கப்படவில்லை', checkingBox: 'கடை கணினியைச் சரிபார்க்கிறது…',
    boxNotAnswering: 'கடை கணினி பதிலளிக்கவில்லை', boxOnline: 'கடை கணினி இணைப்பில்',
    noCloud: 'கடை கணினி தலைமை அலுவலகத்தை அடைய முடியவில்லை', cloudNotSetUp: 'தலைமை அலுவலக இணைப்பு அமைக்கப்படவில்லை',
    cloudUnknown: 'தலைமை அலுவலகம் இன்னும் சரிபார்க்கப்படவில்லை', lastContact: 'கடைசித் தொடர்பு',
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்த கருவிக்குக் கடைசியாகக் கொடுக்கப்பட்ட வேலை இதுதான்:',
    goodsIn: 'அடுக்க வைக்கக் காத்திருப்பவை', noWork: 'இந்த கருவிக்கு இதுவரை கிடங்கு வேலை தரப்படவில்லை.',
    noWorkBody: 'எந்தப் பிரச்சனையும் இல்லை. உங்களுக்கு வேலை ஒதுக்கப்பட்டால் அது தானாகவே இங்கே தோன்றும்.',
    sample: 'மாதிரி வேலை — இது உண்மையான வேலை அல்ல.',
    receive: 'பொருள் வரவு பெறு', putAway: 'அடுக்கு — இடத்தை ஸ்கேன் செய்',
    doneReceiving: 'வரவு முடிந்தது — ரசீதை அனுப்பு',
    tempLabel: 'வந்தபோது வெப்பநிலை, °C (குளிர்/உறைந்த பொருட்கள்)',
    needTemp: 'வெப்பநிலை ஒரு எண்ணாக இருக்க வேண்டும்',
    needTempDetail: 'அளவைத் தட்டச்சு செய்யவும், உதாரணமாக 3.5 அல்லது -18; குளிர்/உறைந்த பொருள் இல்லையெனில் காலியாக விடவும். எதுவும் ஸ்கேன் செய்யப்படவில்லை.',
    scanBarcode: 'வரவின் பார்கோடை ஸ்கேன் செய்யவும்', scanBin: 'வைக்கும் இடத்தை ஸ்கேன் செய்யவும்',
    pointAndPull: 'ஸ்கேனரை நோக்கி டிரிக்கரை அழுத்தவும்.',
    cancel: 'ரத்து', ok: 'சரி', units: 'அலகுகள்',
    waiting: 'அனுப்பக் காத்திருக்கிறது', allSent: 'அனைத்தும் அனுப்பப்பட்டன',
    sentHeading: 'இந்தக் கருவியிலிருந்து அனுப்பப்பட்டவை', nothingSent: 'இன்னும் எதுவும் அனுப்பப்படவில்லை',
    stepSelect: 'அடுக்க ஒரு பொருளைத் தொடவும், அல்லது வரவு பெறவும்',
    stepScanBin: 'வைக்கும் இடத்தை ஸ்கேன் செய்யவும்',
    recalledFlag: 'திரும்பப் பெறப்பட்டது — சேமிப்பு இடம் மட்டும்', expiredFlag: 'காலாவதி — சேமிப்பு இடம் மட்டும்',
    toPick: 'எடுக்க வேண்டியவை', pick: 'எடு — இடத்தை ஸ்கேன் செய்', scanPickBin: 'காட்டப்பட்ட இடத்தை ஸ்கேன் செய்யவும்',
    scanItem: 'பொருளை ஸ்கேன் செய்யவும்',
    confirmPick: 'எடுத்ததை உறுதிப்படுத்தவும்', confirm: 'உறுதிப்படுத்து', fromBin: 'இடத்திலிருந்து',
    stepPick: 'எடுக்கத் தொடங்க பட்டியலில் உள்ள இடத்தை ஸ்கேன் செய்யவும், அல்லது ஒரு பொருளைத் தொடவும்',
    stepPickScanBin: 'எடு — வரியில் காட்டப்பட்ட இடத்தை ஸ்கேன் செய்யவும்',
    stepScanItem: 'இப்போது பொருளை ஸ்கேன் செய்யவும்', stepConfirm: 'அளவைச் சரிபார்த்து உறுதிப்படுத்தவும்',
    received: 'பெறப்பட்டது', unknown_barcode: 'தெரியாத பார்கோடு — சரிபார்க்க ஒதுக்கி வைக்கப்பட்டது',
    receiving_done: 'ரசீது அனுப்பப்பட்டது — தலைமை அலுவலகம் வரவை ஆர்டருடன் ஒப்பிடும்',
    nothing_received: 'இந்த வரவுக்கு இந்தக் கருவியில் இன்னும் எதுவும் பெறப்படவில்லை',
    over_delivery_needs_approval: 'ஆர்டரை விட அதிகம் — இரண்டாவது நபர் ஒப்புதல் அளிக்க வேண்டும்',
    dsd_needs_approval: 'கொள்முதல் ஆர்டர் இல்லை — இரண்டாவது நபர் ஒப்புதல் அளிக்க வேண்டும்',
    price_change_refused: 'வாசலில் விலையை மாற்ற முடியாது',
    not_on_order: 'இது கொள்முதல் ஆர்டரில் இல்லை',
    moved: 'அடுக்கப்பட்டது', duplicate_ignored: 'ஏற்கனவே ஸ்கேன் செய்யப்பட்டது — எதுவும் மாறவில்லை',
    wrong_sku: 'இது அடுக்கக் காத்திருக்கும் பொருள் அல்ல',
    unknown_bin: 'இந்தக் கடையின் இடம் அல்ல — சரிபார்க்க ஒதுக்கி வைக்கப்பட்டது',
    bin_full: 'அந்த இடம் நிரம்பியுள்ளது — வழிந்து விடும்',
    insufficient_goods_in: 'அடுக்கக் காத்திருப்பதை விட அதிகம்',
    insufficient_in_bin: 'அந்த இடத்தில் அவ்வளவு இல்லை',
    not_pickable_state: 'இந்தப் பொருளை எடுக்கும் இடத்தில் வைக்க முடியாது — சேமிப்பு இடத்தைப் பயன்படுத்தவும்',
    recalled_into_pickable: 'திரும்பப் பெற்ற பொருளை எடுக்கும் இடத்தில் வைக்க முடியாது — சேமிப்பு இடத்தைப் பயன்படுத்தவும்',
    expired_into_pickable: 'காலாவதிப் பொருளை எடுக்கும் இடத்தில் வைக்க முடியாது — சேமிப்பு இடத்தைப் பயன்படுத்தவும்',
    invalid_command: 'அந்த ஸ்கேனைப் பயன்படுத்த முடியவில்லை',
    picked: 'எடுக்கப்பட்டது', wrong_bin: 'இது இந்த வரியின் இடம் அல்ல — காட்டப்பட்ட இடத்திற்குச் சென்று ஸ்கேன் செய்யவும்',
    wrong_item: 'இது இந்த வரியின் பொருள் அல்ல — லேபிளைச் சரிபார்த்து மீண்டும் ஸ்கேன் செய்யவும்',
    not_on_pick_list: 'அந்த வரி இந்த எடுப்புப் பட்டியலில் இல்லை',
    line_done: 'இந்த வரி ஏற்கனவே எடுக்கப்பட்டது — எடுக்க எதுவும் இல்லை',
    countBin: 'இடத்தை எண்ணு', adjustStock: 'சரக்கைத் திருத்து',
    scanCountBin: 'எண்ண வேண்டிய இடத்தை ஸ்கேன் செய்யவும்', scanCountItem: 'உள்ளே இருக்கும் பொருளை ஸ்கேன் செய்யவும்', doneCounting: 'எண்ணி முடித்தேன்',
    howMany: 'எத்தனை எண்ணினீர்கள்?', blindHint: 'பார்ப்பதை உள்ளிடவும். எதிர்பார்க்கப்படும் எண் இங்கே காட்டப்படுவதில்லை.',
    scanAdjustItem: 'திருத்த வேண்டிய பொருளை ஸ்கேன் செய்யவும்', adjustTitle: 'சரக்கைத் திருத்து',
    missing: 'காணவில்லை / சேதம் (−)', found: 'கிடைத்தது (+)',
    chooseReason: 'காரணத்தைத் தொடவும் — அது மேற்பார்வையாளர் ஒப்புதலுக்குக் கோரிக்கையைப் பதிவு செய்யும்',
    awaitingApproval: 'தலைமை அலுவலகத்தில் பதிவாகியது — மேற்பார்வையாளர் ஒப்புதலுக்குக் காத்திருக்கிறது',
    stepCountBin: 'எண்ணு — இடத்தை ஸ்கேன் செய்யவும்', stepCountItem: 'எண்ணு — இடத்தில் உள்ள பொருளை ஸ்கேன் செய்யவும், அல்லது முடிக்கவும்',
    stepCountQty: 'எண்ணியதை உள்ளிடவும்', stepAdjustItem: 'திருத்து — பொருளை ஸ்கேன் செய்யவும்',
    stepAdjustReason: 'அளவை அமைத்து, பின் காரணத்தைத் தொடவும்',
    counted: 'எண்ணப்பட்டது', adjustment_requested: 'திருத்தக் கோரிக்கை — மேற்பார்வையாளருக்குக் காத்திருக்கிறது',
    not_a_quantity: 'அது முழு அளவு அல்ல', no_reason: 'பட்டியலில் இருந்து ஒரு காரணத்தைத் தேர்வு செய்யவும்',
    // SP-8c
    toIssue: 'தளத்திற்கு வழங்க வேண்டியவை', issue: 'தளத்திற்கு வழங்கு — இடத்தை ஸ்கேன் செய்', scanIssueBin: 'எடுக்கும் இடத்தை ஸ்கேன் செய்யவும்',
    confirmIssue: 'வழங்கலை உறுதிப்படுத்து', askedBy: 'கேட்டவர்', owed: 'இன்னும் தர வேண்டியது',
    stepIssue: 'தளத்திற்கு வழங்க ஒரு கோரிக்கை வரியைத் தட்டவும்', stepIssueScanBin: 'எடுக்கும் இடத்தை ஸ்கேன் செய்யவும்',
    issued: 'தளத்திற்கு வழங்கப்பட்டது', not_on_indent: 'இந்தக் கருவியில் உள்ள கோரிக்கையில் இல்லை', indent_line_done: 'இந்த வரி முழுமையாக வழங்கப்பட்டது',
    requester_cannot_issue: 'இந்தக் கோரிக்கையை நீங்கள் எழுப்பினீர்கள் — வேறு ஒருவர் வழங்க வேண்டும்', bin_has_none: 'இந்த இடத்தில் அந்தப் பொருள் இல்லை — பொருள் உள்ள இடத்தை ஸ்கேன் செய்யவும்',
  },
};
let lang = 'en';
const t = (key) => WORDS[lang][key] ?? WORDS.en[key] ?? key;

/**
 * Where a piece of work is — the five states of the shared device → store-computer contract
 * (`packages/sync/device-relay` DEVICE_ITEM_STATES), bound by the bilingual guardrail like the scan words.
 */
const STATE_WORDS = {
  saved_here: { en: 'Saved on this handheld — not yet with the store computer', ta: 'இந்தக் கருவியில் சேமிக்கப்பட்டது — கடை கணினிக்கு இன்னும் செல்லவில்லை' },
  retrying: { en: 'Saved on this handheld — the store computer could not be reached, trying again', ta: 'இந்தக் கருவியில் சேமிக்கப்பட்டது — கடை கணினியை அடைய முடியவில்லை, மீண்டும் முயற்சிக்கிறது' },
  handed_to_box: { en: 'With the store computer — it will send this to head office', ta: 'கடை கணினியிடம் உள்ளது — அது இதை தலைமை அலுவலகத்திற்கு அனுப்பும்' },
  posted: { en: 'Posted at head office', ta: 'தலைமை அலுவலகத்தில் பதிவாகியது' },
  refused: { en: 'Refused — a person must look at this', ta: 'மறுக்கப்பட்டது — ஒருவர் இதைப் பார்க்க வேண்டும்' },
};
/** Short badge words for the same five states, so the header can say "2 saved here · 1 posted". */
const STATE_SHORT = {
  saved_here: { en: 'saved here', ta: 'இங்கே சேமிப்பு' },
  retrying: { en: 'retrying', ta: 'மீண்டும் முயற்சி' },
  handed_to_box: { en: 'with the store computer', ta: 'கடை கணினியிடம்' },
  posted: { en: 'posted', ta: 'பதிவாகியது' },
  refused: { en: 'refused', ta: 'மறுக்கப்பட்டது' },
};
/** The kinds of work this handheld sends (the session's `SENT_WORK_KINDS`). */
const KIND_WORDS = {
  receipt: { en: 'Received', ta: 'பெறப்பட்டது' },
  receipt_done: { en: 'Receipt sent', ta: 'ரசீது அனுப்பப்பட்டது' },
  put_away: { en: 'Put away', ta: 'அடுக்கப்பட்டது' },
  pick: { en: 'Picked', ta: 'எடுக்கப்பட்டது' },
  issue: { en: 'Issued to the floor', ta: 'தளத்திற்கு வழங்கப்பட்டது' },
  count: { en: 'Counted', ta: 'எண்ணப்பட்டது' },
  adjustment: { en: 'Adjustment requested', ta: 'திருத்தக் கோரிக்கை' },
};
/** The reasons an adjustment may be raised for (`packages/adjustment` ADJUSTMENT_REASON_CODES) — the buttons on the adjust sheet. */
const REASON_WORDS = {
  damaged: { en: 'Damaged', ta: 'சேதமடைந்தது' },
  expired: { en: 'Expired', ta: 'காலாவதி' },
  miscount: { en: 'Miscount', ta: 'தவறான எண்ணிக்கை' },
  found: { en: 'Found', ta: 'கிடைத்தது' },
  theft_suspected: { en: 'Theft suspected', ta: 'திருட்டு சந்தேகம்' },
  other: { en: 'Other', ta: 'மற்றவை' },
};
const words = (map, key) => (map[key] ? (map[key][lang] ?? map[key].en) : key);

const real = window.warehouseSession;
const data = window.warehouseData;
const outbox = window.warehouseOutbox ?? null;
const grnId = (data && data.grnId) || 'GRN';

let selected = null; // the goods-in item chosen to put away
let selectedPick = null; // the pick-list line (by id) chosen by a tap; a bin scan from the list needs no tap
let pickStep = null; // where a pick in progress is: 'bin' | 'item' | 'confirm' | null
let selectedIssue = null; // the floor-indent line (`indentId|productId`) chosen by a tap (SP-8c)
let issueStep = null; // where an issue to the floor is: 'bin' | 'item' | 'confirm' | null (SP-8c)
let countStep = null; // where a blind count is: 'bin' | 'item' | 'qty' | null (W2)
let adjustStep = null; // where an adjustment request is: 'item' | 'reason' | null (W3)

// ── The scan panel ──────────────────────────────────────────────────────────
// A promise that resolves with the next scanned code, or null if cancelled. No text box exists.
let scanResolve = null;
function awaitScan(title) {
  el('scan-title').textContent = title;
  el('scan-awaiting').textContent = t('pointAndPull');
  el('scan').hidden = false;
  return new Promise((resolve) => { scanResolve = resolve; });
}
el('scan-cancel').addEventListener('click', () => {
  el('scan').hidden = true;
  if (scanResolve !== null) { const r = scanResolve; scanResolve = null; r(null); }
});

// ── The confirm step of a pick ──────────────────────────────────────────────
// The quantity about to leave the bin is the MODEL's (what remains on the line), shown big, then one tap.
// Nothing is typed: a pick of fewer than the line wants is a short pick, and that is the supervisor's
// call on the ERP, not a number a worker adjusts up a ladder.
let confirmResolve = null;
function awaitConfirm(line) {
  el('confirm-title').textContent = `${t('confirmPick')} — ${line.orderRef}`;
  el('confirm-qty').textContent = `${line.remainingMinor} ${t('units')} · ${line.uom}`;
  el('confirm-hint').textContent = `${line.productId}${line.batchId ? ` · ${line.batchId}` : ''} · ${t('fromBin')} ${line.binId}`;
  el('confirm-cancel').textContent = t('cancel');
  el('confirm-ok').textContent = t('confirm');
  el('confirm').hidden = false;
  return new Promise((resolve) => { confirmResolve = resolve; });
}
function settleConfirm(answer) {
  el('confirm').hidden = true;
  if (confirmResolve !== null) { const r = confirmResolve; confirmResolve = null; r(answer); }
}
el('confirm-ok').addEventListener('click', () => settleConfirm(true));
el('confirm-cancel').addEventListener('click', () => settleConfirm(false));

/** SP-8c: the confirm step of an issue to the floor — the number shown before it is committed. */
function awaitConfirmIssue(line, quantity, binId) {
  el('confirm-title').textContent = `${t('confirmIssue')} — ${line.indentId}`;
  el('confirm-qty').textContent = `${quantity} ${t('units')} · ${line.uom}`;
  el('confirm-hint').textContent = `${line.productId} · ${t('fromBin')} ${binId} · ${t('askedBy')} ${line.requestedBy}`;
  el('confirm-cancel').textContent = t('cancel');
  el('confirm-ok').textContent = t('confirm');
  el('confirm').hidden = false;
  return new Promise((resolve) => { confirmResolve = resolve; });
}

// ── A quantity on a keypad (W2 / W3) ────────────────────────────────────────
// Buttons, never a text box (the scanner discipline above). '0' is a real count — an empty bin is a finding.
function buildKeypad(hostId, entryId) {
  el(hostId).replaceChildren(...['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'].map((key) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = key;
    button.addEventListener('click', () => {
      const current = el(entryId).textContent;
      el(entryId).textContent = key === 'C' ? '0'
        : key === '⌫' ? (current.length > 1 ? current.slice(0, -1) : '0')
          : (current === '0' ? key : (current + key).slice(0, 6));
    });
    return button;
  }));
}
buildKeypad('qty-keypad', 'qty-entry');
buildKeypad('adjust-keypad', 'adjust-entry');

// The blind count's quantity: what the worker SAW. The panel carries no expected figure — the model has none to give.
let qtyResolve = null;
function awaitQty(title, hint, initial = '0') {
  el('qty-title').textContent = title;
  el('qty-hint').textContent = hint;
  el('qty-entry').textContent = initial;
  el('qty-cancel').textContent = t('cancel');
  el('qty-ok').textContent = t('ok');
  el('qty').hidden = false;
  return new Promise((resolve) => { qtyResolve = resolve; });
}
function settleQty(answer) {
  el('qty').hidden = true;
  if (qtyResolve !== null) { const r = qtyResolve; qtyResolve = null; r(answer); }
}
el('qty-ok').addEventListener('click', () => settleQty(Number(el('qty-entry').textContent)));
el('qty-cancel').addEventListener('click', () => settleQty(null));

// The adjustment request: direction (missing by default — the common finding), a quantity (1 by default), then the
// reason, whose tap IS the confirm: three interactions for one damaged pack, as the spec budgets it.
let adjustResolve = null;
let adjustSign = -1;
function setAdjustSign(sign) {
  adjustSign = sign;
  el('adjust-minus').setAttribute('aria-pressed', String(sign < 0));
  el('adjust-plus').setAttribute('aria-pressed', String(sign > 0));
}
function awaitAdjustment(productId) {
  el('adjust-title').textContent = t('adjustTitle');
  el('adjust-hint').textContent = productId;
  el('adjust-minus').textContent = t('missing');
  el('adjust-plus').textContent = t('found');
  el('adjust-reason-hint').textContent = t('chooseReason');
  el('adjust-cancel').textContent = t('cancel');
  el('adjust-entry').textContent = '1';
  setAdjustSign(-1);
  el('adjust-reasons').replaceChildren(...Object.keys(REASON_WORDS).map((code) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.reason = code;
    button.textContent = words(REASON_WORDS, code);
    button.addEventListener('click', () => settleAdjustment({ reasonCode: code, deltaMinor: adjustSign * Number(el('adjust-entry').textContent) }));
    return button;
  }));
  el('adjust').hidden = false;
  return new Promise((resolve) => { adjustResolve = resolve; });
}
function settleAdjustment(answer) {
  el('adjust').hidden = true;
  if (adjustResolve !== null) { const r = adjustResolve; adjustResolve = null; r(answer); }
}
el('adjust-minus').addEventListener('click', () => setAdjustSign(-1));
el('adjust-plus').addEventListener('click', () => setAdjustSign(1));
el('adjust-cancel').addEventListener('click', () => settleAdjustment(null));

// ── Felt scan feedback: colour + word + sound + buzz (OA-9) ──────────────────
function feltResult(signal) {
  const banner = el('banner');
  banner.className = 'banner' + (signal.feedback === 'accept' ? ' good' : signal.feedback === 'warn' ? ' warn' : '');
  el('banner-title').textContent = t(signal.code) ?? signal.detail;
  el('banner-text').textContent = signal.detail;
  banner.hidden = false;
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try { navigator.vibrate(signal.vibrateMs); } catch { /* vibration is a nicety, never required */ }
  }
  beep(signal.sound);
}
el('banner-ok').addEventListener('click', () => { el('banner').hidden = true; });

/** A short tone per outcome. Guarded — a device with no audio still shows the colour and the word. */
function beep(kind) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = kind === 'ok' ? 880 : kind === 'warn' ? 520 : 220;
    gain.gain.value = 0.08;
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + (kind === 'error' ? 0.35 : 0.12));
  } catch { /* no audio — the colour and the word carry it */ }
}

// ── Minting a scan command id, unique per scan (idempotent sync depends on it) ──
let seq = 0;
const nextId = (prefix) => `${prefix}-${Date.now()}-${seq++}`;

// ── Render ────────────────────────────────────────────────────────────────
function render() {
  const lines = real && typeof real.pickLines === 'function' ? real.pickLines() : [];
  const items = real && typeof real.goodsIn === 'function' ? real.goodsIn() : [];
  const issues = real && typeof real.indentLines === 'function' ? real.indentLines() : [];

  el('goods-in-heading').textContent = t('goodsIn');
  el('receive').textContent = t('receive');
  el('recv-temp-label').textContent = t('tempLabel');
  // SP-6b: "Delivery complete" appears once something has been received here for this delivery and not yet sent as one receipt.
  el('done-receiving').textContent = t('doneReceiving');
  el('done-receiving').hidden = !(real !== undefined && typeof real.receivingOpen === 'function' && real.receivingOpen(grnId));
  el('put-away').textContent = t('putAway');
  el('put-away').disabled = selected === null;
  el('pick-heading').textContent = t('toPick');
  el('pick').textContent = t('pick');
  el('count-bin').textContent = t('countBin');
  el('adjust-stock').textContent = t('adjustStock');
  el('count-bin').disabled = real === undefined;
  el('adjust-stock').disabled = real === undefined;
  // The Pick button exists only while there is pick work; a bin scanned from the list needs it not at all.
  el('pick').hidden = lines.length === 0;
  if (!lines.some((l) => l.lineId === selectedPick)) selectedPick = null;
  el('pick').disabled = selectedPick === null;
  // SP-8c: the Issue button exists only while the handheld holds floor indents to issue.
  el('issue-heading').textContent = t('toIssue');
  el('issue').textContent = t('issue');
  el('issue').hidden = issues.length === 0;
  if (!issues.some((l) => `${l.indentId}|${l.productId}` === selectedIssue)) selectedIssue = null;
  el('issue').disabled = selectedIssue === null;
  // The footer always says which step comes next — nobody should work out where they are in a sequence.
  el('step').firstChild.textContent =
    issueStep === 'bin' ? t('stepIssueScanBin')
      : issueStep === 'item' ? t('stepScanItem')
        : issueStep === 'confirm' ? t('stepConfirm')
          : countStep === 'bin' ? t('stepCountBin')
      : countStep === 'item' ? t('stepCountItem')
        : countStep === 'qty' ? t('stepCountQty')
          : adjustStep === 'item' ? t('stepAdjustItem')
            : adjustStep === 'reason' ? t('stepAdjustReason')
              : pickStep === 'bin' ? t('stepPickScanBin')
      : pickStep === 'item' ? t('stepScanItem')
        : pickStep === 'confirm' ? t('stepConfirm')
          : selectedPick !== null ? t('stepPickScanBin')
            : selectedIssue !== null ? t('stepIssueScanBin')
            : selected !== null ? t('stepScanBin')
              : lines.length > 0 ? t('stepPick')
                : issues.length > 0 ? t('stepIssue')
                : t('stepSelect');

  paintBadge();
  // Where each accepted scan is — rendered BEFORE the worklists, because an emptied worklist returns early below and a
  // put-away that just emptied it must still show as "with the store computer".
  renderSent();

  // The pick list: the bin is the biggest thing on the row, because the bin is where the worker walks to.
  const pickHost = el('pick-lines');
  pickHost.textContent = '';
  el('pick-heading').hidden = lines.length === 0;
  for (const line of lines) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'item pick';
    row.setAttribute('aria-selected', String(selectedPick === line.lineId));
    const where = document.createElement('div');
    where.className = 'where';
    where.textContent = line.binId;
    const what = document.createElement('div');
    what.className = 'what';
    what.textContent = `${line.orderRef} · ${line.productId}${line.batchId ? ` · ${line.batchId}` : ''}`;
    const qty = document.createElement('div');
    qty.className = 'qty';
    qty.textContent = `${line.remainingMinor} ${t('units')} · ${line.uom}`;
    row.append(where, what, qty);
    row.addEventListener('click', () => { selectedPick = line.lineId; selected = null; selectedIssue = null; render(); });
    pickHost.append(row);
  }

  // SP-8c: the floor indents the back store owes — the bins holding the product are the biggest thing on the row (where to
  // walk); the indent, the item and who asked; what is still owed. Tap a line → Issue → scan the bin → scan the item → confirm.
  const issueHost = el('issue-lines');
  issueHost.textContent = '';
  el('issue-heading').hidden = issues.length === 0;
  for (const line of issues) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'item issue';
    row.setAttribute('aria-selected', String(selectedIssue === `${line.indentId}|${line.productId}`));
    const where = document.createElement('div');
    where.className = 'where';
    where.textContent = line.binIds.length > 0 ? line.binIds.join(' · ') : '—';
    const what = document.createElement('div');
    what.className = 'what';
    what.textContent = `${line.indentId} · ${line.productId} · ${t('askedBy')} ${line.requestedBy}`;
    const qty = document.createElement('div');
    qty.className = 'qty';
    qty.textContent = `${line.remainingMinor} ${t('units')} · ${line.uom} · ${t('owed')}`;
    row.append(where, what, qty);
    row.addEventListener('click', () => { selectedIssue = `${line.indentId}|${line.productId}`; selectedPick = null; selected = null; render(); });
    issueHost.append(row);
  }

  const host = el('goods-in');
  host.textContent = '';
  // With pick work but nothing to put away, the goods-in heading would sit over nothing.
  el('goods-in-heading').hidden = items.length === 0 && (lines.length > 0 || issues.length > 0);
  if (items.length === 0 && lines.length === 0 && issues.length === 0) {
    el('empty').hidden = false;
    el('empty').textContent = `${t('noWork')} ${t('noWorkBody')}`;
    return;
  }
  el('empty').hidden = true;
  items.forEach((item, index) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'item' + (item.recalled ? ' recalled' : '');
    row.setAttribute('aria-selected', String(selected === index));
    const what = document.createElement('div');
    what.className = 'what';
    what.textContent = item.productId + (item.batchId ? ` · ${item.batchId}` : '');
    const qty = document.createElement('div');
    qty.className = 'qty';
    qty.textContent = `${item.quantityMinor} ${t('units')} · ${item.uom}`;
    row.append(what, qty);
    if (item.recalled) { const f = document.createElement('div'); f.className = 'flag'; f.textContent = t('recalledFlag'); row.append(f); }
    row.addEventListener('click', () => { selected = index; selectedPick = null; selectedIssue = null; render(); });
    host.append(row);
  });
}

/**
 * Where each accepted scan has got to (SP-3a · S1): read from the DURABLE device queue plus the store computer's own
 * word, so the list is the same after the app is closed — the proof a scan was not lost with it. A refusal carries its
 * reason, because a person has to act on it. Nothing here is a stock rule; the session owns the states.
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
    // A request head office has RECORDED is not yet applied: it waits for a supervisor — say so, never "posted".
    state.textContent = w.kind === 'adjustment' && w.state === 'posted' ? t('awaitingApproval') : words(STATE_WORDS, w.state);
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

/**
 * Hand this handheld's accepted scans to the store computer and learn where they have got to (SP-3a). The relay is
 * the composition root's (`window.warehouseRelay`), present only when the box served this page over its device
 * socket. Called after every accepted scan and on a slow timer; never blocks a scan, and a box that cannot be
 * reached leaves everything saved here and says so through the state words.
 */
async function syncToBox() {
  const relay = window.warehouseRelay;
  if (!relay) return;
  try {
    await relay.syncNow();
  } catch {
    /* the queue is untouched; the state words say "saved here" */
  }
  render();
}
setInterval(() => { void syncToBox(); }, 10_000);

// ── Actions ─────────────────────────────────────────────────────────────────
el('receive').addEventListener('click', async () => {
  // Wave 3 · SF-07 part 3: the probe reading, when the goods are chilled or frozen — checked BEFORE the scan, so a word never
  // travels. Empty = not taken (head office then holds a cold-chain item for a second person's check).
  const tempText = el('recv-temp').value.trim().replace(',', '.');
  if (tempText !== '' && (!/^-?\d+(\.\d+)?$/.test(tempText) || Math.abs(Number(tempText)) > 60)) {
    feltResult({ feedback: 'reject', code: 'needTemp', detail: t('needTempDetail'), sound: 'error', vibrateMs: 300 });
    return;
  }
  const code = await awaitScan(t('scanBarcode'));
  if (code === null || real === undefined) return;
  const out = real.receive({
    commandId: nextId('recv'), grnId, barcode: code, scannedQuantity: 1, source: 'po',
    ...(tempText === '' ? {} : { temperatureC: Number(tempText) }),
  });
  feltResult(out.signal);
  render();
  if (out.signal.feedback === 'accept') void syncToBox();
});

/**
 * Delivery complete (SP-6b · "the handheld delivery is one receipt, not a pile of scans"): one tap. The session queues ONE
 * completion behind the scans; head office assembles the goods receipt from the scans it already holds and matches it to
 * the order. No quantity is typed or sent here — the scans are the truth, this only says they are all in.
 */
el('done-receiving').addEventListener('click', () => {
  if (real === undefined) return;
  const out = real.completeReceiving({ grnId });
  feltResult(out.signal);
  render();
  if (out.signal.feedback === 'accept') void syncToBox();
});

el('put-away').addEventListener('click', async () => {
  if (selected === null || real === undefined) return;
  const item = real.goodsIn()[selected];
  if (item === undefined) return;
  const bin = await awaitScan(t('scanBin'));
  if (bin === null) return;
  const out = real.putAway({
    commandId: nextId('mv'), scannedProductId: item.productId, scannedBinId: bin,
    batchId: item.batchId, quantityMinor: item.quantityMinor, uom: item.uom, at: new Date().toISOString(),
  });
  feltResult(out.signal);
  selected = null;
  render();
  if (out.signal.feedback === 'accept') void syncToBox();
});

/**
 * Pick one line: scan the bin the line names → scan the item → confirm the quantity (inventory-warehouse.md,
 * ≤3). `binCode` is set when the bin was scanned from the list — that scan WAS step 1, so the panel opens
 * straight on the item. The model checks each scan as it happens (`checkPick`), so a wrong bin is refused at
 * the racking and a wrong item at the shelf — never after the worker has confirmed. The model commits.
 */
async function startPick(line, binCode = null) {
  if (real === undefined) return;
  pickStep = 'bin'; render();
  const bin = binCode ?? await awaitScan(`${t('scanPickBin')} — ${line.binId}`);
  if (bin === null) { pickStep = null; render(); return; }
  const atBin = real.checkPick({ lineId: line.lineId, scannedBinId: bin });
  if (!atBin.ok) { pickStep = null; feltResult(atBin.signal); render(); return; }
  pickStep = 'item'; render();
  const item = await awaitScan(`${t('scanItem')} — ${line.productId}`);
  if (item === null) { pickStep = null; render(); return; }
  const withItem = real.checkPick({ lineId: line.lineId, scannedBinId: bin, scannedItem: item });
  if (!withItem.ok) { pickStep = null; feltResult(withItem.signal); render(); return; }
  pickStep = 'confirm'; render();
  const confirmed = await awaitConfirm(withItem.line);
  pickStep = null;
  if (!confirmed) { render(); return; }
  const out = real.pick({ commandId: nextId('pick'), lineId: line.lineId, scannedBinId: bin, scannedItem: item, at: new Date().toISOString() });
  feltResult(out.signal);
  selectedPick = null;
  render();
  if (out.signal.feedback === 'accept') void syncToBox();
}

el('pick').addEventListener('click', () => {
  if (selectedPick === null || real === undefined) return;
  const line = real.pickLines().find((l) => l.lineId === selectedPick);
  if (line !== undefined) void startPick(line);
});

/**
 * SP-8c: issue one floor-indent line to the floor (inventory-warehouse.md, ≤3 after the tap): scan the bin you take it
 * from → scan the item → confirm the quantity (what is still owed, capped at what the bin holds). The model checks each
 * scan as it happens (`checkIssue`): a bin holding none of it, an unknown bin, a wrong item, the requester issuing to
 * themselves are refused at the racking — never after the worker has confirmed. The model commits and queues ONE fact.
 */
async function startIssue(line) {
  if (real === undefined) return;
  issueStep = 'bin'; render();
  const bin = await awaitScan(`${t('scanIssueBin')} — ${line.productId}`);
  if (bin === null) { issueStep = null; render(); return; }
  const atBin = real.checkIssue({ indentId: line.indentId, productId: line.productId, scannedBinId: bin });
  if (!atBin.ok) { issueStep = null; feltResult(atBin.signal); render(); return; }
  issueStep = 'item'; render();
  const item = await awaitScan(`${t('scanItem')} — ${line.productId}`);
  if (item === null) { issueStep = null; render(); return; }
  const withItem = real.checkIssue({ indentId: line.indentId, productId: line.productId, scannedBinId: bin, scannedItem: item });
  if (!withItem.ok) { issueStep = null; feltResult(withItem.signal); render(); return; }
  issueStep = 'confirm'; render();
  const quantity = Math.min(withItem.line.remainingMinor, withItem.inBinMinor);
  const confirmed = await awaitConfirmIssue(withItem.line, quantity, bin);
  issueStep = null;
  if (!confirmed) { render(); return; }
  const out = real.issueToFloor({ commandId: nextId('issue'), indentId: line.indentId, productId: line.productId, scannedBinId: bin, scannedItem: item, quantityMinor: quantity, at: new Date().toISOString() });
  feltResult(out.signal);
  selectedIssue = null;
  render();
  if (out.signal.feedback === 'accept') void syncToBox();
}

el('issue').addEventListener('click', () => {
  if (selectedIssue === null || real === undefined) return;
  const line = real.indentLines().find((l) => `${l.indentId}|${l.productId}` === selectedIssue);
  if (line !== undefined) void startIssue(line);
});

/**
 * Count a bin, BLIND (W2 · inventory-warehouse.md "start a count ≤2"): tap Count → scan the bin — that is the start. Then
 * for each item in the bin: scan it → type what you see → OK, until "Done counting". Nothing on this screen ever shows
 * what the bin should hold; the model queues only the counted figure and head office compares it (M09-FR-04, §28).
 */
async function startCount() {
  if (real === undefined) return;
  countStep = 'bin'; render();
  const bin = await awaitScan(t('scanCountBin'));
  if (bin === null) { countStep = null; render(); return; }
  if (!real.knowsBin(bin)) {
    countStep = null; render();
    feltResult({ feedback: 'reject', code: 'unknown_bin', detail: `${bin} is not a bin in this store`, sound: 'error', vibrateMs: 300 });
    return;
  }
  for (;;) {
    countStep = 'item'; render();
    el('scan-cancel').textContent = t('doneCounting');
    const item = await awaitScan(`${t('scanCountItem')} ${bin}`);
    el('scan-cancel').textContent = t('cancel');
    if (item === null) break;
    countStep = 'qty'; render();
    const qty = await awaitQty(`${t('howMany')} — ${item}`, t('blindHint'));
    if (qty === null) continue;
    const out = real.countBin({ countId: nextId('count'), scannedBinId: bin, scannedItem: item, countedMinor: qty, at: new Date().toISOString() });
    feltResult(out.signal);
    render();
    if (out.signal.feedback === 'accept') void syncToBox();
  }
  countStep = null; render();
}
el('count-bin').addEventListener('click', () => { void startCount(); });

/**
 * Raise an adjustment REQUEST (W3 · "record an adjustment with reason ≤3"): tap Adjust → scan the item → tap the reason
 * (the quantity defaults to one, missing). It is a request: nothing changes on this handheld, and a supervisor who is
 * not this worker approves it at head office before anything posts (M08-FR-03, §28).
 */
async function startAdjust() {
  if (real === undefined) return;
  adjustStep = 'item'; render();
  const item = await awaitScan(t('scanAdjustItem'));
  if (item === null) { adjustStep = null; render(); return; }
  adjustStep = 'reason'; render();
  const answer = await awaitAdjustment(item);
  adjustStep = null;
  if (answer === null) { render(); return; }
  const out = real.requestAdjustment({ requestId: nextId('adj'), scannedItem: item, deltaMinor: answer.deltaMinor, reasonCode: answer.reasonCode, at: new Date().toISOString() });
  feltResult(out.signal);
  render();
  if (out.signal.feedback === 'accept') void syncToBox();
}
el('adjust-stock').addEventListener('click', () => { void startAdjust(); });

// ── Language ────────────────────────────────────────────────────────────────
el('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  el('sample').textContent = t('sample');
  render();
});

// ── The scanner ─────────────────────────────────────────────────────────────
// A shop scanner is a keyboard: it types the code fast and presses Enter. There is deliberately NO
// input box to focus — losing focus is how a scan goes into the wrong bin or a quantity field.
let scanBuffer = '';
window.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    const code = scanBuffer;
    scanBuffer = '';
    if (code.length < 3) return; // a person pressing Enter, not a scanner
    // A scanner's Enter is never a person's. Left to the browser it also PRESSES whatever button has focus —
    // the "Receive a delivery" the worker just tapped — and the panel silently asks for the next scan, so
    // every received item looked like it wanted scanning again. Found by the browser audit, not by eye.
    event.preventDefault();
    if (scanResolve !== null) {
      el('scan').hidden = true;
      const resolve = scanResolve;
      scanResolve = null;
      resolve(code);
      return;
    }
    // Nothing was asking for a scan. A bin label that a pick-list line names IS step 1 of that pick — the scan
    // chooses the line, as on the picker handheld, and the panel opens straight on the item.
    if (pickStep === null && countStep === null && adjustStep === null && confirmResolve === null && real !== undefined && typeof real.pickLines === 'function') {
      const line = real.pickLines().find((l) => l.binId === code);
      if (line !== undefined) void startPick(line, code);
    }
    return;
  }
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
  // Words as well as a dot — one man in twelve cannot tell the two colours apart. The first line counts THIS
  // handheld's scans by where each is (SP-3a): saved here · retrying · with the store computer · posted · refused —
  // never a bare "sent" (P-08). Without a session it falls back to the queue's own unsent count.
  const sent = real && typeof real.sentWork === 'function' ? real.sentWork() : null;
  if (sent === null) el('queue-text').textContent = unsent === 0 ? t('allSent') : `${unsent} ${t('waiting')}`;
  else if (sent.length === 0) el('queue-text').textContent = t('nothingSent');
  else {
    const counts = {};
    for (const w of sent) counts[w.state] = (counts[w.state] ?? 0) + 1;
    el('queue-text').textContent = Object.keys(STATE_SHORT).filter((s) => counts[s]).map((s) => `${counts[s]} ${words(STATE_SHORT, s)}`).join(' · ');
  }
  const refusedCount = sent === null ? 0 : sent.filter((w) => w.state === 'refused').length;
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
  // Work waiting on this device shows as waiting unless the store computer itself is down — that is worse; a
  // refusal is worse still, because a person has to act on it.
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
window.warehouseBadge = { refresh: refreshBadge, state: () => box };
void refreshBadge();
setInterval(() => { void refreshBadge(); }, 10_000);

// ── Boot ────────────────────────────────────────────────────────────────────
el('who').firstChild.textContent = (data && data.workerId) || '—';
el('assignment').textContent = (data && data.assignmentId) || '';
el('sample').hidden = real !== undefined;
el('sample').textContent = t('sample');

const storageProblem = window.warehouseStorageProblem;
el('storage').hidden = !storageProblem;
if (storageProblem) el('storage').textContent = storageProblem;

render();

// ── The shell's own honesty about where this page came from ──────────────────
// The service worker keeps a copy of the last page the store box actually served, so this screen
// still opens when the box cannot be reached. That copy carries the time it was taken, and this says
// so. **A cached page shown as a live one is the fault this product exists to refuse** (P-08).
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

// The shell existed and nothing ever registered it would mean nothing was ever cached and the screen
// fell back to its sample data the moment the box was unreachable.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
