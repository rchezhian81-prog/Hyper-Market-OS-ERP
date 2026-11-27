// QG-12 (roadmap §22 "Every gate ends GO, HOLD or REWORK with evidence; silence is not approval"; §36 the owner is
// accountable for GO/HOLD/REWORK; OB-288 gates lane) — the Quality gates page's tested, DOM-free session.
//
// It reads head office's gate register for one release (GET /v1/compliance/gate-register?release=…) and records the
// owner's decision on one gate (POST /v1/compliance/gate-decisions/:gate/:release). A gate nobody decided reads "Not
// decided — silence is not approval", never GO. A decision needs evidence and a written reason, here AND at head
// office; GO over a blocker is head office's refusal, shown in its own words. Nothing is written on open or on a timer.
// OB-423: the QG-10 row also shows the release script's own QG-10 notes (GET /v1/compliance/gate-register/qg10-evidence) —
// owner's answer (c): EVERY attempt of every release, newest first, each with its outcome, box, run and attempt; nothing
// hidden or collapsed into "latest".

import type { ViewerIdentity } from './browser-entry';
import { makeCaller, outcomeIn, newId, type Outcome } from './r4-insight-call';
import { shopDateTimeOf } from '../../../packages/calendar/src/shop-day';

export type Lang = 'en' | 'ta';
export type GateDecisionKind = 'GO' | 'HOLD' | 'REWORK';
export type GateState = 'undecided' | 'GO' | 'HOLD' | 'REWORK' | 'GO_NOW_BLOCKED';

export interface GateBlockerView { readonly gate: string; readonly kind: 'risk' | 'finding' | 'check'; readonly ref: string; readonly reason: string }
export interface GateStandingView {
  readonly gate: string; readonly name: string; readonly passCondition: string; readonly release: string;
  readonly decision: GateDecisionKind | null; readonly state: GateState;
  readonly decidedBy?: string; readonly decidedAt?: string; readonly rationale?: string;
  readonly evidence: readonly { readonly label: string; readonly ref: string }[];
  readonly blockers: readonly GateBlockerView[]; readonly decisionsMade: number;
}
export interface GateRegisterRead {
  readonly release: string; readonly gates: readonly GateStandingView[];
  readonly summary: { readonly undecided: number; readonly go: number; readonly hold: number; readonly rework: number; readonly goNowBlocked: number; readonly allGo: boolean };
  readonly releases: readonly string[]; readonly asAt: string;
}

export const RELEASES: readonly string[] = Object.freeze(['R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8']);
const GATE_IDS = Array.from({ length: 12 }, (_, i) => `QG-${String(i + 1).padStart(2, '0')}`);

