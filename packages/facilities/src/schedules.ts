// Cleaning, pest, fire, safety schedules and incidents (M26-FR-03 / M26-FR-04 / P-03 / #6).
//
// Every store has a laminated cleaning rota on a wall that nobody has looked at since the
// week it went up. The reason is always the same: **ticking it costs something and skipping
// it costs nothing**, right up until the pest-control visit that was never booked becomes
// a closure notice.
//
// So this module is built around one asymmetry:
//
//   • **A MISSED SAFETY TASK ESCALATES BY ITSELF.** Not "appears on a report" — escalates,
//     to a named person, and keeps escalating. A compliance task that quietly rolls into
//     tomorrow's list forever is the failure mode, and it is invisible precisely because
//     nothing ever goes red.
//   • **COMPLETION WITHOUT EVIDENCE IS NOT COMPLETION** where evidence was required. A tick
//     against "fire extinguishers checked" is worth nothing at an inspection; a photograph
//     with a date is worth everything. The tick is refused, not warned about.
//   • **THE PERSON WHO DID IT CANNOT BE THE PERSON WHO VERIFIES IT** on a task that carries
//     a legal consequence (§28). Self-verification of a safety check is a signature against
//     nothing.
//
// And one thing that is deliberately *not* a refusal: an overdue **cleaning** task does not
// stop the shop. Treating every schedule as compliance-critical is how the fire check ends
// up buried among 40 mop-the-aisle alerts.
//
// Pure and deterministic: the clock is injected, no I/O.

export type ScheduleCategory = 'cleaning' | 'pest_control' | 'fire_safety' | 'electrical_safety' | 'maintenance' | 'statutory';

export type ScheduleFrequency = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'half_yearly' | 'annual';

export interface MaintenanceSchedule {
  readonly scheduleId: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly title: string;
  readonly category: ScheduleCategory;
  readonly frequency: ScheduleFrequency;
  /** The role expected to do it (M25). */
  readonly assignedRole: string;
  /** Photograph, certificate or witness required for this to count as done. */
  readonly evidenceRequired: boolean;
  /** A second person must verify. Separation of duties on anything with a legal edge. */
  readonly verificationRequired: boolean;
  /** Who hears about it when it is missed. */
  readonly escalatesTo: string;
  /** Days overdue before it escalates. Per-tenant. */
  readonly escalateAfterDays?: number;
  readonly assetId?: string;
  readonly active: boolean;
}

export interface ScheduledTask {
  readonly taskId: string;
  readonly scheduleId: string;
  readonly dueOn: string;
  readonly completedOn?: string;
  readonly completedBy?: string;
  readonly evidenceRefs?: readonly string[];
  readonly verifiedBy?: string;
  readonly note?: string;
}

export type CompletionOutcome =
  | 'complete'
  | 'evidence_missing'
  | 'not_verified'
  | 'self_verified'
  | 'not_done';

export interface CompletionResult {
  readonly taskId: string;
  readonly scheduleId: string;
  readonly title: string;
  readonly accepted: boolean;
  readonly outcome: CompletionOutcome;
  readonly detail: string;
}

/**
 * Decide whether a scheduled task genuinely counts as done.
 *
 * A tick against "fire extinguishers checked" is worth nothing at an inspection. Where the
 * schedule demands evidence, a completion without it is **refused** rather than accepted
 * with a note — because an accepted-with-a-note task shows as green, and green is what
 * everybody reads.
 */
