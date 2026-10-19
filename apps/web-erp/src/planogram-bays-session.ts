// D-13 (R4, OB-219) — the Shelf compliance by bay page's tested, DOM-free session. A thin client over head office's routes:
// the planogram in force compared with the staff counts, scored per bay with every gap named
// (GET /v1/merchandising/planogram-compliance/bays), and a photo of a bay kept on the shop's own server
// (POST /v1/merchandising/shelf-photos/:photoId). Image recognition is a switched-off link: the page says so, no photo leaves
// the shop, and every score is "counted by staff". The session refuses only the cheap things before a request.

import type { ViewerIdentity } from './browser-entry';

export type Lang = 'en' | 'ta';
export type Outcome<T> =
  | { readonly result: 'ok'; readonly value: T }
  | { readonly result: 'refused'; readonly status: number; readonly code: string; readonly whatHappened: string }
  | { readonly result: 'invalid'; readonly why: BaysCopyKey }
  | { readonly result: 'lost_link' };

export interface BayView {
  readonly bayKey: string; readonly aisle: number; readonly rack: number; readonly bay: number;
  readonly planned: number; readonly observed: number; readonly compliant: number;
  readonly score: { readonly kind: 'scored'; readonly bp: number } | { readonly kind: 'not_scored'; readonly because: string };
  readonly gaps: readonly { readonly productId: string; readonly locationId: string; readonly gap: string; readonly words: string }[];
  readonly photos: readonly { readonly photoId: string; readonly takenAt: string; readonly takenBy: string }[];
  readonly measuredBy: string;
}
export interface BaysView {
  readonly storeId: string; readonly planogramId: string; readonly planogramVersion: number; readonly bays: readonly BayView[]; readonly measuredBy: string;
  readonly recognition: { readonly state: string; readonly detail: string; readonly photosSent: number; readonly changesTheScore: false };
}

/** What the phone may send — and how big (700 KB, the ledger's cap). Head office checks again. */
export const PHOTO_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp'] as const);
export const PHOTO_MAX_BYTES = 700 * 1024;

export const BAYS_COPY = {
  en: {
    lang: 'தமிழ்', title: 'Shelf compliance by bay',
    lead: 'Each bay\'s shelf compared with the approved planogram, from the staff counts, with every gap named. A photo can go with a shelf check; it is kept on the shop\'s own computer.',
    store: 'Store', show: 'Show the bays', score: 'Score', notScored: 'Not scored', counted: 'counted', planned: 'facings planned', noGaps: 'No gaps.',
    photos: 'Photos', measuredBy: 'Measured by: counted by staff', recognitionOff: 'Image recognition is switched off: no photo leaves the shop.',
    photoH: 'Add a photo to a shelf check', bay: 'Bay', photo: 'Photo', keep: 'Keep this photo', kept: 'Photo kept on the shop\'s own computer. It was not sent anywhere.',
    typeNotAllowed: 'image type not allowed — use a JPEG, PNG or WebP photo. Nothing was sent.', tooLarge: 'image too large — at most 700 KB. Nothing was sent.',
    nobody: 'Nobody is signed in on this screen — you can read nothing.', cannotRead: 'Your role cannot read shelf compliance.', cannotRecord: 'Your role cannot add shelf photos.',
    needAll: 'Fill in the store, the bay and the photo first. Nothing was sent.', refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was changed.',
  },
  ta: {
    lang: 'English', title: 'அலமாரி இணக்கம் — பகுதி வாரியாக',
    lead: 'ஒவ்வொரு பகுதியின் அலமாரியும் ஒப்புதல் பெற்ற திட்ட வரைபடத்துடன், பணியாளர் எண்ணிக்கையிலிருந்து ஒப்பிடப்படுகிறது; ஒவ்வொரு இடைவெளியும் பெயரிடப்படுகிறது. அலமாரிச் சரிபார்ப்புடன் ஒரு புகைப்படம் சேர்க்கலாம்; அது கடையின் சொந்தக் கணினியில் வைக்கப்படும்.',
    store: 'கடை', show: 'பகுதிகளைக் காட்டு', score: 'மதிப்பெண்', notScored: 'மதிப்பிடப்படவில்லை', counted: 'எண்ணப்பட்டது', planned: 'திட்டமிட்ட இடங்கள்', noGaps: 'இடைவெளி இல்லை.',
    photos: 'புகைப்படங்கள்', measuredBy: 'அளந்தது: பணியாளர் எண்ணிக்கை', recognitionOff: 'பட அடையாளம் அணைக்கப்பட்டுள்ளது: எந்தப் புகைப்படமும் கடையை விட்டு வெளியே செல்லாது.',
    photoH: 'அலமாரிச் சரிபார்ப்புக்கு ஒரு புகைப்படம் சேர்', bay: 'பகுதி', photo: 'புகைப்படம்', keep: 'இந்தப் புகைப்படத்தை வை', kept: 'புகைப்படம் கடையின் சொந்தக் கணினியில் வைக்கப்பட்டது. எங்கும் அனுப்பப்படவில்லை.',
    typeNotAllowed: 'இந்தப் பட வகை அனுமதிக்கப்படவில்லை — JPEG, PNG அல்லது WebP புகைப்படம் பயன்படுத்தவும். எதுவும் அனுப்பப்படவில்லை.', tooLarge: 'படம் மிகப் பெரியது — அதிகபட்சம் 700 KB. எதுவும் அனுப்பப்படவில்லை.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்க முடியாது.', cannotRead: 'உங்கள் பங்கு அலமாரி இணக்கத்தைப் படிக்க முடியாது.', cannotRecord: 'உங்கள் பங்கு அலமாரிப் புகைப்படங்களைச் சேர்க்க முடியாது.',
    needAll: 'முதலில் கடை, பகுதி, புகைப்படம் ஆகியவற்றை நிரப்பவும். எதுவும் அனுப்பப்படவில்லை.', refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் மாற்றப்படவில்லை.',
  },
} as const;
export type BaysCopyKey = keyof typeof BAYS_COPY.en;

