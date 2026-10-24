// The relabel tasks on the Store tasks page (D11-FR-03 "a price change creates relabel tasks"). A tested, DOM-free
// session over head office: every new price raises one task per shelf place at each store it reaches (or one "not on
// the plan"), due when the price takes effect; a person at the store puts the new label up and closes the task with the
// photo reference and the price the label now shows. Head office refuses a label showing another price (the task stays
// open) and records the shelf price as a price-integrity observation. Nothing here changes a price (P-05).
// OB-358: each task says who it is for — the floor champion of the department that owns the product, else the store
// manager (and why) — and marks the reader's own.

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const RELABEL_COPY = {
  en: {
    relabelMineH: 'Shelf labels to change — mine', relabelH: 'Shelf labels to change', relabelLead: 'A price changed. Put the new label up, photograph it, type the price the label shows, and close the task.',
    open: 'to change', none: 'No label to change.', product: 'Product', place: 'Shelf place', notOnPlan: 'not on the shelf plan — find it on the floor', newPrice: 'New price', from: 'from', dueNow: 'due now', notYet: 'not due yet',
    price_change: 'price change', price_list_entry: 'price list', done: 'Changed', doneBy: 'by', labelPrice: 'Price on the new label (₹)', photo: 'Photo reference', close: 'Label changed',
    needFields: 'Type the price on the label and the photo reference first.', saved: 'Saved.', refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved.',
    for: 'For', championOf: 'floor champion of', storeManager: 'the store manager', yours: 'yours', notAssigned: 'not assigned (raised before tasks were assigned)',
    no_department_owns_it: 'no department owns this product here', no_champion_named: 'no floor champion named for', champion_left: 'the floor champion has left —',
    nobodyHolds: 'nobody holds the store manager role here (not set)',
  },
  ta: {
    relabelMineH: 'மாற்ற வேண்டிய அலமாரி லேபிள்கள் — என்னுடையவை', relabelH: 'மாற்ற வேண்டிய அலமாரி லேபிள்கள்', relabelLead: 'விலை மாறியது. புதிய லேபிளை வைத்து, படம் எடுத்து, லேபிளில் உள்ள விலையைத் தட்டச்சு செய்து, பணியை முடிக்கவும்.',
    open: 'மாற்ற வேண்டியவை', none: 'மாற்ற வேண்டிய லேபிள் இல்லை.', product: 'பொருள்', place: 'அலமாரி இடம்', notOnPlan: 'அலமாரித் திட்டத்தில் இல்லை — தளத்தில் தேடவும்', newPrice: 'புதிய விலை', from: 'முதல்', dueNow: 'இப்போது செய்ய வேண்டும்', notYet: 'இன்னும் நேரம் வரவில்லை',
    price_change: 'விலை மாற்றம்', price_list_entry: 'விலைப் பட்டியல்', done: 'மாற்றப்பட்டது', doneBy: 'செய்தவர்', labelPrice: 'புதிய லேபிளில் உள்ள விலை (₹)', photo: 'புகைப்படக் குறிப்பு', close: 'லேபிள் மாற்றப்பட்டது',
    needFields: 'முதலில் லேபிளில் உள்ள விலையையும் புகைப்படக் குறிப்பையும் தட்டச்சு செய்யவும்.', saved: 'சேமிக்கப்பட்டது.', refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கவோ சேமிக்கவோ இல்லை.',
    for: 'யாருக்கு', championOf: 'தளச் சாம்பியன் —', storeManager: 'கடை மேலாளர்', yours: 'உங்களுடையது', notAssigned: 'ஒதுக்கப்படவில்லை (பணி ஒதுக்கீட்டுக்கு முன் எழுப்பப்பட்டது)',
    no_department_owns_it: 'இங்கு இந்தப் பொருள் எந்தப் பிரிவுக்கும் சொந்தமில்லை', no_champion_named: 'தளச் சாம்பியன் பெயரிடப்படவில்லை:', champion_left: 'தளச் சாம்பியன் விலகிவிட்டார் —',
    nobodyHolds: 'இங்கு கடை மேலாளர் பணியில் யாரும் இல்லை (அமைக்கப்படவில்லை)',
  },
} as const;

