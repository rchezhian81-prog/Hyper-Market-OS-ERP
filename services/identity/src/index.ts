// API-01 Identity / Admin — orgs, branches, users, roles, approvals, config, number series.
//
// **This service never stores a credential**, and that is not an omission — it is M02-FR-01's
// deliberate partial. Passwords, passkeys and MFA enrolment belong to the deployment identity
// provider; holding them here would put credentials in this codebase, which hard rule #4 forbids.
// What this service does is resolve a token that the IdP issued into *scope*: which tenant, which
// branches, which role. A test reads the module's exports to prove there is nowhere to put a
// password.
//
// The other rule with teeth: **a role assignment is maker-checker** (§28, SEC-03). Granting
// yourself a permission is the shortest path to every other control in the product, so the one
// thing this service will not do is let one person widen their own authority.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { Permission, Role, RoleAssignment } from '../../../packages/rbac/src/rbac';
import { formatNumber, type NumberFormat } from '../../../packages/numbering/src/numbering';

/**
 * Document number formats per type (M01-FR-02) — configuration, not tenant data: what an invoice
 * number LOOKS like is the product's rule; the gap-free series behind it is per tenant. Kept here in
 * the identity/admin service, which owns "orgs, config, number series".
 */
export const NUMBER_FORMATS: Readonly<Record<string, NumberFormat>> = {
  receipt: { prefix: 'RCP', padTo: 6 },
  invoice: { prefix: 'INV', padTo: 6 },
  po: { prefix: 'PO', padTo: 6 },
  grn: { prefix: 'GRN', padTo: 6 },
  statement: { prefix: 'STMT', padTo: 6 },
};

// Resolving a token into scope. It verifies and never issues — see the file for why.
export * from './token';

export interface GrantRequest {
  readonly grantId: string;
  readonly userId: string;
  readonly roleId: string;
  readonly branchScope: readonly string[] | 'all';
  readonly requestedBy: string;
  readonly approvedBy?: string;
  readonly requestedAt: string;
}

export type GrantRefusal =
  | 'granting_to_yourself'
  | 'approved_by_the_requester'
  | 'not_approved'
  | 'unknown_role'
  | 'escalates_beyond_the_approver';

export interface GrantResult {
  readonly ok: boolean;
  readonly assignment?: RoleAssignment;
  readonly refusedBecause?: GrantRefusal;
  readonly detail: string;
}

/**
 * Grant a role, or refuse.
 *
 * The last refusal is the one people forget: an approver cannot approve a grant that hands out a
 * permission **they do not themselves hold**. Otherwise a supervisor who may approve access
 * changes can create an administrator, which makes every other limit on that supervisor
 * decorative.
 */
export function grantRole(input: {
  readonly request: GrantRequest;
  readonly roles: readonly Role[];
  readonly approverPermissions: readonly Permission[];
}): GrantResult {
  const { request } = input;
  const role = input.roles.find((r) => r.id === request.roleId);

  if (role === undefined) {
    return { ok: false, refusedBecause: 'unknown_role', detail: `no role ${request.roleId}` };
  }
  if (request.requestedBy === request.userId) {
    return {
      ok: false, refusedBecause: 'granting_to_yourself',
      detail: `${request.requestedBy} is requesting a role for themselves. Widening your own authority is the shortest path to every other control in this product`,
    };
  }
  if (request.approvedBy === undefined) {
    return { ok: false, refusedBecause: 'not_approved', detail: 'a role grant needs a second person (§28)' };
  }
  if (request.approvedBy === request.requestedBy) {
    return {
      ok: false, refusedBecause: 'approved_by_the_requester',
      detail: `${request.requestedBy} both requested and approved this. Two names on one action performed by one person is a self-approval with an extra step`,
    };
  }

  const beyond = role.permissions.filter((p) => !input.approverPermissions.includes(p));
  if (beyond.length > 0) {
    return {
      ok: false, refusedBecause: 'escalates_beyond_the_approver',
      detail: `${request.approvedBy} cannot grant ${beyond.join(', ')} because they do not hold it. Otherwise somebody who may approve access changes can create an administrator, and every other limit on them is decorative`,
    };
  }

  return {
    ok: true,
    assignment: { userId: request.userId, roleId: request.roleId, branchScope: request.branchScope },
    detail: `${request.userId} granted ${role.name} by ${request.requestedBy}, approved by ${request.approvedBy}`,
  };
}

