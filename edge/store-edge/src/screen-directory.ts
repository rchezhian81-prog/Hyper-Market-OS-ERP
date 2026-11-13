// U2 · G5/G16 of the UI/UX gap audit (2 Nov 2026): the store computer tells every office page WHO and WHERE from its
// SIGNED store pack, so a page can let a person PICK a colleague or a place by name and SHOW a name wherever it used to
// show an id (`u-cash`, `Asia/Kolkata`) — with head office down (P-01), because the pack is on the box. Nothing here is
// a figure, and nothing is guessed: a register the pack does not hold is an empty list, said as such, never invented.
//
// The payload rides beside `sreNavigation` and `shopTimeZone` as `window.sreDirectory` (screen-server.ts) and is read
// by the chrome (`sreOffice.pick`, `nameOf`, `me`). It names only what the person could already see on this box:
// the store's own people and places, the store itself, and the person signed in.

import type { StorePack, PackWarehouse } from './store-pack';
import { peopleFrom, permissionsOf, assignmentsFrom, rolesFrom } from './screen-navigation';
import { packTimeZone } from './shop-zone';

export interface DirectoryPerson { readonly id: string; readonly name: string; readonly roleId: string | null }
export interface DirectoryPlace { readonly id: string; readonly name: string; readonly kind: 'store' | 'warehouse' | 'bin'; readonly zone?: string }
/** U7: a role the shop gives, by name in both languages where the pack carries the Tamil name (OB-699). */
export interface DirectoryRole { readonly id: string; readonly name: string; readonly nameTa?: string }
export interface DirectoryMe { readonly userId: string; readonly name: string; readonly roleIds: readonly string[]; readonly permissions: readonly string[] }

export interface DirectoryPayload {
  readonly store: { readonly id: string; readonly name: string } | null;
  readonly timeZone: string;
  readonly me: DirectoryMe | null;
  readonly people: readonly DirectoryPerson[];
  readonly places: readonly DirectoryPlace[];
  /** U7: the roles the pack's register holds — the picker's `role` kind (who a procedure is for, several at once). */
  readonly roles: readonly DirectoryRole[];
  /** Which registers the pack really held — a page says "not known" for a list the box was never given. */
  readonly known: { readonly people: boolean; readonly places: boolean; readonly store: boolean; readonly roles: boolean };
}

const binName = (bin: PackWarehouse['bins'][number]): string => (typeof bin.zone === 'string' ? `${bin.binId} (${bin.zone})` : bin.binId);

/** The directory for the office pages on this box, for the person signed in (or nobody). */
export function directoryPayload(pack: StorePack, signedIn: string | null): DirectoryPayload {
  // A pack section is read defensively: an older pack (or one head office built without a field) must never make a
  // page fail to serve — a missing name is the id, a missing warehouse is no warehouse.
  const policies = pack.policies.known ? pack.policies.value : null;
  const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const storeId = text(policies?.storeId);
  const store = policies === null || storeId === '' ? null : { id: storeId, name: text(policies.branchName) === '' ? storeId : text(policies.branchName) };
  const warehouseId = text(policies?.warehouseId);
  const people: DirectoryPerson[] = pack.people.known && Array.isArray(pack.people.value)
    ? peopleFrom(pack.people.value).map((p) => ({ id: p.userId, name: p.displayName, roleId: p.roleId }))
    : [];
  const places: DirectoryPlace[] = [];
  if (store !== null) places.push({ id: store.id, name: store.name, kind: 'store' });
  if (warehouseId !== '' && warehouseId !== store?.id) places.push({ id: warehouseId, name: warehouseId, kind: 'warehouse' });
  if (pack.warehouse.known && Array.isArray(pack.warehouse.value?.bins)) {
    for (const bin of pack.warehouse.value.bins) { if (typeof bin?.binId !== 'string' || bin.binId === '') continue; places.push({ id: bin.binId, name: binName(bin), kind: 'bin', ...(typeof bin.zone === 'string' ? { zone: bin.zone } : {}) }); }
  }
  const roleRows = pack.roles.known && Array.isArray(pack.roles.value) ? pack.roles.value : [];
  const tamilOf = new Map<string, string>();
  for (const r of roleRows) { if (r && typeof r === 'object' && typeof (r as { id?: unknown }).id === 'string' && typeof (r as { nameTa?: unknown }).nameTa === 'string') tamilOf.set((r as { id: string }).id, (r as { nameTa: string }).nameTa); }
  const roles: DirectoryRole[] = rolesFrom(roleRows).map((r) => ({ id: r.id, name: r.name, ...(tamilOf.has(r.id) ? { nameTa: tamilOf.get(r.id)! } : {}) }));
  let me: DirectoryMe | null = null;
  if (signedIn !== null) {
    const roleIds = pack.roleAssignments.known && Array.isArray(pack.roleAssignments.value) ? assignmentsFrom(pack.roleAssignments.value).filter((a) => a.userId === signedIn).map((a) => a.roleId) : [];
    me = { userId: signedIn, name: people.find((p) => p.id === signedIn)?.name ?? signedIn, roleIds, permissions: permissionsOf(signedIn, pack) ?? [] };
  }
  return {
    store, timeZone: packTimeZone(pack), me, people, places, roles,
    known: { people: pack.people.known, places: pack.warehouse.known || store !== null, store: store !== null, roles: pack.roles.known && roles.length > 0 },
  };
}
