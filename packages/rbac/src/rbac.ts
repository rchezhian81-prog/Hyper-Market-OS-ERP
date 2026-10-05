// Role-based access control (RBAC) — least privilege (P-04) and M02-FR-02 (role,
// branch and permission authorization). Default DENY: a user may do only what an
// assigned role EXPLICITLY grants, within the branch scope of that assignment.
// Every check is for a named user — there are no shared logins (hard rule #4).
// Pure domain logic: no storage, no I/O, no wildcards (every permission is
// explicit, by design).

/** A permission code, e.g. "pos.sale.create", "price.change.approve". */
export type Permission = string;

const PERMISSION_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z0-9]+)+$/;

/** True if `code` is a well-formed permission code (dot-separated segments). */
export function isPermission(code: string): code is Permission {
  return PERMISSION_PATTERN.test(code);
}

export interface Role {
  readonly id: string;
  readonly name: string;
  readonly permissions: readonly Permission[];
}

export interface RoleAssignment {
  readonly userId: string;
  readonly roleId: string;
  /** Branches this assignment applies to, or "all" for company-wide authority. */
  readonly branchScope: readonly string[] | 'all';
}

export interface AccessQuery {
  readonly userId: string;
  readonly permission: Permission;
  /** Branch the action targets; null = a company-wide action. */
  readonly branchId: string | null;
}

export class AccessDeniedError extends Error {
  constructor(query: AccessQuery) {
    const where = query.branchId === null ? '(company-wide)' : `in ${query.branchId}`;
    super(`Access denied: ${query.userId} lacks "${query.permission}" ${where}.`);
    this.name = 'AccessDeniedError';
  }
}

function scopeCovers(scope: readonly string[] | 'all', branchId: string | null): boolean {
  if (scope === 'all') return true;
  if (branchId === null) return false; // a company-wide action needs an "all"-scope grant
  return scope.includes(branchId);
}

/**
 * A default-deny access controller built from the configured roles and the
 * user→role assignments. `can` is true only when some assignment grants the
 * permission and its scope covers the branch.
 */
export class AccessControl {
  private readonly rolesById: Map<string, Role>;
  private readonly assignmentsByUser: Map<string, RoleAssignment[]>;

  constructor(roles: readonly Role[], assignments: readonly RoleAssignment[]) {
    // Both tables are COPIED, permission lists included. The assignments were already copied;
    // the roles were held by reference, so a caller who kept the array it passed in could widen
    // its own permissions after construction. `readonly` stops that in TypeScript and stops
    // nothing at all at a JSON boundary, which is where configuration actually arrives from.
    // Two structures where one is defended and the other is not is worse than either, because a
    // reader reasonably assumes the defence is uniform.
    this.rolesById = new Map(roles.map((r): [string, Role] => [
      r.id,
      Object.freeze({ ...r, permissions: Object.freeze([...r.permissions]) }),
    ]));
    this.assignmentsByUser = new Map();
    for (const a of assignments) {
      const list = this.assignmentsByUser.get(a.userId) ?? [];
      list.push(a);
      this.assignmentsByUser.set(a.userId, list);
    }
  }

  /** Default-deny check: true only if a role grant covers the permission and scope. */
  can(query: AccessQuery): boolean {
    const assignments = this.assignmentsByUser.get(query.userId) ?? [];
    for (const assignment of assignments) {
      const role = this.rolesById.get(assignment.roleId);
      if (!role) continue; // unknown role → grants nothing
      if (!role.permissions.includes(query.permission)) continue;
      if (scopeCovers(assignment.branchScope, query.branchId)) return true;
    }
    return false;
  }

  /**
   * WHERE this user may exercise `permission` (Wave 2b · audit PA-01 / EA-03): 'all' when any role granting it is
   * company-wide, otherwise the union of the branch ids of the grants that carry it — [] when none. The server's own
   * answer to "which branches may this person see or change", derived from the grants and never from the request.
   */
  branchScopeOf(userId: string, permission: Permission): readonly string[] | 'all' {
    const branches = new Set<string>();
    for (const assignment of this.assignmentsByUser.get(userId) ?? []) {
      const role = this.rolesById.get(assignment.roleId);
      if (!role || !role.permissions.includes(permission)) continue;
      if (assignment.branchScope === 'all') return 'all';
      for (const b of assignment.branchScope) branches.add(b);
    }
    return [...branches].sort();
  }

  /** Throws AccessDeniedError if the user may not perform the action. */
  assertCan(query: AccessQuery): void {
    if (!this.can(query)) {
      throw new AccessDeniedError(query);
    }
  }
}
