// CR-01 step 4c-1 · OI-06 · ADR-0034 · OB-730 "A" · OB-740 "B" · OB-741 "A" · §28 · hard rules #2, #5, #10 — what a role may
// do, changed by two people, as recorded ADJUSTMENTS to the built-in roles.
//
//   • The built-in roles (services/api/src/roles.ts) stay the starting point. A shop's change is one append-only event —
//     a role, a permission, `add` or `remove`, who asked, who approved, why, when. A role's effective permissions are the
//     built-in ones with the adjustments applied in order (`applyRoleAdjustments`). Undo is another adjustment the other
//     way; nothing is overwritten or deleted (hard rule 2).
//   • Only from the existing list: a permission no built-in role holds is not the product's, and is refused.
//   • The never-from-a-screen list is REFUSED here, at head office, whoever asks and however the request was made — the
//     screen hiding it is a courtesy, not the control (`roleAdjustmentRefusal`).
//   • Two people, never the same one, and the owner always one of them (OB-740 "B"): a store manager asks and the owner
//     approves, or the owner asks and a store manager approves (the approval engine's `whenTheOwnerAsks`). Neither person
//     gives a permission they do not hold themselves (the grant route's rule, §28).
//   • Applied: audited in the asker's name with the approver named, and the owner alerted (P-03).

import type { Route } from '../../kernel/src/index';
import { apiError, requireActorIsCaller } from '../../kernel/src/index';
import type { Role } from '../../../packages/rbac/src/rbac';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { actionDetails, approvalNamedIn, type ApprovalPort } from './approval-requests';
import { isPlatformAdministrationRole } from './separation-of-duties';

/** The event a change to what a role may do is recorded as, on the identity ledger. */
export const ROLE_PERMISSION_ADJUSTED = 'RolePermissionAdjusted';
/** The approval kind (ADR-0024 engine) a change waits on. */
export const ROLE_PERMISSION_CHANGE_KIND = 'role_permission_change';
/** The permission both people act under — the owner's and the store manager's in the built-in roles (OB-740 "B"). */
export const ROLE_ADJUST_PERMISSION = 'identity.role.adjust';

export type AdjustmentChange = 'add' | 'remove';

/** One recorded change to what a role may do. */
export interface RolePermissionAdjustment {
  readonly requestId: string;
  readonly roleId: string;
  readonly permission: string;
  readonly change: AdjustmentChange;
  readonly reason: string;
  readonly requestedBy: string;
  readonly approvedBy: string;
  readonly approvalId: string;
  readonly at: string;
}

/** Why a role or a permission cannot be changed from a screen (ADR-0034 decision 4). */
export type LockReason =
  | 'machine_role'
  | 'outside_party_role'
  | 'posh_committee'
  | 'security_reviewer'
  | 'it_and_business_kept_apart'
  | 'controls_roles_approvals_or_ai'
  | 'owner_reserved'
  | 'owner_role_never_reduced';

/** Plain English for each reason — what the screen and every refusal say. */
export const LOCK_REASON_WORDS: Readonly<Record<LockReason, string>> = Object.freeze({
  machine_role: 'it belongs to a machine (the store computer, a relay or a job), which holds exactly what it needs and nothing a person uses (OB-36)',
  outside_party_role: 'it belongs to an outside party (a customer, a supplier, a business customer or a concessionaire), not to staff',
  posh_committee: 'it belongs to the POSH Internal Committee, whose complaints stay confidential by law (R2 C20)',
  security_reviewer: 'the security reviewer may do nothing else (OB-406)',
  it_and_business_kept_apart: 'the IT function and the shop\'s business are never held together (OB-91, OB-95)',
  controls_roles_approvals_or_ai: 'it decides who may approve, who may change roles, or what an AI agent may do on its own and how it is stopped (hard rule 5)',
  owner_reserved: 'it is one of the owner\'s reserved powers (OB-741 "A")',
  owner_role_never_reduced: 'the owner\'s own role is never reduced from a screen, so nobody can lock the owner out (OB-741 "A")',
});

