// API-10 Owner exception alerts raised by head office itself (OB-288 P2 · M29-FR-03 · Annexure H · P-03 · P-08).
//
// `POST /v1/reporting/owner-alerts` only grouped the events a caller sent; nothing looked at the shop's own records and
// told the owner. Here head office does it, on the ops-alert worker's timer, so the owner is told while he is away from
// the store: the five exceptions the roadmap names — a large discount, a voided bill, a price override, an after-hours
// sign-in and a till short of cash — are read from the records the store computers sync (the till actions and the till
// closes), grouped by the tested `raiseOwnerAlerts` engine, and raised into every owner's alert inbox, once per group
// per trading day.
//
// ── The five thresholds are the OWNER'S, and none is invented ─────────────────────────────────────────────────────────
// Each is "not set" until he enters it. A threshold not set raises NOTHING — and every screen and read says so in those
// words, because "no alerts" from an unset threshold reads exactly like a clean day. Setting, changing or clearing one is
// the owner's alone (`owner.alert.manage`), kept append-only (the latest applies; every earlier value stays) and sealed
// on the audit trail.
//
// ── A source head office does not receive is said, never assumed clean ───────────────────────────────────────────────
// OB-365 (owner, 24–25 Oct 2026, in writing): a sign-in at a till is checked by the store computer, which now SENDS its
// sign-in log to head office — so the after-hours alert, and the sixth alert, failed sign-ins (a wrong PIN, a lockout),
// fire from head office like the others. Until a store computer's first record arrives the source says it has none yet
// ("as at" empty), and a kind head office does not receive is still said by name ("not known"), never "none".
//
// Nothing here commits a business action (hard rule #5): an alert is a message to a person. Nothing is deleted (#6).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { raiseOwnerAlerts, type ExceptionEvent, type ExceptionKind, type OwnerThresholds, type OwnerAlert } from '../../../packages/owner-control/src/index';

export const THRESHOLD_KINDS: readonly ExceptionKind[] = Object.freeze(['large_discount', 'voided_bill', 'price_override', 'after_hours_login', 'cash_short', 'failed_sign_in']);

/** What a threshold is measured in — how the screen asks for it and how it is checked. */
export const THRESHOLD_UNITS: Readonly<Record<ExceptionKind, 'paise' | 'count' | 'hours'>> = Object.freeze({
  large_discount: 'paise', voided_bill: 'count', price_override: 'count', after_hours_login: 'hours', cash_short: 'paise', failed_sign_in: 'count',
});

/** The words each threshold is shown in, English and Tamil. */
export const THRESHOLD_WORDS: Readonly<Record<ExceptionKind, { readonly en: string; readonly ta: string }>> = Object.freeze({
  large_discount: { en: 'Large discount: one bill with this much or more taken off by price overrides', ta: 'பெரிய தள்ளுபடி: விலை மாற்றத்தால் ஒரு பில்லில் இவ்வளவு அல்லது அதிகம் குறைக்கப்பட்டால்' },
  voided_bill: { en: 'Voided bills: this many or more by one person in a day', ta: 'ரத்து செய்த பில்கள்: ஒருவர் ஒரு நாளில் இத்தனை அல்லது அதிகம்' },
  price_override: { en: 'Price overrides: this many or more by one person in a day', ta: 'விலை மாற்றங்கள்: ஒருவர் ஒரு நாளில் இத்தனை அல்லது அதிகம்' },
  after_hours_login: { en: 'After-hours sign-in: a sign-in outside these trading hours', ta: 'நேரம் கடந்த உள்நுழைவு: இந்த வணிக நேரத்துக்கு வெளியே உள்நுழைந்தால்' },
  cash_short: { en: 'Cash short: a till this much or more short at its close', ta: 'பணக் குறைவு: மூடும்போது ஒரு கல்லாவில் இவ்வளவு அல்லது அதிகம் குறைந்தால்' },
  // OB-365: from the till sign-in log the store computers send.
  failed_sign_in: { en: 'Failed sign-ins: this many or more failed till sign-ins by one staff ID in a day', ta: 'தோல்வியுற்ற உள்நுழைவுகள்: ஒரு பணியாளர் எண் ஒரு நாளில் இத்தனை அல்லது அதிகம் முறை கல்லாவில் உள்நுழையத் தவறினால்' },
});

/** The trading hours an after-hours sign-in is judged by (local, whole hours: opens at, closes at). */
export interface TradingHours { readonly opensAtHour: number; readonly closesAtHour: number }

/** One append-only fact: a threshold set (or cleared — `value: null`) by the owner. The latest per kind applies. */
export interface ThresholdSetting {
  readonly kind: ExceptionKind;
  readonly value: number | TradingHours | null;
  readonly setBy: string;
  readonly setAt: string;
  readonly reason?: string;
}

