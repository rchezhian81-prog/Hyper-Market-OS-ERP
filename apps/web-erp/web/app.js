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
// This screen reads a last-synced payload and never presents it as live. It makes exactly ONE write,
// and never on load: the manager's day close, and even that is not a raw fetch here — it calls the
// session's `closeViaBox`, which posts to the store computer through an injected port. The box makes
// the authoritative decision; this view shows what the box decided and locks nothing itself.

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
    manager: 'Store workspace', tradingDay: 'Trading day', today: 'Today', approvals: 'Approvals',
    nobodyNamed: 'Nobody is named for this screen on the store computer. What is waiting is shown; nothing can be decided, received, counted or closed until a manager is named.',
    runningAs: 'Running as',
    // The badge's states from the BOX (design system §1 rule 4): connection · last contact.
    // The home screen's ONE primary action (store-manager.md: clear the next approval or exception; ≤3 taps).
    nextApproval: 'Clear the next approval',
    receive: 'Receive', count: 'Count', closeDay: 'Close the day',
    tapAFigure: 'Tap a figure to go to it.', waiting: 'waiting', youCanClear: 'you can clear',
    exceptionsLabel: 'Exceptions open', unsentLabel: 'Not yet sent to cloud', tasksLabel: 'Tasks today',
    approvalsLabel: 'Approvals waiting', notKnown: 'Not known', nothingWaiting: 'Nothing is waiting.',
    // The Today command centre (UX-2b · OB-15/OB-16).
    salesTodayLabel: 'Sales today', boxSilent: 'the store computer has not said',
    needsAttention: 'Needs attention', nothingNeedsYou: 'Nothing on this list needs you right now. It covers only the figures on this page — it is not a check of the whole store.', purchaseToShelf: 'Purchase to shelf', storeToday: 'Store today', workspaces: 'Workspaces', screenWord: 'screen', screensWord: 'screens', open: 'Open',
    poOpen: 'Purchase orders open', receiptsRecorded: 'Receipts recorded', countsAwaiting: 'Counts awaiting approval', indentsOpen: 'Floor indents open',
    deliveriesToday: 'Deliveries today', checklistOpen: 'Checklist items open', expiringSoon: 'Expiring soon', recallsOpen: 'Recall notices', claimDisputesOpen: 'Disputed supplier claims open',
    attnApprovals: 'approvals you can clear', attnHoApprovals: 'approvals waiting for you at head office — open Approvals', attnExceptions: 'exceptions open', attnUnsent: 'items not yet sent to the cloud', attnRecalls: 'recall notices', attnClaimDisputes: 'disputed supplier claims to settle — open Supplier claims', attnExpiring: 'batches expiring soon', attnChecklist: 'checklist items still open', attnCounts: 'counts awaiting approval', tillDevicesLabel: 'Till devices', attnTillDevices: 'till device(s) failed or not working properly',
    // D-2 (OB-773): drawers closed over/short today, from the store computer's own till-cash log — not in the exceptions count.
    attnOverShort: 'drawer(s) closed over or short today — sign-off is on Cash over / short', overShortNotCounted: 'not counted here: {n} drawer(s) closed over or short today — see Needs attention',
    // OB-392: lane health on Today — one tap per lane.
    lanesTitle: 'Lanes', laneWord: 'Lane', laneAllWorking: 'every device working', laneProblems: 'device problem(s)', laneNotReported: 'the till has not reported its devices yet',
    lanePrinter: 'Printer', laneScanner: 'Scanner', laneCard: 'Card machine', laneLastHeard: 'Till last reported', laneUnsent: 'Not yet at head office', laneLastSync: 'Last sent to head office',
    devOk: 'Working', devDegraded: 'Not working properly', devFailed: 'Failed', devNotReported: 'Not reported', laneNever: 'never', laneBills: 'bill(s) or refund(s) from this till',
    biggestFirst: 'Biggest first.', approve: 'Approve', reject: 'Reject', cancel: 'Cancel', ok: 'OK',
    whyApprove: 'Why are you approving this?', whyReject: 'Why are you rejecting this?',
    decided: 'Decided', requestedBy: 'asked for by', noValue: 'no value',
    // Everything this screen saved — decisions, deliveries, counts — and where each has got to (SP-2a/2b).
    savedHere: 'Saved on this screen', savedLead: 'Decisions, deliveries and counts this screen saved, and where each has got to. Nothing here is lost on a reload.',
    approvedWord: 'Approved', rejectedWord: 'Rejected', heldHere: 'saved, going to head office when the line is up',
    linesWord: 'lines', noOrderWord: 'no purchase order',
    read: 'Please read this', done: 'Done',
    deliveryNote: 'Delivery note number', poNumber: 'Purchase order number (leave empty if there is none)',
    itemCode: 'Item (name or code)', howMany: 'How many', addItem: 'Add this item', noItemsYet: 'No items added yet.',
    tempLabel: 'Temperature on arrival, °C (chilled or frozen goods)',
    tempHint: 'Probe the goods and type the reading, for example 3.5 or -18. Without it, chilled and frozen goods wait for a manager\'s check before they can be sold.',
    needTemp: 'The temperature must be a number of degrees, for example 3.5 or -18. Leave it empty for goods that are not chilled or frozen.',
    // B4 · OB-504: the month and year of manufacture on a packed product's pack.
    mfgLabel: 'Month and year of manufacture (packed goods)', mfgHint: 'Pick the month printed on the pack. A packed product cannot be saved without it.',
    needMfg: 'Write the month of manufacture as year-month, for example 2026-09 (or a full date, 2026-09-14).',
    mfgRequired: 'This is a packed product: type the month and year of manufacture printed on the pack before adding it.',
    mfgWord: 'made',
    // Fix batch 4b · D-029: receive against a chosen order; per line what arrived, damaged, the batch and the expiry date.
    placeLabel: 'Book the goods into', placeStore: 'This store (the shelves the tills sell from) — {id}', placeBack: 'The back store — {id}', placeFromOrder: 'The order says deliver to: {place}.', placeChosenOther: 'The order says deliver to {place}; you chose another place.',
    orderLabel: 'Which order is this delivery?', orderPick: '— choose the order —', orderNone: 'No order — delivered without one',
    orderOther: 'An order not listed — type its number', orderItems: '{n} item(s) due',
    orderAsAt: 'Orders as head office last sent them ({at}). An order issued after that is not listed: choose "An order not listed".',
    chooseOrder: 'Choose the order this delivery is against first (or "No order").',
    linesFromOrder: 'The order\'s items are filled in with what is due. Change "Arrived" where fewer came, and write any damaged, the batch and the expiry date.',
    dueWord: 'due', receivedLabel: 'Arrived', damagedLabel: 'Damaged', batchLabel: 'Batch number', expiryLabel: 'Expiry (best before)',
    mfgShort: 'Month of manufacture', tempShort: 'Temperature °C',
    qcFailLabel: 'Failed quality check / refused at the door', mrpLabel: 'MRP on the pack (₹)', qcFailWord: 'failed the check', mrpWord: 'MRP ₹',
    // Batch 20a · R7 (M03-FR-02): "cases × pack size" for an item head office gave case sizes; the line still records units.
    casesLabel: 'Cases of {n}', caseSizeLabel: 'Pack size', looseLabel: 'Loose units', caseOf: '{level} of {n}',
    casesMath: '{cases} × {n} + {loose} loose = {total} units', needCases: 'Cases and loose units must be whole numbers, 0 or more.',
    needMrp: 'MRP on the pack must be an amount in rupees above 0, with at most 2 decimals (for example 120 or 99.50).',
    needQcFail: '"Failed quality check" must be a whole number, 0 or more.',
    shortBy: 'Short by {n}', moreBy: '{n} more than due', damagedWord: 'damaged', batchWord: 'batch', expWord: 'expires',
    lineProblems: 'Nothing was saved. Check these lines:',
    lp_expiry_not_a_date: 'the expiry is not a real date', lp_damaged_not_whole: 'damaged must be a whole number',
    lp_damaged_more_than_arrived: 'more damaged than arrived', lp_batch_and_expiry_needed: 'this item needs its batch number and expiry date',
    lp_qc_failed_not_whole: '"failed quality check" must be a whole number', lp_set_aside_more_than_arrived: 'damaged and failed the check add up to more than arrived',
    lp_mrp_not_an_amount: 'the MRP is not an amount above 0',
    needArrived: 'Arrived must be a whole number, 0 or more.',
    saveDelivery: 'Save the delivery', remove: 'Remove',
    needNumber: 'Give the delivery note a number first.', needLines: 'Add at least one item first.',
    needItem: 'Type an item code and how many.',
    received: 'Delivery saved', unmatchedWarning: 'There is no purchase order behind this delivery, so nobody can check the invoice against it. Tell the buyer today.',
    matchedNote: 'Head office will check it against the order and the item rules when it arrives there.',
    productCode: 'Product (name or code)', whereIsIt: 'Where (aisle or bay)',
    enterCount: 'Enter the count', howManyOnShelf: 'How many are actually there?',
    countBlindHint: "Count what is actually on the shelf. This screen will not show you the system's figure first — that is on purpose.",
    whyDifferent: 'Why is it different?', needProduct: 'Type a product code and where it is.',
    countRecorded: 'Count recorded',
    countNote: 'Head office works out the difference and what it is worth. A large difference waits there for somebody else to approve; the shelf figure does not change until then.',
    alreadyCounted: 'That count is already saved on this screen. To count the item again, enter a new count.',
    checkOpen: 'Check what is still open', closeNow: 'Close the day now',
    closePin: 'Your till PIN — you key it yourself',
    carryLead: 'Only card or UPI payments are open. The day can close with them sent to head office by name — a second person must approve with their own PIN. Finance settles each one when the provider answers.',
    carryApprover: 'Second person (name or staff ID)', carryPin: 'Their till PIN — they key it themselves', carryReason: 'Why',
    carryProvider: 'The card or UPI provider is not answering', carryMachine: 'The card machine is faulty',
    carryNow: 'Close with these sent to head office', carryNeeds: 'Key your own PIN above, and the second person\'s staff ID and their own PIN.',
    // OB-205: the approvals register's captions and the day close's help lines.
    colRequest: 'Request', colValue: 'Value', colDecision: 'Decision',
    receiveLead: 'Saved on this screen with or without a connection; the store computer sends it to head office.',
    closePinHint: 'Up to six digits. The store computer checks it; it is cleared from this screen as soon as it is sent.',
    carryPinHint: 'The second person types this themselves, on this screen.',
    carried: 'The day is closed and locked. These payments are on head office\'s list until the provider answers',
    closedNote: 'A closed day is locked. Anything found afterwards is a correction, not a change.',
    dayClosed: 'The day is closed and locked.', stillOpen: 'The day cannot close yet',
    // Fix batch 3 (D-012): the day the store computer closes, named on the button and in every message.
    closeNamed: 'Close {day}', closeThisDay: 'This closes {day} — the last trading day that has ended.',
    runningDayWhen: 'Today, {day}, is still trading. It can be closed from {at} on {next}, after the store\'s day cutoff.',
    readyToClose: 'Nothing is open for {day}', readyNote: 'Key your till PIN, then press "{button}".',
    closedNamed: '{day} is closed and locked.', stillOpenNamed: '{day} cannot close yet',
    andMore: 'and more', whatToDo: 'What to do',
    // OB-271 · audit A9: the day's card and UPI list (real trading only).
    cardDayTitle: 'Card and UPI today — match against the machine\'s settlement slip',
    cardDayLead: 'Every card and UPI payment on this store computer\'s tills today, with the number the shop\'s machine printed. Tick each one against the machine\'s settlement slip before you close. A card number is never kept or shown.',
    cardColTime: 'Time', cardColTill: 'Till', cardColKind: 'Card / UPI', cardColAmount: 'Amount', cardColRef: 'Approval / Auth code / RRN', cardColBill: 'Bill',
    cardColRefundRef: 'Refund reference', cardColCheckedBy: 'Checked by', cardColRefund: 'Refund',
    cardKindCard: 'Card', cardKindUpi: 'UPI',
    cardNoRef: 'no number kept — check the machine\'s slip', cardNoBill: 'no bill yet',
    cardPaidTotal: 'Paid by card and UPI today', cardRefundedTotal: 'Refunded on the machine today',
    cardNone: 'No card or UPI payment on this store computer today.',
    cardUnresolvedTitle: 'Still no answer from the machine — check the machine before closing',
    cardRefundsTitle: 'Refunds done on the machine',
    sampleData: 'Sample data — this is not your store.',
    countedSoFar: 'Counted', item: 'Item',
    // OB-172: the receiving checklist for chilled, frozen or raw-meat goods, done at the door and saved with the delivery.
    rcTitle: 'Receiving checklist — chilled and frozen goods',
    rcWhy: 'This delivery has chilled or frozen goods. Tick each check at the door; it is saved with the delivery, in your name.',
    rcPass: 'Pass', rcFail: 'Fail',
    rcAction: 'What was done about the failure (for example: crate refused and sent back)',
    rcNotTold: 'This store computer was not sent the receiving checklist. The delivery is saved and head office will see the checklist is missing.',
    rcNeeded: 'Do the receiving checklist first: tick every check pass or fail.',
    rcNeedAction: 'A check failed. Write what was done about it before saving.',
    rcSaved: 'Receiving checklist saved with the delivery.',
  },
  ta: {
    manager: 'கடை பணியிடம்', tradingDay: 'வியாபார நாள்', today: 'இன்று', approvals: 'ஒப்புதல்கள்',
    nobodyNamed: 'இந்தத் திரைக்கு கடை கணினியில் யாரும் பெயரிடப்படவில்லை. காத்திருப்பவை காட்டப்படுகின்றன; மேலாளர் பெயரிடப்படும் வரை எதையும் முடிவு செய்ய, பெற, எண்ண அல்லது மூட முடியாது.',
    runningAs: 'இயங்குவது',
    nextApproval: 'அடுத்த ஒப்புதலை முடிக்க',
    receive: 'பொருள் பெறு', count: 'எண்ணிக்கை', closeDay: 'நாளை முடி',
    tapAFigure: 'ஒரு எண்ணைத் தொட்டால் அந்தத் திரைக்குச் செல்லும்.', waiting: 'காத்திருக்கிறது',
    youCanClear: 'நீங்கள் முடிக்கக்கூடியவை', exceptionsLabel: 'திறந்த விதிவிலக்குகள்',
    unsentLabel: 'கிளௌடுக்கு அனுப்பப்படாதவை', tasksLabel: 'இன்றைய பணிகள்',
    approvalsLabel: 'காத்திருக்கும் ஒப்புதல்கள்', notKnown: 'தெரியவில்லை',
    salesTodayLabel: 'இன்றைய விற்பனை', boxSilent: 'கடை கணினி சொல்லவில்லை',
    needsAttention: 'கவனம் தேவை', nothingNeedsYou: 'இந்தப் பட்டியலில் இப்போது உங்கள் கவனம் தேவைப்படுவது எதுவும் இல்லை. இது இந்தப் பக்கத்தின் எண்களை மட்டுமே பார்க்கிறது — முழுக் கடையின் சோதனை அல்ல.', purchaseToShelf: 'கொள்முதலிலிருந்து அலமாரிக்கு', storeToday: 'இன்று கடை', workspaces: 'பணியிடங்கள்', screenWord: 'திரை', screensWord: 'திரைகள்', open: 'திற',
    poOpen: 'திறந்த கொள்முதல் ஆணைகள்', receiptsRecorded: 'பதிவான பெறுதல்கள்', countsAwaiting: 'ஒப்புதலுக்குக் காத்திருக்கும் எண்ணிக்கைகள்', indentsOpen: 'திறந்த தளக் கோரிக்கைகள்',
    deliveriesToday: 'இன்றைய டெலிவரிகள்', checklistOpen: 'முடிக்காத சரிபார்ப்புகள்', expiringSoon: 'விரைவில் காலாவதி', recallsOpen: 'திரும்பப்பெறல் அறிவிப்புகள்', claimDisputesOpen: 'திறந்த சர்ச்சைக்குரிய விநியோகஸ்தர் உரிமைக்கோரல்கள்',
    attnApprovals: 'நீங்கள் தீர்க்கக்கூடிய ஒப்புதல்கள்', attnHoApprovals: 'தலைமை அலுவலகத்தில் உங்களுக்காகக் காத்திருக்கும் ஒப்புதல்கள் — ஒப்புதல்கள் பக்கத்தைத் திறக்கவும்', attnExceptions: 'திறந்த விதிவிலக்குகள்', attnUnsent: 'கிளௌடுக்கு அனுப்பப்படாத பதிவுகள்', attnRecalls: 'திரும்பப்பெறல் அறிவிப்புகள்', attnClaimDisputes: 'தீர்க்க வேண்டிய சர்ச்சைக்குரிய விநியோகஸ்தர் உரிமைக்கோரல்கள் — விநியோகஸ்தர் உரிமைக்கோரல்கள் பக்கத்தைத் திறக்கவும்', attnExpiring: 'விரைவில் காலாவதியாகும் தொகுதிகள்', attnChecklist: 'முடிக்காத சரிபார்ப்புகள்', attnCounts: 'ஒப்புதலுக்குக் காத்திருக்கும் எண்ணிக்கைகள்', tillDevicesLabel: 'கல்லா சாதனங்கள்', attnTillDevices: 'செயலிழந்த அல்லது சரியாக வேலை செய்யாத கல்லா சாதனம்(கள்)',
    attnOverShort: 'இன்று கூடுதலாகவோ குறைவாகவோ மூடப்பட்ட பணப்பெட்டி(கள்) — கையொப்பம் கூடுதல் / குறைவு பக்கத்தில்', overShortNotCounted: 'இங்கு எண்ணப்படவில்லை: இன்று கூடுதலாகவோ குறைவாகவோ மூடப்பட்ட {n} பணப்பெட்டி(கள்) — கவனம் தேவை பகுதியைப் பார்க்கவும்',
    lanesTitle: 'கல்லாக்கள்', laneWord: 'கல்லா', laneAllWorking: 'எல்லாச் சாதனங்களும் வேலை செய்கின்றன', laneProblems: 'சாதனச் சிக்கல்(கள்)', laneNotReported: 'கல்லா இன்னும் தன் சாதனங்களைப் பற்றிச் சொல்லவில்லை',
    lanePrinter: 'அச்சுப்பொறி', laneScanner: 'ஸ்கேனர்', laneCard: 'கார்டு இயந்திரம்', laneLastHeard: 'கல்லா கடைசியாகச் சொன்னது', laneUnsent: 'தலைமை அலுவலகத்துக்கு இன்னும் செல்லாதவை', laneLastSync: 'தலைமை அலுவலகத்துக்குக் கடைசியாக அனுப்பியது',
    devOk: 'வேலை செய்கிறது', devDegraded: 'சரியாக வேலை செய்யவில்லை', devFailed: 'செயலிழந்தது', devNotReported: 'சொல்லப்படவில்லை', laneNever: 'ஒருபோதும் இல்லை', laneBills: 'இந்தக் கல்லாவின் பில்(கள்) அல்லது திருப்பம்(கள்)',
    nothingWaiting: 'எதுவும் காத்திருக்கவில்லை.', biggestFirst: 'பெரியது முதலில்.',
    approve: 'ஒப்புதல்', reject: 'மறு', cancel: 'ரத்து', ok: 'சரி',
    whyApprove: 'ஏன் ஒப்புதல் அளிக்கிறீர்கள்?', whyReject: 'ஏன் மறுக்கிறீர்கள்?',
    decided: 'முடிவு பதிவாகியது', requestedBy: 'கேட்டவர்', noValue: 'மதிப்பு இல்லை',
    savedHere: 'இந்தத் திரையில் சேமிக்கப்பட்டவை', savedLead: 'இந்தத் திரை சேமித்த முடிவுகள், டெலிவரிகள், எண்ணிக்கைகள் — ஒவ்வொன்றும் எங்கே உள்ளது. மறுபடியும் ஏற்றினாலும் இங்கு எதுவும் இழக்கப்படாது.',
    approvedWord: 'ஒப்புதல் அளிக்கப்பட்டது', rejectedWord: 'மறுக்கப்பட்டது', heldHere: 'சேமிக்கப்பட்டது, இணைப்பு வந்ததும் தலைமை அலுவலகத்திற்குச் செல்லும்',
    linesWord: 'வரிகள்', noOrderWord: 'கொள்முதல் ஆர்டர் இல்லை',
    read: 'இதைப் படிக்கவும்', done: 'முடிந்தது',
    deliveryNote: 'டெலிவரி நோட்டு எண்', poNumber: 'கொள்முதல் ஆர்டர் எண் (இல்லையென்றால் காலியாக விடவும்)',
    itemCode: 'பொருள் (பெயர் அல்லது குறியீடு)', howMany: 'எத்தனை', addItem: 'இந்தப் பொருளைச் சேர்',
    tempLabel: 'வந்தபோது வெப்பநிலை, °C (குளிர்/உறைந்த பொருட்கள்)',
    tempHint: 'பொருளை அளந்து அளவைத் தட்டச்சு செய்யவும், உதாரணமாக 3.5 அல்லது -18. இல்லையெனில் குளிர்/உறைந்த பொருட்கள் மேலாளர் சரிபார்க்கும் வரை விற்பனைக்கு வராது.',
    needTemp: 'வெப்பநிலை ஒரு எண்ணாக இருக்க வேண்டும், உதாரணமாக 3.5 அல்லது -18. குளிர்/உறைந்த பொருள் இல்லையெனில் காலியாக விடவும்.',
    mfgLabel: 'தயாரிப்பு மாதமும் ஆண்டும் (பொதி செய்த பொருட்கள்)', mfgHint: 'பொதியில் அச்சிட்ட மாதத்தைத் தேர்ந்தெடுங்கள். பொதி செய்த பொருளை இது இல்லாமல் சேமிக்க முடியாது.',
    needMfg: 'தயாரிப்பு மாதத்தை ஆண்டு-மாதம் என எழுதவும், உதாரணமாக 2026-09 (அல்லது முழுத் தேதி, 2026-09-14).',
    mfgRequired: 'இது பொதி செய்த பொருள்: சேர்ப்பதற்கு முன் பொதியில் அச்சிட்ட தயாரிப்பு மாதத்தையும் ஆண்டையும் தட்டச்சு செய்யவும்.',
    mfgWord: 'தயாரிப்பு',
    placeLabel: 'பொருட்களை எங்கே பதிவு செய்வது', placeStore: 'இந்தக் கடை (பில்லிங் விற்கும் அலமாரிகள்) — {id}', placeBack: 'பின் கிடங்கு — {id}', placeFromOrder: 'ஆர்டர் சொல்லும் இடம்: {place}.', placeChosenOther: 'ஆர்டர் சொல்லும் இடம் {place}; நீங்கள் வேறு இடத்தைத் தேர்ந்தெடுத்தீர்கள்.',
    orderLabel: 'இந்த டெலிவரி எந்த ஆர்டருக்கு?', orderPick: '— ஆர்டரைத் தேர்ந்தெடுங்கள் —', orderNone: 'ஆர்டர் இல்லை — ஆர்டர் இல்லாமல் வந்தது',
    orderOther: 'பட்டியலில் இல்லாத ஆர்டர் — அதன் எண்ணைத் தட்டச்சு செய்யவும்', orderItems: '{n} பொருள்(கள்) வர வேண்டியவை',
    orderAsAt: 'தலைமை அலுவலகம் கடைசியாக அனுப்பிய ஆர்டர்கள் ({at}). அதன் பிறகு வழங்கிய ஆர்டர் பட்டியலில் இல்லை: "பட்டியலில் இல்லாத ஆர்டர்" என்பதைத் தேர்ந்தெடுங்கள்.',
    chooseOrder: 'முதலில் இந்த டெலிவரி எந்த ஆர்டருக்கு என்று தேர்ந்தெடுங்கள் (அல்லது "ஆர்டர் இல்லை").',
    linesFromOrder: 'ஆர்டரின் பொருட்கள் வர வேண்டிய அளவுடன் நிரப்பப்பட்டுள்ளன. குறைவாக வந்தால் "வந்தது" என்பதை மாற்றி, சேதமானவை, பேட்ச் எண், காலாவதி தேதியை எழுதவும்.',
    dueWord: 'வர வேண்டியது', receivedLabel: 'வந்தது', damagedLabel: 'சேதமானவை', batchLabel: 'பேட்ச் எண்', expiryLabel: 'காலாவதி தேதி',
    mfgShort: 'தயாரிப்பு மாதம்', tempShort: 'வெப்பநிலை °C',
    qcFailLabel: 'தரச் சோதனையில் தோல்வி / வாசலில் மறுக்கப்பட்டது', mrpLabel: 'பொதியில் உள்ள MRP (₹)', qcFailWord: 'சோதனையில் தோல்வி', mrpWord: 'MRP ₹',
    casesLabel: '{n} கொண்ட பெட்டிகள்', caseSizeLabel: 'பொதி அளவு', looseLabel: 'தனி அலகுகள்', caseOf: '{n} கொண்ட {level}',
    casesMath: '{cases} × {n} + {loose} தனி = {total} அலகுகள்', needCases: 'பெட்டிகளும் தனி அலகுகளும் 0 அல்லது அதற்கு மேற்பட்ட முழு எண்களாக இருக்க வேண்டும்.',
    needMrp: 'பொதியில் உள்ள MRP 0-க்கு மேற்பட்ட ரூபாய்த் தொகையாக, அதிகபட்சம் 2 தசம இடங்களுடன் இருக்க வேண்டும் (உதா: 120 அல்லது 99.50).',
    needQcFail: '"தரச் சோதனையில் தோல்வி" 0 அல்லது அதற்கு மேற்பட்ட முழு எண்ணாக இருக்க வேண்டும்.',
    shortBy: '{n} குறைவு', moreBy: 'வர வேண்டியதை விட {n} அதிகம்', damagedWord: 'சேதம்', batchWord: 'பேட்ச்', expWord: 'காலாவதி',
    lineProblems: 'எதுவும் சேமிக்கப்படவில்லை. இந்த வரிகளைச் சரிபார்க்கவும்:',
    lp_expiry_not_a_date: 'காலாவதி தேதி சரியான தேதி அல்ல', lp_damaged_not_whole: 'சேதமானவை முழு எண்ணாக இருக்க வேண்டும்',
    lp_damaged_more_than_arrived: 'வந்ததை விட அதிகம் சேதம்', lp_batch_and_expiry_needed: 'இந்தப் பொருளுக்கு பேட்ச் எண்ணும் காலாவதி தேதியும் தேவை',
    lp_qc_failed_not_whole: '"தரச் சோதனையில் தோல்வி" முழு எண்ணாக இருக்க வேண்டும்', lp_set_aside_more_than_arrived: 'சேதமும் சோதனைத் தோல்வியும் சேர்ந்து வந்ததை விட அதிகம்',
    lp_mrp_not_an_amount: 'MRP 0-க்கு மேற்பட்ட தொகை அல்ல',
    needArrived: '"வந்தது" 0 அல்லது அதற்கு மேற்பட்ட முழு எண்ணாக இருக்க வேண்டும்.',
    noItemsYet: 'இன்னும் எந்தப் பொருளும் சேர்க்கப்படவில்லை.', saveDelivery: 'டெலிவரியைச் சேமி',
    remove: 'நீக்கு', needNumber: 'முதலில் டெலிவரி நோட்டு எண்ணைக் கொடுக்கவும்.',
    needLines: 'குறைந்தது ஒரு பொருளையாவது சேர்க்கவும்.', needItem: 'பொருள் குறியீடும் எண்ணிக்கையும் தேவை.',
    received: 'டெலிவரி சேமிக்கப்பட்டது',
    unmatchedWarning: 'இந்த டெலிவரிக்கு கொள்முதல் ஆர்டர் இல்லை. எனவே இன்வாய்ஸை யாரும் சரிபார்க்க முடியாது. இன்றே வாங்குபவரிடம் சொல்லவும்.',
    matchedNote: 'தலைமை அலுவலகம் அது அங்கு வந்தவுடன் ஆர்டருடனும் பொருள் விதிகளுடனும் சரிபார்க்கும்.',
    productCode: 'பொருள் (பெயர் அல்லது குறியீடு)', whereIsIt: 'எங்கே (அடுக்கு அல்லது இடம்)',
    enterCount: 'எண்ணிக்கையைப் பதிவு செய்', howManyOnShelf: 'உண்மையில் எத்தனை உள்ளன?',
    countBlindHint: 'அடுக்கில் உள்ளதை எண்ணவும். கணினியின் எண்ணிக்கையை இந்தத் திரை முதலில் காட்டாது — அது வேண்டுமென்றே.',
    whyDifferent: 'ஏன் வித்தியாசம்?', needProduct: 'பொருள் குறியீடும் இடமும் தேவை.',
    countRecorded: 'எண்ணிக்கை பதிவு செய்யப்பட்டது',
    countNote: 'வித்தியாசத்தையும் அதன் மதிப்பையும் தலைமை அலுவலகம் கணக்கிடும். பெரிய வித்தியாசம் அங்கு வேறு ஒருவரின் ஒப்புதலுக்குக் காத்திருக்கும்; அதுவரை அலமாரி எண்ணிக்கை மாறாது.',
    alreadyCounted: 'அந்த எண்ணிக்கை இந்தத் திரையில் ஏற்கனவே சேமிக்கப்பட்டுள்ளது. மீண்டும் எண்ண, புதிய எண்ணிக்கையை உள்ளிடவும்.',
    checkOpen: 'இன்னும் என்ன மீதம் உள்ளது என்று பார்', closeNow: 'இப்போது நாளை முடி',
    closedNote: 'முடிக்கப்பட்ட நாள் பூட்டப்படும். பின்னர் கண்டறியப்படுவது திருத்தமே, மாற்றம் அல்ல.',
    closePin: 'உங்கள் கடை PIN — நீங்களே உள்ளிட வேண்டும்',
    carryLead: 'கார்டு அல்லது UPI கட்டணங்கள் மட்டுமே திறந்துள்ளன. அவற்றைப் பெயருடன் தலைமை அலுவலகத்துக்கு அனுப்பி நாளை முடிக்கலாம் — இரண்டாவது நபர் தன் சொந்த PIN மூலம் ஒப்புதல் தர வேண்டும். வழங்குநர் பதில் தரும்போது நிதித் துறை ஒவ்வொன்றையும் முடிக்கும்.',
    carryApprover: 'இரண்டாவது நபர் (பெயர் அல்லது பணியாளர் எண்)', carryPin: 'அவர்களின் கடை PIN — அவர்களே உள்ளிட வேண்டும்', carryReason: 'காரணம்',
    carryProvider: 'கார்டு அல்லது UPI வழங்குநர் பதில் தரவில்லை', carryMachine: 'கார்டு இயந்திரம் பழுதாக உள்ளது',
    carryNow: 'இவற்றைத் தலைமை அலுவலகத்துக்கு அனுப்பி நாளை முடி', carryNeeds: 'மேலே உங்கள் சொந்த PIN, இரண்டாவது நபரின் பணியாளர் எண் மற்றும் அவரின் சொந்த PIN ஆகியவற்றை உள்ளிடவும்.',
    colRequest: 'கோரிக்கை', colValue: 'மதிப்பு', colDecision: 'முடிவு',
    receiveLead: 'இணைப்பு இருந்தாலும் இல்லாவிட்டாலும் இந்தத் திரையில் சேமிக்கப்படும்; கடை கணினி அதைத் தலைமை அலுவலகத்திற்கு அனுப்பும்.',
    closePinHint: 'ஆறு இலக்கங்கள் வரை. கடை கணினி இதைச் சரிபார்க்கும்; அனுப்பியவுடன் இந்தத் திரையிலிருந்து அழிக்கப்படும்.',
    carryPinHint: 'இரண்டாம் நபர் இதைத் தாமே இந்தத் திரையில் தட்டச்சு செய்ய வேண்டும்.',
    carried: 'நாள் முடிக்கப்பட்டு பூட்டப்பட்டது. வழங்குநர் பதில் தரும் வரை இந்தக் கட்டணங்கள் தலைமை அலுவலகப் பட்டியலில் இருக்கும்',
    dayClosed: 'நாள் முடிக்கப்பட்டு பூட்டப்பட்டது.', stillOpen: 'நாளை இன்னும் முடிக்க முடியாது',
    closeNamed: '{day} நாளை முடி', closeThisDay: 'இது {day} நாளை முடிக்கும் — முடிந்துவிட்ட கடைசி வியாபார நாள்.',
    runningDayWhen: 'இன்று, {day}, வியாபாரம் இன்னும் நடக்கிறது. கடையின் நாள் முடிவு நேரத்துக்குப் பிறகு, {next} {at} முதல் அதை முடிக்கலாம்.',
    readyToClose: '{day} நாளுக்கு எதுவும் திறந்திருக்கவில்லை', readyNote: 'உங்கள் கல்லா PIN-ஐ உள்ளிட்டு, "{button}" அழுத்தவும்.',
    closedNamed: '{day} முடிக்கப்பட்டு பூட்டப்பட்டது.', stillOpenNamed: '{day} நாளை இன்னும் முடிக்க முடியாது',
    andMore: 'மேலும்', whatToDo: 'என்ன செய்ய வேண்டும்',
    cardDayTitle: 'இன்றைய கார்டு மற்றும் UPI — இயந்திரத்தின் செட்டில்மென்ட் சீட்டுடன் சரிபார்க்கவும்',
    cardDayLead: 'இன்று இந்தக் கடை கணினியின் கல்லாக்களில் நடந்த ஒவ்வொரு கார்டு மற்றும் UPI கட்டணமும், கடையின் இயந்திரம் அச்சிட்ட எண்ணுடன். நாளை முடிக்கும் முன் ஒவ்வொன்றையும் இயந்திரத்தின் செட்டில்மென்ட் சீட்டுடன் சரிபார்க்கவும். கார்டு எண் ஒருபோதும் சேமிக்கப்படுவதோ காட்டப்படுவதோ இல்லை.',
    cardColTime: 'நேரம்', cardColTill: 'கல்லா', cardColKind: 'கார்டு / UPI', cardColAmount: 'தொகை', cardColRef: 'அனுமதி / அங்கீகாரக் குறியீடு / RRN', cardColBill: 'பில்',
    cardColRefundRef: 'திரும்பப் பணக் குறிப்பு எண்', cardColCheckedBy: 'சரிபார்த்தவர்', cardColRefund: 'திரும்பப் பணம்',
    cardKindCard: 'கார்டு', cardKindUpi: 'UPI',
    cardNoRef: 'எண் சேமிக்கப்படவில்லை — இயந்திரச் சீட்டைப் பார்க்கவும்', cardNoBill: 'இன்னும் பில் இல்லை',
    cardPaidTotal: 'இன்று கார்டு மற்றும் UPI மூலம் செலுத்தியது', cardRefundedTotal: 'இன்று இயந்திரத்தில் திரும்பத் தந்தது',
    cardNone: 'இன்று இந்தக் கடை கணினியில் கார்டு அல்லது UPI கட்டணம் எதுவும் இல்லை.',
    cardUnresolvedTitle: 'இயந்திரத்திடமிருந்து இன்னும் பதில் இல்லை — முடிக்கும் முன் இயந்திரத்தைப் பார்க்கவும்',
    cardRefundsTitle: 'இயந்திரத்தில் செய்யப்பட்ட திரும்பப் பணங்கள்',
    sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
    countedSoFar: 'எண்ணப்பட்டது', item: 'பொருள்',
    rcTitle: 'பெறுதல் சரிபார்ப்பு — குளிர் மற்றும் உறைந்த பொருட்கள்',
    rcWhy: 'இந்த டெலிவரியில் குளிர் அல்லது உறைந்த பொருட்கள் உள்ளன. வாசலில் ஒவ்வொரு சோதனையையும் குறிக்கவும்; அது உங்கள் பெயரில் டெலிவரியுடன் சேமிக்கப்படும்.',
    rcPass: 'சரி', rcFail: 'தவறு',
    rcAction: 'தவறுக்கு என்ன செய்யப்பட்டது (எ.கா.: பெட்டி மறுக்கப்பட்டு திருப்பி அனுப்பப்பட்டது)',
    rcNotTold: 'இந்தக் கடை கணினிக்கு பெறுதல் சரிபார்ப்புப் பட்டியல் அனுப்பப்படவில்லை. டெலிவரி சேமிக்கப்படும்; சரிபார்ப்பு இல்லை என்பதை தலைமை அலுவலகம் காணும்.',
    rcNeeded: 'முதலில் பெறுதல் சரிபார்ப்பைச் செய்யுங்கள்: ஒவ்வொரு சோதனையையும் சரி அல்லது தவறு எனக் குறிக்கவும்.',
    rcNeedAction: 'ஒரு சோதனை தவறியது. சேமிக்கும் முன் அதற்கு என்ன செய்யப்பட்டது என்று எழுதுங்கள்.',
    rcSaved: 'பெறுதல் சரிபார்ப்பு டெலிவரியுடன் சேமிக்கப்பட்டது.',
  },
};
let lang = 'en';
const t = (key) => WORDS[lang][key] ?? WORDS.en[key];

