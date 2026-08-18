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
// No `prompt`, `confirm` or `alert`; the banner does not fade.

const el = (id) => document.getElementById(id);

const inr = (minor) =>
  '₹' + (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Rupees typed by a person into exact minor units. Never a float in the model. */
const toMinor = (text) => Math.round(Number(String(text).replace(/[^0-9.-]/g, '')) * 100);

// ── Words ───────────────────────────────────────────────────────────────────

const WORDS = {
  en: {
    staleShell: 'No connection to the store computer. This page is what it was last told, at',
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
    whatYouCanDo: 'What you can do', putOnSale: 'Put this on sale',
    stopSelling: 'Stop selling this everywhere', allowSelling: 'Allow selling this again',
    recallNote: 'A recall block stops the till and the app at once, and keeps working with no internet.',
    backToList: 'Back to the list',
    priceLead: 'The two limits below are checked before anything is saved. A price over the MRP cannot be saved by anybody.',
    itemCode: 'Item code', mrpPrinted: 'MRP printed on the pack',
    lowestPrice: 'Lowest price that keeps the margin', newPrice: 'New price (in rupees)',
    startsOn: 'Starts on', checkPrice: 'Check this price', sendForApproval: 'Send for approval and save',
    saveIt: 'Save this price', priceOk: 'This price is fine', needsApproval: 'Somebody else has to approve this',
    priceRefused: 'This price cannot be saved', historyTitle: 'What this item has been priced at',
    noHistory: 'This item has never had a price set.', wasReplacing: 'Replaces',
    from: 'From', price: 'Price', status: 'State', version: 'Change',
    offerLead: 'See what an offer does to the margin before it starts.',
    offerName: 'Give this offer a name', normalPrice: 'Normal price (in rupees)',
    offerPrice: 'Offer price (in rupees)', costsUs: 'What it costs us (in rupees)',
    supplierPays: 'Supplier pays per unit (in rupees)', unitsNow: 'Units you sell now',
    unitsExpected: 'Units you expect with the offer', workItOut: 'Work out what it costs',
    startOffer: 'Start this offer', offerStarted: 'Offer started',
    extraNeeded: 'Extra units needed just to break even', unreachable: 'no volume makes this pay',
    ok: 'OK', cancel: 'Cancel', read: 'Please read this', why: 'Why',
    whoApproves: 'Who approved this?',
    whoApprovesNote: 'You cannot approve your own change. Somebody else has to look at it.',
    needItem: 'Give the item code first.', needPrice: 'Type the new price first.',
    needDate: 'Say what day this price starts.', needOfferFields: 'Fill in every figure first.',
    unknownItem: 'This screen has not been told about that item.',
    priceSaved: 'Price saved', priceSavedNote: 'It starts on the day you gave.',
    published: 'This item is on sale', recallSet: 'Selling stopped', recallLifted: 'Selling allowed again',
    sampleData: 'Sample data — this is not your shop.',
    gapsTitle: 'This screen has not been told everything',
    noApprovers: 'This screen has not been told who may approve. Nothing needing approval can be saved.',
    reasonNeeded: 'Write why, in a sentence somebody can read next year.',
  },
  ta: {
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:',
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
    whatYouCanDo: 'நீங்கள் என்ன செய்யலாம்', putOnSale: 'இதை விற்பனைக்கு வை',
    stopSelling: 'இதை எல்லா இடத்திலும் விற்பதை நிறுத்து', allowSelling: 'மீண்டும் விற்க அனுமதி',
    recallNote: 'ரீகால் தடை பில்லிங் இயந்திரத்தையும் செயலியையும் உடனே நிறுத்தும். இணையம் இல்லாமலும் வேலை செய்யும்.',
    backToList: 'பட்டியலுக்குத் திரும்பு',
    priceLead: 'கீழே உள்ள இரு வரம்புகளும் சேமிக்கும் முன் சரிபார்க்கப்படும். MRP-ஐ விட அதிக விலையை யாராலும் சேமிக்க முடியாது.',
    itemCode: 'பொருள் குறியீடு', mrpPrinted: 'பாக்கெட்டில் அச்சிடப்பட்ட MRP',
    lowestPrice: 'லாபத்தைக் காக்கும் குறைந்தபட்ச விலை', newPrice: 'புதிய விலை (ரூபாயில்)',
    startsOn: 'தொடங்கும் நாள்', checkPrice: 'இந்த விலையைச் சரிபார்', sendForApproval: 'ஒப்புதலுக்கு அனுப்பி சேமி',
    saveIt: 'இந்த விலையைச் சேமி', priceOk: 'இந்த விலை சரியானது', needsApproval: 'வேறு ஒருவர் இதை ஒப்புதல் அளிக்க வேண்டும்',
    priceRefused: 'இந்த விலையைச் சேமிக்க முடியாது', historyTitle: 'இந்தப் பொருளுக்கு இருந்த விலைகள்',
    noHistory: 'இந்தப் பொருளுக்கு இதுவரை விலை நிர்ணயிக்கப்படவில்லை.', wasReplacing: 'மாற்றுவது',
    from: 'முதல்', price: 'விலை', status: 'நிலை', version: 'மாற்றம்',
    offerLead: 'சலுகை தொடங்கும் முன் லாபத்தில் என்ன விளைவு என்று பாருங்கள்.',
    offerName: 'இந்தச் சலுகைக்கு ஒரு பெயர் கொடுங்கள்', normalPrice: 'சாதாரண விலை (ரூபாயில்)',
    offerPrice: 'சலுகை விலை (ரூபாயில்)', costsUs: 'நமக்கு ஆகும் செலவு (ரூபாயில்)',
    supplierPays: 'சப்ளையர் தரும் தொகை (ரூபாயில்)', unitsNow: 'இப்போது விற்கும் அளவு',
    unitsExpected: 'சலுகையுடன் எதிர்பார்க்கும் அளவு', workItOut: 'என்ன செலவாகும் என்று கணக்கிடு',
    startOffer: 'இந்தச் சலுகையைத் தொடங்கு', offerStarted: 'சலுகை தொடங்கியது',
    extraNeeded: 'நஷ்டமில்லாமல் இருக்க கூடுதலாகத் தேவையான அளவு', unreachable: 'எந்த அளவு விற்றாலும் ஈடுசெய்யாது',
    ok: 'சரி', cancel: 'ரத்து', read: 'இதைப் படிக்கவும்', why: 'ஏன்',
    whoApproves: 'இதை யார் ஒப்புதல் அளித்தார்?',
    whoApprovesNote: 'உங்கள் சொந்த மாற்றத்தை நீங்களே ஒப்புதல் அளிக்க முடியாது. வேறு ஒருவர் பார்க்க வேண்டும்.',
    needItem: 'முதலில் பொருள் குறியீட்டைக் கொடுக்கவும்.', needPrice: 'முதலில் புதிய விலையைத் தட்டச்சு செய்யவும்.',
    needDate: 'இந்த விலை எந்த நாளில் தொடங்கும் என்று சொல்லுங்கள்.', needOfferFields: 'முதலில் எல்லா எண்களையும் நிரப்பவும்.',
    unknownItem: 'அந்தப் பொருளைப் பற்றி இந்தத் திரைக்குத் தெரியவில்லை.',
    priceSaved: 'விலை சேமிக்கப்பட்டது', priceSavedNote: 'நீங்கள் கொடுத்த நாளில் தொடங்கும்.',
    published: 'இந்தப் பொருள் விற்பனையில் உள்ளது', recallSet: 'விற்பனை நிறுத்தப்பட்டது', recallLifted: 'விற்பனை மீண்டும் அனுமதிக்கப்பட்டது',
    sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
    gapsTitle: 'இந்தத் திரைக்கு எல்லாத் தகவலும் வரவில்லை',
    noApprovers: 'யார் ஒப்புதல் அளிக்கலாம் என்று இந்தத் திரைக்குத் தெரியவில்லை. ஒப்புதல் தேவைப்படுவது எதுவும் சேமிக்க முடியாது.',
    reasonNeeded: 'ஏன் என்பதை ஒரு வாக்கியத்தில் எழுதுங்கள் — அடுத்த ஆண்டு படிக்கக்கூடியதாக.',
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
  who_may_approve: {
    en: 'It has not been told who may approve, so nothing needing approval can be saved.',
    ta: 'யார் ஒப்புதல் அளிக்கலாம் என்று தெரியவில்லை. எனவே ஒப்புதல் தேவைப்படுவது எதுவும் சேமிக்க முடியாது.',
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
    rollBack: (e) => e,
    historyFor: () => [],
    simulate: () => ({ promotionId: 'sample', verdict: 'improves_margin', promoUnitMargin: { minor: 0, currency: 'INR' }, baselineUnitMargin: { minor: 0, currency: 'INR' }, baselineTotalMargin: { minor: 0, currency: 'INR' }, promoTotalMargin: { minor: 0, currency: 'INR' }, incrementalMargin: { minor: 0, currency: 'INR' }, breakEvenUnits: 0, blocksApproval: false, detail: 'this is sample data' }),
    launch: () => ({ ok: false, detail: 'this is sample data' }),
    quote: () => ({ grossTotal: { minor: 0, currency: 'INR' }, discount: { minor: 0, currency: 'INR' }, netTotal: { minor: 0, currency: 'INR' }, applied: [] }),
  };
}

const real = window.catalogueSession;
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

// ── The panel ───────────────────────────────────────────────────────────────

let sheetResolve = null;

/**
 * Ask who approved something, and optionally why. On screen, never a browser prompt.
 *
 * An empty list is answered before the panel opens: a panel offering no names and only a Cancel
 * button is a dead end that reads as a bug, when what is actually wrong is that nobody has told
 * this screen who may approve.
 */
function askApprover(title, note, people, wantReason = false) {
  if (people.length === 0) {
    tell(t('read'), t('noApprovers'));
    return Promise.resolve(null);
  }
  el('sheet-title').textContent = title;
  el('sheet-note').textContent = note;
  el('sheet-cancel').textContent = t('cancel');
  el('sheet-reason-wrap').hidden = !wantReason;
  el('sheet-reason-label').textContent = t('why');
  el('sheet-reason').value = '';
  el('choices').replaceChildren(...people.map((who) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = who;
    button.addEventListener('click', () => {
      const reason = el('sheet-reason').value.trim();
      // A written reason is the only thing that tells a deliberate margin loss from a mistake, a
      // year later when nobody remembers either.
      if (wantReason && reason.length < 10) { tell(t('read'), t('reasonNeeded')); return; }
      closeSheet({ who, reason });
    });
    return button;
  }));
  el('sheet').hidden = false;
  return new Promise((resolve) => { sheetResolve = resolve; });
}
function closeSheet(answer) {
  el('sheet').hidden = true;
  const resolve = sheetResolve;
  sheetResolve = null;
  if (resolve) resolve(answer);
}
el('sheet-cancel').addEventListener('click', () => { closeSheet(null); });

/** Who may approve. From the box, never invented here. */
const approvers = () => window.catalogueData?.approvers ?? [];
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

const VIEWS = ['items', 'item', 'price', 'shelf', 'promo'];
const TABS = ['items', 'price', 'shelf', 'promo'];

function show(name) {
  for (const view of VIEWS) el(`view-${view}`).hidden = view !== name;
  for (const tab of TABS) {
    el(`tab-${tab}`).setAttribute('aria-current', tab === name ? 'page' : 'false');
  }
}
for (const name of TABS) {
  el(`tab-${name}`).addEventListener('click', () => { show(name); });
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
    + ` · ${view.priceToday === null ? t('noPrice') : inr(view.priceToday.price.minor)}`;
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

  row.append(what, pct, open);
  return row;
}

// ── One item ────────────────────────────────────────────────────────────────

function openItem(product) {
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
      field.textContent = `${check.label}: `;
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

  const mrp = (view.product.mrpHistory ?? [])
    .filter((m) => m.effectiveFrom <= today())
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
    .at(-1);
  el('mrp-value').textContent = mrp === undefined ? '—' : inr(mrp.value.minor);

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

el('check-price').addEventListener('click', () => {
  const sku = el('price-item').value.trim();
  const priceText = el('new-price').value.trim();
  const from = el('price-from').value.trim();
  if (sku === '') { tell(t('read'), t('needItem')); return; }
  if (priceText === '') { tell(t('read'), t('needPrice')); return; }
  if (from === '') { tell(t('read'), t('needDate')); return; }

  const view = session.shelf().find((v) => v.product.sku === sku || v.product.productId === sku);
  if (view === undefined) { tell(t('read'), t('unknownItem')); return; }

  lastProposal = session.proposePrice({
    id: `pc-${view.product.productId}-${from}-${toMinor(priceText)}`,
    productId: view.product.productId,
    priceMinor: toMinor(priceText),
    effectiveFrom: from,
  });
  renderProposal(lastProposal, view.product.productId);
});

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
  el('save-price').textContent = proposal.needsApproval ? t('sendForApproval') : t('saveIt');
  renderHistory(productId);
}

el('save-price').addEventListener('click', async () => {
  if (lastProposal === null) return;

  let approval;
  if (lastProposal.needsApproval) {
    // Separation of duties is asked for on screen and enforced in the model — the person setting
    // the price is not in this list, and a name picked here is checked against the setter anyway.
    const answer = await askApprover(t('whoApproves'), t('whoApprovesNote'), approvers().filter((a) => a !== me()), true);
    if (answer === null) return;
    approval = {
      id: `ap-${lastProposal.draft.id}`, subjectType: 'price_change', subjectRef: lastProposal.draft.id,
      requestedBy: me(), branchId: null, value: null,
      status: 'approved', decidedBy: answer.who, reason: answer.reason,
      decidedAt: new Date().toISOString(),
    };
  }

  const outcome = session.activatePrice(lastProposal, approval);
  if (!outcome.ok) {
    tell(t('read'), outcome.refusals.map((r) => words(PRICE_REFUSAL_WORDS, r)).join(' '));
    return;
  }
  tell(t('priceSaved'), `${inr(outcome.entry.price.minor)} — ${t('priceSavedNote')}`, true);
  el('save-price').hidden = true;
  renderHistory(outcome.entry.productId);
});

function renderHistory(productId) {
  el('history-title').textContent = t('historyTitle');
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

  lastSimulation = session.simulate({
    promotionId: id,
    description: id,
    normalPrice: { minor: toMinor(normal), currency: 'INR' },
    promoPrice: { minor: toMinor(promo), currency: 'INR' },
    unitCost: { minor: toMinor(cost), currency: 'INR' },
    baselineUnits: baseline,
    expectedUnits: expected,
    ...(funding === '' ? {} : { vendorFundingPerUnit: { minor: toMinor(funding), currency: 'INR' } }),
  });
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
}

el('launch').addEventListener('click', async () => {
  if (lastSimulation === null) return;

  let approval;
  if (lastSimulation.blocksApproval) {
    const answer = await askApprover(t('whoApproves'), t('whoApprovesNote'), approvers().filter((a) => a !== me()), true);
    if (answer === null) return;
    approval = {
      subjectRef: lastSimulation.promotionId, status: 'approved',
      decidedBy: answer.who, rationale: answer.reason,
    };
  }

  const outcome = session.launch(lastSimulation, approval);
  if (!outcome.ok) { tell(t('read'), outcome.detail); return; }
  tell(t('offerStarted'), lastSimulation.promotionId, true);
  el('launch').hidden = true;
});

// ── Language ────────────────────────────────────────────────────────────────

function paintChrome() {
  el('who').firstChild.textContent = `${t('title')} `;
  el('whoami').textContent = me();
  el('tab-items').textContent = t('items');
  el('tab-price').textContent = t('changePrice');
  el('tab-shelf').textContent = t('shelves');
  el('tab-promo').textContent = t('offer');
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
});

// ── Boot ────────────────────────────────────────────────────────────────────

el('sample').hidden = real !== undefined;
el('price-from').value = today();
paintChrome();
renderItems();
show('items');

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
