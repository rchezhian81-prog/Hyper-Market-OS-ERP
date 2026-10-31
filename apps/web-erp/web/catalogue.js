// Products and prices — the view layer. Every rule lives in the TESTED session model
// (`apps/web-erp/src/catalogue-session.ts`), attached as `window.catalogueSession`.
//
// ── The one decision this screen is built around ────────────────────────────
//
// **The two limits are on the page before anybody types a price**, not in the refusal afterwards:
// the MRP printed on the pack, and the lowest price that still keeps the shop's margin. A screen
// that only says "rejected" after the fact teaches people to guess, and guessing at a legal ceiling
// is how a shop ends up charging above MRP with an audit trail proving it meant to.
//
// ── The completeness score, and why it is never a bare percentage ───────────
//
// "68% complete" gets put on a wall and decided upon, and nobody can say what the other 32% is. So
// the counts come first — *four of seven done* — the percentage sits beside them, and every
// outstanding item is listed by name with what is missing. The bar is decoration; the list is the
// product.
//
// ── And what it never does ──────────────────────────────────────────────────
//
// There is no "publish anyway", no "override the MRP", and no button that sets a price and approves
// it in one motion. Nothing here writes before the model has been asked.
//
// ── And who approves (ADR-0024 · §28) ───────────────────────────────────────
//
// Nobody's name is typed or picked on this screen. A price below cost or below the margin floor, and
// an offer that loses margin, are ASKED for on head office's approval engine — with a reason the
// approver reads — and a different person who may approve prices approves or rejects it on their own
// Approvals page. Only then does "Save it" / "Start this offer" send the change, naming that approval.
// The words for every outcome come from the tested model, in both languages.
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
    title: 'Products and prices', items: 'Items', changePrice: 'Change a price', offer: 'Offer',
    shelves: 'Shelves',
    shelfLead: "Where each item sits. This is what puts the picker's list in the order they walk the shop.",
    shelf: 'Shelf', fits: 'How many fit on that facing', putItHere: 'Put it here',
    unmappedTitle: 'Items with no shelf address',
    unmappedLead: 'Each of these sends the picker back across the shop.',
    nothingUnmapped: 'Every item has a shelf address.',
    walkTitle: 'The order a picker would walk', noShelves: 'This shop has no shelf addresses yet.',
    needShelfFields: 'Pick an item, a shelf, and how many fit.',
    shelfSet: 'Shelf set', noShelfAddress: 'no shelf address',
    itemsLead: 'What is missing before each item can be sold. The ones needing least work are at the bottom.',
    findItem: 'Find an item', possibleDuplicates: 'Possible duplicates',
    duplicatesLead: 'Nothing here is ever merged automatically. Somebody has to look.',
    noDuplicates: 'Nothing looks like a duplicate.',
    noItems: 'This screen has not been given any items.',
    done: 'done', ofWord: 'of', required: 'needed before it can be sold', niceToHave: 'worth adding',
    stillNeeded: 'Still needed', cannotScore: 'This item cannot be checked',
    onSale: 'On sale', notOnSale: 'Not on sale', recallBlocked: 'Stopped — recall',
    discontinued: 'Discontinued', draft: 'Not finished', noPrice: 'No price set',
    priceNotRead: 'price: open the item to read it from head office', pricesReading: 'Reading the prices already set from head office…',
    whatYouCanDo: 'What you can do', putOnSale: 'Put this on sale',
    stopSelling: 'Stop selling this everywhere', allowSelling: 'Allow selling this again',
    recallNote: 'A recall block stops the till and the app at once, and keeps working with no internet.',
    backToList: 'Back to the list',
    priceLead: 'The two limits below are checked before anything is saved. A price over the MRP cannot be saved by anybody.',
    itemCode: 'Item code', mrpPrinted: 'MRP printed on the pack',
    lowestPrice: 'Lowest price that keeps the margin', newPrice: 'New price (in rupees)',
    startsOn: 'Starts on', checkPrice: 'Check this price', priceThis: 'Change price', priceThisOf: 'Change the price of',
    saveIt: 'Save this price', priceOk: 'This price is fine', needsApproval: 'Somebody else has to approve this',
    askForApproval: 'Ask for approval', saveWithApproval: 'Save it',
    priceApprovalLead: 'This price needs a second person. 1. Write why and press “Ask for approval”. 2. Someone else who may approve prices approves it on their Approvals page. 3. Come back and press “Save it”. Nothing is saved until then.',
    offerApprovalLead: 'This offer loses margin, so it needs a second person. 1. Write why and press “Ask for approval”. 2. Someone else who may approve prices approves it on their Approvals page. 3. Come back and press “Start this offer”. Nothing starts until then.',
    whyLabel: 'Why this is needed (the person approving reads it)',
    whyPlaceholder: 'For example: clearing short-dated stock before it is written off.',
    waitingTitle: 'Waiting for approval',
    priceRefused: 'This price cannot be saved', historyTitle: 'What this item has been priced at',
    noHistory: 'This item has never had a price set.', wasReplacing: 'Replaces',
    from: 'From', price: 'Price', status: 'State', version: 'Change',
    offerLead: '1. See what an offer does to the margin. 2. Record its rule at head office. 3. Start it.',
    ruleTitle: 'The offer\u2019s rule',
    ruleLead: 'Tell head office what the offer is. It is kept as a draft and does nothing until you start it.',
    ruleKind: 'Kind of offer', ruleProducts: 'Item codes it is on (leave blank for the whole bill)', ruleGroup: 'Or a group of items (optional)',
    ruleStarts: 'First day', ruleEnds: 'Last day', rulePercent: 'How much off (%)', ruleAmount: 'Rupees off',
    ruleBuy: 'Buy how many', ruleGet: 'Get how many', ruleMemberPrice: 'Members\u2019 price for one (in rupees)',
    ruleMultiQty: 'How many (2 or more)', ruleMultiPrice: 'For how many rupees',
    ruleBundleItems: 'The set (e.g. RICE x 2, DAL x 1)', ruleBundlePrice: 'Price of the whole set (in rupees)',
    ruleBuyProducts: 'Buy from these item codes', ruleBuyGroup: 'Or buy from this group',
    ruleGetProducts: 'Get from these item codes', ruleGetGroup: 'Or get from this group',
    ruleMinSpend: 'Least the items must add up to (in rupees, optional)', ruleCoupon: 'Coupon code the customer must give (optional)',
    ruleMemberOnly: 'Members only', ruleExclusive: 'Does not add to other offers in this group (optional — blank means it adds on)',
    ruleCap: 'Most times it applies on one bill (optional)', defineOffer: 'Record this rule at head office',
    ruleRecorded: 'Rule recorded at head office as a draft. It does nothing until you press \u201cStart this offer\u201d.',
    ruleRefused: 'Head office refused:', ruleUnreachable: 'Head office cannot be reached, so the rule was not recorded. Try again when the line is back.',
    ruleNotConnected: 'This screen is not connected to head office, so the rule was not recorded.',
    notDefinedYet: 'Not started — head office has no rule for this offer yet. Fill in \u201cThe offer\u2019s rule\u201d with the same name and press \u201cRecord this rule at head office\u201d first. Nothing was started.',
    offerName: 'Give this offer a name', normalPrice: 'Normal price (in rupees)',
    offerPrice: 'Offer price (in rupees)', costsUs: 'What it costs us (in rupees)',
    supplierPays: 'Supplier pays per unit (in rupees)', unitsNow: 'Units you sell now',
    unitsExpected: 'Units you expect with the offer', workItOut: 'Work out what it costs',
    startOffer: 'Start this offer', offerStarted: 'Offer started',
    extraNeeded: 'Extra units needed just to break even', unreachable: 'no volume makes this pay',
    ok: 'OK', read: 'Please read this',
    needItem: 'Give the item code first.', needPrice: 'Type the new price first.',
    needDate: 'Say what day this price starts.', needOfferFields: 'Fill in every figure first.',
    unknownItem: 'This screen has not been told about that item.',
    priceSaved: 'Price saved', priceSavedNote: 'It starts on the day you gave.',
    published: 'This item is on sale', recallSet: 'Selling stopped', recallLifted: 'Selling allowed again',
    sampleData: 'Sample data — this is not your shop.',
    gapsTitle: 'This screen has not been told everything',
  },
  ta: {
    title: 'பொருட்களும் விலைகளும்', items: 'பொருட்கள்', changePrice: 'விலையை மாற்று', offer: 'சலுகை',
    shelves: 'அலமாரிகள்',
    shelfLead: 'ஒவ்வொரு பொருளும் எங்கே இருக்கிறது. இதுவே பிக்கரின் பட்டியலை அவர் கடையை நடக்கும் வரிசையில் அமைக்கிறது.',
    shelf: 'அலமாரி', fits: 'அந்த இடத்தில் எத்தனை பொருந்தும்', putItHere: 'இங்கே வை',
    unmappedTitle: 'அலமாரி முகவரி இல்லாத பொருட்கள்',
    unmappedLead: 'இவை ஒவ்வொன்றும் பிக்கரை கடையின் மறுபக்கம் மீண்டும் அனுப்பும்.',
    nothingUnmapped: 'எல்லாப் பொருட்களுக்கும் அலமாரி முகவரி உள்ளது.',
    walkTitle: 'பிக்கர் நடக்கும் வரிசை', noShelves: 'இந்தக் கடையில் இன்னும் அலமாரி முகவரிகள் இல்லை.',
    needShelfFields: 'பொருள், அலமாரி, எத்தனை பொருந்தும் — எல்லாவற்றையும் தேர்ந்தெடுக்கவும்.',
    shelfSet: 'அலமாரி நிர்ணயிக்கப்பட்டது', noShelfAddress: 'அலமாரி முகவரி இல்லை',
    itemsLead: 'ஒவ்வொரு பொருளையும் விற்பதற்கு முன் என்ன தேவை. குறைந்த வேலை உள்ளவை கீழே.',
    findItem: 'பொருளைத் தேடு', possibleDuplicates: 'இரட்டிப்பாக இருக்கக்கூடியவை',
    duplicatesLead: 'இங்கு எதுவும் தானாக இணைக்கப்படாது. ஒருவர் பார்க்க வேண்டும்.',
    noDuplicates: 'இரட்டிப்பு எதுவும் தெரியவில்லை.',
    noItems: 'இந்தத் திரைக்கு எந்தப் பொருளும் கொடுக்கப்படவில்லை.',
    done: 'முடிந்தது', ofWord: '/', required: 'விற்பதற்கு முன் தேவை', niceToHave: 'சேர்ப்பது நல்லது',
    stillNeeded: 'இன்னும் தேவை', cannotScore: 'இந்தப் பொருளைச் சரிபார்க்க முடியவில்லை',
    onSale: 'விற்பனையில்', notOnSale: 'விற்பனையில் இல்லை', recallBlocked: 'நிறுத்தப்பட்டது — ரீகால்',
    discontinued: 'நிறுத்தப்பட்டது', draft: 'முடிக்கப்படவில்லை', noPrice: 'விலை நிர்ணயிக்கப்படவில்லை',
    priceNotRead: 'விலை: தலைமை அலுவலகத்திலிருந்து படிக்கப் பொருளைத் திறக்கவும்', pricesReading: 'ஏற்கனவே நிர்ணயித்த விலைகளைத் தலைமை அலுவலகத்திலிருந்து படிக்கிறது…',
    whatYouCanDo: 'நீங்கள் என்ன செய்யலாம்', putOnSale: 'இதை விற்பனைக்கு வை',
    stopSelling: 'இதை எல்லா இடத்திலும் விற்பதை நிறுத்து', allowSelling: 'மீண்டும் விற்க அனுமதி',
    recallNote: 'ரீகால் தடை பில்லிங் இயந்திரத்தையும் செயலியையும் உடனே நிறுத்தும். இணையம் இல்லாமலும் வேலை செய்யும்.',
    backToList: 'பட்டியலுக்குத் திரும்பு',
    priceLead: 'கீழே உள்ள இரு வரம்புகளும் சேமிக்கும் முன் சரிபார்க்கப்படும். MRP-ஐ விட அதிக விலையை யாராலும் சேமிக்க முடியாது.',
    itemCode: 'பொருள் குறியீடு', mrpPrinted: 'பாக்கெட்டில் அச்சிடப்பட்ட MRP',
    lowestPrice: 'லாபத்தைக் காக்கும் குறைந்தபட்ச விலை', newPrice: 'புதிய விலை (ரூபாயில்)',
    startsOn: 'தொடங்கும் நாள்', checkPrice: 'இந்த விலையைச் சரிபார்', priceThis: 'விலையை மாற்று', priceThisOf: 'இதன் விலையை மாற்று:',
    saveIt: 'இந்த விலையைச் சேமி', priceOk: 'இந்த விலை சரியானது', needsApproval: 'வேறு ஒருவர் இதை ஒப்புதல் அளிக்க வேண்டும்',
    askForApproval: 'அனுமதி கேள்', saveWithApproval: 'சேமி',
    priceApprovalLead: 'இந்த விலைக்கு இரண்டாம் நபர் தேவை. 1. ஏன் என்று எழுதி “அனுமதி கேள்” அழுத்தவும். 2. விலைகளை அனுமதிக்கக்கூடிய வேறொருவர் தனது அனுமதிகள் பக்கத்தில் அனுமதிப்பார். 3. பிறகு திரும்பி வந்து “சேமி” அழுத்தவும். அதுவரை எதுவும் சேமிக்கப்படாது.',
    offerApprovalLead: 'இந்தச் சலுகையால் லாபம் குறைவதால் இரண்டாம் நபர் தேவை. 1. ஏன் என்று எழுதி “அனுமதி கேள்” அழுத்தவும். 2. விலைகளை அனுமதிக்கக்கூடிய வேறொருவர் தனது அனுமதிகள் பக்கத்தில் அனுமதிப்பார். 3. பிறகு திரும்பி வந்து “இந்தச் சலுகையைத் தொடங்கு” அழுத்தவும். அதுவரை எதுவும் தொடங்காது.',
    whyLabel: 'இது ஏன் தேவை (அனுமதிப்பவர் இதைப் படிப்பார்)',
    whyPlaceholder: 'உதாரணம்: காலாவதி நெருங்கும் சரக்கை வீணாகும் முன் விற்றுத் தீர்க்க.',
    waitingTitle: 'அனுமதிக்காகக் காத்திருக்கிறது',
    priceRefused: 'இந்த விலையைச் சேமிக்க முடியாது', historyTitle: 'இந்தப் பொருளுக்கு இருந்த விலைகள்',
    noHistory: 'இந்தப் பொருளுக்கு இதுவரை விலை நிர்ணயிக்கப்படவில்லை.', wasReplacing: 'மாற்றுவது',
    from: 'முதல்', price: 'விலை', status: 'நிலை', version: 'மாற்றம்',
    offerLead: '1. சலுகையால் லாபத்தில் என்ன விளைவு என்று பாருங்கள். 2. அதன் விதியைத் தலைமை அலுவலகத்தில் பதிவு செய்யுங்கள். 3. அதைத் தொடங்குங்கள்.',
    ruleTitle: 'சலுகையின் விதி',
    ruleLead: 'சலுகை என்ன என்று தலைமை அலுவலகத்திற்குச் சொல்லுங்கள். அது வரைவாக வைக்கப்படும்; நீங்கள் தொடங்கும் வரை எதையும் செய்யாது.',
    ruleKind: 'சலுகையின் வகை', ruleProducts: 'இது பொருந்தும் பொருள் குறியீடுகள் (முழு பில்லுக்கு காலியாக விடவும்)', ruleGroup: 'அல்லது பொருள் குழு (விருப்பம்)',
    ruleStarts: 'முதல் நாள்', ruleEnds: 'கடைசி நாள்', rulePercent: 'எவ்வளவு தள்ளுபடி (%)', ruleAmount: 'தள்ளுபடி ரூபாய்',
    ruleBuy: 'எத்தனை வாங்க வேண்டும்', ruleGet: 'எத்தனை கிடைக்கும்', ruleMemberPrice: 'உறுப்பினர் விலை ஒன்றுக்கு (ரூபாயில்)',
    ruleMultiQty: 'எத்தனை (2 அல்லது அதற்கு மேல்)', ruleMultiPrice: 'எத்தனை ரூபாய்க்கு',
    ruleBundleItems: 'தொகுப்பு (எ.கா. RICE x 2, DAL x 1)', ruleBundlePrice: 'முழுத் தொகுப்பின் விலை (ரூபாயில்)',
    ruleBuyProducts: 'இந்தப் பொருள் குறியீடுகளிலிருந்து வாங்க', ruleBuyGroup: 'அல்லது இந்தக் குழுவிலிருந்து வாங்க',
    ruleGetProducts: 'இந்தப் பொருள் குறியீடுகளிலிருந்து கிடைக்கும்', ruleGetGroup: 'அல்லது இந்தக் குழுவிலிருந்து கிடைக்கும்',
    ruleMinSpend: 'பொருட்களின் குறைந்தபட்ச மொத்தம் (ரூபாயில், விருப்பம்)', ruleCoupon: 'வாடிக்கையாளர் தர வேண்டிய கூப்பன் குறியீடு (விருப்பம்)',
    ruleMemberOnly: 'உறுப்பினர்களுக்கு மட்டும்', ruleExclusive: 'இந்தக் குழுவின் மற்ற சலுகைகளுடன் சேராது (விருப்பம் — காலியாக இருந்தால் சேரும்)',
    ruleCap: 'ஒரு பில்லில் அதிகபட்சம் எத்தனை முறை (விருப்பம்)', defineOffer: 'இந்த விதியைத் தலைமை அலுவலகத்தில் பதிவு செய்',
    ruleRecorded: 'விதி தலைமை அலுவலகத்தில் வரைவாகப் பதிவானது. “இந்தச் சலுகையைத் தொடங்கு” அழுத்தும் வரை எதையும் செய்யாது.',
    ruleRefused: 'தலைமை அலுவலகம் மறுத்தது:', ruleUnreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை, எனவே விதி பதிவாகவில்லை. இணைப்பு வந்ததும் மீண்டும் முயலுங்கள்.',
    ruleNotConnected: 'இந்தத் திரை தலைமை அலுவலகத்துடன் இணைக்கப்படவில்லை, எனவே விதி பதிவாகவில்லை.',
    notDefinedYet: 'தொடங்கப்படவில்லை — இந்தச் சலுகைக்கு தலைமை அலுவலகத்தில் இன்னும் விதி இல்லை. அதே பெயருடன் “சலுகையின் விதி” பகுதியை நிரப்பி முதலில் “இந்த விதியைத் தலைமை அலுவலகத்தில் பதிவு செய்” அழுத்தவும். எதுவும் தொடங்கப்படவில்லை.',
    offerName: 'இந்தச் சலுகைக்கு ஒரு பெயர் கொடுங்கள்', normalPrice: 'சாதாரண விலை (ரூபாயில்)',
    offerPrice: 'சலுகை விலை (ரூபாயில்)', costsUs: 'நமக்கு ஆகும் செலவு (ரூபாயில்)',
    supplierPays: 'சப்ளையர் தரும் தொகை (ரூபாயில்)', unitsNow: 'இப்போது விற்கும் அளவு',
    unitsExpected: 'சலுகையுடன் எதிர்பார்க்கும் அளவு', workItOut: 'என்ன செலவாகும் என்று கணக்கிடு',
    startOffer: 'இந்தச் சலுகையைத் தொடங்கு', offerStarted: 'சலுகை தொடங்கியது',
    extraNeeded: 'நஷ்டமில்லாமல் இருக்க கூடுதலாகத் தேவையான அளவு', unreachable: 'எந்த அளவு விற்றாலும் ஈடுசெய்யாது',
    ok: 'சரி', read: 'இதைப் படிக்கவும்',
    needItem: 'முதலில் பொருள் குறியீட்டைக் கொடுக்கவும்.', needPrice: 'முதலில் புதிய விலையைத் தட்டச்சு செய்யவும்.',
    needDate: 'இந்த விலை எந்த நாளில் தொடங்கும் என்று சொல்லுங்கள்.', needOfferFields: 'முதலில் எல்லா எண்களையும் நிரப்பவும்.',
    unknownItem: 'அந்தப் பொருளைப் பற்றி இந்தத் திரைக்குத் தெரியவில்லை.',
    priceSaved: 'விலை சேமிக்கப்பட்டது', priceSavedNote: 'நீங்கள் கொடுத்த நாளில் தொடங்கும்.',
    published: 'இந்தப் பொருள் விற்பனையில் உள்ளது', recallSet: 'விற்பனை நிறுத்தப்பட்டது', recallLifted: 'விற்பனை மீண்டும் அனுமதிக்கப்பட்டது',
    sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
    gapsTitle: 'இந்தத் திரைக்கு எல்லாத் தகவலும் வரவில்லை',
  },
};
let lang = 'en';
const t = (key) => WORDS[lang][key] ?? WORDS.en[key];