// Fix batch 3 (D-012): a trading day in words — "Friday 14 Nov" / "வெள்ளி 14 நவம்பர்" — from its date, never this device's clock.
const DAY_NAMES = {
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  ta: ['ஞாயிறு', 'திங்கள்', 'செவ்வாய்', 'புதன்', 'வியாழன்', 'வெள்ளி', 'சனி'],
};
const MONTH_NAMES = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  ta: ['ஜனவரி', 'பிப்ரவரி', 'மார்ச்', 'ஏப்ரல்', 'மே', 'ஜூன்', 'ஜூலை', 'ஆகஸ்ட்', 'செப்டம்பர்', 'அக்டோபர்', 'நவம்பர்', 'டிசம்பர்'],
};
function dayWords(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  const d = new Date(`${iso}T00:00:00Z`);
  return `${DAY_NAMES[lang][d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_NAMES[lang][d.getUTCMonth()]}`;
}
const fill = (text, vars) => text.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
/** The day the STORE COMPUTER closes if asked now, as it told this page (`managerData.dayClose`) — null with no box. */
const boxDayClose = () => {
  const dc = window.managerData && window.managerData.dayClose;
  return dc && typeof dc.closes === 'string' ? dc : null;
};
/** "Close Friday 14 Nov" — or the plain words when no store computer has said which day. */
const closeButtonWords = () => { const dc = boxDayClose(); return dc ? fill(t('closeNamed'), { day: dayWords(dc.closes) }) : t('closeNow'); };

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
  nobody_named: {
    en: { title: 'Nobody is named on this screen', todo: 'The store computer has no manager named for this screen. Ask head office to name one in the store pack; nothing can be closed until then.' },
    ta: { title: 'இந்தத் திரையில் யாரும் பெயரிடப்படவில்லை', todo: 'கடை கணினியில் இந்தத் திரைக்கு மேலாளர் பெயரிடப்படவில்லை. தலைமை அலுவலகத்தை கடைத் தொகுப்பில் ஒருவரைப் பெயரிடச் சொல்லுங்கள்; அதுவரை எதையும் மூட முடியாது.' },
  },
  items_unsent: {
    en: { title: 'item(s) have not reached the cloud', todo: 'Nothing is lost — they are saved in the store. Check the internet connection, then check again.' },
    ta: { title: 'பொருள்(கள்) கிளௌடுக்குச் செல்லவில்லை', todo: 'எதுவும் இழக்கப்படவில்லை — கடையில் சேமிக்கப்பட்டுள்ளன. இணைய இணைப்பைச் சரிபார்த்து மீண்டும் பார்க்கவும்.' },
  },
  cannot_see: {
    en: { title: 'This screen could not read one of the lists it must check', todo: 'The day must NOT be closed until it can. Tell whoever looks after the store computer.' },
    ta: { title: 'சரிபார்க்க வேண்டிய பட்டியல் ஒன்றை இந்தத் திரையால் படிக்க முடியவில்லை', todo: 'படிக்க முடியும் வரை நாளை முடிக்கக் கூடாது. கடை கணினியைப் பார்ப்பவரிடம் சொல்லவும்.' },
  },
  payments_pending: {
    en: { title: 'card or UPI payment(s) have no final answer yet', todo: 'The customer may or may not have paid. Do not run the card again. Check each payment with the provider (the till\'s Check payment button), then check again.' },
    ta: { title: 'கார்டு அல்லது UPI கட்டணம்(கள்) இன்னும் இறுதி பதில் பெறவில்லை', todo: 'வாடிக்கையாளர் பணம் செலுத்தியிருக்கலாம் அல்லது இல்லாமல் இருக்கலாம். கார்டை மீண்டும் தேய்க்க வேண்டாம். ஒவ்வொரு கட்டணத்தையும் வழங்குநரிடம் சரிபார்த்து, மீண்டும் பார்க்கவும்.' },
  },
  checklist_open: {
    en: { title: 'closing-checklist item(s) must be done before the day closes', todo: 'Do each one and tick it on the Checklists page, then check again.' },
    ta: { title: 'மூடல் பட்டியல் உருப்படி(கள்) நாள் முடியும் முன் செய்யப்பட வேண்டும்', todo: 'ஒவ்வொன்றையும் செய்து, சரிபார்ப்புப் பட்டியல்கள் பக்கத்தில் குறியிட்டு, மீண்டும் பார்க்கவும்.' },
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
  nobody_named: { en: 'Nobody is named on this screen, so no decision can be recorded against a person.', ta: 'இந்தத் திரையில் யாரும் பெயரிடப்படவில்லை, எனவே எந்த முடிவையும் ஒருவரின் பெயரில் பதிவு செய்ய முடியாது.' },
  already_decided: { en: 'This screen has already decided that request. Its decision is in the list below.', ta: 'இந்தத் திரை அந்தக் கோரிக்கையை ஏற்கனவே முடிவு செய்துவிட்டது. அதன் முடிவு கீழே உள்ள பட்டியலில் உள்ளது.' },
};

