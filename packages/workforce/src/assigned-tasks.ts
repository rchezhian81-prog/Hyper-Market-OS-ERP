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
}

export interface AssignedTaskCompletion {
  readonly taskId: string;
  readonly doneBy: string;
  readonly doneAt: string;
  readonly evidenceRefs: readonly string[];
  readonly stepsDone: readonly string[];
  readonly note?: string;
  /** Set by the engine: minutes past the deadline (0 when on time). */
  readonly lateByMinutes: number;
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
  const lateByMinutes = Math.max(0, Math.floor((Date.parse(done.doneAt) - Date.parse(task.dueAt)) / 60_000));
  return {
    ok: true,
    completion: {
      taskId: task.taskId, doneBy: done.doneBy, doneAt: done.doneAt, evidenceRefs: evidence,
      stepsDone: task.steps.map((s) => s.stepId), lateByMinutes,
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
    if (c !== undefined) {
      return c.lateByMinutes > 0
        ? { ...t, status: 'done_late', completion: c, detail: `done by ${c.doneBy}, ${c.lateByMinutes} minute(s) after the deadline` }
        : { ...t, status: 'done', completion: c, detail: `done by ${c.doneBy} on time` };
    }
    const over = Math.floor((nowMs - Date.parse(t.dueAt)) / 60_000);
    if (over <= 0) return { ...t, status: 'pending', detail: `assigned to ${t.assignedTo}, due ${t.dueAt}` };
    return t.critical
      ? { ...t, status: 'escalated', overdueByMinutes: over, detail: `CRITICAL: ${t.assignedTo} has not done it, ${over} minute(s) past the deadline — escalated to ${t.assignedBy}` }
      : { ...t, status: 'overdue', overdueByMinutes: over, detail: `${t.assignedTo} has not done it, ${over} minute(s) past the deadline` };
  }).sort((a, b) => rank[a.status] - rank[b.status] || (b.overdueByMinutes ?? 0) - (a.overdueByMinutes ?? 0) || a.dueAt.localeCompare(b.dueAt) || a.taskId.localeCompare(b.taskId));
}
