// W5 (platform, access, approvals and data-import administration) — the tested, DOM-free sessions behind the sections this
// wave adds to existing office pages. Each section reads and writes ONLY head office's own routes, in the signed-in person's
// own session (same-origin, a fresh idempotency key on every write, `makeCaller`), and hands every refusal back in head
// office's words. The page holds no rule: it asks the route's own permission before it offers a button (OB-572), refuses only
// blank input before a POST, and never writes on open. Every word has a Tamil twin.
//
//   Store computers    OB-87 conflicts register · OB-54 refusals and stamped records       (GET only)
//   Approvals          M02-FR-03 aged approvals report                                    (GET only)
//   Approval rules     M01-FR-03 a rule's history, preview of an older version, rollback asked → approved → applied
//   Delegation         M02-FR-03 effective authority today (own, lent, or none)
//   Users & roles      OB-165/167 Internal Committee member change (asked → second person → applied) · SEC-11 token revocation
//   Store devices      M33-FR-02 remote sessions (end one), version policy (set) and remote kill of a broken release
//   Roll-out           M33-FR-04 licences (record, list, expiry alerts to a named owner)
//   Integration health M32-FR-03 secrets: which exist, their age and rotation state, and the review — NEVER a value
//   Incidents          M35-FR-04 link a raised alert to an incident · M33-FR-04 platform service requests
//   Administration     M33-FR-03 support-access review
//   Document templates PA-09 reproduce an issued document and reprint it (a numbered, audited duplicate)
//   Owner alerts       M29-FR-04 a scheduled report's run history
//   Compare stores     M29-FR-02 drill audit (who looked at which transactions)
//   Cash office        OB-82 place a till's old records at their store, once
//   Data in and out    OB-315 kept dry runs · M30-FR-04 import data quality and job history
//
// Synthetic data only; no secret value is ever read, held or shown (hard rule 4) — the secrets routes carry vault
// REFERENCES, and this page shows only which secrets exist, their dates and their state.

import { makeCaller, newId, type Outcome } from './r4-insight-call';
import { pagedQuery, pagedAnswer, type RegisterAsk } from './register-paging';