/**
 * Where a piece of work this screen saved has got to — one entry per state in the shared device-relay
 * contract (`packages/sync/device-relay` DEVICE_ITEM_STATES), guarded the same way the refusals are. These
 * are the owner's words: saved here · retrying · with the store computer · posted · refused.
 */
const STATE_WORDS = {
  // D-030: on the store PC this screen IS the store computer — what is still to happen is the trip to head office.
  saved_here: { en: 'Saved. It goes to head office when the line is up.', ta: 'சேமிக்கப்பட்டது. இணைப்பு வந்ததும் தலைமை அலுவலகத்திற்குச் செல்லும்.' },
  retrying: { en: 'Saved on this screen — the store computer could not be reached, trying again', ta: 'இந்தத் திரையில் சேமிக்கப்பட்டது — கடை கணினியை அடைய முடியவில்லை, மீண்டும் முயற்சிக்கிறது' },
  handed_to_box: { en: 'With the store computer — it will send this to head office', ta: 'கடை கணினியிடம் உள்ளது — அது இதை தலைமை அலுவலகத்திற்கு அனுப்பும்' },
  posted: { en: 'Posted at head office', ta: 'தலைமை அலுவலகத்தில் பதிவாகியது' },
  refused: { en: 'Refused — a person must look at this', ta: 'மறுக்கப்பட்டது — ஒருவர் இதைப் பார்க்க வேண்டும்' },
};

/** The kinds of work this screen saves (the model's `SAVED_WORK_KINDS`, guarded): a decision, a delivery, a count. */
const KIND_WORDS = {
  decision: { en: 'Decision', ta: 'முடிவு' },
  receipt: { en: 'Delivery', ta: 'டெலிவரி' },
  count: { en: 'Count', ta: 'எண்ணிக்கை' },
};

/** Why a queued request is not this manager's to decide (the workbench's `blockedReason`). */
const BLOCKED_WORDS = {
  own_request: { en: 'Your own request — somebody else must decide it', ta: 'உங்கள் சொந்தக் கோரிக்கை — வேறு ஒருவர் முடிவு செய்ய வேண்டும்' },
  out_of_scope: { en: 'Not your branch', ta: 'உங்கள் கிளை அல்ல' },
  exceeds_authority: { en: 'Above your approval limit — send it up', ta: 'உங்கள் ஒப்புதல் வரம்பைத் தாண்டியது — மேலே அனுப்பவும்' },
  nobody_named: { en: 'Nobody is named on this screen — it cannot decide', ta: 'இந்தத் திரையில் யாரும் பெயரிடப்படவில்லை — முடிவு செய்ய முடியாது' },
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
      manager: 'sample',
      tradingDay: 'sample',
      approvalsWaiting: { known: true, count: requests.length },
      approvalsIcanClear: { known: true, count: requests.filter((r) => r.requestedBy !== 'you').length },
      exceptions: { known: true, count: open().length },
      unsent: { known: true, count: unsent.length },
      heldHere: 0,
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
    // Sample data decides nothing durable: no device queue, so nothing to list (the real session reads its queue).
    decisions: () => [],
    handedDecisionKeys: () => [],
    noteBoxStatus: () => {},
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
    // Sample data has no store computer behind it, so the box path is off (canCloseViaBox false) and
    // the local preview close is what runs — which on sample data simply reports the blockers, closing
    // nothing. closeViaBox is never reached here; it returns a translated word, never a composed reason.
    canCloseViaBox: false,
    closeViaBox: () => Promise.resolve({ closed: false, reason: t('sampleData') }),
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
/**
 * OB-205: a thin line icon from the one set (sre-icons.js), or nothing when the set is not loaded — the words carry the
 * meaning either way; the shape only sits beside them.
 */
const lineIcon = (name, size) => (window.sreIcon && typeof window.sreIcon === 'function' ? window.sreIcon(name, size) : null);
/** A control's words with its shape in front: the words stay the control's whole text (its name). */
function worded(node, name, words) {
  const mark = lineIcon(name, 18);
  if (!mark) { node.textContent = words; return; }
  const text = document.createElement('span');
  text.textContent = words;
  node.replaceChildren(mark, text);
}

function tell(title, message, good = false) {
  // OB-205: the title wears its shape — a tick for done, the alert for anything else; the title is still its whole text.
  const mark = lineIcon(good === true ? 'circle-check' : 'circle-alert', 24);
  el('banner-title').replaceChildren(...(mark ? [mark] : []), document.createTextNode(title));
  el('banner-text').textContent = message;
  el('banner').classList.toggle('good', good === true);
  el('banner').hidden = false;
  el('banner-ok').textContent = t('ok');
  el('banner-ok').focus();
}
el('banner-ok').addEventListener('click', () => { el('banner').hidden = true; });

// ── The panel ───────────────────────────────────────────────────────────────

let sheetResolve = null;
/** OB-205: what had the focus when the drawer opened — it gets the focus back when the drawer closes, if still there. */
let sheetOpener = null;

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
  worded(el('sheet-cancel'), 'x', t('cancel'));
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

  sheetOpener = document.activeElement;
  el('sheet').hidden = false;
  // OB-205: the drawer takes the focus as it opens — its first choice, or Cancel — so the keyboard is where the eye is.
  const first = mode === 'choice' ? el('choices').querySelector('button') : el('sheet-cancel');
  if (first) first.focus();
  return new Promise((resolve) => { sheetResolve = resolve; });
}
// Escape is the drawer's Cancel: the same answer, nothing else.
el('sheet').addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el('sheet').hidden) { e.preventDefault(); closeSheet(null); } });

function closeSheet(answer) {
  el('sheet').hidden = true;
  const opener = sheetOpener;
  sheetOpener = null;
  if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
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
  el('view-home-dash').hidden = next !== 'home';
  paintTitle();
  if (next === 'home') renderHome();
  if (next === 'approvals') renderApprovals();
  if (next === 'close') resetClose();
}
for (const name of VIEWS) el(`tab-${name}`).addEventListener('click', () => show(name));

// ── Home: four figures, and every one may say it does not know ──────────────

// ── Today (UX-2b · OB-15/OB-16): the figures the store computer sent with this screen, the rail's own workspaces ──
// Every figure comes from `window.managerData.today` — built on the store computer from its pack and its own log —
// or says it is not known. The page invents nothing: no figure, no name, no screen it was not given.
/** Round A: what head office last answered for Today's approvals and purchase orders (null until it has). */
let live = null;
const todayFigures = () => (window.managerData && window.managerData.today && typeof window.managerData.today === 'object' ? window.managerData.today : null);
/** U3 (OB-699): a Today note or why-line in the reader's language — the Tamil the box sent when the screen is Tamil, else the English. */
const todayWords = (en, ta) => (lang === 'ta' && typeof ta === 'string' && ta !== '' ? ta : en);
const figureOf = (key) => { const all = todayFigures(); const f = all ? all[key] : undefined; return f && typeof f === 'object' && typeof f.known === 'boolean' ? f : { known: false, why: t('boxSilent') }; };
const amountOf = (figure) => (figure.known ? (figure.count ?? figure.value ?? 0) : null);
const railItems = () => { const nav = window.sreNavigation; return nav && Array.isArray(nav.groups) ? nav.groups.flatMap((g) => g.items ?? []) : []; };
const railItem = (id) => railItems().find((i) => i && i.id === id) ?? null;
const icon = (name) => (window.sreChrome && typeof window.sreChrome.icon === 'function' ? window.sreChrome.icon(name) : null);

/** A way to act on a row: a view of this page, or a rail link the person holds — nothing when they hold neither. */
function goLink(target) {
  if (!target) return null;
  // Batch 15: a row that opens a list on this page, or that leads to a named place on another page.
  if (target.open) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'go sre-btn'; b.textContent = t('open');
    b.addEventListener('click', () => target.open());
    return b;
  }
  if (target.href) {
    const a = document.createElement('a');
    a.className = 'go'; a.href = target.href; a.textContent = target.label ?? t('open');
    return a;
  }
  if (target.view) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'go sre-btn'; b.textContent = t('open');
    b.addEventListener('click', () => show(target.view));
    return b;
  }
  const item = railItem(target.rail);
  if (!item) return null;
  const a = document.createElement('a');
  a.className = 'go'; a.href = item.path; a.textContent = t('open');
  return a;
}

function renderAttention(floor, today) {
  const rows = [];
  // A row is the number first, then what it is — "3 approvals you can clear" — grammatical at one as at many.
  const add = (figure, labelKey, phraseKey, target) => {
    if (!figure.known) { rows.push({ tone: 'unknown', n: null, text: `${t(labelKey)}: ${t('notKnown')} — ${todayWords(figure.why, figure.whyTa)}`, target: null }); return; }
    const n = amountOf(figure);
    if (n > 0) rows.push({ tone: 'attention', n, text: t(phraseKey), target });
  };
  add(floor.approvalsIcanClear, 'approvalsLabel', 'attnApprovals', { view: 'approvals' });
  // Round A: what waits for this person at head office is decided on the Approvals page, not this one.
  if (today.hoApprovals) add(today.hoApprovals, 'approvalsLabel', 'attnHoApprovals', { rail: 'approval-requests' });
  add(floor.exceptions, 'exceptionsLabel', 'attnExceptions', { view: 'close' });
  add(floor.unsent, 'unsentLabel', 'attnUnsent', { view: 'close' });
  // D-2 (OB-773 · M14-FR-02): a drawer that closed over/short today is work for the cash office, said here with its till
  // and amount (the box's words) — it is not on the exceptions register, so it is never hidden behind "Exceptions open: 0".
  if (today.overShort && today.overShort.known && amountOf(today.overShort) > 0) {
    rows.push({ tone: 'attention', n: amountOf(today.overShort), text: `${t('attnOverShort')} (${todayWords(today.overShort.note, today.overShort.noteTa) ?? ''})`, target: { rail: 'cash-office' } });
  }
  add(today.recalls, 'recallsOpen', 'attnRecalls', { rail: 'expiry' });
  // U7 · OB-727 (owner: B): the disputed supplier claims still open, settled on Supplier claims.
  add(today.claimDisputes, 'claimDisputesOpen', 'attnClaimDisputes', { rail: 'supplier-claims' });
  add(today.expiring, 'expiringSoon', 'attnExpiring', { rail: 'expiry' });
  add(today.checklist, 'checklistOpen', 'attnChecklist', { rail: 'checklist' });
  add(today.counts, 'countsAwaiting', 'attnCounts', { rail: 'counts' });
  // Batch 15: the items at or below their reorder level — the row opens the list (head office's figures).
  if (today.lowStock) {
    const f = today.lowStock;
    if (!f.known) rows.push({ tone: 'unknown', n: null, text: `${board('lowStock')}: ${t('notKnown')} — ${f.noLevels === true ? board('noLevels') : todayWords(f.why, f.whyTa)}`, target: f.noLevels === true && railItem('buying') ? { href: `${railItem('buying').path}#reorder`, label: board('setLevels') } : null });
    else if (amountOf(f) > 0) rows.push({ tone: 'attention', n: amountOf(f), text: board('attnLowStock'), target: lowStockListOf() !== null ? { open: openLowStock } : null });
  }
  // D04-FR-05: the tills' devices — only on a box that has a till; which device and why, in the box's words.
  if (today.tillDevices) {
    const f = today.tillDevices;
    if (!f.known) rows.push({ tone: 'unknown', n: null, text: `${t('tillDevicesLabel')}: ${t('notKnown')} — ${f.why}`, target: null });
    else if (amountOf(f) > 0) rows.push({ tone: 'attention', n: amountOf(f), text: `${t('attnTillDevices')} — ${f.note ?? ''}`, target: null });
  }
  const list = el('attention');
  list.replaceChildren(...(rows.length === 0 ? [quiet(t('nothingNeedsYou'))] : rows.map((row) => {
    const li = document.createElement('li');
    li.className = row.tone;
    // OB-205: a figure the box did not give wears the "not known" shape beside its words.
    const mark = row.tone === 'unknown' ? lineIcon('circle-help', 18) : null;
    if (mark) li.append(mark);
    const text = document.createElement('span'); text.className = 'text';
    if (row.n !== null) { const b = document.createElement('b'); b.className = 'n'; b.textContent = String(row.n); text.append(b, document.createTextNode(` ${row.text}`)); } else text.textContent = row.text;
    li.append(text);
    // Batch 12 (the owner's look): a row that needs someone wears the orange "Action needed" pill — in the reader's one
    // language (batch 17 · OB-855).
    if (row.tone === 'attention') {
      const pill = document.createElement('span'); pill.className = 'pill';
      const mark = lineIcon('triangle-alert', 16);
      if (mark) pill.append(mark);
      const words = document.createElement('span'); words.textContent = board('actionNeeded');
      pill.append(words);
      li.append(pill);
    }
    const go = goLink(row.target);
    if (go) {
      li.append(go);
      // The whole row opens its screen, as the Open button does.
      li.classList.add('opens');
      li.addEventListener('click', (e) => { if (e.target !== go && !go.contains(e.target)) go.click(); });
    }
    return li;
  })));
}

