// W3 · MG-01 · MG-03 · MG-07 · MG-08 · MG-09 · MG-12 · MG-11 (roadmap §30 migration controls) — the "Old system checks"
// office page's tested, DOM-free session. Until now these head-office routes had no caller on any screen: a named person
// could only discover the old sources, approve a code mapping, decide a left-behind exclusion, compare two exports, check
// the switch-over night, undo an opening load or assess retiring the old system by hand-made API calls.
//
// The page is a THIN CLIENT. Every rule is head office's (services/migration/src): the session only refuses what it can see
// is incomplete before asking, sends what the person typed (never their name — head office takes the signed-in person),
// and folds every answer into one Outcome the page shows in head office's own words. Nothing is read or written on open
// or on a timer; every act is an explicit click. Synthetic data only in tests; the routes refuse a production target (#7).

import type { ViewerIdentity } from './browser-entry';
import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

// ── what head office answers (the parts the page shows) ─────────────────────────────────────────────────────

export const SOURCE_KINDS = Object.freeze(['erp_database', 'pos_database', 'spreadsheet', 'paper', 'third_party_system', 'report_only'] as const);
export const VOLUME_BASES = Object.freeze(['counted', 'estimated', 'unknown'] as const);
export const MAPPING_DOMAINS = Object.freeze(['tax_code', 'uom', 'department', 'account', 'branch', 'identity', 'document_kind'] as const);
export const EXCLUSION_SCOPES = Object.freeze(['documents_before', 'entity_kind', 'named_records', 'inactive_records'] as const);

export interface SourceDraft {
  readonly sourceId: string; readonly name: string; readonly kind: string; readonly ownerUserId: string;
  readonly rowCount: string; readonly volumeBasis: string; readonly retentionYears: string; readonly extractable: boolean;
}
export interface LegacySourceBody {
  readonly sourceId: string; readonly name: string; readonly kind: string; readonly volumeBasis: string; readonly extractable: boolean;
  readonly ownerUserId?: string; readonly rowCount?: number; readonly retentionYears?: number;
}
export interface DiscoveryRead {
  readonly complete: boolean; readonly countedRows: number; readonly detail: string;
  readonly gaps: readonly { readonly sourceId: string; readonly name: string; readonly kind: string; readonly detail: string }[];
}
export interface MappingEntryBody { readonly domain: string; readonly legacyValue: string; readonly targetValue: string; readonly rationale: string }
export interface ObservedBody { readonly domain: string; readonly value: string; readonly rows: number }
export interface MappingTableRead {
  readonly mappingId: string; readonly tenantId: string; readonly version: number; readonly status: string;
  readonly entries: readonly MappingEntryBody[]; readonly approvedBy?: string; readonly approvedAt?: string;
}
export interface CoverageRead {
  readonly fullyCovered: boolean; readonly totalAffectedRows: number; readonly detail: string;
  readonly byDomain: readonly { readonly domain: string; readonly distinctValues: number; readonly covered: number; readonly uncovered: readonly string[]; readonly affectedRows: number }[];
}
export interface ExclusionRead {
  readonly exclusionId: string; readonly scope: string; readonly description: string; readonly recordCount: number; readonly valueMinor: number;
  readonly reason: string; readonly status: 'proposed' | 'approved' | 'rejected'; readonly proposedBy: string; readonly proposedAt: string;
  readonly approvedBy?: string; readonly approvedAt?: string; readonly ownerStatement?: string;
}
export interface ExclusionsRead { readonly exclusions: readonly ExclusionRead[]; readonly position: { readonly detail: string } }
export interface ExportDomainRead { readonly domain: string; readonly words: { readonly en: string; readonly ta: string }; readonly fields: readonly { readonly key: string; readonly required: boolean; readonly words: { readonly en: string; readonly ta: string } }[] }
export interface ExportRunRead {
  readonly diffId: string; readonly domain: string; readonly baselineLabel: string; readonly latestLabel: string; readonly by: string; readonly at: string;
  readonly counts: { readonly baseline: number; readonly latest: number; readonly added: number; readonly changed: number; readonly removed: number; readonly unchanged: number };
  readonly undecided?: number; readonly exceptionIds: readonly string[];
}
export interface ExportDiffsRead { readonly runs: readonly ExportRunRead[]; readonly domains: readonly ExportDomainRead[] }
export interface ExportDiffResult { readonly run: ExportRunRead; readonly detail?: string; readonly alreadyRecorded?: boolean }
export interface WindowRead {
  readonly cutoverId: string; readonly go: boolean; readonly openNow: boolean;
  readonly window: { readonly opensAt: string; readonly closesAt: string; readonly goBy: string } | null;
  readonly theCutover?: { readonly cutoverId: string; readonly opensAt: string; readonly closesAt: string };
}
export interface NightCheckRead {
  readonly rollBackNow: boolean; readonly detail: string; readonly cutoverId: string | null;
  readonly crossed: readonly { readonly limit: string; readonly detail: string }[];
  readonly notKnown: readonly string[];
  readonly newlyRaised: readonly unknown[];
}
export interface ReversalLine { readonly domain: string; readonly key: string; readonly openedMinor: number; readonly reversedMinor: number; readonly netMinor: number }
export interface ReversalRead {
  readonly request: { readonly loadId: string; readonly cutoverId: string; readonly reason: string; readonly requestedBy: string; readonly requestedAt: string };
  readonly approval: { readonly approvedBy: string; readonly approvedAt: string } | null;
  readonly position: readonly ReversalLine[]; readonly reversedToZero: boolean;
}
export interface RetirementRead {
  readonly archiveId: string; readonly mayRetireSystem: boolean; readonly blockedBy: readonly string[];
  readonly retentionEndsOn: string; readonly dataIsNeverDeleted: true; readonly detail: string;
}
export interface RetirementDraft {
  readonly archiveId: string; readonly sourceId: string; readonly digest: string; readonly rowCount: string; readonly archivedOn: string;
  readonly retentionYears: string; readonly earliestRecordDate: string; readonly latestRecordDate: string; readonly restoreVerifiedOn: string;
  readonly cutoverAccepted: boolean; readonly openAssessments: string;
}

