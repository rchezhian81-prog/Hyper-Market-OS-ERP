# Stage 14 gate evidence — one customer, end to end

**Gate:** roadmap Stage 14 — customer commerce. Modules M16, M17, M20, M21, M31-FR-01,
D07–D08.

**Executed:** 4 August 2026 against **PostgreSQL 16.13**, following **one person** through
the entire customer-facing product. Automated as `tests/integration/one-customer.test.ts`
(13 assertions), run in CI against a real PostgreSQL service container, and **verified
repeatable** (run twice, green twice).

The claim on trial: **every promise the shop makes to a customer is one it can keep.** Not
"mostly" — at each point where the system could tell a comfortable lie, it tells the truth
instead, and the test asserts the wording.

---

## Priya's week

| # | What happens | Control proven |
|---|---|---|
| 1 | She searches **"aashirwad"** | Typo-tolerant (D01) — a customer who gets nothing concludes the shop does not stock it |
| 2 | A recalled multigrain also matches "aashirvaad" | **Excluded entirely**, not greyed out. A recalled item in a result is an invitation to ask why she cannot have it |
| 3 | She searches in Tamil | Works, including the reasons an item cannot be bought (NFR-08) |
| 4 | Her cart holds 5 oils (2 in stock) and a ghee (none) | **Corrected at review, before the payment screen** — *"only 2 of 5 available"*, the ghee named. A customer told at payment has already decided to buy |
| 5 | The app wants to suggest things | She never consented to profiling, so only **aggregate** suggestions show — and the omission is **stated**, so nobody wonders why the app feels emptier for some customers and removes the check |
| 6 | She uses a ₹50 coupon on a lane whose list is 90 minutes old | Redeemed — and flagged **`countMayBeStale`**. The lane says what it does not know |
| 7 | She tries the same coupon on another lane | **Refused** — `limit_reached` |
| 8 | She spends the household gift card at the till, **offline**, for its full ₹500 | Allowed — within the offline cap. Forbidding it means the shop cannot honour its own gift cards when the internet is down |
| 9 | **Her mother spends the same ₹500 on the app twenty seconds later** | Balance projects to **−₹500**, and the double-spend is raised with **both movements kept** and both channels named. *"Nothing is silently reversed"* — two people genuinely received goods, and the shop decides (hard rule #10) |
| 10 | She tries to deliver to her mother's house, 35 km away | **Refused at the start**, naming the distance and the 10 km limit, and offering collection — not "something went wrong" after a full basket |
| 11 | Her own address, ₹880 basket | Serviceable. **The ₹40 fee is stated up front**, with *"free above ₹1,000"* — a fee that appears on the confirmation screen is the commonest self-inflicted reason a grocery basket is abandoned |
| 12 | Her chosen slot is full | **Alternatives offered**, not an error |
| 13 | **Her bank does not answer** | Order is **`payment_pending`**, `releaseForPicking: false`, and she is told *"we will not pick it until we know — please do not pay again"*. Confirming here means picking, packing and delivering goods never paid for |
| 14 | The bank answers later | Confirmed, ₹920 payable, banked in PostgreSQL against a **provider token**. A card number never existed to store |
| 15 | Her invoice is issued | Frozen under template **v1** |
| 16 | **The shop moves premises in September** | A new template **v2** is published; v1 is kept. Her July invoice, reproduced months later, still shows **12 Old Street** and never **88 New Road** — the customer's copy and the shop's copy remain the same document |
| 17 | The milk was sour. The desk looks her up | **Allowed** — answering her own complaint is performance of the contract, not marketing (M16-FR-04) |
| 18 | The same lookup, for marketing | **`not_profiled`** — she never consented |
| 19 | 90 minutes pass with nobody replying | **First-response SLA breached and escalating**, even though the resolution clock is comfortably within target. *"This is the wait a customer actually feels"* |
| 20 | The agent offers ₹500 goodwill; their limit is ₹200 | **Refused** — needs a separate approver (§28) |
| 21 | The manager approves it | Granted, with both names and a written reason on the record |
| 22 | A model writes the apology | **Not sent.** `approveDraft` requires a named human, and there is no send function anywhere in the module |
| 23 | The Diwali campaign runs | **She is excluded**, and the excluded count is reported. A campaign that quietly drops people looks smaller for no reason, and somebody "fixes" it by loosening the check |
| 24 | Her order confirmation | **Still reaches her** — transactional messages ride the contract, not consent |
| 25 | She opens the privacy centre | Shows **everything held, including the tax invoice that cannot be erased** — a privacy centre showing only the convenient data tells a comforting untrue story |
| 26 | She switches marketing off | Effective **on the very next message**, not the next batch |
| 27 | **She asks to be forgotten** | 413 records deleted; 97 minimised. The letter names **the Income Tax Act and the eight-year period**, the date the invoices can finally go (2034-03-31), and says the audit trail *"can never be deleted by anyone, including us"* |
| 28 | The wording of that letter | *"We would rather tell you exactly which than let you believe they were gone… These are kept because the law requires it, not because we want them. They are not used for marketing"* |
| 29 | `DELETE` on the events behind her order | **The database itself refuses** (migration 0004) — including for an erasure request |

---

## The three places this stage refuses to lie

**"In stock" that isn't.** Availability carries its age, and an **unknown** age is treated
as stale rather than fresh. "We don't know how old this is" is not "it's current", and the
customer standing in a delivery slot is the one who finds out.

**"Paid" that isn't.** The `unknown` payment branch is the same rule the till obeys
(§4.3): the order does not confirm, nothing is picked, and the customer is told plainly —
including not to pay again. Every other outcome here is recoverable; a confirmed order
against money that does not exist is goods out of the door.

**"Erased" that isn't.** The erasure letter is the most carefully worded thing in the
stage, because the alternative is not a technical failure but a broken promise: a customer
who believes they are gone stops worrying about it. So the letter names the statute, the
period and the release date for every record that survives, and states that the retained
data is not used for marketing and cannot be searched by name.

## Repeatability

Run-scoped prefix (`RUN = c<base36 timestamp>`) through every id, customer reference,
coupon code and template id, with reads filtered by it — the suite runs any number of times
against the same append-only database and asserts only on its own events.

## Verdict

**Stage 14 gate: PASSED.** One customer, followed from a misspelled search to a request to
be forgotten, and at every point where the system could have told her something
comfortable it told her something true instead.

## What the owner should check in the store

1. **Search your own app for a product, spelling it wrong.** It should still find it. Then
   check that anything you have recalled does not appear at all.
2. **Put something in the basket that has just sold out.** You should be told at the review
   screen, not at payment.
3. **Ask what happens if the bank does not answer during checkout.** The right answer is
   *"the order isn't placed, we don't pick it, and we tell the customer not to pay again."*
4. **Change the address on your invoice template, then reprint last month's invoice.** It
   must still show the old address. If it changes, the customer's copy and yours no longer
   match, and that is a tax problem, not a design one.
5. **Ask your service desk what happens when a customer asks to be deleted.** They should
   be able to show you the letter that names which records stay and which law requires it.
