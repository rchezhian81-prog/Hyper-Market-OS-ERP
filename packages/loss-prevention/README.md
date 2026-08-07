# `packages/loss-prevention/`

The whole of **M15** — anomaly rules (FR-01), cross-domain fraud signals (FR-02) and
investigation cases (FR-04). **Nothing in this package blocks, suspends, cancels or
reverses anything**, and the tests assert that absence by name: it produces a prioritised
list for a person to read (§7 authority, hard rule #5, AI-NFR-12).

## `src/loss-prevention.ts` — till anomaly rules (M15-FR-01)

"Control by exception" made concrete (P-03):
surface the risky patterns — suspicious voids, refunds, discounts, no-sales and cash
anomalies — as **exceptions that link to the underlying transactions**, for the owner to act
on. It **detects only**; it never acts (an AI fraud agent may summarise/prioritise, never
sanction — AI-NFR-12).

- **`src/loss-prevention.ts`** — `evaluateLossPrevention(events, rules)`:
  - **Rules are data** — a store tunes its own thresholds "without code" (M15-FR-01). Each
    `LpRule` can limit the **count**, the **total value**, and/or a **single value** per
    cashier for a signal kind, and can mark a spike (`escalateAtMultiple`) as `escalate`
    rather than `flag`.
  - Returns an `LpException` for each breach, carrying the observed amount, the limit, the
    severity, and the **linked transaction ids** (`linkedTxnIds`).
  - **Pure and deterministic** — no storage, no I/O, no clock; it computes signals over
    already-synced data, so output is stable and trivially testable.

> Only kinds with a matching rule are evaluated, so a store enables exactly the rules it
> wants. Values are minor units in the store currency. Tested in
> `tests/unit/loss-prevention.test.ts` (9).

## `src/fraud-signals.ts` — cross-domain signals (M15-FR-02)

`loss-prevention.ts` watches the till. This watches what the till cannot see: **coupons,
loyalty, cash on delivery and supplier invoices** — the four places value leaves the
business without a cashier touching anything, which is exactly why they go unnoticed.

Every signal carries a **confidence**, and the weak ones say so in words rather than being
quietly suppressed: a hidden weak signal is how a pattern goes unseen for a year, and a
weak signal presented as strong is how an honest employee gets accused.

- `detectCouponAbuse` — a **declared limit exceeded** is `strong` (a rule was broken, that
  is a fact). One account holding an implausible **share** of coupon use is only ever
  `probable` — a keen regular looks identical. And a share of a *tiny* number is not
  evidence at all: `couponConcentrationMinimumTotal` stops a quiet Tuesday accusing
  whoever shopped on it.
- `detectLoyaltyManipulation` — **points earned with no sale behind them** is not a
  pattern, it is a transaction that should not exist, and it usually has a staff id on it.
  A burn spike is compared against **the account's own history**, never a shop-wide
  average — a big spender is not a suspect — and is reported as `weak`.
- `detectCodAnomalies` — the one place the money is in a pocket. Repeated shortfalls
  (*"one is a customer dispute, three is a pattern"*) and, separately, **cash collected
  and not handed in**, because cash held overnight is a risk even when every rupee
  eventually arrives.
- `detectSupplierAnomalies` — price and quantity against **this supplier's own history for
  this product**, and only once there is enough of it: two observations is not a baseline,
  it is a coincidence. A price *drop* is flagged as well as a rise.
- `prioritiseSignals` — strong before probable before weak, then by value.

Every threshold is per-tenant (`FraudThresholds`); the defaults exist so a new store is
not defenceless on day one. Tested in `tests/unit/fraud-signals.test.ts` (20).

## `src/cases.ts` — investigation cases (M15-FR-04)

A case file is read in two situations and both are adversarial: a disciplinary meeting and
a court. That sets every decision here.

- **Evidence is append-only** — there is no edit and no delete, not for a manager, not for
  the owner (hard rule #6), and a test asserts that no such export exists. Each item is
  **sealed to the one before it**, so an alteration or a removal is *detectable*.
  `verifyEvidence` reports **every** break, not just the first — the pattern of what was
  changed is itself evidence.
- **The chain of custody is part of the evidence** — who collected it, when, from where. A
  CCTV clip with no chain of custody is a video, not evidence.
- **A case cannot close without an outcome**, and **"unfounded" is a first-class outcome**:
  a system that only closes cases as *proven* quietly pressures people into proving things.
  A **proven** outcome needs someone other than the investigator (§28), needs evidence on
  the case, and is refused outright if the evidence chain does not verify.
- **`ruleFeedback`** is the loop the roadmap asks for — outcomes *measurably* adjust the
  rules that raised them. A rule whose cases are all unfounded is **retired**; mostly
  noise is **relaxed**; mostly proven is **tightened**; a handful of outcomes is **not
  enough to judge a rule on**. A rule that spends the manager's attention without ever
  being right is worse than no rule, because after a few weeks nobody reads any of the
  alerts, including the real ones.

Tested in `tests/unit/lp-cases.test.ts` (26), and proven end to end in
`tests/integration/day-close-honestly.test.ts` (Stage 9 gate).

> Pure detection throughout — no storage, no I/O, no clock. Part of the repository layout
> in `CLAUDE.md`.
