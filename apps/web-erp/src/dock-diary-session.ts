// The Dock diary page (M07-FR-01 "ASN/direct-store-delivery, dock scheduling and receiving" · WF-04 · QG-02 · OB-288 P3).
// A tested, DOM-free session over head office's own dock diary (services/inventory/src/dock-diary.ts):
//   • READ — a store's day, door by door, with every booking still "booked" after its window ended listed as LATE;
//   • BOOK — a door for a window, for a supplier and its purchase orders; head office refuses an overlap by name;
//   • STATUS — arrived · completed · no-show · cancelled, each its own fact with who and when (a no-show or a cancellation
//     needs a reason for the supplier's record).
// Head office re-checks every permission and every rule; `may` only shapes what is offered. Nothing is read on open and
// nothing is written without a click. English and Tamil.

import { makeCaller, outcomeIn, newId, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const DOCK_DIARY_COPY = {
  en: {
    title: 'Dock diary', lead: 'Which supplier comes to which door, when — booked ahead, so two lorries never meet at one door. A booking still open after its time is shown as late.',
    store: 'Store', date: 'Day (YYYY-MM-DD)', show: 'Show the day', dayH: 'The day, door by door', none: 'No booking on this day.', lateH: 'Late — booked, time over, not arrived',
    noneLate: 'Nothing is late.', door: 'Door', from: 'From', until: 'Until', supplier: 'Supplier', orders: 'Purchase orders (comma between)', bookedBy: 'booked by',
    bookH: 'Book a door', book: 'Book the door', arrived: 'Arrived', completed: 'Unloaded — done', noShow: 'Did not come', cancel: 'Cancel', reason: 'Why (needed to cancel or mark a no-show)',
    s_booked: 'Booked', s_arrived: 'Arrived', s_completed: 'Done', s_no_show: 'Did not come', s_cancelled: 'Cancelled', late: 'Late',
    booked: 'Booked.', alreadyBooked: 'Already booked with the same details — nothing changed.', updated: 'Done — head office recorded it.',
    needStore: 'Type the store first.', needDate: 'Type the day as YYYY-MM-DD, or leave it empty for every day.', needBooking: 'Fill in the store, the door, the start and the end.',
    needReason: 'Write why first — the supplier\'s record keeps it.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot read the dock diary.', cannotBook: 'Your role cannot book a door.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved.',
  },
  ta: {
    title: 'டாக் நாட்குறிப்பு', lead: 'எந்த விநியோகஸ்தர் எந்த வாசலுக்கு, எப்போது — முன்பதிவு செய்யப்படுகிறது, அதனால் இரண்டு லாரிகள் ஒரே வாசலில் சந்திக்காது. நேரம் முடிந்தும் திறந்திருக்கும் முன்பதிவு தாமதமாகக் காட்டப்படும்.',
    store: 'கடை', date: 'நாள் (YYYY-MM-DD)', show: 'நாளைக் காட்டு', dayH: 'அந்த நாள், வாசல் வாரியாக', none: 'இந்த நாளில் முன்பதிவு இல்லை.', lateH: 'தாமதம் — முன்பதிவு, நேரம் முடிந்தது, வரவில்லை',
    noneLate: 'எதுவும் தாமதமில்லை.', door: 'வாசல்', from: 'முதல்', until: 'வரை', supplier: 'விநியோகஸ்தர்', orders: 'கொள்முதல் ஆணைகள் (காற்புள்ளியால் பிரிக்கவும்)', bookedBy: 'முன்பதிவு செய்தவர்',
    bookH: 'வாசலை முன்பதிவு செய்', book: 'வாசலை முன்பதிவு செய்', arrived: 'வந்தது', completed: 'இறக்கப்பட்டது — முடிந்தது', noShow: 'வரவில்லை', cancel: 'ரத்து செய்', reason: 'ஏன் (ரத்து செய்ய அல்லது வரவில்லை எனக் குறிக்கத் தேவை)',
    s_booked: 'முன்பதிவு', s_arrived: 'வந்தது', s_completed: 'முடிந்தது', s_no_show: 'வரவில்லை', s_cancelled: 'ரத்து', late: 'தாமதம்',
    booked: 'முன்பதிவு செய்யப்பட்டது.', alreadyBooked: 'அதே விவரங்களுடன் ஏற்கனவே முன்பதிவு உள்ளது — எதுவும் மாறவில்லை.', updated: 'முடிந்தது — தலைமை அலுவலகம் பதிவு செய்தது.',
    needStore: 'முதலில் கடையை உள்ளிடுங்கள்.', needDate: 'நாளை YYYY-MM-DD என உள்ளிடுங்கள், அல்லது எல்லா நாட்களுக்கும் காலியாக விடுங்கள்.', needBooking: 'கடை, வாசல், தொடக்கம், முடிவு ஆகியவற்றை நிரப்புங்கள்.',
    needReason: 'முதலில் காரணத்தை எழுதுங்கள் — விநியோகஸ்தரின் பதிவில் அது இருக்கும்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பணி டாக் நாட்குறிப்பைப் படிக்க முடியாது.', cannotBook: 'உங்கள் பணி வாசலை முன்பதிவு செய்ய முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கவோ சேமிக்கவோ இல்லை.',
  },
} as const;

export const dockDiaryWords = (lang: Lang, key: string): string =>
  (DOCK_DIARY_COPY[lang] as Record<string, string>)[key] ?? (DOCK_DIARY_COPY.en as Record<string, string>)[key] ?? key;
export const dockDiaryOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => {
  if (out.result !== 'ok') return outcomeIn((k) => dockDiaryWords(lang, k), out);
  const v = out.value as { alreadyBooked?: boolean; alreadySet?: boolean };
  return dockDiaryWords(lang, v.alreadyBooked === true ? 'alreadyBooked' : v.alreadyBooked === false ? 'booked' : 'updated');
};

export type DockStatus = 'booked' | 'arrived' | 'completed' | 'no_show' | 'cancelled';
export interface DockBooking {
  readonly slotId: string; readonly storeId: string; readonly dockId: string; readonly startsAt: string; readonly endsAt: string; readonly status: DockStatus;
  readonly supplierId?: string; readonly poIds?: readonly string[]; readonly bookedBy: string; readonly bookedAt: string;
  readonly history: readonly { readonly status: DockStatus; readonly by: string; readonly at: string; readonly reason?: string }[];
}
export interface DockDay {
  readonly storeId: string; readonly date: string | null; readonly bookings: readonly DockBooking[]; readonly count: number;
  readonly late: readonly { readonly slotId: string; readonly dockId: string; readonly supplierId: string | null; readonly endedAt: string }[]; readonly asAt: string;
}
export interface BookingForm { readonly storeId: string; readonly dockId: string; readonly startsAt: string; readonly endsAt: string; readonly supplierId: string; readonly poIds: string }

/** What a booking can become next, from head office's own rule: booked → arrived | no-show | cancelled; arrived → done. */
export const NEXT_STATUSES: Readonly<Record<DockStatus, readonly DockStatus[]>> = Object.freeze({
  booked: ['arrived', 'no_show', 'cancelled'], arrived: ['completed'], completed: [], no_show: [], cancelled: [],
});

/** A typed local date-time (`2026-10-26T10:30`, the form's value) as an instant; null when it is not one. */
export function instantOf(local: string): string | null {
  const v = local.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export interface DockDiarySession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly book: boolean };
  day(storeId: string, date: string): Promise<Outcome<DockDay, 'nobody' | 'cannotRead' | 'needStore' | 'needDate'>>;
  book(form: BookingForm): Promise<Outcome<{ readonly booking: DockBooking; readonly alreadyBooked: boolean }, 'nobody' | 'cannotBook' | 'needBooking'>>;
  setStatus(slotId: string, status: Exclude<DockStatus, 'booked'>, reason: string): Promise<Outcome<{ readonly booking: DockBooking; readonly alreadySet: boolean }, 'nobody' | 'cannotBook' | 'needReason'>>;
}

