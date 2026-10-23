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
    rollback: 'Go back to the old system now', rolledBack: 'Going back to the old system is DECIDED — it is not done until the old till takes its first sale',
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
    // MG-10 day entry, witness figures and the first department's templates (cutover readiness, OB-239).
    witnessTitle: 'What the outside evidence says',
    witnessLead: 'Each of the twelve kinds of record, checked against something outside the old system — the stock count, the bank, the tax returns, the accountant\'s books, the suppliers, the customers. A kind with no finding is listed as missing, never as fine.',
    noWitness: 'The store computer has not been told what the outside evidence says. That is not the same as it agreeing.',
    witnessCovered: 'kinds of record have a finding', witnessMissing: 'still missing', witnessSigned: 'signatures over this page',
    verdict_proved: 'proved by outside evidence', verdict_proved_with_differences: 'checked — differences found and listed',
    verdict_not_proved: 'NOT PROVED YET', verdict_no_evidence_exists: 'nothing outside the old system can check this',
    checkedBy: 'checked against', cannotProve: 'what this cannot prove',
    templatesTitle: 'Templates for the first department',
    templatesLead: 'Download each one, fill it in from the old system\'s export, one row per line, and give the folder to the person doing the load on the store computer. A bad row is set aside with its reason — it never stops the good ones, and nothing goes in until a named person has read the list.',
    download: 'Download', requiredColumns: 'must be filled',
    tpl_products: 'Products (one row per item)', tpl_barcodes: 'Barcodes (one row per barcode)',
    tpl_taxClasses: 'Tax classes (HSN and GST rate)', tpl_prices: 'Prices (one row per item: MRP, selling price, cost)',
    dayTitle: 'Enter a day',
    dayLead: 'Type the old system\'s total for the day beside the new system\'s, area by area — or bring in the old system\'s day-end file. Where the two differ by more than the allowed amount, write why. A day with a difference nobody has explained cannot be signed.',
    dayDate: 'Which day', dayImport: 'Bring in the old system\'s day-end file (area, old system, new system, allowed difference)',
    reconciler: 'The person named to reconcile each day', noReconciler: 'Nobody has been named to reconcile each day. The owner names them first — until then no day can be entered or signed.',
    oldSystem: 'Old system', newSystem: 'New system', allowed: 'Allowed difference',
    reason: 'Why do they differ', wrongSide: 'Which one was wrong',
    side_legacy: 'the old system', side_new: 'the new system', side_both: 'both', side_neither: 'neither — a timing difference',
    area_sales_value: 'Sales (₹)', area_sales_count: 'Number of bills', area_stock_movement: 'Stock moved (units)',
    area_tax: 'Tax (₹)', area_payments: 'Payments taken (₹)', area_loyalty: 'Loyalty points',
    notCompared: 'Not compared in the mirror pilot (owner decision OB-256): the old system takes every payment and keeps loyalty, so the evening comparison covers sales, bills, tax and stock only. Nothing to type here.',
    daySave: 'Save the day', daySaved: 'Day saved on this device — it will be sent to head office',
    dayStatement: 'What you checked (in your own words)', daySign: 'Sign the day', daySigned: 'Day signed',
    dayAgrees: 'agrees', dayDiffers: 'differs by', needsReason: 'NEEDS A REASON — the day cannot be signed',
    explainedAs: 'explained', daysTitle: 'Days so far', noDays: 'No day has been entered yet.',
    billsTitle: 'Bill by bill (mirror pilot)',
    billsLead: 'Every sale keyed on the new till on this day, with the old system\'s bill number typed on it (OB-264). Use it to check a bill by hand. The comparison with the old system\'s own bill list is in the evening check from the old system\'s files, above (OB-263).',
    billsNone: 'No sale keyed on the new till on this day yet.', billNew: 'New bill', billOld: 'Old bill', billAmount: 'Amount', billRefunded: 'Refunded',
    billsCount: 'bill(s)', billsTotal: 'in all', billsTruncated: 'Only the latest bills are listed here.',
    signedDay: 'signed by', unsignedDay: 'NOT SIGNED', resignNeeded: 'the figures changed after it was signed — sign it again',
    importDone: 'The file was read into the boxes below. Check them, then save the day.',
    importBad: 'This file could not be read. Each line must be: area, old system, new system, allowed difference.',
    notSaved: 'Not saved', notSigned2: 'Not signed', cannotSign: 'This day cannot be signed yet',
    day_refusal_nobody_is_named_at_this_desk: 'This store computer has not been told who is using this screen.',
    day_refusal_nobody_named_to_reconcile: 'Nobody has been named to reconcile each day.',
    day_refusal_not_the_named_reconciler: 'Only the person named to reconcile each day can enter or sign a day here.',
    day_refusal_not_a_date: 'Choose the day first.',
    day_refusal_no_figures: 'Every area needs both figures. A blank box is not a zero.',
    day_refusal_explanation_refused: 'A reason was refused: say why the systems differ, not which one you prefer.',
    day_refusal_unexplained_material_difference: 'Some differences still have no reason. Write why for each one, save the day, then sign.',
    day_refusal_statement_says_nothing: 'Say in your own words what you checked — at least a full sentence.',
    day_refusal_day_not_recorded: 'Save the day\'s figures first.',
  },
  ta: {
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
    rollback: 'இப்போதே பழைய அமைப்புக்குத் திரும்பு', rolledBack: 'பழைய அமைப்புக்குத் திரும்ப முடிவு செய்யப்பட்டது — பழைய பில்லிங்கில் முதல் விற்பனை நடக்கும் வரை இது முடியவில்லை',
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
    witnessTitle: 'வெளிச் சான்று என்ன சொல்கிறது',
    witnessLead: 'பன்னிரண்டு வகைப் பதிவுகள் ஒவ்வொன்றும் பழைய அமைப்புக்கு வெளியே உள்ள ஒன்றுடன் சரிபார்க்கப்படுகிறது — இருப்பு எண்ணிக்கை, வங்கி, வரி அறிக்கைகள், கணக்காளரின் கணக்குகள், விற்பனையாளர்கள், வாடிக்கையாளர்கள். கண்டுபிடிப்பு இல்லாத வகை "இல்லை" என்று காட்டப்படும், ஒருபோதும் "சரி" என்று அல்ல.',
    noWitness: 'வெளிச் சான்று என்ன சொல்கிறது என்று கடைக் கணினிக்குச் சொல்லப்படவில்லை. அது பொருந்துகிறது என்பது இதன் பொருள் அல்ல.',
    witnessCovered: 'வகைப் பதிவுகளுக்குக் கண்டுபிடிப்பு உள்ளது', witnessMissing: 'இன்னும் இல்லை', witnessSigned: 'இந்தப் பக்கத்தின் மீதான கையெழுத்துகள்',
    verdict_proved: 'வெளிச் சான்றால் நிரூபிக்கப்பட்டது', verdict_proved_with_differences: 'சரிபார்க்கப்பட்டது — வேறுபாடுகள் கண்டறிந்து பட்டியலிடப்பட்டன',
    verdict_not_proved: 'இன்னும் நிரூபிக்கப்படவில்லை', verdict_no_evidence_exists: 'பழைய அமைப்புக்கு வெளியே இதைச் சரிபார்க்க எதுவும் இல்லை',
    checkedBy: 'சரிபார்த்தது', cannotProve: 'இது நிரூபிக்க முடியாதது',
    templatesTitle: 'முதல் துறைக்கான வார்ப்புருக்கள்',
    templatesLead: 'ஒவ்வொன்றையும் பதிவிறக்கி, பழைய அமைப்பின் ஏற்றுமதியிலிருந்து நிரப்பி — ஒரு வரிக்கு ஒரு வரிசை — கடைக் கணினியில் ஏற்றம் செய்பவரிடம் கோப்புறையைக் கொடுங்கள். தவறான வரிசை அதன் காரணத்துடன் ஒதுக்கி வைக்கப்படும் — நல்லவற்றை அது ஒருபோதும் நிறுத்தாது, பெயர் குறிப்பிட்ட ஒருவர் பட்டியலைப் படிக்கும் வரை எதுவும் உள்ளே செல்லாது.',
    download: 'பதிவிறக்கு', requiredColumns: 'கட்டாயம் நிரப்ப வேண்டியவை',
    tpl_products: 'பொருட்கள் (ஒரு பொருளுக்கு ஒரு வரிசை)', tpl_barcodes: 'பார்கோடுகள் (ஒரு பார்கோடுக்கு ஒரு வரிசை)',
    tpl_taxClasses: 'வரி வகைகள் (HSN மற்றும் GST விகிதம்)', tpl_prices: 'விலைகள் (ஒரு பொருளுக்கு ஒரு வரிசை: MRP, விற்பனை விலை, அடக்க விலை)',
    dayTitle: 'ஒரு நாளைப் பதிவு செய்',
    dayLead: 'பழைய அமைப்பின் அன்றைய மொத்தத்தைப் புதிய அமைப்பின் மொத்தத்திற்கு அருகில், பகுதி வாரியாகத் தட்டச்சு செய்யுங்கள் — அல்லது பழைய அமைப்பின் நாள்-முடிவுக் கோப்பைக் கொண்டு வாருங்கள். அனுமதிக்கப்பட்ட அளவை விட அதிகமாக வேறுபட்டால், ஏன் என்று எழுதுங்கள். யாரும் விளக்காத வேறுபாடு உள்ள நாளில் கையெழுத்திட முடியாது.',
    dayDate: 'எந்த நாள்', dayImport: 'பழைய அமைப்பின் நாள்-முடிவுக் கோப்பைக் கொண்டு வா (பகுதி, பழைய அமைப்பு, புதிய அமைப்பு, அனுமதிக்கப்பட்ட வேறுபாடு)',
    reconciler: 'ஒவ்வொரு நாளும் சரிபார்க்கப் பெயரிடப்பட்டவர்', noReconciler: 'ஒவ்வொரு நாளும் சரிபார்க்க யாரும் பெயரிடப்படவில்லை. உரிமையாளர் முதலில் பெயரிட வேண்டும் — அதுவரை எந்த நாளையும் பதிவு செய்யவோ கையெழுத்திடவோ முடியாது.',
    oldSystem: 'பழைய அமைப்பு', newSystem: 'புதிய அமைப்பு', allowed: 'அனுமதிக்கப்பட்ட வேறுபாடு',
    reason: 'ஏன் வேறுபடுகின்றன', wrongSide: 'எது தவறு',
    side_legacy: 'பழைய அமைப்பு', side_new: 'புதிய அமைப்பு', side_both: 'இரண்டும்', side_neither: 'இரண்டும் அல்ல — நேர வேறுபாடு',
    area_sales_value: 'விற்பனை (₹)', area_sales_count: 'பில்களின் எண்ணிக்கை', area_stock_movement: 'நகர்ந்த இருப்பு (அலகுகள்)',
    area_tax: 'வரி (₹)', area_payments: 'பெற்ற பணம் (₹)', area_loyalty: 'விசுவாசப் புள்ளிகள்',
    notCompared: 'மிரர் பைலட்டில் ஒப்பிடப்படுவதில்லை (உரிமையாளர் முடிவு OB-256): ஒவ்வொரு பணத்தையும் பழைய அமைப்பே பெறுகிறது, லாயல்டியையும் அதுவே வைத்திருக்கிறது; எனவே மாலை ஒப்பீடு விற்பனை, பில்கள், வரி, இருப்பு மட்டுமே. இங்கே எதையும் தட்டச்சு செய்ய வேண்டாம்.',
    daySave: 'நாளைச் சேமி', daySaved: 'நாள் இந்தச் சாதனத்தில் சேமிக்கப்பட்டது — தலைமை அலுவலகத்துக்கு அனுப்பப்படும்',
    dayStatement: 'நீங்கள் எதைச் சரிபார்த்தீர்கள் (உங்கள் சொந்த வார்த்தைகளில்)', daySign: 'நாளில் கையெழுத்திடு', daySigned: 'நாளில் கையெழுத்திடப்பட்டது',
    dayAgrees: 'பொருந்துகிறது', dayDiffers: 'வேறுபாடு', needsReason: 'காரணம் தேவை — இந்த நாளில் கையெழுத்திட முடியாது',
    explainedAs: 'விளக்கம்', daysTitle: 'இதுவரையிலான நாட்கள்', noDays: 'இதுவரை எந்த நாளும் பதிவு செய்யப்படவில்லை.',
    billsTitle: 'பில் வாரியாக (மிரர் பைலட்)',
    billsLead: 'இந்த நாளில் புதிய கல்லாவில் பதிவான ஒவ்வொரு விற்பனையும், அதில் உள்ளிட்ட பழைய அமைப்பின் பில் எண்ணுடன் (OB-264). ஒரு பில்லைக் கையால் சரிபார்க்க இதைப் பயன்படுத்தவும். பழைய அமைப்பின் சொந்தப் பில் பட்டியலுடன் ஒப்பீடு மேலே, பழைய அமைப்பின் கோப்புகளிலிருந்து மாலைச் சரிபார்ப்பில் உள்ளது (OB-263).',
    billsNone: 'இந்த நாளில் புதிய கல்லாவில் இன்னும் எந்த விற்பனையும் பதிவாகவில்லை.', billNew: 'புதிய பில்', billOld: 'பழைய பில்', billAmount: 'தொகை', billRefunded: 'திருப்பித் தரப்பட்டது',
    billsCount: 'பில்(கள்)', billsTotal: 'மொத்தம்', billsTruncated: 'சமீபத்திய பில்கள் மட்டுமே இங்கே பட்டியலிடப்பட்டுள்ளன.',
    signedDay: 'கையெழுத்திட்டவர்', unsignedDay: 'கையெழுத்து இல்லை', resignNeeded: 'கையெழுத்திட்ட பிறகு கணக்குகள் மாறின — மீண்டும் கையெழுத்திடுங்கள்',
    importDone: 'கோப்பு கீழே உள்ள பெட்டிகளில் படிக்கப்பட்டது. சரிபார்த்து, பின் நாளைச் சேமியுங்கள்.',
    importBad: 'இந்தக் கோப்பைப் படிக்க முடியவில்லை. ஒவ்வொரு வரியும்: பகுதி, பழைய அமைப்பு, புதிய அமைப்பு, அனுமதிக்கப்பட்ட வேறுபாடு.',
    notSaved: 'சேமிக்கப்படவில்லை', notSigned2: 'கையெழுத்திடப்படவில்லை', cannotSign: 'இந்த நாளில் இன்னும் கையெழுத்திட முடியாது',
    day_refusal_nobody_is_named_at_this_desk: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
    day_refusal_nobody_named_to_reconcile: 'ஒவ்வொரு நாளும் சரிபார்க்க யாரும் பெயரிடப்படவில்லை.',
    day_refusal_not_the_named_reconciler: 'ஒவ்வொரு நாளும் சரிபார்க்கப் பெயரிடப்பட்டவர் மட்டுமே இங்கே நாளைப் பதிவு செய்யவோ கையெழுத்திடவோ முடியும்.',
    day_refusal_not_a_date: 'முதலில் நாளைத் தேர்ந்தெடுங்கள்.',
    day_refusal_no_figures: 'ஒவ்வொரு பகுதிக்கும் இரண்டு கணக்குகளும் தேவை. காலியான பெட்டி பூஜ்ஜியம் அல்ல.',
    day_refusal_explanation_refused: 'ஒரு காரணம் மறுக்கப்பட்டது: எதை விரும்புகிறீர்கள் என்று அல்ல, அமைப்புகள் ஏன் வேறுபடுகின்றன என்று சொல்லுங்கள்.',
    day_refusal_unexplained_material_difference: 'சில வேறுபாடுகளுக்கு இன்னும் காரணம் இல்லை. ஒவ்வொன்றுக்கும் ஏன் என்று எழுதி, நாளைச் சேமித்து, பின் கையெழுத்திடுங்கள்.',
    day_refusal_statement_says_nothing: 'நீங்கள் எதைச் சரிபார்த்தீர்கள் என்று உங்கள் சொந்த வார்த்தைகளில் சொல்லுங்கள் — குறைந்தது ஒரு முழு வாக்கியம்.',
    day_refusal_day_not_recorded: 'முதலில் நாளின் கணக்குகளைச் சேமியுங்கள்.',
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
  // OB-288 P5 · MG-11: the backup and the owner's rollback limits.
  backup_verified: {
    en: 'A good backup, copied off-site, is recent enough by the owner\'s limit',
    ta: 'வெளியிடத்திற்கு நகலெடுக்கப்பட்ட ஒரு நல்ல காப்புப்பிரதி உரிமையாளரின் வரம்புக்குள் புதியதாக உள்ளது',
  },
  rollback_limits_agreed: {
    en: 'The owner has set every rollback limit before the night',
    ta: 'இரவுக்கு முன் ஒவ்வொரு திரும்பும் வரம்பையும் உரிமையாளர் அமைத்துள்ளார்',
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
  // OB-288 P5 · MG-09: what changed in the old system after the copy that was loaded.
  delta_added: { en: 'added in the old system after the copy was loaded', ta: 'நகல் ஏற்றப்பட்ட பிறகு பழைய அமைப்பில் சேர்க்கப்பட்டது' },
  delta_changed: { en: 'changed in the old system after the copy was loaded', ta: 'நகல் ஏற்றப்பட்ட பிறகு பழைய அமைப்பில் மாற்றப்பட்டது' },
  delta_removed: { en: 'removed from the old system after the copy was loaded', ta: 'நகல் ஏற்றப்பட்ட பிறகு பழைய அமைப்பிலிருந்து நீக்கப்பட்டது' },
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
    unsent: () => 0,
    exclusions: () => undefined,
    retirement: () => undefined,
    resolve: () => refused,
    sign: () => refused,
    rollback: () => refused,
    day: (businessDate) => ({ businessDate, differences: [], unexplained: [] }),
    enterDay: () => refused,
    signDay: () => ({ ...refused, unexplained: [] }),
    witness: () => undefined,
    sliceTemplates: () => [],
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
  // A decision, not a done thing (GT-02): never the green "done" banner until the old till has taken a sale.
  tell(t('rolledBack'), outcome.result.detail);
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
  void syncToBox();
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
  void syncToBox();
});

