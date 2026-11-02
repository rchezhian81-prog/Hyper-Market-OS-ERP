// Emergency access (W3 · D11-FR-02 · M02-FR-04 · SEC-11 · §28 · P-04) — a tested, DOM-free session over head office's
// emergency-access routes (services/identity/src/emergency-access.ts), which no screen reached: a manager who needed to give
// someone the owner's rights for twenty minutes could not ask for it, and the owner could not end it early, without a
// programmer. The rules stay head office's; this page only asks:
//   • ASK — the signed-in person (`identity.role.request`) asks the owner to approve EXACTLY this grant: who, which role, in
//     which stores, for how many minutes and why (`POST /v1/approvals/requests`, kind `emergency_access`). Nothing changes
//     yet: the owner decides it on the Approvals page, in his own session — never the person who asked (§28);
//   • GIVE — once the owner approved it, the person who asked presses "Give the access now" and head office grants it with
//     that approval (`POST /v1/access/emergency/:grantId` { …the same details, approvalId }). The end time is fixed then;
//     it ends on its own;
//   • END EARLY — the owner (`identity.role.grant`) cuts a live grant short (`POST …/:grantId/revoke`), recorded, never erased;
//   • REVIEW — every grant, live and ended, with who asked, who approved, why and until when (`GET /v1/access/emergency`,
//     `identity.role.read`).
// Every word this page adds has a Tamil twin; head office's own sentences stay in English (OB-553).

import { makeCaller, newId, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const EMERGENCY_COPY = {
  en: {
    title: 'Emergency access',
    lead: 'Give someone extra access for a short time — for example to fix something urgent. You ask; the owner approves exactly what you asked on the Approvals page; then you give it here. It ends on its own at the time fixed when it was given, and the owner can end it early. Everything is kept on the record.',
    askH: 'Ask for emergency access', person: 'Person (staff id)', role: 'Role to give', stores: 'Stores (ids, separated by commas — or "all")', minutes: 'For how many minutes', reason: 'Why (be specific)', ask: 'Ask the owner to approve',
    asksH: 'My asks', noAsks: 'You have not asked for emergency access.', give: 'Give the access now',
    st_waiting: 'Waiting for the owner to approve', st_approved: 'Approved — you can give it now', st_rejected: 'The owner said no', st_expired: 'The approval ran out of time — ask again', st_used: 'Given',
    reviewH: 'Every emergency grant', noGrants: 'No emergency access has ever been given.', live: 'live', ended: 'ended', endedEarly: 'ended early',
    until: 'until', for: 'for', minutesWord: 'minutes', approvedBy: 'approved by', askedFor: 'for', endH: 'End now', endReasonHint: 'Ends this person\'s emergency access now.', end: 'End it now',
    asked: 'Asked. The owner decides it on the Approvals page; nothing has changed yet.', given: 'Given. It ends on its own at', endedNow: 'Ended. It stays on the record.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot see emergency access.', cannotAsk: 'Your role cannot ask for emergency access.', cannotEnd: 'Only the owner can end emergency access early.',
    needPerson: 'Type the staff id of the person who needs it.', needRole: 'Type the role to give.', needStores: 'Name the stores, or type "all".', needMinutes: 'Type the minutes as a whole number above 0.', needReason: 'Say why, specifically.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or changed.', reading: 'Asking head office…',
  },
  ta: {
    title: 'அவசர அணுகல்',
    lead: 'ஒருவருக்குக் குறுகிய நேரத்திற்குக் கூடுதல் அணுகல் கொடுங்கள் — எ.கா. அவசரமான ஒன்றைச் சரிசெய்ய. நீங்கள் கேட்கிறீர்கள்; நீங்கள் கேட்டதையே உரிமையாளர் அனுமதிகள் பக்கத்தில் ஏற்கிறார்; பிறகு இங்கே கொடுக்கிறீர்கள். கொடுக்கும்போது நிர்ணயிக்கப்பட்ட நேரத்தில் தானாக முடியும்; உரிமையாளர் முன்கூட்டியே முடிக்கலாம். எல்லாம் பதிவில் வைக்கப்படும்.',
    askH: 'அவசர அணுகல் கேள்', person: 'நபர் (பணியாளர் அடையாளம்)', role: 'கொடுக்க வேண்டிய பங்கு', stores: 'கடைகள் (அடையாளங்கள், காற்புள்ளியால் பிரித்து — அல்லது "all")', minutes: 'எத்தனை நிமிடங்களுக்கு', reason: 'ஏன் (தெளிவாக)', ask: 'உரிமையாளரிடம் அனுமதி கேள்',
    asksH: 'என் கோரிக்கைகள்', noAsks: 'நீங்கள் அவசர அணுகல் கேட்கவில்லை.', give: 'இப்போது அணுகலைக் கொடு',
    st_waiting: 'உரிமையாளரின் அனுமதிக்குக் காத்திருக்கிறது', st_approved: 'அனுமதிக்கப்பட்டது — இப்போது கொடுக்கலாம்', st_rejected: 'உரிமையாளர் மறுத்தார்', st_expired: 'அனுமதியின் நேரம் முடிந்தது — மீண்டும் கேளுங்கள்', st_used: 'கொடுக்கப்பட்டது',
    reviewH: 'ஒவ்வொரு அவசர அணுகலும்', noGrants: 'இதுவரை எந்த அவசர அணுகலும் கொடுக்கப்படவில்லை.', live: 'இயக்கத்தில்', ended: 'முடிந்தது', endedEarly: 'முன்கூட்டியே முடிக்கப்பட்டது',
    until: 'வரை', for: 'காலம்', minutesWord: 'நிமிடங்கள்', approvedBy: 'அனுமதித்தவர்', askedFor: 'யாருக்கு', endH: 'இப்போது முடி', endReasonHint: 'இந்த நபரின் அவசர அணுகலை இப்போதே முடிக்கும்.', end: 'இப்போதே முடி',
    asked: 'கேட்கப்பட்டது. உரிமையாளர் அனுமதிகள் பக்கத்தில் முடிவு செய்வார்; இன்னும் எதுவும் மாறவில்லை.', given: 'கொடுக்கப்பட்டது. இது தானாக முடியும் நேரம்', endedNow: 'முடிக்கப்பட்டது. இது பதிவில் இருக்கும்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு அவசர அணுகலைப் பார்க்க முடியாது.', cannotAsk: 'உங்கள் பங்கு அவசர அணுகல் கேட்க முடியாது.', cannotEnd: 'உரிமையாளர் மட்டுமே அவசர அணுகலை முன்கூட்டியே முடிக்க முடியும்.',
    needPerson: 'தேவைப்படும் நபரின் பணியாளர் அடையாளத்தைத் தட்டச்சு செய்யுங்கள்.', needRole: 'கொடுக்க வேண்டிய பங்கைத் தட்டச்சு செய்யுங்கள்.', needStores: 'கடைகளைக் குறிப்பிடுங்கள், அல்லது "all" எனத் தட்டச்சு செய்யுங்கள்.', needMinutes: 'நிமிடங்களை 0-க்கு மேற்பட்ட முழு எண்ணாகத் தட்டச்சு செய்யுங்கள்.', needReason: 'ஏன் என்று தெளிவாகச் சொல்லுங்கள்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை, மாற்றப்படவில்லை.', reading: 'தலைமை அலுவலகத்திடம் கேட்கிறது…',
  },
} as const;

export const emergencyWords = (lang: Lang, key: string): string =>
  (EMERGENCY_COPY[lang] as Record<string, string>)[key] ?? (EMERGENCY_COPY.en as Record<string, string>)[key] ?? key;
export const emergencyOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => emergencyWords(lang, k), out);

