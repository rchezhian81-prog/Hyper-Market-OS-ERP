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

// ── Words and marks on the page's own controls (OB-205) ─────────────────────
//
// Every icon comes from the one set (`window.sreIcon`, design system §3.4) and sits beside its word; with no set loaded
// the word alone is shown, which is always enough. Each control is drawn ONCE and afterwards only its words change —
// and only when they differ — so drawing the bill after a scan creates no icon and changes nothing it need not.
/** The set's icon, or null when the set is not loaded. */
function mark(name, size = 22) {
  return typeof window.sreIcon === 'function' ? window.sreIcon(name, size) : null;
}
/** Set an element's words, touching the page only when they changed. */
function setText(id, words) {
  const node = el(id);
  if (node.textContent !== words) node.textContent = words;
}
/** A button's word (in its `.label`) and, when named, its icon in front of it — redrawn only when either changed. */
function setLabel(id, words, icon) {
  const button = el(id);
  let label = button.querySelector(':scope > .label');
  if (!label) {
    label = document.createElement('span');
    label.className = 'label';
    label.textContent = button.textContent;
    button.replaceChildren(label);
  }
  if (icon) {
    const had = label.previousElementSibling;
    if (!had || had.getAttribute('data-icon') !== icon) {
      const svg = mark(icon);
      if (svg && had) had.replaceWith(svg); else if (svg) button.prepend(svg);
    }
  }
  if (words !== undefined && label.textContent !== words) label.textContent = words;
}
/** The icon at the front of a status line (the empty bill, the age check's label), swapped only when it changed. */
function setLeadIcon(node, icon, size) {
  const had = node.firstElementChild && node.firstElementChild.tagName.toLowerCase() === 'svg' ? node.firstElementChild : null;
  if (had && had.getAttribute('data-icon') === icon) return;
  const svg = mark(icon, size);
  if (svg && had) had.replaceWith(svg); else if (svg) node.prepend(svg);
}

