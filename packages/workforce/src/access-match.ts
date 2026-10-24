// Access matches assignment (M25-FR-01 acceptance: "an employee's access matches their assignment"; P-04 least
// privilege; M02-FR-04 joiner-mover-leaver; audit-3 package 5).
//
// The staff list (the roster's employee records: who works here, in which branch, in which roles, still here or not)
// and the sign-in grants (which roles each person's account holds, and where) are two records kept by two different
// people. They drift: a cashier promoted to manager keeps the cashier grant AND gets the manager's; a leaver's account
// still opens the till a month later; a manager rostered at one store holds authority over every store. This compares
// the two and lists every difference as an exception for a person to act on — it changes nothing itself.
//
// What is compared, and what is deliberately not:
//
//   • Only the STAFF roles — the sign-in roles a person holds because of the job they are rostered for (store manager,
//     cashier, accountant, IT administrator). The owner is the owner, a chartered accountant is an outside
//     professional, and customers, suppliers and machines are not staff: they are listed as "not compared", never
//     silently skipped.
//   • A roster duty that is not a sign-in role ("opener", "deli") grants no sign-in access, so it can never be missing
//     one.
//
// The five exceptions, worst first:
//   critical  leaver_still_has_access     — marked as left on the staff list, still holds a staff role.
//   warning   not_on_staff_list           — holds a staff role and is not on the staff list at all.
//   warning   grant_without_assignment    — holds a staff role the staff list does not give them.
//   warning   branch_outside_assignment   — holds a staff role over a branch other than (or wider than) theirs.
//   info      assignment_without_grant    — rostered for a sign-in role they cannot sign in as (they cannot do the job).
//
// Pure and deterministic.

import type { Employee } from './workforce';

/** The sign-in roles a member of staff holds BECAUSE of their job — the ones compared with the staff list. */
export const STAFF_SIGN_IN_ROLES: readonly string[] = Object.freeze(['store_manager', 'cashier', 'accountant', 'platform_admin']);

export interface AccessGrant {
  readonly userId: string;
  readonly roleId: string;
  readonly branchScope: 'all' | readonly string[];
}

export type AccessMismatchKind =
  | 'leaver_still_has_access' | 'not_on_staff_list' | 'grant_without_assignment' | 'branch_outside_assignment' | 'assignment_without_grant';

export type AccessSeverity = 'critical' | 'warning' | 'info';

export interface AccessMismatch {
  readonly kind: AccessMismatchKind;
  readonly severity: AccessSeverity;
  readonly userId: string;
  readonly roleId: string;
  /** The staff list's branch for the person, when they are on it. */
  readonly rosteredBranch: string | null;
  /** The grant's branch scope, when the mismatch is about a grant. */
  readonly grantScope: 'all' | readonly string[] | null;
  readonly detail: { readonly en: string; readonly ta: string };
}

export interface AccessMatchReport {
  readonly mismatches: readonly AccessMismatch[];
  /** People compared (on the staff list, or holding a staff role). */
  readonly peopleCompared: number;
  /** Of them, whose access matches their assignment exactly. */
  readonly matching: number;
  /** The roles held by anybody that are not staff roles — said, never silently skipped. */
  readonly notCompared: readonly { readonly roleId: string; readonly holders: number }[];
}

const SEVERITY_RANK: Readonly<Record<AccessSeverity, number>> = { critical: 0, warning: 1, info: 2 };
const scopeWords = (s: 'all' | readonly string[]): string => (s === 'all' ? 'every branch' : s.join(', '));

