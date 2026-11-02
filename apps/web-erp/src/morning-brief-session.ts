// EA-07 (R4, signed OB-227 · OB-222) — the Morning brief page's tested, DOM-free session: today's brief as head office
// prepared it from the governed figures (no AI), and whether it was sent. Sending is a switched-off link, so the answer
// says "not sent" — this session shows it and changes nothing.
// W3 (D13-FR-01..06): the brief's SCHEDULE, which no screen set — the shop time it is due, its language and how old the
// figures may be before it warns they are not live (`GET`/`POST /v1/reporting/brief-schedule`, `owner.brief.manage` to
// change it; head office re-checks). Who it is sent to is not set here: sending waits for a provider (OB-222).

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
    scheduleH: 'When the brief is prepared', dueAt: 'Time (shop time)', language: 'Language', staleMinutes: 'Warn when the figures are older than (minutes, optional)',
    lang_en: 'English', lang_ta: 'Tamil', saveSchedule: 'Save the schedule', notSet: 'No schedule is set yet — choose a time and save.', setTo: 'Set to', sentDays: 'days already sent',
    scheduleSaved: 'Saved. The brief is prepared at', recipientsNote: 'Who receives it on the phone is set when sending is switched on (OB-222); nothing is sent until then.',
    cannotManage: 'You can see the schedule; changing it is the owner\'s.', needTime: 'Type the time as HH:MM, e.g. 07:30.', needStale: 'Type the minutes as a whole number above 0, or leave it empty.',
  },
  ta: {
    lang: 'English', title: 'காலைச் சுருக்கம்',
    lead: 'உரிமையாளரின் சுருக்கம் ஒவ்வொரு நாளும் கடையின் சொந்த எண்களிலிருந்து, AI இல்லாமல் தயாரிக்கப்படுகிறது. நீங்கள் ஒரு வழங்குநரைத் தேர்ந்தெடுக்கும் வரை தொலைபேசிக்கு அனுப்புவது நிறுத்தப்பட்டுள்ளது (OB-222) — எதுவும் அனுப்பப்படவில்லை.',
    show: 'இன்றைய சுருக்கத்தைக் காட்டு', briefH: 'இன்றைய சுருக்கம்', sentK: 'அனுப்பப்பட்டதா?', notSent: 'அனுப்பப்படவில்லை', sent: 'அனுப்பப்பட்டது',
    switchedOff: 'தயாரிக்கப்பட்டது, அனுப்பப்படவில்லை: அனுப்புதல் நிறுத்தப்பட்டுள்ளது (OB-222). எதுவும் அனுப்பப்படவில்லை.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்கவோ மாற்றவோ முடியாது.', cannotRead: 'உங்கள் பங்கு சுருக்கத்தைப் படிக்க முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் மாற்றப்படவில்லை.',
    scheduleH: 'சுருக்கம் தயாராகும் நேரம்', dueAt: 'நேரம் (கடை நேரம்)', language: 'மொழி', staleMinutes: 'எண்கள் இதைவிடப் பழையதானால் எச்சரி (நிமிடங்கள், விருப்பம்)',
    lang_en: 'ஆங்கிலம்', lang_ta: 'தமிழ்', saveSchedule: 'அட்டவணையைச் சேமி', notSet: 'இன்னும் அட்டவணை அமைக்கப்படவில்லை — நேரத்தைத் தேர்ந்தெடுத்துச் சேமியுங்கள்.', setTo: 'அமைக்கப்பட்டது', sentDays: 'ஏற்கனவே அனுப்பிய நாட்கள்',
    scheduleSaved: 'சேமிக்கப்பட்டது. சுருக்கம் தயாராகும் நேரம்', recipientsNote: 'ஃபோனில் யார் பெறுவார் என்பது அனுப்புதல் இயக்கப்படும்போது அமைக்கப்படும் (OB-222); அதுவரை எதுவும் அனுப்பப்படாது.',
    cannotManage: 'அட்டவணையைப் பார்க்கலாம்; மாற்றுவது உரிமையாளரின் பணி.', needTime: 'நேரத்தை HH:MM என்று தட்டச்சு செய்யுங்கள், எ.கா. 07:30.', needStale: 'நிமிடங்களை 0-க்கு மேற்பட்ட முழு எண்ணாகத் தட்டச்சு செய்யுங்கள், அல்லது காலியாக விடுங்கள்.',
  },
} as const;
export type BriefCopyKey = keyof typeof BRIEF_COPY.en;
export const briefWords = (lang: Lang, key: BriefCopyKey | string): string => (BRIEF_COPY[lang] as Record<string, string>)[key] ?? (BRIEF_COPY.en as Record<string, string>)[key] ?? key;
export const briefOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => briefWords(lang, k), out);

