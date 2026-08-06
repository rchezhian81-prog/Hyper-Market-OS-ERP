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
| `edge/` — the store box | 2,250 | Runs, writes durably, syncs — **and now feeds every screen**, the buyer's included |
| `apps/` — everything a person touches | 10,200 | **All six have real screens, and the ERP now has nine** — the manager's, the buyer's, the product and price screen, merchandising and space, reporting, the service desk, expiry and recall, finance, and admin and security. The gap that dominated this document is closed |
| Tests | 4,245 + 31 | Unusually thorough on rules; thin on assembly until today |

**2,452 lines of app code for six applications** is the number that matters. For comparison, the POS
alone — one screen a cashier uses eight hours a day — is 1,070 of those lines, and none of it draws
anything.

---

## The three gaps that matter

### Gap 1 — There is no user interface. ✅ **CLOSED.**

*This section is kept as written, because the correction is the point: this was the largest gap in
the project and it is now closed. All six applications have real, tested screens. What follows
below is what it said when it was true.*

Fourteen screen specifications exist in `docs/design/screens/` and they are good: interaction
budgets, offline states, the ≤3-tap rule, what a new cashier must manage unsupervised in thirty
minutes. **None of them has been built.**

What exists, stated precisely — the first draft of this page was too harsh and the correction
matters. **The POS shell is real**: `apps/pos/web/` holds a laid-out screen following the spec
(total largest, line list, one Tender action, permanent sync badge, 56px touch targets) and it is
bundled against the **real tested session**, not a mock. `apps/owner-app/web/` has a shell too.
What the POS shell lacked was a way to reach a disk — built today, see below. What it still lacks is
tender beyond cash, returns, suspend/recall, cash movements, till open/close, and Tamil.

`web-erp` now has a shell too — approvals, receiving, counting and day close — and `owner-app`'s shell has been rebuilt against a real tested session rather than a sample payload. `picker-app`, `delivery-app` and `customer-app` now have shells too, built on their tested sessions. **Every application in the repository layout now has a screen.**

What this means concretely: today nobody can ring up a sale, receive a delivery, count stock, close
a day, approve a price change, pick an order, or look at a dashboard. The rules that would govern
all of those are written, tested and correct.

**This is not a criticism of the sequence.** Building rules before screens is right, and the reverse
is how retail software ends up with beautiful screens over a system that cannot balance a till. But
it does mean the project is further from a pilot than a module count suggests.

### Gap 2 — Assembly has lagged the rules, and it hid **eleven** silent faults