export function accessMatch(input: {
  readonly employees: readonly Employee[];
  readonly grants: readonly AccessGrant[];
  readonly staffRoles?: readonly string[];
}): AccessMatchReport {
  const staffRoles = new Set(input.staffRoles ?? STAFF_SIGN_IN_ROLES);
  const byId = new Map(input.employees.map((e) => [e.employeeId, e] as const));
  const staffGrants = input.grants.filter((g) => staffRoles.has(g.roleId));
  const out: AccessMismatch[] = [];

  for (const g of staffGrants) {
    const e = byId.get(g.userId);
    if (e === undefined) {
      out.push({ kind: 'not_on_staff_list', severity: 'warning', userId: g.userId, roleId: g.roleId, rosteredBranch: null, grantScope: g.branchScope,
        detail: { en: `${g.userId} can sign in as ${g.roleId} (${scopeWords(g.branchScope)}) but is not on the staff list.`, ta: `${g.userId} ${g.roleId} ஆக உள்நுழைய முடியும் (${scopeWords(g.branchScope)}), ஆனால் பணியாளர் பட்டியலில் இல்லை.` } });
      continue;
    }
    if (!e.active) {
      out.push({ kind: 'leaver_still_has_access', severity: 'critical', userId: g.userId, roleId: g.roleId, rosteredBranch: e.branchId, grantScope: g.branchScope,
        detail: { en: `${e.name} (${g.userId}) has left but can still sign in as ${g.roleId}. Take the access away now.`, ta: `${e.name} (${g.userId}) வேலையை விட்டுவிட்டார், ஆனால் இன்னும் ${g.roleId} ஆக உள்நுழைய முடியும். உடனே அணுகலை நீக்கவும்.` } });
      continue;
    }
    if (!e.roles.includes(g.roleId)) {
      out.push({ kind: 'grant_without_assignment', severity: 'warning', userId: g.userId, roleId: g.roleId, rosteredBranch: e.branchId, grantScope: g.branchScope,
        detail: { en: `${e.name} (${g.userId}) can sign in as ${g.roleId}, but the staff list gives them ${e.roles.length === 0 ? 'no role' : e.roles.join(', ')}.`, ta: `${e.name} (${g.userId}) ${g.roleId} ஆக உள்நுழைய முடியும், ஆனால் பணியாளர் பட்டியல் தரும் பணி: ${e.roles.length === 0 ? 'எதுவும் இல்லை' : e.roles.join(', ')}.` } });
      continue;
    }
    if (g.branchScope === 'all' || g.branchScope.some((b) => b !== e.branchId)) {
      out.push({ kind: 'branch_outside_assignment', severity: 'warning', userId: g.userId, roleId: g.roleId, rosteredBranch: e.branchId, grantScope: g.branchScope,
        detail: { en: `${e.name} (${g.userId}) works at ${e.branchId} but holds ${g.roleId} over ${scopeWords(g.branchScope)}.`, ta: `${e.name} (${g.userId}) ${e.branchId} இல் பணிபுரிகிறார், ஆனால் ${g.roleId} அதிகாரம் ${scopeWords(g.branchScope)} வரை உள்ளது.` } });
    }
  }
  for (const e of input.employees) {
    if (!e.active) continue;
    for (const r of e.roles) {
      if (!staffRoles.has(r)) continue; // a duty that is not a sign-in role grants no access
      if (staffGrants.some((g) => g.userId === e.employeeId && g.roleId === r)) continue;
      out.push({ kind: 'assignment_without_grant', severity: 'info', userId: e.employeeId, roleId: r, rosteredBranch: e.branchId, grantScope: null,
        detail: { en: `${e.name} (${e.employeeId}) is rostered as ${r} but cannot sign in as ${r} — they cannot do that job on the system.`, ta: `${e.name} (${e.employeeId}) ${r} பணிக்கு ஒதுக்கப்பட்டுள்ளார், ஆனால் ${r} ஆக உள்நுழைய முடியாது.` } });
    }
  }

  const people = new Set<string>([...input.employees.map((e) => e.employeeId), ...staffGrants.map((g) => g.userId)]);
  const flagged = new Set(out.map((m) => m.userId));
  const notCompared = new Map<string, Set<string>>();
  for (const g of input.grants) {
    if (staffRoles.has(g.roleId)) continue;
    notCompared.set(g.roleId, (notCompared.get(g.roleId) ?? new Set<string>()).add(g.userId));
  }
  return {
    mismatches: out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.userId.localeCompare(b.userId) || a.roleId.localeCompare(b.roleId)),
    peopleCompared: people.size,
    matching: [...people].filter((p) => !flagged.has(p)).length,
    notCompared: [...notCompared.entries()].map(([roleId, h]) => ({ roleId, holders: h.size })).sort((a, b) => a.roleId.localeCompare(b.roleId)),
  };
}