// ── Words ───────────────────────────────────────────────────────────────────
//
// Tamil is a first language for much of the floor staff, not a translation afterthought. Numbers
// are never translated — a total is a total in both.
const WORDS = {
  en: {
    staleShell: 'No connection to the store computer. Billing still works. This price list is what this lane was last given, at',
    offersRefused: 'Offers this till does not apply, because they would give a carry bag free (a bag is always sold at its price). Tell the manager:',
    batch: 'Batch', scanToBegin: 'Scan an item to begin.', qty: 'Qty', void: 'Void', tender: 'Tender',
    // The bill's own words (OB-205): the column heads, the total's name, a voided line's tag, the age check's label, and
    // what the drawer count's − and + buttons say to a screen reader.
    item: 'Item', amount: 'Amount', totalToPay: 'Total to pay', voided: 'Voided', ageCheck: 'Age check — ask for ID',
    oneMore: 'one more', oneFewer: 'one fewer',
    // The age question (M12-FR-04 · Wave 2b PF-03): asked BEFORE the item joins the bill, answered in the signed-in
    // cashier's name. {item} and {age} are filled in from the product the till just scanned.
    ageQuestion: '{item} is age restricted. Check the customer\'s identification. Is the customer {age} or over?',
    ageYes: 'Yes — ID checked, {age} or over', ageNo: 'No — do not sell',
    ageNotSoldTitle: 'Item not sold',
    cannotSellTitle: 'Cannot be sold',
    ageNotSold: 'The customer could not show they are {age} or over, so {item} was not added to the bill. Nothing else changes.',
    // B8 (OB-298): a perishable whose barcode carries no date — the cashier looks at the date printed on the pack, one tap.
    packDateCheck: 'Date check — look at the pack',
    packDateQuestion: '{item} is perishable. Look at the use-by / expiry date printed on the pack. Is it still in date today?',
    packDateYes: 'Yes — date is good', packDateNo: 'No — past its date, do not sell',
    packDateNotSoldTitle: 'Item not sold',
    packDateNotSold: 'The date on the pack of {item} has passed, so it was not added to the bill. Put it aside for the manager.',
    // M12-FR-01 (QG-05): how fast this till puts a scanned item on the bill, today, as the store computer keeps it.
    scanSpeed: 'Scan speed', scanSpeedTitle: 'Scan speed today — this till',
    deliverBill: 'Deliver this bill', undeliverBill: 'Take delivery off this bill', deliveryTitle: 'Delivery',
    deliveryAdded: 'This bill will be delivered. The delivery fee {fee} is on the bill. The customer pays the whole bill now.',
    deliveryFeeNotSet: 'Delivery from the till is not set up: the owner has not set the delivery fee. Take it as a normal sale, or ask the manager.',
    deliveryRemoved: 'Delivery taken off this bill; the fee line is voided.', deliveryRemovedReason: 'delivery taken off at the till',
    deliveryOnBill: 'For delivery',
    scanSpeedSaid: '{samples} scans timed today. 95 in every 100 reached the bill within {p95} ms (the target is {target} ms). Middle {median} ms, slowest {max} ms; {over} over the target.',
    scanSpeedSlow: 'This till is slower than the target — tell the manager.',
    scanSpeedGood: 'Within the target.',
    scanSpeedDropped: '{dropped} timings could not be kept while the store computer was out of reach.',
    scanSpeedWaiting: '{waiting} more are waiting on this till to be sent.',
    scanSpeedUnknown: 'Not measured yet',
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
    cloudLoginRefused: 'Selling offline — this box\'s head office login needs renewing', cloudNotSetUp: 'No head office link on this box',
    cloudUnknown: 'Head office not checked yet',
    lastContact: 'last contact',
    unsentHeld: 'sale(s) are saved on this box and waiting to be sent. Nothing is lost — they go as soon as head office can be reached.',
    reasonForVoid: 'Reason for void', tapLineFirst: 'Tap a line first.',
    scanFirst: 'Scan an item first.', read: 'Please read this',
    notEnough: 'Not enough — the customer still owes',
    receiptsUsedUp: 'This till has used all its receipt numbers. Do not take money — tell the manager to load a new number range.',
    allSent: 'Everything on this lane has reached the cloud.',
    // P-08: when the box has not said how many sales it holds, the count is NOT KNOWN — never a zero from this till.
    unsentNotKnown: 'not known',
    unsentNotKnownMsg: 'The store box has not said how many sales are waiting to be sent, so this till does not know. It shows "not known" — never 0 — until the box answers.',
    // The bill as it prints (B13 · M31-FR-02): what the paper says, shown on the screen.
    receiptPreview: 'The bill', receiptNotMade: 'The sale is saved, but the bill could not be made',
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
    phoneBasket: 'Phone basket (scan and go)', phoneBasketCode: 'The six digits on the customer\'s phone', phoneBasketHint: 'The till prices every line itself. Check the bag, then take the payment.', phoneBasketNotAdded: 'Not rung — deal with each:',
    queueBasket: 'Handheld basket (queue)', queueBasketCode: 'The four digits on the queue handheld', queueBasketHint: 'The till prices every line itself. Check the bag, then take the payment.',
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
    refundChangeAmount: 'Change the amount',
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
    tierNotSet: 'Tiers: not set — every member earns the base points.',
    tierIs: 'Tier {name}: earns {times}× points.',
    tierBelow: 'Below the lowest tier: earns 1× points.',
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
    refundHeldRecall: '{n} item(s) are under RECALL. Do not put them back on the shelf — put them in the held (quarantine) bin.',
    refundHeldExpired: '{n} item(s) are from a batch past its date. Do not put them back on the shelf — put them in the held (quarantine) bin.',
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
    // OB-252: guest sales only during the pilot — said on the till whenever it is on, never a silent drop.
    guestOnlyStrip: 'Guest sales only (pilot): this till takes no customer mobile number and no loyalty. The old billing system keeps loyalty as today.',
    guestOnlyOption: 'Loyalty member — not on this till (guest sales only)',
    guestOnlyTitle: 'Guest sales only',
    guestOnlyMsg: 'Guest sales only on this till during the pilot: no customer mobile number and no loyalty points or store credit. Ring the sale as a guest. The old billing system keeps loyalty as today.',
    // OB-256 · OB-258: the mirror pilot — the old system bills and takes the money; this till records the same lines.
    paidOnOld: 'Paid on old system',
    mirrorStrip: 'Mirror pilot: the customer is billed and pays on the old system. This till records the same items — every sale and refund is "Paid on old system". No money goes into or out of this drawer.',
    mirrorTitle: 'Mirror pilot',
    mirrorSaleDone: 'Recorded — paid on old system',
    mirrorSaleMsg: 'No money in this drawer. The customer\'s bill is the old system\'s.',
    mirrorRefundDone: 'Refund recorded against the old system\'s payment. Do not take money from this drawer — give the refund on the old system as usual.',
    mirrorNoExchange: 'During the mirror pilot, exchanges are done on the old till only. Ring nothing for an exchange on this till; write it on the pilot list (Sheet 2).',
    // OB-264: the old system's bill number, typed on every mirror sale; a mirror refund finds its sale by it.
    oldBillTitle: 'Old bill number',
    oldBillHint: 'Type the bill number printed on the old system\'s bill, exactly as printed: letters, digits, "-" and "/", up to 16. Then press OK.',
    oldBillNeeded: 'Mirror pilot: type the old system\'s bill number for this sale — it is printed on the customer\'s old bill. Nothing was saved.',
    oldBillNotValid: 'That is not an old bill number. A bill number is up to 16 letters, digits, "-" or "/", as printed on the old bill — no spaces or other marks. Nothing was saved.',
    oldBillPersonal: 'That looks like a phone, Aadhaar or card number, not a bill number. Never type a customer\'s details here. Type the number printed on the old bill. Nothing was saved.',
    oldBillRepeated: 'Old bill number {old} is already keyed on another sale (new bill {new}). Check the number on the old bill. If it is right, this bill was already keyed — do not key it twice. Nothing was saved.',
    oldBillShown: 'Old bill',
    oldBillRefundFind: 'Old bill number on the customer\'s bill',
    oldBillRefundHint: 'Type the bill number printed on the customer\'s old bill and press OK. The till finds the sale it was keyed on.',
    oldBillNotFound: 'No sale on this store computer carries that old bill number. Check the number on the customer\'s old bill and try again. Nothing was recorded.',
    // A8: the store computer's answer was lost — the till keeps asking, under the same sale id, until it knows.
    checkingTitle: 'Checking with the store computer — do not ring this again',
    checkingSale: 'The store computer has not answered yet, so the till does not know whether sale {number} was saved. Do not ring it again and do not start another sale. The till keeps asking and will say "saved" or "not saved".',
    checkingRefund: 'The store computer has not answered yet, so the till does not know whether refund {number} was saved. Do not hand back cash and do not run it again. The till keeps asking and will say "saved" or "not saved".',
    checkingAsked: 'Last asked at',
    checkNow: 'Ask again now',
    notSavedTitle: 'Not saved',
    notSavedSale: 'The store computer says sale {number} was NOT saved. Nothing was recorded for it.',
    notSavedRefund: 'The store computer says refund {number} was NOT saved. Do not hand back cash.',
    savedLate: 'The store computer says it was saved.',
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
    exchangeCreditOnly: 'The credit for the goods coming back is recorded, but the replacement sale was NOT rung. Do not hand over the new goods — get the manager to complete the exchange.',
    declinedMsg: 'The payment was declined. The sale is NOT complete — do not hand over the goods. Ask for another payment method.',
    noAnswerMsg: 'The card machine has not answered, so we do not know whether the customer has paid. The sale is NOT complete — do not hand over the goods. Check the machine, and if it is unclear, ask the manager before trying again.',
    // OB-271: real trading — the legal tax invoice on paper, the card machine's approval number, a card refund on the machine.
    realTradingStrip: 'Real trading: this till\'s bill is the legal GST tax invoice. After each sale press "Print bill" and give the paper to the customer.',
    staffPurchaseTitle: 'Staff shopping — not saved',
    printSlip: 'Print delivery slip', slipPrintFailed: 'The delivery slip did not print — check the printer, then press "Print delivery slip" again. The sale is saved.',
    printBill: 'Print bill',
    printDuplicate: 'Print again (DUPLICATE)',
    reprintOption: 'Reprint the last bill',
    reprintTitle: 'Last bill {number}',
    billCopyOption: 'Print a copy of a bill by its number', billCopyNumber: 'The bill number',
    billCopyHint: 'As the customer\'s handheld screen or slip shows it, for example S2L1-000123.', billCopyWhy: 'Why is a copy needed?',
    billCopyHandheld: 'Paid on a handheld queue till', billCopyLost: 'The customer lost the bill', billCopyJam: 'The printer did not print it',
    billCopyTitle: 'Copy {copy} of bill {number}', billCopyFromHandheld: 'This bill was taken on handheld {lane}. It prints marked as a copy.',
    billCopyMarked: 'It prints marked as a copy.',
    printFailedTitle: 'The bill did not print',
    printFailed: 'The sale is saved. The bill did not print — check the printer is on and has paper, then press "Print bill" again.',
    invoiceRefusedTitle: 'Not a legal bill — NOT saved',
    machineRefTitle: 'Approval / Auth code / RRN',
    machineRefHint: 'Type the approval / auth code or the RRN / UPI reference from the machine\'s slip or the UPI screen (4 to 20 letters or digits). Never the card number.',
    machineRefNotValid: 'That is not an approval / auth code or RRN: it must be 4 to 20 letters or digits. Check the machine\'s slip and type it again.',
    machineRefCardLike: 'That looks like a CARD NUMBER. A card number is never typed or kept. Type the approval / auth code or the RRN from the machine\'s slip.',
    machineRefMissing: 'Type the approval or reference number the machine printed for this payment.',
    machineRefStuck: 'The machine said approved, so the money may be taken. Type its approval number from the slip (the machine can reprint its last slip). Do not run the card again.',
    machineRefAgain: 'Type the number again',
    machineRefLost: 'I cannot find it — mark the payment as not known',
    cardRefundTitle: 'Refund on the card machine',
    cardRefundDo: 'Do this refund of {amount} on the shop\'s card machine (or the UPI app) now. Then type the refund reference it prints; a manager checks it with their own PIN.',
    cardRefundDoneOnMachine: 'Done on the machine — type its reference',
    cardRefundNotYet: 'Not done yet',
    cardRefundRefTitle: 'Refund reference from the machine',
    cardRefundRefHint: 'The approval / auth code or RRN the machine printed for the refund (4 to 20 letters or digits). Never the card number.',
    cardRefundCheck: 'What did you check?',
    cardRefundDone: 'Recorded: the refund of {amount} was done on the machine (reference {ref}), checked by {by}.',
    cardRefundLater: 'Not recorded. The refund stays PENDING until it is done on the machine and recorded here — tell the manager.',
    cardListOption: 'Card and UPI today (to match the machine\'s slip)',
    cardListTitle: 'Card and UPI payments today',
    cardListEmpty: 'No card or UPI payments on this till today.',
    cardListNotKnown: 'The store computer did not answer, so the list is not known. Try again.',
    cardListPaid: 'Paid — match each against the machine\'s settlement slip',
    cardListRefunds: 'Refunds done on the machine',
    cardListUnresolved: 'Not known yet (no answer from the machine)',
    cardListTotal: 'Total',
    cardListNoRef: 'no number',
  },
  ta: {
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. பில் போடுவது வேலை செய்யும். இந்த விலைப் பட்டியல் இந்த லேனுக்குக் கடைசியாகக் கொடுக்கப்பட்டது:',
    offersRefused: 'கேரி பையை இலவசமாக்கும் சலுகைகளை இந்த டில் பயன்படுத்தாது (பை எப்போதும் அதன் விலைக்கே விற்கப்படும்). மேலாளரிடம் சொல்லுங்கள்:',
    batch: 'தொகுதி', scanToBegin: 'தொடங்க ஒரு பொருளை ஸ்கேன் செய்யவும்.', qty: 'எண்ணிக்கை', void: 'நீக்கு',
    item: 'பொருள்', amount: 'தொகை', totalToPay: 'செலுத்த வேண்டிய மொத்தம்', voided: 'நீக்கப்பட்டது', ageCheck: 'வயதுச் சரிபார்ப்பு — அடையாள அட்டை கேளுங்கள்',
    oneMore: 'இன்னும் ஒன்று', oneFewer: 'ஒன்று குறைவு',
    ageQuestion: '{item} வயது வரம்புள்ள பொருள். வாடிக்கையாளரின் அடையாள அட்டையைச் சரிபார்க்கவும். வாடிக்கையாளருக்கு {age} வயது அல்லது அதற்கு மேல் ஆகிறதா?',
    ageYes: 'ஆம் — அடையாளம் சரிபார்க்கப்பட்டது, {age} அல்லது அதற்கு மேல்', ageNo: 'இல்லை — விற்க வேண்டாம்',
    ageNotSoldTitle: 'பொருள் விற்கப்படவில்லை',
    cannotSellTitle: 'இதை விற்க முடியாது',
    ageNotSold: 'வாடிக்கையாளர் {age} வயது அல்லது அதற்கு மேல் என்று காட்ட முடியவில்லை, எனவே {item} பில்லில் சேர்க்கப்படவில்லை. வேறு எதுவும் மாறவில்லை.',
    packDateCheck: 'தேதி சரிபார்ப்பு — பொதியைப் பாருங்கள்',
    packDateQuestion: '{item} விரைவில் கெடும் பொருள். பொதியில் அச்சிடப்பட்ட பயன்பாட்டு / காலாவதி தேதியைப் பாருங்கள். இன்று அது இன்னும் செல்லுபடியாகுமா?',
    packDateYes: 'ஆம் — தேதி சரி', packDateNo: 'இல்லை — தேதி கடந்துவிட்டது, விற்க வேண்டாம்',
    packDateNotSoldTitle: 'பொருள் விற்கப்படவில்லை',
    packDateNotSold: '{item} பொதியில் உள்ள தேதி கடந்துவிட்டது, எனவே அது பில்லில் சேர்க்கப்படவில்லை. மேலாளருக்காக தனியாக வையுங்கள்.',
    scanSpeed: 'ஸ்கேன் வேகம்', scanSpeedTitle: 'இன்றைய ஸ்கேன் வேகம் — இந்த கவுண்டர்',
    deliverBill: 'இந்த பில்லை டெலிவரி செய்', undeliverBill: 'இந்த பில்லின் டெலிவரியை நீக்கு', deliveryTitle: 'டெலிவரி',
    deliveryAdded: 'இந்த பில் டெலிவரி செய்யப்படும். டெலிவரி கட்டணம் {fee} பில்லில் உள்ளது. வாடிக்கையாளர் முழுத் தொகையையும் இப்போதே செலுத்துவார்.',
    deliveryFeeNotSet: 'கவுண்டரில் டெலிவரி அமைக்கப்படவில்லை: உரிமையாளர் டெலிவரி கட்டணத்தை அமைக்கவில்லை. சாதாரண விற்பனையாக எடுக்கவும், அல்லது மேலாளரிடம் கேளுங்கள்.',
    deliveryRemoved: 'இந்த பில்லின் டெலிவரி நீக்கப்பட்டது; கட்டண வரி ரத்து செய்யப்பட்டது.', deliveryRemovedReason: 'கவுண்டரில் டெலிவரி நீக்கப்பட்டது',
    deliveryOnBill: 'டெலிவரிக்கு',
    scanSpeedSaid: 'இன்று {samples} ஸ்கேன்கள் நேரம் அளக்கப்பட்டன. 100-ல் 95 ஸ்கேன்கள் {p95} மி.வி.க்குள் பில்லில் வந்தன (இலக்கு {target} மி.வி.). நடு {median} மி.வி., மிக மெதுவானது {max} மி.வி.; {over} இலக்கை மீறின.',
    scanSpeedSlow: 'இந்த கவுண்டர் இலக்கை விட மெதுவாக உள்ளது — மேலாளரிடம் சொல்லுங்கள்.',
    scanSpeedGood: 'இலக்குக்குள் உள்ளது.',
    scanSpeedDropped: 'கடை கணினியை அடைய முடியாதபோது {dropped} நேர அளவுகளை வைத்திருக்க முடியவில்லை.',
    scanSpeedWaiting: 'இன்னும் {waiting} இந்த கவுண்டரில் அனுப்பக் காத்திருக்கின்றன.',
    scanSpeedUnknown: 'இன்னும் அளக்கப்படவில்லை',
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
    cloudLoginRefused: 'ஆஃப்லைனில் விற்பனை — இந்தப் பெட்டியின் தலைமை அலுவலக உள்நுழைவைப் புதுப்பிக்க வேண்டும்', cloudNotSetUp: 'இந்தப் பெட்டியில் தலைமை அலுவலக இணைப்பு இல்லை',
    cloudUnknown: 'தலைமை அலுவலகம் இன்னும் சரிபார்க்கப்படவில்லை',
    lastContact: 'கடைசித் தொடர்பு',
    unsentHeld: 'விற்பனை(கள்) இந்தப் பெட்டியில் சேமிக்கப்பட்டு அனுப்பக் காத்திருக்கின்றன. எதுவும் இழக்கப்படவில்லை — தலைமை அலுவலகத்தை அடைந்தவுடன் அவை செல்லும்.',
    tapLineFirst: 'முதலில் ஒரு வரியைத் தொடவும்.', scanFirst: 'முதலில் ஒரு பொருளை ஸ்கேன் செய்யவும்.',
    read: 'இதைப் படிக்கவும்', notEnough: 'போதவில்லை — வாடிக்கையாளர் இன்னும் தர வேண்டியது',
    receiptsUsedUp: 'இந்த பணப்பெட்டியின் ரசீது எண்கள் முடிந்துவிட்டன. பணம் வாங்க வேண்டாம் — புதிய எண் வரம்பை ஏற்ற மேலாளரிடம் சொல்லவும்.',
    allSent: 'இந்த லேனில் உள்ள அனைத்தும் அனுப்பப்பட்டுவிட்டன.',
    unsentNotKnown: 'தெரியவில்லை',
    unsentNotKnownMsg: 'எத்தனை விற்பனைகள் அனுப்பக் காத்திருக்கின்றன என்று கடைப் பெட்டி சொல்லவில்லை, எனவே இந்த டில்லுக்குத் தெரியாது. பெட்டி பதிலளிக்கும் வரை 0 அல்ல — "தெரியவில்லை" என்றே காட்டும்.',
    receiptPreview: 'பில்', receiptNotMade: 'விற்பனை சேமிக்கப்பட்டது, ஆனால் பில்லை உருவாக்க முடியவில்லை',
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
    phoneBasket: 'ஃபோன் கூடை (ஸ்கேன் செய்து செல்)', phoneBasketCode: 'வாடிக்கையாளரின் ஃபோனில் உள்ள ஆறு இலக்கங்கள்', phoneBasketHint: 'ஒவ்வொரு வரியையும் கட்டண இயந்திரமே விலையிடும். பையைச் சரிபார்த்து, பிறகு கட்டணத்தைப் பெறுங்கள்.', phoneBasketNotAdded: 'சேர்க்கப்படவில்லை — ஒவ்வொன்றையும் பாருங்கள்:',
    queueBasket: 'கருவிக் கூடை (வரிசை)', queueBasketCode: 'வரிசைக் கருவியில் உள்ள நான்கு இலக்கங்கள்', queueBasketHint: 'ஒவ்வொரு வரியையும் இந்த பில்லிங்கே விலையிடும். பையைச் சரிபார்த்து, பிறகு கட்டணத்தைப் பெறுங்கள்.',
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
    refundChangeAmount: 'தொகையை மாற்று',
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
    tierNotSet: 'நிலைகள்: அமைக்கப்படவில்லை — எல்லா உறுப்பினர்களும் அடிப்படைப் புள்ளிகள் பெறுவார்கள்.',
    tierIs: 'நிலை {name}: {times}× புள்ளிகள் பெறும்.',
    tierBelow: 'குறைந்த நிலைக்குக் கீழ்: 1× புள்ளிகள் பெறும்.',
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
    refundHeldRecall: '{n} பொருள்(கள்) திரும்பப்பெறுதலில் (RECALL) உள்ளன. அலமாரியில் திரும்ப வைக்க வேண்டாம் — நிறுத்தி வைக்கும் (தனிமைப்படுத்தல்) தொட்டியில் வையுங்கள்.',
    refundHeldExpired: '{n} பொருள்(கள்) காலாவதியான தொகுதியைச் சேர்ந்தவை. அலமாரியில் திரும்ப வைக்க வேண்டாம் — நிறுத்தி வைக்கும் (தனிமைப்படுத்தல்) தொட்டியில் வையுங்கள்.',
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
    guestOnlyStrip: 'விருந்தினர் விற்பனை மட்டும் (பைலட்): இந்தக் கல்லா வாடிக்கையாளர் கைபேசி எண்ணையோ லாயல்டியையோ எடுப்பதில்லை. பழைய பில்லிங் அமைப்பு லாயல்டியை இன்றுபோல் வைத்திருக்கும்.',
    guestOnlyOption: 'லாயல்டி உறுப்பினர் — இந்தக் கல்லாவில் இல்லை (விருந்தினர் விற்பனை மட்டும்)',
    guestOnlyTitle: 'விருந்தினர் விற்பனை மட்டும்',
    guestOnlyMsg: 'பைலட் காலத்தில் இந்தக் கல்லாவில் விருந்தினர் விற்பனை மட்டும்: வாடிக்கையாளர் கைபேசி எண் இல்லை, லாயல்டி புள்ளிகளோ கடை வரவோ இல்லை. விற்பனையை விருந்தினராக பில் செய்யவும். பழைய பில்லிங் அமைப்பு லாயல்டியை இன்றுபோல் வைத்திருக்கும்.',
    paidOnOld: 'பழைய பில்லிங் அமைப்பில் செலுத்தப்பட்டது',
    mirrorStrip: 'மிரர் பைலட்: வாடிக்கையாளருக்குப் பழைய பில்லிங் அமைப்பில் பில் போடப்பட்டு, பணமும் அங்கேயே செலுத்தப்படுகிறது. இந்தக் கல்லா அதே பொருட்களைப் பதிவு செய்கிறது — ஒவ்வொரு விற்பனையும் திரும்பப் பணமும் "பழைய பில்லிங் அமைப்பில் செலுத்தப்பட்டது". இந்த டிராயரில் பணம் வருவதுமில்லை, போவதுமில்லை.',
    mirrorTitle: 'மிரர் பைலட்',
    mirrorSaleDone: 'பதிவு செய்யப்பட்டது — பழைய பில்லிங் அமைப்பில் செலுத்தப்பட்டது',
    mirrorSaleMsg: 'இந்த டிராயரில் பணம் இல்லை. வாடிக்கையாளரின் பில் பழைய அமைப்பினுடையது.',
    mirrorRefundDone: 'திரும்பப் பணம் பழைய அமைப்பின் கட்டணத்திற்கு எதிராகப் பதிவு செய்யப்பட்டது. இந்த டிராயரிலிருந்து பணம் எடுக்க வேண்டாம் — வழக்கம்போல் பழைய அமைப்பில் திரும்பப் பணம் கொடுக்கவும்.',
    mirrorNoExchange: 'மிரர் பைலட் காலத்தில் பரிமாற்றம் பழைய கல்லாவில் மட்டுமே செய்யப்படும். இந்தக் கல்லாவில் பரிமாற்றத்திற்கு எதையும் பதிவு செய்யாதீர்கள்; சோதனைப் பட்டியலில் எழுதுங்கள் (தாள் 2).',
    oldBillTitle: 'பழைய பில் எண்',
    oldBillHint: 'பழைய பில்லிங் அமைப்பின் பில்லில் அச்சிடப்பட்ட பில் எண்ணை அப்படியே உள்ளிடவும்: எழுத்துகள், எண்கள், "-" மற்றும் "/", 16 வரை. பிறகு சரி அழுத்தவும்.',
    oldBillNeeded: 'மிரர் பைலட்: இந்த விற்பனைக்கான பழைய பில்லிங் அமைப்பின் பில் எண்ணை உள்ளிடவும் — அது வாடிக்கையாளரின் பழைய பில்லில் அச்சிடப்பட்டுள்ளது. எதுவும் சேமிக்கப்படவில்லை.',
    oldBillNotValid: 'இது பழைய பில் எண் அல்ல. பில் எண் என்பது பழைய பில்லில் அச்சிடப்பட்டபடி 16 வரை எழுத்துகள், எண்கள், "-" அல்லது "/" — இடைவெளியோ வேறு குறிகளோ இல்லை. எதுவும் சேமிக்கப்படவில்லை.',
    oldBillPersonal: 'இது பில் எண் அல்ல, தொலைபேசி, ஆதார் அல்லது கார்டு எண் போலத் தெரிகிறது. வாடிக்கையாளரின் விவரங்களை இங்கே ஒருபோதும் உள்ளிட வேண்டாம். பழைய பில்லில் அச்சிடப்பட்ட எண்ணை உள்ளிடவும். எதுவும் சேமிக்கப்படவில்லை.',
    oldBillRepeated: 'பழைய பில் எண் {old} ஏற்கனவே வேறொரு விற்பனையில் பதிவாகியுள்ளது (புதிய பில் {new}). பழைய பில்லில் உள்ள எண்ணைச் சரிபார்க்கவும். எண் சரி என்றால், இந்தப் பில் ஏற்கனவே பதிவாகிவிட்டது — இருமுறை பதிவு செய்ய வேண்டாம். எதுவும் சேமிக்கப்படவில்லை.',
    oldBillShown: 'பழைய பில்',
    oldBillRefundFind: 'வாடிக்கையாளரின் பில்லில் உள்ள பழைய பில் எண்',
    oldBillRefundHint: 'வாடிக்கையாளரின் பழைய பில்லில் அச்சிடப்பட்ட பில் எண்ணை உள்ளிட்டு சரி அழுத்தவும். அது பதிவான விற்பனையைக் கல்லா கண்டுபிடிக்கும்.',
    oldBillNotFound: 'அந்தப் பழைய பில் எண்ணுடன் இந்தக் கடை கணினியில் எந்த விற்பனையும் இல்லை. வாடிக்கையாளரின் பழைய பில்லில் உள்ள எண்ணைச் சரிபார்த்து மீண்டும் முயலவும். எதுவும் பதிவு செய்யப்படவில்லை.',
    checkingTitle: 'கடை கணினியிடம் சரிபார்க்கிறது — இதை மீண்டும் பில் செய்ய வேண்டாம்',
    checkingSale: 'கடை கணினி இன்னும் பதில் தரவில்லை, எனவே விற்பனை {number} சேமிக்கப்பட்டதா என்று கல்லாவுக்குத் தெரியவில்லை. இதை மீண்டும் பில் செய்ய வேண்டாம், வேறு விற்பனையையும் தொடங்க வேண்டாம். கல்லா தொடர்ந்து கேட்கிறது; "சேமிக்கப்பட்டது" அல்லது "சேமிக்கப்படவில்லை" என்று சொல்லும்.',
    checkingRefund: 'கடை கணினி இன்னும் பதில் தரவில்லை, எனவே திரும்பப் பணம் {number} சேமிக்கப்பட்டதா என்று கல்லாவுக்குத் தெரியவில்லை. பணத்தைக் கொடுக்க வேண்டாம், இதை மீண்டும் செய்ய வேண்டாம். கல்லா தொடர்ந்து கேட்கிறது; "சேமிக்கப்பட்டது" அல்லது "சேமிக்கப்படவில்லை" என்று சொல்லும்.',
    checkingAsked: 'கடைசியாகக் கேட்ட நேரம்',
    checkNow: 'இப்போதே மீண்டும் கேள்',
    notSavedTitle: 'சேமிக்கப்படவில்லை',
    notSavedSale: 'விற்பனை {number} சேமிக்கப்படவில்லை என்று கடை கணினி சொல்கிறது. அதற்கு எதுவும் பதிவு செய்யப்படவில்லை.',
    notSavedRefund: 'திரும்பப் பணம் {number} சேமிக்கப்படவில்லை என்று கடை கணினி சொல்கிறது. பணத்தைக் கொடுக்க வேண்டாம்.',
    savedLate: 'சேமிக்கப்பட்டது என்று கடை கணினி சொல்கிறது.',
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
    exchangeCreditOnly: 'திரும்பும் பொருட்களுக்கான வரவு பதிவு செய்யப்பட்டது, ஆனால் மாற்று விற்பனை பில் செய்யப்படவில்லை. புதிய பொருட்களைக் கொடுக்க வேண்டாம் — பரிமாற்றத்தை முடிக்க மேலாளரை அழைக்கவும்.',
    declinedMsg: 'பணம் மறுக்கப்பட்டது. விற்பனை முடியவில்லை — பொருட்களைக் கொடுக்க வேண்டாம். வேறு முறையில் பணம் கேட்கவும்.',
    noAnswerMsg: 'கார்டு இயந்திரம் பதில் சொல்லவில்லை. வாடிக்கையாளர் பணம் செலுத்தினாரா என்று தெரியவில்லை. விற்பனை முடியவில்லை — பொருட்களைக் கொடுக்க வேண்டாம். இயந்திரத்தைச் சரிபார்க்கவும்; தெளிவில்லை என்றால் மேலாளரிடம் கேட்கவும்.',
    realTradingStrip: 'உண்மை வியாபாரம்: இந்தக் கல்லாவின் பில் சட்டப்படியான GST வரி விலைப்பட்டியல். ஒவ்வொரு விற்பனைக்குப் பிறகும் "பில் அச்சிடு" அழுத்தி, அச்சிட்ட பில்லை வாடிக்கையாளரிடம் கொடுக்கவும்.',
    staffPurchaseTitle: 'பணியாளர் பொருட்கள் — சேமிக்கப்படவில்லை',
    printSlip: 'டெலிவரி சீட்டை அச்சிடு', slipPrintFailed: 'டெலிவரி சீட்டு அச்சாகவில்லை — பிரிண்டரைப் பார்த்து, மீண்டும் "டெலிவரி சீட்டை அச்சிடு" அழுத்தவும். விற்பனை சேமிக்கப்பட்டது.',
    printBill: 'பில் அச்சிடு',
    printDuplicate: 'மீண்டும் அச்சிடு (நகல்)',
    reprintOption: 'கடைசி பில்லை மீண்டும் அச்சிடு',
    reprintTitle: 'கடைசி பில் {number}',
    billCopyOption: 'பில் எண் மூலம் பில்லின் நகலை அச்சிடு', billCopyNumber: 'பில் எண்',
    billCopyHint: 'வாடிக்கையாளரின் கையடக்கத் திரை அல்லது சீட்டில் உள்ளபடி, எ.கா. S2L1-000123.', billCopyWhy: 'நகல் ஏன் தேவை?',
    billCopyHandheld: 'கையடக்க வரிசை பில்லிங்கில் செலுத்தப்பட்டது', billCopyLost: 'வாடிக்கையாளர் பில்லைத் தொலைத்தார்', billCopyJam: 'அச்சுப்பொறி அச்சிடவில்லை',
    billCopyTitle: 'பில் {number} — நகல் {copy}', billCopyFromHandheld: 'இந்த பில் கையடக்கக் கருவி {lane}-இல் போடப்பட்டது. இது நகல் என்று குறிக்கப்பட்டு அச்சிடப்படும்.',
    billCopyMarked: 'இது நகல் என்று குறிக்கப்பட்டு அச்சிடப்படும்.',
    printFailedTitle: 'பில் அச்சாகவில்லை',
    printFailed: 'விற்பனை சேமிக்கப்பட்டது. பில் அச்சாகவில்லை — பிரிண்டர் இயங்குகிறதா, காகிதம் உள்ளதா என்று பார்த்து, மீண்டும் "பில் அச்சிடு" அழுத்தவும்.',
    invoiceRefusedTitle: 'சட்டப்படியான பில் அல்ல — சேமிக்கப்படவில்லை',
    machineRefTitle: 'அனுமதி / அங்கீகாரக் குறியீடு / RRN',
    machineRefHint: 'இயந்திரச் சீட்டில் அல்லது UPI திரையில் உள்ள அனுமதி / அங்கீகாரக் குறியீடு அல்லது RRN / UPI குறிப்பு எண்ணை உள்ளிடவும் (4 முதல் 20 எழுத்துகள் அல்லது இலக்கங்கள்). கார்டு எண்ணை ஒருபோதும் உள்ளிட வேண்டாம்.',
    machineRefNotValid: 'இது அனுமதி / அங்கீகாரக் குறியீடு அல்லது RRN அல்ல: 4 முதல் 20 எழுத்துகள் அல்லது இலக்கங்கள் இருக்க வேண்டும். இயந்திரச் சீட்டைப் பார்த்து மீண்டும் உள்ளிடவும்.',
    machineRefCardLike: 'இது கார்டு எண் போல் உள்ளது. கார்டு எண் ஒருபோதும் உள்ளிடப்படுவதோ சேமிக்கப்படுவதோ இல்லை. சீட்டில் உள்ள அனுமதிக் குறியீடு அல்லது RRN-ஐ உள்ளிடவும்.',
    machineRefMissing: 'இந்தப் பணத்திற்கு இயந்திரம் அச்சிட்ட அனுமதி அல்லது குறிப்பு எண்ணை உள்ளிடவும்.',
    machineRefStuck: 'இயந்திரம் அனுமதித்தது, எனவே பணம் எடுக்கப்பட்டிருக்கலாம். சீட்டிலிருந்து அனுமதி எண்ணை உள்ளிடவும் (இயந்திரம் கடைசிச் சீட்டை மீண்டும் அச்சிடும்). கார்டை மீண்டும் தேய்க்க வேண்டாம்.',
    machineRefAgain: 'எண்ணை மீண்டும் உள்ளிடு',
    machineRefLost: 'எண் கிடைக்கவில்லை — பணத்தைத் தெரியாதது எனக் குறி',
    cardRefundTitle: 'கார்டு இயந்திரத்தில் திரும்பப் பணம்',
    cardRefundDo: 'இந்த {amount} திரும்பப் பணத்தை இப்போது கடையின் கார்டு இயந்திரத்தில் (அல்லது UPI செயலியில்) செய்யவும். பிறகு அது அச்சிடும் குறிப்பு எண்ணை உள்ளிடவும்; மேலாளர் தனது PIN-உடன் சரிபார்ப்பார்.',
    cardRefundDoneOnMachine: 'இயந்திரத்தில் செய்யப்பட்டது — குறிப்பு எண்ணை உள்ளிடு',
    cardRefundNotYet: 'இன்னும் செய்யவில்லை',
    cardRefundRefTitle: 'இயந்திரத்தின் திரும்பப் பணக் குறிப்பு எண்',
    cardRefundRefHint: 'திரும்பப் பணத்திற்கு இயந்திரம் அச்சிட்ட அனுமதி / அங்கீகாரக் குறியீடு அல்லது RRN (4 முதல் 20 எழுத்துகள் அல்லது இலக்கங்கள்). கார்டு எண் அல்ல.',
    cardRefundCheck: 'நீங்கள் எதைச் சரிபார்த்தீர்கள்?',
    cardRefundDone: 'பதிவு செய்யப்பட்டது: {amount} திரும்பப் பணம் இயந்திரத்தில் செய்யப்பட்டது (குறிப்பு {ref}), சரிபார்த்தவர் {by}.',
    cardRefundLater: 'பதிவு செய்யப்படவில்லை. இயந்திரத்தில் செய்து இங்கே பதிவு செய்யும் வரை திரும்பப் பணம் நிலுவையில் இருக்கும் — மேலாளரிடம் சொல்லவும்.',
    cardListOption: 'இன்றைய கார்டு மற்றும் UPI (இயந்திரச் சீட்டுடன் ஒப்பிட)',
    cardListTitle: 'இன்றைய கார்டு மற்றும் UPI பணங்கள்',
    cardListEmpty: 'இன்று இந்தக் கல்லாவில் கார்டு அல்லது UPI பணம் இல்லை.',
    cardListNotKnown: 'கடை கணினி பதில் தரவில்லை, எனவே பட்டியல் தெரியவில்லை. மீண்டும் முயலவும்.',
    cardListPaid: 'செலுத்தப்பட்டவை — ஒவ்வொன்றையும் இயந்திரத்தின் தீர்வுச் சீட்டுடன் ஒப்பிடவும்',
    cardListRefunds: 'இயந்திரத்தில் செய்த திரும்பப் பணம்',
    cardListUnresolved: 'இன்னும் தெரியாதவை (இயந்திரத்திடமிருந்து பதில் இல்லை)',
    cardListTotal: 'மொத்தம்',
    cardListNoRef: 'எண் இல்லை',
  },
};
let lang = 'en';
const t = (key) => WORDS[lang][key] ?? WORDS.en[key];

