// Training checks (W3 · OB-675 · QG-02 · roadmap §2.3) — a tested, DOM-free session over head office's scored check per
// role (services/finance/src/role-checks.ts):
//   • THE READING — per role: its check (questions and tasks to watch), the pass mark ("not set" until the owner sets it),
//     the people trained for it with their latest score, and whether at least 90% of them passed (pilot, R0–R2) and 95%
//     (final, after the pilot), with why not (`GET /v1/hr/workforce/role-checks`);
//   • SET THE CHECK — a person who manages training writes the questions and the tasks, one per line
//     (`POST /v1/hr/workforce/role-checks/:roleId`); a changed list is a new version, the earlier ones are kept;
//   • SET THE PASS MARK — the owner only (`POST …/:roleId/pass-mark`), a whole percentage 1–100; never a default;
//   • RECORD AN ATTEMPT — a trainer ticks each item the person passed (`POST …/:roleId/attempts/:attemptId`); head office
//     works out the score and refuses the person recording their own. A retake is a new attempt; the latest counts.
// Reading needs `workforce.roster.read`; the check and attempts `workforce.training.manage`; the pass mark
// `workforce.curriculum.approve` (the owner). Head office re-checks each. Every word this page adds has a Tamil twin; head
// office's own sentences stay in English (OB-553).

import { makeCaller, newId, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const TRAINING_CHECKS_COPY = {
  en: {
    title: 'Training checks',
    lead: 'A scored check for each role — questions to answer and tasks a trainer watches. The owner sets the pass mark. The training gate (QG-02) passes when, in every role, at least 90% of the trained staff passed (the pilot) and 95% (after the pilot). A role with no check, no pass mark or nobody trained is not passed.',
    readingH: 'The training gate by role', refresh: 'Read again', role: 'Role', check: 'Check', noCheck: 'not set', version: 'version', items: 'items',
    passMark: 'Pass mark', notSet: 'not set', trained: 'Trained', passedOf: 'passed', pilot: 'Pilot (90%)', final: 'After the pilot (95%)', passed: 'passed', notPassed: 'not passed',
    notSat: 'not yet sat', latest: 'latest', why: 'Why not',
    checkH: 'Set the check', questions: 'Questions (one per line)', tasks: 'Tasks the trainer watches (one per line)', saveCheck: 'Save this check',
    markH: 'Pass mark (the owner sets it)', markLabel: 'Pass mark (%)', setMark: 'Set the pass mark',
    attemptH: 'Record an attempt', person: 'Staff id', note: 'Note (optional)', passedItem: 'passed', record: 'Record this attempt',
    checkSaved: 'Saved. This is the role\'s check now.', markSaved: 'Saved. The pass mark is set.',
    attemptSaved: 'Recorded.', scored: 'Score', passMarkWas: 'pass mark', resultPassed: 'passed', resultNotPassed: 'not passed',
    noRoles: 'No role to show yet — nobody is on the staff list in a role.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot see the training checks.', cannotManage: 'Your role cannot set a check or record an attempt.', cannotMark: 'Only the owner sets the pass mark.',
    needLines: 'Write at least one question or task, one per line.', needMark: 'Type the pass mark as a whole number from 1 to 100.', needPerson: 'Type the person\'s staff id.', needCheck: 'Set the check first.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or changed.', reading: 'Asking head office…',
  },
  ta: {
    title: 'பயிற்சித் தேர்வுகள்',
    lead: 'ஒவ்வொரு பணிக்கும் மதிப்பெண் தேர்வு — பதில் சொல்ல வேண்டிய கேள்விகள், பயிற்சியாளர் கவனிக்கும் பணிகள். தேர்ச்சி மதிப்பெண்ணை உரிமையாளர் அமைக்கிறார். ஒவ்வொரு பணியிலும் பயிற்சி பெற்றவர்களில் குறைந்தது 90% (சோதனை ஓட்டம்) மற்றும் 95% (அதன் பிறகு) தேர்ச்சி பெற்றால் பயிற்சி வாயில் (QG-02) தேர்ச்சி. தேர்வு, தேர்ச்சி மதிப்பெண் அல்லது பயிற்சி பெற்றவர் இல்லாத பணி தேர்ச்சி இல்லை.',
    readingH: 'பணி வாரியாகப் பயிற்சி வாயில்', refresh: 'மீண்டும் படி', role: 'பணி', check: 'தேர்வு', noCheck: 'அமைக்கப்படவில்லை', version: 'பதிப்பு', items: 'உருப்படிகள்',
    passMark: 'தேர்ச்சி மதிப்பெண்', notSet: 'அமைக்கப்படவில்லை', trained: 'பயிற்சி பெற்றவர்கள்', passedOf: 'தேர்ச்சி', pilot: 'சோதனை ஓட்டம் (90%)', final: 'சோதனை ஓட்டத்துக்குப் பிறகு (95%)', passed: 'தேர்ச்சி', notPassed: 'தேர்ச்சி இல்லை',
    notSat: 'இன்னும் எழுதவில்லை', latest: 'கடைசி', why: 'ஏன் இல்லை',
    checkH: 'தேர்வை அமை', questions: 'கேள்விகள் (ஒரு வரிக்கு ஒன்று)', tasks: 'பயிற்சியாளர் கவனிக்கும் பணிகள் (ஒரு வரிக்கு ஒன்று)', saveCheck: 'இந்தத் தேர்வைச் சேமி',
    markH: 'தேர்ச்சி மதிப்பெண் (உரிமையாளர் அமைக்கிறார்)', markLabel: 'தேர்ச்சி மதிப்பெண் (%)', setMark: 'தேர்ச்சி மதிப்பெண்ணை அமை',
    attemptH: 'ஒரு முயற்சியைப் பதிவு செய்', person: 'பணியாளர் எண்', note: 'குறிப்பு (விருப்பம்)', passedItem: 'தேர்ச்சி', record: 'இந்த முயற்சியைப் பதிவு செய்',
    checkSaved: 'சேமிக்கப்பட்டது. இதுவே இப்போது இந்தப் பணியின் தேர்வு.', markSaved: 'சேமிக்கப்பட்டது. தேர்ச்சி மதிப்பெண் அமைக்கப்பட்டது.',
    attemptSaved: 'பதிவு செய்யப்பட்டது.', scored: 'மதிப்பெண்', passMarkWas: 'தேர்ச்சி மதிப்பெண்', resultPassed: 'தேர்ச்சி', resultNotPassed: 'தேர்ச்சி இல்லை',
    noRoles: 'காட்ட எந்தப் பணியும் இல்லை — பணியாளர் பட்டியலில் யாரும் ஒரு பணியில் இல்லை.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு பயிற்சித் தேர்வுகளைப் பார்க்க முடியாது.', cannotManage: 'உங்கள் பங்கு தேர்வை அமைக்கவோ முயற்சியைப் பதிவு செய்யவோ முடியாது.', cannotMark: 'தேர்ச்சி மதிப்பெண்ணை உரிமையாளர் மட்டுமே அமைக்கிறார்.',
    needLines: 'குறைந்தது ஒரு கேள்வி அல்லது பணியை, ஒரு வரிக்கு ஒன்றாக எழுதுங்கள்.', needMark: 'தேர்ச்சி மதிப்பெண்ணை 1 முதல் 100 வரையிலான முழு எண்ணாகத் தட்டச்சு செய்யுங்கள்.', needPerson: 'பணியாளர் எண்ணைத் தட்டச்சு செய்யுங்கள்.', needCheck: 'முதலில் தேர்வை அமையுங்கள்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை, மாற்றப்படவில்லை.', reading: 'தலைமை அலுவலகத்திடம் கேட்கிறது…',
  },
} as const;

export const trainingChecksWords = (lang: Lang, key: string): string =>
  (TRAINING_CHECKS_COPY[lang] as Record<string, string>)[key] ?? (TRAINING_CHECKS_COPY.en as Record<string, string>)[key] ?? key;
export const trainingChecksOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => trainingChecksWords(lang, k), out);