/** What is locked, and who takes part — written down once, in the composition root (services/api/src/roles.ts). */
export interface RoleAdjustmentPolicy {
  readonly ownerRoleId: string;
  readonly platformAdminRoleId: string;
  /** OB-740 "B": who approves when the owner asks. */
  readonly checkerRoleWhenOwnerAsks: string;
  /** Roles that are never changed from a screen, and why. */
  readonly lockedRoles: Readonly<Record<string, LockReason>>;
  /** Permissions never added or removed from a screen: an exact code, or a prefix ending in '.' (a whole area). */
  readonly lockedPermissions: readonly { readonly match: string; readonly reason: LockReason }[];
}

/** A change judged not allowed: the HTTP status, a code, and the plain words. */
export interface AdjustmentRefusal {
  readonly status: number;
  readonly code: string;
  readonly reason?: LockReason;
  readonly whatHappened: string;
  readonly nextSafeAction: string;
}

const freezeRole = (r: Role, permissions: readonly string[]): Role =>
  Object.freeze({ ...r, permissions: Object.freeze([...permissions]) });

/**
 * The effective roles: the built-in ones with every recorded adjustment applied in the order it was recorded. A role a
 * recorded adjustment names that is not built in is ignored (it was refused when asked; a fold never invents a role).
 */
export function applyRoleAdjustments(builtIn: readonly Role[], adjustments: readonly RolePermissionAdjustment[]): readonly Role[] {
  if (adjustments.length === 0) return builtIn;
  const perms = new Map<string, string[]>(builtIn.map((r) => [r.id, [...r.permissions]]));
  for (const a of adjustments) {
    const list = perms.get(a.roleId);
    if (list === undefined) continue;
    const i = list.indexOf(a.permission);
    if (a.change === 'add' && i < 0) list.push(a.permission);
    if (a.change === 'remove' && i >= 0) list.splice(i, 1);
  }
  return Object.freeze(builtIn.map((r) => freezeRole(r, perms.get(r.id) ?? r.permissions)));
}

/** Per role: what the shop has added to, and taken from, the built-in role (for the screen and the owner's review). */
export function roleDifferences(builtIn: readonly Role[], effective: readonly Role[]): Readonly<Record<string, { readonly added: readonly string[]; readonly removed: readonly string[] }>> {
  const out: Record<string, { added: string[]; removed: string[] }> = {};
  for (const b of builtIn) {
    const e = effective.find((r) => r.id === b.id)?.permissions ?? b.permissions;
    out[b.id] = { added: e.filter((p) => !b.permissions.includes(p)).sort(), removed: b.permissions.filter((p) => !e.includes(p)).sort() };
  }
  return out;
}

/** OB-741 "A": the permissions only the owner holds in the BUILT-IN roles — worked out from them so the list cannot drift. */
export function ownerReservedPermissions(builtIn: readonly Role[], ownerRoleId: string): ReadonlySet<string> {
  const holders = new Map<string, string[]>();
  for (const r of builtIn) for (const p of r.permissions) holders.set(p, [...(holders.get(p) ?? []), r.id]);
  return new Set([...holders].filter(([, h]) => h.length === 1 && h[0] === ownerRoleId).map(([p]) => p));
}

/** The reason a permission itself is locked (an exact code, or an area it falls in), or undefined. */
export function permissionLock(policy: RoleAdjustmentPolicy, permission: string): LockReason | undefined {
  for (const l of policy.lockedPermissions) {
    if (l.match.endsWith('.') ? permission.startsWith(l.match) : permission === l.match) return l.reason;
  }
  return undefined;
}

/**
 * The reason a permission belongs to locked roles only (a machine's, an outside party's, the committee's, the security
 * reviewer's) or to the IT function only — so it never moves into a person's or a business role. undefined otherwise.
 */
