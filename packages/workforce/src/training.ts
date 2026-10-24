// Training, competency and the role curriculum (M25-FR-03 "assign training → record certification"; D11-FR-04
// "training, competency, floor champions and adoption"; QG-09 "role curriculum, competency, floor support and SOP
// acknowledgements complete"; OB-320, owner, 23 Oct 2026: "the role curriculum is built from the SOP sheets and the
// owner guide, one list per role; the owner approves it on screen before it counts").
//
// Three records, each a fact with a name on it:
//
//   • an ASSIGNMENT — a manager gave this person this curriculum item (with an optional due day);
//   • a COMPLETION — the trainer recorded that the person did it (never the person about themselves);
//   • a COMPETENCY sign-off — a SECOND person (neither the trainee nor the trainer who recorded the completion) watched
//     them do it and signed "competent" or "not yet". Only "competent" counts. A "not yet" is kept and a later
//     "competent" supersedes it.
//
// The state of each assignment is worked out from those facts and today — never stored — so it cannot go stale:
// assigned → overdue (past its due day) → completed → competent (or not_yet_competent).
//
// The CURRICULUM per role is a proposal built from the shop's own sheets until the owner approves it; an approved list is
// versioned (a later approval supersedes, the earlier ones are kept). Until the owner approves a role's list it does not
// count: the adoption gate reads "not proven" for that role, never a pass.
//
// Pure and deterministic.

export interface CurriculumItem {
  readonly itemId: string;
  readonly title: string;
  readonly titleTa?: string;
  /** Where it comes from: an SOP sheet id ("SOP-01") or an owner guide part ("owner-guide:30"). */
  readonly source: string;
}

export interface ApprovedCurriculum {
  readonly roleId: string;
  readonly version: number;
  readonly items: readonly CurriculumItem[];
  readonly approvedBy: string;
  readonly approvedAt: string;
}

export interface TrainingAssignment {
  readonly assignmentId: string;
  readonly employeeId: string;
  readonly itemId: string;
  readonly title: string;
  readonly assignedBy: string;
  readonly assignedAt: string;
  /** YYYY-MM-DD; absent = no due day. */
  readonly dueOn?: string;
}

export interface TrainingCompletion {
  readonly assignmentId: string;
  readonly recordedBy: string;
  readonly completedAt: string;
  readonly evidenceRef?: string;
  /** A certificate this training earned, on the certification register (the task gate reads it). */
  readonly certificationId?: string;
}

export interface CompetencySignOff {
  readonly assignmentId: string;
  readonly signedBy: string;
  readonly signedAt: string;
  readonly outcome: 'competent' | 'not_yet';
  readonly note?: string;
}

export type TrainingState = 'assigned' | 'overdue' | 'completed' | 'competent' | 'not_yet_competent';

export interface TrainingRow extends TrainingAssignment {
  readonly state: TrainingState;
  readonly completion: TrainingCompletion | null;
  readonly competency: CompetencySignOff | null;
}

export type TrainingRefusal = 'trainee_cannot_record_own_training' | 'not_completed_yet' | 'second_person_required';

/** May this person record this completion? The trainee never records their own. */
export function checkCompletion(a: TrainingAssignment, recordedBy: string): TrainingRefusal | null {
  return recordedBy === a.employeeId ? 'trainee_cannot_record_own_training' : null;
}

/** May this person sign competency? Only after completion, and never the trainee or the trainer who recorded it. */
export function checkCompetency(a: TrainingAssignment, completion: TrainingCompletion | null, signedBy: string): TrainingRefusal | null {
  if (completion === null) return 'not_completed_yet';
  if (signedBy === a.employeeId || signedBy === completion.recordedBy) return 'second_person_required';
  return null;
}

/** Each assignment's state today, from its facts (the latest completion and the latest sign-off win). */
export function trainingRows(input: {
  readonly assignments: readonly TrainingAssignment[];
  readonly completions: readonly TrainingCompletion[];
  readonly signOffs: readonly CompetencySignOff[];
  readonly today: string;
}): readonly TrainingRow[] {
  const latest = <T extends { assignmentId: string }>(xs: readonly T[]): Map<string, T> => { const m = new Map<string, T>(); for (const x of xs) m.set(x.assignmentId, x); return m; };
  const done = latest(input.completions);
  const signed = latest(input.signOffs);
  const assignments = latest(input.assignments);
  return [...assignments.values()].map((a): TrainingRow => {
    const completion = done.get(a.assignmentId) ?? null;
    const competency = completion === null ? null : signed.get(a.assignmentId) ?? null;
    const state: TrainingState = competency?.outcome === 'competent' ? 'competent'
      : competency?.outcome === 'not_yet' ? 'not_yet_competent'
        : completion !== null ? 'completed'
          : a.dueOn !== undefined && a.dueOn < input.today ? 'overdue' : 'assigned';
    return { ...a, state, completion, competency };
  }).sort((x, y) => x.employeeId.localeCompare(y.employeeId) || x.itemId.localeCompare(y.itemId));
}

/** The approved curriculum for each role: the latest version approved. */
export function currentCurricula(approvals: readonly ApprovedCurriculum[]): ReadonlyMap<string, ApprovedCurriculum> {
  const out = new Map<string, ApprovedCurriculum>();
  for (const a of approvals) {
    const prior = out.get(a.roleId);
    if (prior === undefined || a.version >= prior.version) out.set(a.roleId, a);
  }
  return out;
}

/** Read a curriculum list from a request: each item an id, a title and its source; ids unique. */
export function readCurriculumItems(raw: unknown): readonly CurriculumItem[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return 'A curriculum is a list of one or more items.';
  const out: CurriculumItem[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const o = r !== null && typeof r === 'object' ? r as Record<string, unknown> : {};
    const str = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
    if (!str(o['itemId']) || !str(o['title']) || !str(o['source'])) return 'Each item needs an itemId, a title and its source.';
    if (seen.has(o['itemId'])) return `Item ${o['itemId']} is listed twice.`;
    seen.add(o['itemId']);
    out.push({ itemId: o['itemId'].trim(), title: o['title'].trim(), source: o['source'].trim(), ...(str(o['titleTa']) ? { titleTa: o['titleTa'].trim() } : {}) });
  }
  return out;
}