export function assessCompletion(input: {
  readonly schedule: MaintenanceSchedule;
  readonly task: ScheduledTask;
}): CompletionResult {
  const base = {
    taskId: input.task.taskId,
    scheduleId: input.schedule.scheduleId,
    title: input.schedule.title,
  };

  if (input.task.completedOn === undefined || (input.task.completedBy ?? '').trim() === '') {
    return {
      ...base,
      accepted: false,
      outcome: 'not_done',
      detail: `"${input.schedule.title}" has not been done`,
    };
  }
  if (input.schedule.evidenceRequired && (input.task.evidenceRefs ?? []).length === 0) {
    return {
      ...base,
      accepted: false,
      outcome: 'evidence_missing',
      detail: `"${input.schedule.title}" was ticked with no evidence attached — a tick is worth nothing at an inspection and a dated photograph is worth everything`,
    };
  }
  if (input.schedule.verificationRequired) {
    if (input.task.verifiedBy === undefined) {
      return {
        ...base,
        accepted: false,
        outcome: 'not_verified',
        detail: `"${input.schedule.title}" needs a second person to verify it and nobody has`,
      };
    }
    if (input.task.verifiedBy === input.task.completedBy) {
      return {
        ...base,
        accepted: false,
        outcome: 'self_verified',
        detail: `${input.task.completedBy} both did and verified "${input.schedule.title}" — a self-verified safety check is a signature against nothing (§28)`,
      };
    }
  }

  return {
    ...base,
    accepted: true,
    outcome: 'complete',
    detail: `"${input.schedule.title}" done by ${input.task.completedBy} on ${input.task.completedOn}${input.task.verifiedBy === undefined ? '' : ` and verified by ${input.task.verifiedBy}`}`,
  };
}

export type EscalationLevel = 'none' | 'due' | 'overdue' | 'escalated' | 'compliance_risk';

export interface OverdueTask {
  readonly taskId: string;
  readonly scheduleId: string;
  readonly title: string;
  readonly category: ScheduleCategory;
  readonly dueOn: string;
  readonly daysOverdue: number;
  readonly level: EscalationLevel;
  /** Who must be told. Empty until it escalates. */
  readonly escalateTo?: string;
  /** True when a regulator would care. Cleaning is never this. */
  readonly complianceLinked: boolean;
  readonly detail: string;
}

const DAY_MS = 86_400_000;

const COMPLIANCE_CATEGORIES: ReadonlySet<ScheduleCategory> = new Set([
  'pest_control',
  'fire_safety',
  'electrical_safety',
  'statutory',
]);

/** Default escalation days by category. A mopped aisle and a fire check are not the same. */
const DEFAULT_ESCALATE_AFTER: Readonly<Record<ScheduleCategory, number>> = {
  cleaning: 3,
  maintenance: 7,
  pest_control: 2,
  fire_safety: 1,
  electrical_safety: 1,
  statutory: 0,
};

/**
 * Find what is overdue and **escalate the things that matter by themselves**.
 *
 * A compliance-linked task that has rolled into tomorrow's list every day for a month is the
 * failure this exists to catch: nothing ever goes red, so nothing is ever wrong. Cleaning is
 * deliberately not compliance-linked — burying the fire check among forty mop-the-aisle
 * alerts is the same failure by a different route.
 */
