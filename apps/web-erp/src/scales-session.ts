// Scales — the weighing-scale register screen's tested, DOM-free session (OB-154 "A" · roadmap v2.1 B6 · B7 · L2 · P-03 ·
// P-07 · P-08).
//
// Head office keeps the store's weighing scales on the Legal Metrology register (`GET /v1/facilities/scales`): each scale's
// model-approval number, capacity, last stamping, the last day its stamp is valid, its verification certificate and the
// lanes it weighs for. The signed store pack carries the register to the store computer, and a lane whose scale stamp has
// lapsed sells nothing by weight (OB-151 "A"). This page lists the register (worst first: lapsed, then due soon, then
// current) and adds or updates a scale (`POST /v1/facilities/scales/:assetId`):
//
//   • every scale names its verification certificate; head office refuses a scale without one;
//   • EXTENDING a stamp (a later date) needs the new stamp's certificate AND a second person (L2 · ADR-0024): head office
//     refuses the change by name (`scale_stamp_change_needs_approval`); the page then ASKS for approval with exactly that
//     change (`POST /v1/approvals/requests`, kind `scale_stamp_change`); another person who manages facilities (the
//     owner for the manager, the manager for the owner) approves it on their own Approvals page; and the page then sends
//     the same change with that approval — once;
//   • cutting a stamp short (a scale found faulty) or moving it to other lanes goes straight through.
//
// What the person may do is only what their permissions offer (`facilities.asset.read` to read, `facilities.asset.manage`
// to add or update — the owner and the store manager today); head office re-checks every act and its refusal is shown in
// its own words. The session refuses only cheap things before a POST (a blank field, a date that is not a date) and never
// writes on open.

import type { ViewerIdentity } from './browser-entry';

export type Lang = 'en' | 'ta';

export const SCALES_PATH = '/v1/facilities/scales';
export const APPROVAL_KIND = 'scale_stamp_change';

/** One scale on the register as head office reads it, with whether its stamp is current today. */
export interface ScaleRow {
  readonly assetId: string;
  readonly storeId: string;
  readonly laneIds: readonly string[];
  readonly approvalNo: string;
  readonly capacityGrams: number;
  readonly lastStampedOn: string;
  readonly reverificationDueOn: string;
  readonly certificateRef?: string;
  readonly version: number;
  readonly setBy: string;
  readonly setAt: string;
  readonly approvedBy?: string;
  readonly verification: { readonly level: 'current' | 'due_soon' | 'expired'; readonly tradingBlocked: boolean; readonly daysRemaining: number };
}

/** What the person types to add or update one scale. Lanes are typed as a list separated by commas. */
export interface ScaleForm {
  readonly assetId: string;
  readonly storeId: string;
  readonly lanes: string;
  readonly approvalNo: string;
  readonly capacityGrams: string;
  readonly lastStampedOn: string;
  readonly reverificationDueOn: string;
  readonly certificateRef: string;
}

/** The body head office is sent for a scale — the SAME object the approval is asked for (the engine fingerprints it). */
export type ScaleBody = {
  readonly storeId: string; readonly laneIds: readonly string[]; readonly approvalNo: string; readonly capacityGrams: number;
  readonly lastStampedOn: string; readonly reverificationDueOn: string; readonly certificateRef: string;
};

/** One of this person's stamp-change requests on the approvals engine. */
export interface StampRequest {
  readonly requestId: string;
  readonly status: 'waiting' | 'approved' | 'rejected' | 'expired' | 'used';
  readonly subjectRef: string;
  readonly details: ScaleBody & { readonly assetId: string };
  readonly requestedAt: string;
  readonly decidedBy?: string;
  readonly decisionReason?: string;
}

export interface Register {
  readonly asOf: string;
  readonly scales: readonly ScaleRow[];
  readonly requests: readonly StampRequest[];
}

export type Outcome<T> =
  | { readonly result: 'ok'; readonly value: T }
  | { readonly result: 'refused'; readonly status: number; readonly code: string; readonly whatHappened: string }
  | { readonly result: 'invalid'; readonly why: CopyKey }
  | { readonly result: 'lost_link' };

export type CopyKey = keyof typeof SCALES_COPY.en;

