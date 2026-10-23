// The facilities screen's FOOD-SAFETY CHECKS through the store computer — OB-288 lane 2 · P2 (M10-FR-02 "evidence captured
// offline; queued" · D-6 · §31 · P-01 · P-08 · hard rules #6 #10).
//
// The chiller is checked when it is due, whatever the line is doing. Served by the store computer, the facilities screen
// works out today's slots ITSELF from head office's checks in force (the same `foodSafetyStatus` engine head office runs),
// marks the ones head office last said were done, and the ones THIS screen has saved since; a check is recorded with the
// same engine's rules first (a reading against the limits, every item answered, a corrective action on any failure — the
// screen refuses what head office would refuse, before anything is saved) and written to this device's durable queue, then
// handed to the store computer, which carries it to head office timed by WHEN IT WAS DONE (so a slow line never makes it
// "late"). What head office cannot accept — a slot somebody else recorded — comes back refused, with its reason, shown.
// DOM-free and tested; English and Tamil for every word; the shell renders what this hands over.

import { translator, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { SyncOutbox } from '../../../packages/sync/src/outbox';
import { deviceItemState, deviceItemReason, type BoxItemStatus, type DeviceItemState } from '../../../packages/sync/src/device-relay';
import { foodSafetyStatus, assessCheckRecord, type FoodSafetyCheck, type FoodSafetyCheckRecord, type ItemResult } from '../../../packages/facilities/src/food-safety';

export const FOOD_SAFETY_CHECK_RECORDED = 'FoodSafetyCheckRecorded';
export const foodSafetyKeyFor = (recordId: string): string => `food-safety:${recordId}`;
const DAY_MS = 86_400_000;

/** Head office's word on the store's checks, as the store computer last heard it (`facilitiesData.foodSafety`). */
export interface HeldFoodSafety {
  readonly asAt: string;
  readonly ageMinutes: number;
  readonly checks: readonly FoodSafetyCheck[];
  readonly slots: readonly { readonly checkId: string; readonly slotDueAt: string; readonly state: string; readonly performedBy?: string }[];
}

export type CopyKey =
  | 'fsHeading' | 'fsLead' | 'fsAsOf' | 'fsNotKnown' | 'fsNone' | 'fsDue' | 'fsMissed' | 'fsDoneHo' | 'fsSavedHere' | 'fsUpcoming'
  | 'fsReading' | 'fsPass' | 'fsFail' | 'fsAction' | 'fsSave' | 'fsSaved' | 'fsNobody' | 'fsNoStore' | 'fsBadReading'
  | 'stSavedHere' | 'stRetrying' | 'stHanded' | 'stPosted' | 'stRefused'
  | RefusalKey;
type RefusalKey = 'rf_not_a_slot' | 'rf_slot_not_yet_open' | 'rf_needs_a_delivery' | 'rf_reading_required' | 'rf_items_incomplete' | 'rf_corrective_action_required';

export const FOOD_SAFETY_COPY: BilingualCopy<CopyKey> = {
  en: {
    fsHeading: 'Food-safety checks today', fsLead: 'Each check is done when it is due — the store computer carries it to head office, timed by when you did it, even with the line down.',
    fsAsOf: 'Head office\'s checks as the store computer last heard them, at', fsNotKnown: 'The store computer has not been told this store\'s food-safety checks yet.', fsNone: 'No food-safety check is due today.',
    fsDue: 'Due now', fsMissed: 'Missed — do it now', fsDoneHo: 'Done (head office has it)', fsSavedHere: 'Done — saved on this screen', fsUpcoming: 'Later today',
    fsReading: 'Reading (°C)', fsPass: 'Pass', fsFail: 'Fail', fsAction: 'What was done about it', fsSave: 'Save the check',
    fsSaved: 'Check saved on this screen — the store computer carries it to head office.', fsNobody: 'This store computer has not been told who is using this screen — a check carries a name.',
    fsNoStore: 'This store computer has not said which store this is, so nothing can be saved.', fsBadReading: 'The reading is a temperature, e.g. 4 or 3.5.',
    stSavedHere: 'Saved on this screen', stRetrying: 'Trying to reach the store computer', stHanded: 'With the store computer', stPosted: 'Booked at head office', stRefused: 'Refused — a person must look',
    rf_not_a_slot: 'That is not a time this check is scheduled for.', rf_slot_not_yet_open: 'This check is not due yet.',
    rf_needs_a_delivery: 'Say which delivery this checklist is for.', rf_reading_required: 'Type the reading — for a temperature check the reading is the record.',
    rf_items_incomplete: 'Tick every item pass or fail before saving.', rf_corrective_action_required: 'The check failed — write down what was done about it. A failed check with nothing done is not saved.',
  },
  ta: {
    fsHeading: 'இன்றைய உணவுப் பாதுகாப்புச் சோதனைகள்', fsLead: 'ஒவ்வொரு சோதனையும் உரிய நேரத்தில் செய்யப்படுகிறது — இணைப்பு இல்லாவிட்டாலும், நீங்கள் செய்த நேரத்துடன் கடைக் கணினி அதைத் தலைமை அலுவலகத்திற்குக் கொண்டு செல்லும்.',
    fsAsOf: 'கடைக் கணினி கடைசியாகக் கேட்ட தலைமை அலுவலகச் சோதனைகள், நேரம்', fsNotKnown: 'இந்தக் கடையின் உணவுப் பாதுகாப்புச் சோதனைகள் இன்னும் கடைக் கணினிக்குச் சொல்லப்படவில்லை.', fsNone: 'இன்று எந்த உணவுப் பாதுகாப்புச் சோதனையும் இல்லை.',
    fsDue: 'இப்போது செய்ய வேண்டும்', fsMissed: 'தவறவிட்டது — இப்போதே செய்யுங்கள்', fsDoneHo: 'செய்யப்பட்டது (தலைமை அலுவலகத்திடம் உள்ளது)', fsSavedHere: 'செய்யப்பட்டது — இந்தத் திரையில் சேமிக்கப்பட்டது', fsUpcoming: 'இன்று பின்னர்',
    fsReading: 'அளவீடு (°C)', fsPass: 'சரி', fsFail: 'தோல்வி', fsAction: 'அதற்கு என்ன செய்யப்பட்டது', fsSave: 'சோதனையைச் சேமி',
    fsSaved: 'சோதனை இந்தத் திரையில் சேமிக்கப்பட்டது — கடைக் கணினி அதைத் தலைமை அலுவலகத்திற்குக் கொண்டு செல்லும்.', fsNobody: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை — சோதனையில் பெயர் இருக்கும்.',
    fsNoStore: 'இது எந்தக் கடை என்று கடைக் கணினி சொல்லவில்லை, அதனால் எதுவும் சேமிக்க முடியாது.', fsBadReading: 'அளவீடு ஒரு வெப்பநிலை, எ.கா. 4 அல்லது 3.5.',
    stSavedHere: 'இந்தத் திரையில் சேமிக்கப்பட்டது', stRetrying: 'கடைக் கணினியை அடைய முயல்கிறது', stHanded: 'கடைக் கணினியிடம் உள்ளது', stPosted: 'தலைமை அலுவலகத்தில் பதிவானது', stRefused: 'மறுக்கப்பட்டது — ஒருவர் பார்க்க வேண்டும்',
    rf_not_a_slot: 'இந்தச் சோதனைக்கு இது திட்டமிட்ட நேரம் அல்ல.', rf_slot_not_yet_open: 'இந்தச் சோதனைக்கு இன்னும் நேரம் வரவில்லை.',
    rf_needs_a_delivery: 'இந்தச் சரிபார்ப்புப் பட்டியல் எந்த விநியோகத்திற்கு என்று சொல்லுங்கள்.', rf_reading_required: 'அளவீட்டைத் தட்டச்சு செய்யுங்கள் — வெப்பநிலைச் சோதனையில் அளவீடே பதிவு.',
    rf_items_incomplete: 'சேமிக்கும் முன் ஒவ்வொரு உருப்படியையும் சரி அல்லது தோல்வி எனக் குறியிடுங்கள்.', rf_corrective_action_required: 'சோதனை தோல்வியடைந்தது — அதற்கு என்ன செய்யப்பட்டது என்று எழுதுங்கள். எதுவும் செய்யப்படாத தோல்விச் சோதனை சேமிக்கப்படாது.',
  },
};

/** One slot as the screen shows it. */
export interface FoodSafetySlotRow {
  readonly checkId: string;
  readonly title: string;
  readonly kind: string;
  readonly slotDueAt: string;
  readonly state: 'due' | 'missed' | 'done_ho' | 'saved_here' | 'upcoming';
  readonly stateWord: string;
  readonly icon: string;
  readonly canRecord: boolean;
  readonly limits?: { readonly minTenthsC?: number; readonly maxTenthsC?: number };
  readonly items: readonly { readonly itemId: string; readonly label: string }[];
  /** For a check this screen saved: where it has got to. */
  readonly saved?: { readonly state: DeviceItemState; readonly stateWord: string; readonly reason?: string };
}

export interface FoodSafetyView {
  readonly known: boolean;
  readonly asAtWords: string;
  readonly rows: readonly FoodSafetySlotRow[];
}

export interface RecordInput {
  readonly checkId: string;
  readonly slotDueAt: string;
  readonly readingC?: string;
  readonly itemResults?: Readonly<Record<string, string>>;
  readonly correctiveAction?: string;
}
export type RecordOutcome = { readonly ok: true; readonly recordId: string } | { readonly ok: false; readonly code: string; readonly words: string };

export interface FoodSafetyQueue {
  text(lang: Lang, key: CopyKey): string;
  view(lang: Lang): FoodSafetyView;
  record(lang: Lang, input: RecordInput): RecordOutcome;
  handedKeys(): readonly string[];
  noteBoxStatus(statuses: readonly BoxItemStatus[]): void;
}

const STATE_WORD: Readonly<Record<DeviceItemState, CopyKey>> = Object.freeze({ saved_here: 'stSavedHere', retrying: 'stRetrying', handed_to_box: 'stHanded', posted: 'stPosted', refused: 'stRefused' });
/** Degrees typed by a person → whole tenths, exactly: "4" → 40, "3.5" → 35, "-18" → -180. */
export function tenthsOf(raw: string): number | undefined {
  const m = /^(-?)(\d+)(?:\.(\d))?$/.exec(raw.trim());
  if (m === null) return undefined;
  const v = Number(m[2]) * 10 + Number(m[3] ?? '0');
  return m[1] === '-' ? -v : v;
}
let counter = 0;
const defaultFreshId = (): string => {
  const uuid = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID?.();
  counter += 1;
  return uuid === undefined ? `fs-${Date.now()}-${counter}` : `fs-${uuid.slice(0, 12)}`;
};

export function createFoodSafetyQueue(
  config: { readonly userId: string | null; readonly storeId: string | null; readonly now: () => string; readonly freshId?: () => string },
  held: HeldFoodSafety | null | undefined, outbox: SyncOutbox, boxWords: Map<string, BoxItemStatus> = new Map(),
): FoodSafetyQueue {
  const text = (lang: Lang, key: CopyKey): string => translator(FOOD_SAFETY_COPY, lang)(key);
  const savedHere = (): readonly { key: string; checkId: string; slotDueAt: string; state: DeviceItemState; reason?: string }[] => outbox.all()
    .filter((i) => i.event.type === FOOD_SAFETY_CHECK_RECORDED)
    .map((i) => {
      const p = i.event.payload as { checkId: string; slotDueAt: string };
      const box = boxWords.get(i.key);
      const reason = deviceItemReason(i, box);
      return { key: i.key, checkId: p.checkId, slotDueAt: p.slotDueAt, state: deviceItemState(i, box), ...(reason === undefined ? {} : { reason }) };
    });
  const checkOf = (checkId: string): FoodSafetyCheck | undefined => held?.checks.find((c) => c.checkId === checkId);
  return {
    text,
    view: (lang) => {
      if (held === undefined || held === null) return { known: false, asAtWords: text(lang, 'fsNotKnown'), rows: [] };
      const now = config.now();
      // Today's slots from head office's checks in force, by the same engine — with nothing recorded, so each is due,
      // missed or later; then head office's own word and this screen's saves are laid over them.
      const status = foodSafetyStatus({ checks: held.checks, records: [] as FoodSafetyCheckRecord[], from: new Date(Date.parse(now) - DAY_MS / 2).toISOString(), asAt: now });
      const ho = new Map<string, HeldFoodSafety['slots'][number]>(held.slots.filter((s) => s.state.startsWith('done')).map((s) => [`${s.checkId}\u001f${s.slotDueAt}`, s] as const));
      const mine = new Map<string, ReturnType<typeof savedHere>[number]>(savedHere().map((s) => [`${s.checkId}\u001f${s.slotDueAt}`, s] as const));
      const order: Readonly<Record<FoodSafetySlotRow['state'], number>> = { missed: 0, due: 1, saved_here: 2, done_ho: 3, upcoming: 4 };
      const rows = status.slots.map((slot): FoodSafetySlotRow => {
        const k = `${slot.checkId}\u001f${slot.slotDueAt}`;
        const check = checkOf(slot.checkId)!;
        const saved = mine.get(k);
        const state: FoodSafetySlotRow['state'] = saved !== undefined && saved.state !== 'refused' ? 'saved_here' : ho.has(k) ? 'done_ho'
          : slot.state === 'missed' ? 'missed' : slot.state === 'due' ? 'due' : 'upcoming';
        const word: CopyKey = state === 'missed' ? 'fsMissed' : state === 'due' ? 'fsDue' : state === 'done_ho' ? 'fsDoneHo' : state === 'saved_here' ? 'fsSavedHere' : 'fsUpcoming';
        return {
          checkId: slot.checkId, title: slot.title, kind: slot.kind, slotDueAt: slot.slotDueAt, state, stateWord: text(lang, word),
          icon: state === 'missed' ? '✕' : state === 'due' ? '⚠' : state === 'upcoming' ? '•' : '✓',
          canRecord: (state === 'due' || state === 'missed') && config.userId !== null,
          ...(check.minTenthsC === undefined && check.maxTenthsC === undefined ? {} : { limits: { ...(check.minTenthsC === undefined ? {} : { minTenthsC: check.minTenthsC }), ...(check.maxTenthsC === undefined ? {} : { maxTenthsC: check.maxTenthsC }) } }),
          items: check.items,
          ...(saved === undefined ? {} : { saved: { state: saved.state, stateWord: text(lang, STATE_WORD[saved.state]), ...(saved.reason === undefined ? {} : { reason: saved.reason }) } }),
        };
      }).sort((a, b) => order[a.state] - order[b.state] || a.slotDueAt.localeCompare(b.slotDueAt));
      return { known: true, asAtWords: `${text(lang, 'fsAsOf')} ${held.asAt}`, rows };
    },
    record: (lang, input) => {
      if (config.userId === null) return { ok: false, code: 'nobody', words: text(lang, 'fsNobody') };
      if (config.storeId === null) return { ok: false, code: 'no_store', words: text(lang, 'fsNoStore') };
      const check = checkOf(input.checkId);
      if (check === undefined) return { ok: false, code: 'unknown_check', words: text(lang, 'fsNotKnown') };
      const reading = input.readingC === undefined || input.readingC.trim() === '' ? undefined : tenthsOf(input.readingC);
      if (input.readingC !== undefined && input.readingC.trim() !== '' && reading === undefined) return { ok: false, code: 'bad_reading', words: text(lang, 'fsBadReading') };
      const itemResults: Record<string, ItemResult> = {};
      for (const [k, v] of Object.entries(input.itemResults ?? {})) if (v === 'pass' || v === 'fail') itemResults[k] = v;
      const at = config.now();
      const recordId = (config.freshId ?? defaultFreshId)();
      const action = (input.correctiveAction ?? '').trim();
      // The same rules head office runs — refused here, in its words, before anything is saved.
      const assessed = assessCheckRecord(check, {
        recordId, checkId: check.checkId, performedBy: config.userId, performedAt: at, slotDueAt: input.slotDueAt,
        ...(reading === undefined ? {} : { readingTenthsC: reading }), ...(Object.keys(itemResults).length === 0 ? {} : { itemResults }),
        ...(action === '' ? {} : { correctiveAction: action }),
      });
      // The engine's own reason, in the screen's language (its English detail stays with head office's record of it).
      if (!assessed.ok) return { ok: false, code: assessed.refusal, words: text(lang, `rf_${assessed.refusal}`) };
      const key = foodSafetyKeyFor(recordId);
      outbox.enqueue(makeEvent({
        id: key, type: FOOD_SAFETY_CHECK_RECORDED, occurredAt: at, idempotencyKey: key, source: 'web-erp/facilities',
        payload: {
          recordId, checkId: check.checkId, storeId: config.storeId, performedBy: config.userId, at, slotDueAt: input.slotDueAt,
          ...(reading === undefined ? {} : { readingTenthsC: reading }), ...(Object.keys(itemResults).length === 0 ? {} : { itemResults }),
          ...(action === '' ? {} : { correctiveAction: action }), source: 'facilities-screen',
        },
      }));
      return { ok: true, recordId };
    },
    handedKeys: () => outbox.all().filter((i) => i.event.type === FOOD_SAFETY_CHECK_RECORDED && i.state === 'acknowledged').map((i) => i.key),
    noteBoxStatus: (statuses) => { for (const s of statuses) boxWords.set(s.key, s); },
  };
}
