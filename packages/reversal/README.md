# `packages/reversal/`

Payment reversal, gateway status and refund reconciliation — **M13-FR-04** (§4.3, §6.2).

This package exists to enforce one sentence from the roadmap: **never invent a reversal
success.** It is the mirror of the no-invented-approval rule on the tender side, and it
breaks the same way — not by a decision, but by a hopeful default. The provider call
times out, nobody knows what happened, and the easiest code in the world marks it done.
Two things then go wrong at once, in opposite directions, and **both cost the shop the
same money twice**: the customer is told "that's refunded", comes back angry and is
refunded again; or the reversal actually succeeded, the shop thinks it failed, and
refunds by hand.

- **`requestReversal(input, provider)`** — asks the provider and records what it
  actually said. An `unknown` answer becomes **`uncertain`**, a real and permanent state,
  never a placeholder. Idempotent on the refund id (a retry returns the existing
  reversal, and the provider is never asked twice), capped so the total reversed across
  every attempt can never exceed the original charge, and refusing a PAN-shaped
  reference outright (hard rule #3). An `uncertain` reversal **counts against the cap**
  — the money may still be moving — while a `failed` one does not.
- **`resolveFromSettlement(...)`** — **the only route out of `uncertain`.** There is
  deliberately no `markSucceeded` anywhere in this package, and a test asserts that
  absence, because the moment one exists somebody uses it to clear a queue at 9pm. A
  matching credit on the statement confirms it; a **complete** statement with no credit
  settles it the other way. An **incomplete** statement leaves it uncertain — no credit
  yet is not the same as no credit.
- **`tellTheCustomer(reversal)`** — the true sentence for the counter, derived from the
  state rather than from optimism, so nobody has to improvise a reassuring one. The
  uncertain wording promises nothing and explicitly says the shop will not refund twice.
- **`refundExceptions(...)`** — the cash-office list: **valued and owned**, worst first
  (failed → over-refunded → uncertain → merely unreconciled). An unvalued, unowned
  exception never reaches the top of anyone's day.
- **`refundDayTotals(...)`** — the day close **states all three numbers** (confirmed,
  unknown, refused) rather than splitting the unknown one between the other two.

> Pure and deterministic: the provider is a port (a real adapter returns `unknown` on a
> timeout rather than throwing — a thrown timeout is how "unknown" becomes "failed"), and
> the clock is injected. Tested in `tests/unit/reversal.test.ts` (22) and proven end to
> end in `tests/integration/day-close-honestly.test.ts` (Stage 9 gate). Part of the
> repository layout in `CLAUDE.md`.