export interface IdentityDeps {
  readonly roles: (tenantId: string) => Promise<readonly Role[]> | readonly Role[];
  readonly permissionsOf: (tenantId: string, userId: string) => Promise<readonly Permission[]> | readonly Permission[];
  readonly recordGrant: (tenantId: string, a: RoleAssignment, g: GrantRequest) => Promise<void> | void;
  readonly branches: (tenantId: string) => Promise<readonly { id: string; name: string }[]> | readonly { id: string; name: string }[];
  /** Allocate the next gap-free sequence number for a tenant's document type (M01-FR-02). */
  readonly allocateNumber: (tenantId: string, docType: string) => Promise<number>;
  readonly now: () => string;
}

export function identityRoutes(deps: IdentityDeps): readonly Route[] {
  return [
    {
      api: 'API-01', method: 'GET', path: '/v1/identity/me',
      permission: 'identity.self.read',
      handler: async (ctx) => ({
        status: 200,
        body: {
          tenantId: ctx.tenantId, userId: ctx.userId, branchId: ctx.branchId,
          permissions: await deps.permissionsOf(ctx.tenantId, ctx.userId),
          // No credential of any kind is returned, because none is held.
        },
      }),
    },
    {
      api: 'API-01', method: 'GET', path: '/v1/identity/roles',
      permission: 'identity.role.read',
      handler: async (ctx) => ({ status: 200, body: { roles: await deps.roles(ctx.tenantId) } }),
    },
    {
      api: 'API-01', method: 'GET', path: '/v1/org/branches',
      permission: 'org.branch.read',
      handler: async (ctx) => ({ status: 200, body: { branches: await deps.branches(ctx.tenantId) } }),
    },
    {
      api: 'API-01', method: 'POST', path: '/v1/identity/grants',
      permission: 'identity.role.grant', idempotent: true,
      handler: async (ctx) => {
        const request = ctx.body as GrantRequest;
        const result = grantRole({
          request,
          roles: await deps.roles(ctx.tenantId),
          approverPermissions: await deps.permissionsOf(ctx.tenantId, request?.approvedBy ?? ''),
        });
        if (!result.ok) {
          throw apiError(422, {
            code: result.refusedBecause!,
            whatHappened: result.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nobody\'s access changed. Have the grant requested and approved by two different people, one of whom already holds what is being granted.',
          });
        }
        await deps.recordGrant(ctx.tenantId, result.assignment!, request);
        return { status: 201, body: { granted: result.detail } };
      },
    },
    {
      // Allocate the next gap-free document number for a type (M01-FR-02). Idempotent: a retry under
      // the same key returns the SAME number (the kernel replays the stored response), so a dropped
      // connection never burns a number or hands out two. Gap-free/uniqueness is the store's job.
      api: 'API-01', method: 'POST', path: '/v1/identity/number-series/:docType',
      permission: 'documents.number.allocate', idempotent: true,
      handler: async (ctx) => {
        const docType = ctx.params['docType'] ?? '';
        const format = NUMBER_FORMATS[docType];
        if (format === undefined) {
          throw apiError(404, {
            code: 'unknown_document_type',
            whatHappened: `There is no number series for document type '${docType}'.`,
            wasItSaved: 'not_saved',
            nextSafeAction: `Use one of: ${Object.keys(NUMBER_FORMATS).join(', ')}. Nothing was allocated.`,
          });
        }
        const seq = await deps.allocateNumber(ctx.tenantId, docType);
        return { status: 201, body: { docType, seq, formatted: formatNumber(format, seq) } };
      },
    },
  ];
}
