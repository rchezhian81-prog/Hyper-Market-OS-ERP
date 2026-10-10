// Head office's records behind a governed branch transition (PA-04 · M01-FR-04). Nothing here is new truth: every
// figure is READ from the record that already owns it, and the transition is written in ONE batch.
//
//   state      ← the org register (the branch's latest node version)
//   stock      ← the inventory ledger's weighted-average valuation, at every place under the branch (and its back store)
//   cash       ← each of the branch's tills' cash movements (the drawer balance), and whether a cashier still holds one
//   documents  ← purchase orders still due to deliver to the branch (Batch 2's `openDeliveriesFor`)
//   exceptions ← material till over/shorts at the branch nobody has signed off
//   unsent     ← what the store computer last reported it still holds unsent — and whether that report is fresh enough
//                (the store's own staleness setting) to vouch for; a missing or stale report is not a zero (P-08)
//   access     ← the effective grants limited to the branch
//
// The write: a new version of the branch's org node, the transition record (with the readiness it was decided on),
// and — for a permanent close — a `RoleRevoked` for every grant limited to the branch (and the same role re-granted
// for the OTHER branches a multi-branch grant also covered, so nobody loses more than this branch). Append-only.

import type { EventStore, BatchEntry } from '../../../packages/persistence/src/event-store';
import { makeEvent } from '../../../packages/contracts/src/event';
import { canActivate, GstRegister, type BranchReadiness, type BranchState, type OrgNode } from '../../../packages/org/src/index';
import { custodianOf, tillDrawerBalanceMinor } from '../../../packages/cash/src/index';
import type { BranchTransitionDeps, BranchTransitionRecord, RevokedBranchAccess } from '../../platform/src/branch-lifecycle';
import { branchOfLocationIn } from '../../inventory/src/location-scope';
import { openDeliveriesFor } from '../../purchase/src/purchase-orders';
import {
  STREAM, ROLE_GRANTED, ROLE_REVOKED, streamName, effectiveGrants, foldPurchaseOrders, orgNodeVersionEntry,
  orgStructureAdapter, inventoryAdapter, deviceRegistryAdapter, cashAdapter, shiftAdapter, heldVersionsAdapter,
  storeSettingsAdapter, approvalRequestsAdapter,
} from './adapters';

const STATE_OF: Readonly<Record<OrgNode['status'], BranchState>> = {
  draft: 'draft', active: 'open', suspended: 'temporarily_closed', closed: 'permanently_closed',
};
const TRANSITIONS_STREAM = (): string => streamName(STREAM.org, 'branch-transitions');

