// Licence / entitlement expiry and its alerting (M33-FR-04 · SEC — "an expiring licence alerts a named
// owner"). Distinct from the M36 feature on/off entitlement: a LICENCE is time-bound and has a real person
// responsible for renewing it, so it can lapse — and the whole point of the requirement is that it must not
// lapse silently.
//
//   • SET a licence — which module it covers, whether it is on, when it expires, and WHO must renew it (a
//     licence with no named owner is refused; there is no such thing as everybody's-and-therefore-nobody's
//     renewal). Append-only: each set is a new version; the latest is effective (hard rule #2/#6).
//   • LIST the licences.
//   • ALERT — the licences expiring soon, worst first, each naming the owner who must act. An EXPIRED licence
//     stays in the list and keeps shouting — it does not drop off the day it lapses, which is precisely when
//     most systems go quiet. This is what makes "an expiring licence alerts a named owner" real, and it also
//     feeds the status centre's expiring-entitlements list.
//
// Writes are gated platform.entitlement.manage; reads platform.entitlement.read. No AI writes anything (#5).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isIsoDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

/** A time-bound entitlement with a named owner responsible for renewing it. */
export interface LicenceState {
  readonly moduleId: string;
  readonly name: string;
  readonly enabled: boolean;
  /** ISO-8601 date (YYYY-MM-DD). Omit for a perpetual licence. */
  readonly expiresOn?: string;
  readonly ownerUserId: string;
  readonly ownerName: string;
}

export type LicenceAlertLevel = 'expired' | 'critical' | 'warning' | 'notice';

export interface LicenceAlert {
  readonly moduleId: string;
  readonly name: string;
  readonly expiresOn: string;
  /** Negative once it has expired. */
  readonly daysRemaining: number;
  readonly level: LicenceAlertLevel;
  readonly ownerUserId: string;
  readonly ownerName: string;
  readonly message: string;
}

/** Per-tenant alerting thresholds — chosen, not hard-coded into the alert read. */
export interface LicenceAlertPolicy {
  readonly noticeDays: number;
  readonly warningDays: number;
  readonly criticalDays: number;
}

export const DEFAULT_LICENCE_ALERT_POLICY: LicenceAlertPolicy = { noticeDays: 60, warningDays: 30, criticalDays: 7 };

/** One append-only change to a licence. The WHOLE licence is carried each time (latest wins). */
export interface LicenceEvent {
  readonly licence: LicenceState;
  readonly by: string;
  readonly at: string;
}

/** Fold the append-only log to the current licences — the latest set of a moduleId wins. */
export function projectLicences(events: readonly LicenceEvent[]): readonly LicenceState[] {
  const byModule = new Map<string, LicenceState>();
  for (const e of events) byModule.set(e.licence.moduleId, e.licence);
  return [...byModule.values()];
}

