# Pilot run-sheet — a day-by-day plan for the drills

**Who this is for:** the owner and the store team. Plain English, no jargon.

**What it is:** the go-live checklist (`docs/runbooks/store-go-live-checklist.md`) lists *what* has
to be witnessed before the shop trades on the new system. This run-sheet puts those same drills
**in an order, across days, with the people each one needs** — so the pilot is a booked plan, not a
pile of tasks. It **adds nothing**: every line carries its **UAT-##** and comes straight from the
checklist (which comes from `docs/registers/uat-calendar.md`, the source of truth).

**How to use it:** the days are **relative** ("Set-up Day 1", "Pilot Day 2") so you drop your own
calendar dates in the blank column. Shift and merge days freely — a slow week could do a "day" in
an afternoon. Tick each drill as it passes.

**The golden rule of the pilot:** run it on the **real shop in quiet hours**, on one lane, never on
a busy Saturday. Tell staff plainly: *the system is being tested, not you.* **A wrong answer is a
win** — it is a setting fixed now instead of a surprise later. Keep the checklist open beside this
sheet: it spells out *what a good result looks like* for every line.

---

## Before you start — book these on the first day (they need lead time)

| UAT | What to do | Who | ✓ |
| --- | --- | --- | --- |
| UAT-10 | Book the independent penetration test (a paid engagement, before customer launch) | Owner (paid) |  |
| UAT-49 | Open a live-AI provider account and schedule the 8-question AI go-live evaluation | Owner |  |

Also have ready: the **filled-in set-up workbook** (`pilot-setup-workbook.md` / `.xlsx`), a quiet
trading slot each day, and a note of which staff are on.

---

## Set-up Day 1 — settings and the safety base

*Date: __________  ·  a quiet morning + afternoon  ·  mostly the owner*

| UAT | What to do | Who | ✓ |
| --- | --- | --- | --- |
| UAT-02 | Master-data workshop — work down the set-up workbook, value or accept default on each | Owner |  |
| UAT-03 | Café set-up — recipes, yields, portions, use-by, what is made on site | Owner + café lead |  |
| UAT-04 | Enter the real licences (FSSAI, Legal Metrology, trade, fire), each with a named person | Owner |  |
| UAT-05 | Create one named login per person — no shared accounts | Owner |  |

## Set-up Day 2 — the "ask and confirm" session

*Date: __________  ·  half a day  ·  owner + a staff member. Each is a quick question with a right
answer; a wrong one is a setting to fix today.*

| UAT | Ask / do | Who | ✓ |
| --- | --- | --- | --- |
| UAT-13 | Blind stock-count — count one product off-screen; the system needs a senior approval to correct | Owner + staff |  |
| UAT-15 | Settlement list shows not-due-yet vs genuinely late, each late one with an owner and date | Owner |  |
| UAT-21 | Erasure letter — what happens when a customer asks to be deleted | Staff |  |
| UAT-26 | Concession valuation — the concessionaire's stock is NOT in your valuation | Owner |  |
| UAT-28 | Certification gate — a lapsed food cert stops the deli, not the whole job | Staff |  |
| UAT-29 | Roster leaver — a leaver covers nothing on the Sunday rota | Owner |  |
| UAT-31 | Waste coverage — if reporting coverage fell, the number says "cannot compare" | Owner |  |
| UAT-34 | Plan limit — outgrowing the plan gets an invoice, never stops the tills | Owner |  |
| UAT-38 | Shelf-label walk — any label under the till price is fixed today (legal) | Owner + staff |  |
| UAT-40 | Rejected-items list — Tally rejects go to a worked list, never silent retries | Owner |  |
| UAT-41 | Where is the payment key — a vault, with a named owner and a last-changed date | Owner |  |
| UAT-44 | AI accountability — "a person approved it, their name is on it", never "the AI did it" | Owner |  |
| UAT-47 | AI cost — a figure per assistant and a share of the ₹15,000 ceiling, not one number | Owner |  |
| UAT-48 | Budget exhaustion — the assistant stops and the shop carries on | Owner |  |
| UAT-56 | Incident drill — walk the first 90 seconds from memory: note time, touch nothing, call custodian | Owner + 2nd custodian |  |
| UAT-57 | Off-system contact list — CERT-In and payment-provider numbers written outside the system | Owner |  |
| UAT-58 | Name the security lead — a person, accountable for the 6-hour breach report | Owner |  |

---

## Pilot Day 1 — it keeps trading when things break *(the whole promise — owner present)*

*Date: __________  ·  the most important day. Break things on purpose and watch the shop keep
selling.*

| UAT | What to do | Who | ✓ |
| --- | --- | --- | --- |
| UAT-39 | Unplug the internet mid-sale, finish it, plug back in — **one** sale appears, not two | Staff (owner watches) |  |
| UAT-08 | Pull the network cable mid-basket — the sale completes, prints, later syncs exactly once | Staff |  |
| UAT-43 | Confirm the shop can sell with the cloud down — yes, every time | Owner + staff |  |
| UAT-14 | Park a bill, cut the lane's power, restart — it returns in full; refused on a second lane | Staff |  |
| UAT-07 | Prove the ≤30-minute store recovery — back trading in 30 min, committed sales lost = 0 | Owner + staff |  |
| UAT-01 | Owner-witnessed destroy-and-restore (~10 min) — restore reconciles; then the DB refuses a hand-edit | Owner |  |

## Pilot Day 2 — the money is honest, and safety holds

*Date: __________  ·  the evening before, turn the internet off overnight for UAT-19.*

