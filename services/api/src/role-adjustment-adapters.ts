// CR-01 step 4c-1 · ADR-0034: the stores behind the role-adjustment routes (services/identity/src/role-adjustments.ts).
//
//   • each change is ONE `RolePermissionAdjusted` event on the identity ledger, keyed by its request id so it is written
//     once — never an overwrite (hard rule 2); `effectiveRoleCatalogue` folds them for every reader;
//   • the OWNER ALERT for an applied change (P-03) — on the shop's alert log, to every owner, saying who asked, who
//     approved, what changed for which role, and how many people it reaches.

import type { EventStore } from '../../../packages/persistence/src/event-store';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { AlertLifecycleEvent } from '../../platform/src/alert-lifecycle';
import { ROLE_PERMISSION_ADJUSTED, type RoleAdjustmentAlert, type RoleAdjustmentDeps } from '../../identity/src/role-adjustments';
import { STREAM, alertLifecycleAdapter, effectiveGrants, effectiveRoleCatalogue, permissionsOfRoles, roleAdjustmentsOf, rolesHeldNow } from './adapters';
import { OWNER_ROLE_ID, ROLE_ADJUSTMENT_POLICY, ROLE_CATALOGUE } from './roles';

/** The alert id for an applied change — one per request. */
export const roleAdjustmentAlertIdOf = (requestId: string): string => `role-permission-change:${requestId}`;

/** The owner's alert, in plain words. */
export function roleAdjustmentAlertWords(a: RoleAdjustmentAlert): string {
  const what = a.change === 'add' ? `switched ON "${a.permission}" for the role "${a.roleName}"` : `switched OFF "${a.permission}" for the role "${a.roleName}"`;
  const reach = a.affectedPeople.length === 0 ? 'Nobody holds that role now.' : `It reaches ${a.affectedPeople.length} ${a.affectedPeople.length === 1 ? 'person' : 'people'}: ${a.affectedPeople.join(', ')}.`;
  return `${a.requestedBy} asked and ${a.approvedBy} approved: ${what}. Reason: ${a.reason}. ${reach} It applies at head office now and on the tills with the next store pack. To undo it, make the opposite change the same way.`;
}

export function roleAdjustmentAdapter(input: { readonly store: EventStore; readonly now: () => string }): Omit<RoleAdjustmentDeps, 'approvals' | 'recordAudit'> {
  const { store, now } = input;
  return {
    now,
    builtInRoles: ROLE_CATALOGUE,
    policy: ROLE_ADJUSTMENT_POLICY,
    roles: (tenantId) => effectiveRoleCatalogue(store, tenantId),
    adjustments: (tenantId) => roleAdjustmentsOf(store, tenantId),
    recordAdjustment: async (tenantId, a) => {
      await store.append(tenantId, STREAM.identity, makeEvent({
        id: `role-permission-adjusted-${a.requestId}`, type: ROLE_PERMISSION_ADJUSTED, occurredAt: a.at,
        idempotencyKey: `role-permission-adjusted-${tenantId}-${a.requestId}`, source: 'api/identity', payload: a,
      }));
    },
    holdersOf: async (tenantId, roleId) => (await effectiveGrants(store, tenantId))
      .filter((g) => g.roleId === roleId).map((g) => ({ userId: g.userId, branchScope: g.branchScope })),
    rolesHeldBy: (tenantId, userId) => rolesHeldNow(store, tenantId, userId, now()),
    permissionsOf: async (tenantId, userId) => permissionsOfRoles(store, tenantId, new Set(await rolesHeldNow(store, tenantId, userId, now()))),
    raiseOwnerAlert: async (tenantId, a) => {
      const owners = [...new Set((await effectiveGrants(store, tenantId)).filter((g) => g.roleId === OWNER_ROLE_ID).map((g) => g.userId))].sort();
      const owner = owners[0] ?? 'owner';
      const alertId = roleAdjustmentAlertIdOf(a.requestId);
      const event: AlertLifecycleEvent = {
        alertId, change: 'raised', by: `system:role-permission-change:${a.requestedBy}`, at: a.at,
        alert: {
          alertId, component: `What a role may do was changed (${a.roleName})`,
          status: 'degraded', ownerUserId: owner, ownerName: owner, detail: roleAdjustmentAlertWords(a),
          raisedAt: a.at, ackDueBy: a.at, ...(owners.length > 1 ? { alsoToUserIds: owners.slice(1) } : {}),
        },
      };
      await alertLifecycleAdapter({ store, now }).recordAlertEvent(tenantId, event, `${alertId}|raised|1`);
    },
  };
}
