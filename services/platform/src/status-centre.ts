// The status centre (M33-FR-04) — the single screen an administrator opens first, on the cloud API.
//
// It reports **real** health (P-08 / M35): the same evidence-driven `checkHealth` the operational-health
// read uses, so a status page can never disagree with reality — an absent signal is `unknown`, never a
// cheerful `ok`. Around that it composes what the platform already knows: the device fleet at a glance
// (trading vs blocked, from the registry judged against the stored version policy), how many support
// sessions are open right now (from the durable support-access lifecycle), and any entitlements about to
// lapse — folded by the tested `statusCentre` engine into one verdict with a plain-English headline, worst
// thing first (control by exception, P-03).
//
// A pure read/compute over supplied evidence and stored state — it writes nothing. POST because the health
// evidence is a body, not a query (the same shape operational-health takes). Gated `platform.health.read`.
//
// Note (M33-FR-04, still open): entitlement *expiry* alerting needs licence/expiry dates the product does
// not yet store — so `entitlementsExpiringSoon` is empty until that is built. The health, fleet and
// support-session portions are real today.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { checkHealth, DEFAULT_THRESHOLDS, type HealthSignals } from '../../../packages/ops/src/index';
import { statusCentre, type SupportSession, type EntitlementState } from '../../../packages/platform-admin/src/support-access';

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

// Read the evidence, refusing a field of the WRONG type but accepting any field ABSENT — the engine reports
// an absent signal as `unknown` (P-08). The same reader shape as the operational-health read.
function readSignals(v: unknown): HealthSignals | undefined {
  if (!isObj(v)) return undefined;
  const s = v;
  const strOrOk = (k: string): boolean => s[k] === undefined || isStr(s[k]);
  const numOrOk = (k: string): boolean => s[k] === undefined || isNum(s[k]);
  const boolOrOk = (k: string): boolean => s[k] === undefined || isBool(s[k]);
  if (!strOrOk('lastSyncAt') || !numOrOk('queueDepth') || !numOrOk('deadLetterCount') || !strOrOk('catalogueBuiltAt')
    || !boolOrOk('databaseReachable') || !boolOrOk('localStoreWritable') || !strOrOk('lastBackupAt') || !numOrOk('backupMaxAgeSeconds')) {
    return undefined;
  }
  if (s['integrations'] !== undefined && !(isObj(s['integrations']) && Object.values(s['integrations']).every(isBool))) return undefined;
  return s as HealthSignals;
}

export interface StatusCentreDeps {
  /** The fleet at a glance, from the device registry judged against the stored version policy. */
  readonly fleet: (tenantId: string) => Promise<{ readonly total: number; readonly trading: number; readonly blocked: number }> | { readonly total: number; readonly trading: number; readonly blocked: number };
  /** Every support session ever granted; the engine counts the ones live right now. */
  readonly supportSessions: (tenantId: string) => Promise<readonly SupportSession[]> | readonly SupportSession[];
  /** Entitlements with their lapse dates; empty until licence/expiry data is stored (M33-FR-04, open). */
  readonly entitlements: (tenantId: string) => Promise<readonly EntitlementState[]> | readonly EntitlementState[];
  readonly now: () => string;
  readonly entitlementWarnDays?: number;
}

export function statusCentreRoutes(deps: StatusCentreDeps): readonly Route[] {
  return [
    {
      // The status centre. Body: { signals }, the same operational evidence the edge reports (each field
      // optional, absent reads as unknown). A pure read — POST because the evidence is a body; it writes nothing.
      api: 'API-11', method: 'POST', path: '/v1/platform/status-centre',
      permission: 'platform.health.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const signals = readSignals(b['signals'] ?? {});
        if (signals === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_health_evidence',
            whatHappened: 'The status centre needs { signals } (each field optional, absent reads as unknown), each of the right type.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the evidence the edge reports. A read never writes.',
          });
        }
        const now = deps.now();
        const health = checkHealth(signals, now, DEFAULT_THRESHOLDS);
        const [fleet, supportSessions, entitlements] = await Promise.all([
          Promise.resolve(deps.fleet(ctx.tenantId)),
          Promise.resolve(deps.supportSessions(ctx.tenantId)),
          Promise.resolve(deps.entitlements(ctx.tenantId)),
        ]);
        const centre = statusCentre({
          tenantId: ctx.tenantId, health, fleet, supportSessions, entitlements, now,
          ...(deps.entitlementWarnDays !== undefined ? { entitlementWarnDays: deps.entitlementWarnDays } : {}),
        });
        return { status: 200, body: centre };
      },
    },
  ];
}
