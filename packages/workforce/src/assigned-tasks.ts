// D-8 (roadmap v2.1 addendum, ratified R2) — store task management and execution.
//
// Acceptance, in the addendum's words: "SOP checklists + assigned tasks with deadlines, evidence capture and completion
// accountability; asserted".
//
// The daily-task store (M25-FR-02, `assessDailyTasks`) routes a task to a ROLE and records a `doneBy` a manager types. D-8
// closes what that leaves open, on the same status words (pending / overdue / escalated / done):
//
//   • **Assigned to a named person**, by a named person, with a deadline — never "the morning shift" and never nobody.
//   • **An SOP checklist**: a task may carry the steps of an SOP (named by its id and the version in force when it was
//     assigned), and it is not done until every step is ticked.
//   • **Evidence capture**: a task that requires evidence (a photo of the faced shelf, the signed delivery note) is not done
//     without it — refused, not "done with a note".
//   • **Completion accountability**: only the ASSIGNEE completes their task, in their own sign-in; the record says who,
//     when, and whether it was on time or how many minutes late. A task done late stays "done late" — never quietly green.
//   • **A missed deadline stays missed (NEW-10)**: re-assigning a task AFTER its deadline passed records the new deadline
//     but keeps the one that was missed as the ACCOUNTABLE deadline — the task stays overdue (a critical one stays
//     escalated) and its completion is measured late from the missed deadline. Re-planning a task before its deadline is
//     a plain new deadline. Every missed deadline stays on the task's record.
//
// Pure and deterministic: the clock is injected; no I/O.

export interface TaskStep {
  readonly stepId: string;
  readonly label: string;
}

export interface AssignedTask {
  readonly taskId: string;
  readonly branchId: string;
  readonly title: string;
  readonly assignedTo: string;
  readonly assignedBy: string;
  readonly assignedAt: string;
  readonly dueAt: string;
  readonly critical: boolean;
  readonly evidenceRequired: boolean;
  /** The SOP this checklist carries out, at the version in force when the task was assigned. */
  readonly sop?: { readonly sopId: string; readonly version: number };
  readonly steps: readonly TaskStep[];
  /**
   * NEW-10: the deadline the task is ACCOUNTED against — the first deadline that passed with the task not done (it is
   * carried through every later re-assignment), or `dueAt` when no deadline has been missed. Absent: `dueAt`.
   */
  readonly accountableDueAt?: string;
  /** NEW-10: every deadline that had already passed, not done, when the task was re-assigned — oldest first. */
  readonly missedDeadlines?: readonly string[];
}

/** NEW-10: the deadline lateness is measured from. */
export const accountableDueOf = (t: AssignedTask): string => t.accountableDueAt ?? t.dueAt;

/**
 * NEW-10: what a re-assignment carries forward from the version before it. If the earlier version's accountable deadline
 * had passed when it was re-assigned (`at`), that deadline stays the accountable one and is added to the missed list; a
 * re-assignment before the deadline is a plain new deadline.
 */
export function carriedLateness(before: AssignedTask | undefined, at: string): Pick<AssignedTask, 'accountableDueAt' | 'missedDeadlines'> {
  if (before === undefined) return {};
  const prior = accountableDueOf(before);
  const missed = [...(before.missedDeadlines ?? [])];
  if (Date.parse(at) > Date.parse(before.dueAt) && !missed.includes(before.dueAt)) missed.push(before.dueAt);
  const overdue = Date.parse(at) > Date.parse(prior);
  return {
    // A deadline already missed stays the accountable one (once missed, every later re-assignment carries it).
    ...(overdue ? { accountableDueAt: prior } : {}),
    ...(missed.length === 0 ? {} : { missedDeadlines: missed }),
  };
}

export interface AssignedTaskCompletion {
  readonly taskId: string;
  readonly doneBy: string;
  readonly doneAt: string;
  readonly evidenceRefs: readonly string[];
  readonly stepsDone: readonly string[];
  readonly note?: string;
  /** Set by the engine: minutes past the ACCOUNTABLE deadline (0 when on time) — NEW-10: a deadline missed before a
   *  re-assignment, if there was one. */
  readonly lateByMinutes: number;
  /** NEW-10: the deadline the lateness was measured from. Absent on completions from before NEW-10 (then `dueAt`). */
  readonly accountableDueAt?: string;
}

export type CompletionRefusal = 'not_your_task' | 'evidence_required' | 'checklist_incomplete' | 'already_done';

