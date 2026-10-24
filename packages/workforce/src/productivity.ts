// Productivity — sales per labour hour (M25-FR-03 "measure productivity"; OB-317, owner, 23 Oct 2026: "sales per labour
// hour per department, from the roster plus department sales").
//
// Two figures go into it and both are the shop's own: the LABOUR HOURS are the rostered hours (each assignment of an
// active person to a shift, the shift's length — a leaver still on the grid is not labour), and the SALES are the banked
// bills' net line values, split to departments by the categories each department owns (the department report's rule).
//
// What it will not do is invent the link between the two. A rostered hour carries no department in the roster today;
// until it is decided how an hour belongs to a department, each department's sales are shown with their labour hours
// "not attributed" — the rate per department is never a made-up figure — and the whole-store rate (all sales over all
// rostered hours) is shown, because it needs no such link. `departmentHours`, when given, is that link.
//
// Exact money: the rate is paise per hour, rounded once. Reported, never enforced (the labour-cost rule of this module).

import type { ShiftRequirement, ShiftAssignment, Employee } from './workforce';

export type Rate = { readonly kind: 'per_hour'; readonly minorPerHour: number } | { readonly kind: 'not_meaningful'; readonly because: string };

/** Paise per labour hour, or why there is no such figure. */
export function salesPerLabourHour(salesMinor: number, labourMinutes: number): Rate {
  if (labourMinutes <= 0) return { kind: 'not_meaningful', because: 'no rostered hours' };
  return { kind: 'per_hour', minorPerHour: Math.round((salesMinor * 60) / labourMinutes) };
}

/** Rostered minutes in [from, to): each active person's assignment to a shift, clipped to the window. */
export function rosteredMinutes(input: {
  readonly shifts: readonly ShiftRequirement[];
  readonly assignments: readonly ShiftAssignment[];
  readonly employees: readonly Employee[];
  readonly from: string;
  readonly to: string;
}): { readonly totalMinutes: number; readonly byShift: ReadonlyMap<string, number>; readonly people: number } {
  const active = new Set(input.employees.filter((e) => e.active).map((e) => e.employeeId));
  const start = Date.parse(input.from); const end = Date.parse(input.to);
  const byShift = new Map<string, number>();
  const people = new Set<string>();
  let total = 0;
  for (const a of input.assignments) {
    if (!active.has(a.employeeId)) continue;
    const s = input.shifts.find((x) => x.shiftId === a.shiftId);
    if (s === undefined) continue;
    const from = Math.max(start, Date.parse(s.startsAt)); const to = Math.min(end, Date.parse(s.endsAt));
    if (!(to > from)) continue;
    const minutes = Math.round((to - from) / 60_000);
    total += minutes; people.add(a.employeeId);
    byShift.set(s.shiftId, (byShift.get(s.shiftId) ?? 0) + minutes);
  }
  return { totalMinutes: total, byShift, people: people.size };
}

export interface DepartmentProductivity {
  readonly departmentId: string;
  readonly name: string;
  readonly salesMinor: number;
  /** null = the hours are not attributed to departments (said, never guessed). */
  readonly labourMinutes: number | null;
  readonly rate: Rate;
}

export interface ProductivityReport {
  readonly from: string;
  readonly to: string;
  readonly store: { readonly salesMinor: number; readonly labourMinutes: number; readonly people: number; readonly rate: Rate };
  readonly departments: readonly DepartmentProductivity[];
  /** Sales of products no department owns — counted to the store, never to a department. */
  readonly unownedSalesMinor: number;
  readonly hoursAttributed: boolean;
  readonly reportedOnly: true;
}

export function productivityReport(input: {
  readonly from: string;
  readonly to: string;
  readonly labour: { readonly totalMinutes: number; readonly people: number };
  readonly totalSalesMinor: number;
  readonly departments: readonly { readonly departmentId: string; readonly name: string; readonly salesMinor: number }[];
  readonly unownedSalesMinor: number;
  /** How many rostered minutes belong to each department — absent until that link is decided. */
  readonly departmentMinutes?: ReadonlyMap<string, number>;
}): ProductivityReport {
  const attributed = input.departmentMinutes !== undefined;
  return {
    from: input.from, to: input.to,
    store: { salesMinor: input.totalSalesMinor, labourMinutes: input.labour.totalMinutes, people: input.labour.people, rate: salesPerLabourHour(input.totalSalesMinor, input.labour.totalMinutes) },
    departments: [...input.departments].sort((a, b) => b.salesMinor - a.salesMinor || a.departmentId.localeCompare(b.departmentId)).map((d): DepartmentProductivity => {
      const minutes = attributed ? input.departmentMinutes!.get(d.departmentId) ?? 0 : null;
      return {
        departmentId: d.departmentId, name: d.name, salesMinor: d.salesMinor, labourMinutes: minutes,
        rate: minutes === null ? { kind: 'not_meaningful', because: 'labour hours are not attributed to departments yet' } : salesPerLabourHour(d.salesMinor, minutes),
      };
    }),
    unownedSalesMinor: input.unownedSalesMinor,
    hoursAttributed: attributed,
    reportedOnly: true,
  };
}