// ── Batch 12 (owner, 17 Nov 2026): the owner's Today look — headline cards, the chart, the recent bills, the foot ──
// Every figure is the store computer's own (`window.managerData.todayBoard`, built from its sales log) or says why not.
const BOARD_WORDS = {
  en: {
    sales: 'Sales', bills: 'Bills', purchaseOrders: 'Purchase orders', lowStock: 'Low stock',
    vsPrevious: 'vs. {day}, by this time', noPrevious: 'No previous day yet — this computer holds no earlier day',
    noHistory: 'No previous-day figure is kept for this', noChange: 'No change', notKnown: 'Not known',
    boardSilent: 'the store computer has not sent this page its sales log',
    lowStockWhy: 'this store computer is not sent a low-stock list',
    actionNeeded: 'Action needed', salesOverview: 'Sales overview', chartToday: 'Today', chartWeek: 'This week',
    byHour: 'Hour', byDay: 'Trading day', takings: 'Takings', chartCoversToday: 'Today\'s bills on this store computer, by the shop\'s hour, before refunds',
    chartCoversWeek: 'The last days this store computer holds, before refunds — a day it does not hold is left out',
    chartNone: 'Not known — the store computer has not sent this page its sales log, so nothing is drawn.',
    recentActivity: 'Recent activity', time: 'Time', activity: 'Activity', reference: 'Reference', status: 'Status', amount: 'Amount',
    sale: 'Sale', completed: 'Completed', noBills: 'No bill has been rung on this store computer today.',
    savedHere: 'Local data saved — on this store computer', lastSynced: 'Last synced {at}', neverSynced: 'Not yet sent to head office today or before',
    syncNotKnown: 'Last synced: not known — this computer does not report it', viewReports: 'View reports', overview: 'Store overview',
    lane: 'till {lane}',
    // Batch 15
    vsYesterdayEnd: 'vs. {day}, at its end', noYesterday: 'No earlier day yet — this computer started keeping this today',
    noLevels: 'no reorder levels set yet', setLevels: 'Set reorder levels', openList: 'See the items',
    lowStockTitle: 'Low stock', lowStockLead: 'Items at or below their reorder level, on head office\'s stock figures when this computer last took them ({at}).',
    lowStockLeadNoTime: 'Items at or below their reorder level, on head office\'s stock figures.',
    lowStockNone: 'No item is at or below its reorder level.', item: 'Item', onHand: 'On hand', reorderLevel: 'Reorder level', close: 'Close',
    attnLowStock: 'items at or below their reorder level',
    goodsReceipt: 'Goods received', approval: 'Approval', writeOff: 'Write-off', priceChange: 'Price change',
    st_completed: 'Completed', st_approved: 'Approved', st_rejected: 'Rejected', st_saved_here: 'Saved here — sending', st_sent: 'Sent to head office',
    st_recorded: 'Recorded', st_needs_approval: 'Needs approval', st_on_tills: 'On the tills', noActivity: 'Nothing has happened on this store computer today yet.',
  },
  ta: {
    sales: 'விற்பனை', bills: 'பில்கள்', purchaseOrders: 'கொள்முதல் ஆணைகள்', lowStock: 'குறைந்த சரக்கு',
    vsPrevious: '{day} அன்று இதே நேரத்துடன் ஒப்பிட', noPrevious: 'முந்தைய நாள் இன்னும் இல்லை — இந்தக் கணினியில் முந்தைய நாள் இல்லை',
    noHistory: 'இதற்கு முந்தைய நாள் எண் வைக்கப்படுவதில்லை', noChange: 'மாற்றமில்லை', notKnown: 'தெரியவில்லை',
    boardSilent: 'கடைக் கணினி இந்தப் பக்கத்துக்கு விற்பனைப் பதிவை அனுப்பவில்லை',
    lowStockWhy: 'இந்தக் கடைக் கணினிக்குக் குறைந்த சரக்குப் பட்டியல் அனுப்பப்படுவதில்லை',
    actionNeeded: 'செயல்பாடு தேவை', salesOverview: 'விற்பனை நிலவரம்', chartToday: 'இன்று', chartWeek: 'இந்த வாரம்',
    byHour: 'மணி', byDay: 'வியாபார நாள்', takings: 'வரவு', chartCoversToday: 'இந்தக் கடைக் கணினியில் இன்றைய பில்கள், கடையின் மணி நேரப்படி, திருப்பித் தருவதற்கு முன்',
    chartCoversWeek: 'இந்தக் கடைக் கணினியில் உள்ள கடைசி நாட்கள், திருப்பித் தருவதற்கு முன் — இல்லாத நாள் விடப்பட்டுள்ளது',
    chartNone: 'தெரியவில்லை — கடைக் கணினி இந்தப் பக்கத்துக்கு விற்பனைப் பதிவை அனுப்பவில்லை, எனவே எதுவும் வரையப்படவில்லை.',
    recentActivity: 'சமீபத்திய செயல்பாடுகள்', time: 'நேரம்', activity: 'செயல்பாடு', reference: 'குறிப்பு எண்', status: 'நிலை', amount: 'தொகை',
    sale: 'விற்பனை', completed: 'முடிந்தது', noBills: 'இன்று இந்தக் கடைக் கணினியில் எந்தப் பில்லும் போடப்படவில்லை.',
    savedHere: 'உள்ளூர் தரவு சேமிக்கப்பட்டது — இந்தக் கடைக் கணினியில்', lastSynced: 'கடைசியாக ஒத்திசைக்கப்பட்டது {at}', neverSynced: 'தலைமை அலுவலகத்துக்கு இன்னும் அனுப்பப்படவில்லை',
    syncNotKnown: 'கடைசி ஒத்திசைவு: தெரியவில்லை — இந்தக் கணினி அதைச் சொல்வதில்லை', viewReports: 'அறிக்கைகள்', overview: 'கடை நிலவரம்',
    lane: 'முனையம் {lane}',
    vsYesterdayEnd: '{day} முடிவுடன் ஒப்பிட', noYesterday: 'முந்தைய நாள் இன்னும் இல்லை — இந்தக் கணினி இன்றுதான் இதைப் பதிவுசெய்யத் தொடங்கியது',
    noLevels: 'மறு ஆர்டர் அளவுகள் இன்னும் அமைக்கப்படவில்லை', setLevels: 'மறு ஆர்டர் அளவுகளை அமைக்கவும்', openList: 'பொருட்களைப் பார்க்கவும்',
    lowStockTitle: 'குறைந்த சரக்கு', lowStockLead: 'மறு ஆர்டர் அளவில் அல்லது அதற்குக் கீழ் உள்ள பொருட்கள் — இந்தக் கணினி கடைசியாகப் பெற்ற தலைமை அலுவலகச் சரக்குக் கணக்கின்படி ({at}).',
    lowStockLeadNoTime: 'மறு ஆர்டர் அளவில் அல்லது அதற்குக் கீழ் உள்ள பொருட்கள் — தலைமை அலுவலகச் சரக்குக் கணக்கின்படி.',
    lowStockNone: 'எந்தப் பொருளும் மறு ஆர்டர் அளவில் அல்லது அதற்குக் கீழ் இல்லை.', item: 'பொருள்', onHand: 'கையிருப்பு', reorderLevel: 'மறு ஆர்டர் அளவு', close: 'மூடு',
    attnLowStock: 'பொருட்கள் மறு ஆர்டர் அளவில் அல்லது அதற்குக் கீழ்',
    goodsReceipt: 'சரக்கு வரவு', approval: 'ஒப்புதல்', writeOff: 'தள்ளுபடி', priceChange: 'விலை மாற்றம்',
    st_completed: 'முடிந்தது', st_approved: 'ஒப்புதல் அளிக்கப்பட்டது', st_rejected: 'நிராகரிக்கப்பட்டது', st_saved_here: 'இங்கே சேமிக்கப்பட்டது — அனுப்பப்படுகிறது', st_sent: 'தலைமை அலுவலகத்துக்கு அனுப்பப்பட்டது',
    st_recorded: 'பதிவுசெய்யப்பட்டது', st_needs_approval: 'ஒப்புதல் தேவை', st_on_tills: 'கல்லாக்களில் நடைமுறையில்', noActivity: 'இன்று இந்தக் கடைக் கணினியில் இன்னும் எதுவும் நடக்கவில்லை.',
  },
};
/** A board word in a language (the reader's when not named). */
const board = (key, as) => BOARD_WORDS[as ?? lang][key] ?? BOARD_WORDS.en[key];
/** A card's name in the reader's ONE language (batch 17 · OB-855: batch 12's "English / தமிழ்" pair is gone). */
function cardLabel(key) {
  const words = document.createElement('span');
  words.className = 'kpi-label';
  words.textContent = board(key);
  return words;
}
const boardOf = () => {
  const b = window.managerData && window.managerData.todayBoard;
  return b && typeof b === 'object' && b.today && typeof b.today.takenMinor === 'number' ? b : null;
};
/** A trading day as the shop says it: "Mon 16 Nov". */
const shortDay = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString(lang === 'ta' ? 'ta-IN' : 'en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
};
/** The change line under a headline figure: an arrow and how much, or plainly why there is no comparison. */
function trendLine(now, before, previousDay, money) {
  const line = document.createElement('div');
  line.className = 'kpi-trend';
  const arrow = document.createElement('span'); arrow.className = 'arrow'; arrow.setAttribute('aria-hidden', 'true');
  const vs = document.createElement('span'); vs.className = 'vs';
  if (previousDay === null) {
    line.dataset.dir = 'none';
    arrow.textContent = '–';
    vs.textContent = before === 'no-history' ? board('noHistory') : board('noPrevious');
    line.append(arrow, vs);
    return line;
  }
  const diff = now - before;
  line.dataset.dir = diff > 0 ? 'up' : diff < 0 ? 'down' : 'same';
  arrow.textContent = diff > 0 ? '↑' : diff < 0 ? '↓' : '–';
  const by = document.createElement('span'); by.className = 'by';
  // A percentage only where the previous day had something to be a percentage of; otherwise the plain difference.
  if (diff === 0) by.textContent = board('noChange');
  else if (before > 0) by.textContent = `${diff > 0 ? '+' : '−'}${Math.round(Math.abs(diff) * 100 / before)}%`;
  else by.textContent = `${diff > 0 ? '+' : '−'}${money ? inr(Math.abs(diff)) : Math.abs(diff)}`;
  vs.textContent = board('vsPrevious').replace('{day}', shortDay(previousDay));
  line.append(arrow, by, vs);
  return line;
}
function kpiCard({ key, iconName, figure, trend, why, note, action, opens }) {
  const card = document.createElement('div');
  card.className = 'kpi';
  card.dataset.kpi = key;
  const top = document.createElement('div'); top.className = 'kpi-top sre-with-icon';
  // The round icon sits beside its words (the one set's rule: never an icon alone).
  const mark = lineIcon(iconName, 24);
  if (mark) top.append(mark);
  top.append(cardLabel(key));
  const n = document.createElement('div'); n.className = 'kpi-n';
  card.append(top, n);
  if (figure === null) {
    n.classList.add('unknown');
    n.textContent = board('notKnown');
    const p = document.createElement('p'); p.className = 'kpi-why'; p.textContent = why;
    card.append(p);
  } else {
    n.textContent = figure;
    if (trend) card.append(trend);
    // Batch 15: where the figure came from, in the box's own words (the old strip's note, now on its card).
    if (note) { const p = document.createElement('p'); p.className = 'kpi-note'; p.textContent = note; card.append(p); }
  }
  // Batch 15: a card's one way on — a link (set the reorder levels) or a button that opens its list.
  if (action) card.append(action);
  if (opens) {
    card.classList.add('opens');
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `${board(key)}: ${figure ?? board('notKnown')} — ${board('openList')}`);
    card.addEventListener('click', (e) => { if (!(e.target instanceof Element && e.target.closest('a'))) opens(); });
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); opens(); } });
  }
  return card;
}
/** Batch 15: a card's change against the last figure this computer kept for an earlier day — or plainly why there is none. */
function dailyTrend(now, previous) {
  if (previous === undefined) return trendLine(0, 'no-history', null, false);
  if (previous === null) {
    const line = document.createElement('div'); line.className = 'kpi-trend'; line.dataset.dir = 'none';
    const arrow = document.createElement('span'); arrow.className = 'arrow'; arrow.setAttribute('aria-hidden', 'true'); arrow.textContent = '–';
    const vs = document.createElement('span'); vs.className = 'vs'; vs.textContent = board('noYesterday');
    line.append(arrow, vs);
    return line;
  }
  const line = trendLine(now, previous.value, previous.tradingDay, false);
  const vs = line.querySelector('.vs');
  if (vs) vs.textContent = board('vsYesterdayEnd').replace('{day}', shortDay(previous.tradingDay));
  return line;
}
/** Batch 15: a figure where more is worse (low stock): its rise wears red, its fall green. */
function worseWhenUp(line) { line.classList.add('worse-up'); return line; }
/** Batch 15: the link to the Buying page's Reorder tab, where this person holds the Buying page; nothing otherwise. */
function reorderLink() {
  const item = railItem('buying');
  if (!item) return null;
  const a = document.createElement('a');
  a.className = 'kpi-link'; a.href = `${item.path}#reorder`; a.textContent = board('setLevels');
  return a;
}
function renderKpis(today) {
  const b = boardOf();
  const prev = b ? b.previous : null;
  const po = today.po;
  const low = today.lowStock;
  const dp = b && b.dailyPrevious && typeof b.dailyPrevious === 'object' ? b.dailyPrevious : null;
  // Batch 15: the takings from the board, else the box's own figure (the old strip's "Sales today"), with its note either way.
  const sales = today.sales;
  const salesFigure = b ? inr(b.today.takenMinor) : sales.known ? inr(amountOf(sales)) : null;
  const salesNote = sales.known ? (todayWords(sales.note, sales.noteTa) ?? '') : '';
  const lowKnown = low.known;
  el('kpis').replaceChildren(
    kpiCard({ key: 'sales', iconName: 'chart-column', figure: salesFigure, why: todayWords(sales.why, sales.whyTa) ?? board('boardSilent'), note: salesNote, trend: b ? trendLine(b.today.takenMinor, prev ? prev.takenMinor : 0, prev ? prev.tradingDay : null, true) : null }),
    kpiCard({ key: 'bills', iconName: 'receipt', figure: b ? String(b.today.bills) : null, why: board('boardSilent'), trend: b ? trendLine(b.today.bills, prev ? prev.bills : 0, prev ? prev.tradingDay : null, false) : null }),
    kpiCard({ key: 'purchaseOrders', iconName: 'package', figure: po.known ? String(amountOf(po)) : null, why: todayWords(po.why, po.whyTa) ?? board('boardSilent'), trend: po.known ? dailyTrend(amountOf(po), dp ? dp.purchaseOrdersOpen : undefined) : null }),
    kpiCard({
      key: 'lowStock', iconName: 'triangle-alert', figure: lowKnown ? String(amountOf(low)) : null,
      // "Not known — no reorder levels set yet" with the way to set them; otherwise the box's own reason.
      why: lowKnown ? '' : low.noLevels === true ? board('noLevels') : (todayWords(low.why, low.whyTa) ?? board('lowStockWhy')),
      trend: lowKnown ? worseWhenUp(dailyTrend(amountOf(low), dp ? dp.lowStock : undefined)) : null,
      action: !lowKnown && low.noLevels === true ? reorderLink() : null,
      ...(lowKnown && lowStockListOf() !== null ? { opens: openLowStock } : {}),
    }),
  );
}

// ── Batch 15: the low-stock list — head office's items at or below their reorder level, opened from the card or the row ──
function lowStockListOf() {
  const l = window.managerData && window.managerData.lowStockList;
  return l && typeof l === 'object' && Array.isArray(l.items) ? l : null;
}
function renderLowStock() {
  const list = lowStockListOf();
  el('lowstock-title').textContent = board('lowStockTitle');
  el('lowstock-close').textContent = board('close');
  if (list === null) { el('lowstock-card').hidden = true; return; }
  const at = typeof list.asAt === 'string' ? (window.sreShopDay?.dateTimeOf(list.asAt) || list.asAt) : null;
  el('lowstock-lead').textContent = at ? board('lowStockLead').replace('{at}', at) : board('lowStockLeadNoTime');
  const host = el('lowstock-rows');
  if (list.items.length === 0) {
    const p = document.createElement('p'); p.className = 'recent-none'; p.textContent = board('lowStockNone');
    host.replaceChildren(p);
    return;
  }
  const table = document.createElement('table'); table.className = 'recent lowstock';
  const head = document.createElement('tr');
  for (const [key, cls] of [['item'], ['onHand', 'money'], ['reorderLevel', 'money']]) {
    const th = document.createElement('th'); th.scope = 'col'; if (cls) th.className = cls;
    th.textContent = board(key);
    head.append(th);
  }
  const thead = document.createElement('thead'); thead.append(head);
  const body = document.createElement('tbody');
  const qty = (n, uom) => `${new Intl.NumberFormat(lang === 'ta' ? 'ta-IN' : 'en-IN').format(Number(n))}${uom ? ` ${uom}` : ''}`;
  for (const i of list.items) {
    const tr = document.createElement('tr'); tr.dataset.product = i.productId;
    const name = document.createElement('td'); name.textContent = i.name ?? i.productId;
    const held = document.createElement('td'); held.className = 'money'; held.textContent = qty(i.onHandMinor, i.uom);
    const point = document.createElement('td'); point.className = 'money'; point.textContent = qty(i.reorderPoint, i.uom);
    tr.append(name, held, point);
    body.append(tr);
  }
  table.append(thead, body);
  host.replaceChildren(table);
}
function openLowStock() {
  renderLowStock();
  el('lowstock-card').hidden = false;
  el('lowstock-card').scrollIntoView({ block: 'start' });
  el('lowstock-title').focus();
}
el('lowstock-close').addEventListener('click', () => {
  el('lowstock-card').hidden = true;
  el('kpis').querySelector('[data-kpi="lowStock"]')?.focus();
});

let chartRange = 'today';
function renderSalesChart() {
  el('chart-title').textContent = board('salesOverview');
  el('chart-today').textContent = board('chartToday');
  el('chart-week').textContent = board('chartWeek');
  el('chart-today').setAttribute('aria-pressed', String(chartRange === 'today'));
  el('chart-week').setAttribute('aria-pressed', String(chartRange === 'week'));
  const host = el('sales-chart');
  host.replaceChildren();
  const b = boardOf();
  if (!b || window.sreCharts === undefined) {
    const p = document.createElement('p'); p.className = 'chart-none'; p.textContent = board('chartNone');
    host.append(p);
    return;
  }
  let rows;
  if (chartRange === 'today') {
    // Every hour from the first bill to the last: an hour with no bill on this box took nothing on this box (its log is whole).
    const held = new Map(b.byHour.map((h) => [h.hour, h]));
    const hours = b.byHour.map((h) => Number(h.hour));
    const order = [];
    if (hours.length > 0) {
      let h = hours[0];
      for (let i = 0; i < 24; i++) { order.push(String(h).padStart(2, '0')); if (h === hours[hours.length - 1]) break; h = (h + 1) % 24; }
    }
    rows = order.map((hour) => {
      const v = held.get(hour)?.takenMinor ?? 0;
      return { key: hour, label: `${hour}:00`, value: v, text: inr(v) };
    });
  } else {
    rows = b.week.map((d) => ({ key: d.tradingDay, label: shortDay(d.tradingDay), value: d.takenMinor, text: inr(d.takenMinor), ...(d.tradingDay === b.today.tradingDay ? { mark: { en: 'today', ta: 'இன்று' } } : {}) }));
  }
  window.sreCharts.draw(host, {
    id: `sales-${chartRange}`, kind: 'columns',
    title: { en: BOARD_WORDS.en.salesOverview, ta: BOARD_WORDS.ta.salesOverview },
    covers: chartRange === 'today' ? { en: BOARD_WORDS.en.chartCoversToday, ta: BOARD_WORDS.ta.chartCoversToday } : { en: BOARD_WORDS.en.chartCoversWeek, ta: BOARD_WORDS.ta.chartCoversWeek },
    labelHeading: chartRange === 'today' ? { en: BOARD_WORDS.en.byHour, ta: BOARD_WORDS.ta.byHour } : { en: BOARD_WORDS.en.byDay, ta: BOARD_WORDS.ta.byDay },
    valueHeading: { en: BOARD_WORDS.en.takings, ta: BOARD_WORDS.ta.takings },
    rows,
  }, lang);
}
el('chart-today').addEventListener('click', () => { chartRange = 'today'; renderSalesChart(); });
el('chart-week').addEventListener('click', () => { chartRange = 'week'; renderSalesChart(); });

// Batch 15: each kind of row, its words and icon; each state, its word, icon and tone (status is always word + icon).
const ACTIVITY_KINDS = { sale: ['sale', 'receipt'], goods_receipt: ['goodsReceipt', 'truck'], approval: ['approval', 'badge-check'], write_off: ['writeOff', 'trash'], price_change: ['priceChange', 'tag'] };
const ACTIVITY_STATES = {
  completed: ['circle-check', 'done'], approved: ['circle-check', 'done'], rejected: ['x', 'bad'], saved_here: ['clock', 'pending'],
  sent: ['circle-check', 'done'], recorded: ['check', 'done'], needs_approval: ['triangle-alert', 'pending'], on_tills: ['tag', 'done'],
};
function renderRecent() {
  el('recent-title').textContent = board('recentActivity');
  const host = el('recent');
  const b = boardOf();
  const rows = b && Array.isArray(b.activity) ? b.activity : null;
  if (rows !== null) { renderActivity(host, rows); return; }
  if (!b || b.recent.length === 0) {
    const p = document.createElement('p'); p.className = 'recent-none';
    p.textContent = b ? board('noBills') : `${board('notKnown')} — ${board('boardSilent')}`;
    host.replaceChildren(p);
    return;
  }
  // Batch 17 · OB-855: every heading and word in the reader's one language.
  const cell = (tag, main, cls) => {
    const c = document.createElement(tag);
    if (cls) c.className = cls;
    c.textContent = main;
    return c;
  };
  const table = document.createElement('table'); table.className = 'recent';
  const head = document.createElement('tr');
  for (const [key, cls] of [['time'], ['activity'], ['reference'], ['status'], ['amount', 'money']]) {
    const th = cell('th', board(key), cls);
    th.scope = 'col';
    head.append(th);
  }
  const thead = document.createElement('thead'); thead.append(head);
  const body = document.createElement('tbody');
  for (const r of b.recent) {
    const tr = document.createElement('tr');
    tr.dataset.sale = r.id;
    const what = r.laneId ? ` · ${board('lane').replace('{lane}', r.laneId)}` : '';
    tr.append(
      cell('td', r.at ?? board('notKnown')),
      cell('td', `${board('sale')}${what}`),
      cell('td', r.number ?? r.id),
      cell('td', board('completed'), 'done'),
      cell('td', inr(r.totalMinor), 'money'),
    );
    body.append(tr);
  }
  table.append(thead, body);
  host.replaceChildren(table);
}

