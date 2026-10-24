// The facilities page's office parts (OB-288 LP/workforce package · audit-3 package 5) — two DOM-free, tested pieces:
//
//   • the OFFICE read (M26-FR-01/02/04), from head office: the asset register (warranty, AMC, last service), the health
//     alerts (critical first), every cold room and cabinet with its range, last reading and state (a quiet probe is a
//     fault, never a pass), the downtime summary, 30 days of energy with how much was estimated, and the incidents.
//     Read-only: nothing here clears an alert or closes an incident.
//   • the manual READING queue (M26-FR-02 "readings cache/queue offline"), served by the store computer: a person with the
//     right to record readings types the temperature on the probe for a room or cabinet; it is saved on this screen,
//     carried by the store computer to head office (the person re-checked there; a breach places the quality holds), and
//     shows where it has got to. Timed by when it was taken, not when the line came back.

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';
import type { SyncOutbox } from '../../../packages/sync/src/outbox';
import { createBoxQueue, STATE_KEYS, type BoxQueue } from './lpw-box-queue';

export type Lang = 'en' | 'ta';

export const FACILITIES_OFFICE_COPY = {
  en: {
    officeH: 'Assets, cold rooms and energy', branch: 'Store', asOf: 'As of (optional)', read: 'Read', assetsH: 'Asset register', alertsH: 'Needs attention', noAlerts: 'No asset needs attention.',
    equipmentH: 'Cold rooms and cabinets', downtimeH: 'Downtime', energyH: 'Energy (last 30 days)', incidentsH: 'Facility incidents', none: 'None.',
    warranty: 'warranty until', amc: 'AMC until', lastService: 'last serviced', never: 'never', notRecorded: 'not recorded', critical: 'critical', important: 'important', routine: 'routine',
    amc_expiring: 'AMC ending soon', amc_expired: 'AMC ended', amc_missing: 'No AMC recorded', warranty_expiring: 'Warranty ending soon', service_overdue: 'Service overdue', never_serviced: 'Never serviced',
    within_range: 'Within range', drifting: 'Drifting', breach: 'Out of range — stock on hold', no_data: 'No reading yet — a fault, not a pass', stale: 'Probe gone quiet — a fault, not a pass',
    range: 'range', last: 'last', minutesOut: 'minutes out of range', events: 'times down', minutes: 'minutes', unreported: 'unreported minutes', stillDown: 'still down',
    kwh: 'kWh', cost: 'cost', estimated: 'estimated', perDay: 'per day', notMeaningful: 'not meaningful (no readings)',
    open: 'open', closed: 'closed', evidence: 'evidence', daysLeft: 'days left', daysOver: 'days overdue',
    readingH: 'Take a reading', readingLead: 'Read the probe in each room or cabinet and type the temperature. It is saved here and the store computer carries it to head office.',
    readingAsOf: 'Rooms as the store computer last heard them, at', readingNone: 'The store computer has not been told the monitored rooms yet.', temperature: 'Temperature (°C)', source: 'From', manual_probe: 'Probe', log_sheet: 'Log sheet', save: 'Save the reading', lastAt: 'last reading',
    stSavedHere: 'Saved on this screen', stRetrying: 'Trying to reach the store computer', stHanded: 'With the store computer', stPosted: 'Booked at head office', stRefused: 'Refused — a person must look',
    notANumber: 'Type the temperature as a number, e.g. 3.5 or -18.', mayNotRecord: 'Your role does not record readings.', nobody: 'Nobody is signed in on this screen.',
    saved: 'Saved.', refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read.', needBranch: 'Type the store first.',
  },
  ta: {
    officeH: 'சொத்துகள், குளிர் அறைகள் மற்றும் மின்சாரம்', branch: 'கடை', asOf: 'நாள் (விருப்பம்)', read: 'படி', assetsH: 'சொத்துப் பதிவேடு', alertsH: 'கவனம் தேவை', noAlerts: 'எந்தச் சொத்துக்கும் கவனம் தேவையில்லை.',
    equipmentH: 'குளிர் அறைகள் மற்றும் அலமாரிகள்', downtimeH: 'செயலிழப்பு நேரம்', energyH: 'மின்சாரம் (கடந்த 30 நாள்)', incidentsH: 'வசதி நிகழ்வுகள்', none: 'எதுவும் இல்லை.',
    warranty: 'உத்தரவாதம் வரை', amc: 'AMC வரை', lastService: 'கடைசி சேவை', never: 'இல்லை', notRecorded: 'பதியப்படவில்லை', critical: 'முக்கியமானது', important: 'தேவையானது', routine: 'வழக்கமானது',
    amc_expiring: 'AMC விரைவில் முடிகிறது', amc_expired: 'AMC முடிந்தது', amc_missing: 'AMC பதியப்படவில்லை', warranty_expiring: 'உத்தரவாதம் விரைவில் முடிகிறது', service_overdue: 'சேவை தாமதம்', never_serviced: 'சேவை செய்யப்படவில்லை',
    within_range: 'வரம்பிற்குள்', drifting: 'விலகுகிறது', breach: 'வரம்பிற்கு வெளியே — சரக்கு நிறுத்தத்தில்', no_data: 'இன்னும் அளவீடு இல்லை — இது பழுது, தேர்ச்சி அல்ல', stale: 'அளவி அமைதியானது — இது பழுது, தேர்ச்சி அல்ல',
    range: 'வரம்பு', last: 'கடைசி', minutesOut: 'நிமிடங்கள் வரம்பிற்கு வெளியே', events: 'முறை செயலிழப்பு', minutes: 'நிமிடங்கள்', unreported: 'தெரிவிக்கப்படாத நிமிடங்கள்', stillDown: 'இன்னும் செயலிழப்பில்',
    kwh: 'kWh', cost: 'செலவு', estimated: 'மதிப்பீடு', perDay: 'ஒரு நாளுக்கு', notMeaningful: 'பொருளற்றது (அளவீடுகள் இல்லை)',
    open: 'திறந்தது', closed: 'மூடப்பட்டது', evidence: 'சான்று', daysLeft: 'நாட்கள் உள்ளன', daysOver: 'நாட்கள் தாமதம்',
    readingH: 'அளவீடு எடுங்கள்', readingLead: 'ஒவ்வொரு அறையிலும் அலமாரியிலும் அளவியைப் படித்து வெப்பநிலையைத் தட்டச்சு செய்யவும். இங்கே சேமிக்கப்பட்டு கடைக் கணினி தலைமை அலுவலகத்திற்குக் கொண்டு செல்லும்.',
    readingAsOf: 'கடைக் கணினி கடைசியாகக் கேட்ட அறைகள், நேரம்', readingNone: 'கண்காணிக்கப்படும் அறைகள் இன்னும் கடைக் கணினிக்குச் சொல்லப்படவில்லை.', temperature: 'வெப்பநிலை (°C)', source: 'எதிலிருந்து', manual_probe: 'அளவி', log_sheet: 'பதிவுத் தாள்', save: 'அளவீட்டைச் சேமி', lastAt: 'கடைசி அளவீடு',
    stSavedHere: 'இந்தத் திரையில் சேமிக்கப்பட்டது', stRetrying: 'கடைக் கணினியை அடைய முயல்கிறது', stHanded: 'கடைக் கணினியிடம் உள்ளது', stPosted: 'தலைமை அலுவலகத்தில் பதிவானது', stRefused: 'மறுக்கப்பட்டது — ஒருவர் பார்க்க வேண்டும்',
    notANumber: 'வெப்பநிலையை எண்ணாகத் தட்டச்சு செய்யவும், எ.கா. 3.5 அல்லது -18.', mayNotRecord: 'உங்கள் பணி அளவீடுகளைப் பதிவதில்லை.', nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.',
    saved: 'சேமிக்கப்பட்டது.', refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை.', needBranch: 'முதலில் கடையைத் தட்டச்சு செய்யவும்.',
  },
} as const;

