// Health, sync lag and queue observability (M35-FR-03 / P-08 / §32).
//
// P-08 says: sync lag, stale data and reconciliation differences are VISIBLE. That is
// not a dashboard requirement, it is a design requirement, because the failure mode
// this prevents is specific and expensive:
//
//     Everything looks green. The store keeps trading. The till keeps printing.
//     And forty-one sales have not reached the cloud since 11am, because one
//     poison message stalled the queue behind them.
//
// Nobody finds that on a screen full of green ticks. So health here is computed from
// EVIDENCE — the age of the last successful sync, the depth of the queue, the number
// of dead letters, the age of the local catalogue — and a component that has no
// evidence is `unknown`, never `ok`. Absence of a signal is not proof of health, and
// treating it as such is exactly how outages get discovered by customers.
//
// One deliberate asymmetry: DEGRADED IS NOT DOWN. The store keeps trading through a
// cloud outage (P-01), so the lane's health must never be reported in a way that
// invites someone to stop selling. `canTrade` is separate from `status`.
//
// Pure and deterministic: "now" is injected, there is no clock and no I/O.

export type HealthStatus = 'ok' | 'degraded' | 'down' | 'unknown';

/** Worst-first ordering, so a summary can take the worst of its parts. */
const SEVERITY: Readonly<Record<HealthStatus, number>> = {
  down: 0,
  degraded: 1,
  unknown: 2,
  ok: 3,
};

export function worstOf(statuses: readonly HealthStatus[]): HealthStatus {
  if (statuses.length === 0) return 'unknown';
  return statuses.reduce((worst, s) => (SEVERITY[s] < SEVERITY[worst] ? s : worst), 'ok');
}

export interface ComponentHealth {
  readonly name: string;
  readonly status: HealthStatus;
  /** Plain English — this is read at 9pm by someone who is not a programmer. */
  readonly detail: string;
  /** Numbers behind the verdict, so the judgement can be checked. */
  readonly evidence?: Readonly<Record<string, number | string>>;
}

/** Per-tenant thresholds — chosen, never hard-coded (§32 gives the defaults). */
export interface HealthThresholds {
  /** Cloud RPO: sync lag beyond this is degraded. §32 target: 15 minutes. */
  readonly syncLagWarnSeconds: number;
  /** Beyond this, the lag is a real incident. */
  readonly syncLagCriticalSeconds: number;
  /** Outbox depth that suggests the queue is not draining. */
  readonly queueDepthWarn: number;
  readonly queueDepthCritical: number;
  /** Any dead letter at all is worth showing; this is when it becomes critical. */
  readonly deadLetterCritical: number;
  /** A local catalogue older than this may be missing today's price change. */
  readonly catalogueStaleSeconds: number;
}

export const DEFAULT_THRESHOLDS: HealthThresholds = {
  syncLagWarnSeconds: 900, // §32 cloud RPO ≤ 15 min
  syncLagCriticalSeconds: 3_600,
  queueDepthWarn: 100,
  queueDepthCritical: 1_000,
  deadLetterCritical: 1,
  catalogueStaleSeconds: 14_400, // 4 hours
};

/** What the edge and the services actually report. Every field is optional, and a
 *  missing field yields `unknown` — never a cheerful default. */
export interface HealthSignals {
  /** ISO-8601 UTC of the last item that successfully reached the cloud. */
  readonly lastSyncAt?: string;
  /** Items waiting in the outbox. */
  readonly queueDepth?: number;
  /** Poison items parked for a human (hard rule #6 — never dropped). */
  readonly deadLetterCount?: number;
  /** ISO-8601 UTC the local catalogue snapshot was built. */
  readonly catalogueBuiltAt?: string;
  /** The CLOUD database is reachable. Its absence never stops the store (P-01). */
  readonly databaseReachable?: boolean;
  /**
   * The LOCAL store-edge database accepts writes. This is the only signal that can
   * stop trading: a lane that cannot record a sale must not take one, because an
   * unrecorded sale is worse than a refused one.
   */
  readonly localStoreWritable?: boolean;
  /** Last successful backup — a stale backup is a silent disaster (M35-FR-01). */
  readonly lastBackupAt?: string;
  readonly backupMaxAgeSeconds?: number;
  /** Named integrations and whether their last call succeeded. */
  readonly integrations?: Readonly<Record<string, boolean>>;
}