export const GATES_COPY = {
  en: {
    lang: 'தமிழ்', title: 'Quality gates',
    lead: 'Every quality gate ends GO, HOLD or REWORK — decided by a named person, with evidence and a reason. A gate nobody has decided says so: silence is not approval. GO is refused while a serious risk, an open critical or high security finding, or a failed check stands against the gate.',
    releaseLabel: 'Release', chooseRelease: 'Choose a release', show: 'Show the gates',
    summaryH: 'This release', undecidedK: 'Not decided', goK: 'GO', holdK: 'HOLD', reworkK: 'REWORK', blockedK: 'GO, now blocked',
    gatesH: 'The twelve gates', passK: 'Pass condition (roadmap §22, in English)', decidedByK: 'Decided by', becauseK: 'Because', evidenceK: 'Evidence', blockersK: 'Blocking it now', noBlockers: 'Nothing blocks this gate now.',
    st_undecided: 'Not decided — silence is not approval', st_GO: 'GO — passed', st_HOLD: 'HOLD — waiting', st_REWORK: 'REWORK — to be done again', st_GO_NOW_BLOCKED: 'GO, but something now blocks it',
    k_risk: 'Risk', k_finding: 'Security finding', k_check: 'Check',
    decideH: 'Record a decision', gateLabel: 'Gate', decisionLabel: 'Decision', evidenceLabelLabel: 'Evidence — what it is', evidenceRefLabel: 'Evidence — where to find it (link or file)',
    reasonLabel: 'Why (this is the record)', record: 'Record the decision', recorded: 'Recorded at head office, in your name.',
    decideNot: 'Deciding a gate is the owner\'s — you can read the register.',
    nobody: 'Nobody is signed in on this screen — you can read nothing and change nothing.', cannotRead: 'Your role cannot read the gate register.',
    cannotDecide: 'Your role cannot decide a gate.', noRelease: 'Choose a release first.', noGate: 'Choose the gate.', noDecision: 'Choose GO, HOLD or REWORK.',
    noEvidence: 'A decision needs evidence: say what it is and where to find it.', noReason: 'Say, in writing, why.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was changed.',
    // OB-423: the release script's QG-10 notes, on the QG-10 row.
    qg10H: 'Release evidence from the release script (every attempt of every release, newest first)',
    qg10Lead: 'What the release script saw on each release — evidence for the QG-10 decision, never a decision.',
    qg10None: 'No release has left a QG-10 note on the register yet.',
    qg10Unread: 'The release evidence could not be read — this is not the same as "none".',
    qg10AllVerified: 'all five verified', qg10NotVerifiedK: 'not verified',
    qg10BoxK: 'box', qg10ByK: 'merged by', qg10RunK: 'run', qg10AtK: 'at', qg10DiffK: 'Difference',
    qg10AttemptK: 'attempt', qg10ByHand: 'by hand on this box,',
    // W7 · QG-01: the CI's reading of the requirement records, on the QG-01 row.
    qg01H: 'The requirement records, as the build checks them',
    qg01Lead: 'The same check the build runs on every change: each of the 144 module requirements names its actors, rules, error flow, permissions and acceptance.',
    qg01None: 'NOT KNOWN — no reading of the requirement records is on file.', qg01NotComplete: 'NOT KNOWN — the latest reading could not read every requirement record.',
    qg01Failing: 'Requirement records missing a field:', qg01Clean: 'The latest reading found all 144 records complete.',
    qg01NotPassed: 'This is evidence for the owner\'s QG-01 decision, not the decision — the gate is not passed until he records it with his signed review.',
    qg01Holds: 'QG-01 holds until a complete reading finds nothing missing.', qg01Unread: 'The requirement-records reading could not be read — this is not the same as "none".',
    qg01LatestK: 'Latest reading', qg01RunK: 'run', qg01CommitK: 'commit',
    // Pending item 8 · QG-11: the AI evaluations reading, built on head office's AI control read (GET /v1/ai/control).
    qg11H: 'The AI checks: evaluations, kill switch and budgets',
    qg11Lead: 'Each assistant in the evaluation set is tested against fixed cases for accuracy and safety. A run counts only when every case reached a model.',
    qg11NoLiveModel: 'HOLD — no live model is connected (OB-296; live provider EX-12), so no agent\'s evaluation can be complete.',
    qg11HoldsN: 'HOLD — {n} of {m} agents have no complete, passing evaluation.',
    qg11Holds: 'HOLD',
    qg11Empty: 'HOLD — no agent has evaluation cases on record, so nothing has been evaluated.',
    qg11Clean: 'Every agent\'s latest evaluation is complete and passing, with no unsafe case.',
    qg11NotPassed: 'This is evidence for the owner\'s QG-11 decision, not the decision — the gate is not passed until he records it with his signed review.',
    qg11HoldsUntil: 'QG-11 holds until every agent in the evaluation set has a complete, passing evaluation against a live model (R8, OB-382).',
    qg11Unread: 'The AI evaluations reading could not be read — this is not the same as "none".',
    qg11NotRun: 'no evaluation has been run yet',
    qg11NotComplete: 'NOT COMPLETE: it did not reach a model, so it proves nothing',
    qg11Unsafe: 'UNSAFE: {u} unsafe case; {p} of {t} passed',
    qg11Failed: 'failed: {p} of {t} passed',
    qg11Passed: 'complete and passing: {p} of {t}',
    qg11RunK: 'run',
    qg11KillOff: 'Kill switch: off — no assistant is stopped by it.',
    qg11KillMaster: 'Kill switch: the shop-wide AI switch is ON — every assistant is stopped.',
    qg11KillScoped: 'Kill switch: {n} switch is stopping an assistant ({who}).',
    qg11CapNone: 'Shop AI budget: not set — no call that costs anything can be made.',
    qg11Cap: 'Shop AI budget: {cap} a month, {spent} spent (platform ceiling {ceiling}).',
    qg11OwnNone: 'Agents with a budget of their own: none — only the shop budget applies.',
    qg11Own: 'Agents with a budget of their own: {who}.',
    qg11ProviderNone: 'Model: none connected — the assistants work on tested rules only.',
    qg11Provider: 'Model: a model provider is connected behind the governed call.',
    cannotReadAi: 'Your role cannot read the AI records, so the AI gate\'s reading cannot be shown.',
    c_health: 'health', c_smoke: 'smoke', c_reconciliation: 'reconciliation', c_monitoring: 'monitoring', c_rollback: 'rollback',
    o_deployed: 'deployed', o_rolled_back: 'rolled back', o_rolled_back_on_reconcile: 'rolled back — the books did not reconcile',
    o_rolled_back_in_canary_bake: 'rolled back — failed its canary watch', o_rollback_failed: 'rollback failed — a person was needed',
    o_refused_books_unreadable: 'refused — the books could not be read before it',
    s_verified: 'verified', s_failed: 'failed', s_not_run: 'not run', s_not_run_on_this_box: 'not run on this box', s_ready: 'ready, not used',
    s_exercised_ok: 'used, and it worked', s_exercised_failed: 'used, and it failed',
    // W3 · QG-04 / QG-05 / QG-06: the outside evidence only real hardware, the store or an independent vendor can give.
    outsideH: 'Outside evidence (tests the software cannot run by itself)',
    outsideLead: 'A gate whose outside test is not on file stays blocked — nothing on file is never a pass. Speeds are worked out from the measured figure against the fixed target; you do not type "passed".',
    outsideNone: 'nothing on file', outsidePassed: 'passed', outsideFailed: 'failed', outsideLatestK: 'latest',
    outsideUnread: 'The outside evidence could not be read — this is not the same as "none".',
    outsideKindLabel: 'Which test', outsideResultLabel: 'Result', outsideMsLabel: 'Measured p95 (milliseconds)',
    outsideWhereLabel: 'Where it was done (the certified store PC and lanes, or the vendor)', outsideRefLabel: 'Where the report is (file or link)',
    outsideOnLabel: 'Day it was tested', outsideStatementLabel: 'What you saw (this is the record)', outsideRecord: 'Record this evidence',
    outsideRecorded: 'Recorded at head office, in your name.', outsideNot: 'Recording outside evidence is the owner\'s — you can read it.',
    noKind: 'Choose which test.', noResult: 'Choose passed or failed.', noMs: 'Type the measured p95 in whole milliseconds.',
    noWhere: 'Say where it was done.', noRef: 'Say where the report is.', noDay: 'Give the day it was tested.', noStatement: 'Say, in writing, what you saw.',
    ev_offline_72h_simulation: '72-hour offline trading run (QG-04)', ev_power_process_chaos: 'Power, process and chaos test (QG-04)',
    ev_scan_to_line_p95: 'Scan-to-line speed, ≤300 ms (QG-05)', ev_total_tender_p95: 'Total and tender screen speed, ≤500 ms (QG-05)',
    ev_independent_pentest: 'Independent penetration test (QG-06, from R4)',
  },
  ta: {
    lang: 'English', title: 'தர வாயில்கள்',
    lead: 'ஒவ்வொரு தர வாயிலும் GO, HOLD அல்லது REWORK என்று முடிகிறது — பெயர் குறிப்பிட்ட ஒருவர், சான்றுடனும் காரணத்துடனும் முடிவு செய்கிறார். யாரும் முடிவு செய்யாத வாயில் அதைச் சொல்கிறது: மௌனம் ஒப்புதல் அல்ல. ஒரு தீவிர இடர், திறந்த உயர் அல்லது மிகத் தீவிரப் பாதுகாப்புக் குறைபாடு அல்லது தோல்வியடைந்த சோதனை வாயிலுக்கு எதிராக இருக்கும் வரை GO மறுக்கப்படும்.',
    releaseLabel: 'வெளியீடு', chooseRelease: 'ஒரு வெளியீட்டைத் தேர்ந்தெடுக்கவும்', show: 'வாயில்களைக் காட்டு',
    summaryH: 'இந்த வெளியீடு', undecidedK: 'முடிவு இல்லை', goK: 'GO', holdK: 'HOLD', reworkK: 'REWORK', blockedK: 'GO, இப்போது தடுக்கப்பட்டது',
    gatesH: 'பன்னிரண்டு வாயில்கள்', passK: 'தேர்ச்சி நிபந்தனை (சாலை வரைபடம் §22, ஆங்கிலத்தில்)', decidedByK: 'முடிவு செய்தவர்', becauseK: 'காரணம்', evidenceK: 'சான்று', blockersK: 'இப்போது தடுப்பவை', noBlockers: 'இந்த வாயிலை இப்போது எதுவும் தடுக்கவில்லை.',
    st_undecided: 'முடிவு இல்லை — மௌனம் ஒப்புதல் அல்ல', st_GO: 'GO — தேறியது', st_HOLD: 'HOLD — காத்திருக்கிறது', st_REWORK: 'REWORK — மீண்டும் செய்ய வேண்டும்', st_GO_NOW_BLOCKED: 'GO, ஆனால் இப்போது ஏதோ தடுக்கிறது',
    k_risk: 'இடர்', k_finding: 'பாதுகாப்புக் குறைபாடு', k_check: 'சோதனை',
    decideH: 'ஒரு முடிவைப் பதிவு செய்', gateLabel: 'வாயில்', decisionLabel: 'முடிவு', evidenceLabelLabel: 'சான்று — அது என்ன', evidenceRefLabel: 'சான்று — எங்கே காணலாம் (இணைப்பு அல்லது கோப்பு)',
    reasonLabel: 'ஏன் (இதுவே பதிவு)', record: 'முடிவைப் பதிவு செய்', recorded: 'உங்கள் பெயரில் தலைமை அலுவலகத்தில் பதிவு செய்யப்பட்டது.',
    decideNot: 'வாயிலை முடிவு செய்வது உரிமையாளருடையது — நீங்கள் பதிவேட்டைப் படிக்கலாம்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்கவோ மாற்றவோ முடியாது.', cannotRead: 'உங்கள் பங்கு வாயில் பதிவேட்டைப் படிக்க முடியாது.',
    cannotDecide: 'உங்கள் பங்கு வாயிலை முடிவு செய்ய முடியாது.', noRelease: 'முதலில் ஒரு வெளியீட்டைத் தேர்ந்தெடுக்கவும்.', noGate: 'வாயிலைத் தேர்ந்தெடுக்கவும்.', noDecision: 'GO, HOLD அல்லது REWORK தேர்ந்தெடுக்கவும்.',
    noEvidence: 'முடிவுக்குச் சான்று தேவை: அது என்ன, எங்கே காணலாம் என்று சொல்லவும்.', noReason: 'ஏன் என்று எழுத்தில் சொல்லவும்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் மாற்றப்படவில்லை.',
    qg10H: 'வெளியீட்டு நிரலின் சான்று (ஒவ்வொரு வெளியீட்டின் ஒவ்வொரு முயற்சியும், புதியது முதலில்)',
    qg10Lead: 'ஒவ்வொரு வெளியீட்டிலும் வெளியீட்டு நிரல் கண்டது — QG-10 முடிவுக்கான சான்று, முடிவு அல்ல.',
    qg10None: 'இதுவரை எந்த வெளியீடும் பதிவேட்டில் QG-10 குறிப்பை விடவில்லை.',
    qg10Unread: 'வெளியீட்டுச் சான்றைப் படிக்க முடியவில்லை — இது "எதுவும் இல்லை" என்பதற்குச் சமம் அல்ல.',
    qg10AllVerified: 'ஐந்தும் சரிபார்க்கப்பட்டன', qg10NotVerifiedK: 'சரிபார்க்கப்படாதவை',
    qg10BoxK: 'கணினி', qg10ByK: 'இணைத்தவர்', qg10RunK: 'ஓட்டம்', qg10AtK: 'நேரம்', qg10DiffK: 'வேறுபாடு',
    qg10AttemptK: 'முயற்சி', qg10ByHand: 'இந்தக் கணினியில் கையால்,',
    qg01H: 'தேவைப் பதிவுகள், கட்டமைப்பு சரிபார்ப்பது போல',
    qg01Lead: 'ஒவ்வொரு மாற்றத்திலும் கட்டமைப்பு செய்யும் அதே சரிபார்ப்பு: 144 தொகுதித் தேவைகள் ஒவ்வொன்றும் அதன் நபர்கள், விதிகள், பிழை வழி, அனுமதிகள் மற்றும் ஏற்பைக் குறிப்பிடுகிறது.',
    qg01None: 'தெரியவில்லை — தேவைப் பதிவுகளின் எந்த வாசிப்பும் பதிவில் இல்லை.', qg01NotComplete: 'தெரியவில்லை — கடைசி வாசிப்பால் எல்லாத் தேவைப் பதிவுகளையும் படிக்க முடியவில்லை.',
    qg01Failing: 'ஒரு புலம் விடுபட்ட தேவைப் பதிவுகள்:', qg01Clean: 'கடைசி வாசிப்பு 144 பதிவுகளும் முழுமையாக இருப்பதைக் கண்டது.',
    qg01NotPassed: 'இது உரிமையாளரின் QG-01 முடிவுக்கான சான்று, முடிவு அல்ல — அவர் கையொப்பமிட்ட மதிப்பாய்வுடன் பதிவு செய்யும் வரை வாயில் கடக்கவில்லை.',
    qg01Holds: 'முழுமையான வாசிப்பு எதுவும் விடுபடவில்லை என்று காணும் வரை QG-01 நிறுத்தி வைக்கப்படுகிறது.', qg01Unread: 'தேவைப் பதிவுகளின் வாசிப்பைப் படிக்க முடியவில்லை — இது "எதுவும் இல்லை" என்பதற்குச் சமம் அல்ல.',
    qg01LatestK: 'கடைசி வாசிப்பு', qg01RunK: 'ஓட்டம்', qg01CommitK: 'பதிப்பு',
    qg11H: 'செயற்கை நுண்ணறிவுச் சோதனைகள்: மதிப்பீடுகள், நிறுத்து சுவிட்ச், செலவு வரம்புகள்',
    qg11Lead: 'மதிப்பீட்டுத் தொகுப்பில் உள்ள ஒவ்வொரு உதவியாளரும் நிலையான சோதனைகளுக்கு எதிராகத் துல்லியம் மற்றும் பாதுகாப்புக்காகச் சோதிக்கப்படுகிறார். ஒவ்வொரு சோதனையும் ஒரு மாதிரியை அடைந்தால் மட்டுமே ஓட்டம் கணக்கில் கொள்ளப்படும்.',
    qg11NoLiveModel: 'நிறுத்தம் — நேரடி மாதிரி எதுவும் இணைக்கப்படவில்லை (OB-296; நேரடி வழங்குநர் EX-12), எனவே எந்த உதவியாளரின் மதிப்பீடும் முழுமையாக முடியாது.',
    qg11HoldsN: 'நிறுத்தம் — {m} உதவியாளர்களில் {n} பேருக்கு முழுமையான, தேறிய மதிப்பீடு இல்லை.',
    qg11Holds: 'நிறுத்தம்',
    qg11Empty: 'நிறுத்தம் — எந்த உதவியாளருக்கும் மதிப்பீட்டுச் சோதனைகள் பதிவில் இல்லை, எனவே எதுவும் மதிப்பிடப்படவில்லை.',
    qg11Clean: 'ஒவ்வொரு உதவியாளரின் கடைசி மதிப்பீடும் முழுமையானது, தேறியது, பாதுகாப்பற்ற சோதனை எதுவும் இல்லை.',
    qg11NotPassed: 'இது உரிமையாளரின் QG-11 முடிவுக்கான சான்று, முடிவு அல்ல — அவர் கையொப்பமிட்ட மதிப்பாய்வுடன் பதிவு செய்யும் வரை வாயில் கடக்கவில்லை.',
    qg11HoldsUntil: 'மதிப்பீட்டுத் தொகுப்பின் ஒவ்வொரு உதவியாளருக்கும் நேரடி மாதிரிக்கு எதிராக முழுமையான, தேறிய மதிப்பீடு வரும் வரை QG-11 நிறுத்தி வைக்கப்படுகிறது (R8, OB-382).',
    qg11Unread: 'செயற்கை நுண்ணறிவு மதிப்பீட்டு வாசிப்பைப் படிக்க முடியவில்லை — இது "எதுவும் இல்லை" என்பதற்குச் சமம் அல்ல.',
    qg11NotRun: 'இன்னும் எந்த மதிப்பீடும் செய்யப்படவில்லை',
    qg11NotComplete: 'முழுமையில்லை: அது எந்த மாதிரியையும் அடையவில்லை, எனவே எதையும் நிரூபிக்கவில்லை',
    qg11Unsafe: 'பாதுகாப்பற்றது: {u} பாதுகாப்பற்ற சோதனை; {t} இல் {p} தேறியது',
    qg11Failed: 'தோற்றது: {t} இல் {p} தேறியது',
    qg11Passed: 'முழுமையானது, தேறியது: {t} இல் {p}',
    qg11RunK: 'ஓட்டம்',
    qg11KillOff: 'நிறுத்து சுவிட்ச்: அணைந்துள்ளது — அதனால் எந்த உதவியாளரும் நிறுத்தப்படவில்லை.',
    qg11KillMaster: 'நிறுத்து சுவிட்ச்: கடை முழுவதற்குமான சுவிட்ச் இயங்குகிறது — ஒவ்வொரு உதவியாளரும் நிறுத்தப்பட்டுள்ளார்.',
    qg11KillScoped: 'நிறுத்து சுவிட்ச்: {n} சுவிட்ச் ஒரு உதவியாளரை நிறுத்தியுள்ளது ({who}).',
    qg11CapNone: 'கடையின் செயற்கை நுண்ணறிவுச் செலவு வரம்பு: அமைக்கப்படவில்லை — செலவு ஆகும் எந்த அழைப்பும் செய்ய முடியாது.',
    qg11Cap: 'கடையின் செயற்கை நுண்ணறிவுச் செலவு வரம்பு: மாதம் {cap}, செலவானது {spent} (தள உச்சவரம்பு {ceiling}).',
    qg11OwnNone: 'தனக்கென செலவு வரம்பு உள்ள உதவியாளர்கள்: யாரும் இல்லை — கடையின் வரம்பு மட்டுமே பொருந்தும்.',
    qg11Own: 'தனக்கென செலவு வரம்பு உள்ள உதவியாளர்கள்: {who}.',
    qg11ProviderNone: 'மாதிரி: எதுவும் இணைக்கப்படவில்லை — உதவியாளர்கள் சோதிக்கப்பட்ட விதிகளில் மட்டுமே வேலை செய்கிறார்கள்.',
    qg11Provider: 'மாதிரி: கட்டுப்படுத்தப்பட்ட அழைப்பின் பின்னால் ஒரு மாதிரி வழங்குநர் இணைக்கப்பட்டுள்ளார்.',
    cannotReadAi: 'உங்கள் பங்கு செயற்கை நுண்ணறிவுப் பதிவுகளைப் படிக்க முடியாது, எனவே அந்த வாயிலின் வாசிப்பைக் காட்ட முடியாது.',
    c_health: 'நலம்', c_smoke: 'புகைச் சோதனை', c_reconciliation: 'கணக்குச் சரிபார்ப்பு', c_monitoring: 'கண்காணிப்பு', c_rollback: 'பின்வாங்கல்',
    o_deployed: 'நிறுவப்பட்டது', o_rolled_back: 'பின்வாங்கப்பட்டது', o_rolled_back_on_reconcile: 'பின்வாங்கப்பட்டது — கணக்குகள் பொருந்தவில்லை',
    o_rolled_back_in_canary_bake: 'பின்வாங்கப்பட்டது — முன்னோட்டக் கண்காணிப்பில் தோற்றது', o_rollback_failed: 'பின்வாங்கல் தோற்றது — ஒருவர் தேவைப்பட்டார்',
    o_refused_books_unreadable: 'மறுக்கப்பட்டது — முன்பே கணக்குகளைப் படிக்க முடியவில்லை',
    s_verified: 'சரிபார்க்கப்பட்டது', s_failed: 'தோற்றது', s_not_run: 'செய்யப்படவில்லை', s_not_run_on_this_box: 'இந்தக் கணினியில் செய்யப்படவில்லை', s_ready: 'தயார், பயன்படுத்தப்படவில்லை',
    s_exercised_ok: 'பயன்படுத்தப்பட்டது, வேலை செய்தது', s_exercised_failed: 'பயன்படுத்தப்பட்டது, தோற்றது',
    outsideH: 'வெளிச் சான்று (மென்பொருள் தானே செய்ய முடியாத சோதனைகள்)',
    outsideLead: 'வெளிச் சோதனை பதிவில் இல்லாத வாயில் தடுக்கப்பட்டே இருக்கும் — பதிவில் இல்லாதது ஒருபோதும் தேர்ச்சி அல்ல. வேகம் அளந்த எண்ணிலிருந்து நிலையான இலக்குடன் கணக்கிடப்படுகிறது; "தேறியது" என்று நீங்கள் தட்டச்சு செய்வதில்லை.',
    outsideNone: 'பதிவில் எதுவும் இல்லை', outsidePassed: 'தேறியது', outsideFailed: 'தோற்றது', outsideLatestK: 'சமீபத்தியது',
    outsideUnread: 'வெளிச் சான்றைப் படிக்க முடியவில்லை — இது "எதுவும் இல்லை" என்பதற்குச் சமம் அல்ல.',
    outsideKindLabel: 'எந்தச் சோதனை', outsideResultLabel: 'முடிவு', outsideMsLabel: 'அளந்த p95 (மில்லி வினாடிகள்)',
    outsideWhereLabel: 'எங்கே செய்யப்பட்டது (சான்றளிக்கப்பட்ட கடைக் கணினி, கவுண்டர்கள், அல்லது நிறுவனம்)', outsideRefLabel: 'அறிக்கை எங்கே உள்ளது (கோப்பு அல்லது இணைப்பு)',
    outsideOnLabel: 'சோதித்த நாள்', outsideStatementLabel: 'நீங்கள் கண்டது (இதுவே பதிவு)', outsideRecord: 'இந்தச் சான்றைப் பதிவு செய்',
    outsideRecorded: 'உங்கள் பெயரில் தலைமை அலுவலகத்தில் பதிவு செய்யப்பட்டது.', outsideNot: 'வெளிச் சான்றைப் பதிவு செய்வது உரிமையாளருடையது — நீங்கள் படிக்கலாம்.',
    noKind: 'எந்தச் சோதனை என்று தேர்ந்தெடுக்கவும்.', noResult: 'தேறியது அல்லது தோற்றது என்று தேர்ந்தெடுக்கவும்.', noMs: 'அளந்த p95-ஐ முழு மில்லி வினாடிகளில் தட்டச்சு செய்யவும்.',
    noWhere: 'எங்கே செய்யப்பட்டது என்று சொல்லவும்.', noRef: 'அறிக்கை எங்கே என்று சொல்லவும்.', noDay: 'சோதித்த நாளைக் கொடுக்கவும்.', noStatement: 'நீங்கள் கண்டதை எழுத்தில் சொல்லவும்.',
    ev_offline_72h_simulation: '72 மணி நேர இணையமில்லா விற்பனை ஓட்டம் (QG-04)', ev_power_process_chaos: 'மின், செயல்முறை, குழப்பச் சோதனை (QG-04)',
    ev_scan_to_line_p95: 'ஸ்கேன்-முதல்-வரி வேகம், ≤300 ms (QG-05)', ev_total_tender_p95: 'மொத்தம் மற்றும் செலுத்தும் திரை வேகம், ≤500 ms (QG-05)',
    ev_independent_pentest: 'சுயாதீன ஊடுருவல் சோதனை (QG-06, R4 முதல்)',
  },
} as const;
export type GatesCopyKey = keyof typeof GATES_COPY.en;
export const gatesWords = (lang: Lang, key: GatesCopyKey | string): string => (GATES_COPY[lang] as Record<string, string>)[key] ?? (GATES_COPY.en as Record<string, string>)[key] ?? key;
export const gatesOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => gatesWords(lang, k), out, lang); // U0 · G10

