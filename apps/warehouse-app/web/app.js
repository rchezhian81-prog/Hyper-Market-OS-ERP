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
/**
 * OB-205 (footer): a footer action — its icon and words as one pair, then what it waits for on its own smaller line
 * ("scan the bin"), so the action keeps its whole meaning without its label wrapping to three or four lines.
 */
function sayAction(node, text, icon, waitsFor) {
  say(node, text, icon);
  const why = document.createElement('small');
  why.className = 'why';
  why.textContent = waitsFor;
  node.append(why);
}
/** A quantity: the number on its own, big, then its words — `12 units · EA` stays exactly that text. */
function sayQty(node, n, rest) {
  const big = document.createElement('span');
  big.className = 'n';
  big.textContent = String(n);
  node.replaceChildren(big, rest);
}
/** The slots the markup — and the store box's sign-in strip above this screen — leave for an icon (`data-sre-icon`). */
function paintIconSlots() {
  for (const slot of document.querySelectorAll('[data-sre-icon]')) {
    if (slot.firstElementChild !== null) continue;
    const m = mark(slot.dataset.sreIcon, 18);
    if (m !== null) slot.append(m);
  }
}
/** The shape a sent record's state wears beside its words (the five shared states, and a request awaiting approval). */
const STATE_ICON = { saved_here: 'clock', retrying: 'refresh-cw', handed_to_box: 'store', posted: 'circle-check', refused: 'circle-alert', awaiting: 'clock' };

// ── Words ─────────────────────────────────────────────────────────────────
//
// The scan-feedback keys are the session's own `FEEDBACK_CODES`. A completeness tripwire
// (`tests/guardrails/the-warehouse-screen-speaks-both-languages.test.ts`) fails the build if either
// language is missing one, so a worker is never shown a blank reason when a scan is refused.
// NOTE: the Tamil below is pending a native-speaker review before go-live (OWNER-ACTION OA-10).

