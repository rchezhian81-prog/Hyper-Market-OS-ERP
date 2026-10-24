// The delivery desk's till jobs, on the Dispatch page (OB-352, owner 24 Oct 2026: "the customer app's saved address and
// slot when the customer has the app; otherwise the delivery desk enters them against the till job — the till prints a
// delivery slip"). A tested, DOM-free session over head office: the jobs a till booked for delivery, which path each is
// on, and — for a job whose customer has no app — the desk enters the address (the map point from the slip, kept to about
// 100 metres, and a landmark) and one of the open slots. Head office binds the slot through its own delivery service and
// refuses anything outside the radius, a full or closed slot, a second entry, and a customer who chooses in the app.

import type { ViewerIdentity } from './browser-entry';
import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const TILL_DESK_COPY = {
  en: {
    tillJobsH: 'Deliveries from the till', tillJobsLead: 'Bills the till marked for delivery. A customer with the app chooses the address and slot there; otherwise enter them here from the till’s delivery slip. Once booked, plan them with the day’s routes.',
    showTillJobs: 'Show the till deliveries', dayL: 'Slot day (YYYY-MM-DD)', none: 'No till delivery is waiting.',
    waiting_for_delivery_desk: 'Waiting for the desk — enter it from the slip', waiting_for_customer_app: 'Waiting for the customer — they choose in the app', booked: 'Booked',
    bill: 'Bill', job: 'Job', byApp: 'chosen in the app', byDesk: 'entered at the desk by', slotL: 'Slot', latL: 'Latitude', lonL: 'Longitude', landmarkL: 'Landmark (optional)',
    enter: 'Book this delivery', needFields: 'Choose a slot and give the map point (latitude and longitude) from the slip.', badPoint: 'The map point is not a latitude and longitude.',
    noSlots: 'No open slot on this day — choose another day.', booked_ok: 'Booked —', waitingDesk: 'waiting for the desk', waitingApp: 'waiting for the customer',
    cannotRead: 'Your role cannot read deliveries.', cannotEnter: 'Your role cannot book deliveries.', saved: 'Saved.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or changed.',
  },
  ta: {
    tillJobsH: 'கவுண்டரிலிருந்து டெலிவரிகள்', tillJobsLead: 'கவுண்டர் டெலிவரிக்குக் குறித்த பில்கள். செயலி உள்ள வாடிக்கையாளர் முகவரியையும் நேரத்தையும் அதில் தேர்வு செய்வார்; இல்லையெனில் கவுண்டரின் டெலிவரி சீட்டிலிருந்து இங்கே உள்ளிடுங்கள். பதிவானதும், நாளின் வழிகளுடன் திட்டமிடுங்கள்.',
    showTillJobs: 'கவுண்டர் டெலிவரிகளைக் காட்டு', dayL: 'டெலிவரி நாள் (YYYY-MM-DD)', none: 'காத்திருக்கும் கவுண்டர் டெலிவரி இல்லை.',
    waiting_for_delivery_desk: 'மேசைக்காகக் காத்திருக்கிறது — சீட்டிலிருந்து உள்ளிடுங்கள்', waiting_for_customer_app: 'வாடிக்கையாளருக்காகக் காத்திருக்கிறது — செயலியில் தேர்வு செய்வார்', booked: 'பதிவானது',
    bill: 'பில்', job: 'பணி', byApp: 'செயலியில் தேர்வு செய்யப்பட்டது', byDesk: 'மேசையில் உள்ளிட்டவர்', slotL: 'நேரம்', latL: 'அட்சரேகை', lonL: 'தீர்க்கரேகை', landmarkL: 'அடையாளம் (விருப்பம்)',
    enter: 'இந்த டெலிவரியைப் பதிவு செய்', needFields: 'ஒரு நேரத்தைத் தேர்ந்தெடுத்து, சீட்டிலிருந்து வரைபடப் புள்ளியை (அட்சரேகை, தீர்க்கரேகை) கொடுங்கள்.', badPoint: 'வரைபடப் புள்ளி அட்சரேகை, தீர்க்கரேகை அல்ல.',
    noSlots: 'இந்த நாளில் திறந்த நேரம் இல்லை — வேறு நாளைத் தேர்ந்தெடுங்கள்.', booked_ok: 'பதிவானது —', waitingDesk: 'மேசைக்காகக் காத்திருக்கிறது', waitingApp: 'வாடிக்கையாளருக்காகக் காத்திருக்கிறது',
    cannotRead: 'உங்கள் பங்கு டெலிவரிகளைப் படிக்க முடியாது.', cannotEnter: 'உங்கள் பங்கு டெலிவரிகளைப் பதிவு செய்ய முடியாது.', saved: 'சேமிக்கப்பட்டது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை, மாற்றப்படவில்லை.',
  },
} as const;