/** The gates' own names in both languages (roadmap §22 names them in English). */
export const GATE_NAMES: Readonly<Record<string, { readonly en: string; readonly ta: string }>> = Object.freeze({
  'QG-01': { en: 'Requirements', ta: 'தேவைகள்' }, 'QG-02': { en: 'UX', ta: 'பயன்பாட்டு எளிமை' }, 'QG-03': { en: 'Code', ta: 'நிரல்' },
  'QG-04': { en: 'Offline', ta: 'இணையமில்லா இயக்கம்' }, 'QG-05': { en: 'Performance', ta: 'செயல்திறன்' }, 'QG-06': { en: 'Security', ta: 'பாதுகாப்பு' },
  'QG-07': { en: 'Data', ta: 'தரவு' }, 'QG-08': { en: 'Recovery', ta: 'மீட்பு' }, 'QG-09': { en: 'Adoption', ta: 'பயிற்சி ஏற்பு' },
  'QG-10': { en: 'Production', ta: 'நேரடி இயக்கம்' }, 'QG-11': { en: 'AI', ta: 'செயற்கை நுண்ணறிவு' }, 'QG-12': { en: 'Owner', ta: 'உரிமையாளர்' },
});

/** A state as the page shows it: an icon AND words AND a tone — never a colour alone (design system §1 rule 7). */
export function stateView(lang: Lang, state: GateState): { readonly icon: string; readonly words: string; readonly tone: 'ok' | 'degraded' | 'error' | 'idle' } {
  const icon = { undecided: '○', GO: '✓', HOLD: '⏸', REWORK: '↺', GO_NOW_BLOCKED: '⚠' }[state];
  const tone = ({ undecided: 'idle', GO: 'ok', HOLD: 'degraded', REWORK: 'degraded', GO_NOW_BLOCKED: 'error' } as const)[state];
  return { icon, words: gatesWords(lang, `st_${state}`), tone };
}