export type Lang = 'en' | 'ta';
export type Viewer = { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
type Why = 'nobody' | 'cannot' | 'needAll' | 'needReason' | 'notVersion' | 'notDate' | 'confirmKill' | 'notMoney';
export type W5Outcome<T> = Outcome<T, Why>;

const WORDS = {
  en: {
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was changed.',
    nobody: 'Nobody is signed in on this screen — you can read nothing and change nothing.',
    cannot: 'Your role cannot do this.', needAll: 'Fill in every box marked for this.', needReason: 'Say, in writing, why.',
    notVersion: 'Write a version as numbers, like 1.4.2.', notDate: 'Write the date as YYYY-MM-DD.',
    confirmKill: 'Tick the box to confirm you are withdrawing this release.', notMoney: 'Write rupees, like 2000 or 2000.50.',
    show: 'Show', showAgain: 'Show again', none: 'Nothing to show.', reading: 'Reading from head office…', done: 'Done.',
    by: 'by', at: 'at', reason: 'Why', notSet: 'Not set',
    // Store computers — OB-87 · OB-54
    regH: 'Records head office kept aside', regLead: 'Kept for ever, never deleted: writes refused because the same key came back with different content, records a store computer sent for another store, and records head office stamped with the store computer\'s own store. Read only.',
    conflictsH: 'Same key, different content (refused)', refusalsH: 'Refused: sent for another store', overruledH: 'Taken first by the wrong store (head office placed it elsewhere)', stampsH: 'Stamped with the store computer\'s store',
    bill: 'bill', storeNamed: 'it named store', credStore: 'its sign-in is for store', noCredStore: 'its sign-in names no store',
    // Approvals — M02-FR-03
    agedH: 'Aged approvals', agedLead: 'Every approval still waiting, how long it has waited, and when it goes to the owner; and every one that already went to the owner.',
    waitingH: 'Still waiting', escalatedH: 'Sent to the owner', waited: 'waited', minutes: 'minutes', escalatesAt: 'goes to the owner at', alreadyEscalated: 'already sent to the owner', waitIs: 'the wait is', waitNotSet: 'no wait set',
    // Approval rules — M01-FR-03
    histH: 'A rule\'s history and going back to an older version', histLead: 'Every version of a rule, oldest first. To go back, preview what an older version would change, ask for it, and once it is approved apply it here — it is saved as a new version; nothing is overwritten.',
    ruleL: 'Which rule', r_limits: 'Money limits', 'r_escalation-waits': 'Escalation waits', 'r_price-check': 'Price-check size',
    inForce: 'In force: version', version: 'Version', restored: 'restored version', noVersions: 'Not changed since the owner\'s figures of 23 Oct 2026 — there is no older version to go back to.',
    preview: 'Preview going back to this', askBack: 'Ask to go back to this version', previewNoChange: 'Going back to this version changes nothing.',
    previewNotValid: 'This version would not be valid now:', changes: 'It would change', needsSecond: 'It needs a second person\'s approval.',
    askedBack: 'Asked. It waits for approval on the Approvals page.', askedBackH: 'Going back you asked for', applyBack: 'Apply the approved change',
    appliedBack: 'Applied. The older figures are in force as a new version.',
    st_waiting: 'Waiting for approval', st_approved: 'Approved — apply it now', st_rejected: 'Rejected', st_expired: 'Expired — ask again', st_used: 'Applied',
    toVersion: 'back to version',
    // Delegation — M02-FR-03
    effH: 'What may this person approve today?', effLead: 'Head office answers from the delegations in force today (or on a day you name): authority lent to them, or none.',
    whoL: 'Person (their user id)', kindL: 'Kind of decision', onL: 'On (YYYY-MM-DD, optional — today if empty)', ask: 'Ask head office',
    k_refund: 'Refunds', k_price_change: 'Price changes', k_purchase_order: 'Purchase orders', k_stock_adjustment: 'Stock corrections', k_day_reopen: 'Reopening a closed day',
    src_own_authority: 'Their own authority', src_delegated: 'Lent to them', src_none: 'No authority', onBehalf: 'on behalf of', limit: 'up to', stores: 'stores', allStores: 'all stores',
    // Users — OB-165 · SEC-11
    icH: 'Internal Committee members', icLead: 'The owner adds or removes a committee member. A second person (a store manager) approves exactly that change on the Approvals page in their own session; then the owner applies it here. It needs a fresh two-step sign-in.',
    icWho: 'Member of staff (their user id)', icAction: 'Change', icAdd: 'Add to the committee', icRemove: 'Remove from the committee', icAsk: 'Ask a second person to approve',
    icAsked: 'Asked. A second person approves it on the Approvals page.', icAskedH: 'Committee changes you asked for', icApply: 'Apply the approved change', icApplied: 'Applied. The committee changed.',
    icAlready: 'Nothing changed: they are already on the committee.', icNotMember: 'Nothing changed: they are not on the committee.',
    caH: 'Give the chartered accountant\'s role', caLead: 'The CA alone fills the reverse-charge and TDS lists and the customer-data threshold, so the owner cannot approve this role on his own. The owner asks here; the IT custodian (the named security reviewer) approves exactly that on the Approvals page in his own session; then the owner applies it here. The owner does not get those settings himself.',
    caWho: 'The chartered accountant (their user id)', caAsk: 'Ask the IT custodian to approve', caAsked: 'Asked. The IT custodian approves it on the Approvals page.', caAskedH: 'CA role requests you asked for',
    caApply: 'Apply the approved grant', caApplied: 'Applied. They hold the chartered accountant\'s role now.', caAlready: 'Nothing changed: they already hold the role.',
    revH: 'Sign someone out everywhere, now', revLead: 'Cuts off a person\'s sign-ins issued up to now (a lost phone, a leaver, a changed password), or one sign-in by its token id. Kept on the record; nothing is undone.',
    revTarget: 'Who', revUser: 'A person (every sign-in up to now)', revToken: 'One sign-in (its token id)', revId: 'User id or token id', revWhy: 'Why',
    rr_admin_revoked: 'Taken off by an administrator', rr_security: 'Security worry (lost or stolen)', rr_credential_change: 'Password or code changed', rr_signed_out: 'Signed out',
    revGo: 'Sign them out now', revDone: 'Done. Their sign-ins up to now no longer work.', revListH: 'Sign-outs on record', revOneToken: 'token', revAllOf: 'every sign-in of', revUpTo: 'issued up to',
    // Fleet — M33-FR-02
    rsH: 'Remote sessions on the shop\'s computers', rsLead: 'Who is connected to a shop computer from outside, right now first. End one with a reason; it is kept on the record.',
    rsLive: 'connected now', rsEnded: 'ended', rsOn: 'on', rsFor: 'for', rsOpened: 'opened', rsSeen: 'last seen', rsEnd: 'End this session', rsEndWhy: 'Why end it', rsEndedOk: 'Ended. It is kept on the record.',
    vpH: 'App versions the shop runs', vpLead: 'The version every device should run, the one before it (still allowed), and the oldest that may still work. A withdrawn release stops on every device that runs it.',
    vpNone: 'No version policy is set yet.', vpCurrent: 'Current version', vpPrevious: 'Previous version (optional)', vpMinimum: 'Oldest version still allowed', vpKilled: 'Withdrawn releases',
    vpSet: 'Save this version policy', vpSaved: 'Saved. Devices are judged by it from now.',
    killH: 'Withdraw a broken release', killLead: 'Every device on this version is moved back. The current version cannot be withdrawn. Head office asks no second person for this: only someone whose role manages devices may do it, and it is on the record.',
    killVersion: 'Version to withdraw', killConfirm: 'I am withdrawing this release from every device', killGo: 'Withdraw this release', killDone: 'Withdrawn. Devices on it are moved back.',
    // Rollout — M33-FR-04
    licH: 'Licences', licLead: 'Each paid module or service: on or off, when it ends, and the named person who renews it. One close to its end (or past it) keeps alerting that person until it is renewed.',
    licAlertsH: 'Licences that need renewing', licNoAlerts: 'No licence needs renewing.', licEnds: 'ends', licNoEnd: 'no end date', licOn: 'on', licOff: 'off', licOwner: 'renewed by',
    licModule: 'Module id', licName: 'Name', licEnabled: 'Switched on', licExpires: 'Ends on (YYYY-MM-DD, optional)', licOwnerId: 'Who renews it (user id)', licOwnerName: 'Their name',
    licSave: 'Save this licence', licSaved: 'Saved.',
    // Integration health — M32-FR-03
    secH: 'Secrets the shop\'s connections use', secLead: 'Which secrets exist, what each protects, who owns it, when it was made and last changed, and its rotation state. A secret\'s value is NEVER shown here — only where it is kept. Only the IT custodian sets a value.',
    secWhere: 'kept at', secMade: 'made', secRotated: 'last changed', secNever: 'never changed', secEvery: 'change every', secDays: 'days', secState: 'state',
    st_active: 'in use', st_rotating: 'being changed (old one still allowed)', st_revoked: 'revoked',
    secReview: 'Check the secrets now', secReviewH: 'What the check found', secClean: 'Nothing needs attention.', secBlocking: 'Blocking', secAttention: 'Needs attention',
    // W6 · M32-FR-03 · OB-688 — each machine credential's use, from head office's daily count
    secUseH: 'Use in the last 30 days', secUseLead: 'How many times each machine sign-in (the store computer, the backup job and the like) was used, by whom and on which part of the system, from head office\'s daily count. Only its reference is shown — never the secret itself. Each night head office compares a day with the same day a week before and sends anything unusual to the IT custodian.',
    secUseNone: 'No use recorded in the last 30 days.', secCalls: 'calls', secRefused: 'refused or failed', secDaysUsed: 'days used', secLastUsed: 'last used',
    secUseFor: 'use in the last 30 days', secNoUse: 'no use recorded in the last 30 days', secRef: 'reference', secBy: 'by', secOn: 'on',
    secChecked: 'Last day checked', secNotChecked: 'No day has been checked yet.', secUnusualH: 'Unusual use found (sent to the IT custodian)', secUnusualNone: 'Nothing unusual found in the last 30 days.',
    secNotJudged: 'Days not compared (no use was counted a week before them yet)',
    // OB-689: what "unusual" means, and that its two limits are the code's until the owner sets his own (OB-686).
    secRule: 'Unusual means more than 3 times the calls of the same day a week before, or more than 1 in 10 calls refused — built-in, not yet set by the owner.',
    sig_spike: 'far more calls than the same day a week before', sig_error_surge: 'many calls refused or failed', sig_silent: 'stopped calling', sig_new_caller: 'called with no history',
    // Incidents — M35-FR-04 · M33-FR-04
    linkH: 'Link an alert to an incident', linkLead: 'When another alert belongs to an open incident, link it; its own facts then read into the incident\'s timeline.',
    linkIncident: 'Incident', linkAlert: 'Alert', linkGo: 'Link this alert', linked: 'Linked.', alreadyLinked: 'Already linked — nothing changed.', noOpen: 'No open incident.', noAlerts: 'No alert has been raised.',
    srH: 'Service requests for the system', srLead: 'Work the system itself needs (not a customer complaint): raise it, give it to a person, work it and resolve it with a note. Open ones first.',
    srTitle: 'What needs doing', srDetail: 'Detail', srCategory: 'Area (optional)', srPriority: 'How urgent', p_low: 'Low', p_normal: 'Normal', p_high: 'High', p_urgent: 'Urgent',
    srRaise: 'Raise this request', srRaised: 'Raised.', srAssignTo: 'Give it to (user id)', srAssign: 'Give it to them', srAssigned: 'Given.', srStatus: 'Move it to', srNote: 'Note (needed to resolve)', srMove: 'Move it', srMoved: 'Moved.',
    s_open: 'Open', s_in_progress: 'Being worked', s_resolved: 'Resolved', s_closed: 'Closed', srOpenCount: 'still need work', srRaisedBy: 'raised by', srWith: 'with',
    // Admin — M33-FR-03
    supH: 'Support access — who had it', supLead: 'Every support session: who, approved by whom, why, for how long and how many things they did. A grant that was approved and never used is flagged.',
    supActive: 'open now', supUnused: 'approved but never used', supMins: 'minutes', supActs: 'actions', supApproved: 'approved by',
    // Document templates — PA-09
    docH: 'Reprint an issued document', docLead: 'Find a document head office issued; it is shown exactly as it was issued. A reprint is the same document marked as a numbered duplicate, and who reprinted it, when and why is kept.',
    docId: 'Document id', docFind: 'Find it', docKind: 'Kind', docIssued: 'issued', docReprints: 'Reprints so far', docWhy: 'Why reprint it', docReprint: 'Reprint it', docReprinted: 'Reprinted:', docNumber: 'number',
    // Owner alerts — M29-FR-04
    runsH: 'What each scheduled report did', runsLead: 'Every run of a scheduled report, newest first: the shop day, whether it was prepared or refused, and what it said.',
    runsSchedule: 'Scheduled report', runsNone: 'No scheduled report yet.', runsNoRuns: 'It has not run yet.', o_prepared: 'prepared', o_refused: 'refused', runsCatchUp: 'caught up after a miss', runsFile: 'has a file',
    // Compare stores — M29-FR-02
    drillH: 'Who looked behind a figure', drillLead: 'Looking at the bills behind a figure reaches people\'s own work, so every look is kept: who, which figure, when, how many bills were shown or kept back, and whether they added up.',
    drillShown: 'shown', drillWithheld: 'kept back', drillAdds: 'adds up', drillNotAdds: 'DOES NOT add up',
    // Cash office — OB-82
    legH: 'Old till records with no store', legLead: 'Cash a till kept by its own id alone (before each till belonged to a store) is counted at no store until a head-office person places it, once and for ever.',
    legTill: 'Till id', legStore: 'Store id', legLook: 'Look it up', legUnplaced: 'Not placed at any store:', legMovements: 'movements', legBalance: 'balance', legPlaced: 'Already placed at store', legNoOld: 'This till has no old records to place.',
    legWhy: 'Why this store', legPlace: 'Place it at this store', legDone: 'Placed. It is counted at that store from now.',
    // Data in and out — OB-315 · M30-FR-04
    dryH: 'Keep a check of a file (a dry run)', dryLead: 'The same check as "Check the file", kept on the record with every row\'s problem, in your name. Nothing is loaded.',
    dryTemplate: 'What the file is', dryFile: 'The file', dryTotal: 'Declared total in paise (optional)', dryKeep: 'Keep this check', dryKept: 'Kept.', dryListH: 'Checks kept', dryRows: 'rows', dryGood: 'good', dryBad: 'with problems', dryReady: 'ready to load', dryNotReady: 'not ready to load',
    qualH: 'How clean each source\'s files are', qualLead: 'Files from each supplier or system: how many rows were accepted, which way it is going, and the hours a year spent fixing them. The ones worth a conversation are named.',
    qualAccepted: 'accepted', qualNotEnough: 'not enough files yet', qualHours: 'hours a year to fix', qualTalk: 'Worth a conversation', qualJobsH: 'Every file loaded, refused or abandoned', jobWhen: 'When', jobFile: 'File', jobOutcome: 'What happened', jobRows: 'Good rows', jobBy: 'Uploaded by', jobDetail: 'Head office says', qualSource: 'Show this source',
  },
  ta: {
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் மாற்றப்படவில்லை.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்கவோ மாற்றவோ முடியாது.',
    cannot: 'உங்கள் பங்கால் இதைச் செய்ய முடியாது.', needAll: 'இதற்குக் குறிக்கப்பட்ட எல்லாப் பெட்டிகளையும் நிரப்புங்கள்.', needReason: 'ஏன் என்று எழுத்தில் சொல்லவும்.',
    notVersion: 'பதிப்பை எண்களாக எழுதுங்கள், எ.கா. 1.4.2.', notDate: 'தேதியை YYYY-MM-DD என எழுதுங்கள்.',
    confirmKill: 'இந்த வெளியீட்டைத் திரும்பப் பெறுவதை உறுதிசெய்ய பெட்டியைக் குறியிடுங்கள்.', notMoney: 'ரூபாயில் எழுதுங்கள், எ.கா. 2000 அல்லது 2000.50.',
    show: 'காட்டு', showAgain: 'மீண்டும் காட்டு', none: 'காட்ட எதுவும் இல்லை.', reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…', done: 'முடிந்தது.',
    by: 'செய்தவர்', at: 'நேரம்', reason: 'ஏன்', notSet: 'அமைக்கப்படவில்லை',
    regH: 'தலைமை அலுவலகம் தனியாக வைத்த பதிவுகள்', regLead: 'என்றும் வைக்கப்படும், நீக்கப்படாது: ஒரே திறவுகோல் வேறு உள்ளடக்கத்துடன் வந்ததால் மறுக்கப்பட்டவை, கடைக் கணினி வேறு கடைக்காக அனுப்பியவை, கடைக் கணினியின் சொந்தக் கடையுடன் முத்திரையிடப்பட்டவை. படிக்க மட்டும்.',
    conflictsH: 'ஒரே திறவுகோல், வேறு உள்ளடக்கம் (மறுக்கப்பட்டது)', refusalsH: 'மறுக்கப்பட்டது: வேறு கடைக்காக அனுப்பியது', overruledH: 'தவறான கடை முதலில் எடுத்தது (தலைமை அலுவலகம் வேறிடத்தில் வைத்தது)', stampsH: 'கடைக் கணினியின் கடையுடன் முத்திரையிடப்பட்டது',
    bill: 'பில்', storeNamed: 'அது குறிப்பிட்ட கடை', credStore: 'அதன் உள்நுழைவு இந்தக் கடைக்கு', noCredStore: 'அதன் உள்நுழைவு எந்தக் கடையையும் குறிப்பிடவில்லை',
    agedH: 'காத்திருக்கும் ஒப்புதல்கள்', agedLead: 'இன்னும் காத்திருக்கும் ஒவ்வொரு ஒப்புதலும், எவ்வளவு நேரம் காத்திருந்தது, எப்போது உரிமையாளருக்குச் செல்லும்; ஏற்கனவே உரிமையாளருக்குச் சென்றவை.',
    waitingH: 'இன்னும் காத்திருக்கிறது', escalatedH: 'உரிமையாளருக்கு அனுப்பப்பட்டது', waited: 'காத்திருந்தது', minutes: 'நிமிடங்கள்', escalatesAt: 'உரிமையாளருக்குச் செல்லும் நேரம்', alreadyEscalated: 'ஏற்கனவே உரிமையாளருக்கு அனுப்பப்பட்டது', waitIs: 'காத்திருப்பு', waitNotSet: 'காத்திருப்பு அமைக்கப்படவில்லை',
    histH: 'ஒரு விதியின் வரலாறும் பழைய பதிப்புக்குத் திரும்புதலும்', histLead: 'ஒரு விதியின் ஒவ்வொரு பதிப்பும், பழையது முதலில். திரும்ப, பழைய பதிப்பு எதை மாற்றும் என்று முன்னோட்டம் பார்த்து, கேட்டு, ஒப்புதல் கிடைத்ததும் இங்கே செயல்படுத்துங்கள் — அது புதிய பதிப்பாகச் சேமிக்கப்படும்; எதுவும் மேலெழுதப்படாது.',
    ruleL: 'எந்த விதி', r_limits: 'பண வரம்புகள்', 'r_escalation-waits': 'மேல்நிலைக்கு அனுப்பும் காத்திருப்பு', 'r_price-check': 'விலைச் சோதனை அளவு',
    inForce: 'நடைமுறையில்: பதிப்பு', version: 'பதிப்பு', restored: 'மீட்டெடுத்த பதிப்பு', noVersions: '23 அக் 2026 உரிமையாளர் அளவுகளுக்குப் பின் மாற்றப்படவில்லை — திரும்பச் செல்ல பழைய பதிப்பு இல்லை.',
    preview: 'இதற்குத் திரும்புவதை முன்னோட்டம் பார்', askBack: 'இந்தப் பதிப்புக்குத் திரும்பக் கேள்', previewNoChange: 'இந்தப் பதிப்புக்குத் திரும்புவது எதையும் மாற்றாது.',
    previewNotValid: 'இந்தப் பதிப்பு இப்போது செல்லாது:', changes: 'இது மாற்றுவது', needsSecond: 'இதற்கு இரண்டாம் நபரின் ஒப்புதல் தேவை.',
    askedBack: 'கேட்கப்பட்டது. ஒப்புதல்கள் பக்கத்தில் ஒப்புதலுக்காகக் காத்திருக்கிறது.', askedBackH: 'நீங்கள் கேட்ட திரும்புதல்கள்', applyBack: 'ஒப்புதல் பெற்ற மாற்றத்தைச் செயல்படுத்து',
    appliedBack: 'செயல்படுத்தப்பட்டது. பழைய அளவுகள் புதிய பதிப்பாக நடைமுறையில் உள்ளன.',
    st_waiting: 'ஒப்புதலுக்காகக் காத்திருக்கிறது', st_approved: 'ஒப்புதல் பெற்றது — இப்போது செயல்படுத்துங்கள்', st_rejected: 'மறுக்கப்பட்டது', st_expired: 'காலாவதியானது — மீண்டும் கேளுங்கள்', st_used: 'செயல்படுத்தப்பட்டது',
    toVersion: 'திரும்பும் பதிப்பு',
    effH: 'இன்று இவர் எதை அனுமதிக்கலாம்?', effLead: 'இன்று (அல்லது நீங்கள் குறிப்பிடும் நாளில்) நடைமுறையில் உள்ள பகிர்வுகளிலிருந்து தலைமை அலுவலகம் பதிலளிக்கிறது: இவருக்கு வழங்கப்பட்ட அதிகாரம், அல்லது இல்லை.',
    whoL: 'நபர் (அவரது பயனர் அடையாளம்)', kindL: 'முடிவு வகை', onL: 'தேதி (YYYY-MM-DD, விருப்பம் — காலியெனில் இன்று)', ask: 'தலைமை அலுவலகத்திடம் கேள்',
    k_refund: 'பணத்திருப்பம்', k_price_change: 'விலை மாற்றம்', k_purchase_order: 'கொள்முதல் ஆணை', k_stock_adjustment: 'இருப்புத் திருத்தம்', k_day_reopen: 'மூடிய நாளை மீண்டும் திறத்தல்',
    src_own_authority: 'அவரது சொந்த அதிகாரம்', src_delegated: 'அவருக்கு வழங்கப்பட்டது', src_none: 'அதிகாரம் இல்லை', onBehalf: 'சார்பாக', limit: 'வரை', stores: 'கடைகள்', allStores: 'எல்லாக் கடைகளும்',
    icH: 'உள் குழு உறுப்பினர்கள்', icLead: 'உரிமையாளர் குழு உறுப்பினரைச் சேர்க்கிறார் அல்லது நீக்குகிறார். இரண்டாம் நபர் (கடை மேலாளர்) தம் உள்நுழைவில் ஒப்புதல்கள் பக்கத்தில் அந்த மாற்றத்தையே அனுமதிக்கிறார்; பிறகு உரிமையாளர் இங்கே செயல்படுத்துகிறார். புதிய இரு-படி உள்நுழைவு தேவை.',
    icWho: 'பணியாளர் (அவரது பயனர் அடையாளம்)', icAction: 'மாற்றம்', icAdd: 'குழுவில் சேர்', icRemove: 'குழுவிலிருந்து நீக்கு', icAsk: 'இரண்டாம் நபரின் ஒப்புதலைக் கேள்',
    icAsked: 'கேட்கப்பட்டது. இரண்டாம் நபர் ஒப்புதல்கள் பக்கத்தில் அனுமதிப்பார்.', icAskedH: 'நீங்கள் கேட்ட குழு மாற்றங்கள்', icApply: 'ஒப்புதல் பெற்ற மாற்றத்தைச் செயல்படுத்து', icApplied: 'செயல்படுத்தப்பட்டது. குழு மாறியது.',
    icAlready: 'எதுவும் மாறவில்லை: அவர் ஏற்கனவே குழுவில் உள்ளார்.', icNotMember: 'எதுவும் மாறவில்லை: அவர் குழுவில் இல்லை.',
    caH: 'பட்டயக் கணக்காளர் பங்கைக் கொடு', caLead: 'தலைகீழ் வரி, டிடிஎஸ் பட்டியல்களையும் வாடிக்கையாளர் தரவு வரம்பையும் பட்டயக் கணக்காளர் மட்டுமே நிரப்புகிறார், எனவே உரிமையாளர் தனியாக இந்தப் பங்கை அனுமதிக்க முடியாது. உரிமையாளர் இங்கே கேட்கிறார்; தகவல் தொழில்நுட்பப் பொறுப்பாளர் (பெயரிடப்பட்ட பாதுகாப்பு மதிப்பாய்வாளர்) தம் உள்நுழைவில் ஒப்புதல்கள் பக்கத்தில் அதையே அனுமதிக்கிறார்; பிறகு உரிமையாளர் இங்கே செயல்படுத்துகிறார். அந்த அமைப்புகள் உரிமையாளருக்குக் கிடைக்காது.',
    caWho: 'பட்டயக் கணக்காளர் (அவரது பயனர் அடையாளம்)', caAsk: 'தகவல் தொழில்நுட்பப் பொறுப்பாளரின் ஒப்புதலைக் கேள்', caAsked: 'கேட்கப்பட்டது. தகவல் தொழில்நுட்பப் பொறுப்பாளர் ஒப்புதல்கள் பக்கத்தில் அனுமதிப்பார்.', caAskedH: 'நீங்கள் கேட்ட பட்டயக் கணக்காளர் பங்குக் கோரிக்கைகள்',
    caApply: 'ஒப்புதல் பெற்ற வழங்கலைச் செயல்படுத்து', caApplied: 'செயல்படுத்தப்பட்டது. அவரிடம் இப்போது பட்டயக் கணக்காளர் பங்கு உள்ளது.', caAlready: 'எதுவும் மாறவில்லை: அவரிடம் ஏற்கனவே அந்தப் பங்கு உள்ளது.',
    revH: 'ஒருவரை எல்லா இடத்திலும் இப்போதே வெளியேற்று', revLead: 'இதுவரை வழங்கப்பட்ட ஒருவரின் உள்நுழைவுகளை (தொலைந்த கைப்பேசி, விலகியவர், மாற்றிய கடவுச்சொல்), அல்லது ஒரு உள்நுழைவை அதன் அடையாளத்தால் துண்டிக்கிறது. பதிவில் வைக்கப்படும்; எதுவும் திரும்பப் பெறப்படாது.',
    revTarget: 'யார்', revUser: 'ஒரு நபர் (இதுவரையிலான எல்லா உள்நுழைவும்)', revToken: 'ஒரு உள்நுழைவு (அதன் அடையாளம்)', revId: 'பயனர் அல்லது உள்நுழைவு அடையாளம்', revWhy: 'ஏன்',
    rr_admin_revoked: 'நிர்வாகி நீக்கினார்', rr_security: 'பாதுகாப்புக் கவலை (தொலைந்தது அல்லது திருடப்பட்டது)', rr_credential_change: 'கடவுச்சொல் அல்லது குறியீடு மாறியது', rr_signed_out: 'வெளியேறினார்',
    revGo: 'இப்போதே வெளியேற்று', revDone: 'முடிந்தது. இதுவரையிலான அவரது உள்நுழைவுகள் இனி வேலை செய்யாது.', revListH: 'பதிவில் உள்ள வெளியேற்றங்கள்', revOneToken: 'உள்நுழைவு', revAllOf: 'இவரது எல்லா உள்நுழைவுகளும்', revUpTo: 'இதுவரை வழங்கப்பட்டவை',
    rsH: 'கடைக் கணினிகளில் தொலைநிலை அமர்வுகள்', rsLead: 'வெளியிலிருந்து கடைக் கணினியுடன் இணைந்திருப்பவர், இப்போது இணைந்தவர் முதலில். காரணத்துடன் ஒன்றை முடியுங்கள்; அது பதிவில் வைக்கப்படும்.',
    rsLive: 'இப்போது இணைந்துள்ளது', rsEnded: 'முடிந்தது', rsOn: 'கணினி', rsFor: 'யாருக்கு', rsOpened: 'தொடங்கியது', rsSeen: 'கடைசியாகத் தெரிந்தது', rsEnd: 'இந்த அமர்வை முடி', rsEndWhy: 'ஏன் முடிக்கிறீர்கள்', rsEndedOk: 'முடிக்கப்பட்டது. பதிவில் வைக்கப்பட்டது.',
    vpH: 'கடை இயக்கும் செயலிப் பதிப்புகள்', vpLead: 'ஒவ்வொரு கருவியும் இயக்க வேண்டிய பதிப்பு, அதற்கு முந்தையது (இன்னும் அனுமதி), இன்னும் வேலை செய்யக்கூடிய மிகப் பழையது. திரும்பப் பெற்ற வெளியீடு அதை இயக்கும் எல்லாக் கருவிகளிலும் நிற்கும்.',
    vpNone: 'பதிப்புக் கொள்கை இன்னும் அமைக்கப்படவில்லை.', vpCurrent: 'தற்போதைய பதிப்பு', vpPrevious: 'முந்தைய பதிப்பு (விருப்பம்)', vpMinimum: 'இன்னும் அனுமதிக்கப்படும் மிகப் பழைய பதிப்பு', vpKilled: 'திரும்பப் பெற்ற வெளியீடுகள்',
    vpSet: 'இந்தப் பதிப்புக் கொள்கையைச் சேமி', vpSaved: 'சேமிக்கப்பட்டது. இனி கருவிகள் இதன்படி மதிப்பிடப்படும்.',
    killH: 'பழுதான வெளியீட்டைத் திரும்பப் பெறு', killLead: 'இந்தப் பதிப்பில் உள்ள எல்லாக் கருவிகளும் பின்னுக்கு நகர்த்தப்படும். தற்போதைய பதிப்பைத் திரும்பப் பெற முடியாது. இதற்குத் தலைமை அலுவலகம் இரண்டாம் நபரைக் கேட்பதில்லை: கருவிகளை நிர்வகிக்கும் பங்கு உள்ளவர் மட்டுமே செய்யலாம், அது பதிவில் இருக்கும்.',
    killVersion: 'திரும்பப் பெற வேண்டிய பதிப்பு', killConfirm: 'இந்த வெளியீட்டை எல்லாக் கருவிகளிலிருந்தும் திரும்பப் பெறுகிறேன்', killGo: 'இந்த வெளியீட்டைத் திரும்பப் பெறு', killDone: 'திரும்பப் பெறப்பட்டது. அதில் உள்ள கருவிகள் பின்னுக்கு நகர்த்தப்படும்.',
    licH: 'உரிமங்கள்', licLead: 'ஒவ்வொரு கட்டணத் தொகுதி அல்லது சேவை: இயக்கம் அல்லது நிறுத்தம், எப்போது முடியும், புதுப்பிக்கும் பெயரிடப்பட்ட நபர். முடிவை நெருங்கும் (அல்லது கடந்த) ஒன்று புதுப்பிக்கும் வரை அவரை எச்சரிக்கும்.',
    licAlertsH: 'புதுப்பிக்க வேண்டிய உரிமங்கள்', licNoAlerts: 'எந்த உரிமமும் புதுப்பிக்கத் தேவையில்லை.', licEnds: 'முடிவு', licNoEnd: 'முடிவுத் தேதி இல்லை', licOn: 'இயக்கத்தில்', licOff: 'நிறுத்தத்தில்', licOwner: 'புதுப்பிப்பவர்',
    licModule: 'தொகுதி அடையாளம்', licName: 'பெயர்', licEnabled: 'இயக்கத்தில்', licExpires: 'முடியும் நாள் (YYYY-MM-DD, விருப்பம்)', licOwnerId: 'புதுப்பிப்பவர் (பயனர் அடையாளம்)', licOwnerName: 'அவரது பெயர்',
    licSave: 'இந்த உரிமத்தைச் சேமி', licSaved: 'சேமிக்கப்பட்டது.',
    secH: 'கடையின் இணைப்புகள் பயன்படுத்தும் ரகசியங்கள்', secLead: 'எந்த ரகசியங்கள் உள்ளன, ஒவ்வொன்றும் எதைக் காக்கிறது, யாருடையது, எப்போது உருவானது, கடைசியாக மாறியது, சுழற்சி நிலை. ரகசியத்தின் மதிப்பு இங்கே ஒருபோதும் காட்டப்படாது — அது வைக்கப்பட்ட இடம் மட்டுமே. தகவல் தொழில்நுட்பப் பொறுப்பாளர் மட்டுமே மதிப்பை அமைப்பார்.',
    secWhere: 'வைக்கப்பட்ட இடம்', secMade: 'உருவானது', secRotated: 'கடைசியாக மாறியது', secNever: 'ஒருபோதும் மாறவில்லை', secEvery: 'மாற்ற வேண்டிய இடைவெளி', secDays: 'நாட்கள்', secState: 'நிலை',
    st_active: 'பயன்பாட்டில்', st_rotating: 'மாற்றப்படுகிறது (பழையதும் இன்னும் அனுமதி)', st_revoked: 'ரத்து செய்யப்பட்டது',
    secReview: 'ரகசியங்களை இப்போது சோதி', secReviewH: 'சோதனை கண்டது', secClean: 'கவனிக்க எதுவும் இல்லை.', secBlocking: 'தடுக்கிறது', secAttention: 'கவனம் தேவை',
    secUseH: 'கடந்த 30 நாள் பயன்பாடு', secUseLead: 'ஒவ்வொரு இயந்திர உள்நுழைவும் (கடைக் கணினி, காப்புப் பணி போன்றவை) எத்தனை முறை, யாரால், அமைப்பின் எந்தப் பகுதியில் பயன்பட்டது — தலைமை அலுவலகத்தின் தினசரி எண்ணிக்கையிலிருந்து. அதன் குறிப்பு மட்டுமே காட்டப்படும் — ரகசியம் ஒருபோதும் இல்லை. ஒவ்வொரு இரவும் தலைமை அலுவலகம் ஒரு நாளை ஒரு வாரம் முந்தைய அதே நாளுடன் ஒப்பிட்டு, வழக்கத்துக்கு மாறானதை தகவல் தொழில்நுட்பப் பொறுப்பாளருக்கு அனுப்பும்.',
    secUseNone: 'கடந்த 30 நாட்களில் எந்தப் பயன்பாடும் பதிவாகவில்லை.', secCalls: 'அழைப்புகள்', secRefused: 'மறுக்கப்பட்டவை அல்லது தோல்வியுற்றவை', secDaysUsed: 'பயன்பட்ட நாட்கள்', secLastUsed: 'கடைசியாகப் பயன்பட்டது',
    secUseFor: 'கடந்த 30 நாள் பயன்பாடு', secNoUse: 'கடந்த 30 நாட்களில் பயன்பாடு பதிவாகவில்லை', secRef: 'குறிப்பு', secBy: 'பயன்படுத்தியவர்', secOn: 'பகுதி',
    secChecked: 'கடைசியாகச் சோதித்த நாள்', secNotChecked: 'இன்னும் எந்த நாளும் சோதிக்கப்படவில்லை.', secUnusualH: 'வழக்கத்துக்கு மாறான பயன்பாடு (தகவல் தொழில்நுட்பப் பொறுப்பாளருக்கு அனுப்பப்பட்டது)', secUnusualNone: 'கடந்த 30 நாட்களில் வழக்கத்துக்கு மாறானது எதுவும் இல்லை.',
    secNotJudged: 'ஒப்பிடப்படாத நாட்கள் (ஒரு வாரம் முன்பு இன்னும் எண்ணிக்கை தொடங்கவில்லை)',
    secRule: 'வழக்கத்துக்கு மாறானது என்றால் ஒரு வாரம் முந்தைய அதே நாளை விட 3 மடங்குக்கு மேல் அழைப்புகள், அல்லது 10-இல் 1-க்கு மேல் மறுக்கப்பட்டவை — உள்ளமைந்தது, உரிமையாளர் இன்னும் அமைக்கவில்லை.',
    sig_spike: 'ஒரு வாரம் முந்தைய அதே நாளை விட மிக அதிக அழைப்புகள்', sig_error_surge: 'பல அழைப்புகள் மறுக்கப்பட்டன அல்லது தோல்வியுற்றன', sig_silent: 'அழைப்பது நின்றுவிட்டது', sig_new_caller: 'முன்வரலாறு இல்லாமல் அழைத்தது',
    linkH: 'ஒரு எச்சரிக்கையை ஒரு சம்பவத்துடன் இணை', linkLead: 'இன்னொரு எச்சரிக்கை திறந்த சம்பவத்தைச் சேர்ந்தால், இணையுங்கள்; அதன் உண்மைகள் சம்பவக் காலவரிசையில் சேரும்.',
    linkIncident: 'சம்பவம்', linkAlert: 'எச்சரிக்கை', linkGo: 'இந்த எச்சரிக்கையை இணை', linked: 'இணைக்கப்பட்டது.', alreadyLinked: 'ஏற்கனவே இணைக்கப்பட்டது — எதுவும் மாறவில்லை.', noOpen: 'திறந்த சம்பவம் இல்லை.', noAlerts: 'எந்த எச்சரிக்கையும் எழுப்பப்படவில்லை.',
    srH: 'அமைப்புக்கான சேவைக் கோரிக்கைகள்', srLead: 'அமைப்புக்கே தேவைப்படும் வேலை (வாடிக்கையாளர் புகார் அல்ல): எழுப்பி, ஒருவரிடம் கொடுத்து, செய்து, குறிப்புடன் தீர்க்கவும். திறந்தவை முதலில்.',
    srTitle: 'என்ன செய்ய வேண்டும்', srDetail: 'விவரம்', srCategory: 'பகுதி (விருப்பம்)', srPriority: 'எவ்வளவு அவசரம்', p_low: 'குறைவு', p_normal: 'சாதாரணம்', p_high: 'அதிகம்', p_urgent: 'மிக அவசரம்',
    srRaise: 'இந்தக் கோரிக்கையை எழுப்பு', srRaised: 'எழுப்பப்பட்டது.', srAssignTo: 'யாரிடம் கொடுப்பது (பயனர் அடையாளம்)', srAssign: 'அவரிடம் கொடு', srAssigned: 'கொடுக்கப்பட்டது.', srStatus: 'இதற்கு நகர்த்து', srNote: 'குறிப்பு (தீர்க்கத் தேவை)', srMove: 'நகர்த்து', srMoved: 'நகர்த்தப்பட்டது.',
    s_open: 'திறந்தது', s_in_progress: 'செய்யப்படுகிறது', s_resolved: 'தீர்க்கப்பட்டது', s_closed: 'மூடப்பட்டது', srOpenCount: 'இன்னும் வேலை தேவை', srRaisedBy: 'எழுப்பியவர்', srWith: 'யாரிடம்',
    supH: 'உதவி அணுகல் — யாருக்கு இருந்தது', supLead: 'ஒவ்வொரு உதவி அமர்வும்: யார், யார் அனுமதித்தார், ஏன், எவ்வளவு நேரம், எத்தனை செயல்கள். அனுமதிக்கப்பட்டு ஒருபோதும் பயன்படுத்தப்படாதது குறிக்கப்படும்.',
    supActive: 'இப்போது திறந்துள்ளது', supUnused: 'அனுமதிக்கப்பட்டது, ஆனால் பயன்படுத்தப்படவில்லை', supMins: 'நிமிடங்கள்', supActs: 'செயல்கள்', supApproved: 'அனுமதித்தவர்',
    docH: 'வழங்கிய ஆவணத்தை மீண்டும் அச்சிடு', docLead: 'தலைமை அலுவலகம் வழங்கிய ஆவணத்தைக் கண்டறியுங்கள்; அது வழங்கப்பட்டபடியே காட்டப்படும். மறு அச்சு அதே ஆவணம், எண்ணிட்ட நகல் என்று குறிக்கப்படும்; யார், எப்போது, ஏன் என்பது வைக்கப்படும்.',
    docId: 'ஆவண அடையாளம்', docFind: 'கண்டுபிடி', docKind: 'வகை', docIssued: 'வழங்கப்பட்டது', docReprints: 'இதுவரை மறு அச்சுகள்', docWhy: 'ஏன் மீண்டும் அச்சிடுகிறீர்கள்', docReprint: 'மீண்டும் அச்சிடு', docReprinted: 'மீண்டும் அச்சிடப்பட்டது:', docNumber: 'எண்',
    runsH: 'ஒவ்வொரு திட்டமிட்ட அறிக்கையும் செய்தது', runsLead: 'திட்டமிட்ட அறிக்கையின் ஒவ்வொரு ஓட்டமும், புதியது முதலில்: கடை நாள், தயாரானதா மறுக்கப்பட்டதா, அது சொன்னது.',
    runsSchedule: 'திட்டமிட்ட அறிக்கை', runsNone: 'இன்னும் திட்டமிட்ட அறிக்கை இல்லை.', runsNoRuns: 'இது இன்னும் ஓடவில்லை.', o_prepared: 'தயாரானது', o_refused: 'மறுக்கப்பட்டது', runsCatchUp: 'தவறியபின் ஈடுசெய்தது', runsFile: 'கோப்பு உள்ளது',
    drillH: 'ஒரு எண்ணுக்குப் பின்னால் பார்த்தவர்', drillLead: 'ஒரு எண்ணுக்குப் பின்னால் உள்ள பில்களைப் பார்ப்பது மக்களின் சொந்த வேலையை அடைகிறது, எனவே ஒவ்வொரு பார்வையும் வைக்கப்படும்: யார், எந்த எண், எப்போது, எத்தனை பில்கள் காட்டப்பட்டன அல்லது மறைக்கப்பட்டன, பொருந்தியதா.',
    drillShown: 'காட்டப்பட்டது', drillWithheld: 'மறைக்கப்பட்டது', drillAdds: 'பொருந்துகிறது', drillNotAdds: 'பொருந்தவில்லை',
    legH: 'கடை இல்லாத பழைய கல்லாப் பதிவுகள்', legLead: 'கல்லா தன் அடையாளத்தால் மட்டும் வைத்த பணம் (ஒவ்வொரு கல்லாவும் ஒரு கடைக்குச் சேரும் முன்), தலைமை அலுவலக நபர் ஒருமுறை என்றென்றைக்குமாக வைக்கும் வரை எந்தக் கடையிலும் கணக்கிடப்படாது.',
    legTill: 'கல்லா அடையாளம்', legStore: 'கடை அடையாளம்', legLook: 'தேடு', legUnplaced: 'எந்தக் கடையிலும் வைக்கப்படவில்லை:', legMovements: 'நகர்வுகள்', legBalance: 'இருப்பு', legPlaced: 'ஏற்கனவே இந்தக் கடையில் வைக்கப்பட்டது', legNoOld: 'இந்தக் கல்லாவுக்கு வைக்க வேண்டிய பழைய பதிவுகள் இல்லை.',
    legWhy: 'ஏன் இந்தக் கடை', legPlace: 'இந்தக் கடையில் வை', legDone: 'வைக்கப்பட்டது. இனி அந்தக் கடையில் கணக்கிடப்படும்.',
    dryH: 'கோப்பின் சோதனையை வை (முன் ஓட்டம்)', dryLead: '"கோப்பைச் சரிபார்" போன்ற அதே சோதனை, ஒவ்வொரு வரியின் பிரச்சினையுடன், உங்கள் பெயரில் பதிவில் வைக்கப்படும். எதுவும் ஏற்றப்படாது.',
    dryTemplate: 'கோப்பு என்ன', dryFile: 'கோப்பு', dryTotal: 'அறிவிக்கப்பட்ட மொத்தம் பைசாவில் (விருப்பம்)', dryKeep: 'இந்தச் சோதனையை வை', dryKept: 'வைக்கப்பட்டது.', dryListH: 'வைக்கப்பட்ட சோதனைகள்', dryRows: 'வரிகள்', dryGood: 'சரியானவை', dryBad: 'பிரச்சினை உள்ளவை', dryReady: 'ஏற்றத் தயார்', dryNotReady: 'ஏற்றத் தயாரில்லை',
    qualH: 'ஒவ்வொரு மூலத்தின் கோப்புகளும் எவ்வளவு சுத்தம்', qualLead: 'ஒவ்வொரு விநியோகஸ்தர் அல்லது அமைப்பின் கோப்புகள்: எத்தனை வரிகள் ஏற்கப்பட்டன, எந்தத் திசையில் செல்கிறது, திருத்த ஆண்டுக்கு எத்தனை மணி நேரம். பேச வேண்டியவை பெயரிடப்படும்.',
    qualAccepted: 'ஏற்கப்பட்டது', qualNotEnough: 'இன்னும் போதுமான கோப்புகள் இல்லை', qualHours: 'திருத்த ஆண்டுக்கு மணி நேரம்', qualTalk: 'பேச வேண்டியவை', qualJobsH: 'ஏற்றப்பட்ட, மறுக்கப்பட்ட, கைவிடப்பட்ட ஒவ்வொரு கோப்பும்', jobWhen: 'எப்போது', jobFile: 'கோப்பு', jobOutcome: 'என்ன ஆனது', jobRows: 'சரியான வரிகள்', jobBy: 'பதிவேற்றியவர்', jobDetail: 'தலைமை அலுவலகம் கூறுவது', qualSource: 'இந்த மூலத்தைக் காட்டு',
  },
} as const;

export type W5WordKey = keyof typeof WORDS.en;
export const W5_WORDS = WORDS;

export function w5Words(lang: Lang, key: string): string {
  return (WORDS[lang] as Record<string, string>)[key] ?? (WORDS.en as Record<string, string>)[key] ?? key;
}

/** The words for an outcome: `good` when it went through, else head office's refusal in its own words. */
export function w5OutcomeWords(lang: Lang, out: Outcome<unknown, string>, good = ''): string {
  if (out.result === 'ok') return good;
  if (out.result === 'refused') return `${w5Words(lang, 'refused')} ${out.whatHappened}`;
  if (out.result === 'invalid') return w5Words(lang, out.why);
  return w5Words(lang, 'unreachable');
}

type When = (iso: string | null | undefined) => string;
const plainWhen: When = (iso) => (typeof iso === 'string' ? iso : '');

/** Paise → "₹5,000.00". */
export const rupees = (paise: number): string => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ── the shared shape of every section ────────────────────────────────────────────────────────────────────────────────────

interface Ctx { readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string }
const held = (viewer: Viewer): ReadonlySet<string> => new Set(viewer?.permissions ?? []);
const named = (viewer: Viewer): boolean => viewer?.userId !== undefined;
const enc = encodeURIComponent;
const blank = (s: string | undefined): boolean => s === undefined || s.trim() === '';

function base(viewer: Viewer, ctx: Ctx, keyPrefix: string) {
  const call = makeCaller({ keyPrefix, ...(ctx.fetch === undefined ? {} : { fetch: ctx.fetch }), ...(ctx.newKey === undefined ? {} : { newKey: ctx.newKey }) });
  const perms = held(viewer);
  const who = named(viewer);
  const may = (p: string): boolean => who && perms.has(p);
  /** Refuse before any call: nobody signed in, or the role lacks the route's own permission. */
  const gate = (p: string): { result: 'invalid'; why: Why } | undefined => (!who ? { result: 'invalid', why: 'nobody' } : !perms.has(p) ? { result: 'invalid', why: 'cannot' } : undefined);
  return { call, may, gate };
}
const invalid = (why: Why): { result: 'invalid'; why: Why } => ({ result: 'invalid', why });

// ── Store computers — OB-87 · OB-54 ──────────────────────────────────────────────────────────────────────────────────────

export interface ConflictRow { readonly conflictId: string; readonly userId: string; readonly branchId?: string; readonly method: string; readonly path: string; readonly routePath?: string; readonly saleId?: string; readonly receiptNumber?: string; readonly at: string; readonly detail: string }
export interface RefusalRow { readonly refusalId: string; readonly userId: string; readonly credentialStore: string | null; readonly reason: string; readonly namedStore?: string; readonly field?: string; readonly method: string; readonly path: string; readonly at: string; readonly by?: string }
export interface StampRow { readonly stampId: string; readonly userId: string; readonly store: string; readonly field: string | null; readonly method: string; readonly path: string; readonly at: string }

export function createStoreComputerRegistersSession(input: { readonly viewer: Viewer } & Ctx) {
  const { call, may, gate } = base(input.viewer, input, 'sc-registers');
  const P = 'platform.health.read';
  return {
    may: { read: may(P) },
    conflicts: async (): Promise<W5Outcome<readonly ConflictRow[]>> => gate(P) ?? map(await call<{ conflicts?: ConflictRow[] }>('GET', '/v1/idempotency-conflicts'), (b) => b.conflicts ?? []),
    refusals: async (): Promise<W5Outcome<{ readonly refusals: readonly RefusalRow[]; readonly overruled: readonly Record<string, unknown>[] }>> =>
      gate(P) ?? map(await call<{ refusals?: RefusalRow[]; overruledClaims?: Record<string, unknown>[] }>('GET', '/v1/store-computers/refusals'), (b) => ({ refusals: b.refusals ?? [], overruled: b.overruledClaims ?? [] })),
    stamps: async (): Promise<W5Outcome<readonly StampRow[]>> => gate(P) ?? map(await call<{ stamps?: StampRow[] }>('GET', '/v1/store-computers/stamps'), (b) => b.stamps ?? []),
  };
}
export const conflictLine = (lang: Lang, c: ConflictRow, when: When = plainWhen): string =>
  `${when(c.at)} · ${c.userId}${c.branchId === undefined ? '' : ` · ${c.branchId}`} · ${c.method} ${c.path}${c.receiptNumber === undefined ? '' : ` · ${w5Words(lang, 'bill')} ${c.receiptNumber}`} — ${c.detail}`;
export const refusalLine = (lang: Lang, r: RefusalRow, when: When = plainWhen): string =>
  `${when(r.at)} · ${r.userId} · ${r.credentialStore === null ? w5Words(lang, 'noCredStore') : `${w5Words(lang, 'credStore')} ${r.credentialStore}`}${r.namedStore === undefined ? '' : ` · ${w5Words(lang, 'storeNamed')} ${r.namedStore}${r.field === undefined ? '' : ` (${r.field})`}`} · ${r.method} ${r.path} · ${r.reason}`;
export const stampLine = (_lang: Lang, s: StampRow, when: When = plainWhen): string =>
  `${when(s.at)} · ${s.userId} → ${s.store}${s.field === null ? '' : ` (${s.field})`} · ${s.method} ${s.path}`;

function map<T, U>(out: Outcome<T, never>, f: (v: T) => U): Outcome<U, never> {
  return out.result === 'ok' ? { result: 'ok', value: f(out.value) } : out;
}

// ── Approvals — M02-FR-03 aged approvals ────────────────────────────────────────────────────────────────────────────────

export interface WaitingRow { readonly requestId: string; readonly kind: string; readonly requestedBy: string; readonly requestedAt: string; readonly valueMinor: number | null; readonly summary: string; readonly waitMinutes?: number; readonly waitedMinutes: number; readonly escalatesAt: string | null; readonly escalated: boolean }
export interface EscalationRow { readonly requestId: string; readonly kind: string; readonly requestedBy: string; readonly summary: string; readonly waitedMinutes: number; readonly escalatedAt: string; readonly valueMinor: number | null }
export interface AgedRead { readonly waiting: readonly WaitingRow[]; readonly escalations: readonly EscalationRow[]; readonly asAt: string }

export function createAgedApprovalsSession(input: { readonly viewer: Viewer } & Ctx) {
  const { call, may, gate } = base(input.viewer, input, 'aged');
  const P = 'approvals.rules.read';
  return {
    may: { read: may(P) },
    read: async (): Promise<W5Outcome<AgedRead>> => gate(P) ?? map(await call<{ waiting?: WaitingRow[]; escalations?: EscalationRow[]; asAt?: string }>('GET', '/v1/approvals/escalations'),
      (b) => ({ waiting: [...(b.waiting ?? [])].sort((x, y) => y.waitedMinutes - x.waitedMinutes), escalations: b.escalations ?? [], asAt: b.asAt ?? '' })),
  };
}
export function waitingLine(lang: Lang, r: WaitingRow, when: When = plainWhen): string {
  const w = (k: string) => w5Words(lang, k);
  const money = r.valueMinor === null ? '' : ` · ${rupees(r.valueMinor)}`;
  const wait = r.waitMinutes === undefined ? w('waitNotSet') : `${w('waitIs')} ${r.waitMinutes} ${w('minutes')}`;
  const next = r.escalated ? w('alreadyEscalated') : r.escalatesAt === null ? '' : `${w('escalatesAt')} ${when(r.escalatesAt)}`;
  return `${r.summary}${money} · ${r.requestedBy} · ${w('waited')} ${r.waitedMinutes} ${w('minutes')} (${wait})${next === '' ? '' : ` · ${next}`}`;
}
export const escalationLine = (lang: Lang, e: EscalationRow, when: When = plainWhen): string =>
  `${e.summary}${e.valueMinor === null ? '' : ` · ${rupees(e.valueMinor)}`} · ${e.requestedBy} · ${w5Words(lang, 'waited')} ${e.waitedMinutes} ${w5Words(lang, 'minutes')} · ${when(e.escalatedAt)}`;

// ── Approval rules — M01-FR-03 history, preview, rollback ───────────────────────────────────────────────────────────────

export const RULES = Object.freeze(['limits', 'escalation-waits', 'price-check'] as const);
export type Rule = (typeof RULES)[number];
export interface RuleVersion { readonly version: number; readonly value: unknown; readonly author: string; readonly reason: string; readonly effectiveAt: string; readonly rolledBackFrom: number | null }
export interface RuleHistory { readonly rule: Rule; readonly versions: readonly RuleVersion[]; readonly inForce: { readonly version: number } }
export interface RollbackAsked { readonly requestId: string; readonly status: string; readonly rule: Rule; readonly toVersion: number; readonly basedOnVersion: number; readonly reason: string; readonly decidedBy?: string }
export interface PreviewAnswer { readonly valid: boolean; readonly why?: string; readonly rolesChanged?: readonly { roleId: string; changes: readonly { kind: string; from: unknown; to: unknown }[] }[]; readonly changes?: readonly { field: string; from: unknown; to: unknown }[]; readonly needsSecondPerson?: boolean }

/** A request is a rollback (this section's) when its details name a version to go back to; else it is a figure change. */
export const isRollbackAsk = (details: unknown): boolean => details !== null && typeof details === 'object' && typeof (details as Record<string, unknown>)['toVersion'] === 'number';

export function createRuleHistorySession(input: { readonly viewer: Viewer } & Ctx) {
  const { call, may, gate } = base(input.viewer, input, 'rule-history');
  const R = 'approvals.rules.read'; const W = 'approvals.rules.propose';
  return {
    may: { read: may(R), propose: may(W) },
    history: async (rule: Rule): Promise<W5Outcome<RuleHistory>> => gate(R) ?? call<RuleHistory>('GET', `/v1/approvals/rules/${enc(rule)}/history`),
    /** What going back to `v` would change, against the rule in force — head office's own answer; nothing is written. */
    preview: async (rule: Rule, v: RuleVersion): Promise<W5Outcome<PreviewAnswer>> => gate(R) ?? call<PreviewAnswer>('POST', `/v1/approvals/rules/${enc(rule)}/preview`, { value: v.value }),
    askRollback: async (rule: Rule, toVersion: number, basedOnVersion: number, reason: string): Promise<W5Outcome<{ requestId: string }>> => {
      const no = gate(W); if (no !== undefined) return no;
      if (blank(reason)) return invalid('needReason');
      // Exactly the body the rollback route will send (without its approvalId), plus the rule — what head office fingerprints.
      return call('POST', '/v1/approvals/requests', {
        kind: 'approval_rule_change', subjectRef: `rule:${rule}`, valueMinor: null,
        details: { rule, toVersion, basedOnVersion, reason: reason.trim() },
        summary: `Go back to version ${toVersion} of the ${rule} rule (from version ${basedOnVersion})`, reason: reason.trim(),
      });
    },
    asked: async (): Promise<W5Outcome<readonly RollbackAsked[]>> => {
      const no = gate(W); if (no !== undefined) return no;
      return map(await call<{ mine?: { requestId: string; kind: string; status: string; details?: Record<string, unknown>; decidedBy?: string }[] }>('GET', '/v1/approvals/requests'),
        (b) => (b.mine ?? []).filter((r) => r.kind === 'approval_rule_change' && isRollbackAsk(r.details)).map((r): RollbackAsked => ({
          requestId: r.requestId, status: r.status, rule: r.details!['rule'] as Rule, toVersion: r.details!['toVersion'] as number,
          basedOnVersion: r.details!['basedOnVersion'] as number, reason: String(r.details!['reason'] ?? ''), ...(r.decidedBy === undefined ? {} : { decidedBy: r.decidedBy }),
        })));
    },
    apply: async (a: RollbackAsked): Promise<W5Outcome<{ version: number; restoredVersion?: number }>> => gate(W)
      ?? call('POST', `/v1/approvals/rules/${enc(a.rule)}/rollback`, { toVersion: a.toVersion, basedOnVersion: a.basedOnVersion, reason: a.reason, approvalId: a.requestId }),
  };
}
export const versionLine = (lang: Lang, v: RuleVersion, when: When = plainWhen): string =>
  `${w5Words(lang, 'version')} ${v.version} · ${v.author} · ${when(v.effectiveAt)} · ${v.reason}${v.rolledBackFrom === null ? '' : ` · ${w5Words(lang, 'restored')} ${v.rolledBackFrom}`}`;
export function previewLines(lang: Lang, p: PreviewAnswer): readonly string[] {
  const w = (k: string) => w5Words(lang, k);
  const fig = (x: unknown): string => (x === 'not_set' || x === undefined ? w('notSet') : x === null ? '—' : typeof x === 'number' ? String(x) : String(x));
  if (!p.valid) return [`${w('previewNotValid')} ${p.why ?? ''}`.trim()];
  const lines: string[] = [];
  for (const r of p.rolesChanged ?? []) for (const c of r.changes) lines.push(`${r.roleId} · ${c.kind}: ${fig(c.from)} → ${fig(c.to)}`);
  for (const c of p.changes ?? []) lines.push(`${c.field}: ${fig(c.from)} → ${fig(c.to)}`);
  if (lines.length === 0) return [w('previewNoChange')];
  return [`${w('changes')}:`, ...lines, ...(p.needsSecondPerson === true ? [w('needsSecond')] : [])];
}

// ── Delegation — M02-FR-03 effective authority ──────────────────────────────────────────────────────────────────────────

export const DECISION_KINDS = Object.freeze(['refund', 'price_change', 'purchase_order', 'stock_adjustment', 'day_reopen'] as const);
export interface EffectiveAnswer { readonly userId: string; readonly source: 'own_authority' | 'delegated' | 'none'; readonly branchScope: readonly string[] | 'all'; readonly authorityLimit: { readonly amountMinor?: number; readonly minor?: number } | number | null; readonly onBehalfOf?: string; readonly detail: string }
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function createEffectiveAuthoritySession(input: { readonly viewer: Viewer } & Ctx) {
  const { call, may, gate } = base(input.viewer, input, 'effective');
  const P = 'approvals.delegation.read';
  return {
    may: { read: may(P) },
    ask: async (userId: string, subjectType: string, onDate: string): Promise<W5Outcome<EffectiveAnswer>> => {
      const no = gate(P); if (no !== undefined) return no;
      if (blank(userId) || blank(subjectType)) return invalid('needAll');
      if (!blank(onDate) && !ISO_DATE.test(onDate.trim())) return invalid('notDate');
      return call('POST', '/v1/access/delegations/effective-authority', { userId: userId.trim(), subjectType, ...(blank(onDate) ? {} : { onDate: onDate.trim() }) });
    },
  };
}
export function effectiveLine(lang: Lang, a: EffectiveAnswer): string {
  const w = (k: string) => w5Words(lang, k);
  const lim = a.authorityLimit === null ? '' : typeof a.authorityLimit === 'number' ? ` · ${w('limit')} ${rupees(a.authorityLimit)}`
    : typeof a.authorityLimit.amountMinor === 'number' ? ` · ${w('limit')} ${rupees(a.authorityLimit.amountMinor)}` : typeof a.authorityLimit.minor === 'number' ? ` · ${w('limit')} ${rupees(a.authorityLimit.minor)}` : '';
  const where = a.source === 'none' ? '' : ` · ${a.branchScope === 'all' ? w('allStores') : `${w('stores')} ${a.branchScope.join(', ')}`}`;
  return `${w(`src_${a.source}`)}${a.onBehalfOf === undefined ? '' : ` (${w('onBehalf')} ${a.onBehalfOf})`}${lim}${where} — ${a.detail}`;
}

// ── Users — OB-165/167 Internal Committee changes · SEC-11 token revocation ──────────────────────────────────────────────

export interface CommitteeAsked { readonly requestId: string; readonly changeId: string; readonly status: string; readonly action: 'add' | 'remove'; readonly userId: string; readonly reason: string; readonly decidedBy?: string }

export function createCommitteeChangeSession(input: { readonly viewer: Viewer; readonly newChangeId?: () => string } & Ctx) {
  const { call, may, gate } = base(input.viewer, input, 'ic-change');
  const P = 'posh.committee.manage';
  const changeIdOf = input.newChangeId ?? (() => newId('ic'));
  return {
    may: { manage: may(P) },
    ask: async (action: 'add' | 'remove', userId: string, reason: string): Promise<W5Outcome<{ requestId: string }>> => {
      const no = gate(P); if (no !== undefined) return no;
      if (blank(userId)) return invalid('needAll');
      if (blank(reason)) return invalid('needReason');
      const changeId = changeIdOf();
      // The route's own body (without approvalId) plus its path id — exactly what head office checks the approval against.
      const details = { action, userId: userId.trim(), reason: reason.trim(), changeId };
      return call('POST', '/v1/approvals/requests', {
        kind: 'posh_committee_change', subjectRef: changeId, details, valueMinor: null,
        summary: `${action === 'add' ? 'Add' : 'Remove'} ${userId.trim()} ${action === 'add' ? 'to' : 'from'} the Internal Committee`, reason: reason.trim(),
      });
    },
    asked: async (): Promise<W5Outcome<readonly CommitteeAsked[]>> => {
      const no = gate(P); if (no !== undefined) return no;
      return map(await call<{ mine?: { requestId: string; kind: string; status: string; details?: Record<string, unknown>; decidedBy?: string }[] }>('GET', '/v1/approvals/requests'),
        (b) => (b.mine ?? []).filter((r) => r.kind === 'posh_committee_change' && r.details !== undefined).map((r): CommitteeAsked => ({
          requestId: r.requestId, status: r.status, changeId: String(r.details!['changeId'] ?? ''), action: r.details!['action'] === 'remove' ? 'remove' : 'add',
          userId: String(r.details!['userId'] ?? ''), reason: String(r.details!['reason'] ?? ''), ...(r.decidedBy === undefined ? {} : { decidedBy: r.decidedBy }),
        })));
    },
    apply: async (a: CommitteeAsked): Promise<W5Outcome<{ alreadyMember?: boolean; notAMember?: boolean }>> => gate(P)
      ?? call('POST', `/v1/identity/internal-committee/changes/${enc(a.changeId)}`, { action: a.action, userId: a.userId, reason: a.reason, approvalId: a.requestId }),
  };
}

// OB-681 · OB-143: the chartered accountant's role — the owner asks, the IT custodian approves, the owner applies.
export interface CaGrantAsked { readonly requestId: string; readonly changeId: string; readonly status: string; readonly userId: string; readonly reason: string; readonly decidedBy?: string }

export function createCaGrantSession(input: { readonly viewer: Viewer; readonly newChangeId?: () => string } & Ctx) {
  const { call, may, gate } = base(input.viewer, input, 'ca-grant');
  const P = 'identity.ca.grant.request';
  const changeIdOf = input.newChangeId ?? (() => newId('ca'));
  return {
    may: { ask: may(P) },
    ask: async (userId: string, reason: string): Promise<W5Outcome<{ requestId: string }>> => {
      const no = gate(P); if (no !== undefined) return no;
      if (blank(userId)) return invalid('needAll');
      if (blank(reason)) return invalid('needReason');
      const changeId = changeIdOf();
      // The grant route's own body (without approvalId) plus its path id — what head office checks the approval against.
      const details = { userId: userId.trim(), reason: reason.trim(), changeId };
      return call('POST', '/v1/approvals/requests', { kind: 'ca_role_grant', subjectRef: changeId, details, valueMinor: null, summary: `Give ${userId.trim()} the chartered accountant's role`, reason: reason.trim() });
    },
    asked: async (): Promise<W5Outcome<readonly CaGrantAsked[]>> => {
      const no = gate(P); if (no !== undefined) return no;
      return map(await call<{ mine?: { requestId: string; kind: string; status: string; details?: Record<string, unknown>; decidedBy?: string }[] }>('GET', '/v1/approvals/requests'),
        (b) => (b.mine ?? []).filter((r) => r.kind === 'ca_role_grant' && r.details !== undefined).map((r): CaGrantAsked => ({
          requestId: r.requestId, status: r.status, changeId: String(r.details!['changeId'] ?? ''), userId: String(r.details!['userId'] ?? ''), reason: String(r.details!['reason'] ?? ''), ...(r.decidedBy === undefined ? {} : { decidedBy: r.decidedBy }),
        })));
    },
    apply: async (a: CaGrantAsked): Promise<W5Outcome<{ alreadyHeld?: boolean }>> => gate(P)
      ?? call('POST', `/v1/identity/chartered-accountant/grants/${enc(a.changeId)}`, { userId: a.userId, reason: a.reason, approvalId: a.requestId }),
  };
}

export const REVOCATION_REASONS = Object.freeze(['admin_revoked', 'security', 'credential_change', 'signed_out'] as const);
export interface RevocationRow { readonly id: string; readonly jti?: string; readonly userId?: string; readonly issuedBefore?: number; readonly reason: string; readonly revokedBy: string; readonly revokedAt: string }

export function createTokenRevocationSession(input: { readonly viewer: Viewer } & Ctx) {
  const { call, may, gate } = base(input.viewer, input, 'revoke');
  const P = 'identity.session.revoke';
  return {
    may: { revoke: may(P) },
    list: async (): Promise<W5Outcome<readonly RevocationRow[]>> => gate(P) ?? map(await call<{ revocations?: RevocationRow[] }>('GET', '/v1/identity/token-revocations'),
      (b) => [...(b.revocations ?? [])].sort((x, y) => y.revokedAt.localeCompare(x.revokedAt))),
    revoke: async (target: 'user' | 'token', id: string, reason: string): Promise<W5Outcome<{ revocation: RevocationRow }>> => {
      const no = gate(P); if (no !== undefined) return no;
      if (blank(id) || !(REVOCATION_REASONS as readonly string[]).includes(reason)) return invalid('needAll');
      return call('POST', '/v1/identity/token-revocations', { ...(target === 'user' ? { userId: id.trim() } : { jti: id.trim() }), reason });
    },
  };
}
export function revocationLine(lang: Lang, r: RevocationRow, when: When = plainWhen): string {
  const w = (k: string) => w5Words(lang, k);
  const target = r.jti !== undefined ? `${w('revOneToken')} ${r.jti}` : `${w('revAllOf')} ${r.userId ?? ''}${r.issuedBefore === undefined ? '' : ` (${w('revUpTo')} ${when(new Date(r.issuedBefore * 1000).toISOString())})`}`;
  return `${when(r.revokedAt)} · ${target} · ${w(`rr_${r.reason}`)} · ${w('by')} ${r.revokedBy}`;
}

// ── Store devices — M33-FR-02 remote sessions, version policy and remote kill ───────────────────────────────────────────

export interface RemoteRow { readonly sessionId: string; readonly deviceId: string; readonly userId: string; readonly kind: string; readonly openedAt: string; readonly lastSeenAt: string; readonly active: boolean; readonly terminatedBy?: string; readonly terminatedReason?: string; readonly terminatedAt?: string }
export interface VersionPolicyView { readonly currentVersion: string; readonly previousVersion?: string; readonly minimumSupportedVersion: string; readonly killedVersions?: readonly string[] }
const VERSION = /^\d+(\.\d+){0,3}$/;

export function createFleetControlSession(input: { readonly viewer: Viewer } & Ctx) {
  const { call, may, gate } = base(input.viewer, input, 'fleet-control');
  const R = 'platform.health.read'; const M = 'platform.device.manage';
  return {
    may: { read: may(R), manage: may(M) },
    sessions: async (): Promise<W5Outcome<readonly RemoteRow[]>> => gate(R) ?? map(await call<{ sessions?: RemoteRow[] }>('GET', '/v1/platform/remote-sessions'), (b) => b.sessions ?? []),
    terminate: async (sessionId: string, reason: string): Promise<W5Outcome<unknown>> => {
      const no = gate(M); if (no !== undefined) return no;
      if (blank(reason)) return invalid('needReason');
      return call('POST', `/v1/platform/remote-sessions/${enc(sessionId)}/terminate`, { reason: reason.trim() });
    },
    policy: async (): Promise<W5Outcome<VersionPolicyView | null>> => gate(R) ?? map(await call<{ policy?: VersionPolicyView | null }>('GET', '/v1/platform/version-policy'), (b) => b.policy ?? null),
    /** Set the policy; the withdrawn releases already on it are kept (a set never quietly brings a killed release back). */
    setPolicy: async (typed: { current: string; previous: string; minimum: string }, now: VersionPolicyView | null): Promise<W5Outcome<{ policy: VersionPolicyView }>> => {
      const no = gate(M); if (no !== undefined) return no;
      if (blank(typed.current) || blank(typed.minimum)) return invalid('needAll');
      if (![typed.current, typed.minimum, ...(blank(typed.previous) ? [] : [typed.previous])].every((v) => VERSION.test(v.trim()))) return invalid('notVersion');
      return call('POST', '/v1/platform/version-policy', { policy: {
        currentVersion: typed.current.trim(), minimumSupportedVersion: typed.minimum.trim(), ...(blank(typed.previous) ? {} : { previousVersion: typed.previous.trim() }),
        ...(now?.killedVersions === undefined || now.killedVersions.length === 0 ? {} : { killedVersions: now.killedVersions }),
      } });
    },
    /** Withdraw a broken release (A-10). The route asks only its own permission; the page asks the person to confirm. */
    kill: async (version: string, confirmed: boolean): Promise<W5Outcome<{ policy: VersionPolicyView }>> => {
      const no = gate(M); if (no !== undefined) return no;
      if (blank(version)) return invalid('needAll');
      if (!VERSION.test(version.trim())) return invalid('notVersion');
      if (!confirmed) return invalid('confirmKill');
      return call('POST', '/v1/platform/version-policy/kill', { version: version.trim() });
    },
  };
}
export function remoteLine(lang: Lang, s: RemoteRow, when: When = plainWhen): string {
  const w = (k: string) => w5Words(lang, k);
  const state = s.active ? w('rsLive') : `${w('rsEnded')}${s.terminatedBy === undefined ? '' : ` ${w('by')} ${s.terminatedBy}`}${s.terminatedReason === undefined ? '' : ` — ${s.terminatedReason}`}`;
  return `${s.sessionId} · ${w('rsFor')} ${s.userId} · ${w('rsOn')} ${s.deviceId} · ${s.kind} · ${w('rsOpened')} ${when(s.openedAt)} · ${w('rsSeen')} ${when(s.lastSeenAt)} · ${state}`;
}
export function policyLines(lang: Lang, p: VersionPolicyView | null): readonly string[] {
  const w = (k: string) => w5Words(lang, k);
  if (p === null) return [w('vpNone')];
  return [`${w('vpCurrent')}: ${p.currentVersion}`, `${w('vpPrevious')}: ${p.previousVersion ?? w('notSet')}`, `${w('vpMinimum')}: ${p.minimumSupportedVersion}`,
    `${w('vpKilled')}: ${(p.killedVersions ?? []).length === 0 ? '—' : p.killedVersions!.join(', ')}`];
}

// ── Roll-out — M33-FR-04 licences ───────────────────────────────────────────────────────────────────────────────────────

export interface LicenceRow { readonly moduleId: string; readonly name: string; readonly enabled: boolean; readonly expiresOn?: string; readonly ownerUserId: string; readonly ownerName: string }
export interface LicenceAlertRow { readonly moduleId: string; readonly name: string; readonly level: string; readonly daysRemaining: number; readonly ownerName: string; readonly message: string }

export function createLicencesSession(input: { readonly viewer: Viewer } & Ctx) {
  const { call, may, gate } = base(input.viewer, input, 'licence');
  const R = 'platform.entitlement.read'; const M = 'platform.entitlement.manage';
  return {
    may: { read: may(R), manage: may(M) },
    list: async (): Promise<W5Outcome<readonly LicenceRow[]>> => gate(R) ?? map(await call<{ licences?: LicenceRow[] }>('GET', '/v1/platform/licences'), (b) => b.licences ?? []),
    alerts: async (): Promise<W5Outcome<readonly LicenceAlertRow[]>> => gate(R) ?? map(await call<{ alerts?: LicenceAlertRow[] }>('GET', '/v1/platform/licences/alerts'), (b) => b.alerts ?? []),
    record: async (f: { moduleId: string; name: string; enabled: boolean; expiresOn: string; ownerUserId: string; ownerName: string }): Promise<W5Outcome<unknown>> => {
      const no = gate(M); if (no !== undefined) return no;
      if ([f.moduleId, f.name, f.ownerUserId, f.ownerName].some(blank)) return invalid('needAll');
      if (!blank(f.expiresOn) && !ISO_DATE.test(f.expiresOn.trim())) return invalid('notDate');
      return call('POST', `/v1/platform/licences/${enc(f.moduleId.trim())}`, {
        name: f.name.trim(), enabled: f.enabled, ownerUserId: f.ownerUserId.trim(), ownerName: f.ownerName.trim(), ...(blank(f.expiresOn) ? {} : { expiresOn: f.expiresOn.trim() }),
      });
    },
  };
}
export const licenceLine = (lang: Lang, l: LicenceRow): string =>
  `${l.name} (${l.moduleId}) · ${l.enabled ? w5Words(lang, 'licOn') : w5Words(lang, 'licOff')} · ${l.expiresOn === undefined ? w5Words(lang, 'licNoEnd') : `${w5Words(lang, 'licEnds')} ${l.expiresOn}`} · ${w5Words(lang, 'licOwner')} ${l.ownerName} (${l.ownerUserId})`;

// ── Integration health — M32-FR-03 secrets (references only; never a value) ────────────────────────────────────────────

/** What the page may show of a secret. `vaultRef` is WHERE it is kept (a pointer), never the key; nothing else is kept. */
export interface SecretView { readonly secretId: string; readonly kind: string; readonly vaultRef: string; readonly version: number; readonly state: string; readonly createdOn: string; readonly owner: string; readonly protects: string; readonly lastRotatedOn?: string; readonly revokedOn?: string; readonly rotateEveryDays: number; readonly environment: string }
export interface SecretIssueView { readonly secretId: string; readonly finding: string; readonly blocking: boolean; readonly detail: string }
const SECRET_FIELDS = ['secretId', 'kind', 'vaultRef', 'version', 'state', 'createdOn', 'owner', 'protects', 'lastRotatedOn', 'revokedOn', 'rotateEveryDays', 'environment'] as const;
/** Keep only the named fields — anything else head office ever sent along is dropped before the page sees it. */
export function secretViewOf(raw: Record<string, unknown>): SecretView {
  const out: Record<string, unknown> = {};
  for (const k of SECRET_FIELDS) if (raw[k] !== undefined) out[k] = raw[k];
  return out as unknown as SecretView;
}

export function createSecretsSession(input: { readonly viewer: Viewer } & Ctx) {
  const { call, may, gate } = base(input.viewer, input, 'secrets');
  const R = 'platform.setup.read';
  return {
    may: { read: may(R) },
    inventory: async (): Promise<W5Outcome<readonly SecretView[]>> => gate(R) ?? map(await call<{ secrets?: Record<string, unknown>[] }>('GET', '/v1/integration/secrets'), (b) => (b.secrets ?? []).map(secretViewOf)),
    /** Head office's review on the shop's day — it reads, it never writes. */
    review: async (): Promise<W5Outcome<{ issues: readonly SecretIssueView[]; detail: string }>> => gate(R)
      ?? map(await call<{ issues?: SecretIssueView[]; detail?: string }>('POST', '/v1/integration/secrets/review', {}), (b) => ({ issues: (b.issues ?? []).map((i) => ({ secretId: i.secretId, finding: i.finding, blocking: i.blocking, detail: i.detail })), detail: b.detail ?? '' })),
    /** W6 · M32-FR-03 · OB-688: each machine credential's use over the last 30 shop days, and what the nightly check found. */
    usage: async (): Promise<W5Outcome<SecretUsageView>> => gate(R) ?? map(await call<Record<string, unknown>>('GET', '/v1/integration/secrets/usage'), secretUsageViewOf),
  };
}

/** W6: what the page may show of a credential's use — its REFERENCE, the caller, the API and counts. Nothing else is kept. */
export interface SecretUseView { readonly credentialRef: string; readonly callerId: string; readonly api: string; readonly calls: number; readonly errors: number; readonly daysUsed: number; readonly lastUsedOn: string }
export interface SecretUseFindingView { readonly day: string; readonly baselineDay: string; readonly identityId: string; readonly api: string; readonly signal: string }
export interface SecretUsageView { readonly from: string; readonly to: string; readonly uses: readonly SecretUseView[]; readonly lastRolledUpDay: string | null; readonly findings: readonly SecretUseFindingView[]; readonly notJudged: readonly string[] }
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
export function secretUsageViewOf(raw: Record<string, unknown>): SecretUsageView {
  const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null) : []);
  return {
    from: str(raw['from']), to: str(raw['to']),
    uses: arr(raw['uses']).map((u) => ({ credentialRef: str(u['credentialRef']), callerId: str(u['callerId']), api: str(u['api']), calls: num(u['calls']), errors: num(u['errors']), daysUsed: num(u['daysUsed']), lastUsedOn: str(u['lastUsedOn']) })),
    lastRolledUpDay: typeof raw['lastRolledUpDay'] === 'string' ? raw['lastRolledUpDay'] : null,
    findings: arr(raw['findings']).map((f) => ({ day: str(f['day']), baselineDay: str(f['baselineDay']), identityId: str(f['identityId']), api: str(f['api']), signal: str(f['signal']) })),
    notJudged: Array.isArray(raw['notJudged']) ? raw['notJudged'].filter((d): d is string => typeof d === 'string') : [],
  };
}
export function secretUseLine(lang: Lang, u: SecretUseView): string {
  const w = (k: string) => w5Words(lang, k);
  return `${w('secRef')} ${u.credentialRef} · ${w('secBy')} ${u.callerId} · ${w('secOn')} ${u.api} · ${u.calls} ${w('secCalls')} · ${u.errors} ${w('secRefused')} · ${u.daysUsed} ${w('secDaysUsed')} · ${w('secLastUsed')} ${u.lastUsedOn}`;
}
/** A registered secret's own 30-day use: the uses whose credential reference is that secret's id. */
export function secretUseOf(lang: Lang, secretId: string, uses: readonly SecretUseView[]): string {
  const w = (k: string) => w5Words(lang, k);
  const mine = uses.filter((u) => u.credentialRef === secretId);
  if (mine.length === 0) return w('secNoUse');
  return `${w('secUseFor')}: ${mine.reduce((n, u) => n + u.calls, 0)} ${w('secCalls')}, ${mine.reduce((n, u) => n + u.errors, 0)} ${w('secRefused')}`;
}
export function secretUseFindingLine(lang: Lang, f: SecretUseFindingView): string {
  const w = (k: string) => w5Words(lang, k);
  return `${f.day} · ${f.identityId} · ${f.api} · ${w(`sig_${f.signal}`)} (${f.baselineDay})`;
}
export function secretLine(lang: Lang, s: SecretView): string {
  const w = (k: string) => w5Words(lang, k);
  return `${s.secretId} · ${s.kind} · ${s.environment} · ${s.protects} · ${s.owner} · ${w('secWhere')} ${s.vaultRef} · v${s.version} · ${w('secMade')} ${s.createdOn} · ${s.lastRotatedOn === undefined ? w('secNever') : `${w('secRotated')} ${s.lastRotatedOn}`} · ${w('secEvery')} ${s.rotateEveryDays} ${w('secDays')} · ${w('secState')}: ${w(`st_${s.state}`)}`;
}