// ── words ───────────────────────────────────────────────────────────────────────────────────────────────────

export const OLD_SYSTEM_COPY = {
  en: {
    lang: 'தமிழ்', title: 'Old system checks',
    lead: 'The office steps of moving from the old system: list what it keeps, approve how its codes map, decide what is left behind, compare two exports, check the switch-over night, undo an opening load inside its window, and check whether the old system may be switched off. Head office checks every step; nothing here deletes old data.',
    nobody: 'Nobody is signed in on this screen — you can read nothing and change nothing.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was changed.',
    notAllowed: 'Your role cannot do this step.', done: 'Done.', recorded: 'Recorded at head office, in your name.',
    // MG-01
    discH: 'What the old shop keeps its records in', discLead: 'Add each place the old shop keeps records — the old program, spreadsheets, paper files. Head office names every gap: nobody owning it, a guessed row count, no keeping period, no way to get the data out. This check keeps nothing — keep the list.',
    srcId: 'Short name (letters and digits)', srcName: 'What it is', srcKind: 'Kind', srcOwner: 'Who answers for it (their sign-in)', srcRows: 'How many rows', srcBasis: 'Row count is', srcRetention: 'Keep for (years)', srcExtract: 'We can get the data out',
    k_erp_database: 'The old shop program', k_pos_database: 'The old till program', k_spreadsheet: 'A spreadsheet', k_paper: 'Paper files', k_third_party_system: 'Another company\'s system', k_report_only: 'Only printed reports',
    b_counted: 'counted', b_estimated: 'a guess', b_unknown: 'not known',
    addSource: 'Add to the list', checkSources: 'Check the list', sourcesNone: 'Nothing on the list yet.',
    discComplete: 'The list is complete', discGaps: 'gap(s) — the list is not complete', countedRowsK: 'rows counted',
    noSourceId: 'Give the source a short name of letters and digits.', noSourceName: 'Say what the source is.', noKind: 'Choose its kind.', noBasis: 'Say whether its row count is counted, a guess or not known.',
    noRows: 'Rows is a whole number.', noRetention: 'Keep-for is a whole number of years.', noSources: 'Add at least one source first.', sameSource: 'That short name is already on the list.',
    // MG-03
    mapH: 'How the old codes map', mapLead: 'Each old code (a tax code, a unit, a department…) and what it means here, with why. Approving it puts your name and today on it, and head office refuses one old code meaning two things. Then check the approved mapping covers every value the old data actually carries.',
    mapId: 'Mapping name', mapVersion: 'Version', mapDomain: 'What kind of code', mapOld: 'Old code', mapNew: 'Means here', mapWhy: 'Why',
    d_tax_code: 'Tax code', d_uom: 'Unit', d_department: 'Department', d_account: 'Account', d_branch: 'Branch', d_identity: 'Person or customer number', d_document_kind: 'Document kind',
    addEntry: 'Add this code', seenH: 'Values seen in the old data', seenValue: 'Value', seenRows: 'Rows carrying it', addSeen: 'Add this value',
    checkCoverage: 'Check the approved mapping covers the old data', approveMapping: 'Approve this mapping', approveFirst: 'Approve the mapping first — head office measures coverage only with an approved mapping.', entriesNone: 'No codes yet.', seenNone: 'No values yet.',
    coverageFull: 'Every value in the old data is covered', coverageGaps: 'rows carry a value nothing covers',
    approvedBy: 'Approved by', approvedAt: 'on', saveTable: 'Save the approved mapping (keep it for the load)',
    noMapId: 'Give the mapping a name.', noVersion: 'Version is a whole number from 1.', noDomain: 'Choose what kind of code.', noOld: 'Type the old code.', noNew: 'Type what it means here.', noWhy: 'Say why — this is what anybody reads a year from now.',
    noEntries: 'Add at least one code first.', noSeen: 'Add the values seen in the old data first.', noSeenValue: 'Type the value.', noSeenRows: 'Rows is a whole number.', notReady: 'Head office is not ready — read who is signed in first.',
    // MG-07
    exclH: 'Old records left behind', exclLead: 'Leaving old records behind needs a written, valued reason — age alone is never one — and the owner\'s written decision. Until the owner decides, it explains nothing in the figures.',
    showExclusions: 'Show the list', exclNone: 'Nothing has been proposed to leave behind.',
    exclId: 'Short name', exclScope: 'What is left behind', exclDesc: 'Describe it', exclCount: 'How many records', exclValue: 'Value (₹)', exclReason: 'Why it cannot be used',
    s_documents_before: 'Documents before a date', s_entity_kind: 'A whole kind of record', s_named_records: 'Named records', s_inactive_records: 'Records not used any more',
    proposeExclusion: 'Propose leaving it behind', decideExclusion: 'Record my decision', approveK: 'Approve', rejectK: 'Reject', statementK: 'Your decision, in writing',
    st_proposed: 'waiting for the owner', st_approved: 'approved by the owner', st_rejected: 'rejected by the owner', proposedByK: 'proposed by', decidedByK: 'decided by',
    noExclId: 'Give it a short name.', noScope: 'Choose what is left behind.', noDesc: 'Describe it.', noCount: 'How many records — a whole number.', noValue: 'Value in rupees, for example 1250.50.', noReason: 'Say why it cannot be used.',
    noChoice: 'Choose approve or reject.', noStatement: 'Write your decision.',
    // MG-09
    diffH: 'Compare two exports from the old system', diffLead: 'The export that was loaded, and a newer one. Every difference becomes a problem to decide on the migration list — nothing is applied.',
    showDiffs: 'Show the comparisons', diffId: 'Name this comparison', diffDomain: 'What was exported', diffColumn: 'their column for', baselineFile: 'The export that was loaded (CSV)', latestFile: 'The newer export (CSV)',
    runDiff: 'Compare them', diffsNone: 'No comparison yet.', addedK: 'new', changedK: 'changed', removedK: 'gone', unchangedK: 'same', undecidedK: 'still to decide',
    noDiffId: 'Name the comparison (letters, digits, dot, dash).', noDiffDomain: 'Choose what was exported.', noFiles: 'Choose both export files.', noColumns: 'Name their column for every required field.', domainsFirst: 'Show the comparisons first — head office tells the page what each export holds.',
    // night, window, reversal (MG-11 / MG-08)
    nightH: 'The switch-over night', nightLead: 'The window to undo an opening load opens at the owner\'s switch-over GO and closes 48 hours later. The night check compares what head office sees with the limits the owner agreed.',
    cutoverId: 'Switch-over name', showWindow: 'Show the window', nightCheck: 'Check the night now',
    noGo: 'No switch-over GO is on record — the window has not opened.', windowOpen: 'Window OPEN', windowClosed: 'Window closed', opensK: 'opens', closesK: 'closes', goByK: 'GO given by', notTheCutover: 'This is not the shop\'s switch-over — that one is',
    rollBackNow: 'ROLL BACK NOW — an agreed limit is crossed', limitsHold: 'No agreed limit is crossed', notJudged: 'Could not be judged',
    loadId: 'Opening load', reverseReason: 'Why it must be undone', askReverse: 'Ask to undo this opening load', approveReverse: 'Approve undoing it (a second person)', showReverse: 'Show what it undid',
    reversedZero: 'Every domain is back to zero', notYetReversed: 'Not undone yet', requestedByK: 'asked by', approvedByK: 'approved by', openedK: 'opened', reversedK: 'taken back', netK: 'left',
    noCutover: 'Name the switch-over.', noLoad: 'Name the opening load.', noReverseReason: 'Say why it must be undone.',
    // MG-12
    retireH: 'Switching the old system off', retireLead: 'Switching the old system off never deletes the old data. Head office checks the keeping period from the latest record, that a restore from the archive was shown to work, that the switch-over was accepted, and that nobody still needs the records.',
    archiveId: 'Archive name', archiveSource: 'Which source', archiveDigest: 'Archive fingerprint', archiveRows: 'Rows in it', archivedOn: 'Archived on', retentionYears: 'Keep for (years)',
    earliest: 'Oldest record', latest: 'Newest record', restoreOn: 'Restore shown to work on (leave empty if never)', cutoverAccepted: 'The switch-over was accepted', openAssessments: 'Open questions that could still need the records',
    assess: 'Check whether it may be switched off', mayRetire: 'The old system MAY be switched off', mayNot: 'Not yet', keepUntil: 'keep the records until', neverDeleted: 'The old data is never deleted, whatever else happens.',
    r_retention_not_elapsed: 'the keeping period has not ended', r_restore_never_verified: 'nobody has shown a restore from the archive works', r_cutover_not_accepted: 'the switch-over is not accepted', r_open_assessment: 'open questions could still need the records',
    noArchive: 'Fill in every archive field (fingerprint, rows, dates).', noOpen: 'Open questions is a whole number (0 if none).',
  },
  ta: {
    lang: 'English', title: 'பழைய முறை சோதனைகள்',
    lead: 'பழைய முறையிலிருந்து மாறுவதன் அலுவலகப் படிகள்: அது வைத்திருப்பவற்றைப் பட்டியலிடு, அதன் குறியீடுகள் எப்படிப் பொருந்துகின்றன என்பதை ஒப்புக்கொள், விட்டுச் செல்வதை முடிவு செய், இரண்டு ஏற்றுமதிகளை ஒப்பிடு, மாறும் இரவைச் சோதி, தொடக்க ஏற்றத்தை அதன் கால அளவுக்குள் திரும்பப் பெறு, பழைய முறையை அணைக்கலாமா என்று சோதி. ஒவ்வொரு படியையும் தலைமை அலுவலகம் சோதிக்கிறது; இங்கே எதுவும் பழைய தரவை அழிப்பதில்லை.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்கவோ மாற்றவோ முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் மாற்றப்படவில்லை.',
    notAllowed: 'உங்கள் பங்கு இந்தப் படியைச் செய்ய முடியாது.', done: 'முடிந்தது.', recorded: 'உங்கள் பெயரில் தலைமை அலுவலகத்தில் பதிவு செய்யப்பட்டது.',
    discH: 'பழைய கடை பதிவுகளை வைத்திருக்கும் இடங்கள்', discLead: 'பழைய கடை பதிவுகளை வைத்திருக்கும் ஒவ்வொரு இடத்தையும் சேர்க்கவும் — பழைய நிரல், விரிதாள்கள், காகிதக் கோப்புகள். ஒவ்வொரு இடைவெளியையும் தலைமை அலுவலகம் பெயரிடுகிறது: பொறுப்பாளர் இல்லை, ஊகித்த வரிசை எண்ணிக்கை, வைத்திருக்கும் காலம் இல்லை, தரவை வெளியே எடுக்க வழி இல்லை. இந்தச் சோதனை எதையும் சேமிப்பதில்லை — பட்டியலை வைத்திருங்கள்.',
    srcId: 'சுருக்கப் பெயர் (எழுத்துகள், எண்கள்)', srcName: 'அது என்ன', srcKind: 'வகை', srcOwner: 'பொறுப்பாளர் (அவரது உள்நுழைவு)', srcRows: 'எத்தனை வரிசைகள்', srcBasis: 'வரிசை எண்ணிக்கை', srcRetention: 'வைத்திருக்கும் காலம் (ஆண்டுகள்)', srcExtract: 'தரவை வெளியே எடுக்க முடியும்',
    k_erp_database: 'பழைய கடை நிரல்', k_pos_database: 'பழைய கவுண்டர் நிரல்', k_spreadsheet: 'விரிதாள்', k_paper: 'காகிதக் கோப்புகள்', k_third_party_system: 'வேறு நிறுவனத்தின் முறை', k_report_only: 'அச்சிட்ட அறிக்கைகள் மட்டும்',
    b_counted: 'எண்ணியது', b_estimated: 'ஊகம்', b_unknown: 'தெரியாது',
    addSource: 'பட்டியலில் சேர்', checkSources: 'பட்டியலைச் சோதி', sourcesNone: 'பட்டியலில் இன்னும் எதுவும் இல்லை.',
    discComplete: 'பட்டியல் முழுமையானது', discGaps: 'இடைவெளி(கள்) — பட்டியல் முழுமையாக இல்லை', countedRowsK: 'எண்ணிய வரிசைகள்',
    noSourceId: 'இடத்திற்கு எழுத்து, எண்களால் ஆன சுருக்கப் பெயர் கொடுக்கவும்.', noSourceName: 'அது என்ன என்று சொல்லவும்.', noKind: 'அதன் வகையைத் தேர்ந்தெடுக்கவும்.', noBasis: 'வரிசை எண்ணிக்கை எண்ணியதா, ஊகமா, தெரியாததா என்று சொல்லவும்.',
    noRows: 'வரிசைகள் முழு எண்.', noRetention: 'வைத்திருக்கும் காலம் முழு ஆண்டுகள்.', noSources: 'முதலில் குறைந்தது ஒரு இடத்தைச் சேர்க்கவும்.', sameSource: 'அந்தச் சுருக்கப் பெயர் ஏற்கனவே பட்டியலில் உள்ளது.',
    mapH: 'பழைய குறியீடுகள் எப்படிப் பொருந்துகின்றன', mapLead: 'ஒவ்வொரு பழைய குறியீடும் (வரிக் குறியீடு, அலகு, துறை…) இங்கே என்ன பொருள், ஏன் என்பதுடன். பழைய தரவில் உண்மையில் உள்ள ஒவ்வொரு மதிப்பையும் பொருத்தம் உள்ளடக்குகிறதா என்று தலைமை அலுவலகம் சோதிக்கிறது; ஒரு பழைய குறியீடு இரண்டு பொருள் தருவதை மறுக்கிறது. ஒப்புதல் உங்கள் பெயரையும் இன்றைய நாளையும் அதில் இடுகிறது.',
    mapId: 'பொருத்தத்தின் பெயர்', mapVersion: 'பதிப்பு', mapDomain: 'எந்த வகைக் குறியீடு', mapOld: 'பழைய குறியீடு', mapNew: 'இங்கே பொருள்', mapWhy: 'ஏன்',
    d_tax_code: 'வரிக் குறியீடு', d_uom: 'அலகு', d_department: 'துறை', d_account: 'கணக்கு', d_branch: 'கிளை', d_identity: 'நபர் அல்லது வாடிக்கையாளர் எண்', d_document_kind: 'ஆவண வகை',
    addEntry: 'இந்தக் குறியீட்டைச் சேர்', seenH: 'பழைய தரவில் காணப்பட்ட மதிப்புகள்', seenValue: 'மதிப்பு', seenRows: 'அதைக் கொண்ட வரிசைகள்', addSeen: 'இந்த மதிப்பைச் சேர்',
    checkCoverage: 'ஒப்புக்கொண்ட பொருத்தம் பழைய தரவை உள்ளடக்குகிறதா என்று சோதி', approveMapping: 'இந்தப் பொருத்தத்தை ஒப்புக்கொள்', approveFirst: 'முதலில் பொருத்தத்தை ஒப்புக்கொள்ளவும் — ஒப்புக்கொண்ட பொருத்தத்துடன் மட்டுமே தலைமை அலுவலகம் உள்ளடக்கத்தை அளவிடுகிறது.', entriesNone: 'இன்னும் குறியீடுகள் இல்லை.', seenNone: 'இன்னும் மதிப்புகள் இல்லை.',
    coverageFull: 'பழைய தரவின் ஒவ்வொரு மதிப்பும் உள்ளடக்கப்பட்டது', coverageGaps: 'வரிசைகளில் எதுவும் உள்ளடக்காத மதிப்பு உள்ளது',
    approvedBy: 'ஒப்புக்கொண்டவர்', approvedAt: 'நாள்', saveTable: 'ஒப்புக்கொண்ட பொருத்தத்தைச் சேமி (ஏற்றத்திற்கு வைத்திருங்கள்)',
    noMapId: 'பொருத்தத்திற்குப் பெயர் கொடுக்கவும்.', noVersion: 'பதிப்பு 1 முதல் முழு எண்.', noDomain: 'எந்த வகைக் குறியீடு என்று தேர்ந்தெடுக்கவும்.', noOld: 'பழைய குறியீட்டைத் தட்டச்சு செய்யவும்.', noNew: 'இங்கே அதன் பொருளைத் தட்டச்சு செய்யவும்.', noWhy: 'ஏன் என்று சொல்லவும் — ஓராண்டு கழித்து யாரும் படிப்பது இதுவே.',
    noEntries: 'முதலில் குறைந்தது ஒரு குறியீட்டைச் சேர்க்கவும்.', noSeen: 'முதலில் பழைய தரவில் காணப்பட்ட மதிப்புகளைச் சேர்க்கவும்.', noSeenValue: 'மதிப்பைத் தட்டச்சு செய்யவும்.', noSeenRows: 'வரிசைகள் முழு எண்.', notReady: 'தலைமை அலுவலகம் தயாராக இல்லை — முதலில் யார் உள்நுழைந்துள்ளார் என்று படிக்கவும்.',
    exclH: 'விட்டுச் செல்லும் பழைய பதிவுகள்', exclLead: 'பழைய பதிவுகளை விட்டுச் செல்ல எழுத்தில், மதிப்புடன் காரணம் தேவை — வயது மட்டும் ஒருபோதும் காரணம் அல்ல — உரிமையாளரின் எழுத்து முடிவும் தேவை. உரிமையாளர் முடிவு செய்யும் வரை அது எண்களில் எதையும் விளக்காது.',
    showExclusions: 'பட்டியலைக் காட்டு', exclNone: 'விட்டுச் செல்ல எதுவும் முன்மொழியப்படவில்லை.',
    exclId: 'சுருக்கப் பெயர்', exclScope: 'எது விட்டுச் செல்லப்படுகிறது', exclDesc: 'அதை விவரிக்கவும்', exclCount: 'எத்தனை பதிவுகள்', exclValue: 'மதிப்பு (₹)', exclReason: 'ஏன் பயன்படுத்த முடியாது',
    s_documents_before: 'ஒரு நாளுக்கு முந்தைய ஆவணங்கள்', s_entity_kind: 'ஒரு முழு வகைப் பதிவு', s_named_records: 'பெயரிட்ட பதிவுகள்', s_inactive_records: 'இனி பயன்படாத பதிவுகள்',
    proposeExclusion: 'விட்டுச் செல்ல முன்மொழி', decideExclusion: 'என் முடிவைப் பதிவு செய்', approveK: 'ஒப்புக்கொள்', rejectK: 'மறு', statementK: 'உங்கள் முடிவு, எழுத்தில்',
    st_proposed: 'உரிமையாளருக்காகக் காத்திருக்கிறது', st_approved: 'உரிமையாளர் ஒப்புக்கொண்டார்', st_rejected: 'உரிமையாளர் மறுத்தார்', proposedByK: 'முன்மொழிந்தவர்', decidedByK: 'முடிவு செய்தவர்',
    noExclId: 'சுருக்கப் பெயர் கொடுக்கவும்.', noScope: 'எது விட்டுச் செல்லப்படுகிறது என்று தேர்ந்தெடுக்கவும்.', noDesc: 'அதை விவரிக்கவும்.', noCount: 'எத்தனை பதிவுகள் — முழு எண்.', noValue: 'மதிப்பு ரூபாயில், எ.கா. 1250.50.', noReason: 'ஏன் பயன்படுத்த முடியாது என்று சொல்லவும்.',
    noChoice: 'ஒப்புக்கொள் அல்லது மறு என்று தேர்ந்தெடுக்கவும்.', noStatement: 'உங்கள் முடிவை எழுதவும்.',
    diffH: 'பழைய முறையின் இரண்டு ஏற்றுமதிகளை ஒப்பிடு', diffLead: 'ஏற்றப்பட்ட ஏற்றுமதியும் புதியதும். ஒவ்வொரு வேறுபாடும் தரவு மாற்றப் பட்டியலில் முடிவு செய்ய வேண்டிய சிக்கலாகிறது — எதுவும் பயன்படுத்தப்படுவதில்லை.',
    showDiffs: 'ஒப்பீடுகளைக் காட்டு', diffId: 'இந்த ஒப்பீட்டுக்குப் பெயர்', diffDomain: 'என்ன ஏற்றுமதி செய்யப்பட்டது', diffColumn: 'இதற்கான அவர்களின் நெடுவரிசை', baselineFile: 'ஏற்றப்பட்ட ஏற்றுமதி (CSV)', latestFile: 'புதிய ஏற்றுமதி (CSV)',
    runDiff: 'ஒப்பிடு', diffsNone: 'இன்னும் ஒப்பீடு இல்லை.', addedK: 'புதியவை', changedK: 'மாறியவை', removedK: 'போனவை', unchangedK: 'அதேவை', undecidedK: 'இன்னும் முடிவு செய்ய வேண்டியவை',
    noDiffId: 'ஒப்பீட்டுக்குப் பெயரிடவும் (எழுத்துகள், எண்கள், புள்ளி, கோடு).', noDiffDomain: 'என்ன ஏற்றுமதி செய்யப்பட்டது என்று தேர்ந்தெடுக்கவும்.', noFiles: 'இரண்டு ஏற்றுமதிக் கோப்புகளையும் தேர்ந்தெடுக்கவும்.', noColumns: 'தேவையான ஒவ்வொரு புலத்திற்கும் அவர்களின் நெடுவரிசையைப் பெயரிடவும்.', domainsFirst: 'முதலில் ஒப்பீடுகளைக் காட்டவும் — ஒவ்வொரு ஏற்றுமதியிலும் என்ன உள்ளது என்று தலைமை அலுவலகம் சொல்கிறது.',
    nightH: 'மாறும் இரவு', nightLead: 'தொடக்க ஏற்றத்தைத் திரும்பப் பெறும் கால அளவு உரிமையாளரின் மாற்ற GO-வில் திறந்து 48 மணி நேரத்தில் மூடுகிறது. இரவுச் சோதனை தலைமை அலுவலகம் காண்பதை உரிமையாளர் ஒப்புக்கொண்ட வரம்புகளுடன் ஒப்பிடுகிறது.',
    cutoverId: 'மாற்றத்தின் பெயர்', showWindow: 'கால அளவைக் காட்டு', nightCheck: 'இரவை இப்போது சோதி',
    noGo: 'மாற்ற GO எதுவும் பதிவில் இல்லை — கால அளவு திறக்கவில்லை.', windowOpen: 'கால அளவு திறந்துள்ளது', windowClosed: 'கால அளவு மூடியது', opensK: 'திறப்பு', closesK: 'மூடல்', goByK: 'GO கொடுத்தவர்', notTheCutover: 'இது கடையின் மாற்றம் அல்ல — அது',
    rollBackNow: 'இப்போதே பின்வாங்கு — ஒப்புக்கொண்ட வரம்பு மீறப்பட்டது', limitsHold: 'ஒப்புக்கொண்ட எந்த வரம்பும் மீறப்படவில்லை', notJudged: 'மதிப்பிட முடியவில்லை',
    loadId: 'தொடக்க ஏற்றம்', reverseReason: 'ஏன் திரும்பப் பெற வேண்டும்', askReverse: 'இந்தத் தொடக்க ஏற்றத்தைத் திரும்பப் பெறக் கேள்', approveReverse: 'திரும்பப் பெறுவதை ஒப்புக்கொள் (இரண்டாம் நபர்)', showReverse: 'திரும்பப் பெற்றதைக் காட்டு',
    reversedZero: 'ஒவ்வொரு பகுதியும் பூஜ்யத்திற்குத் திரும்பியது', notYetReversed: 'இன்னும் திரும்பப் பெறவில்லை', requestedByK: 'கேட்டவர்', approvedByK: 'ஒப்புக்கொண்டவர்', openedK: 'திறந்தது', reversedK: 'திரும்பப் பெற்றது', netK: 'மீதி',
    noCutover: 'மாற்றத்தின் பெயரைக் கொடுக்கவும்.', noLoad: 'தொடக்க ஏற்றத்தின் பெயரைக் கொடுக்கவும்.', noReverseReason: 'ஏன் திரும்பப் பெற வேண்டும் என்று சொல்லவும்.',
    retireH: 'பழைய முறையை அணைத்தல்', retireLead: 'பழைய முறையை அணைப்பது பழைய தரவை ஒருபோதும் அழிப்பதில்லை. சமீபத்திய பதிவிலிருந்து வைத்திருக்கும் காலம், காப்பகத்திலிருந்து மீட்பு வேலை செய்வது காட்டப்பட்டதா, மாற்றம் ஏற்கப்பட்டதா, யாருக்கும் இன்னும் பதிவுகள் தேவையா என்று தலைமை அலுவலகம் சோதிக்கிறது.',
    archiveId: 'காப்பகப் பெயர்', archiveSource: 'எந்த இடம்', archiveDigest: 'காப்பகக் கைரேகை', archiveRows: 'அதில் வரிசைகள்', archivedOn: 'காப்பகப்படுத்திய நாள்', retentionYears: 'வைத்திருக்கும் காலம் (ஆண்டுகள்)',
    earliest: 'பழமையான பதிவு', latest: 'சமீபத்திய பதிவு', restoreOn: 'மீட்பு வேலை செய்வது காட்டப்பட்ட நாள் (இல்லையெனில் காலியாக விடவும்)', cutoverAccepted: 'மாற்றம் ஏற்கப்பட்டது', openAssessments: 'இன்னும் பதிவுகள் தேவைப்படக்கூடிய திறந்த கேள்விகள்',
    assess: 'அணைக்கலாமா என்று சோதி', mayRetire: 'பழைய முறையை அணைக்கலாம்', mayNot: 'இன்னும் இல்லை', keepUntil: 'பதிவுகளை வைத்திருக்க வேண்டிய நாள் வரை', neverDeleted: 'எது நடந்தாலும் பழைய தரவு ஒருபோதும் அழிக்கப்படுவதில்லை.',
    r_retention_not_elapsed: 'வைத்திருக்கும் காலம் முடியவில்லை', r_restore_never_verified: 'காப்பகத்திலிருந்து மீட்பு வேலை செய்வதை யாரும் காட்டவில்லை', r_cutover_not_accepted: 'மாற்றம் ஏற்கப்படவில்லை', r_open_assessment: 'திறந்த கேள்விகளுக்கு இன்னும் பதிவுகள் தேவைப்படலாம்',
    noArchive: 'காப்பகத்தின் ஒவ்வொரு புலத்தையும் நிரப்பவும் (கைரேகை, வரிசைகள், நாட்கள்).', noOpen: 'திறந்த கேள்விகள் முழு எண் (இல்லையெனில் 0).',
  },
} as const;
export type OldSystemCopyKey = keyof typeof OLD_SYSTEM_COPY.en;
export const oldSystemWords = (lang: Lang, key: OldSystemCopyKey | string): string =>
  (OLD_SYSTEM_COPY[lang] as Record<string, string>)[key] ?? (OLD_SYSTEM_COPY.en as Record<string, string>)[key] ?? key;
