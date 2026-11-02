// Buyer's screen — the view layer. Every rule lives in the TESTED session model
// (`apps/web-erp/src/buying-session.ts`), attached as `window.buyingSession`.
//
// ── What this screen is actually for ────────────────────────────────────────
//
// Audit finding A-03: somebody retypes an eighty-line supplier invoice into a computer every week.
// The whole product here is **seeing what is wrong before anything is written** — so the preview,
// not the save button, is the biggest thing on the page.
//
// ── The two figures that must agree, and why they are side by side ──────────
//
// The buyer types the total off the **bottom of the supplier's paper**, and the file's own lines are
// summed against it. That figure is the only thing in this flow that does not come from the file,
// which is exactly why it can catch a line the file is missing — every remaining line can be
// perfect and only the total notices.
//
// So the two are shown next to each other, large, and the one that is wrong is coloured. A single
// "does not reconcile" line at the bottom of a form is a message people learn to click past.
//
// ── And what it never does ──────────────────────────────────────────────────
//
// **It writes nothing until the model says the file is clean.** Not a partial save — seventy-seven
// of eighty lines written is an invoice matching no piece of paper anywhere. The save button does not
// exist on the page until the preview says it may.
//
// It never asks "who checked this invoice?". The bill is captured by the signed-in buyer and carries
// no checker: head office does not trust a name typed here, and the check is a second person's own act
// at head office — the match, under their own sign-in.
//
// No `prompt`, `confirm` or `alert`; the banner does not fade.

const el = (id) => document.getElementById(id);

