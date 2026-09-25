# `packages/concession/`

Concession and shop-in-shop — **M27-FR-01…04** (§28, P-02, P-04, hard rules #2, #5). A
per-tenant **optional** feature (ADR-0003), built where a store runs concessions (`AVR-12`).

A concession counter — the jeweller, the mobile-phone kiosk, the sweet stall — sits inside the
shop, rings through the shop's tills, and **is not the shop's business**. Everything difficult
about this module follows from that one fact.

- **`src/concession.ts`**
  - `valueOwnStock({ branchId, lots })` — **ownership is a property of the stock, and the
    valuation asks.** The mistake that costs real money is boring and universal: concession
    stock ends up in the store's valuation. It is on the store's shelves, it moves through the
    store's POS, and one day somebody runs a stock valuation for the accountant and ₹40,00,000
    of somebody else's gold is in it. The balance sheet is wrong, the insurance schedule is
    wrong and the tax position is wrong — and nobody notices, because the number *looks about
    right*.
    - What was excluded is **named and valued** by owner. A quiet exclusion is as dangerous as
      a quiet inclusion: an unexplained gap between the shelf and the balance sheet is its own
      kind of trouble at an audit.
  - `checkStockAccess({ lot, actorId, actorKind, action, … })` — a concessionaire may handle
    their own stock and nothing else; one concessionaire reaching another's is a
    **`securityEvent`**. Store staff may see concession stock so the shelf makes sense, and may
    sell it **only where the contract says so** — but never adjust, write off or count it as
    theirs, because *"somebody else's inventory written off by our staff is a bill we cannot
    argue with"*.
  - `computePeriodCharge({ contract, sales, from, to, meteredUtilitiesMinor? })` — rent,
    revenue share and utilities in **exact integer money** (§29.1), the share taken in BigInt.
    `higher_of_both` is the common Indian mall term and is computed as exactly that: the
    **higher** of the two, never the sum. A refund carries a negative amount and reduces the
    base — charging revenue share on money that went back to a customer is a charge the
    concessionaire will find, and they will be right.
  - `settleConcession({ contract, charge, sales, bankedForThemMinor })` — **the money a
    concession sale takes was never the shop's revenue.** It is held on someone else's behalf
    and the settlement discharges it; presenting it as revenue and the payout as a cost
    inflates both sides of the P&L and makes every margin figure in the business wrong. A till
    short of what the counter rang is a **valued exception**, not a rounding note.
    - The **deposit is stated but never netted**. Grabbing a deposit against an unpaid month is
      a commercial decision with contractual consequences; a settlement routine does not get to
      take it.
  - `mayConcessionTrade({ contract, today, warnWithinDays? })` — **every blocker at once**, in
    the same style as the period close: telling somebody their insurance has lapsed, and only
    after they fix it that the agreement expired too, wastes a week of a trading counter.
    Lapsed insurance blocks trading because *"an uninsured counter inside your shop is your
    exposure, not theirs"*. It warns ahead of an expiry while still letting them trade.
  - `depositPosition({ concessionaireId, movements })` — **projected from movements, never
    stored** (hard rule #2). The commonest small fraud in a shop-in-shop arrangement is a
    deposit quietly booked as rent received: it flatters this year and becomes a real debt the
    day the counter leaves. A forfeit with **nobody's name on it is not a forfeit** and stays a
    liability. There is no balance setter anywhere in the module.

- **`src/concession-tagging.ts`** — till-side capture at **sale AND line-item** level (owner
  decision). `computePeriodCharge`/`settleConcession` work off coarse period totals; this is the
  fine-grained truth the till records so those totals can be trusted and audited.
  - `captureConcessionTag(input)` / `captureConcessionTagIdempotent(input, existing)` — a
    **cashier** records a line **from an approved source** (a docket, an app reference), never
    invents it. It snapshots the commission scheme **as it stood** (a later contract change never
    re-prices a posted line), computes `net = gross − discount` and the commission in **exact
    integer money** (BigInt), and is **idempotent** on the till's own key — a resend or a
    double-scan returns the original tag, never a second charge.
  - `reverseConcessionTag(...)` / `adjustConcessionTag(...)` — a posted tag is **never
    rewritten**. A mistake is a **reversal** (whole line negated) or an **adjustment**
    (compensating delta), each a NEW append-only tag naming the one it corrects (hard rule #2).
    Correcting is a **supervisor**'s act (`mayCorrectConcessionTag` refuses a cashier — SoD, §28),
    and a refused correction is **recorded**, never silent (P-08).
  - A **return / cancellation** carries negative money and names the sale it reverses, so
    commission is never taken on money that went back to a customer.
  - `markSettlementStatus(...)` — the settlement run sets `pending → included_in_charge →
    settled`; the till never guesses it. Every capture and correction is an append-only
    `ConcessionTagEvent` (who, when, from which source — hard rules #2 #6).
  - `concessionTagTotals({ tags, tenantId, concessionaireId?, from?, to? })` — folds the tag
    stream into per-concession gross / net / commission, **netting reversals and returns by
    construction**, so it **feeds** `computePeriodCharge` / `settleConcession` rather than
    duplicating them.

> Pure and deterministic: the clock is injected, no I/O. Composes with `packages/stock`
> (ownership on the ledger), `packages/day-close` (what the tills banked) and
> `packages/finance` (the liability). Tested in `tests/unit/concession.test.ts` (30),
> `tests/unit/concession-tagging.test.ts` (17), proven end to end in
> `tests/integration/beyond-the-till.test.ts` (Stage 16 gate), and the till-side tagging panel is
> browser-verified in `tests/e2e/concession-tagging.e2e.ts` (a cashier records → idempotent resend →
> cashier reversal refused → supervisor reversal backs it out). Part of the repository layout in
> `CLAUDE.md`.
