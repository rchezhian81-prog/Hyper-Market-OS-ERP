// API-11 The owner's numbers for the store-floor devices (OB-375 · OB-378 · D14-FR-02 · D04-FR-06 · R8-3 · P-04 · P-08 ·
// hard rules #2 and #6).
//
//   GET  /v1/devices/floor-settings             each setting as it applies now — the owner's latest entry, or else the
//        value he DECIDED in writing (25 Oct 2026), said as such — with every earlier entry (floor.settings.read).
//   POST /v1/devices/floor-settings/:setting    the OWNER enters a new value (floor.settings.manage — his alone). Append-only:
//        each entry is a new version, the earlier ones stay on the record; audited with before and after.
//
// The two settings, and the owner's decisions they carry:
//
//   • `kiosk_stale_after` — OB-375: the price kiosk stops quoting a price once its signed price list is older than this many
//     minutes, and says "ask a colleague" (it always shows the list's age). Decided: 24 hours = 1 440 minutes.
//   • `self_checkout_watch` — OB-378: the self-checkout lane's watch — a random audit of this share of baskets over this
//     value, and a colleague called after this many loose-produce lines or this many removals. Decided: the engine's
//     suggestions — 3 % of baskets over ₹2,000; 4 loose-produce lines; 3 removals.
//
// Both travel to every store computer in the store pack's policies (`kioskStaleAfterMinutes`, `selfCheckoutWatch`), which
// the store computer already reads (edge/store-edge/src/self-checkout-screens.ts). No other number is invented here.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';

export type FloorDeviceSettingKey = 'kiosk_stale_after' | 'self_checkout_watch';
export const FLOOR_DEVICE_SETTING_KEYS: readonly FloorDeviceSettingKey[] = Object.freeze(['kiosk_stale_after', 'self_checkout_watch']);

/** The self-checkout watch numbers, exactly as the lane reads them (`selfCheckoutWatchOf`). */
export interface SelfCheckoutWatchValue {
  /** The share of baskets drawn for a random audit, in basis points (300 = 3 %). */
  readonly auditRateBps: number;
  /** Only baskets worth more than this (paise) are drawn. */
  readonly auditAboveMinor: number;
  /** A colleague is called after this many loose-produce lines. */
  readonly looseProducePatternCount: number;
  /** A colleague is called after this many removals. */
  readonly voidPatternCount: number;
}

export type FloorDeviceSettingValue = number | SelfCheckoutWatchValue;

/** One append-only entry: the owner set a value. The highest version per setting applies. */
export interface FloorDeviceSetting {
  readonly setting: FloorDeviceSettingKey;
  readonly value: FloorDeviceSettingValue;
  readonly version: number;
  readonly setBy: string;
  readonly setAt: string;
  readonly reason?: string;
}

/** The owner's written decisions (25 Oct 2026) — what applies until he enters a different value. Nothing else is assumed. */
export const OWNER_DECIDED_FLOOR_SETTINGS: Readonly<Record<FloorDeviceSettingKey, { readonly value: FloorDeviceSettingValue; readonly decision: string; readonly decidedOn: string }>> = Object.freeze({
  kiosk_stale_after: { value: 1_440, decision: 'OB-375', decidedOn: '2026-10-25' },
  self_checkout_watch: { value: Object.freeze({ auditRateBps: 300, auditAboveMinor: 200_000, looseProducePatternCount: 4, voidPatternCount: 3 }), decision: 'OB-378', decidedOn: '2026-10-25' },
});

export const FLOOR_SETTING_WORDS: Readonly<Record<FloorDeviceSettingKey, { readonly en: string; readonly ta: string }>> = Object.freeze({
  kiosk_stale_after: {
    en: 'Price kiosk: stop quoting prices once its price list is older than this many minutes (it then says "ask a colleague")',
    ta: 'விலை கியோஸ்க்: விலைப் பட்டியல் இத்தனை நிமிடங்களுக்கு மேல் பழையதானால் விலை சொல்வதை நிறுத்தும் ("ஊழியரிடம் கேளுங்கள்" என்று சொல்லும்)',
  },
  self_checkout_watch: {
    en: 'Self-checkout watch: a random check of this share of baskets over this value; a colleague after this many loose-produce lines or removals',
    ta: 'சுய-பில்லிங் கண்காணிப்பு: இந்த மதிப்புக்கு மேலான கூடைகளில் இத்தனை சதவீதம் சீரற்ற சோதனை; இத்தனை எடைப் பொருள் வரிகள் அல்லது நீக்கங்களுக்குப் பின் ஊழியர்',
  },
});