function belongsOnlyToLockedOrIt(builtIn: readonly Role[], policy: RoleAdjustmentPolicy, permission: string): LockReason | undefined {
  const holders = builtIn.filter((r) => r.permissions.includes(permission));
  // The owner holds nearly every permission, so the owner is left out when asking whose a permission really is: one only
  // a machine and the owner hold (the store computer's relay hops, `*.sync`) is the machine's, not a person's job.
  const others = holders.filter((r) => r.id !== policy.ownerRoleId);
  if (others.length === 0) return undefined; // the owner's alone — judged as a reserved power (OB-741)
  const open = others.filter((r) => policy.lockedRoles[r.id] === undefined);
  if (open.length === 0) return policy.lockedRoles[others[0]!.id];
  if (open.every((r) => r.id === policy.platformAdminRoleId)) return 'it_and_business_kept_apart';
  return undefined;
}

/**
 * Whether this one change may be asked for and applied — every rule of ADR-0034 decision 4, judged against the BUILT-IN
 * roles (what is locked) and the CURRENT effective roles (what the role holds now). undefined = allowed.
 */
export function roleAdjustmentRefusal(input: {
  readonly builtIn: readonly Role[];
  readonly current: readonly Role[];
  readonly policy: RoleAdjustmentPolicy;
  readonly roleId: string;
  readonly permission: string;
  readonly change: AdjustmentChange;
}): AdjustmentRefusal | undefined {
  const { builtIn, current, policy, roleId, permission, change } = input;
  const nothing = 'Nobody\'s access changed.';
  const locked = (reason: LockReason, what: string): AdjustmentRefusal => ({
    status: 422, code: 'not_changeable_from_a_screen', reason,
    whatHappened: `${what} cannot be changed from a screen: ${LOCK_REASON_WORDS[reason]}.`,
    nextSafeAction: `Choose another permission or role. A change to this needs the owner's written decision and a programmer. ${nothing}`,
  });
  const role = builtIn.find((r) => r.id === roleId);
  if (role === undefined) {
    return { status: 404, code: 'not_a_role', whatHappened: `There is no role "${roleId}".`, nextSafeAction: `Choose one of the roles listed. ${nothing}` };
  }
  if (!builtIn.some((r) => r.permissions.includes(permission))) {
    return { status: 422, code: 'not_a_permission_of_the_product', whatHappened: `"${permission}" is not one of the product's permissions; only permissions that already exist can be switched on or off (OB-730 "A").`, nextSafeAction: `Choose a permission from the list. ${nothing}` };
  }
  const lockedRole = policy.lockedRoles[roleId];
  if (lockedRole !== undefined) return locked(lockedRole, `The role "${role.name}"`);
  if (roleId === policy.ownerRoleId && change === 'remove') return locked('owner_role_never_reduced', `Taking "${permission}" from the owner`);
  const permLock = permissionLock(policy, permission);
  if (permLock !== undefined) return locked(permLock, `"${permission}"`);
  if (change === 'add') {
    const only = belongsOnlyToLockedOrIt(builtIn, policy, permission);
    if (only !== undefined) return locked(only, `Giving "${permission}" to "${role.name}"`);
    if (roleId !== policy.ownerRoleId && ownerReservedPermissions(builtIn, policy.ownerRoleId).has(permission)) {
      return locked('owner_reserved', `Giving "${permission}" to "${role.name}"`);
    }
  }
  const now = current.find((r) => r.id === roleId)?.permissions ?? role.permissions;
  if (change === 'add' && now.includes(permission)) {
    return { status: 409, code: 'role_already_holds_it', whatHappened: `"${role.name}" already holds "${permission}".`, nextSafeAction: `Nothing to switch on. ${nothing}` };
  }
  if (change === 'remove' && !now.includes(permission)) {
    return { status: 409, code: 'role_does_not_hold_it', whatHappened: `"${role.name}" does not hold "${permission}".`, nextSafeAction: `Nothing to switch off. ${nothing}` };
  }
  // OB-91 / OB-95: the platform administrator holds only the IT function, and a business role never becomes one by a change.
  if (roleId === policy.platformAdminRoleId && change === 'add' && !permission.startsWith('platform.')) {
    return locked('it_and_business_kept_apart', `Giving the business permission "${permission}" to the platform administrator`);
  }
  const after = change === 'add' ? [...now, permission] : now.filter((p) => p !== permission);
  if (isPlatformAdministrationRole({ ...role, permissions: now }) !== isPlatformAdministrationRole({ ...role, permissions: after })) {
    return locked('it_and_business_kept_apart', `This change to "${role.name}"`);
  }
  return undefined;
}

