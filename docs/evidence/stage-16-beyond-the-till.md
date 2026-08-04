# Stage 16 gate evidence — beyond the till

**Gate:** roadmap Stage 16 — enterprise modules. Modules M22-FR-02/04, M24, M25, M26, M27,
M28-FR-02/03/04.

**Executed:** 4 August 2026 against **PostgreSQL 16.13**, following one trading day through the
six things a hypermarket does besides selling to a customer at a till. Automated as
`tests/integration/beyond-the-till.test.ts` (22 assertions), run in CI against a real PostgreSQL
service container, and **verified repeatable** (run three times, green three times).

The claim on trial: **everything the shop does that is not a walk-in sale still tells the
truth.**

---

## One day, six ways the shop is more than a till

### 1. A school orders on account (M22-FR-02, M22-FR-04)

| # | What happens | Control proven |
|---|---|---|
| 1 | A quote for 40 sacks of rice and 10 tins of oil, ₹82,950 | Held for 15 days. **Non-committing** — no stock moves, no receivable exists |
| 2 | A line quoted at zero quantity | **Refused, and no number is drawn** — a gap in a tax series is a question from an assessing officer with no good answer |
| 3 | The bursar accepts six days later | Converted **at the quoted price**, not at today's price list |
| 4 | The same quote presented three weeks later | **Refused.** *"Re-quote rather than re-price quietly at the invoice"* |
| 5 | Conversion without a credit decision | **Blocked.** Credit control is not optional (M22-FR-01) |
| 6 | Only 25 of the 40 sacks fit on the van | Challan for 25. Invoice **₹38,062.50 — not the order's ₹82,950** |
| 7 | *(why that matters)* | Billing the ordered quantity when the van carried less is an overcharge **with a tax invoice attached to it** |
| 8 | The balance goes two days later | Second invoice bills the remainder once. **The two invoices sum to the order exactly** |
| 9 | A driver takes one extra sack | **Refused** — *"an unordered case on an invoice is a dispute, and the driver has the argument"* |
| 10 | An invoice issued 40 days ago on 30-day terms | **10 days overdue, not 40.** Ageing from the invoice date makes every account on terms look delinquent, and then the report is ignored |
| 11 | A March invoice the school queried | Outstanding, but **not chaseable**. A queried invoice never becomes a reminder letter |
| 12 | *(the same account, query not recorded)* | Would face **stop supply** — and that decision always needs a person, never date arithmetic on the morning of a school function |
| 13 | ₹40,000 received | **Allocated** ₹38,062.50 + ₹1,937.50 across two named invoices, oldest due first. Never netted into a balance |
| 14 | Portal vs finance | Agrees exactly; a ₹1,050 drift is reported **with its sign** — *"they will pay the smaller one"* |

### 2. A supplier logs in from outside (M24)

| # | What happens | Control proven |
|---|---|---|
| 15 | Anand asks for his purchase orders | Two rows. Kumar's is **filtered server-side, from the session** |
| 16 | Anand asks for Kumar's | **Not an empty list — a refusal, with `securityEvent: true`.** A supplier probing for a competitor's invoices is not a UI mistake |
| 17 | Three such attempts | Surfaced as probing: *"one is a mis-click, 3 is somebody trying doors"* |
| 18 | His FSSAI licence expired on 1 July | The **delivery note is refused at the door**, checked at the action rather than on a nightly sweep — the gap between the two is exactly where an expired supplier gets paid |
| 19 | Renewed and verified the same morning | The ASN goes through; a **catalogue still lands for review** — *"the portal is a door, not an authority"* |
| 20 | His statement | Kumar's invoice is not in it. Closing ₹1,550 **reconciles**; the ₹880 he disputes is shown **separately** — neither owed nor written off |
| 21 | The same statement without the grant | **`accessible: false`** — *"a permission answer, NOT a balance of zero"* |

### 3. The jeweller's counter (M27)

