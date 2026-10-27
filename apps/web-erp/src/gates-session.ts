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
import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';

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
    c_health: 'health', c_smoke: 'smoke', c_reconciliation: 'reconciliation', c_monitoring: 'monitoring', c_rollback: 'rollback',
    o_deployed: 'deployed', o_rolled_back: 'rolled back', o_rolled_back_on_reconcile: 'rolled back — the books did not reconcile',
    o_rolled_back_in_canary_bake: 'rolled back — failed its canary watch', o_rollback_failed: 'rollback failed — a person was needed',
    o_refused_books_unreadable: 'refused — the books could not be read before it',
    s_verified: 'verified', s_failed: 'failed', s_not_run: 'not run', s_not_run_on_this_box: 'not run on this box', s_ready: 'ready, not used',
    s_exercised_ok: 'used, and it worked', s_exercised_failed: 'used, and it failed',
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
    c_health: 'நலம்', c_smoke: 'புகைச் சோதனை', c_reconciliation: 'கணக்குச் சரிபார்ப்பு', c_monitoring: 'கண்காணிப்பு', c_rollback: 'பின்வாங்கல்',
    o_deployed: 'நிறுவப்பட்டது', o_rolled_back: 'பின்வாங்கப்பட்டது', o_rolled_back_on_reconcile: 'பின்வாங்கப்பட்டது — கணக்குகள் பொருந்தவில்லை',
    o_rolled_back_in_canary_bake: 'பின்வாங்கப்பட்டது — முன்னோட்டக் கண்காணிப்பில் தோற்றது', o_rollback_failed: 'பின்வாங்கல் தோற்றது — ஒருவர் தேவைப்பட்டார்',
    o_refused_books_unreadable: 'மறுக்கப்பட்டது — முன்பே கணக்குகளைப் படிக்க முடியவில்லை',
    s_verified: 'சரிபார்க்கப்பட்டது', s_failed: 'தோற்றது', s_not_run: 'செய்யப்படவில்லை', s_not_run_on_this_box: 'இந்தக் கணினியில் செய்யப்படவில்லை', s_ready: 'தயார், பயன்படுத்தப்படவில்லை',
    s_exercised_ok: 'பயன்படுத்தப்பட்டது, வேலை செய்தது', s_exercised_failed: 'பயன்படுத்தப்பட்டது, தோற்றது',
  },
} as const;
export type GatesCopyKey = keyof typeof GATES_COPY.en;
export const gatesWords = (lang: Lang, key: GatesCopyKey | string): string => (GATES_COPY[lang] as Record<string, string>)[key] ?? (GATES_COPY.en as Record<string, string>)[key] ?? key;
export const gatesOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => gatesWords(lang, k), out);

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

export interface GatesSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly decide: boolean };
  read(release: string): Promise<Outcome<GateRegisterRead>>;
  /** OB-423: every attempt's QG-10 note, newest first (a GET — the same read right as the register). */
  readEvidence(): Promise<Outcome<Qg10EvidenceRead>>;
  decide(input: {
    readonly gate: string; readonly release: string; readonly decision: string;
    readonly evidenceLabel: string; readonly evidenceRef: string; readonly rationale: string;
  }): Promise<Outcome<{ readonly decision: { readonly decision: GateDecisionKind; readonly decidedBy: string } }>>;
}

export function createGatesSession(input: { readonly viewer: ViewerIdentity | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string }): GatesSession {
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
  };
}
