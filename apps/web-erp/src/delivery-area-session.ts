// Delivery area and slots (W3 · M18-FR-01 / FR-03 · D08 · AVR-13 · §28 · P-07 · P-08 · hard rule #2). A tested, DOM-free
// session over head office's OWN serviceability routes — the page never decides who is served:
//   • GET  /v1/serviceability?on=DAY           — the delivery area in force that day: the owner's figures, or, until he sets
//                                                 any, the standard 10 km of D08 (said as "not set", never as his figure);
//   • GET  /v1/serviceability/periods          — every figure ever set and from when (append-only, the history kept);
//   • POST /v1/serviceability/periods/:from    — new figures from a start date (a different set on the SAME date is refused
//                                                 by name; a change is a later date, never an overwrite);
//   • GET  /v1/serviceability/delivery-service — where the store is, its slots that day and how full each is;
//   • PUT  /v1/serviceability/delivery-service — where the store is, slots a day, the hours, orders per slot, notice needed;
//   • GET  /v1/delivery/locations              — the places that fulfil online orders (a branch, or a dark store);
//   • POST /v1/delivery/locations/:locationId  — one place: where it is, pickup and/or delivery, its radius, the express
//                                                 minutes it can truly reach (blank: no express), orders a slot (M18-FR-03).
// Until the owner types his own numbers (AVR-13) every one reads "not set". Nothing is read or written on open.

import type { ViewerIdentity } from './browser-entry';
import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export interface ServiceabilityPolicy { readonly radiusMetres?: number; readonly minimumOrderMinor?: number; readonly deliveryFeeMinor?: number; readonly freeDeliveryAboveMinor?: number }
export interface ResolvedArea { readonly policy: ServiceabilityPolicy; readonly source: 'default' | 'scheduled'; readonly effectiveFrom: string | null; readonly on: string }
export interface AreaPeriod { readonly effectiveFrom: string; readonly policy: ServiceabilityPolicy }
export interface DeliveryService {
  readonly storeLocation: { readonly lat: number; readonly lon: number }; readonly slotsPerDay: number; readonly windowOpen: string; readonly windowClose: string;
  readonly capacityPerSlot: number; readonly leadMinutes: number; readonly setBy: string; readonly setAt: string;
}
export interface SlotsView {
  readonly deliveryService: DeliveryService | null; readonly detail?: string; readonly day?: string; readonly timeZone?: string;
  readonly slots?: readonly { readonly slotId: string; readonly startsAt: string; readonly endsAt: string; readonly capacity: number; readonly taken: number }[];
}
export interface FulfilmentPlace {
  readonly locationId: string; readonly kind: 'store' | 'dark_store'; readonly lat: number; readonly lon: number; readonly acceptsPickup: boolean; readonly acceptsDelivery: boolean;
  readonly deliveryRadiusMetres: number; readonly expressMinutes?: number; readonly capacityPerSlot?: number; readonly setBy: string; readonly setAt: string;
}
/** What the page shows for the area: each figure, or "not set" where the owner has not given one. */
export interface AreaShown { readonly radius: string; readonly minimum: string; readonly fee: string; readonly freeAbove: string; readonly from: string; readonly isDefault: boolean }

