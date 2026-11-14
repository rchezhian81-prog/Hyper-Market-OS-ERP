// Owner command centre — the view layer. It renders the brief and the approvals produced by the
// TESTED model (`apps/owner-app/src/owner-session.ts`, bundled as `window.ownerSession`) and holds
// no business logic of its own: no KPI maths, no alert grouping, no priority rules, no decision
// about whether data is fresh enough to act on.
//
// ── What this file exists to hold ───────────────────────────────────────────
//
// **1. The age of the data is put in front of the decision, not in a badge above it.** The owner
// is remote and every figure here is historical by construction. Reading yesterday's numbers on
// eleven-hour-old data is fine; approving ₹8 lakh on it is not. So when the data is stale the
// approve panel carries the age in words and the owner has to act through it — one deliberate tap,
// and the model records that they were told.
//
// **2. Nothing is a dead end.** The previous version of this screen answered a tapped alert with
// `window.alert('t-1\nt-2')` — a system dialog containing raw ids. Every tap now opens something
// real: a figure opens the sales behind it, an approval opens the decision.
//
// **3. Sample figures announce themselves.** They used to render as if they were the shop's, down
// to plausible rupee totals. An owner acting on a number that came from nowhere is worse than an
// owner with no number at all.
//
// **4. Tamil is complete.** The old language button set `document.documentElement.lang` and
// changed not one word on the screen — a toggle that says "translated" and is not.
//
// Nothing here fetches. What the phone was last told is all there is (§31).

// OB-607: a moment is shown at the SHOP's clock (its zone, as the store computer told the page) — never this device's.
const shopWhen = (value) => window.sreShopDay?.dateTimeOf(value) ?? '';
const el = (id) => document.getElementById(id);

