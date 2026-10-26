// FG-4 · A12 (1) · OB-386 — free samples and the GST credit they give back. A tested, DOM-free session for two places:
//   • the write-off capture screen: a person who handles stock RECORDS a free sample (POST /v1/inventory/free-samples/:id)
//     — the product, the place, how many and what it was for. Head office values it at its own buying cost and works out
//     the credit to give back; the screen shows head office's sentence, never a figure of its own;
//   • the Input tax credit page: the accountant reads the month's free samples (GET /v1/finance/free-sample-itc?month=)
//     and CHECKS each give-back — agreed, or a query with a note (POST …/:issueId/check).
// Nothing is read or written on open; every write is a person's click. When the page carries who is looking, the cheap
// refusals are made here first; head office re-checks everything either way.

import { makeCaller, newId, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const FREE_SAMPLE_COPY = {
  en: {
    fsH: 'Give a free sample', fsLead: 'Stock given away free (a tasting, a sample to a customer) leaves the shelf here. Head office values it at its own buying cost and works out the GST credit to give back; the accountant checks it.',
    product: 'Product', location: 'Taken from (place)', qty: 'How many', uom: 'Unit', note: 'What it was for (required)', record: 'Record the free sample',
    recorded: 'Recorded. GST credit given back:', needAll: 'Fill the product, the place, a whole number above 0, the unit and what it was for. Nothing was sent.',
    listH: 'Free samples — GST credit given back', listLead: 'Each free sample\'s credit give-back as the system worked it out, in the return it went into. Check each one: agree, or raise a query with a note.',
    listNone: 'No free sample was given in this month.', toCheck: 'to check', notComputed: 'not computed',
    agree: 'Agree', query: 'Query', checkNote: 'Note (required)', agreed: 'Agreed', queried: 'Query raised', unchecked: 'Not checked yet', needNote: 'Write a note first. Nothing was sent.',
    noMonth: 'Choose the month first.', by: 'by',
    saved: 'Saved.', nobody: 'Nobody is signed in on this screen — you can record nothing.', cannotRecord: 'Your role cannot record a stock issue.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was recorded. Record it again when the line is back.',
  },
  ta: {
    fsH: 'இலவச மாதிரி கொடு', fsLead: 'இலவசமாகக் கொடுக்கப்படும் சரக்கு (சுவைபார்ப்பு, வாடிக்கையாளருக்கு மாதிரி) இங்கே அலமாரியை விட்டுச் செல்கிறது. தலைமை அலுவலகம் அதைத் தன் வாங்கிய விலையில் மதிப்பிட்டு, திருப்பித் தர வேண்டிய GST வரவைக் கணக்கிடுகிறது; கணக்காளர் சரிபார்க்கிறார்.',
    product: 'பொருள்', location: 'எடுத்த இடம்', qty: 'எத்தனை', uom: 'அலகு', note: 'எதற்காக (தேவை)', record: 'இலவச மாதிரியைப் பதிவு செய்',
    recorded: 'பதிவு செய்யப்பட்டது. திருப்பித் தரப்பட்ட GST வரவு:', needAll: 'பொருள், இடம், 0-க்கு மேற்பட்ட முழு எண், அலகு, எதற்காக என்பதை நிரப்பவும். எதுவும் அனுப்பப்படவில்லை.',
    listH: 'இலவச மாதிரிகள் — திருப்பித் தரப்பட்ட GST வரவு', listLead: 'ஒவ்வொரு இலவச மாதிரியின் வரவுத் திருப்பம் — அமைப்பு கணக்கிட்டபடி, அது சேர்ந்த ரிட்டர்னில். ஒவ்வொன்றையும் சரிபார்க்கவும்: ஒப்புக்கொள்ளவும், அல்லது குறிப்புடன் கேள்வி எழுப்பவும்.',
    listNone: 'இந்த மாதம் எந்த இலவச மாதிரியும் கொடுக்கப்படவில்லை.', toCheck: 'சரிபார்க்க வேண்டியவை', notComputed: 'கணக்கிடப்படவில்லை',
    agree: 'ஒப்புக்கொள்', query: 'கேள்வி', checkNote: 'குறிப்பு (தேவை)', agreed: 'ஒப்புக்கொள்ளப்பட்டது', queried: 'கேள்வி எழுப்பப்பட்டது', unchecked: 'இன்னும் சரிபார்க்கப்படவில்லை', needNote: 'முதலில் குறிப்பை எழுதவும். எதுவும் அனுப்பப்படவில்லை.',
    noMonth: 'முதலில் மாதத்தைத் தேர்ந்தெடுக்கவும்.', by: 'செய்தவர்',
    saved: 'சேமிக்கப்பட்டது.', nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் பதிவு செய்ய முடியாது.', cannotRecord: 'உங்கள் பங்கு சரக்கு வெளியீட்டைப் பதிவு செய்ய முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் பதிவு செய்யப்படவில்லை. இணைப்பு திரும்பியதும் மீண்டும் பதிவு செய்யவும்.',
  },
} as const;

export const freeSampleWords = (lang: Lang, key: string): string =>
  (FREE_SAMPLE_COPY[lang] as Record<string, string>)[key] ?? (FREE_SAMPLE_COPY.en as Record<string, string>)[key] ?? key;
export const freeSampleOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => (out.result === 'ok' ? freeSampleWords(lang, 'saved') : outcomeIn((k) => freeSampleWords(lang, k), out));

export interface FreeSampleRow {
  readonly issueId: string; readonly productId: string; readonly locationId: string; readonly qty: number; readonly uom: string; readonly note: string;
  readonly issuedBy: string; readonly tradingDay: string; readonly itc: { readonly state: string }; readonly returnMonth?: string; readonly itcWords: string;
  readonly check: { readonly outcome: 'agreed' | 'query'; readonly note: string; readonly by: string } | null;
}

type Why = 'nobody' | 'cannotRecord' | 'needAll' | 'needNote' | 'noMonth';

export interface FreeSampleSession {
  readonly may: { readonly named: boolean; readonly record: boolean };
  record(input: { readonly productId: string; readonly locationId: string; readonly qty: string; readonly uom: string; readonly note: string }): Promise<Outcome<{ readonly itcWords: string }, Why>>;
  list(month: string): Promise<Outcome<{ readonly issues: readonly FreeSampleRow[]; readonly toCheck: number; readonly notComputed: number }, Why>>;
  check(issueId: string, outcome: 'agreed' | 'query', note: string): Promise<Outcome<unknown, Why>>;
}

/** `viewer` undefined: the page carries no identity — head office decides every permission (its refusal is said). */
export function createFreeSampleSession(input: { readonly viewer?: { readonly userId?: string; readonly permissions: readonly string[] }; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string; readonly newIssueId?: () => string }): FreeSampleSession {
  const known = input.viewer !== undefined;
  const named = !known || input.viewer?.userId !== undefined;
  const may = { named, record: named && (!known || (input.viewer?.permissions ?? []).includes('inventory.movement.append')) };
  const call = makeCaller({ keyPrefix: 'free-sample', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const enc = encodeURIComponent;
  return {
    may,
    record: async (i) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      if (!may.record) return { result: 'invalid', why: 'cannotRecord' };
      const qty = /^\d+$/.test(i.qty.trim()) ? Number(i.qty.trim()) : 0;
      if ([i.productId, i.locationId, i.uom, i.note].some((x) => x.trim() === '') || qty <= 0) return { result: 'invalid', why: 'needAll' };
      const id = input.newIssueId?.() ?? newId('fs');
      return call('POST', `/v1/inventory/free-samples/${enc(id)}`, { productId: i.productId.trim(), locationId: i.locationId.trim(), qty, uom: i.uom.trim(), note: i.note.trim() });
    },
    list: async (month) => (/^\d{4}-\d{2}$/.test(month.trim()) ? call('GET', `/v1/finance/free-sample-itc?month=${enc(month.trim())}`) : { result: 'invalid', why: 'noMonth' }),
    check: async (issueId, outcome, note) => (note.trim() === '' ? { result: 'invalid', why: 'needNote' } : call('POST', `/v1/finance/free-sample-itc/${enc(issueId)}/check`, { outcome, note: note.trim() })),
  };
}