/** What the owner is told when a change has been applied (P-03). */
export interface RoleAdjustmentAlert {
  readonly requestId: string;
  readonly roleId: string;
  readonly roleName: string;
  readonly permission: string;
  readonly change: AdjustmentChange;
  readonly requestedBy: string;
  readonly approvedBy: string;
  readonly reason: string;
  readonly affectedPeople: readonly string[];
  readonly at: string;
}

export interface RoleAdjustmentDeps {
  readonly now: () => string;
  /** The built-in roles — what is locked is judged on these. */
  readonly builtInRoles: readonly Role[];
  readonly policy: RoleAdjustmentPolicy;
  /** The shop's effective roles now (built-in + adjustments). */
  readonly roles: (tenantId: string) => Promise<readonly Role[]>;
  readonly adjustments: (tenantId: string) => Promise<readonly RolePermissionAdjustment[]>;
  /** Append one adjustment to the identity ledger. */
  readonly recordAdjustment: (tenantId: string, adjustment: RolePermissionAdjustment) => Promise<void>;
  /** Everybody who holds the role now — the people a change reaches. */
  readonly holdersOf: (tenantId: string, roleId: string) => Promise<readonly { readonly userId: string; readonly branchScope: readonly string[] | 'all' }[]>;
  readonly rolesHeldBy: (tenantId: string, userId: string) => Promise<readonly string[]>;
  readonly permissionsOf: (tenantId: string, userId: string) => Promise<readonly string[]>;
  readonly approvals?: ApprovalPort;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly raiseOwnerAlert?: (tenantId: string, alert: RoleAdjustmentAlert) => Promise<void>;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const refusalError = (r: AdjustmentRefusal): Error =>
  apiError(r.status, { code: r.code, whatHappened: r.whatHappened, wasItSaved: 'not_saved', nextSafeAction: r.nextSafeAction, ...(r.reason === undefined ? {} : { reason: r.reason }) });
const refuse = (status: number, code: string, whatHappened: string, nextSafeAction: string): Error =>
  apiError(status, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction: `${nextSafeAction} Nobody's access changed.` });

/** Read { roleId, permission, change } from a body, or undefined. */
function readChange(b: Record<string, unknown>): { roleId: string; permission: string; change: AdjustmentChange } | undefined {
  if (!isStr(b['roleId']) || !isStr(b['permission']) || (b['change'] !== 'add' && b['change'] !== 'remove')) return undefined;
  return { roleId: (b['roleId'] as string).trim(), permission: (b['permission'] as string).trim(), change: b['change'] };
}

const NOT_READABLE = (extra: string): Error => refuse(400, 'not_readable_as_a_role_change',
  `A change to what a role may do needs { roleId, permission, change: "add" or "remove"${extra} }. Who asks is taken from your sign-in.`,
  'Say which role, which permission, and whether it is switched on or off.');

