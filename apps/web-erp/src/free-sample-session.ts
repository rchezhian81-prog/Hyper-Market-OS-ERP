// FG-4 · A12 (1) · OB-386 — free samples and the GST credit they give back. A tested, DOM-free session for two places:
//   • the write-off capture screen: a person who handles stock RECORDS a free sample (POST /v1/inventory/free-samples/:id)
//     — the product, the place, how many and what it was for. Head office values it at its own buying cost and works out
//     the credit to give back; the screen shows head office's sentence, never a figure of its own;
//   • the Input tax credit page: the accountant reads the month's free samples (GET /v1/finance/free-sample-itc?month=)
//     and CHECKS each give-back — agreed, or a query with a note (POST …/:issueId/check).
// OB-393: each sample now WAITS for a store manager other than the giver, who approves (the stock leaves, the give-back is
// placed) or rejects it from the waiting list on the same screen (GET /v1/inventory/free-samples/pending,
// POST …/:issueId/decision). The giver's own rows carry no approve button; head office refuses a self-approval by name.
// Nothing is read or written on open; every write is a person's click. When the page carries who is looking, the cheap
// refusals are made here first; head office re-checks everything either way.

import { makeCaller, newId, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const FREE_SAMPLE_COPY = {
  en: {
    fsH: 'Give a free sample', fsLead: 'Stock given away free (a tasting, a sample to a customer) leaves the shelf here. Head office values it at its own buying cost and works out the GST credit to give back; the accountant checks it.',
    product: 'Product', location: 'Taken from (place)', qty: 'How many', uom: 'Unit', note: 'What it was for (required)', record: 'Record the free sample',
    recorded: 'Recorded and waiting: a store manager other than you approves it before the stock leaves and the GST credit is given back.',
    pendingH: 'Free samples waiting for approval', pendingLead: 'Given but not yet approved: the stock has not left and no GST credit has been given back. A store manager other than the giver approves or rejects each one.',
    pendingNone: 'No free sample is waiting for approval.', givenBy: 'given by', approve: 'Approve', reject: 'Reject', decisionReason: 'Reason (required)',
    approved: 'Approved. The stock has left. GST credit given back:', rejectedOk: 'Rejected. Nothing moved.', yours: 'You gave this one — another store manager approves it.',
    needReason: 'Write the reason first. Nothing was sent.', loadPending: 'Show the waiting samples',
    awaitingApproval: 'waiting for a store manager\'s approval (no credit given back yet)', needAll: 'Fill the product, the place, a whole number above 0, the unit and what it was for. Nothing was sent.',
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
    recorded: 'பதிவு செய்யப்பட்டு காத்திருக்கிறது: சரக்கு வெளியேறி GST வரவு திருப்பித் தரப்படும் முன், உங்களைத் தவிர வேறொரு கடை மேலாளர் ஒப்புதல் அளிக்க வேண்டும்.',
    pendingH: 'ஒப்புதலுக்காகக் காத்திருக்கும் இலவச மாதிரிகள்', pendingLead: 'கொடுக்கப்பட்டது, ஆனால் இன்னும் ஒப்புதல் இல்லை: சரக்கு வெளியேறவில்லை, GST வரவு திருப்பித் தரப்படவில்லை. கொடுத்தவரைத் தவிர வேறொரு கடை மேலாளர் ஒவ்வொன்றையும் ஏற்கிறார் அல்லது மறுக்கிறார்.',
    pendingNone: 'ஒப்புதலுக்காக எந்த இலவச மாதிரியும் காத்திருக்கவில்லை.', givenBy: 'கொடுத்தவர்', approve: 'ஒப்புதல் அளி', reject: 'மறு', decisionReason: 'காரணம் (தேவை)',
    approved: 'ஒப்புதல் அளிக்கப்பட்டது. சரக்கு வெளியேறியது. திருப்பித் தரப்பட்ட GST வரவு:', rejectedOk: 'மறுக்கப்பட்டது. எதுவும் நகரவில்லை.', yours: 'இதை நீங்கள் கொடுத்தீர்கள் — வேறொரு கடை மேலாளர் ஒப்புதல் அளிப்பார்.',
    needReason: 'முதலில் காரணத்தை எழுதவும். எதுவும் அனுப்பப்படவில்லை.', loadPending: 'காத்திருக்கும் மாதிரிகளைக் காட்டு',
    awaitingApproval: 'கடை மேலாளரின் ஒப்புதலுக்காகக் காத்திருக்கிறது (இன்னும் வரவு திருப்பித் தரப்படவில்லை)', needAll: 'பொருள், இடம், 0-க்கு மேற்பட்ட முழு எண், அலகு, எதற்காக என்பதை நிரப்பவும். எதுவும் அனுப்பப்படவில்லை.',
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

/** OB-393: one free sample waiting for a store manager other than the giver. */
export interface PendingFreeSample {
  readonly issueId: string; readonly productId: string; readonly locationId: string; readonly qty: number; readonly uom: string; readonly note: string;
  readonly requestedBy: string; readonly requestedAt: string; readonly tradingDay: string;
}

type Why = 'nobody' | 'cannotRecord' | 'needAll' | 'needNote' | 'noMonth' | 'needReason' | 'yours';

export interface FreeSampleSession {
  readonly may: { readonly named: boolean; readonly record: boolean; readonly approve: boolean };
  /** Who is looking, when the page says — their own waiting samples carry no approve button (OB-393). */
  readonly viewerId: string | null;
  record(input: { readonly productId: string; readonly locationId: string; readonly qty: string; readonly uom: string; readonly note: string }): Promise<Outcome<{ readonly status: string; readonly detail: string }, Why>>;
  /** OB-393: the samples waiting for approval. */
  pending(): Promise<Outcome<{ readonly pending: readonly PendingFreeSample[]; readonly count: number }, Why>>;
  /** OB-393: approve or reject one — with a reason; never one the viewer gave. */
  decide(sample: Pick<PendingFreeSample, 'issueId' | 'requestedBy'>, decision: 'approve' | 'reject', reason: string): Promise<Outcome<{ readonly itcWords?: string; readonly detail?: string }, Why>>;
  list(month: string): Promise<Outcome<{ readonly issues: readonly FreeSampleRow[]; readonly toCheck: number; readonly notComputed: number; readonly awaitingApproval?: readonly PendingFreeSample[] }, Why>>;
  check(issueId: string, outcome: 'agreed' | 'query', note: string): Promise<Outcome<unknown, Why>>;
}

/** `viewer` undefined: the page carries no identity — head office decides every permission (its refusal is said). */
export function createFreeSampleSession(input: { readonly viewer?: { readonly userId?: string; readonly permissions: readonly string[] }; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string; readonly newIssueId?: () => string }): FreeSampleSession {
  const known = input.viewer !== undefined;
  const named = !known || input.viewer?.userId !== undefined;
  const held = input.viewer?.permissions ?? [];
  const may = { named, record: named && (!known || held.includes('inventory.movement.append')), approve: named && (!known || held.includes('inventory.free_sample.approve')) };
  const viewerId = input.viewer?.userId ?? null;
  const call = makeCaller({ keyPrefix: 'free-sample', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const enc = encodeURIComponent;
  return {
    may,
    viewerId,
    pending: async () => (named ? call('GET', '/v1/inventory/free-samples/pending') : { result: 'invalid', why: 'nobody' }),
    decide: async (sample, decision, reason) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      if (viewerId !== null && sample.requestedBy === viewerId) return { result: 'invalid', why: 'yours' };
      if (reason.trim() === '') return { result: 'invalid', why: 'needReason' };
      return call('POST', `/v1/inventory/free-samples/${enc(sample.issueId)}/decision`, { decision, reason: reason.trim() });
    },
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