export const baysWords = (lang: Lang, key: BaysCopyKey | string): string => (BAYS_COPY[lang] as Record<string, string>)[key] ?? (BAYS_COPY.en as Record<string, string>)[key] ?? key;
export function baysOutcomeWords(lang: Lang, out: Outcome<unknown>): string {
  if (out.result === 'refused') return `${baysWords(lang, 'refused')} ${out.whatHappened}`;
  if (out.result === 'invalid') return baysWords(lang, out.why);
  if (out.result === 'lost_link') return baysWords(lang, 'unreachable');
  return '';
}
/** A bay's score as the page says it — a percentage over the facings counted, or "Not scored — <why>". Never 0% for not scored. */
export function bayScoreWords(lang: Lang, b: BayView): string {
  return b.score.kind === 'scored'
    ? `${(b.score.bp / 100).toFixed(0)}% (${b.compliant}/${b.observed} ${baysWords(lang, 'counted')}, ${b.planned} ${baysWords(lang, 'planned')})`
    : `${baysWords(lang, 'notScored')} — ${b.score.because}`;
}

export interface BaysSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly record: boolean };
  bays(storeId: string): Promise<Outcome<BaysView>>;
  keepPhoto(input: { readonly storeId: string; readonly aisle: number; readonly rack: number; readonly bay: number; readonly mediaType: string; readonly bytes: number; readonly contentBase64: string }): Promise<Outcome<{ readonly sentAnywhere: false }>>;
}

export function createBaysSession(input: { readonly viewer: ViewerIdentity | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string; readonly newId?: () => string }): BaysSession {
  const perms = new Set(input.viewer?.permissions ?? []);
  const named = input.viewer?.userId !== undefined;
  const may = { named, read: named && perms.has('planogram.compliance.read'), record: named && perms.has('shelf.count.record') };
  const rand = (): string => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
  const newKey = input.newKey ?? (() => `bay-${rand()}`);
  const newId = input.newId ?? (() => `photo-${rand().slice(0, 12)}`);
  const http = input.fetch ?? ((...a: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...a));
  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Outcome<T>> {
    try {
      const res = await http(path, { method, credentials: 'same-origin', headers: { accept: 'application/json', ...(method === 'POST' ? { 'content-type': 'application/json', 'idempotency-key': newKey() } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}) });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) { const err = (json['error'] ?? {}) as { code?: string; whatHappened?: string }; return { result: 'refused', status: res.status, code: err.code ?? String(res.status), whatHappened: err.whatHappened ?? `status ${res.status}` }; }
      return { result: 'ok', value: json as T };
    } catch { return { result: 'lost_link' }; }
  }
  return {
    may,
    bays: async (storeId) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      if (!may.read) return { result: 'invalid', why: 'cannotRead' };
      if (storeId.trim() === '') return { result: 'invalid', why: 'needAll' };
      return call('GET', `/v1/merchandising/planogram-compliance/bays?storeId=${encodeURIComponent(storeId.trim())}`);
    },
    keepPhoto: async (p) => {
      if (!may.record) return { result: 'invalid', why: 'cannotRecord' };
      if (p.storeId.trim() === '' || p.contentBase64 === '') return { result: 'invalid', why: 'needAll' };
      if (!(PHOTO_TYPES as readonly string[]).includes(p.mediaType)) return { result: 'invalid', why: 'typeNotAllowed' };
      if (p.bytes > PHOTO_MAX_BYTES) return { result: 'invalid', why: 'tooLarge' };
      return call('POST', `/v1/merchandising/shelf-photos/${encodeURIComponent(newId())}`, { storeId: p.storeId.trim(), aisle: p.aisle, rack: p.rack, bay: p.bay, mediaType: p.mediaType, contentBase64: p.contentBase64 });
    },
  };
}
