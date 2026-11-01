// "Repeat orders" on the Delivery exceptions page (M17-FR-02 subscriptions · OB-303 · P-03 · P-08 · Round 4b — the re-audit's
// "no screen reads repeat orders"). A tested, DOM-free THIN client over head office's staff routes:
//   • READ (`GET /v1/repeat-orders`, `order.read`) — every customer's repeat-order plan (on / paused / cancelled, where it
//     is collected or delivered, its next days) and, FIRST, every day that was NOT placed or was missed, each in the shop's
//     own words (control by exception);
//   • RUN NOW (`POST /v1/repeat-orders/run`, `order.exception.manage`) — the same placement head office's timer runs; once per
//     plan and day, so running it again places nothing twice. Nothing is charged: the customer pays each order in the app.
// Nothing is read on open.

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const REPEAT_ORDERS_COPY = {
  en: {
    h: 'Repeat orders', lead: 'Customers\' repeat orders from the app. The days that were not placed come first — each says why. The shop places each one the day before; the customer pays in the app.',
    show: 'Show the repeat orders', run: 'Place the ones due now', none: 'No customer has a repeat order.', allPlaced: 'Every repeat order due so far was placed.',
    notPlacedH: 'Days not placed', o_not_placed: 'Not placed', o_missed: 'Missed', o_placed: 'Placed', plansH: 'Every repeat order',
    st_active: 'On', st_paused: 'Paused', st_cancelled: 'Cancelled', pickup: 'collect at', delivery: 'delivered from', next: 'next', items: 'items', from: 'from',
    ranNow: 'Done — placed', notPlacedNow: 'not placed', missedNow: 'missed', nothingDue: 'Nothing was due — nothing was placed twice.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot read orders.', cannotRun: 'Your role cannot place repeat orders.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or placed.',
  },
  ta: {
    h: 'தொடர் ஆர்டர்கள்', lead: 'செயலியிலிருந்து வாடிக்கையாளர்களின் தொடர் ஆர்டர்கள். வைக்கப்படாத நாட்கள் முதலில் — ஒவ்வொன்றும் ஏன் எனச் சொல்லும். கடை ஒவ்வொன்றையும் முந்தைய நாள் வைக்கும்; வாடிக்கையாளர் செயலியில் பணம் செலுத்துவார்.',
    show: 'தொடர் ஆர்டர்களைக் காட்டு', run: 'இப்போது உரியவற்றை வை', none: 'எந்த வாடிக்கையாளருக்கும் தொடர் ஆர்டர் இல்லை.', allPlaced: 'இதுவரை உரிய ஒவ்வொரு தொடர் ஆர்டரும் வைக்கப்பட்டது.',
    notPlacedH: 'வைக்கப்படாத நாட்கள்', o_not_placed: 'வைக்கப்படவில்லை', o_missed: 'தவறியது', o_placed: 'வைக்கப்பட்டது', plansH: 'எல்லாத் தொடர் ஆர்டர்களும்',
    st_active: 'இயக்கத்தில்', st_paused: 'இடைநிறுத்தம்', st_cancelled: 'ரத்து', pickup: 'பெறும் இடம்', delivery: 'அனுப்பும் இடம்', next: 'அடுத்து', items: 'பொருட்கள்', from: 'தொடக்கம்',
    ranNow: 'முடிந்தது — வைக்கப்பட்டவை', notPlacedNow: 'வைக்கப்படாதவை', missedNow: 'தவறியவை', nothingDue: 'எதுவும் உரியதாக இல்லை — எதுவும் இருமுறை வைக்கப்படவில்லை.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பணி ஆர்டர்களைப் படிக்க முடியாது.', cannotRun: 'உங்கள் பணி தொடர் ஆர்டர்களை வைக்க முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கவோ வைக்கவோ இல்லை.',
  },
} as const;

export const repeatWords = (lang: Lang, key: string): string =>
  (REPEAT_ORDERS_COPY[lang] as Record<string, string>)[key] ?? (REPEAT_ORDERS_COPY.en as Record<string, string>)[key] ?? key;

export interface Occurrence { readonly subscriptionId: string; readonly day: string; readonly orderId: string; readonly outcome: 'placed' | 'not_placed' | 'missed'; readonly at: string; readonly detail: string }
export interface PlanRow {
  readonly subscriptionId: string; readonly locationId: string; readonly fulfilment: 'pickup' | 'delivery'; readonly startsOn: string; readonly state: 'active' | 'paused' | 'cancelled';
  readonly say?: { readonly en: string; readonly ta: string }; readonly nextDays: readonly string[]; readonly lines: readonly unknown[]; readonly occurrences: readonly Occurrence[];
}
export interface RepeatOrdersView { readonly subscriptions: readonly PlanRow[]; readonly notPlaced: readonly Occurrence[]; readonly detail: string }

export const planWords = (lang: Lang, p: PlanRow): string =>
  `${p.subscriptionId} · ${repeatWords(lang, `st_${p.state}`)} · ${repeatWords(lang, p.fulfilment)} ${p.locationId} · ${p.lines.length} ${repeatWords(lang, 'items')} · ${repeatWords(lang, 'from')} ${p.startsOn}${p.nextDays.length === 0 ? '' : ` · ${repeatWords(lang, 'next')} ${p.nextDays.join(', ')}`}`;
export const occurrenceWords = (lang: Lang, o: Occurrence): string => `${o.subscriptionId} · ${o.day} · ${repeatWords(lang, `o_${o.outcome}`)} — ${o.detail}`;

export const repeatOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => {
  if (out.result !== 'ok') return outcomeIn((k) => repeatWords(lang, k), out);
  const v = out.value as { placed?: number; notPlaced?: number; missed?: number };
  if (v.placed === 0 && v.notPlaced === 0 && v.missed === 0) return repeatWords(lang, 'nothingDue');
  return `${repeatWords(lang, 'ranNow')} ${v.placed ?? 0} · ${repeatWords(lang, 'notPlacedNow')} ${v.notPlaced ?? 0} · ${repeatWords(lang, 'missedNow')} ${v.missed ?? 0}`;
};

export interface RepeatOrdersSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly run: boolean };
  read(): Promise<Outcome<RepeatOrdersView, 'nobody' | 'cannotRead'>>;
  run(): Promise<Outcome<{ readonly placed: number; readonly notPlaced: number; readonly missed: number }, 'nobody' | 'cannotRun'>>;
}

export function createRepeatOrdersSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string;
}): RepeatOrdersSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('order.read'), run: named && held.has('order.exception.manage') };
  const call = makeCaller({ keyPrefix: 'repeat-orders', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  return {
    may,
    read: async () => (!named ? { result: 'invalid', why: 'nobody' } : !may.read ? { result: 'invalid', why: 'cannotRead' } : call('GET', '/v1/repeat-orders')),
    run: async () => (!named ? { result: 'invalid', why: 'nobody' } : !may.run ? { result: 'invalid', why: 'cannotRun' } : call('POST', '/v1/repeat-orders/run', {})),
  };
}