export interface SystemHealth {
  readonly status: HealthStatus;
  /** The store can take a sale. Deliberately separate from `status` (P-01). */
  readonly canTrade: boolean;
  readonly components: readonly ComponentHealth[];
  readonly checkedAt: string;
  /** One line for a human. */
  readonly summary: string;
}

function ageSeconds(iso: string | undefined, now: string): number | undefined {
  if (iso === undefined) return undefined;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return undefined;
  return Math.max(0, Math.floor((Date.parse(now) - then) / 1000));
}

function humanDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`;
  return `${Math.floor(seconds / 86_400)} days`;
}

/**
 * Compute health from evidence. Components with no signal are `unknown`, which is a
 * finding in itself — the absence of a heartbeat is not a heartbeat.
 */
export function checkHealth(
  signals: HealthSignals,
  now: string,
  thresholds: HealthThresholds = DEFAULT_THRESHOLDS,
): SystemHealth {
  const components: ComponentHealth[] = [];

  // --- sync lag -------------------------------------------------------------
  const lag = ageSeconds(signals.lastSyncAt, now);
  if (lag === undefined) {
    components.push({
      name: 'sync',
      status: 'unknown',
      detail: 'nothing has ever reported a successful sync — that is not the same as being up to date',
    });
  } else {
    const status: HealthStatus =
      lag >= thresholds.syncLagCriticalSeconds
        ? 'down'
        : lag >= thresholds.syncLagWarnSeconds
          ? 'degraded'
          : 'ok';
    components.push({
      name: 'sync',
      status,
      detail:
        status === 'ok'
          ? `last synced ${humanDuration(lag)} ago`
          : `nothing has reached the cloud for ${humanDuration(lag)} — the store is still trading, but head-office figures are that old`,
      evidence: { lagSeconds: lag },
    });
  }

  // --- outbox depth ---------------------------------------------------------
  if (signals.queueDepth === undefined) {
    components.push({ name: 'queue', status: 'unknown', detail: 'the outbox has not reported its depth' });
  } else {
    const depth = signals.queueDepth;
    const status: HealthStatus =
      depth >= thresholds.queueDepthCritical
        ? 'down'
        : depth >= thresholds.queueDepthWarn
          ? 'degraded'
          : 'ok';
    components.push({
      name: 'queue',
      status,
      detail:
        depth === 0
          ? 'everything has been sent'
          : `${depth} item(s) waiting to send${status === 'ok' ? '' : ' — the queue is not draining'}`,
      evidence: { depth },
    });
  }

  // --- dead letters ---------------------------------------------------------
  if (signals.deadLetterCount === undefined) {
    components.push({ name: 'dead_letter', status: 'unknown', detail: 'dead letters have not been reported' });
  } else if (signals.deadLetterCount === 0) {
    components.push({ name: 'dead_letter', status: 'ok', detail: 'nothing is stuck' });
  } else {
    // A dead letter is a real business item nobody has dealt with. It never expires
    // and it is never dropped (hard rule #6), so it stays visible until resolved.
    components.push({
      name: 'dead_letter',
      status: signals.deadLetterCount >= thresholds.deadLetterCritical ? 'down' : 'degraded',
      detail: `${signals.deadLetterCount} item(s) could not be sent and are waiting for a person — each one is a real sale, receipt or order`,
      evidence: { count: signals.deadLetterCount },
    });
  }

  // --- local catalogue freshness --------------------------------------------
  const catalogueAge = ageSeconds(signals.catalogueBuiltAt, now);
  if (catalogueAge !== undefined) {
    const stale = catalogueAge > thresholds.catalogueStaleSeconds;
    components.push({
      name: 'catalogue',
      status: stale ? 'degraded' : 'ok',
      detail: stale
        ? `prices on the lane are ${humanDuration(catalogueAge)} old — a price changed today may not be here`
        : `prices are ${humanDuration(catalogueAge)} old`,
      evidence: { ageSeconds: catalogueAge },
    });
  }

  // --- databases ------------------------------------------------------------
  if (signals.databaseReachable !== undefined) {
    components.push({
      name: 'database',
      // Losing the cloud is DEGRADED, never down: the store is designed for it.
      status: signals.databaseReachable ? 'ok' : 'degraded',
      detail: signals.databaseReachable
        ? 'cloud database reachable'
        : 'cloud database not reachable — the store keeps trading locally and work is queued',
    });
  }
  if (signals.localStoreWritable !== undefined) {
    components.push({
      name: 'local_store',
      status: signals.localStoreWritable ? 'ok' : 'down',
      detail: signals.localStoreWritable
        ? 'the lane can record sales'
        : 'the lane CANNOT record a sale — stop selling on this lane; an unrecorded sale is worse than a refused one',
    });
  }

  // --- backup freshness -----------------------------------------------------
  const backupAge = ageSeconds(signals.lastBackupAt, now);
  const backupMax = signals.backupMaxAgeSeconds ?? 86_400;
  if (backupAge === undefined) {
    components.push({
      name: 'backup',
      status: 'unknown',
      detail: 'no backup has ever been reported — this is the one to fix before anything else',
    });
  } else {
    const overdue = backupAge > backupMax;
    components.push({
      name: 'backup',
      status: overdue ? 'down' : 'ok',
      detail: overdue
        ? `the last backup was ${humanDuration(backupAge)} ago — a stale backup is a silent disaster`
        : `last backup ${humanDuration(backupAge)} ago`,
      evidence: { ageSeconds: backupAge },
    });
  }

  // --- integrations ---------------------------------------------------------
  for (const [name, healthy] of Object.entries(signals.integrations ?? {})) {
    components.push({
      name: `integration:${name}`,
      status: healthy ? 'ok' : 'degraded',
      detail: healthy ? 'responding' : `${name} is not responding — work is queued, not lost`,
    });
  }

  const status = worstOf(components.map((c) => c.status));
  const bad = components.filter((c) => c.status === 'down' || c.status === 'degraded');

  return {
    status,
    // The store trades through every cloud-side failure above (P-01). The ONLY thing
    // that stops a lane is being unable to record the sale locally.
    canTrade: signals.localStoreWritable !== false,
    components,
    checkedAt: now,
    summary:
      bad.length === 0
        ? status === 'unknown'
          ? 'Nothing is reporting yet — health is unknown, which is not the same as healthy'
          : 'Everything is up to date'
        : bad.map((c) => c.detail).join('; '),
  };
}

/** An alert with a named owner — an alert nobody owns is noise (M35-FR-04). */
export interface AlertRule {
  readonly alertId: string;
  /** The component whose status triggers it. */
  readonly component: string;
  /** Fire at this status or worse. */
  readonly firesAt: HealthStatus;
  /** A person, not a team — the same rule as compliance obligations (M34-FR-03). */
  readonly ownerUserId: string;
  readonly ownerName: string;
  /** Escalate if not acknowledged within this many minutes (§32 target: 15). */
  readonly ackWithinMinutes: number;
  readonly escalatesToUserId?: string;
}

export interface RaisedAlert {
  readonly alertId: string;
  readonly component: string;
  readonly status: HealthStatus;
  readonly ownerUserId: string;
  readonly ownerName: string;
  readonly detail: string;
  readonly raisedAt: string;
  readonly ackDueBy: string;
}

/** Turn a health check into owned, actionable alerts. */
export function raiseAlerts(
  health: SystemHealth,
  rules: readonly AlertRule[],
): readonly RaisedAlert[] {
  const alerts: RaisedAlert[] = [];
  for (const rule of rules) {
    const component = health.components.find((c) => c.name === rule.component);
    if (!component) continue;
    if (SEVERITY[component.status] > SEVERITY[rule.firesAt]) continue;
    alerts.push({
      alertId: rule.alertId,
      component: rule.component,
      status: component.status,
      ownerUserId: rule.ownerUserId,
      ownerName: rule.ownerName,
      detail: component.detail,
      raisedAt: health.checkedAt,
      ackDueBy: new Date(Date.parse(health.checkedAt) + rule.ackWithinMinutes * 60_000)
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z'),
    });
  }
  return alerts.sort((a, b) => SEVERITY[a.status] - SEVERITY[b.status]);
}

/** An alert past its acknowledgement deadline escalates to a named person. */
export function escalateUnacknowledged(
  alerts: readonly RaisedAlert[],
  rules: readonly AlertRule[],
  acknowledgedIds: readonly string[],
  now: string,
): readonly { readonly alert: RaisedAlert; readonly escalatedTo: string; readonly detail: string }[] {
  return alerts
    .filter((a) => !acknowledgedIds.includes(a.alertId) && a.ackDueBy <= now)
    .map((alert) => {
      const rule = rules.find((r) => r.alertId === alert.alertId);
      const to = rule?.escalatesToUserId;
      return {
        alert,
        escalatedTo: to ?? '',
        detail:
          to === undefined
            ? `nobody is configured above ${alert.ownerName} — this alert has nowhere to escalate to`
            : `${alert.ownerName} has not acknowledged in time; escalated to ${to}`,
      };
    });
}