/** Batch 15: today's bills, deliveries booked in, approvals decided, write-offs and price changes — time, what, reference, status, amount. */
function renderActivity(host, rows) {
  if (rows.length === 0) {
    const p = document.createElement('p'); p.className = 'recent-none'; p.textContent = board('noActivity');
    host.replaceChildren(p);
    return;
  }
  // Batch 17 · OB-855: every heading, kind and state in the reader's one language (the state keeps its icon beside its word).
  const cell = (tag, main, cls) => {
    const c = document.createElement(tag);
    if (cls) c.className = cls;
    c.textContent = main;
    return c;
  };
  const table = document.createElement('table'); table.className = 'recent';
  const head = document.createElement('tr');
  for (const [key, cls] of [['time'], ['activity'], ['reference'], ['status'], ['amount', 'money']]) {
    const th = cell('th', board(key), cls);
    th.scope = 'col';
    head.append(th);
  }
  const thead = document.createElement('thead'); thead.append(head);
  const body = document.createElement('tbody');
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.dataset.kind = r.kind;
    if (r.kind === 'sale') tr.dataset.sale = r.id;
    const [kindKey, kindIcon] = ACTIVITY_KINDS[r.kind] ?? ['activity', 'activity'];
    const what = document.createElement('td'); what.className = 'what sre-with-icon';
    const mark = lineIcon(kindIcon, 18);
    if (mark) what.append(mark);
    const words = document.createElement('span');
    const detail = lang === 'ta' ? (r.detailTa ?? r.detail) : r.detail;
    words.textContent = `${board(kindKey)}${detail ? ` · ${detail}` : ''}`;
    what.append(words);
    const [stateIcon, tone] = ACTIVITY_STATES[r.status] ?? ['circle-help', 'pending'];
    const state = document.createElement('td'); state.className = `state ${tone}`;
    const stateWords = document.createElement('span'); stateWords.className = 'sre-with-icon';
    const sMark = lineIcon(stateIcon, 16);
    if (sMark) stateWords.append(sMark);
    stateWords.append(document.createTextNode(board(`st_${r.status}`)));
    state.append(stateWords);
    tr.append(
      cell('td', r.at ?? board('notKnown')),
      what,
      cell('td', r.reference),
      state,
      cell('td', typeof r.amountMinor === 'number' ? inr(r.amountMinor) : '—', 'money'),
    );
    body.append(tr);
  }
  table.append(thead, body);
  host.replaceChildren(table);
}

function renderFoot() {
  const foot = el('today-foot');
  const b = boardOf();
  if (!b) { foot.replaceChildren(); foot.hidden = true; return; }
  foot.hidden = false;
  const part = (iconName, text, unknown) => {
    const s = document.createElement('span');
    if (unknown) s.className = 'unknown';
    const mark = lineIcon(iconName, 18);
    if (mark) s.append(mark);
    s.append(document.createTextNode(text));
    return s;
  };
  const synced = !('lastSentAt' in b)
    ? part('circle-help', board('syncNotKnown'), true)
    : b.lastSentShop
      ? part('refresh-cw', board('lastSynced').replace('{at}', b.lastSentShop), false)
      : part('clock', board('neverSynced'), true);
  // OB-840 · P-08: the remote link, in the store computer's own words — connected; not connected since <time>; turned off.
  const link = window.sreRemoteLink;
  const remote = link && typeof link === 'object' && typeof link.en === 'string'
    ? part(link.state === 'connected' ? 'globe' : link.state === 'off' ? 'circle-help' : 'clock', String(link[lang] ?? link.en), link.state !== 'connected')
    : null;
  foot.replaceChildren(part('check', board('savedHere'), false), synced, ...(remote === null ? [] : [remote]));
}

/** The secondary action: the reports, where the rail offers this person a reports screen; nothing otherwise. */
function renderReportsLink() {
  const a = el('today-reports');
  const item = railItem('reporting') ?? railItems().find((i) => i && typeof i.path === 'string' && /report/.test(i.path)) ?? null;
  a.hidden = item === null;
  if (item) {
    a.href = item.path;
    const mark = lineIcon('chart-column', 18);
    a.replaceChildren(...(mark ? [mark] : []), document.createTextNode(board('viewReports')));
  }
}

/** The page's one heading follows the tab, in the reader's ONE language: "Today" or "இன்று" (batch 17 · OB-855). */
const TITLE_KEYS = { home: 'today', approvals: 'approvals', receive: 'receive', count: 'count', close: 'closeDay' };
function paintTitle() {
  const key = TITLE_KEYS[view] ?? 'today';
  el('who').firstChild.textContent = `${t(key)} `;
}
/** "Tue 17 Nov 2026" for a trading day; anything that is not a date is shown as it came. */
const longDay = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(String(iso)) ? `${shortDay(iso)} ${String(iso).slice(0, 4)}` : String(iso));

function renderBoard(today) {
  renderKpis(today);
  renderLowStock(); // Batch 15: kept current while open
  renderSalesChart();
  renderRecent();
  renderFoot();
  renderReportsLink();
}
// W1: the empty list wears the shared "nothing yet" state (sreOffice) — its words say what the list covers, so it is
// never read as an all-clear for the whole store (P-08).
function quiet(text) {
  const li = document.createElement('li'); li.className = 'quiet';
  if (window.sreOffice) li.append(window.sreOffice.state(null, 'empty', { title: text, detail: '' })); else li.textContent = text;
  return li;
}

/** A small figure box: the number (or "Not known" and why), its label, its note, and a way in when there is one. */
function figureBox(tag, figure, label, target, opts = {}) {
  const box = document.createElement(tag);
  if (tag !== 'li') box.className = 'op';
  // Batch 15: the figures the old dark strip carried live here now — each names itself for the page's own checks.
  if (opts.key) box.dataset.figure = opts.key;
  if (opts.attentionWhen && figure.known && opts.attentionWhen(amountOf(figure))) box.classList.add('attention');
  if (!figure.known) box.classList.add('unknown');
  const n = document.createElement('b'); n.className = 'n';
  if (figure.known) n.textContent = String(amountOf(figure)); else { n.textContent = t('notKnown'); n.classList.add('unknown'); }
  const l = document.createElement('span'); l.className = 'l'; l.textContent = label;
  // U3 (OB-699) · U7: the box's note or reason in the reader's language — the Tamil it sent, else the English.
  const note = document.createElement('span'); note.className = 'note'; note.textContent = figure.known ? (opts.note ?? todayWords(figure.note, figure.noteTa) ?? '') : todayWords(figure.why, figure.whyTa);
  box.append(n, l, note);
  const go = goLink(target);
  if (go) box.append(go);
  return box;
}
function renderFlow(today) {
  el('flow').replaceChildren(
    figureBox('li', today.po, t('poOpen'), { rail: 'buying' }),
    figureBox('li', today.receipts, t('receiptsRecorded'), { rail: 'goods-receipt' }),
    figureBox('li', today.counts, t('countsAwaiting'), { rail: 'counts' }),
    figureBox('li', today.indents, t('indentsOpen'), { rail: 'indents' }),
  );
}
function renderOps(floor, today) {
  el('ops').replaceChildren(
    // Batch 15: the old dark strip's day figures — approvals, exceptions, what is not yet at head office — first, each one tap
    // from its list; "Sales today" is on the Sales card and "Tasks today" stays below.
    figureBox('div', today.approvalsWaiting, t('approvalsLabel'), { view: 'approvals' }, { key: 'approvals', note: today.approvalsNote, attentionWhen: (n) => n > 0 }),
    figureBox('div', floor.exceptions, t('exceptionsLabel'), { view: 'close' }, { key: 'exceptions', attentionWhen: (n) => n > 0, ...(today.overShortNote ? { note: today.overShortNote } : {}) }),
    figureBox('div', floor.unsent, t('unsentLabel'), { view: 'close' }, { key: 'unsent', attentionWhen: (n) => n > 0, ...(floor.heldHere > 0 ? { note: `${floor.heldHere} ${t('heldHere')}` } : {}) }),
    figureBox('div', today.deliveries, t('deliveriesToday'), null),
    figureBox('div', today.checklist, t('checklistOpen'), { rail: 'checklist' }),
    figureBox('div', today.expiring, t('expiringSoon'), { rail: 'expiry' }),
    figureBox('div', today.recalls, t('recallsOpen'), { rail: 'expiry' }),
    figureBox('div', today.claimDisputes, t('claimDisputesOpen'), { rail: 'supplier-claims' }),
    figureBox('div', floor.tasks, t('tasksLabel'), null, { key: 'tasks' }),
  );
}
function renderWorkspaces() {
  const nav = window.sreNavigation;
  const groups = nav && Array.isArray(nav.groups) ? nav.groups.filter((g) => Array.isArray(g.items) && g.items.length > 0) : [];
  el('ws-card').hidden = groups.length === 0;
  const lang = document.documentElement.lang === 'ta' ? 'ta' : 'en';
  const word = (pair) => (pair && typeof pair === 'object' ? (pair[lang] ?? pair.en ?? '') : String(pair ?? ''));
  el('workspaces').replaceChildren(...groups.map((g) => {
    const a = document.createElement('a');
    a.href = g.items[0].path;
    const ic = document.createElement('span'); ic.className = 'ic'; ic.setAttribute('aria-hidden', 'true');
    const mark = icon(g.group && typeof g.group === 'object' ? g.group.en : g.group);
    if (mark) ic.append(mark);
    const words = document.createElement('span');
    const b = document.createElement('b'); b.textContent = word(g.group);
    const small = document.createElement('small'); small.textContent = `${g.items.length} ${t(g.items.length === 1 ? 'screenWord' : 'screensWord')}`;
    words.append(b, small);
    a.append(ic, words);
    return a;
  }));
}
// ── OB-392 · M12-FR-04: lane health on Today, one tap per lane ────────────────────────────────────────────────────
// Every lane the store computer knows (`window.managerData.lanes`): its printer, scanner and card machine as the till last
// said, when it last said so, what from it is still not at head office, and when the box last sent to head office. A
// device the till never reported reads "Not reported", never "Working" (P-08). One tap on a lane opens it; another closes.
let openLane = null;
const lanesOf = () => (window.managerData && Array.isArray(window.managerData.lanes) ? window.managerData.lanes : null);
const shopTime = (s) => (typeof s === 'string' && s !== '' ? s.replace('T', ' ') : null);
function deviceWords(d) {
  if (d === null || d === undefined) return { text: t('devNotReported'), iconName: 'circle-help' };
  const word = d.state === 'ok' ? t('devOk') : d.state === 'failed' ? t('devFailed') : t('devDegraded');
  return { text: d.detail ? `${word} — ${d.detail}` : word, iconName: d.state === 'ok' ? 'circle-check' : 'triangle-alert' };
}
function renderLanes() {
  const lanes = lanesOf();
  el('lanes-card').hidden = lanes === null || lanes.length === 0;
  el('lanes-title').textContent = t('lanesTitle');
  if (lanes === null) { el('lanes').replaceChildren(); return; }
  el('lanes').replaceChildren(...lanes.flatMap((lane, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = `lane-${i}`;
    btn.dataset['lane'] = lane.laneId;
    const notReported = lane.lastReportAt === null;
    btn.className = `lane ${notReported ? 'unknown' : lane.problems > 0 ? 'attention' : ''}`;
    btn.setAttribute('aria-expanded', String(openLane === lane.laneId));
    btn.setAttribute('aria-controls', `lane-detail-${i}`);
    const mark = lineIcon('monitor', 18);
    if (mark) btn.append(mark);
    const name = document.createElement('b'); name.textContent = `${t('laneWord')} ${lane.laneId}`;
    const sum = document.createElement('span'); sum.className = 'sum';
    sum.textContent = notReported ? t('laneNotReported') : lane.problems > 0 ? `${lane.problems} ${t('laneProblems')}` : t('laneAllWorking');
    btn.append(name, sum);
    btn.addEventListener('click', () => { openLane = openLane === lane.laneId ? null : lane.laneId; renderLanes(); });
    const detail = document.createElement('dl');
    detail.className = 'lane-detail';
    detail.id = `lane-detail-${i}`;
    detail.hidden = openLane !== lane.laneId;
    const row = (iconName, label, text) => {
      const div = document.createElement('div');
      const ic = lineIcon(iconName, 16);
      if (ic) div.append(ic);
      const dt = document.createElement('dt'); dt.textContent = label;
      const dd = document.createElement('dd'); dd.textContent = text;
      div.append(dt, dd);
      return div;
    };
    const devices = lane.devices ?? {};
    const printer = deviceWords(devices.printer); const scanner = deviceWords(devices.scanner); const card = deviceWords(devices.card_terminal);
    detail.append(
      row(printer.iconName === 'circle-check' ? 'receipt' : printer.iconName, t('lanePrinter'), printer.text),
      row(scanner.iconName === 'circle-check' ? 'scan-barcode' : scanner.iconName, t('laneScanner'), scanner.text),
      row(card.iconName === 'circle-check' ? 'wallet' : card.iconName, t('laneCard'), card.text),
      row('clock', t('laneLastHeard'), shopTime(lane.lastReportShop) ?? t('laneNever')),
      row('send', t('laneUnsent'), `${lane.unsent} ${t('laneBills')}`),
      row('refresh-cw', t('laneLastSync'), lane.boxLastSentShop === undefined ? `${t('notKnown')} — ${t('boxSilent')}` : (shopTime(lane.boxLastSentShop) ?? t('laneNever'))),
    );
    return [btn, detail];
  }));
}

function paintTodayWords() {
  el('attention-title').textContent = t('needsAttention');
  el('flow-title').textContent = t('purchaseToShelf');
  el('ops-title').textContent = t('storeToday');
  el('ws-title').textContent = t('workspaces');
}

function renderHome() {
  const floor = session.floor();
  el('day').textContent = `${t('tradingDay')} ${longDay(floor.tradingDay)}`;
  // Who this screen runs as, said in the header; and when the store named nobody, the strip says so (hard rule #4).
  // OB-16: the person's NAME when the store computer sent one with the menu (the rail says the same); the id otherwise.
  const named = globalThis.sreNavigation && globalThis.sreNavigation.person && typeof globalThis.sreNavigation.person.name === 'string' && globalThis.sreNavigation.userId === floor.manager ? globalThis.sreNavigation.person.name : null;
  el('whoami').textContent = floor.manager === null ? '' : `${t('runningAs')} ${named ?? floor.manager}`;
  el('nobody').hidden = floor.manager !== null;
  el('nobody').textContent = floor.manager === null ? t('nobodyNamed') : '';
  const clearable = floor.approvalsIcanClear;
  // Round A (screen gap audit): once head office has answered, its approvals and open orders are counted with the store
  // computer's own — in the reader's language, each tile saying where its number came from (or that head office was not
  // reached). Before it answers, or with no bundle, the store computer's figures stand alone.
  const liveFigures = live !== null && window.todayLive
    ? window.todayLive.figures({ approvalsWaiting: floor.approvalsWaiting, approvalsIcanClear: clearable, purchaseOrdersOpen: figureOf('purchaseOrdersOpen') }, live, lang)
    : null;
  const allClearable = liveFigures ? liveFigures.approvalsIcanClear : clearable;
  const today = {
    sales: figureOf('salesToday'), po: liveFigures ? liveFigures.purchaseOrdersOpen : figureOf('purchaseOrdersOpen'), receipts: figureOf('receiptsRecorded'), indents: figureOf('indentsOpen'),
    hoApprovals: liveFigures ? liveFigures.headOffice : null,
    counts: figureOf('countsAwaitingApproval'), expiring: figureOf('expiringSoon'), recalls: figureOf('recallsOpen'), checklist: figureOf('checklistOpen'), deliveries: figureOf('deliveriesToday'), claimDisputes: figureOf('supplierClaimDisputes'),
    tillDevices: todayFigures() && todayFigures().tillDevices ? figureOf('tillDevices') : null,
    lowStock: figureOf('lowStock'), // Batch 15
    // D-2: only on a store computer that keeps a till-cash log.
    // D-009: a drawer head office says is signed off on Cash over/short is left out (the box's figure stands when it cannot tell).
    overShort: todayFigures() && todayFigures().drawersOverShortToday
      ? (window.todayLive && typeof window.todayLive.overShort === 'function' ? window.todayLive.overShort(figureOf('drawersOverShortToday'), live) : figureOf('drawersOverShortToday'))
      : null,
  };
  const overShortToday = today.overShort && today.overShort.known ? amountOf(today.overShort) : 0;
  // Batch 15: the old dark strip is gone — its figures live on the cards: Sales on the Sales card, the rest on Store today.
  today.approvalsWaiting = liveFigures ? liveFigures.approvalsWaiting : floor.approvalsWaiting;
  today.approvalsNote = [liveFigures?.approvalsWaiting.note, allClearable.known ? `${allClearable.count} ${t('youCanClear')}` : ''].filter(Boolean).join(' · ');
  // D-2: a 0 beside a drawer that closed short is not an all-clear — the exceptions figure says what it leaves out.
  today.overShortNote = overShortToday > 0 ? t('overShortNotCounted').replace('{n}', String(overShortToday)) : '';
  paintTodayWords();
  renderAttention(floor, today);
  renderFlow(today);
  renderOps(floor, today);
  renderLanes(); // OB-392
  renderWorkspaces();
  renderBoard(today); // Batch 12: the owner's look
  // The one primary action on the home screen (store-manager.md: "clear the next approval or exception"). Shown
  // only when there IS one this manager may clear — a primary button that leads nowhere teaches people to ignore
  // primary buttons. From here a decision is three taps: this, Approve (or Reject), the reason.
  const next = el('next-approval');
  next.hidden = !(clearable.known && clearable.count > 0);
  next.textContent = `${t('nextApproval')} (${clearable.known ? clearable.count : 0})`;

  // The link to the store is the same fact as "could I read the registers", so the badge says it.
  window.sreBlind = [floor.approvalsWaiting, floor.exceptions, floor.unsent].some((f) => !f.known);
  window.sreChrome?.repaint();
}

// ── The sync badge is the chrome's (sre-chrome.js). This page adds the one fact only it knows: whether it
// could read its own registers. Not being able to is the same fact as "not connected to the store".

el('next-approval').addEventListener('click', () => {
  show('approvals');
  // Land on the first decision this manager can take, so the next tap IS the decision.
  const first = el('approval-rows').querySelector('.row-actions button');
  if (first) first.focus();
});

// ── The approval inbox ──────────────────────────────────────────────────────

function renderApprovals() {
  const queue = session.approvalQueue();
  if (!queue.known) {
    // An empty list and an unreadable one look identical. Only one of them means "nothing to do".
    el('approval-rows').replaceChildren();
    el('approvals-empty').hidden = false;
    stateBlock(el('approvals-empty'), 'unknown', `${t('notKnown')} — ${queue.why}`);
    return;
  }
  el('approvals-empty').hidden = queue.rows.length > 0;
  stateBlock(el('approvals-empty'), 'empty', t('nothingWaiting'));

  el('approval-rows').replaceChildren(...queue.rows.map((row) => {
    const box = document.createElement('div');
    box.className = 'row';

    const what = document.createElement('div');
    what.className = 'what';
    what.textContent = `${words(SUBJECT_WORDS, row.request.subjectType)} · ${row.request.subjectRef}`;

    const value = document.createElement('div');
    value.className = row.request.value ? 'value' : 'value none';
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
        button.className = `${cls} sre-btn${cls === 'primary' ? ' sre-btn-primary' : cls === 'danger' ? ' sre-btn-danger' : ''}`;
        button.textContent = label;
        button.addEventListener('click', () => decide(row.request, decision));
        actions.appendChild(button);
      }
      box.appendChild(actions);
    } else {
      // Never a button that will fail on submit. The reason is the whole row's message.
      const blocked = document.createElement('div');
      blocked.className = 'blocked sre-with-icon';
      const mark = lineIcon('lock', 16);
      if (mark) blocked.append(mark);
      blocked.append(document.createTextNode(words(BLOCKED_WORDS, row.blockedReason)));
      box.appendChild(blocked);
    }
    return box;
  }));
  renderSavedWork();
}