/**
 * OB-271: why a real-trading bill is not a legal tax invoice, in Tamil — by the model's problem codes (`TaxInvoiceRefusedError`).
 * In English the model's own sentence is shown unchanged.
 */
const INVOICE_PROBLEM_TA = Object.freeze({
  lead: 'இந்த பில்லை சட்டப்படியான வரி விலைப்பட்டியலாக வழங்க முடியாது, எனவே சேமிக்கப்படவில்லை — பணம் வாங்க வேண்டாம்.',
  supplier_legal_name: 'கடையின் சட்டப்பூர்வ பெயர் அமைக்கப்படவில்லை',
  supplier_address: 'கடையின் முகவரி அமைக்கப்படவில்லை',
  supplier_gstin: 'கடையின் GSTIN அமைக்கப்படவில்லை அல்லது சரியானதல்ல',
  place_of_supply: 'GSTIN-இலிருந்து மாநிலத்தைப் படிக்க முடியவில்லை',
  invoice_number: 'பில் எண் சரியான விலைப்பட்டியல் எண் அல்ல',
  invoice_date: 'பில்லின் தேதியைப் படிக்க முடியவில்லை',
  line_description: 'ஒரு பொருளுக்குப் பெயர் இல்லை',
  line_quantity: 'ஒரு பொருளுக்கு அளவு இல்லை',
  line_unit: 'ஒரு பொருளுக்கு அலகு இல்லை',
  line_hsn: 'ஒரு பொருளுக்கு HSN குறியீடு இல்லை',
  line_hsn_digits: 'ஒரு பொருளின் HSN குறியீடு சிறியது (குறைந்தது 6 இலக்கம் தேவை)',
  line_rate: 'ஒரு பொருளின் GST விகிதத்தை CGST, SGST எனப் பிரிக்க முடியவில்லை',
  line_taxable_value: 'ஒரு பொருளுக்கு மதிப்பு இல்லை',
  recipient_details: 'பில் ₹50,000 அல்லது அதற்கு மேல் — வாடிக்கையாளரின் பெயரும் முகவரியும் தேவை; பழைய அமைப்பில் பில் செய்யவும்',
  totals: 'GST-யும் மதிப்புகளும் மொத்தத்துடன் பொருந்தவில்லை',
});

