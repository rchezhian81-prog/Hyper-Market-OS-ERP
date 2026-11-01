// Roles written down but not yet live — OB-615 (owner, 31 Oct 2026, in writing) · roadmap §28 · M02 · P-04.
//
// The owner decided that the four roadmap §28 roles a hypermarket's buying and stock work needs — Purchase User, Purchase
// Approver, Receiver/QC and Warehouse User — are added "each with exactly the roadmap's scope, MAY and MUST NOT", and that
// he SEES and APPROVES each role's permissions BEFORE it goes live. So a role here is defined in full (the permission words it
// would carry, and why each one), shown to the owner on the Users & roles page, and NOT ASSIGNABLE: a grant request or a
// joiner/mover change that names it is refused by name. A role becomes assignable only when the owner's written approval
// moves it into the live catalogue (services/api/src/roles.ts) — a code change through a pull request, like every role.
//
// This file holds only the shape and the refusal; the definitions themselves sit beside the live catalogue in
// services/api/src/roles.ts, the one place the product's authority model is written down.

import type { Role } from '../../../packages/rbac/src/rbac';
import { apiError } from '../../kernel/src/index';

/** One permission word a waiting role would carry, and why — in the owner's words. */
export interface WaitingPermission {
  readonly permission: string;
  readonly why: string;
}

/** A role defined from the roadmap and waiting for the owner's approval before anybody may hold it. */
export interface RoleAwaitingOwnerApproval extends Role {
  /** Roadmap §28, word for word: the role's SCOPE, what it MAY do and what it MUST NOT. */
  readonly roadmap: { readonly scope: string; readonly may: string; readonly mustNot: string };
  /** Which reach limits (M02-FR-02 role scopes) the role is meant to be narrowed by once granted. */
  readonly limitedBy: readonly ('suppliers' | 'categories' | 'locations' | 'money limit' | 'assigned work')[];
  /** Every permission word, each with the reason it is there (the same set as `permissions`). */
  readonly words: readonly WaitingPermission[];
  /** Words deliberately LEFT OUT because of the MUST NOT, each with the reason. */
  readonly withheld: readonly WaitingPermission[];
  /** What the owner is asked to settle before it goes live (2–3 options each, in the report). */
  readonly questions: readonly string[];
}

export const ROLE_AWAITING_OWNER_APPROVAL_CODE = 'role_awaiting_owner_approval';

/** Refused: nobody may be given a role the owner has not approved yet (OB-615). Undefined for any other role. */
export function awaitingApprovalRefusal(roleId: string, waiting: readonly RoleAwaitingOwnerApproval[] | undefined): Error | undefined {
  const role = (waiting ?? []).find((r) => r.id === roleId);
  if (role === undefined) return undefined;
  return apiError(422, {
    code: ROLE_AWAITING_OWNER_APPROVAL_CODE,
    whatHappened: `The ${role.name} role is written down but not live: the owner sees and approves its permissions before anybody may hold it (owner decision OB-615).`,
    wasItSaved: 'not_saved',
    nextSafeAction: 'The owner reads its permissions on the Users & roles page and gives his approval in writing; once it is live, ask again. Nothing was requested.',
  });
}
