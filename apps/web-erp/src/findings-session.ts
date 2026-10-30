// Bill findings and attendance flags (OB-609 · P-03 · P-08 · M29-FR-03 · M25-FR-01 · M05-FR-02). A tested, DOM-free session
// over two head-office routes that already existed but that no screen reached, so what head office found was kept and nobody
// saw it:
//   • BILL FINDINGS — `GET /v1/sales/exceptions` (`pos.exception.read`): every critical and material finding head office
//     raised when a till bill reached it (a price below its floor, a price cut beyond the approving manager's limit, a recalled
//     product sold, a sale above the MRP …), each with head office's own sentence for what happened and what to do. The
//     informational ones (a price a quotation head office backs, OB-551) come back only as a count, and are shown as one.
//     Every bill stands: a finding is work to settle, never a sale to undo (hard rule #2).
//   • ATTENDANCE FLAGS — `GET /v1/hr/workforce/attendance-marks?date=` (`workforce.roster.read`): the marks of one shop day
//     that do not pair up, judged by head office when asked (a night shift pairs across midnight, OB-549): an "out" with no
//     "in", a second mark of the same kind, or an "in" never followed by an "out" once its day or night shift is over. Head
//     office keeps the reader to the stores they may see. Names come from the roster (`GET /v1/hr/workforce/roster`).
// A read only: nothing is written, nothing is decided here. Head office re-checks every permission; `may` only shapes what is
// offered. Head office's own sentences stay in English (OB-553); every word this page adds has a Tamil twin.

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';
import { shopDateIn } from '../../../packages/calendar/src/shop-clock';
import { servedShopZone } from '../../../packages/calendar/src/shop-day';

export type Lang = 'en' | 'ta';

/**
 * A moment as the shop reads it — its own date and 24-hour time, in the shop's zone as the store computer told this page
 * (OB-606 · OB-607), never the device's.
 */
export function shopMomentOf(iso: string, timeZone: string = servedShopZone()): string {
  if (Number.isNaN(Date.parse(iso))) return iso;
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  return `${shopDateIn(iso, timeZone)} ${time}`;
}

export const FINDINGS_COPY = {
  en: {
    title: 'Bill findings and attendance flags',
    lead: 'What head office found when checking bills and attendance marks. Every bill stands: a finding is something to look into and settle, never a sale to undo. Head office\'s own sentences are in English.',
    salesH: 'Bill findings', salesLead: 'Critical findings first: act on them today. Material findings are for the day-end review.',
    attendanceH: 'Attendance flags', attendanceLead: 'Marks of the chosen shop day that do not pair up. A night shift pairs an "in" before midnight with an "out" after it.',
    reload: 'Read again from head office', day: 'Shop day', show: 'Show',
    critical: 'Critical', material: 'Material', bill: 'Bill', product: 'Product', difference: 'Difference', todo: 'What to do:',
    salesNone: 'No critical or material findings. Every bill came in clean.',
    informational: 'informational notes (nothing to do)',
    counts: 'critical · material · informational',
    attNone: 'No attendance flags for this day.', marksRead: 'marks read for this day; with a flag:',
    person: 'Person', mark: 'Mark', at: 'At', flags: 'Flag',
    in: 'in', out: 'out',
    in_without_out: 'In, but no out — a forgotten clock-out',
    out_without_in: 'Out, but no in to pair with',
    repeats_the_last_mark: 'The same mark twice in a row',
    flaggedOnArrival: 'Flagged when it arrived:',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot see bill findings or attendance flags.',
    cannotSales: 'Your role cannot see bill findings.', cannotAttendance: 'Your role cannot see attendance flags.',
    needDay: 'Choose a shop day.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read.', reading: 'Reading from head office…',
  },
  ta: {
    title: 'பில் கண்டறிதல்களும் வருகை எச்சரிக்கைகளும்',
    lead: 'பில்களையும் வருகைப் பதிவுகளையும் சரிபார்க்கும்போது தலைமை அலுவலகம் கண்டறிந்தவை. ஒவ்வொரு பில்லும் நிலைக்கும்: கண்டறிதல் என்பது பார்த்துத் தீர்க்க வேண்டியது, விற்பனையை ரத்து செய்வதல்ல. தலைமை அலுவலகத்தின் சொந்த வாக்கியங்கள் ஆங்கிலத்தில் உள்ளன.',
    salesH: 'பில் கண்டறிதல்கள்', salesLead: 'முக்கியமானவை முதலில்: இன்றே செயல்படுங்கள். கவனிக்க வேண்டியவை நாள் முடிவு மறுஆய்வுக்கு.',
    attendanceH: 'வருகை எச்சரிக்கைகள்', attendanceLead: 'தேர்ந்தெடுத்த கடை நாளில் இணையாத பதிவுகள். இரவுப் பணியில் நள்ளிரவுக்கு முந்தைய "உள்ளே" பதிவு, நள்ளிரவுக்குப் பிந்தைய "வெளியே" பதிவுடன் இணையும்.',
    reload: 'தலைமை அலுவலகத்திலிருந்து மீண்டும் படி', day: 'கடை நாள்', show: 'காட்டு',
    critical: 'முக்கியமானது', material: 'கவனிக்க வேண்டியது', bill: 'பில்', product: 'பொருள்', difference: 'வேறுபாடு', todo: 'செய்ய வேண்டியது:',
    salesNone: 'முக்கியமான அல்லது கவனிக்க வேண்டிய கண்டறிதல் இல்லை. எல்லா பில்களும் சரியாக வந்தன.',
    informational: 'தகவல் குறிப்புகள் (செய்ய வேண்டியது இல்லை)',
    counts: 'முக்கியமானவை · கவனிக்க வேண்டியவை · தகவல்',
    attNone: 'இந்த நாளுக்கு வருகை எச்சரிக்கை இல்லை.', marksRead: 'இந்த நாளின் பதிவுகள் படிக்கப்பட்டன, எச்சரிக்கை உள்ளவை:',
    person: 'நபர்', mark: 'பதிவு', at: 'நேரம்', flags: 'எச்சரிக்கை',
    in: 'உள்ளே', out: 'வெளியே',
    in_without_out: 'உள்ளே பதிவு உண்டு, வெளியே இல்லை — வெளியேறும் பதிவு மறந்துபோனது',
    out_without_in: 'வெளியே பதிவு உண்டு, இணைக்க உள்ளே பதிவு இல்லை',
    repeats_the_last_mark: 'ஒரே பதிவு தொடர்ந்து இருமுறை',
    flaggedOnArrival: 'வந்தபோது எச்சரிக்கப்பட்டது:',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பணி பில் கண்டறிதல்களையோ வருகை எச்சரிக்கைகளையோ பார்க்க முடியாது.',
    cannotSales: 'உங்கள் பணி பில் கண்டறிதல்களைப் பார்க்க முடியாது.', cannotAttendance: 'உங்கள் பணி வருகை எச்சரிக்கைகளைப் பார்க்க முடியாது.',
    needDay: 'கடை நாளைத் தேர்ந்தெடுங்கள்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை.', reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…',
  },
} as const;

