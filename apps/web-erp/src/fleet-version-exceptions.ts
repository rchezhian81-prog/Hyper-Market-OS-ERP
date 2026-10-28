// Round 10 · R10-A · OB-540 (owner, 28 Oct 2026) — the Devices page's section on HANDHELD WORK DONE ON A WITHDRAWN OR TOO-OLD
// APP VERSION (M33-FR-02 · D12-FR-03 · A-10 · P-03 · P-08).
//
// Round 9 (OB-537) made every warehouse, picker, driver and queue-till record carry the app version that made it; head office
// keeps a finding on its own append-only register for work done on a build that should not have started it, and lists them at
// `GET /v1/platform/handheld-work/version-exceptions` (`platform.health.read`, the Devices page's own word). This module reads
// that list for the Devices page and says it in English and Tamil: which handheld, which version, what was done, when, and the
// finding. Read-only — nothing here changes a version, a record, stock or money.
//
// Served the way the rest of the Devices page is: the store computer serves the page, and the page's `/v1` read goes through the
// store computer to head office under the person's OWN head-office sign-in (OB-388 · ADR-0029). So the section is honest about
// every way the read can fail (P-08) — never an empty list that reads as "nothing wrong":
//   • not read yet / an answer that cannot be read → "Not known";
//   • no connection, or head office (or the line) is down → "head office could not be reached";
//   • no head-office sign-in on this computer (401) → the store computer's or head office's own words;
//   • refused (403, …) → said, with head office's words.
// Pure apart from the one injected `fetch`; no DOM.

import { wallClockIn } from '../../../packages/calendar/src/trading-day';
import { DEFAULT_SHOP_CALENDAR } from '../../../packages/calendar/src/shop-clock';

type Lang = 'en' | 'ta';

/** Head office's register read (services/api/src/r9b-handheld-build-adapters.ts `HANDHELD_BUILD_EXCEPTIONS_PATH`). */
export const VERSION_EXCEPTIONS_PATH = '/v1/platform/handheld-work/version-exceptions';
/** The Devices page's own read word — the same one that opens the register at head office. */
export const VERSION_EXCEPTIONS_READ_PERMISSION = 'platform.health.read';

const CLIENTS = ['warehouse', 'picker', 'driver', 'queue_till'] as const;
type Client = (typeof CLIENTS)[number];

/** One finding as head office listed it, read field by field — an unreadable field is `null`, never guessed. */
export interface VersionExceptionRow {
  readonly exceptionId: string;
  readonly client: Client | null;
  readonly appVersion: string | null;
  readonly verdict: string | null;
  readonly markedByStoreComputer: string | null;
  readonly route: string | null;
  readonly recordRef: string | null;
  readonly at: string | null;
  /** Head office's own words for the finding (English — the register keeps them so). */
  readonly detail: string | null;
}

export type VersionExceptionsRead =
  | { readonly state: 'read'; readonly material: readonly VersionExceptionRow[]; readonly informational: number | null; readonly unreadable: number; readonly asAt: string | null }
  | { readonly state: 'not_permitted' }
  | { readonly state: 'sign_in_needed'; readonly en: string | null; readonly ta: string | null }
  | { readonly state: 'refused'; readonly status: number; readonly code: string | null; readonly en: string | null; readonly ta: string | null }
  | { readonly state: 'unreachable' }
  | { readonly state: 'not_known' }
  /** The page has not had head office's answer yet. */
  | { readonly state: 'not_read_yet' };