/**
 * Hand this screen's decisions to the store computer (2b-vi-c-4). The relay is the composition root's
 * (`window.migrationRelay`), present only when the box told this screen where its socket is. The store computer seals each
 * decision for the person it verified and carries it to head office; a box that cannot be reached leaves everything saved
 * on this device, and it goes on the next try.
 */
async function syncToBox() {
  const relay = window.migrationRelay;
  if (!relay) return;
  try {
    await relay.syncNow();
  } catch {
    /* the queue is untouched; it goes on the next try */
  }
}
for (const moment of ['online', 'focus', 'pageshow']) window.addEventListener(moment, () => { void syncToBox(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) void syncToBox(); });

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

// ── Running both: enter, explain and sign a day (MG-10) ────────────────────

const AREAS = ['sales_value', 'sales_count', 'stock_movement', 'tax', 'payments', 'loyalty'];
/**
 * OB-256 (owner, 20 Oct 2026): in the mirror pilot the store computer says which areas are NOT compared — the old system
 * takes every payment and keeps loyalty. Those cards say so and take no figures; they are left out of the day, never sent
 * as a zero (P-08).
 */
const NOT_COMPARED = new Set((window.migrationData?.notCompared ?? []).map((n) => n && n.area).filter((a) => AREAS.includes(a)));
const COMPARED = AREAS.filter((a) => !NOT_COMPARED.has(a));
/** Areas counted in money are typed in rupees and kept in paise; the rest are whole counts. */
const MONEY_AREAS = new Set(['sales_value', 'tax', 'payments']);
const SIDES = ['legacy', 'new', 'both', 'neither'];
const toMinor = (area, text) => {
  const v = String(text ?? '').replace(/[₹,\s]/g, '');
  if (v === '' || !/^-?\d+(\.\d{1,2})?$/.test(v)) return NaN;
  return MONEY_AREAS.has(area) ? Math.round(Number(v) * 100) : (Number.isInteger(Number(v)) ? Number(v) : NaN);
};
const shown = (area, minor) => (MONEY_AREAS.has(area) ? money(minor) : Number(minor).toLocaleString('en-IN'));
const icon = (name, size = 18) => (window.sreIcon && typeof window.sreIcon === 'function' ? window.sreIcon(name, size) : null);
/** A button's word with its icon beside it — never an icon alone (design system §3.4). */
function labelled(button, iconName, word) {
  const mark = icon(iconName);
  const text = document.createElement('span');
  text.textContent = word;
  button.replaceChildren(...(mark ? [mark, text] : [text]));
  button.classList.add('sre-with-icon');
}
const today = () => (window.migrationData?.now ?? new Date().toISOString()).slice(0, 10);
const enteredHere = new Set();

function buildAreas() {
  const box = el('day-areas');
  if (box.childElementCount > 0) return;
  for (const area of AREAS) {
    const card = document.createElement('div');
    card.className = 'area';
    card.id = `day-${area}`;
    const name = document.createElement('strong');
    name.id = `day-${area}-name`;
    const cols = document.createElement('div');
    cols.className = 'cols';
    for (const [suffix, key] of [['old', 'oldSystem'], ['new', 'newSystem'], ['tol', 'allowed']]) {
      const wrap = document.createElement('div');
      const label = document.createElement('label');
      label.htmlFor = `day-${area}-${suffix}`;
      label.dataset.word = key;
      const input = document.createElement('input');
      input.id = `day-${area}-${suffix}`;
      input.type = 'text';
      input.inputMode = 'decimal';
      input.autocomplete = 'off';
      if (suffix === 'tol') input.value = '0';
      wrap.append(label, input);
      cols.append(wrap);
    }
    const diff = document.createElement('span');
    diff.className = 'diff';
    diff.id = `day-${area}-diff`;
    const whyLabel = document.createElement('label');
    whyLabel.htmlFor = `day-${area}-why`;
    whyLabel.dataset.word = 'reason';
    const why = document.createElement('input');
    why.id = `day-${area}-why`;
    why.type = 'text';
    why.autocomplete = 'off';
    const sideLabel = document.createElement('label');
    sideLabel.htmlFor = `day-${area}-side`;
    sideLabel.dataset.word = 'wrongSide';
    const side = document.createElement('select');
    side.id = `day-${area}-side`;
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = '—';
    side.append(blank, ...SIDES.map((v) => { const o = document.createElement('option'); o.value = v; o.dataset.word = `side_${v}`; return o; }));
    card.append(name, cols, diff, whyLabel, why, sideLabel, side);
    if (NOT_COMPARED.has(area)) {
      // OB-256: decided, and said — no boxes to fill, so nothing can be sent as a zero.
      card.className = 'area off';
      for (const node of [cols, diff, whyLabel, why, sideLabel, side]) node.hidden = true;
      for (const input of card.querySelectorAll('input, select')) input.disabled = true;
      const off = document.createElement('p');
      off.id = `day-${area}-off`;
      off.className = 'lead';
      off.dataset.word = 'notCompared';
      card.append(off);
    }
    box.append(card);
    for (const suffix of ['old', 'new', 'tol']) el(`day-${area}-${suffix}`).addEventListener('input', () => { paintDiff(area); });
  }
}

function paintDiff(area) {
  const legacy = toMinor(area, el(`day-${area}-old`).value);
  const now = toMinor(area, el(`day-${area}-new`).value);
  const tol = toMinor(area, el(`day-${area}-tol`).value);
  const card = el(`day-${area}`);
  const out = el(`day-${area}-diff`);
  if (Number.isNaN(legacy) || Number.isNaN(now) || Number.isNaN(tol)) { out.textContent = ''; card.className = 'area'; return; }
  const d = now - legacy;
  const material = Math.abs(d) > tol;
  const explained = el(`day-${area}-why`).value.trim() !== '';
  card.className = `area${material ? (explained ? ' differs' : ' unexplained') : ''}`;
  out.textContent = d === 0 ? t('dayAgrees') : `${t('dayDiffers')} ${shown(area, Math.abs(d))}${material && !explained ? ` — ${t('needsReason')}` : ''}`;
}

