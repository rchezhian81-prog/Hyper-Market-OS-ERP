// Settings and their history (Round 4c · M01-FR-03 · M33-FR-01 · §28 · hard rule #2) — its own page, no longer a second door
// to Store setup. Store setup ANSWERS the shop's questions; this page shows each setting in force, EVERY version it has had
// (who, when, what, why) and puts an older version back as a NEW version — the history is never rewritten. Over head
// office's own routes, which no screen reached before:
//   • `GET /v1/platform/setup` — the settings and the value in force;
//   • `GET /v1/platform/config/:key/history` — every version, oldest first;
//   • `POST /v1/platform/config/:key/rollback` — { toVersion, reason }. A HIGH-IMPACT setting (the trading day, the currency,
//     the time zone, the offline spend cap, the bulk-publish size) goes back only with the owner's approval of exactly that
//     (kind `config_change`, subjectRef `setting:<key>`): head office refuses it by name, this page then asks, the owner
//     approves on the Approvals page, and the same press here sends it with the approval — never the asker's own.
// The owner's approval rules (money limits, waits, price-check size) go back only on the Approval rules page. Reads need
// `platform.setup.read`, the rollback `platform.setup.write`; head office re-checks both.

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';
import { shopDateTimeOf, servedShopZone } from '../../../packages/calendar/src/shop-day';

export type Lang = 'en' | 'ta';

export const SETTINGS_COPY = {
  en: {
    title: 'Settings',
    lead: 'Each setting in force, every value it has had — who chose it, when and why — and a way to put an earlier value back. Going back adds a new version; nothing is ever erased. A high-impact setting goes back only with the owner\'s approval. To answer the shop\'s setup questions, use Store setup.',
    listH: 'Settings in force', history: 'Show its history', hide: 'Hide its history',
    inForce: 'In force', onDefault: 'on the safe default', version: 'version', by: 'by', at: 'on', why: 'why', restoredFrom: 'put back from version',
    goBack: 'Put this value back', reason: 'Why go back', askOwner: 'Ask the owner to approve', sendApproved: 'Put it back now (approved)',
    noHistory: 'This setting has never been changed — it is on its safe default.',
    restored: 'Put back — now version {v}. The earlier versions are all kept.',
    needsOwner: 'This is a high-impact setting: the owner approves going back first. Press “Ask the owner to approve”.',
    asked: 'Asked. When the owner approves it on the Approvals page, press “Put it back now (approved)”.',
    waiting: 'Still waiting for the owner\'s approval.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot see the shop\'s settings.', cannotWrite: 'You can see the history; putting a value back needs the setup permission.',
    needReason: 'Say why you are going back.', current: 'That is already the value in force.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or changed.', reading: 'Reading from head office…',
  },
  ta: {
    title: 'அமைப்புகள்',
    lead: 'நடைமுறையில் உள்ள ஒவ்வொரு அமைப்பும், அதற்கு இருந்த ஒவ்வொரு மதிப்பும் — யார் தேர்ந்தெடுத்தார், எப்போது, ஏன் — முந்தைய மதிப்பைத் திரும்ப வைக்கும் வழியும். திரும்பச் செல்வது புதிய பதிப்பைச் சேர்க்கிறது; எதுவும் அழிக்கப்படுவதில்லை. அதிக தாக்கமுள்ள அமைப்பு உரிமையாளரின் ஒப்புதலுடன் மட்டுமே திரும்பும். கடையின் அமைப்புக் கேள்விகளுக்குப் பதில் அளிக்க, கடை அமைப்பைப் பயன்படுத்துங்கள்.',
    listH: 'நடைமுறையில் உள்ள அமைப்புகள்', history: 'அதன் வரலாற்றைக் காட்டு', hide: 'வரலாற்றை மறை',
    inForce: 'நடைமுறையில்', onDefault: 'பாதுகாப்பான இயல்பு மதிப்பில்', version: 'பதிப்பு', by: 'செய்தவர்', at: 'அன்று', why: 'ஏன்', restoredFrom: 'பதிப்பிலிருந்து திரும்ப வைக்கப்பட்டது',
    goBack: 'இந்த மதிப்பைத் திரும்ப வை', reason: 'ஏன் திரும்பச் செல்கிறீர்கள்', askOwner: 'உரிமையாளரின் ஒப்புதலைக் கேள்', sendApproved: 'இப்போது திரும்ப வை (அனுமதிக்கப்பட்டது)',
    noHistory: 'இந்த அமைப்பு ஒருபோதும் மாற்றப்படவில்லை — பாதுகாப்பான இயல்பு மதிப்பில் உள்ளது.',
    restored: 'திரும்ப வைக்கப்பட்டது — இப்போது பதிப்பு {v}. முந்தைய பதிப்புகள் அனைத்தும் வைக்கப்பட்டுள்ளன.',
    needsOwner: 'இது அதிக தாக்கமுள்ள அமைப்பு: திரும்பச் செல்ல முதலில் உரிமையாளர் அனுமதிக்க வேண்டும். “உரிமையாளரின் ஒப்புதலைக் கேள்” அழுத்துங்கள்.',
    asked: 'கேட்கப்பட்டது. உரிமையாளர் ஒப்புதல்கள் பக்கத்தில் அனுமதித்ததும், “இப்போது திரும்ப வை (அனுமதிக்கப்பட்டது)” அழுத்துங்கள்.',
    waiting: 'இன்னும் உரிமையாளரின் ஒப்புதலுக்காகக் காத்திருக்கிறது.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு கடையின் அமைப்புகளைப் பார்க்க முடியாது.', cannotWrite: 'வரலாற்றைப் பார்க்கலாம்; ஒரு மதிப்பைத் திரும்ப வைக்க அமைப்பு அனுமதி தேவை.',
    needReason: 'ஏன் திரும்பச் செல்கிறீர்கள் என்று சொல்லுங்கள்.', current: 'அதுவே ஏற்கனவே நடைமுறையில் உள்ள மதிப்பு.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை, மாற்றப்படவில்லை.', reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…',
  },
} as const;