/** Why a price change was refused — one entry per `PriceChangeRefusal`, in both languages. */
const PRICE_REFUSAL_WORDS = {
  above_the_printed_mrp: {
    en: 'This is more than the MRP printed on the pack. Nobody can approve it — MRP is the law, not a shop rule.',
    ta: 'இது பாக்கெட்டில் அச்சிடப்பட்ட MRP-ஐ விட அதிகம். இதை யாராலும் ஒப்புதல் அளிக்க முடியாது — MRP சட்டம், கடை விதி அல்ல.',
  },
  below_the_margin_floor: {
    en: 'This earns less than the shop’s minimum margin. It can still be done, but somebody else has to approve it and say why.',
    ta: 'இது கடையின் குறைந்தபட்ச லாபத்தை விடக் குறைவு. செய்யலாம், ஆனால் வேறு ஒருவர் ஒப்புதல் அளித்து காரணம் சொல்ல வேண்டும்.',
  },
  below_what_it_cost_us: {
    en: 'This sells for less than the goods cost. It can still be done, but somebody else has to approve it and say why.',
    ta: 'இது பொருளின் விலையை விடக் குறைவாக விற்கிறது. செய்யலாம், ஆனால் வேறு ஒருவர் ஒப்புதல் அளித்து காரணம் சொல்ல வேண்டும்.',
  },
  the_cost_is_not_known_so_the_margin_was_never_checked: {
    en: 'This screen has no cost price for this item, so nobody can say what this price earns. It needs somebody to approve it with their eyes open.',
    ta: 'இந்தப் பொருளுக்கான செலவு விலை இந்தத் திரைக்குத் தெரியவில்லை. எனவே இந்த விலை என்ன ஈட்டும் என்று சொல்ல முடியாது. ஒருவர் தெரிந்தே ஒப்புதல் அளிக்க வேண்டும்.',
  },
  no_mrp_recorded: {
    en: 'No MRP has been recorded for this item, so the legal ceiling cannot be checked. Add the MRP from the pack first.',
    ta: 'இந்தப் பொருளுக்கு MRP பதிவு செய்யப்படவில்லை. எனவே சட்ட வரம்பைச் சரிபார்க்க முடியாது. முதலில் பாக்கெட்டில் உள்ள MRP-ஐச் சேர்க்கவும்.',
  },
  approved_by_the_person_who_set_it: {
    en: 'The person who set this price cannot also approve it. Somebody else has to look at it.',
    ta: 'இந்த விலையை நிர்ணயித்தவரே ஒப்புதல் அளிக்க முடியாது. வேறு ஒருவர் பார்க்க வேண்டும்.',
  },
  starts_in_the_past: {
    en: 'A price cannot start before today. Back-dating it would change what yesterday’s sales should have charged.',
    ta: 'ஒரு விலை இன்றைக்கு முன் தொடங்க முடியாது. பின்தேதி இட்டால் நேற்றைய விற்பனையின் விலை மாறிவிடும்.',
  },
  same_as_the_price_already_running: {
    en: 'This is the price already running. Nothing would change.',
    ta: 'இது ஏற்கனவே இயங்கும் விலைதான். எதுவும் மாறாது.',
  },
};

