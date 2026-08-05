# Where this project actually stands

**Written to be uncomfortable.** The owner asked for a ruthless assessment and a plan to close every
gap. Comfortable status reports are how projects arrive at go-live with a surprise.

---

## The one-paragraph verdict

**The thinking in this codebase is better than most commercial retail software. The assembly is not
finished, and there is almost no user interface.** 45,000 lines of domain logic encode controls that
products selling for lakhs a year do not have — a period that refuses to close because nothing
checked it, a migration report that refuses to render over eleven of twelve domains, a card guard
that refuses rather than redacts. That work is real and it is the hard part. But **a hypermarket
cannot be run from a TypeScript module**, and today the shop-floor software is fourteen written
screen specifications and two HTML shells. Between those two facts sits the entire remaining
project.

---

## What the numbers actually say

| Layer | Lines | Honest reading |
| --- | --- | --- |
| `packages/` — domain rules | 45,179 | **Genuinely strong.** The product's value lives here |
| `services/` — the thirteen APIs | 5,556 | Built, persisting, authenticated, audited |
| `edge/` — the store box | 1,144 | Now runs, writes durably, syncs. Built **today** |
| `apps/` — everything a person touches | 2,452 | **This is the gap.** Session models with no screens |
| Tests | 3,093 + 31 | Unusually thorough on rules; thin on assembly until today |

**2,452 lines of app code for six applications** is the number that matters. For comparison, the POS
alone — one screen a cashier uses eight hours a day — is 1,070 of those lines, and none of it draws
anything.

---

## The three gaps that matter

### Gap 1 — There is no user interface. This is the largest by far.

Fourteen screen specifications exist in `docs/design/screens/` and they are good: interaction
budgets, offline states, the ≤3-tap rule, what a new cashier must manage unsupervised in thirty
minutes. **None of them has been built.**

What exists, stated precisely — the first draft of this page was too harsh and the correction
matters. **The POS shell is real**: `apps/pos/web/` holds a laid-out screen following the spec
(total largest, line list, one Tender action, permanent sync badge, 56px touch targets) and it is
bundled against the **real tested session**, not a mock. `apps/owner-app/web/` has a shell too.
What the POS shell lacked was a way to reach a disk — built today, see below. What it still lacks is
tender beyond cash, returns, suspend/recall, cash movements, till open/close, and Tamil.

`web-erp`, `customer-app`, `picker-app` and `delivery-app` have **no web files at all**.

What this means concretely: today nobody can ring up a sale, receive a delivery, count stock, close
a day, approve a price change, pick an order, or look at a dashboard. The rules that would govern
all of those are written, tested and correct.

**This is not a criticism of the sequence.** Building rules before screens is right, and the reverse
is how retail software ends up with beautiful screens over a system that cannot balance a till. But
it does mean the project is further from a pilot than a module count suggests.

### Gap 2 — Assembly has lagged the rules, and it hid seven silent faults

In one session, driving the real paths rather than reading the code, seven separate things turned
out to be **present in the design and absent in the running system**:

1. Nothing sent a sale to the cloud — `SyncTransport` had no implementation.
2. Nothing wrote a sale to disk — `DurableLog` had only a test double.
3. Nothing started the store edge — no process, no container.
4. The repeated-request guard lived in memory — gone on every restart, never shared between
   instances.
5. No audit trail was written at all — the port existed, nothing supplied it.
6. A sale committed at the lane was **never queued for sync** — two real pieces, not joined.
7. The till's own commit **never touched a disk** — its own docstring said it did.

None was a crash. Every one was a control quietly not being there. **The pattern is the finding:**
this project has been built requirement-first, with each rule proved in isolation, and the joins
between them were assumed rather than driven. Two guards now exist for that shape and both have
already earned their place — but the lesson generalises, and the plan below applies it.

### Gap 3 — The system has never seen a real product

There is no product master, no price list, no tax rate, no supplier, no customer. Every test runs on
fixtures. That is correct for unit tests and it means **nobody has yet found out what happens when
SRE's actual data arrives** — 20,000-odd SKUs with inconsistent barcodes, missing HSN codes, three
spellings of the same brand, and produce sold by weight.

Data requirements are now fully specified in `docs/requirements/data-requirements.md`. Getting
actual data into a rehearsal environment is the highest-value thing that can happen next after the
UI.

---

## Module-by-module, honestly

Three columns, and they are different questions. **Rules** = is the logic written and tested.
**Wired** = does it run in the assembled system. **Usable** = can a person in the shop do it.

| Modules | Rules | Wired | Usable | The honest note |
| --- | :---: | :---: | :---: | --- |
| M01–M02 Platform, identity | ✅ | ✅ | ❌ | Token verification real; **no identity provider chosen**, so nobody can log in |
| M03–M05 Product, pricing, catalogue | ✅ | ✅ | ❌ | No screen to create or price a product. No HSN field |
| M06–M07 Purchase, supplier | ✅ | ◐ | ❌ | Three-way match real; **nothing captures an invoice**, so it has no lines to match |
| M08–M11 Inventory, warehouse, quality | ✅ | ✅ | ❌ | Movements and snapshots real; no counting screen |
| M12–M15 POS, returns, cash office | ✅ | ✅ | ✅ | The strongest area. Durable commit real, and the screen now reaches the till's own disk over loopback (ADR-0004). **Sale + cash tender only** — returns, suspend, cash movements and till open/close have no screen |
| M16–M18 Customer, loyalty, storefront | ✅ | ✅ | ❌ | Consent real; loyalty **accrual not wired** — points read as *not known* |
| M19–M20 Picking, delivery | ✅ | ◐ | ❌ | Attempts real; **no dispatch list exists**, so runs report unassigned |
| M21–M24 Finance, Tally | ✅ | ◐ | ❌ | Journals and period close real. **No control totals can be built** — deliberate, and it means no month can close yet |
| M25–M28 Reporting, analytics | ✅ | ◐ | ❌ | Two real figures. Everything else needs producers |
| M29–M32 Ops, compliance, workforce | ✅ | ❌ | ❌ | Rules only |
| M33–M35 Owner control, audit, config | ✅ | ✅ | ❌ | Audit trail now real and immutable |
| M36 + A01–A10 AI | ✅ | ✅ | ❌ | Kill switch defaults **on**. No provider chosen (owner decision) |
| MG-01–MG-12 Migration | ✅ | ✅ | ◐ | Strongest non-POS area. CLI tool exists. **No real data yet** |