/** Exact minor units in, rupees out. The model never sees a float. */
const inr = (minor) =>
  '₹' + (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── Words ───────────────────────────────────────────────────────────────────

const WORDS = {
  en: {
    staleShell: 'No connection. These figures are what this phone was last given, at',
    appTitle: 'Today · SRE Hyper Market', today: 'Today', needsAttention: 'Needs your attention', todaysNumbers: "Today's numbers",
    waitingForYou: 'Waiting for you', alerts: 'Alerts', lookAgain: 'Look at these again',
    decidedNotSent: 'Decided, not yet sent', nothingToDecide: 'Nothing needs a decision right now.',
    noAlerts: 'No alerts today.', nothingWaiting: 'Nothing is waiting for you.',
    notKnownNever: 'Not known — no data has ever reached this phone.', notKnownStale: 'Not known — the last word from the shop was',
    live: 'Live · synced', notLive: 'NOT LIVE — last synced', neverSynced: 'No data has ever reached this phone',
    justNow: 'just now', minutesAgo: 'min ago', hoursAgo: 'hours ago',
    sales: 'Taken today', margin: 'Margin', bills: 'Bills', averageBasket: 'Average basket',
    marginNotKnown: 'Not known', tapToSee: 'Tap to see every sale', approve: 'Approve', reject: 'Reject', cancel: 'Cancel',
    close: 'Close', ok: 'OK', total: 'Total', askedBy: 'asked for by', noValue: 'no value',
    whyApprove: 'Why are you approving this?', whyReject: 'Why are you rejecting this?',
    read: 'Please read this', decided: 'Decided', willSend: 'It will be sent as soon as there is a signal.',
    staleWarning: 'These numbers are not live. The shop has been open since this data left, so what you are approving may already have changed. Tap a reason only if you still want to decide now.',
    exception: 'Exception', approval: 'Approval',
    transactions: 'transactions', drillNote: 'Every sale behind this figure — not a sample.',
    countIsAnswer: 'The number of bills is the answer here; the money beside each one is what that bill was worth.',
    noDataTitle: 'This phone has nothing to show',
    noDataBody: 'No figures have reached it yet. Nothing is wrong with the shop — this app has simply not been given any data. It will fill in as soon as it syncs.',
    cannotDecideNoData: 'Nothing has ever synced from this branch, so there is no basis for a decision at all. This is not something to acknowledge and carry on from.',
    sampleData: 'Sample figures — this is not your shop.',
    queuedOne: 'decision waiting to be sent', queuedMany: 'decisions waiting to be sent',
    changedSince: 'This changed after you decided it', withdrawnSince: 'This is no longer waiting for anybody',
    youSaid: 'You said', itNowSays: 'It now says', discard: 'Remove it from my list',
    branchNotThere: 'That shop is not on this phone.',
    // UI-3 (1 Nov 2026): the glance layout, the "no signal" strip, the "not known" figures and the trend charts.
    asAt: 'as at', offline: 'No signal on this phone. Every figure here is what it last received — see the time above.',
    notKnownNoData: 'Not known — no figures from this shop have reached this phone yet.',
    noBillsYet: 'no bills yet today', noCostToday: 'no cost on today\'s bills',
    leftOut: 'bills with no cost are left out', refundLine: 'refund', noCostLine: 'no cost',
    unlisted: 'more counted in this figure that the store computer did not list — the lines above do not add up to it.',
    nothingReached: 'nothing has reached this phone', howTheDayGoes: 'How the day is going',
    hourTitle: 'Bills by the hour, today', hourHeading: 'Hour', takenHeading: 'Taken',
    hourCovers: 'Today at {branch}, by the shop clock · money on the bills, before refunds · read at {time}',
    hourEmpty: 'No bill has been rung today yet, so there is nothing to draw.',
    daysTitle: 'The last days on the store computer', dayHeading: 'Day', todayMark: 'today',
    daysCovers: '{branch} · each trading day the store computer holds (up to 7) · before refunds · read at {time}',
    daysEmpty: 'The store computer holds no trading day yet, so there is nothing to draw.',
    tenderTitle: 'How today was paid', tenderHeading: 'Paid by',
    tenderCovers: 'Today at {branch} · after refunds, the same as "Taken today" · read at {time}',
    tenderEmpty: 'Nothing has been paid today yet, so there is nothing to draw.',
    notSent: 'The store computer did not send this figure, so it is not drawn. Nothing is assumed.',
    chartsMissing: 'The chart part of this app is not on this phone, so the trend is not drawn. The figures above are unaffected.',
    // U6 (7 Nov 2026): the branches side by side (M29-FR-02) and the office pages this phone links to (OB-701).
    compareTitle: 'Branches side by side', compareNote: 'Each shop\'s own figures and its own data age — one shop syncing does not make the others current.',
    cTaken: 'Taken today', cBills: 'Bills', cMargin: 'Margin', cWaiting: 'Waiting for you', cAttention: 'Needs attention', cAge: 'Data',
    notKnownShort: 'Not known', marginNoCost: 'no cost on the bills',
    officeTitle: 'Also in the office', officeNote: 'These open the office\'s own pages. Nothing is copied to this phone.',
    officeAudit: 'Audit log — who did what', officeHealth: 'Store computers — system health', officeCompare: 'Compare side by side — the full report',
    officeNotServed: 'The office links are not on this copy of the app.',
  },
  ta: {
    staleShell: 'இணைப்பு இல்லை. இந்த எண்கள் இந்த ஃபோனுக்குக் கடைசியாகக் கொடுக்கப்பட்டவை:',
    appTitle: 'இன்று · SRE Hyper Market', today: 'இன்று', needsAttention: 'உங்கள் கவனம் தேவை', todaysNumbers: 'இன்றைய எண்கள்',
    waitingForYou: 'உங்களுக்காகக் காத்திருப்பவை', alerts: 'எச்சரிக்கைகள்', lookAgain: 'இவற்றை மீண்டும் பாருங்கள்',
    decidedNotSent: 'முடிவு செய்யப்பட்டது, இன்னும் அனுப்பப்படவில்லை', nothingToDecide: 'இப்போது எந்த முடிவும் தேவையில்லை.',
    noAlerts: 'இன்று எச்சரிக்கை எதுவும் இல்லை.', nothingWaiting: 'உங்களுக்காக எதுவும் காத்திருக்கவில்லை.',
    notKnownNever: 'தெரியாது — இந்த ஃபோனுக்கு இதுவரை எந்தத் தகவலும் வரவில்லை.', notKnownStale: 'தெரியாது — கடையிலிருந்து கடைசித் தகவல் வந்தது',
    live: 'நேரலை · ஒத்திசைவு', notLive: 'நேரலை அல்ல — கடைசி ஒத்திசைவு', neverSynced: 'இந்த ஃபோனுக்கு இதுவரை எந்தத் தகவலும் வரவில்லை',
    justNow: 'இப்போதுதான்', minutesAgo: 'நிமிடங்களுக்கு முன்', hoursAgo: 'மணி நேரத்திற்கு முன்',
    sales: 'இன்று வசூல்', margin: 'லாபம்', bills: 'பில்கள்', averageBasket: 'சராசரி கூடை',
    marginNotKnown: 'தெரியவில்லை', tapToSee: 'ஒவ்வொரு விற்பனையையும் பார்க்கத் தட்டவும்', approve: 'ஒப்புதல்', reject: 'மறு', cancel: 'ரத்து',
    close: 'மூடு', ok: 'சரி', total: 'மொத்தம்', askedBy: 'கேட்டவர்', noValue: 'மதிப்பு இல்லை',
    whyApprove: 'ஏன் ஒப்புதல் அளிக்கிறீர்கள்?', whyReject: 'ஏன் மறுக்கிறீர்கள்?',
    read: 'இதைப் படிக்கவும்', decided: 'முடிவு பதிவாகியது', willSend: 'சிக்னல் கிடைத்தவுடன் அனுப்பப்படும்.',
    staleWarning: 'இந்த எண்கள் நேரலை அல்ல. இந்தத் தகவல் வந்த பிறகும் கடை திறந்திருந்தது. எனவே நீங்கள் ஒப்புதல் அளிப்பது ஏற்கனவே மாறியிருக்கலாம். இப்போதே முடிவு செய்ய விரும்பினால் மட்டும் ஒரு காரணத்தைத் தட்டவும்.',
    exception: 'விதிவிலக்கு', approval: 'ஒப்புதல்',
    transactions: 'பரிவர்த்தனைகள்', drillNote: 'இந்த எண்ணுக்குப் பின்னால் உள்ள ஒவ்வொரு விற்பனையும் — மாதிரி அல்ல.',
    countIsAnswer: 'இங்கே பில்களின் எண்ணிக்கையே பதில்; ஒவ்வொன்றின் பக்கத்தில் உள்ள தொகை அந்தப் பில்லின் மதிப்பு.',
    noDataTitle: 'இந்த ஃபோனில் காட்ட எதுவும் இல்லை',
    noDataBody: 'இதுவரை எந்த எண்ணும் வரவில்லை. கடையில் எந்தப் பிரச்சனையும் இல்லை — இந்த ஆப்-க்கு தகவல் தரப்படவில்லை. ஒத்திசைவு ஆனவுடன் நிரம்பும்.',
    cannotDecideNoData: 'இந்தக் கிளையிலிருந்து இதுவரை எந்தத் தகவலும் வரவில்லை. எனவே முடிவெடுக்க எந்த அடிப்படையும் இல்லை. இதை ஒப்புக்கொண்டு தொடர முடியாது.',
    sampleData: 'மாதிரி எண்கள் — இது உங்கள் கடை அல்ல.',
    queuedOne: 'முடிவு அனுப்பக் காத்திருக்கிறது', queuedMany: 'முடிவுகள் அனுப்பக் காத்திருக்கின்றன',
    changedSince: 'நீங்கள் முடிவு செய்த பிறகு இது மாறிவிட்டது', withdrawnSince: 'இது இனி யாருக்கும் காத்திருக்கவில்லை',
    youSaid: 'நீங்கள் சொன்னது', itNowSays: 'இப்போது உள்ளது', discard: 'என் பட்டியலிலிருந்து நீக்கு',
    branchNotThere: 'அந்தக் கடை இந்த ஃபோனில் இல்லை.',
    asAt: 'இந்த நேரத்தில்', offline: 'இந்த ஃபோனில் சிக்னல் இல்லை. இங்குள்ள ஒவ்வொரு எண்ணும் கடைசியாகக் கிடைத்தது — மேலே உள்ள நேரத்தைப் பாருங்கள்.',
    notKnownNoData: 'தெரியவில்லை — இந்தக் கடையின் எந்த எண்ணும் இன்னும் இந்த ஃபோனுக்கு வரவில்லை.',
    noBillsYet: 'இன்று இன்னும் பில் இல்லை', noCostToday: 'இன்றைய பில்களுக்குச் செலவு இல்லை',
    leftOut: 'செலவு இல்லாத பில்கள் சேர்க்கப்படவில்லை', refundLine: 'திருப்பித் தந்தது', noCostLine: 'செலவு இல்லை',
    unlisted: 'இந்த எண்ணில் சேர்ந்தவை, ஆனால் கடை கணினி பட்டியலிடாதவை — மேலே உள்ள வரிகள் இதற்குக் கூடாது.',
    nothingReached: 'இந்த ஃபோனுக்கு எதுவும் வரவில்லை', howTheDayGoes: 'இன்றைய நாள் எப்படிப் போகிறது',
    hourTitle: 'இன்று மணி வாரியாகப் பில்கள்', hourHeading: 'மணி', takenHeading: 'வசூல்',
    hourCovers: 'இன்று {branch}, கடை நேரப்படி · பில்களின் தொகை, திருப்பித் தந்ததற்கு முன் · படித்த நேரம் {time}',
    hourEmpty: 'இன்று இன்னும் எந்தப் பில்லும் போடப்படவில்லை, எனவே வரைய எதுவும் இல்லை.',
    daysTitle: 'கடை கணினியில் உள்ள கடைசி நாட்கள்', dayHeading: 'நாள்', todayMark: 'இன்று',
    daysCovers: '{branch} · கடை கணினியில் உள்ள ஒவ்வொரு வணிக நாளும் (7 வரை) · திருப்பித் தந்ததற்கு முன் · படித்த நேரம் {time}',
    daysEmpty: 'கடை கணினியில் இன்னும் எந்த வணிக நாளும் இல்லை, எனவே வரைய எதுவும் இல்லை.',
    tenderTitle: 'இன்று எப்படிப் பணம் வந்தது', tenderHeading: 'செலுத்திய முறை',
    tenderCovers: 'இன்று {branch} · திருப்பித் தந்த பிறகு, "இன்று வசூல்" போலவே · படித்த நேரம் {time}',
    tenderEmpty: 'இன்று இன்னும் எந்தப் பணமும் வரவில்லை, எனவே வரைய எதுவும் இல்லை.',
    notSent: 'கடை கணினி இந்த எண்ணை அனுப்பவில்லை, எனவே வரையப்படவில்லை. எதுவும் ஊகிக்கப்படவில்லை.',
    chartsMissing: 'இந்த ஆப்பின் வரைபடப் பகுதி இந்த ஃபோனில் இல்லை, எனவே போக்கு வரையப்படவில்லை. மேலே உள்ள எண்கள் பாதிக்கப்படவில்லை.',
    compareTitle: 'கிளைகள் அருகருகே', compareNote: 'ஒவ்வொரு கடையின் சொந்த எண்களும் அதன் சொந்தத் தகவல் வயதும் — ஒரு கடை ஒத்திசைந்தால் மற்றவை புதியவை ஆகாது.',
    cTaken: 'இன்று வசூல்', cBills: 'பில்கள்', cMargin: 'லாபம்', cWaiting: 'உங்களுக்காகக் காத்திருப்பவை', cAttention: 'கவனம் தேவை', cAge: 'தகவல்',
    notKnownShort: 'தெரியவில்லை', marginNoCost: 'பில்களுக்குச் செலவு இல்லை',
    officeTitle: 'அலுவலகத்திலும்', officeNote: 'இவை அலுவலகத்தின் சொந்தப் பக்கங்களைத் திறக்கும். இந்த ஃபோனுக்கு எதுவும் நகலெடுக்கப்படவில்லை.',
    officeAudit: 'தணிக்கைப் பதிவு — யார் என்ன செய்தார்', officeHealth: 'கடை கணினிகள் — அமைப்பு நிலை', officeCompare: 'அருகருகே ஒப்பிடு — முழு அறிக்கை',
    officeNotServed: 'அலுவலக இணைப்புகள் இந்த ஆப் நகலில் இல்லை.',
  },
};
let lang = 'en';
const t = (key) => WORDS[lang][key] ?? WORDS.en[key];
// U3 (OB-699): the brief's sentence frames are the product's own words — the model composes them in both languages; the
// phone shows the reader's. A finding's own words inside them are not translated.
const said = (en, ta) => (lang === 'ta' && typeof ta === 'string' && ta !== '' ? ta : en);

/**
 * Words for every refusal the model can return — one entry per `OWNER_DECIDE_REFUSALS`.
 *
 * A guardrail walks the model's list against this map in both languages. An owner reading
 * `stale_data_not_acknowledged` off a phone taps the button again, harder.
 */
const REFUSAL_WORDS = {
  request_not_found: { en: 'That is no longer waiting for you. Somebody else may have decided it.', ta: 'அது இனி உங்களுக்காகக் காத்திருக்கவில்லை. வேறு ஒருவர் முடிவு செய்திருக்கலாம்.' },
  unknown_reason_code: { en: 'That reason cannot be used for this decision.', ta: 'இந்த முடிவுக்கு அந்தக் காரணத்தைப் பயன்படுத்த முடியாது.' },
  stale_data_not_acknowledged: { en: 'These numbers are not live. Read the warning on the panel before deciding.', ta: 'இந்த எண்கள் நேரலை அல்ல. முடிவெடுப்பதற்கு முன் பேனலில் உள்ள எச்சரிக்கையைப் படிக்கவும்.' },
  no_data_at_all: { en: 'Nothing has ever synced from this branch, so there is nothing to decide on.', ta: 'இந்தக் கிளையிலிருந்து இதுவரை எதுவும் வரவில்லை. எனவே முடிவெடுக்க எதுவும் இல்லை.' },
  self_approval_forbidden: { en: 'You asked for this yourself, so somebody else has to decide it.', ta: 'இதை நீங்களே கேட்டீர்கள். எனவே வேறு ஒருவர் முடிவு செய்ய வேண்டும்.' },
  reason_required: { en: 'A reason has to be recorded with every decision.', ta: 'ஒவ்வொரு முடிவுக்கும் ஒரு காரணம் பதிவு செய்யப்பட வேண்டும்.' },
  out_of_scope: { en: 'This shop is not yours to decide for.', ta: 'இந்தக் கடைக்கு நீங்கள் முடிவு செய்ய முடியாது.' },
  exceeds_authority: { en: 'This is above your own approval limit.', ta: 'இது உங்கள் ஒப்புதல் வரம்பைத் தாண்டியது.' },
  // OB-521 (R8-A): the gate's own words (with the version) are shown when it has them; these are the fallback.
  app_version_too_old: { en: 'This app is too old or was withdrawn. Update it before making a new decision — the decisions already made are kept.', ta: 'இந்தச் செயலி மிகப் பழையது அல்லது திரும்பப் பெறப்பட்டது. புதிய முடிவு எடுப்பதற்கு முன் புதுப்பிக்கவும் — ஏற்கனவே எடுத்த முடிவுகள் வைக்கப்பட்டுள்ளன.' },
};

/** Words for each reason code the model offers. Guarded against the model's own catalogue. */
const REASON_WORDS = {
  within_policy: { en: 'It is within policy', ta: 'இது கொள்கைக்கு உட்பட்டது' },
  checked_with_supplier: { en: 'I checked with the supplier', ta: 'சப்ளையரிடம் சரிபார்த்தேன்' },
  checked_the_stock: { en: 'I checked the stock myself', ta: 'இருப்பை நானே சரிபார்த்தேன்' },
  owner_instructed: { en: 'I have decided this', ta: 'இதை நான் முடிவு செய்துவிட்டேன்' },
  price_looks_wrong: { en: 'The price looks wrong', ta: 'விலை தவறாகத் தெரிகிறது' },
  not_enough_evidence: { en: 'Not enough proof', ta: 'போதுமான ஆதாரம் இல்லை' },
  against_policy: { en: 'Against policy', ta: 'கொள்கைக்கு எதிரானது' },
  ask_the_owner_first: { en: 'Ask me again with more detail', ta: 'மேலும் விவரத்துடன் மீண்டும் கேளுங்கள்' },
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

/** The four figures on the brief, and which model KPI each reads. */
// Round 4 (P-08): sales and bills are EVERY bill's (`takings`) — a bill the store computer cannot cost still took money;
// the margin says "not known" when no bill today could be costed.
// UI-3: each tile gives its figure AND, where one is missing, why — `null` is drawn as "Not known", never as a nought (P-08).
// No figure is worked out here: each is the model's own, only chosen between and written in rupees.
const KPI_TILES = [
  { kpi: 'grossSales', label: 'sales', cls: 'lead', from: (k, tk) => ({ value: inr(tk ? tk.takenMinor : k.grossSalesMinor) }) },
  { kpi: 'margin', label: 'margin', cls: '', from: (k, tk) => (tk && tk.marginUnknownBills > 0 && k.basketCount === 0
    ? { value: null, why: t('noCostToday') }
    : { value: inr(k.marginMinor), why: tk && tk.marginUnknownBills > 0 ? `${tk.marginUnknownBills} ${t('leftOut')}` : '' }) },
  { kpi: 'baskets', label: 'bills', cls: '', from: (k, tk) => ({ value: String(tk ? tk.bills : k.basketCount) }) },
  // OB-640 (owner, 1 Nov 2026): the takings ÷ EVERY bill, as the model works it out; an average of no bills is not known.
  { kpi: 'averageBasket', label: 'averageBasket', cls: 'basket', from: (k, tk) => (tk === undefined
    ? (k.basketCount === 0 ? { value: null, why: t('noBillsYet') } : { value: inr(k.avgBasketMinor) })
    : tk.averageBasketMinor === null ? { value: null, why: t('noBillsYet') } : { value: inr(tk.averageBasketMinor) }) },
];

const words = (map, key) => (map[key]?.[lang] ?? map[key]?.en ?? String(key).replace(/_/g, ' '));

/**
 * Sample figures with the same surface as the bundled `OwnerSession`, so the layout is runnable
 * and reviewable before real data arrives.
 *
 * It deliberately shows **stale** data with an approval waiting, because that is the path worth
 * rehearsing: a demo on live numbers would never show the warning that this screen exists to put
 * in front of a decision. Whenever this stand-in is in use the header says so.
 */
function sampleSession() {
  const approvals = [
    { id: 'a1', subjectType: 'purchase_order', subjectRef: 'PO-9912 · Rice, 200 bags', requestedBy: 'Karthik (buying)', valueMinor: 812_000_00 },
    { id: 'a2', subjectType: 'price_change', subjectRef: 'Toor dal 1kg', requestedBy: 'Karthik (buying)', valueMinor: 45_000 },
  ];
  const sales = [
    { saleId: 'S-1041', contributesMinor: 295_00, tender: 'upi', units: 7 },
    { saleId: 'S-1039', contributesMinor: 118_00, tender: 'cash', units: 3 },
    { saleId: 'S-1044', contributesMinor: 59_00, tender: 'card', units: 2 },
  ];
  const gross = sales.reduce((sum, s) => sum + s.contributesMinor, 0);
  const decided = new Set();
  return {
    branches: () => [{
      branchId: 'b1', name: 'SRE Hyper Market',
      freshness: { state: 'stale', ageSeconds: 39_600, lastSyncedAt: null, asOf: '' },
    }],
    currentBranchId: () => 'b1',
    viewBranch: () => true,
    brief: () => ({
      asOf: '',
      kpis: { grossSalesMinor: gross, marginMinor: 148_00, basketCount: sales.length, avgBasketMinor: Math.round(gross / sales.length) },
      freshness: { state: 'stale', ageSeconds: 39_600, lastSyncedAt: null, asOf: '' },
      headline: '3 bills today, ₹472.00 taken, margin ₹148.00 (31.4%). These numbers are NOT live — the branch has not synced recently.',
      attention: [{ rank: 1, source: 'approval', sentence: 'Approval waiting: purchase order from Karthik for ₹8,12,000.00.', ref: 'a1' }],
      alerts: [{ kind: 'void', severity: 'escalate', count: 9, totalValueMinor: 0, linkedTxnIds: ['t-1', 't-2', 't-3'], sentence: 'Urgent: voided bills over the limit — 3 transactions.' }],
      approvals: approvals.filter((a) => !decided.has(a.id)),
    }),
    drill: (kpi) => ({ kpi, lines: sales, totalMinor: gross, countIsTheAnswer: kpi === 'baskets' }),
    trends: () => ({ byHour: null, recentDays: null }),
    decide: ({ requestId, acknowledgeStale }) => {
      if (acknowledgeStale !== true) return { ok: false, refusal: 'stale_data_not_acknowledged' };
      decided.add(requestId);
      return { ok: true, decision: { request: { id: requestId } }, queuedCount: decided.size };
    },
    queued: () => [...decided].map((id) => ({ request: { id } })),
    reconcileQueued: () => ({ stillValid: [], needsAnotherLook: [] }),
    discardQueued: () => true,
  };
}

const real = window.ownerSession;
const session = real ?? sampleSession();
const REASONS = window.ownerReasons ?? {
  approved: ['within_policy', 'checked_with_supplier', 'checked_the_stock', 'owner_instructed'],
  rejected: ['price_looks_wrong', 'not_enough_evidence', 'against_policy', 'ask_the_owner_first'],
};

// ── The banner ──────────────────────────────────────────────────────────────

/** Say something the owner must read, and keep saying it. No timer — same rule as the till. */
function tell(title, message, good = false) {
  el('banner-title').textContent = title;
  el('banner-text').textContent = message;
  el('banner').classList.toggle('good', good === true);
  el('banner').hidden = false;
  el('banner-ok').textContent = t('ok');
  el('banner-ok').focus();
}
el('banner-ok').addEventListener('click', () => { el('banner').hidden = true; });

// ── How old, in words ───────────────────────────────────────────────────────

/**
 * The age of the data as a person would say it.
 *
 * A phone showing "39600s" is a phone whose freshness indicator nobody reads, and an unread
 * freshness indicator is the same as not having one.
 */
function ageInWords(seconds) {
  if (seconds === null || seconds === undefined) return '';
  if (seconds < 60) return t('justNow');
  if (seconds < 3600) return `${Math.round(seconds / 60)} ${t('minutesAgo')}`;
  return `${Math.round(seconds / 360) / 10} ${t('hoursAgo')}`;
}

function renderFreshness(freshness) {
  const dot = el('fresh-dot');
  const text = el('fresh-text');
  dot.className = 'dot ' + (freshness.state === 'fresh' ? '' : freshness.state);
  // Words as well as a colour, and the state in the class so the words carry weight too.
  text.className = freshness.state === 'fresh' ? '' : freshness.state;
  text.textContent = freshness.state === 'missing'
    ? t('neverSynced')
    : `${freshness.state === 'stale' ? t('notLive') : t('live')} ${ageInWords(freshness.ageSeconds)}`;
  // UI-3 (P-08): the moment the figures are from, at the shop's clock — "2 hours ago" alone is unreadable an hour later.
  const when = freshness.lastSyncedAt ? shopWhen(freshness.lastSyncedAt) : '';
  el('asof').textContent = when === '' ? '' : `· ${t('asAt')} ${when}`;
}

// ── No signal on this phone (UI-3 · P-01 · P-08) ────────────────────────────
// The phone itself says whether it has a network. Without one, nothing here can be newer than the time in the header,
// and the strip says so in words — the dot alone is colour.
function paintOffline() {
  const strip = el('offline');
  strip.hidden = navigator.onLine !== false;
  strip.textContent = t('offline');
}
window.addEventListener('online', paintOffline);
window.addEventListener('offline', paintOffline);

// ── The trend (UI-3): three simple charts from the one chart code, each saying what it covers and when it was read ──

const TENDER_WORDS = {
  cash: { en: 'Cash', ta: 'ரொக்கம்' }, card: { en: 'Card', ta: 'அட்டை' }, upi: { en: 'UPI', ta: 'UPI' },
  store_credit: { en: 'Store credit', ta: 'கடைக் கடன்' }, exchange_credit: { en: 'Exchange credit', ta: 'மாற்றுக் கடன்' },
  loyalty_points: { en: 'Loyalty points', ta: 'விசுவாசப் புள்ளிகள்' }, paid_on_old_erp: { en: 'Paid on the old system', ta: 'பழைய அமைப்பில் செலுத்தியது' },
  split: { en: 'Split', ta: 'பிரித்தது' }, tender_difference: { en: 'Not matched to a payment', ta: 'பணத்துடன் பொருந்தாதது' },
};
const fillIn = (text, values) => Object.entries(values).reduce((w, [k, v]) => w.split(`{${k}}`).join(String(v)), text);

function chartOrSay(host, spec, notSent) {
  host.replaceChildren();
  if (notSent || window.sreCharts === undefined) {
    const p = document.createElement('p');
    p.className = 'empty unknown';
    const head = document.createElement('strong');
    head.textContent = spec.title;
    p.append(head, document.createElement('br'), document.createTextNode(notSent ? t('notSent') : t('chartsMissing')));
    host.append(p);
    return;
  }
  window.sreCharts.draw(host, spec, lang);
}

function renderTrends(brief) {
  const trends = typeof session.trends === 'function' ? session.trends() : { byHour: null, recentDays: null };
  const branch = session.branches().find((b) => b.branchId === session.currentBranchId())?.name ?? '';
  const time = brief.freshness.lastSyncedAt ? shopWhen(brief.freshness.lastSyncedAt) : t('neverSynced');
  const covers = (key) => fillIn(t(key), { branch, time });
  const missing = brief.freshness.state === 'missing';
  // W4 (P-02): "today" is the trading day the store computer counted these figures for — its own rule, the same day head
  // office's dashboard counts — never a date worked out again here (past a day end after midnight that names the wrong day).
  const today = trends.today ?? '';
  chartOrSay(el('chart-hour'), {
    id: 'hour', kind: 'columns', title: t('hourTitle'), covers: covers('hourCovers'), labelHeading: t('hourHeading'), valueHeading: t('takenHeading'),
    empty: t('hourEmpty'),
    rows: (trends.byHour ?? []).map((h) => ({ key: h.hour, label: `${h.hour}:00`, value: h.takenMinor, text: `${inr(h.takenMinor)} · ${h.bills} ${t('bills').toLowerCase()}` })),
  }, missing || trends.byHour === null);
  chartOrSay(el('chart-days'), {
    id: 'days', kind: 'columns', title: t('daysTitle'), covers: covers('daysCovers'), labelHeading: t('dayHeading'), valueHeading: t('takenHeading'),
    empty: t('daysEmpty'),
    rows: (trends.recentDays ?? []).map((d) => ({
      key: d.tradingDay, label: `${d.tradingDay.slice(8, 10)}/${d.tradingDay.slice(5, 7)}`, value: d.takenMinor,
      text: `${inr(d.takenMinor)} · ${d.bills} ${t('bills').toLowerCase()}`, ...(d.tradingDay === today ? { mark: t('todayMark') } : {}),
    })),
  }, missing || trends.recentDays === null);
  const mix = Object.entries(brief.takings?.tenderMix ?? {}).sort((a, b) => b[1] - a[1]);
  chartOrSay(el('chart-tender'), {
    id: 'tender', kind: 'bars', title: t('tenderTitle'), covers: covers('tenderCovers'), labelHeading: t('tenderHeading'), valueHeading: t('takenHeading'),
    empty: t('tenderEmpty'),
    rows: mix.map(([kind, minor]) => ({ key: kind, label: words(TENDER_WORDS, kind), value: minor, text: minor < 0 ? `−${inr(-minor)}` : inr(minor) })),
  }, missing || brief.takings === undefined);
}

// ── Rendering ───────────────────────────────────────────────────────────────

function renderBranches() {
  const branches = session.branches();
  // One shop is not a choice, so the switcher is not shown for one shop.
  el('branches').hidden = branches.length < 2;
  el('branches').replaceChildren(...branches.map((branch) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = branch.name;
    const age = document.createElement('span');
    age.className = 'age';
    // Each shop carries its own freshness. One branch syncing does not make the others current.
    age.textContent = branch.freshness.state === 'missing'
      ? t('neverSynced')
      : ageInWords(branch.freshness.ageSeconds);
    button.appendChild(age);
    button.setAttribute('aria-current', branch.branchId === session.currentBranchId() ? 'page' : 'false');
    button.addEventListener('click', () => {
      if (!session.viewBranch(branch.branchId)) { tell(t('read'), t('branchNotThere')); return; }
      render();
    });
    return button;
  }));
}

/**
 * UI-3 · U0 (P-08): an empty list is good news only on live data. On a phone that has never been told anything, or whose
 * data is stale, "nothing needs you" is a guess — the list says "not known" and how old the last word was.
 */
function emptyLine(words, freshness) {
  const none = document.createElement('p');
  none.className = freshness.state === 'fresh' ? 'empty' : 'empty unknown';
  none.textContent = freshness.state === 'missing' ? t('notKnownNoData')
    : freshness.state === 'stale' ? `${t('notKnownStale')} ${ageInWords(freshness.ageSeconds)}.`
    : words;
  return none;
}
const countOf = (list, freshness) => (freshness.state === 'missing' ? '' : `(${list.length})`);

function renderAttention(items, freshness) {
  const host = el('attention');
  el('attention-count').textContent = countOf(items, freshness);
  if (items.length === 0) {
    const none = emptyLine(t('nothingToDecide'), freshness);
    host.replaceChildren(none);
    return;
  }
  host.replaceChildren(...items.map((item) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'card' + (item.source === 'approval' ? ' approval' : item.sentence.startsWith('Urgent') ? ' urgent' : '');
    const rank = document.createElement('span');
    rank.className = 'rank';
    rank.textContent = `#${item.rank} · ${item.source === 'approval' ? t('approval') : t('exception')}`;
    const body = document.createElement('span');
    body.textContent = said(item.sentence, item.sentenceTa);
    card.append(rank, body);
    // Tapping goes to the thing itself. The old version opened a system dialog with a raw id in
    // it, which is a dead end wearing the clothes of an action.
    card.addEventListener('click', () => {
      if (item.source === 'approval') {
        const request = session.brief().approvals.find((a) => a.id === item.ref);
        if (request) openDecide(request);
        return;
      }
      const alert = session.brief().alerts.find((a) => `${a.kind}:${a.severity}` === item.ref);
      if (alert) showAlert(alert);
    });
    return card;
  }));
}

