// "Clock in / clock out" on the self-service page the store computer serves — Round 7 · OB-507 (M25-FR-01 "attendance cache,
// sync on reconnect" · §31 · P-01 · P-08 · hard rules #2 #6 #10). A tested, DOM-free model; ess.js only draws it.
//
// A person marks their OWN attendance (in or out), signed in at the store computer. The mark is written to THIS device's
// durable queue before the page says "saved", handed to the store computer (which keeps it on its own disk, fsync'd, across
// a restart) and carried to head office once the line is up — one mark, once: its id is made here and travels with it, so a
// re-send is the same mark (§31.1). Head office re-checks the person and their store, books it, and flags a mark out of
// order (two "in"s); a mark it cannot accept (a different mark under the same id, a person not at this store) comes back
// REFUSED with its reason, shown here and never dropped. Nobody marks for anybody else. PIN method only — no fingerprint
// at the store computer (C21's consent rule lives at head office).

import type { SyncOutbox } from '../../../packages/sync/src/outbox';
import type { BoxItemStatus } from '../../../packages/sync/src/device-relay';
import { createBoxQueue, STATE_KEYS, type BoxQueue } from './lpw-box-queue';

export const ATTENDANCE_MARKED = 'AttendanceMarked';
export const ATTENDANCE_SOURCE = 'web-erp/ess';
export const attendanceKeyFor = (markId: string): string => `attendance:${markId}`;
/** The right a person needs to mark their own attendance (head office re-checks it from their own grants). */
export const ATTENDANCE_PERMISSION = 'workforce.attendance.mark';

export type Lang = 'en' | 'ta';

export const ATTENDANCE_COPY = {
  en: {
    title: 'My attendance', lead: 'Mark when you start and finish. It is saved on this store computer at once, and reaches head office when the line is up.',
    clockIn: 'I am starting work (in)', clockOut: 'I am finishing work (out)', in: 'In', out: 'Out',
    none: 'No marks made on this screen yet.', saved: 'Saved on this store computer.', nobody: 'Nobody is signed in on this screen — sign in to mark your attendance.',
    noStore: 'This store computer has not said which store it is, so nothing was saved.', notAllowed: 'You do not have the right to mark attendance here — ask your manager.',
    notOnBox: 'Marking attendance here works only on the store computer.',
    stSavedHere: 'Saved on this screen', stRetrying: 'Trying to reach the store computer', stHanded: 'With the store computer', stPosted: 'Booked at head office', stRefused: 'Refused — a manager must look',
  },
  ta: {
    title: 'எனது வருகை', lead: 'நீங்கள் வேலையைத் தொடங்கும்போதும் முடிக்கும்போதும் பதியுங்கள். இது உடனே இந்தக் கடைக் கணினியில் சேமிக்கப்படும்; இணைப்பு வந்ததும் தலைமை அலுவலகத்தை அடையும்.',
    clockIn: 'வேலையைத் தொடங்குகிறேன் (உள்ளே)', clockOut: 'வேலையை முடிக்கிறேன் (வெளியே)', in: 'உள்ளே', out: 'வெளியே',
    none: 'இந்தத் திரையில் இன்னும் பதிவு இல்லை.', saved: 'இந்தக் கடைக் கணினியில் சேமிக்கப்பட்டது.', nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — உங்கள் வருகையைப் பதிய உள்நுழையவும்.',
    noStore: 'இது எந்தக் கடை என்று கடைக் கணினி சொல்லவில்லை; எதுவும் சேமிக்கப்படவில்லை.', notAllowed: 'இங்கு வருகையைப் பதிய உங்களுக்கு அனுமதி இல்லை — உங்கள் மேலாளரிடம் கேளுங்கள்.',
    notOnBox: 'இங்கு வருகையைப் பதிவது கடைக் கணினியில் மட்டுமே.',
    stSavedHere: 'இந்தத் திரையில் சேமிக்கப்பட்டது', stRetrying: 'கடைக் கணினியை அடைய முயல்கிறது', stHanded: 'கடைக் கணினியிடம் உள்ளது', stPosted: 'தலைமை அலுவலகத்தில் பதிவானது', stRefused: 'மறுக்கப்பட்டது — மேலாளர் பார்க்க வேண்டும்',
  },
} as const;

export const attendanceWords = (lang: Lang, key: string): string =>
  (ATTENDANCE_COPY[lang] as Record<string, string>)[key] ?? (ATTENDANCE_COPY.en as Record<string, string>)[key] ?? key;

export interface AttendancePayload extends Record<string, unknown> {
  readonly markId: string; readonly employeeId: string; readonly kind: 'in' | 'out'; readonly method: 'pin';
  readonly at: string; readonly storeId: string; readonly source: string;
}

export interface ShownMark { readonly markId: string; readonly kind: 'in' | 'out'; readonly at: string; readonly state: string; readonly stateWord: string; readonly reason?: string }

export type MarkOutcome = { readonly outcome: 'saved'; readonly markId: string } | { readonly outcome: 'nobody' | 'no_store' | 'not_allowed' };

export interface AttendanceQueue {
  /** Whether the person on this screen may mark (named, a store known, and the right held). */
  readonly may: boolean;
  mark(kind: 'in' | 'out'): MarkOutcome;
  /** This person's marks made on this device, newest first, each with where it has got to (the five shared words). */
  marks(lang: Lang): readonly ShownMark[];
  /** The kind of the person's last mark here, so the page can offer the other one first (undefined when none). */
  lastKind(): 'in' | 'out' | undefined;
  readonly queue: BoxQueue<AttendancePayload>;
}

let counter = 0;
const defaultFreshId = (): string => {
  const uuid = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID?.();
  counter += 1;
  return uuid === undefined ? `att-${Date.now()}-${counter}` : `att-${uuid}`;
};

export function createAttendanceQueue(
  config: { readonly userId: string | null; readonly storeId: string | null; readonly permissions: readonly string[]; readonly now: () => string; readonly freshId?: () => string },
  outbox: SyncOutbox,
  boxWords: Map<string, BoxItemStatus> = new Map(),
): AttendanceQueue {
  const queue = createBoxQueue<AttendancePayload>(ATTENDANCE_MARKED, ATTENDANCE_SOURCE, outbox, boxWords);
  const freshId = config.freshId ?? defaultFreshId;
  const may = config.userId !== null && config.storeId !== null && config.permissions.includes(ATTENDANCE_PERMISSION);
  const mine = () => queue.items().filter((i) => i.payload.employeeId === config.userId)
    .sort((a, b) => b.payload.at.localeCompare(a.payload.at) || b.key.localeCompare(a.key));
  return {
    may,
    queue,
    mark: (kind) => {
      if (config.userId === null) return { outcome: 'nobody' };
      if (config.storeId === null) return { outcome: 'no_store' };
      if (!config.permissions.includes(ATTENDANCE_PERMISSION)) return { outcome: 'not_allowed' };
      const markId = freshId();
      const at = config.now();
      queue.enqueue(attendanceKeyFor(markId), { markId, employeeId: config.userId, kind, method: 'pin', at, storeId: config.storeId, source: 'self-service-screen' }, at);
      return { outcome: 'saved', markId };
    },
    marks: (lang) => mine().map((i) => ({
      markId: i.payload.markId, kind: i.payload.kind, at: i.payload.at, state: i.state, stateWord: attendanceWords(lang, STATE_KEYS[i.state]),
      ...(i.reason === undefined ? {} : { reason: i.reason }),
    })),
    lastKind: () => mine().find((i) => i.state !== 'refused')?.payload.kind,
  };
}