| UAT | What to do | Who | ✓ |
| --- | --- | --- | --- |
| UAT-19 | Brief without AI — with internet off overnight, the morning brief still arrives (numbers, no written summary) | Owner |  |
| UAT-16 | Refund uncertainty — if the card machine goes quiet, nobody can mark it refunded by hand | Staff |  |
| UAT-18 | Owner drill-through — tap any figure on your phone; it lands on the real bills, and they add up | Owner |  |
| UAT-30 | Scrap money — last month's cardboard/plastic/e-waste price, cheap loads flagged, money on the books | Owner |  |
| UAT-12 | Live recall drill — recall a real batch, time it; the lane refuses the item with the cable out | Owner + manager |  |
| UAT-32 | Cold-room exposure — a door left open holds every batch; then unplug the probe — silence reads as a fault | Staff |  |

## Pilot Day 3 — the customer, delivery, and dignity side is honest

*Date: __________*

| UAT | What to do | Who | ✓ |
| --- | --- | --- | --- |
| UAT-22 | App honesty — misspelled search still finds it; recalled item hidden; sold-out warns at review, not payment | Staff |  |
| UAT-23 | Cancel an online order — the shelf figure comes straight back | Staff |  |
| UAT-24 | Substitution policy — pickers "leave it out and don't charge", never "send the closest thing" | Pickers |  |
| UAT-25 | Weighed line & crate — weigh a pack vs invoice to the paisa; frozen not with dry, raw not above ready-to-eat | Staff |  |
| UAT-27 | Supplier-portal isolation — a supplier opening another's invoice is refused AND recorded | Owner + supplier |  |
| UAT-36 | Self-checkout dignity — a bag on the scale says only "a colleague is coming", no accusation | Staff |  |
| UAT-37 | Self-checkout age — an age-restricted item always fetches a person; no setting changes that | Staff |  |
| UAT-42 | Unapproved peripheral — an unapproved scanner/printer is refused, and it names what to buy | Staff |  |

## Pilot Day 4 — AI is accountable, staff can work it, and the CA/export prep

*Date: __________  ·  spread the staff usability (UAT-06) across the whole pilot as people are free.*

| UAT | What to do | Who | ✓ |
| --- | --- | --- | --- |
| UAT-45 | Two names — an AI-suggested markdown shows the approving manager AND the drafting assistant, in order | Owner + manager |  |
| UAT-46 | Pull the kill switch yourself — it stops instantly; the brief still arrives; the puller cannot lift it | Owner |  |
| UAT-06 | Usability testing — real cashier, manager and warehouse tasks on the real screens | Staff |  |
| UAT-17 | CA control-total rehearsal — walk the month's evidence pack; a pack that does not reconcile refuses to look signable | CA |  |
| UAT-20 | Invoice-layout freeze — change the invoice address, reprint last month's — it still shows the OLD address | Owner |  |
| UAT-33 | Second-shop demonstration — the system runs as a different imaginary retailer from the same install | Owner |  |
| UAT-35 | Leave-tomorrow export — all your data, every domain, in files another system can read, each with a checksum | Owner |  |

---

## Your-real-data block — migration *(after the pilot, after our own extract, with the CA)*

*Date: __________  ·  the legacy-extract block is lifted — on 7 Aug 2026 the owner decided we
extract our own data ourselves (OB-06), so these run once that extract is done.*

| UAT | What to do | Who | ✓ |
| --- | --- | --- | --- |
| UAT-50 | Duplicate-product answer — a twice-existing product is listed for a decision, never merged automatically | Owner |  |
| UAT-51 | Read the problem list yourself — money and tax first, each line checkable against the old system | Owner |  |
| UAT-55 | Approve what we leave behind — anything not migrated needs your written approval and a number | Owner |  |
| UAT-52 | Signature check — two different people sign; the one who ran the load is neither; CA signs tax and finance | Owner + CA |  |

## Go-live block — cutover *(owner GO required)*

*Date: __________*

| UAT | What to do | Who | ✓ |
| --- | --- | --- | --- |
| UAT-53 | Watch the rollback actually performed (not the plan), with a date, in a rehearsal window before GO | Owner + store |  |
| UAT-09 | Migration reconciliation sign-off — stock, financial, tax, loyalty control totals, signed | Owner + CA |  |
| UAT-11 | Formal GO for cutover — your explicit GO | Owner |  |
| UAT-54 | After cutover — the old system stays read-only until retention ends; data is never deleted | Owner |  |

---

## The five drills that matter most

If a day gets squeezed, these five are the promise the whole system is built on — do not drop them:

1. **UAT-39** — unplug mid-sale, one sale not two.
2. **UAT-01** — destroy-and-restore, nothing lost, hand-edit refused.
3. **UAT-07** — back trading inside 30 minutes.
4. **UAT-12** — a real recall, refused at the lane with the cable out.
5. **UAT-46** — the kill switch stops the AI instantly and the shop carries on.

## Where the owner must personally be in the room

Booking-critical: **UAT-01** (destroy-and-restore), **UAT-07** and **UAT-39/43** (offline trading),
**UAT-46** (kill switch), **UAT-18** (drill-through), plus every **sign-off** — UAT-09, UAT-11,
UAT-52, UAT-53, UAT-55. Everything else a trained staff member can run with you told the result.

---

## Two decisions that sit outside every drill

Not on this run-sheet because they are choices, not checks: **where it is hosted** (the cloud
vendor — budget already set) and **the live AI provider** (everything runs on a safe stand-in until
you choose). Both block *customer* launch, not the pilot.

_Derived from `docs/runbooks/store-go-live-checklist.md` and `docs/registers/uat-calendar.md`, which
stay the source of truth; if they ever disagree, the register wins._
