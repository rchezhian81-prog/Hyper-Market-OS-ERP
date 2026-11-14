// CR-01 step 4a · ADR-0033: the stores behind the box-relay privilege routes (services/identity/src/box-privilege.ts).
//
//   • the ONE-USE list of privilege request ids — an append-only fact per id, keyed so the same id can be written once only:
//     the first relay of an id is accepted, every later one (another key, another moment) is refused as already used;
//   • the OWNER ALERT for an accepted change (P-03 · ADR-0033 §5) — raised once per request on the shop's alert log, to the
//     shop's owners, saying who did what, when, and who approved it.

import type { EventStore } from '../../../packages/persistence/src/event-store';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { AlertLifecycleEvent } from '../../platform/src/alert-lifecycle';
import type { BoxPrivilegeDeps, PrivilegeChangeAlert } from '../../identity/src/box-privilege';
import { privilegeAlertWords } from '../../identity/src/box-privilege';
import { STREAM, streamName, alertLifecycleAdapter, effectiveGrants, rolesHeldNow } from './adapters';
import { OWNER_ROLE_ID } from './roles';

export const PRIVILEGE_REQUESTS_STREAM = streamName(STREAM.identity, 'box-privilege-requests');

/** The alert id of one privilege change: one alert per request, never per pass. */
export const privilegeAlertIdOf = (requestId: string): string => `privilege-change:${requestId}`;

export function boxPrivilegeAdapter(input: { readonly store: EventStore; readonly now: () => string }): Omit<BoxPrivilegeDeps, 'identity' | 'privilegeSealKey'> {
  const { store, now } = input;
  return {
    now,
    spendRequestId: async (tenantId, use) => {
      const out = await store.append(tenantId, PRIVILEGE_REQUESTS_STREAM, makeEvent({
        id: `box-privilege-request-${use.requestId}`, type: 'BoxPrivilegeRequestUsed', occurredAt: use.at,
        idempotencyKey: `box-privilege-request-${tenantId}-${use.requestId}`, source: 'api/identity',
        payload: use,
      }));
      return out.deduped ? 'used' : 'first';
    },
    rolesHeldBy: (tenantId, userId) => rolesHeldNow(store, tenantId, userId, now()),
    raiseOwnerAlert: async (tenantId: string, a: PrivilegeChangeAlert) => {
      const owners = [...new Set((await effectiveGrants(store, tenantId)).filter((g) => g.roleId === OWNER_ROLE_ID).map((g) => g.userId))].sort();
      const owner = owners[0] ?? 'owner';
      const alertId = privilegeAlertIdOf(a.requestId);
      const event: AlertLifecycleEvent = {
        alertId, change: 'raised', by: `system:box-privilege:${a.relayedBy}`, at: a.at,
        alert: {
          alertId, component: `Privilege change on the store PC (${a.kind === 'role_request' ? 'role asked for' : 'role approved'})`,
          status: 'degraded', ownerUserId: owner, ownerName: owner, detail: privilegeAlertWords(a),
          raisedAt: a.at, ackDueBy: a.at, ...(owners.length > 1 ? { alsoToUserIds: owners.slice(1) } : {}),
        },
      };
      await alertLifecycleAdapter({ store, now }).recordAlertEvent(tenantId, event, `${alertId}|raised|1`);
    },
  };
}