export const VERSION_EXCEPTIONS_COPY = {
  en: {
    heading: 'Handheld work on a withdrawn or too-old app version',
    lead: 'Work a handheld did on an app version head office has withdrawn, or one below the minimum it supports. The work stands — nothing was refused or thrown away. Update that handheld.',
    notKnown: 'Not known — head office\'s list has not been read yet.',
    notReadable: 'Not known — head office answered, but its list could not be read.',
    unreachable: 'Not known — head office could not be reached, so this computer cannot say whether any handheld work was done on a withdrawn or too-old version.',
    signInNeeded: 'Not known — this computer has no head-office sign-in for you. Sign in to head office on this computer with your own login and second step, then reload.',
    refused: 'Not known — head office refused to show the list:',
    notPermitted: 'You do not have permission to see this list.',
    none: 'No handheld work was done on a withdrawn or too-old version.',
    found: 'piece(s) of handheld work were done on a withdrawn or too-old version — update those handhelds.',
    noneHeld: 'entries could not be read — they are on head office\'s list, ask head office.',
    informational: 'record(s) came from a handheld too old to report its version — update those handhelds.',
    informationalNotKnown: 'How many records reported no version is not known.',
    asAt: 'Head office\'s list as at',
    kind: 'Handheld', version: 'Version', what: 'What was done', when: 'When', finding: 'Finding',
    notReported: 'not reported', notKnownShort: 'Not known',
    c_warehouse: 'Warehouse handheld', c_picker: 'Picker\'s handheld', c_driver: 'Driver\'s phone', c_queue_till: 'Queue till',
    v_version_killed: 'Version withdrawn by head office', v_upgrade_required: 'Below the minimum supported version',
    alsoMarked: '(the store computer marked it too)',
    record: 'record',
    w_pick: 'A pick on a wave line', w_packed: 'A wave packed', w_stop: 'A delivery stop', w_settled: 'A delivery route settled',
    w_handover: 'Driver\'s cash handed over', w_proof: 'A proof of delivery', w_return: 'An online return collected at the door',
    w_movement: 'A warehouse put-away or pick', w_receivingScan: 'A receiving scan', w_received: 'A delivery received',
    w_dsd: 'A direct delivery checked in', w_adjustment: 'A stock adjustment asked for', w_count: 'A stock count',
    w_transferOut: 'A transfer sent', w_transferIn: 'A transfer received', w_basket: 'A queue-till basket handed over',
    w_other: 'Work sent to',
  },
  ta: {
    heading: 'திரும்பப் பெற்ற அல்லது மிகப் பழைய செயலிப் பதிப்பில் கைக்கருவி செய்த பணி',
    lead: 'தலைமை அலுவலகம் திரும்பப் பெற்ற செயலிப் பதிப்பில், அல்லது அது ஆதரிக்கும் குறைந்தபட்சப் பதிப்புக்குக் கீழான பதிப்பில், கைக்கருவி செய்த பணி. பணி நிலைக்கும் — எதுவும் மறுக்கப்படவில்லை, தூக்கி எறியப்படவில்லை. அந்தக் கைக்கருவியைப் புதுப்பியுங்கள்.',
    notKnown: 'தெரியாது — தலைமை அலுவலகப் பட்டியல் இன்னும் படிக்கப்படவில்லை.',
    notReadable: 'தெரியாது — தலைமை அலுவலகம் பதில் சொன்னது, ஆனால் அதன் பட்டியலைப் படிக்க முடியவில்லை.',
    unreachable: 'தெரியாது — தலைமை அலுவலகத்தை அடைய முடியவில்லை, எனவே திரும்பப் பெற்ற அல்லது மிகப் பழைய பதிப்பில் ஏதேனும் கைக்கருவிப் பணி நடந்ததா என்று இந்தக் கணினியால் சொல்ல முடியாது.',
    signInNeeded: 'தெரியாது — இந்தக் கணினியில் உங்களுக்குத் தலைமை அலுவலக உள்நுழைவு இல்லை. உங்கள் சொந்த உள்நுழைவாலும் இரண்டாம் படியாலும் இந்தக் கணினியில் தலைமை அலுவலகத்தில் உள்நுழைந்து, பக்கத்தை மீண்டும் ஏற்றுங்கள்.',
    refused: 'தெரியாது — தலைமை அலுவலகம் பட்டியலைக் காட்ட மறுத்தது:',
    notPermitted: 'இந்தப் பட்டியலைப் பார்க்க உங்களுக்கு அனுமதி இல்லை.',
    none: 'திரும்பப் பெற்ற அல்லது மிகப் பழைய பதிப்பில் எந்தக் கைக்கருவிப் பணியும் நடக்கவில்லை.',
    found: 'கைக்கருவிப் பணி(கள்) திரும்பப் பெற்ற அல்லது மிகப் பழைய பதிப்பில் நடந்தன — அந்தக் கைக்கருவிகளைப் புதுப்பியுங்கள்.',
    noneHeld: 'பதிவுகளைப் படிக்க முடியவில்லை — அவை தலைமை அலுவலகப் பட்டியலில் உள்ளன, தலைமை அலுவலகத்தைக் கேளுங்கள்.',
    informational: 'பதிவு(கள்) தன் பதிப்பைச் சொல்ல முடியாத அளவுக்குப் பழைய கைக்கருவியிலிருந்து வந்தன — அந்தக் கைக்கருவிகளைப் புதுப்பியுங்கள்.',
    informationalNotKnown: 'பதிப்பைச் சொல்லாத பதிவுகள் எத்தனை என்று தெரியாது.',
    asAt: 'தலைமை அலுவலகப் பட்டியல், இந்த நேரப்படி:',
    kind: 'கைக்கருவி', version: 'பதிப்பு', what: 'செய்த பணி', when: 'எப்போது', finding: 'கண்டறிதல்',
    notReported: 'சொல்லப்படவில்லை', notKnownShort: 'தெரியாது',
    c_warehouse: 'கிடங்குக் கைக்கருவி', c_picker: 'பொருள் எடுப்பவரின் கைக்கருவி', c_driver: 'ஓட்டுநரின் கைபேசி', c_queue_till: 'வரிசைக் கல்லா',
    v_version_killed: 'தலைமை அலுவலகம் திரும்பப் பெற்ற பதிப்பு', v_upgrade_required: 'ஆதரிக்கப்படும் குறைந்தபட்சப் பதிப்புக்குக் கீழ்',
    alsoMarked: '(கடைக் கணினியும் குறித்தது)',
    record: 'பதிவு',
    w_pick: 'அலை வரியில் ஒரு எடுப்பு', w_packed: 'ஒரு அலை கட்டப்பட்டது', w_stop: 'ஒரு டெலிவரி நிறுத்தம்', w_settled: 'ஒரு டெலிவரி வழி கணக்கு முடிந்தது',
    w_handover: 'ஓட்டுநரின் பணம் ஒப்படைக்கப்பட்டது', w_proof: 'ஒரு டெலிவரி சான்று', w_return: 'வாசலில் சேகரித்த ஆன்லைன் திருப்பம்',
    w_movement: 'கிடங்கில் வைப்பு அல்லது எடுப்பு', w_receivingScan: 'சரக்கு வரவு ஸ்கேன்', w_received: 'ஒரு டெலிவரி பெறப்பட்டது',
    w_dsd: 'நேரடி டெலிவரி பதிவு', w_adjustment: 'சரக்குத் திருத்தக் கோரிக்கை', w_count: 'ஒரு சரக்கு எண்ணிக்கை',
    w_transferOut: 'ஒரு இடமாற்றம் அனுப்பப்பட்டது', w_transferIn: 'ஒரு இடமாற்றம் பெறப்பட்டது', w_basket: 'வரிசைக் கல்லா கூடை ஒப்படைப்பு',
    w_other: 'இங்கு அனுப்பிய பணி:',
  },
} as const;