const whole = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Read a value for its setting — or say why it is not one. */
export function readFloorSettingValue(setting: FloorDeviceSettingKey, raw: unknown): { readonly ok: true; readonly value: FloorDeviceSettingValue } | { readonly ok: false; readonly why: string } {
  if (setting === 'kiosk_stale_after') {
    // At least a minute; at most a week (a kiosk quoting a week-old list is not a price check).
    if (!whole(raw) || raw < 1 || raw > 10_080) return { ok: false, why: 'The minutes are a whole number from 1 to 10 080 (one week). 24 hours is 1440.' };
    return { ok: true, value: raw };
  }
  if (!isObj(raw)) return { ok: false, why: 'The watch is { auditRateBps, auditAboveMinor, looseProducePatternCount, voidPatternCount }.' };
  const { auditRateBps: rate, auditAboveMinor: above, looseProducePatternCount: loose, voidPatternCount: voids } = raw;
  if (!whole(rate) || rate < 0 || rate > 10_000) return { ok: false, why: 'The audit share is in basis points, 0 to 10 000 (3 % is 300).' };
  if (!whole(above) || above < 0) return { ok: false, why: 'The basket value is a whole number of paise, 0 or more (₹2,000 is 200000).' };
  if (!whole(loose) || loose < 1 || loose > 100) return { ok: false, why: 'The loose-produce lines are a whole number from 1 to 100.' };
  if (!whole(voids) || voids < 1 || voids > 100) return { ok: false, why: 'The removals are a whole number from 1 to 100.' };
  return { ok: true, value: { auditRateBps: rate, auditAboveMinor: above, looseProducePatternCount: loose, voidPatternCount: voids } };
}

/** The latest entry per setting (highest version). */
export function latestFloorSettings(entries: readonly FloorDeviceSetting[]): ReadonlyMap<FloorDeviceSettingKey, FloorDeviceSetting> {
  const out = new Map<FloorDeviceSettingKey, FloorDeviceSetting>();
  for (const e of entries) { const cur = out.get(e.setting); if (cur === undefined || e.version >= cur.version) out.set(e.setting, e); }
  return out;
}

/** What applies now for one setting: the owner's latest entry, or his written decision. */
export interface EffectiveFloorSetting {
  readonly setting: FloorDeviceSettingKey;
  readonly value: FloorDeviceSettingValue;
  readonly source: 'owner_entry' | 'owner_decision';
  readonly decision: string;
  readonly decidedOn: string;
  readonly version: number;
  readonly setBy: string | null;
  readonly setAt: string | null;
  readonly words: { readonly en: string; readonly ta: string };
  readonly history: readonly FloorDeviceSetting[];
}

export function effectiveFloorSettings(entries: readonly FloorDeviceSetting[]): readonly EffectiveFloorSetting[] {
  const latest = latestFloorSettings(entries);
  return FLOOR_DEVICE_SETTING_KEYS.map((setting) => {
    const e = latest.get(setting);
    const decided = OWNER_DECIDED_FLOOR_SETTINGS[setting];
    return {
      setting, value: e?.value ?? decided.value, source: e === undefined ? 'owner_decision' as const : 'owner_entry' as const,
      decision: decided.decision, decidedOn: decided.decidedOn, version: e?.version ?? 0,
      setBy: e?.setBy ?? null, setAt: e?.setAt ?? null, words: FLOOR_SETTING_WORDS[setting],
      history: entries.filter((x) => x.setting === setting).sort((a, b) => a.version - b.version),
    };
  });
}

