# Getting our data out ourselves

**MG-01 · MG-02 · MG-06 · §34.** Owner decision, 7 August 2026: **we do not wait for the
incumbent vendor.** Written to be followed by somebody who is not a programmer, with a
technical person beside them for Route A.

> **The decision, and why it is right.** A vendor asked to export a customer's data in an open
> format is being asked to help that customer leave. The request gets answered slowly, partially,
> in a format nobody can use, or not at all — and none of those is a refusal you can escalate.
> A migration plan whose first step is *"wait for them"* has handed its schedule to somebody
> whose interests run the other way. So the letter is no longer the plan. It stays on file, and
> if they ever answer, that is a bonus and not a dependency.

---

## What we are doing, plainly

Getting **our own business data** out of software we licensed, running on **our own machine**.
That is ordinary and lawful — it is our stock, our sales, our customers, our books.

Two things we do not do, and they are the whole boundary:

- We do not touch their **software** — no source code, no decompiling, no defeating a password
  or protection they put on their program.
- We use only the access **we already have**: the machine we own, the login we were given, and
  the export and report features we paid for.

There is one question worth asking your CA or solicitor once, at leisure, and it does not block
anything below: *does our licence agreement say anything about exporting our own data?* Most do
not. Ask, note the answer, carry on.

---

## Four routes, best first

Use the best route each kind of data allows. Most shops end up using two or three.

| | Route | What it gives | What it cannot give |
| --- | --- | --- | --- |
| **A** | **Read the database directly** | Everything, including history | Needs a technical person and the database password |
| **B** | **The system's own "Export to Excel"** | Row-by-row, repeatable | Only what the screen shows — filters and hidden columns cut it silently |
| **C** | **Print a report, then read the file** | Whatever the report prints | Totals only; batch and expiry detail are usually not on it |
| **D** | **Type it in by hand** | A small table | **Not a migration source** — see below |

### Route A — read the database directly *(do this if at all possible)*

Almost every system of this kind keeps its data in a database on the back-office PC. Find it:

1. On the back-office machine, look in the program's install folder for files ending `.mdf`,
   `.fdb`, `.gdb`, `.db`, `.sqlite`, `.dbf` or `.mdb`. Note the folder.
2. Look in Windows Services for something like *SQL Server*, *Firebird* or *PostgreSQL*.
3. The password is often in the program's own settings file, or was set by whoever installed it.
   The person who installed the system is a better person to ask than the vendor's support desk.

**Copy the files first, before reading anything.** Then read from the copy. This is MG-02 and it
is not a formality: the first thing that reads the data must not also be the only thing that has
it.

If the database is locked while the program is running, **close the program on every machine
first**, or take the copy after the shop closes.

### Route B — the system's own export

Every screen with a grid almost certainly has *Export*, *Export to Excel*, or a right-click
menu. Work through the screens and export each one.

**The trap:** an export gives you what the screen was *showing*. If the screen had a date filter,
a page limit, or a hidden column, the export has the same. So for every export, ask the screen
for the row count first, and check the file has that many rows. A file with 4,000 rows where the
screen said 41,200 is not a smaller export — it is the wrong file.

**This is the one failure that reconciles perfectly**, which is why it is dangerous: the short
file parses cleanly, its rows are well-formed, and its own grand total agrees with the sum of its
rows to the paisa. It is internally consistent about a shop a tenth of the real size, and the
first person to notice is a customer whose product does not scan.

The software checks it on four signals before anything else looks at the file, and **refuses**
rather than warns. The one worth knowing about: **`Page N of M`**. Almost every report prints it,
and if the file stops at page 3 while the report says *of 47*, it is truncated — no arithmetic,
and nobody needs to have written a count down. But write the count down anyway; it is one glance
and it is the strongest check there is.

### Route C — print a report and read the file

Every such system prints reports. Print to PDF, or to a text file if it offers one.

Useful, and limited in a way worth understanding: **a report has already decided what to group,
what to round and what to leave off.** No amount of careful reading gets those back. A stock
report may give a total per product and no batches at all — and if the batches are not on any
report, Route C cannot produce them for you.

### Route D — typing it in

For a small table — twenty payment types, forty departments — this is fine. For anything larger
it is **not a migration source**, and the software refuses to treat it as one.

Not snobbery about manual work. A route nobody can re-run cannot be rehearsed, cannot be
re-applied to catch the changes since, and cannot be redone when the first attempt turns out
wrong. Two people typing the same page produce two different datasets, and no one can say which
is right. Where it must be used, **two people key it separately and the two files are compared** —
the software does the comparison and names every field the two disagreed on, so each is a line for
a person to settle against the page rather than an average to take.