function linesFromForm() {
  return COMPARED.map((area) => {
    const why = el(`day-${area}-why`).value.trim();
    const side = el(`day-${area}-side`).value;
    return {
      area,
      legacyValue: toMinor(area, el(`day-${area}-old`).value),
      newValue: toMinor(area, el(`day-${area}-new`).value),
      toleranceMinor: toMinor(area, el(`day-${area}-tol`).value),
      ...(why === '' ? {} : { explanation: why }),
      ...(side === '' ? {} : { wrongSide: side }),
    };
  });
}

/** The old system's day-end file: `area,old,new,allowed` per line; a header line is skipped. Rupees for money areas. */
el('day-import').addEventListener('change', async () => {
  const file = el('day-import').files?.[0];
  if (!file) return;
  let ok = 0;
  try {
    const text = await file.text();
    for (const raw of text.split(/\r?\n/)) {
      const cells = raw.split(',').map((c) => c.trim());
      if (cells.length < 3 || !COMPARED.includes(cells[0])) continue;
      el(`day-${cells[0]}-old`).value = cells[1];
      el(`day-${cells[0]}-new`).value = cells[2];
      if (cells[3] !== undefined && cells[3] !== '') el(`day-${cells[0]}-tol`).value = cells[3];
      paintDiff(cells[0]);
      ok += 1;
    }
  } catch { ok = 0; }
  if (ok === 0) tell(t('read'), t('importBad'));
  else tell(t('read'), t('importDone'), true);
});

el('day-save').addEventListener('click', () => {
  const outcome = session.enterDay({ businessDate: el('day-date').value, lines: linesFromForm() });
  // The rule's own sentence is English; in Tamil the screen's own words carry the refusal.
  if (!outcome.ok) { tell(t('notSaved'), `${t(`day_refusal_${outcome.refusal}`)}${lang === 'en' ? ` ${outcome.detail}` : ''}`); return; }
  enteredHere.add(outcome.day.businessDate);
  // Saved on this device; now handed to the store computer, which carries it to head office (hard rule #1).
  void syncToBox();
  tell(t('daySaved'), lang === 'en' ? outcome.detail : `${outcome.day.differences.length} · ${outcome.day.unexplained.length === 0 ? t('explainedAs') : t('needsReason')}`, outcome.day.unexplained.length === 0);
  paintChrome();
});

el('day-sign').addEventListener('click', () => {
  const outcome = session.signDay({ businessDate: el('day-date').value, statement: el('day-statement').value });
  if (!outcome.ok) {
    const named = outcome.unexplained.map((d) => `${t(`area_${d.area}`)} (${d.differenceId})`).join(', ');
    tell(t('cannotSign'), `${t(`day_refusal_${outcome.refusal}`)}${named === '' ? '' : ` — ${named}`}`);
    return;
  }
  el('day-statement').value = '';
  void syncToBox();
  tell(t('daySigned'), lang === 'en' ? outcome.detail : `${t('signedDay')} ${outcome.signature.signedBy}`, true);
  paintChrome();
});
el('day-date').addEventListener('change', () => { renderDay(); renderBills(); });

function renderDay() {
  const date = el('day-date').value;
  const view = el('day-view');
  view.replaceChildren();
  if (date === '') return;
  const day = session.day(date);
  if (day.comparisons === undefined) return;
  for (const c of day.comparisons) {
    const row = document.createElement('div');
    const diff = day.differences.find((d) => d.area === c.area);
    const open = day.unexplained.some((d) => d.area === c.area);
    row.className = `row ${diff === undefined ? 'clean' : open ? 'failed' : 'flagged'}`;
    const what = document.createElement('span');
    what.className = 'what';
    const name = document.createElement('strong');
    name.textContent = t(`area_${c.area}`);
    const sides = document.createElement('div');
    sides.className = 'sides';
    for (const [label, value] of [[t('oldSystem'), c.legacyValue], [t('newSystem'), c.newValue]]) {
      const cell = document.createElement('span');
      const small = document.createElement('small');
      small.textContent = label;
      cell.append(small, document.createTextNode(shown(c.area, value)));
      sides.append(cell);
    }
    what.append(name, sides);
    if (diff !== undefined) {
      what.append(line(open ? `${diff.differenceId} · ${t('needsReason')}` : `${diff.differenceId} · ${t('explainedAs')}: ${diff.explanation}`));
    }
    row.append(what);
    view.append(row);
  }
  const status = document.createElement('p');
  status.className = 'lead';
  status.id = 'day-status';
  status.textContent = day.signature !== undefined ? `${t('signedDay')} ${day.signature.signedBy} · ${day.signature.signedAt}` : t('unsignedDay');
  view.append(status);
}

/**
 * OB-264 — the bill-wise list for the evening check: the day chosen above, each mirror sale's new bill, the old system's
 * bill number keyed on it, its value and what has come back. Read from the store computer's own disk; shown only in the
 * mirror pilot. A list to check by, never a comparison the screen pretends to have made (that waits for OB-263).
 */
function renderBills() {
  const data = window.migrationData?.mirrorBills;
  const box = el('bills');
  box.hidden = data === undefined || data === null || !Array.isArray(data.bills);
  if (box.hidden) return;
  el('bills-title').textContent = t('billsTitle');
  el('bills-lead').textContent = t('billsLead');
  const day = el('day-date').value;
  const bills = data.bills.filter((b) => b && b.tradingDay === day);
  const list = el('bills-list');
  if (bills.length === 0) { list.replaceChildren(emptyLine(t('billsNone')), ...(data.truncated ? [line(t('billsTruncated'))] : [])); return; }
  const table = document.createElement('table');
  table.id = 'bills-table';
  const head = document.createElement('tr');
  for (const key of ['billNew', 'billOld', 'billAmount', 'billRefunded']) { const th = document.createElement('th'); th.scope = 'col'; th.textContent = t(key); head.append(th); }
  const thead = document.createElement('thead');
  thead.append(head);
  const body = document.createElement('tbody');
  for (const b of bills) {
    const tr = document.createElement('tr');
    for (const v of [b.number, b.oldErpBillNumber, money(b.totalMinor), money(b.refundedMinor)]) { const td = document.createElement('td'); td.textContent = String(v); tr.append(td); }
    body.append(tr);
  }
  table.append(thead, body);
  const total = bills.reduce((n, b) => n + (b.totalMinor ?? 0) - (b.refundedMinor ?? 0), 0);
  list.replaceChildren(table, line(`${bills.length} ${t('billsCount')} · ${money(total)} ${t('billsTotal')}`), ...(data.truncated ? [line(t('billsTruncated'))] : []));
}

function renderDays() {
  const reconciler = window.migrationData?.dailyReconcilerUserId;
  el('day-reconciler').textContent = reconciler === undefined ? t('noReconciler') : `${t('reconciler')}: ${reconciler}`;
  for (const area of AREAS) {
    el(`day-${area}-name`).textContent = t(`area_${area}`);
  }
  for (const node of document.querySelectorAll('#day-areas [data-word]')) node.textContent = t(node.dataset.word);
  if (el('day-date').value === '') el('day-date').value = today();
  renderDay();
  renderBills();
  const list = el('days-list');
  const position = session.parallel();
  // Days the store computer sent, and days entered on this page — saved here even before the store computer has them.
  const all = [...new Set([...(window.migrationData?.parallelDays ?? []).map((d) => d.businessDate), ...enteredHere])].sort().reverse();
  if (position === undefined && all.length === 0) { list.replaceChildren(emptyLine(t('noDays'))); return; }
  list.replaceChildren(...(all.length === 0 ? [emptyLine(t('noDays'))] : all.map((date) => {
    const day = session.day(date);
    const row = document.createElement('div');
    row.className = `row ${day.signature !== undefined ? 'done' : day.unexplained.length > 0 ? 'failed' : 'held'}`;
    const what = document.createElement('span');
    what.className = 'what';
    const name = document.createElement('strong');
    name.textContent = date;
    what.append(name, line(day.signature !== undefined
      ? `${t('signedDay')} ${day.signature.signedBy}`
      : day.unexplained.length > 0 ? `${day.unexplained.length} · ${t('needsReason')}` : t('unsignedDay')));
    const stale = (window.migrationData?.parallelDaySignatures ?? []).some((sg) => sg.businessDate === date && sg.stillApplies === false);
    if (stale && day.signature === undefined) what.append(line(t('resignNeeded')));
    row.append(what);
    return row;
  })));
}

// ── The figures: the witness checks, and the first department's templates ─

function renderWitness() {
  const w = session.witness();
  const box = el('witness-summary');
  box.replaceChildren();
  if (w === undefined) { box.append(emptyLine(t('noWitness'))); el('witness-list').replaceChildren(); return; }
  const covered = (w.covered ?? []).length;
  const missing = w.missing ?? [];
  const headline = document.createElement('span');
  headline.className = 'big';
  headline.textContent = `${covered} / ${covered + missing.length}`;
  box.append(headline, line(`${t('witnessCovered')} · ${w.signaturesOverThisPage ?? 0} ${t('witnessSigned')}`));
  if (missing.length > 0) box.append(line(`${t('witnessMissing')}: ${missing.join(', ')}`));
  el('witness-list').replaceChildren(...(w.findings ?? []).map((f) => {
    const row = document.createElement('div');
    row.className = `row ${f.verdict === 'proved' ? 'passed' : f.verdict === 'not_proved' ? 'failed' : 'flagged'}`;
    const what = document.createElement('span');
    what.className = 'what';
    const name = document.createElement('strong');
    const figure = f.figureMinor !== undefined ? money(f.figureMinor) : (f.figureLabel ?? '');
    name.textContent = `${f.domain.replace(/_/g, ' ')}${figure === '' ? '' : ` — ${figure}`}`;
    what.append(name, line(t(`verdict_${f.verdict}`)));
    if ((f.provedBy ?? []).length > 0) what.append(line(`${t('checkedBy')}: ${f.provedBy.join(', ').replace(/_/g, ' ')}`));
    if (f.whatItCannotProve) what.append(line(`${t('cannotProve')}: ${f.whatItCannotProve}`));
    row.append(what);
    return row;
  }));
}

const TEMPLATE_WORDS = { 'products.csv': 'tpl_products', 'barcodes.csv': 'tpl_barcodes', 'tax-classes.csv': 'tpl_taxClasses', 'prices.csv': 'tpl_prices' };