/** Why a product could not be published — one entry per `PublishRefusal`. */
const PUBLISH_REFUSAL_WORDS = {
  not_finished: {
    en: 'Some things are still missing from this item. They are listed above.',
    ta: 'இந்தப் பொருளில் சில தகவல்கள் இன்னும் விடுபட்டுள்ளன. மேலே பட்டியலிடப்பட்டுள்ளன.',
  },
  recall_blocked: {
    en: 'This item is stopped because of a recall. Lift that first — putting it on sale would undo it.',
    ta: 'ரீகால் காரணமாக இந்தப் பொருள் நிறுத்தப்பட்டுள்ளது. முதலில் அதை நீக்கவும் — விற்பனைக்கு வைத்தால் அது ரத்தாகும்.',
  },
  barcode_belongs_to_another_item: {
    en: 'That barcode already belongs to another item. One barcode rings up one product.',
    ta: 'அந்த பார்கோடு ஏற்கனவே வேறு பொருளுக்கு உரியது. ஒரு பார்கோடு ஒரு பொருளையே காட்ட வேண்டும்.',
  },
  // B2: a pack carries one printed MRP at a time — two different MRPs from the same date are refused, never saved.
  two_mrps_on_one_date: {
    en: 'Refused: this item has two different MRPs starting on the same date. A pack may carry only one MRP at a time. Keep the MRP already on record, or give the new MRP its own later date.',
    ta: 'மறுக்கப்பட்டது: இந்தப் பொருளுக்கு ஒரே தேதியில் தொடங்கும் இரண்டு வெவ்வேறு MRP-கள் உள்ளன. ஒரு பொட்டலத்தில் ஒரே நேரத்தில் ஒரு MRP மட்டுமே இருக்கலாம். பதிவில் உள்ள MRP-யை வைத்திருங்கள், அல்லது புதிய MRP-க்குப் பிந்தைய தனித் தேதியைக் கொடுங்கள்.',
  },
};

/** B2 · B4: the names of the checks added for the statutory pack rules, in both languages (others read as the engine says). */
const CHECK_LABEL_WORDS = {
  mrpHistory: { en: 'one MRP per date', ta: 'ஒரு தேதிக்கு ஒரே MRP' },
  'safety.consumerCareContact': { en: 'a consumer-care contact', ta: 'வாடிக்கையாளர் புகார் தொடர்பு (பெயர், தொலைபேசி அல்லது மின்னஞ்சல்)' },
};

/** Why a shelf could not be set — one entry per `ShelfRefusal`, in both languages. */
const SHELF_REFUSAL_WORDS = {
  this_box_has_no_shelf_map: {
    en: 'This screen has not been told the shop’s shelf addresses, so there is nowhere to put anything yet.',
    ta: 'கடையின் அலமாரி முகவரிகள் இந்தத் திரைக்குத் தெரியவில்லை. எனவே எதையும் வைக்க இடம் இல்லை.',
  },
  no_such_shelf_in_this_shop: {
    en: 'There is no such shelf in this shop.',
    ta: 'இந்தக் கடையில் அப்படி ஒரு அலமாரி இல்லை.',
  },
  a_shelf_facing_with_no_capacity_holds_nothing: {
    en: 'Say how many fit on that shelf facing. A facing that holds nothing cannot be refilled.',
    ta: 'அந்த இடத்தில் எத்தனை பொருந்தும் என்று சொல்லுங்கள். எதுவும் பிடிக்காத இடத்தை நிரப்ப முடியாது.',
  },
  it_already_lives_somewhere_else: {
    en: 'This item already lives on another shelf. Two homes means the picker’s route and the refill task disagree about where it is, and then both are wrong.',
    ta: 'இந்தப் பொருள் ஏற்கனவே வேறு அலமாரியில் உள்ளது. இரண்டு இடங்கள் என்றால் பிக்கரின் வழியும் நிரப்பும் வேலையும் வேறுபடும்; இரண்டுமே தவறாகும்.',
  },
};

/** What the store box did not tell this screen — one sentence per `CatalogueGap`. */
const GAP_WORDS = {
  what_the_shop_sells: {
    en: 'It has not been told what this shop sells, so there is nothing here to work on.',
    ta: 'இந்தக் கடை என்ன விற்கிறது என்று தெரியவில்லை. எனவே இங்கு வேலை செய்ய எதுவும் இல்லை.',
  },
  what_each_department_needs: {
    en: 'It has not been told what each department requires, so no item can be checked at all — that is why some show as “cannot be checked” rather than 0%.',
    ta: 'ஒவ்வொரு பிரிவுக்கும் என்ன தேவை என்று தெரியவில்லை. எனவே எந்தப் பொருளையும் சரிபார்க்க முடியாது — சிலவற்றில் 0% அல்ல, "சரிபார்க்க முடியவில்லை" என்று காட்டப்படுவது அதனால்தான்.',
  },
  what_things_cost: {
    en: 'It has not been told what things cost us, so no margin can be worked out and every price change will need an approver.',
    ta: 'பொருட்களுக்கு நமக்கு ஆகும் செலவு தெரியவில்லை. எனவே லாபத்தைக் கணக்கிட முடியாது; ஒவ்வொரு விலை மாற்றத்திற்கும் ஒப்புதல் தேவை.',
  },
  the_prices_already_set: {
    en: 'It has not been told the prices already set, so the history is empty and a repeated price cannot be spotted.',
    ta: 'ஏற்கனவே நிர்ணயித்த விலைகள் தெரியவில்லை. எனவே வரலாறு காலியாக இருக்கும்; மீண்டும் அதே விலை என்பதைக் கண்டறிய முடியாது.',
  },
  which_barcodes_are_taken: {
    en: 'It has not been told which barcodes are already in use, so a clash cannot be spotted before it happens.',
    ta: 'எந்த பார்கோடுகள் ஏற்கனவே பயன்பாட்டில் உள்ளன என்று தெரியவில்லை. எனவே மோதலை முன்கூட்டியே கண்டறிய முடியாது.',
  },
  where_things_sit_on_the_shelves: {
    en: 'It has not been told where things sit on the shelves, so the picker’s list is in whatever order it arrived rather than the order they walk the shop.',
    ta: 'பொருட்கள் அலமாரியில் எங்கே இருக்கின்றன என்று தெரியவில்லை. எனவே பிக்கரின் பட்டியல் அவர் நடக்கும் வரிசையில் இல்லாமல், வந்த வரிசையிலேயே இருக்கும்.',
  },
  which_zones_to_collect_last: {
    en: 'It has not been told which zones to collect last, so the chiller is picked wherever it falls in aisle order rather than at the end.',
    ta: 'எந்தப் பகுதிகளைக் கடைசியாக எடுக்க வேண்டும் என்று தெரியவில்லை. எனவே குளிர்சாதனப் பொருட்கள் கடைசியில் அல்லாமல், வரிசையில் வரும் இடத்திலேயே எடுக்கப்படும்.',
  },
};

/** The kinds of offer this tab defines (`OFFER_KINDS`) — the engine's list less the bank-card offer (OB-305: off). */
const OFFER_KIND_WORDS = {
  percent_off: { en: 'Percent off', ta: 'சதவீதத் தள்ளுபடி' },
  amount_off: { en: 'Rupees off', ta: 'ரூபாய் தள்ளுபடி' },
  buy_x_get_y: { en: 'Buy some, get some free', ta: 'சில வாங்கினால் சில இலவசம்' },
  member_price: { en: 'Members\u2019 price', ta: 'உறுப்பினர் விலை' },
  multibuy: { en: 'So many for one price (e.g. 3 for ₹99)', ta: 'இத்தனை ஒரு விலைக்கு (எ.கா. 3 ₹99க்கு)' },
  bundle_price: { en: 'A set of items at one price', ta: 'ஒரு விலையில் பொருள் தொகுப்பு' },
  mix_match: { en: 'Buy from one set, get from another', ta: 'ஒரு தொகுப்பில் வாங்கி மற்றொன்றில் பெறுக' },
};

/** Why a rule could not be sent — one entry per `OfferDefinitionProblem`. Nothing was sent. */
const OFFER_PROBLEM_WORDS = {
  needs_name: { en: 'Give the offer a name first (the same name you start it with). Nothing was sent.', ta: 'முதலில் சலுகைக்கு ஒரு பெயர் கொடுங்கள் (தொடங்கும் அதே பெயர்). எதுவும் அனுப்பப்படவில்லை.' },
  needs_kind: { en: 'Pick the kind of offer. Nothing was sent.', ta: 'சலுகையின் வகையைத் தேர்ந்தெடுக்கவும். எதுவும் அனுப்பப்படவில்லை.' },
  needs_days: { en: 'Give the first and the last day, the last not before the first. Nothing was sent.', ta: 'முதல் மற்றும் கடைசி நாளைக் கொடுக்கவும்; கடைசி நாள் முதல் நாளுக்கு முன் இருக்கக்கூடாது. எதுவும் அனுப்பப்படவில்லை.' },
  not_a_number: { en: 'A figure is not a number (rupees like 12.50, whole counts like 3, a percentage like 10). Nothing was sent.', ta: 'ஒரு எண் சரியாக இல்லை (ரூபாய் 12.50 போல, எண்ணிக்கை 3 போல, சதவீதம் 10 போல). எதுவும் அனுப்பப்படவில்லை.' },
  bad_bundle_line: { en: 'Write the set as item code x how many, separated by commas — for example RICE x 2, DAL x 1. Nothing was sent.', ta: 'தொகுப்பை பொருள் குறியீடு x எத்தனை என்று காற்புள்ளியால் பிரித்து எழுதவும் — எ.கா. RICE x 2, DAL x 1. எதுவும் அனுப்பப்படவில்லை.' },
};

