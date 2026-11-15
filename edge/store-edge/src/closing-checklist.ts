// The store rules' CLOSING CHECKLIST on the store computer — one source for the Today count, the Checklists page and
// the day close (fix batch 3: D-008 · D-011 · D-012 · M14-FR-04 · M25-FR-02 · P-03 · P-08 · hard rules #2 #6).
//
// Head office sends the store rules' closing checklist in the pack (`checklist`: each item, and whether it BLOCKS the day
// close — "a blocking item must be done before the day closes", services/platform store-packs). It sends every item
// not done: head office cannot know what was done in the shop tonight. What WAS done is this box's own record: each
// tick a manager makes is a checklist completion written to the box's completions log (append-only, durable before it
// is called done) and queued for head office's synced checklist route — so a tick is never overwritten, never lost, and
// says who ticked it and when. This file folds the two: the rules say which items there are; the box's ticks say which
// are done. Today counts from it, the Checklists page lists it, and the box's close refuses while a blocking one is open.
//
// The DAY the box closes is also named here, once: the most recently ENDED trading day (M14-FR-04) — the trading day
// before the running one, by the store's trading-day rule and cutoff. The close and the screens both read this, so the
// screen can say which day a button closes without a rule of its own.

type Rec = Record<string, unknown>;

/** One store-rules checklist item, as the pack carries it (`PackChecklistItem`). */
export interface RulesChecklistItem {
  readonly itemId: string;
  readonly description: string;
  readonly done: boolean;
  readonly blocking: boolean;
  readonly doneBy?: string;
}

/** One item of the day's closing checklist as the box knows it: the rule, and who ticked it when (if anyone). */
export interface ClosingChecklistItem {
  readonly itemId: string;
  readonly description: string;
  readonly blocking: boolean;
  readonly done: boolean;
  readonly doneBy?: string;
  readonly doneAt?: string;
}

/** The day's closing checklist: its id (`<day>-closing`, the id the cloud files it under), its day, its items. */
export interface ClosingChecklist {
  readonly checklistId: string;
  readonly kind: 'closing';
  readonly forDate: string;
  readonly items: readonly ClosingChecklistItem[];
}

/** The id one day's closing checklist is filed under, on this box and at head office. */
export const closingChecklistId = (day: string): string => `${day}-closing`;

