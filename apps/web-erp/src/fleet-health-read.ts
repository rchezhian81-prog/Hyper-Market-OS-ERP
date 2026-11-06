// W6 · M33-FR-04 (A-10 · P-03 · P-08) — the Devices page reads the shop's REAL fleet from head office.
//
// Head office keeps the device registry and judges it: `POST /v1/platform/devices/fleet-health` (`platform.health.read`, the
// Devices page's own word) runs the tested `evaluateDevice` / `fleetSummary` over the stored fleet against the stored version
// policy and answers the rollup and each device's verdict. It is a READ (a POST only because it may carry a body); nothing is
// recorded. Until this file the page's code said the fleet was "wired next" and the store computer never carried it, so on the
// store PC the page always said "No devices are registered yet" — a healthy-looking empty list nobody had read (P-08).
//
// No machine feeds this route, and none should: the store computer does not hold the registry or the version policy, so a box
// that "sent its fleet health" would be sending head office's own answer back to it. The PAGE asks, as the person signed in,
// through the store computer (OB-388 · ADR-0029), narrowed to this store (OB-601). Every way the read can fail is said in
// words, never an empty fleet:
//   • head office has no version policy yet → said (it cannot judge a device against nothing);
//   • no connection / head office down → "cannot be reached"; no head-office sign-in → said; refused → said.
// Pure apart from the one injected `fetch`; no DOM.

import type { FleetDeviceRow, FleetSummaryRollup, FleetVerdict } from './fleet-session';
import { FLEET_VERDICTS } from './fleet-session';

export const FLEET_HEALTH_PATH = '/v1/platform/devices/fleet-health';

export type FleetHealthRead =
  | { readonly state: 'not_read_yet' }
  | { readonly state: 'read'; readonly summary: FleetSummaryRollup; readonly devices: readonly FleetDeviceRow[]; readonly asAt: string | null }
  | { readonly state: 'no_version_policy' }
  | { readonly state: 'not_known' }
  | { readonly state: 'unreachable' }
  | { readonly state: 'sign_in_needed'; readonly said: string | null }
  | { readonly state: 'not_permitted' }
  | { readonly state: 'refused'; readonly status: number; readonly code: string | null; readonly said: string | null };

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v !== '';
const whole = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined);

/** Head office's answer → the page's rows: each device flattened with its verdict, `silent` from the rollup. Undefined when unreadable. */
export function fleetRowsOf(body: unknown): { readonly summary: FleetSummaryRollup; readonly devices: readonly FleetDeviceRow[] } | undefined {
  if (!isObj(body) || !isObj(body['summary']) || !Array.isArray(body['devices'])) return undefined;
  const s = body['summary'];
  const silentIds = Array.isArray(s['silent']) ? (s['silent'] as unknown[]).filter(isStr) : undefined;
  const counts = ['total', 'trading', 'blocked', 'mustUpgrade'].map((k) => whole(s[k]));
  if (silentIds === undefined || counts.some((c) => c === undefined) || !isObj(s['byVersion'])) return undefined;
  const byVersion: Record<string, number> = {};
  for (const [k, v] of Object.entries(s['byVersion'])) { const n = whole(v); if (n === undefined) return undefined; byVersion[k] = n; }
  const silent = new Set(silentIds);
  const devices: FleetDeviceRow[] = [];
  for (const row of body['devices'] as unknown[]) {
    if (!isObj(row) || !isObj(row['device']) || !isObj(row['decision'])) return undefined;
    const d = row['device']; const v = row['decision'];
    if (!isStr(d['deviceId']) || !isStr(d['label']) || !isStr(d['kind']) || !isStr(d['branchId']) || !isStr(d['status'])) return undefined;
    if (!(FLEET_VERDICTS as readonly string[]).includes(v['verdict'] as string) || typeof v['mayTrade'] !== 'boolean' || typeof v['mustUpgrade'] !== 'boolean') return undefined;
    devices.push({
      deviceId: d['deviceId'], label: d['label'], kind: d['kind'], branchId: d['branchId'], status: d['status'],
      ...(isStr(d['appVersion']) ? { appVersion: d['appVersion'] } : {}), ...(isStr(d['lastSeenAt']) ? { lastSeenAt: d['lastSeenAt'] } : {}),
      verdict: v['verdict'] as FleetVerdict, mayTrade: v['mayTrade'], mustUpgrade: v['mustUpgrade'],
      ...(isStr(v['targetVersion']) ? { targetVersion: v['targetVersion'] } : {}),
      detail: typeof v['detail'] === 'string' ? v['detail'] : '', silent: silent.has(d['deviceId']),
    });
  }
  const [total, trading, blocked, mustUpgrade] = counts as number[];
  return { summary: { total: total!, trading: trading!, blocked: blocked!, mustUpgrade: mustUpgrade!, silent: silent.size, byVersion }, devices };
}

const wordsOf = (body: unknown): { code: string | null; said: string | null } => {
  const e = isObj(body) && isObj(body['error']) ? body['error'] : undefined;
  return { code: isStr(e?.['code']) ? e!['code'] as string : null, said: isStr(e?.['whatHappened']) ? e!['whatHappened'] as string : null };
};