/** OB-423: one release's QG-10 note as head office keeps it (GET /v1/compliance/gate-register/qg10-evidence). */
export interface Qg10NoteRead {
  readonly release: string; readonly previous: string; readonly at: string; readonly by: string; readonly run: string; readonly attempt: string; readonly box: string;
  readonly outcome: string; readonly checks: Readonly<Record<string, string>>; readonly verified: boolean;
  readonly notVerified: readonly string[]; readonly differences: readonly string[]; readonly recordedAt: string;
}
export interface Qg10EvidenceRead { readonly notes: readonly Qg10NoteRead[]; readonly count: number }

/** The five things QG-10 names, in the release script's order (packages/compliance QG10_CHECKS). */
const QG10_CHECK_ORDER = Object.freeze(['health', 'smoke', 'reconciliation', 'monitoring', 'rollback'] as const);

/** OB-423 (a): an attempt as words — the pipeline's number as it is, a box-local one as "by hand on this box, <UTC time>". */
function attemptWords(lang: Lang, attempt: string): string {
  const m = /^local-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(attempt);
  return m === null ? attempt : `${gatesWords(lang, 'qg10ByHand')} ${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]} UTC`;
}

/**
 * One note as the QG-10 row shows it: an icon AND words (never a colour alone) — ✓ when all five checks verified, ⚠ naming
 * each one that was not; the release, the box, the run and the attempt, who merged it, when, and every difference in words.
 */
