// The menu the store computer draws for each ERP screen (Stage G slice 5b · §27 role surfaces · P-07 · P-04).
//
// Every ERP page carries one menu of the OTHER screens this person may open. The list is not kept by hand and not
// guessed by the page: it is worked out HERE, per request, from two things the box already holds — the pack's role
// register (`roles` + `roleAssignments`, the same tables `packages/rbac` guards every action with) and the viewer the
// screen's own payload names (`userId`). `navigationFor` (apps/web-erp/src/navigation.ts) is the one catalogue, gated
// item by item on the permission the screen itself checks, so the menu can never offer a screen the server would
// refuse — and it is filtered to the screens THIS box serves, so it can never offer a dead link.
//
// Default deny, said out loud (P-08): no named viewer → no sections and the reason `no_user`; no role register on
// this box → no sections and the reason `no_roles`. A role register with a malformed entry drops that entry (a bad
// row grants nothing) rather than the whole register.

import { AccessControl, type Role, type RoleAssignment } from '../../../packages/rbac/src/rbac';
import { ERP_NAVIGATION, NAV_GROUP_LABELS, navigationFor, type NavItem } from '../../../apps/web-erp/src/navigation';
import type { StorePack } from './store-pack';
import type { ScreenName } from './screen-data';

export interface Bilingual { readonly en: string; readonly ta: string }

export interface NavigationLink {
  readonly id: string;
  readonly label: Bilingual;
  readonly path: string;
  /** True on the one item that opens the screen being served — the chrome marks it `aria-current="page"`. */
  readonly current: boolean;
}

export interface NavigationGroup { readonly group: Bilingual; readonly items: readonly NavigationLink[] }