// ── Incidents — M35-FR-04 link an alert · M33-FR-04 service requests ────────────────────────────────────────────────────

export interface IncidentPick { readonly incidentId: string; readonly title: string; readonly state: string; readonly alertIds: readonly string[] }
export interface AlertPick { readonly alertId: string; readonly component: string; readonly status: string; readonly detail: string }

export function createIncidentAlertSession(input: { readonly viewer: Viewer } & Ctx) {
  const { call, may, gate } = base(input.viewer, input, 'incident-alert');
  const R = 'platform.health.read'; const M = 'platform.alert.manage';
  return {
    may: { read: may(R), manage: may(M) },
    choices: async (): Promise<W5Outcome<{ incidents: readonly IncidentPick[]; alerts: readonly AlertPick[] }>> => {
      const no = gate(R); if (no !== undefined) return no;
      const inc = await call<{ incidents?: IncidentPick[] }>('GET', '/v1/platform/incidents'); if (inc.result !== 'ok') return inc;
      const al = await call<{ alerts?: { alert: AlertPick }[] }>('GET', '/v1/platform/alerts'); if (al.result !== 'ok') return al;
      return { result: 'ok', value: { incidents: (inc.value.incidents ?? []).filter((i) => i.state !== 'closed'), alerts: (al.value.alerts ?? []).map((a) => ({ alertId: a.alert.alertId, component: a.alert.component, status: a.alert.status, detail: a.alert.detail })) } };
    },
    link: async (incidentId: string, alertId: string): Promise<W5Outcome<{ alertIds: readonly string[]; alreadyLinked?: boolean }>> => {
      const no = gate(M); if (no !== undefined) return no;
      if (blank(incidentId) || blank(alertId)) return invalid('needAll');
      return call('POST', `/v1/platform/incidents/${enc(incidentId)}/alerts`, { alertId });
    },
  };
}