const WORDS = {
  en: {
    // OB-521 (R8-A): new work refused on a withdrawn or too-old build (the session's own words are the detail).
    app_version_too_old: 'Update this handheld',
    noBoxLink: 'not connected to a store computer', checkingBox: 'checking the store computer…',
    boxNotAnswering: 'store computer not answering', boxOnline: 'store computer online',
    noCloud: 'store computer cannot reach head office', cloudLoginRefused: 'store computer\'s head office login needs renewing', cloudNotSetUp: 'no head office link set up',
    cloudUnknown: 'head office not checked yet', lastContact: 'last contact',
    staleShell: 'No connection to the store computer. This is the work this handheld was last given, at',
    goodsIn: 'Waiting to be put away', noWork: 'No warehouse work has been given to this handheld yet.',
    noWorkBody: 'Nothing is wrong. When work is assigned to you it will appear here on its own.',
    sample: 'Sample assignment — this is not real work.',
    // OB-205 (footer): an action's words, then — on its own smaller line — what it waits for, so a label never wraps to four lines.
    receive: 'Receive a delivery', putAway: 'Put away', waitsForBin: 'scan the bin',
    deliveries: 'Deliveries waiting for this store', chooseDelivery: 'Choose the delivery at the door first',
    receivingThis: 'receiving now', chooseThis: 'receive this one',
    doneReceiving: 'Delivery complete — send the receipt',
    tempLabel: 'Arrival temperature (chilled or frozen goods)', tempNotTaken: 'not taken',
    tempTitle: 'Arrival temperature, °C', tempHint: 'Probe the goods and key the reading, for example 3.5 or -18. It goes with every scan until you change it.', tempNone: 'No reading',
    needTemp: 'The temperature must be a number of degrees',
    needTempDetail: 'Key the probe reading, for example 3.5 or -18, or choose No reading for goods that are not chilled or frozen. Nothing was set.',
    // B4 · OB-504: the month and year of manufacture printed on a packed product's pack — it rides on every scan until changed.
    mfgLabel: 'Month of manufacture (packed goods)', mfgNotEntered: 'not entered',
    mfgTitle: 'Month of manufacture — key it as YYYYMM', mfgHint: 'From the pack, for example 202609 for September 2026. It goes with every scan until you change it. Key 0 to clear it.',
    needMfg: 'The month of manufacture is not readable', needMfgDetail: 'Key the year and month as six digits, for example 202609. Nothing was set.',
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
    toPick: 'To pick', pick: 'Pick', scanPickBin: 'Scan the bin shown', scanItem: 'Scan the item',
    confirmPick: 'Confirm the pick', confirm: 'Confirm', fromBin: 'from bin',
    stepPick: 'Scan a bin on the pick list to start picking, or tap an item',
    stepPickScanBin: 'Pick — scan the bin shown on the line',
    stepScanItem: 'Now scan the item', stepConfirm: 'Check the quantity, then confirm',
    // scan feedback, keyed by the session's outcome codes
    received: 'Received', unknown_barcode: 'Unknown barcode — set aside for someone to sort out',
    receiving_done: 'Receipt sent — head office will match the delivery to the order',
    nothing_received: 'Nothing has been received on this handheld for this delivery yet',
    // OB-172: the receiving checklist for chilled, frozen or raw-meat goods, done at the door before the receipt is sent
    checklist_required: 'Chilled or frozen goods — do the receiving checklist first',
    checklist_incomplete: 'The receiving checklist is not finished',
    checklistTitle: 'Receiving checklist — chilled and frozen goods', checklistHint: 'Tick each check at the door. It goes with the receipt, in your name.',
    checkPass: 'Pass', checkFail: 'Fail', sendReceipt: 'Send the receipt', checkedOf: '{n} of {total} checked',
    checklistActionHint: 'A check failed — tap what was done about it',
    actionRefused: 'Refused — sent back with the driver', actionChilled: 'Moved straight to the chiller or freezer', actionHeld: 'Held aside for the manager to check',
    over_delivery_needs_approval: 'More than ordered — a second person must approve it',
    dsd_needs_approval: 'No purchase order — a second person must approve it',
    price_change_refused: 'The price cannot be changed at the door',
    manufacture_date_required: 'Packed goods — enter the month of manufacture first',
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
    toIssue: 'To issue to the floor', issue: 'Issue to the floor', scanIssueBin: 'Scan the bin you are taking it from',
    confirmIssue: 'Confirm the issue', askedBy: 'asked by', owed: 'still owed',
    stepIssue: 'Tap an indent line to issue it to the floor', stepIssueScanBin: 'Scan the bin you are taking it from',
    issued: 'Issued to the floor', not_on_indent: 'Not on an indent this handheld holds', indent_line_done: 'This line is already fully issued',
    requester_cannot_issue: 'You raised this indent — a different person must issue it', bin_has_none: 'This bin holds none of that item — scan the bin the stock is in',
    // OB-288 lane 2 · WF-07 offline: transfers SENT from this store and COUNTED IN at it — one tap to send; a keypad count per line
    toSendHeading: 'Transfers to send', toCountInHeading: 'Transfers to count in',
    transfersAsOf: "Head office's transfers as the store computer last heard them, at",
    transferTo: 'to', transferFrom: 'from', transferLines: 'line(s)', transferDoneHere: 'Done on this handheld',
    confirmSend: 'Send this transfer — the goods are loaded', countInLine: 'Count in', sentWas: 'sent',
    transfer_sent: 'Transfer sent', transfer_counted_in: 'Transfer counted in', not_a_transfer_here: 'Not a transfer for this store',
    transfer_already_done: 'Already done on this handheld — nothing changed', count_incomplete: 'Every line needs its count',
  },
  ta: {
    app_version_too_old: 'இந்தக் கருவியைப் புதுப்பிக்கவும்',
    noBoxLink: 'கடை கணினியுடன் இணைக்கப்படவில்லை', checkingBox: 'கடை கணினியைச் சரிபார்க்கிறது…',
    boxNotAnswering: 'கடை கணினி பதிலளிக்கவில்லை', boxOnline: 'கடை கணினி இணைப்பில்',
    noCloud: 'கடை கணினி தலைமை அலுவலகத்தை அடைய முடியவில்லை', cloudLoginRefused: 'கடை கணினியின் தலைமை அலுவலக உள்நுழைவைப் புதுப்பிக்க வேண்டும்', cloudNotSetUp: 'தலைமை அலுவலக இணைப்பு அமைக்கப்படவில்லை',
    cloudUnknown: 'தலைமை அலுவலகம் இன்னும் சரிபார்க்கப்படவில்லை', lastContact: 'கடைசித் தொடர்பு',
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்த கருவிக்குக் கடைசியாகக் கொடுக்கப்பட்ட வேலை இதுதான்:',
    goodsIn: 'அடுக்க வைக்கக் காத்திருப்பவை', noWork: 'இந்த கருவிக்கு இதுவரை கிடங்கு வேலை தரப்படவில்லை.',
    noWorkBody: 'எந்தப் பிரச்சனையும் இல்லை. உங்களுக்கு வேலை ஒதுக்கப்பட்டால் அது தானாகவே இங்கே தோன்றும்.',
    sample: 'மாதிரி வேலை — இது உண்மையான வேலை அல்ல.',
    receive: 'பொருள் வரவு பெறு', putAway: 'அடுக்கு', waitsForBin: 'இடத்தை ஸ்கேன் செய்',
    deliveries: 'இந்தக் கடைக்கு வர வேண்டிய சரக்குகள்', chooseDelivery: 'முதலில் வாசலில் உள்ள சரக்கைத் தேர்ந்தெடுக்கவும்',
    receivingThis: 'இப்போது பெறப்படுகிறது', chooseThis: 'இதைப் பெறு',
    doneReceiving: 'வரவு முடிந்தது — ரசீதை அனுப்பு',
    tempLabel: 'வந்தபோது வெப்பநிலை (குளிர்/உறைந்த பொருட்கள்)', tempNotTaken: 'எடுக்கப்படவில்லை',
    tempTitle: 'வந்தபோது வெப்பநிலை, °C', tempHint: 'பொருளை அளந்து அளவை அழுத்தவும், உதாரணமாக 3.5 அல்லது -18. மாற்றும் வரை ஒவ்வொரு ஸ்கேனுடனும் செல்லும்.', tempNone: 'அளவு இல்லை',
    needTemp: 'வெப்பநிலை ஒரு எண்ணாக இருக்க வேண்டும்',
    needTempDetail: 'அளவை அழுத்தவும், உதாரணமாக 3.5 அல்லது -18; குளிர்/உறைந்த பொருள் இல்லையெனில் «அளவு இல்லை» என்பதைத் தேர்வு செய்யவும். எதுவும் அமைக்கப்படவில்லை.',
    mfgLabel: 'தயாரிப்பு மாதம் (பொதி செய்த பொருட்கள்)', mfgNotEntered: 'உள்ளிடப்படவில்லை',
    mfgTitle: 'தயாரிப்பு மாதம் — YYYYMM என உள்ளிடவும்', mfgHint: 'பொதியில் உள்ளபடி, உதாரணமாக செப்டம்பர் 2026க்கு 202609. மாற்றும் வரை ஒவ்வொரு ஸ்கேனுடனும் செல்லும். அழிக்க 0 அழுத்தவும்.',
    needMfg: 'தயாரிப்பு மாதம் படிக்க முடியவில்லை', needMfgDetail: 'ஆண்டையும் மாதத்தையும் ஆறு இலக்கங்களாக அழுத்தவும், உதாரணமாக 202609. எதுவும் அமைக்கப்படவில்லை.',
    scanBarcode: 'வரவின் பார்கோடை ஸ்கேன் செய்யவும்', scanBin: 'வைக்கும் இடத்தை ஸ்கேன் செய்யவும்',
    pointAndPull: 'ஸ்கேனரை நோக்கி டிரிக்கரை அழுத்தவும்.',
    cancel: 'ரத்து', ok: 'சரி', units: 'அலகுகள்',
    waiting: 'அனுப்பக் காத்திருக்கிறது', allSent: 'அனைத்தும் அனுப்பப்பட்டன',
    sentHeading: 'இந்தக் கருவியிலிருந்து அனுப்பப்பட்டவை', nothingSent: 'இன்னும் எதுவும் அனுப்பப்படவில்லை',
    stepSelect: 'அடுக்க ஒரு பொருளைத் தொடவும், அல்லது வரவு பெறவும்',
    stepScanBin: 'வைக்கும் இடத்தை ஸ்கேன் செய்யவும்',
    recalledFlag: 'திரும்பப் பெறப்பட்டது — சேமிப்பு இடம் மட்டும்', expiredFlag: 'காலாவதி — சேமிப்பு இடம் மட்டும்',
    toPick: 'எடுக்க வேண்டியவை', pick: 'எடு', scanPickBin: 'காட்டப்பட்ட இடத்தை ஸ்கேன் செய்யவும்',
    scanItem: 'பொருளை ஸ்கேன் செய்யவும்',
    confirmPick: 'எடுத்ததை உறுதிப்படுத்தவும்', confirm: 'உறுதிப்படுத்து', fromBin: 'இடத்திலிருந்து',
    stepPick: 'எடுக்கத் தொடங்க பட்டியலில் உள்ள இடத்தை ஸ்கேன் செய்யவும், அல்லது ஒரு பொருளைத் தொடவும்',
    stepPickScanBin: 'எடு — வரியில் காட்டப்பட்ட இடத்தை ஸ்கேன் செய்யவும்',
    stepScanItem: 'இப்போது பொருளை ஸ்கேன் செய்யவும்', stepConfirm: 'அளவைச் சரிபார்த்து உறுதிப்படுத்தவும்',
    received: 'பெறப்பட்டது', unknown_barcode: 'தெரியாத பார்கோடு — சரிபார்க்க ஒதுக்கி வைக்கப்பட்டது',
    receiving_done: 'ரசீது அனுப்பப்பட்டது — தலைமை அலுவலகம் வரவை ஆர்டருடன் ஒப்பிடும்',
    nothing_received: 'இந்த வரவுக்கு இந்தக் கருவியில் இன்னும் எதுவும் பெறப்படவில்லை',
    checklist_required: 'குளிர் அல்லது உறைந்த பொருட்கள் — முதலில் பெறுதல் சரிபார்ப்பைச் செய்யவும்',
    checklist_incomplete: 'பெறுதல் சரிபார்ப்பு முடியவில்லை',
    checklistTitle: 'பெறுதல் சரிபார்ப்பு — குளிர் மற்றும் உறைந்த பொருட்கள்', checklistHint: 'வாசலில் ஒவ்வொரு சோதனையையும் குறிக்கவும். அது உங்கள் பெயரில் ரசீதுடன் செல்லும்.',
    checkPass: 'சரி', checkFail: 'தவறு', sendReceipt: 'ரசீதை அனுப்பு', checkedOf: '{total} இல் {n} சரிபார்க்கப்பட்டது',
    checklistActionHint: 'ஒரு சோதனை தவறியது — அதற்கு என்ன செய்யப்பட்டது என்பதைத் தட்டவும்',
    actionRefused: 'மறுக்கப்பட்டது — ஓட்டுநருடன் திருப்பி அனுப்பப்பட்டது', actionChilled: 'உடனே குளிர்சாதனம் அல்லது உறைவிப்பானுக்கு மாற்றப்பட்டது', actionHeld: 'மேலாளர் சரிபார்க்க ஒதுக்கி வைக்கப்பட்டது',
    over_delivery_needs_approval: 'ஆர்டரை விட அதிகம் — இரண்டாவது நபர் ஒப்புதல் அளிக்க வேண்டும்',
    dsd_needs_approval: 'கொள்முதல் ஆர்டர் இல்லை — இரண்டாவது நபர் ஒப்புதல் அளிக்க வேண்டும்',
    price_change_refused: 'வாசலில் விலையை மாற்ற முடியாது',
    manufacture_date_required: 'பொதி செய்த பொருள் — முதலில் தயாரிப்பு மாதத்தை உள்ளிடவும்',
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
    toIssue: 'தளத்திற்கு வழங்க வேண்டியவை', issue: 'தளத்திற்கு வழங்கு', scanIssueBin: 'எடுக்கும் இடத்தை ஸ்கேன் செய்யவும்',
    confirmIssue: 'வழங்கலை உறுதிப்படுத்து', askedBy: 'கேட்டவர்', owed: 'இன்னும் தர வேண்டியது',
    stepIssue: 'தளத்திற்கு வழங்க ஒரு கோரிக்கை வரியைத் தட்டவும்', stepIssueScanBin: 'எடுக்கும் இடத்தை ஸ்கேன் செய்யவும்',
    issued: 'தளத்திற்கு வழங்கப்பட்டது', not_on_indent: 'இந்தக் கருவியில் உள்ள கோரிக்கையில் இல்லை', indent_line_done: 'இந்த வரி முழுமையாக வழங்கப்பட்டது',
    requester_cannot_issue: 'இந்தக் கோரிக்கையை நீங்கள் எழுப்பினீர்கள் — வேறு ஒருவர் வழங்க வேண்டும்', bin_has_none: 'இந்த இடத்தில் அந்தப் பொருள் இல்லை — பொருள் உள்ள இடத்தை ஸ்கேன் செய்யவும்',
    // OB-288 lane 2 · WF-07
    toSendHeading: 'அனுப்ப வேண்டிய மாற்றல்கள்', toCountInHeading: 'எண்ணிப் பெற வேண்டிய மாற்றல்கள்',
    transfersAsOf: 'கடைக் கணினி கடைசியாகக் கேட்ட தலைமை அலுவலக மாற்றல்கள், நேரம்',
    transferTo: 'க்கு', transferFrom: 'இருந்து', transferLines: 'வரி(கள்)', transferDoneHere: 'இந்தக் கருவியில் செய்யப்பட்டது',
    confirmSend: 'இந்த மாற்றலை அனுப்பு — பொருட்கள் ஏற்றப்பட்டன', countInLine: 'எண்ணிப் பெறு', sentWas: 'அனுப்பியது',
    transfer_sent: 'மாற்றல் அனுப்பப்பட்டது', transfer_counted_in: 'மாற்றல் எண்ணிப் பெறப்பட்டது', not_a_transfer_here: 'இந்தக் கடைக்கான மாற்றல் அல்ல',
    transfer_already_done: 'இந்தக் கருவியில் ஏற்கெனவே செய்யப்பட்டது — எதுவும் மாறவில்லை', count_incomplete: 'ஒவ்வொரு வரிக்கும் எண்ணிக்கை தேவை',
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
  transfer_out: { en: 'Transfer sent', ta: 'மாற்றல் அனுப்பப்பட்டது' },
  transfer_in: { en: 'Transfer counted in', ta: 'மாற்றல் எண்ணிப் பெறப்பட்டது' },
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

let arrivalTempC = null; // Wave 3 · SF-07 part 3: the keyed arrival reading, °C, or null (declared early: the first render reads it)
let manufacturedOn = null; // B4 · OB-504: the keyed month of manufacture (YYYY-MM) for packed goods, or null
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
  say(el('scan-title'), title, 'scan-barcode');
  say(el('scan-awaiting'), t('pointAndPull'), 'scan-line');
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
  say(el('confirm-title'), `${t('confirmPick')} — ${line.orderRef}`, 'package-check');
  sayQty(el('confirm-qty'), line.remainingMinor, ` ${t('units')} · ${line.uom}`);
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
  say(el('confirm-title'), `${t('confirmIssue')} — ${line.indentId}`, 'package-minus');
  sayQty(el('confirm-qty'), quantity, ` ${t('units')} · ${line.uom}`);
  el('confirm-hint').textContent = `${line.productId} · ${t('fromBin')} ${binId} · ${t('askedBy')} ${line.requestedBy}`;
  el('confirm-cancel').textContent = t('cancel');
  el('confirm-ok').textContent = t('confirm');
  el('confirm').hidden = false;
  return new Promise((resolve) => { confirmResolve = resolve; });
}

// ── A quantity on a keypad (W2 / W3) ────────────────────────────────────────
// Buttons, never a text box (the scanner discipline above). '0' is a real count — an empty bin is a finding.
function buildKeypad(hostId, entryId, maxDigits = 6) {
  el(hostId).replaceChildren(...['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'].map((key) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = key;
    button.addEventListener('click', () => {
      const current = el(entryId).textContent;
      el(entryId).textContent = key === 'C' ? '0'
        : key === '⌫' ? (current.length > 1 ? current.slice(0, -1) : '0')
          : (current === '0' ? key : (current + key).slice(0, maxDigits));
    });
    return button;
  }));
}
buildKeypad('qty-keypad', 'qty-entry');
buildKeypad('adjust-keypad', 'adjust-entry');
buildKeypad('dsd-driver-keypad', 'dsd-driver-entry', 10); // R3 D-11: a driver's mobile number is ten digits