const words = (map, key) => (map[key]?.[lang] ?? map[key]?.en ?? String(key).replace(/_/g, ' '));

/**
 * A stand-in with the same surface as the bundled session, so the flow is reviewable before a real
 * catalogue arrives. Replaced at build time by the tested model; whenever it is in use the header
 * says so.
 */
function sampleSession() {
  const product = {
    productId: 'SAMPLE-1', sku: 'SAMPLE-1', name: 'Sample item', primaryCategoryId: 'sample',
    baseUom: 'ea', taxClass: null, lifecycle: 'draft',
  };
  return {
    shelf: () => [{
      product,
      validation: null,
      score: { knowable: true, productId: 'SAMPLE-1', checks: [], required: { done: 4, total: 5 }, advisory: { done: 1, total: 2 }, percent: 71, publishable: false },
      sellable: 'not_published',
      priceToday: null,
    }],
    needsWork: () => [],
    inspect: () => ({ product, validation: null, score: { knowable: false, productId: 'SAMPLE-1', why: 'this is sample data' }, sellable: 'not_published', priceToday: null }),
    publish: () => ({ ok: false, refusal: 'not_finished', detail: 'this is sample data', missing: [] }),
    setRecallBlock: (p, blocked) => ({ ...p, recallBlocked: blocked }),
    duplicates: () => [],
    shelves: () => [],
    shelfOf: () => null,
    assignShelf: () => ({ ok: false, refusal: 'this_box_has_no_shelf_map', detail: 'this is sample data' }),
    walk: () => ({ steps: [], ordering: 'the order the list arrived in — this store has no shelf map', unmapped: [] }),
    proposePrice: () => ({
      draft: { id: 'sample', productId: 'SAMPLE-1', price: { minor: 0, currency: 'INR' }, effectiveFrom: '', status: 'draft', version: 1 },
      replaces: null, check: null, cleanToActivate: false, needsApproval: false,
      refusals: ['no_mrp_recorded'], detail: ['this is sample data'],
    }),
    activatePrice: () => ({ ok: false, refusals: ['no_mrp_recorded'], detail: ['this is sample data'] }),
    canChangePriceInCloud: false,
    changePriceInCloud: async () => ({ saved: false, reason: 'this is sample data' }),
    rollBack: (e) => e,
    historyFor: () => [],
    simulate: () => ({ promotionId: 'sample', verdict: 'improves_margin', promoUnitMargin: { minor: 0, currency: 'INR' }, baselineUnitMargin: { minor: 0, currency: 'INR' }, baselineTotalMargin: { minor: 0, currency: 'INR' }, promoTotalMargin: { minor: 0, currency: 'INR' }, incrementalMargin: { minor: 0, currency: 'INR' }, breakEvenUnits: 0, blocksApproval: false, detail: 'this is sample data' }),
    launch: () => ({ ok: false, detail: 'this is sample data' }),
    canLaunchToCloud: false,
    launchToCloud: async () => ({ launched: false, reason: 'this is sample data' }),
    canDefineOffer: false,
    defineOffer: async () => ({ kind: 'not_connected' }),
    // A sample view is connected to nothing, so nothing that needs a second person moves — and it says so.
    canAskForApproval: false,
    askPriceApproval: async () => ({ kind: 'not_connected' }),
    savePriceWithApproval: async () => ({ kind: 'not_connected' }),
    askLaunchApproval: async () => ({ kind: 'not_connected' }),
    launchWithApproval: async () => ({ kind: 'not_connected' }),
    presentAskOutcome: (l) => sampleWords(l),
    presentUseOutcome: (l) => sampleWords(l),
    quote: () => ({ grossTotal: { minor: 0, currency: 'INR' }, discount: { minor: 0, currency: 'INR' }, netTotal: { minor: 0, currency: 'INR' }, applied: [] }),
  };
}

/** The sample view's one answer to anything that needs a second person: it is connected to nothing. */
const SAMPLE_NOT_CONNECTED = {
  en: 'This is sample data and is not connected to head office, so nothing was asked and nothing was saved.',
  ta: 'இது மாதிரித் தகவல், தலைமை அலுவலகத்துடன் இணைக்கப்படவில்லை; எனவே எதுவும் கேட்கப்படவில்லை, எதுவும் சேமிக்கப்படவில்லை.',
};
const sampleWords = (l) => {
  const label = SAMPLE_NOT_CONNECTED[l] ?? SAMPLE_NOT_CONNECTED.en;
  return { tone: 'error', icon: '✕', label, announcement: label, needsAttention: true };
};

const real = window.catalogueSession;
const session = real ?? sampleSession();

// ── The banner ──────────────────────────────────────────────────────────────

/** The banner: `good` for done, `'pending'` for waiting on a second person, anything else needs reading. */
function tell(title, message, good = false) {
  el('banner-title').textContent = title;
  el('banner-text').textContent = message;
  el('banner').classList.toggle('good', good === true);
  el('banner').classList.toggle('pending', good === 'pending');
  el('banner').hidden = false;
  el('banner-ok').textContent = t('ok');
  el('banner-ok').focus();
}
el('banner-ok').addEventListener('click', () => { el('banner').hidden = true; });

/**
 * Say what happened to an ask or a save that needs a second person — in the model's own words (both
 * languages, tested), with a title that matches: done, waiting, or please read.
 */
function tellApproval(kind, presented, subject) {
  if (kind === 'done') {
    tell(subject === 'price' ? t('priceSaved') : subject === 'mrp' ? mw('replaced') : t('offerStarted'), presented.label, true);
  } else if (kind === 'asked' || kind === 'waiting') {
    tell(t('waitingTitle'), presented.label, 'pending');
  } else {
    tell(t('read'), presented.label);
  }
}

/** Run a click's work once: the button is disabled while head office answers, so a double tap asks once. */
async function busy(id, work) {
  const button = el(id);
  if (button.disabled) return;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try { await work(); } finally { button.disabled = false; button.removeAttribute('aria-busy'); }
}

const me = () => window.catalogueData?.userId ?? 'pricing';
const today = () => window.catalogueData?.today ?? '';

/** Everything the box did not tell this screen, named rather than left to be guessed. */
function renderGaps() {
  const gaps = window.catalogueGaps ?? [];
  el('gaps').hidden = gaps.length === 0;
  el('gaps-title').textContent = t('gapsTitle');
  el('gaps-list').replaceChildren(...gaps.map((gap) => {
    const item = document.createElement('li');
    item.textContent = words(GAP_WORDS, gap);
    return item;
  }));
}

// ── Navigation ──────────────────────────────────────────────────────────────

const VIEWS = ['items', 'item', 'price', 'shelf', 'promo', 'rivals'];
const TABS = ['items', 'price', 'shelf', 'promo', 'rivals'];

function show(name) {
  for (const view of VIEWS) el(`view-${view}`).hidden = view !== name;
  for (const tab of TABS) {
    el(`tab-${tab}`).setAttribute('aria-current', tab === name ? 'page' : 'false');
  }
}
for (const name of TABS) {
  el(`tab-${name}`).addEventListener('click', () => { show(name); if (name === 'rivals') void loadRivals(); });
}
el('back-to-items').addEventListener('click', () => { show('items'); renderItems(); });

// ── The item list, worst-first (D01) ────────────────────────────────────────

const SELLABLE_WORDS = {
  sellable: 'onSale', recall_blocked: 'recallBlocked',
  discontinued: 'discontinued', not_published: 'draft',
};

let openProduct = null;

function renderItems() {
  const query = el('item-search').value.trim().toLowerCase();
  const views = session.shelf().filter((v) =>
    query === ''
    || v.product.name.toLowerCase().includes(query)
    || v.product.sku.toLowerCase().includes(query));

  if (views.length === 0) {
    const none = document.createElement('p');
    none.className = 'empty';
    none.textContent = t('noItems');
    el('item-list').replaceChildren(none);
  } else {
    // Least-finished first: the work goes where a field or two unlocks an item.
    const ordered = [...views].sort((a, b) => weightOf(a) - weightOf(b));
    el('item-list').replaceChildren(...ordered.map(itemRow));
  }

  const dupes = session.duplicates();
  el('dupes-title').textContent = t('possibleDuplicates');
  el('dupes-lead').textContent = t('duplicatesLead');
  if (dupes.length === 0) {
    const none = document.createElement('p');
    none.className = 'empty';
    none.textContent = t('noDuplicates');
    el('dupes').replaceChildren(none);
  } else {
    el('dupes').replaceChildren(...dupes.map((pair) => {
      const row = document.createElement('div');
      row.className = 'row';
      const what = document.createElement('span');
      what.className = 'what';
      const head = document.createElement('strong');
      head.textContent = `${pair.productIdA} · ${pair.productIdB}`;
      const why = document.createElement('small');
      why.textContent = `${pair.signal.replace(/_/g, ' ')} — ${pair.confidence.replace(/_/g, ' ')}`;
      what.append(head, why);
      row.append(what);
      return row;
    }));
  }
}

/** An unscoreable record sorts to the very top: nobody can even measure it. */
function weightOf(view) {
  if (!view.score.knowable) return -1;
  return view.score.percent;
}

function itemRow(view) {
  const row = document.createElement('div');
  row.className = 'row';
  if (view.sellable === 'recall_blocked') row.classList.add('stopped');

  const what = document.createElement('span');
  what.className = 'what';
  const name = document.createElement('strong');
  name.textContent = view.product.name === '' ? view.product.productId : view.product.name;
  const sub = document.createElement('small');
  sub.textContent = `${view.product.sku} · ${t(SELLABLE_WORDS[view.sellable] ?? 'notOnSale')}`
    + ` · ${priceWords(view)}`;
  what.append(name, sub);

  const pct = document.createElement('span');
  pct.className = 'pct';
  // Never a bare percentage: an unscoreable record says so in words instead of showing a number
  // that would read as "somebody has filled in nothing".
  pct.textContent = view.score.knowable
    ? `${view.score.required.done}/${view.score.required.total}`
    : '—';

  const open = document.createElement('button');
  open.type = 'button';
  open.textContent = '›';
  open.setAttribute('aria-label', view.product.name);
  open.addEventListener('click', () => { openItem(view.product); });

  // OB-390 · product-merchandising.md "edit a price ≤3 (open → new price → submit)": the price form opens ALREADY HOLDING
  // this item — its code filled, its MRP and margin floor shown — so the person types only the new price.
  const price = document.createElement('button');
  price.type = 'button';
  price.className = 'price-this';
  price.dataset.sku = view.product.sku;
  price.setAttribute('aria-label', `${t('priceThisOf')} ${view.product.name === '' ? view.product.sku : view.product.name}`);
  if (window.sreIcon && typeof window.sreIcon.withWord === 'function') price.replaceChildren(window.sreIcon.withWord('indian-rupee', t('priceThis')));
  else price.textContent = t('priceThis');
  price.addEventListener('click', () => { openPriceFor(view.product); });

  row.append(what, pct, price, open);
  return row;
}