export function findOverdue(input: {
  readonly schedules: readonly MaintenanceSchedule[];
  readonly tasks: readonly ScheduledTask[];
  readonly asAt: string;
}): readonly OverdueTask[] {
  const scheduleById = new Map(input.schedules.filter((s) => s.active).map((s) => [s.scheduleId, s]));
  const asAtMs = Date.parse(`${input.asAt}T00:00:00Z`);
  const overdue: OverdueTask[] = [];

  for (const task of input.tasks) {
    const schedule = scheduleById.get(task.scheduleId);
    if (schedule === undefined) continue;

    const done = assessCompletion({ schedule, task });
    if (done.accepted) continue;

    const daysOverdue = Math.floor((asAtMs - Date.parse(`${task.dueOn}T00:00:00Z`)) / DAY_MS);
    if (daysOverdue < 0) continue;

    const complianceLinked = COMPLIANCE_CATEGORIES.has(schedule.category);
    const escalateAfter = schedule.escalateAfterDays ?? DEFAULT_ESCALATE_AFTER[schedule.category];

    const level: EscalationLevel =
      daysOverdue === 0
        ? 'due'
        : daysOverdue > escalateAfter
          ? complianceLinked
            ? 'compliance_risk'
            : 'escalated'
          : 'overdue';

    const escalated = level === 'escalated' || level === 'compliance_risk';

    overdue.push({
      taskId: task.taskId,
      scheduleId: schedule.scheduleId,
      title: schedule.title,
      category: schedule.category,
      dueOn: task.dueOn,
      daysOverdue,
      level,
      escalateTo: escalated ? schedule.escalatesTo : undefined,
      complianceLinked,
      detail:
        level === 'compliance_risk'
          ? `"${schedule.title}" is ${daysOverdue} day(s) overdue and a regulator would care — escalated to ${schedule.escalatesTo}${done.outcome === 'evidence_missing' ? ' (it was ticked, but with no evidence)' : ''}`
          : level === 'escalated'
            ? `"${schedule.title}" is ${daysOverdue} day(s) overdue — escalated to ${schedule.escalatesTo}`
            : level === 'due'
              ? `"${schedule.title}" is due today`
              : `"${schedule.title}" is ${daysOverdue} day(s) late`,
    });
  }

  // Compliance risk first, then by how long it has been rotting.
  const rank: Record<EscalationLevel, number> = {
    compliance_risk: 0, escalated: 1, overdue: 2, due: 3, none: 4,
  };
  return overdue.sort(
    (a, b) => rank[a.level] - rank[b.level] || b.daysOverdue - a.daysOverdue || a.taskId.localeCompare(b.taskId),
  );
}

export type IncidentKind = 'injury' | 'near_miss' | 'fire' | 'equipment_failure' | 'food_safety' | 'security';

export type IncidentSeverity = 'minor' | 'serious' | 'reportable';

export interface SafetyIncident {
  readonly incidentId: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly kind: IncidentKind;
  readonly severity: IncidentSeverity;
  readonly occurredAt: string;
  readonly reportedAt: string;
  readonly reportedBy: string;
  readonly description: string;
  readonly evidenceRefs?: readonly string[];
  readonly assetId?: string;
  /** Corrective action, once there is one. */
  readonly actionTaken?: string;
  readonly closedAt?: string;
  readonly closedBy?: string;
}

export type IncidentCloseOutcome =
  | 'closed'
  | 'no_action_recorded'
  | 'no_evidence'
  | 'self_closed'
  | 'not_reported_to_authority';

export interface IncidentCloseResult {
  readonly incidentId: string;
  readonly closed: boolean;
  readonly outcome: IncidentCloseOutcome;
  readonly detail: string;
}

/**
 * Close a safety incident — or refuse to.
 *
 * **An incident closed with no corrective action is an incident that will happen again**, and
 * the record will show it was "handled". So a close needs the action written down, evidence
 * where the severity warrants it, and somebody other than the reporter signing it off.
 *
 * A reportable incident additionally cannot be closed until the statutory notification has
 * been made. That is not the system being difficult: closing it internally is precisely what
 * makes everybody stop thinking about it.
 */
export function closeIncident(input: {
  readonly incident: SafetyIncident;
  readonly closedBy: string;
  readonly actionTaken: string;
  readonly authorityNotifiedOn?: string;
  readonly at: string;
}): IncidentCloseResult {
  const base = { incidentId: input.incident.incidentId };

  if (input.actionTaken.trim() === '') {
    return {
      ...base,
      closed: false,
      outcome: 'no_action_recorded',
      detail: 'an incident closed with no corrective action is an incident that will happen again, recorded as handled',
    };
  }
  if (input.incident.severity !== 'minor' && (input.incident.evidenceRefs ?? []).length === 0) {
    return {
      ...base,
      closed: false,
      outcome: 'no_evidence',
      detail: `a ${input.incident.severity} incident cannot be closed on a description alone — evidence is retained and never deleted (#6)`,
    };
  }
  if (input.closedBy === input.incident.reportedBy && input.incident.severity !== 'minor') {
    return {
      ...base,
      closed: false,
      outcome: 'self_closed',
      detail: `${input.closedBy} both reported and closed this — a serious incident needs a second person (§28)`,
    };
  }
  if (input.incident.severity === 'reportable' && input.authorityNotifiedOn === undefined) {
    return {
      ...base,
      closed: false,
      outcome: 'not_reported_to_authority',
      detail: 'this is a reportable incident and no statutory notification is on file — closing it internally is exactly what makes everybody stop thinking about it',
    };
  }

  return {
    ...base,
    closed: true,
    outcome: 'closed',
    detail: `closed by ${input.closedBy} on ${input.at.slice(0, 10)}: ${input.actionTaken}`,
  };
}