export const findingsWords = (lang: Lang, key: string): string =>
  (FINDINGS_COPY[lang] as Record<string, string>)[key] ?? (FINDINGS_COPY.en as Record<string, string>)[key] ?? key;

/** The three ways head office says a mark does not pair up (services/finance/src/attendance-pairing.ts). */
export const ATTENDANCE_FLAGS = ['in_without_out', 'out_without_in', 'repeats_the_last_mark'] as const;
export type AttendanceFlag = (typeof ATTENDANCE_FLAGS)[number];

/** A flag in the reader's language; a flag this page does not know is shown as head office named it. */
export const flagWords = (lang: Lang, flag: string): string =>
  (ATTENDANCE_FLAGS as readonly string[]).includes(flag) ? findingsWords(lang, flag) : flag;

/** One finding, as head office raised it. `detail` and `ownerAction` are head office's own sentences. */
export interface BillFinding {
  readonly severity: 'critical' | 'material';
  readonly kind: string;
  readonly saleId: string;
  readonly productId?: string;
  readonly differenceMinor?: number;
  readonly detail: string;
  readonly ownerAction: string;
}
export interface BillFindings { readonly critical: number; readonly material: number; readonly informational: number; readonly findings: readonly BillFinding[] }

export interface FlaggedMark {
  readonly markId: string; readonly employeeId: string; readonly name: string;
  readonly kind: 'in' | 'out'; readonly at: string; readonly flags: readonly string[]; readonly flaggedOnArrival: readonly string[];
}
export interface AttendanceFlags { readonly date: string; readonly marksRead: number; readonly flagged: readonly FlaggedMark[] }

type Why = 'nobody' | 'cannotRead' | 'cannotSales' | 'cannotAttendance' | 'needDay';
type Done<T> = Promise<Outcome<T, Why>>;

export interface FindingsSession {
  readonly may: { readonly named: boolean; readonly sales: boolean; readonly attendance: boolean };
  /** The shop's own today (never the device's UTC date). */
  today(): string;
  /** Every open critical and material bill finding, critical first; informational ones as a count. */
  bills(): Done<BillFindings>;
  /** The marks of one shop day that do not pair up, with the person's name from the roster. */
  attendance(date: string): Done<AttendanceFlags>;
}