export const facilitiesOfficeWords = (lang: Lang, key: string): string =>
  (FACILITIES_OFFICE_COPY[lang] as Record<string, string>)[key] ?? (FACILITIES_OFFICE_COPY.en as Record<string, string>)[key] ?? key;
export const facilitiesOfficeOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => (out.result === 'ok' ? facilitiesOfficeWords(lang, 'saved') : outcomeIn((k) => facilitiesOfficeWords(lang, k), out));

/** Tenths of a degree from what a person typed ("3.5", "-18", "4,2"); undefined when it is not a temperature. */
export function tenthsOf(raw: string): number | undefined {
  const s = raw.trim().replace(',', '.');
  if (!/^-?\d{1,3}(\.\d)?$/.test(s)) return undefined;
  return Math.round(Number(s) * 10);
}
export const degrees = (tenths: number): string => `${(tenths / 10).toFixed(1)}°C`;

// ── The office read ───────────────────────────────────────────────────────────────────────────────────────────────────
export interface FacilitiesOfficeSession {
  readonly may: { readonly named: boolean; readonly read: boolean };
  read(branchId: string, asOf: string): Promise<Outcome<Record<string, unknown>, 'needBranch'>>;
}
export function createFacilitiesOfficeSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch }): FacilitiesOfficeSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const call = makeCaller({ keyPrefix: 'fac-office', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  return {
    may: { named, read: named && held.has('facilities.asset.read') },
    read: async (branchId, asOf) => {
      if (branchId.trim() === '') return { result: 'invalid', why: 'needBranch' };
      const q = new URLSearchParams({ branchId: branchId.trim(), ...(/^\d{4}-\d{2}-\d{2}$/.test(asOf) ? { asOf } : {}) });
      return call('GET', `/v1/facilities/office?${q.toString()}`);
    },
  };
}

// ── The manual reading queue (store computer) ──────────────────────────────────────────────────────────────────────────
export interface HeldEquipment { readonly asAt: string; readonly ageMinutes: number; readonly items: readonly { readonly assetId: string; readonly name: string; readonly range: { readonly minTenthsC: number; readonly maxTenthsC: number }; readonly lastReadingAt: string | null }[] }
export interface ReadingPayload extends Record<string, unknown> { readonly assetId: string; readonly readingId: string; readonly tenthsC: number; readonly at: string; readonly source: 'manual_probe' | 'log_sheet'; readonly recordedBy: string; readonly storeId: string }
export const EQUIPMENT_READING_RECORDED = 'EquipmentReadingRecorded';
export const readingIdFor = (assetId: string, userId: string, at: string): string => `rd-${assetId}-${userId}-${at.replace(/[^0-9]/g, '').slice(0, 14)}`.replace(/[^A-Za-z0-9_-]/g, '');

export interface ReadingRow { readonly assetId: string; readonly name: string; readonly rangeWords: string; readonly lastWords: string; readonly saved: readonly { readonly words: string; readonly state: string; readonly reason?: string }[] }
export interface EquipmentReadingQueue {
  readonly canRecord: boolean;
  view(lang: Lang): { readonly known: boolean; readonly asAtWords: string; readonly rows: readonly ReadingRow[] };
  record(lang: Lang, input: { readonly assetId: string; readonly reading: string; readonly source: 'manual_probe' | 'log_sheet' }): { readonly ok: true } | { readonly ok: false; readonly words: string };
  text(lang: Lang, key: string): string;
  readonly queue: BoxQueue<ReadingPayload>;
}
export function createEquipmentReadingQueue(who: { readonly userId: string | null; readonly storeId: string; readonly permissions: readonly string[]; readonly now: () => string }, held: HeldEquipment | null, outbox: SyncOutbox): EquipmentReadingQueue {
  const queue = createBoxQueue<ReadingPayload>(EQUIPMENT_READING_RECORDED, 'web-erp/facilities', outbox);
  const canRecord = who.userId !== null && who.permissions.includes('facilities.reading.record');
  const w = facilitiesOfficeWords;
  return {
    canRecord, queue, text: w,
    view: (lang) => {
      if (held === null) return { known: false, asAtWords: w(lang, 'readingNone'), rows: [] };
      const items = queue.items();
      return {
        known: true, asAtWords: `${w(lang, 'readingAsOf')} ${held.asAt}`,
        rows: held.items.map((e) => ({
          assetId: e.assetId, name: e.name,
          rangeWords: `${w(lang, 'range')} ${degrees(e.range.minTenthsC)} – ${degrees(e.range.maxTenthsC)}`,
          lastWords: `${w(lang, 'lastAt')}: ${e.lastReadingAt ?? w(lang, 'never')}`,
          saved: items.filter((i) => i.payload.assetId === e.assetId).map((i) => ({ words: `${degrees(i.payload.tenthsC)} · ${i.payload.at} · ${w(lang, STATE_KEYS[i.state])}`, state: i.state, ...(i.reason === undefined ? {} : { reason: i.reason }) })),
        })),
      };
    },
    record: (lang, r) => {
      if (who.userId === null) return { ok: false, words: w(lang, 'nobody') };
      if (!canRecord) return { ok: false, words: w(lang, 'mayNotRecord') };
      const tenthsC = tenthsOf(r.reading);
      if (tenthsC === undefined) return { ok: false, words: w(lang, 'notANumber') };
      const at = who.now();
      const readingId = readingIdFor(r.assetId, who.userId, at);
      queue.enqueue(readingId, { assetId: r.assetId, readingId, tenthsC, at, source: r.source, recordedBy: who.userId, storeId: who.storeId }, at);
      return { ok: true };
    },
  };
}