*Updated. The count was seven when this was written and it is now eleven — every one found the same
way, by driving a real path rather than reading code. The four added since: the picker's scans and
the driver's COD both queued nowhere at all despite both docstrings saying they did; the six screens
had no producer for any of their data; and the customer app's search read the wrong field, so it
reported "nothing matched" for every term ever typed. **All four are fixed.** The original seven
follow.*

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
| M01–M02 Platform, identity | ✅ | ✅ | ◐ | Token verification real; the approvals inbox is a screen (decide in ≤3 taps, reason recorded, separation of duties visible). **Admin and security is now a screen too** — outside access scoped and time-bound, who can get in, the device fleet, and what retention would do. **The defect found building it:** support access had two implementations and the weaker was wired to the API — its request had no `scopes` field, so least privilege could not be stated — and the expiry was never checked by anything. **No identity provider chosen**, so nobody can log in |
| M03–M05 Product, pricing, catalogue | ✅ | ✅ | ✅ | **The product and price screen is now built** — HSN/tax class is a field and nothing publishes without one. A price change is drafted, checked against the MRP ceiling and the margin floor with both limits shown *before* the price is typed, approved by somebody else and appended as a new entry. Until this session **nothing in the system had ever produced a `PriceEntry`**, so the catalogue snapshot builder had never had a real price to ship to a lane. **Shelf addresses are built too** (M04-FR-02, owner decision 6 Aug 2026): the store box now sequences the picker's wave by the shop's own shelf map, chiller last where the store has said so — `routeFor` had been written and tested since the module existed and nothing had ever called it. **Planograms, refill tasks, the range review and space are built too** (6 Aug 2026, owner asked for them next): a blind shelf count is the producer that never existed, and an uncounted facing is now reported as *never counted* rather than as an empty shelf — which had been raising the loudest alarm in the system for every product in the shop |
| M06–M07 Purchase, supplier | ✅ | ✅ | ✅ | Three-way match real; goods receiving is a screen, and a delivery with no purchase order is flagged unmatched rather than filed quietly. **The buyer's screen now captures a supplier invoice in one go** — checked against the total printed on the paper, each line's own arithmetic checked with the line number to look at, approved by somebody else, committed atomically — so the match has lines at last. An uncaptured invoice still refuses, and now says which of the three documents is missing |
| M08–M11 Inventory, warehouse, quality | ✅ | ✅ | ✅ | Movements and snapshots real; blind counting is a screen, and a count the screen cannot value is refused rather than priced at zero. ~~No expiry or recall screen~~ ✅ **Expiry and recall are now built** — the action list, FEFO allocation, the backwards trace, and a recall that leads with what is still in customers' homes and will not close without evidence. **The defect found while building it was the worst of the session:** the recall block that says *"even offline"* had no field in the pack to arrive in, and the payload the box served the lane was not a `CatalogueSnapshot` at all, so the till threw on boot — a recalled tin scanned and sold like any other |
| M12–M15 POS, returns, cash office | ✅ | ✅ | ✅ | The strongest area. Durable commit real, and the screen reaches the till's own disk over loopback (ADR-0004). Cash, card, UPI, hold/recall, cash to safe and a blind till close are in; **day close now has a manager screen that reports a list rather than a refusal**. ~~Receipt-based returns still have no screen~~ ✅ **The service desk is now built** — the desk the till has been pointing at all along. It finds the bill in the box's own log, so a receipted return works with the cable out, and **the at-most-once guard has a producer at last**: it had been fed a bare zero, so the same receipt could be refunded every day |
| M16–M18 Customer, loyalty, storefront | ✅ | ✅ | ◐ | **The customer app is now a screen**: search, repeat order, basket review, slots, payment, and a privacy centre where withdrawing consent is the same one tap as giving it (DPDP s.6(6)). Loyalty **accrual still not wired** — points read as *not known* |
| M19–M20 Picking, delivery | ✅ | ✅ | ✅ | **Both handhelds are now screens**, both queue their work, and **the store box now plans the routes** (M19-FR-03) — straight-line distances, stated as such, as a draft a dispatcher confirms. Runs reconcile against a real assignment list at last |
| M21–M24 Finance, Tally | ✅ | ✅ | ✅ | Journals and period close real. ~~**No control totals can be built** — deliberate, and it means no month can close yet~~ ✅ **Built.** Every figure is stated twice — the shop's own record and what the accounts actually received — computed independently and agreeing to the paisa or not at all. **Only a posting the accounts ACCEPTED counts as received**, so a queued or refused one cannot make both sides agree by being the same number twice. **A month can now close, and a CA can sign it** (QG-07) |
| M21 CRM and service desk | ✅ | ✅ | ◐ | **Complaints, enquiries, warranty and lost-and-found are now a screen**, with the SLA clock on both promises — first reply and resolution, which fail differently — and compensation under maker-checker. The desk says out loud when the times it is showing are the software's starting figures rather than anything this shop agreed. Campaigns are still rules only |
| M25–M28 Workforce, facilities, concession, waste | ✅ | ◐ | ❌ | **Mislabelled as "Reporting, analytics" in every earlier version of this document.** Rules only, apart from the refill task's owning role, which merchandising now uses |
| M29–M32 Reporting, ops, compliance | ✅ | ✅ | ◐ | **The reporting screen is now built** (M29-FR-01/02, D13, API-10), **comparisons included** — today against the last day the box actually holds, and what is selling by department. D13 names 28 reports; **eleven have code behind them and the other seventeen are listed as unrunnable, by name, rather than hidden** — a screen showing only what works looks finished, and somebody who cannot find shrinkage concludes the shop has none. The two reasons are told apart because they have different owners: *nothing yet records what is thrown away* is the shop's to fix, *this version cannot work it out yet* is ours. Exports are permission-checked, PII-redacted and audited, and refuse outright when the box has not been told who is asking. Compliance and workforce are still rules only |
| M33–M35 Owner control, audit, config | ✅ | ✅ | ✅ | Audit trail real and immutable. The owner's phone is a screen: brief, drill-through to every sale behind a figure, and approvals that record how old the data was when he decided. **Support access, the device fleet, legal hold and retention are now a screen as well** — and what the shop has not decided is reported as undecided rather than as compliant |
| M36 + A01–A10 AI | ✅ | ✅ | ❌ | Kill switch defaults **on**. No provider chosen (owner decision) |
| MG-01–MG-12 Migration | ✅ | ✅ | ◐ | Strongest non-POS area. CLI tool exists. **No real data yet** |