function renderTemplates() {
  el('templates-list').replaceChildren(...session.sliceTemplates().map((tpl) => {
    const row = document.createElement('div');
    row.className = 'row held';
    const what = document.createElement('span');
    what.className = 'what';
    const name = document.createElement('strong');
    name.textContent = `${t(TEMPLATE_WORDS[tpl.file] ?? tpl.file)} — ${tpl.file}`;
    what.append(name, line(`${t('requiredColumns')}: ${tpl.required.join(', ')}`), line(tpl.columns.join(', ')));
    const button = document.createElement('button');
    button.type = 'button';
    button.id = `template-${tpl.file.replace('.csv', '')}`;
    labelled(button, 'file-text', t('download'));
    // Made here, from the bundled template — no network needed (P-01).
    button.addEventListener('click', () => {
      const url = URL.createObjectURL(new Blob([tpl.csv], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = tpl.file;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    row.append(what, button);
    return row;
  }));
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

// ── Running both: the evening check from the old system's two files (OB-263) ─────────────────────────────────
//
// The owner saves two reports from the old system for the day — the item-wise sales report and the bill-wise list — as
// CSV, and picks them here. The page reads only each file's own header row (for the one-time "which column is which"
// mapping); the store computer reads the figures through the saved mapping, keeps only the pilot department, compares them
// with its own mirror sales and refunds, and keeps the figures (never the files). Every difference needs a reason; then the
// day is signed. All of it on the store computer, with no internet; head office hears it the way a day always goes.

const EC_WORDS = {
  en: {
    title: 'Evening check from the old system\'s files',
    lead: 'Save two reports from the old system for the day, as CSV: the item-wise sales report and the bill-wise list. Pick them below. The first time, say which column is which — once. Then load them: the store computer compares them with the new till, for the pilot department only. Write a reason on every difference, then sign the day.',
    dept: 'Pilot department', deptUnknown: 'The pilot department is not known on this store computer yet — it comes from the department slice once it is applied. Nothing can be compared until then.',
    date: 'Which day', templates: 'Our templates (what each column means)',
    tpl_item_wise: 'Item-wise template', tpl_bill_wise: 'Bill-wise template',
    file_item_wise: '1. The old system\'s item-wise sales report for the day (CSV)', file_bill_wise: '2. The old system\'s bill-wise list for the day (CSV)',
    report_item_wise: 'the item-wise report', report_bill_wise: 'the bill-wise list',
    noFile: 'No file chosen yet.', fileReady: 'Columns found — ready to load', fileNeedsMap: 'Say which column is which (below), once',
    fileMissing: 'The saved mapping names a column this file does not have. If the old system\'s report changed, change the mapping.',
    notCsv: 'Only a CSV file can be read. In Excel: File, Save As, "CSV UTF-8 (Comma delimited)".',
    tooBig: 'This file is too large to be one day\'s report.',
    noHeader: 'No header row was found in this file.',
    mapTitle: 'Which column is which', mapLead: 'For each of our fields, choose the column of the old system\'s report that holds it. Columns you do not choose are never read or kept — a customer\'s name or phone number in the report goes nowhere.',
    choose: '— choose —', notInReport: 'Not in this report',
    dateOrder: 'How does the report write its dates?', dmy: 'Day first (21/10/2026)', mdy: 'Month first (10/21/2026)', ymd: 'Year first (2026-10-21)',
    tax: 'Does the report\'s sales value already include the tax?', taxYes: 'Yes — the value includes tax', taxNo: 'No — the value is before tax',
    pilotValue: 'Which of these is the pilot department?', pilotKept: 'Pilot department in the file',
    linesTax: 'Do the bill lines\' values already include the tax?', linesTaxYes: 'Yes — the line values include tax', linesTaxNo: 'No — the line values are before tax',
    otherDeptRows: 'rows of other departments in the file, not compared', noDeptRows: 'rows with no department written, not compared',
    billsWithoutTax: 'The bill lines are before tax, so the pilot items are compared without tax on both sides.', valueNotKnownBills: 'bill(s) in both whose value without tax is not known (a new-till line has no tax rate), not compared',
    mapSave: 'Save the mapping', mapCancel: 'Cancel', mapSaved: 'Mapping saved on this store computer',
    mappingsTitle: 'Which column is which (saved on this store computer)', noMapping: 'Not mapped yet.', change: 'Change',
    setBy: 'set by', changedBefore: 'earlier mappings',
    tolValue: 'Allowed difference in value (₹)', tolTax: 'Allowed difference in tax (₹)', tolBad: 'The allowed difference must be rupees, 0 or more.',
    load: 'Load and compare', loaded: 'Loaded and compared', bothFiles: 'Pick both files first: the item-wise report and the bill-wise list.',
    notLoaded: 'No files have been loaded for this day yet.',
    totals: 'The day\'s totals (pilot department)', what: 'What', old: 'Old system', new: 'New till', difference: 'Difference',
    value: 'Sales value (₹)', taxRow: 'Tax (₹)', bills: 'Number of bills', qty: 'Quantity',
    notKnown: 'Not known', agrees: 'agrees',
    payments: 'Payments taken (₹)', loyalty: 'Loyalty points', notComparedShort: 'Not compared in the mirror pilot (OB-256, OB-265)',
    items: 'Items that differ', itemsAgree: 'items agree', noItemDiff: 'Every pilot item agrees.',
    item: 'Item', qtyCol: 'Quantity', valueCol: 'Value (₹)', taxCol: 'Tax (₹)',
    notInCat: 'Not in the new catalogue', notInCatLead: 'Items on the old system\'s report that match no product of the new catalogue. Each is a difference.',
    billsTitle: 'Bill by bill', billsLines: 'The bill-wise list has each bill\'s items, so every check below was made.',
    billsPresence: 'The bill-wise list has no item lines. So only this is checked: every bill keyed on the new till is on the old list. Which old bills had pilot items, and their values, cannot be compared.',
    billsMatched: 'bills match', noBillDiff: 'No bill differs.', bill: 'Bill',
    bill_not_keyed: 'On the old system with pilot items, not keyed on the new till', bill_not_on_old: 'Keyed on the new till, not on the old list (mistyped, or another day)', bill_value: 'In both, but the pilot items differ in value',
    explainTitle: 'To explain: returns, credit notes and exchanges on the old system', explainLead: 'The old files show these. They are not matched to anything (exchanges are done on the old system only, OB-269). Write what each one was.',
    readTitle: 'What was read, and what was not compared', otherDepts: 'rows for other departments, not compared', outsideNew: 'new-till lines outside the pilot department, not compared',
    fileRead: 'rows read', totalLines: 'total line(s) at the foot, not used', withoutCode: 'line(s) with no code, not used', underAbove: 'item line(s) under the bill above', dateNotChecked: 'The item-wise report has no date column: check yourself that it is for the chosen day.',
    changed: 'The new till has more sales or refunds for this day since the files were loaded. Load the files again to compare them.',
    reasonsTitle: 'Differences — each needs a reason before the day can be signed', noDiffs: 'No difference beyond the allowed amount.',
    why: 'Why do they differ', side: 'Which one was wrong', explained: 'Reason', by: 'by',
    reasonsSave: 'Save the reasons', reasonsSaved: 'Reasons saved on this store computer', noReasonTyped: 'Write a reason beside at least one difference.',
    statement: 'What you checked (in your own words)', sign: 'Sign the day', signed: 'Day signed', signedBy: 'Signed by',
    unsigned: 'Not signed yet', stillNeeds: 'still need a reason',
    history: 'Loads of this day', current: 'in use now', replaced: 'replaced — kept in the history', voided: 'Signature over replaced figures — no longer applies',
    notSaved: 'Not saved', cannotSign: 'This day cannot be signed yet', relayLater: 'Saved on this store computer. It goes to head office when the line is back.',
    sessionEnded: 'Your office sign-in has ended. Open the migration screen again and enter your PIN.',
    area_sales_value: 'Sales value (₹)', area_tax: 'Tax (₹)', area_sales_count: 'Number of bills', area_stock_movement: 'Quantity',
    area_item_quantity: 'Quantity of', area_item_value: 'Value of', area_item_tax: 'Tax of', area_item_not_in_catalogue: 'Not in the new catalogue:',
    area_bill_not_keyed: 'Not keyed on the new till: old bill', area_bill_not_on_old: 'Not on the old list: old bill', area_bill_value: 'Pilot items differ in value: old bill', area_old_return: 'Return, credit note or exchange on the old system:',
  },
  ta: {
    title: 'பழைய அமைப்பின் கோப்புகளிலிருந்து மாலைச் சரிபார்ப்பு',
    lead: 'அந்த நாளுக்கான இரண்டு அறிக்கைகளைப் பழைய அமைப்பிலிருந்து CSV ஆகச் சேமியுங்கள்: பொருள் வாரியான விற்பனை அறிக்கையும் பில் வாரியான பட்டியலும். கீழே அவற்றைத் தேர்ந்தெடுங்கள். முதல் முறை மட்டும், எந்த நெடுவரிசை எது என்று சொல்லுங்கள். பிறகு ஏற்றுங்கள்: கடைக் கணினி அவற்றைப் புதிய கல்லாவுடன், பைலட் துறைக்கு மட்டும், ஒப்பிடும். ஒவ்வொரு வேறுபாட்டுக்கும் காரணம் எழுதி, பின் நாளில் கையெழுத்திடுங்கள்.',
    dept: 'பைலட் துறை', deptUnknown: 'பைலட் துறை இந்தக் கடைக் கணினிக்கு இன்னும் தெரியவில்லை — துறைப் பகுதி ஏற்றப்பட்ட பிறகு அது வரும். அதுவரை எதையும் ஒப்பிட முடியாது.',
    date: 'எந்த நாள்', templates: 'எங்கள் வார்ப்புருக்கள் (ஒவ்வொரு நெடுவரிசையின் பொருள்)',
    tpl_item_wise: 'பொருள் வாரியான வார்ப்புரு', tpl_bill_wise: 'பில் வாரியான வார்ப்புரு',
    file_item_wise: '1. அந்த நாளுக்கான பழைய அமைப்பின் பொருள் வாரியான விற்பனை அறிக்கை (CSV)', file_bill_wise: '2. அந்த நாளுக்கான பழைய அமைப்பின் பில் வாரியான பட்டியல் (CSV)',
    report_item_wise: 'பொருள் வாரியான அறிக்கை', report_bill_wise: 'பில் வாரியான பட்டியல்',
    noFile: 'இன்னும் கோப்பு தேர்ந்தெடுக்கப்படவில்லை.', fileReady: 'நெடுவரிசைகள் கிடைத்தன — ஏற்றத் தயார்', fileNeedsMap: 'எந்த நெடுவரிசை எது என்று (கீழே) ஒரு முறை சொல்லுங்கள்',
    fileMissing: 'சேமித்த பொருத்தம் சொல்லும் ஒரு நெடுவரிசை இந்தக் கோப்பில் இல்லை. பழைய அமைப்பின் அறிக்கை மாறியிருந்தால், பொருத்தத்தை மாற்றுங்கள்.',
    notCsv: 'CSV கோப்பை மட்டுமே படிக்க முடியும். Excel-இல்: File, Save As, "CSV UTF-8 (Comma delimited)".',
    tooBig: 'இந்தக் கோப்பு ஒரு நாளின் அறிக்கையாக இருக்க மிகப் பெரியது.',
    noHeader: 'இந்தக் கோப்பில் தலைப்பு வரி கிடைக்கவில்லை.',
    mapTitle: 'எந்த நெடுவரிசை எது', mapLead: 'எங்கள் ஒவ்வொரு புலத்துக்கும், அதைக் கொண்டுள்ள பழைய அமைப்பின் அறிக்கையின் நெடுவரிசையைத் தேர்ந்தெடுங்கள். நீங்கள் தேர்ந்தெடுக்காத நெடுவரிசைகள் படிக்கப்படுவதோ வைக்கப்படுவதோ இல்லை — அறிக்கையில் உள்ள வாடிக்கையாளரின் பெயரோ தொலைபேசி எண்ணோ எங்கும் செல்லாது.',
    choose: '— தேர்ந்தெடுங்கள் —', notInReport: 'இந்த அறிக்கையில் இல்லை',
    dateOrder: 'அறிக்கை தேதிகளை எப்படி எழுதுகிறது?', dmy: 'நாள் முதலில் (21/10/2026)', mdy: 'மாதம் முதலில் (10/21/2026)', ymd: 'ஆண்டு முதலில் (2026-10-21)',
    tax: 'அறிக்கையின் விற்பனை மதிப்பில் ஏற்கனவே வரி அடங்கியுள்ளதா?', taxYes: 'ஆம் — மதிப்பில் வரி அடங்கும்', taxNo: 'இல்லை — மதிப்பு வரிக்கு முந்தையது',
    pilotValue: 'இவற்றில் எது பைலட் துறை?', pilotKept: 'கோப்பில் பைலட் துறை',
    linesTax: 'பில் வரிகளின் மதிப்பில் ஏற்கனவே வரி அடங்கியுள்ளதா?', linesTaxYes: 'ஆம் — வரி மதிப்பில் வரி அடங்கும்', linesTaxNo: 'இல்லை — வரி மதிப்பு வரிக்கு முந்தையது',
    otherDeptRows: 'கோப்பில் வேறு துறைகளின் வரிகள், ஒப்பிடப்படவில்லை', noDeptRows: 'துறை எழுதப்படாத வரிகள், ஒப்பிடப்படவில்லை',
    billsWithoutTax: 'பில் வரிகள் வரிக்கு முந்தையவை, எனவே பைலட் பொருட்கள் இரு பக்கமும் வரி இல்லாமல் ஒப்பிடப்படுகின்றன.', valueNotKnownBills: 'இரண்டிலும் உள்ள, வரி இல்லாத மதிப்பு தெரியாத பில்(கள்) (புதிய கல்லா வரியில் வரி விகிதம் இல்லை), ஒப்பிடப்படவில்லை',
    mapSave: 'பொருத்தத்தைச் சேமி', mapCancel: 'ரத்து செய்', mapSaved: 'பொருத்தம் இந்தக் கடைக் கணினியில் சேமிக்கப்பட்டது',
    mappingsTitle: 'எந்த நெடுவரிசை எது (இந்தக் கடைக் கணினியில் சேமிக்கப்பட்டது)', noMapping: 'இன்னும் பொருத்தப்படவில்லை.', change: 'மாற்று',
    setBy: 'அமைத்தவர்', changedBefore: 'முந்தைய பொருத்தங்கள்',
    tolValue: 'மதிப்பில் அனுமதிக்கப்பட்ட வேறுபாடு (₹)', tolTax: 'வரியில் அனுமதிக்கப்பட்ட வேறுபாடு (₹)', tolBad: 'அனுமதிக்கப்பட்ட வேறுபாடு ரூபாயில், 0 அல்லது அதற்கு மேல் இருக்க வேண்டும்.',
    load: 'ஏற்றி ஒப்பிடு', loaded: 'ஏற்றி ஒப்பிடப்பட்டது', bothFiles: 'முதலில் இரண்டு கோப்புகளையும் தேர்ந்தெடுங்கள்: பொருள் வாரியான அறிக்கையும் பில் வாரியான பட்டியலும்.',
    notLoaded: 'இந்த நாளுக்கு இன்னும் எந்தக் கோப்பும் ஏற்றப்படவில்லை.',
    totals: 'நாளின் மொத்தங்கள் (பைலட் துறை)', what: 'எது', old: 'பழைய அமைப்பு', new: 'புதிய கல்லா', difference: 'வேறுபாடு',
    value: 'விற்பனை மதிப்பு (₹)', taxRow: 'வரி (₹)', bills: 'பில்களின் எண்ணிக்கை', qty: 'அளவு',
    notKnown: 'தெரியவில்லை', agrees: 'பொருந்துகிறது',
    payments: 'பெற்ற பணம் (₹)', loyalty: 'விசுவாசப் புள்ளிகள்', notComparedShort: 'மிரர் பைலட்டில் ஒப்பிடப்படுவதில்லை (OB-256, OB-265)',
    items: 'வேறுபடும் பொருட்கள்', itemsAgree: 'பொருட்கள் பொருந்துகின்றன', noItemDiff: 'ஒவ்வொரு பைலட் பொருளும் பொருந்துகிறது.',
    item: 'பொருள்', qtyCol: 'அளவு', valueCol: 'மதிப்பு (₹)', taxCol: 'வரி (₹)',
    notInCat: 'புதிய பட்டியலில் இல்லை', notInCatLead: 'பழைய அமைப்பின் அறிக்கையில் உள்ள, புதிய பட்டியலின் எந்தப் பொருளுடனும் பொருந்தாத பொருட்கள். ஒவ்வொன்றும் ஒரு வேறுபாடு.',
    billsTitle: 'பில் வாரியாக', billsLines: 'பில் வாரியான பட்டியலில் ஒவ்வொரு பில்லின் பொருட்களும் உள்ளன, எனவே கீழே உள்ள எல்லாச் சரிபார்ப்புகளும் செய்யப்பட்டன.',
    billsPresence: 'பில் வாரியான பட்டியலில் பொருள் வரிகள் இல்லை. எனவே இது மட்டுமே சரிபார்க்கப்படுகிறது: புதிய கல்லாவில் பதிவான ஒவ்வொரு பில்லும் பழைய பட்டியலில் உள்ளதா. எந்தப் பழைய பில்களில் பைலட் பொருட்கள் இருந்தன, அவற்றின் மதிப்பு என்ன என்பதை ஒப்பிட முடியாது.',
    billsMatched: 'பில்கள் பொருந்துகின்றன', noBillDiff: 'எந்தப் பில்லும் வேறுபடவில்லை.', bill: 'பில்',
    bill_not_keyed: 'பழைய அமைப்பில் பைலட் பொருட்களுடன் உள்ளது, புதிய கல்லாவில் பதிவாகவில்லை', bill_not_on_old: 'புதிய கல்லாவில் பதிவானது, பழைய பட்டியலில் இல்லை (தவறாக உள்ளிடப்பட்டது, அல்லது வேறு நாள்)', bill_value: 'இரண்டிலும் உள்ளது, ஆனால் பைலட் பொருட்களின் மதிப்பு வேறுபடுகிறது',
    explainTitle: 'விளக்க வேண்டியவை: பழைய அமைப்பில் திருப்பங்கள், கடன் குறிப்புகள், பரிமாற்றங்கள்', explainLead: 'பழைய கோப்புகள் இவற்றைக் காட்டுகின்றன. இவை எதனுடனும் பொருத்தப்படுவதில்லை (பரிமாற்றங்கள் பழைய அமைப்பில் மட்டுமே, OB-269). ஒவ்வொன்றும் என்ன என்று எழுதுங்கள்.',
    readTitle: 'படிக்கப்பட்டவை, ஒப்பிடப்படாதவை', otherDepts: 'வேறு துறைகளின் வரிகள், ஒப்பிடப்படவில்லை', outsideNew: 'பைலட் துறைக்கு வெளியே உள்ள புதிய கல்லா வரிகள், ஒப்பிடப்படவில்லை',
    fileRead: 'வரிகள் படிக்கப்பட்டன', totalLines: 'கடைசியில் உள்ள மொத்த வரி(கள்), பயன்படுத்தப்படவில்லை', withoutCode: 'குறியீடு இல்லாத வரி(கள்), பயன்படுத்தப்படவில்லை', underAbove: 'மேலே உள்ள பில்லின் கீழ் பொருள் வரி(கள்)', dateNotChecked: 'பொருள் வாரியான அறிக்கையில் தேதி நெடுவரிசை இல்லை: அது தேர்ந்தெடுத்த நாளுக்கானது என்று நீங்களே சரிபாருங்கள்.',
    changed: 'கோப்புகள் ஏற்றப்பட்ட பிறகு இந்த நாளுக்குப் புதிய கல்லாவில் மேலும் விற்பனைகள் அல்லது திருப்பங்கள் உள்ளன. ஒப்பிட, கோப்புகளை மீண்டும் ஏற்றுங்கள்.',
    reasonsTitle: 'வேறுபாடுகள் — நாளில் கையெழுத்திடும் முன் ஒவ்வொன்றுக்கும் காரணம் தேவை', noDiffs: 'அனுமதிக்கப்பட்ட அளவுக்கு மேல் எந்த வேறுபாடும் இல்லை.',
    why: 'ஏன் வேறுபடுகின்றன', side: 'எது தவறு', explained: 'காரணம்', by: '—',
    reasonsSave: 'காரணங்களைச் சேமி', reasonsSaved: 'காரணங்கள் இந்தக் கடைக் கணினியில் சேமிக்கப்பட்டன', noReasonTyped: 'குறைந்தது ஒரு வேறுபாட்டின் அருகில் காரணம் எழுதுங்கள்.',
    statement: 'நீங்கள் சரிபார்த்தது (உங்கள் சொந்த வார்த்தைகளில்)', sign: 'நாளில் கையெழுத்திடு', signed: 'நாளில் கையெழுத்திடப்பட்டது', signedBy: 'கையெழுத்திட்டவர்',
    unsigned: 'இன்னும் கையெழுத்திடப்படவில்லை', stillNeeds: 'இன்னும் காரணம் தேவை',
    history: 'இந்த நாளின் ஏற்றங்கள்', current: 'இப்போது பயன்பாட்டில்', replaced: 'மாற்றப்பட்டது — வரலாற்றில் வைக்கப்பட்டுள்ளது', voided: 'மாற்றப்பட்ட கணக்குகள் மீதான கையெழுத்து — இனி பொருந்தாது',
    notSaved: 'சேமிக்கப்படவில்லை', cannotSign: 'இந்த நாளில் இன்னும் கையெழுத்திட முடியாது', relayLater: 'இந்தக் கடைக் கணினியில் சேமிக்கப்பட்டது. இணைப்பு திரும்பியதும் தலைமை அலுவலகத்துக்குச் செல்லும்.',
    sessionEnded: 'உங்கள் அலுவலக உள்நுழைவு முடிந்தது. இடமாற்றத் திரையை மீண்டும் திறந்து உங்கள் PIN-ஐ உள்ளிடுங்கள்.',
    area_sales_value: 'விற்பனை மதிப்பு (₹)', area_tax: 'வரி (₹)', area_sales_count: 'பில்களின் எண்ணிக்கை', area_stock_movement: 'அளவு',
    area_item_quantity: 'அளவு —', area_item_value: 'மதிப்பு —', area_item_tax: 'வரி —', area_item_not_in_catalogue: 'புதிய பட்டியலில் இல்லை:',
    area_bill_not_keyed: 'புதிய கல்லாவில் பதிவாகவில்லை: பழைய பில்', area_bill_not_on_old: 'பழைய பட்டியலில் இல்லை: பழைய பில்', area_bill_value: 'பைலட் பொருட்களின் மதிப்பு வேறுபடுகிறது: பழைய பில்', area_old_return: 'பழைய அமைப்பில் திருப்பம், கடன் குறிப்பு அல்லது பரிமாற்றம்:',
  },
};
/** Each refusal the store computer can give, in the screen's own words (its detail follows, in English, on the English screen). */
const EC_REFUSALS = {
  not_the_named_reconciler: { en: 'Only the person named to reconcile each day can load, explain or sign a day here.', ta: 'ஒவ்வொரு நாளும் சரிபார்க்கப் பெயரிடப்பட்டவர் மட்டுமே இங்கே நாளை ஏற்றவோ, விளக்கவோ, கையெழுத்திடவோ முடியும்.' },
  nobody_named_to_reconcile: { en: 'Nobody has been named to reconcile each day.', ta: 'ஒவ்வொரு நாளும் சரிபார்க்க யாரும் பெயரிடப்படவில்லை.' },
  no_mapping: { en: 'Say which column is which first — once for each report.', ta: 'முதலில் எந்த நெடுவரிசை எது என்று சொல்லுங்கள் — ஒவ்வொரு அறிக்கைக்கும் ஒரு முறை.' },
  mapping_refused: { en: 'The mapping was not saved.', ta: 'பொருத்தம் சேமிக்கப்படவில்லை.' },
  not_csv: { en: 'This is not a CSV file the store computer can read.', ta: 'இது கடைக் கணினி படிக்கக்கூடிய CSV கோப்பு அல்ல.' },
  too_large: { en: 'The file is too large to be one day\'s report.', ta: 'கோப்பு ஒரு நாளின் அறிக்கையாக இருக்க மிகப் பெரியது.' },
  too_many_rows: { en: 'The file has too many rows to be one day\'s report.', ta: 'கோப்பில் ஒரு நாளின் அறிக்கைக்கு மிக அதிக வரிகள் உள்ளன.' },
  header_not_found: { en: 'A column the mapping names is not in the file.', ta: 'பொருத்தம் சொல்லும் ஒரு நெடுவரிசை கோப்பில் இல்லை.' },
  unreadable_rows: { en: 'Some lines could not be read. Nothing was kept.', ta: 'சில வரிகளைப் படிக்க முடியவில்லை. எதுவும் வைக்கப்படவில்லை.' },
  wrong_day: { en: 'The file is for another day. Nothing was kept.', ta: 'கோப்பு வேறு ஒரு நாளுக்கானது. எதுவும் வைக்கப்படவில்லை.' },
  looks_personal: { en: 'The bill number column holds what look like phone numbers. Check the mapping. Nothing was kept.', ta: 'பில் எண் நெடுவரிசையில் தொலைபேசி எண்கள் போலத் தெரிகின்றன. பொருத்தத்தைச் சரிபாருங்கள். எதுவும் வைக்கப்படவில்லை.' },
  code_looks_personal: { en: 'The item code column holds what looks like a phone number. Check the mapping. Nothing was kept.', ta: 'பொருள் குறியீட்டு நெடுவரிசையில் தொலைபேசி எண் போலத் தெரிகிறது. பொருத்தத்தைச் சரிபாருங்கள். எதுவும் வைக்கப்படவில்லை.' },
  repeated_bill: { en: 'A bill is on more than one row.', ta: 'ஒரு பில் ஒன்றுக்கு மேற்பட்ட வரிகளில் உள்ளது.' },
  quantity_not_whole: { en: 'A quantity is not a whole number for an item sold in whole units.', ta: 'முழு அலகுகளில் விற்கப்படும் பொருளுக்கு அளவு முழு எண் அல்ல.' },
  too_many_differences: { en: 'Far too many differences — a wrong column or another day\'s file.', ta: 'மிக அதிக வேறுபாடுகள் — தவறான நெடுவரிசை அல்லது வேறு நாளின் கோப்பு.' },
  no_pilot_department: { en: 'The pilot department is not known yet.', ta: 'பைலட் துறை இன்னும் தெரியவில்லை.' },
  no_catalogue: { en: 'This store computer holds no catalogue yet.', ta: 'இந்தக் கடைக் கணினியில் இன்னும் பொருள் பட்டியல் இல்லை.' },
  day_not_loaded: { en: 'Load the files for this day first.', ta: 'முதலில் இந்த நாளுக்கான கோப்புகளை ஏற்றுங்கள்.' },
  reason_says_nothing: { en: 'Say what really happened, in at least a full sentence.', ta: 'உண்மையில் என்ன நடந்தது என்று குறைந்தது ஒரு முழு வாக்கியத்தில் சொல்லுங்கள்.' },
  reason_refused: { en: 'A reason was refused: say why the systems differ, not which one you prefer.', ta: 'ஒரு காரணம் மறுக்கப்பட்டது: எதை விரும்புகிறீர்கள் என்று அல்ல, அமைப்புகள் ஏன் வேறுபடுகின்றன என்று சொல்லுங்கள்.' },
  already_signed: { en: 'This day is already signed over these figures.', ta: 'இந்தக் கணக்குகளின் மீது இந்த நாளில் ஏற்கனவே கையெழுத்திடப்பட்டுள்ளது.' },
  unexplained_material_difference: { en: 'Some differences still have no reason. Write why for each one, save the reasons, then sign.', ta: 'சில வேறுபாடுகளுக்கு இன்னும் காரணம் இல்லை. ஒவ்வொன்றுக்கும் ஏன் என்று எழுதி, காரணங்களைச் சேமித்து, பின் கையெழுத்திடுங்கள்.' },
  statement_says_nothing: { en: 'Say in your own words what you checked — at least a full sentence.', ta: 'நீங்கள் எதைச் சரிபார்த்தீர்கள் என்று உங்கள் சொந்த வார்த்தைகளில் சொல்லுங்கள் — குறைந்தது ஒரு முழு வாக்கியம்.' },
  could_not_write_durably: { en: 'The store computer could not write to its disk. Nothing was saved — try again.', ta: 'கடைக் கணினி அதன் வட்டில் எழுத முடியவில்லை. எதுவும் சேமிக்கப்படவில்லை — மீண்டும் முயலுங்கள்.' },
  no_sign_in: { en: 'This store computer does not ask for a PIN on office screens, so it cannot tell who you are. Nothing was saved.', ta: 'இந்தக் கடைக் கணினி அலுவலகத் திரைகளில் PIN கேட்பதில்லை, எனவே நீங்கள் யார் என்று அதற்குத் தெரியாது. எதுவும் சேமிக்கப்படவில்லை.' },
  not_allowed: { en: 'You may not use the migration screen.', ta: 'நீங்கள் இடமாற்றத் திரையைப் பயன்படுத்த முடியாது.' },
  not_in_the_mirror_pilot: { en: 'This store computer is not set for the mirror pilot.', ta: 'இந்தக் கடைக் கணினி மிரர் பைலட்டுக்கு அமைக்கப்படவில்லை.' },
  not_readable: { en: 'The store computer could not read the request.', ta: 'கடைக் கணினியால் கோரிக்கையைப் படிக்க முடியவில்லை.' },
  offline: { en: 'The store computer could not be reached. Nothing was saved — try again.', ta: 'கடைக் கணினியை அடைய முடியவில்லை. எதுவும் சேமிக்கப்படவில்லை — மீண்டும் முயலுங்கள்.' },
};
const ec = (key) => EC_WORDS[lang][key] ?? EC_WORDS.en[key] ?? key;
const ecRefusal = (code) => (EC_REFUSALS[code]?.[lang] ?? EC_REFUSALS[code]?.en ?? String(code).replace(/_/g, ' '));
const EC_KINDS = ['item_wise', 'bill_wise'];
const EC_MONEY = new Set(['sales_value', 'tax', 'item_value', 'item_tax', 'bill_value']);
const ecState = {
  data: window.migrationData?.eveningCheck,
  kit: window.eveningCheckKit,
  files: { item_wise: null, bill_wise: null },
  mappings: window.migrationData?.eveningCheck?.mappings ?? { current: {}, history: [] },
  day: undefined,
  mapping: null,
};

/** "1,234.50" or "₹ 12" → paise, by its digits (never through a floating-point number); NaN if not rupees. */
function ecPaise(text) {
  const v = String(text ?? '').replace(/[₹,\s]/g, '');
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(v);
  return m === null ? NaN : Number(m[1]) * 100 + Number(((m[2] ?? '') + '00').slice(0, 2));
}
/** A quantity in its unit's smallest step, worded: 1.234 kg, 500 g, a bare count for "each". */
function ecQty(minor, uom) {
  if (uom === 'kg' || uom === 'L') { const s = minor < 0 ? '-' : ''; const a = Math.abs(minor); return `${s}${Math.floor(a / 1000)}.${String(a % 1000).padStart(3, '0')} ${uom}`; }
  return uom === 'ea' || uom === undefined ? Number(minor).toLocaleString('en-IN') : `${Number(minor).toLocaleString('en-IN')} ${uom}`;
}
/** A figure that may not be known: shown, or null (drawn as "Not known" — never a zero). */
const ecKnown = (k, show) => (k && k.known === true ? show(k.minor) : null);
function ecCell(text, cls) {
  const td = document.createElement('td');
  if (cls) td.className = cls;
  if (text === null) { const s = document.createElement('span'); s.className = 'notknown'; s.textContent = ec('notKnown'); td.append(s); } else td.textContent = text;
  return td;
}
function ecTable(id, heads, rows) {
  const wrap = document.createElement('div');
  wrap.className = 'scroll';
  const table = document.createElement('table');
  table.id = id;
  const head = document.createElement('tr');
  heads.forEach(([word, num]) => { const th = document.createElement('th'); th.scope = 'col'; th.textContent = word; if (num) th.className = 'num'; head.append(th); });
  const thead = document.createElement('thead');
  thead.append(head);
  const body = document.createElement('tbody');
  for (const r of rows) body.append(r);
  table.append(thead, body);
  wrap.append(table);
  return wrap;
}
function ecRow(cells, differs) { const tr = document.createElement('tr'); if (differs) tr.className = 'differs'; tr.append(...cells); return tr; }
function ecHeading(text, id) { const h = document.createElement('h4'); if (id) h.id = id; h.textContent = text; return h; }
function ecPara(text, cls = 'lead', id) { const p = document.createElement('p'); p.className = cls; if (id) p.id = id; p.textContent = text; return p; }

/** Ask the store computer (same page, same sign-in). A box that cannot be reached is said, never assumed saved. */
async function ecCall(path, body) {
  try {
    const res = await fetch(`./evening-check/${path}`, body === undefined
      ? { method: 'GET', credentials: 'same-origin', cache: 'no-store' }
      : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (res.status === 401) return { ok: false, refusedBecause: 'session', detail: '' };
    const out = await res.json().catch(() => ({ ok: false, refusedBecause: 'not_readable', detail: '' }));
    if (out && out.mappings) ecState.mappings = out.mappings;
    return out;
  } catch {
    return { ok: false, refusedBecause: 'offline', detail: '' };
  }
}
function ecTellRefusal(title, out) {
  const head = out.refusedBecause === 'session' ? ec('sessionEnded') : ecRefusal(out.refusedBecause);
  const detail = [lang === 'en' && out.detail ? out.detail : '', ...(out.problems ?? [])].filter((x) => x !== '').join(' · ');
  tell(title, detail === '' ? head : `${head} ${detail}`);
}

/** Read a picked file in the browser: refuse what is not a CSV or too big; decode UTF-8, else Windows' own code page. */
async function ecReadFile(kind) {
  const file = el(`ec-file-${kind}`).files?.[0];
  ecState.files[kind] = null;
  if (!file) { ecPaintFiles(); return; }
  const say = (text) => { ecState.files[kind] = { name: file.name, problem: text }; ecPaintFiles(); };
  if (!/\.csv$/i.test(file.name)) { say(ec('notCsv')); return; }
  if (file.size > (ecState.kit?.maxBytes ?? 5 * 1024 * 1024)) { say(ec('tooBig')); return; }
  let text;
  try {
    const bytes = await file.arrayBuffer();
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { text = new TextDecoder('windows-1252').decode(bytes); }
  } catch { say(ec('notCsv')); return; }
  const header = ecState.kit ? ecState.kit.headerRowOf(text) : { ok: false };
  if (!header.ok) { say(ec('noHeader')); return; }
  ecState.files[kind] = { name: file.name, size: file.size, text, columns: header.columns };
  ecPaintFiles();
  if (ecMissing(kind).length > 0) ecOpenMapping(kind);
}
/** The mapped columns this file lacks — ['*'] when nothing is mapped yet. */
function ecMissing(kind) {
  const f = ecState.files[kind];
  const m = ecState.mappings.current?.[kind];
  if (!f || !f.columns) return [];
  if (!m) return ['*'];
  const have = new Set(f.columns.map((c) => ecState.kit.headerKey(c)));
  return Object.values(m.mapping.columns).filter((c) => !have.has(ecState.kit.headerKey(c)));
}
function ecPaintFiles() {
  for (const kind of EC_KINDS) {
    const f = ecState.files[kind];
    const box = el(`ec-box-${kind}`);
    const state = el(`ec-state-${kind}`);
    if (!f) { box.className = 'file'; state.textContent = ec('noFile'); continue; }
    if (f.problem) { box.className = 'file needs'; state.textContent = `${f.name}: ${f.problem}`; continue; }
    const missing = ecMissing(kind);
    box.className = `file ${missing.length === 0 ? 'ready' : 'needs'}`;
    state.textContent = `${f.name} · ${missing.length === 0 ? ec('fileReady') : missing[0] === '*' ? ec('fileNeedsMap') : `${ec('fileMissing')} (${missing.join(', ')})`}`;
  }
}

/** The one-time "which column is which": a choice per field, from the file's own header row. */
function ecOpenMapping(kind) {
  ecState.mapping = kind;
  const spec = ecState.kit.reports[kind];
  const held = ecState.mappings.current?.[kind]?.mapping;
  const columns = ecState.files[kind]?.columns ?? Object.values(held?.columns ?? {});
  const same = (a, b) => ecState.kit.headerKey(a) === ecState.kit.headerKey(b);
  el('ec-map').hidden = false;
  el('ec-map-title').textContent = `${ec('mapTitle')} — ${ec(`report_${kind}`)}`;
  el('ec-map-lead').textContent = ec('mapLead');
  el('ec-map-fields').replaceChildren(...spec.fields.map((f) => {
    const wrap = document.createElement('div');
    const label = document.createElement('label');
    label.htmlFor = `ec-map-${f.key}`;
    label.textContent = `${f.words[lang] ?? f.words.en}${f.required ? ' *' : ''}`;
    const select = document.createElement('select');
    select.id = `ec-map-${f.key}`;
    const first = document.createElement('option');
    first.value = '';
    first.textContent = f.required ? ec('choose') : ec('notInReport');
    select.append(first, ...columns.map((c) => { const o = document.createElement('option'); o.value = c; o.textContent = c; return o; }));
    const was = held?.columns?.[f.key];
    const match = was === undefined ? undefined : columns.find((c) => same(c, was));
    if (match !== undefined) select.value = match;
    wrap.append(label, select);
    return wrap;
  }));
  const order = el('ec-map-date-order');
  order.replaceChildren(...['', ...ecState.kit.dateOrders].map((v) => { const o = document.createElement('option'); o.value = v; o.textContent = v === '' ? ec('choose') : ec(v); return o; }));
  order.value = held?.dateOrder ?? '';
  el('ec-map-includes-tax-box').hidden = kind !== 'item_wise';
  const tax = el('ec-map-includes-tax');
  tax.replaceChildren(...[['', ec('choose')], ['yes', ec('taxYes')], ['no', ec('taxNo')]].map(([v, w]) => { const o = document.createElement('option'); o.value = v; o.textContent = w; return o; }));
  tax.value = held?.valueIncludesTax === true ? 'yes' : held?.valueIncludesTax === false ? 'no' : '';
  el('ec-map-date-order-label').textContent = ec('dateOrder');
  el('ec-map-includes-tax-label').textContent = ec('tax');
  // OB-263 B: the bill-wise list's question — do its line values include the tax?
  el('ec-map-lines-tax-box').hidden = kind !== 'bill_wise';
  const linesTax = el('ec-map-lines-tax');
  linesTax.replaceChildren(...[['', ec('choose')], ['yes', ec('linesTaxYes')], ['no', ec('linesTaxNo')]].map(([v, w]) => { const o = document.createElement('option'); o.value = v; o.textContent = w; return o; }));
  linesTax.value = held?.lineValuesIncludeTax === true ? 'yes' : held?.lineValuesIncludeTax === false ? 'no' : '';
  el('ec-map-lines-tax-label').textContent = ec('linesTax');
  // OB-263 A: once the department column is chosen, which of ITS values (read from the file) is the pilot department.
  el('ec-map-pilot-label').textContent = ec('pilotValue');
  const paintPilot = () => {
    const column = kind === 'item_wise' ? el('ec-map-department')?.value ?? '' : '';
    el('ec-map-pilot-box').hidden = column === '';
    if (column === '') return;
    const text = ecState.files[kind]?.text;
    const values = text ? ecState.kit.columnValuesOf(text, column) : [];
    const was = held?.pilotDepartmentValue;
    const list = was !== undefined && !values.some((v) => same(v, was)) ? [was, ...values] : values;
    const pick = el('ec-map-pilot-value');
    const before = pick.value;
    pick.replaceChildren(...['', ...list].map((v) => { const o = document.createElement('option'); o.value = v; o.textContent = v === '' ? ec('choose') : v; return o; }));
    const keep = list.find((v) => (before !== '' && same(v, before)) || (before === '' && was !== undefined && same(v, was)));
    pick.value = keep ?? '';
  };
  if (kind === 'item_wise') el('ec-map-department').addEventListener('change', paintPilot);
  paintPilot();
  labelled(el('ec-map-save'), 'list-checks', ec('mapSave'));
  labelled(el('ec-map-cancel'), 'x', ec('mapCancel'));
}
el('ec-map-cancel').addEventListener('click', () => { el('ec-map').hidden = true; ecState.mapping = null; });
el('ec-map-save').addEventListener('click', async () => {
  const kind = ecState.mapping;
  if (!kind) return;
  const columns = {};
  for (const f of ecState.kit.reports[kind].fields) { const v = el(`ec-map-${f.key}`).value; if (v !== '') columns[f.key] = v; }
  const order = el('ec-map-date-order').value;
  const tax = el('ec-map-includes-tax').value;
  const linesTax = el('ec-map-lines-tax').value;
  const pilotValue = el('ec-map-pilot-value').value;
  const mapping = {
    columns, ...(order === '' ? {} : { dateOrder: order }), ...(kind === 'item_wise' && tax !== '' ? { valueIncludesTax: tax === 'yes' } : {}),
    ...(kind === 'item_wise' && columns.department !== undefined && pilotValue !== '' ? { pilotDepartmentValue: pilotValue } : {}),
    ...(kind === 'bill_wise' && linesTax !== '' ? { lineValuesIncludeTax: linesTax === 'yes' } : {}),
  };
  const out = await ecCall('mapping', { report: kind, mapping, ...(ecState.files[kind]?.columns ? { header: ecState.files[kind].columns } : {}) });
  if (!out.ok) { ecTellRefusal(ec('notSaved'), out); return; }
  el('ec-map').hidden = true;
  ecState.mapping = null;
  tell(ec('mapSaved'), `${ec(`report_${kind}`)} · ${ec('setBy')} ${out.mapping.setBy}`, true);
  ecPaintFiles();
  ecPaintMappings();
});

/** The mapping in force for each report — who set it, when — and every earlier one, kept. */
function ecPaintMappings() {
  const fieldWord = (kind, key) => { const f = ecState.kit?.reports[kind].fields.find((x) => x.key === key); return f ? (f.words[lang] ?? f.words.en) : key; };
  el('ec-mappings').replaceChildren(...EC_KINDS.map((kind) => {
    const card = document.createElement('div');
    card.className = 'row held';
    card.id = `ec-mapping-${kind}`;
    const what = document.createElement('span');
    what.className = 'what';
    const name = document.createElement('strong');
    name.textContent = ec(`report_${kind}`);
    what.append(name);
    const m = ecState.mappings.current?.[kind];
    if (!m) what.append(line(ec('noMapping')));
    else {
      what.append(line(`${ec('setBy')} ${m.setBy} · ${m.setAt}`));
      for (const [k, v] of Object.entries(m.mapping.columns)) what.append(line(`${fieldWord(kind, k)} ← ${v}`));
      if (m.mapping.dateOrder) what.append(line(`${ec('dateOrder')} ${ec(m.mapping.dateOrder)}`));
      if (m.mapping.valueIncludesTax !== undefined) what.append(line(m.mapping.valueIncludesTax ? ec('taxYes') : ec('taxNo')));
      if (m.mapping.pilotDepartmentValue !== undefined) what.append(line(`${ec('pilotKept')}: ${m.mapping.pilotDepartmentValue}`));
      if (m.mapping.lineValuesIncludeTax !== undefined) what.append(line(m.mapping.lineValuesIncludeTax ? ec('linesTaxYes') : ec('linesTaxNo')));
      const all = (ecState.mappings.history ?? []).filter((h) => h.report === kind);
      if (all.length > 1) what.append(line(`${ec('changedBefore')}: ${all.slice(0, -1).map((h) => `${h.setBy} · ${h.setAt}`).join('; ')}`));
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.id = `ec-map-change-${kind}`;
    labelled(button, 'list-checks', ec('change'));
    button.addEventListener('click', () => ecOpenMapping(kind));
    card.append(what, button);
    return card;
  }));
}

el('ec-load').addEventListener('click', async () => {
  if (EC_KINDS.some((k) => !ecState.files[k] || !ecState.files[k].text)) { tell(ec('notSaved'), ec('bothFiles')); return; }
  const missing = EC_KINDS.find((k) => ecMissing(k).length > 0);
  if (missing) { ecOpenMapping(missing); tell(ec('notSaved'), ec('fileNeedsMap')); return; }
  const value = ecPaise(el('ec-tol-value').value);
  const tax = ecPaise(el('ec-tol-tax').value);
  if (Number.isNaN(value) || Number.isNaN(tax)) { tell(ec('notSaved'), ec('tolBad')); return; }
  const out = await ecCall('load', { businessDate: el('ec-date').value, itemWise: ecState.files.item_wise.text, billWise: ecState.files.bill_wise.text, tolerance: { valueMinor: value, taxMinor: tax } });
  if (!out.ok) { ecTellRefusal(ec('notSaved'), out); return; }
  ecState.day = out.day;
  ecPaintDay();
  tell(ec('loaded'), `${out.day.differences.length} · ${out.day.unexplained.length} ${ec('stillNeeds')}${out.relayed ? '' : ` · ${ec('relayLater')}`}`, out.day.unexplained.length === 0);
});

/** How one difference reads: its area in words, the item's name or the bill, and the two figures. */
function ecDifferenceWords(d) {
  const check = ecState.day?.current?.check;
  const item = check?.items.find((i) => i.productId === d.subject);
  const subject = d.area.startsWith('item_') && item ? `${item.name ?? item.productId} (${item.productId})` : (d.subject ?? '');
  const comparison = ecState.day?.current?.comparisons.find((c) => c.area === d.area && c.subject === d.subject);
  const uom = d.area === 'stock_movement' ? d.subject : item?.uom;
  const show = (v) => (EC_MONEY.has(d.area) ? money(v) : d.area === 'item_quantity' || d.area === 'stock_movement' || d.area === 'sales_count' ? ecQty(v, uom) : null);
  const figures = comparison && show(comparison.legacyValue) !== null ? ` — ${ec('old')} ${show(comparison.legacyValue)}, ${ec('new')} ${show(comparison.newValue)}` : '';
  return `${ec(`area_${d.area}`)} ${subject}${figures}`.replace(/\s+/g, ' ').trim();
}

function ecPaintDay() {
  const day = ecState.day;
  const result = el('ec-result');
  const reasons = el('ec-reasons');
  const history = el('ec-history');
  const signed = day?.signature !== undefined;
  if (!day || !day.current) {
    result.replaceChildren(emptyLine(ec('notLoaded')));
    reasons.replaceChildren();
    history.replaceChildren(...(day && day.voidedSignatures?.length ? [ecPara(`${ec('voided')}: ${day.voidedSignatures.map((s) => `${s.signedBy} · ${s.signedAt}`).join('; ')}`, 'warn', 'ec-voided')] : []));
    for (const id of ['ec-reasons-save', 'ec-sign', 'ec-statement', 'ec-statement-label']) el(id).hidden = true;
    return;
  }
  for (const id of ['ec-sign', 'ec-statement', 'ec-statement-label']) el(id).hidden = signed;
  const c = day.current.check;
  const parts = [];
  if (day.newTillChangedSinceLoad) parts.push(ecPara(ec('changed'), 'warn', 'ec-changed'));
  parts.push(ecPara(signed ? `${ec('signedBy')} ${day.signature.signedBy} · ${day.signature.signedAt}` : `${ec('unsigned')} · ${day.unexplained.length} ${ec('stillNeeds')}`, 'lead', 'ec-status'));
  // The day's totals, old against new. "Not known" is said, never a zero (P-08).
  // New against old, with its sign in front: "-₹45.00" (the new till has less), "+1".
  const diffCell = (o, n, show) => (n === null || o === null ? ecCell(null, 'num') : ecCell(o === n ? ec('agrees') : `${n < o ? '-' : '+'}${show(Math.abs(n - o))}`, 'num'));
  const tt = c.totals;
  const taxNew = ecKnown(tt.tax.new, (v) => v);
  const billsOld = ecKnown(tt.bills.old, (v) => v);
  const rows = [
    ecRow([ecCell(ec('value')), ecCell(money(tt.value.old), 'num'), ecCell(money(tt.value.new), 'num'), diffCell(tt.value.old, tt.value.new, money)], Math.abs(tt.value.new - tt.value.old) > c.tolerance.valueMinor),
    ecRow([ecCell(ec('taxRow')), ecCell(money(tt.tax.old), 'num'), ecCell(taxNew === null ? null : money(taxNew), 'num'), diffCell(tt.tax.old, taxNew, money)], taxNew !== null && Math.abs(taxNew - tt.tax.old) > c.tolerance.taxMinor),
    ecRow([ecCell(ec('bills')), ecCell(billsOld === null ? null : String(billsOld), 'num'), ecCell(String(tt.bills.new), 'num'), diffCell(billsOld, tt.bills.new, (v) => String(v))], billsOld !== null && billsOld !== tt.bills.new),
    ...tt.quantity.map((q) => ecRow([ecCell(`${ec('qty')} (${q.uom})`), ecCell(ecQty(q.old, q.uom), 'num'), ecCell(ecQty(q.new, q.uom), 'num'), diffCell(q.old, q.new, (v) => ecQty(v, q.uom))], q.old !== q.new)),
    ecRow([ecCell(ec('payments')), ecCell(ec('notComparedShort')), ecCell('—'), ecCell('—')]),
    ecRow([ecCell(ec('loyalty')), ecCell(ec('notComparedShort')), ecCell('—'), ecCell('—')]),
  ];
  parts.push(ecHeading(`${ec('totals')}: ${c.department.name}`, 'ec-totals-title'), ecTable('ec-totals', [[ec('what')], [ec('old'), true], [ec('new'), true], [ec('difference'), true]], rows));
  // Items that differ.
  const differing = c.items.filter((i) => i.differs.length > 0);
  parts.push(ecHeading(ec('items'), 'ec-items-title'));
  parts.push(differing.length === 0 ? emptyLine(ec('noItemDiff')) : ecTable('ec-items', [[ec('item')], [ec('qtyCol'), true], [ec('valueCol'), true], [ec('taxCol'), true]], differing.map((i) => ecRow([
    ecCell(`${i.name ?? i.productId} (${i.productId})`),
    ecCell(`${ecQty(i.old.quantityMinor, i.uom)} → ${ecQty(i.new.quantityMinor, i.uom)}`, 'num'),
    ecCell(`${money(i.old.valueMinor)} → ${money(i.new.valueMinor)}`, 'num'),
    ecCell(i.new.tax.known ? `${money(i.old.taxMinor)} → ${money(i.new.tax.minor)}` : null, 'num'),
  ], true))));
  parts.push(line(`${c.items.length - differing.length} ${ec('itemsAgree')}`));
  if (c.notInCatalogue.length > 0) {
    parts.push(ecHeading(ec('notInCat'), 'ec-notincat-title'), ecPara(ec('notInCatLead')), ecTable('ec-notincat', [[ec('item')], [ec('qtyCol'), true], [ec('valueCol'), true]], c.notInCatalogue.map((n) => ecRow([
      ecCell(n.code), ecCell(String(n.quantityThousandths / 1000), 'num'), ecCell(money(n.valueMinor), 'num'),
    ], true))));
  }
  // Bill by bill, by the old bill number keyed on every mirror sale (OB-264).
  parts.push(ecHeading(ec('billsTitle'), 'ec-bills-title'), ecPara(c.bills.checked === 'lines' ? ec('billsLines') : ec('billsPresence'), 'lead', 'ec-bills-mode'));
  if (c.bills.valueBasis === 'without_tax') parts.push(ecPara(ec('billsWithoutTax'), 'lead', 'ec-bills-basis'));
  if (c.bills.valueNotKnown > 0) parts.push(ecPara(`${c.bills.valueNotKnown} ${ec('valueNotKnownBills')}`, 'warn', 'ec-bills-not-known'));
  parts.push(c.bills.differences.length === 0 ? emptyLine(ec('noBillDiff')) : ecTable('ec-bills', [[ec('bill')], [ec('what')], [ec('valueCol'), true], [ec('new')]], c.bills.differences.map((b) => ecRow([
    ecCell(b.billNumber), ecCell(ec(b.kind === 'not_keyed' ? 'bill_not_keyed' : b.kind === 'not_on_old' ? 'bill_not_on_old' : 'bill_value')),
    ecCell(b.kind === 'value_differs' ? `${money(b.oldValueMinor)} → ${money(b.newValueMinor)}` : (b.oldValueMinor ?? b.newValueMinor) === undefined ? null : money(b.oldValueMinor ?? b.newValueMinor), 'num'),
    ecCell(b.newBill ?? '—'),
  ], true))));
  parts.push(line(`${c.bills.matched} ${ec('billsMatched')}`));
  if (c.explain.length > 0) {
    parts.push(ecHeading(ec('explainTitle'), 'ec-explain-title'), ecPara(ec('explainLead')), ecTable('ec-explain', [[ec('what')], [ec('valueCol'), true]], c.explain.map((e) => ecRow([
      ecCell(e.billNumber ? `${ec('bill')} ${e.billNumber}` : `${ec('item')} ${e.code} (${e.line})`), ecCell(money(e.valueMinor), 'num'),
    ], true))));
  }
  // What was read, and what was set aside — counted, never silently dropped.
  const f = day.current.files;
  parts.push(ecHeading(ec('readTitle'), 'ec-read-title'));
  parts.push(line(`${ec('report_item_wise')}: ${f.itemWise.rowsRead} ${ec('fileRead')} · ${f.itemWise.totalLines} ${ec('totalLines')} · ${f.itemWise.withoutCode} ${ec('withoutCode')}`));
  if (f.itemWise.dateChecked === false) parts.push(ecPara(ec('dateNotChecked'), 'warn', 'ec-date-not-checked'));
  // OB-263 A: the rows the file's own department column set aside — counted and said, never silently dropped.
  if (f.itemWise.department) {
    const d = f.itemWise.department;
    parts.push(ecPara(`${ec('pilotKept')}: ${d.pilotValue} · ${d.otherDepartmentRows} ${ec('otherDeptRows')} · ${d.noDepartmentRows} ${ec('noDeptRows')}`, 'lead', 'ec-dept-rows'));
  }
  parts.push(line(`${ec('report_bill_wise')}: ${f.billWise.rowsRead} ${ec('fileRead')} · ${f.billWise.totalLines} ${ec('totalLines')} · ${f.billWise.withoutCode} ${ec('withoutCode')}${f.billWise.linesUnderBillAbove ? ` · ${f.billWise.linesUnderBillAbove} ${ec('underAbove')}` : ''}`));
  parts.push(line(`${c.otherDepartments.rows} ${ec('otherDepts')} (${money(c.otherDepartments.valueMinor)}) · ${c.newOutsideDepartment.lines} ${ec('outsideNew')}`));
  result.replaceChildren(...parts);

  // The differences, each with its reason — or the box for one.
  const cards = day.differences.map((d) => {
    const card = document.createElement('div');
    const open = day.unexplained.some((u) => u.differenceId === d.differenceId);
    card.className = `diff ${open ? 'open' : 'done'}`;
    card.id = `ec-diff-${d.differenceId}`;
    const name = document.createElement('strong');
    name.textContent = ecDifferenceWords(d);
    const id = document.createElement('small');
    id.textContent = d.differenceId;
    card.append(name, id);
    if (!open) { card.append(line(`${ec('explained')}: ${d.explanation} · ${ec('by')} ${d.ownerUserId}${d.wrongSide ? ` · ${ec('side')}: ${t(`side_${d.wrongSide}`)}` : ''}`)); return card; }
    const whyLabel = document.createElement('label');
    whyLabel.htmlFor = `ec-why-${d.differenceId}`;
    whyLabel.textContent = ec('why');
    const why = document.createElement('input');
    why.type = 'text';
    why.id = `ec-why-${d.differenceId}`;
    why.autocomplete = 'off';
    why.dataset.differenceId = d.differenceId;
    const sideLabel = document.createElement('label');
    sideLabel.htmlFor = `ec-side-${d.differenceId}`;
    sideLabel.textContent = ec('side');
    const side = document.createElement('select');
    side.id = `ec-side-${d.differenceId}`;
    side.append(...['', 'legacy', 'new', 'both', 'neither'].map((v) => { const o = document.createElement('option'); o.value = v; o.textContent = v === '' ? '—' : t(`side_${v}`); return o; }));
    card.append(whyLabel, why, sideLabel, side);
    return card;
  });
  reasons.replaceChildren(ecHeading(ec('reasonsTitle'), 'ec-reasons-title'), ...(cards.length === 0 ? [emptyLine(ec('noDiffs'))] : cards));
  el('ec-reasons-save').hidden = day.unexplained.length === 0;

  // Every load of the day: the one in use, the ones it replaced (kept), and any signature over replaced figures.
  history.replaceChildren(ecHeading(ec('history'), 'ec-history-title'),
    ...day.history.map((h) => line(`${h.loadedAt} · ${h.loadedBy} · ${h.current ? ec('current') : ec('replaced')}${h.signedBy ? ` · ${ec('signedBy')} ${h.signedBy}` : ''}`)),
    ...(day.voidedSignatures.length > 0 ? [ecPara(`${ec('voided')}: ${day.voidedSignatures.map((s) => `${s.signedBy} · ${s.signedAt}`).join('; ')}`, 'warn', 'ec-voided')] : []));
}

el('ec-reasons-save').addEventListener('click', async () => {
  const reasons = [...document.querySelectorAll('#ec-reasons input[data-difference-id]')]
    .map((input) => ({ differenceId: input.dataset.differenceId, explanation: input.value.trim(), side: el(`ec-side-${input.dataset.differenceId}`).value }))
    .filter((r) => r.explanation !== '')
    .map((r) => ({ differenceId: r.differenceId, explanation: r.explanation, ...(r.side === '' ? {} : { wrongSide: r.side }) }));
  if (reasons.length === 0) { tell(ec('notSaved'), ec('noReasonTyped')); return; }
  const out = await ecCall('reasons', { businessDate: el('ec-date').value, reasons });
  if (!out.ok) { ecTellRefusal(ec('notSaved'), out); return; }
  ecState.day = out.day;
  ecPaintDay();
  tell(ec('reasonsSaved'), `${out.day.unexplained.length} ${ec('stillNeeds')}${out.relayed ? '' : ` · ${ec('relayLater')}`}`, out.day.unexplained.length === 0);
});
el('ec-sign').addEventListener('click', async () => {
  const out = await ecCall('sign', { businessDate: el('ec-date').value, statement: el('ec-statement').value });
  if (!out.ok) { ecTellRefusal(ec('cannotSign'), out); return; }
  el('ec-statement').value = '';
  ecState.day = out.day;
  ecPaintDay();
  tell(ec('signed'), `${ec('signedBy')} ${out.signature.signedBy}${out.relayed ? '' : ` · ${ec('relayLater')}`}`, true);
});
for (const kind of EC_KINDS) {
  el(`ec-file-${kind}`).addEventListener('change', () => { void ecReadFile(kind); });
  // Made here, from the bundled template — no network needed (P-01).
  el(`ec-template-${kind}`).addEventListener('click', () => {
    if (!ecState.kit) return;
    const url = URL.createObjectURL(new Blob([ecState.kit.templateCsv(kind)], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = ecState.kit.reports[kind].file;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}
async function ecLoadDay() {
  const date = el('ec-date').value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { ecState.day = undefined; ecPaintDay(); return; }
  const out = await ecCall(`day?date=${encodeURIComponent(date)}`);
  ecState.day = out.ok ? out.day : undefined;
  ecPaintDay();
}
el('ec-date').addEventListener('change', () => {
  // The same day below, so the bill-wise list and the typed day follow it.
  el('day-date').value = el('ec-date').value;
  renderDay();
  renderBills();
  void ecLoadDay();
});

function renderEvening() {
  const box = el('ec');
  box.hidden = ecState.data === undefined || ecState.data === null || ecState.kit === undefined;
  if (box.hidden) return;
  for (const [id, key] of [['ec-title', 'title'], ['ec-lead', 'lead'], ['ec-date-label', 'date'], ['ec-templates-title', 'templates'],
    ['ec-file-item_wise-label', 'file_item_wise'], ['ec-file-bill_wise-label', 'file_bill_wise'], ['ec-mappings-title', 'mappingsTitle'],
    ['ec-tol-value-label', 'tolValue'], ['ec-tol-tax-label', 'tolTax'], ['ec-statement-label', 'statement']]) el(id).textContent = ec(key);
  el('ec-dept').textContent = ecState.data.department ? `${ec('dept')}: ${ecState.data.department.name} (${ecState.data.department.categoryId})` : ec('deptUnknown');
  labelled(el('ec-template-item_wise'), 'file-text', ec('tpl_item_wise'));
  labelled(el('ec-template-bill_wise'), 'file-text', ec('tpl_bill_wise'));
  labelled(el('ec-load'), 'git-compare-arrows', ec('load'));
  labelled(el('ec-reasons-save'), 'clipboard-check', ec('reasonsSave'));
  labelled(el('ec-sign'), 'badge-check', ec('sign'));
  if (el('ec-date').value === '') el('ec-date').value = el('day-date').value || today();
  if (ecState.mapping) ecOpenMapping(ecState.mapping);
  ecPaintFiles();
  ecPaintMappings();
  ecPaintDay();
}
if (ecState.data !== undefined && ecState.data !== null) setTimeout(() => { void ecLoadDay(); }, 0);

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
    ['witness-title', 'witnessTitle'], ['witness-lead', 'witnessLead'],
    ['templates-title', 'templatesTitle'], ['templates-lead', 'templatesLead'],
    ['day-title', 'dayTitle'], ['day-lead', 'dayLead'], ['day-date-label', 'dayDate'],
    ['day-import-label', 'dayImport'], ['day-statement-label', 'dayStatement'], ['days-title', 'daysTitle'],
  ]) {
    el(id).textContent = t(key);
  }
  labelled(el('day-save'), 'clipboard-check', t('daySave'));
  labelled(el('day-sign'), 'badge-check', t('daySign'));

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
  buildAreas();
  renderDays();
  renderEvening();
  renderWitness();
  renderTemplates();
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

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