export const findingsOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => findingsWords(lang, k), out);

const isDay = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

/** One raw finding as head office sends it, kept only when it is readable. */
function readFinding(raw: unknown, severity: 'critical' | 'material'): BillFinding | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (!isStr(r['saleId']) || !isStr(r['detail'])) return undefined;
  return {
    severity, kind: isStr(r['kind']) ? r['kind'] : 'finding', saleId: r['saleId'], detail: r['detail'],
    ownerAction: isStr(r['ownerAction']) ? r['ownerAction'] : '',
    ...(isStr(r['productId']) ? { productId: r['productId'] } : {}),
    ...(typeof r['differenceMinor'] === 'number' && Number.isFinite(r['differenceMinor']) ? { differenceMinor: r['differenceMinor'] } : {}),
  };
}

export function createFindingsSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch; readonly now?: () => string;
  /**
   * OB-612: the store this page asks for — on the store PC, the box's own store (from its signed pack). Head office narrows
   * to what the person may see and refuses a store they may not, by name. Absent: head office answers with their scope.
   */
  readonly storeId?: string;
}): FindingsSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, sales: named && held.has('pos.exception.read'), attendance: named && held.has('workforce.roster.read') };
  const call = makeCaller({ keyPrefix: 'findings', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  const now = input.now ?? (() => new Date().toISOString());
  const gate = (need: 'sales' | 'attendance'): { result: 'invalid'; why: Why } | undefined =>
    !named ? { result: 'invalid', why: 'nobody' } : !may[need] ? { result: 'invalid', why: need === 'sales' ? 'cannotSales' : 'cannotAttendance' } : undefined;
  return {
    may,
    today: () => shopDateIn(now(), servedShopZone()),
    bills: async () => {
      const no = gate('sales'); if (no !== undefined) return no;
      const store = input.storeId?.trim() ?? '';
      const out = await call<{ critical?: unknown[]; material?: unknown[]; informational?: unknown }>('GET', store === '' ? '/v1/sales/exceptions' : `/v1/sales/exceptions?branchId=${encodeURIComponent(store)}`);
      if (out.result !== 'ok') return out;
      const read = (list: unknown, severity: 'critical' | 'material'): BillFinding[] =>
        (Array.isArray(list) ? list : []).map((r) => readFinding(r, severity)).filter((f): f is BillFinding => f !== undefined);
      const critical = read(out.value.critical, 'critical');
      const material = read(out.value.material, 'material');
      const informational = typeof out.value.informational === 'number' ? out.value.informational : 0;
      return { result: 'ok', value: { critical: critical.length, material: material.length, informational, findings: [...critical, ...material] } };
    },
    attendance: async (date) => {
      const no = gate('attendance'); if (no !== undefined) return no;
      if (!isDay(date)) return { result: 'invalid', why: 'needDay' };
      const [marks, roster] = await Promise.all([
        call<{ marks?: unknown[] }>('GET', `/v1/hr/workforce/attendance-marks?date=${encodeURIComponent(date)}`),
        call<{ employees?: { employeeId?: unknown; name?: unknown }[] }>('GET', '/v1/hr/workforce/roster'),
      ]);
      if (marks.result !== 'ok') return marks;
      // The roster only puts a name to an id; without it the id is shown, never a guess.
      const names = new Map<string, string>();
      if (roster.result === 'ok' && Array.isArray(roster.value.employees)) {
        for (const e of roster.value.employees) if (isStr(e.employeeId) && isStr(e.name)) names.set(e.employeeId, e.name);
      }
      const all = Array.isArray(marks.value.marks) ? marks.value.marks : [];
      const flagged: FlaggedMark[] = [];
      for (const raw of all) {
        if (raw === null || typeof raw !== 'object') continue;
        const m = raw as Record<string, unknown>;
        const flags = Array.isArray(m['exceptions']) ? (m['exceptions'] as unknown[]).filter(isStr) : [];
        if (flags.length === 0 || !isStr(m['markId']) || !isStr(m['employeeId']) || !isStr(m['at']) || (m['kind'] !== 'in' && m['kind'] !== 'out')) continue;
        flagged.push({
          markId: m['markId'], employeeId: m['employeeId'], name: names.get(m['employeeId']) ?? m['employeeId'], kind: m['kind'], at: m['at'], flags,
          flaggedOnArrival: Array.isArray(m['flaggedOnArrival']) ? (m['flaggedOnArrival'] as unknown[]).filter(isStr) : [],
        });
      }
      flagged.sort((a, b) => a.name.localeCompare(b.name) || a.at.localeCompare(b.at) || a.markId.localeCompare(b.markId));
      return { result: 'ok', value: { date, marksRead: all.length, flagged } };
    },
  };
}
