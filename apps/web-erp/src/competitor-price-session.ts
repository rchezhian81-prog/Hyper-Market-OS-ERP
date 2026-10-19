// COMPETITOR PRICES — the capture-and-compare panel on the Products and prices page (D06-FR-05 "markdown ladder and
// competitor capture" · M05 · P-02 · P-05 · hard rule #2).
//
// A THIN client over head office's own routes: `POST /v1/prices/competitor/:observationId` records one sighting (an
// observation, append-only — never edited; a re-send is the same record) and `GET /v1/prices/competitor?storeId=` puts
// beside each product the shop's OWN effective price at that store now and each competitor's latest sighting, with the
// gap and how old the sighting is. It CHANGES NO PRICE: a gap is information; a change goes through the governed price
// route with its own checks and approval. No rule lives here — what may be recorded, and every refusal, is head office's.

import { translator, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { rupees, paiseOf, outcomeOf, type HttpAnswer, type Outcome } from './finance-close-session';

export { rupees, paiseOf };

export const COMPETITOR_SOURCES = Object.freeze(['shelf_visit', 'website', 'flyer', 'phone'] as const);
export type CompetitorSource = (typeof COMPETITOR_SOURCES)[number];

export interface CompetitorHttp {
  get(path: string): Promise<HttpAnswer>;
  post(path: string, body: unknown): Promise<HttpAnswer>;
}

export interface CompetitorViewer {
  readonly userId?: string;
  readonly permissions: readonly string[];
  readonly storeId?: string;
  /** Now on the box's clock (ISO) — used when the person does not say when they saw it. */
  readonly now?: string;
  /** The shop's products the screen was given, for names. */
  readonly products?: readonly { readonly productId: string; readonly name: string }[];
}

export interface ComparisonRow {
  readonly productId: string;
  readonly ourPriceMinor: number | null;
  readonly ourPriceNotKnown?: string;
  readonly competitors: readonly {
    readonly competitor: string; readonly priceMinor: number; readonly observedAt: string; readonly source: string; readonly ageDays: number;
    readonly observationId: string; readonly recordedBy: string; readonly note?: string; readonly gapMinor?: number; readonly gapBps?: number;
  }[];
}
export interface Comparison { readonly storeId: string; readonly asAt: string; readonly products: readonly ComparisonRow[]; readonly count: number; readonly changesNoPrice: true }

export interface SightingInput {
  readonly productId: string;
  readonly competitor: string;
  /** Rupees as typed. */
  readonly price: string;
  readonly source: CompetitorSource;
  /** When it was seen (ISO or a datetime-local); empty → now on the box's clock. */
  readonly observedAt?: string;
  readonly note?: string;
}

export const COMPETITOR_PERMISSIONS = Object.freeze({ read: 'catalogue.pack.read', record: 'price.change.propose' });

export type CompetitorCopyKey =
  | 'tab' | 'h' | 'lede' | 'product' | 'competitor' | 'price' | 'source' | 'seenAt' | 'note' | 'record' | 'recorded' | 'already'
  | 'ours' | 'theirs' | 'gap' | 'dearer' | 'cheaper' | 'same' | 'daysOld' | 'today' | 'ourNotKnown' | 'none' | 'noPrice'
  | 'shelf_visit' | 'website' | 'flyer' | 'phone' | 'changesNoPrice' | 'refused' | 'unreachable' | 'notAllowed' | 'cannotRead' | 'readOnly' | 'needFields' | 'noStore' | 'notConnected'
  // R4 D-18 (OB-216): drafted price changes a person approves.
  | 'draftsH' | 'draftsLede' | 'noDrafts' | 'draftLine' | 'approveDraft' | 'draftApproved' | 'notDraftedH' | 'ruleLine' | 'ruleOwner' | 'ruleDefault' | 'cappedAtMrp';

export const COMPETITOR_COPY: BilingualCopy<CompetitorCopyKey> = {
  en: {
    tab: 'Competitor prices', h: 'Competitor prices', lede: 'Write down a price you saw at another shop and see it beside ours. Recording a price changes no price — a change goes through “Change a price” with its own checks and approval.',
    product: 'Our item', competitor: 'Which shop', price: 'Their price (₹)', source: 'Where you saw it', seenAt: 'When you saw it (leave empty for now)', note: 'Pack or offer note (optional)',
    record: 'Record this price', recorded: 'Recorded — head office kept the sighting. No price was changed.', already: 'Already recorded — the same sighting, kept once.',
    ours: 'Our price', theirs: 'Their price', gap: 'Gap', dearer: 'we are dearer by', cheaper: 'we are cheaper by', same: 'the same price', daysOld: '{n} days old', today: 'seen today',
    ourNotKnown: 'our price here is not known today', none: 'No competitor price recorded for this store yet.', noPrice: '—',
    shelf_visit: 'Shelf visit', website: 'Website', flyer: 'Flyer', phone: 'Phone', changesNoPrice: 'This comparison changes no price.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was recorded.', notAllowed: 'Your role cannot record competitor prices.',
    cannotRead: 'Your role cannot read the comparison.', readOnly: 'You can read the comparison; recording a price needs a pricing role.', needFields: 'Pick an item, name the shop and give their price.',
    noStore: 'This screen was not told which store it is for.',
    notConnected: 'Competitor prices are kept at head office. Open Products and prices from head office to record or compare them.',
    draftsH: 'Drafted price changes', draftsLede: 'Where a competitor is far enough below us and was seen recently, a price change is drafted — never above MRP, never below cost or the margin floor. Nothing changes until a person approves it here, through the normal price checks.',
    noDrafts: 'No price change is drafted for this store.', draftLine: '{name}: {from} → {to} to match {who} ({gap}% below, seen {age} day(s) ago)',
    approveDraft: 'Approve this price', draftApproved: 'Approved — the new price goes to the tills with the next price update.', notDraftedH: 'Not drafted, and why',
    ruleLine: 'Rule: a competitor {gap}% or more below us, seen under {age} days ago', ruleOwner: '(your setting)', ruleDefault: '(the agreed starting setting)', cappedAtMrp: 'kept at the MRP',
  },
  ta: {
    tab: 'போட்டியாளர் விலைகள்', h: 'போட்டியாளர் விலைகள்', lede: 'மற்றொரு கடையில் பார்த்த விலையை எழுதி, நம் விலையுடன் ஒப்பிடுங்கள். விலையைப் பதிவு செய்வது எந்த விலையையும் மாற்றாது — மாற்றம் “விலையை மாற்று” வழியாக அதன் சரிபார்ப்புகளுடனும் ஒப்புதலுடனும் செல்லும்.',
    product: 'நம் பொருள்', competitor: 'எந்தக் கடை', price: 'அவர்கள் விலை (₹)', source: 'எங்கே பார்த்தீர்கள்', seenAt: 'எப்போது பார்த்தீர்கள் (இப்போது என்றால் காலியாக விடுங்கள்)', note: 'பொதி அல்லது சலுகைக் குறிப்பு (விருப்பம்)',
    record: 'இந்த விலையைப் பதிவு செய்', recorded: 'பதிவு செய்யப்பட்டது — தலைமை அலுவலகம் வைத்துக்கொண்டது. எந்த விலையும் மாற்றப்படவில்லை.', already: 'ஏற்கனவே பதிவு செய்யப்பட்டது — அதே பதிவு, ஒருமுறை வைக்கப்பட்டது.',
    ours: 'நம் விலை', theirs: 'அவர்கள் விலை', gap: 'வேறுபாடு', dearer: 'நாம் அதிகம்', cheaper: 'நாம் குறைவு', same: 'அதே விலை', daysOld: '{n} நாட்கள் பழையது', today: 'இன்று பார்த்தது',
    ourNotKnown: 'இங்கே நம் விலை இன்று தெரியவில்லை', none: 'இந்தக் கடைக்கு இன்னும் போட்டியாளர் விலை பதிவாகவில்லை.', noPrice: '—',
    shelf_visit: 'அலமாரிப் பார்வை', website: 'இணையதளம்', flyer: 'விளம்பரத் தாள்', phone: 'தொலைபேசி', changesNoPrice: 'இந்த ஒப்பீடு எந்த விலையையும் மாற்றாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் பதிவாகவில்லை.', notAllowed: 'உங்கள் பங்கால் போட்டியாளர் விலைகளைப் பதிவு செய்ய முடியாது.',
    cannotRead: 'உங்கள் பங்கால் ஒப்பீட்டைப் படிக்க முடியாது.', readOnly: 'நீங்கள் ஒப்பீட்டைப் படிக்கலாம்; விலையைப் பதிவு செய்ய விலை நிர்ணயப் பங்கு தேவை.', needFields: 'ஒரு பொருளைத் தேர்ந்தெடுத்து, கடையின் பெயரையும் அவர்கள் விலையையும் கொடுங்கள்.',
    noStore: 'இந்தத் திரைக்கு எந்தக் கடை என்று சொல்லப்படவில்லை.',
    notConnected: 'போட்டியாளர் விலைகள் தலைமை அலுவலகத்தில் வைக்கப்படுகின்றன. அவற்றைப் பதிவு செய்ய அல்லது ஒப்பிட, தலைமை அலுவலகத்திலிருந்து பொருட்களும் விலைகளும் திரையைத் திறக்கவும்.',
    draftsH: 'வரைவு விலை மாற்றங்கள்', draftsLede: 'ஒரு போட்டியாளர் நம்மைவிடப் போதுமான அளவு குறைவாகவும் சமீபத்தில் பார்க்கப்பட்டும் இருந்தால், விலை மாற்றம் வரைவு செய்யப்படும் — MRP-க்கு மேல் இல்லை, அடக்கவிலை அல்லது குறைந்தபட்ச லாப வரம்புக்குக் கீழ் இல்லை. ஒருவர் இங்கே வழக்கமான விலைச் சரிபார்ப்புகளுடன் ஒப்புதல் அளிக்கும் வரை எதுவும் மாறாது.',
    noDrafts: 'இந்தக் கடைக்கு எந்த விலை மாற்றமும் வரைவு செய்யப்படவில்லை.', draftLine: '{name}: {from} → {to}, {who} உடன் பொருந்த ({gap}% குறைவு, {age} நாள் முன் பார்த்தது)',
    approveDraft: 'இந்த விலைக்கு ஒப்புதல் அளி', draftApproved: 'ஒப்புதல் அளிக்கப்பட்டது — அடுத்த விலை புதுப்பிப்புடன் புதிய விலை பில் இயந்திரங்களுக்குச் செல்லும்.', notDraftedH: 'வரைவு செய்யப்படாதவை, ஏன்',
    ruleLine: 'விதி: ஒரு போட்டியாளர் நம்மைவிட {gap}% அல்லது அதற்கு மேல் குறைவு, {age} நாட்களுக்குள் பார்த்தது', ruleOwner: '(உங்கள் அமைப்பு)', ruleDefault: '(ஒப்புக்கொண்ட தொடக்க அமைப்பு)', cappedAtMrp: 'MRP-யில் வைக்கப்பட்டது',
  },
};
export const COMPETITOR_COPY_KEYS: readonly CompetitorCopyKey[] = Object.freeze(Object.keys(COMPETITOR_COPY.en) as CompetitorCopyKey[]);

export function competitorWords(lang: Lang): (key: CompetitorCopyKey, fill?: Readonly<Record<string, string | number>>) => string {
  const t = translator(COMPETITOR_COPY, lang);
  return (key, fill) => Object.entries(fill ?? {}).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), t(key));
}

