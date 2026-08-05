// Public surface of the customer shopping app (M16 / D06 / D08) — the shopping session behind
// the customer screens: browse, review against the live catalogue, choose a slot, pay with a
// provider token, and see the truth about whether the order actually reached the shop.
//
// The one rule that lives here rather than in `packages/storefront`: **an order is not placed
// until the shop has it.** On a phone with no signal the basket is prepared and nothing else.

export * from './shopping-session';