export const tillDeskWords = (lang: Lang, key: string): string => (TILL_DESK_COPY[lang] as Record<string, string>)[key] ?? (TILL_DESK_COPY.en as Record<string, string>)[key] ?? key;
export const tillDeskOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => (out.result === 'ok' ? tillDeskWords(lang, 'saved') : outcomeIn((k) => tillDeskWords(lang, k), out));

export interface TillJobRow {
  readonly orderId: string; readonly receiptNumber: string; readonly locationId: string; readonly bookedAt: string;
  readonly path: 'customer_app' | 'delivery_desk'; readonly status: 'waiting_for_customer_app' | 'waiting_for_delivery_desk' | 'booked';
  readonly given: { readonly by: 'customer_app' | 'delivery_desk'; readonly personId: string; readonly slotStartsAt: string; readonly slotEndsAt: string; readonly landmark?: string } | null;
}
export interface TillJobsRead {
  readonly jobs: readonly TillJobRow[]; readonly waitingForDesk: number; readonly waitingForCustomer: number;
  readonly days: readonly string[]; readonly openSlots: readonly { readonly startsAt: string; readonly endsAt: string; readonly remaining: number }[];
}

export interface TillDeskSession {
  readonly may: { readonly read: boolean; readonly enter: boolean };
  jobs(storeId: string, day: string): Promise<Outcome<TillJobsRead, 'badDate'>>;
  enter(orderId: string, input: { readonly slotStartsAt: string; readonly lat: string; readonly lon: string; readonly landmark: string }): Promise<Outcome<unknown, 'needFields' | 'badPoint'>>;
}

/** A latitude/longitude as typed ("11.0168"), or undefined when it is not one. */
export function coordinateOf(raw: string, max: number): number | undefined {
  const s = raw.trim();
  if (!/^-?\d{1,3}(\.\d{1,7})?$/.test(s)) return undefined;
  const n = Number(s);
  return Math.abs(n) <= max ? n : undefined;
}

export function createTillDeskSession(input: { readonly viewer: ViewerIdentity | { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string }): TillDeskSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const call = makeCaller({ keyPrefix: 'till-desk', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  return {
    may: { read: named && held.has('delivery.run.read'), enter: named && held.has('delivery.dispatch.manage') },
    jobs: async (storeId, day) => {
      if (day.trim() !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(day.trim())) return { result: 'invalid', why: 'badDate' };
      const q = new URLSearchParams({ ...(storeId.trim() === '' ? {} : { storeId: storeId.trim() }), ...(day.trim() === '' ? {} : { day: day.trim() }) }).toString();
      return call('GET', `/v1/delivery/till-jobs${q === '' ? '' : `?${q}`}`);
    },
    enter: async (orderId, e) => {
      if (e.slotStartsAt.trim() === '' || e.lat.trim() === '' || e.lon.trim() === '') return { result: 'invalid', why: 'needFields' };
      const lat = coordinateOf(e.lat, 90); const lon = coordinateOf(e.lon, 180);
      if (lat === undefined || lon === undefined) return { result: 'invalid', why: 'badPoint' };
      return call('POST', `/v1/delivery/till-jobs/${encodeURIComponent(orderId)}/delivery`, {
        slotStartsAt: e.slotStartsAt.trim(), deliveryLocation: { lat, lon }, ...(e.landmark.trim() === '' ? {} : { landmark: e.landmark.trim() }),
      });
    },
  };
}
