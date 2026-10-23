// Department scope on a person's role (M02-FR-02 "Role, branch, department, value-limit and state-based authorization" ·
// §28 "Department Manager — assigned departments … within limit" · §35 "Role + branch/department/value/state/purpose …
// Deny server-side" · SEC-03).
//
// A role grant already carries its BRANCH scope. This adds the department: a grant of a role to a person may be limited to
// some departments (org department nodes, each owning product categories — `packages/org/src/departments.ts`). Absent, the
// grant reaches every department, exactly as before. The limit is set — and lifted — by two people through the
// maker-checker engine (kind `department_scope_change`: someone who may request access asks, someone who may grant it
// approves, never the person it limits), recorded append-only, and the latest per (person, role) stands.
//
// The server then refuses, by name, a department-limited person acting outside their departments on the scoped families
// (assortment, counts, stock adjustments) and filters their reads — the composition root wraps those routes.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { actionDetails, openApproval, type ApprovalPort } from './approval-requests';

export const DEPARTMENT_SCOPE_KIND = 'department_scope_change';

export interface DepartmentScopeRecord {
  readonly userId: string;
  readonly roleId: string;
  /** The departments this person's role reaches, or 'all' (the limit lifted). */
  readonly departments: readonly string[] | 'all';
  readonly reason: string;
  readonly requestedBy: string;
  readonly approvedBy: string;
  readonly approvalId: string;
  readonly at: string;
}

/** The latest record per (person, role), in append order — a later record supersedes. */
export function foldDepartmentScopes(records: readonly DepartmentScopeRecord[]): ReadonlyMap<string, DepartmentScopeRecord> {
  const out = new Map<string, DepartmentScopeRecord>();
  for (const r of records) out.set(`${r.userId}\u0000${r.roleId}`, r);
  return out;
}

/** A grant's department scope from the fold: 'all' unless a record limits it. */
export function departmentScopeFor(scopes: ReadonlyMap<string, DepartmentScopeRecord>, userId: string, roleId: string): readonly string[] | 'all' {
  return scopes.get(`${userId}\u0000${roleId}`)?.departments ?? 'all';
}

export interface DepartmentScopeDeps {
  readonly records: (tenantId: string) => Promise<readonly DepartmentScopeRecord[]>;
  readonly recordScope: (tenantId: string, record: DepartmentScopeRecord) => Promise<void>;
  /** Does this person hold this role now (a live grant)? */
  readonly holdsRole: (tenantId: string, userId: string, roleId: string) => Promise<boolean>;
  /** The department nodes head office knows (org nodes of kind `department`, not closed). */
  readonly departmentIds: (tenantId: string) => Promise<readonly string[]>;
  readonly approvals: ApprovalPort;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

export function departmentScopeRoutes(deps: DepartmentScopeDeps): readonly Route[] {
  return [
    {
      // Limit (or lift the limit on) a person's role to some departments. Body: { departments ('all' | ids), reason,
      // approvalId } — asked for and approved through the engine (kind department_scope_change) by two other people.
      api: 'API-01', method: 'POST', path: '/v1/identity/department-scopes/:userId/:roleId',
      permission: 'identity.role.request', idempotent: true,
      handler: async (ctx) => {
        const userId = (ctx.params['userId'] ?? '').trim();
        const roleId = (ctx.params['roleId'] ?? '').trim();
        const b = (ctx.body !== null && typeof ctx.body === 'object' ? ctx.body : {}) as Record<string, unknown>;
        const departments = b['departments'] === 'all' ? 'all' as const
          : Array.isArray(b['departments']) && b['departments'].length > 0 && b['departments'].every(isStr) ? [...new Set((b['departments'] as string[]).map((d) => d.trim()))].sort() : undefined;
        if (userId === '' || roleId === '' || departments === undefined || !isStr(b['reason']) || !isStr(b['approvalId'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_department_scope',
            whatHappened: 'A department scope is { departments ("all", or one or more department ids), reason, approvalId } for a person\'s role in the path.',
            wasItSaved: 'not_saved',
            nextSafeAction: `Ask for approval first (POST /v1/approvals/requests, kind ${DEPARTMENT_SCOPE_KIND}, subjectRef ${userId}/${roleId}); then send it with the approvalId. Nothing was changed.`,
          });
        }
        if (userId === ctx.userId) {
          throw apiError(422, { code: 'scoping_yourself', whatHappened: `${ctx.userId} cannot change the reach of their own role (§28).`, wasItSaved: 'not_saved', nextSafeAction: 'Someone else asks for it. Nothing was changed.' });
        }
        if (!(await deps.holdsRole(ctx.tenantId, userId, roleId))) {
          throw apiError(422, { code: 'role_not_held', whatHappened: `${userId} does not hold the ${roleId} role, so there is nothing to limit.`, wasItSaved: 'not_saved', nextSafeAction: 'Grant the role first (two people), then limit it. Nothing was changed.' });
        }
        if (departments !== 'all') {
          const known = new Set(await deps.departmentIds(ctx.tenantId));
          const unknown = departments.filter((d) => !known.has(d));
          if (unknown.length > 0) {
            throw apiError(422, { code: 'unknown_department', whatHappened: `${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not a department head office knows (an org node of kind department).`, wasItSaved: 'not_saved', nextSafeAction: 'Name departments from the organisation page. Nothing was changed.' });
          }
        }
        const approval = await openApproval(deps.approvals, {
          tenantId: ctx.tenantId, approvalId: (b['approvalId'] as string).trim(), kind: DEPARTMENT_SCOPE_KIND, subjectRef: `${userId}/${roleId}`,
          details: actionDetails(ctx.body, { userId, roleId }), valueMinor: null, maker: ctx.userId,
          usedBy: `department-scope:${userId}/${roleId}`, now: deps.now(),
        });
        if (approval.decision.decidedBy === userId) {
          throw apiError(422, { code: 'scoped_person_approved', whatHappened: `${userId} approved the change to their own role's reach — it does not count (§28).`, wasItSaved: 'not_saved', nextSafeAction: 'Have a different person approve it. Nothing was changed.' });
        }
        await approval.spend();
        const before = (await deps.records(ctx.tenantId)).filter((r) => r.userId === userId && r.roleId === roleId).at(-1);
        const record: DepartmentScopeRecord = {
          userId, roleId, departments, reason: (b['reason'] as string).trim().slice(0, 300), requestedBy: ctx.userId,
          approvedBy: approval.decision.decidedBy, approvalId: approval.decision.requestId, at: deps.now(),
        };
        await deps.recordScope(ctx.tenantId, record);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'role.department_scope', objectType: 'user', objectId: userId, at: record.at,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: { roleId, departments: before === undefined ? 'all' : before.departments === 'all' ? 'all' : before.departments.join(',') },
          after: { roleId, departments: departments === 'all' ? 'all' : departments.join(','), approvedBy: record.approvedBy },
          reason: record.reason, approvalId: record.approvalId, correlationId: `${userId}/${roleId}`,
        });
        return { status: 201, body: record };
      },
    },
    {
      // Every person's department-limited role, as it stands now (a limit lifted to 'all' is no longer listed).
      api: 'API-01', method: 'GET', path: '/v1/identity/department-scopes',
      permission: 'identity.role.read',
      handler: async (ctx) => {
        const scopes = [...foldDepartmentScopes(await deps.records(ctx.tenantId)).values()].filter((r) => r.departments !== 'all');
        return { status: 200, body: { scopes, count: scopes.length } };
      },
    },
  ];
}