/** The gap in words: positive = the shop is dearer. Never a zero for "not known". Pure. */
export function gapWords(lang: Lang, gapMinor: number | undefined): string {
  const w = competitorWords(lang);
  if (gapMinor === undefined) return w('ourNotKnown');
  if (gapMinor === 0) return w('same');
  return `${gapMinor > 0 ? w('dearer') : w('cheaper')} ${rupees(Math.abs(gapMinor))}`;
}

export function competitorOutcomeWords(lang: Lang, o: Outcome<{ alreadyRecorded?: boolean }>): { readonly ok: boolean; readonly text: string } {
  const w = competitorWords(lang);
  switch (o.kind) {
    case 'done': return { ok: true, text: o.body.alreadyRecorded === true ? w('already') : w('recorded') };
    case 'refused': return { ok: false, text: `${w('refused')} ${o.whatHappened}${o.nextSafeAction === '' ? '' : ` ${o.nextSafeAction}`}` };
    case 'not_allowed': return { ok: false, text: w('notAllowed') };
    case 'invalid': return { ok: false, text: o.detail === '' ? w('needFields') : o.detail };
    case 'unreachable': return { ok: false, text: w('unreachable') };
  }
}

/** R4 D-18: one drafted price change, as head office drafts it (`GET /v1/prices/competitor-drafts`). */
export interface DraftView {
  readonly productId: string; readonly storeId: string; readonly fromPriceMinor: number; readonly draftPriceMinor: number;
  readonly mrpMinor: number; readonly costMinor: number; readonly currency: string; readonly competitor: string; readonly competitorPriceMinor: number;
  readonly ageDays: number; readonly gapBps: number; readonly cappedAtMrp: boolean; readonly detail: string;
}
export interface DraftsView {
  readonly storeId: string; readonly rule: { readonly gapBps: number; readonly maxAgeDays: number; readonly source: string; readonly version: number | null };
  readonly drafts: readonly DraftView[];
  readonly notDrafted: readonly { readonly productId: string; readonly reason: string; readonly words: string; readonly detail: string; readonly competitor?: string }[];
  readonly advisoryOnly: true; readonly pricesChanged: false;
}

