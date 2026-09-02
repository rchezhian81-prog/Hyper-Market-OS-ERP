// Alert lifecycle — raise, acknowledge, escalate over time (M35-FR-04 · API-11 · §32 · P-03 · P-08).
//
// `operational-health` computes the owned alerts a health check should raise, but it is STATELESS: every
// alert's acknowledgement deadline is, by construction, still in the future, so it cannot answer the other
// half of FR-04 — **an alert nobody acknowledges in time escalates to a named person.** That needs state
// held over time: an alert raised now, acknowledged (or not) later, and swept for escalation once its
// deadline has passed. This is that store, append-only (hard rule #2), folded latest-per-alert:
//
//   • RAISE — from the same health evidence the read takes ({signals, thresholds?, alertRules[]}), compute
//     the owned alerts (the tested `checkHealth`/`raiseAlerts`) and PERSIST each with its owner, its §32
//     acknowledgement deadline, and where it escalates to. A re-raise of an alert already open is the same
//     ongoing condition — it keeps the original deadline and acknowledgement, never resetting the clock.
//   • ACKNOWLEDGE — a NAMED person takes an open alert (P-04), which stops it escalating. Acknowledging an
//     alert nobody raised is refused (404).
//   • ESCALATE — the sweep: the tested `escalateUnacknowledged` finds every alert past its deadline that
//     nobody has acknowledged and routes it to the configured person; an alert with nobody above its owner
//     is reported as having nowhere to go (P-08), not silently dropped. Already-escalated alerts are left
//     alone, so the sweep is idempotent and re-running it never double-escalates.
//   • BOARD — every live alert with its state (open / acknowledged / escalated), the ones needing a look
//     first (control by exception, P-03).
//
// Writes gated `platform.alert.manage`; the board reads `platform.health.read`. No business transaction is
// posted here (§28); no AI acknowledges or escalates anything (hard rule #5).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  checkHealth, raiseAlerts, escalateUnacknowledged, type RaisedAlert, type AlertRule,
} from '../../../packages/ops/src/index';
import { readSignals, readThresholds, readRules } from './operational-health';

/** One append-only fact about an alert. `change` says which; the extra fields carry its detail. */
export interface AlertLifecycleEvent {
  readonly alertId: string;
  readonly change: 'raised' | 'acknowledged' | 'escalated';
  /** Who caused it — the raiser, the acknowledger, or the sweeper (P-04). */
  readonly by: string;
  readonly at: string;
  /** `raised` only — the owned alert with its owner and deadline. */
  readonly alert?: RaisedAlert;
  /** `raised` only — where this alert escalates to if it goes unacknowledged. */
  readonly escalatesToUserId?: string;
  /** `escalated` only — who it went to, and why. */
  readonly escalatedTo?: string;
  readonly detail?: string;
}

export type AlertState = 'open' | 'acknowledged' | 'escalated';

/** A live alert — the fold of its history to now. */
export interface LiveAlert {
  readonly alert: RaisedAlert;
  readonly state: AlertState;
  readonly escalatesToUserId?: string;
  readonly acknowledgedBy?: string;
  readonly acknowledgedAt?: string;
  readonly escalatedTo?: string;
  readonly escalatedAt?: string;
  readonly escalationDetail?: string;
}

interface MutableAlert {
  alert: RaisedAlert; escalatesToUserId?: string;
  acknowledgedBy?: string; acknowledgedAt?: string;
  escalatedTo?: string; escalatedAt?: string; escalationDetail?: string;
}

/**
 * Fold the append-only log to the CURRENT set of alerts — one per id. A re-raise of a known id is the same
 * ongoing condition, so its ORIGINAL deadline and acknowledgement survive (only the escalation target is
 * refreshed). An acknowledge/escalate for an id never raised is ignored — no phantom alert, the same way the
 * device registry ignores a stray status for an unregistered device.
 */