export interface CheckItem { readonly itemId: string; readonly kind: 'question' | 'task'; readonly text: string }
export interface RoleRow {
  readonly roleId: string;
  readonly check: { readonly version: number; readonly items: number } | null;
  readonly items: readonly CheckItem[];
  readonly passMarkPercent: number | null;
  readonly trained: readonly { readonly employeeId: string; readonly name: string; readonly latest: { readonly scorePercent: number; readonly passed: boolean } | null }[];
  readonly passedCount: number;
  readonly passedPercent: number | null;
  readonly pilot: 'passed' | 'not_passed';
  readonly final: 'passed' | 'not_passed';
  readonly why: readonly string[];
}
export interface ChecksView { readonly roles: readonly RoleRow[]; readonly asAt: string }

type Why = 'nobody' | 'cannotRead' | 'cannotManage' | 'cannotMark' | 'needLines' | 'needMark' | 'needPerson' | 'needCheck';
type Done<T> = Promise<Outcome<T, Why>>;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The questions and tasks, one per line, as the check's items (q1…, t1…); blank lines dropped. */
export function itemsFromLines(questions: string, tasks: string): readonly CheckItem[] {
  const lines = (s: string) => s.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  return [
    ...lines(questions).map((text, i): CheckItem => ({ itemId: `q${i + 1}`, kind: 'question', text })),
    ...lines(tasks).map((text, i): CheckItem => ({ itemId: `t${i + 1}`, kind: 'task', text })),
  ];
}

/** "90" → 90; undefined unless a whole number from 1 to 100. */
export function passMarkOf(raw: string): number | undefined {
  const s = raw.trim();
  if (!/^\d{1,3}$/.test(s)) return undefined;
  const n = Number(s);
  return n >= 1 && n <= 100 ? n : undefined;
}

