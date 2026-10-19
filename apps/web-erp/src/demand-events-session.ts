// D-24 (R4, signed OB-227 · OB-220) — the Store events page's tested, DOM-free session. A thin client over head office's
// own routes: the festivals and local events a manager records for the store (dates and the expected effect), each with
// how its effect is known ("manager's estimate" until an earlier occurrence back-tests it), the product forecast that
// uses them with no extra step, the 7-day correction with its back-test error, and the weather link — switched off.
// Every rule is head office's; this session refuses only the cheap things before a request and never writes on open.

import type { ViewerIdentity } from './browser-entry';
import { makeCaller, newId, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';
export interface EventView {
  readonly eventId: string; readonly version: number; readonly storeId: string; readonly label: string; readonly kind: string;
  readonly from: string; readonly to: string; readonly multiplier: number; readonly productIds?: readonly string[];
  readonly effect: { readonly basis: 'manager_estimate' | 'back_tested'; readonly words: string };
}
export interface EventsView { readonly events: readonly EventView[]; readonly weather: { readonly state: string; readonly detail: string } }
export interface ForecastView {
  readonly productId: string;
  readonly horizon: readonly { readonly day: string; readonly forecastQty: number; readonly appliedSignals: readonly string[] }[];
  readonly shortHorizon?: {
    readonly correction: { readonly factor: number; readonly basis: string; readonly recentDays: number };
    readonly horizon: readonly { readonly day: string; readonly forecastQty: number; readonly correctedQty: number; readonly appliedSignals: readonly string[] }[];
    readonly backtest: { readonly testedDays?: number; readonly plainWape?: number; readonly correctedWape?: number; readonly notBackTested?: true };
  };
  readonly storedEvents?: readonly { readonly eventId: string; readonly label: string; readonly effect: { readonly basis: string; readonly words: string } }[];
  readonly weather?: { readonly state: string; readonly detail: string };
}

export const EVENTS_COPY = {
  en: {
    lang: 'தமிழ்', title: 'Store events',
    lead: 'Festivals and local events the manager records for the store. The next forecasts and order proposals use them with no extra step, and every figure an event changes names it.',
    store: 'Store', show: 'Show the events', recordH: 'Record an event', label: 'Name', kind: 'Kind', festival: 'Festival', local_event: 'Local event',
    from: 'From', to: 'To', effect: 'Expected effect (e.g. 1.5 = half as much again)', products: 'Only these products (codes, comma-separated; optional)', save: 'Record the event',
    eventsH: 'Events in the calendar', forecastH: 'What it does to a forecast', product: 'Product code', forecast: 'Show the next 7 days',
    withdrawReason: 'Why withdraw it', withdraw: 'Withdraw', recorded: 'Recorded. The next forecast and order proposal use it.', withdrawn: 'Withdrawn. It is kept on record and no longer used.',
    noEvents: 'No event is recorded for this store.', allProducts: 'all products', day: 'Day', forecastCol: 'Forecast', correctedCol: 'Corrected from the last 7 days', eventsCol: 'Events',
    backtest: 'Back-test error over the last {days} days — plain forecast: {plain}; corrected: {corrected}.', notBackTested: 'Not back-tested: too little history to hold out a week and still correct.',
    factor: 'Correction from the last 7 days: ×{factor}.',
    nobody: 'Nobody is signed in on this screen — you can read nothing and change nothing.', cannotRead: 'Your role cannot read the forecast.', cannotManage: 'Only a manager can record or withdraw an event.',
    needStore: 'Fill in the store first. Nothing was sent.', needEvent: 'Fill in the name, both days and the expected effect (a number above 0). Nothing was sent.', needReason: 'Say why first. Nothing was sent.', needProduct: 'Give a product code first. Nothing was sent.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was changed.',
  },
  ta: {
    lang: 'English', title: 'கடை நிகழ்வுகள்',
    lead: 'மேலாளர் கடைக்காகப் பதிவு செய்யும் திருவிழாக்களும் உள்ளூர் நிகழ்வுகளும். அடுத்த முன்கணிப்புகளும் ஆர்டர் முன்மொழிவுகளும் கூடுதல் படியின்றி இவற்றைப் பயன்படுத்தும்; ஒரு நிகழ்வு மாற்றும் ஒவ்வொரு எண்ணும் அதன் பெயரைக் கூறும்.',
    store: 'கடை', show: 'நிகழ்வுகளைக் காட்டு', recordH: 'நிகழ்வைப் பதிவு செய்', label: 'பெயர்', kind: 'வகை', festival: 'திருவிழா', local_event: 'உள்ளூர் நிகழ்வு',
    from: 'முதல்', to: 'வரை', effect: 'எதிர்பார்க்கும் விளைவு (எ.கா. 1.5 = பாதி அதிகம்)', products: 'இந்தப் பொருட்கள் மட்டும் (குறியீடுகள், காற்புள்ளியால் பிரித்து; விருப்பம்)', save: 'நிகழ்வைப் பதிவு செய்',
    eventsH: 'நாட்காட்டியில் உள்ள நிகழ்வுகள்', forecastH: 'முன்கணிப்பில் அதன் விளைவு', product: 'பொருள் குறியீடு', forecast: 'அடுத்த 7 நாட்களைக் காட்டு',
    withdrawReason: 'ஏன் திரும்பப் பெறுவது', withdraw: 'திரும்பப் பெறு', recorded: 'பதிவு செய்யப்பட்டது. அடுத்த முன்கணிப்பும் ஆர்டர் முன்மொழிவும் இதைப் பயன்படுத்தும்.', withdrawn: 'திரும்பப் பெறப்பட்டது. பதிவில் வைக்கப்பட்டுள்ளது, இனி பயன்படுத்தப்படாது.',
    noEvents: 'இந்தக் கடைக்கு எந்த நிகழ்வும் பதிவு செய்யப்படவில்லை.', allProducts: 'எல்லாப் பொருட்களும்', day: 'நாள்', forecastCol: 'முன்கணிப்பு', correctedCol: 'கடந்த 7 நாட்களிலிருந்து திருத்தியது', eventsCol: 'நிகழ்வுகள்',
    backtest: 'கடந்த {days} நாட்களின் பின்-சோதனைப் பிழை — சாதாரண முன்கணிப்பு: {plain}; திருத்தியது: {corrected}.', notBackTested: 'பின்-சோதனை செய்யப்படவில்லை: ஒரு வாரத்தை ஒதுக்கித் திருத்த போதிய வரலாறு இல்லை.',
    factor: 'கடந்த 7 நாட்களிலிருந்து திருத்தம்: ×{factor}.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்கவோ மாற்றவோ முடியாது.', cannotRead: 'உங்கள் பங்கு முன்கணிப்பைப் படிக்க முடியாது.', cannotManage: 'மேலாளர் மட்டுமே நிகழ்வைப் பதிவு செய்யவோ திரும்பப் பெறவோ முடியும்.',
    needStore: 'முதலில் கடையை நிரப்பவும். எதுவும் அனுப்பப்படவில்லை.', needEvent: 'பெயர், இரண்டு நாட்கள், எதிர்பார்க்கும் விளைவு (0-க்கு மேல்) நிரப்பவும். எதுவும் அனுப்பப்படவில்லை.', needReason: 'முதலில் காரணத்தைச் சொல்லுங்கள். எதுவும் அனுப்பப்படவில்லை.', needProduct: 'முதலில் பொருள் குறியீட்டைக் கொடுக்கவும். எதுவும் அனுப்பப்படவில்லை.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் மாற்றப்படவில்லை.',
  },
} as const;
export type EventsCopyKey = keyof typeof EVENTS_COPY.en;
export const eventsWords = (lang: Lang, key: EventsCopyKey | string): string => (EVENTS_COPY[lang] as Record<string, string>)[key] ?? (EVENTS_COPY.en as Record<string, string>)[key] ?? key;
export const eventsOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => eventsWords(lang, k), out);
/** The words for an effect: the manager's figure, and how it is known. */
export const effectWords = (lang: Lang, e: Pick<EventView, 'multiplier' | 'effect'>): string => `×${e.multiplier} — ${e.effect.basis === 'manager_estimate' ? (lang === 'ta' ? 'மேலாளரின் மதிப்பீடு' : "manager's estimate") : e.effect.words}`;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface EventsSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly manage: boolean };
  events(storeId: string): Promise<Outcome<EventsView>>;
  record(input: { storeId: string; label: string; kind: string; from: string; to: string; effect: string; products: string }): Promise<Outcome<{ readonly event: EventView }>>;
  withdraw(eventId: string, reason: string): Promise<Outcome<{ readonly event: EventView }>>;
  forecast(productId: string): Promise<Outcome<ForecastView>>;
}

