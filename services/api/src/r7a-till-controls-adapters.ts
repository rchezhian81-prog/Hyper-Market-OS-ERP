// R7-A · head office's wiring for the till's own controls (OB-500 · OB-501). Import and registration lines only in
// `main.ts`; every function here is a hook spread into an existing input there.
//
//   • OB-500 (M02-FR-02 value limits · M05-FR-02 "the check also holds offline") — the store pack's `tillControls`: each
//     product's FLOOR price at this store (its average buying cost lifted by the store's margin floor, rounded up — the
//     price guard's own rule; the cost itself is never sent) and each person's PRICE-CUT LIMIT at the till (the owner's money
//     limits, kind `price_override`, through the authority-limits engine). The till and the store computer refuse a cut
//     below the floor or above the approving manager's limit with no network; head office's sale intake re-checks every
//     lowered line it receives against the same rules (`tillOverrideRulesForSale`) and raises a visible exception.
//   • OB-501 (M33-FR-02 · D12-FR-03) — the store pack's `versionPolicy`: the version policy head office keeps
//     (services/platform/src/version-policy.ts). The till refuses to START a new bill on a withdrawn or too-old build; head
//     office's sale intake judges every sale's reported build by the same policy (`clientVersionPolicyOf`).
//
// Reads only. Nothing here changes a price, a limit or a version (P-05).

import type { EventStore } from '../../../packages/persistence/src/event-store';
import type { DurableTenantSettings } from '../../../packages/tenant/src/durable-settings';
import { AccessControl } from '../../../packages/rbac/src/rbac';
import { floorPriceMinor, type OverrideLimit, type TillControls } from '../../../packages/price-guard/src/till-override';
import type { VersionPolicy } from '../../../packages/platform-admin/src/devices';
import type { IncomingSale } from '../../pos/src/sale-intake';
import { averageBuyingCosts, catalogueAdapter, effectiveGrants, orgStructureAdapter, saleStockLocationOf, storeRulesAdapter, versionPolicyAdapter } from './adapters';
import { branchOfLocationIn } from '../../inventory/src/location-scope';
import { authorityOfAdapter } from './p1-identity-adapters';
import { OWNER_ROLE_ID, ROLE_CATALOGUE } from './roles';
import type { PackSigner } from '../../catalogue/src/pack';

interface Base { readonly store: EventStore; readonly now: () => string; readonly settings: DurableTenantSettings; readonly signer: PackSigner }

/** The permission a manager needs to approve a till price cut (edge/store-edge/src/till-approvals.ts `OVERRIDE_AUTHORITY`). */
export const TILL_OVERRIDE_AUTHORITY = 'pos.override.approve';

/** One person's price-cut limit, from the owner's money limits (kind `price_override`). */
async function limitOf(input: Base, tenantId: string, userId: string): Promise<OverrideLimit & { readonly version: number }> {
  const a = await authorityOfAdapter(input)(tenantId, userId, 'price_override');
  if (a.state === 'unlimited') return { state: 'unlimited', limitMinor: null, version: a.rulesVersion };
  if (a.state === 'limit') return { state: 'limit', limitMinor: a.limitMinor ?? 0, version: a.rulesVersion };
  return { state: 'not_set', limitMinor: null, version: a.rulesVersion };
}

/** Each product's floor at this store: its average buying cost there, lifted by the store's margin floor (0 when not set). */
export async function floorsAt(input: Base, tenantId: string, storeId: string, productIds: readonly string[]): Promise<{ floors: Record<string, number>; notKnown: string[] }> {
  const bps = (await storeRulesAdapter({ store: input.store }).rules(tenantId, storeId))?.marginFloorBps ?? 0;
  const costs = await averageBuyingCosts({ store: input.store, now: input.now }, tenantId);
  const floors: Record<string, number> = {};
  const notKnown: string[] = [];
  for (const productId of productIds) {
    const cost = costs.costOf(productId, storeId);
    if (cost === undefined || !Number.isSafeInteger(cost) || cost < 0) notKnown.push(productId);
    else floors[productId] = floorPriceMinor(cost, bps);
  }
  return { floors, notKnown: notKnown.sort() };
}

/**
 * OB-500: the store pack's `tillControls` for ONE store — the floor of every product head office published, and the
 * price-cut limit of every person whose grants reach this store with the till-override authority.
 */