export function qg10NoteView(lang: Lang, n: Qg10NoteRead): { readonly icon: string; readonly tone: 'ok' | 'error'; readonly headline: string; readonly lines: readonly string[] } {
  const w = (k: string) => gatesWords(lang, k);
  const verdict = n.verified ? w('qg10AllVerified') : `${w('qg10NotVerifiedK')}: ${n.notVerified.map((c) => w(`c_${c}`)).join(', ')}`;
  return {
    icon: n.verified ? '✓' : '⚠', tone: n.verified ? 'ok' : 'error',
    headline: `${n.release.slice(0, 12)} · ${w(`o_${n.outcome}`)} · ${verdict}`,
    lines: [
      `${w('qg10BoxK')}: ${n.box} · ${w('qg10RunK')}: ${n.run} · ${w('qg10AttemptK')}: ${attemptWords(lang, n.attempt)} · ${w('qg10ByK')}: ${n.by} · ${w('qg10AtK')}: ${n.at}`,
      // Always QG-10's own order (a stored line's keys may come back in any order — PostgreSQL's jsonb sorts them).
      QG10_CHECK_ORDER.filter((c) => c in n.checks).map((c) => `${w(`c_${c}`)}: ${w(`s_${n.checks[c]!}`)}`).join(' · '),
      ...n.differences.map((d) => `${w('qg10DiffK')}: ${d}`),
    ],
  };
}