type CopyKey = keyof typeof VERSION_EXCEPTIONS_COPY.en;
export const versionExceptionsWords = (lang: Lang, key: CopyKey): string => VERSION_EXCEPTIONS_COPY[lang][key] ?? VERSION_EXCEPTIONS_COPY.en[key];

/** The kind of work, from the route the record arrived on (services/api relay routes; the queue basket report). */
const WORK_OF_ROUTE: readonly (readonly [string, CopyKey])[] = [
  ['/v1/fulfilment/waves/:waveId/lines/:lineId/synced', 'w_pick'],
  ['/v1/fulfilment/waves/:waveId/packed/synced', 'w_packed'],
  ['/v1/delivery/routes/:routeId/stops/:stopId/synced', 'w_stop'],
  ['/v1/delivery/routes/:routeId/settled/synced', 'w_settled'],
  ['/v1/delivery/routes/:routeId/handover/synced', 'w_handover'],
  ['/v1/delivery/routes/:routeId/stops/:stopId/proof/synced', 'w_proof'],
  ['/v1/online-returns/:returnId/collection/synced', 'w_return'],
  ['/v1/warehouse/movements/:commandId/synced', 'w_movement'],
  ['/v1/inventory/receiving-scans/:commandId/synced', 'w_receivingScan'],
  ['/v1/inventory/goods-receipt/:grnId/assembled', 'w_received'],
  ['/v1/inventory/dsd-checkins/:checkInId/synced', 'w_dsd'],
  ['/v1/inventory/adjustment-requests/:requestId/synced', 'w_adjustment'],
  ['/v1/inventory/counts/:countId/synced', 'w_count'],
  ['/v1/warehouse/transfers/:transferId/dispatch/synced', 'w_transferOut'],
  ['/v1/warehouse/transfers/:transferId/receive/synced', 'w_transferIn'],
  ['/v1/platform/handheld-work/queue-baskets/:basketId/build/synced', 'w_basket'],
];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/** One finding, read field by field. Undefined only when it is not an object or has no id at all. */
function readRow(v: unknown): VersionExceptionRow | undefined {
  if (!isObj(v) || strOrNull(v['exceptionId']) === null) return undefined;
  const client = CLIENTS.find((c) => c === v['client']) ?? null;
  return {
    exceptionId: v['exceptionId'] as string, client, appVersion: strOrNull(v['appVersion']), verdict: strOrNull(v['verdict']),
    markedByStoreComputer: strOrNull(v['markedByStoreComputer']), route: strOrNull(v['route']), recordRef: strOrNull(v['recordRef']),
    at: strOrNull(v['at']) !== null && !Number.isNaN(Date.parse(v['at'] as string)) ? (v['at'] as string) : null,
    detail: strOrNull(v['detail']),
  };
}