/** A sale the till refused, as the screen says it: a refused tax invoice gets its own heading (and Tamil words). */
function saleRefusal(e) {
  if (e && e.name === 'TaxInvoiceRefusedError' && Array.isArray(e.problems)) {
    if (lang !== 'ta') return { title: t('invoiceRefusedTitle'), words: e.laneMessage };
    const parts = [...new Set(e.problems.map((p) => INVOICE_PROBLEM_TA[p.code] || p.words))];
    return { title: t('invoiceRefusedTitle'), words: `${INVOICE_PROBLEM_TA.lead} ${parts.join('; ')}.` };
  }
  // OB-301: a staff member's own shopping the store computer refused — its own heading, and its own Tamil words.
  if (e && e.refusedBecause === 'staff_purchase_refused') {
    return { title: t('staffPurchaseTitle'), words: lang === 'ta' && e.laneMessageTa ? e.laneMessageTa : e.laneMessage };
  }
  return { title: e && e.notSavedTitle ? t('notSavedTitle') : t('read'), words: e && e.laneMessage ? e.laneMessage : String(e && e.message ? e.message : e) };
}

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
    confirmPackDate() { throw new Error('No price list on this lane.'); }, refusePackDate() { throw new Error('No price list on this lane.'); },
    ageConfirmedAtLeast: () => 0,
    // No identity without the bundle either — the stand-in says so rather than inventing a lane or a cashier.
    signIn() {}, signOut() {}, operator: () => undefined,
    lane: () => ({ laneId: null, tradingDayCutoff: '00:00', tradingDayAt: (at) => at.slice(0, 10) }),
    // No store computer, so no receipt numbers: the stand-in refuses to take money rather than mint one (audit PF-04).
    nextReceipt: () => Promise.reject(Object.assign(new Error('no store computer'), { laneMessage: 'This till has no store computer to number its bills. Do not take money — tell the manager.' })),
    tenderCash: (_id, number) => Promise.resolve(number),
    tenderPaidOnOldErp: (_id, number) => Promise.resolve(number),
    // OB-264: no store computer, so no mirror sale is found by its old bill number either.
    lookupRefundByOldBill: () => Promise.resolve(null),
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
/** OB-252: this till takes guest sales only — no customer mobile number, no loyalty — when its store computer says so. */
const guestOnly = () => !!(session.guestSalesOnly && session.guestSalesOnly());
/** OB-256 · OB-258: this till is in the mirror pilot — "Paid on old system" is then its only tender, for sales and refunds. */
const mirror = () => !!(session.mirrorPilot && session.mirrorPilot());
// OB-271: real trading — off during the mirror pilot; when off, nothing below changes what the till does.
const realTradingOn = () => !!(session.realTrading && session.realTrading());
/** How a refund may be given on this till: in the mirror pilot only "Paid on old system"; never store credit when guest-only. */
function refundTenders() {
  if (mirror()) return [{ value: 'paid_on_old_erp', label: t('paidOnOld') }];
  return [
    { value: 'cash', label: t('cash') },
    { value: 'card', label: t('card') },
    { value: 'upi', label: t('upi') },
    ...(guestOnly() ? [] : [{ value: 'store_credit', label: t('storeCredit') }]),
  ];
}
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
  // The heading reads "Lane 1 · Signed in: …" as one line of words; on screen the lane sits over the cashier, and a
  // missing lane or nobody signed in is said in amber words (the words are the signal, the colour only helps).
  setText('lane-name', laneWords);
  setText('cashier', who ? `${t('signedInAs')}: ${who}` : t('notSignedIn'));
  el('lane-name').toggleAttribute('data-missing', !lane.laneId);
  el('cashier').toggleAttribute('data-missing', !who);
  el('lane').setAttribute('data-operator', who || '');
  el('lane').setAttribute('data-lane', lane.laneId || '');
  setLabel('signin', who ? t('signOut') : t('signIn'));
}
async function toggleSignIn() {
  if (session.operator && session.operator()) {
    if (session.signOutAtTill) await session.signOutAtTill(); else session.signOut();
    rememberOperator(null);
    paintOperator();
    return;
  }
  // The stand-in (no bundle) has no store computer to ask: it cannot sign anybody in.
  if (!session.signInAtTill) { tell(t('read'), t('noStoreBox'), STOP); return; }
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
  if (!outcome.signedIn) { tell(t('signInRefused'), outcome.laneMessage, STOP); paintOperator(); return; }
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
// P-08: the session keeps the last answer and re-sends it to the store computer every 5 minutes while a cashier is
// signed in (so a healthy, quiet till does not read "not known" at head office), and an adapter that can tell us when a
// device changes (`window.sreDevices.onChange(fn)`) has the change sent at once. Both are fire-and-forget.
// An adapter that keeps its own clock (`window.sreDevices.lastObservedAt()`) has that time sent with every report, and
// head office judges the lane by it — so a hung adapter reads stale. A time passed only with a change (`onChange(fn(devices,
// observedAt))`) travels with that one change only; later re-sends are judged by the till's own time (no false "hung").
let devicesWatched = false;
function watchDevices() {
  const adapter = window.sreDevices;
  if (devicesWatched || !adapter || typeof adapter.onChange !== 'function' || typeof session.devicesSaid !== 'function') return;
  devicesWatched = true;
  if (typeof adapter.lastObservedAt === 'function' && typeof session.deviceAdapterClock === 'function') session.deviceAdapterClock(() => adapter.lastObservedAt());
  try {
    adapter.onChange((devices, observedAt) => { if (Array.isArray(devices) && devices.length > 0) session.devicesSaid(devices, observedAt); });
  } catch {
    /* an adapter that cannot be watched still reports at sign-in and on the 5-minute re-send */
  }
}
async function reportDevices() {
  watchDevices();
  const adapter = window.sreDevices;
  if (!adapter || typeof adapter.status !== 'function' || typeof session.reportDevices !== 'function') return;
  try {
    const devices = await adapter.status();
    const observedAt = typeof adapter.lastObservedAt === 'function' ? adapter.lastObservedAt() : undefined;
    if (Array.isArray(devices) && devices.length > 0) await session.reportDevices(devices, typeof observedAt === 'string' ? observedAt : undefined);
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
 *
 * OB-238 (19 Oct 2026): every banner says which kind of message it is, and the caller says it — never guessed from the
 * words. SUCCESS is good news (change due, approved, refund recorded, cash recorded, the sale done): the green surface
 * and the tick. STOP is a stop, a refusal or an error (a recalled batch, tobacco, the HUID, age refused, declined,
 * offline, anything that went wrong): red with the stop mark. Anything that is not plainly SUCCESS is STOP, so a refusal
 * can never look green. The mark sits beside the title's words (never the only signal); the two marks are drawn once and
 * reused, so a refused scan makes no new icon and asks nothing of the network.
 */
const SUCCESS = 'success';
const STOP = 'stop';
const TONE_MARK = Object.freeze({ [SUCCESS]: 'circle-check', [STOP]: 'circle-alert' });
const toneMarks = {};
function tell(title, message, tone = STOP, bill = null, printable = false) {
  pendingCopy = null;
  const kind = tone === SUCCESS ? SUCCESS : STOP;
  if (!toneMarks[kind]) toneMarks[kind] = mark(TONE_MARK[kind], 28);
  const words = document.createElement('span');
  words.textContent = title;
  el('refusal-title').replaceChildren(...(toneMarks[kind] ? [toneMarks[kind]] : []), words);
  el('refusal').dataset.tone = kind;
  el('refusal-text').textContent = message;
  // The bill, only after a sale: exactly the lines the paper prints. Any other message shows none.
  const slip = el('refusal-receipt');
  slip.textContent = bill ?? '';
  slip.hidden = bill === null;
  slip.setAttribute('aria-label', t('receiptPreview'));
  // OB-271: after a real-trading sale, "Print bill" — and, once it has printed, "Print again (DUPLICATE)".
  const actions = el('print-actions');
  if (actions) {
    actions.hidden = !printable;
    el('print-bill').hidden = !printable;
    if (el('print-slip')) el('print-slip').hidden = true; // OB-352: shown again by offerSlip() after a delivery bill
    el('print-bill').textContent = t('printBill');
    el('print-duplicate').textContent = t('printDuplicate');
    el('print-duplicate').hidden = !printable || !printedBills.has(lastInvoiceNumber());
  }
  el('refusal').hidden = false;
  el('refusal-ok').textContent = t('ok');
  el('refusal-ok').focus();
}
el('refusal-ok').addEventListener('click', () => { el('refusal').hidden = true; });

// ── A sale or refund whose answer was lost (audit A8) ───────────────────────
//
// The store computer saved it, or did not — the till does not know, because the answer never came back. Saying "not
// saved" here is how a shop ends up with a phantom sale and a second one for the same customer; saying "saved" is how it
// hands over goods for nothing. So the till says neither: it covers the screen, keeps asking the store computer under the
// SAME id (the box answers a repeat with the original outcome and never saves twice), and only says "saved" or "not
// saved" once the box has answered. Nothing else can be done on the till meanwhile. A reload does not escape it: what is
// being checked is kept in this tab's session storage (ids only — never a customer's number) and asked about on start.
const PENDING_WRITE_KEY = 'sre-pos-pending-write';
const CHECK_EVERY_MS = 2_000;
function rememberPendingWrite(entry) {
  try { if (entry) window.sessionStorage.setItem(PENDING_WRITE_KEY, JSON.stringify(entry)); else window.sessionStorage.removeItem(PENDING_WRITE_KEY); } catch { /* the in-page check still runs; only a reload loses it */ }
}
function pendingWrite() {
  try { const raw = window.sessionStorage.getItem(PENDING_WRITE_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
const isUnconfirmed = (e) => !!e && (e.name === 'SaleUnconfirmedError' || e.name === 'RefundUncertainError');
/**
 * Cover the till and ask `again()` until it stops answering "unconfirmed". Resolves what `again` resolved; rejects with
 * what it rejected when that is an answer (refused). `words()` is what the cover says while it waits, in the language
 * shown — the cover has its own language button, because nothing under it can be pressed.
 */
async function untilTheBoxAnswers(again, words, entry) {
  rememberPendingWrite(entry);
  const cover = el('checking');
  let askedAt = null;
  const paint = () => {
    setText('checking-title', t('checkingTitle'));
    setText('checking-text', words());
    setText('checking-asked', askedAt === null ? '' : `${t('checkingAsked')} ${askedAt.toLocaleTimeString()}`);
    setText('checking-now', t('checkNow'));
  };
  paint();
  cover.hidden = false;
  let wake = null;
  el('checking-now').onclick = () => { if (wake) wake(); };
  el('checking-lang').onclick = () => { el('lang').click(); paint(); };
  try {
    for (;;) {
      await new Promise((resolve) => { wake = resolve; setTimeout(resolve, CHECK_EVERY_MS); });
      wake = null;
      askedAt = new Date();
      paint();
      try {
        const answer = await again();
        if (answer === 'unknown') continue;
        return answer;
      } catch (e) {
        if (isUnconfirmed(e)) continue;
        throw e;
      }
    }
  } finally {
    cover.hidden = true;
    el('checking-now').onclick = null;
    el('checking-lang').onclick = null;
    rememberPendingWrite(null);
  }
}
/**
 * A tender's rejection, handled (A8): any refusal is passed on as it is; a sale whose answer was LOST is asked about
 * again, under its own id, until the box says — resolving the receipt number once it says saved, rejecting with the
 * box's refusal (headed "not saved") once it says not saved. Used as `await session.tenderCash(…).catch(lostAnswer)`.
 */
async function lostAnswer(e) {
  if (!e || e.name !== 'SaleUnconfirmedError') throw e;
  const number = e.number || '';
  try {
    return await untilTheBoxAnswers(() => session.confirmPendingSale(), () => t('checkingSale').replace('{number}', number), { kind: 'sale', saleId: e.saleId, number });
  } catch (refused) {
    throw Object.assign(new Error('not saved'), { notSavedTitle: true, laneMessage: `${t('notSavedSale').replace('{number}', number)}\n${refused && refused.laneMessage ? refused.laneMessage : ''}` });
  }
}
/** A refund outcome — and if its answer was lost, keep asking until the box says which (RR-F02 · A8). */
async function refundOutcome(outcome, number, originalSaleId) {
  if (!outcome || outcome.kind !== 'uncertain' || !session.confirmPendingRefund) return outcome;
  return untilTheBoxAnswers(async () => {
    const again = await session.confirmPendingRefund();
    return again.kind === 'uncertain' ? 'unknown' : again;
  }, () => t('checkingRefund').replace('{number}', number), { kind: 'refund', returnId: `RT-${number}`, number, originalSaleId: originalSaleId || null });
}
/** After a reload: the page lost what it sent, so it asks the store computer whether that sale or refund is on its disk. */
async function resolveAfterReload() {
  const entry = pendingWrite();
  if (!entry || !session.saleOnBox) { rememberPendingWrite(null); return; }
  const isSale = entry.kind === 'sale';
  const answer = await untilTheBoxAnswers(
    () => (isSale ? session.saleOnBox(entry.saleId) : session.refundOnBox(entry.returnId, entry.originalSaleId)),
    () => t(isSale ? 'checkingSale' : 'checkingRefund').replace('{number}', entry.number || ''),
    entry,
  );
  if (answer === 'saved') tell(isSale ? t('approved') : t('refundDone'), `${entry.number} — ${t('savedLate')}`, SUCCESS);
  else tell(t('notSavedTitle'), t(isSale ? 'notSavedSale' : 'notSavedRefund').replace('{number}', entry.number || ''), STOP);
}

// ── The panel ───────────────────────────────────────────────────────────────

let sheetResolve = null;
/** What the open sheet asks for: 'number', 'choice' or 'text' (OB-264) — null when it is closed. */
let sheetMode = null;
let onEntryChange = null;
let chosen = null;
// What the keypad holds. For a PIN it is MASKED: the screen shows one dot per digit, the digits live only here, and they
// are gone the moment the panel closes (ADR-0020 — never shown, never stored).
let entryValue = '0';
let entryMasked = false;
/** A code (the handheld's 4 digits, the phone's 6): every digit counts, a leading 0 included — never read as a number. */
let entryIsCode = false;
const CODE_DIGITS = 8;
const PIN_DIGITS = 6;
function paintEntry() {
  el('entry').textContent = entryMasked ? '•'.repeat(entryValue.length) : entryValue;
  if (entryMasked) el('entry').setAttribute('aria-label', `${entryValue.length} / ${PIN_DIGITS}`); else el('entry').removeAttribute('aria-label');
}
function typeIntoEntry(key) {
  const current = entryValue;
  const next = entryMasked
    ? (key === 'C' ? '' : key === '⌫' ? current.slice(0, -1) : (current.length < PIN_DIGITS ? current + key : current))
    : entryIsCode
      ? (key === 'C' ? '' : key === '⌫' ? current.slice(0, -1) : (current.length < CODE_DIGITS ? current + key : current))
    : (key === 'C' ? '0' : key === '⌫' ? (current.length > 1 ? current.slice(0, -1) : '0') : (current === '0' ? key : current + key));
  entryValue = next;
  paintEntry();
  if (!entryMasked && !entryIsCode && onEntryChange) el('entry-hint').textContent = onEntryChange(Number(next));
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
function ask({ title, mode, hint = '', initial = '0', onChange = null, choices = VOID_REASONS, quick = [], mask = false, commit = false, code = false }) {
  el('sheet-title').textContent = title;
  el('entry-hint').textContent = hint;
  entryIsCode = code === true;
  entryValue = entryIsCode ? '' : initial;
  entryMasked = mask === true;
  paintEntry();
  el('entry').hidden = mode !== 'number';
  el('keypad').hidden = mode !== 'number';
  el('reasons').hidden = mode !== 'choice';
  // A typed answer with letters (OB-264: the old system's bill number) — a text field, from the keyboard or a scanner.
  sheetMode = mode;
  el('entry-text').hidden = mode !== 'text';
  el('entry-text').value = mode === 'text' ? initial : '';
  el('entry-text').setAttribute('aria-label', title);
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
        // OB-390 · pos-refund.md "Choose a reason: 1 (tap a reason chip)": where the question is a reason and nothing
        // else, the chip IS the answer — the words on it are the reason taken, as a quick-row value is (never free text).
        if (commit) closeSheet(reason.code);
      });
      return button;
    }));
  }

  el('sheet').hidden = false;
  if (mode === 'text') el('entry-text').focus();
  return new Promise((resolve) => { sheetResolve = resolve; });
}

function closeSheet(answer) {
  el('sheet').hidden = true;
  el('entry-text').value = '';
  el('entry-text').hidden = true;
  sheetMode = null;
  onEntryChange = null;
  // A PIN leaves this screen with the answer and nowhere else.
  entryMasked = false;
  entryIsCode = false;
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
  closeSheet(sheetMode === 'text' ? el('entry-text').value : el('reasons').hidden ? entryValue : chosen);
});
// Enter in the typed field is OK (a scanner ends its code with Enter); it never reaches the sale screen's scanner.
el('entry-text').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); closeSheet(el('entry-text').value); }
});

/**
 * Ask how the customer is paying, or what the machine said.
 *
 * A separate panel from `ask` because this is a **choice between three big things** with nothing
 * else on screen. It is the moment a cashier is most watched and least able to hunt for a control.
 */
