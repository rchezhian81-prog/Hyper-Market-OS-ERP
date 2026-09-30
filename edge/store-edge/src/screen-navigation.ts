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
  const userId = viewerOf(input.payload);
  if (userId === null) return { userId: null, branchId, why: 'no_user', groups: [] };
  if (!input.pack.roles.known || !input.pack.roleAssignments.known) return { userId, branchId, why: 'no_roles', groups: [] };

  const access = new AccessControl(rolesFrom(input.pack.roles.value), assignmentsFrom(input.pack.roleAssignments.value));
  const groups = navigationFor(access, { userId, branchId }, boxServedItems(input.catalogue ?? ERP_NAVIGATION));
  return {
    userId,
    branchId,
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