// ── The arrival temperature (Wave 3 · SF-07 part 3) ──────────────────────────
// Keyed, never typed: digits, a minus and a decimal point. The reading rides on every receiving scan until it is changed or
// cleared ("No reading"); head office holds a chilled or frozen scan without one. A keyed value that is not a plain number
// (a lone minus, a trailing point) is refused on OK — nothing is set.
function renderTemp() {
  say(el('recv-temp'), `${t('tempLabel')}: ${arrivalTempC === null ? t('tempNotTaken') : `${arrivalTempC} °C`}`, 'thermometer');
}
el('temp-keypad').replaceChildren(...['1', '2', '3', '4', '5', '6', '7', '8', '9', '−', '0', '.', 'C', '⌫'].map((key) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = key;
  button.addEventListener('click', () => {
    const current = el('temp-entry').textContent === '—' ? '' : el('temp-entry').textContent;
    const next = key === 'C' ? ''
      : key === '⌫' ? current.slice(0, -1)
        : key === '−' ? (current.startsWith('-') ? current.slice(1) : `-${current}`)
          : key === '.' ? (current.includes('.') ? current : `${current === '' || current === '-' ? `${current}0` : current}.`)
            : (current + key).slice(0, 6);
    el('temp-entry').textContent = next === '' ? '—' : next;
  });
  return button;
}));
el('recv-temp').addEventListener('click', () => {
  say(el('temp-title'), t('tempTitle'), 'thermometer');
  el('temp-hint').textContent = t('tempHint');
  el('temp-none').textContent = t('tempNone');
  el('temp-cancel').textContent = t('cancel');
  el('temp-ok').textContent = t('ok');
  el('temp-entry').textContent = arrivalTempC === null ? '—' : String(arrivalTempC);
  el('temp').hidden = false;
});
// ── The month of manufacture (B4 · OB-504) ──────────────────────────────────
// Keyed on the number pad as YYYYMM (no text box on the handheld). It rides on every receiving scan until changed or cleared
// (key 0); a packed product scanned without it is refused here, offline, and by head office.
function renderMfg() {
  say(el('recv-mfg'), `${t('mfgLabel')}: ${manufacturedOn === null ? t('mfgNotEntered') : manufacturedOn}`, 'calendar');
}
el('recv-mfg').addEventListener('click', async () => {
  const keyed = await awaitQty(t('mfgTitle'), t('mfgHint'), manufacturedOn === null ? '0' : manufacturedOn.replace('-', ''));
  if (keyed === null) return;
  if (keyed === 0) { manufacturedOn = null; renderMfg(); return; }
  const text = String(keyed);
  const month = Number(text.slice(4));
  if (!/^\d{6}$/.test(text) || month < 1 || month > 12) {
    feltResult({ feedback: 'reject', code: 'needMfg', detail: t('needMfgDetail'), sound: 'error', vibrateMs: 300 });
    return;
  }
  manufacturedOn = `${text.slice(0, 4)}-${text.slice(4)}`;
  renderMfg();
});
el('temp-cancel').addEventListener('click', () => { el('temp').hidden = true; });
el('temp-none').addEventListener('click', () => { arrivalTempC = null; el('temp').hidden = true; renderTemp(); });
el('temp-ok').addEventListener('click', () => {
  const text = el('temp-entry').textContent;
  if (text === '—') { arrivalTempC = null; el('temp').hidden = true; renderTemp(); return; }
  if (!/^-?\d+(\.\d+)?$/.test(text) || Math.abs(Number(text)) > 60) {
    el('temp').hidden = true;
    feltResult({ feedback: 'reject', code: 'needTemp', detail: t('needTempDetail'), sound: 'error', vibrateMs: 300 });
    return;
  }
  arrivalTempC = Number(text);
  el('temp').hidden = true;
  renderTemp();
});

