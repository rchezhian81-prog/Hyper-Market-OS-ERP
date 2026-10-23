// The Tally files page — the accountant's daily Tally import file (OB-293 · M23-FR-01/04 · M32-FR-04 · D10-FR-06 ·
// D14-FR-03 · P-07 · P-08 · hard rule #6). A tested, DOM-free session.
//
// It reads head office's daily Tally outbox (GET /v1/finance/tally/outbox) on a click: one file per ended trading day
// carrying EVERY journal of that day (sales, returns, GST, cash, bank, payables, receivables, stock), what each file
// holds by family, and the DEAD LETTER — a day Tally could not be given, kept with the reason, never dropped. The
// accountant downloads a day's XML to import into Tally (each download is recorded by head office), REQUEUES a dead
// day once the cause is fixed (with what was fixed — the original stays on the record), and can ask for one pass now.
// It also reads a month's trial balance (GET /v1/finance/periods/:period/trial-balance). Nothing is read on open, and
// nothing is a zero that was not counted: no ledger names means "waiting for the ledger names", said in words.

import type { ViewerIdentity } from './browser-entry';
import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';
export type PostingState = 'queued' | 'posted' | 'dead_lettered';
export interface FamilyTotal { readonly family: string; readonly journals: number; readonly debitMinor: number; readonly creditMinor: number }
export interface PostingView {
  readonly postingId: string; readonly day: string; readonly sequence: number; readonly period: string; readonly state: PostingState;
  readonly attempts: number; readonly journals: number; readonly debitMinor: number; readonly creditMinor: number;
  readonly lastFailure: string | null; readonly corrects: string | null; readonly waitingFor: 'ledger_names' | null;
  readonly nextAttemptAt: string | null; readonly postedAt: string | null; readonly deadLetteredAt: string | null;
  /** A dead-lettered day's requeue, when a person has requeued it (the dead-lettered record itself never changes). */
  readonly correctedBy: { readonly postingId: string; readonly state: PostingState } | null;
  readonly file: { readonly fileName: string; readonly sha256: string; readonly byFamily: readonly FamilyTotal[] } | null;
}
export interface OutboxRead {
  readonly postings: readonly PostingView[]; readonly deadLetters: readonly PostingView[];
  readonly counts: { readonly posted: number; readonly queued: number; readonly deadLettered: number };
  /** Dead-lettered days not yet carried by a posted requeue — what still waits for a person. */
  readonly openDeadLetters: number;
  readonly ledgerNames: { readonly companyName: string; readonly version: number } | null;
  readonly waitingFor: 'ledger_names' | null;
  readonly families: readonly { readonly family: string; readonly words: { readonly en: string; readonly ta: string } }[];
  readonly asAt: string;
}
export interface TallyFile { readonly fileName: string; readonly xml: string; readonly sha256: string; readonly downloadedBefore: readonly { readonly by: string; readonly at: string }[] }
export interface TrialBalanceRow { readonly account: string; readonly accountClass: string | null; readonly periodDebitMinor: number; readonly periodCreditMinor: number; readonly closingNetDebitMinor: number }
export interface TrialBalanceRead {
  readonly period: string; readonly rows: readonly TrialBalanceRow[]; readonly balanced: boolean; readonly outByMinor: number;
  readonly totals: { readonly closingDebitMinor: number; readonly closingCreditMinor: number }; readonly detail: string;
}