export const settingsWords = (lang: Lang, key: string): string =>
  (SETTINGS_COPY[lang] as Record<string, string>)[key] ?? (SETTINGS_COPY.en as Record<string, string>)[key] ?? key;
export const settingsOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => settingsWords(lang, k), out);

export interface Setting { readonly key: string; readonly label: string; readonly value: unknown; readonly isDefault: boolean; readonly version: number }
export interface SettingVersion { readonly version: number; readonly value: unknown; readonly author: string; readonly reason: string; readonly at: string; readonly rolledBackFrom: number | null }
/** What going back did: done, or — a high-impact setting — the owner must approve first (the details to ask with). */
export type GoBack =
  | { readonly kind: 'restored'; readonly version: number }
  | { readonly kind: 'needs_owner'; readonly ask: { readonly key: string; readonly toVersion: number; readonly reason: string } };

type Why = 'nobody' | 'cannotRead' | 'cannotWrite' | 'needReason' | 'current';
type Done<T> = Promise<Outcome<T, Why>>;

const isStr = (v: unknown): v is string => typeof v === 'string';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
/** A value as a person reads it. */
export const valueWords = (v: unknown): string => (v === null || v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v));

export interface SettingsSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly write: boolean };
  settings(): Done<readonly Setting[]>;
  history(key: string): Done<readonly SettingVersion[]>;
  /** Put version `toVersion` back. `approvalId`: the owner's approval of exactly this, for a high-impact setting. */
  goBack(key: string, toVersion: number, reason: string, current: number, approvalId?: string): Done<GoBack>;
  /** Ask the owner to approve putting a high-impact setting back (kind config_change, exactly the rollback's details). */
  askOwner(ask: { readonly key: string; readonly toVersion: number; readonly reason: string }): Done<{ readonly requestId: string }>;
  /** Whether that approval is decided yet: 'approved', 'waiting', or how it ended. */
  approvalOf(requestId: string): Done<string>;
  moment(iso: string): string;
}