| # | What happens | Control proven |
|---|---|---|
| 22 | ₹4,00,000 of gold on our shelves | **Excluded from our valuation.** ₹3,48,000 is ours; the gold is named, valued and left out of *"the balance sheet, the insurance schedule and the tax position"* |
| 23 | Our manager tries to write it off | **Refused** — *"somebody else's inventory written off by our staff is a bill we cannot argue with"* |
| 24 | Another concessionaire looks at it | **Security event** |
| 25 | ₹7,00,000 of counter sales in July | Rent ₹50,000 against ₹56,000 revenue share → **the higher of the two, not the sum** |
| 26 | Settlement | ₹7,00,000 held **on their behalf — never our revenue**; ₹6,40,000 payable |
| 27 | The till banks ₹1,800 less than the counter rang | **A valued exception, not a rounding note** |
| 28 | An unapproved ₹30,000 forfeit against their deposit | **Still a liability.** *"A forfeit with nobody's name on it is not a forfeit"* |
| 29 | Their insurance and licence both lapse | **Counter shut, both reasons at once** — *"an uninsured counter inside your shop is your exposure, not theirs"* |

### 4. The cold room and the power (M26-FR-01/02/04)

| # | What happens | Control proven |
|---|---|---|
| 30 | The cold room's AMC expired 64 days ago | **In its own critical list**, separate from the shelf trolley — *"₹80,000 of stock depends on it"* |
| 31 | The room sits above 9.5 °C for three hours | **Everything in it is held**, ₹1,840 across two batches, *"including the ones nobody probed"* |
| 32 | *(why that matters)* | The store probes a few batches; **the room is what actually fails** |
| 33 | A probe silent for three days | **`stale` — a fault, not a pass.** A probe that fell out of the room reads as "no alerts" forever |
| 34 | A door open for fifteen minutes | **Drifting, not a hold.** Grace is real |
| 35 | Mains fail, the DG will not start | **47 unprotected minutes counted from the MAINS failure**, and the cold room is named. The stock does not care which piece of equipment let it down |

### 5. The morning shift and the fire check (M25, M26-FR-03/04)

| # | What happens | Control proven |
|---|---|---|
| 36 | Suresh left last month, still in the grid as Sunday's opener | *"2026-08-09 06:00 has NOBODY rostered as opener"* — **a leaver is not cover**, and this is the gap nobody sees until the morning |
| 37 | Raj's food-handling certificate lapsed | **The deli counter is blocked, not Raj.** He stacks shelves all shift |
| 38 | *(why that matters)* | Blocking the person is how a shop works around the system on a busy Saturday, and **a control people route around is not a control** |
| 39 | Raj acknowledged v3 of the deli SOP; it is now v5 | **Not up to date.** *"An old signature against a procedure nobody has read looks like compliance and is not"* |
| 40 | A cashier hits 96% of her basket-size target | **Pays nothing.** *"Nearly is a conversation for a manager, not a formula"* — 96% of a bonus for 96% of a target redefines the target |
| 41 | The fire check is 15 days overdue, alongside **40** overdue mop-the-aisle tasks | The fire check is **first**, escalated by name to the owner, and is the **only** compliance-linked one of the 41 |
| 42 | The fire check ticked with no photograph | **Still a compliance risk.** *"A tick is worth nothing at an inspection and a dated photograph is worth everything"* |
| 43 | A reportable injury closed with no action / by its reporter / with no statutory notice | **Refused three times.** *"Closing it internally is exactly what makes everybody stop thinking about it"* |
| 44 | The compliance pack for August | **Not presentable**, two gaps named. *"Handing it over as complete is worse than handing over nothing"* |

### 6. What leaves as waste (M28-FR-02/03/04)