/**
 * Everything this screen saved and where each item has got to (SP-2a · SP-2b · F11): decisions, deliveries and
 * counts alike, read from the DURABLE device queue, so the list is the same after a reload — the proof the work
 * was not lost with the tab. Each row carries one of the five state words; a refusal carries its reason, because
 * a person has to act on it. A count row shows what was COUNTED, never what was expected (the count stays blind).
 */
function renderSavedWork() {
  const saved = typeof session.savedWork === 'function' ? session.savedWork() : [];
  el('saved-title').hidden = saved.length === 0;
  el('saved-lead').hidden = saved.length === 0;
  el('saved-rows').replaceChildren(...saved.map((w) => {
    const box = document.createElement('div');
    box.className = `row saved ${w.kind}`;
    box.dataset.state = w.state;
    box.dataset.kind = w.kind;
    box.dataset.id = w.id;

    const what = document.createElement('div');
    what.className = 'what';
    what.textContent = `${words(KIND_WORDS, w.kind)} · ${w.what} — ${detailOf(w)}`;

    const state = document.createElement('div');
    state.className = `pill ${w.state} sre-with-icon`;
    const mark = lineIcon(STATE_SHAPES[w.state] ?? 'clock', 16);
    if (mark) state.append(mark);
    state.append(document.createTextNode(words(STATE_WORDS, w.state)));

    box.append(what, state);
    if (w.reason) {
      const why = document.createElement('div');
      why.className = 'blocked';
      why.textContent = w.reason;
      box.appendChild(why);
    }
    return box;
  }));
}

/** OB-205: each saved state's shape from the one set, beside its word (posted is done; refused needs a person). */
const STATE_SHAPES = { posted: 'circle-check', refused: 'circle-alert', retrying: 'refresh-cw', saved_here: 'clock', handed_to_box: 'clock' };

/** OB-205: an empty or not-known list as a block — the shape and the words; "not known" is never drawn like "nothing". */
function stateBlock(node, kind, words_) {
  node.className = kind === 'unknown' ? 'state-block unknown' : 'state-block';
  const mark = lineIcon(kind === 'unknown' ? 'circle-help' : 'circle-check', 24);
  const text = document.createElement('span');
  text.textContent = words_;
  node.replaceChildren(...(mark ? [mark] : []), text);
}

/** The second line of a saved-work row, in the reader's language. */
function detailOf(w) {
  if (w.kind === 'decision') return w.detail === 'approved' ? t('approvedWord') : t('rejectedWord');
  if (w.kind === 'receipt') {
    // The model gives "<n> · <po>" or "<n> · no purchase order"; say it in words.
    const [n, po] = w.detail.split(' · ');
    return `${n} ${t('linesWord')} · ${po === 'no purchase order' ? t('noOrderWord') : po}`;
  }
  return w.detail;
}

/**
 * Hand this screen's saved work to the store computer and learn where it has got to (SP-2a). The relay is the
 * composition root's (`window.managerRelay`), present only when the box told this screen where its socket is.
 * Called after every decision and on a slow timer; never blocks a tap, and a box that cannot be reached leaves
 * everything saved here and says so through the state words.
 */
async function syncToBox() {
  void syncFiles(); // batch 20e: the photos and scans go on their own queue, one file at a time
  const relay = window.managerRelay;
  if (!relay) return;
  try {
    await relay.syncNow();
  } catch {
    /* the queue is untouched; the state words say "saved here" */
  }
  if (view === 'approvals') renderSavedWork();
  if (view === 'home') renderHome();
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
    // Said only once it is in the durable queue (the session enqueues BEFORE it answers ok), with WHERE it is —
    // "saved on this screen" until the store computer takes it, never a bare "decided" (P-08).
    const queued = session.savedWork().find((w) => w.kind === 'decision' && w.id === request.id);
    const where = queued === undefined ? '' : ` — ${words(STATE_WORDS, queued.state)}`;
    tell(t('decided'), `${words(SUBJECT_WORDS, request.subjectType)} · ${request.subjectRef}${where}`, true);
    void syncToBox();
  } else {
    // The refusal names a rule, so it is shown in words rather than swallowed or printed as a
    // code — a screen that quietly did nothing would have a manager tapping the button harder.
    tell(t('read'), words(REFUSAL_WORDS, outcome.refusal));
  }
  renderApprovals();
}

// ── Receiving ───────────────────────────────────────────────────────────────

let receiptLines = [];

/**
 * OB-172: the receiving checklist, shown once a chilled, frozen or raw-meat item is on the delivery (head office's product
 * master says which, through the store computer — no network needed). One Pass / Fail pair per check, and a box for what
 * was done when any check fails. Nothing is decided here: the session judges it by head office's own rule when it saves.
 */
let checklistAnswers = {};
function receivingSetup() {
  return session && typeof session.receivingChecklist === 'function' ? session.receivingChecklist() : undefined;
}
function coldOnDelivery() {
  return session && typeof session.coldChainAmong === 'function' ? session.coldChainAmong(receiptLines.map((l) => l.productId)) : [];
}
function renderChecklist() {
  const setup = receivingSetup();
  const check = setup && setup.checks.length > 0 ? setup.checks[0] : undefined;
  const cold = coldOnDelivery();
  const show = check !== undefined && cold.length > 0;
  el('receive-checklist').hidden = !show;
  el('receive-checklist-missing').hidden = !(setup === undefined && receiptLines.some((l) => l.temperatureC !== undefined));
  if (!show) return;
  el('receive-checklist-title').textContent = check.title ? `${t('rcTitle')} · ${check.title}` : t('rcTitle');
  el('receive-checklist-why').textContent = `${t('rcWhy')} (${cold.join(', ')})`;
  el('receive-checklist-items').replaceChildren(...check.items.map((item) => {
    const row = document.createElement('div');
    row.className = 'rc-row';
    row.setAttribute('role', 'radiogroup');
    const name = document.createElement('span');
    name.id = `rc-label-${item.itemId}`;
    name.textContent = item.label;
    row.setAttribute('aria-labelledby', name.id);
    row.append(name);
    for (const result of ['pass', 'fail']) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = `rc-${item.itemId}`;
      input.value = result;
      input.dataset.item = item.itemId;
      input.checked = checklistAnswers[item.itemId] === result;
      input.addEventListener('change', () => { checklistAnswers[item.itemId] = result; renderChecklist(); });
      label.append(input, document.createTextNode(` ${t(result === 'pass' ? 'rcPass' : 'rcFail')}`));
      row.append(label);
    }
    return row;
  }));
  const anyFail = check.items.some((i) => checklistAnswers[i.itemId] === 'fail');
  el('receive-checklist-action-field').hidden = !anyFail;
  el('receive-checklist-action-label').textContent = t('rcAction');
}

// Batch 20a · R7: the cases and loose units typed for a line, kept beside it (never sent — the receipt records units only).
const casesOf = new WeakMap();
function renderLines() {
  renderChecklist();
  renderFileItems(); // batch 20e: a damage photo names one of the delivery's items
  el('receive-empty').hidden = receiptLines.length > 0;
  const nameOf = (id) => (session && typeof session.productName === 'function' ? session.productName(id) : id);
  const packedIds = session && typeof session.packedAmong === 'function' ? session.packedAmong(receiptLines.map((l) => l.productId)) : [];
  const coldIds = coldOnDelivery();
  el('receive-lines').replaceChildren(...receiptLines.map((line, index) => {
    const row = document.createElement('div');
    row.className = 'line-row';
    row.dataset.productId = line.productId;
    const name = document.createElement('span');
    name.textContent = nameOf(line.productId);
    const qty = document.createElement('span');
    qty.className = 'q';
    qty.textContent = [
      line.dueMinor === undefined ? String(line.quantityMinor) : `${line.quantityMinor} / ${line.dueMinor} ${t('dueWord')}`,
      line.temperatureC === undefined ? '' : `${line.temperatureC} °C`,
      line.manufacturedOn === undefined ? '' : `${t('mfgWord')} ${line.manufacturedOn}`,
      line.damagedMinor ? `${line.damagedMinor} ${t('damagedWord')}` : '',
      line.qcFailedMinor ? `${line.qcFailedMinor} ${t('qcFailWord')}` : '',
      line.mrpMinor ? `${t('mrpWord')}${(line.mrpMinor / 100).toFixed(2)}` : '',
      line.batchId ? `${t('batchWord')} ${line.batchId}` : '',
      line.expiry ? `${t('expWord')} ${line.expiry}` : '',
    ].filter((x) => x !== '').join(' · ');
    const remove = document.createElement('button'); remove.classList.add('sre-btn');
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `${t('remove')} ${nameOf(line.productId)}`);
    remove.addEventListener('click', () => { receiptLines.splice(index, 1); renderLines(); });
    row.append(name, qty, remove);
    // Fix batch 4b · D-029: what arrived, how many damaged, the batch and the expiry date — on the line itself, so an order's
    // lines (filled in from the order) are completed in place. The session judges them again when the delivery is saved.
    const edit = document.createElement('div');
    edit.className = 'line-edit';
    const box = (cls, labelKey, type, value, onChange, attrs, labelWords) => {
      const label = document.createElement('label');
      const span = document.createElement('span'); span.textContent = labelWords ?? t(labelKey);
      const input = document.createElement('input');
      input.type = type; input.className = cls; input.dataset.index = String(index); input.value = value ?? '';
      for (const [k, v] of Object.entries(attrs ?? {})) input.setAttribute(k, v);
      input.addEventListener('change', () => { onChange(input.value.trim()); renderLines(); });
      label.append(span, input);
      return label;
    };
    // Batch 20a · R7 (M07-FR-01 · M03-FR-02): an item head office gave case sizes is counted as "cases × pack size" plus loose
    // units — the line still records UNITS (Arrived is worked out and shown). Typing Arrived directly clears the cases.
    const sizes = session && typeof session.casePacksOf === 'function' ? session.casePacksOf(line.productId) : [];
    const byCase = casesOf.get(line);
    const size = sizes.find((z) => z.level === byCase?.level) ?? sizes[0];
    const applyCases = (next) => {
      const total = session.unitsFromCases(next.cases, size.units, next.loose);
      if (total === undefined) { tell(t('read'), t('needCases')); return; }
      casesOf.set(line, { ...next, level: size.level });
      line.quantityMinor = total;
    };
    const caseBoxes = size === undefined ? [] : [
      ...(sizes.length > 1 ? [(() => {
        const label = document.createElement('label');
        const span = document.createElement('span'); span.textContent = t('caseSizeLabel');
        const select = document.createElement('select');
        select.className = 'case-size'; select.dataset.index = String(index);
        select.replaceChildren(...sizes.map((z) => { const o = document.createElement('option'); o.value = z.level; o.textContent = fill(t('caseOf'), { level: z.level, n: String(z.units) }); return o; }));
        select.value = size.level;
        select.addEventListener('change', () => { const cur = casesOf.get(line) ?? { cases: 0, loose: 0 }; casesOf.set(line, { ...cur, level: select.value }); const z = sizes.find((x) => x.level === select.value); if (z && cur.cases !== undefined) { const total = session.unitsFromCases(cur.cases, z.units, cur.loose); if (total !== undefined) line.quantityMinor = total; } renderLines(); });
        label.append(span, select);
        return label;
      })()] : []),
      box('cases', 'casesLabel', 'number', byCase ? String(byCase.cases) : '', (v) => {
        const cases = v === '' ? 0 : Number(v);
        applyCases({ cases, loose: byCase?.loose ?? 0 });
      }, { min: '0', step: '1', inputmode: 'numeric' }, fill(t('casesLabel'), { n: String(size.units) })),
      box('loose', 'looseLabel', 'number', byCase ? String(byCase.loose) : '', (v) => {
        const loose = v === '' ? 0 : Number(v);
        applyCases({ cases: byCase?.cases ?? 0, loose });
      }, { min: '0', step: '1', inputmode: 'numeric' }),
    ];
    edit.append(
      ...caseBoxes,
      box('arrived', 'receivedLabel', 'number', String(line.quantityMinor), (v) => {
        const n = Number(v);
        if (v === '' || !Number.isInteger(n) || n < 0) { tell(t('read'), t('needArrived')); return; }
        line.quantityMinor = n;
        casesOf.delete(line); // typed in units: the cases no longer say it
      }, { min: '0', step: '1', inputmode: 'numeric' }),
      box('damaged', 'damagedLabel', 'number', line.damagedMinor ? String(line.damagedMinor) : '', (v) => {
        if (v === '') { delete line.damagedMinor; return; }
        line.damagedMinor = Number(v);
      }, { min: '0', step: '1', inputmode: 'numeric' }),
      // Batch 18a · R4 (M07-FR-02/03): units that failed the quality check or were refused at the door — head office
      // quarantines them for a second person to decide (accept, return to the supplier, or claim); never on sale.
      box('qcfail', 'qcFailLabel', 'number', line.qcFailedMinor ? String(line.qcFailedMinor) : '', (v) => {
        if (v === '') { delete line.qcFailedMinor; return; }
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0) { tell(t('read'), t('needQcFail')); return; }
        line.qcFailedMinor = n;
      }, { min: '0', step: '1', inputmode: 'numeric' }),
      // Batch 18a · R3 (M07-FR-02): the MRP printed on the pack, in rupees — head office flags one that differs from its master.
      box('mrp', 'mrpLabel', 'text', line.mrpMinor ? (line.mrpMinor / 100).toFixed(2) : '', (v) => {
        const text = v.replace(/,/g, '').replace(/^₹\s*/, '');
        if (text === '') { delete line.mrpMinor; return; }
        if (!/^\d{1,7}(\.\d{1,2})?$/.test(text) || Number(text) <= 0) { tell(t('read'), t('needMrp')); return; }
        const [rupees, paise = ''] = text.split('.');
        line.mrpMinor = Number(rupees) * 100 + Number(paise.padEnd(2, '0'));
      }, { inputmode: 'decimal', autocomplete: 'off' }),
      box('batch', 'batchLabel', 'text', line.batchId ?? '', (v) => { if (v === '') delete line.batchId; else line.batchId = v; }, { autocomplete: 'off' }),
      box('expiry', 'expiryLabel', 'date', line.expiry ?? '', (v) => { if (v === '') delete line.expiry; else line.expiry = v; }),
      ...(packedIds.includes(line.productId) ? [box('mfg', 'mfgShort', 'month', line.manufacturedOn ?? '', (v) => {
        if (v === '') delete line.manufacturedOn; else line.manufacturedOn = v;
      })] : []),
      ...(coldIds.includes(line.productId) ? [box('temp', 'tempShort', 'text', line.temperatureC === undefined ? '' : String(line.temperatureC), (v) => {
        const text = v.replace(',', '.');
        if (text === '') { delete line.temperatureC; return; }
        const c = Number(text);
        if (!/^-?\d+(\.\d+)?$/.test(text) || c < -60 || c > 60) { tell(t('read'), t('needTemp')); return; }
        line.temperatureC = c;
      }, { inputmode: 'decimal', autocomplete: 'off' })] : []),
    );
    row.append(edit);
    // Batch 20a · R7: the sum in words, so "4 × 12 + 3 loose = 51 units" is checked by eye before saving.
    if (byCase !== undefined && size !== undefined) {
      const sum = document.createElement('span');
      sum.className = 'cases-math';
      sum.textContent = fill(t('casesMath'), { cases: String(byCase.cases), n: String(size.units), loose: String(byCase.loose), total: String(line.quantityMinor) });
      row.append(sum);
    }
    // Short, or more than due, against what the order still had due (head office works the same out from its own order).
    if (line.dueMinor !== undefined && line.quantityMinor !== line.dueMinor) {
      const note = document.createElement('span');
      note.className = 'short';
      note.textContent = line.quantityMinor < line.dueMinor
        ? fill(t('shortBy'), { n: String(line.dueMinor - line.quantityMinor) })
        : fill(t('moreBy'), { n: String(line.quantityMinor - line.dueMinor) });
      row.append(note);
    }
    return row;
  }));
}

// ── Fix batch 4b · D-029: the order is CHOSEN from the ones this store waits for (offline, from the store computer) ──
function openDeliveriesNow() {
  return session && typeof session.openDeliveries === 'function' ? session.openDeliveries() : { known: false };
}
function renderOrderChoice() {
  const open = openDeliveriesNow();
  const sel = el('grn-order');
  el('grn-order-field').hidden = !open.known;
  el('grn-po-field').hidden = open.known && sel.value !== 'other';
  if (!open.known) return;
  const current = sel.value;
  const opt = (value, text) => { const o = document.createElement('option'); o.value = value; o.textContent = text; return o; };
  sel.replaceChildren(
    opt('', t('orderPick')),
    ...open.orders.map((d) => opt(`po:${d.poId}`, `${d.number} · ${d.supplierName ?? d.supplierId} · ${fill(t('orderItems'), { n: String(d.due.filter((l) => l.dueMinor > 0).length) })}`)),
    opt('none', t('orderNone')),
    opt('other', t('orderOther')),
  );
  sel.value = [...sel.options].some((o) => o.value === current) ? current : '';
  el('grn-order-label').textContent = t('orderLabel');
  let at = '';
  if (open.asAt) {
    // In the SHOP's zone (the one the store computer told the page, else the shop default) — never this device's own (OB-606).
    let zone = 'Asia/Kolkata';
    try { if (typeof window.shopTimeZone === 'string' && window.shopTimeZone !== '') { new Intl.DateTimeFormat('en-CA', { timeZone: window.shopTimeZone }); zone = window.shopTimeZone; } } catch { /* an unknown zone: the shop default */ }
    const d = new Date(open.asAt);
    at = Number.isNaN(d.getTime()) ? open.asAt : new Intl.DateTimeFormat(lang === 'ta' ? 'ta-IN' : 'en-IN', { timeZone: zone, dateStyle: 'medium', timeStyle: 'short' }).format(d);
  }
  el('grn-order-hint').textContent = at === '' ? '' : fill(t('orderAsAt'), { at });
}
el('grn-order').addEventListener('change', () => {
  const v = el('grn-order').value;
  el('grn-po-field').hidden = v !== 'other';
  // Lines filled in from a previously chosen order go; lines added by hand stay.
  receiptLines = receiptLines.filter((l) => l.dueMinor === undefined);
  if (v.startsWith('po:')) {
    const poId = v.slice(3);
    el('grn-po').value = poId;
    receiptLines = [...session.dueLinesOf(poId).map((l) => ({ productId: l.productId, dueMinor: l.dueMinor, quantityMinor: l.dueMinor, uom: 'ea' })), ...receiptLines];
    el('grn-order-hint').textContent = t('linesFromOrder');
    renderPlaceChoice(poId);
  } else {
    el('grn-po').value = '';
    renderPlaceChoice(null);
  }
  renderLines();
});
// ── Fix batch 5 · D-017: the goods are booked where the order says (this store or the back store), or where the manager picks ──
function placeWords(p) { return fill(t(p.kind === 'store' ? 'placeStore' : 'placeBack'), { id: p.locationId }); }
function renderPlaceChoice(poId) {
  const sel = el('grn-place');
  if (!session || typeof session.receivePlaces !== 'function') { el('grn-place-field').hidden = true; return; }
  const places = session.receivePlaces();
  el('grn-place-label').textContent = t('placeLabel');
  sel.replaceChildren(...places.map((p) => { const o = document.createElement('option'); o.value = p.locationId; o.textContent = placeWords(p); return o; }));
  const preferred = session.defaultReceivePlace(poId ?? null);
  sel.value = preferred;
  sayPlaceHint(poId ?? null);
}
function sayPlaceHint(poId) {
  const named = poId === null ? undefined : openDeliveriesNow().orders?.find((d) => d.poId === poId)?.deliverToLocationId;
  const place = named === undefined ? undefined : session.receivePlaces().find((p) => p.locationId === named);
  el('grn-place-hint').textContent = place === undefined ? ''
    : fill(t(el('grn-place').value === named ? 'placeFromOrder' : 'placeChosenOther'), { place: placeWords(place) });
}
el('grn-place').addEventListener('change', () => { const c = chosenPo(); sayPlaceHint(c.ok ? c.poId : null); });