export const SR_PRIORITIES = Object.freeze(['low', 'normal', 'high', 'urgent'] as const);
export const SR_STATUSES = Object.freeze(['open', 'in_progress', 'resolved', 'closed'] as const);
export interface ServiceRequestRow { readonly requestId: string; readonly title: string; readonly detail: string; readonly category: string; readonly priority: string; readonly status: string; readonly raisedBy: string; readonly assignedTo?: string; readonly resolution?: string; readonly raisedAt: string; readonly updatedAt: string; readonly needsAttention: boolean }

export function createServiceRequestsSession(input: { readonly viewer: Viewer; readonly newRequestId?: () => string } & Ctx) {
  const { call, may, gate } = base(input.viewer, input, 'service-request');
  const R = 'platform.service.read'; const M = 'platform.service.manage';
  const idOf = input.newRequestId ?? (() => newId('sr'));
  return {
    may: { read: may(R), manage: may(M) },
    list: async (): Promise<W5Outcome<{ requests: readonly ServiceRequestRow[]; open: number }>> => gate(R) ?? map(await call<{ requests?: ServiceRequestRow[]; open?: number }>('GET', '/v1/platform/service-requests'), (b) => ({ requests: b.requests ?? [], open: b.open ?? 0 })),
    one: async (id: string): Promise<W5Outcome<ServiceRequestRow>> => gate(R) ?? map(await call<{ request: ServiceRequestRow }>('GET', `/v1/platform/service-requests/${enc(id)}`), (b) => b.request),
    raise: async (f: { title: string; detail: string; category: string; priority: string }): Promise<W5Outcome<{ requestId: string }>> => {
      const no = gate(M); if (no !== undefined) return no;
      if (blank(f.title) || blank(f.detail)) return invalid('needAll');
      return call('POST', '/v1/platform/service-requests', { requestId: idOf(), title: f.title.trim(), detail: f.detail.trim(), ...(blank(f.category) ? {} : { category: f.category.trim() }), priority: (SR_PRIORITIES as readonly string[]).includes(f.priority) ? f.priority : 'normal' });
    },
    assign: async (id: string, to: string): Promise<W5Outcome<unknown>> => {
      const no = gate(M); if (no !== undefined) return no;
      if (blank(to)) return invalid('needAll');
      return call('POST', `/v1/platform/service-requests/${enc(id)}/assign`, { assignedTo: to.trim() });
    },
    move: async (id: string, status: string, note: string): Promise<W5Outcome<unknown>> => {
      const no = gate(M); if (no !== undefined) return no;
      if (!(SR_STATUSES as readonly string[]).includes(status)) return invalid('needAll');
      if (status === 'resolved' && blank(note)) return invalid('needReason');
      return call('POST', `/v1/platform/service-requests/${enc(id)}/status`, { status, ...(blank(note) ? {} : { note: note.trim() }) });
    },
  };
}
export function serviceRequestLine(lang: Lang, r: ServiceRequestRow, when: When = plainWhen): string {
  const w = (k: string) => w5Words(lang, k);
  return `${r.title} · ${w(`s_${r.status}`)} · ${w(`p_${r.priority}`)} · ${r.category} · ${w('srRaisedBy')} ${r.raisedBy} ${when(r.raisedAt)}${r.assignedTo === undefined ? '' : ` · ${w('srWith')} ${r.assignedTo}`}${r.resolution === undefined ? '' : ` · ${r.resolution}`} — ${r.detail}`;
}

