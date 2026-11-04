// W5 (R2 addendum C20 · POSH Act · OB-157 "committee only") — the Internal Committee's CONFIDENTIAL complaints register, on
// the committee's own page (/posh-committee). A tested, DOM-free session over head office's register routes, which no
// screen reached before:
//   • the register — `GET /v1/hr/posh/complaints` (every complaint, where it stands) and one complaint with its steps
//     (`GET …/complaints/:complaintId`);
//   • receive a complaint — `POST /v1/hr/posh/complaints` { receivedOn, complainantRef, respondentRef, summary }; the id is
//     made by head office (never typed here, so no id can carry a name);
//   • an inquiry step — `POST …/complaints/:complaintId/steps` { kind: inquiry_started | disposed, on, outcome?, note? };
//   • the access log — `GET /v1/hr/posh/access-log`: who read or wrote the register, and when.
// ONLY the committee holds `posh.complaint.read` / `posh.complaint.record` — not the owner, not a store manager, not the
// platform administrator (OB-157). This session refuses to send anything for anyone else, and head office refuses them
// again and seals every read and write into the committee's access log. Records are append-only: nothing here edits or
// removes a complaint or a step. Nothing is cached or stored in the browser. Head office's own sentences stay in English
// (OB-553); every word this page adds has a Tamil twin.

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const POSH_REGISTER_COPY = {
  en: {
    registerH: 'Complaints register (committee only)',
    registerLead: 'Confidential. Only the Internal Committee sees this register. Every look and every entry is recorded in the access log below.',
    showRegister: 'Show the register', count: 'complaints', open: 'still open', none: 'No complaint is in the register.',
    received: 'Received', under_inquiry: 'Under inquiry', disposed: 'Disposed of',
    receivedOn: 'Received on', complainant: 'Complainant (reference)', respondent: 'About (reference)', summary: 'What the complaint says',
    outcome: 'Outcome', disposedOn: 'Disposed of on', steps: 'Steps', recordedBy: 'recorded by',
    upheld: 'upheld', not_upheld: 'not upheld', conciliation: 'settled by conciliation', withdrawn: 'withdrawn',
    inquiry_started: 'Inquiry started', stepDisposed: 'Disposed of',
    receiveH: 'Receive a complaint', receive: 'Record the complaint', receivedOk: 'Recorded in the register.',
    stepH: 'Record the next step', stepKind: 'Step', stepOn: 'Date of the step', note: 'Committee note (optional)', saveStep: 'Record the step', stepOk: 'Step recorded.',
    logH: 'Access log', showLog: 'Show the access log', logNone: 'Nobody has read or written the register yet.', who: 'who', what: 'what', when: 'when',
    needComplaint: 'Fill in the date received (YYYY-MM-DD), both references and what the complaint says.',
    needStep: 'Choose the step and give its date (YYYY-MM-DD); disposing of a complaint needs an outcome.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Only the Internal Committee may see the complaints register.',
    cannotRecord: 'Only the Internal Committee may record in the register.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or recorded.', reading: 'Reading from head office…',
  },
  ta: {
    registerH: 'புகார்ப் பதிவேடு (குழு மட்டும்)',
    registerLead: 'இரகசியமானது. உள் குழு மட்டுமே இந்தப் பதிவேட்டைப் பார்க்கும். ஒவ்வொரு பார்வையும் ஒவ்வொரு பதிவும் கீழே உள்ள அணுகல் பதிவில் பதிவாகும்.',
    showRegister: 'பதிவேட்டைக் காட்டு', count: 'புகார்கள்', open: 'இன்னும் நிலுவையில்', none: 'பதிவேட்டில் எந்தப் புகாரும் இல்லை.',
    received: 'பெறப்பட்டது', under_inquiry: 'விசாரணையில்', disposed: 'முடிக்கப்பட்டது',
    receivedOn: 'பெற்ற நாள்', complainant: 'புகார்தாரர் (குறிப்பு)', respondent: 'யாரைப் பற்றி (குறிப்பு)', summary: 'புகார் சொல்வது',
    outcome: 'முடிவு', disposedOn: 'முடிக்கப்பட்ட நாள்', steps: 'படிகள்', recordedBy: 'பதிவு செய்தவர்',
    upheld: 'உறுதிசெய்யப்பட்டது', not_upheld: 'உறுதிசெய்யப்படவில்லை', conciliation: 'சமரசத்தால் தீர்க்கப்பட்டது', withdrawn: 'திரும்பப் பெறப்பட்டது',
    inquiry_started: 'விசாரணை தொடங்கியது', stepDisposed: 'முடிக்கப்பட்டது',
    receiveH: 'புகாரைப் பெறு', receive: 'புகாரைப் பதிவு செய்', receivedOk: 'பதிவேட்டில் பதிவாகியது.',
    stepH: 'அடுத்த படியைப் பதிவு செய்', stepKind: 'படி', stepOn: 'படியின் நாள்', note: 'குழுக் குறிப்பு (விருப்பம்)', saveStep: 'படியைப் பதிவு செய்', stepOk: 'படி பதிவாகியது.',
    logH: 'அணுகல் பதிவு', showLog: 'அணுகல் பதிவைக் காட்டு', logNone: 'இதுவரை யாரும் பதிவேட்டைப் படிக்கவோ எழுதவோ இல்லை.', who: 'யார்', what: 'என்ன', when: 'எப்போது',
    needComplaint: 'பெற்ற நாள் (YYYY-MM-DD), இரண்டு குறிப்புகள், புகார் சொல்வது ஆகியவற்றை நிரப்புங்கள்.',
    needStep: 'படியைத் தேர்ந்தெடுத்து அதன் நாளைக் கொடுங்கள் (YYYY-MM-DD); புகாரை முடிக்க ஒரு முடிவு தேவை.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உள் குழு மட்டுமே புகார்ப் பதிவேட்டைப் பார்க்கலாம்.',
    cannotRecord: 'உள் குழு மட்டுமே பதிவேட்டில் பதிவு செய்யலாம்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை, பதிவாகவில்லை.', reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…',
  },
} as const;

