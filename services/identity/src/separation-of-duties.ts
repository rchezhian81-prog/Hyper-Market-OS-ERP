// SEPARATION OF DUTIES — the IT/platform function and the running of the shop are never one person's (owner decision OB-95
// "C", 13 Oct 2026, in writing · §28 · SEC-03 · P-04 · M02-FR-02).
//
// OB-91 refused the IT/platform administrator's FUNCTION the clearing of a store computer's suspicious bill-number report.
// A person who held both the IT role and an all-stores business role could still clear it through the business role
// (verifier r24 Q3). The owner chose to close that at the source: head office refuses to give one person both.
//
//   • the IT/platform role is `platform_admin`, or any role whose whole grant is platform administration (every permission
//     in `platform.*`, besides reading oneself) — `isPlatformAdministrationRole`, the same rule OB-91 uses;
//   • a business role is every other role in the catalogue that a PERSON holds — not the machine identities (the store
//     computer, the backup job, the message-provider relay), which have their own rules (OB-54, PA-12);
//   • granting the IT role to someone who holds a business role, or a business role to someone who holds the IT role, is
//     refused by name — when it is asked for, when it is approved, in an emergency grant, in a joiner/mover change and in
//     the operator's initial admin set (scripts/bootstrap-tenant.ts, scripts/new-shop.ts). A live emergency grant counts as
//     held. Every refusal answers 422 `it_role_and_business_role_on_one_person`, and is on the audit trail like every
//     request;
//   • combinations already on the ledger (granted before this rule) are listed for the owner on the operational health
//     (`access_separation_of_duties`, degraded, naming each person and their roles) — never silently kept.

import type { Role } from '../../../packages/rbac/src/rbac';

/**
 * §28 / M33-FR-01 / SEC-11: the platform-administration (IT) function, held apart from running the shop. OB-91 and OB-95
 * (owner, 13 Oct 2026) turn on it.
 */
export const PLATFORM_ADMIN_ROLE_ID = 'platform_admin';

/**
 * OB-91: is this role the platform/IT administration function — the platform administrator itself, or any role whose
 * whole grant is platform administration (every permission in the `platform.*` namespace, besides reading oneself)? Such a
 * role runs the computers, never the shop.
 */
export function isPlatformAdministrationRole(role: Role): boolean {
  return role.id === PLATFORM_ADMIN_ROLE_ID
    || (role.permissions.length > 0 && role.permissions.every((p) => p.startsWith('platform.') || p === 'identity.self.read'));
}

/**
 * The machine identities' roles (mirrors services/api/src/roles.ts STORE_COMPUTER_ROLE_ID, BACKUP_JOB_ROLE_ID and
 * PROVIDER_RELAY_ROLE_ID — a test holds them equal). A machine is neither the IT function nor a business role here.
 */
export const MACHINE_ROLE_IDS: readonly string[] = Object.freeze(['store_computer', 'backup_job', 'message_provider_relay']);

/** The code every refusal of this rule carries. */
export const SEPARATION_OF_DUTIES_REFUSAL_CODE = 'it_role_and_business_role_on_one_person';

/** How a role counts under OB-95: the IT function, a business role, or neither (a machine, or not in the catalogue). */
export function dutyOf(roleId: string, roles: readonly Role[]): 'it' | 'business' | undefined {
  if (MACHINE_ROLE_IDS.includes(roleId)) return undefined;
  const role = roles.find((r) => r.id === roleId);
  if (role === undefined) return undefined;
  return isPlatformAdministrationRole(role) ? 'it' : 'business';
}

/**
 * A set of roles one person would hold: refused (the words) when it holds both the IT function and a business role.
 * undefined = acceptable.
 */
export function dutiesSetRefusal(roleIds: readonly string[], roles: readonly Role[]): string | undefined {
  const distinct = [...new Set(roleIds)];
  const it = distinct.filter((r) => dutyOf(r, roles) === 'it');
  const business = distinct.filter((r) => dutyOf(r, roles) === 'business');
  if (it.length === 0 || business.length === 0) return undefined;
  return `One person may not hold both the IT/platform role (${it.join(', ')}) and a business role (${business.join(', ')}) — owner decision OB-95: the person who looks after the computers never also runs the shop, so nobody can clear a warning about what a computer did through a business role. Give the IT work and the business work to two people, each with their own sign-in.`;
}

/** Grant-time rule: `roleId` given to a user who holds `heldRoleIds` now (from the ledger, live emergency grants included). */
export function dutiesGrantRefusal(roleId: string, heldRoleIds: readonly string[], roles: readonly Role[]): string | undefined {
  const refusal = dutiesSetRefusal([roleId, ...heldRoleIds], roles);
  if (refusal === undefined) return undefined;
  const duty = dutyOf(roleId, roles);
  // A person already holding both (granted before the rule) is refused any further grant too, until the mix is ended.
  return duty === 'it'
    ? `${roleId} is the IT/platform role, and this person already holds a business role. ${refusal}`
    : `This person already holds the IT/platform role, and ${roleId} is a business role. ${refusal}`;
}

/** OB-95: the people who hold both today (grants on the ledger from before the rule), with their roles — for the owner. */
export function combinedDuties(grants: readonly { readonly userId: string; readonly roleId: string }[], roles: readonly Role[]):
  { readonly userId: string; readonly itRoles: readonly string[]; readonly businessRoles: readonly string[] }[] {
  const byUser = new Map<string, Set<string>>();
  for (const g of grants) byUser.set(g.userId, (byUser.get(g.userId) ?? new Set()).add(g.roleId));
  const out: { userId: string; itRoles: string[]; businessRoles: string[] }[] = [];
  for (const [userId, held] of [...byUser].sort((a, b) => a[0].localeCompare(b[0]))) {
    const itRoles = [...held].filter((r) => dutyOf(r, roles) === 'it').sort();
    const businessRoles = [...held].filter((r) => dutyOf(r, roles) === 'business').sort();
    if (itRoles.length > 0 && businessRoles.length > 0) out.push({ userId, itRoles, businessRoles });
  }
  return out;
}