export function createEventsSession(input: { readonly viewer: ViewerIdentity | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string }): EventsSession {
  const perms = new Set(input.viewer?.permissions ?? []);
  const named = input.viewer?.userId !== undefined;
  const may = { named, read: named && perms.has('inventory.availability.read'), manage: named && perms.has('inventory.calendar.manage') };
  const call = makeCaller({ keyPrefix: 'events', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const enc = encodeURIComponent;
  const guard = (need: boolean, why: EventsCopyKey): Outcome<never, EventsCopyKey> | undefined => (!named ? { result: 'invalid', why: 'nobody' } : !need ? { result: 'invalid', why } : undefined);
  return {
    may,
    events: async (storeId) => guard(may.read, 'cannotRead') ?? (storeId.trim() === '' ? { result: 'invalid', why: 'needStore' } : call('GET', `/v1/inventory/demand-events?storeId=${enc(storeId.trim())}`)),
    record: async (e) => {
      const g = guard(may.manage, 'cannotManage'); if (g) return g;
      if (e.storeId.trim() === '') return { result: 'invalid', why: 'needStore' };
      const multiplier = Number(e.effect.trim());
      if (e.label.trim() === '' || !DAY.test(e.from) || !DAY.test(e.to) || !Number.isFinite(multiplier) || multiplier <= 0) return { result: 'invalid', why: 'needEvent' };
      const productIds = e.products.split(',').map((p) => p.trim()).filter((p) => p !== '');
      return call('POST', `/v1/inventory/demand-events/${enc(newId('ev'))}`, { storeId: e.storeId.trim(), label: e.label.trim(), kind: e.kind, from: e.from, to: e.to, multiplier, ...(productIds.length === 0 ? {} : { productIds }) });
    },
    withdraw: async (eventId, reason) => {
      const g = guard(may.manage, 'cannotManage'); if (g) return g;
      return reason.trim() === '' ? { result: 'invalid', why: 'needReason' } : call('POST', `/v1/inventory/demand-events/${enc(eventId)}/withdraw`, { reason: reason.trim() });
    },
    forecast: async (productId) => guard(may.read, 'cannotRead') ?? (productId.trim() === '' ? { result: 'invalid', why: 'needProduct' } : call('GET', `/v1/inventory/demand-forecast?productId=${enc(productId.trim())}&horizonDays=7`)),
  };
}
