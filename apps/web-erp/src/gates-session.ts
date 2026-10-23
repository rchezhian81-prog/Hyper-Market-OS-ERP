// QG-12 (roadmap §22 "Every gate ends GO, HOLD or REWORK with evidence; silence is not approval"; §36 the owner is
// accountable for GO/HOLD/REWORK; OB-288 gates lane) — the Quality gates page's tested, DOM-free session.
//
// It reads head office's gate register for one release (GET /v1/compliance/gate-register?release=…) and records the
// owner's decision on one gate (POST /v1/compliance/gate-decisions/:gate/:release). A gate nobody decided reads "Not
// decided — silence is not approval", never GO. A decision needs evidence and a written reason, here AND at head
// office; GO over a blocker is head office's refusal, shown in its own words. Nothing is written on open or on a timer.

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

export interface GatesSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly decide: boolean };
  read(release: string): Promise<Outcome<GateRegisterRead>>;
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