/** What is asked — exactly the body head office's grant route reads (the grant id is the path). */
export interface EmergencyAskBody { readonly userId: string; readonly roleId: string; readonly branchScope: 'all' | readonly string[]; readonly reason: string; readonly minutes: number }
export interface EmergencyAsk { readonly requestId: string; readonly grantId: string; readonly status: 'waiting' | 'approved' | 'rejected' | 'expired' | 'used'; readonly body: EmergencyAskBody; readonly decidedBy?: string }
export interface EmergencyGrantRow { readonly grantId: string; readonly userId: string; readonly approvedBy: string; readonly reason: string; readonly grantedAt: string; readonly expiresAt: string; readonly minutes: number; readonly endedEarly: boolean; readonly active: boolean }

type Why = 'nobody' | 'cannotRead' | 'cannotAsk' | 'cannotEnd' | 'needPerson' | 'needRole' | 'needStores' | 'needMinutes' | 'needReason';
type Done<T> = Promise<Outcome<T, Why>>;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const STATUSES = ['waiting', 'approved', 'rejected', 'expired', 'used'] as const;

/** "all", or the store ids typed (separated by commas or spaces); undefined when nothing usable was typed. */
export function storesFrom(raw: string): 'all' | readonly string[] | undefined {
  const s = raw.trim();
  if (s.toLowerCase() === 'all') return 'all';
  const ids = [...new Set(s.split(/[\s,]+/).map((x) => x.trim()).filter((x) => x !== ''))];
  return ids.length === 0 ? undefined : ids;
}

/** The ask's body from the approved request's details (the grant id is the path, never part of the body). */
function askBodyOf(details: unknown): EmergencyAskBody | undefined {
  if (!isObj(details)) return undefined;
  const scope = details['branchScope'];
  const branchScope = scope === 'all' ? 'all' : Array.isArray(scope) && scope.every((x) => typeof x === 'string') ? scope as string[] : undefined;
  if (branchScope === undefined || typeof details['minutes'] !== 'number') return undefined;
  return { userId: str(details['userId']), roleId: str(details['roleId']), branchScope, reason: str(details['reason']), minutes: details['minutes'] };
}

