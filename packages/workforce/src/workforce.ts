// Rosters, tasks, certification and incentives (M25 / P-04 / §28 / §29.1).
//
// This module governs people, which changes what "correct" means. A stock figure that is
// wrong costs money; a roster that is wrong means somebody's childcare falls through, or
// the shop opens with nobody who can legally slice meat. So three things are refusals
// rather than warnings, and one is deliberately *not*.
//
//   • **A ROSTER GAP IS VISIBLE, NOT AVERAGED.** "We have 14 shifts covered out of 16" is
//     a number nobody acts on. *"Sunday 06:00–14:00 has no one who can open the shop"* is.
//     Gaps are reported by **what is missing**, named, with the hour.
//   • **AN EXPIRED CERTIFICATION BLOCKS THE TASK IT GATES.** Not the person — the task.
//     Someone whose food-handling certificate lapsed can still stack shelves; they cannot
//     work the deli counter. Blocking the person is how a shop ends up ignoring the
//     system on a busy Saturday.
//   • **INCENTIVES ARE EXACT** (§29.1). Integer minor units, no floats, and a target that
//     was missed pays **nothing** rather than a proportion — because "nearly" is a
//     conversation, not a formula, and a system that quietly pays 96% of a missed target
//     has redefined the target.
//
// And the one that is *not* a refusal: **labour cost as a share of sales is reported, never
// enforced.** A system that refuses to roster a fourth cashier because the ratio looks bad
// is a system that creates queues at Diwali. It states the number; a manager decides.
//
// Pure and deterministic: the clock is injected, no I/O.

export interface Employee {
  readonly employeeId: string;
  readonly name: string;
  readonly branchId: string;
  /** The roles they are assigned — access follows from this (M02-FR-04, P-04). */
  readonly roles: readonly string[];
  readonly active: boolean;
  readonly hourlyRateMinor?: number;
}

export interface Certification {
  readonly certificationId: string;
  readonly employeeId: string;
  readonly kind: string;
  readonly issuedOn: string;
  /** Inclusive last valid date, YYYY-MM-DD. */
  readonly validUntil: string;
  readonly verifiedBy?: string;
}

export interface ShiftRequirement {
  readonly shiftId: string;
  readonly branchId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  /** What the shift genuinely cannot run without. */
  readonly requiredRoles: readonly { readonly role: string; readonly count: number }[];
}

export interface ShiftAssignment {
  readonly shiftId: string;
  readonly employeeId: string;
  readonly role: string;
}

export interface RosterGap {
  readonly shiftId: string;
  readonly startsAt: string;
  readonly role: string;
  readonly needed: number;
  readonly assigned: number;
  readonly short: number;
  /** Written for a manager reading it on a phone, not for a report. */
  readonly detail: string;
}

/**
 * Find what the roster is actually missing.
 *
 * Reported **per role per shift**, with the hour, because "14 of 16 covered" is a number
 * nobody acts on and *"Sunday 06:00 has nobody who can open the shop"* is.
 */
export function rosterGaps(input: {
  readonly shifts: readonly ShiftRequirement[];
  readonly assignments: readonly ShiftAssignment[];
  readonly employees: readonly Employee[];
}): readonly RosterGap[] {
  const active = new Set(input.employees.filter((e) => e.active).map((e) => e.employeeId));
  const gaps: RosterGap[] = [];

  for (const shift of [...input.shifts].sort((a, b) => a.startsAt.localeCompare(b.startsAt))) {
    for (const requirement of shift.requiredRoles) {
      // A leaver still on the roster is not cover. This is the gap nobody sees until the
      // morning, because the name is still in the grid.
      const assigned = input.assignments.filter(
        (a) => a.shiftId === shift.shiftId && a.role === requirement.role && active.has(a.employeeId),
      ).length;
      if (assigned >= requirement.count) continue;

      gaps.push({
        shiftId: shift.shiftId,
        startsAt: shift.startsAt,
        role: requirement.role,
        needed: requirement.count,
        assigned,
        short: requirement.count - assigned,
        detail:
          assigned === 0
            ? `${shift.startsAt.slice(0, 16).replace('T', ' ')} has NOBODY rostered as ${requirement.role}`
            : `${shift.startsAt.slice(0, 16).replace('T', ' ')} is ${requirement.count - assigned} short of ${requirement.role}`,
      });
    }
  }

  return gaps;
}