function renderKpis(kpis, takings, freshness) {
  el('kpis').replaceChildren(...KPI_TILES.map((tile) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `kpi ${tile.cls}`.trim();
    button.dataset.kpi = tile.kpi;
    // Nothing has ever reached this phone from the shop: every figure is not known, never a row of noughts (P-08).
    const shown = freshness.state === 'missing' ? { value: null, why: t('nothingReached') } : tile.from(kpis, takings);
    for (const [cls, text] of [['label', t(tile.label)], [shown.value === null ? 'value unknown' : 'value', shown.value ?? t('marginNotKnown')], ['why', shown.why ?? ''], ['more', t('tapToSee')]]) {
      if (cls === 'why' && text === '') continue;
      const part = document.createElement('div');
      part.className = cls;
      part.textContent = text;
      button.appendChild(part);
    }
    // Every figure drills to its source in one tap (M29-FR-02, QG-02 budget of ≤3).
    button.addEventListener('click', () => openDrill(tile.kpi, t(tile.label)));
    return button;
  }));
}

function renderAlerts(alerts, freshness) {
  const host = el('alerts');
  el('alerts-count').textContent = countOf(alerts, freshness);
  if (alerts.length === 0) {
    const none = emptyLine(t('noAlerts'), freshness);
    host.replaceChildren(none);
    return;
  }
  host.replaceChildren(...alerts.map((alert) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'alert';
    const line = document.createElement('span');
    line.textContent = said(alert.sentence, alert.sentenceTa);
    const drill = document.createElement('span');
    drill.className = 'drill';
    drill.textContent = `${alert.linkedTxnIds.length} ${t('transactions')}`;
    row.append(line, drill);
    row.addEventListener('click', () => showAlert(alert));
    return row;
  }));
}