**Legend:** ✅ done · ◐ partial, with a named reason · ❌ not started

### The five that are ◐ for a good reason, and must not be "fixed" by relaxing them

- **Period close refuses** because no control total can be built inside this system — every figure
  comes down one path, so comparing two of them is one figure written twice. The genuine second
  source is the bank statement or the filed return. **The fix is a bank feed, not a weaker check.**
- **Delivery runs report unassigned attempts** because nothing dispatches. Correct until M20 route
  planning is built.
- **Loyalty points answer "not known"** because nothing accrues them. Correct until M14 is wired.
- **Commitments answer "not known"** because no purchase order is recorded. Correct until M06 is
  wired.
- **Invoice matching refuses** because no invoice lines are captured. Correct until receiving is
  wired.

Each of these is the system telling the truth about what it does not know. **If any of them ever
starts answering confidently without the missing producer being built, that is the regression.**

---

## What "world class" actually requires, beyond finishing the list

Five things that separate good retail software from software that merely has all the modules. Two of
them this project already has.

| | Have it? | |
| --- | :---: | --- |
| **It never loses a sale** | ✅ | Durable commit, idempotent sync, append-only ledger, visible dead-letter. This is now genuinely true and tested end to end |
| **It tells the truth when it does not know** | ✅ | Unusually strong. Not-known is a first-class answer throughout |
| **A new cashier is productive in 30 minutes** | ❌ | Specified, not built. This is the one customers actually judge |
| **It is fast at the scale of a real shop** | ◐ | Bounded reads proved with real numbers; **never run against 20,000 real SKUs** |
| **It is legal on day one** | ◐ | Card handling and audit yes. **E-invoicing, HSN and FSSAI records are not built** |

---

## The five things most likely to go wrong, ranked

1. **The UI is underestimated.** Fourteen screens for six applications, offline-capable, in two
   languages, usable by staff who are not computer users. This is *the* remaining project, and it is
   larger than everything built so far looks.
2. **Real data breaks assumptions.** 20,000 SKUs with duplicate barcodes, missing HSN, weighed items
   and three spellings of one brand. Every migration control exists for this; none has met real
   data.
3. **E-invoicing is discovered late.** If turnover has ever exceeded ₹5 crore since 2017–18 it
   applies permanently, and it is a government-portal integration on the critical path — not a
   setting.
4. **No identity provider is chosen**, so nobody can log in and no user acceptance testing can run.
   Blocked on the hosting decision (OB-02).
5. **The gap between "module built" and "module usable" is not visible on any status page.** It is
   now, in the table above, and that table is the one to look at.

---

## What I recommend, in order

**1. Finish the POS screen, end to end.** ✅ *The seam is built:* the screen now commits to the
till's own disk over a loopback socket, and a sale rung on the screen lands on the disk and in the
cloud queue — proved end to end with nothing stubbed. ✅ *And the screen is now usable rather than demonstrable:* on-screen
keypad and reason panels instead of browser prompts (which kiosk browsers block outright), change
due computed as the cashier types, a refusal banner that does not fade, Tamil throughout, and a
scanner path that cannot type a barcode into a quantity field.
✅ *Card, UPI and hold/recall are in too*, with the
unanswered-terminal case refusing to complete rather than guessing.
✅ *Cash to the safe and a blind, denomination-by-denomination
till close are in.* **What remains:** receipt-based returns, which need the lane to look up an
original sale and are currently sent to the service desk by name rather than hidden behind a dead
button — and then the whole thing on real hardware with a real scanner and a stopwatch, which is
the only test that counts.

**2. Get real data into the rehearsal environment.** Follow the extraction plan. Every control is
built and waiting; none has met a real export.

**3. Then the other five surfaces**, in this order: store manager → owner → receiving/purchase →
picker/delivery → customer app. Ordered by how much of the shop stops without them.

**4. In parallel, close the compliance build**: HSN on the product, e-invoicing if it applies, FSSAI
records, legal-metrology stamping dates.

**5. Decide the identity provider and hosting** (OB-02). Everything else can proceed; user testing
cannot.

The sequenced plan, with what each step delivers and how long it plausibly takes, is
`docs/architecture/build-plan.md`.

---

## A closing note on the last two sessions

Seven silent faults were found by driving real paths rather than reading code. That was worth doing
and the guards left behind will catch some of it again. But the honest reading is that **the same
class of gap almost certainly exists in the modules nobody has driven yet** — and the modules nobody
has driven yet are the ones with no screen, which is most of them.

The plan therefore front-loads *building the thing a person uses*, because a screen is the only test
that cannot be passed by a system that merely looks assembled.
