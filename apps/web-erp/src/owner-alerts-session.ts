// The "Owner alerts and scheduled reports" page (OB-288 lane 4 · P2 · M29-FR-03 · M29-FR-04). A tested, DOM-free session.
//
//   • THE SIX ALERTS — large discount, voided bill, price override, after-hours sign-in, cash short and (OB-365) failed till
//     sign-ins. Each threshold is the owner's and shows "Not set — this alert does not fire until you enter it" until he
//     enters it; one head office cannot yet judge (no till sign-in log has arrived) says so even once set. Only the owner
//     saves or clears one (head office re-checks).
//   • TODAY — what the synced records hold for each, the alerts the owner's thresholds raise, and whether each is already in
//     the owners' alert inbox; "Check now" runs the same pass the worker runs on its timer.
//   • SCHEDULED REPORTS AND EXPORTS — the owner's schedules, each prepared by itself at the shop's time, with its latest run
//     ("prepared, not sent" while sending is switched off, OB-222).
// Nothing is read before the person may see it; every write is a person's explicit click, in their own name.

import { makeCaller, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';
export type AlertKind = 'large_discount' | 'voided_bill' | 'price_override' | 'after_hours_login' | 'cash_short' | 'failed_sign_in';
// OB-365: the sixth, failed sign-ins at a till, from the store computer's sign-in log.
export const ALERT_KINDS: readonly AlertKind[] = ['large_discount', 'voided_bill', 'price_override', 'after_hours_login', 'cash_short', 'failed_sign_in'];
/** How each threshold is typed on screen: rupees, a count, or opening–closing hours. */
export const ALERT_INPUT: Readonly<Record<AlertKind, 'rupees' | 'count' | 'hours'>> = {
  large_discount: 'rupees', voided_bill: 'count', price_override: 'count', after_hours_login: 'hours', cash_short: 'rupees', failed_sign_in: 'count',
};

export const OWNER_ALERTS_COPY = {
  en: {
    title: 'Owner alerts and scheduled reports', lead: 'Your six exception alerts reach your alert inbox by themselves, even when you are away. Each fires only once you set its number. Your scheduled reports and exports are prepared at the shop\'s time with nobody pressing anything.',
    thresholdsH: 'Your six alerts', todayH: 'Today', schedulesH: 'Scheduled reports and exports',
    large_discount: 'Large discount on one bill (₹)', voided_bill: 'Voided bills by one person in a day', price_override: 'Price overrides by one person in a day', after_hours_login: 'After-hours sign-in (trading hours, e.g. 8-23)', cash_short: 'Till short at its close (₹)', failed_sign_in: 'Failed till sign-ins by one staff ID in a day',
    notSet: 'Not set — this alert does not fire until you enter it.', setTo: 'Set to', setBy: 'by', cannotFire: 'Set, but it cannot fire:',
    save: 'Save', clear: 'Switch off', clearWhy: 'Why switch it off (required)', checkNow: 'Check now',
    recorded: 'recorded', alerts: 'alert(s)', inInbox: 'in your alert inbox', notInInbox: 'not yet in your alert inbox', notKnown: 'not known',
    noAlerts: 'No alert today from the thresholds you set.', raised: 'Alerts newly sent to your inbox:',
    scheduleId: 'Schedule name', kind: 'What', kindReport: 'Report', kindExport: 'Export', target: 'Report id or export domain', time: 'Time (HH:MM, shop time)', language: 'Language',
    saveSchedule: 'Save the schedule', runNow: 'Prepare what is due now', stop: 'Stop', stopWhy: 'Why stop it (required)', noSchedules: 'No report or export is scheduled yet.',
    lastRun: 'Last prepared', never: 'not prepared yet', runs: 'run(s)', stopped: 'stopped', prepared: 'Prepared', sendingOff: 'Prepared, not sent: sending is switched off (no message provider is chosen).',
    needValue: 'Type the number first.', needRupees: 'Type the amount in rupees, more than nought (for example 500 or 500.50).', needCount: 'Type a whole number, at least 1.', needHours: 'Type the trading hours as opening-closing, whole hours (for example 8-23).',
    needReason: 'Write why first.', needSchedule: 'Give the schedule a name, choose what it prepares, and a time as HH:MM.',
    saved: 'Saved.', nobody: 'Nobody is signed in on this screen — you can read nothing.', cannotRead: 'Your role cannot open this page.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved.',
  },
  ta: {
    title: 'உரிமையாளர் எச்சரிக்கைகள் மற்றும் திட்டமிட்ட அறிக்கைகள்', lead: 'உங்கள் ஆறு விதிவிலக்கு எச்சரிக்கைகள் நீங்கள் கடையில் இல்லாதபோதும் தானாகவே உங்கள் எச்சரிக்கைப் பெட்டிக்கு வரும். ஒவ்வொன்றும் அதன் எண்ணை நீங்கள் அமைத்த பிறகே செயல்படும். உங்கள் திட்டமிட்ட அறிக்கைகளும் ஏற்றுமதிகளும் கடையின் நேரத்தில் யாரும் அழுத்தாமலேயே தயாராகும்.',
    thresholdsH: 'உங்கள் ஆறு எச்சரிக்கைகள்', todayH: 'இன்று', schedulesH: 'திட்டமிட்ட அறிக்கைகள் மற்றும் ஏற்றுமதிகள்',
    large_discount: 'ஒரு பில்லில் பெரிய தள்ளுபடி (₹)', voided_bill: 'ஒருவர் ஒரு நாளில் ரத்து செய்த பில்கள்', price_override: 'ஒருவர் ஒரு நாளில் செய்த விலை மாற்றங்கள்', after_hours_login: 'நேரம் கடந்த உள்நுழைவு (வணிக நேரம், எ.கா. 8-23)', cash_short: 'மூடும்போது கல்லாவில் குறைவு (₹)', failed_sign_in: 'ஒரு பணியாளர் எண் ஒரு நாளில் தவறிய கல்லா உள்நுழைவுகள்',
    notSet: 'அமைக்கப்படவில்லை — இதை நீங்கள் உள்ளிடும் வரை இந்த எச்சரிக்கை செயல்படாது.', setTo: 'அமைக்கப்பட்டது', setBy: 'அமைத்தவர்', cannotFire: 'அமைக்கப்பட்டது, ஆனால் செயல்பட முடியாது:',
    save: 'சேமி', clear: 'நிறுத்து', clearWhy: 'ஏன் நிறுத்துகிறீர்கள் (தேவை)', checkNow: 'இப்போது சரிபார்',
    recorded: 'பதிவானவை', alerts: 'எச்சரிக்கை(கள்)', inInbox: 'உங்கள் எச்சரிக்கைப் பெட்டியில் உள்ளது', notInInbox: 'இன்னும் உங்கள் எச்சரிக்கைப் பெட்டியில் இல்லை', notKnown: 'தெரியாது',
    noAlerts: 'நீங்கள் அமைத்த எண்களால் இன்று எந்த எச்சரிக்கையும் இல்லை.', raised: 'உங்கள் பெட்டிக்கு புதிதாக அனுப்பப்பட்ட எச்சரிக்கைகள்:',
    scheduleId: 'திட்டத்தின் பெயர்', kind: 'என்ன', kindReport: 'அறிக்கை', kindExport: 'ஏற்றுமதி', target: 'அறிக்கை எண் அல்லது ஏற்றுமதிப் பகுதி', time: 'நேரம் (HH:MM, கடை நேரம்)', language: 'மொழி',
    saveSchedule: 'திட்டத்தைச் சேமி', runNow: 'இப்போது நிலுவையில் உள்ளதைத் தயார் செய்', stop: 'நிறுத்து', stopWhy: 'ஏன் நிறுத்துகிறீர்கள் (தேவை)', noSchedules: 'இன்னும் எந்த அறிக்கையும் ஏற்றுமதியும் திட்டமிடப்படவில்லை.',
    lastRun: 'கடைசியாகத் தயாரானது', never: 'இன்னும் தயாராகவில்லை', runs: 'ஓட்டம்(கள்)', stopped: 'நிறுத்தப்பட்டது', prepared: 'தயாரானது', sendingOff: 'தயாரானது, அனுப்பப்படவில்லை: அனுப்புதல் நிறுத்தப்பட்டுள்ளது (செய்தி வழங்குநர் தேர்வு செய்யப்படவில்லை).',
    needValue: 'முதலில் எண்ணைத் தட்டச்சு செய்யவும்.', needRupees: 'தொகையை ரூபாயில், பூஜ்ஜியத்தை விட அதிகமாகத் தட்டச்சு செய்யவும் (எ.கா. 500 அல்லது 500.50).', needCount: 'குறைந்தது 1 என்ற முழு எண்ணைத் தட்டச்சு செய்யவும்.', needHours: 'வணிக நேரத்தைத் திறப்பு-மூடல் என முழு மணிகளில் தட்டச்சு செய்யவும் (எ.கா. 8-23).',
    needReason: 'முதலில் ஏன் என்று எழுதவும்.', needSchedule: 'திட்டத்துக்கு ஒரு பெயர், அது தயாரிப்பது என்ன, HH:MM என்ற நேரம் கொடுக்கவும்.',
    saved: 'சேமிக்கப்பட்டது.', nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்க முடியாது.', cannotRead: 'உங்கள் பங்கு இந்தப் பக்கத்தைத் திறக்க முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கவோ சேமிக்கவோ இல்லை.',
  },
} as const;

export const ownerAlertsWords = (lang: Lang, key: string): string =>
  (OWNER_ALERTS_COPY[lang] as Record<string, string>)[key] ?? (OWNER_ALERTS_COPY.en as Record<string, string>)[key] ?? key;

export function ownerAlertsOutcomeWords(lang: Lang, out: Outcome<unknown>): string {
  const w = (k: string) => ownerAlertsWords(lang, k);
  if (out.result === 'refused') return `${w('refused')} ${out.whatHappened}`;
  if (out.result === 'invalid') return w(out.why);
  if (out.result === 'lost_link') return w('unreachable');
  return w('saved');
}

/** "500" / "500.50" → paise; anything else → undefined. */
export function paiseOfRupees(raw: string): number | undefined {
  const v = raw.trim().replace(/,/g, '');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(v)) return undefined;
  const p = Math.round(Number(v) * 100);
  return p > 0 ? p : undefined;
}
/** "8-23" → { opensAtHour: 8, closesAtHour: 23 }; anything else → undefined. */
export function hoursOfText(raw: string): { opensAtHour: number; closesAtHour: number } | undefined {
  const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(raw);
  if (m === null) return undefined;
  const o = Number(m[1]); const c = Number(m[2]);
  return o >= 0 && o <= 23 && c >= 1 && c <= 24 && o < c ? { opensAtHour: o, closesAtHour: c } : undefined;
}
/** A threshold value as the screen shows it. */
export function shownValue(kind: AlertKind, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (ALERT_INPUT[kind] === 'rupees' && typeof value === 'number') return `₹${(value / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (ALERT_INPUT[kind] === 'hours' && typeof value === 'object') { const h = value as { opensAtHour: number; closesAtHour: number }; return `${h.opensAtHour}-${h.closesAtHour}`; }
  return String(value);
}

export interface ThresholdRow { readonly kind: AlertKind; readonly state: 'set' | 'not_set'; readonly value: unknown; readonly setBy: string | null; readonly setAt: string | null; readonly canFire: boolean; readonly whyNot?: string }
export interface TodayView {
  readonly tradingDay: string;
  readonly kinds: readonly { readonly kind: AlertKind; readonly threshold: string; readonly events: number | null; readonly alerts: number; readonly say: string }[];
  readonly alerts: readonly { readonly kind: AlertKind; readonly headline: string; readonly inboxId: string; readonly inOwnersInbox: boolean; readonly count: number; readonly valueMinor: number }[];
}
export interface ScheduleRow {
  readonly schedule: { readonly scheduleId: string; readonly kind: 'report' | 'export'; readonly target: string; readonly dueAt: readonly [number, number]; readonly language: Lang; readonly status: 'active' | 'stopped' };
  readonly runs: number;
  readonly lastRun: { readonly tradingDay: string; readonly outcome: string; readonly sending: string; readonly lines: readonly string[] } | null;
}

export interface OwnerAlertsSession {
  readonly may: { readonly named: boolean; readonly open: boolean; readonly manage: boolean; readonly schedulesRead: boolean; readonly schedule: boolean };
  readThresholds(): Promise<Outcome<{ readonly thresholds: readonly ThresholdRow[]; readonly notSet: readonly AlertKind[] }>>;
  setThreshold(kind: AlertKind, typed: string): Promise<Outcome<unknown, 'needValue' | 'needRupees' | 'needCount' | 'needHours'>>;
  clearThreshold(kind: AlertKind, reason: string): Promise<Outcome<unknown, 'needReason'>>;
  readToday(): Promise<Outcome<TodayView>>;
  checkNow(): Promise<Outcome<{ readonly raised: number }>>;
  readSchedules(): Promise<Outcome<{ readonly schedules: readonly ScheduleRow[]; readonly sending: string }>>;
  saveSchedule(input: { readonly scheduleId: string; readonly kind: string; readonly target: string; readonly time: string; readonly language: string }): Promise<Outcome<unknown, 'needSchedule'>>;
  stopSchedule(scheduleId: string, reason: string): Promise<Outcome<unknown, 'needReason'>>;
  runNow(): Promise<Outcome<{ readonly prepared: number }>>;
}

export function createOwnerAlertsSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string }): OwnerAlertsSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = {
    named, open: named && held.has('owner.alert.read'), manage: named && held.has('owner.alert.manage'),
    schedulesRead: named && held.has('owner.kpi.read'), schedule: named && held.has('owner.report.schedule'),
  };
  const call = makeCaller({ keyPrefix: 'owner-alerts', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  return {
    may,
    readThresholds: () => call('GET', '/v1/reporting/owner-alert-thresholds'),
    setThreshold: async (kind, typed) => {
      if (typed.trim() === '') return { result: 'invalid', why: 'needValue' };
      const how = ALERT_INPUT[kind];
      let value: unknown;
      if (how === 'rupees') { value = paiseOfRupees(typed); if (value === undefined) return { result: 'invalid', why: 'needRupees' }; }
      else if (how === 'count') { const n = Number(typed.trim()); if (!/^\d+$/.test(typed.trim()) || n < 1) return { result: 'invalid', why: 'needCount' }; value = n; }
      else { value = hoursOfText(typed); if (value === undefined) return { result: 'invalid', why: 'needHours' }; }
      return call('POST', `/v1/reporting/owner-alert-thresholds/${kind}`, { value });
    },
    clearThreshold: async (kind, reason) => {
      if (reason.trim() === '') return { result: 'invalid', why: 'needReason' };
      return call('POST', `/v1/reporting/owner-alert-thresholds/${kind}`, { clear: true, reason: reason.trim() });
    },
    readToday: () => call('GET', '/v1/reporting/owner-exceptions'),
    checkNow: () => call('POST', '/v1/reporting/owner-exceptions/raise', {}),
    readSchedules: () => call('GET', '/v1/reporting/report-schedules'),
    saveSchedule: async ({ scheduleId, kind, target, time, language }) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
      if (scheduleId.trim() === '' || (kind !== 'report' && kind !== 'export') || target.trim() === '' || m === null || Number(m[1]) > 23 || Number(m[2]) > 59) return { result: 'invalid', why: 'needSchedule' };
      return call('POST', `/v1/reporting/report-schedules/${encodeURIComponent(scheduleId.trim())}`, { kind, target: target.trim(), dueAt: [Number(m[1]), Number(m[2])], language: language === 'ta' ? 'ta' : 'en' });
    },
    stopSchedule: async (scheduleId, reason) => {
      if (reason.trim() === '') return { result: 'invalid', why: 'needReason' };
      return call('POST', `/v1/reporting/report-schedules/${encodeURIComponent(scheduleId)}/stop`, { reason: reason.trim() });
    },
    runNow: () => call('POST', '/v1/reporting/report-schedules/run', {}),
  };
}