// ── Administration — M33-FR-03 support-access review ────────────────────────────────────────────────────────────────────

export interface SupportReviewRow { readonly sessionId: string; readonly requesterName: string; readonly approvedBy: string; readonly reason: string; readonly scopes: readonly string[]; readonly startedAt: string; readonly minutes: number; readonly actionCount: number; readonly active: boolean; readonly unused: boolean }

export function createSupportReviewSession(input: { readonly viewer: Viewer } & Ctx) {
  const { call, may, gate } = base(input.viewer, input, 'support-review');
  const R = 'platform.support.read';
  return {
    may: { read: may(R) },
    review: async (): Promise<W5Outcome<readonly SupportReviewRow[]>> => gate(R) ?? map(await call<{ review?: SupportReviewRow[] }>('GET', '/v1/platform/support-access/review'), (b) => b.review ?? []),
  };
}
export function supportReviewLine(lang: Lang, r: SupportReviewRow, when: When = plainWhen): string {
  const w = (k: string) => w5Words(lang, k);
  return `${r.requesterName} · ${w('supApproved')} ${r.approvedBy} · ${r.reason} · ${r.scopes.join(', ')} · ${when(r.startedAt)} · ${r.minutes} ${w('supMins')} · ${r.actionCount} ${w('supActs')}${r.active ? ` · ${w('supActive')}` : ''}${r.unused ? ` · ${w('supUnused')}` : ''}`;
}

