// API-11 Platform — OBSERVED operational health (M35-FR-03 / FR-04 / FR-01).
//
// `POST /v1/platform/operational-health` judges health from evidence the caller SUPPLIES. That was the
// honest first rung: the engine was real, the telemetry was not. These routes make the cloud read its
// own signals instead of being told them — the newest sale any lane has synced (data freshness, the
// number the owner asks for), the connector queues' depth and dead letters (M32), the catalogue pack's
// age, the integration adapters' heartbeats, and the backups the operator has recorded — and judge them
// with the SAME `checkHealth`, so the status page can never disagree with the ledgers.
//
// Alerts need owners (§32). The rules that name who owns which component, and the thresholds, are
// stored per tenant (versioned, latest in force); the raise route reads the observed signals, judges
// them, and writes the alerts into the SAME durable lifecycle store the manual raise uses, so the ack
// and escalation sweep work on them unchanged. With no rules defined nothing is raised — and the route
// says so, rather than inventing an owner (P-05).
//
// What the cloud cannot see it says it cannot see (P-08): the lane's local disk is a lane-side signal
// and stays `unknown` here — it is never guessed `ok`. A backup counts only when it was recorded as
// completed, encrypted AND off-site (FR-01); a failed or unprotected backup is on the record but does
// not move the clock.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  checkHealth, raiseAlerts, DEFAULT_THRESHOLDS,
  type HealthSignals, type HealthThresholds, type AlertRule, type SystemHealth, type RaisedAlert,
} from '../../../packages/ops/src/index';
import { readRules, readThresholds } from './operational-health';
import type { AlertLifecycleDeps, AlertLifecycleEvent } from './alert-lifecycle';

export interface ConnectorQueueDepth {
  readonly connectorId: string;
  readonly queued: number;
  readonly deadLettered: number;
}

/** A backup the operator (or the backup script, through the operator's credential) recorded. */
export interface BackupRecord {
  readonly backupId: string;
  readonly at: string;
  readonly ok: boolean;
  readonly encrypted: boolean;
  readonly offsite: boolean;
  readonly sizeBytes?: number;
  readonly detail?: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
}

/** The alert rules in force for a tenant: who owns which component, at what status, plus the thresholds. */
export interface StoredAlertRules {
  readonly version: number;
  readonly rules: readonly AlertRule[];
  readonly thresholds: HealthThresholds;
  /** How old the newest good backup may be before the `backup` component is `down`. */
  readonly backupMaxAgeSeconds: number;
  readonly definedBy: string;
  readonly definedAt: string;
}

export const DEFAULT_BACKUP_MAX_AGE_SECONDS = 86_400;

export interface ObservedHealthDeps extends Pick<AlertLifecycleDeps, 'alerts' | 'recordAlertEvent'> {
  readonly now: () => string;
  /** The newest sale the cloud has received from any lane — when it happened at the till. */
  readonly lastSaleSyncedAt: (tenantId: string) => Promise<string | undefined> | string | undefined;
  readonly catalogueBuiltAt: (tenantId: string) => Promise<string | undefined> | string | undefined;
  readonly connectorQueues: (tenantId: string) => Promise<readonly ConnectorQueueDepth[]> | readonly ConnectorQueueDepth[];
  /** Per registered, enabled adapter: is it healthy right now (judged from its heartbeats)? */
  readonly integrationHealth: (tenantId: string, at: string) => Promise<Readonly<Record<string, boolean>>> | Readonly<Record<string, boolean>>;
  readonly backups: (tenantId: string) => Promise<readonly BackupRecord[]> | readonly BackupRecord[];
  readonly recordBackup: (tenantId: string, record: BackupRecord) => Promise<void> | void;
  readonly alertRules: (tenantId: string) => Promise<StoredAlertRules | undefined> | StoredAlertRules | undefined;
  readonly defineAlertRules: (tenantId: string, rules: StoredAlertRules) => Promise<void> | void;
}

export interface ObservedSignals {
  readonly signals: HealthSignals;
  /** Where each signal came from — so a screen can say what "fresh" means. */
  readonly provenance: Readonly<Record<string, string>>;
  readonly freshness: { readonly lastSaleAt: string | null; readonly ageSeconds: number | null };
  readonly queues: readonly ConnectorQueueDepth[];
  readonly lastBackup: BackupRecord | null;
  /** Signals the cloud cannot observe from here, named rather than guessed. */
  readonly notObserved: readonly string[];
}

/** A backup that counts (FR-01): completed, encrypted and off-site. */
export const goodBackup = (b: BackupRecord): boolean => b.ok && b.encrypted && b.offsite;