export type CompletionCheck =
  | { readonly ok: true; readonly completion: AssignedTaskCompletion }
  | { readonly ok: false; readonly refusal: CompletionRefusal; readonly detail: string };

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** Why an assignment cannot stand — or `null` when it can. */
export function assignmentProblem(t: Omit<AssignedTask, 'taskId' | 'assignedBy' | 'assignedAt'>): string | null {
  if (!isStr(t.branchId) || !isStr(t.title) || !isStr(t.assignedTo)) return 'a task needs a branch, a title and the person it is assigned to';
  if (!isStr(t.dueAt) || Number.isNaN(Date.parse(t.dueAt))) return 'a task needs a deadline (dueAt, a time)';
  const ids = t.steps.map((s) => s.stepId);
  if (ids.some((id) => !isStr(id)) || new Set(ids).size !== ids.length || t.steps.some((s) => !isStr(s.label))) {
    return 'each checklist step needs its own stepId and a label';
  }
  if (t.sop !== undefined && t.steps.length === 0) return 'an SOP checklist needs its steps';
  return null;
}

/**
 * Judge a completion: only the assignee, with every step ticked, with the evidence the task requires. On time or late
 * is measured from the deadline and kept.
 */
export function checkCompletion(task: AssignedTask, done: { readonly doneBy: string; readonly doneAt: string; readonly evidenceRefs: readonly string[]; readonly stepsDone: readonly string[]; readonly note?: string }, already?: AssignedTaskCompletion): CompletionCheck {
  if (already !== undefined) return { ok: false, refusal: 'already_done', detail: `"${task.title}" was already done by ${already.doneBy} at ${already.doneAt} — a completion is never overwritten` };
  if (done.doneBy !== task.assignedTo) {
    return { ok: false, refusal: 'not_your_task', detail: `"${task.title}" is assigned to ${task.assignedTo}; only they complete it, in their own sign-in (ask ${task.assignedBy} to reassign it)` };
  }
  const missing = task.steps.filter((s) => !done.stepsDone.includes(s.stepId));
  if (missing.length > 0) {
    return { ok: false, refusal: 'checklist_incomplete', detail: `"${task.title}" is not done until every step is ticked — not ticked: ${missing.map((s) => s.label).join(', ')}` };
  }
  const evidence = done.evidenceRefs.filter(isStr).map((e) => e.trim());
  if (task.evidenceRequired && evidence.length === 0) {
    return { ok: false, refusal: 'evidence_required', detail: `"${task.title}" needs its evidence (a photo or document reference) — a tick without it is not a completion` };
  }
  const due = accountableDueOf(task);
  const lateByMinutes = Math.max(0, Math.floor((Date.parse(done.doneAt) - Date.parse(due)) / 60_000));
  return {
    ok: true,
    completion: {
      taskId: task.taskId, doneBy: done.doneBy, doneAt: done.doneAt, evidenceRefs: evidence,
      stepsDone: task.steps.map((s) => s.stepId), lateByMinutes, accountableDueAt: due,
      ...(isStr(done.note) ? { note: done.note.trim() } : {}),
    },
  };
}

export type AssignedTaskStatus = 'pending' | 'overdue' | 'escalated' | 'done' | 'done_late';

export interface AssignedTaskView extends AssignedTask {
  readonly status: AssignedTaskStatus;
  readonly overdueByMinutes?: number;
  readonly completion?: AssignedTaskCompletion;
  readonly detail: string;
}

/** Every task with where it stands, worst first: escalated (critical and late), overdue, pending, done late, done. */
export function assessAssignedTasks(tasks: readonly AssignedTask[], completions: readonly AssignedTaskCompletion[], now: string): readonly AssignedTaskView[] {
  const nowMs = Date.parse(now);
  const doneBy = new Map(completions.map((c) => [c.taskId, c] as const));
  const rank: Record<AssignedTaskStatus, number> = { escalated: 0, overdue: 1, pending: 2, done_late: 3, done: 4 };
  return tasks.map((t): AssignedTaskView => {
    const c = doneBy.get(t.taskId);
    const due = accountableDueOf(t);
    const moved = due !== t.dueAt ? ` (re-assigned after missing its deadline of ${due}; new deadline ${t.dueAt})` : '';
    if (c !== undefined) {
      return c.lateByMinutes > 0
        ? { ...t, status: 'done_late', completion: c, detail: `done by ${c.doneBy}, ${c.lateByMinutes} minute(s) after the deadline${moved}` }
        : { ...t, status: 'done', completion: c, detail: `done by ${c.doneBy} on time` };
    }
    const over = Math.floor((nowMs - Date.parse(due)) / 60_000);
    if (over <= 0) return { ...t, status: 'pending', detail: `assigned to ${t.assignedTo}, due ${t.dueAt}` };
    return t.critical
      ? { ...t, status: 'escalated', overdueByMinutes: over, detail: `CRITICAL: ${t.assignedTo} has not done it, ${over} minute(s) past the deadline — escalated to ${t.assignedBy}${moved}` }
      : { ...t, status: 'overdue', overdueByMinutes: over, detail: `${t.assignedTo} has not done it, ${over} minute(s) past the deadline${moved}` };
  }).sort((a, b) => rank[a.status] - rank[b.status] || (b.overdueByMinutes ?? 0) - (a.overdueByMinutes ?? 0) || a.dueAt.localeCompare(b.dueAt) || a.taskId.localeCompare(b.taskId));
}