// The blind count's quantity: what the worker SAW. The panel carries no expected figure — the model has none to give.
let qtyResolve = null;
function awaitQty(title, hint, initial = '0') {
  say(el('qty-title'), title, 'calculator');
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
  say(el('adjust-title'), t('adjustTitle'), 'sliders');
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
  // OB-521: where the session gave its own Tamil words (the app-version refusal), they are shown in Tamil.
  el('banner-text').textContent = lang === 'ta' && signal.detailTa ? signal.detailTa : signal.detail;
  // OB-205: the outcome's shape beside its word — a tick, a warning, a stop — never the colour alone.
  const shape = mark(signal.feedback === 'accept' ? 'circle-check' : signal.feedback === 'warn' ? 'triangle-alert' : 'circle-alert', 28);
  el('banner-mark').replaceChildren(...(shape === null ? [] : [shape]));
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

  say(el('goods-in-heading'), t('goodsIn'), 'layers');
  el('goods-in-heading').dataset.count = String(items.length);
  say(el('receive'), t('receive'), 'truck');
  renderDeliveries();
  renderTemp();
  renderMfg();
  // SP-6b: "Delivery complete" appears once something has been received here for this delivery and not yet sent as one receipt.
  say(el('done-receiving'), t('doneReceiving'), 'send');
  el('done-receiving').hidden = !(real !== undefined && typeof real.receivingOpen === 'function' && real.receivingOpen(grnId));
  sayAction(el('put-away'), t('putAway'), 'layers', t('waitsForBin'));
  el('put-away').disabled = selected === null;
  say(el('pick-heading'), t('toPick'), 'shopping-basket');
  el('pick-heading').dataset.count = String(lines.length);
  sayAction(el('pick'), t('pick'), 'shopping-basket', t('waitsForBin'));
  say(el('count-bin'), t('countBin'), 'calculator');
  say(el('adjust-stock'), t('adjustStock'), 'sliders');
  el('count-bin').disabled = real === undefined;
  el('adjust-stock').disabled = real === undefined;
  // The Pick button exists only while there is pick work; a bin scanned from the list needs it not at all.
  el('pick').hidden = lines.length === 0;
  if (!lines.some((l) => l.lineId === selectedPick)) selectedPick = null;
  el('pick').disabled = selectedPick === null;
  // SP-8c: the Issue button exists only while the handheld holds floor indents to issue.
  say(el('issue-heading'), t('toIssue'), 'package-minus');
  el('issue-heading').dataset.count = String(issues.length);
  sayAction(el('issue'), t('issue'), 'package-minus', t('waitsForBin'));
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
  const transfersHeld = renderTransfers();

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
    sayQty(qty, line.remainingMinor, ` ${t('units')} · ${line.uom}`);
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
    sayQty(qty, line.remainingMinor, ` ${t('units')} · ${line.uom} · ${t('owed')}`);
    row.append(where, what, qty);
    row.addEventListener('click', () => { selectedIssue = `${line.indentId}|${line.productId}`; selectedPick = null; selected = null; render(); });
    issueHost.append(row);
  }

  const host = el('goods-in');
  host.textContent = '';
  // With pick work but nothing to put away, the goods-in heading would sit over nothing.
  el('goods-in-heading').hidden = items.length === 0 && (lines.length > 0 || issues.length > 0 || transfersHeld > 0);
  if (items.length === 0 && lines.length === 0 && issues.length === 0 && transfersHeld === 0) {
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
    sayQty(qty, item.quantityMinor, ` ${t('units')} · ${item.uom}`);
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
    // A request head office has RECORDED is not yet applied: it waits for a supervisor — say so, never "posted".
    const awaiting = w.kind === 'adjustment' && w.state === 'posted';
    say(state, awaiting ? t('awaitingApproval') : words(STATE_WORDS, w.state), STATE_ICON[awaiting ? 'awaiting' : w.state]);
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
/**
 * OB-288 lane 2 · WF-07 offline: the transfers this store SENDS and COUNTS IN, as head office last said (and when — P-08).
 * A row to send: one tap → the confirm sheet → sent. A row to count in: the keypad once per line (0 is a real count) →
 * counted in. Either is saved on this handheld in the signed-in worker's name and handed to the store computer; what head
 * office refuses comes back in the sent-work list with its reason. Returns how many transfer rows are shown.
 */
function renderTransfers() {
  const work = real && typeof real.transferWork === 'function' ? real.transferWork() : { known: false, toSend: [], toCountIn: [] };
  const shown = work.toSend.length + work.toCountIn.length;
  say(el('xfer-send-heading'), t('toSendHeading'), 'send');
  el('xfer-send-heading').dataset.count = String(work.toSend.filter((r) => !r.doneHere).length);
  el('xfer-send-heading').hidden = work.toSend.length === 0;
  say(el('xfer-in-heading'), t('toCountInHeading'), 'package-check');
  el('xfer-in-heading').dataset.count = String(work.toCountIn.filter((r) => !r.doneHere).length);
  el('xfer-in-heading').hidden = work.toCountIn.length === 0;
  el('xfer-asof').hidden = !work.known || shown === 0;
  if (work.known) el('xfer-asof').textContent = `${t('transfersAsOf')} ${new Date(work.asAt).toLocaleString()}`;
  el('xfer-send').replaceChildren(...work.toSend.map((r) => transferRow(r, 'send')));
  el('xfer-in').replaceChildren(...work.toCountIn.map((r) => transferRow(r, 'in')));
  return shown;
}
function transferRow(r, end) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'item transfer';
  row.dataset.transfer = r.transferId;
  row.dataset.end = end;
  const where = document.createElement('div');
  where.className = 'where';
  where.textContent = r.transferId;
  const what = document.createElement('div');
  what.className = 'what';
  what.textContent = `${end === 'send' ? t('transferTo') : t('transferFrom')} ${end === 'send' ? r.toLocationId : r.fromLocationId} · ${r.lines.length} ${t('transferLines')}`;
  const qty = document.createElement('div');
  qty.className = 'qty';
  sayQty(qty, r.lines.reduce((n, l) => n + l.quantityMinor, 0), ` ${t('units')}`);
  row.append(where, what, qty);
  if (r.doneHere) {
    const f = document.createElement('div');
    f.className = 'flag done';
    say(f, t('transferDoneHere'), 'circle-check');
    row.append(f);
    row.disabled = true;
  }
  row.addEventListener('click', () => { void (end === 'send' ? startSendTransfer(r) : startCountInTransfer(r)); });
  return row;
}
async function startSendTransfer(r) {
  say(el('confirm-title'), `${t('confirmSend')} — ${r.transferId}`, 'send');
  sayQty(el('confirm-qty'), r.lines.reduce((n, l) => n + l.quantityMinor, 0), ` ${t('units')} · ${r.lines.length} ${t('transferLines')}`);
  el('confirm-hint').textContent = `${t('transferTo')} ${r.toLocationId} · ${r.lines.map((l) => `${l.productId} ${l.quantityMinor} ${l.uom}`).join(' · ')}`;
  el('confirm-cancel').textContent = t('cancel');
  el('confirm-ok').textContent = t('confirm');
  el('confirm').hidden = false;
  const yes = await new Promise((resolve) => { confirmResolve = resolve; });
  if (!yes) return;
  const out = real.sendTransfer({ transferId: r.transferId, at: new Date().toISOString() });
  feltResult(out.signal);
  render();
  if (out.accepted) void syncToBox();
}
async function startCountInTransfer(r) {
  const counted = [];
  for (const l of r.lines) {
    const q = await awaitQty(`${t('countInLine')} — ${l.productId}${l.batchId ? ` · ${l.batchId}` : ''}`, `${r.transferId} · ${t('sentWas')} ${l.quantityMinor} ${l.uom}`, '0');
    if (q === null) return;
    counted.push({ productId: l.productId, batchId: l.batchId, quantityMinor: q });
  }
  const out = real.countInTransfer({ transferId: r.transferId, counted, at: new Date().toISOString() });
  feltResult(out.signal);
  render();
  if (out.accepted) void syncToBox();
}

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
const syncTimer = setInterval(() => { void syncToBox(); }, 10_000);
// Verifier hh L3: when the sign-in ends the screen locks (the strip's script); this screen's timers stop with it.
(window.phoneSignInOnLock = Array.isArray(window.phoneSignInOnLock) ? window.phoneSignInOnLock : []).push(() => clearInterval(syncTimer));