export interface TrainingChecksSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly manage: boolean; readonly setMark: boolean };
  read(): Done<ChecksView>;
  setCheck(roleId: string, questions: string, tasks: string): Done<{ readonly version: number }>;
  setPassMark(roleId: string, raw: string): Done<{ readonly passMarkPercent: number }>;
  record(roleId: string, employeeId: string, results: readonly { readonly itemId: string; readonly passed: boolean }[], note: string): Done<{ readonly scorePercent: number; readonly passMarkPercent: number; readonly passed: boolean }>;
}

export function createTrainingChecksSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch; readonly newAttemptId?: () => string }): TrainingChecksSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('workforce.roster.read'), manage: named && held.has('workforce.training.manage'), setMark: named && held.has('workforce.curriculum.approve') };
  const call = makeCaller({ keyPrefix: 'training-checks', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  const attemptIdOf = input.newAttemptId ?? (() => newId('att'));
  const no = (why: Why): { result: 'invalid'; why: Why } => ({ result: 'invalid', why });
  const gate = (need: 'read' | 'manage' | 'setMark') => (!named ? no('nobody') : !may[need] ? no(need === 'read' ? 'cannotRead' : need === 'manage' ? 'cannotManage' : 'cannotMark') : undefined);
  const role = (id: string): string => encodeURIComponent(id.trim());
  return {
    may,
    read: async () => {
      const g = gate('read'); if (g) return g;
      const out = await call<{ roles?: unknown[]; asAt?: unknown }>('GET', '/v1/hr/workforce/role-checks');
      if (out.result !== 'ok') return out;
      const roles = (out.value.roles ?? []).flatMap((r): RoleRow[] => {
        if (!isObj(r) || typeof r['roleId'] !== 'string') return [];
        const check = isObj(r['check']) ? { version: Number(r['check']['version']), items: Number(r['check']['items']) } : null;
        return [{
          roleId: r['roleId'], check,
          items: Array.isArray(r['items']) ? r['items'].flatMap((i) => (isObj(i) && typeof i['itemId'] === 'string' && (i['kind'] === 'question' || i['kind'] === 'task') ? [{ itemId: i['itemId'], kind: i['kind'], text: str(i['text']) }] : [])) : [],
          passMarkPercent: typeof r['passMarkPercent'] === 'number' ? r['passMarkPercent'] : null,
          trained: Array.isArray(r['trained']) ? r['trained'].flatMap((p) => (isObj(p) && typeof p['employeeId'] === 'string'
            ? [{ employeeId: p['employeeId'], name: str(p['name']), latest: isObj(p['latest']) ? { scorePercent: Number(p['latest']['scorePercent']), passed: p['latest']['passed'] === true } : null }] : [])) : [],
          passedCount: typeof r['passedCount'] === 'number' ? r['passedCount'] : 0,
          passedPercent: typeof r['passedPercent'] === 'number' ? r['passedPercent'] : null,
          // Anything but an explicit "passed" reads not passed — never a pass from a missing word (P-08).
          pilot: r['pilot'] === 'passed' ? 'passed' : 'not_passed', final: r['final'] === 'passed' ? 'passed' : 'not_passed',
          why: Array.isArray(r['why']) ? r['why'].filter((w): w is string => typeof w === 'string') : [],
        }];
      });
      return { result: 'ok', value: { roles, asAt: str(out.value.asAt) } };
    },
    setCheck: async (roleId, questions, tasks) => {
      const g = gate('manage'); if (g) return g;
      const items = itemsFromLines(questions, tasks);
      if (items.length === 0) return no('needLines');
      const out = await call<{ check?: { version?: unknown } }>('POST', `/v1/hr/workforce/role-checks/${role(roleId)}`, { items });
      return out.result === 'ok' ? { result: 'ok', value: { version: Number(out.value.check?.version ?? 0) } } : out;
    },
    setPassMark: async (roleId, raw) => {
      const g = gate('setMark'); if (g) return g;
      const passMarkPercent = passMarkOf(raw);
      if (passMarkPercent === undefined) return no('needMark');
      const out = await call('POST', `/v1/hr/workforce/role-checks/${role(roleId)}/pass-mark`, { passMarkPercent });
      return out.result === 'ok' ? { result: 'ok', value: { passMarkPercent } } : out;
    },
    record: async (roleId, employeeId, results, note) => {
      const g = gate('manage'); if (g) return g;
      if (employeeId.trim() === '') return no('needPerson');
      if (results.length === 0) return no('needCheck');
      const out = await call<{ attempt?: { scorePercent?: unknown; passMarkPercent?: unknown; passed?: unknown } }>('POST', `/v1/hr/workforce/role-checks/${role(roleId)}/attempts/${encodeURIComponent(attemptIdOf())}`,
        { employeeId: employeeId.trim(), results, ...(note.trim() === '' ? {} : { note: note.trim() }) });
      return out.result === 'ok'
        ? { result: 'ok', value: { scorePercent: Number(out.value.attempt?.scorePercent ?? 0), passMarkPercent: Number(out.value.attempt?.passMarkPercent ?? 0), passed: out.value.attempt?.passed === true } }
        : out;
    },
  };
}