function choose(title, options, kicker = null) {
  el('pay-title').textContent = title;
  // What kind of question this is, said first when the till must stop the cashier (the age check): a label with its mark.
  el('pay-kicker').hidden = kicker === null;
  if (kicker !== null) { el('pay-kicker-text').textContent = kicker.words; setLeadIcon(el('pay-kicker'), kicker.icon, 18); }
  el('pay-kinds').replaceChildren(...options.map((option) => {
    const button = document.createElement('button');
    button.type = 'button';
    // An answer may carry the set's mark in front of its words (cash, card, yes, no); the words alone are the answer.
    // The words stay the button's own text (not wrapped in a span), so the button itself is what carries them.
    const svg = option.icon ? mark(option.icon) : null;
    if (svg) {
      button.append(svg, document.createTextNode(option.label));
    } else {
      button.textContent = option.label;
    }
    button.addEventListener('click', () => { el('pay').hidden = true; payResolve?.(option.value); payResolve = null; });
    return button;
  }));
  el('pay-cancel').textContent = t('cancel');
  setLabel('more', t('more'));
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
    minus.setAttribute('aria-label', `${t('oneFewer')} ${inr(value)}`);
    const shown = document.createElement('span');
    shown.className = 'n';
    shown.id = `n-${value}`;
    shown.textContent = '0';
    const plus = document.createElement('button');
    plus.type = 'button';
    plus.textContent = '+';
    plus.setAttribute('aria-label', `${t('oneMore')} ${inr(value)}`);
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

/**
 * The item cell: the name, then each detail on its own tag under it — the batch a 2D code carried (D-20), the gold
 * piece's hallmark HUID (B13), and for a voided line the word and its reason. The joins (" · ") stay in the words, so
 * the line still reads "Paneer 200g · Batch B-2"; on screen they are hidden and the tags do the separating.
 */
function itemCell(line) {
  const cell = document.createElement('td');
  cell.className = 'item';
  const desc = document.createElement('span');
  desc.className = 'desc';
  desc.textContent = line.description;
  cell.append(desc);
  const tag = (words, cls) => {
    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = ' · ';
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = words;
    cell.append(sep, span);
  };
  if (line.batchId) tag(`${t('batch')} ${line.batchId}`, 'meta');
  if (line.huid) tag(`HUID ${line.huid}`, 'meta');
  if (line.voided) {
    const why = VOID_REASONS.find((r) => r.code === line.voidReason);
    tag(why ? `${t('voided')}: ${why[lang] ?? why.en}` : t('voided'), 'void-note');
  }
  return cell;
}
function numberCell(words, cls) {
  const cell = document.createElement('td');
  cell.className = cls;
  cell.textContent = words;
  return cell;
}

function render() {
  const lines = session.basket();
  el('lines').replaceChildren(...lines.map((line) => {
    const row = document.createElement('tr');
    if (line.lineId === selectedLineId) row.setAttribute('aria-selected', 'true');
    // A voided line stays on the bill — it is evidence (M15) — struck through, with the word and its reason.
    if (line.voided) row.className = 'voided';
    row.tabIndex = 0;
    row.addEventListener('click', () => { selectedLineId = line.lineId; render(); });
    // A weighed line reads in its unit ("1.234 kg", "500 g"); a count stays a count. Words only — the line keeps its integer.
    row.append(itemCell(line), numberCell(line.qtyText ?? String(line.qty), 'qty'), numberCell(inr(line.amountMinor), 'amount'));
    return row;
  }));
  el('bill-table').hidden = lines.length === 0;

  // On the box (PF-05): Hold while there are items, Recall when the till is empty. The stand-in keeps its flag.
  const suspended = session.holdAtTill ? (lines.length === 0 && heldCount > 0) : (session.state && session.state() === 'suspended');
  const recall = session.holdAtTill ? lines.length === 0 : suspended;
  setLabel('hold', recall ? t('recall') : t('hold'), recall ? 'rotate-ccw' : 'pause');
  el('empty').hidden = lines.length > 0 && !suspended;
  // A held basket must SAY it is held. A screen showing an empty basket when one is parked is how
  // the same customer's items get rung up twice.
  setText('empty-text', suspended ? t('onHold') : t('scanToBegin'));
  el('empty').toggleAttribute('data-held', Boolean(suspended));
  setLeadIcon(el('empty'), suspended ? 'pause-circle' : 'scan-barcode', 28);
  el('total').textContent = inr(session.payableMinor());
  // OB-299: a bill marked for delivery SAYS so beside its total — words and the truck icon.
  const forDelivery = typeof session.isForDelivery === 'function' && session.isForDelivery();
  const totalLabel = el('total-label');
  const totalWords = forDelivery ? `${t('totalToPay')} · ${t('deliveryOnBill')}` : t('totalToPay');
  if (totalLabel.textContent !== totalWords || (totalLabel.querySelector('svg') !== null) !== forDelivery) {
    totalLabel.textContent = totalWords;
    const truck = forDelivery ? mark('truck', 20) : null;
    if (truck) totalLabel.prepend(truck);
  }
  totalLabel.toggleAttribute('data-delivery', forDelivery);

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
/** OB-403: the store computer's hold on new offers as the till last applied it (the page booted with the box's). */
let offerHoldCutoff = (window.posLane && window.posLane.offerHold && window.posLane.offerHold.held === true && typeof window.posLane.offerHold.cutoffAt === 'string') ? window.posLane.offerHold.cutoffAt : null;

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
  // The chip says the state in bold and the detail after it; read together they are the same sentence as before.
  let state;
  let detail = '';
  let tone;
  if (!box.asked) {
    dot.classList.add('idle');
    tone = 'idle';
    state = t('checkingBox');
  } else if (!box.reachable) {
    dot.classList.add('error');
    tone = 'error';
    state = t('offline');
    detail = ` — ${t('boxNotAnswering')}`;
  } else {
    const s = box.status;
    const when = s.lastContactAt ? ` · ${t('lastContact')} ${clock(s.lastContactAt)}` : '';
    detail = when;
    if (s.cloud === 'online') {
      tone = 'ok';
      state = t('online');
    } else {
      tone = s.cloud === 'unknown' || s.cloud === 'starting' ? 'idle' : 'degraded';
      dot.classList.add(tone);
      state = s.cloud === 'offline' ? t('noCloud') : s.cloud === 'login_refused' ? t('cloudLoginRefused') : s.cloud === 'not_configured' ? t('cloudNotSetUp') : t('cloudUnknown');
    }
  }
  // Words as well as a dot. A colour-only badge is invisible to one man in twelve, and this badge
  // is how a cashier knows whether the shop is behind.
  el('conn').dataset.tone = tone;
  setText('conn-state', state);
  setText('conn-detail', detail);
  // The unsent count is the BOX's — the sale was saved there, and there is where it waits. When the box has not said
  // (not asked yet, not answering, or an answer with no count), the count is NOT KNOWN, in amber — never this till's own
  // in-memory queue, which a reload empties and which can read 0 while the box holds sales (P-08).
  const unsent = unsentKnown();
  setText('unsent-label', t('unsent'));
  setText('unsent-count', unsent === null ? t('unsentNotKnown') : String(unsent));
  el('unsent').toggleAttribute('data-waiting', unsent !== null && unsent > 0);
  el('unsent').toggleAttribute('data-unknown', unsent === null);
}

/** How many sales the BOX says it holds unsent, or `null` when that is not known (P-08 — a "not known", never a 0). */
function unsentKnown() {
  const n = box.asked && box.reachable && box.status ? box.status.unsent : undefined;
  return Number.isInteger(n) && n >= 0 ? n : null;
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
  // OB-403 "A" · §31.1: the store computer's hold on new offers while its clock is 5+ minutes out. Only an answer from the
  // box changes it — an unreachable box leaves the hold as it last said (never lifted by silence).
  if (box.reachable && box.status && box.status.offerHold && typeof session.holdOffersStartingAfter === 'function') {
    const h = box.status.offerHold;
    const cutoff = h.held === true && typeof h.cutoffAt === 'string' ? h.cutoffAt : null;
    if (cutoff !== offerHoldCutoff) { offerHoldCutoff = cutoff; session.holdOffersStartingAfter(cutoff); render(); }
  }
  paintBadge();
}
void refreshBadge();
setInterval(() => { void refreshBadge(); }, 10_000);
// The badge's own handle, so a test (or a person at the console) can ask the box again without waiting.
window.posBadge = { refresh: refreshBadge, state: () => box };

// ── Cashier intents ─────────────────────────────────────────────────────────

el('qty').addEventListener('click', async () => {
  if (!selectedLineId) { tell(t('read'), t('tapLineFirst'), STOP); return; }
  // Tap the line, tap Qty, tap the number: three (pos-cashier.md). The keypad + OK remain for larger quantities.
  const answer = await ask({
    title: t('quantity'), mode: 'number', initial: '1',
    quick: ['2', '3', '4', '5', '6'].map((n) => ({ label: n, value: n })),
  });
  if (answer === null) return;
  const qty = Number(answer);
  if (!Number.isInteger(qty) || qty <= 0) return;
  try {
    session.setQuantity(selectedLineId, qty);
  } catch (e) {
    // B6 · B14: a loose-cigarette count, or a weight on a lane whose scale stamp ran out, is refused; the line keeps its quantity.
    tell(e && e.name === 'TillRuleRefusedError' ? t('cannotSellTitle') : t('read'), e && e.laneMessage ? e.laneMessage : String(e && e.message ? e.message : e), STOP);
    return;
  }
  render();
});

el('void').addEventListener('click', async () => {
  if (!selectedLineId) { tell(t('read'), t('tapLineFirst'), STOP); return; }
  // A reason is mandatory (M15) and it is chosen, not typed.
  const reason = await ask({ title: t('reasonForVoid'), mode: 'choice' });
  if (!reason) return;
  // The void, its value and the reason go to the store computer first (audit PF-07); the line goes only once it has them.
  if (session.voidAtTill) {
    const r = await session.voidAtTill(selectedLineId, reason);
    if (!r.ok) { tell(t('read'), r.laneMessage, STOP); return; }
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
  if (baskets.length === 0) { tell(t('read'), t('noneHeld'), STOP); await refreshHeld(); return; }
  const pick = await choose(t('giveUpWhich'), baskets.map(heldBasketOption));
  if (pick === null || pick === undefined) return;
  const why = await choose(t('whyGiveUp'), GIVE_UP_REASONS.map((r) => ({ value: r.code, label: r[lang] ?? r.en })));
  if (why === null || why === undefined) return;
  const r = await session.abandonAtTill(pick, why);
  tell(t('read'), r.ok ? t('givenUp') : r.laneMessage, r.ok ? SUCCESS : STOP);
  await refreshHeld();
}

/**
 * OB-350 scan-and-go: the customer's phone shows a six-digit code; the cashier keys it and the till asks its store computer,
 * which asks head office — once. Every line is rung through THIS till's pack (the till's price, never the phone's); a line
 * it cannot ring is listed for the cashier. Payment and the bag check are as for any bill. Offline it says so — scan the items.
 */
async function recallPhoneBasket() {
  const code = await ask({ title: t('phoneBasketCode'), mode: 'number', hint: t('phoneBasketHint'), initial: '', code: true });
  if (code === null || code === undefined) return;
  const r = await session.recallPhoneBasketAtTill(String(code));
  selectedLineId = null;
  render();
  if (!r.ok) { tell(t('read'), r.laneMessage, STOP); return; }
  const missing = (r.notAdded ?? []).map((l) => `${l.name} × ${l.qty} — ${l.laneMessage}`).join('\n');
  tell(t('phoneBasket'), r.laneMessage, missing === '' ? SUCCESS : STOP, missing === '' ? undefined : `${t('phoneBasketNotAdded')}\n${missing}`);
}

/**
 * D04-FR-05 queue-busting: a staff handheld scanned this customer's basket in the queue and showed a four-digit code. The till
 * asks ITS store computer (no head office, so it works offline) — once — and rings every line through THIS till's pack.
 */
async function recallQueueBasket() {
  const code = await ask({ title: t('queueBasketCode'), mode: 'number', hint: t('queueBasketHint'), initial: '', code: true });
  if (code === null || code === undefined) return;
  const r = await session.recallQueueBasketAtTill(String(code));
  selectedLineId = null;
  render();
  if (!r.ok) { tell(t('read'), r.laneMessage, STOP); return; }
  const missing = (r.notAdded ?? []).map((l) => `${l.name} × ${l.qty} — ${l.laneMessage}`).join('\n');
  tell(t('queueBasket'), r.laneMessage, missing === '' ? SUCCESS : STOP, missing === '' ? undefined : `${t('phoneBasketNotAdded')}\n${missing}`);
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
    if (!r.ok) tell(t('read'), r.laneMessage, STOP);
  } else {
    const baskets = await session.heldAtTill();
    if (baskets.length === 0) { tell(t('read'), t('noneHeld'), STOP); return; }
    const pick = baskets.length === 1 ? baskets[0].billId : await choose(t('recallWhich'), baskets.map(heldBasketOption));
    if (pick === null || pick === undefined) return;
    const r = await session.recallAtTill(pick);
    if (!r.ok || r.repriceRequired) tell(t('read'), r.laneMessage, STOP);
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
  if (payable <= 0) { tell(t('read'), t('scanFirst'), STOP); return; }
  // OB-256: in the mirror pilot the customer pays on the old system — the one tender, offered alone.
  if (mirror()) return payOnOldSystem(payable);

  const kind = await choose(t('howPaying'), [
    { value: 'cash', label: `${t('cash')} — ${inr(payable)}`, icon: 'banknote' },
    { value: 'card', label: `${t('card')} — ${inr(payable)}`, icon: 'wallet' },
    { value: 'upi', label: `${t('upi')} — ${inr(payable)}`, icon: 'monitor-smartphone' },
    // A split across tenders, and a loyalty member's points and store credit (M12-FR-03 · PF-09 step 3).
    ...(session.tenderSplit ? [{ value: 'split', label: t('split'), icon: 'arrow-left-right' }] : []),
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
    const sold = huidLines();
    const receipt = await session.tenderCash(`S-${receiptNumber}`, receiptNumber, new Date().toISOString()).catch(lostAnswer);
    tell(`${t('changeDue')}: ${inr(change)}`, withReceiptNotice(withHuids(receipt, sold)), SUCCESS, saleBill(), realTradingOn());
    offerSlip();
    session.newSale();
    void refreshBadge();
    selectedLineId = null;
    render();
  } catch (e) {
    // The model's words, unchanged (a refused tax invoice gets its own heading, and its Tamil words — OB-271).
    const said = saleRefusal(e);
    tell(said.title, said.words, STOP);
  }
});

/**
 * OB-256 — the MIRROR PILOT's payment. The customer is billed and pays on the old system; this till records the same lines
 * as "Paid on old system" — the default and the only tender, for the whole bill: no amount to type, no change, no card
 * machine, nothing into the drawer. The sale is numbered and saved on the store computer exactly as any other.
 */
async function payOnOldSystem(payable) {
  const kind = await choose(t('howPaying'), [{ value: 'paid_on_old_erp', label: `${t('paidOnOld')} — ${inr(payable)}`, icon: 'receipt-text' }]);
  if (kind === null) return;
  // OB-264: the old system's bill number for this same bill — required, judged here before a bill number is taken, and
  // judged again by the store computer (which also refuses one already keyed) before its disk.
  const oldBill = await askOldBill(t('oldBillTitle'), t('oldBillHint'));
  if (oldBill === null) return;
  const receiptNumber = await takeReceiptNumber();
  if (receiptNumber === null) return;
  try {
    const receipt = await session.tenderPaidOnOldErp(`S-${receiptNumber}`, receiptNumber, new Date().toISOString(), oldBill).catch(lostAnswer);
    tell(t('mirrorSaleDone'), `${withReceiptNotice(receipt)}\n${t('oldBillShown')}: ${oldBill}\n${t('mirrorSaleMsg')}`, SUCCESS);
    session.newSale();
    void refreshBadge();
    selectedLineId = null;
    render();
  } catch (e) {
    // OB-264: the store computer refused an old bill number already keyed — said in this till's language, with its numbers.
    const words = e && e.laneMessage ? e.laneMessage : String(e && e.message ? e.message : e);
    const repeated = /^Old bill number (\S+) is already keyed on another sale \(new bill ([^)]+)\)/.exec(words);
    tell(e && e.notSavedTitle ? t('notSavedTitle') : t('read'), repeated ? t('oldBillRepeated').replace('{old}', repeated[1]).replace('{new}', repeated[2]) : words, STOP);
  }
}

/**
 * OB-264 — ask for the old system's bill number (letters, digits, "-" and "/", so a typed field, not the keypad) and judge
 * it by the same rule the store computer runs. Resolves the number as it is kept, or `null` once the keyer has been told
 * why not (nothing is saved and nothing is numbered).
 */
async function askOldBill(title, hint) {
  const typed = await ask({ title, mode: 'text', hint, initial: '' });
  if (typed === null) return null;
  if (!session.readOldBill) { tell(t('read'), t('oldBillNeeded'), STOP); return null; }
  const read = session.readOldBill(String(typed));
  // The model's reason, said in this till's language (its English words are the model's own).
  const said = { old_bill_missing: 'oldBillNeeded', old_bill_not_valid: 'oldBillNotValid', old_bill_looks_personal: 'oldBillPersonal' }[read.refusedBecause];
  if (!read.ok) { tell(t('read'), said ? t(said) : read.laneMessage, STOP); return null; }
  return read.value;
}

/**
 * The next receipt number, from the store computer (audit PF-04). `null` when it gave none — the screen has then said
 * why in the box's own words (range spent, nobody signed in, it could not save or be reached) and no money is taken.
 */
async function takeReceiptNumber() {
  try {
    return await session.nextReceipt();
  } catch (e) {
    tell(t('read'), e && e.refusedBecause === 'receipt_numbers_used_up' ? t('receiptsUsedUp') : (e && e.laneMessage ? e.laneMessage : t('receiptsUsedUp')), STOP);
    return null;
  }
}

/**
 * B13 (OB-138): the gold pieces on this bill and their hallmark HUIDs, read BEFORE the sale clears the basket, so the bill
 * the cashier hands over names each HUID sold. The sale record keeps them too (the store computer and head office read it).
 */
function huidLines() {
  return session.basket().filter((l) => l.huid).map((l) => `${l.description} — HUID ${l.huid}`);
}
function withHuids(receipt, sold) {
  return sold.length === 0 ? receipt : `${receipt}\n${sold.join('\n')}`;
}

/** The receipt, with what the box last said about the numbers (running low, or no range set up) when it said anything. */
/**
 * B13 · M31-FR-02: the bill of the sale just committed, exactly as it prints — `@sre/receipt`'s lines from the saved
 * record (a gold piece's "HUID: <code>" under its line). A bill that could not be made says so; the sale stays saved.
 * The stand-in shell has no receipt renderer, so it shows none rather than a made-up one.
 */
function printedBill() {
  if (typeof session.receiptLines !== 'function') return null;
  const made = session.receiptLines();
  return made && made.ok ? made.lines.join('\n') : `${t('receiptNotMade')}: ${made && made.why ? made.why : ''}`;
}

/**
 * OB-271: the bill shown after a sale. In real trading it is the TAX INVOICE as it prints (every Rule 46 field, checked on
 * the render); otherwise exactly the bill as before.
 */
function saleBill() {
  if (!realTradingOn() || typeof session.taxInvoice !== 'function') return printedBill();
  const made = session.taxInvoice({ language: lang });
  return made && made.ok ? made.lines.join('\n') : `${t('receiptNotMade')}: ${made && made.why ? made.why : ''}`;
}

/** OB-271: the bill numbers this page has printed at least once — a further print is marked DUPLICATE (Rule 46 practice). */
const printedBills = new Set();
/** OB-373: the copy of a bill on screen now (printed by its number), or null — what "Print bill" prints while it shows. */
let pendingCopy = null;

/**
 * OB-373 (owner, 25 Oct 2026): a COPY of any bill on this store computer, by its number — above all a bill a handheld queue
 * till took, which has no printer. The store computer records who printed which copy and why BEFORE it answers; the copy
 * is marked DUPLICATE (English or Tamil, as the till shows) and printed through the browser like any bill (ADR-0027).
 */
async function printBillCopyByNumber() {
  const typed = await ask({ title: t('billCopyNumber'), mode: 'text', hint: t('billCopyHint'), initial: '' });
  if (typed === null || typed === undefined || String(typed).trim() === '') return;
  const why = await choose(t('billCopyWhy'), [
    { value: 'handheld', label: t('billCopyHandheld'), icon: 'monitor-smartphone' },
    { value: 'lost', label: t('billCopyLost'), icon: 'receipt' },
    { value: 'jam', label: t('billCopyJam'), icon: 'triangle-alert' },
  ]);
  if (why === null || why === undefined) return;
  // The reason goes on the record in English (head office reads it); the screen shows it in the till's language.
  const reason = WORDS.en[{ handheld: 'billCopyHandheld', lost: 'billCopyLost', jam: 'billCopyJam' }[why]];
  const r = await session.printBillCopy({ billNumber: String(typed).trim(), reason, language: lang });
  if (!r.ok) { tell(t('read'), lang === 'ta' && r.laneMessageTa ? r.laneMessageTa : (r.laneMessage || r.why), STOP); return; }
  const title = t('billCopyTitle').replace('{copy}', String(r.copyNumber)).replace('{number}', r.number);
  const note = String(r.billLaneId).startsWith('device:') ? t('billCopyFromHandheld').replace('{lane}', String(r.billLaneId).slice('device:'.length)) : t('billCopyMarked');
  tell(title, note, SUCCESS, r.lines.join('\n'), Array.isArray(r.rows));
  pendingCopy = r;
  if (el('print-duplicate')) el('print-duplicate').hidden = true;
}
function lastInvoiceNumber() {
  if (typeof session.taxInvoice !== 'function') return null;
  const made = session.taxInvoice();
  return made && made.ok ? made.number : null;
}

/** One printed row of the invoice as a node, tagged with the Rule 46 field(s) it carries. */
function printRow(row) {
  const node = document.createElement('div');
  node.className = `pr-${row.kind}`;
  if (row.fields.length > 0) node.dataset.field = row.fields.join(' ');
  if (row.kind === 'qr' && row.qr && typeof row.qr.svg === 'string') {
    // A22: the B2C dynamic QR, drawn from the SVG the invoice carries (no network, no library), with its caption under it.
    const img = document.createElement('img');
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(row.qr.svg)}`;
    img.alt = row.text ?? '';
    const caption = document.createElement('span');
    caption.textContent = row.text ?? '';
    node.append(img, caption);
    return node;
  }
  if (row.kind === 'pair' || (row.kind === 'title' && row.left !== undefined)) {
    node.classList.add('pr-split');
    const left = document.createElement('span');
    left.textContent = row.left ?? '';
    const right = document.createElement('span');
    right.textContent = row.right ?? '';
    node.append(left, right);
  } else if (row.kind !== 'rule') {
    node.textContent = row.text ?? '';
  }
  return node;
}

/**
 * OB-271 — print the bill on paper: the browser's own print, through the printer's Windows driver, so Tamil prints with
 * the computer's own fonts (ADR-0027). The sale is already saved: a print that fails never undoes or blocks it, and the
 * bill stays printable. The first print of a bill is the original; every later one is marked DUPLICATE.
 */
function printBill(askedDuplicate) {
  // OB-373: the copy on screen is what prints — it is already marked DUPLICATE and already recorded on the store computer.
  if (pendingCopy !== null && Array.isArray(pendingCopy.rows)) {
    const copy = pendingCopy;
    const area = el('print-area');
    area.className = `print-area paper-${copy.paperWidthMm}`;
    area.dataset.copy = 'duplicate';
    area.dataset.number = copy.number;
    area.lang = lang;
    area.replaceChildren(...copy.rows.map(printRow));
    try { window.print(); } catch { tell(t('printFailedTitle'), t('printFailed'), STOP, copy.lines.join('\n')); }
    return;
  }
  if (typeof session.taxInvoice !== 'function') return;
  const number = lastInvoiceNumber();
  const duplicate = askedDuplicate === true || (number !== null && printedBills.has(number));
  const made = session.taxInvoice({ language: lang, duplicate });
  if (!made || !made.ok) { tell(t('read'), `${t('receiptNotMade')}: ${made && made.why ? made.why : ''}`, STOP); return; }
  const area = el('print-area');
  area.className = `print-area paper-${made.paperWidthMm}`;
  area.dataset.copy = duplicate ? 'duplicate' : 'original';
  area.dataset.number = made.number;
  area.lang = lang;
  area.replaceChildren(...made.rows.map(printRow));
  try {
    window.print();
    printedBills.add(made.number);
    el('print-duplicate').hidden = false;
  } catch {
    // The sale stands; the paper did not come. Said, and the bill stays on screen to print again.
    tell(t('printFailedTitle'), t('printFailed'), STOP, made.lines.join('\n'), true);
  }
}
if (el('print-bill')) {
  el('print-bill').addEventListener('click', () => { printBill(false); });
  el('print-duplicate').addEventListener('click', () => { printBill(true); });
}

/**
 * OB-352 (owner, 24 Oct 2026): after a bill marked for delivery — its slip under the bill. A customer with the app gets one
 * line (they choose the address and slot in the app); otherwise the slip the delivery desk fills in, with "Print delivery
 * slip". The till keeps no address and no phone number: the slip has blank lines to be written by hand.
 */
function offerSlip() {
  const slip = typeof session.deliverySlip === 'function' ? session.deliverySlip(lang) : null;
  const button = el('print-slip');
  if (slip === null || !button) return;
  const shown = el('refusal-receipt');
  shown.textContent = `${shown.textContent ? `${shown.textContent}\n\n` : ''}${slip.lines.join('\n')}`;
  shown.hidden = false;
  if (slip.path !== 'delivery_desk') return;
  el('print-actions').hidden = false;
  if (!realTradingOn()) { el('print-bill').hidden = true; el('print-duplicate').hidden = true; }
  const icon = mark('truck', 18);
  button.replaceChildren(...(icon ? [icon] : []), document.createTextNode(t('printSlip')));
  button.hidden = false;
}
/** OB-352: print the delivery slip on paper (the browser's own print, as the bill prints). The sale is already saved. */
function printSlip() {
  const slip = typeof session.deliverySlip === 'function' ? session.deliverySlip(lang) : null;
  if (slip === null) return;
  const area = el('print-area');
  area.className = 'print-area paper-80';
  area.dataset.copy = 'delivery-slip';
  area.dataset.number = slip.receiptNumber;
  area.lang = lang;
  area.replaceChildren(...slip.lines.map((words, i) => { const row = document.createElement('div'); row.className = i === 0 ? 'pr-title' : 'pr-line'; row.textContent = words; return row; }));
  try { window.print(); } catch { tell(t('printFailedTitle'), t('slipPrintFailed'), STOP, slip.lines.join('\n')); }
}
if (el('print-slip')) el('print-slip').addEventListener('click', () => { printSlip(); });

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
/** OB-271: the machine's approval / reference number typed for each approved attempt on this page, by attempt id. */
const machineRefs = new Map();

/**
 * OB-271 · audit A9 — in real trading, the approval or reference number the shop's own machine printed, typed from the slip
 * and judged by the same rule the store computer runs (OB-274: 4–20 letters or digits, any machine; anything card-like refused, never echoed).
 * The machine already said approved, so there is no plain Cancel: the cashier types it again, or — if it truly cannot be
 * found — marks the payment as NOT KNOWN (it then holds the day close until the manager settles it). Resolves the kept
 * number, or `null` for "not known".
 */
async function askMachineRef() {
  let hint = t('machineRefHint');
  for (;;) {
    const typed = await ask({ title: t('machineRefTitle'), mode: 'text', hint, initial: '' });
    if (typed === null) {
      const what = await choose(t('machineRefStuck'), [{ value: 'again', label: t('machineRefAgain') }, { value: 'lost', label: t('machineRefLost') }]);
      if (what === 'lost') return null;
      hint = t('machineRefHint');
      continue;
    }
    const read = session.readMachineRef(String(typed));
    if (read.ok) return read.value;
    hint = t({ machine_ref_looks_like_card: 'machineRefCardLike', machine_ref_missing: 'machineRefMissing' }[read.refusedBecause] || 'machineRefNotValid');
  }
}

async function cardAttempt(kind, amountMinor) {
  const machine = () => choose(`${t('tapTerminal')} — ${inr(amountMinor)}`, [
    { value: 'approved', label: t('approved'), icon: 'circle-check' },
    { value: 'declined', label: t('declined'), icon: 'x' },
    { value: 'no_answer', label: t('noAnswer'), icon: 'clock' },
  ]);
  if (!session.startCardPayment) {
    const outcome = await machine();
    if (outcome === null) return null;
    if (outcome !== 'approved') { tell(t('read'), outcome === 'declined' ? t('declinedMsg') : t('noAnswerMsg'), STOP); return null; }
    return '';
  }
  let started = await session.startCardPayment(kind, amountMinor);
  if (!started.ok && started.refusedBecause === 'unresolved_payment_on_this_bill' && started.attemptId) {
    const what = await choose(started.laneMessage, [{ value: 'check', label: t('checkPayment') }, { value: 'cancel', label: t('cancel') }]);
    if (what !== 'check') return null;
    const checked = await session.checkCardPayment(started.attemptId);
    if (!checked.ok) { tell(t('read'), checked.laneMessage, STOP); return null; }
    if (checked.state === 'recovered_paid') return checked.attemptId;
    started = await session.startCardPayment(kind, amountMinor);
  }
  if (!started.ok && started.refusedBecause === 'already_paid_on_this_bill' && started.attemptId) {
    if (started.machineRef) machineRefs.set(started.attemptId, started.machineRef);
    return started.attemptId;
  }
  if (!started.ok || !started.attemptId) { tell(t('read'), started.laneMessage, STOP); return null; }
  const outcome = await machine();
  if (outcome === null) return null;
  // OB-271: in real trading "approved" carries the machine's own approval number; one that cannot be found is "not known".
  let machineRef;
  let said = outcome;
  if (outcome === 'approved' && realTradingOn() && session.readMachineRef) {
    machineRef = await askMachineRef();
    if (machineRef === null) said = 'no_answer';
  }
  const answered = said === 'approved' && machineRef ? await session.answerCardPayment(started.attemptId, said, undefined, machineRef) : await session.answerCardPayment(started.attemptId, said);
  if (!answered.ok) { tell(t('read'), answered.laneMessage, STOP); return null; }
  // Said in the cashier's words: an unpaid sale does not commit, and the goods stay on the counter.
  if (said !== 'approved') { tell(t('read'), said === 'declined' ? t('declinedMsg') : t('noAnswerMsg'), STOP); return null; }
  if (machineRef) machineRefs.set(started.attemptId, machineRef);
  return started.attemptId;
}

async function takeCardOrUpi(kind, payable) {
  const ref = await cardAttempt(kind, payable);
  if (ref === null) return;
  const outcome = 'approved';

  const receiptNumber = await takeReceiptNumber();
  if (receiptNumber === null) return;
  try {
    const soldGold = huidLines();
    const machineRef = ref ? machineRefs.get(ref) : undefined;
    const receipt = await session.tenderCardOrUpi({
      saleId: `S-${receiptNumber}`, receiptNumber,
      atIsoUtc: new Date().toISOString(), kind, outcome, ...(ref ? { ref } : {}), ...(machineRef ? { machineRef } : {}),
    }).catch(lostAnswer);
    tell(`${t('approved')} — ${kind === 'card' ? t('card') : t('upi')}`, withReceiptNotice(withHuids(receipt, soldGold)), SUCCESS, saleBill(), realTradingOn());
    offerSlip();
    session.newSale();
    void refreshBadge();
    selectedLineId = null;
    render();
  } catch (e) {
    const said = saleRefusal(e);
    tell(said.title, said.words, STOP);
  }
}

/**
 * A SPLIT payment (M12-FR-03 · PF-09 step 3): part by part until the bill is covered — cash, card, UPI, and for a named
 * loyalty member their points and store credit, as far as the store computer says they may spend here now. A card or UPI
 * part is an attempt recorded on the store computer before the machine is asked (PF-06). Only the last part may be cash
 * over the amount (change). The store computer decides the points and credit again before the disk and says no, in
 * words, if its copy no longer covers them — nothing is then saved and the customer pays another way.
 */
/** OB-295: the member's tier in words — "not set" while the owner has set no tiers; never a made-up ladder. */
function tierWords(tier) {
  if (!tier || tier.tiersSet !== true) return t('tierNotSet');
  if (tier.name === null) return t('tierBelow');
  return t('tierIs').replace('{name}', tier.name).replace('{times}', String(tier.multiplierBps / 10000));
}

async function splitPayment(payable) {
  let wallet = null;
  if (session.loyaltyWallet && session.loyaltyMemberLast4 && session.loyaltyMemberLast4() !== null) {
    wallet = await session.loyaltyWallet();
    if (!wallet.ok) { tell(t('read'), wallet.laneMessage, STOP); wallet = null; }
    else {
      tell(t('member'), t('splitWallet').replace('{last4}', wallet.last4 || session.loyaltyMemberLast4()).replace('{points}', String(wallet.points))
        .replace('{pointsValue}', inr(wallet.pointsValueMinor)).replace('{credit}', inr(wallet.storeCreditMinor)).replace('{asOf}', wallet.asOf ? new Date(wallet.asOf).toLocaleString() : '—')
        // OB-295: the member's tier multiplier from the box's copy — "not set" until the owner sets tiers.
        + ' ' + tierWords(wallet.tier), STOP);
    }
  } else if (session.loyaltyWallet && !guestOnly()) {
    tell(t('read'), t('splitNoMember'), STOP);
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
    if (kind !== 'cash' && amountMinor > max) { tell(t('read'), `${t('upTo')} ${inr(max)}`, STOP); continue; }
    if (kind === 'loyalty_points' && amountMinor % wallet.pointValuePaise !== 0) { tell(t('read'), t('pointsWhole').replace('{value}', inr(wallet.pointValuePaise)), STOP); continue; }
    if (kind === 'card' || kind === 'upi') {
      const ref = await cardAttempt(kind, amountMinor);
      if (ref === null) return;
      parts.push({ kind, amountMinor, ...(ref ? { ref } : {}), ...(ref && machineRefs.get(ref) ? { machineRef: machineRefs.get(ref) } : {}) });
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
    const soldGold = huidLines();
    const receipt = await session.tenderSplit({ saleId: `S-${receiptNumber}`, receiptNumber, atIsoUtc: new Date().toISOString(), parts }).catch(lostAnswer);
    tell(change > 0 ? `${t('changeDue')}: ${inr(change)}` : t('approved'), withReceiptNotice(withHuids(receipt, soldGold)), SUCCESS, saleBill(), realTradingOn());
    offerSlip();
    session.newSale();
    void refreshBadge();
    selectedLineId = null;
    render();
  } catch (e) {
    const said = saleRefusal(e);
    tell(said.title, said.words, STOP);
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
    // OB-350 scan-and-go: a customer's phone basket, by the code on their phone — onto an empty till; the till prices it.
    // Offered only where this box has a head-office link (a standalone box could never fetch one); offline it says so.
    ...(session.recallPhoneBasketAtTill && session.basket().length === 0 && box.status && box.status.cloud !== 'not_configured' ? [{ value: 'phone_basket', label: t('phoneBasket'), icon: 'monitor-smartphone' }] : []),
    // D04-FR-05 queue-busting: a basket a queue handheld handed to this till's store computer — only while this lane's switch
    // (pos.queue_busting, from the signed pack) is on, and onto an empty till.
    ...(session.recallQueueBasketAtTill && session.basket().length === 0 && window.posRollout && window.posRollout.isOn('pos.queue_busting') ? [{ value: 'queue_basket', label: t('queueBasket'), icon: 'scan-barcode' }] : []),
    ...(cash === null || cash.shiftOpen ? [{ value: 'close', label: t('closeTill') }] : []),
    // OB-271 · audit A9: today's card/UPI payments with the machine's numbers — real trading only.
    ...(realTradingOn() && session.cardPayments ? [{ value: 'card_list', label: t('cardListOption') }] : []),
    // OB-271: the last bill stays printable — a reprint is marked DUPLICATE once it has printed.
    ...(realTradingOn() && lastInvoiceNumber() !== null ? [{ value: 'reprint', label: t('reprintOption') }] : []),
    // OB-373: a copy of ANY bill on this store computer by its number — a handheld queue till's above all (it has no printer).
    ...(typeof session.printBillCopy === 'function' ? [{ value: 'bill_copy', label: t('billCopyOption'), icon: 'receipt-text' }] : []),
    // SUPERVISOR OVERRIDES (PF-07 · M12-FR-04): each needs a manager's approval and is recorded on the store computer
    // first. Changing a price needs a selected line.
    ...(session.noSaleAtTill ? [{ value: 'no_sale', label: t('noSale') }] : []),
    // M12-FR-01: this till's scan-to-line speed today, as the store computer keeps it.
    ...(typeof session.scanSpeed === 'function' ? [{ value: 'scan_speed', label: t('scanSpeed'), icon: 'activity' }] : []),
    // OB-299 (M12-FR-02): paid in full here, delivered — the owner's delivery-fee line, once; or taken off again.
    ...(typeof session.deliverThisBill === 'function'
      ? [session.isForDelivery() ? { value: 'undeliver', label: t('undeliverBill'), icon: 'truck' } : { value: 'deliver', label: t('deliverBill'), icon: 'truck' }] : []),
    ...(session.priceChangeAtTill && selectedLineId ? [{ value: 'price_change', label: t('priceChange') }] : []),
    // The customer's loyalty membership, by the mobile number they joined with (PF-09 step 2 · OB-28 "1").
    ...(guestOnly() ? [{ value: 'guest_only', label: t('guestOnlyOption') }] : session.setLoyaltyMobile === undefined ? [] : session.loyaltyMemberLast4() === null
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
  if (what === 'card_list') { tell(t('cardListTitle'), '', SUCCESS, await cardListText()); return undefined; }
  if (what === 'bill_copy') return printBillCopyByNumber();
  if (what === 'reprint') { tell(t('reprintTitle').replace('{number}', lastInvoiceNumber() ?? ''), '', SUCCESS, saleBill(), true); return undefined; }
  if (what === 'give_up') return giveUpHeldBasket();
  if (what === 'phone_basket') return recallPhoneBasket();
  if (what === 'queue_basket') return recallQueueBasket();
  if (what === 'member') return nameLoyaltyMember();
  if (what === 'guest_only') { tell(t('guestOnlyTitle'), t('guestOnlyMsg'), STOP); return undefined; }
  if (what === 'no_sale') return openDrawerNoSale();
  if (what === 'scan_speed') return showScanSpeed();
  if (what === 'deliver') return deliverThisBill();
  if (what === 'undeliver') { session.undeliverThisBill(t('deliveryRemovedReason')); render(); tell(t('deliveryTitle'), t('deliveryRemoved'), SUCCESS); return undefined; }
  if (what === 'price_change') return changeLinePrice();
  if (what === 'member_remove') { session.setLoyaltyMobile(null); tell(t('member'), t('memberRemoved'), SUCCESS); return undefined; }
});

/**
 * OB-299 (M12-FR-02): mark the bill for delivery — the delivery-fee line at its signed price, once. The customer then pays the
 * whole bill here; the store computer relays the committed bill to head office, which books it as one delivery job.
 */
function deliverThisBill() {
  const r = session.deliverThisBill();
  if (!r.ok) { tell(t('deliveryTitle'), r.refusedBecause === 'delivery_fee_not_set' ? t('deliveryFeeNotSet') : r.laneMessage, STOP); return; }
  render();
  tell(t('deliveryTitle'), t('deliveryAdded').replace('{fee}', inr(r.feeMinor)), SUCCESS);
}

/**
 * M12-FR-01 (QG-05 · §32): this till's scan-to-line figures for today, read from the store computer (which keeps every
 * timed scan). Not measured yet, or the box out of reach, is said — never a made-up figure (P-08).
 */
async function showScanSpeed() {
  const s = await session.scanSpeed();
  const waiting = s.waiting > 0 ? ` ${t('scanSpeedWaiting').replace('{waiting}', String(s.waiting))}` : '';
  if (!s.known) { tell(`${t('scanSpeedTitle')}: ${t('scanSpeedUnknown')}`, `${s.why}${waiting}`, STOP); return; }
  const said = t('scanSpeedSaid').replace('{samples}', String(s.samples)).replace('{p95}', String(s.p95Ms)).replace('{target}', String(s.targetMs))
    .replace('{median}', String(s.medianMs)).replace('{max}', String(s.maxMs)).replace('{over}', String(s.overTargetCount));
  const dropped = s.droppedSamples > 0 ? ` ${t('scanSpeedDropped').replace('{dropped}', String(s.droppedSamples))}` : '';
  tell(t('scanSpeedTitle'), `${said} ${s.withinTarget ? t('scanSpeedGood') : t('scanSpeedSlow')}${dropped}${waiting}`, s.withinTarget ? SUCCESS : STOP);
}

/**
 * Open the drawer with NO SALE (PF-07 · M15-FR-01): a manager approves with their own PIN, the store computer records it
 * with the cashier and the manager, and only then is the cashier told to open the drawer. No approval, no record — no drawer.
 */
async function openDrawerNoSale() {
  const approval = await managerApproves({ kind: 'no_sale', valueMinor: 0, hint: t('noSaleHint'), reasons: NO_SALE_REASONS, reasonTitle: 'overrideReason' });
  if (!approval) return;
  const r = await session.noSaleAtTill(approval.reason, { approvalId: approval.approvalId });
  tell(r.ok ? t('noSaleDone') : t('read'), r.laneMessage, r.ok ? SUCCESS : STOP);
}

/**
 * Lower the selected line's price (PF-07 · M12-FR-04): the new unit price, a manager's approval for exactly what it takes
 * off the line, recorded on the store computer — and only then does the line change.
 */
async function changeLinePrice() {
  const lineId = selectedLineId;
  if (!lineId) { tell(t('read'), t('tapLineFirst'), STOP); return; }
  const typed = await ask({ title: t('newPrice'), mode: 'number', initial: '' });
  if (typed === null || typed === '') return;
  const toUnitMinor = Math.round(Number(typed) * 100);
  const value = session.priceChangeValue(lineId, toUnitMinor);
  if (!value.ok) { tell(t('read'), value.laneMessage, STOP); return; }
  const approval = await managerApproves({ kind: 'price_override', billRef: session.currentBillRef(), valueMinor: value.reductionMinor, hint: t('overrideHint'), reasons: PRICE_CHANGE_REASONS, reasonTitle: 'overrideReason' });
  if (!approval) return;
  const r = await session.priceChangeAtTill(lineId, toUnitMinor, approval.reason, { approvalId: approval.approvalId });
  if (!r.ok) { tell(t('read'), r.laneMessage, STOP); return; }
  tell(t('priceChanged'), r.laneMessage, SUCCESS);
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
  if (!outcome.ok) { tell(t('member'), outcome.laneMessage, STOP); return; }
  tell(t('member'), t('memberSet').replace('{last4}', outcome.last4), SUCCESS);
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
  if (!outcome.committed && outcome.refusedBecause === 'lane_unreachable') { tell(t('cashNotSaved'), cashWords(outcome), STOP); return false; }
  if (outcome.committed) tell(t('pendingCash'), `${inr(pending.amountMinor)} — ${t('cashSaved')}`, SUCCESS);
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
    if (outcome.committed) tell(t(doneKey), `${inr(minor)} — ${t('cashSaved')}`, SUCCESS);
    else tell(t('cashNotSaved'), cashWords(outcome), STOP);
  } catch (e) {
    // Nobody signed in, or no lane: the model refuses before the store computer is asked, in its own words (F09).
    tell(t('read'), e && e.laneMessage ? e.laneMessage : String(e && e.message ? e.message : e), STOP);
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
  if (!session.approveAtTill) { tell(t('read'), t('noStoreBox'), STOP); return null; }
  const by = await askScanOrKey({ title: t('refundManagerId'), hint });
  if (by === null || by === '' || by === '0') { tell(t('read'), t('refundNeedManager'), STOP); return null; }
  const pin = await ask({ title: t('managerPinTitle'), mode: 'number', hint: t('managerPinHint'), initial: '', mask: true });
  if (pin === null || pin === '') { tell(t('read'), t('refundNeedManager'), STOP); return null; }
  // OB-390: the manager's reason for a RETURN is the refund's own preset list, answered with one tap on a chip (as the
  // cashier's is). The other approvals (no sale, a price change, a card refund's check) keep their tap and OK.
  const reason = await ask({ title: t(reasonTitle), mode: 'choice', choices: reasons, commit: reasons === REFUND_REASONS });
  if (!reason) return null;
  const outcome = await session.approveAtTill({ managerId: String(by), pin: String(pin), kind, ...(billRef ? { billRef } : {}), valueMinor, reason });
  if (!outcome.approved) { tell(t('approvalRefused'), outcome.laneMessage, STOP); return null; }
  return { by: outcome.approvedBy, reason, approvalId: outcome.approvalId };
}

/** The "Change the amount" answer on the refund's how-is-it-given question (OB-390) — never a refund method. */
const CHANGE_AMOUNT = 'change_amount';

/**
 * How many of a bill's line are coming back, capped at what is still returnable. OB-390: when exactly ONE can come back
 * there is nothing to choose, so the till does not ask — it is that one. Otherwise the keypad, as before. `null` when the
 * cashier cancelled or keyed a number that cannot come back (and was told so).
 */
async function howManyBack(productId, line) {
  if (line.returnableMinor === 1) return 1;
  const qtyAns = await ask({
    title: `${t('refundHowMany')} — ${descOf(productId)}`, mode: 'number', initial: '1',
    hint: `${t('refundCanReturn')}: ${line.returnableMinor}`,
  });
  if (qtyAns === null) return null;
  const qty = Number(qtyAns);
  if (!Number.isInteger(qty) || qty <= 0 || qty > line.returnableMinor) { tell(t('read'), t('refundBadQty'), STOP); return null; }
  return qty;
}

/**
 * The refund. Money leaves the drawer, so honesty beats speed at every step and every rule is
 * enforced behind this view (M13). This file assembles the cashier's answers and shows the outcome —
 * it decides nothing: `lookupRefund` reads the bill from this lane's own disk, and `submit` runs the
 * tested refund engine + the till's durable-first write. Every outcome is the model's own words.
 */
async function startRefund() {
  // 1. Find the bill — scan the receipt, or key the bill number. In the mirror pilot (OB-264) the customer holds only the
  //    old system's bill, so the till asks for ITS number and the store computer finds the sale it was keyed on.
  let bill;
  if (mirror() && session.lookupRefundByOldBill) {
    const oldBill = await askOldBill(t('oldBillRefundFind'), t('oldBillRefundHint'));
    if (oldBill === null) return;
    try {
      bill = await session.lookupRefundByOldBill(oldBill);
    } catch {
      tell(t('refundStop'), t('refundLookupFailed'), STOP);
      return;
    }
    if (!bill) { tell(t('read'), t('oldBillNotFound'), STOP); return; }
  } else {
    const receipt = await askScanOrKey({ title: t('refundFind'), hint: t('refundFindHint') });
    if (receipt === null || receipt === '' || receipt === '0') return;
    try {
      bill = await session.lookupRefund(String(receipt));
    } catch {
      tell(t('refundStop'), t('refundLookupFailed'), STOP);
      return;
    }
    if (!bill) { tell(t('read'), t('refundNotFound'), STOP); return; }
  }

  const returnable = bill.returnable.filter((l) => l.returnableMinor > 0);
  if (returnable.length === 0) { tell(t('read'), t('refundNothingLeft'), STOP); return; }

  // 2. Which item, and how many — capped at what is still returnable on the bill.
  const productId = await choose(t('refundWhichItem'), returnable.map((l) => ({
    value: l.productId, label: `${descOf(l.productId)} — ${t('refundCanReturn')} ${l.returnableMinor}`,
  })));
  if (productId === null) return;
  const line = returnable.find((l) => l.productId === productId);

  const qty = await howManyBack(productId, line);
  if (qty === null) return;

  // 3. Reason (chosen, never typed — M15), and the condition the goods come back in (M13-FR-02).
  const reason = await ask({ title: t('refundReason'), mode: 'choice', choices: REFUND_REASONS, commit: true });
  if (!reason) return;

  const disposition = await choose(t('refundCondition'), [
    { value: 'resell', label: t('dispResell') },
    { value: 'damaged', label: t('dispDamaged') },
  ]);
  if (disposition === null) return;

  // 4. The amount and how it is given (OB-390). The amount STARTS at what the goods coming back were charged on this bill
  // (the engine's own valuation, never above what is left to refund) and is shown on the question that asks how it is
  // given; "Change the amount" opens the keypad, shown against the ceiling as they type. The METHOD is never chosen for
  // the cashier: it is always one of their taps. The engine judges whatever amount is sent (M13-FR-03).
  const typeAmount = async () => {
    const amount = await ask({
      title: t('refundAmount'), mode: 'number',
      hint: `${t('refundMax')}: ${inr(bill.maxRefundMinor)}`,
      onChange: (rupees) => (Math.round(rupees * 100) > bill.maxRefundMinor
        ? `${t('refundTooMuch')} ${inr(bill.maxRefundMinor)}`
        : `${t('refundGiving')}: ${inr(Math.round(rupees * 100))}`),
    });
    return amount === null ? null : Math.round(Number(amount) * 100);
  };
  let refundMinor = typeof bill.lineValueMinor === 'function' ? bill.lineValueMinor(productId, qty) : 0;
  if (!(refundMinor > 0)) {
    // No value the bill can give (nothing priced, nothing left): the cashier keys it, as before.
    const typed = await typeAmount();
    if (typed === null || typed <= 0) return;
    refundMinor = typed;
  }
  let refundTender = null;
  while (refundTender === null) {
    const pick = await choose(`${t('refundHow')} — ${t('refundGiving')} ${inr(refundMinor)}`, [
      ...refundTenders(),
      { value: CHANGE_AMOUNT, label: t('refundChangeAmount') },
    ]);
    if (pick === null) return;
    if (pick !== CHANGE_AMOUNT) { refundTender = pick; break; }
    const typed = await typeAmount();
    if (typed !== null && typed > 0) refundMinor = typed; // cancelled or nought: back to the question, amount unchanged
  }

  // 4a. Store credit is money on the customer's account, so it must go to a NAMED customer (M13-FR-03).
  // Capture them scanned or keyed; if none is given, the credit cannot be issued to nobody — stop and
  // say so (the engine and the cloud both refuse a store-credit refund with no customer).
  let customerRef;
  if (refundTender === 'store_credit') {
    const who = await askScanOrKey({ title: t('refundCustomerId'), hint: t('refundCustomerHint') });
    if (who === null || who === '' || who === '0') { tell(t('read'), t('refundNeedCustomer'), STOP); return; }
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
    // A8 · RR-F02: an answer that was lost is asked again, under the same id, until the store computer says which.
    outcome = await refundOutcome(outcome, number, bill.sale.saleId);
  } catch (e) {
    // submit is written not to throw, but a lost connection to the store can still reject here — treat
    // it as a stop, never as a silent success.
    tell(t('refundStop'), e && e.laneMessage ? e.laneMessage : String(e && e.message ? e.message : e), STOP);
    return;
  }
  await afterRefund(outcome, refundTender, returnId);
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
  // OB-258: in the mirror pilot an exchange is keyed as a refund, then a sale — each "Paid on old system".
  if (mirror()) { tell(t('mirrorTitle'), t('mirrorNoExchange'), STOP); return; }
  // 0. The replacement must already be on the bill.
  if (session.basket().filter((l) => !l.voided).length === 0) { tell(t('read'), t('exchangeNeedsBasket'), STOP); return; }

  // 1. Find the customer's bill — scan the receipt, or key the bill number.
  const receipt = await askScanOrKey({ title: t('refundFind'), hint: t('refundFindHint') });
  if (receipt === null || receipt === '' || receipt === '0') return;
  let bill;
  try {
    bill = await session.lookupRefund(String(receipt));
  } catch {
    tell(t('refundStop'), t('refundLookupFailed'), STOP);
    return;
  }
  if (!bill) { tell(t('read'), t('refundNotFound'), STOP); return; }
  if (!bill.exchange) { tell(t('read'), t('refundNotFound'), STOP); return; }
  const returnable = bill.returnable.filter((l) => l.returnableMinor > 0);
  if (returnable.length === 0) { tell(t('read'), t('refundNothingLeft'), STOP); return; }

  // 2. What is coming back, and how many — capped at what is still returnable on the bill.
  const productId = await choose(t('refundWhichItem'), returnable.map((l) => ({
    value: l.productId, label: `${descOf(l.productId)} — ${t('refundCanReturn')} ${l.returnableMinor}`,
  })));
  if (productId === null) return;
  const line = returnable.find((l) => l.productId === productId);
  const qty = await howManyBack(productId, line);
  if (qty === null) return;

  // 3. Reason (chosen, never typed — M15) and the condition the goods come back in (M13-FR-02).
  const reason = await ask({ title: t('refundReason'), mode: 'choice', choices: REFUND_REASONS, commit: true });
  if (!reason) return;
  const disposition = await choose(t('refundCondition'), [
    { value: 'resell', label: t('dispResell') },
    { value: 'damaged', label: t('dispDamaged') },
  ]);
  if (disposition === null) return;
  const returnLines = [{ productId, uom: line.uom, quantityMinor: qty, disposition }];

  // 4. The quote — the engine's arithmetic over the bill's history and the goods on the bill now. Nothing recorded.
  const quote = bill.exchange.quote(returnLines);
  if (!quote.ok) { tell(t('read'), quote.detail, STOP); return; }

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
      if (ref && machineRefs.get(ref)) settlement.topUp.machineRef = machineRefs.get(ref);
    }
  } else {
    const refundTender = await choose(`${credit} — ${t('exchangeRefunds')}: ${inr(quote.balanceMinor)} — ${t('refundHow')}`, [
      { value: 'cash', label: t('cash') },
      { value: 'card', label: t('card') },
      { value: 'upi', label: t('upi') },
      ...(guestOnly() ? [] : [{ value: 'store_credit', label: t('storeCredit') }]),
    ]);
    if (refundTender === null) return;
    settlement.refundTender = refundTender;
    if (refundTender === 'store_credit') {
      const who = await askScanOrKey({ title: t('refundCustomerId'), hint: t('refundCustomerHint') });
      if (who === null || who === '' || who === '0') { tell(t('read'), t('refundNeedCustomer'), STOP); return; }
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
    // A8: the replacement sale's answer was lost. Keep asking under its own id; only then say whether it was saved.
    if (e && e.name === 'SaleUnconfirmedError') {
      try {
        const receipt = await lostAnswer(e);
        tell(t('exchangeDone'), `${t('savedLate')} RT-${number} · ${receipt}`, SUCCESS);
        session.newSale();
        void refreshBadge();
        selectedLineId = null;
        render();
      } catch (refused) {
        tell(t('exchangeStop'), refused && refused.laneMessage ? refused.laneMessage : String(refused), STOP);
      }
      return;
    }
    tell(t('exchangeStop'), e && e.laneMessage ? e.laneMessage : String(e && e.message ? e.message : e), STOP);
    return;
  }
  // A8 · RR-F02: the credit's answer was lost. Once the box says it is saved, the replacement sale is still not rung —
  // the screen says so rather than finishing an exchange it did not finish.
  if (outcome.kind === 'uncertain') {
    const credit = await refundOutcome(outcome, number, bill.sale.saleId);
    if (credit.kind === 'settled' || credit.kind === 'pending') {
      tell(t('exchangeStop'), `${t('savedLate')} RT-${number}. ${t('exchangeCreditOnly')}`, STOP);
      return;
    }
    showRefundOutcome(credit);
    return;
  }
  if (outcome.kind === 'done') {
    // OB-271 · audit A11: in REAL TRADING a difference refunded to a card or UPI is then DONE on the shop's own machine,
    // exactly as a card refund: its reference typed, a manager checks it with their own PIN, the store computer records it
    // (once, for exactly that difference) — instead of staying "pending". Off: exactly as before.
    const onMachine = outcome.balance === 'refund' && outcome.refundStatus === 'pending' && realTradingOn()
      && (settlement.refundTender === 'card' || settlement.refundTender === 'upi') && session.recordCardRefundOnMachine;
    if (!onMachine) tell(t('exchangeDone'), `${outcome.laneMessage} ${outcome.number} · ${outcome.replacementReceipt}`, SUCCESS);
    session.newSale();
    void refreshBadge();
    selectedLineId = null;
    render();
    if (onMachine) await afterRefund({ kind: 'pending', refundMinor: outcome.balanceMinor }, settlement.refundTender, `RT-${number}`);
    return;
  }
  if (outcome.kind === 'half_done') { tell(t('exchangeStop'), outcome.laneMessage, STOP); return; }
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
  if (!desk) { tell(t('read'), t('noReceiptUnknown'), STOP); return; }

  // 1. The item — the only evidence there is. Scanned, or its code keyed.
  const code = await askScanOrKey({ title: t('noReceiptItem'), hint: t('noReceiptItemHint') });
  if (code === null || code === '' || code === '0') return;
  const item = desk.findProduct(String(code));
  if (!item) { tell(t('read'), t('noReceiptUnknown'), STOP); return; }

  // 2. How many.
  const qtyAns = await ask({ title: `${t('refundHowMany')} — ${item.name}`, mode: 'number', initial: '1' });
  if (qtyAns === null) return;
  const qty = Number(qtyAns);
  if (!Number.isInteger(qty) || qty <= 0) { tell(t('read'), t('refundBadQty'), STOP); return; }

  // 3. Reason (chosen, never typed — M15) and the condition the goods come back in (M13-FR-02).
  const reason = await ask({ title: t('refundReason'), mode: 'choice', choices: REFUND_REASONS, commit: true });
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
  if (refundMinor > desk.capMinor) { tell(t('read'), `${t('noReceiptOverCap')} ${inr(desk.capMinor)}`, STOP); return; }

  const refundTender = await choose(t('refundHow'), refundTenders());
  if (refundTender === null) return;

  // 4a. Store credit must go to a NAMED customer (M13-FR-03) — the same rule as the receipted refund.
  let customerRef;
  if (refundTender === 'store_credit') {
    const who = await askScanOrKey({ title: t('refundCustomerId'), hint: t('refundCustomerHint') });
    if (who === null || who === '' || who === '0') { tell(t('read'), t('refundNeedCustomer'), STOP); return; }
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
    // A8 · RR-F02: no bill to look it up by, so the till keeps re-sending the same refund until the box answers.
    outcome = await refundOutcome(outcome, number, null);
  } catch (e) {
    tell(t('refundStop'), e && e.laneMessage ? e.laneMessage : String(e && e.message ? e.message : e), STOP);
    return;
  }
  await afterRefund(outcome, refundTender, returnId);
  render();
}

/**
 * OB-271 · audit A11: a refund's outcome — and in REAL TRADING, a refund to a card or UPI is then DONE on the shop's own
 * machine: the cashier types the machine's refund reference and a manager checks it with their own PIN; the store computer
 * records it (once, for exactly that refund and amount) instead of leaving it "pending" forever. Off: exactly as before.
 */
const CARD_REFUND_REASONS = [{ code: 'refund_done_on_machine', en: 'Refund seen on the machine\'s slip', ta: 'இயந்திரச் சீட்டில் திரும்பப் பணம் பார்க்கப்பட்டது' }];
async function afterRefund(outcome, refundTender, returnId) {
  if (!realTradingOn() || outcome.kind !== 'pending' || (refundTender !== 'card' && refundTender !== 'upi') || !session.recordCardRefundOnMachine) {
    showRefundOutcome(outcome, refundTender);
    return;
  }
  const amount = inr(outcome.refundMinor);
  const what = await choose(t('cardRefundDo').replace('{amount}', amount), [
    { value: 'done', label: t('cardRefundDoneOnMachine') },
    { value: 'later', label: t('cardRefundNotYet') },
  ]);
  if (what !== 'done') { tell(t('refundPending'), t('cardRefundLater'), STOP); return; }
  let hint = t('cardRefundRefHint');
  let machineRef = null;
  for (;;) {
    const typed = await ask({ title: t('cardRefundRefTitle'), mode: 'text', hint, initial: '' });
    if (typed === null) { tell(t('refundPending'), t('cardRefundLater'), STOP); return; }
    const read = session.readMachineRef(String(typed));
    if (read.ok) { machineRef = read.value; break; }
    hint = t({ machine_ref_looks_like_card: 'machineRefCardLike', machine_ref_missing: 'machineRefMissing' }[read.refusedBecause] || 'machineRefNotValid');
  }
  const approval = await managerApproves({ kind: 'card_refund_on_machine', billRef: returnId, valueMinor: outcome.refundMinor, hint: t('refundManagerHint'), reasons: CARD_REFUND_REASONS, reasonTitle: 'cardRefundCheck' });
  if (approval === null) { tell(t('refundPending'), t('cardRefundLater'), STOP); return; }
  const r = await session.recordCardRefundOnMachine({ returnId, refundMinor: outcome.refundMinor, refundTender, machineRef, approval });
  if (!r.ok) { tell(t('refundPending'), `${r.laneMessage}\n${t('cardRefundLater')}`, STOP); return; }
  tell(t('refundDone'), t('cardRefundDone').replace('{amount}', amount).replace('{ref}', machineRef).replace('{by}', approval.by), SUCCESS);
}

/**
 * OB-271 · audit A9: today's card and UPI payments on this till, each with the machine's approval number, and the card
 * refunds done on the machine — as the store computer recorded them, to match against the machine's settlement slip.
 */
async function cardListText() {
  if (!session.cardPayments) return null;
  const list = await session.cardPayments();
  if (list === null) return t('cardListNotKnown');
  if (list.paid.length === 0 && list.unresolved.length === 0 && list.refundsOnMachine.length === 0) return t('cardListEmpty');
  const kindOf = (k) => (k === 'upi' ? t('upi') : t('card'));
  const out = [t('cardListPaid')];
  for (const p of list.paid) out.push(`${clock(p.askedAt)}  ${kindOf(p.kind)}  ${inr(p.amountMinor)}  ${p.machineRef || t('cardListNoRef')}${p.saleId ? `  ${p.saleId}` : ''}`);
  out.push(`${t('cardListTotal')}: ${inr(list.paid.reduce((n, p) => n + p.amountMinor, 0))}`);
  if (list.unresolved.length > 0) {
    out.push('', t('cardListUnresolved'));
    for (const p of list.unresolved) out.push(`${clock(p.askedAt)}  ${kindOf(p.kind)}  ${inr(p.amountMinor)}`);
  }
  if (list.refundsOnMachine.length > 0) {
    out.push('', t('cardListRefunds'));
    for (const r of list.refundsOnMachine) out.push(`${clock(r.at)}  ${kindOf(r.kind)}  -${inr(r.amountMinor)}  ${r.machineRef}  ${r.returnId}`);
  }
  return out.join('\n');
}

/**
 * One screen state per refund outcome, in the model's OWN words (`laneMessage`). The money-critical
 * four — refused, uncertain, conflict, not entitled — head with "Do not hand over cash", the one
 * instruction that must not be missed; settled and pending get their own headings; anything else is
 * the plain "please read this".
 */
function showRefundOutcome(outcome, refundTender) {
  const stop = outcome.kind === 'refused' || outcome.kind === 'uncertain'
    || outcome.kind === 'conflict' || outcome.kind === 'not_entitled';
  const title = outcome.kind === 'settled' ? t('refundDone')
    : outcome.kind === 'pending' ? t('refundPending')
      : stop ? t('refundStop')
        : t('read');
  // OB-258: a refund to "Paid on old system" was given on the old system — said in the till's language, so nobody opens
  // this drawer for it.
  const words = outcome.kind === 'settled' && refundTender === 'paid_on_old_erp' ? t('mirrorRefundDone') : outcome.laneMessage;
  // M13-FR-02: a unit the till held (under recall, or of an expired batch) is said, so it goes in the held bin, not the shelf.
  const held = outcome.held
    ? [outcome.held.recall > 0 ? t('refundHeldRecall').replace('{n}', String(outcome.held.recall)) : null,
      outcome.held.expired > 0 ? t('refundHeldExpired').replace('{n}', String(outcome.held.expired)) : null].filter(Boolean)
    : [];
  tell(title, [words, ...held].join('\n'), outcome.kind === 'settled' && held.length === 0 ? SUCCESS : STOP);
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
      if (reasonCode === null) { tell(t('read'), t('needsReason'), STOP); return; }
      result = await session.till.close({ shiftId, closedAt, countedMinor: counted, denominations: count.denominations, reasonCode });
    }
    if (!result.closed) { tell(t('read'), cashWords(result), STOP); return; }
    const variance = result.varianceMinor;
    const headline = variance === 0 ? t('balanced')
      : variance > 0 ? `${t('over')} ${inr(variance)}`
        : `${t('short')} ${inr(-variance)}`;
    // A material difference is not a number to note down — it is an instruction to call the manager before the money is
    // put away. The store computer has recorded it and the cash office will see it.
    // OB-271 · audit A9: in real trading the close also lists today's card/UPI payments with the machine's numbers.
    const cards = realTradingOn() ? await cardListText() : null;
    tell(headline, result.exceptionRaised ? t('needsReason') : `${t('tillClosed')} — ${t('counted')}: ${inr(counted)}`, variance === 0 && !result.exceptionRaised ? SUCCESS : STOP, cards);
  } catch (e) {
    // Nobody signed in, or no lane: refused before the store computer is asked, in the model's words (F09).
    tell(t('read'), e && e.laneMessage ? e.laneMessage : t('needsReason'), STOP);
  }
}

/**
 * The words that are the page's own (the buttons, the bill's column heads, the total's name) in the cashier's language,
 * and the page's language with them — so a screen reader reads Tamil as Tamil, and Tamil gets its taller lines.
 */
function paintWords() {
  document.documentElement.lang = lang;
  setLabel('qty', t('qty'));
  setLabel('void', t('void'));
  setLabel('tender', t('tender'));
  setLabel('more', t('more'));
  el('pay-cancel').textContent = t('cancel');
  setText('th-item', t('item'));
  setText('th-qty', t('qty'));
  setText('th-amount', t('amount'));
  setText('total-label', t('totalToPay'));
}
// Each control takes its mark from the one set once, here; afterwards only its words change.
for (const [id, icon] of [['signin', 'user-round'], ['unsent', 'upload'], ['lang', 'globe'], ['qty', 'calculator'], ['void', 'x'], ['hold', 'pause'], ['more', 'layout-grid'], ['tender', 'indian-rupee']]) setLabel(id, undefined, icon);
paintWords();

el('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  paintWords();
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
  const unsent = unsentKnown();
  if (unsent === null) { tell(`${t('unsent')}: ${t('unsentNotKnown')}`, t('unsentNotKnownMsg'), STOP); return; }
  tell(`${t('unsent')}: ${unsent}`, unsent === 0 ? t('allSent') : `${unsent} ${t('unsentHeld')}`, unsent === 0 ? SUCCESS : STOP);
});

// ── The scanner ─────────────────────────────────────────────────────────────
//
// A retail barcode scanner is a keyboard: it types the digits very fast and presses Enter. So there
// is deliberately **no input box to focus** — losing focus is how a scan goes into whatever was
// last tapped, which at a till is a quantity field, and a barcode typed into a quantity is a sale
// of nine hundred million units. Digits are collected globally and flushed on Enter.
//
// D-20: a 2D scanner (DataMatrix, GS1 QR) types more than digits — the printed "(01)…(17)…(10)…" form, a web address,
// or the raw code with group separators (sent as Ctrl+]). Every character is collected; at Enter a code shaped like a
// GS1 code goes to the catalogue whole, and anything else keeps ONLY its digits — exactly what a 1D scan did before.
let scanBuffer = '';
// M12-FR-01: when the scan's first character arrived — the scan-to-line time runs from here to the line on the screen.
let scanStartedAt = null;
/** M12-FR-01: time one scan to the next painted frame (the line is on the screen), and hand it to the till. */
function noteScanToLine(startedAt) {
  if (startedAt === null || typeof session.noteScanTime !== 'function' || typeof requestAnimationFrame !== 'function') return;
  requestAnimationFrame(() => { try { session.noteScanTime(performance.now() - startedAt); } catch { /* timing never stops a sale */ } });
}
const GS = String.fromCharCode(29);
/** A GS1 2D code by its shape alone (the tested reader in packages/gs1 decides the rest). */
function gs1Shaped(code) {
  return code.startsWith('(') || code.startsWith(']') || /^https?:\/\//i.test(code) || code.includes(GS);
}

/**
 * Ask the age question (M12-FR-04 · Wave 2b audit PF-03) on the big-button panel — two answers, nothing else on screen.
 * The item is NOT on the bill while this is open: the session refused it. "Yes" records the answer in the signed-in
 * cashier's name and scans the item again; "No" records the refusal (loss-prevention evidence) and says the item was not
 * sold; Cancel adds nothing and records nothing. The commit checks the answer again before the money is taken.
 */
async function askAge(refusal, retry) {
  const fill = (words) => words.replace('{item}', refusal.description).replace(/\{age\}/g, String(refusal.minimumAge));
  const answer = await choose(fill(t('ageQuestion')), [
    { label: fill(t('ageYes')), value: 'yes', icon: 'check' },
    { label: t('ageNo'), value: 'no', icon: 'x' },
  ], { words: t('ageCheck'), icon: 'shield-alert' });
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
    // B8: an age-restricted perishable asks its pack date next, then scans again.
    if (e && e.name === 'PackDateCheckRequiredError') { void askPackDate(e, retry); return; }
    tell(t('read'), e && e.laneMessage ? e.laneMessage : String(e && e.message ? e.message : e), STOP);
    return;
  }
  render();
  tell(t('ageNotSoldTitle'), fill(t('ageNotSold')), STOP);
}
/**
 * B8 (OB-298, owner 23 Oct 2026): a perishable whose barcode carries no date — the cashier looks at the date printed on the
 * pack and answers with ONE tap before the line is added. "Yes" records the confirmation in the signed-in cashier's name
 * and scans the item again (the line carries it); "No" records that it was out of date and says it was not sold; Cancel
 * adds nothing and records nothing. The commit checks every perishable line again before the money is taken.
 */
async function askPackDate(refusal, retry) {
  const fill = (words) => words.replace('{item}', refusal.description);
  const answer = await choose(fill(t('packDateQuestion')), [
    { label: t('packDateYes'), value: 'yes', icon: 'check' },
    { label: t('packDateNo'), value: 'no', icon: 'x' },
  ], { words: t('packDateCheck'), icon: 'calendar-check' });
  if (answer === null) return; // backed out: nothing added, nothing recorded
  const at = new Date().toISOString();
  try {
    if (answer === 'yes') {
      session.confirmPackDate(refusal.productId, at);
      retry();
      render();
      return;
    }
    session.refusePackDate(refusal.productId, at);
  } catch (e) {
    // A retry can meet another question (an age check) or a refusal — each in its own words.
    if (e && e.name === 'AgeCheckRequiredError') { void askAge(e, retry); return; }
    tell(t('read'), e && e.laneMessage ? e.laneMessage : String(e && e.message ? e.message : e), STOP);
    return;
  }
  render();
  tell(t('packDateNotSoldTitle'), fill(t('packDateNotSold')), STOP);
}
window.addEventListener('keydown', (event) => {
  // A panel is open; the scan is not for us.
  if (!el('sheet').hidden || !el('pay').hidden || !el('count').hidden || !el('refusal').hidden || !el('checking').hidden) return;
  if (event.key === 'Enter') {
    const raw = scanBuffer;
    scanBuffer = '';
    const startedAt = scanStartedAt;
    scanStartedAt = null;
    const code = gs1Shaped(raw) ? raw : raw.replace(/[^0-9]/g, '');
    if (code.length < 6) return; // a person pressing Enter, not a scanner
    // A scanner ends every code with Enter, and Enter on a FOCUSED button presses it: the button last tapped — the
    // language toggle, Void, Tender — would be pressed by the next scan. The Enter belongs to the scan, so it stops here.
    event.preventDefault();
    if (!session.hasCatalogue()) { tell(t('read'), t('noCatalogue'), STOP); return; }
    try {
      session.scanBarcode(code);
      render();
      noteScanToLine(startedAt);
    } catch (e) {
      // An age-restricted item with no confirmed answer in this basket: the session refused to add it (PF-03). Ask, and
      // scan again only on a yes.
      if (e && e.name === 'AgeCheckRequiredError') { void askAge(e, () => session.scanBarcode(code)); return; }
      // B8 (OB-298): a perishable with no date in its barcode — one tap on the date printed on the pack, then scanned again.
      if (e && e.name === 'PackDateCheckRequiredError') { void askPackDate(e, () => session.scanBarcode(code)); return; }
      // A line the law forbids (B6 · B14 · B19 — a banned plastic, a thin or free bag, a loose cigarette, weight on a
      // scale whose stamp ran out) is refused in the gate's own words; there is no override to offer.
      if (e && e.name === 'TillRuleRefusedError') { tell(t('cannotSellTitle'), e.laneMessage, STOP); return; }
      tell(t('read'), String(e && e.message ? e.message : e), STOP);
    }
    return;
  }
  // A 2D scanner sends FNC1 as Ctrl+] (the group separator); every other printable character is kept as typed.
  if (event.ctrlKey && event.key === ']') { scanBuffer += GS; return; }
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key.length === 1) {
    if (scanBuffer === '') scanStartedAt = event.timeStamp;
    scanBuffer += event.key;
  }
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

// NEW-1 (B19 · P-08): an offer in the pack that would give a carry bag away is refused by the till, and the lane says so.
function paintRefusedOffers() {
  const strip = el('offers-refused');
  const refused = session && typeof session.refusedOffers === 'function' ? session.refusedOffers() : [];
  if (!strip) return;
  strip.hidden = refused.length === 0;
  if (refused.length === 0) return;
  strip.textContent = `${t('offersRefused')} ${refused.map((o) => o.offerId).join(', ')}`;
}
paintRefusedOffers();
el('lang').addEventListener('click', paintRefusedOffers);

// OB-252: guest sales only is SAID on the till whenever it is on — the member option is not simply missing.
function paintGuestOnly() {
  const strip = el('guest-only');
  if (!strip) return;
  strip.hidden = !guestOnly();
  if (!strip.hidden) strip.textContent = t('guestOnlyStrip');
}
paintGuestOnly();
el('lang').addEventListener('click', paintGuestOnly);

// OB-256: the mirror pilot is SAID on the till whenever it is on — "Paid on old system" is not simply the only button.
function paintMirror() {
  const strip = el('mirror-pilot');
  if (!strip) return;
  strip.hidden = !mirror();
  if (!strip.hidden) strip.textContent = t('mirrorStrip');
}
paintMirror();
el('lang').addEventListener('click', paintMirror);

// OB-271: real trading is SAID on the till whenever it is on (never during the mirror pilot).
function paintRealTrading() {
  const strip = el('real-trading');
  if (!strip) return;
  strip.hidden = !realTradingOn();
  if (!strip.hidden) strip.textContent = t('realTradingStrip');
}
paintRealTrading();
el('lang').addEventListener('click', paintRealTrading);

// A8: a sale or refund that was still being checked when this page was reloaded is asked about before anything else.
void resolveAfterReload();

// The shell existed and nothing ever registered it, so nothing was ever cached and every one of
// these screens fell back to its sample data the moment the box was unreachable.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