export interface ComplianceEvidencePack {
  readonly branchId: string;
  readonly from: string;
  readonly to: string;
  readonly schedulesCovered: number;
  readonly tasksDue: number;
  readonly tasksEvidenced: number;
  readonly tasksMissed: number;
  readonly openIncidents: number;
  readonly reportableIncidents: number;
  /** True only when an inspector could be handed this without a conversation. */
  readonly presentable: boolean;
  readonly gaps: readonly string[];
  readonly detail: string;
}

/**
 * Build the pack an inspector would ask for, and **say plainly whether it would survive**.
 *
 * The same principle as the finance evidence pack (M23-FR-04): a pack that quietly presents
 * a 60%-complete record as "the evidence" is worse than no pack, because somebody will hand
 * it over believing it is complete. Gaps are listed by name.
 */
export function buildComplianceEvidence(input: {
  readonly branchId: string;
  readonly schedules: readonly MaintenanceSchedule[];
  readonly tasks: readonly ScheduledTask[];
  readonly incidents: readonly SafetyIncident[];
  readonly from: string;
  readonly to: string;
}): ComplianceEvidencePack {
  const schedules = input.schedules.filter((s) => s.branchId === input.branchId && s.active);
  const scheduleById = new Map(schedules.map((s) => [s.scheduleId, s]));
  const due = input.tasks.filter(
    (t) => scheduleById.has(t.scheduleId) && t.dueOn >= input.from && t.dueOn <= input.to,
  );

  const gaps: string[] = [];
  let tasksEvidenced = 0;
  let tasksMissed = 0;

  for (const task of due) {
    const schedule = scheduleById.get(task.scheduleId)!;
    const result = assessCompletion({ schedule, task });
    if (result.accepted) {
      tasksEvidenced += 1;
    } else {
      tasksMissed += 1;
      if (COMPLIANCE_CATEGORIES.has(schedule.category)) {
        gaps.push(`${task.dueOn} "${schedule.title}" — ${result.outcome.replace(/_/g, ' ')}`);
      }
    }
  }

  const incidents = input.incidents.filter(
    (i) => i.branchId === input.branchId && i.occurredAt >= input.from && i.occurredAt <= `${input.to}T23:59:59Z`,
  );
  const open = incidents.filter((i) => i.closedAt === undefined);
  const reportable = incidents.filter((i) => i.severity === 'reportable');

  for (const incident of open.filter((i) => i.severity !== 'minor')) {
    gaps.push(`${incident.occurredAt.slice(0, 10)} ${incident.severity} ${incident.kind.replace(/_/g, ' ')} still open`);
  }

  const presentable = gaps.length === 0;

  return {
    branchId: input.branchId,
    from: input.from,
    to: input.to,
    schedulesCovered: schedules.length,
    tasksDue: due.length,
    tasksEvidenced,
    tasksMissed,
    openIncidents: open.length,
    reportableIncidents: reportable.length,
    presentable,
    gaps: gaps.sort(),
    detail: presentable
      ? `${tasksEvidenced} of ${due.length} evidenced with nothing compliance-linked missing — this pack can be handed over`
      : `${gaps.length} gap(s) an inspector would find: this pack is NOT presentable as it stands, and handing it over as complete is worse than handing over nothing`,
  };
}
