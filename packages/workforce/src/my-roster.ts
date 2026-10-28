// "My own rota" — the shifts ONE person is rostered for, from the committed roster (M25 · §7 · OB-166 "A" · OB-155).
//
// One fold, used in two places so the answer is the same with or without the internet (OB-507):
//   • head office's `GET /v1/hr/workforce/my-roster` (services/finance/src/roster-store.ts);
//   • the store computer, from the roster head office put in the SIGNED store pack, when the line is down.
// Only shifts of a PUBLISHED week are shown (a week not yet published, or edited after publishing, is held back until it is
// checked and published again — `notYetPublished` says how many); each published week names the working-time limits that
// were not checked when it was published. Pure: no clock, no I/O.

import type { Employee, ShiftAssignment, ShiftRequirement } from './workforce';

/** The published week a shift belongs to, as head office judged it. */
export interface PublishedWeek {
  readonly branchId: string;
  readonly weekStart: string;
  readonly weekEnd: string;
  /** The working-time limits that were not checked when the week was published (labels, in the owner's words). */
  readonly limitsNotChecked: readonly string[];
}

export interface MyShift { readonly shiftId: string; readonly role: string; readonly branchId: string; readonly startsAt: string; readonly endsAt: string }

export interface MyRoster {
  readonly employeeId: string;
  readonly known: boolean;
  readonly active: boolean;
  readonly shifts: readonly MyShift[];
  readonly count: number;
  readonly notYetPublished: number;
  readonly weeks: readonly PublishedWeek[];
}

export function myRosterFrom(input: {
  readonly employeeId: string;
  readonly employees: readonly Employee[];
  readonly shifts: readonly ShiftRequirement[];
  readonly assignments: readonly ShiftAssignment[];
  /** Each shift staff may see now, with the published week it belongs to. */
  readonly visible: ReadonlyMap<string, PublishedWeek>;
}): MyRoster {
  const me = input.employees.find((e) => e.employeeId === input.employeeId);
  const byShift = new Map(input.shifts.map((s) => [s.shiftId, s] as const));
  const assigned = input.assignments.filter((a) => a.employeeId === input.employeeId && byShift.has(a.shiftId));
  const shifts = assigned
    .filter((a) => input.visible.has(a.shiftId))
    .map((a): MyShift => {
      const s = byShift.get(a.shiftId)!;
      return { shiftId: s.shiftId, role: a.role, branchId: s.branchId, startsAt: s.startsAt, endsAt: s.endsAt };
    })
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.shiftId.localeCompare(b.shiftId));
  const weeks = new Map<string, PublishedWeek>();
  for (const s of shifts) { const w = input.visible.get(s.shiftId)!; weeks.set(`${w.branchId}|${w.weekStart}`, w); }
  return {
    employeeId: input.employeeId, known: me !== undefined, active: me?.active ?? false, shifts, count: shifts.length,
    notYetPublished: assigned.length - shifts.length,
    weeks: [...weeks.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart) || a.branchId.localeCompare(b.branchId))
      .map((w) => ({ branchId: w.branchId, weekStart: w.weekStart, weekEnd: w.weekEnd, limitsNotChecked: [...w.limitsNotChecked] })),
  };
}