function daysBetweenDates(from: string, to: string): number {
  return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * The licences that need attention, worst first. An expired licence stays in the list and keeps shouting —
 * it does not drop off the day it lapses (that is when the reminder matters most). Only enabled licences with
 * an expiry raise an alert; a perpetual or disabled one never does.
 */
export function licenceAlerts(
  licences: readonly LicenceState[],
  asOfDate: string,
  policy: LicenceAlertPolicy = DEFAULT_LICENCE_ALERT_POLICY,
): readonly LicenceAlert[] {
  const alerts: LicenceAlert[] = [];
  for (const l of licences) {
    if (!l.enabled || l.expiresOn === undefined) continue;
    const daysRemaining = daysBetweenDates(asOfDate, l.expiresOn);
    if (daysRemaining > policy.noticeDays) continue;
    const level: LicenceAlertLevel =
      daysRemaining < 0 ? 'expired'
        : daysRemaining <= policy.criticalDays ? 'critical'
          : daysRemaining <= policy.warningDays ? 'warning'
            : 'notice';
    const message = daysRemaining < 0
      ? `${l.name} EXPIRED ${-daysRemaining} day(s) ago — ${l.ownerName} must renew it now`
      : `${l.name} expires in ${daysRemaining} day(s) — ${l.ownerName} to renew`;
    alerts.push({ moduleId: l.moduleId, name: l.name, expiresOn: l.expiresOn, daysRemaining, level, ownerUserId: l.ownerUserId, ownerName: l.ownerName, message });
  }
  return alerts.sort((a, b) => a.daysRemaining - b.daysRemaining); // most overdue first
}

export interface LicenceDeps {
  readonly licences: (tenantId: string) => Promise<readonly LicenceState[]> | readonly LicenceState[];
  readonly recordLicence: (tenantId: string, event: LicenceEvent, key: string) => Promise<void> | void;
  /** ISO-8601 UTC datetime; the alert read compares on its date portion. */
  readonly now: () => string;
  readonly policy?: LicenceAlertPolicy;
}

export function licenceRoutes(deps: LicenceDeps): readonly Route[] {
  return [
    {
      // Record a licence — which module, on/off, expiry, and the NAMED owner who must renew it. A licence
      // with no named owner is refused (there is no renewal without a person to do it).
      api: 'API-11', method: 'POST', path: '/v1/platform/licences/:moduleId',
      permission: 'platform.entitlement.manage', idempotent: true,
      handler: async (ctx) => {
        const moduleId = ctx.params['moduleId'] ?? '';
        const b = ctx.body;
        if (!isObj(b) || !isStr(b['name']) || !isBool(b['enabled'])) {
          throw apiError(400, { code: 'not_readable_as_a_licence', whatHappened: 'A licence needs { name, enabled, ownerUserId, ownerName } and an optional expiresOn (YYYY-MM-DD).', wasItSaved: 'not_saved', nextSafeAction: 'Send the licence details.' });
        }
        if (b['expiresOn'] !== undefined && !isIsoDate(b['expiresOn'])) {
          throw apiError(400, { code: 'expires_on_not_a_date', whatHappened: 'expiresOn must be an ISO date like 2027-03-31 when given.', wasItSaved: 'not_saved', nextSafeAction: 'Send the expiry date, or leave it out for a perpetual licence.' });
        }
        if (!isStr(b['ownerUserId']) || !isStr(b['ownerName'])) {
          throw apiError(422, { code: 'licence_owner_unnamed', whatHappened: 'A licence must name the person responsible for renewing it (ownerUserId + ownerName).', wasItSaved: 'not_saved', nextSafeAction: 'Name a real owner — an unnamed licence has nobody to renew it.' });
        }
        const licence: LicenceState = {
          moduleId, name: (b['name'] as string).trim(), enabled: b['enabled'] as boolean,
          ...(isIsoDate(b['expiresOn']) ? { expiresOn: b['expiresOn'] } : {}),
          ownerUserId: (b['ownerUserId'] as string).trim(), ownerName: (b['ownerName'] as string).trim(),
        };
        const at = deps.now();
        await deps.recordLicence(ctx.tenantId, { licence, by: ctx.userId, at }, ctx.idempotencyKey ?? `licence-${moduleId}-${at}`);
        return { status: 200, body: { licence, at } };
      },
    },
    {
      // Every licence and its state.
      api: 'API-11', method: 'GET', path: '/v1/platform/licences',
      permission: 'platform.entitlement.read',
      handler: async (ctx) => ({ status: 200, body: { licences: await deps.licences(ctx.tenantId), asAt: deps.now() } }),
    },
    {
      // The alert view — licences expiring soon (and already expired), worst first, each naming the owner who
      // must renew it. This is "an expiring licence alerts a named owner."
      api: 'API-11', method: 'GET', path: '/v1/platform/licences/alerts',
      permission: 'platform.entitlement.read',
      handler: async (ctx) => {
        const asOfDate = deps.now().slice(0, 10);
        const alerts = licenceAlerts(await deps.licences(ctx.tenantId), asOfDate, deps.policy);
        return { status: 200, body: { alerts, expired: alerts.filter((a) => a.level === 'expired').length, asAt: deps.now() } };
      },
    },
  ];
}