/** The calendar date before a `YYYY-MM-DD`. */
export function dayBefore(day: string): string {
  const dt = new Date(`${day}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

/** The calendar date after a `YYYY-MM-DD`. */
export function dayAfter(day: string): string {
  const dt = new Date(`${day}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

/**
 * The trading day the store computer closes when asked now (M14-FR-04): the most recently ENDED one — the day before the
 * running trading day. The running day cannot be closed while it is still trading; it ends at the store's cutoff on the
 * next calendar day. The box's close and the screens' words both come from here.
 */
export const dayTheBoxCloses = (runningTradingDay: string): string => dayBefore(runningTradingDay);

/** "HH:MM" for a cutoff held as minutes after midnight. */
export const cutoffWords = (cutoffMinutes: number): string =>
  `${String(Math.floor(cutoffMinutes / 60)).padStart(2, '0')}:${String(cutoffMinutes % 60).padStart(2, '0')}`;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/**
 * The checklist completion BODIES on this box's completions log (each record is `{ completionKind, body }`), kept only
 * where they are checklists. Untrusted JSON off the disk, read defensively; anything else is skipped (it stays on the
 * log, kept, hard rule #6 — this is a read, never a repair).
 */
export function checklistBodiesOf(envelopes: readonly unknown[]): Rec[] {
  return envelopes.flatMap((e) => {
    const env = (e !== null && typeof e === 'object' ? e : {}) as Rec;
    if (env['completionKind'] !== 'checklist') return [];
    const body = env['body'];
    return body !== null && typeof body === 'object' ? [body as Rec] : [];
  });
}

/**
 * Fold the store rules' checklist with this box's ticks for one trading day. An item is done when head office already
 * says so, or when any tick on this box for that day's checklist marks it done — the FIRST such tick names who did it.
 * Ticks are never undone here: a tick is a record of a person's act, kept (hard rule #2).
 */
export function foldClosingChecklist(rules: readonly RulesChecklistItem[], checklistBodies: readonly unknown[] | undefined, day: string): ClosingChecklist {
  const id = closingChecklistId(day);
  const ticked = new Map<string, { doneBy?: string; doneAt?: string }>();
  for (const raw of checklistBodies === undefined ? [] : checklistBodies) { // no ticks read: none made here
    const body = (raw !== null && typeof raw === 'object' ? raw : {}) as Rec;
    if (str(body['checklistId']) !== id) continue;
    const items = Array.isArray(body['items']) ? (body['items'] as unknown[]) : [];
    for (const it of items) {
      const item = (it !== null && typeof it === 'object' ? it : {}) as Rec;
      const itemId = str(item['itemId']);
      if (itemId === undefined || item['done'] !== true || ticked.has(itemId)) continue;
      const doneBy = str(item['doneBy']);
      const doneAt = str(item['doneAt']);
      ticked.set(itemId, { ...(doneBy === undefined ? {} : { doneBy }), ...(doneAt === undefined ? {} : { doneAt }) });
    }
  }
  return {
    checklistId: id, kind: 'closing', forDate: day,
    items: rules.map((r) => {
      const tick = ticked.get(r.itemId);
      if (tick !== undefined) return { itemId: r.itemId, description: r.description, blocking: r.blocking, done: true, ...tick };
      return { itemId: r.itemId, description: r.description, blocking: r.blocking, done: r.done, ...(r.doneBy === undefined ? {} : { doneBy: r.doneBy }) };
    }),
  };
}

/** The items of a checklist that must be done before the day closes and are not done. */
export const blockingOpen = (checklist: ClosingChecklist): readonly ClosingChecklistItem[] =>
  checklist.items.filter((i) => i.blocking && !i.done);

/**
 * The record one tick writes: the whole checklist as it stands WITH this item done by this person now — the shape head
 * office's synced checklist route reads (latest per checklist id wins there; every record is kept, hard rule #6).
 */
export function tickRecord(checklist: ClosingChecklist, itemId: string, doneBy: string, doneAt: string, branchId: string | undefined): Rec {
  return {
    checklistId: checklist.checklistId, kind: 'closing', forDate: checklist.forDate,
    ...(branchId === undefined ? {} : { branchId }),
    items: checklist.items.map((i) => (i.itemId === itemId && !i.done
      ? { itemId: i.itemId, description: i.description, blocking: i.blocking, done: true, doneBy, doneAt }
      : { itemId: i.itemId, description: i.description, blocking: i.blocking, done: i.done, ...(i.doneBy === undefined ? {} : { doneBy: i.doneBy }), ...(i.doneAt === undefined ? {} : { doneAt: i.doneAt }) })),
  };
}

/** Why a tick was refused, in both languages — said on the Checklists page as the box said it. */
export type TickRefusal = 'not_a_day_to_tick' | 'no_such_item' | 'already_done' | 'no_checklist' | 'nobody_signed_in' | 'lacks_permission' | 'could_not_save';

export const TICK_WORDS: Readonly<Record<TickRefusal, { readonly en: string; readonly ta: string }>> = Object.freeze({
  not_a_day_to_tick: {
    en: 'That checklist is not for today or for the day waiting to be closed. Nothing was saved.',
    ta: 'அந்தப் பட்டியல் இன்றைக்கோ முடிக்கக் காத்திருக்கும் நாளுக்கோ உரியது அல்ல. எதுவும் சேமிக்கப்படவில்லை.',
  },
  no_such_item: {
    en: 'That item is not on the store rules\' closing checklist any more. Nothing was saved. Refresh the page.',
    ta: 'அந்த உருப்படி கடை விதிகளின் மூடல் பட்டியலில் இனி இல்லை. எதுவும் சேமிக்கப்படவில்லை. பக்கத்தைப் புதுப்பிக்கவும்.',
  },
  already_done: {
    en: 'That item is already ticked. Nothing more was saved.',
    ta: 'அந்த உருப்படி ஏற்கனவே குறிக்கப்பட்டுள்ளது. மேலும் எதுவும் சேமிக்கப்படவில்லை.',
  },
  no_checklist: {
    en: 'Head office has not sent this store a closing checklist, so there is nothing to tick. Nothing was saved.',
    ta: 'தலைமை அலுவலகம் இந்தக் கடைக்கு மூடல் பட்டியலை அனுப்பவில்லை, எனவே குறிக்க எதுவும் இல்லை. எதுவும் சேமிக்கப்படவில்லை.',
  },
  nobody_signed_in: {
    en: 'Sign in to the office screens first, with your own staff ID and PIN. Nothing was saved.',
    ta: 'முதலில் உங்கள் சொந்தப் பணியாளர் எண்ணாலும் PIN-ஆலும் அலுவலகத் திரைகளில் உள்நுழையுங்கள். எதுவும் சேமிக்கப்படவில்லை.',
  },
  lacks_permission: {
    en: 'You do not hold the right to tick the closing checklist. Nothing was saved. Ask the manager.',
    ta: 'மூடல் பட்டியலைக் குறிக்கும் உரிமை உங்களிடம் இல்லை. எதுவும் சேமிக்கப்படவில்லை. மேலாளரிடம் கேளுங்கள்.',
  },
  could_not_save: {
    en: 'The store computer could not save the tick. Nothing was saved. Tell whoever looks after the store computer.',
    ta: 'கடைக் கணினியால் குறியைச் சேமிக்க முடியவில்லை. எதுவும் சேமிக்கப்படவில்லை. கடைக் கணினியைப் பார்ப்பவரிடம் சொல்லுங்கள்.',
  },
});

/** The permission a person needs to tick the closing checklist — the same right that signs a checklist (M25-FR-02). */
export const TICK_AUTHORITY = 'workforce.roster.manage';
