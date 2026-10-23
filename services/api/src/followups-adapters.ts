// OB-288 integration follow-ups — the seams between the five finished lanes (recall/trace, gates/scans, store-box offline
// queues, procure-to-pay, identity/authority), closed on the owner's decisions of 23 Oct 2026. Head-office wiring only:
// each rule is in its own tested engine; this file hands one lane's port to another. Registered from main.ts with one
// spread per seam.

import type { EventStore } from '../../../packages/persistence/src/event-store';
import type { DurableTenantSettings } from '../../../packages/tenant/src/durable-settings';
import type { PurchaseOrderDeps } from '../../purchase/src/purchase-orders';
import { authorityOfAdapter } from './p1-identity-adapters';

/**
 * OB-290 · M02-FR-02 — procure-to-pay's purchase-order limit IS identity's server-held rule: the raiser's limit decides
 * whether an order is theirs or goes to the owner, and the approver's limit decides whether they may issue it. Both read
 * the owner's versioned limits table through the one `authorityOf` port (never a figure in a request, never a default
 * kept in the purchasing code).
 */
export function poAuthorityHooks(input: { readonly store: EventStore; readonly now: () => string; readonly settings: DurableTenantSettings }): Pick<PurchaseOrderDeps, 'authorityOf'> {
  return { authorityOf: authorityOfAdapter(input) };
}
