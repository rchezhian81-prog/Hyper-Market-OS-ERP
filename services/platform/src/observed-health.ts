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
// PA-12 round 4 — the lane and the backup reach a named person without anyone pressing "raise":
//   • the STORE COMPUTERS' own sync reports (EA-01 watermarks) are lane signals here: the sync clock is the stalest
//     store's last complete sync (not the newest sale), and their unsent and refused (dead-lettered) items count in
//     the queue and dead-letter components;
//   • a backup whose LATEST record failed (did not complete, not encrypted, or no off-site copy) makes the backup
//     component degraded at once — not only when the last good one finally ages past the limit;
//   • `raiseObservedAlerts` is the raise this route runs, exported so the ops-alert worker runs the same on its timer.
//
// PA-12 round 6 — the backup job reports ITSELF, and silence is an alert:
//   • the real backup job (the pilot box's encrypted-backup.sh → scripts/report-backup.mjs) posts its own outcome —
//     success AND failure — under its own operator-provisioned machine identity (role `backup_job`, the one permission
//     `platform.backup.record`), with what it measured: when it started and ended, the encrypted file's size and
//     sha256, whether it is encrypted, and whether the operator's off-site copy step confirmed the copy;
//   • a backup that never reports by its expected time is MISSED by itself: once the alert rules are in force, a good
//     backup is due within `backupMaxAgeSeconds` of the last good one (or, if there has never been one, of when the
//     rules first came into force — `backupsExpectedSince`, carried across rule versions) — the backup component is
//     then `down`, named "MISSED", and the ops-alert worker raises it to its owner with nobody posting anything.
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
import { raiseKey, type AlertLifecycleDeps, type AlertLifecycleEvent } from './alert-lifecycle';

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
  /** PA-12 r6: when the job finished (it measured it), and the sha256 of the file it kept (`sha256:<hex>`). */
  readonly endedAt?: string;
  readonly checksum?: string;
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
  /** PA-12 r6: when backups first became expected (the first rules version) — kept across versions, so redefining the
   *  rules never resets the clock a never-reporting backup is judged MISSED by. Absent on rules stored before r6. */
  readonly backupsExpectedSince?: string;
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
  /**
   * PA-12: the store computers' own sync reports (EA-01) — the stalest store's last complete sync and what their queues
   * still hold or had refused. Absent, or no store has reported: the newest sale stands in, said so.
   */
  readonly storeLanes?: (tenantId: string) => Promise<StoreLaneSignals | undefined>;
}

/** What the store computers last reported about their queues (PA-12, from the EA-01 watermark reports). */
export interface StoreLaneSignals {
  /** The stalest reporting store's last complete sync (across its queues); null when one has never completed one. */
  readonly stalestCompleteAt: string | null;
  readonly stalestStore: string;
  readonly unsent: number;
  readonly deadLettered: number;
  readonly stores: number;
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
  const [lastSale, catalogue, queues, integrations, backups, lanes] = await Promise.all([
    deps.lastSaleSyncedAt(tenantId), deps.catalogueBuiltAt(tenantId), deps.connectorQueues(tenantId),
    deps.integrationHealth(tenantId, at), deps.backups(tenantId),
    deps.storeLanes === undefined ? Promise.resolve(undefined) : deps.storeLanes(tenantId),
  ]);
  const sortedBackups = [...backups].sort(byAt);
  const good = [...sortedBackups].reverse().find(goodBackup);
  const latest = sortedBackups[sortedBackups.length - 1];
  const fromLanes = lanes !== undefined && lanes.stores > 0;
  const queued = queues.reduce((s, q) => s + q.queued, 0) + (fromLanes ? lanes.unsent : 0);
  const deadLettered = queues.reduce((s, q) => s + q.deadLettered, 0) + (fromLanes ? lanes.deadLettered : 0);
  // The sync clock: the stalest store's last COMPLETE sync when the store computers report (EA-01/PA-12); a store that
  // has never completed one leaves it unset (the engine then says so, never "ok"). Else the newest sale stands in.
  const lastSyncAt = fromLanes ? (lanes.stalestCompleteAt ?? undefined) : lastSale;
  const signals: HealthSignals = {
    ...(lastSyncAt === undefined ? {} : { lastSyncAt }),
    queueDepth: queued,
    deadLetterCount: deadLettered,
    ...(catalogue === undefined ? {} : { catalogueBuiltAt: catalogue }),
    databaseReachable: true,
    integrations,
    ...(good === undefined ? {} : { lastBackupAt: good.at }),
    backupMaxAgeSeconds,
  };
  const ageSeconds = lastSyncAt === undefined ? null : Math.max(0, Math.floor((Date.parse(at) - Date.parse(lastSyncAt)) / 1000));
  return {
    signals,
    provenance: {
      lastSyncAt: fromLanes
        ? `the stalest store computer's last complete sync, from its own report (${lanes.stalestStore}; ${lanes.stores} store(s) reporting)`
        : 'the newest sale the cloud has received from any lane, at the time it was rung up (SaleCommitted) — no store computer has reported its sync yet',
      queueDepth: `messages still queued across ${queues.length} connector queue(s)${fromLanes ? ` and the store computers' own queues (${lanes.unsent} waiting)` : ''}`,
      deadLetterCount: `messages dead-lettered across ${queues.length} connector queue(s)${fromLanes ? ` and the store computers' queues (${lanes.deadLettered} refused)` : ''} — each one still needs a person`,
      catalogueBuiltAt: 'when the latest published catalogue pack was built',
      databaseReachable: 'this very read came from the cloud database',
      integrations: 'each enabled adapter judged from its recorded heartbeats',
      lastBackupAt: 'the newest backup recorded as completed, encrypted and off-site; a failed or unprotected backup is kept but does not count',
    },
    freshness: { lastSaleAt: lastSyncAt ?? null, ageSeconds },
    queues,
    lastBackup: latest ?? null,
    notObserved: ['localStoreWritable — a lane-side signal (the store box reports it through its own health check); never guessed ok here'],
  };
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isIso = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) && !Number.isNaN(Date.parse(v));

