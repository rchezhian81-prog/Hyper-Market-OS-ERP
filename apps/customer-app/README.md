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

## The hop to the shop (`src/shop-transport.ts`) — M20 slice 2

Since 29 Sep 2026 the app **talks to the cloud**. `shop.place()` runs the session's own checks first
(reviewed, resolved, current prices, slot, no card number — none of these ever reaches the network), then
POSTs the basket to `POST /v1/storefront/orders/:orderId` with the customer's session token and an
idempotency key that *is* the order, and what the shop answered is what the customer is told: it has the
order (confirmed **because the shop said so**), it refused it (in its own words), the sign-in has ended
(sign in again; the basket is kept), it could not answer (nothing confirmed; the same order id is kept so
a saved order cannot double), or the request never reached it — *prepared, not sent*, and `shop.retry()`
sends the **same** order once, by itself when the connection returns or on one tap. The transport is
relative by default: the app is served behind the same origin as the API, so the token goes only to the
host that served the page. Tested in `tests/unit/shop-transport.test.ts`,
`tests/unit/customer-app-places-through-the-shop.test.ts`, against the real API kernel in
`tests/integration/the-app-orders-through-the-cloud.test.ts`, and in a real browser in
`tests/e2e/customer-order-delivery.e2e.ts`.

Sign-in now lives **in the shop page**, right where ordering needs it (browsing stays guest): the same
thin OTP client as below, handing the token straight to `shop.signedIn()` — held in memory by the model,
never in storage or a cookie. What a real store still needs (Stage F, deployment): the auth backend
(OTP begin/verify, revoke on sign-out, and the `customer` role granted on the first verified sign-in) and
a reverse proxy serving the app, `/auth/*` and `/v1/*` on one origin.

## The sign-in screen (`web/login.html` + `web/login.js`) — a thin client (M02 / M20 / M22)

The portal sign-in is a **thin client**: it holds no password, no signing key and no token-minting
code. It asks the auth backend to send a one-time code to the customer's phone, submits the code they
read off it, and on a verified sign-in holds only the short-lived session token, in memory. Everything
that mints or verifies lives on the backend — the real IdP / cloud auth API in production, and in the
browser E2E a local Node server running the SAME production engines (`@sre/identity`) with the
local/test IdP and OTP simulator, so a minter never enters the page (hard rule #4). The screen proves,
in a real browser: sign in by OTP → an ordinary action is allowed → a sensitive one (change bank
details) prompts step-up → sign-out **revokes** the session so the same still-unexpired token is
refused server-side. Verified in `tests/e2e/customer-login.e2e.ts` (self-skips with no browser).
