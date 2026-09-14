// Operations advisor (A06 "Operations" · API-13 · §7.1 · P-05 · P-08) — the deterministic engine behind
// the Operations agent.
//
// A06's remit (§7.1) is to "explain sync and integration incidents and recommend a runbook — an OPERATOR
// executes it." It is NOT a model-drafting agent: the incidents are the REAL, persisted operational alerts
// (the tested `checkHealth`/`raiseAlerts` folded by the alert-lifecycle store — sync lag, a queue that is not
// draining, dead letters, a stale catalogue, a missing backup, a silent integration), and the runbook for
// each is a fixed, reviewed mapping from the component to the steps a person takes. So the advice is grounded
// in evidence and deterministic: the same alerts always yield the same recommendation, in the same order.
//
// It recommends only for alerts that STILL NEED ATTENTION — an acknowledged alert already has a named person
// on it (M35-FR-04), so re-recommending it would be noise (P-03 control-by-exception). It DECIDES nothing and
// executes nothing: it produces a review list, and an operator acknowledges the alert and runs the runbook
// (hard rule #5 — an AI never acts on the system itself).
//
// Pure and deterministic: no clock, no I/O.

import type { HealthStatus, RaisedAlert } from './health';

/** A live alert as A06 reads it — the raised alert plus where it is in its lifecycle. `LiveAlert` from the
 *  alert-lifecycle store satisfies this structurally, so the agent reads the store's fold without a copy. */
export interface AlertForAdvice {
  readonly alert: RaisedAlert;
  readonly state: 'open' | 'acknowledged' | 'escalated';
}

export interface OperationsFinding {
  /** Stable, deterministic id: the same alert yields the same finding id every time. */
  readonly findingId: string;
  readonly alertId: string;
  /** The health component that is unwell (sync / queue / dead_letter / catalogue / database / local_store /
   *  backup / integration:<name>). */
  readonly component: string;
  readonly status: HealthStatus;
  /** One line an operator reads first. */
  readonly headline: string;
  /** What is wrong and why it matters — the alert's own plain-English detail. */
  readonly detail: string;
  /** The recommended runbook — the steps a person takes. Fixed per component, never invented. */
  readonly runbook: string;
  /** The numbers/owner behind the alert, so the recommendation can be checked. */
  readonly evidence: Readonly<Record<string, string | number>>;
}

// Worst first, so an operator sees the lane-stopping incident before the stale-price one.
const SEVERITY: Readonly<Record<HealthStatus, number>> = { down: 0, degraded: 1, unknown: 2, ok: 3 };

/**
 * The runbook for a component — the reviewed steps an operator takes. Keyed by the component FAMILY (the part
 * before any `:`), so every named integration (`integration:gstn`, `integration:razorpay`, …) shares the one
 * integration runbook. A component with no specific runbook falls back to the generic review step rather than
 * inventing advice.
 */
const RUNBOOK_FOR: Readonly<Record<string, string>> = {
  sync: 'Check for a poison message stalling the outbox: open the dead-letter queue, park the bad item, and let the queue drain. Confirm the sync agent is running on the store computer.',
  queue: 'The outbox is not draining. Confirm the sync agent is running and the cloud is reachable; if one item is stuck, move it to the dead-letter queue so the rest can send.',
  dead_letter: 'Each dead letter is a real sale, receipt or order that could not be sent. Open the dead-letter queue, fix or re-submit each item, and never delete one — they are kept by rule.',
  catalogue: "The lane's price list is stale. Force a catalogue refresh on the store computer and confirm the latest price change has reached the lane.",
  database: 'The cloud database is unreachable. The store keeps trading locally and work is queued — check connectivity and credentials, and let the queue sync when it returns.',
  local_store: 'The lane cannot record a sale — STOP selling on that lane. Restart the store-edge service; if it still cannot write, take the lane out of use until fixed (an unrecorded sale is worse than a refused one).',
  backup: 'Backups are stale or missing — fix this before anything else. Run a backup now, confirm it completes, and check the backup schedule on the store computer.',
  integration: 'The named integration is not responding. Work is queued, not lost. Check the provider status and credentials, then re-run the integration health check once it responds.',
};

const runbookFor = (component: string): string =>
  RUNBOOK_FOR[component.split(':')[0] ?? component] ??
  'Review the incident detail and follow the operations runbook for this component.';

/**
 * Turn the live operational alerts into runbook recommendations for the incidents that still need attention.
 *
 * Read-only and deterministic. An alert a named person has already acknowledged is left out (they are on it);
 * everything still open or escalated is recommended, worst-first then by component. It produces a review list,
 * never an action.
 */
export function recommendOperationsRunbooks(alerts: readonly AlertForAdvice[]): readonly OperationsFinding[] {
  const findings: OperationsFinding[] = [];
  for (const { alert, state } of alerts) {
    if (state === 'acknowledged') continue; // a named owner is already on it (M35-FR-04)
    findings.push({
      findingId: `ops-runbook:${alert.alertId}`,
      alertId: alert.alertId,
      component: alert.component,
      status: alert.status,
      headline: `${alert.component} is ${alert.status}: ${alert.detail}`,
      detail: alert.detail,
      runbook: runbookFor(alert.component),
      evidence: {
        component: alert.component,
        status: alert.status,
        owner: alert.ownerName,
        raisedAt: alert.raisedAt,
        ackDueBy: alert.ackDueBy,
        ...(state === 'escalated' ? { escalated: 'yes — past its deadline, unacknowledged' } : {}),
      },
    });
  }
  return findings.sort((a, b) =>
    (SEVERITY[a.status] - SEVERITY[b.status]) || a.component.localeCompare(b.component) || a.alertId.localeCompare(b.alertId));
}