/** Ask head office for the fleet's health, as the person, for this store. A fresh key per read — it is a read, never a replay. */
export async function readFleetHealth(
  fetchFn: typeof globalThis.fetch | undefined = (globalThis as { fetch?: typeof fetch }).fetch,
  storeId?: string,
  newKey: () => string = () => `fleet-health-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
): Promise<FleetHealthRead> {
  if (fetchFn === undefined) return { state: 'unreachable' };
  const path = storeId === undefined || storeId.trim() === '' ? FLEET_HEALTH_PATH : `${FLEET_HEALTH_PATH}?branchId=${encodeURIComponent(storeId.trim())}`;
  let res: Response;
  try {
    res = await fetchFn(path, {
      method: 'POST', credentials: 'same-origin',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'idempotency-key': newKey() },
      body: '{}',
    });
  } catch {
    return { state: 'unreachable' };
  }
  let body: unknown;
  try { body = await res.json(); } catch { body = undefined; }
  if (res.status === 200) {
    const rows = fleetRowsOf(body);
    return rows === undefined ? { state: 'not_known' } : { state: 'read', ...rows, asAt: isObj(body) && isStr(body['asAt']) ? body['asAt'] : null };
  }
  if (res.status === 502 || res.status === 503 || res.status === 504) return { state: 'unreachable' };
  const w = wordsOf(body);
  if (res.status === 409 && w.code === 'no_version_policy') return { state: 'no_version_policy' };
  if (res.status === 401) return { state: 'sign_in_needed', said: w.said };
  if (res.status === 403 && (w.code === null || w.code === 'forbidden' || w.code === 'permission_denied')) return { state: 'not_permitted' };
  return { state: 'refused', status: res.status, code: w.code, said: w.said };
}

type Lang = 'en' | 'ta';
const WORDS = {
  en: {
    reading: 'Reading the fleet from head office…',
    read: 'The fleet as head office holds it.',
    noPolicy: 'Head office has no app version policy yet, so it cannot judge the devices. The owner or IT sets it first; until then the fleet is not known — not "all well".',
    notKnown: 'Head office answered, but the answer could not be read. The fleet is not known.',
    unreachable: 'Head office cannot be reached, so the fleet is not known. Nothing is shown as healthy.',
    signIn: 'This computer has no head-office sign-in for you, so the fleet cannot be read.',
    notPermitted: 'Head office does not let your role see the device fleet.',
    refused: 'Head office refused:',
  },
  ta: {
    reading: 'தலைமை அலுவலகத்திலிருந்து சாதனங்களைப் படிக்கிறது…',
    read: 'தலைமை அலுவலகம் வைத்துள்ளபடி சாதனங்கள்.',
    noPolicy: 'தலைமை அலுவலகத்தில் இன்னும் செயலிப் பதிப்புக் கொள்கை இல்லை, எனவே சாதனங்களை மதிப்பிட முடியாது. உரிமையாளர் அல்லது IT முதலில் அமைக்க வேண்டும்; அதுவரை சாதனங்களின் நிலை தெரியாது — "எல்லாம் சரி" அல்ல.',
    notKnown: 'தலைமை அலுவலகம் பதிலளித்தது, ஆனால் அதைப் படிக்க முடியவில்லை. சாதனங்களின் நிலை தெரியாது.',
    unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை, எனவே சாதனங்களின் நிலை தெரியாது. எதுவும் சரி என்று காட்டப்படவில்லை.',
    signIn: 'இந்தக் கணினியில் உங்களுக்குத் தலைமை அலுவலக உள்நுழைவு இல்லை, எனவே சாதனங்களைப் படிக்க முடியாது.',
    notPermitted: 'உங்கள் பங்கிற்குச் சாதனங்களைப் பார்க்கத் தலைமை அலுவலகம் அனுமதிக்கவில்லை.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:',
  },
} as const;
export const FLEET_HEALTH_WORDS = WORDS;

/** The one line the Devices page shows about where its fleet came from. `known` false: the list below is NOT the fleet. */
export function fleetHealthLine(lang: Lang, read: FleetHealthRead): { readonly known: boolean; readonly tone: 'ok' | 'unknown'; readonly text: string } {
  const w = WORDS[lang];
  switch (read.state) {
    case 'read': return { known: true, tone: 'ok', text: w.read };
    case 'not_read_yet': return { known: false, tone: 'unknown', text: w.reading };
    case 'no_version_policy': return { known: false, tone: 'unknown', text: w.noPolicy };
    case 'not_known': return { known: false, tone: 'unknown', text: w.notKnown };
    case 'unreachable': return { known: false, tone: 'unknown', text: w.unreachable };
    case 'sign_in_needed': return { known: false, tone: 'unknown', text: read.said === null ? w.signIn : `${w.signIn} ${read.said}` };
    case 'not_permitted': return { known: false, tone: 'unknown', text: w.notPermitted };
    case 'refused': return { known: false, tone: 'unknown', text: `${w.refused} ${read.said ?? `${read.status}${read.code === null ? '' : ` ${read.code}`}`}` };
  }
}

/** What the Devices page is handed on `window.fleetHealth` (fleet.js never calls the network itself). */
export interface FleetHealthPort {
  /** False when the reader does not hold the Devices page's read word: nothing is read. */
  readonly mayRead: boolean;
  /** Read head office's fleet; a successful read becomes the fleet the page's session shows. */
  read(): Promise<FleetHealthRead>;
  line(lang: Lang, read: FleetHealthRead): ReturnType<typeof fleetHealthLine>;
}

export function fleetHealthPort(input: {
  readonly permissions: readonly string[] | undefined;
  readonly storeId?: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Called with each successful read — the session's fleet port reads it from here. */
  readonly onRead: (fleet: { readonly summary: FleetSummaryRollup; readonly devices: readonly FleetDeviceRow[] }) => void;
}): FleetHealthPort {
  const mayRead = (input.permissions ?? []).includes('platform.health.read');
  return {
    mayRead,
    read: async () => {
      if (!mayRead) return { state: 'not_permitted' };
      const r = await readFleetHealth(input.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch, input.storeId);
      if (r.state === 'read') input.onRead({ summary: r.summary, devices: r.devices });
      return r;
    },
    line: fleetHealthLine,
  };
}
