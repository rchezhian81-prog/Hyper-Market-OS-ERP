// D-21 (R4, OB-217) — the "seen together" panel on the Investigations page: a tested, DOM-free session over head office's
// own routes. For a product or a cashier and a period it shows the till exceptions, the waste and shrink and the count
// differences side by side (GET /v1/loss-prevention/correlation) and the case head office PROPOSES. Nothing is opened on
// read: a person opens a case from the proposal, naming the investigator (POST /v1/loss-prevention/cases/:caseId). A CCTV
// clip is recorded only as a reference — camera, time from and to, who collected it (POST …/cases/:caseId/cctv/:id); the
// page has no place for video. Every rule is head office's; this session refuses only the cheap things before a request.

import type { ViewerIdentity } from './browser-entry';

export type Lang = 'en' | 'ta';
export type Outcome<T> =
  | { readonly result: 'ok'; readonly value: T }
  | { readonly result: 'refused'; readonly status: number; readonly code: string; readonly whatHappened: string }
  | { readonly result: 'invalid'; readonly why: CorrelationCopyKey }
  | { readonly result: 'lost_link' };

export interface CorrelationViewData {
  readonly subject: { readonly kind: 'product' | 'cashier'; readonly productId?: string; readonly cashierId?: string };
  readonly from: string; readonly to: string;
  readonly tillExceptions: readonly { readonly ref: string; readonly kind: 'void' | 'no_sale' | 'price_override' | 'refund'; readonly cashierId: string; readonly productIds: readonly string[]; readonly valueMinor: number; readonly day: string }[];
  readonly shrink: readonly { readonly ref: string; readonly productId: string; readonly lossType: string; readonly reasonCode: string; readonly quantityMinor: number; readonly valueMinor: number; readonly day: string }[];
  readonly countDifferences: readonly { readonly ref: string; readonly productId: string; readonly varianceMinor: number; readonly valueMinor: number; readonly day: string }[];
  readonly productsJoined: readonly string[];
  readonly proposal: { readonly propose: boolean; readonly because: string; readonly raisedFromRef: string; readonly subjectRef: string; readonly summary: string; readonly valueMinor: number };
  readonly opened: false;
}

export const CORRELATION_COPY = {
  en: {
    heading: 'Seen together', lead: 'For one product or one cashier and a period: the till exceptions, the waste and shrink, and the count differences, side by side. It proposes a case — a person decides whether to open one.',
    product: 'Product', cashier: 'Cashier', subjectKind: 'Look at', subjectId: 'Product code or cashier', from: 'From', to: 'To', show: 'Show together',
    tillH: 'Till exceptions', shrinkH: 'Waste and shrink', countsH: 'Count differences', none: 'None in this period.',
    void: 'Void', no_sale: 'Drawer opened, no sale', price_override: 'Price override', refund: 'Refund',
    proposed: 'A case is proposed:', notProposed: 'No case proposed:', investigator: 'Investigator', caseId: 'Case number', open: 'Open this case',
    opened: 'Case opened. It is in the list above.', cctvH: 'CCTV clip (a reference only — no video is kept here)', camera: 'Camera', clipFrom: 'Clip from', clipTo: 'Clip to', collectedBy: 'Collected by',
    addCctv: 'Record the CCTV reference', cctvAdded: 'CCTV reference recorded on the case. No video is kept.', joined: 'Products joined:',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot read this view.', cannotManage: 'Only someone who manages investigations can open a case or add a CCTV reference.',
    needAll: 'Fill in every field first. Nothing was sent.', backwards: 'The period runs backwards. Nothing was sent.', refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was changed.',
  },
  ta: {
    heading: 'ஒன்றாகக் காணப்பட்டவை', lead: 'ஒரு பொருள் அல்லது ஒரு காசாளர் மற்றும் ஒரு காலத்திற்கு: பில் இயந்திர விதிவிலக்குகள், வீண் மற்றும் இழப்பு, எண்ணிக்கை வேறுபாடுகள், பக்கம் பக்கமாக. இது ஒரு வழக்கைப் பரிந்துரைக்கிறது — திறப்பதா என்பதை ஒருவர் முடிவு செய்கிறார்.',
    product: 'பொருள்', cashier: 'காசாளர்', subjectKind: 'பார்க்க', subjectId: 'பொருள் குறியீடு அல்லது காசாளர்', from: 'முதல்', to: 'வரை', show: 'ஒன்றாகக் காட்டு',
    tillH: 'பில் இயந்திர விதிவிலக்குகள்', shrinkH: 'வீண் மற்றும் இழப்பு', countsH: 'எண்ணிக்கை வேறுபாடுகள்', none: 'இந்தக் காலத்தில் எதுவும் இல்லை.',
    void: 'ரத்து', no_sale: 'விற்பனையின்றி பணப்பெட்டி திறப்பு', price_override: 'விலை மாற்றம்', refund: 'பணத் திருப்பம்',
    proposed: 'ஒரு வழக்கு பரிந்துரைக்கப்படுகிறது:', notProposed: 'வழக்கு பரிந்துரைக்கப்படவில்லை:', investigator: 'விசாரணையாளர்', caseId: 'வழக்கு எண்', open: 'இந்த வழக்கைத் திற',
    opened: 'வழக்கு திறக்கப்பட்டது. மேலே உள்ள பட்டியலில் உள்ளது.', cctvH: 'CCTV பதிவு (குறிப்பு மட்டும் — இங்கே வீடியோ வைக்கப்படுவதில்லை)', camera: 'கேமரா', clipFrom: 'பதிவு தொடக்கம்', clipTo: 'பதிவு முடிவு', collectedBy: 'சேகரித்தவர்',
    addCctv: 'CCTV குறிப்பைப் பதிவு செய்', cctvAdded: 'CCTV குறிப்பு வழக்கில் பதிவானது. வீடியோ வைக்கப்படவில்லை.', joined: 'இணைக்கப்பட்ட பொருட்கள்:',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு இதைப் படிக்க முடியாது.', cannotManage: 'விசாரணைகளை நிர்வகிப்பவர் மட்டுமே வழக்கைத் திறக்கவோ CCTV குறிப்பைச் சேர்க்கவோ முடியும்.',
    needAll: 'முதலில் எல்லாப் புலங்களையும் நிரப்பவும். எதுவும் அனுப்பப்படவில்லை.', backwards: 'காலம் பின்னோக்கி உள்ளது. எதுவும் அனுப்பப்படவில்லை.', refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் மாற்றப்படவில்லை.',
  },
} as const;
export type CorrelationCopyKey = keyof typeof CORRELATION_COPY.en;