// ── Round A: the prices already set, read from head office item by item (the store computer's relay) ─────────────
// The store setup never carries every price ever set; `window.cataloguePrices` reads one item's when it is opened. An item
// not read yet is never shown as "no price set", and a read that failed says why for that item (P-08).
const prices = window.cataloguePrices ?? null;
function priceWords(view) {
  const state = prices === null ? 'loaded' : prices.state(view.product.productId);
  if (state === 'loaded' || state === 'none') return view.priceToday === null ? t('noPrice') : inr(view.priceToday.price.minor);
  if (state === 'loading') return t('pricesReading');
  if (state === 'not_loaded') return t('priceNotRead');
  return prices.why(view.product.productId) ?? t('priceNotRead');
}
function readPrices(productId, again = false) {
  if (prices === null) return;
  const before = prices.state(productId);
  // Read once; a failed read is asked again only when the person opens the item again (never in a loop).
  if (!(before === 'not_loaded' || (again && (before === 'lost_link' || before === 'refused')))) return;
  void prices.load(productId).then(() => {
    renderItems();
    if (!el('view-price').hidden && productIdOfPriceForm() === productId) { renderLimits(); renderHistory(productId); }
    if (openProduct !== null && openProduct.productId === productId) renderItem();
  });
}
function productIdOfPriceForm() {
  const code = el('price-item').value.trim();
  const found = session.shelf().find((v) => v.product.sku === code || v.product.productId === code);
  return found === undefined ? code : found.product.productId;
}

/** OB-390: open "Change a price" holding this item — the code filled, the limits shown, the cursor in the price. */
function openPriceFor(product) {
  readPrices(product.productId, true);
  show('price');
  el('price-item').value = product.sku;
  el('new-price').value = '';
  el('price-verdict').hidden = true;
  el('save-price').hidden = true;
  el('price-approval').hidden = true;
  lastProposal = null;
  renderLimits();
  renderHistory(product.productId);
  el('new-price').focus();
}

// ── One item ────────────────────────────────────────────────────────────────

function openItem(product) {
  readPrices(product.productId, true);
  openProduct = product;
  show('item');
  renderItem();
}

function renderItem() {
  if (openProduct === null) return;
  const view = session.inspect(openProduct);
  el('item-title').textContent = view.product.name === '' ? view.product.productId : view.product.name;
  el('item-sub').textContent = `${view.product.sku} · ${t(SELLABLE_WORDS[view.sellable] ?? 'notOnSale')}`;
  el('item-actions-title').textContent = t('whatYouCanDo');
  el('publish').textContent = t('putOnSale');
  el('recall').textContent = view.product.recallBlocked === true ? t('allowSelling') : t('stopSelling');
  el('recall-note').textContent = t('recallNote');
  el('back-to-items').textContent = t('backToList');
  el('item-score').replaceChildren(...scoreParts(view.score));
}

/**
 * The completeness score: **counts first, percentage second, missing items by name.**
 *
 * A bare percentage gets decided upon and nobody can say what the rest of it is.
 */
function scoreParts(score) {
  const parts = [];
  const box = el('item-score');

  if (!score.knowable) {
    box.className = 'score unknown';
    const head = document.createElement('strong');
    head.textContent = t('cannotScore');
    const why = document.createElement('span');
    why.className = 'counts';
    why.textContent = score.why;
    parts.push(head, why);
    return parts;
  }

  box.className = 'score ' + (score.publishable ? 'ready' : 'blocked');

  const counts = document.createElement('span');
  counts.className = 'counts';
  counts.textContent = `${score.required.done} ${t('ofWord')} ${score.required.total} ${t('required')}`
    + ` · ${score.advisory.done} ${t('ofWord')} ${score.advisory.total} ${t('niceToHave')}`;

  const percent = document.createElement('span');
  percent.className = 'percent';
  percent.textContent = `${score.percent}%`;

  const bar = document.createElement('div');
  bar.className = 'bar';
  const fill = document.createElement('span');
  fill.style.width = `${score.percent}%`;
  bar.append(fill);

  parts.push(percent, counts, bar);

  const outstanding = score.checks.filter((c) => !c.done);
  if (outstanding.length > 0) {
    const head = document.createElement('strong');
    head.textContent = t('stillNeeded');
    const list = document.createElement('ul');
    list.className = 'missing';
    for (const check of outstanding) {
      const item = document.createElement('li');
      const field = document.createElement('span');
      field.className = 'field-name';
      field.textContent = `${CHECK_LABEL_WORDS[check.field] === undefined ? check.label : words(CHECK_LABEL_WORDS, check.field)}: `;
      item.append(field, document.createTextNode(check.missing ?? ''));
      list.append(item);
    }
    parts.push(head, list);
  }
  return parts;
}

el('publish').addEventListener('click', () => {
  if (openProduct === null) return;
  const draft = openProduct;
  const outcome = session.publish(draft);
  if (!outcome.ok) {
    tell(t('read'), words(PUBLISH_REFUSAL_WORDS, outcome.refusal));
    return;
  }
  // The Save reaches the shared truth: commit a durable publish command to the offline outbox (P-01, §31).
  // The session never touches the network from here — the sync agent drains the queue to the cloud.
  const queued = typeof session.requestPublish === 'function' ? session.requestPublish(draft) : { ok: true };
  openProduct = outcome.product;
  renderItem();
  if (queued.ok || queued.refusal === 'already_queued') {
    tell(t('published'), outcome.product.name, true);
  } else {
    // A validated product should always queue; if it could not, say so rather than imply it went through.
    tell(t('read'), words(PUBLISH_REFUSAL_WORDS, 'not_finished'));
  }
});

el('recall').addEventListener('click', () => {
  if (openProduct === null) return;
  // Two taps, by design. This is the control somebody reaches for when a supplier rings about
  // glass in a jar, and it is honoured offline because it travels in the catalogue pack.
  const blocked = openProduct.recallBlocked === true;
  openProduct = session.setRecallBlock(openProduct, !blocked);
  renderItem();
  tell(blocked ? t('recallLifted') : t('recallSet'), openProduct.name, blocked);
});

// ── Changing a price ────────────────────────────────────────────────────────

let lastProposal = null;

/**
 * Show the two limits for an item **before** anybody types a price.
 *
 * A screen that only says "rejected" afterwards teaches people to guess, and guessing at a legal
 * ceiling is how a shop charges above MRP with an audit trail proving it meant to.
 */
function renderLimits() {
  const sku = el('price-item').value.trim();
  const view = session.shelf().find((v) => v.product.sku === sku || v.product.productId === sku);
  el('mrp-label').textContent = t('mrpPrinted');
  el('floor-label').textContent = t('lowestPrice');
  if (view === undefined) {
    el('price-limits').hidden = true;
    return;
  }
  el('price-limits').hidden = false;
  readPrices(view.product.productId); // Round A: an item typed into the form has its prices read too

  const mrp = (view.product.mrpHistory ?? [])
    .filter((m) => m.effectiveFrom <= today())
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
    .at(-1);
  el('mrp-value').textContent = mrp === undefined ? '—' : inr(mrp.value.minor);
  renderMrpReplace(view.product.productId);

  // The floor is derived from the cost and the tenant's own margin policy. Absent a cost there is
  // no floor to show, and a dash is the honest answer — not a zero that would read as "anything
  // goes".
  const costMinor = window.catalogueData?.costsMinor?.[view.product.productId];
  const floorBps = window.catalogueData?.marginFloorBps;
  el('floor-value').textContent = costMinor === undefined || floorBps === undefined
    ? '—'
    : inr(Math.ceil((costMinor * 10_000) / (10_000 - floorBps)));
}
el('price-item').addEventListener('input', renderLimits);

// ── OB-512: replacing an MRP that is not yet in force ───────────────────────
const MRP_REPLACE_WORDS = {
  en: { title: 'Replace an MRP that is not yet in force', lead: 'Only an MRP whose start date has not come yet can be replaced. Write why and ask for approval; once a second person approves it, press “Replace it”. The old MRP stays on record beside the new one.', date: 'Which MRP (its start date)', newMrp: 'New MRP (in rupees)', why: 'Why it is replaced (the person approving reads it)', ask: 'Ask for approval', save: 'Replace it', from: 'from', replaced: 'MRP replaced' },
  ta: { title: 'இன்னும் நடைமுறைக்கு வராத MRP-ஐ மாற்றுதல்', lead: 'தொடக்கத் தேதி இன்னும் வராத MRP-ஐ மட்டுமே மாற்ற முடியும். காரணத்தை எழுதி அனுமதி கேளுங்கள்; இரண்டாம் நபர் அனுமதித்ததும் “மாற்று” அழுத்துங்கள். பழைய MRP புதியதன் அருகில் பதிவில் இருக்கும்.', date: 'எந்த MRP (அதன் தொடக்கத் தேதி)', newMrp: 'புதிய MRP (ரூபாயில்)', why: 'ஏன் மாற்றப்படுகிறது (அனுமதிப்பவர் படிப்பார்)', ask: 'அனுமதி கேள்', save: 'மாற்று', from: 'முதல்', replaced: 'MRP மாற்றப்பட்டது' },
};
const mw = (key) => (MRP_REPLACE_WORDS[lang] ?? MRP_REPLACE_WORDS.en)[key];
let mrpReplaceProduct = null;
function renderMrpReplace(productId) {
  const future = typeof session.mrpsNotYetInForce === 'function' ? session.mrpsNotYetInForce(productId) : [];
  mrpReplaceProduct = future.length === 0 ? null : productId;
  el('mrp-replace').hidden = future.length === 0;
  el('mrp-replace-title').textContent = mw('title');
  el('mrp-replace-lead').textContent = mw('lead');
  el('mrp-replace-date-label').textContent = mw('date');
  el('mrp-replace-new-label').textContent = mw('newMrp');
  el('mrp-replace-why-label').textContent = mw('why');
  const withIcon = (id, icon, word) => {
    if (window.sreIcon && typeof window.sreIcon.withWord === 'function') el(id).replaceChildren(window.sreIcon.withWord(icon, word));
    else el(id).textContent = word;
  };
  withIcon('mrp-replace-ask', 'send', mw('ask'));
  withIcon('mrp-replace-save', 'refresh-cw', mw('save'));
  const chosen = el('mrp-replace-date').value;
  el('mrp-replace-date').replaceChildren(...future.map((m) => {
    const o = document.createElement('option');
    o.value = m.effectiveFrom;
    o.textContent = `${inr(m.mrpMinor)} ${mw('from')} ${m.effectiveFrom}`;
    return o;
  }));
  if (future.some((m) => m.effectiveFrom === chosen)) el('mrp-replace-date').value = chosen;
}
const mrpReplaceInput = () => ({
  productId: mrpReplaceProduct ?? '', effectiveFrom: el('mrp-replace-date').value,
  newMrpMinor: toMinor(el('mrp-replace-new').value), why: el('mrp-replace-why').value,
});
el('mrp-replace-ask').addEventListener('click', () => {
  void busy('mrp-replace-ask', async () => {
    if (mrpReplaceProduct === null) return;
    const outcome = await session.askMrpReplacement(lang, mrpReplaceInput());
    tellApproval(outcome.kind, session.presentAskOutcome(lang, 'mrp', outcome), 'mrp');
  });
});
el('mrp-replace-save').addEventListener('click', () => {
  void busy('mrp-replace-save', async () => {
    if (mrpReplaceProduct === null) return;
    const input = mrpReplaceInput();
    const outcome = await session.replaceMrpWithApproval(input);
    tellApproval(outcome.kind, session.presentUseOutcome(lang, 'mrp', outcome, inr(input.newMrpMinor)), 'mrp');
  });
});

