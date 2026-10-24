// The write-off capture page's line-down parts (M28-FR-01 · M28.md "Offline (§31): queued; approval on sync" · audit-4 ·
// OB-288 LP/workforce package). Two DOM-free, tested pieces:
//
//   • the QUEUE, served by the store computer: a person who handles stock saves a loss on this screen when head office
//     cannot be reached — what, where, how many, the kind of loss and why (chosen from the closed lists, never typed or
//     defaulted), a photo reference. The store computer carries it to head office, which values it with its own cost,
//     records a small one, and holds a big one (evidence required) for a SECOND person. Nothing is valued or decided here.
//   • the SECOND PERSON's list, from head office: the captured losses waiting for approval, approved or rejected with a
//     reason by somebody who is not the raiser (head office refuses the raiser by name, §28).

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';
import type { SyncOutbox } from '../../../packages/sync/src/outbox';
import { WASTE_REASON_CODES } from '../../../packages/waste/src/reasons';
import { createBoxQueue, STATE_KEYS, type BoxQueue } from './lpw-box-queue';

export type Lang = 'en' | 'ta';
export const LOSS_TYPES = ['wastage', 'damage', 'expiry', 'donation', 'destruction'] as const;

export const WRITE_OFF_QUEUE_COPY = {
  en: {
    queueH: 'Line down? Save the loss on this screen', queueLead: 'Head office cannot be reached. Save the loss here; the store computer carries it to head office, which values it. A big loss waits there for a second person.',
    product: 'Product', location: 'Where', qty: 'How many', uom: 'Unit', lossType: 'Kind of loss', reason: 'Why it is lost', evidence: 'Photo reference (needed for a big loss)', choose: '— choose —', save: 'Save the loss here',
    wastage: 'Wastage', damage: 'Damage', expiry: 'Expiry', donation: 'Donation', destruction: 'Destruction', shrinkage: 'Shrinkage', preparation: 'Preparation', customer_return: 'Customer return', recall: 'Recall',
    savedH: 'Saved on this screen', noneSaved: 'Nothing saved on this screen.',
    stSavedHere: 'Saved on this screen', stRetrying: 'Trying to reach the store computer', stHanded: 'With the store computer', stPosted: 'Booked at head office', stRefused: 'Refused — a person must look',
    pendingH: 'Losses waiting for a second person', pendingNone: 'No captured loss is waiting.', raisedBy: 'raised by', value: 'head office value', approve: 'Approve', reject: 'Reject', why: 'Your reason (required)', posted: 'Recorded', awaiting_approval: 'Waiting for a second person', rejected: 'Rejected',
    needFields: 'Fill in the product, where, a whole number, the unit, and choose the kind of loss and why.', needReason: 'Write your reason first.', nobody: 'Nobody is signed in on this screen.', mayNot: 'Your role does not record losses.',
    saved: 'Saved.', refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved.',
  },
  ta: {
    queueH: 'இணைப்பு இல்லையா? இழப்பை இந்தத் திரையில் சேமியுங்கள்', queueLead: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை. இழப்பை இங்கே சேமியுங்கள்; கடைக் கணினி அதைத் தலைமை அலுவலகத்திற்குக் கொண்டு செல்லும், அங்கே மதிப்பிடப்படும். பெரிய இழப்பு இரண்டாவது நபருக்காகக் காத்திருக்கும்.',
    product: 'பொருள்', location: 'எங்கே', qty: 'எத்தனை', uom: 'அலகு', lossType: 'இழப்பின் வகை', reason: 'ஏன் இழப்பு', evidence: 'புகைப்படக் குறிப்பு (பெரிய இழப்புக்குத் தேவை)', choose: '— தேர்ந்தெடுக்கவும் —', save: 'இழப்பை இங்கே சேமி',
    wastage: 'வீணானது', damage: 'சேதம்', expiry: 'காலாவதி', donation: 'நன்கொடை', destruction: 'அழிப்பு', shrinkage: 'குறைவு', preparation: 'தயாரிப்பு', customer_return: 'வாடிக்கையாளர் திருப்பம்', recall: 'திரும்பப் பெறுதல்',
    savedH: 'இந்தத் திரையில் சேமிக்கப்பட்டவை', noneSaved: 'இந்தத் திரையில் எதுவும் சேமிக்கப்படவில்லை.',
    stSavedHere: 'இந்தத் திரையில் சேமிக்கப்பட்டது', stRetrying: 'கடைக் கணினியை அடைய முயல்கிறது', stHanded: 'கடைக் கணினியிடம் உள்ளது', stPosted: 'தலைமை அலுவலகத்தில் பதிவானது', stRefused: 'மறுக்கப்பட்டது — ஒருவர் பார்க்க வேண்டும்',
    pendingH: 'இரண்டாவது நபருக்காகக் காத்திருக்கும் இழப்புகள்', pendingNone: 'காத்திருக்கும் இழப்பு எதுவும் இல்லை.', raisedBy: 'பதிந்தவர்', value: 'தலைமை அலுவலக மதிப்பு', approve: 'ஒப்புதல்', reject: 'நிராகரி', why: 'உங்கள் காரணம் (தேவை)', posted: 'பதிவானது', awaiting_approval: 'இரண்டாவது நபருக்காகக் காத்திருக்கிறது', rejected: 'நிராகரிக்கப்பட்டது',
    needFields: 'பொருள், இடம், முழு எண், அலகு ஆகியவற்றை நிரப்பி, இழப்பின் வகையையும் காரணத்தையும் தேர்ந்தெடுக்கவும்.', needReason: 'முதலில் உங்கள் காரணத்தை எழுதவும்.', nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', mayNot: 'உங்கள் பணி இழப்புகளைப் பதிவதில்லை.',
    saved: 'சேமிக்கப்பட்டது.', refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கவோ சேமிக்கவோ இல்லை.',
  },
} as const;