export type TaskGateOutcome = 'allowed' | 'certification_expired' | 'certification_missing' | 'not_assigned' | 'inactive';

export interface TaskGateDecision {
  readonly employeeId: string;
  readonly task: string;
  readonly allowed: boolean;
  readonly outcome: TaskGateOutcome;
  readonly detail: string;
  /** What else this person may still do — so a lapsed certificate does not idle them. */
  readonly stillAllowed?: string;
}

/**
 * Decide whether someone may perform a **gated task**.
 *
 * The gate is on the **task**, never on the person. Someone whose food-handling
 * certificate lapsed can still stack shelves — they cannot work the deli counter. Blocking
 * the person outright is how a shop ends up working around the system on a busy Saturday,
 * and a control people route around is not a control.
 */
export function canPerformTask(input: {
  readonly employee: Employee;
  readonly task: string;
  /** The certification kind this task requires, if any. */
  readonly requiresCertification?: string;
  /** The role this task requires. */
  readonly requiresRole?: string;
  readonly certifications: readonly Certification[];
  readonly today: string;
}): TaskGateDecision {
  const base = { employeeId: input.employee.employeeId, task: input.task };

  if (!input.employee.active) {
    return { ...base, allowed: false, outcome: 'inactive', detail: 'this employee has left' };
  }
  if (input.requiresRole !== undefined && !input.employee.roles.includes(input.requiresRole)) {
    return {
      ...base,
      allowed: false,
      outcome: 'not_assigned',
      detail: `${input.task} needs the ${input.requiresRole} role and this person is assigned ${input.employee.roles.join(', ') || 'nothing'}`,
    };
  }
  if (input.requiresCertification !== undefined) {
    const cert = input.certifications
      .filter(
        (c) =>
          c.employeeId === input.employee.employeeId &&
          c.kind === input.requiresCertification &&
          c.verifiedBy !== undefined,
      )
      .sort((a, b) => b.validUntil.localeCompare(a.validUntil))[0];

    if (cert === undefined) {
      return {
        ...base,
        allowed: false,
        outcome: 'certification_missing',
        detail: `${input.task} needs a verified ${input.requiresCertification} and there is none on file`,
        stillAllowed: 'anything this role does that is not certification-gated',
      };
    }
    if (cert.validUntil < input.today) {
      return {
        ...base,
        allowed: false,
        outcome: 'certification_expired',
        detail: `${input.employee.name}'s ${input.requiresCertification} expired on ${cert.validUntil} — this task is blocked, not this person`,
        stillAllowed: 'anything this role does that is not certification-gated',
      };
    }
  }

  return { ...base, allowed: true, outcome: 'allowed', detail: `${input.employee.name} may do this` };
}

export type ChecklistOutcome = 'complete' | 'incomplete' | 'not_signed' | 'blocked_item';

export interface ChecklistItem {
  readonly itemId: string;
  readonly description: string;
  readonly done: boolean;
  readonly doneBy?: string;
  readonly doneAt?: string;
  /** True when the shop genuinely cannot open or close without it. */
  readonly blocking: boolean;
  readonly note?: string;
}

export interface ChecklistResult {
  readonly checklistId: string;
  readonly kind: 'opening' | 'closing' | 'handover';
  readonly outcome: ChecklistOutcome;
  readonly complete: boolean;
  readonly outstanding: readonly ChecklistItem[];
  readonly blockingOutstanding: readonly ChecklistItem[];
  readonly detail: string;
}

/**
 * Assess an opening, closing or handover checklist.
 *
 * **Blocking and non-blocking items are separated on purpose.** A checklist where
 * everything blocks is a checklist people tick without reading, and then the one item
 * that mattered — the chiller temperature, the safe — is ticked with the rest. So only
 * what genuinely stops the shop blocks it; the remainder is carried, visible, into the
 * next shift's handover.
 */