/**
 * Check the price against the MRP and the margin floor (the model's own `proposePrice`, which writes nothing). Pressed,
 * it says what is missing; `quiet` — as the person types (OB-390) — it checks only once the item, the price and the day
 * are all there, says nothing otherwise, and leaves Save hidden until the model says the price may be saved. Either way
 * the check runs BEFORE Save can be pressed, exactly as before.
 */
function checkThePrice(quiet) {
  const sku = el('price-item').value.trim();
  const priceText = el('new-price').value.trim();
  const from = el('price-from').value.trim();
  const view = session.shelf().find((v) => v.product.sku === sku || v.product.productId === sku);
  if (quiet && (sku === '' || priceText === '' || from === '' || view === undefined || !(toMinor(priceText) > 0))) {
    lastProposal = null;
    el('price-verdict').hidden = true;
    el('save-price').hidden = true;
    el('price-approval').hidden = true;
    return;
  }
  if (sku === '') { tell(t('read'), t('needItem')); return; }
  if (priceText === '') { tell(t('read'), t('needPrice')); return; }
  if (from === '') { tell(t('read'), t('needDate')); return; }
  if (view === undefined) { tell(t('read'), t('unknownItem')); return; }

  lastProposal = session.proposePrice({
    id: `pc-${view.product.productId}-${from}-${toMinor(priceText)}`,
    productId: view.product.productId,
    priceMinor: toMinor(priceText),
    effectiveFrom: from,
  });
  renderProposal(lastProposal, view.product.productId);
}
el('check-price').addEventListener('click', () => { checkThePrice(false); });
// OB-390: the check runs as the price is typed, so Save is the next act — no separate "Check" press needed.
for (const id of ['new-price', 'price-from', 'price-item']) el(id).addEventListener('input', () => { checkThePrice(true); });

function renderProposal(proposal, productId) {
  const box = el('price-verdict');
  box.hidden = false;
  box.replaceChildren();
  box.className = 'verdict ' + (proposal.cleanToActivate ? 'ready' : proposal.needsApproval ? 'approval' : 'problem');

  const head = document.createElement('strong');
  head.textContent = proposal.cleanToActivate
    ? t('priceOk')
    : proposal.needsApproval ? t('needsApproval') : t('priceRefused');
  box.append(head);

  // The model's own refusal codes, in the shop's own words. Never a reworded second version.
  for (const refusal of proposal.refusals) {
    const why = document.createElement('span');
    why.className = 'why';
    why.textContent = words(PRICE_REFUSAL_WORDS, refusal);
    box.append(why);
  }

  if (proposal.replaces !== null) {
    const replacing = document.createElement('span');
    replacing.className = 'why';
    replacing.textContent = `${t('wasReplacing')} ${inr(proposal.replaces.price.minor)}`;
    box.append(replacing);
  }

  // The save button does not exist on the page until the model says the price may be saved.
  el('save-price').hidden = !(proposal.cleanToActivate || proposal.needsApproval);
  el('save-price').textContent = proposal.needsApproval ? t('saveWithApproval') : t('saveIt');
  // A price that needs a second person shows the ask: a reason the approver reads, and "Ask for approval".
  el('price-approval').hidden = !proposal.needsApproval;
  paintPriceApproval();
  renderHistory(productId);
}

/** The price an ask on this page was last made for — so "Save it" becomes the one main action after asking. */
let priceAskedFor = null;
const priceKey = (proposal) => `${proposal.draft.productId}|${proposal.draft.price.minor}`;

/** Which of "Ask for approval" and "Save it" is the main action: asking first, then saving once asked. */
function paintPriceApproval() {
  el('price-approval-lead').textContent = t('priceApprovalLead');
  el('price-why-label').textContent = t('whyLabel');
  el('price-why').placeholder = t('whyPlaceholder');
  el('ask-price').textContent = t('askForApproval');
  const needs = lastProposal !== null && lastProposal.needsApproval;
  const asked = needs && priceAskedFor === priceKey(lastProposal);
  el('ask-price').classList.toggle('primary', needs && !asked);
  el('save-price').classList.toggle('primary', !needs || asked);
}

// Ask for approval — the price setter's OWN request, in their own session, for exactly this change. Nothing is saved.
el('ask-price').addEventListener('click', () => {
  void busy('ask-price', async () => {
    if (lastProposal === null || !lastProposal.needsApproval) return;
    const proposal = lastProposal;
    const outcome = await session.askPriceApproval(lang, {
      productId: proposal.draft.productId, priceMinor: proposal.draft.price.minor, why: el('price-why').value,
    });
    if (outcome.kind === 'asked') { priceAskedFor = priceKey(proposal); el('price-why').value = ''; paintPriceApproval(); }
    tellApproval(outcome.kind, session.presentAskOutcome(lang, 'price', outcome), 'price');
  });
});

el('save-price').addEventListener('click', () => {
  void busy('save-price', async () => {
    if (lastProposal === null) return;
    const proposal = lastProposal;

    // A below-cost / below-floor price needs a second person's OWN approval (ADR-0024 · §28): "Save it" finds the
    // setter's own APPROVED request for exactly these figures and sends the change naming it. Not asked, waiting,
    // rejected, expired, used or changed — each is said plainly, and nothing is sent. With no head office behind
    // this page it says so, and nothing is saved: a name on this screen is not an approval.
    if (proposal.needsApproval) {
      const outcome = await session.savePriceWithApproval({
        productId: proposal.draft.productId, priceMinor: proposal.draft.price.minor,
      });
      tellApproval(outcome.kind, session.presentUseOutcome(lang, 'price', outcome, inr(proposal.draft.price.minor)), 'price');
      if (outcome.kind === 'done') {
        el('save-price').hidden = true;
        el('price-approval').hidden = true;
        priceAskedFor = null;
      }
      return;
    }

    // Wired to head office? Then the change goes THERE (M05-FR-02): the cloud re-runs the guard (MRP ceiling,
    // cost, margin floor), records the append-only change, and it is read back by the lane. The screen shows
    // what the cloud decided and changes nothing itself.
    if (session.canChangePriceInCloud) {
      const outcome = await session.changePriceInCloud({
        productId: proposal.draft.productId,
        priceMinor: proposal.draft.price.minor,
      });
      if (!outcome.saved) { tell(t('read'), outcome.reason); return; }
      tell(t('priceSaved'), `${inr(proposal.draft.price.minor)} — ${t('priceSavedNote')}`, true);
      el('save-price').hidden = true;
      return;
    }

    // No head office behind this page: the local activation is honest that it only validates in this browser,
    // and it is never handed an approval.
    const outcome = session.activatePrice(proposal);
    if (!outcome.ok) {
      tell(t('read'), outcome.refusals.map((r) => words(PRICE_REFUSAL_WORDS, r)).join(' '));
      return;
    }
    tell(t('priceSaved'), `${inr(outcome.entry.price.minor)} — ${t('priceSavedNote')}`, true);
    el('save-price').hidden = true;
    renderHistory(outcome.entry.productId);
  });
});

function renderHistory(productId) {
  el('history-title').textContent = t('historyTitle');
  const state = prices === null ? 'loaded' : prices.state(productId);
  if (state !== 'loaded' && state !== 'none') {
    // Not read from head office (yet, or it could not be): say so — never "this item has never had a price set".
    const note = document.createElement('p');
    note.className = 'empty';
    note.textContent = state === 'loading' || state === 'not_loaded' ? t('pricesReading') : (prices.why(productId) ?? t('pricesReading'));
    el('price-history').replaceChildren(note);
    return;
  }
  const entries = session.historyFor(productId);
  if (entries.length === 0) {
    const none = document.createElement('p');
    none.className = 'empty';
    none.textContent = t('noHistory');
    el('price-history').replaceChildren(none);
    return;
  }
  const table = document.createElement('table');
  const head = document.createElement('tr');
  for (const [text, cls] of [[t('from'), ''], [t('price'), 'amount'], [t('status'), ''], [t('version'), 'amount']]) {
    const th = document.createElement('th');
    th.textContent = text;
    if (cls) th.className = cls;
    head.append(th);
  }
  table.append(head);
  for (const entry of entries) {
    const row = document.createElement('tr');
    if (entry.status !== 'active') row.classList.add('blocked');
    for (const [text, cls] of [
      [entry.effectiveFrom, ''], [inr(entry.price.minor), 'amount'],
      [entry.status.replace(/_/g, ' '), ''], [String(entry.version), 'amount'],
    ]) {
      const td = document.createElement('td');
      td.textContent = text;
      if (cls) td.className = cls;
      row.append(td);
    }
    table.append(row);
  }
  el('price-history').replaceChildren(table);
}

// ── Where things sit (M04-FR-02) ────────────────────────────────────────────
//
// The reason this earns a tab: **shelf location sequences the picker's walk.** A picker filling an
// order without a route walks the shop the way the order was typed — dairy, then rice, then back to
// dairy. The roadmap's audit calls picking time the largest controllable cost in this business, and
// it is decided by whether a shelf address exists and sorts sensibly.
//
// So the walk preview is the point of the screen. Somebody addressing shelves has to SEE the order
// change rather than take it on trust.

function renderShelf() {
  el('shelf-title').textContent = t('shelves');
  el('shelf-lead').textContent = t('shelfLead');
  el('shelf-product-label').textContent = t('itemCode');
  el('shelf-location-label').textContent = t('shelf');
  el('shelf-capacity-label').textContent = t('fits');
  el('assign-shelf').textContent = t('putItHere');
  el('unmapped-title').textContent = t('unmappedTitle');
  el('unmapped-lead').textContent = t('unmappedLead');
  el('walk-title').textContent = t('walkTitle');

  const shelves = session.shelves();
  el('shelf-location').replaceChildren(...shelves.map((location) => {
    const option = document.createElement('option');
    option.value = location.locationId;
    // The sign on the aisle, plus the zone when it is not ambient — a picker reading "Chiller"
    // knows more than one reading "L-COLD".
    option.textContent = (location.label ?? location.locationId)
      + (location.zone === undefined || location.zone === 'ambient' ? '' : ` (${location.zone})`);
    return option;
  }));

  const walk = session.walk();
  el('walk-ordering').textContent = shelves.length === 0 ? t('noShelves') : walk.ordering;

  // Named, not counted. Each one is a walk back across the shop, and the person who can fix it is
  // exactly the person reading this.
  if (walk.unmapped.length === 0) {
    const none = document.createElement('p');
    none.className = 'empty';
    none.textContent = t('nothingUnmapped');
    el('unmapped-list').replaceChildren(none);
  } else {
    el('unmapped-list').replaceChildren(...walk.unmapped.map((productId) => {
      const step = walk.steps.find((s) => s.productId === productId);
      const row = document.createElement('div');
      row.className = 'row';
      const what = document.createElement('span');
      what.className = 'what';
      const name = document.createElement('strong');
      name.textContent = step?.name ?? productId;
      const sub = document.createElement('small');
      sub.textContent = `${productId} · ${t('noShelfAddress')}`;
      what.append(name, sub);
      row.append(what);
      return row;
    }));
  }

  el('walk-list').replaceChildren(...(walk.steps.length === 0 ? [] : [walkTable(walk.steps)]));
}