export const DELIVERY_AREA_COPY = {
  en: {
    lang: 'தமிழ்', title: 'Delivery area and slots',
    lead: 'How far the shop delivers, the delivery fee and minimum order, and the delivery slots with how many orders each can take. Until the owner types his own figures each reads "not set" — head office then uses the standard 10 km and refuses delivery orders until the slots are set. A change starts from a date; earlier figures are kept.',
    areaH: 'Delivery area', on: 'For the day', showArea: 'Show the area', radius: 'Delivers up to', minimum: 'Minimum order', fee: 'Delivery fee', freeAbove: 'Free delivery above', from: 'In force from',
    notSet: 'not set', usingDefault: 'Not set by the owner — head office uses the standard 10 km until he sets it.', km: 'km',
    historyH: 'Every figure set', showHistory: 'Show the history', noHistory: 'No figure has been set yet.',
    setAreaH: 'Set new figures', startFrom: 'Start from (date)', radiusKm: 'Delivers up to (km)', minimumRs: 'Minimum order (₹)', feeRs: 'Delivery fee (₹)', freeAboveRs: 'Free delivery above (₹)', saveArea: 'Save from that date', areaSaved: 'Saved from',
    slotsH: 'Delivery slots', day: 'Day', showSlots: 'Show the slots', noService: 'Delivery slots: not set — every delivery order is refused until they are set.', slotTaken: 'taken', storeAt: 'Store location', setBy: 'Set by',
    setSlotsH: 'Set the slots', lat: 'Store latitude', lon: 'Store longitude', slotsPerDay: 'Slots a day', open: 'First slot starts (HH:MM)', close: 'Last slot ends (HH:MM)', capacity: 'Orders each slot can take', lead2: 'Notice needed to pick (minutes)', saveSlots: 'Save the slots', slotsSaved: 'Slots saved.',
    placesH: 'Places that fulfil online orders', placesLead: 'A branch, or a dark store (a store with no shop floor — it takes no pickup). Express delivery is offered from a place only when its express minutes are set; blank means no express from there.',
    showPlaces: 'Show the places', noPlaces: 'No place is set up yet: not set.', placeId: 'Place code', kind: 'Kind', kind_store: 'Branch', kind_dark_store: 'Dark store',
    pickup: 'Takes pickup', delivery: 'Delivers', radiusPlace: 'Delivers up to (km)', express: 'Express: minutes to the door (blank = no express)', perSlot: 'Orders a slot (blank = not set)', savePlace: 'Save the place', placeSaved: 'Place saved:',
    noExpress: 'no express', expressIn: 'express in', minutes: 'minutes', yes: 'yes', no: 'no', perSlotK: 'orders a slot',
    needPlace: 'Give the place code, its latitude and longitude, a radius in km above zero, and whole numbers above zero for express and orders a slot when given. A dark store takes no pickup. Nothing was sent.',
    needDay: 'Give a date (YYYY-MM-DD) first. Nothing was read.', needFrom: 'Give the start date (YYYY-MM-DD). Nothing was sent.', needSome: 'Give at least one figure, each a number 0 or more. Nothing was sent.',
    needSlots: 'Give the store\'s latitude and longitude, whole numbers above zero for slots and orders, and hours as HH:MM with the end after the start. Nothing was sent.',
    nobody: 'Nobody is signed in on this screen — you can read nothing and change nothing.', cannotRead: 'Your role cannot read the delivery area.', cannotSet: 'Your role cannot change the delivery area.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was changed.',
  },
  ta: {
    lang: 'English', title: 'டெலிவரி பகுதி மற்றும் நேரங்கள்',
    lead: 'கடை எவ்வளவு தூரம் வரை டெலிவரி செய்கிறது, டெலிவரி கட்டணம், குறைந்தபட்ச ஆர்டர், டெலிவரி நேரங்கள் மற்றும் ஒவ்வொன்றும் எத்தனை ஆர்டர் எடுக்கலாம். உரிமையாளர் தன் எண்ணிக்கைகளைத் தட்டச்சு செய்யும் வரை ஒவ்வொன்றும் "அமைக்கப்படவில்லை" என்று காட்டும் — அதுவரை தலைமை அலுவலகம் வழக்கமான 10 கி.மீ.யைப் பயன்படுத்தும், நேரங்கள் அமைக்கப்படும் வரை டெலிவரி ஆர்டர்களை மறுக்கும். மாற்றம் ஒரு தேதியிலிருந்து தொடங்கும்; முந்தைய எண்ணிக்கைகள் வைக்கப்படும்.',
    areaH: 'டெலிவரி பகுதி', on: 'நாள்', showArea: 'பகுதியைக் காட்டு', radius: 'டெலிவரி தூரம்', minimum: 'குறைந்தபட்ச ஆர்டர்', fee: 'டெலிவரி கட்டணம்', freeAbove: 'இதற்கு மேல் இலவச டெலிவரி', from: 'நடைமுறைக்கு வந்த நாள்',
    notSet: 'அமைக்கப்படவில்லை', usingDefault: 'உரிமையாளர் அமைக்கவில்லை — அவர் அமைக்கும் வரை தலைமை அலுவலகம் வழக்கமான 10 கி.மீ.யைப் பயன்படுத்தும்.', km: 'கி.மீ.',
    historyH: 'அமைத்த எல்லா எண்ணிக்கைகளும்', showHistory: 'வரலாற்றைக் காட்டு', noHistory: 'இதுவரை எந்த எண்ணிக்கையும் அமைக்கப்படவில்லை.',
    setAreaH: 'புதிய எண்ணிக்கைகளை அமை', startFrom: 'தொடங்கும் நாள்', radiusKm: 'டெலிவரி தூரம் (கி.மீ.)', minimumRs: 'குறைந்தபட்ச ஆர்டர் (₹)', feeRs: 'டெலிவரி கட்டணம் (₹)', freeAboveRs: 'இதற்கு மேல் இலவச டெலிவரி (₹)', saveArea: 'அந்த நாளிலிருந்து சேமி', areaSaved: 'சேமிக்கப்பட்டது, தொடக்கம்',
    slotsH: 'டெலிவரி நேரங்கள்', day: 'நாள்', showSlots: 'நேரங்களைக் காட்டு', noService: 'டெலிவரி நேரங்கள்: அமைக்கப்படவில்லை — அமைக்கும் வரை ஒவ்வொரு டெலிவரி ஆர்டரும் மறுக்கப்படும்.', slotTaken: 'எடுக்கப்பட்டது', storeAt: 'கடையின் இடம்', setBy: 'அமைத்தவர்',
    setSlotsH: 'நேரங்களை அமை', lat: 'கடையின் அட்சரேகை', lon: 'கடையின் தீர்க்கரேகை', slotsPerDay: 'ஒரு நாளில் நேரங்கள்', open: 'முதல் நேரம் தொடங்கும் (HH:MM)', close: 'கடைசி நேரம் முடியும் (HH:MM)', capacity: 'ஒவ்வொரு நேரமும் எடுக்கும் ஆர்டர்கள்', lead2: 'எடுக்கத் தேவையான அவகாசம் (நிமிடம்)', saveSlots: 'நேரங்களைச் சேமி', slotsSaved: 'நேரங்கள் சேமிக்கப்பட்டன.',
    placesH: 'ஆன்லைன் ஆர்டர்களை நிறைவேற்றும் இடங்கள்', placesLead: 'ஒரு கிளை, அல்லது டார்க் ஸ்டோர் (விற்பனைத் தளம் இல்லாத கடை — அது கடையில் பெற்றுக்கொள்ளுதலை ஏற்காது). ஒரு இடத்தின் விரைவு நிமிடங்கள் அமைக்கப்பட்டால் மட்டுமே அங்கிருந்து விரைவு டெலிவரி வழங்கப்படும்; காலி என்றால் விரைவு இல்லை.',
    showPlaces: 'இடங்களைக் காட்டு', noPlaces: 'இன்னும் எந்த இடமும் அமைக்கப்படவில்லை: அமைக்கப்படவில்லை.', placeId: 'இடக் குறியீடு', kind: 'வகை', kind_store: 'கிளை', kind_dark_store: 'டார்க் ஸ்டோர்',
    pickup: 'கடையில் பெற்றுக்கொள்ளலாம்', delivery: 'டெலிவரி செய்யும்', radiusPlace: 'டெலிவரி தூரம் (கி.மீ.)', express: 'விரைவு: வாசல் வரை நிமிடங்கள் (காலி = விரைவு இல்லை)', perSlot: 'ஒரு நேரத்திற்கு ஆர்டர்கள் (காலி = அமைக்கப்படவில்லை)', savePlace: 'இடத்தைச் சேமி', placeSaved: 'இடம் சேமிக்கப்பட்டது:',
    noExpress: 'விரைவு இல்லை', expressIn: 'விரைவு', minutes: 'நிமிடங்களில்', yes: 'ஆம்', no: 'இல்லை', perSlotK: 'ஒரு நேரத்திற்கு ஆர்டர்கள்',
    needPlace: 'இடக் குறியீடு, அதன் அட்சரேகை, தீர்க்கரேகை, பூஜ்ஜியத்தை விட அதிகமான கி.மீ. தூரம், கொடுத்தால் விரைவுக்கும் ஒரு நேர ஆர்டர்களுக்கும் பூஜ்ஜியத்தை விட அதிகமான முழு எண்கள் கொடுங்கள். டார்க் ஸ்டோர் கடையில் பெற்றுக்கொள்ளுதலை ஏற்காது. எதுவும் அனுப்பப்படவில்லை.',
    needDay: 'முதலில் தேதியைக் கொடுங்கள் (YYYY-MM-DD). எதுவும் படிக்கப்படவில்லை.', needFrom: 'தொடங்கும் தேதியைக் கொடுங்கள் (YYYY-MM-DD). எதுவும் அனுப்பப்படவில்லை.', needSome: 'குறைந்தது ஒரு எண்ணிக்கையைக் கொடுங்கள், ஒவ்வொன்றும் 0 அல்லது அதற்கு மேல். எதுவும் அனுப்பப்படவில்லை.',
    needSlots: 'கடையின் அட்சரேகை, தீர்க்கரேகை, நேரங்களுக்கும் ஆர்டர்களுக்கும் பூஜ்ஜியத்தை விட அதிகமான முழு எண்கள், HH:MM வடிவில் நேரங்கள் (முடிவு தொடக்கத்திற்குப் பின்) கொடுங்கள். எதுவும் அனுப்பப்படவில்லை.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்கவோ மாற்றவோ முடியாது.', cannotRead: 'உங்கள் பங்கு டெலிவரி பகுதியைப் படிக்க முடியாது.', cannotSet: 'உங்கள் பங்கு டெலிவரி பகுதியை மாற்ற முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் மாற்றப்படவில்லை.',
  },
} as const;
export type DeliveryAreaKey = keyof typeof DELIVERY_AREA_COPY.en;
export const deliveryAreaWords = (lang: Lang, key: DeliveryAreaKey | string): string => (DELIVERY_AREA_COPY[lang] as Record<string, string>)[key] ?? (DELIVERY_AREA_COPY.en as Record<string, string>)[key] ?? key;
export const deliveryAreaOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => deliveryAreaWords(lang, k), out);

