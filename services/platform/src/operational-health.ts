// API-11 Operational health & alerting (M35-FR-03/04 · §32) — the owner's "is the shop healthy, and can
// I still trade?" read on the cloud. NOT the liveness probe (`/v1/platform/health` answers "is this
// service up"); this answers the operational question from EVIDENCE the edge and services report — sync
// lag, outbox depth, dead letters, catalogue age, backup age, integrations — and it holds two lines that
// matter more than any single number:
//
//   • `canTrade` is SEPARATE from `status` (P-01). Every cloud-side failure above degrades the status
//     while the store keeps selling; the ONLY thing that stops a lane is being unable to record the sale
//     locally. A cloud outage must never read as "stop selling."
//   • A missing signal is `unknown`, never a cheerful `ok` (P-08) — the absence of a heartbeat is not a
//     heartbeat.
//
// Alerts turn the verdict into OWNED, actionable work: each routes to a named person with a §32
// acknowledgement deadline — an alert nobody owns is noise (M35-FR-04). The rules are the tested
// `checkHealth` / `raiseAlerts` in `@sre/ops`. A pure read/compute over supplied evidence — it writes
// nothing. Gated `platform.health.read`.
//
// Named follow-on: `escalateUnacknowledged` (the OTHER half of FR-04) is a function of TIME and
// persisted acknowledgement state — an alert escalates once its deadline passes with nobody having
// acknowledged. That is stateful (raise now, escalate later) and belongs to an alert-lifecycle store, not
// this stateless compute, where every alert's deadline is by definition still in the future.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  checkHealth, raiseAlerts, DEFAULT_THRESHOLDS,
  type HealthSignals, type HealthThresholds, type HealthStatus, type AlertRule,
} from '../../../packages/ops/src/index';

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const STATUSES: readonly HealthStatus[] = ['ok', 'degraded', 'down', 'unknown'];

// Read the evidence, rejecting a field of the WRONG type (a string queue depth would silently misjudge
// the outbox) but accepting any field ABSENT — the engine reports an absent signal as `unknown`.
// Exported so the alert-lifecycle store (which PERSISTS a raise) validates evidence the same way this
// stateless read does — one parser, so the two surfaces can never disagree on what health evidence is.
export function readSignals(v: unknown): HealthSignals | undefined {
  if (!isObj(v)) return undefined;
  const s = v;
  const strOrOk = (k: string) => s[k] === undefined || isStr(s[k]);
  const numOrOk = (k: string) => s[k] === undefined || isNum(s[k]);
  const boolOrOk = (k: string) => s[k] === undefined || isBool(s[k]);
  if (!strOrOk('lastSyncAt') || !numOrOk('queueDepth') || !numOrOk('deadLetterCount') || !strOrOk('catalogueBuiltAt')
    || !boolOrOk('databaseReachable') || !boolOrOk('localStoreWritable') || !strOrOk('lastBackupAt') || !numOrOk('backupMaxAgeSeconds')) {
    return undefined;
  }
  if (s['integrations'] !== undefined && !(isObj(s['integrations']) && Object.values(s['integrations']).every(isBool))) return undefined;
  return s as HealthSignals;
}

// Thresholds are per-tenant (§32 gives the defaults). A partial object fills the rest from the defaults;
// a field of the wrong type is refused rather than silently ignored.
export function readThresholds(v: unknown): HealthThresholds | undefined {
  if (v === undefined) return DEFAULT_THRESHOLDS;
  if (!isObj(v)) return undefined;
  const keys: readonly (keyof HealthThresholds)[] = ['syncLagWarnSeconds', 'syncLagCriticalSeconds', 'queueDepthWarn', 'queueDepthCritical', 'deadLetterCritical', 'catalogueStaleSeconds'];
  const out = { ...DEFAULT_THRESHOLDS };
  for (const k of keys) {
    if (v[k] === undefined) continue;
    if (!isNum(v[k]) || (v[k] as number) < 0) return undefined;
    out[k] = v[k] as number;
  }
  return out;
}

export function readRules(v: unknown): readonly AlertRule[] | undefined {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return undefined;
  const out: AlertRule[] = [];
  for (const raw of v) {
    if (!isObj(raw) || !isStr(raw['alertId']) || !isStr(raw['component']) || !STATUSES.includes(raw['firesAt'] as HealthStatus)
      || !isStr(raw['ownerUserId']) || !isStr(raw['ownerName']) || !isNum(raw['ackWithinMinutes']) || (raw['ackWithinMinutes'] as number) <= 0
      || (raw['escalatesToUserId'] !== undefined && !isStr(raw['escalatesToUserId']))) {
      return undefined;
    }
    out.push({
      alertId: raw['alertId'] as string, component: raw['component'] as string, firesAt: raw['firesAt'] as HealthStatus,
      ownerUserId: raw['ownerUserId'] as string, ownerName: raw['ownerName'] as string, ackWithinMinutes: raw['ackWithinMinutes'] as number,
      ...(isStr(raw['escalatesToUserId']) ? { escalatesToUserId: raw['escalatesToUserId'] } : {}),
    });
  }
  return out;
}

export interface OperationalHealthDeps {
  readonly now: () => string;
}

export function operationalHealthRoutes(deps: OperationalHealthDeps): readonly Route[] {
  return [
    {
      // Compute operational health from evidence, then the owned alerts. Body:
      // { signals, thresholds?, alertRules? }. A pure compute — POST because the evidence is a body,
      // not a query; it writes nothing.
      api: 'API-11', method: 'POST', path: '/v1/platform/operational-health',
      permission: 'platform.health.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const signals = readSignals(b['signals'] ?? {});
        const thresholds = readThresholds(b['thresholds']);
        const rules = readRules(b['alertRules']);
        if (signals === undefined || thresholds === undefined || rules === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_health_evidence',
            whatHappened: 'Operational health needs { signals } (each field optional, absent reads as unknown) and optional { thresholds, alertRules[] }, each of the right type.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the evidence the edge reports. A read never writes.',
          });
        }
        const now = deps.now();
        const health = checkHealth(signals, now, thresholds);
        const alerts = raiseAlerts(health, rules);
        return { status: 200, body: { health, alerts } };
      },
    },
  ];
}
