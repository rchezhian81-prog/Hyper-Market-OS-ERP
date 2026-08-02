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
    this.rolesById = new Map(roles.map((r): [string, Role] => [r.id, r]));
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

  /** Throws AccessDeniedError if the user may not perform the action. */
  assertCan(query: AccessQuery): void {
    if (!this.can(query)) {
      throw new AccessDeniedError(query);
    }
  }
}
