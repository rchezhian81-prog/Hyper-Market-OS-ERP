// Shelves and space — the view layer. Every rule lives in the TESTED session model
// (`apps/web-erp/src/merchandising-session.ts`), attached as `window.merchandisingSession`.
//
// ── The one decision this screen is built around ────────────────────────────
//
// **How much of the plan anybody actually looked at is shown ABOVE the compliance figure.** A
// percentage over a shop nobody has counted is a number somebody would put on a wall, and it would
// mean nothing — which is exactly what happened before the count existed: an uncounted facing read
// as an empty one, and the whole shop came back as an urgent refill list on day one.
//
// So the coverage line leads, the figure follows, and when the plan is only part-counted the screen
// says so in the same breath rather than in a footnote.
//
// ── Counted blind ───────────────────────────────────────────────────────────
//
// The counting field shows **nothing** about what the facing is supposed to hold. Same discipline
// as the till drawer and the stock count: a number on the screen is an answer, and a tired person
// at the end of a shift agrees with it. The session model has no method that would return one, so
// there is nothing here to render even by accident.
//
// ── Since SP-8c-ii the two saves leave the page ─────────────────────────────
//
// A count is written to the DURABLE device queue through the session before this screen says "saved"
// — the SAME queue the Floor indents screen uses — and listed under "Saved on this screen" with the
// five shared state words until the store computer says head office has it. The refill tasks become
// ONE indent on that queue through `session.raiseRefill()`, the same record the floor would raise by
// hand; the same shelves asked once a day. The relay (window.merchandisingRelay) hands the queue to
// the store computer after every save and when the page comes back — never on a timer.
//
// No `prompt`, `confirm` or `alert`; the banner does not fade.

const el = (id) => document.getElementById(id);