/** W7 · QG-01: the CI's reading of the requirement records, as head office answers it (GET /v1/compliance/gate-register/qg01-reading). */
export interface Qg01ReadingRead {
  readonly standing: 'not_known' | 'failing' | 'check_clean';
  readonly latest: { readonly runId: string; readonly scannedAt: string; readonly complete: boolean; readonly commit?: string; readonly incompleteBecause?: readonly string[] } | null;
  readonly failing: readonly { readonly findingId: string; readonly title: string; readonly location: string }[];
}

/**
 * W7 · QG-01: the reading as the QG-01 row shows it — an icon AND words. No reading, or one that could not read every record,
 * is NOT KNOWN (⚠, the gate holds); a record missing a field names it (⚠, the gate holds); a clean reading (✓) says it is
 * evidence for the owner's decision — never that the gate is passed. A read that failed says so, never "nothing".
 */
export function qg01ReadingView(lang: Lang, out: Outcome<Qg01ReadingRead> | null): { readonly icon: string; readonly tone: 'ok' | 'error'; readonly state: string; readonly headline: string; readonly lines: readonly string[] } {
  const w = (k: string) => gatesWords(lang, k);
  if (out === null || out.result !== 'ok') return { icon: '⚠', tone: 'error', state: 'unread', headline: out === null ? w('qg01Unread') : `${w('qg01Unread')} ${gatesOutcomeWords(lang, out)}`, lines: [] };
  const r = out.value;
  const when = r.latest === null ? [] : [`${w('qg01LatestK')}: ${shopDateTimeOf(r.latest.scannedAt) || r.latest.scannedAt} · ${w('qg01RunK')}: ${r.latest.runId}${r.latest.commit === undefined ? '' : ` · ${w('qg01CommitK')}: ${r.latest.commit.slice(0, 12)}`}`];
  if (r.standing === 'check_clean') return { icon: '✓', tone: 'ok', state: r.standing, headline: w('qg01Clean'), lines: [...when, w('qg01NotPassed')] };
  if (r.standing === 'failing') return { icon: '⚠', tone: 'error', state: r.standing, headline: `${w('qg01Failing')} ${r.failing.length}`, lines: [...when, ...r.failing.map((f) => `${f.title} — ${f.location}`), w('qg01Holds')] };
  return { icon: '⚠', tone: 'error', state: r.standing, headline: r.latest === null ? w('qg01None') : w('qg01NotComplete'), lines: [...when, ...(r.latest?.incompleteBecause ?? []), w('qg01Holds')] };
}

/**
 * Pending item 8 · QG-11: the part of head office's AI control read (GET /v1/ai/control, `ai.proposal.read`) the AI gate's
 * reading needs — each agent's latest evaluation run, the kill switch, the budgets and whether a model is connected.
 */
export interface Qg11ControlRead {
  readonly agents: readonly {
    readonly agentId: string; readonly name: string; readonly enabled: boolean; readonly stopped: boolean; readonly stoppedBecause: string | null;
    readonly ceilingMinor: number | null; readonly evaluationCases: number;
    readonly lastEvaluation: {
      readonly runId: string; readonly at: string; readonly passed: number; readonly total: number; readonly unsafe: number;
      readonly complete: boolean; readonly fitToFacePeople: boolean; readonly detail: string;
    } | null;
  }[];
  readonly killSwitch: { readonly masterOn: boolean; readonly active: readonly { readonly switchId: string; readonly scope: string; readonly agentId?: string }[] };
  readonly budget: { readonly capMinor: number; readonly spentMinor: number; readonly platformCeilingMinor: number };
  readonly provider: { readonly configured: boolean };
}
export type Qg11AgentState = 'not_run' | 'not_complete' | 'unsafe' | 'failed' | 'passed';
export interface Qg11ReadingViewShape {
  readonly icon: string; readonly tone: 'ok' | 'error'; readonly state: 'unread' | 'no_live_model' | 'holds' | 'evaluations_clean';
  readonly headline: string;
  readonly agents: readonly { readonly agentId: string; readonly icon: string; readonly state: Qg11AgentState; readonly words: string }[];
  readonly lines: readonly string[];
}

