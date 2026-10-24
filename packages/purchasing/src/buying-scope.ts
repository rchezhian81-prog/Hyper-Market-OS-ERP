// Central and local procurement (M06-FR-04 "Central/local procurement …"; §28 scope). OB-289 (owner, 23 Oct 2026, in
// writing, D-6 option C "Both, per order"): every purchase order carries ONE buying scope —
//
//   central_via_warehouse   — head office buys into a warehouse of its own, and the stock is transferred to the stores;
//   central_direct_to_store — head office buys, and the supplier delivers straight to the store;
//   local                   — a store buys for itself, within the money limit of the person raising the order.
//
// OB-290 (owner, 23 Oct 2026, D-3): the local limit is the raiser's role PO limit — store manager ₹25,000 per order, owner
// unlimited — held on head office's server as the owner's versioned approval rules (`authorityOf`, package P1). This engine
// only applies the figure it is given.
//
// The rules, so a scope is never just a label:
//   • a CENTRAL order is raised by head office — someone whose authority is company-wide. A person scoped to stores buys
//     locally or not at all;
//   • a central-via-warehouse order is delivered to a warehouse that belongs to no store; a direct-to-store or local order
//     is delivered to a store (or a place inside it, its back store);
//   • a local order ABOVE the raiser's limit is not theirs alone: it goes to the OWNER to decide (integration follow-up,
//     owner 23 Oct 2026 — "an over-limit PO routes to the owner"); a local order is refused when no limit is known for the
//     raiser at all (never "unlimited by default");
//   • a scope the buyer does not name is DERIVED from those same facts — a store-scoped buyer's order is local; head
//     office's order to its own warehouse is central-via-warehouse; head office's order to a store is central-direct — and
//     the order says it was derived. Nothing else is guessed.
//
// Pure and deterministic.

export const BUYING_SCOPES = ['central_via_warehouse', 'central_direct_to_store', 'local'] as const;
export type BuyingScope = (typeof BUYING_SCOPES)[number];

export const isBuyingScope = (v: unknown): v is BuyingScope => typeof v === 'string' && (BUYING_SCOPES as readonly string[]).includes(v);

export type ScopeRefusal =
  | 'unknown_buying_scope' | 'central_buying_is_head_offices' | 'central_via_warehouse_needs_a_warehouse'
  | 'scope_delivers_to_a_store' | 'local_limit_unknown';

export type ScopeJudgement =
  | {
    readonly ok: true; readonly scope: BuyingScope; readonly source: 'named' | 'derived';
    /** A local order above the raiser's limit: the owner decides it (only someone with unlimited authority issues it). */
    readonly ownerDecides?: { readonly raiserLimitMinor: number; readonly valueMinor: number };
  }
  | { readonly ok: false; readonly refusal: ScopeRefusal; readonly detail: string };

export function judgeBuyingScope(f: {
  /** What the buyer named (undefined ⇒ derive). */
  readonly named: unknown;
  /** True when the raiser's authority is company-wide (head office). */
  readonly raiserCompanyWide: boolean;
  /** Where the order is delivered: a warehouse belonging to no store, or a store (or a place inside one). */
  readonly destination: 'central_warehouse' | 'store';
  readonly valueMinor: number;
  /** The raiser's local PO limit: a number, `null` unlimited, `undefined` not known. */
  readonly localLimitMinor: number | null | undefined;
}): ScopeJudgement {
  let scope: BuyingScope;
  let source: 'named' | 'derived';
  if (f.named === undefined || f.named === null) {
    source = 'derived';
    scope = !f.raiserCompanyWide ? 'local' : f.destination === 'central_warehouse' ? 'central_via_warehouse' : 'central_direct_to_store';
  } else if (isBuyingScope(f.named)) {
    source = 'named';
    scope = f.named;
  } else {
    return { ok: false, refusal: 'unknown_buying_scope', detail: `"${String(f.named)}" is not a buying scope — it is one of ${BUYING_SCOPES.join(', ')}` };
  }
  if (scope !== 'local' && !f.raiserCompanyWide) {
    return { ok: false, refusal: 'central_buying_is_head_offices', detail: 'a central order is raised by head office; a person whose authority is limited to stores buys locally' };
  }
  if (scope === 'central_via_warehouse' && f.destination !== 'central_warehouse') {
    return { ok: false, refusal: 'central_via_warehouse_needs_a_warehouse', detail: 'a central-via-warehouse order is delivered to a warehouse that belongs to no store' };
  }
  if (scope !== 'central_via_warehouse' && f.destination !== 'store') {
    return { ok: false, refusal: 'scope_delivers_to_a_store', detail: `a ${scope === 'local' ? 'local' : 'central direct-to-store'} order is delivered to a store, not to head office's warehouse` };
  }
  if (scope === 'local') {
    if (f.localLimitMinor === undefined) {
      return { ok: false, refusal: 'local_limit_unknown', detail: 'no local purchase-order limit is held for the person raising it, so a local order cannot be raised' };
    }
    if (f.localLimitMinor !== null && f.valueMinor > f.localLimitMinor) {
      return { ok: true, scope, source, ownerDecides: { raiserLimitMinor: f.localLimitMinor, valueMinor: f.valueMinor } };
    }
  }
  return { ok: true, scope, source };
}
