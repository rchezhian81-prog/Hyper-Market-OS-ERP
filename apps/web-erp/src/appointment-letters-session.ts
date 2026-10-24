// The Appointment letters page (C17 · OB-323 "generate from record + signed scan as HR evidence"). A tested, DOM-free
// session over head office's letter routes: the owner sets the letter's words (English and Tamil, "not set" until he
// does — the software never writes a legal letter's words); HR makes a letter for one person FROM THEIR RECORD (name,
// roles, store, hourly rate, the shop's registered name) on the day it takes effect; the signed copy is photographed and
// kept, with its SHA-256, as the HR evidence. Nobody makes their own letter (§28) — head office refuses it by name.

import { makeCaller, newId, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const LETTERS_COPY = {
  en: {
    title: 'Appointment letters', lead: 'A letter is made from the person\'s staff record in the owner\'s words, then the signed copy is photographed and kept as the record.',
    wordingH: 'The letter\'s words (owner)', wordingNotSet: 'The owner has not set the letter\'s words yet (not set). No letter can be made until he does.', wordingV: 'Words in use: version', setBy: 'set by',
    fields: 'Fields a letter fills: {{employerName}} {{employeeName}} {{employeeId}} {{roles}} {{branch}} {{effectiveFrom}} {{hourlyRate}} {{issuedOn}}',
    bodyEn: 'Words (English)', bodyTa: 'Words (Tamil)', saveWording: 'Save the words',
    makeH: 'Make a letter', employee: 'Staff id', effectiveFrom: 'Takes effect from', make: 'Make the letter',
    listH: 'Letters made', none: 'No letter has been made yet.', awaiting: 'waiting for the signed copy', signedKept: 'Signed copy kept', notSigned: 'Signed copy not kept yet', effective: 'from', issuedBy: 'made by',
    show: 'Show the letter', scan: 'Photo of the signed copy', keep: 'Keep the signed copy', pickFirst: 'Choose the photo first.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role does not make appointment letters.',
    saved: 'Saved.', needFields: 'Fill in every field first — English and Tamil both.', refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved.',
  },
  ta: {
    title: 'நியமனக் கடிதங்கள்', lead: 'பணியாளர் பதிவிலிருந்து உரிமையாளரின் சொற்களில் கடிதம் உருவாகும்; கையெழுத்திட்ட நகல் படம் எடுக்கப்பட்டு பதிவாக வைக்கப்படும்.',
    wordingH: 'கடிதத்தின் சொற்கள் (உரிமையாளர்)', wordingNotSet: 'கடிதத்தின் சொற்களை உரிமையாளர் இன்னும் அமைக்கவில்லை (அமைக்கப்படவில்லை). அவர் அமைக்கும் வரை கடிதம் உருவாக்க முடியாது.', wordingV: 'பயன்பாட்டில் உள்ள சொற்கள்: பதிப்பு', setBy: 'அமைத்தவர்',
    fields: 'கடிதம் நிரப்பும் இடங்கள்: {{employerName}} {{employeeName}} {{employeeId}} {{roles}} {{branch}} {{effectiveFrom}} {{hourlyRate}} {{issuedOn}}',
    bodyEn: 'சொற்கள் (ஆங்கிலம்)', bodyTa: 'சொற்கள் (தமிழ்)', saveWording: 'சொற்களைச் சேமி',
    makeH: 'கடிதம் உருவாக்கு', employee: 'பணியாளர் எண்', effectiveFrom: 'நடைமுறைக்கு வரும் நாள்', make: 'கடிதத்தை உருவாக்கு',
    listH: 'உருவாக்கிய கடிதங்கள்', none: 'இன்னும் கடிதம் உருவாக்கப்படவில்லை.', awaiting: 'கையெழுத்து நகலுக்குக் காத்திருக்கிறது', signedKept: 'கையெழுத்து நகல் வைக்கப்பட்டது', notSigned: 'கையெழுத்து நகல் இன்னும் இல்லை', effective: 'முதல்', issuedBy: 'உருவாக்கியவர்',
    show: 'கடிதத்தைக் காட்டு', scan: 'கையெழுத்திட்ட நகலின் படம்', keep: 'கையெழுத்து நகலை வை', pickFirst: 'முதலில் படத்தைத் தேர்ந்தெடுக்கவும்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பணி நியமனக் கடிதங்களை உருவாக்குவதில்லை.',
    saved: 'சேமிக்கப்பட்டது.', needFields: 'முதலில் எல்லா இடங்களையும் நிரப்பவும் — ஆங்கிலம் மற்றும் தமிழ் இரண்டும்.', refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கவோ சேமிக்கவோ இல்லை.',
  },
} as const;

export const lettersWords = (lang: Lang, key: string): string =>
  (LETTERS_COPY[lang] as Record<string, string>)[key] ?? (LETTERS_COPY.en as Record<string, string>)[key] ?? key;
export const lettersOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => (out.result === 'ok' ? lettersWords(lang, 'saved') : outcomeIn((k) => lettersWords(lang, k), out));

export interface LetterRow { readonly letterId: string; readonly employeeId: string; readonly effectiveFrom: string; readonly wordingVersion: number; readonly issuedBy: string; readonly issuedAt: string; readonly signedCopyKept: boolean; readonly scans: number }
export interface Letter { readonly letterId: string; readonly employeeId: string; readonly textEn: string; readonly textTa: string; readonly effectiveFrom: string; readonly wordingVersion: number }

export interface AppointmentLettersSession {
  readonly may: { readonly named: boolean; readonly open: boolean; readonly wording: boolean };
  wording(): Promise<Outcome<{ readonly set: boolean; readonly wording?: { readonly version: number; readonly bodyEn: string; readonly bodyTa: string; readonly setBy: string; readonly setAt: string } }>>;
  setWording(bodyEn: string, bodyTa: string): Promise<Outcome<unknown, 'needFields'>>;
  make(employeeId: string, effectiveFrom: string): Promise<Outcome<{ readonly letter: Letter }, 'needFields'>>;
  letters(): Promise<Outcome<{ readonly letters: readonly LetterRow[]; readonly awaitingSignedCopy: number }>>;
  letter(letterId: string): Promise<Outcome<{ readonly letter: Letter }>>;
  keepSignedCopy(letterId: string, scan: { readonly mediaType: string; readonly contentBase64: string; readonly sha256: string } | null): Promise<Outcome<unknown, 'pickFirst'>>;
}

export function createAppointmentLettersSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string; readonly newLetterId?: () => string }): AppointmentLettersSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const call = makeCaller({ keyPrefix: 'letter', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const newLetterId = input.newLetterId ?? (() => newId('AL'));
  return {
    may: { named, open: named && held.has('hr.appointmentletter.issue'), wording: named && held.has('hr.appointmentletter.wording') },
    wording: () => call('GET', '/v1/hr/workforce/appointment-letters/wording'),
    setWording: async (bodyEn, bodyTa) => {
      if (bodyEn.trim() === '' || bodyTa.trim() === '') return { result: 'invalid', why: 'needFields' };
      return call('POST', '/v1/hr/workforce/appointment-letters/wording', { bodyEn, bodyTa });
    },
    make: async (employeeId, effectiveFrom) => {
      if (employeeId.trim() === '' || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) return { result: 'invalid', why: 'needFields' };
      return call('POST', `/v1/hr/workforce/employees/${encodeURIComponent(employeeId.trim())}/appointment-letters/${encodeURIComponent(newLetterId())}`, { effectiveFrom });
    },
    letters: () => call('GET', '/v1/hr/workforce/appointment-letters'),
    letter: (letterId) => call('GET', `/v1/hr/workforce/appointment-letters/${encodeURIComponent(letterId)}`),
    keepSignedCopy: async (letterId, scan) => {
      if (scan === null) return { result: 'invalid', why: 'pickFirst' };
      return call('POST', `/v1/hr/workforce/appointment-letters/${encodeURIComponent(letterId)}/signed-scan`, scan);
    },
  };
}