const RANK: Readonly<Record<string, number>> = { ok: 0, unknown: 1, degraded: 2, down: 3 };

/**
 * A backup whose LATEST record failed is an exception now (PA-12): the backup component is at least degraded, naming
 * why — even while the last good backup is still inside its age limit. A missed backup (no good one inside the limit)
 * is already `down` from the engine.
 */
export function withFailedBackup(health: SystemHealth, latest: BackupRecord | null): SystemHealth {
  if (latest === null || goodBackup(latest)) return health;
  const why = [...(latest.ok ? [] : ['did not complete']), ...(latest.encrypted ? [] : ['is not encrypted']), ...(latest.offsite ? [] : ['has no off-site copy'])].join(', ');
  const components = health.components.map((c) => (c.name !== 'backup' || (RANK[c.status] ?? 0) >= RANK['degraded']!
    ? c
    : { ...c, status: 'degraded' as const, detail: `the latest backup (${latest.backupId}, ${latest.at}) ${why}; ${c.detail}` }));
  const status = components.reduce<SystemHealth['status']>((w, c) => ((RANK[c.status] ?? 0) > (RANK[w] ?? 0) ? c.status : w), health.status);
  return { ...health, components, status };
}

/**
 * PA-12 r6 — a backup that has not reported by its expected time is MISSED, by itself. With rules in force, a good
 * backup is due `backupMaxAgeSeconds` after the last good one — or after `backupsExpectedSince` when there has never
 * been one (the engine alone would only say `unknown` then, which no rule fires on). Past that, the backup component
 * is `down` and says MISSED and when it was due. Without rules nothing is expected of anyone, and nothing changes.
 */
export function withMissedBackup(health: SystemHealth, backups: readonly BackupRecord[], stored: StoredAlertRules | undefined, at: string): SystemHealth {
  if (stored === undefined) return health;
  const maxMs = stored.backupMaxAgeSeconds * 1000;
  const good = [...backups].filter(goodBackup).sort(byAt).pop();
  const since = good?.at ?? stored.backupsExpectedSince ?? stored.definedAt;
  const dueMs = Date.parse(since) + maxMs;
  if (!(Date.parse(at) > dueMs)) return health;
  const due = new Date(dueMs).toISOString();
  const detail = good === undefined
    ? `MISSED — no good backup has reported since backups became expected (${since}); one was due by ${due}. A backup that does not report is treated as not taken`
    : `MISSED — the next good backup was due by ${due} (the last good one was ${good.backupId} at ${good.at})`;
  const components = health.components.map((c) => (c.name !== 'backup' ? c
    : { ...c, status: 'down' as const, detail: c.status === 'down' ? `${detail}; ${c.detail}` : detail }));
  const status = components.reduce<SystemHealth['status']>((w, c) => ((RANK[c.status] ?? 0) > (RANK[w] ?? 0) ? c.status : w), health.status);
  return { ...health, components, status };
}