export function branchTransitionsAdapter(input: { readonly store: EventStore; readonly now: () => string }): BranchTransitionDeps {
  const { store, now } = input;
  const org = orgStructureAdapter({ store, now });

  const readAll = async (tenantId: string): Promise<BranchTransitionRecord[]> =>
    (await store.readStream(tenantId, TRANSITIONS_STREAM(), { type: 'BranchTransitioned' })).map((e) => e.event.payload as BranchTransitionRecord);

  return {
    now,
    approvals: approvalRequestsAdapter({ store, now }),

    branch: async (tenantId, branchId) => {
      const nodes = await org.nodes(tenantId);
      const node = nodes.find((n) => n.nodeId === branchId && n.kind === 'branch');
      if (node === undefined) return undefined;
      let configured = false;
      try {
        configured = canActivate(node, nodes.filter((n) => n.nodeId !== branchId), new GstRegister(await org.registrations(tenantId)));
      } catch { configured = false; }
      return { state: STATE_OF[node.status], configured };
    },

    readiness: async (tenantId, branchId, at): Promise<BranchReadiness> => {
      // ── where the branch's stock can be: every place under it, and the back store its settings name ──────────────
      const settings = await storeSettingsAdapter({ store }).settings(tenantId, branchId);
      const own = new Set([branchId, ...(settings?.warehouseId !== undefined && settings.warehouseId !== null ? [settings.warehouseId] : [])]);
      const placed = branchOfLocationIn(await org.nodes(tenantId));
      const branchOf = (locationId: string): string => (own.has(locationId) ? branchId : placed(locationId));

      // ── stock: quantity (any non-zero, either sign, counts) and value at weighted-average cost ───────────────────
      let stockUnits = 0; let stockMinor = 0;
      for (const row of await inventoryAdapter({ store, now }).valuation(tenantId)) {
        if (branchOf(row.locationId) !== branchId) continue;
        stockUnits += Math.abs(row.onHandMinor);
        stockMinor += row.value.minor;
      }

      // ── cash and open shifts: the branch's tills (its POS lanes in the fleet register) ───────────────────────────
      const fleet = await deviceRegistryAdapter({ store, now }).fleet(tenantId);
      const atBranch = fleet.filter((d) => d.branchId === branchId);
      const tills = atBranch.filter((d) => d.kind === 'pos_lane').map((d) => d.deviceId);
      const cash = cashAdapter({ store, now });
      let cashMinor = 0; let openShifts = 0;
      for (const tillId of tills) {
        const chain = await cash.tillMovements(tenantId, tillId);
        cashMinor += tillDrawerBalanceMinor(chain, tillId);
        if (custodianOf(chain, tillId) !== null) openShifts += 1;
      }

      // ── exceptions: a material over/short at one of the branch's tills that nobody has signed off ────────────────
      const shifts = shiftAdapter({ store, now });
      const reviewed = new Set((await shifts.overShortReviews(tenantId)).map((r) => r.shiftId));
      const unresolvedExceptions = (await shifts.overShortShifts(tenantId))
        .filter((r) => tills.includes(r.tillId) && !reviewed.has(r.shiftId)).length;

      // ── open documents: purchase orders still due to deliver here ──────────────────────────────────────────────
      const openDocuments = openDeliveriesFor([...(await foldPurchaseOrders(store, tenantId)).values()], branchId, branchOf).length;

      // ── unsent: the store computer's own word, if it is fresh enough to vouch for ─────────────────────────────────
      const held = await heldVersionsAdapter({ store }).heldVersions(tenantId, branchId);
      let unsentSyncItems = 0;
      let syncStateUnknown: string | undefined;
      if (held === undefined || held.unsentItems === undefined) {
        syncStateUnknown = 'the store computer has never reported how many records it still holds unsent';
      } else if (settings === undefined) {
        unsentSyncItems = held.unsentItems;
        syncStateUnknown = `the store has no settings, so there is no staleness limit to judge the computer's report of ${held.reportedAt} by`;
      } else {
        unsentSyncItems = held.unsentItems;
        const ageSeconds = Math.floor((Date.parse(at) - Date.parse(held.reportedAt)) / 1000);
        if (ageSeconds > settings.staleAfterSeconds) {
          syncStateUnknown = `the store computer last reported at ${held.reportedAt}, ${ageSeconds} seconds ago — older than the store's limit of ${settings.staleAfterSeconds}`;
        }
      }

      // ── access: everyone whose grant is limited to (or includes) this branch ────────────────────────────────────
      const grants = await effectiveGrants(store, tenantId);
      const activeUserCount = new Set(grants.filter((g) => g.branchScope !== 'all' && g.branchScope.includes(branchId)).map((g) => g.userId)).size;

      return {
        branchId,
        stockValue: { minor: stockMinor, currency: 'INR' },
        stockUnits,
        cashBalance: { minor: cashMinor, currency: 'INR' },
        openDocuments,
        unsentSyncItems,
        ...(syncStateUnknown === undefined ? {} : { syncStateUnknown }),
        openShifts,
        unresolvedExceptions,
        activeUserCount,
        devicesAssigned: atBranch.filter((d) => d.status !== 'retired').length,
      };
    },

    commit: async (tenantId, record, toNodeStatus) => {
      const node = (await org.nodes(tenantId)).find((n) => n.nodeId === record.branchId);
      if (node === undefined) throw new Error(`branch ${record.branchId} vanished from the org register mid-transition`);
      const entries: BatchEntry[] = [];
      const nodeEntry = await orgNodeVersionEntry(store, tenantId, { ...node, status: toNodeStatus }, record.at);
      if (nodeEntry !== undefined) entries.push(nodeEntry);

      const revoked: RevokedBranchAccess[] = [];
      if (record.toState === 'permanently_closed') {
        const limited = (await effectiveGrants(store, tenantId))
          .filter((g) => g.branchScope !== 'all' && g.branchScope.includes(record.branchId));
        const provenance = { kind: 'branch_transition', transitionId: record.transitionId, requestedBy: record.requestedBy, approvedBy: record.approvedBy, reason: record.reason };
        limited.forEach((g, i) => {
          const scope = g.branchScope as readonly string[];
          const keeps = scope.filter((b) => b !== record.branchId);
          revoked.push({ userId: g.userId, roleId: g.roleId, branchScope: scope, keeps });
          entries.push({ stream: STREAM.identity, event: makeEvent({
            id: `revoke-branch-close-${record.transitionId}-${i}`, type: ROLE_REVOKED, occurredAt: record.at,
            idempotencyKey: `revoke-${tenantId}-branch-close-${record.transitionId}-${i}`, source: 'api/platform',
            payload: { userId: g.userId, roleId: g.roleId, branchScope: scope, provenance },
          }) });
          if (keeps.length > 0) {
            entries.push({ stream: STREAM.identity, event: makeEvent({
              id: `grant-branch-close-${record.transitionId}-${i}`, type: ROLE_GRANTED, occurredAt: record.at,
              idempotencyKey: `grant-${tenantId}-branch-close-${record.transitionId}-${i}`, source: 'api/platform',
              payload: {
                userId: g.userId, roleId: g.roleId, branchScope: keeps,
                request: {
                  grantId: `branch-close-${record.transitionId}-${i}`, userId: g.userId, roleId: g.roleId, branchScope: keeps,
                  requestedBy: record.requestedBy, approvedBy: record.approvedBy, requestedAt: record.at,
                },
                provenance,
              },
            }) });
          }
        });
      }

      const kept: BranchTransitionRecord = { ...record, accessRevoked: revoked };
      entries.push({ stream: TRANSITIONS_STREAM(), event: makeEvent({
        id: `branch-transition-${record.transitionId}`, type: 'BranchTransitioned', occurredAt: record.at,
        idempotencyKey: `branch-transition-${tenantId}-${record.transitionId}`, source: 'api/platform', payload: kept,
      }) });
      await store.appendBatch(tenantId, entries);
      return kept;
    },

    transitions: async (tenantId, branchId) => (await readAll(tenantId)).filter((r) => r.branchId === branchId),
  };
}