const byAt = (a: { readonly at: string }, b: { readonly at: string }): number => a.at.localeCompare(b.at);

/** Fold the cloud's own ledgers into the health engine's signal shape. Pure over the deps' answers. */
export async function observeSignals(deps: ObservedHealthDeps, tenantId: string, at: string, backupMaxAgeSeconds: number): Promise<ObservedSignals> {
  const [lastSale, catalogue, queues, integrations, backups] = await Promise.all([
    deps.lastSaleSyncedAt(tenantId), deps.catalogueBuiltAt(tenantId), deps.connectorQueues(tenantId),
    deps.integrationHealth(tenantId, at), deps.backups(tenantId),
  ]);
  const sortedBackups = [...backups].sort(byAt);
  const good = [...sortedBackups].reverse().find(goodBackup);
  const latest = sortedBackups[sortedBackups.length - 1];
  const queued = queues.reduce((s, q) => s + q.queued, 0);
  const deadLettered = queues.reduce((s, q) => s + q.deadLettered, 0);
  const signals: HealthSignals = {
    ...(lastSale === undefined ? {} : { lastSyncAt: lastSale }),
    queueDepth: queued,
    deadLetterCount: deadLettered,
    ...(catalogue === undefined ? {} : { catalogueBuiltAt: catalogue }),
    databaseReachable: true,
    integrations,
    ...(good === undefined ? {} : { lastBackupAt: good.at }),
    backupMaxAgeSeconds,
  };
  const ageSeconds = lastSale === undefined ? null : Math.max(0, Math.floor((Date.parse(at) - Date.parse(lastSale)) / 1000));
  return {
    signals,
    provenance: {
      lastSyncAt: 'the newest sale the cloud has received from any lane, at the time it was rung up (SaleCommitted)',
      queueDepth: `messages still queued across ${queues.length} connector queue(s)`,
      deadLetterCount: `messages dead-lettered across ${queues.length} connector queue(s) — each one still needs a person`,
      catalogueBuiltAt: 'when the latest published catalogue pack was built',
      databaseReachable: 'this very read came from the cloud database',
      integrations: 'each enabled adapter judged from its recorded heartbeats',
      lastBackupAt: 'the newest backup recorded as completed, encrypted and off-site; a failed or unprotected backup is kept but does not count',
    },
    freshness: { lastSaleAt: lastSale ?? null, ageSeconds },
    queues,
    lastBackup: latest ?? null,
    notObserved: ['localStoreWritable — a lane-side signal (the store box reports it through its own health check); never guessed ok here'],
  };
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isIso = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) && !Number.isNaN(Date.parse(v));

