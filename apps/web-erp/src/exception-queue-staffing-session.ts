// "Who works each queue" on the Delivery exceptions page — the tested, DOM-free model (OB-676 "A", owner, 2 Nov 2026, in
// writing · M19-FR-01 · Item 2 · P-03 · P-05 · P-08).
//
// The roles that staff each delivery-exception queue were a fixed map in code. Now the owner sets them per queue and confirms
// them here: the code's map is offered as the starting suggestion and reads "not confirmed" until he confirms it; a queue
// with no role is shown as UNOWNED (its exceptions stay listed and still escalate) — never silently dropped. Asked of head
// office on a click (`GET/POST /v1/orders/exception-queue-staffing`); nothing is read or written on open. Head office
// re-checks the owner's right and that each role named may work exceptions at all.

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';
import type { Lang } from '../../../packages/ui/src/index';

export type StaffedQueue = 'fulfilment_supervisor' | 'customer_service_desk' | 'finance_recon_queue' | 'duty_manager';
export const STAFFED_QUEUES: readonly StaffedQueue[] = ['fulfilment_supervisor', 'customer_service_desk', 'finance_recon_queue', 'duty_manager'];
export type Staffing = Readonly<Record<StaffedQueue, readonly string[]>>;

export interface StaffingRead {
  readonly state: 'confirmed' | 'not_confirmed';
  readonly staffing: Staffing;
  readonly suggested: Staffing;
  readonly confirmed: { readonly version: number; readonly by: string; readonly at: string } | null;
  readonly unowned: readonly StaffedQueue[];
  readonly history: readonly { readonly version: number; readonly staffing: Staffing; readonly asSuggested: boolean; readonly reason: string | null; readonly by: string; readonly at: string }[];
  readonly rolesThatMayWork: readonly string[];
}

export const STAFFING_COPY = {
  en: {
    h: 'Who works each queue', show: 'Show who works each queue', confirm: 'Confirm these roles', noteL: 'Note (optional)',
    lead: 'The owner sets which roles work each delivery-exception queue. Until he confirms, the queues run on the starting suggestion. A queue with no role is unowned — its exceptions stay on the list and still go up to the duty manager.',
    q_fulfilment_supervisor: 'Fulfilment supervisor', q_customer_service_desk: 'Customer service desk', q_finance_recon_queue: 'Finance reconciliation', q_duty_manager: 'Duty manager',
    r_owner: 'Owner', r_store_manager: 'Store manager', r_accountant: 'Accountant', r_cashier: 'Cashier (service desk)',
    st_confirmed: 'Confirmed by the owner', st_not_confirmed: 'NOT CONFIRMED by the owner — the queues run on the starting suggestion until he confirms',
    unowned: 'UNOWNED — no role works this queue', unownedSummary: 'Unowned queues:', by: 'confirmed by', version: 'version', historyH: 'Every confirmation',
    asSuggested: 'the starting suggestion, as offered', changed: 'changed from the suggestion', confirmedNow: 'Confirmed —',
    nobody: 'Nobody is signed in on this screen — you can read nothing.', cannotRead: 'Your role cannot read delivery exceptions.', cannotSet: 'Only the owner sets who works each queue.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or changed.',
  },
  ta: {
    h: 'ஒவ்வொரு வரிசையையும் யார் கையாளுகிறார்', show: 'யார் கையாளுகிறார் எனக் காட்டு', confirm: 'இந்தப் பங்குகளை உறுதிசெய்', noteL: 'குறிப்பு (விருப்பம்)',
    lead: 'ஒவ்வொரு டெலிவரி விதிவிலக்கு வரிசையையும் எந்தப் பங்குகள் கையாளும் என்பதை உரிமையாளர் அமைக்கிறார். அவர் உறுதிசெய்யும் வரை தொடக்கப் பரிந்துரையின்படி வரிசைகள் இயங்கும். பங்கு இல்லாத வரிசைக்கு உரிமையாளர் இல்லை — அதன் விதிவிலக்குகள் பட்டியலிலேயே இருக்கும், பணி மேலாளருக்குச் செல்லும்.',
    q_fulfilment_supervisor: 'நிறைவேற்று மேற்பார்வையாளர்', q_customer_service_desk: 'வாடிக்கையாளர் சேவை மேசை', q_finance_recon_queue: 'நிதி சரிபார்ப்பு', q_duty_manager: 'பணி மேலாளர்',
    r_owner: 'உரிமையாளர்', r_store_manager: 'கடை மேலாளர்', r_accountant: 'கணக்காளர்', r_cashier: 'காசாளர் (சேவை மேசை)',
    st_confirmed: 'உரிமையாளர் உறுதிசெய்தார்', st_not_confirmed: 'உரிமையாளர் உறுதிசெய்யவில்லை — அவர் உறுதிசெய்யும் வரை தொடக்கப் பரிந்துரையின்படி வரிசைகள் இயங்கும்',
    unowned: 'உரிமையாளர் இல்லை — எந்தப் பங்கும் இந்த வரிசையைக் கையாளவில்லை', unownedSummary: 'உரிமையாளர் இல்லாத வரிசைகள்:', by: 'உறுதிசெய்தவர்', version: 'பதிப்பு', historyH: 'ஒவ்வொரு உறுதிப்படுத்தலும்',
    asSuggested: 'தொடக்கப் பரிந்துரை, அப்படியே', changed: 'பரிந்துரையிலிருந்து மாற்றப்பட்டது', confirmedNow: 'உறுதிசெய்யப்பட்டது —',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்க முடியாது.', cannotRead: 'உங்கள் பங்கு டெலிவரி விதிவிலக்குகளைப் படிக்க முடியாது.', cannotSet: 'ஒவ்வொரு வரிசையையும் யார் கையாளுவார் என்பதை உரிமையாளர் மட்டுமே அமைப்பார்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை, மாற்றப்படவில்லை.',
  },
} as const;