export function rupees(minor: number): string {
  return `₹${Math.floor(Math.abs(minor) / 100).toLocaleString('en-IN')}.${String(Math.abs(minor) % 100).padStart(2, '0')}`;
}
const paiseOf = (text: string): number | undefined => {
  const t = text.replace(/[,\s₹]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return undefined;
  const [r, p = ''] = t.split('.');
  return Number(r) * 100 + Number(p.padEnd(2, '0'));
};
const metresOf = (text: string): number | undefined => {
  const t = text.trim();
  if (!/^\d+(\.\d{1,3})?$/.test(t)) return undefined;
  return Math.round(Number(t) * 1000);
};
const isDay = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`));

/**
 * The area as the page shows it. Head office answers the standard 10 km when the owner has set nothing (`source: default`);
 * the page says "not set" for every figure then, so a default is never taken for the owner's own number (AVR-13 · P-08).
 */
export function areaShown(lang: Lang, r: ResolvedArea): AreaShown {
  const w = (k: DeliveryAreaKey) => deliveryAreaWords(lang, k);
  if (r.source === 'default') return { radius: w('notSet'), minimum: w('notSet'), fee: w('notSet'), freeAbove: w('notSet'), from: w('notSet'), isDefault: true };
  const p = r.policy;
  return {
    radius: p.radiusMetres === undefined ? w('notSet') : `${(p.radiusMetres / 1000).toLocaleString('en-IN', { maximumFractionDigits: 3 })} ${w('km')}`,
    minimum: p.minimumOrderMinor === undefined ? w('notSet') : rupees(p.minimumOrderMinor),
    fee: p.deliveryFeeMinor === undefined ? w('notSet') : rupees(p.deliveryFeeMinor),
    freeAbove: p.freeDeliveryAboveMinor === undefined ? w('notSet') : rupees(p.freeDeliveryAboveMinor),
    from: r.effectiveFrom ?? w('notSet'), isDefault: false,
  };
}

export interface DeliveryAreaSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly set: boolean };
  area(on: string): Promise<Outcome<ResolvedArea>>;
  history(): Promise<Outcome<{ readonly schedule: readonly AreaPeriod[]; readonly count: number }>>;
  /** New figures from a start date — only the figures typed are sent; a blank stays not set. */
  setArea(input: { readonly from: string; readonly radiusKm: string; readonly minimum: string; readonly fee: string; readonly freeAbove: string }): Promise<Outcome<{ readonly period: AreaPeriod }>>;
  slots(day: string): Promise<Outcome<SlotsView>>;
  setSlots(input: { readonly lat: string; readonly lon: string; readonly slotsPerDay: string; readonly open: string; readonly close: string; readonly capacity: string; readonly leadMinutes: string }): Promise<Outcome<{ readonly deliveryService: DeliveryService }>>;
  places(): Promise<Outcome<{ readonly locations: readonly FulfilmentPlace[] }>>;
  /** One place that fulfils online orders — express only when its minutes are typed; a dark store never takes pickup. */
  setPlace(input: { readonly locationId: string; readonly kind: 'store' | 'dark_store'; readonly lat: string; readonly lon: string; readonly pickup: boolean; readonly delivery: boolean; readonly radiusKm: string; readonly expressMinutes: string; readonly perSlot: string }): Promise<Outcome<{ readonly location: FulfilmentPlace }>>;
}

export function createDeliveryAreaSession(input: { readonly viewer: ViewerIdentity | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string }): DeliveryAreaSession {
  const perms = new Set(input.viewer?.permissions ?? []);
  const named = input.viewer?.userId !== undefined;
  const may = { named, read: named && perms.has('delivery.serviceability.read'), set: named && perms.has('delivery.serviceability.manage') };
  const call = makeCaller({ keyPrefix: 'delivery-area', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const guard = (need: boolean, why: DeliveryAreaKey): Outcome<never, DeliveryAreaKey> | undefined => (!named ? { result: 'invalid', why: 'nobody' } : !need ? { result: 'invalid', why } : undefined);
  const num = (t: string): number | undefined => (/^-?\d+(\.\d+)?$/.test(t.trim()) ? Number(t.trim()) : undefined);
  const wholeAbove0 = (t: string): number | undefined => (/^\d+$/.test(t.trim()) && Number(t.trim()) > 0 ? Number(t.trim()) : undefined);
  return {
    may,
    area: async (on) => {
      const g = guard(may.read, 'cannotRead'); if (g) return g;
      return isDay(on.trim()) ? call('GET', `/v1/serviceability?on=${on.trim()}`) : { result: 'invalid', why: 'needDay' };
    },
    history: async () => guard(may.read, 'cannotRead') ?? call('GET', '/v1/serviceability/periods'),
    setArea: async ({ from, radiusKm, minimum, fee, freeAbove }) => {
      const g = guard(may.set, 'cannotSet'); if (g) return g;
      if (!isDay(from.trim())) return { result: 'invalid', why: 'needFrom' };
      const policy: Record<string, number> = {};
      for (const [field, text, read] of [['radiusMetres', radiusKm, metresOf], ['minimumOrderMinor', minimum, paiseOf], ['deliveryFeeMinor', fee, paiseOf], ['freeDeliveryAboveMinor', freeAbove, paiseOf]] as const) {
        if (text.trim() === '') continue;
        const v = read(text);
        if (v === undefined) return { result: 'invalid', why: 'needSome' };
        policy[field] = v;
      }
      if (Object.keys(policy).length === 0) return { result: 'invalid', why: 'needSome' };
      return call('POST', `/v1/serviceability/periods/${from.trim()}`, policy);
    },
    slots: async (day) => {
      const g = guard(may.read, 'cannotRead'); if (g) return g;
      return isDay(day.trim()) ? call('GET', `/v1/serviceability/delivery-service?day=${day.trim()}`) : { result: 'invalid', why: 'needDay' };
    },
    setSlots: async ({ lat, lon, slotsPerDay, open, close, capacity, leadMinutes }) => {
      const g = guard(may.set, 'cannotSet'); if (g) return g;
      const whole = (s: string): number | undefined => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : undefined);
      const la = num(lat); const lo = num(lon); const n = whole(slotsPerDay); const c = whole(capacity);
      const lead = leadMinutes.trim() === '' ? undefined : whole(leadMinutes);
      const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
      if (la === undefined || lo === undefined || Math.abs(la) > 90 || Math.abs(lo) > 180 || n === undefined || n <= 0 || c === undefined || c <= 0
        || !hhmm.test(open.trim()) || !hhmm.test(close.trim()) || close.trim() <= open.trim() || (leadMinutes.trim() !== '' && lead === undefined)) return { result: 'invalid', why: 'needSlots' };
      return call('PUT', '/v1/serviceability/delivery-service', {
        storeLocation: { lat: la, lon: lo }, slotsPerDay: n, windowOpen: open.trim(), windowClose: close.trim(), capacityPerSlot: c, ...(lead === undefined ? {} : { leadMinutes: lead }),
      });
    },
    places: async () => guard(may.read, 'cannotRead') ?? call('GET', '/v1/delivery/locations'),
    setPlace: async ({ locationId, kind, lat, lon, pickup, delivery, radiusKm, expressMinutes, perSlot }) => {
      const g = guard(may.set, 'cannotSet'); if (g) return g;
      const id = locationId.trim();
      const la = num(lat); const lo = num(lon); const radius = metresOf(radiusKm);
      const express = expressMinutes.trim() === '' ? undefined : wholeAbove0(expressMinutes);
      const slot = perSlot.trim() === '' ? undefined : wholeAbove0(perSlot);
      if (id === '' || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || (kind !== 'store' && kind !== 'dark_store') || la === undefined || lo === undefined || Math.abs(la) > 90 || Math.abs(lo) > 180
        || radius === undefined || radius <= 0 || (expressMinutes.trim() !== '' && express === undefined) || (perSlot.trim() !== '' && slot === undefined)
        || (kind === 'dark_store' && pickup)) return { result: 'invalid', why: 'needPlace' };
      return call('POST', `/v1/delivery/locations/${encodeURIComponent(id)}`, {
        kind, lat: la, lon: lo, acceptsPickup: pickup, acceptsDelivery: delivery, deliveryRadiusMetres: radius,
        ...(express === undefined ? {} : { expressMinutes: express }), ...(slot === undefined ? {} : { capacityPerSlot: slot }),
      });
    },
  };
}