export const oldSystemOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => oldSystemWords(lang, k), out);

/** Paise as rupees, Indian grouping. */
export const rupees = (minor: number): string => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ── the pure checks the page makes before asking ───────────────────────────────────────────────────────────

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const whole = (s: string): number | undefined => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : undefined);
type Invalid = { readonly result: 'invalid'; readonly why: string };
const invalid = (why: string): Invalid => ({ result: 'invalid', why });

/** One source as typed → the body head office reads, or why it cannot be sent. An empty owner / rows / retention is sent as absent: that IS the gap. */
export function readSource(d: SourceDraft): LegacySourceBody | Invalid {
  if (!ID.test(d.sourceId.trim())) return invalid('noSourceId');
  if (d.name.trim() === '') return invalid('noSourceName');
  if (!(SOURCE_KINDS as readonly string[]).includes(d.kind)) return invalid('noKind');
  if (!(VOLUME_BASES as readonly string[]).includes(d.volumeBasis)) return invalid('noBasis');
  const rows = d.rowCount.trim() === '' ? undefined : whole(d.rowCount);
  if (d.rowCount.trim() !== '' && rows === undefined) return invalid('noRows');
  const years = d.retentionYears.trim() === '' ? undefined : whole(d.retentionYears);
  if (d.retentionYears.trim() !== '' && years === undefined) return invalid('noRetention');
  return {
    sourceId: d.sourceId.trim(), name: d.name.trim(), kind: d.kind, volumeBasis: d.volumeBasis, extractable: d.extractable,
    ...(d.ownerUserId.trim() === '' ? {} : { ownerUserId: d.ownerUserId.trim() }),
    ...(rows === undefined ? {} : { rowCount: rows }), ...(years === undefined ? {} : { retentionYears: years }),
  };
}