export function tillControlsPackSectionOf(input: Base) {
  return async (tenantId: string, storeId: string): Promise<TillControls> => {
    const published = await catalogueAdapter({ store: input.store, now: input.now, signer: input.signer }).currentPack(tenantId);
    const { floors, notKnown } = await floorsAt(input, tenantId, storeId, (published?.snapshot.products ?? []).map((p) => p.productId));
    const grants = (await effectiveGrants(input.store, tenantId)).filter((g) => g.branchScope === 'all' || (Array.isArray(g.branchScope) && g.branchScope.includes(storeId)));
    const access = new AccessControl(ROLE_CATALOGUE, grants);
    const approvers = [...new Set(grants.map((g) => g.userId))].filter((u) => access.can({ userId: u, permission: TILL_OVERRIDE_AUTHORITY, branchId: storeId })).sort();
    const overrideLimits: Record<string, OverrideLimit> = {};
    let limitsVersion = 0;
    for (const userId of approvers) {
      const l = await limitOf(input, tenantId, userId);
      overrideLimits[userId] = { state: l.state, limitMinor: l.limitMinor };
      limitsVersion = l.version;
    }
    // OB-520: the approvers who hold the OWNER role at this store — the only ones who may cut a product with no known floor.
    const ownerApprovers = approvers.filter((u) => grants.some((g) => g.userId === u && g.roleId === OWNER_ROLE_ID));
    return { floors, floorsNotKnown: notKnown, overrideLimits, limitsVersion, ownerApprovers };
  };
}

/** OB-501: the version policy head office keeps, for the store pack — `undefined` when none has been set (nothing enforced). */
export function versionPolicyPackSectionOf(input: Pick<Base, 'store' | 'now'>) {
  const adapter = versionPolicyAdapter(input);
  return async (tenantId: string): Promise<VersionPolicy | undefined> => adapter.policy(tenantId);
}

/** OB-501: the same policy for head office's sale intake. */
export const clientVersionPolicyOf = versionPolicyPackSectionOf;

/**
 * OB-500: for a sale with lowered lines, the floor of each lowered product at the store it was rung at and the price-cut
 * limit of each manager named as approving one — what head office's intake re-checks. A sale with no lowered line reads
 * nothing (the costs are read only when needed).
 */
export function tillOverrideRulesForSale(input: Base) {
  return async (tenantId: string, sale: IncomingSale): Promise<{ readonly floors: ReadonlyMap<string, number>; readonly limits: ReadonlyMap<string, OverrideLimit>; readonly floorsNotKnown: ReadonlySet<string>; readonly owners: ReadonlySet<string> } | undefined> => {
    const lowered = sale.lines.filter((l) => l.priceOverride !== undefined);
    if (lowered.length === 0) return undefined;
    const where = await saleStockLocationOf(input.store, tenantId, sale);
    const nodes = await orgStructureAdapter({ store: input.store, now: input.now }).nodes(tenantId);
    const storeId = where.basis === 'unplaced' ? undefined : branchOfLocationIn(nodes)(where.locationId);
    const floors = new Map<string, number>();
    // OB-520: the lowered products with no known floor at that store (only judged when the store is known — an unplaced
    // sale is not told "no floor", it is simply not re-judged on the floor).
    const floorsNotKnown = new Set<string>();
    if (storeId !== undefined) {
      const f = await floorsAt(input, tenantId, storeId, [...new Set(lowered.map((l) => l.productId))]);
      for (const [p, minor] of Object.entries(f.floors)) floors.set(p, minor);
      for (const p of f.notKnown) floorsNotKnown.add(p);
    }
    const grants = await effectiveGrants(input.store, tenantId);
    const owners = new Set(grants.filter((g) => g.roleId === OWNER_ROLE_ID && (storeId === undefined || g.branchScope === 'all' || (Array.isArray(g.branchScope) && g.branchScope.includes(storeId)))).map((g) => g.userId));
    const limits = new Map<string, OverrideLimit>();
    for (const approver of new Set(lowered.map((l) => (typeof l.priceOverride?.approvedBy === 'string' ? l.priceOverride.approvedBy.trim() : '')).filter((a) => a !== ''))) {
      const l = await limitOf(input, tenantId, approver);
      limits.set(approver, { state: l.state, limitMinor: l.limitMinor });
    }
    return { floors, limits, floorsNotKnown, owners };
  };
}