export const poshRegisterWords = (lang: Lang, key: string): string =>
  (POSH_REGISTER_COPY[lang] as Record<string, string>)[key] ?? (POSH_REGISTER_COPY.en as Record<string, string>)[key] ?? key;
export const poshRegisterOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => poshRegisterWords(lang, k), out);

export const POSH_STEP_OUTCOMES = ['upheld', 'not_upheld', 'conciliation', 'withdrawn'] as const;
export type PoshStepOutcome = (typeof POSH_STEP_OUTCOMES)[number];

export interface ComplaintStep { readonly stepId: string; readonly kind: 'inquiry_started' | 'disposed'; readonly on: string; readonly outcome?: PoshStepOutcome; readonly note?: string; readonly recordedBy: string }
export interface ComplaintRow {
  readonly complaintId: string; readonly receivedOn: string; readonly complainantRef: string; readonly respondentRef: string; readonly summary: string;
  readonly status: 'received' | 'under_inquiry' | 'disposed'; readonly outcome?: PoshStepOutcome; readonly disposedOn?: string; readonly steps: readonly ComplaintStep[];
}
export interface RegisterView { readonly complaints: readonly ComplaintRow[]; readonly count: number; readonly open: number }
export interface AccessEntry { readonly actorId: string; readonly action: string; readonly objectId: string; readonly at: string }

type Why = 'nobody' | 'cannotRead' | 'cannotRecord' | 'needComplaint' | 'needStep';
type Done<T> = Promise<Outcome<T, Why>>;
const isDate = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

export interface PoshRegisterSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly record: boolean };
  register(): Done<RegisterView>;
  one(complaintId: string): Done<{ readonly complaint: ComplaintRow }>;
  receive(c: { readonly receivedOn: string; readonly complainantRef: string; readonly respondentRef: string; readonly summary: string }): Done<{ readonly complaintId: string; readonly status: string }>;
  step(complaintId: string, s: { readonly kind: string; readonly on: string; readonly outcome?: string; readonly note?: string }): Done<{ readonly complaintId: string; readonly stepId: string; readonly status: string }>;
  accessLog(): Done<{ readonly entries: readonly AccessEntry[]; readonly count: number }>;
}

export function createPoshRegisterSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch }): PoshRegisterSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('posh.complaint.read'), record: named && held.has('posh.complaint.record') };
  const call = makeCaller({ keyPrefix: 'posh-reg', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  const readGate = (): { result: 'invalid'; why: Why } | undefined => (!named ? { result: 'invalid', why: 'nobody' } : !may.read ? { result: 'invalid', why: 'cannotRead' } : undefined);
  const writeGate = (): { result: 'invalid'; why: Why } | undefined => (!named ? { result: 'invalid', why: 'nobody' } : !may.record ? { result: 'invalid', why: 'cannotRecord' } : undefined);
  return {
    may,
    register: async () => readGate() ?? call<RegisterView>('GET', '/v1/hr/posh/complaints'),
    one: async (complaintId) => readGate() ?? call('GET', `/v1/hr/posh/complaints/${encodeURIComponent(complaintId)}`),
    receive: async (c) => {
      const g = writeGate(); if (g) return g;
      const body = { receivedOn: c.receivedOn.trim(), complainantRef: c.complainantRef.trim(), respondentRef: c.respondentRef.trim(), summary: c.summary.trim() };
      if (!isDate(body.receivedOn) || body.complainantRef === '' || body.respondentRef === '' || body.summary === '') return { result: 'invalid', why: 'needComplaint' };
      return call('POST', '/v1/hr/posh/complaints', body);
    },
    step: async (complaintId, s) => {
      const g = writeGate(); if (g) return g;
      const kind = s.kind; const on = s.on.trim(); const outcome = s.outcome ?? '';
      if ((kind !== 'inquiry_started' && kind !== 'disposed') || !isDate(on) || (kind === 'disposed' && !(POSH_STEP_OUTCOMES as readonly string[]).includes(outcome))) return { result: 'invalid', why: 'needStep' };
      const note = (s.note ?? '').trim();
      return call('POST', `/v1/hr/posh/complaints/${encodeURIComponent(complaintId)}/steps`, { kind, on, ...(kind === 'disposed' ? { outcome } : {}), ...(note === '' ? {} : { note }) });
    },
    accessLog: async () => readGate() ?? call('GET', '/v1/hr/posh/access-log'),
  };
}
