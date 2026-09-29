// Customer-scoped access to orders — M20 (customer app), §35, hard rule #6, P-04.
//
// A customer signed into the storefront may see and act on ITS OWN orders and nothing else. "Its own" is
// decided from what the order RECORDS about who placed it (`customerRef`, written at placement from the
// authenticated subject — never from a reference in the request), the same way the supplier portal scopes a
// supplier to its partner binding (M24-FR-01). A request for someone else's order — or for a staff-placed
// order that has no customer at all — is a SECURITY EVENT: refused, and recorded so a pattern of probing is
// visible (hard rule #6), never quietly answered with an empty screen.

export interface CustomerScopedOrder {
  readonly orderId: string;
  /** Who placed the order through the storefront. Absent on an order staff placed at the desk. */
  readonly customerRef?: string;
}

export type ScopeOutcome =
  /** The caller's own order. */
  | 'own'
  /** No order of that id exists — a plain 404, not a security event. */
  | 'unknown'
  /** Another customer's order: refused and recorded. */
  | 'not_your_order'
  /** An order staff placed at the desk, with no customer on it: not the caller's to see; refused and recorded. */
  | 'not_a_storefront_order';

export interface ScopeDecision {
  readonly outcome: ScopeOutcome;
  readonly allowed: boolean;
  /** Whether this attempt goes on the security register (hard rule #6). */
  readonly securityEvent: boolean;
  readonly detail: string;
}

export function scopeOrderToCustomer(input: {
  readonly order: CustomerScopedOrder | undefined;
  readonly customerRef: string;
}): ScopeDecision {
  if (input.order === undefined) {
    return { outcome: 'unknown', allowed: false, securityEvent: false, detail: 'no order of that id has been placed' };
  }
  if (input.order.customerRef === undefined) {
    return { outcome: 'not_a_storefront_order', allowed: false, securityEvent: true, detail: `order "${input.order.orderId}" was placed at the desk and belongs to no storefront customer` };
  }
  if (input.order.customerRef !== input.customerRef) {
    return { outcome: 'not_your_order', allowed: false, securityEvent: true, detail: `order "${input.order.orderId}" belongs to another customer` };
  }
  return { outcome: 'own', allowed: true, securityEvent: false, detail: 'the caller\'s own order' };
}

/** A recorded refusal — who asked for what they may not see, and when (hard rule #6). */
export interface StorefrontAccessRefusal {
  readonly customerRef: string;
  readonly orderId: string;
  readonly outcome: Exclude<ScopeOutcome, 'own' | 'unknown'>;
  readonly action: 'read' | 'place';
  readonly at: string;
}

/**
 * The pattern a person should look at: a customer who has been refused for MORE THAN ONE distinct order
 * is probing, not mistyping. Deterministic, over the register.
 */
export function probingCustomers(refusals: readonly StorefrontAccessRefusal[], threshold = 2): readonly { readonly customerRef: string; readonly distinctOrders: number }[] {
  const byCustomer = new Map<string, Set<string>>();
  for (const r of refusals) {
    const set = byCustomer.get(r.customerRef) ?? new Set<string>();
    set.add(r.orderId);
    byCustomer.set(r.customerRef, set);
  }
  return [...byCustomer.entries()]
    .filter(([, orders]) => orders.size >= threshold)
    .map(([customerRef, orders]) => ({ customerRef, distinctOrders: orders.size }))
    .sort((a, b) => b.distinctOrders - a.distinctOrders || a.customerRef.localeCompare(b.customerRef));
}