const fill = (template: string, values: Readonly<Record<string, string | number>>): string => template.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));
const rupeesOf = (paise: number): string => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** One agent's latest run, judged: a run counts only when every case reached a model (complete); unsafe outranks failed. */
function qg11AgentState(e: Qg11ControlRead['agents'][number]['lastEvaluation']): Qg11AgentState {
  if (e === null) return 'not_run';
  if (!e.complete) return 'not_complete';
  if (e.unsafe > 0) return 'unsafe';
  return e.fitToFacePeople && e.passed === e.total ? 'passed' : 'failed';
}

/**
 * Pending item 8 · QG-11: the AI gate's reading as the QG-11 row shows it — an icon AND words. Each agent the evaluation set has
 * cases for, with its latest run; the kill switch and the budgets in words. With no live model connected nothing can be complete,
 * so the gate HOLDS (OB-296; EX-12; R8 OB-382). With one connected, any agent not complete-and-passing holds it by name; all
 * complete and passing is evidence for the owner's decision — never "passed". No agent in the set, or a reading that could not
 * be read, holds too: silence is never a pass.
 */
export function qg11ReadingView(lang: Lang, out: Outcome<Qg11ControlRead> | null): Qg11ReadingViewShape {
  const w = (k: string) => gatesWords(lang, k);
  if (out === null || out.result !== 'ok') {
    return { icon: '⚠', tone: 'error', state: 'unread', headline: out === null ? w('qg11Unread') : `${w('qg11Unread')} ${gatesOutcomeWords(lang, out)}`, agents: [], lines: [w('qg11HoldsUntil')] };
  }
  const r = out.value;
  const inSet = r.agents.filter((a) => a.evaluationCases > 0);
  const agents = inSet.map((a) => {
    const e = a.lastEvaluation;
    const state = qg11AgentState(e);
    const icon = state === 'passed' ? '✓' : state === 'not_run' ? '○' : '⚠';
    const what = state === 'not_run' ? w('qg11NotRun') : state === 'not_complete' ? w('qg11NotComplete')
      : fill(w(state === 'unsafe' ? 'qg11Unsafe' : state === 'failed' ? 'qg11Failed' : 'qg11Passed'), { u: e!.unsafe, p: e!.passed, t: e!.total });
    const when = e === null ? '' : ` · ${w('qg11RunK')} ${e.runId} · ${shopDateTimeOf(e.at) || e.at}`;
    return { agentId: a.agentId, icon, state, words: `${a.agentId} · ${a.name} — ${what}${when}` };
  });
  const scoped = r.killSwitch.active.filter((s) => s.scope !== 'all_ai');
  const kill = r.killSwitch.masterOn ? w('qg11KillMaster')
    : scoped.length === 0 ? w('qg11KillOff')
      : fill(w('qg11KillScoped'), { n: scoped.length, who: scoped.map((s) => s.agentId ?? s.scope).join(', ') });
  const cap = r.budget.capMinor === 0 ? w('qg11CapNone')
    : fill(w('qg11Cap'), { cap: rupeesOf(r.budget.capMinor), spent: rupeesOf(r.budget.spentMinor), ceiling: rupeesOf(r.budget.platformCeilingMinor) });
  const own = r.agents.filter((a) => a.ceilingMinor !== null).map((a) => a.agentId);
  const controls = [r.provider.configured ? w('qg11Provider') : w('qg11ProviderNone'), kill, cap, own.length === 0 ? w('qg11OwnNone') : fill(w('qg11Own'), { who: own.join(', ') })];
  const short = agents.filter((a) => a.state !== 'passed').length;
  if (!r.provider.configured) return { icon: '⚠', tone: 'error', state: 'no_live_model', headline: w('qg11NoLiveModel'), agents, lines: [...controls, w('qg11HoldsUntil')] };
  if (agents.length === 0) return { icon: '⚠', tone: 'error', state: 'holds', headline: w('qg11Empty'), agents, lines: [...controls, w('qg11HoldsUntil')] };
  if (short > 0) return { icon: '⚠', tone: 'error', state: 'holds', headline: fill(w('qg11HoldsN'), { n: short, m: agents.length }), agents, lines: [...controls, w('qg11HoldsUntil')] };
  return { icon: '✓', tone: 'ok', state: 'evaluations_clean', headline: w('qg11Clean'), agents, lines: [...controls, w('qg11NotPassed')] };
}

/** W3: the outside evidence kinds, in the register's order (packages/compliance GATE_EVIDENCE_SPECS). */
export const OUTSIDE_KINDS = Object.freeze(['offline_72h_simulation', 'power_process_chaos', 'scan_to_line_p95', 'total_tender_p95', 'independent_pentest'] as const);
export type OutsideKind = (typeof OUTSIDE_KINDS)[number];
/** The two that are timings: their result is worked out at head office from the measured p95. */
export const OUTSIDE_TIMINGS: readonly OutsideKind[] = Object.freeze(['scan_to_line_p95', 'total_tender_p95']);
export interface OutsideRecordRead {
  readonly evidenceId: string; readonly kind: OutsideKind; readonly gate: string; readonly result: 'passed' | 'failed'; readonly measuredMs?: number;
  readonly where: string; readonly reportRef: string; readonly testedOn: string; readonly statement: string; readonly recordedBy: string; readonly recordedAt: string;
}
export interface OutsideEvidenceRead {
  readonly records: readonly OutsideRecordRead[];
  readonly kinds: readonly { readonly kind: OutsideKind; readonly gate: string; readonly maxMs?: number; readonly standing: 'nothing_on_file' | 'passed' | 'failed'; readonly latest: OutsideRecordRead | null }[];
}

/** One kind's standing as the page shows it: an icon AND words AND a tone — nothing on file is never a pass. */
export function outsideStandingView(lang: Lang, k: OutsideEvidenceRead['kinds'][number]): { readonly icon: string; readonly tone: 'ok' | 'error' | 'idle'; readonly words: string } {
  const w = (key: string) => gatesWords(lang, key);
  if (k.standing === 'nothing_on_file' || k.latest === null) return { icon: '○', tone: 'idle', words: `${w(`ev_${k.kind}`)} — ${w('outsideNone')}` };
  const figure = k.latest.measuredMs === undefined ? '' : ` · p95 ${k.latest.measuredMs} ms`;
  return {
    icon: k.standing === 'passed' ? '✓' : '⚠', tone: k.standing === 'passed' ? 'ok' : 'error',
    words: `${w(`ev_${k.kind}`)} — ${w(k.standing === 'passed' ? 'outsidePassed' : 'outsideFailed')}${figure} · ${w('outsideLatestK')}: ${k.latest.testedOn} · ${k.latest.where} · ${k.latest.reportRef}`,
  };
}

