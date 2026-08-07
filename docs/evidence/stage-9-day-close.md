# Stage 9 gate evidence — end-of-day and refund controls

**Gate:** roadmap Stage 9 — *"end-of-day and refund controls prove out."* Modules M12–M15,
D04.

**Executed:** 4 August 2026 against **PostgreSQL 16.13**, walking **one trading day** from
the first parked basket to the moment the manager is allowed to close. Automated as
`tests/integration/day-close-honestly.test.ts` (9 assertions), run in CI against a real
PostgreSQL service container, and **verified repeatable** (run twice, green twice).

The claim under test is narrow and unforgiving: **the day closes on what actually
happened, not on what would be convenient.** Money in an unknown state stays unknown and is
stated as a number. Money the shop owes a customer stops the close. Money the shop is owed
is split into what it can chase and what it has simply lost.

---

## The day, and where each control bites

| # | Step | Control proven |
|---|---|---|
| 1 | A basket is parked at 17:10 | Written as **serialised state**, not held in the running program |
| 2 | **The till loses power** | The bill is rebuilt from what was on disk, lines intact — *this is the M12-FR-02 acceptance criterion, executed rather than asserted* |
| 3 | The customer returns and the bill is resumed | Resumed once, on the lane that came back up |
| 4 | The customer wanders to another lane and asks there too | **Refused** — *"resuming again would charge the customer twice"*, naming who already has it |
| 5 | One basket parked at lunchtime is never collected | On the close-of-day list at **₹540.00**, *"past the abandonment window; nobody is coming back for it"*. The resumed bill is correctly **not** on it |
| 6 | Three sales rung up and committed | Local commit, nothing awaiting the network (hard rule #1); banked in PostgreSQL |
| 7 | A card machine never answers on a sale to an **identified** customer | Tender stays **`uncertain`**; recovery from a complete provider record confirms **not paid** — ₹840.00, contactable |
| 8 | The same on a **walk-in** | Also unpaid, and the system says plainly there is **nobody to contact** |
| 9 | A UPI payment where the provider's record is **incomplete** | **Still unknown.** *"No authorisation yet is not the same as no authorisation — do not chase the customer on this"* |
| 10 | The close-of-day exposure | **Four numbers, kept apart**: ₹840.00 recoverable · ₹300.00 unrecoverable (*"treat this as a loss, not a debt"*) · ₹120.00 unknown. A single "pending" total lets a manager close believing the money is merely late |
| 11 | The unknown money | **Does not block the close** — it is *stated*, not absorbed. A manager who cannot close starts looking for a way around the system |
| 12 | The lane retried a card and the provider captured **twice** | **BLOCKS the close.** *"Refund it before closing; nobody will chase this tomorrow on the customer's behalf"* |
| 13 | A refund is requested and the gateway times out | Recorded **`uncertain`**, never "done". The customer is told the truth, including *"we will not refund you twice"* |
| 14 | The cashier presses refund again | **Refused** — one refund id, one reversal; the provider is never asked a second time |
| 15 | The statement arrives overnight with the credit | Resolved to **succeeded**, `resolvedBy: provider_settlement` — **the only route out of uncertain** |
| 16 | The day's refund totals | **All three stated separately**: ₹850.50 confirmed, ₹220.00 unknown, ₹150.00 refused. The unknown figure is not split between the other two |
| 17 | The refund exception list | Valued, **owned by a named person**, worst first — *"the customer is owed this money and has not had it"* ahead of *"do NOT refund again until the statement settles it"* |
| 18 | The provider settlement file, where `gross − fees ≠ net` | **Refused.** *"The provider's own arithmetic does not hold"* — reconciling against a file that does not add up invents differences that are not there |
| 19 | The corrected file | Accepted: ₹850.50 gross less ₹15.31 fees = ₹835.19 banked |
| 20 | Yesterday's unsettled card tender | **`awaiting_settlement`** — normal at T+1, reported for cash flow, **not an exception** |
| 21 | July's unsettled card tender | **`overdue_settlement`** — *"this money may not arrive on its own"*. ₹600.00 at risk |
| 22 | Opening a case on the overdue one | Assigned to a **named person** with a due date |
| 23 | Opening a case on the merely-not-due one | **Refused** — *"opening one trains people to close cases without reading them"* |
| 24 | Resolving it | Closes **only with an outcome and a note**, and returns feedback: *"correct the cycle so normal timing stops raising exceptions"* |
| 25 | Three short COD returns by one driver | Signal raised, valued at ₹200.00 — and `actionTaken: false`. **The fraud layer detects; it does not act** (hard rule #5 / AI-NFR-12) |
| 26 | A case opened on that signal, with evidence | Chain of custody recorded; the evidence chain **verifies** |
| 27 | Someone edits the evidence description behind the code | **The seal breaks and the case cannot be closed on it** |
| 28 | Closing the genuine case as **proven**, by the investigator | **Refused** — a proven outcome needs a second signature (§28) |
| 29 | Closed by the owner, with a note | Recorded, with the outcome and the recovery |
| 30 | `DELETE` and `UPDATE` on the day's events | **The database itself refuses** (migration 0004). Every sale is still there |

---

## The two distinctions this stage is really about

**Late is not lost.** A card tender with no credit yet is completely normal at T+1 and a
serious problem at T+9. A system that reports both as "unsettled" either buries the real
one among a hundred normal ones, or trains the cash office to clear the list without
reading it. Both end the same way: the one that mattered is missed. So unmatched tenders
are aged against the provider's contracted cycle, and only the genuinely late ones become
exceptions with a name against them.

**Unknown is not a third kind of paid.** Every place money can be in an indeterminate
state — an uncertain tender, an uncertain reversal — that state is **named, kept, valued
and reported on its own line**. There is deliberately no function anywhere in this stage's
code that resolves an uncertain payment or refund by hand, in either direction, and three
separate tests assert that absence by scanning the module's exports. The reason is not
theoretical: the moment such a function exists, somebody uses it at 9pm to clear a queue,
and the shop's books quietly stop describing reality.

## Repeatability

The ledger is append-only and the database refuses `DELETE`, so the suite mints a
run-scoped prefix (`RUN = d<base36 timestamp>`) into every id and idempotency key, and
filters its reads by it — the same suite runs any number of times against the same database
and still asserts on exactly its own events.

## Verdict

**Stage 9 gate: PASSED.** A parked bill survives the till losing power and can only be
resumed once. A refund cannot be invented, cannot be double-issued, and can only be
confirmed by the provider's own statement. The day states its unknowns instead of absorbing
them, refuses to close while the shop is holding a customer's money, and closes on evidence
that nothing afterwards can delete.

## What the owner should check in the store

Three things, each about a minute:

1. **Pull the plug on a lane mid-basket after parking a bill.** Turn it back on. The parked
   bill should still be there with every line on it. Then try to recall the same bill on a
   second lane — it should refuse and tell you which lane already has it.
2. **Ask the cash office to show you the settlement list.** There should be two separate
   figures: money that is simply not due yet, and money that is genuinely late. If it shows
   one "unsettled" total, the list is not being read.
3. **Ask what happens when the card machine does not answer during a refund.** The correct
   answer is *"it says we don't know yet, and we don't tell the customer it's done until
   the bank statement shows it"*. If anyone can click a button to mark it refunded, that
   button is the problem, and there is deliberately no such button in this system.