/** Whether head office receives the records an exception kind is judged from. */
export interface ExceptionSource {
  readonly kind: ExceptionKind;
  readonly known: boolean;
  /** The newest record of that kind head office holds (the source's own time); null when none has arrived. */
  readonly asAt: string | null;
  readonly why?: string;
}

/** One threshold as the screen shows it. */
export interface ThresholdView {
  readonly kind: ExceptionKind;
  readonly unit: 'paise' | 'count' | 'hours';
  readonly words: { readonly en: string; readonly ta: string };
  readonly state: 'set' | 'not_set';
  readonly value: number | TradingHours | null;
  readonly setBy: string | null;
  readonly setAt: string | null;
  /** True only when it is set AND head office receives the records it is judged from. */
  readonly canFire: boolean;
  /** Why it cannot fire, in words — present whenever `canFire` is false. */
  readonly whyNot?: string;
}

export const NOT_SET_SAY = 'Not set. This alert does not fire until you enter it.';

/** The latest setting per kind (append order; a cleared one is `null`). */
export function latestThresholds(settings: readonly ThresholdSetting[]): ReadonlyMap<ExceptionKind, ThresholdSetting> {
  const out = new Map<ExceptionKind, ThresholdSetting>();
  for (const s of settings) out.set(s.kind, s);
  return out;
}

/** The engine's thresholds: ONLY the kinds the owner has set. An unset kind is absent, so the engine raises nothing for it. */
export function engineThresholds(settings: readonly ThresholdSetting[]): OwnerThresholds {
  const latest = latestThresholds(settings);
  const n = (k: ExceptionKind): number | undefined => {
    const v = latest.get(k)?.value;
    return typeof v === 'number' ? v : undefined;
  };
  const hours = latest.get('after_hours_login')?.value;
  return {
    ...(n('large_discount') === undefined ? {} : { largeDiscountMinor: n('large_discount')! }),
    ...(n('voided_bill') === undefined ? {} : { voidedBillCount: n('voided_bill')! }),
    ...(n('price_override') === undefined ? {} : { priceOverrideCount: n('price_override')! }),
    ...(n('cash_short') === undefined ? {} : { cashShortMinor: n('cash_short')! }),
    ...(n('failed_sign_in') === undefined ? {} : { failedSignInCount: n('failed_sign_in')! }),
    ...(hours !== null && typeof hours === 'object' ? { tradingHours: [hours.opensAtHour, hours.closesAtHour] as const } : {}),
  };
}

/** The five thresholds as the screen shows them — each set or "not set", and whether it can fire. */
export function thresholdBoard(settings: readonly ThresholdSetting[], sources: readonly ExceptionSource[]): readonly ThresholdView[] {
  const latest = latestThresholds(settings);
  return THRESHOLD_KINDS.map((kind) => {
    const s = latest.get(kind);
    const set = s !== undefined && s.value !== null;
    const source = sources.find((x) => x.kind === kind);
    const known = source?.known ?? false;
    const whyNot = !set ? NOT_SET_SAY : !known ? `Set, but it cannot fire: ${source?.why ?? 'head office does not receive the records it is judged from'}.` : undefined;
    return {
      kind, unit: THRESHOLD_UNITS[kind], words: THRESHOLD_WORDS[kind],
      state: set ? 'set' as const : 'not_set' as const, value: set ? s!.value : null,
      setBy: set ? s!.setBy : null, setAt: set ? s!.setAt : null,
      canFire: set && known, ...(whyNot === undefined ? {} : { whyNot }),
    };
  });
}

/** Read a threshold value for its kind — or say why it is not one. */
export function readThresholdValue(kind: ExceptionKind, raw: unknown): { ok: true; value: number | TradingHours } | { ok: false; why: string } {
  const unit = THRESHOLD_UNITS[kind];
  if (unit === 'hours') {
    const r = raw as Record<string, unknown> | null;
    const o = r?.['opensAtHour']; const c = r?.['closesAtHour'];
    if (typeof r !== 'object' || r === null || !Number.isInteger(o) || !Number.isInteger(c) || (o as number) < 0 || (o as number) > 23 || (c as number) < 1 || (c as number) > 24 || (o as number) >= (c as number)) {
      return { ok: false, why: 'Trading hours are { opensAtHour, closesAtHour }: whole hours, opening 0–23, closing 1–24, opening before closing.' };
    }
    return { ok: true, value: { opensAtHour: o as number, closesAtHour: c as number } };
  }
  if (!Number.isSafeInteger(raw) || (raw as number) <= 0) {
    return { ok: false, why: unit === 'paise' ? 'The amount is a whole number of paise, more than nought (₹500 is 50000).' : 'The number is a whole number, at least 1.' };
  }
  return { ok: true, value: raw as number };
}