// ── Document templates — PA-09 audited reprint ─────────────────────────────────────────────────────────────────────────

export interface IssuedDocument { readonly documentId: string; readonly kind: string; readonly subjectRef?: string; readonly content: string; readonly templateId: string; readonly templateVersion: number; readonly issuedAt: string; readonly issuedBy: string; readonly source?: { readonly number?: string }; readonly reprints?: readonly { readonly copyNumber: number; readonly reprintedBy: string; readonly reprintedAt: string; readonly reason: string }[] }
export interface ReprintAnswer { readonly documentId: string; readonly copyNumber: number; readonly marking: string; readonly content: string; readonly reprintedBy: string; readonly reprintedAt: string }

export function createReprintSession(input: { readonly viewer: Viewer } & Ctx) {
  const { call, may, gate } = base(input.viewer, input, 'reprint');
  const R = 'document.template.read'; const W = 'document.issue';
  return {
    may: { read: may(R), reprint: may(W) },
    find: async (documentId: string): Promise<W5Outcome<IssuedDocument>> => {
      const no = gate(R); if (no !== undefined) return no;
      if (blank(documentId)) return invalid('needAll');
      return call('GET', `/v1/documents/issued/${enc(documentId.trim())}`);
    },
    reprint: async (documentId: string, reason: string): Promise<W5Outcome<ReprintAnswer>> => {
      const no = gate(W); if (no !== undefined) return no;
      if (blank(reason)) return invalid('needReason');
      return call('POST', `/v1/documents/issued/${enc(documentId)}/reprint`, { reason: reason.trim() });
    },
  };
}
export const documentLine = (lang: Lang, d: IssuedDocument, when: When = plainWhen): string =>
  `${w5Words(lang, 'docKind')}: ${d.kind}${d.source?.number === undefined ? '' : ` · ${w5Words(lang, 'docNumber')} ${d.source.number}`} · ${w5Words(lang, 'docIssued')} ${when(d.issuedAt)} ${w5Words(lang, 'by')} ${d.issuedBy} · ${w5Words(lang, 'docReprints')}: ${(d.reprints ?? []).length}`;