function showAlert(alert) {
  // The transactions behind the alert, in the panel rather than a system dialog.
  el('drill-title').textContent = said(alert.sentence, alert.sentenceTa);
  el('drill-total-label').textContent = t('transactions');
  el('drill-total').textContent = String(alert.linkedTxnIds.length);
  el('drill-note').textContent = '';
  el('drill-lines').replaceChildren(...alert.linkedTxnIds.map((txnId) => {
    const row = document.createElement('div');
    row.className = 'drill-line';
    const id = document.createElement('span');
    id.textContent = txnId;
    row.append(id);
    return row;
  }));
  el('drill-close').textContent = t('close');
  el('drill').hidden = false;
}

function renderApprovals(approvals, freshness) {
  const host = el('approvals');
  el('approvals-count').textContent = countOf(approvals, freshness);
  if (approvals.length === 0) {
    const none = emptyLine(t('nothingWaiting'), freshness);
    host.replaceChildren(none);
    return;
  }
  host.replaceChildren(...approvals.map((request) => {
    const box = document.createElement('div');
    box.className = 'row';

    const what = document.createElement('div');
    what.className = 'what';
    what.textContent = `${words(SUBJECT_WORDS, request.subjectType)} · ${request.subjectRef}`;

    const value = document.createElement('div');
    value.className = 'value';
    value.textContent = request.valueMinor === null ? t('noValue') : inr(request.valueMinor);

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${t('askedBy')} ${request.requestedBy}`;

    const actions = document.createElement('div');
    actions.className = 'row-actions';
    for (const [decision, label, cls] of [
      ['approved', t('approve'), 'primary'], ['rejected', t('reject'), 'danger'],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = cls;
      button.textContent = label;
      button.addEventListener('click', () => openDecide(request, decision));
      actions.appendChild(button);
    }

    box.append(what, value, meta, actions);
    return box;
  }));
}

function renderQueued() {
  const queued = session.queued();
  el('queued-section').hidden = queued.length === 0;
  el('queued').textContent =
    `${queued.length} ${queued.length === 1 ? t('queuedOne') : t('queuedMany')}. ${t('willSend')}`;
}

/**
 * Decisions that went out of date while they waited (§31.1).
 *
 * Above everything else on the screen, because a ₹40,000 approval that quietly applied to a
 * ₹90,000 request is the exact failure a maker-checker exists to prevent. They are never sent and
 * never dropped on their own — the owner looks again.
 */
function renderRecheck() {
  const { needsAnotherLook } = session.reconcileQueued();
  el('recheck-section').hidden = needsAnotherLook.length === 0;
  el('recheck').replaceChildren(...needsAnotherLook.map((item) => {
    const box = document.createElement('div');
    box.className = 'row recheck';

    const why = document.createElement('div');
    why.className = 'why';
    why.textContent = item.reason === 'request_changed' ? t('changedSince') : t('withdrawnSince');

    const said = document.createElement('div');
    said.className = 'what';
    said.textContent = `${t('youSaid')}: ${item.decision.request.status === 'approved' ? t('approve') : t('reject')}`;

    box.append(why, said);

    if (item.nowIs !== null) {
      const nowIs = document.createElement('div');
      nowIs.className = 'meta';
      nowIs.textContent = `${t('itNowSays')}: ${words(SUBJECT_WORDS, item.nowIs.subjectType)} · ${item.nowIs.subjectRef} · ${item.nowIs.valueMinor === null ? t('noValue') : inr(item.nowIs.valueMinor)}`;
      box.append(nowIs);
    }

    const discard = document.createElement('button');
    discard.type = 'button';
    discard.className = 'wide';
    discard.textContent = t('discard');
    // Only ever after it has been shown. Removing it before that is the silent drop.
    discard.addEventListener('click', () => { session.discardQueued(item.decision.request.id); render(); });
    box.append(discard);
    return box;
  }));
}

// ── Deciding ────────────────────────────────────────────────────────────────

/**
 * Open the decision panel.
 *
 * **The staleness warning lives in here**, next to the reasons, so the age of the data is in front
 * of the owner at the moment of the decision rather than in a badge they scrolled past on the way
 * down. Tapping a reason with that warning showing IS the acknowledgement, and the model records
 * that it happened.
 */
function openDecide(request, decision = 'approved') {
  const freshness = session.brief().freshness;
  el('decide-title').textContent = decision === 'approved' ? t('whyApprove') : t('whyReject');
  el('decide-what').textContent =
    `${words(SUBJECT_WORDS, request.subjectType)} · ${request.subjectRef} · ` +
    `${request.valueMinor === null ? t('noValue') : inr(request.valueMinor)}`;

  const stale = freshness.state === 'stale';
  el('decide-stale').hidden = freshness.state === 'fresh';
  el('decide-stale').textContent = freshness.state === 'missing'
    ? t('cannotDecideNoData')
    : `${t('notLive')} ${ageInWords(freshness.ageSeconds)}. ${t('staleWarning')}`;

  const codes = decision === 'approved' ? REASONS.approved : REASONS.rejected;
  el('decide-reasons').replaceChildren(...(freshness.state === 'missing' ? [] : codes.map((code) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = words(REASON_WORDS, code);
    button.addEventListener('click', () => {
      el('decide').hidden = true;
      submit(request, decision, code, stale);
    });
    return button;
  })));

  el('decide-cancel').textContent = t('cancel');
  el('decide').hidden = false;
}
el('decide-cancel').addEventListener('click', () => { el('decide').hidden = true; });

function submit(request, decision, reasonCode, acknowledgeStale) {
  const outcome = session.decide({ requestId: request.id, decision, reasonCode, acknowledgeStale });
  if (outcome.ok) {
    tell(t('decided'), `${words(SUBJECT_WORDS, request.subjectType)} · ${request.subjectRef}. ${t('willSend')}`, true);
  } else {
    // The refusal names a rule, so it is shown in words. A screen that quietly did nothing would
    // have the owner tapping the same button harder.
    const gateSaid = outcome.refusal === 'app_version_too_old' ? window.ownerVersion?.refusal() : undefined;
    tell(t('read'), gateSaid ? (lang === 'ta' ? gateSaid.ta : gateSaid.en) : words(REFUSAL_WORDS, outcome.refusal));
  }
  render();
}

// ── Drilling ────────────────────────────────────────────────────────────────

/**
 * Every sale behind a figure — all of them, never a sample.
 *
 * A drill-through that shows a selection is how a figure and its evidence come to disagree, and
 * the disagreement is only ever found by the person being asked to act on it.
 */
function openDrill(kpi, label) {
  const drill = session.drill(kpi);
  el('drill-title').textContent = label;
  el('drill-total-label').textContent = drill.countIsTheAnswer ? t('bills') : t('total');
  el('drill-total').textContent = drill.countIsTheAnswer ? String(drill.lines.length) : inr(drill.totalMinor);
  el('drill-note').textContent = (drill.countIsTheAnswer ? t('countIsAnswer') : t('drillNote'))
    + (drill.unlisted > 0 ? ` ${drill.unlisted} ${t('unlisted')}` : '');
  el('drill-lines').replaceChildren(...drill.lines.map((line) => {
    const row = document.createElement('div');
    row.className = 'drill-line';
    const id = document.createElement('span');
    // OB-640: a bill with no cost and a refund are named as such — a refund takes its amount off the total.
    const what = line.kind === 'refund' ? ` · ${t('refundLine')}` : line.kind === 'uncosted_bill' ? ` · ${t('noCostLine')}` : '';
    id.textContent = `${line.saleId} · ${line.tender}${what}`;
    const amount = document.createElement('span');
    amount.textContent = line.contributesMinor < 0 ? `−${inr(-line.contributesMinor)}` : inr(line.contributesMinor);
    row.append(id, amount);
    return row;
  }));
  el('drill-close').textContent = t('close');
  el('drill').hidden = false;
}
el('drill-close').addEventListener('click', () => { el('drill').hidden = true; });

// ── Paint ───────────────────────────────────────────────────────────────────

function paintChrome() {
  el('title').textContent = t('appTitle');
  el('attention-title').textContent = t('needsAttention');
  el('kpis-title').textContent = t('todaysNumbers');
  el('approvals-title').textContent = t('waitingForYou');
  el('alerts-title').textContent = t('alerts');
  el('recheck-title').textContent = t('lookAgain');
  el('queued-title').textContent = t('decidedNotSent');
  el('trends-title').textContent = t('howTheDayGoes');
  el('compare-title').textContent = t('compareTitle');
  el('office-title').textContent = t('officeTitle');
  el('sample').textContent = t('sampleData');
  paintOffline();
}

/**
 * U6 · M29-FR-02: the branches SIDE BY SIDE — one card per shop with the same four figures and its own data age, from the
 * session's own comparison (nothing worked out here). Shown only for two shops or more; a shop that never reached this
 * phone says "Not known" on every figure, never a nought (P-08). The branch in view is not changed by reading it.
 */
function renderCompare() {
  const rows = typeof session.compare === 'function' ? session.compare() : [];
  el('compare-section').hidden = rows.length < 2;
  if (rows.length < 2) return;
  el('compare-note').textContent = t('compareNote');
  const figure = (value, words) => (value === null ? t('notKnownShort') : words(value));
  el('compare').replaceChildren(...rows.map((r) => {
    const card = document.createElement('div');
    card.className = `cmp ${r.freshness.state}`;
    card.dataset.branch = r.branchId;
    const head = document.createElement('div');
    head.className = 'cmp-name';
    head.textContent = r.name;
    const age = document.createElement('div');
    age.className = `cmp-age ${r.freshness.state}`;
    age.textContent = `${t('cAge')}: ${r.freshness.state === 'missing' ? t('neverSynced') : ageInWords(r.freshness.ageSeconds)}`;
    const grid = document.createElement('dl');
    grid.className = 'cmp-grid';
    const cells = [
      [t('cTaken'), figure(r.takenMinor, inr)],
      [t('cBills'), figure(r.bills, String)],
      [t('cMargin'), r.marginKnown ? inr(r.marginMinor) : r.freshness.state === 'missing' ? t('notKnownShort') : `${t('notKnownShort')} — ${t('marginNoCost')}`],
      [t('cWaiting'), figure(r.approvalsWaiting, String)],
      [t('cAttention'), figure(r.attentionCount, String)],
    ];
    for (const [label, value] of cells) {
      const dt = document.createElement('dt'); dt.textContent = label;
      const dd = document.createElement('dd'); dd.textContent = value;
      if (value.startsWith(t('notKnownShort'))) dd.className = 'unknown';
      grid.append(dt, dd);
    }
    card.append(head, age, grid);
    return card;
  }));
}

/**
 * U6 · OB-701 (owner, 7 Nov 2026, decision 4 = B): the audit trail and system health stay OFFICE pages; this phone links to
 * them (and to the full compare report). The links come from the store computer with the public prefix; served from a
 * file there are none, and the section says so rather than guessing a path.
 */
function renderOffice() {
  const links = window.ownerOffice;
  el('office-note').textContent = links ? t('officeNote') : t('officeNotServed');
  const host = el('office-links');
  host.replaceChildren();
  if (!links) return;
  for (const [key, href] of [['officeAudit', links.auditLog], ['officeHealth', links.storeComputers], ['officeCompare', links.compare]]) {
    if (typeof href !== 'string' || href === '') continue;
    const a = document.createElement('a');
    a.className = 'office-link';
    a.href = href;
    a.textContent = t(key);
    host.append(a);
  }
}

function render() {
  const brief = session.brief();
  el('headline').textContent = said(brief.headline, brief.headlineTa);
  renderFreshness(brief.freshness);
  renderBranches();
  renderCompare();
  renderOffice();
  renderRecheck();
  renderKpis(brief.kpis, brief.takings, brief.freshness);
  renderAttention(brief.attention, brief.freshness);
  renderApprovals(brief.approvals, brief.freshness);
  renderAlerts(brief.alerts, brief.freshness);
  renderTrends(brief);
  renderQueued();
}

el('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  paintChrome();
  render();
});

// Sample figures must announce themselves.
el('sample').hidden = real !== undefined;

// A decision the phone could not save is said out loud, not swallowed (P-08).
const queueProblem = window.ownerQueueProblem;
el('queue-problem').hidden = !queueProblem;
if (queueProblem) el('queue-problem').textContent = queueProblem;

paintChrome();

if (real === undefined && window.ownerData !== undefined) {
  // The bundle is there, data arrived, and still no session — the payload carried no branches.
  // Say so plainly rather than rendering a screen of zeros that reads as a quiet day.
  el('headline').textContent = `${t('noDataTitle')} — ${t('noDataBody')}`;
} else {
  render();
}

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
  // OB-607: the SHOP's clock (the zone the store computer served), never this device's own — a phone or laptop set to
  // another zone read the shop's 01:00 as its own evening.
  strip.textContent = `${t('staleShell')} ${shopWhen(at)}`;
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
