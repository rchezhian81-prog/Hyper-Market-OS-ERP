# `packages/storefront/`

The customer app and web storefront — **M20** (all four requirements), with D07–D08.

The app and the till must sell **the same shop**. That is P-02, and it breaks the same way
every time: the storefront gets its own product list, its own prices and its own idea of
stock, because that was easier than reaching into the real one. Six weeks later the app is
selling something the shop discontinued, at last month's price.

**So this package holds no catalogue of its own.** It takes the same published product and
price data the lane's `CatalogueCache` is built from, and adds only the customer-facing
concerns on top.

## `src/browse.ts` — catalogue, search, cart, lists (M20-FR-01/02)

- `viewProduct` applies the **same order of checks as the lane**: recall first, then
  status, then stock. An item the till would refuse is never shown as buyable.
- **Stock carries its age.** "In stock" from a two-hour-old figure is a promise the shop
  may not keep, so a stale figure is labelled — and an **unknown** age is treated as stale,
  because "we don't know how old this is" is not "fresh" (P-08).
- `searchCatalogue` — barcode wins outright, then exact, then prefix, then a
  **typo-tolerant** pass (D01). A customer who searches "aashirwad" and gets nothing
  concludes the shop does not stock it. Recalled and discontinued items are **excluded
  entirely**, not greyed out: a recalled item in a result is an invitation to ask why.
- `reviewCart` runs **before checkout, not at the door** — a customer told at the payment
  screen that two items are gone has already decided to buy them.
- `repeatOrder` **names what it could not bring back**. A repeat order that quietly loses
  the milk is why people stop trusting the button.
- `recommend` keeps the two kinds apart: *"customers also bought"* is aggregate and shown
  to anyone; *"because you bought X"* is profiling of a named person and needs consent
  (M16-FR-02) — and its omission is **stated**, so nobody wonders why the app feels emptier
  for some customers and removes the check.
- English and Tamil throughout (NFR-08) — **including the reasons an item cannot be
  bought**, which are exactly the strings a shop leaves untranslated.

## `src/checkout.ts` — serviceability, slots, payment, privacy (M20-FR-03/04)

- `checkServiceability` refuses an out-of-area address **at the start**, naming the
  distance and the limit — not "something went wrong" after a basket is filled. Radius,
  minimum order and fees are all per-tenant (D08 defaults to 10 km), and **the fee is
  stated up front**: a delivery charge that appears on the confirmation screen is the
  commonest self-inflicted reason a grocery basket is abandoned.
- `bookSlot` refuses a full slot and **offers the alternatives** rather than an error, and
  enforces enough notice to actually pick the order.
- `placeOrder` — the important branch is `unknown`. **An uncertain payment leaves the order
  `payment_pending`, releases nothing for picking, and tells the customer the truth**
  including *"please do not pay again"* (§4.3, the same rule `packages/tender` obeys). A
  confirmed order against money that may not exist means the shop picks, packs and delivers
  goods it was never paid for. A PAN-shaped payment reference is refused outright
  (hard rule #3).
- `trackOrder` states its own age — a cached "out for delivery" can be an hour old.
- `privacyCentre` lists **every** category including the ones that cannot be erased: a
  privacy centre showing only the convenient data tells the customer a comforting and
  untrue story about how much the shop knows. `changeConsent` takes effect **immediately**,
  not from the next batch — "it applies from tomorrow" is how someone who just switched
  marketing off receives one more message and complains to a regulator instead of the shop.

> Pure and deterministic: no clock, no network, no card data. Tested in
> `tests/unit/storefront-browse.test.ts` (23) and `tests/unit/storefront-checkout.test.ts`
> (19). Part of the repository layout in `CLAUDE.md`.
