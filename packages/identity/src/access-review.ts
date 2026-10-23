// The access review and the permission matrix (M02-FR-01 "access-review report lists users, roles, scope and last login" ·
// M02-FR-02 "a permissions matrix export and an access-review report" · SEC-11 · §28 · P-03 · P-08). Pure: no storage.
//
// Who holds what, where, up to how much — and which rows deserve a second look. Each flag is a control that fails quietly
// in real shops: a leaver whose sign-in was ended but who still holds a role; a privileged person with no second factor; a
// role held by a name nobody gave a sign-in to; emergency access still live; the IT role and a business role on one person.
//
// The last sign-in time is kept by the identity server (Keycloak), not by head office — so the review says that, by name,
// rather than printing a blank that reads like "never" (P-08: never a fake zero).

export type SignInState = 'issued' | 'requested' | 'ended' | 'none';

export interface ReviewPerson {
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
  readonly state: Exclude<SignInState, 'none'>;
  /** Whether the sign-in was set up with a second factor. */
  readonly secondFactor: boolean;
}

export interface ReviewGrant {
  readonly userId: string;
  readonly roleId: string;
  readonly branchScope: readonly string[] | 'all';
  readonly departmentScope?: readonly string[] | 'all';
}

export interface ReviewEmergencyGrant {
  readonly userId: string;
  readonly roleId: string;
  readonly expiresAt: string;
  readonly approvedBy: string;
}

export interface ReviewRole {
  readonly id: string;
  readonly name: string;
  readonly permissions: readonly string[];
}

export const ACCESS_REVIEW_FLAGS = Object.freeze([
  'privileged_without_second_factor',
  'holds_roles_after_sign_in_ended',
  'holds_roles_with_no_sign_in',
  'emergency_access_live',
  'it_and_business_roles',
] as const);
export type AccessReviewFlag = (typeof ACCESS_REVIEW_FLAGS)[number];

/** Permissions that make a person privileged (SEC-03 "MFA required for privileged and remote access"). */
export const PRIVILEGED_PERMISSIONS: readonly string[] = Object.freeze([
  'identity.role.grant', 'platform.setup.write', 'platform.flag.write', 'platform.config.approve',
  'approvals.rules.approve', 'org.structure.approve', 'platform.support.grant',
]);

export interface AccessReviewEntry {
  readonly userId: string;
  readonly displayName: string | null;
  readonly username: string | null;
  readonly signIn: SignInState;
  readonly secondFactor: boolean | null;
  readonly roles: readonly { readonly roleId: string; readonly roleName: string; readonly branchScope: readonly string[] | 'all'; readonly departmentScope: readonly string[] | 'all' }[];
  readonly emergency: readonly { readonly roleId: string; readonly expiresAt: string; readonly approvedBy: string }[];
  readonly privileged: boolean;
  readonly machine: boolean;
  /** Never a blank: head office does not keep it. */
  readonly lastSignIn: { readonly at: null; readonly keptBy: 'identity_server' };
  readonly flags: readonly AccessReviewFlag[];
}

export function reviewAccess(input: {
  readonly people: readonly ReviewPerson[];
  readonly grants: readonly ReviewGrant[];
  readonly emergency: readonly ReviewEmergencyGrant[];
  readonly roles: readonly ReviewRole[];
  /** Roles held by machines (the store computer, the backup job…): they have no person's sign-in by design. */
  readonly machineRoleIds: readonly string[];
  /** Whether a role is the IT/platform-administration duty (§28 · OB-95). */
  readonly isItRole: (roleId: string) => boolean;
}): readonly AccessReviewEntry[] {
  const roleById = new Map(input.roles.map((r) => [r.id, r] as const));
  const ids = [...new Set([...input.people.map((p) => p.userId), ...input.grants.map((g) => g.userId), ...input.emergency.map((e) => e.userId)])].sort();
  return ids.map((userId): AccessReviewEntry => {
    const person = input.people.find((p) => p.userId === userId);
    const grants = input.grants.filter((g) => g.userId === userId);
    const emergency = input.emergency.filter((e) => e.userId === userId);
    const heldRoleIds = [...new Set([...grants.map((g) => g.roleId), ...emergency.map((e) => e.roleId)])];
    const permissions = new Set(heldRoleIds.flatMap((r) => roleById.get(r)?.permissions ?? []));
    const privileged = PRIVILEGED_PERMISSIONS.some((p) => permissions.has(p));
    const machine = heldRoleIds.length > 0 && heldRoleIds.every((r) => input.machineRoleIds.includes(r));
    const flags: AccessReviewFlag[] = [];
    if (privileged && person !== undefined && !person.secondFactor) flags.push('privileged_without_second_factor');
    if (heldRoleIds.length > 0 && person?.state === 'ended') flags.push('holds_roles_after_sign_in_ended');
    if (heldRoleIds.length > 0 && person === undefined && !machine) flags.push('holds_roles_with_no_sign_in');
    if (emergency.length > 0) flags.push('emergency_access_live');
    const it = heldRoleIds.some((r) => input.isItRole(r));
    const business = heldRoleIds.some((r) => !input.isItRole(r) && !input.machineRoleIds.includes(r));
    if (it && business) flags.push('it_and_business_roles');
    return {
      userId,
      displayName: person?.displayName ?? null,
      username: person?.username ?? null,
      signIn: person?.state ?? 'none',
      secondFactor: person === undefined ? null : person.secondFactor,
      roles: grants.map((g) => ({ roleId: g.roleId, roleName: roleById.get(g.roleId)?.name ?? g.roleId, branchScope: g.branchScope, departmentScope: g.departmentScope ?? 'all' }))
        .sort((a, b) => (a.roleId < b.roleId ? -1 : a.roleId > b.roleId ? 1 : 0)),
      emergency: emergency.map((e) => ({ roleId: e.roleId, expiresAt: e.expiresAt, approvedBy: e.approvedBy })),
      privileged, machine,
      lastSignIn: { at: null, keptBy: 'identity_server' },
      flags,
    };
  });
}

/** The permission matrix: every role against every permission it grants (sorted, so two exports compare line by line). */
export function permissionMatrix(roles: readonly ReviewRole[]): { readonly roles: readonly string[]; readonly permissions: readonly string[]; readonly grants: Readonly<Record<string, readonly string[]>> } {
  const permissions = [...new Set(roles.flatMap((r) => r.permissions))].sort();
  return {
    roles: roles.map((r) => r.id),
    permissions,
    grants: Object.fromEntries(permissions.map((p) => [p, roles.filter((r) => r.permissions.includes(p)).map((r) => r.id)])),
  };
}

/** The matrix as CSV — one row per permission, one column per role, `yes` where the role grants it. */
export function permissionMatrixCsv(roles: readonly ReviewRole[]): string {
  const m = permissionMatrix(roles);
  const cell = (v: string): string => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [['permission', ...m.roles].map(cell).join(',')];
  for (const p of m.permissions) lines.push([p, ...m.roles.map((r) => (m.grants[p]!.includes(r) ? 'yes' : ''))].map(cell).join(','));
  return `${lines.join('\n')}\n`;
}
