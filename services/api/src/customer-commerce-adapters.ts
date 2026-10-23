// OB-288 wave 3 · customer, loyalty, CRM and the online cart — head office's wiring for this package. One line in
// `main.ts` calls `customerCommerceSurface(surface, …)`; everything below adds routes or rebuilds an existing route in
// place with more of the shop's own facts behind it. Each rebuilt route keeps its path and permission; a target route
// that is missing throws at start-up — a step that silently does not happen is the failure P-08 forbids.
//
//   • M16-FR-04 — the customer's record shows the service desk's own cases (complaints first), and segmentation counts
//     the complaints the desk actually recorded, not only ones typed in by hand.

import type { EventStore } from '../../../packages/persistence/src/event-store';
import type { Route } from '../../kernel/src/index';
import { customer360Routes, complaintFactsOf, type ServiceCaseFact } from '../../customer/src/customer-360';
import { segmentRoutes } from '../../customer/src/segments';
import type { ComplaintFact } from '../../../packages/customer/src/index';
import { customer360Adapter, segmentDataAdapter, serviceCaseAdapter } from './adapters';
import { customerOverviewRoutes } from '../../customer/src/customer-overview';
import { customerOverviewAdapter } from './r4-insight-adapters';

export interface CustomerCommerceInput {
  readonly store: EventStore | undefined;
  readonly now: () => string;
}

function replace(surface: Route[], method: string, path: string, change: (r: Route) => Route): void {
  const at = surface.findIndex((r) => r.method === method && r.path === path);
  if (at < 0) throw new Error(`customer-commerce wiring cannot find ${method} ${path} — the step it adds would silently not happen`);
  surface[at] = change(surface[at]!);
}

/** Every route of `fresh` replaces the route with the same method and path on the surface (keeping its permission). */
function rebuildInPlace(surface: Route[], fresh: readonly Route[], only?: (r: Route) => boolean): void {
  for (const f of fresh) {
    if (only !== undefined && !only(f)) continue;
    replace(surface, f.method, f.path, (r) => ({ ...f, permission: r.permission, ...(r.entitlement === undefined ? {} : { entitlement: r.entitlement }) }));
  }
}

// ── M16-FR-04 · the service desk's cases on the customer's record ───────────────────────────────────────────────────

/** The desk's cases naming one customer, as the record shows them. */
export function casesOfCustomer(input: { readonly store: EventStore; readonly now: () => string }) {
  return async (tenantId: string, customerRef: string): Promise<readonly ServiceCaseFact[]> =>
    (await serviceCaseAdapter(input).serviceCases(tenantId))
      .filter((c) => c.customerRef === customerRef)
      .map((c): ServiceCaseFact => ({
        caseId: c.caseId, customerRef: c.customerRef, kind: c.kind, state: c.state, priority: c.priority, summary: c.summary, openedAt: c.openedAt,
        ...(c.orderRef === undefined ? {} : { orderRef: c.orderRef }),
        ...(c.resolvedAt === undefined ? {} : { resolvedAt: c.resolvedAt }),
        ...(c.resolution === undefined ? {} : { resolution: c.resolution }),
      }));
}

/** The complaint facts segmentation reads: the ones typed in (kept) and the desk's own complaints, one per case. */
export function complaintFactsWithCases(input: { readonly store: EventStore; readonly now: () => string }) {
  return async (tenantId: string): Promise<readonly ComplaintFact[]> => {
    const typed = await segmentDataAdapter(input).complaintFacts(tenantId);
    const fromDesk = complaintFactsOf(await serviceCaseAdapter(input).serviceCases(tenantId));
    const seen = new Set(typed.map((c) => c.caseId));
    return [...typed, ...fromDesk.filter((c) => !seen.has(c.caseId))];
  };
}

/** The package on the head-office surface. Called once by `buildSurface`, before the API manifest is taken. */
export function customerCommerceSurface(surface: Route[], input: CustomerCommerceInput): void {
  const { store, now } = input;
  if (store !== undefined) {
    const base = { store, now };
    // M16-FR-04: the record shows the desk's cases; segments count the desk's complaints.
    rebuildInPlace(surface, customer360Routes({ ...customer360Adapter(base), casesOf: casesOfCustomer(base) }), (r) => r.path === '/v1/customers/:customerRef/profile');
    rebuildInPlace(surface, segmentRoutes({
      now, ...segmentDataAdapter(base),
      orderFacts: async (t: string) => { await customer360Adapter(base).catchUp(t); return segmentDataAdapter(base).orderFacts(t); },
      complaintFacts: complaintFactsWithCases(base),
    }), (r) => r.method === 'GET');
    rebuildInPlace(surface, customerOverviewRoutes({ ...customerOverviewAdapter(base), complaintFacts: complaintFactsWithCases(base) }));
  }
}