// ── OB-37: the store's open deliveries ──────────────────────────────────────
// Each issued order that names this store, with what is still to arrive. Choosing one reloads the phone on it (the box
// serves the same page; the choice rides in the address), so every scan is received against the order at the door.
function renderDeliveries() {
  const list = (data && Array.isArray(data.openDeliveries)) ? data.openDeliveries : [];
  el('deliveries-heading').hidden = list.length === 0;
  say(el('deliveries-heading'), t('deliveries'), 'truck');
  el('deliveries-heading').dataset.count = String(list.length);
  el('deliveries').replaceChildren(...list.map((d) => {
    const row = document.createElement('a');
    row.className = 'row';
    row.href = `?delivery=${encodeURIComponent(d.poId)}`;
    const current = data.poId === d.poId;
    row.setAttribute('aria-current', current ? 'true' : 'false');
    const units = d.ordered.reduce((n, o) => n + o.quantityMinor, 0);
    row.textContent = `${d.number} · ${d.supplierId} · ${d.ordered.length} × ${units} — ${current ? t('receivingThis') : t('chooseThis')}`;
    return row;
  }));
  // Several waiting and none chosen: nothing is received under a made-up delivery.
  const mustChoose = list.length > 1 && !(data && data.grnId);
  el('receive').disabled = mustChoose;
  el('receive').title = mustChoose ? t('chooseDelivery') : '';
}

