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

/** A product's name from the lane's catalogue, or its code when the catalogue does not know it — a
 *  cashier reads "Amul Ghee 1L", not "P1", but a delisted item still shows something rather than blank. */
const descOf = (productId) => (session.productName && session.productName(productId)) || productId;

// ── Words ───────────────────────────────────────────────────────────────────
//
// Tamil is a first language for much of the floor staff, not a translation afterthought. Numbers
// are never translated — a total is a total in both.
const WORDS = {
  en: {
    staleShell: 'No connection to the store computer. Billing still works. This price list is what this lane was last given, at',
    scanToBegin: 'Scan an item to begin.', qty: 'Qty', void: 'Void', tender: 'Tender',
    // The age question (M12-FR-04 · Wave 2b PF-03): asked BEFORE the item joins the bill, answered in the signed-in
    // cashier's name. {item} and {age} are filled in from the product the till just scanned.
    ageQuestion: '{item} is age restricted. Check the customer\'s identification. Is the customer {age} or over?',
    ageYes: 'Yes — ID checked, {age} or over', ageNo: 'No — do not sell',
    ageNotSoldTitle: 'Item not sold',
    ageNotSold: 'The customer could not show they are {age} or over, so {item} was not added to the bill. Nothing else changes.',
    // Who is on the till (SP-4b · F09): the lane the box said it is, and the cashier who signed in — or nobody.
    lane: 'Lane', noLane: 'No lane set on this till', notSignedIn: 'Nobody signed in',
    signIn: 'Sign in', signOut: 'Sign out', signInTitle: 'Your staff ID',
    signInHint: 'Scan your badge or key your staff ID, then OK. Next you key your till PIN.',
    // The till PIN (ADR-0020 · PF-02): checked by the store computer, never shown, never kept on this screen.
    noStoreBox: 'This till is not connected to its store computer, so nobody can sign in. Tell the manager.',
    pinTitle: 'Your till PIN', pinHint: 'Key your six-digit till PIN, then OK. It is never shown. Forgotten it? Ask the manager.',
    signInRefused: 'Not signed in',
    signedInAs: 'Signed in',
    checkPayment: 'Check that payment with the provider',
    cancel: 'Cancel', ok: 'OK', quantity: 'Quantity', cashReceived: 'Cash received',
    changeDue: 'Change due', online: 'Online', offline: 'Offline', unsent: 'Unsent',
    // The badge's states, from the BOX (design system §1 rule 4): connection · unsent · last contact.
    // One-tap values on a panel (pos-cashier.md: quantity ≤3 taps, cash ≤3 taps — tap line → qty → confirm).
    exact: 'Exact',
    checkingBox: 'Checking the store box…',
    boxNotAnswering: 'the store box is not answering — sales cannot be saved on this lane',
    noCloud: 'Selling offline — head office cannot be reached',
    cloudNotSetUp: 'No head office link on this box',
    cloudUnknown: 'Head office not checked yet',
    lastContact: 'last contact',
    unsentHeld: 'sale(s) are saved on this box and waiting to be sent. Nothing is lost — they go as soon as head office can be reached.',
    reasonForVoid: 'Reason for void', tapLineFirst: 'Tap a line first.',
    scanFirst: 'Scan an item first.', read: 'Please read this',
    notEnough: 'Not enough — the customer still owes',
    receiptsUsedUp: 'This till has used all its receipt numbers. Do not take money — tell the manager to load a new number range.',
    allSent: 'Everything on this lane has reached the cloud.',
    noCatalogue: 'This lane has no price list loaded, so it cannot scan. Tell the manager.',
    hold: 'Hold', recall: 'Recall', held: 'Basket held',
    howPaying: 'How is the customer paying?', cash: 'Cash', card: 'Card', upi: 'UPI',
    onHold: 'A basket is on hold. Tap Recall to bring it back.',
    noneHeld: 'No basket is on hold for this till.',
    recallWhich: 'Which held basket?',
    noSale: 'Open drawer (no sale)', noSaleDone: 'Recorded — open the drawer', noSaleHint: 'A manager approves opening the drawer with no sale',
    priceChange: 'Change price of the selected line', newPrice: 'New price for one unit (₹) — lower than now', priceChanged: 'Price changed',
    overrideHint: 'A manager who is not you approves this', overrideReason: 'Manager: why is this allowed?',
    giveUp: 'Give up a held basket', giveUpWhich: 'Which held basket is being given up?', whyGiveUp: 'Why is it being given up?',
    givenUp: 'Basket given up. It stays on the record with your name and the reason.',
    tapTerminal: 'What did the card machine say?',
    approved: 'Approved', declined: 'Declined', noAnswer: 'It has not answered',
    more: 'More', pickup: 'Cash to safe', closeTill: 'Close till', refund: 'Refund',
    countDrawer: 'Count the drawer', counted: 'Counted', closeTillNow: 'Close till',
    amountToSafe: 'How much is going to the safe?', movedToSafe: 'Moved to the safe',
    over: 'Over by', short: 'Short by', balanced: 'The drawer balances exactly.',
    needsReason: 'This difference is large enough that a manager must be told. Do not put the money away — call the manager now.',
    countHint: 'Count what is actually in the drawer. Nothing on this screen tells you what it should be — that is on purpose.',
    // The till's cash lives on the store computer (SP-4c · F10): a float opens the till, a pickup goes to the safe, the close is
    // decided there. The words for each refusal are the store computer's own (English) and their Tamil twins.
    takeFloat: 'Take float (open the till)', floatAmount: 'How much float is going into the drawer?', floatTaken: 'Float taken — the till is open',
    cashSaved: 'Recorded on the store computer', cashNotSaved: 'NOT recorded. Do not move the money.',
    whyOut: 'Why is the drawer out?', tillClosed: 'Till closed',
    pendingCash: 'A cash movement from before was still waiting — it has now been recorded.',
    cash_till_already_assigned: 'This till already has a float out. Close the till before another float is taken.',
    cash_till_not_held_by_this_custodian: 'You do not hold this till. Take the float first, or ask the cashier who did.',
    cash_insufficient_till_cash: 'The drawer does not hold that much. Count what is there and tell the manager before moving any cash.',
    cash_no_open_shift: 'No float has been taken on this till, so there is no shift to close. Take the float first.',
    cash_not_the_custodian: 'This till is held by another cashier. Only the cashier who took the float can close it.',
    cash_lane_unreachable: 'The store computer did not answer. The cash is NOT recorded yet — do not move it. Try again in a moment.',
    cash_no_store_box: 'This till is not connected to its store computer, so cash cannot be recorded. Tell the manager.',
    cash_material_variance_needs_a_reason: 'The drawer is out by more than the shop allows. Say why before the till can close.',
    cash_denominations_do_not_add_up: 'The notes and coins you counted do not add up to the total, or include a note that does not exist. Count the drawer again.',
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
    refundCustomerId: 'Store credit: key the loyalty member\'s mobile number',
    refundCustomerHint: 'Store credit is money on the member\'s account — it goes to the mobile number they joined with',
    refundNeedCustomer: 'Store credit must go to a loyalty member. Key their mobile number — or choose a different refund method.',
    split: 'Split / points / store credit',
    splitLeft: 'Still to pay',
    points: 'Points',
    upTo: 'up to',
    splitNoMember: 'No loyalty member on this bill, so points and store credit are not offered. Name the member first (More → Loyalty member).',
    splitWallet: 'Member ••••{last4}: {points} points ({pointsValue}), store credit {credit}. Balances as of {asOf}.',
    pointsWhole: 'Points are spent whole: one point is worth {value}.',
    refundCondition: 'What condition is the item in?',
    dispResell: 'Good — back on the shelf',
    dispDamaged: 'Damaged — not for sale',
    refundManagerId: 'Manager: scan your badge or key your staff ID',
    refundManagerHint: 'A different person from the cashier must approve a refund',
    refundNeedManager: 'A manager must approve this refund. Ask a manager — not yourself.',
    refundApproveReason: 'Manager: why is this refund approved?',
    // The manager's own PIN (ADR-0021): checked by the store computer, for this one refund only.
    managerPinTitle: 'Manager: your till PIN', managerPinHint: 'The manager keys their own six-digit till PIN. It is never shown, and approves this refund only.',
    approvalRefused: 'Not approved',
    refundDone: 'Refund recorded',
    refundPending: 'Refund pending',
    refundStop: 'Do not hand over cash',
    noReceipt: 'Return without receipt',
    noReceiptItem: 'Scan the item coming back, or key its code',
    noReceiptItemHint: 'No bill, so the item is the evidence — scan its barcode, or type the product code and press OK',
    noReceiptUnknown: 'That item is not in this lane\'s price list. Check the barcode, or send the customer to the service desk.',
    noReceiptMax: 'No-receipt limit',
    noReceiptOverCap: 'That is above the no-receipt limit —',
    noReceiptManagerHint: 'Every return without a receipt needs a manager — a different person from the cashier',
    exchange: 'Exchange',
    member: 'Loyalty member',
    memberRemove: 'Remove loyalty member ••••{last4}',
    memberAsk: 'Customer\'s mobile number',
    memberHint: 'Key the 10-digit number the customer joined with. Points are added when the sale reaches head office.',
    memberSet: 'Member ••••{last4} is on this bill. Their points are added when the sale reaches head office.',
    memberRemoved: 'No loyalty member on this bill now.',
    exchangeNeedsBasket: 'Scan the replacement items onto the bill first, then choose Exchange.',
    exchangeCredit: 'Credit for the goods coming back',
    exchangeEven: 'Even exchange — nothing to pay, nothing to refund',
    exchangeConfirm: 'Record the exchange',
    exchangeCollect: 'Customer pays the difference',
    exchangeRefunds: 'Shop refunds the difference',
    exchangeHow: 'How does the customer pay?',
    exchangeDone: 'Exchange recorded',
    exchangeStop: 'Do not hand over the new goods',
    declinedMsg: 'The payment was declined. The sale is NOT complete — do not hand over the goods. Ask for another payment method.',
    noAnswerMsg: 'The card machine has not answered, so we do not know whether the customer has paid. The sale is NOT complete — do not hand over the goods. Check the machine, and if it is unclear, ask the manager before trying again.',
  },
  ta: {
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. பில் போடுவது வேலை செய்யும். இந்த விலைப் பட்டியல் இந்த லேனுக்குக் கடைசியாகக் கொடுக்கப்பட்டது:',
    scanToBegin: 'தொடங்க ஒரு பொருளை ஸ்கேன் செய்யவும்.', qty: 'எண்ணிக்கை', void: 'நீக்கு',
    ageQuestion: '{item} வயது வரம்புள்ள பொருள். வாடிக்கையாளரின் அடையாள அட்டையைச் சரிபார்க்கவும். வாடிக்கையாளருக்கு {age} வயது அல்லது அதற்கு மேல் ஆகிறதா?',
    ageYes: 'ஆம் — அடையாளம் சரிபார்க்கப்பட்டது, {age} அல்லது அதற்கு மேல்', ageNo: 'இல்லை — விற்க வேண்டாம்',
    ageNotSoldTitle: 'பொருள் விற்கப்படவில்லை',
    ageNotSold: 'வாடிக்கையாளர் {age} வயது அல்லது அதற்கு மேல் என்று காட்ட முடியவில்லை, எனவே {item} பில்லில் சேர்க்கப்படவில்லை. வேறு எதுவும் மாறவில்லை.',
    lane: 'லேன்', noLane: 'இந்த கவுண்டருக்கு லேன் அமைக்கப்படவில்லை', notSignedIn: 'யாரும் உள்நுழையவில்லை',
    signIn: 'உள்நுழை', signOut: 'வெளியேறு', signInTitle: 'உங்கள் பணியாளர் குறியீடு',
    signInHint: 'உங்கள் பேட்ஜை ஸ்கேன் செய்யவும் அல்லது பணியாளர் எண்ணை உள்ளிட்டு சரி அழுத்தவும். அடுத்து உங்கள் கல்லா PIN-ஐ உள்ளிடுவீர்கள்.',
    noStoreBox: 'இந்தக் கல்லா அதன் கடை கணினியுடன் இணைக்கப்படவில்லை, எனவே யாரும் உள்நுழைய முடியாது. மேலாளரிடம் சொல்லுங்கள்.',
    pinTitle: 'உங்கள் கல்லா PIN', pinHint: 'ஆறு இலக்க கல்லா PIN-ஐ உள்ளிட்டு சரி அழுத்தவும். அது ஒருபோதும் காட்டப்படாது. மறந்துவிட்டீர்களா? மேலாளரிடம் கேளுங்கள்.',
    signInRefused: 'உள்நுழையவில்லை',
    signedInAs: 'உள்நுழைந்தவர்',
    checkPayment: 'அந்தப் பணத்தை வழங்குநரிடம் சரிபார்',
    tender: 'பணம் பெறு', cancel: 'ரத்து', ok: 'சரி', quantity: 'எண்ணிக்கை',
    cashReceived: 'பெற்ற பணம்', changeDue: 'மீதம் தர வேண்டியது', online: 'இணைப்பில்',
    offline: 'இணைப்பு இல்லை', unsent: 'அனுப்பப்படாதவை', reasonForVoid: 'நீக்கக் காரணம்',
    exact: 'சரியான தொகை',
    checkingBox: 'கடைப் பெட்டியைச் சரிபார்க்கிறது…',
    boxNotAnswering: 'கடைப் பெட்டி பதிலளிக்கவில்லை — இந்த வரிசையில் விற்பனைகளைச் சேமிக்க முடியாது',
    noCloud: 'ஆஃப்லைனில் விற்பனை — தலைமை அலுவலகத்தை அடைய முடியவில்லை',
    cloudNotSetUp: 'இந்தப் பெட்டியில் தலைமை அலுவலக இணைப்பு இல்லை',
    cloudUnknown: 'தலைமை அலுவலகம் இன்னும் சரிபார்க்கப்படவில்லை',
    lastContact: 'கடைசித் தொடர்பு',
    unsentHeld: 'விற்பனை(கள்) இந்தப் பெட்டியில் சேமிக்கப்பட்டு அனுப்பக் காத்திருக்கின்றன. எதுவும் இழக்கப்படவில்லை — தலைமை அலுவலகத்தை அடைந்தவுடன் அவை செல்லும்.',
    tapLineFirst: 'முதலில் ஒரு வரியைத் தொடவும்.', scanFirst: 'முதலில் ஒரு பொருளை ஸ்கேன் செய்யவும்.',
    read: 'இதைப் படிக்கவும்', notEnough: 'போதவில்லை — வாடிக்கையாளர் இன்னும் தர வேண்டியது',
    receiptsUsedUp: 'இந்த பணப்பெட்டியின் ரசீது எண்கள் முடிந்துவிட்டன. பணம் வாங்க வேண்டாம் — புதிய எண் வரம்பை ஏற்ற மேலாளரிடம் சொல்லவும்.',
    allSent: 'இந்த லேனில் உள்ள அனைத்தும் அனுப்பப்பட்டுவிட்டன.',
    noCatalogue: 'இந்த லேனில் விலைப் பட்டியல் இல்லை. மேலாளரிடம் சொல்லவும்.',
    hold: 'நிறுத்து', recall: 'திரும்பப் பெறு', held: 'கூடை நிறுத்தப்பட்டது',
    howPaying: 'வாடிக்கையாளர் எவ்வாறு பணம் தருகிறார்?', cash: 'ரொக்கம்', card: 'கார்டு', upi: 'UPI',
    onHold: 'ஒரு கூடை நிறுத்தி வைக்கப்பட்டுள்ளது. திரும்பப் பெற தட்டவும்.',
    noneHeld: 'இந்த டில்லுக்கு நிறுத்தி வைத்த கூடை எதுவும் இல்லை.',
    recallWhich: 'எந்த நிறுத்திய கூடை?',
    noSale: 'டிராயரைத் திற (விற்பனை இல்லை)', noSaleDone: 'பதிவாகியது — டிராயரைத் திறக்கலாம்', noSaleHint: 'விற்பனை இல்லாமல் டிராயரைத் திறக்க மேலாளர் அனுமதிக்க வேண்டும்',
    priceChange: 'தேர்ந்த வரியின் விலையை மாற்று', newPrice: 'ஒரு அலகுக்கான புதிய விலை (₹) — இப்போதையதை விடக் குறைவு', priceChanged: 'விலை மாற்றப்பட்டது',
    overrideHint: 'உங்களைத் தவிர வேறு ஒரு மேலாளர் அனுமதிக்க வேண்டும்', overrideReason: 'மேலாளர்: இது ஏன் அனுமதிக்கப்படுகிறது?',
    giveUp: 'நிறுத்திய கூடையைக் கைவிடு', giveUpWhich: 'எந்த நிறுத்திய கூடை கைவிடப்படுகிறது?', whyGiveUp: 'ஏன் கைவிடப்படுகிறது?',
    givenUp: 'கூடை கைவிடப்பட்டது. உங்கள் பெயரும் காரணமும் பதிவில் இருக்கும்.',
    tapTerminal: 'கார்டு இயந்திரம் என்ன சொன்னது?',
    approved: 'ஏற்கப்பட்டது', declined: 'மறுக்கப்பட்டது', noAnswer: 'பதில் இல்லை',
    more: 'மேலும்', pickup: 'பணத்தை பெட்டகத்திற்கு', closeTill: 'டில்லை மூடு', refund: 'திரும்பப் பணம்',
    countDrawer: 'டிராயரை எண்ணவும்', counted: 'எண்ணப்பட்டது', closeTillNow: 'டில்லை மூடு',
    amountToSafe: 'பெட்டகத்திற்கு எவ்வளவு?', movedToSafe: 'பெட்டகத்திற்கு மாற்றப்பட்டது',
    over: 'அதிகம்', short: 'குறைவு', balanced: 'டிராயர் சரியாக உள்ளது.',
    needsReason: 'இந்த வித்தியாசம் பெரியது. மேலாளரிடம் சொல்ல வேண்டும். பணத்தை வைக்க வேண்டாம் — உடனே மேலாளரை அழைக்கவும்.',
    countHint: 'டிராயரில் உள்ளதை எண்ணவும். எவ்வளவு இருக்க வேண்டும் என்பதை இந்தத் திரை சொல்லாது — அது வேண்டுமென்றே.',
    takeFloat: 'ஆரம்பப் பணம் எடு (டில்லைத் திற)', floatAmount: 'டிராயரில் எவ்வளவு ஆரம்பப் பணம் போகிறது?', floatTaken: 'ஆரம்பப் பணம் எடுக்கப்பட்டது — டில் திறந்துள்ளது',
    cashSaved: 'கடை கணினியில் பதிவு செய்யப்பட்டது', cashNotSaved: 'பதிவு செய்யப்படவில்லை. பணத்தை நகர்த்த வேண்டாம்.',
    whyOut: 'டிராயர் ஏன் வித்தியாசமாக உள்ளது?', tillClosed: 'டில் மூடப்பட்டது',
    pendingCash: 'முன்பு காத்திருந்த பணப் பதிவு இப்போது பதிவு செய்யப்பட்டது.',
    cash_till_already_assigned: 'இந்த டில்லில் ஏற்கனவே ஆரம்பப் பணம் உள்ளது. மற்றொன்று எடுப்பதற்கு முன் டில்லை மூடவும்.',
    cash_till_not_held_by_this_custodian: 'இந்த டில் உங்களிடம் இல்லை. முதலில் ஆரம்பப் பணம் எடுக்கவும், அல்லது எடுத்தவரிடம் கேளுங்கள்.',
    cash_insufficient_till_cash: 'டிராயரில் அவ்வளவு இல்லை. இருப்பதை எண்ணி, பணத்தை நகர்த்தும் முன் மேலாளரிடம் சொல்லவும்.',
    cash_no_open_shift: 'இந்த டில்லில் ஆரம்பப் பணம் எடுக்கப்படவில்லை; மூடுவதற்கு ஷிப்ட் இல்லை. முதலில் ஆரம்பப் பணம் எடுக்கவும்.',
    cash_not_the_custodian: 'இந்த டில் வேறு கேஷியரிடம் உள்ளது. ஆரம்பப் பணம் எடுத்தவரே மூட வேண்டும்.',
    cash_lane_unreachable: 'கடை கணினி பதில் தரவில்லை. பணம் இன்னும் பதிவாகவில்லை — நகர்த்த வேண்டாம். சிறிது நேரத்தில் மீண்டும் முயற்சிக்கவும்.',
    cash_no_store_box: 'இந்த டில் கடை கணினியுடன் இணைக்கப்படவில்லை; பணப் பதிவு செய்ய முடியாது. மேலாளரிடம் சொல்லவும்.',
    cash_material_variance_needs_a_reason: 'டிராயர் வித்தியாசம் அனுமதிக்கப்பட்டதை விட அதிகம். டில் மூட முன் காரணம் சொல்லவும்.',
    cash_denominations_do_not_add_up: 'நீங்கள் எண்ணிய நோட்டுகளும் நாணயங்களும் மொத்தத்துடன் பொருந்தவில்லை, அல்லது இல்லாத நோட்டு உள்ளது. டிராயரை மீண்டும் எண்ணவும்.',
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
    refundCustomerId: 'கடை வரவு: லாயல்டி உறுப்பினரின் கைபேசி எண்ணை உள்ளிடவும்',
    refundCustomerHint: 'கடை வரவு என்பது வாடிக்கையாளர் கணக்கில் உள்ள பணம் — அது ஒரு பெயரிடப்பட்ட வாடிக்கையாளருக்கே செல்ல வேண்டும்',
    refundNeedCustomer: 'கடை வரவு ஒரு லாயல்டி உறுப்பினருக்கே செல்ல வேண்டும். அவர்களின் கைபேசி எண்ணை உள்ளிடவும் — அல்லது வேறு முறையைத் தேர்ந்தெடுக்கவும்.',
    split: 'பிரித்துச் செலுத்து / புள்ளிகள் / கடை வரவு',
    splitLeft: 'இன்னும் செலுத்த வேண்டியது',
    points: 'புள்ளிகள்',
    upTo: 'அதிகபட்சம்',
    splitNoMember: 'இந்த பில்லில் லாயல்டி உறுப்பினர் இல்லை, எனவே புள்ளிகள் மற்றும் கடை வரவு வழங்கப்படவில்லை. முதலில் உறுப்பினரைச் சேர்க்கவும் (மேலும் → லாயல்டி உறுப்பினர்).',
    splitWallet: 'உறுப்பினர் ••••{last4}: {points} புள்ளிகள் ({pointsValue}), கடை வரவு {credit}. {asOf} நிலவரப்படி இருப்பு.',
    pointsWhole: 'புள்ளிகள் முழுமையாகவே செலவிடப்படும்: ஒரு புள்ளி {value} மதிப்புடையது.',
    refundCondition: 'பொருளின் நிலை என்ன?',
    dispResell: 'நல்லது — அலமாரிக்குத் திரும்ப',
    dispDamaged: 'சேதம் — விற்பனைக்கு அல்ல',
    refundManagerId: 'மேலாளர்: உங்கள் அடையாள அட்டையை ஸ்கேன் செய்யவும் அல்லது ஊழியர் குறியீட்டை உள்ளிடவும்',
    refundManagerHint: 'திரும்பப் பணத்தை காசாளர் அல்லாத வேறு ஒருவர் அனுமதிக்க வேண்டும்',
    refundNeedManager: 'இந்த திரும்பப் பணத்தை ஒரு மேலாளர் அனுமதிக்க வேண்டும். உங்களை அல்ல — ஒரு மேலாளரிடம் கேளுங்கள்.',
    refundApproveReason: 'மேலாளர்: இந்த திரும்பப் பணம் ஏன் அனுமதிக்கப்படுகிறது?',
    managerPinTitle: 'மேலாளர்: உங்கள் கல்லா PIN', managerPinHint: 'மேலாளர் தனது ஆறு இலக்க கல்லா PIN-ஐ உள்ளிடுகிறார். அது ஒருபோதும் காட்டப்படாது; இந்த ஒரு திரும்பப் பணத்திற்கு மட்டுமே அனுமதி.',
    approvalRefused: 'அனுமதிக்கப்படவில்லை',
    refundDone: 'திரும்பப் பணம் பதிவு செய்யப்பட்டது',
    refundPending: 'திரும்பப் பணம் நிலுவையில்',
    refundStop: 'பணத்தைக் கொடுக்க வேண்டாம்',
    noReceipt: 'ரசீது இல்லாமல் திரும்பப் பெறல்',
    noReceiptItem: 'திரும்பும் பொருளை ஸ்கேன் செய்யவும், அல்லது அதன் குறியீட்டை உள்ளிடவும்',
    noReceiptItemHint: 'பில் இல்லை, பொருளே ஆதாரம் — அதன் பார்கோடை ஸ்கேன் செய்யவும், அல்லது பொருள் குறியீட்டை உள்ளிட்டு OK அழுத்தவும்',
    noReceiptUnknown: 'அந்தப் பொருள் இந்த லேனின் விலைப் பட்டியலில் இல்லை. பார்கோடைச் சரிபார்க்கவும், அல்லது வாடிக்கையாளரை சேவை மேசைக்கு அனுப்பவும்.',
    noReceiptMax: 'ரசீது இல்லாத வரம்பு',
    noReceiptOverCap: 'ரசீது இல்லாத வரம்பை விட அதிகம் —',
    noReceiptManagerHint: 'ரசீது இல்லாத ஒவ்வொரு திரும்பப் பெறலுக்கும் ஒரு மேலாளர் தேவை — காசாளர் அல்லாத வேறு ஒருவர்',
    exchange: 'பரிமாற்றம்',
    member: 'லாயல்டி உறுப்பினர்',
    memberRemove: 'லாயல்டி உறுப்பினரை நீக்கு ••••{last4}',
    memberAsk: 'வாடிக்கையாளரின் கைபேசி எண்',
    memberHint: 'வாடிக்கையாளர் சேர்ந்த 10 இலக்க எண்ணை உள்ளிடவும். விற்பனை தலைமை அலுவலகத்தை அடைந்ததும் புள்ளிகள் சேர்க்கப்படும்.',
    memberSet: 'உறுப்பினர் ••••{last4} இந்த பில்லில் உள்ளார். விற்பனை தலைமை அலுவலகத்தை அடைந்ததும் புள்ளிகள் சேர்க்கப்படும்.',
    memberRemoved: 'இந்த பில்லில் இப்போது லாயல்டி உறுப்பினர் இல்லை.',
    exchangeNeedsBasket: 'முதலில் மாற்றுப் பொருட்களை பில்லில் ஸ்கேன் செய்யவும், பிறகு பரிமாற்றம் தேர்வு செய்யவும்.',
    exchangeCredit: 'திரும்பும் பொருட்களுக்கான வரவு',
    exchangeEven: 'சம பரிமாற்றம் — செலுத்த வேண்டியதும் இல்லை, திரும்பத் தர வேண்டியதும் இல்லை',
    exchangeConfirm: 'பரிமாற்றத்தைப் பதிவு செய்',
    exchangeCollect: 'வாடிக்கையாளர் வித்தியாசத்தைச் செலுத்துகிறார்',
    exchangeRefunds: 'கடை வித்தியாசத்தைத் திரும்பத் தருகிறது',
    exchangeHow: 'வாடிக்கையாளர் எப்படிச் செலுத்துகிறார்?',
    exchangeDone: 'பரிமாற்றம் பதிவு செய்யப்பட்டது',
    exchangeStop: 'புதிய பொருட்களைக் கொடுக்க வேண்டாம்',
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

/** Why a held basket is given up, preset (PF-05) — kept on the store computer's record with who gave it up, never deleted. */
const GIVE_UP_REASONS = [
  { code: 'customer_left', en: 'Customer left without it', ta: 'வாடிக்கையாளர் வாங்காமல் சென்றார்' },
  { code: 'customer_no_money', en: 'Customer could not pay', ta: 'வாடிக்கையாளரால் பணம் செலுத்த முடியவில்லை' },
  { code: 'held_by_mistake', en: 'Held by mistake', ta: 'தவறாக நிறுத்தப்பட்டது' },
  { code: 'rung_again', en: 'Rung again on a new bill', ta: 'புதிய பில்லில் மீண்டும் போடப்பட்டது' },
];

/** Why the drawer is opened with no sale, preset (PF-07 · M15) — recorded with the cashier and the approving manager. */
const NO_SALE_REASONS = [
  { code: 'change_for_customer', en: 'Change for a customer', ta: 'வாடிக்கையாளருக்குச் சில்லறை' },
  { code: 'correct_last_tender', en: 'Correct the last payment', ta: 'கடைசி கட்டணத்தைச் சரிசெய்ய' },
  { code: 'check_drawer', en: 'Check the drawer', ta: 'டிராயரைச் சரிபார்க்க' },
  { code: 'other', en: 'Other', ta: 'மற்றவை' },
];

/** Why a price is lowered at the till, preset (PF-07 · M12-FR-04) — recorded with the cashier and the approving manager. */
const PRICE_CHANGE_REASONS = [
  { code: 'shelf_label_lower', en: 'Shelf label shows a lower price', ta: 'அலமாரி விலைச்சீட்டில் குறைந்த விலை' },
  { code: 'damaged_pack', en: 'Damaged pack, sold as is', ta: 'சேதமடைந்த பொதி, அப்படியே விற்பனை' },
  { code: 'near_expiry', en: 'Near expiry', ta: 'காலாவதி நெருங்குகிறது' },
  { code: 'price_match', en: 'Price match approved', ta: 'விலை ஒப்பீடு அனுமதிக்கப்பட்டது' },
];

/** Refund reasons, preset — free text at a till is a reason nobody can report on afterwards (M15). */
const REFUND_REASONS = [
  { code: 'damaged', en: 'Damaged / faulty', ta: 'சேதம் / குறை' },
  { code: 'wrong_item', en: 'Wrong item', ta: 'தவறான பொருள்' },
  { code: 'not_needed', en: 'No longer needed', ta: 'இனி தேவையில்லை' },
  { code: 'expired', en: 'Expired / out of date', ta: 'காலாவதி ஆனது' },
  { code: 'other', en: 'Other', ta: 'மற்றவை' },
];

/** Why a drawer is out at close, preset — the cash office reports on codes, never prose (M14-FR-02 · M15). */
const CASH_REASONS = [
  { code: 'wrong_change', en: 'Wrong change given', ta: 'தவறான சில்லறை கொடுக்கப்பட்டது' },
  { code: 'miscount', en: 'Miscounted', ta: 'தவறாக எண்ணப்பட்டது' },
  { code: 'float_error', en: 'The float was wrong', ta: 'ஆரம்பப் பணம் தவறு' },
  { code: 'unrecorded_movement', en: 'Cash moved without recording', ta: 'பதிவு செய்யாமல் பணம் நகர்த்தப்பட்டது' },
  { code: 'unexplained', en: 'Cannot explain', ta: 'விளக்க முடியவில்லை' },
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
    // No catalogue, so nothing restricted can be scanned; the age answers exist so the shell never calls a missing method.
    confirmAge() { throw new Error('No price list on this lane.'); }, refuseAge() { throw new Error('No price list on this lane.'); },
    ageConfirmedAtLeast: () => 0,
    // No identity without the bundle either — the stand-in says so rather than inventing a lane or a cashier.
    signIn() {}, signOut() {}, operator: () => undefined,
    lane: () => ({ laneId: null, tradingDayCutoff: '00:00', tradingDayAt: (at) => at.slice(0, 10) }),
    // No store computer, so no receipt numbers: the stand-in refuses to take money rather than mint one (audit PF-04).
    nextReceipt: () => Promise.reject(Object.assign(new Error('no store computer'), { laneMessage: 'This till has no store computer to number its bills. Do not take money — tell the manager.' })),
    tenderCash: (_id, number) => Promise.resolve(number),
    tenderCardOrUpi: ({ receiptNumber, outcome }) => (outcome === 'approved'
      ? Promise.resolve(receiptNumber)
      : Promise.reject(Object.assign(new Error('not paid'), { notPaid: outcome }))),
    suspend() { held = true; }, recall() { held = false; }, state: () => (held ? 'suspended' : 'selling'),
    newSale() { lines.length = 0; seq = 0; },
    // No real bills without the bundle, so a refund lookup finds nothing — the screen says so
    // honestly rather than pretending. The real, tested surface replaces this at build time.
    lookupRefund: () => Promise.resolve(null),
    // And no return without a receipt: the stand-in was given no cap and no catalogue, so it offers none (fail safe).
    noReceiptReturn: () => null,
    // The demo till has no store computer, so it says so the way the real one does — it never pretends to record cash.
    till: {
      moveCash: () => Promise.resolve({ committed: false, refusedBecause: 'no_store_box', laneMessage: WORDS.en.cash_no_store_box }),
      close: () => Promise.resolve({ closed: false, refusedBecause: 'no_store_box', laneMessage: WORDS.en.cash_no_store_box }),
      tillCash: () => Promise.resolve(null),
    },
  };
}

const session = window.posSession ?? demoSession();
let selectedLineId = null;

// ── Who is on the till (SP-4b · F09) ────────────────────────────────────────
//
// The header names the LANE the store box said this till is and the CASHIER who signed in — never a stand-in.
// A cashier signs in with their staff ID (scanned or keyed) and their till PIN, checked by the store computer, and is kept
// across a reload on THIS till only
// (sessionStorage: it dies with the browser session, so a till left open overnight still starts with nobody).
// With nobody signed in, or no lane, the model refuses to take payment in its own words; the header says why.
// The tab keeps the SESSION the store computer minted (ADR-0020), never the PIN and never a typed name; a reload asks the
// box whether it is still live.
const OPERATOR_KEY = 'sre-pos-operator-session';
/** How this till's store computer signs a person in ('pin' or 'verified_sign_in'), learned once at start-up. */
let tillSignInMode = null;
function rememberedOperator() {
  try { return window.sessionStorage.getItem(OPERATOR_KEY) || null; } catch { return null; }
}
function rememberOperator(id) {
  try { if (id) window.sessionStorage.setItem(OPERATOR_KEY, id); else window.sessionStorage.removeItem(OPERATOR_KEY); } catch { /* the till still works; the sign-in just does not survive a reload */ }
}
function paintOperator() {
  const lane = session.lane ? session.lane() : { laneId: null };
  const who = session.operator ? session.operator() : undefined;
  const laneWords = lane.laneId ? `${t('lane')} ${lane.laneId}` : t('noLane');
  el('lane').textContent = `${laneWords} · ${who ? `${t('signedInAs')}: ${who}` : t('notSignedIn')}`;
  el('lane').setAttribute('data-operator', who || '');
  el('lane').setAttribute('data-lane', lane.laneId || '');
  el('signin').textContent = who ? t('signOut') : t('signIn');
}
async function toggleSignIn() {
  if (session.operator && session.operator()) {
    if (session.signOutAtTill) await session.signOutAtTill(); else session.signOut();
    rememberOperator(null);
    paintOperator();
    return;
  }
  // The stand-in (no bundle) has no store computer to ask: it cannot sign anybody in.
  if (!session.signInAtTill) { tell(t('read'), t('noStoreBox')); return; }
  // On the hosted copy the person already signed in with their password; the store computer takes them from that sign-in.
  // The way this box signs people in is learned once at start-up (below) — never awaited here, because a badge scanned
  // the instant Sign in is tapped must land in an OPEN prompt (found by the PF-02 browser test: the first keystrokes were
  // lost while the till was still asking, and the box was sent a truncated staff ID).
  const by = tillSignInMode ?? await session.tillSignInBy();
  let outcome;
  if (by === 'verified_sign_in') {
    outcome = await session.signInAtTill({});
  } else {
    const staffId = await askScanOrKey({ title: t('signInTitle'), hint: t('signInHint') });
    if (staffId === null || staffId === '' || staffId === '0') return;
    const pin = await ask({ title: t('pinTitle'), mode: 'number', hint: t('pinHint'), initial: '', mask: true });
    if (pin === null || pin === '') return;
    outcome = await session.signInAtTill({ staffId: String(staffId), pin: String(pin) });
  }
  if (!outcome.signedIn) { tell(t('signInRefused'), outcome.laneMessage); paintOperator(); return; }
  rememberOperator(session.operatorToken());
  paintOperator();
  void refreshHeld();
  void reportDevices();
}

// ── The till's devices (D04-FR-05 · M12-FR-04) ──────────────────────────────
// What the scanner, printer, scale, drawer and card machine say comes from a device adapter on this till computer
// (`window.sreDevices.status()` — hardware-side, external; absent on a till with none). When the cashier signs in, its
// answer goes to the store computer for the manager's Today screen. Nothing here waits on it, and a device that has
// failed never stops a sale.
async function reportDevices() {
  const adapter = window.sreDevices;
  if (!adapter || typeof adapter.status !== 'function' || typeof session.reportDevices !== 'function') return;
  try {
    const devices = await adapter.status();
    if (Array.isArray(devices) && devices.length > 0) await session.reportDevices(devices);
  } catch {
    /* a device adapter that cannot answer is the manager's to see as "not reported", not the cashier's problem now */
  }
}

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
// What the keypad holds. For a PIN it is MASKED: the screen shows one dot per digit, the digits live only here, and they
// are gone the moment the panel closes (ADR-0020 — never shown, never stored).
let entryValue = '0';
let entryMasked = false;
const PIN_DIGITS = 6;
function paintEntry() {
  el('entry').textContent = entryMasked ? '•'.repeat(entryValue.length) : entryValue;
  if (entryMasked) el('entry').setAttribute('aria-label', `${entryValue.length} / ${PIN_DIGITS}`); else el('entry').removeAttribute('aria-label');
}
function typeIntoEntry(key) {
  const current = entryValue;
  const next = entryMasked
    ? (key === 'C' ? '' : key === '⌫' ? current.slice(0, -1) : (current.length < PIN_DIGITS ? current + key : current))
    : (key === 'C' ? '0' : key === '⌫' ? (current.length > 1 ? current.slice(0, -1) : '0') : (current === '0' ? key : current + key));
  entryValue = next;
  paintEntry();
  if (!entryMasked && onEntryChange) el('entry-hint').textContent = onEntryChange(Number(next));
}
// A till with a keyboard: a masked PIN may be keyed there too. Captured while the PIN panel is open, and only then.
function onPinKey(event) {
  if (!entryMasked || el('sheet').hidden) return;
  if (/^[0-9]$/.test(event.key)) { event.preventDefault(); event.stopPropagation(); typeIntoEntry(event.key); return; }
  if (event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); typeIntoEntry('⌫'); return; }
  if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); closeSheet(entryValue); }
}
window.addEventListener('keydown', onPinKey, true);