/** The order the delivery is against: the chosen one, none, or the typed number when the list is not known or the order is not on it. */
function chosenPo() {
  const open = openDeliveriesNow();
  const v = el('grn-order').value;
  if (!open.known || v === 'other') { const typed = el('grn-po').value.trim(); return { ok: true, poId: typed === '' ? null : typed }; }
  if (v.startsWith('po:')) return { ok: true, poId: v.slice(3) };
  if (v === 'none') return { ok: true, poId: null };
  // Nothing chosen: a number typed by hand still counts (never a dead end); otherwise ask.
  const typed = el('grn-po').value.trim();
  return typed === '' ? { ok: false } : { ok: true, poId: typed };
}

el('add-line').addEventListener('click', () => {
  const productId = el('grn-product').value.trim();
  const quantity = Number(el('grn-qty').value);
  if (productId === '' || !Number.isInteger(quantity) || quantity <= 0) {
    tell(t('read'), t('needItem'));
    return;
  }
  // Wave 3 · SF-07 part 2: the arrival temperature, when the goods are chilled or frozen. Empty = not taken (head office then
  // holds a cold-chain line for a manager's check); anything else must be a plain number of degrees — never guessed.
  const tempText = el('grn-temp').value.trim().replace(',', '.');
  const temperatureC = tempText === '' ? undefined : Number(tempText);
  if (temperatureC !== undefined && (!/^-?\d+(\.\d+)?$/.test(tempText) || temperatureC < -60 || temperatureC > 60)) {
    tell(t('read'), t('needTemp'));
    return;
  }
  // B4 · OB-504: the month and year of manufacture, read strictly; a packed product (head office's list) is refused without it.
  const mfgText = el('grn-mfg').value.trim();
  if (mfgText !== '' && !/^\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$/.test(mfgText)) {
    tell(t('read'), t('needMfg'));
    return;
  }
  const packed = session && typeof session.packedAmong === 'function' ? session.packedAmong([productId]) : [];
  if (mfgText === '' && packed.length > 0) {
    tell(t('read'), t('mfgRequired'));
    return;
  }
  receiptLines.push({ productId, quantityMinor: quantity, uom: 'ea', ...(temperatureC === undefined ? {} : { temperatureC }), ...(mfgText === '' ? {} : { manufacturedOn: mfgText }) });
  el('grn-product').value = '';
  el('grn-qty').value = '';
  el('grn-temp').value = '';
  el('grn-mfg').value = '';
  el('grn-product').focus();
  renderLines();
});

el('save-receipt').addEventListener('click', () => {
  const number = el('grn-number').value.trim();
  if (number === '') { tell(t('read'), t('needNumber')); return; }
  const chosen = chosenPo();
  if (!chosen.ok) { tell(t('read'), t('chooseOrder')); return; }
  // Fix batch 4b · D-029: a line where nothing arrived is not booked in (the order still has it due); the due figure stays here.
  const toSave = receiptLines.filter((l) => l.quantityMinor > 0).map((l) => { const line = { ...l }; delete line.dueMinor; return line; });
  if (toSave.length === 0) { tell(t('read'), t('needLines')); return; }

  // OB-172: the checklist travels inside the delivery. A cold-chain delivery is not saved without every check ticked.
  const setup = receivingSetup();
  const check = setup && setup.checks.length > 0 ? setup.checks[0] : undefined;
  let checklist;
  if (check !== undefined && coldOnDelivery().length > 0) {
    if (check.items.some((i) => checklistAnswers[i.itemId] !== 'pass' && checklistAnswers[i.itemId] !== 'fail')) { tell(t('read'), t('rcNeeded')); return; }
    const action = el('receive-checklist-action').value.trim();
    if (check.items.some((i) => checklistAnswers[i.itemId] === 'fail') && action === '') { tell(t('read'), t('rcNeedAction')); return; }
    const probed = receiptLines.find((l) => l.temperatureC !== undefined && coldOnDelivery().includes(l.productId));
    checklist = {
      checkId: check.checkId,
      itemResults: Object.fromEntries(check.items.map((i) => [i.itemId, checklistAnswers[i.itemId]])),
      ...(probed === undefined ? {} : { readingTenthsC: Math.round(probed.temperatureC * 10) }),
      ...(action === '' ? {} : { correctiveAction: action }),
    };
  }

  const stamp = Date.now().toString(36);
  try {
    const received = session.receive({
      grnId: `grn-${stamp}`,
      number,
      poId: chosen.poId,
      receivedAt: new Date().toISOString(),
      lines: toSave,
      ...(checklist === undefined ? {} : { checklist }),
      ...(el('grn-place').value === '' ? {} : { locationId: el('grn-place').value }), // D-017
    });
    // An unmatched delivery is SAID, not filed quietly. Nobody can check an invoice against a
    // purchase order that does not exist, and the person who can still fix that is the buyer today.
    // And WHERE the delivery is (SP-2b): saved on this screen until the store computer takes it — the whole
    // receipt now travels to head office on the same path as a decision, never a bare "saved" (P-08).
    const saved = session.savedWork().find((w) => w.kind === 'receipt' && w.id === received.receipt.id);
    const where = saved === undefined ? '' : ` — ${words(STATE_WORDS, saved.state)}`;
    // Batch 20e · R6: the photos and scans picked for this delivery go on their own queue now — AFTER the delivery is saved,
    // so a file that cannot be kept never stops the delivery (it is said, by name, in the same message).
    const filesSaid = keepFilesWith(received.receipt, number);
    tell(t('received'), `${received.unmatched ? t('unmatchedWarning') : t('matchedNote')}${checklist === undefined ? '' : ` ${t('rcSaved')}`}${where}${filesSaid === '' ? '' : ` ${filesSaid}`}`, !received.unmatched);
    void syncToBox();
    receiptLines = [];
    checklistAnswers = {};
    el('receive-checklist-action').value = '';
    el('grn-number').value = '';
    el('grn-po').value = '';
    el('grn-order').value = '';
    renderOrderChoice();
    renderPlaceChoice(null);
    renderLines();
  } catch (e) {
    // Fix batch 4b · D-029: the lines that are wrong, by name, in the manager's language — nothing was saved.
    if (e && e.name === 'ReceiptLinesRefusedError' && Array.isArray(e.problems)) {
      const nameOf = (id) => (typeof session.productName === 'function' ? session.productName(id) : id);
      tell(t('read'), `${t('lineProblems')} ${e.problems.map((p) => `${nameOf(p.productId)}: ${t(`lp_${p.kind}`) ?? p.kind}`).join('; ')}`);
      return;
    }
    // B4 · OB-504: a packed product with no month of manufacture is refused in the manager's language, not the error's.
    tell(t('read'), e && e.name === 'ManufactureDateRequiredError' ? `${t('mfgRequired')} (${(e.productIds ?? []).join(', ')})` : String(e && e.message ? e.message : e));
  }
});

// ── Batch 20e · R6 (M07-FR-04 · OB-904 – OB-906): photos and scans kept with the delivery ─────────────────────────────────
// The bundle's attachment queue, file reader and words (`window.receiptAttachments`). A photo is made smaller on this computer
// before it is kept; a file that is not a JPEG/PNG photo or a PDF scan, or is too big, is refused in words before anything is
// kept. The files are kept only when the delivery is saved, on their OWN queue, and each says where it has got to (P-08).
const files = window.receiptAttachments;
const fw = (key, fill) => (files ? files.word(lang, key, fill ?? {}) : key);
let pickedFiles = [];

function paintFileWords() {
  el('receive-files').hidden = !files;
  if (!files) return;
  el('receive-files-title').textContent = fw('heading');
  el('receive-files-lead').textContent = fw('lead');
  el('receive-file-kind-label').textContent = fw('kindLabel');
  el('receive-file-item-label').textContent = fw('itemLabel');
  el('receive-file-label').textContent = fw('pick');
  const kind = el('receive-file-kind').value || 'delivery_note';
  el('receive-file-kind').replaceChildren(...files.kinds(lang).map((k) => { const o = document.createElement('option'); o.value = k.kind; o.textContent = k.label; return o; }));
  el('receive-file-kind').value = kind;
  el('receive-files-sent-title').textContent = fw('pendingHeading');
  el('receive-files-sent-lead').textContent = fw('pendingLead');
  renderFileItems();
  renderPickedFiles();
  renderSentFiles();
}

/** The items on the delivery, for a damage photo of one of them (the whole delivery by default). */
function renderFileItems() {
  if (!files) return;
  const keep = el('receive-file-item').value;
  const nameOf = (id) => (typeof session.productName === 'function' ? session.productName(id) : id);
  const seen = new Set();
  const options = [{ value: '', label: fw('wholeDelivery') }];
  for (const l of receiptLines) if (!seen.has(l.productId)) { seen.add(l.productId); options.push({ value: l.productId, label: nameOf(l.productId) }); }
  el('receive-file-item').replaceChildren(...options.map((x) => { const o = document.createElement('option'); o.value = x.value; o.textContent = x.label; return o; }));
  if (options.some((x) => x.value === keep)) el('receive-file-item').value = keep;
  el('receive-file-item-field').hidden = el('receive-file-kind').value !== 'damage_photo';
}

function fileLine(f) {
  const nameOf = (id) => (typeof session.productName === 'function' ? session.productName(id) : id);
  const item = f.productId ? ` · ${fw('forItem', { item: nameOf(f.productId) })}` : '';
  return `${fw(f.kind)}${item} · ${f.fileName} · ${fw('kb', { n: Math.max(1, Math.round(f.bytes / 1024)) })}`;
}

function renderPickedFiles() {
  if (!files) return;
  el('receive-file-list').replaceChildren(...pickedFiles.map((f) => {
    const li = document.createElement('li'); li.dataset.kind = f.kind;
    const what = document.createElement('span'); what.className = 'what'; what.textContent = fileLine(f);
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'sre-btn remove-file'; remove.textContent = fw('remove');
    remove.setAttribute('aria-label', `${fw('remove')} ${f.fileName}`);
    remove.addEventListener('click', () => { pickedFiles = pickedFiles.filter((x) => x !== f); renderPickedFiles(); });
    li.append(what, remove);
    return li;
  }));
  if (el('receive-file-status').dataset.reading !== '1' && el('receive-file-status').dataset.problem !== '1') {
    el('receive-file-status').textContent = pickedFiles.length === 0 ? '' : fw('picked', { n: pickedFiles.length });
  }
}

/** Every file this screen kept, newest first, with where it has got to — the five state words, a refusal with its reason. */
function renderSentFiles() {
  if (!files) return;
  const list = files.queue.list();
  el('receive-files-sent-title').hidden = list.length === 0;
  el('receive-files-sent-lead').hidden = list.length === 0;
  el('receive-files-sent').replaceChildren(...list.map((f) => {
    const li = document.createElement('li'); li.className = 'saved-file'; li.dataset.state = f.state; li.dataset.grnId = f.grnId;
    const what = document.createElement('span'); what.className = 'what'; what.textContent = `${f.receiptNumber} · ${fileLine(f)}`;
    const state = document.createElement('span'); state.className = `pill ${f.state} sre-with-icon`;
    const mark = lineIcon(STATE_SHAPES[f.state] ?? 'clock', 16); if (mark) state.append(mark);
    state.append(document.createTextNode(words(STATE_WORDS, f.state)));
    li.append(what, state);
    if (f.reason) { const why = document.createElement('span'); why.className = 'blocked'; why.textContent = f.reason; li.append(why); }
    return li;
  }));
}

el('receive-file-kind').addEventListener('change', () => { el('receive-file-item-field').hidden = el('receive-file-kind').value !== 'damage_photo'; });

el('receive-file').addEventListener('change', async () => {
  if (!files) return;
  const input = el('receive-file');
  const chosen = [...(input.files ?? [])];
  if (chosen.length === 0) return;
  const kind = el('receive-file-kind').value;
  const productId = kind === 'damage_photo' ? el('receive-file-item').value : '';
  const status = el('receive-file-status');
  status.dataset.reading = '1';
  delete status.dataset.problem;
  status.textContent = fw('reading');
  const problems = [];
  for (const file of chosen) {
    if (pickedFiles.length >= files.maxPerReceipt) { problems.push(`${file.name}: ${fw('too_many_files')}`); continue; }
    const read = await files.read(file);
    if (!read.ok) { problems.push(`${file.name}: ${fw(read.code)}`); continue; }
    pickedFiles.push({ kind, ...(productId === '' ? {} : { productId }), fileName: read.fileName, mediaType: read.mediaType, contentBase64: read.contentBase64, bytes: read.bytes });
  }
  input.value = '';
  delete status.dataset.reading;
  if (problems.length > 0) status.dataset.problem = '1';
  renderPickedFiles();
  if (problems.length > 0) status.textContent = problems.join(' ');
});

/** Keep the picked files with the delivery just saved; the words for the message (empty when none were picked). */
function keepFilesWith(receipt, number) {
  if (!files || pickedFiles.length === 0) return '';
  const refused = [];
  let kept = 0;
  for (const f of pickedFiles) {
    const out = files.queue.add({
      attachmentId: files.newId(), grnId: receipt.id, receiptNumber: number, warehouseId: receipt.warehouseId,
      storeId: window.managerData?.storeId ?? null, kind: f.kind, ...(f.productId ? { productId: f.productId } : {}),
      fileName: f.fileName, mediaType: f.mediaType, contentBase64: f.contentBase64, attachedBy: files.attachedBy ?? receipt.receivedBy ?? null,
    });
    if (out.added) kept += 1; else refused.push(`${f.fileName}: ${fw(out.code)}`);
  }
  const problem = typeof files.storageProblem === 'function' ? files.storageProblem() : undefined;
  if (problem) refused.push(problem);
  pickedFiles = [];
  delete el('receive-file-status').dataset.problem;
  renderPickedFiles();
  renderSentFiles();
  void syncFiles();
  return [kept > 0 ? fw('savedWith', { n: kept }) : '', refused.length > 0 ? fw('notKept', { why: refused.join('; ') }) : ''].filter((x) => x !== '').join(' ');
}

/** Hand the files to the store computer (one at a time) and learn where they have got to. Never blocks a tap. */
async function syncFiles() {
  if (!files || !files.relay) { renderSentFiles(); return; }
  try { await files.relay.syncNow(); } catch { /* every file is kept here; the state words say so */ }
  renderSentFiles();
}

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
  } catch (e) {
    // Only the device's own storage can fail here; the count was NOT saved and the manager is told so.
    tell(t('read'), String(e && e.message ? e.message : e));
    return;
  }

  if (!attempt.counted) {
    tell(t('read'), attempt.refusal === 'nobody_named' ? t('nobodyNamed') : t('alreadyCounted'));
    return;
  }
  // Recorded and QUEUED — and that is all this screen knows (SP-2b). The expected figure, the difference and its
  // value are head office's; a large difference waits there for somebody else. The banner says where the count is.
  const saved = session.savedWork().find((w) => w.kind === 'count' && w.id === attempt.countId);
  const where = saved === undefined ? '' : ` — ${words(STATE_WORDS, saved.state)}`;
  tell(t('countRecorded'), `${t('countNote')}${where}`, true);
  void syncToBox();
  el('count-product').value = '';
  el('count-location').value = '';
});

// ── Closing the day ─────────────────────────────────────────────────────────

function resetClose() {
  el('blockers').replaceChildren();
  el('do-close').hidden = true;
  el('close-pin-row').hidden = true;
  el('carry-row').hidden = true;
  renderCardDay();
}

/**
 * OB-271 · audit A9 — REAL TRADING only: today's card and UPI payments on this store computer's tills, each with the number
 * the shop's machine printed ("Approval / Auth code / RRN"), those still with no answer, and the refunds done on the
 * machine — exactly as the store computer listed them (`window.managerData.cardPayments`), to tick against the machine's
 * settlement slip. Absent from the payload (the mirror pilot, or no card payments on this box): the section stays hidden.
 * Only what the store computer checked is shown; a number it did not keep reads "no number kept" — never a card number.
 */
function renderCardDay() {
  const day = window.managerData && window.managerData.cardPayments;
  const section = el('card-day');
  if (!day || typeof day !== 'object' || !Array.isArray(day.paid)) { section.hidden = true; return; }
  section.hidden = false;
  el('card-day-title').textContent = t('cardDayTitle');
  el('card-day-lead').textContent = t('cardDayLead');
  // OB-607: a card payment's time of day is the SHOP's clock (its zone, as the store computer told the page) — never this
  // device's: a laptop in New York read 15:30 for a payment the shop took at 01:00.
  const clock = (iso) => window.sreShopDay?.timeOf(iso) || '—';
  const kindOf = (k) => (k === 'upi' ? t('cardKindUpi') : t('cardKindCard'));
  const cell = (tag, text, className) => {
    const c = document.createElement(tag);
    c.textContent = text;
    if (className) c.className = className;
    if (tag === 'th') c.scope = 'col';
    return c;
  };
  const table = (id, heads, rows) => {
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    const tbl = document.createElement('table');
    tbl.id = id;
    const head = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const h of heads) hr.appendChild(cell('th', h));
    head.appendChild(hr);
    const body = document.createElement('tbody');
    for (const r of rows) { const tr = document.createElement('tr'); for (const c of r) tr.appendChild(c); body.appendChild(tr); }
    tbl.append(head, body);
    wrap.appendChild(tbl);
    return wrap;
  };
  const refCell = (ref) => (typeof ref === 'string' && ref !== '' ? cell('td', ref, 'ref') : cell('td', t('cardNoRef'), 'ref none'));
  const line = (id, text, className) => { const p = document.createElement('p'); p.id = id; p.textContent = text; if (className) p.className = className; return p; };
  const heading = (text) => { const h = document.createElement('h4'); h.textContent = text; return h; };
  const unresolved = Array.isArray(day.unresolved) ? day.unresolved : [];
  const refunds = Array.isArray(day.refundsOnMachine) ? day.refundsOnMachine : [];
  const parts = [];
  if (day.paid.length === 0 && unresolved.length === 0 && refunds.length === 0) parts.push(line('card-day-none', t('cardNone')));
  if (day.paid.length > 0) {
    parts.push(table('card-day-paid', [t('cardColTime'), t('cardColTill'), t('cardColKind'), t('cardColAmount'), t('cardColRef'), t('cardColBill')],
      day.paid.map((p) => [cell('td', clock(p.at)), cell('td', String(p.laneId ?? '')), cell('td', kindOf(p.kind)), cell('td', inr(p.amountMinor), 'n'), refCell(p.machineRef), cell('td', p.saleId || t('cardNoBill'))])));
    parts.push(line('card-day-paid-total', `${t('cardPaidTotal')}: ${inr(day.paidTotalMinor ?? 0)}`, 'total'));
  }
  if (unresolved.length > 0) {
    parts.push(heading(t('cardUnresolvedTitle')));
    parts.push(table('card-day-unresolved', [t('cardColTime'), t('cardColTill'), t('cardColKind'), t('cardColAmount'), t('cardColBill')],
      unresolved.map((p) => [cell('td', clock(p.at)), cell('td', String(p.laneId ?? '')), cell('td', kindOf(p.kind)), cell('td', inr(p.amountMinor), 'n'), cell('td', String(p.billRef ?? ''))])));
  }
  if (refunds.length > 0) {
    parts.push(heading(t('cardRefundsTitle')));
    parts.push(table('card-day-refunds', [t('cardColTime'), t('cardColTill'), t('cardColKind'), t('cardColRefund'), t('cardColRefundRef'), t('cardColBill'), t('cardColCheckedBy')],
      refunds.map((r) => [cell('td', clock(r.at)), cell('td', String(r.laneId ?? '')), cell('td', kindOf(r.kind)), cell('td', `-${inr(r.amountMinor)}`, 'n'), refCell(r.machineRef), cell('td', String(r.returnId ?? '')), cell('td', r.approvedBy || '—')])));
    parts.push(line('card-day-refunded-total', `${t('cardRefundedTotal')}: ${inr(day.refundedTotalMinor ?? 0)}`, 'total'));
  }
  el('card-day-body').replaceChildren(...parts);
}

