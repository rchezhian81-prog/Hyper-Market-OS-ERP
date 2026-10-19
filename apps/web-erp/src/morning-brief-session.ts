// EA-07 (R4, signed OB-227 · OB-222) — the Morning brief page's tested, DOM-free session: today's brief as head office
// prepared it from the governed figures (no AI), and whether it was sent. Sending is a switched-off link, so the answer
// says "not sent" — this session shows it and changes nothing.

import type { ViewerIdentity } from './browser-entry';
import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';
export interface BriefTodayView {
  readonly tradingDay?: string; readonly prepared: boolean; readonly lines?: readonly string[]; readonly deterministic?: boolean;
  readonly sending: 'on' | 'switched_off'; readonly sent: boolean; readonly detail: string;
}

export const BRIEF_COPY = {
  en: {
    lang: 'தமிழ்', title: 'Morning brief',
    lead: 'The owner\'s brief is prepared every day from the shop\'s own figures, with no AI. Sending it to a phone is switched off until you choose a provider (OB-222) — nothing is sent.',
    show: 'Show today\'s brief', briefH: 'Today\'s brief', sentK: 'Sent?', notSent: 'Not sent', sent: 'Sent',
    switchedOff: 'Prepared, NOT sent: sending is switched off (OB-222). Nothing was sent.',
    nobody: 'Nobody is signed in on this screen — you can read nothing and change nothing.', cannotRead: 'Your role cannot read the brief.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was changed.',
  },
  ta: {
    lang: 'English', title: 'காலைச் சுருக்கம்',
    lead: 'உரிமையாளரின் சுருக்கம் ஒவ்வொரு நாளும் கடையின் சொந்த எண்களிலிருந்து, AI இல்லாமல் தயாரிக்கப்படுகிறது. நீங்கள் ஒரு வழங்குநரைத் தேர்ந்தெடுக்கும் வரை தொலைபேசிக்கு அனுப்புவது நிறுத்தப்பட்டுள்ளது (OB-222) — எதுவும் அனுப்பப்படவில்லை.',
    show: 'இன்றைய சுருக்கத்தைக் காட்டு', briefH: 'இன்றைய சுருக்கம்', sentK: 'அனுப்பப்பட்டதா?', notSent: 'அனுப்பப்படவில்லை', sent: 'அனுப்பப்பட்டது',
    switchedOff: 'தயாரிக்கப்பட்டது, அனுப்பப்படவில்லை: அனுப்புதல் நிறுத்தப்பட்டுள்ளது (OB-222). எதுவும் அனுப்பப்படவில்லை.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்கவோ மாற்றவோ முடியாது.', cannotRead: 'உங்கள் பங்கு சுருக்கத்தைப் படிக்க முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் மாற்றப்படவில்லை.',
  },
} as const;
export type BriefCopyKey = keyof typeof BRIEF_COPY.en;
export const briefWords = (lang: Lang, key: BriefCopyKey | string): string => (BRIEF_COPY[lang] as Record<string, string>)[key] ?? (BRIEF_COPY.en as Record<string, string>)[key] ?? key;
export const briefOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => briefWords(lang, k), out);

export interface BriefSession {
  readonly may: { readonly named: boolean; readonly read: boolean };
  today(): Promise<Outcome<BriefTodayView>>;
}

export function createBriefSession(input: { readonly viewer: ViewerIdentity | undefined; readonly fetch?: typeof globalThis.fetch }): BriefSession {
  const perms = new Set(input.viewer?.permissions ?? []);
  const named = input.viewer?.userId !== undefined;
  const may = { named, read: named && perms.has('owner.kpi.read') };
  const call = makeCaller({ keyPrefix: 'brief', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  return {
    may,
    today: async () => (!named ? { result: 'invalid', why: 'nobody' } : !may.read ? { result: 'invalid', why: 'cannotRead' } : call('GET', '/v1/reporting/brief-today')),
  };
}
