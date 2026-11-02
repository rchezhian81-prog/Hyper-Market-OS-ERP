// Payments business customers SAY they sent — finance's queue on the Business customers page (M22-FR-04 "a payment reduces
// the outstanding and reconciles to finance" · OB-41 "A" · M23 · §28 · P-03 · P-04 · hard rules #2 #6 #10). A tested,
// DOM-free THIN client over head office's own routes (services/finance/src/b2b-transfer-notes.ts):
//
//   • THE QUEUE (`GET /v1/b2b/transfer-notes`) — every note a customer recorded on its portal, the waiting ones first, each
//     with the amount, the day and the bank reference the customer gave, and where it stands;
//   • MATCH (`POST …/:noteId/match`) — finance reads the line off ITS OWN bank statement (amount received, the day, the
//     reference printed there) and head office accepts only an exact match of amount and reference; anything else is
//     refused by name and the note stays waiting. A match records the money through the collection path once, and the
//     customer's balance comes down;
//   • REJECT (`POST …/:noteId/reject`) — no such money on the statement: the note is rejected with a reason the customer
//     reads. It stays on record; it is never deleted.
//
// The person who recorded a note can never decide it (head office refuses). Nothing is read on open; every call is a click.

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const B2B_TRANSFER_NOTES_COPY = {
  en: {
    h: 'Payments customers say they sent', lead: 'A business customer tells the shop on its portal that it sent a bank transfer. Nothing is paid on the customer\'s word: find the money on the shop\'s own bank statement, then match it — or reject the note with a reason the customer will read.',
    show: 'Show the payment notes', none: 'No customer has told the shop about a payment.', waiting: 'waiting', waitingSum: 'waiting to be checked',
    customer: 'Customer', amount: 'Amount', sentOn: 'Sent on', reference: 'Their bank reference', against: 'For invoices',
    st_pending: 'Waiting — check the bank statement', st_matched: 'Matched to money received', st_rejected: 'Rejected',
    receivedL: 'Received on the statement (₹)', receivedOnL: 'Day on the statement (YYYY-MM-DD)', statementRefL: 'Reference on the statement', match: 'Match to the bank statement',
    matchedNow: 'Matched — the money is recorded once and the customer\'s balance has come down.', alreadyMatched: 'Already matched — nothing changed.',
    rejectWhyL: 'Why it is rejected (the customer reads this)', reject: 'Reject this note', rejectedNow: 'Rejected — the note stays on record with your reason.',
    needMatch: 'Write the amount in rupees, the day (YYYY-MM-DD) and the reference exactly as the bank statement shows them.', needWhy: 'Write why it is rejected.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot record customer payments.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved.',
  },
  ta: {
    h: 'வாடிக்கையாளர்கள் அனுப்பியதாகச் சொல்லும் செலுத்துதல்கள்', lead: 'வணிக வாடிக்கையாளர் தன் போர்ட்டலில் வங்கிப் பரிமாற்றம் அனுப்பியதாகக் கடைக்குச் சொல்கிறார். வாடிக்கையாளரின் சொல்லால் எதுவும் செலுத்தப்பட்டதாகாது: கடையின் சொந்த வங்கி அறிக்கையில் பணத்தைக் கண்டு பொருத்துங்கள் — அல்லது வாடிக்கையாளர் படிக்கும் காரணத்துடன் நிராகரியுங்கள்.',
    show: 'செலுத்துதல் குறிப்புகளைக் காட்டு', none: 'எந்த வாடிக்கையாளரும் செலுத்துதலைப் பற்றிச் சொல்லவில்லை.', waiting: 'காத்திருக்கிறது', waitingSum: 'சரிபார்க்கக் காத்திருக்கிறது',
    customer: 'வாடிக்கையாளர்', amount: 'தொகை', sentOn: 'அனுப்பிய நாள்', reference: 'அவர்களின் வங்கிக் குறிப்பு', against: 'எந்த விலைப்பட்டியல்களுக்கு',
    st_pending: 'காத்திருக்கிறது — வங்கி அறிக்கையைப் பாருங்கள்', st_matched: 'பெற்ற பணத்துடன் பொருத்தப்பட்டது', st_rejected: 'நிராகரிக்கப்பட்டது',
    receivedL: 'அறிக்கையில் பெற்றது (₹)', receivedOnL: 'அறிக்கையில் உள்ள நாள் (YYYY-MM-DD)', statementRefL: 'அறிக்கையில் உள்ள குறிப்பு', match: 'வங்கி அறிக்கையுடன் பொருத்து',
    matchedNow: 'பொருத்தப்பட்டது — பணம் ஒருமுறை பதிவானது, வாடிக்கையாளரின் நிலுவை குறைந்தது.', alreadyMatched: 'ஏற்கனவே பொருத்தப்பட்டது — எதுவும் மாறவில்லை.',
    rejectWhyL: 'ஏன் நிராகரிக்கப்படுகிறது (வாடிக்கையாளர் இதைப் படிப்பார்)', reject: 'இந்தக் குறிப்பை நிராகரி', rejectedNow: 'நிராகரிக்கப்பட்டது — உங்கள் காரணத்துடன் குறிப்பு பதிவில் இருக்கும்.',
    needMatch: 'வங்கி அறிக்கையில் உள்ளபடியே ரூபாயில் தொகை, நாள் (YYYY-MM-DD), குறிப்பு — எழுதுங்கள்.', needWhy: 'ஏன் நிராகரிக்கப்படுகிறது என்று எழுதுங்கள்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பணி வாடிக்கையாளர் செலுத்துதல்களைப் பதிவு செய்ய முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கவோ சேமிக்கவோ இல்லை.',
  },
} as const;