export function readEntry(d: { readonly domain: string; readonly legacyValue: string; readonly targetValue: string; readonly rationale: string }): MappingEntryBody | Invalid {
  if (!(MAPPING_DOMAINS as readonly string[]).includes(d.domain)) return invalid('noDomain');
  if (d.legacyValue.trim() === '') return invalid('noOld');
  if (d.targetValue.trim() === '') return invalid('noNew');
  if (d.rationale.trim() === '') return invalid('noWhy');
  return { domain: d.domain, legacyValue: d.legacyValue.trim(), targetValue: d.targetValue.trim(), rationale: d.rationale.trim() };
}

export function readSeen(d: { readonly domain: string; readonly value: string; readonly rows: string }): ObservedBody | Invalid {
  if (!(MAPPING_DOMAINS as readonly string[]).includes(d.domain)) return invalid('noDomain');
  if (d.value.trim() === '') return invalid('noSeenValue');
  const rows = whole(d.rows);
  if (rows === undefined) return invalid('noSeenRows');
  return { domain: d.domain, value: d.value.trim(), rows };
}

/** "1250.50" → 125050 paise; undefined when it is not a rupee amount. */
export function paiseOf(text: string): number | undefined {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text.trim().replace(/,/g, ''));
  if (m === null) return undefined;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