/** OB-358: who a task is for, in words. */
export function relabelAssigneeWords(lang: Lang, row: Pick<RelabelRow, 'assignee' | 'storeManagers' | 'assignedToMe'>): string {
  const w = (k: string) => relabelWords(lang, k);
  const a = row.assignee;
  const mine = row.assignedToMe === true ? ` · ✓ ${w('yours')}` : '';
  if (a === undefined || a === null) return `${w('for')}: ${w('notAssigned')}`;
  if (a.to === 'floor_champion') return `${w('for')}: ${a.employeeId} (${w('championOf')} ${a.departmentId})${mine}`;
  const why = a.because === 'no_department_owns_it' ? w(a.because) : `${w(a.because)} ${a.departmentId ?? ''}`.trim();
  const who = row.storeManagers === undefined ? '' : row.storeManagers.length === 0 ? ` — ⚠ ${w('nobodyHolds')}` : ` (${row.storeManagers.join(', ')})`;
  return `${w('for')}: ${w('storeManager')}${who} — ${why}${mine}`;
}

export const relabelWords = (lang: Lang, key: string): string =>
  (RELABEL_COPY[lang] as Record<string, string>)[key] ?? (RELABEL_COPY.en as Record<string, string>)[key] ?? key;
export const relabelOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => (out.result === 'ok' ? relabelWords(lang, 'saved') : outcomeIn((k) => relabelWords(lang, k), out));

/** Paise from what a person typed as rupees ("45", "45.50"); undefined when it is not a price. */
export function paiseOf(raw: string): number | undefined {
  const s = raw.trim();
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return undefined;
  const [r, p = ''] = s.split('.');
  return Number(r) * 100 + Number(p.padEnd(2, '0'));
}

export interface RelabelRow {
  readonly taskId: string; readonly branchId: string; readonly productId: string; readonly locationId: string | null; readonly priceMinor: number; readonly dueAt: string;
  readonly because: 'price_change' | 'price_list_entry'; readonly dueNow: boolean; readonly done: { readonly doneBy: string; readonly doneAt: string; readonly shelfPriceMinor: number } | null;
  /** OB-358: who the task goes to (null = raised before the rule), whether it is the reader's, and who holds the store manager role. */
  readonly assignee?: { readonly to: 'floor_champion'; readonly departmentId: string; readonly employeeId: string } | { readonly to: 'store_manager'; readonly departmentId: string | null; readonly because: 'no_department_owns_it' | 'no_champion_named' | 'champion_left' } | null;
  readonly assignedToMe?: boolean;
  readonly storeManagers?: readonly string[];
}
export interface RelabelSession {
  readonly may: { readonly read: boolean; readonly close: boolean; readonly readMine: boolean };
  tasks(branchId?: string): Promise<Outcome<{ readonly tasks: readonly RelabelRow[]; readonly open: number }>>;
  /** OB-358: the tasks that go to me (my department's floor champion, or the store manager) — the My tasks page. */
  mine(): Promise<Outcome<{ readonly tasks: readonly RelabelRow[]; readonly open: number }>>;
  close(taskId: string, labelPrice: string, evidenceRef: string): Promise<Outcome<unknown, 'needFields'>>;
}
export function createRelabelSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string }): RelabelSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const call = makeCaller({ keyPrefix: 'relabel', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  return {
    may: { read: named && held.has('workforce.task.read'), close: named && held.has('workforce.task.complete.own'), readMine: named && held.has('workforce.task.complete.own') },
    mine: () => call('GET', '/v1/pricing/relabel-tasks/mine'),
    tasks: (branchId) => call('GET', `/v1/pricing/relabel-tasks${branchId === undefined || branchId.trim() === '' ? '' : `?branchId=${encodeURIComponent(branchId.trim())}`}`),
    close: async (taskId, labelPrice, evidenceRef) => {
      const shelfPriceMinor = paiseOf(labelPrice);
      if (shelfPriceMinor === undefined || evidenceRef.trim() === '') return { result: 'invalid', why: 'needFields' };
      return call('POST', `/v1/pricing/relabel-tasks/${encodeURIComponent(taskId)}/done`, { shelfPriceMinor, evidenceRef: evidenceRef.trim() });
    },
  };
}