export const SCALES_COPY = {
  en: {
    title: 'Weighing scales', lang: 'தமிழ்',
    lead: 'Every weighing scale on the Legal Metrology register: its stamp, its certificate and the tills it weighs for. A till whose scale stamp has run out sells nothing by weight.',
    sumScales: 'Scales on the register', sumLapsed: 'Stamp run out', sumSoon: 'Due soon', sumWaiting: 'Your changes waiting',
    tabRegister: 'Register', tabEdit: 'Add or update', tabRequests: 'Waiting for approval',
    registerLead: 'Worst first: a scale whose stamp has run out, then one due soon. Its tills sell by weight only while the stamp is current.',
    editLead: 'Add a scale, or update one. Every scale names its verification certificate. A later stamp date needs the new certificate and a second person\'s approval; an earlier date (a scale found faulty) or other tills goes straight through.',
    requestsLead: 'Your stamp-date changes waiting for a second person. Once one is approved, save it here.',
    colScale: 'Scale', colStore: 'Store', colLanes: 'Tills', colStamped: 'Last stamped', colValid: 'Stamp valid to', colCertificate: 'Certificate', colState: 'Stamp', colBy: 'Set by',
    stCurrent: 'Current', stSoon: 'Due soon — book the re-verification', stExpired: 'Run out — its tills cannot sell by weight',
    noCertificate: 'not recorded', noScales: 'No weighing scale is on the register yet. Every till scale must be on it before the store opens (OB-151).',
    noRequests: 'No stamp-date change is waiting.',
    fAsset: 'Scale asset number', fStore: 'Store', fLanes: 'Tills it weighs for (separate with commas)', fApprovalNo: 'Model-approval number', fCapacity: 'Capacity in grams',
    fStamped: 'Last stamped on', fValid: 'Stamp valid to', fCertificate: 'Verification certificate number',
    save: 'Save the scale', saved: 'Saved — the next store setup carries it to the store computer.', ask: 'Ask a second person to approve this change',
    asked: 'Asked — another person who manages scales approves it on their Approvals page. Then save it from "Waiting for approval".',
    needsApproval: 'A later stamp date needs a second person. Ask for approval with exactly this change.',
    reqWaiting: 'Waiting for a second person', reqApproved: 'Approved by {by} — ready to save', reqRejected: 'Rejected by {by}: {why}', reqExpired: 'Approval expired — ask again', reqUsed: 'Saved',
    saveApproved: 'Save with this approval', reqLine: '{asset}: stamp valid to {valid}, certificate {certificate}',
    needAll: 'Fill in every field first. Nothing was sent.', notDate: 'Write the dates as YYYY-MM-DD. Nothing was sent.', notGrams: 'Write the capacity as a whole number of grams. Nothing was sent.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was changed.',
    cannotRead: 'Your role cannot read the scale register.', readOnly: 'You can read the register. Adding or updating a scale is for the owner and the store manager.',
    nobody: 'Nobody is signed in on this screen — you can read nothing and change nothing.', asOf: 'As of {day}',
  },
  ta: {
    title: 'எடைத் தராசுகள்', lang: 'English',
    lead: 'சட்ட அளவியல் பதிவேட்டில் உள்ள ஒவ்வொரு எடைத் தராசும்: அதன் முத்திரை, சான்றிதழ், அது எடை போடும் கவுண்டர்கள். தராசு முத்திரை காலாவதியான கவுண்டர் எதையும் எடைக்கு விற்காது.',
    sumScales: 'பதிவேட்டில் உள்ள தராசுகள்', sumLapsed: 'முத்திரை காலாவதி', sumSoon: 'விரைவில் தேவை', sumWaiting: 'காத்திருக்கும் உங்கள் மாற்றங்கள்',
    tabRegister: 'பதிவேடு', tabEdit: 'சேர் அல்லது புதுப்பி', tabRequests: 'அனுமதிக்காகக் காத்திருப்பவை',
    registerLead: 'மோசமானது முதலில்: முத்திரை காலாவதியான தராசு, பிறகு விரைவில் தேவைப்படுவது. முத்திரை செல்லுபடியாகும் வரை மட்டுமே அதன் கவுண்டர்கள் எடைக்கு விற்கும்.',
    editLead: 'ஒரு தராசைச் சேர்க்கவும் அல்லது புதுப்பிக்கவும். ஒவ்வொரு தராசும் அதன் சரிபார்ப்புச் சான்றிதழைக் குறிப்பிடும். பிந்தைய முத்திரைத் தேதிக்குப் புதிய சான்றிதழும் இரண்டாம் நபரின் அனுமதியும் தேவை; முந்தைய தேதி (பழுதான தராசு) அல்லது வேறு கவுண்டர்கள் நேரடியாகச் செல்லும்.',
    requestsLead: 'இரண்டாம் நபருக்காகக் காத்திருக்கும் உங்கள் முத்திரைத் தேதி மாற்றங்கள். அனுமதிக்கப்பட்டதும் இங்கே சேமியுங்கள்.',
    colScale: 'தராசு', colStore: 'கடை', colLanes: 'கவுண்டர்கள்', colStamped: 'கடைசி முத்திரை', colValid: 'முத்திரை செல்லுபடி வரை', colCertificate: 'சான்றிதழ்', colState: 'முத்திரை', colBy: 'அமைத்தவர்',
    stCurrent: 'செல்லுபடியானது', stSoon: 'விரைவில் தேவை — மறுசரிபார்ப்பை முன்பதிவு செய்யுங்கள்', stExpired: 'காலாவதி — அதன் கவுண்டர்கள் எடைக்கு விற்க முடியாது',
    noCertificate: 'பதிவு செய்யப்படவில்லை', noScales: 'பதிவேட்டில் இன்னும் எந்த எடைத் தராசும் இல்லை. கடை திறக்கும் முன் ஒவ்வொரு கவுண்டர் தராசும் அதில் இருக்க வேண்டும் (OB-151).',
    noRequests: 'எந்த முத்திரைத் தேதி மாற்றமும் காத்திருக்கவில்லை.',
    fAsset: 'தராசு சொத்து எண்', fStore: 'கடை', fLanes: 'அது எடை போடும் கவுண்டர்கள் (காற்புள்ளியால் பிரிக்கவும்)', fApprovalNo: 'மாதிரி அனுமதி எண்', fCapacity: 'கிராமில் கொள்ளளவு',
    fStamped: 'கடைசியாக முத்திரையிட்டது', fValid: 'முத்திரை செல்லுபடி வரை', fCertificate: 'சரிபார்ப்புச் சான்றிதழ் எண்',
    save: 'தராசைச் சேமி', saved: 'சேமிக்கப்பட்டது — அடுத்த கடை அமைப்பு இதைக் கடை கணினிக்குக் கொண்டு செல்லும்.', ask: 'இந்த மாற்றத்தை அனுமதிக்க இரண்டாம் நபரைக் கேள்',
    asked: 'கேட்கப்பட்டது — தராசுகளை நிர்வகிக்கும் இன்னொருவர் தம் அனுமதிகள் பக்கத்தில் அனுமதிப்பார். பிறகு "அனுமதிக்காகக் காத்திருப்பவை" இல் சேமியுங்கள்.',
    needsApproval: 'பிந்தைய முத்திரைத் தேதிக்கு இரண்டாம் நபர் தேவை. இதே மாற்றத்துடன் அனுமதி கேளுங்கள்.',
    reqWaiting: 'இரண்டாம் நபருக்காகக் காத்திருக்கிறது', reqApproved: '{by} அனுமதித்தார் — சேமிக்கத் தயார்', reqRejected: '{by} மறுத்தார்: {why}', reqExpired: 'அனுமதி காலாவதியானது — மீண்டும் கேளுங்கள்', reqUsed: 'சேமிக்கப்பட்டது',
    saveApproved: 'இந்த அனுமதியுடன் சேமி', reqLine: '{asset}: முத்திரை {valid} வரை, சான்றிதழ் {certificate}',
    needAll: 'முதலில் எல்லாப் புலங்களையும் நிரப்புங்கள். எதுவும் அனுப்பப்படவில்லை.', notDate: 'தேதிகளை YYYY-MM-DD என எழுதுங்கள். எதுவும் அனுப்பப்படவில்லை.', notGrams: 'கொள்ளளவை முழு கிராம் எண்ணாக எழுதுங்கள். எதுவும் அனுப்பப்படவில்லை.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் மாற்றப்படவில்லை.',
    cannotRead: 'உங்கள் பங்கால் தராசுப் பதிவேட்டைப் படிக்க முடியாது.', readOnly: 'நீங்கள் பதிவேட்டைப் படிக்கலாம். தராசைச் சேர்ப்பதும் புதுப்பிப்பதும் உரிமையாளருக்கும் கடை மேலாளருக்கும் மட்டும்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்கவோ மாற்றவோ முடியாது.', asOf: '{day} நிலவரப்படி',
  },
} as const;

