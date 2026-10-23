// Till bill and GST package (OB-288 builders · audit-1 P5: A2, A7, A8, A12, A22 · audit-2 P3: M12-FR-01, M12-FR-02,
// M13-FR-02, M14-FR-04, B8, B10, B12) — head office's wiring for it.
//
// Composition: `tillBillSurface(surface, …)` is the one line in `main.ts`. It adds this package's routes to the surface;
// the stores live in `till-bill-stores.ts`, which `adapters.ts` reads with one registration line where the catalogue pack
// assembly needs them. No route here is new permission: each reuses the code its family already gates by.

import type { EventStore } from '../../../packages/persistence/src/event-store';
import type { Route } from '../../kernel/src/index';
import { cessRateRoutes } from '../../catalogue/src/cess-rates';
import { cessRateStore } from './till-bill-stores';
import { orgStructureAdapter } from './adapters';
import { branchOfLocationIn } from '../../inventory/src/location-scope';
import { gstStateOf } from '../../../packages/finance/src/gst-states';

/**
 * A8: the supplier's own GST State for a B2B order — the State of the GSTIN of the store the order is dispatched from (its
 * location's branch), else, when the business has exactly ONE GST registration, that registration's State. Undefined when
 * neither is on record: the invoice then carries no split and says why, rather than a guessed one (P-08).
 */
export function supplierStateCodeOf(input: { readonly store: EventStore; readonly now: () => string }): (tenantId: string, locationId: string | undefined) => Promise<string | undefined> {
  return async (tenantId, locationId) => {
    const org = orgStructureAdapter(input);
    const nodes = await org.nodes(tenantId);
    const branchId = locationId === undefined ? undefined : branchOfLocationIn(nodes)(locationId);
    const branch = branchId === undefined ? undefined : nodes.find((n) => n.nodeId === branchId);
    const fromStore = typeof branch?.gstin === 'string' ? gstStateOf(branch.gstin)?.code : undefined;
    if (fromStore !== undefined) return fromStore;
    const registrations = await org.registrations(tenantId);
    return registrations.length === 1 ? gstStateOf(registrations[0]!.gstin)?.code : undefined;
  };
}

export function tillBillSurface(surface: Route[], input: { readonly store: EventStore | undefined; readonly now: () => string }): void {
  const { store, now } = input;
  // A7: the compensation-cess schedule per HSN — what the pack carries to the tills, signed.
  surface.push(...cessRateRoutes(store === undefined ? { setCess: () => {}, schedule: () => [] } : cessRateStore({ store, now })));
}