export const correlationWords = (lang: Lang, key: CorrelationCopyKey | string): string =>
  (CORRELATION_COPY[lang] as Record<string, string>)[key] ?? (CORRELATION_COPY.en as Record<string, string>)[key] ?? key;
export function correlationOutcomeWords(lang: Lang, out: Outcome<unknown>): string {
  if (out.result === 'refused') return `${correlationWords(lang, 'refused')} ${out.whatHappened}`;
  if (out.result === 'invalid') return correlationWords(lang, out.why);
  if (out.result === 'lost_link') return correlationWords(lang, 'unreachable');
  return '';
}
export const correlationRupees = (minor: number): string => `₹${(minor / 100).toFixed(2)}`;

export interface CorrelationSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly manage: boolean };
  view(kind: 'product' | 'cashier', id: string, from: string, to: string): Promise<Outcome<CorrelationViewData>>;
  /** A PERSON opens a case from the proposal, naming the investigator — the one way a case comes from this view. */
  open(caseId: string, proposal: CorrelationViewData['proposal'], assignedTo: string): Promise<Outcome<{ readonly caseId: string; readonly state: string }>>;
  /** A CCTV clip as a reference only: camera, time from and to, who collected it. There is no field for video. */
  cctv(caseId: string, ref: { readonly cameraId: string; readonly from: string; readonly to: string; readonly collectedBy: string }): Promise<Outcome<{ readonly ref: string; readonly videoStored: false }>>;
}

export function createCorrelationSession(input: { readonly viewer: ViewerIdentity | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string; readonly newId?: () => string }): CorrelationSession {
  const perms = new Set(input.viewer?.permissions ?? []);
  const named = input.viewer?.userId !== undefined;
  const may = { named, read: named && perms.has('lp.case.read'), manage: named && perms.has('lp.case.manage') };
  const rand = (): string => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
  const newKey = input.newKey ?? (() => `lp-${rand()}`);
  const newId = input.newId ?? (() => `cctv-${rand().slice(0, 12)}`);
  const http = input.fetch ?? ((...a: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...a));
  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Outcome<T>> {
    try {
      const res = await http(path, { method, credentials: 'same-origin', headers: { accept: 'application/json', ...(method === 'POST' ? { 'content-type': 'application/json', 'idempotency-key': newKey() } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}) });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) { const err = (json['error'] ?? {}) as { code?: string; whatHappened?: string }; return { result: 'refused', status: res.status, code: err.code ?? String(res.status), whatHappened: err.whatHappened ?? `status ${res.status}` }; }
      return { result: 'ok', value: json as T };
    } catch { return { result: 'lost_link' }; }
  }
  const enc = encodeURIComponent;
  const blank = (...xs: string[]): boolean => xs.some((x) => x.trim() === '');
  return {
    may,
    view: async (kind, id, from, to) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      if (!may.read) return { result: 'invalid', why: 'cannotRead' };
      if (blank(id, from, to)) return { result: 'invalid', why: 'needAll' };
      if (from > to) return { result: 'invalid', why: 'backwards' };
      return call('GET', `/v1/loss-prevention/correlation?${kind === 'product' ? 'productId' : 'cashierId'}=${enc(id.trim())}&from=${enc(from)}&to=${enc(to)}`);
    },
    open: async (caseId, p, assignedTo) => {
      if (!may.manage) return { result: 'invalid', why: 'cannotManage' };
      if (blank(caseId, assignedTo)) return { result: 'invalid', why: 'needAll' };
      return call('POST', `/v1/loss-prevention/cases/${enc(caseId.trim())}`, { raisedFromRef: p.raisedFromRef, subjectRef: p.subjectRef, summary: p.summary, valueMinor: p.valueMinor, assignedTo: assignedTo.trim() });
    },
    cctv: async (caseId, ref) => {
      if (!may.manage) return { result: 'invalid', why: 'cannotManage' };
      if (blank(caseId, ref.cameraId, ref.from, ref.to, ref.collectedBy) || Number.isNaN(Date.parse(ref.from)) || Number.isNaN(Date.parse(ref.to))) return { result: 'invalid', why: 'needAll' };
      return call('POST', `/v1/loss-prevention/cases/${enc(caseId.trim())}/cctv/${enc(newId())}`, {
        cameraId: ref.cameraId.trim(), from: new Date(ref.from).toISOString(), to: new Date(ref.to).toISOString(), collectedBy: ref.collectedBy.trim(),
      });
    },
  };
}