/** One word in the reader's language, with `{name}` slots filled. */
export function wordsFor(lang: Lang, key: CopyKey, slots: Readonly<Record<string, string | number>> = {}): string {
  let text: string = SCALES_COPY[lang][key] ?? SCALES_COPY.en[key];
  for (const [k, v] of Object.entries(slots)) text = text.split(`{${k}}`).join(String(v));
  return text;
}

/** How a refusal, a bad form or a lost link reads to a person (a success reads its own word). */
export function outcomeWords(lang: Lang, out: Outcome<unknown>): string {
  if (out.result === 'refused') return out.code === 'scale_stamp_change_needs_approval' ? wordsFor(lang, 'needsApproval') : `${wordsFor(lang, 'refused')} ${out.whatHappened}`;
  if (out.result === 'invalid') return wordsFor(lang, out.why);
  if (out.result === 'lost_link') return wordsFor(lang, 'unreachable');
  return '';
}

/** A scale's stamp in words — never colour alone (P-07). */
export const stampWords = (lang: Lang, s: ScaleRow): string =>
  wordsFor(lang, s.verification.level === 'expired' ? 'stExpired' : s.verification.level === 'due_soon' ? 'stSoon' : 'stCurrent');

/** How a request stands, in the reader's words. */
export function requestWords(lang: Lang, r: StampRequest): string {
  switch (r.status) {
    case 'waiting': return wordsFor(lang, 'reqWaiting');
    case 'approved': return wordsFor(lang, 'reqApproved', { by: r.decidedBy ?? '' });
    case 'rejected': return wordsFor(lang, 'reqRejected', { by: r.decidedBy ?? '', why: r.decisionReason ?? '' });
    case 'expired': return wordsFor(lang, 'reqExpired');
    default: return wordsFor(lang, 'reqUsed');
  }
}