export interface EmergencyAccessSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly ask: boolean; readonly end: boolean };
  review(): Done<{ readonly grants: readonly EmergencyGrantRow[]; readonly active: number }>;
  myAsks(): Done<readonly EmergencyAsk[]>;
  ask(input: { readonly userId: string; readonly roleId: string; readonly stores: string; readonly minutes: string; readonly reason: string }): Done<{ readonly requestId: string; readonly grantId: string }>;
  give(ask: EmergencyAsk): Done<{ readonly expiresAt: string }>;
  end(grantId: string): Done<{ readonly revokedAt: string }>;
}

export function createEmergencyAccessSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch; readonly newGrantId?: () => string }): EmergencyAccessSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('identity.role.read'), ask: named && held.has('identity.role.request'), end: named && held.has('identity.role.grant') };
  const call = makeCaller({ keyPrefix: 'emergency', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  const newGrantId = input.newGrantId ?? (() => newId('eg'));
  const no = (why: Why): { result: 'invalid'; why: Why } => ({ result: 'invalid', why });
  const gate = (need: 'read' | 'ask' | 'end') => (!named ? no('nobody') : !may[need] ? no(need === 'read' ? 'cannotRead' : need === 'ask' ? 'cannotAsk' : 'cannotEnd') : undefined);
  return {
    may,
    review: async () => {
      const g = gate('read'); if (g) return g;
      const out = await call<{ review?: unknown[]; active?: unknown }>('GET', '/v1/access/emergency');
      if (out.result !== 'ok') return out;
      const grants = (out.value.review ?? []).flatMap((r): EmergencyGrantRow[] => (isObj(r) && typeof r['grantId'] === 'string'
        ? [{ grantId: r['grantId'], userId: str(r['userId']), approvedBy: str(r['approvedBy']), reason: str(r['reason']), grantedAt: str(r['grantedAt']), expiresAt: str(r['expiresAt']), minutes: typeof r['minutes'] === 'number' ? r['minutes'] : 0, endedEarly: r['endedEarly'] === true, active: r['active'] === true }] : []));
      return { result: 'ok', value: { grants, active: grants.filter((x) => x.active).length } };
    },
    myAsks: async () => {
      const g = gate('ask'); if (g) return g;
      const out = await call<{ mine?: unknown[] }>('GET', '/v1/approvals/requests');
      if (out.result !== 'ok') return out;
      const asks = (out.value.mine ?? []).flatMap((r): EmergencyAsk[] => {
        if (!isObj(r) || r['kind'] !== 'emergency_access' || typeof r['requestId'] !== 'string') return [];
        const body = askBodyOf(r['details']);
        const status = STATUSES.find((s) => s === r['status']);
        if (body === undefined || status === undefined) return [];
        return [{ requestId: r['requestId'], grantId: str(r['subjectRef']), status, body, ...(typeof r['decidedBy'] === 'string' ? { decidedBy: r['decidedBy'] } : {}) }];
      });
      return { result: 'ok', value: asks.reverse() };
    },
    ask: async (a) => {
      const g = gate('ask'); if (g) return g;
      if (a.userId.trim() === '') return no('needPerson');
      if (a.roleId.trim() === '') return no('needRole');
      const branchScope = storesFrom(a.stores);
      if (branchScope === undefined) return no('needStores');
      if (!/^\d{1,4}$/.test(a.minutes.trim()) || Number(a.minutes.trim()) <= 0) return no('needMinutes');
      if (a.reason.trim() === '') return no('needReason');
      const grantId = newGrantId();
      const body: EmergencyAskBody = { userId: a.userId.trim(), roleId: a.roleId.trim(), branchScope, reason: a.reason.trim(), minutes: Number(a.minutes.trim()) };
      const out = await call<{ requestId?: unknown }>('POST', '/v1/approvals/requests', {
        kind: 'emergency_access', subjectRef: grantId, details: { ...body, grantId }, valueMinor: null,
        summary: `Emergency access: ${body.userId} as ${body.roleId} for ${body.minutes} minutes`, reason: body.reason,
      });
      if (out.result !== 'ok') return out;
      return typeof out.value.requestId === 'string' ? { result: 'ok', value: { requestId: out.value.requestId, grantId } } : { result: 'lost_link' };
    },
    give: async (ask) => {
      const g = gate('ask'); if (g) return g;
      const out = await call<{ expiresAt?: unknown }>('POST', `/v1/access/emergency/${encodeURIComponent(ask.grantId)}`, { ...ask.body, approvalId: ask.requestId });
      if (out.result !== 'ok') return out;
      return { result: 'ok', value: { expiresAt: str(out.value.expiresAt) } };
    },
    end: async (grantId) => {
      const g = gate('end'); if (g) return g;
      const out = await call<{ revokedAt?: unknown }>('POST', `/v1/access/emergency/${encodeURIComponent(grantId)}/revoke`, {});
      if (out.result !== 'ok') return out;
      return { result: 'ok', value: { revokedAt: str(out.value.revokedAt) } };
    },
  };
}