/** The store pack's policies these settings travel in — exactly the keys the store computer reads. */
export function floorDevicePackPolicies(entries: readonly FloorDeviceSetting[]): { readonly kioskStaleAfterMinutes: number; readonly selfCheckoutWatch: SelfCheckoutWatchValue } {
  const eff = new Map(effectiveFloorSettings(entries).map((e) => [e.setting, e.value] as const));
  return { kioskStaleAfterMinutes: eff.get('kiosk_stale_after') as number, selfCheckoutWatch: eff.get('self_checkout_watch') as SelfCheckoutWatchValue };
}

export interface FloorDeviceSettingsDeps {
  readonly now: () => string;
  /** Every entry, oldest first (append-only). */
  readonly settings: (tenantId: string) => Promise<readonly FloorDeviceSetting[]>;
  readonly record: (tenantId: string, s: FloorDeviceSetting, key: string) => Promise<void>;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

const same = (a: FloorDeviceSettingValue, b: FloorDeviceSettingValue): boolean => JSON.stringify(a) === JSON.stringify(b);

export function floorDeviceSettingRoutes(deps: FloorDeviceSettingsDeps): readonly Route[] {
  return [
    {
      api: 'API-11', method: 'GET', path: '/v1/devices/floor-settings',
      permission: 'floor.settings.read',
      handler: async (ctx) => ({ status: 200, body: { settings: effectiveFloorSettings(await deps.settings(ctx.tenantId)), asAt: deps.now() } }),
    },
    {
      // The OWNER enters a value. Body: { value, reason? }. The same value as now records nothing new.
      api: 'API-11', method: 'POST', path: '/v1/devices/floor-settings/:setting',
      permission: 'floor.settings.manage', idempotent: true,
      handler: async (ctx) => {
        const setting = (ctx.params['setting'] ?? '') as FloorDeviceSettingKey;
        if (!FLOOR_DEVICE_SETTING_KEYS.includes(setting)) {
          throw apiError(404, { code: 'no_such_floor_setting', whatHappened: `There is no floor-device setting called "${ctx.params['setting'] ?? ''}".`, wasItSaved: 'not_saved', nextSafeAction: `Use one of: ${FLOOR_DEVICE_SETTING_KEYS.join(', ')}.` });
        }
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const read = readFloorSettingValue(setting, b['value']);
        if (!read.ok) throw apiError(400, { code: 'not_readable_as_a_floor_setting', whatHappened: read.why, wasItSaved: 'not_saved', nextSafeAction: 'Correct the value and send it again. Nothing was changed.' });
        if (b['reason'] !== undefined && (typeof b['reason'] !== 'string' || b['reason'].length > 300)) {
          throw apiError(400, { code: 'not_readable_as_a_floor_setting', whatHappened: 'The reason, when given, is text of up to 300 characters.', wasItSaved: 'not_saved', nextSafeAction: 'Send a short reason, or none. Nothing was changed.' });
        }
        const value = (read as { value: FloorDeviceSettingValue }).value;
        const all = await deps.settings(ctx.tenantId);
        const before = effectiveFloorSettings(all).find((e) => e.setting === setting)!;
        if (before.source === 'owner_entry' && same(before.value, value)) return { status: 200, body: { setting: before, unchanged: true } };
        const at = deps.now();
        const entry: FloorDeviceSetting = {
          setting, value, version: before.version + 1, setBy: ctx.userId, setAt: at,
          ...(typeof b['reason'] === 'string' && b['reason'].trim() !== '' ? { reason: b['reason'].trim() } : {}),
        };
        await deps.record(ctx.tenantId, entry, ctx.idempotencyKey ?? `${setting}-${at}`);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'floor.setting.set', objectType: 'floor_device_setting', objectId: setting, at,
          origin: { tenantId: ctx.tenantId, branchId: null },
          before: { value: JSON.stringify(before.value), source: before.source, version: String(before.version) },
          after: { value: JSON.stringify(value), source: 'owner_entry', version: String(entry.version) },
          ...(entry.reason === undefined ? {} : { reason: entry.reason }),
          correlationId: setting,
        });
        return { status: 201, body: { setting: effectiveFloorSettings([...all, entry]).find((e) => e.setting === setting) } };
      },
    },
  ];
}