export function assessChecklist(input: {
  readonly checklistId: string;
  readonly kind: 'opening' | 'closing' | 'handover';
  readonly items: readonly ChecklistItem[];
  readonly signedBy?: string;
}): ChecklistResult {
  const outstanding = input.items.filter((i) => !i.done);
  const blockingOutstanding = outstanding.filter((i) => i.blocking);
  const base = { checklistId: input.checklistId, kind: input.kind, outstanding, blockingOutstanding };

  if (blockingOutstanding.length > 0) {
    return {
      ...base,
      outcome: 'blocked_item',
      complete: false,
      detail: `${blockingOutstanding.length} item(s) the shop cannot run without: ${blockingOutstanding.map((i) => i.description).join('; ')}`,
    };
  }
  if ((input.signedBy ?? '').trim() === '') {
    return {
      ...base,
      outcome: 'not_signed',
      complete: false,
      detail: 'a checklist with nobody\'s name on it is a list, not a record',
    };
  }
  if (outstanding.length > 0) {
    return {
      ...base,
      outcome: 'incomplete',
      complete: true,
      detail: `signed by ${input.signedBy} with ${outstanding.length} non-blocking item(s) carried into the handover: ${outstanding.map((i) => i.description).join('; ')}`,
    };
  }
  return { ...base, outcome: 'complete', complete: true, detail: `signed by ${input.signedBy}, nothing outstanding` };
}

export interface IncentiveTarget {
  readonly employeeId: string;
  readonly metric: string;
  readonly targetMinor: number;
  readonly achievedMinor: number;
  /** Payout if the target is met. Exact minor units. */
  readonly payoutMinor: number;
  /** Optional accelerator above target, in basis points of the excess. */
  readonly acceleratorBps?: number;
  /** Cap on the total payout. */
  readonly capMinor?: number;
}

export interface IncentiveResult {
  readonly employeeId: string;
  readonly metric: string;
  readonly met: boolean;
  readonly payoutMinor: number;
  readonly achievementBps: number | 'not_meaningful';
  readonly detail: string;
}

/**
 * Compute an incentive. **Exact integer arithmetic** (§29.1) and **a missed target pays
 * nothing** — not a proportion.
 *
 * Paying 96% of a bonus for 96% of a target has quietly redefined the target, and next
 * quarter everybody aims at 96%. "Nearly" is a conversation a manager can have; it is not
 * a formula.
 */
export function computeIncentive(target: IncentiveTarget): IncentiveResult {
  const achievementBps =
    target.targetMinor === 0
      ? ('not_meaningful' as const)
      : Number((BigInt(target.achievedMinor) * 10_000n) / BigInt(target.targetMinor));

  if (target.achievedMinor < target.targetMinor) {
    return {
      employeeId: target.employeeId,
      metric: target.metric,
      met: false,
      payoutMinor: 0,
      achievementBps,
      detail:
        achievementBps === 'not_meaningful'
          ? 'no target set, so nothing is payable'
          : `${(achievementBps / 100).toFixed(1)}% of target — nothing is payable. "Nearly" is a conversation for a manager, not a formula`,
    };
  }

  const excess = target.achievedMinor - target.targetMinor;
  const accelerator =
    target.acceleratorBps === undefined
      ? 0
      : Number((BigInt(excess) * BigInt(target.acceleratorBps)) / 10_000n);
  const raw = target.payoutMinor + accelerator;
  const payoutMinor = target.capMinor === undefined ? raw : Math.min(raw, target.capMinor);

  return {
    employeeId: target.employeeId,
    metric: target.metric,
    met: true,
    payoutMinor,
    achievementBps,
    detail:
      payoutMinor < raw
        ? `target met; ${raw} earned and capped at ${payoutMinor}`
        : accelerator > 0
          ? `target met with ${excess} over; ${target.payoutMinor} plus ${accelerator} accelerator`
          : `target met; ${payoutMinor} payable`,
  };
}

export interface LabourCostView {
  readonly branchId: string;
  readonly labourCostMinor: number;
  readonly salesMinor: number;
  readonly labourBps: number | 'not_meaningful';
  /** True when it is above the tenant's guide. Reported, never enforced. */
  readonly aboveGuide: boolean;
  readonly detail: string;
}