/**
 * OB-55: the day may close with pending card/UPI payments carried to head office ONLY when those payments are the sole
 * thing open, and only through the store computer (which checks both people's PINs). Anything else open: the old list.
 */
function onlyPaymentsOpen(blockers) {
  return blockers.length > 0 && blockers.every((b) => b.kind === 'payments_pending') && session.canCloseViaBox;
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
    box.dataset.kind = blocker.kind; // which blocker, for a reader (and a test) — the words stay the person's

    const title = document.createElement('h3');
    // A count belongs in front of the sentence where there is one, and nowhere where there is not.
    title.textContent = blocker.count > 0 ? `${blocker.count} ${words_.title}` : words_.title;
    // OB-205: a blocker wears the alert shape beside its title — the title is still its whole text.
    const mark = lineIcon('circle-alert', 20);
    if (mark) { title.prepend(mark); title.className = 'sre-with-icon'; }

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

/** The SHOP's wall clock, as the trading-day rule expects it ("YYYY-MM-DDTHH:MM") — OB-606: in the shop's zone (as the
 *  store computer told the page), never this device's: a laptop set to London closed the shop's yesterday. */
function localStamp() {
  if (window.sreShopDay !== undefined) return window.sreShopDay.wallClock();
  // OB-607: the sample stand-in (no bundle) reads the SHOP's clock too — the zone the store computer told the page, else
  // the shop default (Asia/Kolkata, packages/calendar shop-clock) — never this device's own clock.
  let zone = 'Asia/Kolkata';
  try { if (typeof window.shopTimeZone === 'string' && window.shopTimeZone !== '') { new Intl.DateTimeFormat('en-CA', { timeZone: window.shopTimeZone }); zone = window.shopTimeZone; } } catch { /* an unknown zone: the shop default */ }
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const part = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

el('check-close').addEventListener('click', () => {
  const blockers = session.blockersForClose(localStamp());
  renderBlockers(blockers);
  // The close button only appears once there is nothing in the way — and it is the model's list
  // that decides that, not this screen's opinion of it.
  el('do-close').hidden = blockers.length > 0;
  // Round 4: the close goes to the store computer as the manager's own act — their till PIN, keyed here.
  el('close-pin-row').hidden = (blockers.length > 0 && !onlyPaymentsOpen(blockers)) || !session.canCloseViaBox;
  // OB-55: only card/UPI payments open — offer the close with them carried to head office, on a second person's PIN.
  el('carry-row').hidden = !onlyPaymentsOpen(blockers);
  const dc = boxDayClose();
  if (blockers.length > 0) tell(dc ? fill(t('stillOpenNamed'), { day: dayWords(dc.closes) }) : t('stillOpen'), onlyPaymentsOpen(blockers) ? t('carryLead') : t('closedNote'));
  // D-012: the confirmation names the day the store computer will close.
  else if (dc && session.canCloseViaBox) tell(fill(t('readyToClose'), { day: dayWords(dc.closes) }), fill(t('readyNote'), { button: closeButtonWords() }), true);
});

el('do-carry').addEventListener('click', () => {
  void (async () => {
    const closerPin = el('close-pin').value;
    const approvedBy = el('carry-approver').value.trim();
    const approverPin = el('carry-pin').value;
    // The PINs never stay on the screen, whatever happens next.
    el('close-pin').value = '';
    el('carry-pin').value = '';
    if (closerPin === '' || approvedBy === '' || approverPin === '') {
      // OB-205: say it beside the fields too, and mark the ones still empty — the banner alone is gone once read.
      el('close-pin').setAttribute('aria-invalid', closerPin === '' ? 'true' : 'false');
      el('carry-approver').setAttribute('aria-invalid', approvedBy === '' ? 'true' : 'false');
      el('carry-pin').setAttribute('aria-invalid', approverPin === '' ? 'true' : 'false');
      el('carry-needs').textContent = t('carryNeeds');
      el('carry-needs').hidden = false;
      tell(t('stillOpen'), t('carryNeeds'));
      return;
    }
    el('carry-needs').hidden = true;
    const stamp = Date.now().toString(36);
    const outcome = await session.closeViaBox({
      dayCloseId: `dc-${stamp}`, closedAtLocal: localStamp(), closedAt: new Date().toISOString(), closerPin,
      carryForward: { approvedBy, approverPin, reason: el('carry-reason').value },
    });
    if (outcome.closed) {
      const named = session.blockersForClose(localStamp()).flatMap((b) => b.items.map((i) => i.what));
      tell(fill(t('closedNamed'), { day: dayWords(outcome.tradingDay) }), `${t('carried')}${named.length > 0 ? `: ${named.join('; ')}` : '.'}`, true);
      el('blockers').replaceChildren();
      el('carry-row').hidden = true;
      el('close-pin-row').hidden = true;
      el('do-close').hidden = true;
      return;
    }
    // The store computer refused — its own reason, never a bare "no". Nothing was locked.
    tell(t('stillOpen'), boxReason(outcome));
  })();
});

/** The store computer's own reason for not closing, in Tamil when it said it in Tamil too (OB-259's sign-in refusals). */
const boxReason = (outcome) => (lang === 'ta' && typeof outcome.reasonTa === 'string' && outcome.reasonTa !== '' ? outcome.reasonTa : outcome.reason) || t('closedNote');

el('do-close').addEventListener('click', () => {
  void (async () => {
    const stamp = Date.now().toString(36);
    const closeInput = { dayCloseId: `dc-${stamp}`, closedAtLocal: localStamp(), closedAt: new Date().toISOString() };

    // Wired to the store computer? Then the close goes THERE. The box makes the authoritative
    // decision — it reads the real outbox this page never sees — writes the locked day durably and
    // queues it for head office. This screen shows what the box decided and locks nothing itself.
    if (session.canCloseViaBox) {
      const closerPin = el('close-pin').value;
      el('close-pin').value = '';
      const outcome = await session.closeViaBox({ ...closeInput, closerPin });
      el('close-pin-row').hidden = true;
      if (outcome.closed) {
        // D-012: the day the BOX closed, by name — "Friday 14 Nov is closed and locked."
        tell(fill(t('closedNamed'), { day: dayWords(outcome.tradingDay) }), t('closedNote'), true);
        el('do-close').hidden = true;
        el('blockers').replaceChildren();
        return;
      }
      // The box refused. Its reason is the truth — a sale rung a second ago, the day not yet ended,
      // or the store computer unreachable. Re-render the local blocker list (translated) where there
      // is one, and always carry the box's own reason so a manager is never told a bare "no".
      renderBlockers(session.blockersForClose(localStamp()));
      el('do-close').hidden = true;
      const dcNow = boxDayClose();
      tell(dcNow ? fill(t('stillOpenNamed'), { day: dayWords(dcNow.closes) }) : t('stillOpen'), boxReason(outcome));
      return;
    }

    // No store computer behind this page. The local preview close is honest that it only touches
    // this browser: it re-checks the blockers and closes nothing that has not reached the cloud.
    const attempt = session.closeTheDay(closeInput);
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
  })();
});

// ── Language ────────────────────────────────────────────────────────────────

/**
 * OB-288 lane 2 · OB-327: this store computer's clock against head office's, said in words beside its shape, and the bills
 * marked while it was 5+ minutes out listed by number for a person to check. The tested view decides what shows.
 */
function paintBoxClock() {
  const md = window.managerData;
  // D-028: moments in the shop's own time words (OB-607), never a computer timestamp.
  const shopWords = (iso) => window.sreShopDay?.dateTimeOf?.(iso) ?? '';
  const v = typeof window.boxClockView === 'function' ? window.boxClockView(lang, md && md.clock, md && md.clockFlaggedBills, md && md.timeZone, md && md.activationHold, shopWords) : null;
  const strip = el('box-clock');
  if (v === null || !v.show) { strip.hidden = true; return; }
  strip.hidden = false;
  strip.dataset.tone = v.tone;
  el('box-clock-words').hidden = v.words === '';
  if (v.words !== '') worded(el('box-clock-words'), v.icon, v.words);
  // R1a · P-08: this store computer's own time zone is not the shop's (it still dates by the shop's zone).
  el('box-zone-words').hidden = v.zoneWords === '';
  if (v.zoneWords !== '') worded(el('box-zone-words'), 'globe', v.zoneWords);
  // OB-403 "A" · §31.1: new prices, offers and the bill-number year held while the clock is 5+ minutes out, by name.
  el('box-hold-words').hidden = v.holdWords === '';
  if (v.holdWords !== '') worded(el('box-hold-words'), 'pause', v.holdWords);
  el('box-clock-bills-h').hidden = v.bills.length === 0;
  el('box-clock-bills-h').textContent = v.billsHeading;
  el('box-clock-bills').replaceChildren(...v.bills.map((b) => { const li = document.createElement('li'); li.dataset.sale = b.saleId; li.textContent = b.label; return li; }));
}

function paintChrome() {
  paintBoxClock();
  paintTitle();
  el('tab-home').textContent = t('today');
  el('tab-approvals').textContent = t('approvals');
  el('tab-receive').textContent = t('receive');
  el('tab-count').textContent = t('count');
  el('tab-close').textContent = t('closeDay');
  el('home-title').textContent = board('overview'); // batch 17 · OB-855: one language
  el('home-lead').textContent = t('tapAFigure');
  el('approvals-title').textContent = t('approvals');
  el('approvals-lead').textContent = t('biggestFirst');
  el('saved-title').textContent = t('savedHere');
  el('saved-lead').textContent = t('savedLead');
  el('receive-title').textContent = t('receive');
  el('receive-lead').textContent = t('receiveLead');
  el('grn-number-label').textContent = t('deliveryNote');
  el('grn-po-label').textContent = t('poNumber');
  renderOrderChoice(); // D-029: the order list, in this language
  { const keep = el('grn-place').value; const c = chosenPo(); renderPlaceChoice(c.ok ? c.poId : null); if (keep !== '' && [...el('grn-place').options].some((o) => o.value === keep)) { el('grn-place').value = keep; sayPlaceHint(c.ok ? c.poId : null); } } // D-017
  el('grn-product-label').textContent = t('itemCode');
  el('grn-qty-label').textContent = t('howMany');
  el('grn-temp-label').textContent = t('tempLabel');
  el('grn-temp-hint').textContent = t('tempHint');
  el('grn-mfg-label').textContent = t('mfgLabel');
  el('grn-mfg-hint').textContent = t('mfgHint');
  el('add-line').textContent = t('addItem');
  el('receive-empty').textContent = t('noItemsYet');
  el('save-receipt').textContent = t('saveDelivery');
  paintFileWords(); // batch 20e
  el('receive-checklist-missing').textContent = t('rcNotTold');
  el('count-title').textContent = t('count');
  el('count-lead').textContent = t('countBlindHint');
  el('count-product-label').textContent = t('productCode');
  el('count-location-label').textContent = t('whereIsIt');
  el('enter-count').textContent = t('enterCount');
  el('close-title').textContent = t('closeDay');
  // D-012: which trading day the store computer closes, and when today's can be closed (after the store's cutoff).
  const dc = boxDayClose();
  el('close-lead').textContent = dc && session.canCloseViaBox
    ? `${fill(t('closeThisDay'), { day: dayWords(dc.closes) })} ${fill(t('runningDayWhen'), { day: dayWords(dc.runningDay), at: dc.runningDayClosesFrom?.at ?? '', next: dayWords(dc.runningDayClosesFrom?.day) })} ${t('closedNote')}`
    : t('closedNote');
  worded(el('check-close'), 'list-checks', t('checkOpen'));
  el('approvals-col-what').textContent = t('colRequest');
  el('approvals-col-value').textContent = t('colValue');
  el('approvals-col-act').textContent = t('colDecision');
  el('close-pin-hint').textContent = t('closePinHint');
  el('carry-pin-hint').textContent = t('carryPinHint');
  if (!el('carry-needs').hidden) el('carry-needs').textContent = t('carryNeeds');
  el('do-close').textContent = session.canCloseViaBox ? closeButtonWords() : t('closeNow');
  el('close-pin-label').textContent = t('closePin');
  el('close-pin').setAttribute('aria-label', t('closePin'));
  el('carry-lead').textContent = t('carryLead');
  el('carry-approver-label').textContent = t('carryApprover');
  el('carry-pin-label').textContent = t('carryPin');
  el('carry-reason-label').textContent = t('carryReason');
  el('carry-reason-provider').textContent = t('carryProvider');
  el('carry-reason-machine').textContent = t('carryMachine');
  el('do-carry').textContent = t('carryNow');
  el('sample').textContent = t('sampleData');
}

// OB-205: a field marked as still needed stops saying so the moment something is typed into it.
for (const id of ['close-pin', 'carry-approver', 'carry-pin']) el(id).addEventListener('input', () => { el(id).removeAttribute('aria-invalid'); });

el('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  // The document says which language it speaks (3.1.1) — a screen reader and the chrome both read it here.
  document.documentElement.lang = lang;
  paintChrome();
  // Batch 18a (OB-855): the delivery's lines being typed are redrawn in the chosen language too, keeping what was typed.
  renderLines();
  show(view);
});

// ── Boot ────────────────────────────────────────────────────────────────────

// Sample figures must announce themselves. A manager acting on a number that came from nowhere is
// worse than a manager with no number at all.
el('sample').hidden = real !== undefined;

paintChrome();
renderLines();
show('home');
// The chrome (sre-chrome.js) loads after this script; once it is there, the Today page takes its icons.
document.addEventListener('sre:chrome', () => { paintBoxClock(); if (view === 'home') renderHome(); });

// The device queue's own honesty (SP-2a · P-08): if this browser's storage refused, the manager is told so
// before deciding anything — a decision that will not survive a reload is not "saved".
if (typeof window.managerStorageProblem === 'string' && window.managerStorageProblem !== '') {
  tell(t('read'), window.managerStorageProblem);
}
// Hand saved work to the store computer now and every ten seconds while the page is open; a box that is
// down leaves everything saved here, and the state words say exactly that.
void syncToBox();
if (window.managerRelay) setInterval(() => { void syncToBox(); }, 10_000);
// Round A: Today's head-office counts — read now, and again each minute while the page is open (a GET, read only).
async function refreshLive() {
  if (!window.todayLive) return;
  live = await window.todayLive.read();
  if (view === 'home') renderHome();
}
void refreshLive();
if (window.todayLive) setInterval(() => { void refreshLive(); }, 60_000);

// ── The shell's own honesty about where this page came from ─────────────────
//

// The shell existed and nothing ever registered it, so nothing was ever cached and every one of
// these screens fell back to its sample data the moment the box was unreachable.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}

// ── U2b (G14): the month of manufacture is picked from a list of the last 36 months (the shop's own clock says which month it is);
// the typed box stays only where the shop's clock is unknown. The value is the same 'YYYY-MM' the receipt line always carried.
(function mfgMonthList() {
  const input = el('grn-mfg'); const today = window.sreShopDay?.today?.() ?? '';
  if (!input || input.tagName !== 'INPUT' || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return;
  const names = { en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], ta: ['ஜன', 'பிப்', 'மார்', 'ஏப்', 'மே', 'ஜூன்', 'ஜூலை', 'ஆக', 'செப்', 'அக்', 'நவ', 'டிச'] };
  const sel = document.createElement('select'); sel.id = 'grn-mfg'; sel.setAttribute('aria-describedby', 'grn-mfg-hint');
  const none = document.createElement('option'); none.value = ''; sel.append(none);
  let y = Number(today.slice(0, 4)); let mo = Number(today.slice(5, 7));
  for (let k = 0; k < 36; k += 1) { const o = document.createElement('option'); o.value = `${y}-${String(mo).padStart(2, '0')}`; o.dataset.y = String(y); o.dataset.m = String(mo); sel.append(o); mo -= 1; if (mo === 0) { mo = 12; y -= 1; } }
  const paintMonths = () => { const l = document.documentElement.lang === 'ta' ? 'ta' : 'en'; none.textContent = l === 'ta' ? '— மாதத்தைத் தேர்ந்தெடுங்கள் —' : '— pick the month —'; for (const o of sel.options) if (o.value !== '') o.textContent = `${names[l][Number(o.dataset.m) - 1]} ${o.dataset.y}`; };
  paintMonths(); new MutationObserver(paintMonths).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  input.replaceWith(sel);
})();

// ── U2c (UI/UX gap audit G5, 7 Nov 2026): Today's three typed ids pick by NAME through the chrome's picker ───────────
// The delivery's item, the count's product and the carry-over's second person: a "Choose…" button (≥ 44px) beside the
// field opens `sreOffice.pick`; the pick writes the id the screen sends (so a code typed by hand still works when the
// list cannot be read — never a dead end), and the thing's name is shown beside the field. The same page-side adapter
// the U2/U2b pages use; words in both languages.
(function todayPickers() {
  const PICK_WORDS = {
    en: { choose: 'Choose…', item: 'the item', product: 'the product', person: 'the second person' },
    ta: { choose: 'தேர்வு…', item: 'பொருளை', product: 'பொருளை', person: 'இரண்டாவது நபரை' },
  };
  const pw = (k) => (document.documentElement.lang === 'ta' ? PICK_WORDS.ta : PICK_WORDS.en)[k] ?? PICK_WORDS.en[k];
  const repaints = [];
  function pickable(inputId, kind, titleKey) {
    const input = el(inputId);
    if (!input || input.dataset.pickable === 'on') return;
    const office = window.sreOffice;
    if (!office || typeof office.pick !== 'function') { document.addEventListener('sre:chrome', () => pickable(inputId, kind, titleKey), { once: true }); return; }
    input.dataset.pickable = 'on';
    const row = document.createElement('div'); row.className = 'pick-row';
    input.replaceWith(row); row.append(input);
    const btn = document.createElement('button'); btn.type = 'button'; btn.id = `${inputId}-pick`; btn.className = 'sre-btn sre-btn-quiet pick';
    const name = document.createElement('span'); name.id = `${inputId}-name`; name.className = 'pick-name';
    row.append(btn, name);
    const paint = () => { btn.textContent = pw('choose'); btn.setAttribute('aria-label', `${pw('choose')} ${pw(titleKey)}`); };
    paint(); repaints.push(paint);
    btn.addEventListener('click', async () => {
      const picked = await office.pick({ kind, title: { en: PICK_WORDS.en[titleKey], ta: PICK_WORDS.ta[titleKey] }, allowCode: true });
      if (!picked || picked.ok !== true) return;
      const id = String(picked.id ?? '');
      input.value = id;
      name.textContent = typeof picked.name === 'string' && picked.name !== id ? picked.name : '';
      input.removeAttribute('aria-invalid');
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    input.addEventListener('input', () => { name.textContent = ''; });
  }
  pickable('grn-product', 'product', 'item');
  pickable('count-product', 'product', 'product');
  pickable('carry-approver', 'person', 'person');
  new MutationObserver(() => { for (const r of repaints) r(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
})();
