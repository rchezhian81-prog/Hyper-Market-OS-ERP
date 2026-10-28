// Escalation by age (M02-FR-03 "timeout escalates" · acceptance "an aged pending approval escalates" · owner decision OB-292
// of 23 Oct 2026 · P-03 · P-08 · hard rules #2, #6).
//
// The owner chose a different wait for each kind, every one changeable, all going to him:
//   refund 1 hour · purchase order 24 hours · stock adjustment 48 hours.
// A refund, purchase order or stock adjustment still waiting for a decision after its kind's wait is ESCALATED to the
// owner: the escalation is recorded once as its own append-only event (who asked, when, how long it waited, the wait and
// the rule version it was judged by), and raised into every owner's alert inbox. It is never decided by the sweep — a
// person decides it (hard rule #5). Once it is decided the alert is cleared (kept, never deleted).
//
// The sweep runs on the ops-alert worker's timer (`services/api/src/ops-alert-sweeps.ts`); the clock is injected, so a test
// moves time forward instead of waiting.

import type { Route } from '../../kernel/src/index';
import type { AlertText } from '../../../packages/ops/src/alert-text';
import { escalationDue, ESCALATING_SUBJECTS, type EscalationWaits, type EscalatingSubject } from '../../../packages/approvals/src/authority-rules';

/** An approval still waiting for a decision, from wherever it waits (the engine's inbox, a proposed purchase order). */
export interface PendingApproval {
  readonly requestId: string;
  readonly source: 'approval_engine' | 'purchase_order';
  readonly kind: string;
  readonly limitedAs: EscalatingSubject;
  readonly requestedAt: string;
  readonly requestedBy: string;
  readonly valueMinor: number | null;
  readonly summary: string;
  /** OB-435: a summary head office made, structured (absent: a summary a person typed — kept as written). */
  readonly summaryText?: AlertText;
}

/** One escalation, as recorded (once per request). */
export interface ApprovalEscalation {
  readonly requestId: string;
  readonly source: PendingApproval['source'];
  readonly kind: string;
  readonly limitedAs: EscalatingSubject;
  readonly requestedAt: string;
  readonly requestedBy: string;
  readonly valueMinor: number | null;
  readonly summary: string;
  readonly summaryText?: AlertText;
  readonly waitMinutes: number;
  readonly waitedMinutes: number;
  readonly escalatedAt: string;
  readonly escalatedTo: 'owner';
  /** The version of the escalation-waits rule it was judged by (0 = the owner's decided figures). */
  readonly rulesVersion: number;
}

export interface ApprovalEscalationDeps {
  readonly pending: (tenantId: string) => Promise<readonly PendingApproval[]>;
  readonly waits: (tenantId: string) => Promise<{ readonly value: EscalationWaits; readonly version: number }>;
  readonly escalations: (tenantId: string) => Promise<readonly ApprovalEscalation[]>;
  /** Append the escalation once (idempotent per request): true when newly recorded. */
  readonly recordEscalation: (tenantId: string, escalation: ApprovalEscalation) => Promise<boolean>;
  /** Raise it into every owner's alert inbox; false when no owner is on record (said, never swallowed). */
  readonly tellOwners: (tenantId: string, escalation: ApprovalEscalation) => Promise<boolean>;
  /** Clear the owner alert of an escalation whose approval has since been decided. */
  readonly clearDecided?: (tenantId: string, escalation: ApprovalEscalation, at: string) => Promise<boolean>;
}

export interface SweepOutcome {
  readonly escalated: readonly ApprovalEscalation[];
  /** Escalated, but there is no owner on record to tell — P-08: counted and said. */
  readonly noOwnerToTell: number;
  readonly cleared: number;
}

/** One pass: escalate every pending approval past its wait that has not been escalated yet. */
export async function sweepAgedApprovals(deps: ApprovalEscalationDeps, tenantId: string, at: string): Promise<SweepOutcome> {
  const [pending, waits, already] = await Promise.all([deps.pending(tenantId), deps.waits(tenantId), deps.escalations(tenantId)]);
  const done = new Set(already.map((e) => e.requestId));
  const escalated: ApprovalEscalation[] = [];
  let noOwnerToTell = 0;
  for (const p of [...pending].sort((a, b) => (a.requestedAt < b.requestedAt ? -1 : a.requestedAt > b.requestedAt ? 1 : a.requestId < b.requestId ? -1 : 1))) {
    if (done.has(p.requestId)) continue;
    const waitMinutes = waits.value[p.limitedAs];
    const due = escalationDue({ requestedAt: p.requestedAt, waitMinutes, now: at });
    if (!due.due) continue;
    const e: ApprovalEscalation = { ...p, waitMinutes, waitedMinutes: due.waitedMinutes, escalatedAt: at, escalatedTo: 'owner', rulesVersion: waits.version };
    if (!(await deps.recordEscalation(tenantId, e))) continue;
    escalated.push(e);
    if (!(await deps.tellOwners(tenantId, e))) noOwnerToTell += 1;
  }
  let cleared = 0;
  if (deps.clearDecided !== undefined) {
    const stillPending = new Set(pending.map((p) => p.requestId));
    for (const e of already) if (!stillPending.has(e.requestId) && (await deps.clearDecided(tenantId, e, at))) cleared += 1;
  }
  return { escalated, noOwnerToTell, cleared };
}

export function approvalEscalationRoutes(deps: ApprovalEscalationDeps & { readonly now: () => string }): readonly Route[] {
  return [
    {
      // Every escalation by age, and what is still waiting with when it will escalate — the aged-approvals report
      // (M02-FR-03 "an approvals report (pending, aged, approver, outcome) feeds the owner approval inbox").
      api: 'API-01', method: 'GET', path: '/v1/approvals/escalations',
      permission: 'approvals.rules.read',
      handler: async (ctx) => {
        const [pending, waits, escalations] = await Promise.all([deps.pending(ctx.tenantId), deps.waits(ctx.tenantId), deps.escalations(ctx.tenantId)]);
        const now = deps.now();
        const done = new Map(escalations.map((e) => [e.requestId, e]));
        const waiting = pending.map((p) => {
          const due = escalationDue({ requestedAt: p.requestedAt, waitMinutes: waits.value[p.limitedAs], now });
          return { ...p, waitMinutes: waits.value[p.limitedAs], waitedMinutes: due.waitedMinutes, escalatesAt: due.dueAt, escalated: done.has(p.requestId) };
        });
        return { status: 200, body: { asAt: now, waits: waits.value, waitsVersion: waits.version, kinds: ESCALATING_SUBJECTS, waiting, escalations } };
      },
    },
  ];
}