export const writeOffQueueWords = (lang: Lang, key: string): string =>
  (WRITE_OFF_QUEUE_COPY[lang] as Record<string, string>)[key] ?? (WRITE_OFF_QUEUE_COPY.en as Record<string, string>)[key] ?? key;
export const writeOffQueueOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => (out.result === 'ok' ? writeOffQueueWords(lang, 'saved') : outcomeIn((k) => writeOffQueueWords(lang, k), out));

export interface CapturedPayload extends Record<string, unknown> {
  readonly writeOffId: string; readonly productId: string; readonly locationId: string; readonly qty: number; readonly uom: string;
  readonly lossType: (typeof LOSS_TYPES)[number]; readonly reasonCode: string; readonly evidenceRef?: string; readonly raisedBy: string; readonly capturedAt: string; readonly storeId: string;
}
export const WRITE_OFF_CAPTURED = 'WriteOffCaptured';

export interface WriteOffQueue {
  readonly canCapture: boolean;
  readonly lossTypes: readonly string[];
  readonly reasons: readonly string[];
  save(lang: Lang, input: { readonly productId: string; readonly locationId: string; readonly qty: string; readonly uom: string; readonly lossType: string; readonly reasonCode: string; readonly evidenceRef: string }): { readonly ok: true; readonly writeOffId: string } | { readonly ok: false; readonly words: string };
  saved(lang: Lang): readonly { readonly writeOffId: string; readonly words: string; readonly state: string; readonly reason?: string }[];
  text(lang: Lang, key: string): string;
  readonly queue: BoxQueue<CapturedPayload>;
}

export function createWriteOffQueue(who: { readonly userId: string | null; readonly storeId: string; readonly permissions: readonly string[]; readonly now: () => string; readonly newId?: () => string }, outbox: SyncOutbox): WriteOffQueue {
  const queue = createBoxQueue<CapturedPayload>(WRITE_OFF_CAPTURED, 'web-erp/write-off-capture', outbox);
  const canCapture = who.userId !== null && who.permissions.includes('inventory.movement.append');
  const newId = who.newId ?? (() => `WO-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const w = writeOffQueueWords;
  return {
    canCapture, queue, text: w, lossTypes: LOSS_TYPES, reasons: WASTE_REASON_CODES,
    save: (lang, i) => {
      if (who.userId === null) return { ok: false, words: w(lang, 'nobody') };
      if (!canCapture) return { ok: false, words: w(lang, 'mayNot') };
      const qty = Number(i.qty);
      if (i.productId.trim() === '' || i.locationId.trim() === '' || i.uom.trim() === '' || !Number.isInteger(qty) || qty < 1
        || !(LOSS_TYPES as readonly string[]).includes(i.lossType) || !(WASTE_REASON_CODES as readonly string[]).includes(i.reasonCode)) return { ok: false, words: w(lang, 'needFields') };
      const writeOffId = newId();
      const at = who.now();
      queue.enqueue(writeOffId, {
        writeOffId, productId: i.productId.trim(), locationId: i.locationId.trim(), qty, uom: i.uom.trim(), lossType: i.lossType as CapturedPayload['lossType'], reasonCode: i.reasonCode,
        ...(i.evidenceRef.trim() === '' ? {} : { evidenceRef: i.evidenceRef.trim() }), raisedBy: who.userId, capturedAt: at, storeId: who.storeId,
      }, at);
      return { ok: true, writeOffId };
    },
    saved: (lang) => queue.items().map((it) => ({
      writeOffId: it.key, state: it.state, ...(it.reason === undefined ? {} : { reason: it.reason }),
      words: `${it.payload.productId} × ${it.payload.qty} ${it.payload.uom} · ${w(lang, it.payload.lossType)} · ${w(lang, it.payload.reasonCode)} · ${w(lang, STATE_KEYS[it.state])}`,
    })),
  };
}

export interface CaptureRow { readonly at: string; readonly state: 'posted' | 'awaiting_approval' | 'rejected'; readonly loss: CapturedPayload; readonly valueMinor?: number | null; readonly decidedBy?: string; readonly decisionReason?: string }
export interface WriteOffDecideSession {
  readonly may: { readonly read: boolean; readonly decide: boolean };
  pending(): Promise<Outcome<{ readonly captures: readonly CaptureRow[]; readonly awaitingApproval: number }>>;
  decide(writeOffId: string, decision: 'approved' | 'rejected', reason: string): Promise<Outcome<unknown, 'needReason'>>;
}
export function createWriteOffDecideSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string }): WriteOffDecideSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const call = makeCaller({ keyPrefix: 'wo-decide', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  return {
    may: { read: named && held.has('waste.view'), decide: named && held.has('inventory.movement.append') },
    pending: () => call('GET', '/v1/inventory/write-off-captures'),
    decide: async (writeOffId, decision, reason) => {
      if (reason.trim() === '') return { result: 'invalid', why: 'needReason' };
      return call('POST', `/v1/inventory/write-off-captures/${encodeURIComponent(writeOffId)}/decide`, { decision, reason: reason.trim() });
    },
  };
}