/** The brief's schedule as head office holds it; `set: false` before anyone set one (never a made-up time). */
export type BriefScheduleView =
  | { readonly set: false }
  | { readonly set: true; readonly dueAt: string; readonly language: 'en' | 'ta'; readonly staleAfterMinutes: number | null; readonly sentDays: number };

const two = (n: number): string => String(n).padStart(2, '0');

export interface BriefSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly manage: boolean };
  today(): Promise<Outcome<BriefTodayView>>;
  schedule(): Promise<Outcome<BriefScheduleView, 'nobody' | 'cannotRead'>>;
  setSchedule(input: { readonly dueAt: string; readonly language: string; readonly staleMinutes: string }): Promise<Outcome<{ readonly dueAt: string }, 'nobody' | 'cannotManage' | 'needTime' | 'needStale'>>;
}

export function createBriefSession(input: { readonly viewer: ViewerIdentity | undefined; readonly fetch?: typeof globalThis.fetch }): BriefSession {
  const perms = new Set(input.viewer?.permissions ?? []);
  const named = input.viewer?.userId !== undefined;
  const may = { named, read: named && perms.has('owner.kpi.read'), manage: named && perms.has('owner.brief.manage') };
  const call = makeCaller({ keyPrefix: 'brief', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  return {
    may,
    today: async () => (!named ? { result: 'invalid', why: 'nobody' } : !may.read ? { result: 'invalid', why: 'cannotRead' } : call('GET', '/v1/reporting/brief-today')),
    schedule: async () => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      if (!may.read) return { result: 'invalid', why: 'cannotRead' };
      const out = await call<{ schedule?: { dueAt?: unknown; language?: unknown; staleAfterMinutes?: unknown; sentDays?: unknown } }>('GET', '/v1/reporting/brief-schedule');
      // Head office says it holds no schedule yet: that is "not set", never a default time.
      if (out.result === 'refused' && out.code === 'no_brief_schedule') return { result: 'ok', value: { set: false } };
      if (out.result !== 'ok') return out;
      const s = out.value.schedule;
      const d = Array.isArray(s?.dueAt) ? s.dueAt : [];
      if (typeof d[0] !== 'number' || typeof d[1] !== 'number') return { result: 'ok', value: { set: false } };
      return { result: 'ok', value: { set: true, dueAt: `${two(d[0])}:${two(d[1])}`, language: s?.language === 'ta' ? 'ta' : 'en', staleAfterMinutes: typeof s?.staleAfterMinutes === 'number' ? s.staleAfterMinutes : null, sentDays: Array.isArray(s?.sentDays) ? s.sentDays.length : 0 } };
    },
    setSchedule: async (a) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      if (!may.manage) return { result: 'invalid', why: 'cannotManage' };
      const m = /^(\d{1,2}):(\d{2})$/.exec(a.dueAt.trim());
      if (m === null || Number(m[1]) > 23 || Number(m[2]) > 59) return { result: 'invalid', why: 'needTime' };
      const stale = a.staleMinutes.trim();
      if (stale !== '' && (!/^\d{1,5}$/.test(stale) || Number(stale) <= 0)) return { result: 'invalid', why: 'needStale' };
      const dueAt = [Number(m[1]), Number(m[2])] as const;
      const out = await call('POST', '/v1/reporting/brief-schedule', { dueAt, language: a.language === 'ta' ? 'ta' : 'en', ...(stale === '' ? {} : { staleAfterMinutes: Number(stale) }) });
      return out.result === 'ok' ? { result: 'ok', value: { dueAt: `${two(dueAt[0])}:${two(dueAt[1])}` } } : out;
    },
  };
}
