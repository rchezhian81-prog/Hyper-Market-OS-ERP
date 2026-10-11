// PA-12 round 10 (M35-FR-01 · P-04 · hard rule #4 "no shared logins"): a MACHINE identity is never also a person.
//
// The backup job reports whether last night's backup worked, and that report is believed only from a grant of the
// `backup_job` role itself (round 7). Nothing stopped a PERSON's user id from also being granted `backup_job` — and then
// that person could post "backup good" under their own sign-in. So `backup_job` is machine-only:
//
//   • granting `backup_job` to a user who already holds ANY other role is refused when it is asked for, when it is
//     approved, in an emergency grant and in a joiner/mover change;
//   • granting any other role to a user who holds `backup_job` is refused the same way;
//   • at report time, a backup_job holder who also holds another role (a ledger from before this rule) is not believed.
//
// The backup job's identity holds `backup_job` and nothing else; a person who runs backups by hand signs in as themselves
// and cannot post the backup's outcome.

/** Roles that only a machine identity may hold — and that identity holds nothing else. */
export const MACHINE_ONLY_ROLES: readonly string[] = Object.freeze(['backup_job']);

/**
 * Grant-time rule. `roleId` is the role being granted; `heldRoleIds` the roles the user holds now (from the ledger, never
 * the request). undefined = acceptable; otherwise the plain-English reason.
 */
export function machineIdentityGrantRefusal(roleId: string, heldRoleIds: readonly string[]): string | undefined {
  const others = [...new Set(heldRoleIds.filter((r) => r !== roleId))];
  if (MACHINE_ONLY_ROLES.includes(roleId) && others.length > 0) {
    return `The ${roleId} role belongs to a machine identity that holds nothing else, and this user already holds ${others.join(', ')}. A person's sign-in must never be able to post the backup's outcome, so it is refused (PA-12). Give the backup job its own sign-in (docs/runbooks/backup-and-recovery.md).`;
  }
  const machine = others.find((r) => MACHINE_ONLY_ROLES.includes(r));
  if (machine !== undefined) {
    return `This user is the ${machine} machine identity, which holds nothing else; ${roleId} cannot be added to it. A person gets their own sign-in (PA-12).`;
  }
  return undefined;
}

/** A target set of grants for one user (a joiner/mover change): refused when it mixes a machine-only role with any other. */
export function machineIdentitySetRefusal(roleIds: readonly string[]): string | undefined {
  const distinct = [...new Set(roleIds)];
  const machine = distinct.find((r) => MACHINE_ONLY_ROLES.includes(r));
  if (machine === undefined || distinct.length === 1) return undefined;
  return machineIdentityGrantRefusal(machine, distinct);
}

/** The code every refusal of this rule carries. */
export const MACHINE_IDENTITY_REFUSAL_CODE = 'machine_identity_holds_only_its_role';