/** Head office's (or the store computer's) refusal words, in head office's error shape. */
function wordsOf(body: unknown): { readonly code: string | null; readonly en: string | null; readonly ta: string | null } {
  const e = isObj(body) && isObj(body['error']) ? body['error'] : isObj(body) ? body : {};
  return { code: strOrNull(e['code']), en: strOrNull(e['whatHappened']), ta: strOrNull(e['whatHappenedTa']) };
}

/**
 * OB-540: read head office's register through the store computer, as the person signed in (`credentials: 'same-origin'`).
 * Every failure is a named state; nothing is ever read as an empty, healthy list.
 */
export async function readVersionExceptions(fetchFn: typeof globalThis.fetch | undefined = (globalThis as { fetch?: typeof fetch }).fetch): Promise<VersionExceptionsRead> {
  if (fetchFn === undefined) return { state: 'unreachable' };
  let res: Response;
  try {
    res = await fetchFn(VERSION_EXCEPTIONS_PATH, { method: 'GET', headers: { accept: 'application/json' }, credentials: 'same-origin' });
  } catch {
    return { state: 'unreachable' }; // no connection, or the store computer could not reach head office (it drops the call)
  }
  let body: unknown;
  try { body = await res.json(); } catch { body = undefined; }
  if (res.status === 200) {
    if (!isObj(body) || !Array.isArray(body['material'])) return { state: 'not_known' };
    const rows = (body['material'] as unknown[]).map(readRow);
    const material = rows.filter((r): r is VersionExceptionRow => r !== undefined);
    const informational = typeof body['informational'] === 'number' && Number.isInteger(body['informational']) && body['informational'] >= 0 ? body['informational'] : null;
    return { state: 'read', material, informational, unreadable: rows.length - material.length, asAt: strOrNull(body['asAt']) };
  }
  if (res.status === 502 || res.status === 503 || res.status === 504) return { state: 'unreachable' };
  const words = wordsOf(body);
  if (res.status === 401) return { state: 'sign_in_needed', en: words.en, ta: words.ta };
  // A 403 from head office's own permission check is "not permitted"; the store computer's own 403s say who and why.
  if (res.status === 403 && (words.code === null || words.code === 'forbidden' || words.code === 'permission_denied')) return { state: 'not_permitted' };
  return { state: 'refused', status: res.status, code: words.code, en: words.en, ta: words.ta };
}

export interface PresentedVersionException {
  readonly exceptionId: string;
  readonly kind: string;
  readonly version: string;
  readonly what: string;
  readonly when: string;
  readonly finding: string;
  /** Head office's own words for the finding (English only, as the register keeps them); null in Tamil or when absent. */
  readonly detail: string | null;
}

export interface VersionExceptionsView {
  readonly heading: string;
  readonly lead: string;
  /** `ok` = read and nothing listed; `attention` = findings listed; `unknown` = cannot say (never a healthy-looking zero). */
  readonly tone: 'ok' | 'attention' | 'unknown';
  readonly icon: string;
  /** The one line saying where the list stands. */
  readonly status: string;
  readonly rows: readonly PresentedVersionException[];
  /** "N records came from a handheld too old to report its version", when head office counted any (or said it cannot). */
  readonly informational: string | null;
  readonly asAt: string | null;
  readonly labels: { readonly kind: string; readonly version: string; readonly what: string; readonly when: string; readonly finding: string };
}

const shown = (iso: string | null, zone: string): string | null => {
  if (iso === null) return null;
  try { return wallClockIn(iso, zone).replace('T', ' '); } catch { return null; }
};