// ── Actions ─────────────────────────────────────────────────────────────────
el('receive').addEventListener('click', async () => {
  // Wave 3 · SF-07 part 3: the probe reading, when the goods are chilled or frozen — checked BEFORE the scan, so a word never
  // travels. Empty = not taken (head office then holds a cold-chain item for a second person's check).
  const code = await awaitScan(t('scanBarcode'));
  if (code === null || real === undefined) return;
  const out = real.receive({
    commandId: nextId('recv'), grnId, barcode: code, scannedQuantity: 1, source: 'po',
    ...(arrivalTempC === null ? {} : { temperatureC: arrivalTempC }),
    ...(manufacturedOn === null ? {} : { manufacturedOn }),
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
el('done-receiving').addEventListener('click', async () => {
  if (real === undefined) return;
  // OB-172: a chilled / frozen / raw-meat delivery asks for the receiving checklist first (head office's own, from the store
  // setup — no network needed). Cancelled → nothing is sent; the delivery stays open on this handheld.
  const need = typeof real.deliveryChecklist === 'function' ? real.deliveryChecklist(grnId) : { known: false, coldChain: [] };
  let checklist;
  if (need.check !== undefined && need.coldChain.length > 0) {
    checklist = await awaitChecklist(need.check, need.coldChain);
    if (checklist === null) return;
  }
  const out = real.completeReceiving({ grnId, ...(checklist === undefined ? {} : { checklist }) });
  feltResult(out.signal);
  render();
  if (out.signal.feedback === 'accept') void syncToBox();
});

/**
 * OB-172: the receiving checklist sheet — one Pass / Fail pair per check, and on any failure the corrective action as a
 * tap (no text box on the handheld). Resolves the answer, or null on Cancel. The session judges it again before it sends.
 */
let checklistResolve = null;
function awaitChecklist(check, coldChain) {
  const results = {};
  let action = null;
  const ACTIONS = ['actionRefused', 'actionChilled', 'actionHeld'];
  const paint = () => {
    const anyFail = check.items.some((i) => results[i.itemId] === 'fail');
    el('checklist-action-hint').hidden = !anyFail;
    el('checklist-actions').hidden = !anyFail;
    if (!anyFail) action = null;
    for (const b of el('checklist-actions').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.action === action));
    for (const b of el('checklist-items').querySelectorAll('button')) b.setAttribute('aria-pressed', String(results[b.dataset.item] === b.dataset.result));
    el('checklist-ok').disabled = !(check.items.every((i) => results[i.itemId] !== undefined) && (!anyFail || action !== null));
    // OB-205: how far through the checks the receiver is, in words.
    const answered = check.items.filter((i) => results[i.itemId] !== undefined).length;
    el('checklist-progress').hidden = check.items.length === 0;
    el('checklist-progress').textContent = t('checkedOf').replace('{n}', String(answered)).replace('{total}', String(check.items.length));
  };
  say(el('checklist-title'), check.title ? `${t('checklistTitle')} · ${check.title}` : t('checklistTitle'), 'clipboard-check');
  el('checklist-hint').textContent = `${t('checklistHint')} (${coldChain.join(', ')})`;
  el('checklist-action-hint').textContent = t('checklistActionHint');
  el('checklist-cancel').textContent = t('cancel');
  el('checklist-ok').textContent = t('sendReceipt');
  el('checklist-items').replaceChildren(...check.items.map((item) => {
    const row = document.createElement('div');
    row.className = 'check-item';
    const name = document.createElement('span');
    name.id = `check-${item.itemId}`;
    name.textContent = item.label;
    const pair = document.createElement('div');
    pair.className = 'direction';
    pair.setAttribute('role', 'group');
    pair.setAttribute('aria-labelledby', name.id);
    for (const result of ['pass', 'fail']) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.item = item.itemId;
      b.dataset.result = result;
      b.textContent = t(result === 'pass' ? 'checkPass' : 'checkFail');
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => { results[item.itemId] = result; paint(); });
      pair.append(b);
    }
    row.append(name, pair);
    return row;
  }));
  el('checklist-actions').replaceChildren(...ACTIONS.map((key) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.action = key;
    b.textContent = t(key);
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => { action = key; paint(); });
    return b;
  }));
  paint();
  el('checklist').hidden = false;
  return new Promise((resolve) => {
    checklistResolve = (answer) => resolve(answer === null ? null : {
      checkId: check.checkId, itemResults: { ...results },
      // The words of what was done go in English for the record (head office's inspector reads one language).
      ...(action === null ? {} : { correctiveAction: WORDS.en[action] }),
    });
  });
}
function settleChecklist(answer) {
  el('checklist').hidden = true;
  if (checklistResolve !== null) { const r = checklistResolve; checklistResolve = null; r(answer); }
}
el('checklist-cancel').addEventListener('click', () => settleChecklist(null));
el('checklist-ok').addEventListener('click', () => settleChecklist({}));

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