export function projectAlerts(events: readonly AlertLifecycleEvent[]): readonly LiveAlert[] {
  const byId = new Map<string, MutableAlert>();
  for (const e of events) {
    if (e.change === 'raised') {
      if (e.alert === undefined) continue;
      const existing = byId.get(e.alertId);
      if (existing === undefined) {
        byId.set(e.alertId, { alert: e.alert, ...(e.escalatesToUserId !== undefined ? { escalatesToUserId: e.escalatesToUserId } : {}) });
      } else {
        // Ongoing condition: keep the first deadline and any acknowledgement; refresh only the escalation target.
        existing.escalatesToUserId = e.escalatesToUserId;
      }
      continue;
    }
    const a = byId.get(e.alertId);
    if (a === undefined) continue; // no phantom alert
    if (e.change === 'acknowledged') {
      a.acknowledgedBy = e.by;
      a.acknowledgedAt = e.at;
    } else { // escalated
      a.escalatedTo = e.escalatedTo ?? '';
      a.escalatedAt = e.at;
      a.escalationDetail = e.detail;
    }
  }
  return [...byId.values()].map((a) => ({
    alert: a.alert,
    state: a.escalatedAt !== undefined ? 'escalated' : a.acknowledgedAt !== undefined ? 'acknowledged' : 'open',
    ...(a.escalatesToUserId !== undefined ? { escalatesToUserId: a.escalatesToUserId } : {}),
    ...(a.acknowledgedBy !== undefined ? { acknowledgedBy: a.acknowledgedBy } : {}),
    ...(a.acknowledgedAt !== undefined ? { acknowledgedAt: a.acknowledgedAt } : {}),
    ...(a.escalatedTo !== undefined ? { escalatedTo: a.escalatedTo } : {}),
    ...(a.escalatedAt !== undefined ? { escalatedAt: a.escalatedAt } : {}),
    ...(a.escalationDetail !== undefined ? { escalationDetail: a.escalationDetail } : {}),
  }));
}

export interface AlertLifecycleDeps {
  /** The current set of live alerts, folded from the append-only log (survives restart). */
  readonly alerts: (tenantId: string) => Promise<readonly LiveAlert[]> | readonly LiveAlert[];
  /** Append one alert fact. Idempotent on the key. */
  readonly recordAlertEvent: (tenantId: string, event: AlertLifecycleEvent, key: string) => Promise<void> | void;
  readonly now: () => string;
}

// SEVERITY order for the board: worse first, then the soonest deadline. `unknown` sits above `ok`.
const SEVERITY: Record<string, number> = { down: 0, unknown: 1, degraded: 2, ok: 3 };