const inr = (minor) =>
  '₹' + (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── Words ───────────────────────────────────────────────────────────────────

const WORDS = {
  en: {
    title: 'Shelves and space',
    countTab: 'Count a shelf', refillTab: 'Refills', rangeTab: 'Range', spaceTab: 'Space',
    countLead: 'Count what is actually on the facing. You will not be shown what it should be — that is the point.',
    shelf: 'Shelf', itemCode: 'Item code', howMany: 'How many are on the shelf',
    saveCount: 'Save this count', countSaved: 'Count saved',
    stillToCount: 'Still to count',
    stillToCountLead: 'The ones nobody has ever counted come first — nothing can be said about those at all.',
    neverCounted: 'never counted', minutesAgo: 'minutes ago', allCounted: 'Everything on the plan has been counted recently.',
    refillLead: 'Shelves that need filling from the stockroom, in the order you walk them.',
    goFill: 'Go and fill these', everythingFound: 'Everything the check found',
    nothingToFill: 'Nothing needs filling from what has been counted.',
    coverageWhole: 'Every facing on the plan was counted',
    coveragePartial: 'Only part of the plan has been counted',
    coverageNone: 'Nothing on the plan has been counted yet',
    ofPlan: 'of the plan counted', shelvesFull: 'of the counted shelves are properly filled',
    meansLittle: 'This figure covers only what was counted. It says nothing about the rest of the shop.',
    bring: 'Bring', noCheck: 'The shelves cannot be checked',
    rangeLead: 'What this shop carries. Dropping something you still have stock of puts it on clearance rather than hiding it.',
    why: 'Why', replacedBy: 'Replaced by (item code)', dropIt: 'Take it out of the range',
    rangeDisagree: 'Where the range and the shop disagree', carriedToday: 'Carried today',
    nothingCarried: 'This screen has not been told what the shop carries.',
    rangeClean: 'The range and the shop agree.',
    dropped: 'Taken out of the range', toClearance: 'Put on clearance', delisted: 'Delisted',
    spaceLead: 'What each part of the floor earns per square foot. Margin, not turnover — a big seller on a thin margin can be the worst use of space in the building.',
    area: 'Area', sqft: 'Sq ft', salesPerSqFt: 'Sales / sq ft', marginPerSqFt: 'Margin / sq ft',
    notMeaningful: 'not measured', tooMuchSpace: 'takes more space than it earns',
    noAreas: 'This screen has not been told how big each part of the floor is.',
    contracts: 'Supplier display space',
    contractsLead: 'An expired contract with the stand still on the floor is space you are giving away.',
    noContracts: 'No display contracts.', owed: 'Owed',
    ok: 'OK', cancel: 'Cancel', read: 'Please read this',
    needCountFields: 'Pick a shelf, an item and a number.',
    needDropFields: 'Give the item code and a reason.',
    sampleData: 'Sample data — this is not your shop.',
    gapsTitle: 'This screen has not been told everything',
    savedCounts: 'Saved on this screen',
    savedCountsLead: 'Each count is kept on this device and carried by the store computer to head office. "Posted" is only ever the store computer\u2019s word.',
    countKeptHere: 'kept on this device',
    countOnPage: 'changed this page only — no store computer is wired',
    raiseRefill: 'Ask the back store for these',
    refillRaised: 'Indent raised for the back store',
    refillAlready: 'Already asked today — see below',
    savedRefills: 'Asked of the back store',
    savedRefillsLead: 'The refill tasks above became one indent, kept on this device and carried to head office; a different person approves it on the Floor indents screen.',
    askedToday: 'asked today',
  },
  ta: {
    title: 'அலமாரிகளும் இடமும்',
    countTab: 'அலமாரியை எண்ணு', refillTab: 'நிரப்புதல்', rangeTab: 'வரிசை', spaceTab: 'இடம்',
    countLead: 'அலமாரியில் உண்மையில் உள்ளதை எண்ணுங்கள். எவ்வளவு இருக்க வேண்டும் என்று காட்டப்படாது — அதுவே நோக்கம்.',
    shelf: 'அலமாரி', itemCode: 'பொருள் குறியீடு', howMany: 'அலமாரியில் எத்தனை உள்ளன',
    saveCount: 'இந்த எண்ணிக்கையைச் சேமி', countSaved: 'எண்ணிக்கை சேமிக்கப்பட்டது',
    stillToCount: 'இன்னும் எண்ண வேண்டியவை',
    stillToCountLead: 'யாரும் இதுவரை எண்ணாதவை முதலில் — அவற்றைப் பற்றி எதுவும் சொல்ல முடியாது.',
    neverCounted: 'இதுவரை எண்ணப்படவில்லை', minutesAgo: 'நிமிடங்களுக்கு முன்', allCounted: 'திட்டத்தில் உள்ள அனைத்தும் சமீபத்தில் எண்ணப்பட்டுள்ளன.',
    refillLead: 'கிடங்கிலிருந்து நிரப்ப வேண்டிய அலமாரிகள், நீங்கள் நடக்கும் வரிசையில்.',
    goFill: 'இவற்றை நிரப்புங்கள்', everythingFound: 'சரிபார்ப்பில் கண்டறியப்பட்ட அனைத்தும்',
    nothingToFill: 'எண்ணப்பட்டவற்றில் நிரப்ப வேண்டியது எதுவும் இல்லை.',
    coverageWhole: 'திட்டத்தில் உள்ள ஒவ்வொரு இடமும் எண்ணப்பட்டது',
    coveragePartial: 'திட்டத்தில் ஒரு பகுதி மட்டுமே எண்ணப்பட்டுள்ளது',
    coverageNone: 'திட்டத்தில் எதுவும் இன்னும் எண்ணப்படவில்லை',
    ofPlan: 'திட்டத்தில் எண்ணப்பட்டது', shelvesFull: 'எண்ணப்பட்ட அலமாரிகளில் சரியாக நிரம்பியுள்ளன',
    meansLittle: 'இந்த எண் எண்ணப்பட்டவற்றை மட்டுமே குறிக்கிறது. மீதமுள்ள கடையைப் பற்றி எதுவும் சொல்லவில்லை.',
    bring: 'கொண்டு வா', noCheck: 'அலமாரிகளைச் சரிபார்க்க முடியாது',
    rangeLead: 'இந்தக் கடை என்ன வைத்திருக்கிறது. இருப்பு இருக்கும் பொருளை நீக்கினால் அது மறைக்கப்படாமல் கிளியரன்ஸுக்குச் செல்லும்.',
    why: 'ஏன்', replacedBy: 'இதற்கு பதிலாக (பொருள் குறியீடு)', dropIt: 'வரிசையிலிருந்து நீக்கு',
    rangeDisagree: 'வரிசையும் கடையும் வேறுபடும் இடங்கள்', carriedToday: 'இன்று வைத்திருப்பவை',
    nothingCarried: 'கடை என்ன வைத்திருக்கிறது என்று இந்தத் திரைக்குத் தெரியவில்லை.',
    rangeClean: 'வரிசையும் கடையும் பொருந்துகின்றன.',
    dropped: 'வரிசையிலிருந்து நீக்கப்பட்டது', toClearance: 'கிளியரன்ஸில் வைக்கப்பட்டது', delisted: 'நீக்கப்பட்டது',
    spaceLead: 'தரையின் ஒவ்வொரு பகுதியும் ஒரு சதுர அடிக்கு எவ்வளவு ஈட்டுகிறது. விற்பனை அல்ல, லாபம் — அதிகம் விற்றாலும் குறைந்த லாபம் என்றால் அது கடையின் மோசமான இட பயன்பாடாக இருக்கலாம்.',
    area: 'பகுதி', sqft: 'சதுர அடி', salesPerSqFt: 'விற்பனை / சதுர அடி', marginPerSqFt: 'லாபம் / சதுர அடி',
    notMeaningful: 'அளக்கப்படவில்லை', tooMuchSpace: 'ஈட்டுவதை விட அதிக இடம் எடுக்கிறது',
    noAreas: 'தரையின் ஒவ்வொரு பகுதியும் எவ்வளவு பெரியது என்று இந்தத் திரைக்குத் தெரியவில்லை.',
    contracts: 'சப்ளையர் காட்சி இடம்',
    contractsLead: 'காலாவதியான ஒப்பந்தம், ஆனால் ஸ்டாண்ட் இன்னும் தரையில் — அது நீங்கள் இலவசமாகக் கொடுக்கும் இடம்.',
    noContracts: 'காட்சி ஒப்பந்தங்கள் இல்லை.', owed: 'வர வேண்டியது',
    ok: 'சரி', cancel: 'ரத்து', read: 'இதைப் படிக்கவும்',
    needCountFields: 'அலமாரி, பொருள், எண்ணிக்கை — எல்லாவற்றையும் கொடுக்கவும்.',
    needDropFields: 'பொருள் குறியீடும் ஒரு காரணமும் கொடுக்கவும்.',
    sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
    gapsTitle: 'இந்தத் திரைக்கு எல்லாத் தகவலும் வரவில்லை',
    savedCounts: 'இந்தத் திரையில் சேமிக்கப்பட்டவை',
    savedCountsLead: 'ஒவ்வொரு எண்ணிக்கையும் இந்தச் சாதனத்தில் வைக்கப்பட்டு, கடைக் கணினி தலைமை அலுவலகத்திற்குக் கொண்டு செல்கிறது. "பதிவானது" என்பது கடைக் கணினியின் சொல் மட்டுமே.',
    countKeptHere: 'இந்தச் சாதனத்தில் வைக்கப்பட்டது',
    countOnPage: 'இந்தப் பக்கம் மட்டுமே மாறியது — கடைக் கணினி இணைக்கப்படவில்லை',
    raiseRefill: 'இவற்றைப் பின்கடையிடம் கேளுங்கள்',
    refillRaised: 'பின்கடைக்கு கோரிக்கை எழுப்பப்பட்டது',
    refillAlready: 'இன்று ஏற்கனவே கேட்கப்பட்டது — கீழே பார்க்கவும்',
    savedRefills: 'பின்கடையிடம் கேட்டவை',
    savedRefillsLead: 'மேலே உள்ள நிரப்பும் வேலைகள் ஒரே கோரிக்கையாகி, இந்தச் சாதனத்தில் வைக்கப்பட்டு தலைமை அலுவலகத்திற்குச் செல்கிறது; வேறு ஒருவர் தளக் கோரிக்கைகள் திரையில் ஒப்புதல் அளிக்கிறார்.',
    askedToday: 'இன்று கேட்கப்பட்டது',
  },
};

/** The five SHARED device states — the same words as the manager's, the buyer's and the indents screens (P-08). */
const STATE_WORDS = {
  saved_here: { en: 'Saved on this device — not yet with the store computer', ta: 'இந்தச் சாதனத்தில் சேமிக்கப்பட்டது — கடைக் கணினிக்கு இன்னும் செல்லவில்லை' },
  retrying: { en: 'Saved on this device — trying the store computer again', ta: 'இந்தச் சாதனத்தில் சேமிக்கப்பட்டது — கடைக் கணினியை மீண்டும் முயல்கிறது' },
  handed_to_box: { en: 'With the store computer — waiting for head office', ta: 'கடைக் கணினியில் உள்ளது — தலைமை அலுவலகத்திற்காகக் காத்திருக்கிறது' },
  posted: { en: 'Posted at head office', ta: 'தலைமை அலுவலகத்தில் பதிவானது' },
  refused: { en: 'Refused — a person must look at this', ta: 'மறுக்கப்பட்டது — ஒருவர் இதைப் பார்க்க வேண்டும்' },
};

/** Why a refill ask was refused before anything was saved — one entry per `RefillRefusal`. */
const REFILL_REFUSAL_WORDS = {
  no_indent_link: { en: 'This screen has no link to the floor indents, so it cannot ask the back store. Use the Floor indents screen.', ta: 'இந்தத் திரைக்கு தளக் கோரிக்கைகளுடன் இணைப்பு இல்லை. தளக் கோரிக்கைகள் திரையைப் பயன்படுத்துங்கள்.' },
  nothing_to_fill: { en: 'Nothing needs filling from what has been counted, so there is nothing to ask for.', ta: 'எண்ணப்பட்டவற்றில் நிரப்ப வேண்டியது எதுவும் இல்லை. எனவே கேட்க எதுவும் இல்லை.' },
  not_permitted: { en: 'You do not hold the right to raise an indent. Ask the floor supervisor.', ta: 'கோரிக்கை எழுப்பும் உரிமை உங்களுக்கு இல்லை. தள மேற்பார்வையாளரைக் கேளுங்கள்.' },
  nobody_named: { en: 'Nobody is signed in on this screen, so the ask cannot be put in anyone\u2019s name.', ta: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை. எனவே கோரிக்கையை யார் பெயரிலும் வைக்க முடியாது.' },
  no_places: { en: 'The store computer has not named the floor and the back store, so there is nowhere to ask from.', ta: 'கடைக் கணினி தளத்தையும் பின்கடையையும் குறிப்பிடவில்லை.' },
  no_lines: { en: 'The ask would have no lines.', ta: 'கோரிக்கையில் வரிகள் இல்லை.' },
  bad_line: { en: 'A line on the ask is not a whole number of an item.', ta: 'கோரிக்கையில் ஒரு வரி முழு எண்ணாக இல்லை.' },
  duplicate_product: { en: 'The same item appears twice on the ask.', ta: 'ஒரே பொருள் கோரிக்கையில் இரண்டு முறை உள்ளது.' },
};
let lang = 'en';
const t = (key) => WORDS[lang][key] ?? WORDS.en[key];

/** Why a count was refused — one entry per `CountRefusal`, in both languages. */
const COUNT_REFUSAL_WORDS = {
  a_negative_count_is_not_a_count: {
    en: 'A shelf cannot hold less than nothing. If the facing is empty, the answer is zero.',
    ta: 'ஒரு அலமாரி பூஜ்ஜியத்தை விடக் குறைவாக வைத்திருக்க முடியாது. காலியாக இருந்தால் பதில் பூஜ்ஜியம்.',
  },
  a_count_needs_a_whole_number: {
    en: 'Count in whole units. Half a tin on a shelf is a damaged tin, which is a different job.',
    ta: 'முழு எண்ணிக்கையில் எண்ணுங்கள். பாதி டப்பா என்பது சேதமான டப்பா — அது வேறு வேலை.',
  },
  nobody_signed_this_count: {
    en: 'A count nobody put their name to cannot be asked about later, and it will be asked about.',
    ta: 'யாரும் பெயர் போடாத எண்ணிக்கையைப் பற்றி பின்னர் கேட்க முடியாது — ஆனால் கேட்கப்படும்.',
  },
  this_shop_has_no_such_shelf: {
    en: 'This shop has no such shelf. A count against a shelf that does not exist is one nobody can act on.',
    ta: 'இந்தக் கடையில் அப்படி ஒரு அலமாரி இல்லை. இல்லாத அலமாரிக்கான எண்ணிக்கையை யாரும் பயன்படுத்த முடியாது.',
  },
};

/** Why the shelves cannot be checked at all — one entry per `NoPlanReason`. */
const NO_PLAN_WORDS = {
  this_store_has_no_shelf_map: {
    en: 'Nobody has addressed this shop’s shelves yet, so there is nothing to check against.',
    ta: 'இந்தக் கடையின் அலமாரிகளுக்கு இன்னும் முகவரி கொடுக்கப்படவில்லை. எனவே ஒப்பிட எதுவும் இல்லை.',
  },
  this_store_has_never_published_a_planogram: {
    en: 'This shop has never published a shelf plan, so there is nothing to compare the shelves with.',
    ta: 'இந்தக் கடை இதுவரை அலமாரித் திட்டம் ஒன்றை வெளியிடவில்லை. எனவே அலமாரிகளை எதனுடனும் ஒப்பிட முடியாது.',
  },
};

/** What the store box did not tell this screen — one sentence per `MerchandisingGap`. */
const GAP_WORDS = {
  where_the_shelves_are: {
    en: 'It has not been told where the shelves are, so nothing can be counted — a count against a shelf that does not exist is one nobody can act on.',
    ta: 'அலமாரிகள் எங்கே உள்ளன என்று தெரியவில்லை. எனவே எதையும் எண்ண முடியாது.',
  },
  what_should_be_on_each_shelf: {
    en: 'It has not been told what should be on each shelf, so there is nothing to check the shelves against.',
    ta: 'ஒவ்வொரு அலமாரியிலும் என்ன இருக்க வேண்டும் என்று தெரியவில்லை. எனவே அலமாரிகளை ஒப்பிட எதுவும் இல்லை.',
  },
  what_is_in_the_stockroom: {
    en: 'It has not been told what is in the stockroom, so a refill task would be a wish rather than an instruction.',
    ta: 'கிடங்கில் என்ன உள்ளது என்று தெரியவில்லை. எனவே நிரப்பும் வேலை ஒரு ஆசையாகவே இருக்கும், கட்டளையாக அல்ல.',
  },
  what_this_shop_carries: {
    en: 'It has not been told what this shop carries, so the range cannot be reviewed.',
    ta: 'இந்தக் கடை என்ன வைத்திருக்கிறது என்று தெரியவில்லை. எனவே வரிசையை மதிப்பாய்வு செய்ய முடியாது.',
  },
  how_big_each_part_of_the_floor_is: {
    en: 'It has not been told how big each part of the floor is, so sales per square foot cannot be worked out — and a made-up one would decide a layout.',
    ta: 'தரையின் ஒவ்வொரு பகுதியும் எவ்வளவு பெரியது என்று தெரியவில்லை. எனவே சதுர அடிக்கான விற்பனையைக் கணக்கிட முடியாது.',
  },
  who_is_counting: {
    en: 'It has not been told who is at this screen, so no count can be put in anyone\u2019s name and none will be saved.',
    ta: 'இந்தத் திரையில் யார் இருக்கிறார்கள் என்று தெரியவில்லை. எனவே எந்த எண்ணிக்கையும் யார் பெயரிலும் சேமிக்க முடியாது.',
  },
};

const words = (map, key) => (map[key]?.[lang] ?? map[key]?.en ?? String(key).replace(/_/g, ' '));

/** The range reasons the engine accepts. Offered, never invented on the screen. */
const DROP_REASONS = {
  poor_sales: { en: 'It does not sell', ta: 'விற்பனை ஆகவில்லை' },
  poor_margin: { en: 'The margin is too thin', ta: 'லாபம் மிகக் குறைவு' },
  supplier_discontinued: { en: 'The supplier stopped making it', ta: 'சப்ளையர் நிறுத்திவிட்டார்' },
  quality_issue: { en: 'A quality problem', ta: 'தரப் பிரச்சினை' },
  range_rationalisation: { en: 'Tidying the range', ta: 'வரிசையைச் சீரமைத்தல்' },
  seasonal_end: { en: 'The season is over', ta: 'சீசன் முடிந்தது' },
  replaced_by_alternative: { en: 'Replaced by something else', ta: 'வேறு பொருளால் மாற்றப்பட்டது' },
};

/** A stand-in with the same surface as the bundled session, announced whenever it is in use. */
function sampleSession() {
  return {
    countingList: () => [],
    ages: () => [],
    count: () => ({ ok: false, refusal: 'this_shop_has_no_such_shelf', detail: 'this is sample data' }),
    savedCounts: () => [],
    handedKeys: () => [],
    noteBoxStatus: () => {},
    refills: () => ({ tasks: [], draft: null, canRaise: false, alreadySaved: false, saved: [] }),
    raiseRefill: () => ({ ok: false, refusal: 'no_indent_link' }),
    check: () => ({ why: 'this_store_has_no_shelf_map' }),
    range: () => [],
    drop: () => ({ ok: false, detail: 'this is sample data' }),
    rangeIssues: () => [],
    space: () => [],
    contracts: () => [],
  };
}

const real = window.merchandisingSession;
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
el('sheet-cancel').addEventListener('click', () => { el('sheet').hidden = true; });

/** Everything the box did not tell this screen, named rather than left to be guessed. */
function renderGaps() {
  const gaps = window.merchandisingGaps ?? [];
  el('gaps').hidden = gaps.length === 0;
  el('gaps-title').textContent = t('gapsTitle');
  el('gaps-list').replaceChildren(...gaps.map((gap) => {
    const item = document.createElement('li');
    item.textContent = words(GAP_WORDS, gap);
    return item;
  }));
}

// ── Navigation ──────────────────────────────────────────────────────────────

const VIEWS = ['count', 'refill', 'range', 'space'];
function show(name) {
  for (const view of VIEWS) {
    el(`view-${view}`).hidden = view !== name;
    el(`tab-${view}`).setAttribute('aria-current', view === name ? 'page' : 'false');
  }
}
for (const name of VIEWS) {
  el(`tab-${name}`).addEventListener('click', () => { show(name); });
}

/** One piece of work saved on this device: what it was, and where it has got to — a word, never colour alone. */
function savedRow(what, detail, w) {
  const li = document.createElement('li');
  li.className = 'saved';
  li.dataset.state = w.state;
  const head = document.createElement('div'); head.className = 'what'; head.textContent = what;
  const sub = document.createElement('div'); sub.className = 'detail'; sub.textContent = detail;
  const pill = document.createElement('div'); pill.className = `pill ${w.state}`; pill.textContent = words(STATE_WORDS, w.state);
  li.append(head, sub, pill);
  if (w.reason) { const why = document.createElement('div'); why.className = 'why'; why.textContent = w.reason; li.append(why); }
  return li;
}

// ── Counting ────────────────────────────────────────────────────────────────

/** Every count this screen saved, newest first, with the five shared state words (P-08). */
function renderSavedCounts() {
  const saved = session.savedCounts();
  el('saved-counts-heading').hidden = saved.length === 0;
  el('saved-counts-lead').hidden = saved.length === 0;
  el('saved-counts-heading').textContent = t('savedCounts');
  el('saved-counts-lead').textContent = t('savedCountsLead');
  el('saved-counts').replaceChildren(...saved.map((w) => savedRow(`${w.productId} · ${w.countedMinor}`, `${w.locationId} · ${w.countId}`, w)));
}

function renderCount() {
  el('count-title').textContent = t('countTab');
  el('count-lead').textContent = t('countLead');
  el('count-location-label').textContent = t('shelf');
  el('count-product-label').textContent = t('itemCode');
  el('count-qty-label').textContent = t('howMany');
  el('save-count').textContent = t('saveCount');
  el('tocount-title').textContent = t('stillToCount');
  el('tocount-lead').textContent = t('stillToCountLead');

  // The shelves this shop has, from the box. Deliberately NOT a free-text field: a typo becomes a
  // phantom facing that nobody ever counts and the compliance report can never explain.
  const shelves = window.merchandisingData?.shelfLocations ?? [];
  el('count-location').replaceChildren(...shelves.map((location) => {
    const option = document.createElement('option');
    option.value = location.locationId;
    option.textContent = (location.label ?? location.locationId)
      + (location.zone === undefined || location.zone === 'ambient' ? '' : ` (${location.zone})`);
    return option;
  }));

  const list = session.countingList();
  if (list.length === 0) {
    const none = document.createElement('p');
    none.className = 'empty';
    none.textContent = t('allCounted');
    el('tocount-list').replaceChildren(none);
    return;
  }
  renderSavedCounts();
  el('tocount-list').replaceChildren(...list.map((row) => {
    const item = document.createElement('div');
    item.className = 'row ' + (row.lastCountedAt === null ? 'urgent' : 'normal');
    const what = document.createElement('span');
    what.className = 'what';
    const name = document.createElement('strong');
    name.textContent = row.productId;
    const sub = document.createElement('small');
    // "Never counted" is not "a long time ago", and the difference decides where somebody starts.
    sub.textContent = row.lastCountedAt === null
      ? `${row.locationId} · ${t('neverCounted')}`
      : `${row.locationId} · ${row.minutesAgo} ${t('minutesAgo')}`;
    what.append(name, sub);
    item.append(what);
    return item;
  }));
}

el('save-count').addEventListener('click', () => {
  const locationId = el('count-location').value;
  const productId = el('count-product').value.trim();
  const qty = el('count-qty').value.trim();
  if (locationId === '' || productId === '' || qty === '') {
    tell(t('read'), t('needCountFields'));
    return;
  }
  // The session writes the count to the durable device queue BEFORE it returns ok (SP-8c-ii); the view only renders.
  const outcome = session.count({ locationId, productId, countedMinor: Number(qty) });
  if (!outcome.ok) { tell(t('read'), words(COUNT_REFUSAL_WORDS, outcome.refusal)); return; }

  // The count is queued for the box; the screen keeps it so the next count is against a list that
  // already reflects this one, rather than asking for the same facing twice.
  (window.merchandisingData?.shelfCounts ?? []).push(outcome.count);
  el('count-product').value = '';
  el('count-qty').value = '';
  renderCount();
  renderRefill();
  tell(t('countSaved'), `${outcome.count.productId} · ${outcome.count.countedMinor} — ${outcome.queued ? t('countKeptHere') : t('countOnPage')}`, true);
  void syncToBox();
});

// ── Refills ─────────────────────────────────────────────────────────────────

function renderRefill() {
  el('refill-title').textContent = t('refillTab');
  el('refill-lead').textContent = t('refillLead');
  el('tasks-title').textContent = t('goFill');
  el('issues-title').textContent = t('everythingFound');
  el('raise-refill').textContent = t('raiseRefill');
  renderSavedRefills();

  const check = session.check();
  const coverage = el('coverage');
  coverage.replaceChildren();

  if ('why' in check) {
    // Two different nothings, and they lead to different actions: address the shelves, or publish
    // a plan. "0 issues" would read as neither, and as a clean shop.
    coverage.className = 'coverage none';
    const head = document.createElement('strong');
    head.textContent = t('noCheck');
    const why = document.createElement('span');
    why.className = 'headline';
    why.textContent = words(NO_PLAN_WORDS, check.why);
    coverage.append(head, why);
    el('tasks-list').replaceChildren();
    el('issues-list').replaceChildren();
    el('raise-refill').hidden = true;
    return;
  }

  // The refill tasks become ONE indent on the shared queue — offered only when this reader may raise it and there is
  // something to fill; the same shelves asked once a day, so the button says so instead of asking again.
  const refills = session.refills();
  el('raise-refill').hidden = !refills.canRaise;
  el('raise-refill').disabled = refills.alreadySaved;
  el('raise-refill').textContent = refills.alreadySaved ? t('refillAlready') : t('raiseRefill');

  const counted = check.plannedFacings - check.notObserved;
  coverage.className = 'coverage ' + (check.wholePlanObserved ? 'whole' : counted === 0 ? 'none' : 'partial');

  // Coverage FIRST. A compliance percentage over a shop nobody has counted is a number somebody
  // would put on a wall, and it would mean nothing.
  const headline = document.createElement('span');
  headline.className = 'headline';
  headline.textContent = check.wholePlanObserved
    ? t('coverageWhole')
    : counted === 0 ? t('coverageNone') : t('coveragePartial');

  const coverageFigure = document.createElement('span');
  coverageFigure.className = 'figure';
  coverageFigure.textContent = `${counted} / ${check.plannedFacings} ${t('ofPlan')}`;

  coverage.append(headline, coverageFigure);

  if (counted > 0) {
    const compliance = document.createElement('span');
    compliance.className = 'headline';
    compliance.textContent = `${Math.round(check.complianceBp / 100)}% ${t('shelvesFull')}`;
    coverage.append(compliance);
  }
  if (!check.wholePlanObserved) {
    const caveat = document.createElement('span');
    caveat.className = 'caveat';
    caveat.textContent = t('meansLittle');
    coverage.append(caveat);
  }

  if (check.tasks.length === 0) {
    const none = document.createElement('p');
    none.className = 'empty';
    none.textContent = t('nothingToFill');
    el('tasks-list').replaceChildren(none);
  } else {
    el('tasks-list').replaceChildren(...check.tasks.map((task) => {
      const row = document.createElement('div');
      row.className = `row ${task.priority}`;
      const what = document.createElement('span');
      what.className = 'what';
      const name = document.createElement('strong');
      name.textContent = task.productId;
      const sub = document.createElement('small');
      sub.textContent = `${task.location.label ?? task.locationId} · ${task.detail}`;
      what.append(name, sub);
      const qty = document.createElement('span');
      qty.className = 'qty';
      qty.textContent = String(task.quantityMinor);
      row.append(what, qty);
      return row;
    }));
  }

  el('issues-list').replaceChildren(...check.issues.map((issue) => {
    const row = document.createElement('div');
    row.className = 'row';
    const what = document.createElement('span');
    what.className = 'what';
    const name = document.createElement('strong');
    name.textContent = issue.productId;
    const sub = document.createElement('small');
    // The engine's own sentence. Rewording it here would put a second, untested version of the
    // same judgement on the screen.
    sub.textContent = issue.detail;
    what.append(name, sub);
    row.append(what);
    return row;
  }));
}

/** The asks this screen raised from refill tasks, newest first, with the five shared state words. */
function renderSavedRefills() {
  const saved = session.refills().saved;
  el('saved-refills-heading').hidden = saved.length === 0;
  el('saved-refills-lead').hidden = saved.length === 0;
  el('saved-refills-heading').textContent = t('savedRefills');
  el('saved-refills-lead').textContent = t('savedRefillsLead');
  el('saved-refills').replaceChildren(...saved.map((w) => savedRow(`${w.indentId} · ${t('askedToday')}`, w.detail, w)));
}

el('raise-refill').addEventListener('click', () => {
  // The session refuses before anything is saved (no link, nobody named, no right, nothing to fill); a good ask is on the
  // durable queue through the Indents session before this returns ok. The view invents no wording.
  const outcome = session.raiseRefill();
  if (!outcome.ok) { tell(t('read'), words(REFILL_REFUSAL_WORDS, outcome.refusal)); return; }
  renderRefill();
  tell(outcome.alreadySaved ? t('refillAlready') : t('refillRaised'), outcome.indentId, true);
  void syncToBox();
});

// ── Range ───────────────────────────────────────────────────────────────────

function renderRange() {
  el('range-title').textContent = t('rangeTab');
  el('range-lead').textContent = t('rangeLead');
  el('drop-product-label').textContent = t('itemCode');
  el('drop-reason-label').textContent = t('why');
  el('drop-replacement-label').textContent = t('replacedBy');
  el('drop-item').textContent = t('dropIt');
  el('range-issues-title').textContent = t('rangeDisagree');
  el('range-list-title').textContent = t('carriedToday');

  el('drop-reason').replaceChildren(...Object.keys(DROP_REASONS).map((reason) => {
    const option = document.createElement('option');
    option.value = reason;
    option.textContent = words(DROP_REASONS, reason);
    return option;
  }));

  const issues = session.rangeIssues();
  if (issues.length === 0) {
    const none = document.createElement('p');
    none.className = 'empty';
    none.textContent = t('rangeClean');
    el('range-issues').replaceChildren(none);
  } else {
    el('range-issues').replaceChildren(...issues.map((issue) => {
      const row = document.createElement('div');
      row.className = 'row normal';
      const what = document.createElement('span');
      what.className = 'what';
      const name = document.createElement('strong');
      name.textContent = issue.productId;
      const sub = document.createElement('small');
      sub.textContent = issue.detail;
      what.append(name, sub);
      row.append(what);
      return row;
    }));
  }

  const carried = session.range();
  if (carried.length === 0) {
    const none = document.createElement('p');
    none.className = 'empty';
    none.textContent = t('nothingCarried');
    el('range-list').replaceChildren(none);
    return;
  }
  const list = document.createElement('p');
  list.textContent = carried.join(' · ');
  el('range-list').replaceChildren(list);
}

el('drop-item').addEventListener('click', () => {
  const productId = el('drop-product').value.trim();
  const reason = el('drop-reason').value;
  if (productId === '' || reason === '') { tell(t('read'), t('needDropFields')); return; }
  const replacement = el('drop-replacement').value.trim();

  const outcome = session.drop({
    productId,
    reason,
    ...(replacement === '' ? {} : { replacedByProductId: replacement }),
  });
  if (!outcome.ok) {
    // The engine's own refusal, said rather than swallowed — it is the one that stops a stocked
    // item being deleted, and the one that insists a replacement is named.
    tell(t('read'), outcome.detail);
    return;
  }
  el('drop-product').value = '';
  el('drop-replacement').value = '';
  renderRange();
  tell(
    t('dropped'),
    `${productId} — ${outcome.decision.outcome === 'routed_to_clearance' ? t('toClearance') : t('delisted')}. ${outcome.decision.detail}`,
    true,
  );
});

// ── Space ───────────────────────────────────────────────────────────────────

function renderSpace() {
  el('space-title').textContent = t('spaceTab');
  el('space-lead').textContent = t('spaceLead');
  el('contracts-title').textContent = t('contracts');
  el('contracts-lead').textContent = t('contractsLead');

  const rows = session.space();
  if (rows.length === 0) {
    const none = document.createElement('p');
    none.className = 'empty';
    none.textContent = t('noAreas');
    el('space-list').replaceChildren(none);
  } else {
    const table = document.createElement('table');
    const head = document.createElement('tr');
    for (const [text, cls] of [[t('area'), ''], [t('sqft'), 'amount'], [t('salesPerSqFt'), 'amount'], [t('marginPerSqFt'), 'amount']]) {
      const th = document.createElement('th');
      th.textContent = text;
      if (cls) th.className = cls;
      head.append(th);
    }
    table.append(head);
    for (const row of rows) {
      const tr = document.createElement('tr');
      if (row.underperforming) tr.className = 'flag';
      // A ratio that cannot be computed says so. "0 sales per sq ft" and "we never measured this
      // area" lead to opposite decisions.
      const show = (ratio) => (ratio.kind === 'per_sq_ft' ? inr(ratio.minorPerSqFt) : t('notMeaningful'));
      for (const [text, cls] of [
        [row.name + (row.underperforming ? ` — ${t('tooMuchSpace')}` : ''), ''],
        [String(row.squareFeet), 'amount'],
        [show(row.salesPerSqFt), 'amount'],
        [show(row.marginPerSqFt), 'amount'],
      ]) {
        const td = document.createElement('td');
        td.textContent = text;
        if (cls) td.className = cls;
        tr.append(td);
      }
      table.append(tr);
    }
    el('space-list').replaceChildren(table);
  }

  const contracts = session.contracts();
  if (contracts.length === 0) {
    const none = document.createElement('p');
    none.className = 'empty';
    none.textContent = t('noContracts');
    el('contracts-list').replaceChildren(none);
    return;
  }
  el('contracts-list').replaceChildren(...contracts.map((contract) => {
    const row = document.createElement('div');
    row.className = 'row ' + (contract.finding === 'active' ? 'low' : 'urgent');
    const what = document.createElement('span');
    what.className = 'what';
    const name = document.createElement('strong');
    name.textContent = contract.supplierId;
    const sub = document.createElement('small');
    sub.textContent = contract.detail;
    what.append(name, sub);
    const owed = document.createElement('span');
    owed.className = 'qty';
    owed.textContent = contract.outstanding.minor > 0 ? `${t('owed')} ${inr(contract.outstanding.minor)}` : '';
    row.append(what, owed);
    return row;
  }));
}

// ── Language ────────────────────────────────────────────────────────────────

function paintChrome() {
  el('who').firstChild.textContent = `${t('title')} `;
  el('whoami').textContent = window.merchandisingData?.userId ?? '';
  el('tab-count').textContent = t('countTab');
  el('tab-refill').textContent = t('refillTab');
  el('tab-range').textContent = t('rangeTab');
  el('tab-space').textContent = t('spaceTab');
  el('sample').textContent = t('sampleData');
  renderGaps();
  renderCount();
  renderRefill();
  renderRange();
  renderSpace();
}

el('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  paintChrome();
});

// ── Boot ────────────────────────────────────────────────────────────────────

el('sample').hidden = real !== undefined;
paintChrome();
show('count');

/**
 * Hand this screen's saved counts and asks to the store computer and learn where they have got to (SP-2 / SP-8c-ii). The
 * relay is the composition root's (`window.merchandisingRelay`), present only when the box told this screen where its
 * socket is. Called after every save and when the page regains the network or the reader's attention — no timer.
 */
async function syncToBox() {
  const relay = window.merchandisingRelay;
  if (!relay) return;
  try { await relay.syncNow(); } catch { /* the queue is untouched; the state words say "saved on this device" */ }
  renderSavedCounts();
  renderSavedRefills();
}
for (const moment of ['online', 'focus', 'pageshow']) window.addEventListener(moment, () => { void syncToBox(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) void syncToBox(); });
void syncToBox();

// ── The shell's own honesty about where this page came from ─────────────────
//

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