export const TALLY_FILES_COPY = {
  en: {
    lang: 'தமிழ்', title: 'Tally files',
    lead: 'One Tally import file for each trading day, carrying every journal of that day. Download a day and import it in Tally. A day Tally could not be given waits in the dead letter with the reason — it is never dropped.',
    read: 'Show the daily files', run: 'Make the files now', runDone: 'Done — files made:', runNone: 'Nothing new to make.',
    postedK: 'Ready', queuedK: 'Waiting', deadK: 'Dead letter', companyK: 'Tally company', notNamed: 'Not named yet',
    noNames: 'Waiting for the ledger names — the accountant has not named the Tally company and ledgers yet, so no file can be made.',
    s_posted: 'Ready to import', s_queued: 'Waiting', s_dead_lettered: 'In the dead letter',
    dayK: 'Day', journalsK: 'journals', attemptsK: 'tries', debitK: 'Debit', creditK: 'Credit', whyK: 'Why', correctsK: 'Requeued from', correctedByK: 'Requeued as', nextK: 'Next try',
    download: 'Download for Tally', downloaded: 'Saved as', downloadedBefore: 'Downloaded before by',
    requeue: 'Requeue this day', reasonL: 'What did you fix?', needReason: 'Say what you fixed before requeueing.', requeued: 'Requeued as',
    deadH: 'Dead letter — days Tally could not be given', filesH: 'Every day\'s file', noDead: 'Nothing in the dead letter.', noFiles: 'No day has ended since the books began — there is no file yet.',
    tbH: 'Trial balance for a month', monthL: 'Month (YYYY-MM)', tbRead: 'Show the trial balance', badMonth: 'Write the month as YYYY-MM.',
    accountK: 'Account', classK: 'Class', closingK: 'Closing', balanced: 'Balanced — debit and credit agree to the paisa.', outBy: 'OUT BY', unclassed: 'not classed',
    nobody: 'Nobody is signed in on this screen — you can read nothing.', cannotRead: 'Your role cannot read the books.', cannotConfigure: 'Your role cannot make or requeue Tally files.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or changed.',
  },
  ta: {
    lang: 'English', title: 'டேலி கோப்புகள்',
    lead: 'ஒவ்வொரு வணிக நாளுக்கும் ஒரு டேலி இறக்குமதிக் கோப்பு, அந்த நாளின் எல்லாப் பதிவுகளுடன். ஒரு நாளைப் பதிவிறக்கி டேலியில் இறக்குமதி செய்யுங்கள். டேலிக்குக் கொடுக்க முடியாத நாள் காரணத்துடன் தோல்விப் பட்டியலில் காத்திருக்கும் — அது ஒருபோதும் கைவிடப்படாது.',
    read: 'நாள் கோப்புகளைக் காட்டு', run: 'இப்போதே கோப்புகளை உருவாக்கு', runDone: 'முடிந்தது — உருவான கோப்புகள்:', runNone: 'புதிதாக உருவாக்க எதுவும் இல்லை.',
    postedK: 'தயார்', queuedK: 'காத்திருக்கிறது', deadK: 'தோல்விப் பட்டியல்', companyK: 'டேலி நிறுவனம்', notNamed: 'இன்னும் பெயரிடப்படவில்லை',
    noNames: 'பேரேட்டுப் பெயர்களுக்காகக் காத்திருக்கிறது — கணக்காளர் டேலி நிறுவனத்தையும் பேரேடுகளையும் இன்னும் பெயரிடவில்லை, எனவே கோப்பு உருவாக்க முடியாது.',
    s_posted: 'இறக்குமதிக்குத் தயார்', s_queued: 'காத்திருக்கிறது', s_dead_lettered: 'தோல்விப் பட்டியலில்',
    dayK: 'நாள்', journalsK: 'பதிவுகள்', attemptsK: 'முயற்சிகள்', debitK: 'பற்று', creditK: 'வரவு', whyK: 'காரணம்', correctsK: 'இதிலிருந்து மீண்டும் வரிசையில்', correctedByK: 'மீண்டும் வரிசையில் வைக்கப்பட்டது:', nextK: 'அடுத்த முயற்சி',
    download: 'டேலிக்காகப் பதிவிறக்கு', downloaded: 'இந்தப் பெயரில் சேமிக்கப்பட்டது', downloadedBefore: 'முன்பு பதிவிறக்கியவர்',
    requeue: 'இந்த நாளை மீண்டும் வரிசையில் வை', reasonL: 'நீங்கள் எதைச் சரிசெய்தீர்கள்?', needReason: 'மீண்டும் வரிசையில் வைக்கும் முன் எதைச் சரிசெய்தீர்கள் என்று சொல்லுங்கள்.', requeued: 'மீண்டும் வரிசையில்:',
    deadH: 'தோல்விப் பட்டியல் — டேலிக்குக் கொடுக்க முடியாத நாட்கள்', filesH: 'ஒவ்வொரு நாளின் கோப்பும்', noDead: 'தோல்விப் பட்டியலில் எதுவும் இல்லை.', noFiles: 'கணக்குகள் தொடங்கியதிலிருந்து எந்த நாளும் முடியவில்லை — இன்னும் கோப்பு இல்லை.',
    tbH: 'ஒரு மாதத்தின் இருப்பாய்வு', monthL: 'மாதம் (YYYY-MM)', tbRead: 'இருப்பாய்வைக் காட்டு', badMonth: 'மாதத்தை YYYY-MM என எழுதுங்கள்.',
    accountK: 'கணக்கு', classK: 'வகை', closingK: 'இறுதி இருப்பு', balanced: 'சமநிலை — பற்றும் வரவும் காசு வரை ஒத்துப்போகின்றன.', outBy: 'வித்தியாசம்', unclassed: 'வகைப்படுத்தப்படவில்லை',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்க முடியாது.', cannotRead: 'உங்கள் பங்கு கணக்குகளைப் படிக்க முடியாது.', cannotConfigure: 'உங்கள் பங்கு டேலி கோப்புகளை உருவாக்கவோ மீண்டும் வரிசையில் வைக்கவோ முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை, மாற்றப்படவில்லை.',
  },
} as const;
export const tallyFilesWords = (lang: Lang, key: string): string => (TALLY_FILES_COPY[lang] as Record<string, string>)[key] ?? (TALLY_FILES_COPY.en as Record<string, string>)[key] ?? key;
export const tallyFilesOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => tallyFilesWords(lang, k), out);