export interface NavigationPayload {
  /** Who the screen's payload named, or null when it named nobody. */
  readonly userId: string | null;
  readonly branchId: string | null;
  /** The person's name and role as the pack's `people` section and role catalogue say them — null when the pack carries none (the rail then shows the id). */
  readonly person: { readonly name: string; readonly role: string | null } | null;
  /** The branch's name from the pack's policies — null when the pack carries none. */
  readonly branch: { readonly name: string } | null;
  /** Why `groups` is empty, when it is. Null when there is a list (which may still be empty for a user with no grants). */
  readonly why: 'no_user' | 'no_roles' | null;
  readonly groups: readonly NavigationGroup[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** The pack's untyped `roles` rows, kept only where they are whole. A half-row grants nothing. */
export function rolesFrom(rows: readonly unknown[]): Role[] {
  const roles: Role[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const { id, name, permissions } = row;
    if (typeof id !== 'string' || typeof name !== 'string' || !isStringList(permissions)) continue;
    roles.push({ id, name, permissions });
  }
  return roles;
}

/** The pack's untyped `people` rows, kept only where they name a person: `{ userId, displayName, roleId? }`. */
export function peopleFrom(rows: readonly unknown[]): { userId: string; displayName: string; roleId: string | null }[] {
  const people: { userId: string; displayName: string; roleId: string | null }[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const { userId, displayName, roleId } = row;
    if (typeof userId !== 'string' || userId === '' || typeof displayName !== 'string' || displayName.trim() === '') continue;
    people.push({ userId, displayName: displayName.trim(), roleId: typeof roleId === 'string' && roleId !== '' ? roleId : null });
  }
  return people;
}

/** The name and role of the person the screen named, when the pack carries them. */
export function personOf(userId: string | null, pack: StorePack): NavigationPayload['person'] {
  if (userId === null || !pack.people.known) return null;
  const me = peopleFrom(pack.people.value).find((p) => p.userId === userId);
  if (me === undefined) return null;
  const roles = pack.roles.known ? rolesFrom(pack.roles.value) : [];
  const assigned = pack.roleAssignments.known ? assignmentsFrom(pack.roleAssignments.value).find((a) => a.userId === userId)?.roleId ?? null : null;
  const roleId = me.roleId ?? assigned;
  const role = roleId === null ? null : roles.find((r) => r.id === roleId)?.name ?? null;
  return { name: me.displayName, role };
}

/** The branch's name from the pack's policies, when the pack carries one. */
export function branchOf(pack: StorePack): NavigationPayload['branch'] {
  if (!pack.policies.known) return null;
  const name = (pack.policies.value as { branchName?: unknown }).branchName;
  return typeof name === 'string' && name.trim() !== '' ? { name: name.trim() } : null;
}

/**
 * The permissions this box's role register gives a person on this branch — the union of every role assigned to them
 * here (or everywhere) — or null when the box has no role register to ask. Nothing is guessed: no register, no answer.
 */
export function permissionsOf(userId: string, pack: StorePack): readonly string[] | null {
  if (!pack.roles.known || !pack.roleAssignments.known) return null;
  const branchId = pack.policies.known ? pack.policies.value.branchId : null;
  const roles = new Map(rolesFrom(pack.roles.value).map((r) => [r.id, r.permissions] as const));
  const held = new Set<string>();
  for (const a of assignmentsFrom(pack.roleAssignments.value)) {
    if (a.userId !== userId) continue;
    if (a.branchScope !== 'all' && (branchId === null || !a.branchScope.includes(branchId))) continue;
    for (const permission of roles.get(a.roleId) ?? []) held.add(permission);
  }
  return [...held].sort();
}

/**
 * A screen's payload re-addressed to the person who SIGNED IN (OB-16, 5 Oct 2026). Behind the authenticated relay the
 * ERP screens run as that person — their id, the permissions this box's register gives them — not as whoever the
 * pack happened to name for the screen. The rule is narrow and stated: the payload's own `userId` and, where it
 * carries one, its `permissions`; the same for a direct child that carries BOTH (the floor's `indents` block). A
 * child that names a person without permissions (the warehouse `supervisor`, whose authority limit is their own)
 * is left as the pack said it. A screen the pack had nothing for stays nothing — the person still gets their rail.
 */
export function asSignedInPerson(payload: Record<string, unknown> | null, userId: string, pack: StorePack): Record<string, unknown> | null {
  if (payload === null) return null;
  const permissions = permissionsOf(userId, pack) ?? [];
  const readdress = (o: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...o, userId };
    if (Array.isArray(o['permissions'])) out['permissions'] = permissions;
    return out;
  };
  const out = readdress(payload);
  for (const [key, value] of Object.entries(payload)) {
    if (isRecord(value) && typeof value['userId'] === 'string' && Array.isArray(value['permissions'])) out[key] = readdress(value);
  }
  // PA-06 part 3b: the buying screen's buyer is the signed-in person, and never one of their own approvers (§28) — the
  // buyer is removed here, on the box, not trusted to leave themselves alone on the screen.
  if ('buyerId' in payload) {
    out['buyerId'] = userId;
    if (Array.isArray(payload['approvers'])) out['approvers'] = (payload['approvers'] as unknown[]).filter((who) => who !== userId);
  }
  return out;
}

/** The pack's untyped `roleAssignments` rows, kept only where they are whole. */
export function assignmentsFrom(rows: readonly unknown[]): RoleAssignment[] {
  const assignments: RoleAssignment[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const { userId, roleId, branchScope } = row;
    if (typeof userId !== 'string' || typeof roleId !== 'string') continue;
    if (branchScope !== 'all' && !isStringList(branchScope)) continue;
    assignments.push({ userId, roleId, branchScope });
  }
  return assignments;
}

/**
 * Who is looking at this screen, as its own payload says: `userId` at the top (most screens), or the supervisor's
 * on the warehouse oversight screen. Nothing else — a default here would offer somebody else's menu.
 */
export function viewerOf(payload: Record<string, unknown> | null): string | null {
  if (payload === null) return null;
  if (typeof payload['userId'] === 'string') return payload['userId'];
  const supervisor = payload['supervisor'];
  if (isRecord(supervisor) && typeof supervisor['userId'] === 'string') return supervisor['userId'];
  return null;
}

/** The catalogue items the store computer may offer: those it serves. Unserved and unbuilt items stay out. */
export const boxServedItems = (catalogue: readonly NavItem[] = ERP_NAVIGATION): NavItem[] =>
  catalogue.filter((item) => (item.served ?? 'box') === 'box');

export function navigationPayload(input: {
  readonly screen: ScreenName;
  readonly pack: StorePack;
  readonly payload: Record<string, unknown> | null;
  /** The box's own router: which screen a menu path opens (through its redirects), or null for none. */
  readonly screenOf: (path: string) => ScreenName | null;
  readonly catalogue?: readonly NavItem[];
}): NavigationPayload {
  const branchId = input.pack.policies.known ? input.pack.policies.value.branchId : null;
  const branch = branchOf(input.pack);
  const userId = viewerOf(input.payload);
  if (userId === null) return { userId: null, branchId, person: null, branch, why: 'no_user', groups: [] };
  const person = personOf(userId, input.pack);
  if (!input.pack.roles.known || !input.pack.roleAssignments.known) return { userId, branchId, person, branch, why: 'no_roles', groups: [] };

  const access = new AccessControl(rolesFrom(input.pack.roles.value), assignmentsFrom(input.pack.roleAssignments.value));
  const groups = navigationFor(access, { userId, branchId }, boxServedItems(input.catalogue ?? ERP_NAVIGATION));
  return {
    userId,
    branchId,
    person,
    branch,
    why: null,
    groups: groups.map((g) => ({
      group: NAV_GROUP_LABELS[g.group] ?? { en: g.group, ta: g.group },
      items: g.items.map((item) => ({
        id: item.id,
        label: { en: item.label, ta: item.labelTa },
        path: item.path,
        current: input.screenOf(item.path) === input.screen,
      })),
    })),
  };
}