---

## The part that actually matters: proving the numbers

This is where self-extraction is different, and where it is genuinely **better** than a vendor
export — which is not what anybody expects to hear.

With a vendor file, you have their word for what it means. Without one, everything you have comes
from the same system. So if you read the stock value off the stock report, and then check it
against the valuation report from that same system, **the two will agree perfectly and it proves
nothing.** They would agree just as perfectly about a wrong number. The software refuses that
check by name.

**So the proof comes from outside the old system entirely** — from records other people keep, for
their own reasons, with no interest in agreeing with our old ERP:

| To prove | Check against | Why it is independent |
| --- | --- | --- |
| **Stock** | **A physical count.** Count the shelves | The only truth about stock that exists anywhere. Everything else is a record *of* it |
| **Sales** | The bank statement; the card/UPI settlement file | The bank has no interest in agreeing with our old system |
| **Tax** | The GST returns already filed | Filed, dated, signed. It cannot be adjusted to make a total agree |
| **Supplier balances** | The supplier's own statement | They keep their own ledger and will confirm it, because they want paying |
| **Books** | The accounts the CA prepared | Prepared independently, by somebody with a licence at stake |
| **Loyalty points** | A sample of customers | They can see their own balance and will say if it is wrong |

**A vendor export is one system's account of itself. A bank statement is an adversary's.** The
second is better evidence.

Where a domain has *no* outside check available, that is not a reason to stop — but it is written
down, and the owner is told in writing that those figures rest on the old system's word.

---

## The order to do it in

1. **Copy first.** Whatever route, take an untouched copy before anything reads it (MG-02).
2. **Count everything.** Row counts per table or report, written down. An estimate cannot be a
   control total.
3. **Extract**, best route per domain.
4. **Gather the outside evidence** — bank statements, filed returns, supplier statements, and
   book a physical count.
5. **Load into the rehearsal environment.** Never production. The software refuses a production
   target before it checks anything else (hard rule #7).
6. **Reconcile against the outside evidence**, not against the old system.
7. **Work the exception list.** Every problem found is kept; the owner decides each blocking one,
   including deciding to accept it.
8. **Run both systems side by side** until the daily figures agree.
9. **Cut over**, with the rollback already demonstrated.

**The shop trades on the old system throughout.** Nothing here interrupts selling.

---

## What the owner does

Three things, and none of them involves the vendor:

1. **Get the outside evidence.** Bank statements for the period, the filed GST returns, and
   statements from your main suppliers. These are yours to ask for and nobody will refuse them.
2. **Authorise a physical count.** It is the only thing that proves the stock figure, and it
   needs staff and a closed evening.

   **It does not have to be a full count.** The software plans a **value-stratified** one: the
   high-value lines — the ghee, the oil, the big rice bags — are counted in **full**, and a thin
   sample is taken from the long tail. Counting the top lines covers ~80% of your money in a
   fraction of the hours, and a random sample of the same size that happened to miss the ghee
   would have verified almost nothing while looking thorough.

   Three things the software insists on: the counter **never sees the expected number** (shown
   "expected: 40", people write 40); the person who ran the extraction **cannot choose which
   lines get checked** (not dishonesty — you pick the lines you are confident about); and what
   the sample suggests about the uncounted tail is reported as an **estimate**, never added to
   the counted figure to make one confident-looking total.
3. **Find whoever installed the current system.** Not the vendor's support desk — the person or
   local firm who set it up. They usually know where the database sits and what the password is,
   and they have no reason not to say.

## What to check when it is done

- **Ask what the stock figure was checked against.** The right answer is *"a physical count."*
  If the answer is another report from the old system, it has not been checked.
- **Ask how many rows came out, and how many went in.** Two numbers that match, per table.
- **Ask to see the list of what could not be proved.** There will be something. It should be
  short, named, and in writing.

## Related

- `../architecture/migration-design.md` — the MG-01…12 pipeline this feeds
- `../evidence/stage-11-the-old-shop-arrives-whole.md` — the engine, rehearsed end to end
- `../discovery/legacy-data-access.md` — the vendor letter, retained on file, no longer the plan
- `../../packages/migration/src/extraction.ts` — the route and verification rules, as code
- `../../packages/migration/src/report-parser.ts` — reads what Routes B and C actually produce:
  finds the real header under the shop's name and the report title, never counts a
  *"Total for GROCERY"* line as a product, reads `4,12,000.00` as twelve lakh, and keeps every
  paisa exact