export function createSettingsSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch; readonly timeZone?: string }): SettingsSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('platform.setup.read'), write: named && held.has('platform.setup.write') };
  const call = makeCaller({ keyPrefix: 'settings', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  const zone = input.timeZone ?? servedShopZone();
  const no = (why: Why): { result: 'invalid'; why: Why } => ({ result: 'invalid', why });
  const gate = (need: 'read' | 'write') => (!named ? no('nobody') : !may[need] ? no(need === 'read' ? 'cannotRead' : 'cannotWrite') : undefined);
  return {
    may,
    moment: (iso) => shopDateTimeOf(iso, zone) || iso,
    settings: async () => {
      const g = gate('read'); if (g) return g;
      const out = await call<{ items?: unknown[] }>('GET', '/v1/platform/setup');
      if (out.result !== 'ok') return out;
      return { result: 'ok', value: (out.value.items ?? []).flatMap((i): Setting[] => (isObj(i) && isStr(i['key']) && isStr(i['label'])
        ? [{ key: i['key'], label: i['label'], value: i['value'], isDefault: i['isDefault'] === true, version: typeof i['version'] === 'number' ? i['version'] : 0 }] : [])) };
    },
    history: async (key) => {
      const g = gate('read'); if (g) return g;
      const out = await call<{ versions?: unknown[] }>('GET', `/v1/platform/config/${encodeURIComponent(key)}/history`);
      if (out.result !== 'ok') return out;
      return { result: 'ok', value: (out.value.versions ?? []).flatMap((v): SettingVersion[] => (isObj(v) && typeof v['version'] === 'number'
        ? [{ version: v['version'], value: v['value'], author: isStr(v['author']) ? v['author'] : '', reason: isStr(v['reason']) ? v['reason'] : '', at: isStr(v['effectiveAt']) ? v['effectiveAt'] : '',
          rolledBackFrom: typeof v['rolledBackFrom'] === 'number' ? v['rolledBackFrom'] : null }] : [])).sort((a, b) => b.version - a.version) };
    },
    goBack: async (key, toVersion, reason, current, approvalId) => {
      const g = gate('write'); if (g) return g;
      if (reason.trim() === '') return no('needReason');
      if (toVersion === current) return no('current');
      const out = await call<{ restored?: { version?: unknown } }>('POST', `/v1/platform/config/${encodeURIComponent(key)}/rollback`, { toVersion, reason: reason.trim(), ...(approvalId === undefined ? {} : { approvalId }) });
      if (out.result === 'refused' && out.code === 'high_impact_change_needs_owner_approval') return { result: 'ok', value: { kind: 'needs_owner', ask: { key, toVersion, reason: reason.trim() } } };
      if (out.result !== 'ok') return out;
      return { result: 'ok', value: { kind: 'restored', version: typeof out.value.restored?.version === 'number' ? out.value.restored.version : 0 } };
    },
    askOwner: async (ask) => {
      const g = gate('write'); if (g) return g;
      // Exactly the rollback's details, as head office fingerprints them: the body plus the path's key and the act.
      const details = { toVersion: ask.toVersion, reason: ask.reason, key: ask.key, action: 'rollback' };
      const out = await call<{ requestId?: unknown }>('POST', '/v1/approvals/requests', { kind: 'config_change', subjectRef: `setting:${ask.key}`, details, valueMinor: null, summary: `Put ${ask.key} back to version ${ask.toVersion}`, reason: ask.reason });
      if (out.result !== 'ok') return out;
      return isStr(out.value.requestId) ? { result: 'ok', value: { requestId: out.value.requestId } } : { result: 'lost_link' };
    },
    approvalOf: async (requestId) => {
      const g = gate('write'); if (g) return g;
      const out = await call<{ mine?: unknown[] }>('GET', '/v1/approvals/requests');
      if (out.result !== 'ok') return out;
      const mine = (out.value.mine ?? []).find((r) => isObj(r) && r['requestId'] === requestId);
      return { result: 'ok', value: isObj(mine) && isStr(mine['status']) ? mine['status'] : 'waiting' };
    },
  };
}