export function createDockDiarySession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string; readonly newSlotId?: () => string }): DockDiarySession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('inventory.availability.read'), book: named && held.has('inventory.movement.append') };
  const call = makeCaller({ keyPrefix: 'dock-diary', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const slotIdOf = input.newSlotId ?? (() => newId('slot'));
  return {
    may,
    day: async (storeId, date) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      if (!may.read) return { result: 'invalid', why: 'cannotRead' };
      if (storeId.trim() === '') return { result: 'invalid', why: 'needStore' };
      const d = date.trim();
      if (d !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return { result: 'invalid', why: 'needDate' };
      const q = new URLSearchParams({ storeId: storeId.trim(), ...(d === '' ? {} : { date: d }) }).toString();
      return call<DockDay>('GET', `/v1/inventory/dock-diary?${q}`);
    },
    book: async (f) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      if (!may.book) return { result: 'invalid', why: 'cannotBook' };
      const startsAt = instantOf(f.startsAt);
      const endsAt = instantOf(f.endsAt);
      if (f.storeId.trim() === '' || f.dockId.trim() === '' || startsAt === null || endsAt === null) return { result: 'invalid', why: 'needBooking' };
      const poIds = f.poIds.split(',').map((p) => p.trim()).filter((p) => p !== '');
      return call('POST', `/v1/inventory/dock-diary/${encodeURIComponent(slotIdOf())}`, {
        storeId: f.storeId.trim(), dockId: f.dockId.trim(), startsAt, endsAt,
        ...(f.supplierId.trim() === '' ? {} : { supplierId: f.supplierId.trim() }), ...(poIds.length === 0 ? {} : { poIds }),
      });
    },
    setStatus: async (slotId, status, reason) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      if (!may.book) return { result: 'invalid', why: 'cannotBook' };
      if ((status === 'no_show' || status === 'cancelled') && reason.trim() === '') return { result: 'invalid', why: 'needReason' };
      return call('POST', `/v1/inventory/dock-diary/${encodeURIComponent(slotId)}/status`, { status, ...(reason.trim() === '' ? {} : { reason: reason.trim() }) });
    },
  };
}