export const transferNotesWords = (lang: Lang, key: string): string =>
  (B2B_TRANSFER_NOTES_COPY[lang] as Record<string, string>)[key] ?? (B2B_TRANSFER_NOTES_COPY.en as Record<string, string>)[key] ?? key;

export interface TransferNoteRow {
  readonly noteId: string; readonly customerId: string; readonly amountMinor: number; readonly transferredOn: string; readonly bankReference: string;
  readonly against: readonly string[]; readonly recordedBy: string; readonly state: 'pending' | 'matched' | 'rejected';
  readonly decidedBy?: string; readonly reason?: string; readonly receivedOn?: string;
}
export interface TransferNotesQueue { readonly notes: readonly TransferNoteRow[]; readonly pending: number; readonly pendingMinor: number; readonly asAt: string }
export interface MatchForm { readonly receivedRupees: string; readonly receivedOn: string; readonly bankReference: string }

type Why = 'nobody' | 'cannotRead' | 'needMatch' | 'needWhy';
type Done<T> = Promise<Outcome<T, Why>>;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Rupees as typed in whole paise, or null when it is not money above zero. */
export function paiseOfRupees(typed: string): number | null {
  const v = typed.replace(/[₹,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return null;
  const [whole, frac = ''] = v.split('.');
  const minor = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return minor > 0 && Number.isSafeInteger(minor) ? minor : null;
}

/** What the bank statement shows, as the match route reads it, or null when incomplete. */
export function matchBody(f: MatchForm): { readonly receivedMinor: number; readonly receivedOn: string; readonly bankReference: string } | null {
  const receivedMinor = paiseOfRupees(f.receivedRupees);
  const on = f.receivedOn.trim(); const ref = f.bankReference.trim();
  if (receivedMinor === null || !DAY.test(on) || Number.isNaN(Date.parse(`${on}T00:00:00.000Z`)) || ref === '') return null;
  return { receivedMinor, receivedOn: on, bankReference: ref };
}

export const transferNotesOutcomeWords = (lang: Lang, out: Outcome<unknown>, good: string): string => {
  if (out.result !== 'ok') return outcomeIn((k) => transferNotesWords(lang, k), out);
  return transferNotesWords(lang, (out.value as { alreadyMatched?: boolean } | undefined)?.alreadyMatched === true ? 'alreadyMatched' : good);
};

export interface TransferNotesSession {
  readonly may: { readonly named: boolean; readonly record: boolean };
  queue(): Done<TransferNotesQueue>;
  match(noteId: string, f: MatchForm): Done<{ readonly alreadyMatched?: boolean }>;
  reject(noteId: string, why: string): Done<unknown>;
}

export function createTransferNotesSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string;
}): TransferNotesSession {
  const named = input.viewer?.userId !== undefined;
  const may = { named, record: named && (input.viewer?.permissions ?? []).includes('b2b.receivable.record') };
  const call = makeCaller({ keyPrefix: 'b2b-transfer-notes', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const gate = (): { result: 'invalid'; why: Why } | undefined => (!named ? { result: 'invalid', why: 'nobody' } : !may.record ? { result: 'invalid', why: 'cannotRead' } : undefined);
  const enc = (s: string): string => encodeURIComponent(s.trim());
  return {
    may,
    queue: async () => gate() ?? call('GET', '/v1/b2b/transfer-notes'),
    match: async (noteId, f) => {
      const no = gate(); if (no !== undefined) return no;
      const body = matchBody(f);
      if (body === null) return { result: 'invalid', why: 'needMatch' };
      return call('POST', `/v1/b2b/transfer-notes/${enc(noteId)}/match`, body);
    },
    reject: async (noteId, why) => {
      const no = gate(); if (no !== undefined) return no;
      if (why.trim() === '') return { result: 'invalid', why: 'needWhy' };
      return call('POST', `/v1/b2b/transfer-notes/${enc(noteId)}/reject`, { reason: why.trim() });
    },
  };
}
