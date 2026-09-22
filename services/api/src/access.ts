// Per-tenant authorization, wired to the authoritative event source (M02-FR-02, SEC-03, P-04,
// ADR-0003). The production API composes the kernel with THIS resolver instead of a global,
// empty `AccessControl`: for each request the kernel asks for the caller's tenant, and this reads
// that tenant's own `RoleGranted` history from the event ledger and folds it into a default-deny
// `AccessControl` over the product's role catalogue. Authority is therefore (a) scoped to one
// tenant, (b) taken from the append-only ledger, not a table someone populated by hand, and
// (c) default-deny — a tenant with no grants authorises nothing (fail closed).
//
// Bootstrap: because granting a role itself needs `identity.role.grant` (maker-checker), a brand-new
// tenant has nobody who can grant the first role. `seedGenesisOwner` records the ONE genesis owner
// grant — and only when the tenant has no grants at all, so it can create the first owner exactly
// once and can never widen anyone thereafter. It is an audited `RoleGranted` event like any other,
// not a bypass of the authorization check.

import type { EventStore, PersistedEvent } from '../../../packages/persistence/src/event-store';
import { AccessControl, type Role, type RoleAssignment } from '../../../packages/rbac/src/rbac';
import { makeEvent } from '../../../packages/contracts/src/event';
import { STREAM } from './adapters';

interface GrantPayload {
  readonly userId: string;
  readonly roleId: string;
  readonly branchScope: readonly string[] | 'all';
}

function assignmentOf(e: PersistedEvent): RoleAssignment {
  const p = e.event.payload as GrantPayload;
  return { userId: p.userId, roleId: p.roleId, branchScope: p.branchScope };
}

/**
 * A per-tenant access resolver for the kernel. Reads the tenant's `RoleGranted` events and folds
 * them into a default-deny `AccessControl` over the given role catalogue.
 *
 * Read every request, deliberately: authority must reflect the current grants, a stale cache is a
 * revoked administrator who still has the keys. The identity stream is small (role changes are rare
 * and human-paced); a freshness-versioned cache is a later optimisation, not a correctness need.
 */
export function tenantAccessResolver(
  store: EventStore,
  roleCatalogue: readonly Role[],
): (tenantId: string) => Promise<AccessControl> {
  return async (tenantId) => {
    const grants = await store.readStream(tenantId, STREAM.identity, { type: 'RoleGranted' });
    return new AccessControl(roleCatalogue, grants.map(assignmentOf));
  };
}

/**
 * A per-tenant FEATURE-ENTITLEMENT resolver for the kernel (M36-FR-01 · §35). Reads the tenant's
 * `TenantEntitlementSet` events and folds them into the set of optional/paid features currently ON —
 * latest change per feature wins, DEFAULT OFF. The kernel refuses a route that names an `entitlement`
 * the tenant has not enabled, so a paid feature the shop did not buy is off even for a user who holds
 * the permission.
 *
 * This is the SAME fold `platformAdapter().entitlements` serves the `/v1/platform/entitlements` routes
 * from, so enabling a feature through that API turns its routes on. Read every request, like access:
 * a stale cache is a feature a lapsed plan still reaches. Default-deny survives — a tenant with no
 * entitlement history reaches no optional-feature route (fail closed).
 */
export function tenantEntitlementResolver(
  store: EventStore,
): (tenantId: string) => Promise<readonly string[]> {
  return async (tenantId) => {
    const changes = await store.readStream(tenantId, STREAM.platform, { type: 'TenantEntitlementSet' });
    const state = new Map<string, boolean>();
    for (const e of changes) {
      const p = e.event.payload as { feature: string; enabled: boolean };
      state.set(p.feature, p.enabled);
    }
    return [...state.entries()].filter(([, on]) => on).map(([feature]) => feature);
  };
}

export type GenesisOutcome = 'seeded' | 'already_bootstrapped';

/**
 * Record the genesis owner for a tenant — the first authority, from which every other grant is
 * later made under maker-checker. Refuses if the tenant already has ANY grant, so it establishes
 * the first owner once and never escalates anyone afterwards. Recorded as an audited `RoleGranted`
 * event with genesis provenance.
 */
export async function seedGenesisOwner(
  store: EventStore,
  ownerRoleId: string,
  tenantId: string,
  ownerUserId: string,
  at: string,
): Promise<GenesisOutcome> {
  const existing = await store.readStream(tenantId, STREAM.identity, { type: 'RoleGranted' });
  if (existing.length > 0) return 'already_bootstrapped';

  const assignment: RoleAssignment = { userId: ownerUserId, roleId: ownerRoleId, branchScope: 'all' };
  await store.append(tenantId, STREAM.identity, makeEvent({
    id: `grant-genesis-${tenantId}`,
    type: 'RoleGranted',
    occurredAt: at,
    idempotencyKey: `grant-${tenantId}-genesis`,
    source: 'system/genesis',
    // The same shape a normal grant records: the assignment RBAC reads, plus who asked and approved
    // — here the system itself, marked as genesis so an access review a year later can see it for
    // what it was.
    payload: {
      ...assignment,
      request: {
        grantId: 'genesis', userId: ownerUserId, roleId: ownerRoleId, branchScope: 'all',
        requestedBy: 'system:genesis', approvedBy: 'system:genesis', requestedAt: at,
      },
    },
  }));
  return 'seeded';
}