/** Judge a shop's observed health with its stored rules (the read and the raise share it). */
export async function judgeObserved(deps: ObservedHealthDeps, tenantId: string, at: string) {
  const stored = await deps.alertRules(tenantId);
  const observed = await observeSignals(deps, tenantId, at, stored?.backupMaxAgeSeconds ?? DEFAULT_BACKUP_MAX_AGE_SECONDS);
  const health: SystemHealth = withMissedBackup(
    withFailedBackup(checkHealth(observed.signals, at, stored?.thresholds ?? DEFAULT_THRESHOLDS), observed.lastBackup),
    await deps.backups(tenantId), stored, at);
  const alerts: readonly RaisedAlert[] = raiseAlerts(health, stored?.rules ?? []);
  return { stored, observed, health, alerts };
}

/**
 * Raise the shop's observed alerts into the durable lifecycle store (each to its named owner), and — when `clear` —
 * mark cleared every open alert whose condition is no longer observed (kept, never deleted; a recurrence is a new
 * occurrence). Returns undefined when the shop has no alert rules (nothing can be owned, so nothing is raised).
 */
export async function raiseObservedAlerts(deps: ObservedHealthDeps, tenantId: string, by: string, at: string, opts: { readonly clear?: boolean } = {}) {
  const judged = await judgeObserved(deps, tenantId, at);
  if (judged.stored === undefined) return undefined;
  const before = await deps.alerts(tenantId);
  const known = new Set(before.map((a) => a.alert.alertId));
  let newlyOpened = 0;
  for (const alert of judged.alerts) {
    const rule = judged.stored.rules.find((r) => r.alertId === alert.alertId);
    const event: AlertLifecycleEvent = {
      alertId: alert.alertId, change: 'raised', by, at, alert,
      ...(rule?.escalatesToUserId !== undefined ? { escalatesToUserId: rule.escalatesToUserId } : {}),
    };
    const live = before.find((a) => a.alert.alertId === alert.alertId);
    await deps.recordAlertEvent(tenantId, event, raiseKey(alert.alertId, live));
    if (!known.has(alert.alertId) || live?.state === 'cleared') newlyOpened += 1;
  }
  let cleared = 0;
  if (opts.clear === true) {
    const firing = new Set(judged.alerts.map((a) => a.alertId));
    const ruled = new Set(judged.stored.rules.map((r) => r.alertId));
    for (const a of before) {
      if (a.state === 'cleared' || firing.has(a.alert.alertId) || !ruled.has(a.alert.alertId)) continue;
      await deps.recordAlertEvent(tenantId, { alertId: a.alert.alertId, change: 'cleared', by, at, detail: `${a.alert.component} is no longer at ${a.alert.status} or worse` }, `clear-${a.alert.alertId}-o${a.occurrence}`);
      cleared += 1;
    }
  }
  return { ...judged, stored: judged.stored, newlyOpened, cleared };
}

export function observedHealthRoutes(deps: ObservedHealthDeps): readonly Route[] {
  const judge = (tenantId: string, at: string) => judgeObserved(deps, tenantId, at);

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
        const definedAt = deps.now();
        const stored: StoredAlertRules = {
          version: (current?.version ?? 0) + 1, rules, thresholds, backupMaxAgeSeconds: maxAge as number,
          // PA-12 r6: the clock a never-reporting backup is judged MISSED by starts with the FIRST rules, and stays.
          backupsExpectedSince: current === undefined ? definedAt : (current.backupsExpectedSince ?? current.definedAt),
          definedBy: ctx.userId, definedAt,
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
        const done = await raiseObservedAlerts(deps, ctx.tenantId, ctx.userId, at);
        if (done === undefined) {
          throw apiError(409, {
            code: 'alert_rules_not_defined',
            whatHappened: 'No alert rules are defined for this shop, so nothing can be raised — an alert without a named owner is noise nobody answers (§32).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Define the rules first (PUT /v1/platform/alert-rules: who owns which component, at what status, how soon they must acknowledge). Nothing was raised.',
          });
        }
        const { stored, observed, health, alerts, newlyOpened } = done;
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
          || (b['detail'] !== undefined && !isStr(b['detail']))
          || (b['endedAt'] !== undefined && (!isIso(b['endedAt']) || Date.parse(b['endedAt']) < Date.parse(b['at'] as string)))
          || (b['checksum'] !== undefined && !(typeof b['checksum'] === 'string' && /^sha256:[0-9a-f]{64}$/.test(b['checksum'])))) {
          throw apiError(400, {
            code: 'not_readable_as_a_backup_record',
            whatHappened: 'A backup record needs when it ran (ISO time) and whether it completed (ok), was encrypted and was copied off-site; optionally its size in bytes, when it ended (not before it ran), its checksum (sha256:<64 hex>) and a detail.',
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
          ...(isIso(b['endedAt']) ? { endedAt: b['endedAt'] } : {}),
          ...(typeof b['checksum'] === 'string' ? { checksum: b['checksum'] } : {}),
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