| # | What happens | Control proven |
|---|---|---|
| 45 | Four cardboard loads, one at a third of the usual rate | Flagged **against this shop's own running average**, with the evidence and posting gaps beside it — and the finding *"asks about the RATE, not about the person"* |
| 46 | ₹1,500 of proceeds not posted | Named as **off-books cash, whatever anyone intended** |
| 47 | Two carry bags | **A visible line, ₹23.60 with its own GST.** Where the tenant has not enabled it there is **no line**, not a line worth nothing |
| 48 | 300 crates out, 182 back | **118 in circulation, 39.3% never returned.** A shop that treats crates as consumed buys 400 again next year |
| 49 | July waste ₹4,100 against June's ₹5,000 — an 18% fall | **`not_comparable`.** The cafe and non-food managers were on leave; coverage fell from 100% to 60% |
| 50 | *(the honest answer)* | *"We CANNOT say whether waste changed. A fall here would be less recording, not less waste"* |

### 7. And it is all banked

| # | What happens | Control proven |
|---|---|---|
| 51 | Six events written to PostgreSQL | Invoice, refused submission, concession settlement, cold-room breach, escalated fire check, waste report |
| 52 | The invoice event re-sent | **Idempotent** — still six rows, not seven |
| 53 | `DELETE` and `UPDATE` on the ledger | **The database itself refuses** (migration 0004), and all six rows are still readable afterwards |

---

## The four things this stage refuses to let drift

**Whose money it is.** A concession sale rings through our till and the money was never ours;
a supplier statement is their claim on us; a school's payment has to land on a named invoice.
Each of these has a version where the shop quietly treats somebody else's money as its own —
not through dishonesty, but because netting is easier than allocating. Every one of them is
refused here.

**Whose stock it is.** ₹4,00,000 of a jeweller's gold on our shelves, in our POS, counted by our
staff. A valuation that swallows it overstates the balance sheet, the insurance schedule and the
tax position at once, and it always *looks about right*. Ownership is a property of the stock,
and the valuation asks.

**Whose data it is.** Two portals, both letting people outside the business log in. In both, the
identity comes from the session and never from the request, and a request for somebody else's
rows is a refusal that is **recorded** — not an empty list.

**Whether a number can be believed.** A waste figure that fell because a careful manager went on
leave. An energy figure a third of which was estimated. A compliance pack that is 60% complete.
Each of these carries its own honesty on its face, because each of them will be quoted in a
decision by somebody who was not there when it was produced.

## Repeatability

Run-scoped prefix (`RUN = s<base36 timestamp>`) through every document, session, contract, asset
and event id, with reads filtered by it — the suite runs any number of times against the same
append-only database and asserts only on its own events.

## Verdict

**Stage 16 gate: PASSED.** A B2B invoice follows the van rather than the order, a supplier sees
only their own rows and an expired licence stops them at the door, a concession counter trades
without ever entering our balance sheet, a cold room holds everything inside it when it drifts,
a roster names the missing opener and a lapsed certificate blocks the counter rather than the
person, and a fall in recorded waste is reported as what it is.

## What the owner should check in the store

1. **Ask for your stock valuation and check whether the jeweller's gold is in it.** It must not
   be. If it is, your balance sheet, your insurance cover and your tax position are all wrong by
   the same amount, and the figure will look perfectly reasonable.
2. **Ask a supplier to log in and try to open another supplier's invoice.** They must be refused
   — and you should be able to see that the attempt was recorded. An empty screen is not good
   enough.
3. **Look at last month's cardboard money.** The system will tell you what a tonne fetched and
   whether any load went cheap. It will also tell you if the money never reached the books.
4. **Check the Sunday morning rota for anyone who has left.** The system counts a leaver as
   nobody. If your old rota still shows them as covering the open, that is the gap you would
   otherwise find at six on a Sunday morning.
5. **Ask what happens when a food-handling certificate lapses.** The right answer is *"they
   can't work the deli, they can still work the shop floor"*. If the answer is *"they can't
   work"*, people will find a way around it on a busy Saturday.
6. **Ask why waste is down.** If reporting coverage fell, the system will tell you the number
   cannot be compared. That is the honest answer, and it is worth more than a good figure.