// ── R3 D-11 (OB-141): a direct delivery at the back door — no cash ───────────────────────────────────────
// The rules are the tested `DsdDoorSession` (apps/warehouse-app/src/dsd-door.ts) over the same engine head office runs.
// This view only shows its lines and differences and passes the worker's taps and scans. There is no money field.
// NOTE: the Tamil below is pending a native-speaker review before go-live (OWNER-ACTION OA-10), like the rest.
const DSD_WORDS = {
  en: {
    dsd_started: 'Check-in started', dsd_scanned: 'Scanned', dsd_handed_back: 'Handed back to the driver',
    dsd_closed: 'Delivery closed — note signed', unknown_barcode: 'Not a product this phone knows', not_a_quantity: 'That is not a quantity',
    no_reason: 'Choose why it is handed back', hand_back_more_than_scanned: 'More handed back than came off the van',
    delivery_note_not_signed: 'Scan the delivery note first', no_cash_at_the_door: 'No cash at the door',
    dsd_not_started: 'Start the check-in first', dsd_already_closed: 'This delivery is already closed', dsd_needs_vendor: 'Choose the delivery and key the driver',
    app_version_too_old: 'Update this handheld',
    expected: 'expected', scanned: 'scanned', back: 'handed back', kept: 'kept',
    // D-11: what is kept from a route sheet (no order) or beyond the order waits for a second person at head office.
    held: 'held for a second person',
    short: 'short', over: 'over', not_expected: 'not on the order', noDifferences: 'No differences',
    driverKeyed: 'Driver\'s mobile number', notKeyed: 'not keyed', noteScanned: 'Delivery note', scanNote: 'scan its barcode',
    chooseItemBack: 'Tap the item to hand back', chooseWhy: 'Why is it handed back?', howMany: 'How many are handed back?',
    damaged: 'Damaged', temperature_breach: 'Too warm / too cold', expired: 'Expired', not_ordered: 'Not ordered', other: 'Other',
    nothingToChoose: 'No delivery for this store is on this phone', route: 'route', useNumber: 'tap to use the ten digits keyed above',
    // OB-205: the sheet's own labels, which were English only.
    dsdOpen: 'Direct delivery at the door (no cash)', dsdTitle: 'Direct delivery at the door',
    noCashNote: 'No cash at the door. The driver gets the signed delivery note; the supplier is paid later as a supplier bill.',
    startCheckIn: 'Start the check-in', dsdScanItem: 'Scan an item', handBack: 'Hand back to the driver', backBtn: 'Back',
    closeDelivery: 'Driver signs the note — close the delivery',
  },
  ta: {
    dsd_started: 'சரிபார்ப்பு தொடங்கியது', dsd_scanned: 'ஸ்கேன் செய்யப்பட்டது', dsd_handed_back: 'ஓட்டுநரிடம் திருப்பி கொடுக்கப்பட்டது',
    dsd_closed: 'டெலிவரி முடிந்தது — குறிப்பு கையெழுத்திடப்பட்டது', unknown_barcode: 'இந்த போனுக்கு தெரியாத பொருள்', not_a_quantity: 'அது ஒரு எண்ணிக்கை அல்ல',
    no_reason: 'ஏன் திருப்பி கொடுக்கப்படுகிறது என்பதைத் தேர்வு செய்யவும்', hand_back_more_than_scanned: 'வண்டியிலிருந்து வந்ததை விட அதிகம் திருப்பப்பட்டது',
    delivery_note_not_signed: 'முதலில் டெலிவரி குறிப்பை ஸ்கேன் செய்யவும்', no_cash_at_the_door: 'வாசலில் பணம் இல்லை',
    dsd_not_started: 'முதலில் சரிபார்ப்பைத் தொடங்கவும்', dsd_already_closed: 'இந்த டெலிவரி ஏற்கனவே முடிந்தது', dsd_needs_vendor: 'டெலிவரியைத் தேர்வு செய்து ஓட்டுநர் எண்ணை உள்ளிடவும்',
    app_version_too_old: 'இந்தக் கருவியைப் புதுப்பிக்கவும்',
    expected: 'எதிர்பார்த்தது', scanned: 'ஸ்கேன்', back: 'திருப்பியது', kept: 'வைத்தது',
    held: 'இரண்டாம் நபர் முடிவுக்காக நிறுத்தப்பட்டது',
    short: 'குறைவு', over: 'அதிகம்', not_expected: 'ஆர்டரில் இல்லை', noDifferences: 'வேறுபாடு இல்லை',
    driverKeyed: 'ஓட்டுநரின் மொபைல் எண்', notKeyed: 'உள்ளிடப்படவில்லை', noteScanned: 'டெலிவரி குறிப்பு', scanNote: 'அதன் பார்கோடை ஸ்கேன் செய்யவும்',
    chooseItemBack: 'திருப்ப வேண்டிய பொருளைத் தட்டவும்', chooseWhy: 'ஏன் திருப்பப்படுகிறது?', howMany: 'எத்தனை திருப்பப்படுகின்றன?',
    damaged: 'சேதம்', temperature_breach: 'அதிக சூடு / அதிக குளிர்', expired: 'காலாவதி', not_ordered: 'ஆர்டர் செய்யப்படவில்லை', other: 'மற்றவை',
    nothingToChoose: 'இந்த கடைக்கான டெலிவரி இந்த போனில் இல்லை', route: 'வழி', useNumber: 'மேலே உள்ளிட்ட பத்து இலக்கங்களைப் பயன்படுத்த தட்டவும்',
    dsdOpen: 'வாசலில் நேரடி டெலிவரி (பணம் இல்லை)', dsdTitle: 'வாசலில் நேரடி டெலிவரி',
    noCashNote: 'வாசலில் பணம் இல்லை. ஓட்டுநருக்குக் கையெழுத்திட்ட டெலிவரி குறிப்பு கிடைக்கும்; சப்ளையருக்குப் பின்னர் சப்ளையர் பில்லாகப் பணம் செலுத்தப்படும்.',
    startCheckIn: 'சரிபார்ப்பைத் தொடங்கு', dsdScanItem: 'ஒரு பொருளை ஸ்கேன் செய்', handBack: 'ஓட்டுநரிடம் திருப்பிக் கொடு', backBtn: 'பின்செல்',
    closeDelivery: 'ஓட்டுநர் குறிப்பில் கையெழுத்திடுகிறார் — டெலிவரியை முடி',
  },
};
const dt = (key) => DSD_WORDS[lang][key] ?? DSD_WORDS.en[key] ?? key;
const dsd = window.dsdSession;
let dsdChoice = null; // { poId } | { routeId, supplierId }
let dsdDriver = null; // the driver's mobile number, keyed
let dsdNote = null; // the delivery note's scanned reference
let dsdBack = null; // a hand-back in progress: { productId, quantityMinor }

function dsdFelt(signal) {
  feltResult({ ...signal, code: signal.code });
  el('banner-title').textContent = dt(signal.code);
}