export function alertLifecycleRoutes(deps: AlertLifecycleDeps): readonly Route[] {
  return [
    {
      // RAISE — compute the owned alerts from the evidence, then persist each. Same body as the stateless
      // read (`/operational-health`), parsed by the same reader so the two can never disagree.
      api: 'API-11', method: 'POST', path: '/v1/platform/alerts/raise',
      permission: 'platform.alert.manage', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const signals = readSignals(b['signals'] ?? {});
        const thresholds = readThresholds(b['thresholds']);
        const rules = readRules(b['alertRules']);
        if (signals === undefined || thresholds === undefined || rules === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_health_evidence',
            whatHappened: 'Raising alerts needs { signals } and optional { thresholds, alertRules[] }, each of the right type.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the evidence the edge reports, with the alert rules that own each component.',
          });
        }
        const at = deps.now();
        const alerts = raiseAlerts(checkHealth(signals, at, thresholds), rules);
        const known = new Set((await deps.alerts(ctx.tenantId)).map((a) => a.alert.alertId));
        let persisted = 0;
        for (const alert of alerts) {
          const rule = rules.find((r) => r.alertId === alert.alertId);
          const event: AlertLifecycleEvent = {
            alertId: alert.alertId, change: 'raised', by: ctx.userId, at, alert,
            ...(rule?.escalatesToUserId !== undefined ? { escalatesToUserId: rule.escalatesToUserId } : {}),
          };
          // Key on the alertId (no time): a re-raise of the same ongoing condition collapses to one open alert.
          await deps.recordAlertEvent(ctx.tenantId, event, `raise-${alert.alertId}`);
          if (!known.has(alert.alertId)) persisted += 1;
        }
        return { status: 200, body: { raised: alerts.length, newlyOpened: persisted, alerts, at } };
      },
    },
    {
      // ACKNOWLEDGE — a named person takes an open alert, stopping its escalation. 404 for an unknown alert.
      api: 'API-11', method: 'POST', path: '/v1/platform/alerts/:alertId/acknowledge',
      permission: 'platform.alert.manage', idempotent: true,
      handler: async (ctx) => {
        const alertId = ctx.params['alertId'] ?? '';
        const live = (await deps.alerts(ctx.tenantId)).find((a) => a.alert.alertId === alertId);
        if (live === undefined) {
          throw apiError(404, {
            code: 'unknown_alert',
            whatHappened: `There is no alert called '${alertId}' to acknowledge.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Check the id against GET /v1/platform/alerts.',
          });
        }
        const at = deps.now();
        // Key on the alertId (no time): a re-acknowledge of the same alert collapses to one.
        await deps.recordAlertEvent(ctx.tenantId, { alertId, change: 'acknowledged', by: ctx.userId, at }, `ack-${alertId}`);
        return { status: 200, body: { alertId, acknowledgedBy: ctx.userId, at } };
      },
    },
    {
      // ESCALATE — the sweep. Every open, unacknowledged alert past its deadline is routed to the configured
      // person (the tested `escalateUnacknowledged`); already-escalated alerts are skipped, so it is idempotent.
      api: 'API-11', method: 'POST', path: '/v1/platform/alerts/escalate',
      permission: 'platform.alert.manage', idempotent: true,
      handler: async (ctx) => {
        const live = await deps.alerts(ctx.tenantId);
        const at = deps.now();
        const openAlerts = live.map((a) => a.alert);
        const rules = live.map((a): AlertRule => ({
          alertId: a.alert.alertId, component: a.alert.component, firesAt: a.alert.status,
          ownerUserId: a.alert.ownerUserId, ownerName: a.alert.ownerName, ackWithinMinutes: 1,
          ...(a.escalatesToUserId !== undefined ? { escalatesToUserId: a.escalatesToUserId } : {}),
        }));
        const acknowledgedIds = live.filter((a) => a.acknowledgedAt !== undefined).map((a) => a.alert.alertId);
        const alreadyEscalated = new Set(live.filter((a) => a.escalatedAt !== undefined).map((a) => a.alert.alertId));

        const due = escalateUnacknowledged(openAlerts, rules, acknowledgedIds, at).filter((e) => !alreadyEscalated.has(e.alert.alertId));
        for (const e of due) {
          await deps.recordAlertEvent(ctx.tenantId, {
            alertId: e.alert.alertId, change: 'escalated', by: ctx.userId, at,
            escalatedTo: e.escalatedTo, detail: e.detail,
          }, `escalate-${e.alert.alertId}-${at}`);
        }
        return {
          status: 200,
          body: {
            escalated: due.map((e) => ({ alertId: e.alert.alertId, escalatedTo: e.escalatedTo, detail: e.detail })),
            count: due.length,
            at,
          },
        };
      },
    },
    {
      // BOARD — every live alert with its state; worst first, then soonest deadline (control by exception).
      api: 'API-11', method: 'GET', path: '/v1/platform/alerts',
      permission: 'platform.health.read',
      handler: async (ctx) => {
        const live = await deps.alerts(ctx.tenantId);
        const ordered = [...live].sort((a, b) =>
          (SEVERITY[a.alert.status] ?? 9) - (SEVERITY[b.alert.status] ?? 9) || a.alert.ackDueBy.localeCompare(b.alert.ackDueBy));
        const needAttention = live.filter((a) => a.state !== 'acknowledged').length;
        return { status: 200, body: { alerts: ordered, open: live.filter((a) => a.state === 'open').length, needAttention, asAt: deps.now() } };
      },
    },
  ];
}