**Legend:** ✅ done · ◐ partial, with a named reason · ❌ not started

~~**Owner decision taken, 6 August 2026 — M04.** Shelf locations first; planograms deferred to
R3.~~ ✅ **All of M04 is now built** (owner asked for the rest the same day). The prerequisite named
in the deferral — *no producer of on-shelf counts anywhere in the system* — was built first as a
blind shelf count, and it turned out to be the whole point: `planogramCompliance` had been treating
an **uncounted** facing as an **empty** one, so on day one the entire shop came back as urgent
refill tasks and staff would have been sent to full shelves.

### The security control with two implementations (6 August 2026)

Found while building the admin and security screen.

`services/platform` carried its own `grantSupportAccess`, and it was the one wired to the API. Its
request had **no `scopes` field at all** — so support access granted over the wire could not state
least privilege, could not be refused for holding a scope support may never hold, and had no rule
stopping an approval **lengthening** the window that was asked for. The package's version, unwired,
enforced all three.

A second, simpler copy of a security control is the one that drifts, and it drifts in the direction
of letting more through.

**And the expiry was never checked.** `supportSessionActive` decides liveness from the clock, and
nothing outside its own unit test ever asked it: a session was granted with an `expiresAt` in a
response body and no code anywhere read it again. Standing access wearing a time limit's clothes.

### The gate that had no key (6 August 2026)

QG-07 says a period cannot close on unvalidated control totals, and a CA must be able to sign them.
`validateControlTotals`, `closePeriod` and `buildEvidencePack` have enforced exactly that since the
module was written — and **none of them was ever given a control total**, because nothing in this
system built one. This document has carried the consequence for weeks: *no month can close yet.*

The producer now exists. The decision it turns on is small and load-bearing: **only a posting the
accounts have accepted counts as received.** Count a queued one and both sides of every total become
the same number computed twice, so the month closes reconciled and signed with the accounts empty.

### The one that was a safety matter (6 August 2026)

Found while building the expiry and recall screen, by running the till against a payload the store
box actually produces rather than reading the code.

**The lane's catalogue has refused a recall-blocked scan since it was written**, and the refusal
says *"even offline"* — the loudest safety claim in this system. Two things made it unreachable:
the store pack had **no field for the flag to arrive in**, and what `posPayload` served the lane was
not a `CatalogueSnapshot` at all — no `barcodes` array, no `status`, no `taxBps`. Building the real
cache from it **threw before the till rendered anything**.

So a cashier opening the till on a real box got a blank screen, and once that was fixed there was
still nothing to stop a recalled tin being scanned and sold.

The integration test that should have caught it checked the payload's *contents* and never that the
lane could consume them. It now builds the real cache and scans through it.

### The defect that had nothing to do with any of the above (6 August 2026)

Found by running the reporting screen against a box that had been trading for four days rather
than one. **The store box's sales log is append-only and is never rotated**, so it holds every
sale ever committed on it — and every screen that meant *today* was being handed all of it.

The owner's phone reported **₹2,245 as the day's takings on a day the shop took ₹145**. The
manager's exception register, which the day close gates on, counted a refund from last Tuesday
against today's limit — so on a box a fortnight old, a shop in which nothing at all went wrong
could no longer close its day, and nobody could clear it.

Nothing crashed and no test went red. The number was simply wrong, and it got wronger every day
the box stayed up. It is the clearest example this project has produced of why the tests are not
the thing that finds these: **the rules were all correct, and the input to them was not.**

### The ones that are ◐ for a good reason, and must not be "fixed" by relaxing them

_Two have since been closed properly — by building the missing producer, never by weakening the check._

- **Period close refuses** because no control total can be built inside this system — every figure
  comes down one path, so comparing two of them is one figure written twice. The genuine second
  source is the bank statement or the filed return. **The fix is a bank feed, not a weaker check.**
