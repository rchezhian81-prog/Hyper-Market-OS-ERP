# `packages/loyalty/`

Loyalty points — earn / burn / reverse (**M17-FR-01**). Points are **money-like**, so they
follow the ledger discipline: every movement is auditable and the balance **reconciles** to the
liability (M23).

- **`src/loyalty.ts`**
  - `earnPoints(input, pointsLedger, outbox)` — an append-only **positive** movement (e.g. from
    a sale).
  - `burnPoints(input, pointsLedger, outbox)` — redeem at tender. Guards: the balance can
    **never go negative** (`InsufficientPointsError`), and an **offline** burn can **never
    exceed the offline cap** (`OfflineCapExceededError`) — the double-spend guard (M12-FR-03 /
    §31).
  - `reversePoints(input, pointsLedger, outbox)` — a compensating **credit** (e.g. a returned
    sale), never an edit of history.
  - `pointsBalance(pointsLedger, customerId)` — the balance, **projected** from the events
    (never stored — mirror of hard rule #2).
  - Idempotent on the movement id: a replay collapses to one effect and does **not** re-run the
    guards.

- **`src/coupons.ts`** (M17-FR-02) — a coupon is a small bearer instrument the shop prints and
  then honours, and everything that goes wrong with them goes wrong the same way: **checked
  once at issue and never again at the moment it costs money.** So `redeemCoupon` validates
  expiry, eligibility, the total limit and the per-customer limit **at redemption**, works
  **offline** against the lane's cached redemption set, is idempotent on the redemption id
  (a re-scan is not a second use), and **says when that cache is stale** rather than silently
  trusting it — a code used on lane 3 and again on lane 5 ninety seconds later is the
  commonest coupon fraud there is. A percentage is exact BigInt basis points and the discount
  can never exceed the basket: a coupon cannot pay a customer.
  `issuePersonalisedOffer` needs **both** profiling and marketing consent and names which is
  missing. `assessReferral` pays only once the referred person has **actually bought**
  (paying on sign-up funds an afternoon of fake accounts) and refuses a self-referral,
  including the disguised kind where two accounts share a verified contact.
- **`src/stored-value.ts`** (M17-FR-03/04) — a gift card is **the shop's money held on the
  customer's behalf**, so every issued rupee is a **liability** on the balance sheet.
  Balances are **projected from append-only movements**, never stored and decremented — a
  stored balance is a number two lanes can race on. Offline redemption is **capped, not
  forbidden**: forbid it and the shop cannot honour its own gift cards when the internet is
  down, which is when a customer is most annoyed. `householdBalance` pools value across a
  family (M17-FR-04), which makes the cross-channel race a normal Tuesday rather than a rare
  one — so `findDoubleSpends` surfaces it as a **valued exception with both movements kept**
  and both channels named. Nothing is silently reversed (hard rule #10): two people genuinely
  received goods, and the shop decides. `reconcileLiability` compares outstanding value
  against what finance posted and calls any difference **unrecorded debt**, not a rounding
  note. `flagVelocity` is **detect-only** — a genuine customer spending a large gift card
  across a big shop looks identical, and blocking them at the counter over a heuristic is
  worse than a delayed investigation.

> Composes `packages/ledger` (an append-only points ledger) and `packages/sync`. Every movement
> is a `PointsMovement` event queued for cloud reconciliation to the loyalty liability (M23).
> Tested in `tests/unit/loyalty.test.ts` (8), `tests/unit/loyalty-coupons.test.ts` (19) and
> `tests/unit/loyalty-stored-value.test.ts` (16). Part of the repository layout in `CLAUDE.md`.