/** OB-540: the section in one language — the Devices page draws exactly this. */
export function presentVersionExceptions(lang: Lang, read: VersionExceptionsRead, timeZone: string = DEFAULT_SHOP_CALENDAR.timeZone): VersionExceptionsView {
  const w = (k: CopyKey): string => versionExceptionsWords(lang, k);
  const base = {
    heading: w('heading'), lead: w('lead'),
    labels: { kind: w('kind'), version: w('version'), what: w('what'), when: w('when'), finding: w('finding') },
  };
  const unknown = (status: string): VersionExceptionsView => ({ ...base, tone: 'unknown', icon: '?', status, rows: [], informational: null, asAt: null });
  const theirs = (en: string | null, ta: string | null): string | null => (lang === 'ta' ? ta ?? en : en);
  switch (read.state) {
    case 'not_read_yet': return unknown(w('notKnown'));
    case 'not_known': return unknown(w('notReadable'));
    case 'unreachable': return unknown(w('unreachable'));
    case 'not_permitted': return unknown(w('notPermitted'));
    case 'sign_in_needed': { const said = theirs(read.en, read.ta); return unknown(said === null ? w('signInNeeded') : `${w('signInNeeded')} ${said}`); }
    case 'refused': { const said = theirs(read.en, read.ta); return unknown(`${w('refused')} ${said ?? `${read.status}${read.code === null ? '' : ` ${read.code}`}`}`); }
    case 'read': break;
  }
  const rows = [...read.material].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '') || a.exceptionId.localeCompare(b.exceptionId)).map((r): PresentedVersionException => {
    const work = WORK_OF_ROUTE.find(([route]) => route === r.route)?.[1];
    const ref = r.recordRef === null ? null : (r.recordRef.split('#')[0] ?? '') || null;
    const whatWords = work !== undefined ? w(work) : r.route !== null ? `${w('w_other')} ${r.route}` : w('notKnownShort');
    const verdictKey = r.verdict === 'version_killed' ? 'v_version_killed' : r.verdict === 'upgrade_required' ? 'v_upgrade_required' : undefined;
    const marked = r.markedByStoreComputer === 'version_killed' || r.markedByStoreComputer === 'upgrade_required';
    return {
      exceptionId: r.exceptionId,
      kind: r.client === null ? w('notKnownShort') : w(`c_${r.client}` as CopyKey),
      version: r.appVersion ?? w('notReported'),
      what: ref === null ? whatWords : `${whatWords} (${w('record')} ${ref})`,
      when: shown(r.at, timeZone) ?? w('notKnownShort'),
      finding: `${verdictKey === undefined ? (r.verdict ?? w('notKnownShort')) : w(verdictKey)}${marked ? ` ${w('alsoMarked')}` : ''}`,
      detail: lang === 'en' ? r.detail : null,
    };
  });
  const status = rows.length === 0 && read.unreadable === 0 ? w('none')
    : read.unreadable > 0 ? `${rows.length} ${w('found')} ${read.unreadable} ${w('noneHeld')}` : `${rows.length} ${w('found')}`;
  const informational = read.informational === null ? w('informationalNotKnown') : read.informational > 0 ? `${read.informational} ${w('informational')}` : null;
  const asAt = shown(read.asAt, timeZone);
  return {
    ...base,
    tone: rows.length === 0 && read.unreadable === 0 ? 'ok' : 'attention', icon: rows.length === 0 && read.unreadable === 0 ? '✓' : '⚠',
    status, rows, informational, asAt: asAt === null ? null : `${w('asAt')} ${asAt}`,
  };
}

/** What the Devices page is handed on `window.fleetVersionExceptions` (fleet.js never calls the network itself). */
export interface FleetVersionExceptionsPort {
  /** False when the reader does not hold the Devices page's read word: the section says so and nothing is read. */
  readonly mayRead: boolean;
  read(): Promise<VersionExceptionsRead>;
  view(lang: Lang, read: VersionExceptionsRead): VersionExceptionsView;
}

/** OB-540: the port for this reader — reads only when they hold the Devices page's own word. */
export function fleetVersionExceptionsPort(permissions: readonly string[] | undefined, fetchFn?: typeof globalThis.fetch): FleetVersionExceptionsPort {
  const mayRead = (permissions ?? []).includes(VERSION_EXCEPTIONS_READ_PERMISSION);
  return {
    mayRead,
    read: () => (mayRead ? readVersionExceptions(fetchFn ?? (globalThis as { fetch?: typeof fetch }).fetch) : Promise.resolve({ state: 'not_permitted' })),
    view: (lang, read) => presentVersionExceptions(lang, read),
  };
}