- ~~**Delivery runs report unassigned attempts** because nothing dispatches.~~ ✅ **Closed.** The
  store box now plans routes (M19-FR-03) and `assignedOrderIds` gives the reconciliation the list it
  never had. The control that catches a delivery against an order nobody dispatched still works —
  it simply no longer fires on every single delivery.
- **Loyalty points answer "not known"** because nothing accrues them. Correct until M14 is wired.
- **Commitments answer "not known"** because no purchase order is recorded *by the API*. The
  buyer's screen raises orders and the store box serves what is on order, so the screen's own match
  is real; the API-side projection is still honest about not having them.
- ~~**Invoice matching refuses** because no invoice lines are captured.~~ ✅ **Closed.** The buyer's
  screen captures them, against the control total printed on the supplier's paper. The refusal that
  mattered is still there and still fires: an invoice nobody has captured is *not checked*, which is
  a different sentence from *clean*, and the screen shows it as the sentence it is.

Each of these is the system telling the truth about what it does not know. **If any of them ever
starts answering confidently without the missing producer being built, that is the regression.**

---

## What "world class" actually requires, beyond finishing the list

Five things that separate good retail software from software that merely has all the modules. Two of
them this project already has.

| | Have it? | |
| --- | :---: | --- |
| **It never loses a sale** | ✅ | Durable commit, idempotent sync, append-only ledger, visible dead-letter. Now true on the handhelds too — a picker's wave and a driver's cash survive the device |
| **It tells the truth when it does not know** | ✅ | Unusually strong. Not-known is a first-class answer throughout |
| **A new cashier is productive in 30 minutes** | ◐ | Built and guarded on all six surfaces. **Never yet put in front of a person with a stopwatch**, which is the only test that settles it |
| **It is fast at the scale of a real shop** | ◐ | Bounded reads proved with real numbers; **never run against 20,000 real SKUs** |
| **It is legal on day one** | ◐ | Card handling, audit and now DPDP consent/erasure yes. **E-invoicing, HSN and FSSAI records are not built** |

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

✅ **The store box now feeds all six screens** — its own log for the day's sales and exceptions,
the cloud pack for everything the rest of the business decided, and a clear statement of which of
the two any given answer came from. **The manager's day close now closes**, proved end to end.

**2. Get real data into the rehearsal environment.** Follow the extraction plan. Every control is
built and waiting; none has met a real export. **This is now the single biggest remaining risk** —
the screens, the box and the rules are all built, and none of them has met one real product.

**3. Then the other five surfaces**, in this order: store manager → owner → receiving/purchase →
picker/delivery → customer app. Ordered by how much of the shop stops without them.
✅ **All six are built.**
✅ *The customer app is built* — the only public surface, so WCAG 2.2 AA is enforced statically and
nothing loads from another host. Its centre of gravity is the privacy centre: withdrawing consent
is the same single tap as giving it, which is section 6(6) of the DPDP Act and the commonest dark
pattern in consumer software. An erasure says on the button, before it is pressed, that tax
records survive it.
✅ *The picker handheld and the driver's phone are built* — and building them found the worst
assembly gap yet: **neither queued anything**. Both session docstrings said the scans, the proof
and the COD were queued for sync, and every one of them lived only in memory on the device. On the
driver's phone that meant cash collected with no record that survived a dead battery. Both now
write through to the device, the substitution needs the customer's own reference rather than a tick
box, and the driver's cash handover is counted blind like the till drawer.
✅ *The owner app is built*: the brief now drills — every figure opens every sale behind it — and
approvals are decided on the phone with the **age of the data in front of the decision**, recorded
into it. A decision made with no signal is queued, and if the request changes while it waits it
comes back to be looked at again rather than being sent or dropped. Three faults in the old shell
were fixed on the way: browser `alert()` dialogs holding raw ids, sample figures rendered as if
they were the shop's takings, and a language toggle that changed no words at all.
✅ *The store manager screen is built*: approvals inbox, receiving, blind stock count and a day
close that answers with a list of what is still open. Its registers refuse to guess — a screen
that cannot read the exception list will not close the day, which is the correct answer and the
one worth rehearsing during the pilot. **What remains on it:** the exception and task registers
have no producer on the store box yet, so today every one of them answers *not known*.

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
