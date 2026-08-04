# Stage 8 gate evidence — physical-to-system and recall proof

**Gate:** roadmap Stage 8 — *"physical-to-system and recall proof."* Modules M08–M11,
D05.

**Executed:** 4 August 2026 against **PostgreSQL 16.13**, following **one batch of chicken
from the supplier's van to a recall** with the real engines — no mocks. Automated as
`tests/integration/physical-to-system.test.ts` (10 assertions), run in CI against a real
PostgreSQL service container, and **verified repeatable** (run three times, green three
times).

Two claims are on trial, and they are the two a hypermarket owner actually cares about:

1. **Physical to system** — every unit that entered the building can be pointed at.
2. **Recall** — when a batch has to come back, the shop can stop selling it instantly and
   everywhere, say exactly how much went out and to whom, and close the recall only with
   evidence that is then kept for ever.

---

## Act one — 240 kg of chicken, and where every kilo went

| # | Step | Control proven |
|---|---|---|
| 1 | Three temperature readings on arrival: 2.2 °C, 3.1 °C, 2.6 °C | Within the −2.0 °C to 4.0 °C rule. **All three readings retained**, not just the verdict — that is what an inspector asks for (M34-FR-03) |
| 2 | Quality release | Released by a **named person** against a passed sample. "It was checked" is not evidence |
| 3 | 240 kg received into `store-1` | Appended to the append-only ledger **and** to the durable PostgreSQL log |
| 4 | Put-away suggested | `CH-01`, a chilled pickable bin with room — one product kept in one place |
| 5 | The handheld hesitates; the operator scans again | `duplicate_ignored`, **no second movement**. Without this the bin holds 480 kg that does not exist |
| 6 | A typo'd bin `CH-99` is scanned | `unknown_bin` → **resolution queue**, never invented. *"Somewhere near aisle 4" is how stock becomes unfindable* |
| 7 | Quarantined stock aimed at a **pickable** bin | **Refused** (`not_pickable_state`). The same stock **is** accepted into `QU-01`. This is the commonest route by which bad stock reaches a customer — not a decision, a put-away |
| 8 | 60 kg transfer to `branch-2`, requested by the warehouse | **Refused** unapproved, and **refused again** when the requester approves it themselves (§28) |
| 9 | Approved by the ops manager, dispatched | Out of `store-1`; **in-transit held at `branch-2`** — visible to the branch, not sellable. *The van is a place* |
| 10 | The branch counts 55 kg | 55 in-transit → on-hand; **5 kg becomes a valued exception of ₹900.00** *"and it needs an owner"*, plus an explicit shortfall movement so nothing sits in a van for ever |
| 11 | 120 kg sold across four sales | System figure now 240 − 60 − 120 = **60 kg** |
| 12 | A **blind** cycle count returns 57 kg | The counter never supplies or sees the expected figure — it is projected from the ledger, so blind-count integrity is **structural**, not a UI promise |
| 13 | The count is reconciled | **Refused**: ₹540.00 of shrinkage is material and needs an approver |
| 14 | The counter approves their own variance | **Refused** — `self_approval_forbidden` (§28) |
| 15 | The store manager approves, with a reason | Compensating `InventoryAdjusted` of **−3 kg** appended. **Nothing is overwritten** (hard rule #2) |
| 16 | System figure re-projected | **57 kg — exactly the counted figure.** Not close; equal |

### The proof itself

```
240 kg received
 =  57 on the shelf at store-1     (and the physical count agrees)
 +  55 at branch-2
 +   0 still in transit
 + 120 sold to customers
 +   5 dispatched and never arrived — valued at ₹900.00, owned by a name
 +   3 shrinkage — counted, approved, corrected
 = 240
```

Two independent projections are checked against each other and both land on 57: the
**event ledger** (`onHandMinor`, the system figure the count is judged against) and the
**state projection** (`projectStock`, which tracks where each unit stands). Neither stores a
quantity; both derive it. The state projection also reports **zero exceptions** — no state
went negative anywhere in the chain.

### And it survives the database

Re-read from PostgreSQL and re-projected, the six synced events sum to the same 60 kg the
ledger held before the count adjustment. The adjustment itself is still in the outbox and
**its absence is visible** (`unsentCount() > 0`) rather than silently assumed applied (P-08).

---

## Act two — the recall

| # | Step | Control proven |
|---|---|---|
| 1 | A second batch arrives with **no temperature reading at all** | **Breach → automatic quarantine.** *"An unmeasured cold chain is an unproven one, so it is held rather than assumed good."* Absence of evidence is not evidence of a cold chain |
| 2 | Readings do exist for the overnight period: 9.2 °C, 10.4 °C, 3.1 °C | **Breach on duration as well as peak** — 10.4 °C for **180 minutes** against a 30-minute grace. Judging on peak alone either condemns good stock or clears bad stock, depending on which threshold you happen to pick |
| 3 | The breach is raised | Becomes an **incident linked to the control it defeated** (`c-cold-chain`), with its readings attached — it reaches the compliance register, not a conversation by the chiller (M34-FR-04) |
| 4 | Someone tries to release the hold anyway | **Refused** — `cold_chain_breach`. A held batch cannot be talked out of the hold |
| 5 | 12 kg had already gone out across three sales | — |
| 6 | Recall initiated; initiated **again** by a second person | **One recall, not two** (idempotent) |
| 7 | **(a) The lane** | `assertSellable` throws, from the **cached** open-recall set — the block holds **with the cable out**. The real offline `CatalogueCache` refuses the barcode too. **No network is consulted anywhere in this path** (M10-FR-04, hard rule #1) |
| 8 | **(b) The transfer** | **Refused** — *"sending it to another branch moves the problem, it does not solve it."* A recall is not solved by exporting it |
| 9 | **(c) The put-away** | **Refused** — recalled/quarantined stock never reaches a bin someone picks from |
| 10 | Trace the batch | **48 kg received, 12 kg issued, 36 kg still in the building to pull off the shelf.** The three sales are named individually |
| 11 | Who can be contacted | **One customer is identifiable** (`c-loyalty-8891`); **two were walk-ins and are not**. The system says which is which instead of implying the recall reached everyone |
| 12 | Why none of the rest is sellable | *"0 available — 36 quarantine not sellable"* — the plain-English answer a manager can act on, not a bare number |
| 13 | Close the recall with a blank evidence reference | **Refused** — `MissingRecallEvidenceError` |
| 14 | Close it with a disposal note | Closed. The record, the initiator and the evidence reference are **all still retrievable** (hard rule #6) |
| 15 | Try to `DELETE` the underlying events | **The database itself refuses** — `event_ledger is append-only`, migration 0004. Not the code above it; the storage engine |
| 16 | Try to `UPDATE` them | **Refused likewise.** All 10 events are still present afterwards |

---

## Defect found and fixed during this work

Three shipped source files — `packages/stock/src/position.ts`,
`packages/persistence/src/event-store.ts` and `packages/import/src/import-job.ts` — contained
a **raw NUL byte** written directly into a template literal as a composite-key separator.
The code compiled and ran correctly, and the guardrail scanners (which read UTF-8) were never
blinded by it. The damage was to **review**: git, grep, ripgrep and GitHub's diff view all
classify such a file as *binary*, so a change inside `position.ts` — the module that decides
what is sellable — would render as `Binary files differ` with **not one line shown to a
reviewer**. That is a silent hole straight through the pull-request gate in hard rule #8, and
it is invisible precisely because every check stays green.

All three now use the `U+0000` escape (identical at runtime), and a new guardrail —
`tests/guardrails/plain-text-source.test.ts` — fails the build if any shipped source file
ever contains a raw control byte again. As with every guardrail, it also proves it fires on a
known-bad fixture, so green means "the tripwire works and found nothing".

## Repeatability

The ledger is append-only and the database refuses `DELETE`, so a fixed idempotency key would
make the second run assert against the first run's data. The suite mints a run-scoped prefix
(`RUN = r<base36 timestamp>`) into every batch id, event id and idempotency key, and filters
its reads by it — so the same suite can be run any number of times against the same database
and still assert on exactly its own events.

## Verdict

**Stage 8 gate: PASSED.** Physical reconciles to system to the kilo, through a real blind
count and a real approved correction; and a recall stops the batch at every exit — the lane,
the transfer and the put-away — names who received it, and can only be closed with evidence
that nothing can afterwards delete.

## What the owner should check in the store

At the next stock count, take one product and follow it: count the shelf without looking at
the screen, then ask the system what it expected. If they differ, the system should refuse to
correct itself until a **second, more senior person** approves the difference with a reason —
and the corrected figure afterwards should equal what was physically counted, not an average
of the two. Then ask the manager: *"if this batch were recalled right now, could you tell me
how much went out and which customers we can telephone?"* The answer should be a number and a
list, in under a minute, without ringing anyone.
