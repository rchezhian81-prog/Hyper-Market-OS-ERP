// Productivity — sales per labour hour (M25-FR-03 "measure productivity"; OB-317, owner, 23 Oct 2026: "sales per labour
// hour per department, from the roster plus department sales").
//
// Two figures go into it and both are the shop's own: the LABOUR HOURS are the rostered hours (each assignment of an
// active person to a shift, the shift's length — a leaver still on the grid is not labour), and the SALES are the banked
// bills' net line values, split to departments by the categories each department owns (the department report's rule).
//
// The link between the two is the owner's decision OB-357 (24 Oct 2026, in writing): a person's rostered hours count to
// their HOME DEPARTMENT on the staff record (`Employee.homeDepartmentId`, `departmentLabour`). A person with no home
// department — or one whose home department is no longer a live department — is never guessed into one: their hours are
// shown "not attributed", by name, and still count to the whole-store rate (all sales over all rostered hours).
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
}): { readonly totalMinutes: number; readonly byShift: ReadonlyMap<string, number>; readonly byEmployee: ReadonlyMap<string, number>; readonly people: number } {
  const active = new Set(input.employees.filter((e) => e.active).map((e) => e.employeeId));
  const start = Date.parse(input.from); const end = Date.parse(input.to);
  const byShift = new Map<string, number>();
  const byEmployee = new Map<string, number>();
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
    byEmployee.set(a.employeeId, (byEmployee.get(a.employeeId) ?? 0) + minutes);
  }
  return { totalMinutes: total, byShift, byEmployee, people: people.size };
}

/** A person whose rostered hours belong to no department — said by name, never guessed into one (OB-357). */
export interface UnattributedPerson {
  readonly employeeId: string;
  readonly name: string;
  readonly labourMinutes: number;
  readonly why: 'no_home_department' | 'home_department_not_live';
}

/**
 * OB-357: each person's rostered minutes counted to their home department on the staff record. `liveDepartments` are the
 * departments the report shows; a home department not among them, or none at all, leaves the person "not attributed".
 */
export function departmentLabour(input: {
  readonly byEmployee: ReadonlyMap<string, number>;
  readonly employees: readonly Employee[];
  readonly liveDepartments: ReadonlySet<string>;
}): { readonly departmentMinutes: ReadonlyMap<string, number>; readonly notAttributed: { readonly labourMinutes: number; readonly people: readonly UnattributedPerson[] } } {
  const byId = new Map(input.employees.map((e) => [e.employeeId, e] as const));
  const departmentMinutes = new Map<string, number>();
  const people: UnattributedPerson[] = [];
  let unattributed = 0;
  for (const [employeeId, minutes] of [...input.byEmployee.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const e = byId.get(employeeId);
    const home = typeof e?.homeDepartmentId === 'string' && e.homeDepartmentId.trim() !== '' ? e.homeDepartmentId.trim() : undefined;
    if (home !== undefined && input.liveDepartments.has(home)) { departmentMinutes.set(home, (departmentMinutes.get(home) ?? 0) + minutes); continue; }
    unattributed += minutes;
    people.push({ employeeId, name: e?.name ?? employeeId, labourMinutes: minutes, why: home === undefined ? 'no_home_department' : 'home_department_not_live' });
  }
  return { departmentMinutes, notAttributed: { labourMinutes: unattributed, people } };
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
  /** OB-357: the rostered hours of people with no (live) home department — "not attributed", by name. */
  readonly notAttributed: { readonly labourMinutes: number; readonly people: readonly UnattributedPerson[] };
  readonly reportedOnly: true;
}

export function productivityReport(input: {
  readonly from: string;
  readonly to: string;
  readonly labour: { readonly totalMinutes: number; readonly people: number };
  readonly totalSalesMinor: number;
  readonly departments: readonly { readonly departmentId: string; readonly name: string; readonly salesMinor: number }[];
  readonly unownedSalesMinor: number;
  /** How many rostered minutes belong to each department (OB-357: by each person's home department). */
  readonly departmentMinutes?: ReadonlyMap<string, number>;
  /** OB-357: the hours that belong to no department, and whose. */
  readonly notAttributed?: { readonly labourMinutes: number; readonly people: readonly UnattributedPerson[] };
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
    notAttributed: input.notAttributed ?? { labourMinutes: attributed ? 0 : input.labour.totalMinutes, people: [] },
    reportedOnly: true,
  };
}