/**
 * Labour cost as a share of sales.
 *
 * **Reported, never enforced.** A system that refuses to roster a fourth cashier because
 * the ratio looks bad is a system that creates queues at Diwali and loses more than it
 * saved. It states the number, names the guide, and a manager decides.
 */
export function labourCost(input: {
  readonly branchId: string;
  readonly hours: readonly { readonly employeeId: string; readonly hours: number }[];
  readonly employees: readonly Employee[];
  readonly salesMinor: number;
  /** Per-tenant guide, in basis points of sales. Default 1,200 (12%). */
  readonly guideBps?: number;
}): LabourCostView {
  const rateById = new Map(input.employees.map((e) => [e.employeeId, e.hourlyRateMinor ?? 0]));
  const labourCostMinor = input.hours.reduce(
    (s, h) => s + Math.round((rateById.get(h.employeeId) ?? 0) * h.hours),
    0,
  );
  const guide = input.guideBps ?? 1_200;
  const labourBps =
    input.salesMinor === 0
      ? ('not_meaningful' as const)
      : Number((BigInt(labourCostMinor) * 10_000n) / BigInt(input.salesMinor));
  const aboveGuide = labourBps !== 'not_meaningful' && labourBps > guide;

  return {
    branchId: input.branchId,
    labourCostMinor,
    salesMinor: input.salesMinor,
    labourBps,
    aboveGuide,
    detail:
      labourBps === 'not_meaningful'
        ? `${labourCostMinor} of labour against no sales — the ratio means nothing today`
        : aboveGuide
          ? `labour is ${(labourBps / 100).toFixed(1)}% of sales against a ${(guide / 100).toFixed(1)}% guide — worth a look, and it is your call: a queue costs more than a cashier`
          : `labour is ${(labourBps / 100).toFixed(1)}% of sales`,
  };
}

export interface SopAcknowledgement {
  readonly sopId: string;
  readonly version: number;
  readonly employeeId: string;
  readonly acknowledgedAt: string;
}

export interface SopStatus {
  readonly sopId: string;
  readonly title: string;
  readonly currentVersion: number;
  readonly employeeId: string;
  readonly acknowledgedVersion?: number;
  readonly upToDate: boolean;
  readonly detail: string;
}

/**
 * Who has acknowledged the **current version** of each SOP that applies to their role
 * (M25-FR-04).
 *
 * Acknowledging version 3 is not acknowledging version 5. A shop that treats an old
 * acknowledgement as current has a signature against a procedure nobody has read — which
 * is worse than no signature, because it looks like compliance.
 */
export function sopStatus(input: {
  readonly employee: Employee;
  readonly sops: readonly { readonly sopId: string; readonly title: string; readonly version: number; readonly forRoles: readonly string[] }[];
  readonly acknowledgements: readonly SopAcknowledgement[];
}): readonly SopStatus[] {
  return input.sops
    .filter((s) => s.forRoles.some((r) => input.employee.roles.includes(r)))
    .map((s): SopStatus => {
      const acknowledged = input.acknowledgements
        .filter((a) => a.sopId === s.sopId && a.employeeId === input.employee.employeeId)
        .sort((a, b) => b.version - a.version)[0];

      if (acknowledged === undefined) {
        return {
          sopId: s.sopId,
          title: s.title,
          currentVersion: s.version,
          employeeId: input.employee.employeeId,
          upToDate: false,
          detail: `${input.employee.name} has never acknowledged "${s.title}"`,
        };
      }
      const upToDate = acknowledged.version >= s.version;
      return {
        sopId: s.sopId,
        title: s.title,
        currentVersion: s.version,
        employeeId: input.employee.employeeId,
        acknowledgedVersion: acknowledged.version,
        upToDate,
        detail: upToDate
          ? `acknowledged v${acknowledged.version}`
          : `acknowledged v${acknowledged.version} but the current one is v${s.version} — an old signature against a procedure nobody has read looks like compliance and is not`,
      };
    })
    .sort((a, b) => Number(a.upToDate) - Number(b.upToDate) || a.sopId.localeCompare(b.sopId));
}
