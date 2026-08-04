# Stage 10 gate evidence — the books reconcile and the owner can see why

**Gate:** roadmap Stage 10 — finance, Tally and owner control. Modules M23, M29, D10/D13.

**Executed:** 4 August 2026 against **PostgreSQL 16.13**, closing **one month** end to
end. Automated as `tests/integration/books-reconcile.test.ts` (10 assertions), run in CI
against a real PostgreSQL service container, and **verified repeatable** (run twice, green
twice).

Two claims on trial:

1. **The books reconcile, or they do not close.** Control totals are computed from two
   independent sides and compared exactly. A posting the accounts never received blocks
   the close. Nothing is written off by the calendar.
2. **The owner can see why, down to the transaction.** Every headline drills to the
   immutable events behind it — and when the two disagree, the system says so instead of
   showing a plausible list.

---

## The month, and where each control bites

| # | Step | Control proven |
|---|---|---|
| 1 | Four sales banked in PostgreSQL: ₹48,200.00 net, ₹2,410.00 GST | Control totals **projected from the database**, not read from a stored figure |
| 2 | The month is posted to Tally | Sales journal accepted, voucher `V-1001` recorded |
| 3 | Tally **refuses** the GST journal — a ledger name doesn't exist | **Dead-lettered immediately**, not retried five times. A voucher Tally will never accept does not become acceptable on the fifth attempt, and retrying it buries the one item a human needs to see |
| 4 | The drain reports | *"nothing was dropped"* — the failure is visible, valued and on the list |
| 5 | Finance tries to close the period | **Refused, with both blockers at once**: the GST control total doesn't reconcile (₹2,410.00 vs ₹0.00) **and** a posting the accounts never received is outstanding |
| 6 | The evidence pack produced at that moment | **Not signable.** *"Do not sign them until the differences above are explained"* |
| 7 | The ledger name is created in Tally and the posting requeued | A **new** posting with a **new** idempotency key — reusing the old one would be rejected identically. **The original failure stays on file**, unchanged: evidence the month was once wrong |
| 8 | The retry times out and Tally reports `duplicate` | Treated exactly as accepted — **one voucher, not two.** This is the payoff of idempotency, and it is the case that actually occurs |
| 9 | Finance closes again | **Closed.** Every control total agrees exactly, on both sides, to the paisa |
| 10 | The evidence pack | **Signable**, and it states *both sides of every figure and the method used to derive each* — so the CA signs something re-derivable, not our word |
| 11 | Someone asks to reopen the signed month | **Refused** without an approval |
| 12 | They approve their own reopen | **Refused** (§28) |
| 13 | A late credit note for the closed month | Routed to the **open** period as a compensating entry — *"a signed period is never edited"* |
| 14 | The owner drills into net sales | **Four events from the database**, totalling exactly the headline |
| 15 | A branch manager drills the same headline | Sees ₹20,000.00 across their branch, with ₹28,200.00 **withheld and stated**: *"outside your access and are not shown — the headline figure includes them"* |
| 16 | A headline that doesn't match its own events | **"THESE TRANSACTIONS DO NOT ADD UP TO THE FIGURE THEY CAME FROM… Do not act on this until it is explained"** |
| 17 | Branch comparison | Rows reconcile to the same total; shares in **exact basis points** (58.50%), never a float |
| 18 | Six voided bills and one 02:15 login | **Two alerts, not seven.** The unvalued after-hours login sorts **above** ₹3,000.00 of voids |
| 19 | The approval inbox | One item actionable; one **superseded** — *"approving it now would commit a review of the old version and undo the newer change"* |
| 20 | The daily brief, three mornings running | Sent **with nobody sending it**, and **with no AI at all** — every figure present |
| 21 | `DELETE` and `UPDATE` on the month's events | **The database itself refuses** (migration 0004) |

---

## The three decisions this stage really turns on

**Tally is a destination, not the book of record.** Our append-only ledger is the truth. A
failed posting never changes our numbers — it queues, retries, and if it keeps failing it
sits in a visible dead-letter queue. The failure people actually hit is the reverse
assumption: a posting fails, somebody "fixes it in Tally", and now two systems disagree
and neither knows it.

**A control total is stated twice or it is not a control total.** Every figure is computed
from two independent sides — what the ledger holds and what the accounts received — and
they must agree exactly. A close that tolerates a small difference tolerates any
difference, because nobody ever tightens the tolerance afterwards. The evidence pack
therefore prints both sides and the derivation method for each, so the CA is signing
something they can re-derive rather than a number we assert.

**The numbers are the brief; the narrative is a decoration.** A daily brief that depends on
a language model stops on the morning the model is down, the key expires, or the internet
is out — which in a Tamil Nadu hypermarket is a Tuesday. So the deterministic figures are
composed first and always sendable; the narrative is applied afterwards and is dropped
without ceremony if it is absent, unconfident, in the wrong language, or carries no
evidence for what it claims. **AI is additive, never blocking**, and it never touches a
number.

## Defect found and fixed during this work

The alert ordering sorted by severity and then by **value**, which meant a zero-value alert
always sank to the bottom of its band. The gate test caught it: *"someone signed in at
02:15"* — the most important line on the list — was ranked underneath ₹3,000.00 of voided
bills. Ranking within a severity now puts **unvalued alerts first**, because an alert with
no rupee figure is not an alert worth nothing; it is one whose risk is not money, and those
(access, hours, identity) are precisely the ones nobody else is watching for.

## Repeatability

Run-scoped prefix (`RUN = f<base36 timestamp>`) on every id and idempotency key, with reads
filtered by it — the suite runs any number of times against the same append-only database
and still asserts on exactly its own events.

## Verdict

**Stage 10 gate: PASSED.** A month cannot close on figures that do not agree, on postings
the accounts never received, or on differences nobody has explained; a signed month cannot
be edited afterwards; every headline the owner sees drills to the events behind it or
declares itself untrustworthy; and the morning brief arrives on its own with the internet,
the model and the narrative all switched off.

## What the owner should check in the store

1. **Ask your CA to sign the month's control totals.** The pack should show, for every
   figure, *both* what our system holds and what Tally received, plus how each was
   worked out. If they only ever see one column, they are signing our word.
2. **Try to close a month with one posting still failing.** It should refuse, and it should
   tell you *both* problems at once, not one per attempt.
3. **Tap any number on your phone.** You should land on the actual bills behind it, and
   they should add up to the number you tapped. If they ever don't, the screen should say
   so in capital letters rather than showing you a list that nearly matches.
4. **Turn the internet off and wait for tomorrow's brief.** The sales, margin, baskets and
   cash should still arrive. The only thing missing should be the written paragraph — and
   it should say so.