function walkTable(steps) {
  const table = document.createElement('table');
  const head = document.createElement('tr');
  for (const text of ['', t('item'), t('shelf')]) {
    const th = document.createElement('th');
    th.textContent = text;
    head.append(th);
  }
  table.append(head);
  steps.forEach((step, index) => {
    const row = document.createElement('tr');
    if (step.shelf === null) row.classList.add('blocked');
    for (const text of [String(index + 1), step.name, step.shelf ?? t('noShelfAddress')]) {
      const td = document.createElement('td');
      td.textContent = text;
      row.append(td);
    }
    table.append(row);
  });
  return table;
}

el('assign-shelf').addEventListener('click', () => {
  const sku = el('shelf-product').value.trim();
  const locationId = el('shelf-location').value;
  const capacity = Number(el('shelf-capacity').value);
  if (sku === '' || locationId === '' || !Number.isInteger(capacity) || capacity <= 0) {
    tell(t('read'), t('needShelfFields'));
    return;
  }
  const view = session.shelf().find((v) => v.product.sku === sku || v.product.productId === sku);
  if (view === undefined) { tell(t('read'), t('unknownItem')); return; }

  const outcome = session.assignShelf({
    productId: view.product.productId, locationId, capacityMinor: capacity,
  });
  if (!outcome.ok) { tell(t('read'), words(SHELF_REFUSAL_WORDS, outcome.refusal)); return; }
  el('shelf-product').value = '';
  el('shelf-capacity').value = '';
  renderShelf();
  tell(t('shelfSet'), `${view.product.name} · ${locationId}`, true);
});

// ── An offer ────────────────────────────────────────────────────────────────

let lastSimulation = null;
// The exact input the simulation was run on — the launch re-sends it so head office re-simulates from the
// numbers, never trusting a client-computed result.
let lastSimulationInput = null;

el('simulate').addEventListener('click', () => {
  const id = el('promo-id').value.trim();
  const normal = el('promo-normal').value.trim();
  const promo = el('promo-price').value.trim();
  const cost = el('promo-cost').value.trim();
  const baseline = Number(el('promo-baseline').value);
  const expected = Number(el('promo-expected').value);
  if (id === '' || normal === '' || promo === '' || cost === '' || !Number.isFinite(baseline) || !Number.isFinite(expected)) {
    tell(t('read'), t('needOfferFields'));
    return;
  }
  const funding = el('promo-funding').value.trim();

  lastSimulationInput = {
    promotionId: id,
    description: id,
    normalPrice: { minor: toMinor(normal), currency: 'INR' },
    promoPrice: { minor: toMinor(promo), currency: 'INR' },
    unitCost: { minor: toMinor(cost), currency: 'INR' },
    baselineUnits: baseline,
    expectedUnits: expected,
    ...(funding === '' ? {} : { vendorFundingPerUnit: { minor: toMinor(funding), currency: 'INR' } }),
  };
  lastSimulation = session.simulate(lastSimulationInput);
  renderSimulation(lastSimulation);
});

function renderSimulation(simulation) {
  const box = el('promo-verdict');
  box.hidden = false;
  box.replaceChildren();
  box.className = 'verdict ' + (simulation.blocksApproval ? 'problem' : 'ready');

  const head = document.createElement('strong');
  head.textContent = `${inr(simulation.incrementalMargin.minor)}`;
  const why = document.createElement('span');
  why.className = 'why';
  // The model's own sentence about the money. Rewording it here would put a second, untested
  // version of the same arithmetic on the screen.
  why.textContent = simulation.detail;
  const breakEven = document.createElement('span');
  breakEven.className = 'why';
  breakEven.textContent = `${t('extraNeeded')}: ${simulation.breakEvenUnits === 'unreachable' ? t('unreachable') : simulation.breakEvenUnits}`;

  box.append(head, why, breakEven);
  el('launch').hidden = false;
  el('launch').textContent = t('startOffer');
  // A margin-losing offer shows the ask: a reason the approver reads, and "Ask for approval".
  el('promo-approval').hidden = !simulation.blocksApproval;
  paintLaunchApproval();
}

/** The offer an ask on this page was last made for — so "Start this offer" becomes the main action after asking. */
let offerAskedFor = null;
const offerKey = (input) => JSON.stringify(input);

/** Which of "Ask for approval" and "Start this offer" is the main action: asking first, then starting once asked. */
function paintLaunchApproval() {
  el('promo-approval-lead').textContent = t('offerApprovalLead');
  el('promo-why-label').textContent = t('whyLabel');
  el('promo-why').placeholder = t('whyPlaceholder');
  el('ask-launch').textContent = t('askForApproval');
  const needs = lastSimulation !== null && lastSimulation.blocksApproval;
  const asked = needs && lastSimulationInput !== null && offerAskedFor === offerKey(lastSimulationInput);
  el('ask-launch').classList.toggle('primary', needs && !asked);
  el('launch').classList.toggle('primary', !needs || asked);
}

// Ask for approval — the proposer's OWN request, in their own session, for exactly this offer. Nothing starts.
el('ask-launch').addEventListener('click', () => {
  void busy('ask-launch', async () => {
    if (lastSimulation === null || lastSimulationInput === null || !lastSimulation.blocksApproval) return;
    const input = lastSimulationInput;
    const outcome = await session.askLaunchApproval(lang, { input, why: el('promo-why').value });
    if (outcome.kind === 'asked') { offerAskedFor = offerKey(input); el('promo-why').value = ''; paintLaunchApproval(); }
    tellApproval(outcome.kind, session.presentAskOutcome(lang, 'offer', outcome), 'offer');
  });
});

el('launch').addEventListener('click', () => {
  void busy('launch', async () => {
    if (lastSimulation === null || lastSimulationInput === null) return;
    const simulation = lastSimulation;
    const input = lastSimulationInput;

    // A margin-losing offer needs a second person's OWN approval (ADR-0024 · §28): "Start this offer" finds the
    // proposer's own APPROVED request for exactly this offer and launches naming it — otherwise it says why not,
    // and nothing is sent. With no head office behind this page it says so, and nothing starts.
    if (simulation.blocksApproval) {
      const outcome = await session.launchWithApproval(input);
      tellApproval(outcome.kind, session.presentUseOutcome(lang, 'offer', outcome, input.promotionId), 'offer');
      if (outcome.kind === 'done') {
        el('launch').hidden = true;
        el('promo-approval').hidden = true;
        offerAskedFor = null;
      }
      return;
    }

    // Wired to head office? Then the launch goes THERE (M05-FR-03/04): the cloud re-simulates the input, records
    // the launch, and it is read back by finance/reporting. The screen shows what the cloud decided and launches
    // nothing itself.
    if (session.canLaunchToCloud) {
      const outcome = await session.launchToCloud({ input });
      // Head office has no rule for this offer: say what to do on THIS page, rather than its route name.
      if (!outcome.launched) { tell(t('read'), outcome.code === 'promotion_not_defined' ? t('notDefinedYet') : outcome.reason); return; }
      tell(t('offerStarted'), input.promotionId, true);
      el('launch').hidden = true;
      return;
    }

    // No head office behind this page: the local launch is honest that it only validates in this browser, and it
    // is never handed an approval.
    const outcome = session.launch(simulation);
    if (!outcome.ok) { tell(t('read'), outcome.detail); return; }
    tell(t('offerStarted'), simulation.promotionId, true);
    el('launch').hidden = true;
  });
});

// ── The offer's rule (M05-FR-03/04 · re-audit 30 Oct 2026) ─────────────────
//
// Head office refuses to start an offer it has no rule for. This step sends the rule — kind, products or group, the shop's
// days, coupon, members only, the exclusive group it competes in, the abuse cap — through the tested session to head
// office's own definition route; head office keeps it as a DRAFT that applies to nothing until "Start this offer". Its
// answer is said as given; no answer claims nothing.

const RULE_FIELDS = [
  ['rule-kind-label', 'ruleKind'], ['rule-products-label', 'ruleProducts'], ['rule-group-label', 'ruleGroup'],
  ['rule-starts-label', 'ruleStarts'], ['rule-ends-label', 'ruleEnds'], ['rule-percent-label', 'rulePercent'],
  ['rule-amount-label', 'ruleAmount'], ['rule-buy-label', 'ruleBuy'], ['rule-get-label', 'ruleGet'],
  ['rule-member-price-label', 'ruleMemberPrice'], ['rule-multi-qty-label', 'ruleMultiQty'], ['rule-multi-price-label', 'ruleMultiPrice'],
  ['rule-bundle-items-label', 'ruleBundleItems'], ['rule-bundle-price-label', 'ruleBundlePrice'],
  ['rule-buy-products-label', 'ruleBuyProducts'], ['rule-buy-group-label', 'ruleBuyGroup'],
  ['rule-get-products-label', 'ruleGetProducts'], ['rule-get-group-label', 'ruleGetGroup'],
  ['rule-min-spend-label', 'ruleMinSpend'], ['rule-coupon-label', 'ruleCoupon'], ['rule-member-only-label', 'ruleMemberOnly'],
  ['rule-exclusive-label', 'ruleExclusive'], ['rule-cap-label', 'ruleCap'], ['define-offer', 'defineOffer'],
  ['rule-title', 'ruleTitle'], ['rule-lead', 'ruleLead'],
];

function renderRule() {
  for (const [id, key] of RULE_FIELDS) el(id).textContent = t(key);
  const select = el('rule-kind');
  const was = select.value;
  select.replaceChildren(...Object.keys(OFFER_KIND_WORDS).map((kind) => {
    const option = document.createElement('option');
    option.value = kind;
    option.textContent = words(OFFER_KIND_WORDS, kind);
    return option;
  }));
  if (was !== '') select.value = was;
  showRuleFields();
}

/** Only the boxes the chosen kind reads are shown — a figure in another kind's box is never sent either. */
function showRuleFields() {
  const kind = el('rule-kind').value;
  for (const field of document.querySelectorAll('#promo-rule [data-kinds]')) {
    field.hidden = !field.dataset.kinds.split(' ').includes(kind);
  }
}
el('rule-kind').addEventListener('change', showRuleFields);

function ruleSay(text, ok) { el('define-status').textContent = text; el('define-status').dataset.ok = ok ? 'yes' : 'no'; }

el('define-offer').addEventListener('click', () => busy('define-offer', async () => {
  const value = (id) => el(id).value;
  const outcome = await session.defineOffer({
    promotionId: value('promo-id'), kind: value('rule-kind'), startsOn: value('rule-starts'), endsOn: value('rule-ends'),
    productIds: value('rule-products'), group: value('rule-group'), percent: value('rule-percent'), amountOff: value('rule-amount'),
    buyQty: value('rule-buy'), getQty: value('rule-get'), memberPrice: value('rule-member-price'),
    multibuyQty: value('rule-multi-qty'), multibuyPrice: value('rule-multi-price'),
    bundleItems: value('rule-bundle-items'), bundlePrice: value('rule-bundle-price'),
    buyProductIds: value('rule-buy-products'), buyGroup: value('rule-buy-group'),
    getProductIds: value('rule-get-products'), getGroup: value('rule-get-group'),
    minSpend: value('rule-min-spend'), coupon: value('rule-coupon'), memberOnly: el('rule-member-only').checked,
    exclusiveGroup: value('rule-exclusive'), maxApplications: value('rule-cap'),
  });
  if (outcome.kind === 'defined') ruleSay(`${t('ruleRecorded')} ${outcome.promotionId} · ${value('rule-starts')} – ${value('rule-ends')}`, true);
  else if (outcome.kind === 'invalid') ruleSay(words(OFFER_PROBLEM_WORDS, outcome.problem), false);
  else if (outcome.kind === 'refused') ruleSay(`${t('ruleRefused')} ${outcome.whatHappened === '' ? outcome.code : outcome.whatHappened}`, false);
  else if (outcome.kind === 'lost_link') ruleSay(t('ruleUnreachable'), false);
  else ruleSay(t('ruleNotConnected'), false);
}));