/** The register worst first: run out, then due soon, then current; then by the day the stamp runs out, then by scale. */
export function orderedScales(scales: readonly ScaleRow[]): ScaleRow[] {
  const rank = { expired: 0, due_soon: 1, current: 2 } as const;
  return [...scales].sort((a, b) => rank[a.verification.level] - rank[b.verification.level]
    || a.reverificationDueOn.localeCompare(b.reverificationDueOn) || a.assetId.localeCompare(b.assetId));
}

/** The figures at the top of the page. */
export function summarise(reg: Register | null): { readonly scales: number | null; readonly lapsed: number | null; readonly soon: number | null; readonly waiting: number | null } {
  if (reg === null) return { scales: null, lapsed: null, soon: null, waiting: null };
  return {
    scales: reg.scales.length,
    lapsed: reg.scales.filter((s) => s.verification.level === 'expired').length,
    soon: reg.scales.filter((s) => s.verification.level === 'due_soon').length,
    waiting: reg.requests.filter((r) => r.status === 'waiting' || r.status === 'approved').length,
  };
}

/** A register row back into the form, so updating a scale starts from what is on record. */
export const formOf = (s: ScaleRow): ScaleForm => ({
  assetId: s.assetId, storeId: s.storeId, lanes: s.laneIds.join(', '), approvalNo: s.approvalNo, capacityGrams: String(s.capacityGrams),
  lastStampedOn: s.lastStampedOn, reverificationDueOn: s.reverificationDueOn, certificateRef: s.certificateRef ?? '',
});

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Read the form into the body head office is sent, or the reason it cannot be sent. Pure. */
export function bodyOf(form: ScaleForm): { readonly ok: true; readonly assetId: string; readonly body: ScaleBody } | { readonly ok: false; readonly why: CopyKey } {
  const f = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : ''])) as unknown as ScaleForm;
  if (f.assetId === '' || f.storeId === '' || f.approvalNo === '' || f.capacityGrams === '' || f.lastStampedOn === '' || f.reverificationDueOn === '' || f.certificateRef === '') return { ok: false, why: 'needAll' };
  if (!DAY.test(f.lastStampedOn) || !DAY.test(f.reverificationDueOn)) return { ok: false, why: 'notDate' };
  if (!/^\d+$/.test(f.capacityGrams) || Number(f.capacityGrams) <= 0 || !Number.isSafeInteger(Number(f.capacityGrams))) return { ok: false, why: 'notGrams' };
  const laneIds = [...new Set(f.lanes.split(',').map((l) => l.trim()).filter((l) => l !== ''))];
  return {
    ok: true, assetId: f.assetId,
    body: { storeId: f.storeId, laneIds, approvalNo: f.approvalNo, capacityGrams: Number(f.capacityGrams), lastStampedOn: f.lastStampedOn, reverificationDueOn: f.reverificationDueOn, certificateRef: f.certificateRef },
  };
}

