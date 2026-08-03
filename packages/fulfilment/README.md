# `packages/fulfilment/`

Picking, packing and delivery — **M19**. Turn a confirmed order into an accurate, honestly
delivered one.

- **`src/delivery.ts`**
  - `transitionDelivery(from, event)` — the delivery state machine (`assigned →
    out_for_delivery → delivered`, or `failed → reattempt`/`returned_to_origin`); only allowed
    transitions apply (`InvalidDeliveryTransitionError`). Helpers `canTransitionDelivery`,
    `isTerminalDelivery`.
  - `assertProofOfDelivery(proof)` — a delivery is complete only with **proof** (photo / OTP /
    signature); missing proof throws `ProofRequiredError` (M19-FR-03).
  - `confirmSubstitution(input)` — a short-pick substitution applies **only when the customer
    has confirmed it** (A04 / hard rule #5 spirit); otherwise `SubstitutionNotConfirmedError`
    and the line stays short (M19-FR-01).
- **`src/cod.ts`**
  - `reconcileCod(expectations, collections)` — reconciles cash-on-delivery **to the paisa** at
    shift end, matching by order and flagging **short / over / uncollected / unexpected** as
    valued exceptions (feeds M23). **COD is cash/UPI only** — a card method is refused with
    `CardDataError` (hard rule #3).

> Pure and deterministic; offline the caller queues these as events (PII minimized on device).
> Tested in `tests/unit/fulfilment.test.ts`. Part of the repository layout in `CLAUDE.md`.