// ── Owner alerts — M29-FR-04 schedule runs · Compare stores — M29-FR-02 drill audits ───────────────────────────────────

export interface ScheduleRunRow { readonly scheduleId: string; readonly kind: string; readonly tradingDay: string; readonly reason: string; readonly ranAt: string; readonly outcome: string; readonly lines: readonly string[]; readonly hasFile?: boolean }
export interface DrillAuditRow { readonly userId: string; readonly metric: string; readonly at: string; readonly transactionsShown: number; readonly transactionsWithheld: number; readonly reconciled: boolean }

export function createScheduleRunsSession(input: { readonly viewer: Viewer } & Ctx) {
  const { call, may, gate } = base(input.viewer, input, 'schedule-runs');
  const R = 'owner.kpi.read';
  return {
    may: { read: may(R) },
    schedules: async (): Promise<W5Outcome<readonly string[]>> => gate(R) ?? map(await call<{ schedules?: { schedule: { scheduleId: string } }[] }>('GET', '/v1/reporting/report-schedules'), (b) => (b.schedules ?? []).map((s) => s.schedule.scheduleId)),
    runs: async (scheduleId: string): Promise<W5Outcome<readonly ScheduleRunRow[]>> => gate(R) ?? map(await call<{ runs?: ScheduleRunRow[] }>('GET', `/v1/reporting/report-schedules/${enc(scheduleId)}/runs`), (b) => b.runs ?? []),
  };
}
export const scheduleRunLine = (lang: Lang, r: ScheduleRunRow, when: When = plainWhen): string =>
  `${r.tradingDay} · ${w5Words(lang, `o_${r.outcome}`)}${r.reason === 'missed_catch_up' ? ` · ${w5Words(lang, 'runsCatchUp')}` : ''} · ${when(r.ranAt)}${r.hasFile === true ? ` · ${w5Words(lang, 'runsFile')}` : ''}${r.lines.length === 0 ? '' : ` — ${r.lines.join(' / ')}`}`;