export interface ScalesSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly manage: boolean };
  /** The register and this person's waiting stamp changes (nothing is written). */
  load(): Promise<Outcome<Register>>;
  /** Add or update a scale. A later stamp date is refused by head office until approved — said in words. */
  save(form: ScaleForm): Promise<Outcome<{ readonly scale: ScaleRow }>>;
  /** Ask a second person to approve exactly this change. */
  ask(form: ScaleForm): Promise<Outcome<{ readonly requestId: string }>>;
  /** Send an approved change, with its approval — the very body that was approved. */
  saveApproved(request: StampRequest): Promise<Outcome<{ readonly scale: ScaleRow }>>;
}

export function createScalesSession(input: {
  readonly viewer: ViewerIdentity | undefined;
  readonly fetch?: typeof globalThis.fetch;
  readonly newKey?: () => string;
}): ScalesSession {
  const perms = new Set(input.viewer?.permissions ?? []);
  const named = input.viewer?.userId !== undefined;
  const may = { named, read: named && perms.has('facilities.asset.read'), manage: named && perms.has('facilities.asset.manage') };
  const rand = (): string => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
  const newKey = input.newKey ?? (() => `scl-${rand()}`);
  const http = input.fetch ?? ((...a: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...a));

  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown, key?: string): Promise<Outcome<T>> {
    try {
      const res = await http(path, {
        method, credentials: 'same-origin',
        headers: { accept: 'application/json', ...(method === 'POST' ? { 'content-type': 'application/json', 'idempotency-key': key ?? newKey() } : {}) },
        ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const err = (json['error'] ?? {}) as { code?: string; whatHappened?: string };
        return { result: 'refused', status: res.status, code: err.code ?? String(res.status), whatHappened: err.whatHappened ?? `status ${res.status}` };
      }
      return { result: 'ok', value: json as T };
    } catch {
      return { result: 'lost_link' };
    }
  }
  const nobody = { result: 'invalid', why: 'nobody' } as const;
  const cannotRead = { result: 'invalid', why: 'cannotRead' } as const;
  const readOnly = { result: 'invalid', why: 'readOnly' } as const;
  const scalePath = (assetId: string): string => `${SCALES_PATH}/${encodeURIComponent(assetId)}`;

  return {
    may,
    load: async () => {
      if (!named) return nobody;
      if (!may.read) return cannotRead;
      const reg = await call<{ asOf: string; scales: ScaleRow[] }>('GET', SCALES_PATH);
      if (reg.result !== 'ok') return reg;
      const inbox = may.manage ? await call<{ mine?: (StampRequest & { kind: string })[] }>('GET', '/v1/approvals/requests') : undefined;
      const requests: StampRequest[] = inbox === undefined || inbox.result !== 'ok' ? [] : (inbox.value.mine ?? []).filter((r) => r.kind === APPROVAL_KIND)
        .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
      return { result: 'ok', value: { asOf: reg.value.asOf, scales: orderedScales(reg.value.scales ?? []), requests } };
    },
    save: async (form) => {
      if (!named) return nobody;
      if (!may.manage) return readOnly;
      const read = bodyOf(form);
      if (!read.ok) return { result: 'invalid', why: read.why };
      return call('POST', scalePath(read.assetId), read.body);
    },
    ask: async (form) => {
      if (!named) return nobody;
      if (!may.manage) return readOnly;
      const read = bodyOf(form);
      if (!read.ok) return { result: 'invalid', why: read.why };
      // The details are EXACTLY what the change will send, and its address's id — the engine fingerprints them.
      return call('POST', '/v1/approvals/requests', {
        kind: APPROVAL_KIND, subjectRef: read.assetId, valueMinor: null, details: { ...read.body, assetId: read.assetId },
        summary: `${read.assetId}: stamp valid to ${read.body.reverificationDueOn} (certificate ${read.body.certificateRef})`,
        reason: `Re-verified: certificate ${read.body.certificateRef}, last stamped ${read.body.lastStampedOn}`,
      });
    },
    saveApproved: async (request) => {
      if (!named) return nobody;
      if (!may.manage) return readOnly;
      const { assetId, ...body } = request.details;
      // Keyed on the approval, so a retried click is the same act.
      return call('POST', scalePath(assetId), { ...body, approvalId: request.requestId }, `scl-approved-${request.requestId}`);
    },
  };
}