export function roleAdjustmentRoutes(deps: RoleAdjustmentDeps): readonly Route[] {
  const { policy } = deps;
  const ownerReserved = ownerReservedPermissions(deps.builtInRoles, policy.ownerRoleId);
  /** Who approves a change this person asks for (OB-740 "B"). */
  const approverFor = (askerRoles: readonly string[]): string =>
    askerRoles.includes(policy.ownerRoleId) ? 'a store manager (in their own session)' : 'the owner (in their own session)';

  return [
    {
      // Every role: what it holds now, what the shop changed from the built-in role, and whether it is locked — plus the
      // owner's reserved powers, the locked areas and every change ever recorded. For the Users & roles page (4c-2).
      api: 'API-01', method: 'GET', path: '/v1/identity/role-permissions',
      permission: ROLE_ADJUST_PERMISSION,
      handler: async (ctx) => {
        const [current, history] = await Promise.all([deps.roles(ctx.tenantId), deps.adjustments(ctx.tenantId)]);
        const diff = roleDifferences(deps.builtInRoles, current);
        return {
          status: 200,
          body: {
            asAt: deps.now(),
            roles: deps.builtInRoles.map((b) => {
              const lock = policy.lockedRoles[b.id];
              return {
                roleId: b.id, name: b.name, ...(b.nameTa === undefined ? {} : { nameTa: b.nameTa }),
                locked: lock === undefined ? null : { reason: lock, words: LOCK_REASON_WORDS[lock] },
                permissions: [...(current.find((r) => r.id === b.id)?.permissions ?? b.permissions)].sort(),
                added: diff[b.id]?.added ?? [], removed: diff[b.id]?.removed ?? [],
              };
            }),
            ownerReserved: [...ownerReserved].sort(),
            lockedPermissions: policy.lockedPermissions.map((l) => ({ match: l.match, reason: l.reason, words: LOCK_REASON_WORDS[l.reason] })),
            history,
            howAChangeIsMade: 'Check it (POST /v1/identity/role-permissions/check), ask for approval (POST /v1/approvals/requests, kind role_permission_change, with exactly the change and a requestId), and once the second person approves it in their own session, apply it (POST /v1/identity/role-permissions/:requestId with the approvalId). The owner is always one of the two people.',
          },
        };
      },
    },
    {
      // Before asking: is this change allowed, who does it reach, and who must approve it? Changes nothing.
      api: 'API-01', method: 'POST', path: '/v1/identity/role-permissions/check',
      permission: ROLE_ADJUST_PERMISSION, idempotent: true, // reads only: safe to send again
      handler: async (ctx) => {
        const c = readChange((ctx.body ?? {}) as Record<string, unknown>);
        if (c === undefined) throw NOT_READABLE('');
        const refusal = roleAdjustmentRefusal({ builtIn: deps.builtInRoles, current: await deps.roles(ctx.tenantId), policy, ...c });
        const youLack = refusal === undefined && c.change === 'add' && !(await deps.permissionsOf(ctx.tenantId, ctx.userId)).includes(c.permission);
        const affected = (await deps.holdersOf(ctx.tenantId, c.roleId)).map((h) => ({ userId: h.userId, branchScope: h.branchScope }));
        if (refusal !== undefined || youLack) {
          return {
            status: 200,
            body: {
              ...c, allowed: false,
              refusal: refusal === undefined
                ? { code: 'you_do_not_hold_it', whatHappened: `You do not hold "${c.permission}" yourself, so you cannot give it to a role (§28).` }
                : { code: refusal.code, ...(refusal.reason === undefined ? {} : { reason: refusal.reason }), whatHappened: refusal.whatHappened },
              affectedPeople: affected,
            },
          };
        }
        return { status: 200, body: { ...c, allowed: true, affectedPeople: affected, approvedBy: approverFor(await deps.rolesHeldBy(ctx.tenantId, ctx.userId)) } };
      },
    },
    {
      // Apply a change a second person approved. Body: { roleId, permission, change, reason, approvalId }. The caller is the
      // person who ASKED (requireActorIsCaller); the approval was given in the other person's own session for exactly this
      // change (kind role_permission_change). Sensitive: a recent MFA re-authentication, as giving a role.
      api: 'API-01', method: 'POST', path: '/v1/identity/role-permissions/:requestId',
      permission: ROLE_ADJUST_PERMISSION, idempotent: true,
      reauth: { withinSeconds: 300, amr: ['mfa'] },
      handler: async (ctx) => {
        const requestId = (ctx.params['requestId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        requireActorIsCaller(ctx, b, 'requestedBy');
        const c = readChange(b);
        if (requestId === '' || c === undefined || !isStr(b['reason'])) throw NOT_READABLE(', reason, approvalId');
        const reason = (b['reason'] as string).trim();
        const current = await deps.roles(ctx.tenantId);
        const refusal = roleAdjustmentRefusal({ builtIn: deps.builtInRoles, current, policy, ...c });
        if (refusal !== undefined) throw refusalError(refusal);
        const at = deps.now();
        const opened = await approvalNamedIn(deps.approvals, {
          tenantId: ctx.tenantId, approvalId: b['approvalId'], typedField: 'approvedBy', typedValue: b['approvedBy'],
          kind: ROLE_PERMISSION_CHANGE_KIND, subjectRef: requestId, details: actionDetails(ctx.body, { requestId }), valueMinor: null,
          maker: ctx.userId, usedBy: `role-permission-change:${requestId}`, now: at,
        });
        if (opened === undefined) {
          throw refuse(422, 'role_change_needs_a_second_person',
            'A change to what a role may do applies only once a second person has approved exactly this change in their own session — the owner always one of the two (OB-730, OB-740 "B", §28).',
            'Ask for approval (POST /v1/approvals/requests, kind role_permission_change, with exactly this change and requestId); once it is approved, send it again with the approvalId.');
        }
        const approvedBy = opened.decision.decidedBy;
        if (approvedBy === ctx.userId) {
          throw refuse(422, 'role_change_approved_by_its_asker', `${ctx.userId} asked for this change and cannot also approve it (§28).`, 'Ask the other person to approve it in their own session.');
        }
        // OB-740 "B", judged again on the roles held NOW, before the approval is spent: the owner is one of the two, and when
        // the owner asked, the approver is a store manager.
        const [askerRoles, approverRoles] = await Promise.all([deps.rolesHeldBy(ctx.tenantId, ctx.userId), deps.rolesHeldBy(ctx.tenantId, approvedBy)]);
        const askerIsOwner = askerRoles.includes(policy.ownerRoleId);
        if (!askerIsOwner && !approverRoles.includes(policy.ownerRoleId)) {
          throw refuse(422, 'role_change_needs_the_owner', `Neither ${ctx.userId} nor ${approvedBy} holds the owner role. The owner is always one of the two people who change what a role may do (OB-740 "B").`, 'Ask the owner to approve exactly this change in their own session.');
        }
        if (askerIsOwner && !approverRoles.includes(policy.checkerRoleWhenOwnerAsks)) {
          throw refuse(422, 'role_change_asked_by_the_owner_needs_a_store_manager', `The owner asked for this change, so a store manager approves it; ${approvedBy} does not hold the store manager role (OB-740 "B").`, 'Ask a store manager to approve exactly this change in their own session.');
        }
        // §28: neither person gives a permission they do not hold themselves.
        if (c.change === 'add') {
          for (const who of [ctx.userId, approvedBy]) {
            if (!(await deps.permissionsOf(ctx.tenantId, who)).includes(c.permission)) {
              throw refuse(422, 'gives_what_they_do_not_hold', `${who} does not hold "${c.permission}" and so cannot give it to a role (§28: nobody gives authority they do not hold).`, 'Ask someone who holds it, or choose another permission.');
            }
          }
        }
        const affected = (await deps.holdersOf(ctx.tenantId, c.roleId)).map((h) => h.userId);
        await opened.spend();
        const adjustment: RolePermissionAdjustment = { requestId, ...c, reason, requestedBy: ctx.userId, approvedBy, approvalId: (b['approvalId'] as string).trim(), at };
        await deps.recordAdjustment(ctx.tenantId, adjustment);
        const roleName = deps.builtInRoles.find((r) => r.id === c.roleId)?.name ?? c.roleId;
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'role.permission.adjust', objectType: 'role', objectId: c.roleId,
          at, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: { permission: c.permission, held: String(c.change === 'remove') },
          after: { permission: c.permission, held: String(c.change === 'add'), change: c.change, requestedBy: ctx.userId, approvedBy, affectedPeople: affected.join(',') },
          reason, approvalId: adjustment.approvalId, correlationId: requestId,
        });
        await deps.raiseOwnerAlert?.(ctx.tenantId, { requestId, roleName, ...c, requestedBy: ctx.userId, approvedBy, reason, affectedPeople: affected, at });
        return {
          status: 201,
          body: {
            requestId, ...c, requestedBy: ctx.userId, approvedBy, affectedPeople: affected,
            appliesAtHeadOffice: 'from the next request',
            onTheTills: 'when the store PC next takes its store pack — until then the tills still work to the role as it was',
          },
        };
      },
    },
  ];
}
