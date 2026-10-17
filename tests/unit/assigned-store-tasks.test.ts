import { describe, it, expect } from 'vitest';
import { assignmentProblem, assessAssignedTasks, checkCompletion, carriedLateness, type AssignedTask } from '../../packages/workforce/src/assigned-tasks';

// D-8 (roadmap v2.1 addendum, ratified R2): "SOP checklists + assigned tasks with deadlines, evidence capture and completion
// accountability; asserted".

const task = (over: Partial<AssignedTask> = {}): AssignedTask => ({
  taskId: 't1', branchId: 'BR1', title: 'Face up aisle 4', assignedTo: 'u-ravi', assignedBy: 'u-mgr', assignedAt: '2026-10-16T03:00:00.000Z',
  dueAt: '2026-10-16T05:00:00.000Z', critical: false, evidenceRequired: true,
  sop: { sopId: 'sop-facing', version: 3 },
  steps: [{ stepId: 'front', label: 'Pull stock to the front' }, { stepId: 'labels', label: 'Labels face out' }],
  ...over,
});
const done = (over: Partial<{ doneBy: string; doneAt: string; evidenceRefs: string[]; stepsDone: string[]; note: string }> = {}) => ({
  doneBy: 'u-ravi', doneAt: '2026-10-16T04:30:00.000Z', evidenceRefs: ['photo-aisle4'], stepsDone: ['front', 'labels'], ...over,
});

describe('D-8 assigned tasks with deadlines', () => {
  it('a task is assigned to a named person with a deadline; an SOP checklist carries its steps', () => {
    expect(assignmentProblem(task())).toBeNull();
    expect(assignmentProblem(task({ assignedTo: ' ' }))).toMatch(/assigned to/);
    expect(assignmentProblem(task({ dueAt: 'tomorrow' }))).toMatch(/deadline/);
    expect(assignmentProblem(task({ steps: [] }))).toMatch(/SOP checklist needs its steps/);
    expect(assignmentProblem(task({ steps: [{ stepId: 'a', label: 'x' }, { stepId: 'a', label: 'y' }] }))).toMatch(/own stepId/);
  });
});

describe('D-8 evidence capture and completion accountability', () => {
  it('only the assignee completes it; every step ticked; the evidence the task requires', () => {
    expect(checkCompletion(task(), done({ doneBy: 'u-mgr' }))).toMatchObject({ ok: false, refusal: 'not_your_task' });
    expect(checkCompletion(task(), done({ stepsDone: ['front'] }))).toMatchObject({ ok: false, refusal: 'checklist_incomplete' });
    expect(checkCompletion(task(), done({ evidenceRefs: [] }))).toMatchObject({ ok: false, refusal: 'evidence_required' });
    expect(checkCompletion(task(), done({ evidenceRefs: ['  '] }))).toMatchObject({ ok: false, refusal: 'evidence_required' });
    expect(checkCompletion(task({ evidenceRequired: false }), done({ evidenceRefs: [] }))).toMatchObject({ ok: true });
    const ok = checkCompletion(task(), done({ note: ' all faced ' }));
    expect(ok).toEqual({ ok: true, completion: { taskId: 't1', doneBy: 'u-ravi', doneAt: '2026-10-16T04:30:00.000Z', evidenceRefs: ['photo-aisle4'], stepsDone: ['front', 'labels'], lateByMinutes: 0, accountableDueAt: '2026-10-16T05:00:00.000Z', note: 'all faced' } });
    if (!ok.ok) throw new Error('expected ok');
    expect(checkCompletion(task(), done(), ok.completion)).toMatchObject({ ok: false, refusal: 'already_done' });
  });

  it('a late completion is kept as late, by how many minutes', () => {
    const late = checkCompletion(task(), done({ doneAt: '2026-10-16T06:15:00.000Z' }));
    expect(late).toMatchObject({ ok: true, completion: { lateByMinutes: 75 } });
  });

  it('reads every task worst first: escalated (critical and late), overdue, pending, done late, done', () => {
    const tasks = [
      task({ taskId: 'pending', dueAt: '2026-10-16T09:00:00.000Z' }),
      task({ taskId: 'overdue', dueAt: '2026-10-16T05:00:00.000Z' }),
      task({ taskId: 'critical', dueAt: '2026-10-16T06:00:00.000Z', critical: true }),
      task({ taskId: 'on-time' }),
      task({ taskId: 'late' }),
    ];
    const completions = [
      { taskId: 'on-time', doneBy: 'u-ravi', doneAt: '2026-10-16T04:00:00.000Z', evidenceRefs: ['p'], stepsDone: ['front', 'labels'], lateByMinutes: 0 },
      { taskId: 'late', doneBy: 'u-ravi', doneAt: '2026-10-16T06:00:00.000Z', evidenceRefs: ['p'], stepsDone: ['front', 'labels'], lateByMinutes: 60 },
    ];
    const v = assessAssignedTasks(tasks, completions, '2026-10-16T07:00:00.000Z');
    expect(v.map((t) => [t.taskId, t.status])).toEqual([['critical', 'escalated'], ['overdue', 'overdue'], ['pending', 'pending'], ['late', 'done_late'], ['on-time', 'done']]);
    expect(v[0]!.detail).toContain('escalated to u-mgr');
    expect(v[1]!.overdueByMinutes).toBe(120);
  });
});

describe('NEW-10: a re-assignment after the deadline keeps the missed deadline accountable', () => {
  it('re-assigned after missing it: the missed deadline stays accountable and on the list; before it: a plain new deadline', () => {
    const missed = task({ dueAt: '2026-10-16T05:00:00.000Z' });
    expect(carriedLateness(missed, '2026-10-16T08:00:00.000Z')).toEqual({ accountableDueAt: '2026-10-16T05:00:00.000Z', missedDeadlines: ['2026-10-16T05:00:00.000Z'] });
    expect(carriedLateness(missed, '2026-10-16T04:00:00.000Z')).toEqual({});
    // Missed twice: the FIRST missed deadline stays the accountable one; both are on the list.
    const again = task({ dueAt: '2026-10-16T09:00:00.000Z', accountableDueAt: '2026-10-16T05:00:00.000Z', missedDeadlines: ['2026-10-16T05:00:00.000Z'] });
    expect(carriedLateness(again, '2026-10-16T10:00:00.000Z')).toEqual({ accountableDueAt: '2026-10-16T05:00:00.000Z', missedDeadlines: ['2026-10-16T05:00:00.000Z', '2026-10-16T09:00:00.000Z'] });
  });
  it('a critical task stays escalated, and its completion is late from the missed deadline', () => {
    const t = task({ critical: true, dueAt: '2026-10-16T12:00:00.000Z', accountableDueAt: '2026-10-16T05:00:00.000Z' });
    const [v] = assessAssignedTasks([t], [], '2026-10-16T08:00:00.000Z');
    expect(v).toMatchObject({ status: 'escalated', overdueByMinutes: 180 });
    expect(v!.detail).toMatch(/re-assigned after missing its deadline of 2026-10-16T05:00:00.000Z/);
    const c = checkCompletion(t, done({ doneAt: '2026-10-16T09:00:00.000Z' }));
    expect(c).toMatchObject({ ok: true, completion: { lateByMinutes: 240, accountableDueAt: '2026-10-16T05:00:00.000Z' } });
  });
});
