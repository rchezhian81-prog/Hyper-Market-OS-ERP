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
// No `prompt`, `confirm` or `alert`; the banner does not fade.

const el = (id) => document.getElementById(id);

const inr = (minor) =>
  '₹' + (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── Words ───────────────────────────────────────────────────────────────────

const WORDS = {
  en: {
    staleShell: 'No connection to the store computer. This page is what it was last told, at',
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
  },
  ta: {
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:',
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
  },
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

// ── Counting ────────────────────────────────────────────────────────────────

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
  const outcome = session.count({ locationId, productId, countedMinor: Number(qty) });
  if (!outcome.ok) { tell(t('read'), words(COUNT_REFUSAL_WORDS, outcome.refusal)); return; }

  // The count is queued for the box; the screen keeps it so the next count is against a list that
  // already reflects this one, rather than asking for the same facing twice.
  (window.merchandisingData?.shelfCounts ?? []).push(outcome.count);
  el('count-product').value = '';
  el('count-qty').value = '';
  renderCount();
  renderRefill();
  tell(t('countSaved'), `${outcome.count.productId} · ${outcome.count.countedMinor}`, true);
});

// ── Refills ─────────────────────────────────────────────────────────────────

function renderRefill() {
  el('refill-title').textContent = t('refillTab');
  el('refill-lead').textContent = t('refillLead');
  el('tasks-title').textContent = t('goFill');
  el('issues-title').textContent = t('everythingFound');

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
    return;
  }

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

// ── The shell's own honesty about where this page came from ─────────────────
//
// A cached page shown as a live one is the fault this product exists to refuse — and on this screen
// it is worse than most: a shelf count from this morning presented as this minute's is exactly the
// mistake the whole freshness window is built to prevent.
function paintStale() {
  const at = window.shellCachedAt;
  const strip = el('stale');
  if (!strip) return;
  strip.hidden = at === undefined;
  if (at === undefined) return;
  strip.textContent = `${t('staleShell')} ${new Date(at).toLocaleString()}`;
}
paintStale();
el('lang').addEventListener('click', paintStale);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