export interface OwnerExceptionsDeps {
  readonly now: () => string;
  /** Every threshold setting, oldest first (append-only). */
  readonly settings: (tenantId: string) => Promise<readonly ThresholdSetting[]>;
  readonly recordSetting: (tenantId: string, setting: ThresholdSetting, key: string) => Promise<void>;
  /** The shop's trading day now, by its own calendar. */
  readonly today: (tenantId: string) => Promise<string>;
  /** The trading day before `day`. */
  readonly dayBefore: (day: string) => string;
  /** The day's exception events from the synced records, and which kinds head office receives at all. */
  readonly exceptions: (tenantId: string, day: string) => Promise<{ readonly events: readonly ExceptionEvent[]; readonly sources: readonly ExceptionSource[] }>;
  /** Raise each alert into every owner's inbox, once per alert per day. Answers how many were NEWLY raised. */
  readonly raise: (tenantId: string, day: string, alerts: readonly OwnerAlert[], at: string, by: string) => Promise<{ readonly raised: number; readonly alreadyRaised: number; readonly owners: number }>;
  /** The ids of this day's alerts already in the owners' inbox. */
  readonly raisedIds: (tenantId: string, day: string) => Promise<ReadonlySet<string>>;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

/** The inbox id of one owner alert on one trading day — deterministic, so a pass run twice raises once. */
export const ownerExceptionAlertId = (day: string, alert: Pick<OwnerAlert, 'alertId'>): string => `owner-exception:${day}:${alert.alertId.replace(/^alert:/, '')}`;

/** What one day looks like: the thresholds, the events, the alerts the owner's thresholds raise from them. */
export async function ownerExceptionsOn(deps: OwnerExceptionsDeps, tenantId: string, day: string) {
  const [settings, { events, sources }] = await Promise.all([deps.settings(tenantId), deps.exceptions(tenantId, day)]);
  const alerts = raiseOwnerAlerts({ events, thresholds: engineThresholds(settings) });
  return { settings, events, sources, alerts, board: thresholdBoard(settings, sources) };
}

/**
 * ONE PASS for one shop (the ops-alert worker's hook, and the owner's "check now"): yesterday and today, by the shop's own
 * trading calendar, so an exception synced after midnight is still raised. Answers how many alerts were newly raised.
 */
export async function sweepOwnerExceptions(deps: OwnerExceptionsDeps, tenantId: string, at: string, by = 'system:owner-exceptions'): Promise<{ readonly raised: number; readonly days: readonly { day: string; alerts: number; raised: number }[] }> {
  const today = await deps.today(tenantId);
  const days = [deps.dayBefore(today), today];
  const out: { day: string; alerts: number; raised: number }[] = [];
  let raised = 0;
  for (const day of days) {
    const { alerts } = await ownerExceptionsOn(deps, tenantId, day);
    const r = alerts.length === 0 ? { raised: 0 } : await deps.raise(tenantId, day, alerts, at, by);
    raised += r.raised;
    out.push({ day, alerts: alerts.length, raised: r.raised });
  }
  return { raised, days: out };
}

const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

export function ownerExceptionRoutes(deps: OwnerExceptionsDeps): readonly Route[] {
  return [
    {
      // The five thresholds — each set (with who set it and when) or "not set", and whether it can fire.
      api: 'API-10', method: 'GET', path: '/v1/reporting/owner-alert-thresholds',
      permission: 'owner.alert.read',
      handler: async (ctx) => {
        const day = await deps.today(ctx.tenantId);
        const [settings, { sources }] = await Promise.all([deps.settings(ctx.tenantId), deps.exceptions(ctx.tenantId, day)]);
        const board = thresholdBoard(settings, sources);
        return { status: 200, body: { thresholds: board, notSet: board.filter((b) => b.state === 'not_set').map((b) => b.kind), asAt: deps.now() } };
      },
    },
    {
      // SET (or CLEAR) one threshold — the owner's alone. Body: { value } (paise, a count, or { opensAtHour, closesAtHour }),
      // or { clear: true, reason }. Append-only: the earlier value stays on the record.
      api: 'API-10', method: 'POST', path: '/v1/reporting/owner-alert-thresholds/:kind',
      permission: 'owner.alert.manage', idempotent: true,
      handler: async (ctx) => {
        const kind = (ctx.params['kind'] ?? '') as ExceptionKind;
        if (!THRESHOLD_KINDS.includes(kind)) {
          throw apiError(404, { code: 'no_such_threshold', whatHappened: `There is no owner alert called "${ctx.params['kind'] ?? ''}".`, wasItSaved: 'not_saved', nextSafeAction: `Use one of: ${THRESHOLD_KINDS.join(', ')}.` });
        }
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const at = deps.now();
        let setting: ThresholdSetting;
        if (b['clear'] === true) {
          if (typeof b['reason'] !== 'string' || b['reason'].trim() === '') {
            throw apiError(400, { code: 'clear_needs_a_reason', whatHappened: 'Clearing a threshold switches its alert off; say why.', wasItSaved: 'not_saved', nextSafeAction: 'Send { clear: true, reason }. Nothing was changed.' });
          }
          setting = { kind, value: null, setBy: ctx.userId, setAt: at, reason: b['reason'].trim() };
        } else {
          const read = readThresholdValue(kind, b['value']);
          if (!read.ok) throw apiError(400, { code: 'not_readable_as_a_threshold', whatHappened: read.why, wasItSaved: 'not_saved', nextSafeAction: 'Correct the value and send it again. Nothing was changed.' });
          setting = { kind, value: (read as { value: number | TradingHours }).value, setBy: ctx.userId, setAt: at };
        }
        const before = latestThresholds(await deps.settings(ctx.tenantId)).get(kind);
        await deps.recordSetting(ctx.tenantId, setting, ctx.idempotencyKey ?? `${kind}-${at}`);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: setting.value === null ? 'owner.alert_threshold.clear' : 'owner.alert_threshold.set', objectType: 'owner_alert_threshold', objectId: kind,
          at, origin: { tenantId: ctx.tenantId, branchId: null },
          before: before === undefined || before.value === null ? null : { value: JSON.stringify(before.value) },
          after: { value: setting.value === null ? 'not set' : JSON.stringify(setting.value) },
          ...(setting.reason === undefined ? {} : { reason: setting.reason }),
          correlationId: kind,
        });
        return { status: 201, body: { kind, state: setting.value === null ? 'not_set' : 'set', value: setting.value, setBy: setting.setBy, setAt: at } };
      },
    },
    {
      // The day's exceptions (?day=YYYY-MM-DD, default today): per kind, what the synced records hold, and the alerts the
      // owner's thresholds raise from them — with each unset threshold, and each source head office does not receive, said.
      api: 'API-10', method: 'GET', path: '/v1/reporting/owner-exceptions',
      permission: 'owner.alert.read',
      handler: async (ctx) => {
        const asked = ctx.query['day'];
        if (asked !== undefined && !isDay(asked)) {
          throw apiError(400, { code: 'not_readable_as_a_day', whatHappened: `"${asked}" is not a trading day (YYYY-MM-DD).`, wasItSaved: 'not_saved', nextSafeAction: 'Send ?day=YYYY-MM-DD, or leave it off for today.' });
        }
        const day = asked ?? await deps.today(ctx.tenantId);
        const { events, sources, alerts, board } = await ownerExceptionsOn(deps, ctx.tenantId, day);
        const inInbox = await deps.raisedIds(ctx.tenantId, day);
        const kinds = THRESHOLD_KINDS.map((kind) => {
          const t = board.find((b) => b.kind === kind)!;
          const s = sources.find((x) => x.kind === kind);
          const mine = events.filter((e) => e.kind === kind);
          return {
            kind, words: THRESHOLD_WORDS[kind], threshold: t.state, canFire: t.canFire,
            // P-08: a kind head office does not receive has no count — "not known", never nought.
            events: s?.known === false ? null : mine.length,
            sourceAsAt: s?.asAt ?? null,
            alerts: alerts.filter((a) => a.kind === kind).length,
            say: t.state === 'not_set' ? NOT_SET_SAY : s?.known === false ? `Not known: ${s.why ?? 'head office does not receive these records'}.` : `${mine.length} recorded; ${alerts.filter((a) => a.kind === kind).length} alert(s).`,
          };
        });
        return {
          status: 200,
          body: {
            tradingDay: day, kinds, thresholds: board,
            alerts: alerts.map((a) => ({ ...a, inboxId: ownerExceptionAlertId(day, a), inOwnersInbox: inInbox.has(ownerExceptionAlertId(day, a)) })),
            asAt: deps.now(),
          },
        };
      },
    },
    {
      // CHECK NOW — the same pass the worker runs on its timer (yesterday and today); idempotent: an alert already in the
      // owners' inbox for the day is never raised twice.
      api: 'API-10', method: 'POST', path: '/v1/reporting/owner-exceptions/raise',
      permission: 'owner.alert.manage', idempotent: true,
      handler: async (ctx) => ({ status: 200, body: { ...(await sweepOwnerExceptions(deps, ctx.tenantId, deps.now(), ctx.userId)), at: deps.now() } }),
    },
  ];
}