export const staffingWords = (lang: Lang, key: string): string => (STAFFING_COPY[lang] as Record<string, string>)[key] ?? (STAFFING_COPY.en as Record<string, string>)[key] ?? key;
/** A role in words — a role with no words is shown by its id, never hidden. */
export const roleWords = (lang: Lang, role: string): string => { const w = staffingWords(lang, `r_${role}`); return w === `r_${role}` ? role.replace(/_/g, ' ') : w; };
export const staffingOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => staffingWords(lang, k), out);

/** One queue's row: its name, the roles in words (or UNOWNED), and whether it is unowned. Pure. */
export function queueRows(lang: Lang, r: StaffingRead): readonly { readonly queue: StaffedQueue; readonly name: string; readonly roles: readonly string[]; readonly words: string; readonly unowned: boolean }[] {
  return STAFFED_QUEUES.map((q) => {
    const roles = r.staffing[q] ?? [];
    return { queue: q, name: staffingWords(lang, `q_${q}`), roles, unowned: roles.length === 0, words: roles.length === 0 ? staffingWords(lang, 'unowned') : roles.map((x) => roleWords(lang, x)).join(', ') };
  });
}

export interface StaffingSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly set: boolean };
  read(): Promise<Outcome<StaffingRead>>;
  /** The owner confirms: for each queue the roles ticked (an empty list leaves it unowned). */
  setStaffing(staffing: Staffing, note: string): Promise<Outcome<StaffingRead>>;
}

export function createStaffingSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string;
}): StaffingSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('order.read'), set: named && held.has('order.exception.staffing.set') };
  const call = makeCaller({ keyPrefix: 'queue-staffing', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  return {
    may,
    read: async () => (!named ? { result: 'invalid', why: 'nobody' } : !may.read ? { result: 'invalid', why: 'cannotRead' } : call<StaffingRead>('GET', '/v1/orders/exception-queue-staffing')),
    setStaffing: async (staffing, note) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      if (!may.set) return { result: 'invalid', why: 'cannotSet' };
      const body = { staffing: Object.fromEntries(STAFFED_QUEUES.map((q) => [q, [...new Set(staffing[q] ?? [])].sort()])), ...(note.trim() === '' ? {} : { reason: note.trim() }) };
      return call<StaffingRead>('POST', '/v1/orders/exception-queue-staffing', body);
    },
  };
}
