// Migration — the view layer. Every rule lives in the TESTED session model
// (`apps/web-erp/src/migration-session.ts`), attached as `window.migrationSession`.
//
// ── The decision this screen is built around ────────────────────────────────
//
// **A check nothing could answer is drawn differently from a check that came back bad.** Both
// stop the switch-over, and both must — but a failed check is work somebody has to finish, and an
// unanswerable one is a producer that was never connected. Drawing them the same colour sends the
// owner to the wrong person, and on the night that costs the whole evening.
//
// ── And the two that follow ─────────────────────────────────────────────────
//
// **Nothing is ticked by hand.** The eight checks are derived, and every one of them shows the
// sentence its answer came from — in the producer's own words, not the screen's.
//
// **The rollback button is always on the page.** It is not behind a state, a checklist or an
// approval: a rollback that needs an approval chain gets performed an hour late, and the hour is
// the whole cost. It is the only button on this screen that never refuses for lack of readiness.
//
// No `prompt`, `confirm` or `alert`; the banner does not fade.

const el = (id) => document.getElementById(id);

const money = (minor) =>
  '₹' + (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── Words ───────────────────────────────────────────────────────────────────

const WORDS = {
  en: {
    staleShell: 'No connection to the store computer. This page is what it was last told, at',
    title: 'Moving from the old system',
    where: 'Can we switch over', figures: 'The figures', data: 'Problems in the old data',
    both: 'Running both', old: 'The old system',
    whereLead: 'Eight checks. Every one of them is worked out from what is actually true — none of them is a box somebody ticks — and each says underneath where its answer came from.',
    figuresLead: 'Every figure appears twice — what the old system says and what came across — with how each side was worked out. Both must agree exactly, and somebody who did not run the load must sign each one.',
    dataLead: 'Everything wrong with the old system’s data, worst first, with the ones nobody has decided about at the top. Nothing here is ever deleted — a decided one stays on the list as the record that somebody looked at it.',
    bothLead: 'Both systems ringing the same sales. Where they disagree, one of them is wrong about your shop, and somebody has to put their name to which. A bad day resets the count — the clean days only count from after the problem was fixed.',
    oldLead: 'Everything the old shop keeps its records in, and anything about it nobody can answer. What is missing here is the point — a migration that starts with gaps migrates whatever somebody happened to remember.',
    go: 'YES — every check has passed', nogo: 'NOT YET',
    tradingEither: 'Whichever way this goes, your shop opens tomorrow and the tills keep selling.',
    passed: 'passed', failed: 'not yet', notKnown: 'NOBODY CAN ANSWER THIS',
    notKnownNote: 'Nothing has told this screen. That is a different problem from a check that came back bad, and it needs a different person to fix it.',
    rollbackTitle: 'Go back to the old system',
    rollbackLead: 'One button. It needs nobody’s approval and it works at any time, including in the middle of the switch-over. Nothing about the migration record is undone.',
    triggerLabel: 'Why are you going back',
    triggerTotals: 'A figure did not add up', triggerTrade: 'The shop cannot sell',
    triggerData: 'The data is wrong', triggerOwner: 'My decision',
    triggerTime: 'We have run out of time tonight',
    rollback: 'Go back to the old system now', rolledBack: 'Gone back to the old system',
    noFigures: 'No figures have been recorded yet. Nothing has been checked, which is not the same as everything agreeing.',
    oldSays: 'the old system says', cameAcross: 'came across', howWorkedOut: 'worked out by',
    signedBy: 'signed by', notSigned: 'NOT SIGNED', agrees: 'agrees exactly',
    doesNotAgree: 'does not agree', explained: 'explained by what we agreed to leave behind',
    signTitle: 'Sign a figure', signTotalLabel: 'Which figure', signRoleLabel: 'Signing as',
    signStatementLabel: 'What you checked', sign: 'Sign it', signed: 'Signed',
    noData: 'Nothing has told this screen what is wrong with the old data. That is not the same as it being clean.',
    nothingWrong: 'Nothing outstanding.', blocking: 'STOPS THE SWITCH-OVER',
    atStake: 'money at stake', decidedBy: 'decided by', undecided: 'nobody has decided about this',
    decideTitle: 'Decide about one', decideIdLabel: 'Which one',
    decideActionLabel: 'What do you want to do',
    actionCorrect: 'Correct it', actionMerge: 'They are the same thing — merge them',
    actionExclude: 'Leave it behind', actionAsIs: 'Bring it across exactly as it is',
    survivorLabel: 'Which record survives the merge',
    decideReasonLabel: 'Why (this is what anybody reads a year from now)',
    decide: 'Record my decision', decided: 'Decision recorded',
    noBoth: 'Both systems have not been run side by side yet.',
    cleanDays: 'clean days in a row', ofRequired: 'needed', openDifferences: 'still unexplained',
    nobodysName: 'with nobody’s name on it', valueAtStake: 'worth',
    noOld: 'Nobody has listed what the old shop keeps its records in yet.',
    sources: 'places records are kept', countedRows: 'rows counted', gaps: 'things nobody can answer',
    retireTitle: 'Switching the old system off',
    retireLead: 'Switching the old system off is not the same act as deleting the old data, and this screen never does the second one.',
    noRetire: 'Nothing has been archived yet, or nobody has said how many open questions could still need the old records. Either way this cannot be decided.',
    neverDeleted: 'The old data is never deleted, whatever else happens.',
    ok: 'OK', read: 'Please read this',
    nobodyNamed: 'This store box has not been told who is using this screen. Nothing can be signed, decided or rolled back — all three carry the name of whoever did them.',
    sampleData: 'Sample data — this is not your shop.',
    unsent: 'decision(s) made here and not yet sent to the store computer — they are saved and will be sent when the connection is back',
  },
  ta: {
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:',
    title: 'பழைய அமைப்பிலிருந்து மாறுதல்',
    where: 'மாற முடியுமா', figures: 'கணக்குகள்', data: 'பழைய தகவலில் உள்ள பிரச்சினைகள்',
    both: 'இரண்டையும் இயக்குதல்', old: 'பழைய அமைப்பு',
    whereLead: 'எட்டு சரிபார்ப்புகள். ஒவ்வொன்றும் உண்மையான நிலையிலிருந்து கணக்கிடப்படுகிறது — எதுவும் யாரோ ஒருவர் டிக் செய்யும் பெட்டி அல்ல — ஒவ்வொன்றின் கீழும் அந்தப் பதில் எங்கிருந்து வந்தது என்று எழுதப்பட்டுள்ளது.',
    figuresLead: 'ஒவ்வொரு கணக்கும் இரண்டு முறை காட்டப்படுகிறது — பழைய அமைப்பு சொல்வதும், இங்கே வந்ததும் — ஒவ்வொரு பக்கமும் எப்படிக் கணக்கிடப்பட்டது என்பதுடன். இரண்டும் சரியாகப் பொருந்த வேண்டும், ஏற்றம் செய்யாத ஒருவர் ஒவ்வொன்றிலும் கையெழுத்திட வேண்டும்.',
    dataLead: 'பழைய அமைப்பின் தகவலில் உள்ள எல்லாப் பிழைகளும், மோசமானவை முதலில், யாரும் முடிவு செய்யாதவை மேலே. இங்கே எதுவும் நீக்கப்படுவதில்லை — முடிவு செய்யப்பட்டதும் பட்டியலில் இருக்கும், யாரோ பார்த்தார்கள் என்பதற்கான ஆதாரமாக.',
    bothLead: 'இரண்டு அமைப்புகளும் ஒரே விற்பனையைப் பதிவு செய்கின்றன. அவை வேறுபடும் இடத்தில் ஒன்று உங்கள் கடையைப் பற்றித் தவறாகச் சொல்கிறது, யாரோ ஒருவர் எது என்று பெயருடன் சொல்ல வேண்டும். ஒரு மோசமான நாள் எண்ணிக்கையை மீட்டமைக்கும் — பிரச்சினை சரிசெய்யப்பட்ட பிறகுதான் நல்ல நாட்கள் கணக்கில் வரும்.',
    oldLead: 'பழைய கடை தன் பதிவுகளை வைத்திருக்கும் எல்லா இடங்களும், அதைப் பற்றி யாரும் பதில் சொல்ல முடியாதவையும். இங்கே இல்லாதவைதான் முக்கியம் — இடைவெளிகளுடன் தொடங்கும் இடம்பெயர்வு, யாரோ நினைவில் வைத்திருந்ததை மட்டுமே கொண்டு வரும்.',
    go: 'ஆம் — எல்லா சரிபார்ப்பும் தேர்ச்சி', nogo: 'இன்னும் இல்லை',
    tradingEither: 'இது எப்படி முடிந்தாலும், நாளை உங்கள் கடை திறக்கும், பில்லிங் தொடரும்.',
    passed: 'தேர்ச்சி', failed: 'இன்னும் இல்லை', notKnown: 'இதற்கு யாரும் பதில் சொல்ல முடியாது',
    notKnownNote: 'இந்தத் திரைக்கு எதுவும் சொல்லப்படவில்லை. இது தோல்வியடைந்த சரிபார்ப்பிலிருந்து வேறுபட்ட பிரச்சினை, இதைச் சரிசெய்ய வேறொருவர் தேவை.',
    rollbackTitle: 'பழைய அமைப்புக்குத் திரும்பு',
    rollbackLead: 'ஒரே பொத்தான். யாருடைய அனுமதியும் தேவையில்லை, எந்த நேரத்திலும் வேலை செய்யும் — மாற்றத்தின் நடுவிலும். இடம்பெயர்வுப் பதிவில் எதுவும் அழிக்கப்படாது.',
    triggerLabel: 'ஏன் திரும்புகிறீர்கள்',
    triggerTotals: 'ஒரு கணக்கு பொருந்தவில்லை', triggerTrade: 'கடையால் விற்க முடியவில்லை',
    triggerData: 'தகவல் தவறாக உள்ளது', triggerOwner: 'என் முடிவு',
    triggerTime: 'இன்றிரவு நேரம் முடிந்துவிட்டது',
    rollback: 'இப்போதே பழைய அமைப்புக்குத் திரும்பு', rolledBack: 'பழைய அமைப்புக்குத் திரும்பியது',
    noFigures: 'இதுவரை எந்தக் கணக்கும் பதிவு செய்யப்படவில்லை. எதுவும் சரிபார்க்கப்படவில்லை — எல்லாம் பொருந்துகிறது என்பது இதன் பொருள் அல்ல.',
    oldSays: 'பழைய அமைப்பு சொல்வது', cameAcross: 'இங்கே வந்தது', howWorkedOut: 'கணக்கிட்ட முறை',
    signedBy: 'கையெழுத்திட்டவர்', notSigned: 'கையெழுத்து இல்லை', agrees: 'சரியாகப் பொருந்துகிறது',
    doesNotAgree: 'பொருந்தவில்லை', explained: 'விட்டுவிட ஒப்புக்கொண்டவற்றால் விளக்கப்பட்டது',
    signTitle: 'ஒரு கணக்கில் கையெழுத்திடு', signTotalLabel: 'எந்தக் கணக்கு', signRoleLabel: 'எந்த முறையில்',
    signStatementLabel: 'நீங்கள் எதைச் சரிபார்த்தீர்கள்', sign: 'கையெழுத்திடு', signed: 'கையெழுத்திடப்பட்டது',
    noData: 'பழைய தகவலில் என்ன தவறு என்று இந்தத் திரைக்குச் சொல்லப்படவில்லை. அது சுத்தமாக இருப்பது என்று பொருள் அல்ல.',
    nothingWrong: 'நிலுவையில் எதுவும் இல்லை.', blocking: 'மாற்றத்தைத் தடுக்கிறது',
    atStake: 'ஆபத்தில் உள்ள பணம்', decidedBy: 'முடிவு செய்தவர்', undecided: 'இதைப் பற்றி யாரும் முடிவு செய்யவில்லை',
    decideTitle: 'ஒன்றைப் பற்றி முடிவு செய்', decideIdLabel: 'எது',
    decideActionLabel: 'என்ன செய்ய வேண்டும்',
    actionCorrect: 'சரிசெய்', actionMerge: 'இவை ஒன்றுதான் — இணைத்துவிடு',
    actionExclude: 'விட்டுவிடு', actionAsIs: 'இருக்கிற நிலையிலேயே கொண்டு வா',
    survivorLabel: 'இணைப்பில் எந்தப் பதிவு தங்கும்',
    decideReasonLabel: 'ஏன் (ஒரு வருடம் கழித்து யாரோ படிப்பது இதுதான்)',
    decide: 'என் முடிவைப் பதிவு செய்', decided: 'முடிவு பதிவு செய்யப்பட்டது',
    noBoth: 'இரண்டு அமைப்புகளும் இன்னும் அருகருகே இயக்கப்படவில்லை.',
    cleanDays: 'தொடர்ச்சியான நல்ல நாட்கள்', ofRequired: 'தேவை', openDifferences: 'இன்னும் விளக்கப்படாதவை',
    nobodysName: 'யாருடைய பெயரும் இல்லாமல்', valueAtStake: 'மதிப்பு',
    noOld: 'பழைய கடை தன் பதிவுகளை எங்கு வைத்திருக்கிறது என்று யாரும் இதுவரை பட்டியலிடவில்லை.',
    sources: 'பதிவுகள் வைக்கப்படும் இடங்கள்', countedRows: 'எண்ணப்பட்ட வரிசைகள்', gaps: 'யாரும் பதில் சொல்ல முடியாதவை',
    retireTitle: 'பழைய அமைப்பை நிறுத்துதல்',
    retireLead: 'பழைய அமைப்பை நிறுத்துவதும் பழைய தகவலை நீக்குவதும் ஒன்றல்ல. இந்தத் திரை இரண்டாவதை ஒருபோதும் செய்யாது.',
    noRetire: 'இதுவரை எதுவும் காப்பகப்படுத்தப்படவில்லை, அல்லது பழைய பதிவுகள் தேவைப்படக்கூடிய திறந்த கேள்விகள் எத்தனை என்று யாரும் சொல்லவில்லை. எப்படியும் இதை முடிவு செய்ய முடியாது.',
    neverDeleted: 'வேறு எது நடந்தாலும், பழைய தகவல் ஒருபோதும் நீக்கப்படாது.',
    ok: 'சரி', read: 'இதைப் படிக்கவும்',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைப் பெட்டிக்குத் தெரியவில்லை. கையெழுத்திடவோ, முடிவு செய்யவோ, திரும்பவோ முடியாது — மூன்றும் செய்தவரின் பெயரைச் சுமக்கும்.',
    sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
    unsent: 'முடிவு(கள்) இங்கே எடுக்கப்பட்டு இன்னும் கடைக் கணினிக்கு அனுப்பப்படவில்லை — அவை சேமிக்கப்பட்டுள்ளன, இணைப்பு திரும்பியதும் அனுப்பப்படும்',
  },
};
let lang = 'en';
const t = (key) => WORDS[lang][key] ?? WORDS.en[key];

/** The eight checks, in the shop's words — one entry per `CutoverCheck`, both languages. */
const CHECK_WORDS = {
  control_totals_signed: {
    en: 'Every figure agrees and somebody has signed it',
    ta: 'ஒவ்வொரு கணக்கும் பொருந்துகிறது, யாரோ கையெழுத்திட்டுள்ளார்',
  },
  rollback_demonstrated: {
    en: 'We have actually gone back to the old system once, as a rehearsal',
    ta: 'ஒத்திகையாக ஒரு முறை உண்மையிலேயே பழைய அமைப்புக்குத் திரும்பியுள்ளோம்',
  },
  parallel_run_sufficient: {
    en: 'Both systems have run side by side long enough, with nothing unexplained',
    ta: 'இரண்டு அமைப்புகளும் போதுமான காலம் அருகருகே இயங்கியுள்ளன, விளக்கப்படாதது எதுவும் இல்லை',
  },
  edge_fully_synced: {
    en: 'The store computer has nothing left waiting to be sent',
    ta: 'கடைக் கணினியில் அனுப்ப நிலுவையில் எதுவும் இல்லை',
  },
  blocking_exceptions_cleared: {
    en: 'Somebody has decided about every serious problem in the old data',
    ta: 'பழைய தகவலில் உள்ள ஒவ்வொரு தீவிரப் பிரச்சினை பற்றியும் யாரோ முடிவு செய்துள்ளார்',
  },
  delta_applied: {
    en: 'Everything the shop did since the last copy has been brought across',
    ta: 'கடைசி நகலுக்குப் பிறகு கடை செய்த அனைத்தும் கொண்டு வரப்பட்டுள்ளன',
  },
  team_named: {
    en: 'The people who will be here on the night are named, with a job each',
    ta: 'அன்றிரவு இருப்பவர்கள் பெயருடன் குறிக்கப்பட்டுள்ளனர், ஒவ்வொருவருக்கும் ஒரு வேலை',
  },
  owner_go: {
    en: 'You have said go',
    ta: 'நீங்கள் சரி என்று சொல்லிவிட்டீர்கள்',
  },
};

/** Why something could not be signed — one entry per `SignRefusal`, both languages. */
const SIGN_REFUSAL_WORDS = {
  nobody_is_named_at_this_desk: {
    en: 'This store computer has not been told who is using this screen. Nothing was signed.',
    ta: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை. எதுவும் கையெழுத்திடப்படவில்லை.',
  },
  nobody_ran_the_load: {
    en: 'Nobody has told this screen who brought the data across, so it cannot check that you are somebody else.',
    ta: 'தகவலை யார் கொண்டு வந்தார் என்று இந்தத் திரைக்குச் சொல்லப்படவில்லை. எனவே நீங்கள் வேறு ஒருவர் என்பதைச் சரிபார்க்க முடியாது.',
  },
  refused: {
    en: 'The rules refused this. Nothing was signed.',
    ta: 'விதிகள் இதை மறுத்தன. எதுவும் கையெழுத்திடப்படவில்லை.',
  },
};

/** Why a decision was not recorded — one entry per `ResolveRefusal`, both languages. */
const RESOLVE_REFUSAL_WORDS = {
  nobody_is_named_at_this_desk: {
    en: 'This store computer has not been told who is using this screen. Nothing was recorded.',
    ta: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை. எதுவும் பதிவு செய்யப்படவில்லை.',
  },
  needs_a_reason: {
    en: 'Write down why. In a year this sentence is the only record that anybody decided.',
    ta: 'ஏன் என்று எழுதுங்கள். ஒரு வருடம் கழித்து யாரோ முடிவு செய்தார்கள் என்பதற்கான ஒரே பதிவு இந்த வாக்கியம்தான்.',
  },
  refused: {
    en: 'The rules refused this. Nothing was recorded.',
    ta: 'விதிகள் இதை மறுத்தன. எதுவும் பதிவு செய்யப்படவில்லை.',
  },
};

/** Why a rollback was not performed — one entry per `RollbackRefusal`, both languages. */
const ROLLBACK_REFUSAL_WORDS = {
  nobody_is_named_at_this_desk: {
    en: 'This store computer has not been told who is using this screen. A rollback carries a name.',
    ta: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை. திரும்புவது ஒரு பெயரைச் சுமக்கும்.',
  },
  needs_a_reason: {
    en: 'Say why you are going back.',
    ta: 'ஏன் திரும்புகிறீர்கள் என்று சொல்லுங்கள்.',
  },
};

/** What is wrong with a record — one entry per `ExceptionKind`, both languages. */
const EXCEPTION_WORDS = {
  duplicate_product: { en: 'the same product twice', ta: 'ஒரே பொருள் இரண்டு முறை' },
  shared_barcode: { en: 'two products behind one barcode', ta: 'ஒரே பார்கோடில் இரண்டு பொருட்கள்' },
  negative_stock: { en: 'less than nothing on the shelf', ta: 'அலமாரியில் பூஜ்ஜியத்திற்கும் குறைவு' },
  batch_without_expiry: { en: 'a batch with no expiry date', ta: 'காலாவதி தேதி இல்லாத தொகுதி' },
  duplicate_customer: { en: 'the same customer twice', ta: 'ஒரே வாடிக்கையாளர் இரண்டு முறை' },
  duplicate_supplier_gstin: { en: 'two suppliers with one GST number', ta: 'ஒரே GST எண்ணில் இரண்டு விற்பனையாளர்கள்' },
  document_total_mismatch: { en: 'a bill whose lines do not add up to its total', ta: 'வரிகள் மொத்தத்துடன் பொருந்தாத ஒரு பில்' },
  orphan_line: { en: 'a line belonging to no bill', ta: 'எந்தப் பில்லுக்கும் சொந்தமில்லாத வரி' },
  unmapped_tax_code: { en: 'a tax code nothing here understands', ta: 'இங்கே புரியாத ஒரு வரிக் குறியீடு' },
  pre_revision_tax_document: { en: 'a bill from before the tax rates changed', ta: 'வரி விகிதங்கள் மாறுவதற்கு முந்தைய பில்' },
};

const words = (map, key) => (map[key]?.[lang] ?? map[key]?.en ?? String(key).replace(/_/g, ' '));

/** A stand-in with the same surface as the bundled session, announced whenever it is in use. */
function sampleSession() {
  const refused = { ok: false, refusal: 'nobody_is_named_at_this_desk', detail: 'this is sample data' };
  return {
    cutover: () => ({
      derived: { checklist: {}, checks: [], notKnown: [], detail: '' },
      decision: { go: false, failed: [], shopKeepsTrading: true, detail: '', ownerAction: '' },
    }),
    discovery: () => undefined,
    cleaning: () => undefined,
    exceptionList: () => undefined,
    reconciliation: () => undefined,
    parallel: () => undefined,
    unowned: () => [],
    exclusions: () => undefined,
    retirement: () => undefined,
    resolve: () => refused,
    sign: () => refused,
    rollback: () => refused,
  };
}

const real = window.migrationSession;
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

// ── Navigation ──────────────────────────────────────────────────────────────

const VIEWS = ['where', 'figures', 'data', 'both', 'old'];

function show(name) {
  for (const view of VIEWS) el(`view-${view}`).hidden = view !== name;
  for (const tab of VIEWS) el(`tab-${tab}`).setAttribute('aria-current', tab === name ? 'page' : 'false');
}
for (const name of VIEWS) el(`tab-${name}`).addEventListener('click', () => { show(name); });

function emptyLine(text) {
  const p = document.createElement('p');
  p.className = 'empty';
  p.textContent = text;
  return p;
}

function line(text) {
  const small = document.createElement('small');
  small.textContent = text;
  return small;
}

// ── Can we switch over ──────────────────────────────────────────────────────

function renderWhere() {
  const { derived, decision } = session.cutover();

  const verdict = el('verdict');
  verdict.className = `verdict ${decision.go ? 'go' : 'nogo'}`;
  verdict.replaceChildren();
  const headline = document.createElement('strong');
  headline.textContent = decision.go ? t('go') : t('nogo');
  const action = document.createElement('p');
  // The module's own sentence of advice, carried through unchanged.
  action.textContent = decision.ownerAction;
  verdict.append(headline, action);

  // P-01, on the page rather than only in the types.
  el('trading').textContent = t('tradingEither');

  el('check-list').replaceChildren(...derived.checks.map((check) => {
    const row = document.createElement('div');
    // Three states, three colours. "Nobody can answer this" is drawn differently from "not yet"
    // on purpose — they need different people to fix them.
    row.className = `row ${check.state === 'passed' ? 'passed' : check.state === 'not_known' ? 'unknown' : 'failed'}`;
    const what = document.createElement('span');
    what.className = 'what';
    const name = document.createElement('strong');
    const state = check.state === 'passed' ? t('passed') : check.state === 'not_known' ? t('notKnown') : t('failed');
    name.textContent = `${words(CHECK_WORDS, check.check)} — ${state}`;
    // The producer's own words, never the screen's summary of them.
    what.append(name, line(check.evidence));
    if (check.state === 'not_known') what.append(line(t('notKnownNote')));
    row.append(what);
    return row;
  }));
}

el('rollback').addEventListener('click', () => {
  const outcome = session.rollback({
    trigger: el('trigger').value,
    // The legacy system is still there because MG-12 never deleted it.
    legacySystemAvailable: true,
  });
  if (!outcome.ok) {
    tell(t('read'), `${words(ROLLBACK_REFUSAL_WORDS, outcome.refusal)} ${outcome.detail}`);
    return;
  }
  tell(t('rolledBack'), outcome.result.detail, true);
  paintChrome();
});

// ── The figures ─────────────────────────────────────────────────────────────

function renderFigures() {
  const report = session.reconciliation();
  const box = el('figures-summary');
  box.replaceChildren();

  if (report === undefined) {
    // Nothing recorded is not everything agreeing. `assessReconciliation` says so itself on an
    // empty list — but it has to be given one to say it, and it never was.
    box.append(emptyLine(t('noFigures')));
    el('figures-list').replaceChildren();
    el('sign-total').replaceChildren();
    return;
  }

  const headline = document.createElement('span');
  headline.className = 'big';
  headline.textContent = report.qg07Passed ? t('go') : t('nogo');
  box.append(headline, line(report.detail));

  el('figures-list').replaceChildren(...report.assessments.map((total) => {
    const row = document.createElement('div');
    row.className = `row ${total.status === 'open' ? 'failed' : total.signed ? 'clean' : 'flagged'}`;
    const what = document.createElement('span');
    what.className = 'what';
    const name = document.createElement('strong');
    name.textContent = `${total.name} — ${total.status === 'reconciled' ? t('agrees') : total.status === 'explained' ? t('explained') : t('doesNotAgree')}`;
    what.append(name, line(total.detail));
    // Signed or not, said in words. A total that agrees and is unsigned still blocks QG-07.
    what.append(line(total.signed ? t('signedBy') : t('notSigned')));
    row.append(what);
    return row;
  }));

  // Only unsigned totals can be signed, and the list is built from the real report.
  el('sign-total').replaceChildren(...report.assessments
    .filter((total) => !total.signed)
    .map((total) => {
      const option = document.createElement('option');
      option.value = total.totalId;
      option.textContent = total.name;
      return option;
    }));
}

el('sign').addEventListener('click', () => {
  const outcome = session.sign({
    totalId: el('sign-total').value,
    signerRole: el('sign-role').value.trim(),
    statement: el('sign-statement').value,
  });
  if (!outcome.ok) {
    tell(t('read'), `${words(SIGN_REFUSAL_WORDS, outcome.refusal)} ${outcome.detail}`);
    return;
  }
  tell(t('signed'), outcome.detail, true);
  paintChrome();
});

// ── Problems in the old data ────────────────────────────────────────────────

function renderData() {
  const position = session.cleaning();
  const list = session.exceptionList();
  const box = el('data-summary');
  box.replaceChildren();

  if (position === undefined || list === undefined) {
    box.append(emptyLine(t('noData')));
    el('data-list').replaceChildren();
    el('decide-id').replaceChildren();
    return;
  }

  const headline = document.createElement('span');
  headline.className = 'big';
  headline.textContent = String(position.blockingUnresolved.length);
  box.append(
    headline,
    line(position.detail),
    line(`${t('atStake')}: ${money(position.valueAtStakeMinor)}`),
  );

  el('data-list').replaceChildren(...(list.length === 0
    ? [emptyLine(t('nothingWrong'))]
    : list.map((exception) => {
      const row = document.createElement('div');
      row.className = `row ${exception.resolution !== undefined
        ? 'done'
        : exception.severity === 'blocking' ? 'failed' : 'flagged'}`;
      const what = document.createElement('span');
      what.className = 'what';
      const name = document.createElement('strong');
      name.textContent = `${words(EXCEPTION_WORDS, exception.kind)}${exception.severity === 'blocking' && exception.resolution === undefined ? ` — ${t('blocking')}` : ''}`;
      // What was observed, in words somebody can check against the old system.
      what.append(name, line(exception.evidence));
      if (exception.valueMinor !== undefined) {
        what.append(line(`${t('atStake')}: ${money(exception.valueMinor)}`));
      }
      // A decided one stays on the list. It is the record that somebody looked at it.
      what.append(line(exception.resolution === undefined
        ? t('undecided')
        : `${t('decidedBy')} ${exception.resolution.decidedBy}: ${exception.resolution.reason}`));
      row.append(what);
      return row;
    })));

  undecided = list.filter((exception) => exception.resolution === undefined);
  el('decide-id').replaceChildren(...undecided.map((exception) => {
    const option = document.createElement('option');
    option.value = exception.exceptionId;
    option.textContent = `${words(EXCEPTION_WORDS, exception.kind)} — ${exception.evidence}`;
    return option;
  }));
  paintSurvivors();
}

/** The undecided ones, as the picker last drew them. Repainting the survivors must not rebuild
 *  the whole list, or choosing an action would silently reset which exception was picked. */
let undecided = [];

/** A merge must name which record survives, so the choice is offered from the real records. */
function paintSurvivors() {
  const chosen = undecided.find((exception) => exception.exceptionId === el('decide-id').value);
  el('survivor').replaceChildren(...(chosen === undefined ? [] : chosen.legacyIds).map((legacyId) => {
    const option = document.createElement('option');
    option.value = legacyId;
    option.textContent = legacyId;
    return option;
  }));
  const merging = el('decide-action').value === 'merge';
  el('survivor').hidden = !merging;
  el('survivor-label').hidden = !merging;
}

el('decide-action').addEventListener('change', paintSurvivors);
el('decide-id').addEventListener('change', paintSurvivors);

el('decide').addEventListener('click', () => {
  const action = el('decide-action').value;
  const outcome = session.resolve({
    exceptionId: el('decide-id').value,
    action,
    // Never defaulted to a stock phrase. This sentence is the whole record in a year's time.
    reason: el('decide-reason').value,
    ...(action === 'merge' ? { survivingLegacyId: el('survivor').value } : {}),
  });
  if (!outcome.ok) {
    tell(t('read'), `${words(RESOLVE_REFUSAL_WORDS, outcome.refusal)} ${outcome.detail}`);
    return;
  }
  tell(t('decided'), outcome.detail, true);
  el('decide-reason').value = '';
  paintChrome();
});

// ── Running both ────────────────────────────────────────────────────────────

function renderBoth() {
  const position = session.parallel();
  const box = el('both-summary');
  box.replaceChildren();

  if (position === undefined) {
    box.append(emptyLine(t('noBoth')));
    el('both-list').replaceChildren();
    return;
  }

  const headline = document.createElement('span');
  headline.className = 'big';
  headline.textContent = String(position.consecutiveCleanDays);
  box.append(headline, line(`${t('cleanDays')} · ${position.detail}`));

  // The differences with nobody's name on them are what §34.1 is about, so they lead.
  const unowned = session.unowned();
  el('both-list').replaceChildren(...(position.openDifferences.length === 0
    ? [emptyLine(t('nothingWrong'))]
    : [...position.openDifferences]
      .sort((a, b) => (a.ownerUserId === undefined ? 0 : 1) - (b.ownerUserId === undefined ? 0 : 1))
      .map((difference) => {
        const row = document.createElement('div');
        const nameless = unowned.some((d) => d.differenceId === difference.differenceId);
        row.className = `row ${nameless ? 'failed' : 'flagged'}`;
        const what = document.createElement('span');
        what.className = 'what';
        const name = document.createElement('strong');
        name.textContent = `${difference.area.replace(/_/g, ' ')} — ${money(Math.abs(difference.difference))}`;
        what.append(name, line(difference.businessDate));
        what.append(line(nameless
          ? t('nobodysName')
          : `${t('decidedBy')} ${difference.ownerUserId}${difference.explanation === undefined ? '' : `: ${difference.explanation}`}`));
        row.append(what);
        return row;
      })));
}

// ── The old system ──────────────────────────────────────────────────────────

function renderOld() {
  const result = session.discovery();
  const box = el('old-summary');
  box.replaceChildren();

  if (result === undefined) {
    // Discovery that never ran and discovery that found nothing are opposite facts.
    box.append(emptyLine(t('noOld')));
    el('old-list').replaceChildren();
  } else {
    const headline = document.createElement('span');
    headline.className = 'big';
    headline.textContent = String(result.sources.length);
    box.append(
      headline,
      line(`${t('sources')} · ${result.countedRows.toLocaleString('en-IN')} ${t('countedRows')}`),
      line(result.detail),
    );

    // The gaps are the output. A clean list of four sources is worth less than one that says
    // "and nobody owns the loyalty spreadsheet".
    el('old-list').replaceChildren(...(result.gaps.length === 0
      ? result.sources.map((source) => {
        const row = document.createElement('div');
        row.className = 'row clean';
        const what = document.createElement('span');
        what.className = 'what';
        const name = document.createElement('strong');
        name.textContent = source.name;
        what.append(name, line(`${source.kind.replace(/_/g, ' ')} · ${(source.rowCount ?? 0).toLocaleString('en-IN')}`));
        row.append(what);
        return row;
      })
      : result.gaps.map((gap) => {
        const row = document.createElement('div');
        row.className = 'row flagged';
        const what = document.createElement('span');
        what.className = 'what';
        const name = document.createElement('strong');
        name.textContent = gap.name;
        what.append(name, line(gap.detail));
        row.append(what);
        return row;
      })));
  }

  const assessment = session.retirement();
  const retire = el('retire-box');
  retire.replaceChildren();
  if (assessment === undefined) {
    retire.append(emptyLine(t('noRetire')));
  } else {
    const row = document.createElement('div');
    row.className = `row ${assessment.mayRetireSystem ? 'clean' : 'held'}`;
    const what = document.createElement('span');
    what.className = 'what';
    const name = document.createElement('strong');
    name.textContent = assessment.mayRetireSystem ? t('passed') : t('failed');
    what.append(name, line(assessment.detail));
    row.append(what);
    retire.append(row);
  }
  // Said whatever else is true. Retiring the system and deleting the data get conflated
  // constantly, and only one of them is what anybody agreed to.
  retire.append(emptyLine(t('neverDeleted')));
}

// ── Language and chrome ─────────────────────────────────────────────────────

function paintChrome() {
  el('who').firstChild.textContent = `${t('title')} `;
  el('whoami').textContent = window.migrationData?.userId ?? '';
  for (const [id, key] of [
    ['tab-where', 'where'], ['tab-figures', 'figures'], ['tab-data', 'data'],
    ['tab-both', 'both'], ['tab-old', 'old'],
    ['where-title', 'where'], ['where-lead', 'whereLead'],
    ['figures-title', 'figures'], ['figures-lead', 'figuresLead'],
    ['data-title', 'data'], ['data-lead', 'dataLead'],
    ['both-title', 'both'], ['both-lead', 'bothLead'],
    ['old-title', 'old'], ['old-lead', 'oldLead'],
    ['rollback-title', 'rollbackTitle'], ['rollback-lead', 'rollbackLead'],
    ['trigger-label', 'triggerLabel'], ['trigger-totals', 'triggerTotals'],
    ['trigger-trade', 'triggerTrade'], ['trigger-data', 'triggerData'],
    ['trigger-owner', 'triggerOwner'], ['trigger-time', 'triggerTime'],
    ['rollback', 'rollback'],
    ['sign-title', 'signTitle'], ['sign-total-label', 'signTotalLabel'],
    ['sign-role-label', 'signRoleLabel'], ['sign-statement-label', 'signStatementLabel'],
    ['sign', 'sign'],
    ['decide-title', 'decideTitle'], ['decide-id-label', 'decideIdLabel'],
    ['decide-action-label', 'decideActionLabel'], ['action-correct', 'actionCorrect'],
    ['action-merge', 'actionMerge'], ['action-exclude', 'actionExclude'],
    ['action-as-is', 'actionAsIs'], ['survivor-label', 'survivorLabel'],
    ['decide-reason-label', 'decideReasonLabel'], ['decide', 'decide'],
    ['retire-title', 'retireTitle'], ['retire-lead', 'retireLead'],
    ['sample', 'sampleData'],
  ]) {
    el(id).textContent = t(key);
  }

  const nobody = el('nobody');
  nobody.hidden = window.migrationData?.userId !== undefined;
  nobody.textContent = nobody.hidden ? '' : t('nobodyNamed');

  // What this page has decided and not yet managed to send. A screen that draws a signature it
  // could not record is the failure P-08 exists to refuse, so this is never hidden when it is > 0.
  const unsent = session.unsent();
  const strip = el('unsent');
  strip.hidden = unsent === 0;
  strip.textContent = unsent === 0 ? '' : `${unsent} ${t('unsent')}`;

  renderWhere();
  renderFigures();
  renderData();
  renderBoth();
  renderOld();
}

el('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  paintChrome();
});

// ── Boot ────────────────────────────────────────────────────────────────────

el('sample').hidden = real !== undefined;
paintChrome();
show('where');

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