const inr = (minor) =>
  '₹' + (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Rupees typed by a person into exact minor units. Never a float in the model. */
const toMinor = (text) => Math.round(Number(String(text).replace(/[^0-9.-]/g, '')) * 100);

// ── Words ───────────────────────────────────────────────────────────────────

const WORDS = {
  en: {
    buying: 'Buying', supplierInvoice: 'Supplier invoice', checkAgainst: 'Check against the order',
    raiseOrder: 'Raise an order',
    invoiceLead: "Paste the supplier's file, type the total printed on the paper, and see what is wrong before anything is saved.",
    invoiceNumber: 'Invoice number', supplier: 'Supplier', deliverTo: 'Deliver to store',
    printedTotal: 'Total printed on the invoice (in rupees)', theLines: "The supplier's lines",
    checkThis: 'Check this invoice', saveInvoice: 'Save this invoice',
    readyToSave: 'This invoice adds up and every line is good',
    notReady: 'This invoice cannot be saved yet',
    fileSays: 'The file adds up to', paperSays: 'The paper says',
    linesFound: 'line(s) read from the file',
    problemsFound: 'thing(s) to fix. Nothing has been saved.',
    doesNotAddUp: 'The lines do not add up to the total on the paper. Either a line is wrong or a line is missing — and both mean paying something other than what was agreed.',
    line: 'Line', ok: 'OK', cancel: 'Cancel', read: 'Please read this',
    needInvoiceNumber: 'Give the invoice number first.',
    needTotal: 'Type the total printed on the paper invoice first.',
    needFile: 'Paste the supplier\'s lines first.',
    saved: 'Invoice saved on this device', savedNote: 'It can be checked against the order now. The store computer will carry it to head office, where someone else checks the bill against the order under their own sign-in. The list below says where it has got to.',
    invoicePo: 'Purchase order number (if you have it)',
    savedTitle: 'Invoices saved on this screen', savedLead: 'Each is saved on this device first, then with the store computer, then posted at head office.',
    linesWord: 'lines', noOrderWord: 'no purchase order',
    comparePo: 'Purchase order number', compareInvoice: 'Invoice number', compareThem: 'Compare them',
    matchLead: 'Compare what was ordered, what arrived, and what the supplier has invoiced.',
    item: 'Item', ordered: 'Ordered', received: 'Arrived', invoiced: 'Invoiced', payable: 'May be paid',
    blocked: 'Do not pay this yet', agreed: 'These agree', withheld: 'Held back',
    poLead: 'Somebody else has to approve it before it goes to the supplier.',
    itemCode: 'Item', howMany: 'How many', agreedPrice: 'Agreed price each (in rupees)',
    // OB-31: a loose item is ordered in its own unit — "2.5" kg — and priced per whole kg / litre, never per gram.
    howManyIn: 'How many {unit}', pricePer: 'Agreed price per {one} (in rupees)',
    unitMany: { ea: 'items', kg: 'kg', L: 'litres', g: 'grams', ml: 'ml' },
    unitOne: { ea: 'item', kg: 'kg', L: 'litre', g: 'gram', ml: 'ml' },
    needWholeItems: 'Items are ordered in whole numbers. Loose goods take up to three decimals of a kg or a litre (2.5 kg).',
    addItem: 'Add this item', raiseIt: 'Raise the order', noLinesYet: 'No items added yet.',
    choose: 'Choose…', pickUnavailable: 'The list could not open — type the code instead.', whichSupplier: 'Which supplier?', whichItem: 'Which item? (name or barcode)', whichStore: 'Which store?',
    needPoLine: 'Add at least one item first.', needPoFields: 'Fill in the item, how many, and the price.',
    orderRaised: 'Order raised', whoApprovesPo: 'Who approved this order?',
    orderProposed: 'Order proposed — waiting for a second person to approve it',
    sampleData: 'Sample data — this is not your shop.',
    notConnected: 'This screen has not been given anything by the store box yet.',
    remove: 'Remove', lineTotal: 'Line total', whatIsWrong: 'What is wrong',
    gapsTitle: 'This screen has not been told everything',
    budgetTab: 'Budget (open to buy)', budgetLead: 'How much each category may still buy this month. Orders over the budget go to the owner.',
    month: 'Month', budgetStore: 'Store (leave empty for the whole company)', showMonth: 'Show this month',
    category: 'Category', budget: 'Budget', committed: 'Committed (issued orders)', waitingCol: 'Waiting for approval', openToBuy: 'Open to buy',
    afterWaiting: 'Left if the waiting orders are issued', stateCol: 'Where it stands',
    st_within: 'Within budget', st_over: 'Over budget', st_no_budget: 'No budget set — not limited, said here',
    forStore: 'this store\'s budget', forCompany: 'company budget', categoriesOver: 'Categories over budget', totalOpen: 'Open to buy (all budgets)',
    waitingTitle: 'Orders waiting for approval this month', noWaiting: 'No orders are waiting for approval this month.',
    overridesTitle: 'Orders issued over budget this month', noOverrides: 'No order was issued over budget this month.',
    raisedBy: 'raised by', overBy: 'Over budget by', escalates: 'This order is over the budget: it goes to the owner. Only the owner can issue an order over budget, with a reason (OB-63).',
    withinBudget: 'Within budget.', notChecked: 'Raised before budgets were checked.',
    issueReason: 'Why this order is approved', overReason: 'Why it may go over budget', issueIt: 'Issue this order',
    issued: 'Issued — head office sent it to the supplier.', issuedOver: 'Issued over budget — head office recorded the reason.',
    letThrough: 'let through by', because: 'because',
    setTitle: 'Set a category budget', setLead: 'A new figure for the same category, month and store replaces the old one; the old one stays on record.',
    budgetAmount: 'Budget for the month (in rupees)', budgetReason: 'Why this figure', setIt: 'Set this budget',
    budgetSet: 'Budget set — head office kept it.', budgetReplaced: 'Budget set — it replaces the earlier figure, which stays on record.',
    fillBudget: 'Give the category, the amount and why.', notMoney: 'The amount is not an amount of money.',
    onlyOwnerSets: 'Setting a budget is the owner\'s — your role can read the budgets but not change them.',
    historyTitle: 'Budget figures set for this month', noHistory: 'No budget has been set for this month.', setByWord: 'set by', replaced: 'replaced by a later figure',
    refusedBy: 'Head office refused:', cannotReach: 'Head office cannot be reached — nothing was changed.',
    readingOtb: 'Reading the budgets from head office…', notSignedIn: 'Nobody is signed in — the budgets cannot be read.',
    proposedOver: 'Order proposed — over this month\'s budget by',
  },
  ta: {
    buying: 'கொள்முதல்', supplierInvoice: 'சப்ளையர் இன்வாய்ஸ்', checkAgainst: 'ஆர்டருடன் சரிபார்',
    raiseOrder: 'ஆர்டர் தயாரி',
    invoiceLead: 'சப்ளையரின் கோப்பை ஒட்டவும், தாளில் அச்சிடப்பட்ட மொத்தத்தைத் தட்டச்சு செய்யவும். எதுவும் சேமிக்கப்படும் முன் என்ன தவறு என்று பாருங்கள்.',
    invoiceNumber: 'இன்வாய்ஸ் எண்', supplier: 'சப்ளையர்', deliverTo: 'டெலிவரி செய்ய வேண்டிய கடை',
    printedTotal: 'இன்வாய்ஸில் அச்சிடப்பட்ட மொத்தம் (ரூபாயில்)', theLines: 'சப்ளையரின் வரிகள்',
    checkThis: 'இந்த இன்வாய்ஸைச் சரிபார்', saveInvoice: 'இந்த இன்வாய்ஸைச் சேமி',
    readyToSave: 'இந்த இன்வாய்ஸ் சரியாகக் கூடுகிறது, எல்லா வரிகளும் நன்றாக உள்ளன',
    notReady: 'இந்த இன்வாய்ஸை இன்னும் சேமிக்க முடியாது',
    fileSays: 'கோப்பின் கூட்டுத்தொகை', paperSays: 'தாளில் உள்ளது',
    linesFound: 'வரி(கள்) கோப்பிலிருந்து படிக்கப்பட்டன',
    problemsFound: 'சரிசெய்ய வேண்டியவை. எதுவும் சேமிக்கப்படவில்லை.',
    doesNotAddUp: 'வரிகள் தாளில் உள்ள மொத்தத்துடன் பொருந்தவில்லை. ஒரு வரி தவறாக இருக்கலாம் அல்லது ஒரு வரி விடுபட்டிருக்கலாம் — இரண்டுமே ஒப்புக்கொண்டதை விட வேறு தொகை செலுத்துவதாகும்.',
    line: 'வரி', ok: 'சரி', cancel: 'ரத்து', read: 'இதைப் படிக்கவும்',
    needInvoiceNumber: 'முதலில் இன்வாய்ஸ் எண்ணைக் கொடுக்கவும்.',
    needTotal: 'முதலில் தாளில் அச்சிடப்பட்ட மொத்தத்தைத் தட்டச்சு செய்யவும்.',
    needFile: 'முதலில் சப்ளையரின் வரிகளை ஒட்டவும்.',
    saved: 'இன்வாய்ஸ் இந்தக் கருவியில் சேமிக்கப்பட்டது', savedNote: 'இப்போது ஆர்டருடன் சரிபார்க்கலாம். கடை கணினி இதை தலைமை அலுவலகத்திற்கு அனுப்பும்; அங்கு வேறு ஒருவர் தன் சொந்த உள்நுழைவில் இந்த பில்லை ஆர்டருடன் சரிபார்ப்பார். கீழே உள்ள பட்டியல் எங்கே இருக்கிறது என்று சொல்லும்.',
    invoicePo: 'கொள்முதல் ஆர்டர் எண் (இருந்தால்)',
    savedTitle: 'இந்தத் திரையில் சேமிக்கப்பட்ட இன்வாய்ஸ்கள்', savedLead: 'ஒவ்வொன்றும் முதலில் இந்தக் கருவியில், பின் கடை கணினியிடம், பின் தலைமை அலுவலகத்தில் பதிவாகும்.',
    linesWord: 'வரிகள்', noOrderWord: 'கொள்முதல் ஆர்டர் இல்லை',
    comparePo: 'கொள்முதல் ஆர்டர் எண்', compareInvoice: 'இன்வாய்ஸ் எண்', compareThem: 'ஒப்பிடு',
    matchLead: 'ஆர்டர் செய்தது, வந்தது, சப்ளையர் கேட்டது — மூன்றையும் ஒப்பிடவும்.',
    item: 'பொருள்', ordered: 'ஆர்டர்', received: 'வந்தது', invoiced: 'கேட்டது', payable: 'செலுத்தலாம்',
    blocked: 'இதை இன்னும் செலுத்த வேண்டாம்', agreed: 'இவை பொருந்துகின்றன', withheld: 'நிறுத்தி வைக்கப்பட்டது',
    poLead: 'சப்ளையருக்குச் செல்வதற்கு முன் வேறு ஒருவர் ஒப்புதல் அளிக்க வேண்டும்.',
    itemCode: 'பொருள்', howMany: 'எத்தனை', agreedPrice: 'ஒப்புக்கொண்ட விலை (ரூபாயில்)',
    howManyIn: 'எத்தனை {unit}', pricePer: 'ஒரு {one}-க்கு ஒப்புக்கொண்ட விலை (ரூபாயில்)',
    unitMany: { ea: 'பொருட்கள்', kg: 'கிலோ', L: 'லிட்டர்', g: 'கிராம்', ml: 'மி.லி.' },
    unitOne: { ea: 'பொருள்', kg: 'கிலோ', L: 'லிட்டர்', g: 'கிராம்', ml: 'மி.லி.' },
    needWholeItems: 'பொருட்கள் முழு எண்ணில் ஆர்டர் செய்யப்படும். தளர்வான பொருட்கள் கிலோ / லிட்டரில் மூன்று தசம இடங்கள் வரை (2.5 கிலோ).',
    addItem: 'இந்தப் பொருளைச் சேர்', raiseIt: 'ஆர்டரைத் தயாரி', noLinesYet: 'இன்னும் பொருட்கள் சேர்க்கப்படவில்லை.',
    choose: 'தேர்ந்தெடு…', pickUnavailable: 'பட்டியலைத் திறக்க முடியவில்லை — குறியீட்டைத் தட்டச்சு செய்யவும்.', whichSupplier: 'எந்த சப்ளையர்?', whichItem: 'எந்தப் பொருள்? (பெயர் அல்லது பார்கோடு)', whichStore: 'எந்தக் கடை?',
    needPoLine: 'குறைந்தது ஒரு பொருளையாவது சேர்க்கவும்.', needPoFields: 'பொருள், எண்ணிக்கை, விலை — எல்லாவற்றையும் நிரப்பவும்.',
    orderRaised: 'ஆர்டர் தயாரிக்கப்பட்டது', whoApprovesPo: 'இந்த ஆர்டரை யார் ஒப்புதல் அளித்தார்?',
    orderProposed: 'ஆர்டர் முன்மொழியப்பட்டது — வேறு ஒருவர் ஒப்புதல் அளிக்கக் காத்திருக்கிறது',
    sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
    notConnected: 'கடை கணினியிடமிருந்து இந்தத் திரைக்கு இன்னும் எதுவும் வரவில்லை.',
    remove: 'நீக்கு', lineTotal: 'வரி மொத்தம்', whatIsWrong: 'என்ன தவறு',
    gapsTitle: 'இந்தத் திரைக்கு எல்லாத் தகவலும் வரவில்லை',
    budgetTab: 'பட்ஜெட் (வாங்க மீதம்)', budgetLead: 'இந்த மாதம் ஒவ்வொரு வகையும் இன்னும் எவ்வளவு வாங்கலாம். பட்ஜெட்டை மீறும் ஆர்டர்கள் உரிமையாளரிடம் செல்லும்.',
    month: 'மாதம்', budgetStore: 'கடை (முழு நிறுவனத்திற்கும் என்றால் காலியாக விடவும்)', showMonth: 'இந்த மாதத்தைக் காட்டு',
    category: 'வகை', budget: 'பட்ஜெட்', committed: 'உறுதியானது (வழங்கிய ஆர்டர்கள்)', waitingCol: 'ஒப்புதலுக்குக் காத்திருப்பவை', openToBuy: 'வாங்க மீதம்',
    afterWaiting: 'காத்திருக்கும் ஆர்டர்கள் வழங்கப்பட்டால் மீதம்', stateCol: 'நிலை',
    st_within: 'பட்ஜெட்டுக்குள்', st_over: 'பட்ஜெட்டை மீறியது', st_no_budget: 'பட்ஜெட் அமைக்கப்படவில்லை — வரம்பு இல்லை, இங்கே சொல்லப்படுகிறது',
    forStore: 'இந்தக் கடையின் பட்ஜெட்', forCompany: 'நிறுவனப் பட்ஜெட்', categoriesOver: 'பட்ஜெட்டை மீறிய வகைகள்', totalOpen: 'வாங்க மீதம் (எல்லா பட்ஜெட்டும்)',
    waitingTitle: 'இந்த மாதம் ஒப்புதலுக்குக் காத்திருக்கும் ஆர்டர்கள்', noWaiting: 'இந்த மாதம் எந்த ஆர்டரும் ஒப்புதலுக்குக் காத்திருக்கவில்லை.',
    overridesTitle: 'இந்த மாதம் பட்ஜெட்டை மீறி வழங்கிய ஆர்டர்கள்', noOverrides: 'இந்த மாதம் எந்த ஆர்டரும் பட்ஜெட்டை மீறி வழங்கப்படவில்லை.',
    raisedBy: 'தயாரித்தவர்', overBy: 'பட்ஜெட்டை மீறிய தொகை', escalates: 'இந்த ஆர்டர் பட்ஜெட்டை மீறுகிறது: இது உரிமையாளரிடம் செல்லும். பட்ஜெட்டை மீறும் ஆர்டரை உரிமையாளர் மட்டுமே, ஒரு காரணத்துடன், வழங்க முடியும் (OB-63).',
    withinBudget: 'பட்ஜெட்டுக்குள்.', notChecked: 'பட்ஜெட் சரிபார்ப்புக்கு முன் தயாரிக்கப்பட்டது.',
    issueReason: 'இந்த ஆர்டருக்கு ஏன் ஒப்புதல்', overReason: 'ஏன் பட்ஜெட்டை மீறலாம்', issueIt: 'இந்த ஆர்டரை வழங்கு',
    issued: 'வழங்கப்பட்டது — தலைமை அலுவலகம் சப்ளையருக்கு அனுப்பியது.', issuedOver: 'பட்ஜெட்டை மீறி வழங்கப்பட்டது — தலைமை அலுவலகம் காரணத்தைப் பதிவு செய்தது.',
    letThrough: 'அனுமதித்தவர்', because: 'காரணம்',
    setTitle: 'ஒரு வகைக்கான பட்ஜெட்டை அமை', setLead: 'அதே வகை, மாதம், கடைக்கு புதிய தொகை பழையதை மாற்றும்; பழையது பதிவில் இருக்கும்.',
    budgetAmount: 'மாதத்திற்கான பட்ஜெட் (ரூபாயில்)', budgetReason: 'இந்தத் தொகை ஏன்', setIt: 'இந்தப் பட்ஜெட்டை அமை',
    budgetSet: 'பட்ஜெட் அமைக்கப்பட்டது — தலைமை அலுவலகம் வைத்துக்கொண்டது.', budgetReplaced: 'பட்ஜெட் அமைக்கப்பட்டது — முந்தைய தொகையை மாற்றுகிறது; அது பதிவில் இருக்கும்.',
    fillBudget: 'வகை, தொகை, காரணம் — மூன்றையும் கொடுக்கவும்.', notMoney: 'தொகை ஒரு பணத் தொகை அல்ல.',
    onlyOwnerSets: 'பட்ஜெட் அமைப்பது உரிமையாளரின் பணி — உங்கள் பங்கால் பட்ஜெட்டைப் படிக்கலாம், மாற்ற முடியாது.',
    historyTitle: 'இந்த மாதத்திற்கு அமைத்த பட்ஜெட் தொகைகள்', noHistory: 'இந்த மாதத்திற்கு பட்ஜெட் அமைக்கப்படவில்லை.', setByWord: 'அமைத்தவர்', replaced: 'பின்னர் வந்த தொகையால் மாற்றப்பட்டது',
    refusedBy: 'தலைமை அலுவலகம் மறுத்தது:', cannotReach: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் மாற்றப்படவில்லை.',
    readingOtb: 'தலைமை அலுவலகத்திலிருந்து பட்ஜெட்டைப் படிக்கிறது…', notSignedIn: 'யாரும் உள்நுழையவில்லை — பட்ஜெட்டைப் படிக்க முடியாது.',
    proposedOver: 'ஆர்டர் முன்மொழியப்பட்டது — இந்த மாதப் பட்ஜெட்டை மீறிய தொகை',
  },
};
let lang = 'en';
const t = (key) => WORDS[lang][key] ?? WORDS.en[key];

// ── U2 · G5: pick a thing, never type its code ──────────────────────────────
// A "Choose…" button beside an id field opens the shared picker (sreOffice.pick, the chrome); the pick writes the id into
// the field and names it beside, so the page still sends exactly the id it always sent. The field stays typeable: when the
// list cannot be read (head office down, no right) typing the code is the fallback, never a dead end (P-01, P-08).
const pickers = [];
function pickerBeside(input, kind, titleKey, extra = {}) {
  const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'sre-btn pick-btn'; btn.id = `${input.id}-pick`;
  const name = document.createElement('small'); name.className = 'pick-name'; name.id = `${input.id}-name`;
  const host = input.closest('label') ?? input; // beside the field, never inside its label (the label names the input, not the button)
  host.after(btn, name);
  btn.addEventListener('click', async () => {
    const office = window.sreOffice;
    if (!office || typeof office.pick !== 'function') { name.textContent = t('pickUnavailable'); return; }
    const picked = await office.pick({ kind, title: { en: WORDS.en[titleKey], ta: WORDS.ta[titleKey] }, allowCode: true, ...extra });
    if (!picked || picked.ok !== true) return;
    input.value = picked.id;
    name.textContent = picked.name && picked.name !== picked.id ? `${picked.name} (${picked.id})` : '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  input.addEventListener('input', (e) => { if (e.isTrusted) name.textContent = ''; });
  pickers.push(btn);
  btn.textContent = t('choose'); // named from the first paint, however early the page mounts it
  return btn;
}
const paintPickers = () => { for (const b of pickers) b.textContent = t('choose'); };
/** The signed-in person's own store, from the chrome (sreOffice.me) or the store computer's directory — '' when not known. */
function myStore() {
  const office = window.sreOffice;
  const me = office && typeof office.me === 'function' ? office.me() : null;
  return (me && me.storeId) || (window.sreDirectory && window.sreDirectory.store && window.sreDirectory.store.id) || '';
}

/** Why a capture was refused — one entry per `CaptureRefusal` in the model, in both languages. */
const REFUSAL_WORDS = {
  file_has_problems: { en: 'Some lines need fixing on the paper invoice first. Nothing has been saved.', ta: 'சில வரிகளை முதலில் சரிசெய்ய வேண்டும். எதுவும் சேமிக்கப்படவில்லை.' },
  does_not_add_up_to_the_invoice_total: { en: 'The lines do not add up to the total on the paper. Either a line is wrong or a line is missing.', ta: 'வரிகள் தாளில் உள்ள மொத்தத்துடன் பொருந்தவில்லை. ஒரு வரி தவறு அல்லது ஒரு வரி விடுபட்டுள்ளது.' },
  nothing_to_capture: { en: 'There is nothing in this file to save.', ta: 'இந்தக் கோப்பில் சேமிக்க எதுவும் இல்லை.' },
  already_captured: { en: 'This invoice has already been saved. Saving it twice would double what this supplier is owed.', ta: 'இந்த இன்வாய்ஸ் ஏற்கனவே சேமிக்கப்பட்டுள்ளது. இரண்டு முறை சேமித்தால் சப்ளையருக்கு இரட்டிப்பாகும்.' },
};

/**
 * Where a saved invoice is — the five states of the shared device → store-computer contract (`packages/sync/device-relay`
 * DEVICE_ITEM_STATES), the same words the manager screen and the handhelds use (SP-2a · SP-7a).
 */
const STATE_WORDS = {
  saved_here: { en: 'Saved on this device — not yet with the store computer', ta: 'இந்தக் கருவியில் சேமிக்கப்பட்டது — கடை கணினிக்கு இன்னும் செல்லவில்லை' },
  retrying: { en: 'Saved on this device — the store computer could not be reached, trying again', ta: 'இந்தக் கருவியில் சேமிக்கப்பட்டது — கடை கணினியை அடைய முடியவில்லை, மீண்டும் முயற்சிக்கிறது' },
  handed_to_box: { en: 'With the store computer — it will send this to head office', ta: 'கடை கணினியிடம் உள்ளது — அது இதை தலைமை அலுவலகத்திற்கு அனுப்பும்' },
  posted: { en: 'Posted at head office', ta: 'தலைமை அலுவலகத்தில் பதிவாகியது' },
  refused: { en: 'Refused — a person must look at this', ta: 'மறுக்கப்பட்டது — ஒருவர் இதைப் பார்க்க வேண்டும்' },
};

const words = (map, key) => (map[key]?.[lang] ?? map[key]?.en ?? String(key).replace(/_/g, ' '));

/**
 * What the store box did not tell this screen — one sentence per `BuyingGap` in the entry.
 *
 * Each of these already fails toward a refusal, so nothing here is protecting against a wrong
 * answer. It is protecting against the buyer *mis-reading a right one*: "this was never ordered"
 * looks identical whether the supplier invented the line or the box was simply never sent the
 * order, and only one of those is an argument to have with a supplier.
 */
const GAP_WORDS = {
  who_is_buying: {
    en: 'Nobody is signed in on this screen, so nothing can be saved or ordered. Sign in as yourself to buy.',
    ta: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை. எனவே எதையும் சேமிக்கவோ ஆர்டர் செய்யவோ முடியாது. வாங்க உங்கள் பெயரில் உள்நுழையுங்கள்.',
  },
  what_this_shop_stocks: {
    en: 'It has not been told what this shop stocks, so every line will be reported as an item we do not carry.',
    ta: 'இந்தக் கடையில் என்ன பொருட்கள் உள்ளன என்று தெரியவில்லை. எனவே எல்லா வரிகளும் "நாங்கள் வைத்திருக்காத பொருள்" என்று காட்டப்படும்.',
  },
  what_was_ordered: {
    en: 'It has not been told what was ordered, so nothing can be checked against an order.',
    ta: 'என்ன ஆர்டர் செய்யப்பட்டது என்று தெரியவில்லை. எனவே ஆர்டருடன் எதையும் ஒப்பிட முடியாது.',
  },
  what_arrived: {
    en: 'It has not been told what arrived, so an invoice cannot be checked against the delivery.',
    ta: 'என்ன வந்தது என்று தெரியவில்லை. எனவே இன்வாய்ஸை வந்த பொருட்களுடன் ஒப்பிட முடியாது.',
  },
  which_invoices_are_already_saved: {
    en: 'It has not been told which invoices are already saved, so it cannot warn you about saving one twice.',
    ta: 'எந்த இன்வாய்ஸ்கள் ஏற்கனவே சேமிக்கப்பட்டுள்ளன என்று தெரியவில்லை. இரண்டு முறை சேமிப்பதைப் பற்றி எச்சரிக்க முடியாது.',
  },
};

/**
 * Sample buying data with the same surface as the bundled session, so the flow is reviewable
 * before a real invoice arrives. Replaced at build time by the tested model; whenever it is in use
 * the header says so.
 */
function sampleSession() {
  return {
    previewInvoice: ({ declaredTotalMinor }) => ({
      lines: [{ productId: 'SAMPLE-1', quantity: 10, unitPriceMinor: 10_000, lineTotalMinor: 100_000 }],
      sumMinor: 100_000,
      declaredTotalMinor,
      readyToApprove: declaredTotalMinor === 100_000,
      // No line-level problems on purpose: this stand-in demonstrates the case only the control
      // total can catch — every line perfect, and the paper still says something else.
      problems: [],
      preview: { reconciles: declaredTotalMinor === 100_000 },
    }),
    captureInvoice: () => ({ ok: false, refusal: 'nothing_to_capture', detail: 'this is sample data' }),
    match: () => ({
      lines: [], payableMinor: 0, invoicedMinor: 0, withheldMinor: 0, blocked: true,
      detail: 'sample', ownerAction: 'This is sample data — nothing has been compared.',
    }),
    raisePurchaseOrder: () => { throw new Error('this is sample data'); },
  };
}

const real = window.buyingSession;
const session = real ?? sampleSession();

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

// ── What the box did not say ────────────────────────────────────────────────

/** Everything the box did not tell this screen, named on the page rather than left to be guessed. */
function renderGaps() {
  const gaps = window.buyingGaps ?? [];
  el('gaps').hidden = gaps.length === 0;
  el('gaps-title').textContent = t('gapsTitle');
  el('gaps-list').replaceChildren(...gaps.map((gap) => {
    const item = document.createElement('li');
    item.textContent = words(GAP_WORDS, gap);
    return item;
  }));
}

// ── Navigation ──────────────────────────────────────────────────────────────

const VIEWS = ['invoice', 'match', 'po', 'budget', 'orders', 'reorder'];
for (const name of VIEWS) {
  el(`tab-${name}`).addEventListener('click', () => {
    for (const other of VIEWS) {
      el(`view-${other}`).hidden = other !== name;
      el(`tab-${other}`).setAttribute('aria-current', other === name ? 'page' : 'false');
    }
  });
}

// ── The invoice flow ────────────────────────────────────────────────────────

let lastPreview = null;

/**
 * Check the invoice. **Writes nothing.**
 *
 * The two figures that must agree are rendered side by side and large: the file's own sum, and
 * what the buyer read off the paper. A single "does not reconcile" line at the bottom of a form is
 * a message people learn to click past.
 */
el('preview').addEventListener('click', () => {
  const text = el('file-text').value.trim();
  const declared = el('declared-total').value.trim();
  if (text === '') { tell(t('read'), t('needFile')); return; }
  if (declared === '') { tell(t('read'), t('needTotal')); return; }

  let preview;
  try {
    preview = session.previewInvoice({ text, declaredTotalMinor: toMinor(declared) });
  } catch (e) {
    // A file that will not parse is said plainly. The model refuses to treat it as an empty file,
    // which would read as a quiet day rather than a supplier's invoice nobody has read.
    tell(t('read'), String(e && e.message ? e.message : e));
    return;
  }
  lastPreview = preview;
  renderPreview(preview);
});

function renderPreview(preview) {
  const verdict = el('verdict');
  verdict.hidden = false;
  verdict.className = 'verdict ' + (preview.readyToApprove ? 'ready' : 'problem');
  verdict.replaceChildren();

  const headline = document.createElement('strong');
  headline.textContent = preview.readyToApprove ? t('readyToSave') : t('notReady');

  const counts = document.createElement('span');
  counts.className = 'totals';
  counts.textContent = `${preview.lines.length} ${t('linesFound')}`
    + (preview.problems.length > 0 ? ` · ${preview.problems.length} ${t('problemsFound')}` : '');

  // The two figures, side by side. The one that is wrong is coloured — never colour alone, the
  // words above it say which is which.
  const compare = document.createElement('div');
  compare.className = 'compare';
  const off = preview.sumMinor !== preview.declaredTotalMinor;
  for (const [label, minor, isWrong] of [
    [t('fileSays'), preview.sumMinor, off],
    [t('paperSays'), preview.declaredTotalMinor, false],
  ]) {
    const box = document.createElement('div');
    const l = document.createElement('span');
    l.className = 'label';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'value' + (isWrong ? ' off' : '');
    v.textContent = inr(minor);
    box.append(l, v);
    compare.append(box);
  }

  verdict.append(headline, counts, compare);
  if (off) {
    const why = document.createElement('span');
    why.className = 'totals';
    why.textContent = t('doesNotAddUp');
    verdict.append(why);
  }

  // Every problem, by line number, so somebody can go and look at the paper.
  el('problems').replaceChildren(...preview.problems.map((problem) => {
    const row = document.createElement('div');
    row.className = 'problem-row';
    const where = document.createElement('span');
    where.className = 'where';
    where.textContent = `${t('line')} ${problem.line}: `;
    row.append(where, document.createTextNode(problem.message));
    return row;
  }));

  el('lines-preview').replaceChildren(linesTable(preview.lines));
  // The save button does not exist on the page until the model says the file may be saved.
  el('capture').hidden = !preview.readyToApprove;
  el('preview').classList.toggle('sre-btn-primary', !preview.readyToApprove); el('capture').classList.toggle('sre-btn-primary', preview.readyToApprove);
  el('capture').textContent = t('saveInvoice');
}

/** OB-31: the smallest steps a line holds as a person reads them (2500 of a kg item → "2.500 kg") — the session's word. */
function quantityText(productId, quantityMinor) {
  return typeof session.quantityText === 'function' ? session.quantityText(productId, quantityMinor) : String(quantityMinor);
}

function linesTable(lines) {
  const table = document.createElement('table');
  const head = document.createElement('tr');
  for (const [text, cls] of [[t('item'), ''], [t('howMany'), 'amount'], [t('agreedPrice'), 'amount'], [t('lineTotal'), 'amount']]) {
    const th = document.createElement('th');
    th.textContent = text;
    if (cls) th.className = cls;
    head.append(th);
  }
  table.append(head);
  for (const line of lines) {
    const row = document.createElement('tr');
    for (const [text, cls] of [
      [line.productId, ''], [quantityText(line.productId, line.quantity), 'amount'],
      [inr(line.unitPriceMinor), 'amount'], [inr(line.lineTotalMinor), 'amount'],
    ]) {
      const td = document.createElement('td');
      td.textContent = text;
      if (cls) td.className = cls;
      row.append(td);
    }
    table.append(row);
  }
  return table;
}

el('capture').addEventListener('click', () => {
  const invoiceId = el('invoice-id').value.trim();
  if (invoiceId === '') { tell(t('read'), t('needInvoiceNumber')); return; }
  if (lastPreview === null) return;

  // No "who checked this invoice?" here. The bill is captured by the signed-in buyer and carries no
  // checker — head office does not trust a name typed on this screen. The check is a second person's
  // own act at head office: the match, under their own sign-in.
  const poId = el('invoice-po').value.trim();
  const outcome = session.captureInvoice({
    invoiceId,
    supplierId: el('supplier-id').value.trim(),
    poId: poId === '' ? null : poId,
    preview: lastPreview,
  });

  if (!outcome.ok) {
    tell(t('read'), words(REFUSAL_WORDS, outcome.refusal));
    return;
  }
  // Saved means ON THE DEVICE (SP-7a · F02): the model queued it before it said ok. The list says where it goes next.
  tell(t('saved'), `${outcome.lines.length} × ${inr(outcome.totalMinor)} — ${t('savedNote')}`, true);
  el('capture').hidden = true;
  el('preview').classList.add('sre-btn-primary');
  renderSavedInvoices();
  void syncToBox();
});

/**
 * Every invoice this screen saved and where each has got to (SP-7a · F02), read from the DURABLE device queue, so the
 * list is the same after a reload — the proof the invoice was not lost with the tab. Each row carries one of the five
 * shared state words; a refusal carries its reason, because a person has to act on it.
 */
function renderSavedInvoices() {
  const saved = typeof session.savedInvoices === 'function' ? session.savedInvoices() : [];
  el('saved-title').hidden = saved.length === 0;
  el('saved-lead').hidden = saved.length === 0;
  el('saved-invoices').replaceChildren(...saved.map((w) => {
    const row = document.createElement('div');
    row.className = 'saved';
    row.dataset.state = w.state;
    row.dataset.id = w.invoiceId;
    const what = document.createElement('div');
    what.className = 'what';
    what.textContent = `${w.invoiceId} · ${w.supplierId} — ${w.lineCount} ${t('linesWord')} · ${inr(w.totalMinor)} · ${w.poId === null ? t('noOrderWord') : w.poId}`;
    const state = document.createElement('div');
    state.className = `pill ${w.state}`;
    state.textContent = words(STATE_WORDS, w.state);
    row.append(what, state);
    if (w.reason) {
      const why = document.createElement('div');
      why.className = 'why';
      why.textContent = w.reason;
      row.append(why);
    }
    return row;
  }));
}

/**
 * Hand this screen's saved invoices to the store computer and learn where they have got to (SP-7a). The relay is the
 * composition root's (`window.buyingRelay`), present only when the box told this screen where its socket is. Called
 * after every capture and on a slow timer; a box that cannot be reached leaves everything saved here and says so.
 */
async function syncToBox() {
  const relay = window.buyingRelay;
  if (!relay) return;
  try {
    await relay.syncNow();
  } catch {
    /* the queue is untouched; the state words say "saved on this device" */
  }
  renderSavedInvoices();
}
// No timer on this page (the banner never fades, and neither does anything else run on a clock): the queue is handed on
// after every capture, when the page regains the network or the buyer's attention, and at boot — the store computer
// carries it from there whenever it is reached.
for (const moment of ['online', 'focus', 'pageshow']) window.addEventListener(moment, () => { void syncToBox(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) void syncToBox(); });

// ── The three-way match ─────────────────────────────────────────────────────

el('run-match').addEventListener('click', () => {
  const result = session.match({
    poId: el('match-po').value.trim(),
    invoiceId: el('match-invoice').value.trim(),
  });

  const verdict = el('match-verdict');
  verdict.hidden = false;
  verdict.className = 'verdict ' + (result.blocked ? 'problem' : 'ready');
  verdict.replaceChildren();

  const headline = document.createElement('strong');
  headline.textContent = result.blocked ? t('blocked') : t('agreed');
  const totals = document.createElement('span');
  totals.className = 'totals';
  totals.textContent = `${t('payable')}: ${inr(result.payableMinor)}`
    + (result.withheldMinor > 0 ? ` · ${t('withheld')}: ${inr(result.withheldMinor)}` : '');
  const action = document.createElement('span');
  action.className = 'totals';
  // The model's own sentence. It already distinguishes "checked and clean" from "not checked", and
  // rewording it here would put a second, untested version of that distinction on the screen.
  action.textContent = result.ownerAction;

  verdict.append(headline, totals, action);
  el('match-lines').replaceChildren(...(result.lines.length === 0 ? [] : [matchTable(result.lines)]));
});

function matchTable(lines) {
  const table = document.createElement('table');
  const head = document.createElement('tr');
  for (const [text, cls] of [[t('item'), ''], [t('payable'), 'amount'], [t('whatIsWrong'), '']]) {
    const th = document.createElement('th');
    th.textContent = text;
    if (cls) th.className = cls;
    head.append(th);
  }
  table.append(head);
  for (const line of lines) {
    const row = document.createElement('tr');
    if (line.status === 'blocked') row.className = 'blocked';
    for (const [text, cls] of [
      [line.productId, ''], [inr(line.payableMinor), 'amount'], [line.detail, ''],
    ]) {
      const td = document.createElement('td');
      td.textContent = text;
      if (cls) td.className = cls;
      row.append(td);
    }
    table.append(row);
  }
  return table;
}

// ── Raising a purchase order ────────────────────────────────────────────────

let poLines = [];

function renderPoLines() {
  if (poLines.length === 0) {
    const none = document.createElement('p');
    none.className = 'empty';
    none.textContent = t('noLinesYet');
    el('po-lines').replaceChildren(none);
    return;
  }
  el('po-lines').replaceChildren(linesTable(poLines.map((l) => ({
    productId: l.productId, quantity: l.orderedQty,
    // OB-31 rule 3: grams × the price per kg ÷ 1000, rounded once — the session's arithmetic, never qty × price here.
    unitPriceMinor: l.unitCostMinor,
    lineTotalMinor: typeof session.lineValueMinor === 'function' ? session.lineValueMinor(l.productId, l.orderedQty, l.unitCostMinor) : l.unitCostMinor * l.orderedQty,
  }))));
}

/** OB-31: the unit the typed item is counted in ('ea' when the screen was not told). */
const unitOfTyped = () => {
  const productId = el('po-product').value.trim();
  return productId !== '' && typeof session.unitOf === 'function' ? session.unitOf(productId) : 'ea';
};

/** The quantity and price boxes name the item's unit, so "10" beside "kg" is ten kilos — what is typed is what is ordered. */
function paintPoUnit() {
  const unit = unitOfTyped();
  const many = (WORDS[lang].unitMany ?? WORDS.en.unitMany)[unit] ?? unit;
  const one = (WORDS[lang].unitOne ?? WORDS.en.unitOne)[unit] ?? unit;
  el('po-qty-label').textContent = t('howManyIn').replace('{unit}', many);
  el('po-cost-label').textContent = t('pricePer').replace('{one}', one);
}
el('po-product').addEventListener('input', paintPoUnit);
pickerBeside(el('po-supplier'), 'supplier', 'whichSupplier');
pickerBeside(el('po-store'), 'store', 'whichStore');
pickerBeside(el('po-product'), 'product', 'whichItem');
paintPickers();
// "Deliver to store" is the person's own store unless they change it (U2 · G5); the chrome may load after this page.
const prefillStore = () => { if (el('po-store').value.trim() === '') { const id = myStore(); if (id !== '') el('po-store').value = id; } };
prefillStore();
document.addEventListener('sre:chrome', prefillStore);

el('add-po-line').addEventListener('click', () => {
  const productId = el('po-product').value.trim();
  const typedQty = el('po-qty').value.trim();
  // OB-31 rule 1: what is typed is in the item's own unit ("10" kg); the order holds and sends its smallest steps (10000 g).
  const orderedQty = typeof session.orderQuantityFrom === 'function'
    ? session.orderQuantityFrom(productId, typedQty)
    : (/^\d+$/.test(typedQty) && Number(typedQty) > 0 ? Number(typedQty) : undefined);
  const unitCostMinor = toMinor(el('po-cost').value);
  if (productId === '' || typedQty === '' || !Number.isFinite(unitCostMinor) || unitCostMinor <= 0) {
    tell(t('read'), t('needPoFields'));
    return;
  }
  if (orderedQty === undefined) {
    tell(t('read'), t('needWholeItems'));
    return;
  }
  poLines.push({ productId, orderedQty, unitCostMinor });
  el('po-product').value = '';
  el('po-qty').value = '';
  el('po-cost').value = '';
  paintPoUnit();
  renderPoLines();
});

el('raise-po').addEventListener('click', async () => {
  if (poLines.length === 0) { tell(t('read'), t('needPoLine')); return; }

  // Raising an order PROPOSES it to head office in the buyer's OWN name (§28). It does NOT ask the buyer
  // to type an "approved by" name here — issuing is a separate second person's act, which head office
  // enforces by the authenticated identity of whoever approves it. So there is no self-approval to make.
  const stamp = Date.now().toString(36).toUpperCase();
  const poId = `PO-${stamp}`;
  const out = await session.proposeToCloud({
    poId,
    supplierId: el('po-supplier').value.trim(),
    deliverToLocationId: el('po-store').value.trim(),
    lines: poLines,
  });
  if (out.proposed) {
    // Only after head office genuinely saved the proposal — never a false "raised" on a dropped link (P-08).
    // WF-03 · OB-63 (round 12): head office's open-to-buy check rides on the order; over budget, it escalates to the owner.
    if (out.budget?.overBudget) tell(`${t('proposedOver')} ${inr(out.budget.overByMinor)}`, `${poId} · ${inr(out.totalMinor)} — ${t('escalates')}`);
    else tell(t('orderProposed'), `${poId} · ${inr(out.totalMinor)}`, true);
    poLines = [];
    renderPoLines();
  } else {
    // A blocked supplier, a lost link, or a box not connected to head office — said plainly, never swallowed.
    tell(t('read'), out.reason);
  }
});

// ── Open to buy (WF-03 · D02-FR-01 · D03-FR-01 · OB-63, round 12) ──────────────
//
// Head office's figures, read live under the signed-in buyer's session (`window.buyingOpenToBuy`, the tested model in
// apps/web-erp/src/open-to-buy-session.ts). Opening the tab only READS; setting a budget and issuing an order are a
// person's clicks, and every refusal is head office's own words. Nothing about the budget is decided on this page.

const otb = window.buyingOpenToBuy ?? null;
let otbLast = null;
// OB-606 (M01-FR-02): the SHOP's month (its zone, as the store computer told the page) — never this device's own month.
const thisMonth = () => (window.sreShopDay === undefined ? '' : window.sreShopDay.thisMonth());

function otbSay(id, answer, good) {
  const node = el(id);
  if (answer.ok) { node.className = 'otb-status good'; node.textContent = good; return; }
  node.className = 'otb-status err';
  node.textContent = answer.unreachable ? t('cannotReach') : `${t('refusedBy')} ${answer.whatHappened}`;
}

function textCell(tag, text, cls) { const c = document.createElement(tag); c.textContent = text; if (cls) c.className = cls; return c; }

async function readOtb() {
  if (otb === null) { el('budget-status').className = 'otb-status err'; el('budget-status').textContent = t('notSignedIn'); return; }
  el('budget-status').className = 'otb-status';
  el('budget-status').textContent = t('readingOtb');
  const answer = await otb.read(el('budget-period').value || thisMonth(), el('budget-store').value);
  if (!answer.ok) { otbSay('budget-status', answer, ''); return; }
  otbLast = answer.value;
  el('budget-status').textContent = '';
  renderOtb();
}

function issueControls(o, box) {
  const reason = document.createElement('input');
  reason.className = 'issue-reason';
  reason.setAttribute('aria-label', `${o.poId} — ${t('issueReason')}`);
  reason.placeholder = t('issueReason');
  const overReason = document.createElement('input');
  overReason.className = 'over-reason';
  overReason.setAttribute('aria-label', `${o.poId} — ${t('overReason')}`);
  overReason.placeholder = t('overReason');
  overReason.hidden = o.escalation === null;
  const go = document.createElement('button'); go.classList.add('sre-btn');
  go.type = 'button';
  go.dataset.act = 'issue';
  go.textContent = t('issueIt');
  const status = textCell('p', '', 'otb-status');
  status.id = `issue-status-${o.poId}`;
  status.setAttribute('role', 'status');
  go.addEventListener('click', async () => {
    const answer = await otb.issue(o.poId, reason.value, overReason.hidden ? undefined : overReason.value);
    otbSay(status.id, answer, answer.ok ? (answer.value.overBudget ? t('issuedOver') : t('issued')) : '');
    if (answer.ok) {
      const kept = status.textContent;
      await readOtb();
      el('budget-status').className = 'otb-status good';
      el('budget-status').textContent = `${o.poId}: ${kept}`;
    }
  });
  for (const node of [reason, overReason]) { const f = document.createElement('div'); f.className = 'field'; f.append(node); box.append(f); }
  box.append(go, status);
}

function renderOtb() {
  el('budget-set').hidden = otb === null || !otb.maySetBudget;
  el('budget-set-not').textContent = otb !== null && !otb.maySetBudget ? t('onlyOwnerSets') : '';
  if (otbLast === null) return;
  const { view, history, waiting } = otbLast;
  // Summary panels: how many categories are over, and what is left across the budgets head office holds.
  const over = view.rows.filter((r) => r.state === 'over').length;
  const open = view.rows.reduce((s, r) => s + (r.openToBuyMinor ?? 0), 0);
  el('budget-summary').replaceChildren(...[[t('categoriesOver'), String(over)], [t('totalOpen'), inr(open)]].map(([label, value]) => {
    const box = document.createElement('div');
    box.append(textCell('span', label, 'label'), textCell('span', value, 'value'));
    return box;
  }));
  const head = document.createElement('tr');
  for (const [k, cls] of [['category', ''], ['budget', 'amount'], ['committed', 'amount'], ['waitingCol', 'amount'], ['openToBuy', 'amount'], ['afterWaiting', 'amount'], ['stateCol', '']]) head.append(textCell('th', t(k), cls));
  const money = (m) => (m === null ? '—' : m < 0 ? `−${inr(-m)}` : inr(m));
  el('otb-table').replaceChildren(head, ...view.rows.map((r) => {
    const tr = document.createElement('tr');
    tr.dataset.category = r.categoryId;
    tr.dataset.state = r.state;
    if (r.state === 'over') tr.className = 'over';
    tr.append(
      textCell('td', r.categoryId + (r.budgetScope === null ? '' : ` (${r.budgetScope === 'store' ? t('forStore') : t('forCompany')})`)),
      textCell('td', money(r.budgetMinor), 'amount'), textCell('td', money(r.committedMinor), 'amount'), textCell('td', money(r.waitingMinor), 'amount'),
      textCell('td', money(r.openToBuyMinor), 'amount'), textCell('td', money(r.openAfterWaitingMinor), 'amount'), textCell('td', t(`st_${r.state}`)),
    );
    return tr;
  }));

  // Waiting orders — the ones head office found over budget first, each saying it escalates to the owner (OB-63).
  el('waiting-orders').replaceChildren(...(waiting.length === 0 ? [textCell('p', t('noWaiting'), 'empty')] : waiting.map((o) => {
    const box = document.createElement('div');
    box.className = `escalation${o.escalation ? ' over' : ''}`;
    box.dataset.po = o.poId;
    box.append(textCell('div', `${o.poId} · ${o.supplierId} · ${inr(o.totalMinor)} · ${t('raisedBy')} ${o.requisitionedBy}`, 'what'));
    if (o.escalation) box.append(textCell('div', `${t('overBy')} ${inr(o.escalation.overByMinor)} (${o.escalation.overCategories.map((c) => c.categoryId).join(', ')}). ${t('escalates')}`, 'why'));
    else box.append(textCell('div', o.checked ? t('withinBudget') : t('notChecked'), 'why'));
    if (otb.mayIssue) issueControls(o, box);
    return box;
  })));

  el('budget-overrides').replaceChildren(...(view.overrides.length === 0 ? [textCell('p', t('noOverrides'), 'empty')] : view.overrides.map((o) => {
    const row = textCell('div', `${o.poId} · ${t('overBy')} ${inr(o.overByMinor)} · ${t('letThrough')} ${o.approvedBy} · ${t('because')} “${o.reason}”`, 'version');
    row.dataset.po = o.poId;
    return row;
  })));

  el('budget-history').replaceChildren(...(history.length === 0 ? [textCell('p', t('noHistory'), 'empty')] : history.map((v) => {
    const row = textCell('div', `${v.categoryId}${v.storeId ? ` · ${v.storeId}` : ''} · ${inr(v.amountMinor)} · ${t('setByWord')} ${v.setBy} · “${v.reason}”${v.superseded ? ` — ${t('replaced')}` : ''}`, `version${v.superseded ? ' superseded' : ''}`);
    row.dataset.category = v.categoryId;
    row.dataset.superseded = String(v.superseded);
    return row;
  })));
}

el('budget-read').addEventListener('click', () => { void readOtb(); });
el('tab-budget').addEventListener('click', () => { if (otbLast === null) void readOtb(); });
el('budget-save').addEventListener('click', async () => {
  if (otb === null) return;
  const answer = await otb.setBudget({
    categoryId: el('budget-category').value, period: el('budget-period').value || thisMonth(), amount: el('budget-amount').value,
    reason: el('budget-reason').value, storeId: el('budget-store').value,
  });
  if (answer.ok === false && 'problem' in answer) {
    el('budget-set-status').className = 'otb-status err';
    el('budget-set-status').textContent = answer.problem === 'not_money' ? t('notMoney') : t('fillBudget');
    return;
  }
  otbSay('budget-set-status', answer, answer.ok ? (answer.value.supersedes ? t('budgetReplaced') : t('budgetSet')) : '');
  if (answer.ok) await readOtb();
});

// ── Open orders (M06-FR-04 · OB-289, Round 4b) ──────────────────────────────
//
// Head office's open-commitment report, read live under the signed-in person's session (`window.buyingOpenOrders`, the
// tested model in apps/web-erp/src/open-orders-session.ts). Opening the tab writes nothing; reading is a click. A person who
// approves orders may change (amend) or cancel part of an issued order — each a click with a reason, head office's answer
// shown in its own words, and the report read again so what is shown is what head office kept.

const oo = window.buyingOpenOrders ?? null;
const ot = (k) => (oo === null ? k : oo.words(lang, k));
let ooLast = null;

function ooSay(node, out, good) { node.className = `otb-status ${out.result === 'ok' ? 'good' : 'err'}`; node.textContent = oo.outcomeWords(lang, out, good); }

function groupRows(groups, label) {
  if (groups.length === 0) return [textCell('p', '—', 'empty')];
  return groups.map((g) => {
    const row = document.createElement('div');
    row.className = 'group-row';
    row.dataset.key = g.key;
    row.append(textCell('span', label(g.key)), textCell('span', `${g.orders} ${ot('orders')} · ${g.lines} ${ot('lines')} · ${oo.rupees(g.openValueMinor)}`));
    return row;
  });
}

function ooInput(cls, value, label) { const i = document.createElement('input'); i.className = cls; i.value = value; i.autocomplete = 'off'; i.setAttribute('aria-label', label); return i; }
function ooField(node) { const f = document.createElement('div'); f.className = 'field'; f.append(node); return f; }

function orderBox(order) {
  const lines = ooLast.report.lines.filter((l) => l.poId === order.poId);
  const unit = (productId) => order.lines.find((l) => l.productId === productId)?.uom ?? 'ea';
  const box = document.createElement('div');
  box.className = 'open-order';
  box.dataset.po = order.poId;
  const scope = lines[0]?.buyingScope ?? 'scope_not_recorded';
  box.append(textCell('div', `${ot('order')} ${order.number} (${order.poId}) · ${ot('supplier')} ${order.supplierId} · ${ot('deliverTo')} ${order.deliverTo === 'store_not_named' ? ot('store_not_named') : order.deliverTo} · ${ot(`sc_${scope}`)}${order.amendmentCount > 0 ? ` · ${order.amendmentCount} ${ot('amendments')}` : ''}`, 'what'));
  const wrap = document.createElement('div'); wrap.className = 'table-wrap';
  const table = document.createElement('table');
  table.className = 'open-lines';
  const head = document.createElement('tr');
  for (const [k, cls] of [['product', ''], ['ordered', 'amount'], ['received', 'amount'], ['cancelled', 'amount'], ['open', 'amount'], ['value', 'amount']]) head.append(textCell('th', ot(k), cls));
  table.append(head);
  for (const l of lines) {
    const tr = document.createElement('tr');
    tr.dataset.product = l.productId;
    if (l.openQty < 0 || !l.agrees) tr.className = 'blocked';
    const u = unit(l.productId);
    tr.append(textCell('td', l.productId), textCell('td', oo.lineQty(l.orderedQty, u), 'amount'), textCell('td', oo.lineQty(l.receivedQty, u), 'amount'),
      textCell('td', oo.lineQty(l.cancelledQty, u), 'amount'), textCell('td', oo.lineQty(l.openQty, u), 'amount'), textCell('td', oo.rupees(l.openValueMinor), 'amount'));
    table.append(tr);
  }
  wrap.append(table);
  box.append(wrap);
  if (!oo.session.may.change) return box;

  // Change the order: every line's new quantity (in its unit) and price per unit.
  const amend = document.createElement('details');
  amend.className = 'amend';
  amend.append(textCell('summary', ot('amendH')), textCell('p', ot('amendLead'), 'lead'));
  const at = document.createElement('table');
  const ah = document.createElement('tr');
  for (const k of ['product', 'newQty', 'price']) ah.append(textCell('th', ot(k)));
  at.append(ah);
  for (const l of order.lines) {
    const tr = document.createElement('tr');
    tr.dataset.product = l.productId;
    const qty = ooInput('amend-qty', oo.editableQty(l.orderedQty, l.uom ?? 'ea'), `${l.productId} — ${ot('newQty')}`);
    const price = ooInput('amend-price', oo.editablePrice(l), `${l.productId} — ${ot('price')}`);
    if (price.value === '') price.placeholder = ot('casePriced');
    const q = document.createElement('td'); q.append(qty); const p = document.createElement('td'); p.append(price);
    tr.append(textCell('td', `${l.productId} (${l.uom ?? 'ea'})`), q, p);
    at.append(tr);
  }
  const aReason = ooInput('amend-reason', '', ot('reason')); aReason.placeholder = ot('reason');
  const aOver = ooInput('amend-over', '', ot('overBudgetReason')); aOver.placeholder = ot('overBudgetReason');
  const aGo = document.createElement('button'); aGo.type = 'button'; aGo.className = 'primary sre-btn sre-btn-primary'; aGo.dataset.act = 'amend'; aGo.textContent = ot('amend');
  const aStatus = textCell('p', '', 'otb-status'); aStatus.setAttribute('role', 'status');
  aGo.addEventListener('click', async () => {
    const out = await oo.session.amend(order, {
      lines: [...at.querySelectorAll('tr[data-product]')].map((tr) => ({ productId: tr.dataset.product, qtyText: tr.querySelector('input.amend-qty').value, priceText: tr.querySelector('input.amend-price').value })),
      reason: aReason.value, overBudgetReason: aOver.value,
    });
    if (out.result === 'ok') { await readOrders(); ooSay(el('orders-status'), out, 'amended'); return; }
    ooSay(aStatus, out);
  });
  amend.append(at, ooField(aReason), ooField(aOver), aGo, aStatus);
  box.append(amend);

  // Cancel quantity: per item, in its unit; blank means none of that item.
  const cancel = document.createElement('details');
  cancel.className = 'cancel';
  cancel.append(textCell('summary', ot('cancelH')));
  const ct = document.createElement('table');
  const chd = document.createElement('tr');
  for (const k of ['product', 'open', 'cancelQty']) chd.append(textCell('th', ot(k)));
  ct.append(chd);
  for (const l of lines) {
    const tr = document.createElement('tr');
    tr.dataset.product = l.productId;
    const qty = ooInput('cancel-qty', '', `${l.productId} — ${ot('cancelQty')}`);
    const q = document.createElement('td'); q.append(qty);
    tr.append(textCell('td', `${l.productId} (${unit(l.productId)})`), textCell('td', oo.lineQty(l.openQty, unit(l.productId))), q);
    ct.append(tr);
  }
  const cReason = ooInput('cancel-reason', '', ot('reason')); cReason.placeholder = ot('reason');
  const cGo = document.createElement('button'); cGo.classList.add('sre-btn'); cGo.type = 'button'; cGo.dataset.act = 'cancel'; cGo.textContent = ot('cancel');
  const cStatus = textCell('p', '', 'otb-status'); cStatus.setAttribute('role', 'status');
  cGo.addEventListener('click', async () => {
    const out = await oo.session.cancel(order, { lines: [...ct.querySelectorAll('tr[data-product]')].map((tr) => ({ productId: tr.dataset.product, qtyText: tr.querySelector('input.cancel-qty').value })), reason: cReason.value });
    if (out.result === 'ok') { await readOrders(); ooSay(el('orders-status'), out, 'cancelledNow'); return; }
    ooSay(cStatus, out);
  });
  cancel.append(ct, ooField(cReason), cGo, cStatus);
  box.append(cancel);
  return box;
}

function renderOrders() {
  for (const id of ['orders-summary', 'orders-by-scope', 'orders-by-supplier', 'orders-by-store', 'orders-exceptions', 'orders-list']) el(id).replaceChildren();
  if (ooLast === null) return;
  const r = ooLast.report;
  el('orders-summary').replaceChildren(...[[ot('totalOpen'), oo.rupees(r.totalOpenMinor)], [ot('issuedOrders'), String(r.issuedOrders)]].map(([label, value]) => {
    const box = document.createElement('div');
    box.append(textCell('span', label, 'label'), textCell('span', value, 'value'));
    return box;
  }));
  el('orders-by-scope').replaceChildren(...groupRows(r.byScope, (k) => ot(`sc_${k}`)));
  el('orders-by-supplier').replaceChildren(...groupRows(r.bySupplier, (k) => k));
  el('orders-by-store').replaceChildren(...groupRows(r.byStore, (k) => (k === 'store_not_named' ? ot('store_not_named') : k)));
  const unitOf = (poId, productId) => ooLast.orders.find((o) => o.poId === poId)?.lines.find((l) => l.productId === productId)?.uom ?? 'ea';
  const ex = [
    ...r.overReceived.map((o) => textCell('p', `⚠ ${ot('overReceived')}: ${o.poId} · ${o.productId} · ${oo.lineQty(o.overByQty, unitOf(o.poId, o.productId))}`, 'exception')),
    ...r.receiptsDisagree.map((o) => textCell('p', `⚠ ${ot('receiptsDisagree')}: ${o.poId} · ${o.productId}`, 'exception')),
  ];
  el('orders-exceptions').replaceChildren(...(ex.length === 0 ? [textCell('p', ot('noExceptions'), 'empty')] : ex));
  el('orders-list').replaceChildren(...(ooLast.orders.length === 0 ? [textCell('p', ot('noOrders'), 'empty')] : ooLast.orders.map(orderBox)));
}

async function readOrders() {
  if (oo === null) { el('orders-status').className = 'otb-status err'; el('orders-status').textContent = t('notSignedIn'); return; }
  const out = await oo.session.read({ buyingScope: el('orders-scope').value, supplierId: el('orders-supplier').value, storeId: el('orders-store').value });
  if (out.result !== 'ok') { ooLast = null; renderOrders(); ooSay(el('orders-status'), out); return; }
  ooLast = out.value;
  el('orders-status').className = 'otb-status'; el('orders-status').textContent = '';
  renderOrders();
}

function paintOrdersWords() {
  el('tab-orders').textContent = ot('tab');
  el('orders-title').textContent = ot('title');
  el('orders-lead').textContent = ot('lead');
  for (const [id, k] of [['orders-scope-label', 'filterScope'], ['orders-supplier-label', 'filterSupplier'], ['orders-store-label', 'filterStore'], ['orders-read', 'show'],
    ['orders-scope-all', 'allScopes'], ['orders-scope-cw', 'sc_central_via_warehouse'], ['orders-scope-cd', 'sc_central_direct_to_store'], ['orders-scope-local', 'sc_local'], ['orders-scope-nr', 'sc_scope_not_recorded'],
    ['orders-scope-h', 'byScopeH'], ['orders-supplier-h', 'bySupplierH'], ['orders-store-h', 'byStoreH'], ['orders-exceptions-h', 'exceptionsH'], ['orders-list-h', 'ordersH']]) el(id).textContent = ot(k);
  if (oo !== null && !oo.session.may.read) { el('orders-status').className = 'otb-status'; el('orders-status').textContent = ot(oo.session.may.named ? 'cannotRead' : 'nobody'); }
  renderOrders();
}

el('orders-read').addEventListener('click', () => { void readOrders(); });

// ── Reorder (M09-FR-02 · WF-03, Round 4b) ───────────────────────────────────
//
// The reorder settings stored per item at a store, head office's proposal worked out on them and its own stock (advisory
// only), and a requisition raised from ticked lines or from an assistant's draft — through the tested model
// (`window.buyingReorder`, apps/web-erp/src/replenishment-session.ts). Opening the tab writes nothing.

const rp = window.buyingReorder ?? null;
const rt = (k) => (rp === null ? k : rp.words(lang, k));
let rpParams = null;
let rpProposal = null;
const RP_FIELDS = ['maxLevel', 'reorderPoint', 'safetyStock', 'leadTimeDays', 'minOrderQty', 'orderMultiple', 'avgDailyDemand'];
function rpSay(id, out, good) { el(id).className = `otb-status ${out.result === 'ok' ? 'good' : 'err'}`; el(id).textContent = rp.outcomeWords(lang, out, good); }
const rpQty = (minor, productId) => (minor === undefined ? '—' : rp.qtyIn(minor, rp.session.uomOf(productId)));

function renderReorder() {
  el('reorder-proposal').replaceChildren(); el('reorder-params').replaceChildren(); el('reorder-exceptions').replaceChildren();
  el('reorder-raise-box').hidden = true;
  el('reorder-advisory').textContent = rpProposal === null ? '' : rt('advisory');
  if (rpProposal !== null) {
    const lines = rpProposal.proposals;
    if (lines.length === 0) el('reorder-proposal').append(textCell('caption', rpProposal.parametersNotSet ? rt('noParams') : rt('noProposal')));
    else {
      const head = document.createElement('tr');
      for (const k of ['choose', 'product', 'position', 'reorderPoint', 'suggested', 'yourQty']) head.append(textCell('th', rt(k)));
      el('reorder-proposal').append(head);
      for (const l of lines) {
        const tr = document.createElement('tr');
        tr.dataset.product = l.productId; tr.dataset.reason = l.reason;
        const pick = document.createElement('td');
        if (l.suggestedQty > 0 && rp.session.may.set) { const c = document.createElement('input'); c.type = 'checkbox'; c.className = 'tick'; c.setAttribute('aria-label', `${rt('choose')} ${l.productId}`); pick.append(c); }
        const mine = document.createElement('td');
        if (l.suggestedQty > 0 && rp.session.may.set) { const q = document.createElement('input'); q.className = 'qty'; q.setAttribute('aria-label', `${l.productId} — ${rt('yourQty')}`); mine.append(q); }
        tr.append(pick, textCell('td', l.productId), textCell('td', rpQty(l.position, l.productId)), textCell('td', rpQty(l.reorderPoint, l.productId)),
          textCell('td', `${rpQty(l.suggestedQty, l.productId)} · ${rt(`r_${l.reason}`)}`), mine);
        el('reorder-proposal').append(tr);
      }
      el('reorder-raise-box').hidden = !rp.session.may.set;
    }
    for (const o of rpProposal.outOfRange ?? []) el('reorder-exceptions').append(textCell('p', `${o.productId}: ${rt('outOfRange')} (${o.status})`, 'exception'));
    for (const o of rpProposal.stoppedByLifecycle ?? []) el('reorder-exceptions').append(textCell('p', `${o.productId}: ${rt('stopped')} (${o.lifecycle})`, 'exception'));
  }
  if (rpParams !== null) {
    if (rpParams.products.length === 0) { el('reorder-params').append(textCell('caption', rt('noParams'))); return; }
    const head = document.createElement('tr');
    for (const k of ['product', ...RP_FIELDS, 'version']) head.append(textCell('th', rt(k)));
    el('reorder-params').append(head);
    for (const { current: c, history } of rpParams.products) {
      const tr = document.createElement('tr');
      tr.dataset.product = c.productId; tr.dataset.version = String(c.version);
      tr.append(textCell('td', c.productId), ...RP_FIELDS.map((f) => textCell('td', f === 'leadTimeDays' ? (c[f] === undefined ? '—' : String(c[f])) : rpQty(c[f], c.productId))),
        textCell('td', `${rt('version')} ${c.version} · ${rt('setBy')} ${c.setBy} · ${rt('why')}: ${c.reason}${history.length > 1 ? ` · ${rt('history')}: ${history.slice(0, -1).map((h) => `v${h.version} ${rpQty(h.maxLevel, c.productId)} (${h.setBy})`).join(', ')}` : ''}`));
      el('reorder-params').append(tr);
    }
  }
}

async function readReorder() {
  if (rp === null) { el('reorder-status').className = 'otb-status err'; el('reorder-status').textContent = t('notSignedIn'); return; }
  const store = el('reorder-store').value;
  const [params, proposal] = [await rp.session.parameters(store), await rp.session.proposal(store)];
  if (params.result !== 'ok') { rpParams = null; rpProposal = null; renderReorder(); rpSay('reorder-status', params); return; }
  rpParams = params.value;
  if (proposal.result !== 'ok') { rpProposal = null; renderReorder(); rpSay('reorder-status', proposal); return; }
  rpProposal = proposal.value;
  el('reorder-status').className = 'otb-status'; el('reorder-status').textContent = '';
  renderReorder();
}

function paintReorderWords() {
  el('tab-reorder').textContent = rt('tab'); el('reorder-title').textContent = rt('title'); el('reorder-lead').textContent = rt('lead');
  for (const [id, k] of [['reorder-store-label', 'store'], ['reorder-read', 'show'], ['reorder-proposal-h', 'proposalH'], ['reorder-raise', 'raise'], ['reorder-params-h', 'paramsH'],
    ['reorder-set-h', 'setH'], ['rp-productId-l', 'product'], ['rp-reason-l', 'reason'], ['rp-save', 'set'], ['draft-h', 'draftH'], ['dr-id-l', 'draftId'], ['dr-product-l', 'product'], ['dr-qty-l', 'draftQty'], ['dr-raise', 'raiseDraft'],
    ...RP_FIELDS.map((f) => [`rp-${f}-l`, f])]) el(id).textContent = rt(k);
  if (rp !== null && !rp.session.may.read) { el('reorder-status').className = 'otb-status'; el('reorder-status').textContent = rt(rp.session.may.named ? 'cannotRead' : 'nobody'); }
  el('reorder-set').hidden = rp === null || !rp.session.may.set;
  renderReorder();
}

el('reorder-read').addEventListener('click', () => { void readReorder(); });
el('rp-save').addEventListener('click', async () => {
  if (rp === null) return;
  const form = Object.fromEntries(['productId', 'reason', ...RP_FIELDS].map((f) => [f, el(`rp-${f}`).value]));
  const out = await rp.session.setParameters(el('reorder-store').value, form);
  rpSay('rp-status', out, 'savedNow');
  if (out.result === 'ok') { await readReorder(); rpSay('rp-status', out, 'savedNow'); }
});
// A product chosen in the form shows its current settings, in its own unit, ready to change.
el('rp-productId').addEventListener('change', () => {
  const c = rpParams?.products.find((p) => p.current.productId === el('rp-productId').value.trim())?.current;
  if (c === undefined) return;
  for (const f of RP_FIELDS) el(`rp-${f}`).value = f === 'leadTimeDays' ? (c[f] === undefined ? '' : String(c[f])) : rp.editable(c[f], rp.session.uomOf(c.productId));
});
el('reorder-raise').addEventListener('click', async () => {
  const ticked = [...el('reorder-proposal').querySelectorAll('tr[data-product]')].filter((tr) => tr.querySelector('input.tick')?.checked === true)
    .map((tr) => ({ productId: tr.dataset.product, qtyText: tr.querySelector('input.qty')?.value ?? '' }));
  rpSay('reorder-raise-status', await rp.session.raise(rpProposal, ticked), 'raisedNow');
});
el('dr-raise').addEventListener('click', async () => {
  rpSay('dr-status', await rp.session.raiseFromDraft({ proposalId: el('dr-id').value, productId: el('dr-product').value, qtyText: el('dr-qty').value }), 'raisedNow');
});

// ── Language ────────────────────────────────────────────────────────────────

function paintChrome() {
  el('who').firstChild.textContent = `${t('buying')} `;
  el('whoami').textContent = window.buyingData?.buyerId ?? '';
  el('tab-invoice').textContent = t('supplierInvoice');
  el('tab-match').textContent = t('checkAgainst');
  el('tab-po').textContent = t('raiseOrder');
  el('invoice-title').textContent = t('supplierInvoice');
  el('invoice-lead').textContent = t('invoiceLead');
  el('invoice-id-label').textContent = t('invoiceNumber');
  el('supplier-id-label').textContent = t('supplier');
  el('invoice-po-label').textContent = t('invoicePo');
  el('saved-title').textContent = t('savedTitle');
  el('saved-lead').textContent = t('savedLead');
  el('declared-total-label').textContent = t('printedTotal');
  el('file-text-label').textContent = t('theLines');
  el('preview').textContent = t('checkThis');
  el('capture').textContent = t('saveInvoice');
  el('match-title').textContent = t('checkAgainst');
  el('match-lead').textContent = t('matchLead');
  el('match-po-label').textContent = t('comparePo');
  el('match-invoice-label').textContent = t('compareInvoice');
  el('run-match').textContent = t('compareThem');
  el('po-title').textContent = t('raiseOrder');
  el('po-lead').textContent = t('poLead');
  el('po-supplier-label').textContent = t('supplier');
  el('po-store-label').textContent = t('deliverTo');
  el('po-product-label').textContent = t('itemCode');
  paintPickers();
  paintPoUnit();
  el('add-po-line').textContent = t('addItem');
  el('raise-po').textContent = t('raiseIt');
  el('sample').textContent = t('sampleData');
  el('tab-budget').textContent = t('budgetTab');
  el('budget-title').textContent = t('budgetTab');
  el('budget-lead').textContent = t('budgetLead');
  el('budget-period-label').textContent = t('month');
  el('budget-store-label').textContent = t('budgetStore');
  el('budget-read').textContent = t('showMonth');
  el('waiting-title').textContent = t('waitingTitle');
  el('overrides-title').textContent = t('overridesTitle');
  el('budget-set-title').textContent = t('setTitle');
  el('budget-set-lead').textContent = t('setLead');
  el('budget-category-label').textContent = t('category');
  el('budget-amount-label').textContent = t('budgetAmount');
  el('budget-reason-label').textContent = t('budgetReason');
  el('budget-save').textContent = t('setIt');
  el('history-title').textContent = t('historyTitle');
  paintOrdersWords();
  paintReorderWords();
  renderOtb();
  renderGaps();
}

el('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  paintChrome();
  if (lastPreview !== null) renderPreview(lastPreview);
  renderPoLines();
  renderSavedInvoices();
});

// ── Boot ────────────────────────────────────────────────────────────────────

el('sample').hidden = real !== undefined;
if (el('budget-period').value === '') el('budget-period').value = thisMonth();
paintChrome();
renderPoLines();
renderSavedInvoices();
void syncToBox();

// ── The shell's own honesty about where this page came from ─────────────────
//

// The shell existed and nothing ever registered it, so nothing was ever cached and every one of
// these screens fell back to its sample data the moment the box was unreachable.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