/**
 * Ask the cashier something, on screen.
 *
 * Resolves with the answer, or `null` if cancelled. `mode` is `'number'` (keypad) or `'choice'`
 * (preset buttons) — the two shapes every question at a till actually takes.
 */
function ask({ title, mode, hint = '', initial = '0', onChange = null, choices = VOID_REASONS, quick = [], mask = false }) {
  el('sheet-title').textContent = title;
  el('entry-hint').textContent = hint;
  entryValue = initial;
  entryMasked = mask === true;
  paintEntry();
  el('entry').hidden = mode !== 'number';
  el('keypad').hidden = mode !== 'number';
  el('reasons').hidden = mode !== 'choice';
  // The quick row (pos-cashier.md interaction budget): the values a cashier reaches for most, each ONE tap that
  // answers the question outright — a quantity of 3, the ₹500 note the customer is holding. The keypad below
  // stays for everything else, and a TYPED value still ends in OK: the quick tap is the confirm, because the
  // value on the button is the value taken; a typed one is not confirmed until the cashier has seen it.
  el('quick').hidden = mode !== 'number' || quick.length === 0;
  el('quick').replaceChildren(...(mode === 'number' ? quick : []).map((option) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = option.label;
    button.addEventListener('click', () => { closeSheet(String(option.value)); });
    return button;
  }));
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
  // A PIN leaves this screen with the answer and nowhere else.
  entryMasked = false;
  entryValue = '0';
  el('entry').textContent = '';
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
  button.addEventListener('click', () => { typeIntoEntry(key); });
  return button;
}));