/** The download the approved table is kept as — the chain-of-custody copy the load reads. */
export function approvedTableFile(t: MappingTableRead): { readonly name: string; readonly href: string } {
  return { name: `${t.mappingId}-v${t.version}-approved.json`, href: `data:application/json;charset=utf-8,${encodeURIComponent(`${JSON.stringify(t, null, 2)}\n`)}` };
}

// ── the session ───────────────────────────────────────────────────────────────────────────────────────────

export interface OldSystemMay {
  readonly named: boolean;
  readonly discover: boolean; readonly mapRead: boolean; readonly mapApprove: boolean;
  readonly exclusionsRead: boolean; readonly propose: boolean; readonly decideExclusion: boolean;
  readonly diffRead: boolean; readonly diffRun: boolean;
  readonly windowRead: boolean; readonly cutoverDecide: boolean;
  readonly retire: boolean;
}

export interface OldSystemSession {
  readonly may: OldSystemMay;
  discover(sources: readonly LegacySourceBody[]): Promise<Outcome<DiscoveryRead>>;
  /** Coverage is measured with the APPROVED table (head office maps nothing with a draft — a draft is a proposal). */
  coverage(observed: readonly ObservedBody[]): Promise<Outcome<CoverageRead>>;
  approveMapping(table: { readonly mappingId: string; readonly version: string; readonly entries: readonly MappingEntryBody[] }): Promise<Outcome<MappingTableRead>>;
  exclusions(): Promise<Outcome<ExclusionsRead>>;
  proposeExclusion(d: { readonly exclusionId: string; readonly scope: string; readonly description: string; readonly recordCount: string; readonly value: string; readonly reason: string }): Promise<Outcome<ExclusionRead>>;
  decideExclusion(exclusionId: string, choice: string, statement: string): Promise<Outcome<ExclusionRead>>;
  exportDiffs(): Promise<Outcome<ExportDiffsRead>>;
  runExportDiff(d: { readonly diffId: string; readonly domain: string; readonly columns: Readonly<Record<string, string>>; readonly baseline: { readonly csv: string; readonly label: string } | null; readonly latest: { readonly csv: string; readonly label: string } | null }, domains: readonly ExportDomainRead[]): Promise<Outcome<ExportDiffResult>>;
  window(cutoverId: string): Promise<Outcome<WindowRead>>;
  nightCheck(): Promise<Outcome<NightCheckRead>>;
  askReversal(loadId: string, cutoverId: string, reason: string): Promise<Outcome<unknown>>;
  approveReversal(loadId: string): Promise<Outcome<unknown>>;
  reversal(loadId: string): Promise<Outcome<ReversalRead>>;
  assessRetirement(d: RetirementDraft): Promise<Outcome<RetirementRead>>;
}