export function observedHealthRoutes(deps: ObservedHealthDeps): readonly Route[] {
  const judge = async (tenantId: string, at: string) => {
    const stored = await deps.alertRules(tenantId);
    const observed = await observeSignals(deps, tenantId, at, stored?.backupMaxAgeSeconds ?? DEFAULT_BACKUP_MAX_AGE_SECONDS);
    const health: SystemHealth = checkHealth(observed.signals, at, stored?.thresholds ?? DEFAULT_THRESHOLDS);
    const alerts: readonly RaisedAlert[] = raiseAlerts(health, stored?.rules ?? []);
    return { stored, observed, health, alerts };
  };

  return [
    {
      api: 'API-11', method: 'GET', path: '/v1/platform/alert-rules',
      permission: 'platform.health.read',
      handler: async (ctx) => ({
        status: 200,
        body: {
          rules: (await deps.alertRules(ctx.tenantId)) ?? null,
          defaults: { thresholds: DEFAULT_THRESHOLDS, backupMaxAgeSeconds: DEFAULT_BACKUP_MAX_AGE_SECONDS },
          asAt: deps.now(),
        },
      }),
    },
    {
      api: 'API-11', method: 'PUT', path: '/v1/platform/alert-rules',
      permission: 'platform.alert.manage', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const rules = Array.isArray(b['rules']) ? readRules(b['rules']) : undefined;
        const thresholds = readThresholds(b['thresholds']);
        const maxAge = b['backupMaxAgeSeconds'] === undefined ? DEFAULT_BACKUP_MAX_AGE_SECONDS : b['backupMaxAgeSeconds'];
        if (rules === undefined || rules.length === 0 || thresholds === undefined || !Number.isInteger(maxAge) || (maxAge as number) <= 0) {
          throw apiError(400, {
            code: 'alert_rules_not_readable',
            whatHappened: 'Alert rules need a non-empty rules[] (alertId, component, firesAt, ownerUserId, ownerName, ackWithinMinutes, optional escalatesToUserId), '
              + 'optional thresholds of the right type and an optional positive whole backupMaxAgeSeconds. Every alert needs a named owner (§32).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Correct the rules and send the whole set again. The rules in force are unchanged.',
          });
        }
        const current = await deps.alertRules(ctx.tenantId);
        const stored: StoredAlertRules = {
          version: (current?.version ?? 0) + 1, rules, thresholds, backupMaxAgeSeconds: maxAge as number,
          definedBy: ctx.userId, definedAt: deps.now(),
        };
        await deps.defineAlertRules(ctx.tenantId, stored);
        return { status: 200, body: { version: stored.version, rules: rules.length, components: [...new Set(rules.map((r) => r.component))] } };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/platform/operational-health/observed',
      permission: 'platform.health.read',
      handler: async (ctx) => {
        const at = deps.now();
        const { stored, observed, health, alerts } = await judge(ctx.tenantId, at);
        return {
          status: 200,
          body: { observed, health, wouldRaise: alerts, rulesVersion: stored?.version ?? null, asAt: at },
        };
      },
    },
    {
      api: 'API-11', method: 'POST', path: '/v1/platform/operational-health/observed/raise',
      permission: 'platform.alert.manage', idempotent: true,
      handler: async (ctx) => {
        const at = deps.now();
        const { stored, observed, health, alerts } = await judge(ctx.tenantId, at);
        if (stored === undefined) {
          throw apiError(409, {
            code: 'alert_rules_not_defined',
            whatHappened: 'No alert rules are defined for this shop, so nothing can be raised — an alert without a named owner is noise nobody answers (§32).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Define the rules first (PUT /v1/platform/alert-rules: who owns which component, at what status, how soon they must acknowledge). Nothing was raised.',
          });
        }
        const known = new Set((await deps.alerts(ctx.tenantId)).map((a) => a.alert.alertId));
        let newlyOpened = 0;
        for (const alert of alerts) {
          const rule = stored.rules.find((r) => r.alertId === alert.alertId);
          const event: AlertLifecycleEvent = {
            alertId: alert.alertId, change: 'raised', by: ctx.userId, at, alert,
            ...(rule?.escalatesToUserId !== undefined ? { escalatesToUserId: rule.escalatesToUserId } : {}),
          };
          await deps.recordAlertEvent(ctx.tenantId, event, `raise-${alert.alertId}`);
          if (!known.has(alert.alertId)) newlyOpened += 1;
        }
        return { status: 200, body: { raised: alerts.length, newlyOpened, alerts, health, observed, rulesVersion: stored.version, at } };
      },
    },
    {
      api: 'API-11', method: 'POST', path: '/v1/platform/backups/:backupId/taken',
      permission: 'platform.backup.record', idempotent: true,
      handler: async (ctx) => {
        const backupId = ctx.params['backupId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isIso(b['at']) || !isBool(b['ok']) || !isBool(b['encrypted']) || !isBool(b['offsite'])
          || (b['sizeBytes'] !== undefined && (!Number.isInteger(b['sizeBytes']) || (b['sizeBytes'] as number) < 0))
          || (b['detail'] !== undefined && !isStr(b['detail']))) {
          throw apiError(400, {
            code: 'not_readable_as_a_backup_record',
            whatHappened: 'A backup record needs when it ran (ISO time) and whether it completed (ok), was encrypted and was copied off-site; optionally its size in bytes and a detail.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the four facts about the backup. Nothing was recorded.',
          });
        }
        if ((await deps.backups(ctx.tenantId)).some((x) => x.backupId === backupId)) {
          throw apiError(409, {
            code: 'backup_already_recorded',
            whatHappened: `${backupId} is already on the record. A backup is recorded once.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Record the next backup under its own id. Nothing was changed.',
          });
        }
        const record: BackupRecord = {
          backupId, at: b['at'], ok: b['ok'], encrypted: b['encrypted'], offsite: b['offsite'],
          ...(Number.isInteger(b['sizeBytes']) ? { sizeBytes: b['sizeBytes'] as number } : {}),
          ...(isStr(b['detail']) ? { detail: b['detail'] } : {}),
          recordedBy: ctx.userId, recordedAt: deps.now(),
        };
        await deps.recordBackup(ctx.tenantId, record);
        return {
          status: 201,
          body: {
            backupId, counts: goodBackup(record),
            ...(goodBackup(record) ? {} : { why: [
              ...(record.ok ? [] : ['it did not complete']),
              ...(record.encrypted ? [] : ['it is not encrypted']),
              ...(record.offsite ? [] : ['it has no off-site copy']),
            ] }),
          },
        };
      },
    },
  ];
}