// ── Competitor prices (D06-FR-05) ───────────────────────────────────────────
//
// A thin panel over head office's own routes, through the tested model (`competitor-price-session.ts`, attached as
// `window.competitorPriceSession` / `competitorPriceKit`). It records a sighting and shows the comparison head office
// works out — our effective price at this store beside each competitor's latest sighting. It changes no price.

const rivals = window.competitorPriceSession ?? null;
const rivalKit = window.competitorPriceKit ?? null;
const rw = (key, fill) => (rivalKit === null ? key : rivalKit.competitorWords(lang)(key, fill));
let rivalsRead = null;

function rivalSay(id, text, ok) { el(id).textContent = text; el(id).dataset.ok = ok ? 'yes' : 'no'; }

function renderRivals() {
  // A sample view (no head office behind it) keeps the page's own words and offers nothing.
  if (rivalKit === null) { el('rivals-form').hidden = true; return; }
  el('rivals-title').textContent = rw('h');
  el('rivals-lead').textContent = rw('lede');
  el('rivals-note').textContent = rw('changesNoPrice');
  for (const [id, k] of [['rival-product-label', 'product'], ['rival-competitor-label', 'competitor'], ['rival-price-label', 'price'], ['rival-source-label', 'source'], ['rival-seen-label', 'seenAt'], ['rival-note-label', 'note'], ['rival-record', 'record']]) el(id).textContent = rw(k);
  const form = el('rivals-form');
  form.hidden = rivals === null || !rivals.may.record;
  if (rivals === null) { rivalSay('rivals-status', rw('notConnected'), false); el('rivals-list').replaceChildren(); return; }
  if (rivals !== null) {
    const productSelect = el('rival-product');
    const was = productSelect.value;
    productSelect.replaceChildren(...rivals.products.map((p) => { const o = document.createElement('option'); o.value = p.productId; o.textContent = `${p.name} (${p.productId})`; return o; }));
    if ([...productSelect.options].some((o) => o.value === was)) productSelect.value = was;
    const sourceSelect = el('rival-source');
    const src = sourceSelect.value;
    sourceSelect.replaceChildren(...rivalKit.sources.map((s) => { const o = document.createElement('option'); o.value = s; o.textContent = rw(s); return o; }));
    if (src !== '') sourceSelect.value = src;
  }
  const list = el('rivals-list');
  list.replaceChildren();
  if (rivals === null) return;
  if (!rivals.may.read) { rivalSay('rivals-status', rw('cannotRead'), false); return; }
  if (!rivals.may.record) rivalSay('rivals-status', rw('readOnly'), true);
  if (rivalsRead === null) return;
  if (rivalsRead.kind !== 'done') {
    const said = rivalKit.competitorOutcomeWords(lang, rivalsRead);
    rivalSay('rivals-status', rivalsRead.kind === 'invalid' ? rw('noStore') : said.text, false);
    return;
  }
  const c = rivalsRead.body;
  if (c.products.length === 0) { const p = document.createElement('p'); p.className = 'lead'; p.textContent = rw('none'); list.append(p); return; }
  for (const row of c.products) {
    const box = document.createElement('div');
    box.className = 'row';
    box.dataset.product = row.productId;
    const what = document.createElement('div');
    what.className = 'what';
    const name = document.createElement('strong');
    name.textContent = `${rivals.nameOf(row.productId)} — ${rw('ours')} ${row.ourPriceMinor === null ? rw('ourNotKnown') : rivalKit.rupees(row.ourPriceMinor)}`;
    what.append(name);
    for (const k of row.competitors) {
      const line = document.createElement('small');
      line.dataset.competitor = k.competitor;
      line.textContent = `${k.competitor}: ${rivalKit.rupees(k.priceMinor)} · ${rivalKit.gapWords(lang, k.gapMinor)} · ${rw(k.source)} · ${k.ageDays === 0 ? rw('today') : rw('daysOld', { n: k.ageDays })}${k.note ? ` · ${k.note}` : ''}`;
      what.append(line);
    }
    box.append(what);
    list.append(box);
  }
}

// ── R4 Lane 4 · D-18 (OB-216) — begin: drafted price changes a person approves ─────────────────────────────────
let draftsRead = null;
function renderDrafts() {
  const block = el('drafts-block');
  block.hidden = rivals === null || rivalKit === null || !rivals.may.record || draftsRead === null || draftsRead.kind !== 'done';
  if (block.hidden) return;
  const d = draftsRead.body;
  el('drafts-title').textContent = rw('draftsH');
  el('drafts-lead').textContent = rw('draftsLede');
  el('drafts-rule').textContent = `${rw('ruleLine', { gap: (d.rule.gapBps / 100).toFixed(1), age: d.rule.maxAgeDays })} ${d.rule.source === 'owner_setting' ? rw('ruleOwner') : rw('ruleDefault')}`;
  el('not-drafted-title').textContent = rw('notDraftedH');
  const list = el('drafts-list');
  list.replaceChildren();
  if (d.drafts.length === 0) { const p = document.createElement('p'); p.className = 'lead'; p.textContent = rw('noDrafts'); list.append(p); }
  for (const draft of d.drafts) {
    const box = document.createElement('div');
    box.className = 'row';
    box.dataset.draft = draft.productId;
    const what = document.createElement('div');
    what.className = 'what';
    const line = document.createElement('strong');
    line.textContent = rw('draftLine', { name: rivals.nameOf(draft.productId), from: rivalKit.rupees(draft.fromPriceMinor), to: rivalKit.rupees(draft.draftPriceMinor), who: draft.competitor, gap: (draft.gapBps / 100).toFixed(1), age: draft.ageDays })
      + (draft.cappedAtMrp ? ` · ${rw('cappedAtMrp')}` : '');
    what.append(line);
    const approve = document.createElement('button');
    approve.type = 'button';
    approve.className = 'primary';
    approve.dataset.approve = draft.productId;
    approve.textContent = rw('approveDraft');
    approve.addEventListener('click', async () => {
      approve.disabled = true;
      const out = await rivals.approveDraft(draft);
      if (out.kind === 'done') rivalSay('drafts-status', rw('draftApproved'), true);
      else rivalSay('drafts-status', rivalKit.competitorOutcomeWords(lang, out).text, false);
      await loadRivals();
    });
    box.append(what, approve);
    list.append(box);
  }
  el('not-drafted-list').replaceChildren(...d.notDrafted.map((n) => {
    const p = document.createElement('p');
    p.className = 'lead';
    p.dataset.notDrafted = n.productId;
    p.dataset.reason = n.reason;
    p.textContent = `${rivals.nameOf(n.productId)}: ${n.words}${n.competitor === undefined ? '' : ` (${n.competitor})`}`;
    return p;
  }));
}
// ── R4 Lane 4 · D-18 — end

async function loadRivals() {
  if (rivals === null || !rivals.may.read) { renderRivals(); return; }
  rivalsRead = await rivals.compare();
  renderRivals();
  // R4 D-18: the drafts are read only by someone who may propose a price (a read; it changes nothing).
  if (rivals.may.record) { draftsRead = await rivals.drafts(); renderDrafts(); }
}

el('rival-record').addEventListener('click', () => busy('rival-record', async () => {
  const out = await rivals.record({
    productId: el('rival-product').value, competitor: el('rival-competitor').value, price: el('rival-price').value,
    source: el('rival-source').value, observedAt: el('rival-seen').value, note: el('rival-note').value,
  });
  const said = rivalKit.competitorOutcomeWords(lang, out);
  rivalSay('rival-record-status', said.text, said.ok);
  if (said.ok) { el('rival-price').value = ''; el('rival-note').value = ''; }
  await loadRivals();
}));

// ── Language ────────────────────────────────────────────────────────────────

function paintChrome() {
  el('who').firstChild.textContent = `${t('title')} `;
  el('whoami').textContent = me();
  el('tab-items').textContent = t('items');
  el('tab-price').textContent = t('changePrice');
  el('tab-shelf').textContent = t('shelves');
  el('tab-promo').textContent = t('offer');
  if (rivalKit !== null) el('tab-rivals').textContent = rw('tab');
  el('items-title').textContent = t('items');
  el('items-lead').textContent = t('itemsLead');
  el('item-search-label').textContent = t('findItem');
  el('price-title').textContent = t('changePrice');
  el('price-lead').textContent = t('priceLead');
  el('price-item-label').textContent = t('itemCode');
  el('new-price-label').textContent = t('newPrice');
  el('price-from-label').textContent = t('startsOn');
  el('check-price').textContent = t('checkPrice');
  el('promo-title').textContent = t('offer');
  el('promo-lead').textContent = t('offerLead');
  el('promo-id-label').textContent = t('offerName');
  el('promo-normal-label').textContent = t('normalPrice');
  el('promo-price-label').textContent = t('offerPrice');
  el('promo-cost-label').textContent = t('costsUs');
  el('promo-funding-label').textContent = t('supplierPays');
  el('promo-baseline-label').textContent = t('unitsNow');
  el('promo-expected-label').textContent = t('unitsExpected');
  el('simulate').textContent = t('workItOut');
  renderRule();
  el('sample').textContent = t('sampleData');
  renderGaps();
  renderLimits();
  renderShelf();
}

el('item-search').addEventListener('input', renderItems);

el('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  paintChrome();
  renderItems();
  renderItem();
  if (lastProposal !== null) renderProposal(lastProposal, lastProposal.draft.productId);
  if (lastSimulation !== null) renderSimulation(lastSimulation);
  renderRivals();
  renderDrafts(); // R4 D-18
  if (!el('view-price').hidden) renderLimits(); // OB-512: the replace-an-MRP panel speaks the chosen language
});

// ── Boot ────────────────────────────────────────────────────────────────────

el('sample').hidden = real !== undefined;
el('price-from').value = today();
el('rule-starts').value = today();
el('rule-ends').value = today();
paintChrome();
renderItems();
// Open the tab the menu asked for. The "Pricing" and "Promotions" menu items redirect here with
// ?tab=price / ?tab=promo (screen-server SCREEN_ALIASES); anything else opens on the item list.
const wantedTab = new URLSearchParams(window.location.search).get('tab');
show(TABS.includes(wantedTab) ? wantedTab : 'items');
renderRivals();
if (wantedTab === 'rivals') void loadRivals();

// ── The shell's own honesty about where this page came from ─────────────────
//

// The shell existed and nothing ever registered it, so nothing was ever cached and every one of
// these screens fell back to its sample data the moment the box was unreachable.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
