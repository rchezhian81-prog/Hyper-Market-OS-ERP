# Screen spec — Customer app / web (Stage 3)

- **Surface:** Customer app/web (§27) · **Modules:** M20, M16, D08, D07, A04 · **Design bar:** a first-time shopper on a low-bandwidth phone orders in a few taps; consent and privacy are honest; the customer always confirms the cart (A04).

> Built on `../design-system.md`. Public-facing surface — **WCAG 2.2 AA** target (NFR-07).

## Screens & states (§27 Customer app/web row)
OTP login · Catalogue/search · Product page · Cart & lists · Repeat order ·
Slots & fees · Payment · Order tracking · Receipts · Returns/complaints ·
Privacy centre. All handle the §27.1 states.

## Shop → cart → checkout (M20 / D08)
- Catalogue with filters, voice/barcode search and typo tolerance (D01 / D08);
  lists, favourites and one-tap repeat order.
- **10-km configurable serviceability** (D08): an out-of-area address shows a clear
  message, not a dead end.
- Cart supports controlled substitutions/alternatives; **the customer confirms the cart**
  (A04) — AI only suggests, it never commits the order.
- Slots, minimum order and fees shown **before** payment; online payment via provider
  tokens only (no card data, hard rule #3).
- **Interaction budget (≤3):** reorder a past basket (≤3) · add a searched item to cart
  (≤2) · reach checkout from cart (≤2).

## Tracking, receipts, service
- Live order tracking, digital receipts, and return/refund/complaint raise-and-track.

## Privacy centre (M16 / D07 · PRV)
- Consent purpose/preference and **access/correction/export/erasure** requests are
  self-service and honest — nothing buried.

## Offline / low-bandwidth (§31 customer row)
- Ordering and payment **require online** — shown with a clear unavailable message;
  **the cart may cache**; the app is built for low bandwidth (light assets, resumable).

## Accessibility & language
- WCAG 2.2 AA; English/Tamil; large targets; screen-reader labelled; secure sessions.

## Acceptance (QG-02)
- A new customer completes a first order in a few taps on a low-spec phone.
- An out-of-area address is refused clearly.
- A substitution never happens without the customer's confirmation.
- A privacy request (export/erasure) can be raised without contacting staff.