export interface CompetitorPriceSession {
  readonly may: { readonly read: boolean; readonly record: boolean };
  readonly storeId: string | null;
  readonly products: readonly { readonly productId: string; readonly name: string }[];
  nameOf(productId: string): string;
  compare(): Promise<Outcome<Comparison>>;
  record(input: SightingInput): Promise<Outcome<{ readonly alreadyRecorded?: boolean }>>;
  /** R4 D-18: the drafted price changes for this store — a read; it changes nothing. */
  drafts(): Promise<Outcome<DraftsView>>;
  /**
   * R4 D-18: a PERSON approves one draft — it goes through the existing price route (`POST /v1/prices/changes`) with the
   * draft's own figures, where head office judges it again against the MRP, the cost and the store's margin floor.
   */
  approveDraft(draft: DraftView): Promise<Outcome<{ readonly priceMinor: number; readonly verdict: string }>>;
}

export function createCompetitorPriceSession(viewer: CompetitorViewer, http: CompetitorHttp, newId: () => string = () => globalThis.crypto?.randomUUID?.() ?? `obs-${Date.now()}`): CompetitorPriceSession {
  const held = new Set(viewer.permissions);
  const may = Object.freeze({ read: held.has(COMPETITOR_PERMISSIONS.read), record: held.has(COMPETITOR_PERMISSIONS.record) });
  const storeId = viewer.storeId !== undefined && viewer.storeId.trim() !== '' ? viewer.storeId : null;
  const products = viewer.products ?? [];
  const names = new Map(products.map((p) => [p.productId, p.name]));
  return {
    may, storeId, products,
    nameOf: (id) => names.get(id) ?? id,
    compare: async () => {
      if (!may.read) return { kind: 'not_allowed', needs: COMPETITOR_PERMISSIONS.read };
      if (storeId === null) return { kind: 'invalid', detail: '' };
      return outcomeOf<Comparison>(await http.get(`/v1/prices/competitor?storeId=${encodeURIComponent(storeId)}`));
    },
    record: async (input) => {
      if (!may.record) return { kind: 'not_allowed', needs: COMPETITOR_PERMISSIONS.record };
      const priceMinor = paiseOf(input.price);
      if (storeId === null || input.productId.trim() === '' || input.competitor.trim() === '' || priceMinor === null || priceMinor <= 0) return { kind: 'invalid', detail: '' };
      const when = input.observedAt !== undefined && input.observedAt.trim() !== '' ? input.observedAt : viewer.now;
      if (when === undefined || Number.isNaN(Date.parse(when))) return { kind: 'invalid', detail: '' };
      const note = input.note?.trim() ?? '';
      // One id per sighting, minted once per click: a re-send after a lost reply is the same record (head office says so).
      return outcomeOf(await http.post(`/v1/prices/competitor/${encodeURIComponent(newId())}`, {
        productId: input.productId, storeId, competitor: input.competitor.trim(), priceMinor, observedAt: new Date(when).toISOString(), source: input.source,
        ...(note === '' ? {} : { note }),
      }));
    },
    drafts: async () => {
      if (!may.record) return { kind: 'not_allowed', needs: COMPETITOR_PERMISSIONS.record };
      if (storeId === null) return { kind: 'invalid', detail: '' };
      return outcomeOf<DraftsView>(await http.get(`/v1/prices/competitor-drafts?storeId=${encodeURIComponent(storeId)}`));
    },
    approveDraft: async (d) => {
      if (!may.record) return { kind: 'not_allowed', needs: COMPETITOR_PERMISSIONS.record };
      return outcomeOf(await http.post('/v1/prices/changes', {
        productId: d.productId, priceMinor: d.draftPriceMinor, mrpMinor: d.mrpMinor, costMinor: d.costMinor, currency: d.currency, storeId: d.storeId,
      }));
    },
  };
}

export function browserCompetitorHttp(): CompetitorHttp {
  const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
  const answer = async (res: Response): Promise<HttpAnswer> => ({ status: res.status, body: await res.json().catch(() => null) });
  return {
    get: async (path) => {
      if (fetchFn === undefined) return { status: 0, body: null };
      try { return await answer(await fetchFn(path, { headers: { accept: 'application/json' }, credentials: 'same-origin' })); } catch { return { status: 0, body: null }; }
    },
    post: async (path, body) => {
      if (fetchFn === undefined) return { status: 0, body: null };
      const key = globalThis.crypto?.randomUUID?.() ?? `competitor-${Date.now()}`;
      try {
        return await answer(await fetchFn(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json', 'idempotency-key': key }, body: JSON.stringify(body ?? {}) }));
      } catch { return { status: 0, body: null }; }
    },
  };
}