el('sheet-cancel').addEventListener('click', () => { closeSheet(null); });
el('sheet-ok').addEventListener('click', () => {
  closeSheet(el('reasons').hidden ? entryValue : chosen);
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
  // What the cashier counted, note by note (M14-FR-02): the total AND the breakdown, so the cash office sees WHAT was
  // short rather than only how much. Cancelled → null.
  return new Promise((resolve) => {
    countResolve = (accepted) => resolve(accepted
      ? { totalMinor: total(), denominations: [...counts].filter(([, n]) => n > 0).map(([value, n]) => ({ denominationMinor: value, count: n })) }
      : null);
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

  // On the box (PF-05): Hold while there are items, Recall when the till is empty. The stand-in keeps its flag.
  const suspended = session.holdAtTill ? (lines.length === 0 && heldCount > 0) : (session.state && session.state() === 'suspended');
  el('hold').textContent = (session.holdAtTill ? lines.length === 0 : suspended) ? t('recall') : t('hold');
  el('empty').hidden = lines.length > 0 && !suspended;
  // A held basket must SAY it is held. A screen showing an empty basket when one is parked is how
  // the same customer's items get rung up twice.
  el('empty').textContent = suspended ? t('onHold') : t('scanToBegin');
  el('total').textContent = inr(session.payableMinor());

  paintOperator();
  paintBadge();
  publishToDisplay();
}

// ── The customer display (D04-FR-05 · M12-FR-01) ───────────────────────────
// The screen facing the customer is a second window on this till computer (customer-display.html). Each time the basket
// is drawn here, the till's own frame — lines, saving, amount to pay; nothing a customer must not see — goes to it over a
// BroadcastChannel: no network, so it works with the cable out. A display that is not open, or a browser without the
// channel, never stops a sale.
let displayChannel = null;
function publishToDisplay() {
  if (typeof session.customerDisplay !== 'function' || typeof BroadcastChannel !== 'function') return;
  try {
    if (displayChannel === null) displayChannel = new BroadcastChannel(session.customerDisplayChannelName());
    displayChannel.postMessage(session.customerDisplay());
  } catch {
    /* the display is a convenience for the customer; the sale never waits on it */
  }
}

// ── The sync badge: what the BOX knows, never what the shell assumes ────────
//
// Design system §1 rule 4: every screen shows connection state, the unsent count and last-sync freshness.
// The shell cannot know any of that on its own — it used to show "Online · Unsent: 0" from a state nothing
// ever set. The box can: it owns the outbox, drains it and pulls the catalogue, and it answers
// GET /lane/sync-status on the same socket the sale is saved through. So the badge asks the box every ten
// seconds and after every sale, and there are FOUR honest states, each with words as well as a colour
// (one man in twelve cannot tell the colours apart):
//   · the box has not been asked yet          — "Checking the store box…"
//   · the box does not answer                 — OFFLINE: a sale posted now will be refused, so say so first
//   · the box answers, head office reachable  — online, with when head office last answered
//   · the box answers, head office not        — selling offline (or no link set up): the queue holds (P-01)
// Read at each poll, not once: the box names its socket in the served page, and a box that vanishes must be noticed.
const laneBase = () => (typeof window.laneWriteBase === 'string' ? window.laneWriteBase : 'http://127.0.0.1:8090');
let box = { asked: false, reachable: false, status: null };

/** The local clock face for a box time — the person reading it is standing in the shop. */
function clock(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** The connection state the tested session records, from the box's answer (the contracts' vocabulary). */
function connectionFor(b) {
  if (!b.asked) return 'reconnecting';
  if (!b.reachable) return 'offline';
  return b.status && b.status.cloud === 'online' ? 'online' : 'degraded';
}

function paintBadge() {
  const dot = el('conn-dot');
  dot.classList.remove('offline', 'degraded', 'error', 'idle');
  let words;
  if (!box.asked) {
    dot.classList.add('idle');
    words = t('checkingBox');
  } else if (!box.reachable) {
    dot.classList.add('error');
    words = `${t('offline')} — ${t('boxNotAnswering')}`;
  } else {
    const s = box.status;
    const when = s.lastContactAt ? ` · ${t('lastContact')} ${clock(s.lastContactAt)}` : '';
    if (s.cloud === 'online') {
      words = `${t('online')}${when}`;
    } else {
      dot.classList.add(s.cloud === 'unknown' || s.cloud === 'starting' ? 'idle' : 'degraded');
      words = `${s.cloud === 'offline' ? t('noCloud') : s.cloud === 'not_configured' ? t('cloudNotSetUp') : t('cloudUnknown')}${when}`;
    }
  }
  // Words as well as a dot. A colour-only badge is invisible to one man in twelve, and this badge
  // is how a cashier knows whether the shop is behind.
  el('conn-text').textContent = words;
  // The unsent count is the BOX's — the sale was saved there, and there is where it waits.
  const unsent = box.reachable && box.status ? box.status.unsent : session.syncBadge().unsentCount;
  el('unsent').textContent = `${t('unsent')}: ${unsent}`;
}

async function refreshBadge() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 3000);
  try {
    const res = await fetch(`${laneBase()}/lane/sync-status`, { cache: 'no-store', signal: ctl.signal });
    box = res.ok ? { asked: true, reachable: true, status: await res.json() } : { asked: true, reachable: false, status: null };
  } catch {
    box = { asked: true, reachable: false, status: null };
  } finally {
    clearTimeout(timer);
  }
  if (typeof session.setConnection === 'function') session.setConnection(connectionFor(box));
  paintBadge();
}
void refreshBadge();
setInterval(() => { void refreshBadge(); }, 10_000);
// The badge's own handle, so a test (or a person at the console) can ask the box again without waiting.
window.posBadge = { refresh: refreshBadge, state: () => box };

// ── Cashier intents ─────────────────────────────────────────────────────────

el('qty').addEventListener('click', async () => {
  if (!selectedLineId) { tell(t('read'), t('tapLineFirst')); return; }
  // Tap the line, tap Qty, tap the number: three (pos-cashier.md). The keypad + OK remain for larger quantities.
  const answer = await ask({
    title: t('quantity'), mode: 'number', initial: '1',
    quick: ['2', '3', '4', '5', '6'].map((n) => ({ label: n, value: n })),
  });
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
  // The void, its value and the reason go to the store computer first (audit PF-07); the line goes only once it has them.
  if (session.voidAtTill) {
    const r = await session.voidAtTill(selectedLineId, reason);
    if (!r.ok) { tell(t('read'), r.laneMessage); return; }
  } else {
    session.voidLine(selectedLineId, reason);
  }
  selectedLineId = null;
  render();
});

/**
 * Hold and Recall (audit PF-05). With items on the till, Hold hands the basket to the STORE COMPUTER, which keeps it on
 * its disk — the till clears only once the box has it, so a reload or a power cut cannot lose a customer's basket. With
 * the till empty, Recall lists what the box holds for this till and brings one back — once; the box gives a basket to
 * one till only. The stand-in shell (no bundle) keeps the old in-memory flag.
 */
let heldCount = 0;
const heldBasketOption = (b) => ({
  value: b.billId,
  label: `${b.firstItem}${b.lineCount > 1 ? ` +${b.lineCount - 1}` : ''} · ${inr(b.valueMinor)} · ${new Date(b.heldAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
});

/**
 * Give up a held basket (PF-05's last piece): the customer left, or it was held by mistake. The cashier picks the basket
 * and a preset reason; the STORE COMPUTER records it with the signed-in person and keeps the basket on its record —
 * nothing is deleted (hard rule #6) — and it can no longer be recalled. Under More, so Recall stays one tap.
 */
async function giveUpHeldBasket() {
  const baskets = await session.heldAtTill();
  if (baskets.length === 0) { tell(t('read'), t('noneHeld')); await refreshHeld(); return; }
  const pick = await choose(t('giveUpWhich'), baskets.map(heldBasketOption));
  if (pick === null || pick === undefined) return;
  const why = await choose(t('whyGiveUp'), GIVE_UP_REASONS.map((r) => ({ value: r.code, label: r[lang] ?? r.en })));
  if (why === null || why === undefined) return;
  const r = await session.abandonAtTill(pick, why);
  tell(t('read'), r.ok ? t('givenUp') : r.laneMessage);
  await refreshHeld();
}

async function refreshHeld() {
  if (!session.heldAtTill) return;
  try { heldCount = (await session.heldAtTill()).length; } catch { heldCount = 0; }
  render();
}
el('hold').addEventListener('click', async () => {
  if (!session.holdAtTill) {
    const suspended = session.state && session.state() === 'suspended';
    if (suspended) session.recall(); else session.suspend();
    selectedLineId = null;
    render();
    return;
  }
  if (session.basket().length > 0) {
    // One tap (pos-cashier.md): on success the screen itself says the basket is on hold; only a refusal interrupts.
    const r = await session.holdAtTill();
    if (!r.ok) tell(t('read'), r.laneMessage);
  } else {
    const baskets = await session.heldAtTill();
    if (baskets.length === 0) { tell(t('read'), t('noneHeld')); return; }
    const pick = baskets.length === 1 ? baskets[0].billId : await choose(t('recallWhich'), baskets.map(heldBasketOption));
    if (pick === null || pick === undefined) return;
    const r = await session.recallAtTill(pick);
    if (!r.ok || r.repriceRequired) tell(t('read'), r.laneMessage);
  }
  selectedLineId = null;
  await refreshHeld();
});

/**
 * The one-tap cash amounts for a bill (pos-cashier.md: Tender → Cash → confirm ≤ 3): the exact amount, then the
 * notes a customer actually hands over that cover it — ₹100, ₹200, ₹500, ₹2000 — never one below the bill. Change
 * due is worked out by the same `onChange` arithmetic the keypad uses, from the model's payable; nothing here prices.
 */
function quickCash(payableMinor) {
  const rupees = payableMinor / 100;
  const notes = [100, 200, 500, 2000].filter((note) => note > rupees && note - rupees < 2000).slice(0, 3);
  return [{ label: `${t('exact')} ${inr(payableMinor)}`, value: String(rupees) }, ...notes.map((note) => ({ label: inr(note * 100), value: String(note) }))];
}

el('tender').addEventListener('click', async () => {
  const payable = session.payableMinor();
  if (payable <= 0) { tell(t('read'), t('scanFirst')); return; }

  const kind = await choose(t('howPaying'), [
    { value: 'cash', label: `${t('cash')} — ${inr(payable)}` },
    { value: 'card', label: `${t('card')} — ${inr(payable)}` },
    { value: 'upi', label: `${t('upi')} — ${inr(payable)}` },
    // A split across tenders, and a loyalty member's points and store credit (M12-FR-03 · PF-09 step 3).
    ...(session.tenderSplit ? [{ value: 'split', label: t('split') }] : []),
  ]);
  if (kind === null) return;
  if (kind === 'split') return splitPayment(payable);
  if (kind !== 'cash') return takeCardOrUpi(kind, payable);

  const changeFor = (rupees) => Math.round(rupees * 100) - payable;
  const received = await ask({
    title: `${t('cashReceived')} — ${inr(payable)}`,
    mode: 'number',
    hint: `${t('notEnough')} ${inr(payable)}`,
    onChange: (rupees) => (changeFor(rupees) < 0
      ? `${t('notEnough')} ${inr(-changeFor(rupees))}`
      : `${t('changeDue')}: ${inr(changeFor(rupees))}`),
    quick: quickCash(payable),
  });
  if (received === null) return;
  const change = changeFor(Number(received));
  if (change < 0) return; // the panel already said so, in words, as they typed

  // The receipt number comes from the store computer, saved on its disk first (audit PF-04 · M01-FR-02). If it cannot
  // give one — the range is spent, the box cannot save — the till stops: no money is taken, the manager is told.
  const receiptNumber = await takeReceiptNumber();
  if (receiptNumber === null) return;
  try {
    // Awaited, and the await is the guarantee: the receipt number does not exist until the sale is
    // on this till's disk (hard rule #1). There is nothing to print with before then.
    const receipt = await session.tenderCash(`S-${receiptNumber}`, receiptNumber, new Date().toISOString());
    tell(`${t('changeDue')}: ${inr(change)}`, withReceiptNotice(receipt));
    session.newSale();
    void refreshBadge();
    selectedLineId = null;
    render();
  } catch (e) {
    // The model's words, unchanged.
    tell(t('read'), e && e.laneMessage ? e.laneMessage : String(e && e.message ? e.message : e));
  }
});

/**
 * The next receipt number, from the store computer (audit PF-04). `null` when it gave none — the screen has then said
 * why in the box's own words (range spent, nobody signed in, it could not save or be reached) and no money is taken.
 */
async function takeReceiptNumber() {
  try {
    return await session.nextReceipt();
  } catch (e) {
    tell(t('read'), e && e.refusedBecause === 'receipt_numbers_used_up' ? t('receiptsUsedUp') : (e && e.laneMessage ? e.laneMessage : t('receiptsUsedUp')));
    return null;
  }
}

/** The receipt, with what the box last said about the numbers (running low, or no range set up) when it said anything. */
function withReceiptNotice(receipt) {
  const notice = session.receiptNotice ? session.receiptNotice() : undefined;
  return notice ? `${receipt}\n\n${notice}` : receipt;
}

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
/**
 * One card or UPI payment, through the store computer (audit PF-06): the attempt is recorded BEFORE the machine is asked,
 * and what the machine said is recorded on it. If this bill has a payment that got no answer, the cashier is offered a
 * CHECK with the provider instead of the machine — asking again is how a customer pays twice. A payment the provider
 * already confirmed for this bill is used, not charged again. Resolves to the payment's reference, or `null` (not paid —
 * the screen has said why). The stand-in shell (no bundle) only asks what the machine said.
 */
async function cardAttempt(kind, amountMinor) {
  const machine = () => choose(`${t('tapTerminal')} — ${inr(amountMinor)}`, [
    { value: 'approved', label: t('approved') },
    { value: 'declined', label: t('declined') },
    { value: 'no_answer', label: t('noAnswer') },
  ]);
  if (!session.startCardPayment) {
    const outcome = await machine();
    if (outcome === null) return null;
    if (outcome !== 'approved') { tell(t('read'), outcome === 'declined' ? t('declinedMsg') : t('noAnswerMsg')); return null; }
    return '';
  }
  let started = await session.startCardPayment(kind, amountMinor);
  if (!started.ok && started.refusedBecause === 'unresolved_payment_on_this_bill' && started.attemptId) {
    const what = await choose(started.laneMessage, [{ value: 'check', label: t('checkPayment') }, { value: 'cancel', label: t('cancel') }]);
    if (what !== 'check') return null;
    const checked = await session.checkCardPayment(started.attemptId);
    if (!checked.ok) { tell(t('read'), checked.laneMessage); return null; }
    if (checked.state === 'recovered_paid') return checked.attemptId;
    started = await session.startCardPayment(kind, amountMinor);
  }
  if (!started.ok && started.refusedBecause === 'already_paid_on_this_bill' && started.attemptId) return started.attemptId;
  if (!started.ok || !started.attemptId) { tell(t('read'), started.laneMessage); return null; }
  const outcome = await machine();
  if (outcome === null) return null;
  const answered = await session.answerCardPayment(started.attemptId, outcome);
  if (!answered.ok) { tell(t('read'), answered.laneMessage); return null; }
  // Said in the cashier's words: an unpaid sale does not commit, and the goods stay on the counter.
  if (outcome !== 'approved') { tell(t('read'), outcome === 'declined' ? t('declinedMsg') : t('noAnswerMsg')); return null; }
  return started.attemptId;
}

async function takeCardOrUpi(kind, payable) {
  const ref = await cardAttempt(kind, payable);
  if (ref === null) return;
  const outcome = 'approved';

  const receiptNumber = await takeReceiptNumber();
  if (receiptNumber === null) return;
  try {
    const receipt = await session.tenderCardOrUpi({
      saleId: `S-${receiptNumber}`, receiptNumber,
      atIsoUtc: new Date().toISOString(), kind, outcome, ...(ref ? { ref } : {}),
    });
    tell(`${t('approved')} — ${kind === 'card' ? t('card') : t('upi')}`, withReceiptNotice(receipt));
    session.newSale();
    void refreshBadge();
    selectedLineId = null;
    render();
  } catch (e) {
    tell(t('read'), e && e.laneMessage ? e.laneMessage : String(e && e.message ? e.message : e));
  }
}

/**
 * A SPLIT payment (M12-FR-03 · PF-09 step 3): part by part until the bill is covered — cash, card, UPI, and for a named
 * loyalty member their points and store credit, as far as the store computer says they may spend here now. A card or UPI
 * part is an attempt recorded on the store computer before the machine is asked (PF-06). Only the last part may be cash
 * over the amount (change). The store computer decides the points and credit again before the disk and says no, in
 * words, if its copy no longer covers them — nothing is then saved and the customer pays another way.
 */
async function splitPayment(payable) {
  let wallet = null;
  if (session.loyaltyWallet && session.loyaltyMemberLast4 && session.loyaltyMemberLast4() !== null) {
    wallet = await session.loyaltyWallet();
    if (!wallet.ok) { tell(t('read'), wallet.laneMessage); wallet = null; }
    else {
      tell(t('member'), t('splitWallet').replace('{last4}', wallet.last4 || session.loyaltyMemberLast4()).replace('{points}', String(wallet.points))
        .replace('{pointsValue}', inr(wallet.pointsValueMinor)).replace('{credit}', inr(wallet.storeCreditMinor)).replace('{asOf}', wallet.asOf ? new Date(wallet.asOf).toLocaleString() : '—'));
    }
  } else if (session.loyaltyWallet) {
    tell(t('read'), t('splitNoMember'));
  }
  const parts = [];
  let remaining = payable;
  let change = 0;
  let walletSpent = 0;
  while (remaining > 0) {
    const used = new Set(parts.map((p) => p.kind));
    const capLeft = wallet ? wallet.capRemainingMinor - walletSpent : 0;
    const pointsMax = wallet && wallet.pointValuePaise > 0
      ? Math.min(remaining, wallet.pointsValueMinor, capLeft) - (Math.min(remaining, wallet.pointsValueMinor, capLeft) % wallet.pointValuePaise) : 0;
    const creditMax = wallet ? Math.min(remaining, wallet.storeCreditMinor, capLeft) : 0;
    const kind = await choose(`${t('splitLeft')} ${inr(remaining)}`, [
      { value: 'cash', label: t('cash') },
      { value: 'card', label: t('card') },
      { value: 'upi', label: t('upi') },
      ...(pointsMax > 0 && !used.has('loyalty_points') ? [{ value: 'loyalty_points', label: `${t('points')} — ${t('upTo')} ${inr(pointsMax)}` }] : []),
      ...(creditMax > 0 && !used.has('store_credit') ? [{ value: 'store_credit', label: `${t('storeCredit')} — ${t('upTo')} ${inr(creditMax)}` }] : []),
    ]);
    if (kind === null) return;
    const max = kind === 'loyalty_points' ? pointsMax : kind === 'store_credit' ? creditMax : remaining;
    const typed = await ask({ title: `${kind === 'loyalty_points' ? t('points') : kind === 'store_credit' ? t('storeCredit') : t(kind)} — ${t('splitLeft')} ${inr(remaining)}`, mode: 'number', hint: kind === 'cash' ? `${t('notEnough')} ${inr(remaining)}` : `${t('upTo')} ${inr(max)}`, initial: kind === 'cash' ? '0' : String(max / 100),
      // One tap: the notes that cover what is left, or the most this part may be.
      quick: kind === 'cash' ? quickCash(remaining) : [{ label: `${t('upTo')} ${inr(max)}`, value: String(max / 100) }] });
    if (typed === null) return;
    const amountMinor = Math.round(Number(typed) * 100);
    if (!(amountMinor > 0)) continue;
    if (kind !== 'cash' && amountMinor > max) { tell(t('read'), `${t('upTo')} ${inr(max)}`); continue; }
    if (kind === 'loyalty_points' && amountMinor % wallet.pointValuePaise !== 0) { tell(t('read'), t('pointsWhole').replace('{value}', inr(wallet.pointValuePaise))); continue; }
    if (kind === 'card' || kind === 'upi') {
      const ref = await cardAttempt(kind, amountMinor);
      if (ref === null) return;
      parts.push({ kind, amountMinor, ...(ref ? { ref } : {}) });
    } else if (kind === 'cash') {
      // Cash over what is owed is change: the bill records what it covered, the drawer the change handed back.
      const covered = Math.min(amountMinor, remaining);
      change = amountMinor - covered;
      parts.push({ kind, amountMinor: covered });
    } else {
      walletSpent += amountMinor;
      parts.push({ kind, amountMinor });
    }
    remaining -= Math.min(amountMinor, remaining);
  }
  const receiptNumber = await takeReceiptNumber();
  if (receiptNumber === null) return;
  try {
    const receipt = await session.tenderSplit({ saleId: `S-${receiptNumber}`, receiptNumber, atIsoUtc: new Date().toISOString(), parts });
    tell(change > 0 ? `${t('changeDue')}: ${inr(change)}` : t('approved'), withReceiptNotice(receipt));
    session.newSale();
    void refreshBadge();
    selectedLineId = null;
    render();
  } catch (e) {
    tell(t('read'), e && e.laneMessage ? e.laneMessage : String(e && e.message ? e.message : e));
  }
}

el('more').addEventListener('click', async () => {
  // What the till can do next depends on whether a float is out — asked of the STORE COMPUTER, which is the only thing
  // that knows after a reload (SP-4c). With no answer, everything is offered and the store computer says no if it must.
  const cash = await session.till.tillCash();
  const options = [
    ...(cash === null || !cash.shiftOpen ? [{ value: 'float', label: t('takeFloat') }] : []),
    ...(cash === null || cash.shiftOpen ? [{ value: 'pickup', label: t('pickup') }] : []),
    { value: 'refund', label: t('refund') },
    // An EXCHANGE — goods back against a bill, new goods out, the difference settled (SP-9b-ii · M13-FR-03).
    { value: 'exchange', label: t('exchange') },
    // A return WITHOUT a receipt is offered only when the store computer gave this till a no-receipt cap and a price
    // list to name the item from (SP-9b-i · M13-FR-01). Without them the option is not there — the till never guesses a limit.
    ...(session.noReceiptReturn && session.noReceiptReturn() !== null ? [{ value: 'no_receipt', label: t('noReceipt') }] : []),
    // PF-05: a held basket can be given up, with a reason — offered only when the store computer holds one for this till.
    ...(session.abandonAtTill && heldCount > 0 ? [{ value: 'give_up', label: t('giveUp') }] : []),
    ...(cash === null || cash.shiftOpen ? [{ value: 'close', label: t('closeTill') }] : []),
    // SUPERVISOR OVERRIDES (PF-07 · M12-FR-04): each needs a manager's approval and is recorded on the store computer
    // first. Changing a price needs a selected line.
    ...(session.noSaleAtTill ? [{ value: 'no_sale', label: t('noSale') }] : []),
    ...(session.priceChangeAtTill && selectedLineId ? [{ value: 'price_change', label: t('priceChange') }] : []),
    // The customer's loyalty membership, by the mobile number they joined with (PF-09 step 2 · OB-28 "1").
    ...(session.setLoyaltyMobile === undefined ? [] : session.loyaltyMemberLast4() === null
      ? [{ value: 'member', label: t('member') }]
      : [{ value: 'member_remove', label: t('memberRemove').replace('{last4}', session.loyaltyMemberLast4()) }]),
  ];
  const what = await choose(t('more'), options);
  if (what === 'float') return takeFloat();
  if (what === 'pickup') return takeCashToSafe();
  if (what === 'refund') return startRefund();
  if (what === 'exchange') return startExchange();
  if (what === 'no_receipt') return startNoReceiptReturn();
  if (what === 'close') return closeTheTill();
  if (what === 'give_up') return giveUpHeldBasket();
  if (what === 'member') return nameLoyaltyMember();
  if (what === 'no_sale') return openDrawerNoSale();
  if (what === 'price_change') return changeLinePrice();
  if (what === 'member_remove') { session.setLoyaltyMobile(null); tell(t('member'), t('memberRemoved')); return undefined; }
});

/**
 * Open the drawer with NO SALE (PF-07 · M15-FR-01): a manager approves with their own PIN, the store computer records it
 * with the cashier and the manager, and only then is the cashier told to open the drawer. No approval, no record — no drawer.
 */
async function openDrawerNoSale() {
  const approval = await managerApproves({ kind: 'no_sale', valueMinor: 0, hint: t('noSaleHint'), reasons: NO_SALE_REASONS, reasonTitle: 'overrideReason' });
  if (!approval) return;
  const r = await session.noSaleAtTill(approval.reason, { approvalId: approval.approvalId });
  tell(r.ok ? t('noSaleDone') : t('read'), r.laneMessage);
}

/**
 * Lower the selected line's price (PF-07 · M12-FR-04): the new unit price, a manager's approval for exactly what it takes
 * off the line, recorded on the store computer — and only then does the line change.
 */
async function changeLinePrice() {
  const lineId = selectedLineId;
  if (!lineId) { tell(t('read'), t('tapLineFirst')); return; }
  const typed = await ask({ title: t('newPrice'), mode: 'number', initial: '' });
  if (typed === null || typed === '') return;
  const toUnitMinor = Math.round(Number(typed) * 100);
  const value = session.priceChangeValue(lineId, toUnitMinor);
  if (!value.ok) { tell(t('read'), value.laneMessage); return; }
  const approval = await managerApproves({ kind: 'price_override', billRef: session.currentBillRef(), valueMinor: value.reductionMinor, hint: t('overrideHint'), reasons: PRICE_CHANGE_REASONS, reasonTitle: 'overrideReason' });
  if (!approval) return;
  const r = await session.priceChangeAtTill(lineId, toUnitMinor, approval.reason, { approvalId: approval.approvalId });
  if (!r.ok) { tell(t('read'), r.laneMessage); return; }
  tell(t('priceChanged'), r.laneMessage);
  render();
}

/**
 * Name the loyalty member on this bill by the mobile number they joined with (PF-09 step 2). Keyed on the till's own
 * keypad; the number stays in this page's memory and goes to the store computer with the sale, which turns it into the
 * member code before anything is written. Only the last four digits are ever shown.
 */
async function nameLoyaltyMember() {
  const typed = await ask({ title: t('memberAsk'), mode: 'number', hint: t('memberHint'), initial: '' });
  if (typed === null || typed === '' || typed === '0') return;
  const outcome = session.setLoyaltyMobile(String(typed));
  if (!outcome.ok) { tell(t('member'), outcome.laneMessage); return; }
  tell(t('member'), t('memberSet').replace('{last4}', outcome.last4));
}

// ── Cash on the store computer (SP-4c · F10 · M14-FR-01) ─────────────────────────────────────────────────────────────
//
// The till keeps NO cash figure of its own: every float, pickup and the close is recorded on the store computer, durably,
// before the cashier is told "recorded" — a browser tab dies with a reload, and that is exactly how a float used to
// vanish. A movement the store computer could not be asked about (it did not answer) is kept HERE, with its own id, until
// it is acknowledged: the next cash action sends it again first, and the store computer answers "already recorded" for a
// repeat — so the money moves once however many times the till has to ask (owner directive §2, §31.1).
const PENDING_CASH_KEY = 'sre-pos-pending-cash';
function pendingCash() {
  try { const raw = window.sessionStorage.getItem(PENDING_CASH_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function rememberPendingCash(req) {
  try { if (req) window.sessionStorage.setItem(PENDING_CASH_KEY, JSON.stringify(req)); else window.sessionStorage.removeItem(PENDING_CASH_KEY); } catch { /* the store computer still has the record; only the retry memory is lost */ }
}
/** The refusal in the cashier's language where the till has words for it; otherwise the store computer's own sentence. */
function cashWords(outcome) {
  return (outcome.refusedBecause && WORDS[lang][`cash_${outcome.refusedBecause}`]) || outcome.laneMessage;
}
async function sendCash(req) {
  const outcome = await session.till.moveCash(req);
  rememberPendingCash(!outcome.committed && outcome.refusedBecause === 'lane_unreachable' ? req : null);
  return outcome;
}
/** Anything still waiting from before goes first, under its own id. False when the store computer still does not answer. */
async function flushPendingCash() {
  const pending = pendingCash();
  if (!pending) return true;
  const outcome = await sendCash(pending);
  if (!outcome.committed && outcome.refusedBecause === 'lane_unreachable') { tell(t('cashNotSaved'), cashWords(outcome)); return false; }
  if (outcome.committed) tell(t('pendingCash'), `${inr(pending.amountMinor)} — ${t('cashSaved')}`);
  return true;
}
async function moveCashToBox(kind, titleKey, doneKey) {
  if (!(await flushPendingCash())) return;
  const amount = await ask({ title: t(titleKey), mode: 'number' });
  if (amount === null) return;
  const minor = Math.round(Number(amount) * 100);
  if (minor <= 0) return;
  try {
    const outcome = await sendCash({ kind, amountMinor: minor, at: new Date().toISOString(), movementId: `cm-${kind}-${Date.now().toString(36)}` });
    if (outcome.committed) tell(t(doneKey), `${inr(minor)} — ${t('cashSaved')}`);
    else tell(t('cashNotSaved'), cashWords(outcome));
  } catch (e) {
    // Nobody signed in, or no lane: the model refuses before the store computer is asked, in its own words (F09).
    tell(t('read'), e && e.laneMessage ? e.laneMessage : String(e && e.message ? e.message : e));
  }
}
const takeFloat = () => moveCashToBox('float_issue', 'floatAmount', 'floatTaken');
const takeCashToSafe = () => moveCashToBox('pickup', 'amountToSafe', 'movedToSafe');

/**
 * Ask for a receipt number or a staff code — SCANNED or keyed (the owner chose both). The receipt
 * carries a barcode and a staff badge carries a barcode, so a scan (fast keystrokes ending in Enter)
 * resolves at once; the on-screen number pad is the fallback for keying it by hand. The scan capture
 * is SCOPED to this panel and removed when it closes, so it never leaks into the sale screen's global
 * scanner (which stays off while a panel is open).
 */
function askScanOrKey({ title, hint = '' }) {
  // The button that opened this prompt must NOT keep focus: a scanner ends its code with Enter, and Enter on a focused
  // button is a click — the sign-in button would sign the cashier straight back out (found by the F09 browser test).
  if (document.activeElement && typeof document.activeElement.blur === 'function') document.activeElement.blur();
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
 * A MANAGER approves, here, for this one refund (ADR-0021 · §28): their badge or staff ID, their OWN six-digit till PIN
 * (masked, never kept), and why. The store computer checks the PIN and the manager's authority, refuses the cashier
 * approving themselves, and issues an approval bound to this kind, bill, amount and cashier, used once. Resolves the
 * approval for the refund to carry, or `null` once the cashier has been told why not.
 */
async function managerApproves({ kind, billRef, valueMinor, hint, reasons = REFUND_REASONS, reasonTitle = 'refundApproveReason' }) {
  if (!session.approveAtTill) { tell(t('read'), t('noStoreBox')); return null; }
  const by = await askScanOrKey({ title: t('refundManagerId'), hint });
  if (by === null || by === '' || by === '0') { tell(t('read'), t('refundNeedManager')); return null; }
  const pin = await ask({ title: t('managerPinTitle'), mode: 'number', hint: t('managerPinHint'), initial: '', mask: true });
  if (pin === null || pin === '') { tell(t('read'), t('refundNeedManager')); return null; }
  const reason = await ask({ title: t(reasonTitle), mode: 'choice', choices: reasons });
  if (!reason) return null;
  const outcome = await session.approveAtTill({ managerId: String(by), pin: String(pin), kind, ...(billRef ? { billRef } : {}), valueMinor, reason });
  if (!outcome.approved) { tell(t('approvalRefused'), outcome.laneMessage); return null; }
  return { by: outcome.approvedBy, reason, approvalId: outcome.approvalId };
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
    value: l.productId, label: `${descOf(l.productId)} — ${t('refundCanReturn')} ${l.returnableMinor}`,
  })));
  if (productId === null) return;
  const line = returnable.find((l) => l.productId === productId);

  const qtyAns = await ask({
    title: `${t('refundHowMany')} — ${descOf(productId)}`, mode: 'number', initial: '1',
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

  // 4a. Store credit is money on the customer's account, so it must go to a NAMED customer (M13-FR-03).
  // Capture them scanned or keyed; if none is given, the credit cannot be issued to nobody — stop and
  // say so (the engine and the cloud both refuse a store-credit refund with no customer).
  let customerRef;
  if (refundTender === 'store_credit') {
    const who = await askScanOrKey({ title: t('refundCustomerId'), hint: t('refundCustomerHint') });
    if (who === null || who === '' || who === '0') { tell(t('read'), t('refundNeedCustomer')); return; }
    customerRef = String(who);
  }

  // 5. A manager approves where the policy requires it (§28). The default is every refund; a manager
  // scans their badge or keys their staff code — a DIFFERENT person from the cashier, which the engine
  // enforces and the cloud re-verifies on sync.
  let approval;
  if (bill.needsApproval(refundMinor)) {
    approval = await managerApproves({ kind: 'refund', billRef: bill.sale.saleId, valueMinor: refundMinor, hint: t('refundManagerHint') });
    if (approval === null) return;
  }

  // 6. The refund's own document number, from this lane's gap-free range, and its operation identity
  // (the idempotency key — a retry under the same id can never refund twice, RR-F03).
  const number = await takeReceiptNumber();
  if (number === null) return;
  const returnId = `RT-${number}`;

  let outcome;
  try {
    outcome = await bill.submit({
      returnId, number, reasonCode: reason,
      lines: [{ productId, uom: line.uom, quantityMinor: qty, disposition }],
      refundMinor, refundTender,
      ...(approval ? { approval } : {}),
      ...(customerRef ? { customerRef } : {}),
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
 * The EXCHANGE (SP-9b-ii · M13-FR-03): goods coming back against a bill, new goods going out, the difference settled.
 *
 * The cashier rings the REPLACEMENT goods onto the bill first — so they are priced, promoted, age-checked and
 * MRP-capped exactly as any sale (one commerce truth, P-02) — then chooses Exchange, finds the customer's bill and
 * says what is coming back. The till quotes: the credit at the bill's OWN price, the replacement as rung, and which
 * way the difference goes. Even → nothing changes hands. The customer owes → they pay the difference (cash, or what
 * the card machine said). The shop owes → it refunds the difference by the refund's own rules, a manager approving
 * where the policy says so (§28) — the money that actually leaves is what is judged, never the credit. Everything is
 * decided before anything is written; the credit is recorded first, then the replacement sale paid with it. If the
 * second half cannot be recorded, the screen SAYS so (do not hand over the new goods) rather than pretending.
 */
async function startExchange() {
  // 0. The replacement must already be on the bill.
  if (session.basket().filter((l) => !l.voided).length === 0) { tell(t('read'), t('exchangeNeedsBasket')); return; }

  // 1. Find the customer's bill — scan the receipt, or key the bill number.
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
  if (!bill.exchange) { tell(t('read'), t('refundNotFound')); return; }
  const returnable = bill.returnable.filter((l) => l.returnableMinor > 0);
  if (returnable.length === 0) { tell(t('read'), t('refundNothingLeft')); return; }

  // 2. What is coming back, and how many — capped at what is still returnable on the bill.
  const productId = await choose(t('refundWhichItem'), returnable.map((l) => ({
    value: l.productId, label: `${descOf(l.productId)} — ${t('refundCanReturn')} ${l.returnableMinor}`,
  })));
  if (productId === null) return;
  const line = returnable.find((l) => l.productId === productId);
  const qtyAns = await ask({
    title: `${t('refundHowMany')} — ${descOf(productId)}`, mode: 'number', initial: '1',
    hint: `${t('refundCanReturn')}: ${line.returnableMinor}`,
  });
  if (qtyAns === null) return;
  const qty = Number(qtyAns);
  if (!Number.isInteger(qty) || qty <= 0 || qty > line.returnableMinor) { tell(t('read'), t('refundBadQty')); return; }

  // 3. Reason (chosen, never typed — M15) and the condition the goods come back in (M13-FR-02).
  const reason = await ask({ title: t('refundReason'), mode: 'choice', choices: REFUND_REASONS });
  if (!reason) return;
  const disposition = await choose(t('refundCondition'), [
    { value: 'resell', label: t('dispResell') },
    { value: 'damaged', label: t('dispDamaged') },
  ]);
  if (disposition === null) return;
  const returnLines = [{ productId, uom: line.uom, quantityMinor: qty, disposition }];

  // 4. The quote — the engine's arithmetic over the bill's history and the goods on the bill now. Nothing recorded.
  const quote = bill.exchange.quote(returnLines);
  if (!quote.ok) { tell(t('read'), quote.detail); return; }

  // 5. Settle the difference — the customer's way in, or the shop's way out (with a manager where §28 says so).
  const settlement = {};
  let approval;
  const credit = `${t('exchangeCredit')}: ${inr(quote.returnedValueMinor)}`;
  if (quote.balance === 'even') {
    const go = await choose(`${credit} — ${t('exchangeEven')}`, [{ value: 'go', label: t('exchangeConfirm') }]);
    if (go === null) return;
  } else if (quote.balance === 'top_up') {
    const kind = await choose(`${credit} — ${t('exchangeCollect')}: ${inr(quote.balanceMinor)} — ${t('exchangeHow')}`, [
      { value: 'cash', label: t('cash') },
      { value: 'card', label: t('card') },
      { value: 'upi', label: t('upi') },
    ]);
    if (kind === null) return;
    settlement.topUp = { kind };
    if (kind !== 'cash') {
      // Through the store computer, recorded before the machine is asked — silence is NOT approval (M12-FR-03 · PF-06).
      const ref = await cardAttempt(kind, quote.balanceMinor);
      if (ref === null) return;
      settlement.topUp.outcome = 'approved';
      if (ref) settlement.topUp.ref = ref;
    }
  } else {
    const refundTender = await choose(`${credit} — ${t('exchangeRefunds')}: ${inr(quote.balanceMinor)} — ${t('refundHow')}`, [
      { value: 'cash', label: t('cash') },
      { value: 'card', label: t('card') },
      { value: 'upi', label: t('upi') },
      { value: 'store_credit', label: t('storeCredit') },
    ]);
    if (refundTender === null) return;
    settlement.refundTender = refundTender;
    if (refundTender === 'store_credit') {
      const who = await askScanOrKey({ title: t('refundCustomerId'), hint: t('refundCustomerHint') });
      if (who === null || who === '' || who === '0') { tell(t('read'), t('refundNeedCustomer')); return; }
      settlement.customerRef = String(who);
    }
    if (quote.needsApproval) {
      approval = await managerApproves({ kind: 'exchange_refund', billRef: bill.sale.saleId, valueMinor: quote.balanceMinor, hint: t('refundManagerHint') });
      if (approval === null) return;
    }
  }

  // 6. Two documents from this lane's gap-free range: the return (the credit) and the replacement sale's receipt.
  const number = await takeReceiptNumber();
  if (number === null) return;
  const replacementReceipt = await takeReceiptNumber();
  if (replacementReceipt === null) return;

  let outcome;
  try {
    outcome = await bill.exchange.complete({
      exchangeId: `RT-${number}`, number, reasonCode: reason, returnLines,
      replacementSaleId: `S-${replacementReceipt}`, replacementReceipt,
      settlement,
      ...(approval ? { approval } : {}),
    });
  } catch (e) {
    tell(t('exchangeStop'), e && e.laneMessage ? e.laneMessage : String(e && e.message ? e.message : e));
    return;
  }
  if (outcome.kind === 'done') {
    tell(t('exchangeDone'), `${outcome.laneMessage} ${outcome.number} · ${outcome.replacementReceipt}`);
    session.newSale();
    void refreshBadge();
    selectedLineId = null;
    render();
    return;
  }
  if (outcome.kind === 'half_done') { tell(t('exchangeStop'), outcome.laneMessage); return; }
  showRefundOutcome(outcome);
}

/**
 * The return WITHOUT a receipt (SP-9b-i · M13-FR-01). The same honesty as the refund, with the three controls that
 * replace the bill: the item is named from this lane's own price list (scanned or keyed — a delisted item can still
 * come back), the amount is capped at the limit the store computer gave this till, and a manager ALWAYS approves
 * (a different person, §28). The engine refuses an amount above the cap and a missing approver before anything is
 * written; the cloud re-checks all three when the return reaches it and shows a breach on the exceptions screen.
 */
async function startNoReceiptReturn() {
  const desk = session.noReceiptReturn ? session.noReceiptReturn() : null;
  if (!desk) { tell(t('read'), t('noReceiptUnknown')); return; }

  // 1. The item — the only evidence there is. Scanned, or its code keyed.
  const code = await askScanOrKey({ title: t('noReceiptItem'), hint: t('noReceiptItemHint') });
  if (code === null || code === '' || code === '0') return;
  const item = desk.findProduct(String(code));
  if (!item) { tell(t('read'), t('noReceiptUnknown')); return; }

  // 2. How many.
  const qtyAns = await ask({ title: `${t('refundHowMany')} — ${item.name}`, mode: 'number', initial: '1' });
  if (qtyAns === null) return;
  const qty = Number(qtyAns);
  if (!Number.isInteger(qty) || qty <= 0) { tell(t('read'), t('refundBadQty')); return; }

  // 3. Reason (chosen, never typed — M15) and the condition the goods come back in (M13-FR-02).
  const reason = await ask({ title: t('refundReason'), mode: 'choice', choices: REFUND_REASONS });
  if (!reason) return;
  const disposition = await choose(t('refundCondition'), [
    { value: 'resell', label: t('dispResell') },
    { value: 'damaged', label: t('dispDamaged') },
  ]);
  if (disposition === null) return;

  // 4. The amount — shown against the no-receipt limit as they type, and stopped here if it is above it.
  const amount = await ask({
    title: t('refundAmount'), mode: 'number',
    hint: `${t('noReceiptMax')}: ${inr(desk.capMinor)}`,
    onChange: (rupees) => (Math.round(rupees * 100) > desk.capMinor
      ? `${t('noReceiptOverCap')} ${inr(desk.capMinor)}`
      : `${t('refundGiving')}: ${inr(Math.round(rupees * 100))}`),
  });
  if (amount === null) return;
  const refundMinor = Math.round(Number(amount) * 100);
  if (refundMinor <= 0) return;
  if (refundMinor > desk.capMinor) { tell(t('read'), `${t('noReceiptOverCap')} ${inr(desk.capMinor)}`); return; }

  const refundTender = await choose(t('refundHow'), [
    { value: 'cash', label: t('cash') },
    { value: 'card', label: t('card') },
    { value: 'upi', label: t('upi') },
    { value: 'store_credit', label: t('storeCredit') },
  ]);
  if (refundTender === null) return;

  // 4a. Store credit must go to a NAMED customer (M13-FR-03) — the same rule as the receipted refund.
  let customerRef;
  if (refundTender === 'store_credit') {
    const who = await askScanOrKey({ title: t('refundCustomerId'), hint: t('refundCustomerHint') });
    if (who === null || who === '' || who === '0') { tell(t('read'), t('refundNeedCustomer')); return; }
    customerRef = String(who);
  }

  // 5. A manager, ALWAYS (§28) — their badge or staff ID AND their own till PIN, checked by the store computer, which
  // issues an approval for this one return (ADR-0021); the cloud re-verifies the authority on sync.
  const approval = await managerApproves({ kind: 'no_receipt_return', valueMinor: refundMinor, hint: t('noReceiptManagerHint') });
  if (approval === null) return;

  // 6. The document number from this lane's gap-free range, and the operation identity (idempotency key, RR-F03).
  const number = await takeReceiptNumber();
  if (number === null) return;
  const returnId = `RT-${number}`;

  let outcome;
  try {
    outcome = await desk.submit({
      returnId, number, reasonCode: reason, noReceipt: true,
      lines: [{ productId: item.productId, uom: item.uom, quantityMinor: qty, disposition }],
      refundMinor, refundTender,
      approval,
      ...(customerRef ? { customerRef } : {}),
    });
  } catch (e) {
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
  if (!(await flushPendingCash())) return;
  const count = await countDrawer();
  if (count === null) return;
  const counted = count.totalMinor;
  const shiftId = `sh-${Date.now().toString(36)}`;
  const closedAt = new Date().toISOString();
  try {
    // Exactly what a cashier knows — which shift, when, what was counted (and in which notes). The store computer works
    // every other figure out from what it recorded and answers with the difference (SP-4c · F10). The same shift id is
    // sent again with a reason, so the store computer sees ONE close.
    let result = await session.till.close({ shiftId, closedAt, countedMinor: counted, denominations: count.denominations });
    if (!result.closed && result.refusedBecause === 'material_variance_needs_a_reason') {
      // The count is made, so the difference can be shown; a reason is a CODE the cash office can report on, never prose.
      const out = result.varianceMinor ?? 0;
      const reasonCode = await ask({ title: `${out > 0 ? t('over') : t('short')} ${inr(Math.abs(out))} — ${t('whyOut')}`, mode: 'choice', choices: CASH_REASONS });
      if (reasonCode === null) { tell(t('read'), t('needsReason')); return; }
      result = await session.till.close({ shiftId, closedAt, countedMinor: counted, denominations: count.denominations, reasonCode });
    }
    if (!result.closed) { tell(t('read'), cashWords(result)); return; }
    const variance = result.varianceMinor;
    const headline = variance === 0 ? t('balanced')
      : variance > 0 ? `${t('over')} ${inr(variance)}`
        : `${t('short')} ${inr(-variance)}`;
    // A material difference is not a number to note down — it is an instruction to call the manager before the money is
    // put away. The store computer has recorded it and the cash office will see it.
    tell(headline, result.exceptionRaised ? t('needsReason') : `${t('tillClosed')} — ${t('counted')}: ${inr(counted)}`);
  } catch (e) {
    // Nobody signed in, or no lane: refused before the store computer is asked, in the model's words (F09).
    tell(t('read'), e && e.laneMessage ? e.laneMessage : t('needsReason'));
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

el('signin').addEventListener('click', () => { void toggleSignIn(); });
// A reload keeps the cashier who signed in on THIS till (F09 reload test) — re-applied to the real session before paint.
{
  const remembered = rememberedOperator();
  if (session.tillSignInBy) void session.tillSignInBy().then((mode) => { tillSignInMode = mode; });
  // Ask the store computer whether the session this tab kept is still live; a session it no longer knows signs nobody in.
  if (remembered && session.resumeAtTill && !(session.operator && session.operator())) {
    void session.resumeAtTill(remembered).then((live) => { if (!live) rememberOperator(null); paintOperator(); render(); if (live) void refreshHeld(); });
  }
}

el('unsent').addEventListener('click', () => {
  const unsent = box.reachable && box.status ? box.status.unsent : session.syncBadge().unsentCount;
  tell(`${t('unsent')}: ${unsent}`, unsent === 0 ? t('allSent') : `${unsent} ${t('unsentHeld')}`);
});

// ── The scanner ─────────────────────────────────────────────────────────────
//
// A retail barcode scanner is a keyboard: it types the digits very fast and presses Enter. So there
// is deliberately **no input box to focus** — losing focus is how a scan goes into whatever was
// last tapped, which at a till is a quantity field, and a barcode typed into a quantity is a sale
// of nine hundred million units. Digits are collected globally and flushed on Enter.
let scanBuffer = '';

/**
 * Ask the age question (M12-FR-04 · Wave 2b audit PF-03) on the big-button panel — two answers, nothing else on screen.
 * The item is NOT on the bill while this is open: the session refused it. "Yes" records the answer in the signed-in
 * cashier's name and scans the item again; "No" records the refusal (loss-prevention evidence) and says the item was not
 * sold; Cancel adds nothing and records nothing. The commit checks the answer again before the money is taken.
 */
async function askAge(refusal, retry) {
  const fill = (words) => words.replace('{item}', refusal.description).replace(/\{age\}/g, String(refusal.minimumAge));
  const answer = await choose(fill(t('ageQuestion')), [
    { label: fill(t('ageYes')), value: 'yes' },
    { label: t('ageNo'), value: 'no' },
  ]);
  if (answer === null) return; // backed out: nothing added, nothing recorded
  const at = new Date().toISOString();
  try {
    if (answer === 'yes') {
      session.confirmAge(refusal.minimumAge, at, refusal.productId);
      retry();
      render();
      return;
    }
    session.refuseAge(refusal.minimumAge, at, refusal.productId);
  } catch (e) {
    tell(t('read'), e && e.laneMessage ? e.laneMessage : String(e && e.message ? e.message : e));
    return;
  }
  render();
  tell(t('ageNotSoldTitle'), fill(t('ageNotSold')));
}
window.addEventListener('keydown', (event) => {
  // A panel is open; the scan is not for us.
  if (!el('sheet').hidden || !el('pay').hidden || !el('count').hidden || !el('refusal').hidden) return;
  if (event.key === 'Enter') {
    const code = scanBuffer;
    scanBuffer = '';
    if (code.length < 6) return; // a person pressing Enter, not a scanner
    // A scanner ends every code with Enter, and Enter on a FOCUSED button presses it: the button last tapped — the
    // language toggle, Void, Tender — would be pressed by the next scan. The Enter belongs to the scan, so it stops here.
    event.preventDefault();
    if (!session.hasCatalogue()) { tell(t('read'), t('noCatalogue')); return; }
    try {
      session.scanBarcode(code);
      render();
    } catch (e) {
      // An age-restricted item with no confirmed answer in this basket: the session refused to add it (PF-03). Ask, and
      // scan again only on a yes.
      if (e && e.name === 'AgeCheckRequiredError') { void askAge(e, () => session.scanBarcode(code)); return; }
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