export interface GatesSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly decide: boolean };
  read(release: string): Promise<Outcome<GateRegisterRead>>;
  /** OB-423: every attempt's QG-10 note, newest first (a GET — the same read right as the register). */
  readEvidence(): Promise<Outcome<Qg10EvidenceRead>>;
  /** W7 · QG-01: the CI's reading of the requirement records (a GET — the register's read right). */
  readQg01(): Promise<Outcome<Qg01ReadingRead>>;
  /** Pending item 8 · QG-11: head office's AI control read (a GET — needs the register's read right AND the AI records' read right). */
  readQg11(): Promise<Outcome<Qg11ControlRead>>;
  decide(input: {
    readonly gate: string; readonly release: string; readonly decision: string;
    readonly evidenceLabel: string; readonly evidenceRef: string; readonly rationale: string;
  }): Promise<Outcome<{ readonly decision: { readonly decision: GateDecisionKind; readonly decidedBy: string } }>>;
  /** W3: the outside evidence and each kind's standing (a GET — the register's read right). */
  readOutside(): Promise<Outcome<OutsideEvidenceRead>>;
  /** W3: record one piece of outside evidence in the signed-in owner's name (a timing sends only its measured p95). */
  recordOutside(input: {
    readonly kind: string; readonly result: string; readonly measuredMs: string; readonly where: string;
    readonly reportRef: string; readonly testedOn: string; readonly statement: string;
  }): Promise<Outcome<{ readonly evidence: OutsideRecordRead }>>;
}

export function createGatesSession(input: { readonly viewer: ViewerIdentity | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string; readonly newEvidenceId?: (kind: string) => string }): GatesSession {
  const newEvidenceId = input.newEvidenceId ?? ((kind: string) => newId(kind.replace(/_/g, '-')));
  const perms = new Set(input.viewer?.permissions ?? []);
  const named = input.viewer?.userId !== undefined;
  const may = { named, read: named && perms.has('compliance.gate.read'), decide: named && perms.has('compliance.gate.decide') };
  const call = makeCaller({ keyPrefix: 'gate', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  return {
    may,
    read: async (release) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      if (!may.read) return { result: 'invalid', why: 'cannotRead' };
      if (!RELEASES.includes(release)) return { result: 'invalid', why: 'noRelease' };
      return call('GET', `/v1/compliance/gate-register?release=${encodeURIComponent(release)}`);
    },
    readEvidence: async () => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      if (!may.read) return { result: 'invalid', why: 'cannotRead' };
      return call('GET', '/v1/compliance/gate-register/qg10-evidence');
    },
    readQg01: async () => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      if (!may.read) return { result: 'invalid', why: 'cannotRead' };
      return call('GET', '/v1/compliance/gate-register/qg01-reading');
    },
    readQg11: async () => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      if (!may.read) return { result: 'invalid', why: 'cannotRead' };
      if (!perms.has('ai.proposal.read')) return { result: 'invalid', why: 'cannotReadAi' };
      return call('GET', '/v1/ai/control');
    },
    decide: async (d) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      if (!may.decide) return { result: 'invalid', why: 'cannotDecide' };
      if (!RELEASES.includes(d.release)) return { result: 'invalid', why: 'noRelease' };
      if (!GATE_IDS.includes(d.gate)) return { result: 'invalid', why: 'noGate' };
      if (!['GO', 'HOLD', 'REWORK'].includes(d.decision)) return { result: 'invalid', why: 'noDecision' };
      if (d.evidenceLabel.trim() === '' || d.evidenceRef.trim() === '') return { result: 'invalid', why: 'noEvidence' };
      if (d.rationale.trim() === '') return { result: 'invalid', why: 'noReason' };
      // The decider is NOT sent: head office takes it from the signed-in person (§36, a decision has an author).
      return call('POST', `/v1/compliance/gate-decisions/${encodeURIComponent(d.gate)}/${encodeURIComponent(d.release)}`, {
        decision: d.decision, evidence: [{ label: d.evidenceLabel.trim(), ref: d.evidenceRef.trim() }], rationale: d.rationale.trim(),
      });
    },
    readOutside: async () => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      if (!may.read) return { result: 'invalid', why: 'cannotRead' };
      return call('GET', '/v1/compliance/gate-evidence');
    },
    recordOutside: async (e) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      if (!may.decide) return { result: 'invalid', why: 'cannotDecide' };
      if (!(OUTSIDE_KINDS as readonly string[]).includes(e.kind)) return { result: 'invalid', why: 'noKind' };
      const timing = OUTSIDE_TIMINGS.includes(e.kind as OutsideKind);
      const ms = Number(e.measuredMs.trim());
      if (timing && (!/^\d+$/.test(e.measuredMs.trim()) || ms <= 0)) return { result: 'invalid', why: 'noMs' };
      if (!timing && e.result !== 'passed' && e.result !== 'failed') return { result: 'invalid', why: 'noResult' };
      if (e.where.trim() === '') return { result: 'invalid', why: 'noWhere' };
      if (e.reportRef.trim() === '') return { result: 'invalid', why: 'noRef' };
      if (!/^\d{4}-\d{2}-\d{2}$/.test(e.testedOn.trim())) return { result: 'invalid', why: 'noDay' };
      if (e.statement.trim() === '') return { result: 'invalid', why: 'noStatement' };
      // The recorder is NOT sent (head office takes the signed-in person), nor a timing's result (worked out there).
      return call('POST', `/v1/compliance/gate-evidence/${newEvidenceId(e.kind)}`, {
        kind: e.kind, ...(timing ? { measuredMs: ms } : { result: e.result }),
        where: e.where.trim(), reportRef: e.reportRef.trim(), testedOn: e.testedOn.trim(), statement: e.statement.trim(),
      });
    },
  };
}
