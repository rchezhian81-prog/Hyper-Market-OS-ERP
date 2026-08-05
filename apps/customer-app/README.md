# `apps/customer-app/`

The customer shopping app (Android / iOS + responsive web store) — M16 / D06 / D08.

`src/shopping-session.ts` is the model behind the customer screens: browse, review the basket
against the live catalogue, choose a slot, pay with a provider token, and see the truth about
whether the order actually reached the shop.

## The rule that lives here rather than in `packages/storefront`

**An order is not placed until the shop has it.** On a phone with no signal the basket is prepared
and nothing else — the screen says *not sent yet*, never *order placed*.

That is the deliberate **inverse** of the till (hard rule #1), and the difference is worth stating
because getting it backwards is easy. At the till we commit locally first and sync afterwards,
because the money is already in the drawer and the customer has walked out — the event happened,
and refusing to record it loses it. On a customer's phone nothing has happened at all: no money has
moved, no goods have left, and the shop has never heard of this basket. An app that says "order
placed" over a queued request has told the customer something untrue about the world, and they find
out when nothing arrives.

## The other three, all about sequence

- **Nothing is paid for that has not been reviewed.** `reviewCart` exists precisely so a customer
  is told at review — not at the payment screen, and certainly not at the door — that two items are
  gone. A session that lets checkout skip review makes that function optional.
- **A review goes stale.** If the catalogue is republished while somebody is deciding, paying
  against the older review charges a figure the customer never saw (P-02). The session refuses and
  asks them to look again rather than quietly repricing.
- **Problems are resolved by the customer, deliberately.** A short line is not silently reduced to
  what is in stock — they accept the smaller quantity, or they do not.

Tested in `tests/unit/customer-app.test.ts`.