function renderDsd() {
  if (!dsd) return;
  const view = dsd.view();
  const open = view !== null && !view.closed;
  el('dsd-start-panel').hidden = open;
  el('dsd-work-panel').hidden = !open;
  if (!open) {
    const c = dsd.choices();
    const buttons = [
      ...c.orders.map((o) => ({ key: `po:${o.poId}`, text: `${o.number} · ${o.supplierId}`, choice: { poId: o.poId } })),
      ...c.routes.map((r) => ({ key: `route:${r.routeId}`, text: `${dt('route')} ${r.routeId} · ${r.supplierId}`, choice: { routeId: r.routeId, supplierId: r.supplierId } })),
    ];
    el('dsd-choose-hint').textContent = buttons.length === 0 ? dt('nothingToChoose') : t('chooseDelivery');
    el('dsd-choices').replaceChildren(...buttons.map((b) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.choice = b.key;
      button.textContent = b.text;
      button.setAttribute('aria-pressed', String(dsdChoice !== null && JSON.stringify(dsdChoice) === JSON.stringify(b.choice)));
      button.addEventListener('click', () => { dsdChoice = b.choice; renderDsd(); });
      return button;
    }));
    el('dsd-driver').textContent = `${dt('driverKeyed')}: ${dsdDriver ?? dt('notKeyed')} — ${dt('useNumber')}`;
    el('dsd-start').disabled = dsdChoice === null || dsdDriver === null;
    return;
  }
  el('dsd-against').textContent = `${view.supplierId} · ${view.against}`;
  el('dsd-lines').replaceChildren(...view.lines.map((l) => {
    const row = document.createElement('div');
    row.className = 'item';
    row.dataset.product = l.productId;
    const what = document.createElement('span'); what.className = 'what'; what.textContent = l.productId;
    const qty = document.createElement('span'); qty.className = 'qty';
    qty.textContent = `${dt('expected')} ${l.expectedMinor} · ${dt('scanned')} ${l.scannedMinor} · ${dt('back')} ${l.handedBackMinor} · ${dt('kept')} ${l.keptMinor}`
      + (l.heldMinor > 0 ? ` · ${dt('held')} ${l.heldMinor}` : '');
    // OB-205: the one number the receiver checks at a glance — scanned against expected — big, on the right.
    const count = document.createElement('span'); count.className = 'count';
    sayQty(count, `${l.scannedMinor} / ${l.expectedMinor}`, `${dt('scanned')} / ${dt('expected')}`);
    row.append(what, qty, count);
    return row;
  }));
  el('dsd-differences').replaceChildren(...(view.discrepancies.length === 0
    ? [Object.assign(document.createElement('p'), { className: 'hint', textContent: dt('noDifferences') })]
    : view.discrepancies.map((d) => {
      const p = document.createElement('p');
      p.className = 'flag discrepancy';
      p.dataset.kind = d.kind;
      p.textContent = `${d.productId}: ${dt(d.kind)} ${Math.abs(d.differenceMinor)}`;
      return p;
    })));
  el('dsd-note').textContent = `${dt('noteScanned')}: ${dsdNote ?? dt('scanNote')}`;
  el('dsd-close').disabled = dsdNote === null;
}

el('dsd-open').hidden = !dsd;
/** OB-205: the door sheet's fixed labels, in the worker's language, with their icons. */
function paintDsdWords() {
  say(el('dsd-open'), dt('dsdOpen'), 'truck');
  say(el('dsd-title'), dt('dsdTitle'), 'truck');
  el('dsd-no-cash').textContent = dt('noCashNote');
  say(el('dsd-start'), dt('startCheckIn'), 'clipboard-list');
  say(el('dsd-scan'), dt('dsdScanItem'), 'scan-barcode');
  say(el('dsd-hand-back'), dt('handBack'), 'rotate-ccw');
  say(el('dsd-cancel'), dt('backBtn'), 'x');
  say(el('dsd-close'), dt('closeDelivery'), 'file-text');
}
paintDsdWords();
el('dsd-open').addEventListener('click', () => { el('dsd').hidden = false; renderDsd(); });
el('dsd-cancel').addEventListener('click', () => { el('dsd').hidden = true; });
el('dsd-driver').addEventListener('click', () => {
  const entry = el('dsd-driver-entry').textContent;
  if (/^[0-9]{10}$/.test(entry)) dsdDriver = entry;
  renderDsd();
});
el('dsd-start').addEventListener('click', () => {
  if (!dsd || dsdChoice === null || dsdDriver === null) return;
  const out = dsd.start({ checkInId: nextId('dsd'), ...dsdChoice, driverName: `mobile ${dsdDriver}` });
  dsdFelt(out);
  renderDsd();
});
el('dsd-scan').addEventListener('click', async () => {
  const code = await awaitScan(t('scanBarcode'));
  if (code === null || !dsd) return;
  dsdFelt(dsd.scan(nextId('dsd-scan'), code));
  renderDsd();
});
el('dsd-hand-back').addEventListener('click', () => {
  const view = dsd ? dsd.view() : null;
  if (view === null) return;
  el('dsd-back-hint').hidden = false;
  el('dsd-back-hint').textContent = dt('chooseItemBack');
  el('dsd-back-products').hidden = false;
  el('dsd-back-products').replaceChildren(...view.lines.filter((l) => l.keptMinor > 0).map((l) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.product = l.productId;
    button.textContent = l.productId;
    button.addEventListener('click', async () => {
      const n = await awaitQty(dt('howMany'), l.productId, '1');
      if (n === null) return;
      dsdBack = { productId: l.productId, quantityMinor: n };
      el('dsd-back-products').hidden = true;
      el('dsd-back-hint').textContent = dt('chooseWhy');
      el('dsd-back-reasons').hidden = false;
      el('dsd-back-reasons').replaceChildren(...['damaged', 'temperature_breach', 'expired', 'not_ordered', 'other'].map((reason) => {
        const r = document.createElement('button');
        r.type = 'button';
        r.dataset.reason = reason;
        r.textContent = dt(reason);
        r.addEventListener('click', () => {
          el('dsd-back-reasons').hidden = true;
          el('dsd-back-hint').hidden = true;
          if (dsdBack === null) return;
          dsdFelt(dsd.handBack(nextId('dsd-back'), dsdBack.productId, dsdBack.quantityMinor, reason));
          dsdBack = null;
          renderDsd();
        });
        return r;
      }));
    });
    return button;
  }));
});
el('dsd-note').addEventListener('click', async () => {
  const code = await awaitScan(`${dt('noteScanned')}: ${dt('scanNote')}`);
  if (code !== null) dsdNote = code;
  renderDsd();
});
el('dsd-close').addEventListener('click', () => {
  if (!dsd || dsdNote === null || dsdDriver === null) return;
  const out = dsd.close({ noteRef: dsdNote, driverSignedName: `mobile ${dsdDriver}` });
  dsdFelt(out);
  if (out.feedback === 'accept') { dsdChoice = null; dsdNote = null; dsdDriver = null; void syncToBox(); }
  renderDsd();
  render();
});

// ── Language ────────────────────────────────────────────────────────────────
el('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  el('sample').textContent = t('sample');
  paintDsdWords();
  renderDsd();
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
      boxWords = `${s.cloud === 'offline' ? t('noCloud') : s.cloud === 'login_refused' ? t('cloudLoginRefused') : s.cloud === 'not_configured' ? t('cloudNotSetUp') : t('cloudUnknown')}${when}`;
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
    // OB-521: the app version policy as the store computer's signed pack has it now (only an answer from the box changes it).
    if (box.reachable && box.status && 'appVersionPolicy' in box.status) window.warehouseVersion?.apply(box.status.appVersionPolicy);
  } catch {
    box = { asked: true, reachable: false, status: null };
  } finally {
    clearTimeout(timer);
  }
  paintBadge();
}
window.warehouseBadge = { refresh: refreshBadge, state: () => box };
void refreshBadge();
const badgeTimer = setInterval(() => { void refreshBadge(); }, 10_000);
window.phoneSignInOnLock.push(() => clearInterval(badgeTimer));

// ── Boot ────────────────────────────────────────────────────────────────────
el('who').firstChild.textContent = (data && data.workerId) || '—';
el('assignment').textContent = (data && data.assignmentId) || '';
el('sample').hidden = real !== undefined;
el('sample').textContent = t('sample');
paintIconSlots();

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