/** Rupees with paise, Indian grouping — from whole paise, never a float sum. */
export function rupees(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}₹${Math.floor(abs / 100).toLocaleString('en-IN')}.${String(abs % 100).padStart(2, '0')}`;
}

/** A family's words in the language, from what head office sent (never a guessed label). */
export function familyWords(read: OutboxRead, lang: Lang, family: string): string {
  return read.families.find((f) => f.family === family)?.words[lang] ?? family;
}

export interface TallyFilesSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly configure: boolean };
  read(): Promise<Outcome<OutboxRead>>;
  /** One pass now: how many day files were newly queued, made ready, and sent to the dead letter. */
  run(): Promise<Outcome<{ readonly queued: number; readonly posted: number; readonly deadLettered: number }>>;
  requeue(postingId: string, reason: string): Promise<Outcome<{ readonly requeued: boolean; readonly posting?: PostingView; readonly alreadyRequeuedAs?: string }>>;
  download(postingId: string): Promise<Outcome<TallyFile>>;
  trialBalance(period: string): Promise<Outcome<TrialBalanceRead>>;
}

export function createTallyFilesSession(input: { readonly viewer: ViewerIdentity | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string }): TallyFilesSession {
  const named = input.viewer?.userId !== undefined;
  const held = input.viewer?.permissions ?? [];
  const may = { named, read: named && held.includes('finance.period.read'), configure: named && held.includes('finance.posting.configure') };
  const call = makeCaller({ ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }), keyPrefix: 'tally-files' });
  const gateRead = (): Outcome<never> | undefined => (!named ? { result: 'invalid', why: 'nobody' } : !may.read ? { result: 'invalid', why: 'cannotRead' } : undefined);
  const gateWrite = (): Outcome<never> | undefined => gateRead() ?? (!may.configure ? { result: 'invalid', why: 'cannotConfigure' } : undefined);
  const enc = encodeURIComponent;
  return {
    may,
    read: async () => gateRead() ?? call<OutboxRead>('GET', '/v1/finance/tally/outbox'),
    run: async () => {
      const g = gateWrite(); if (g !== undefined) return g;
      const out = await call<{ readonly queued: readonly string[]; readonly posted: readonly string[]; readonly deadLettered: readonly string[] }>('POST', '/v1/finance/tally/outbox/run', {});
      if (out.result !== 'ok') return out;
      return { result: 'ok', value: { queued: out.value.queued.length, posted: out.value.posted.length, deadLettered: out.value.deadLettered.length } };
    },
    requeue: async (postingId, reason) => {
      const g = gateWrite(); if (g !== undefined) return g;
      if (reason.trim() === '') return { result: 'invalid', why: 'needReason' };
      return call('POST', `/v1/finance/tally/outbox/${enc(postingId)}/requeue`, { reason: reason.trim() });
    },
    download: async (postingId) => gateRead() ?? call<TallyFile>('GET', `/v1/finance/tally/files/${enc(postingId)}`),
    trialBalance: async (period) => {
      const g = gateRead(); if (g !== undefined) return g;
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period.trim())) return { result: 'invalid', why: 'badMonth' };
      return call<TrialBalanceRead>('GET', `/v1/finance/periods/${period.trim()}/trial-balance`);
    },
  };
}