export function createDrillAuditsSession(input: { readonly viewer: Viewer } & Ctx) {
  const { call, may, gate } = base(input.viewer, input, 'drill-audits');
  const R = 'owner.kpi.read';
  return {
    may: { read: may(R) },
    read: async (): Promise<W5Outcome<readonly DrillAuditRow[]>> => gate(R) ?? map(await call<{ audits?: DrillAuditRow[] }>('GET', '/v1/reporting/drill-audits'), (b) => b.audits ?? []),
  };
}
export const drillAuditLine = (lang: Lang, a: DrillAuditRow, when: When = plainWhen): string =>
  `${when(a.at)} · ${a.userId} · ${a.metric} · ${a.transactionsShown} ${w5Words(lang, 'drillShown')} · ${a.transactionsWithheld} ${w5Words(lang, 'drillWithheld')} · ${a.reconciled ? w5Words(lang, 'drillAdds') : w5Words(lang, 'drillNotAdds')}`;

// ── Cash office — OB-82 legacy till placement ───────────────────────────────────────────────────────────────────────────

export interface LegacyRead { readonly tillId: string; readonly storeId: string | null; readonly unplacedLegacy?: { readonly movements: number; readonly balanceMinor: number; readonly custodian?: string | null }; readonly legacyPlacement?: { readonly storeId: string; readonly placedBy: string; readonly at: string; readonly countedHere: boolean } }

export function createLegacyPlacementSession(input: { readonly viewer: Viewer } & Ctx) {
  const { call, may, gate } = base(input.viewer, input, 'legacy-till');
  const R = 'cash.till.read'; const W = 'till.overshort.review';
  return {
    may: { read: may(R), place: may(W) },
    look: async (tillId: string, storeId: string): Promise<W5Outcome<LegacyRead>> => {
      const no = gate(R); if (no !== undefined) return no;
      if (blank(tillId) || blank(storeId)) return invalid('needAll');
      return call('GET', `/v1/tills/${enc(tillId.trim())}/cash?storeId=${enc(storeId.trim())}`);
    },
    place: async (tillId: string, storeId: string, reason: string): Promise<W5Outcome<unknown>> => {
      const no = gate(W); if (no !== undefined) return no;
      if (blank(tillId) || blank(storeId)) return invalid('needAll');
      if (blank(reason)) return invalid('needReason');
      return call('POST', `/v1/tills/${enc(tillId.trim())}/legacy-placement`, { storeId: storeId.trim(), reason: reason.trim() });
    },
  };
}
export function legacyLine(lang: Lang, r: LegacyRead, when: When = plainWhen): string {
  const w = (k: string) => w5Words(lang, k);
  if (r.legacyPlacement !== undefined) return `${w('legPlaced')} ${r.legacyPlacement.storeId} · ${w('by')} ${r.legacyPlacement.placedBy} · ${when(r.legacyPlacement.at)}`;
  if (r.unplacedLegacy !== undefined) return `${w('legUnplaced')} ${r.unplacedLegacy.movements} ${w('legMovements')} · ${w('legBalance')} ${rupees(r.unplacedLegacy.balanceMinor)}`;
  return w('legNoOld');
}

// ── Data in and out — OB-315 dry runs · M30-FR-04 import quality ───────────────────────────────────────────────────────

export interface TemplatePick { readonly id: string; readonly label?: string; readonly domain: string; readonly columns?: readonly unknown[]; readonly keyColumns?: readonly string[] }
export interface DryRunRow { readonly runId: string; readonly templateId: string; readonly ranBy: string; readonly at: string; readonly totalRows: number; readonly validCount: number; readonly errorRowCount: number; readonly commitReady: boolean; readonly errors: readonly { line: number; column: string; message: string }[] }
export interface QualityRow { readonly sourceId: string; readonly jobs: number; readonly totalRows: number; readonly rejectedRows: number; readonly acceptedBps: number | 'not_enough_data'; readonly band: string; readonly direction: string; readonly annualFixHours: number }
export interface QualityRead { readonly sources: readonly QualityRow[]; readonly worthAConversation: readonly string[]; readonly totalAnnualFixHours: number; readonly detail: string }
export interface JobRow { readonly jobId: string; readonly fileName: string; readonly uploadedBy: string; readonly uploadedAt: string; readonly outcome: string; readonly rows: string; readonly detail: string }

export function createImportChecksSession(input: { readonly viewer: Viewer; readonly newRunId?: () => string } & Ctx) {
  const { call, may, gate } = base(input.viewer, input, 'import-checks');
  const R = 'purchase.import.read';
  const idOf = input.newRunId ?? (() => newId('dry'));
  return {
    may: { read: may(R) },
    templates: async (): Promise<W5Outcome<readonly TemplatePick[]>> => gate(R) ?? map(await call<{ templates?: TemplatePick[] }>('GET', '/v1/import/templates'), (b) => b.templates ?? []),
    keep: async (templateId: string, text: string, declaredTotal: string): Promise<W5Outcome<{ dryRun: DryRunRow }>> => {
      const no = gate(R); if (no !== undefined) return no;
      if (blank(templateId) || blank(text)) return invalid('needAll');
      if (!blank(declaredTotal) && !/^\d+$/.test(declaredTotal.trim())) return invalid('notMoney');
      return call('POST', `/v1/import/dry-runs/${enc(idOf())}`, { templateId, text, ...(blank(declaredTotal) ? {} : { declaredTotalMinor: Number(declaredTotal.trim()) }) });
    },
    dryRuns: async (): Promise<W5Outcome<readonly DryRunRow[]>> => gate(R) ?? map(await call<{ dryRuns?: DryRunRow[] }>('GET', '/v1/import/dry-runs'), (b) => b.dryRuns ?? []),
    quality: async (): Promise<W5Outcome<QualityRead>> => gate(R) ?? call<QualityRead>('GET', '/v1/purchase/import-quality'),
    source: async (sourceId: string): Promise<W5Outcome<QualityRow & { topReasons?: readonly { reason?: string; count?: number }[] }>> => gate(R) ?? call('GET', `/v1/purchase/import-quality/${enc(sourceId)}`),
    jobs: async (): Promise<W5Outcome<readonly JobRow[]>> => gate(R) ?? map(await call<{ jobs?: JobRow[] }>('GET', '/v1/purchase/import-jobs'), (b) => b.jobs ?? []),
    /** U7 (OB-726): ONE page of every job, searched and sorted by head office, with the total of all of them. */
    jobsPage: async (ask: RegisterAsk): Promise<W5Outcome<{ readonly rows: readonly JobRow[]; readonly total: number }>> => {
      const no = gate(R); if (no !== undefined) return no;
      const out = await call<unknown>('GET', `/v1/purchase/import-jobs?${pagedQuery(ask, { when: 'uploadedAt', file: 'fileName' })}`);
      if (out.result !== 'ok') return out;
      const page = pagedAnswer(out.value, 'jobs');
      return page === undefined ? { result: 'lost_link' } : { result: 'ok', value: { rows: page.rows as readonly JobRow[], total: page.total } };
    },
  };
}
export function dryRunLine(lang: Lang, d: DryRunRow, when: When = plainWhen): string {
  const w = (k: string) => w5Words(lang, k);
  return `${when(d.at)} · ${d.templateId} · ${d.ranBy} · ${d.totalRows} ${w('dryRows')} · ${d.validCount} ${w('dryGood')} · ${d.errorRowCount} ${w('dryBad')} · ${d.commitReady ? w('dryReady') : w('dryNotReady')}`;
}
export function qualityLine(lang: Lang, q: QualityRow): string {
  const w = (k: string) => w5Words(lang, k);
  const acc = q.acceptedBps === 'not_enough_data' ? w('qualNotEnough') : `${(q.acceptedBps / 100).toFixed(1)}% ${w('qualAccepted')}`;
  return `${q.sourceId} · ${q.jobs} · ${q.totalRows} ${w('dryRows')} · ${acc} · ${q.band} · ${q.direction} · ${q.annualFixHours} ${w('qualHours')}`;
}
export const jobLine = (_lang: Lang, j: JobRow, when: When = plainWhen): string => `${when(j.uploadedAt)} · ${j.fileName} · ${j.outcome} · ${j.rows} · ${j.uploadedBy} — ${j.detail}`;
