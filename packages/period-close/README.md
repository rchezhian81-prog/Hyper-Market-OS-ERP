# `packages/period-close/`

Tally connector, retry and dead-letter queue, period close and CA-signable control
totals — **M23-FR-04** (QG-07, §4.2, §28).

The single most important thing about this package is what it is **not**: **Tally is a
destination, not the book of record.** Our append-only ledger is the truth; Tally is
where a copy goes so the CA can work in software they already use. The failure people
actually hit is the reverse assumption — a posting fails, somebody "fixes it in Tally",
and now two systems disagree and neither knows it.

## `src/tally-connector.ts`

- **A failed posting never changes our numbers.** It queues, retries with computed
  exponential backoff (no timers — `backoffSeconds` is a pure function), and if it keeps
  failing it lands in a **visible** dead-letter queue.
- **Posting is idempotent and versioned.** A `duplicate` result is treated exactly as
  `accepted` — Tally already has it, so the business effect is present and the queue
  stops trying. Without that, every retry after an ambiguous timeout doubles the month's
  revenue, and the ambiguous timeout is the normal case, not the edge case.
- **A rejection is not a retry.** Tally refusing a voucher because a ledger name does not
  exist will refuse it identically a thousand times. A `rejected` goes **straight** to the
  dead-letter queue without burning the attempt budget — retrying a permanent failure
  buries the one item a human needs to see.
- **`deadLetters` is read, never drained by deletion.** The only way out is
  `requeueCorrected`, which creates a **new** posting with a **new** idempotency key
  (reusing the old one would be rejected identically) and **keeps the original failure on
  file** — a dead-letter that vanishes when it is fixed leaves no evidence the month was
  ever wrong (hard rule #6).

## `src/period.ts`

A period close is the moment the shop says in writing what happened last month, and a
chartered accountant puts their name to it. So it cannot be a button that sets a flag.

- **`validateControlTotals`** — every total is stated **twice, from two independent
  sides**: what our ledger holds, and what the accounts actually received. They must
  agree **exactly**, in integer minor units. A close that tolerates a small difference
  tolerates any difference, because nobody ever tightens the tolerance afterwards.
- **`closePeriod`** returns **every blocker at once** — unreconciled totals, dead-lettered
  postings (money the accounts never saw), unsent sync items (they would arrive into a
  closed period), and unexplained exceptions. A finance team meeting obstacles one at a
  time on the last day of the month starts looking for a way round the system, and finds
  one.
- **`reopenPeriod`** needs an approval from **someone other than the requester** (§28) and
  a written reason. A signed set of accounts does not change on one person's say-so.
- **`routeCorrection`** sends a correction for a closed period into the **open** one as a
  compensating entry (hard rule #2). Accounts that change after they were signed are the
  one thing an auditor cannot forgive, and the fix always looks harmless at the time.
- **`buildEvidencePack`** is what the CA signs: every figure, both sides, and the method
  used to derive each — so the signature is on something re-derivable rather than on our
  word. A pack that does **not** reconcile is still produced (hiding it just moves the
  conversation later) but is marked **not signable** and says *"Do not sign them until the
  differences above are explained."* A single outstanding dead-letter makes it unsignable
  even when every total agrees.

> Pure and deterministic: the connector is a port, the clock is injected, backoff is
> computed rather than slept. Tested in `tests/unit/period-close.test.ts` (27) and proven
> end to end in `tests/integration/books-reconcile.test.ts` (Stage 10 gate). Part of the
> repository layout in `CLAUDE.md`.