export function createOldSystemSession(input: { readonly viewer: ViewerIdentity | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string }): OldSystemSession {
  const perms = new Set(input.viewer?.permissions ?? []);
  const named = input.viewer?.userId !== undefined;
  const has = (p: string): boolean => named && perms.has(p);
  const may: OldSystemMay = {
    named,
    discover: has('migration.discovery.read'), mapRead: has('migration.mapping.read'), mapApprove: has('migration.mapping.approve'),
    exclusionsRead: has('migration.reconciliation.read'), propose: has('migration.exclusion.propose'), decideExclusion: has('migration.exclusion.approve'),
    diffRead: has('migration.cleaning.read'), diffRun: has('migration.exception.record'),
    windowRead: has('migration.parallel.read'), cutoverDecide: has('migration.cutover.decide'),
    retire: has('migration.retirement.assess'),
  };
  const call = makeCaller({ keyPrefix: 'old-system', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const gate = (right: boolean): Invalid | undefined => (!named ? invalid('nobody') : right ? undefined : invalid('notAllowed'));
  // The mapping table is built FOR this shop: its tenant is head office's answer about who is signed in, never typed.
  let tenantId: string | undefined;
  /** The table head office last approved on this page — what coverage is measured with. */
  let approved: MappingTableRead | undefined;
  const tenant = async (): Promise<string | Invalid> => {
    if (tenantId !== undefined) return tenantId;
    const me = await call<{ tenantId?: string }>('GET', '/v1/identity/me');
    if (me.result !== 'ok' || typeof me.value.tenantId !== 'string') return invalid('notReady');
    tenantId = me.value.tenantId;
    return tenantId;
  };
  const tableOf = async (t: { readonly mappingId: string; readonly version: string; readonly entries: readonly MappingEntryBody[] }): Promise<MappingTableRead | Invalid> => {
    if (!ID.test(t.mappingId.trim())) return invalid('noMapId');
    const version = whole(t.version);
    if (version === undefined || version < 1) return invalid('noVersion');
    if (t.entries.length === 0) return invalid('noEntries');
    const tid = await tenant();
    if (typeof tid !== 'string') return tid;
    return { mappingId: t.mappingId.trim(), tenantId: tid, version, status: 'draft', entries: t.entries };
  };
  const enc = encodeURIComponent;
  return {
    may,
    discover: async (sources) => gate(may.discover) ?? (sources.length === 0 ? invalid('noSources') : call('POST', '/v1/migration/discovery', { sources })),
    coverage: async (observed) => {
      const no = gate(may.mapRead); if (no) return no;
      if (approved === undefined) return invalid('approveFirst');
      if (observed.length === 0) return invalid('noSeen');
      return call('POST', '/v1/migration/mapping/coverage', { table: approved, observed });
    },
    approveMapping: async (t) => {
      const no = gate(may.mapApprove); if (no) return no;
      const table = await tableOf(t); if ('result' in table) return table;
      const out = await call<MappingTableRead>('POST', '/v1/migration/mapping/approve', { table });
      if (out.result === 'ok') approved = out.value; // head office's approved table, exactly as it came back
      return out;
    },
    exclusions: async () => gate(may.exclusionsRead) ?? call('GET', '/v1/migration/history/exclusions'),
    proposeExclusion: async (d) => {
      const no = gate(may.propose); if (no) return no;
      if (!ID.test(d.exclusionId.trim())) return invalid('noExclId');
      if (!(EXCLUSION_SCOPES as readonly string[]).includes(d.scope)) return invalid('noScope');
      if (d.description.trim() === '') return invalid('noDesc');
      const count = whole(d.recordCount); if (count === undefined) return invalid('noCount');
      const value = paiseOf(d.value); if (value === undefined) return invalid('noValue');
      if (d.reason.trim() === '') return invalid('noReason');
      return call('POST', '/v1/migration/history/exclusions', { exclusionId: d.exclusionId.trim(), scope: d.scope, description: d.description.trim(), recordCount: count, valueMinor: value, reason: d.reason.trim() });
    },
    decideExclusion: async (id, choice, statement) => {
      const no = gate(may.decideExclusion); if (no) return no;
      if (choice !== 'approve' && choice !== 'reject') return invalid('noChoice');
      if (statement.trim() === '') return invalid('noStatement');
      return call('POST', `/v1/migration/history/exclusions/${enc(id)}/decision`, { approve: choice === 'approve', ownerStatement: statement.trim() });
    },
    exportDiffs: async () => gate(may.diffRead) ?? call('GET', '/v1/migration/export-diffs'),
    runExportDiff: async (d, domains) => {
      const no = gate(may.diffRun); if (no) return no;
      if (!ID.test(d.diffId.trim())) return invalid('noDiffId');
      const spec = domains.find((x) => x.domain === d.domain);
      if (domains.length === 0) return invalid('domainsFirst');
      if (spec === undefined) return invalid('noDiffDomain');
      if (d.baseline === null || d.latest === null || d.baseline.csv === '' || d.latest.csv === '') return invalid('noFiles');
      const mapping: Record<string, string> = {};
      for (const f of spec.fields) {
        const col = (d.columns[f.key] ?? '').trim();
        if (col !== '') mapping[f.key] = col;
        else if (f.required) return invalid('noColumns');
      }
      return call('POST', `/v1/migration/export-diffs/${enc(d.diffId.trim())}`, { domain: d.domain, mapping, baseline: d.baseline, latest: d.latest });
    },
    window: async (cutoverId) => gate(may.windowRead) ?? (cutoverId.trim() === '' ? invalid('noCutover') : call('GET', `/v1/migration/cutover/windows/${enc(cutoverId.trim())}`)),
    nightCheck: async () => gate(may.cutoverDecide) ?? call('POST', '/v1/migration/cutover/night-check', {}),
    askReversal: async (loadId, cutoverId, reason) => {
      const no = gate(may.cutoverDecide); if (no) return no;
      if (loadId.trim() === '') return invalid('noLoad');
      if (cutoverId.trim() === '') return invalid('noCutover');
      if (reason.trim() === '') return invalid('noReverseReason');
      // Only WHICH cutover and WHY — what is taken back is head office's, from the load's own register (hard rule #10).
      return call('POST', `/v1/migration/opening-reversals/${enc(loadId.trim())}`, { cutoverId: cutoverId.trim(), reason: reason.trim() });
    },
    approveReversal: async (loadId) => gate(may.cutoverDecide) ?? (loadId.trim() === '' ? invalid('noLoad') : call('POST', `/v1/migration/opening-reversals/${enc(loadId.trim())}/approval`, {})),
    reversal: async (loadId) => gate(may.windowRead) ?? (loadId.trim() === '' ? invalid('noLoad') : call('GET', `/v1/migration/opening-reversals/${enc(loadId.trim())}`)),
    assessRetirement: async (d) => {
      const no = gate(may.retire); if (no) return no;
      const rows = whole(d.rowCount); const years = whole(d.retentionYears); const open = whole(d.openAssessments);
      if (!ID.test(d.archiveId.trim()) || d.sourceId.trim() === '' || d.digest.trim() === '' || rows === undefined || years === undefined
        || !DAY.test(d.archivedOn.trim()) || !DAY.test(d.earliestRecordDate.trim()) || !DAY.test(d.latestRecordDate.trim())
        || (d.restoreVerifiedOn.trim() !== '' && !DAY.test(d.restoreVerifiedOn.trim()))) return invalid('noArchive');
      if (open === undefined) return invalid('noOpen');
      return call('POST', '/v1/migration/retirement/assessment', {
        archive: {
          archiveId: d.archiveId.trim(), sourceId: d.sourceId.trim(), digest: d.digest.trim(), rowCount: rows, archivedAt: `${d.archivedOn.trim()}T00:00:00.000Z`,
          retentionYears: years, earliestRecordDate: d.earliestRecordDate.trim(), latestRecordDate: d.latestRecordDate.trim(), readOnly: true,
          ...(d.restoreVerifiedOn.trim() === '' ? {} : { restoreVerifiedAt: `${d.restoreVerifiedOn.trim()}T00:00:00.000Z` }),
        },
        cutoverAccepted: d.cutoverAccepted, openAssessments: open,
      });
    },
  };
}
